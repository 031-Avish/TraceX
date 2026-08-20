import React, { useCallback, useEffect, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listConnectors, saveConnector } from "../api.js";

const BLANK = {
  github: { token: "", owner: "", repo: "" },
  slack: { token: "", channelId: "" },
};

export default function ConnectorsPage() {
  const { apiUrl, tenantId } = useConfig();
  const showToast = useToast();
  const [connectors, setConnectors] = useState([]);
  const [forms, setForms] = useState(BLANK);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!apiUrl) return;
    listConnectors(apiUrl, tenantId)
      .then(({ connectors }) => {
        setConnectors(connectors);
        setForms((prev) => {
          const next = { github: { ...prev.github, token: "" }, slack: { ...prev.slack, token: "" } };
          const gh = connectors.find((c) => c.type === "github");
          const sl = connectors.find((c) => c.type === "slack");
          if (gh) {
            next.github.owner = gh.config.owner || "";
            next.github.repo = gh.config.repo || "";
          }
          if (sl) {
            next.slack.channelId = sl.config.channelId || "";
          }
          return next;
        });
      })
      .catch((e) => showToast(e.message, "error"));
  }, [apiUrl, tenantId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const updateField = (type, field, value) =>
    setForms((prev) => ({ ...prev, [type]: { ...prev[type], [field]: value } }));

  const save = async (type) => {
    try {
      setLoading(true);
      await saveConnector(apiUrl, tenantId, type, forms[type]);
      showToast(`${type} connector saved`, "ok");
      load();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const isConnected = (type) => connectors.some((c) => c.type === type);

  if (!apiUrl) return <div className="panel">Set the Config API URL in Settings first.</div>;

  return (
    <div>
      <h2 className="section-title">Connectors</h2>
      <p className="hint">Connect your own GitHub and Slack — the agent only sees what you configure here.</p>

      <div className="cards-row">
        <div className="card">
          <div className="card-head">
            <span className="title">🐙 GitHub</span>
            <span className={`badge ${isConnected("github") ? "connected" : "not-connected"}`}>
              {isConnected("github") ? "Connected" : "Not connected"}
            </span>
          </div>
          <div className="field">
            <label>Personal Access Token</label>
            <input
              type="password"
              placeholder="leave blank to keep existing"
              value={forms.github.token}
              onChange={(e) => updateField("github", "token", e.target.value)}
            />
          </div>
          <div className="field">
            <label>Default repo owner</label>
            <input
              value={forms.github.owner}
              onChange={(e) => updateField("github", "owner", e.target.value)}
              placeholder="your-username"
            />
          </div>
          <div className="field">
            <label>Default repo name</label>
            <input
              value={forms.github.repo}
              onChange={(e) => updateField("github", "repo", e.target.value)}
              placeholder="acme-payment-service"
            />
          </div>
          <button onClick={() => save("github")} disabled={loading}>
            Save
          </button>
        </div>

        <div className="card">
          <div className="card-head">
            <span className="title">💬 Slack</span>
            <span className={`badge ${isConnected("slack") ? "connected" : "not-connected"}`}>
              {isConnected("slack") ? "Connected" : "Not connected"}
            </span>
          </div>
          <div className="field">
            <label>Bot Token (xoxb-...)</label>
            <input
              type="password"
              placeholder="leave blank to keep existing"
              value={forms.slack.token}
              onChange={(e) => updateField("slack", "token", e.target.value)}
            />
          </div>
          <div className="field">
            <label>Default channel ID</label>
            <input
              value={forms.slack.channelId}
              onChange={(e) => updateField("slack", "channelId", e.target.value)}
              placeholder="C0XXXXXXXXX"
            />
          </div>
          <button onClick={() => save("slack")} disabled={loading}>
            Save
          </button>
        </div>

        <div className="card dim">
          <div className="card-head">
            <span className="title">📊 Datadog</span>
            <span className="badge not-connected">Coming soon</span>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            Same connector interface — any observability platform slots in without changing the agent.
          </p>
        </div>
      </div>
    </div>
  );
}
