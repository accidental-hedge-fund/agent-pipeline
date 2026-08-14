// Planning-leverage telemetry schema (#702).
//
// Versioned additive records for phase boundaries, selected planning depth /
// risk class, durations (elapsed vs active effort), assumption lineage,
// material rework, and optional snapshots. No collapsed productivity score.
//
// Privacy: free text is redacted before serialize. Default durable storage is
// host-local under `.agent-pipeline/` (run events.jsonl + optional snapshot).
// Customer-hosted installs do not require a fleet collector. Retention follows
// the configured run/evidence window used by scoreboard.

import { redactSecrets, sanitize } from "../artifact-sanitize.ts";
import {
  isPlaceholderIdentity,
  normalizeFullSha,
  type AttributionAuthority,
  type AttributionMethod,
} from "../outcomes/schema.ts";
import { PRE_CODE_ATTESTATION_TRIGGER_CLASSES } from "../types.ts";

// ---------------------------------------------------------------------------
// Schema version + closed enums
// ---------------------------------------------------------------------------

export const PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION = 1 as const;

/** Additive events.jsonl types for this family (stream schema_version stays 1). */
export const PLANNING_LEVERAGE_EVENT_TYPES = [
  "planning_leverage_phase",
  "assumption_lineage",
  "material_rework",
  "planning_leverage_snapshot",
] as const;
export type PlanningLeverageEventType = (typeof PLANNING_LEVERAGE_EVENT_TYPES)[number];

export const DELIVERY_PHASES = [
  "alignment",
  "planning",
  "implementation",
  "review",
  "correction",
] as const;
export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

export const PHASE_BOUNDARIES = ["start", "end"] as const;
export type PhaseBoundary = (typeof PHASE_BOUNDARIES)[number];

export const PLANNING_DEPTHS = ["minimal", "standard", "deep", "unknown"] as const;
export type PlanningDepth = (typeof PLANNING_DEPTHS)[number];

