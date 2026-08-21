// src/engine/agent-loop.js
// The agent: given an incident, decides which tools to call and when it has
// enough evidence to conclude. Uses Anthropic Claude's native tool calling.
//
// Loop shape (ReAct-style):
//   1. Send the incident + available tools to Claude
//   2. Claude returns tool_use blocks (investigate more) or calls submit_triage_brief (done)
//   3. Execute requested tools, sanitize + truncate results, feed back as tool_result
//   4. Repeat, bounded by MAX_TURNS and a wall-clock budget

const { sanitize } = require("../utils/sanitizer");

const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 6);
const MAX_TOOL_RESULT_CHARS = Number(process.env.AGENT_MAX_TOOL_RESULT_CHARS || 4000);
const MAX_ARRAY_ITEMS = Number(process.env.AGENT_MAX_ARRAY_ITEMS || 20);
const WALL_CLOCK_BUDGET_MS = Number(process.env.AGENT_WALL_CLOCK_BUDGET_MS || 65000);

class AgentLoop {
  constructor({ llmClient, tools, log }) {
    this.llm = llmClient;
    this.schemas = tools.schemas;
    this.executors = tools.executors;
    this.log = log;
  }

  async run(alarmData) {
    const startTime = Date.now();
    const investigationPath = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Anthropic format: system prompt is separate, messages start with user
    const systemPrompt = this._systemPrompt();
    const messages = [
      { role: "user", content: this._incidentSummary(alarmData) },
    ];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (Date.now() - startTime > WALL_CLOCK_BUDGET_MS) {
        this.log.warn(`Agent hit wall-clock budget after ${turn - 1} turn(s)`);
        return this._fallback(investigationPath, "wall-clock budget exceeded", startTime, totalInputTokens, totalOutputTokens);
      }

      let response;
      try {
        response = await this.llm.chat({ messages, tools: this.schemas, systemPrompt });
      } catch (error) {
        this.log.error(`LLM call failed on turn ${turn}: ${error.message}`);
        return this._fallback(investigationPath, error.message, startTime, totalInputTokens, totalOutputTokens);
      }

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      // Push assistant response into conversation history
      // Anthropic expects: { role: "assistant", content: [...blocks...] }
      messages.push({ role: "assistant", content: response.rawContent });

      if (!response.toolCalls.length) {
        // Model answered in plain text without calling any tool.
        // Nudge it once toward submit_triage_brief.
        this.log.warn(`Turn ${turn}: no tool call — nudging toward submit_triage_brief`);
        messages.push({
          role: "user",
          content: "Call the submit_triage_brief tool now with your findings, or call another tool if you need more evidence.",
        });
        continue;
      }

      // Process each tool call
      // In Anthropic format, tool results go as a user message with tool_result content blocks
      const toolResultBlocks = [];

      for (const toolCall of response.toolCalls) {
        const name = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch { args = {}; }

        // Terminal tool — agent is done investigating
        if (name === "submit_triage_brief") {
          const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
          const cost = this.llm.estimateCost(totalInputTokens, totalOutputTokens);
          this.log.ok(`Agent concluded after ${investigationPath.length} tool call(s): ${investigationPath.join(" → ") || "(none)"} → submit_triage_brief`);
          return {
            ...args,
            triageTimeSec: elapsedSec,
            investigationPath,
            tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
            estimatedCost: `$${cost.toFixed(4)}`,
            turnsUsed: turn,
          };
        }

        // Execute the investigation tool
        investigationPath.push(name);
        this.log.info(`Turn ${turn}: agent calling ${name}(${JSON.stringify(args)})`);

        const executor = this.executors[name];
        let resultContent;
        if (!executor) {
          resultContent = JSON.stringify({ error: `Unknown tool: ${name}` });
        } else {
          try {
            const result = await executor(args);
            const limited = this._limitArrays(result);
            resultContent = this._truncate(sanitize(JSON.stringify(limited)));
          } catch (error) {
            resultContent = JSON.stringify({ error: error.message });
          }
        }

        // Anthropic tool_result format
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: resultContent,
        });
      }

      // Push all tool results as a single user message (Anthropic format)
      if (toolResultBlocks.length > 0) {
        messages.push({ role: "user", content: toolResultBlocks });
      }
    }

    this.log.warn(`Agent hit MAX_TURNS (${MAX_TURNS}) without calling submit_triage_brief`);
    return this._fallback(investigationPath, `exceeded ${MAX_TURNS} turns`, startTime, totalInputTokens, totalOutputTokens);
  }

  _limitArrays(value) {
    if (Array.isArray(value)) {
      const capped = value.length > MAX_ARRAY_ITEMS ? value.slice(-MAX_ARRAY_ITEMS) : value;
      return capped.map((v) => this._limitArrays(v));
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, val] of Object.entries(value)) out[key] = this._limitArrays(val);
      return out;
    }
    return value;
  }

  _truncate(str) {
    if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
    return str.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... [truncated — ${str.length - MAX_TOOL_RESULT_CHARS} chars omitted]`;
  }

  _fallback(investigationPath, reason, startTime, inputTokens, outputTokens) {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost = this.llm.estimateCost(inputTokens, outputTokens);
    return {
      rootCause: `Automated analysis incomplete: ${reason}. Evidence gathered (${investigationPath.join(", ") || "none"}) is available for manual review.`,
      timeline: "• Automated triage did not reach a conclusion — see agent logs",
      financialImpact: "• Requires manual assessment",
      remediation: "Escalate to L2/L3 for manual root cause analysis.",
      confidence: 0,
      severity: "P1",
      triageTimeSec: elapsedSec,
      investigationPath,
      tokenUsage: { input: inputTokens, output: outputTokens },
      estimatedCost: `$${cost.toFixed(4)}`,
      turnsUsed: null,
    };
  }

  _systemPrompt() {
    return `You are an autonomous Site Reliability Engineer investigating a production incident.

You have tools to gather evidence — logs, metrics, alarm details, Git commits and diffs.
You decide which tools to call and in what order. Do not call tools you don't need.
A typical investigation needs 2-4 tool calls.

Investigation approach:
- Start with whichever signal is most likely to explain the incident.
- If a stack trace points at a specific commit, pull that commit's diff.
- Stop once you can state a root cause with real evidence.

When you have enough evidence, call submit_triage_brief exactly once with your conclusion.
Cite specific evidence (commit SHAs, file/line, log timestamps) — do not speculate.`;
  }

  _incidentSummary(alarmData) {
    const summary = `INCIDENT ALERT

Alarm: ${alarmData.alarmName || "unknown"}
Description: ${alarmData.description || "threshold exceeded"}
Client: ${alarmData.client || "unknown"}
Service: ${alarmData.service || "unknown"}
Environment: ${alarmData.environment || "unknown"}
Region: ${alarmData.region || "us-east-1"}
Triggered at: ${alarmData.timestamp || new Date().toISOString()}

Investigate this incident using the available tools and submit a triage brief when you have enough evidence.`;
    return sanitize(summary);
  }
}

module.exports = { AgentLoop };
