// Claude model entitlement detection and auto-reviewer fallback (#870).
//
// Config-load adversarial `auto` still prefers `claude-fable-5`. On a Claude
// subscription without separately purchased Fable usage credits, that model
// fails immediately with an entitlement-specific HTTP 429 before any tokens
// are consumed. Claude CLI `--fallback-model` does not recover from this
// class. This module owns the closed detection patterns and the allowlisted
// single-retry subscription model for auto-sourced Claude reviewers only.

import type { HarnessResult } from "./harness.ts";
import type { StageDiagnosticReasonCode } from "./stage-diagnostic.ts";

/** Allowlisted subscription-backed Claude model used for one auto-only retry. */
export const AUTO_ENTITLEMENT_FALLBACK_MODEL = "sonnet";

/**
 * Closed phrase set for the Fable / usage-credit entitlement class observed on
 * Claude Code. Matching is case-insensitive over concatenated stdout+stderr.
 * Bare HTTP 429 or ordinary rate-limit text alone is NOT enough — that remains
 * ordinary throttle (see {@link isClaudeModelEntitlementFailure}).
 */
const ENTITLEMENT_PHRASES = [
  "requires usage credits",
  "/usage-credits",
  "usage credits",
  "fable 5 requires usage credits",
  "fable requires usage credits",
] as const;

/**
 * True when harness output is the Fable/usage-credit entitlement refusal.
 * Distinguishes from ordinary transient throttle (`rate_limit_event` / generic
 * rate-limit wording without entitlement phrases).
 */
export function isClaudeModelEntitlementFailure(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  signals?: Pick<HarnessResult, "exit_code" | "throttled" | "success"> | null,
): boolean {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`.toLowerCase();
  if (!text.trim()) return false;
  const hasEntitlementPhrase = ENTITLEMENT_PHRASES.some((p) => text.includes(p));
  if (!hasEntitlementPhrase) return false;
  // Entitlement message is the signal; optional 429 / throttle / non-zero exit
  // reinforce but are not required when the closed phrase is present (zero-token
  // CLI paths may omit structured throttle flags).
  void signals;
  return true;
}

/**
 * Classify a harness result for reviewer durable projection. Prefer entitlement
 * over bare `throttled` so a zero-token Fable 429 with `throttled: true` is not
 * mis-routed as ordinary rate-limit recovery that still rewrites models.
 */
export function classifyReviewerHarnessFailure(
  result: Pick<
    HarnessResult,
    "stdout" | "stderr" | "exit_code" | "throttled" | "success" | "timed_out" | "spawn_error" | "capture_error" | "oversize_argv" | "stdin_error"
  > & { code?: number | null },
): StageDiagnosticReasonCode {
  if (isClaudeModelEntitlementFailure(result.stdout, result.stderr, result)) {
    return "model-entitlement-required";
  }
  if (result.throttled) return "transient-infra";
  if (result.timed_out) return "harness-timeout";
  if (result.oversize_argv || result.stdin_error || result.capture_error) {
    return "harness-contract";
  }
  if (result.spawn_error) return "harness-contract";
  // Prefer structured exit_code (HarnessResult); accept legacy `code` for
  // classifyHarnessFailure-shaped inputs.
  const exitCode =
    typeof result.exit_code === "number"
      ? result.exit_code
      : typeof result.code === "number"
        ? result.code
        : null;
  if (exitCode !== null && exitCode !== 0) return "harness-contract";
  return "workflow-engine-defect";
}

/**
 * Whether an auto-sourced Claude reviewer attempt is eligible for the single
 * allowlisted subscription-model retry after an entitlement failure.
 */
export function shouldRetryAutoEntitlementFallback(input: {
  reviewerHarness: string;
  modelWasAuto: boolean;
  preferredModel: string | undefined;
  result: Pick<HarnessResult, "stdout" | "stderr" | "exit_code" | "throttled" | "success">;
}): boolean {
  if (!input.modelWasAuto) return false;
  if (input.reviewerHarness !== "claude") return false;
  if (input.result.success) return false;
  return isClaudeModelEntitlementFailure(input.result.stdout, input.result.stderr, input.result);
}
