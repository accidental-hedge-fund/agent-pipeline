// Human-gated merge-queue drive with optional release-when-complete (#676)
// and typed conflict/CI repair holds (#675).
//
// Walks selector-scoped pipeline:ready-to-deploy PRs one at a time through the
// existing merge surface (mergePr). Default is dry-run (no merges). Opt-in
// --release-when-complete prepares a release PR via shared runRelease when the
// queue is complete — never tags, publishes, or merges the release.
//
// On conflict or red required checks: record a typed hold, never force-merge,
// continue remaining candidates. Optional --repair (default off) may attempt
// deterministic-first then shared mechanical repair, re-gate, then mergePr.

import { spawnSync } from "node:child_process";
import { mergePr, realMergeDeps, type MergeDeps } from "./merge.ts";
import {
  evaluateReleaseWhenComplete,
  isReleaseWhenCompleteEnabled,
  maybePrepareReleaseWhenComplete,
  missingReleaseVersionError,
  type ReleaseWhenCompleteHookResult,
  type RunReleaseFn,
} from "./merge-queue-release-when-complete.ts";
import { runRelease } from "./release.ts";
import {
  canAttemptRepair,
  claimRepairAttempt,
  classifyEligibility,
  classifyFromMergeError,
  createHold,
  createRepairBudget,
  buildSurgicalRepairPrompt,
  type EligibilitySnapshot,
  type MergeQueueHoldReason,
  type MergeQueueHoldRecord,
  type RepairBudgetState,
} from "./merge_queue_hold.ts";
import {
  evaluateChecksGate,
  isMergeableClean,
  realMergeQueueDeps as realPlanDeps,
  type MergeQueueDeps as PlanDeps,
} from "./merge_queue.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MergeQueueCandidate {
  issueNumber: number;
  prNumber: number;
  title: string;
}

/** Held item in drive results — reason is the typed code when classifiable. */
export interface MergeQueueHeldItem {
  issueNumber: number;
  prNumber: number;
  /** Typed hold reason when known; free-form only for non-classifiable failures. */
  reason: MergeQueueHoldReason | string;
  summary?: string;
  remediation?: string;
  headSha?: string;
  repairAttemptsUsed?: number;
  outcome?: "held" | "manual-repair" | "failed";
  /** Never true solely for mechanical budget exhaustion. */
  humanAuthority?: boolean;
}

export interface MergeQueueNonCandidate {
  issueNumber: number;
  title?: string;
}

export interface MergeQueueOpts {
  /** Milestone title selector (required for candidate scope). */
  milestone: string;
  /**
   * When true, perform merges. When false (default), dry-run: plan only.
   * Commander `--apply` sets this true; bare dry-run is the safe default.
   * Superseded when `dryRun` is true (explicit `--dry-run` forces plan-only).
   */
  apply: boolean;
  /**
   * Explicit CLI `--dry-run`. When true, forces plan-only mode even if
   * `apply` is also true — dry-run always wins over apply.
   */
  dryRun?: boolean;
  /**
   * Opt-in surgical/mechanical repair of held conflict/CI items (#675).
   * CLI `--repair`. Default false; dry-run never repairs.
   */
  repair?: boolean;
  /** Config `merge_queue.repair` (default false). */
  repairConfig?: boolean;
  /** Max charged implementer repair attempts per item (default 1). */
  repairMaxAttempts?: number;
  /** Optional wall-clock budget for repair-related work (ms). */
  repairMaxWallClockMs?: number;
  /** CLI `--release-when-complete` flag. */
  releaseWhenComplete?: boolean;
  /** CLI `--release-version` (major|minor|patch|X.Y.Z). */
  releaseVersion?: string;
  /** Config `merge_queue.release_when_complete` (default false). */
  releaseWhenCompleteConfig?: boolean;
  repoDir: string;
  repo: string;
  baseBranch?: string;
  releaseModel?: "semver" | "continuous";
}

export interface DeterministicRepairResult {
  /** True when a candidate-moving side effect may have occurred (rebase/push). */
  changed: boolean;
  headSha?: string;
  evidence: string;
}

