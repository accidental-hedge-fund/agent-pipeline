// Durable resumable human-question handoffs (#647).
//
// Versioned side-contract for parking work with a bounded question, eligibility,
// answer lifecycle, and fail-closed resume revalidation. Complements labels /
// comments / intervention events — does NOT introduce a parallel workflow SM.
//
// Pure helpers + injectable fs store. Unit tests never touch network/git/subprocess.

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { artifactSubdir, HANDOFFS_ARTIFACT } from "./artifact-ignore.ts";
import type { IdentityAdapter } from "./pre-code-attestation.ts";
import { resolveAuthorizedApprover, type ApproverResolutionResult } from "./pre-code-attestation.ts";
import type { PreCodeApproverRule } from "./types.ts";
import { candidateEpochChanged } from "./issue-stage-adapters.ts";
import type { TypedRequestKind } from "./grill-decisions.ts";
import {
  validateAuthorityRequest,
  validateCapabilityRequest,
  validateDecisionPackage,
  type AuthorityRequestRecord,
  type CapabilityRequestRecord,
  type DecisionResolutionPackage,
} from "./typed-request-resolution.ts";

export { HANDOFFS_ARTIFACT };

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export const HANDOFF_SCHEMA_VERSION = 1 as const;

/** Closed handoff classes. Authority-bearing classes require authority evidence at create. */
export const HANDOFF_CLASSES = [
  "missing_context",
  "product_judgment",
  "domain_expertise",
  "risk_authority",
  "override_disposition",
  "manual_repair",
  "unknown",
] as const;
export type HandoffClass = (typeof HANDOFF_CLASSES)[number];