/** Built-in risk classes + unknown (reuses pre-code vocabulary for stable joins). */
export const RISK_CLASSES = [
  ...PRE_CODE_ATTESTATION_TRIGGER_CLASSES,
  "unknown",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const ELAPSED_AVAILABILITIES = ["observed", "unavailable"] as const;
export type ElapsedAvailability = (typeof ELAPSED_AVAILABILITIES)[number];

export const ACTIVE_EFFORT_SOURCES = [
  "harness_accounted",
  "operator_reported",
  "derived",
  "unknown",
] as const;
export type ActiveEffortSource = (typeof ACTIVE_EFFORT_SOURCES)[number];

export const VALUE_AVAILABILITIES = ["observed", "inferred", "unavailable"] as const;
export type ValueAvailability = (typeof VALUE_AVAILABILITIES)[number];

export const COST_SOURCES = ["actual", "estimated", "unknown"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const MATERIALITIES = ["material", "ordinary", "unknown"] as const;
export type Materiality = (typeof MATERIALITIES)[number];

export const MATERIAL_CRITERIA = [
  "scope_expansion",
  "design_interface_change",
  "replan_or_assumption_reopen",
  "multi_round_blocking",
] as const;
export type MaterialCriterion = (typeof MATERIAL_CRITERIA)[number];

export const ASSUMPTION_KINDS = ["assumption", "open_question"] as const;
export type AssumptionKind = (typeof ASSUMPTION_KINDS)[number];

export const ASSUMPTION_STATUSES = [
  "open",
  "resolved",
  "invalidated",
  "deferred",
  "unknown",
] as const;
export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];

export const ATTRIBUTION_TARGET_TYPES_PL = [
  "run",
  "commit",
  "pr",
  "issue",
  "component",
  "production_outcome",
] as const;
export type PlanningLeverageAttributionTargetType =
  (typeof ATTRIBUTION_TARGET_TYPES_PL)[number];

// ---------------------------------------------------------------------------
// Shared nested shapes
// ---------------------------------------------------------------------------

export interface ActiveEffort {
  value_ms: number | null;
  source: ActiveEffortSource;
  availability: ValueAvailability;
}

export interface DurationFields {
  started_at: string | null;
  ended_at: string | null;
  elapsed_ms: number | null;
  elapsed_availability: ElapsedAvailability;
  active_effort: ActiveEffort;
}

export interface ReviewEffort {
  findings_blocking: number | null;
  findings_advisory: number | null;
  re_review_count: number | null;
  /** Per-counter availability; absent counters use unavailable. */
  availability: {
    findings_blocking: ValueAvailability;
    findings_advisory: ValueAvailability;
    re_review_count: ValueAvailability;
  };
}

export interface CostFields {
  cost_usd: number | null;
  cost_source: CostSource;
}

export interface PlanningLeverageAttribution {
  target_type: PlanningLeverageAttributionTargetType;
  target_id: string;
  method: AttributionMethod;
  authority: AttributionAuthority;
  confidence?: number | null;
  note?: string | null;
}

export interface DerivedMetric {
  value: number | null;
  availability: ValueAvailability;
  inputs: string[];
  note?: string | null;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  issues: ValidationIssue[];
  value: T | null;
}

// ---------------------------------------------------------------------------
// Record payloads (record_schema_version nested; stream uses schema_version: 1)
// ---------------------------------------------------------------------------

export interface PlanningLeveragePhasePayload {
  record_schema_version: typeof PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION;
  type: "planning_leverage_phase";
  run_id: string;
  issue: number | null;
  phase: DeliveryPhase;
  phase_instance_id: string;
  boundary: PhaseBoundary;
  planning_depth: PlanningDepth;
  risk_class: RiskClass;
  risk_classes?: RiskClass[];
  started_at: string | null;
  ended_at: string | null;
  elapsed_ms: number | null;
  elapsed_availability: ElapsedAvailability;
  active_effort: ActiveEffort;
  cost?: CostFields;
  review_effort?: ReviewEffort;
  fix_rounds?: number | null;
  attribution?: PlanningLeverageAttribution[];
  pipeline_stage?: string | null;
}

export interface AssumptionResolution {
  note: string | null;
  resolved_in_phase: DeliveryPhase | null;
}

export interface AssumptionLineagePayload {
  record_schema_version: typeof PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION;
  type: "assumption_lineage";
  run_id: string;
  issue: number | null;
  assumption_id: string;
  kind: AssumptionKind;
  statement: string;
  introduced_phase: DeliveryPhase;
  status: AssumptionStatus;
  status_updated_at: string;
  resolution?: AssumptionResolution | null;
  evidence_refs?: string[];
}

export interface MaterialReworkPayload {
  record_schema_version: typeof PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION;
  type: "material_rework";
  run_id: string;
  issue: number | null;
  materiality: Materiality;
  material_criteria: MaterialCriterion[];
  fix_round: number | null;
  review_effort: ReviewEffort;
  phase_instance_id?: string | null;
  evidence_refs?: string[];
  attribution?: PlanningLeverageAttribution[];
  started_at?: string | null;
  ended_at?: string | null;
  elapsed_ms?: number | null;
  elapsed_availability?: ElapsedAvailability;
  active_effort?: ActiveEffort;
  cost?: CostFields;
}

export interface PlanningLeverageSnapshotPayload {
  record_schema_version: typeof PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION;
  type: "planning_leverage_snapshot";
  run_id: string;
  issue: number | null;
  phase: DeliveryPhase | null;
  phase_instance_id: string | null;
  planning_depth: PlanningDepth;
  risk_class: RiskClass;
  risk_classes?: RiskClass[];
  /** Raw/observed phase elapsed totals by phase (ms); only observed sums. */
  phase_elapsed_ms: Partial<Record<DeliveryPhase, number>>;
  phase_elapsed_availability: Partial<Record<DeliveryPhase, ElapsedAvailability>>;
  review_effort: ReviewEffort;
  fix_rounds: number | null;
  assumption_counts: {
    open: number;
    deferred: number;
    resolved: number;
    invalidated: number;
    unknown: number;
  };
  materiality_counts: Record<Materiality, number>;
  attribution: PlanningLeverageAttribution[];
  linkage_diagnostics: string[];
  /** Derived metrics only — never the sole store of raw observations. */
  derived: Record<string, DerivedMetric>;
}

// ---------------------------------------------------------------------------
// Stream event shapes (base schema_version remains 1)
// ---------------------------------------------------------------------------

interface StreamEventBase {
  schema_version: 1;
  type: PlanningLeverageEventType;
  at: string;
}

export interface PlanningLeveragePhaseEvent
  extends StreamEventBase, PlanningLeveragePhasePayload {
  type: "planning_leverage_phase";
}

export interface AssumptionLineageEvent
  extends StreamEventBase, AssumptionLineagePayload {
  type: "assumption_lineage";
}

export interface MaterialReworkEvent extends StreamEventBase, MaterialReworkPayload {
  type: "material_rework";
}

export interface PlanningLeverageSnapshotEvent
  extends StreamEventBase, PlanningLeverageSnapshotPayload {
  type: "planning_leverage_snapshot";
}

export type PlanningLeverageFamilyEvent =
  | PlanningLeveragePhaseEvent
  | AssumptionLineageEvent
  | MaterialReworkEvent
  | PlanningLeverageSnapshotEvent;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function redactFreeText(text: string, maxLen = 500): string {
  return sanitize(redactSecrets(text)).slice(0, maxLen);
}

export { isPlaceholderIdentity, normalizeFullSha };

/** Unavailable active effort — never 0 or elapsed-as-default. */
export function unavailableActiveEffort(): ActiveEffort {
  return {
    value_ms: null,
    source: "unknown",
    availability: "unavailable",
  };
}

export function emptyReviewEffort(): ReviewEffort {
  return {
    findings_blocking: null,
    findings_advisory: null,
    re_review_count: null,
    availability: {
      findings_blocking: "unavailable",
      findings_advisory: "unavailable",
      re_review_count: "unavailable",
    },
  };
}

export function observedReviewEffort(args: {
  findings_blocking: number;
  findings_advisory: number;
  re_review_count: number;
}): ReviewEffort {
  return {
    findings_blocking: args.findings_blocking,
    findings_advisory: args.findings_advisory,
    re_review_count: args.re_review_count,
    availability: {
      findings_blocking: "observed",
      findings_advisory: "observed",
      re_review_count: "observed",
    },
  };
}

export function unknownCost(): CostFields {
  return { cost_usd: null, cost_source: "unknown" };
}

/**
 * Compute elapsed from explicit timestamps. Never invents missing ends.
 * Returns null elapsed + unavailable when either timestamp is missing.
 */
export function computeElapsed(
  started_at: string | null | undefined,
  ended_at: string | null | undefined,
): Pick<DurationFields, "elapsed_ms" | "elapsed_availability"> {
  if (
    typeof started_at !== "string" ||
    !started_at ||
    typeof ended_at !== "string" ||
    !ended_at
  ) {
    return { elapsed_ms: null, elapsed_availability: "unavailable" };
  }
  const startMs = Date.parse(started_at);
  const endMs = Date.parse(ended_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { elapsed_ms: null, elapsed_availability: "unavailable" };
  }
  return { elapsed_ms: endMs - startMs, elapsed_availability: "observed" };
}

export function makeActiveEffort(args: {
  value_ms: number | null | undefined;
  source?: ActiveEffortSource;
  availability?: ValueAvailability;
}): ActiveEffort {
  const availability = args.availability ?? (args.value_ms == null ? "unavailable" : "observed");
  if (availability === "unavailable") {
    return unavailableActiveEffort();
  }
  if (args.value_ms == null || !Number.isFinite(args.value_ms) || args.value_ms < 0) {
    return unavailableActiveEffort();
  }
  return {
    value_ms: args.value_ms,
    source: args.source ?? "unknown",
    availability,
  };
}

/** Map pipeline stage name → delivery phase, or null when unmapped. */
export function mapStageToPhase(stage: string): DeliveryPhase | null {
  switch (stage) {
    case "ready":
    case "pre-code-attestation":
      return "alignment";
    case "planning":
    case "plan-review":
      return "planning";
    case "implementing":
    case "design-gate":
      return "implementation";
    case "review-1":
    case "review-2":
    case "pre-merge":
      return "review";
    case "fix-1":
    case "fix-2":
      return "correction";
    default:
      return null;
  }
}

/** Stable phase_instance_id for a phase interval (run-scoped). */
export function makePhaseInstanceId(args: {
  run_id: string;
  phase: DeliveryPhase;
  started_at: string;
}): string {
  return `${args.run_id}:${args.phase}:${args.started_at}`;
}

export function makeAttribution(args: {
  target_type: PlanningLeverageAttributionTargetType;
  target_id: string;
  method: AttributionMethod;
  authority: AttributionAuthority;
  confidence?: number | null;
  note?: string | null;
}): PlanningLeverageAttribution | null {
  if (!args.target_id || isPlaceholderIdentity(args.target_id)) return null;
  if (args.target_type === "commit") {
    const sha = normalizeFullSha(args.target_id);
    if (!sha) return null;
    return {
      target_type: "commit",
      target_id: sha,
      method: args.method,
      authority: args.authority,
      confidence: args.confidence ?? null,
      note: args.note ? redactFreeText(args.note, 200) : null,
    };
  }
  return {
    target_type: args.target_type,
    target_id: String(args.target_id).trim(),
    method: args.method,
    authority: args.authority,
    confidence: args.confidence ?? null,
    note: args.note ? redactFreeText(args.note, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// Validators / builders
// ---------------------------------------------------------------------------

function validateActiveEffort(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): ActiveEffort {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return unavailableActiveEffort();
  }
  const o = raw as Record<string, unknown>;
  if (!isOneOf(o.availability, VALUE_AVAILABILITIES)) {
    issues.push({ path: `${path}.availability`, message: "invalid availability" });
    return unavailableActiveEffort();
  }
  if (!isOneOf(o.source, ACTIVE_EFFORT_SOURCES)) {
    issues.push({ path: `${path}.source`, message: "invalid source" });
  }
  if (o.availability === "unavailable") {
    // Refuse silent zero-fill or elapsed copy: force null value.
    if (o.value_ms !== null && o.value_ms !== undefined) {
      if (o.value_ms === 0) {
        issues.push({
          path: `${path}.value_ms`,
          message: "unavailable active effort must not use 0 to mean unknown",
        });
      }
    }
    return unavailableActiveEffort();
  }
  if (o.value_ms !== null && (typeof o.value_ms !== "number" || !Number.isFinite(o.value_ms) || o.value_ms < 0)) {
    issues.push({ path: `${path}.value_ms`, message: "must be non-negative number or null" });
    return unavailableActiveEffort();
  }
  return {
    value_ms: o.value_ms === null || o.value_ms === undefined ? null : Number(o.value_ms),
    source: isOneOf(o.source, ACTIVE_EFFORT_SOURCES) ? o.source : "unknown",
    availability: o.availability,
  };
}

function validateReviewEffort(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): ReviewEffort {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyReviewEffort();
  }
  const o = raw as Record<string, unknown>;
  const availRaw =
    o.availability && typeof o.availability === "object" && !Array.isArray(o.availability)
      ? (o.availability as Record<string, unknown>)
      : {};
  const parseCounter = (
    key: "findings_blocking" | "findings_advisory" | "re_review_count",
  ): { value: number | null; availability: ValueAvailability } => {
    const avail = isOneOf(availRaw[key], VALUE_AVAILABILITIES)
      ? availRaw[key]
      : o[key] == null
        ? "unavailable"
        : "observed";
    if (avail === "unavailable") {
      if (o[key] === 0) {
        // 0 with explicit observed availability is allowed; 0 used as unknown is not.
        // When availability is unavailable, force null (reject 0-as-unknown).
        issues.push({
          path: `${path}.${key}`,
          message: "unavailable counter must be null, not 0",
        });
      }
      return { value: null, availability: "unavailable" };
    }
    if (o[key] === null || o[key] === undefined) {
      return { value: null, availability: avail };
    }
    if (typeof o[key] !== "number" || !Number.isInteger(o[key]) || (o[key] as number) < 0) {
      issues.push({ path: `${path}.${key}`, message: "must be non-negative integer or null" });
      return { value: null, availability: "unavailable" };
    }
    return { value: o[key] as number, availability: avail };
  };
  const b = parseCounter("findings_blocking");
  const a = parseCounter("findings_advisory");
  const r = parseCounter("re_review_count");
  return {
    findings_blocking: b.value,
    findings_advisory: a.value,
    re_review_count: r.value,
    availability: {
      findings_blocking: b.availability,
      findings_advisory: a.availability,
      re_review_count: r.availability,
    },
  };
}

function validateAttributionList(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): PlanningLeverageAttribution[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path, message: "must be an array" });
    return [];
  }
  const out: PlanningLeverageAttribution[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      issues.push({ path: `${path}[${i}]`, message: "must be object" });
      continue;
    }
    const o = entry as Record<string, unknown>;
    if (!isOneOf(o.target_type, ATTRIBUTION_TARGET_TYPES_PL)) {
      issues.push({ path: `${path}[${i}].target_type`, message: "invalid target_type" });
      continue;
    }
    if (typeof o.target_id !== "string" || isPlaceholderIdentity(o.target_id)) {
      issues.push({
        path: `${path}[${i}].target_id`,
        message: "missing or placeholder identity forbidden",
      });
      continue;
    }
    const a = makeAttribution({
      target_type: o.target_type,
      target_id: o.target_id,
      method: isOneOf(o.method, ["direct", "trailer", "heuristic", "manual", "adapter"] as const)
        ? o.method
        : "direct",
      authority: isOneOf(o.authority, ["observed", "inferred"] as const)
        ? o.authority
        : "inferred",
      confidence: typeof o.confidence === "number" ? o.confidence : null,
      note: typeof o.note === "string" ? o.note : null,
    });
    if (a) out.push(a);
    else {
      issues.push({
        path: `${path}[${i}].target_id`,
        message: "placeholder or invalid identity rejected",
      });
    }
  }
  return out;
}

