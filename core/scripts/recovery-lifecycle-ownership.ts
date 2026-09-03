// Closed RecoverySupervisor lifecycle-state law (#1322).
//
// Lives next to operation-observation types. Adapters still emit observations;
// this module is the sole mapping from observations, compatibility labels,
// ledger.stop projections, and typed-request evidence onto the six lifecycle
// states. It is not a second RecoverySupervisor, classifier, inventory,
// observer package, grant schema, scheduler, or public CLI verb.
//
// Reuses COMMAND_FORM_INVENTORY, typed-request-resolution, and existing
// observer invariants. Do not add a fourth execution_disposition.

import {
  COMMAND_FORM_INVENTORY,
  lookupCommandForm,
  type ExecutionDisposition,
} from "./command-form-inventory.ts";
import { COMMAND_REGISTRY } from "./command-registry.ts";
import { OPERATION_SURFACE } from "./operation-surface.ts";
import {
  PUBLIC_TYPED_REQUESTS,
  type PublicTypedRequest,
} from "./typed-request-resolution.ts";
import type { LoopCoolingRecord, LoopStopRecord } from "./loop/types.ts";

export const RECOVERY_LIFECYCLE_STATES = [
  "active",
  "cooling",
  "external-condition-wait",
  "typed-input-wait",
  "succeeded",
  "cancelled",
] as const;

export type RecoveryLifecycleState = (typeof RECOVERY_LIFECYCLE_STATES)[number];

export const MECHANICAL_FAULT_CLASSES = [
  "mechanical-failure",
  "unknown-failure",
  "malformed-output",
  "process-death",
  "no-progress",
  "capacity",
  "retry-exhaustion",
] as const;

export type MechanicalFaultClass = (typeof MECHANICAL_FAULT_CLASSES)[number];

/** Historical stop reasons that project Cooling, never human ownership. */
export const MECHANICAL_COMPATIBILITY_STOP_REASONS = [
  "run_fatal",
  "recovery_exhausted",
  "repeated_no_progress",
  "consecutive_blocked",
  "supervisor_no_progress",
  "supervisor_cycle_cap",
  "worktree_capacity",
] as const;

export type MechanicalCompatibilityStopReason =
  (typeof MECHANICAL_COMPATIBILITY_STOP_REASONS)[number];

export const AUTHORITATIVE_OBSERVER_SYSTEMS = [
  "git",
  "forge",
  "checks",
  "reviews",
  "merge",
  "release",
  "deploy",
  "orchestration",
] as const;

export type AuthoritativeObserverSystem = (typeof AUTHORITATIVE_OBSERVER_SYSTEMS)[number];

export const LEGACY_TERMINAL_MIGRATION = {
  run_fatal: "cooling",
  recovery_exhausted: "cooling",
  repeated_no_progress: "cooling",
  cycle_caps: "cooling",
  blocked: "cooling",
  "needs-human": "typed-input-wait",
} as const satisfies Record<string, RecoveryLifecycleState>;

export interface LifecycleOwnership {
  state: RecoveryLifecycleState;
  owned: true;
  ownerless: false;
  human_owned: false;
  cancelled: boolean;
  human_authority: boolean;
  typed_request: PublicTypedRequest | null;
}

/** Durable RecoverySupervisor record for one admitted Logical Operation. */
export interface DurableLifecycleRecord extends LifecycleOwnership {
  logical_operation_id: string;
  updated_at: string;
  revision: number;
}

export interface LifecycleDerivationInput {
  labels?: readonly string[];
  typedRequest?: PublicTypedRequest | null;
  stopReason?: string | null;
  cooling?: boolean;
  trainOutcome?: string | null;
  observerProvedPostcondition?: boolean;
  processExitCode?: number | null;
  cancelledByAuthenticatedCaller?: boolean;
  cancelledByOriginalAuthorizedCaller?: boolean;
  activeAttempt?: boolean;
  externalConditionWait?: boolean;
  faultClass?: MechanicalFaultClass | null;
}

const MECHANICAL_STOP_SET: ReadonlySet<string> = new Set(MECHANICAL_COMPATIBILITY_STOP_REASONS);

