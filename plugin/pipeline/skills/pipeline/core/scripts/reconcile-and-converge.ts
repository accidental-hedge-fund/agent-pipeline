// Reconcile-and-converge surfaces (#759).
//
// Pure observation → ordered actions, following the
// `enforceOpenspecActiveChangeGuard` shape: derive true state from
// authoritative sources, repair toward the invariant, fail closed on
// observation failure. Does NOT execute recipes (#761/#787 ownership).
//
// Surfaces:
//  1. Worktree lifecycle (exists/missing/dirty/stale/poisoned-mismatched)
//  2. Review-verdict currency (reuse / re-review / hold inputs)

import type { LocalOnlyCommitResult, RemoveSafetyResult } from "./worktree.ts";
import { evaluateRemoveSafety } from "./worktree.ts";

// ---------------------------------------------------------------------------
// Worktree lifecycle reconcile
// ---------------------------------------------------------------------------

/** Closed action set for worktree lifecycle convergence. */
export type WorktreeReconcileActionKind =
  | "retain"
  | "rematerialize"
  | "recreate"
  | "salvage_then_continue"
  | "refuse_unsafe_remove"
  | "safe_remove_then_recreate"
  | "fail_closed";

export interface WorktreeReconcileAction {
  kind: WorktreeReconcileActionKind;
  reason: string;
  /** When kind implies remove, callers MUST re-check evaluateRemoveSafety. */
  requiresRemoveSafety: boolean;
}

export interface WorktreeObservedState {
  /** Stage requires a managed worktree for this issue. */
  required: boolean;
  /** Managed registration / on-disk record present. */
  managedPresent: boolean;
  /** Path exists on disk. */
  pathExists?: boolean;
  dirty?: boolean;
  localOnly?: LocalOnlyCommitResult;
  /** Branch name currently checked out (or registered). */
  actualBranch?: string | null;
  /** Expected branch for the issue/slug. */
  expectedBranch?: string | null;
  /** HEAD oid of the managed tree when observable. */
  actualHead?: string | null;
  /** Expected candidate head (PR head / candidate identity). */
  expectedHead?: string | null;
  /**
   * Stale relative to desired path/slug (e.g. slug rename) while still
   * managed for the same issue.
   */
  stalePathOrSlug?: boolean;
  /** Observation could not be completed (git/network/auth). */
  observationFailed?: boolean;
  observationError?: string;
  /** Operator force authority for remove decisions. */
  force?: boolean;
}

export interface WorktreeReconcileResult {
  actions: WorktreeReconcileAction[];
  /** True when stages must not proceed on the current tree. */
  blocked: boolean;
  /** Optional remove-safety snapshot when dirty/localOnly were observed. */
  removeSafety?: RemoveSafetyResult;
}

function action(
  kind: WorktreeReconcileActionKind,
  reason: string,
  requiresRemoveSafety = false,
): WorktreeReconcileAction {
  return { kind, reason, requiresRemoveSafety };
}

/**
 * Pure worktree lifecycle reconcile: observe managed-tree state → ordered
 * actions. Removal-bearing actions always flag `requiresRemoveSafety` so
 * callers re-check `evaluateRemoveSafety` immediately before mutation (#770).
 */
