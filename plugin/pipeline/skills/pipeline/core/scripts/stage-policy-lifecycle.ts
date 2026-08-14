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

export interface StagedPolicyPromotionProvenance {
  /** Only the engine transition path may produce this kind. */
  kind: "engine-transition";
  /** effectivePolicyHash at the moment promotion into enforcing was evaluated. */
  policy_hash: string;
  /** Authenticated authority that authorized the promotion. */
  actor: string;
  role: string;
  /** ISO 8601 observed-at of the transition evaluation. */
  observed_at: string;
}

export interface StagedPolicy {
  policy_id: string;
  state: PolicyLifecycleState;
  /** Acceptance-relevant config folded into policy_hash. */
  acceptance: Record<string, unknown>;
  /** Append-only lineage; never rewrite or delete entries. */
  lineage: PolicyLineageEvent[];
  /**
   * Engine-attested promotion provenance (#695 66803fac). Absent for config
   * materialization; only set by evaluateLifecycleTransition when a promotion
   * into `enforcing` actually evaluated observation aggregates against policy
   * thresholds and resolved an authenticated authority. Config-declared
   * lineage can never carry this token, so a forged StagedPolicy object does
   * not satisfy the enforcing invariant.
   */
  promotion_provenance?: StagedPolicyPromotionProvenance | null;
}

/**
 * ISO 8601 date-time (with zone) for lineage `at`. Rejects bare dates and
 * free-form non-empty strings so config cannot self-attest with placeholders.
 */
export function isIso8601Timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return false;
  }
  return !Number.isNaN(Date.parse(s));
}

/** Transitions that require non-empty evidence_refs in materialize/config lineage. */
function edgeRequiresEvidenceRefs(
  from: PolicyLifecycleState,
  to: PolicyLifecycleState,
): boolean {
  return (from === "observe" && to === "required") || (from === "required" && to === "enforcing");
}

/** Transitions that require a named authority record in materialize/config lineage. */
function edgeRequiresAuthority(to: PolicyLifecycleState): boolean {
  return to === "enforcing" || to === "retired";
}

/**
 * Legal full promotion path into enforcing (draft → observe → required → enforcing).
 * Config cannot self-attest enforcing via a forged single required→enforcing head.
 */
export const ENFORCING_PROMOTION_PATH: ReadonlyArray<
  readonly [PolicyLifecycleState, PolicyLifecycleState]
> = [
  ["draft", "observe"],
  ["observe", "required"],
  ["required", "enforcing"],
] as const;

