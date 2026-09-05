// Run-store (#155): stable run directory, append-only event log, and run artifacts.
//
// Layout: <repoDir>/.agent-pipeline/runs/<run-id>/
//   run.json           – immutable identity metadata (written once at initRunDir)
//   events.jsonl       – append-only O_APPEND event log (one JSON object per line)
//   write-health.json  – durable event-stream write-health (#633); elevated on
//                        append/sink/fallback delivery failures
//   terminal.log       – raw combined stdout/stderr (tee started after initRunDir)
//   summary.json       – finalized evidence bundle (written at finalizeRun)
//
// All writes are non-fatal: I/O errors are caught and logged. Readers tolerate
// missing files, corrupt tail lines, and unknown fields (forward-compat).
//
// Durability note (#633): events.jsonl uses O_APPEND single-line writes (complete
// newline-terminated JSON lines). Unlike the durable loop store (temp+fsync+rename
// whole documents), event appends do not fsync by default — a process crash can
// lose the last unflushed line(s). Readers skip partial/corrupt tail lines.
// Post-append fsync is optional via RunStoreDeps.fsyncFile when enabled.

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  ISSUE_HISTORY_SCHEMA_VERSION,
  type EvidenceBundle,
  type IssueHistoryEntry,
  type ReviewFindingRecord,
  type StageAccountingRecord,
} from "./types.ts";
import { redactSecrets, sanitize, sanitizeDeep } from "./artifact-sanitize.ts";
import { stageDurationMs } from "./evidence-bundle.ts";
import type { GhMetricsSummary } from "./gh.ts";
import type { HumanInterventionEvent } from "./intervention.ts";
import type { StageDiagnostic } from "./stage-diagnostic.ts";
import { validateCorrectionEvent, type CorrectionEvent } from "./correction.ts";
import type { ProductFaultEvent } from "./product-fault.ts";
import type {
  AssumptionLineageEvent,
  MaterialReworkEvent,
  PlanningLeveragePhaseEvent,
  PlanningLeverageSnapshotEvent,
} from "./planning-leverage/schema.ts";
import { accountingSummary, sanitizeStageAccountingRecord } from "./accounting.ts";
import { RUNS_ARTIFACT, HISTORY_ARTIFACT, artifactSubdir } from "./artifact-ignore.ts";
import {
  buildEvidenceSubjectDiagnostics,
  collectDiagnosticArtifactsFromBundle,
  type EvidenceSubjectV1,
} from "./evidence-subject.ts";
import {
  parseTrustedSurfaceDecision,
  stampTrustedSurfaceDecision,
  type TrustedSurfaceDecision,
} from "./trusted-surface.ts";
import { isLogicalOperationId, mintLogicalOperationId, resolveLogicalOperationId } from "./logical-operation.ts";
import {
  assertRequiredAdmissionRoute,
  type RequiredAdmissionRouteName,
} from "./operation-reliability.ts";

export const RUN_SCHEMA_VERSION = 1;

/** Durable trusted-surface decision artifact for a run (#691). */
export const TRUSTED_SURFACE_FILE = "trusted-surface.json";

export type RunId = string;

/** Filesystem-safe UTC timestamp with millisecond precision.
 *  Format: `YYYY-MM-DDTHH-MM-SS-mmmZ` (colons and the decimal point replaced
 *  with hyphens) so two instants in the same second produce distinct ids. */
export function filesystemSafeUtcTimestamp(startedAt: Date): string {
  return startedAt.toISOString().replace(/:/g, "-").replace(/\.(\d+)Z$/, "-$1Z");
}

/** Produce the run-id from issue number and dispatch start time.
 *  Format: `<issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ>` (filesystem-safe; colons and the
 *  decimal point replaced with hyphens). Milliseconds are preserved so that two
 *  dispatches starting in the same second produce distinct directories. */
export function runIdFor(issue: number, startedAt: Date): RunId {
  return `${issue}-${filesystemSafeUtcTimestamp(startedAt)}`;
}

/** Produce a train-level run-id. Distinct from per-issue advance ids
 *  (`<issue>-<timestamp>`): prefix `train-` plus the same filesystem-safe UTC
 *  timestamp with milliseconds. */
export function trainRunIdFor(startedAt: Date): RunId {
  return `train-${filesystemSafeUtcTimestamp(startedAt)}`;
}

/** Public unique-operation entrypoints that require strict durable admission. */
export type PublicEntrypointKind = "single" | "train" | "merge" | "merge-queue";

export const PUBLIC_ADMISSION_STAMP_VERSION = "public-admission.v1" as const;

export interface PublicAdmissionStamp {
  schema_version: typeof PUBLIC_ADMISSION_STAMP_VERSION;
  logical_operation_id: string;
  physical_run_id: RunId;
  entrypoint: PublicEntrypointKind;
  operation_key: string;
  repository: string;
  domain: string;
  issue: number | null;
  approved_root: string;
  started_at: string;
  binding_sha256: string;
}

/** Produce a public-entrypoint run-id (`single-` / `merge-` / `merge-queue-`
 *  plus the same filesystem-safe UTC timestamp as {@link trainRunIdFor}). */
export function publicEntrypointRunIdFor(
  kind: PublicEntrypointKind,
  startedAt: Date,
): RunId {
  return `${kind}-${filesystemSafeUtcTimestamp(startedAt)}`;
}

/** Root directory that holds all run subdirectories for a repo. */
export function runsDir(repoDir: string): string {
  return artifactSubdir(repoDir, RUNS_ARTIFACT);
}

/** Absolute path of a single run's directory. */
export function runDirPath(repoDir: string, runId: RunId): string {
  return path.join(runsDir(repoDir), runId);
}

/** Root directory for the issue-level evidence-history artifacts (#377), a
 *  sibling of `runs/` under `.agent-pipeline/` — durable, reboot-safe storage,
 *  unlike the legacy `/tmp/pipeline-<repo>` state dir. */
export function issueHistoryDir(repoDir: string): string {
  return artifactSubdir(repoDir, HISTORY_ARTIFACT);
}

/** Absolute path of the append-only per-issue evidence-history JSONL. */
export function issueHistoryPath(repoDir: string, issue: number): string {
  return path.join(issueHistoryDir(repoDir), `issue-${issue}.jsonl`);
}

/** Recover `repoDir` from a run directory. Inverse of
 *  `runDirPath(repoDir, runId) === path.join(repoDir, ".agent-pipeline", "runs", runId)`:
 *  strip the run-id, then "runs", then ".agent-pipeline". */
function repoDirFromRunDir(runDir: string): string {
  return path.dirname(path.dirname(path.dirname(runDir)));
}

// ---------------------------------------------------------------------------
// Event types — all carry schema_version, type, at
// ---------------------------------------------------------------------------

interface RunEventBase {
  schema_version: number;
  type: string;
  at: string;
}

export interface RunStartEvent extends RunEventBase {
  type: "run_start";
  run_id: RunId;
  /** Omitted on train runs — a train is not a one-issue advance. */
  issue?: number;
  /**
   * Public admission entrypoint when this run is `single` / `merge` /
   * `merge-queue`. Omitted on historical advance runs.
   */
  entrypoint?: PublicEntrypointKind;
  repo: string;
  /**
   * Outer-host session identity when known (#784). Independent of implementer
   * / reviewer adapter treatment identity. Omitted when unknown.
   */
  outer_host?: string;
  /**
   * Opaque immutable logical-operation identity (#1368). Additive;
   * `schema_version` stays 1. Distinct from physical `run_id`.
   */
  logical_operation_id?: string;
  /** Crash-durable public admission proof. Presence is not completion. */
  admission_stamp?: PublicAdmissionStamp;
}
export type RunCompleteStopReason = "iteration-budget-exhausted";

export interface RunCompleteEvent extends RunEventBase {
  type: "run_complete";
  final_state: string;
  elapsed_ms: number;
  /**
   * Additive incomplete-invocation marker (#1245). Set when the advance loop
   * falls through `MAX_ITERATIONS` at a non-terminal stage. Omitted on
   * successful ready-to-deploy finalize and on in-loop waiting/blocked stops.
   * `schema_version` stays 1.
   */
  stop_reason?: RunCompleteStopReason;
}
export interface StageStartEvent extends RunEventBase {
  type: "stage_start";
  stage: string;
}
export interface StageCompleteEvent extends RunEventBase {
  type: "stage_complete";
  stage: string;
  outcome: string;
  commits?: string[];
}
export interface PrCreatedEvent extends RunEventBase {
  type: "pr_created";
  pr: number;
}
export interface PrUpdatedEvent extends RunEventBase {
  type: "pr_updated";
  pr: number;
}
export interface WorktreeCreatedEvent extends RunEventBase {
  type: "worktree_created";
  _localPath: string;
}
export interface WorktreeRemovedEvent extends RunEventBase {
  type: "worktree_removed";
  _localPath: string;
}
export interface ReviewVerdictEvent extends RunEventBase {
  type: "review_verdict";
  round: number;
  sha: string;
  verdict: string;
  finding_counts: Record<string, number>;
  /** Per-finding records (#209). Additive optional — absent on pre-#209 events. */
  findings?: ReviewFindingRecord[];
  /** Harness that actually reviewed this round (#209, #39 fallback). */
  reviewer_harness?: string;
  reviewer_model?: string;
  self_review?: boolean;
  /**
   * Multi-agent ensemble identity when review_ensemble ran for this round
   * (#645). Additive optional — single-agent rounds omit it. schema_version
   * is not bumped solely for these fields.
   */
  ensemble?: {
    size: number;
    usable: number;
    failed: number;
    merge: "union_blocking";
    agents: Array<{
      role?: "primary";
      harness: string;
      effectiveHarness: string;
      model?: string;
      selfReview: boolean;
      status: "usable" | "failed";
      failureClass?: string;
      costUsd?: number | null;
      providerFamily?: string;
      modelFamily?: string;
      latencyMs?: number | null;
      costClass?: string;
      failureOrFallbackReason?: string;
      independentlyEligible?: boolean;
    }>;
    summary?: string;
    coverage?: {
      configured: number;
      attempted: number;
      usable: number;
      independent: number;
      required: number;
    };
    aggregation_outcome?: string;
    aggregation_reason?: string;
    cost?: {
      requested: number;
      attempted: number;
      completed: number;
      billable: number;
      billable_cost_usd?: number | null;
    };
    risk_class?: string;
  };
}
export interface GateResultEvent extends RunEventBase {
  type: "gate_result";
  gate: string;
  result: "pass" | "fail" | "partial" | "skipped";
  mode?: string;
  reason?: string;
}
/** Structured Tester suite evidence signal (#646). Appended only after a
 *  successful full-record write of `tester-evidence.json`. */
export interface TesterEvidenceEvent extends RunEventBase {
  type: "tester_evidence";
  overall_status: string;
  candidate_sha: string;
  duration_ms: number;
  command_count: number;
  issue?: number;
  run_id?: string;
}
/** Supplemental targeted-check signal (#646). Never replaces authoritative suite evidence. */
export interface TesterTargetedCheckEvent extends RunEventBase {
  type: "tester_targeted_check";
  candidate_sha: string;
  identity: string;
  status: string;
  duration_ms: number;
  issue?: number;
  run_id?: string;
}
export interface BlockerSetEvent extends RunEventBase {
  type: "blocker_set";
  reason: string;
  /** Exact producer-authored diagnostic; legacy events may omit it. */
  diagnostic?: StageDiagnostic;
  /**
   * Pipeline stage that produced the block (#683). Additive optional — absent
   * on pre-#683 events. Scoreboard pre-merge aggregates filter on
   * `stage === "pre-merge"`.
   */
  stage?: string;
  /**
   * Structural `BlockerKind` when known (#683). Additive optional — absent on
   * pre-#683 events. Used as a fallback class signal when `offramp_class` is
   * missing.
   */
  blocker_kind?: string;
  /**
   * Closed pre-merge off-ramp class when stage is pre-merge (#683). Additive
   * optional — absent on non-pre-merge blocks and pre-#683 events. Values are
   * members of `PreMergeOfframpClass` (`pre-merge-offramp.ts`).
   */
  offramp_class?: string;
  /**
   * Shared id pairing this `blocker_set` with the co-emitted `human_intervention`
   * for the same off-ramp (#683 review 2). Additive optional — scoreboard
   * dedupes only the matching pair so mixed historical/new streams still count
   * every distinct off-ramp.
   */
  offramp_id?: string;
}
export interface BlockerClearedEvent extends RunEventBase {
  type: "blocker_cleared";
}
export interface GhMetricsSummaryEvent extends RunEventBase {
  type: "gh_metrics_summary";
  call_count: number;
  total_ms: number;
  p50_ms: number;
  p95_ms: number;
  slowest_calls: { category: string; elapsed_ms: number }[];
  /** Per-run call counts by typed wrapper name (#839). Untagged calls omitted. */
  by_wrapper: Record<string, number>;
}
export interface StageAccountingEvent extends RunEventBase, StageAccountingRecord {
  type: "stage_accounting";
}
/** Recorded at the instant a `runCapped` wall-clock cap fires (#398) — before,
 *  and independent of, the harness invocation's promise resolving — so a
 *  supervisor tailing events.jsonl can detect a wedged harness without process
 *  introspection. Additive: does not change `schema_version` or the meaning of
 *  `stage_start`/`stage_complete` stage-timeline filters, which exclude it. */
