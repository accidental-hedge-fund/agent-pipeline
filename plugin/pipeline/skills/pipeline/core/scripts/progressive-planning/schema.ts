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
  "history_provenance_rejected",
  "class_evidence_rejected",
  "class_evidence_missing",
  "safety_conflict",
  "subsignal_incomplete",
  "unknown_default",
  "high_severity_scan_incomplete",
  "open_assumptions_preserved",
  "human_authority_floor",
  "assumption_count_id_mismatch",
  "invalid_action_rejected",
] as const;
export type RoutingDiagnostic = (typeof ROUTING_DIAGNOSTICS)[number];

/**
 * Allowed source kinds for per-class evidence refs (pre-routing only).
 * Outcome-derived / post-routing / free-text-only kinds are forbidden.
 */
export const CLASS_EVIDENCE_SOURCE_KINDS = [
  "structural",
  "declared",
  "historical_observed",
] as const;
export type ClassEvidenceSourceKind = (typeof CLASS_EVIDENCE_SOURCE_KINDS)[number];

/** Source kinds that must never assign a progressive class. */
export const FORBIDDEN_CLASS_EVIDENCE_SOURCE_KINDS = [
  "outcome_derived",
  "post_routing",
  "llm_free_text",
] as const;
export type ForbiddenClassEvidenceSourceKind =
  (typeof FORBIDDEN_CLASS_EVIDENCE_SOURCE_KINDS)[number];

/**
 * Safety dimensions that may present contradictory declared vs structural evidence.
 * Conflict resolution is fail-closed (research note §4.1 matrix).
 */
export const SAFETY_CONFLICT_DIMENSIONS = [
  "rollback",
  "blast_radius",
  "security",
  "compliance",
] as const;
export type SafetyConflictDimension = (typeof SAFETY_CONFLICT_DIMENSIONS)[number];

/**
 * Closed human-authority predicate ids (operational checklist).
 * Used for documentation, offline fixtures, and future observe-mode encoding.
 */
export const HUMAN_AUTHORITY_PREDICATES = [
  "irreversible_no_automated_rollback",
  "high_blast_radius",
  "security_sensitive",
  "compliance_sensitive",
] as const;
export type HumanAuthorityPredicate = (typeof HUMAN_AUTHORITY_PREDICATES)[number];

/**
 * Deploy-surface blast sub-criteria (narrower than ordinary production delivery).
 * Used by isHighBlastDefaultTrafficDeploy and research note §5.3.
 */
export const HIGH_BLAST_DEPLOY_CRITERIA = [
  "default_traffic_path_change",
  "all_tenant_forced_rollout",
  "infra_cdn_auth_gateway_cutover",
  "deploy_pipeline_affects_default_traffic",
] as const;
export type HighBlastDeployCriterion = (typeof HIGH_BLAST_DEPLOY_CRITERIA)[number];

/** Ordinary production delivery signals that do NOT set high blast alone. */
export const ROUTINE_DEPLOY_NON_BLAST = [
  "existing_cicd_app_release",
  "feature_flagged_staged_rollout",
  "canary_only_path_with_staged_plan",
  "docs_or_ci_only_no_deploy_path",
] as const;
export type RoutineDeployNonBlast = (typeof ROUTINE_DEPLOY_NON_BLAST)[number];

/** Forbidden collapsed score field names (must never appear on recommendations). */
export const FORBIDDEN_SCORE_FIELDS = [
  "risk_score",
  "expected_pain",
  "leverage_score",
  "productivity_score",
] as const;

/**
 * Default post-merge observation horizon (days) for offline eval eligibility.
 * Outcomes before horizon end are not-yet-observable (censored), not negatives.
 */
export const DEFAULT_POST_MERGE_OBSERVATION_HORIZON_DAYS = 14 as const;

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

export function isClassEvidenceSourceKind(
  value: unknown,
): value is ClassEvidenceSourceKind {
  return (
    typeof value === "string" &&
    (CLASS_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isForbiddenClassEvidenceSourceKind(
  value: unknown,
): value is ForbiddenClassEvidenceSourceKind {
  return (
    typeof value === "string" &&
    (FORBIDDEN_CLASS_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isSafetyConflictDimension(
  value: unknown,
): value is SafetyConflictDimension {
  return (
    typeof value === "string" &&
    (SAFETY_CONFLICT_DIMENSIONS as readonly string[]).includes(value)
  );
}

/**
 * Pure offline classifier: does a deploy-surface change set high_blast_radius
 * via the default-traffic path (not ordinary app delivery)?
 *
 * Positive: infra/CDN/auth-gateway cutover, deploy-pipeline change that alters
 * default production traffic, forced all-tenant rollout without staged plan.
 * Negative: existing CI/CD app release, feature-flag staged rollout, canary-only
 * with staged plan, docs/CI-only with no deploy path.
 */
export function isHighBlastDefaultTrafficDeploy(input: {
  /** True when the change alters the default production traffic path (routing, CDN, gateway, cluster ingress). */
  alters_default_traffic_path?: boolean;
  /** True when deploy pipeline / release infra itself changes (not app code through existing pipeline). */
  changes_deploy_pipeline_or_infra?: boolean;
  /** True when rollout is forced to all tenants/default traffic without staged/canary plan. */
  forced_all_tenant_or_default_rollout?: boolean;
  /** True when only ordinary app code ships via existing CI/CD. */
  ordinary_app_release_via_existing_cicd?: boolean;
  /** True when a documented staged/canary/feature-flag rollout plan exists. */
  staged_or_canary_plan_documented?: boolean;
}): boolean {
  if (input.ordinary_app_release_via_existing_cicd === true) {
    // Ordinary delivery alone never sets high blast via deploy criterion.
    if (
      input.alters_default_traffic_path !== true &&
      input.changes_deploy_pipeline_or_infra !== true &&
      input.forced_all_tenant_or_default_rollout !== true
    ) {
      return false;
    }
  }
  if (
    input.staged_or_canary_plan_documented === true &&
    input.forced_all_tenant_or_default_rollout !== true &&
    input.alters_default_traffic_path !== true &&
    input.changes_deploy_pipeline_or_infra !== true
  ) {
    return false;
  }
  return (
    input.alters_default_traffic_path === true ||
    input.changes_deploy_pipeline_or_infra === true ||
    input.forced_all_tenant_or_default_rollout === true
  );
}
