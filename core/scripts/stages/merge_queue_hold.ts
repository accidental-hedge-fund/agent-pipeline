// Merge-queue hold + surgical repair model (#675).
//
// When sequential drive hits merge conflicts or blocking required checks, the
// queue records a per-item hold (never force-merges), continues remaining
// candidates by default, and optionally attempts a budget-bounded surgical
// repair in the managed worktree before re-gating and retrying mergePr.
//
// Pure constructors and classifiers live here so unit tests need no network,
// git, or subprocess. Drive orchestration is in merge_queue_drive.ts.

import { isMergeableClean } from "./merge_queue.ts";

// ---------------------------------------------------------------------------
// Hold reason vocabulary (stable machine keys)
// ---------------------------------------------------------------------------

/** Closed set of hold reasons required by merge-queue-repair-hold. */
export type MergeQueueHoldReason = "merge-conflict" | "checks-failed";

export const HOLD_REASON_MERGE_CONFLICT: MergeQueueHoldReason = "merge-conflict";
export const HOLD_REASON_CHECKS_FAILED: MergeQueueHoldReason = "checks-failed";

/** Default max automatic repair attempts per item within one drive session. */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;

// ---------------------------------------------------------------------------
// Hold record
// ---------------------------------------------------------------------------

export interface MergeQueueHold {
  prNumber: number;
  issueNumber: number;
  reason: MergeQueueHoldReason;
  /** Operator-visible next steps naming the PR (and issue when known). */
  remediation: string;
  /** Automatic repair attempts already spent this drive session. */
  repairAttempts: number;
  /** Head SHA observed when the hold was recorded (when known). */
  lastHeadSha: string | null;
  /** Conflict or checks summary for evidence. */
  summary: string;
}

export interface CreateHoldArgs {
  prNumber: number;
  issueNumber: number;
  reason: MergeQueueHoldReason;
  summary: string;
  lastHeadSha?: string | null;
  repairAttempts?: number;
  /** Override remediation; default builds from reason. */
  remediation?: string;
}

/** Pure constructor for a hold record with default remediation text. */
export function createHold(args: CreateHoldArgs): MergeQueueHold {
  const lastHeadSha = args.lastHeadSha ?? null;
  const repairAttempts = args.repairAttempts ?? 0;
  const remediation =
    args.remediation ??
    buildHoldRemediation({
      reason: args.reason,
      prNumber: args.prNumber,
      issueNumber: args.issueNumber,
      summary: args.summary,
      repairAttempts,
      lastHeadSha,
    });
  return {
    prNumber: args.prNumber,
    issueNumber: args.issueNumber,
    reason: args.reason,
    remediation,
    repairAttempts,
    lastHeadSha,
    summary: args.summary,
  };
}

// ---------------------------------------------------------------------------
// Remediation text
// ---------------------------------------------------------------------------

export interface HoldRemediationArgs {
  reason: MergeQueueHoldReason;
  prNumber: number;
  issueNumber: number;
  summary: string;
  repairAttempts?: number;
  lastHeadSha?: string | null;
}

/**
 * Operator-visible remediation for a hold. Names PR + issue and states
 * concrete next steps (manual fix/repair, re-run drive or pipeline merge).
 */
export function buildHoldRemediation(args: HoldRemediationArgs): string {
  const issuePart =
    args.issueNumber > 0 ? ` (linked issue #${args.issueNumber})` : "";
  const shaPart = args.lastHeadSha ? ` head=${args.lastHeadSha}` : "";
  const attemptsPart =
    typeof args.repairAttempts === "number" && args.repairAttempts > 0
      ? ` repair_attempts=${args.repairAttempts}`
      : "";

  if (args.reason === HOLD_REASON_MERGE_CONFLICT) {
    return (
      `Hold merge-conflict: PR #${args.prNumber}${issuePart} is not mergeable ` +
      `(${args.summary}${shaPart}${attemptsPart}). ` +
      `Resolve conflicts on the PR branch (manual rebase/merge or re-run with ` +
      `--repair), push, then re-run \`pipeline merge-queue --apply\` or ` +
      `\`pipeline merge ${args.prNumber}\`.`
    );
  }

  // checks-failed
  return (
    `Hold checks-failed: PR #${args.prNumber}${issuePart} has blocking required ` +
    `checks (${args.summary}${shaPart}${attemptsPart}). ` +
    `Fix or wait for required checks on the head SHA, optionally re-run with ` +
    `--repair for a surgical CI-only fix, then re-run ` +
    `\`pipeline merge-queue --apply\` or \`pipeline merge ${args.prNumber}\`.`
  );
}

// ---------------------------------------------------------------------------
// Eligibility classification (pure)
// ---------------------------------------------------------------------------

export interface EligibilitySnapshot {
  /** mergeable field from gh pr view */
  mergeable: string;
  /** mergeStateStatus from gh pr view */
  mergeStateStatus: string;
  /** When true, required (or fallback) checks are non-blocking. */
  checksOk: boolean;
  /** Human summary of checks state (green or blocking detail). */
  checksSummary: string;
  headRefOid?: string | null;
}

export type EligibilityClassification =
  | { kind: "eligible" }
  | {
      kind: "hold";
      reason: MergeQueueHoldReason;
      summary: string;
    };

/**
 * Classify drive eligibility from mergeability + checks snapshot.
 * Conflict/dirty merge state → merge-conflict hold.
 * Blocking required checks → checks-failed hold.
 * Both clean → eligible.
 *
 * When both conflict and checks fail, merge-conflict wins (must fix merge
 * graph before checks on a restacked head are meaningful).
 */
