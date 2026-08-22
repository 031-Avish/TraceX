import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listApplications, simulateBreak, simulateHeal, simulateStatus } from "../api.js";

const POLL_INTERVAL_MS = 5000;
const RECOVERED_RESET_MS = 4500;

// simulateStatus (lambda-config-api/index.js) queries the most recent
// INCIDENT#<alarmName># item unconditionally — it has no way to tell a
// fresh incident from THIS "Break" click apart from a leftover record from
// a previous, already-finished run on the same alarm (its response doesn't
// even include the incident's startedAt, only state/confidence/severity).
// So the client has to guard against showing a stale result itself: a real
// CloudWatch alarm here takes ~45-90s minimum to evaluate and enter ALARM,
// so anything claiming to be past "breaking" (investigating/reported/
// recovered) inside that window cannot possibly belong to this run. 40s
// gives a small safety margin under the documented 45s floor. See
// seenInvestigatingRef below for the second half of the guard.
const MIN_ALARM_EVAL_MS = 40000;

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
//
// incidentState is written by lambda-agent/src/incidents/incident-store.js and
// lambda-agent/src/handler.js. Every value either of those files ever sets as
// `state:` must have an explicit branch below — falling through to `return
// current` unhandled (as used to happen for "alerting") silently freezes the
// card instead of showing real progress. Known values, confirmed by grepping
// both files: alerting, investigating, slack_alert_failed, reported,
// report_failed, recovered.
function nextPhase(current, data) {
  if (!data) return current;
  const { alarmState, incidentState, confidence, severity } = data;

  switch (incidentState) {
    case "recovered":
      return { phase: "recovered", confidence: null, severity: null, error: null };

    case "reported":
      return { phase: "reported", confidence, severity, error: null };

    case "report_failed":
      // The agent finished investigating but couldn't post the report to
      // Slack even after handler.js's one retry — a real, terminal failure,
      // not "nothing happening". Surface it instead of hiding it.
      return {
        phase: "reported",
        confidence,
        severity,
        error: "Investigation finished, but posting the report to Slack failed.",
      };

    case "investigating":
      return { phase: "investigating", confidence: null, severity: null, error: null };

    case "slack_alert_failed":
      // Only the *initial* alert failed to post — handler.js still runs the
      // agent and retries the post before the final report, so this is
      // usually transient. Keep showing "investigating" (it genuinely is
      // running) but flag the hiccup rather than staying silent about it.
      return {
        phase: "investigating",
        confidence: null,
        severity: null,
        error: "Initial Slack alert failed — the agent is investigating anyway and will retry the post.",
      };

    case "alerting":
      // Incident record was just created: the alarm has fired but the agent
      // hasn't posted any progress yet. Explicitly treated the same as the
      // not-yet-set case below — keep showing "Alert Fired / waiting" rather
      // than silently falling through with no matching branch.
      return current;

    default:
      // incidentState is null/undefined — no incident recorded yet.
      if (alarmState === "ALARM") {
        return { phase: "investigating", confidence: null, severity: null, error: null };
      }
      // alarmState is OK/INSUFFICIENT_DATA/unknown — keep whatever we're
      // currently showing (either still "healthy", or the optimistic
      // "breaking" state right after clicking Break, waiting for CloudWatch
      // to catch up).
      return current;
  }
}

