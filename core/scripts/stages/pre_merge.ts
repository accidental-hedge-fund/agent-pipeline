// Pre-merge gate: OpenSpec archive (once) → conflict pre-check → CI gate →
// mergeability gate → ready-to-deploy.
//
// Returns { advanced: false, status: "waiting" } when CI is still running.
// The caller (pipeline.ts loop) breaks on waiting so the user can re-invoke
// later.
//
// We deliberately do NOT auto-merge. The terminal stage is just the
// `pipeline:ready-to-deploy` label.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  findLatestCommentMatching,
  getIssueDetail,
  getPrChecks,
  getPrCommits,
  getPrDetail,
  getPrForIssue,
  parseChecksAggregate,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { branchName, getForIssue, gitInWorktree } from "../worktree.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
import { extractReviewedSha } from "./review.ts";
import * as openspec from "../openspec.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

const OPENSPEC_ARCHIVE_PREFIX = "chore: archive OpenSpec change(s) for #";
const REBASE_MARKER_FILE = ".pipeline-rebase-attempted";

/**
 * True when a commit was authored by the pipeline itself in pre-merge (an
 * OpenSpec archive) rather than by a developer/fix step. These commits do not
 * change the code the reviewer evaluated, so they must not invalidate the
 * review verdict (#98). Matched on the exact pre-merge commit prefix — a
 * developer's own `chore:` commit with different wording does NOT match and
 * still triggers a re-review. A `docs: update documentation for #N` commit is
 * NOT pipeline-internal: the pre-merge docs harness was removed (#91, docs now
 * land inside the reviewed implementation diff), so any such commit can only
 * come from a developer. Exported for tests.
 */
export function isPipelineInternalCommit(messageHeadline: string): boolean {
  return messageHeadline.startsWith(OPENSPEC_ARCHIVE_PREFIX);
}

export interface AdvancePreMergeOpts {
  dryRun?: boolean;
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
}

/**
 * External seams for {@link advance}, overridable in tests so the gate
 * sequence (SHA gate → archive → conflict pre-check → CI → mergeability →
 * advance) can be exercised without GitHub or a worktree. Extends
 * {@link ShaGateDeps} so one bag also feeds the review-SHA gate. Mirrors the
 * DI pattern used elsewhere (review.ts, testgate.ts).
 */
