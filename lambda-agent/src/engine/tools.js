// src/engine/tools.js
// Wraps the observability collectors as tools the agent can choose to call.
// The agent decides WHICH of these to use and WHEN it has enough evidence —
// this file only defines what's available and how to execute each one.
//
// The tool list is built dynamically per tenant/app. Every observability
// source the app has configured+ready (CloudWatch always, plus Datadog or any
// future provider when connected) gets its own provider-suffixed tool variant
// — e.g. get_error_logs_cloudwatch and get_error_logs_datadog can both be
// offered at once. The agent picks which source(s) to call per incident,
// including calling more than one for corroboration; nothing upstream forces
// a single provider choice. Adding a new provider means adding one entry to
// PROVIDER_ADAPTERS below — the schema/executor generation is generic.
// GitHub tools are only offered when this tenant actually has GitHub
// credentials configured — via the connector registry, or the env var
// fallback. A tenant that hasn't connected GitHub simply never sees
// get_recent_commits/get_commit_diff as an option, instead of the agent
// "choosing" them and burning a turn on a guaranteed failure.

const { CloudWatchLogsCollector } = require("../collectors/cloudwatch-logs");
const { CloudWatchMetricsCollector } = require("../collectors/cloudwatch-metrics");
const { GitHubCommitsCollector } = require("../collectors/github-commits");
const { DatadogCollector } = require("../collectors/datadog");

// Maps a source's `provider` to an adapter exposing the 4 observability
// operations in a common shape. `ctx` is the same per-incident scope object
// buildTools receives; `source` is that provider's own entry from
// ctx.observabilitySources (credentials/queries specific to it).
const PROVIDER_ADAPTERS = {
  cloudwatch: (ctx) => {
    const logs = new CloudWatchLogsCollector(ctx.awsRegion);
    const metrics = new CloudWatchMetricsCollector(ctx.awsRegion);
    return {
      label: "CloudWatch",
      getRecentErrorLogs: (windowMinutes) => logs.getRecentErrorLogs(ctx.logGroupName, windowMinutes),
      getDeploymentLogs: (windowMinutes) => logs.getDeploymentLogs(ctx.logGroupName, windowMinutes),
      getServiceMetrics: (windowMinutes) =>
        metrics.getServiceMetrics({
          namespace: ctx.metricNamespace,
          metricName: ctx.metricName,
          dimensions: ctx.metricDimensions,
          statistic: ctx.metricStatistic,
          windowMinutes,
        }),
      getAlarmDetails: () => metrics.getAlarmDetails(ctx.alarmName),
    };
  },
  datadog: (ctx, source) => {
    const dd = new DatadogCollector(source);
    return {
      label: "Datadog",
      getRecentErrorLogs: (windowMinutes) => dd.getRecentErrorLogs(windowMinutes),
      getDeploymentLogs: (windowMinutes) => dd.getDeploymentLogs(windowMinutes),
      getServiceMetrics: (windowMinutes) => dd.getServiceMetrics(windowMinutes),
      getAlarmDetails: () => dd.getAlarmDetails(),
    };
  },
};

// One entry per observability operation: the stable name suffix, default
// time-window param (null = no window param, e.g. alarm details), and a
// description template — {provider} is filled in per source.
const OBSERVABILITY_OPS = [
  {
    suffix: "error_logs",
    defaultWindow: 15,
    description: "Fetch recent ERROR/FATAL/5xx log entries for the affected service from {provider}. Use this first for any error-rate or exception-based incident.",
    call: (adapter, windowMinutes) => adapter.getRecentErrorLogs(windowMinutes),
  },
  {
    suffix: "deployment_logs",
    defaultWindow: 30,
    description: "Fetch recent deployment/release events for the affected service from {provider}. Use this to check whether a deploy happened shortly before the incident started.",
    call: (adapter, windowMinutes) => adapter.getDeploymentLogs(windowMinutes),
  },
  {
    suffix: "service_metrics",
    defaultWindow: 30,
    description: "Fetch {provider}'s metric time series for the affected service. Use this to see how the error rate trended over time, not just individual log lines.",
    call: (adapter, windowMinutes) => adapter.getServiceMetrics(windowMinutes),
  },
  {
    suffix: "alarm_details",
    defaultWindow: null,
    description: "Fetch {provider}'s alert or monitor details for the affected service, including current state and query/threshold context.",
    call: (adapter) => adapter.getAlarmDetails(),
  },
];

/**
 * Build the tool list + executor map for one incident's investigation.
 * `ctx` binds the tenant-specific scope (log group, namespace, alarm name) so the
 * model can tune parameters like time windows, but can't be tricked into asking
 * for a different tenant's log group.
 */
function buildTools(ctx) {
  const sources = ctx.observabilitySources?.length ? ctx.observabilitySources : [{ provider: "cloudwatch" }];
  const githubAvailable = Boolean(ctx.github?.token || process.env.GITHUB_TOKEN);
  const github = githubAvailable ? new GitHubCommitsCollector(ctx.github || undefined) : null;

  const observabilitySchemas = [];
  const observabilityExecutors = {};

  for (const source of sources) {
    const buildAdapter = PROVIDER_ADAPTERS[source.provider];
    if (!buildAdapter) continue; // unknown/unimplemented provider — skip rather than offer a tool that can't execute
    const adapter = buildAdapter(ctx, source);
    const suffix = source.provider;

    for (const op of OBSERVABILITY_OPS) {
      const name = `get_${op.suffix}_${suffix}`;
      observabilitySchemas.push({
        type: "function",
        function: {
          name,
          description: op.description.replace("{provider}", adapter.label),
          parameters: {
            type: "object",
            properties:
              op.defaultWindow === null
                ? {}
                : {
                    windowMinutes: {
                      type: "integer",
                      description: `How far back to look, in minutes. Default ${op.defaultWindow}.`,
                    },
                  },
          },
        },
      });
      observabilityExecutors[name] = (args) =>
        op.call(adapter, op.defaultWindow === null ? undefined : args.windowMinutes || op.defaultWindow);
    }
  }

  const allSchemas = [
    ...observabilitySchemas,
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
    ...observabilityExecutors,
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
