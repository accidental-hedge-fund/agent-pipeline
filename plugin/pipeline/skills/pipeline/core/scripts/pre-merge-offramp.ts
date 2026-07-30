// Pre-merge off-ramp classification (#683).
//
// Closed operator-facing reason classes for pre-merge blocked / needs-human
// off-ramps. Distinct from HumanInterventionKind (factory-debt taxonomy) and
// DurableBlockerClass (durable-loop recovery). Pure mapper only — no I/O.

import { type BlockerKind } from "./types.ts";

/** Closed set of pre-merge off-ramp classes for scoreboard aggregation. */
export const PRE_MERGE_OFFRAMP_CLASSES = [
  "ci-failed",
  "delta-review",
  "merge-conflict",
  "openspec-invalid",
  "openspec-stale-delta",
  "other",
] as const;

export type PreMergeOfframpClass = (typeof PRE_MERGE_OFFRAMP_CLASSES)[number];

/**
 * Optional path tag when `BlockerKind` alone is too coarse (e.g. CI failure and
 * delta-review both historically used `needs-human` for the recipe surface).
 * Values that are themselves `PreMergeOfframpClass` members (except residual
 * `other`) take precedence over kind mapping.
 */
export type PreMergeOfframpPathTag = Exclude<PreMergeOfframpClass, "other">;

const CLASS_SET: ReadonlySet<string> = new Set(PRE_MERGE_OFFRAMP_CLASSES);

/** True when `value` is a member of the closed PreMergeOfframpClass set. */
export function isPreMergeOfframpClass(value: unknown): value is PreMergeOfframpClass {
  return typeof value === "string" && CLASS_SET.has(value);
}

export interface ToPreMergeOfframpClassInput {
  /** Structural blocker kind from setBlocked / StageResult, when known. */
  blockerKind?: string | null;
  /**
   * Explicit pre-merge path tag (ci-failed, delta-review, …). Wins over kind
   * when it is a non-residual closed class.
   */
  pathTag?: string | null;
}

/**
 * Pure total mapper: BlockerKind and/or path tag → exactly one closed class.
 * Unknown/missing inputs resolve to `other`. No I/O, no free-text parsing.
 */
export function toPreMergeOfframpClass(input: ToPreMergeOfframpClassInput = {}): PreMergeOfframpClass {
  const tag = input.pathTag;
  if (typeof tag === "string" && tag !== "other" && isPreMergeOfframpClass(tag)) {
    return tag;
  }

  switch (input.blockerKind as BlockerKind | string | null | undefined) {
    case "merge-conflict":
      return "merge-conflict";
    case "openspec-invalid":
      return "openspec-invalid";
    case "openspec-stale-delta":
      return "openspec-stale-delta";
    case "test-gate-exhausted":
    case "build-failed":
    case "ci-exhausted":
      // Local test/build exhaustion and post-#679 CI recovery exhaustion map to ci-failed.
      return "ci-failed";
    default:
      return "other";
  }
}

/** Zero-initialized by-class count map covering the full closed set. */
export function zeroPreMergeOfframpClassCounts(): Record<PreMergeOfframpClass, number> {
  const out = {} as Record<PreMergeOfframpClass, number>;
  for (const c of PRE_MERGE_OFFRAMP_CLASSES) {
    out[c] = 0;
  }
  return out;
}
