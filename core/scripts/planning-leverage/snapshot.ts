// Optional per-run planning-leverage snapshot (#702).
//
// Separates raw observations from derived metrics with availability labels.
// Host-local default: optional event + optional file under run directory.

import * as path from "node:path";
import {
  DELIVERY_PHASES,
  emptyReviewEffort,
  makeAttribution,
  PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
  readAssumptionPayload,
  readMaterialReworkPayload,
  readPhasePayload,
  type DeliveryPhase,
  type ElapsedAvailability,
  type Materiality,
  type PlanningDepth,
  type PlanningLeverageSnapshotPayload,
  type RiskClass,
  type DerivedMetric,
  type ValueAvailability,
} from "./schema.ts";
import {
  countAssumptionsByStatus,
  projectAssumptionCurrentState,
} from "./assumptions.ts";
import {
  joinProductionOutcomesForRun,
  type ProductionOutcomeLite,
} from "./linkage.ts";

export const PLANNING_LEVERAGE_SNAPSHOT_FILENAME = "planning_leverage.json";

export function planningLeverageSnapshotPath(runDir: string): string {
  return path.join(runDir, PLANNING_LEVERAGE_SNAPSHOT_FILENAME);
}

/**
 * Build a snapshot from planning-leverage family events already collected.
 * Pure: no I/O. Derived metrics live only under `derived`.
 */
