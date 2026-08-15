// Pure progressive-planning recommendation composition (#703).
//
// Offline / fixture use only. Does not select run planning_depth in advance.
// Most-restrictive composition + safe defaults; no collapsed risk score.
//
// Severity floors (PRIMARY_ACTION_SEVERITY) are provisional hypotheses until
// #702/#576 offline calibration retains or revises them (research note §3.2).

import {
  FORBIDDEN_SCORE_FIELDS,
  isClassEvidenceSourceKind,
  isForbiddenClassEvidenceSourceKind,
  isProgressiveRiskClass,
  isRoutingAction,
  isSafetyConflictDimension,
  PRIMARY_ACTION_SEVERITY,
  PROGRESSIVE_PLANNING_POLICY_ID,
  PROGRESSIVE_PLANNING_VOCAB_VERSION,
  type ClassEvidenceSourceKind,
  type ProgressiveRiskClass,
  type RecommendedPlanningDepth,
  type RoutingAction,
  type RoutingDiagnostic,
  type SafetyConflictDimension,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/**
 * Pre-routing provenance contract for observed_rework_cost history.
 *
 * Every historical rate / elevation flag MUST be derived solely from completed
 * work whose terminal timestamp is strictly before recommendation_as_of, and
 * whose run_id is not the target run. Target-run material_rework, review,
 * fix-round, and production_outcome records MUST NOT enter class assignment.
 */
export interface ObservedReworkProvenance {
  /** ISO-8601 instant at which the recommendation is composed. */
  recommendation_as_of: string;
  /**
   * Inclusive upper bound for historical cohort membership: only runs with
   * completed_at ≤ history_cutoff_at and completed_at < recommendation_as_of
   * may contribute. Prefer history_cutoff_at === recommendation_as_of (strict
   * less-than on completed_at is still required).
   */
  history_cutoff_at: string;
  /** Target run id being routed — MUST be excluded from cohort inputs. */
  target_run_id: string;
  /**
   * Prior completed run ids that contributed to history_available /
   * history_elevated. Empty when history is unavailable.
   */
  cohort_run_ids: readonly string[];
  /**
   * Per cohort run: completion timestamp used for the cutoff check.
   * Required for every id in cohort_run_ids when history_available is true.
   */
  cohort_completed_at?: Readonly<Record<string, string>>;
}

/**
 * Immutable per-class evidence reference (observable or declared only).
 * Must be available before routing; never outcome-derived from the target run.
 */
export interface ClassEvidenceRef {
  /** Stable pointer: path glob, label, design marker, prior run_id, event id. */
  ref: string;
  /** structural | declared | historical_observed only. */
  source_kind: ClassEvidenceSourceKind;
  /**
   * ISO-8601 instant when this evidence was observed/declared.
   * MUST be ≤ recommendation_as_of (pre-routing).
   */
  observed_as_of: string;
}

export interface ClassEvidenceInput {
  /** Progressive class id. */
  class_id: ProgressiveRiskClass;
  /**
   * Per-class evidence refs. Required for structured class assertions that
   * contribute action floors (except bare `unknown` bucket). Missing or
   * invalid evidence rejects the class assignment (no elevation from it).
   */
  evidence?: readonly ClassEvidenceRef[];
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
   * When true, observed_rework_provenance MUST be present and valid.
   */
  history_available?: boolean;
  /**
   * When history_available, whether historical cost is elevated for light depth.
   * Must reflect only pre-cutoff cohort outcomes (see ObservedReworkProvenance).
   */
  history_elevated?: boolean;
}

/**
 * Structured declared vs structural conflict on a safety dimension.
 * Polarity "elevating" claims higher risk / stricter gate; "clearing" claims lower.
 */
export interface SafetyEvidenceConflict {
  dimension: SafetyConflictDimension;
  declared_polarity: "elevating" | "clearing";
  structural_polarity: "elevating" | "clearing";
}

export interface ComposeRoutingInput {
  /** Matched progressive classes with optional completeness flags. */
  classes?: readonly ClassEvidenceInput[] | readonly ProgressiveRiskClass[];
  /**
   * Composition as-of time for per-class evidence validation.
   * Defaults to observed_rework_provenance.recommendation_as_of when present.
   */
  recommendation_as_of?: string;
  /**
   * When true (default), structured class entries without valid evidence refs
   * are rejected (no action floor). String shorthand classes are fixture-only
   * and emit class_evidence_missing unless require_class_evidence is false.
   */
  require_class_evidence?: boolean;
  /**
   * Declared low-risk / lightweight-favoring signal (docs-only, single private
   * module, etc.). Conflicts with high-severity structural classes.
   */
  lightweight_favoring?: boolean;
  /**
   * Open or deferred assumption / open_question count for the run.
   * Routing-only signal; reconstructability of the set requires
   * open_or_deferred_assumption_ids (or the #702 lineage stream by run_id).
   * When ids are also supplied, count MUST equal the deduped id length or
   * composition throws (no recommendation produced).
   */
  open_or_deferred_assumption_count?: number;
  /**
   * Stable #702 assumption_id values whose latest status is open or deferred.
   * When provided, count is derived from this list unless a contradictory
   * count is also supplied (then rejected). preserve_assumptions does not mint
   * new ids; consumers re-project lineage.
   */
  open_or_deferred_assumption_ids?: readonly string[];
  /**
   * Explicit human-authority boundary hit (irreversible / high blast /
   * security / compliance checklist from research note §5).
   */
  human_authority_boundary?: boolean;
  /**
   * Conflicting declared signals already detected by the caller
   * (e.g. low-risk label vs auth path). Prefer structured safety_conflicts.
   */
  conflict?: boolean;
  /**
   * Structured safety conflicts (declared vs structural). Always fail closed
   * to the elevating/conservative floor; never ordinary standard/lightweight.
   */
  safety_conflicts?: readonly SafetyEvidenceConflict[];
  /**
   * Caller attests that high-severity predicates (irreversibility, blast,
   * security, compliance — structural + declared) were evaluated before
   * composition. When false, the no-match path MUST NOT be treated as an
   * ordinary standard plan (fail closed toward deepen + preserve, not lightweight).
   * Default true for fixture callers that already filtered classes.
   */
  high_severity_scan_complete?: boolean;
  /**
   * Required when any observed_rework_cost class has history_available true.
   * Enforces pre-routing provenance (no target-run outcome leakage).
   */
  observed_rework_provenance?: ObservedReworkProvenance;
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
   * Open/deferred assumption_id values carried for lineage reconstructability.
   * Empty when none supplied; never invents ids.
   */
  preserved_assumption_ids: string[];
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
): { structured: ClassEvidenceInput[]; shorthand: ProgressiveRiskClass[] } {
  if (!raw || raw.length === 0) return { structured: [], shorthand: [] };
  const structured: ClassEvidenceInput[] = [];
  const shorthand: ProgressiveRiskClass[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (isProgressiveRiskClass(entry)) shorthand.push(entry);
      continue;
    }
    if (entry && typeof entry === "object" && isProgressiveRiskClass(entry.class_id)) {
      structured.push(entry);
    }
  }
  return { structured, shorthand };
}

