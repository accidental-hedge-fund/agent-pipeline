// Progressive-planning closed vocabularies (#703).
//
// Offline / research helpers only. No advance-loop wiring, no collapsed risk
// score, no productivity / expected-pain fields.

import {
  PLANNING_DEPTHS,
  type PlanningDepth,
} from "../planning-leverage/schema.ts";

export const PROGRESSIVE_PLANNING_VOCAB_VERSION = "progressive-planning-v1" as const;

/** Future staged policy id (draft/observe only for this research package). */
export const PROGRESSIVE_PLANNING_POLICY_ID = "progressive_planning_depth" as const;

/** Candidate work/risk classes — multi-label evidence dimensions, not a score. */
export const PROGRESSIVE_RISK_CLASSES = [
  "ambiguity",
  "reversibility",
  "blast_radius",
  "novelty",
  "dependency_uncertainty",
  "security_compliance",
  "observed_rework_cost",
  "unknown",
] as const;
export type ProgressiveRiskClass = (typeof PROGRESSIVE_RISK_CLASSES)[number];

/** Closed routing actions. */
export const ROUTING_ACTIONS = [
  "lightweight_plan",
  "standard_plan",
  "deepen_product",
  "deepen_technical",
  "zoom_feasibility",
  "zoom_vertical_slice",
  "preserve_assumptions",
  "request_human_authority",
] as const;
export type RoutingAction = (typeof ROUTING_ACTIONS)[number];

/**
 * Primary (depth-like) actions ordered by restrictiveness.
 * Stackable actions are handled separately.
 */
export const PRIMARY_ACTION_SEVERITY: Readonly<Record<
  Exclude<RoutingAction, "preserve_assumptions">,
  number
>> = {
  lightweight_plan: 0,
  standard_plan: 1,
  deepen_product: 2,
  deepen_technical: 2,
  zoom_feasibility: 3,
  zoom_vertical_slice: 3,
  request_human_authority: 4,
};

export const RECOMMENDED_PLANNING_DEPTHS = PLANNING_DEPTHS;
export type RecommendedPlanningDepth = PlanningDepth;

export const ROUTING_DIAGNOSTICS = [
  "conflict",
  "history_unavailable",
  "subsignal_incomplete",
  "unknown_default",
  "open_assumptions_preserved",
  "human_authority_floor",
  "invalid_action_rejected",
] as const;
export type RoutingDiagnostic = (typeof ROUTING_DIAGNOSTICS)[number];

/** Forbidden collapsed score field names (must never appear on recommendations). */
export const FORBIDDEN_SCORE_FIELDS = [
  "risk_score",
  "expected_pain",
  "leverage_score",
  "productivity_score",
] as const;

export function isProgressiveRiskClass(value: unknown): value is ProgressiveRiskClass {
  return (
    typeof value === "string" &&
    (PROGRESSIVE_RISK_CLASSES as readonly string[]).includes(value)
  );
}

export function isRoutingAction(value: unknown): value is RoutingAction {
  return (
    typeof value === "string" &&
    (ROUTING_ACTIONS as readonly string[]).includes(value)
  );
}

export function isRecommendedPlanningDepth(
  value: unknown,
): value is RecommendedPlanningDepth {
  return (
    typeof value === "string" &&
    (RECOMMENDED_PLANNING_DEPTHS as readonly string[]).includes(value)
  );
}
