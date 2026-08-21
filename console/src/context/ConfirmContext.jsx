import React, { createContext, useCallback, useContext, useRef, useState } from "react";

const ConfirmContext = createContext(null);

// Promise-based replacement for window.confirm — same call shape (await it,
// get a boolean back) but themed to match the rest of the console instead of
// a native browser dialog.
export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setDialog({ message, ...opts });
    });
  }, []);

  const settle = (result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setDialog(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <div className="modal-overlay" onClick={() => settle(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            {dialog.title && <h3>{dialog.title}</h3>}
            <p>{dialog.message}</p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => settle(false)}>
                Cancel
              </button>
              <button className={dialog.danger ? "danger" : ""} onClick={() => settle(true)}>
                {dialog.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx;
}
