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
import { makePipelineRunId } from "../traceability.ts";
import * as openspec from "../openspec.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import type { ValidateResult } from "../openspec.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

export interface AdvanceFixOpts {
  dryRun?: boolean;
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
}

/** Injectable seams for {@link advanceFix} — overridable in tests. */
export interface AdvanceFixDeps {
  /** Files changed between two SHAs (defaults to `git diff --name-only from to`). */
  gitDiffFiles?: (wtPath: string, from: string, to: string) => Promise<string[]>;
  /** Validate one OpenSpec change (defaults to `openspec.validateItem`). */
  openspecValidateItem?: (wtPath: string, id: string) => Promise<ValidateResult>;
}

export async function advanceFix(
  cfg: PipelineConfig,
  issueNumber: number,
  round: 1 | 2,
  opts: AdvanceFixOpts = {},
  deps: AdvanceFixDeps = {},
): Promise<Outcome> {
  const stage: Stage = round === 1 ? "fix-1" : "fix-2";
  const harness = cfg.harnesses.implementer;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${harness}`);

  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) {
    await setBlocked(cfg, issueNumber, "No worktree found. Cannot apply fixes.", stage);
    return { advanced: false, status: "blocked", reason: "no worktree" };
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const findings = extractReviewFindings(detail.comments, round);
  if (!findings) {
    // No findings → just advance.
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

  // Use branch-diff to identify the OpenSpec change this branch introduced rather
  // than changes[0], which may be an unrelated pre-existing change in the worktree.
  const branchDiff = await gitInWorktree(
    wt.path,
    ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
    { ignoreFailure: true },
  );
  const diffPaths = branchDiff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const specContext = openspecContextFromDiff(cfg, wt.path, diffPaths);
  const prompt = buildFixPrompt({
    issueNumber,
    title: detail.title,
    reviewFindings: findings,
    priorReviewHistory: extractAllReviewFindingsHistory(detail.comments, round),
    fixRound: round,
    pipelineRunId,
    specContext,
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

  // ---- OpenSpec spec-delta validation (#106): if the harness revised any spec
  //      delta files this round, validate the change before push/advance ----
  if (headBefore && headAfter && headBefore !== headAfter) {
    const specCheck = await enforceOpenspecSpecDeltaValidation(wt.path, headBefore, headAfter, {
      gitDiffFiles: deps.gitDiffFiles ?? defaultGitDiffFiles,
      openspecValidateItem: deps.openspecValidateItem ?? openspec.validateItem,
    });
    if (!specCheck.ok) {
      await setBlocked(cfg, issueNumber, specCheck.reason, stage);
      return { advanced: false, status: "blocked", reason: specCheck.reason };
    }
  }

  // ---- test/build gate (#15) — must pass before advancing past this fix round ----
  const gate = await runTestGate(cfg, issueNumber, wt.path, {}, pipelineRunId);
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

/**
 * All prior review-{round} finding comments on the issue (oldest-first, excluding
 * the most recent, which is already supplied verbatim as the current findings),
 * joined with dividers. Gives the fix harness the full cross-round history so it
 * does not revert an earlier fix and re-trigger a finding that was already
 * resolved (the #275 publicly_accessible oscillation). Returns "" when there is
 * at most one such comment (nothing prior to show).
 */
export function extractAllReviewFindingsHistory(
  comments: { body: string }[],
  round: 1 | 2,
): string {
  const marker = `## Review ${round}`;
  const matches = comments.filter(
    (c) =>
      c.body.startsWith(marker) &&
      (c.body.includes("needs-attention") ||
        c.body.includes("### Findings") ||
        c.body.toUpperCase().includes("REQUEST_CHANGES") ||
        c.body.toUpperCase().includes("REQUEST CHANGES")),
  );
  if (matches.length <= 1) return "";
  return matches
    .slice(0, -1)
    .map((c, i) => `--- Prior review ${round} attempt ${i + 1} ---\n${c.body}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// OpenSpec spec-delta validation (#106) — exported for direct unit testing
// ---------------------------------------------------------------------------

async function defaultGitDiffFiles(wtPath: string, from: string, to: string): Promise<string[]> {
  const r = await gitInWorktree(wtPath, ["diff", "--name-only", from, to], { ignoreFailure: true });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * After a fix harness runs, check whether it revised any OpenSpec spec delta
 * files (`openspec/changes/<id>/specs/**`). When it did, validate that change
 * before push. A structural validation failure blocks the fix round so the LLM
 * cannot silently commit a broken spec delta. Returns `{ ok: true }` when no
 * spec files were touched or all touched changes pass validation. Exported for
 * direct unit testing; called from `advanceFix` with injectable deps.
 */
export async function enforceOpenspecSpecDeltaValidation(
  wtPath: string,
  headBefore: string,
  headAfter: string,
  deps: {
    gitDiffFiles: (wtPath: string, from: string, to: string) => Promise<string[]>;
    openspecValidateItem: (wtPath: string, id: string) => Promise<ValidateResult>;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (headBefore === headAfter) return { ok: true };
  const changed = await deps.gitDiffFiles(wtPath, headBefore, headAfter);
  const specDeltaIds = new Set<string>();
  for (const f of changed) {
    const m = f.replace(/\\/g, "/").match(/^openspec\/changes\/([^/]+)\/specs\//);
    if (m) specDeltaIds.add(m[1]);
  }
  if (specDeltaIds.size === 0) return { ok: true };
  for (const id of specDeltaIds) {
    const vr = await deps.openspecValidateItem(wtPath, id);
    if (!vr.valid && !vr.unavailable) {
      const detail =
        vr.issues.map((i) => i.message).filter(Boolean).join("; ") || vr.raw.slice(0, 400);
      return {
        ok: false,
        reason:
          `OpenSpec change '${id}' spec delta is structurally invalid after fix-round revision: ` +
          `${detail}. Resolve the validation error before advancing.`,
      };
    }
  }
  return { ok: true };
}
