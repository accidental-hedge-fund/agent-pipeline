// Staged policy lifecycle (#695).
//
// Closed states, pure transition/promotion predicates, append-only lineage,
// and deterministic policy_hash for the effective acceptance slice.
// No network, git, or subprocess — all I/O is injectable at the call site.

import { buildPolicyHash } from "./evidence-subject.ts";

// ---------------------------------------------------------------------------
// Closed states (single-sourced; drift-guarded by unit tests)
// ---------------------------------------------------------------------------

export const POLICY_LIFECYCLE_STATES = [
  "draft",
  "observe",
  "required",
  "enforcing",
  "retired",
] as const;

export type PolicyLifecycleState = (typeof POLICY_LIFECYCLE_STATES)[number];

export function isPolicyLifecycleState(value: unknown): value is PolicyLifecycleState {
  return (
    typeof value === "string" &&
    (POLICY_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

export function assertPolicyLifecycleState(value: unknown): PolicyLifecycleState {
  if (!isPolicyLifecycleState(value)) {
    throw new Error(
      `invalid policy lifecycle state: ${JSON.stringify(value)}; ` +
        `expected one of ${POLICY_LIFECYCLE_STATES.join("|")}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Legal transition table
// ---------------------------------------------------------------------------

/** Closed legal edges (excluding retired, which is reachable from any active). */
const LEGAL_PROMOTION_EDGES: ReadonlyMap<PolicyLifecycleState, PolicyLifecycleState> = new Map([
  ["draft", "observe"],
  ["observe", "required"],
  ["required", "enforcing"],
]);

export function isLegalLifecycleEdge(
  from: PolicyLifecycleState,
  to: PolicyLifecycleState,
): boolean {
  if (from === "retired") return false;
  if (to === "retired") return from !== "retired";
  return LEGAL_PROMOTION_EDGES.get(from) === to;
}

// ---------------------------------------------------------------------------
// Observation aggregates + authority (injectable inputs)
// ---------------------------------------------------------------------------

/**
 * Default promotion thresholds. Config may override via staged policy block;
 * missing aggregates fail closed (cannot promote).
 */
export const DEFAULT_PROMOTION_THRESHOLDS = {
  /** Minimum observation runs before draft→required / required→enforcing. */
  min_observation_run_count: 3,
  /** Maximum false-positive or override rate in [0, 1]. */
  max_false_positive_or_override_rate: 0.2,
  /** Maximum unresolved evidence items. */
  max_unresolved_evidence_count: 0,
} as const;

export interface PolicyObservationAggregates {
  observation_run_count: number;
  false_positive_or_override_rate: number;
  unresolved_evidence_count: number;
}

export interface PolicyAuthorityRecord {
  /** Authenticated actor identity (login, subject, etc.). */
  actor: string;
  /** Role or capability that authorizes the transition. */
  role: string;
}

export interface PromotionThresholds {
  min_observation_run_count: number;
  max_false_positive_or_override_rate: number;
  max_unresolved_evidence_count: number;
}

// ---------------------------------------------------------------------------
// Policy identity + hash
// ---------------------------------------------------------------------------

/**
 * Acceptance-relevant slice folded into policy_hash.
 *
 * Included keys (v1 — keep tests in sync):
 *   - policy_id
 *   - state (effective lifecycle state)
 *   - acceptance (caller-defined acceptance-relevant config for this policy)
 *
 * Changing any of these revises the digest so prior policy-bound readiness
 * becomes non-current under evidence_subject rules (#692).
 */
export interface PolicyAcceptanceSlice {
  policy_id: string;
  state: PolicyLifecycleState;
  /** Structured acceptance-relevant config; stable-sorted by buildPolicyHash. */
  acceptance: Record<string, unknown>;
}

export function computeStagedPolicyHash(slice: PolicyAcceptanceSlice): string {
  return buildPolicyHash({
    policy_id: slice.policy_id,
    state: slice.state,
    acceptance: slice.acceptance,
  });
}

// ---------------------------------------------------------------------------
// Lineage (append-only)
// ---------------------------------------------------------------------------

export interface PolicyLineageEvent {
  policy_id: string;
  from_state: PolicyLifecycleState;
  to_state: PolicyLifecycleState;
  policy_hash_before: string;
  policy_hash_after: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Named authority; empty only when transition legally requires none (none today for promote/retire). */
  authority: PolicyAuthorityRecord | null;
  /** Observation or audit evidence references (may be empty for draft→observe). */
  evidence_refs: string[];
}

export interface StagedPolicy {
  policy_id: string;
  state: PolicyLifecycleState;
  /** Acceptance-relevant config folded into policy_hash. */
  acceptance: Record<string, unknown>;
  /** Append-only lineage; never rewrite or delete entries. */
  lineage: PolicyLineageEvent[];
}

export function createStagedPolicy(
  policyId: string,
  acceptance: Record<string, unknown> = {},
  initialState: PolicyLifecycleState = "draft",
): StagedPolicy {
  if (!policyId || typeof policyId !== "string" || !policyId.trim()) {
    throw new Error("policy_id must be a non-empty string");
  }
  assertPolicyLifecycleState(initialState);
  return {
    policy_id: policyId.trim(),
    state: initialState,
    acceptance: { ...acceptance },
    lineage: [],
  };
}

export function effectivePolicyHash(policy: StagedPolicy): string {
  return computeStagedPolicyHash({
    policy_id: policy.policy_id,
    state: policy.state,
    acceptance: policy.acceptance,
  });
}

// ---------------------------------------------------------------------------
// Transition evaluation (pure)
// ---------------------------------------------------------------------------

export type TransitionRejectReason =
  | "illegal_edge"
  | "retired_terminal"
  | "missing_authority"
  | "insufficient_observation"
  | "false_positive_rate_exceeded"
  | "unresolved_evidence_exceeded"
  | "missing_observation_aggregates"
  | "enforcing_requires_lineage_path";

export interface TransitionInput {
  policy: StagedPolicy;
  to: PolicyLifecycleState;
  /** ISO 8601; injectable for tests. */
  at: string;
  authority?: PolicyAuthorityRecord | null;
  observation?: PolicyObservationAggregates | null;
  thresholds?: Partial<PromotionThresholds>;
  evidence_refs?: string[];
  /**
   * Optional replacement acceptance slice after transition (e.g. promotion
   * expands acceptance). Defaults to the current policy.acceptance.
   */
  acceptance_after?: Record<string, unknown>;
}

export type TransitionResult =
  | { ok: true; policy: StagedPolicy; event: PolicyLineageEvent }
  | { ok: false; reason: TransitionRejectReason; message: string };

function thresholdsOf(partial?: Partial<PromotionThresholds>): PromotionThresholds {
  return {
    min_observation_run_count:
      partial?.min_observation_run_count ?? DEFAULT_PROMOTION_THRESHOLDS.min_observation_run_count,
    max_false_positive_or_override_rate:
      partial?.max_false_positive_or_override_rate ??
      DEFAULT_PROMOTION_THRESHOLDS.max_false_positive_or_override_rate,
    max_unresolved_evidence_count:
      partial?.max_unresolved_evidence_count ??
      DEFAULT_PROMOTION_THRESHOLDS.max_unresolved_evidence_count,
  };
}

function authorityPresent(authority: PolicyAuthorityRecord | null | undefined): boolean {
  return (
    !!authority &&
    typeof authority.actor === "string" &&
    authority.actor.trim().length > 0 &&
    typeof authority.role === "string" &&
    authority.role.trim().length > 0
  );
}

function observationMeets(
  observation: PolicyObservationAggregates | null | undefined,
  thresholds: PromotionThresholds,
): TransitionRejectReason | null {
  if (
    !observation ||
    typeof observation.observation_run_count !== "number" ||
    typeof observation.false_positive_or_override_rate !== "number" ||
    typeof observation.unresolved_evidence_count !== "number"
  ) {
    return "missing_observation_aggregates";
  }
  if (observation.observation_run_count < thresholds.min_observation_run_count) {
    return "insufficient_observation";
  }
  if (observation.false_positive_or_override_rate > thresholds.max_false_positive_or_override_rate) {
    return "false_positive_rate_exceeded";
  }
  if (observation.unresolved_evidence_count > thresholds.max_unresolved_evidence_count) {
    return "unresolved_evidence_exceeded";
  }
  return null;
}

/**
 * Evaluate a lifecycle transition. Pure over inputs; appends lineage on success
 * without mutating the input policy (returns a new object).
 */
export function evaluateLifecycleTransition(input: TransitionInput): TransitionResult {
  const from = assertPolicyLifecycleState(input.policy.state);
  const to = assertPolicyLifecycleState(input.to);

  if (from === "retired") {
    return {
      ok: false,
      reason: "retired_terminal",
      message: `policy ${input.policy.policy_id} is retired; no further transitions`,
    };
  }

  if (!isLegalLifecycleEdge(from, to)) {
    return {
      ok: false,
      reason: "illegal_edge",
      message:
        `illegal lifecycle transition ${from} → ${to} for policy ${input.policy.policy_id}; ` +
        `legal: draft→observe, observe→required, required→enforcing, *→retired`,
    };
  }

  const thresholds = thresholdsOf(input.thresholds);
  const needsAuthority = to === "enforcing" || to === "retired";
  // observe→required also requires observation coverage (design table).
  const needsObservation = to === "required" || to === "enforcing";

  if (needsAuthority && !authorityPresent(input.authority)) {
    return {
      ok: false,
      reason: "missing_authority",
      message: `transition to ${to} requires a named authority record (actor + role)`,
    };
  }

  if (needsObservation) {
    const obsFail = observationMeets(input.observation, thresholds);
    if (obsFail) {
      return {
        ok: false,
        reason: obsFail,
        message: `transition ${from} → ${to} rejected: ${obsFail}`,
      };
    }
  }

  // Enforcing is unreachable without traversing required and recording lineage
  // for that edge (enforced by legal table + append below). Extra guard: if
  // somehow to===enforcing without from===required, reject.
  if (to === "enforcing" && from !== "required") {
    return {
      ok: false,
      reason: "enforcing_requires_lineage_path",
      message: "enforcing is only reachable from required with a lineage event",
    };
  }

  const acceptanceAfter = input.acceptance_after ?? { ...input.policy.acceptance };
  const hashBefore = effectivePolicyHash(input.policy);
  const hashAfter = computeStagedPolicyHash({
    policy_id: input.policy.policy_id,
    state: to,
    acceptance: acceptanceAfter,
  });

  const event: PolicyLineageEvent = {
    policy_id: input.policy.policy_id,
    from_state: from,
    to_state: to,
    policy_hash_before: hashBefore,
    policy_hash_after: hashAfter,
    at: input.at,
    authority: needsAuthority ? (input.authority as PolicyAuthorityRecord) : (input.authority ?? null),
    evidence_refs: [...(input.evidence_refs ?? [])],
  };

  const next: StagedPolicy = {
    policy_id: input.policy.policy_id,
    state: to,
    acceptance: acceptanceAfter,
    // Append-only: copy prior events byte-stable, then append.
    lineage: [...input.policy.lineage, event],
  };

  return { ok: true, policy: next, event };
}

/** True when lineage contains an entry into enforcing (invariant for enforcing state). */
export function hasEnforcingLineage(policy: StagedPolicy): boolean {
  return policy.lineage.some((e) => e.to_state === "enforcing");
}

/**
 * Invariant check: an enforcing effective state MUST have lineage into enforcing.
 * Returns false when the invariant is broken (should never happen via evaluateLifecycleTransition).
 */
export function enforcingStateHasLineage(policy: StagedPolicy): boolean {
  if (policy.state !== "enforcing") return true;
  return hasEnforcingLineage(policy);
}

/** Evidence row for run finalize: policy_id, state, policy_hash (+ optional lineage head). */
export interface StagedPolicyEvidenceRow {
  policy_id: string;
  state: PolicyLifecycleState;
  policy_hash: string;
  lineage_head?: PolicyLineageEvent | null;
}

export function toPolicyEvidenceRow(policy: StagedPolicy): StagedPolicyEvidenceRow {
  const lineage = policy.lineage;
  return {
    policy_id: policy.policy_id,
    state: policy.state,
    policy_hash: effectivePolicyHash(policy),
    lineage_head: lineage.length > 0 ? lineage[lineage.length - 1]! : null,
  };
}
