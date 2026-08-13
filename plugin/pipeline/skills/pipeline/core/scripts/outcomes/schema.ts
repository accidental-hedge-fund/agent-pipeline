// Production-outcome record schema (#576).
//
// Versioned multi-kind outcomes with explicit delivery-chain fields and
// observation states. No collapsed maintainability score. Free text is
// redacted before serialize. Readers ignore unknown fields.

import { redactSecrets, sanitize } from "../artifact-sanitize.ts";

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export const OUTCOME_SCHEMA_VERSION = 1 as const;

export const OUTCOME_KINDS = [
  "delivery",
  "reversion",
  "escaped_defect",
  "follow_up_rework",
  "change_amplification",
  "post_control_recurrence",
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const OBSERVATION_STATES = [
  "observed",
  "delayed",
  "unknown",
  "not_observed",
  "disputed",
] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

export const DEPLOY_STATUSES = [
  "succeeded",
  "failed",
  "rolled_back",
  "in_progress",
  "unknown",
  "not_observed",
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export const MERGE_STATUSES = [
  "merged",
  "not_merged",
  "unknown",
  "not_observed",
] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

export const VERIFICATION_STATUSES = [
  "passed",
  "failed",
  "unknown",
  "not_observed",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const ROLLBACK_OUTCOMES = [
  "succeeded",
  "failed",
  "unknown",
  "not_observed",
] as const;
export type RollbackOutcome = (typeof ROLLBACK_OUTCOMES)[number];

export const ATTRIBUTION_TARGET_TYPES = [
  "run",
  "commit",
  "pr",
  "issue",
  "component",
  /** Join target for planning-leverage / material-rework → #576 outcomes (#702). */
  "production_outcome",
] as const;
export type AttributionTargetType = (typeof ATTRIBUTION_TARGET_TYPES)[number];

export const ATTRIBUTION_METHODS = [
  "direct",
  "trailer",
  "heuristic",
  "manual",
  "adapter",
] as const;
export type AttributionMethod = (typeof ATTRIBUTION_METHODS)[number];

export const ATTRIBUTION_AUTHORITIES = ["observed", "inferred"] as const;
export type AttributionAuthority = (typeof ATTRIBUTION_AUTHORITIES)[number];

export const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface DeliveryVerification {
  status: VerificationStatus;
  evidence_ref: string | null;
  fresh_at: string | null;
}

export interface DeliveryRollback {
  occurred: boolean | null;
  outcome: RollbackOutcome | null;
}

export interface DeliveryChain {
  environment: string | null;
  deploy_status: DeployStatus;
  deployed_candidate_sha: string | null;
  merge_status: MergeStatus;
  merged_sha: string | null;
  verification: DeliveryVerification;
  rollback: DeliveryRollback;
}

export interface OutcomeSource {
  adapter_id: string;
  signal_ref: string;
  /** Optional provider event id for diagnostics; never a secret. */
  provider_event_id?: string | null;
}

export interface OutcomeAttribution {
  target_type: AttributionTargetType;
  target_id: string;
  method: AttributionMethod;
  authority: AttributionAuthority;
  confidence: number | null;
  note?: string | null;
  disputed?: boolean;
}

export interface ProductionOutcome {
  schema_version: typeof OUTCOME_SCHEMA_VERSION;
  type: "production_outcome";
  outcome_id: string;
  outcome_kind: OutcomeKind;
  observation_state: ObservationState;
  observed_at: string | null;
  signal_at: string | null;
  source: OutcomeSource;
  delivery: DeliveryChain | null;
  summary: string;
  evidence_refs: string[];
  attribution: OutcomeAttribution[];
  linkage_diagnostics: string[];
  /** Optional supersession pointer when a later record replaces this identity. */
  supersedes_outcome_id?: string | null;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  value: ProductionOutcome | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Normalize a commit SHA: full 40-char hex lowercase, else null. Never invent. */
export function normalizeFullSha(sha: string | null | undefined): string | null {
  if (typeof sha !== "string") return null;
  const t = sha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(t)) return null;
  return t;
}

/** Reject placeholder-like identity strings that look fabricated. */
export function isPlaceholderIdentity(value: string): boolean {
  const t = value.trim().toLowerCase();
  if (!t) return true;
  if (t === "unknown" || t === "null" || t === "undefined" || t === "n/a" || t === "none") return true;
  if (/^0{7,}$/.test(t)) return true;
  if (/^placeholder/.test(t)) return true;
  if (t === "deadbeef" || t === "cafebabe") return true;
  return false;
}

export function redactFreeText(text: string, maxLen = 500): string {
  return sanitize(redactSecrets(text)).slice(0, maxLen);
}

export function emptyDeliveryChain(overrides: Partial<DeliveryChain> = {}): DeliveryChain {
  return {
    environment: null,
    deploy_status: "not_observed",
    deployed_candidate_sha: null,
    merge_status: "not_observed",
    merged_sha: null,
    verification: {
      status: "not_observed",
      evidence_ref: null,
      fresh_at: null,
    },
    rollback: {
      occurred: null,
      outcome: null,
    },
    ...overrides,
    verification: {
      status: "not_observed",
      evidence_ref: null,
      fresh_at: null,
      ...(overrides.verification ?? {}),
    },
    rollback: {
      occurred: null,
      outcome: null,
      ...(overrides.rollback ?? {}),
    },
  };
}

function validateDelivery(raw: unknown, issues: ValidationIssue[], path: string): DeliveryChain | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path, message: "delivery must be an object or null" });
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (!isOneOf(o.deploy_status, DEPLOY_STATUSES)) {
    issues.push({ path: `${path}.deploy_status`, message: "invalid deploy_status" });
  }
  if (!isOneOf(o.merge_status, MERGE_STATUSES)) {
    issues.push({ path: `${path}.merge_status`, message: "invalid merge_status" });
  }
  const deployed = o.deployed_candidate_sha == null ? null : normalizeFullSha(String(o.deployed_candidate_sha));
  if (o.deployed_candidate_sha != null && deployed === null) {
    issues.push({
      path: `${path}.deployed_candidate_sha`,
      message: "must be full 40-char hex SHA or null (placeholders forbidden)",
    });
  }
  const merged = o.merged_sha == null ? null : normalizeFullSha(String(o.merged_sha));
  if (o.merged_sha != null && merged === null) {
    issues.push({
      path: `${path}.merged_sha`,
      message: "must be full 40-char hex SHA or null (placeholders forbidden)",
    });
  }
  const verRaw = o.verification;
  let verification: DeliveryVerification = {
    status: "not_observed",
    evidence_ref: null,
    fresh_at: null,
  };
  if (verRaw && typeof verRaw === "object" && !Array.isArray(verRaw)) {
    const v = verRaw as Record<string, unknown>;
    if (!isOneOf(v.status, VERIFICATION_STATUSES)) {
      issues.push({ path: `${path}.verification.status`, message: "invalid verification status" });
    } else {
      verification = {
        status: v.status,
        evidence_ref: typeof v.evidence_ref === "string" ? redactFreeText(v.evidence_ref, 300) : null,
        fresh_at: typeof v.fresh_at === "string" ? v.fresh_at : null,
      };
    }
  } else if (verRaw != null) {
    issues.push({ path: `${path}.verification`, message: "verification must be an object" });
  }
  const rbRaw = o.rollback;
  let rollback: DeliveryRollback = { occurred: null, outcome: null };
  if (rbRaw && typeof rbRaw === "object" && !Array.isArray(rbRaw)) {
    const r = rbRaw as Record<string, unknown>;
    const occurred =
      typeof r.occurred === "boolean" ? r.occurred : r.occurred === null || r.occurred === undefined ? null : null;
    if (r.occurred !== undefined && r.occurred !== null && typeof r.occurred !== "boolean") {
      issues.push({ path: `${path}.rollback.occurred`, message: "must be boolean or null" });
    }
    let outcome: RollbackOutcome | null = null;
    if (r.outcome === null || r.outcome === undefined) {
      outcome = null;
    } else if (isOneOf(r.outcome, ROLLBACK_OUTCOMES)) {
      outcome = r.outcome;
    } else {
      issues.push({ path: `${path}.rollback.outcome`, message: "invalid rollback outcome" });
    }
    rollback = { occurred, outcome };
  } else if (rbRaw != null) {
    issues.push({ path: `${path}.rollback`, message: "rollback must be an object" });
  }

  if (issues.some((i) => i.path.startsWith(path))) {
    // still build a best-effort value for callers that only need structure
  }

  return {
    environment: typeof o.environment === "string" ? o.environment : o.environment === null ? null : null,
    deploy_status: isOneOf(o.deploy_status, DEPLOY_STATUSES) ? o.deploy_status : "unknown",
    deployed_candidate_sha: deployed,
    merge_status: isOneOf(o.merge_status, MERGE_STATUSES) ? o.merge_status : "unknown",
    merged_sha: merged,
    verification,
    rollback,
  };
}

