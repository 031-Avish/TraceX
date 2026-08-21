import React from "react";
import { useConfig } from "../context/ConfigContext.jsx";

export default function SettingsPage() {
  const { apiUrl, setApiUrl, tenantId, setTenantId } = useConfig();

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Saved locally in your browser only — nothing here goes through the config API.</p>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 520 }}>
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
          The API URL comes from the <code>config_api_url</code> Terraform output after <code>./deploy.sh</code>. The
          triage agent reads config for the <code>TENANT_ID</code> env var on the Lambda (defaults to{" "}
          <code>demo</code>), so this should usually match that.
        </p>
      </div>
    </div>
  );
}
