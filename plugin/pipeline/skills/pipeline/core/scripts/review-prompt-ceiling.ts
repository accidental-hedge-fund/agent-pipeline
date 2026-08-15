// Review-path character ceiling preflight (#1054).
//
// Codex (and similar model APIs) reject inputs above a hard character limit
// even when the adapter declares maxPromptBytes: "unlimited" for stdin delivery.
// This module is pure: resolve ceiling + check assembled prompt character length
// before any reviewer harness / ensemble / stage-executor spawn.

import {
  isFiniteMaxPromptBytes,
  type MaxPromptBytes,
} from "./harness-adapters/types.ts";

/**
 * Codex API input character ceiling used when the configured reviewer has no
 * finite declared maximum (missing, unlimited, or unknown).
 */
export const DEFAULT_REVIEW_PROMPT_CHAR_CEILING = 1_048_576;

/**
 * Resolve the effective review prompt character ceiling.
 *
 * Prefer the configured reviewer's declared finite max (maxPromptBytes when
 * finite). Otherwise fall back to {@link DEFAULT_REVIEW_PROMPT_CHAR_CEILING}.
 *
 * Finite byte caps (e.g. argv limits) are treated as the same integer domain as
 * character counts for this gate — they are strictly tighter than the Codex
 * default for typical ASCII-heavy pipeline prompts.
 */
export function resolveReviewPromptCharCeiling(
  declaredMax: MaxPromptBytes | undefined | null,
): number {
  if (isFiniteMaxPromptBytes(declaredMax)) return declaredMax;
  return DEFAULT_REVIEW_PROMPT_CHAR_CEILING;
}

export type ReviewPromptSizeOk = { ok: true; measured: number; ceiling: number };
export type ReviewPromptSizeOver = {
  ok: false;
  measured: number;
  ceiling: number;
};
export type ReviewPromptSizeCheck = ReviewPromptSizeOk | ReviewPromptSizeOver;

/**
 * Character-length preflight for a fully assembled review prompt.
 * Refuses when `measured` is strictly greater than `ceiling`.
 */
export function checkReviewPromptSize(
  prompt: string,
  ceiling: number,
): ReviewPromptSizeCheck {
  const measured = prompt.length;
  if (measured > ceiling) {
    return { ok: false, measured, ceiling };
  }
  return { ok: true, measured, ceiling };
}

/** Operator-facing reason including measured size and ceiling. */
export function formatReviewPromptTooLargeReason(
  round: 1 | 2,
  measured: number,
  ceiling: number,
): string {
  return (
    `Assembled review prompt for review-${round} exceeds the reviewer input ` +
    `character ceiling (measured=${measured}, ceiling=${ceiling}). ` +
    `Re-running without reducing the assembled prompt or changing the ` +
    `reviewer/ceiling configuration will fail again.`
  );
}