export function isRecoveryLifecycleState(value: unknown): value is RecoveryLifecycleState {
  return typeof value === "string" && (RECOVERY_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function assertRecoveryLifecycleState(value: unknown): RecoveryLifecycleState {
  if (!isRecoveryLifecycleState(value)) {
    throw new Error(
      `invalid recovery lifecycle state ${JSON.stringify(value)}; expected one of ${RECOVERY_LIFECYCLE_STATES.join("|")}`,
    );
  }
  return value;
}

export function isMechanicalFaultClass(value: unknown): value is MechanicalFaultClass {
  return typeof value === "string" && (MECHANICAL_FAULT_CLASSES as readonly string[]).includes(value);
}

export function isMechanicalCompatibilityStopReason(
  reason: string | null | undefined,
): reason is MechanicalCompatibilityStopReason {
  return typeof reason === "string" && MECHANICAL_STOP_SET.has(reason);
}

function owned(state: RecoveryLifecycleState, extra?: Partial<LifecycleOwnership>): LifecycleOwnership {
  return {
    state,
    owned: true,
    ownerless: false,
    human_owned: false,
    cancelled: state === "cancelled",
    human_authority: extra?.human_authority === true,
    typed_request: extra?.typed_request ?? null,
  };
}

const TERMINAL_LIFECYCLE_STATES: ReadonlySet<RecoveryLifecycleState> = new Set(["succeeded", "cancelled"]);

function ownershipFromRecord(record: DurableLifecycleRecord): LifecycleOwnership {
  return {
    state: record.state,
    owned: true,
    ownerless: false,
    human_owned: false,
    cancelled: record.cancelled,
    human_authority: record.human_authority,
    typed_request: record.typed_request,
  };
}

function sameOwnership(record: DurableLifecycleRecord, next: LifecycleOwnership): boolean {
  return (
    record.state === next.state &&
    record.cancelled === next.cancelled &&
    record.human_authority === next.human_authority &&
    record.typed_request === next.typed_request
  );
}

/** Admit a Logical Operation into RecoverySupervisor ownership as `active`. */
export function admitLifecycleRecord(input: {
  logical_operation_id: string;
  updated_at: string;
}): DurableLifecycleRecord {
  const logical_operation_id = input.logical_operation_id.trim();
  if (!logical_operation_id) {
    throw new Error("lifecycle record: logical_operation_id is required");
  }
  return {
    logical_operation_id,
    ...owned("active"),
    updated_at: input.updated_at,
    revision: 1,
  };
}

/**
 * Apply a lawful lifecycle transition. `succeeded` and `cancelled` are sticky.
 * Admission (no current record) writes revision 1.
 */
export function applyLifecycleTransition(
  current: DurableLifecycleRecord | null | undefined,
  next: LifecycleOwnership,
  updated_at: string,
  logical_operation_id: string,
): DurableLifecycleRecord {
  const id = (current?.logical_operation_id ?? logical_operation_id).trim();
  if (!current) {
    return {
      logical_operation_id: id,
      ...next,
      updated_at,
      revision: 1,
    };
  }
  if (TERMINAL_LIFECYCLE_STATES.has(current.state) && next.state !== current.state) {
    return current;
  }
  if (sameOwnership(current, next)) return current;
  return {
    logical_operation_id: current.logical_operation_id,
    ...next,
    updated_at,
    revision: current.revision + 1,
  };
}

/**
 * Consult the durable ownership record plus current typed-request evidence.
 * Compatibility labels and process exits are not lifecycle truth.
 */
export function consultLifecycleRecord(
  record: DurableLifecycleRecord | null | undefined,
  evidence: LifecycleDerivationInput = {},
): LifecycleOwnership {
  if (evidence.cancelledByAuthenticatedCaller === true || evidence.cancelledByOriginalAuthorizedCaller === true) {
    return owned("cancelled");
  }
  if (evidence.observerProvedPostcondition === true) {
    return owned("succeeded");
  }
  if (isPublicTypedRequest(evidence.typedRequest)) {
    return owned("typed-input-wait", {
      human_authority: evidence.typedRequest === "AuthorityRequest",
      typed_request: evidence.typedRequest,
    });
  }
  if (!record) {
    return deriveLifecycleState(evidence);
  }
  if (record.state === "typed-input-wait") {
    return deriveLifecycleState({ ...evidence, typedRequest: null });
  }
  return ownershipFromRecord(record);
}

/** Bind the closed lifecycle record onto a ledger-shaped document. */
export function bindLifecycleRecord<T extends { lifecycle?: DurableLifecycleRecord | null }>(
  ledger: T,
  logicalOperationId: string,
  ownership: LifecycleOwnership,
  updated_at: string,
): T {
  const lifecycle = applyLifecycleTransition(ledger.lifecycle, ownership, updated_at, logicalOperationId);
  if (ledger.lifecycle === lifecycle) return ledger;
  return { ...ledger, lifecycle };
}

const OBSERVER_SUCCESS_ITEM_STATES: ReadonlySet<string> = new Set([
  "ready",
  "merged",
  "released",
  "deployed",
]);

/** Default freshness window for stored per-item observer proof. Loop callers
 *  MUST pass the native-goal freshness window via `facts.freshnessWindowSeconds`. */
export const OBSERVER_PROOF_FRESHNESS_WINDOW_SECONDS = 300;

/** Stored identity facts that can prove an observer-success item state. */
export interface ObserverSuccessIdentityFacts {
  observed_at?: string;
  pr_number?: number | null;
  pr_state?: string | null;
  ready_label_present?: boolean;
}

export interface LifecycleOwnedItemFacts {
  state: string;
  hold_request?: { typed_request?: string } | null | undefined;
  last_verified_identity?: ObserverSuccessIdentityFacts | null | undefined;
}

/** True when `identity` currently proves `state` as an observer-success terminal. */
export function identityProvesObserverSuccessState(
  state: string,
  identity: ObserverSuccessIdentityFacts | null | undefined,
  nowMs?: number,
  freshnessWindowSeconds: number = OBSERVER_PROOF_FRESHNESS_WINDOW_SECONDS,
): boolean {
  if (!identity || !OBSERVER_SUCCESS_ITEM_STATES.has(state)) return false;
  if (nowMs !== undefined) {
    const ageSeconds = (nowMs - Date.parse(identity.observed_at ?? "")) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > freshnessWindowSeconds) {
      return false;
    }
  }
  switch (state) {
    case "ready":
      return identity.pr_number != null && identity.pr_state === "open" && identity.ready_label_present === true;
    case "merged":
      return identity.pr_state === "merged";
    case "released":
    case "deployed":
      return false;
    default:
      return false;
  }
}

/** Current typed request on any owned item, if present. */
export function typedRequestFromOwnedItems(
  items: Record<string, { hold_request?: { typed_request?: string } | null | undefined }>,
): PublicTypedRequest | null {
  for (const item of Object.values(items)) {
    const typed = item.hold_request?.typed_request;
    if (isPublicTypedRequest(typed)) return typed;
  }
  return null;
}

/**
 * Derive lifecycle ownership from the item states that a lawful transition
 * just wrote, plus observer-proof and cooling facts. `succeeded` requires
 * observer proof and current authoritative proof for every success-terminal
 * item — stored sibling state is not proof.
 */
export function lifecycleOwnershipAfterItemTransition(
  items: Record<string, LifecycleOwnedItemFacts>,
  facts: {
    cooling?: boolean;
    stopReason?: string | null;
    observerProvedPostcondition?: boolean;
    activeAttempt?: boolean;
    nowMs?: number;
    freshnessWindowSeconds?: number;
  },
): LifecycleOwnership {
  const list = Object.values(items);
  const windowSeconds = facts.freshnessWindowSeconds ?? OBSERVER_PROOF_FRESHNESS_WINDOW_SECONDS;
  const allCurrentSuccessProof =
    list.length > 0 &&
    list.every((item) =>
      identityProvesObserverSuccessState(
        item.state,
        item.last_verified_identity,
        facts.nowMs,
        windowSeconds,
      ),
    );
  return deriveLifecycleState({
    typedRequest: typedRequestFromOwnedItems(items),
    cooling: facts.cooling,
    stopReason: facts.stopReason,
    observerProvedPostcondition: facts.observerProvedPostcondition === true && allCurrentSuccessProof,
    activeAttempt: facts.activeAttempt,
  });
}

/** Recovery recipes are refused only after a lawful lifecycle exit. */
export function lifecycleAllowsRecoveryRecipe(
  record: DurableLifecycleRecord | null | undefined,
): boolean {
  const life = consultLifecycleRecord(record);
  return life.state !== "cancelled" && life.state !== "succeeded";
}

function hasNeedsHumanLabel(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((l) => l === "pipeline:needs-human" || l === "needs-human");
}

function hasBlockedLabel(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((l) => l === "pipeline:blocked" || l === "blocked");
}

function isPublicTypedRequest(value: unknown): value is PublicTypedRequest {
  return typeof value === "string" && (PUBLIC_TYPED_REQUESTS as readonly string[]).includes(value);
}

/**
 * Derive RecoverySupervisor lifecycle state from durable records and current
 * typed-request evidence. Compatibility labels, ledger.stop.reason, train STOP,
 * and process exits project from that state and are not lifecycle truth.
 */
export function deriveLifecycleState(input: LifecycleDerivationInput): LifecycleOwnership {
  if (input.cancelledByAuthenticatedCaller === true || input.cancelledByOriginalAuthorizedCaller === true) {
    return owned("cancelled");
  }

  if (input.observerProvedPostcondition === true) {
    return owned("succeeded");
  }

  if (isPublicTypedRequest(input.typedRequest)) {
    return owned("typed-input-wait", {
      human_authority: input.typedRequest === "AuthorityRequest",
      typed_request: input.typedRequest,
    });
  }

  // Leftover needs-human / blocked labels without a typed request are false-human.
  if (input.externalConditionWait === true) {
    return owned("external-condition-wait");
  }

  if (input.faultClass && isMechanicalFaultClass(input.faultClass)) {
    return input.faultClass === "capacity" ? owned("external-condition-wait") : owned("cooling");
  }

  if (isMechanicalCompatibilityStopReason(input.stopReason) || input.cooling === true) {
    return input.stopReason === "worktree_capacity"
      ? owned("external-condition-wait")
      : owned("cooling");
  }

  if (input.trainOutcome === "STOP") {
    return owned("cooling");
  }

  if (hasNeedsHumanLabel(input.labels) || hasBlockedLabel(input.labels)) {
    return owned("cooling");
  }

  if (input.activeAttempt === true) {
    return owned("active");
  }

  if (input.processExitCode === 0 && input.observerProvedPostcondition !== true) {
    return owned("cooling");
  }

  return owned("cooling");
}

/** Process exit is ingress evidence. Exit 0 without observer proof is not succeeded. */
export function lifecycleAfterProcessExit(input: {
  exitCode: number | null | undefined;
  observerProvedPostcondition: boolean;
  observerSystem?: AuthoritativeObserverSystem | null;
}): LifecycleOwnership {
  void input.observerSystem;
  if (input.observerProvedPostcondition) return owned("succeeded");
  return owned("cooling");
}

export function lifecycleForMechanicalFault(fault: MechanicalFaultClass): LifecycleOwnership {
  return deriveLifecycleState({ faultClass: fault });
}

/**
 * A raw adapter failure is none of DecisionRequest, CapabilityRequest, or
 * AuthorityRequest. Classifier evidence is required for typed-input wait.
 */
export function typedRequestForRawFailure(): null {
  return null;
}

export function compatibilityStopAllowsIndependentSiblings(
  reason: string | null | undefined,
): boolean {
  return isMechanicalCompatibilityStopReason(reason);
}

/** True when this item's recovery recipes must wait for a later wake. */
export function compatibilityStopRefusesItem(
  stop: { reason: string; item_id?: string } | null | undefined,
  itemId: string,
): boolean {
  if (!stop) return false;
  if (!isMechanicalCompatibilityStopReason(stop.reason)) return true;
  return stop.item_id === itemId;
}

export function coolingRecordFromCompatibilityStop(stop: {
  reason: string;
  time: string;
  item_id?: string;
  theme?: string;
}): LoopCoolingRecord {
  const historical =
    stop.reason === "recovery_exhausted" || stop.reason === "run_fatal" || stop.reason === "repeated_no_progress"
      ? stop.reason
      : undefined;
  return {
    reason: "mechanical_exhaustion",
    time: stop.time,
    ...(stop.item_id ? { item_id: stop.item_id } : {}),
    ...(stop.theme ? { theme: stop.theme } : {}),
    ...(historical ? { historical_evidence: historical } : {}),
  };
}

/**
 * Cycle-result projection: mechanical compatibility stops are Cooling.
 * Independent siblings remain schedulable. The ledger.stop field may remain.
 */
export function supervisorCycleDispositionForStop(input: {
  stop: LoopStopRecord | null | undefined;
  hasSchedulableSibling: boolean;
}): { stop: LoopStopRecord | null; cooling: LoopCoolingRecord | null; continueSiblings: boolean } {
  const stop = input.stop ?? null;
  if (!stop) return { stop: null, cooling: null, continueSiblings: false };
  if (!isMechanicalCompatibilityStopReason(stop.reason)) {
    return { stop, cooling: null, continueSiblings: false };
  }
  if (input.hasSchedulableSibling) {
    return { stop: null, cooling: null, continueSiblings: true };
  }
  return {
    stop: null,
    cooling: coolingRecordFromCompatibilityStop(stop),
    continueSiblings: false,
  };
}

export function mutatingSurfaceVerbsMissingInventory(
  surfaceNames: readonly string[] = OPERATION_SURFACE.map((op) => op.name),
): string[] {
  const keywords = new Set(COMMAND_FORM_INVENTORY.map((f) => f.keyword));
  return surfaceNames.filter((name) => name.trim() && !keywords.has(name));
}

export function executionDispositionForForm(formId: string): ExecutionDisposition | undefined {
  return lookupCommandForm(formId)?.execution_disposition;
}

/** No public lifecycle / RecoverySupervisor / inventory CLI verb is registered. */
export const FORBIDDEN_PUBLIC_LIFECYCLE_VERBS = [
  "lifecycle",
  "recovery-supervisor",
  "inventory",
  "cooling",
] as const;

export function registeredForbiddenLifecycleVerbs(
  registry: Record<string, unknown> = COMMAND_REGISTRY,
): string[] {
  return FORBIDDEN_PUBLIC_LIFECYCLE_VERBS.filter((verb) => verb in registry);
}

export function observerCatalogHas(system: AuthoritativeObserverSystem): boolean {
  return (AUTHORITATIVE_OBSERVER_SYSTEMS as readonly string[]).includes(system);
}
