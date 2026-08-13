// Emit planning-leverage family events via appendEvent (#702).
//
// Inherits denylist/redaction, event-sink delivery, and summaryEvents
// accumulation from run-store. Non-fatal: append failures never throw.

import {
  appendEvent,
  defaultRunStoreDeps,
  RUN_SCHEMA_VERSION,
  type RunStoreDeps,
} from "../run-store.ts";
import {
  buildAssumptionPayload,
  buildMaterialReworkPayload,
  buildPhasePayload,
  makeAttribution,
  makePhaseInstanceId,
  mapStageToPhase,
  unavailableActiveEffort,
  type ActiveEffort,
  type AssumptionKind,
  type AssumptionStatus,
  type DeliveryPhase,
  type MaterialCriterion,
  type Materiality,
  type PhaseBoundary,
  type PlanningDepth,
  type PlanningLeverageAttribution,
  type PlanningLeverageFamilyEvent,
  type ReviewEffort,
  type RiskClass,
  type AssumptionResolution,
  emptyReviewEffort,
} from "./schema.ts";
import { classifyMateriality, type MaterialityEvidence } from "./materiality.ts";
import { createOpenAssumption, updateAssumptionStatus } from "./assumptions.ts";
import type { AssumptionLineagePayload } from "./schema.ts";
import type { PlanningLeverageSnapshotPayload } from "./schema.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function streamBase(type: PlanningLeverageFamilyEvent["type"], at?: string) {
  return {
    schema_version: RUN_SCHEMA_VERSION as 1,
    type,
    at: at ?? nowIso(),
  };
}

export interface EmitPhaseOpts {
  run_id: string;
  issue?: number | null;
  phase?: DeliveryPhase;
  /** When phase omitted, map from pipeline stage. */
  pipeline_stage?: string;
  boundary: PhaseBoundary;
  phase_instance_id?: string;
  planning_depth?: PlanningDepth;
  risk_class?: RiskClass;
  risk_classes?: RiskClass[];
  started_at?: string | null;
  ended_at?: string | null;
  active_effort?: ActiveEffort;
  at?: string;
}

/**
 * Emit a planning_leverage_phase start/end event.
 * Returns false when phase cannot be determined or validation fails (non-fatal).
 */
