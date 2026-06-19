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
import { branchName, getForIssue, gitInWorktree, reattachIfDetached } from "../worktree.ts";
import { buildFixPrompt } from "../prompts/index.ts";
import { runFormatGate, runFormatAndTestGates } from "./format-gate.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import { makePipelineRunId } from "../traceability.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import * as openspec from "../openspec.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import type { ValidateResult } from "../openspec.ts";
import { makePromptRecord, recordPrompt } from "../evidence-bundle.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";
import { extractBlockingKeysMarker } from "./review.ts";

export interface AdvanceFixOpts {
  dryRun?: boolean;
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
  /** Evidence-bundle run/state dir (#147); when set, the test gate records its
   *  command runs under this round's stage. Undefined → recording disabled. */
  stateDir?: string;
}

/** Injectable seams for {@link advanceFix} — overridable in tests. */
export interface AdvanceFixDeps {
  /** Files changed between two SHAs (defaults to `git diff --name-only from to`). */
  gitDiffFiles?: (wtPath: string, from: string, to: string) => Promise<string[]>;
  /** Validate one OpenSpec change (defaults to `openspec.validateItem`). */
  openspecValidateItem?: (wtPath: string, id: string) => Promise<ValidateResult>;
  /** Format/lint gate runner (#182); defaults to runFormatGate. */
  runFormatGate?: typeof runFormatGate;
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
    await setBlocked(cfg, issueNumber, "No worktree found. Cannot apply fixes.", stage, "worktree-missing");
    return { advanced: false, status: "blocked", reason: "no worktree" };
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const findings = extractBlockingReviewFindings(detail.comments, round);
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

