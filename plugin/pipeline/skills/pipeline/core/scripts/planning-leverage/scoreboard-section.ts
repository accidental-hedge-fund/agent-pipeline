// Additive factory-scoreboard planning_leverage section (#702).
//
// Depth/risk histograms, phase elapsed (observed only), assumption and
// materiality breakdowns. No productivity / leverage / expected-pain score.
// Missing telemetry → zeros + telemetry_absent diagnostic (non-fatal).

import {
  DELIVERY_PHASES,
  MATERIALITIES,
  PLANNING_DEPTHS,
  PLANNING_LEVERAGE_EVENT_TYPES,
  readAssumptionPayload,
  readMaterialReworkPayload,
  readPhasePayload,
  type DeliveryPhase,
  type Materiality,
  type PlanningDepth,
  type RiskClass,
  type ValueAvailability,
} from "./schema.ts";
import {
  countAssumptionsByStatus,
  projectAssumptionCurrentState,
} from "./assumptions.ts";

export interface PlanningLeverageScoreboardSection {
  /** Partition label for raw vs derived vs unavailable. */
  partitions: {
    observed: Record<string, unknown>;
    derived: Record<string, unknown>;
    unavailable: Record<string, unknown>;
  };
  by_planning_depth: Record<PlanningDepth, number>;
  by_risk_class: Record<string, number>;
  phase_elapsed_ms: Record<DeliveryPhase, number | null>;
  phase_elapsed_availability: Record<DeliveryPhase, ValueAvailability | "unavailable">;
  assumption_counts: {
    open: number;
    deferred: number;
    resolved: number;
    invalidated: number;
    unknown: number;
    unresolved: number;
  };
  materiality_counts: Record<Materiality, number>;
  fix_round_events: number;
  runs_with_telemetry: number;
  runs_without_telemetry: number;
  total_runs_considered: number;
  diagnostics: Array<{ code: string; message: string }>;
}

function emptyDepthCounts(): Record<PlanningDepth, number> {
  const out = {} as Record<PlanningDepth, number>;
  for (const d of PLANNING_DEPTHS) out[d] = 0;
  return out;
}

function emptyMaterialityCounts(): Record<Materiality, number> {
  const out = {} as Record<Materiality, number>;
  for (const m of MATERIALITIES) out[m] = 0;
  return out;
}

function emptyPhaseElapsed(): Record<DeliveryPhase, number | null> {
  const out = {} as Record<DeliveryPhase, number | null>;
  for (const p of DELIVERY_PHASES) out[p] = null;
  return out;
}

function emptyPhaseAvail(): Record<DeliveryPhase, ValueAvailability | "unavailable"> {
  const out = {} as Record<DeliveryPhase, ValueAvailability | "unavailable">;
  for (const p of DELIVERY_PHASES) out[p] = "unavailable";
  return out;
}

export function emptyPlanningLeverageScoreboardSection(
  diagnostics: PlanningLeverageScoreboardSection["diagnostics"] = [],
): PlanningLeverageScoreboardSection {
  return {
    partitions: {
      observed: {},
      derived: {},
      unavailable: {
        active_effort: "not measured; never presented as zero cost fact",
      },
    },
    by_planning_depth: emptyDepthCounts(),
    by_risk_class: { unknown: 0 },
    phase_elapsed_ms: emptyPhaseElapsed(),
    phase_elapsed_availability: emptyPhaseAvail(),
    assumption_counts: {
      open: 0,
      deferred: 0,
      resolved: 0,
      invalidated: 0,
      unknown: 0,
      unresolved: 0,
    },
    materiality_counts: emptyMaterialityCounts(),
    fix_round_events: 0,
    runs_with_telemetry: 0,
    runs_without_telemetry: 0,
    total_runs_considered: 0,
    diagnostics,
  };
}

export interface RunEventsInput {
  runId: string;
  events: readonly unknown[];
}

function runHasLeverageTelemetry(events: readonly unknown[]): boolean {
  for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    const t = (e as { type?: string }).type;
    if (
      t &&
      (PLANNING_LEVERAGE_EVENT_TYPES as readonly string[]).includes(t)
    ) {
      return true;
    }
  }
  return false;
}