function validateCost(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): CostFields | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path, message: "cost must be object" });
    return unknownCost();
  }
  const o = raw as Record<string, unknown>;
  const source = isOneOf(o.cost_source, COST_SOURCES) ? o.cost_source : "unknown";
  if (!isOneOf(o.cost_source, COST_SOURCES)) {
    issues.push({ path: `${path}.cost_source`, message: "invalid cost_source" });
  }
  if (source === "unknown") {
    if (o.cost_usd === 0) {
      issues.push({
        path: `${path}.cost_usd`,
        message: "unknown cost must not use 0 to mean unknown",
      });
    }
    return unknownCost();
  }
  if (o.cost_usd !== null && (typeof o.cost_usd !== "number" || !Number.isFinite(o.cost_usd))) {
    issues.push({ path: `${path}.cost_usd`, message: "must be number or null" });
    return unknownCost();
  }
  return {
    cost_usd: o.cost_usd === null || o.cost_usd === undefined ? null : Number(o.cost_usd),
    cost_source: source,
  };
}

/** Build a validated phase payload. Rejects out-of-enum and placeholder run_ids. */
export function buildPhasePayload(input: {
  run_id: string;
  issue?: number | null;
  phase: DeliveryPhase;
  phase_instance_id: string;
  boundary: PhaseBoundary;
  planning_depth?: PlanningDepth;
  risk_class?: RiskClass;
  risk_classes?: RiskClass[];
  started_at?: string | null;
  ended_at?: string | null;
  active_effort?: ActiveEffort;
  cost?: CostFields;
  review_effort?: ReviewEffort;
  fix_rounds?: number | null;
  attribution?: PlanningLeverageAttribution[];
  pipeline_stage?: string | null;
}): ValidationResult<PlanningLeveragePhasePayload> {
  const issues: ValidationIssue[] = [];
  if (!input.run_id || isPlaceholderIdentity(input.run_id)) {
    issues.push({ path: "run_id", message: "required non-placeholder string" });
  }
  if (!isOneOf(input.phase, DELIVERY_PHASES)) {
    issues.push({ path: "phase", message: "invalid phase" });
  }
  if (!isOneOf(input.boundary, PHASE_BOUNDARIES)) {
    issues.push({ path: "boundary", message: "invalid boundary" });
  }
  if (!input.phase_instance_id || isPlaceholderIdentity(input.phase_instance_id)) {
    issues.push({ path: "phase_instance_id", message: "required non-placeholder string" });
  }
  const depth = input.planning_depth ?? "unknown";
  if (!isOneOf(depth, PLANNING_DEPTHS)) {
    issues.push({ path: "planning_depth", message: "invalid planning_depth" });
  }
  const risk = input.risk_class ?? "unknown";
  if (!isOneOf(risk, RISK_CLASSES)) {
    issues.push({ path: "risk_class", message: "invalid risk_class" });
  }
  const started_at = input.started_at ?? null;
  const ended_at = input.ended_at ?? null;
  const { elapsed_ms, elapsed_availability } = computeElapsed(started_at, ended_at);
  const active_effort = input.active_effort
    ? validateActiveEffort(input.active_effort, issues, "active_effort")
    : unavailableActiveEffort();
  // Never copy elapsed into active when unavailable
  if (
    active_effort.availability === "unavailable" &&
    active_effort.value_ms != null &&
    elapsed_ms != null &&
    active_effort.value_ms === elapsed_ms
  ) {
    issues.push({
      path: "active_effort.value_ms",
      message: "must not default to elapsed_ms when unavailable",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues, value: null };
  }

  const value: PlanningLeveragePhasePayload = {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "planning_leverage_phase",
    run_id: input.run_id,
    issue: input.issue ?? null,
    phase: input.phase,
    phase_instance_id: input.phase_instance_id,
    boundary: input.boundary,
    planning_depth: depth,
    risk_class: risk,
    risk_classes: input.risk_classes,
    started_at,
    ended_at,
    elapsed_ms,
    elapsed_availability,
    active_effort,
    cost: input.cost,
    review_effort: input.review_effort,
    fix_rounds: input.fix_rounds ?? null,
    attribution: input.attribution,
    pipeline_stage: input.pipeline_stage ?? null,
  };
  return { ok: true, issues: [], value };
}

export function buildAssumptionPayload(input: {
  run_id: string;
  issue?: number | null;
  assumption_id: string;
  kind: AssumptionKind;
  statement: string;
  introduced_phase: DeliveryPhase;
  status: AssumptionStatus;
  status_updated_at: string;
  resolution?: AssumptionResolution | null;
  evidence_refs?: string[];
}): ValidationResult<AssumptionLineagePayload> {
  const issues: ValidationIssue[] = [];
  if (!input.run_id || isPlaceholderIdentity(input.run_id)) {
    issues.push({ path: "run_id", message: "required non-placeholder string" });
  }
  if (!input.assumption_id || isPlaceholderIdentity(input.assumption_id)) {
    issues.push({ path: "assumption_id", message: "required non-placeholder string" });
  }
  if (!isOneOf(input.kind, ASSUMPTION_KINDS)) {
    issues.push({ path: "kind", message: "invalid kind" });
  }
  if (!isOneOf(input.introduced_phase, DELIVERY_PHASES)) {
    issues.push({ path: "introduced_phase", message: "invalid phase" });
  }
  if (!isOneOf(input.status, ASSUMPTION_STATUSES)) {
    issues.push({ path: "status", message: "invalid status" });
  }
  if (typeof input.statement !== "string") {
    issues.push({ path: "statement", message: "required string" });
  }
  if (!input.status_updated_at) {
    issues.push({ path: "status_updated_at", message: "required ISO timestamp" });
  }
  if (issues.length > 0) return { ok: false, issues, value: null };

  const resolution = input.resolution
    ? {
        note:
          input.resolution.note != null
            ? redactFreeText(input.resolution.note, 300)
            : null,
        resolved_in_phase: input.resolution.resolved_in_phase,
      }
    : null;

  const value: AssumptionLineagePayload = {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "assumption_lineage",
    run_id: input.run_id,
    issue: input.issue ?? null,
    assumption_id: input.assumption_id,
    kind: input.kind,
    statement: redactFreeText(input.statement, 500),
    introduced_phase: input.introduced_phase,
    status: input.status,
    status_updated_at: input.status_updated_at,
    resolution,
    evidence_refs: (input.evidence_refs ?? []).map((e) => redactFreeText(e, 200)),
  };
  return { ok: true, issues: [], value };
}

export function buildMaterialReworkPayload(input: {
  run_id: string;
  issue?: number | null;
  materiality: Materiality;
  material_criteria: MaterialCriterion[];
  fix_round?: number | null;
  review_effort?: ReviewEffort;
  phase_instance_id?: string | null;
  evidence_refs?: string[];
  attribution?: PlanningLeverageAttribution[];
  started_at?: string | null;
  ended_at?: string | null;
  active_effort?: ActiveEffort;
  cost?: CostFields;
}): ValidationResult<MaterialReworkPayload> {
  const issues: ValidationIssue[] = [];
  if (!input.run_id || isPlaceholderIdentity(input.run_id)) {
    issues.push({ path: "run_id", message: "required non-placeholder string" });
  }
  if (!isOneOf(input.materiality, MATERIALITIES)) {
    issues.push({ path: "materiality", message: "invalid materiality" });
  }
  if (!Array.isArray(input.material_criteria)) {
    issues.push({ path: "material_criteria", message: "must be array" });
  } else {
    for (let i = 0; i < input.material_criteria.length; i++) {
      if (!isOneOf(input.material_criteria[i], MATERIAL_CRITERIA)) {
        issues.push({ path: `material_criteria[${i}]`, message: "invalid criterion" });
      }
    }
  }
  if (
    input.fix_round != null &&
    (typeof input.fix_round !== "number" ||
      !Number.isInteger(input.fix_round) ||
      input.fix_round < 1)
  ) {
    issues.push({ path: "fix_round", message: "must be positive integer or null" });
  }
  const review_effort = input.review_effort
    ? validateReviewEffort(input.review_effort, issues, "review_effort")
    : emptyReviewEffort();
  const started_at = input.started_at ?? null;
  const ended_at = input.ended_at ?? null;
  const { elapsed_ms, elapsed_availability } = computeElapsed(started_at, ended_at);
  const active_effort = input.active_effort
    ? validateActiveEffort(input.active_effort, issues, "active_effort")
    : unavailableActiveEffort();
  const cost = input.cost ? validateCost(input.cost, issues, "cost") : undefined;
  const attribution = input.attribution
    ? validateAttributionList(input.attribution, issues, "attribution")
    : [];

  if (issues.length > 0) return { ok: false, issues, value: null };

  const value: MaterialReworkPayload = {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "material_rework",
    run_id: input.run_id,
    issue: input.issue ?? null,
    materiality: input.materiality,
    material_criteria: [...input.material_criteria],
    fix_round: input.fix_round ?? null,
    review_effort,
    phase_instance_id: input.phase_instance_id ?? null,
    evidence_refs: (input.evidence_refs ?? []).map((e) => redactFreeText(e, 200)),
    attribution,
    started_at,
    ended_at,
    elapsed_ms,
    elapsed_availability,
    active_effort,
    cost,
  };
  return { ok: true, issues: [], value };
}

/**
 * Read-side helpers: accept records, ignore unknown fields, strip collapsed scores.
 */
export function readPhasePayload(input: unknown): PlanningLeveragePhasePayload | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.record_schema_version !== PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION) return null;
  if (o.type !== "planning_leverage_phase" && o.type !== undefined) {
    // Stream events also have type planning_leverage_phase
    if (o.type !== "planning_leverage_phase") return null;
  }
  if (typeof o.run_id !== "string" || isPlaceholderIdentity(o.run_id)) return null;
  if (!isOneOf(o.phase, DELIVERY_PHASES)) return null;
  if (!isOneOf(o.boundary, PHASE_BOUNDARIES)) return null;
  if (typeof o.phase_instance_id !== "string") return null;
  const depth = isOneOf(o.planning_depth, PLANNING_DEPTHS) ? o.planning_depth : "unknown";
  const risk = isOneOf(o.risk_class, RISK_CLASSES) ? o.risk_class : "unknown";
  const started_at = typeof o.started_at === "string" ? o.started_at : null;
  const ended_at = typeof o.ended_at === "string" ? o.ended_at : null;
  const computed = computeElapsed(started_at, ended_at);
  // Prefer stored elapsed when observed; recompute if inconsistent
  const elapsed_ms =
    typeof o.elapsed_ms === "number" && o.elapsed_availability === "observed"
      ? o.elapsed_ms
      : computed.elapsed_ms;
  const elapsed_availability =
    isOneOf(o.elapsed_availability, ELAPSED_AVAILABILITIES)
      ? o.elapsed_availability
      : computed.elapsed_availability;
  const issues: ValidationIssue[] = [];
  const active_effort = validateActiveEffort(o.active_effort, issues, "active_effort");
  return {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "planning_leverage_phase",
    run_id: o.run_id,
    issue: typeof o.issue === "number" ? o.issue : o.issue === null ? null : null,
    phase: o.phase,
    phase_instance_id: o.phase_instance_id,
    boundary: o.boundary,
    planning_depth: depth,
    risk_class: risk,
    risk_classes: Array.isArray(o.risk_classes)
      ? o.risk_classes.filter((c): c is RiskClass => isOneOf(c, RISK_CLASSES))
      : undefined,
    started_at,
    ended_at,
    elapsed_ms,
    elapsed_availability,
    active_effort,
    pipeline_stage: typeof o.pipeline_stage === "string" ? o.pipeline_stage : null,
  };
}

