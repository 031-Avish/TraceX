import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { listApplications, simulateBreak, simulateHeal, simulateStatus } from "../api.js";

const POLL_INTERVAL_MS = 5000;
const RECOVERED_RESET_MS = 4500;

// simulateStatus (lambda-config-api/index.js) returns the CURRENT, live
// alarmState plus the most recent incident record for that alarm
// (incidentState/startedAt/confidence/severity — startedAt is ISO or null).
// The card's phase is derived fresh from that pair on every single poll
// (see computePhase below) — never from locally-remembered React state —
// so a page refresh, a remount from navigating away and back, or opening
// the page in a second tab all show the true current state immediately,
// instead of freezing on "Healthy" or on a stale guard that can never
// un-stick itself. The one piece of client memory that's genuinely needed
// is "did I just click Break and am I still waiting for MY alarm to fire"
// — that's UX polish (so the wait doesn't flash an old recovered/healthy
// state first), not a correctness guard, and it's persisted to
// localStorage (see BREAK_STORAGE_KEY) specifically so it survives a
// refresh mid-wait instead of losing track and looking stuck.
const CLOCK_SKEW_BUFFER_MS = 10000;
const MAX_BREAK_WAIT_MS = 5 * 60 * 1000; // safety cap — never override longer than this
const BREAK_STORAGE_PREFIX = "tracex-sim-break-";

