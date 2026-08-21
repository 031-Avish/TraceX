import React, { useCallback, useEffect, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import { listApplications, saveApplication, deleteApplication } from "../api.js";

const EMPTY_FORM = {
  appId: "",
  environment: "production",
  // CloudWatch scope — which log group / alarm / namespace belongs to this target
  alarmName: "",
  logGroupName: "",
  metricNamespace: "",
  // Datadog scope — optional; only used when the Datadog connector is active
  serviceName: "",
  monitorId: "",
  metricQuery: "",
  errorQuery: "",
  deploymentQuery: "",
  // Per-target connector overrides (fall back to the connector's default when blank)
  githubRepoOwner: "",
  githubRepoName: "",
  slackChannelId: "",
};

export default function ApplicationsPage() {
  const { apiUrl, tenantId } = useConfig();
  const showToast = useToast();
  const confirm = useConfirm();

  const [applications, setApplications] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null); // null = adding a new one
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!apiUrl) return;
    listApplications(apiUrl, tenantId)
      .then(({ applications }) => setApplications(applications))
      .catch((e) => showToast(e.message, "error"))
      .finally(() => setLoaded(true));
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
      showToast("An identifier is required", "error");
      return;
    }
    const { appId, ...config } = form;
    try {
      setLoading(true);
      await saveApplication(apiUrl, tenantId, appId.trim(), config);
      showToast(editingId ? "Updated" : "Added", "ok");
      startNew();
      load();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const remove = async (appId) => {
    const ok = await confirm(`Remove "${appId}"? The agent will stop investigating incidents for it.`, {
      title: "Remove application",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
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
      <div className="page-heading">
        <div>
          <h1>Applications</h1>
          <p>
            What the agent investigates today — a service scoped to CloudWatch or Datadog. Infrastructure-level
            targets (Grafana/Loki, clusters, hosts) are on the way as a peer to this, not a replacement for it.
          </p>
        </div>
        <span className="connection-count">{applications.length} configured</span>
      </div>

      {!loaded ? (
        <div className="apps-list">
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </div>
      ) : (
        <div className="apps-list">
          {applications.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">▤</div>
              No applications configured yet — add one below to give the agent something to investigate.
            </div>
          )}
          {applications.map((app) => (
            <div className={`app-item ${editingId === app.appId ? "editing" : ""}`} key={app.appId}>
              <div>
                <div className="app-id">
                  {app.appId}
                  {app.config.environment && <span className="env-tag">{app.config.environment}</span>}
                </div>
                <div className="meta">
                  {app.config.logGroupName || app.config.serviceName || "—"} · alarm:{" "}
                  {app.config.alarmName || app.config.monitorId || "—"}
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
      )}

      <form className="app-form" onSubmit={save}>
        <h3 className="full form-title">{editingId ? `Editing "${editingId}"` : "Add application"}</h3>

        {/* ── Identity ──────────────────────────────────────────────────── */}
        <div className="field">
          <label>Identifier (matches the alarm's service name)</label>
          <input
            value={form.appId}
            onChange={(e) => updateField("appId", e.target.value)}
            placeholder="payment-service"
            disabled={!!editingId}
          />
        </div>
        <div className="field">
          <label>Environment</label>
          <input value={form.environment} onChange={(e) => updateField("environment", e.target.value)} placeholder="production" />
        </div>

        {/* ── CloudWatch scope ──────────────────────────────────────────── */}
        <div className="field-group-label full">CloudWatch scope</div>
        <div className="field">
          <label>Alarm name</label>
          <input
            value={form.alarmName}
            onChange={(e) => updateField("alarmName", e.target.value)}
            placeholder="acme-payment-5xx-critical"
          />
        </div>
        <div className="field">
          <label>Log group</label>
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

        {/* ── Datadog scope (optional) ──────────────────────────────────── */}
        <div className="field-group-label full">
          Datadog scope <span className="hint-inline">(optional — requires Datadog connector)</span>
        </div>
        <div className="field">
          <label>Service tag</label>
          <input value={form.serviceName} onChange={(e) => updateField("serviceName", e.target.value)} placeholder={form.appId || "payment-service"} />
        </div>
        <div className="field">
          <label>Monitor ID</label>
          <input value={form.monitorId} onChange={(e) => updateField("monitorId", e.target.value)} placeholder="12345678" />
        </div>
        <div className="field full">
          <label>Metric query</label>
          <input
            value={form.metricQuery}
            onChange={(e) => updateField("metricQuery", e.target.value)}
            placeholder="sum:trace.http.request.errors{service:payment-service}.as_count()"
          />
        </div>
        <div className="field full">
          <label>Error log query</label>
          <input
            value={form.errorQuery}
            onChange={(e) => updateField("errorQuery", e.target.value)}
            placeholder="service:payment-service env:production status:error"
          />
        </div>
        <div className="field full">
          <label>Deployment log query</label>
          <input
            value={form.deploymentQuery}
            onChange={(e) => updateField("deploymentQuery", e.target.value)}
            placeholder="service:payment-service env:production deployment"
          />
        </div>

        {/* ── Per-target overrides ─────────────────────────────────────── */}
        <div className="field-group-label full">
          Per-application connector overrides <span className="hint-inline">(optional — falls back to connector default)</span>
        </div>
        <div className="field">
          <label>GitHub repo owner</label>
          <input value={form.githubRepoOwner} onChange={(e) => updateField("githubRepoOwner", e.target.value)} placeholder="uses connector default" />
        </div>
        <div className="field">
          <label>GitHub repo name</label>
          <input value={form.githubRepoName} onChange={(e) => updateField("githubRepoName", e.target.value)} placeholder="uses connector default" />
        </div>
        <div className="field full">
          <label>Slack channel ID</label>
          <input value={form.slackChannelId} onChange={(e) => updateField("slackChannelId", e.target.value)} placeholder="uses connector default" />
        </div>

        <div className="actions">
          <button type="submit" disabled={loading}>
            {loading && <span className="spinner" />}
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