export function readAssumptionPayload(input: unknown): AssumptionLineagePayload | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.record_schema_version !== PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION) return null;
  if (typeof o.run_id !== "string" || isPlaceholderIdentity(o.run_id)) return null;
  if (typeof o.assumption_id !== "string" || !o.assumption_id) return null;
  if (!isOneOf(o.kind, ASSUMPTION_KINDS)) return null;
  if (!isOneOf(o.status, ASSUMPTION_STATUSES)) return null;
  if (!isOneOf(o.introduced_phase, DELIVERY_PHASES)) return null;
  if (typeof o.statement !== "string") return null;
  if (typeof o.status_updated_at !== "string") return null;
  return {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "assumption_lineage",
    run_id: o.run_id,
    issue: typeof o.issue === "number" ? o.issue : null,
    assumption_id: o.assumption_id,
    kind: o.kind,
    statement: o.statement,
    introduced_phase: o.introduced_phase,
    status: o.status,
    status_updated_at: o.status_updated_at,
    resolution:
      o.resolution && typeof o.resolution === "object" && !Array.isArray(o.resolution)
        ? {
            note:
              typeof (o.resolution as Record<string, unknown>).note === "string"
                ? String((o.resolution as Record<string, unknown>).note)
                : null,
            resolved_in_phase: isOneOf(
              (o.resolution as Record<string, unknown>).resolved_in_phase,
              DELIVERY_PHASES,
            )
              ? ((o.resolution as Record<string, unknown>).resolved_in_phase as DeliveryPhase)
              : null,
          }
        : null,
    evidence_refs: Array.isArray(o.evidence_refs)
      ? o.evidence_refs.filter((e): e is string => typeof e === "string")
      : [],
  };
}

