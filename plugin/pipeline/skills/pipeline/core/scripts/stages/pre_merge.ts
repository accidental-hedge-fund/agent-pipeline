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
  getGhActor,
  getIssueDetail,
  getPrChecks,
  getPrCommits,
  getPrDetail,
  getPrDiff,
  getPrForIssue,
  parseChecksAggregate,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { branchName, getForIssue, gitInWorktree } from "../worktree.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
import {
  computeDiffHash,
  DELTA_REVIEW_MARKER_PREFIX,
  diffFilePaths,
  extractBlockingKeysFromComment,
  extractBlockingKeysMarker,
  extractDiffHashFromComment,
  findLatestReviewCommentBody,
  formatDeltaReviewComment,
  extractReviewedSha,
  parseStructuredVerdict,
} from "./review.ts";
import {
  extractOverrides,
  extractScopedOverrides,
  findingKey,
  partitionFindings,
  reviewCommentFlagsSpecDivergence,
} from "../review-policy.ts";
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
import { buildDeltaReviewPrompt } from "../prompts/index.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import * as openspec from "../openspec.ts";
import type { ReviewFinding } from "../types.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
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
  /** Evidence-bundle run/state dir (#147); when set, key pre-merge operations
   *  (CI checks, OpenSpec archive push, rebase) are recorded under "pre-merge".
   *  Undefined → recording disabled. */
  stateDir?: string;
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
  /** Per-commit paths for all non-pipeline-internal branch commits (guard input). */
  branchDeveloperCommits?: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>;
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
    await setBlockedFn(cfg, issueNumber, "No pull request found for pre-merge gate.", "pre-merge", "needs-human");
    return { advanced: false, status: "blocked", reason: "no PR" };
  }

  if (opts.dryRun) {
    const dryNextStage = cfg.eval_gate.enabled
      ? "eval-gate"
      : cfg.shipcheck_gate?.enabled ? "shipcheck-gate" : "ready-to-deploy";
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
  const archiveOutcome = await maybeArchiveOpenspec(cfg, issueNumber, pipelineRunId, deps, opts.stateDir);
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
    return recoverFromMergeConflict(cfg, issueNumber, opts.stateDir, deps);
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

  // Record CI check result evidence; skip when still pending (no result yet).
  if (opts.stateDir && !agg.pending) {
    const ciSummary = agg.failed.length > 0
      ? agg.failed.map((c) => `${c.name}: ${c.bucket}`).join(", ")
      : `all ${checks.length} check(s) passed`;
    await recordCommand(
      opts.stateDir,
      issueNumber,
      "pre-merge",
      makeCommandRecord(`gh pr checks #${prNumber}`, agg.failed.length > 0 ? 1 : 0, 0, ciSummary),
    ).catch(() => {});
  }

  if (agg.pending) {
    return { advanced: false, status: "waiting", reason: "CI still running" };
  }

  if (agg.failed.length > 0) {
    const wt = await getForIssueFn(cfg, issueNumber);
    const alreadyRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
    if (!alreadyRebased && wt) {
      const ok = await tryRebaseAndPushFn(cfg, issueNumber);
      if (opts.stateDir) {
        await recordCommand(
          opts.stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
            ok ? 0 : 1,
            0,
            ok ? "rebase and push succeeded; CI re-running" : "rebase or push failed",
          ),
        ).catch(() => {});
      }
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
      "needs-human",
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
    return recoverFromMergeConflict(cfg, issueNumber, opts.stateDir, deps);
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
      if (opts.stateDir) {
        await recordCommand(
          opts.stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
            ok ? 0 : 1,
            0,
            ok ? "rebase and push succeeded; CI re-running" : "rebase or push failed",
          ),
        ).catch(() => {});
      }
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
      "merge-conflict",
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
        "openspec-invalid",
      );
      return { advanced: false, status: "blocked", reason: "openspec validation failed" };
    } else {
      console.log(`[pipeline] #${issueNumber}: openspec validation passed`);
    }
  }

  // ---- Step 3: advance ----
  // Route to the first enabled late-stage gate. Skip eval-gate when disabled to
  // avoid spurious label churn; similarly skip shipcheck-gate when disabled.
  const nextStage = cfg.eval_gate.enabled
    ? "eval-gate"
    : cfg.shipcheck_gate?.enabled ? "shipcheck-gate" : "ready-to-deploy";
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
 * Result of a pre-merge delta review invocation (#228). The caller formats the
 * comment and routes based on whether there are blocking findings after policy.
 */
export interface DeltaReviewResult {
  verdict: "approve" | "needs-attention";
  findings: ReviewFinding[];
  summary: string;
  /** The harness that actually performed the review (may differ from cfg.harnesses.reviewer
   *  on the #39 same-harness fallback). Undefined when the caller is a test stub. */
  effectiveReviewer?: string;
  /** True when the implementing harness reviewed its own work (same-harness fallback). */
  selfReview?: boolean;
}

/**
 * Injectable seam for the pre-merge delta review (#228). The real implementation
 * calls `invokeReviewer` with the delta-review prompt and returns the parsed
 * verdict; fakes in tests return a controlled verdict without any I/O.
 */
export type RunDeltaReviewFn = (
  cfg: PipelineConfig,
  issueNumber: number,
  issueDetail: { title: string; body: string },
  deltaDiff: string,
  worktreePath: string,
  specContext: string,
) => Promise<DeltaReviewResult>;

/**
 * External seams for {@link enforceReviewShaGate}, overridable in tests.
 * Mirrors the DI pattern used elsewhere (testgate.ts, review.ts).
 */
export interface ShaGateDeps {
  getIssueDetail?: typeof getIssueDetail;
  getPrDetail?: typeof getPrDetail;
  getPrCommits?: typeof getPrCommits;
  /** Fetches the full PR diff (#228 diff-hash check). */
  getPrDiff?: typeof getPrDiff;
  /**
   * Fetches the diff between two commits on the PR for the delta review (#228).
   * Injectable seam; real implementation uses `git diff baseSha...headSha`.
   */
  getCommitDeltaDiff?: (
    cfg: PipelineConfig,
    prNumber: number,
    baseSha: string,
    headSha: string,
  ) => Promise<string>;
  /** Runs the pre-merge delta review (#228) and returns the parsed verdict. */
  runDeltaReview?: RunDeltaReviewFn;
  postComment?: typeof postComment;
  transition?: typeof transition;
  setBlocked?: typeof setBlocked;
  /** Looks up the issue worktree path and slug for the delta reviewer's CWD and OpenSpec context (#228). */
  getForIssue?: typeof getForIssue;
  /** Returns the authenticated GitHub username so the SHA gate only trusts
   *  pipeline-authored review comments (#228 Finding 9). */
  getGhActor?: () => Promise<string | null>;
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
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const getCommitDeltaDiffFn = deps.getCommitDeltaDiff ?? defaultGetCommitDeltaDiff;
  const runDeltaReviewFn = deps.runDeltaReview ?? defaultRunDeltaReview;
  const postCommentFn = deps.postComment ?? postComment;
  const transitionFn = deps.transition ?? transition;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const getGhActorFn = deps.getGhActor ?? getGhActor;

  const detail = await getIssueDetailFn(cfg, issueNumber);

  // Only trust review comments authored by the authenticated pipeline actor (#228
  // Findings 8 & 9). Any commenter can post a forged `## Review 2 — approve` body;
  // filtering to the gh user makes forged verdicts invisible to all reuse checks.
  // Fail-closed (#228 Finding 8): if the actor cannot be determined (network error,
  // expired token), block rather than silently proceeding — a transient auth failure
  // must not disable stale-verdict or unresolved-blocker enforcement.
  const actor = await getGhActorFn();
  if (actor === null) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Pre-merge: cannot verify review-comment provenance — authenticated gh actor ` +
        `unavailable (\`getGhActor\` returned null). This is typically an expired gh ` +
        `token or a transient network error. Restore gh authentication (\`gh auth ` +
        `status\`) and re-run the pipeline to resume.`,
      "pre-merge",
      "needs-human",
    );
    return {
      advanced: false,
      status: "blocked",
      reason: "pre-merge: actor lookup failed — cannot verify review provenance",
    };
  }
  const trustedComments = detail.comments.filter((c) => c.author === actor);

  const reviewed = extractReviewedSha(trustedComments);
  // No prior review comment (e.g. review steps disabled, or first run) → nothing
  // to validate; let pre-merge proceed as normal.
  if (!reviewed) return null;

  const head = (await getPrDetailFn(cfg, prNumber)).head_sha;

  // Shared guard for the verdict-REUSE short-circuits below (exact-SHA match,
  // pipeline-internal-only commits, diff-hash unchanged). A recorded verdict may
  // only be REUSED as an approval if it left no unresolved blocking findings.
  // A blocking pre-merge delta review (#228) records `reviewed-sha`/`verdict-diff-hash`
  // and `setBlocked`s at `pipeline:pre-merge`, so EVERY reuse path must re-check the
  // recorded `pipeline-blocking-keys` marker against current overrides — otherwise
  // clearing the blocked label (optionally plus a no-op commit that preserves the
  // diff hash, or an OpenSpec archive commit) would advance pre-merge with
  // unresolved blocking findings (a review-gate bypass — #228 review-2 findings).
  // Marker-only lookup: an approve / advisory-only verdict has no marker or an empty
  // one → "no blockers" → returns null (caller proceeds), preserving prior behavior.
  const reuseBlockedBy = async (
    commentBody: string | null,
    via: string,
  ): Promise<Outcome | null> => {
    const recorded = commentBody ? extractBlockingKeysMarker(commentBody) : null;
    if (!recorded || recorded.size === 0) return null;
    const overrides = extractOverrides(detail.comments);
    const unresolved = [...recorded].filter((k) => !overrides.has(k));
    if (unresolved.length === 0) return null;
    // Scoped overrides may cover the remaining key-only blockers, but we can't verify
    // without the actual finding objects. Force a fresh review so partitionFindings
    // can be called with live findings and scopes (#229).
    const activeScopes = extractScopedOverrides(detail.comments);
    if (activeScopes.length > 0) {
      const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
      await postCommentFn(
        cfg,
        issueNumber,
        `## Pipeline: Re-running review — scoped override active\n\n` +
          `Active scoped override(s) may cover the ${unresolved.length} cached blocking ` +
          `finding(s). Re-running review with live findings to apply scoped dispositions.`,
      );
      await transitionFn(
        cfg,
        issueNumber,
        "pre-merge",
        reviewStage,
        `Scoped overrides active; re-running review ${reviewed.round} to apply scoped dispositions to live findings.`,
      );
      return {
        advanced: true,
        from: "pre-merge",
        to: reviewStage,
        summary: `re-review: scoped overrides may cover cached blockers`,
      };
    }
    await setBlockedFn(
      cfg,
      issueNumber,
      `Pre-merge: the last review recorded ${unresolved.length} unresolved blocking finding(s) ` +
        `at HEAD (${unresolved.join(", ")})${via}. Fix them (push a commit) or \`--override\` each ` +
        `before pre-merge can proceed.`,
      "pre-merge",
      "needs-human",
    );
    return {
      advanced: false,
      status: "blocked",
      reason: `pre-merge: ${unresolved.length} unresolved blocking finding(s) at reviewed HEAD${via}`,
    };
  };

  // Exact match → the verdict still covers HEAD, but only as an approval when no
  // recorded blockers remain unresolved (a blocking delta review leaves
  // reviewed-sha == HEAD; see reuseBlockedBy).
  if (reviewed.sha && reviewed.sha === head) {
    return (
      (await reuseBlockedBy(findLatestReviewCommentBody(trustedComments, reviewed.round), "")) ??
      null
    );
  }

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
          // Task 5.8: Only archive commits landed since the review → verdict valid.
          // No diff-hash check needed: the pipeline-internal exemption takes precedence.
          // Reuse guard: a recorded verdict with unresolved blockers is not a valid
          // approval even across pipeline-internal commits (#228).
          return (
            (await reuseBlockedBy(
              findLatestReviewCommentBody(trustedComments, reviewed.round),
              " (verdict reused across pipeline-internal commits)",
            )) ?? null
          );
        }
      }
      // reviewed.sha absent from history (rebased/squashed) or a developer
      // commit landed → fall through to the diff-hash check (#228).
    } catch {
      // If commit classification fails, fall through to diff-hash check (conservative).
    }

    // Diff-hash check (#228): before routing back to a full review round, compare
    // the current PR diff hash to the one recorded in the prior review comment.
    // If the diff is identical, the verdict is still valid even though SHA changed.
    // On a hash mismatch, run a focused delta review of only the unreviewed commits.
    try {
      const currentDiff = await getPrDiffFn(cfg, prNumber);
      const currentHash = computeDiffHash(currentDiff);
      const priorCommentBody = findLatestReviewCommentBody(trustedComments, reviewed.round);
      const cachedHash = priorCommentBody ? extractDiffHashFromComment(priorCommentBody) : null;

      if (cachedHash !== null && cachedHash === currentHash) {
        // Diff unchanged despite SHA mismatch: verdict still covers the code. Reuse
        // guard (#228 review-2): a no-op commit moves HEAD while leaving the diff hash
        // identical, so this reuse path must also re-check recorded blockers — else
        // clearing the blocked label + a no-op commit would advance with unresolved
        // blocking findings.
        const blocked = await reuseBlockedBy(priorCommentBody, " (diff unchanged)");
        if (blocked) return blocked;
        // Diff unchanged and no unresolved blockers: verdict is still valid.
        await postCommentFn(cfg, issueNumber, diffUnchangedNotice(reviewed.sha, head));
        console.log(
          `[pipeline] #${issueNumber}: diff hash unchanged (${currentHash}); verdict reused (SHA ${reviewed.sha?.slice(0, 7)} → ${head.slice(0, 7)})`,
        );
        return null;
      }

      // Diff changed: run a focused adversarial delta review of only the unreviewed
      // commits instead of routing back to a full review-2 round. The delta review
      // does NOT count against the max_adversarial_rounds ceiling.
      const deltaDiff = reviewed.sha
        ? await getCommitDeltaDiffFn(cfg, prNumber, reviewed.sha, head)
        : currentDiff; // reviewed SHA missing → review the full diff as the delta

      // Resolve worktree and spec context for the delta reviewer (Finding 3): the
      // delta reviewer must run from the issue worktree (not cfg.repo_dir) so it
      // can inspect PR-branch files, and must receive OpenSpec context for any
      // change dirs touched by the unreviewed commits.
      const deltaWt = await getForIssueFn(cfg, issueNumber);
      const deltaWorktreePath = deltaWt?.path ?? cfg.repo_dir;
      const deltaSpecContext = deltaWt
        ? openspecContextFromDiff(cfg, deltaWt.path, diffFilePaths(deltaDiff))
        : "";

      const deltaResult = await runDeltaReviewFn(
        cfg, issueNumber, detail, deltaDiff, deltaWorktreePath, deltaSpecContext,
      );
      // Guard: needs-attention with zero findings indicates unparseable reviewer output
      // (#228 fix-1). Mirror advanceReview's zero-findings handling: throw to the
      // conservative catch path (full re-review) rather than treating zero findings as
      // an implicit approval.
      if (deltaResult.verdict === "needs-attention" && deltaResult.findings.length === 0) {
        throw new Error(
          `delta review returned needs-attention with zero findings (likely unparseable output); ` +
          `summary: ${deltaResult.summary || "(none)"}`,
        );
      }
      const overrides = extractOverrides(detail.comments);
      const scopes = extractScopedOverrides(detail.comments);
      const partition = partitionFindings(deltaResult.findings, cfg.review_policy, overrides, scopes);

      const newHash = computeDiffHash(currentDiff);
      const deltaCommentVerdict = {
        verdict: deltaResult.verdict,
        summary: deltaResult.summary,
        findings: deltaResult.findings,
        next_steps: [] as string[],
        commitSha: head,
      };
      const blockingKeysSet = new Set(partition.blocking.map((f) => findingKey(f)));

      // Apply same-harness self-review disclosure (Finding 4): when invokeReviewer
      // falls back to the implementer, the delta comment must carry the same
      // selfReviewBanner and (self-review) label used by advanceReview.
      const deltaEffectiveReviewer = deltaResult.effectiveReviewer ?? cfg.harnesses.reviewer;
      const deltaIsSelfReview = deltaResult.selfReview ?? false;
      const deltaReviewerLabel = deltaIsSelfReview
        ? `${deltaEffectiveReviewer} (self-review)`
        : deltaEffectiveReviewer;
      const deltaCommentBody = formatDeltaReviewComment(
        cfg,
        deltaCommentVerdict,
        `pre-merge delta review by ${deltaReviewerLabel}`,
        blockingKeysSet.size > 0 ? blockingKeysSet : undefined,
        newHash,
      );
      // Place the banner AFTER the heading so isDeltaReviewComment (startsWith check)
      // still recognizes the comment on the next pre-merge re-entry (#228 Finding 5).
      const deltaComment = deltaIsSelfReview
        ? (() => {
            const nl = deltaCommentBody.indexOf("\n");
            return nl >= 0
              ? `${deltaCommentBody.slice(0, nl)}\n\n${selfReviewBanner(cfg.harnesses.reviewer, deltaEffectiveReviewer)}${deltaCommentBody.slice(nl)}`
              : `${deltaCommentBody}\n\n${selfReviewBanner(cfg.harnesses.reviewer, deltaEffectiveReviewer)}`;
          })()
        : deltaCommentBody;
      await postCommentFn(cfg, issueNumber, deltaComment);

      if (partition.blocking.length === 0) {
        // Re-validate HEAD: a push during the delta reviewer invocation means the
        // approval covers a commit that is no longer HEAD. Rather than proceeding
        // on a stale approval, fall back to the conservative full re-review path
        // (Finding 2). We throw so the catch block handles the fallthrough.
        const postDeltaHead = (await getPrDetailFn(cfg, prNumber)).head_sha;
        if (postDeltaHead !== head) {
          throw new Error(
            `PR HEAD moved from ${head.slice(0, 7)} to ${postDeltaHead.slice(0, 7)} ` +
            `during delta review; delta approval is stale — re-entering SHA gate`,
          );
        }
        // Delta review approves (or findings all below policy): pre-merge proceeds.
        console.log(`[pipeline] #${issueNumber}: pre-merge delta review approved; proceeding`);
        return null;
      }

      // Delta review found blocking findings: block pre-merge without routing to review-2.
      await setBlockedFn(
        cfg,
        issueNumber,
        "Pre-merge delta review found blocking findings; fix required before merging.",
        "pre-merge",
        "needs-human",
      );
      return {
        advanced: false,
        status: "blocked",
        reason: "pre-merge delta review: blocking findings",
      };
    } catch (err) {
      // Diff fetch or delta review failed → fall through to full re-review (conservative).
      console.warn(
        `[pipeline] #${issueNumber}: diff-hash check or delta review failed (${(err as Error).message}); falling back to full re-review`,
      );
    }
  }

  // reviewed.sha is null (no sentinel) OR diff-hash/delta-review path errored:
  // treat as stale and run the full review stage again.
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

