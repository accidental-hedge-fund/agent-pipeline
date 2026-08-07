// Factory macro-controller (#890): coarse phase + next-action derivation and
// restart-safe tick. Delegates whole items to durable loop / advance only —
// never per-stage label transitions, never unattended merge/release.
//
// Tick: load → observe → derive → claim → dispatch child whole-run → reconcile → evidence.
// Conversation memory is never required for correctness.

import {
  actionIdFor,
  adoptOrReplan,
  claimAction,
  getFactoryStatus,
  listClaims,
  readClaim,
  readCurrentRevision,
  tryAcquireDispatchLease,
  updateClaim,
  type FactoryStoreDeps,
  type AdoptRequest,
} from "./store.ts";
import {
  FACTORY_SERVICE_CONTROLLER_ID,
  FactoryError,
  type FactoryActionClaim,
  type FactoryCoarsePhase,
  type FactoryCompletionPolicy,
  type FactoryControlIdentities,
  type FactoryExecutionContractRevision,
  type FactoryFingerprints,
  type FactoryLinkedRuns,
  type FactoryNextAction,
  type FactoryRepoIdentity,
  type FactorySelector,
  type FactoryStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Deps seams (all external effects injectable)
// ---------------------------------------------------------------------------

export type ChildRunStatus =
  | { state: "not_found" }
  | { state: "running"; run_id: string }
  | { state: "completed"; run_id: string; all_items_terminal: boolean; all_ready_to_deploy: boolean }
  | { state: "failed"; run_id: string; detail: string }
  | { state: "ambiguous"; run_id: string; detail: string };

export interface FactoryMacroDeps {
  store: FactoryStoreDeps;
  /** Fresh base SHA observation (git). */
  observeBaseSha(repoDir: string, baseBranch: string): Promise<string>;
  /** Optional GitHub selector/live checks — not authoritative for contract body. */
  observeGithubSnapshot?(input: {
    repo: string;
    issue_ids: string[];
  }): Promise<{ ok: boolean; detail?: string }>;
  now(): Date;
  /** Start/resume durable loop as whole-run (never per-stage). */
  startOrResumeLoop(input: {
    factory_run_id: string;
    revision: number;
    loop_run_id: string | null;
    action_id: string;
  }): Promise<{ loop_run_id: string }>;
  observeLoop(loopRunId: string): Promise<ChildRunStatus>;
  /** Optional whole-issue advance child. */
  startOrResumeAdvance?(input: {
    factory_run_id: string;
    revision: number;
    advance_run_id: string | null;
    issue_id: string;
    action_id: string;
  }): Promise<{ advance_run_id: string }>;
  observeAdvance?(advanceRunId: string): Promise<ChildRunStatus>;
  /**
   * Intentional isolation: merge/release mutation functions MUST NOT be present
   * on this deps surface. Tests assert the tick path never calls them.
   */
  readConfigFingerprints?(): Promise<FactoryFingerprints>;
  /** Injected fault hooks for crash-matrix tests only. */
  _fault?: {
    crashBeforeClaim?: boolean;
    crashAfterClaim?: boolean;
    crashAfterChildStart?: boolean;
    crashAfterAmbiguous?: boolean;
  };
}

export interface FactoryLiveObservation {
  base_sha: string;
  loop: ChildRunStatus | null;
  advance: ChildRunStatus | null;
  observed_at: string;
}

// ---------------------------------------------------------------------------
// Phase / next-action derivation (deterministic, no conversation memory)
// ---------------------------------------------------------------------------

export interface DeriveInput {
  contract: FactoryExecutionContractRevision;
  claims: FactoryActionClaim[];
  live: FactoryLiveObservation;
}

export interface DeriveResult {
  coarse_phase: FactoryCoarsePhase;
  next_action: FactoryNextAction;
  reason: string;
}

function openClaimForAction(
  claims: FactoryActionClaim[],
  revision: number,
  action: FactoryNextAction,
): FactoryActionClaim | undefined {
  return claims.find(
    (c) =>
      c.revision === revision &&
      c.action === action &&
      (c.state === "claimed" || c.state === "started" || c.state === "ambiguous_reconcile"),
  );
}

/**
 * Derive coarse phase and next action solely from durable contract/claims +
 * live child/external observations.
 */
export function derivePhaseAndNextAction(input: DeriveInput): DeriveResult {
  const { contract, claims, live } = input;
  const policy = contract.completion_policy;

  // Terminal factory phases stay put unless replan moves them.
  if (contract.coarse_phase === "factory_complete" || contract.coarse_phase === "factory_stopped") {
    return {
      coarse_phase: contract.coarse_phase,
      next_action: "none",
      reason: "terminal factory phase",
    };
  }

  // Operator-gated phases: only emit operator next-actions (no mutation).
  if (contract.coarse_phase === "merge_prepare") {
    return {
      coarse_phase: "merge_prepare",
      next_action: "operator_merge",
      reason: "merge preparation — operator-gated",
    };
  }
  if (contract.coarse_phase === "release_prepare") {
    return {
      coarse_phase: "release_prepare",
      next_action: "operator_release",
      reason: "release preparation — operator-gated",
    };
  }
  if (contract.coarse_phase === "engine_observe") {
    return {
      coarse_phase: "engine_observe",
      next_action: "observe_engine_pin",
      reason: "engine pin observe-only",
    };
  }

  const loopId = contract.linked_runs.loop_run_id ?? null;
  const advanceId = contract.linked_runs.advance_run_id ?? null;
  const multiItem = (contract.issue_ids?.length ?? 0) > 1 || !!loopId;

  // Reconcile open claims first (restart safety).
  const open = claims.filter(
    (c) =>
      c.revision === contract.revision &&
      (c.state === "claimed" || c.state === "started" || c.state === "ambiguous_reconcile"),
  );
  if (open.length > 0) {
    const c = open[open.length - 1];
    if (c.action === "start_loop" || c.action === "resume_loop" || c.action === "observe_loop") {
      if (live.loop?.state === "running") {
        return { coarse_phase: "executing", next_action: "observe_loop", reason: "open claim; loop running" };
      }
      if (live.loop?.state === "ambiguous" || c.state === "ambiguous_reconcile") {
        return {
          coarse_phase: "executing",
          next_action: "observe_loop",
          reason: "ambiguous child — re-query live truth",
        };
      }
      if (live.loop?.state === "completed") {
        return completeFromLoop(live.loop, policy);
      }
      if (live.loop?.state === "failed") {
        return {
          coarse_phase: "factory_stopped",
          next_action: "none",
          reason: `loop failed: ${live.loop.detail}`,
        };
      }
      // Claimed but child not started / not found — resume claim without second free dispatch
      if (c.state === "claimed" && (!live.loop || live.loop.state === "not_found")) {
        return {
          coarse_phase: contract.coarse_phase === "intake" ? "adopted" : "executing",
          next_action: c.action === "resume_loop" ? "resume_loop" : "start_loop",
          reason: "claimed; child not yet observed — resume claim",
        };
      }
    }
    if (c.action === "start_advance" || c.action === "resume_advance" || c.action === "observe_advance") {
      if (live.advance?.state === "running") {
        return { coarse_phase: "executing", next_action: "observe_advance", reason: "advance running" };
      }
      if (live.advance?.state === "completed") {
        return completeFromLoop(live.advance, policy);
      }
      if (live.advance?.state === "failed") {
        return {
          coarse_phase: "factory_stopped",
          next_action: "none",
          reason: `advance failed: ${live.advance.detail}`,
        };
      }
      if (c.state === "claimed") {
        return {
          coarse_phase: "executing",
          next_action: c.action === "resume_advance" ? "resume_advance" : "start_advance",
          reason: "claimed advance; child not yet observed",
        };
      }
    }
  }

  // No open claim — drive from contract phase + live child.
  if (contract.coarse_phase === "intake") {
    return {
      coarse_phase: "intake",
      next_action: "await_adoption",
      reason: "contract not yet driving execution",
    };
  }

  if (multiItem || loopId) {
    if (!loopId) {
      return {
        coarse_phase: "adopted",
        next_action: "start_loop",
        reason: "adopted; no linked loop yet",
      };
    }
    if (!live.loop || live.loop.state === "not_found") {
      return {
        coarse_phase: "adopted",
        next_action: "start_loop",
        reason: "linked loop id not observed — start/resume loop",
      };
    }
    if (live.loop.state === "running") {
      return { coarse_phase: "executing", next_action: "observe_loop", reason: "loop in progress" };
    }
    if (live.loop.state === "ambiguous") {
      return {
        coarse_phase: "executing",
        next_action: "observe_loop",
        reason: "ambiguous loop status",
      };
    }
    if (live.loop.state === "failed") {
      return {
        coarse_phase: "factory_stopped",
        next_action: "none",
        reason: `loop failed: ${live.loop.detail}`,
      };
    }
    if (live.loop.state === "completed") {
      return completeFromLoop(live.loop, policy);
    }
  }

  // Single-item advance path
  if (advanceId || (contract.issue_ids.length === 1 && !multiItem)) {
    if (!advanceId) {
      return {
        coarse_phase: "adopted",
        next_action: "start_advance",
        reason: "single-item; no advance run linked",
      };
    }
    if (!live.advance || live.advance.state === "not_found") {
      return {
        coarse_phase: "adopted",
        next_action: "start_advance",
        reason: "advance run not observed",
      };
    }
    if (live.advance.state === "running") {
      return { coarse_phase: "executing", next_action: "observe_advance", reason: "advance in progress" };
    }
    if (live.advance.state === "completed") {
      return completeFromLoop(live.advance, policy);
    }
    if (live.advance.state === "failed") {
      return {
        coarse_phase: "factory_stopped",
        next_action: "none",
        reason: `advance failed: ${live.advance.detail}`,
      };
    }
  }

  // Default: honor contract snapshot next_action when still valid
  return {
    coarse_phase: contract.coarse_phase,
    next_action: contract.next_action,
    reason: "contract snapshot",
  };
}

function completeFromLoop(
  child: Extract<ChildRunStatus, { state: "completed" }>,
  policy: FactoryCompletionPolicy,
): DeriveResult {
  if (policy === "all_items_ready_to_deploy" && child.all_ready_to_deploy) {
    return {
      coarse_phase: "items_complete",
      next_action: "operator_merge",
      reason: "all items ready-to-deploy — merge_prepare path",
    };
  }
  if (policy === "all_items_terminal" && child.all_items_terminal) {
    return {
      coarse_phase: "items_complete",
      next_action: "factory_idle",
      reason: "all items terminal per completion policy",
    };
  }
  if (child.all_items_terminal && !child.all_ready_to_deploy) {
    return {
      coarse_phase: "items_complete",
      next_action: "factory_idle",
      reason: "items terminal but not all ready-to-deploy",
    };
  }
  return {
    coarse_phase: "executing",
    next_action: "observe_loop",
    reason: "loop completed observation incomplete — re-observe",
  };
}

// ---------------------------------------------------------------------------
// Adopt / replan wrappers
// ---------------------------------------------------------------------------

export interface FactoryAdoptInput {
  factory_run_id: string;
  expected_revision: number | null;
  repo: FactoryRepoIdentity;
  selector: FactorySelector;
  issue_ids: string[];
  pr_ids?: string[];
  milestones?: string[];
  dependency_edges?: { from: string; to: string }[];
  linked_runs?: FactoryLinkedRuns;
  identities: FactoryControlIdentities;
  fingerprints: FactoryFingerprints;
  coarse_phase?: FactoryCoarsePhase;
  completion_policy?: FactoryCompletionPolicy;
  next_action?: FactoryNextAction;
  live_state_reason?: string | null;
  /** Freshly observed live identity (must match repo). */
  live_repo: FactoryRepoIdentity;
  factoryModeEnabled?: boolean;
}

export async function adoptFactoryContract(
  deps: FactoryMacroDeps,
  input: FactoryAdoptInput,
): Promise<FactoryExecutionContractRevision> {
  const request: AdoptRequest = {
    factory_run_id: input.factory_run_id,
    expected_revision: input.expected_revision,
    live_repo: input.live_repo,
    factoryModeEnabled: input.factoryModeEnabled,
    body: {
      factory_run_id: input.factory_run_id,
      repo: input.repo,
      selector: input.selector,
      issue_ids: input.issue_ids,
      pr_ids: input.pr_ids ?? [],
      milestones: input.milestones ?? [],
      dependency_edges: input.dependency_edges ?? [],
      linked_runs: input.linked_runs ?? {},
      identities: input.identities,
      fingerprints: input.fingerprints,
      coarse_phase: input.coarse_phase ?? (input.expected_revision === null ? "adopted" : "adopted"),
      completion_policy: input.completion_policy ?? "all_items_ready_to_deploy",
      next_action: input.next_action ?? "start_loop",
      live_state_reason: input.live_state_reason ?? null,
    },
  };
  return adoptOrReplan(deps.store, request);
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface TickResult {
  factory_run_id: string;
  revision: number;
  coarse_phase: FactoryCoarsePhase;
  next_action: FactoryNextAction;
  derive_reason: string;
  claim: FactoryActionClaim | null;
  claim_won: boolean;
  dispatched: boolean;
  child_run_id: string | null;
  status: FactoryStatus;
}

/**
 * One reconciliation tick. Reconstructs phase/next action from durable state
 * + live truth; claims before side effects; dispatches at most once.
 *
 * Does NOT: set pipeline stage labels, call mergePr, merge-queue apply, or
 * unattended release finalize. Does NOT widen concurrency budgets.
 */
export async function tickFactory(
  deps: FactoryMacroDeps,
  factoryRunId: string,
  opts: { repoDir: string; acquireLock?: boolean } = { repoDir: "." },
): Promise<TickResult> {
  const contract = await readCurrentRevision(deps.store, factoryRunId);
  if (!contract) {
    throw new FactoryError("not_found", `factory run "${factoryRunId}" has no current revision`);
  }

  // Observe live truth
  const base_sha = await deps.observeBaseSha(opts.repoDir, contract.repo.base_branch);
  const loopId = contract.linked_runs.loop_run_id ?? null;
  const advanceId = contract.linked_runs.advance_run_id ?? null;
  const loop = loopId ? await deps.observeLoop(loopId) : null;
  const advance =
    advanceId && deps.observeAdvance ? await deps.observeAdvance(advanceId) : null;

  const live: FactoryLiveObservation = {
    base_sha,
    loop,
    advance,
    observed_at: deps.now().toISOString(),
  };

  const claims = await listClaims(deps.store, factoryRunId);
  const derived = derivePhaseAndNextAction({ contract, claims, live });

  // Operator-only next actions: record intent, never mutate merge/release.
  const operatorOnly = new Set<FactoryNextAction>([
    "operator_merge",
    "operator_release",
    "observe_engine_pin",
    "factory_idle",
    "none",
    "await_adoption",
  ]);

  if (operatorOnly.has(derived.next_action)) {
    const status = (await getFactoryStatus(deps.store, factoryRunId))!;
    return {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase:
        derived.next_action === "operator_merge" && derived.coarse_phase === "items_complete"
          ? "merge_prepare"
          : derived.coarse_phase,
      next_action: derived.next_action,
      derive_reason: derived.reason,
      claim: null,
      claim_won: false,
      dispatched: false,
      child_run_id: null,
      status: {
        ...status,
        coarse_phase:
          derived.next_action === "operator_merge" && derived.coarse_phase === "items_complete"
            ? "merge_prepare"
            : derived.coarse_phase,
        next_action: derived.next_action,
      },
    };
  }

  if (deps._fault?.crashBeforeClaim) {
    throw new FactoryError("validation", "injected fault: crash before claim");
  }

  const actionId = actionIdFor(contract.revision, derived.next_action);
  const { claim, won } = await claimAction(deps.store, {
    factory_run_id: factoryRunId,
    revision: contract.revision,
    action_id: actionId,
    action: derived.next_action,
    service_controller: contract.identities.service_controller || FACTORY_SERVICE_CONTROLLER_ID,
  });

  if (deps._fault?.crashAfterClaim) {
    throw new FactoryError("validation", "injected fault: crash after claim");
  }

  // Only one tick dispatches a side effect for a claim: exclusive dispatch lease
  // (won claim path + restart after claim-before-start). Concurrent losers observe.
  let dispatched = false;
  let child_run_id: string | null = claim.child_run_id ?? null;

  const isChildStartAction =
    derived.next_action === "start_loop" ||
    derived.next_action === "resume_loop" ||
    derived.next_action === "start_advance" ||
    derived.next_action === "resume_advance";

  // Observe-only path: update claim from live child without starting.
  if (
    derived.next_action === "observe_loop" ||
    derived.next_action === "observe_advance"
  ) {
    const child = derived.next_action === "observe_loop" ? live.loop : live.advance;
    if (child?.state === "completed") {
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "completed",
        child_run_id: child.run_id,
        outcome_detail: "child completed",
      });
    } else if (child?.state === "failed") {
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "failed",
        child_run_id: child.run_id,
        outcome_detail: child.detail,
      });
    } else if (child?.state === "ambiguous") {
      if (deps._fault?.crashAfterAmbiguous) {
        await updateClaim(deps.store, factoryRunId, actionId, {
          state: "ambiguous_reconcile",
          child_run_id: child.run_id,
          outcome_detail: child.detail,
        });
        throw new FactoryError("validation", "injected fault: crash after ambiguous");
      }
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "ambiguous_reconcile",
        child_run_id: child.run_id,
        outcome_detail: child.detail,
      });
    } else if (child?.state === "running") {
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "started",
        child_run_id: child.run_id,
      });
      child_run_id = child.run_id;
    }
  } else if (isChildStartAction && !claim.child_run_id) {
    // Exclusive dispatch lease: at most one concurrent tick starts the child.
    // Restart after claim (won=false, state=claimed) still acquires the lease once.
    const leaseWon = await tryAcquireDispatchLease(deps.store, factoryRunId, actionId);
    if (leaseWon) {
      if (derived.next_action === "start_loop" || derived.next_action === "resume_loop") {
        const result = await deps.startOrResumeLoop({
          factory_run_id: factoryRunId,
          revision: contract.revision,
          loop_run_id: loopId,
          action_id: actionId,
        });
        child_run_id = result.loop_run_id;
        dispatched = true;
        await updateClaim(deps.store, factoryRunId, actionId, {
          state: "started",
          child_run_id: result.loop_run_id,
        });
        if (deps._fault?.crashAfterChildStart) {
          throw new FactoryError("validation", "injected fault: crash after child start");
        }
      } else if (
        (derived.next_action === "start_advance" || derived.next_action === "resume_advance") &&
        deps.startOrResumeAdvance
      ) {
        const issueId = contract.issue_ids[0] ?? "0";
        const result = await deps.startOrResumeAdvance({
          factory_run_id: factoryRunId,
          revision: contract.revision,
          advance_run_id: advanceId,
          issue_id: issueId,
          action_id: actionId,
        });
        child_run_id = result.advance_run_id;
        dispatched = true;
        await updateClaim(deps.store, factoryRunId, actionId, {
          state: "started",
          child_run_id: result.advance_run_id,
        });
        if (deps._fault?.crashAfterChildStart) {
          throw new FactoryError("validation", "injected fault: crash after child start");
        }
      }
    }
  }

  const finalClaim = await readClaim(deps.store, factoryRunId, actionId);
  const status = (await getFactoryStatus(deps.store, factoryRunId))!;

  return {
    factory_run_id: factoryRunId,
    revision: contract.revision,
    coarse_phase: derived.coarse_phase,
    next_action: derived.next_action,
    derive_reason: derived.reason,
    claim: finalClaim,
    claim_won: won,
    dispatched,
    child_run_id,
    status: {
      ...status,
      coarse_phase: derived.coarse_phase,
      next_action: derived.next_action,
    },
  };
}

/**
 * Read-only status: never mutates contract, claims, or children.
 */
export async function factoryStatus(
  deps: FactoryMacroDeps,
  factoryRunId: string,
): Promise<FactoryStatus | null> {
  return getFactoryStatus(deps.store, factoryRunId);
}

/**
 * Drift-guard surface: the macro-controller module intentionally does not
 * export any per-stage label transition API. This constant lists the only
 * child operations the controller may perform.
 */
export const FACTORY_CHILD_OPERATIONS = [
  "startOrResumeLoop",
  "observeLoop",
  "startOrResumeAdvance",
  "observeAdvance",
] as const;

/** Operations that must never appear on FactoryMacroDeps for merge isolation. */
export const FACTORY_FORBIDDEN_MERGE_OPERATIONS = [
  "mergePr",
  "mergeQueueApply",
  "finalizeRelease",
  "auto_merge",
] as const;
