// Shared recommend-and-commit resolution (#1326).
// Thin wrapper around grill-settle.settleRecommendation — not a second classifier.
// Maps durable-pause aliases onto the public three-member typed-request union.

import { candidateEpochChanged, candidateEpochFromSha } from "./issue-stage-adapters.ts";
import type { TypedRequestKind } from "./grill-decisions.ts";
import {
  defaultSettlementSignals,
  parseSignalsFromModel,
  settleRecommendation,
  type SettlementResult,
  type SettlementSignals,
} from "./grill-settle.ts";
import type { LoopHumanInputRequestKind } from "./loop/types.ts";

export const PUBLIC_TYPED_REQUESTS = [
  "DecisionRequest",
  "CapabilityRequest",
  "AuthorityRequest",
] as const;

export type PublicTypedRequest = (typeof PUBLIC_TYPED_REQUESTS)[number];

export const PAUSE_KIND_TO_TYPED_REQUEST = {
  decision: "DecisionRequest",
  answer: "CapabilityRequest",
  "authority-grant": "AuthorityRequest",
} as const satisfies Record<LoopHumanInputRequestKind, PublicTypedRequest>;

export const TYPED_REQUEST_TO_PAUSE_KIND = {
  DecisionRequest: "decision",
  CapabilityRequest: "answer",
  AuthorityRequest: "authority-grant",
} as const satisfies Record<PublicTypedRequest, LoopHumanInputRequestKind>;

export const PROTECTED_AUTHORITY_OPERATIONS = [
  "merge",
  "release",
  "deploy",
  "secret",
  "override",
] as const;

export type FalseHumanSource =
  | "unknown-error"
  | "stale-label"
  | "retry-exhaustion"
  | "low-confidence";

export interface DecisionResolutionPackage {
  recommendation: string;
  rationale: string;
  alternatives: string[];
  risk: string;
  evidence: string[];
}

export interface CapabilityRequestRecord {
  missing: string;
  provider: string;
  live_probe: string;
  resume_condition: string;
}

export interface AuthorityRequestRecord {
  eligible_actor: string;
  repository: string;
  operation: string;
  scope: string;
  candidate_epoch: string | null;
  evidence: string[];
  expiry: string;
  /** AuthorityRequest never records a default grant. */
  grant: null;
}

export type TypedRequestResolution =
  | {
      kind: "auto-settle";
      package: DecisionResolutionPackage;
      eligibility_reason: string;
    }
  | {
      kind: "DecisionRequest";
      package: DecisionResolutionPackage;
      pause_kind: "decision";
      durable_class: "specification-decision";
    }
  | {
      kind: "CapabilityRequest";
      record: CapabilityRequestRecord;
      pause_kind: "answer";
    }
  | {
      kind: "external-condition-wait";
      record: CapabilityRequestRecord;
    }
  | {
      kind: "AuthorityRequest";
      record: AuthorityRequestRecord;
      pause_kind: "authority-grant";
      durable_class: "missing-authority";
    }
  | { kind: "engine-owned"; reason: string };

export interface ResolveTypedRequestInput {
  nodeClass: string;
  recommendation: string;
  factText?: string;
  signals?: Record<string, unknown> | Partial<SettlementSignals>;
  category?: "product-decision" | "authority" | null;
  source?: FalseHumanSource | "diagnostic" | "grill";
  externalConditionWithoutInput?: boolean;
  capability?: Partial<CapabilityRequestRecord>;
  authority?: Partial<Omit<AuthorityRequestRecord, "grant">>;
  tipPresent?: boolean;
  candidateSha?: string | null;
  now?: Date;
  rationale?: string;
  alternatives?: string[];
  risk?: string;
  evidence?: string[];
}

export function pauseKindToTypedRequest(
  kind: LoopHumanInputRequestKind | string,
): PublicTypedRequest | null {
  if (kind === "decision" || kind === "answer" || kind === "authority-grant") {
    return PAUSE_KIND_TO_TYPED_REQUEST[kind];
  }
  return null;
}

export function typedRequestToPauseKind(request: PublicTypedRequest): LoopHumanInputRequestKind {
  return TYPED_REQUEST_TO_PAUSE_KIND[request];
}

export function durableClassForTypedRequest(
  request: PublicTypedRequest,
): "specification-decision" | "missing-authority" | null {
  if (request === "DecisionRequest") return "specification-decision";
  if (request === "AuthorityRequest") return "missing-authority";
  return null;
}

