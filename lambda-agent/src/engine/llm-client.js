// src/engine/llm-client.js
// Wrapper around the Anthropic Claude API with tool-calling support.
// This is the ONLY file that knows about the LLM provider — swapping to
// Azure OpenAI, Bedrock, etc. means editing this file only.
//
// Normalizes Claude's response format to a provider-agnostic shape that
// agent-loop.js consumes, so the agent logic doesn't care which model runs.

const Anthropic = require("@anthropic-ai/sdk");

class LLMClient {
  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("Missing ANTHROPIC_API_KEY — set it in .env or terraform.tfvars");
    }

    this.client = new Anthropic();  // reads ANTHROPIC_API_KEY from env
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250514";

    // Rough cost estimate for the Slack "pipeline cost" line
    this.inputCostPer1k = Number(process.env.LLM_INPUT_COST_PER_1K || 0.003);
    this.outputCostPer1k = Number(process.env.LLM_OUTPUT_COST_PER_1K || 0.015);
  }

  /**
   * Single chat-completion turn with optional tool definitions.
   *
   * Accepts messages in Anthropic's native format:
   *   - System prompt is passed separately (extracted by agent-loop)
   *   - Messages alternate user/assistant
   *   - Tool results are sent as user messages with tool_result content blocks
   *
   * Tools are converted from OpenAI's { type:"function", function:{...} } format
   * to Anthropic's { name, description, input_schema } format automatically.
   */
  async chat({ messages, tools, systemPrompt, maxTokens = 1500 }) {
    // Convert OpenAI-style tool schemas to Anthropic format
    const anthropicTools = (tools || [])
      .filter(t => t.type === "function")
      .map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt || undefined,
      messages,
      tools: anthropicTools.length ? anthropicTools : undefined,
    });

    // Extract tool use blocks from content
    const toolCalls = (response.content || [])
      .filter(block => block.type === "tool_use")
      .map(block => ({
        id: block.id,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      }));

    // Extract text blocks
    const textContent = (response.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");

    return {
      // The raw content array — needed for pushing back into messages
      rawContent: response.content,
      textContent,
      toolCalls,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      },
    };
  }

  estimateCost(inputTokens, outputTokens) {
    return (inputTokens / 1000) * this.inputCostPer1k + (outputTokens / 1000) * this.outputCostPer1k;
  }
}

module.exports = { LLMClient };
