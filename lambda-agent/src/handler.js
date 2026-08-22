// src/handler.js
// ═══════════════════════════════════════════════════════════════
//  PRESIDIO SRE TRIAGE AGENT — Lambda Entry Point
//  Trigger: SNS event from CloudWatch Alarm
//  Flow: Alarm → Slack parent alert → Agent investigation → threaded brief
//
//  This used to run a fixed Promise.all([logs, metrics, commits]) fan-out
//  for every incident. It now hands the incident to an agent loop that
//  decides which tools to call and when it has enough evidence — see
//  src/engine/agent-loop.js and src/engine/tools.js.
// ═══════════════════════════════════════════════════════════════

try { require("dotenv").config(); } catch {}

const { CloudWatchClient, DescribeAlarmsCommand, ListTagsForResourceCommand } = require("@aws-sdk/client-cloudwatch");
const { LLMClient } = require("./engine/llm-client");
const { buildTools } = require("./engine/tools");
const { AgentLoop } = require("./engine/agent-loop");
const { SlackNotifier } = require("./slack/slack-notifier");
const { Logger } = require("./utils/logger");
const { resolveTenantConfig } = require("./config/connector-registry");
const { createIncident, findLatestIncident, updateIncident } = require("./incidents/incident-store");

let cwClient = null;
function getCWClient(region) {
  if (!cwClient) cwClient = new CloudWatchClient({ region: region || process.env.AWS_REGION || "us-east-1" });
  return cwClient;
}

/**
 * Fetches alarm tags from CloudWatch via DescribeAlarms + ListTagsForResource.
 * Returns a plain object of tag key→value, or {} on any failure.
 * Called once per invocation — result is tiny and not worth caching across invocations.
 */
async function fetchAlarmTags(alarmName, region) {
  try {
    const cw = getCWClient(region);
    const describeResult = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [alarmName], AlarmTypes: ["MetricAlarm"] }));
    const alarm = describeResult.MetricAlarms?.[0];
    if (!alarm?.AlarmArn) return {};
    const tagsResult = await cw.send(new ListTagsForResourceCommand({ ResourceARN: alarm.AlarmArn }));
    const tags = {};
    for (const { Key, Value } of tagsResult.Tags || []) tags[Key] = Value;
    return tags;
  } catch (e) {
    // Non-fatal: fall through to defaults
    return {};
  }
}

module.exports.main = async (event) => {
  const log = new Logger("TRIAGE");

  log.banner("PRESIDIO SRE TRIAGE AGENT — ACTIVATED");

  const alarmData = await parseAlarmEvent(event);
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
    awsRegion: alarmData.region,
    logGroupName: tenantConfig ? tenantConfig.logGroupName : (process.env.LOG_GROUP_NAME || "/ecs/acme-payment-service"),
    metricNamespace: alarmData.metricNamespace || (tenantConfig ? tenantConfig.metricNamespace : (process.env.METRIC_NAMESPACE || "AcmeApp")),
    metricName: alarmData.metricName || "Payment5xxCount",
    metricDimensions: alarmData.metricDimensions || [],
    metricStatistic: alarmData.metricStatistic || "Sum",
    alarmName: alarmData.alarmName || tenantConfig?.alarmName,
    // Every source this app has configured+ready — CloudWatch is always one of
    // them (the alarm that triggered this is a CloudWatch alarm), Datadog or
    // future providers are added on top when connected. The agent picks which
    // to call, not this handler.
    observabilitySources: tenantConfig?.observabilitySources || [{ provider: "cloudwatch" }],
    github: tenantConfig?.github || null,
  };

  // Surfaced to the agent as one more fact in the incident summary (see
  // AgentLoop._incidentSummary) — not consumed by any tool directly.
  alarmData.knownDependencyName = tenantConfig?.infraResourceName || null;
  alarmData.knownDependencyArn = tenantConfig?.infraResourceArn || null;

  const llmClient = new LLMClient();
  const tools = buildTools(toolCtx);
  const agent = new AgentLoop({ llmClient, tools, log });
  const slackNotifier = new SlackNotifier(tenantConfig?.slack || {});

  if (alarmData.newState === "OK") {
    const incident = await findLatestIncident(tenantId, alarmData.alarmName);
    if (!incident?.slackThreadTs) {
      log.warn(`No Slack thread found for recovered alarm ${alarmData.alarmName}`);
      return response("recovery_unmatched", { slackPosted: false });
    }
    if (incident.state === "recovered") {
      log.warn(`Duplicate recovery delivery ignored: ${incident.sk}`);
      return response("duplicate_recovery_ignored", { slackPosted: true });
    }
    const recovery = await slackNotifier.postRecovery(alarmData, incident.slackThreadTs);
    if (recovery.success) {
      await updateIncident(tenantId, incident.sk, {
        state: "recovered",
        recoveredAt: alarmData.stateChangeTime || alarmData.timestamp || new Date().toISOString(),
      });
    }
    return response("recovery_processed", { slackPosted: recovery.success, error: recovery.error });
  }

  const incident = await createIncident(tenantId, alarmData);
  if (!incident.created) {
    log.warn(`Duplicate alarm delivery ignored: ${incident.sk}`);
    return response("duplicate_ignored", { slackPosted: Boolean(incident.item?.slackThreadTs) });
  }

  let initialAlert = await slackNotifier.postInitialAlert(alarmData);
  if (initialAlert.success) {
    await updateIncident(tenantId, incident.sk, {
      state: "investigating",
      slackChannelId: initialAlert.channel,
      slackThreadTs: initialAlert.messageTs,
    });
    log.ok(`Initial alert posted to Slack (thread: ${initialAlert.messageTs})`);
  } else {
    await updateIncident(tenantId, incident.sk, { state: "slack_alert_failed", error: initialAlert.error });
    log.error(`Initial Slack alert failed: ${initialAlert.error}`);
  }

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

  // Never create an orphan standalone report. Retry the parent alert once,
  // then post the report only when Slack has returned a thread timestamp.
  if (!initialAlert.success) {
    initialAlert = await slackNotifier.postInitialAlert(alarmData);
    if (initialAlert.success) {
      await updateIncident(tenantId, incident.sk, {
        state: "investigating",
        slackChannelId: initialAlert.channel,
        slackThreadTs: initialAlert.messageTs,
      });
    }
  }

  const slackResult = initialAlert.success
    ? await slackNotifier.postTriageBrief(triageResult, alarmData, {}, initialAlert.messageTs)
    : { success: false, error: `Could not create Slack parent alert: ${initialAlert.error}` };

  if (slackResult.success) {
    log.ok(`Triage brief posted to Slack (ts: ${slackResult.messageTs})`);
  } else {
    log.error(`Slack post failed: ${slackResult.error}`);
  }

  await updateIncident(tenantId, incident.sk, {
    state: slackResult.success ? "reported" : "report_failed",
    completedAt: new Date().toISOString(),
    confidence: triageResult.confidence,
    severity: triageResult.severity,
    reportMessageTs: slackResult.messageTs || "",
    // Full triage brief text — persisted alongside the Slack post so a UI can
    // display the real brief content without needing Slack API access.
    rootCause: triageResult.rootCause,
    timeline: triageResult.timeline,
    financialImpact: triageResult.financialImpact,
    remediation: triageResult.remediation,
    investigationPath: triageResult.investigationPath,
    ...(slackResult.error ? { error: slackResult.error } : {}),
  });

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

