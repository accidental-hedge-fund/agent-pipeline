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
  closePr,
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
  postComment,
  reopenPr,
  setBlocked,
  transition,
} from "../gh.ts";
import { branchName, getForIssue, getOnDiskForIssue, gitInWorktree } from "../worktree.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
import {
  computeDiffHash,
  DELTA_REVIEW_MARKER_PREFIX,
  diffFilePaths,
  extractBlockingKeysFromComment,
  extractBlockingKeysMarker,
  extractDiffHashFromComment,
  extractReviewArtifact,
  findLatestReviewCommentBody,
  formatDeltaReviewComment,
  extractReviewedSha,
  parseStructuredVerdict,
} from "./review.ts";
import {
  buildTrustedOverrideComments,
  extractOverrides,
  extractScopedOverrides,
  findingKey,
  partitionFindings,
} from "../review-policy.ts";
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
import { buildDeltaReviewPrompt } from "../prompts/index.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import * as openspec from "../openspec.ts";
import {
  computeBranchDeveloperCommits,
  enforceSpecConsistencyGuard,
} from "../openspec-consistency.ts";
export {
  enforceSpecConsistencyGuard,
  specDeltaIsStale,
  type FixCommit,
  type SpecConsistencyDeps,
} from "../openspec-consistency.ts";
import type { ReviewFinding } from "../types.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";
import { readEvents } from "../run-store.ts";
import type { RunStoreDeps, StageAccountingEvent } from "../run-store.ts";

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
  const shaGate = await enforceReviewShaGate(
    cfg,
    issueNumber,
    prNumber,
    { ...deps, runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
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
  if ((cfg.ci_mode ?? "github") === "local") {
    // Local mode (#350): verify CI using the current run's recorded test-gate outcome
    // instead of polling GitHub Actions check-runs. The conflict pre-check, mergeability
    // gate, and OpenSpec-validation gate are unaffected and still run below.
    const readRunEventsFn = deps.readRunEvents ?? readEvents;
    const tgResult = await latestTestGateOutcome(opts.runDir, readRunEventsFn);

    if (tgResult === null) {
      // Fail-closed: no test-gate result for this run → block rather than skip verification.
      await setBlockedFn(
        cfg,
        issueNumber,
        "ci_mode: local is set but no local test-gate result was found for this run. " +
          "The test gate must have completed before the pre-merge gate can proceed. " +
          "Ensure the test gate ran (check that test_gate.enabled is true and a command is " +
          "detected or configured), or switch to ci_mode: github to wait for GitHub Actions.",
        "pre-merge",
        "needs-human",
      );
      return {
        advanced: false,
        status: "blocked",
        reason: "ci_mode: local — no test-gate result for this run",
      };
    }

    if (tgResult.outcome !== "success") {
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
    }

    // SHA guard: compare the current PR head to the worktree HEAD SHA recorded
    // in the test-gate accounting event. This is the exact commit that was tested,
    // regardless of when pre-merge runs or what pollingCtx captured. If the recorded
    // SHA is absent (old event without pr_head_sha), or the PR head has moved past
    // the tested commit (developer push, archive commit, rebase), block rather than
    // certify an untested commit. (#350 review-2 fix)
    if (!tgResult.prHeadSha || prDetail.head_sha !== tgResult.prHeadSha) {
      const testedAt = tgResult.prHeadSha ? tgResult.prHeadSha.slice(0, 7) : "unknown";
      await setBlockedFn(
        cfg,
        issueNumber,
        "ci_mode: local — the PR head changed after the local test gate ran " +
          `(test gate at ${testedAt}, ` +
          `current head ${prDetail.head_sha.slice(0, 7)}). ` +
          "Re-run the pipeline to run the local test gate against the current head.",
        "pre-merge",
        "needs-human",
      );
      return {
        advanced: false,
        status: "blocked",
        reason: "ci_mode: local — PR head moved after test gate ran",
      };
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
  accounting?: { runDir: string; runStoreDeps?: RunStoreDeps },
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
  runDir?: string;
  runStoreDeps?: RunStoreDeps;
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
          await postCommentFn(
            cfg,
            issueNumber,
            `## Pipeline: Re-running review — prior runner identity differs\n\n` +
              `Review comments exist from an allowlisted prior runner (not \`${actor}\`). ` +
              `Re-running review under the current identity to establish a verified baseline ` +
              `before proceeding to pre-merge.`,
          );
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
        deps.runDir ? { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps } : undefined,
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
      // Trust overrides from any authorized runner identity (#229 Findings 1, 4, 5).
      const overrides = extractOverrides(trustedOverrideComments);
      const scopes = extractScopedOverrides(trustedOverrideComments);
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
  accounting?: { runDir: string; runStoreDeps?: RunStoreDeps },
): Promise<DeltaReviewResult> {
  const prompt = buildDeltaReviewPrompt({
    cfg,
    issueNumber,
    title: issueDetail.title,
    body: issueDetail.body,
    deltaDiff,
    specContext,
  });
  const model = cfg.models.review;
  const invocation = await invokeReviewer(
    cfg.harnesses.reviewer,
    cfg.harnesses.implementer,
    worktreePath,
    prompt,
    {
      timeoutSec: cfg.review_timeout,
      model,
      accounting: accounting
        ? {
            runDir: accounting.runDir,
            runStoreDeps: accounting.runStoreDeps,
            issue: issueNumber,
            stage: "pre-merge",
            modelSlot: "review",
            model,
          }
        : undefined,
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
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const gitFn = deps.gitInWorktree ?? gitInWorktree;
  const isActiveFn = deps.openspecIsActive ?? openspec.isActive;
  const changeDirExistsFn = deps.changeDirExists ?? openspec.changeDirExists;
  const archiveFn = deps.openspecArchive ?? openspec.archive;
  const branchDeveloperCommitsFn =
    deps.branchDeveloperCommits ?? ((wtPath, base) => computeBranchDeveloperCommits(
      gitFn,
      wtPath,
      base,
      { skipSubjectsStartingWith: [OPENSPEC_ARCHIVE_PREFIX] },
    ));

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
    return {
      advanced: false,
      status: "blocked",
      reason: preArchiveStatus.code !== 0 ? "pre-archive git status failed" : "worktree dirty before archive",
    };
  }

  console.log(`[pipeline] #${issueNumber}: archiving OpenSpec change(s): ${candidates.join(", ")}`);
  for (const id of candidates) {
    const res = await archiveFn(wt.path, id);
    if (res.unavailable) {
      await setBlockedFn(
        cfg,
        issueNumber,
        `openspec CLI unavailable — cannot archive change '${id}'. Install the openspec CLI and re-run.`,
        "pre-merge",
        "openspec-invalid",
      );
      return { advanced: false, status: "blocked", reason: `openspec CLI unavailable (${id})` };
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
    return { advanced: false, status: "blocked", reason: "push failed after archive" };
  }
  console.log(`[pipeline] #${issueNumber}: OpenSpec change(s) archived; CI will re-run`);
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
