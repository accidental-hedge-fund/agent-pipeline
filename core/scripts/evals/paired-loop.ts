// Multi-role pair-loop orchestration for implementing-paired and pipeline-paired
// modes (eval-ordered-primary-reviewer-pairs #601).
//
// Invoked from executor.ts after the cell worktree, eval contract, and command
// boundary are installed. Reuses production prompt builders, review parsers,
// and review-policy partitioning. Never performs production GitHub writes.

import { partitionFindings } from "../review-policy.ts";
import {
  isJsonVerdictShaped,
  parseProseReview,
  parseStrictVerdict,
  parseStructuredVerdict,
} from "../stages/review-parsing.ts";
import type { PipelineConfig, ReviewFinding } from "../types.ts";
import { resolveAdapter } from "../harness-adapters/index.ts";
import type { EvalGhSurface } from "./gh-eval-surface.ts";
import {
  detectConflictingReviewerDeclarations,
  materializePairedAdversarialReviewPrompt,
  materializePairedFixPrompt,
  materializePairedImplementPrompt,
  materializePairedPlanReviewPrompt,
  materializePairedPlanRevisionPrompt,
  materializePairedPlanningPrompt,
  materializePairedStandardReviewPrompt,
  resolvePairedRoleCoordinates,
  type PairedPromptContext,
} from "./stage-adapters.ts";
import type {
  Cell,
  CellOutcome,
  ExperimentManifest,
  FailedRole,
  Fixture,
  ReviewVerdictParseProvenance,
  RoleCoordinate,
  SandboxMode,
} from "./types.ts";
import type { RawStageEntry } from "./trajectory/collect.ts";

export interface PairedHarnessInvokeArgs {
  harness: string;
  worktreeDir: string;
  prompt: string;
  timeoutSec: number;
  model?: string;
  effort?: string;
  gh: EvalGhSurface;
  env?: NodeJS.ProcessEnv;
  sandboxMode?: SandboxMode;
}

export interface PairedHarnessResult {
  success: boolean;
  timed_out: boolean;
  spawn_error?: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration: number;
  throttled?: boolean | null;
}

export interface PairedPreflightResult {
  ok: boolean;
  failure?: "missing-cli" | "unauthenticated" | "headless-unavailable" | "unsupported-setting";
  message?: string;
}

export interface PairedLoopDeps {
  invokeHarness: (args: PairedHarnessInvokeArgs) => Promise<PairedHarnessResult>;
  preflight: (harness: string, req: { model?: string; effort?: string }) => Promise<PairedPreflightResult>;
  getDiff: (args: { worktreeDir: string; baseSha: string }) => Promise<string>;
  classifyPostInvocationFailure: (
    result: PairedHarnessResult,
    harness: string,
    req: { model?: string; effort?: string },
  ) => Promise<string | null>;
  isolationEnv: (worktreeDir: string) => NodeJS.ProcessEnv;
}

export interface PairedLoopInput {
  cfg: PipelineConfig;
  cell: Cell;
  fixture: Fixture;
  manifest: ExperimentManifest;
  worktreeDir: string;
  gh: EvalGhSurface;
  deps: PairedLoopDeps;
  cellDeadlineMs: number;
  trajectoryActions: string[];
  trajectoryStages: RawStageEntry[];
}

export interface PairedLoopResult {
  outcome: CellOutcome;
  /** Concatenated prompts actually sent (for prompt_hash). */
  materializedPrompt: string;
}

/** Parse review stdout with production strict-then-tolerant provenance. */
export function parseReviewFindings(stdout: string): {
  findings?: ReviewFinding[];
  provenance: ReviewVerdictParseProvenance;
} {
  const strict = parseStrictVerdict(stdout);
  if (strict) {
    return { findings: strict.findings, provenance: "strict" };
  }
  const structured = parseStructuredVerdict(stdout);
  if (structured._raw === undefined && (isJsonVerdictShaped(stdout) || parseProseReview(stdout) !== null)) {
    return { findings: structured.findings as ReviewFinding[], provenance: "tolerant" };
  }
  return { provenance: "unparseable" };
}