export interface MechanicalRepairResult {
  succeeded: boolean;
  headSha?: string;
  evidence: string;
  error?: string;
}

export interface MergeQueueDeps {
  /** List open R2D candidates for the milestone (issue + open PR). */
  listR2dCandidates(milestone: string): Promise<MergeQueueCandidate[]>;
  /**
   * Open milestone issues that are not R2D candidates (warning payload only).
   * `candidateIssueNumbers` is the set currently treated as candidates so the
   * impl can exclude them without a second eligibility pass when possible.
   */
  listOpenNonCandidates(
    milestone: string,
    candidateIssueNumbers: ReadonlySet<number>,
  ): Promise<MergeQueueNonCandidate[]>;
  /**
   * Merge one candidate via the existing human merge surface.
   * On throw, the drive holds the item and continues.
   */
  mergeCandidate(candidate: MergeQueueCandidate): Promise<void>;
  /**
   * Optional live eligibility snapshot for typed holds + re-gate (#675).
   * When absent, drive still classifies merge errors after mergeCandidate throws.
   */
  evaluateEligibility?(
    candidate: MergeQueueCandidate,
  ): Promise<EligibilitySnapshot>;
  /**
   * Deterministic remediation first (clean rebase/restack or check re-query).
   * Must not charge the implementer budget. Optional; skipped when absent.
   */
  attemptDeterministicRepair?(
    candidate: MergeQueueCandidate,
    reason: MergeQueueHoldReason,
    snapshot: EligibilitySnapshot,
  ): Promise<DeterministicRepairResult>;
  /**
   * Shared mechanical / implementer repair seam (repair_pipeline_item mapping).
   * Claimed and charged before invoke. Must not call mergePr itself.
   */
  attemptMechanicalRepair?(
    candidate: MergeQueueCandidate,
    reason: MergeQueueHoldReason,
    snapshot: EligibilitySnapshot,
    prompt: string,
  ): Promise<MechanicalRepairResult>;
  /** Clock for repair wall-clock budget (epoch ms). */
  now?(): number;
  /** Shared release prepare entry (runRelease). */
  runRelease: RunReleaseFn;
  log(msg: string): void;
  error(msg: string): void;
}

export interface MergeQueueResult {
  mode: "dry-run" | "apply";
  /** Candidates present at drive start. */
  initialCandidates: MergeQueueCandidate[];
  /** Successfully merged (apply only). */
  merged: MergeQueueCandidate[];
  /** Held after conflict/checks/failure (apply only). */
  held: MergeQueueHeldItem[];
  /** Remaining open R2D candidates after the drive (re-queried when apply). */
  remainingCandidates: MergeQueueCandidate[];
  openNonCandidates: MergeQueueNonCandidate[];
  release: ReleaseWhenCompleteHookResult;
  /** Process exit code for the CLI (0 ok, 1 hold/merge/release failure, 2 usage). */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

const R2D_LABEL = "pipeline:ready-to-deploy";
const DEFAULT_REPAIR_MAX_ATTEMPTS = 1;

/**
 * Resolve the open same-repo PR number that closes `issueNumber`, or null when
 * the issue has no open closing PR. Lookup / parse failures throw so callers
 * fail closed rather than treating an R2D issue as a non-candidate (which would
 * falsely empty the queue for release-when-complete completeness).
 * Uses `gh pr list --search "closing:N"` shape already used elsewhere.
 */
function resolveOpenPrForIssue(
  repoDir: string,
  repo: string,
  issueNumber: number,
): number | null {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `closing:${issueNumber}`,
      "--json",
      "number",
      "--limit",
      "5",
    ],
    { encoding: "utf8", stdio: "pipe", cwd: repoDir },
  );
  if (result.status !== 0) {
    throw new Error(
      `[merge-queue] gh pr list failed for issue #${issueNumber} ` +
        `(exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
    );
  }
  try {
    const items = JSON.parse(result.stdout.trim() || "[]") as Array<{ number: number }>;
    return items.length > 0 ? items[0].number : null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[merge-queue] failed to parse gh pr list for issue #${issueNumber}: ${detail}`,
    );
  }
}

