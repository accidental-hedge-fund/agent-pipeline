// Fix stages: fix-1 → review-2, fix-2 → pre-merge.
//
// Steps:
//   1. Find the latest review comment for this round (review-N) on the issue.
//   2. Run the IMPLEMENTER harness in the existing worktree with the fix prompt
//      + the verbatim review findings.
//   3. Verify new commits exist; push.
//   4. Transition fix-N → review-N+1 (or pre-merge for round 2).

import {
  findLatestCommentMatching,
  getIssueDetail,
  setBlocked,
  transition,
} from "../gh.ts";
import { invoke } from "../harness.ts";
import { branchName, getForIssue, gitInWorktree } from "../worktree.ts";
import { buildFixPrompt } from "../prompts/index.ts";
import { runTestGate, testGateBlockReason } from "../testgate.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

export interface AdvanceFixOpts {
  dryRun?: boolean;
  model?: string;
}

export async function advanceFix(
  cfg: PipelineConfig,
  issueNumber: number,
  round: 1 | 2,
  opts: AdvanceFixOpts = {},
): Promise<Outcome> {
  const stage: Stage = round === 1 ? "fix-1" : "fix-2";
  const harness = cfg.harnesses.implementer;

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${harness}`);

  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) {
    await setBlocked(cfg, issueNumber, "No worktree found. Cannot apply fixes.", stage);
    return { advanced: false, status: "blocked", reason: "no worktree" };
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const findings = extractReviewFindings(detail.comments, round);
  if (!findings) {
    // No findings → just advance (this is unusual but matches openclaw behavior).
    const next: Stage = round === 1 ? "review-2" : "pre-merge";
    await transition(
      cfg,
      issueNumber,
      stage,
      next,
      "No review findings found to address. Advancing.",
    );
    return { advanced: true, from: stage, to: next, summary: "no findings to address" };
  }

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would invoke ${harness} to fix findings`);
    return {
      advanced: true,
      from: stage,
      to: round === 1 ? "review-2" : "pre-merge",
      summary: "[dry-run]",
    };
  }

  // Capture HEAD before so we can detect non-commits.
  const headBefore = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();

  const prompt = buildFixPrompt({
    issueNumber,
    title: detail.title,
    reviewFindings: findings,
    fixRound: round,
  });
  const result = await invoke(harness, wt.path, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: opts.model ?? cfg.models.fix,
  });

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await setBlocked(cfg, issueNumber, `Fix harness (${harness}) failed: ${reason}`, stage);
    return { advanced: false, status: "blocked", reason };
  }

  const headAfter = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();
  if (headBefore && headAfter && headBefore === headAfter) {
    await setBlocked(
      cfg,
      issueNumber,
      `${stage} reported success but produced no new commits.`,
      stage,
    );
    return { advanced: false, status: "blocked", reason: "no new commits" };
  }

  // ---- Verify fix-round commit message format (#68) ----
  if (headBefore) {
    const commitCheck = await enforceFixCommitGate(round, issueNumber, wt.path, headBefore);
    if (!commitCheck.ok) {
      await setBlocked(cfg, issueNumber, commitCheck.reason, stage);
      return { advanced: false, status: "blocked", reason: commitCheck.reason };
    }
  }

  // ---- test/build gate (#15) — must pass before advancing past this fix round ----
  const gate = await runTestGate(cfg, issueNumber, wt.path);
  if (!gate.skipped && !gate.passed) {
    await setBlocked(cfg, issueNumber, testGateBlockReason(gate), stage);
    return { advanced: false, status: "blocked", reason: "test gate failed" };
  }

  const branch = branchName(issueNumber, wt.slug);
  const push = await gitInWorktree(wt.path, ["push", "origin", branch], { ignoreFailure: true });
  if (push.code !== 0) {
    await setBlocked(
      cfg,
      issueNumber,
      `Git push failed after fix: ${push.stderr.trim()}`,
      stage,
    );
    return { advanced: false, status: "blocked", reason: "push failed" };
  }

  if (round === 1) {
    await transition(
      cfg,
      issueNumber,
      "fix-1",
      "review-2",
      `Fix round 1 complete. Review 1 findings addressed. Ready for adversarial review.`,
    );
    return {
      advanced: true,
      from: "fix-1",
      to: "review-2",
      summary: "fixes pushed",
    };
  } else {
    await transition(
      cfg,
      issueNumber,
      "fix-2",
      "pre-merge",
      `Fix round 2 complete. Adversarial review findings addressed. Ready for pre-merge gate.`,
    );
    return {
      advanced: true,
      from: "fix-2",
      to: "pre-merge",
      summary: "fixes pushed",
    };
  }
}

// ---------------------------------------------------------------------------
// Fix-commit format gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Returns the `VerifyDeps`-compatible config for a fix-round commit check and
 * exposes the gate as a standalone injectable function so tests can exercise
 * it without mocking the entire `advanceFix` call chain.
 */
export async function enforceFixCommitGate(
  round: 1 | 2,
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(
    wtPath,
    headBefore,
    {
      messagePattern: {
        pattern: new RegExp(
          `fix:\\s+address review ${round} findings \\(#${issueNumber}\\)`,
          "i",
        ),
        description: `Fix round ${round} commit message does not match prescribed format`,
      },
    },
    deps,
  );
}

// ---- pure helpers ----

export function extractReviewFindings(
  comments: { body: string }[],
  round: 1 | 2,
): string {
  const marker = `## Review ${round}`;
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) =>
      b.startsWith(marker) &&
      (b.includes("needs-attention") ||
        b.includes("### Findings") ||
        b.toUpperCase().includes("REQUEST_CHANGES") ||
        b.toUpperCase().includes("REQUEST CHANGES")),
  );
  return m?.body ?? "";
}
