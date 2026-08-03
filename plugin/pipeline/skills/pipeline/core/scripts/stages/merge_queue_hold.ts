// Pure merge-queue hold / repair-budget helpers (#675).
//
// Typed holds for human-gated merge-queue drive when a candidate is
// non-mergeable (conflict/dirty) or has blocking required checks. Optional
// surgical repair is opt-in elsewhere; this module stays pure and injectable.
//
// #855: post-repair / restack re-gate also fails closed when a candidate head's
// root README violates the docs-landing-split landing-page contract (large
// unrelated monolith). That is a checks-class hold, not a new merge-authority
// or review-policy change.

import {
  checkReadmeLandingContract,
  formatReadmeLandingDiagnostics,
} from "../readme-landing-contract.ts";

// ---------------------------------------------------------------------------
// Hold vocabulary
// ---------------------------------------------------------------------------

/** Stable operator-facing hold reason codes (not a second recovery taxonomy). */
export type MergeQueueHoldReason = "merge-conflict" | "checks-failed";

export const MERGE_QUEUE_HOLD_REASONS: readonly MergeQueueHoldReason[] = [
  "merge-conflict",
  "checks-failed",
] as const;

/**
 * Eligibility snapshot used to classify hold reasons before merge.
 * Checks gate is pre-evaluated (same policy as merge / dry-run selection).
 * Optional open/R2D fields are set by production re-gate so post-repair merge
 * never proceeds when the PR left the queue policy set.
 */
export interface EligibilitySnapshot {
  mergeable: string;
  mergeStateStatus: string;
  /** True when required/observable checks are non-blocking under merge policy. */
  checksOk: boolean;
  /** Blocking-check summary when checksOk is false. */
  checksDetail?: string;
  headRefOid?: string;
  /**
   * PR state from `gh pr view` when known (`OPEN` / `CLOSED` / `MERGED`).
   * Omitted in unit fixtures that only exercise mergeability/checks.
   */
  prState?: string;
  /**
   * Whether the linked issue currently has `pipeline:ready-to-deploy`.
   * Omitted in unit fixtures that only exercise mergeability/checks.
   */
  issueHasR2d?: boolean;
}

export interface CreateHoldInput {
  issueNumber: number;
  prNumber: number;
  reason: MergeQueueHoldReason;
  summary: string;
  headSha?: string;
  repairAttemptsUsed?: number;
  /** When true, budget exhausted without restoring eligibility. */
  budgetExhausted?: boolean;
}

/**
 * Full hold record for drive results and release-when-complete completeness.
 * `reason` is the typed code; remediation is operator-visible next steps.
 */
