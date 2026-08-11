// Pre-merge orchestration / routing (#628).
// Owns advance, advancePolling, AdvancePreMergeOpts/Deps, PreMergePollingContext,
// and composition of domain gates.

import {
  closePr,
  getHeadCheckRunCount,
  getSuccessfulCheckRunCount,
  getPrChecks,
  getPrDetail,
  getPrForIssue,
  parseChecksAggregate,
  reopenPr,
  setBlocked,
  transition,
  rerunFailedWorkflows,
  fetchCheckLogExcerpt,
  type RerunFailedWorkflowsResult,
} from "../gh.ts";
import {
  classifyCiFailure,
  type CiFailureClass,
} from "../ci-failure-classify.ts";
import {
  ensureManagedWorktree,
  getForIssue,
  getOnDiskForIssue,
  gitInWorktree,
  type EnsureManagedWorktreeDeps,
  type EnsureManagedWorktreeResult,
} from "../worktree.ts";
import {
  trySalvageUncommittedWork,
} from "../salvage-harness-work.ts";
import { makePipelineRunId } from "../traceability.ts";
import * as openspec from "../openspec.ts";
import {
  computeBranchDeveloperCommits,
  performBoundedSpecRepair,
  type InvokeFn,
  type SpecConsistencyDeps,
  type ValidateFn,
  type FixCommit,
} from "../openspec-consistency.ts";
import { invoke } from "../harness.ts";
import {
  isPipelineInternalCommit,
  OPENSPEC_ARCHIVE_PREFIX,
} from "../pipeline-commits.ts";
import type { CheckRun, Outcome, PipelineConfig, Stage } from "../types.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import { readEvents } from "../run-store.ts";
import type { RunStoreDeps, StageAccountingEvent } from "../run-store.ts";
import { runTestGate } from "../testgate.ts";
import { getIssueDetail, getPrCommits, getPrDiff, listPrHeadChangeDirs, getGhActor, postComment, clearBlocked, createIssue, addIssueComment } from "../gh.ts";
import { preMergeBlocked, recordPreMergeGateResult } from "./pre-merge-shared.ts";
import {
  enforceReviewShaGate,
  type ShaGateDeps,
} from "./pre-merge-sha-gate.ts";
import { enforceOpenspecActiveChangeGuard, maybeArchiveOpenspec } from "./pre-merge-openspec-archive.ts";
import {
  ciRecoveryShaSetAdd,
  ciRecoveryShaSetHas,
  defaultGetDiffFilePaths,
  handleDefinitiveCiFailure,
  handleZeroRunRecovery,
  hydrateCiRecoveryMarkers,
  persistCtxCiMarkers,
} from "./pre-merge-ci-gate.ts";
import {
  markRebaseAttempted,
  rebaseAlreadyAttempted,
  recoverFromMergeConflict,
  resolveRebasePushResult,
  tryRebaseAndPush,
} from "./pre-merge-conflict-rebase.ts";
import {
  performPreMergeAutoFix,
  PRE_MERGE_AUTOFIX_PREFIX,
  type AttemptPreMergeAutoFixFn,
} from "./pre-merge-autofix.ts";