export const HANDOFF_STATUSES = [
  "pending",
  "answered",
  "rejected",
  "superseded",
  "expired",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const AUTHORITY_MODES = ["authority", "non_authority"] as const;
export type AuthorityMode = (typeof AUTHORITY_MODES)[number];

/** Classes that default to authority-bearing when create supplies authority evidence. */
export const AUTHORITY_BEARING_CLASSES: ReadonlySet<HandoffClass> = new Set([
  "product_judgment",
  "risk_authority",
  "override_disposition",
]);

/** Non-authority by definition — answers never grant approval/attestation/override. */
export const NON_AUTHORITY_CLASSES: ReadonlySet<HandoffClass> = new Set([
  "missing_context",
  "domain_expertise",
  "manual_repair",
  "unknown",
]);

export const MAX_QUESTION_LENGTH = 4000;
export const MAX_ANSWER_LENGTH = 8000;
export const MAX_REASON_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface HumanDecisionRequiredEvidence {
  finding_key: string;
  finding_fingerprint: string;
  reviewed_sha: string;
  category?: "product-decision" | "authority";
}

export interface HandoffScopeHashes {
  candidate_sha: string | null;
  candidate_epoch?: string | null;
  plan_revision?: string | null;
  dossier_hash?: string | null;
  policy_hash?: string | null;
  spec_hashes?: string[];
  content_hashes?: string[];
}

export interface HandoffEligibilityEvidence {
  unresolved: boolean;
  eligible_actors: string[];
  resolution_summary: string;
  matched_rule_ids?: string[];
}

export interface HandoffAnswer {
  decision: "answer" | "reject";
  responder: string;
  identity_source: string;
  answer_text: string | null;
  answered_at: string;
  supporting_evidence?: string | null;
  /** Payload hash used for idempotency. */
  payload_hash: string;
  /** Explicit client request id when supplied. */
  client_request_id?: string | null;
  /** True when this body was recorded; duplicates leave this as the original. */
  authorization_evidence?: string | null;
}

export interface HumanQuestionHandoff {
  schema_version: typeof HANDOFF_SCHEMA_VERSION;
  handoff_id: string;
  domain: string;
  repo: string;
  issue_number: number;
  run_id: string | null;
  attempt_id: string | null;
  blocked_stage: string;
  question: string;
  reason: string;
  handoff_class: HandoffClass;
  authority_mode: AuthorityMode;
  human_decision_required: HumanDecisionRequiredEvidence | null;
  /** True when create used a policy-bound authority gate other than HDR (e.g. pre-code wait). */
  policy_bound_authority_gate?: boolean;
  scope: HandoffScopeHashes;
  required_capability: string[];
  resolution_evidence: HandoffEligibilityEvidence;
  status: HandoffStatus;
  created_at: string;
  expires_at: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  answer: HandoffAnswer | null;
  resume_target: string;
  resume_preconditions: string[];
  /** Identity used for idempotent create reuse (finding key + fp + sha). */
  declaration_identity?: string | null;
  typed_request?: TypedRequestKind;
  decision_package?: DecisionResolutionPackage;
  capability_request?: CapabilityRequestRecord;
  authority_request?: AuthorityRequestRecord;
}

export type HandoffAuditOp =
  | "create"
  | "answer"
  | "reject"
  | "supersede"
  | "expire"
  | "resume_attempt"
  | "create_failed"
  | "answer_refused"
  | "resume_refused";

export interface HandoffAuditEvent {
  schema_version: 1;
  at: string;
  op: HandoffAuditOp;
  handoff_id: string;
  issue_number: number;
  actor?: string | null;
  detail: string;
  duplicate?: boolean;
  payload_hash?: string | null;
  status_after?: HandoffStatus | null;
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface HandoffParseResult {
  ok: true;
  handoff: HumanQuestionHandoff;
}

export interface HandoffParseFailure {
  ok: false;
  reason: string;
  raw?: unknown;
}

export type HandoffValidation = HandoffParseResult | HandoffParseFailure;

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function isHandoffClass(v: unknown): v is HandoffClass {
  return typeof v === "string" && (HANDOFF_CLASSES as readonly string[]).includes(v);
}

function isHandoffStatus(v: unknown): v is HandoffStatus {
  return typeof v === "string" && (HANDOFF_STATUSES as readonly string[]).includes(v);
}

function isAuthorityMode(v: unknown): v is AuthorityMode {
  return typeof v === "string" && (AUTHORITY_MODES as readonly string[]).includes(v);
}

function isShaLike(v: unknown): boolean {
  return typeof v === "string" && /^[0-9a-fA-F]{7,64}$/.test(v);
}

/**
 * Default authority mode for a class. `unknown` and pure context classes are
 * always non_authority. Authority-bearing classes still need create-time evidence.
 */
export function defaultAuthorityModeForClass(cls: HandoffClass): AuthorityMode {
  if (NON_AUTHORITY_CLASSES.has(cls)) return "non_authority";
  if (AUTHORITY_BEARING_CLASSES.has(cls)) return "authority";
  return "non_authority";
}

/** Pure schema validation. Unknown schema_version fails closed for resume consumers. */
export function parseHumanQuestionHandoff(raw: unknown): HandoffValidation {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "handoff record is not an object", raw };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== HANDOFF_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported schema_version: ${String(o.schema_version)} (supported: ${HANDOFF_SCHEMA_VERSION})`,
      raw,
    };
  }
  if (!isNonEmptyString(o.handoff_id, 200)) {
    return { ok: false, reason: "missing or invalid handoff_id", raw };
  }
  if (!isNonEmptyString(o.domain, 200)) {
    return { ok: false, reason: "missing or invalid domain", raw };
  }
  if (!isNonEmptyString(o.repo, 300)) {
    return { ok: false, reason: "missing or invalid repo", raw };
  }
  if (typeof o.issue_number !== "number" || !Number.isInteger(o.issue_number) || o.issue_number < 1) {
    return { ok: false, reason: "missing or invalid issue_number", raw };
  }
  if (o.run_id !== null && o.run_id !== undefined && typeof o.run_id !== "string") {
    return { ok: false, reason: "invalid run_id", raw };
  }
  if (o.attempt_id !== null && o.attempt_id !== undefined && typeof o.attempt_id !== "string") {
    return { ok: false, reason: "invalid attempt_id", raw };
  }
  if (!isNonEmptyString(o.blocked_stage, 100)) {
    return { ok: false, reason: "missing or invalid blocked_stage", raw };
  }
  if (typeof o.question !== "string" || o.question.trim().length === 0) {
    return { ok: false, reason: "missing or empty question", raw };
  }
  if (o.question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, reason: `question exceeds ${MAX_QUESTION_LENGTH} characters`, raw };
  }
  if (typeof o.reason !== "string" || o.reason.length > MAX_REASON_LENGTH) {
    return { ok: false, reason: "missing or oversized reason", raw };
  }
  if (!isHandoffClass(o.handoff_class)) {
    return { ok: false, reason: `unknown handoff_class: ${String(o.handoff_class)}`, raw };
  }
  if (!isAuthorityMode(o.authority_mode)) {
    return { ok: false, reason: `invalid authority_mode: ${String(o.authority_mode)}`, raw };
  }
  // Class/mode consistency: unknown must be non_authority.
  if (o.handoff_class === "unknown" && o.authority_mode !== "non_authority") {
    return { ok: false, reason: "handoff_class unknown requires authority_mode non_authority", raw };
  }
  if (NON_AUTHORITY_CLASSES.has(o.handoff_class) && o.authority_mode === "authority") {
    // Allow only if an explicit policy gate was recorded (rare); default refuse for
    // missing_context / domain_expertise / manual_repair / unknown.
    if (o.handoff_class !== "risk_authority" && !o.policy_bound_authority_gate) {
      return {
        ok: false,
        reason: `class ${o.handoff_class} cannot be authority_mode authority without policy_bound_authority_gate`,
        raw,
      };
    }
  }
  if (!isHandoffStatus(o.status)) {
    return { ok: false, reason: `invalid status: ${String(o.status)}`, raw };
  }
  if (!isNonEmptyString(o.created_at, 40)) {
    return { ok: false, reason: "missing created_at", raw };
  }
  if (o.expires_at !== null && o.expires_at !== undefined && typeof o.expires_at !== "string") {
    return { ok: false, reason: "invalid expires_at", raw };
  }
  if (!isNonEmptyString(o.resume_target, 200)) {
    return { ok: false, reason: "missing or invalid resume_target", raw };
  }
  if (!Array.isArray(o.resume_preconditions) || o.resume_preconditions.some((p) => typeof p !== "string")) {
    return { ok: false, reason: "resume_preconditions must be string[]", raw };
  }
  if (!Array.isArray(o.required_capability) || o.required_capability.some((c) => typeof c !== "string")) {
    return { ok: false, reason: "required_capability must be string[]", raw };
  }
  if (o.scope === null || typeof o.scope !== "object") {
    return { ok: false, reason: "missing scope", raw };
  }
  const scope = o.scope as Record<string, unknown>;
  if (
    scope.candidate_sha !== null &&
    scope.candidate_sha !== undefined &&
    typeof scope.candidate_sha !== "string"
  ) {
    return { ok: false, reason: "invalid candidate_sha", raw };
  }
  if (o.resolution_evidence === null || typeof o.resolution_evidence !== "object") {
    return { ok: false, reason: "missing resolution_evidence", raw };
  }
  const re = o.resolution_evidence as Record<string, unknown>;
  if (typeof re.unresolved !== "boolean") {
    return { ok: false, reason: "resolution_evidence.unresolved must be boolean", raw };
  }
  if (!Array.isArray(re.eligible_actors) || re.eligible_actors.some((a) => typeof a !== "string")) {
    return { ok: false, reason: "resolution_evidence.eligible_actors must be string[]", raw };
  }
  if (typeof re.resolution_summary !== "string") {
    return { ok: false, reason: "resolution_evidence.resolution_summary must be string", raw };
  }

  let humanDecision: HumanDecisionRequiredEvidence | null = null;
  if (o.human_decision_required != null) {
    if (typeof o.human_decision_required !== "object") {
      return { ok: false, reason: "invalid human_decision_required", raw };
    }
    const hdr = o.human_decision_required as Record<string, unknown>;
    if (
      !isNonEmptyString(hdr.finding_key, 64) ||
      !isNonEmptyString(hdr.finding_fingerprint, 64) ||
      !isNonEmptyString(hdr.reviewed_sha, 64)
    ) {
      return { ok: false, reason: "human_decision_required missing key/fingerprint/reviewed_sha", raw };
    }
    humanDecision = {
      finding_key: hdr.finding_key,
      finding_fingerprint: hdr.finding_fingerprint,
      reviewed_sha: hdr.reviewed_sha,
      ...(hdr.category === "product-decision" || hdr.category === "authority"
        ? { category: hdr.category }
        : {}),
    };
  }

  let answer: HandoffAnswer | null = null;
  if (o.answer != null) {
    if (typeof o.answer !== "object") {
      return { ok: false, reason: "invalid answer", raw };
    }
    const a = o.answer as Record<string, unknown>;
    if (a.decision !== "answer" && a.decision !== "reject") {
      return { ok: false, reason: "answer.decision must be answer|reject", raw };
    }
    if (!isNonEmptyString(a.responder, 200) || !isNonEmptyString(a.identity_source, 100)) {
      return { ok: false, reason: "answer missing responder/identity_source", raw };
    }
    if (!isNonEmptyString(a.answered_at, 40) || !isNonEmptyString(a.payload_hash, 128)) {
      return { ok: false, reason: "answer missing answered_at/payload_hash", raw };
    }
    answer = {
      decision: a.decision,
      responder: a.responder,
      identity_source: a.identity_source,
      answer_text: typeof a.answer_text === "string" ? a.answer_text : null,
      answered_at: a.answered_at,
      supporting_evidence:
        typeof a.supporting_evidence === "string" ? a.supporting_evidence : null,
      payload_hash: a.payload_hash,
      client_request_id:
        typeof a.client_request_id === "string" ? a.client_request_id : null,
      authorization_evidence:
        typeof a.authorization_evidence === "string" ? a.authorization_evidence : null,
    };
  }

  const handoff: HumanQuestionHandoff = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: o.handoff_id as string,
    domain: o.domain as string,
    repo: o.repo as string,
    issue_number: o.issue_number as number,
    run_id: (o.run_id as string | null | undefined) ?? null,
    attempt_id: (o.attempt_id as string | null | undefined) ?? null,
    blocked_stage: o.blocked_stage as string,
    question: (o.question as string).trim(),
    reason: o.reason as string,
    handoff_class: o.handoff_class,
    authority_mode: o.authority_mode,
    human_decision_required: humanDecision,
    policy_bound_authority_gate: o.policy_bound_authority_gate === true,
    scope: {
      candidate_sha: (scope.candidate_sha as string | null | undefined) ?? null,
      candidate_epoch:
        typeof scope.candidate_epoch === "string" && scope.candidate_epoch.trim()
          ? scope.candidate_epoch
          : null,
      plan_revision: (scope.plan_revision as string | null | undefined) ?? null,
      dossier_hash: (scope.dossier_hash as string | null | undefined) ?? null,
      policy_hash: (scope.policy_hash as string | null | undefined) ?? null,
      spec_hashes: Array.isArray(scope.spec_hashes)
        ? (scope.spec_hashes as string[]).filter((s) => typeof s === "string")
        : undefined,
      content_hashes: Array.isArray(scope.content_hashes)
        ? (scope.content_hashes as string[]).filter((s) => typeof s === "string")
        : undefined,
    },
    required_capability: o.required_capability as string[],
    resolution_evidence: {
      unresolved: re.unresolved,
      eligible_actors: re.eligible_actors as string[],
      resolution_summary: re.resolution_summary as string,
      matched_rule_ids: Array.isArray(re.matched_rule_ids)
        ? (re.matched_rule_ids as string[]).filter((s) => typeof s === "string")
        : undefined,
    },
    status: o.status,
    created_at: o.created_at as string,
    expires_at: (o.expires_at as string | null | undefined) ?? null,
    supersedes: typeof o.supersedes === "string" ? o.supersedes : null,
    superseded_by: typeof o.superseded_by === "string" ? o.superseded_by : null,
    answer,
    resume_target: o.resume_target as string,
    resume_preconditions: o.resume_preconditions as string[],
    declaration_identity:
      typeof o.declaration_identity === "string" ? o.declaration_identity : null,
  };

  const typed = o.typed_request;
  if (typed === "DecisionRequest" || typed === "CapabilityRequest" || typed === "AuthorityRequest") {
    handoff.typed_request = typed;
    if (typed === "DecisionRequest") {
      const pkg = validateDecisionPackage(o.decision_package as DecisionResolutionPackage | undefined);
      if (!pkg.ok) return { ok: false, reason: pkg.reason, raw };
      handoff.decision_package = pkg.package;
    } else if (typed === "CapabilityRequest") {
      const rec = validateCapabilityRequest(o.capability_request as CapabilityRequestRecord | undefined);
      if (!rec.ok) return { ok: false, reason: rec.reason, raw };
      handoff.capability_request = rec.record;
    } else {
      const rec = validateAuthorityRequest(
        o.authority_request as AuthorityRequestRecord | undefined,
        Boolean(handoff.scope.candidate_sha),
      );
      if (!rec.ok) return { ok: false, reason: rec.reason, raw };
      handoff.authority_request = rec.record;
    }
  }
  return { ok: true, handoff };
}

// ---------------------------------------------------------------------------
// Create eligibility
// ---------------------------------------------------------------------------

export interface CreateHandoffInput {
  domain: string;
  repo: string;
  issue_number: number;
  run_id?: string | null;
  attempt_id?: string | null;
  blocked_stage: string;
  question: string;
  reason: string;
  handoff_class: HandoffClass;
  /** When omitted, derived from class. */
  authority_mode?: AuthorityMode;
  required_capability: string[];
  candidate_sha?: string | null;
  /** When true, create fails if candidate_sha is missing (PR/worktree tip exists). */
  tip_present?: boolean;
  plan_revision?: string | null;
  dossier_hash?: string | null;
  policy_hash?: string | null;
  spec_hashes?: string[];
  content_hashes?: string[];
  human_decision_required?: HumanDecisionRequiredEvidence | null;
  /** Equivalent policy-bound authority gate (e.g. active pre-code attestation wait). */
  policy_bound_authority_gate?: boolean;
  resolution_evidence?: HandoffEligibilityEvidence;
  resume_target: string;
  resume_preconditions?: string[];
  expires_at?: string | null;
  supersedes?: string | null;
  declaration_identity?: string | null;
  handoff_id?: string;
  created_at?: string;
  /**
   * When true, map engine exhaustion without a decision question to
   * manual_repair + non_authority (never product_judgment).
   */
  engine_exhaustion_without_decision?: boolean;
  typed_request?: TypedRequestKind;
  decision_package?: DecisionResolutionPackage;
  capability_request?: CapabilityRequestRecord;
  authority_request?: AuthorityRequestRecord;
  candidate_epoch?: string | null;
}

export interface CreateHandoffResult {
  ok: true;
  handoff: HumanQuestionHandoff;
}

export interface CreateHandoffFailure {
  ok: false;
  reason: string;
  code:
    | "empty_question"
    | "question_too_long"
    | "missing_capability"
    | "missing_candidate_sha"
    | "authority_evidence_required"
    | "invalid_class"
    | "invalid_authority_mode"
    | "unresolved_authority_routing"
    | "schema"
    | "incomplete_typed_request"
    | "default_authority_grant";
}

/**
 * Pure create gate. Does not persist. Authority-bearing create requires
 * human-decision-required evidence (key, fingerprint, reviewed SHA) or an
 * equivalent policy-bound authority gate (post-#787).
 */
export function canCreateHandoff(
  input: CreateHandoffInput,
): CreateHandoffResult | CreateHandoffFailure {
  if (input.engine_exhaustion_without_decision) {
    // Force typed non-authority manual repair — never product_judgment.
    input = {
      ...input,
      handoff_class: "manual_repair",
      authority_mode: "non_authority",
      human_decision_required: null,
      policy_bound_authority_gate: false,
    };
  }

  if (!isHandoffClass(input.handoff_class)) {
    return { ok: false, reason: "unknown handoff_class", code: "invalid_class" };
  }
  const q = (input.question ?? "").trim();
  if (q.length === 0) {
    return { ok: false, reason: "question is empty", code: "empty_question" };
  }
  if (q.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      reason: `question exceeds ${MAX_QUESTION_LENGTH} characters`,
      code: "question_too_long",
    };
  }
  if (!input.required_capability || input.required_capability.length === 0) {
    // Authority classes may use authority evidence as the capability obligation.
    const authMode = input.authority_mode ?? defaultAuthorityModeForClass(input.handoff_class);
    if (authMode !== "authority" && !AUTHORITY_BEARING_CLASSES.has(input.handoff_class)) {
      return {
        ok: false,
        reason: "required_capability must be non-empty for non-authority handoffs",
        code: "missing_capability",
      };
    }
  }

  const authorityMode =
    input.authority_mode ?? defaultAuthorityModeForClass(input.handoff_class);

  if (input.handoff_class === "unknown" && authorityMode === "authority") {
    return {
      ok: false,
      reason: "unknown class cannot be authority-bearing",
      code: "invalid_authority_mode",
    };
  }

  if (authorityMode === "authority") {
    const hdr = input.human_decision_required;
    const hasHdr =
      hdr &&
      isNonEmptyString(hdr.finding_key, 64) &&
      isNonEmptyString(hdr.finding_fingerprint, 64) &&
      isNonEmptyString(hdr.reviewed_sha, 64);
    if (!hasHdr && !input.policy_bound_authority_gate) {
      return {
        ok: false,
        reason:
          "authority-bearing create requires current human-decision-required evidence " +
          "(finding_key, fingerprint, reviewed_sha) or a policy-bound authority gate",
        code: "authority_evidence_required",
      };
    }
  }

  if (input.tip_present && !input.candidate_sha) {
    return {
      ok: false,
      reason: "candidate_sha required when a PR/worktree tip is present",
      code: "missing_candidate_sha",
    };
  }

  if (input.typed_request === "DecisionRequest") {
    const pkg = validateDecisionPackage(input.decision_package);
    if (!pkg.ok) {
      return { ok: false, reason: pkg.reason, code: "incomplete_typed_request" };
    }
    input = { ...input, decision_package: pkg.package };
  } else if (input.typed_request === "CapabilityRequest") {
    const rec = validateCapabilityRequest(input.capability_request);
    if (!rec.ok) {
      return { ok: false, reason: rec.reason, code: "incomplete_typed_request" };
    }
    input = { ...input, capability_request: rec.record };
  } else if (input.typed_request === "AuthorityRequest") {
    if (input.authority_request && "grant" in input.authority_request && input.authority_request.grant != null) {
      return {
        ok: false,
        reason: "AuthorityRequest must not record a default grant",
        code: "default_authority_grant",
      };
    }
    const rec = validateAuthorityRequest(input.authority_request, input.tip_present === true);
    if (!rec.ok) {
      return { ok: false, reason: rec.reason, code: "incomplete_typed_request" };
    }
    input = { ...input, authority_request: rec.record };
  }

  // Unresolved authority routing at create: fail closed when authority and no eligible actors.
  const resolution = input.resolution_evidence ?? {
    unresolved: false,
    eligible_actors: [],
    resolution_summary: "no resolution provided at create",
  };
  if (
    authorityMode === "authority" &&
    resolution.unresolved &&
    resolution.eligible_actors.length === 0
  ) {
    return {
      ok: false,
      reason: "unresolved authority routing: no eligible actor under effective policy",
      code: "unresolved_authority_routing",
    };
  }

  const createdAt = input.created_at ?? nowIso();
  const handoffId = input.handoff_id ?? `hqh_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const capabilities =
    input.required_capability && input.required_capability.length > 0
      ? input.required_capability
      : authorityMode === "authority"
        ? ["authority"]
        : [];

  const handoff: HumanQuestionHandoff = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: handoffId,
    domain: input.domain,
    repo: input.repo,
    issue_number: input.issue_number,
    run_id: input.run_id ?? null,
    attempt_id: input.attempt_id ?? null,
    blocked_stage: input.blocked_stage,
    question: q,
    reason: (input.reason ?? "").slice(0, MAX_REASON_LENGTH),
    handoff_class: input.handoff_class,
    authority_mode: authorityMode,
    human_decision_required: input.human_decision_required ?? null,
    policy_bound_authority_gate: input.policy_bound_authority_gate === true,
    scope: {
      candidate_sha: input.candidate_sha ?? null,
      candidate_epoch: input.candidate_epoch ?? input.authority_request?.candidate_epoch ?? null,
      plan_revision: input.plan_revision ?? null,
      dossier_hash: input.dossier_hash ?? null,
      policy_hash: input.policy_hash ?? null,
      spec_hashes: input.spec_hashes,
      content_hashes: input.content_hashes,
    },
    required_capability: capabilities,
    resolution_evidence: resolution,
    status: "pending",
    created_at: createdAt,
    expires_at: input.expires_at ?? null,
    supersedes: input.supersedes ?? null,
    superseded_by: null,
    answer: null,
    resume_target: input.resume_target,
    resume_preconditions: input.resume_preconditions ?? [],
    declaration_identity: input.declaration_identity ?? null,
    ...(input.typed_request ? { typed_request: input.typed_request } : {}),
    ...(input.decision_package ? { decision_package: input.decision_package } : {}),
    ...(input.capability_request ? { capability_request: input.capability_request } : {}),
    ...(input.authority_request ? { authority_request: input.authority_request } : {}),
  };

  const parsed = parseHumanQuestionHandoff(handoff);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, code: "schema" };
  }
  return { ok: true, handoff: parsed.handoff };
}

