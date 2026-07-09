import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolSystemPrompt,
  renderToolConversation,
  parseToolCalls,
  CONTRACT_MARKER_START,
} from "./tools.js";
import { openaiToCli } from "./openai-to-cli.js";
import type { OpenAITool, OpenAIChatRequest } from "../types/openai.js";

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

test("buildToolSystemPrompt lists the tool and the contract marker", () => {
  const sp = buildToolSystemPrompt([weatherTool], "auto", undefined);
  assert.match(sp, /get_weather/);
  assert.match(sp, /Get current weather/);
  assert.ok(sp.includes(CONTRACT_MARKER_START));
});

test("buildToolSystemPrompt honors tool_choice=none / required / forced", () => {
  assert.match(buildToolSystemPrompt([weatherTool], "none", undefined), /MUST NOT call/);
  assert.match(buildToolSystemPrompt([weatherTool], "required", undefined), /MUST call one/);
  const forced = buildToolSystemPrompt(
    [weatherTool],
    { type: "function", function: { name: "get_weather" } },
    undefined
  );
  assert.match(forced, /MUST call the tool "get_weather"/);
});

test("buildToolSystemPrompt preserves caller system prompt", () => {
  const sp = buildToolSystemPrompt([weatherTool], "auto", "You are Bob.");
  assert.match(sp, /You are Bob\./);
});

test("parseToolCalls: marker form", () => {
  const out = `${CONTRACT_MARKER_START} {"name":"get_weather","arguments":{"city":"Hanoi"}}`;
  const calls = parseToolCalls(out);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_weather");
  assert.equal(calls[0].arguments, '{"city":"Hanoi"}');
});

test("parseToolCalls: multiple markers", () => {
  const out = [
    `${CONTRACT_MARKER_START} {"name":"a","arguments":{"x":1}}`,
    `${CONTRACT_MARKER_START} {"name":"b","arguments":{"y":2}}`,
  ].join("\n");
  const calls = parseToolCalls(out);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ["a", "b"]);
});

test("parseToolCalls: bare json object fallback", () => {
  const calls = parseToolCalls('{"name":"get_weather","arguments":{"city":"Hanoi"}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_weather");
});

test("parseToolCalls: {tool_call:{...}} fallback", () => {
  const calls = parseToolCalls('{"tool_call":{"name":"get_weather","arguments":{"city":"Hanoi"}}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_weather");
});

test("parseToolCalls: fenced json is stripped", () => {
  const calls = parseToolCalls('```json\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```');
  assert.equal(calls.length, 1);
});

test("parseToolCalls: plain text answer yields no calls", () => {
  assert.equal(parseToolCalls("The weather in Hanoi is sunny.").length, 0);
});

test("renderToolConversation renders tool results and prior tool_calls", () => {
  const rendered = renderToolConversation([
    { role: "user", content: "Weather in Hanoi?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":31}' },
  ]);
  assert.match(rendered, /User: Weather in Hanoi\?/);
  assert.match(rendered, /Assistant \(called tools\)/);
  assert.match(rendered, /Tool result \(get_weather\): \{"temp":31\}/);
});

test("openaiToCli: no tools -> not tool mode (path unchanged)", () => {
  const req: OpenAIChatRequest = {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "hi" }],
  };
  const cli = openaiToCli(req);
  assert.equal(cli.toolMode, undefined);
  assert.equal(cli.prompt, "hi");
});

test("openaiToCli: tools present -> tool mode with contract system prompt", () => {
  const req: OpenAIChatRequest = {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "Weather in Hanoi?" }],
    tools: [weatherTool],
    tool_choice: "auto",
  };
  const cli = openaiToCli(req);
  assert.equal(cli.toolMode, true);
  assert.ok(cli.systemPrompt && cli.systemPrompt.includes("get_weather"));
  assert.match(cli.prompt, /User: Weather in Hanoi\?/);
});