function snapshotSummary(reason: MergeQueueHoldReason, snap: EligibilitySnapshot): string {
  if (reason === "merge-conflict") {
    return `mergeable=${snap.mergeable} mergeStateStatus=${snap.mergeStateStatus}`;
  }
  return snap.checksDetail?.trim() || "required checks blocking";
}

function holdToResultItem(hold: MergeQueueHoldRecord): MergeQueueHeldItem {
  return {
    issueNumber: hold.issueNumber,
    prNumber: hold.prNumber,
    reason: hold.reason,
    summary: hold.summary,
    remediation: hold.remediation,
    headSha: hold.headSha,
    repairAttemptsUsed: hold.repairAttemptsUsed,
    outcome: hold.outcome,
    humanAuthority: hold.humanAuthority,
  };
}

export function isRepairEnabled(
  repairFlag: boolean | undefined,
  repairConfig: boolean | undefined,
): boolean {
  return repairFlag === true || repairConfig === true;
}

/**
 * Production eligibility evaluator using the same gates as dry-run selection /
 * mergePr (mergeable+CLEAN + checks policy).
 */
export async function evaluateCandidateEligibility(
  prNumber: number,
  planDeps: Pick<PlanDeps, "ghPrView" | "ghPrChecksRequired" | "ghPrChecksAll">,
): Promise<EligibilitySnapshot> {
  const prData = await planDeps.ghPrView(prNumber, [
    "mergeable",
    "mergeStateStatus",
    "headRefOid",
  ]);
  const mergeable = String(prData.mergeable ?? "UNKNOWN");
  const mergeStateStatus = String(prData.mergeStateStatus ?? "UNKNOWN");
  const headRefOid = String(prData.headRefOid ?? "") || undefined;

  // When conflict/dirty, checks are secondary (conflict wins) but still
  // surface detail when both fail.
  let checksOk = true;
  let checksDetail: string | undefined;
  if (isMergeableClean(mergeable, mergeStateStatus)) {
    const checks = await evaluateChecksGate(prNumber, planDeps);
    checksOk = checks.ok;
    checksDetail = checks.ok ? undefined : checks.detail;
  } else {
    // Still try to report check detail when cheap; ignore check API failures.
    try {
      const checks = await evaluateChecksGate(prNumber, planDeps);
      if (!checks.ok) checksDetail = checks.detail;
    } catch {
      /* conflict is sufficient */
    }
  }

  return {
    mergeable,
    mergeStateStatus,
    checksOk,
    checksDetail,
    headRefOid,
  };
}

