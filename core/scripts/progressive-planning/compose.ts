// Pure progressive-planning recommendation composition (#703).
//
// Offline / fixture use only. Does not select run planning_depth in advance.
// Most-restrictive composition + safe defaults; no collapsed risk score.

import {
  FORBIDDEN_SCORE_FIELDS,
  isProgressiveRiskClass,
  isRoutingAction,
  PRIMARY_ACTION_SEVERITY,
  PROGRESSIVE_PLANNING_POLICY_ID,
  PROGRESSIVE_PLANNING_VOCAB_VERSION,
  type ProgressiveRiskClass,
  type RecommendedPlanningDepth,
  type RoutingAction,
  type RoutingDiagnostic,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface ClassEvidenceInput {
  /** Progressive class id. */
  class_id: ProgressiveRiskClass;
  /**
   * Whether required sub-signals for this class are complete enough to act.
   * When false for high-severity classes, composition fails closed.
   */
  subsignals_complete?: boolean;
  /**
   * For reversibility: whether a documented automated rollback path exists.
   * When false/undefined and class matches, human-authority floor applies.
   */
  automated_rollback_documented?: boolean;
  /**
   * For observed_rework_cost: whether historical rates are available with
   * sample floor met. When false, class is ignored (not invented).
   */
  history_available?: boolean;
  /**
   * When history_available, whether historical cost is elevated for light depth.
   */
  history_elevated?: boolean;
}

export interface ComposeRoutingInput {
  /** Matched progressive classes with optional completeness flags. */
  classes?: readonly ClassEvidenceInput[] | readonly ProgressiveRiskClass[];
  /**
   * Declared low-risk / lightweight-favoring signal (docs-only, single private
   * module, etc.). Conflicts with high-severity structural classes.
   */
  lightweight_favoring?: boolean;
  /** Open or deferred assumption / open_question count for the run. */
  open_or_deferred_assumption_count?: number;
  /**
   * Explicit human-authority boundary hit (irreversible / high blast /
   * security / compliance checklist).
   */
  human_authority_boundary?: boolean;
  /**
   * Conflicting declared signals already detected by the caller
   * (e.g. low-risk label vs auth path).
   */
  conflict?: boolean;
}

export interface ProgressivePlanningRecommendation {
  vocab_version: typeof PROGRESSIVE_PLANNING_VOCAB_VERSION;
  policy_id: typeof PROGRESSIVE_PLANNING_POLICY_ID;
  /** Most restrictive primary action. */
  primary_action: RoutingAction;
  /** Full action set including stacks (closed vocabulary only). */
  actions: RoutingAction[];
  matched_classes: ProgressiveRiskClass[];
  recommended_planning_depth: RecommendedPlanningDepth;
  diagnostics: RoutingDiagnostic[];
  /**
   * Automation is never enabled by this helper. Always false for research
   * package consumers; advance must not apply primary_action automatically.
   */
  automation_enabled: false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normalizeClasses(
  raw: ComposeRoutingInput["classes"],
): ClassEvidenceInput[] {
  if (!raw || raw.length === 0) return [];
  const out: ClassEvidenceInput[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (isProgressiveRiskClass(entry)) out.push({ class_id: entry });
      continue;
    }
    if (entry && typeof entry === "object" && isProgressiveRiskClass(entry.class_id)) {
      out.push(entry);
    }
  }
  return out;
}

function actionFloorForClass(ev: ClassEvidenceInput): {
  actions: RoutingAction[];
  diagnostics: RoutingDiagnostic[];
} {
  const diagnostics: RoutingDiagnostic[] = [];
  const complete = ev.subsignals_complete !== false;

  switch (ev.class_id) {
    case "unknown":
      return { actions: ["standard_plan"], diagnostics: ["unknown_default"] };

    case "ambiguity":
      return { actions: ["deepen_product", "preserve_assumptions"], diagnostics: [] };

    case "novelty":
      return { actions: ["zoom_feasibility"], diagnostics: [] };

    case "dependency_uncertainty":
      return { actions: ["zoom_vertical_slice", "preserve_assumptions"], diagnostics: [] };

    case "blast_radius":
      return {
        actions: complete
          ? ["deepen_technical", "zoom_feasibility"]
          : ["deepen_technical", "preserve_assumptions"],
        diagnostics: complete ? [] : ["subsignal_incomplete"],
      };

    case "reversibility":
      if (ev.automated_rollback_documented === true) {
        return {
          actions: ["deepen_technical", "preserve_assumptions"],
          diagnostics: [],
        };
      }
      return {
        actions: [
          "request_human_authority",
          "deepen_technical",
          "preserve_assumptions",
        ],
        diagnostics: complete ? ["human_authority_floor"] : ["subsignal_incomplete", "human_authority_floor"],
      };

    case "security_compliance":
      if (!complete) {
        return {
          actions: [
            "request_human_authority",
            "deepen_technical",
            "preserve_assumptions",
          ],
          diagnostics: ["subsignal_incomplete", "human_authority_floor"],
        };
      }
      return {
        actions: ["deepen_technical", "preserve_assumptions"],
        diagnostics: [],
      };

    case "observed_rework_cost":
      if (!ev.history_available) {
        return { actions: [], diagnostics: ["history_unavailable"] };
      }
      if (ev.history_elevated) {
        return {
          actions: ["deepen_technical", "preserve_assumptions"],
          diagnostics: [],
        };
      }
      return { actions: [], diagnostics: [] };

    default:
      return { actions: [], diagnostics: [] };
  }
}

function isPrimaryAction(
  a: RoutingAction,
): a is Exclude<RoutingAction, "preserve_assumptions"> {
  return a !== "preserve_assumptions";
}

function severity(a: RoutingAction): number {
  if (!isPrimaryAction(a)) return -1;
  return PRIMARY_ACTION_SEVERITY[a];
}

function pickPrimary(actions: Iterable<RoutingAction>): RoutingAction {
  let best: Exclude<RoutingAction, "preserve_assumptions"> | null = null;
  let bestSev = -1;
  for (const a of actions) {
    if (!isPrimaryAction(a)) continue;
    const s = PRIMARY_ACTION_SEVERITY[a];
    if (best === null || s > bestSev) {
      best = a;
      bestSev = s;
    }
  }
  // Empty primary set → standard (safe default; caller usually pre-seeds).
  return best ?? "standard_plan";
}

function depthForPrimary(primary: RoutingAction): RecommendedPlanningDepth {
  switch (primary) {
    case "lightweight_plan":
      return "minimal";
    case "standard_plan":
      return "standard";
    case "deepen_product":
    case "deepen_technical":
    case "zoom_feasibility":
    case "zoom_vertical_slice":
    case "request_human_authority":
      return "deep";
    case "preserve_assumptions":
      return "standard";
    default:
      return "unknown";
  }
}

function assertNoScoreFields(rec: ProgressivePlanningRecommendation): void {
  const obj = rec as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_SCORE_FIELDS) {
    if (key in obj && obj[key] !== undefined) {
      throw new Error(`forbidden score field present on recommendation: ${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose a progressive-planning recommendation from class evidence.
 * Pure: no I/O. Safe defaults fail closed for high-severity incomplete evidence.
 */
export function composeProgressivePlanningRecommendation(
  input: ComposeRoutingInput = {},
): ProgressivePlanningRecommendation {
  const diagnostics: RoutingDiagnostic[] = [];
  const actionSet = new Set<RoutingAction>();
  const matched: ProgressiveRiskClass[] = [];

  const classes = normalizeClasses(input.classes);
  let anyHighSeverity = false;

  for (const ev of classes) {
    if (!matched.includes(ev.class_id)) matched.push(ev.class_id);
    const { actions, diagnostics: d } = actionFloorForClass(ev);
    for (const a of actions) {
      if (isRoutingAction(a)) actionSet.add(a);
    }
    for (const diag of d) diagnostics.push(diag);
    if (
      ev.class_id === "security_compliance" ||
      ev.class_id === "reversibility" ||
      ev.class_id === "blast_radius"
    ) {
      anyHighSeverity = true;
    }
  }

  if (input.conflict) {
    diagnostics.push("conflict");
  }

  // Lightweight-favoring only wins when no high-severity class matched.
  if (input.lightweight_favoring) {
    if (anyHighSeverity || input.human_authority_boundary) {
      diagnostics.push("conflict");
      // do not add lightweight_plan
    } else if (actionSet.size === 0 || [...actionSet].every((a) => a === "preserve_assumptions")) {
      actionSet.add("lightweight_plan");
    } else {
      // structural classes already present — conflict if they are above lightweight
      const primarySoFar = pickPrimary(actionSet);
      if (severity(primarySoFar) > PRIMARY_ACTION_SEVERITY.lightweight_plan) {
        diagnostics.push("conflict");
      } else {
        actionSet.add("lightweight_plan");
      }
    }
  }

  // No signals → standard (not lightweight).
  if (actionSet.size === 0) {
    actionSet.add("standard_plan");
    if (matched.length === 0 || matched.every((c) => c === "unknown")) {
      diagnostics.push("unknown_default");
    }
  }

  if (input.human_authority_boundary) {
    actionSet.add("request_human_authority");
    actionSet.add("preserve_assumptions");
    diagnostics.push("human_authority_floor");
  }

  const openCount = input.open_or_deferred_assumption_count ?? 0;
  const primary = pickPrimary(actionSet);

  // preserve_assumptions stacks when open items exist (always for lightweight).
  if (openCount > 0) {
    actionSet.add("preserve_assumptions");
    diagnostics.push("open_assumptions_preserved");
  } else if (
    primary === "lightweight_plan" &&
    openCount === 0 &&
    !actionSet.has("preserve_assumptions")
  ) {
    // no open items — fine without preserve
  }

  // Security incomplete already added human authority; ensure never lightweight alone.
  if (
    actionSet.has("lightweight_plan") &&
    (actionSet.has("request_human_authority") ||
      actionSet.has("deepen_technical") ||
      actionSet.has("deepen_product") ||
      actionSet.has("zoom_feasibility") ||
      actionSet.has("zoom_vertical_slice"))
  ) {
    actionSet.delete("lightweight_plan");
    if (!diagnostics.includes("conflict")) diagnostics.push("conflict");
  }

  const finalPrimary = pickPrimary(actionSet);
  // Collect same-tier co-actions for deepen/zoom pairs.
  const actions = orderActions(actionSet, finalPrimary);

  // Deduplicate diagnostics preserving order
  const seenDiag = new Set<RoutingDiagnostic>();
  const uniqueDiag: RoutingDiagnostic[] = [];
  for (const d of diagnostics) {
    if (!seenDiag.has(d)) {
      seenDiag.add(d);
      uniqueDiag.push(d);
    }
  }

  const rec: ProgressivePlanningRecommendation = {
    vocab_version: PROGRESSIVE_PLANNING_VOCAB_VERSION,
    policy_id: PROGRESSIVE_PLANNING_POLICY_ID,
    primary_action: finalPrimary,
    actions,
    matched_classes: matched,
    recommended_planning_depth: depthForPrimary(finalPrimary),
    diagnostics: uniqueDiag,
    automation_enabled: false,
  };

  assertNoScoreFields(rec);
  return rec;
}

function orderActions(
  set: Set<RoutingAction>,
  primary: RoutingAction,
): RoutingAction[] {
  const ordered: RoutingAction[] = [];
  // primary first
  if (set.has(primary)) ordered.push(primary);
  // other primaries by severity desc, then name
  const others = [...set]
    .filter((a) => a !== primary && isPrimaryAction(a))
    .sort((a, b) => severity(b) - severity(a) || a.localeCompare(b));
  ordered.push(...others);
  if (set.has("preserve_assumptions")) ordered.push("preserve_assumptions");
  // reject anything invalid (should not happen)
  return ordered.filter(isRoutingAction);
}

/**
 * Validate a machine-readable recommendation: closed action enum, closed depth,
 * no forbidden score fields, free-form actions rejected.
 */
export function validateProgressivePlanningRecommendation(
  raw: unknown,
): { ok: true; value: ProgressivePlanningRecommendation } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: ["recommendation must be an object"] };
  }
  const o = raw as Record<string, unknown>;

  for (const key of FORBIDDEN_SCORE_FIELDS) {
    if (key in o && o[key] !== undefined) {
      issues.push(`forbidden field: ${key}`);
    }
  }

  if (!isRoutingAction(o.primary_action)) {
    issues.push(`primary_action not in closed set: ${JSON.stringify(o.primary_action)}`);
  }

  if (!Array.isArray(o.actions)) {
    issues.push("actions must be an array");
  } else {
    for (let i = 0; i < o.actions.length; i++) {
      if (!isRoutingAction(o.actions[i])) {
        issues.push(`actions[${i}] not in closed set: ${JSON.stringify(o.actions[i])}`);
      }
    }
  }

  if (
    typeof o.recommended_planning_depth !== "string" ||
    !["minimal", "standard", "deep", "unknown"].includes(o.recommended_planning_depth)
  ) {
    issues.push(
      `recommended_planning_depth not in closed set: ${JSON.stringify(o.recommended_planning_depth)}`,
    );
  }

  if (o.automation_enabled === true) {
    issues.push("automation_enabled must not be true for research package recommendations");
  }

  if (issues.length > 0) return { ok: false, issues };

  const actions = (o.actions as RoutingAction[]).filter(isRoutingAction);
  const matched = Array.isArray(o.matched_classes)
    ? o.matched_classes.filter(isProgressiveRiskClass)
    : [];
  const diagnostics = Array.isArray(o.diagnostics)
    ? (o.diagnostics.filter((d): d is RoutingDiagnostic => typeof d === "string") as RoutingDiagnostic[])
    : [];

  return {
    ok: true,
    value: {
      vocab_version: PROGRESSIVE_PLANNING_VOCAB_VERSION,
      policy_id: PROGRESSIVE_PLANNING_POLICY_ID,
      primary_action: o.primary_action as RoutingAction,
      actions,
      matched_classes: matched,
      recommended_planning_depth: o.recommended_planning_depth as RecommendedPlanningDepth,
      diagnostics,
      automation_enabled: false,
    },
  };
}

/**
 * Map a primary routing action to recommended planning_depth (closed enum).
 * Exported for offline tables and tests.
 */
export function recommendedDepthForAction(
  action: RoutingAction,
): RecommendedPlanningDepth {
  if (!isRoutingAction(action)) return "unknown";
  return depthForPrimary(action);
}
