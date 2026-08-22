import React from "react";

// A consistent, honest "nothing here yet" treatment — an icon, a short
// explanation, and a real call-to-action. No fabricated placeholder data.
export default function EmptyState({ icon, title, message, actionLabel, onAction }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{message}</p>
      {actionLabel && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