export function classifyEligibility(
  snap: EligibilitySnapshot,
): EligibilityClassification {
  if (!isMergeableClean(snap.mergeable, snap.mergeStateStatus)) {
    return {
      kind: "hold",
      reason: HOLD_REASON_MERGE_CONFLICT,
      summary: `mergeable=${snap.mergeable} mergeStateStatus=${snap.mergeStateStatus}`,
    };
  }
  if (!snap.checksOk) {
    return {
      kind: "hold",
      reason: HOLD_REASON_CHECKS_FAILED,
      summary: snap.checksSummary || "required checks blocking",
    };
  }
  return { kind: "eligible" };
}

// ---------------------------------------------------------------------------
// Repair budget (pure)
// ---------------------------------------------------------------------------

export interface RepairBudget {
  maxAttempts: number;
  /** Wall-clock deadline (ms since epoch) for repair-related work; null = none. */
  deadlineMs: number | null;
}

export function createRepairBudget(opts: {
  maxAttempts?: number;
  /** Optional max wall-clock for repair-related waiting (ms). */
  maxWallClockMs?: number | null;
  nowMs?: number;
}): RepairBudget {
  const maxAttempts =
    typeof opts.maxAttempts === "number" && Number.isFinite(opts.maxAttempts)
      ? Math.max(0, Math.floor(opts.maxAttempts))
      : DEFAULT_MAX_REPAIR_ATTEMPTS;
  const maxWall =
    typeof opts.maxWallClockMs === "number" && Number.isFinite(opts.maxWallClockMs)
      ? Math.max(0, opts.maxWallClockMs)
      : null;
  const now = opts.nowMs ?? Date.now();
  return {
    maxAttempts,
    deadlineMs: maxWall !== null ? now + maxWall : null,
  };
}

/**
 * Whether another automatic repair may start for this item.
 * Zero maxAttempts or exhausted attempts → false.
 * Past wall-clock deadline → false.
 */
export function canAttemptRepair(
  attemptsUsed: number,
  budget: RepairBudget,
  nowMs: number = Date.now(),
): boolean {
  if (budget.maxAttempts <= 0) return false;
  if (attemptsUsed >= budget.maxAttempts) return false;
  if (budget.deadlineMs !== null && nowMs >= budget.deadlineMs) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Surgical repair prompt (pure string)
// ---------------------------------------------------------------------------

export interface RepairPromptArgs {
  prNumber: number;
  issueNumber: number;
  reason: MergeQueueHoldReason;
  summary: string;
  worktreePath: string;
  lastHeadSha?: string | null;
}

/**
 * Build a repair harness prompt constrained to surgical-fix discipline for
 * merge-conflict or checks-failed holds only — no feature work or refactors.
 */
export function buildMergeQueueRepairPrompt(args: RepairPromptArgs): string {
  const cause =
    args.reason === HOLD_REASON_MERGE_CONFLICT
      ? "merge conflicts / non-mergeable PR state"
      : "blocking required checks (fail/pending/cancel)";
  const shaLine = args.lastHeadSha
    ? `Observed head SHA: ${args.lastHeadSha}`
    : "Observed head SHA: (unknown)";

  return [
    `You are performing a merge-queue surgical repair for issue #${args.issueNumber}, PR #${args.prNumber}.`,
    ``,
    `Hold reason: ${args.reason}`,
    `Cause: ${cause}`,
    `Evidence: ${args.summary}`,
    shaLine,
    `Managed worktree (only path you may edit): ${args.worktreePath}`,
    ``,
    `## Surgical Fix Discipline (required)`,
    ``,
    `Make the **minimal diff** that resolves the ${cause} only — nothing more.`,
    ``,
    `- Do NOT refactor, rename, or restructure code beyond what conflict/CI resolution requires.`,
    `- Do NOT broaden scope to feature work, related-but-unflagged areas, or opportunistic cleanup.`,
    `- Do NOT introduce product features under the guise of a conflict or CI fix.`,
    `- Prefer resolving merge conflicts with correct integration of both sides; do not drop intentional work without cause.`,
    `- For CI failures: fix the failing assertion/build/test only.`,
    ``,
    `## Destructive-Operation Guard (required)`,
    ``,
    `Destructive ops (\`git worktree remove --force\`, force-push, branch delete, merge-surface) MUST stay scoped to this managed worktree root and/or the reviewed PR head. Do not force-merge.`,
    ``,
    `## Outcome`,
    ``,
    `Push repair commits to the PR head through normal non-force push (or justified force-with-lease scoped to the reviewed head after rebase). Do NOT squash-merge the PR. After push, stop — the queue re-gates eligibility before any merge.`,
  ].join("\n");
}

/**
 * Classify a mergePr / gate error message into a hold reason when it clearly
 * indicates conflict or required-check failure; otherwise null (hard failure).
 */
export function classifyMergeErrorToHoldReason(
  message: string,
): MergeQueueHoldReason | null {
  const m = message.toLowerCase();
  if (
    m.includes("merge conflict") ||
    m.includes("mergeable: conflicting") ||
    m.includes("mergeable=conflicting") ||
    m.includes("merge state is dirty") ||
    m.includes("mergestatestatus=dirty") ||
    m.includes("merge state is behind") ||
    (m.includes("cannot be merged") && m.includes("mergeable"))
  ) {
    return HOLD_REASON_MERGE_CONFLICT;
  }
  if (
    m.includes("required check") ||
    m.includes("failing or pending") ||
    m.includes("checks:") ||
    m.includes("status check")
  ) {
    return HOLD_REASON_CHECKS_FAILED;
  }
  return null;
}