function validateAttribution(raw: unknown, issues: ValidationIssue[], path: string): OutcomeAttribution | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: "attribution entry must be an object" });
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (!isOneOf(o.target_type, ATTRIBUTION_TARGET_TYPES)) {
    issues.push({ path: `${path}.target_type`, message: "invalid target_type" });
    return null;
  }
  if (typeof o.target_id !== "string" || !o.target_id.trim() || isPlaceholderIdentity(o.target_id)) {
    issues.push({ path: `${path}.target_id`, message: "target_id missing or placeholder" });
    return null;
  }
  if (o.target_type === "commit") {
    const sha = normalizeFullSha(o.target_id);
    if (!sha) {
      issues.push({ path: `${path}.target_id`, message: "commit target_id must be full 40-char hex SHA" });
      return null;
    }
  }
  if (!isOneOf(o.method, ATTRIBUTION_METHODS)) {
    issues.push({ path: `${path}.method`, message: "invalid method" });
    return null;
  }
  if (!isOneOf(o.authority, ATTRIBUTION_AUTHORITIES)) {
    issues.push({ path: `${path}.authority`, message: "invalid authority" });
    return null;
  }
  let confidence: number | null = null;
  if (o.confidence === null || o.confidence === undefined) {
    confidence = null;
  } else if (typeof o.confidence === "number" && Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1) {
    confidence = o.confidence;
  } else {
    issues.push({ path: `${path}.confidence`, message: "confidence must be in [0,1] or null" });
    return null;
  }
  const targetId =
    o.target_type === "commit" ? normalizeFullSha(o.target_id)! : o.target_id.trim();
  return {
    target_type: o.target_type,
    target_id: targetId,
    method: o.method,
    authority: o.authority,
    confidence,
    note: typeof o.note === "string" ? redactFreeText(o.note, 200) : null,
    disputed: o.disputed === true ? true : undefined,
  };
}

