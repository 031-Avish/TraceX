import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useConfig } from "../context/ConfigContext.jsx";
import { listConnectors, listApplications } from "../api.js";

const CONNECTOR_TYPES = ["github", "slack"];

export default function OverviewPage() {
  const { apiUrl, tenantId } = useConfig();
  const [connectors, setConnectors] = useState([]);
  const [applications, setApplications] = useState([]);
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
      <div className="panel">
        <h2 className="section-title">Get started</h2>
        <p>
          Set your Config API URL in <Link to="/settings">Settings</Link> — it comes from the{" "}
          <code>config_api_url</code> Terraform output after <code>./deploy.sh</code>.
        </p>
      </div>
    );
  }

  return (
    <div>
      {error && <p className="error-text">{error}</p>}
      <div className="grid-2">
        <div className="panel">
          <h2 className="section-title">Connectors</h2>
          <p className="hint">
            tenant <code>{tenantId}</code>
          </p>
          <ul className="summary-list">
            {CONNECTOR_TYPES.map((type) => {
              const found = connectors.some((c) => c.type === type);
              return (
                <li key={type}>
                  <span className={`dot ${found ? "on" : "off"}`} />
                  {type} — {found ? "connected" : "not connected"}
                </li>
              );
            })}
          </ul>
          <Link to="/connectors" className="btn-link">
            Manage connectors →
          </Link>
        </div>

        <div className="panel">
          <h2 className="section-title">Applications</h2>
          <p className="hint">{applications.length} configured</p>
          <ul className="summary-list">
            {applications.length === 0 && <li className="hint">None yet</li>}
            {applications.slice(0, 6).map((a) => (
              <li key={a.appId}>{a.appId}</li>
            ))}
          </ul>
          <Link to="/applications" className="btn-link">
            Manage applications →
          </Link>
        </div>
      </div>
    </div>
  );
}