function Stepper({ phase, confidence, severity, investigatingSeconds, breakingSeconds }) {
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
                <span className="spinner" /> waiting for alarm… ({breakingSeconds}s)
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
  const [sim, setSim] = useState({ phase: "healthy", confidence: null, severity: null, error: null });
  const [breaking, setBreaking] = useState(false);
  const [healing, setHealing] = useState(false);
  const [investigatingSeconds, setInvestigatingSeconds] = useState(0);
  const [breakingSeconds, setBreakingSeconds] = useState(0);
  // Tracks the real ~45-90s wait between clicking "Fix" and the CloudWatch
  // alarm actually clearing back to OK (incidentState -> "recovered"). Without
  // this the card just sits on "reported" with no sign that anything is
  // happening, which is exactly what reads as "stuck".
  const [healTriggered, setHealTriggered] = useState(false);
  const [healSeconds, setHealSeconds] = useState(0);
  const intervalRef = useRef(null);
  const resetTimerRef = useRef(null);
  // When this run's "Break" was clicked, and whether we've locally observed
  // this run actually reach "investigating" — the two-part stale-incident
  // guard described above MIN_ALARM_EVAL_MS. Both reset on a fresh Break
  // click and when the card settles back to "healthy".
  const breakClickedAtRef = useRef(null);
  const seenInvestigatingRef = useRef(false);

  const polling = sim.phase !== "healthy";

  const poll = useCallback(() => {
    simulateStatus(apiUrl, tenantId, app.appId)
      .then((data) => {
        setSim((current) => {
          const candidate = nextPhase(current, data);
          if (candidate.phase === current.phase) return { ...current, ...candidate };

          const advancesPastBreaking =
            candidate.phase === "investigating" || candidate.phase === "reported" || candidate.phase === "recovered";
          const elapsed = breakClickedAtRef.current ? Date.now() - breakClickedAtRef.current : Infinity;

          if (advancesPastBreaking && elapsed < MIN_ALARM_EVAL_MS) {
            // Too soon for this to be a real CloudWatch transition from
            // this click — almost certainly a stale INCIDENT# record left
            // over from a previous run on this alarm. Keep showing the
            // waiting state instead of jumping straight to a stale result.
            return current;
          }
          if ((candidate.phase === "reported" || candidate.phase === "recovered") && !seenInvestigatingRef.current) {
            // Never locally observed this run pass through "investigating" —
            // same stale-record guard, belt-and-suspenders against a leftover
            // "reported"/"recovered" record surfacing without ever having
            // been preceded by a genuine "investigating" state this run.
            return current;
          }
          if (candidate.phase === "investigating") seenInvestigatingRef.current = true;
          return { ...current, ...candidate };
        });
      })
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

  // Same idea, but for the "Alert Fired" step — this is the real ~45-90s
  // metric-filter + alarm-evaluation latency between clicking "Break" and
  // CloudWatch actually entering ALARM. Ticks the whole time sim.phase stays
  // "breaking" so the wait visibly counts up instead of looking frozen.
  useEffect(() => {
    if (sim.phase !== "breaking") {
      setBreakingSeconds(0);
      return undefined;
    }
    const start = Date.now();
    const id = setInterval(() => setBreakingSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [sim.phase]);

  // Same idea again for the wait after "Fix" is clicked: real ~45-90s for the
  // alarm to clear back to OK. Runs from the moment Fix succeeds until the
  // card reaches "recovered" (or is reset to "healthy").
  useEffect(() => {
    if (!healTriggered || sim.phase === "recovered" || sim.phase === "healthy") {
      setHealSeconds(0);
      return undefined;
    }
    const start = Date.now();
    const id = setInterval(() => setHealSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [healTriggered, sim.phase]);

  // "Recovered" is a brief success beat — reset back to "Healthy" a few
  // seconds after we see it so the card is ready for the next run.
  useEffect(() => {
    if (sim.phase !== "recovered") return undefined;
    resetTimerRef.current = setTimeout(() => {
      setSim({ phase: "healthy", confidence: null, severity: null, error: null });
      setHealTriggered(false);
      breakClickedAtRef.current = null;
      seenInvestigatingRef.current = false;
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
      breakClickedAtRef.current = Date.now();
      seenInvestigatingRef.current = false;
      setSim({ phase: "breaking", confidence: null, severity: null, error: null });
      setHealTriggered(false);
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
      setHealTriggered(true);
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
          {app.config?.infraResourceName && (
            <div className="hint" title={app.config?.infraResourceArn || undefined}>
              Depends on: {app.config.infraResourceName}
            </div>
          )}
        </div>
      </div>

      <Stepper
        phase={sim.phase}
        confidence={sim.confidence}
        severity={sim.severity}
        investigatingSeconds={investigatingSeconds}
        breakingSeconds={breakingSeconds}
      />

      {sim.error && <p className="hint sim-note sim-error">⚠ {sim.error}</p>}

      {sim.phase === "reported" && !sim.error && (
        <p className="hint sim-note">Check Slack for the full triage brief.</p>
      )}

      {healTriggered && sim.phase !== "recovered" && sim.phase !== "healthy" && (
        <p className="hint sim-note">
          <span className="spinner" /> Waiting for the alarm to clear… ({healSeconds}s)
        </p>
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