/**
 * Validate and normalize a production_outcome record.
 * Rejects out-of-enum values and placeholder SHAs/run ids.
 * Delivery object is required (non-null) for outcome_kind "delivery".
 */
export function validateProductionOutcome(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "", message: "record must be an object" }], value: null };
  }
  const o = input as Record<string, unknown>;

  if (o.schema_version !== OUTCOME_SCHEMA_VERSION) {
    issues.push({ path: "schema_version", message: `must be ${OUTCOME_SCHEMA_VERSION}` });
  }
  if (o.type !== "production_outcome") {
    issues.push({ path: "type", message: 'must be "production_outcome"' });
  }
  if (typeof o.outcome_id !== "string" || !o.outcome_id.trim() || isPlaceholderIdentity(o.outcome_id)) {
    issues.push({ path: "outcome_id", message: "required non-placeholder string" });
  }
  if (!isOneOf(o.outcome_kind, OUTCOME_KINDS)) {
    issues.push({ path: "outcome_kind", message: "invalid outcome_kind" });
  }
  if (!isOneOf(o.observation_state, OBSERVATION_STATES)) {
    issues.push({ path: "observation_state", message: "invalid observation_state" });
  }
  if (o.observed_at !== null && typeof o.observed_at !== "string") {
    issues.push({ path: "observed_at", message: "must be ISO string or null" });
  }
  if (o.signal_at !== null && typeof o.signal_at !== "string") {
    issues.push({ path: "signal_at", message: "must be ISO string or null" });
  }

  let source: OutcomeSource | null = null;
  if (typeof o.source !== "object" || o.source === null || Array.isArray(o.source)) {
    issues.push({ path: "source", message: "source object required" });
  } else {
    const s = o.source as Record<string, unknown>;
    if (typeof s.adapter_id !== "string" || !s.adapter_id.trim()) {
      issues.push({ path: "source.adapter_id", message: "required" });
    }
    if (typeof s.signal_ref !== "string" || !s.signal_ref.trim()) {
      issues.push({ path: "source.signal_ref", message: "required" });
    }
    source = {
      adapter_id: typeof s.adapter_id === "string" ? s.adapter_id.trim() : "",
      signal_ref: typeof s.signal_ref === "string" ? redactFreeText(s.signal_ref, 300) : "",
      provider_event_id:
        typeof s.provider_event_id === "string"
          ? s.provider_event_id
          : s.provider_event_id === null
            ? null
            : undefined,
    };
  }

  const kind = isOneOf(o.outcome_kind, OUTCOME_KINDS) ? o.outcome_kind : null;
  let delivery: DeliveryChain | null = null;
  if (kind === "delivery") {
    if (o.delivery == null) {
      issues.push({ path: "delivery", message: "delivery object required for outcome_kind delivery" });
    } else {
      delivery = validateDelivery(o.delivery, issues, "delivery");
    }
  } else if (o.delivery != null) {
    delivery = validateDelivery(o.delivery, issues, "delivery");
  }

  if (typeof o.summary !== "string") {
    issues.push({ path: "summary", message: "summary string required" });
  }

  const evidence_refs: string[] = [];
  if (!Array.isArray(o.evidence_refs)) {
    issues.push({ path: "evidence_refs", message: "must be an array" });
  } else {
    for (let i = 0; i < o.evidence_refs.length; i++) {
      const e = o.evidence_refs[i];
      if (typeof e === "string") evidence_refs.push(redactFreeText(e, 300));
      else issues.push({ path: `evidence_refs[${i}]`, message: "must be string" });
    }
  }

  const attribution: OutcomeAttribution[] = [];
  if (o.attribution === undefined) {
    // allow omit → empty
  } else if (!Array.isArray(o.attribution)) {
    issues.push({ path: "attribution", message: "must be an array" });
  } else {
    for (let i = 0; i < o.attribution.length; i++) {
      const a = validateAttribution(o.attribution[i], issues, `attribution[${i}]`);
      if (a) attribution.push(a);
    }
  }

  const linkage_diagnostics: string[] = [];
  if (o.linkage_diagnostics === undefined) {
    // empty
  } else if (!Array.isArray(o.linkage_diagnostics)) {
    issues.push({ path: "linkage_diagnostics", message: "must be an array" });
  } else {
    for (let i = 0; i < o.linkage_diagnostics.length; i++) {
      const d = o.linkage_diagnostics[i];
      if (typeof d === "string" && d.trim()) linkage_diagnostics.push(d.trim());
      else issues.push({ path: `linkage_diagnostics[${i}]`, message: "must be non-empty string" });
    }
  }

  // Forbid collapsed score fields by construction: they are never copied.

  if (issues.length > 0) {
    return { ok: false, issues, value: null };
  }

  const value: ProductionOutcome = {
    schema_version: OUTCOME_SCHEMA_VERSION,
    type: "production_outcome",
    outcome_id: String(o.outcome_id).trim(),
    outcome_kind: kind!,
    observation_state: o.observation_state as ObservationState,
    observed_at: o.observed_at === null || o.observed_at === undefined ? null : String(o.observed_at),
    signal_at: o.signal_at === null || o.signal_at === undefined ? null : String(o.signal_at),
    source: source!,
    delivery,
    summary: redactFreeText(String(o.summary), 500),
    evidence_refs,
    attribution,
    linkage_diagnostics,
    supersedes_outcome_id:
      typeof o.supersedes_outcome_id === "string"
        ? o.supersedes_outcome_id
        : o.supersedes_outcome_id === null
          ? null
          : undefined,
  };
  return { ok: true, issues: [], value };
}