export interface HarnessTimeoutEvent extends RunEventBase {
  type: "harness_timeout";
  stage: string;
  timeout_sec: number;
}
/** A fix-round harness invocation failed (crash or timeout) and is being
 *  retried in place, worktree preserved (#486). `attempt` is the about-to-run
 *  attempt's 1-indexed number (>= 2); `limit` is `auto_recovery_max_retries`;
 *  `reason` is the failure that triggered this retry. */
export interface FixHarnessRetryEvent extends RunEventBase {
  type: "fix_harness_retry";
  stage: string;
  attempt: number;
  limit: number;
  reason: string;
}
/** Advisory warning (#445): a harness commit step left a gitignored file
 *  uncommitted that is referenced by name in the committed diff. Never blocks
 *  and never changes stage advance/blocking semantics — purely informational
 *  so the exclusion is diagnosed at the stage that caused it instead of at a
 *  downstream CI failure. */
export interface IgnoredArtifactWarningEvent extends RunEventBase {
  type: "ignored_artifact_warning";
  stage: string;
  files: Array<{ path: string; source: string | null; line: number | null; pattern: string | null }>;
}

/** A blocking finding was demoted to advisory because it re-raised, without an
 *  explicit `prior_round_acknowledgment`, a SPECIFIC finding a prior round
 *  already settled (#389, finding-level matching #464). Never blocks and
 *  never changes the finding's visibility — the finding is still recorded and
 *  posted, tagged `REVERSAL-UNACKNOWLEDGED`; this event is purely an audit
 *  record of the demotion. `settled_finding_key`/`settling_round`/`matched_by`
 *  identify which prior finding was matched and how (#464). */
export interface ReversalUnacknowledgedEvent extends RunEventBase {
  type: "reversal_unacknowledged";
  finding_key: string;
  surface: string;
  settled_finding_key: string;
  settling_round: number;
  matched_by: "key" | "title-similarity";
}

/** Agent-self-reported minor friction (#419), non-blocking. Flows through the
 *  same `appendEvent` path as every other run event, so it inherits redaction
 *  and external-sink delivery unchanged. See `emitPapercut`. */
export interface PapercutEvent extends RunEventBase {
  type: "papercut";
  run_id: RunId;
  issue: number;
  stage: string | null;
  harness: string | null;
  model: string | null;
  message: string;
}

/** Mid-run engine drift (#450): the on-disk engine version and/or template
 *  fingerprint no longer match the identity this run was pinned to at start —
 *  most likely an `install.mjs update` landed while this process was still
 *  running. Advisory only: the run continues against its pinned snapshot;
 *  this event exists so the discrepancy is attributable after the fact. */
export interface EngineDriftEvent extends RunEventBase {
  type: "engine_drift";
  stage: string;
  pinned: RunEngineIdentity;
  observed: RunEngineIdentity;
}

/** Durable leftover vs unknown-dirt disposition (#1246). Additive; schema_version stays 1. */
export interface HarnessMutationOwnershipEvent extends RunEventBase {
  type: "harness_mutation_ownership";
  disposition: "recovered" | "checkpointed" | "resumed" | "rejected";
  issue: number;
  attempt_id: string;
  owned_path_count: number;
  unknown_paths?: string[];
}

/** A blocking finding was demoted to advisory because its `recommendation`
 *  reinstates a design alternative a settled finding's `rejected_alternatives`
 *  already required removed (#483) — the escape neither `matchSettledFinding`
 *  (key/title axis) nor a re-framed axis catches. Never blocks and never
 *  changes the finding's visibility — it is still recorded and posted, tagged
 *  `SETTLED-ALTERNATIVE-REINSTATED`; this event is purely an audit record. */
export interface SettledAlternativeReinstatedEvent extends RunEventBase {
  type: "settled_alternative_reinstated";
  finding_key: string;
  surface: string;
  settled_finding_key: string;
  settling_round: number;
  matched_alternative: string;
}

/** One pre-merge delta review round ran (#483). `round` is the 1-based round
 *  number for this item (the durable count observed BEFORE this round, plus
 *  one); `cap` is the configured `review_policy.max_delta_rounds`. */
export interface DeltaRoundEvent extends RunEventBase {
  type: "delta_round";
  round: number;
  cap: number;
}

/** The pre-merge item's durable delta-round count reached
 *  `review_policy.max_delta_rounds` (#483): no further delta review runs, and
 *  `ceiling_action` disposed of the outstanding blocking delta findings. */
export interface DeltaRoundCeilingEvent extends RunEventBase {
  type: "delta_round_ceiling";
  observed: number;
  cap: number;
  ceiling_action: "park" | "demote_and_advance";
}

/** A pre-merge delta round's blocking findings all sat on settled axes at
 *  confidence strictly below each axis's prior maximum (#483) — flagged as
 *  suspected churn, audit-only (never changes the round's blocking
 *  disposition on its own). */
export interface DeltaChurnSuspectedEvent extends RunEventBase {
  type: "delta_churn_suspected";
  round: number;
  axes: { surface: string; prior_max_confidence: number; new_confidence: number }[];
}

/** A delta-review finding was demoted to advisory because its surface matches
 *  a settled finding's surface and it cited no evidence drawn from the
 *  supplied HEAD file state (#496) — the evidence rule that raises the floor
 *  from "assume persistence" to "look at the file" for narrow follow-up
 *  diffs. Distinct from `reversal_unacknowledged`: this fires even when the
 *  finding carries a `prior_round_acknowledgment`, since that acknowledgment
 *  alone is not evidence. Never blocks and never changes visibility — the
 *  finding is still recorded and posted, tagged `SETTLED-SURFACE-UNVERIFIED`;
 *  this event is purely an audit record. */
export interface SettledSurfaceUnverifiedEvent extends RunEventBase {
  type: "settled_surface_unverified";
  finding_key: string;
  surface: string;
  settled_finding_key: string;
  settling_round: number;
}

/** A delta-review finding was demoted to advisory because it re-raises a
 *  prior-round advisory finding (same surface or stable key) without citing
 *  HEAD-state evidence of a new/worsened defect (#680). Distinct from
 *  `settled_surface_unverified` (which keys off resolved-by-fix / overridden
 *  settled findings). Never blocks by itself — the finding is still recorded
 *  and posted, tagged `ADVISORY-CARRY-FORWARD`; this event is purely an audit
 *  record. */
export interface AdvisoryCarryForwardEvent extends RunEventBase {
  type: "advisory_carry_forward";
  finding_key: string;
  surface: string;
  prior_advisory_key: string;
  prior_round: number;
  matched_by: "surface" | "key";
}

export type { HumanInterventionEvent };
export type { CorrectionEvent };
export type { ProductFaultEvent };
/** Planning-leverage family (#702) — additive; stream schema_version stays 1. */
export type { PlanningLeveragePhaseEvent, AssumptionLineageEvent, MaterialReworkEvent, PlanningLeverageSnapshotEvent };

export type RunEvent =
  | RunStartEvent
  | RunCompleteEvent
  | StageStartEvent
  | StageCompleteEvent
  | PrCreatedEvent
  | PrUpdatedEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | ReviewVerdictEvent
  | GateResultEvent
  | TesterEvidenceEvent
  | TesterTargetedCheckEvent
  | BlockerSetEvent
  | BlockerClearedEvent
  | GhMetricsSummaryEvent
  | StageAccountingEvent
  | HarnessTimeoutEvent
  | FixHarnessRetryEvent
  | IgnoredArtifactWarningEvent
  | PapercutEvent
  | ReversalUnacknowledgedEvent
  | SettledAlternativeReinstatedEvent
  | SettledSurfaceUnverifiedEvent
  | AdvisoryCarryForwardEvent
  | DeltaRoundEvent
  | DeltaRoundCeilingEvent
  | DeltaChurnSuspectedEvent
  | EngineDriftEvent
  | HarnessMutationOwnershipEvent
  | HumanInterventionEvent
  | CorrectionEvent
  | ProductFaultEvent
  | PlanningLeveragePhaseEvent
  | AssumptionLineageEvent
  | MaterialReworkEvent
  | PlanningLeverageSnapshotEvent;

// ---------------------------------------------------------------------------
// Write-health (#633) — durable mid-run event-stream delivery failures
// ---------------------------------------------------------------------------

export const WRITE_HEALTH_FILENAME = "write-health.json";
export const WRITE_HEALTH_SCHEMA_VERSION = 1 as const;

/** Criticality of an event-stream append for recovery / operator surfaces. */
export type EventCriticality = "control-critical" | "best-effort";

/**
 * Durable, run-scoped record of event-stream write failures. Absent / zero
 * failure_count means healthy (or a pre-#633 run that never recorded health).
 */
export interface WriteHealthRecord {
  schema_version: typeof WRITE_HEALTH_SCHEMA_VERSION;
  failure_count: number;
  last_failure_at: string | null;
  /** Redacted/capped last error message. */
  last_error: string | null;
  last_event_type: string | null;
  /** Worst criticality among failed writes; null when failure_count is 0. */
  worst_criticality: EventCriticality | null;
  exclusive_fallback_attempted: boolean;
  exclusive_fallback_succeeded: boolean;
}

export const HEALTHY_WRITE_HEALTH: WriteHealthRecord = {
  schema_version: WRITE_HEALTH_SCHEMA_VERSION,
  failure_count: 0,
  last_failure_at: null,
  last_error: null,
  last_event_type: null,
  worst_criticality: null,
  exclusive_fallback_attempted: false,
  exclusive_fallback_succeeded: false,
};

/**
 * Event types that recovery / authority disposition depends on.
 * Includes run-store control records and loop control-plane kinds that may be
 * classified through this helper (or bridged onto the same criticality API).
 */
const CONTROL_CRITICAL_EVENT_TYPES = new Set<string>([
  // Blocker + stage-diagnostic evidence (diagnostic is nested on blocker_set;
  // standalone type name reserved so a separate emit path cannot default to best-effort)
  "blocker_set",
  "blocker_cleared",
  "stage_diagnostic",
  "human_intervention",
  // Recovery claim / result (run-store path + loop recovery kinds)
  "correction_event",
  "fix_harness_retry",
  "loop_recovery_attempt",
  "loop_recovery_attempt_started",
  "loop_recovery_attempt_stale",
  // Run / loop terminal state
  "run_complete",
  "loop_run_stopped",
  "loop_run_complete",
  "loop_item_blocked",
]);

/** Default criticality for an event `type` (or loop `kind`) string. Callers may override. */
export function eventCriticalityForType(type: string): EventCriticality {
  if (CONTROL_CRITICAL_EVENT_TYPES.has(type)) return "control-critical";
  // Family prefixes: any recovery-claim/result kind stays control-critical even
  // when a new suffix is added without updating the closed set.
  if (type.startsWith("loop_recovery_")) return "control-critical";
  if (type.startsWith("stage_diagnostic")) return "control-critical";
  return "best-effort";
}

export function isElevatedWriteHealth(
  health: WriteHealthRecord | null | undefined,
): boolean {
  return health != null && health.failure_count > 0;
}

