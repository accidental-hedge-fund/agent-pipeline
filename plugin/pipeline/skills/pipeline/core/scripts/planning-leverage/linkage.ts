// Linkage helpers: planning-leverage ↔ production outcomes (#702 / #576).
//
// Pure / offline-testable. Never invents production_outcome ids.
// Observed authority only when outcome_id comes from a durable store record
// or explicit manual mapping. Temporal co-occurrence alone is inferred.

import {
  isPlaceholderIdentity,
  makeAttribution,
  type PlanningLeverageAttribution,
} from "./schema.ts";

export interface ProductionOutcomeLite {
  outcome_id: string;
  /** Attribution entries already on the outcome (run/commit/pr/…). */
  attribution?: ReadonlyArray<{
    target_type: string;
    target_id: string;
    authority?: string;
  }>;
}

export const PL_LINKAGE_DIAGNOSTIC_CODES = {
  unresolved_production_outcome: "unresolved_production_outcome",
  invented_identity_rejected: "invented_identity_rejected",
  temporal_join_only: "temporal_join_only",
} as const;

export interface ProductionOutcomeJoinResult {
  attribution: PlanningLeverageAttribution[];
  diagnostics: string[];
}

/**
 * Join planning-leverage run identity to production outcomes by observed run
 * attribution on the outcome records. Does not fabricate outcome ids.
 */
export function joinProductionOutcomesForRun(args: {
  run_id: string;
  outcomes: readonly ProductionOutcomeLite[];
}): ProductionOutcomeJoinResult {
  const attribution: PlanningLeverageAttribution[] = [];
  const diagnostics: string[] = [];

  if (!args.run_id || isPlaceholderIdentity(args.run_id)) {
    diagnostics.push(PL_LINKAGE_DIAGNOSTIC_CODES.invented_identity_rejected);
    return { attribution, diagnostics };
  }

  for (const o of args.outcomes) {
    if (!o.outcome_id || isPlaceholderIdentity(o.outcome_id)) {
      diagnostics.push(PL_LINKAGE_DIAGNOSTIC_CODES.invented_identity_rejected);
      continue;
    }
    const attrs = o.attribution ?? [];
    const runHit = attrs.find(
      (a) => a.target_type === "run" && a.target_id === args.run_id,
    );
    if (!runHit) continue;
    const authority =
      runHit.authority === "observed" ? "observed" : "inferred";
    const a = makeAttribution({
      target_type: "production_outcome",
      target_id: o.outcome_id,
      method: authority === "observed" ? "direct" : "heuristic",
      authority,
      confidence: authority === "observed" ? 1 : 0.4,
    });
    if (a) attribution.push(a);
  }

  if (attribution.length === 0) {
    diagnostics.push(PL_LINKAGE_DIAGNOSTIC_CODES.unresolved_production_outcome);
  }
  return { attribution, diagnostics };
}

/**
 * Temporal co-occurrence only: same-day same-repo without shared run/SHA/trailer.
 * Always authority: inferred. Prefer omitting over fabricating.
 */
export function inferProductionOutcomeFromTemporal(args: {
  outcome_id: string;
  same_day_same_repo: boolean;
  shared_run_or_sha_or_trailer: boolean;
}): PlanningLeverageAttribution | null {
  if (!args.outcome_id || isPlaceholderIdentity(args.outcome_id)) return null;
  if (args.shared_run_or_sha_or_trailer) {
    return makeAttribution({
      target_type: "production_outcome",
      target_id: args.outcome_id,
      method: "direct",
      authority: "observed",
      confidence: 1,
    });
  }
  if (!args.same_day_same_repo) return null;
  return makeAttribution({
    target_type: "production_outcome",
    target_id: args.outcome_id,
    method: "heuristic",
    authority: "inferred",
    confidence: 0.2,
    note: "temporal co-occurrence only",
  });
}

/**
 * Build production_outcome attribution only when evidence exists.
 * Placeholders and missing ids are omitted (never fabricated).
 */
export function productionOutcomeAttribution(args: {
  outcome_id: string | null | undefined;
  authority: "observed" | "inferred";
  method?: "direct" | "manual" | "heuristic";
}): PlanningLeverageAttribution | null {
  if (!args.outcome_id || isPlaceholderIdentity(args.outcome_id)) return null;
  return makeAttribution({
    target_type: "production_outcome",
    target_id: args.outcome_id,
    method: args.method ?? (args.authority === "observed" ? "direct" : "heuristic"),
    authority: args.authority,
    confidence: args.authority === "observed" ? 1 : 0.3,
  });
}
