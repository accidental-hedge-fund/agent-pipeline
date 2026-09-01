// Engine-owned auto-settle + typed-request classification (#1369).
// Pure: models propose; this predicate decides.

import {
  AUTO_ACCEPT_ELIGIBILITY_REASON,
  classifyAuthority,
  isGrillTaxonomyClass,
  isNonAuthorityClass,
  isOperatorRequiredClass,
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

export function typedRequestHandoffClass(
  request: TypedRequestKind,
  nodeClass: string,
): HandoffClass {
  if (request === "CapabilityRequest") return "missing_context";
  if (request === "DecisionRequest") return "product_judgment";
  if (nodeClass === "security" || nodeClass === "irreversible-operations") return "risk_authority";
  return "product_judgment";
}

export function defaultSettlementSignals(nodeClass: string): SettlementSignals {
  const operator = isOperatorRequiredClass(nodeClass);
  const protectedClass = PROTECTED_CLASSES.has(nodeClass);
  return {
    reversible: !protectedClass,
    in_scope: true,
    policy_consistent: true,
    covered_by_existing_authority: isNonAuthorityClass(nodeClass),
    contradictory: false,
    missing_external: false,
    discoverable_from_facts: false,
    protected_action: protectedClass,
    confidence: "medium",
  };
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
  const protectedGrant =
    signals.protected_action || PROTECTED_CLASSES.has(node.class);
  if (protectedGrant && !signals.covered_by_existing_authority) {
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
    (classified.mayAutoDefault || signals.covered_by_existing_authority) &&
    !(protectedGrant && !signals.covered_by_existing_authority);
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

export function parseSignalsFromModel(
  raw: Record<string, unknown>,
  nodeClass: string,
): SettlementSignals {
  const base = defaultSettlementSignals(nodeClass);
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
    reversible: bool("reversible", base.reversible),
    in_scope: bool("in_scope", base.in_scope),
    policy_consistent: bool("policy_consistent", base.policy_consistent),
    covered_by_existing_authority: bool(
      "covered_by_existing_authority",
      base.covered_by_existing_authority,
    ),
    contradictory: bool("contradictory", base.contradictory),
    missing_external: bool("missing_external", base.missing_external),
    discoverable_from_facts: bool("discoverable_from_facts", base.discoverable_from_facts),
    protected_action: bool("protected_action", base.protected_action),
    confidence,
  };
}
