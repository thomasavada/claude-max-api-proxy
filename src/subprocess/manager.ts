/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
  systemPrompt?: string;
  /**
   * OpenAI tool-calling emulation mode. Disables the CLI's own tools and
   * dynamic system-prompt sections so the model can only emit the text
   * tool-call contract we injected. See adapter/tools.ts.
   */
  toolMode?: boolean;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

// Timeout model — see DESIGN/README. We DON'T kill long-but-active tasks.
// The idle timer resets on every chunk of output, so a task that is actively
// streaming runs as long as it keeps producing output. Only genuinely stuck
// processes (no output for IDLE_TIMEOUT) are killed. An optional hard cap
// bounds total wall-clock time and is OFF by default (0).
const IDLE_TIMEOUT = Number(process.env.CLAUDE_IDLE_TIMEOUT_MS) || 300000; // 5 min of silence
const MAX_TIMEOUT = Number(process.env.CLAUDE_MAX_TIMEOUT_MS) || 0; // 0 = no hard cap
const KILL_GRACE = Number(process.env.CLAUDE_KILL_GRACE_MS) || 5000; // SIGTERM→SIGKILL grace
// Allow pointing at a specific Claude binary (mirrors the PATH handling used
// for `claude models` in routes.ts, and lets tests inject a fake CLI).
const CLI_BIN = process.env.CLAUDE_CLI_BIN || "claude";

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private idleTimeoutId: NodeJS.Timeout | null = null;
  private maxTimeoutId: NodeJS.Timeout | null = null;
  private forceKillId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;
  private idleMs: number = IDLE_TIMEOUT;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    // Backward-compat: an explicit options.timeout is treated as the idle window.
    this.idleMs = options.timeout || IDLE_TIMEOUT;

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn(CLI_BIN, args, {
          cwd: options.cwd || process.cwd(),
          env: { ...process.env, OPENCLAW_PROXY: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Idle timeout: fires only after idleMs of NO output. Reset on every
        // chunk (see stdout/stderr handlers) so active tasks are never killed.
        this.resetIdleTimer();

        // Optional hard cap on total wall-clock time (off by default).
        if (MAX_TIMEOUT > 0) {
          this.maxTimeoutId = setTimeout(() => {
            this.handleTimeout(`Request exceeded hard cap of ${MAX_TIMEOUT}ms`);
          }, MAX_TIMEOUT);
        }

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimers();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                `Claude CLI ("${CLI_BIN}") not found. Install with: npm install -g @anthropic-ai/claude-code`
              )
            );
          } else {
            reject(err);
          }
        });

        // Pass prompt via stdin to avoid E2BIG with large prompts
        this.process.stdin?.write(prompt);
        this.process.stdin?.end();

        console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.resetIdleTimer(); // activity — the task is alive, don't time out
          const data = chunk.toString();
          console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          this.resetIdleTimer(); // stderr output also counts as activity
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            console.error("[Subprocess stderr]:", errorText.slice(0, 200));
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          console.error(`[Subprocess] Process closed with code: ${code}`);
          this.clearTimers();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimers();
        reject(err);
      }
    });
  }

  /**
   * (Re)arm the idle timer. Called on spawn and on every chunk of output, so
   * the countdown only elapses during genuine silence from the subprocess.
   */
  private resetIdleTimer(): void {
    if (this.isKilled) return;
    if (this.idleTimeoutId) clearTimeout(this.idleTimeoutId);
    this.idleTimeoutId = setTimeout(() => {
      this.handleTimeout(`No output for ${this.idleMs}ms (process appears stuck)`);
    }, this.idleMs);
  }

  /**
   * Common path for idle / hard-cap timeouts: mark killed, escalate the kill,
   * and surface a clear error so the caller can close the stream cleanly.
   */
  private handleTimeout(reason: string): void {
    if (this.isKilled) return;
    this.isKilled = true;
    this.escalateKill();
    this.emit("error", new Error(`Request timed out: ${reason}`));
  }

  /**
   * Terminate the process gracefully, then forcibly. SIGTERM lets the CLI flush
   * and exit; if it's still alive after KILL_GRACE we SIGKILL it so a hung CLI
   * can never become a zombie holding the request open.
   */
  private escalateKill(): void {
    if (!this.process) return;
    this.clearTimers();
    this.process.kill("SIGTERM");
    this.forceKillId = setTimeout(() => {
      if (this.process && this.process.exitCode === null && this.process.signalCode === null) {
        console.error("[Subprocess] SIGTERM grace elapsed — sending SIGKILL");
        this.process.kill("SIGKILL");
      }
    }, KILL_GRACE);
    // Don't let the force-kill timer keep the event loop alive on shutdown.
    this.forceKillId.unref?.();
  }

  /**
   * Build CLI arguments array
   * Note: prompt is passed via stdin to avoid E2BIG errors with large prompts
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--no-session-persistence", // Don't save sessions
    ];

    // Tool-calling emulation: strip the CLI's own agent capabilities so the
    // model can only produce the text tool-call contract we injected. Without
    // this the CLI would (a) expose its own Read/Write/Bash/MCP tools and try to
    // *execute* them in its agent loop instead of handing a call back, and
    // (b) prepend a ~14k-token identity preamble that fights our contract.
    if (options.toolMode) {
      args.push("--tools", ""); // disable ALL built-in tools
      args.push("--strict-mcp-config"); // ignore ambient MCP servers (no --mcp-config given)
      args.push("--exclude-dynamic-system-prompt-sections"); // drop the large default preamble
    }

    // Full system-prompt override — replaces the CLI's default Claude Code identity
    // so the requested persona (e.g. a domain assistant) actually takes effect.
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    // Support headless operation without permission prompts
    if (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "true") {
      args.push("--dangerously-skip-permissions");
    }

    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isContentDelta(message)) {
          // Emit content delta for streaming
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the idle and hard-cap timers (not the force-kill timer, which must
   * outlive them to guarantee SIGKILL lands).
   */
  private clearTimers(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.maxTimeoutId) {
      clearTimeout(this.maxTimeoutId);
      this.maxTimeoutId = null;
    }
  }

  /**
   * Kill the subprocess (e.g. on client disconnect). Uses the same
   * SIGTERM→SIGKILL escalation so a stuck CLI is always reaped.
   */
  kill(_signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.escalateKill();
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
