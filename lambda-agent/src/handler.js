// src/handler.js
// ═══════════════════════════════════════════════════════════════
//  PRESIDIO SRE TRIAGE AGENT — Lambda Entry Point
//  Trigger: SNS event from CloudWatch Alarm
//  Flow: Alarm → Agent investigates (its own choice of tools) → Slack Brief
//
//  This used to run a fixed Promise.all([logs, metrics, commits]) fan-out
//  for every incident. It now hands the incident to an agent loop that
//  decides which tools to call and when it has enough evidence — see
//  src/engine/agent-loop.js and src/engine/tools.js.
// ═══════════════════════════════════════════════════════════════

try { require("dotenv").config(); } catch {}

const { LLMClient } = require("./engine/llm-client");
const { buildTools } = require("./engine/tools");
const { AgentLoop } = require("./engine/agent-loop");
const { SlackNotifier } = require("./slack/slack-notifier");
const { Logger } = require("./utils/logger");
const { resolveTenantConfig } = require("./config/connector-registry");

module.exports.main = async (event) => {
  const log = new Logger("TRIAGE");

  log.banner("PRESIDIO SRE TRIAGE AGENT — ACTIVATED");

  const alarmData = parseAlarmEvent(event);
  log.info(`Alarm: ${alarmData.alarmName}`);
  log.info(`Client: ${alarmData.client} | Service: ${alarmData.service} | Env: ${alarmData.environment}`);

  // Look up self-configured connector settings for this tenant/app (set up via
  // the console UI). Falls back to env vars if nothing's configured yet — keeps
  // the original single-tenant demo working even without touching the console.
  const tenantId = process.env.TENANT_ID || "demo";
  const tenantConfig = await resolveTenantConfig(tenantId, alarmData.service);
  if (tenantConfig) {
    log.info(`Loaded connector config for tenant "${tenantId}" / app "${alarmData.service}" from registry`);
  } else {
    log.info(`No registry config for tenant "${tenantId}" / app "${alarmData.service}" — using env var defaults`);
  }

  const toolCtx = {
    logGroupName: tenantConfig?.logGroupName || process.env.LOG_GROUP_NAME || "/ecs/acme-payment-service",
    metricNamespace: tenantConfig?.metricNamespace || process.env.METRIC_NAMESPACE || "AcmeApp",
    alarmName: tenantConfig?.alarmName || alarmData.alarmName,
    github: tenantConfig?.github || null,
  };

  const llmClient = new LLMClient();
  const tools = buildTools(toolCtx);
  const agent = new AgentLoop({ llmClient, tools, log });
  const slackNotifier = new SlackNotifier(tenantConfig?.slack || {});

  // ═══════════════════════════════════════════
  //  STEP 1: Agent investigates — its own choice of tools
  // ═══════════════════════════════════════════
  log.step(1, "AGENT INVESTIGATING (autonomous tool selection)");

  const triageResult = await agent.run(alarmData);

  log.info(`Investigation path: ${triageResult.investigationPath?.join(" → ") || "(none)"}`);
  log.info(`Confidence: ${triageResult.confidence}%`);
  log.info(`Severity: ${triageResult.severity}`);
  log.info(`Token usage: ${triageResult.tokenUsage?.input || 0} in / ${triageResult.tokenUsage?.output || 0} out`);
  log.info(`Estimated cost: ${triageResult.estimatedCost}`);

  // ═══════════════════════════════════════════
  //  STEP 2: Post Triage Brief to Slack
  // ═══════════════════════════════════════════
  log.step(2, "POSTING INCIDENT TRIAGE BRIEF TO SLACK");

  const slackResult = await slackNotifier.postTriageBrief(triageResult, alarmData);

  if (slackResult.success) {
    log.ok(`Triage brief posted to Slack (ts: ${slackResult.messageTs})`);
  } else {
    log.error(`Slack post failed: ${slackResult.error}`);
  }

  // ═══════════════════════════════════════════
  //  DONE
  // ═══════════════════════════════════════════
  const totalTimeSec = ((Date.now() - log.startTime) / 1000).toFixed(1);

  log.banner(`TRIAGE COMPLETE — Total: ${totalTimeSec}s | Confidence: ${triageResult.confidence}% | Severity: ${triageResult.severity}`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "triage_complete",
      totalTimeSec,
      confidence: triageResult.confidence,
      severity: triageResult.severity,
      investigationPath: triageResult.investigationPath,
      slackPosted: slackResult.success,
      cost: triageResult.estimatedCost,
    }),
  };
};

// ─── SNS Event Parser ────────────────────────────────────────

function parseAlarmEvent(event) {
  // Try to parse as SNS event (from CloudWatch Alarm → SNS → Lambda)
  try {
    const snsRecord = event.Records?.[0]?.Sns;
    if (snsRecord) {
      const message = JSON.parse(snsRecord.Message);
      return {
        alarmName: message.AlarmName || "unknown-alarm",
        description: message.AlarmDescription || message.NewStateReason || "",
        region: message.Region || process.env.AWS_REGION || "us-east-1",
        timestamp: snsRecord.Timestamp || new Date().toISOString(),
        stateChangeTime: message.StateChangeTime || null,
        oldState: message.OldStateValue || null,
        newState: message.NewStateValue || "ALARM",
        // In production, these would come from alarm tags via DescribeAlarms
        client: "Acme Corp",
        service: "payment-service",
        environment: "Production",
      };
    }
  } catch (e) {
    // Not an SNS event — fall through to direct invocation parsing
  }

  // Direct invocation (for local testing / manual Lambda invocation)
  return {
    alarmName: event.alarmName || "acme-payment-5xx-critical",
    description: event.description || "5xx error threshold exceeded",
    region: event.region || process.env.AWS_REGION || "us-east-1",
    timestamp: event.timestamp || new Date().toISOString(),
    client: event.client || "Acme Corp",
    service: event.service || "payment-service",
    environment: event.environment || "Production",
  };
}
