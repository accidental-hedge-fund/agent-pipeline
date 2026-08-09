// Mechanical escalation classifiers (#760).
//
// Derive pipeline/stage-diagnostic@1 reason codes from structured HarnessResult
// flags and gh error shapes — never free-form prose as the primary signal.

import { isTransientGhError } from "./gh.ts";
import type { HarnessResult } from "./harness.ts";
import {
  isClaudeModelEntitlementFailure,
  classifyReviewerHarnessFailure,
} from "./model-entitlement.ts";
import {
  projectPipelineReasonCode,
  type StageDiagnosticReasonCode,
} from "./stage-diagnostic.ts";
import type { DurableBlockerClass } from "./loop/types.ts";
import type { HumanInterventionKind } from "./intervention.ts";
import type { PreMergeOfframpClass } from "./pre-merge-offramp.ts";
import type { BlockerKind } from "./types.ts";

/** Structured harness classification input (subset of HarnessResult flags). */
export interface HarnessFailureSignals {
  timed_out?: boolean;
  spawn_error?: boolean;
  capture_error?: boolean;
  oversize_argv?: boolean;
  stdin_error?: boolean;
  throttled?: boolean;
  code?: number | null;
  /** Optional product text for entitlement detection (#870). */
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  success?: boolean;
}

/**
 * Classify a harness result into a closed stage-diagnostic reason code using
 * structured flags. When stdout/stderr are present, Fable/usage-credit
 * entitlement refusals project to `model-entitlement-required` (#870) rather
 * than ordinary throttle or workflow-engine-defect.
 */
export function classifyHarnessFailure(
  result: HarnessFailureSignals | Pick<
    HarnessResult,
    "timed_out" | "spawn_error" | "capture_error" | "code"
  > & {
    oversize_argv?: boolean;
    stdin_error?: boolean;
    throttled?: boolean;
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    success?: boolean;
  },
): StageDiagnosticReasonCode {
  // Entitlement text wins over bare throttled so zero-token Fable 429s stay typed.
  if (
    isClaudeModelEntitlementFailure(
      (result as { stdout?: string }).stdout,
      (result as { stderr?: string }).stderr,
      result as Pick<HarnessResult, "exit_code" | "throttled" | "success">,
    )
  ) {
    return "model-entitlement-required";
  }
  if (result.throttled) return "transient-infra";
  if (result.timed_out) return "harness-timeout";
  if (result.oversize_argv || result.stdin_error || result.capture_error) {
    return "harness-contract";
  }
  if (result.spawn_error) return "harness-contract";
  // Non-zero exit without structured flags: still engine-owned harness contract,
  // not product judgment.
  const exitCode =
    typeof (result as { code?: number | null }).code === "number"
      ? (result as { code: number }).code
      : typeof (result as { exit_code?: number }).exit_code === "number"
        ? (result as { exit_code: number }).exit_code
        : null;
  if (exitCode !== null && exitCode !== 0) return "harness-contract";
  return "workflow-engine-defect";
}

/** Re-export for reviewer call sites that want the full HarnessResult shape. */
export { classifyReviewerHarnessFailure };

export type GhErrorClass =
  | "transient-infra"
  | "environment-auth"
  | "capability-refusal"
  | "deterministic-client"
  | "unknown";

/**
 * Classify a gh CLI error from structured shape signals. HTTP status / known
 * tokens are structural; free-form prose is not the primary classifier.
 */
export function classifyGhError(stderr: string): {
  class: GhErrorClass;
  reason_code: StageDiagnosticReasonCode;
  transient: boolean;
} {
  const s = stderr.toLowerCase();

  // Auth / credential refusal (not a soft success path for attestation sites).
  if (
    (s.includes("401") && !s.includes("bad credentials")) ||
    s.includes("authentication required") ||
    s.includes("http 401")
  ) {
    // Note: isTransientGhError treats "401 bad credentials" as transient blip;
    // non-blip auth maps to environment-auth.
    if (!(s.includes("401") && s.includes("bad credentials"))) {
      return { class: "environment-auth", reason_code: "environment-auth", transient: false };
    }
  }

  if (
    s.includes("resource not accessible") ||
    s.includes("http 403") && !s.includes("rate limit") ||
    s.includes("permission")
  ) {
    // Rate-limit 403 is transient; other 403s are capability refusal.
    if (!(s.includes("rate limit") || s.includes("secondary rate limit"))) {
      return {
        class: "capability-refusal",
        reason_code: "capability-refusal",
        transient: false,
      };
    }
  }

  if (isTransientGhError(stderr)) {
    return { class: "transient-infra", reason_code: "transient-infra", transient: true };
  }

  // Deterministic client errors
  if (
    s.includes("http 422") ||
    s.includes("http 404") ||
    s.includes("validation failed") ||
    s.includes("not found") ||
    s.includes("unprocessable")
  ) {
    return {
      class: "deterministic-client",
      reason_code: "workflow-state",
      transient: false,
    };
  }

  return { class: "unknown", reason_code: "workflow-engine-defect", transient: false };
}