export function readMaterialReworkPayload(input: unknown): MaterialReworkPayload | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.record_schema_version !== PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION) return null;
  if (typeof o.run_id !== "string" || isPlaceholderIdentity(o.run_id)) return null;
  if (!isOneOf(o.materiality, MATERIALITIES)) return null;
  const criteria = Array.isArray(o.material_criteria)
    ? o.material_criteria.filter((c): c is MaterialCriterion => isOneOf(c, MATERIAL_CRITERIA))
    : [];
  const issues: ValidationIssue[] = [];
  const review_effort = validateReviewEffort(o.review_effort, issues, "review_effort");
  return {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "material_rework",
    run_id: o.run_id,
    issue: typeof o.issue === "number" ? o.issue : null,
    materiality: o.materiality,
    material_criteria: criteria,
    fix_round: typeof o.fix_round === "number" ? o.fix_round : null,
    review_effort,
    phase_instance_id: typeof o.phase_instance_id === "string" ? o.phase_instance_id : null,
    evidence_refs: Array.isArray(o.evidence_refs)
      ? o.evidence_refs.filter((e): e is string => typeof e === "string")
      : [],
  };
}

export function readSnapshotPayload(input: unknown): PlanningLeverageSnapshotPayload | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (o.record_schema_version !== PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION) return null;
  if (typeof o.run_id !== "string" || isPlaceholderIdentity(o.run_id)) return null;
  // Forbid collapsed scores by construction — never copy them.
  const depth = isOneOf(o.planning_depth, PLANNING_DEPTHS) ? o.planning_depth : "unknown";
  const risk = isOneOf(o.risk_class, RISK_CLASSES) ? o.risk_class : "unknown";
  const issues: ValidationIssue[] = [];
  const review_effort = validateReviewEffort(o.review_effort, issues, "review_effort");
  const derived: Record<string, DerivedMetric> = {};
  if (o.derived && typeof o.derived === "object" && !Array.isArray(o.derived)) {
    for (const [k, v] of Object.entries(o.derived as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const d = v as Record<string, unknown>;
      if (!isOneOf(d.availability, VALUE_AVAILABILITIES)) continue;
      derived[k] = {
        value: typeof d.value === "number" ? d.value : d.value === null ? null : null,
        availability: d.availability,
        inputs: Array.isArray(d.inputs)
          ? d.inputs.filter((x): x is string => typeof x === "string")
          : [],
        note: typeof d.note === "string" ? d.note : null,
      };
    }
  }
  return {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "planning_leverage_snapshot",
    run_id: o.run_id,
    issue: typeof o.issue === "number" ? o.issue : null,
    phase: isOneOf(o.phase, DELIVERY_PHASES) ? o.phase : null,
    phase_instance_id: typeof o.phase_instance_id === "string" ? o.phase_instance_id : null,
    planning_depth: depth,
    risk_class: risk,
    phase_elapsed_ms:
      o.phase_elapsed_ms && typeof o.phase_elapsed_ms === "object"
        ? (o.phase_elapsed_ms as Partial<Record<DeliveryPhase, number>>)
        : {},
    phase_elapsed_availability:
      o.phase_elapsed_availability && typeof o.phase_elapsed_availability === "object"
        ? (o.phase_elapsed_availability as Partial<Record<DeliveryPhase, ElapsedAvailability>>)
        : {},
    review_effort,
    fix_rounds: typeof o.fix_rounds === "number" ? o.fix_rounds : null,
    assumption_counts: {
      open: 0,
      deferred: 0,
      resolved: 0,
      invalidated: 0,
      unknown: 0,
      ...(typeof o.assumption_counts === "object" && o.assumption_counts
        ? (o.assumption_counts as Record<string, number>)
        : {}),
    },
    materiality_counts: {
      material: 0,
      ordinary: 0,
      unknown: 0,
      ...(typeof o.materiality_counts === "object" && o.materiality_counts
        ? (o.materiality_counts as Record<Materiality, number>)
        : {}),
    },
    attribution: validateAttributionList(o.attribution, issues, "attribution"),
    linkage_diagnostics: Array.isArray(o.linkage_diagnostics)
      ? o.linkage_diagnostics.filter((d): d is string => typeof d === "string")
      : [],
    derived,
  };
}

/** Serialize free-text-bearing payloads with redaction. */
export function serializeAssumptionPayload(payload: AssumptionLineagePayload): string {
  const safe: AssumptionLineagePayload = {
    ...payload,
    statement: redactFreeText(payload.statement, 500),
    resolution: payload.resolution
      ? {
          note: payload.resolution.note
            ? redactFreeText(payload.resolution.note, 300)
            : null,
          resolved_in_phase: payload.resolution.resolved_in_phase,
        }
      : payload.resolution,
    evidence_refs: (payload.evidence_refs ?? []).map((e) => redactFreeText(e, 200)),
  };
  return JSON.stringify(safe);
}
