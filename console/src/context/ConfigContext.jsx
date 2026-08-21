import React, { createContext, useContext, useEffect, useState } from "react";

const ConfigContext = createContext(null);

export function ConfigProvider({ children }) {
  // Terraform bakes the deployed config API URL in at build time (VITE_CONFIG_API_URL)
  // so the hosted console works out of the box — localStorage still wins if the user
  // has explicitly overridden it (e.g. pointing at a different environment).
  const [apiUrl, setApiUrl] = useState(
    () => localStorage.getItem("tracex_api_url") || import.meta.env.VITE_CONFIG_API_URL || ""
  );
  const [tenantId, setTenantId] = useState(() => localStorage.getItem("tracex_tenant_id") || "demo");

  useEffect(() => {
    localStorage.setItem("tracex_api_url", apiUrl);
  }, [apiUrl]);

  useEffect(() => {
    localStorage.setItem("tracex_tenant_id", tenantId);
  }, [tenantId]);

  return (
    <ConfigContext.Provider value={{ apiUrl, setApiUrl, tenantId, setTenantId }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
  return ctx;
}