export interface AdvancePreMergeDeps extends ShaGateDeps {
  getPrForIssue?: typeof getPrForIssue;
  getPrChecks?: typeof getPrChecks;
  getForIssue?: typeof getForIssue;
  setBlocked?: typeof setBlocked;
  tryRebaseAndPush?: typeof tryRebaseAndPush;
  rebaseAlreadyAttempted?: typeof rebaseAlreadyAttempted;
  markRebaseAttempted?: typeof markRebaseAttempted;
  // Seams for the OpenSpec archive step + its consistency guard (#106), so
  // maybeArchiveOpenspec is testable without a real worktree, git, openspec
  // CLI, or GitHub.
  gitInWorktree?: typeof gitInWorktree;
  openspecIsActive?: typeof openspec.isActive;
  changeDirExists?: typeof openspec.changeDirExists;
  openspecArchive?: typeof openspec.archive;
  /** Repo-relative paths changed by the branch's fix-round commits (guard input). */
  branchFixDiffPaths?: (wtPath: string, baseBranch: string) => Promise<string[]>;
}

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome> {
  const getPrForIssueFn = deps.getPrForIssue ?? getPrForIssue;
  const getPrChecksFn = deps.getPrChecks ?? getPrChecks;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const transitionFn = deps.transition ?? transition;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;

  console.log(`[pipeline] #${issueNumber}: pre-merge gate`);

  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(cfg, issueNumber, "No pull request found for pre-merge gate.", "pre-merge");
    return { advanced: false, status: "blocked", reason: "no PR" };
  }

  if (opts.dryRun) {
    const dryNextStage = cfg.eval_gate.enabled ? "eval-gate" : "ready-to-deploy";
    console.log(`[pipeline] #${issueNumber}: [dry-run] would archive+CI+merge for PR #${prNumber}`);
    return { advanced: true, from: "pre-merge", to: dryNextStage, summary: "[dry-run]" };
  }

  // ---- Review-SHA gate (#16): runs before any pre-merge work ----
  // pre-merge is the only stage that acts on a prior review verdict without
  // re-running review, so it is where a stale approval would slip through. If
  // HEAD has moved past the reviewed commit via a developer/fix commit, bounce
  // back to the review round before doing any pre-merge work; pipeline-internal
  // commits (openspec archive) do not invalidate the verdict.
  const shaGate = await enforceReviewShaGate(cfg, issueNumber, prNumber, deps);
  if (shaGate) return shaGate;

  // ---- Step 0: OpenSpec archive (once; folds change deltas into living specs) ----
  const archiveOutcome = await maybeArchiveOpenspec(cfg, issueNumber, pipelineRunId, deps);
  if (archiveOutcome) return archiveOutcome;

  // ---- Step 0.5: early conflict detection (#95) ----
  // GitHub cannot build the pull_request merge ref for a CONFLICTING PR, so
  // no pull_request-triggered check runs are ever created — polling for
  // checks would wait out ci_timeout for runs that cannot appear. Fetch PR
  // detail and route a conflict straight to the rebase path. UNKNOWN (GitHub
  // still computing mergeability) is NOT a conflict and falls through to the
  // CI poll.
  const prDetail = await getPrDetailFn(cfg, prNumber);
  // Narrow predicate: only CONFLICTING (mergeable === false) or an explicit DIRTY
  // merge state bypasses the CI poll. BEHIND/BLOCKED map to "conflict" in the
  // broader parseMergeable() but represent out-of-date branch or branch protection —
  // not a real merge conflict — so they must fall through to the CI poll.
  const isEarlyConflict =
    prDetail.mergeable === false ||
    (prDetail.mergeable_state ?? "").toUpperCase() === "DIRTY";
  if (isEarlyConflict) {
    console.log(`[pipeline] #${issueNumber}: PR #${prNumber} is conflicting; skipping CI poll`);
    return recoverFromMergeConflict(cfg, issueNumber, deps);
  }

  // ---- Step 1: CI ----
  let checks;
  try {
    checks = await getPrChecksFn(cfg, prNumber);
  } catch (err) {
    const e = err as Error;
    return { advanced: false, status: "waiting", reason: `gh pr checks failed: ${e.message}` };
  }

  const agg = parseChecksAggregate(checks);
  if (agg.pending) {
    return { advanced: false, status: "waiting", reason: "CI still running" };
  }

  if (agg.failed.length > 0) {
    const wt = await getForIssueFn(cfg, issueNumber);
    const alreadyRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
    if (!alreadyRebased && wt) {
      const ok = await tryRebaseAndPushFn(cfg, issueNumber);
      if (ok) {
        markRebaseAttemptedFn(wt.path);
        return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
      }
    }
    await setBlockedFn(
      cfg,
      issueNumber,
      `CI checks failed:\n${agg.failed.map((c) => `- ${c.name}: ${c.bucket}`).join("\n")}`,
      "pre-merge",
    );
    return { advanced: false, status: "blocked", reason: "CI failed" };
  }

  // ---- Step 2: mergeability ----
  // Re-fetch after CI passes to catch conflicts that developed while CI was
  // running. Reusing the pre-CI snapshot could let a PR that became
  // CONFLICTING after the early check slip through to ready-to-deploy.
  // Use a narrow true-conflict predicate (same as Step 0.5) rather than
  // parseMergeable(), which also maps BEHIND/BLOCKED to "conflict". BEHIND
  // is an out-of-date branch (code is compatible, not conflicting); BLOCKED
  // is branch-protection preventing the merge. Routing those states to
  // recoverFromMergeConflict consumes the rebase marker and then blocks on
  // the next poll with a misleading "merge conflict — manual rebase needed"
  // reason for a PR that never had a real code conflict.
  const freshPrDetail = await getPrDetailFn(cfg, prNumber);
  const freshState = (freshPrDetail.mergeable_state ?? "").toUpperCase();
  const isFreshConflict = freshPrDetail.mergeable === false || freshState === "DIRTY";
  if (isFreshConflict) {
    return recoverFromMergeConflict(cfg, issueNumber, deps);
  }
  if (freshState === "BEHIND") {
    // BEHIND means the branch is out-of-date but has no code conflict.
    // Attempt one auto-rebase (same marker guard as the CONFLICTING path).
    // A second poll with the marker set blocks with a behind-specific reason,
    // not a conflict reason. BLOCKED (branch protection) is not updatable
    // by a rebase and stays as passive waiting.
    const behindWt = await getForIssueFn(cfg, issueNumber);
    const behindAlreadyRebased = behindWt ? rebaseAlreadyAttemptedFn(behindWt.path) : true;
    if (!behindAlreadyRebased && behindWt) {
      const ok = await tryRebaseAndPushFn(cfg, issueNumber);
      if (ok) {
        markRebaseAttemptedFn(behindWt.path);
        return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
      }
    }
    await setBlockedFn(
      cfg,
      issueNumber,
      "PR branch is behind the base branch and could not be automatically updated — manual rebase or update needed.",
      "pre-merge",
    );
    return { advanced: false, status: "blocked", reason: "branch behind base" };
  }
  if (freshState === "BLOCKED") {
    return { advanced: false, status: "waiting", reason: "GitHub mergeability: blocked" };
  }
  if (freshPrDetail.mergeable === null && freshState !== "CLEAN" && freshState !== "HAS_HOOKS") {
    return { advanced: false, status: "waiting", reason: "GitHub still computing mergeability" };
  }

  // ---- Step 2.5: OpenSpec validation gate (opt-in / auto-detected) ----
  // Only runs when the target repo has an `openspec/` workspace (or it's forced
  // on via config). Refuses ready-to-deploy if the change's specs/deltas are
  // structurally invalid. A missing `openspec` CLI is non-blocking (skipped).
  const specWt = await getForIssueFn(cfg, issueNumber);
  if (specWt && openspec.isActive(cfg, specWt.path)) {
    const spec = await openspec.validate(specWt.path);
    if (spec.unavailable) {
      console.log(
        `[pipeline] #${issueNumber}: openspec active but CLI unavailable; skipping spec validation (non-blocking)`,
      );
    } else if (!spec.valid) {
      const detail = spec.issues.length
        ? spec.issues.map((i) => `- ${i.item ? `${i.item}: ` : ""}${i.message}`).join("\n")
        : spec.raw;
      await setBlockedFn(
        cfg,
        issueNumber,
        `OpenSpec validation failed (\`openspec validate --all\`):\n${detail}`,
        "pre-merge",
      );
      return { advanced: false, status: "blocked", reason: "openspec validation failed" };
    } else {
      console.log(`[pipeline] #${issueNumber}: openspec validation passed`);
    }
  }

  // ---- Step 3: advance ----
  // Skip the eval-gate label entirely when evals are disabled to avoid spurious
  // label churn and pipeline comments on repos that did not opt in.
  const nextStage = cfg.eval_gate.enabled ? "eval-gate" : "ready-to-deploy";
  await transitionFn(
    cfg,
    issueNumber,
    "pre-merge",
    nextStage,
    `All pre-merge gates passed (CI green, no conflicts). Advancing to ${nextStage} for PR #${prNumber}.`,
  );
  return {
    advanced: true,
    from: "pre-merge",
    to: nextStage,
    summary: `PR #${prNumber} pre-merge gates passed`,
  };
}