/**
 * Mutable context shared across `advancePolling` iterations. `advancePolling`
 * allocates one per polling session and passes it to every `advance()` call so
 * the CI-gate grace window and the no-run recovery guard persist across polls
 * (fixing the reset-on-every-poll bug — #281 review 2).
 *
 * CI recovery attempt authority (#679 / #759) is the stage-attempt ledger
 * (`runDir/stage-attempt-ledger.json`); SHA-set fields below are a process-local
 * cache projected from the ledger so a process restart does not re-consume budget.
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
  /**
   * PR head SHA for which the **head-bound** pre-CI entry-gate stack
   * (review-SHA gate, OpenSpec archive, active-change guard) already produced a
   * clean proceed into the CI step (#816). Session-scoped only; any head
   * movement invalidates by SHA mismatch. Early-conflict is never memoized.
   */
  entryGatesPassedForSha?: string;
  /**
   * Session-scoped open PR number for this polling session (#816). Reused only
   * while a per-tick `getPrDetail` shows the PR is still open; closed / merged /
   * missing detail clears this and `entryGatesPassedForSha`, then re-resolves
   * via `getPrForIssue`.
   */
  prNumber?: number;
  /**
   * True after a `gate_result` with `gate: "ci"` / `result: "partial"` was
   * written for the current CI waiting stretch (#682). Prevents per-poll
   * waiting spam on the advance event stream (and therefore on the loop
   * progress mirror).
   */
  ciWaitingGateRecorded?: boolean;
  /**
   * Head SHAs for which the definitive-CI-failure one-shot rebase was already
   * attempted (#771). Durable via stage-attempt ledger (SHA-set cache) so
   * H1→H2→H1 cannot re-open a consumed budget for H1 after worktree recreate.
   */
  ciRebaseAttemptedShas?: string[];
  /** Head SHAs for which an automatic failed-workflow re-run was already attempted (#679). */
  ciRerunAttemptedShas?: string[];
  /** Head SHAs for which archive-only failed-run close+reopen recovery was attempted (#679). */
  ciArchiveFailRecoveryAttemptedShas?: string[];
  /** Head SHAs for which optional CI assertion auto-fix was attempted (#679). */
  ciAssertionFixAttemptedShas?: string[];
  /**
   * Head SHAs for which a terminal `gate_result` `ci`/`fail` was already recorded
   * after recovery budget exhaustion (#771). Pure re-polls must not spam another fail.
   */
  ciTerminalFailRecordedShas?: string[];
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
  /**
   * Optional head-SHA rebase-attempt probe for tests (#759). Production uses
   * the stage-attempt ledger when runDir is available.
   */
  rebaseAttemptedForHead?: (headSha: string) => boolean;
  /** Injectable stage-attempt ledger I/O (#759). */
  stageAttemptLedgerDeps?: import("../stage-attempt-ledger.ts").StageAttemptLedgerDeps;
  // Seams for the OpenSpec archive step + its consistency guard (#106), so
  // maybeArchiveOpenspec is testable without a real worktree, git, openspec
  // CLI, or GitHub.
  gitInWorktree?: typeof gitInWorktree;
  openspecIsActive?: typeof openspec.isActive;
  changeDirExists?: typeof openspec.changeDirExists;
  /** Tip-tree listing of active change dirs (`openspec/changes/<id>/`, excl. archive). */
  listChangeDirs?: typeof openspec.listChangeDirs;
  /**
   * Tip-tree listing of active OpenSpec change ids on the reviewed PR head when
   * no on-disk worktree is available (#714 review 2). Production default uses the
   * GitHub Contents API at the PR head SHA. Must not use cumulative PR path
   * subtraction (archive-then-reintroduce masking).
   */
  listPrHeadChangeDirs?: typeof listPrHeadChangeDirs;
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
   * Injectable salvage-uncommitted-work seam for the pre-merge bounded
   * auto-fix path (#547). Defaults to `trySalvageUncommittedWork` from
   * salvage-harness-work.ts. Tests inject a fake to exercise the salvage
   * fallback without a real git subprocess.
   */
  trySalvageUncommittedWork?: typeof trySalvageUncommittedWork;
  /**
   * Rematerialize a missing managed worktree before archive / autofix (#769).
   * Production default: {@link ensureManagedWorktree}. Tests inject fakes.
   */
  ensureManagedWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    ensureDeps?: EnsureManagedWorktreeDeps,
  ) => Promise<EnsureManagedWorktreeResult>;
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
  /**
   * Re-run failed workflow jobs for definitive CI failures (#679).
   * Defaults to `rerunFailedWorkflows` from gh.ts. Tests inject fakes.
   */
  rerunFailedWorkflows?: (
    cfg: PipelineConfig,
    failedChecks: CheckRun[],
  ) => Promise<RerunFailedWorkflowsResult>;
  /**
   * Fetch a bounded log excerpt for a failed check (#679).
   * Defaults to `fetchCheckLogExcerpt` from gh.ts. Tests inject fakes.
   */
  fetchCheckLogExcerpt?: (
    cfg: PipelineConfig,
    check: CheckRun,
  ) => Promise<string | null>;
  /**
   * Optional one-shot surgical fix for assertion-classified CI failures (#679).
   * Only invoked when `cfg.pre_merge_ci_assertion_fix` is true. Production
   * default reports not-implemented (config defaults false). Tests inject fakes.
   */
  runCiAssertionFix?: (
    cfg: PipelineConfig,
    issueNumber: number,
    ctx: {
      prNumber: number;
      headSha: string;
      failedChecks: CheckRun[];
      classification: CiFailureClass;
      logExcerpt: string | null;
    },
  ) => Promise<{ ok: boolean; reason?: string }>;
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