/** Partition findings with production review_policy; unparseable is blocking. */
export function partitionBlockingFindings(
  cfg: PipelineConfig,
  findings: ReviewFinding[] | undefined,
  provenance: ReviewVerdictParseProvenance,
): { blocking: ReviewFinding[]; unparseable: boolean } {
  if (provenance === "unparseable" || findings === undefined) {
    // Non-approval / blocking contract failure — never empty-findings pass.
    return { blocking: [], unparseable: true };
  }
  const policy = cfg.review_policy ?? { block_threshold: "medium" as const, min_confidence: 0.7 };
  const partitioned = partitionFindings(findings, {
    block_threshold: policy.block_threshold,
    min_confidence: policy.min_confidence,
  });
  return { blocking: partitioned.blocking, unparseable: false };
}

function findingsAsText(findings: ReviewFinding[], unparseable: boolean, rawStdout?: string): string {
  if (unparseable) {
    return [
      "Reviewer returned unparseable output (not an approval).",
      "Treat this as a blocking contract failure and improve the change.",
      rawStdout ? `Raw reviewer output:\n${rawStdout.slice(0, 8_000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return JSON.stringify(findings, null, 2);
}

type RoleName = "primary" | "reviewer";

interface ResolvedRole {
  role: RoleName;
  harness: string;
  model?: string;
  effort?: string;
}

function resolveRole(
  cfg: PipelineConfig,
  role: RoleName,
  coordinate: RoleCoordinate,
): ResolvedRole {
  const resolved = resolvePairedRoleCoordinates(cfg, role, coordinate);
  return { role, ...resolved };
}

/**
 * Run implementing-paired or pipeline-paired graph for one cell.
 * Boundary/contract remain installed for every harness invocation; the caller
 * restores them only after this returns (for clean checks/changed paths).
 */
export async function runPairedCellLoop(input: PairedLoopInput): Promise<PairedLoopResult> {
  const { cfg, cell, fixture, manifest, worktreeDir, gh, deps, cellDeadlineMs, trajectoryActions, trajectoryStages } =
    input;
  const mode = cell.mode;
  if (mode !== "implementing-paired" && mode !== "pipeline-paired") {
    return {
      outcome: { result_class: "infra_error", error: `runPairedCellLoop invoked for non-paired mode "${mode}"` },
      materializedPrompt: "",
    };
  }

  const primaryCoord = cell.treatment.primary;
  const reviewerCoord = cell.treatment.reviewer;
  if (!primaryCoord || !reviewerCoord) {
    return {
      outcome: {
        result_class: "infra_error",
        error: "paired cell is missing primary or reviewer treatment coordinates",
        detail: { failed_role: "primary" satisfies FailedRole },
      },
      materializedPrompt: "",
    };
  }

  const conflict = detectConflictingReviewerDeclarations(cfg);
  if (conflict) {
    return {
      outcome: { result_class: "infra_error", error: conflict },
      materializedPrompt: "",
    };
  }

  const primary = resolveRole(cfg, "primary", primaryCoord);
  const reviewer = resolveRole(cfg, "reviewer", reviewerCoord);

  const promptCtx: PairedPromptContext = {
    cfg,
    fixture,
    pipelineRunId: `eval-${cell.cell_id}`,
    implementer: primary.harness,
    reviewer: reviewer.harness,
  };

  const promptsSent: string[] = [];
  const phaseDetails: Record<string, unknown>[] = [];
  const preflighted = new Set<RoleName>();

  // Evidence shared by both modes — mutated as the loop advances; always
  // merged into terminal outcomes so failed cells keep reconstructable
  // pair-loop diagnostics (#601 review 2 36a6a954).
  let planText = "";
  let planRevisionInvoked = false;
  let fix1Invoked = false;
  let fix2Invoked = false;
  let review1Parse: ReviewVerdictParseProvenance | undefined;
  let review2Parse: ReviewVerdictParseProvenance | undefined;
  let reReviewParse: ReviewVerdictParseProvenance | undefined;
  let blockingBeforeFix1 = 0;
  let blockingAfterFix1 = 0;
  let blockingBeforeFix2 = 0;
  let review2Findings: ReviewFinding[] | undefined;
  let review2Unparseable = false;
  let malformedReviewCount = 0;
  let finalDiff = "";

  /** Absolute wall-clock deadline check — used before preflight/diff/harness
   *  and immediately after every successful phase (#601 review 2 c77be66e). */
  const deadlineExceeded = (when: string, role: FailedRole): CellOutcome => ({
    result_class: "timeout",
    error: `paired cell exceeded its ${manifest.timeout}s deadline ${when}`,
    detail: { failed_role: role },
  });

  const checkDeadline = (when: string, role: FailedRole): CellOutcome | null => {
    if (Date.now() >= cellDeadlineMs) return deadlineExceeded(when, role);
    return null;
  };

  /** Merge accumulated pair-loop evidence into every terminal outcome. */
  const terminate = (outcome: CellOutcome): PairedLoopResult => {
    const durationSec = phaseDetails.reduce(
      (sum, p) => sum + (typeof p.duration === "number" ? p.duration : 0),
      0,
    );
    const baseDetail: Record<string, unknown> = {
      stages: phaseDetails,
      execution_class: "local-cli",
      pair_id: cell.treatment_id,
      primary: {
        harness: primary.harness,
        model: primary.model ?? null,
        effort: primary.effort ?? null,
      },
      reviewer: {
        harness: reviewer.harness,
        model: reviewer.model ?? null,
        effort: reviewer.effort ?? null,
      },
      fix_invoked: fix1Invoked || fix2Invoked,
      fix_1_invoked: fix1Invoked,
      fix_2_invoked: fix2Invoked,
      plan_revision_invoked: planRevisionInvoked,
      blocking_findings_before: blockingBeforeFix1,
      blocking_findings_after: mode === "implementing-paired" ? blockingAfterFix1 : undefined,
      blocking_findings_before_fix_1: blockingBeforeFix1,
      // Both modes record post-fix-1 blocking; pipeline-paired uses adversarial
      // review as that observation (#601 review 1 6d63e02e).
      blocking_findings_after_fix_1: blockingAfterFix1,
      blocking_findings_before_fix_2: mode === "pipeline-paired" ? blockingBeforeFix2 : undefined,
      // Review-2 / pre-fix-2 findings labeled separately from final post-fix-2 state.
      review_2_findings: mode === "pipeline-paired" ? (review2Findings ?? null) : undefined,
      review_2_unparseable: mode === "pipeline-paired" ? review2Unparseable : undefined,
      post_fix_2_diff_present: mode === "pipeline-paired" ? fix2Invoked : undefined,
      final_diff_bytes: finalDiff.length,
      review_verdict_parse: review1Parse,
      review_1_verdict_parse: review1Parse,
      review_2_verdict_parse: mode === "implementing-paired" ? reReviewParse : review2Parse,
      re_review_verdict_parse: reReviewParse,
      malformed_review_count: malformedReviewCount,
      duration_sec: durationSec,
      pair_loop: {
        mode,
        plan_revision_invoked: planRevisionInvoked,
        fix_1_invoked: fix1Invoked,
        fix_2_invoked: fix2Invoked,
        blocking_before_fix_1: blockingBeforeFix1,
        blocking_after_fix_1: blockingAfterFix1,
        blocking_before_fix_2: mode === "pipeline-paired" ? blockingBeforeFix2 : null,
        malformed_review_count: malformedReviewCount,
      },
    };
    // Outcome-specific fields (failed_role, final_review_disposition, …) win.
    const detail = { ...baseDetail, ...(outcome.detail ?? {}) };
    return {
      outcome: { ...outcome, detail },
      materializedPrompt: promptsSent.join("\n\n---\n\n"),
    };
  };

  /** Preflight a role on first use so primary can implement before reviewer auth is checked. */
  const ensurePreflight = async (
    resolved: ResolvedRole,
  ): Promise<CellOutcome | null> => {
    if (preflighted.has(resolved.role)) return null;
    const before = checkDeadline(`before ${resolved.role} preflight`, resolved.role);
    if (before) return before;
    if (resolved.effort !== undefined) {
      const adapter = resolveAdapter(resolved.harness);
      if (!adapter || !adapter.capabilities.effort) {
        return {
          result_class: "infra_error",
          error: `harness "${resolved.harness}" has no reasoning-effort control — cannot deliver declared effort "${resolved.effort}"`,
          detail: { failed_role: resolved.role },
        };
      }
    }
    let preflight: PairedPreflightResult;
    try {
      preflight = await deps.preflight(resolved.harness, {
        model: resolved.model,
        effort: resolved.effort,
      });
    } catch (err) {
      return {
        result_class: "infra_error",
        error: `${resolved.role} preflight failed: ${(err as Error).message}`,
        detail: { failed_role: resolved.role },
      };
    }
    const after = checkDeadline(`during ${resolved.role} preflight`, resolved.role);
    if (after) return after;
    if (!preflight.ok) {
      const resultClass = preflight.failure === "unauthenticated" ? "auth_error" : "infra_error";
      return {
        result_class: resultClass,
        error: `${resolved.role} preflight failed: ${preflight.message ?? preflight.failure}`,
        detail: { failed_role: resolved.role },
      };
    }
    preflighted.add(resolved.role);
    trajectoryActions.push(`preflight passed for ${resolved.role} harness "${resolved.harness}"`);
    return null;
  };

  const collectDiff = async (
    when: string,
  ): Promise<{ diff?: string; outcome?: CellOutcome }> => {
    const before = checkDeadline(`before ${when}`, "primary");
    if (before) return { outcome: before };
    try {
      const diff = await deps.getDiff({ worktreeDir, baseSha: cell.base_sha });
      const after = checkDeadline(`during ${when}`, "primary");
      if (after) return { outcome: after };
      return { diff };
    } catch (err) {
      return {
        outcome: {
          result_class: "infra_error",
          error: `failed to collect ${when}: ${(err as Error).message}`,
          detail: { failed_role: "primary" satisfies FailedRole },
        },
      };
    }
  };

  const invokePhase = async (
    phase: string,
    resolved: ResolvedRole,
    prompt: string,
  ): Promise<{ result?: PairedHarnessResult; outcome?: CellOutcome }> => {
    const preflightError = await ensurePreflight(resolved);
    if (preflightError) return { outcome: preflightError };

    promptsSent.push(prompt);
    const remainingMs = cellDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      return {
        outcome: deadlineExceeded(`before ${phase}`, resolved.role),
      };
    }
    // Pass the exact remaining budget — do NOT ceil to whole seconds, which
    // would grant a sub-second remainder a full extra second of overrun
    // allowance (#601 review 2 c77be66e). Fractional seconds are honored by
    // harness runCapped (timeoutSec * 1000).
    const timeoutSec = remainingMs / 1000;
    let result: PairedHarnessResult;
    try {
      result = await deps.invokeHarness({
        harness: resolved.harness,
        worktreeDir,
        prompt,
        timeoutSec,
        model: resolved.model,
        effort: resolved.effort,
        gh,
        env: deps.isolationEnv(worktreeDir),
        sandboxMode: manifest.sandbox_mode,
      });
    } catch (err) {
      return {
        outcome: {
          result_class: "infra_error",
          error: `${phase} harness invocation failed: ${(err as Error).message}`,
          detail: { failed_role: resolved.role },
        },
      };
    }
    trajectoryStages.push({
      stage: phase,
      message: prompt,
      output: result.stdout,
      error: result.success ? undefined : result.stderr,
      duration_ms: Math.round(result.duration * 1000),
      success: result.success,
    });
    phaseDetails.push({
      phase,
      role: resolved.role,
      harness: resolved.harness,
      model: resolved.model ?? null,
      effort: resolved.effort ?? null,
      success: result.success,
      exit_code: result.exit_code,
      duration: result.duration,
    });
    if (result.timed_out) {
      return {
        outcome: {
          result_class: "timeout",
          error: `${phase} exceeded the paired cell deadline`,
          detail: { failed_role: resolved.role },
        },
      };
    }
    if (result.spawn_error) {
      return {
        outcome: {
          result_class: "infra_error",
          error: `${phase} failed to spawn the ${resolved.harness} harness`,
          detail: { failed_role: resolved.role },
        },
      };
    }
    if (!result.success) {
      const authFailure = await deps.classifyPostInvocationFailure(result, resolved.harness, {
        model: resolved.model,
        effort: resolved.effort,
      });
      if (authFailure) {
        return {
          outcome: {
            result_class: "auth_error",
            error: `${phase} ${authFailure}`,
            detail: { failed_role: resolved.role },
          },
        };
      }
      // Any other unsuccessful harness result is infrastructure — do not parse
      // or advance the pair graph from failed stage output (#601 review 1 031e981b).
      trajectoryActions.push(
        `invoked ${phase} via ${resolved.role} harness "${resolved.harness}" (failure → infra_error)`,
      );
      return {
        outcome: {
          result_class: "infra_error",
          error:
            `${phase} harness "${resolved.harness}" exited unsuccessfully ` +
            `(exit_code=${result.exit_code}` +
            (result.stderr ? `; stderr=${result.stderr.slice(0, 500)}` : "") +
            `)`,
          detail: { failed_role: resolved.role },
        },
      };
    }
    // Successful harness output is only usable if the shared wall-clock budget
    // has not already elapsed (final phase has no later invoke to recheck).
    if (Date.now() >= cellDeadlineMs) {
      trajectoryActions.push(
        `invoked ${phase} via ${resolved.role} harness "${resolved.harness}" (success after deadline → timeout)`,
      );
      return {
        outcome: deadlineExceeded(`after ${phase}`, resolved.role),
      };
    }
    trajectoryActions.push(
      `invoked ${phase} via ${resolved.role} harness "${resolved.harness}" (success)`,
    );
    return { result };
  };

  if (mode === "pipeline-paired") {
    // planning → plan-review → (optional) plan revision → implement → review → fix-1 → adversarial → fix-2
    const planning = await invokePhase(
      "planning",
      primary,
      materializePairedPlanningPrompt(promptCtx),
    );
    if (planning.outcome) return terminate(planning.outcome);
    planText = planning.result!.stdout || "";

    const planReview = await invokePhase(
      "plan-review",
      reviewer,
      materializePairedPlanReviewPrompt(promptCtx, planText),
    );
    if (planReview.outcome) return terminate(planReview.outcome);
    const planReviewParsed = parseReviewFindings(planReview.result!.stdout);
    const planBlocking = partitionBlockingFindings(cfg, planReviewParsed.findings, planReviewParsed.provenance);
    if (planReviewParsed.provenance === "unparseable") malformedReviewCount += 1;
    if (planBlocking.blocking.length > 0 || planBlocking.unparseable) {
      planRevisionInvoked = true;
      const feedback = findingsAsText(
        planBlocking.blocking,
        planBlocking.unparseable,
        planReview.result!.stdout,
      );
      const revision = await invokePhase(
        "plan-revision",
        primary,
        materializePairedPlanRevisionPrompt(promptCtx, planText, feedback),
      );
      if (revision.outcome) return terminate(revision.outcome);
      planText = revision.result!.stdout || planText;
    }
  } else {
    // implementing-paired: plan from fixture stage-entry / task_input.
    const artifact = fixture.stage_entry_artifacts.implementing;
    if (typeof artifact === "object" && artifact !== null && typeof (artifact as { plan?: string }).plan === "string") {
      planText = (artifact as { plan: string }).plan;
    } else if (typeof artifact === "string") {
      planText = artifact;
    } else {
      planText = fixture.task_input;
    }
  }

  // Shared implement → standard review → conditional fix-1 → re-review (implementing-paired)
  // or implement → standard review → fix-1 → adversarial → fix-2 (pipeline-paired)
  const implement = await invokePhase(
    "implementing",
    primary,
    materializePairedImplementPrompt(promptCtx, planText),
  );
  if (implement.outcome) return terminate(implement.outcome);

  const initialDiffResult = await collectDiff("primary implementation diff for review");
  if (initialDiffResult.outcome) return terminate(initialDiffResult.outcome);
  const initialDiff = initialDiffResult.diff!;

  const review1 = await invokePhase(
    "review-1",
    reviewer,
    materializePairedStandardReviewPrompt(promptCtx, planText, initialDiff),
  );
  if (review1.outcome) return terminate(review1.outcome);
  const review1Parsed = parseReviewFindings(review1.result!.stdout);
  review1Parse = review1Parsed.provenance;
  if (review1Parse === "unparseable") malformedReviewCount += 1;
  const review1Partition = partitionBlockingFindings(cfg, review1Parsed.findings, review1Parsed.provenance);
  blockingBeforeFix1 = review1Partition.unparseable ? 1 : review1Partition.blocking.length;

  if (blockingBeforeFix1 > 0) {
    fix1Invoked = true;
    const fix1 = await invokePhase(
      "fix-1",
      primary,
      materializePairedFixPrompt(
        promptCtx,
        findingsAsText(review1Partition.blocking, review1Partition.unparseable, review1.result!.stdout),
        1,
      ),
    );
    if (fix1.outcome) return terminate(fix1.outcome);
  }

  const postFix1Diff = await collectDiff("post-fix-1 worktree diff for review");
  if (postFix1Diff.outcome) return terminate(postFix1Diff.outcome);
  finalDiff = postFix1Diff.diff!;

  // Final re-review remaining-blocking / unparseable disposition (implementing-paired only).
  let finalReviewUnresolved = false;
  let finalReviewUnparseable = false;

  if (mode === "implementing-paired") {
    // Re-review only when fix ran (design: skip second review when no blocking).
    if (fix1Invoked) {
      const reReview = await invokePhase(
        "review-2",
        reviewer,
        materializePairedStandardReviewPrompt(promptCtx, planText, finalDiff),
      );
      if (reReview.outcome) return terminate(reReview.outcome);
      const reParsed = parseReviewFindings(reReview.result!.stdout);
      reReviewParse = reParsed.provenance;
      if (reReviewParse === "unparseable") malformedReviewCount += 1;
      const rePartition = partitionBlockingFindings(cfg, reParsed.findings, reParsed.provenance);
      finalReviewUnparseable = rePartition.unparseable;
      blockingAfterFix1 = rePartition.unparseable ? 1 : rePartition.blocking.length;
      // Unresolved final re-review is not a completed treatment quality outcome
      // (#601 review 1 14b9a887): unparseable is never approval, and still-blocking
      // after fix must not count as completed / quality-graded.
      if (blockingAfterFix1 > 0) finalReviewUnresolved = true;
    } else {
      blockingAfterFix1 = blockingBeforeFix1;
    }
  } else {
    // pipeline-paired: always run adversarial review after fix-1 path; no third review after fix-2.
    // When fix-1 did not run, adversarial still sees the implementation diff.
    const review1Summary =
      review1Parsed.findings && review1Parsed.findings.length > 0
        ? JSON.stringify(review1Parsed.findings, null, 2)
        : review1.result!.stdout.slice(0, 4_000);
    const adv = await invokePhase(
      "review-2",
      reviewer,
      materializePairedAdversarialReviewPrompt(promptCtx, finalDiff, review1Summary),
    );
    if (adv.outcome) return terminate(adv.outcome);
    const advParsed = parseReviewFindings(adv.result!.stdout);
    review2Parse = advParsed.provenance;
    if (review2Parse === "unparseable") malformedReviewCount += 1;
    const advPartition = partitionBlockingFindings(cfg, advParsed.findings, advParsed.provenance);
    review2Findings = advParsed.findings;
    review2Unparseable = advPartition.unparseable;
    blockingBeforeFix2 = advPartition.unparseable ? 1 : advPartition.blocking.length;
    // Adversarial review is the sole post-fix-1 observation; record it as the
    // post-fix-1 blocking count as well as the pre-fix-2 count (#601 review 1 6d63e02e).
    blockingAfterFix1 = blockingBeforeFix2;

    if (blockingBeforeFix2 > 0) {
      fix2Invoked = true;
      const fix2 = await invokePhase(
        "fix-2",
        primary,
        materializePairedFixPrompt(
          promptCtx,
          findingsAsText(advPartition.blocking, advPartition.unparseable, adv.result!.stdout),
          2,
          review1Summary,
        ),
      );
      if (fix2.outcome) return terminate(fix2.outcome);
      // No third review after fix-2. Capture final post-fix-2 worktree state separately.
      const postFix2Diff = await collectDiff("post-fix-2 worktree diff");
      if (postFix2Diff.outcome) return terminate(postFix2Diff.outcome);
      finalDiff = postFix2Diff.diff!;
    }
  }

  // Final absolute deadline gate before completing (covers modes that end
  // without a harness phase after the last successful step).
  const finalDeadline = checkDeadline("before completing pair loop", "primary");
  if (finalDeadline) return terminate(finalDeadline);

  // implementing-paired: unresolved final re-review is not a completed treatment
  // outcome — exclude from quality grading and completion reliability while
  // preserving parse provenance and loop diagnostics in detail.
  if (mode === "implementing-paired") {
    if (finalReviewUnresolved) {
      return terminate({
        result_class: "infra_error",
        error: finalReviewUnparseable
          ? "implementing-paired final re-review was unparseable (not approval) — not a completed treatment outcome"
          : "implementing-paired final re-review still has blocking findings — not a completed treatment outcome",
        detail: {
          final_review_disposition: finalReviewUnparseable
            ? "unresolved_unparseable"
            : "unresolved_blocking",
        },
      });
    }
    return terminate({
      result_class: "completed",
      detail: { final_review_disposition: "approved" },
    });
  }

  return terminate({ result_class: "completed" });
}
