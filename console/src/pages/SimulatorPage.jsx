import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listApplications, simulateBreak, simulateHeal, simulateStatus } from "../api.js";

const POLL_INTERVAL_MS = 5000;
const RECOVERED_RESET_MS = 4500;

// The three scenario groups the product plan calls for. Each app card is
// slotted into exactly one of these by appId; anything registered outside
// this list still shows up (see "Other applications" below) instead of
// silently disappearing.
const SECTIONS = [
  {
    key: "app-errors",
    title: "Application Errors",
    subtitle: "Code-level bugs — the agent finds the actual bad commit.",
    appIds: ["payment-service"],
  },
  {
    key: "infra-capacity",
    title: "Infrastructure — Capacity Limits",
    subtitle: "No code cause here — this is a platform-level throttle (Lambda concurrency).",
    appIds: ["inventory-service"],
  },
  {
    key: "infra-dependency",
    title: "Infrastructure — Dependency Failure",
    subtitle: "The app's own code is fine — a downstream AWS service it depends on is failing.",
    appIds: ["acme-payment-service"],
  },
];

const KNOWN_APP_IDS = new Set(SECTIONS.flatMap((s) => s.appIds));

// The five stages of the live flow shown on every card.
const STEPS = [
  { key: "healthy", label: "Healthy" },
  { key: "alarm", label: "Alert Fired" },
  { key: "investigating", label: "Agent Investigating" },
  { key: "reported", label: "Root Cause Found" },
  { key: "recovered", label: "Recovered" },
];
const PHASE_STEP = { healthy: 0, breaking: 1, investigating: 2, reported: 3, recovered: 4 };

// Cosmetic, cycling status lines so the (real, 20-40s) investigating stage
// feels alive instead of a spinner stuck on one static word.
const INVESTIGATING_HINTS = [
  "Pulling recent deploys…",
  "Correlating error logs…",
  "Checking recent commits…",
  "Cross-referencing alarm history…",
  "Drafting root-cause hypothesis…",
];

// Maps the raw /simulate/{appId}/status response onto the card's display phase.
// Kept as a pure function so the polling effect below stays easy to follow.
function nextPhase(current, data) {
  if (!data) return current;
  const { alarmState, incidentState, confidence, severity } = data;

  if (incidentState === "recovered") {
    return { phase: "recovered", confidence: null, severity: null };
  }
  if (incidentState === "reported") {
    return { phase: "reported", confidence, severity };
  }
  if (alarmState === "ALARM" && (incidentState === "investigating" || !incidentState)) {
    return { phase: "investigating", confidence: null, severity: null };
  }
  if (alarmState === "OK" && !incidentState) {
    // Alarm hasn't tripped yet — keep whatever we're currently showing
    // (either still "healthy", or the optimistic "breaking" state right
    // after clicking Break, waiting for CloudWatch to catch up).
    return current;
  }
  return current;
}

