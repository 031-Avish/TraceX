const test = require("node:test");
const assert = require("node:assert/strict");
const { LLMClient } = require("../src/engine/llm-client");

test("OpenRouter client sends OpenAI-compatible tools and normalizes tool calls", async () => {
  let request;
  const fakeClient = {
    chat: { completions: { create: async (body) => {
      request = body;
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_error_logs", arguments: "{\"windowMinutes\":15}" } }],
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      };
    } } },
  };

  const client = new LLMClient({ apiKey: "test-key", model: "test/model", client: fakeClient });
  const tools = [{ type: "function", function: { name: "get_error_logs", parameters: { type: "object" } } }];
  const result = await client.chat({ messages: [{ role: "user", content: "incident" }], tools, systemPrompt: "system" });

  assert.equal(request.model, "test/model");
  assert.deepEqual(request.messages[0], { role: "system", content: "system" });
  assert.equal(request.tools[0].function.name, "get_error_logs");
  assert.equal(result.toolCalls[0].function.name, "get_error_logs");
  assert.equal(result.assistantMessage.tool_calls[0].id, "call_1");
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 8 });
});