/**
 * Validate a single class evidence ref against recommendation_as_of.
 * Rejects forbidden source kinds, empty refs, and post-routing timestamps.
 */
export function validateClassEvidenceRef(
  ref: unknown,
  recommendationAsOf: string | undefined,
): { ok: true; value: ClassEvidenceRef } | { ok: false; reason: string } {
  if (ref == null || typeof ref !== "object" || Array.isArray(ref)) {
    return { ok: false, reason: "evidence ref must be an object" };
  }
  const o = ref as Record<string, unknown>;
  if (typeof o.ref !== "string" || o.ref.length === 0) {
    return { ok: false, reason: "evidence ref.ref must be a non-empty string" };
  }
  if (isForbiddenClassEvidenceSourceKind(o.source_kind)) {
    return {
      ok: false,
      reason: `forbidden source_kind for class assignment: ${o.source_kind}`,
    };
  }
  if (!isClassEvidenceSourceKind(o.source_kind)) {
    return {
      ok: false,
      reason: `source_kind not in allowed set: ${JSON.stringify(o.source_kind)}`,
    };
  }
  if (typeof o.observed_as_of !== "string" || !Number.isFinite(Date.parse(o.observed_as_of))) {
    return { ok: false, reason: "evidence observed_as_of must be a valid ISO-8601 time" };
  }
  if (recommendationAsOf != null) {
    const asOf = Date.parse(recommendationAsOf);
    const observed = Date.parse(o.observed_as_of);
    if (Number.isFinite(asOf) && observed > asOf) {
      return {
        ok: false,
        reason: "evidence observed_as_of is after recommendation_as_of (post-routing)",
      };
    }
  }
  // Reject refs that encode target-run outcome leakage by convention.
  const lower = o.ref.toLowerCase();
  if (
    lower.includes("production_outcome:") ||
    lower.includes("material_rework:target") ||
    lower.startsWith("outcome_derived:")
  ) {
    return {
      ok: false,
      reason: "evidence ref encodes outcome-derived target-run signal",
    };
  }
  return {
    ok: true,
    value: {
      ref: o.ref,
      source_kind: o.source_kind,
      observed_as_of: o.observed_as_of,
    },
  };
}