function Stepper({ phase, confidence, severity, investigatingSeconds }) {
  const activeIndex = PHASE_STEP[phase] ?? 0;

  return (
    <div className="stepper">
      {STEPS.map((step, idx) => {
        const state = idx < activeIndex ? "complete" : idx === activeIndex ? "active" : "upcoming";
        return (
          <div className={`stepper-step ${state} step-${step.key}`} key={step.key}>
            <span className="stepper-dot">{state === "complete" ? "✓" : ""}</span>
            <span className="stepper-label">{step.label}</span>

            {step.key === "alarm" && state === "active" && (
              <span className="stepper-meta">
                <span className="spinner" /> waiting for alarm…
              </span>
            )}

            {step.key === "investigating" && state === "active" && (
              <span className="stepper-meta">
                <span className="spinner" />{" "}
                {INVESTIGATING_HINTS[Math.floor(investigatingSeconds / 6) % INVESTIGATING_HINTS.length]}{" "}
                ({investigatingSeconds}s)
              </span>
            )}

            {step.key === "reported" && state === "active" && (
              <span className="stepper-meta">
                {typeof confidence === "number" && (
                  <span className="badge reported">{Math.round(confidence)}% confidence</span>
                )}
                {severity && <span className="badge reported">{severity}</span>}
              </span>
            )}

            {step.key === "recovered" && state === "active" && (
              <span className="stepper-meta stepper-meta-ok">back to healthy…</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SimCard({ app, apiUrl, tenantId, showToast, confirm }) {
  const [sim, setSim] = useState({ phase: "healthy", confidence: null, severity: null });
  const [breaking, setBreaking] = useState(false);
  const [healing, setHealing] = useState(false);
  const [investigatingSeconds, setInvestigatingSeconds] = useState(0);
  const intervalRef = useRef(null);
  const resetTimerRef = useRef(null);

  const polling = sim.phase !== "healthy";

  const poll = useCallback(() => {
    simulateStatus(apiUrl, tenantId, app.appId)
      .then((data) => setSim((current) => ({ ...current, ...nextPhase(current, data) })))
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

  // Ticks once a second only while "Agent Investigating" is the active step,
  // purely so that stage can visibly show it's alive during the real 20-40s
  // it takes the agent to work.
  useEffect(() => {
    if (sim.phase !== "investigating") {
      setInvestigatingSeconds(0);
      return undefined;
    }
    const start = Date.now();
    const id = setInterval(() => setInvestigatingSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [sim.phase]);

  // "Recovered" is a brief success beat — reset back to "Healthy" a few
  // seconds after we see it so the card is ready for the next run.
  useEffect(() => {
    if (sim.phase !== "recovered") return undefined;
    resetTimerRef.current = setTimeout(() => {
      setSim({ phase: "healthy", confidence: null, severity: null });
    }, RECOVERED_RESET_MS);
    return () => clearTimeout(resetTimerRef.current);
  }, [sim.phase]);

  const handleBreak = async () => {
    const ok = await confirm(
      `Trigger a synthetic incident for ${app.appId}? This will fire a real alarm and post to Slack.`
    );
    if (!ok) return;
    try {
      setBreaking(true);
      await simulateBreak(apiUrl, app.appId);
      showToast(`Synthetic incident triggered for ${app.appId}`, "ok");
      setSim({ phase: "breaking", confidence: null, severity: null });
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

  const fixEnabled = sim.phase === "breaking" || sim.phase === "investigating" || sim.phase === "reported";

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="title">{app.appId}</div>
          <div className="hint">env: {app.config?.environment || "production"}</div>
        </div>
      </div>

      <Stepper
        phase={sim.phase}
        confidence={sim.confidence}
        severity={sim.severity}
        investigatingSeconds={investigatingSeconds}
      />

      {sim.phase === "reported" && (
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

function NotRegisteredCard({ appId }) {
  return (
    <div className="card dim">
      <div className="card-head">
        <div>
          <div className="title">{appId}</div>
          <div className="hint">not registered yet</div>
        </div>
      </div>
      <p className="hint">Add this application under Applications to enable the simulator for it.</p>
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

  const appsById = useMemo(() => new Map(applications.map((a) => [a.appId, a])), [applications]);
  const otherApps = useMemo(
    () => applications.filter((a) => !KNOWN_APP_IDS.has(a.appId)),
    [applications]
  );

  if (!apiUrl) return <div className="panel">Set the Config API URL in Settings first.</div>;

  const renderCard = (appId) => {
    const app = appsById.get(appId);
    if (!app) return <NotRegisteredCard key={appId} appId={appId} />;
    return (
      <SimCard key={appId} app={app} apiUrl={apiUrl} tenantId={tenantId} showToast={showToast} confirm={confirm} />
    );
  };

  return (
    <div>
      <h2 className="section-title">Simulator</h2>
      <p className="hint">
        Trigger a synthetic incident against a registered application to verify the alarm → agent →
        Slack pipeline works end-to-end.
      </p>

      {loading && <p className="hint">Loading applications…</p>}

      {!loading &&
        SECTIONS.map((section) => (
          <section className="panel sim-section" key={section.key}>
            <h2 className="section-title">{section.title}</h2>
            <p className="hint sim-section-subtitle">{section.subtitle}</p>
            <div className="cards-row">{section.appIds.map(renderCard)}</div>
          </section>
        ))}

      {!loading && otherApps.length > 0 && (
        <section className="panel sim-section">
          <h2 className="section-title">Other applications</h2>
          <p className="hint sim-section-subtitle">
            Registered applications outside the scripted demo scenarios above.
          </p>
          <div className="cards-row">
            {otherApps.map((app) => (
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
        </section>
      )}
    </div>
  );
}
