// Trajectory/verifier artifact types (#536, eval-trajectory-artifacts).
//
// These describe the bounded, sanitized, content-addressed per-cell evidence
// this change persists alongside the compact runs.jsonl/grades.jsonl streams:
// one treatment trajectory artifact per executed cell, and one verifier
// evidence artifact per grader/judge that scored it. Every persisted shape
// carries a top-level schema_version (run-artifact-conventions).

import type { CellExecutionClass } from "../types.ts";

export const TRAJECTORY_SCHEMA_VERSION = 1;

export type TruncationStatus = "none" | "truncated";

/** Accounting for a deterministic head/tail bounding pass — always present,
 *  even when nothing was dropped (status "none", zero counts). */
export interface TruncationInfo {
  status: TruncationStatus;
  dropped_event_count: number;
  dropped_byte_count: number;
}

/** A telemetry channel a harness may or may not expose. `available: false`
 *  always carries a `reason` — an unavailable channel is never represented as
 *  an empty-but-successful one. */
export interface ChannelAvailability {
  available: boolean;
  reason?: string;
}

/** Reference to an artifact the treatment itself produced (e.g. a changed
 *  repository path in its worktree) — a path only, never file content. */
export interface ProducedArtifactRef {
  path: string;
}

/** One structured tool-call event, when a harness exposes tool-call
 *  structure. No harness this engine drives currently exposes this channel
 *  (see `tool_events.availability`); the shape is defined so a future harness
 *  adapter can populate it without a schema change. */
export interface ToolEvent {
  stage: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

/** One stage's bounded output — never chain-of-thought, only the harness's
 *  structured/plain-text stdout, its error text (if any), timing, and whether
 *  the invocation itself succeeded. */
export interface TrajectoryStageEntry {
  stage: string;
  output: string;
  error?: string;
  duration_ms?: number;
  success?: boolean;
}

/** Descriptor a referencing record (`runs.jsonl`, `grades.jsonl`, a judge
 *  record, a disagreement record) carries instead of embedding an artifact's
 *  content inline. */
export interface ArtifactDescriptor {
  /** Repo-relative path to the artifact file. */
  path: string;
  /** sha256 hex digest of the persisted (sanitized, bounded) bytes. */
  content_hash: string;
  schema_version: number;
  byte_count: number;
  truncation_status: TruncationStatus;
}

/** One immutable per-cell treatment trajectory artifact (task 1.1). */
export interface TreatmentTrajectoryArtifact {
  schema_version: number;
  cell_id: string;
  experiment_id: string;
  execution_class: CellExecutionClass;
  /** Bounded per-stage messages/output, error text, and timing. */
  stages: TrajectoryStageEntry[];
  /** Bounded, short human-readable descriptions of actions taken (stage
   *  invocations, environment setup/teardown, etc). */
  actions: string[];
  /** Structured tool-call events, when the harness exposes them — always
   *  capability-aware (see `ChannelAvailability`). */
  tool_events: { availability: ChannelAvailability; items: ToolEvent[] };
  /** Repository-relative paths the treatment changed in its own worktree. */
  produced_artifacts: ProducedArtifactRef[];
  /** Merged truncation accounting across every bounded channel above. */
  truncation: TruncationInfo;
}

/** One immutable verifier evidence artifact — emitted separately by each
 *  deterministic grader and by the optional model judge (task 1.1). Never
 *  shares an address with, and is never referenced by, the treatment
 *  trajectory artifact for the same cell. */
export interface VerifierEvidenceArtifact {
  schema_version: number;
  cell_id: string;
  experiment_id: string;
  verifier_kind: "grader" | "judge";
  verifier_id: string;
  verifier_version: string;
  /** The inputs this verifier consumed (grading-relevant cell detail, or the
   *  grade record handed to a judge). */
  inputs: unknown;
  /** Checks or evidence consulted while deciding — MAY include verifier-only
   *  material (hidden checks, seeded-defect ground truth, golden answers);
   *  this is the artifact where such material is permitted to live. */
  evidence_consulted: unknown[];
  /** Intermediate structured decisions, when the verifier produces any. */
  intermediate_decisions?: unknown;
  final_result: unknown;
  truncation: TruncationInfo;
}
