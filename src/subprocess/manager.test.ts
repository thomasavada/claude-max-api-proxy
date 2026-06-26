/**
 * Subprocess manager tests — focus on the long-running-task hardening:
 * idle timeout, clean completion, and SIGTERM→SIGKILL escalation.
 *
 * We inject a fake CLI via CLAUDE_CLI_BIN so these run without the real
 * `claude` binary and without network access. Module-level knobs
 * (CLAUDE_CLI_BIN, CLAUDE_KILL_GRACE_MS) are read at import time, so they
 * MUST be set before the dynamic import below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake `claude` CLI whose behavior is chosen at spawn time via FAKE_MODE.
const FAKE_CLI = `#!/usr/bin/env node
const mode = process.env.FAKE_MODE || "active";
if (mode === "active") {
  // Produce one line then exit cleanly — the happy path.
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok" }) + "\\n");
  process.exit(0);
} else if (mode === "stuck") {
  // Alive but silent — should trip the idle timeout.
  setInterval(() => {}, 1000);
} else if (mode === "ignore-term") {
  // Ignore SIGTERM so only SIGKILL can stop us — tests escalation.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
`;

const dir = mkdtempSync(join(tmpdir(), "claude-fake-"));
const fakeCli = join(dir, "fake-claude.mjs");
writeFileSync(fakeCli, FAKE_CLI);
chmodSync(fakeCli, 0o755);

process.env.CLAUDE_CLI_BIN = fakeCli;
process.env.CLAUDE_KILL_GRACE_MS = "150"; // keep escalation fast in tests

const { ClaudeSubprocess } = await import("./manager.js");

// Reject if a promise doesn't settle in time, so a hung subprocess fails the
// test loudly instead of stalling the whole run.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms).unref()
    ),
  ]);
}

const opts = (extra: Record<string, unknown> = {}) =>
  ({ model: "sonnet", ...extra } as any);

test("emits a timeout error when the subprocess is silent past the idle window", async () => {
  process.env.FAKE_MODE = "stuck";
  const sp = new ClaudeSubprocess();
  const errP = once(sp, "error");
  await sp.start("hi", opts({ timeout: 200 })); // 200ms idle window
  const [err] = (await withTimeout(errP, 2000, "idle-timeout error")) as [Error];
  assert.match(err.message, /timed out/i);
});

test("completes cleanly (code 0, no error) when the subprocess exits normally", async () => {
  process.env.FAKE_MODE = "active";
  const sp = new ClaudeSubprocess();
  let errored = false;
  sp.on("error", () => {
    errored = true;
  });
  const closeP = once(sp, "close");
  await sp.start("hi", opts({ timeout: 5000 }));
  const [code] = (await withTimeout(closeP, 2000, "clean close")) as [number | null];
  assert.equal(code, 0);
  assert.equal(errored, false);
});

test("escalates to SIGKILL when the subprocess ignores SIGTERM", async () => {
  process.env.FAKE_MODE = "ignore-term";
  const sp = new ClaudeSubprocess();
  const closeP = once(sp, "close");
  await sp.start("hi", opts({ timeout: 60000 }));
  await new Promise((r) => setTimeout(r, 100)); // let the child install its SIGTERM handler
  sp.kill(); // SIGTERM ignored → must escalate to SIGKILL within the grace window
  // If escalation failed, the child stays alive forever and this times out.
  await withTimeout(closeP, 2000, "force-kill close");
});
