// src/engine/triage-engine.js
// Core LLM-powered triage engine.
// Sends filtered, sanitized observability context to Claude for root cause analysis.
// Uses structured prompting to get consistent, parseable output.

const Anthropic = require("@anthropic-ai/sdk");
const { sanitize } = require("../utils/sanitizer");

class TriageEngine {
  constructor() {
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env automatically
    this.model = "claude-sonnet-4-5-20250514";
  }

  /**
   * Main entry point: analyze incident data and return structured triage result.
   */
  async analyze({ logs, metrics, commits, alarmData }) {
    const startTime = Date.now();

    const systemPrompt = this._getSystemPrompt();
    const userPrompt = this._buildPrompt({ logs, metrics, commits, alarmData });

    const promptTokenEstimate = Math.ceil(userPrompt.length / 4);
    console.log(`    Prompt size: ~${promptTokenEstimate} tokens`);
    console.log(`    Model: ${this.model}`);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });

      const analysisText = response.content[0].text;
      const analysisTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);

      // Calculate cost estimate
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const estimatedCost = (inputTokens * 0.003 / 1000) + (outputTokens * 0.015 / 1000);

      console.log(`    Input tokens: ${inputTokens}, Output tokens: ${outputTokens}`);
      console.log(`    Estimated cost: $${estimatedCost.toFixed(4)}`);

      const parsed = this._parseResponse(analysisText, analysisTimeSec);
      parsed.tokenUsage = { input: inputTokens, output: outputTokens };
      parsed.estimatedCost = `$${estimatedCost.toFixed(4)}`;
      parsed.analysisTimeSec = analysisTimeSec;

      return parsed;
    } catch (error) {
      const analysisTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`    Claude API error: ${error.message}`);
      return this._fallbackResponse(error.message, analysisTimeSec);
    }
  }

  _getSystemPrompt() {
    return `You are an expert Site Reliability Engineer (SRE) performing automated incident triage for Presidio Managed Services. Your job is to analyze observability data from client cloud environments and produce a precise, actionable incident analysis.

ANALYSIS PRINCIPLES:
1. EVIDENCE-BASED: Cite specific log entries, commit SHAs, metric timestamps, and stack traces.
2. TEMPORAL CORRELATION: Map the timeline — when did the deployment happen relative to when errors started?
3. FINANCIALLY AWARE: Quantify the cost/revenue impact of the incident.
4. ACTIONABLE: Provide exact CLI commands for remediation, not vague suggestions.
5. CALIBRATED CONFIDENCE: State your confidence honestly. If evidence is weak, say so.

YOU MUST RESPOND IN EXACTLY THIS FORMAT (use these exact headers):

ROOT_CAUSE:
[2-3 sentence technical root cause analysis. Cite the specific commit SHA, file, line, or config change. Explain the causal chain from change to failure.]

TIMELINE:
• T-[X] min: [event with evidence]
• T-[Y] min: [event with evidence]
[4-6 chronological entries from earliest to most recent. Use negative time relative to alarm trigger.]

FINANCIAL_IMPACT:
• [metric]: [quantified value]
• [metric]: [quantified value]
[2-4 items. Include failed transactions, estimated revenue loss rate, and any infrastructure waste like auto-scaling burn.]

REMEDIATION:
[Exact CLI command in a code block — e.g., aws ecs update-service with rollback params]
[1-2 sentences explaining why this fixes the root cause]

CONFIDENCE: [number]%
SEVERITY: [P1 or P2 or P3]

Do not add any text outside these sections. Do not add introductions or conclusions.`;
  }

  _buildPrompt({ logs, metrics, commits, alarmData }) {
    // Sanitize all data before including in prompt
    const sanitizedLogs = sanitize(JSON.stringify(logs.events || logs, null, 2));
    const sanitizedMetrics = sanitize(JSON.stringify(metrics.metrics || metrics, null, 2));
    const sanitizedCommits = sanitize(JSON.stringify(commits.commits || commits, null, 2));

    // Truncate if too long (keep under ~6000 tokens)
    const maxChars = 20000;
    const truncatedLogs = sanitizedLogs.length > maxChars
      ? sanitizedLogs.substring(0, maxChars) + "\n... [truncated for token budget]"
      : sanitizedLogs;

    return `INCIDENT TRIAGE REQUEST
=====================

ALARM DETAILS:
- Alarm Name: ${alarmData.alarmName || "unknown"}
- Description: ${alarmData.description || "Threshold exceeded"}
- Region: ${alarmData.region || "us-east-1"}
- Trigger Time: ${alarmData.timestamp || new Date().toISOString()}
- Client: ${alarmData.client || "Unknown Client"}
- Service: ${alarmData.service || "unknown-service"}
- Environment: ${alarmData.environment || "Production"}

ALARM STATE (from CloudWatch):
${alarmData.alarmDetails ? JSON.stringify(alarmData.alarmDetails, null, 2) : "Not available"}

──────────────────────────────────────────────

RECENT ERROR LOGS (last 15 minutes, filtered to ERROR/FATAL/5xx):
${truncatedLogs}

──────────────────────────────────────────────

CLOUDWATCH METRICS (last 30 minutes, 1-min resolution):
${sanitizedMetrics}

──────────────────────────────────────────────

RECENT GIT COMMITS (last 10 commits to main branch):
${sanitizedCommits}

──────────────────────────────────────────────

Analyze this incident data. Identify the root cause, reconstruct the timeline, quantify the financial impact, and provide the exact remediation command.`;
  }

  _parseResponse(text, triageTimeSec) {
    const result = {
      rootCause: this._extractSection(text, "ROOT_CAUSE:") || "Unable to determine root cause from available data.",
      timeline: this._extractSection(text, "TIMELINE:") || "Timeline data insufficient for analysis.",
      financialImpact: this._extractSection(text, "FINANCIAL_IMPACT:") || "Financial impact requires manual assessment.",
      remediation: this._extractSection(text, "REMEDIATION:") || "Manual investigation and remediation recommended. Escalate to L3.",
      confidence: 75,
      severity: "P1",
      triageTimeSec,
      rawAnalysis: text,
    };

    // Extract confidence
    const confMatch = text.match(/CONFIDENCE:\s*(\d+)/i);
    if (confMatch) result.confidence = Math.min(parseInt(confMatch[1]), 100);

    // Extract severity
    const sevMatch = text.match(/SEVERITY:\s*(P[1-3])/i);
    if (sevMatch) result.severity = sevMatch[1].toUpperCase();

    return result;
  }

  _extractSection(text, header) {
    const headerIndex = text.indexOf(header);
    if (headerIndex === -1) return null;

    const contentStart = headerIndex + header.length;
    const nextHeaders = [
      "ROOT_CAUSE:", "TIMELINE:", "FINANCIAL_IMPACT:",
      "REMEDIATION:", "CONFIDENCE:", "SEVERITY:",
    ];

    let endIndex = text.length;
    for (const nh of nextHeaders) {
      if (nh === header) continue;
      const idx = text.indexOf(nh, contentStart);
      if (idx !== -1 && idx < endIndex) endIndex = idx;
    }

    return text.substring(contentStart, endIndex).trim();
  }

  _fallbackResponse(errorMessage, triageTimeSec) {
    return {
      rootCause: `⚠️ Automated analysis unavailable (${errorMessage}). Manual triage required — raw log data was collected successfully and is available for human review.`,
      timeline: "• Automated timeline generation failed\n• Review raw logs in CloudWatch for manual correlation",
      financialImpact: "• Financial impact assessment requires manual analysis\n• Check billing dashboard for anomalous spend",
      remediation: "1. Escalate to L2/L3 for manual root cause analysis\n2. Review recent deployments in the CI/CD pipeline\n3. Check CloudWatch Logs Insights for error pattern analysis",
      confidence: 0,
      severity: "P1",
      triageTimeSec,
      rawAnalysis: null,
      tokenUsage: { input: 0, output: 0 },
      estimatedCost: "$0.0000",
    };
  }
}

module.exports = { TriageEngine };
