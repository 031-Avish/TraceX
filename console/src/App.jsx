import React from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { ConfigProvider, useConfig } from "./context/ConfigContext.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { ConfirmProvider } from "./context/ConfirmContext.jsx";
import { ThemeProvider, useTheme } from "./context/ThemeContext.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import ConnectorsPage from "./pages/ConnectorsPage.jsx";
import ApplicationsPage from "./pages/ApplicationsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

const NAV_ITEMS = [
  { to: "/", end: true, icon: "◱", label: "Overview" },
  { to: "/connectors", icon: "◈", label: "Integrations" },
  { to: "/applications", icon: "▤", label: "Applications" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const systemPrefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const isDark = theme ? theme === "dark" : systemPrefersDark;
  return (
    <button
      className="secondary icon-only"
      onClick={toggleTheme}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle color theme"
    >
      {isDark ? "☀" : "☾"}
    </button>
  );
}

function TopBar() {
  const { apiUrl, tenantId } = useConfig();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">🧭</span>
        TraceX
      </div>
      <nav>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="topbar-right">
        <div className="tenant-pill">
          <span className="status-dot" style={{ background: apiUrl ? "var(--success)" : "var(--text-tertiary)" }} />
          tenant: <code>{tenantId}</code>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ConfigProvider>
        <ToastProvider>
          <ConfirmProvider>
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
          </ConfirmProvider>
        </ToastProvider>
      </ConfigProvider>
    </ThemeProvider>
  );
}