export function buildSnapshotFromEvents(args: {
  run_id: string;
  issue?: number | null;
  events: readonly unknown[];
  outcomes?: readonly ProductionOutcomeLite[];
  planning_depth?: PlanningDepth;
  risk_class?: RiskClass;
}): PlanningLeverageSnapshotPayload {
  const phase_elapsed_ms: Partial<Record<DeliveryPhase, number>> = {};
  const phase_elapsed_availability: Partial<
    Record<DeliveryPhase, ElapsedAvailability>
  > = {};
  let planning_depth: PlanningDepth = args.planning_depth ?? "unknown";
  let risk_class: RiskClass = args.risk_class ?? "unknown";
  let maxFixRound: number | null = null;

  for (const raw of args.events) {
    const phase = readPhasePayload(raw);
    if (phase) {
      if (phase.planning_depth !== "unknown") planning_depth = phase.planning_depth;
      if (phase.risk_class !== "unknown") risk_class = phase.risk_class;
      if (
        phase.boundary === "end" &&
        phase.elapsed_availability === "observed" &&
        typeof phase.elapsed_ms === "number"
      ) {
        phase_elapsed_ms[phase.phase] =
          (phase_elapsed_ms[phase.phase] ?? 0) + phase.elapsed_ms;
        phase_elapsed_availability[phase.phase] = "observed";
      } else if (
        phase.boundary === "end" &&
        phase_elapsed_availability[phase.phase] !== "observed"
      ) {
        phase_elapsed_availability[phase.phase] = "unavailable";
      }
    }
    const mat = readMaterialReworkPayload(raw);
    if (mat && typeof mat.fix_round === "number") {
      maxFixRound =
        maxFixRound == null ? mat.fix_round : Math.max(maxFixRound, mat.fix_round);
    }
  }

  // Ensure every phase has an availability label when we saw no end event.
  for (const p of DELIVERY_PHASES) {
    if (phase_elapsed_availability[p] == null && phase_elapsed_ms[p] == null) {
      // leave unset — not "zero observed"
    }
  }

  const current = projectAssumptionCurrentState(args.events, args.run_id);
  const byStatus = countAssumptionsByStatus(current);

  const materiality_counts: Record<Materiality, number> = {
    material: 0,
    ordinary: 0,
    unknown: 0,
  };
  for (const raw of args.events) {
    const mat = readMaterialReworkPayload(raw);
    if (mat) materiality_counts[mat.materiality]++;
  }

  const attribution = [];
  const runAttr = makeAttribution({
    target_type: "run",
    target_id: args.run_id,
    method: "direct",
    authority: "observed",
    confidence: 1,
  });
  if (runAttr) attribution.push(runAttr);
  if (args.issue != null && args.issue > 0) {
    const ia = makeAttribution({
      target_type: "issue",
      target_id: String(args.issue),
      method: "direct",
      authority: "observed",
      confidence: 1,
    });
    if (ia) attribution.push(ia);
  }

  const linkage_diagnostics: string[] = [];
  if (args.outcomes) {
    const joined = joinProductionOutcomesForRun({
      run_id: args.run_id,
      outcomes: args.outcomes,
    });
    for (const a of joined.attribution) attribution.push(a);
    linkage_diagnostics.push(...joined.diagnostics);
  }

  const derived: Record<string, DerivedMetric> = {};
  const planElapsed = phase_elapsed_ms.planning;
  const corrElapsed = phase_elapsed_ms.correction;
  if (
    typeof planElapsed === "number" &&
    planElapsed > 0 &&
    typeof corrElapsed === "number" &&
    phase_elapsed_availability.planning === "observed" &&
    phase_elapsed_availability.correction === "observed"
  ) {
    derived.correction_elapsed_over_planning_elapsed = {
      value: corrElapsed / planElapsed,
      availability: "observed",
      inputs: ["phase_elapsed_ms.correction", "phase_elapsed_ms.planning"],
    };
  } else {
    derived.correction_elapsed_over_planning_elapsed = {
      value: null,
      availability: "unavailable",
      inputs: ["phase_elapsed_ms.correction", "phase_elapsed_ms.planning"],
      note: "requires observed planning and correction elapsed",
    };
  }

  // Active-effort-based derived metric stays unavailable when active effort unknown.
  derived.active_correction_effort_ratio = {
    value: null,
    availability: "unavailable" as ValueAvailability,
    inputs: ["active_effort.correction", "active_effort.planning"],
    note: "active effort not measured in v1 emitters",
  };

  return {
    record_schema_version: PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
    type: "planning_leverage_snapshot",
    run_id: args.run_id,
    issue: args.issue ?? null,
    phase: null,
    phase_instance_id: null,
    planning_depth,
    risk_class,
    phase_elapsed_ms,
    phase_elapsed_availability,
    review_effort: emptyReviewEffort(),
    fix_rounds: maxFixRound,
    assumption_counts: {
      open: byStatus.open,
      deferred: byStatus.deferred,
      resolved: byStatus.resolved,
      invalidated: byStatus.invalidated,
      unknown: byStatus.unknown,
    },
    materiality_counts,
    attribution,
    linkage_diagnostics,
    derived,
  };
}

/** Write snapshot JSON under the run directory (host-local). Non-fatal. */
export async function writePlanningLeverageSnapshotFile(
  runDir: string,
  snapshot: PlanningLeverageSnapshotPayload,
  writeFile: (p: string, content: string) => Promise<void>,
): Promise<boolean> {
  try {
    // Never include collapsed score fields.
    const safe = { ...snapshot };
    delete (safe as { leverage_score?: unknown }).leverage_score;
    delete (safe as { productivity_score?: unknown }).productivity_score;
    delete (safe as { expected_pain?: unknown }).expected_pain;
    await writeFile(planningLeverageSnapshotPath(runDir), `${JSON.stringify(safe, null, 2)}\n`);
    return true;
  } catch (err) {
    console.warn(
      `[pipeline] planning-leverage: write snapshot failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

/** Collect family events from a mixed event list. */
export function filterPlanningLeverageEvents(
  events: readonly { type?: string }[],
): unknown[] {
  return events.filter(
    (e) =>
      e &&
      (e.type === "planning_leverage_phase" ||
        e.type === "assumption_lineage" ||
        e.type === "material_rework" ||
        e.type === "planning_leverage_snapshot"),
  );
}
