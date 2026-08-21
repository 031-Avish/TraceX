const test = require("node:test");
const assert = require("node:assert/strict");
const { DatadogCollector } = require("../src/collectors/datadog");

test("Datadog log adapter scopes and normalizes error logs", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ data: [{ attributes: { timestamp: "2026-08-21T10:00:00Z", message: "boom", service: "payments", status: "error", attributes: { trace_id: "123" } } }] }) };
  };

  const collector = new DatadogCollector({ apiKey: "api", appKey: "app", site: "eu1", service: "payments", environment: "prod" });
  const result = await collector.getRecentErrorLogs(10);

  assert.equal(request.url, "https://api.datadoghq.eu/api/v2/logs/events/search");
  assert.equal(request.options.headers["DD-API-KEY"], "api");
  assert.match(JSON.parse(request.options.body).filter.query, /service:payments env:prod/);
  assert.deepEqual(result.events[0], { timestamp: "2026-08-21T10:00:00Z", message: "boom", service: "payments", status: "error", attributes: { trace_id: "123" } });
});

test("Datadog metric adapter requires an application query", async () => {
  const collector = new DatadogCollector({ apiKey: "api", appKey: "app" });
  const result = await collector.getServiceMetrics();
  assert.equal(result.success, false);
  assert.match(result.error, /metric query/);
});