export function declarationIdentityKey(
  findingKey: string,
  fingerprint: string,
  reviewedSha: string,
): string {
  return `${findingKey}:${fingerprint}:${reviewedSha}`;
}

// ---------------------------------------------------------------------------
// Eligibility + authorization
// ---------------------------------------------------------------------------

export interface ResolveHandoffEligibilityInput {
  handoff: Pick<
    HumanQuestionHandoff,
    "authority_mode" | "required_capability" | "handoff_class" | "resolution_evidence"
  >;
  /** Pre-resolved eligible actors (from policy). */
  eligibleActors?: string[];
  /** Optional #575-style approver rules + adapter. */
  rules?: PreCodeApproverRule[];
  adapter?: IdentityAdapter;
  affectedPaths?: string[];
  affectedComponents?: string[];
  matchedRiskClasses?: string[];
  /** Probe actor used only when rules are evaluated for coverage. */
  probeActor?: string;
}

export async function resolveHandoffEligibility(
  input: ResolveHandoffEligibilityInput,
): Promise<HandoffEligibilityEvidence> {
  if (input.eligibleActors && input.eligibleActors.length > 0) {
    return {
      unresolved: false,
      eligible_actors: [...input.eligibleActors],
      resolution_summary: `explicit eligible set (${input.eligibleActors.length})`,
    };
  }

  if (input.rules && input.rules.length > 0) {
    // Use resolveAuthorizedApprover coverage shape: we care whether *any* rule
    // covers the obligations, not whether a specific actor is authorized.
    // When probeActor is absent, unresolved if no identity/group/role/path_owner rules exist.
    const hasAuthorizer = input.rules.some((r) => r.kind !== "risk_class");
    if (!hasAuthorizer) {
      return {
        unresolved: true,
        eligible_actors: [],
        resolution_summary: "unresolved: no authorizer rules in policy",
      };
    }
    if (input.probeActor) {
      const result: ApproverResolutionResult = await resolveAuthorizedApprover({
        actor: input.probeActor,
        authenticated: true,
        identitySource: "probe",
        affectedPaths: input.affectedPaths ?? [],
        affectedComponents: input.affectedComponents ?? [],
        matchedRiskClasses: input.matchedRiskClasses ?? [],
        rules: input.rules,
        adapter: input.adapter,
      });
      if (result.unresolved) {
        return {
          unresolved: true,
          eligible_actors: [],
          resolution_summary: "unresolved ownership under approver rules",
          matched_rule_ids: result.matchedRuleIds,
        };
      }
      // Collect identity-rule identities as the eligible set when present.
      const identities = input.rules
        .filter((r): r is Extract<PreCodeApproverRule, { kind: "identity" }> => r.kind === "identity")
        .map((r) => r.identity);
      return {
        unresolved: false,
        eligible_actors: identities.length > 0 ? identities : [input.probeActor],
        resolution_summary: result.authorized
          ? `probe actor ${input.probeActor} authorized under rules`
          : `rules present; probe actor not necessarily eligible`,
        matched_rule_ids: result.matchedRuleIds,
      };
    }
    const identities = input.rules
      .filter((r): r is Extract<PreCodeApproverRule, { kind: "identity" }> => r.kind === "identity")
      .map((r) => r.identity);
    if (identities.length === 0) {
      return {
        unresolved: true,
        eligible_actors: [],
        resolution_summary:
          "unresolved: policy has non-identity rules only; cannot list eligible actors without adapters",
      };
    }
    return {
      unresolved: false,
      eligible_actors: identities,
      resolution_summary: `identity rules: ${identities.join(", ")}`,
    };
  }

  // No policy inputs.
  if (input.handoff.authority_mode === "authority") {
    return {
      unresolved: true,
      eligible_actors: [],
      resolution_summary: "unresolved authority routing: no eligible actors under effective policy",
    };
  }

  // Non-authority: open to authenticated operators; no invented assignee list.
  return {
    unresolved: false,
    eligible_actors: [],
    resolution_summary:
      "non_authority: any authenticated actor may answer; does not grant approval/attestation/override",
  };
}

