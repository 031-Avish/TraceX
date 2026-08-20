// src/engine/llm-client.js
// Thin wrapper around Azure OpenAI (Azure AI Foundry) chat completions.
// This is the ONLY file that should know about Azure — swapping providers
// later (Claude, a different Foundry deployment, etc.) means editing this
// file only, not the agent loop or tools.

const { AzureOpenAI } = require("openai");

class LLMClient {
  constructor() {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";

    if (!endpoint || !apiKey || !deployment) {
      throw new Error(
        "Missing Azure OpenAI config — set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT"
      );
    }

    this.deployment = deployment;
    this.client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

    // Rough per-1K-token cost estimate for the Slack "pipeline cost" line.
    // Not billing-accurate — override via env if you know your deployment's actual rate.
    this.inputCostPer1k = Number(process.env.LLM_INPUT_COST_PER_1K || 0.005);
    this.outputCostPer1k = Number(process.env.LLM_OUTPUT_COST_PER_1K || 0.015);
  }

  /**
   * Single chat-completion turn with optional tool definitions.
   * Returns the assistant message, any tool calls, finish reason, and token usage.
   */
  async chat({ messages, tools, maxTokens = 1500 }) {
    const response = await this.client.chat.completions.create({
      model: this.deployment, // Azure ignores this for routing (deployment is in the client), but the SDK requires the field
      messages,
      tools: tools && tools.length ? tools : undefined,
      tool_choice: tools && tools.length ? "auto" : undefined,
      max_tokens: maxTokens,
    });

    const choice = response.choices?.[0];
    const message = choice?.message || { role: "assistant", content: "" };

    return {
      message,
      toolCalls: message.tool_calls || [],
      finishReason: choice?.finish_reason,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
    };
  }

  estimateCost(inputTokens, outputTokens) {
    return (inputTokens / 1000) * this.inputCostPer1k + (outputTokens / 1000) * this.outputCostPer1k;
  }
}

module.exports = { LLMClient };