/**
 * Early-conflict predicate for pre-merge (#95 / #816).
 * Byte-stable: only CONFLICTING (`mergeable === false`) or uppercased
 * `mergeable_state === "DIRTY"` divert to conflict recovery before CI.
 * UNKNOWN/null mergeable and BEHIND/BLOCKED without DIRTY fall through.
 */
export function isEarlyConflictPrDetail(prDetail: {
  mergeable: boolean | null;
  mergeable_state?: string | null;
}): boolean {
  return (
    prDetail.mergeable === false ||
    (prDetail.mergeable_state ?? "").toUpperCase() === "DIRTY"
  );
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
  const rerunFailedWorkflowsFn = deps.rerunFailedWorkflows ?? rerunFailedWorkflows;
  const fetchCheckLogExcerptFn = deps.fetchCheckLogExcerpt ?? fetchCheckLogExcerpt;
  const runCiAssertionFixFn = deps.runCiAssertionFix;

  console.log(`[pipeline] #${issueNumber}: pre-merge gate`);

  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);
  const pollingCtx = opts.pollingCtx;

  // ---- PR identity (#816): session-cached open PR number with open validity ----
  const clearPrIdentityCache = (): void => {
    if (!pollingCtx) return;
    delete pollingCtx.prNumber;
    delete pollingCtx.entryGatesPassedForSha;
  };

  // Single setBlocked call site for the no-PR path (escalation inventory #760).
  const blockNoPr = async (): Promise<Outcome> => {
    await setBlockedFn(cfg, issueNumber, "No pull request found for pre-merge gate.", "pre-merge", "needs-human");
    return preMergeBlocked("no PR", "needs-human");
  };

  let prNumber: number | null =
    pollingCtx && typeof pollingCtx.prNumber === "number" && pollingCtx.prNumber > 0
      ? pollingCtx.prNumber
      : null;
  if (prNumber === null) {
    prNumber = await getPrForIssueFn(cfg, issueNumber);
    if (prNumber && pollingCtx) pollingCtx.prNumber = prNumber;
  }
  if (!prNumber) {
    return blockNoPr();
  }

  if (opts.dryRun) {
    // Always route through visual-gate (#395); a disabled visual-gate skips
    // itself forward to the first enabled later gate — see stages/visual.ts.
    console.log(`[pipeline] #${issueNumber}: [dry-run] would archive+CI+merge for PR #${prNumber}`);
    return { advanced: true, from: "pre-merge", to: "visual-gate", summary: "[dry-run]" };
  }

  // ---- Hoist PR detail early (#816): head SHA + mergeability + open validity ----
  const fetchOpenPrDetail = async (
    candidate: number,
  ): Promise<{ prNumber: number; prDetail: Awaited<ReturnType<typeof getPrDetailFn>> } | null> => {
    let detail: Awaited<ReturnType<typeof getPrDetailFn>> | null = null;
    try {
      detail = await getPrDetailFn(cfg, candidate);
    } catch {
      detail = null;
    }
    // Missing state (partial test fakes) is treated as open; production always sets state.
    const state = detail?.state ?? "open";
    if (detail && state === "open") {
      return { prNumber: candidate, prDetail: detail };
    }
    // Closed / merged / missing: clear session identity and re-resolve.
    clearPrIdentityCache();
    const resolved = await getPrForIssueFn(cfg, issueNumber);
    if (!resolved) return null;
    if (pollingCtx) pollingCtx.prNumber = resolved;
    try {
      const reDetail = await getPrDetailFn(cfg, resolved);
      const reState = reDetail.state ?? "open";
      if (reState !== "open") {
        clearPrIdentityCache();
        return null;
      }
      return { prNumber: resolved, prDetail: reDetail };
    } catch {
      clearPrIdentityCache();
      return null;
    }
  };

  const openPr = await fetchOpenPrDetail(prNumber);
  if (!openPr) {
    return blockNoPr();
  }
  prNumber = openPr.prNumber;
  let prDetail = openPr.prDetail;

  // CI recovery markers: hydrate every tick so durable ledger projects into ctx
  // before Step 1; preArchive capture remains once-per-session (below, full stack).
  if (pollingCtx) {
    hydrateCiRecoveryMarkers(pollingCtx, opts.runDir);
  }

  // ---- Head-bound entry gates (#816): once per head SHA per polling session ----
  // Memo hit skips only review-SHA gate, OpenSpec archive, and active-change guard.
  // Early-conflict and Step 1 CI always run (base can move without head change).
  const entryGatesMemoHit =
    !!pollingCtx &&
    typeof pollingCtx.entryGatesPassedForSha === "string" &&
    pollingCtx.entryGatesPassedForSha.length > 0 &&
    pollingCtx.entryGatesPassedForSha === prDetail.head_sha;

  if (!entryGatesMemoHit) {
    // ---- Review-SHA gate (#16): runs before any pre-merge work ----
    // pre-merge is the only stage that acts on a prior review verdict without
    // re-running review, so it is where a stale approval would slip through. If
    // HEAD has moved past the reviewed commit via a developer/fix commit, bounce
    // back to the review round before doing any pre-merge work; pipeline-internal
    // commits (openspec archive) do not invalidate the verdict.

    // Wire the bounded pre-merge auto-fix dep (#359): when the implementer harness
    // is configured and no seam is injected by the caller, build a production closure
    // that invokes `performPreMergeAutoFix` (fix + amend + push) for the gate to call.
    // Missing managed worktree rematerializes first (#769) so residual re-entry and
    // normal delta autofix share one factory path (no bare empty `{status:"error"}`).
    const gitFnForAutoFix = deps.gitInWorktree ?? gitInWorktree;
    const invokeFnForAutoFix = deps.invokeFn ?? invoke;
    const getForIssueForAutoFix = deps.getForIssue ?? getOnDiskForIssue;
    const salvageFnForAutoFix = deps.trySalvageUncommittedWork ?? trySalvageUncommittedWork;
    const ensureWtForAutoFix = deps.ensureManagedWorktree ?? ensureManagedWorktree;
    const preAutoFixFn: ShaGateDeps["attemptPreMergeAutoFix"] =
      deps.attemptPreMergeAutoFix ??
      (cfg.harnesses?.implementer
        ? async (blockingFindings, issueTitle, findingsText, claimAttempt) => {
            let wt = await getForIssueForAutoFix(cfg, issueNumber);
            if (!wt) {
              const remat = await ensureWtForAutoFix(cfg, issueNumber, {
                getOnDiskForIssue: getForIssueForAutoFix,
                getIssueTitle: async () => issueTitle,
                runDir: opts.runDir,
                runStoreDeps: opts.runStoreDeps,
              });
              if (remat.result === "fail") {
                return {
                  status: "rematerialize-failed",
                  blockerKind: remat.blockerKind,
                  diagnostic:
                    `worktree rematerialize failed (${remat.blockerKind}): ${remat.reason}`,
                };
              }
              wt = { path: remat.worktree.path, slug: remat.worktree.slug };
            }
            // `claimAttempt` charges the durable one-attempt marker inside
            // performPreMergeAutoFix only after the clean-tree preflight, so a
            // preflight failure here or below never consumes the attempt (#787).
            return performPreMergeAutoFix(
              cfg,
              issueNumber,
              pipelineRunId,
              findingsText,
              issueTitle,
              wt,
              gitFnForAutoFix,
              invokeFnForAutoFix,
              salvageFnForAutoFix,
              {},
              claimAttempt,
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

    // ---- Capture pre-archive SHA for the no-run / archive-only recovery path (#281, #679) ----
    // Capture runs once per session when still unset: the developer's last commit
    // before maybeArchiveOpenspec may push an archive commit that moves HEAD.
    // Prefer the already-hoisted open prDetail head when available (#816).
    if (pollingCtx && !pollingCtx.preArchiveSha) {
      pollingCtx.preArchiveSha = prDetail.head_sha;
      // Best-effort: flush baseline early so later recovery markers include it.
      // Budget-consuming side-effects still require a successful persist of their
      // own markers via persistCtxCiMarkers before returning waiting.
      persistCtxCiMarkers(pollingCtx, opts.runDir);
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

    // Re-fetch after the stack: archive (or other steps) may have moved HEAD.
    // Memo and early-conflict must use the post-stack head that enters CI (#816).
    try {
      prDetail = await getPrDetailFn(cfg, prNumber);
    } catch {
      // Detail fetch failed post-stack; keep pre-stack detail for early-conflict/CI.
    }
  }

  // ---- Step 0.5: early conflict detection (#95) — every tick, including memo hits ----
  // GitHub cannot build the pull_request merge ref for a CONFLICTING PR, so
  // no pull_request-triggered check runs are ever created — polling for
  // checks would wait out ci_timeout for runs that cannot appear. Base branch
  // movement can make a PR DIRTY without changing head_sha, so this must not
  // be skipped under the entry-gate proceed memo (#816).
  // Narrow predicate: only CONFLICTING (mergeable === false) or an explicit DIRTY
  // merge state bypasses the CI poll. BEHIND/BLOCKED map to "conflict" in the
  // broader parseMergeable() but represent out-of-date branch or branch protection —
  // not a real merge conflict — so they must fall through to the CI poll.
  if (isEarlyConflictPrDetail(prDetail)) {
    console.log(`[pipeline] #${issueNumber}: PR #${prNumber} is conflicting; skipping CI poll`);
    return recoverFromMergeConflict(cfg, issueNumber, opts.stateDir, deps, prNumber, opts.runDir);
  }

  // Clean proceed into Step 1: record head-bound entry-gate memo for this head (#816).
  // Only set on proceed; non-null gate returns above never reach here.
  if (pollingCtx) {
    pollingCtx.entryGatesPassedForSha = prDetail.head_sha;
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
        // Operational precondition (no worktree) — not a CI/local gate failure.
        // Residual `other` (needs-human, no ci-failed path tag) so scoreboard
        // does not inflate the ci-failed rate (#683 review 2).
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — no worktree found for this issue; cannot run the local test gate " +
            "from pre-merge. Ensure the pipeline created a worktree, or switch to ci_mode: github.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked("ci_mode: local — no worktree for inline gate", "needs-human");
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
        // Fail-closed operational/config precondition (gate disabled / no command) —
        // not an actual CI or local test failure. Residual `other` (#683 review 2).
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline local test gate was skipped (test_gate is disabled or no " +
            "test command was detected). ci_mode: local requires a verified local exit-0 result. " +
            "Enable test_gate with a test command, or switch to ci_mode: github.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked(
          "ci_mode: local — inline test gate skipped (fail-closed)",
          "needs-human",
        );
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
        return preMergeBlocked("ci_mode: local — inline test gate failed", "needs-human", "ci-failed");
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
        return preMergeBlocked(
          "ci_mode: local — inline gate created fix commits; push required",
          "needs-human",
          "ci-failed",
        );
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
        return preMergeBlocked(
          "ci_mode: local — worktree ahead of PR head; push required",
          "needs-human",
          "ci-failed",
        );
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
      return preMergeBlocked("ci_mode: local — local test gate failed", "needs-human", "ci-failed");
    } else {
      localTestedSha = tgResult.prHeadSha!;
    }

    console.log(
      `[pipeline] #${issueNumber}: ci_mode: local — local test gate passed; skipping GitHub Actions wait`,
    );
    // Observability (#682): local green is a definitive CI pass for the mirror.
    await recordPreMergeGateResult(
      { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
      "ci",
      "pass",
      "ci_mode: local",
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
      // Defense in depth for older getPrChecks / injected fakes: gh's empty
      // result is a non-zero exit with "no checks reported", not a waitable
      // transport error. Same normalization as getPrChecks / merge (#95, #882).
      if ((e.message ?? "").toLowerCase().includes("no checks reported")) {
        checks = [];
      } else {
        return { advanced: false, status: "waiting", reason: `gh pr checks failed: ${e.message}` };
      }
    }

    // Empty rollup is not immediately "green CI" (#882 pre-merge review).
    // `gh pr checks` reports "no checks reported" / [] both for repos with no
    // CI and for the normal lag before an asynchronously queued workflow
    // creates its first check-run. Wait through the same bounded start window
    // as no-run recovery (`ci_no_run_grace_s`, default 60s). After the window,
    // an still-empty rollup remains passable for true no-CI repos (#95).
    // Without a polling session there is no durable timer — fail closed by
    // waiting unless grace is explicitly 0.
    if (checks.length === 0) {
      const graceMs = (cfg.ci_no_run_grace_s ?? 60) * 1000;
      const emptyCtx = opts.pollingCtx;
      let emptyReady = graceMs <= 0;
      if (!emptyReady && emptyCtx) {
        if (emptyCtx.ciGateEnteredAt === undefined) emptyCtx.ciGateEnteredAt = nowMsFn();
        emptyReady = nowMsFn() - emptyCtx.ciGateEnteredAt >= graceMs;
      }
      if (!emptyReady) {
        if (!emptyCtx?.ciWaitingGateRecorded) {
          if (emptyCtx) emptyCtx.ciWaitingGateRecorded = true;
          await recordPreMergeGateResult(
            { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
            "ci",
            "partial",
            "waiting for CI checks to appear",
          );
        }
        return {
          advanced: false,
          status: "waiting",
          reason: "waiting for CI checks to appear",
        };
      }
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
      // Observability (#682): at most one ci/waiting gate_result per continuous
      // wait stretch so loop mirrors are not spammed by CI poll ticks.
      if (!ctx?.ciWaitingGateRecorded) {
        if (ctx) ctx.ciWaitingGateRecorded = true;
        await recordPreMergeGateResult(
          { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
          "ci",
          "partial",
          "CI still running",
        );
      }
      return { advanced: false, status: "waiting", reason: "CI still running" };
    }

    if (agg.failed.length > 0) {
      // Re-read PR head after the check poll and before definitive-failure
      // recovery. A concurrent developer push while getPrChecks was in flight
      // must not bind recovery budget / force-push rebase to the pre-poll SHA
      // (#771 review: stale head after polling).
      const polledHeadSha = prDetail.head_sha;
      let settledHeadSha: string;
      try {
        settledHeadSha = (await getPrDetailFn(cfg, prNumber)).head_sha;
      } catch (err) {
        const e = err as Error;
        return {
          advanced: false,
          status: "waiting",
          reason: `PR head re-read failed after checks: ${e.message}`,
        };
      }
      if (settledHeadSha !== polledHeadSha) {
        console.log(
          `[pipeline] #${issueNumber}: PR head advanced during CI poll ` +
            `(${polledHeadSha.slice(0, 7)} → ${settledHeadSha.slice(0, 7)}); re-evaluating without recovery`,
        );
        return {
          advanced: false,
          status: "waiting",
          reason: "PR head advanced; waiting for checks",
        };
      }

      // Full CheckRun objects (with link/description) for classification + URLs.
      const failedChecks = checks.filter((c) => {
        const b = (c.bucket ?? "").toLowerCase();
        return b === "fail" || b === "cancel";
      });
      const recoveryOut = await handleDefinitiveCiFailure(cfg, issueNumber, prNumber, settledHeadSha, failedChecks, opts, {
        getForIssueFn,
        getPrDetailFn,
        setBlockedFn,
        tryRebaseAndPushFn,
        markRebaseAttemptedFn,
        getSuccessfulCheckRunCountFn,
        getDiffFilePathsFn,
        closePrFn,
        reopenPrFn,
        rerunFailedWorkflowsFn,
        fetchCheckLogExcerptFn,
        runCiAssertionFixFn,
        stateDir: opts.stateDir,
      });
      // Observability for the loop progress mirror (#682 / #771).
      // Terminal ci/fail is idempotent per failed head SHA. Partial spam from
      // false `rebased; CI re-running` is prevented by the ladder itself: pure
      // re-polls of an unchanged red head escalate rather than re-wait.
      // Effective recovery context: hydrate from runDir even when the caller
      // omits pollingCtx so `{ runDir }`-only restarts stay idempotent (#771 r2).
      // Durable claim of the per-head terminal slot happens BEFORE the event
      // append so a crash/persist failure cannot re-append the same fail row
      // on restart (#771 r2 adversarial: failure-atomic terminal recording).
      if (recoveryOut.status === "blocked") {
        const failHead = settledHeadSha;
        const recoveryCtx: PreMergePollingContext = opts.pollingCtx ?? {};
        const hydrate = hydrateCiRecoveryMarkers(recoveryCtx, opts.runDir);
        if (!hydrate.ok) {
          console.log(
            `[pipeline] #${issueNumber}: skipping terminal ci/fail event — ${hydrate.reason}`,
          );
        } else {
          const alreadyTerminal = ciRecoveryShaSetHas(
            recoveryCtx.ciTerminalFailRecordedShas,
            failHead,
          );
          if (!alreadyTerminal) {
            const prevTerminal = recoveryCtx.ciTerminalFailRecordedShas;
            recoveryCtx.ciTerminalFailRecordedShas = ciRecoveryShaSetAdd(
              recoveryCtx.ciTerminalFailRecordedShas,
              failHead,
            );
            const claim = persistCtxCiMarkers(recoveryCtx, opts.runDir);
            if (!claim.ok) {
              recoveryCtx.ciTerminalFailRecordedShas = prevTerminal;
              console.log(
                `[pipeline] #${issueNumber}: skipping terminal ci/fail event — durable claim failed: ${claim.reason}`,
              );
            } else {
              await recordPreMergeGateResult(
                { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
                "ci",
                "fail",
                recoveryOut.reason ?? "CI failed",
              );
            }
          }
        }
        if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = false;
      } else if (recoveryOut.status === "waiting") {
        // Recovery side-effect just occurred → start a new wait stretch (allow
        // one partial after prior "CI still running" stretch).
        if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = false;
        await recordPreMergeGateResult(
          { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
          "ci",
          "partial",
          recoveryOut.reason ?? "CI recovery in progress",
        );
        if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = true;
      }
      return recoveryOut;
    }

    // Definitive green CI (github mode) — observability for the loop mirror (#682).
    await recordPreMergeGateResult(
      { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
      "ci",
      "pass",
    );
    if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = false;
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
    return preMergeBlocked(
      "ci_mode: local — PR head moved after SHA re-check",
      "needs-human",
      "ci-failed",
    );
  }
  const freshState = (freshPrDetail.mergeable_state ?? "").toUpperCase();
  const isFreshConflict = freshPrDetail.mergeable === false || freshState === "DIRTY";
  if (isFreshConflict) {
    return recoverFromMergeConflict(cfg, issueNumber, opts.stateDir, deps, prNumber, opts.runDir);
  }
  if (freshState === "BEHIND") {
    // BEHIND means the branch is out-of-date but has no code conflict.
    // Attempt one auto-rebase (same marker guard as the CONFLICTING path).
    // A second poll with the marker set blocks with a behind-specific reason,
    // not a conflict reason. BLOCKED (branch protection) is not updatable
    // by a rebase and stays as passive waiting.
    // #771: `rebased; CI re-running` only when authoritative PR head moved.
    const behindWt = await getForIssueFn(cfg, issueNumber);
    const behindAlreadyRebased = behindWt ? rebaseAlreadyAttemptedFn(behindWt.path) : true;
    if (!behindAlreadyRebased && behindWt) {
      const beforeSha = freshPrDetail.head_sha;
      const gitOk = await tryRebaseAndPushFn(cfg, issueNumber);
      // Consume one-shot worktree budget whether HEAD moved or not.
      markRebaseAttemptedFn(behindWt.path);
      let afterSha: string | undefined;
      try {
        afterSha = (await getPrDetailFn(cfg, prNumber)).head_sha;
      } catch {
        afterSha = undefined;
      }
      const rebaseResult = await resolveRebasePushResult(beforeSha, gitOk, afterSha);
      if (opts.stateDir) {
        const summary =
          rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved
            ? "rebase and push succeeded; HEAD moved; CI re-running"
            : rebaseResult.ok && !rebaseResult.verified
              ? "rebase and push reported success but PR head could not be re-read"
              : rebaseResult.ok
                ? "rebase and push reported success but HEAD unchanged"
                : rebaseResult.reason;
        await recordCommand(
          opts.stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
            rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved ? 0 : 1,
            0,
            summary,
          ),
        ).catch(() => {});
      }
      if (rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved) {
        return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
      }
      // Successful side-effect with unverified HEAD: do not block on the old tip.
      if (rebaseResult.ok && !rebaseResult.verified) {
        return {
          advanced: false,
          status: "waiting",
          reason: REBASE_HEAD_UNVERIFIED_WAIT_REASON,
        };
      }
    }
    const mergeConflictMsg = "PR branch is behind the base branch and could not be automatically updated — manual rebase or update needed.";
    await setBlockedFn(cfg, issueNumber, mergeConflictMsg, "pre-merge", "merge-conflict");
    return preMergeBlocked(mergeConflictMsg, "merge-conflict");
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
      return preMergeBlocked("openspec validation failed", "openspec-invalid");
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
