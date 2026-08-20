// src/handler.js
// ═══════════════════════════════════════════════════════════════
//  PRESIDIO SRE TRIAGE AGENT — Lambda Orchestrator
//  Trigger: SNS event from CloudWatch Alarm
//  Flow: Alarm → Collect Data (parallel) → LLM Analysis → Slack Brief
// ═══════════════════════════════════════════════════════════════

// Load env vars when running locally (Lambda env vars are set by serverless)
try { require("dotenv").config(); } catch {}

const { CloudWatchLogsCollector } = require("./collectors/cloudwatch-logs");
const { CloudWatchMetricsCollector } = require("./collectors/cloudwatch-metrics");
const { GitHubCommitsCollector } = require("./collectors/github-commits");
const { TriageEngine } = require("./engine/triage-engine");
const { SlackNotifier } = require("./slack/slack-notifier");
const { Logger } = require("./utils/logger");

module.exports.main = async (event) => {
  const log = new Logger("TRIAGE");

  log.banner("PRESIDIO SRE TRIAGE AGENT — ACTIVATED");

  // ── Parse the incoming alarm event ──
  const alarmData = parseAlarmEvent(event);
  log.info(`Alarm: ${alarmData.alarmName}`);
  log.info(`Client: ${alarmData.client} | Service: ${alarmData.service} | Env: ${alarmData.environment}`);

  // ── Initialize all modules ──
  const logCollector = new CloudWatchLogsCollector();
  const metricCollector = new CloudWatchMetricsCollector();
  const gitCollector = new GitHubCommitsCollector();
  const triageEngine = new TriageEngine();
  const slackNotifier = new SlackNotifier();

  const logGroupName = process.env.LOG_GROUP_NAME || "/ecs/acme-payment-service";
  const metricNamespace = process.env.METRIC_NAMESPACE || "AcmeApp";

  // ═══════════════════════════════════════════
  //  STEP 1: Parallel Data Collection
  // ═══════════════════════════════════════════
  log.step(1, "COLLECTING OBSERVABILITY DATA (parallel)");
  const collectionTimer = log.timer("Data collection");

  const [errorLogs, deployLogs, allLogs, metrics, alarmDetails, commits] = await Promise.all([
    logCollector.getRecentErrorLogs(logGroupName, 15),
    logCollector.getDeploymentLogs(logGroupName, 30),
    logCollector.getAllRecentLogs(logGroupName, 15),
    metricCollector.getServiceMetrics(metricNamespace, 30),
    metricCollector.getAlarmDetails(alarmData.alarmName),
    gitCollector.getRecentCommits(10),
  ]);

  const collectionSec = collectionTimer.stop();

  // Log collection results
  log.info(`Error logs: ${errorLogs.count} events ${errorLogs.success ? "✓" : "✗ " + errorLogs.error}`);
  log.info(`Deploy logs: ${deployLogs.count} events ${deployLogs.success ? "✓" : "✗ " + deployLogs.error}`);
  log.info(`All logs: ${allLogs.count} events ${allLogs.success ? "✓" : "✗ " + allLogs.error}`);
  log.info(`Metrics: ${metrics.count} series ${metrics.success ? "✓" : "✗ " + metrics.error}`);
  log.info(`Alarm details: ${alarmDetails.success ? "✓" : "✗ " + alarmDetails.error}`);
  log.info(`Git commits: ${commits.count} commits ${commits.success ? "✓" : "✗ " + commits.error}`);

  // Merge and sort all log data chronologically
  const mergedLogs = [
    ...(deployLogs.events || []),
    ...(errorLogs.events || []),
    ...(allLogs.events || []),
  ]
    // Deduplicate by timestamp + message hash
    .filter((event, index, self) =>
      index === self.findIndex(e =>
        e.timestamp === event.timestamp &&
        JSON.stringify(e.message) === JSON.stringify(event.message)
      )
    )
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  log.info(`Merged & deduplicated: ${mergedLogs.length} total log events for analysis`);

  // Enrich alarm data with details
  alarmData.alarmDetails = alarmDetails.alarm || null;

  // ═══════════════════════════════════════════
  //  STEP 2: LLM Root Cause Analysis
  // ═══════════════════════════════════════════
  log.step(2, "LLM ROOT CAUSE ANALYSIS (Claude)");
  const analysisTimer = log.timer("LLM analysis");

  const triageResult = await triageEngine.analyze({
    logs: { events: mergedLogs, totalCount: mergedLogs.length },
    metrics,
    commits,
    alarmData,
  });

  analysisTimer.stop();

  log.info(`Confidence: ${triageResult.confidence}%`);
  log.info(`Severity: ${triageResult.severity}`);
  log.info(`Token usage: ${triageResult.tokenUsage?.input || 0} in / ${triageResult.tokenUsage?.output || 0} out`);
  log.info(`Inference cost: ${triageResult.estimatedCost}`);

  // ═══════════════════════════════════════════
  //  STEP 3: Post Triage Brief to Slack
  // ═══════════════════════════════════════════
  log.step(3, "POSTING INCIDENT TRIAGE BRIEF TO SLACK");

  const slackResult = await slackNotifier.postTriageBrief(
    triageResult,
    alarmData,
    { collectionSec: collectionSec.toFixed(1) }
  );

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