export interface MergeQueueHoldRecord {
  issueNumber: number;
  prNumber: number;
  reason: MergeQueueHoldReason;
  summary: string;
  headSha?: string;
  repairAttemptsUsed: number;
  remediation: string;
  /**
   * Queue outcome for completeness. Mechanical budget exhaustion is
   * `manual-repair` — never human-authority solely due to exhaustion.
   */
  outcome: "held" | "manual-repair";
  /** Always false for mechanical/engine holds from this path. */
  humanAuthority: false;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * True when merge graph is not MERGEABLE+CLEAN (conflict, dirty, behind, etc.).
 * Conflict-class remediation (rebase/restack) applies before check meaning on a
 * restacked head is reliable.
 */
export function isConflictOrDirtyMergeState(
  mergeable: string,
  mergeStateStatus: string,
): boolean {
  const m = (mergeable ?? "").toUpperCase();
  const s = (mergeStateStatus ?? "").toUpperCase();
  if (m === "MERGEABLE" && s === "CLEAN") return false;
  // UNKNOWN is not yet a hard conflict hold in isolation — caller may wait —
  // but for queue drive we treat any non-clean as conflict-class so we never
  // force-merge. UNKNOWN still maps to merge-conflict for hold reporting.
  return true;
}

/**
 * Classify eligibility into a typed hold reason, or null when mergeability +
 * checks alone look mergeable. Callers that re-gate after repair MUST also use
 * {@link classifyQueueEligibility} (open PR + linked R2D) before merge.
 * Conflict wins when both conflict/dirty and checks fail.
 */
export function classifyEligibility(
  snapshot: EligibilitySnapshot,
): MergeQueueHoldReason | null {
  if (isConflictOrDirtyMergeState(snapshot.mergeable, snapshot.mergeStateStatus)) {
    return "merge-conflict";
  }
  if (!snapshot.checksOk) {
    return "checks-failed";
  }
  return null;
}

/**
 * Full queue re-gate: PR open policy, linked-issue R2D policy, then conflict/checks.
 * Used before every post-repair (and production preflight) merge attempt.
 *
 * - `already-done`: PR is MERGED (or closed and no longer open) — do not merge or hold as conflict.
 * - `policy`: open PR but linked issue lost R2D — hold free-form / not mergeable via queue policy.
 * - `hold`: typed conflict or checks-failed.
 * - `eligible`: all known gates pass (unknown open/R2D fields do not block for fixture compat).
 */
export type QueueEligibilityClass =
  | { kind: "eligible" }
  | { kind: "already-done"; summary: string }
  | { kind: "policy"; summary: string }
  | { kind: "hold"; reason: MergeQueueHoldReason };

export function classifyQueueEligibility(
  snapshot: EligibilitySnapshot,
): QueueEligibilityClass {
  if (snapshot.prState != null) {
    const state = snapshot.prState.toUpperCase();
    if (state === "MERGED") {
      return { kind: "already-done", summary: `PR state is ${snapshot.prState}` };
    }
    if (state !== "OPEN") {
      // CLOSED without MERGED (or other non-open): already out of the queue.
      return {
        kind: "already-done",
        summary: `PR is not open (state=${snapshot.prState})`,
      };
    }
  }
  if (snapshot.issueHasR2d === false) {
    return {
      kind: "policy",
      summary:
        "linked issue no longer has pipeline:ready-to-deploy; queue policy forbids merge",
    };
  }
  const hold = classifyEligibility(snapshot);
  if (hold) return { kind: "hold", reason: hold };
  return { kind: "eligible" };
}

/**
 * Apply the README landing-page contract to an eligibility snapshot (#855).
 *
 * When `readmeContent` is null/undefined (no local head material available),
 * the snapshot is returned unchanged — callers still rely on CI docs:check
 * once the head is pushed. When content is supplied and violates the
 * docs-landing-split contract (including a #793-class monolithic append),
 * force `checksOk: false` with diagnostics that name the README / landing-page
 * breach so re-gate classifies as checks-failed and never merge-eligible.
 *
 * Pure — no I/O. Does not invent new hold reason codes or change merge authority.
 */
export function applyReadmeLandingContractGate(
  snapshot: EligibilitySnapshot,
  readmeContent: string | null | undefined,
): EligibilitySnapshot {
  if (readmeContent == null) return snapshot;
  const result = checkReadmeLandingContract(readmeContent);
  if (result.ok) return snapshot;
  const detail = formatReadmeLandingDiagnostics(result);
  return {
    ...snapshot,
    checksOk: false,
    checksDetail: snapshot.checksDetail
      ? `${snapshot.checksDetail}; ${detail}`
      : detail,
  };
}

/**
 * Best-effort classification from a `mergePr` / merge-surface error message
 * when no live eligibility snapshot is available.
 */
export function classifyFromMergeError(message: string): MergeQueueHoldReason | null {
  const text = message.toLowerCase();
  // Conflict / dirty / behind / non-mergeable graph first (wins over checks).
  if (
    text.includes("conflicting") ||
    text.includes("merge conflict") ||
    text.includes("merge conflicts") ||
    text.includes("mergestatestatus is dirty") ||
    text.includes("merge state is dirty") ||
    text.includes("dirty") ||
    text.includes("behind") ||
    text.includes("cannot be merged") ||
    text.includes("not yet computed") ||
    text.includes("mergeable is unknown")
  ) {
    // If the only dirty mention is inside a checks message, still prefer
    // checks when the error is clearly about status checks.
    if (
      (text.includes("required check") || text.includes("observable check")) &&
      !text.includes("conflicting") &&
      !text.includes("merge conflict") &&
      !text.includes("behind") &&
      !text.includes("dirty")
    ) {
      return "checks-failed";
    }
    return "merge-conflict";
  }
  if (
    text.includes("required check") ||
    text.includes("observable check") ||
    text.includes("checks are not all green") ||
    text.includes("failing or pending")
  ) {
    return "checks-failed";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Remediation text + hold factory
// ---------------------------------------------------------------------------

export function buildHoldRemediation(input: {
  reason: MergeQueueHoldReason;
  prNumber: number;
  issueNumber?: number;
  summary?: string;
  budgetExhausted?: boolean;
}): string {
  const pr = `PR #${input.prNumber}`;
  const issue =
    input.issueNumber != null && input.issueNumber > 0
      ? `issue #${input.issueNumber}`
      : null;
  const subject = issue ? `${pr} (linked ${issue})` : pr;
  const evidence = input.summary?.trim() ? ` Evidence: ${input.summary.trim()}.` : "";

  if (input.reason === "merge-conflict") {
    const budgetNote = input.budgetExhausted
      ? " Repair budget is exhausted for this drive;"
      : "";
    return (
      `${subject} is held for merge-conflict.${evidence}` +
      `${budgetNote} Resolve merge conflicts (rebase/restack onto the integration base), ` +
      `optionally re-run \`pipeline merge-queue --milestone … --apply --repair\`, ` +
      `then retry merge-queue apply or \`pipeline merge ${input.prNumber}\` after the PR is MERGEABLE/CLEAN.`
    );
  }

  // checks-failed
  const budgetNote = input.budgetExhausted
    ? " Repair budget is exhausted for this drive;"
    : "";
  return (
    `${subject} is held for checks-failed.${evidence}` +
    `${budgetNote} Fix or wait for blocking checks to pass, ` +
    `optionally re-run with \`--apply --repair\` if a surgical CI fix is needed, ` +
    `then retry merge-queue apply or \`pipeline merge ${input.prNumber}\`.`
  );
}

export function createHold(input: CreateHoldInput): MergeQueueHoldRecord {
  const repairAttemptsUsed = input.repairAttemptsUsed ?? 0;
  const budgetExhausted = input.budgetExhausted === true;
  return {
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    reason: input.reason,
    summary: input.summary,
    headSha: input.headSha,
    repairAttemptsUsed,
    remediation: buildHoldRemediation({
      reason: input.reason,
      prNumber: input.prNumber,
      issueNumber: input.issueNumber,
      summary: input.summary,
      budgetExhausted,
    }),
    outcome: budgetExhausted ? "manual-repair" : "held",
    humanAuthority: false,
  };
}

// ---------------------------------------------------------------------------
// Repair budget (pure)
// ---------------------------------------------------------------------------

export interface RepairBudget {
  /** Max charged implementer/mechanical repair attempts per item per drive. */
  maxAttempts: number;
  /** Optional wall-clock deadline (epoch ms). */
  deadlineMs?: number;
}

export interface RepairBudgetState {
  budget: RepairBudget;
  attemptsUsed: number;
  /** Epoch ms when the item's repair window started (for wall-clock). */
  startedAtMs: number;
}

export function createRepairBudget(
  maxAttempts: number,
  opts?: { maxWallClockMs?: number; nowMs?: number },
): RepairBudgetState {
  const attempts = Number.isFinite(maxAttempts) && maxAttempts >= 0
    ? Math.floor(maxAttempts)
    : 0;
  const now = opts?.nowMs ?? 0;
  const wall = opts?.maxWallClockMs;
  return {
    budget: {
      maxAttempts: attempts,
      deadlineMs:
        wall != null && Number.isFinite(wall) && wall > 0
          ? now + wall
          : undefined,
    },
    attemptsUsed: 0,
    startedAtMs: now,
  };
}

/**
 * True when another implementer repair may be claimed.
 * Deterministic preflight does not use this gate for charging.
 */
export function canAttemptRepair(
  state: RepairBudgetState,
  nowMs: number,
): boolean {
  if (state.attemptsUsed >= state.budget.maxAttempts) return false;
  if (state.budget.deadlineMs != null && nowMs >= state.budget.deadlineMs) {
    return false;
  }
  return true;
}

/**
 * Claim one implementer repair attempt (charge before side effects).
 * Returns the next state; does not mutate the input.
 */
export function claimRepairAttempt(state: RepairBudgetState): RepairBudgetState {
  return {
    ...state,
    attemptsUsed: state.attemptsUsed + 1,
  };
}

export function isBudgetExhausted(
  state: RepairBudgetState,
  nowMs: number,
): boolean {
  return !canAttemptRepair(state, nowMs);
}

// ---------------------------------------------------------------------------
// Surgical repair prompt (pure)
// ---------------------------------------------------------------------------

export function buildSurgicalRepairPrompt(input: {
  reason: MergeQueueHoldReason;
  prNumber: number;
  issueNumber?: number;
  summary?: string;
  headSha?: string;
}): string {
  const issue =
    input.issueNumber != null && input.issueNumber > 0
      ? `issue #${input.issueNumber}`
      : "the linked pipeline issue";
  const head = input.headSha ? ` Current head: ${input.headSha}.` : "";
  const evidence = input.summary?.trim()
    ? `\n\nEvidence:\n${input.summary.trim()}`
    : "";

  const goal =
    input.reason === "merge-conflict"
      ? "Resolve merge conflicts so the PR is MERGEABLE with mergeStateStatus CLEAN against the integration base."
      : "Fix the blocking CI/required-check failures so required checks pass (or are non-blocking under branch policy).";

  return [
    `## Merge-queue surgical repair (PR #${input.prNumber}, ${issue})`,
    "",
    "You are performing a **bounded surgical repair** for the human-gated merge queue.",
    goal + head,
    evidence,
    "",
    "### Surgical-fix discipline (mandatory)",
    "- Make the **minimal diff** that resolves only the merge conflict or blocking CI failure.",
    "- **Do not** refactor, add features, rename for style, or perform opportunistic cleanup.",
    "- **Do not** weaken tests, review policy, gates, or requirements to go green.",
    "- **Do not** restore a monolithic root `README.md` or other large unrelated documentation delta during conflict resolution or restack — the landing-page contract (lean README, companion links) is fail-closed on re-gate.",
    "- **Do not** squash-merge or otherwise merge the PR — push the repair only; merge is operator/queue-gated after re-validation.",
    "- Destructive git operations (force-push, worktree remove, branch delete) are allowed only when scoped to this managed worktree / this PR head, with explicit justification.",
    "",
    "### After the fix",
    "- Commit and push to the PR head branch.",
    "- Leave the worktree clean of unrelated changes.",
  ].join("\n");
}
