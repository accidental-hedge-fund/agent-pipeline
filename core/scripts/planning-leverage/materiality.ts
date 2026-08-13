// Pure material-rework classifier (#702).
//
// Operational definition: a correction is material only when at least one
// closed criterion applies. Ordinary review edits (formatting, local renames)
// are not material. Insufficient evidence → unknown (never default material).

import type { MaterialCriterion, Materiality } from "./schema.ts";

export interface MaterialityEvidence {
  /** Net expansion of production paths/modules beyond plan/scope. */
  scope_expansion?: boolean;
  /** Public API, schema, wire format, or persisted data model change in fix. */
  design_interface_change?: boolean;
  /** Planning artifacts revised or resolved assumptions reopened. */
  replan_or_assumption_reopen?: boolean;
  /**
   * Count of fix rounds addressing blocking findings at/above block threshold.
   * multi_round_blocking applies when this is >= 2.
   */
  blocking_fix_rounds?: number | null;
  /** Engine-recorded architecture/correctness material class for the round. */
  engine_material_class?: boolean;
  /**
   * When true, the engine has enough evidence to classify ordinary if no
   * criteria match. When false/undefined and no criteria fire, result is unknown.
   */
  evidence_sufficient?: boolean;
}

export interface MaterialityClassification {
  materiality: Materiality;
  material_criteria: MaterialCriterion[];
}

/**
 * Classify correction work from closed evidence flags.
 * Pure: no I/O. Positive and negative fixtures covered by unit tests.
 */
export function classifyMateriality(evidence: MaterialityEvidence): MaterialityClassification {
  const criteria: MaterialCriterion[] = [];

  if (evidence.scope_expansion === true) criteria.push("scope_expansion");
  if (evidence.design_interface_change === true) criteria.push("design_interface_change");
  if (evidence.replan_or_assumption_reopen === true) {
    criteria.push("replan_or_assumption_reopen");
  }
  const rounds = evidence.blocking_fix_rounds;
  if (
    (typeof rounds === "number" && Number.isFinite(rounds) && rounds >= 2) ||
    evidence.engine_material_class === true
  ) {
    criteria.push("multi_round_blocking");
  }

  if (criteria.length > 0) {
    return { materiality: "material", material_criteria: criteria };
  }

  if (evidence.evidence_sufficient === true) {
    return { materiality: "ordinary", material_criteria: [] };
  }

  // Insufficient evidence — never default to material.
  return { materiality: "unknown", material_criteria: [] };
}

/** Fixture: formatting-only fix with sufficient evidence → ordinary. */
export const FIXTURE_ORDINARY_FORMATTING: MaterialityEvidence = {
  scope_expansion: false,
  design_interface_change: false,
  replan_or_assumption_reopen: false,
  blocking_fix_rounds: 1,
  engine_material_class: false,
  evidence_sufficient: true,
};

/** Fixture: schema / public API change in fix round → material. */
export const FIXTURE_MATERIAL_INTERFACE: MaterialityEvidence = {
  scope_expansion: false,
  design_interface_change: true,
  replan_or_assumption_reopen: false,
  blocking_fix_rounds: 1,
  evidence_sufficient: true,
};

/** Fixture: two blocking fix rounds → material multi_round_blocking. */
export const FIXTURE_MATERIAL_MULTI_ROUND: MaterialityEvidence = {
  scope_expansion: false,
  design_interface_change: false,
  replan_or_assumption_reopen: false,
  blocking_fix_rounds: 2,
  evidence_sufficient: true,
};

/** Fixture: insufficient evidence → unknown. */
export const FIXTURE_UNKNOWN_EVIDENCE: MaterialityEvidence = {
  evidence_sufficient: false,
};
