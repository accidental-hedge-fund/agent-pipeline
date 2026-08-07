// Factory macro-controller (#890): coarse phase + next-action derivation and
// restart-safe tick. Delegates whole items to durable loop / advance only —
// never per-stage label transitions, never unattended merge/release.
//
// Tick: load → observe → derive → claim → dispatch child whole-run → reconcile → evidence.
// Conversation memory is never required for correctness.

import {
  actionIdFor,
  adoptOrReplan,
  acquireFactoryLock,
  claimAction,
  getFactoryStatus,
  listClaims,
  readClaim,
  readCurrentRevision,
  releaseFactoryLock,
  tryAcquireOrRecoverDispatchLease,
  updateClaim,
  writePhaseEvidence,
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
  type FactoryDependencyEdge,
  type FactoryExecutionContractRevision,
  type FactoryFingerprints,
  type FactoryGithubIdentitySnapshot,
  type FactoryLinkedRuns,
  type FactoryNextAction,
  type FactoryPhaseEvidence,
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
  /**
   * Fresh repository name + base branch for live reconciliation (required on
   * every enabled tick; compared against the accepted contract).
   */
  observeRepoIdentity(input: {
    repoDir: string;
    baseBranch: string;
  }): Promise<{ name: string; base_branch: string }>;
  /**
   * Fresh GitHub-linked identity observation — required on every enabled tick.
   * Receives the full contracted selector/issue/PR/milestone/dependency snapshot
   * and MUST return a typed live observation so the controller can compare each
   * field against the accepted revision before dispatch. Not authoritative for
   * contract body content (drift → replan_required + CAS replan).
   */
  observeGithubSnapshot(input: {
    repo: string;
    contracted: FactoryGithubIdentitySnapshot;
  }): Promise<{
    ok: boolean;
    detail?: string;
    /** Live observed identities; required for successful reconciliation. */
    observed?: FactoryGithubIdentitySnapshot;
  }>;
  now(): Date;
  /** Start/resume durable loop as whole-run (never per-stage). */
  startOrResumeLoop(input: {
    factory_run_id: string;
    revision: number;
    loop_run_id: string | null;
    action_id: string;
  }): Promise<{ loop_run_id: string }>;
  observeLoop(loopRunId: string): Promise<ChildRunStatus>;
  /**
   * Whole-issue advance child. Optional only for loop-only deps construction;
   * when derivation selects start/resume/observe advance, both advance seams
   * MUST be present or the tick fails closed (no silent strand).
   */
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
  /** Fresh configuration fingerprints — required on every enabled tick. */
  readConfigFingerprints(): Promise<FactoryFingerprints>;
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
      // Match the loop path: ambiguous live status or claim state stays on
      // observe_advance — never fall through to contract snapshot (which may
      // select start_loop and launch an unrelated whole-item child).
      if (live.advance?.state === "ambiguous" || c.state === "ambiguous_reconcile") {
        return {
          coarse_phase: "executing",
          next_action: "observe_advance",
          reason: "ambiguous child — re-query live truth",
        };
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
      if (c.state === "claimed" && (!live.advance || live.advance.state === "not_found")) {
        return {
          coarse_phase: "executing",
          next_action: c.action === "resume_advance" ? "resume_advance" : "start_advance",
          reason: "claimed advance; child not yet observed",
        };
      }
      // Any other open advance claim: re-observe only — do not select a different child kind.
      return {
        coarse_phase: "executing",
        next_action: "observe_advance",
        reason: "open advance claim — re-query live truth",
      };
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
    if (live.advance.state === "ambiguous") {
      return {
        coarse_phase: "executing",
        next_action: "observe_advance",
        reason: "ambiguous advance status",
      };
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

/** Non-dispatchable next actions (operator / replan / idle). */
const NON_DISPATCH_ACTIONS = new Set<FactoryNextAction>([
  "operator_merge",
  "operator_release",
  "observe_engine_pin",
  "factory_idle",
  "none",
  "await_adoption",
  "replan_required",
]);

/**
 * When derivation selects an advance whole-item action, both advance seams
 * must be present. Returns a fail-closed reason string, or null when ok.
 */
function advanceSeamRequirement(
  nextAction: FactoryNextAction,
  deps: FactoryMacroDeps,
): string | null {
  if (
    nextAction === "start_advance" ||
    nextAction === "resume_advance"
  ) {
    if (deps.startOrResumeAdvance == null || deps.observeAdvance == null) {
      return (
        "single-item advance path requires startOrResumeAdvance and observeAdvance seams — " +
        "replan to a loop-linked contract or provide advance child seams"
      );
    }
  }
  if (nextAction === "observe_advance" && deps.observeAdvance == null) {
    return (
      "observe_advance requires observeAdvance seam — " +
      "replan to a loop-linked contract or provide advance child seams"
    );
  }
  return null;
}

function resolveReportedPhase(derived: DeriveResult): FactoryCoarsePhase {
  if (derived.next_action === "operator_merge" && derived.coarse_phase === "items_complete") {
    return "merge_prepare";
  }
  return derived.coarse_phase;
}

function childDispositionFromLive(
  live: FactoryLiveObservation,
  kind: "loop" | "advance",
): FactoryPhaseEvidence["child_disposition"] {
  const child = kind === "loop" ? live.loop : live.advance;
  if (!child || child.state === "not_found") {
    return child
      ? { kind, run_id: "", state: "not_found" }
      : null;
  }
  if (child.state === "running") {
    return { kind, run_id: child.run_id, state: "running" };
  }
  if (child.state === "ambiguous") {
    return { kind, run_id: child.run_id, state: "ambiguous", detail: child.detail };
  }
  if (child.state === "failed") {
    return { kind, run_id: child.run_id, state: "failed", detail: child.detail };
  }
  return {
    kind,
    run_id: child.run_id,
    state: "completed",
    all_items_terminal: child.all_items_terminal,
    all_ready_to_deploy: child.all_ready_to_deploy,
  };
}

async function persistPhaseEvidence(
  deps: FactoryMacroDeps,
  input: {
    factory_run_id: string;
    revision: number;
    coarse_phase: FactoryCoarsePhase;
    next_action: FactoryNextAction;
    reason: string;
    identities: FactoryControlIdentities;
    live: FactoryLiveObservation;
    replan_reason?: string | null;
  },
): Promise<FactoryPhaseEvidence> {
  const child_disposition =
    input.next_action === "observe_loop" ||
    input.next_action === "operator_merge" ||
    input.next_action === "factory_idle" ||
    input.coarse_phase === "items_complete" ||
    input.coarse_phase === "merge_prepare" ||
    input.coarse_phase === "factory_stopped"
      ? childDispositionFromLive(input.live, "loop") ??
        childDispositionFromLive(input.live, "advance")
      : childDispositionFromLive(input.live, "advance") ??
        childDispositionFromLive(input.live, "loop");

  return writePhaseEvidence(deps.store, {
    factory_run_id: input.factory_run_id,
    revision: input.revision,
    coarse_phase: input.coarse_phase,
    next_action: input.next_action,
    reason: input.reason,
    service_controller: input.identities.service_controller,
    outer_host: input.identities.outer_host,
    implementer_treatment: input.identities.implementer_treatment,
    reviewer_treatment: input.identities.reviewer_treatment,
    privileged_mutation_actor: input.identities.privileged_mutation_actor,
    child_disposition,
    replan_reason: input.replan_reason ?? null,
  });
}

/** Canonical string multiset equality for identity lists. */
function sameStringMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].map(String).sort();
  const bs = [...b].map(String).sort();
  return as.every((v, i) => v === bs[i]);
}

function sameSelector(a: FactorySelector, b: FactorySelector): boolean {
  return a.type === b.type && a.value === b.value;
}

function sameDependencyEdges(
  a: FactoryDependencyEdge[],
  b: FactoryDependencyEdge[],
): boolean {
  if (a.length !== b.length) return false;
  const canon = (edges: FactoryDependencyEdge[]) =>
    [...edges]
      .map((e) => `${String(e.from)}\0${String(e.to)}`)
      .sort()
      .join("\n");
  return canon(a) === canon(b);
}

/**
 * Compare a live GitHub identity snapshot against the accepted contract fields.
 * Returns null when equal; otherwise a human-readable drift reason.
 */
export function githubIdentityDriftReason(
  contract: Pick<
    FactoryExecutionContractRevision,
    "selector" | "issue_ids" | "pr_ids" | "milestones" | "dependency_edges"
  >,
  observed: FactoryGithubIdentitySnapshot,
): string | null {
  if (!sameSelector(observed.selector, contract.selector)) {
    return (
      `GitHub selector drift: live ${observed.selector.type}:${observed.selector.value} !== ` +
      `contract ${contract.selector.type}:${contract.selector.value}`
    );
  }
  if (!sameStringMultiset(observed.issue_ids, contract.issue_ids)) {
    return (
      `GitHub issue_ids drift: live [${[...observed.issue_ids].map(String).sort().join(",")}] !== ` +
      `contract [${[...contract.issue_ids].map(String).sort().join(",")}]`
    );
  }
  if (!sameStringMultiset(observed.pr_ids, contract.pr_ids)) {
    return (
      `GitHub pr_ids drift: live [${[...observed.pr_ids].map(String).sort().join(",")}] !== ` +
      `contract [${[...contract.pr_ids].map(String).sort().join(",")}]`
    );
  }
  if (!sameStringMultiset(observed.milestones, contract.milestones)) {
    return (
      `GitHub milestones drift: live [${[...observed.milestones].map(String).sort().join(",")}] !== ` +
      `contract [${[...contract.milestones].map(String).sort().join(",")}]`
    );
  }
  if (!sameDependencyEdges(observed.dependency_edges, contract.dependency_edges)) {
    return "GitHub dependency_edges drift vs accepted contract";
  }
  return null;
}

export function contractGithubIdentitySnapshot(
  contract: Pick<
    FactoryExecutionContractRevision,
    "selector" | "issue_ids" | "pr_ids" | "milestones" | "dependency_edges"
  >,
): FactoryGithubIdentitySnapshot {
  return {
    selector: { type: contract.selector.type, value: contract.selector.value },
    issue_ids: [...contract.issue_ids],
    pr_ids: [...contract.pr_ids],
    milestones: [...contract.milestones],
    dependency_edges: contract.dependency_edges.map((e) => ({
      from: e.from,
      to: e.to,
    })),
  };
}

/**
 * Compare live observations against the accepted contract. On mismatch or
 * missing required observations, return a non-dispatchable replan_required
 * posture (CAS replan is required to adopt the new live identity into a
 * retained revision). Absent GitHub, configuration, or repository-identity
 * observations fail closed — they are not treated as successful reconciliation.
 * GitHub reconciliation compares the full contracted selector, issue/PR ids,
 * milestones, and dependency edges against the typed live observation.
 */
export function reconcileLiveIdentity(input: {
  contract: FactoryExecutionContractRevision;
  base_sha: string;
  /** Fresh repo name + base_branch; null/undefined fails closed. */
  live_repo?: { name: string; base_branch: string } | null;
  github?: {
    ok: boolean;
    detail?: string;
    observed?: FactoryGithubIdentitySnapshot;
  } | null;
  configFingerprints?: FactoryFingerprints | null;
}): { ok: true } | { ok: false; reason: string } {
  const { contract, base_sha, live_repo, github, configFingerprints } = input;
  if (live_repo == null) {
    return {
      ok: false,
      reason:
        "repository identity observation required before dispatch — CAS replan required",
    };
  }
  if (
    live_repo.name !== contract.repo.name ||
    live_repo.base_branch !== contract.repo.base_branch
  ) {
    return {
      ok: false,
      reason:
        `repository identity drift: live ${live_repo.name}@${live_repo.base_branch} !== ` +
        `contract ${contract.repo.name}@${contract.repo.base_branch} — CAS replan required`,
    };
  }
  if (base_sha !== contract.repo.observed_base_sha) {
    return {
      ok: false,
      reason:
        `base SHA drift: live ${base_sha} !== contract ${contract.repo.observed_base_sha} — CAS replan required`,
    };
  }
  if (github == null) {
    return {
      ok: false,
      reason:
        "GitHub snapshot observation required before dispatch — CAS replan required",
    };
  }
  if (!github.ok) {
    return {
      ok: false,
      reason: `GitHub snapshot mismatch: ${github.detail ?? "ok=false"} — CAS replan required`,
    };
  }
  if (github.observed == null) {
    return {
      ok: false,
      reason:
        "GitHub identity observation missing observed selector/issue/PR/milestone/dependency snapshot — CAS replan required",
    };
  }
  {
    const drift = githubIdentityDriftReason(contract, github.observed);
    if (drift) {
      return {
        ok: false,
        reason: `${drift} — CAS replan required`,
      };
    }
  }
  if (configFingerprints == null) {
    return {
      ok: false,
      reason:
        "configuration fingerprint observation required before dispatch — CAS replan required",
    };
  }
  {
    const c = contract.fingerprints;
    if (
      configFingerprints.configuration !== c.configuration ||
      configFingerprints.authority_policy !== c.authority_policy ||
      configFingerprints.engine_pin !== c.engine_pin ||
      configFingerprints.treatment !== c.treatment
    ) {
      return {
        ok: false,
        reason:
          "configuration fingerprint drift vs accepted contract — CAS replan required",
      };
    }
  }
  return { ok: true };
}

/**
 * One reconciliation tick. Reconstructs phase/next action from durable state
 * + live truth; claims before side effects; dispatches at most once.
 *
 * Does NOT: set pipeline stage labels, call mergePr, merge-queue apply, or
 * unattended release finalize. Does NOT widen concurrency budgets.
 *
 * When `acquireLock` is true (default), acquires the host-local factory-run
 * lock for the full tick lifecycle. Pass `acquireLock: false` only when the
 * caller already holds the factory-run lock.
 */
export async function tickFactory(
  deps: FactoryMacroDeps,
  factoryRunId: string,
  opts: { repoDir: string; acquireLock?: boolean } = { repoDir: "." },
): Promise<TickResult> {
  const shouldLock = opts.acquireLock !== false;
  let lockToken: string | null = null;
  if (shouldLock) {
    const lock = await acquireFactoryLock(deps.store, factoryRunId);
    lockToken = lock.token;
  }
  try {
    return await tickFactoryLocked(deps, factoryRunId, opts);
  } finally {
    if (lockToken) {
      await releaseFactoryLock(deps.store, factoryRunId, lockToken);
    }
  }
}

async function tickFactoryLocked(
  deps: FactoryMacroDeps,
  factoryRunId: string,
  opts: { repoDir: string; acquireLock?: boolean },
): Promise<TickResult> {
  const contract = await readCurrentRevision(deps.store, factoryRunId);
  if (!contract) {
    throw new FactoryError("not_found", `factory run "${factoryRunId}" has no current revision`);
  }

  const controlIdentities: FactoryControlIdentities = {
    service_controller:
      contract.identities.service_controller || FACTORY_SERVICE_CONTROLLER_ID,
    outer_host: contract.identities.outer_host,
    implementer_treatment: contract.identities.implementer_treatment,
    reviewer_treatment: contract.identities.reviewer_treatment,
    privileged_mutation_actor: contract.identities.privileged_mutation_actor,
  };
  const serviceController = controlIdentities.service_controller;

  // Observe live truth (git base, repository identity, GitHub, config, children).
  // All four external-truth seams are required; missing providers fail closed
  // via reconcileLiveIdentity (null is not a successful reconciliation).
  const base_sha = await deps.observeBaseSha(opts.repoDir, contract.repo.base_branch);
  const live_repo =
    deps.observeRepoIdentity != null
      ? await deps.observeRepoIdentity({
          repoDir: opts.repoDir,
          baseBranch: contract.repo.base_branch,
        })
      : null;
  const contractedGithub = contractGithubIdentitySnapshot(contract);
  const github =
    deps.observeGithubSnapshot != null
      ? await deps.observeGithubSnapshot({
          repo: contract.repo.name,
          contracted: contractedGithub,
        })
      : null;
  const configFingerprints =
    deps.readConfigFingerprints != null ? await deps.readConfigFingerprints() : null;

  const claims = await listClaims(deps.store, factoryRunId);
  // Prefer durable claim child links when observing so restart after child
  // start does not depend on the immutable contract having been replanned.
  const openWithChild = [...claims]
    .reverse()
    .find(
      (c) =>
        c.revision === contract.revision &&
        c.child_run_id &&
        (c.state === "claimed" || c.state === "started" || c.state === "ambiguous_reconcile"),
    );
  const loopId =
    (openWithChild?.action === "start_loop" ||
    openWithChild?.action === "resume_loop" ||
    openWithChild?.action === "observe_loop"
      ? openWithChild.child_run_id
      : null) ??
    contract.linked_runs.loop_run_id ??
    null;
  const advanceId =
    (openWithChild?.action === "start_advance" ||
    openWithChild?.action === "resume_advance" ||
    openWithChild?.action === "observe_advance"
      ? openWithChild.child_run_id
      : null) ??
    contract.linked_runs.advance_run_id ??
    null;
  const loop = loopId ? await deps.observeLoop(loopId) : null;
  const advance =
    advanceId && deps.observeAdvance ? await deps.observeAdvance(advanceId) : null;

  const live: FactoryLiveObservation = {
    base_sha,
    loop,
    advance,
    observed_at: deps.now().toISOString(),
  };

  // Live identity reconciliation — fail closed before derive/dispatch.
  const liveOk = reconcileLiveIdentity({
    contract,
    base_sha,
    live_repo,
    github,
    configFingerprints,
  });
  if (!liveOk.ok) {
    const coarse_phase = contract.coarse_phase;
    const next_action: FactoryNextAction = "replan_required";
    await persistPhaseEvidence(deps, {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase,
      next_action,
      reason: liveOk.reason,
      identities: controlIdentities,
      live,
      replan_reason: liveOk.reason,
    });
    const status = (await getFactoryStatus(deps.store, factoryRunId))!;
    return {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase,
      next_action,
      derive_reason: liveOk.reason,
      claim: null,
      claim_won: false,
      dispatched: false,
      child_run_id: null,
      status,
    };
  }

  const derived = derivePhaseAndNextAction({ contract, claims, live });
  const reportedPhase = resolveReportedPhase(derived);

  // Single-item advance path: fail closed when child seams are absent so a
  // claimed action cannot strand forever with no child id and no error.
  const advanceSeamMissingReason = advanceSeamRequirement(derived.next_action, deps);
  if (advanceSeamMissingReason) {
    const actionId = actionIdFor(contract.revision, derived.next_action);
    const existingClaim = await readClaim(deps.store, factoryRunId, actionId);
    if (
      existingClaim &&
      (existingClaim.state === "claimed" ||
        existingClaim.state === "started" ||
        existingClaim.state === "ambiguous_reconcile")
    ) {
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "failed",
        outcome_detail: advanceSeamMissingReason,
      });
    }
    const failedClaim = await readClaim(deps.store, factoryRunId, actionId);
    await persistPhaseEvidence(deps, {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase: reportedPhase,
      next_action: "replan_required",
      reason: advanceSeamMissingReason,
      identities: controlIdentities,
      live,
      replan_reason: advanceSeamMissingReason,
    });
    const status = (await getFactoryStatus(deps.store, factoryRunId))!;
    return {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase: reportedPhase,
      next_action: "replan_required",
      derive_reason: advanceSeamMissingReason,
      claim: failedClaim,
      claim_won: false,
      dispatched: false,
      child_run_id: failedClaim?.child_run_id ?? null,
      status,
    };
  }

  // Operator-only / non-dispatch next actions: durable phase evidence, no merge.
  if (NON_DISPATCH_ACTIONS.has(derived.next_action)) {
    await persistPhaseEvidence(deps, {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase: reportedPhase,
      next_action: derived.next_action,
      reason: derived.reason,
      identities: controlIdentities,
      live,
    });
    const status = (await getFactoryStatus(deps.store, factoryRunId))!;
    return {
      factory_run_id: factoryRunId,
      revision: contract.revision,
      coarse_phase: reportedPhase,
      next_action: derived.next_action,
      derive_reason: derived.reason,
      claim: null,
      claim_won: false,
      dispatched: false,
      child_run_id: null,
      status,
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
    identities: controlIdentities,
  });

  if (deps._fault?.crashAfterClaim) {
    throw new FactoryError("validation", "injected fault: crash after claim");
  }

  // Only one tick dispatches a side effect for a claim: exclusive dispatch lease
  // (won claim path + restart after claim-before-start). Unfinished leases
  // (lease held, no child_run_id) are recovered with the same action_id.
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
        outcome_detail: JSON.stringify({
          disposition: "completed",
          all_items_terminal: child.all_items_terminal,
          all_ready_to_deploy: child.all_ready_to_deploy,
        }),
      });
      child_run_id = child.run_id;
    } else if (child?.state === "failed") {
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "failed",
        child_run_id: child.run_id,
        outcome_detail: child.detail,
      });
      child_run_id = child.run_id;
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
      child_run_id = child.run_id;
    } else if (child?.state === "running") {
      await updateClaim(deps.store, factoryRunId, actionId, {
        state: "started",
        child_run_id: child.run_id,
      });
      child_run_id = child.run_id;
    }
  } else if (isChildStartAction && !claim.child_run_id) {
    // Exclusive dispatch lease, or recovery of an unfinished lease after a
    // crash between child creation and durable child_run_id write.
    const lease = await tryAcquireOrRecoverDispatchLease(
      deps.store,
      factoryRunId,
      actionId,
      claim,
    );
    if (lease.acquired) {
      if (derived.next_action === "start_loop" || derived.next_action === "resume_loop") {
        const result = await deps.startOrResumeLoop({
          factory_run_id: factoryRunId,
          revision: contract.revision,
          loop_run_id: loopId,
          action_id: actionId,
        });
        child_run_id = result.loop_run_id;
        dispatched = true;
        // Crash window: child exists but claim not yet updated — recovery
        // re-dispatches with the same action_id (idempotent child start).
        if (deps._fault?.crashAfterChildStart) {
          throw new FactoryError("validation", "injected fault: crash after child start");
        }
        await updateClaim(deps.store, factoryRunId, actionId, {
          state: "started",
          child_run_id: result.loop_run_id,
        });
      } else if (
        derived.next_action === "start_advance" ||
        derived.next_action === "resume_advance"
      ) {
        // Seam presence already validated above; defense-in-depth fail closed.
        if (!deps.startOrResumeAdvance) {
          await updateClaim(deps.store, factoryRunId, actionId, {
            state: "failed",
            outcome_detail:
              "startOrResumeAdvance seam unavailable for single-item advance dispatch",
          });
        } else {
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
          if (deps._fault?.crashAfterChildStart) {
            throw new FactoryError("validation", "injected fault: crash after child start");
          }
          await updateClaim(deps.store, factoryRunId, actionId, {
            state: "started",
            child_run_id: result.advance_run_id,
          });
        }
      }
    }
  }

  // Re-derive after claim updates so phase evidence records completion posture.
  const finalClaim = await readClaim(deps.store, factoryRunId, actionId);
  const claimsAfter = await listClaims(deps.store, factoryRunId);
  // Refresh child observation if we just linked a new child id.
  let liveAfter = live;
  if (child_run_id && (derived.next_action === "start_loop" || derived.next_action === "resume_loop")) {
    const loopAfter = await deps.observeLoop(child_run_id);
    liveAfter = { ...live, loop: loopAfter };
  } else if (
    child_run_id &&
    (derived.next_action === "start_advance" || derived.next_action === "resume_advance") &&
    deps.observeAdvance
  ) {
    const advanceAfter = await deps.observeAdvance(child_run_id);
    liveAfter = { ...live, advance: advanceAfter };
  }
  const derivedAfter = derivePhaseAndNextAction({
    contract,
    claims: claimsAfter,
    live: liveAfter,
  });
  const reportedAfter = resolveReportedPhase(derivedAfter);

  await persistPhaseEvidence(deps, {
    factory_run_id: factoryRunId,
    revision: contract.revision,
    coarse_phase: reportedAfter,
    next_action: derivedAfter.next_action,
    reason: derivedAfter.reason,
    identities: controlIdentities,
    live: liveAfter,
  });

  const status = (await getFactoryStatus(deps.store, factoryRunId))!;

  return {
    factory_run_id: factoryRunId,
    revision: contract.revision,
    coarse_phase: reportedAfter,
    next_action: derivedAfter.next_action,
    derive_reason: derivedAfter.reason,
    claim: finalClaim,
    claim_won: won,
    dispatched,
    child_run_id,
    status,
  };
}

/**
 * Read-only status: never mutates contract, claims, or children.
 * Reconstructs current coarse phase / next action from durable phase evidence
 * when present (same revision as current contract).
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