// ---------------------------------------------------------------------------
// Review-SHA gate (#16): never advance on a stale approval
// ---------------------------------------------------------------------------

/**
 * External seams for {@link enforceReviewShaGate}, overridable in tests.
 * Mirrors the DI pattern used elsewhere (testgate.ts, review.ts).
 */
export interface ShaGateDeps {
  getIssueDetail?: typeof getIssueDetail;
  getPrDetail?: typeof getPrDetail;
  getPrCommits?: typeof getPrCommits;
  postComment?: typeof postComment;
  transition?: typeof transition;
}

/**
 * Before pre-merge acts on the prior review verdict, verify the most recent
 * review comment still covers HEAD. Returns `null` to proceed (verdict fresh,
 * or nothing to validate), or an `advanced` Outcome that bounces the item back
 * to its review round when the verdict is stale (HEAD moved past the reviewed
 * commit) or unverifiable (no SHA sentinel). The orchestrator loop then re-runs
 * that review stage, which records the new SHA.
 */
export async function enforceReviewShaGate(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  deps: ShaGateDeps = {},
): Promise<Outcome | null> {
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const getPrCommitsFn = deps.getPrCommits ?? getPrCommits;
  const postCommentFn = deps.postComment ?? postComment;
  const transitionFn = deps.transition ?? transition;

  const detail = await getIssueDetailFn(cfg, issueNumber);
  const reviewed = extractReviewedSha(detail.comments);
  // No prior review comment (e.g. review steps disabled, or first run) → nothing
  // to validate; let pre-merge proceed as normal.
  if (!reviewed) return null;

  const head = (await getPrDetailFn(cfg, prNumber)).head_sha;

  // Exact match → the verdict still covers HEAD; proceed.
  if (reviewed.sha && reviewed.sha === head) return null;

  // HEAD moved past the reviewed commit. Re-review ONLY when a developer/fix
  // commit landed since the verdict — the pipeline's own pre-merge commits
  // (OpenSpec archive) do not change the reviewed code and must not
  // invalidate the verdict. Re-reviewing them re-ran the adversarial
  // reviewer on the pipeline's own commits every run, which (with a thorough
  // reviewer) turned each run into a non-converging cascade (#98). #16's value
  // is preserved: any non-internal commit in the range still bounces.
  if (reviewed.sha) {
    try {
      const commits = await getPrCommitsFn(cfg, prNumber);
      const reviewedIdx = commits.findIndex((c) => c.oid === reviewed.sha);
      if (reviewedIdx !== -1) {
        const landedSince = commits.slice(reviewedIdx + 1);
        if (
          landedSince.length > 0 &&
          landedSince.every((c) => isPipelineInternalCommit(c.messageHeadline))
        ) {
          // Only archive commits landed since the review → verdict valid.
          return null;
        }
      }
      // reviewed.sha absent from history (rebased/squashed) or a developer
      // commit landed → fall through to a re-review (the safe default).
    } catch {
      // If commit classification fails, fall through to re-review (conservative).
    }
  }

  const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
  await postCommentFn(cfg, issueNumber, staleReviewNotice(reviewed.sha, head));
  await transitionFn(
    cfg,
    issueNumber,
    "pre-merge",
    reviewStage,
    `Re-running review ${reviewed.round}: HEAD moved past the reviewed commit ` +
      `${reviewed.sha ? `\`${reviewed.sha.slice(0, 7)}\`` : "(unrecorded)"} → \`${head.slice(0, 7)}\`.`,
  );
  return {
    advanced: true,
    from: "pre-merge",
    to: reviewStage,
    summary: `re-review: HEAD moved to ${head.slice(0, 7)}`,
  };
}

