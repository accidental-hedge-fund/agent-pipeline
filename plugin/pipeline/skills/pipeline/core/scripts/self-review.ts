// Same-harness self-review fallback (#39).
//
// The pipeline's value is cross-harness review: one harness implements, the
// *other* reviews it. But if the configured reviewer CLI is not installed or
// not spawnable, the review step would otherwise hard-block and stall the item.
// This module degrades — once, at the reviewer-invoke seam shared by every
// review round (plan-review, review-1, review-2) — to a review performed by the
// implementing harness, clearly labeled so a self-review is never mistaken for
// an independent cross-harness one.
//
// Trigger is precise: only a `spawn_error` (the CLI could not be spawned at all,
// see harness.ts) falls back. A reviewer that ran but timed out or exited
// nonzero is a genuine failure and is returned as-is for the caller to block on.

import { invoke, type HarnessResult, type InvokeOptions } from "./harness.ts";
import type { Harness } from "./types.ts";

export interface ReviewerInvocation {
  /** The harness result to gate on (from the effective reviewer). */
  result: HarnessResult;
  /** The harness that actually produced this review — the fallback when selfReview.
   *  A `string` because the configured reviewer may be a custom CLI (#40); on a
   *  self-review it is the implementing harness (always a built-in `Harness`). */
  effectiveReviewer: string;
  /** True when the configured cross-harness reviewer was unavailable and the
   *  implementing harness reviewed its own work instead. */
  selfReview: boolean;
}

/**
 * Invoke the configured cross-harness reviewer. If its CLI is not installed /
 * not spawnable (`spawn_error`) and a *different* implementing harness is
 * configured, re-run the same review prompt on the implementer as a same-harness
 * self-review (#39).
 *
 * Not a fallback (the configured reviewer's result is returned verbatim):
 *  - the reviewer ran but timed out or exited nonzero (genuine failure → block),
 *  - the reviewer === implementer (no independent harness to fall back to; if it
 *    spawn-fails, the caller blocks — a self-review by the same missing CLI is
 *    impossible and pointless).
 *
 * When the fallback is also unusable — it failed (spawn_error, nonzero exit, or
 * timeout) OR it exited 0 with no usable review output — the result is marked
 * unsuccessful with both harnesses' stderr merged, so the caller's existing
 * `!result.success` branch surfaces both failures and names the missing reviewer.
 *
 * `reviewer` may be a custom reviewer CLI (`review_harness`, #40) or a built-in
 * harness; `implementer` is always a built-in `Harness` (the self-review
 * fallback target). `inv` is injectable so unit tests exercise every branch
 * without spawning.
 */
export async function invokeReviewer(
  reviewer: string,
  implementer: Harness,
  worktreeDir: string,
  prompt: string,
  opts: InvokeOptions = {},
  inv: typeof invoke = invoke,
): Promise<ReviewerInvocation> {
  const result = await inv(reviewer, worktreeDir, prompt, opts);
  if (result.spawn_error && reviewer !== implementer) {
    const configuredReviewerStderr = result.stderr;
    const fallback = await inv(implementer, worktreeDir, prompt, opts);
    // A self-review that produces no usable review output is not a usable review.
    // Treat an exit-0-but-empty fallback as unusable too — alongside spawn_error,
    // nonzero exit, and timeout — so callers' `!result.success` branch blocks with a
    // message that names BOTH harnesses and surfaces the configured reviewer's error,
    // instead of the review-round path degrading to a generic "no reviewer output"
    // block that never mentions the missing configured reviewer (#40 finding 61f38f28).
    const fallbackUsable = fallback.success && fallback.stdout.trim() !== "";
    if (!fallbackUsable) {
      const mergedStderr = [configuredReviewerStderr, fallback.stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
      return {
        result: { ...fallback, success: false, stderr: mergedStderr },
        effectiveReviewer: implementer,
        selfReview: true,
      };
    }
    return { result: fallback, effectiveReviewer: implementer, selfReview: true };
  }
  return { result, effectiveReviewer: reviewer, selfReview: false };
}

/**
 * The disclosure banner prepended to a self-review's posted comment. Single
 * source of wording so plan-review and the standard/adversarial rounds read
 * identically. Visibly distinct from a normal cross-harness review.
 */
export function selfReviewBanner(configuredReviewer: string, effectiveReviewer: string): string {
  return (
    `> ⚠️ **Same-harness self-review (#39).** The cross-harness reviewer ` +
    `\`${configuredReviewer}\` is not installed / not spawnable, so this review was ` +
    `performed by the implementing harness \`${effectiveReviewer}\` reviewing its own ` +
    `work. A same-harness review is weaker than an independent cross-harness review — ` +
    `weigh it accordingly.`
  );
}