function response(status, details = {}) {
  return { statusCode: 200, body: JSON.stringify({ status, ...details }) };
}

// ─── SNS Event Parser ────────────────────────────────────────
// Tags expected on every aws_cloudwatch_metric_alarm resource:
//   Client      → human-readable tenant/org name  (e.g. "ShopCo")
//   Service     → logical service name            (e.g. "order-service")
//   Environment → deployment tier                 (e.g. "production", "staging")
// Any tag that is absent falls back to the value extracted from the SNS message
// structure or, finally, to a safe "unknown" placeholder so the rest of the
// pipeline never sees undefined.

async function parseAlarmEvent(event) {
  // ── SNS trigger (CloudWatch Alarm → SNS → Lambda) ──────────
  try {
    const snsRecord = event.Records?.[0]?.Sns;
    if (snsRecord) {
      const message = JSON.parse(snsRecord.Message);
      const alarmName = message.AlarmName || "unknown-alarm";
      // CloudWatch's Region field can be a display name; the Alarm ARN always
      // contains the SDK-compatible region code.
      const region = message.AlarmArn?.split(":")[3] || process.env.AWS_REGION || "us-east-1";

      // Alarm tags are the authoritative source of identity. Fetched once via
      // DescribeAlarms → ListTagsForResource. Falls back gracefully if the call
      // fails (no IAM permission, throttle, etc.).
      const tags = await fetchAlarmTags(alarmName, region);

      // Secondary fallback: some setups embed service info in Trigger.Dimensions
      // (e.g. { Name: "ServiceName", Value: "order-service" }).
      const dimensions = message.Trigger?.Dimensions || [];
      const dimService = dimensions.find((d) => /^service$/i.test(d.name))?.value;

      return {
        alarmName,
        description: message.AlarmDescription || message.NewStateReason || "",
        region,
        timestamp: snsRecord.Timestamp || new Date().toISOString(),
        stateChangeTime: message.StateChangeTime || null,
        oldState: message.OldStateValue || null,
        newState: message.NewStateValue || "ALARM",
        metricNamespace: message.Trigger?.Namespace || null,
        metricName: message.Trigger?.MetricName || null,
        metricStatistic: message.Trigger?.Statistic || message.Trigger?.ExtendedStatistic || "Sum",
        metricDimensions: (message.Trigger?.Dimensions || []).map((dimension) => ({
          Name: dimension.name || dimension.Name,
          Value: dimension.value || dimension.Value,
        })),
        client: tags.Client || tags.client || "unknown-client",
        service: tags.Service || tags.service || dimService || "unknown-service",
        environment: tags.Environment || tags.environment || "production",
      };
    }
  } catch (e) {
    // Not an SNS event — fall through to direct invocation parsing
  }

  // ── Direct invocation (local testing / manual Lambda invoke) ──
  // Caller may pass these fields explicitly; nothing is hardcoded.
  return {
    alarmName: event.alarmName || "unknown-alarm",
    description: event.description || "",
    region: event.region || process.env.AWS_REGION || "us-east-1",
    timestamp: event.timestamp || new Date().toISOString(),
    stateChangeTime: event.stateChangeTime || null,
    oldState: event.oldState || null,
    newState: event.newState || "ALARM",
    client: event.client || process.env.DEFAULT_CLIENT || "unknown-client",
    service: event.service || process.env.DEFAULT_SERVICE || "unknown-service",
    environment: event.environment || process.env.DEFAULT_ENVIRONMENT || "production",
    metricNamespace: event.metricNamespace || null,
    metricName: event.metricName || null,
    metricStatistic: event.metricStatistic || "Sum",
    metricDimensions: event.metricDimensions || [],
  };
}
