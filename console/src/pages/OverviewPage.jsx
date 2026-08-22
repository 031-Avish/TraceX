import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useConfig } from "../context/ConfigContext.jsx";
import { listConnectors, listApplications } from "../api.js";

// cloudwatch is always active (agent's own IAM role — no credentials to
// store), so it's excluded from the "connect a tool" checklist below and
// rendered separately in the connectors summary list.
const OPTIONAL_CONNECTOR_TYPES = ["datadog", "github", "slack"];

export default function OverviewPage() {
  const { apiUrl, tenantId } = useConfig();
  const [connectors, setConnectors] = useState([]);
  const [applications, setApplications] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!apiUrl) return;
    setError(null);
    setLoading(true);
    Promise.all([listConnectors(apiUrl, tenantId), listApplications(apiUrl, tenantId)])
      .then(([c, a]) => {
        setConnectors(c.connectors);
        setApplications(a.applications);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
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

  const hasOptionalConnector = connectors.some((c) => OPTIONAL_CONNECTOR_TYPES.includes(c.type));
  const hasApplication = applications.length > 0;
  const steps = [
    {
      done: true,
      label: "Infra connection active",
      detail: "CloudWatch observes via the agent's IAM role — nothing to set up.",
      to: "/connectors",
    },
    {
      done: hasOptionalConnector,
      label: "Connect a code or notification tool",
      detail: "GitHub for commit correlation, Slack to deliver the triage brief.",
      to: "/connectors",
    },
    {
      done: hasApplication,
      label: "Register an application",
      detail: "Scope the agent to a specific alarm, log group, and repo.",
      to: "/applications",
    },
    {
      done: hasApplication,
      label: "Run the simulator",
      detail: "Trigger a synthetic incident and watch the real alarm → agent → Slack flow.",
      to: "/simulator",
    },
  ];

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Overview</h1>
          <p>
            Tenant <code>{tenantId}</code>
          </p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {!loading && (!hasOptionalConnector || !hasApplication) && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <h2 className="section-title">Getting started</h2>
          <ol className="setup-checklist">
            {steps.map((step) => (
              <li key={step.label} className={step.done ? "done" : ""}>
                <span className="setup-checklist-dot">{step.done ? "✓" : ""}</span>
                <div>
                  <div className="setup-checklist-label">{step.label}</div>
                  <div className="hint">{step.detail}</div>
                </div>
                {!step.done && (
                  <Link to={step.to} className="btn-link push-right">
                    Go →
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="grid-2">
        <div className="panel">
          <h2 className="section-title">Connectors</h2>
          <p className="hint">{connectors.length} connected</p>
          <ul className="summary-list">
            <li>
              <span className="dot on" />
              cloudwatch — always on (IAM role)
            </li>
            {OPTIONAL_CONNECTOR_TYPES.map((type) => {
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
          {applications.length === 0 ? (
            <p className="hint">None yet — add one to start monitoring it.</p>
          ) : (
            <ul className="summary-list">
              {applications.slice(0, 6).map((a) => (
                <li key={a.appId}>
                  <span className="dot info" />
                  {a.appId}
                </li>
              ))}
              {applications.length > 6 && <li className="hint">+{applications.length - 6} more</li>}
            </ul>
          )}
          <Link to="/applications" className="btn-link">
            Manage applications →
          </Link>
        </div>
      </div>
    </div>
  );
}