/** Cap + redact an error message for durable write-health storage. */
function capWriteHealthError(message: string, maxLen = 240): string {
  const redacted = sanitize(redactSecrets(message));
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen - 1)}…`;
}

function worseCriticality(
  a: EventCriticality | null,
  b: EventCriticality,
): EventCriticality {
  if (a === "control-critical" || b === "control-critical") return "control-critical";
  return "best-effort";
}

export function writeHealthPath(runDir: string): string {
  return path.join(runDir, WRITE_HEALTH_FILENAME);
}

/**
 * Synthetic elevated record when write-health.json exists but cannot be trusted
 * (I/O error other than missing, JSON parse failure, or invalid shape). Fail-safe:
 * operators and recovery treat this as control-critical incomplete evidence —
 * never as healthy / zero-failure.
 */
export const UNREADABLE_WRITE_HEALTH: WriteHealthRecord = {
  schema_version: WRITE_HEALTH_SCHEMA_VERSION,
  failure_count: 1,
  last_failure_at: null,
  last_error: "write-health.json unreadable or corrupt",
  last_event_type: null,
  worst_criticality: "control-critical",
  exclusive_fallback_attempted: false,
  exclusive_fallback_succeeded: false,
};

/**
 * Parse write-health JSON text. Corrupt / invalid / incomplete content returns
 * {@link UNREADABLE_WRITE_HEALTH} (elevated) rather than null so callers never
 * convert a present-but-broken artifact into a healthy run.
 *
 * Requires the complete on-disk schema at runtime: supported schema_version,
 * non-negative integer failure_count, required nullable/string fields, valid
 * criticality, and boolean exclusive-fallback flags. Partial JSON such as
 * `{ "failure_count": 0 }` is elevated, not normalized to healthy.
 */
export function parseWriteHealthText(raw: string): WriteHealthRecord {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    const o = parsed as Record<string, unknown>;
    // Supported schema version is required — missing/unsupported is corrupt.
    if (o.schema_version !== WRITE_HEALTH_SCHEMA_VERSION) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    // failure_count: required non-negative integer (reject floats/negatives).
    if (
      typeof o.failure_count !== "number" ||
      !Number.isInteger(o.failure_count) ||
      !Number.isFinite(o.failure_count) ||
      o.failure_count < 0
    ) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    // Required nullable/string fields must be present with correct types.
    if (!(o.last_failure_at === null || typeof o.last_failure_at === "string")) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    if (!(o.last_error === null || typeof o.last_error === "string")) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    if (!(o.last_event_type === null || typeof o.last_event_type === "string")) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    // worst_criticality: null when healthy; one of the two classes when elevated.
    if (
      !(
        o.worst_criticality === null ||
        o.worst_criticality === "control-critical" ||
        o.worst_criticality === "best-effort"
      )
    ) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    if (typeof o.exclusive_fallback_attempted !== "boolean") {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    if (typeof o.exclusive_fallback_succeeded !== "boolean") {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    // Consistency: elevated records must carry a criticality; healthy must not.
    if (o.failure_count > 0 && o.worst_criticality === null) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    if (o.failure_count === 0 && o.worst_criticality !== null) {
      return { ...UNREADABLE_WRITE_HEALTH };
    }
    return {
      schema_version: WRITE_HEALTH_SCHEMA_VERSION,
      failure_count: o.failure_count,
      last_failure_at: o.last_failure_at,
      last_error: o.last_error,
      last_event_type: o.last_event_type,
      worst_criticality: o.worst_criticality,
      exclusive_fallback_attempted: o.exclusive_fallback_attempted,
      exclusive_fallback_succeeded: o.exclusive_fallback_succeeded,
    };
  } catch {
    return { ...UNREADABLE_WRITE_HEALTH };
  }
}

/**
 * Map a filesystem read failure for `write-health.json` onto the
 * missing-vs-unreadable dep contract used by recovery dispatch (#633):
 * - ENOENT → `null` (legacy / never written; non-elevated)
 * - any other error → non-empty non-JSON text so {@link parseWriteHealthText}
 *   elevates to {@link UNREADABLE_WRITE_HEALTH}
 *
 * Callers that collapse every read error to `null` lose the fail-safe signal.
 */
export function writeHealthTextForReadFailure(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return null;
  const msg =
    err instanceof Error
      ? err.message || err.name || "unknown read error"
      : String(err);
  return `{unreadable write-health: ${msg}}`;
}

/**
 * Read write-health.json.
 * - Missing file (ENOENT) → null (legacy run / never written; not a failure).
 * - Present but unreadable, corrupt, or invalid shape → elevated
 *   {@link UNREADABLE_WRITE_HEALTH} (fail-safe; never substitute healthy).
 * - Valid JSON → normalized {@link WriteHealthRecord}.
 */
export async function readWriteHealth(
  runDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<WriteHealthRecord | null> {
  try {
    const raw = await deps.readFile(writeHealthPath(runDir));
    return parseWriteHealthText(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    // File present but unreadable (EACCES, EISDIR, …) or unknown I/O error —
    // fail safe rather than treating as healthy/absent.
    return {
      ...UNREADABLE_WRITE_HEALTH,
      last_error: capWriteHealthError(
        `write-health.json unreadable: ${(err as Error).message ?? String(err)}`,
      ),
    };
  }
}

export interface WriteHealthFailureUpdate {
  eventType: string;
  criticality: EventCriticality;
  error: string;
  exclusiveFallbackAttempted?: boolean;
  exclusiveFallbackSucceeded?: boolean;
}

/**
 * Per-run serialization for write-health read-modify-write updates (#633).
 * Prevents concurrent appendEvent failures from losing increments or
 * downgrading worst_criticality when two updates race on the same runDir.
 * Host-local / in-process only (same concurrency scope as other run-store I/O).
 */
const writeHealthUpdateChains = new Map<string, Promise<void>>();

/** Unique temp path so concurrent writers never share `write-health.json.tmp`. */
function writeHealthTempPath(target: string): string {
  const uniq = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return `${target}.tmp.${uniq}`;
}

/** Safe, non-empty description of a sink rejection (may be non-Error / empty message). */
function describeSinkDeliveryError(err: unknown): string {
  if (err instanceof Error) {
    const msg = typeof err.message === "string" ? err.message.trim() : "";
    if (msg) return msg;
    const name = err.name && err.name !== "Error" ? err.name : "Error";
    return `${name} (empty message)`;
  }
  if (err === undefined) return "sink rejected with undefined";
  if (err === null) return "sink rejected with null";
  try {
    return `sink rejected: ${String(err)}`;
  } catch {
    return "sink rejected with unprintable value";
  }
}

/**
 * Merge a failure into write-health.json. Best-effort: never throws.
 * Returns the updated record, or null when the update itself could not be
 * persisted (callers still surface via console.warn on the append path).
 * Updates for the same runDir are serialized so concurrent failures cannot
 * lose increments or downgrade criticality (#633).
 */
export async function recordWriteHealthFailure(
  runDir: string,
  update: WriteHealthFailureUpdate,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<WriteHealthRecord | null> {
  const prev = writeHealthUpdateChains.get(runDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate).catch(() => undefined);
  writeHealthUpdateChains.set(runDir, chained);
  await prev.catch(() => undefined);
  try {
    try {
      const priorRaw = await readWriteHealth(runDir, deps);
      // Unreadable prior still elevates; start from its failure_count when known,
      // otherwise from healthy zero so we record at least this failure.
      const prior =
        priorRaw && priorRaw.failure_count >= 0
          ? priorRaw
          : { ...HEALTHY_WRITE_HEALTH };
      const next: WriteHealthRecord = {
        schema_version: WRITE_HEALTH_SCHEMA_VERSION,
        failure_count: prior.failure_count + 1,
        last_failure_at: nowIso(),
        last_error: capWriteHealthError(update.error),
        last_event_type: update.eventType,
        worst_criticality: worseCriticality(prior.worst_criticality, update.criticality),
        exclusive_fallback_attempted:
          prior.exclusive_fallback_attempted || update.exclusiveFallbackAttempted === true,
        exclusive_fallback_succeeded:
          prior.exclusive_fallback_succeeded || update.exclusiveFallbackSucceeded === true,
      };
      // Prefer atomic unique-tmp+rename when rename is available; fall back to writeFile.
      const target = writeHealthPath(runDir);
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      try {
        const tmp = writeHealthTempPath(target);
        await deps.writeFile(tmp, serialized);
        await deps.rename(tmp, target);
      } catch {
        await deps.writeFile(target, serialized);
      }
      return next;
    } catch (err) {
      console.warn(
        `[pipeline] run-store: write-health update failed (non-fatal): ${(err as Error).message}`,
      );
      return null;
    }
  } finally {
    release();
    // Drop map entry when this waiter is still the chain tail (no newer waiter).
    if (writeHealthUpdateChains.get(runDir) === chained) {
      writeHealthUpdateChains.delete(runDir);
    }
  }
}

/** Public operator-facing shape for status/summary JSON (elevated or healthy). */
export function writeHealthForOperatorSurface(
  health: WriteHealthRecord | null | undefined,
): WriteHealthRecord | null {
  if (!health) return null;
  if (!isElevatedWriteHealth(health)) {
    // Explicit healthy representation for finalized bundles; status JSON uses
    // null for healthy/absent to avoid inventing failures.
    return { ...HEALTHY_WRITE_HEALTH };
  }
  return health;
}

// ---------------------------------------------------------------------------
// Deps — injectable I/O seam; unit tests inject in-memory fakes
// ---------------------------------------------------------------------------

export interface RunStoreDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  /** Append to file using O_APPEND semantics (create if absent). */
  appendFile: (p: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat: (p: string) => Promise<{ mtime: Date }>;
  /**
   * Optional post-append durability flush for events.jsonl (#633). When set,
   * called after a successful local append; failure is treated as durable-
   * delivery failure (return false + write-health). Default deps leave this
   * unset — residual durability gap vs loop store's fsync document writes.
   */
  fsyncFile?: (p: string) => Promise<void>;
  /** When set, each appended event line is also passed here (--json-events mode). */
  stdoutWrite?: (line: string) => void;
  /** Optional external event sink (#343). When set, each appended event line is
   *  also delivered here (in addition to, or instead of, the local events.jsonl
   *  write — see `eventSinkMode`). Delivery is best-effort: appendEvent catches
   *  any throw/rejection and logs a non-fatal warning, never propagating it.
   *  In exclusive mode, sink failure triggers a local events.jsonl fallback (#633). */
  eventSink?: (line: string) => void | Promise<void>;
  /** Selects whether the local events.jsonl write happens alongside eventSink
   *  delivery ("additive", default) or is skipped on successful sink delivery
   *  ("exclusive"). On exclusive sink failure the engine falls back to a local
   *  write (#633). Ignored when eventSink is unset. */
  eventSinkMode?: "additive" | "exclusive";
  /** Optional in-memory accumulator (#343): when set, every event appended via
   *  appendEvent is also pushed here, regardless of eventSinkMode. finalizeRun
   *  reads from this (when present) instead of re-reading events.jsonl, so
   *  stage_accounting/human_intervention data still reaches summary.json in
   *  exclusive mode, where events.jsonl is not written on the happy path. */
  summaryEvents?: RunEvent[];
  /**
   * Authoritative evaluation-pin subject for finalize diagnostics (#692).
   * MUST be derived from live run/candidate runtime state — never inferred from
   * the readiness artifacts under comparison. When absent/null, diagnostics
   * MUST NOT report `match` (pin-unavailable disposition).
   */
  evaluationPinSubject?: EvidenceSubjectV1 | null;
}

export const defaultRunStoreDeps: RunStoreDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  readdir: async (p) => {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries as Array<{ name: string; isDirectory(): boolean }>;
  },
  stat: (p) => fsp.stat(p),
  // fsyncFile intentionally unset by default — see file header durability note.
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// initRunDir
// ---------------------------------------------------------------------------

/** Identity of the engine snapshot a run is pinned to (#450): the engine
 *  version, its resolved root path, and a fingerprint of the pinned prompt-
 *  template set. Captured once at run start; omitted when resolution fails.
 *
 *  #762 adds optional two-track fields: `track` (`pinned` | `candidate`) is
 *  required for **new** runs that write engine identity; historical run.json
 *  without `track` remains readable — consumers treat missing track as unknown
 *  and never invent it from version alone. Optional `pin_version` / `git_sha`
 *  are advisory when known at run start. Mid-run drift uses `engine_drift`
 *  events and does **not** rewrite `engine.track`. */
export interface RunEngineIdentity {
  version: string;
  root: string;
  templates_fingerprint: string;
  /** Two-track classification (#762). Absent on pre-track historical runs. */
  track?: "pinned" | "candidate";
  /** Production pin target version when known at run start (#762). */
  pin_version?: string;
  /** Release git SHA when known; omit rather than invent (#762). */
  git_sha?: string;
  /**
   * Git commit of the engine root checkout when resolvable at init (#763).
   * Distinct from `git_sha` (production pin). Omitted/null when unresolvable —
   * never invented. Write-once with the rest of `engine`.
   */
  commit_sha?: string | null;
}

export type RunKind = "advance" | "train" | PublicEntrypointKind;

export interface TrainRunSelector {
  issues?: number[];
  milestone?: string;
}

export interface RunMeta {
  schema_version: number;
  run_id: RunId;
  /**
   * Advance runs identify one issue. Train runs omit this (or leave it null)
   * so a multi-item train is not a fake one-issue advance record.
   */
  issue?: number | null;
  /** Explicit run kind. Omitted on historical advance runs (treated as advance). */
  kind?: RunKind;
  /** Train merge mode when `kind` is `train`. */
  merge_mode?: boolean;
  /** Train selector when `kind` is `train`. */
  selector?: TrainRunSelector;
  /** Ordered work-list issue numbers when known at train init. */
  ordered_issues?: number[];
  repo: string;
  profile: string | null;
  started_at: string;
  /** Omitted when the engine identity cannot be resolved at run-directory
   *  creation (e.g. missing/malformed package.json) — the run still starts. */
  engine?: RunEngineIdentity;
  /**
   * Outer-host session identity (#784). Separate from implementer/reviewer
   * treatment (adapter) identity. Omitted when unknown rather than invented
   * from adapter id.
   */
  outer_host?: string;
  /**
   * Run-level discovery-channel default (#763). Written for new runs so
   * scoreboard collectors can inherit event-level channel only when this
   * explicit stamp is present. Historical run.json without the field must
   * not be treated as live-run merely because engine.version exists.
   */
  discovery_channel?: string;
  /**
   * Opaque immutable logical-operation identity (#1368). Written once at
   * first init. Distinct from physical `run_id`. Historical artifacts omit it.
   */
  logical_operation_id?: string;
  /** Crash-durable public admission proof. Presence is not completion. */
  admission_stamp?: PublicAdmissionStamp;
}

export interface InitRunDirOpts {
  runDir: string;
  runId: RunId;
  /**
   * Required for advance runs. Train runs (`kind: "train"`) omit this so
   * `run.json` is not a fake single-issue advance record. `single` may set
   * it; `merge` / `merge-queue` omit it.
   */
  issue?: number;
  /**
   * When `"train"`, write train identity (selector, merge mode, ordered issues).
   * When `"single"` / `"merge"` / `"merge-queue"`, persist that public kind.
   */
  kind?: RunKind;
  mergeMode?: boolean;
  selector?: TrainRunSelector;
  orderedIssues?: readonly number[];
  repo: string;
  profile: string | null;
  startedAt: string;
  engine?: RunEngineIdentity;
  /** Outer-host id when known (#784). Never invent from adapter id. */
  outerHost?: string | null;
  /**
   * Run-level discovery-channel (#763). Defaults to `live-run` for ordinary
   * advance when omitted so new runs always carry an explicit stamp.
   * Pass another closed-set value for batch/manual contexts. Historical
   * runs that predate this field remain readable without inventing a channel.
   */
  discoveryChannel?: string | null;
  /**
   * Resume / parent-handoff binding (#1368). When omitted, a new logical
   * identity is minted. Re-entry of an existing run.json ignores this and
   * keeps the written value.
   */
  logicalOperationId?: string | null;
  /** Injectable mint for tests. Production uses crypto.randomBytes. */
  mintLogicalOperationId?: () => string;
}

/** Create the run directory, write run.json, append run_start to events.jsonl.
 *  Idempotent: if run.json already exists (same run-id re-entered), returns
 *  immediately without touching run.json or events.jsonl.
 *  Non-fatal: I/O errors are caught and logged. */
export async function initRunDir(
  opts: InitRunDirOpts,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    await deps.mkdir(opts.runDir, { recursive: true });

    // Idempotency guard: if run.json already exists this directory was already
    // initialized. Do not overwrite run.json (written-once contract) and do not
    // truncate events.jsonl (append-only contract).
    try {
      await deps.stat(path.join(opts.runDir, "run.json"));
      return; // already initialized — leave all files untouched
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT → first initialization, continue below
    }

    const outerHost =
      typeof opts.outerHost === "string" && opts.outerHost.trim()
        ? opts.outerHost.trim()
        : undefined;
    // #763: new runs always persist an explicit discovery_channel so collectors
    // never treat pre-stamp history (engine.version only) as live-run.
    const discoveryChannel =
      typeof opts.discoveryChannel === "string" && opts.discoveryChannel.trim()
        ? opts.discoveryChannel.trim()
        : opts.discoveryChannel === null
          ? undefined
          : "live-run";
    const isTrain = opts.kind === "train";
    const publicKind: PublicEntrypointKind | undefined =
      opts.kind === "single" || opts.kind === "merge" || opts.kind === "merge-queue"
        ? opts.kind
        : undefined;
    const logicalOperationId = resolveLogicalOperationId({
      parent: opts.logicalOperationId,
      mint: opts.mintLogicalOperationId ?? mintLogicalOperationId,
    });
    const meta: RunMeta = {
      schema_version: RUN_SCHEMA_VERSION,
      run_id: opts.runId,
      logical_operation_id: logicalOperationId,
      repo: opts.repo,
      profile: opts.profile,
      started_at: opts.startedAt,
      ...(isTrain
        ? {
            kind: "train" as const,
            merge_mode: !!opts.mergeMode,
            ...(opts.selector ? { selector: opts.selector } : {}),
            ...(opts.orderedIssues ? { ordered_issues: [...opts.orderedIssues] } : {}),
          }
        : publicKind
          ? {
              kind: publicKind,
              ...(opts.issue != null ? { issue: opts.issue } : {}),
            }
          : { issue: opts.issue }),
      ...(opts.engine ? { engine: opts.engine } : {}),
      ...(outerHost ? { outer_host: outerHost } : {}),
      ...(discoveryChannel ? { discovery_channel: discoveryChannel } : {}),
    };
    await deps.writeFile(
      path.join(opts.runDir, "run.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
    );

    // Create terminal.log up front (empty, append-mode so an existing file is not
    // truncated) so a `pipeline logs <id> --follow` started in the window between
    // run_start and the terminal tee attaching does not fail on a missing file (#155).
    await deps.appendFile(path.join(opts.runDir, "terminal.log"), "");

    // Append the run_start event (appendFile creates events.jsonl on first use).
    // Train runs own seq via the train event session; skip here so seq stays 1-based
    // without a duplicate run_start. Still create events.jsonl so hosts can follow
    // immediately after init.
    if (isTrain) {
      await deps.appendFile(path.join(opts.runDir, "events.jsonl"), "");
    }
    if (!isTrain) {
      const event: RunStartEvent = {
        schema_version: RUN_SCHEMA_VERSION,
        type: "run_start",
        at: opts.startedAt,
        run_id: opts.runId,
        logical_operation_id: logicalOperationId,
        repo: opts.repo,
        ...(opts.issue != null ? { issue: opts.issue } : {}),
        ...(publicKind ? { entrypoint: publicKind } : {}),
        ...(outerHost ? { outer_host: outerHost } : {}),
      };
      await appendEvent(opts.runDir, event, deps);
    }
  } catch (err) {
    console.warn(
      `[pipeline] run-store: initRunDir failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