/** Notice posted when the pre-merge diff-hash check finds the diff unchanged (#228). */
export function diffUnchangedNotice(reviewedSha: string | null, headSha: string): string {
  const from = reviewedSha ? ` from \`${reviewedSha.slice(0, 7)}\`` : "";
  return [
    "## Pipeline: Diff unchanged since last review; verdict reused",
    "",
    `HEAD has moved${from} to \`${headSha.slice(0, 7)}\`, but the PR diff hash is identical to the one the last review evaluated.`,
    "The prior review verdict is still valid; pre-merge proceeds without a re-review.",
  ].join("\n");
}

/** Default implementation of the `getCommitDeltaDiff` seam (#228). */
async function defaultGetCommitDeltaDiff(
  cfg: PipelineConfig,
  _prNumber: number,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const label = `${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}`;
  const result = await gitInWorktree(cfg.repo_dir, ["diff", `${baseSha}...${headSha}`], {
    ignoreFailure: true,
  });
  if (result.code !== 0) {
    throw new Error(
      `git diff ${label} failed (exit ${result.code}): ` +
      `${result.stderr.trim() || "no error output — objects may not be present locally"}`,
    );
  }
  if (!result.stdout.trim()) {
    throw new Error(
      `git diff ${label} produced empty output despite a diff-hash mismatch; ` +
      `refusing to delta-review an empty range`,
    );
  }
  return result.stdout;
}

