import React, { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

// null = follow system preference (prefers-color-scheme), no explicit choice made yet.
// "light" / "dark" = explicit user override, persisted and wins regardless of system pref.
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem("tracex_theme") || null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) {
      root.setAttribute("data-theme", theme);
      localStorage.setItem("tracex_theme", theme);
    } else {
      root.removeAttribute("data-theme");
      localStorage.removeItem("tracex_theme");
    }
  }, [theme]);

  const toggleTheme = () => {
    const systemPrefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const currentlyDark = theme ? theme === "dark" : systemPrefersDark;
    setTheme(currentlyDark ? "light" : "dark");
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