/**
 * Validate per-class evidence for structured class assertions.
 * unknown may omit evidence; all other classes need ≥1 valid ref when required.
 */
export function validateClassEvidenceAssignment(
  ev: ClassEvidenceInput,
  recommendationAsOf: string | undefined,
  requireEvidence: boolean,
): {
  ok: boolean;
  diagnostics: RoutingDiagnostic[];
  reasons: string[];
} {
  const diagnostics: RoutingDiagnostic[] = [];
  const reasons: string[] = [];
  if (ev.class_id === "unknown") {
    return { ok: true, diagnostics, reasons };
  }
  const refs = ev.evidence ?? [];
  if (refs.length === 0) {
    if (requireEvidence) {
      diagnostics.push("class_evidence_missing");
      reasons.push(`class ${ev.class_id} has no evidence refs`);
      return { ok: false, diagnostics, reasons };
    }
    return { ok: true, diagnostics, reasons };
  }
  let anyOk = false;
  for (const r of refs) {
    const check = validateClassEvidenceRef(r, recommendationAsOf);
    if (check.ok) {
      anyOk = true;
    } else {
      diagnostics.push("class_evidence_rejected");
      reasons.push(check.reason);
    }
  }
  if (!anyOk) {
    return { ok: false, diagnostics, reasons };
  }
  // If any ref is valid, class may assign; rejected sibling refs still diagnostic.
  return { ok: true, diagnostics, reasons };
}

/**
 * Validate observed_rework provenance. Returns diagnostic codes when invalid.
 * Valid provenance: cutoff ≤ as_of; every cohort run completed before as_of;
 * target_run_id not in cohort; cohort_completed_at present for each cohort id.
 */
export function validateObservedReworkProvenance(
  prov: ObservedReworkProvenance | undefined,
  historyAvailable: boolean,
): { ok: true } | { ok: false; diagnostics: RoutingDiagnostic[] } {
  if (!historyAvailable) return { ok: true };
  if (!prov) {
    return { ok: false, diagnostics: ["history_provenance_rejected"] };
  }
  const asOf = Date.parse(prov.recommendation_as_of);
  const cutoff = Date.parse(prov.history_cutoff_at);
  if (!Number.isFinite(asOf) || !Number.isFinite(cutoff)) {
    return { ok: false, diagnostics: ["history_provenance_rejected"] };
  }
  if (cutoff > asOf) {
    return { ok: false, diagnostics: ["history_provenance_rejected"] };
  }
  if (!prov.target_run_id || typeof prov.target_run_id !== "string") {
    return { ok: false, diagnostics: ["history_provenance_rejected"] };
  }
  const ids = prov.cohort_run_ids ?? [];
  if (ids.includes(prov.target_run_id)) {
    return { ok: false, diagnostics: ["history_provenance_rejected"] };
  }
  const completed = prov.cohort_completed_at ?? {};
  for (const id of ids) {
    if (id === prov.target_run_id) {
      return { ok: false, diagnostics: ["history_provenance_rejected"] };
    }
    const doneAt = completed[id];
    if (doneAt == null) {
      return { ok: false, diagnostics: ["history_provenance_rejected"] };
    }
    const t = Date.parse(doneAt);
    if (!Number.isFinite(t) || t >= asOf || t > cutoff) {
      return { ok: false, diagnostics: ["history_provenance_rejected"] };
    }
  }
  return { ok: true };
}