export interface AuthorizeHandoffAnswerInput {
  handoff: HumanQuestionHandoff;
  actor: string | null | undefined;
  identitySource: string | null | undefined;
  authenticated: boolean;
  /** Optional live re-check via #575 rules. */
  rules?: PreCodeApproverRule[];
  adapter?: IdentityAdapter;
  affectedPaths?: string[];
  affectedComponents?: string[];
  matchedRiskClasses?: string[];
}

export interface AuthorizeHandoffAnswerResult {
  ok: boolean;
  reason: string;
  /** Explicit: non-authority success never means approval/attestation/override. */
  grants_approval: false;
  grants_attestation: false;
  grants_finding_override: false;
  authorization_evidence?: string;
}

/**
 * Pure answer authorization. Authority-bearing refuses unidentified/unauthorized.
 * Non-authority answers never upgrade to approval/attestation/override.
 */
export async function authorizeHandoffAnswer(
  input: AuthorizeHandoffAnswerInput,
): Promise<AuthorizeHandoffAnswerResult> {
  const denyBase = {
    grants_approval: false as const,
    grants_attestation: false as const,
    grants_finding_override: false as const,
  };

  if (input.handoff.status !== "pending") {
    return {
      ok: false,
      reason: `handoff status is ${input.handoff.status}, not pending`,
      ...denyBase,
    };
  }

  if (input.handoff.authority_mode === "authority") {
    if (!input.authenticated || !input.actor || !input.identitySource) {
      return {
        ok: false,
        reason: "unidentified actor cannot satisfy authority-bearing handoff",
        ...denyBase,
      };
    }
    const eligible = input.handoff.resolution_evidence.eligible_actors.map((a) =>
      a.toLowerCase(),
    );
    let authorized = eligible.includes(input.actor.toLowerCase());
    let evidence = authorized
      ? `actor ${input.actor} in eligible set`
      : `actor ${input.actor} not in eligible set`;

    if (
      !authorized &&
      typeof input.handoff.declaration_identity === "string" &&
      input.handoff.declaration_identity.startsWith("grill-v1:")
    ) {
      authorized = true;
      evidence = `grill-authority: authenticated actor ${input.actor}`;
    }

    if (!authorized && input.rules && input.rules.length > 0) {
      const result = await resolveAuthorizedApprover({
        actor: input.actor,
        authenticated: true,
        identitySource: input.identitySource,
        affectedPaths: input.affectedPaths ?? [],
        affectedComponents: input.affectedComponents ?? [],
        matchedRiskClasses: input.matchedRiskClasses ?? [],
        rules: input.rules,
        adapter: input.adapter,
      });
      if (result.unresolved) {
        return {
          ok: false,
          reason: "unresolved authority routing under current policy",
          ...denyBase,
        };
      }
      authorized = result.authorized;
      evidence = result.resolutions.map((r) => r.evidence).join("; ");
    }

    // Authority with empty eligible set and no rules → fail closed.
    if (
      !authorized &&
      eligible.length === 0 &&
      (!input.rules || input.rules.length === 0)
    ) {
      return {
        ok: false,
        reason: "unresolved authority routing: no eligible actor under effective policy",
        ...denyBase,
      };
    }

    if (!authorized) {
      return {
        ok: false,
        reason: `unauthorized actor for authority-bearing handoff: ${evidence}`,
        ...denyBase,
      };
    }
    return {
      ok: true,
      reason: "authorized",
      ...denyBase,
      authorization_evidence: evidence,
    };
  }

  // non_authority
  if (!input.authenticated || !input.actor) {
    // Still require a known actor for audit provenance when answering.
    return {
      ok: false,
      reason: "non-authority answer requires authenticated actor identity for provenance",
      ...denyBase,
    };
  }
  return {
    ok: true,
    reason:
      "non_authority context answer accepted; does not grant approval, attestation, or finding override",
    ...denyBase,
    authorization_evidence: `authenticated ${input.actor} via ${input.identitySource ?? "unknown"}`,
  };
}

// ---------------------------------------------------------------------------
// Answer / reject / supersede
// ---------------------------------------------------------------------------

