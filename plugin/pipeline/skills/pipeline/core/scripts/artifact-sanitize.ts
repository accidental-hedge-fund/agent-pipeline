// Write-time injection denylist for machine-readable run artifacts (#161).
//
// Applied to serialized JSON content before persisting to disk so a replayed
// artifact line cannot inject instructions into a later agent's context.
// Matching spans are replaced with [REDACTED-INJECTION] — the record is
// written with the substitution in place, never silently dropped.

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
];

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
