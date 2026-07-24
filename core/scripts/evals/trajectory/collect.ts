// Build sanitized, bounded trajectory/verifier artifact objects from raw
// per-cell execution data (#536, eval-trajectory-artifacts tasks 2, 3, 4).
// Sanitization runs before bounding (design.md decision 4): a secret or
// injection payload must never survive into the bytes that get bounded,
// hashed, and addressed. `store.ts` applies the same sanitization again,
// defensively, as the final chokepoint before the bytes are persisted —
// mirroring run-store.ts's belt-and-suspenders convention.

import { redactSecrets, sanitize } from "../../artifact-sanitize.ts";
import { boundItems, boundText, mergeTruncations, DEFAULT_TRAJECTORY_CEILINGS, type BoundCeilings } from "./bound.ts";
import {
  TRAJECTORY_SCHEMA_VERSION,
  type ChannelAvailability,
  type ProducedArtifactRef,
  type ToolEvent,
  type TreatmentTrajectoryArtifact,
  type TrajectoryStageEntry,
  type TruncationInfo,
  type VerifierEvidenceArtifact,
} from "./types.ts";
import type { CellExecutionClass, CellResultClass } from "../types.ts";

function clean(text: string): string {
  return sanitize(redactSecrets(text));
}

export interface RawStageEntry {
  stage: string;
  /** The materialized stage prompt/message supplied to the treatment —
   *  treatment-visible input only, never verifier-only material. */
  message: string;
  output: string;
  error?: string;
  duration_ms?: number;
  success?: boolean;
}

export interface BuildTreatmentTrajectoryInput {
  cell_id: string;
  experiment_id: string;
  execution_class: CellExecutionClass;
  stages: RawStageEntry[];
  actions: string[];
  /** Structured tool-call telemetry, when the harness/executor exposes it.
   *  `available: false` requires a `reason` (capability-aware collection,
   *  task 3.1) — no harness driven by this engine currently exposes this
   *  channel, so callers pass `{ available: false, reason: "..." }` today. */
  toolEvents: { availability: ChannelAvailability; items?: ToolEvent[] };
  producedArtifacts: string[];
  /** The cell's terminal result classification and, when not `"completed"`,
   *  its structured error — captured independently of any stage's own
   *  stdout/stderr so a timeout/infra_error/auth_error cell is diagnosable
   *  even when the failing stage produced no stderr. */
  result_class: CellResultClass;
  error?: string;
  ceilings?: BoundCeilings;
}

export function buildTreatmentTrajectoryArtifact(
  input: BuildTreatmentTrajectoryInput,
): TreatmentTrajectoryArtifact {
  const ceilings = input.ceilings ?? DEFAULT_TRAJECTORY_CEILINGS;
  const truncations: TruncationInfo[] = [];

  const sanitizedStages: TrajectoryStageEntry[] = input.stages.map((s) => {
    const boundedMessage = boundText(clean(s.message), ceilings.maxBytes);
    truncations.push(boundedMessage.truncation);
    const boundedOutput = boundText(clean(s.output), ceilings.maxBytes);
    truncations.push(boundedOutput.truncation);
    let error: string | undefined;
    if (s.error !== undefined) {
      const boundedError = boundText(clean(s.error), ceilings.maxBytes);
      truncations.push(boundedError.truncation);
      error = boundedError.text;
    }
    return {
      stage: s.stage,
      message: boundedMessage.text,
      output: boundedOutput.text,
      ...(error !== undefined ? { error } : {}),
      ...(s.duration_ms !== undefined ? { duration_ms: s.duration_ms } : {}),
      ...(s.success !== undefined ? { success: s.success } : {}),
    };
  });
  const boundedStages = boundItems(sanitizedStages, ceilings, (s) => JSON.stringify(s));
  truncations.push(boundedStages.truncation);

  const sanitizedActions = input.actions.map((a) => clean(a));
  const boundedActions = boundItems(sanitizedActions, ceilings, (a) => a);
  truncations.push(boundedActions.truncation);

  const toolEventItems = input.toolEvents.items ?? [];
  const boundedToolEvents = boundItems(toolEventItems, ceilings, (e) => JSON.stringify(e));
  truncations.push(boundedToolEvents.truncation);

  const producedArtifacts: ProducedArtifactRef[] = input.producedArtifacts.map((p) => ({ path: p }));

  let boundedError: string | undefined;
  if (input.error !== undefined) {
    const bounded = boundText(clean(input.error), ceilings.maxBytes);
    truncations.push(bounded.truncation);
    boundedError = bounded.text;
  }

  return {
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    cell_id: input.cell_id,
    experiment_id: input.experiment_id,
    execution_class: input.execution_class,
    stages: boundedStages.items,
    actions: boundedActions.items,
    tool_events: { availability: input.toolEvents.availability, items: boundedToolEvents.items },
    produced_artifacts: producedArtifacts,
    result_class: input.result_class,
    ...(boundedError !== undefined ? { error: boundedError } : {}),
    truncation: mergeTruncations(truncations),
  };
}

export interface BuildVerifierEvidenceInput {
  cell_id: string;
  experiment_id: string;
  verifier_kind: "grader" | "judge";
  verifier_id: string;
  verifier_version: string;
  inputs: unknown;
  evidence_consulted: unknown[];
  intermediate_decisions?: unknown;
  final_result: unknown;
  ceilings?: BoundCeilings;
}

export function buildVerifierEvidenceArtifact(input: BuildVerifierEvidenceInput): VerifierEvidenceArtifact {
  const ceilings = input.ceilings ?? DEFAULT_TRAJECTORY_CEILINGS;
  const bounded = boundItems(input.evidence_consulted, ceilings, (e) => JSON.stringify(e));

  return {
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    cell_id: input.cell_id,
    experiment_id: input.experiment_id,
    verifier_kind: input.verifier_kind,
    verifier_id: input.verifier_id,
    verifier_version: input.verifier_version,
    inputs: input.inputs,
    evidence_consulted: bounded.items,
    ...(input.intermediate_decisions !== undefined ? { intermediate_decisions: input.intermediate_decisions } : {}),
    final_result: input.final_result,
    truncation: bounded.truncation,
  };
}
