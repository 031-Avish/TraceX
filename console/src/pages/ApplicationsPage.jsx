import React, { useCallback, useEffect, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listApplications, saveApplication, deleteApplication } from "../api.js";
import Modal from "../components/Modal.jsx";
import EmptyState from "../components/EmptyState.jsx";

const EMPTY_FORM = {
  appId: "",
  environment: "production",
  // CloudWatch scope — which log group / alarm / namespace belongs to this app
  alarmName: "",
  logGroupName: "",
  metricNamespace: "",
  // Datadog scope — optional; only used when the Datadog connector is active
  serviceName: "",
  monitorId: "",
  metricQuery: "",
  errorQuery: "",
  deploymentQuery: "",
  // Per-app connector overrides (fall back to the connector's default when blank)
  githubRepoOwner: "",
  githubRepoName: "",
  slackChannelId: "",
};

export default function ApplicationsPage() {
  const { apiUrl, tenantId } = useConfig();
  const showToast = useToast();
  const [applications, setApplications] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null); // null = adding a new application
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);

  const load = useCallback(() => {
    if (!apiUrl) return;
    setListLoading(true);
    listApplications(apiUrl, tenantId)
      .then(({ applications }) => setApplications(applications))
      .catch((e) => showToast(e.message, "error"))
      .finally(() => setListLoading(false));
  }, [apiUrl, tenantId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (app) => {
    setEditingId(app.appId);
    setForm({ ...EMPTY_FORM, ...app.config, appId: app.appId });
    setModalOpen(true);
  };

  const startNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
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
      closeModal();
      load();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const remove = async (appId) => {
    if (!window.confirm(`Remove "${appId}"? This can't be undone.`)) return;
    try {
      await deleteApplication(apiUrl, tenantId, appId);
      showToast("Removed", "ok");
      if (editingId === appId) closeModal();
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
            Map each application to its observability provider and a tightly scoped set of logs,
            metrics, alerts, repository, and notification destinations.
          </p>
        </div>
        <button type="button" onClick={startNew}>
          + Add application
        </button>
      </div>

      {!listLoading && applications.length === 0 && (
        <div className="panel">
          <EmptyState
            icon="🗂"
            title="No applications yet"
            message="Register an application to scope which logs, alarms, and repository the agent investigates when it fires."
            actionLabel="Add your first application"
            onAction={startNew}
          />
        </div>
      )}

      {applications.length > 0 && (
        <div className="apps-list">
          {applications.map((app) => (
            <div className="app-item" key={app.appId}>
              <div>
                <div className="app-id">{app.appId}</div>
                <div className="meta">
                  {app.config.logGroupName || app.config.serviceName || "—"} · alarm:{" "}
                  {app.config.alarmName || app.config.monitorId || "—"} · env:{" "}
                  {app.config.environment || "production"}
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

      {modalOpen && (
        <Modal
          title={editingId ? `Editing "${editingId}"` : "Add application"}
          subtitle="Scope the agent to this application's logs, alarms, repo, and notification target."
          onClose={closeModal}
          wide
        >
          <form className="app-form" onSubmit={save}>
            {/* ── Identity ──────────────────────────────────────────────── */}
            <div className="field">
              <label>App ID (matches alarm's service name)</label>
              <input
                value={form.appId}
                onChange={(e) => updateField("appId", e.target.value)}
                placeholder="payment-service"
                disabled={!!editingId}
                autoFocus
              />
            </div>
            <div className="field">
              <label>Environment</label>
              <input
                value={form.environment}
                onChange={(e) => updateField("environment", e.target.value)}
                placeholder="production"
              />
            </div>

            {/* ── CloudWatch scope ──────────────────────────────────────── */}
            {/* These fields scope the CloudWatch integration to this specific   */}
            {/* application. Connect CloudWatch under Integrations first.        */}
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
              <input
                value={form.metricNamespace}
                onChange={(e) => updateField("metricNamespace", e.target.value)}
                placeholder="AcmeApp"
              />
            </div>

            {/* ── Datadog scope (optional) ────────────────────────────────── */}
            {/* Only used when the Datadog connector is active. Leave blank if   */}
            {/* your team uses CloudWatch only.                                  */}
            <div className="field-group-label full">
              Datadog scope <span className="hint-inline">(optional — requires Datadog connector)</span>
            </div>
            <div className="field">
              <label>Service tag</label>
              <input
                value={form.serviceName}
                onChange={(e) => updateField("serviceName", e.target.value)}
                placeholder={form.appId || "payment-service"}
              />
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

            {/* ── Per-app overrides ───────────────────────────────────────── */}
            {/* Falls back to the connector's default when left blank.           */}
            <div className="field-group-label full">
              Per-app connector overrides <span className="hint-inline">(optional — falls back to connector default)</span>
            </div>
            <div className="field">
              <label>GitHub repo owner</label>
              <input
                value={form.githubRepoOwner}
                onChange={(e) => updateField("githubRepoOwner", e.target.value)}
                placeholder="uses connector default"
              />
            </div>
            <div className="field">
              <label>GitHub repo name</label>
              <input
                value={form.githubRepoName}
                onChange={(e) => updateField("githubRepoName", e.target.value)}
                placeholder="uses connector default"
              />
            </div>
            <div className="field full">
              <label>Slack channel ID</label>
              <input
                value={form.slackChannelId}
                onChange={(e) => updateField("slackChannelId", e.target.value)}
                placeholder="uses connector default"
              />
            </div>

            <div className="actions">
              <button type="submit" disabled={loading}>
                {loading ? "Saving…" : editingId ? "Save changes" : "Add application"}
              </button>
              <button type="button" className="secondary" onClick={closeModal}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
