import React, { useCallback, useEffect, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listApplications, saveApplication, deleteApplication } from "../api.js";

const EMPTY_FORM = {
  appId: "",
  alarmName: "",
  logGroupName: "",
  metricNamespace: "",
  githubRepoOwner: "",
  githubRepoName: "",
  slackChannelId: "",
  observabilityProvider: "cloudwatch",
  serviceName: "",
  environment: "production",
  errorQuery: "",
  deploymentQuery: "",
  metricQuery: "",
  monitorId: "",
};

export default function ApplicationsPage() {
  const { apiUrl, tenantId } = useConfig();
  const showToast = useToast();
  const [applications, setApplications] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null); // null = adding a new application
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!apiUrl) return;
    listApplications(apiUrl, tenantId)
      .then(({ applications }) => setApplications(applications))
      .catch((e) => showToast(e.message, "error"));
  }, [apiUrl, tenantId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (app) => {
    setEditingId(app.appId);
    setForm({ ...EMPTY_FORM, ...app.config, appId: app.appId });
  };

  const startNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const save = async (e) => {
    e.preventDefault();
    if (!form.appId.trim()) {
      showToast("App ID is required", "error");
      return;
    }
    const { appId, ...config } = form;
    try {
      setLoading(true);
      await saveApplication(apiUrl, tenantId, appId.trim(), config);
      showToast(editingId ? "Application updated" : "Application added", "ok");
      startNew();
      load();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const remove = async (appId) => {
    try {
      await deleteApplication(apiUrl, tenantId, appId);
      showToast("Removed", "ok");
      if (editingId === appId) startNew();
      load();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  if (!apiUrl) return <div className="panel">Set the Config API URL in Settings first.</div>;

  return (
    <div>
      <h2 className="section-title">Applications</h2>
      <p className="hint">
        Map each application to its observability provider and a tightly scoped set of logs, metrics,
        alerts, repository, and notification destinations.
      </p>

      <div className="apps-list">
        {applications.length === 0 && <p className="hint">No applications configured yet — add one below.</p>}
        {applications.map((app) => (
          <div className={`app-item ${editingId === app.appId ? "editing" : ""}`} key={app.appId}>
            <div>
              <div className="app-id">{app.appId}</div>
              <div className="meta">
                {app.config.observabilityProvider || "cloudwatch"} · {app.config.serviceName || app.config.logGroupName || "—"} · alert: {app.config.monitorId || app.config.alarmName || "—"}
              </div>
            </div>
            <div className="app-actions">
              <button className="secondary" onClick={() => startEdit(app)}>
                Edit
              </button>
              <button className="danger" onClick={() => remove(app.appId)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <form className="app-form" onSubmit={save}>
        <h3 className="full form-title">{editingId ? `Editing "${editingId}"` : "Add application"}</h3>

        <div className="field">
          <label>App ID (matches alarm's service name)</label>
          <input
            value={form.appId}
            onChange={(e) => updateField("appId", e.target.value)}
            placeholder="payment-service"
            disabled={!!editingId}
          />
        </div>
        <div className="field">
          <label>Observability provider</label>
          <select value={form.observabilityProvider} onChange={(e) => updateField("observabilityProvider", e.target.value)}>
            <option value="cloudwatch">AWS CloudWatch</option>
            <option value="datadog">Datadog</option>
          </select>
        </div>
        <div className="field">
          <label>Environment</label>
          <input value={form.environment} onChange={(e) => updateField("environment", e.target.value)} placeholder="production" />
        </div>
        {form.observabilityProvider === "cloudwatch" ? <>
        <div className="field">
          <label>Alarm name</label>
          <input
            value={form.alarmName}
            onChange={(e) => updateField("alarmName", e.target.value)}
            placeholder="acme-payment-5xx-critical"
          />
        </div>
        <div className="field">
          <label>CloudWatch log group</label>
          <input
            value={form.logGroupName}
            onChange={(e) => updateField("logGroupName", e.target.value)}
            placeholder="/ecs/acme-payment-service"
          />
        </div>
        <div className="field">
          <label>Metric namespace</label>
          <input value={form.metricNamespace} onChange={(e) => updateField("metricNamespace", e.target.value)} placeholder="AcmeApp" />
        </div>
        </> : <>
        <div className="field">
          <label>Datadog service tag</label>
          <input value={form.serviceName} onChange={(e) => updateField("serviceName", e.target.value)} placeholder={form.appId || "payment-service"} />
        </div>
        <div className="field">
          <label>Monitor ID</label>
          <input value={form.monitorId} onChange={(e) => updateField("monitorId", e.target.value)} placeholder="12345678" />
        </div>
        <div className="field full">
          <label>Metric query</label>
          <input value={form.metricQuery} onChange={(e) => updateField("metricQuery", e.target.value)} placeholder="sum:trace.http.request.errors{service:payment-service}.as_count()" />
        </div>
        <div className="field full">
          <label>Error log query (optional override)</label>
          <input value={form.errorQuery} onChange={(e) => updateField("errorQuery", e.target.value)} placeholder="service:payment-service env:production status:error" />
        </div>
        <div className="field full">
          <label>Deployment log query (optional override)</label>
          <input value={form.deploymentQuery} onChange={(e) => updateField("deploymentQuery", e.target.value)} placeholder="service:payment-service env:production deployment" />
        </div>
        </>}
        <div className="field">
          <label>GitHub repo owner (override)</label>
          <input
            value={form.githubRepoOwner}
            onChange={(e) => updateField("githubRepoOwner", e.target.value)}
            placeholder="optional — uses connector default"
          />
        </div>
        <div className="field">
          <label>GitHub repo name (override)</label>
          <input
            value={form.githubRepoName}
            onChange={(e) => updateField("githubRepoName", e.target.value)}
            placeholder="optional — uses connector default"
          />
        </div>
        <div className="field full">
          <label>Slack channel ID (override)</label>
          <input
            value={form.slackChannelId}
            onChange={(e) => updateField("slackChannelId", e.target.value)}
            placeholder="optional — uses connector default"
          />
        </div>
        <div className="actions">
          <button type="submit" disabled={loading}>
            {editingId ? "Save changes" : "Add application"}
          </button>
          {editingId && (
            <button type="button" className="secondary" onClick={startNew}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
