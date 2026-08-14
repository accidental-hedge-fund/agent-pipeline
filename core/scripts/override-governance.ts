// Governed typed overrides (#693).
//
// Versioned class taxonomy, policy-bound authenticated authority, required
// evidence, expiry, renewal-lite, supersession lineage, subject-bound
// invalidation, and append-only decision history. Pure evaluators only —
// comment I/O and CLI wiring live in review-policy.ts / pipeline.ts.
//
// Product boundary: Pipeline enforces validity and emits facts. Project Warrant
// may view/alert/analyze but MUST NOT bypass these gates.

import { createHash, randomUUID } from "node:crypto";
import {
  compareEvidenceSubjects,
  type EvidenceSubjectV1,
} from "./evidence-subject.ts";
import type {
  OverrideApproverRule,
  OverrideClassPolicy,
  OverrideEvidenceRefKind,
  OverrideGovernanceConfig,
  OverrideRequireHumanOn,
  OverrideSodRole,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OVERRIDE_GOVERNANCE_SCHEMA_VERSION = 1 as const;
export const IMPLICIT_LOW_RISK_CLASS = "low_risk_deferred" as const;
/** Default max duration for the implicit low-risk class (30 days). */
export const IMPLICIT_MAX_DURATION_HOURS = 720 as const;

export const OVERRIDE_LIFECYCLE_STATES = [
  "active",
  "expired",
  "superseded",
  "renewed",
  "rejected",
  "invalidated",
] as const;
export type OverrideLifecycle = (typeof OVERRIDE_LIFECYCLE_STATES)[number];

/** Validity evaluation outcomes (superset of lifecycle for gate reasons). */
export const OVERRIDE_VALIDITY_STATUSES = [
  "active",
  "expired",
  "superseded",
  "renewed",
  "rejected",
  "invalidated",
  "unauthorized",
  "malformed",
  "scope_mismatch",
] as const;
export type OverrideValidityStatus = (typeof OVERRIDE_VALIDITY_STATUSES)[number];

export const OVERRIDE_EVENT_TYPES = [
  "override_recorded",
  "override_rejected",
  "override_superseded",
  "override_renewed_lite",
  "override_renewed_human",
  "override_expired",
  "override_invalidated",
] as const;
export type OverrideEventType = (typeof OVERRIDE_EVENT_TYPES)[number];

export const OVERRIDE_INVALIDATION_REASONS = [
  "subject_mismatch",
  "subject_malformed",
  "policy_change",
  "fingerprint_drift",
  "region_drift",
  "authorization_revoked",
  "superseded",
  "expired",
] as const;
export type OverrideInvalidationReason = (typeof OVERRIDE_INVALIDATION_REASONS)[number];

export const OVERRIDE_REFUSAL_REASONS = [
  "unauthenticated",
  "unauthorized",
  "sod_violation",
  "missing_evidence",
  "unknown_class",
  "malformed_target",
  "empty_explanation",
  "invalid_duration",
] as const;
export type OverrideRefusalReason = (typeof OVERRIDE_REFUSAL_REASONS)[number];

// ---------------------------------------------------------------------------
// Decision model (schema_version 1)
// ---------------------------------------------------------------------------

export type OverrideTarget =
  | { kind: "key"; key: string }
  | { kind: "scope"; scopeType: "category" | "file"; scopeValue: string };

export interface OverrideAuthorizationResolution {
  authorized: boolean;
  matched_rule: string | null;
  evidence: string;
  identity_source: string;
}

export interface OverrideEvidenceRefs {
  /** Class-required and optional refs keyed by kind. */
  [kind: string]: string | undefined;
}

export interface OverrideDecisionV1 {
  schema_version: 1;
  decision_id: string;
  class: string;
  disposition: string;
  target: OverrideTarget;
  explanation: string;
  actor: string;
  identity_source: string;
  authorization: OverrideAuthorizationResolution;
  evidence_refs: OverrideEvidenceRefs;
  remediation_refs: OverrideEvidenceRefs;
  evidence_subject?: EvidenceSubjectV1;
  finding_fingerprint: string | null;
  code_region: string | null;
  created_at: string;
  expires_at: string;
  /** Stored lifecycle at append time; projection recomputes active status. */
  lifecycle: OverrideLifecycle;
  supersedes: string | null;
  renewed_from: string | null;
  renewal_kind: "lite" | "human" | null;
  invalidation_reason: OverrideInvalidationReason | null;
  /** True when extracted from a pre-governance sentinel. */
  legacy_compat?: boolean;
}

export interface OverrideValidityResult {
  status: OverrideValidityStatus;
  reason: string;
  invalidation_reason?: OverrideInvalidationReason;
  mismatched_subject_fields?: string[];
}

export interface LiveOverrideContext {
  /** Live finding fingerprint for key targets (payload fingerprint). */
  finding_fingerprint?: string | null;
  /** Live code region digest (file + line band). */
  code_region?: string | null;
  /** For scope targets: whether the live finding matches the scope. */
  scope_matches?: boolean;
}

export interface OverrideIdentityAdapter {
  resolveGroupMembers?(groupRef: string): string[] | Promise<string[]>;
  actorHasRole?(actor: string, role: string): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implicit / effective policy
// ---------------------------------------------------------------------------

/**
 * Built-in low-risk compatibility class used when `override_governance` is
 * omitted from config. Preserves non-empty free-form dispositions under the
 * trusted-actor model, with renewal-lite and a generous max duration.
 */
export function implicitOverrideGovernance(): OverrideGovernanceConfig {
  return {
    schema_version: OVERRIDE_GOVERNANCE_SCHEMA_VERSION,
    implicit: true,
    default_class: IMPLICIT_LOW_RISK_CLASS,
    classes: {
      [IMPLICIT_LOW_RISK_CLASS]: {
        max_duration_hours: IMPLICIT_MAX_DURATION_HOURS,
        required_evidence: [],
        renewal: {
          mode: "lite",
          require_human_on: ["fingerprint_drift", "region_drift", "subject_mismatch"],
        },
        // Empty approvers + implicit flag → any authenticated actor (current
        // actor + trusted_override_actors continuity at the trust filter layer).
        approvers: [{ kind: "trusted_override_actors_allowlist" }],
        separation_of_duties: { enabled: false, forbid_roles: [] },
      },
    },
  };
}

export function getClassPolicy(
  governance: OverrideGovernanceConfig,
  classId: string,
): OverrideClassPolicy | null {
  return governance.classes[classId] ?? null;
}

export function resolveClassId(
  governance: OverrideGovernanceConfig,
  explicitClass: string | undefined,
): { classId: string } | { error: string } {
  if (explicitClass) {
    if (!governance.classes[explicitClass]) {
      return {
        error: `Unknown override class "${explicitClass}". Known classes: ${Object.keys(governance.classes).sort().join(", ") || "(none)"}.`,
      };
    }
    return { classId: explicitClass };
  }
  if (governance.default_class && governance.classes[governance.default_class]) {
    return { classId: governance.default_class };
  }
  if (governance.implicit && governance.classes[IMPLICIT_LOW_RISK_CLASS]) {
    return { classId: IMPLICIT_LOW_RISK_CLASS };
  }
  return {
    error:
      "Override class is required when override_governance is configured without default_class. " +
      'Use "<key>: <class>: <reason>" or set default_class in config.',
  };
}

// ---------------------------------------------------------------------------
// Authority + SoD
// ---------------------------------------------------------------------------

export interface AuthorizeOverrideInput {
  actor: string | null;
  identitySource: string;
  classPolicy: OverrideClassPolicy;
  /** trusted_override_actors from config (may be empty/undefined). */
  trustedAllowlist?: string[];
  /** When true (implicit governance), trusted_override_actors_allowlist accepts any authenticated actor. */
  implicitGovernance?: boolean;
  adapter?: OverrideIdentityAdapter;
  implementer?: string | null;
  findingAuthor?: string | null;
}

export interface AuthorizeOverrideResult {
  authorized: boolean;
  refusal?: OverrideRefusalReason;
  authorization: OverrideAuthorizationResolution;
  sod?: { ok: boolean; violatedRoles: OverrideSodRole[]; reason?: string };
}

function ruleId(rule: OverrideApproverRule, index: number): string {
  switch (rule.kind) {
    case "identity":
      return `identity:${rule.identity}#${index}`;
    case "group_ref":
      return `group_ref:${rule.group_ref}#${index}`;
    case "role":
      return `role:${rule.role}#${index}`;
    case "trusted_override_actors_allowlist":
      return `trusted_override_actors_allowlist#${index}`;
  }
}

/**
 * Resolve whether `actor` may record/use an override under class policy.
 * Fail closed when actor is null/unauthenticated.
 */
export async function authorizeOverrideActor(
  input: AuthorizeOverrideInput,
): Promise<AuthorizeOverrideResult> {
  const baseAuth: OverrideAuthorizationResolution = {
    authorized: false,
    matched_rule: null,
    evidence: "not evaluated",
    identity_source: input.identitySource,
  };

  if (input.actor === null || input.actor.trim() === "") {
    return {
      authorized: false,
      refusal: "unauthenticated",
      authorization: {
        ...baseAuth,
        evidence: "actor is null or empty — fail closed",
      },
    };
  }

  const actor = input.actor.trim();
  const sod = checkOverrideSeparationOfDuties({
    enabled: input.classPolicy.separation_of_duties.enabled,
    forbidRoles: input.classPolicy.separation_of_duties.forbid_roles,
    actor,
    implementer: input.implementer,
    findingAuthor: input.findingAuthor,
  });
  if (!sod.ok) {
    return {
      authorized: false,
      refusal: "sod_violation",
      authorization: {
        ...baseAuth,
        evidence: sod.reason ?? "separation of duties violation",
      },
      sod,
    };
  }

  const rules = input.classPolicy.approvers;
  // Implicit governance with only the allowlist rule: any authenticated actor
  // (trust filter already constrained comment authors; record path uses getGhActor).
  if (rules.length === 0 && input.implicitGovernance) {
    return {
      authorized: true,
      authorization: {
        authorized: true,
        matched_rule: "implicit:any_authenticated",
        evidence: `implicit governance accepts authenticated actor ${actor}`,
        identity_source: input.identitySource,
      },
      sod,
    };
  }

  if (rules.length === 0) {
    return {
      authorized: false,
      refusal: "unauthorized",
      authorization: {
        ...baseAuth,
        evidence: "no approver rules configured for class",
      },
      sod,
    };
  }

  const allowlist = (input.trustedAllowlist ?? []).map((a) => a.toLowerCase());

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const id = ruleId(rule, i);

    if (rule.kind === "identity") {
      if (actor.toLowerCase() === rule.identity.toLowerCase()) {
        return {
          authorized: true,
          authorization: {
            authorized: true,
            matched_rule: id,
            evidence: `identity match for actor ${actor}`,
            identity_source: input.identitySource,
          },
          sod,
        };
      }
    } else if (rule.kind === "group_ref") {
      const members = input.adapter?.resolveGroupMembers
        ? await input.adapter.resolveGroupMembers(rule.group_ref)
        : [];
      if (members.some((m) => m.toLowerCase() === actor.toLowerCase())) {
        return {
          authorized: true,
          authorization: {
            authorized: true,
            matched_rule: id,
            evidence: `group_ref ${rule.group_ref} membership for ${actor}`,
            identity_source: input.identitySource,
          },
          sod,
        };
      }
    } else if (rule.kind === "role") {
      const has = input.adapter?.actorHasRole
        ? await input.adapter.actorHasRole(actor, rule.role)
        : false;
      if (has) {
        return {
          authorized: true,
          authorization: {
            authorized: true,
            matched_rule: id,
            evidence: `role ${rule.role} for ${actor}`,
            identity_source: input.identitySource,
          },
          sod,
        };
      }
    } else if (rule.kind === "trusted_override_actors_allowlist") {
      if (input.implicitGovernance) {
        // Continuity with pre-governance: authenticated actor is enough;
        // trusted_override_actors only extends who may author sentinels.
        return {
          authorized: true,
          authorization: {
            authorized: true,
            matched_rule: id,
            evidence: `trusted_override_actors_allowlist (implicit) accepts ${actor}`,
            identity_source: input.identitySource,
          },
          sod,
        };
      }
      // Explicit config: actor must appear on the allowlist (or be the only
      // path when allowlist is empty — then any authenticated, matching today).
      if (allowlist.length === 0 || allowlist.includes(actor.toLowerCase())) {
        return {
          authorized: true,
          authorization: {
            authorized: true,
            matched_rule: id,
            evidence:
              allowlist.length === 0
                ? `trusted_override_actors_allowlist empty — authenticated ${actor}`
                : `trusted_override_actors allowlist includes ${actor}`,
            identity_source: input.identitySource,
          },
          sod,
        };
      }
    }
  }

  return {
    authorized: false,
    refusal: "unauthorized",
    authorization: {
      ...baseAuth,
      evidence: `actor ${actor} matched no approver rule`,
    },
    sod,
  };
}

export function checkOverrideSeparationOfDuties(input: {
  enabled: boolean;
  forbidRoles: OverrideSodRole[];
  actor: string;
  implementer?: string | null;
  findingAuthor?: string | null;
}): { ok: boolean; violatedRoles: OverrideSodRole[]; reason?: string } {
  if (!input.enabled) return { ok: true, violatedRoles: [] };
  const violated: OverrideSodRole[] = [];
  const actor = input.actor.toLowerCase();
  if (
    input.forbidRoles.includes("implementer") &&
    input.implementer &&
    input.implementer.toLowerCase() === actor
  ) {
    violated.push("implementer");
  }
  if (
    input.forbidRoles.includes("finding_author") &&
    input.findingAuthor &&
    input.findingAuthor.toLowerCase() === actor
  ) {
    violated.push("finding_author");
  }
  if (violated.length === 0) return { ok: true, violatedRoles: [] };
  return {
    ok: false,
    violatedRoles: violated,
    reason: `separation of duties forbids override by roles: ${violated.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Evidence refs
// ---------------------------------------------------------------------------

const EVIDENCE_TOKEN_RE = /\b([a-z_]+)=(\S+)/gi;

/** Parse `kind=value` tokens from free-text (CLI reason tail). */
export function parseEvidenceRefTokens(text: string): OverrideEvidenceRefs {
  const refs: OverrideEvidenceRefs = {};
  for (const m of text.matchAll(EVIDENCE_TOKEN_RE)) {
    refs[m[1]!.toLowerCase()] = m[2]!;
  }
  return refs;
}

/** Strip `kind=value` tokens from explanation so disposition parse stays clean. */
export function stripEvidenceRefTokens(text: string): string {
  return text.replace(EVIDENCE_TOKEN_RE, "").replace(/\s+/g, " ").trim();
}

export function missingRequiredEvidence(
  classPolicy: OverrideClassPolicy,
  evidenceRefs: OverrideEvidenceRefs,
  remediationRefs: OverrideEvidenceRefs = {},
): OverrideEvidenceRefKind[] {
  const missing: OverrideEvidenceRefKind[] = [];
  for (const kind of classPolicy.required_evidence) {
    const v = evidenceRefs[kind] ?? remediationRefs[kind];
    if (!v || !String(v).trim()) missing.push(kind);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Decision construction (append-only — never mutates prior)
// ---------------------------------------------------------------------------

export function newDecisionId(): string {
  return randomUUID();
}

export function computeExpiresAt(createdAtIso: string, maxDurationHours: number): string {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) {
    throw new Error(`invalid created_at: ${createdAtIso}`);
  }
  if (!Number.isInteger(maxDurationHours) || maxDurationHours < 1) {
    throw new Error(`invalid max_duration_hours: ${maxDurationHours}`);
  }
  return new Date(created + maxDurationHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function codeRegionDigest(file: string | undefined, lineStart: number | undefined): string {
  const f = (file ?? "").toLowerCase();
  const bucket =
    !lineStart || lineStart < 1 ? 0 : Math.floor((lineStart - 1) / 5) * 5 + 1;
  return createHash("sha1").update(`${f}|${bucket}`).digest("hex").slice(0, 16);
}

export function buildOverrideDecision(input: {
  classId: string;
  disposition: string;
  target: OverrideTarget;
  explanation: string;
  actor: string;
  identitySource: string;
  authorization: OverrideAuthorizationResolution;
  evidenceRefs?: OverrideEvidenceRefs;
  remediationRefs?: OverrideEvidenceRefs;
  evidenceSubject?: EvidenceSubjectV1;
  findingFingerprint?: string | null;
  codeRegion?: string | null;
  createdAt: string;
  maxDurationHours: number;
  supersedes?: string | null;
  renewedFrom?: string | null;
  renewalKind?: "lite" | "human" | null;
  decisionId?: string;
  legacyCompat?: boolean;
}): OverrideDecisionV1 {
  return {
    schema_version: 1,
    decision_id: input.decisionId ?? newDecisionId(),
    class: input.classId,
    disposition: input.disposition,
    target: input.target,
    explanation: input.explanation,
    actor: input.actor,
    identity_source: input.identitySource,
    authorization: input.authorization,
    evidence_refs: { ...(input.evidenceRefs ?? {}) },
    remediation_refs: { ...(input.remediationRefs ?? {}) },
    evidence_subject: input.evidenceSubject,
    finding_fingerprint: input.findingFingerprint ?? null,
    code_region: input.codeRegion ?? null,
    created_at: input.createdAt,
    expires_at: computeExpiresAt(input.createdAt, input.maxDurationHours),
    lifecycle: "active",
    supersedes: input.supersedes ?? null,
    renewed_from: input.renewedFrom ?? null,
    renewal_kind: input.renewalKind ?? null,
    invalidation_reason: null,
    legacy_compat: input.legacyCompat,
  };
}

// ---------------------------------------------------------------------------
// Pure validity evaluation
// ---------------------------------------------------------------------------

export interface EvaluateOverrideValidityInput {
  decision: OverrideDecisionV1;
  /** Evaluation pin subject; null skips subject currency (legacy call sites). */
  pin: EvidenceSubjectV1 | null;
  live: LiveOverrideContext;
  classPolicy: OverrideClassPolicy | null;
  /** Wall-clock now (ms since epoch). Injectable for tests. */
  now: number;
  /**
   * When re-checking authorization under current policy. If omitted, the
   * decision's stored authorization.authorized is trusted (renewal-lite inherits).
   */
  reauthorize?: AuthorizeOverrideResult | null;
  /** When a later decision supersedes/renews this one, pass its id. */
  supersededBy?: string | null;
  renewedBy?: string | null;
}

/**
 * Pure validity gate. Only `status === "active"` unblocks a finding.
 */
export function evaluateOverrideValidity(
  input: EvaluateOverrideValidityInput,
): OverrideValidityResult {
  const d = input.decision;

  if (d.lifecycle === "rejected") {
    return { status: "rejected", reason: "decision was rejected at record time" };
  }
  if (input.supersededBy || d.lifecycle === "superseded") {
    return {
      status: "superseded",
      reason: input.supersededBy
        ? `superseded by ${input.supersededBy}`
        : "decision is superseded",
      invalidation_reason: "superseded",
    };
  }
  if (input.renewedBy || d.lifecycle === "renewed") {
    return {
      status: "renewed",
      reason: input.renewedBy
        ? `renewed by ${input.renewedBy}`
        : "decision was renewed (predecessor)",
    };
  }

  // Scope match (when live context supplies the check)
  if (d.target.kind === "scope" && input.live.scope_matches === false) {
    return { status: "scope_mismatch", reason: "live finding is outside decision scope" };
  }

  // Expiry
  const expiresMs = Date.parse(d.expires_at);
  if (Number.isFinite(expiresMs) && input.now >= expiresMs) {
    return {
      status: "expired",
      reason: `expires_at ${d.expires_at} is in the past`,
      invalidation_reason: "expired",
    };
  }

  // Authorization re-check
  if (input.reauthorize) {
    if (!input.reauthorize.authorized) {
      return {
        status: "unauthorized",
        reason: input.reauthorize.authorization.evidence,
        invalidation_reason: "authorization_revoked",
      };
    }
  } else if (!d.authorization.authorized && !d.legacy_compat) {
    return {
      status: "unauthorized",
      reason: "stored authorization is not authorized",
      invalidation_reason: "authorization_revoked",
    };
  }

  // Evidence subject currency
  if (d.evidence_subject) {
    if (input.pin) {
      const cmp = compareEvidenceSubjects(d.evidence_subject, input.pin);
      if (cmp.outcome === "malformed") {
        return {
          status: "invalidated",
          reason: "decision evidence_subject is malformed",
          invalidation_reason: "subject_malformed",
        };
      }
      if (cmp.outcome === "mismatch") {
        // Governed dimensions for override currency
        const governed = new Set([
          "candidate_sha",
          "policy_hash",
          "verifier_fingerprint",
          "engine_fingerprint",
          "diff_hash",
          "required_evidence_set_revision",
        ]);
        const mismatched = cmp.mismatched_fields.filter((f) => governed.has(f));
        if (mismatched.length > 0) {
          return {
            status: "invalidated",
            reason: `evidence_subject mismatch: ${mismatched.join(", ")}`,
            invalidation_reason: "subject_mismatch",
            mismatched_subject_fields: mismatched,
          };
        }
      }
    }
    // pin null → skip subject check (call site lacks pin)
  }
  // legacy_unbound (no subject): honor for low-risk / legacy_compat only; never
  // treat as high-risk authority evidence. Still subject to expiry above.

  // Fingerprint / region drift for key targets (invalidates currency when live known)
  if (d.target.kind === "key") {
    if (
      d.finding_fingerprint &&
      input.live.finding_fingerprint &&
      d.finding_fingerprint !== input.live.finding_fingerprint
    ) {
      return {
        status: "invalidated",
        reason: "finding fingerprint drift",
        invalidation_reason: "fingerprint_drift",
      };
    }
    if (
      d.code_region &&
      input.live.code_region &&
      d.code_region !== input.live.code_region
    ) {
      return {
        status: "invalidated",
        reason: "code region drift",
        invalidation_reason: "region_drift",
      };
    }
  }

  if (!input.classPolicy && !d.legacy_compat) {
    return {
      status: "malformed",
      reason: `unknown class policy for "${d.class}"`,
    };
  }

  return { status: "active", reason: "currently valid" };
}

// ---------------------------------------------------------------------------
// Active projection (append-only ledger → last valid active per target)
// ---------------------------------------------------------------------------

export function targetKey(target: OverrideTarget): string {
  if (target.kind === "key") return `key:${target.key}`;
  return `scope:${target.scopeType}:${target.scopeValue}`;
}

export interface ProjectActiveOverridesInput {
  decisions: readonly OverrideDecisionV1[];
  governance: OverrideGovernanceConfig;
  pin: EvidenceSubjectV1 | null;
  now: number;
  /** Optional live context keyed by targetKey. */
  liveByTarget?: Map<string, LiveOverrideContext>;
}

export interface ProjectedDecision {
  decision: OverrideDecisionV1;
  validity: OverrideValidityResult;
}

/**
 * Project lifecycle over an append-only decision list.
 * Later decisions for the same target supersede earlier ones for the active view;
 * prior records are never mutated — only marked via projection.
 */
export function projectActiveOverrides(
  input: ProjectActiveOverridesInput,
): {
  /** Latest currently-valid active decision per target. */
  activeByTarget: Map<string, ProjectedDecision>;
  /** Full projection for every decision (append-only history view). */
  all: ProjectedDecision[];
} {
  // Group by target in append order
  const byTarget = new Map<string, OverrideDecisionV1[]>();
  for (const d of input.decisions) {
    const k = targetKey(d.target);
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k)!.push(d);
  }

  const successorOf = new Map<string, { supersedes?: string; renews?: string }>();
  for (const list of byTarget.values()) {
    for (let i = 0; i < list.length; i++) {
      const d = list[i]!;
      if (d.supersedes) {
        const prev = successorOf.get(d.supersedes) ?? {};
        prev.supersedes = d.decision_id;
        successorOf.set(d.supersedes, prev);
      }
      if (d.renewed_from) {
        const prev = successorOf.get(d.renewed_from) ?? {};
        prev.renews = d.decision_id;
        successorOf.set(d.renewed_from, prev);
      }
      // Implicit supersession: later decision same target without explicit link
      if (i > 0) {
        const earlier = list[i - 1]!;
        if (!d.supersedes && !d.renewed_from) {
          const prev = successorOf.get(earlier.decision_id) ?? {};
          if (!prev.supersedes && !prev.renews) {
            prev.supersedes = d.decision_id;
            successorOf.set(earlier.decision_id, prev);
          }
        }
      }
    }
  }

  const all: ProjectedDecision[] = [];
  const activeByTarget = new Map<string, ProjectedDecision>();

  for (const d of input.decisions) {
    const tk = targetKey(d.target);
    const succ = successorOf.get(d.decision_id);
    const classPolicy = getClassPolicy(input.governance, d.class);
    const live = input.liveByTarget?.get(tk) ?? {};
    const validity = evaluateOverrideValidity({
      decision: d,
      pin: input.pin,
      live,
      classPolicy,
      now: input.now,
      supersededBy: succ?.supersedes ?? null,
      renewedBy: succ?.renews ?? null,
    });
    const projected: ProjectedDecision = { decision: d, validity };
    all.push(projected);
    if (validity.status === "active") {
      activeByTarget.set(tk, projected);
    }
  }

  return { activeByTarget, all };
}

/**
 * Convert active projection into the Map/scopes shapes partitionFindings expects.
 */
export function activeProjectionToPartitionInputs(
  activeByTarget: Map<string, ProjectedDecision>,
): {
  overrides: Map<string, string>;
  scopes: Array<{
    type: "category" | "file";
    value: string;
    disposition: string;
    reason: string;
  }>;
} {
  const overrides = new Map<string, string>();
  const scopes: Array<{
    type: "category" | "file";
    value: string;
    disposition: string;
    reason: string;
  }> = [];
  for (const { decision } of activeByTarget.values()) {
    if (decision.target.kind === "key") {
      overrides.set(decision.target.key, decision.disposition);
    } else {
      scopes.push({
        type: decision.target.scopeType,
        value: decision.target.scopeValue,
        disposition: decision.disposition,
        reason: decision.explanation,
      });
    }
  }
  return { overrides, scopes };
}

// ---------------------------------------------------------------------------
// Renewal-lite
// ---------------------------------------------------------------------------

export interface RenewalLiteEligibilityInput {
  prior: OverrideDecisionV1;
  classPolicy: OverrideClassPolicy;
  live: LiveOverrideContext;
  pin: EvidenceSubjectV1 | null;
  now: number;
  /** Whether prior actor would still authorize under current policy. */
  priorAuthStillHolds: boolean;
}

export type RenewalLiteResult =
  | { eligible: true }
  | {
      eligible: false;
      reason: string;
      drift: OverrideRequireHumanOn | "expired_not_due" | "mode_forbids" | "auth_revoked";
    };

/**
 * Renewal-lite may auto-renew only when fingerprint + code region still match,
 * subject is current, prior auth still holds, and class mode is `lite`.
 */
export function evaluateRenewalLiteEligibility(
  input: RenewalLiteEligibilityInput,
): RenewalLiteResult {
  const { prior, classPolicy, live, pin, now, priorAuthStillHolds } = input;

  if (classPolicy.renewal.mode === "none") {
    return { eligible: false, reason: "renewal mode is none", drift: "mode_forbids" };
  }
  if (classPolicy.renewal.mode === "human") {
    return { eligible: false, reason: "renewal mode is human", drift: "mode_forbids" };
  }

  const expiresMs = Date.parse(prior.expires_at);
  // Eligible at or after expiry (or scheduled revalidation near expiry)
  if (Number.isFinite(expiresMs) && now < expiresMs) {
    // Still current — not yet due; caller may still pre-check drift
  }

  if (!priorAuthStillHolds) {
    return {
      eligible: false,
      reason: "prior authorization no longer holds under current policy",
      drift: "auth_revoked",
    };
  }

  const requireHuman = new Set(classPolicy.renewal.require_human_on);

  if (
    requireHuman.has("fingerprint_drift") &&
    prior.finding_fingerprint &&
    live.finding_fingerprint &&
    prior.finding_fingerprint !== live.finding_fingerprint
  ) {
    return {
      eligible: false,
      reason: "finding fingerprint drift blocks lite renewal",
      drift: "fingerprint_drift",
    };
  }

  if (
    requireHuman.has("region_drift") &&
    prior.code_region &&
    live.code_region &&
    prior.code_region !== live.code_region
  ) {
    return {
      eligible: false,
      reason: "code region drift blocks lite renewal",
      drift: "region_drift",
    };
  }

  if (requireHuman.has("subject_mismatch") && prior.evidence_subject && pin) {
    const cmp = compareEvidenceSubjects(prior.evidence_subject, pin);
    if (cmp.outcome === "mismatch" || cmp.outcome === "malformed") {
      return {
        eligible: false,
        reason: `evidence subject ${cmp.outcome} blocks lite renewal`,
        drift: "subject_mismatch",
      };
    }
  }

  if (requireHuman.has("policy_change") && prior.evidence_subject && pin) {
    if (prior.evidence_subject.policy_hash !== pin.policy_hash) {
      return {
        eligible: false,
        reason: "policy_hash change blocks lite renewal",
        drift: "policy_change",
      };
    }
  }

  return { eligible: true };
}

/**
 * Append a lite renewal decision. Does NOT mutate `prior` (including expires_at).
 */
export function buildLiteRenewalDecision(
  prior: OverrideDecisionV1,
  classPolicy: OverrideClassPolicy,
  createdAt: string,
): OverrideDecisionV1 {
  return buildOverrideDecision({
    classId: prior.class,
    disposition: prior.disposition,
    target: prior.target,
    explanation: prior.explanation,
    actor: prior.actor,
    identitySource: prior.identity_source,
    authorization: { ...prior.authorization },
    evidenceRefs: { ...prior.evidence_refs },
    remediationRefs: { ...prior.remediation_refs },
    evidenceSubject: prior.evidence_subject,
    findingFingerprint: prior.finding_fingerprint,
    codeRegion: prior.code_region,
    createdAt,
    maxDurationHours: classPolicy.max_duration_hours,
    renewedFrom: prior.decision_id,
    renewalKind: "lite",
  });
}

/**
 * Human renewal: full new decision with lineage; prior immutable.
 */
export function buildHumanRenewalDecision(
  prior: OverrideDecisionV1,
  input: Omit<
    Parameters<typeof buildOverrideDecision>[0],
    "renewedFrom" | "renewalKind" | "supersedes"
  >,
): OverrideDecisionV1 {
  return buildOverrideDecision({
    ...input,
    renewedFrom: prior.decision_id,
    renewalKind: "human",
  });
}

// ---------------------------------------------------------------------------
// Record-path validation (refuse before post)
// ---------------------------------------------------------------------------

export interface ValidateOverrideRecordInput {
  governance: OverrideGovernanceConfig;
  classId: string | undefined;
  actor: string | null;
  identitySource: string;
  explanation: string;
  evidenceRefs?: OverrideEvidenceRefs;
  remediationRefs?: OverrideEvidenceRefs;
  trustedAllowlist?: string[];
  adapter?: OverrideIdentityAdapter;
  implementer?: string | null;
  findingAuthor?: string | null;
}

export type ValidateOverrideRecordResult =
  | {
      ok: true;
      classId: string;
      classPolicy: OverrideClassPolicy;
      authorization: OverrideAuthorizationResolution;
      evidenceRefs: OverrideEvidenceRefs;
      explanation: string;
    }
  | {
      ok: false;
      refusal: OverrideRefusalReason;
      message: string;
    };

/**
 * Class / authority / evidence / SoD checks before posting an override.
 */
export async function validateOverrideRecord(
  input: ValidateOverrideRecordInput,
): Promise<ValidateOverrideRecordResult> {
  const classRes = resolveClassId(input.governance, input.classId);
  if ("error" in classRes) {
    return { ok: false, refusal: "unknown_class", message: classRes.error };
  }
  const classPolicy = getClassPolicy(input.governance, classRes.classId);
  if (!classPolicy) {
    return {
      ok: false,
      refusal: "unknown_class",
      message: `Unknown override class "${classRes.classId}".`,
    };
  }

  const rawExplanation = input.explanation.trim();
  if (!rawExplanation) {
    return {
      ok: false,
      refusal: "empty_explanation",
      message: "Override reason must not be empty.",
    };
  }

  const tokenRefs = parseEvidenceRefTokens(rawExplanation);
  const evidenceRefs = { ...tokenRefs, ...(input.evidenceRefs ?? {}) };
  const remediationRefs = { ...(input.remediationRefs ?? {}) };
  // Remediation kinds often live in the same token stream
  for (const k of ["remediation_issue_url"] as const) {
    if (evidenceRefs[k] && !remediationRefs[k]) remediationRefs[k] = evidenceRefs[k];
  }

  const missing = missingRequiredEvidence(classPolicy, evidenceRefs, remediationRefs);
  if (missing.length > 0) {
    return {
      ok: false,
      refusal: "missing_evidence",
      message: `Class "${classRes.classId}" requires evidence refs: ${missing.join(", ")}. Pass as kind=value tokens in the reason.`,
    };
  }

  const auth = await authorizeOverrideActor({
    actor: input.actor,
    identitySource: input.identitySource,
    classPolicy,
    trustedAllowlist: input.trustedAllowlist,
    implicitGovernance: input.governance.implicit === true,
    adapter: input.adapter,
    implementer: input.implementer,
    findingAuthor: input.findingAuthor,
  });

  if (!auth.authorized) {
    return {
      ok: false,
      refusal: auth.refusal ?? "unauthorized",
      message:
        auth.refusal === "unauthenticated"
          ? "Cannot record override: unauthenticated actor (getGhActor returned null)."
          : auth.refusal === "sod_violation"
            ? auth.authorization.evidence
            : `Unauthorized to record override class "${classRes.classId}": ${auth.authorization.evidence}`,
    };
  }

  const explanation = stripEvidenceRefTokens(rawExplanation) || rawExplanation;

  return {
    ok: true,
    classId: classRes.classId,
    classPolicy,
    authorization: auth.authorization,
    evidenceRefs,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function buildOverrideEvent(
  type: OverrideEventType,
  fields: {
    decision_id?: string;
    prior_decision_id?: string;
    class?: string;
    actor?: string | null;
    target?: OverrideTarget;
    lifecycle?: OverrideLifecycle | OverrideValidityStatus;
    reason?: string;
    invalidation_reason?: OverrideInvalidationReason;
    mismatched_subject_fields?: string[];
    expires_at?: string;
    created_at?: string;
    at?: string;
  },
): Record<string, unknown> {
  return {
    schema_version: 1,
    type,
    at: fields.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    decision_id: fields.decision_id ?? null,
    prior_decision_id: fields.prior_decision_id ?? null,
    class: fields.class ?? null,
    actor: fields.actor ?? null,
    target: fields.target ?? null,
    lifecycle: fields.lifecycle ?? null,
    reason: fields.reason ?? null,
    invalidation_reason: fields.invalidation_reason ?? null,
    mismatched_subject_fields: fields.mismatched_subject_fields ?? null,
    expires_at: fields.expires_at ?? null,
    created_at: fields.created_at ?? null,
  };
}

/** Shallow freeze helper for tests asserting append-only (no in-place mutate). */
export function freezeDecision(d: OverrideDecisionV1): Readonly<OverrideDecisionV1> {
  return Object.freeze({
    ...d,
    target: Object.freeze({ ...d.target }),
    authorization: Object.freeze({ ...d.authorization }),
    evidence_refs: Object.freeze({ ...d.evidence_refs }),
    remediation_refs: Object.freeze({ ...d.remediation_refs }),
    evidence_subject: d.evidence_subject ? Object.freeze({ ...d.evidence_subject }) : undefined,
  });
}
