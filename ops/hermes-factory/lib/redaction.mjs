const SECRET_KEY = /(secret|token|password|credential|private[_-]?key|prompt|stdout|stderr|raw[_-]?output|environment|env_values?)/i;
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/gi,
  /\bncryptsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/gi,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
];

export function secretValuesFromEnv(names, env = process.env) {
  const values = [];
  for (const name of names ?? []) {
    const value = env[name];
    if (typeof value === "string" && value.length >= 4) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function redactText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return text;
}

export function redactValue(value, secrets = [], depth = 0) {
  if (depth > 8) return "[REDACTED:DEPTH]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value, secrets).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactValue(entry, secrets, depth + 1));
  if (typeof value !== "object") return String(value);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(entry, secrets, depth + 1);
  }
  return out;
}

export function assertNoSecret(value, secrets = []) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) throw new Error("redaction failure: secret canary remains");
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new Error("redaction failure: token-like value remains");
    pattern.lastIndex = 0;
  }
}

export function safeErrorMessage(error, secrets = []) {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, secrets).replace(/[\r\n]+/g, " ").slice(0, 500);
}
