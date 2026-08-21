export const CONNECTOR_CATALOG = [
  { type: "github", name: "GitHub", icon: "◉", category: "Code", available: true, description: "Correlate incidents with commits and inspect code diffs.", fields: [
    { key: "token", label: "Personal access token", type: "password", placeholder: "ghp_...", secret: true },
    { key: "owner", label: "Default repository owner", placeholder: "your-org" },
    { key: "repo", label: "Default repository name", placeholder: "payment-service" },
  ] },
  { type: "slack", name: "Slack", icon: "#", category: "Notifications", available: true, description: "Deliver structured incident briefs to your response channel.", fields: [
    { key: "token", label: "Bot token", type: "password", placeholder: "xoxb-...", secret: true },
    { key: "channelId", label: "Default channel ID", placeholder: "C0XXXXXXXXX" },
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
];

export function blankConfig(definition) {
  return Object.fromEntries((definition.fields || []).map((field) => [field.key, field.defaultValue || ""]));
}
