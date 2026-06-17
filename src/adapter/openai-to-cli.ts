/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIMessageContent } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku" | string;

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  systemPrompt?: string;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names
  "claude-opus-4": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
  // 4.7 generation (latest)
  "claude-opus-4-7": "claude-opus-4-7",
  // 4.6 generation
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  // 4.5 generation
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
  // With provider prefix (claude-code-cli/)
  "claude-code-cli/claude-opus-4": "opus",
  "claude-code-cli/claude-sonnet-4": "sonnet",
  "claude-code-cli/claude-haiku-4": "haiku",
  "claude-code-cli/claude-opus-4-6": "claude-opus-4-6",
  "claude-code-cli/claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-code-cli/claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-code-cli/claude-haiku-4-5": "claude-haiku-4-5",
  // With provider prefix (claude-proxy/)
  "claude-proxy/claude-opus-4": "opus",
  "claude-proxy/claude-sonnet-4": "sonnet",
  "claude-proxy/claude-haiku-4": "haiku",
  "claude-proxy/claude-opus-4-6": "claude-opus-4-6",
  "claude-proxy/claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-proxy/claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-proxy/claude-haiku-4-5": "claude-haiku-4-5",
  // Short aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping any provider prefix (claude-code-cli/, claude-proxy/, claude-max/, ...)
  const stripped = model.replace(/^[^/]+\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Passthrough: pass model name as-is to Claude CLI
  // This way new models (e.g. claude-opus-4-8) work automatically
  // without needing to update the proxy
  return stripped || model;
}

/**
 * Extract text from OpenAI message content (handles string, array, and null)
 */
function extractContentText(content: OpenAIMessageContent): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .filter((part): part is typeof part & { text: string } =>
        part.type === "text" && typeof part.text === "string"
      )
      .map((part) => part.text)
      .join("\n");
  }
  return String(content);
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(messages: OpenAIChatRequest["messages"]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractContentText(msg.content);
    if (!text) continue;

    switch (msg.role) {
      case "system":
      case "developer":
        // System/developer messages are forwarded via the CLI's --system-prompt
        // flag (see systemPromptFrom), NOT embedded in the user prompt — otherwise
        // the CLI's own default identity overrides them. Skip here.
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Concatenate all system/developer messages into a single system prompt string.
 * Forwarded to the CLI via --system-prompt so it fully overrides the default
 * Claude Code identity (otherwise the model ignores the requested persona).
 */
export function systemPromptFrom(messages: OpenAIChatRequest["messages"]): string | undefined {
  const sys = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => extractContentText(m.content))
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
  return sys.length > 0 ? sys : undefined;
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
    systemPrompt: systemPromptFrom(request.messages),
  };
}
