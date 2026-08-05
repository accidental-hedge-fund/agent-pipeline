// Outer-host identity in run evidence (#784).
//
// Outer-host id is recorded separately from implementer/reviewer treatment
// (adapter) identity. Never invent outer-host id from adapter id, model, or
// provider.

/** Explicit unknown sentinel when the launching outer host cannot be determined. */
export const OUTER_HOST_UNKNOWN = "unknown" as const;

export type OuterHostEvidenceId = string | typeof OUTER_HOST_UNKNOWN;

export interface OuterHostEvidenceFields {
  /**
   * Outer-host id when known; omit or set to "unknown" when undetermined.
   * Never equalized with implementer/reviewer adapter ids.
   */
  outer_host?: OuterHostEvidenceId;
}

export interface ResolveOuterHostEvidenceInput {
  /**
   * Explicit outer-host id from the launcher (e.g. env PIPELINE_OUTER_HOST or
   * skill-declared host). Prefer this when present.
   */
  explicit?: string | null;
  /**
   * Optional registered-id allowlist / registry lookup. When provided, unknown
   * ids that are not registered are treated as unknown rather than invented.
   */
  isRegistered?: (id: string) => boolean;
  /**
   * Implementer adapter id — used only to refuse silent copy; never returned
   * as outer_host when explicit is missing.
   */
  implementerAdapterId?: string | null;
  reviewerAdapterId?: string | null;
}

/**
 * Resolve the outer-host evidence field.
 *
 * - Uses explicit id when non-empty (and registered when a checker is given).
 * - When undetermined, returns "unknown" — never the implementer adapter id.
 */
export function resolveOuterHostEvidence(
  input: ResolveOuterHostEvidenceInput = {},
): OuterHostEvidenceId {
  const raw = typeof input.explicit === "string" ? input.explicit.trim() : "";
  if (raw) {
    if (input.isRegistered && !input.isRegistered(raw)) {
      return OUTER_HOST_UNKNOWN;
    }
    return raw;
  }
  // Deliberately do not fall back to implementerAdapterId / reviewerAdapterId.
  return OUTER_HOST_UNKNOWN;
}

/**
 * Build evidence payload fields. When outer host is unknown, still emit
 * outer_host: "unknown" so readers can distinguish "not recorded" from
 * older pre-#784 events (which omit the field entirely at the event layer).
 */
export function outerHostEvidenceFields(
  input: ResolveOuterHostEvidenceInput = {},
): OuterHostEvidenceFields {
  return { outer_host: resolveOuterHostEvidence(input) };
}

/**
 * Read PIPELINE_OUTER_HOST from an env map (injectable — no process.env in tests).
 */
export function readOuterHostFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const v = env.PIPELINE_OUTER_HOST;
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}