/**
 * Read-side helper: extract a ProductionOutcome, ignoring unknown fields.
 * Returns null when required identity fields are missing or invalid.
 */
export function readProductionOutcome(input: unknown): ProductionOutcome | null {
  const result = validateProductionOutcome(input);
  return result.value;
}

/** Serialize with write-time redaction on free-text fields. */
export function serializeProductionOutcome(record: ProductionOutcome): string {
  const safe: ProductionOutcome = {
    ...record,
    summary: redactFreeText(record.summary, 500),
    evidence_refs: record.evidence_refs.map((e) => redactFreeText(e, 300)),
    source: {
      ...record.source,
      signal_ref: redactFreeText(record.source.signal_ref, 300),
    },
    attribution: record.attribution.map((a) => ({
      ...a,
      note: a.note ? redactFreeText(a.note, 200) : a.note,
    })),
    delivery: record.delivery
      ? {
          ...record.delivery,
          environment:
            typeof record.delivery.environment === "string"
              ? redactFreeText(record.delivery.environment, 100)
              : record.delivery.environment,
          verification: {
            ...record.delivery.verification,
            evidence_ref: record.delivery.verification.evidence_ref
              ? redactFreeText(record.delivery.verification.evidence_ref, 300)
              : null,
          },
        }
      : null,
  };
  return `${JSON.stringify(safe, null, 2)}\n`;
}

/** Build a minimal valid delivery outcome shell for adapters. */
export function makeOutcomeShell(args: {
  outcome_id: string;
  outcome_kind: OutcomeKind;
  observation_state: ObservationState;
  adapter_id: string;
  signal_ref: string;
  summary: string;
  observed_at?: string | null;
  signal_at?: string | null;
  delivery?: DeliveryChain | null;
  attribution?: OutcomeAttribution[];
  linkage_diagnostics?: string[];
  evidence_refs?: string[];
  provider_event_id?: string | null;
}): ProductionOutcome {
  return {
    schema_version: OUTCOME_SCHEMA_VERSION,
    type: "production_outcome",
    outcome_id: args.outcome_id,
    outcome_kind: args.outcome_kind,
    observation_state: args.observation_state,
    observed_at: args.observed_at ?? null,
    signal_at: args.signal_at ?? null,
    source: {
      adapter_id: args.adapter_id,
      signal_ref: args.signal_ref,
      provider_event_id: args.provider_event_id,
    },
    delivery: args.outcome_kind === "delivery" ? (args.delivery ?? emptyDeliveryChain()) : (args.delivery ?? null),
    summary: redactFreeText(args.summary, 500),
    evidence_refs: args.evidence_refs ?? [],
    attribution: args.attribution ?? [],
    linkage_diagnostics: args.linkage_diagnostics ?? [],
  };
}