export function reconcileWorktreeLifecycle(
  observed: WorktreeObservedState,
): WorktreeReconcileResult {
  if (observed.observationFailed) {
    return {
      actions: [
        action(
          "fail_closed",
          observed.observationError?.trim() ||
            "worktree observation failed; refusing to assume invariant holds",
        ),
      ],
      blocked: true,
    };
  }

  if (!observed.managedPresent || observed.pathExists === false) {
    if (!observed.required) {
      return {
        actions: [action("retain", "no managed worktree required")],
        blocked: false,
      };
    }
    return {
      actions: [
        action(
          "rematerialize",
          "managed worktree missing; rematerialize/recreate before parking for absence",
        ),
      ],
      blocked: true,
    };
  }

  // Poisoned / mismatched tree: wrong branch or HEAD vs expected candidate (#769).
  const branchMismatch =
    !!observed.expectedBranch &&
    !!observed.actualBranch &&
    observed.actualBranch !== observed.expectedBranch;
  const headMismatch =
    !!observed.expectedHead &&
    !!observed.actualHead &&
    observed.actualHead !== observed.expectedHead;
  if (branchMismatch || headMismatch) {
    const reason = branchMismatch
      ? `poisoned/mismatched branch: actual=${observed.actualBranch} expected=${observed.expectedBranch}`
      : `poisoned/mismatched HEAD: actual=${observed.actualHead?.slice(0, 7)} expected=${observed.expectedHead?.slice(0, 7)}`;
    return {
      actions: [
        action("refuse_unsafe_remove", `${reason}; will not retain-as-healthy`, true),
        action("rematerialize", "repair/rematerialize to expected candidate revision"),
      ],
      blocked: true,
    };
  }

  const dirty = !!observed.dirty;
  const localOnly = observed.localOnly ?? false;
  const safety = evaluateRemoveSafety({
    dirty,
    localOnly,
    force: !!observed.force,
  });

  if (dirty && !observed.force) {
    return {
      actions: [
        action(
          "refuse_unsafe_remove",
          "dirty worktree; refuse unsafe remove without force",
          true,
        ),
        action("salvage_then_continue", "salvage uncommitted work before further lifecycle mutation"),
      ],
      blocked: true,
      removeSafety: safety,
    };
  }

  if (!safety.ok) {
    return {
      actions: [
        action("refuse_unsafe_remove", safety.error, true),
        action("retain", "retain managed worktree until remove safety allows"),
      ],
      blocked: true,
      removeSafety: safety,
    };
  }

  if (observed.stalePathOrSlug) {
    return {
      actions: [
        action(
          "safe_remove_then_recreate",
          "stale clean managed worktree; reclaim then recreate at desired path/slug",
          true,
        ),
      ],
      blocked: false,
      removeSafety: safety,
    };
  }

  return {
    actions: [action("retain", "managed worktree healthy for expected candidate")],
    blocked: false,
    removeSafety: safety,
  };
}

// ---------------------------------------------------------------------------
// Review-verdict currency reconcile
// ---------------------------------------------------------------------------

/** Closed action set for review-currency convergence. */
export type ReviewCurrencyActionKind =
  | "reuse_verdict"
  | "delta_re_review"
  | "full_re_review"
  | "hold_unresolved_keys"
  | "emit_review_findings_recovery"
  | "fail_closed"
  /** Explicit: mechanical recurrence/ceiling is NOT a human hold. */
  | "surface_recovery_diagnostics";

export interface ReviewCurrencyAction {
  kind: ReviewCurrencyActionKind;
  reason: string;
}

export interface ReviewCurrencyObservedState {
  reviewedSha?: string | null;
  headSha?: string | null;
  /** Reviewed SHA is current under exact match / internal-commit / diff-hash rules. */
  currencyStatus: "current" | "superseded" | "unknown" | "missing";
  /** Pipeline-internal-only commits between reviewed and head. */
  pipelineInternalOnly?: boolean;
  /** Diff-hash reuse allowed by product rules. */
  diffHashReuse?: boolean;
  /** Unresolved blocking keys at the current verdict. */
  unresolvedBlockingKeys?: string[];
  /**
   * Exact-key recurrence evidence bound to current run, candidate lineage, and
   * an intervening fix attempt. Unbound history must not be passed as true.
   */
  exactKeyRecurrenceBound?: boolean;
  /** Review-ceiling exhaustion for the current candidate (engine-owned). */
  reviewCeilingExhausted?: boolean;
  /**
   * Current `human-decision-required` authority diagnostic. Mechanical
   * recurrence/ceiling alone must NOT set this.
   */
  humanDecisionRequiredAuthority?: boolean;
  /** Observation failure (cannot read head/commits). */
  observationFailed?: boolean;
  observationError?: string;
  /** Prefer delta over full when re-review is required. */
  preferDelta?: boolean;
}

export interface ReviewCurrencyReconcileResult {
  actions: ReviewCurrencyAction[];
  /**
   * True only when the gate must hold (unresolved keys or fail-closed).
   * Never set solely from recurrence/ceiling without human-decision authority.
   */
  hold: boolean;
  /**
   * True when recurrence/ceiling evidence should feed the autonomous recovery
   * controller — not a product needs-human terminalization.
   */
  recoveryInput: boolean;
  /**
   * Explicit guard: never invent needs-human from reconcile without authority.
   */
  mayApplyHumanHold: boolean;
}

/**
 * Pure review-verdict currency reconcile. Recurrence and ceiling are inputs
 * for recovery routing; they do not independently authorize `needs-human`.
 */