/**
 * Exhaustive pure projection: every stage-diagnostic reason → exactly one
 * DurableBlockerClass (via projectPipelineReasonCode).
 */
export function durableClassForReasonCode(
  reasonCode: StageDiagnosticReasonCode,
): DurableBlockerClass {
  return projectPipelineReasonCode(reasonCode).blockerClass;
}

/**
 * Reporting-only projection from a stage-diagnostic reason (+ optional kind)
 * into HumanInterventionKind. MUST NOT be used as an authority classifier —
 * authority is solely projectStageDiagnostic → human_authority.
 */
export function interventionKindFromReason(
  reasonCode: StageDiagnosticReasonCode,
  blockerKind?: BlockerKind | null,
): HumanInterventionKind {
  switch (reasonCode) {
    case "human-decision-required":
      return "product-judgment-required";
    case "human-context-required":
      return "ambiguous-issue";
    case "review-findings":
      // Reporting dimension only — review-non-convergence must not grant authority.
      return "review-non-convergence";
    case "implementation-ci":
    case "repair-budget-exhausted":
      if (
        blockerKind === "eval-gate-failed" ||
        blockerKind === "eval-gate-misconfigured" ||
        blockerKind === "shipcheck-failed" ||
        blockerKind === "visual-gate-failed" ||
        blockerKind === "visual-gate-misconfigured"
      ) {
        return "eval-shipcheck-failure";
      }
      return "test-build-failure";
    case "environment-auth":
    case "capability-refusal":
    case "model-entitlement-required":
      return "auth-tooling-preflight-failure";
    case "harness-timeout":
    case "harness-contract":
    case "workflow-engine-defect":
      return "reviewer-unavailable";
    case "transient-infra":
    case "external-wait":
    case "worktree-capacity":
    case "workflow-state":
      if (blockerKind === "merge-conflict" || blockerKind === "head-drift") {
        return "merge-conflict-or-branch-drift";
      }
      return "auth-tooling-preflight-failure";
    case "openspec-archive-apply-conflict":
    case "openspec-generated-delta-invalid":
      return "product-judgment-required";
    default:
      return "unknown";
  }
}

/**
 * Reporting projection into PreMergeOfframpClass from reason + blocker kind.
 * Not an authority classifier.
 */
export function offrampClassFromReason(
  reasonCode: StageDiagnosticReasonCode,
  blockerKind?: BlockerKind | null,
): PreMergeOfframpClass {
  if (blockerKind === "merge-conflict" || reasonCode === "workflow-state" && blockerKind === "merge-conflict") {
    return "merge-conflict";
  }
  if (blockerKind === "openspec-invalid" || reasonCode === "openspec-archive-apply-conflict") {
    return "openspec-invalid";
  }
  if (blockerKind === "openspec-stale-delta") return "openspec-stale-delta";
  if (
    reasonCode === "implementation-ci" ||
    blockerKind === "ci-exhausted" ||
    blockerKind === "test-gate-exhausted" ||
    blockerKind === "build-failed"
  ) {
    return "ci-failed";
  }
  if (reasonCode === "review-findings") return "delta-review";
  return "other";
}

/** True when a reason code is infrastructure / mechanical (never product judgment alone). */
export function isMechanicalInfrastructureReason(reasonCode: StageDiagnosticReasonCode): boolean {
  return (
    reasonCode === "transient-infra" ||
    reasonCode === "harness-timeout" ||
    reasonCode === "harness-contract" ||
    reasonCode === "external-wait" ||
    reasonCode === "repair-budget-exhausted" ||
    reasonCode === "worktree-capacity" ||
    reasonCode === "environment-auth" ||
    reasonCode === "capability-refusal" ||
    reasonCode === "model-entitlement-required" ||
    reasonCode === "workflow-engine-defect"
  );
}
