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
  addIssueComment,
  closePr,
  createIssue,
  getGhActor,
  getHeadCheckRunCount,
  getSuccessfulCheckRunCount,
  getIssueDetail,
  getPrChecks,
  getPrCommits,
  getPrDetail,
  getPrDiff,
  getPrForIssue,
  parseChecksAggregate,
  clearBlocked,
  postComment,
  reopenPr,
  setBlocked,
  transition,
} from "../gh.ts";
import { branchName, getForIssue, getOnDiskForIssue, gitInWorktree, reattachIfDetached } from "../worktree.ts";
import { PIPELINE_INTERNAL_MARKER_FILES } from "../salvage-harness-work.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
import {
  attestPipelineComment,
  buildDeltaFollowupIssueBody,
  buildDeltaFollowupUpdateComment,
  computeDiffHash,
  DELTA_REVIEW_MARKER_PREFIX,
  deltaRoundCeilingComment,
  deltaRoundCeilingDemotionComment,
  diffFilePaths,
  extractBlockingKeysFromComment,
  extractBlockingKeysMarker,
  extractCeilingFollowupNumber,
  extractDiffHashFromComment,
  extractReviewArtifact,
  findLatestReviewCommentBody,
  formatDeltaReviewComment,
  extractReviewedSha,
  parseStructuredVerdict,
  type DeltaCeilingFinding,
} from "./review.ts";
import {
  applySettledSurfaceEvidenceRule,
  buildTrustedOverrideComments,
  extractOverrides,
  extractScopedOverrides,
  findingKey,
  overrideComment,
  partitionFindings,
  severityRank,
  surfaceKey,
  type AlternativeReinstatementMatch,
  type ReversalMatch,
  type UnverifiedSettledSurfaceMatch,
} from "../review-policy.ts";
import {
  buildPriorRoundDigest,
  countDeltaRounds,
  detectSuspectedChurn,
  settledFindings,
  settledFindingsSurfaceFiles,
  settledFindingsVerification,
  type HeadFileState,
  type PriorRoundDigest,
  type SettledFindingVerification,
} from "../review-history.ts";
import { appendEvent, RUN_SCHEMA_VERSION } from "../run-store.ts";
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
import { buildDeltaReviewPrompt, buildFixPrompt } from "../prompts/index.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import * as openspec from "../openspec.ts";
import {
  computeBranchDeveloperCommits,
  enforceSpecConsistencyGuard,
  performBoundedSpecRepair,
  type InvokeFn,
  type SpecConsistencyDeps,
  type ValidateFn,
} from "../openspec-consistency.ts";
export {
  enforceSpecConsistencyGuard,
  specDeltaIsStale,
  type FixCommit,
  type SpecConsistencyDeps,
} from "../openspec-consistency.ts";
import { invoke } from "../harness.ts";
import { reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { VISUAL_PUBLISH_COMMIT_PREFIX } from "./visual.ts";
import type { ReviewFinding } from "../types.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";
import { readEvents } from "../run-store.ts";
import type { RunStoreDeps, StageAccountingEvent } from "../run-store.ts";
import { runTestGate } from "../testgate.ts";

const OPENSPEC_ARCHIVE_PREFIX = "chore: archive OpenSpec change(s) for #";

/**
 * Exact publish-commit subject pattern (#463): the full prescribed subject,
 * `VISUAL_PUBLISH_COMMIT_PREFIX` followed by an issue number and nothing
 * else. Matched in full (not as a prefix) so a developer's own code-changing
 * commit merely starting with the same words — e.g. `chore: publish
 * visual-gate evidence for #463 and tweak layout` — does NOT match and still
 * triggers the required re-review.
 */
const VISUAL_PUBLISH_COMMIT_PATTERN = new RegExp(
  `^${VISUAL_PUBLISH_COMMIT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`,
);
export const REBASE_MARKER_FILE = PIPELINE_INTERNAL_MARKER_FILES[0];

/**
 * Commit-subject prefix for the pre-merge bounded auto-fix round (#359).
 * Every auto-fix commit starts with this prefix so the one-attempt bound can
 * detect a prior attempt after a process restart by scanning PR commit subjects.
 * MUST NOT match `isPipelineInternalCommit` — auto-fix commits are developer
 * commits and must invalidate the review-SHA gate so the re-review runs.
 */
export const PRE_MERGE_AUTOFIX_PREFIX = "fix: pre-merge auto-fix";

/**
 * Result of a pre-merge bounded auto-fix attempt (#359).
 * "fix-committed" — harness committed a fix and pushed it to the PR head.
 *                   Caller should re-run the delta review exactly once,
 *                   evaluated against `headSha` — the authoritative post-fix
 *                   commit SHA read from local git state (#371). Callers MUST
 *                   NOT re-derive the post-fix head from a GitHub-API PR-head
 *                   read, which can still return the pre-fix head in the
 *                   window immediately after the push.
 * "error"         — harness failure, dirty worktree, push failure, or no
 *                   commit produced. Worktree rolled back to pre-fix HEAD.
 */
export type PreMergeAutoFixResult =
  | { status: "fix-committed"; headSha: string }
  | { status: "error" };

/**
 * Injectable seam for the bounded pre-merge auto-fix attempt (#359).
 * Parameters: the blocking ReviewFinding objects, the issue title (for the
 * fix prompt), and the delta review comment body (as reviewFindings text).
 * Called by `enforceReviewShaGate` only when (a) all blocking findings pass
 * `allBlockingAutoFixable` and (b) no prior auto-fix commit is present.
 */
export type AttemptPreMergeAutoFixFn = (
  blockingFindings: ReviewFinding[],
  issueTitle: string,
  reviewComment: string,
) => Promise<PreMergeAutoFixResult>;

/**
 * True when a commit was authored by the pipeline itself in pre-merge (an
 * OpenSpec archive) rather than by a developer/fix step. These commits do not
 * change the code the reviewer evaluated, so they must not invalidate the
 * review verdict (#98). Matched on the exact pre-merge commit prefix — a
 * developer's own `chore:` commit with different wording does NOT match and
 * still triggers a re-review. A `docs: update documentation for #N` commit is
 * NOT pipeline-internal: the pre-merge docs harness was removed (#91, docs now
 * land inside the reviewed implementation diff), so any such commit can only
 * come from a developer. Also matches the visual-gate artifact-publish commit
 * (#463): it republishes already-reviewed evidence, does not change the code
 * the reviewer evaluated, and must not invalidate the verdict or be mistaken
 * for a visual-fix commit (distinct prefix from `visualFixCommitPattern`).
 * Exported for tests.
 */
export function isPipelineInternalCommit(messageHeadline: string): boolean {
  return (
    messageHeadline.startsWith(OPENSPEC_ARCHIVE_PREFIX) ||
    VISUAL_PUBLISH_COMMIT_PATTERN.test(messageHeadline)
  );
}

/**
 * Tri-state result of {@link resolveReviewedShaCurrency}: whether a SHA a
 * delta review ran against (or a verdict was recorded against) is still the
 * PR branch head at the moment of recording (#481).
 * - `current`     — `candidateSha` is still the head, or every commit since
 *   it is pipeline-internal (#98 exemption preserved).
 * - `superseded`  — a newer developer/fix commit landed; `headSha` is the
 *   current head. The verdict must be discarded, not recorded as blocking.
 * - `unknown`     — the head or commit list could not be read/classified
 *   (network failure, or `candidateSha`/the current head is absent from the
 *   commit list — e.g. rebase/squash, or a stale commit-list read). Callers
 *   MUST fail closed: never record a blocking verdict on `unknown`.
 */
export type ReviewedShaCurrency =
  | { status: "current" }
  | { status: "superseded"; headSha: string }
  | { status: "unknown" };

/**
 * Seams needed to resolve whether `candidateSha` — the SHA a delta review
 * ran against — is still the PR branch head (#481). Re-reads the PR head and,
 * on mismatch, classifies the commits between `candidateSha` and the new head
 * using the same `isPipelineInternalCommit` rule as the existing SHA gate
 * reuse checks, so pipeline-internal-only commits (OpenSpec archive) still
 * count as current.
 */
export async function resolveReviewedShaCurrency(
  cfg: PipelineConfig,
  prNumber: number,
  candidateSha: string,
  deps: {
    getPrDetail: typeof getPrDetail;
    getPrCommits: typeof getPrCommits;
  },
): Promise<ReviewedShaCurrency> {
  try {
    const newHead = (await deps.getPrDetail(cfg, prNumber)).head_sha;
    if (newHead === candidateSha) return { status: "current" };
    const commits = await deps.getPrCommits(cfg, prNumber);
    const candidateIdx = commits.findIndex((c) => c.oid === candidateSha);
    const newHeadIdx = commits.findIndex((c) => c.oid === newHead);
    // Both SHAs must be present, and in order, to trust the fetched commit
    // list as spanning the full range — otherwise the list may be stale
    // (fetched before the newer push landed) or the history was rebased.
    if (candidateIdx === -1 || newHeadIdx === -1 || newHeadIdx <= candidateIdx) {
      return { status: "unknown" };
    }
    const landedSince = commits.slice(candidateIdx + 1, newHeadIdx + 1);
    if (landedSince.every((c) => isPipelineInternalCommit(c.messageHeadline))) {
      return { status: "current" };
    }
    return { status: "superseded", headSha: newHead };
  } catch {
    return { status: "unknown" };
  }
}

/** Bound on additional delta-review attempts after a supersession within one
 *  pre-merge entry (#481). Exceeding it falls back to the conservative full
 *  re-review path rather than looping. */
export const MAX_DELTA_SUPERSESSION_RETRIES = 1;

/**
 * Notice posted when a pre-merge delta verdict is discarded because the PR
 * head moved past the SHA it was run against (#481). Carries no
 * `pipeline-blocking-keys` marker and does not claim the new head as its
 * reviewed commit — review history must not misrepresent a superseded
 * verdict as describing the current head.
 */
export function supersededDeltaReviewNotice(reviewedSha: string, headSha: string): string {
  return attestPipelineComment(
    "pre-merge-delta-superseded",
    [
      `${DELTA_REVIEW_MARKER_PREFIX} — superseded`,
      "",
      `This delta review ran against \`${reviewedSha.slice(0, 7)}\`, but the PR branch head ` +
        `had already moved to \`${headSha.slice(0, 7)}\` by the time the verdict was ready.`,
      "The verdict is discarded — it carries no blocking authority — and the delta review " +
        "re-runs against the current head.",
    ].join("\n"),
  );
}

/**
 * True iff a blocking finding's category is in the auto-fix allowlist
 * `{ correctness, missing-dep }`. Absent/empty/unknown category → false
 * (fail-closed: auto-fix only on positive signal). (#359)
 */
export function isAutoFixableFinding(f: ReviewFinding): boolean {
  const cat = (f.category ?? "").toLowerCase().trim();
  return cat === "correctness" || cat === "missing-dep";
}

/**
 * True iff the blocking findings array is non-empty and every element
 * passes `isAutoFixableFinding`. Empty array → false (no findings to fix).
 * (#359)
 */
export function allBlockingAutoFixable(blocking: ReviewFinding[]): boolean {
  return blocking.length > 0 && blocking.every(isAutoFixableFinding);
}

/**
 * Perform one bounded pre-merge auto-fix attempt (#359).
 *
 * Invokes the implementer harness with the surgical-fix prompt (`buildFixPrompt`),
 * amends the resulting commit to carry the `PRE_MERGE_AUTOFIX_PREFIX` subject
 * (the durable crash-safe one-attempt marker), and pushes to the PR head.
 *
 * Pre-conditions: worktree must be clean (fail closed otherwise).
 * On any failure (harness error, no commit produced, push error): rolls the
 * worktree back to the pre-fix HEAD over a clean tree and returns "error".
 * The surgical-fix discipline (#235) — minimal diff, destructive-operation guard,
 * pre-commit self-check — applies via `buildFixPrompt` unchanged.
 */
export async function performPreMergeAutoFix(
  cfg: PipelineConfig,
  issueNumber: number,
  pipelineRunId: string,
  findingsText: string,
  issueTitle: string,
  wt: { path: string; slug: string },
  gitFn: typeof gitInWorktree,
  invokeFn: InvokeFn,
): Promise<PreMergeAutoFixResult> {
  const harness = cfg.harnesses?.implementer;
  if (!harness) return { status: "error" };

  const headBefore = (
    await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();

  // Pre-fix cleanliness check: a dirty worktree before the attempt fails closed
  // (#235). Rollback uses `git reset --hard`; running that over pre-existing dirty
  // work would irreversibly discard it.
  const preStatus = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (preStatus.code !== 0 || preStatus.stdout.trim() !== "") return { status: "error" };

  // Reattach detached HEAD before the harness commits (#359 Finding 3): commits
  // made in a detached worktree don't move the branch ref, so the later push
  // would silently leave the PR branch unchanged while returning success.
  const reattach = await reattachIfDetached(wt, issueNumber, gitFn);
  if (!reattach.ok) return { status: "error" };

  const prompt = buildFixPrompt({
    cfg,
    issueNumber,
    title: issueTitle,
    reviewFindings: findingsText,
    fixRound: 1,
    pipelineRunId,
  });

  const result = await invokeFn(harness, wt.path, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: cfg.models?.fix ?? null,
    sandbox: cfg.harness_sandbox,
  });

  if (!result.success) {
    if (headBefore) {
      await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
      await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    }
    return { status: "error" };
  }

  const headAfter = (
    await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const statusAfter = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  // Fail closed when status exits non-zero: we cannot prove the worktree is clean (#359 R2 F4).
  const hasUncommitted = statusAfter.code !== 0 || statusAfter.stdout.trim() !== "";
  const hasNewCommit = headAfter && headBefore && headAfter !== headBefore;

  // Spec (#359): a dirty post-harness worktree (uncommitted changes remaining) or
  // no new commit is a failure — roll back. The harness MUST commit cleanly; a dirty
  // state indicates the harness exited early or its pre-commit self-check withheld the
  // commit, and we must not push a partial or self-check-rejected fix.
  if (hasUncommitted || !hasNewCommit) {
    if (headBefore) {
      await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
      await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    }
    return { status: "error" };
  }

  // Harness committed cleanly; amend to set the canonical subject so the
  // one-attempt bound can detect this commit by subject prefix.
  const autoFixMsg = withTrailers(
    `${PRE_MERGE_AUTOFIX_PREFIX} for #${issueNumber}`,
    issueNumber,
    pipelineRunId,
  );

  const amendRes = await gitFn(
    wt.path, ["commit", "--amend", "-m", autoFixMsg], { ignoreFailure: true },
  );
  if (amendRes.code !== 0) {
    await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    return { status: "error" };
  }

  // Capture the authoritative post-fix head from local git state (#371) — the
  // amend rewrote the commit SHA, so this is the SHA the caller's re-review must
  // evaluate. Read here (not re-derived from a GitHub-API PR-head read after the
  // push), since that API read can still lag and return the pre-fix head.
  const postFixHead = (
    await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  if (!postFixHead) {
    await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    return { status: "error" };
  }

  // Push the fix commit to the PR head.
  const branch = branchName(issueNumber, wt.slug);
  const pushRes = await gitFn(wt.path, ["push", "origin", branch], { ignoreFailure: true });
  if (pushRes.code !== 0) {
    // Rollback: push failed, remove the local commit so the next attempt is clean.
    await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    return { status: "error" };
  }

  return { status: "fix-committed", headSha: postFixHead };
}

/**
 * Mutable context shared across `advancePolling` iterations. `advancePolling`
 * allocates one per polling session and passes it to every `advance()` call so
 * the CI-gate grace window and the no-run recovery guard persist across polls
 * (fixing the reset-on-every-poll bug — #281 review 2).
 */
export interface PreMergePollingContext {
  /** Wall-clock ms when the CI gate first observed pending checks. Set by
   *  `advance()` on first entry; never reset once set within a session. */
  ciGateEnteredAt?: number;
  /** Head SHA for which a close+reopen recovery was already attempted. Prevents
   *  repeated PR state churn when two consecutive polls both see zero check-runs. */
  noRunRecoveryAttemptedForSha?: string;
  /** PR head SHA before the OpenSpec archive commit was pushed. Used by the
   *  no-run recovery path to verify the pre-archive SHA had green CI and to
   *  compute the archive-only diff. Captured once at the start of the first
   *  poll that reaches the archive step. */
  preArchiveSha?: string;
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
  /** Run directory for JSONL event log (#302). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events (#302). */
  runStoreDeps?: RunStoreDeps;
  /** Mutable context shared across polling iterations. When absent (single
   *  `advance()` call without a polling loop), the CI-gate grace window and the
   *  no-run recovery guard are skipped (pre-existing behaviour). */
  pollingCtx?: PreMergePollingContext;
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
  /**
   * Injectable bounded spec-delta repair attempt (#356). When provided, the
   * spec-divergence consistency guard calls this for a `spec-behind-code`
   * direction instead of blocking immediately. Production default: uses the
   * implementer harness to update only the active change's spec files.
   * Tests inject a mock to verify the dep is wired without a real harness.
   */
  attemptBoundedRepair?: SpecConsistencyDeps["attemptBoundedRepair"];
  /**
   * Injectable harness invoker for the internal bounded-repair closure (#356).
   * Defaults to `invoke` from harness.ts. Tests inject this to exercise the
   * production-path repair closure (when `attemptBoundedRepair` is not provided
   * and `cfg.harnesses.implementer` is set) without spawning a real harness.
   */
  invokeFn?: InvokeFn;
  /**
   * Injectable OpenSpec change validator for the internal bounded-repair closure
   * (#356). Defaults to `openspec.validateItem`. Tests inject this alongside
   * `invokeFn` to exercise the production-path repair closure end-to-end.
   */
  openspecValidateItem?: ValidateFn;
  /**
   * GitHub login of the pipeline actor used to filter review comments to
   * trusted-authored entries before extracting spec-divergence signals (#356
   * finding 1). When absent, `maybeArchiveOpenspec` resolves it via `getGhActor()`
   * at runtime. Tests inject a literal string (matching the review-comment author
   * they set up) to avoid a real GitHub API call.
   */
  trustedReviewAuthor?: string | null;
  // Seams for the no-run recovery path (#281).
  getHeadCheckRunCount?: typeof getHeadCheckRunCount;
  /** Counts only successful (conclusion=success) check-runs for a SHA.
   *  Used for the prior-SHA green check in auto-recovery: a pre-archive SHA
   *  with only failed/pending runs must NOT qualify as green. */
  getSuccessfulCheckRunCount?: typeof getSuccessfulCheckRunCount;
  closePr?: typeof closePr;
  reopenPr?: typeof reopenPr;
  /** Returns the diff file paths between two SHAs (used for the archive-only check).
   *  Injected seam; defaults to `git diff --name-only baseSha...headSha`. */
  getDiffFilePaths?: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>;
  /** Wall-clock timestamp in ms. Injectable for tests; defaults to Date.now(). */
  nowMs?: () => number;
  /** Sleep for the given ms. Injectable for tests to avoid real waits in
   *  `advancePolling` unit tests; defaults to setTimeout-based sleep. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Read events from the run-store JSONL log. Injected for tests; defaults to
   *  `readEvents` from run-store.ts. Used by the `ci_mode: local` gate (#350). */
  readRunEvents?: typeof readEvents;
  /** Run the local test gate inline. Injected for tests; defaults to `runTestGate`
   *  from testgate.ts. Used by the `ci_mode: local` gate when the cached result is
   *  absent or stale (#350). */
  runTestGate?: typeof runTestGate;
  /** Read the HEAD SHA of a worktree by path. Injected for tests; defaults to
   *  `git rev-parse HEAD` in the worktree. Used by the `ci_mode: local` inline gate
   *  to verify the tested commit matches the remote PR head (#350). */
  getWorktreeHead?: (worktreePath: string) => Promise<string>;
}

/**
 * Read the most-recent `stage_accounting` event with `harness === "test-gate"`
 * from the run's event log. Returns the outcome and the worktree HEAD SHA that
 * was recorded at test time (pr_head_sha, if present). Returns `null` when no
 * test-gate event exists (run dir absent, log unreadable, or gate never ran).
 * Used by the `ci_mode: local` pre-merge CI gate (#350).
 */
async function latestTestGateOutcome(
  runDir: string | undefined,
  readRunEventsFn: typeof readEvents,
): Promise<{ outcome: "success" | "failure"; prHeadSha: string | null } | null> {
  if (!runDir) return null;
  let events: Awaited<ReturnType<typeof readEvents>>;
  try {
    events = await readRunEventsFn(runDir);
  } catch {
    return null;
  }
  const testGateEvents = events.filter(
    (e): e is StageAccountingEvent =>
      e.type === "stage_accounting" && (e as StageAccountingEvent).harness === "test-gate",
  );
  if (testGateEvents.length === 0) return null;
  const last = testGateEvents[testGateEvents.length - 1]!;
  return {
    outcome: last.outcome === "success" ? "success" : "failure",
    prHeadSha: last.pr_head_sha ?? null,
  };
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
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const transitionFn = deps.transition ?? transition;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;
  const getHeadCheckRunCountFn = deps.getHeadCheckRunCount ?? getHeadCheckRunCount;
  const getSuccessfulCheckRunCountFn = deps.getSuccessfulCheckRunCount ?? getSuccessfulCheckRunCount;
  const closePrFn = deps.closePr ?? closePr;
  const reopenPrFn = deps.reopenPr ?? reopenPr;
  const getDiffFilePathsFn = deps.getDiffFilePaths ?? defaultGetDiffFilePaths;
  const nowMsFn = deps.nowMs ?? (() => Date.now());

  console.log(`[pipeline] #${issueNumber}: pre-merge gate`);

  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(cfg, issueNumber, "No pull request found for pre-merge gate.", "pre-merge", "needs-human");
    return { advanced: false, status: "blocked", reason: "no PR" };
  }

  if (opts.dryRun) {
    // Always route through visual-gate (#395); a disabled visual-gate skips
    // itself forward to the first enabled later gate — see stages/visual.ts.
    console.log(`[pipeline] #${issueNumber}: [dry-run] would archive+CI+merge for PR #${prNumber}`);
    return { advanced: true, from: "pre-merge", to: "visual-gate", summary: "[dry-run]" };
  }

  // ---- Review-SHA gate (#16): runs before any pre-merge work ----
  // pre-merge is the only stage that acts on a prior review verdict without
  // re-running review, so it is where a stale approval would slip through. If
  // HEAD has moved past the reviewed commit via a developer/fix commit, bounce
  // back to the review round before doing any pre-merge work; pipeline-internal
  // commits (openspec archive) do not invalidate the verdict.

  // Wire the bounded pre-merge auto-fix dep (#359): when the implementer harness
  // is configured and no seam is injected by the caller, build a production closure
  // that invokes `performPreMergeAutoFix` (fix + amend + push) for the gate to call.
  const gitFnForAutoFix = deps.gitInWorktree ?? gitInWorktree;
  const invokeFnForAutoFix = deps.invokeFn ?? invoke;
  const getForIssueForAutoFix = deps.getForIssue ?? getOnDiskForIssue;
  const preAutoFixFn: ShaGateDeps["attemptPreMergeAutoFix"] =
    deps.attemptPreMergeAutoFix ??
    (cfg.harnesses?.implementer
      ? async (blockingFindings, issueTitle, findingsText) => {
          const wt = await getForIssueForAutoFix(cfg, issueNumber);
          if (!wt) return { status: "error" };
          return performPreMergeAutoFix(
            cfg,
            issueNumber,
            pipelineRunId,
            findingsText,
            issueTitle,
            wt,
            gitFnForAutoFix,
            invokeFnForAutoFix,
          );
        }
      : undefined);

  const shaGate = await enforceReviewShaGate(
    cfg,
    issueNumber,
    prNumber,
    {
      ...deps,
      runDir: opts.runDir,
      runStoreDeps: opts.runStoreDeps,
      attemptPreMergeAutoFix: preAutoFixFn,
    },
  );
  if (shaGate) return shaGate;

  // ---- Capture pre-archive SHA for the no-run recovery path (#281) ----
  // Done once per polling session (when pollingCtx exists and preArchiveSha is not
  // yet set). Captures the current PR head — the developer's last commit — before
  // maybeArchiveOpenspec potentially pushes an archive commit that moves HEAD.
  // Subsequent polls find preArchiveSha already set and skip this fetch.
  if (opts.pollingCtx && !opts.pollingCtx.preArchiveSha) {
    try {
      const preArchiveDetail = await getPrDetailFn(cfg, prNumber);
      opts.pollingCtx.preArchiveSha = preArchiveDetail.head_sha;
    } catch {
      // Fetch failed; no-run recovery will use the non-archive fallback path.
    }
  }

  // ---- Step 0: OpenSpec archive (once; folds change deltas into living specs) ----
  const archiveOutcome = await maybeArchiveOpenspec(
    cfg,
    issueNumber,
    pipelineRunId,
    { ...deps, runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
    opts.stateDir,
    prNumber,
  );
  if (archiveOutcome) return archiveOutcome;

  // ---- Step 0.6: head-side active-change guard (#467) ----
  // Worktree-independent postcondition: even if the archive step above no-opped
  // for a reason not yet enumerated, pre-merge must never advance while the PR's
  // own changed-file list still carries an unarchived `openspec/changes/<id>/`
  // path it introduced. Behaves identically on a first run, an override-resumed
  // run, a fresh process, or after the worktree has been removed. Skipped when
  // `openspec.enabled: off` explicitly disables the integration (matches
  // maybeArchiveOpenspec's own off-mode skip above).
  if (cfg.openspec?.enabled !== "off") {
    const openspecGuardOutcome = await enforceOpenspecActiveChangeGuard(cfg, issueNumber, prNumber, deps);
    if (openspecGuardOutcome) return openspecGuardOutcome;
  }

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
  // localTestedSha is set by the local-mode branch and re-checked after the
  // mergeability refetch to catch pushes that arrive during Step 2. It stays
  // null in github mode (unused).
  let localTestedSha: string | null = null;

  if ((cfg.ci_mode ?? "github") === "local") {
    // Local mode (#350): verify CI using the current run's recorded test-gate outcome
    // instead of polling GitHub Actions check-runs. The conflict pre-check, mergeability
    // gate, and OpenSpec-validation gate are unaffected and still run below.
    const readRunEventsFn = deps.readRunEvents ?? readEvents;
    const runTestGateFn = deps.runTestGate ?? runTestGate;
    const tgResult = await latestTestGateOutcome(opts.runDir, readRunEventsFn);

    const isAbsent = tgResult === null;
    // Only treat as stale when the result is a success: a failure blocks regardless
    // of which commit was tested (the developer must fix the tests). A successful
    // result from an old commit needs re-validation against the current PR head.
    const isStale = tgResult !== null &&
      tgResult.outcome === "success" &&
      (!tgResult.prHeadSha || prDetail.head_sha !== tgResult.prHeadSha);

    if (isAbsent || isStale) {
      // No usable cached result (first entry to pre-merge, or PR head moved after
      // an OpenSpec archive commit or rebase). Run the test gate inline against the
      // current worktree so recovery is deterministic rather than a re-run dead-end.
      const localWt = await getForIssueFn(cfg, issueNumber);
      if (!localWt) {
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — no worktree found for this issue; cannot run the local test gate " +
            "from pre-merge. Ensure the pipeline created a worktree, or switch to ci_mode: github.",
          "pre-merge",
          "needs-human",
        );
        return { advanced: false, status: "blocked", reason: "ci_mode: local — no worktree for inline gate" };
      }
      const inlineResult = await runTestGateFn(
        cfg,
        issueNumber,
        localWt.path,
        {},
        pipelineRunId,
        "pre-merge",
        opts.stateDir,
        opts.runDir,
      );
      if (inlineResult.skipped) {
        // Fail-closed: skipped means the test gate is disabled or no command was detected.
        // ci_mode: local must not advance without a verified local exit-0 result.
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline local test gate was skipped (test_gate is disabled or no " +
            "test command was detected). ci_mode: local requires a verified local exit-0 result. " +
            "Enable test_gate with a test command, or switch to ci_mode: github.",
          "pre-merge",
          "needs-human",
        );
        return { advanced: false, status: "blocked", reason: "ci_mode: local — inline test gate skipped (fail-closed)" };
      }
      if (!inlineResult.passed) {
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline local test gate (run from pre-merge) failed. " +
            "Fix the failing tests, push a new commit, and re-run the pipeline.",
          "pre-merge",
          "needs-human",
        );
        return { advanced: false, status: "blocked", reason: "ci_mode: local — inline test gate failed" };
      }
      if ((inlineResult.attempts ?? 0) > 0) {
        // The test gate invoked the implementer harness (test-and-fix mode) and may
        // have created commits. Those commits exist only in the local worktree and are
        // not on the remote PR head. Certifying the remote PR head would advance an
        // untested commit. Block: push the fix commits and re-run the pipeline.
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline test gate invoked the implementer harness to fix " +
            `failing tests (${inlineResult.attempts} attempt(s)). ` +
            "Any fix commits exist only in the local worktree. " +
            "Push the fix commits to the PR branch, then re-run the pipeline so the full " +
            "review → pre-merge path covers the updated code.",
          "pre-merge",
          "needs-human",
        );
        return { advanced: false, status: "blocked", reason: "ci_mode: local — inline gate created fix commits; push required" };
      }
      // Verify the actual worktree HEAD matches the remote PR head. A prior inline
      // gate run may have created fix commits (attempts > 0) and blocked; if the user
      // retries without pushing, those commits remain in the worktree. A subsequent
      // run passes with attempts === 0 (no new harness calls needed) but tests the
      // ahead worktree, not the remote PR head. (#350 pre-merge finding)
      const gitFnForHead = deps.gitInWorktree ?? gitInWorktree;
      const getWorktreeHeadFn = deps.getWorktreeHead ??
        ((wt: string) => gitFnForHead(wt, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim()));
      const worktreeHead = await getWorktreeHeadFn(localWt.path);
      if (worktreeHead !== prDetail.head_sha) {
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the local worktree is ahead of the remote PR head " +
            `(worktree HEAD ${worktreeHead.slice(0, 7)}, PR head ${prDetail.head_sha.slice(0, 7)}). ` +
            "Push the worktree commits to the PR branch, then re-run the pipeline.",
          "pre-merge",
          "needs-human",
        );
        return { advanced: false, status: "blocked", reason: "ci_mode: local — worktree ahead of PR head; push required" };
      }
      localTestedSha = prDetail.head_sha;
    } else if (tgResult.outcome !== "success") {
      await setBlockedFn(
        cfg,
        issueNumber,
        "ci_mode: local is set but the most recent local test-gate result is a failure. " +
          "Fix the failing tests, push a new commit to re-run the test gate, then re-run the pipeline.",
        "pre-merge",
        "needs-human",
      );
      return {
        advanced: false,
        status: "blocked",
        reason: "ci_mode: local — local test gate failed",
      };
    } else {
      localTestedSha = tgResult.prHeadSha!;
    }

    console.log(
      `[pipeline] #${issueNumber}: ci_mode: local — local test gate passed; skipping GitHub Actions wait`,
    );
    // Local test gate passed: fall through to Step 2 (mergeability) and Step 2.5 (OpenSpec).
    // Do NOT return early — the downstream gates must still run.
  } else {
    // github mode (default): poll GitHub Actions check-runs.
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
      // No-run recovery (#281): when GitHub Actions never fires a run for the head
      // SHA (e.g. after an archive-only commit), `getPrChecks` returns a stale
      // pending state indefinitely. After the grace window, query the check-runs API
      // directly. Zero runs → enter recovery rather than polling out ci_timeout.
      // Only active when a polling context is present (advancePolling session).
      const ctx = opts.pollingCtx;
      if (ctx) {
        const headSha = prDetail.head_sha;
        if (ctx.ciGateEnteredAt === undefined) ctx.ciGateEnteredAt = nowMsFn();
        const elapsed = nowMsFn() - ctx.ciGateEnteredAt;
        if (elapsed >= (cfg.ci_no_run_grace_s ?? 60) * 1000) {
          let runCount: number;
          try {
            runCount = await getHeadCheckRunCountFn(cfg, headSha);
          } catch {
            runCount = -1; // API failure → treat as "runs exist" (conservative-open)
          }
          if (runCount === 0) {
            return handleZeroRunRecovery(cfg, issueNumber, prNumber, headSha, ctx,
              setBlockedFn, closePrFn, reopenPrFn, getSuccessfulCheckRunCountFn, getDiffFilePathsFn);
          }
        }
      }
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

  // Final SHA re-check for ci_mode: local: a developer push that arrives
  // between the test-gate completion and this mergeability refetch would
  // produce a freshPrDetail.head_sha that differs from the SHA we actually
  // tested. Re-verify so we never certify an untested commit. (#350 pre-merge fix)
  if (localTestedSha !== null && freshPrDetail.head_sha !== localTestedSha) {
    const testedAt = localTestedSha.slice(0, 7);
    await setBlockedFn(
      cfg,
      issueNumber,
      "ci_mode: local — PR head moved after the local test gate ran " +
        `(tested ${testedAt}, current head ${freshPrDetail.head_sha.slice(0, 7)}). ` +
        "Re-run the pipeline to run the local test gate against the current head.",
      "pre-merge",
      "needs-human",
    );
    return { advanced: false, status: "blocked", reason: "ci_mode: local — PR head moved after SHA re-check" };
  }
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
    const mergeConflictMsg = "PR branch is behind the base branch and could not be automatically updated — manual rebase or update needed.";
    await setBlockedFn(cfg, issueNumber, mergeConflictMsg, "pre-merge", "merge-conflict");
    return { advanced: false, status: "blocked", reason: mergeConflictMsg, blockerKind: "merge-conflict" };
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
  // Always route through visual-gate (#395), matching the infographic's
  // visual-gate → eval-gate order. A disabled visual-gate is not a case
  // pre-merge special-cases here — the visual-gate stage itself skips forward
  // to the first enabled later gate (mirroring eval-gate's own disabled path).
  const nextStage: Stage = "visual-gate";
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
  accounting?: {
    runDir?: string;
    runStoreDeps?: RunStoreDeps;
    priorRoundsDigest?: PriorRoundDigest;
    /** Resolved-finding verification entries (#496); see {@link ReadHeadFilesFn}. */
    settledFindingsVerification?: SettledFindingVerification[];
    /** HEAD content of the files those entries' surfaces name (#496). */
    headFiles?: HeadFileState[];
  },
) => Promise<DeltaReviewResult>;

