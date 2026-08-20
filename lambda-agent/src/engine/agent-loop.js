// src/engine/agent-loop.js
// The agent: given an incident, decides which tools to call and when it has
// enough evidence to conclude. Replaces the old fixed Promise.all([...]) fan-out.
//
// Loop shape (ReAct-style, via native tool calling):
//   1. Send the incident + available tools to the model
//   2. Model returns tool_calls (investigate more) or calls submit_triage_brief (done)
//   3. Execute requested tools, sanitize + truncate results, feed back as tool messages
//   4. Repeat, bounded by MAX_TURNS and a wall-clock budget (Lambda has 90s total)

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

    const messages = [
      { role: "system", content: this._systemPrompt() },
      { role: "user", content: this._incidentSummary(alarmData) },
    ];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (Date.now() - startTime > WALL_CLOCK_BUDGET_MS) {
        this.log.warn(`Agent hit wall-clock budget after ${turn - 1} turn(s) — finalizing with available evidence`);
        return this._fallback(investigationPath, "wall-clock budget exceeded before conclusion", startTime, totalInputTokens, totalOutputTokens);
      }

      let response;
      try {
        response = await this.llm.chat({ messages, tools: this.schemas });
      } catch (error) {
        this.log.error(`LLM call failed on turn ${turn}: ${error.message}`);
        return this._fallback(investigationPath, error.message, startTime, totalInputTokens, totalOutputTokens);
      }

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      if (!response.toolCalls.length) {
        // Model answered in plain text instead of calling submit_triage_brief.
        // Nudge it once rather than failing the whole investigation.
        this.log.warn(`Turn ${turn}: model responded without a tool call — nudging toward submit_triage_brief`);
        messages.push(response.message);
        messages.push({
          role: "user",
          content: "Call the submit_triage_brief tool now with your findings, or call another tool if you need more evidence.",
        });
        continue;
      }

      messages.push(response.message);

      for (const toolCall of response.toolCalls) {
        const name = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          args = {};
        }

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

        investigationPath.push(name);
        this.log.info(`Turn ${turn}: agent calling ${name}(${JSON.stringify(args)})`);

        const executor = this.executors[name];
        let resultContent;
        if (!executor) {
          resultContent = JSON.stringify({ error: `Unknown tool: ${name}` });
        } else {
          try {
            const result = await executor(args);
            // Cap array volume BEFORE stringifying, keeping the most recent items —
            // collector results are chronological (oldest first), so blind char-slicing
            // the serialized string would keep the oldest, least relevant entries and
            // could drop the most recent one (often the actual smoking-gun error).
            const limited = this._limitArrays(result);
            resultContent = this._truncate(sanitize(JSON.stringify(limited)));
          } catch (error) {
            resultContent = JSON.stringify({ error: error.message });
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultContent,
        });
      }
    }

    this.log.warn(`Agent hit MAX_TURNS (${MAX_TURNS}) without calling submit_triage_brief`);
    return this._fallback(investigationPath, `exceeded ${MAX_TURNS} turns without a conclusion`, startTime, totalInputTokens, totalOutputTokens);
  }

  // Recursively caps any array to its most recent MAX_ARRAY_ITEMS entries
  // (arrays here are always chronological, oldest-first, or file lists —
  // "most recent" is the right thing to keep in both cases). This is the
  // primary volume control; _truncate below is only a last-resort backstop.
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
    return str.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... [truncated — ${str.length - MAX_TOOL_RESULT_CHARS} more chars omitted to control token spend]`;
  }

  _fallback(investigationPath, reason, startTime, inputTokens, outputTokens) {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost = this.llm.estimateCost(inputTokens, outputTokens);
    return {
      rootCause: `Automated analysis incomplete: ${reason}. Evidence gathered so far (${investigationPath.join(", ") || "none"}) is available for manual review.`,
      timeline: "• Automated triage did not reach a conclusion — see agent logs for the investigation path so far",
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

You have a set of tools to gather evidence — logs, metrics, alarm details, Git commits and diffs.
You decide which tools to call and in what order, based on what this specific incident looks like.
Do not call tools you don't need. Every tool call costs money and time — investigate efficiently,
not exhaustively. A typical investigation needs 2-4 tool calls before you have enough evidence.

Investigation approach:
- Start with whichever signal is most likely to explain the incident given the alarm description.
- If deployment logs or a stack trace point at a specific commit, pull that commit's diff before concluding.
- Stop investigating once you can state a root cause with real evidence — don't call every tool "just in case".

When you have enough evidence, call submit_triage_brief exactly once with your conclusion. Cite specific
evidence (commit SHAs, file/line, log timestamps) in your root cause — do not speculate without evidence
you actually pulled via a tool call.`;
  }

  _incidentSummary(alarmData) {
    // AlarmName/Description come from the CloudWatch alarm's own config — in
    // production that's operator-authored free text, not guaranteed clean, so
    // it goes through the same sanitizer as every tool result before reaching
    // the model. (client/service/environment are fixed demo values, not user
    // input, but sanitizing the whole block is one less thing to reason about.)
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
