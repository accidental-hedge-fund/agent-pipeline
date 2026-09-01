// Engine-owned auto-settle + typed-request classification (#1369).
// Pure: models propose; this predicate decides.

import {
  AUTO_ACCEPT_ELIGIBILITY_REASON,
  classifyAuthority,
  isGrillTaxonomyClass,
  isNonAuthorityClass,
} from "./grill-taxonomy.ts";
import type { TypedRequestKind } from "./grill-decisions.ts";
import type { HandoffClass } from "./human-question-handoff.ts";

export interface SettlementSignals {
  reversible: boolean;
  in_scope: boolean;
  policy_consistent: boolean;
  covered_by_existing_authority: boolean;
  contradictory: boolean;
  missing_external: boolean;
  discoverable_from_facts: boolean;
  protected_action: boolean;
  confidence: "low" | "medium" | "high";
}

export type SettlementResult =
  | { kind: "auto-accept"; eligibility_reason: string }
  | { kind: "typed-request"; request: TypedRequestKind; handoff_class: HandoffClass; reason: string }
  | { kind: "unresolved"; reason: string };

const PROTECTED_CLASSES = new Set([
  "security",
  "irreversible-operations",
  "merge-release",
  "human-attestation",
]);

/** Engine-owned recommendation scan. Class labels are not sufficient. */
const PROTECTED_ACTION_PATTERNS: readonly RegExp[] = [
  /\bauto[_\-]?merge\b/i,
  /\bsquash[-\s]?merge\b/i,
  /\bmerge-queue\b/i,
  /\b(?:pipeline|train)\s+--merge\b/i,
  /\bmerge\s+(?:this\s+)?(?:pr|pull request)\b/i,
  /\bmerge\s+into\s+(?:main|staging|production)\b/i,
  /\b(?:authorize|grant|allow)\s+(?:merge|release|deploy)\b/i,
  /\bdeploy\s+to\s+(?:prod|production)\b/i,
  /\bship\s+(?:this\s+)?milestone\b/i,
  /\bforce[-\s]?push\b/i,
  /\bgit\s+push\s+--force(?:-with-lease)?\b/i,
  /\bworktree\s+remove\b/i,
  /\b(?:delete|remove)\s+(?:the\s+)?(?:branch|worktree)\b/i,
  /\b(?:destroy|wipe|drop)\s+(?:the\s+)?(?:database|table|data)\b/i,
  /\birreversible\b/i,
  /\b(?:weaken|disable|bypass|skip)\b[\s\w-]{0,40}\b(?:auth|authentication|authorization|rbac)\b/i,
  /\b(?:expose|leak|commit)\s+(?:the\s+)?(?:secret|credential|password)\b/i,
  /\bsecurity-sensitive\b/i,
];

export function recommendationMatchesProtectedAction(recommendation: string): boolean {
  const rec = recommendation.trim();
  if (!rec) return false;
  return PROTECTED_ACTION_PATTERNS.some((re) => re.test(rec));
}

export function engineProtectedAction(nodeClass: string, recommendation: string): boolean {
  return PROTECTED_CLASSES.has(nodeClass) || recommendationMatchesProtectedAction(recommendation);
}

export function typedRequestHandoffClass(
  request: TypedRequestKind,
  nodeClass: string,
): HandoffClass {
  if (request === "CapabilityRequest") return "missing_context";
  if (request === "DecisionRequest") return "product_judgment";
  if (nodeClass === "security" || nodeClass === "irreversible-operations") return "risk_authority";
  return "product_judgment";
}

/**
 * Derive auto-settle predicates from taxonomy + the concrete recommendation
 * + trusted fact text. Class membership alone is not eligibility.
 */
export function deriveSettlementSignals(
  node: { class: string; recommendation: string },
  factText: string,
): SettlementSignals {
  const protectedAction = engineProtectedAction(node.class, node.recommendation);
  const recProtected = recommendationMatchesProtectedAction(node.recommendation);
  return {
    reversible: !protectedAction,
    in_scope: !recProtected,
    policy_consistent: !recProtected,
    covered_by_existing_authority: engineCoveredByExistingAuthority(
      node.class,
      node.recommendation,
      factText,
    ),
    contradictory: false,
    missing_external: false,
    discoverable_from_facts: false,
    protected_action: protectedAction,
    confidence: "medium",
  };
}

export function defaultSettlementSignals(
  nodeClass: string,
  recommendation = "",
): SettlementSignals {
  return deriveSettlementSignals({ class: nodeClass, recommendation }, "");
}