export async function emitPlanningLeveragePhase(
  runDir: string,
  opts: EmitPhaseOpts,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<boolean> {
  try {
    const phase = opts.phase ?? (opts.pipeline_stage ? mapStageToPhase(opts.pipeline_stage) : null);
    if (!phase) return false;

    const started_at =
      opts.started_at ??
      (opts.boundary === "start" ? (opts.at ?? nowIso()) : null);
    const ended_at =
      opts.ended_at ?? (opts.boundary === "end" ? (opts.at ?? nowIso()) : null);
    const phase_instance_id =
      opts.phase_instance_id ??
      makePhaseInstanceId({
        run_id: opts.run_id,
        phase,
        started_at: started_at ?? opts.at ?? nowIso(),
      });

    const runAttr = makeAttribution({
      target_type: "run",
      target_id: opts.run_id,
      method: "direct",
      authority: "observed",
      confidence: 1,
    });
    const attribution: PlanningLeverageAttribution[] = runAttr ? [runAttr] : [];
    if (opts.issue != null && opts.issue > 0) {
      const ia = makeAttribution({
        target_type: "issue",
        target_id: String(opts.issue),
        method: "direct",
        authority: "observed",
        confidence: 1,
      });
      if (ia) attribution.push(ia);
    }

    const built = buildPhasePayload({
      run_id: opts.run_id,
      issue: opts.issue ?? null,
      phase,
      phase_instance_id,
      boundary: opts.boundary,
      planning_depth: opts.planning_depth ?? "unknown",
      risk_class: opts.risk_class ?? "unknown",
      risk_classes: opts.risk_classes,
      started_at,
      ended_at: opts.boundary === "end" ? ended_at : null,
      active_effort: opts.active_effort ?? unavailableActiveEffort(),
      attribution,
      pipeline_stage: opts.pipeline_stage ?? null,
    });
    if (!built.ok || !built.value) {
      console.warn(
        `[pipeline] planning-leverage: phase payload invalid: ${built.issues.map((i) => i.message).join("; ")}`,
      );
      return false;
    }

    const event = {
      ...streamBase("planning_leverage_phase", opts.at),
      ...built.value,
    } as PlanningLeverageFamilyEvent;
    return await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] planning-leverage: emitPlanningLeveragePhase failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

export interface EmitAssumptionOpts {
  run_id: string;
  issue?: number | null;
  assumption_id?: string;
  kind: AssumptionKind;
  statement: string;
  introduced_phase: DeliveryPhase;
  status?: AssumptionStatus;
  status_updated_at?: string;
  resolution?: AssumptionResolution | null;
  evidence_refs?: string[];
  /** Prior payload for status updates (reuses assumption_id). */
  prior?: AssumptionLineagePayload;
  at?: string;
}

export async function emitAssumptionLineage(
  runDir: string,
  opts: EmitAssumptionOpts,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<boolean> {
  try {
    const at = opts.status_updated_at ?? opts.at ?? nowIso();
    let payload: AssumptionLineagePayload;
    if (opts.prior) {
      payload = updateAssumptionStatus({
        prior: opts.prior,
        status: opts.status ?? "open",
        status_updated_at: at,
        resolved_in_phase: opts.resolution?.resolved_in_phase,
        resolution_note: opts.resolution?.note,
        evidence_refs: opts.evidence_refs,
      });
    } else {
      payload = createOpenAssumption({
        run_id: opts.run_id,
        issue: opts.issue,
        assumption_id: opts.assumption_id,
        kind: opts.kind,
        statement: opts.statement,
        introduced_phase: opts.introduced_phase,
        status_updated_at: at,
      });
      if (opts.status && opts.status !== "open") {
        payload = updateAssumptionStatus({
          prior: payload,
          status: opts.status,
          status_updated_at: at,
          resolved_in_phase: opts.resolution?.resolved_in_phase,
          resolution_note: opts.resolution?.note,
          evidence_refs: opts.evidence_refs,
        });
      }
    }
    const built = buildAssumptionPayload(payload);
    if (!built.ok || !built.value) {
      console.warn(
        `[pipeline] planning-leverage: assumption payload invalid: ${built.issues.map((i) => i.message).join("; ")}`,
      );
      return false;
    }
    const event = {
      ...streamBase("assumption_lineage", opts.at ?? at),
      ...built.value,
    } as PlanningLeverageFamilyEvent;
    return await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] planning-leverage: emitAssumptionLineage failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

export interface EmitMaterialReworkOpts {
  run_id: string;
  issue?: number | null;
  /** Direct classification, or pass evidence for pure classifier. */
  materiality?: Materiality;
  material_criteria?: MaterialCriterion[];
  evidence?: MaterialityEvidence;
  fix_round?: number | null;
  review_effort?: ReviewEffort;
  phase_instance_id?: string | null;
  evidence_refs?: string[];
  started_at?: string | null;
  ended_at?: string | null;
  active_effort?: ActiveEffort;
  at?: string;
}

export async function emitMaterialRework(
  runDir: string,
  opts: EmitMaterialReworkOpts,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<boolean> {
  try {
    let materiality = opts.materiality;
    let criteria = opts.material_criteria ?? [];
    if (materiality == null && opts.evidence) {
      const c = classifyMateriality(opts.evidence);
      materiality = c.materiality;
      criteria = c.material_criteria;
    }
    if (materiality == null) materiality = "unknown";

    const built = buildMaterialReworkPayload({
      run_id: opts.run_id,
      issue: opts.issue ?? null,
      materiality,
      material_criteria: criteria,
      fix_round: opts.fix_round ?? null,
      review_effort: opts.review_effort ?? emptyReviewEffort(),
      phase_instance_id: opts.phase_instance_id ?? null,
      evidence_refs: opts.evidence_refs,
      started_at: opts.started_at,
      ended_at: opts.ended_at,
      active_effort: opts.active_effort,
    });
    if (!built.ok || !built.value) {
      console.warn(
        `[pipeline] planning-leverage: material_rework payload invalid: ${built.issues.map((i) => i.message).join("; ")}`,
      );
      return false;
    }
    const event = {
      ...streamBase("material_rework", opts.at),
      ...built.value,
    } as PlanningLeverageFamilyEvent;
    return await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] planning-leverage: emitMaterialRework failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

export async function emitPlanningLeverageSnapshot(
  runDir: string,
  snapshot: PlanningLeverageSnapshotPayload,
  deps: RunStoreDeps = defaultRunStoreDeps,
  at?: string,
): Promise<boolean> {
  try {
    const event = {
      ...streamBase("planning_leverage_snapshot", at),
      ...snapshot,
    } as PlanningLeverageFamilyEvent;
    return await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] planning-leverage: emitPlanningLeverageSnapshot failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Fix-round number from pipeline stage name (fix-1 → 1, fix-2 → 2).
 */
export function fixRoundFromStage(stage: string): number | null {
  const m = /^fix-(\d+)$/i.exec(stage);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