/** Default implementation of the `runDeltaReview` seam (#228). */
async function defaultRunDeltaReview(
  cfg: PipelineConfig,
  issueNumber: number,
  issueDetail: { title: string; body: string },
  deltaDiff: string,
  worktreePath: string,
  specContext: string,
): Promise<DeltaReviewResult> {
  const prompt = buildDeltaReviewPrompt({
    cfg,
    issueNumber,
    title: issueDetail.title,
    body: issueDetail.body,
    deltaDiff,
    specContext,
  });
  const invocation = await invokeReviewer(
    cfg.harnesses.reviewer,
    cfg.harnesses.implementer,
    worktreePath,
    prompt,
    { timeoutSec: cfg.review_timeout, model: cfg.models.review },
  );
  if (!invocation.result.success) {
    throw new Error(
      `delta review harness failed: exit ${invocation.result.exit_code}`,
    );
  }
  const parsed = parseStructuredVerdict(invocation.result.stdout, "");
  return {
    verdict: parsed.verdict,
    findings: parsed.findings,
    summary: parsed.summary,
    effectiveReviewer: invocation.effectiveReviewer,
    selfReview: invocation.selfReview,
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
 * Returns true when the PR branch commit history already contains a pipeline-
 * internal archive commit for this issue (#181). Reads the committed log rather
 * than the local filesystem so it is reliable across polling iterations: the
 * guard fires on the very next poll after the archive commit is pushed.
 */
export async function archiveAlreadyDone(
  gitFn: typeof gitInWorktree,
  wtPath: string,
  baseBranch: string,
  issueNumber: number,
): Promise<boolean> {
  const log = await gitFn(
    wtPath,
    ["log", "--format=%s", `origin/${baseBranch}..HEAD`],
    { ignoreFailure: true },
  );
  const prefix = `${OPENSPEC_ARCHIVE_PREFIX}${issueNumber}`;
  return log.stdout.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) return false;
    // Require a non-digit (or end of string) after the issue number so that
    // #18 does not match a commit intended for #181 or any other prefixed number.
    const charAfter = trimmed[prefix.length];
    return charAfter === undefined || !/\d/.test(charAfter);
  });
}

