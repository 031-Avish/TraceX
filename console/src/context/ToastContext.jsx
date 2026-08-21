import React, { createContext, useCallback, useContext, useState } from "react";

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, kind = "ok") => {
    const id = Date.now();
    setToast({ id, message, kind });
    setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current));
    }, 2800);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {toast && <div className={`toast show ${toast.kind}`}>{toast.message}</div>}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
