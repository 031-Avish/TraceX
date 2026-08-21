// Datadog observability adapter. It normalizes Datadog responses into the
// same shapes consumed by the agent's provider-independent tools.

const SITE_HOSTS = {
  us1: "api.datadoghq.com",
  us3: "api.us3.datadoghq.com",
  us5: "api.us5.datadoghq.com",
  eu1: "api.datadoghq.eu",
  ap1: "api.ap1.datadoghq.com",
  ap2: "api.ap2.datadoghq.com",
  us1_fed: "api.ddog-gov.com",
};

class DatadogCollector {
  constructor(config = {}) {
    this.apiKey = config.apiKey || config.token;
    this.appKey = config.appKey;
    this.site = config.site || "us1";
    this.host = SITE_HOSTS[this.site] || SITE_HOSTS.us1;
    this.service = config.service;
    this.environment = config.environment;
    this.errorQuery = config.errorQuery;
    this.deploymentQuery = config.deploymentQuery;
    this.metricQuery = config.metricQuery;
    this.monitorId = config.monitorId;
  }

  async getRecentErrorLogs(windowMinutes = 15) {
    const query = this.errorQuery || this._scopedQuery("status:(error OR critical OR emergency)");
    const data = await this._request("POST", "/api/v2/logs/events/search", {
      filter: { from: `now-${windowMinutes}m`, to: "now", query },
      sort: "-timestamp",
      page: { limit: 50 },
    });
    const events = (data.data || []).map((item) => ({
      timestamp: item.attributes?.timestamp,
      message: item.attributes?.message,
      service: item.attributes?.service,
      status: item.attributes?.status,
      attributes: item.attributes?.attributes,
    }));
    return { success: true, count: events.length, events, provider: "datadog", query };
  }

  async getDeploymentLogs(windowMinutes = 30) {
    const query = this.deploymentQuery || this._scopedQuery("(deployment OR deploy OR release)");
    const data = await this._request("POST", "/api/v2/logs/events/search", {
      filter: { from: `now-${windowMinutes}m`, to: "now", query },
      sort: "-timestamp",
      page: { limit: 20 },
    });
    const events = (data.data || []).map((item) => ({
      timestamp: item.attributes?.timestamp,
      message: item.attributes?.message,
      attributes: item.attributes?.attributes,
    }));
    return { success: true, count: events.length, events, provider: "datadog", query };
  }

  async getServiceMetrics(windowMinutes = 30) {
    if (!this.metricQuery) {
      return { success: false, metrics: [], error: "No Datadog metric query is mapped to this application" };
    }
    const to = Math.floor(Date.now() / 1000);
    const from = to - windowMinutes * 60;
    const data = await this._request("GET", `/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(this.metricQuery)}`);
    const metrics = (data.series || []).map((series) => ({
      id: series.metric,
      label: series.display_name || series.expression || series.metric,
      datapoints: (series.pointlist || []).map(([timestamp, value]) => ({
        timestamp: new Date(timestamp).toISOString(),
        value,
      })),
      scope: series.scope,
    }));
    return { success: true, count: metrics.length, metrics, provider: "datadog" };
  }

  async getAlarmDetails() {
    if (!this.monitorId) {
      return { success: false, alarm: null, error: "No Datadog monitor ID is mapped to this application" };
    }
    const monitor = await this._request("GET", `/api/v1/monitor/${encodeURIComponent(this.monitorId)}`);
    return {
      success: true,
      provider: "datadog",
      alarm: {
        id: monitor.id,
        name: monitor.name,
        state: monitor.overall_state,
        message: monitor.message,
        query: monitor.query,
        type: monitor.type,
        modified: monitor.modified,
      },
    };
  }

  _scopedQuery(base) {
    return [this.service && `service:${this.service}`, this.environment && `env:${this.environment}`, base]
      .filter(Boolean)
      .join(" ");
  }

  async _request(method, path, body) {
    const response = await fetch(`https://${this.host}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "DD-API-KEY": this.apiKey,
        "DD-APPLICATION-KEY": this.appKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Datadog ${response.status}: ${detail || response.statusText}`);
    }
    return response.json();
  }
}

module.exports = { DatadogCollector, SITE_HOSTS };
