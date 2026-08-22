export const CONNECTOR_CATALOG = [
  // ── Observability ───────────────────────────────────────────────────────────
  // CloudWatch uses the Lambda's IAM role — no credentials to store. The region
  // field is informational and matches what was set at deploy time.
  { type: "cloudwatch", name: "AWS CloudWatch", icon: "☁", category: "Observability", available: true, description: "Logs, metrics, and alarms via IAM role assumption — TraceX never sees long-lived AWS credentials. In this demo, TraceX and the monitored account are the same account, so the agent's own execution role is used directly; a real deployment has the customer create a role in their own account that trusts TraceX's account ID, scoped by an external ID.", fields: [
    { key: "region", label: "AWS region", placeholder: "us-east-1" },
    { key: "roleArn", label: "IAM role ARN (production cross-account path)", placeholder: "arn:aws:iam::<customer-account-id>:role/TraceXReadOnly" },
    { key: "externalId", label: "External ID", type: "password", placeholder: "shared secret set on the trust policy", secret: true },
  ] },
  { type: "datadog", name: "Datadog", icon: "D", category: "Observability", available: true, description: "Investigate Datadog logs, metrics, and monitors through one scoped connection.", fields: [
    { key: "site", label: "Datadog site", type: "select", defaultValue: "us1", options: [["us1", "US1"], ["us3", "US3"], ["us5", "US5"], ["eu1", "EU1"], ["ap1", "AP1"], ["ap2", "AP2"], ["us1_fed", "US1-FED"]] },
    { key: "apiKey", label: "API key", type: "password", secret: true },
    { key: "appKey", label: "Application key", type: "password", secret: true },
  ] },
  { type: "grafana", name: "Grafana", icon: "G", category: "Observability", description: "Loki logs and Prometheus metrics.", available: false },
  { type: "newrelic", name: "New Relic", icon: "N", category: "Observability", description: "NRQL logs, telemetry, and alerts.", available: false },
  { type: "elastic", name: "Elastic", icon: "E", category: "Observability", description: "Elasticsearch logs and APM data.", available: false },
  { type: "splunk", name: "Splunk", icon: "S", category: "Observability", description: "Search and correlate Splunk events.", available: false },
  { type: "azure-monitor", name: "Azure Monitor", icon: "A", category: "Observability", description: "Azure logs, metrics, and alerts.", available: false },
  // ── Code ────────────────────────────────────────────────────────────────────
  { type: "github", name: "GitHub", icon: "◉", category: "Code", available: true, description: "Correlate incidents with commits and inspect code diffs.", fields: [
    { key: "token", label: "Personal access token", type: "password", placeholder: "ghp_...", secret: true },
    { key: "owner", label: "Default repository owner", placeholder: "your-org" },
    { key: "repo", label: "Default repository name", placeholder: "payment-service" },
  ] },
  // ── Notifications ───────────────────────────────────────────────────────────
  { type: "slack", name: "Slack", icon: "#", category: "Notifications", available: true, description: "Deliver structured incident briefs to your response channel.", fields: [
    { key: "token", label: "Bot token", type: "password", placeholder: "xoxb-...", secret: true },
    { key: "channelId", label: "Default channel ID", placeholder: "C0XXXXXXXXX" },
  ] },
];

export function blankConfig(definition) {
  return Object.fromEntries((definition.fields || []).map((field) => [field.key, field.defaultValue || ""]));
}