/**
 * Apply safety conflict matrix (§4.1): contradictory declared vs structural
 * evidence fails closed to the elevating floor. Never ordinary standard/lightweight.
 */
export function resolveSafetyConflicts(
  conflicts: readonly SafetyEvidenceConflict[] | undefined,
): {
  actions: RoutingAction[];
  diagnostics: RoutingDiagnostic[];
  hasConflict: boolean;
} {
  if (!conflicts || conflicts.length === 0) {
    return { actions: [], diagnostics: [], hasConflict: false };
  }
  const actions = new Set<RoutingAction>();
  const diagnostics: RoutingDiagnostic[] = ["safety_conflict", "conflict"];
  let hasRealConflict = false;
  for (const c of conflicts) {
    if (!isSafetyConflictDimension(c.dimension)) continue;
    if (c.declared_polarity === c.structural_polarity) {
      // Same polarity is not a contradiction; still honor elevating side.
      if (c.declared_polarity === "elevating") {
        applyElevatingSafetyFloor(c.dimension, actions);
      }
      continue;
    }
    hasRealConflict = true;
    // Fail closed: elevating side always wins.
    applyElevatingSafetyFloor(c.dimension, actions);
  }
  if (!hasRealConflict && actions.size === 0) {
    return { actions: [], diagnostics: [], hasConflict: false };
  }
  if (hasRealConflict && actions.size === 0) {
    // Should not happen; safety net
    actions.add("deepen_technical");
    actions.add("preserve_assumptions");
  }
  return {
    actions: [...actions],
    diagnostics: hasRealConflict || actions.size > 0 ? diagnostics : [],
    hasConflict: hasRealConflict || actions.size > 0,
  };
}

function applyElevatingSafetyFloor(
  dimension: SafetyConflictDimension,
  actions: Set<RoutingAction>,
): void {
  switch (dimension) {
    case "rollback":
    case "security":
    case "compliance":
      actions.add("request_human_authority");
      actions.add("deepen_technical");
      actions.add("preserve_assumptions");
      break;
    case "blast_radius":
      actions.add("deepen_technical");
      actions.add("zoom_feasibility");
      actions.add("preserve_assumptions");
      // Blast conflict with elevating structural does not always force human
      // unless human_authority_boundary is also set; floor is deep/zoom.
      break;
  }
}

/**
 * Validate open assumption count vs id list. When ids are supplied and count
 * is also supplied, they MUST agree (after id dedupe). Returns derived count/ids.
 * Throws when both are supplied and disagree — no recommendation may be produced.
 */
export function resolveOpenAssumptionsStrict(input: ComposeRoutingInput): {
  openCount: number;
  preservedIds: string[];
} {
  const ids = (input.open_or_deferred_assumption_ids ?? []).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const seen = new Set<string>();
  const preservedIds: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      preservedIds.push(id);
    }
  }
  const countProvided =
    input.open_or_deferred_assumption_count !== undefined &&
    input.open_or_deferred_assumption_count !== null;

  if (preservedIds.length > 0) {
    if (countProvided) {
      const count = Number(input.open_or_deferred_assumption_count);
      if (!Number.isFinite(count) || count !== preservedIds.length) {
        throw new Error(
          `assumption_count_id_mismatch: open_or_deferred_assumption_count=${String(
            input.open_or_deferred_assumption_count,
          )} !== deduped ids length ${preservedIds.length}`,
        );
      }
    }
    return { openCount: preservedIds.length, preservedIds };
  }
  const count = input.open_or_deferred_assumption_count ?? 0;
  return { openCount: count > 0 ? count : 0, preservedIds: [] };
}