/**
 * Injectable seam (#496 task 2.1) for reading a set of files' content at the
 * reviewed head from the delta reviewer's worktree — the resolved-finding
 * verification context's evidence surface. Returns one entry per requested
 * `path`, in the same order, so unit tests can assert deterministically.
 */
export type ReadHeadFilesFn = (worktreePath: string, treeSha: string, paths: string[]) => Promise<HeadFileState[]>;

/** Per-file byte cap for the HEAD file-state injection (#496 design.md
 *  Decision 3), next to the existing 50KB diff cap so the total prompt
 *  budget is reviewable in one place. */
export const HEAD_FILE_PER_FILE_CAP = 8_000;
/** Total byte cap across all injected HEAD files (#496 design.md Decision 3). */
export const HEAD_FILE_TOTAL_CAP = 24_000;

/** Default implementation of the `readHeadFiles` seam (#496): reads each
 *  requested path from the IMMUTABLE reviewed Git tree (`git show
 *  <treeSha>:<path>`), never from the mutable worktree filesystem — so no
 *  concurrent writer, symlink swap, or validation-to-read race can inject
 *  external content or fake deletion evidence (#496 delta finding 8f981a57);
 *  the object store is the security boundary. Bounded by
 *  {@link HEAD_FILE_PER_FILE_CAP} and {@link HEAD_FILE_TOTAL_CAP}. A path
 *  absent from the tree yields `present: false` with `"not-found"` — citable
 *  deletion evidence (design.md Decision 3). A traversal-shaped path is
 *  `"rejected"` without ever reaching git (#496 finding cdd406db); symlinks
 *  in the tree are blobs of link text, not followed (#496 finding 702a99fc).
 */
