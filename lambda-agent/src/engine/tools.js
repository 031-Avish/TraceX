// src/engine/tools.js
// Wraps the observability collectors as tools the agent can choose to call.
// The agent decides WHICH of these to use and WHEN it has enough evidence —
// this file only defines what's available and how to execute each one.
//
// The tool list is built dynamically per tenant/app. Observability tools keep
// stable names while their executors route to CloudWatch, Datadog, or a future
// provider adapter. GitHub tools are only offered when this
// tenant actually has GitHub credentials configured — via the connector
// registry, or the env var fallback. A tenant that hasn't connected GitHub
// simply never sees get_recent_commits/get_commit_diff as an option, instead
// of the agent "choosing" them and burning a turn on a guaranteed failure.

const { CloudWatchLogsCollector } = require("../collectors/cloudwatch-logs");
const { CloudWatchMetricsCollector } = require("../collectors/cloudwatch-metrics");
const { GitHubCommitsCollector } = require("../collectors/github-commits");
const { DatadogCollector } = require("../collectors/datadog");

/**
 * Build the tool list + executor map for one incident's investigation.
 * `ctx` binds the tenant-specific scope (log group, namespace, alarm name) so the
 * model can tune parameters like time windows, but can't be tricked into asking
 * for a different tenant's log group.
 */
function buildTools(ctx) {
  const logs = new CloudWatchLogsCollector(ctx.awsRegion);
  const metrics = new CloudWatchMetricsCollector(ctx.awsRegion);
  const provider = ctx.observability?.provider || "cloudwatch";
  const datadog = provider === "datadog" ? new DatadogCollector(ctx.observability) : null;
  const unavailable = provider === "unavailable" ? ctx.observability.error : null;
  const githubAvailable = Boolean(ctx.github?.token || process.env.GITHUB_TOKEN);
  const github = githubAvailable ? new GitHubCommitsCollector(ctx.github || undefined) : null;

  const allSchemas = [
    {
      type: "function",
      function: {
        name: "get_error_logs",
        description:
          "Fetch recent ERROR/FATAL/5xx log entries for the affected service. Use this first for any error-rate or exception-based incident.",
        parameters: {
          type: "object",
          properties: {
            windowMinutes: {
              type: "integer",
              description: "How far back to look, in minutes. Default 15.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_deployment_logs",
        description:
          "Fetch recent deployment/release events for the affected service. Use this to check whether a deploy happened shortly before the incident started.",
        parameters: {
          type: "object",
          properties: {
            windowMinutes: {
              type: "integer",
              description: "How far back to look, in minutes. Default 30.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_service_metrics",
        description:
          "Fetch the configured observability provider's metric time series for the affected service. Use this to see how the error rate trended over time, not just individual log lines.",
        parameters: {
          type: "object",
          properties: {
            windowMinutes: {
              type: "integer",
              description: "How far back to look, in minutes. Default 30.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_alarm_details",
        description:
          "Fetch the configured observability provider's alert or monitor details, including current state and query/threshold context.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_recent_commits",
        description:
          "Fetch recent Git commits to the affected service's repository. Use this when logs or deployment events suggest a code change caused the incident.",
        parameters: {
          type: "object",
          properties: {
            count: {
              type: "integer",
              description: "Number of recent commits to fetch. Default 10.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_commit_diff",
        description:
          "Fetch the file-level diff for one specific commit SHA. Use this once you suspect a particular commit (e.g. from a stack trace or deployment log) — pulls the actual code change, not just the message.",
        parameters: {
          type: "object",
          properties: {
            sha: { type: "string", description: "The commit SHA (short or full) to inspect." },
          },
          required: ["sha"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_triage_brief",
        description:
          "Finalize the investigation and submit the structured incident triage brief. Call this once — and only once — you have enough evidence to state a root cause. Do not call any other tool after this.",
        parameters: {
          type: "object",
          properties: {
            rootCause: {
              type: "string",
              description: "2-3 sentence technical root cause, citing specific evidence (commit SHA, file/line, log entry).",
            },
            timeline: {
              type: "string",
              description: "Chronological bullet list, e.g. '• T-12 min: deploy started\\n• T-8 min: first 500s appear'",
            },
            financialImpact: {
              type: "string",
              description: "Bullet list quantifying business/cost impact (failed transactions, revenue rate, infra burn).",
            },
            remediation: {
              type: "string",
              description: "Exact CLI/Terraform command to fix it, plus a one-line explanation of why it works.",
            },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            severity: { type: "string", enum: ["P1", "P2", "P3"] },
          },
          required: ["rootCause", "timeline", "financialImpact", "remediation", "confidence", "severity"],
        },
      },
    },
  ];

  // GitHub tools require a configured token — don't offer them (and don't
  // register an executor for them) when this tenant hasn't connected GitHub.
  const GITHUB_TOOL_NAMES = new Set(["get_recent_commits", "get_commit_diff"]);
  const schemas = allSchemas.filter((s) => githubAvailable || !GITHUB_TOOL_NAMES.has(s.function.name));

  const executors = {
    get_error_logs: (args) => unavailable ? Promise.resolve({ success: false, error: unavailable }) : datadog
      ? datadog.getRecentErrorLogs(args.windowMinutes || 15)
      : logs.getRecentErrorLogs(ctx.logGroupName, args.windowMinutes || 15),
    get_deployment_logs: (args) => unavailable ? Promise.resolve({ success: false, error: unavailable }) : datadog
      ? datadog.getDeploymentLogs(args.windowMinutes || 30)
      : logs.getDeploymentLogs(ctx.logGroupName, args.windowMinutes || 30),
    get_service_metrics: (args) => unavailable ? Promise.resolve({ success: false, error: unavailable }) : datadog
      ? datadog.getServiceMetrics(args.windowMinutes || 30)
      : metrics.getServiceMetrics({
          namespace: ctx.metricNamespace,
          metricName: ctx.metricName,
          dimensions: ctx.metricDimensions,
          statistic: ctx.metricStatistic,
          windowMinutes: args.windowMinutes || 30,
        }),
    get_alarm_details: () => unavailable ? Promise.resolve({ success: false, error: unavailable }) : datadog
      ? datadog.getAlarmDetails()
      : metrics.getAlarmDetails(ctx.alarmName),
    ...(githubAvailable
      ? {
          get_recent_commits: (args) => github.getRecentCommits(args.count || 10),
          get_commit_diff: (args) => github.getCommitDiff(args.sha),
        }
      : {}),
  };

  return { schemas, executors };
}

module.exports = { buildTools };
