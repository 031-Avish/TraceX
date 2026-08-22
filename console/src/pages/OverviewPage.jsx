import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useConfig } from "../context/ConfigContext.jsx";
import { listConnectors, listApplications, simulateStatus } from "../api.js";

// cloudwatch is always active (agent's own IAM role — no credentials to
// store), so it's excluded from the "connect a tool" checklist below and
// rendered separately in the connectors summary list.
const OPTIONAL_CONNECTOR_TYPES = ["datadog", "github", "slack"];

// Caps how many applications the live-status strip below queries — this is
// a real DescribeAlarms + DynamoDB read per app (the same call the Simulator
// page polls), so keep the overview page's own load fast/cheap rather than
// fanning out unboundedly for tenants with a lot of registered apps.
const MAX_LIVE_STATUS_APPS = 8;

const ALARM_STATE_LABEL = {
  OK: "healthy",
  ALARM: "in alarm",
  INSUFFICIENT_DATA: "insufficient data",
};
const ALARM_STATE_DOT = {
  OK: "on",
  ALARM: "err",
  INSUFFICIENT_DATA: "warn",
};

export default function OverviewPage() {
  const { apiUrl, tenantId } = useConfig();
  const [connectors, setConnectors] = useState([]);
  const [applications, setApplications] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // appId -> simulateStatus response, or null once a fetch for it has
  // failed/settled with no alarm configured. Absent key = still loading.
  const [liveStatus, setLiveStatus] = useState({});

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

  // Real current CloudWatch alarm state per registered application — not
  // fabricated placeholder data, the same simulateStatus call the Simulator
  // page already polls. Fired once per app as soon as the app list loads.
  useEffect(() => {
    if (!apiUrl || applications.length === 0) return undefined;
    let cancelled = false;
    setLiveStatus({});
    applications.slice(0, MAX_LIVE_STATUS_APPS).forEach((app) => {
      simulateStatus(apiUrl, tenantId, app.appId)
        .then((data) => {
          if (!cancelled) setLiveStatus((current) => ({ ...current, [app.appId]: data }));
        })
        .catch(() => {
          if (!cancelled) setLiveStatus((current) => ({ ...current, [app.appId]: null }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, tenantId, applications]);

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
  const monitoredCount = applications.filter((a) => a.config?.alarmName).length;
  const alarmingCount = Object.values(liveStatus).filter((s) => s?.alarmState === "ALARM").length;
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

      {!loading && (
        <div className="stat-row">
          <div className="stat-tile">
            <div className="stat-value">{applications.length}</div>
            <div className="stat-label">Applications registered</div>
          </div>
          <div className="stat-tile">
            <div className="stat-value">
              {connectors.length}
              <span className="stat-of"> / {OPTIONAL_CONNECTOR_TYPES.length + 1}</span>
            </div>
            <div className="stat-label">Connectors active</div>
          </div>
          <div className="stat-tile">
            <div className="stat-value">{monitoredCount}</div>
            <div className="stat-label">Scoped to a CloudWatch alarm</div>
          </div>
          <div className={`stat-tile ${alarmingCount > 0 ? "stat-alert" : ""}`}>
            <div className="stat-value">{alarmingCount}</div>
            <div className="stat-label">Currently in alarm</div>
          </div>
        </div>
      )}

      {!loading && hasApplication && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <h2 className="section-title">Live status</h2>
          <p className="hint" style={{ marginBottom: 14 }}>
            Current CloudWatch alarm state for each registered application.
          </p>
          <div className="status-grid">
            {applications.slice(0, MAX_LIVE_STATUS_APPS).map((app) => {
              const status = liveStatus[app.appId];
              const alarmState = status?.alarmState;
              const dotClass = alarmState ? ALARM_STATE_DOT[alarmState] || "info" : "off";
              const label = !app.config?.alarmName
                ? "no alarm configured"
                : status === undefined
                ? "checking…"
                : alarmState
                ? ALARM_STATE_LABEL[alarmState] || alarmState.toLowerCase()
                : "unknown";
              return (
                <Link to="/simulator" className="status-item" key={app.appId}>
                  <span className="status-left">
                    <span className={`dot ${dotClass}`} />
                    <span className="status-appid">{app.appId}</span>
                  </span>
                  <span className="status-state">{label}</span>
                </Link>
              );
            })}
            {applications.length > MAX_LIVE_STATUS_APPS && (
              <div className="status-item">
                <span className="status-left">
                  <span className="hint">+{applications.length - MAX_LIVE_STATUS_APPS} more — see Applications</span>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

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