export async function defaultReadHeadFiles(
  worktreePath: string,
  treeSha: string,
  paths: string[],
  gitFn: typeof gitInWorktree = gitInWorktree,
): Promise<HeadFileState[]> {
  const results: HeadFileState[] = [];
  let totalUsed = 0;
  for (const p of paths) {
    // Runtime string guard (#496 delta finding cdd406db round 2, refined for
    // 49da0f1a7403d6f4): surfaces originate in untrusted prior-review history
    // and types are stripped at runtime — a non-string value must render as
    // rejected, never throw. String(p) is unsafe here: a malformed value like
    // { toString: null } throws TypeError during coercion instead of
    // rejecting cleanly, so a fixed marker is used instead of coercing.
    if (typeof p !== "string") {
      results.push({ path: "<non-string surface>", content: "", truncated: false, present: false, absenceReason: "rejected" });
      continue;
    }
    const rel = path.posix.normalize(p.split(path.sep).join(path.posix.sep));
    if (rel === "" || rel === "." || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
      results.push({ path: p, content: "", truncated: false, present: false, absenceReason: "rejected" });
      continue;
    }
    const shown = await gitFn(worktreePath, ["show", `${treeSha}:${rel}`], { ignoreFailure: true });
    if (shown.code !== 0) {
      const absenceReason =
        /does not exist|exists on disk, but not in|invalid object name|not a valid object name/i.test(shown.stderr)
          ? "not-found"
          : "unreadable";
      results.push({ path: p, content: "", truncated: false, present: false, absenceReason });
      continue;
    }
    let content = shown.stdout;
    let truncated = false;
    if (content.length > HEAD_FILE_PER_FILE_CAP) {
      content = content.slice(0, HEAD_FILE_PER_FILE_CAP);
      truncated = true;
    }
    const remaining = HEAD_FILE_TOTAL_CAP - totalUsed;
    if (content.length > remaining) {
      content = content.slice(0, Math.max(remaining, 0));
      truncated = true;
    }
    totalUsed += content.length;
    results.push({ path: p, content, truncated, present: true });
  }
  return results;
}

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
   * Optional `worktreePath` (#371): the source directory to diff from. Defaults
   * to `cfg.repo_dir`, which is not fetched mid-run and can lack a commit object
   * pushed earlier in this same run (e.g. the pre-merge auto-fix commit) — pass
   * the issue worktree path, which authored that commit, to guarantee it's present.
   */
  getCommitDeltaDiff?: (
    cfg: PipelineConfig,
    prNumber: number,
    baseSha: string,
    headSha: string,
    worktreePath?: string,
  ) => Promise<string>;
  /** Runs the pre-merge delta review (#228) and returns the parsed verdict. */
  runDeltaReview?: RunDeltaReviewFn;
  /** Reads settled findings' surface files at the reviewed head from the
   *  delta worktree (#496). Default: {@link defaultReadHeadFiles}. */
  readHeadFiles?: ReadHeadFilesFn;
  postComment?: typeof postComment;
  transition?: typeof transition;
  setBlocked?: typeof setBlocked;
  /** Clears the blocked label when a post-write HEAD verify finds the blocking
   *  verdict was superseded while the block was being persisted (#481 delta
   *  finding 6eadb958 — self-heal instead of stranding a stale block). */
  clearBlocked?: typeof clearBlocked;
  /** Looks up the issue worktree path and slug for the delta reviewer's CWD and OpenSpec context (#228). */
  getForIssue?: typeof getForIssue;
  /** Returns the authenticated GitHub username so the SHA gate only trusts
   *  pipeline-authored review comments (#228 Finding 9). */
  getGhActor?: () => Promise<string | null>;
  runDir?: string;
  runStoreDeps?: RunStoreDeps;
  /**
   * Injectable seam for the bounded pre-merge auto-fix round (#359).
   * When provided, called when (a) all blocking delta-review findings pass
   * `allBlockingAutoFixable` and (b) no prior auto-fix commit is present in
   * the branch since the reviewed SHA. Production default: wired in
   * `advance()` as a closure over the implementer harness and worktree.
   * Tests inject this directly to exercise the blocking-branch routing without
   * a real harness, git, or network.
   */
  attemptPreMergeAutoFix?: AttemptPreMergeAutoFixFn;
  /**
   * Authoritative remote-ref read for the post-fix head revalidation (#371
   * pre-merge delta review, key 8ad8b7f0). Returns the SHA `refs/heads/<branch>`
   * currently points at on origin, or null when the ref cannot be read. Used
   * only when the GitHub-API PR-head read still echoes the known pre-fix head
   * after an approving post-fix re-review — that read is indistinguishable
   * from a stale read masking a genuinely newer concurrent push, so the guard
   * must consult `git ls-remote` (which reads the live ref, not a cached API
   * view) before proceeding. Production default: `defaultGetRemoteHead`.
   */
  getRemoteHead?: (cwd: string, branch: string) => Promise<string | null>;
  /** Files the single tracked follow-up issue at the pre-merge delta-round
   *  ceiling under `ceiling_action: demote_and_advance` (#483). Mirrors the
   *  review-2 ceiling's seam. */
  createIssue?: (title: string, body: string, labels: string[]) => Promise<number>;
  /** Appends to an existing delta-round-ceiling follow-up issue on re-entry (#483). */
  addIssueComment?: (issueNumber: number, body: string) => Promise<void>;
}

