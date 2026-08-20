import React from "react";
import { useConfig } from "../context/ConfigContext.jsx";

export default function SettingsPage() {
  const { apiUrl, setApiUrl, tenantId, setTenantId } = useConfig();

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <h2 className="section-title">Settings</h2>
      <div className="field">
        <label>Config API URL</label>
        <input
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://xxxxx.execute-api.us-east-1.amazonaws.com"
        />
      </div>
      <div className="field">
        <label>Tenant ID</label>
        <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="demo" />
      </div>
      <p className="hint">
        Saved locally in your browser only — nothing here goes through the config API. The API URL
        comes from the <code>config_api_url</code> Terraform output after <code>./deploy.sh</code>.
        The triage agent reads config for <code>TENANT_ID</code> env var on the Lambda (defaults to{" "}
        <code>demo</code>), so this should usually match that.
      </p>
    </div>
  );
}
