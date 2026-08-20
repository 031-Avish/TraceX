// src/api.js
// Thin fetch wrapper around the connector config API (lambda-config-api/).

export class ApiError extends Error {}

async function request(apiUrl, path, options = {}) {
  if (!apiUrl) throw new ApiError("Set the Config API URL in Settings first");
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(`${res.status}: ${body || res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

export const listConnectors = (apiUrl, tenantId) =>
  request(apiUrl, `/connectors?tenantId=${encodeURIComponent(tenantId)}`);

export const saveConnector = (apiUrl, tenantId, type, config) =>
  request(apiUrl, `/connectors`, { method: "PUT", body: JSON.stringify({ tenantId, type, config }) });

export const deleteConnector = (apiUrl, tenantId, type) =>
  request(apiUrl, `/connectors/${encodeURIComponent(type)}?tenantId=${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
  });

export const listApplications = (apiUrl, tenantId) =>
  request(apiUrl, `/applications?tenantId=${encodeURIComponent(tenantId)}`);

export const saveApplication = (apiUrl, tenantId, appId, config) =>
  request(apiUrl, `/applications`, { method: "PUT", body: JSON.stringify({ tenantId, appId, config }) });

export const deleteApplication = (apiUrl, tenantId, appId) =>
  request(apiUrl, `/applications/${encodeURIComponent(appId)}?tenantId=${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
  });