/** The notice posted before a SHA-mismatch re-review. Pure; exported for tests. */
export function staleReviewNotice(reviewedSha: string | null, headSha: string): string {
  const newShort = headSha.slice(0, 7);
  const body = reviewedSha
    ? `Re-running review: HEAD has moved from \`${reviewedSha.slice(0, 7)}\` to \`${newShort}\` since the last review.`
    : `Re-running review: the last review did not record the commit it evaluated, ` +
      `so its verdict cannot be verified against current HEAD (\`${newShort}\`).`;
  return [
    "## Pipeline: Re-running review",
    "",
    body,
    "",
    "The prior review verdict is discarded; review re-runs against the current commit before this item can advance.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// OpenSpec archive (once per PR)
// ---------------------------------------------------------------------------

/**
 * When OpenSpec is active, archive the change(s) this PR branch introduced so
 * their spec deltas fold into the living `openspec/specs/`. Idempotent: a change
 * already archived is no longer an active dir, so it drops out of the candidate
 * set. Returns a `waiting` Outcome after pushing (CI must re-run), a `blocked`
 * Outcome on failure or a stale-delta divergence (#106), or null when there is
 * nothing to do (continue the gate). Exported for tests; all I/O is injectable
 * via {@link AdvancePreMergeDeps}.
 */
export async function maybeArchiveOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
  pipelineRunId: string,
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome | null> {
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const gitFn = deps.gitInWorktree ?? gitInWorktree;
  const isActiveFn = deps.openspecIsActive ?? openspec.isActive;
  const changeDirExistsFn = deps.changeDirExists ?? openspec.changeDirExists;
  const archiveFn = deps.openspecArchive ?? openspec.archive;
  const branchFixDiffPathsFn =
    deps.branchFixDiffPaths ?? ((wtPath, base) => computeFixDiffPaths(gitFn, wtPath, base));

  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt || !isActiveFn(cfg, wt.path)) return null;

  // Changes this PR branch introduced, still active (not yet archived).
  const diff = await gitFn(
    wt.path,
    ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
    { ignoreFailure: true },
  );
  const candidates = openspec
    .changeIdsFromPaths(diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
    .filter((id) => changeDirExistsFn(wt.path, id));
  if (candidates.length === 0) return null; // already archived, or none

  // ---- Consistency guard (#106): never archive a delta the code outgrew ----
  // OpenSpec deltas are authored at planning time and frozen; fix rounds only
  // edit code. If a material fix moved the implementation but left the change's
  // specs/** untouched AND the reviewer flagged the divergence, archiving would
  // fold a stale delta into the living specs (silent corruption) and re-review
  // would keep re-anchoring on the wrong delta. Block and surface it instead.
  const guard = await enforceSpecConsistencyGuard(cfg, issueNumber, wt.path, candidates, {
    branchFixDiffPaths: branchFixDiffPathsFn,
    getIssueDetail: getIssueDetailFn,
    setBlocked: setBlockedFn,
  });
  if (guard) return guard;

  console.log(`[pipeline] #${issueNumber}: archiving OpenSpec change(s): ${candidates.join(", ")}`);
  for (const id of candidates) {
    const res = await archiveFn(wt.path, id);
    if (res.unavailable) {
      console.log(
        `[pipeline] #${issueNumber}: openspec CLI unavailable; skipping archive (non-blocking)`,
      );
      return null;
    }
    if (!res.success) {
      await setBlockedFn(cfg, issueNumber, `openspec archive ${id} failed:\n${res.output}`, "pre-merge");
      return { advanced: false, status: "blocked", reason: `openspec archive failed (${id})` };
    }
  }

  // Commit + push the archived specs so CI validates the finalized state.
  await gitFn(wt.path, ["add", "-A"], { ignoreFailure: true });
  const status = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (!status.stdout.trim()) return null; // archive produced no diff (unexpected) → continue
  await gitFn(
    wt.path,
    ["commit", "-m", withTrailers(`${OPENSPEC_ARCHIVE_PREFIX}${issueNumber}`, issueNumber, pipelineRunId)],
    { ignoreFailure: true },
  );
  const push = await gitFn(wt.path, ["push", "origin", branchName(issueNumber, wt.slug)], {
    ignoreFailure: true,
  });
  if (push.code !== 0) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Git push failed after OpenSpec archive: ${push.stderr.trim()}`,
      "pre-merge",
    );
    return { advanced: false, status: "blocked", reason: "push failed after archive" };
  }
  console.log(`[pipeline] #${issueNumber}: OpenSpec change(s) archived; CI will re-run`);
  return { advanced: false, status: "waiting", reason: "openspec change archived; CI re-running" };
}

// ---------------------------------------------------------------------------
// OpenSpec spec/code consistency guard (#106)
// ---------------------------------------------------------------------------

/** Deps for {@link enforceSpecConsistencyGuard} — injectable fakes in tests. */
export interface SpecConsistencyDeps {
  branchFixDiffPaths: (wtPath: string, baseBranch: string) => Promise<string[]>;
  getIssueDetail: typeof getIssueDetail;
  setBlocked: typeof setBlocked;
}

/**
 * Pre-archive backstop for "fix rounds don't revise the change" (#106). Returns
 * a blocked Outcome (and labels the issue) when a change's spec delta is stale
 * relative to the implementation, or null to proceed. "Stale" requires all of:
 *   1. fix-round commits changed implementation files,
 *   2. the change's `specs/**` were NOT among those changes, and
 *   3. the most recent review verdict flagged a code/spec divergence.
 * Missing any one → proceed (conservative-open: avoid false positives on fix
 * rounds that correctly left a still-accurate spec unchanged). Exported for tests.
 */
export async function enforceSpecConsistencyGuard(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  changeIds: string[],
  deps: SpecConsistencyDeps,
): Promise<Outcome | null> {
  const fixDiffPaths = await deps.branchFixDiffPaths(wtPath, cfg.base_branch);
  // No fix-round commits → the implementation never moved after planning, so a
  // fix cannot have drifted the delta. Nothing to guard.
  if (fixDiffPaths.length === 0) return null;

  const stale = changeIds.find((id) => specDeltaIsStale(id, fixDiffPaths));
  if (!stale) return null;

  // The structural signal (code changed, spec didn't) only matters if the
  // reviewer actually saw a divergence — otherwise the spec is presumed
  // consistent (the reviewer reviewed against it and did not object), and the
  // frozen delta is helping (case A: code drifted from a correct spec).
  // Only inspect the structured "### Findings" block, not the full review body:
  // an approving summary like "No divergence from the OpenSpec delta; matches"
  // would otherwise trip the guard even though no finding flags divergence.
  const detail = await deps.getIssueDetail(cfg, issueNumber);
  const reviewBody = latestReviewBody(detail.comments);
  const findingsSection = reviewBody ? extractFindingsSection(reviewBody) : null;
  if (!findingsSection || !reviewFlagsSpecDivergence(findingsSection)) return null;

  await deps.setBlocked(cfg, issueNumber, staleSpecDeltaBlockReason(stale), "pre-merge");
  return { advanced: false, status: "blocked", reason: `stale OpenSpec delta (${stale})` };
}

const FIX_COMMIT_RE = /^fix:\s+address review \d+ findings/i;

/**
 * Repo-relative paths changed by the branch's fix-round commits — the diff from
 * the parent of the FIRST `fix: address review N findings` commit through HEAD.
 * The full branch diff cannot be used: planning authors the spec deltas on the
 * same branch, so `specs/**` would always appear "changed" and the guard could
 * never detect a fix that left them behind. Returns [] when the branch has no
 * fix commit (no fix round ran).
 */
async function computeFixDiffPaths(
  gitFn: typeof gitInWorktree,
  wtPath: string,
  baseBranch: string,
): Promise<string[]> {
  const log = await gitFn(
    wtPath,
    ["log", "--reverse", "--format=%H%x1f%s", `origin/${baseBranch}..HEAD`],
    { ignoreFailure: true },
  );
  let firstFixSha: string | null = null;
  for (const line of log.stdout.split("\n")) {
    const sep = line.indexOf("\x1f");
    if (sep === -1) continue;
    const sha = line.slice(0, sep).trim();
    if (sha && FIX_COMMIT_RE.test(line.slice(sep + 1).trim())) {
      firstFixSha = sha;
      break;
    }
  }
  if (!firstFixSha) return [];
  const diff = await gitFn(wtPath, ["diff", "--name-only", `${firstFixSha}^`, "HEAD"], {
    ignoreFailure: true,
  });
  return diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Structural half of the guard: did fix rounds change implementation files
 * (anything outside `openspec/`) while leaving change `id`'s spec deltas
 * untouched? Pure; exported for tests.
 */
export function specDeltaIsStale(id: string, fixDiffPaths: string[]): boolean {
  const paths = fixDiffPaths.map((p) => p.replace(/\\/g, "/").trim()).filter(Boolean);
  if (paths.length === 0) return false;
  const specPrefix = `openspec/changes/${id}/specs/`;
  const specUpdated = paths.some((p) => p.startsWith(specPrefix));
  const touchedImpl = paths.some((p) => !p.startsWith("openspec/"));
  return touchedImpl && !specUpdated;
}

/**
 * Extracts the content of the `### Findings` block from a formatted review
 * comment, returning null when no such section exists. This restricts the
 * divergence guard to actual reviewer findings rather than the summary prose,
 * preventing approving summaries that incidentally mention "divergence" or
 * "spec" from being misread as flagging a code/spec divergence.
 */
function extractFindingsSection(reviewBody: string): string | null {
  const marker = "\n### Findings";
  const start = reviewBody.indexOf(marker);
  if (start === -1) return null;
  const after = reviewBody.slice(start + marker.length);
  const nextSection = after.search(/\n###? /);
  return nextSection === -1 ? after : after.slice(0, nextSection);
}

/**
 * Verdict half of the guard: does a review verdict body flag a divergence
 * between the implementation and the spec delta? Requires both a spec/requirement
 * reference AND a divergence cue, so an incidental "spec" mention does not trip
 * it. Pure; exported for tests.
 */
export function reviewFlagsSpecDivergence(reviewBody: string): boolean {
  const t = reviewBody.toLowerCase();
  const mentionsSpec = /\b(?:open)?spec(?:s|ification)?\b/.test(t) || t.includes("requirement");
  if (!mentionsSpec) return false;
  return (
    /\bdiverg(?:e|es|ed|ing|ence)\b/.test(t) ||
    /\binconsisten(?:t|cy)\b/.test(t) ||
    /\b(?:does not|doesn't|did not|didn't|no longer)\s+(?:match|matches|reflect|reflects|describe|describes|capture|captures|align|aligns)\b/.test(t) ||
    /\bout of (?:sync|date)\b/.test(t) ||
    /\b(?:stale|outdated)\b/.test(t) ||
    /\bcontradicts?\b/.test(t) ||
    /\bmismatch(?:es|ed)?\b/.test(t)
  );
}

/** Latest review verdict comment body (round 1 or 2), or null when none exists. */
function latestReviewBody(
  comments: { author: string; body: string; createdAt: string }[],
): string | null {
  const m = findLatestCommentMatching(
    comments,
    (b) => b.startsWith("## Review 1") || b.startsWith("## Review 2"),
  );
  return m?.body ?? null;
}

/** Operator-facing block reason naming the stale-delta condition and the fix. */
function staleSpecDeltaBlockReason(id: string): string {
  return [
    `OpenSpec change \`${id}\` has a stale spec delta: fix rounds changed implementation files but did`,
    `not update the change's \`specs/**\`, and the most recent review verdict flagged a divergence between`,
    `the code and the spec. Archiving now would fold a delta into the living \`openspec/specs/\` that does`,
    `not describe the merged implementation.`,
    ``,
    `To resolve, update \`openspec/changes/${id}/specs/**\` (and \`tasks.md\`) so the spec matches the`,
    `implemented behavior, then re-run \`openspec validate ${id}\` and push. Any commit that brings the`,
    `spec delta into agreement clears this guard. If the reviewer's divergence finding is a false positive,`,
    `the correct resolution is still to update the delta so the living spec states the actual behavior.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rebase tracking
// ---------------------------------------------------------------------------

/**
 * Conflict recovery shared by the early-conflict check (#95) and the Step 2
 * mergeability gate: attempt one auto-rebase, bounded by the per-worktree
 * rebase marker so an unresolvable conflict cannot retry a rebase on every
 * poll iteration. When the rebase cannot resolve the conflict (or was already
 * attempted), blocks with a conflict-specific reason rather than a generic
 * CI-timeout or CI-failure message.
 */
async function recoverFromMergeConflict(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome> {
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;

  const wt = await getForIssueFn(cfg, issueNumber);
  const alreadyRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
  if (!alreadyRebased && wt) {
    const ok = await tryRebaseAndPushFn(cfg, issueNumber);
    if (ok) {
      markRebaseAttemptedFn(wt.path);
      return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
    }
  }
  await setBlockedFn(
    cfg,
    issueNumber,
    "PR has a merge conflict with the base branch that could not be automatically rebased — manual rebase needed.",
    "pre-merge",
  );
  return { advanced: false, status: "blocked", reason: "merge conflict" };
}

function rebaseAlreadyAttempted(wtPath: string): boolean {
  return fs.existsSync(path.join(wtPath, REBASE_MARKER_FILE));
}

function markRebaseAttempted(wtPath: string): void {
  fs.writeFileSync(path.join(wtPath, REBASE_MARKER_FILE), "1");
}

async function tryRebaseAndPush(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<boolean> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) return false;
  const branch = branchName(issueNumber, wt.slug);

  const fetch = await gitInWorktree(wt.path, ["fetch", "origin", cfg.base_branch], {
    ignoreFailure: true,
  });
  if (fetch.code !== 0) return false;

  const rebase = await gitInWorktree(wt.path, ["rebase", `origin/${cfg.base_branch}`], {
    ignoreFailure: true,
  });
  if (rebase.code !== 0) {
    await gitInWorktree(wt.path, ["rebase", "--abort"], { ignoreFailure: true });
    return false;
  }

  const push = await gitInWorktree(
    wt.path,
    ["push", "--force-with-lease", "origin", branch],
    { ignoreFailure: true },
  );
  return push.code === 0;
}

/**
 * Polling loop: invoke `advance` repeatedly until it advances, blocks, or
 * exhausts the CI timeout. Used by the top-level orchestrator. Returns the
 * last outcome.
 */
export async function advancePolling(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
): Promise<Outcome> {
  const deadline = Date.now() + cfg.ci_timeout * 1000;
  let last: Outcome | null = null;
  while (Date.now() < deadline) {
    last = await advance(cfg, issueNumber, opts);
    if (last.advanced) return last;
    if (!last.advanced && last.status !== "waiting") return last;
    // waiting → sleep and try again
    await new Promise((r) => setTimeout(r, cfg.ci_poll_interval * 1000));
  }
  return last ?? { advanced: false, status: "waiting", reason: "timed out polling pre-merge" };
}
