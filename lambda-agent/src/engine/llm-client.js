// OpenRouter client using its OpenAI-compatible Chat Completions API.
// This is the only module that knows which LLM gateway TraceX uses.

const OpenAI = require("openai");

class LLMClient {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY — set it in .env or terraform.tfvars");

    this.model = options.model || process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";
    this.client = options.client || new OpenAI({
      apiKey,
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com/031-Avish/TraceX",
        "X-Title": process.env.OPENROUTER_APP_NAME || "TraceX",
      },
      timeout: Number(process.env.OPENROUTER_TIMEOUT_MS || 30000),
      maxRetries: Number(process.env.OPENROUTER_MAX_RETRIES || 2),
    });

    this.inputCostPer1k = Number(process.env.LLM_INPUT_COST_PER_1K || 0);
    this.outputCostPer1k = Number(process.env.LLM_OUTPUT_COST_PER_1K || 0);
  }

  async chat({ messages, tools, systemPrompt, maxTokens = 1500 }) {
    const requestMessages = systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: requestMessages,
      tools: tools?.length ? tools : undefined,
      tool_choice: tools?.length ? "auto" : undefined,
      max_tokens: maxTokens,
      temperature: 0.1,
    });

    const choice = response.choices?.[0];
    if (!choice?.message) throw new Error("OpenRouter returned no assistant message");

    const toolCalls = (choice.message.tool_calls || []).map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.function?.name, arguments: call.function?.arguments || "{}" },
    }));

    return {
      assistantMessage: {
        role: "assistant",
        content: choice.message.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      textContent: choice.message.content || "",
      toolCalls,
      stopReason: choice.finish_reason,
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