/** `git ls-remote origin refs/heads/<branch>` from `cwd`; null on any failure. */
async function defaultGetRemoteHead(cwd: string, branch: string): Promise<string | null> {
  const res = await gitInWorktree(
    cwd, ["ls-remote", "origin", `refs/heads/${branch}`], { ignoreFailure: true },
  );
  if (res.code !== 0) return null;
  const sha = res.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
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
  const readHeadFilesFn = deps.readHeadFiles ?? defaultReadHeadFiles;
  const getRemoteHeadFn = deps.getRemoteHead ?? defaultGetRemoteHead;
  const createIssueFn = deps.createIssue ?? ((title: string, body: string, labels: string[]) => createIssue(cfg, title, body, labels));
  const addIssueCommentFn = deps.addIssueComment ?? ((issueNum: number, body: string) => addIssueComment(cfg, issueNum, body));
  const postCommentFn = deps.postComment ?? postComment;
  const transitionFn = deps.transition ?? transition;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const clearBlockedFn = deps.clearBlocked ?? clearBlocked;
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
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
  // SHA extraction uses actor-only trust: allowlisted actors must NOT be trusted
  // for review verdict comments as any allowlisted identity could otherwise post a
  // forged approval header and bypass the SHA gate (#229 Finding 8).
  const trustedComments = detail.comments.filter((c) => c.author === actor);
  // Override/scope extraction uses the broader allowlist set (#229 Findings 4, 5, 6).
  const trustedOverrideComments = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);

  const reviewed = extractReviewedSha(trustedComments);
  // No prior review from the current actor found. Three sub-cases:
  // (a) No review comments at all (review disabled, first run) → proceed normally.
  // (b) Review comments from arbitrary commenters (e.g. forged headers) → proceed; do
  //     not trigger re-review on arbitrary non-actor comments (DoS risk: any commenter
  //     could post a review-headed comment to cause endless re-reviews).
  // (c) Review comments from an explicitly trusted prior runner (in trusted_override_actors)
  //     — DO NOT silently proceed, that skips blocker enforcement (#229 Finding 7).
  //     Route to re-review so the current actor establishes its own verified baseline.
  if (!reviewed) {
    const allowlist = cfg.trusted_override_actors ?? [];
    if (allowlist.length > 0) {
      const hasAllowlistedReview = detail.comments.some(
        (c) =>
          c.author != null &&
          c.author !== actor &&
          allowlist.includes(c.author) &&
          (c.body.startsWith("## Review 1") ||
            c.body.startsWith("## Review 2") ||
            c.body.startsWith(DELTA_REVIEW_MARKER_PREFIX)),
      );
      if (hasAllowlistedReview) {
        // Select the highest-enabled review stage to re-run. If all review steps are
        // disabled, do not route to a review stage that will be immediately skipped back
        // to pre-merge (livelock — #229 Finding 9). In that case just proceed.
        const reviewStage: Stage | null = cfg.steps.adversarial_review
          ? "review-2"
          : cfg.steps.standard_review
            ? "review-1"
            : null;
        if (reviewStage === null) {
          // Reviews are fully disabled — cannot re-run review. If the prior allowlisted
          // runner's comment carried unresolved blocking keys, block rather than silently
          // skip blocker enforcement (#229 Finding 10). Only proceed when the prior review
          // was approve/advisory-only or all keys are explicitly overridden.
          const priorReviewComment = detail.comments
            .filter(
              (c) =>
                c.author != null &&
                c.author !== actor &&
                allowlist.includes(c.author as string) &&
                (c.body.startsWith("## Review 1") ||
                  c.body.startsWith("## Review 2") ||
                  c.body.startsWith(DELTA_REVIEW_MARKER_PREFIX)),
            )
            .at(-1);
          if (priorReviewComment) {
            // Primary: prefer artifact for blocking-keys read (#264); fall back to legacy
            // extractor (scrapes override-key tokens) for comments without an artifact.
            // An explicit empty marker / empty artifact.blockingKeys is "no blockers".
            const _priorArtifact = extractReviewArtifact(priorReviewComment.body);
            const recorded = _priorArtifact !== null
              ? new Set(_priorArtifact.blockingKeys)
              : extractBlockingKeysFromComment(priorReviewComment.body);
            if (recorded.size > 0) {
              const overrides = extractOverrides(trustedOverrideComments);
              const unresolved = [...recorded].filter((k) => !overrides.has(k));
              if (unresolved.length > 0) {
                await setBlockedFn(
                  cfg,
                  issueNumber,
                  `Pre-merge: prior runner recorded ${unresolved.length} unresolved blocking ` +
                    `finding(s) (${unresolved.join(", ")}). Reviews are disabled, so ` +
                    `\`--override\` each key before pre-merge can proceed.`,
                  "pre-merge",
                  "needs-human",
                );
                return {
                  advanced: false,
                  status: "blocked",
                  reason: `pre-merge: ${unresolved.length} unresolved blocking finding(s) from prior allowlisted runner (reviews disabled)`,
                };
              }
            }
          }
          // Prior review was approve/advisory-only or all keys overridden — fall through.
        } else {
          await postCommentFn(cfg, issueNumber, preMergeRerunIdentityNotice(actor));
          await transitionFn(cfg, issueNumber, "pre-merge", reviewStage);
          return { advanced: true, to: reviewStage };
        }
      }
    }
    return null;
  }

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
    // Primary: prefer artifact for blocking-keys read (#264); marker-only fallback
    // for pre-artifact comments. Null artifact + null marker = approve/advisory → no blockers.
    const _bodyArtifact = commentBody ? extractReviewArtifact(commentBody) : null;
    const recorded = _bodyArtifact !== null
      ? new Set(_bodyArtifact.blockingKeys)
      : (commentBody ? extractBlockingKeysMarker(commentBody) : null);
    if (!recorded || recorded.size === 0) return null;
    // Trust overrides from any authorized runner identity (#229 Findings 1, 4, 5).
    const overrides = extractOverrides(trustedOverrideComments);
    const unresolved = [...recorded].filter((k) => !overrides.has(k));
    if (unresolved.length === 0) return null;
    // Scoped overrides may cover the remaining key-only blockers, but we can't verify
    // without the actual finding objects. Force a fresh review so partitionFindings
    // can be called with live findings and scopes (#229).
    const activeScopes = extractScopedOverrides(trustedOverrideComments);
    if (activeScopes.length > 0) {
      const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
      await postCommentFn(cfg, issueNumber, preMergeRerunScopeNotice(unresolved.length));
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
  // reviewed-sha == HEAD; see reuseBlockedBy). `head` above was read once at
  // function entry, so a push can land between that read and the moment this
  // branch acts on it (including while `reuseBlockedBy` itself awaits
  // `setBlockedFn`) — re-resolve currency right before reusing recorded
  // blocking keys (#481 Finding 1) rather than trusting the frozen `head`.
  // `unknown` fails closed to the conservative full re-review path at the
  // bottom of this function instead of reusing the recorded verdict.
  if (reviewed.sha && reviewed.sha === head) {
    try {
      const currency = await resolveReviewedShaCurrency(cfg, prNumber, reviewed.sha, {
        getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
      });
      if (currency.status === "current") {
        return (
          (await reuseBlockedBy(findLatestReviewCommentBody(trustedComments, reviewed.round), "")) ??
          null
        );
      }
      if (currency.status === "unknown") {
        throw new Error(
          `cannot confirm reviewed SHA ${reviewed.sha.slice(0, 7)} is still the PR head; ` +
            `falling back to conservative re-review`,
        );
      }
      // superseded: a push landed between the initial `head` read and this
      // check — fall through to the pipeline-internal-commits / diff-hash
      // checks below rather than reusing recorded blocking keys.
    } catch (err) {
      if (err instanceof Error && err.message.includes("cannot confirm reviewed SHA")) {
        console.warn(`[pipeline] #${issueNumber}: ${err.message}`);
        const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
        await postCommentFn(cfg, issueNumber, staleReviewNotice(reviewed.sha, head));
        await transitionFn(
          cfg,
          issueNumber,
          "pre-merge",
          reviewStage,
          `Re-running review ${reviewed.round}: cannot confirm reviewed SHA ` +
            `\`${reviewed.sha.slice(0, 7)}\` is still the PR head; falling back to conservative re-review.`,
        );
        return {
          advanced: true,
          from: "pre-merge",
          to: reviewStage,
          summary: `re-review: cannot confirm reviewed SHA currency`,
        };
      }
      throw err;
    }
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
      // Primary: prefer artifact for diff-hash read (#264); sentinel fallback for pre-artifact.
      const _priorArtifact2 = priorCommentBody ? extractReviewArtifact(priorCommentBody) : null;
      const cachedHash = _priorArtifact2?.diffHash ?? (priorCommentBody ? extractDiffHashFromComment(priorCommentBody) : null);

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

      // Pre-merge delta-round ceiling (#483): the diff changed and the prior
      // verdict is stale, so a delta review would normally run — but bound how
      // many times that can happen per item. Computed BEFORE invoking the
      // reviewer, purely from the durable delta-review comment thread, so this
      // check never depends on run-local state.
      const deltaRoundCount = countDeltaRounds(detail.comments, {
        actor, trustedOverrideActors: cfg.trusted_override_actors,
      });
      const deltaRoundCap = cfg.review_policy.max_delta_rounds;
      if (deltaRoundCap > 0 && deltaRoundCount >= deltaRoundCap) {
        if (deps.runDir) {
          const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          await appendEvent(deps.runDir, {
            schema_version: RUN_SCHEMA_VERSION, type: "delta_round_ceiling", at,
            observed: deltaRoundCount, cap: deltaRoundCap, ceiling_action: cfg.review_policy.ceiling_action,
          }, deps.runStoreDeps).catch(() => {});
        }

        // Reconstruct the outstanding blocking delta findings from the last
        // trusted delta-review comment — no reviewer invocation happens at the
        // ceiling, so there is no fresh ReviewFinding to partition. Filter out
        // any key since overridden by a trusted operator disposition.
        const lastDeltaComment = trustedComments
          .filter((c) => c.body.startsWith(DELTA_REVIEW_MARKER_PREFIX))
          .at(-1);
        const lastDeltaArtifact = lastDeltaComment ? extractReviewArtifact(lastDeltaComment.body) : null;
        const rawOutstanding: DeltaCeilingFinding[] = lastDeltaArtifact?.blockingFindings
          ? lastDeltaArtifact.blockingFindings.map((f) => ({
              key: f.key, surface: f.surface, severity: f.severity, title: f.title,
            }))
          : [...(lastDeltaComment ? (extractBlockingKeysMarker(lastDeltaComment.body) ?? new Set<string>()) : new Set<string>())]
              .map((key) => ({ key, surface: null, severity: "unknown", title: "(title unavailable)" }));
        const currentOverrides = extractOverrides(trustedOverrideComments);
        const outstanding = rawOutstanding.filter((f) => !currentOverrides.has(f.key));

        if (outstanding.length === 0) {
          // Every previously-recorded blocking key is now overridden (or the
          // last delta round left nothing blocking) — nothing to disposition;
          // proceed as if the gate passed.
          console.log(
            `[pipeline] #${issueNumber}: pre-merge delta-round ceiling reached (${deltaRoundCount}/${deltaRoundCap}) ` +
            `with no outstanding blocking findings; proceeding`,
          );
          return null;
        }

        const highOrCritical = outstanding.filter((f) => severityRank(f.severity) >= severityRank("high"));
        const belowHigh = outstanding.filter((f) => severityRank(f.severity) < severityRank("high"));
        const shouldDemote =
          cfg.review_policy.ceiling_action === "demote_and_advance" &&
          highOrCritical.length === 0 &&
          belowHigh.length > 0;

        if (!shouldDemote) {
          await postCommentFn(
            cfg, issueNumber,
            deltaRoundCeilingComment(cfg, deltaRoundCount, deltaRoundCap, cfg.review_policy.ceiling_action, outstanding),
          );
          await setBlockedFn(
            cfg, issueNumber,
            `Pre-merge delta review reached the ${deltaRoundCap}-round ceiling with ${outstanding.length} ` +
              `unresolved blocking finding(s).`,
            "pre-merge", "needs-human",
          );
          return {
            advanced: false,
            status: "blocked",
            reason: `pre-merge delta-round ceiling: ${outstanding.length} unresolved blocking finding(s)`,
          };
        }

        const existingFollowup = extractCeilingFollowupNumber(detail.comments, actor);
        let followupNumber: number;
        if (existingFollowup !== null) {
          followupNumber = existingFollowup;
          await addIssueCommentFn(followupNumber, buildDeltaFollowupUpdateComment(issueNumber, deltaRoundCount, belowHigh));
        } else {
          followupNumber = await createIssueFn(
            `[Deferred] Pre-merge delta review ceiling findings from #${issueNumber}`,
            buildDeltaFollowupIssueBody(issueNumber, belowHigh),
            [],
          );
        }

        await postCommentFn(
          cfg, issueNumber,
          deltaRoundCeilingDemotionComment(cfg, deltaRoundCount, deltaRoundCap, belowHigh, followupNumber),
        );

        const ceilingTimestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        for (const f of belowHigh) {
          const disposition = `deferred-#${followupNumber}`;
          const body = overrideComment({
            key: f.key,
            disposition,
            reason: `auto-demoted at pre-merge delta-round ceiling (round ${deltaRoundCount}/${deltaRoundCap}); deferred to #${followupNumber}`,
            stage: "pre-merge",
            timestamp: ceilingTimestamp,
            footer: cfg.marker_footer,
          });
          await postCommentFn(cfg, issueNumber, body);
        }

        console.log(
          `[pipeline] #${issueNumber}: pre-merge delta-round ceiling (${deltaRoundCount}/${deltaRoundCap}); ` +
          `${belowHigh.length} below-high finding(s) demoted, advancing (follow-up #${followupNumber})`,
        );
        return null;
      }

      // Resolve worktree and spec context for the delta reviewer (Finding 3): the
      // delta reviewer must run from the issue worktree (not cfg.repo_dir) so it
      // can inspect PR-branch files, and must receive OpenSpec context for any
      // change dirs touched by the unreviewed commits. Resolved before the diff
      // call (#371) so the delta diff itself also reads from the worktree — the
      // source that authored any commit pushed earlier in this same run (e.g. a
      // pre-merge auto-fix commit); `cfg.repo_dir` is not fetched mid-run and can
      // lack that object immediately after the push.
      const deltaWt = await getForIssueFn(cfg, issueNumber);
      const deltaWorktreePath = deltaWt?.path ?? cfg.repo_dir;

      // Diff changed: run a focused adversarial delta review of only the unreviewed
      // commits instead of routing back to a full review-2 round. The delta review
      // does NOT count against the max_adversarial_rounds ceiling.
      //
      // The SHA a delta review targets can be superseded by a further fix push
      // landing while the (slow) reviewer invocation is in flight (#481). Before
      // recording anything for `targetHead`, re-validate it against the PR head:
      // on supersession, discard the verdict — no blocking authority, no
      // reviewed-sha claim on the new head — and re-run the delta review against
      // it instead, bounded by MAX_DELTA_SUPERSESSION_RETRIES so a branch under
      // continuous pushes degrades to the conservative full re-review path below
      // rather than looping.
      let targetHead = head;
      let deltaDiff = reviewed.sha
        ? await getCommitDeltaDiffFn(cfg, prNumber, reviewed.sha, targetHead, deltaWorktreePath)
        : currentDiff; // reviewed SHA missing → review the full diff as the delta
      let deltaSpecContext = deltaWt
        ? openspecContextFromDiff(cfg, deltaWt.path, diffFilePaths(deltaDiff))
        : "";

      if (deps.runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(deps.runDir, {
          schema_version: RUN_SCHEMA_VERSION, type: "delta_round", at,
          round: deltaRoundCount + 1, cap: deltaRoundCap,
        }, deps.runStoreDeps).catch(() => {});
      }

      let deltaResult: DeltaReviewResult;
      let priorRoundsDigest: PriorRoundDigest;
      let settledVerification: SettledFindingVerification[] = [];
      let headFiles: HeadFileState[] = [];
      let supersessionAttempts = 0;
      for (;;) {
        // Cross-round memory digest (#389): the pre-merge delta review is one of
        // the rounds that can see prior-round history.
        priorRoundsDigest = buildPriorRoundDigest(detail.comments, {
          actor, trustedOverrideActors: cfg.trusted_override_actors,
        });
        // Resolved-finding verification context (#496): the settled findings
        // from the digest, plus their surfaces' HEAD content, so the delta
        // reviewer can verify a claimed resolution instead of assuming
        // persistence. Absent settled history => no read, no context (design.md
        // Decision 5) — the delta prompt stays byte-identical to before #496.
        settledVerification = settledFindingsVerification(priorRoundsDigest);
        headFiles = settledVerification.length > 0
          ? await readHeadFilesFn(deltaWorktreePath, targetHead, settledFindingsSurfaceFiles(settledVerification))
          : [];
        deltaResult = await runDeltaReviewFn(
          cfg, issueNumber, detail, deltaDiff, deltaWorktreePath, deltaSpecContext,
          deps.runDir
            ? { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps, priorRoundsDigest, settledFindingsVerification: settledVerification, headFiles }
            : { priorRoundsDigest, settledFindingsVerification: settledVerification, headFiles },
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

        const currency = await resolveReviewedShaCurrency(cfg, prNumber, targetHead, {
          getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
        });
        if (currency.status === "current") break;
        if (currency.status === "unknown" || supersessionAttempts >= MAX_DELTA_SUPERSESSION_RETRIES) {
          throw new Error(
            currency.status === "unknown"
              ? `cannot confirm reviewed SHA ${targetHead.slice(0, 7)} is still the PR head; ` +
                `falling back to conservative re-review`
              : `delta review superseded again after ${supersessionAttempts} retry attempt(s); ` +
                `falling back to conservative re-review`,
          );
        }
        // Superseded: discard this verdict — post a superseded notice carrying no
        // blocking-key marker and no claim on the new head — then re-run the
        // delta review against it.
        await postCommentFn(cfg, issueNumber, supersededDeltaReviewNotice(targetHead, currency.headSha));
        supersessionAttempts++;
        targetHead = currency.headSha;
        deltaDiff = reviewed.sha
          ? await getCommitDeltaDiffFn(cfg, prNumber, reviewed.sha, targetHead, deltaWorktreePath)
          : await getPrDiffFn(cfg, prNumber);
        deltaSpecContext = deltaWt
          ? openspecContextFromDiff(cfg, deltaWt.path, diffFilePaths(deltaDiff))
          : "";
      }

      // Trust overrides from any authorized runner identity (#229 Findings 1, 4, 5).
      const overrides = extractOverrides(trustedOverrideComments);
      const scopes = extractScopedOverrides(trustedOverrideComments);
      const settled = settledFindings(priorRoundsDigest);
      const partition = partitionFindings(deltaResult.findings, cfg.review_policy, overrides, scopes, new Map(), null, settled);
      const reversalDemotions = new Map<string, ReversalMatch>();
      const alternativeDemotions = new Map<string, AlternativeReinstatementMatch>();
      for (const { finding, reason, reversalMatch, alternativeMatch } of partition.advisory) {
        if (reason === "reversal-unacknowledged" && reversalMatch) {
          reversalDemotions.set(findingKey(finding), reversalMatch);
          if (deps.runDir) {
            const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            await appendEvent(deps.runDir, {
              schema_version: RUN_SCHEMA_VERSION, type: "reversal_unacknowledged", at,
              finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
              settled_finding_key: reversalMatch.settledKey, settling_round: reversalMatch.settledRound,
              matched_by: reversalMatch.matchedBy,
            }, deps.runStoreDeps).catch(() => {});
          }
          continue;
        }
        if (reason === "settled-alternative-reinstated" && alternativeMatch) {
          alternativeDemotions.set(findingKey(finding), alternativeMatch);
          if (deps.runDir) {
            const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            await appendEvent(deps.runDir, {
              schema_version: RUN_SCHEMA_VERSION, type: "settled_alternative_reinstated", at,
              finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
              settled_finding_key: alternativeMatch.settledKey, settling_round: alternativeMatch.settledRound,
              matched_alternative: alternativeMatch.matchedAlternative,
            }, deps.runStoreDeps).catch(() => {});
          }
        }
      }

      // Resolved-finding evidence rule (#496): a still-blocking finding whose
      // surface matches a settled finding's surface, and which cites no
      // evidence drawn from the supplied HEAD file state, is demoted to
      // advisory — the same routing the #389 reversal machinery uses, with a
      // distinct reason so it is not double-reported as an unacknowledged
      // reversal. A no-op when there is no settled history (design.md
      // Decision 5). Runs AFTER the reversal/alternative guards above so a
      // finding already demoted there is not reconsidered here.
      const unverifiedSurfaceDemotions = new Map<string, UnverifiedSettledSurfaceMatch>();
      const evidenceResult = applySettledSurfaceEvidenceRule(partition.blocking, settledVerification, headFiles);
      partition.blocking = evidenceResult.blocking;
      for (const { finding, match } of evidenceResult.demoted) {
        partition.advisory.push({ finding, reason: "settled-surface-unverified", unverifiedSurfaceMatch: match });
        unverifiedSurfaceDemotions.set(findingKey(finding), match);
        if (deps.runDir) {
          const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          await appendEvent(deps.runDir, {
            schema_version: RUN_SCHEMA_VERSION, type: "settled_surface_unverified", at,
            finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
            settled_finding_key: match.settledKey, settling_round: match.settledRound,
          }, deps.runStoreDeps).catch(() => {});
        }
      }

      // Confidence-trend churn detector (#483): audit-only — labels the posted
      // comment and emits one event, never alters the blocking partition above.
      const churn = detectSuspectedChurn(partition.blocking, priorRoundsDigest);
      if (churn.suspected && deps.runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(deps.runDir, {
          schema_version: RUN_SCHEMA_VERSION, type: "delta_churn_suspected", at,
          round: deltaRoundCount + 1,
          axes: churn.axes.map((a) => ({
            surface: a.surface, prior_max_confidence: a.priorMaxConfidence, new_confidence: a.newConfidence,
          })),
        }, deps.runStoreDeps).catch(() => {});
      }

      const newHash = computeDiffHash(currentDiff);
      const deltaCommentVerdict = {
        verdict: deltaResult.verdict,
        summary: deltaResult.summary,
        findings: deltaResult.findings,
        next_steps: [] as string[],
        commitSha: targetHead,
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
        reversalDemotions,
        alternativeDemotions,
        churn,
        unverifiedSurfaceDemotions,
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
        // Re-validate HEAD (#481 Finding 2): the currency check above ran
        // BEFORE `postCommentFn` — itself a network call a fix-round push can
        // land during — so it does not cover a push landing while the comment
        // was being posted. Re-read HEAD now; if it moved past `targetHead`,
        // the approval covers a commit that is no longer HEAD. Rather than
        // proceeding on a stale approval, fall back to the conservative full
        // re-review path. We throw so the catch block handles the fallthrough.
        const postDeltaHead = (await getPrDetailFn(cfg, prNumber)).head_sha;
        if (postDeltaHead !== targetHead) {
          throw new Error(
            `PR HEAD moved from ${targetHead.slice(0, 7)} to ${postDeltaHead.slice(0, 7)} ` +
            `during delta review; delta approval is stale — re-entering SHA gate`,
          );
        }
        // Delta review approves (or findings all below policy): pre-merge proceeds.
        console.log(`[pipeline] #${issueNumber}: pre-merge delta review approved; proceeding`);
        return null;
      }

      // Delta review found blocking findings. Attempt one bounded auto-fix
      // before blocking when all findings are in the category allowlist (#359).
      // Tracks the head the verdict that will ultimately gate `setBlockedFn`
      // below was produced against — `targetHead` unless an auto-fix re-review
      // supersedes it (#481 review 2 finding 1).
      let finalBlockingHead = targetHead;
      const attemptAutoFixFn = deps.attemptPreMergeAutoFix;
      if (attemptAutoFixFn && allBlockingAutoFixable(partition.blocking)) {
        // One-attempt bound (crash-safe): detect a prior auto-fix commit by
        // scanning PR commits since the reviewed SHA for the PREFIX subject.
        let priorAutoFix = false;
        try {
          const prCommits = await getPrCommitsFn(cfg, prNumber);
          const revIdx = reviewed.sha
            ? prCommits.findIndex((c) => c.oid === reviewed.sha)
            : -1;
          const since = revIdx !== -1 ? prCommits.slice(revIdx + 1) : prCommits;
          priorAutoFix = since.some((c) =>
            c.messageHeadline.startsWith(PRE_MERGE_AUTOFIX_PREFIX),
          );
        } catch {
          // Cannot determine prior attempt — fail closed (#359): skipping the
          // auto-fix is safer than risking a second attempt when the durable
          // marker cannot be read (crash-safe at-most-one requirement).
          priorAutoFix = true;
        }

        if (!priorAutoFix) {
          // Scope the fix prompt to blocking findings only — not the full delta
          // comment which may include advisory/non-blocking findings (#359 R2 F3).
          const blockingOnlyBody = formatDeltaReviewComment(
            cfg,
            { ...deltaCommentVerdict, findings: partition.blocking },
            `pre-merge delta review by ${deltaReviewerLabel}`,
            blockingKeysSet.size > 0 ? blockingKeysSet : undefined,
            newHash,
          );
          const fixRes = await attemptAutoFixFn(
            partition.blocking, detail.title, blockingOnlyBody,
          );
          if (fixRes.status === "fix-committed") {
            // Re-run the delta review exactly once (does NOT consume a review-2
            // ceiling slot, consistent with the delta-review budget rule, #359).
            // Anchor to the auto-fix's authoritative post-fix head from local git
            // state (#371) — NOT a GitHub-API PR-head read, which can still return
            // the pre-fix head in the window immediately after the push and would
            // silently re-review the pre-fix diff (byte-identical to the first
            // review), re-emitting the finding the auto-fix just resolved.
            const newPrHead = fixRes.headSha;
            // Do NOT fall back to the pre-fix `currentDiff` if the post-fix diff
            // cannot be obtained (#359 R2 F1), including when `reviewed.sha` itself
            // is missing (#371 review 1 finding 1): a fallback would let the
            // reviewer approve a stale diff while recording `newPrHead` as
            // reviewed. Let the exception propagate to the outer catch, which
            // routes to the conservative full re-review without recording the new
            // head. Diff from `deltaWorktreePath` (#371) — the worktree that
            // authored the auto-fix commit — since `cfg.repo_dir` is not fetched
            // mid-run and may not yet contain that commit object.
            if (!reviewed.sha) {
              throw new Error(
                "no reviewed-sha recorded to diff the auto-fix commit " +
                  `${newPrHead.slice(0, 7)} against; cannot anchor post-fix re-review`,
              );
            }
            const reReviewDiff = await getCommitDeltaDiffFn(
              cfg, prNumber, reviewed.sha, newPrHead, deltaWorktreePath,
            );
            // Rebuild the digest from freshly fetched issue comments (review finding
            // #389 R1 F3): the just-posted delta-review comment (line ~1406 above)
            // is prior-round history for this re-review, and the digest captured
            // before that comment existed cannot demote a reversal against it.
            const reReviewIssueDetail = await getIssueDetailFn(cfg, issueNumber);
            const reReviewDigest = buildPriorRoundDigest(reReviewIssueDetail.comments, {
              actor, trustedOverrideActors: cfg.trusted_override_actors,
            });
            const reSettled = settledFindings(reReviewDigest);
            const reSettledVerification = settledFindingsVerification(reReviewDigest);
            const reHeadFiles = reSettledVerification.length > 0
              ? await readHeadFilesFn(deltaWorktreePath, newPrHead, settledFindingsSurfaceFiles(reSettledVerification))
              : [];
            const reResult = await runDeltaReviewFn(
              cfg, issueNumber, detail, reReviewDiff, deltaWorktreePath, deltaSpecContext,
              deps.runDir
                ? { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps, priorRoundsDigest: reReviewDigest, settledFindingsVerification: reSettledVerification, headFiles: reHeadFiles }
                : { priorRoundsDigest: reReviewDigest, settledFindingsVerification: reSettledVerification, headFiles: reHeadFiles },
            );
            const rePartition = partitionFindings(
              reResult.findings, cfg.review_policy, overrides, scopes, new Map(), null, reSettled,
            );
            // Resolved-finding evidence rule (#496), mirroring the primary
            // delta-review application above.
            const reUnverifiedSurfaceDemotions = new Map<string, UnverifiedSettledSurfaceMatch>();
            const reEvidenceResult = applySettledSurfaceEvidenceRule(rePartition.blocking, reSettledVerification, reHeadFiles);
            rePartition.blocking = reEvidenceResult.blocking;
            for (const { finding, match } of reEvidenceResult.demoted) {
              rePartition.advisory.push({ finding, reason: "settled-surface-unverified", unverifiedSurfaceMatch: match });
              reUnverifiedSurfaceDemotions.set(findingKey(finding), match);
              if (deps.runDir) {
                const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                await appendEvent(deps.runDir, {
                  schema_version: RUN_SCHEMA_VERSION, type: "settled_surface_unverified", at,
                  finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
                  settled_finding_key: match.settledKey, settling_round: match.settledRound,
                }, deps.runStoreDeps).catch(() => {});
              }
            }
            // Mirror the initial delta review guard (#228): needs-attention with zero
            // findings is likely unparseable reviewer output — block conservatively.
            // Detect BEFORE formatting/posting the comment so we do not write a
            // clean reviewed-sha artifact for unparseable output (#359 R2 F2).
            const reIsUnparseable =
              reResult.verdict === "needs-attention" && reResult.findings.length === 0;
            // Post the re-review delta comment with updated sentinels.
            // Use the post-fix diff hash (reReviewDiff), not the pre-fix currentDiff (#359 R2 F1).
            // Suppress commitSha for unparseable output so the reuse path cannot
            // treat the artifact as a clean approval (#359 R2 F2).
            const reNewHash = computeDiffHash(reReviewDiff);
            const reBlockingKeys = new Set(rePartition.blocking.map((f) => findingKey(f)));
            const reEffective = reResult.effectiveReviewer ?? cfg.harnesses.reviewer;
            const reSelfReview = reResult.selfReview ?? false;
            const reLabel = reSelfReview ? `${reEffective} (self-review)` : reEffective;
            const reReversalDemotions = new Map<string, ReversalMatch>();
            for (const { finding, reason, reversalMatch } of rePartition.advisory) {
              if (reason !== "reversal-unacknowledged" || !reversalMatch) continue;
              reReversalDemotions.set(findingKey(finding), reversalMatch);
              if (deps.runDir) {
                const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                await appendEvent(deps.runDir, {
                  schema_version: RUN_SCHEMA_VERSION, type: "reversal_unacknowledged", at,
                  finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
                  settled_finding_key: reversalMatch.settledKey, settling_round: reversalMatch.settledRound,
                  matched_by: reversalMatch.matchedBy,
                }, deps.runStoreDeps).catch(() => {});
              }
            }
            const reCommentBody = formatDeltaReviewComment(
              cfg,
              {
                verdict: reResult.verdict,
                summary: reResult.summary,
                findings: reResult.findings,
                next_steps: [],
                commitSha: reIsUnparseable ? undefined : newPrHead,
              },
              `pre-merge delta review by ${reLabel}`,
              reBlockingKeys.size > 0 ? reBlockingKeys : undefined,
              reNewHash,
              reReversalDemotions,
              undefined,
              undefined,
              reUnverifiedSurfaceDemotions,
            );
            const reComment = reSelfReview
              ? (() => {
                  const nl = reCommentBody.indexOf("\n");
                  return nl >= 0
                    ? `${reCommentBody.slice(0, nl)}\n\n${selfReviewBanner(cfg.harnesses.reviewer, reEffective)}${reCommentBody.slice(nl)}`
                    : `${reCommentBody}\n\n${selfReviewBanner(cfg.harnesses.reviewer, reEffective)}`;
                })()
              : reCommentBody;

            // A blocking post-auto-fix re-review verdict is subject to the same
            // supersession re-validation as the initial delta review (#481): the
            // approve branch below already re-confirms the head via its own
            // ls-remote disambiguation, but a blocking outcome previously went
            // straight to `setBlockedFn` on `newPrHead` with no currency check at
            // all. Bound to a single conservative fallback (no further retry
            // loop here) rather than blocking on a verdict the head has already
            // moved past.
            if (rePartition.blocking.length > 0 || reIsUnparseable) {
              const reCurrency = await resolveReviewedShaCurrency(cfg, prNumber, newPrHead, {
                getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
              });
              if (reCurrency.status === "superseded") {
                await postCommentFn(
                  cfg, issueNumber,
                  supersededDeltaReviewNotice(newPrHead, reCurrency.headSha),
                );
                throw new Error(
                  `post-auto-fix re-review superseded: PR head moved from ${newPrHead.slice(0, 7)} ` +
                  `to ${reCurrency.headSha.slice(0, 7)}; falling back to conservative re-review`,
                );
              }
              if (reCurrency.status === "unknown") {
                throw new Error(
                  `cannot confirm post-auto-fix reviewed SHA ${newPrHead.slice(0, 7)} is still ` +
                  `the PR head; falling back to conservative re-review`,
                );
              }
              // Re-review's verdict (still blocking) now supersedes the initial
              // delta verdict as the one that will gate `setBlockedFn` below.
              finalBlockingHead = newPrHead;
            }
            await postCommentFn(cfg, issueNumber, reComment);

            if (rePartition.blocking.length === 0 && !reIsUnparseable) {
              // Re-validate HEAD, but do not let a single stale GitHub-API
              // PR-head read veto an approving post-fix re-review (#371 review
              // 2). `newPrHead` is the authoritative post-fix head we already
              // confirmed was pushed (performPreMergeAutoFix only returns
              // "fix-committed" after `git push` succeeds); the GitHub API's
              // PR-head field can still echo the pre-fix `head`, or even echo
              // `newPrHead` itself, for a short window after a *further*
              // concurrent push lands. Neither a read matching the pre-fix
              // `head` nor one matching `newPrHead` is proof of mere staleness
              // (#371 delta review, keys 8ad8b7f0 and 9943b2af): both can mask
              // a concurrent push that landed during the re-review. Disambiguate
              // via the live remote ref (`git ls-remote`) whenever the API read
              // is consistent with either of those two known SHAs, and fail
              // closed to the SHA gate when it does not confirm the auto-fix
              // head. A read reporting some THIRD, different SHA is an
              // unambiguous signal of a newer concurrent push on its own.
              const postFixPr = await getPrDetailFn(cfg, prNumber);
              const postFixHead = postFixPr.head_sha;
              if (postFixHead !== newPrHead && postFixHead !== targetHead) {
                throw new Error(
                  `PR HEAD moved from ${newPrHead.slice(0, 7)} to ${postFixHead.slice(0, 7)} ` +
                  `during pre-merge auto-fix re-review; re-entering SHA gate`,
                );
              }
              const remoteHead = await getRemoteHeadFn(
                deltaWorktreePath, postFixPr.head_ref,
              );
              if (remoteHead !== newPrHead) {
                throw new Error(
                  `GitHub API reports head ${postFixHead.slice(0, 7)} and ls-remote reports ` +
                  `${remoteHead ? remoteHead.slice(0, 7) : "(unreadable)"} — cannot confirm ` +
                  `auto-fix head ${newPrHead.slice(0, 7)} is the current PR head; ` +
                  `re-entering SHA gate`,
                );
              }
              console.log(
                `[pipeline] #${issueNumber}: pre-merge auto-fix re-review approved; proceeding`,
              );
              return null;
            }
            // Re-review still blocks or returned unparseable output: fall through to block below.
          }
          // fixRes.status === "error": fall through to block below.
        }
        // Prior auto-fix attempt detected: fall through to block below.
      }

      // Re-validate HEAD one last time before granting blocking authority (#481
      // review 2 finding 1): the currency checks above only cover the window up
      // to their own `postCommentFn` call, not the time since spent posting that
      // comment, running an auto-fix attempt, or posting the re-review comment.
      // A push landing in any of those windows must not leave a stale verdict
      // blocking the issue — fail closed to the conservative full re-review.
      const finalCurrency = await resolveReviewedShaCurrency(cfg, prNumber, finalBlockingHead, {
        getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
      });
      if (finalCurrency.status !== "current") {
        throw new Error(
          finalCurrency.status === "superseded"
            ? `PR HEAD moved from ${finalBlockingHead.slice(0, 7)} to ` +
              `${finalCurrency.headSha.slice(0, 7)} after the blocking verdict was recorded; ` +
              `falling back to conservative re-review`
            : `cannot confirm blocking verdict head ${finalBlockingHead.slice(0, 7)} is still ` +
              `the PR head; falling back to conservative re-review`,
        );
      }

      // Non-auto-fixable category, no seam, or fix round exhausted:
      // block pre-merge without routing to review-2.
      await setBlockedFn(
        cfg,
        issueNumber,
        "Pre-merge delta review found blocking findings; fix required before merging.",
        "pre-merge",
        "needs-human",
      );
      // Post-write HEAD verify (#481 delta finding 6eadb958): a check before a
      // separate write can never be airtight — a push can land between the
      // finalCurrency read above and setBlockedFn persisting the block. GitHub
      // offers no compare-and-swap, so instead of shrinking that window make
      // losing the race SELF-HEALING: if the head moved while the block was
      // being written, clear the block and fall back to the conservative full
      // re-review rather than stranding a stale block for manual recovery.
      const postWriteCurrency = await resolveReviewedShaCurrency(cfg, prNumber, finalBlockingHead, {
        getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
      });
      if (postWriteCurrency.status === "superseded") {
        console.warn(
          `[pipeline] #${issueNumber}: PR HEAD moved to ` +
          `${postWriteCurrency.headSha.slice(0, 7)} while the blocking state was being ` +
          `persisted; clearing the stale block and falling back to conservative re-review`,
        );
        await clearBlockedFn(cfg, issueNumber);
        throw new Error(
          `blocking verdict head ${finalBlockingHead.slice(0, 7)} was superseded by ` +
          `${postWriteCurrency.headSha.slice(0, 7)} during block persistence; ` +
          `stale block cleared — falling back to conservative re-review`,
        );
      }
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

/** Notice posted when review comments exist from an allowlisted prior runner identity. */
export function preMergeRerunIdentityNotice(actor: string): string {
  return attestPipelineComment(
    "pre-merge-rerun-identity",
    `## Pipeline: Re-running review — prior runner identity differs\n\n` +
      `Review comments exist from an allowlisted prior runner (not \`${actor}\`). ` +
      `Re-running review under the current identity to establish a verified baseline ` +
      `before proceeding to pre-merge.`,
  );
}

/** Notice posted when active scoped overrides may cover cached blocking findings. */
export function preMergeRerunScopeNotice(unresolvedCount: number): string {
  return attestPipelineComment(
    "pre-merge-rerun-scope",
    `## Pipeline: Re-running review — scoped override active\n\n` +
      `Active scoped override(s) may cover the ${unresolvedCount} cached blocking ` +
      `finding(s). Re-running review with live findings to apply scoped dispositions.`,
  );
}

/** Notice posted when the pre-merge diff-hash check finds the diff unchanged (#228). */
export function diffUnchangedNotice(reviewedSha: string | null, headSha: string): string {
  const from = reviewedSha ? ` from \`${reviewedSha.slice(0, 7)}\`` : "";
  return attestPipelineComment(
    "pre-merge-diff-unchanged",
    [
      "## Pipeline: Diff unchanged since last review; verdict reused",
      "",
      `HEAD has moved${from} to \`${headSha.slice(0, 7)}\`, but the PR diff hash is identical to the one the last review evaluated.`,
      "The prior review verdict is still valid; pre-merge proceeds without a re-review.",
    ].join("\n"),
  );
}

/** Default implementation of the `getCommitDeltaDiff` seam (#228). */
async function defaultGetCommitDeltaDiff(
  cfg: PipelineConfig,
  _prNumber: number,
  baseSha: string,
  headSha: string,
  worktreePath?: string,
): Promise<string> {
  const label = `${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}`;
  const cwd = worktreePath ?? cfg.repo_dir;
  const result = await gitInWorktree(cwd, ["diff", `${baseSha}...${headSha}`], {
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
  accounting?: {
    runDir?: string;
    runStoreDeps?: RunStoreDeps;
    priorRoundsDigest?: PriorRoundDigest;
    settledFindingsVerification?: SettledFindingVerification[];
    headFiles?: HeadFileState[];
  },
): Promise<DeltaReviewResult> {
  const prompt = buildDeltaReviewPrompt({
    cfg,
    issueNumber,
    title: issueDetail.title,
    body: issueDetail.body,
    deltaDiff,
    specContext,
    priorRoundsDigest: accounting?.priorRoundsDigest,
    settledFindingsVerification: accounting?.settledFindingsVerification,
    headFiles: accounting?.headFiles,
  });
  // Not yet guarded against the effective reviewer command — invokeReviewer
  // applies resolveReviewerModelForHarness itself, per attempted harness, so a
  // same-harness fallback (#39) is guarded against the harness it actually
  // targets rather than the nominal `cfg.harnesses.reviewer` (#441 finding c0acb169).
  const rawModel = cfg.harnesses.reviewerModel ?? cfg.models.review;
  const modelWasAuto = reviewerModelSourceWasAuto(cfg, undefined);
  const invocation = await invokeReviewer(
    cfg.harnesses.reviewer,
    cfg.harnesses.implementer,
    worktreePath,
    prompt,
    {
      timeoutSec: cfg.review_timeout,
      model: rawModel,
      modelWasAuto,
      accounting: accounting?.runDir
        ? {
            runDir: accounting.runDir,
            runStoreDeps: accounting.runStoreDeps,
            issue: issueNumber,
            stage: "pre-merge",
            modelSlot: "review",
          }
        : undefined,
      // #492: opt-in prompt-delivery channel for a custom reviewer CLI.
      promptDelivery: cfg.harnesses.reviewerPromptDelivery,
    },
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
  return attestPipelineComment(
    "pre-merge-stale-review",
    [
      "## Pipeline: Re-running review",
      "",
      body,
      "",
      "The prior review verdict is discarded; review re-runs against the current commit before this item can advance.",
    ].join("\n"),
  );
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
 * Head-side postcondition (#467, design D1): before pre-merge advances, block
 * while the PR's own changed-file list still carries an `openspec/changes/<id>/`
 * path (id ≠ `archive`) not matched by a corresponding
 * `openspec/changes/archive/<id>/` path in that same file list. Computed purely
 * from `getPrDiff` → `diffFilePaths` — never the local worktree filesystem — so
 * it behaves identically on a first run, an override-resumed run, a fresh
 * process, or after the worktree has been removed. Returns `null` to continue
 * when nothing remains active.
 */
export async function enforceOpenspecActiveChangeGuard(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome | null> {
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const setBlockedFn = deps.setBlocked ?? setBlocked;

  let diff: string;
  try {
    diff = await getPrDiffFn(cfg, prNumber);
  } catch (err) {
    // Fail closed (#467): cannot prove the PR carries no active OpenSpec change,
    // so do not let a fetch failure silently pass the guard.
    const reason =
      `Pre-merge cannot verify the OpenSpec active-change guard — fetching the PR diff failed ` +
      `(${(err as Error).message}). Check gh auth/network and re-run.`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
    return { advanced: false, status: "blocked", reason };
  }
  const remaining = openspec.unarchivedChangeIdsFromPrFiles(diffFilePaths(diff));
  if (remaining.length === 0) return null;

  const reason =
    `Pre-merge cannot advance: OpenSpec change(s) still active on this PR: ${remaining.join(", ")}. ` +
    `Run \`openspec archive <id>\` for each and push before pre-merge can continue.`;
  await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
  return { advanced: false, status: "blocked", reason };
}

/**
 * When OpenSpec is active, archive the change(s) this PR branch introduced so
 * their spec deltas fold into the living `openspec/specs/`. Idempotent: once an
 * archive commit exists on the branch, subsequent polling iterations skip this
 * step entirely. Returns a `waiting` Outcome after pushing (CI must re-run), a
 * `blocked` Outcome on failure, or null when there is nothing to do (continue the gate).
 *
 * Fails closed (#467): a candidate probe that errors, or a missing worktree
 * while the PR itself still carries an `openspec/changes/<id>/` path, blocks
 * rather than returning `null` — `null` is reserved for a positively
 * established "nothing to archive". Every decision (archived / skipped /
 * blocked) is recorded as a `gate_result` run event via `deps.runDir` so a
 * silent skip is diagnosable from `events.jsonl` alone.
 */
export async function maybeArchiveOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
  pipelineRunId: string,
  deps: AdvancePreMergeDeps = {},
  stateDir?: string,
  prNumber?: number,
): Promise<Outcome | null> {
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const gitFn = deps.gitInWorktree ?? gitInWorktree;
  const isActiveFn = deps.openspecIsActive ?? openspec.isActive;
  const changeDirExistsFn = deps.changeDirExists ?? openspec.changeDirExists;
  const archiveFn = deps.openspecArchive ?? openspec.archive;
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const branchDeveloperCommitsFn =
    deps.branchDeveloperCommits ?? ((wtPath, base) => computeBranchDeveloperCommits(
      gitFn,
      wtPath,
      base,
      { skipSubjectsStartingWith: [OPENSPEC_ARCHIVE_PREFIX] },
    ));

  const recordDecision = async (result: "pass" | "fail" | "skipped", reason?: string): Promise<void> => {
    if (!deps.runDir) return;
    await appendEvent(
      deps.runDir,
      {
        schema_version: RUN_SCHEMA_VERSION,
        type: "gate_result",
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        gate: "openspec-archive",
        result,
        reason,
      },
      deps.runStoreDeps,
    ).catch(() => {});
  };

  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    // Worktree missing: fall back to the head-side PR file list (worktree-independent)
    // rather than assuming there is nothing to archive (#467). `openspec.enabled: off`
    // disables the integration outright regardless of file contents.
    const mode = cfg.openspec?.enabled ?? "auto";
    if (mode === "off" || prNumber === undefined) {
      await recordDecision("skipped", "openspec-inactive");
      return null;
    }
    let prPaths: string[];
    try {
      prPaths = diffFilePaths(await getPrDiffFn(cfg, prNumber));
    } catch (err) {
      const reason =
        `Worktree for #${issueNumber} not found on disk and the PR diff fetch failed ` +
        `(${(err as Error).message}), so it cannot be confirmed there is no active OpenSpec ` +
        `change to archive. Restore the worktree (or gh auth) and re-run.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", reason);
      return { advanced: false, status: "blocked", reason };
    }
    const remaining = openspec.unarchivedChangeIdsFromPrFiles(prPaths);
    if (remaining.length > 0) {
      const reason =
        `OpenSpec worktree for #${issueNumber} not found on disk, and the pull request still ` +
        `introduces active OpenSpec change(s): ${remaining.join(", ")}. Restore the worktree ` +
        `(or re-run planning) so the archive step can run, then re-run the pipeline.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", reason);
      return { advanced: false, status: "blocked", reason };
    }
    await recordDecision("skipped", "no-candidates");
    return null;
  }
  if (!isActiveFn(cfg, wt.path)) {
    await recordDecision("skipped", "openspec-inactive");
    return null;
  }

  // Changes this PR branch introduced, still active (not yet archived).
  const diff = await gitFn(
    wt.path,
    ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
    { ignoreFailure: true },
  );
  if (diff.code !== 0) {
    // Fail closed (#467): a failed probe must never be read as "no candidates" —
    // `ignoreFailure: true` only suppresses the throw, not the meaning of a non-zero exit.
    const detail = (diff.stderr || diff.stdout || "(no output)").trim();
    const reason =
      `Cannot determine active OpenSpec change candidates — ` +
      `\`git diff --name-only origin/${cfg.base_branch}...HEAD\` failed (exit ${diff.code}): ${detail}`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
    await recordDecision("fail", reason);
    return { advanced: false, status: "blocked", reason };
  }
  const candidates = openspec
    .changeIdsFromPaths(diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
    .filter((id) => changeDirExistsFn(wt.path, id));

  // Idempotency guard (#181, fix 2): evaluate candidates *before* consulting commit
  // history so a prior archive commit cannot mask re-introduced active change
  // directories. If no candidates remain, there is nothing to archive.
  if (candidates.length === 0) {
    await recordDecision("skipped", "no-candidates");
    return null;
  }

  // ---- Consistency guard (#106): never archive a delta the code outgrew ----
  // OpenSpec deltas are frozen at planning; fix rounds only edit code. If a
  // material fix moved the implementation but left the change's specs/** untouched
  // AND a review finding is tagged `category: spec-divergence`, archiving would
  // fold a stale delta into the living specs (silent corruption) and re-review
  // would keep re-anchoring on the wrong delta. Block and surface it instead.
  //
  // Wire the bounded repair dep (#356): when direction is `spec-behind-code` the
  // guard calls this once before blocking. Only created when the harness is
  // configured; tests inject deps.attemptBoundedRepair directly.
  let repairAttempted = false;
  const attemptRepairFn: SpecConsistencyDeps["attemptBoundedRepair"] =
    deps.attemptBoundedRepair ??
    (cfg.harnesses?.implementer
      ? async (changeId, issNo, runId) => {
          if (repairAttempted) return "already-attempted";
          repairAttempted = true;
          return performBoundedSpecRepair(
            cfg,
            changeId,
            issNo,
            runId,
            wt.path,
            gitFn,
            branchDeveloperCommitsFn,
            deps.invokeFn ?? invoke,
            deps.openspecValidateItem ?? openspec.validateItem,
          );
        }
      : undefined);
  const getHeadShaFn = async (p: string): Promise<string | null> => {
    const r = await gitFn(p, ["rev-parse", "HEAD"], { ignoreFailure: true });
    return r.stdout.trim() || null;
  };
  // Resolve the trusted review-comment author for the comment-author filter (#356 finding 1).
  // When the dep is provided (including null), use it directly so tests avoid a real network call.
  // In production (dep absent), fail closed: null from getGhActor() means auth is degraded,
  // and proceeding without the filter would allow untrusted commenters to forge review markers.
  let trustedReviewAuthor: string | null;
  if ("trustedReviewAuthor" in deps) {
    trustedReviewAuthor = deps.trustedReviewAuthor ?? null;
  } else {
    const getGhActorFn = deps.getGhActor ?? getGhActor;
    trustedReviewAuthor = await getGhActorFn();
    if (trustedReviewAuthor === null) {
      const reason =
        "cannot resolve the pipeline actor identity (gh auth may be degraded) — " +
        "trusted review-comment filtering requires a known actor; check `gh auth status`";
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", reason);
      return { advanced: false, status: "blocked", reason, blockerKind: "needs-human" };
    }
  }
  const guard = await enforceSpecConsistencyGuard(cfg, issueNumber, wt.path, candidates, {
    branchDeveloperCommits: branchDeveloperCommitsFn,
    getIssueDetail: getIssueDetailFn,
    setBlocked: setBlockedFn,
    pipelineRunId,
    attemptBoundedRepair: attemptRepairFn,
    getHeadSha: getHeadShaFn,
    trustedReviewAuthor,
  });
  if (guard) {
    await recordDecision("fail", guard.reason ?? "spec-consistency guard blocked");
    return guard;
  }

  // Pre-archive cleanliness guard: the commit-failure rollback below is destructive
  // (`git restore .` + `git clean -fd openspec/`), so it is provably lossless ONLY when
  // the worktree is fully clean before archive. Block on ANY pre-existing dirty state —
  // a path-prefix filter is unsafe two ways: a dirty tracked openspec/ file (e.g.
  // `M  openspec/specs/x.md`) would be silently discarded by the rollback, and a porcelain
  // rename/copy record (`R  openspec/a -> core/a`) has a destination outside openspec/ that
  // matching only the first path misses. All planning/fix work is committed before pre-merge,
  // so any non-empty status here is anomalous — fail safe rather than risk data loss.
  // Fail CLOSED: only proceed when `git status` SUCCEEDS and reports a clean tree. If the
  // status check itself errors (non-zero exit, often with empty stdout), we cannot prove the
  // tree is clean — treating that as clean would let the destructive rollback run over
  // unproven state, the very data-loss class this guard exists to close.
  const preArchiveStatus = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (preArchiveStatus.code !== 0 || preArchiveStatus.stdout.trim() !== "") {
    const detail =
      preArchiveStatus.code !== 0
        ? `git status --porcelain failed (exit ${preArchiveStatus.code}): ${(preArchiveStatus.stderr || preArchiveStatus.stdout || "(no output)").trim()}`
        : `pre-existing dirty paths:\n${preArchiveStatus.stdout.trim()}`;
    await setBlockedFn(
      cfg,
      issueNumber,
      `Cannot verify a clean worktree before the OpenSpec archive, so a failed archive commit's destructive rollback could discard pre-existing work — ${detail}. Commit/stash changes (or fix the git error) and re-run.`,
      "pre-merge",
      "openspec-invalid",
    );
    const blockedReason =
      preArchiveStatus.code !== 0 ? "pre-archive git status failed" : "worktree dirty before archive";
    await recordDecision("fail", blockedReason);
    return { advanced: false, status: "blocked", reason: blockedReason };
  }

  console.log(`[pipeline] #${issueNumber}: archiving OpenSpec change(s): ${candidates.join(", ")}`);
  for (const id of candidates) {
    const res = await archiveFn(wt.path, id);
    if (res.unavailable) {
      const reason = `openspec CLI unavailable — cannot archive change '${id}'. Install the openspec CLI and re-run.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
      await recordDecision("fail", `openspec CLI unavailable (${id})`);
      return { advanced: false, status: "blocked", reason: `openspec CLI unavailable (${id})` };
    }
    if (!res.success) {
      // Surface the CLI output verbatim (#467) — e.g. a "header not found" error from a
      // retitled `## MODIFIED Requirements` delta the living spec does not (yet) contain.
      const reason = `openspec archive ${id} failed:\n${res.output}`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
      await recordDecision("fail", reason);
      return { advanced: false, status: "blocked", reason };
    }
  }

  // Commit + push the archived specs so CI validates the finalized state.
  await gitFn(wt.path, ["add", "-A"], { ignoreFailure: true });
  const status = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (!status.stdout.trim()) {
    // archive produced no diff (unexpected) → continue
    await recordDecision("skipped", "no-candidates");
    return null;
  }
  const commit = await gitFn(
    wt.path,
    ["commit", "-m", withTrailers(`${OPENSPEC_ARCHIVE_PREFIX}${issueNumber}`, issueNumber, pipelineRunId)],
    { ignoreFailure: true },
  );
  if (commit.code !== 0) {
    const detail = commit.stderr.trim() || commit.stdout.trim() || "(no output)";
    // Restore the worktree to its pre-archive state so the next run can retry.
    // openspec archive removed openspec/changes/<id>/ and modified openspec/specs/;
    // without this, changeDirExists returns false on retry and candidates is empty,
    // letting pre-merge continue without the required archive commit.
    await gitFn(wt.path, ["restore", "--staged", "."], { ignoreFailure: true });
    await gitFn(wt.path, ["restore", "."], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd", "openspec/"], { ignoreFailure: true });
    await setBlockedFn(
      cfg,
      issueNumber,
      `OpenSpec archive commit failed:\n${detail}`,
      "pre-merge",
      "push-failed",
    );
    await recordDecision("fail", "archive commit failed");
    return { advanced: false, status: "blocked", reason: "archive commit failed" };
  }
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
    await recordDecision("fail", "push failed after archive");
    return { advanced: false, status: "blocked", reason: "push failed after archive" };
  }
  console.log(`[pipeline] #${issueNumber}: OpenSpec change(s) archived; CI will re-run`);
  await recordDecision("pass", candidates.join(", "));
  return { advanced: false, status: "waiting", reason: "openspec change archived; CI re-running" };
}

// ---------------------------------------------------------------------------
// No-run recovery (#281)
// ---------------------------------------------------------------------------

/**
 * Called when `getPrChecks` shows pending CI but the check-runs API reports
 * zero runs for the head SHA — GitHub Actions never fired, typically after an
 * archive-only commit that did not re-trigger the `pull_request` event.
 *
 * Decision tree:
 *  1. Already attempted recovery for this SHA → block (needs-human).
 *  2. Diff from preArchiveSha to headSha is openspec-only AND preArchiveSha had
 *     ≥1 successful check-run (prior green) → close+reopen PR to re-fire CI → waiting.
 *  3. close+reopen throws → block (needs-human).
 *  4. Non-archive diff or preArchiveSha unavailable → block (needs-human) with
 *     actionable manual close+reopen suggestion.
 */
async function handleZeroRunRecovery(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  ctx: PreMergePollingContext,
  setBlockedFn: typeof setBlocked,
  closePrFn: typeof closePr,
  reopenPrFn: typeof reopenPr,
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount,
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>,
): Promise<Outcome> {
  // One-shot-per-SHA guard: prevents repeated PR state churn on consecutive polls.
  if (ctx.noRunRecoveryAttemptedForSha === headSha) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `No CI run detected for head SHA ${headSha.slice(0, 7)}; close+reopen recovery was already attempted for this SHA. ` +
        `Investigate why GitHub Actions is not triggering and manually re-fire CI, then remove the \`blocked\` label and re-run the pipeline.`,
      "pre-merge",
      "needs-human",
    );
    return { advanced: false, status: "blocked", reason: `no CI run after recovery for ${headSha.slice(0, 7)}` };
  }

  const preArchiveSha = ctx.preArchiveSha;
  let isArchiveOnly = false;
  let priorGreen = false;

  if (preArchiveSha && preArchiveSha !== headSha) {
    try {
      const diffPaths = await getDiffFilePathsFn(cfg, preArchiveSha, headSha);
      isArchiveOnly = diffPaths.length > 0 && diffPaths.every((p) => p.startsWith("openspec/"));
      if (isArchiveOnly) {
        const successCount = await getSuccessfulCheckRunCountFn(cfg, preArchiveSha);
        priorGreen = successCount > 0;
      }
    } catch {
      // Treat as non-archive-only on error (conservative-open: no auto-recover).
    }
  }

  if (isArchiveOnly && priorGreen) {
    try {
      await closePrFn(cfg, prNumber);
      await reopenPrFn(cfg, prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setBlockedFn(
        cfg,
        issueNumber,
        `No CI run detected for head SHA ${headSha.slice(0, 7)}; close+reopen recovery failed: ${msg}`,
        "pre-merge",
        "needs-human",
      );
      return { advanced: false, status: "blocked", reason: `no CI run; close+reopen failed: ${msg}` };
    }
    ctx.noRunRecoveryAttemptedForSha = headSha;
    console.log(
      `[pipeline] #${issueNumber}: no CI run for SHA ${headSha.slice(0, 7)}; closed and reopened PR #${prNumber} to re-fire CI`,
    );
    return {
      advanced: false,
      status: "waiting",
      reason: "no CI run detected; closed and reopened PR to re-fire CI",
    };
  }

  // Non-archive diff or pre-archive SHA unavailable or prior SHA had no runs.
  await setBlockedFn(
    cfg,
    issueNumber,
    `No CI run detected for head SHA ${headSha.slice(0, 7)}; try closing and reopening the PR to re-fire GitHub Actions.`,
    "pre-merge",
    "needs-human",
  );
  return { advanced: false, status: "blocked", reason: `no CI run detected for head SHA ${headSha.slice(0, 7)}` };
}

/** Default implementation of the `getDiffFilePaths` seam. */
async function defaultGetDiffFilePaths(
  cfg: PipelineConfig,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const result = await gitInWorktree(
    cfg.repo_dir,
    ["diff", "--name-only", `${baseSha}...${headSha}`],
    { ignoreFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(`git diff --name-only ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
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
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
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
  const wt = await getOnDiskForIssue(cfg, issueNumber);
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
 *
 * `deps` is optional and forwarded to every `advance` call; injectable seams
 * (nowMs, sleepMs, getHeadCheckRunCount, …) enable unit-testing the polling
 * loop without real network calls or wall-clock waits.
 */
export async function advancePolling(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome> {
  const nowMsFn = deps.nowMs ?? (() => Date.now());
  const sleepMsFn = deps.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = nowMsFn() + cfg.ci_timeout * 1000;
  let last: Outcome | null = null;
  // Allocate a shared polling context so grace-window timing and no-run recovery
  // state persist across advance() iterations (#281). Reuses an existing context
  // when one was passed in opts (e.g. from a resumed polling session).
  const pollingCtx: PreMergePollingContext = opts.pollingCtx ?? {};
  while (nowMsFn() < deadline) {
    last = await advance(cfg, issueNumber, { ...opts, pollingCtx }, deps);
    if (last.advanced) return last;
    if (!last.advanced && last.status !== "waiting") return last;
    // waiting → sleep and try again
    await sleepMsFn(cfg.ci_poll_interval * 1000);
  }
  return last ?? { advanced: false, status: "waiting", reason: "timed out polling pre-merge" };
}