/**
 * Write root for a public `single` / `merge` / `merge-queue` admission.
 * Unique-operation collection scores `runsDir(resolveFactoryControlRoot(...))`
 * plus loop state-home. Persist MUST land in that factory-control generic
 * store. A candidate-worktree `repoDir` is never a fallback: inability to
 * resolve the approved control root is an admission refusal.
 */
export async function resolvePublicAdmissionPersistRoot(opts: {
  repoDir: string;
  env?: NodeJS.ProcessEnv;
  factoryControlDir?: string | null;
  /**
   * Test overlay. `undefined` resolves the live factory-control root.
   * A non-empty string is that approved persist root. `null` / empty means
   * there is no approved root and admission must fail closed.
   */
  factoryControlRoot?: string | null;
}): Promise<string | null> {
  if (opts.factoryControlRoot !== undefined) {
    const overlay =
      typeof opts.factoryControlRoot === "string" ? opts.factoryControlRoot.trim() : "";
    return overlay !== "" ? overlay : null;
  }
  const { resolveFactoryControlRoot } = await import("./production-engine-pin.ts");
  const controlRoot = resolveFactoryControlRoot({
    repoDir: opts.repoDir,
    env: opts.env,
    factoryControlDir: opts.factoryControlDir,
  });
  return controlRoot;
}

export type PublicAdmissionFailureKind =
  | "invalid_binding"
  | "approved_root_unavailable"
  | "approved_root_mismatch"
  | "persistence_failure"
  | "verification_failure"
  | "identity_conflict";

export interface PublicAdmissionIdentity {
  kind: PublicEntrypointKind;
  operationKey: string;
  runId: RunId;
  logicalOperationId: string;
  repository: string;
  domain: string;
  issue: number | null;
  startedAt: string;
}

export interface PublicAdmissionBinding extends PublicAdmissionIdentity {
  approvedRoot: string;
  runDir: string;
  stamp: PublicAdmissionStamp;
}

export type PublicAdmissionResult =
  | ({ acknowledged: true; binding: PublicAdmissionBinding } & PublicAdmissionBinding)
  | ({
      acknowledged: false;
      binding: PublicAdmissionIdentity & { approvedRoot: string | null; runDir: string | null };
      failure: { kind: PublicAdmissionFailureKind; step: string; diagnostic: string };
    } & PublicAdmissionIdentity & { approvedRoot: string | null; runDir: string | null });