function lineageContainsEnforcingPromotionPath(
  lineage: readonly PolicyLineageEvent[],
): boolean {
  const need = ENFORCING_PROMOTION_PATH;
  if (lineage.length < need.length) return false;
  for (let i = 0; i <= lineage.length - need.length; i++) {
    let ok = true;
    for (let j = 0; j < need.length; j++) {
      const e = lineage[i + j]!;
      const [from, to] = need[j]!;
      if (e.from_state !== from || e.to_state !== to) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export interface MaterializeLineageInput {
  policy_id: string;
  state: PolicyLifecycleState;
  acceptance?: Record<string, unknown>;
  lineage: readonly PolicyLineageEvent[];
  /**
   * Verified promotion provenance (#695 66803fac).
   *
   * Config-declared lineage is NEVER sufficient proof of enforcing: a config
   * author can construct the draft→observe→required→enforcing chain locally,
   * set `evidence_refs: ["anything"]`, and claim `{actor, role}` — the hash
   * chain only proves self-consistency, not independently verified observation
   * aggregates or authenticated authority. `verified: true` may only be set by
   * a caller that actually evaluated observation aggregates against policy
   * thresholds and resolved an authenticated authority (the engine transition
   * path). Default false → static `enforcing`/`retired` declarations are
   * rejected during config load.
   */
  verified?: boolean;
}

/**
 * Validate ordered config/materialize lineage for a declared effective state.
 *
 * Fail-closed for `enforcing` and `retired`:
 * - complete legal chain (no discontinuous / illegal edges)
 * - last event lands on the declared state
 * - `enforcing` requires the full draft→observe→required→enforcing path
 * - authority on enforcing/retired entries
 * - non-empty evidence_refs on observe→required and required→enforcing
 * - ISO 8601 `at` on every event
 * - policy_hash_before/after recomputed from the canonical acceptance slice
 * - consecutive hash continuity
 *
 * Self-attested single-head lineage with arbitrary strings is rejected.
 */
export function validateMaterializedLineage(input: MaterializeLineageInput): void {
  const policyId = input.policy_id.trim();
  const state = assertPolicyLifecycleState(input.state);
  const acceptance = input.acceptance ?? {};
  const lineage = input.lineage;
  const verified = input.verified === true;

  // Fail closed on unverified materialization (#695 66803fac): a static config
  // author can forge every field of a locally-consistent lineage (hashes,
  // evidence_refs, authority). Only an engine transition that actually resolved
  // observation aggregates against thresholds and authenticated authority may
  // mark `verified: true`. Without that provenance, enforcing/retired are
  // rejected outright — nothing in the chain is independently proven.
  if ((state === "enforcing" || state === "retired") && !verified) {
    throw new Error(
      `staged policy ${policyId}: state "${state}" requires verified promotion provenance; ` +
        `config-declared lineage cannot mint authority or proving evidence — ` +
        `materialize through the engine transition path or declare a non-enforcing state`,
    );
  }

  if (state === "enforcing" || state === "retired") {
    if (!lineage.length) {
      throw new Error(
        `staged policy ${policyId}: state "${state}" requires validated append-only lineage; ` +
          `static config cannot invent ${state} without a promotion/retirement chain`,
      );
    }
  }

  if (!lineage.length) return;

  const last = lineage[lineage.length - 1]!;
  if (last.to_state !== state) {
    throw new Error(
      `staged policy ${policyId}: lineage last to_state "${last.to_state}" does not match ` +
        `declared state "${state}"`,
    );
  }

  for (let i = 0; i < lineage.length; i++) {
    const e = lineage[i]!;
    if (e.policy_id !== policyId) {
      throw new Error(
        `staged policy ${policyId}: lineage[${i}].policy_id "${e.policy_id}" does not match`,
      );
    }
    if (!isLegalLifecycleEdge(e.from_state, e.to_state)) {
      throw new Error(
        `staged policy ${policyId}: lineage[${i}] illegal edge ${e.from_state} → ${e.to_state}`,
      );
    }
    if (!isIso8601Timestamp(e.at)) {
      throw new Error(
        `staged policy ${policyId}: lineage[${i}].at must be ISO 8601 date-time with zone; got ${JSON.stringify(e.at)}`,
      );
    }
    if (edgeRequiresAuthority(e.to_state) && !authorityPresent(e.authority)) {
      throw new Error(
        `staged policy ${policyId}: lineage[${i}] ${e.from_state} → ${e.to_state} requires named authority (actor + role)`,
      );
    }
    if (edgeRequiresEvidenceRefs(e.from_state, e.to_state)) {
      const refs = e.evidence_refs ?? [];
      if (!refs.some((r) => typeof r === "string" && r.trim().length > 0)) {
        throw new Error(
          `staged policy ${policyId}: lineage[${i}] ${e.from_state} → ${e.to_state} requires non-empty evidence_refs ` +
            `(observation/promotion evidence cannot be self-attested empty)`,
        );
      }
    }

    const expectedBefore = computeStagedPolicyHash({
      policy_id: policyId,
      state: e.from_state,
      acceptance,
    });
    const expectedAfter = computeStagedPolicyHash({
      policy_id: policyId,
      state: e.to_state,
      acceptance,
    });
    if (e.policy_hash_before !== expectedBefore) {
      throw new Error(
        `staged policy ${policyId}: lineage[${i}].policy_hash_before does not match recomputed hash ` +
          `for state "${e.from_state}" (forged or stale hash rejected)`,
      );
    }
    if (e.policy_hash_after !== expectedAfter) {
      throw new Error(
        `staged policy ${policyId}: lineage[${i}].policy_hash_after does not match recomputed hash ` +
          `for state "${e.to_state}" (forged or stale hash rejected)`,
      );
    }

    if (i > 0) {
      const prev = lineage[i - 1]!;
      if (prev.to_state !== e.from_state) {
        throw new Error(
          `staged policy ${policyId}: lineage discontinuous at [${i}]: ` +
            `prior to_state "${prev.to_state}" !== from_state "${e.from_state}"`,
        );
      }
      if (prev.policy_hash_after !== e.policy_hash_before) {
        throw new Error(
          `staged policy ${policyId}: lineage hash chain broken at [${i}]: ` +
            `prior policy_hash_after !== policy_hash_before`,
        );
      }
    }
  }

  if (state === "enforcing" || lineage.some((e) => e.to_state === "enforcing")) {
    if (!lineageContainsEnforcingPromotionPath(lineage)) {
      throw new Error(
        `staged policy ${policyId}: enforcing requires the complete predecessor chain ` +
          `draft→observe→required→enforcing with validated hashes and evidence; ` +
          `a self-attested required→enforcing head alone is rejected`,
      );
    }
  }

  if (state === "retired") {
    const retire = last;
    if (retire.to_state !== "retired" || !authorityPresent(retire.authority)) {
      throw new Error(
        `staged policy ${policyId}: state "retired" requires a final lineage event to retired ` +
          `with named authority; static config cannot retire without authority`,
      );
    }
  }
}

/**
 * True when lineage is a fully validated materialization into enforcing
 * (complete promotion path, recomputed hashes, authority, evidence_refs, ISO at).
 */
export function hasValidEnforcingPromotionLineage(
  policyId: string,
  lineage: readonly PolicyLineageEvent[],
  acceptance: Record<string, unknown> = {},
  verified = false,
): boolean {
  try {
    validateMaterializedLineage({
      policy_id: policyId,
      state: "enforcing",
      acceptance,
      lineage,
      verified,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject effective `enforcing` (and, when state is retired, unauthorized
 * retirement) without validated lineage. Prefer
 * {@link validateMaterializedLineage} when acceptance is available for hash recompute.
 *
 * @deprecated Callers with acceptance should use validateMaterializedLineage.
 * Kept for call sites that only pass policyId/state/lineage; uses empty acceptance.
 */
export function assertEnforcingLineage(
  policyId: string,
  state: PolicyLifecycleState,
  lineage: readonly PolicyLineageEvent[],
  acceptance: Record<string, unknown> = {},
): void {
  validateMaterializedLineage({
    policy_id: policyId,
    state,
    acceptance,
    lineage,
  });
}

export function createStagedPolicy(
  policyId: string,
  acceptance: Record<string, unknown> = {},
  initialState: PolicyLifecycleState = "draft",
  lineage: readonly PolicyLineageEvent[] = [],
): StagedPolicy {
  if (!policyId || typeof policyId !== "string" || !policyId.trim()) {
    throw new Error("policy_id must be a non-empty string");
  }
  const id = policyId.trim();
  const state = assertPolicyLifecycleState(initialState);
  const lineageCopy = lineage.map((e) => ({
    ...e,
    authority: e.authority ? { ...e.authority } : null,
    evidence_refs: [...(e.evidence_refs ?? [])],
  }));
  validateMaterializedLineage({
    policy_id: id,
    state,
    acceptance,
    lineage: lineageCopy,
  });
  return {
    policy_id: id,
    state,
    acceptance: { ...acceptance },
    lineage: lineageCopy,
    // Config/materialize can never mint promotion provenance (#695 66803fac).
    promotion_provenance: null,
  };
}

/** Config / decl shape for a staged policy (optional lineage for enforcing). */
export interface StagedPolicyDecl {
  policy_id: string;
  state: PolicyLifecycleState;
  acceptance?: Record<string, unknown>;
  lineage?: readonly PolicyLineageEvent[];
}

/**
 * Materialize a StagedPolicy from a config declaration. Fails closed when
 * state is enforcing/retired without a fully validated lineage chain.
 */
export function stagedPolicyFromDecl(decl: StagedPolicyDecl): StagedPolicy {
  return createStagedPolicy(
    decl.policy_id,
    decl.acceptance ?? {},
    decl.state,
    decl.lineage ?? [],
  );
}

export function stagedPoliciesFromDecls(
  decls: readonly StagedPolicyDecl[] | undefined,
): StagedPolicy[] {
  if (!decls?.length) return [];
  return decls.map((d) => stagedPolicyFromDecl(d));
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
    // Engine-attested promotion provenance (#695 66803fac): only the transition
    // path that actually evaluated observation aggregates against thresholds
    // and resolved an authenticated authority may attach this token. Config
    // materialization never sets it.
    promotion_provenance:
      to === "enforcing" && authorityPresent(input.authority)
        ? {
            kind: "engine-transition",
            policy_hash: hashAfter,
            actor: (input.authority as PolicyAuthorityRecord).actor,
            role: (input.authority as PolicyAuthorityRecord).role,
            observed_at: input.at,
          }
        : null,
  };

  return { ok: true, policy: next, event };
}

/** True when lineage contains an entry into enforcing (invariant for enforcing state). */
export function hasEnforcingLineage(policy: StagedPolicy): boolean {
  return policy.lineage.some((e) => e.to_state === "enforcing");
}

/**
 * Invariant check: an enforcing effective state MUST carry engine-attested
 * promotion provenance (transition-evaluated observation + authority) AND a
 * fully validated promotion lineage. Returns false when the invariant is
 * broken (config bypass or forged record).
 */
export function enforcingStateHasLineage(policy: StagedPolicy): boolean {
  if (policy.state !== "enforcing") return true;
  const prov = policy.promotion_provenance;
  if (!prov || prov.kind !== "engine-transition") return false;
  // Provenance must match the current hash — a stale/forged token fails closed.
  if (prov.policy_hash !== effectivePolicyHash(policy)) return false;
  return hasValidEnforcingPromotionLineage(
    policy.policy_id,
    policy.lineage,
    policy.acceptance,
    true,
  );
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