export function payloadHash(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface AnswerHandoffInput {
  handoff: HumanQuestionHandoff;
  decision: "answer" | "reject";
  actor: string;
  identitySource: string;
  authenticated: boolean;
  answerText?: string | null;
  supportingEvidence?: string | null;
  clientRequestId?: string | null;
  rules?: PreCodeApproverRule[];
  adapter?: IdentityAdapter;
  affectedPaths?: string[];
  affectedComponents?: string[];
  matchedRiskClasses?: string[];
  now?: string;
}

export type AnswerHandoffResult =
  | {
      ok: true;
      handoff: HumanQuestionHandoff;
      duplicate: boolean;
      /** Always false — answering never advances the item by itself. */
      advances_item: false;
    }
  | { ok: false; reason: string; handoff: HumanQuestionHandoff; code: string };

export async function applyHandoffAnswer(
  input: AnswerHandoffInput,
): Promise<AnswerHandoffResult> {
  const h = input.handoff;
  const hash = payloadHash({
    handoff_id: h.handoff_id,
    decision: input.decision,
    actor: input.actor,
    answer_text: input.answerText ?? null,
    client_request_id: input.clientRequestId ?? null,
  });

  // Idempotent duplicate: same payload hash already recorded.
  if (
    h.answer &&
    (h.status === "answered" || h.status === "rejected") &&
    (h.answer.payload_hash === hash ||
      (input.clientRequestId &&
        h.answer.client_request_id &&
        h.answer.client_request_id === input.clientRequestId))
  ) {
    return { ok: true, handoff: h, duplicate: true, advances_item: false };
  }

  if (h.status === "superseded" || h.status === "expired") {
    return {
      ok: false,
      reason: `cannot ${input.decision} handoff in status ${h.status}`,
      handoff: h,
      code: "terminal_status",
    };
  }

  if (h.status === "answered" || h.status === "rejected") {
    // Different payload after terminal answer → refuse (no rewrite of prior body).
    return {
      ok: false,
      reason: "handoff already has a terminal answer; prior answer body is immutable",
      handoff: h,
      code: "already_answered",
    };
  }

  const auth = await authorizeHandoffAnswer({
    handoff: h,
    actor: input.actor,
    identitySource: input.identitySource,
    authenticated: input.authenticated,
    rules: input.rules,
    adapter: input.adapter,
    affectedPaths: input.affectedPaths,
    affectedComponents: input.affectedComponents,
    matchedRiskClasses: input.matchedRiskClasses,
  });
  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason,
      handoff: h,
      code: auth.reason.includes("unidentified")
        ? "unidentified"
        : auth.reason.includes("unresolved")
          ? "unresolved_routing"
          : "unauthorized",
    };
  }

  if (input.decision === "answer") {
    const text = (input.answerText ?? "").trim();
    if (text.length === 0) {
      return {
        ok: false,
        reason: "answer text is required for decision=answer",
        handoff: h,
        code: "empty_answer",
      };
    }
    if (text.length > MAX_ANSWER_LENGTH) {
      return {
        ok: false,
        reason: `answer exceeds ${MAX_ANSWER_LENGTH} characters`,
        handoff: h,
        code: "answer_too_long",
      };
    }
  }

  const now = input.now ?? nowIso();
  const next: HumanQuestionHandoff = {
    ...h,
    status: input.decision === "reject" ? "rejected" : "answered",
    answer: {
      decision: input.decision,
      responder: input.actor,
      identity_source: input.identitySource,
      answer_text: input.decision === "answer" ? (input.answerText ?? "").trim() : null,
      answered_at: now,
      supporting_evidence: input.supportingEvidence ?? null,
      payload_hash: hash,
      client_request_id: input.clientRequestId ?? null,
      authorization_evidence: auth.authorization_evidence ?? null,
    },
  };
  return { ok: true, handoff: next, duplicate: false, advances_item: false };
}

export interface SupersedeHandoffInput {
  prior: HumanQuestionHandoff;
  replacement: HumanQuestionHandoff;
  now?: string;
}

export interface SupersedeHandoffResult {
  ok: true;
  prior: HumanQuestionHandoff;
  replacement: HumanQuestionHandoff;
}

/**
 * Mark prior as superseded and link ids. Replacement must already be a valid
 * pending handoff (typically just created). Does not advance the item.
 */
export function supersedeHandoff(input: SupersedeHandoffInput): SupersedeHandoffResult {
  const prior: HumanQuestionHandoff = {
    ...input.prior,
    status: "superseded",
    superseded_by: input.replacement.handoff_id,
  };
  const replacement: HumanQuestionHandoff = {
    ...input.replacement,
    supersedes: input.prior.handoff_id,
    status: "pending",
  };
  return { ok: true, prior, replacement };
}

// ---------------------------------------------------------------------------
// Resume revalidation
// ---------------------------------------------------------------------------

export interface ResumeContext {
  candidate_sha: string | null;
  candidate_epoch?: string | null;
  dossier_hash?: string | null;
  policy_hash?: string | null;
  plan_revision?: string | null;
  spec_hashes?: string[];
  content_hashes?: string[];
  now?: string;
  /** Optional: re-check authority of recorded responder under current policy. */
  rules?: PreCodeApproverRule[];
  adapter?: IdentityAdapter;
  affectedPaths?: string[];
  affectedComponents?: string[];
  matchedRiskClasses?: string[];
  /** Known stage entry keys; resume_target must match exactly one when provided. */
  known_stage_entries?: string[];
  stage_preconditions_ok?: boolean;
}

export type ResumeValidation =
  | {
      ok: true;
      resume_target: string;
      handoff_id: string;
    }
  | {
      ok: false;
      reason: string;
      code:
        | "not_answered"
        | "rejected"
        | "superseded"
        | "expired"
        | "stale_sha"
        | "scope_hash_mismatch"
        | "malformed"
        | "ambiguous_resume_target"
        | "stage_preconditions"
        | "authorization_stale"
        | "unsupported_schema"
        | "no_pending_request";
      advances_item: false;
    };

/**
 * Pure resume validation. A stale, expired, superseded, or malformed answer
 * never advances. Labels are not mutated here (caller preserves them).
 */
export async function validateHandoffResume(
  handoffOrRaw: HumanQuestionHandoff | unknown,
  ctx: ResumeContext,
): Promise<ResumeValidation> {
  const parsed =
    handoffOrRaw &&
    typeof handoffOrRaw === "object" &&
    (handoffOrRaw as HumanQuestionHandoff).schema_version === HANDOFF_SCHEMA_VERSION &&
    (handoffOrRaw as HumanQuestionHandoff).handoff_id
      ? parseHumanQuestionHandoff(handoffOrRaw)
      : parseHumanQuestionHandoff(handoffOrRaw);

  if (!parsed.ok) {
    const unsupported = parsed.reason.includes("unsupported schema_version");
    return {
      ok: false,
      reason: parsed.reason,
      code: unsupported ? "unsupported_schema" : "malformed",
      advances_item: false,
    };
  }
  const h = parsed.handoff;

  if (h.status === "superseded" || h.superseded_by) {
    return {
      ok: false,
      reason: `handoff ${h.handoff_id} is superseded`,
      code: "superseded",
      advances_item: false,
    };
  }
  if (h.status === "rejected") {
    return {
      ok: false,
      reason: `handoff ${h.handoff_id} was rejected`,
      code: "rejected",
      advances_item: false,
    };
  }
  if (h.status === "expired") {
    return {
      ok: false,
      reason: `handoff ${h.handoff_id} is expired`,
      code: "expired",
      advances_item: false,
    };
  }
  if (h.status !== "answered" || !h.answer || h.answer.decision !== "answer") {
    return {
      ok: false,
      reason: `handoff ${h.handoff_id} is not answered (status=${h.status})`,
      code: "not_answered",
      advances_item: false,
    };
  }

  const now = ctx.now ?? nowIso();
  if (h.expires_at && Date.parse(h.expires_at) < Date.parse(now)) {
    return {
      ok: false,
      reason: `handoff ${h.handoff_id} expired at ${h.expires_at}`,
      code: "expired",
      advances_item: false,
    };
  }

  if (h.scope.candidate_sha) {
    if (!ctx.candidate_sha || ctx.candidate_sha !== h.scope.candidate_sha) {
      return {
        ok: false,
        reason:
          `candidate SHA mismatch: handoff bound ${h.scope.candidate_sha}, ` +
          `current ${ctx.candidate_sha ?? "(none)"}`,
        code: "stale_sha",
        advances_item: false,
      };
    }
  }
  const boundEpoch = h.scope.candidate_epoch ?? h.authority_request?.candidate_epoch ?? null;
  const currentEpoch = ctx.candidate_epoch ?? ctx.candidate_sha ?? null;
  if (boundEpoch && candidateEpochChanged(boundEpoch, currentEpoch)) {
    return {
      ok: false,
      reason:
        `candidate epoch mismatch: handoff bound ${boundEpoch}, ` +
        `current ${currentEpoch ?? "(none)"}`,
      code: "stale_sha",
      advances_item: false,
    };
  }

  if (h.scope.dossier_hash && ctx.dossier_hash !== undefined) {
    if (ctx.dossier_hash !== h.scope.dossier_hash) {
      return {
        ok: false,
        reason: "dossier hash mismatch",
        code: "scope_hash_mismatch",
        advances_item: false,
      };
    }
  }
  if (h.scope.policy_hash && ctx.policy_hash !== undefined) {
    if (ctx.policy_hash !== h.scope.policy_hash) {
      return {
        ok: false,
        reason: "policy hash mismatch",
        code: "scope_hash_mismatch",
        advances_item: false,
      };
    }
  }
  if (h.scope.plan_revision && ctx.plan_revision !== undefined) {
    if (ctx.plan_revision !== h.scope.plan_revision) {
      return {
        ok: false,
        reason: "plan revision mismatch",
        code: "scope_hash_mismatch",
        advances_item: false,
      };
    }
  }

  // Resume target must be unambiguous.
  const target = (h.resume_target ?? "").trim();
  if (!target) {
    return {
      ok: false,
      reason: "resume_target missing",
      code: "ambiguous_resume_target",
      advances_item: false,
    };
  }
  if (ctx.known_stage_entries && ctx.known_stage_entries.length > 0) {
    const matches = ctx.known_stage_entries.filter((s) => s === target);
    if (matches.length !== 1) {
      return {
        ok: false,
        reason:
          matches.length === 0
            ? `resume_target "${target}" maps to no known stage entry`
            : `resume_target "${target}" maps to multiple stage entries`,
        code: "ambiguous_resume_target",
        advances_item: false,
      };
    }
  }

  if (ctx.stage_preconditions_ok === false) {
    return {
      ok: false,
      reason: "stage preconditions for re-entry are not satisfied",
      code: "stage_preconditions",
      advances_item: false,
    };
  }

  // Authority-bearing: re-check responder still authorized under current policy when rules provided.
  if (h.authority_mode === "authority" && ctx.rules && ctx.rules.length > 0 && h.answer) {
    const result = await resolveAuthorizedApprover({
      actor: h.answer.responder,
      authenticated: true,
      identitySource: h.answer.identity_source,
      affectedPaths: ctx.affectedPaths ?? [],
      affectedComponents: ctx.affectedComponents ?? [],
      matchedRiskClasses: ctx.matchedRiskClasses ?? [],
      rules: ctx.rules,
      adapter: ctx.adapter,
    });
    if (result.unresolved || !result.authorized) {
      return {
        ok: false,
        reason: "recorded responder is no longer authorized under current policy",
        code: "authorization_stale",
        advances_item: false,
      };
    }
  }

  return { ok: true, resume_target: target, handoff_id: h.handoff_id };
}

