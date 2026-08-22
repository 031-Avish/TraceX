import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useConfig } from "../context/ConfigContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { deleteConnector, listConnectors, saveConnector, testConnector } from "../api.js";
import { blankConfig, CONNECTOR_CATALOG } from "../connectors.js";

export default function ConnectorsPage() {
  const { apiUrl, tenantId } = useConfig();
  const showToast = useToast();
  const [connectors, setConnectors] = useState([]);
  const [selectedType, setSelectedType] = useState(null);
  const [form, setForm] = useState({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const selected = useMemo(() => CONNECTOR_CATALOG.find((item) => item.type === selectedType), [selectedType]);
  const isInfra = selected?.authMode === "lambda-iam-role";

  const load = useCallback(() => {
    if (!apiUrl) return;
    listConnectors(apiUrl, tenantId)
      .then(({ connectors }) => setConnectors(connectors))
      .catch((e) => showToast(e.message, "error"));
  }, [apiUrl, tenantId, showToast]);
  useEffect(() => {
    load();
  }, [load]);

  const open = (definition) => {
    if (!definition.available) return;
    const existing = connectors.find((item) => item.type === definition.type);
    setSelectedType(definition.type);
    setForm({ ...blankConfig(definition), ...(existing?.config || {}) });
    setTestResult(null);
  };
  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTestResult(null);
  };

  const test = async () => {
    try {
      setTesting(true);
      const result = await testConnector(apiUrl, tenantId, selected.type, form);
      setTestResult(result);
      showToast(`${selected.name} connection verified`, "ok");
    } catch (error) {
      setTestResult({ ok: false, error: error.message });
      showToast(error.message, "error");
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!testResult?.ok) return showToast("Test the connection successfully before saving", "error");
    try {
      setSaving(true);
      await saveConnector(apiUrl, tenantId, selected.type, {
        ...form,
        lastTestStatus: "healthy",
        lastTestedAt: testResult.testedAt,
        lastTestLatencyMs: testResult.latencyMs,
      });
      showToast(isInfra ? `${selected.name} settings saved` : `${selected.name} connected`, "ok");
      setSelectedType(null);
      load();
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    const prompt = isInfra
      ? `Reset ${selected.name} region settings back to defaults? This does not disable observability — the agent still uses its IAM role.`
      : `Disconnect ${selected.name}? Applications using it will fall back to CloudWatch.`;
    if (!window.confirm(prompt)) return;
    try {
      await deleteConnector(apiUrl, tenantId, selected.type);
      setSelectedType(null);
      load();
      showToast(isInfra ? `${selected.name} settings reset` : `${selected.name} disconnected`, "ok");
    } catch (error) {
      showToast(error.message, "error");
    }
  };

  if (!apiUrl) return <div className="panel">Set the Config API URL in Settings first.</div>;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Integrations</h1>
          <p>Connect the tools TraceX can use during an investigation.</p>
        </div>
        <span className="connection-count">{connectors.length} connected</span>
      </div>

      {selected ? (
        <div className="connector-setup">
          <button className="back-button" onClick={() => setSelectedType(null)}>
            ← All integrations
          </button>
          <div className="setup-header">
            <span className="provider-icon large">{selected.icon}</span>
            <div>
              <h2>{isInfra ? selected.name : `Connect ${selected.name}`}</h2>
              <p>{selected.description}</p>
            </div>
          </div>

          {isInfra && (
            <div className="infra-callout">
              <span className="infra-callout-icon">🔒</span>
              <div>
                <strong>Always on — no credentials needed.</strong>
                <p>
                  This connects via the agent's own AWS IAM execution role, not a stored secret. It's active by
                  default for every application, including the downstream-dependency demo scenario, whether or not
                  you save anything below. The fields here only let you document a region or a cross-account role
                  ARN for a production deployment — there's nothing to "connect".
                </p>
              </div>
            </div>
          )}

          <div className="setup-form">
            {(selected.fields || []).map((field) => (
              <div className="field" key={field.key}>
                <label>
                  {field.label}
                  {field.secret && connectors.some((c) => c.type === selected.type) ? " (leave blank to keep existing)" : ""}
                </label>
                {field.type === "select" ? (
                  <select value={form[field.key] || ""} onChange={(e) => update(field.key, e.target.value)}>
                    {field.options.map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type || "text"}
                    value={form[field.key] || ""}
                    placeholder={field.placeholder || ""}
                    onChange={(e) => update(field.key, e.target.value)}
                  />
                )}
              </div>
            ))}
            {testResult && (
              <div className={`test-result ${testResult.ok ? "success" : "failure"}`}>
                {testResult.ok ? `Connection verified in ${testResult.latencyMs} ms` : testResult.error}
              </div>
            )}
            <div className="setup-actions">
              <button className="secondary" onClick={test} disabled={testing}>
                {testing ? "Testing…" : isInfra ? "Validate settings" : "Test connection"}
              </button>
              <button onClick={save} disabled={saving || !testResult?.ok}>
                {saving ? "Saving…" : isInfra ? "Save settings" : "Save connection"}
              </button>
              {connectors.some((c) => c.type === selected.type) && (
                <button className="danger push-right" onClick={disconnect}>
                  {isInfra ? "Reset to defaults" : "Disconnect"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {["Observability", "Code", "Notifications"].map((category) => (
            <section className="catalog-section" key={category}>
              <h2 className="section-title">{category}</h2>
              <div className="connector-grid">
                {CONNECTOR_CATALOG.filter((item) => item.category === category).map((item) => {
                  const connection = connectors.find((current) => current.type === item.type);
                  const itemIsInfra = item.authMode === "lambda-iam-role";
                  return (
                    <button
                      className={`connector-tile ${!item.available ? "unavailable" : ""} ${itemIsInfra ? "infra" : ""}`}
                      key={item.type}
                      onClick={() => open(item)}
                    >
                      <span className="provider-icon">{item.icon}</span>
                      <span className="tile-copy">
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                        {itemIsInfra && <span className="infra-badge">🔒 via agent IAM role · no credentials needed</span>}
                      </span>
                      {itemIsInfra ? (
                        <span className="badge always-on">Always on</span>
                      ) : (
                        <span className={`badge ${connection ? "connected" : "not-connected"}`}>
                          {connection ? "Connected" : item.available ? "Connect" : "Coming soon"}
                        </span>
                      )}
                      {connection?.config?.lastTestedAt && (
                        <span className="last-tested">Tested {new Date(connection.config.lastTestedAt).toLocaleString()}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