  // Ensure the worktree is on its pipeline branch before the harness commits.
  // The review stage may have checked out a specific SHA (detached HEAD); any
  // commits made while detached don't move the branch ref, so the later push
  // would silently leave the PR branch unchanged.
  const reattach = await reattachIfDetached(wt, issueNumber);
  if (!reattach.ok) {
    await setBlocked(
      cfg, issueNumber,
      `Failed to reattach detached worktree to pipeline branch: ${reattach.stderr}`,
      stage, "needs-human",
    );
    return { advanced: false, status: "blocked", reason: "reattach failed" };
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
    cfg,
    issueNumber,
    title: detail.title,
    reviewFindings: findings,
    priorReviewHistory: extractAllReviewFindingsHistory(detail.comments, round),
    fixRound: round,
    pipelineRunId,
    specContext,
  });
  if (opts.stateDir) {
    await recordPrompt(
      opts.stateDir,
      issueNumber,
      stage,
      makePromptRecord(`fix-${round}`, harness, prompt),
    ).catch(() => {});
  }
  const result = await invoke(harness, wt.path, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: opts.model ?? cfg.models.fix,
    sandbox: cfg.harness_sandbox,
  });

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await setBlocked(cfg, issueNumber, `Fix harness (${harness}) failed: ${reason}`, stage, "harness-failure");
    return { advanced: false, status: "blocked", reason };
  }

  let headAfter = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();
  if (headBefore && headAfter && headBefore === headAfter) {
    // #131: the harness reported success without committing — salvage real
    // uncommitted work into a commit instead of discarding it. A clean
    // worktree (nothing salvaged) keeps the existing block path.
    const salvaged = await trySalvageUncommittedWork(
      wt.path,
      issueNumber,
      pipelineRunId,
      fixSalvageStageLabel(round, issueNumber),
    );
    if (!salvaged) {
      await setBlocked(
        cfg,
        issueNumber,
        `${stage} reported success but produced no new commits.`,
        stage,
        "no-commits",
      );
      return { advanced: false, status: "blocked", reason: "no new commits" };
    }
    headAfter = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();
  }

  // ---- Verify fix-round commit message format (#68) ----
  if (headBefore) {
    const commitCheck = await enforceFixCommitGate(round, issueNumber, wt.path, headBefore);
    if (!commitCheck.ok) {
      await setBlocked(cfg, issueNumber, commitCheck.reason, stage, "needs-human");
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
      await setBlocked(cfg, issueNumber, specCheck.reason, stage, "openspec-invalid");
      return { advanced: false, status: "blocked", reason: specCheck.reason };
    }
  }

  // ---- Format + test gates to convergence (#182, #15) ----
  // The format/lint gate runs BEFORE the test gate and both re-run until neither
  // produces a new commit, so the pushed fix state is simultaneously formatted
  // and tested — no auto-format commit ships untested, no test-fix commit unformatted.
  const fmtGateFn = deps.runFormatGate ?? runFormatGate;
  const gates = await runFormatAndTestGates(
    cfg, issueNumber, wt.path, stage, pipelineRunId, opts.stateDir,
    { runFormatGate: fmtGateFn },
  );
  if (!gates.ok) {
    await setBlocked(
      cfg, issueNumber, gates.reason, stage,
      gates.source === "test" ? "test-gate-exhausted" : "needs-human",
    );
    return { advanced: false, status: "blocked", reason: gates.reason };
  }

  const branch = branchName(issueNumber, wt.slug);
  const push = await gitInWorktree(wt.path, ["push", "origin", branch], { ignoreFailure: true });
  if (push.code !== 0) {
    await setBlocked(
      cfg,
      issueNumber,
      `Git push failed after fix: ${push.stderr.trim()}`,
      stage,
      "push-failed",
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
// Salvage stage label (#131) — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Stage label for a salvaged fix-round commit. Includes the round's prescribed
 * commit subject so the salvage commit body satisfies `enforceFixCommitGate`'s
 * message pattern (matched against subject + body) and the salvaged run
 * proceeds to the test gate. Exported so tests can pin the label against the
 * gate's actual pattern (drift between the two fails the contract test).
 */
export function fixSalvageStageLabel(round: 1 | 2, issueNumber: number): string {
  return `fix-${round} (prescribed commit: "fix: address review ${round} findings (#${issueNumber})")`;
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
// Mixed-verdict filtering: strip advisory findings from the fix prompt (#236)
// ---------------------------------------------------------------------------

/**
 * Returns true only when the advisory sentinel appears in the formatter-owned
 * header zone of a finding block — the title line (`**N. ...`) and the optional
 * `Location:` line — before any reviewer-controlled prose (body, recommendation).
 *
 * The sentinel is emitted by formatReviewComment BEFORE f.body, so for a genuine
 * advisory finding it sits in this header zone. A blocking finding whose body or
 * recommendation text happens to contain the sentinel string will NOT match, because
 * the scan stops at the first non-header line.
 */
function advisoryMarkerInHeaderZone(block: string, marker: string): boolean {
  let seenTitle = false;
  for (const line of block.split("\n")) {
    if (!line) continue;
    if (line === marker) return true;
    if (!seenTitle && /^\*\*\d+\./.test(line)) { seenTitle = true; continue; }
    if (seenTitle && line.startsWith("Location:")) continue;
    break; // first non-header non-empty line → reviewer prose starts
  }
  return false;
}

/**
 * Removes non-blocking (advisory) findings from a review comment body so the
 * fix prompt's "Address EACH finding" instruction applies only to genuine
 * blockers. Advisory findings are identified by their `override-key` NOT
 * appearing in `blockingKeys`.
 *
 * Findings that carry no `override-key` token pass through unchanged (safety).
 * Returns the body unchanged when no advisory findings are present.
 * Exported for direct unit testing.
 */
export function filterToBlockingFindings(body: string, blockingKeys: Set<string>): string {
  const FINDINGS_HEADER = "\n### Findings";
  const OVERRIDE_KEY_RE = /`override-key: ([0-9a-f]{8})`/;
  // The pipeline-blocking-keys comment is a reliable footer boundary marker —
  // it is always emitted when blockingKeys is supplied to formatReviewComment,
  // and the footer text line immediately precedes it (separated by a single \n,
  // not \n\n, so the \n\n-based section-end detection below would miss it).
  const PK_MARKER = "\n<!-- pipeline-blocking-keys:";

  const findingsIdx = body.indexOf(FINDINGS_HEADER);
  if (findingsIdx === -1) return body;

  const beforeFindings = body.slice(0, findingsIdx);
  const afterFindingsLine = body.slice(findingsIdx + FINDINGS_HEADER.length);

  // Separate findings content from the footer. The cfgFooter text is preceded
  // by only a single \n (not \n\n) so it ends up attached to the last finding's
  // block when splitting by blank lines. To avoid discarding the footer along
  // with an advisory finding, locate the pipeline-blocking-keys comment and
  // back up one line to find the footer boundary.
  let findingsContent: string;
  let footer: string;

  const pkIdx = afterFindingsLine.indexOf(PK_MARKER);
  if (pkIdx !== -1) {
    // footerLineStart: one \n back from the \n that starts the PK comment.
    const footerLineStart = afterFindingsLine.lastIndexOf("\n", pkIdx - 1);
    const splitAt = footerLineStart !== -1 ? footerLineStart + 1 : pkIdx;
    findingsContent = afterFindingsLine.slice(0, splitAt);
    footer = afterFindingsLine.slice(splitAt);
  } else {
    // No PK marker (should not happen when called via extractBlockingReviewFindings
    // but handled as a safe fallback).
    const nextIdx = afterFindingsLine.search(/\n\n###|\n\n\*/);
    findingsContent = nextIdx !== -1 ? afterFindingsLine.slice(0, nextIdx) : afterFindingsLine;
    footer = nextIdx !== -1 ? afterFindingsLine.slice(nextIdx) : "";
  }

  // Split on blank-line + "**N." (finding boundary) OR blank-line + "##"
  // (section boundary like "### Raw Review Output" or "### Next Steps"), so
  // those optional sections are not accidentally discarded with an advisory block.
  const blocks = findingsContent.split(/\n\n(?=\*\*\d+\.|\#\#)/);

  // Per-finding advisory marker emitted by formatReviewComment for reviewer-marked
  // non-blocking findings (#236 fix 2). Takes precedence over the key-set check so
  // a blocking:false finding that shares a key with a genuine blocker is still excluded.
  // The marker is emitted BEFORE reviewer-controlled fields (body, recommendation) so
  // it can be detected safely in the formatter-owned header zone; see fix #236 delta.
  const ADVISORY_FINDING_MARKER = "<!-- pipeline-advisory-finding -->";

  const blocking: string[] = [];
  let advisoryCount = 0;

  for (const block of blocks) {
    if (!block.trim()) continue;
    // Per-finding marker beats key-set: a reviewer-marked advisory finding is
    // excluded even when its override-key collides with a blocking finding's key.
    // Check only the formatter-controlled header zone (title + Location: lines)
    // to avoid being spoofed by reviewer prose that contains the sentinel string.
    if (advisoryMarkerInHeaderZone(block, ADVISORY_FINDING_MARKER)) {
      advisoryCount++;
      continue;
    }
    const keyMatch = block.match(OVERRIDE_KEY_RE);
    const key = keyMatch?.[1];
    if (!key || blockingKeys.has(key)) {
      blocking.push(block);
    } else {
      advisoryCount++;
    }
  }

  if (advisoryCount === 0) return body;

  const note = advisoryCount === 1
    ? "Note: 1 advisory finding was omitted (marked non-blocking by the reviewer — not required work for this fix round)."
    : `Note: ${advisoryCount} advisory findings were omitted (marked non-blocking by the reviewer — not required work for this fix round).`;

  return [
    beforeFindings,
    FINDINGS_HEADER,
    ...blocking.map(b => "\n\n" + b),
    "\n\n" + note + "\n",
    footer,
  ].join("");
}

/**
 * Like {@link extractReviewFindings} but filters advisory (non-blocking) findings
 * out of the returned body so the fix harness only sees blocking findings (#236).
 * Relies on the `pipeline-blocking-keys` marker in the review comment. Returns
 * the body unchanged when no marker is present (legacy comments) or when all
 * findings are blocking.
 */
export function extractBlockingReviewFindings(
  comments: { body: string }[],
  round: 1 | 2,
): string {
  const body = extractReviewFindings(comments, round);
  if (!body) return body;

  const blockingKeys = extractBlockingKeysMarker(body);
  if (!blockingKeys || blockingKeys.size === 0) return body;

  return filterToBlockingFindings(body, blockingKeys);
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