export function reconcileReviewCurrency(
  observed: ReviewCurrencyObservedState,
): ReviewCurrencyReconcileResult {
  if (observed.observationFailed) {
    return {
      actions: [
        {
          kind: "fail_closed",
          reason:
            observed.observationError?.trim() ||
            "review currency observation failed; refusing to reuse verdict",
        },
      ],
      hold: true,
      recoveryInput: false,
      mayApplyHumanHold: false,
    };
  }

  if (observed.currencyStatus === "unknown" || observed.currencyStatus === "missing") {
    return {
      actions: [
        {
          kind: "fail_closed",
          reason: "review currency unknown or missing; fail closed",
        },
        {
          kind: observed.preferDelta ? "delta_re_review" : "full_re_review",
          reason: "cannot prove verdict currency; re-review required",
        },
      ],
      hold: true,
      recoveryInput: false,
      mayApplyHumanHold: false,
    };
  }

  const unresolved = (observed.unresolvedBlockingKeys ?? []).filter(Boolean);
  const recurrence = !!observed.exactKeyRecurrenceBound;
  const ceiling = !!observed.reviewCeilingExhausted;
  const humanAuthority = !!observed.humanDecisionRequiredAuthority;

  if (observed.currencyStatus === "superseded") {
    const actions: ReviewCurrencyAction[] = [
      {
        kind: observed.preferDelta !== false ? "delta_re_review" : "full_re_review",
        reason: "reviewed SHA superseded by developer/fix commits; re-review",
      },
    ];
    if (recurrence || ceiling) {
      actions.push({
        kind: "surface_recovery_diagnostics",
        reason:
          "recurrence/ceiling evidence is recovery input only; not independent human hold",
      });
      actions.push({
        kind: "emit_review_findings_recovery",
        reason: "bind review-findings class for autonomous recovery controller",
      });
    }
    return {
      actions,
      hold: false,
      recoveryInput: recurrence || ceiling,
      mayApplyHumanHold: humanAuthority,
    };
  }

  // currencyStatus === "current" (exact SHA, internal-only, or diff-hash reuse).
  if (unresolved.length > 0) {
    const actions: ReviewCurrencyAction[] = [
      {
        kind: "hold_unresolved_keys",
        reason: `unresolved blocking keys at current verdict: ${unresolved.join(", ")}`,
      },
    ];
    if (recurrence || ceiling) {
      actions.push({
        kind: "surface_recovery_diagnostics",
        reason:
          "recurrence/ceiling with unresolved keys → recovery/reconcile, not invented human-decision authority",
      });
      actions.push({
        kind: "emit_review_findings_recovery",
        reason: "engine-owned review-findings recovery input",
      });
    }
    return {
      actions,
      hold: true,
      recoveryInput: recurrence || ceiling,
      // Unresolved keys hold pre-merge; they do not invent human-decision authority.
      mayApplyHumanHold: humanAuthority,
    };
  }

  if (recurrence || ceiling) {
    return {
      actions: [
        {
          kind: "surface_recovery_diagnostics",
          reason:
            "exact-key recurrence or review-ceiling exhaustion is reconciler input for recovery",
        },
        {
          kind: "emit_review_findings_recovery",
          reason: "do not apply needs-human without current human-decision-required authority",
        },
        {
          kind: "reuse_verdict",
          reason: "verdict currency holds; recovery controller owns non-convergence path",
        },
      ],
      hold: false,
      recoveryInput: true,
      mayApplyHumanHold: humanAuthority,
    };
  }

  return {
    actions: [
      {
        kind: "reuse_verdict",
        reason: "reviewed SHA current and blockers resolved",
      },
    ],
    hold: false,
    recoveryInput: false,
    mayApplyHumanHold: humanAuthority,
  };
}

/**
 * Shared identity key material for child-stage repair and supervisor recovery
 * claims so restart cannot suppress, duplicate, or bypass recovery.
 */
export function sharedRepairIdentity(input: {
  itemId: string;
  candidateIdentity: string;
  evidenceFingerprint: string;
  action: string;
}): string {
  return [
    input.itemId.trim(),
    input.candidateIdentity.trim(),
    input.evidenceFingerprint.trim(),
    input.action.trim(),
  ].join("\0");
}

/**
 * Whether bare open-PR existence may clear a started recovery claim.
 * Spec: bare open PR MUST NOT supersede a started claim without verified
 * ready/merged truth.
 */
export function bareOpenPrSupersedesStartedClaim(input: {
  openPrExists: boolean;
  verifiedReadyOrMerged: boolean;
}): boolean {
  if (input.verifiedReadyOrMerged) return true;
  return false;
}