/**
 * Classify one frontier recommendation. Low confidence is ignored.
 * Discoverable facts never become CapabilityRequest.
 * Auto-accept never grants merge, release, destructive, or security authority.
 */
export function settleRecommendation(
  node: { class: string; recommendation: string },
  signals: SettlementSignals,
): SettlementResult {
  const rec = (node.recommendation ?? "").trim();
  if (signals.contradictory) {
    return {
      kind: "typed-request",
      request: "DecisionRequest",
      handoff_class: typedRequestHandoffClass("DecisionRequest", node.class),
      reason: "contradictory product requirements",
    };
  }
  if (signals.missing_external && !signals.discoverable_from_facts) {
    return {
      kind: "typed-request",
      request: "CapabilityRequest",
      handoff_class: typedRequestHandoffClass("CapabilityRequest", node.class),
      reason: "missing external ability or information",
    };
  }
  if (!isGrillTaxonomyClass(node.class)) {
    return { kind: "unresolved", reason: `unknown class ${node.class}` };
  }
  const classified = classifyAuthority(node.class);
  const recProtected = recommendationMatchesProtectedAction(rec);
  const protectedGrant =
    signals.protected_action || engineProtectedAction(node.class, rec);
  const covered = signals.covered_by_existing_authority && !recProtected && !protectedGrant;
  if (protectedGrant && !covered) {
    return {
      kind: "typed-request",
      request: "AuthorityRequest",
      handoff_class: typedRequestHandoffClass("AuthorityRequest", node.class),
      reason: "protected action lacks existing authority",
    };
  }
  if (!rec) {
    if (classified.operatorRequired) {
      return {
        kind: "typed-request",
        request: "AuthorityRequest",
        handoff_class: typedRequestHandoffClass("AuthorityRequest", node.class),
        reason: "operator-required node has no recommendation",
      };
    }
    return { kind: "unresolved", reason: "empty recommendation" };
  }
  const autoSettleOk =
    signals.reversible &&
    signals.in_scope &&
    signals.policy_consistent &&
    !recProtected &&
    (classified.mayAutoDefault || covered) &&
    !protectedGrant;
  if (autoSettleOk) {
    return { kind: "auto-accept", eligibility_reason: AUTO_ACCEPT_ELIGIBILITY_REASON };
  }
  if (classified.operatorRequired) {
    return {
      kind: "typed-request",
      request: "AuthorityRequest",
      handoff_class: typedRequestHandoffClass("AuthorityRequest", node.class),
      reason: "operator-required recommendation is not covered by existing authority",
    };
  }
  return { kind: "unresolved", reason: "recommendation does not meet auto-settle predicate" };
}

/**
 * Existing-authority coverage is engine-owned. A protected recommendation
 * is never covered, including when the model puts it in a non-authority
 * class. Non-authority classes cover only non-protected recommendations.
 * Protected classes never auto-grant from model prose. Scope (and other
 * non-protected operator-required classes) is covered only when the
 * recommendation already appears in trusted facts.
 */
export function engineCoveredByExistingAuthority(
  nodeClass: string,
  recommendation: string,
  factText: string,
): boolean {
  if (engineProtectedAction(nodeClass, recommendation)) return false;
  if (isNonAuthorityClass(nodeClass)) return true;
  const rec = recommendation.trim().toLowerCase();
  if (!rec) return false;
  return factText.toLowerCase().includes(rec);
}

/**
 * Model output may supply pause evidence (contradictory, missing_external)
 * and confidence. Authority-predicate fields are derived from taxonomy,
 * the concrete recommendation, and trusted facts, never copied from the model.
 */
export function parseSignalsFromModel(
  raw: Record<string, unknown>,
  nodeClass: string,
  recommendation = "",
  factText = "",
): SettlementSignals {
  const base = deriveSettlementSignals({ class: nodeClass, recommendation }, factText);
  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw[key];
    if (typeof v === "boolean") return v;
    return fallback;
  };
  const confidenceRaw = raw.confidence;
  const confidence =
    confidenceRaw === "low" || confidenceRaw === "medium" || confidenceRaw === "high"
      ? confidenceRaw
      : base.confidence;
  return {
    reversible: base.reversible,
    in_scope: base.in_scope,
    policy_consistent: base.policy_consistent,
    covered_by_existing_authority: base.covered_by_existing_authority,
    contradictory: bool("contradictory", base.contradictory),
    missing_external: bool("missing_external", base.missing_external),
    discoverable_from_facts: base.discoverable_from_facts,
    protected_action: base.protected_action,
    confidence,
  };
}
