// Multi-change treatment graphs (#577): bare implement vs Agent Pipeline
// review-policy + finding-resolution (implementing-paired style) per checkpoint.
//
// Shares production review/fix prompt builders and review_policy partitioning
// with paired-loop.ts so pipeline-current is not a second unconstrained invoke.

import type { PipelineConfig } from "../types.ts";
import {
  materializePairedAdversarialReviewPrompt,
  materializePairedFixPrompt,
  materializePairedStandardReviewPrompt,
  type PairedPromptContext,
} from "./stage-adapters.ts";
import {
  parseReviewFindings,
  partitionBlockingFindings,
} from "./paired-loop.ts";
import type { ReviewFinding } from "../types.ts";
import type {
  CellOutcome,
  Fixture,
  ReviewVerdictParseProvenance,
  SandboxMode,
} from "./types.ts";
import type { RawStageEntry } from "./trajectory/collect.ts";

export interface MultiChangeHarnessInvokeArgs {
  harness: string;
  worktreeDir: string;
  prompt: string;
  timeoutSec: number;
  model?: string;
  effort?: string;
  env?: NodeJS.ProcessEnv;
  sandboxMode?: SandboxMode;
}

export interface MultiChangeHarnessResult {
  success: boolean;
  timed_out: boolean;
  spawn_error?: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface MultiChangeTreatmentDeps {
  invokeHarness: (args: MultiChangeHarnessInvokeArgs) => Promise<MultiChangeHarnessResult>;
  getDiff: (args: { worktreeDir: string; baseSha: string }) => Promise<string>;
  classifyPostInvocationFailure: (
    result: MultiChangeHarnessResult,
    harness: string,
    req: { model?: string; effort?: string },
  ) => Promise<string | null>;
  isolationEnv: (worktreeDir: string) => NodeJS.ProcessEnv;
}

export interface MultiChangeTreatmentInput {
  cfg: PipelineConfig;
  fixture: Fixture;
  /** Disclosed checkpoint requirement (plan / issue body for review prompts). */
  checkpointTaskInput: string;
  checkpointId: string;
  /** Same disclosed implement prompt bare and pipeline share. */
  implementPrompt: string;
  profile: string;
  cellId: string;
  worktreeDir: string;
  baseSha: string;
  harness: string;
  model?: string;
  effort?: string;
  sessionId: string;
  cellDeadlineMs: number;
  manifestTimeoutSec: number;
  sandboxMode?: SandboxMode;
  deps: MultiChangeTreatmentDeps;
  trajectoryActions: string[];
  trajectoryStages: RawStageEntry[];
}

export type MultiChangeTreatmentResult =
  | {
      ok: true;
      duration: number;
      /** Prompts actually sent (for multi-change prompt trail). */
      prompts: string[];
      pipeline: {
        fix_1_invoked: boolean;
        fix_2_invoked: boolean;
        blocking_before_fix_1: number;
        review_1_verdict_parse?: ReviewVerdictParseProvenance;
      };
    }
  | { ok: false; outcome: CellOutcome };

function findingsAsText(
  findings: ReviewFinding[],
  unparseable: boolean,
  rawStdout?: string,
): string {
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

/**
 * Run one multi-change checkpoint's treatment graph.
 *
 * - bare / just-solve / quality-feedback / design-dossier: implement only
 * - pipeline-current: implement → standard review → conditional fix → conditional re-review
 * - adversarial-review: implement → standard review → conditional fix → adversarial → conditional fix-2
 *
 * Quality (verifier) outcomes are graded after this returns; unresolved review
 * findings do not abort the lineage (multi-change continues for diagnostics).
 * Infra/auth/timeout aborts via `{ ok: false, outcome }`.
 */
export async function runMultiChangeCheckpointTreatment(
  input: MultiChangeTreatmentInput,
): Promise<MultiChangeTreatmentResult> {
  const {
    cfg,
    fixture,
    checkpointTaskInput,
    checkpointId,
    implementPrompt,
    profile,
    cellId,
    worktreeDir,
    baseSha,
    harness,
    model,
    effort,
    sessionId,
    cellDeadlineMs,
    manifestTimeoutSec,
    sandboxMode,
    deps,
    trajectoryActions,
    trajectoryStages,
  } = input;

  const prompts: string[] = [];
  let duration = 0;
  let fix1Invoked = false;
  let fix2Invoked = false;
  let blockingBeforeFix1 = 0;
  let review1Parse: ReviewVerdictParseProvenance | undefined;

  const abortDetail = (resultClass: CellOutcome["result_class"]): CellOutcome["detail"] => ({
    multi_change: {
      aborted: { checkpoint_id: checkpointId, result_class: resultClass },
    },
  });

  const invoke = async (
    role: string,
    prompt: string,
  ): Promise<{ ok: true; result: MultiChangeHarnessResult } | { ok: false; outcome: CellOutcome }> => {
    const remaining = cellDeadlineMs - Date.now();
    if (remaining <= 0) {
      const error = `multi-change cell exceeded its ${manifestTimeoutSec}s timeout during checkpoint "${checkpointId}" (${role})`;
      trajectoryActions.push(error);
      return {
        ok: false,
        outcome: { result_class: "timeout", error, detail: abortDetail("timeout") },
      };
    }
    prompts.push(prompt);
    let result: MultiChangeHarnessResult;
    try {
      result = await deps.invokeHarness({
        harness,
        worktreeDir,
        prompt,
        timeoutSec: Math.max(1, Math.ceil(remaining / 1000)),
        model,
        effort,
        env: {
          ...deps.isolationEnv(worktreeDir),
          PIPELINE_EVAL_SESSION_ID: sessionId,
          PIPELINE_EVAL_CHECKPOINT_ID: checkpointId,
        },
        sandboxMode,
      });
    } catch (err) {
      const error = `harness invocation failed: ${(err as Error).message}`;
      trajectoryActions.push(`checkpoint "${checkpointId}" ${role}: ${error}`);
      return {
        ok: false,
        outcome: { result_class: "infra_error", error, detail: abortDetail("infra_error") },
      };
    }

    duration += result.duration;
    trajectoryStages.push({
      stage: role,
      message: prompt,
      output: result.stdout,
      error: result.success ? undefined : result.stderr,
      duration_ms: Math.round(result.duration * 1000),
      success: result.success,
    });

    if (result.timed_out) {
      return {
        ok: false,
        outcome: {
          result_class: "timeout",
          error: `checkpoint "${checkpointId}" ${role} exceeded the per-cell timeout`,
          detail: abortDetail("timeout"),
        },
      };
    }
    if (result.spawn_error) {
      return {
        ok: false,
        outcome: {
          result_class: "infra_error",
          error: `checkpoint "${checkpointId}" ${role} failed to spawn the harness process`,
          detail: abortDetail("infra_error"),
        },
      };
    }
    if (!result.success) {
      const authFailure = await deps.classifyPostInvocationFailure(result, harness, {
        model,
        effort,
      });
      if (authFailure) {
        return {
          ok: false,
          outcome: {
            result_class: "auth_error",
            error: `checkpoint "${checkpointId}" ${role} ${authFailure}`,
            detail: abortDetail("auth_error"),
          },
        };
      }
    }
    trajectoryActions.push(
      `checkpoint "${checkpointId}" ${role} via "${harness}" ` +
        `(session ${sessionId}, model ${model ?? "default"}, ${result.success ? "success" : "failure"})`,
    );
    return { ok: true, result };
  };

  // Implement (identical disclosed prompt for bare and pipeline treatments).
  const implement = await invoke("implement", implementPrompt);
  if (!implement.ok) return implement;

  const usesPipelineGraph = profile === "pipeline-current" || profile === "adversarial-review";
  if (!usesPipelineGraph) {
    return {
      ok: true,
      duration,
      prompts,
      pipeline: {
        fix_1_invoked: false,
        fix_2_invoked: false,
        blocking_before_fix_1: 0,
      },
    };
  }

  // Checkpoint-scoped fixture view so production review/fix prompts see only
  // the disclosed requirement (not later checkpoints or the synopsis alone).
  const checkpointFixture: Fixture = {
    ...fixture,
    task_input: checkpointTaskInput,
  };
  const promptCtx: PairedPromptContext = {
    cfg,
    fixture: checkpointFixture,
    pipelineRunId: `eval-mc-${cellId}-${checkpointId}`,
    implementer: harness,
    reviewer: harness,
  };
  const planText = checkpointTaskInput;

  let diff: string;
  try {
    diff = await deps.getDiff({ worktreeDir, baseSha });
  } catch (err) {
    const error = `checkpoint "${checkpointId}" failed to collect worktree diff for review: ${(err as Error).message}`;
    trajectoryActions.push(error);
    return {
      ok: false,
      outcome: { result_class: "infra_error", error, detail: abortDetail("infra_error") },
    };
  }

  const review1 = await invoke(
    "review-1",
    materializePairedStandardReviewPrompt(promptCtx, planText, diff),
  );
  if (!review1.ok) return review1;

  const review1Parsed = parseReviewFindings(review1.result.stdout);
  review1Parse = review1Parsed.provenance;
  const review1Partition = partitionBlockingFindings(cfg, review1Parsed.findings, review1Parsed.provenance);
  blockingBeforeFix1 = review1Partition.unparseable ? 1 : review1Partition.blocking.length;
  trajectoryActions.push(
    `checkpoint "${checkpointId}" review-1: ${review1Parse}` +
      (blockingBeforeFix1 > 0
        ? ` (${blockingBeforeFix1} blocking; fix-1 will run)`
        : " (no blocking findings)"),
  );

  if (blockingBeforeFix1 > 0) {
    fix1Invoked = true;
    const fix1 = await invoke(
      "fix-1",
      materializePairedFixPrompt(
        promptCtx,
        findingsAsText(review1Partition.blocking, review1Partition.unparseable, review1.result.stdout),
        1,
      ),
    );
    if (!fix1.ok) return fix1;
  }

  let postDiff: string;
  try {
    postDiff = await deps.getDiff({ worktreeDir, baseSha });
  } catch (err) {
    const error = `checkpoint "${checkpointId}" failed to collect post-review worktree diff: ${(err as Error).message}`;
    trajectoryActions.push(error);
    return {
      ok: false,
      outcome: { result_class: "infra_error", error, detail: abortDetail("infra_error") },
    };
  }

  if (profile === "pipeline-current") {
    // implementing-paired style: re-review only when fix ran. Unresolved
    // findings do not abort multi-change lineage (verifiers remain quality signal).
    if (fix1Invoked) {
      const reReview = await invoke(
        "review-2",
        materializePairedStandardReviewPrompt(promptCtx, planText, postDiff),
      );
      if (!reReview.ok) return reReview;
      const reParsed = parseReviewFindings(reReview.result.stdout);
      const rePartition = partitionBlockingFindings(cfg, reParsed.findings, reParsed.provenance);
      const stillBlocking = rePartition.unparseable ? 1 : rePartition.blocking.length;
      trajectoryActions.push(
        `checkpoint "${checkpointId}" review-2: ${reParsed.provenance}` +
          (stillBlocking > 0 ? ` (${stillBlocking} still blocking; lineage continues)` : " (clear)"),
      );
    }
  } else {
    // adversarial-review profile: adversarial pass after fix-1 path, optional fix-2.
    const review1Summary =
      review1Parsed.findings && review1Parsed.findings.length > 0
        ? JSON.stringify(review1Parsed.findings, null, 2)
        : review1.result.stdout.slice(0, 4_000);
    const adv = await invoke(
      "adversarial-review",
      materializePairedAdversarialReviewPrompt(promptCtx, postDiff, review1Summary),
    );
    if (!adv.ok) return adv;
    const advParsed = parseReviewFindings(adv.result.stdout);
    const advPartition = partitionBlockingFindings(cfg, advParsed.findings, advParsed.provenance);
    const blockingBeforeFix2 = advPartition.unparseable ? 1 : advPartition.blocking.length;
    trajectoryActions.push(
      `checkpoint "${checkpointId}" adversarial-review: ${advParsed.provenance}` +
        (blockingBeforeFix2 > 0 ? ` (${blockingBeforeFix2} blocking; fix-2 will run)` : " (no blocking)"),
    );
    if (blockingBeforeFix2 > 0) {
      fix2Invoked = true;
      const fix2 = await invoke(
        "fix-2",
        materializePairedFixPrompt(
          promptCtx,
          findingsAsText(advPartition.blocking, advPartition.unparseable, adv.result.stdout),
          2,
          review1Summary,
        ),
      );
      if (!fix2.ok) return fix2;
    }
  }

  return {
    ok: true,
    duration,
    prompts,
    pipeline: {
      fix_1_invoked: fix1Invoked,
      fix_2_invoked: fix2Invoked,
      blocking_before_fix_1: blockingBeforeFix1,
      review_1_verdict_parse: review1Parse,
    },
  };
}