export function isProtectedAuthorityOperation(operation: string): boolean {
  const token = operation.trim().toLowerCase();
  return (PROTECTED_AUTHORITY_OPERATIONS as readonly string[]).includes(token);
}

export function validateDecisionPackage(
  pkg: Partial<DecisionResolutionPackage> | null | undefined,
): { ok: true; package: DecisionResolutionPackage } | { ok: false; reason: string } {
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, reason: "decision resolution package is missing" };
  }
  if (typeof pkg.recommendation !== "string" || !pkg.recommendation.trim()) {
    return { ok: false, reason: "decision resolution missing recommendation" };
  }
  if (typeof pkg.rationale !== "string" || !pkg.rationale.trim()) {
    return { ok: false, reason: "decision resolution missing rationale" };
  }
  if (!Array.isArray(pkg.alternatives) || pkg.alternatives.some((a) => typeof a !== "string")) {
    return { ok: false, reason: "decision resolution missing alternatives" };
  }
  if (typeof pkg.risk !== "string" || !pkg.risk.trim()) {
    return { ok: false, reason: "decision resolution missing risk" };
  }
  if (!Array.isArray(pkg.evidence) || pkg.evidence.length === 0 || pkg.evidence.some((e) => typeof e !== "string")) {
    return { ok: false, reason: "decision resolution missing evidence" };
  }
  return {
    ok: true,
    package: {
      recommendation: pkg.recommendation,
      rationale: pkg.rationale,
      alternatives: pkg.alternatives,
      risk: pkg.risk,
      evidence: pkg.evidence,
    },
  };
}

export function validateCapabilityRequest(
  record: Partial<CapabilityRequestRecord> | null | undefined,
): { ok: true; record: CapabilityRequestRecord } | { ok: false; reason: string } {
  if (!record || typeof record !== "object") {
    return { ok: false, reason: "CapabilityRequest is missing" };
  }
  if (typeof record.missing !== "string" || !record.missing.trim()) {
    return { ok: false, reason: "CapabilityRequest missing capability or information" };
  }
  if (typeof record.provider !== "string" || !record.provider.trim()) {
    return { ok: false, reason: "CapabilityRequest missing provider" };
  }
  if (typeof record.live_probe !== "string" || !record.live_probe.trim()) {
    return { ok: false, reason: "CapabilityRequest missing live probe" };
  }
  if (typeof record.resume_condition !== "string" || !record.resume_condition.trim()) {
    return { ok: false, reason: "CapabilityRequest missing resume condition" };
  }
  return {
    ok: true,
    record: {
      missing: record.missing,
      provider: record.provider,
      live_probe: record.live_probe,
      resume_condition: record.resume_condition,
    },
  };
}

export function validateAuthorityRequest(
  record: Partial<AuthorityRequestRecord> | null | undefined,
  tipPresent = false,
): { ok: true; record: AuthorityRequestRecord } | { ok: false; reason: string } {
  if (!record || typeof record !== "object") {
    return { ok: false, reason: "AuthorityRequest is missing" };
  }
  if ("grant" in record && record.grant !== null && record.grant !== undefined) {
    return { ok: false, reason: "AuthorityRequest must not record a default grant" };
  }
  if (typeof record.eligible_actor !== "string" || !record.eligible_actor.trim()) {
    return { ok: false, reason: "AuthorityRequest missing eligible actor" };
  }
  if (typeof record.repository !== "string" || !record.repository.trim()) {
    return { ok: false, reason: "AuthorityRequest missing repository" };
  }
  if (typeof record.operation !== "string" || !record.operation.trim()) {
    return { ok: false, reason: "AuthorityRequest missing operation" };
  }
  if (typeof record.scope !== "string" || !record.scope.trim()) {
    return { ok: false, reason: "AuthorityRequest missing scope" };
  }
  if (typeof record.expiry !== "string" || !record.expiry.trim()) {
    return { ok: false, reason: "AuthorityRequest missing expiry" };
  }
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    return { ok: false, reason: "AuthorityRequest missing evidence" };
  }
  const epoch =
    typeof record.candidate_epoch === "string" && record.candidate_epoch.trim()
      ? record.candidate_epoch.trim()
      : null;
  if (tipPresent && !epoch) {
    return { ok: false, reason: "AuthorityRequest missing candidate epoch while a tip exists" };
  }
  return {
    ok: true,
    record: {
      eligible_actor: record.eligible_actor,
      repository: record.repository,
      operation: record.operation,
      scope: record.scope,
      candidate_epoch: epoch,
      evidence: record.evidence,
      expiry: record.expiry,
      grant: null,
    },
  };
}

