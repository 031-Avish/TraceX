import React from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { ConfigProvider, useConfig } from "./context/ConfigContext.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import ConnectorsPage from "./pages/ConnectorsPage.jsx";
import ApplicationsPage from "./pages/ApplicationsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

function TopBar() {
  const { tenantId } = useConfig();
  return (
    <header className="topbar">
      <div className="brand">🧭 TraceX Console</div>
      <nav>
        <NavLink to="/" end>
          Overview
        </NavLink>
        <NavLink to="/connectors">Connectors</NavLink>
        <NavLink to="/applications">Applications</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <div className="tenant-pill">
        tenant: <code>{tenantId}</code>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <ConfigProvider>
      <ToastProvider>
        <BrowserRouter>
          <div className="shell">
            <TopBar />
            <main>
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/connectors" element={<ConnectorsPage />} />
                <Route path="/applications" element={<ApplicationsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </div>
        </BrowserRouter>
      </ToastProvider>
    </ConfigProvider>
  );
}
