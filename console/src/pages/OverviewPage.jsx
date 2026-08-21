import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useConfig } from "../context/ConfigContext.jsx";
import { listConnectors, listApplications } from "../api.js";
import { CONNECTOR_CATALOG } from "../connectors.js";

const CONNECTABLE_TYPES = CONNECTOR_CATALOG.filter((c) => c.available).map((c) => c.type);

export default function OverviewPage() {
  const { apiUrl, tenantId } = useConfig();
  const [connectors, setConnectors] = useState(null);
  const [applications, setApplications] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!apiUrl) return;
    setError(null);
    Promise.all([listConnectors(apiUrl, tenantId), listApplications(apiUrl, tenantId)])
      .then(([c, a]) => {
        setConnectors(c.connectors);
        setApplications(a.applications);
      })
      .catch((e) => setError(e.message));
  }, [apiUrl, tenantId]);

  if (!apiUrl) {
    return (
      <div>
        <div className="page-heading">
          <div>
            <h1>Welcome to TraceX</h1>
            <p>Connect your own tools — the agent only ever sees what you configure here.</p>
          </div>
        </div>
        <div className="empty-state" style={{ maxWidth: 480 }}>
          <div className="empty-icon">🧭</div>
          Set your Config API URL in <Link to="/settings" className="btn-link" style={{ display: "inline" }}>Settings</Link> to get started —
          it comes from the <code>config_api_url</code> Terraform output after <code>./deploy.sh</code>.
        </div>
      </div>
    );
  }

  const loading = connectors === null || applications === null;
  const connectedCount = connectors?.filter((c) => CONNECTABLE_TYPES.includes(c.type)).length ?? 0;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Overview</h1>
          <p>What TraceX can see for tenant <code>{tenantId}</code>, at a glance.</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <div className="stat-row">
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </div>
      ) : (
        <div className="stat-row">
          <div className="stat-card accent">
            <span className="stat-label">Connectors</span>
            <span className="stat-value">
              {connectedCount}
              <small>/ {CONNECTABLE_TYPES.length} available</small>
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Applications</span>
            <span className="stat-value">{applications.length}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Tenant</span>
            <span className="stat-value" style={{ fontSize: 16 }}>
              {tenantId}
            </span>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="panel">
          <h2 className="section-title">Connectors</h2>
          {loading ? (
            <div className="skeleton" style={{ height: 96 }} />
          ) : (
            <>
              <ul className="summary-list">
                {CONNECTOR_CATALOG.filter((c) => c.available).map((c) => {
                  const found = connectors.some((item) => item.type === c.type);
                  return (
                    <li key={c.type}>
                      <span className={`dot ${found ? "on" : "off"}`} />
                      {c.name} — {found ? "connected" : "not connected"}
                    </li>
                  );
                })}
              </ul>
              <Link to="/connectors" className="btn-link">
                Manage connectors →
              </Link>
            </>
          )}
        </div>

        <div className="panel">
          <h2 className="section-title">Applications</h2>
          {loading ? (
            <div className="skeleton" style={{ height: 96 }} />
          ) : (
            <>
              <ul className="summary-list">
                {applications.length === 0 && <li className="hint">None configured yet</li>}
                {applications.slice(0, 6).map((a) => (
                  <li key={a.appId}>
                    <span className="dot on" />
                    {a.appId}
                    {a.config?.environment && (
                      <span className="env-tag" style={{ marginLeft: 2 }}>
                        {a.config.environment}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <Link to="/applications" className="btn-link">
                Manage applications →
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