/** Pure aggregation over included runs' event lists. */
export function aggregatePlanningLeverageScoreboardSection(
  runs: readonly RunEventsInput[],
): PlanningLeverageScoreboardSection {
  const section = emptyPlanningLeverageScoreboardSection();
  section.total_runs_considered = runs.length;

  const phaseSums: Record<DeliveryPhase, number> = {
    alignment: 0,
    planning: 0,
    implementation: 0,
    review: 0,
    correction: 0,
  };
  const phaseObserved: Record<DeliveryPhase, boolean> = {
    alignment: false,
    planning: false,
    implementation: false,
    review: false,
    correction: false,
  };

  // Per-run selected depth/risk: last non-unknown phase event wins; else unknown.
  for (const run of runs) {
    if (!runHasLeverageTelemetry(run.events)) {
      section.runs_without_telemetry++;
      continue;
    }
    section.runs_with_telemetry++;

    let depth: PlanningDepth = "unknown";
    let risk: RiskClass | string = "unknown";

    for (const raw of run.events) {
      const phase = readPhasePayload(raw);
      if (phase) {
        if (phase.planning_depth !== "unknown") depth = phase.planning_depth;
        if (phase.risk_class !== "unknown") risk = phase.risk_class;
        if (
          phase.boundary === "end" &&
          phase.elapsed_availability === "observed" &&
          typeof phase.elapsed_ms === "number"
        ) {
          phaseSums[phase.phase] += phase.elapsed_ms;
          phaseObserved[phase.phase] = true;
        }
      }
      const mat = readMaterialReworkPayload(raw);
      if (mat) {
        section.materiality_counts[mat.materiality]++;
        section.fix_round_events++;
      }
    }

    section.by_planning_depth[depth] = (section.by_planning_depth[depth] ?? 0) + 1;
    section.by_risk_class[risk] = (section.by_risk_class[risk] ?? 0) + 1;

    const current = projectAssumptionCurrentState(run.events, run.runId);
    const byStatus = countAssumptionsByStatus(current);
    section.assumption_counts.open += byStatus.open;
    section.assumption_counts.deferred += byStatus.deferred;
    section.assumption_counts.resolved += byStatus.resolved;
    section.assumption_counts.invalidated += byStatus.invalidated;
    section.assumption_counts.unknown += byStatus.unknown;
    section.assumption_counts.unresolved += byStatus.open + byStatus.deferred;
  }

  for (const p of DELIVERY_PHASES) {
    if (phaseObserved[p]) {
      section.phase_elapsed_ms[p] = phaseSums[p];
      section.phase_elapsed_availability[p] = "observed";
    } else {
      section.phase_elapsed_ms[p] = null;
      section.phase_elapsed_availability[p] = "unavailable";
    }
  }

  // Derived: correction/planning elapsed ratio when both observed.
  const planE = section.phase_elapsed_ms.planning;
  const corrE = section.phase_elapsed_ms.correction;
  if (
    typeof planE === "number" &&
    planE > 0 &&
    typeof corrE === "number" &&
    section.phase_elapsed_availability.planning === "observed" &&
    section.phase_elapsed_availability.correction === "observed"
  ) {
    section.partitions.derived = {
      correction_elapsed_over_planning_elapsed: {
        value: corrE / planE,
        availability: "observed",
      },
    };
  } else {
    section.partitions.derived = {
      correction_elapsed_over_planning_elapsed: {
        value: null,
        availability: "unavailable",
      },
    };
  }

  section.partitions.observed = {
    by_planning_depth: { ...section.by_planning_depth },
    by_risk_class: { ...section.by_risk_class },
    phase_elapsed_ms: { ...section.phase_elapsed_ms },
    materiality_counts: { ...section.materiality_counts },
    assumption_counts: { ...section.assumption_counts },
  };

  // Active effort is never presented as zero fact.
  section.partitions.unavailable = {
    active_effort_ms: null,
    active_effort_availability: "unavailable",
    note: "active effort not coerced to 0 or elapsed",
  };

  if (section.runs_with_telemetry === 0 && section.total_runs_considered > 0) {
    section.diagnostics.push({
      code: "telemetry_absent",
      message: "no planning-leverage family events in window",
    });
  } else if (section.total_runs_considered === 0) {
    section.diagnostics.push({
      code: "telemetry_absent",
      message: "no included runs in window",
    });
  }

  // Hard rule: never emit collapsed scores.
  return section;
}

export function formatPlanningLeverageScoreboardHuman(
  section: PlanningLeverageScoreboardSection,
): string[] {
  const lines: string[] = [];
  lines.push("Planning leverage / material rework:");
  lines.push(
    `  Runs with telemetry: ${section.runs_with_telemetry} / ${section.total_runs_considered}` +
      ` (absent: ${section.runs_without_telemetry})`,
  );
  lines.push("  By planning_depth (selected, observed):");
  for (const d of PLANNING_DEPTHS) {
    lines.push(`    ${d}: ${section.by_planning_depth[d] ?? 0}`);
  }
  lines.push("  By risk_class (selected, observed):");
  for (const [k, v] of Object.entries(section.by_risk_class).sort()) {
    lines.push(`    ${k}: ${v}`);
  }
  lines.push("  Phase elapsed (observed only; unavailable left unlabeled as zero):");
  for (const p of DELIVERY_PHASES) {
    const avail = section.phase_elapsed_availability[p];
    const ms = section.phase_elapsed_ms[p];
    if (avail === "observed" && ms != null) {
      lines.push(`    ${p}: ${ms} ms (observed)`);
    } else {
      lines.push(`    ${p}: unavailable`);
    }
  }
  lines.push(
    `  Assumptions — unresolved (open+deferred): ${section.assumption_counts.unresolved}` +
      `, resolved: ${section.assumption_counts.resolved}`,
  );
  lines.push("  Materiality:");
  for (const m of MATERIALITIES) {
    lines.push(`    ${m}: ${section.materiality_counts[m] ?? 0}`);
  }
  lines.push(
    `  Material-rework events: ${section.fix_round_events}`,
  );
  const derived = section.partitions.derived
    .correction_elapsed_over_planning_elapsed as
    | { value: number | null; availability: string }
    | undefined;
  if (derived) {
    lines.push(
      `  Derived correction/planning elapsed ratio: ` +
        (derived.availability === "observed" && derived.value != null
          ? `${derived.value.toFixed(3)} (derived)`
          : "unavailable"),
    );
  }
  lines.push(
    "  Note: no productivity_score / leverage_score / expected_pain; " +
      "active effort unavailable is not reported as zero cost.",
  );
  // Host-local privacy: events under .agent-pipeline/runs; redacted free text;
  // retention follows scoreboard window; no fleet collector required.
  lines.push(
    "  Storage: host-local run events under .agent-pipeline/; redacted free text; " +
      "retention follows report window; no fleet collector required.",
  );
  for (const d of section.diagnostics) {
    lines.push(`  Diagnostic: ${d.code}: ${d.message}`);
  }
  return lines;
}

/** True when an event is a stage-timeline lifecycle type (excludes leverage family). */
export function isStageTimelineEventType(type: string): boolean {
  return type === "stage_start" || type === "stage_complete";
}