function loadBreakClickedAt(appId) {
  try {
    const raw = localStorage.getItem(BREAK_STORAGE_PREFIX + appId);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}
function saveBreakClickedAt(appId, value) {
  try {
    if (value === null) localStorage.removeItem(BREAK_STORAGE_PREFIX + appId);
    else localStorage.setItem(BREAK_STORAGE_PREFIX + appId, String(value));
  } catch {
    // localStorage unavailable (private mode, etc.) — the override just
    // won't survive a refresh; live-derived state still works correctly.
  }
}

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

// Maps the raw /simulate/{appId}/status response onto the card's display
// phase — a PURE function of live backend data only (alarmState is
// CloudWatch's real-time current state; it's the anchor of truth here).
// This never reads or depends on locally-remembered React state, so it's
// correct immediately on mount, after a refresh, after navigating away and
// back, or in a second tab — none of which used to work (the card used to
// initialize to "healthy" unconditionally and only start polling once a
// *local* phase change had already happened, so a real, currently-firing
// incident was invisible until you personally clicked Break in that exact
// browser session).
//
// incidentState is written by lambda-agent/src/incidents/incident-store.js
// and lambda-agent/src/handler.js — every value either file ever sets as
// `state:` must have an explicit branch below (confirmed by grepping both:
// alerting, investigating, slack_alert_failed, reported, report_failed,
// recovered). While alarmState is ALARM, incidentState is authoritative
// (a real, live incident — trust it directly, including an "alerting" or
// absent record, which just means the agent hasn't posted progress yet).
// Once alarmState drops to OK, only "recovered" is a state that's still
// consistent with that; any other incidentState at that point is a
// leftover terminal value from an older, fully-finished cycle and the
// service is simply healthy right now.
function computePhase(data) {
  if (!data) return { phase: "healthy", confidence: null, severity: null, error: null, startedAt: null };
  const { alarmState, incidentState, confidence, severity, startedAt } = data;

  if (alarmState === "ALARM") {
    switch (incidentState) {
      case "reported":
        return { phase: "reported", confidence, severity, error: null, startedAt };
      case "report_failed":
        return {
          phase: "reported",
          confidence,
          severity,
          error: "Investigation finished, but posting the report to Slack failed.",
          startedAt,
        };
      case "investigating":
        return { phase: "investigating", confidence: null, severity: null, error: null, startedAt };
      case "slack_alert_failed":
        return {
          phase: "investigating",
          confidence: null,
          severity: null,
          error: "Initial Slack alert failed — the agent is investigating anyway and will retry the post.",
          startedAt,
        };
      default:
        // "alerting", a stale "recovered" from an earlier cycle, or no
        // incident record synced yet — the alarm is live right now
        // regardless, so show the waiting state.
        return { phase: "breaking", confidence: null, severity: null, error: null, startedAt };
    }
  }

  // alarmState is OK / INSUFFICIENT_DATA / null — no active alarm right now.
  if (incidentState === "recovered") {
    return { phase: "recovered", confidence: null, severity: null, error: null, startedAt };
  }
  return { phase: "healthy", confidence: null, severity: null, error: null, startedAt: null };
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
  // When "Break" was clicked, persisted to localStorage (not just a React
  // ref) so it survives a page refresh or navigating away and back mid-wait
  // — hydrated on mount so a reload during the ~45-90s wait still shows
  // "waiting for alarm" instead of losing track and looking stuck or, worse,
  // flashing an older unrelated recovered/healthy state. This is UX polish
  // only: computePhase() above is correct with or without it, since it's a
  // pure function of live alarmState/incidentState.
  const breakClickedAtRef = useRef(loadBreakClickedAt(app.appId));
  // Which incident (by startedAt) we've already shown+settled a "Recovered"
  // beat for — so a fully-finished old incident's terminal "recovered"
  // record (which never changes once written) doesn't re-flash every time
  // it's polled after we've already settled back to "healthy" for it.
  const acknowledgedRecoveredRef = useRef(null);

  const poll = useCallback(() => {
    simulateStatus(apiUrl, tenantId, app.appId)
      .then((data) => {
        let computed = computePhase(data);

        const clickedAt = breakClickedAtRef.current;
        const withinOverrideWindow = clickedAt !== null && Date.now() - clickedAt < MAX_BREAK_WAIT_MS;
        if (withinOverrideWindow && (computed.phase === "healthy" || computed.phase === "recovered")) {
          const startedAtMs = computed.startedAt ? new Date(computed.startedAt).getTime() : null;
          const isOurIncident = startedAtMs !== null && startedAtMs >= clickedAt - CLOCK_SKEW_BUFFER_MS;
          if (!isOurIncident) {
            // Just clicked Break and still waiting for CloudWatch to catch
            // up — don't let an older/unrelated recovered-or-absent record
            // make it look like the click did nothing.
            computed = { phase: "breaking", confidence: null, severity: null, error: null, startedAt: null };
          }
        }
        if (clickedAt !== null && !withinOverrideWindow) {
          // Safety cap elapsed (5 min) with no real progress ever seen —
          // stop overriding, just show whatever's actually true.
          breakClickedAtRef.current = null;
          saveBreakClickedAt(app.appId, null);
        }

        if (computed.phase === "recovered" && acknowledgedRecoveredRef.current === computed.startedAt) {
          // Already showed + settled this exact incident's recovery beat —
          // its terminal record never changes, so without this it would
          // re-flash "Recovered" on every poll forever instead of staying
          // settled at "Healthy".
          setSim({ phase: "healthy", confidence: null, severity: null, error: null });
          return;
        }
        setSim(computed);
      })
      .catch((e) => showToast(e.message, "error"));
  }, [apiUrl, tenantId, app.appId, showToast]);

  // Always polling, from mount to unmount, regardless of local phase — this
  // is what makes the card show true current state on load/refresh instead
  // of only ever reacting to a Break click made in this exact session.
  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [poll]);

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
  // seconds after we see it so the card is ready for the next run. Marks
  // this specific incident (by startedAt) as acknowledged first, so the
  // next poll (which will still see the same terminal "recovered" record)
  // doesn't immediately undo the reset.
  useEffect(() => {
    if (sim.phase !== "recovered") return undefined;
    resetTimerRef.current = setTimeout(() => {
      acknowledgedRecoveredRef.current = sim.startedAt;
      setSim({ phase: "healthy", confidence: null, severity: null, error: null });
      setHealTriggered(false);
      breakClickedAtRef.current = null;
      saveBreakClickedAt(app.appId, null);
    }, RECOVERED_RESET_MS);
    return () => clearTimeout(resetTimerRef.current);
  }, [sim.phase, sim.startedAt, app.appId]);

  const handleBreak = async () => {
    const ok = await confirm(
      `Trigger a synthetic incident for ${app.appId}? This will fire a real alarm and post to Slack.`
    );
    if (!ok) return;
    try {
      setBreaking(true);
      await simulateBreak(apiUrl, app.appId);
      showToast(`Synthetic incident triggered for ${app.appId}`, "ok");
      const now = Date.now();
      breakClickedAtRef.current = now;
      saveBreakClickedAt(app.appId, now);
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