/**
 * When OpenSpec is active, archive the change(s) this PR branch introduced so
 * their spec deltas fold into the living `openspec/specs/`. Idempotent: once an
 * archive commit exists on the branch, subsequent polling iterations skip this
 * step entirely. Returns a `waiting` Outcome after pushing (CI must re-run), a
 * `blocked` Outcome on failure, or null when there is nothing to do (continue the gate).
 */
export async function maybeArchiveOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
  pipelineRunId: string,
  deps: AdvancePreMergeDeps = {},
  stateDir?: string,
): Promise<Outcome | null> {
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const gitFn = deps.gitInWorktree ?? gitInWorktree;
  const isActiveFn = deps.openspecIsActive ?? openspec.isActive;
  const changeDirExistsFn = deps.changeDirExists ?? openspec.changeDirExists;
  const archiveFn = deps.openspecArchive ?? openspec.archive;
  const branchDeveloperCommitsFn =
    deps.branchDeveloperCommits ?? ((wtPath, base) => computeBranchDeveloperCommits(gitFn, wtPath, base));

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

  // Idempotency guard (#181, fix 2): evaluate candidates *before* consulting commit
  // history so a prior archive commit cannot mask re-introduced active change
  // directories. If no candidates remain, there is nothing to archive.
  if (candidates.length === 0) return null;

  // ---- Consistency guard (#106): never archive a delta the code outgrew ----
  // OpenSpec deltas are frozen at planning; fix rounds only edit code. If a
  // material fix moved the implementation but left the change's specs/** untouched
  // AND a review finding is tagged `category: spec-divergence`, archiving would
  // fold a stale delta into the living specs (silent corruption) and re-review
  // would keep re-anchoring on the wrong delta. Block and surface it instead.
  const guard = await enforceSpecConsistencyGuard(cfg, issueNumber, wt.path, candidates, {
    branchDeveloperCommits: branchDeveloperCommitsFn,
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
      await setBlockedFn(cfg, issueNumber, `openspec archive ${id} failed:\n${res.output}`, "pre-merge", "openspec-invalid");
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
  const pushBranch = branchName(issueNumber, wt.slug);
  const push = await gitFn(wt.path, ["push", "origin", pushBranch], {
    ignoreFailure: true,
  });
  if (stateDir) {
    await recordCommand(
      stateDir,
      issueNumber,
      "pre-merge",
      makeCommandRecord(
        `git push origin ${pushBranch}`,
        push.code,
        0,
        push.code !== 0 ? push.stderr.trim() : "OpenSpec archive pushed; CI will re-run",
      ),
    ).catch(() => {});
  }
  if (push.code !== 0) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Git push failed after OpenSpec archive: ${push.stderr.trim()}`,
      "pre-merge",
      "push-failed",
    );
    return { advanced: false, status: "blocked", reason: "push failed after archive" };
  }
  console.log(`[pipeline] #${issueNumber}: OpenSpec change(s) archived; CI will re-run`);
  return { advanced: false, status: "waiting", reason: "openspec change archived; CI re-running" };
}

// ---------------------------------------------------------------------------
// OpenSpec spec/code consistency guard (#106)
// ---------------------------------------------------------------------------

/** One branch commit with the repo-relative paths it changed. Ordered: index 0
 * is the earliest commit in the range, last is HEAD. Exported for tests. */
export interface FixCommit {
  sha: string;
  paths: string[];
}

/** Deps for {@link enforceSpecConsistencyGuard} — injectable fakes in tests. */
export interface SpecConsistencyDeps {
  branchDeveloperCommits: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>;
  getIssueDetail: typeof getIssueDetail;
  setBlocked: typeof setBlocked;
}

/**
 * Pre-archive backstop for "fix rounds don't revise the change" (#106). Returns a
 * blocked Outcome (and labels the issue) when a change's spec delta is stale
 * relative to the implementation, or null to proceed. "Stale" requires ALL of:
 *   1. developer/fix commits on the branch changed implementation files,
 *   2. the change's `specs/**` were NOT updated after the last implementation
 *      change (order-aware), and
 *   3. the most recent review verdict tagged a finding `category: spec-divergence`.
 *
 * Condition 3 is read from the STRUCTURED category marker that
 * `formatReviewComment` emits (`reviewCommentFlagsSpecDivergence`), never by
 * keyword-matching the reviewer's prose — prose inference is adversarially
 * unwinnable (the #109 failure). Missing any condition → proceed (conservative-
 * open: don't false-positive on fixes that correctly left an accurate spec
 * untouched). Exported for tests.
 */
export async function enforceSpecConsistencyGuard(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  changeIds: string[],
  deps: SpecConsistencyDeps,
): Promise<Outcome | null> {
  const devCommits = await deps.branchDeveloperCommits(wtPath, cfg.base_branch);
  // No non-internal commits → nothing moved since planning. Nothing to guard.
  if (devCommits.length === 0) return null;

  const stale = changeIds.find((id) => specDeltaIsStale(id, devCommits));
  if (!stale) return null;

  // The structural signal (code changed, spec didn't) only matters if the reviewer
  // actually flagged the divergence — otherwise the spec is presumed consistent
  // (reviewed against it, no objection) and the frozen delta is helping. Read the
  // structured `category: spec-divergence` marker, NOT prose.
  const detail = await deps.getIssueDetail(cfg, issueNumber);
  const reviewBody = latestReviewBody(detail.comments);
  if (!reviewBody || !reviewCommentFlagsSpecDivergence(reviewBody)) return null;

  await deps.setBlocked(cfg, issueNumber, staleSpecDeltaBlockReason(stale), "pre-merge", "openspec-stale-delta");
  return { advanced: false, status: "blocked", reason: `stale OpenSpec delta (${stale})` };
}

/**
 * Per-commit paths for all non-pipeline-internal commits on the branch, oldest
 * first. Excludes only the pipeline's own OpenSpec archive commits (which don't
 * change reviewed code). Per-commit (not a collapsed range) so the stale guard
 * can compare the order of the last impl-changing commit against the last
 * spec-delta-changing commit.
 */
async function computeBranchDeveloperCommits(
  gitFn: typeof gitInWorktree,
  wtPath: string,
  baseBranch: string,
): Promise<FixCommit[]> {
  const log = await gitFn(
    wtPath,
    ["log", "--reverse", "--format=%H%x1f%s", `origin/${baseBranch}..HEAD`],
    { ignoreFailure: true },
  );
  const result: FixCommit[] = [];
  for (const line of log.stdout.split("\n")) {
    const sep = line.indexOf("\x1f");
    if (sep === -1) continue;
    const sha = line.slice(0, sep).trim();
    if (!sha) continue;
    const subj = line.slice(sep + 1).trim();
    // Only skip the pipeline's own OpenSpec archive commits — auto-format commits
    // can change implementation files and must remain visible to the stale-spec
    // guard even though they are classified as pipeline-internal for the
    // review-SHA gate (#182 finding 3).
    if (subj.startsWith(OPENSPEC_ARCHIVE_PREFIX)) continue;
    const d = await gitFn(wtPath, ["diff", "--name-only", `${sha}^`, sha], { ignoreFailure: true });
    const paths = d.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    result.push({ sha, paths });
  }
  return result;
}

/**
 * Structural half of the guard: did developer/fix commits change implementation
 * files (anything outside `openspec/`) in a commit that came AFTER the last
 * spec-delta update? Order-aware: an early spec edit in fix-1 does not protect
 * against a later fix-2 commit that moved the code without touching the spec.
 * Pure; exported for tests.
 */
export function specDeltaIsStale(id: string, commits: FixCommit[]): boolean {
  if (commits.length === 0) return false;
  const specPrefix = `openspec/changes/${id}/specs/`;
  let lastSpecIdx = -1;
  let lastImplIdx = -1;
  for (let i = 0; i < commits.length; i++) {
    const paths = commits[i].paths.map((p) => p.replace(/\\/g, "/").trim()).filter(Boolean);
    if (paths.some((p) => p.startsWith(specPrefix))) lastSpecIdx = i;
    if (paths.some((p) => !p.startsWith("openspec/"))) lastImplIdx = i;
  }
  // Stale when impl changed AND the last impl commit is more recent (higher index)
  // than the last spec commit. lastSpecIdx === -1 means the spec was never updated.
  return lastImplIdx !== -1 && lastImplIdx > lastSpecIdx;
}

/**
 * Latest review verdict comment body (round 1, round 2, or pre-merge delta),
 * or null when none exists. Delta review comments are included so that a
 * `category: spec-divergence` finding in the most recent delta review is
 * visible to `enforceSpecConsistencyGuard` — without this, an older full-review
 * comment (without the marker) would be picked up instead (#228 finding 1).
 */
function latestReviewBody(
  comments: { author: string; body: string; createdAt: string }[],
): string | null {
  const m = findLatestCommentMatching(
    comments,
    (b) =>
      b.startsWith("## Review 1") ||
      b.startsWith("## Review 2") ||
      b.startsWith(DELTA_REVIEW_MARKER_PREFIX),
  );
  return m?.body ?? null;
}

/** Operator-facing block reason naming the stale-delta condition and the fix. */
function staleSpecDeltaBlockReason(id: string): string {
  return [
    `OpenSpec change \`${id}\` has a stale spec delta: fix rounds changed implementation files but did`,
    `not update the change's \`specs/**\`, and the most recent review verdict tagged a finding`,
    `\`category: spec-divergence\`. Archiving now would fold a delta into the living \`openspec/specs/\``,
    `that does not describe the merged implementation.`,
    ``,
    `To resolve, update \`openspec/changes/${id}/specs/**\` (and \`tasks.md\`) so the spec matches the`,
    `implemented behavior, then re-run \`openspec validate ${id}\` and push. Any commit that brings the`,
    `spec delta into agreement clears this guard. If the divergence finding is a false positive, the`,
    `correct resolution is still to update the delta so the living spec states the actual behavior.`,
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
  stateDir?: string,
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
    if (stateDir) {
      await recordCommand(
        stateDir,
        issueNumber,
        "pre-merge",
        makeCommandRecord(
          `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
          ok ? 0 : 1,
          0,
          ok ? "conflict-recovery rebase succeeded; CI re-running" : "conflict-recovery rebase failed",
        ),
      ).catch(() => {});
    }
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
    "merge-conflict",
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
 * last outcome. `opts.stateDir` is forwarded to each `advance` call so
 * evidence recording works across all polling iterations.
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
