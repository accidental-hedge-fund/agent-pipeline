// Resolve selected planning_depth and risk_class for a run (#702).
//
// Selected values come from configuration, policy, or explicit operator choice
// at/before planning — never from post-hoc plan quality (length, tokens).
// When selection cannot be determined, return "unknown" (do not invent
// "standard" without an actual selection signal).

import {
  PLANNING_DEPTHS,
  RISK_CLASSES,
  type PlanningDepth,
  type RiskClass,
} from "./schema.ts";

/** Inputs that may establish selected depth/risk for a run. */
export interface PlanningLeverageSelectionInput {
  /** Explicit operator/config selection when present (minimal|standard|deep). */
  planning_depth?: string | null;
  /** Explicit primary risk class when present. */
  risk_class?: string | null;
  /**
   * Declared or policy-matched risk classes for the work item
   * (e.g. pre-code dossier declared_risk_classes).
   */
  risk_classes?: readonly string[] | null;
  /**
   * Whether the plan-review step is enabled for this run.
   * `undefined`/`null` means this signal is unavailable → depth stays unknown
   * unless `planning_depth` is explicit.
   */
  plan_review?: boolean | null;
  /**
   * Planning-phase reasoning effort (`cfg.effort.planning` or
   * `cfg.plan_review_effort`). Used only when `plan_review` is a known boolean.
   */
  planning_effort?: string | null;
}

export interface PlanningLeverageSelection {
  planning_depth: PlanningDepth;
  risk_class: RiskClass;
  /** Present when at least one non-unknown risk class was selected. */
  risk_classes?: RiskClass[];
}

/** Effort levels that select deep planning when plan_review is on. */
const DEEP_PLANNING_EFFORTS = new Set(["high", "xhigh", "max"]);

function parseDepth(raw: string | null | undefined): PlanningDepth | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "unknown") return null;
  return (PLANNING_DEPTHS as readonly string[]).includes(v) ? (v as PlanningDepth) : null;
}

function parseRisk(raw: string | null | undefined): RiskClass | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "unknown" || v === "") return null;
  return (RISK_CLASSES as readonly string[]).includes(v) ? (v as RiskClass) : null;
}

/**
 * Locked mapping from plan_review + planning effort → planning_depth:
 *
 * | plan_review | planning_effort     | depth    |
 * |-------------|---------------------|----------|
 * | false       | (any)               | minimal  |
 * | true        | high / xhigh / max  | deep     |
 * | true        | other / unset       | standard |
 * | absent      | (any)               | unknown  |
 *
 * Explicit `planning_depth` always wins when it is a non-unknown enum value.
 */
export function resolvePlanningLeverageSelection(
  input: PlanningLeverageSelectionInput,
): PlanningLeverageSelection {
  let planning_depth: PlanningDepth = parseDepth(input.planning_depth) ?? "unknown";

  if (planning_depth === "unknown" && typeof input.plan_review === "boolean") {
    if (!input.plan_review) {
      planning_depth = "minimal";
    } else {
      const effort = String(input.planning_effort ?? "")
        .trim()
        .toLowerCase();
      planning_depth = DEEP_PLANNING_EFFORTS.has(effort) ? "deep" : "standard";
    }
  }

  const collected: RiskClass[] = [];
  const primary = parseRisk(input.risk_class);
  if (primary) collected.push(primary);
  if (input.risk_classes) {
    for (const r of input.risk_classes) {
      const parsed = parseRisk(r);
      if (parsed && !collected.includes(parsed)) collected.push(parsed);
    }
  }

  const risk_class: RiskClass = collected[0] ?? "unknown";
  const out: PlanningLeverageSelection = { planning_depth, risk_class };
  if (collected.length > 0) out.risk_classes = collected;
  return out;
}