export function realMergeQueueDeps(
  repoDir: string,
  repo: string,
  mergeDeps?: MergeDeps,
): MergeQueueDeps {
  const md = mergeDeps ?? realMergeDeps(repo);
  const plan = realPlanDeps(repo);

  return {
    async listR2dCandidates(milestone: string): Promise<MergeQueueCandidate[]> {
      const result = spawnSync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          R2D_LABEL,
          "--milestone",
          milestone,
          "--json",
          "number,title",
          "--limit",
          "200",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[merge-queue] gh issue list failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const items = JSON.parse(result.stdout.trim() || "[]") as Array<{
        number: number;
        title: string;
      }>;
      const candidates: MergeQueueCandidate[] = [];
      for (const item of items) {
        const prNumber = resolveOpenPrForIssue(repoDir, repo, item.number);
        if (prNumber == null) continue;
        candidates.push({
          issueNumber: item.number,
          prNumber,
          title: item.title,
        });
      }
      // Stable order: ascending issue number.
      candidates.sort((a, b) => a.issueNumber - b.issueNumber);
      return candidates;
    },

    async listOpenNonCandidates(
      milestone: string,
      candidateIssueNumbers: ReadonlySet<number>,
    ): Promise<MergeQueueNonCandidate[]> {
      const result = spawnSync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--milestone",
          milestone,
          "--json",
          "number,title,labels",
          "--limit",
          "200",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[merge-queue] gh issue list (all open) failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const items = JSON.parse(result.stdout.trim() || "[]") as Array<{
        number: number;
        title: string;
        labels: Array<{ name: string }>;
      }>;
      return items
        .filter((item) => !candidateIssueNumbers.has(item.number))
        .map((item) => ({ issueNumber: item.number, title: item.title }));
    },

    async mergeCandidate(candidate: MergeQueueCandidate): Promise<void> {
      await mergePr(candidate.prNumber, md);
    },

    async evaluateEligibility(candidate) {
      return evaluateCandidateEligibility(candidate.prNumber, plan);
    },

    // Production does not auto-wire implementer repair here — operators opt in
    // via --repair and injectors/tests supply mechanical seams. Deterministic
    // path re-queries eligibility only (checks re-read; no silent rebase without
    // worktree wiring). Full worktree rebase remains available through the
    // injected attemptDeterministicRepair / attemptMechanicalRepair seams.
    async attemptDeterministicRepair(candidate, reason, _snapshot) {
      if (reason === "checks-failed") {
        // Re-query settled check state (no second poller loop — one re-read).
        const snap = await evaluateCandidateEligibility(candidate.prNumber, plan);
        return {
          changed: false,
          headSha: snap.headRefOid,
          evidence: snap.checksOk
            ? "checks re-query: non-blocking"
            : `checks re-query still blocking: ${snap.checksDetail ?? "unknown"}`,
        };
      }
      // Conflict: re-read mergeability; actual rebase requires mechanical/worktree path.
      const snap = await evaluateCandidateEligibility(candidate.prNumber, plan);
      return {
        changed: false,
        headSha: snap.headRefOid,
        evidence: isMergeableClean(snap.mergeable, snap.mergeStateStatus)
          ? "mergeability re-query: MERGEABLE/CLEAN"
          : `mergeability re-query: mergeable=${snap.mergeable} mergeStateStatus=${snap.mergeStateStatus}`,
      };
    },

    runRelease: (versionArg, opts, cfg) => runRelease(versionArg, opts, cfg),

    now: () => Date.now(),

    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
  };
}

// ---------------------------------------------------------------------------
// Per-candidate apply processing
// ---------------------------------------------------------------------------

