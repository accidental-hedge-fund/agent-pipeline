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
import * as fs from "node:fs";
import * as path from "node:path";
import { invoke } from "../harness.ts";
import type { PipelineConfig } from "../types.ts";
import {
  branchName,
  ensureManagedWorktree,
  getOnDiskForIssue,
  gitInWorktree,
} from "../worktree.ts";
import {
  mergeQueueIntegrityStoreRoot,
  runCoveredCandidateMutation,
  type CandidateIntegrityContext,
  type IntegrityClassification,
} from "../candidate-integrity.ts";
import { appendEvent, defaultRunStoreDeps } from "../run-store.ts";
import { mergePr, realMergeDeps, type MergeDeps } from "./merge.ts";
import {
  evaluateReleaseWhenComplete,
  isReleaseWhenCompleteEnabled,
  maybePrepareReleaseWhenComplete,
  missingReleaseVersionError,
  type ReleaseWhenCompleteHookResult,
  type RunReleaseFn,
} from "./merge-queue-release-when-complete.ts";
import { performPreMergeAutoFix } from "./pre_merge.ts";
import { runRelease } from "./release.ts";
import {
  applyReadmeLandingContractGate,
  canAttemptRepair,
  claimRepairAttempt,
  classifyFromMergeError,
  classifyQueueEligibility,
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
 * Best-effort read of root README.md from a managed worktree for the landing-page
 * re-gate (#855). Returns null when no worktree is on disk or the file is missing.
 * Injectable for hermetic tests — production uses {@link getOnDiskForIssue}.
 */
export function readManagedWorktreeReadme(
  issueNumber: number,
  cfg: PipelineConfig,
  deps: {
    getOnDiskForIssue?: typeof getOnDiskForIssue;
    readFileSync?: (absPath: string, encoding: "utf8") => string;
    existsSync?: (absPath: string) => boolean;
  } = {},
): string | null {
  const getWorktree = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const read =
    deps.readFileSync ??
    ((p: string, enc: "utf8") => fs.readFileSync(p, enc));
  try {
    const onDisk = getWorktree(issueNumber, cfg);
    if (!onDisk?.path) return null;
    const readmePath = path.join(onDisk.path, "README.md");
    if (!exists(readmePath)) return null;
    return read(readmePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Production eligibility evaluator using the same gates as dry-run selection /
 * mergePr: PR open + linked-issue R2D policy + mergeable+CLEAN + checks policy.
 *
 * Optional `readmeContent` applies the README landing-page contract (#855) so a
 * post-repair / restack head that reintroduces a monolithic README cannot be
 * re-gate eligible even when GitHub checks have not yet re-run.
 */
export async function evaluateCandidateEligibility(
  candidate: { prNumber: number; issueNumber: number },
  planDeps: Pick<PlanDeps, "ghPrView" | "ghPrChecksRequired" | "ghPrChecksAll">,
  labelDeps?: Pick<MergeDeps, "getIssueLabels">,
  opts?: { readmeContent?: string | null },
): Promise<EligibilitySnapshot> {
  const prNumber = candidate.prNumber;
  const prData = await planDeps.ghPrView(prNumber, [
    "mergeable",
    "mergeStateStatus",
    "headRefOid",
    "state",
  ]);
  const mergeable = String(prData.mergeable ?? "UNKNOWN");
  const mergeStateStatus = String(prData.mergeStateStatus ?? "UNKNOWN");
  const headRefOid = String(prData.headRefOid ?? "") || undefined;
  const prState = String(prData.state ?? "") || undefined;

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

  let issueHasR2d: boolean | undefined;
  if (labelDeps) {
    try {
      const labels = await labelDeps.getIssueLabels(candidate.issueNumber);
      issueHasR2d = labels.includes(R2D_LABEL);
    } catch {
      // Fail closed: unknown labels must not look like policy-pass.
      issueHasR2d = false;
    }
  }

  const base: EligibilitySnapshot = {
    mergeable,
    mergeStateStatus,
    checksOk,
    checksDetail,
    headRefOid,
    prState,
    issueHasR2d,
  };
  if (opts && "readmeContent" in opts) {
    return applyReadmeLandingContractGate(base, opts.readmeContent);
  }
  return base;
}

/**
 * Deterministic clean rebase/restack onto the configured integration base for
 * merge-conflict holds (#675). Does **not** charge the implementer budget.
 *
 * Safety scope (destructive force-with-lease):
 * - Operates only inside the **managed worktree root** for the candidate issue.
 * - Pushes only the issue's pipeline branch (`pipeline/<issue>-<slug>`) with
 *   `--force-with-lease=refs/heads/<branch>:<expectedHeadSha>` bound to the
 *   eligibility snapshot head — never force-pushes the integration base.
 * - Fails closed (no abort) when a rebase is already in progress or the worktree
 *   is dirty — never aborts an operator-owned rebase session.
 * - Only aborts a rebase this invocation started from a proven-clean worktree.
 * - On push failure, restores the candidate branch to the pre-rebase SHA so a
 *   later drive can retry (no silent local-only restack).
 *
 * Injectable for hermetic tests; production wires real worktree/git deps.
 */
export type DeterministicRebaseDeps = {
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  ensureManagedWorktree?: typeof ensureManagedWorktree;
  gitInWorktree?: typeof gitInWorktree;
  branchNameFn?: typeof branchName;
  /**
   * #857: when set, the head-moving rebase/push runs under candidate-integrity.
   * Production wires a store under the repo; tests may inject a memory store via
   * `integrity.storeDeps` or omit to exercise the legacy path only when intentionally
   * testing pre-integrity behavior (covered production path always sets this).
   */
  integrity?: Omit<
    CandidateIntegrityContext,
    | "worktreePath"
    | "gitInWorktree"
    | "base_ref"
    | "resolveBaseSha"
    | "resolveCandidateSha"
    | "mutation_method"
    | "subject"
  > & {
    storeRoot?: string;
    subject?: CandidateIntegrityContext["subject"];
    skip?: boolean;
  };
};

export async function runDeterministicConflictRebase(
  candidate: MergeQueueCandidate,
  cfg: PipelineConfig,
  deps: DeterministicRebaseDeps = {},
  /**
   * PR head SHA from the eligibility snapshot that classified the conflict.
   * Required for bound force-with-lease; when absent, fail closed.
   */
  expectedHeadSha?: string,
): Promise<DeterministicRepairResult> {
  const getWorktree = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const ensureWorktree = deps.ensureManagedWorktree ?? ensureManagedWorktree;
  const git = deps.gitInWorktree ?? gitInWorktree;
  const branchFn = deps.branchNameFn ?? branchName;

  const base = cfg.base_branch;
  if (!base) {
    return {
      changed: false,
      evidence: "deterministic rebase skipped: no base_branch configured",
    };
  }

  const expected = expectedHeadSha?.trim();
  if (!expected) {
    return {
      changed: false,
      evidence:
        "deterministic rebase skipped: no expected PR head SHA (eligibility snapshot required)",
    };
  }

  let wt = await getWorktree(cfg, candidate.issueNumber);
  if (!wt) {
    const materialized = await ensureWorktree(cfg, candidate.issueNumber);
    if (materialized.result === "fail" || !materialized.worktree) {
      const detail =
        materialized.result === "fail"
          ? materialized.reason
          : "worktree rematerialization did not return a worktree";
      return {
        changed: false,
        evidence: `deterministic rebase: managed worktree unavailable: ${detail}`,
      };
    }
    wt = { path: materialized.worktree.path, slug: materialized.worktree.slug };
  }

  // Managed worktree only — never operate outside this root.
  const managedRoot = wt.path;
  const branch = branchFn(candidate.issueNumber, wt.slug);

  // Fail closed if a rebase is already in progress (operator-owned session).
  const rebaseMerge = await git(
    managedRoot,
    ["rev-parse", "--verify", "REBASE_HEAD"],
    { ignoreFailure: true },
  );
  if (rebaseMerge.code === 0) {
    return {
      changed: false,
      evidence:
        "deterministic rebase skipped: rebase already in progress (will not abort operator session)",
    };
  }

  // Fail closed on a dirty worktree — do not clobber uncommitted operator work.
  const dirty = await git(managedRoot, ["status", "--porcelain"], {
    ignoreFailure: true,
  });
  if (dirty.code === 0 && dirty.stdout.trim() !== "") {
    return {
      changed: false,
      evidence:
        "deterministic rebase skipped: managed worktree has uncommitted changes",
    };
  }

  const headBefore = await git(managedRoot, ["rev-parse", "HEAD"], {
    ignoreFailure: true,
  });
  const beforeSha =
    headBefore.code === 0 ? headBefore.stdout.trim() || undefined : undefined;
  if (!beforeSha) {
    return {
      changed: false,
      evidence: "deterministic rebase: cannot resolve local HEAD",
    };
  }
  if (beforeSha !== expected) {
    return {
      changed: false,
      headSha: beforeSha,
      evidence:
        `deterministic rebase skipped: local HEAD ${beforeSha.slice(0, 7)} ` +
        `!== eligibility snapshot head ${expected.slice(0, 7)} (stale checkout)`,
    };
  }

  // Fetch base and the candidate branch so remote-tracking is current.
  const fetchBase = await git(managedRoot, ["fetch", "origin", base], {
    ignoreFailure: true,
  });
  if (fetchBase.code !== 0) {
    return {
      changed: false,
      headSha: beforeSha,
      evidence: `deterministic rebase: fetch origin/${base} failed`,
    };
  }
  const fetchBranch = await git(managedRoot, ["fetch", "origin", branch], {
    ignoreFailure: true,
  });
  if (fetchBranch.code !== 0) {
    return {
      changed: false,
      headSha: beforeSha,
      evidence: `deterministic rebase: fetch origin/${branch} failed`,
    };
  }

  const remoteHead = await git(
    managedRoot,
    ["rev-parse", `refs/remotes/origin/${branch}`],
    { ignoreFailure: true },
  );
  const remoteSha =
    remoteHead.code === 0 ? remoteHead.stdout.trim() || undefined : undefined;
  if (!remoteSha || remoteSha !== expected) {
    return {
      changed: false,
      headSha: beforeSha,
      evidence:
        `deterministic rebase skipped: origin/${branch} ` +
        `${(remoteSha ?? "missing").slice(0, 12)} !== eligibility snapshot ` +
        `${expected.slice(0, 7)} (stale or divergent remote head)`,
    };
  }

  const performRebasePush = async (): Promise<DeterministicRepairResult> => {
    // We started from a proven-clean, non-rebasing worktree at the expected SHA.
    // Only then is aborting a rebase we start safe (it is ours).
    const rebase = await git(managedRoot, ["rebase", `origin/${base}`], {
      ignoreFailure: true,
    });
    if (rebase.code !== 0) {
      await git(managedRoot, ["rebase", "--abort"], { ignoreFailure: true });
      // Ensure we are back on the pre-rebase SHA (abort should restore; belt+suspenders).
      await git(managedRoot, ["reset", "--hard", expected], {
        ignoreFailure: true,
      });
      return {
        changed: false,
        headSha: expected,
        evidence:
          `deterministic rebase onto origin/${base} failed (conflicts or unclean); aborted our session`,
      };
    }

    const headAfterRebase = await git(managedRoot, ["rev-parse", "HEAD"], {
      ignoreFailure: true,
    });
    const afterRebaseSha =
      headAfterRebase.code === 0
        ? headAfterRebase.stdout.trim() || undefined
        : undefined;

    // No-op restack: branch already based on origin/<base> tip — not candidate-moving.
    if (beforeSha && afterRebaseSha && beforeSha === afterRebaseSha) {
      return {
        changed: false,
        headSha: afterRebaseSha,
        evidence: `deterministic rebase: already up to date with origin/${base} (HEAD unchanged)`,
      };
    }

    // Bound force-with-lease to the eligibility snapshot head, not a floating tracking ref.
    const leaseRef = `refs/heads/${branch}:${expected}`;
    const push = await git(
      managedRoot,
      ["push", `--force-with-lease=${leaseRef}`, "origin", `HEAD:refs/heads/${branch}`],
      { ignoreFailure: true },
    );
    if (push.code !== 0) {
      // Restore local branch so a later drive can retry (avoids "already up to date" no-op).
      await git(managedRoot, ["reset", "--hard", expected], {
        ignoreFailure: true,
      });
      return {
        changed: false,
        headSha: expected,
        evidence:
          `deterministic rebase succeeded locally but force-with-lease push of ${branch} ` +
          `failed (lease expected ${expected.slice(0, 7)}); local branch restored`,
      };
    }

    const moved =
      beforeSha && afterRebaseSha
        ? ` (${beforeSha.slice(0, 7)} → ${afterRebaseSha.slice(0, 7)})`
        : "";
    return {
      changed: true,
      headSha: afterRebaseSha ?? beforeSha,
      evidence:
        `deterministic clean rebase onto origin/${base}; pushed ${branch}${moved}`,
    };
  };

  // #857: candidate-integrity lifecycle around head-moving rebase/push.
  // Production always has cfg.repo_dir (or an explicit integrity.storeRoot).
  // Hermetic unit tests that omit both keep the pre-integrity mutation path.
  const storeRoot =
    deps.integrity?.storeRoot ??
    (cfg.repo_dir
      ? mergeQueueIntegrityStoreRoot(cfg.repo_dir, candidate.issueNumber, candidate.prNumber)
      : undefined);
  if (!deps.integrity?.skip && storeRoot) {
    const subject = deps.integrity?.subject ?? {
      run_id: path.basename(storeRoot),
      issue: candidate.issueNumber,
      pr: candidate.prNumber,
    };
    const integrityResult = await runCoveredCandidateMutation(
      {
        storeRoot,
        subject,
        mutation_method: "restack",
        base_ref: base,
        worktreePath: managedRoot,
        gitInWorktree: git,
        resolveBaseSha: async () => {
          const r = await git(managedRoot, ["rev-parse", `origin/${base}`], {
            ignoreFailure: true,
          });
          return r.code === 0 ? r.stdout.trim() || null : null;
        },
        resolveCandidateSha: async () => {
          // Prefer remote PR branch tip after push; fall back to local HEAD.
          const remote = await git(
            managedRoot,
            ["rev-parse", `refs/remotes/origin/${branch}`],
            { ignoreFailure: true },
          );
          if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim();
          const local = await git(managedRoot, ["rev-parse", "HEAD"], {
            ignoreFailure: true,
          });
          return local.code === 0 ? local.stdout.trim() || null : null;
        },
        emitEvent: deps.integrity?.emitEvent ?? (async (event) => {
          await appendEvent(storeRoot, event as never, defaultRunStoreDeps).catch(() => {});
        }),
        path_class: deps.integrity?.path_class,
        engine_version: deps.integrity?.engine_version,
        storeDeps: deps.integrity?.storeDeps,
        mutation_id: deps.integrity?.mutation_id,
      },
      performRebasePush,
    );

    if (integrityResult.aborted) {
      return {
        changed: false,
        headSha: beforeSha,
        evidence:
          `deterministic rebase aborted by candidate-integrity: ${integrityResult.abort_reason ?? "pre-persist failed"}`,
      };
    }

    const baseResult =
      integrityResult.mutation_result ??
      ({
        changed: false,
        headSha: integrityResult.record.after_sha ?? beforeSha,
        evidence: integrityResult.mutation_error ?? "rebase mutation incomplete",
      } satisfies DeterministicRepairResult);

    return annotateIntegrityResult(
      baseResult,
      integrityResult.classification,
      integrityResult.disposition.merge_eligible,
    );
  }

  return performRebasePush();
}

/** Annotate repair evidence with integrity classification for re-gate consumers. */
function annotateIntegrityResult(
  result: DeterministicRepairResult,
  classification: IntegrityClassification,
  mergeEligible: boolean,
): DeterministicRepairResult {
  const tag = `[candidate-integrity:${classification}${mergeEligible ? "" : ";not-merge-eligible"}]`;
  return {
    ...result,
    evidence: `${result.evidence} ${tag}`,
    // Scope expansion / unverified must not look like a successful candidate-moving repair.
    changed:
      classification === "scope_expansion" || classification === "unverified"
        ? false
        : result.changed,
  };
}

/**
 * Shared mechanical-remediation transaction for merge-queue repair (#675).
 * Reuses managed-worktree resolve + {@link performPreMergeAutoFix} (same push
 * path as recovery's repair_pipeline_item executor) without inventing a
 * merge-queue-only model branch. Does not call mergePr.
 *
 * Injectable for hermetic tests; production wires real worktree/harness deps.
 */
export async function runSharedMechanicalRepair(
  candidate: MergeQueueCandidate,
  prompt: string,
  cfg: PipelineConfig,
  deps: {
    getOnDiskForIssue?: typeof getOnDiskForIssue;
    ensureManagedWorktree?: typeof ensureManagedWorktree;
    gitInWorktree?: typeof gitInWorktree;
    performRepair?: typeof performPreMergeAutoFix;
    invoke?: typeof invoke;
    /** #857 integrity context; production sets store via repo_dir. */
    integrity?: DeterministicRebaseDeps["integrity"];
  } = {},
): Promise<MechanicalRepairResult> {
  const getWorktree = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const ensureWorktree = deps.ensureManagedWorktree ?? ensureManagedWorktree;
  const git = deps.gitInWorktree ?? gitInWorktree;
  const repair = deps.performRepair ?? performPreMergeAutoFix;
  const invokeFn = deps.invoke ?? invoke;

  if (!cfg.harnesses?.implementer) {
    return {
      succeeded: false,
      evidence: "no implementer harness configured for mechanical repair",
      error: "no implementer harness configured",
    };
  }

  let wt = await getWorktree(cfg, candidate.issueNumber);
  if (!wt) {
    const materialized = await ensureWorktree(cfg, candidate.issueNumber);
    if (materialized.result === "fail" || !materialized.worktree) {
      const detail =
        materialized.result === "fail"
          ? materialized.reason
          : "worktree rematerialization did not return a worktree";
      return {
        succeeded: false,
        evidence: `managed worktree unavailable: ${detail}`,
        error: detail,
      };
    }
    wt = { path: materialized.worktree.path, slug: materialized.worktree.slug };
  }

  const runId = `merge-queue-repair-pr-${candidate.prNumber}`;
  const doRepair = async () =>
    repair(
      cfg,
      candidate.issueNumber,
      runId,
      prompt,
      candidate.title,
      wt,
      git,
      invokeFn,
      undefined,
      {
        commitSubjectPrefix: `fix: merge-queue surgical repair`,
        salvageLabel: "merge-queue surgical repair",
      },
    );

  const toMechanical = (
    result: Awaited<ReturnType<typeof repair>>,
    integrityTag?: string,
  ): MechanicalRepairResult => {
    const tag = integrityTag ? ` ${integrityTag}` : "";
    if (result.status === "fix-committed") {
      return {
        succeeded: true,
        headSha: result.headSha,
        evidence: `shared mechanical repair pushed ${result.headSha}${tag}`,
      };
    }
    if (result.status === "noop-clean") {
      return {
        succeeded: false,
        headSha: result.headSha,
        evidence: `${result.diagnostic ?? "mechanical repair left clean no-op"}${tag}`,
        error: result.diagnostic ?? "noop-clean",
      };
    }
    return {
      succeeded: false,
      evidence: `mechanical repair status=${result.status}${tag}`,
      error: `mechanical repair status=${result.status}`,
    };
  };

  // #857: wrap mechanical repair head movement in candidate-integrity.
  const storeRoot =
    deps.integrity?.storeRoot ??
    (cfg.repo_dir
      ? mergeQueueIntegrityStoreRoot(cfg.repo_dir, candidate.issueNumber, candidate.prNumber)
      : undefined);
  const base = cfg.base_branch;
  if (!deps.integrity?.skip && storeRoot && base) {
    const branch = branchName(candidate.issueNumber, wt.slug);
    const subject = deps.integrity?.subject ?? {
      run_id: path.basename(storeRoot),
      issue: candidate.issueNumber,
      pr: candidate.prNumber,
    };
    const integrityResult = await runCoveredCandidateMutation(
      {
        storeRoot,
        subject,
        mutation_method: "conflict_repair",
        base_ref: base,
        worktreePath: wt.path,
        gitInWorktree: git,
        resolveBaseSha: async () => {
          const r = await git(wt.path, ["rev-parse", `origin/${base}`], {
            ignoreFailure: true,
          });
          return r.code === 0 ? r.stdout.trim() || null : null;
        },
        resolveCandidateSha: async () => {
          const remote = await git(
            wt.path,
            ["rev-parse", `refs/remotes/origin/${branch}`],
            { ignoreFailure: true },
          );
          if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim();
          const local = await git(wt.path, ["rev-parse", "HEAD"], {
            ignoreFailure: true,
          });
          return local.code === 0 ? local.stdout.trim() || null : null;
        },
        emitEvent: deps.integrity?.emitEvent ?? (async (event) => {
          await appendEvent(storeRoot, event as never, defaultRunStoreDeps).catch(() => {});
        }),
        storeDeps: deps.integrity?.storeDeps,
        mutation_id: deps.integrity?.mutation_id,
      },
      doRepair,
    );

    if (integrityResult.aborted) {
      return {
        succeeded: false,
        evidence: `mechanical repair aborted by candidate-integrity: ${integrityResult.abort_reason ?? "pre-persist failed"}`,
        error: integrityResult.abort_reason ?? "integrity pre-persist failed",
      };
    }

    const repairResult = integrityResult.mutation_result;
    if (!repairResult) {
      return {
        succeeded: false,
        evidence: `mechanical repair incomplete under integrity: ${integrityResult.mutation_error ?? "unknown"}`,
        error: integrityResult.mutation_error ?? "mutation incomplete",
      };
    }

    const tag = `[candidate-integrity:${integrityResult.classification}${
      integrityResult.disposition.merge_eligible ? "" : ";not-merge-eligible"
    }]`;
    const out = toMechanical(repairResult, tag);
    // Scope expansion / unverified must not be merge-eligible success.
    if (
      integrityResult.classification === "scope_expansion" ||
      integrityResult.classification === "unverified"
    ) {
      return {
        ...out,
        succeeded: false,
        error:
          out.error ??
          `candidate-integrity ${integrityResult.classification}`,
      };
    }
    return out;
  }

  return toMechanical(await doRepair());
}

export function realMergeQueueDeps(
  repoDir: string,
  repo: string,
  mergeDeps?: MergeDeps,
  /** Required for production mechanical repair (managed worktree + implementer). */
  cfg?: PipelineConfig,
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
      // Prefer local managed-worktree README for landing-page fail-closed (#855)
      // so post-restack / post-repair heads with a monolithic README are not
      // re-gate eligible before CI re-runs docs:check.
      const readmeContent = cfg
        ? readManagedWorktreeReadme(candidate.issueNumber, cfg)
        : null;
      return evaluateCandidateEligibility(candidate, plan, md, {
        readmeContent,
      });
    },

    // Deterministic-first: checks re-query; conflicts attempt clean rebase/restack
    // onto the integration base in the managed worktree before mechanical repair.
    async attemptDeterministicRepair(candidate, reason, snapshot) {
      if (reason === "checks-failed") {
        // Re-query settled check state (no second poller loop — one re-read).
        const readmeContent = cfg
          ? readManagedWorktreeReadme(candidate.issueNumber, cfg)
          : null;
        const snap = await evaluateCandidateEligibility(candidate, plan, md, {
          readmeContent,
        });
        return {
          changed: false,
          headSha: snap.headRefOid,
          evidence: snap.checksOk
            ? "checks re-query: non-blocking"
            : `checks re-query still blocking: ${snap.checksDetail ?? "unknown"}`,
        };
      }
      // Conflict: managed-worktree clean rebase/restack first (does not charge
      // implementer budget). Falls back to mergeability re-query only when cfg
      // is unavailable so worktree ops cannot run.
      // Thread eligibility snapshot head so force-with-lease is bound to the
      // inspected PR tip (never an unbound lease on a floating tracking ref).
      if (cfg) {
        return runDeterministicConflictRebase(
          candidate,
          cfg,
          {},
          snapshot.headRefOid,
        );
      }
      const snap = await evaluateCandidateEligibility(candidate, plan, md);
      return {
        changed: false,
        headSha: snap.headRefOid,
        evidence: isMergeableClean(snap.mergeable, snap.mergeStateStatus)
          ? "mergeability re-query: MERGEABLE/CLEAN (rebase skipped: no PipelineConfig)"
          : `mergeability re-query: mergeable=${snap.mergeable} mergeStateStatus=${snap.mergeStateStatus}; rebase skipped: no PipelineConfig`,
      };
    },

    // Production mechanical repair: shared managed-worktree + performPreMergeAutoFix
    // transaction (same implementer push path as recovery). Manual-repair holds
    // are reserved for budget exhaustion or executor failure after claim.
    async attemptMechanicalRepair(candidate, _reason, _snapshot, prompt) {
      if (!cfg) {
        return {
          succeeded: false,
          evidence:
            "PipelineConfig required for production mechanical repair (pass cfg to realMergeQueueDeps)",
          error: "missing PipelineConfig for mechanical repair",
        };
      }
      return runSharedMechanicalRepair(candidate, prompt, cfg);
    },

    runRelease: (versionArg, opts, releaseCfg) => runRelease(versionArg, opts, releaseCfg),

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
  | { status: "already-done"; summary: string }
> {
  const nowFn = deps.now ?? (() => Date.now());
  let budget: RepairBudgetState | undefined;
  if (opts.repairEnabled) {
    budget = createRepairBudget(opts.repairMaxAttempts, {
      maxWallClockMs: opts.repairMaxWallClockMs,
      nowMs: nowFn(),
    });
  }

  /** Re-evaluate with isolation: dependency failures never escape the item. */
  const reEvaluate = async (): Promise<
    | { ok: true; snapshot: EligibilitySnapshot | null }
    | { ok: false; error: string }
  > => {
    if (!deps.evaluateEligibility) return { ok: true, snapshot: null };
    try {
      const snapshot = await deps.evaluateEligibility(candidate);
      return { ok: true, snapshot };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const freeFormHold = (
    message: string,
    attemptsUsed: number,
    budgetExhausted = false,
  ): MergeQueueHeldItem => ({
    issueNumber: candidate.issueNumber,
    prNumber: candidate.prNumber,
    reason: message,
    summary: message,
    outcome: budgetExhausted ? "manual-repair" : "failed",
    humanAuthority: false,
    repairAttemptsUsed: attemptsUsed,
    remediation:
      `PR #${candidate.prNumber} (issue #${candidate.issueNumber}): ${message}. ` +
      `Inspect the error, fix, then retry merge-queue apply or pipeline merge ${candidate.prNumber}.`,
  });

  const policyHold = (summary: string, attemptsUsed: number): MergeQueueHeldItem => ({
    issueNumber: candidate.issueNumber,
    prNumber: candidate.prNumber,
    reason: summary,
    summary,
    outcome: "held",
    humanAuthority: false,
    repairAttemptsUsed: attemptsUsed,
    remediation:
      `PR #${candidate.prNumber} (issue #${candidate.issueNumber}) is not queue-eligible: ${summary}. ` +
      `Restore pipeline:ready-to-deploy on the linked issue (and keep the PR open) before retrying.`,
  });

  /**
   * Apply full queue gates (open + R2D + conflict/checks). Returns merge-ready
   * only when every known gate passes; never calls mergePr itself.
   */
  const applyQueueGates = (
    snap: EligibilitySnapshot | null,
    fallbackReason: MergeQueueHoldReason | null,
    fallbackSummary: string,
  ):
    | { status: "eligible" }
    | { status: "already-done"; summary: string }
    | { status: "policy"; summary: string }
    | {
        status: "ineligible";
        reason: MergeQueueHoldReason;
        snapshot: EligibilitySnapshot | null;
        summary: string;
      } => {
    if (!snap) {
      if (fallbackReason) {
        return {
          status: "ineligible",
          reason: fallbackReason,
          snapshot: null,
          summary: fallbackSummary,
        };
      }
      return { status: "eligible" };
    }
    const gate = classifyQueueEligibility(snap);
    if (gate.kind === "eligible") return { status: "eligible" };
    if (gate.kind === "already-done") {
      return { status: "already-done", summary: gate.summary };
    }
    if (gate.kind === "policy") {
      return { status: "policy", summary: gate.summary };
    }
    return {
      status: "ineligible",
      reason: gate.reason,
      snapshot: snap,
      summary: snapshotSummary(gate.reason, snap),
    };
  };

  let evalResult = await reEvaluate();
  if (!evalResult.ok) {
    // Preflight failure: hold this item and let the outer loop continue.
    return {
      status: "held",
      hold: freeFormHold(`eligibility preflight failed: ${evalResult.error}`, 0),
    };
  }

  let snapshot = evalResult.snapshot;
  let reason: MergeQueueHoldReason | null = null;
  let summary = "";
  let attemptsUsed = 0;

  // Eligible path (or no evaluator): attempt merge; classify throw if needed.
  const attemptMergeOnce = async (): Promise<
    | { status: "merged" }
    | { status: "held"; hold: MergeQueueHeldItem }
    | { status: "already-done"; summary: string }
    | {
        status: "ineligible";
        reason: MergeQueueHoldReason;
        snapshot: EligibilitySnapshot | null;
        summary: string;
      }
  > => {
    const gates = applyQueueGates(snapshot, null, "");
    if (gates.status === "already-done") return gates;
    if (gates.status === "policy") {
      return { status: "held", hold: policyHold(gates.summary, attemptsUsed) };
    }
    if (gates.status === "ineligible") return gates;

    const mergeResult = await tryMerge(candidate, deps);
    if (mergeResult.ok) return { status: "merged" };

    const fromErr = classifyFromMergeError(mergeResult.error);
    if (fromErr) {
      // Refresh snapshot if we can so re-gate/repair have current evidence.
      const refreshed = await reEvaluate();
      if (refreshed.ok) {
        snapshot = refreshed.snapshot ?? snapshot;
      }
      if (snapshot) {
        const gate = classifyQueueEligibility(snapshot);
        if (gate.kind === "already-done") {
          return { status: "already-done", summary: gate.summary };
        }
        if (gate.kind === "policy") {
          return { status: "held", hold: policyHold(gate.summary, attemptsUsed) };
        }
        if (gate.kind === "hold") {
          return {
            status: "ineligible",
            reason: gate.reason,
            snapshot,
            summary: snapshotSummary(gate.reason, snapshot),
          };
        }
        // Snapshot looks eligible but merge threw a classifiable error — trust error.
        return {
          status: "ineligible",
          reason: fromErr,
          snapshot,
          summary: mergeResult.error,
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
      hold: freeFormHold(mergeResult.error, attemptsUsed),
    };
  };

  let first = await attemptMergeOnce();
  if (first.status === "merged") return { status: "merged" };
  if (first.status === "held") return first;
  if (first.status === "already-done") return first;

  // Ineligible: optional repair ladder, else hold.
  reason = first.reason;
  snapshot = first.snapshot;
  summary = first.summary;

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
      let detEvidence = "deterministic repair";
      try {
        const det = await deps.attemptDeterministicRepair(
          candidate,
          reason!,
          snapshot,
        );
        detEvidence = det.evidence;
        deps.log(`[merge-queue] deterministic: ${det.evidence}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        detEvidence = `deterministic repair failed: ${msg}`;
        deps.log(`[merge-queue] deterministic failed (hold-and-continue path): ${msg}`);
        // Keep prior reason; fall through to mechanical / budget gates.
      }

      // Always re-gate after deterministic path (even re-query only).
      const afterDet = await reEvaluate();
      if (!afterDet.ok) {
        return {
          status: "held",
          hold: freeFormHold(
            `post-deterministic re-gate failed: ${afterDet.error}; last: ${detEvidence}`,
            attemptsUsed,
          ),
        };
      }
      snapshot = afterDet.snapshot ?? snapshot;
      if (snapshot) {
        const gates = applyQueueGates(snapshot, reason, summary);
        if (gates.status === "already-done") return gates;
        if (gates.status === "policy") {
          return { status: "held", hold: policyHold(gates.summary, attemptsUsed) };
        }
        if (gates.status === "ineligible") {
          reason = gates.reason;
          summary = gates.summary;
          snapshot = gates.snapshot ?? snapshot;
        } else {
          // Re-eligible — merge via existing surface only.
          const mergeResult = await tryMerge(candidate, deps);
          if (mergeResult.ok) return { status: "merged" };
          const fromErr = classifyFromMergeError(mergeResult.error);
          if (fromErr) {
            reason = fromErr;
            summary = mergeResult.error;
            const refreshed = await reEvaluate();
            if (refreshed.ok) snapshot = refreshed.snapshot ?? snapshot;
          } else {
            return {
              status: "held",
              hold: freeFormHold(mergeResult.error, attemptsUsed),
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

    let mech: MechanicalRepairResult;
    try {
      mech = await deps.attemptMechanicalRepair(
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
    } catch (err) {
      // Claimed attempt is charged on failure/timeout/rejection.
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`[merge-queue] mechanical repair rejected: ${msg}`);
      mech = {
        succeeded: false,
        evidence: `mechanical repair threw: ${msg}`,
        error: msg,
      };
    }
    deps.log(
      `[merge-queue] mechanical repair: succeeded=${mech.succeeded} ${mech.evidence}`,
    );

    // Mandatory re-gate after candidate-moving repair (or any mechanical attempt).
    const afterMech = await reEvaluate();
    if (!afterMech.ok) {
      return {
        status: "held",
        hold: freeFormHold(
          `post-repair re-gate failed: ${afterMech.error}; repair: ${mech.evidence}`,
          attemptsUsed,
          !canAttemptRepair(budget, nowFn()),
        ),
      };
    }
    snapshot = afterMech.snapshot ?? snapshot;
    if (snapshot) {
      const gates = applyQueueGates(snapshot, reason, summary);
      if (gates.status === "already-done") return gates;
      if (gates.status === "policy") {
        return { status: "held", hold: policyHold(gates.summary, attemptsUsed) };
      }
      if (gates.status === "eligible") {
        const mergeResult = await tryMerge(candidate, deps);
        if (mergeResult.ok) return { status: "merged" };
        const fromErr = classifyFromMergeError(mergeResult.error);
        if (fromErr) {
          reason = fromErr;
          summary = mergeResult.error;
        } else {
          return {
            status: "held",
            hold: freeFormHold(mergeResult.error, attemptsUsed),
          };
        }
      } else {
        reason = gates.reason;
        summary = gates.summary;
        snapshot = gates.snapshot ?? snapshot;
      }
    } else if (!mech.succeeded) {
      summary = mech.error ?? mech.evidence ?? summary;
    }

    // Loop: if still ineligible, continue while budget remains.
    if (!reason) {
      // No snapshot and merge didn't run — hold.
      return {
        status: "held",
        hold: makeHold(!canAttemptRepair(budget, nowFn())),
      };
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
      } else if (outcome.status === "already-done") {
        // PR no longer open (merged/closed) after selection or repair — not held.
        deps.log(
          `[merge-queue] already-done issue #${c.issueNumber} PR #${c.prNumber}` +
            ` — ${outcome.summary}`,
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