/** Strict I/O required for an acknowledged public admission. */
export interface PublicAdmissionStoreDeps extends RunStoreDeps {
  fsyncFile: (p: string) => Promise<void>;
  fsyncDirectory: (p: string) => Promise<void>;
  realpath: (p: string) => Promise<string>;
  /** Atomically publish an already-durable claim without replacing a winner. */
  link: (existingPath: string, newPath: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
}

export const PUBLIC_ADMISSION_CLAIM_VERSION = "public-admission-claim.v1" as const;

interface PublicAdmissionClaim {
  schema_version: typeof PUBLIC_ADMISSION_CLAIM_VERSION;
  operation_key: string;
  logical_operation_id: string;
  entrypoint: PublicEntrypointKind;
  repository: string;
  domain: string;
  issue: number | null;
  approved_root: string;
  claimed_at: string;
}

export const defaultPublicAdmissionStoreDeps: PublicAdmissionStoreDeps = {
  ...defaultRunStoreDeps,
  fsyncFile: async (p) => {
    const handle = await fsp.open(p, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  fsyncDirectory: async (p) => {
    const handle = await fsp.open(p, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  realpath: (p) => fsp.realpath(p),
  link: (existingPath, newPath) => fsp.link(existingPath, newPath),
  unlink: (p) => fsp.unlink(p),
};

function publicAdmissionBindingDigest(
  input: Omit<PublicAdmissionStamp, "schema_version" | "binding_sha256">,
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function boundedAdmissionDiagnostic(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return sanitize(message).slice(0, 1000) || "unknown admission failure";
}

function publicAdmissionFailure(
  identity: PublicAdmissionIdentity,
  root: string | null,
  runDir: string | null,
  kind: PublicAdmissionFailureKind,
  step: string,
  err: unknown,
): PublicAdmissionResult {
  const common = { ...identity, approvedRoot: root, runDir };
  return {
    acknowledged: false,
    ...common,
    binding: common,
    failure: { kind, step, diagnostic: boundedAdmissionDiagnostic(err) },
  };
}

function parseAdmissionDocuments(
  runRaw: string,
  eventsRaw: string,
): { meta: RunMeta; event: RunStartEvent } {
  const meta = JSON.parse(runRaw) as RunMeta;
  const lines = eventsRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new Error("events.jsonl must contain exactly one admission event");
  return { meta, event: JSON.parse(lines[0]!) as RunStartEvent };
}

function verifyPublicAdmissionDocuments(
  binding: PublicAdmissionBinding,
  runRaw: string,
  eventsRaw: string,
): void {
  const { meta, event } = parseAdmissionDocuments(runRaw, eventsRaw);
  const expectedStamp = JSON.stringify(binding.stamp);
  const checks: Array<[boolean, string]> = [
    [meta.schema_version === RUN_SCHEMA_VERSION, "run schema"],
    [meta.run_id === binding.runId, "run id"],
    [meta.logical_operation_id === binding.logicalOperationId, "logical operation id"],
    [meta.kind === binding.kind, "entrypoint kind"],
    [meta.repo === binding.repository, "repository"],
    [(meta.issue ?? null) === binding.issue, "issue"],
    [JSON.stringify(meta.admission_stamp) === expectedStamp, "run admission stamp"],
    [event.schema_version === RUN_SCHEMA_VERSION && event.type === "run_start", "event schema/type"],
    [event.run_id === binding.runId, "event run id"],
    [event.logical_operation_id === binding.logicalOperationId, "event logical operation id"],
    [event.entrypoint === binding.kind, "event entrypoint"],
    [event.repo === binding.repository, "event repository"],
    [(event.issue ?? null) === binding.issue, "event issue"],
    [JSON.stringify(event.admission_stamp) === expectedStamp, "event admission stamp"],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Error(`admission read-back ${failed[1]} mismatch`);
}

async function readExistingPublicAdmission(
  binding: PublicAdmissionBinding,
  deps: PublicAdmissionStoreDeps,
): Promise<"absent" | "matching"> {
  const runPath = path.join(binding.runDir, "run.json");
  const eventsPath = path.join(binding.runDir, "events.jsonl");
  const readOptional = async (filePath: string): Promise<string | null> => {
    try {
      return await deps.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
  const [runRaw, eventsRaw] = await Promise.all([
    readOptional(runPath),
    readOptional(eventsPath),
  ]);
  if (runRaw === null && eventsRaw === null) return "absent";
  if (runRaw === null || eventsRaw === null) {
    throw new Error("partial existing admission artifact");
  }
  verifyPublicAdmissionDocuments(binding, runRaw, eventsRaw);
  return "matching";
}

async function atomicallyPublishAdmissionFile(
  target: string,
  contents: string,
  deps: PublicAdmissionStoreDeps,
): Promise<void> {
  const suffix = randomBytes(8).toString("hex");
  const temp = `${target}.tmp-${process.pid}-${suffix}`;
  await deps.writeFile(temp, contents);
  await deps.fsyncFile(temp);
  await deps.rename(temp, target);
  await deps.fsyncFile(target);
}

function admissionOperationKey(opts: {
  operationKey?: string | null;
  kind: PublicEntrypointKind;
  repo: string;
  domain?: string;
  issue?: number;
}): string {
  const supplied = opts.operationKey?.trim();
  if (supplied) return supplied;
  return [opts.kind, opts.repo, opts.domain?.trim() || opts.repo, opts.issue ?? "none"].join(":");
}

function admissionClaimDigest(operationKey: string): string {
  return createHash("sha256").update(operationKey).digest("hex");
}

function admissionClaimPath(approvedRoot: string, operationKey: string): string {
  const digest = createHash("sha256").update(operationKey).digest("hex");
  return path.join(approvedRoot, ".agent-pipeline", "admissions", `${digest}.json`);
}

function verifyAdmissionClaim(
  claim: PublicAdmissionClaim,
  expected: Omit<PublicAdmissionClaim, "schema_version" | "logical_operation_id" | "claimed_at">,
): void {
  if (claim.schema_version !== PUBLIC_ADMISSION_CLAIM_VERSION) throw new Error("admission claim schema mismatch");
  if (!isLogicalOperationId(claim.logical_operation_id)) throw new Error("admission claim logical identity is invalid");
  for (const [key, value] of Object.entries(expected)) {
    if (claim[key as keyof PublicAdmissionClaim] !== value) {
      throw new Error(`admission claim ${key} mismatch`);
    }
  }
}

async function claimPublicLogicalOperation(input: {
  approvedRoot: string;
  operationKey: string;
  proposedLogicalOperationId: string | null;
  mintLogicalOperationId: () => string;
  onBound: (logicalOperationId: string) => void;
  suppliedLogicalOperationId: string | null;
  kind: PublicEntrypointKind;
  repository: string;
  domain: string;
  issue: number | null;
  claimedAt: string;
  deps: PublicAdmissionStoreDeps;
}): Promise<{ logicalOperationId: string; claimPath: string }> {
  const claimsRoot = path.join(input.approvedRoot, ".agent-pipeline", "admissions");
  const digest = admissionClaimDigest(input.operationKey);
  const claimPath = admissionClaimPath(input.approvedRoot, input.operationKey);
  await input.deps.mkdir(claimsRoot, { recursive: true });
  const expected = {
    operation_key: input.operationKey,
    entrypoint: input.kind,
    repository: input.repository,
    domain: input.domain,
    issue: input.issue,
    approved_root: input.approvedRoot,
  };
  const readClaim = async (filePath: string): Promise<PublicAdmissionClaim | null> => {
    try {
      const claim = JSON.parse(await input.deps.readFile(filePath)) as PublicAdmissionClaim;
      verifyAdmissionClaim(claim, expected);
      return claim;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
  const acceptClaim = async (claim: PublicAdmissionClaim): Promise<{ logicalOperationId: string; claimPath: string }> => {
    if (
      input.suppliedLogicalOperationId &&
      input.suppliedLogicalOperationId !== claim.logical_operation_id
    ) {
      throw new Error("supplied Logical Operation conflicts with immutable admission claim");
    }
    input.onBound(claim.logical_operation_id);
    await input.deps.fsyncFile(claimPath);
    await input.deps.fsyncDirectory(claimsRoot);
    return { logicalOperationId: claim.logical_operation_id, claimPath };
  };

  const published = await readClaim(claimPath);
  if (published) return acceptClaim(published);

  const pendingPrefix = `${digest}.pending-`;
  let pendingPath: string | null = null;
  let claim: PublicAdmissionClaim | null = null;
  const entries = await input.deps.readdir(claimsRoot);
  for (const entry of entries) {
    if (!entry.name.startsWith(pendingPrefix) || !entry.name.endsWith(".json")) continue;
    const candidatePath = path.join(claimsRoot, entry.name);
    try {
      const candidate = await readClaim(candidatePath);
      if (!candidate) continue;
      pendingPath = candidatePath;
      claim = candidate;
      break;
    } catch {
      // An interrupted partial temp is not an exposed claim. A complete
      // sibling temp or a fresh temp may still recover this operation.
    }
  }

  if (!claim || !pendingPath) {
    const logicalOperationId = input.proposedLogicalOperationId ?? input.mintLogicalOperationId();
    if (!isLogicalOperationId(logicalOperationId)) {
      throw new Error("logical operation mint returned an invalid identity");
    }
    input.onBound(logicalOperationId);
    claim = {
      schema_version: PUBLIC_ADMISSION_CLAIM_VERSION,
      ...expected,
      logical_operation_id: logicalOperationId,
      claimed_at: input.claimedAt,
    };
    pendingPath = path.join(
      claimsRoot,
      `${pendingPrefix}${process.pid}-${randomBytes(8).toString("hex")}.json`,
    );
    await input.deps.writeFile(pendingPath, `${JSON.stringify(claim, null, 2)}\n`);
  }
  await input.deps.fsyncFile(pendingPath);
  try {
    await input.deps.link(pendingPath, claimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const winner = await readClaim(claimPath);
  if (!winner) throw new Error("admission claim publication produced no durable winner");
  const accepted = await acceptClaim(winner);
  await input.deps.unlink(pendingPath).catch(() => {});
  return accepted;
}

/**
 * Persist a control-host generic-store run for a public `pipeline single` /
 * `pipeline merge` / `pipeline merge-queue` admission. Uses the existing
 * the existing generic-store schema (no second run store). Protected work may
 * start only after this function returns `acknowledged: true`.
 */
export async function persistPublicEntrypointAdmission(
  opts: {
    repoDir: string;
    kind: PublicEntrypointKind;
    repo: string;
    profile?: string | null;
    issue?: number;
    startedAt?: Date;
    logicalOperationId?: string | null;
    /** Stable identity of the admitted intent across process restarts/retries. */
    operationKey?: string | null;
    /** Direct admissions mint; nested/resume admissions must reuse this id. */
    admissionMode?: "direct" | "nested" | "resume";
    domain?: string;
    runId?: RunId;
    mintLogicalOperationId?: () => string;
    env?: NodeJS.ProcessEnv;
    factoryControlDir?: string | null;
    factoryControlRoot?: string | null;
    /** Executable inventory route that authorizes this strict boundary. */
    route: RequiredAdmissionRouteName;
  },
  deps: PublicAdmissionStoreDeps = defaultPublicAdmissionStoreDeps,
): Promise<PublicAdmissionResult> {
  const expectedBoundary = opts.kind === "train" ? "train-admission" : "public-admission";
  assertRequiredAdmissionRoute(opts.route, opts.kind, expectedBoundary);
  const startedAt = opts.startedAt ?? new Date();
  const runId = opts.runId ?? publicEntrypointRunIdFor(opts.kind, startedAt);
  const suppliedLogicalId = opts.logicalOperationId?.trim() || null;
  const mode = opts.admissionMode ?? "direct";
  const mintLogical = opts.mintLogicalOperationId ?? mintLogicalOperationId;
  const proposedLogicalOperationId = suppliedLogicalId;
  const operationKey = admissionOperationKey(opts);
  let identity: PublicAdmissionIdentity = {
    kind: opts.kind,
    operationKey,
    runId,
    logicalOperationId: proposedLogicalOperationId ?? "",
    repository: opts.repo,
    domain: opts.domain?.trim() || opts.repo,
    issue: opts.issue ?? null,
    startedAt: startedAt.toISOString(),
  };
  if ((mode !== "direct" && !isLogicalOperationId(proposedLogicalOperationId)) || !operationKey) {
    return publicAdmissionFailure(
      identity,
      null,
      null,
      "invalid_binding",
      "bind_identity",
      mode === "direct"
        ? "logical operation mint returned an invalid identity"
        : `${mode} admission requires an existing Logical Operation identity`,
    );
  }
  const persistRoot = await resolvePublicAdmissionPersistRoot({
    repoDir: opts.repoDir,
    env: opts.env,
    factoryControlDir: opts.factoryControlDir,
    factoryControlRoot: opts.factoryControlRoot,
  });
  if (!persistRoot) {
    if (!identity.logicalOperationId && mode === "direct") {
      identity = { ...identity, logicalOperationId: mintLogical() };
    }
    return publicAdmissionFailure(
      identity,
      null,
      null,
      "approved_root_unavailable",
      "resolve_approved_root",
      "approved factory-control root is unavailable",
    );
  }
  const requestedRoot = path.resolve(persistRoot);
  let approvedRoot: string;
  try {
    approvedRoot = await deps.realpath(requestedRoot);
  } catch (err) {
    if (!identity.logicalOperationId && mode === "direct") {
      identity = { ...identity, logicalOperationId: mintLogical() };
    }
    return publicAdmissionFailure(
      identity,
      requestedRoot,
      null,
      "approved_root_unavailable",
      "canonicalize_approved_root",
      err,
    );
  }
  if (approvedRoot !== requestedRoot) {
    if (!identity.logicalOperationId && mode === "direct") {
      identity = { ...identity, logicalOperationId: mintLogical() };
    }
    return publicAdmissionFailure(
      identity,
      approvedRoot,
      null,
      "approved_root_mismatch",
      "verify_approved_root",
      `approved root resolved to ${approvedRoot}, expected ${requestedRoot}`,
    );
  }
  try {
    const claimed = await claimPublicLogicalOperation({
      approvedRoot,
      operationKey,
      proposedLogicalOperationId,
      mintLogicalOperationId: mintLogical,
      onBound: (logicalOperationId) => {
        identity = { ...identity, logicalOperationId };
      },
      suppliedLogicalOperationId: suppliedLogicalId,
      kind: opts.kind,
      repository: identity.repository,
      domain: identity.domain,
      issue: identity.issue,
      claimedAt: identity.startedAt,
      deps,
    });
    identity = { ...identity, logicalOperationId: claimed.logicalOperationId };
  } catch (err) {
    if (!identity.logicalOperationId && mode === "direct") {
      identity = { ...identity, logicalOperationId: mintLogical() };
    }
    const message = boundedAdmissionDiagnostic(err);
    return publicAdmissionFailure(
      identity,
      approvedRoot,
      null,
      /conflict|mismatch/i.test(message) ? "identity_conflict" : "persistence_failure",
      "claim_operation",
      err,
    );
  }
  const logicalOperationId = identity.logicalOperationId;
  const runDir = runDirPath(approvedRoot, runId);
  const stampInput = {
    logical_operation_id: logicalOperationId,
    physical_run_id: runId,
    entrypoint: opts.kind,
    operation_key: operationKey,
    repository: identity.repository,
    domain: identity.domain,
    issue: identity.issue,
    approved_root: approvedRoot,
    started_at: identity.startedAt,
  };
  const stamp: PublicAdmissionStamp = {
    schema_version: PUBLIC_ADMISSION_STAMP_VERSION,
    ...stampInput,
    binding_sha256: publicAdmissionBindingDigest(stampInput),
  };
  const binding: PublicAdmissionBinding = { ...identity, approvedRoot, runDir, stamp };
  const meta: RunMeta = {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: runId,
    logical_operation_id: logicalOperationId,
    kind: opts.kind,
    ...(identity.issue !== null ? { issue: identity.issue } : {}),
    repo: identity.repository,
    profile: opts.profile ?? null,
    started_at: identity.startedAt,
    discovery_channel: "live-run",
    admission_stamp: stamp,
  };
  const event: RunStartEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "run_start",
    at: identity.startedAt,
    run_id: runId,
    logical_operation_id: logicalOperationId,
    entrypoint: opts.kind,
    repo: identity.repository,
    ...(identity.issue !== null ? { issue: identity.issue } : {}),
    admission_stamp: stamp,
  };
  const parentRunsDir = runsDir(approvedRoot);
  let createdRunDir = false;
  try {
    await deps.mkdir(parentRunsDir, { recursive: true });
    try {
      await deps.mkdir(runDir, { recursive: false });
      createdRunDir = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (!createdRunDir) {
      const existing = await readExistingPublicAdmission(binding, deps);
      if (existing === "matching") return { acknowledged: true, ...binding, binding };
      throw new Error("existing admission run directory has no complete stamp");
    }
    await atomicallyPublishAdmissionFile(
      path.join(runDir, "run.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
      deps,
    );
    await atomicallyPublishAdmissionFile(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      deps,
    );
    await deps.fsyncDirectory(runDir);
    await deps.fsyncDirectory(parentRunsDir);
  } catch (err) {
    const message = boundedAdmissionDiagnostic(err);
    return publicAdmissionFailure(
      identity,
      approvedRoot,
      runDir,
      !createdRunDir || /existing admission|mismatch|partial/i.test(message)
        ? "identity_conflict"
        : "persistence_failure",
      createdRunDir ? "publish_stamp" : "verify_existing",
      err,
    );
  }
  try {
    const [runRaw, eventsRaw] = await Promise.all([
      deps.readFile(path.join(runDir, "run.json")),
      deps.readFile(path.join(runDir, "events.jsonl")),
    ]);
    verifyPublicAdmissionDocuments(binding, runRaw, eventsRaw);
  } catch (err) {
    const message = boundedAdmissionDiagnostic(err);
    const kind = message.includes("mismatch") ? "identity_conflict" : "verification_failure";
    return publicAdmissionFailure(identity, approvedRoot, runDir, kind, "read_back", err);
  }
  return { acknowledged: true, ...binding, binding };
}

/** Resolve the engine identity a dispatch should pin, respecting `initRunDir`'s
 *  written-once contract (#450): when `runDir/run.json` already exists (a
 *  resumed dispatch re-entering the same run-id), reuse the identity already
 *  recorded there rather than re-resolving the current on-disk identity —
 *  `initRunDir` will not overwrite an existing run.json, so a freshly-resolved
 *  identity would silently diverge from what was actually written and suppress
 *  drift detection against the original pin. `resolveFresh` is only invoked
 *  when no run.json exists yet (first init for this run-id). */
export async function resolveRunEngineIdentity(
  runDir: string,
  resolveFresh: () => RunEngineIdentity | undefined,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEngineIdentity | undefined> {
  try {
    const raw = await deps.readFile(path.join(runDir, "run.json"));
    const meta = JSON.parse(raw) as { engine?: RunEngineIdentity };
    return meta.engine;
  } catch {
    return resolveFresh();
  }
}

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

export interface AppendEventOptions {
  /**
   * Override criticality classification. Defaults from `event.type` via
   * {@link eventCriticalityForType} (blocker/recovery/terminal → control-critical).
   */
  criticality?: EventCriticality;
}

/** Append a JSON event line to events.jsonl. Non-fatal on I/O error.
 *  If deps.stdoutWrite is set, also passes the line there (--json-events mode).
 *  If deps.eventSink is set (#343), also delivers the line to it: in "additive"
 *  mode (default) alongside the local write; in "exclusive" mode the local
 *  write is skipped on successful sink delivery, and on sink failure the engine
 *  falls back to a local `events.jsonl` write (#633). Sink / local failures are
 *  caught, logged as non-fatal warnings, recorded in write-health, and never
 *  throw out of here. */
/** Returns whether the event was durably delivered (local write, exclusive-mode
 *  sink delivery, or exclusive-mode local fallback) — non-fatal callers may
 *  ignore the result; a caller that must not report success on a silent failure
 *  (e.g. the `correction record` CLI) can check it. */
export async function appendEvent(
  runDir: string,
  event: RunEvent,
  deps: RunStoreDeps = defaultRunStoreDeps,
  opts: AppendEventOptions = {},
): Promise<boolean> {
  const criticality = opts.criticality ?? eventCriticalityForType(event.type);
  const line = `${JSON.stringify(event)}\n`;
  const eventsPath = path.join(runDir, "events.jsonl");
  const hasSink = deps.eventSink !== undefined;
  const exclusive = hasSink && deps.eventSinkMode === "exclusive";

  if (deps.summaryEvents) {
    deps.summaryEvents.push(event);
  }

  const recordFailure = async (
    error: string,
    flags: {
      exclusiveFallbackAttempted?: boolean;
      exclusiveFallbackSucceeded?: boolean;
    } = {},
  ): Promise<void> => {
    await recordWriteHealthFailure(
      runDir,
      {
        eventType: event.type,
        criticality,
        error,
        exclusiveFallbackAttempted: flags.exclusiveFallbackAttempted,
        exclusiveFallbackSucceeded: flags.exclusiveFallbackSucceeded,
      },
      deps,
    );
  };

  const tryLocalAppend = async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await deps.appendFile(eventsPath, line);
      if (deps.fsyncFile) {
        try {
          await deps.fsyncFile(eventsPath);
        } catch (fsyncErr) {
          const msg = `fsync failed: ${(fsyncErr as Error).message}`;
          console.warn(`[pipeline] run-store: appendEvent fsync failed (non-fatal): ${msg}`);
          return { ok: false, error: msg };
        }
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[pipeline] run-store: appendEvent failed (non-fatal): ${msg}`);
      return { ok: false, error: msg };
    }
  };

  // --- exclusive mode: sink first; local only on sink failure (#633) ---
  if (exclusive) {
    // Track failure with a boolean — never use error-message truthiness as the
    // sentinel (empty message / non-Error rejections must still fall back).
    let sinkFailed = false;
    let sinkError = "";
    try {
      await deps.eventSink!(line);
    } catch (err) {
      sinkFailed = true;
      sinkError = describeSinkDeliveryError(err);
      console.warn(
        `[pipeline] run-store: eventSink delivery failed (non-fatal): ${sinkError}`,
      );
    }

    if (deps.stdoutWrite) {
      deps.stdoutWrite(line);
    }

    if (!sinkFailed) {
      return true; // exclusive happy path: sink-only, no local write
    }

    // Local fallback after exclusive sink failure.
    const local = await tryLocalAppend();
    await recordFailure(
      local.ok
        ? `exclusive sink failed (local fallback ok): ${sinkError}`
        : `exclusive sink and local fallback failed: sink=${sinkError}; local=${local.error ?? "unknown"}`,
      {
        exclusiveFallbackAttempted: true,
        exclusiveFallbackSucceeded: local.ok,
      },
    );
    return local.ok;
  }

  // --- additive / no-sink: local first, then optional sink ---
  const local = await tryLocalAppend();

  if (!local.ok && !hasSink) {
    // No durable destination remaining — do not claim the event on --json-events
    // stdout either (regression: local-only I/O failure must not emit the line).
    await recordFailure(local.error ?? "local events.jsonl append failed");
    return false;
  }

  if (deps.stdoutWrite) {
    deps.stdoutWrite(line);
  }

  let sinkFailed = false;
  let sinkError = "";
  if (hasSink) {
    try {
      await deps.eventSink!(line);
    } catch (err) {
      sinkFailed = true;
      sinkError = describeSinkDeliveryError(err);
      console.warn(
        `[pipeline] run-store: eventSink delivery failed (non-fatal): ${sinkError}`,
      );
    }
  }

  if (!local.ok) {
    await recordFailure(local.error ?? "local events.jsonl append failed");
    return false;
  }
  if (sinkFailed) {
    // Local succeeded; still surface sink loss in write-health.
    await recordFailure(`event sink delivery failed: ${sinkError}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// readEvents
// ---------------------------------------------------------------------------

/** Read events.jsonl: missing file → []; corrupt or partial tail line → skipped;
 *  unknown fields → preserved unchanged (forward-compat). */
export async function readEvents(
  runDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await deps.readFile(path.join(runDir, "events.jsonl"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as RunEvent);
    } catch {
      // Partial or corrupt line (e.g. from a mid-write crash) — skip silently
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// emitGhMetrics
// ---------------------------------------------------------------------------

/** Append a gh_metrics_summary event to events.jsonl. Non-fatal on I/O error. */
export async function emitGhMetrics(
  runDir: string,
  summary: GhMetricsSummary,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const event: GhMetricsSummaryEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "gh_metrics_summary",
    at: nowIso(),
    call_count: summary.call_count,
    total_ms: summary.total_ms,
    p50_ms: summary.p50_ms,
    p95_ms: summary.p95_ms,
    slowest_calls: summary.slowest_calls,
    by_wrapper: summary.by_wrapper ?? {},
  };
  try {
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: emitGhMetrics failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// emitStageAccounting
// ---------------------------------------------------------------------------

/** Append a sanitized stage_accounting event to events.jsonl. Non-fatal on I/O
 *  error and streams via appendEvent's existing --json-events path. */
export async function emitStageAccounting(
  runDir: string,
  record: StageAccountingRecord,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const event: StageAccountingEvent = {
    ...sanitizeStageAccountingRecord(record),
    type: "stage_accounting",
    at: nowIso(),
  };
  try {
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: emitStageAccounting failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// emitPapercut (#419)
// ---------------------------------------------------------------------------

/** Append a `papercut` event to events.jsonl via the standard `appendEvent`
 *  path (so it gets redaction + external event-sink delivery for free, on
 *  identical terms to `blocker_set`/`human_intervention`). Total function:
 *  never throws — any failure (including a thrown/rejecting `appendEvent`) is
 *  caught and logged as a non-fatal warning, mirroring `emitHumanIntervention`. */
export async function emitPapercut(
  runDir: string,
  payload: {
    run_id: RunId;
    issue: number;
    stage: string | null;
    harness: string | null;
    model: string | null;
    message: string;
  },
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    const event: PapercutEvent = {
      schema_version: RUN_SCHEMA_VERSION,
      type: "papercut",
      at: nowIso(),
      run_id: payload.run_id,
      issue: payload.issue,
      stage: payload.stage,
      harness: payload.harness,
      model: payload.model,
      message: sanitize(redactSecrets(payload.message)),
    };
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: emitPapercut failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// appendIssueHistory (#377)
// ---------------------------------------------------------------------------

/** Append one compact per-run entry to the issue-level evidence history JSONL
 *  at `.agent-pipeline/history/issue-<N>.jsonl` (create-on-first-write). Entries
 *  are serialized through the same `sanitizeDeep` + `redactSecrets` + `sanitize`
 *  chain used for `summary.json`, so no secret reaches the artifact. Non-fatal:
 *  an append error is caught, logged, and never propagates — resumed pipelines
 *  must not fail because a history write failed. */
export async function appendIssueHistory(
  repoDir: string,
  issue: number,
  entry: IssueHistoryEntry,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    const cleanedEntry = sanitizeDeep(entry);
    const line = sanitize(redactSecrets(`${JSON.stringify(cleanedEntry)}\n`));
    await deps.mkdir(issueHistoryDir(repoDir), { recursive: true });
    await deps.appendFile(issueHistoryPath(repoDir, issue), line);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: issue history append failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Trusted-surface decision persistence (#691)
// ---------------------------------------------------------------------------

/** Absolute path of the durable trusted-surface decision for a run. */
export function trustedSurfacePath(runDir: string): string {
  return path.join(runDir, TRUSTED_SURFACE_FILE);
}

/**
 * Persist the trusted-surface decision for the run (atomic tmp + rename).
 * **Fatal on I/O error** for current runs — callers must fail closed rather
 * than advance readiness without a durable decision (#691 review).
 * Callers recompute on product candidate SHA advance.
 */
export async function writeTrustedSurfaceDecision(
  runDir: string,
  decision: TrustedSurfaceDecision,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  await deps.mkdir(runDir, { recursive: true });
  const finalPath = trustedSurfacePath(runDir);
  const tmp = `${finalPath}.tmp`;
  const cleaned = sanitizeDeep(stampTrustedSurfaceDecision(decision));
  const serialized = sanitize(redactSecrets(`${JSON.stringify(cleaned, null, 2)}\n`));
  await deps.writeFile(tmp, serialized);
  await deps.rename(tmp, finalPath);
}

/**
 * Persist and read back the decision. Throws when write or readback fails or
 * when the stored outcome/hash does not match (fail closed).
 */
export async function persistTrustedSurfaceDecision(
  runDir: string,
  decision: TrustedSurfaceDecision,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<TrustedSurfaceDecision> {
  await writeTrustedSurfaceDecision(runDir, decision, deps);
  const readBack = await readTrustedSurfaceDecision(runDir, deps);
  if (!readBack) {
    throw new Error(
      "trusted-surface decision write succeeded but readback returned null/malformed",
    );
  }
  if (readBack.outcome !== decision.outcome) {
    throw new Error(
      `trusted-surface decision readback outcome mismatch: wrote ${decision.outcome}, read ${readBack.outcome}`,
    );
  }
  if (readBack.effective_verifier_hash !== decision.effective_verifier_hash) {
    throw new Error(
      "trusted-surface decision readback effective_verifier_hash mismatch",
    );
  }
  return readBack;
}

/**
 * Load the durable trusted-surface decision, or null when absent/malformed.
 * Does not invent passthrough for historical omission.
 */
export async function readTrustedSurfaceDecision(
  runDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<TrustedSurfaceDecision | null> {
  try {
    const raw = await deps.readFile(trustedSurfacePath(runDir));
    return parseTrustedSurfaceDecision(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Path for mid-run verifier-identity invalidation marker (#691).
 * Presence means readiness evidence bound to previous_hash is non-current.
 */
export function trustedSurfaceInvalidationPath(runDir: string): string {
  return path.join(runDir, "trusted-surface-invalidation.json");
}

export interface TrustedSurfaceInvalidation {
  at: string;
  stage: string;
  previous_hash: string | null;
  next_hash: string | null;
  reason: string;
}

/** Persist a verifier-drift invalidation record (atomic). Throws on I/O failure. */
export async function writeTrustedSurfaceInvalidation(
  runDir: string,
  record: TrustedSurfaceInvalidation,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  await deps.mkdir(runDir, { recursive: true });
  const finalPath = trustedSurfaceInvalidationPath(runDir);
  const tmp = `${finalPath}.tmp`;
  const serialized = sanitize(redactSecrets(`${JSON.stringify(sanitizeDeep(record), null, 2)}\n`));
  await deps.writeFile(tmp, serialized);
  await deps.rename(tmp, finalPath);
}

export async function readTrustedSurfaceInvalidation(
  runDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<TrustedSurfaceInvalidation | null> {
  try {
    const raw = await deps.readFile(trustedSurfaceInvalidationPath(runDir));
    const o = JSON.parse(raw) as TrustedSurfaceInvalidation;
    if (!o || typeof o !== "object") return null;
    if (typeof o.at !== "string" || typeof o.stage !== "string") return null;
    return o;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// finalizeRun
// ---------------------------------------------------------------------------

/** Finalize the run: append gh_metrics_summary + run_complete, write summary.json, write legacy evidence.json.
 *  summary.json and legacy write are atomic (tmp + rename). Legacy write failure is non-fatal. */
export async function finalizeRun(
  runDir: string,
  bundle: EvidenceBundle,
  stateDir: string,
  issue: number,
  startedAt: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
  ghMetrics?: GhMetricsSummary,
  stopReason?: RunCompleteStopReason,
): Promise<void> {
  const now = nowIso();
  const startMs = Date.parse(startedAt);
  const elapsedMs = Number.isFinite(startMs) ? Date.parse(now) - startMs : 0;

  // Append gh_metrics_summary before run_complete (#257)
  if (ghMetrics) {
    await emitGhMetrics(runDir, ghMetrics, deps);
  }

  // Append run_complete before writing summary.json
  const completeEvent: RunCompleteEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "run_complete",
    at: now,
    final_state: bundle.finalState ?? "unknown",
    elapsed_ms: elapsedMs,
    ...(stopReason ? { stop_reason: stopReason } : {}),
  };
  await appendEvent(runDir, completeEvent, deps);

  // Collect event-derived records to embed in summary.json. When the caller
  // supplies deps.summaryEvents (#343), use that in-memory accumulator so
  // exclusive sink mode — which never writes events.jsonl — still enriches
  // summary.json; otherwise fall back to re-reading events.jsonl. Non-fatal:
  // if the read fails, arrays stay empty.
  let interventions: HumanInterventionEvent[] = [];
  let accountingRecords: StageAccountingRecord[] = [];
  let deltaRoundEvents: DeltaRoundEvent[] = [];
  let deltaCeilingEvents: DeltaRoundCeilingEvent[] = [];
  let deltaChurnEvents: DeltaChurnSuspectedEvent[] = [];
  let corrections: CorrectionEvent[] = [];
  // Malformed/unknown-schema_version correction_event records are surfaced
  // here, not silently dropped: validateCorrectionEvent() partitions the raw
  // records into valid events (embedded in `corrections`) and visible error
  // strings (embedded in `correctionErrors`) — neither path throws or aborts
  // the run.
  let correctionErrors: string[] = [];
  const partitionCorrections = (raw: unknown[]): void => {
    for (const r of raw) {
      const result = validateCorrectionEvent(r);
      if (result.ok) corrections.push(result.event);
      else correctionErrors.push(result.error);
    }
  };
  if (deps.summaryEvents) {
    interventions = deps.summaryEvents.filter(
      (e): e is HumanInterventionEvent => e.type === "human_intervention",
    );
    accountingRecords = deps.summaryEvents
      .filter((e): e is StageAccountingEvent => e.type === "stage_accounting")
      .map((e) => sanitizeStageAccountingRecord(e));
    deltaRoundEvents = deps.summaryEvents.filter((e): e is DeltaRoundEvent => e.type === "delta_round");
    deltaCeilingEvents = deps.summaryEvents.filter((e): e is DeltaRoundCeilingEvent => e.type === "delta_round_ceiling");
    deltaChurnEvents = deps.summaryEvents.filter((e): e is DeltaChurnSuspectedEvent => e.type === "delta_churn_suspected");
    partitionCorrections(deps.summaryEvents.filter((e) => e.type === "correction_event"));
  } else {
    try {
      const eventsForSummary = await readEvents(runDir, deps);
      interventions = eventsForSummary.filter(
        (e): e is HumanInterventionEvent => e.type === "human_intervention",
      );
      accountingRecords = eventsForSummary
        .filter((e): e is StageAccountingEvent => e.type === "stage_accounting")
        .map((e) => sanitizeStageAccountingRecord(e));
      deltaRoundEvents = eventsForSummary.filter((e): e is DeltaRoundEvent => e.type === "delta_round");
      deltaCeilingEvents = eventsForSummary.filter((e): e is DeltaRoundCeilingEvent => e.type === "delta_round_ceiling");
      deltaChurnEvents = eventsForSummary.filter((e): e is DeltaChurnSuspectedEvent => e.type === "delta_churn_suspected");
      partitionCorrections(eventsForSummary.filter((e) => e.type === "correction_event"));
    } catch {
      // Non-fatal: missing or unreadable events.jsonl → empty arrays
    }
  }
  if (deltaRoundEvents.length > 0 || deltaCeilingEvents.length > 0) {
    const lastRound = deltaRoundEvents[deltaRoundEvents.length - 1];
    const lastCeiling = deltaCeilingEvents[deltaCeilingEvents.length - 1];
    bundle.deltaRounds = {
      count: lastRound?.round ?? lastCeiling?.observed ?? 0,
      cap: lastRound?.cap ?? lastCeiling?.cap ?? 0,
      ceiling: lastCeiling
        ? { observed: lastCeiling.observed, ceilingAction: lastCeiling.ceiling_action }
        : undefined,
      churnRounds: deltaChurnEvents.map((e) => ({
        round: e.round,
        axes: e.axes.map((a) => ({
          surface: a.surface, priorMaxConfidence: a.prior_max_confidence, newConfidence: a.new_confidence,
        })),
      })),
    };
  }

  // Serialize bundle — same sanitization as evidence-bundle.ts writeBundle.
  // run_id is the filesystem-safe directory name so consumers can join summary.json
  // to the run directory by a single stable identifier (the bundle's runId field
  // uses the commit-trailer format 155/..., which differs from the dir name 155-...).
  const fileRunId = path.basename(runDir);
  let logicalOperationId: string | undefined;
  try {
    const rawMeta = await deps.readFile(path.join(runDir, "run.json"));
    const meta = JSON.parse(rawMeta) as { logical_operation_id?: unknown };
    if (typeof meta.logical_operation_id === "string" && meta.logical_operation_id.trim()) {
      logicalOperationId = meta.logical_operation_id.trim();
    }
  } catch {
    // Historical or missing run.json — omit the field (missing correlation).
  }
  // Mutate the caller's bundle (not just the summary.json copy) so the harness
  // invocation durations reach `notifyBundlePath`, called right after
  // `finalizeRun` resolves with this same object reference, without a second
  // events.jsonl read (#377).
  bundle.accounting = accountingSummary(accountingRecords);
  // Event-stream write-health (#633): always embed so a green finalState cannot
  // hide truncated/empty audit. Absent on-disk health → explicit healthy record.
  const writeHealth =
    (await readWriteHealth(runDir, deps)) ?? { ...HEALTHY_WRITE_HEALTH };
  (bundle as EvidenceBundle & { write_health?: WriteHealthRecord }).write_health = writeHealth;

  // evidence_subject diagnostics (#692): compare readiness artifacts to the
  // best-known evaluation pin. Never invents subjects — only compares what
  // producers wrote. Optional tester-evidence.json subject is loaded best-effort.
  let testerSubject: unknown = undefined;
  let includeTesterRow = false;
  try {
    const tePath = path.join(runDir, "tester-evidence.json");
    const teRaw = await deps.readFile(tePath);
    const teParsed = JSON.parse(teRaw) as { evidence_subject?: unknown };
    includeTesterRow = true;
    testerSubject = teParsed.evidence_subject;
  } catch {
    // Missing or unreadable tester evidence — omit tester row unless we want
    // legacy labeling; only include when the file existed. Absent file → no row.
  }
  const diagnosticArts = collectDiagnosticArtifactsFromBundle({
    reviews: bundle.reviews,
    overrides: bundle.overrides,
    corrections,
    tester_evidence_subject: testerSubject,
    include_tester_row: includeTesterRow,
  });
  // Authoritative pin only — never select from the artifacts being validated
  // (that would label a co-stale set as match after product HEAD advanced).
  const pin =
    deps.evaluationPinSubject === undefined
      ? null
      : deps.evaluationPinSubject;
  const evidenceSubjectDiagnostics = buildEvidenceSubjectDiagnostics(
    pin,
    diagnosticArts,
  );
  (bundle as EvidenceBundle).evidence_subject_diagnostics =
    evidenceSubjectDiagnostics;

  // Trusted-surface decision (#691): embed when computed; never invent passthrough
  // for historical runs that lack the durable artifact.
  const trustedSurface =
    bundle.trusted_surface ??
    (await readTrustedSurfaceDecision(runDir, deps));
  if (trustedSurface) {
    (bundle as EvidenceBundle).trusted_surface = trustedSurface;
  }

  const summaryWithVersion = {
    ...bundle,
    schema_version: RUN_SCHEMA_VERSION,
    run_id: fileRunId,
    ...(logicalOperationId ? { logical_operation_id: logicalOperationId } : {}),
    interventions,
    corrections,
    correctionErrors,
    write_health: writeHealth,
    evidence_subject_diagnostics: evidenceSubjectDiagnostics,
    ...(trustedSurface ? { trusted_surface: trustedSurface } : {}),
  };
  const cleanedBundle = sanitizeDeep(summaryWithVersion);
  const serialized = sanitize(redactSecrets(`${JSON.stringify(cleanedBundle, null, 2)}\n`));

  // Write summary.json atomically
  const summaryPath = path.join(runDir, "summary.json");
  try {
    const tmp = `${summaryPath}.tmp`;
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, summaryPath);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: summary.json write failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Write legacy evidence.json (non-fatal; keeps existing consumers working)
  const legacyDir = path.join(stateDir, String(issue));
  const legacyPath = path.join(legacyDir, "evidence.json");
  try {
    await deps.mkdir(legacyDir, { recursive: true });
    const tmp = `${legacyPath}.tmp`;
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, legacyPath);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: legacy evidence.json write failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Append-only issue-level evidence history (#377): one compact per-run entry,
  // appended (never rewritten) after summary.json/evidence.json, so a re-run
  // never erases prior rounds' timing history. appendIssueHistory is itself
  // non-fatal on I/O error.
  const historyEntry: IssueHistoryEntry = {
    schema_version: ISSUE_HISTORY_SCHEMA_VERSION,
    run_id: fileRunId,
    issue,
    pr: bundle.pr,
    branch: bundle.branch,
    final_state: bundle.finalState,
    finalized_at: bundle.finalizedAt,
    stages: bundle.stages.map((s) => ({
      stage: s.stage,
      enteredAt: s.enteredAt,
      exitedAt: s.exitedAt,
      durationMs: stageDurationMs(s.enteredAt, s.exitedAt),
      outcome: s.outcome,
    })),
  };
  await appendIssueHistory(repoDirFromRunDir(runDir), issue, historyEntry, deps);
}

// ---------------------------------------------------------------------------
// listRunIds — for `pipeline logs` (no-arg form)
// ---------------------------------------------------------------------------

/** List run-ids available in .agent-pipeline/runs/, sorted by mtime descending.
 *  Returns [] when the directory is absent or empty. */
export async function listRunIds(
  repoDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<string[]> {
  const dir = runsDir(repoDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const withMtime = await Promise.all(
    dirs.map(async (e) => {
      try {
        const st = await deps.stat(path.join(dir, e.name));
        return { name: e.name, mtime: st.mtime.getTime() };
      } catch {
        return { name: e.name, mtime: 0 };
      }
    }),
  );

  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((e) => e.name);
}

// ---------------------------------------------------------------------------
// latestRunDirForIssue — locate the current run directory for a
// Pipeline-owned correction_event emission point (#499), host-locally.
// ---------------------------------------------------------------------------

/** Return the absolute path of the most-recent run directory for `issueNumber`
 *  (by run-id prefix, already sorted by mtime descending by `listRunIds`), or
 *  `null` when no matching run directory exists. */
export async function latestRunDirForIssue(
  repoDir: string,
  issueNumber: number,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<string | null> {
  const allIds = await listRunIds(repoDir, deps);
  const prefix = `${issueNumber}-`;
  const matchId = allIds.find((rid) => rid.startsWith(prefix));
  return matchId ? runDirPath(repoDir, matchId) : null;
}

// ---------------------------------------------------------------------------
// latestSummaryForIssue — for `pipeline N --summary` run-directory-first read
// ---------------------------------------------------------------------------

/** Minimal runtime check for the EvidenceBundle shape required by formatSummary.
 *  Returns false if the value is not an object, any required array field is absent,
 *  or any nested stage/review entry is missing the fields that formatSummary accesses
 *  directly (stage.stage, stage.commands, review.sha, review.verdict, review.round,
 *  review.findingCounts).  Used to treat missing-required-fields summaries as absent
 *  for fallback purposes (spec §261). */
export function isValidSummaryBundle(parsed: unknown): parsed is EvidenceBundle {
  if (!parsed || typeof parsed !== "object") return false;
  const b = parsed as Record<string, unknown>;
  if (
    !Array.isArray(b.harnesses) ||
    !Array.isArray(b.stages) ||
    !Array.isArray(b.reviews) ||
    !Array.isArray(b.overrides) ||
    !Array.isArray(b.recoveries)
  ) return false;
  for (const s of b.stages as unknown[]) {
    if (!s || typeof s !== "object") return false;
    const sr = s as Record<string, unknown>;
    if (typeof sr.stage !== "string" || !Array.isArray(sr.commands)) return false;
    // formatSummary dereferences each command's cmd/exitCode/durationMs; a malformed
    // element (e.g. null, or missing fields) would crash the formatter, so a bundle with
    // any such command must be treated as absent for fallback (not a valid bundle).
    for (const c of sr.commands as unknown[]) {
      if (!c || typeof c !== "object") return false;
      const cr = c as Record<string, unknown>;
      if (typeof cr.cmd !== "string" || typeof cr.exitCode !== "number" || typeof cr.durationMs !== "number") return false;
    }
  }
  for (const r of b.reviews as unknown[]) {
    if (!r || typeof r !== "object") return false;
    const rr = r as Record<string, unknown>;
    if (
      typeof rr.sha !== "string" ||
      typeof rr.verdict !== "string" ||
      typeof rr.round !== "number" ||
      !rr.findingCounts ||
      typeof rr.findingCounts !== "object"
    ) return false;
  }
  // formatSummary also dereferences each override (o.key / o.reason) and recovery
  // (rec.trigger / rec.round / rec.at); validate those element shapes too.
  for (const o of b.overrides as unknown[]) {
    if (!o || typeof o !== "object") return false;
    const or = o as Record<string, unknown>;
    if (typeof or.key !== "string" || typeof or.reason !== "string") return false;
  }
  for (const rec of b.recoveries as unknown[]) {
    if (!rec || typeof rec !== "object") return false;
    const rr = rec as Record<string, unknown>;
    if (typeof rr.trigger !== "string" || typeof rr.round !== "number" || typeof rr.at !== "string") return false;
  }
  return true;
}

/** Return the EvidenceBundle from the most-recent `summary.json` for the given
 *  issue number, or `null` when none is found.
 *
 *  Scans all run directories whose run-id begins with `<issueNumber>-` (already
 *  sorted by mtime descending by `listRunIds`), reads `summary.json` from the
 *  first readable match, and parses it.  A missing file, unreadable file,
 *  corrupt JSON, or a file missing required fields is treated as absent and the
 *  next candidate is tried (so a single bad entry does not shadow a valid older run). */
export async function latestSummaryForIssue(
  repoDir: string,
  issueNumber: number,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<EvidenceBundle | null> {
  const allIds = await listRunIds(repoDir, deps);
  const prefix = `${issueNumber}-`;
  for (const id of allIds.filter((rid) => rid.startsWith(prefix))) {
    const summaryPath = path.join(runDirPath(repoDir, id), "summary.json");
    try {
      const raw = await deps.readFile(summaryPath);
      const parsed = JSON.parse(raw);
      if (isValidSummaryBundle(parsed)) return parsed;
    } catch {
      // Absent or corrupt — try next matching run
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// latestRunEventsSummaryForIssue — for the `possibly_wedged` status flag (#398)
// ---------------------------------------------------------------------------

export interface RunEventsSummary {
  /** True when events.jsonl contains a `run_complete` event. */
  finalized: boolean;
  /** The newest event's type/timestamp, or null when events.jsonl is empty. */
  lastEvent: { type: string; at: string } | null;
  /**
   * Event-stream write-health for this run (#633). Null when no write-health
   * artifact exists (legacy run or never written). Elevated when failure_count > 0.
   */
  writeHealth: WriteHealthRecord | null;
}

/** Return a finalized/last-event summary of the most-recent run's events.jsonl
 *  for the given issue, or null when no run directory exists for it. Unlike
 *  `latestSummaryForIssue`, this reads events.jsonl directly rather than
 *  summary.json, so a run that has not reached `finalizeRun` yet (including a
 *  wedged one) can still be inspected. Non-fatal: an unreadable events.jsonl is
 *  treated as absent. Also loads write-health.json for status surfaces (#633). */
export async function latestRunEventsSummaryForIssue(
  repoDir: string,
  issueNumber: number,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEventsSummary | null> {
  const allIds = await listRunIds(repoDir, deps);
  const prefix = `${issueNumber}-`;
  const matchId = allIds.find((rid) => rid.startsWith(prefix));
  if (!matchId) return null;
  const dir = runDirPath(repoDir, matchId);
  const writeHealth = await readWriteHealth(dir, deps);
  try {
    const events = await readEvents(dir, deps);
    if (events.length === 0) {
      return { finalized: false, lastEvent: null, writeHealth };
    }
    const finalized = events.some((e) => e.type === "run_complete");
    const last = events[events.length - 1];
    return {
      finalized,
      lastEvent: { type: last.type, at: last.at },
      writeHealth,
    };
  } catch {
    // Unreadable events still expose write-health when present.
    return { finalized: false, lastEvent: null, writeHealth };
  }
}

// ---------------------------------------------------------------------------
// Terminal log tee — patches process.stdout/stderr to mirror output to a file.
// Separate from the injectable deps pattern: this operates on global process state.
// ---------------------------------------------------------------------------

export interface TerminalLogTee {
  /** Write directly to the original stdout, bypassing terminal.log.
   *  Used by --json-events mode so JSON event lines are not captured in terminal.log. */
  rawWrite: (chunk: string) => void;
  /** Restore the original write functions and close the log stream. */
  stop(): Promise<void>;
}

/** Start a tee that mirrors process.stdout and process.stderr to terminal.log at logPath.
 *  Returns a handle with rawWrite (for --json-events bypass) and stop().
 *  The logPath directory must exist before calling this function. */
export function startTerminalLogTee(logPath: string): TerminalLogTee {
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  // Save originals before patching
  const origStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const origStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;

  // teeActive gates every write to logStream. The error handler flips it to false
  // and restores the original writes so a log-stream failure is non-fatal and does
  // not crash the pipeline via an unhandled 'error' event on the WriteStream.
  let teeActive = true;

  logStream.on("error", (err) => {
    if (!teeActive) return;
    teeActive = false;
    console.warn(`[pipeline] run-store: terminal.log stream error (non-fatal): ${err.message}`);
    (process.stdout as { write: typeof origStdoutWrite }).write = origStdoutWrite;
    (process.stderr as { write: typeof origStderrWrite }).write = origStderrWrite;
  });

  function makePatch(
    orig: typeof origStdoutWrite,
  ): typeof origStdoutWrite {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (...args: any[]): boolean {
      const [chunk, enc] = args;
      if (teeActive) {
        if (typeof chunk === "string") {
          logStream.write(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8");
        } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
          logStream.write(chunk as Buffer);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return (orig as (...a: any[]) => boolean)(...args);
    } as typeof origStdoutWrite;
  }

  (process.stdout as { write: typeof origStdoutWrite }).write = makePatch(origStdoutWrite);
  (process.stderr as { write: typeof origStderrWrite }).write = makePatch(origStderrWrite);

  return {
    rawWrite(chunk: string): void {
      origStdoutWrite(chunk);
    },
    stop(): Promise<void> {
      teeActive = false;
      (process.stdout as { write: typeof origStdoutWrite }).write = origStdoutWrite;
      (process.stderr as { write: typeof origStderrWrite }).write = origStderrWrite;
      return new Promise<void>((resolve) => {
        logStream.end(() => resolve());
      });
    },
  };
}