export function defaultAuthorityExpiry(now = new Date()): string {
  return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function inferProtectedOperation(recommendation: string, nodeClass: string): string {
  const rec = recommendation.toLowerCase();
  if (/\boverride\b/.test(rec)) return "override";
  if (/\bsecret\b|\bcredential\b/.test(rec)) return "secret";
  if (/\bdeploy\b/.test(rec)) return "deploy";
  if (/\brelease\b/.test(rec) && !/\bnotes\b|\bchangelog\b/.test(rec)) return "release";
  if (/\bmerge\b/.test(rec) || nodeClass === "merge-release") return "merge";
  if (nodeClass === "security") return "security";
  if (nodeClass === "irreversible-operations") return "irreversible-operation";
  if (nodeClass === "human-attestation") return "human-attestation";
  return "protected-action";
}

export function isCandidateBoundRequestStale(input: {
  boundSha?: string | null;
  boundEpoch?: string | null;
  currentSha?: string | null;
  leftoverBlockedLabel?: boolean;
}): boolean {
  const bound = (input.boundEpoch ?? input.boundSha ?? "").trim();
  const current = (input.currentSha ?? "").trim();
  if (!bound) return false;
  void input.leftoverBlockedLabel;
  return candidateEpochChanged(bound, current);
}

function signalsFromInput(input: ResolveTypedRequestInput): SettlementSignals {
  const factText = input.factText ?? "";
  if (input.signals && !Array.isArray(input.signals)) {
    return parseSignalsFromModel(
      input.signals as Record<string, unknown>,
      input.nodeClass,
      input.recommendation,
      factText,
    );
  }
  return defaultSettlementSignals(input.nodeClass, input.recommendation, factText);
}

function buildPackage(
  input: ResolveTypedRequestInput,
  result: SettlementResult,
): DecisionResolutionPackage {
  const rec = (input.recommendation ?? "").trim() || "(none)";
  const rationale =
    (typeof input.rationale === "string" && input.rationale.trim()) ||
    (result.kind === "auto-accept"
      ? result.eligibility_reason
      : result.kind === "typed-request"
        ? result.reason
        : result.reason);
  const evidence =
    input.evidence && input.evidence.length > 0
      ? input.evidence
      : (input.factText ?? "").trim()
        ? [input.factText!.trim()]
        : [rationale];
  return {
    recommendation: rec,
    rationale,
    alternatives: Array.isArray(input.alternatives) ? input.alternatives : [],
    risk:
      (typeof input.risk === "string" && input.risk.trim()) ||
      (result.kind === "typed-request" && result.request === "AuthorityRequest" ? "high" : "low"),
    evidence,
  };
}

function buildCapabilityRecord(input: ResolveTypedRequestInput): Partial<CapabilityRequestRecord> {
  const missing =
    input.capability?.missing ??
    (input.recommendation.trim() || "missing information or capability");
  return {
    missing,
    provider: input.capability?.provider ?? "operator",
    live_probe:
      input.capability?.live_probe ??
      `live probe for ${missing}`,
    resume_condition:
      input.capability?.resume_condition ??
      (input.externalConditionWithoutInput
        ? "external condition becomes true without supplied input"
        : "supplied input restores the missing capability or information"),
  };
}

function buildAuthorityRecord(input: ResolveTypedRequestInput): Partial<AuthorityRequestRecord> {
  const sha = (input.candidateSha ?? input.authority?.candidate_epoch ?? "").trim();
  const epoch = sha ? candidateEpochFromSha(sha).epoch_id : (input.authority?.candidate_epoch ?? null);
  return {
    eligible_actor: input.authority?.eligible_actor,
    repository: input.authority?.repository,
    operation:
      input.authority?.operation ?? inferProtectedOperation(input.recommendation, input.nodeClass),
    scope: input.authority?.scope ?? input.nodeClass,
    candidate_epoch: epoch,
    evidence:
      input.authority?.evidence ??
      ((input.factText ?? "").trim() ? [input.factText!.trim()] : [input.recommendation || "protected action"]),
    expiry: input.authority?.expiry ?? defaultAuthorityExpiry(input.now ?? new Date()),
    grant: null,
  };
}

/**
 * Shared recommend-and-commit classifier. Always calls settleRecommendation
 * except for false-human sources that must not manufacture a typed request.
 */
export function resolveTypedRequest(input: ResolveTypedRequestInput): TypedRequestResolution {
  if (input.source === "unknown-error" || input.source === "stale-label" || input.source === "retry-exhaustion") {
    return { kind: "engine-owned", reason: input.source };
  }

  if (input.externalConditionWithoutInput) {
    const rec = validateCapabilityRequest(buildCapabilityRecord(input));
    if (!rec.ok) return { kind: "engine-owned", reason: rec.reason };
    return { kind: "external-condition-wait", record: rec.record };
  }

  const signals = signalsFromInput(input);
  const result = settleRecommendation(
    { class: input.nodeClass, recommendation: input.recommendation },
    signals,
    input.factText ?? "",
  );

  if (input.category === "authority") {
    const rec = validateAuthorityRequest(buildAuthorityRecord(input), input.tipPresent === true);
    if (!rec.ok) return { kind: "engine-owned", reason: rec.reason };
    return {
      kind: "AuthorityRequest",
      record: rec.record,
      pause_kind: "authority-grant",
      durable_class: "missing-authority",
    };
  }

  if (result.kind === "auto-accept") {
    const pkg = validateDecisionPackage(buildPackage(input, result));
    if (!pkg.ok) return { kind: "engine-owned", reason: pkg.reason };
    return {
      kind: "auto-settle",
      package: pkg.package,
      eligibility_reason: result.eligibility_reason,
    };
  }

  if (result.kind === "typed-request") {
    if (result.request === "DecisionRequest") {
      const pkg = validateDecisionPackage(buildPackage(input, result));
      if (!pkg.ok) return { kind: "engine-owned", reason: pkg.reason };
      return {
        kind: "DecisionRequest",
        package: pkg.package,
        pause_kind: "decision",
        durable_class: "specification-decision",
      };
    }
    if (result.request === "CapabilityRequest") {
      const rec = validateCapabilityRequest(buildCapabilityRecord(input));
      if (!rec.ok) return { kind: "engine-owned", reason: rec.reason };
      return { kind: "CapabilityRequest", record: rec.record, pause_kind: "answer" };
    }
    const rec = validateAuthorityRequest(buildAuthorityRecord(input), input.tipPresent === true);
    if (!rec.ok) return { kind: "engine-owned", reason: rec.reason };
    return {
      kind: "AuthorityRequest",
      record: rec.record,
      pause_kind: "authority-grant",
      durable_class: "missing-authority",
    };
  }

  if (input.category === "product-decision") {
    const pkg = validateDecisionPackage(buildPackage(input, result));
    if (!pkg.ok) return { kind: "engine-owned", reason: pkg.reason };
    return {
      kind: "DecisionRequest",
      package: pkg.package,
      pause_kind: "decision",
      durable_class: "specification-decision",
    };
  }

  return {
    kind: "engine-owned",
    reason: result.kind === "unresolved" ? result.reason : "unclassified",
  };
}

export interface ClassifyHumanAskInput extends ResolveTypedRequestInput {
  reasonCode?: string;
}

/** Map a stage diagnostic / park candidate onto the shared classifier. */
export function classifyHumanAsk(input: ClassifyHumanAskInput): TypedRequestResolution {
  const reasonCode = input.reasonCode ?? "";
  if (
    reasonCode &&
    reasonCode !== "human-decision-required" &&
    reasonCode !== "human-context-required" &&
    input.source !== "diagnostic" &&
    input.source !== "grill" &&
    input.source !== "low-confidence"
  ) {
    if (!input.category) {
      return { kind: "engine-owned", reason: `reason_code ${reasonCode} is not a typed request` };
    }
  }

  if (reasonCode === "human-context-required" && !input.externalConditionWithoutInput) {
    return resolveTypedRequest({
      ...input,
      nodeClass: input.nodeClass || "operational-default",
      signals: {
        ...(input.signals as Record<string, unknown> | undefined),
        missing_external: true,
        contradictory: false,
      },
    });
  }

  return resolveTypedRequest({
    ...input,
    nodeClass:
      input.nodeClass ||
      (input.category === "authority" ? "merge-release" : "interface-contract"),
  });
}

export function shouldReleaseAutoSettleableHold(input: ResolveTypedRequestInput): boolean {
  return resolveTypedRequest(input).kind === "auto-settle";
}

export type { TypedRequestKind };
export { settleRecommendation };
