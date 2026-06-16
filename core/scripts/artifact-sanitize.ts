// Write-time injection denylist and secret-value redaction for machine-readable
// run artifacts (#161).
//
// Two separate passes are applied before persisting to disk:
//  1. Secret-value redaction — replaces token formats and env-var secret values
//     with [REDACTED] so credentials are never stored in run-dir artifacts.
//  2. Injection denylist — replaces prompt-injection phrases with
//     [REDACTED-INJECTION] so replayed artifact lines cannot hijack a later agent.

/** Imperative phrase patterns that indicate a prompt-injection attempt. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(previous|prior|above|all)\s+instructions?/gi,
  /you\s+are\s+now\b/gi,
  /\bdisregard\s+(the\s+)?(above|all|previous|prior|following)\b/gi,
  /\bsystem\s*:/gi,
  /forget\s+(everything|all|previous|prior|the\s+above)/gi,
  /act\s+as\s+if\b/gi,
  /you\s+must\s+now\b/gi,
  /override\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  // Model control tokens (ChatML / OpenAI special tokens that inject chat-role framing)
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  // Line-start role markers that inject chat-role syntax when an artifact is replayed
  /^assistant\s*:/gim,
];

/** Token / credential format patterns — matched without env dependency. */
const SECRET_VALUE_RE =
  /(ghp|ghs|gho|ghr|github_pat)_[A-Za-z0-9_]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}/g;

/** Env-var names whose values are treated as secrets. */
const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|_PASS$|_KEY$/i;

/**
 * Replace known secret patterns (token formats + env-var secret values) with
 * `[REDACTED]`.  Applied to serialized artifact content before writing so raw
 * credentials can never reach a run-dir file.  Pure for token-format matching;
 * reads `process.env` for env-var value scrubbing.
 */
export function redactSecrets(text: string): string {
  let result = text.replace(SECRET_VALUE_RE, "[REDACTED]");
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_NAME_RE.test(name)) {
      result = result.split(value).join("[REDACTED]");
    }
  }
  // Redact inline env-var assignments whose name matches the secret pattern,
  // even when the value is not present in process.env (e.g. OPENAI_API_KEY=xyz cmd).
  // Handles unquoted, double-quoted, and single-quoted values so that
  // OPENAI_API_KEY="secret" cmd and OPENAI_API_KEY='secret' cmd are also redacted.
  result = result.replace(
    /\b([A-Z][A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`,;)\\]+)/g,
    (full, name) => (SECRET_NAME_RE.test(name) ? `${name}=[REDACTED]` : full),
  );
  return result;
}

/**
 * Apply the injection denylist to `content`.  Every span that matches a
 * denylist pattern is replaced with `[REDACTED-INJECTION]`.  Clean strings
 * are returned unchanged.  The function is pure and has no side effects.
 */
export function sanitize(content: string): string {
  let result = content;
  for (const pattern of INJECTION_PATTERNS) {
    result = result.replace(pattern, "[REDACTED-INJECTION]");
  }
  return result;
}

/**
 * Recursively sanitize every string leaf of a JSON-serializable value, applying
 * `sanitize(redactSecrets(...))` at the FIELD level (before serialization). This
 * is the correct chokepoint for artifacts built by `JSON.stringify`: a secret or
 * role-marker inside a string field is escaped by stringify (`KEY="x"` →
 * `KEY=\"x\"`, a leading `assistant:` line → `...\nassistant:` on one JSON line),
 * which defeats the raw-text patterns when they only run on the serialized
 * output. Sanitizing the values first lets the patterns see the unescaped
 * content (#161). Returns a structurally-identical copy; arrays and plain
 * objects are recursed, every other value passes through unchanged.
 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") {
    return sanitize(redactSecrets(value)) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as T;
  }
  return value;
}