// ---------------------------------------------------------------------------
// Store (injectable fs)
// ---------------------------------------------------------------------------

export interface HandoffStoreDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  appendFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
  readdir: (p: string) => Promise<string[]>;
  rename?: (from: string, to: string) => Promise<void>;
}

export const defaultHandoffStoreDeps: HandoffStoreDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  readdir: (p) => fsp.readdir(p),
  rename: (from, to) => fsp.rename(from, to),
};

export function handoffsRoot(repoDir: string): string {
  return artifactSubdir(repoDir, HANDOFFS_ARTIFACT);
}

export function issueHandoffsDir(repoDir: string, issueNumber: number): string {
  return path.join(handoffsRoot(repoDir), `issue-${issueNumber}`);
}

export function handoffRecordPath(
  repoDir: string,
  issueNumber: number,
  handoffId: string,
): string {
  return path.join(issueHandoffsDir(repoDir, issueNumber), `${handoffId}.json`);
}

export function handoffAuditPath(repoDir: string, issueNumber: number): string {
  return path.join(issueHandoffsDir(repoDir, issueNumber), "audit.jsonl");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function atomicWriteJson(
  filePath: string,
  data: unknown,
  deps: HandoffStoreDeps,
): Promise<void> {
  await deps.mkdir(path.dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  if (deps.rename) {
    const tmp = `${filePath}.tmp`;
    await deps.writeFile(tmp, body);
    await deps.rename(tmp, filePath);
  } else {
    await deps.writeFile(filePath, body);
  }
}

export async function appendHandoffAudit(
  repoDir: string,
  event: HandoffAuditEvent,
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<void> {
  const p = handoffAuditPath(repoDir, event.issue_number);
  await deps.mkdir(path.dirname(p), { recursive: true });
  await deps.appendFile(p, `${JSON.stringify(event)}\n`);
}

export async function saveHandoff(
  repoDir: string,
  handoff: HumanQuestionHandoff,
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<void> {
  const parsed = parseHumanQuestionHandoff(handoff);
  if (!parsed.ok) {
    throw new Error(`refuse to persist invalid handoff: ${parsed.reason}`);
  }
  await atomicWriteJson(
    handoffRecordPath(repoDir, handoff.issue_number, handoff.handoff_id),
    parsed.handoff,
    deps,
  );
}

export async function loadHandoff(
  repoDir: string,
  issueNumber: number,
  handoffId: string,
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<HandoffValidation> {
  try {
    const raw = await deps.readFile(handoffRecordPath(repoDir, issueNumber, handoffId));
    return parseHumanQuestionHandoff(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: `handoff not found: ${handoffId}` };
    }
    return { ok: false, reason: `failed to load handoff: ${(err as Error).message}` };
  }
}

export interface ListHandoffsFilter {
  issue?: number;
  run_id?: string | null;
  status?: HandoffStatus | HandoffStatus[];
  domain?: string;
  repo?: string;
  /** Queue batch issue set — when set, only these issues. */
  batch_issue_numbers?: number[];
}

/**
 * List handoffs for an issue. When `issue` is omitted, scans all issue-* dirs
 * under the handoffs root (best-effort; ENOENT → []).
 */
export async function listHandoffs(
  repoDir: string,
  filter: ListHandoffsFilter = {},
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<HumanQuestionHandoff[]> {
  const issues: number[] = [];
  if (filter.issue !== undefined) {
    issues.push(filter.issue);
  } else if (filter.batch_issue_numbers && filter.batch_issue_numbers.length > 0) {
    issues.push(...filter.batch_issue_numbers);
  } else {
    try {
      const root = handoffsRoot(repoDir);
      const entries = await deps.readdir(root);
      for (const name of entries) {
        const m = /^issue-(\d+)$/.exec(name);
        if (m) issues.push(Number(m[1]));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  const statusSet = filter.status
    ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    : null;

  const out: HumanQuestionHandoff[] = [];
  for (const issue of issues) {
    let names: string[];
    try {
      names = await deps.readdir(issueHandoffsDir(repoDir, issue));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === "audit.json") continue;
      const id = name.replace(/\.json$/, "");
      const loaded = await loadHandoff(repoDir, issue, id, deps);
      if (!loaded.ok) continue;
      const h = loaded.handoff;
      if (filter.run_id != null && h.run_id !== filter.run_id) continue;
      if (filter.domain && h.domain !== filter.domain) continue;
      if (filter.repo && h.repo !== filter.repo) continue;
      if (statusSet && !statusSet.has(h.status)) continue;
      out.push(h);
    }
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

/**
 * Create + persist with audit. Idempotent reuse when declaration_identity
 * matches an existing pending handoff on the same issue.
 */
export async function createAndPersistHandoff(
  repoDir: string,
  input: CreateHandoffInput,
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<
  | { ok: true; handoff: HumanQuestionHandoff; reused: boolean }
  | { ok: false; reason: string; code: string }
> {
  const created = canCreateHandoff(input);
  if (!created.ok) {
    await appendHandoffAudit(
      repoDir,
      {
        schema_version: 1,
        at: nowIso(),
        op: "create_failed",
        handoff_id: input.handoff_id ?? "(none)",
        issue_number: input.issue_number,
        detail: created.reason,
        evidence: { code: created.code },
      },
      deps,
    ).catch(() => {
      /* best-effort */
    });
    return created;
  }

  if (created.handoff.declaration_identity) {
    const existing = await listHandoffs(
      repoDir,
      { issue: input.issue_number, status: "pending" },
      deps,
    );
    const match = existing.find(
      (h) => h.declaration_identity === created.handoff.declaration_identity,
    );
    if (match) {
      await appendHandoffAudit(
        repoDir,
        {
          schema_version: 1,
          at: nowIso(),
          op: "create",
          handoff_id: match.handoff_id,
          issue_number: match.issue_number,
          detail: "idempotent reuse of pending handoff with same declaration identity",
          duplicate: true,
          status_after: match.status,
        },
        deps,
      );
      return { ok: true, handoff: match, reused: true };
    }
  }

  await saveHandoff(repoDir, created.handoff, deps);
  await appendHandoffAudit(
    repoDir,
    {
      schema_version: 1,
      at: nowIso(),
      op: "create",
      handoff_id: created.handoff.handoff_id,
      issue_number: created.handoff.issue_number,
      detail: `created ${created.handoff.handoff_class}/${created.handoff.authority_mode}`,
      status_after: "pending",
    },
    deps,
  );
  return { ok: true, handoff: created.handoff, reused: false };
}

export interface GrillAnswerMaterializeHook {
  materialize(
    handoff: HumanQuestionHandoff,
    answerText: string,
  ): Promise<
    | { ok: true; wrote: boolean }
    | { ok: false; reason: string; code: string }
  >;
  /**
   * When set, a grill-authority answer runs apply + materialize + ledger save
   * under this lock. Production uses the host-local domain+issue `withLock`.
   */
  withIssueLock?: <T>(
    domain: string,
    issueNumber: number,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export async function answerAndPersistHandoff(
  repoDir: string,
  issueNumber: number,
  handoffId: string,
  input: Omit<AnswerHandoffInput, "handoff">,
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
  grillMaterialize?: GrillAnswerMaterializeHook,
): Promise<AnswerHandoffResult> {
  const loaded = await loadHandoff(repoDir, issueNumber, handoffId, deps);
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.reason,
      handoff: {
        schema_version: 1,
        handoff_id: handoffId,
        domain: "",
        repo: "",
        issue_number: issueNumber,
        run_id: null,
        attempt_id: null,
        blocked_stage: "",
        question: "?",
        reason: "",
        handoff_class: "unknown",
        authority_mode: "non_authority",
        human_decision_required: null,
        scope: { candidate_sha: null },
        required_capability: ["unknown"],
        resolution_evidence: {
          unresolved: true,
          eligible_actors: [],
          resolution_summary: "missing",
        },
        status: "pending",
        created_at: nowIso(),
        expires_at: null,
        supersedes: null,
        superseded_by: null,
        answer: null,
        resume_target: "unknown",
        resume_preconditions: [],
      },
      code: "not_found",
    };
  }
  const grillBound =
    typeof loaded.handoff.declaration_identity === "string" &&
    loaded.handoff.declaration_identity.startsWith("grill-v1:");
  const execute = () =>
    persistGrillAnswerAfterLoad(
      repoDir,
      issueNumber,
      handoffId,
      input,
      deps,
      grillMaterialize,
      loaded.handoff,
      grillBound,
    );
  if (grillBound && input.decision === "answer" && grillMaterialize?.withIssueLock) {
    try {
      return await grillMaterialize.withIssueLock(
        loaded.handoff.domain,
        loaded.handoff.issue_number,
        execute,
      );
    } catch (err) {
      return {
        ok: false,
        reason: (err as Error).message,
        handoff: loaded.handoff,
        code: "lock_held",
      };
    }
  }
  return execute();
}

async function persistGrillAnswerAfterLoad(
  repoDir: string,
  issueNumber: number,
  handoffId: string,
  input: Omit<AnswerHandoffInput, "handoff">,
  deps: HandoffStoreDeps,
  grillMaterialize: GrillAnswerMaterializeHook | undefined,
  loadedHandoff: HumanQuestionHandoff,
  grillBound: boolean,
): Promise<AnswerHandoffResult> {
  const result = await applyHandoffAnswer({ ...input, handoff: loadedHandoff });
  if (!result.ok) {
    await appendHandoffAudit(
      repoDir,
      {
        schema_version: 1,
        at: nowIso(),
        op: "answer_refused",
        handoff_id: handoffId,
        issue_number: issueNumber,
        actor: input.actor,
        detail: result.reason,
        evidence: { code: result.code },
      },
      deps,
    );
    return result;
  }
  if (grillBound && input.decision === "answer" && grillMaterialize && !result.duplicate) {
    const materialized = await grillMaterialize.materialize(
      loadedHandoff,
      input.answerText ?? "",
    );
    if (!materialized.ok) {
      await appendHandoffAudit(
        repoDir,
        {
          schema_version: 1,
          at: nowIso(),
          op: "answer_refused",
          handoff_id: handoffId,
          issue_number: issueNumber,
          actor: input.actor,
          detail: materialized.reason,
          evidence: { code: materialized.code },
        },
        deps,
      );
      return {
        ok: false,
        reason: materialized.reason,
        handoff: loadedHandoff,
        code: materialized.code,
      };
    }
  }
  if (!result.duplicate) {
    if (grillBound && input.decision === "answer") {
      try {
        await saveHandoff(repoDir, result.handoff, deps);
      } catch (err) {
        // Body may already be patched; leave ledger pending so an identical retry heals.
        await appendHandoffAudit(
          repoDir,
          {
            schema_version: 1,
            at: nowIso(),
            op: "answer_refused",
            handoff_id: handoffId,
            issue_number: issueNumber,
            actor: input.actor,
            detail: `persist after write failed: ${(err as Error).message}`,
            evidence: { code: "persist_failed" },
          },
          deps,
        ).catch(() => {});
        return {
          ok: false,
          reason: `handoff persist failed after body write: ${(err as Error).message}`,
          handoff: loadedHandoff,
          code: "persist_failed",
        };
      }
    } else {
      await saveHandoff(repoDir, result.handoff, deps);
    }
  }
  await appendHandoffAudit(
    repoDir,
    {
      schema_version: 1,
      at: nowIso(),
      op: input.decision === "reject" ? "reject" : "answer",
      handoff_id: handoffId,
      issue_number: issueNumber,
      actor: input.actor,
      detail: result.duplicate ? "duplicate delivery" : `${input.decision} recorded`,
      duplicate: result.duplicate,
      payload_hash: result.handoff.answer?.payload_hash,
      status_after: result.handoff.status,
    },
    deps,
  );
  return result;
}

export async function supersedeAndPersistHandoff(
  repoDir: string,
  priorIssue: number,
  priorId: string,
  replacementInput: CreateHandoffInput,
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<
  | { ok: true; prior: HumanQuestionHandoff; replacement: HumanQuestionHandoff }
  | { ok: false; reason: string; code: string }
> {
  const loaded = await loadHandoff(repoDir, priorIssue, priorId, deps);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, code: "not_found" };
  if (loaded.handoff.status === "superseded") {
    // Idempotent: already superseded by the same lineage.
    if (loaded.handoff.superseded_by) {
      const rep = await loadHandoff(repoDir, priorIssue, loaded.handoff.superseded_by, deps);
      if (rep.ok) {
        return { ok: true, prior: loaded.handoff, replacement: rep.handoff };
      }
    }
  }
  const created = await createAndPersistHandoff(
    repoDir,
    {
      ...replacementInput,
      issue_number: priorIssue,
      supersedes: priorId,
    },
    deps,
  );
  if (!created.ok) return created;
  const linked = supersedeHandoff({
    prior: loaded.handoff,
    replacement: created.handoff,
  });
  await saveHandoff(repoDir, linked.prior, deps);
  await saveHandoff(repoDir, linked.replacement, deps);
  await appendHandoffAudit(
    repoDir,
    {
      schema_version: 1,
      at: nowIso(),
      op: "supersede",
      handoff_id: priorId,
      issue_number: priorIssue,
      detail: `superseded by ${linked.replacement.handoff_id}`,
      status_after: "superseded",
      evidence: { superseded_by: linked.replacement.handoff_id },
    },
    deps,
  );
  return { ok: true, prior: linked.prior, replacement: linked.replacement };
}

// ---------------------------------------------------------------------------
// Operator surfaces (formatting)
// ---------------------------------------------------------------------------

export function formatHandoffListHuman(handoffs: HumanQuestionHandoff[], now = nowIso()): string {
  if (handoffs.length === 0) return "No handoffs found.";
  const lines = [
    "| id | status | class | authority | age | stage | resume | question |",
    "|----|--------|-------|-----------|-----|-------|--------|----------|",
  ];
  for (const h of handoffs) {
    const age = ageSeconds(h.created_at, now);
    const q =
      h.question.length > 48 ? `${h.question.slice(0, 45)}...` : h.question.replace(/\|/g, "/");
    lines.push(
      `| ${h.handoff_id} | ${h.status} | ${h.handoff_class} | ${h.authority_mode} | ${age}s | ${h.blocked_stage} | ${h.resume_target} | ${q} |`,
    );
  }
  return lines.join("\n");
}

export function formatHandoffShowHuman(h: HumanQuestionHandoff): string {
  const lines = [
    `Handoff: ${h.handoff_id}`,
    `Status: ${h.status}`,
    `Class: ${h.handoff_class}  authority_mode: ${h.authority_mode}`,
    `Issue: #${h.issue_number}  repo: ${h.repo}  domain: ${h.domain}`,
    `Blocked stage: ${h.blocked_stage}`,
    `Resume target: ${h.resume_target}`,
    `Candidate SHA: ${h.scope.candidate_sha ?? "(none)"}`,
    `Created: ${h.created_at}`,
    `Expires: ${h.expires_at ?? "(none)"}`,
    `Question: ${h.question}`,
    `Reason: ${h.reason}`,
    `Required capability: ${h.required_capability.join(", ") || "(none)"}`,
    `Eligibility: ${h.resolution_evidence.resolution_summary}`,
    `Eligible actors: ${h.resolution_evidence.eligible_actors.join(", ") || "(open/unresolved)"}`,
  ];
  if (h.human_decision_required) {
    lines.push(
      `HDR evidence: key=${h.human_decision_required.finding_key} ` +
        `fp=${h.human_decision_required.finding_fingerprint} ` +
        `sha=${h.human_decision_required.reviewed_sha}`,
    );
  }
  if (h.answer) {
    lines.push(
      `Answer: decision=${h.answer.decision} by ${h.answer.responder} ` +
        `(${h.answer.identity_source}) at ${h.answer.answered_at}`,
    );
    if (h.answer.answer_text) lines.push(`Answer text: ${h.answer.answer_text}`);
  }
  if (h.superseded_by) lines.push(`Superseded by: ${h.superseded_by}`);
  if (h.supersedes) lines.push(`Supersedes: ${h.supersedes}`);
  return lines.join("\n");
}

export function ageSeconds(createdAt: string, now: string): number {
  const a = Date.parse(createdAt);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 1000));
}

export interface WaitingHumanProjection {
  waiting_human_count: number;
  waiting_human_oldest_age_seconds: number | null;
  pending_handoff_ids: string[];
}

/** Pure projection for queue/budget summaries. */
export function projectWaitingHuman(
  handoffs: HumanQuestionHandoff[],
  now = nowIso(),
): WaitingHumanProjection {
  const pending = handoffs.filter((h) => h.status === "pending");
  let oldest: number | null = null;
  for (const h of pending) {
    const age = ageSeconds(h.created_at, now);
    if (oldest === null || age > oldest) oldest = age;
  }
  return {
    waiting_human_count: pending.length,
    waiting_human_oldest_age_seconds: oldest,
    pending_handoff_ids: pending.map((h) => h.handoff_id),
  };
}

export function formatStatusHandoffSection(
  handoffs: HumanQuestionHandoff[],
  now = nowIso(),
): string | null {
  const pending = handoffs.filter((h) => h.status === "pending");
  if (pending.length === 0) return null;
  const lines = [
    `Human-question handoffs (${pending.length} pending):`,
    ...pending.map((h) => {
      const q =
        h.question.length > 80 ? `${h.question.slice(0, 77)}...` : h.question;
      return (
        `- ${h.handoff_id} [${h.handoff_class}/${h.authority_mode}] ` +
        `age=${ageSeconds(h.created_at, now)}s — ${q}`
      );
    }),
    `Inspect: pipeline handoff show <id>   Answer: pipeline handoff answer <id> --text "..."`,
  ];
  return lines.join("\n");
}

/** Optional pipeline-attested comment body for operator discovery. */
export function handoffDiscoveryCommentBody(h: HumanQuestionHandoff): string {
  // Heading is registered in PIPELINE_COMMENT_KINDS (`human-question-handoff`).
  // Callers that post this body SHOULD wrap with attestPipelineComment.
  const body = [
    "## Pipeline: Human-question handoff",
    "",
    `Handoff id: \`${h.handoff_id}\``,
    `Class: \`${h.handoff_class}\`  Authority: \`${h.authority_mode}\`  Status: \`${h.status}\``,
    `Blocked stage: \`${h.blocked_stage}\`  Resume: \`${h.resume_target}\``,
    `Candidate SHA: \`${h.scope.candidate_sha ?? "none"}\``,
    "",
    "### Question",
    h.question,
    "",
    "### Reason",
    h.reason,
    "",
    `<!-- pipeline-human-question-handoff: ${h.handoff_id} -->`,
  ].join("\n");
  return body;
}

// ---------------------------------------------------------------------------
// Evidence companion record (referenced from evidence bundle)
// ---------------------------------------------------------------------------

export interface HandoffEvidenceRecord {
  handoff_id: string;
  handoff_class: HandoffClass;
  authority_mode: AuthorityMode;
  status: HandoffStatus;
  issue: number;
  candidate_sha: string | null;
  op: HandoffAuditOp;
  actor?: string | null;
  resume_ok?: boolean | null;
  resume_reason?: string | null;
  at: string;
}

export function handoffEvidenceFromAudit(
  event: HandoffAuditEvent,
  handoff?: Pick<
    HumanQuestionHandoff,
    "handoff_class" | "authority_mode" | "status" | "scope"
  >,
): HandoffEvidenceRecord {
  return {
    handoff_id: event.handoff_id,
    handoff_class: handoff?.handoff_class ?? "unknown",
    authority_mode: handoff?.authority_mode ?? "non_authority",
    status: handoff?.status ?? event.status_after ?? "pending",
    issue: event.issue_number,
    candidate_sha: handoff?.scope.candidate_sha ?? null,
    op: event.op,
    actor: event.actor ?? null,
    resume_ok:
      event.op === "resume_attempt" || event.op === "resume_refused"
        ? event.op === "resume_attempt" && event.evidence?.ok === true
        : null,
    resume_reason:
      typeof event.evidence?.reason === "string" ? event.evidence.reason : null,
    at: event.at,
  };
}

// ---------------------------------------------------------------------------
// Fix-stage helper: create authority-bearing handoff from accepted declaration
// ---------------------------------------------------------------------------

export interface HumanDecisionDeclForHandoff {
  category: "product-decision" | "authority" | "external-dependency";
  key: string;
  fingerprint: string;
  reviewedSha: string;
  request: string;
}

/**
 * Build create input for an accepted needs-human-decision declaration.
 * Authority categories → authority mode + HDR evidence.
 * external-dependency → non_authority (no human authority).
 */
export function createInputFromHumanDecisionDeclaration(args: {
  domain: string;
  repo: string;
  issue_number: number;
  blocked_stage: string;
  run_id?: string | null;
  decl: HumanDecisionDeclForHandoff;
  resume_target?: string;
  eligible_actors?: string[];
}): CreateHandoffInput {
  const authority =
    args.decl.category === "product-decision" || args.decl.category === "authority";
  return {
    domain: args.domain,
    repo: args.repo,
    issue_number: args.issue_number,
    run_id: args.run_id ?? null,
    blocked_stage: args.blocked_stage,
    question: args.decl.request,
    reason: `Accepted needs-human-decision (${args.decl.category}) for finding ${args.decl.key}`,
    handoff_class: authority ? "product_judgment" : "manual_repair",
    authority_mode: authority ? "authority" : "non_authority",
    required_capability: authority ? ["authority", "product-decision"] : ["manual-repair"],
    candidate_sha: args.decl.reviewedSha,
    tip_present: true,
    human_decision_required: authority
      ? {
          finding_key: args.decl.key,
          finding_fingerprint: args.decl.fingerprint,
          reviewed_sha: args.decl.reviewedSha,
          category: args.decl.category as "product-decision" | "authority",
        }
      : null,
    resolution_evidence: {
      unresolved: authority && (!args.eligible_actors || args.eligible_actors.length === 0),
      eligible_actors: args.eligible_actors ?? [],
      resolution_summary:
        args.eligible_actors && args.eligible_actors.length > 0
          ? `eligible: ${args.eligible_actors.join(", ")}`
          : authority
            ? "unresolved at create: operator must resolve via policy or open answer path"
            : "non_authority external-dependency wait",
    },
    // When authority has no eligible actors, create would fail. Supply a
    // sentinel open-operator capability with unresolved=false only when we
    // have actors; for park create we allow empty eligible with unresolved
    // false so the park always creates a handle (operator CLI still re-checks).
    resume_target: args.resume_target ?? "override-or-unblock",
    resume_preconditions: ["answer-valid", "candidate-sha-current"],
    declaration_identity: declarationIdentityKey(
      args.decl.key,
      args.decl.fingerprint,
      args.decl.reviewedSha,
    ),
  };
}

/**
 * Adjust create input so authority parks can persist even when eligibility is
 * not yet resolved — unresolved routing is enforced at answer time. Spec allows
 * create with HDR evidence; answer fails closed if still unresolved.
 */
export function prepareAuthorityParkCreate(input: CreateHandoffInput): CreateHandoffInput {
  if (input.authority_mode !== "authority" && input.handoff_class !== "product_judgment") {
    return input;
  }
  const re = input.resolution_evidence ?? {
    unresolved: false,
    eligible_actors: [],
    resolution_summary: "deferred eligibility to answer time",
  };
  // Do not fail create on unresolved routing for park sites — fail at answer.
  return {
    ...input,
    resolution_evidence: {
      ...re,
      unresolved: false,
      resolution_summary:
        re.eligible_actors.length > 0
          ? re.resolution_summary
          : "eligibility deferred to answer authorization (HDR evidence present at create)",
    },
  };
}

// Production site markers for escalation inventory / drift guards (#647 / #760).
// Keep these string literals stable — inventory rows reference them.
export const HANDOFF_ESCALATION_SITES = [
  {
    site_id: "human-question-handoff:create-authority-without-evidence",
    match: "authority_evidence_required",
    disposition: "deliberately-fail-closed" as const,
    notes: "authority create without HDR or policy gate",
  },
  {
    site_id: "human-question-handoff:unauthorized-answer",
    match: "unauthorized",
    disposition: "deliberately-fail-closed" as const,
    notes: "unauthorized or unidentified answer refused",
  },
  {
    site_id: "human-question-handoff:unresolved-authority-routing",
    match: "unresolved_routing",
    disposition: "deliberately-fail-closed" as const,
    notes: "no eligible actor under policy",
  },
  {
    site_id: "human-question-handoff:resume-stale-or-superseded",
    match: "stale_sha",
    disposition: "deliberately-fail-closed" as const,
    notes: "stale SHA / superseded / expired / malformed resume refuse",
  },
  {
    site_id: "human-question-handoff:pending-wait",
    match: "pending",
    disposition: "reconcile-owned" as const,
    notes: "pending human wait is not transient-retryable authority",
  },
] as const;

export type HandoffEscalationSiteId = (typeof HANDOFF_ESCALATION_SITES)[number]["site_id"];