function actionFloorForClass(
  ev: ClassEvidenceInput,
  provenanceOk: boolean,
): {
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
        diagnostics: complete
          ? ["human_authority_floor"]
          : ["subsignal_incomplete", "human_authority_floor"],
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
      if (!provenanceOk) {
        // Treat as unavailable — never elevate from leaked/invalid history.
        return { actions: [], diagnostics: ["history_provenance_rejected"] };
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
 *
 * PRIMARY_ACTION_SEVERITY and non-safety action floors are provisional
 * hypotheses (not calibrated conclusions) until #702/#576 cohort FP/FN
 * calibration retains or revises them.
 *
 * Throws when open_or_deferred_assumption_count disagrees with supplied ids
 * (no recommendation is produced for contradictory assumption inputs).
 */
export function composeProgressivePlanningRecommendation(
  input: ComposeRoutingInput = {},
): ProgressivePlanningRecommendation {
  // Fail before any recommendation when count/ids contradict.
  const { openCount, preservedIds } = resolveOpenAssumptionsStrict(input);

  const diagnostics: RoutingDiagnostic[] = [];
  const actionSet = new Set<RoutingAction>();
  const matched: ProgressiveRiskClass[] = [];

  const { structured, shorthand } = normalizeClasses(input.classes);
  const requireEvidence = input.require_class_evidence !== false;
  const recommendationAsOf =
    input.recommendation_as_of ??
    input.observed_rework_provenance?.recommendation_as_of;

  let anyHighSeverity = false;

  // Provenance gate for any history_available observed_rework_cost entry.
  const needsHistory = structured.some(
    (c) => c.class_id === "observed_rework_cost" && c.history_available === true,
  );
  const provenanceCheck = validateObservedReworkProvenance(
    input.observed_rework_provenance,
    needsHistory,
  );
  const provenanceOk = provenanceCheck.ok;
  if (!provenanceCheck.ok) {
    for (const d of provenanceCheck.diagnostics) diagnostics.push(d);
  }

  // Structured classes: validate per-class evidence; reject unsupported assignments.
  for (const ev of structured) {
    const evCheck = validateClassEvidenceAssignment(ev, recommendationAsOf, requireEvidence);
    for (const d of evCheck.diagnostics) diagnostics.push(d);
    if (!evCheck.ok) {
      // Do not elevate from unsupported/outcome-derived/post-routing assertions.
      continue;
    }
    if (!matched.includes(ev.class_id)) matched.push(ev.class_id);
    const { actions, diagnostics: d } = actionFloorForClass(ev, provenanceOk);
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

  // String shorthand: fixture convenience. When require_class_evidence, emit
  // class_evidence_missing and still apply floors (legacy fixtures) only if
  // require_class_evidence was explicitly set false; default true means
  // shorthand is treated as missing-evidence for non-unknown classes.
  for (const classId of shorthand) {
    if (classId === "unknown") {
      if (!matched.includes("unknown")) matched.push("unknown");
      const { actions, diagnostics: d } = actionFloorForClass(
        { class_id: "unknown" },
        provenanceOk,
      );
      for (const a of actions) actionSet.add(a);
      for (const diag of d) diagnostics.push(diag);
      continue;
    }
    if (requireEvidence) {
      diagnostics.push("class_evidence_missing");
      // Reject assignment: no action floor from bare string without evidence.
      continue;
    }
    if (!matched.includes(classId)) matched.push(classId);
    const { actions, diagnostics: d } = actionFloorForClass(
      { class_id: classId },
      provenanceOk,
    );
    for (const a of actions) {
      if (isRoutingAction(a)) actionSet.add(a);
    }
    for (const diag of d) diagnostics.push(diag);
    if (
      classId === "security_compliance" ||
      classId === "reversibility" ||
      classId === "blast_radius"
    ) {
      anyHighSeverity = true;
    }
  }

  if (input.conflict) {
    diagnostics.push("conflict");
  }

  // Structured safety conflicts: fail closed, never ordinary standard/lightweight.
  const safetyResolved = resolveSafetyConflicts(input.safety_conflicts);
  for (const a of safetyResolved.actions) actionSet.add(a);
  for (const d of safetyResolved.diagnostics) diagnostics.push(d);
  if (safetyResolved.hasConflict) {
    anyHighSeverity = true;
  }

  // Unresolved conflict (boolean or structured) blocks lightweight: prefer the
  // more restrictive side. Boolean-only conflict without a safety dimension
  // floors at standard (not lightweight); structured dimensions use their matrix.
  const unresolvedConflict = input.conflict === true || safetyResolved.hasConflict;

  // High-severity scan incomplete: cannot treat empty match as ordinary standard.
  const scanComplete = input.high_severity_scan_complete !== false;
  if (!scanComplete) {
    diagnostics.push("high_severity_scan_incomplete");
    // Fail closed: deepen technical + preserve; never lightweight alone.
    actionSet.add("deepen_technical");
    actionSet.add("preserve_assumptions");
    // Remove lightweight if present later; do not allow unknown_default standard.
  }

  // Lightweight-favoring only wins when no high-severity class matched and no
  // unresolved conflict is present.
  if (input.lightweight_favoring) {
    if (
      anyHighSeverity ||
      input.human_authority_boundary ||
      !scanComplete ||
      unresolvedConflict
    ) {
      if (!diagnostics.includes("conflict")) diagnostics.push("conflict");
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

  // No signals → standard (not lightweight) ONLY when high-severity scan complete
  // AND no safety conflict forced a floor.
  if (actionSet.size === 0) {
    if (scanComplete && !safetyResolved.hasConflict) {
      actionSet.add("standard_plan");
      if (matched.length === 0 || matched.every((c) => c === "unknown")) {
        diagnostics.push("unknown_default");
      }
    } else {
      // already seeded deepen_technical above; ensure non-empty
      actionSet.add("deepen_technical");
      actionSet.add("preserve_assumptions");
    }
  }

  if (input.human_authority_boundary) {
    actionSet.add("request_human_authority");
    actionSet.add("preserve_assumptions");
    diagnostics.push("human_authority_floor");
  }

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
  // Unresolved conflict (boolean or structured safety) also blocks lightweight.
  if (
    actionSet.has("lightweight_plan") &&
    (actionSet.has("request_human_authority") ||
      actionSet.has("deepen_technical") ||
      actionSet.has("deepen_product") ||
      actionSet.has("zoom_feasibility") ||
      actionSet.has("zoom_vertical_slice") ||
      !scanComplete ||
      unresolvedConflict)
  ) {
    actionSet.delete("lightweight_plan");
    if (!diagnostics.includes("conflict")) diagnostics.push("conflict");
  }

  // Safety conflict must never leave ordinary standard as primary when elevating.
  if (
    safetyResolved.hasConflict &&
    actionSet.has("standard_plan") &&
    (actionSet.has("request_human_authority") ||
      actionSet.has("deepen_technical") ||
      actionSet.has("zoom_feasibility"))
  ) {
    actionSet.delete("standard_plan");
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
    preserved_assumption_ids: preservedIds,
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
  const preserved = Array.isArray(o.preserved_assumption_ids)
    ? o.preserved_assumption_ids.filter((id): id is string => typeof id === "string")
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
      preserved_assumption_ids: preserved,
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

/**
 * Project open/deferred assumption_ids from a #702 current-state map.
 * Pure helper for fixtures linking compose to assumption_lineage.
 */
export function unresolvedAssumptionIdsFromCurrent(
  current: ReadonlyMap<string, { status: string }>,
): string[] {
  const out: string[] = [];
  for (const [id, p] of current) {
    if (p.status === "open" || p.status === "deferred") out.push(id);
  }
  return out.sort();
}
