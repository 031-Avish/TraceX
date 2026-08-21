// src/utils/sanitizer.js
// Strips PII and sensitive tokens from observability data before sending to LLM.
// This is a security-critical module — every piece of data passes through here.

const PII_PATTERNS = [
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL_REDACTED]" },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "[IP_REDACTED]" },
  // Requires separators (dash/dot/space) so it doesn't collide with plain digit
  // sequences that show up constantly in this domain — counts, revisions, ports.
  { pattern: /\b(?:\+?\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, replacement: "[PHONE_REDACTED]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[AWS_KEY_REDACTED]" },
  { pattern: /(?:aws_secret_access_key|aws_session_token)["\s:=]+["']?([a-zA-Z0-9/+=]{20,})["']?/gi, replacement: "[AWS_SECRET_REDACTED]" },
  { pattern: /(?:api[_-]?key|token|secret|password|passwd|authorization)["\s:=]+["']?([a-zA-Z0-9_\-\.]{16,})["']?/gi, replacement: "[TOKEN_REDACTED]" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN_REDACTED]" },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: "[CARD_REDACTED]" },
  { pattern: /\b[A-Z]{2}\d{2}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/g, replacement: "[IBAN_REDACTED]" },
];

function sanitize(text) {
  if (text === null || text === undefined) return "";
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(text);
    } catch {
      return "[UNSERIALIZABLE_DATA]";
    }
  }

  for (const { pattern, replacement } of PII_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    text = text.replace(pattern, replacement);
  }

  return text;
}

function sanitizeObject(obj) {
  if (typeof obj === "string") return sanitize(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj && typeof obj === "object") {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = sanitizeObject(value);
    }
    return cleaned;
  }
  return obj;
}

module.exports = { sanitize, sanitizeObject };
