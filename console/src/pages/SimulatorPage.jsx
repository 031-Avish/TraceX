import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listApplications, simulateBreak, simulateHeal, simulateStatus } from "../api.js";

const POLL_INTERVAL_MS = 5000;

// Maps the raw /simulate/{appId}/status response onto the card's display state.
// Kept as a pure function so the polling effect below stays easy to follow.
function nextSimState(current, data) {
  if (!data) return current;
  const { alarmState, incidentState, confidence, severity } = data;

  if (incidentState === "recovered") {
    return { status: "healthy", confidence: null, severity: null };
  }
  if (incidentState === "reported") {
    return { status: "reported", confidence, severity };
  }
  if (alarmState === "ALARM" && (incidentState === "investigating" || !incidentState)) {
    return { status: "investigating", confidence: null, severity: null };
  }
  if (alarmState === "OK" && !incidentState) {
    // Alarm hasn't tripped yet — keep whatever we're currently showing
    // (either still "healthy", or the optimistic "broken" state right after
    // clicking Break, waiting for CloudWatch to catch up).
    return current;
  }
  return current;
}

function StatusLine({ sim }) {
  switch (sim.status) {
    case "healthy":
      return (
        <span className="sim-status">
          <span className="dot on" /> Healthy
        </span>
      );
    case "broken":
      return (
        <span className="sim-status">
          <span className="dot err" /> Broken
        </span>
      );
    case "investigating":
      return (
        <span className="sim-status">
          <span className="dot warn" />
          <span className="spinner" /> Broken — alert fired, agent investigating
        </span>
      );
    case "reported":
      return (
        <span className="sim-status">
          <span className="dot info" /> Reported
          {typeof sim.confidence === "number" && (
            <span className="badge reported"> {Math.round(sim.confidence)}% confidence</span>
          )}
          {sim.severity && <span className="badge reported">{sim.severity}</span>}
        </span>
      );
    default:
      return null;
  }
}

function SimCard({ app, apiUrl, tenantId, showToast, confirm }) {
  const [sim, setSim] = useState({ status: "healthy", confidence: null, severity: null });
  const [breaking, setBreaking] = useState(false);
  const [healing, setHealing] = useState(false);
  const intervalRef = useRef(null);

  const polling = sim.status !== "healthy";

  const poll = useCallback(() => {
    simulateStatus(apiUrl, tenantId, app.appId)
      .then((data) => setSim((current) => ({ ...current, ...nextSimState(current, data) })))
      .catch((e) => showToast(e.message, "error"));
  }, [apiUrl, tenantId, app.appId, showToast]);

  useEffect(() => {
    if (!polling) return undefined;
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [polling, poll]);

  const handleBreak = async () => {
    const ok = await confirm(
      `Trigger a synthetic incident for ${app.appId}? This will fire a real alarm and post to Slack.`
    );
    if (!ok) return;
    try {
      setBreaking(true);
      await simulateBreak(apiUrl, app.appId);
      showToast(`Synthetic incident triggered for ${app.appId}`, "ok");
      setSim({ status: "broken", confidence: null, severity: null });
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setBreaking(false);
    }
  };

  const handleFix = async () => {
    try {
      setHealing(true);
      await simulateHeal(apiUrl, app.appId);
      showToast(`Fix triggered for ${app.appId}`, "ok");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setHealing(false);
    }
  };

  const fixEnabled = sim.status !== "healthy";

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="title">{app.appId}</div>
          <div className="hint">env: {app.config?.environment || "production"}</div>
        </div>
        <StatusLine sim={sim} />
      </div>

      {sim.status === "reported" && (
        <p className="hint sim-note">Check Slack for the full triage brief.</p>
      )}

      <div className="app-actions">
        <button className="danger" onClick={handleBreak} disabled={breaking}>
          {breaking ? "Breaking…" : "Break"}
        </button>
        <button className="secondary" onClick={handleFix} disabled={!fixEnabled || healing}>
          {healing ? "Fixing…" : "Fix"}
        </button>
      </div>
    </div>
  );
}

export default function SimulatorPage() {
  const { apiUrl, tenantId } = useConfig();
  const showToast = useToast();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!apiUrl) return;
    setLoading(true);
    listApplications(apiUrl, tenantId)
      .then(({ applications }) => setApplications(applications))
      .catch((e) => showToast(e.message, "error"))
      .finally(() => setLoading(false));
  }, [apiUrl, tenantId, showToast]);

  // window.confirm mirrors the confirm-before-impactful-action pattern already
  // used on ConnectorsPage (see its `disconnect` handler).
  const confirm = useCallback((message) => Promise.resolve(window.confirm(message)), []);

  if (!apiUrl) return <div className="panel">Set the Config API URL in Settings first.</div>;

  return (
    <div>
      <h2 className="section-title">Simulator</h2>
      <p className="hint">
        Trigger a synthetic incident against a registered application to verify the alarm → agent →
        Slack pipeline works end-to-end.
      </p>

      {loading && <p className="hint">Loading applications…</p>}
      {!loading && applications.length === 0 && (
        <p className="hint">No applications configured yet — add one under Applications first.</p>
      )}

      <div className="cards-row">
        {applications.map((app) => (
          <SimCard
            key={app.appId}
            app={app}
            apiUrl={apiUrl}
            tenantId={tenantId}
            showToast={showToast}
            confirm={confirm}
          />
        ))}
      </div>
    </div>
  );
}
