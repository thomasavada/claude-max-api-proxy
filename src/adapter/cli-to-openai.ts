/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
} from "../types/openai.js";
import { parseToolCalls } from "./tools.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Build OpenAI `tool_calls` from parsed CLI text output. Returns null when the
 * model produced a normal text answer (no tool call). Each call gets a
 * deterministic-shaped OpenAI id (`call_<uuid>`).
 */
export function toolCallsFromText(text: string): OpenAIToolCall[] | null {
  const parsed = parseToolCalls(text);
  if (parsed.length === 0) return null;
  return parsed.map((p) => ({
    id: `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
    type: "function" as const,
    function: { name: p.name, arguments: p.arguments },
  }));
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response.
 *
 * When `toolMode` is set and the model emitted the tool-call contract, the
 * response carries `message.tool_calls` with finish_reason:"tool_calls"
 * (content null), matching OpenAI function-calling semantics. Otherwise it is a
 * normal text completion.
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  opts?: { toolMode?: boolean }
): OpenAIChatResponse {
  // Get model from modelUsage or default
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  const text = ensureString(result.result);
  const toolCalls = opts?.toolMode ? toolCallsFromText(text) : null;

  const usage = {
    prompt_tokens: result.usage?.input_tokens || 0,
    completion_tokens: result.usage?.output_tokens || 0,
    total_tokens:
      (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
  };

  if (toolCalls) {
    return {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: normalizeModelName(modelName),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: toolCalls },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    };
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
/**
 * Defensively convert any value to string to prevent [object Object] in responses
 */
function ensureString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