async function tryMerge(
  candidate: MergeQueueCandidate,
  deps: MergeQueueDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await deps.mergeCandidate(candidate);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function processCandidateApply(
  candidate: MergeQueueCandidate,
  opts: {
    repairEnabled: boolean;
    repairMaxAttempts: number;
    repairMaxWallClockMs?: number;
  },
  deps: MergeQueueDeps,
): Promise<
  | { status: "merged" }
  | { status: "held"; hold: MergeQueueHeldItem }
> {
  const nowFn = deps.now ?? (() => Date.now());
  let budget: RepairBudgetState | undefined;
  if (opts.repairEnabled) {
    budget = createRepairBudget(opts.repairMaxAttempts, {
      maxWallClockMs: opts.repairMaxWallClockMs,
      nowMs: nowFn(),
    });
  }

  const reEvaluate = async (): Promise<EligibilitySnapshot | null> => {
    if (!deps.evaluateEligibility) return null;
    return deps.evaluateEligibility(candidate);
  };

  let snapshot = await reEvaluate();
  let reason: MergeQueueHoldReason | null = snapshot
    ? classifyEligibility(snapshot)
    : null;

  // Eligible path (or no evaluator): attempt merge; classify throw if needed.
  const attemptMergeOnce = async (): Promise<
    | { status: "merged" }
    | { status: "held"; hold: MergeQueueHeldItem }
    | { status: "ineligible"; reason: MergeQueueHoldReason; snapshot: EligibilitySnapshot | null; summary: string }
  > => {
    if (reason && snapshot) {
      return {
        status: "ineligible",
        reason,
        snapshot,
        summary: snapshotSummary(reason, snapshot),
      };
    }
    const mergeResult = await tryMerge(candidate, deps);
    if (mergeResult.ok) return { status: "merged" };

    const fromErr = classifyFromMergeError(mergeResult.error);
    if (fromErr) {
      // Refresh snapshot if we can so re-gate/repair have current evidence.
      snapshot = (await reEvaluate()) ?? snapshot;
      if (snapshot) {
        const classified = classifyEligibility(snapshot) ?? fromErr;
        return {
          status: "ineligible",
          reason: classified,
          snapshot,
          summary: snapshot
            ? snapshotSummary(classified, snapshot)
            : mergeResult.error,
        };
      }
      return {
        status: "ineligible",
        reason: fromErr,
        snapshot: null,
        summary: mergeResult.error,
      };
    }

    // Non-classifiable hard failure — hold with free-form reason (no force-merge).
    return {
      status: "held",
      hold: {
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        reason: mergeResult.error,
        summary: mergeResult.error,
        outcome: "failed",
        humanAuthority: false,
        remediation:
          `PR #${candidate.prNumber} (issue #${candidate.issueNumber}) failed merge: ${mergeResult.error}. ` +
          `Inspect the error, fix, then retry merge-queue apply or pipeline merge ${candidate.prNumber}.`,
      },
    };
  };

  let first = await attemptMergeOnce();
  if (first.status === "merged") return { status: "merged" };
  if (first.status === "held") return first;

  // Ineligible: optional repair ladder, else hold.
  reason = first.reason;
  snapshot = first.snapshot;
  let summary = first.summary;
  let attemptsUsed = 0;

  const makeHold = (budgetExhausted: boolean): MergeQueueHeldItem =>
    holdToResultItem(
      createHold({
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        reason: reason!,
        summary,
        headSha: snapshot?.headRefOid,
        repairAttemptsUsed: attemptsUsed,
        budgetExhausted,
      }),
    );

  if (!opts.repairEnabled || !budget) {
    return { status: "held", hold: makeHold(false) };
  }

  // Repair ladder: deterministic first, then claimed mechanical while budget remains.
  while (true) {
    // Deterministic remediation (does not charge implementer attempts).
    if (deps.attemptDeterministicRepair && snapshot) {
      deps.log(
        `[merge-queue] deterministic repair for issue #${candidate.issueNumber} ` +
          `PR #${candidate.prNumber} (${reason})…`,
      );
      const det = await deps.attemptDeterministicRepair(candidate, reason!, snapshot);
      deps.log(`[merge-queue] deterministic: ${det.evidence}`);
      // Always re-gate after deterministic path (even re-query only).
      snapshot = (await reEvaluate()) ?? snapshot;
      if (snapshot) {
        reason = classifyEligibility(snapshot);
        if (reason) {
          summary = snapshotSummary(reason, snapshot);
        } else {
          // Re-eligible — merge via existing surface only.
          const mergeResult = await tryMerge(candidate, deps);
          if (mergeResult.ok) return { status: "merged" };
          const fromErr = classifyFromMergeError(mergeResult.error);
          if (fromErr) {
            reason = fromErr;
            summary = mergeResult.error;
            snapshot = (await reEvaluate()) ?? snapshot;
          } else {
            return {
              status: "held",
              hold: {
                issueNumber: candidate.issueNumber,
                prNumber: candidate.prNumber,
                reason: mergeResult.error,
                summary: mergeResult.error,
                outcome: "failed",
                humanAuthority: false,
                repairAttemptsUsed: attemptsUsed,
              },
            };
          }
        }
      }
    }

    if (!reason) {
      // Should have merged above; if not, re-check.
      const mergeResult = await tryMerge(candidate, deps);
      if (mergeResult.ok) return { status: "merged" };
      const fromErr = classifyFromMergeError(mergeResult.error) ?? "checks-failed";
      reason = fromErr;
      summary = mergeResult.error;
    }

    if (!canAttemptRepair(budget, nowFn())) {
      deps.log(
        `[merge-queue] repair budget exhausted for issue #${candidate.issueNumber} ` +
          `PR #${candidate.prNumber} (attempts=${budget.attemptsUsed})`,
      );
      return { status: "held", hold: makeHold(true) };
    }

    if (!deps.attemptMechanicalRepair) {
      // Repair enabled but no mechanical seam — leave manual-repair hold.
      return { status: "held", hold: makeHold(true) };
    }

    // Claim before side effects.
    budget = claimRepairAttempt(budget);
    attemptsUsed = budget.attemptsUsed;
    const prompt = buildSurgicalRepairPrompt({
      reason: reason!,
      prNumber: candidate.prNumber,
      issueNumber: candidate.issueNumber,
      summary,
      headSha: snapshot?.headRefOid,
    });
    deps.log(
      `[merge-queue] mechanical repair attempt ${attemptsUsed} for ` +
        `issue #${candidate.issueNumber} PR #${candidate.prNumber}…`,
    );
    const mech = await deps.attemptMechanicalRepair(
      candidate,
      reason!,
      snapshot ?? {
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        checksOk: false,
        checksDetail: summary,
      },
      prompt,
    );
    deps.log(
      `[merge-queue] mechanical repair: succeeded=${mech.succeeded} ${mech.evidence}`,
    );

    // Mandatory re-gate after candidate-moving repair (or any mechanical attempt).
    snapshot = (await reEvaluate()) ?? snapshot;
    if (snapshot) {
      reason = classifyEligibility(snapshot);
      if (!reason) {
        const mergeResult = await tryMerge(candidate, deps);
        if (mergeResult.ok) return { status: "merged" };
        const fromErr = classifyFromMergeError(mergeResult.error);
        if (fromErr) {
          reason = fromErr;
          summary = mergeResult.error;
        } else {
          return {
            status: "held",
            hold: {
              issueNumber: candidate.issueNumber,
              prNumber: candidate.prNumber,
              reason: mergeResult.error,
              summary: mergeResult.error,
              outcome: "failed",
              humanAuthority: false,
              repairAttemptsUsed: attemptsUsed,
            },
          };
        }
      } else {
        summary = snapshotSummary(reason, snapshot);
      }
    } else if (!mech.succeeded) {
      summary = mech.error ?? mech.evidence ?? summary;
    }

    // Loop: if still ineligible, continue while budget remains.
    if (!reason) {
      // No snapshot and merge didn't run — hold.
      return { status: "held", hold: makeHold(!canAttemptRepair(budget, nowFn())) };
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the merge-queue drive (dry-run or apply) and optionally prepare a release
 * when the queue is complete.
 *
 * Failure isolation: if release prepare fails after merges, merge outcomes stay
 * intact and exitCode becomes non-zero after reporting. Conflict/CI holds never
 * force-merge; default policy is hold item and continue remaining candidates.
 */
export async function runMergeQueue(
  opts: MergeQueueOpts,
  deps: MergeQueueDeps,
): Promise<MergeQueueResult> {
  const enabled = isReleaseWhenCompleteEnabled(
    opts.releaseWhenComplete,
    opts.releaseWhenCompleteConfig,
  );
  // Explicit --dry-run forces plan-only even when --apply is also present.
  const dryRun = opts.dryRun === true || !opts.apply;
  const repairEnabled =
    !dryRun && isRepairEnabled(opts.repair, opts.repairConfig);
  const repairMaxAttempts =
    opts.repairMaxAttempts != null && opts.repairMaxAttempts >= 0
      ? Math.floor(opts.repairMaxAttempts)
      : DEFAULT_REPAIR_MAX_ATTEMPTS;

  // Usage gate before any merge or release mutation.
  if (enabled && (!opts.releaseVersion || opts.releaseVersion.trim() === "")) {
    const msg = missingReleaseVersionError();
    deps.error(msg);
    return {
      mode: dryRun ? "dry-run" : "apply",
      initialCandidates: [],
      merged: [],
      held: [],
      remainingCandidates: [],
      openNonCandidates: [],
      release: {
        status: "usage_error",
        exitNonZero: true,
        error: msg,
      },
      exitCode: 2,
    };
  }

  const initialCandidates = await deps.listR2dCandidates(opts.milestone);
  const candidateNums = new Set(initialCandidates.map((c) => c.issueNumber));
  const openNonCandidates = await deps.listOpenNonCandidates(
    opts.milestone,
    candidateNums,
  );

  deps.log(
    `[merge-queue] milestone=${JSON.stringify(opts.milestone)} ` +
      `mode=${dryRun ? "dry-run" : "apply"}` +
      `${repairEnabled ? " repair=on" : ""}` +
      ` candidates=${initialCandidates.length}`,
  );

  const merged: MergeQueueCandidate[] = [];
  const held: MergeQueueHeldItem[] = [];

  if (dryRun) {
    if (initialCandidates.length === 0) {
      deps.log("[merge-queue] dry-run: no ready-to-deploy candidates");
    } else {
      deps.log("[merge-queue] dry-run planned merges (no merges performed):");
      for (const c of initialCandidates) {
        deps.log(
          `  - issue #${c.issueNumber} PR #${c.prNumber}: ${c.title}`,
        );
      }
    }
    // Dry-run never repairs even if --repair is present.
    if (opts.repair || opts.repairConfig) {
      deps.log(
        "[merge-queue] dry-run: repair flag ignored (no repair side effects)",
      );
    }
    if (!enabled) {
      // Dry-run without flag: do not list prepare-release as a planned action.
      deps.log("[merge-queue] dry-run: release-when-complete is off (no release prepare planned)");
    }
  } else {
    // Sequential single-flight: hold-and-continue on conflict/checks/failure.
    for (const c of initialCandidates) {
      deps.log(
        `[merge-queue] processing issue #${c.issueNumber} PR #${c.prNumber}…`,
      );
      const outcome = await processCandidateApply(
        c,
        {
          repairEnabled,
          repairMaxAttempts,
          repairMaxWallClockMs: opts.repairMaxWallClockMs,
        },
        deps,
      );
      if (outcome.status === "merged") {
        merged.push(c);
        deps.log(
          `[merge-queue] merged issue #${c.issueNumber} PR #${c.prNumber}`,
        );
      } else {
        held.push(outcome.hold);
        const rem = outcome.hold.remediation
          ? ` — ${outcome.hold.remediation}`
          : "";
        deps.log(
          `[merge-queue] held issue #${c.issueNumber} PR #${c.prNumber}` +
            ` reason=${outcome.hold.reason}${rem}`,
        );
      }
    }
  }

  // Completeness: dry-run uses current state; apply re-queries remaining R2D.
  const remainingCandidates = dryRun
    ? initialCandidates
    : await deps.listR2dCandidates(opts.milestone);

  // Held items for completeness: apply uses drive holds; dry-run has none yet.
  const heldForCompleteness = dryRun ? [] : held;

  const completeness = evaluateReleaseWhenComplete({
    remainingCandidates: remainingCandidates.map((c) => ({
      issueNumber: c.issueNumber,
      prNumber: c.prNumber,
    })),
    heldItems: heldForCompleteness.map((h) => ({
      issueNumber: h.issueNumber,
      prNumber: h.prNumber,
      reason: h.reason,
    })),
    openNonCandidates: openNonCandidates.map((n) => ({
      issueNumber: n.issueNumber,
      title: n.title,
    })),
  });

  const release = await maybePrepareReleaseWhenComplete(
    {
      enabled,
      version: opts.releaseVersion,
      dryRun,
    },
    completeness,
    {
      repo_dir: opts.repoDir,
      repo: opts.repo,
      base_branch: opts.baseBranch,
      release_model: opts.releaseModel,
    },
    {
      runRelease: deps.runRelease,
      log: deps.log,
      error: deps.error,
    },
  );

  let exitCode = 0;
  if (release.exitNonZero) {
    exitCode = release.status === "usage_error" ? 2 : 1;
  } else if (held.length > 0) {
    // Held conflict/checks/budget items leave a non-zero exit for operators.
    exitCode = 1;
  }

  return {
    mode: dryRun ? "dry-run" : "apply",
    initialCandidates,
    merged,
    held,
    remainingCandidates,
    openNonCandidates,
    release,
    exitCode,
  };
}
