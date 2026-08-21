import React, { createContext, useContext, useEffect, useState } from "react";

const ConfigContext = createContext(null);

export function ConfigProvider({ children }) {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem("tracex_api_url") || "");
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
