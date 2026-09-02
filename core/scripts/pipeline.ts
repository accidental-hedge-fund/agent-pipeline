#!/usr/bin/env node
// Top-level orchestrator. Three modes:
//
//   pipeline N                            advance loop (default)
//   pipeline N --status                   read-only status
//   pipeline N --unblock "<answer>"       post answer + clear blocked label
//
// Auto-detects whether N is an issue or PR via the REST API. PRs without
// a `closingIssuesReferences` link are refused (the pipeline is issue-centric).
//
// Per-domain config from `.github/pipeline.yml` (resolved by config.ts) and
// the user's repo cwd. Mutex is per-issue (lock.ts at
// /tmp/pipeline-{domain}-{N}.lock) so multiple pipeline runs on different
// issues coexist.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { writeFileSync, readFileSync, realpathSync, existsSync, promises as fsPromises } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { Command, Option } from "commander";
import { resolveConfig, resolveReleaseConfig, resolveLoopNativeGoalAttestation, scaffoldDefaultConfig, findGitRoot, generateConfigSchema, validateConfig, syncConfig, repoMapAdd, repoMapRemove, repoMapList, type RepoMapRelation } from "./config.ts";
import { ensureArtifactIgnoreBlock } from "./artifact-ignore.ts";
import { spawnDetached } from "./detach.ts";
import { productionRestoreDeadDetached } from "./liveness-cli.ts";
import { discoverHosts, formatDiscovery } from "./discovery.ts";
import {
  addLabel,
  buildAuditSentinel,
  clearBlocked,
  ensurePipelineLabels,
  getGhActor,
  getIssueDetail,
  getIssueLabelEvents,
  getItemKind,
  getLatestBlockedLabeledAt,
  getPrDetail,
  getPrForIssue,
  getPrLinkedIssue,
  isBlocked,
  lastBlockerKindFromComments,
  pickStage,
  postComment,
  silentTransition,
  transition,
} from "./gh.ts";
import { PipelineLock, isKillSwitchActive, isLivePlanningActive, tryAcquireLivePlanningMarker, runStateDir, withLock } from "./lock.ts";
import { reportMechanicalFault, type ReportOperationObservation } from "./operation-observation.ts";
import { fulfillTypedRequestAndValidateResume } from "./typed-request-resume.ts";
import { findWrapperPidForIssue, isCoexistenceFailureEvidence } from "./loop/live-advance.ts";
import { eventsTextHasGateUnavailable } from "./issue-readiness.ts";
import {
  buildTrustedOverrideComments,
  govPayloadFromDecision,
  overrideComment,
  parseOverrideArg,
  scopedOverrideComment,
} from "./review-policy.ts";
import {
  classifyPostPlanComments,
  humanAckRecoveryAction,
} from "./issue-context-snapshot.ts";
import {
  buildOverrideDecision,
  buildOverrideEvent,
  implicitOverrideGovernance,
  validateOverrideRecord,
} from "./override-governance.ts";
import {
  attestPipelineComment,
  extractBlockingKeysFromComment,
  extractReviewedSha,
  REVIEW_MARKER_PREFIX_R1,
  REVIEW_MARKER_PREFIX_R2,
} from "./stages/review-parsing.ts";
import { makePipelineRunId } from "./traceability.ts";
import { mintLogicalOperationId } from "./logical-operation.ts";
import { normalizeFullSha } from "./trusted-surface.ts";
import {
  branchName,
  ensureManagedWorktree,
  getForIssue,
  getOnDiskForIssue,
  gitInWorktree,
  removeWorktreeForIssue,
  resolveOpenPrHeadForBranch,
  sweepMergedWorktrees,
  type EnsureManagedWorktreeResult,
} from "./worktree.ts";
import {
  isAncestorOfVerifiedHead,
  isStaleTipPushEvidence,
  resolveVerifiedRemoteHead,
} from "./transient-wrappers.ts";
import { classifyPorcelainForScratchRecover } from "./worktree-dirt.ts";
import {
  checkpointOwnedHarnessDirt,
  classifyHarnessMutationDirt,
  loadOwnershipRecord,
  emitOwnershipEvidence,
  type OwnershipDeps,
} from "./harness-mutation-ownership.ts";
import {
  executePublishUnpublishedStageCommit,
  PUBLISH_UNPUBLISHED_STAGE_COMMIT,
  type PublishUnpublishedExecutorDeps,
} from "./unpublished-stage-commit.ts";
import { resolveEngineCommitSha } from "./engine-attribution.ts";
import { formatPipelineVersionJson } from "./ship-end-identity.ts";
import {
  bundlePath,
  createBundle,
  finalizeBundle,
  markNotified,
  patchBundleIdentity,
  printSummary,
  readBundle,
  recordOverride,
  recordRecovery,
  recordStage,
} from "./evidence-bundle.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  emitGhMetrics,
  finalizeRun,
  initRunDir,
  isElevatedWriteHealth,
  isValidSummaryBundle,
  latestRunDirForIssue,
  latestRunEventsSummaryForIssue,
  latestSummaryForIssue,
  listRunIds,
  parseWriteHealthText,
  runDirPath,
  runIdFor,
  runsDir,
  startTerminalLogTee,
  writeHealthTextForReadFailure,
  type RunEventsSummary,
  type RunStoreDeps,
  type TerminalLogTee,
} from "./run-store.ts";
import { finishReleasePr, realReleaseFinishDeps } from "./stages/release-finish.ts";
import { realReleaseDeps, runRelease } from "./stages/release.ts";
import { runIntake, realIntakeDeps } from "./stages/intake.ts";
import {
  runDecompose,
  realDecomposeDeps,
  isEpicLabeled,
  EPIC_LABEL,
  type EffortBand,
} from "./stages/decompose.ts";
import { runRefineSpec, realRefineSpecDeps } from "./stages/refine-spec.ts";
import { realGrillDeps, runGrill } from "./stages/grill.ts";
import { parseGrillSelector } from "./grill-selector.ts";
import {
  realGrillIssuePreviewDeps,
  realGrillReadySnapshot,
  runRefineSpecIssuePreview,
  usageError,
} from "./grill-issue.ts";
import { materializeGrillAnswer } from "./grill-handoff.ts";
import {
  defaultGrillProposalKeyDeps,
  resolveGrillProposalKey,
} from "./grill-proposal.ts";
import {
  recordPapercut,
  reportPapercuts,
  papercutsEnabled,
  realPapercutDeps,
  autoFileDurableRunBlockers,
  realAutoFileDeps,
} from "./stages/papercut.ts";
import { runSweep, realSweepDeps } from "./stages/sweep.ts";
import { runTriage, realTriageDeps, validateTriageInput, TriageReadyError } from "./stages/triage.ts";
import { mergePr, realMergeDeps, realMergeSupervision } from "./stages/merge.ts";
import { runMergeQueue, realMergeQueueDeps } from "./stages/merge-queue.ts";
import {
  parseIssueList,
  realTrainDeps,
  runTrain,
  type AdvanceOutcome,
  type TrainDeps,
} from "./stages/train.ts";
import {
  composeTrainAdvanceStopReason,
  extractTrainAdvanceLoopEvidence,
  hasStructuredTrainAdvanceEvidence,
  scopeTrainAdvanceEvidenceForIssue,
  type TrainAdvanceLoopEvidence,
} from "./stages/train-advance-stop-reason.ts";
import * as reviewStage from "./stages/review.ts";
import { emitHumanIntervention, blockerKindToInterventionKind } from "./intervention.ts";
import {
  REVIEW_CEILING_MARKER,
  ceilingRound,
  evidenceTimestamp,
} from "./advance-shared.ts";
import {
  emitCorrectionEvent,
  emitControlAttribution,
  CORRECTION_HUMAN_SOURCE_KINDS,
  CORRECTION_FAILURE_CLASSES,
  CORRECTION_REUSABLE,
  CORRECTION_PROPOSED_CONTROLS,
  CONTROL_ATTRIBUTION_DISPOSITIONS,
  EVIDENCE_REF_KINDS,
  type CorrectionFailureClass,
  type CorrectionProposedControl,
  type CorrectionReusable,
  type CorrectionSourceKind,
  type ControlAttributionDisposition,
  type EvidenceRefKind,
} from "./correction.ts";
import { runProductFaultReport, realProductFaultReportDeps } from "./product-fault.ts";
import {
  formatDoctorJson,
  formatDoctorSummary,
  loadLatestPreflightResult,
  realDoctorDeps,
  runPreflight,
  storePreflightResult,
  type PreflightResult,
} from "./stages/doctor.ts";
import {
  foldSmokeIntoChecks,
  realHarnessSmokeDeps,
  runHarnessSmoke,
  type HarnessSmokeDeps,
} from "./stages/harness-smoke.ts";
import { runLoopPreflight, MAX_RANGE_SPAN, type LoopEngine, type LoopPreflightOutcome, type LoopSelector, type RawLoopArgs, type NativeGoalAttestation } from "./loop-preflight.ts";
import { auditSupervisor, driveSupervisor, type SupervisorDeps } from "./loop/supervisor.ts";
import {
  defaultLoopStoreDeps,
  markRunSuperseded,
  readContract,
  readLedger,
  resolveSupersessionChainHead,
  runDir as loopRunDir,
  runExists as loopRunExists,
} from "./loop/store.ts";
import {
  defaultFollowEventsIo,
  followEventsWithTerminalExit,
  followFileWithSignalCleanup,
  isAdvanceRunCompleteLine,
  runLoopLogs,
} from "./loop/logs.ts";
import {
  followLoopStageProgress,
  formatAuditStageTableRow,
  parseAdvanceEventsJsonl,
} from "./loop/stage-progress.ts";
import { initRecoverableRun } from "./loop/recovery.ts";
import { defaultReconcileObserveDeps } from "./loop/reconcile.ts";
import {
  createRepairPipelineItemExecutor,
  type RepairPipelineItemInput,
  type RepairPipelineItemResult,
} from "./loop/repair-pipeline-item.ts";
import {
  evaluatePostHarnessNoNewCommit,
  formatNoopAdvanceEvidenceNote,
  implementDeliverablePresentGoalCheck,
} from "./noop-advance.ts";
import * as openspec from "./openspec.ts";
import { compileContractItems, type RawContractItem } from "./loop/dependencies.ts";
import {
  assertDiscoveryCompleteForAdmission,
  discoverDeclaredDependencies,
  extractRoadmapDeclaredEdges,
  realWorkListDependencyDiscoverDeps,
  type DeclaredDependencyDiscoveryResult,
  type RoadmapDeclaredEdge,
  type WorkListDependencyDiscoverDeps,
} from "./loop/work-list-deps.ts";
import { isFactoryControlCheckout } from "./production-engine-pin.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA, type LoopEngineName, type LoopLedger } from "./loop/types.ts";
import {
  formatLoopRunHandoff,
  writeFlushedStdoutLine,
  type LoopRunReadyContext,
} from "./loop/handoff.ts";
import {
  LOOP_EXECUTION_CONTRACT_SCHEMA,
  normalizeLoopOutcome,
  type LoopEvidencePointer,
  type LoopExecutionRequest,
  type LoopExecutionResponse,
} from "./loop-execution-contract.ts";
import {
  buildStageDiagnostic,
  lastStageDiagnosticFromEventsJsonl,
  projectStageDiagnostic,
  type StageDiagnostic,
} from "./stage-diagnostic.ts";
import {
  buildStatusPayload,
  formatWriteHealthStatusWarning,
  type StatusPayload,
} from "./status-json.ts";
import {
  BLOCKED_LABEL,
  BLOCKER_KINDS,
  LABEL_PREFIX,
  reviewStageSkipTarget,
  type BlockerKind,
  type EvidenceBundle,
  type Outcome,
  type PipelineConfig,
  type Stage,
  type StageOutcome,
} from "./types.ts";
import { allowsJsonFlag, lookupCommand, validateFlags } from "./command-registry.ts";
import {
  dispatch,
  isAutoLoopRecoverable,
  isAutoLoopEligible,
  canAutoLoopContinue,
  runAdvance,
  realPlanningRecoveryDeps,
  type AdvanceDeps,
  type AdvanceOpts,
  type PlanningRecoveryDeps,
} from "./pipeline-run.ts";
import { nestedAdvanceChildEnv } from "./advance-handoff.ts";

// Re-export for backward compatibility with existing import paths.
export { isAutoLoopRecoverable, isAutoLoopEligible, canAutoLoopContinue };
export { ceilingRound, REVIEW_CEILING_MARKER } from "./advance-shared.ts";
export type { AdvanceDeps, AdvanceOpts, PlanningRecoveryDeps };

/** Map Commander-facing {@link CliOpts} into the thin advance bag (#630). */
export function toAdvanceOpts(opts: Pick<
  CliOpts,
  "dryRun" | "model" | "once" | "override" | "jsonEvents" | "profile" | "runId" | "sha"
>): AdvanceOpts {
  const sha = typeof opts.sha === "string" ? opts.sha.trim() : "";
  return {
    dryRun: opts.dryRun,
    model: opts.model,
    once: opts.once,
    override: opts.override,
    jsonEvents: opts.jsonEvents,
    profile: opts.profile,
    runId: opts.runId,
    ...(opts.engineTrack === "pinned" || opts.engineTrack === "candidate"
      ? { engineTrack: opts.engineTrack }
      : {}),
    ...(sha ? { candidateShaOverride: sha } : {}),
  };
}

// Package version, single-sourced from package.json so a version bump is reflected
// automatically. The path is `../package.json` (core/package.json). The installer stages
// `scripts/` beside that core manifest, so the same relative path resolves in both the
// repository and installed CLI layouts without a committed plugin core copy.
// Returns "" on missing/malformed file so `pipeline doctor` can execute and surface the
// install:version-coherence failure instead of crashing before the command dispatches.
const require = createRequire(import.meta.url);
export const VERSION: string = (() => {
  try {
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "";
  }
})();

export interface CliOpts {
  /**
   * Parent logical-operation identity for nested loop/single admission (#1368).
   * Internal: train/ship handoff. Not a public CLI flag.
   */
  parentLogicalOperationId?: string;
  status?: boolean;
  summary?: boolean;
  unblock?: string;
  override?: string;
  once?: boolean;
  dryRun?: boolean;
  domain?: string;
  repoPath?: string;
  base?: string;
  model?: string;
  profile?: string;
  cleanup?: boolean;
  init?: boolean;
  doctor?: boolean;
  failFast?: boolean;
  /** Stream lifecycle events to stdout as JSON lines (--json-events). */
  jsonEvents?: boolean;
  /** Follow mode for `pipeline logs <run-id> --follow` (-f). */
  follow?: boolean;
  /**
   * Events follow until-terminal: exit 0 after terminal event (default true).
   * Advance `pipeline logs … --events --follow` → `run_complete` (#725);
   * loop `pipeline loop logs … --follow` → `loop_run_stopped` or
   * `loop_run_complete` (#699).
   * Commander `--no-until-terminal` sets this false for interrupt-only follow.
   */
  untilTerminal?: boolean;
  /** Read/follow events.jsonl instead of terminal.log in `pipeline logs`. */
  events?: boolean;
  // `pipeline run <N> --detach` options
  detach?: boolean;
  timeout?: number;
  flockTimeout?: number;
  /** Internal: pre-allocated #155 run-store run id, set by the detached launcher so
   *  the inner run uses the same `.agent-pipeline/runs/<run-id>` the caller was told. */
  runId?: string;
  /**
   * Advance: explicit candidate-SHA override when no managed worktree is on
   * disk (#1243). Commander maps `--sha` → `sha`. Must be a full 40-hex SHA.
   */
  sha?: string;
  /** Emit machine-readable JSON (for --status, the doctor command, `pipeline path`, and `pipeline config validate/sync`). */
  json?: boolean;
  /** controls check: non-zero exit on any drifted outcome (#695). */
  strict?: boolean;
  /** Doctor: silent exit-0/1 polling gate; no output. Mutually exclusive with --json. */
  isOk?: boolean;
  /**
   * Doctor: opt-in dynamic harness smoke (#780). Runs one cheap canned model
   * call per unique configured treatment after static preflight. Default doctor
   * (flag absent) remains model-free.
   */
  harnessSmoke?: boolean;
  /** Release: skip opening $EDITOR for ROADMAP review (commit scaffolded ROADMAP as-is).
   *  Commander's `--no-edit` sets `edit: false` here. */
  edit?: boolean;
  /**
   * factory-gate: post-pass pack auto-close (#754). Default true.
   * Commander's `--no-close-pack` sets `closePack: false`.
   */
  closePack?: boolean;
  /** Intake/decompose: short free-text description or seed. */
  description?: string;
  /** decompose: parent epic issue number. */
  epic?: number;
  /** decompose: max child issues in the plan. */
  maxChildren?: number;
  /** decompose: max effort band S|M|L|XL. */
  maxEffort?: string;
  /** decompose: allow XL children despite max-effort. */
  allowXl?: boolean;
  /** refine-spec: existing issue title to refine. */
  title?: string;
  /** refine-spec: existing issue body to refine. */
  body?: string;
  /** refine-spec apply: path to a signed grill-proposal.v1 envelope. */
  proposalFile?: string;
  /** Intake/release/decompose: pin the target release slot (e.g. "v1.6.0" or "1.6.0"). */
  release?: string;
  /** release: theme for a scaffolded release-plan row when missing (#730). */
  theme?: string;
  /**
   * release: audited open-soak-defect override reason (#755). Commander maps
   * `--allow-open-soak-defects <reason>` → `allowOpenSoakDefects`.
   */
  allowOpenSoakDefects?: string;
  /**
   * release ensure-tag: this ship's independent FRG-bound packed candidate 40-hex SHA.
   * Commander maps `--packed-candidate` → `packedCandidate`.
   */
  packedCandidate?: string;
  /** Roadmap/sweep: gate GitHub write-backs (comments, PRs); default is dry-run. */
  apply?: boolean;
  /** Roadmap: emit top-N dependency-safe issues from an existing plan.json. */
  next?: number;
  /** Sweep: override the target GitHub repository (owner/repo). */
  repo?: string;
  /** Triage: target pre-pipeline stage label (ready or backlog). needs-spec is an admission hold. */
  stage?: string;
  /** papercut: run-store run id to record/scope a report to. */
  run?: string;
  /** papercut: free-text friction message to record (-m/--message). */
  message?: string;
  /** Remove issue N's on-disk worktree and local branch, then exit. */
  removeWorktree?: boolean;
  /** Modifier for --remove-worktree: remove despite uncommitted changes. */
  force?: boolean;
  /** improve: restrict analysis to runs on or after this ISO date. */
  since?: string;
  /** factory-gate: target release version X.Y.Z (#723). Commander maps --for → for. */
  for?: string;
  /** ship: absolute path to the gateway-authenticated authorization document. */
  authorization?: string;
  /** factory-gate: durable loop run id to score (#723). */
  fromRun?: string;
  /**
   * factory-release prepare: absolute path to the secret-free request JSON (#953).
   * Commander maps `--request` → request.
   */
  request?: string;
  /**
   * Two-track engine intent (#762). Commander maps `--engine-track` → engineTrack.
   * Values: `pinned` | `candidate`.
   */
  engineTrack?: "pinned" | "candidate";
  /**
   * factory-gate: after a release-eligible pass, opt-in promote of the production
   * pin to --for version (#762). Default off — never silent pin write.
   */
  promotePinOnPass?: boolean;
  /** factory-pin promote/init: optional release git SHA (never invented). */
  gitSha?: string;
  /** factory-pin init: bootstrap from FRG pass for this version. */
  fromFrg?: string;
  /** factory-pin / engine-promote: install host (codex|claude|grok|opencode|all; default all). */
  host?: string;
  /** engine-promote: skip skill install (pin-only). */
  skipInstall?: boolean;
  /** factory-pin rollback: target version (default: pin.previous). */
  to?: string;
  /** scoreboard: restrict analysis to runs on or before this ISO date. */
  until?: string;
  /** scoreboard / outcomes list: use a relative N-day window. */
  days?: number;
  /** outcomes: source adapter id (default: github). */
  adapter?: string;
  /** outcomes: retention window in days for list/scoreboard-style filters. */
  retentionDays?: number;
  /** outcomes ingest: absolute path to a JSON fixture of RawOutcomeSignal[]. */
  fixture?: string;
  /** lineage impact: upstream node id for forward impact walk. */
  nodeId?: string;
  /** lineage impact: revised revision identity for the upstream node. */
  newRevision?: string;
  /** lineage impact: revised content hash for the upstream node. */
  newHash?: string;
  /** lineage propose: start backward proposals from this evidence node. */
  evidenceNodeId?: string;
  /** lineage export: include full node/edge records in the JSON slice. */
  includeRecords?: boolean;
  /** scoreboard: explicit per-harness cost estimates, as harness=usd-per-call. */
  estimateCost?: string[];
  /** scoreboard: emit a chronological day|week time-series alongside the full-window summary. */
  bucket?: string;
  /** scoreboard: group record-scoped metrics by one execution-identity dimension
   *  (harness|model|effort|executor). Collected repeatably so a repeated flag can
   *  be detected rather than silently last-wins (#437). */
  by?: string[];
  /** scoreboard: write a self-contained offline HTML export of the report to this path (#427). */
  html?: string;
  /** evals: directory of fixture JSON files (default: core/evals/fixtures). */
  fixtures?: string;
  /** improve: emit top-N clusters in the report (default 5). */
  top?: number;
  /** improve: only report clusters with at least this many occurrences (default 3). */
  minOccurrences?: number;
  /** improve: print an intervention summary (--interventions). */
  interventions?: boolean;
  // Queue batch factory operation mode (#305).
  /** queue: maximum issues to start in the batch. */
  maxIssues?: number;
  /** queue: stop launching new runs when cumulative cost reaches this USD limit. */
  budgetDollars?: number;
  /** queue: maximum simultaneous pipeline runs. */
  concurrency?: number;
  /** queue: halt new launches when failure rate (failed/completed) meets this threshold (0.0–1.0). */
  maxFailureRate?: number;
  /** queue: filter eligible issues to those carrying all specified labels (repeatable). */
  label?: string[];
  /** queue / merge-queue / train / loop: filter issues to this milestone title. */
  milestone?: string;
  /** train: comma- or space-separated issue list (e.g. "10,11,12"). */
  issues?: string;
  /** train: after ready-to-deploy, merge via existing merge surface and prove base containment. */
  merge?: boolean;
  /** queue: filter eligible issues to those at or below this risk level (low|medium|high). */
  risk?: string;
  /**
   * merge-queue (#676): after a complete drive, prepare a release PR via the
   * existing release path (prepare-only; never tags/publishes/merges). Default off.
   * Requires --release-version. CLI ORs with config merge_queue.release_when_complete.
   */
  releaseWhenComplete?: boolean;
  /**
   * merge-queue (#676): version for release-when-complete (major|minor|patch|X.Y.Z).
   * Required when release-when-complete is enabled.
   */
  releaseVersion?: string;
  /**
   * merge-queue (#675): opt-in surgical/mechanical repair of conflict/CI holds
   * during --apply. Default off; dry-run never repairs. CLI ORs with
   * config merge_queue.repair. Does not grant auto_merge.
   */
  repair?: boolean;
  /** backfill: scope the apply slice to a named capability. */
  capability?: string;
  /** config repo-map add/remove: target relationship list (default: depends_on). */
  rel?: string;
  /** loop: issue-number range selector, e.g. "400-420". */
  range?: string;
  /** loop: named roadmap slice selector. */
  roadmapSlice?: string;
  /** loop: resume an existing durable run by id (also shared by no other command). */
  resume?: string;
  /** loop: read-only report for the run instead of starting/resuming. */
  audit?: boolean;
  /** loop: start a fresh run superseding a terminally-stopped canonical run for the same selector. */
  newRun?: boolean;
  /** correction record: issue number to record the correction against. */
  issue?: number;
  /** correction record: bounded source kind (override|rejection|retry|repair|unblock|manual). */
  sourceKind?: string;
  /** correction record: bounded failure class. */
  failureClass?: string;
  /** correction record: evidence reference, "<kind>:<id>" (kind one of finding|blocker|event|comment|artifact). */
  evidenceRef?: string;
  /** correction record: the observable correction/disposition text. */
  correctionText?: string;
  /** correction record: reusability disposition (yes|no|unknown). */
  reusable?: string;
  /** correction record: optional bounded proposed control. */
  proposedControl?: string;
  /** correction record: optional SHA the corrected evidence was reviewed against. */
  reviewedSha?: string;
  /** correction record: optional current head SHA at record time. */
  headSha?: string;
  /** correction attribute: the correction_key (from a correction_event) this control resolves. */
  correctionKey?: string;
  /** correction attribute: bounded control type (instruction|skill-rubric|eval|deterministic-gate|human-judgment). */
  controlType?: string;
  /** correction attribute: bounded disposition (implemented|human-owned|rejected|superseded). */
  disposition?: string;
  /** correction attribute: the PR that shipped the control. */
  pr?: number;
  /** correction attribute: optional commit SHA the control became effective at. */
  effectiveCommit?: string;
  /** correction attribute: optional release/tag the control became effective at. */
  effectiveRelease?: string;
  /** correction attribute: required for an effective control (disposition implemented,
   *  or superseded shipping a replacement control) — the ISO timestamp the control
   *  actually became effective, distinct from the record's append time. */
  effectiveAt?: string;
  /** correction attribute: optional attribution_id this record supersedes. */
  supersedes?: string;
  /** correction attribute: optional bounded free-text note. */
  note?: string;
  /** scoreboard: group correction/recurrence metrics by a single correction dimension. */
  correctionsBy?: string[];
  /** report: skip the interactive confirmation prompt (-y/--yes). */
  yes?: boolean;
  /** handoff answer: answer body text (#647). */
  text?: string;
  /** handoff reject/supersede: reason text (#647). */
  reason?: string;
  /** handoff answer/reject/supersede: client idempotency key (#647). */
  clientRequestId?: string;
  /** handoff list: comma-separated issue numbers for a queue batch (#647). */
  batch?: string;
  /** handoff list: status filter (#647). */
  filterStatus?: string;
  /** handoff supersede: candidate SHA (#647). */
  candidateSha?: string;
  /** handoff supersede: resume target (#647). */
  resumeTarget?: string;
  /** handoff supersede: handoff_class (#647). Commander maps `--class` → class. */
  class?: string;
  /** handoff supersede: bounded question (#647). */
  question?: string;
}

export interface ShipCliInput {
  mode: "run" | "status";
  milestone: string;
  version: string;
  authorizationPath: string | null;
}

const SHIP_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Derive X.Y.Z from --for or from a semver milestone title (vX.Y.Z / X.Y.Z). */
export function deriveShipVersionFromMilestone(
  milestone: string,
  explicitFor?: string | null,
): string {
  const fromFor = String(explicitFor ?? "").trim().replace(/^[vV]/, "");
  if (fromFor) {
    if (!SHIP_SEMVER.test(fromFor)) {
      throw new Error("--for <X.Y.Z> must be a semantic version");
    }
    return fromFor;
  }
  const fromMilestone = milestone.trim().replace(/^[vV]/, "");
  if (SHIP_SEMVER.test(fromMilestone)) return fromMilestone;
  throw new Error(
    "milestone title is not a semantic version (vX.Y.Z or X.Y.Z); pass --for <X.Y.Z>",
  );
}

export const DEFAULT_SHIP_AUTH_PUBLIC_KEY_FILE = "/etc/agent-pipeline/ship-authority.pem";

export function validateShipAuthorizationPublicKeyFile(
  filePath: string,
  metadata: { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number },
): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error("trusted public key path must be absolute");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("trusted public key must be a regular file, not a symlink");
  }
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error("trusted public key must be root-owned and not writable by group or other");
  }
}

/** Validate only the public ship command shape. Stage code validates identity and authorization contents. */
export function normalizeShipCliInput(
  positionals: readonly string[],
  opts: Pick<CliOpts, "milestone" | "for" | "authorization" | "json">,
): ShipCliInput {
  const verb = positionals[1];
  if (verb !== undefined && verb !== "status") {
    throw new Error(`unexpected argument ${JSON.stringify(verb)}; expected 'status' or no subcommand`);
  }
  const mode = verb === "status" ? "status" : "run";
  const milestone = String(opts.milestone ?? "").trim();
  if (!milestone) throw new Error("--milestone <m> is required");
  const version = deriveShipVersionFromMilestone(milestone, opts.for);

  const authorization = String(opts.authorization ?? "").trim();
  if (mode === "status") {
    if (authorization) throw new Error("status does not accept --authorization");
    return { mode, milestone, version, authorizationPath: null };
  }
  if (authorization && !path.isAbsolute(authorization)) {
    throw new Error("--authorization must be an absolute path");
  }
  return {
    mode,
    milestone,
    version,
    authorizationPath: authorization || null,
  };
}

export function validateReleaseMachineOutputMode(
  opts: Pick<CliOpts, "json" | "dryRun">,
): void {
  if (opts.json && opts.dryRun) {
    throw new Error(
      "--dry-run and --json cannot be combined; dry-run prints a multi-section preview, " +
        "while --json emits one release identity object",
    );
  }
}

/** Select only the status that the failed coordinator call persisted. */
export function selectPersistedShipFailureStatus(
  status: unknown,
  authorizationFingerprint: string,
  errorMessage: string,
): unknown | null {
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  const record = status as Record<string, unknown>;
  return record.authorization_fingerprint === authorizationFingerprint &&
      record.last_error === errorMessage
    ? status
    : null;
}

/**
 * Build and return the configured Commander program (without parsing).
 * Exported so tests can parse synthetic argv slices and verify CLI behaviour.
 */
/**
 * Max positional args (including the command keyword) accepted by the shared
 * extra-positionals guard in main. `loop` accepts the command plus up to
 * {@link MAX_RANGE_SPAN} issue numbers so an explicit issue-list selector can
 * reach {@link normalizeLoopArgs} instead of dying as "unexpected argument(s)"
 * (#554). `handoff` is verb-aware when `args` is passed: `list` (and a missing
 * or unknown verb) admits command + one token; `show|answer|reject|supersede`
 * admits command + verb + one handoff ID (#1349). Without `args`, `handoff`
 * returns the documented ceiling of 3. Other commands keep their pre-existing
 * caps.
 */
export function maxPositionalsFor(
  command: string | undefined,
  args?: readonly string[],
): number {
  if (
    command === "run" ||
    command === "single" ||
    command === "intake" ||
    command === "decompose" ||
    command === "triage" ||
    command === "merge" ||
    command === "merge-queue" ||
    command === "train" ||
    command === "ship" ||
    command === "status" ||
    command === "summary" ||
    command === "papercut" ||
    command === "correction" ||
    command === "controls" ||
    // host-local store verbs with a subcommand: outcomes list|ingest, lineage export|impact|…
    command === "outcomes" ||
    command === "lineage" ||
    command === "liveness" ||
    // factory-release prepare; factory-pin show|init|promote|rollback (#1114)
    command === "factory-release" ||
    command === "factory-pin"
  ) {
    return 2;
  }
  // release <version> | release finish <pr> | release ensure-tag <version> <oid>
  if (command === "release") {
    return 4;
  }
  if (command === "unblock" || command === "override" || command === "evals") {
    return 3;
  }
  if (command === "recover-parked") {
    return 2;
  }
  // loop keyword + up to MAX_RANGE_SPAN issue numbers (same ceiling as --range).
  if (command === "loop") {
    return 1 + MAX_RANGE_SPAN;
  }
  if (command === "refine-spec") {
    return 2; // refine-spec [apply]
  }
  if (command === "grill") {
    return 2; // grill [status]
  }
  if (command === "handoff") {
    if (args === undefined) return 3;
    const verb = args[1];
    if (
      verb === "show" ||
      verb === "answer" ||
      verb === "reject" ||
      verb === "supersede"
    ) {
      return 3; // verb + exactly one handoff ID
    }
    return 2; // list, missing verb, or unknown verb
  }
  return 1; // plain advance takes only the keyword / issue number
}

export function buildCmd(): Command {
  const cmd = new Command();
  const collectRepeatable = (value: string, previous: string[] = []): string[] => [...previous, value];
  cmd
    .name("pipeline")
    .description("Advance a GitHub issue/PR through the pipeline state machine.")
    .version(VERSION, "-V, --version", "print version and exit")
    // Allow 'pipeline run <N> ...', 'pipeline path', 'pipeline config <verb>', and
    // 'pipeline logs <id>' — they pass a second positional Commander would reject.
    .allowExcessArguments(true)
    .argument("[number]", "issue or PR number (required unless --cleanup or --remove-worktree), or a subcommand: init | doctor | status | unblock | override | recover-parked | cleanup | logs | path | config | controls | single | release | ship | factory-gate | factory-release | factory-pin | engine-promote | intake | decompose | triage | roadmap | sweep | grill | merge | merge-queue | train | summary | improve | scoreboard | outcomes | lineage | liveness | queue | backfill | evals | loop | correction | handoff | report")
    .option("--cleanup", "sweep pipeline-managed worktrees whose PR is merged and exit")
    .option("--init", "ensure pipeline labels and scaffold .github/pipeline.yml (no issue number required)")
    .option("--doctor", "run the deterministic preflight checks before advancing; abort the run on any failure")
    .option("--fail-fast", "doctor: stop at the first failing check instead of collecting all failures")
    .option(
      "--harness-smoke",
      "doctor: opt-in role-aware runtime smoke for every unique configured adapter/role/model/effort treatment (~1 cheap model call per treatment; not model-free)",
    )
    .option("--is-ok", "doctor: silent exit-0/1 gate (no output); mutually exclusive with --json")
    .option("--status", "read-only status; print stage and exit")
    .option("--json", "emit machine-readable JSON (for --status, doctor, or controls check)")
    .option("--strict", "controls check: non-zero exit on any drifted outcome (not only fail-closed)")
    .option("--summary", "print the human-readable evidence-bundle summary for <number> and exit")
    .option("--unblock <answer>", "post answer as a comment and clear the blocked label")
    .option(
      "--override <spec>",
      'disposition a review finding so it no longer blocks, then auto-resume: "<key|scope>: [<class>:] <reason>" (class optional; bare reasons use default_class / implicit low_risk_deferred; evidence as kind=url tokens)',
    )
    .option("--once", "advance one stage and stop")
    .option(
      "--sha <sha>",
      "advance: explicit candidate-SHA override (full 40-hex) when no managed worktree is on disk",
    )
    .option("--dry-run", "log what would happen without invoking harnesses or modifying GitHub")
    .option("--domain <name>", "override domain name (default: repo dir basename)")
    .option("--repo-path <path>", "override the target repo working tree")
    .option("--base <branch>", "override the base branch (default: from .github/pipeline.yml or 'main')")
    .option("--model <model>", "override the review/fix model when supported by the selected harness")
    .option("--profile <name>", "shared-core profile to use: codex or claude", process.env.PIPELINE_PROFILE ?? "codex")
    .option("--json-events", "stream lifecycle events to stdout as JSON lines (in addition to human-readable output)")
    .option("-f, --follow", "follow mode for 'pipeline logs' / 'pipeline loop logs': stream new output as it is written")
    // Commander `--no-until-terminal` pattern (same as `--no-edit`): attribute is
    // `untilTerminal`, default true, CLI flag sets false for interrupt-only follow
    // (#699 loop; #725 advance events).
    .option(
      "--no-until-terminal",
      "events --follow: keep streaming until interrupt only (default: exit 0 after run_complete for advance logs, or loop_run_stopped/loop_run_complete for loop logs)",
    )
    .option("--events", "logs mode: read/follow events.jsonl (required selection for advance logs; always selected for 'pipeline loop logs')")
    // `pipeline run <N> --detach` options
    .option("--detach", "run the pipeline in a detached background process (survives launcher exit)")
    .option("--timeout <seconds>", "watchdog: kill the detached run after this many seconds and write a non-zero sentinel", Number)
    .option("--flock-timeout <ms>", "max ms to wait for the per-issue advisory lock (default: 5000)", Number)
    .option("--run-id <id>", "internal: pin the run-store run id (set by the detached launcher so the inner run uses the caller's run directory)")
    .option("--no-edit", "release: skip opening $EDITOR after ROADMAP scaffold (commit as scaffolded)")
    .option(
      "--theme <text>",
      "release: theme for the release PR title / optional ROADMAP docs (overrides milestone title; default: milestone title extraction, or <theme>)",
    )
    .option(
      "--allow-open-soak-defects <reason>",
      "release: audited override to prepare a release PR despite open candidate-linked engine-class soak defects; reason is required and recorded on the PR body (#755). Silent skip is not available.",
    )
    .option(
      "--skip-frg",
      "release / engine-promote: explicit escape — skip Factory Reliability Gate latest.json and write a non-production-quality pin (no-frg-<version>, null evidence). Default promote requires a real FRG pass.",
    )
    .option(
      "--packed-candidate <sha>",
      "release ensure-tag: this ship's independent FRG-bound packed candidate 40-hex SHA",
    )
    .option("--description <text>", "intake/decompose: free-text description or decomposition seed")
    .option("--epic <n>", "decompose: parent epic issue number", Number)
    .option("--max-children <n>", "decompose: maximum child issues in the plan (default: 12 or config)", Number)
    .option("--max-effort <band>", "decompose: maximum child effort S|M|L|XL (default: M or config)")
    .option("--allow-xl", "decompose: permit XL effort children despite max-effort")
    .option("--title <text>", "refine-spec: existing issue title to refine")
    .option("--body <markdown>", "refine-spec: existing issue body to refine")
    .option(
      "--proposal-file <path>",
      "refine-spec apply: read the signed grill-proposal.v1 envelope from PATH instead of stdin",
    )
    .option("--release <version>", "intake/release/decompose: pin the target release slot (e.g. v1.6.0)")
    .option("--apply", "roadmap/sweep/backfill/improve/config sync/decompose: execute write-backs; default is dry-run/preview")
    .option("--next <n>", "roadmap: emit top-N dependency-safe issues from existing plan.json without re-running the engine", Number)
    .option("--repo <owner/repo>", "sweep/backfill: override the target GitHub repository (default: current repo from gh config)")
    .option("--stage <stage>", "triage: target pre-pipeline stage label (ready or backlog). needs-spec is an admission hold: apply the spec, then triage --stage ready")
    // loop (#451): pipeline:loop deterministic preflight + delegation to goal-loop.
    .option("--range <spec>", "loop: issue-number range selector, e.g. 400-420")
    .option("--roadmap-slice <slice>", "loop: named roadmap slice selector")
    .option("--resume <run-id>", "loop: resume an existing durable run by id, regardless of which engine created it")
    .option("--audit", "loop: read-only report for the run (process identity, action evidence, per-item stage table); combine with --follow for stage-progress streaming")
    .option("--new-run", "loop: start a fresh run superseding a terminally-stopped canonical run for the same selector")
    // papercut (#419) is agent-facing, not human-facing: registered and directly invocable
    // (see command-registry.ts + the dispatch block below) but deliberately absent from the
    // `[number]` argument's subcommand description above and from these two options'
    // descriptions/visibility, so it never appears anywhere in --help output.
    .addOption(new Option("--run <run-id>", "run-store run id to record an event against, or scope a report to").hideHelp())
    .addOption(new Option("-m, --message <text>", "free-text friction message to record").hideHelp())
    .option("--for <version>", "ship / factory-gate / factory-pin / engine-promote: target release version X.Y.Z", undefined)
    .option("--authorization <path>", "ship: absolute path to the gateway-authenticated authorization JSON")
    .option(
      "--host <name>",
      "engine-promote: skill install host (codex|claude|grok|opencode|omp|all; default all)",
    )
    .option("--skip-install", "engine-promote: promote pin only; do not run npx install")
    .option("--from-run <run-id>", "factory-gate: score an existing durable loop run id")
    .option(
      "--request <absolute-path>",
      "factory-release prepare: absolute path to the secret-free request JSON (#953)",
    )
    .option(
      "--engine-track <track>",
      "two-track engine intent: pinned (production pin) or candidate (FRG/eval soak) (#762)",
    )
    .option(
      "--promote-pin-on-pass",
      "factory-gate: after a release-eligible FRG pass, promote the production engine pin (opt-in; never merges or tags) (#762)",
    )
    .option("--git-sha <sha>", "factory-pin promote/init: optional release commit SHA (never invented)")
    .option("--from-frg <version>", "factory-pin init: bootstrap pin from FRG pass for version X.Y.Z")
    .option("--to <version>", "factory-pin rollback: repoint pin to this FRG-passed version")
    .option(
      "--no-close-pack",
      "factory-gate: skip auto-close of synthetic pack PRs/issues after a release-eligible pass",
    )
    .option(
      "--observations <file>",
      "factory-gate: JSON file of scenario + composition observations (see FRG runbook)",
    )
    .option(
      "--scenario <token>",
      "factory-gate: additive scenario observation id=status:detail[:observed=N] (repeatable)",
      collectRepeatable,
      [],
    )
    .option("--since <date>", "improve/scoreboard: restrict analysis to runs on or after this ISO date (e.g. 2026-06-01)")
    .option("--until <date>", "scoreboard: restrict analysis to runs on or before this ISO date (e.g. 2026-06-15)")
    .option("--days <n>", "scoreboard/outcomes: analyze the last N days (default: 30 for scoreboard)", Number)
    .option("--adapter <id>", "outcomes ingest: source adapter id (default: github)")
    .option("--retention-days <n>", "outcomes/lineage: exclude records older than N days (default: 365 outcomes / 90 lineage)", Number)
    .option("--fixture <path>", "outcomes/lineage ingest: JSON fixture path (offline; no network)")
    .option("--node-id <id>", "lineage impact: upstream node id for the forward impact walk")
    .option("--new-revision <rev>", "lineage impact: new revision identity for the revised upstream node")
    .option("--new-hash <hash>", "lineage impact: new content hash for the revised upstream node")
    .option("--evidence-node-id <id>", "lineage propose: start backward proposals from this evidence node")
    .option("--include-records", "lineage export: include full node/edge records in JSON output")
    .option("--estimate-cost <harness=usd>", "scoreboard: estimate missing harness-call costs; repeatable", collectRepeatable, [])
    .option("--bucket <unit>", "scoreboard: add a chronological day|week time-series alongside the full-window summary")
    .option("--by <dimension>", "scoreboard: group metrics by harness|model|effort|executor; repeatable (to detect a duplicate flag)", collectRepeatable, [])
    .option("--html <path>", "scoreboard: write a self-contained offline HTML export of the report to this path")
    .option("--fixtures <dir>", "evals: directory of fixture JSON files (default: core/evals/fixtures)")
    .option("--baseline <treatment_id>", "evals report: the treatment_id every paired delta is computed against (required)")
    .option("--judge", "evals grade: opt in to the optional model judge (disabled by default; recorded separately from deterministic grades)")
    .option("--out <path>", "evals harvest: write the rendered draft JSON to this path instead of stdout")
    .option("--plan-only", "evals harvest --apply: additionally prove the promoted draft expands into an executable cell plan (no live model call, no production GitHub write)")
    .option("--trajectory-max-events <n>", "evals run/grade: max events retained per bounded trajectory/verifier channel before deterministic head/tail truncation (default: 200)", Number)
    .option("--trajectory-max-bytes <n>", "evals run/grade: max serialized bytes retained per bounded trajectory/verifier channel before deterministic head/tail truncation (default: 200000)", Number)
    .option("--link-artifacts", "evals report: opt in to linking trajectory/verifier artifact references for flagged cells (outliers, judge disagreements, false positives/negatives, failed cells); default output is unchanged")
    .option("--top <n>", "improve: emit top-N clusters in the report (default: 5)", Number)
    .option("--min-occurrences <n>", "improve: only create issues for clusters with at least this many occurrences (default: 3, 2 for the correction category; requires --apply)", Number)
    .option("--interventions", "improve: print an intervention summary as JSON instead of the cluster report")
    .option("--remove-worktree", "remove issue N's on-disk worktree and local branch, then exit (bypasses kill switch)")
    .option("--force", "modifier for --remove-worktree: remove despite uncommitted changes (usage error without --remove-worktree)")
    // queue batch factory operation mode (#305)
    .option("--max-issues <N>", "queue: maximum issues to start in the batch (default: 10)", Number)
    .option("--budget-dollars <D>", "queue: stop launching new runs when cumulative cost (USD) reaches this limit", Number)
    .option("--concurrency <C>", "queue: maximum simultaneous pipeline runs (default: 1)", Number)
    .option("--max-failure-rate <R>", "queue: halt new launches when failure rate meets this threshold 0.0–1.0 (default: 1.0)", Number)
    .option("--label <L>", "queue: filter eligible issues to those carrying this label (repeatable)", collectRepeatable, [])
    .option("--milestone <M>", "ship / queue / merge-queue / train / loop: filter issues to this milestone title")
    .option("--issues <list>", "train: comma- or space-separated issue numbers (e.g. 10,11,12)")
    .option(
      "--merge",
      "train: after each issue reaches ready-to-deploy, merge via pipeline merge and prove base containment before the next item",
    )
    .option("--risk <level>", "queue: filter eligible issues to those at or below this risk level (low|medium|high)")
    .option(
      "--release-when-complete",
      "merge-queue: after a complete drive, prepare a release PR for human review (opt-in; never tags, publishes, or merges the release)",
    )
    .option(
      "--release-version <version>",
      "merge-queue: version for --release-when-complete (major|minor|patch|X.Y.Z); required when release-when-complete is enabled",
    )
    .option(
      "--repair",
      "merge-queue: during --apply, attempt deterministic-first then surgical repair of conflict/CI holds (opt-in; default off; dry-run never repairs; does not grant auto_merge)",
    )
    // backfill options (#327)
    .option("--capability <name>", "backfill: scope the apply slice to a named capability")
    .option("--rel <relation>", "config repo-map add/remove: depends_on or depended_on_by (default: depends_on)")
    // correction record (#499): a narrow, non-mutating CLI that records one
    // correction_event against an existing run. No advance/unblock/override/
    // merge/deploy/code-mutation authority — its only side effect is one
    // appended, sanitized correction_event.
    .option(
      "--issue <n>",
      "refine-spec / handoff / correction: issue number",
      Number,
    )
    .option("--source-kind <kind>", `correction record: ${CORRECTION_HUMAN_SOURCE_KINDS.join("|")}`)
    .option("--failure-class <class>", `correction record: ${CORRECTION_FAILURE_CLASSES.join("|")}`)
    .option("--evidence-ref <kind:id>", `correction record: "<kind>:<id>" evidence pointer (kind one of ${EVIDENCE_REF_KINDS.join("|")})`)
    .option("--correction-text <text>", "correction record: the observable correction/disposition text")
    .option("--reusable <value>", `correction record: ${CORRECTION_REUSABLE.join("|")}`)
    .option("--proposed-control <control>", `correction record: optional — ${CORRECTION_PROPOSED_CONTROLS.join("|")}`)
    .option("--reviewed-sha <sha>", "correction record: optional — the SHA the corrected evidence was reviewed against")
    .option("--head-sha <sha>", "correction record: optional — the current head SHA at record time")
    // correction attribute (#501): a narrow, non-mutating CLI that records one
    // control_attribution against the durable repo-level attribution ledger.
    // Same authority boundary as `correction record` — no advance/unblock/
    // override/merge/deploy path, no GitHub call.
    .option("--correction-key <key>", "correction attribute: the correction_key (from a correction_event) this control resolves")
    .option("--control-type <type>", `correction attribute: ${CORRECTION_PROPOSED_CONTROLS.join("|")}`)
    .option("--disposition <value>", `correction attribute: ${CONTROL_ATTRIBUTION_DISPOSITIONS.join("|")}`)
    .option("--pr <n>", "correction attribute: the PR that shipped the control", Number)
    .option("--effective-commit <sha>", "correction attribute: optional — the commit SHA the control became effective at")
    .option("--effective-release <tag>", "correction attribute: optional — the release/tag the control became effective at")
    .option("--effective-at <iso>", "correction attribute: the ISO timestamp the control actually became effective — required when --disposition is implemented, or superseded with --effective-commit/--effective-release")
    .option("--supersedes <attribution-id>", "correction attribute: optional — the attribution_id this record supersedes")
    .option("--note <text>", "correction attribute: optional bounded free-text note")
    .option("--corrections-by <dimension>", "scoreboard: group correction/recurrence metrics by repo|stage|harness|model|source_kind|failure_class|proposed_control|implemented_control; repeatable (to detect a duplicate flag)", collectRepeatable, [])
    // human-question handoff (#647)
    .option("--text <text>", "handoff answer: the answer text")
    .option("--reason <text>", "handoff reject/supersede: reason text")
    .option("--client-request-id <id>", "handoff answer/reject/supersede: idempotency key")
    .option("--batch <list>", "handoff list: comma-separated issue numbers for a queue batch filter")
    .option("--filter-status <status>", "handoff list: filter by handoff status (pending|answered|rejected|superseded|expired)")
    // handoff supersede reuses existing --capability <name> (also used by backfill)
    .option("--candidate-sha <sha>", "handoff supersede: candidate SHA")
    .option("--resume-target <stage>", "handoff supersede: resume target")
    .option("--class <class>", "handoff supersede: handoff_class")
    .option("--question <text>", "handoff supersede: bounded question text")
    // report (#502): privacy-safe upstream product-fault reporting. Disabled
    // by default (product_fault.enabled absent/false in .github/pipeline.yml)
    // — see `runProductFaultReport`. --yes supplies the explicit confirmation
    // on the command line instead of an interactive y/N prompt.
    .option("-y, --yes", "report: skip the interactive confirmation prompt (explicit operator confirmation given on the command line)");
  // Note: `--json` is defined once above; it serves --status, the doctor command,
  // `pipeline path`, and `pipeline config validate/sync` (path/config are exempted from
  // the --status-only check). `allowExcessArguments(true)` (above) permits the
  // second positional of `run <N>`, `path`, `config <verb>`, and `logs <id>`.
  return cmd;
}

/** Derives a deterministic run id from a resolved issue-number list. Stable
 *  across repeated invocations of the same resolved list so a second run
 *  naturally resumes instead of creating a duplicate. Selector provenance is
 *  stored separately on the immutable contract. */
export function workListRunId(repo: string, engine: LoopEngine, issues: readonly string[]): string {
  const hash = crypto.createHash("sha256").update(`${repo}:${engine}:${issues.join(",")}`).digest("hex").slice(0, 16);
  return `loop-${hash}`;
}

/** Return the selector identity that is stored after a selector resolves to an
 * issue list. Work-list values use the resolved list so range and explicit-list
 * callers keep their existing canonical contract shape. */
export function resolvedContractSelector(
  sourceSelector: LoopSelector | undefined,
  issues: readonly string[],
): LoopSelector {
  return sourceSelector
    ? sourceSelector.type === "work-list"
      ? { type: "work-list", value: [...issues] }
      : { ...sourceSelector }
    : { type: "work-list", value: [...issues] };
}

/** Canonical run ids predate selector provenance and are based on the resolved
 * issue list. Refuse silent reuse when another selector produced the same list;
 * an explicit terminal `--new-run` can then mint the corrected contract. */
export function canonicalSelectorMatches(
  existing: LoopSelector,
  sourceSelector: LoopSelector | undefined,
  issues: readonly string[],
): boolean {
  const requested = resolvedContractSelector(sourceSelector, issues);
  if (existing.type !== requested.type) return false;
  if (existing.type === "work-list" && requested.type === "work-list") {
    return existing.value.length === requested.value.length &&
      existing.value.every((value, index) => value === requested.value[index]);
  }
  return existing.value === requested.value;
}

/** Compiles a `LoopContractInit` + seeded `LoopLedger` for an already-resolved
 *  issue-number list. `rawItems` carries **declared** per-item dependencies
 *  (from {@link discoverDeclaredDependencies} / {@link compileWorkListRunFresh});
 *  when omitted, every item is independent (`depends_on: []`) — used only by
 *  pure unit tests that intentionally skip discovery. Production fresh init
 *  always passes discovered raw items so body/native/roadmap edges feed
 *  `compileContractItems` (capability `work-list-declared-dependency-population`,
 *  #615). Milestone/label/roadmap-slice/explicit-list selectors all resolve into
 *  this same compile entrypoint via {@link resolveSelectorIssues}. */
export function compileWorkListRun(
  cfg: PipelineConfig,
  engine: LoopEngine,
  issues: readonly string[],
  runId: string,
  rawItems?: readonly RawContractItem[],
  sourceSelector?: LoopSelector,
  logicalOperationId?: string,
): { contract: import("./loop/recovery.ts").LoopContractInit; ledger: LoopLedger } {
  // Resolution turns every selector into an issue list for dependency
  // discovery. Keep the normalized source selector on the immutable contract;
  // otherwise a label/milestone FRG pack becomes indistinguishable from an
  // ad-hoc work list after fresh compilation. Callers that supply only a list
  // retain the existing work-list contract shape.
  const contractSelector = resolvedContractSelector(sourceSelector, issues);
  const resolvedLogicalId =
    typeof logicalOperationId === "string" && logicalOperationId.trim()
      ? logicalOperationId.trim()
      : mintLogicalOperationId();
  const contract: import("./loop/recovery.ts").LoopContractInit = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: runId,
    logical_operation_id: resolvedLogicalId,
    engine,
    repo: { name: cfg.repo, base_branch: cfg.base_branch },
    selector: contractSelector,
    objective: `advance ${issues.join(", ")} to pipeline:ready-to-deploy`,
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: [],
    recovery_budgets: { default: 3 },
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: compileContractItems(
      rawItems ?? issues.map((id) => ({ id, depends_on: [] as string[] })),
    ),
    canonical_hash: runId,
  };
  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: runId,
    items: Object.fromEntries(
      issues.map((id) => [id, { id, state: "pending" as const, history: [], recovery_budgets_remaining: { default: 3 } }]),
    ),
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  return { contract, ledger };
}

/**
 * Fresh work-list run compile: discover declared dependencies, then compile.
 * Resume paths must NOT call this — they keep the on-disk contract (no silent
 * re-discover overwrite). Run id remains {@link workListRunId} of the issue
 * list only (deps do not change run identity).
 *
 * Multi-item packs and factory-owned runs (live factory control checkout) refuse
 * admission with {@link IncompleteDependencyDiscoveryError} when any enabled
 * authoritative source is unavailable or incomplete — no contract/ledger is
 * produced (#905). Successful compiles attach additive `dependency_discovery`
 * audit identity (edge provenance + source observations) on the contract.
 */
export async function compileWorkListRunFresh(
  cfg: PipelineConfig,
  engine: LoopEngine,
  issues: readonly string[],
  runId: string,
  discoverDeps: WorkListDependencyDiscoverDeps = realWorkListDependencyDiscoverDeps(cfg),
  sourceSelector?: LoopSelector,
  opts?: { forceRefuseIncomplete?: boolean; env?: NodeJS.ProcessEnv; logicalOperationId?: string },
): Promise<{
  contract: import("./loop/recovery.ts").LoopContractInit;
  ledger: LoopLedger;
  discovery: DeclaredDependencyDiscoveryResult;
}> {
  const discovery = await discoverDeclaredDependencies(issues, discoverDeps);
  // Factory-owned fresh admission always refuses incomplete discovery, even
  // for a single-item pack (spec: multi-item OR factory-owned). Factory plane
  // is checkout-role, not GitHub owner/name (#1237). Callers may also force
  // refuse via opts for non-factory exploratory paths.
  const forceRefuseIncomplete =
    opts?.forceRefuseIncomplete === true ||
    isFactoryControlCheckout({
      repoDir: cfg.repo_dir,
      env: opts?.env ?? process.env,
    });
  assertDiscoveryCompleteForAdmission(issues, discovery, {
    forceRefuse: forceRefuseIncomplete,
  });
  const { contract, ledger } = compileWorkListRun(
    cfg,
    engine,
    issues,
    runId,
    discovery.items,
    sourceSelector,
    opts?.logicalOperationId,
  );
  // Additive provenance — older on-disk contracts omit this field and remain
  // readable on resume without re-discovery.
  contract.dependency_discovery = {
    observations: discovery.observations.map((o) => ({
      source: o.source,
      scope: o.scope,
      status: o.status,
      observation_id: o.observation_id,
      ...(o.reason ? { reason: o.reason } : {}),
    })),
    edge_provenance: discovery.edge_provenance.map((e) => ({
      depender: e.depender,
      prerequisite: e.prerequisite,
      sources: [...e.sources],
    })),
    // Hard-wait admission audit (#1073): off-selector / closed / not-open refs.
    ...(discovery.ignored_deps.length > 0
      ? {
          ignored_deps: discovery.ignored_deps.map((d) => ({
            depender: d.depender,
            target: d.target,
            reason: d.reason,
          })),
        }
      : {}),
  };
  return { contract, ledger, discovery };
}

/** The real `pipeline/loop-execution@1` dispatch seam: runs the per-item
 *  advance loop for `item_id` to completion as a synchronous child process
 *  (never the external goal-loop skill), then maps the issue's final label
 *  state to a terminal outcome. Injected so unit tests never spawn a real
 *  process. */
/** Builds the child-process argv for the per-item advance loop hand-off.
 *  Deliberately omits `--once`: the child must run its normal advance loop
 *  to completion (a defined `pipeline/loop-execution@1` terminal outcome —
 *  ready-to-deploy, blocked, or closed), not stop after a single stage (#512
 *  review 1, finding 57fe63fa). Optional `runId` pins the child's
 *  `.agent-pipeline/runs/<run-id>/` via the same internal `--run-id` flag
 *  detached launch already uses (#667). Exported as a pure function so this
 *  contract is unit-testable without spawning a real process. */
export function dispatchItemChildArgs(
  scriptPath: string,
  issueNumber: number,
  engine: LoopEngine,
  repoDir: string,
  opts?: { runId?: string; engineTrack?: "pinned" | "candidate" },
): string[] {
  const args = [scriptPath, String(issueNumber), "--profile", engine, "--repo-path", repoDir];
  if (opts?.runId) args.push("--run-id", opts.runId);
  if (opts?.engineTrack === "pinned" || opts?.engineTrack === "candidate") {
    args.push("--engine-track", opts.engineTrack);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Loop dispatch ↔ advance run-store linkage helpers (#667).
// ---------------------------------------------------------------------------

/** Pinned advance run-store identity for one per-item hand-off. */
export interface AdvanceRunPin {
  /** Basename under `.agent-pipeline/runs/<run-id>/`. */
  pipeline_run_id: string;
  /** Absolute path of the advance run directory. */
  run_dir: string;
  /** Absolute path of that run's `events.jsonl`. */
  events_path: string;
}

/** Durable start-linkage payload written on the loop run event trail. */
export interface AdvanceStartLinkage {
  item_id: string;
  pipeline_run_id: string;
  events: string;
}

/** Durable terminal-linkage payload written on the loop run event trail. */
export interface AdvanceTerminalLinkage {
  item_id: string;
  pipeline_run_id: string;
  outcome: LoopExecutionResponse["outcome"];
  /** Absolute events path when a real pin was known; omitted when none. */
  events?: string;
}

/** Compute a pinned advance run id + absolute paths for a repo root + issue. */
export function pinAdvanceRunIdentity(repoDir: string, issueNumber: number, startedAt: Date): AdvanceRunPin {
  const pipeline_run_id = runIdFor(issueNumber, startedAt);
  const run_dir = runDirPath(repoDir, pipeline_run_id);
  return {
    pipeline_run_id,
    run_dir,
    events_path: path.join(run_dir, "events.jsonl"),
  };
}

/** Last-resort synthetic join key when no advance run store can be established. */
export function syntheticLoopEvidencePipelineRunId(loopRunId: string, itemId: string): string {
  return `pipeline-loop-${loopRunId}-${itemId}`;
}

/** True when `pipeline_run_id` is the synthetic-only form (not a real store basename). */
export function isSyntheticLoopEvidencePipelineRunId(pipelineRunId: string): boolean {
  return pipelineRunId.startsWith("pipeline-loop-");
}

/** Map a known pin (or synthetic fallback) into a truthful evidence pointer.
 *  When `events_path_known` is false (spawn/init failure before a live store),
 *  retain the intended pin id for traceability but omit `events_path` so we
 *  never advertise a non-existent `events.jsonl` as live. */
export function buildLoopEvidencePointer(opts: {
  pr_number: number | null;
  item_id: string;
  loop_run_id: string;
  pin?: AdvanceRunPin | null;
  /** Default true when a pin is present. Pass false when the store was never live. */
  events_path_known?: boolean;
  worktree_root?: string | null;
}): LoopEvidencePointer {
  if (opts.pin) {
    const eventsKnown = opts.events_path_known !== false;
    return {
      pr_number: opts.pr_number,
      pipeline_run_id: opts.pin.pipeline_run_id,
      ...(eventsKnown ? { events_path: opts.pin.events_path } : {}),
      ...(opts.worktree_root !== undefined ? { worktree_root: opts.worktree_root } : {}),
    };
  }
  const pipelineRunId = syntheticLoopEvidencePipelineRunId(opts.loop_run_id, opts.item_id);
  return {
    pr_number: opts.pr_number,
    pipeline_run_id: pipelineRunId,
    ...(opts.worktree_root !== undefined ? { worktree_root: opts.worktree_root } : {}),
  };
}

/** Start-linkage event payload for the loop run trail. */
export function buildStartLinkagePayload(itemId: string, pin: AdvanceRunPin): AdvanceStartLinkage {
  return {
    item_id: itemId,
    pipeline_run_id: pin.pipeline_run_id,
    events: pin.events_path,
  };
}

/** Terminal-linkage event payload. When `pin` is null/absent, falls back to a
 *  synthetic id for traceability and omits `events` so we never claim a live
 *  join to a non-existent path. */
export function buildTerminalLinkagePayload(
  itemId: string,
  outcome: LoopExecutionResponse["outcome"],
  opts: { pin?: AdvanceRunPin | null; loop_run_id: string; events_path?: string | null },
): AdvanceTerminalLinkage {
  if (opts.pin) {
    return {
      item_id: itemId,
      pipeline_run_id: opts.pin.pipeline_run_id,
      outcome,
      events: opts.pin.events_path,
    };
  }
  if (opts.events_path) {
    // Evidence carried a real path/id without a local pin object (e.g. fake dispatch).
    const basename = path.basename(path.dirname(opts.events_path));
    return {
      item_id: itemId,
      pipeline_run_id: basename,
      outcome,
      events: opts.events_path,
    };
  }
  return {
    item_id: itemId,
    pipeline_run_id: syntheticLoopEvidencePipelineRunId(opts.loop_run_id, itemId),
    outcome,
  };
}

/** Pure classifier for the per-item advance's terminal label/state → dispatch outcome,
 *  extracted from {@link realDispatchItem} so the mapping is unit-testable without a real
 *  child process. The blocker discriminator is the canonical `BLOCKED_LABEL` (`"blocked"`, the
 *  exact string `gh.ts` applies) — NOT `${LABEL_PREFIX}blocked`, which is never written. The
 *  old wrong name here mapped a real needs-human block to `failed`, which the supervisor then
 *  classified as workflow-engine-defect and run_fataled the whole run (#616).
 *
 *  The canonical diagnostic from the final structured `blocker_set` decides
 *  recoverable, capacity, or explicit human authority. Missing/malformed
 *  diagnostics fail the protocol; labels and prose never grant authority. */
export function classifyDispatchOutcome(
  detail: { labels: readonly string[]; state: string },
  diagnostic?: StageDiagnostic | null,
  /** Optional advance events.jsonl body for mid-stage / coexistence classification (#770). */
  eventsText?: string | null,
): LoopExecutionResponse["outcome"] {
  const readyLabel = `${LABEL_PREFIX}ready-to-deploy`;
  if (detail.labels.includes(readyLabel)) return "ready_to_deploy";
  if (detail.labels.includes(`${LABEL_PREFIX}needs-spec`)) return "needs_spec";
  if (eventsTextHasGateUnavailable(eventsText)) return "gate_unavailable";
  if (detail.labels.includes(BLOCKED_LABEL)) {
    const projection = projectStageDiagnostic(diagnostic);
    if (projection.disposition === "capacity") return "capacity_wait";
    if (projection.disposition === "recover") return "blocked_recoverable";
    if (projection.disposition === "human_authority") return "blocked_needs_human";
    return "failed";
  }
  if (detail.state === "closed") return "abandoned";
  // Coexistence is only lock / already-running / install evidence — never bare
  // mid-stage skipped/waiting events that can mask a genuine crash (#770 review
  // finding 929fc0ac).
  if (isCoexistenceFailureEvidence(eventsText)) {
    return "coexistence_wait";
  }
  return "failed";
}

/**
 * Read the last `blocker_kind` from an advance events.jsonl body (#718).
 * Pure over the raw text so unit tests need no filesystem.
 */
export function lastBlockerKindFromEventsJsonl(eventsText: string): string | null {
  let last: string | null = null;
  for (const line of eventsText.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; blocker_kind?: unknown };
      if (event.type === "blocker_set" && typeof event.blocker_kind === "string") last = event.blocker_kind;
    } catch {
      // Compatibility reader only; dispatch classification uses the typed parser.
    }
  }
  return last;
}

/** Injectable deps for {@link realDispatchItem} — unit tests never spawn a real
 *  process or touch live gh (#667). */
export interface RealDispatchItemDeps {
  spawn?: typeof spawn;
  now?: () => Date;
  getIssueDetail?: typeof getIssueDetail;
  getPrForIssue?: typeof getPrForIssue;
  /**
   * Clear the product `blocked` label after a pure capacity disposition so the
   * issue is re-admissible once a slot frees (#718). Injected for unit tests.
   */
  clearBlocked?: typeof clearBlocked;
  /**
   * Authenticated gh actor login used to trust-filter the durable blocker-kind
   * comment fallback (#718 review b5108544). Injected for unit tests — never
   * call live `gh api user` from tests.
   */
  getGhActor?: () => Promise<string | null>;
  /**
   * Latest `blocked` label application time for comment-fallback incarnation
   * binding (#718 69894186). Injected for unit tests — never call live
   * timeline GraphQL from tests.
   */
  getLatestBlockedLabeledAt?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<string | null>;
  scriptPath?: string;
  execPath?: string;
  /**
   * True when the pinned advance `events.jsonl` has been created (store init).
   * Defaults to `existsSync`. Injected so unit tests never touch the real FS.
   */
  eventsPathExists?: (eventsPath: string) => boolean;
  /**
   * Read advance events.jsonl text for capacity-vs-product disposition (#718).
   * Defaults to fs.readFileSync when the path exists.
   */
  readEventsText?: (eventsPath: string) => string | null;
  /**
   * Read write-health.json beside the advance events path (#633). Defaults to
   * reading `<runDir>/write-health.json` when present. Used so missing
   * control-critical evidence after a recorded stream failure stays fail-safe.
   *
   * Contract: return `null` only when the file is missing (ENOENT / legacy).
   * Present-but-unreadable (EACCES, I/O) MUST NOT collapse to null — return
   * non-empty text that fails parse so recovery elevates to
   * UNREADABLE_WRITE_HEALTH. Collapsing unreadable → null would follow the
   * ordinary missing-evidence path instead of the persistence-failure path.
   */
  readWriteHealthText?: (eventsPath: string) => string | null;
  /** Poll interval (ms) while waiting for store init during the child wait. */
  storeReadyPollMs?: number;
}

export function realDispatchItem(
  cfg: PipelineConfig,
  engine: LoopEngine,
  deps: RealDispatchItemDeps = {},
): SupervisorDeps["dispatchItem"] {
  const spawnFn = deps.spawn ?? spawn;
  const nowFn = deps.now ?? (() => new Date());
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const getPrForIssueFn = deps.getPrForIssue ?? getPrForIssue;
  const clearBlockedFn = deps.clearBlocked ?? clearBlocked;
  const getGhActorFn = deps.getGhActor ?? getGhActor;
  const getLatestBlockedLabeledAtFn =
    deps.getLatestBlockedLabeledAt ?? getLatestBlockedLabeledAt;
  const scriptPath = deps.scriptPath ?? fileURLToPath(import.meta.url);
  const execPath = deps.execPath ?? process.execPath;
  const eventsPathExistsFn = deps.eventsPathExists ?? ((p: string) => existsSync(p));
  const readEventsTextFn =
    deps.readEventsText ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const readWriteHealthTextFn =
    deps.readWriteHealthText ??
    ((eventsPath: string): string | null => {
      const healthPath = path.join(path.dirname(eventsPath), "write-health.json");
      try {
        return readFileSync(healthPath, "utf8");
      } catch (err) {
        // Missing → null; present-but-unreadable → elevated sentinel text.
        return writeHealthTextForReadFailure(err);
      }
    });
  const storeReadyPollMs = deps.storeReadyPollMs ?? 50;

  return async (request, hooks): Promise<LoopExecutionResponse> => {
    const issueNumber = Number(request.item_id);
    // Pin before spawn so the child uses the same `.agent-pipeline/runs/<run-id>/`
    // (detached-launch pattern). Start linkage + live events_path are published
    // only after the pinned run store is confirmed initialized — never on bare
    // `spawn` (which only proves the OS launched the executable) or on exit
    // before initRunDir.
    const pin =
      Number.isFinite(issueNumber) && issueNumber > 0
        ? pinAdvanceRunIdentity(cfg.repo_dir, issueNumber, nowFn())
        : null;

    let startLinkage: Promise<void> = Promise.resolve();
    let storeReady = false;
    const confirmStoreReady = (): boolean => {
      if (!pin || storeReady) return storeReady;
      if (!eventsPathExistsFn(pin.events_path)) return false;
      storeReady = true;
      if (hooks?.onAdvanceLinked) {
        startLinkage = Promise.resolve(
          hooks.onAdvanceLinked(buildStartLinkagePayload(request.item_id, pin)),
        ).then(() => undefined);
      }
      return true;
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawnFn(
          execPath,
          dispatchItemChildArgs(scriptPath, issueNumber, engine, cfg.repo_dir, {
            ...(pin ? { runId: pin.pipeline_run_id } : {}),
            ...(cfg.engine_track === "pinned" || cfg.engine_track === "candidate"
              ? { engineTrack: cfg.engine_track }
              : {}),
          }),
          { stdio: "inherit", env: nestedAdvanceChildEnv() },
        );
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let settled = false;
        const stopPoll = () => {
          if (pollTimer !== undefined) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }
        };
        const startPoll = () => {
          if (!pin || storeReady || pollTimer !== undefined) return;
          // Immediate check, then bounded poll while the child is alive so
          // harnesses can follow the advance trail mid-wait once init succeeds.
          confirmStoreReady();
          if (!storeReady) {
            pollTimer = setInterval(() => {
              if (confirmStoreReady()) stopPoll();
            }, storeReadyPollMs);
          }
        };
        child.on("spawn", startPoll);
        child.on("error", (err) => {
          stopPoll();
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        child.on("exit", () => {
          stopPoll();
          // Final confirmation: child may have created the store just before exit,
          // or fakes may only emit `exit` (no `spawn`). Never publish start
          // linkage / events_path without this check.
          confirmStoreReady();
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });
    } catch {
      // Spawn failure: retain the intended pin id for traceability when known,
      // but omit events_path — no child created the run store. Start linkage
      // was not published.
      return {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: request.item_id,
        run_id: request.run_id,
        outcome: "failed",
        evidence: buildLoopEvidencePointer({
          pr_number: null,
          item_id: request.item_id,
          loop_run_id: request.run_id,
          pin,
          events_path_known: false,
        }),
      };
    }
    // Linkage write errors must surface separately from spawn failure — when
    // the store was confirmed, a failed append is not a "no store" path.
    await startLinkage;

    let outcome: LoopExecutionResponse["outcome"] = "failed";
    let diagnostic: StageDiagnostic | undefined;
    let prNumber: number | null = null;
    try {
      const detail = await getIssueDetailFn(cfg, issueNumber);
      // Prefer the advance run's last blocker_set diagnostic. When the fresh
      // per-dispatch events lack one (an already-blocked item early-exits in
      // pipeline-run.ts before writing any blocker_set), fall back to the
      // durable attested kind marker on the blocked comment (#718) for EVERY
      // blocker kind — capacity, mechanical, or human — so the re-dispatch is
      // classified by its true blocker class instead of cascading into a
      // protocol failure the supervisor treats as an engine defect.
      let eventsTextForClassify: string | null = null;
      let writeHealthHint: { failure_count: number; worst_criticality?: string | null; last_error?: string | null; last_event_type?: string | null } | null = null;
      if (pin && storeReady) {
        eventsTextForClassify = readEventsTextFn(pin.events_path);
        const whRaw = readWriteHealthTextFn(pin.events_path);
        if (whRaw != null && whRaw !== "") {
          // Corrupt/unreadable write-health is fail-safe elevated (#633 review):
          // never treat a present-but-broken artifact as healthy/absent.
          const parsed = parseWriteHealthText(whRaw);
          if (isElevatedWriteHealth(parsed)) {
            writeHealthHint = {
              failure_count: parsed.failure_count,
              worst_criticality: parsed.worst_criticality,
              last_error: parsed.last_error,
              last_event_type: parsed.last_event_type,
            };
          }
        }
      }
      let resolution = lastStageDiagnosticFromEventsJsonl(
        eventsTextForClassify ?? "",
        writeHealthHint,
      );
      // Compatibility for early-exits before a fresh run-store event: only the
      // authenticated, current blocked-label incarnation may supply this
      // structural fallback. Comment prose is never read or transported.
      if (resolution.diagnostic === null && Array.isArray(detail.comments)) {
        const actor = await getGhActorFn();
        let blockedLabeledAt: string | null = null;
        try {
          blockedLabeledAt = await getLatestBlockedLabeledAtFn(cfg, issueNumber);
        } catch {
          blockedLabeledAt = null;
        }
        const trustedKind = lastBlockerKindFromComments(detail.comments, {
          trustedAuthor: actor,
          blockedLabeledAt,
        });
        if (trustedKind === "human-decision-required") {
          // A marker attests only the prior blocker's kind. It cannot
          // reconstruct authority_evidence or candidate binding, so it must
          // remain a protocol defect and enter bounded engine recovery rather
          // than manufacturing or preserving a human hold.
        } else if (
          trustedKind !== null &&
          (BLOCKER_KINDS as readonly string[]).includes(trustedKind)
        ) {
          // Mechanical kinds (including worktree-capacity) synthesize the same
          // coarse structural diagnostic stageDiagnosticFromBlockerSet builds,
          // so recovery targets the true blocker class, not engine-defect.
          const markerDiagnostic = buildStageDiagnostic({
            blockerKind: trustedKind as BlockerKind,
            reason: "trusted current blocker-kind attestation",
          });
          resolution = {
            ...projectStageDiagnostic(markerDiagnostic),
            diagnostic: markerDiagnostic,
          };
        }
      }
      diagnostic = resolution.diagnostic ?? undefined;
      outcome = classifyDispatchOutcome(detail, diagnostic, eventsTextForClassify);
      // Pure capacity is ops admission, not a product block: clear the label so
      // re-admission after a slot frees does not thrash on an already-blocked
      // early-exit (#718). Clear MUST succeed before capacity_wait is safe for a
      // later re-dispatch that lacks a fresh blocker_set — a pending revert with
      // blocked still set used to become needs-human on the next early-exit
      // (review 9873320c). We still emit capacity_wait on clear failure so THIS
      // cycle keeps ops admission (not needs-human); the durable
      // pipeline-blocker-kind marker on the blocked comment is the capacity
      // discriminator that prevents the next-cycle cascade.
      if (outcome === "capacity_wait") {
        try {
          await clearBlockedFn(cfg, issueNumber);
        } catch (clearErr) {
          const msg = clearErr instanceof Error ? clearErr.message : String(clearErr);
          console.error(
            `[pipeline] #${issueNumber}: clearBlocked failed after capacity disposition: ${msg}; ` +
              `emitting capacity_wait with blocked label still present — durable ` +
              `blocker-kind on the issue comment must classify the next re-dispatch as capacity`,
          );
          // Do not convert to failed: the supervisor routes failed into
          // engine-defect recovery / run_fatal. capacity_wait keeps ops
          // admission for this cycle; the durable marker classifies the next
          // early-blocked re-dispatch as capacity (see lastBlockerKindFromComments).
        }
      }
      const pr = await getPrForIssueFn(cfg, issueNumber).catch(() => null);
      prNumber = pr ?? null;
    } catch {
      outcome = "failed";
    }

    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: normalizeLoopOutcome(outcome),
      evidence: buildLoopEvidencePointer({
        pr_number: prNumber,
        item_id: request.item_id,
        loop_run_id: request.run_id,
        pin,
        // Only advertise a live events path when the store was confirmed.
        events_path_known: storeReady,
      }),
      ...(diagnostic ? { diagnostic } : {}),
    };
  };
}

/** Injectable seam for {@link realGetChangedFiles} — defaults to the real
 *  on-disk worktree lookup and `git diff`, overridable so unit tests exercise
 *  the changed-file mapping/filtering with no real filesystem/git access. */
export interface RealGetChangedFilesDeps {
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  gitInWorktree?: typeof gitInWorktree;
}

/** The real live changed-file-overlap observer (#530 review 1, finding
 *  ffbf2be1): resolves an item's on-disk managed worktree (zero gh API calls
 *  via {@link getOnDiskForIssue}) and diffs it against the configured base
 *  branch. Returns an empty list when the item has no on-disk worktree yet —
 *  the overlap check this feeds is a post-run safety net over declared
 *  ownership, so "nothing observed yet" degrades to "no overlap observed"
 *  rather than throwing and failing an otherwise-successful cycle. */
export function realGetChangedFiles(cfg: PipelineConfig, deps: RealGetChangedFilesDeps = {}): SupervisorDeps["getChangedFiles"] {
  const getOnDiskForIssueFn = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const gitInWorktreeFn = deps.gitInWorktree ?? gitInWorktree;
  return async (itemId: string): Promise<string[]> => {
    const issueNumber = Number(itemId);
    const wt = await getOnDiskForIssueFn(cfg, issueNumber);
    if (!wt) return [];
    const result = await gitInWorktreeFn(wt.path, ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`], { ignoreFailure: true });
    return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  };
}

type ExecuteRecoveryInput = Parameters<NonNullable<SupervisorDeps["executeRecovery"]>>[0];

export interface RealExecuteRecoveryDeps {
  getIssueDetail?: typeof getIssueDetail;
  getGhActor?: typeof getGhActor;
  clearBlocked?: typeof clearBlocked;
  repairPipelineItem?: (input: RepairPipelineItemInput) => Promise<RepairPipelineItemResult>;
  /** Injectable HEAD read for verify_head_goal (#758). */
  gitHead?: (wtPath: string) => Promise<string>;
  /**
   * Injectable worktree cleanliness probe for verify_head_goal (#758 R1).
   * Returns true only when the tree is clean relative to HEAD (no uncommitted
   * work). Failures must return false (fail closed).
   */
  isWorktreeClean?: (wtPath: string) => Promise<boolean>;
  /** Injectable git-in-worktree for unlink_engine_scratch (#1020 / #1028). */
  gitInWorktree?: typeof gitInWorktree;
  /**
   * After first successful engine-scratch recover, file a live milestone sibling
   * (#1021 / #1028). Non-fatal: failures must not reverse the recover.
   */
  onEngineClassRecovered?: (input: {
    issueNumber: number;
    evidenceKey: string;
    action: string;
  }) => Promise<void>;
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  /**
   * Rematerialize an absent managed worktree onto the verified PR / remote
   * tip during stale-tip `resync_workflow_state` (#1103). Tests inject fakes.
   */
  ensureManagedWorktree?: typeof ensureManagedWorktree;
  /**
   * Open-PR head resolver for stale-tip currency. Defaults to
   * {@link resolveOpenPrHeadForBranch}. Tests inject fakes.
   */
  resolveOpenPrHeadForBranch?: typeof resolveOpenPrHeadForBranch;
  /**
   * @deprecated Prefer probeImplementDeliverable. Kept so older test stubs
   * still type-check; recovery no longer treats non-empty listChangeDirs as
   * deliverable proof (#758 R2).
   */
  listChangeDirs?: (dir: string) => string[];
  /**
   * Paths changed on the issue branch vs base (default: git diff
   * origin/<base>...HEAD). Used by the default deliverable probe to bind
   * identity to the issue branch rather than any leftover change dir (#758 R2).
   */
  listBranchChangedPaths?: (wtPath: string) => Promise<string[]>;
  /**
   * True when an OpenSpec change id has the minimum accepted planning
   * artifacts (proposal.md). Used by the default deliverable probe (#758 R2).
   */
  changeHasDeliverableArtifacts?: (wtPath: string, changeId: string) => boolean;
  /**
   * Issue-bound implement deliverable probe. Default: branch-introduced
   * OpenSpec change ids that still exist and have proposal.md. Injectable so
   * unit tests do not need a real worktree filesystem (#758 R2).
   */
  probeImplementDeliverable?: (
    wtPath: string,
    issueNumber: number,
  ) => Promise<{ present: boolean; description?: string }>;
  /**
   * Applicable format/test gates at the claimed HEAD. Must not be hard-coded
   * true — recovery certifies implement-deliverable-present only when this
   * probe proves green (#758 R2).
   */
  probeGatesGreen?: (wtPath: string, issueNumber: number) => Promise<boolean>;
  /**
   * Format gate runner for the default probeGatesGreen implementation.
   * Signature matches `runFormatGate` (status ok | blocked).
   */
  runFormatGate?: (
    wtPath: string,
    config: Pick<PipelineConfig, "format_gate">,
    issueNumber: number,
  ) => Promise<{ status: "ok"; committed: boolean } | { status: "blocked"; reason: string }>;
  /**
   * Test gate runner for the default probeGatesGreen implementation.
   * Signature matches `runTestGate` (passed / skipped fields used).
   */
  runTestGate?: (
    cfg: PipelineConfig,
    issueNumber: number,
    wtPath: string,
  ) => Promise<{ skipped: boolean; passed?: boolean }>;
  postComment?: typeof postComment;
  ownership?: OwnershipDeps;
  /** #1272: inspect/execute unpublished stage-commit publish. */
  publishUnpublished?: PublishUnpublishedExecutorDeps;
}

/** Production provider-neutral recovery registry. Substantive repair delegates
 * to the configured whole-item implementer transaction; narrow recipes only
 * clear a current mechanical block and verify that exact state transition. */
export function realExecuteRecovery(
  cfg: PipelineConfig,
  deps: RealExecuteRecoveryDeps = {},
): NonNullable<SupervisorDeps["executeRecovery"]> {
  const getDetail = deps.getIssueDetail ?? getIssueDetail;
  const verifyAuthentication = deps.getGhActor ?? getGhActor;
  const clear = deps.clearBlocked ?? clearBlocked;
  const repairPipelineItem = deps.repairPipelineItem ?? createRepairPipelineItemExecutor(cfg);
  const getWorktree = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const ensureWorktree = deps.ensureManagedWorktree ?? ensureManagedWorktree;
  const resolvePrHead = deps.resolveOpenPrHeadForBranch ?? resolveOpenPrHeadForBranch;
  const post = deps.postComment ?? postComment;
  const gitInWt = deps.gitInWorktree ?? gitInWorktree;
  const gitHead =
    deps.gitHead ??
    (async (wtPath: string) =>
      (await gitInWt(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim());
  const isWorktreeClean =
    deps.isWorktreeClean ??
    (async (wtPath: string) => {
      // Fail closed: non-zero status or any porcelain output ⇒ not clean.
      const status = await gitInWt(
        wtPath,
        ["status", "--porcelain", "--untracked-files=all"],
        { ignoreFailure: true },
      );
      if (status.code !== 0) return false;
      return status.stdout.trim() === "";
    });
  // Branch-introduced paths — not tip-wide listChangeDirs — so an unrelated
  // leftover under openspec/changes/ cannot satisfy the implement goal (#758 R2).
  const listBranchChangedPaths =
    deps.listBranchChangedPaths ??
    (async (wtPath: string) => {
      const result = await gitInWorktree(
        wtPath,
        ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
        { ignoreFailure: true },
      );
      if (result.code !== 0) return [];
      return result.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    });
  const changeHasDeliverableArtifacts =
    deps.changeHasDeliverableArtifacts ??
    ((wtPath: string, changeId: string) =>
      openspec.readChangeFile(wtPath, changeId, "proposal.md") !== null);
  const probeImplementDeliverable =
    deps.probeImplementDeliverable ??
    (async (wtPath: string, _issueNumber: number) => {
      const branchPaths = await listBranchChangedPaths(wtPath);
      const branchChangeIds = openspec
        .changeIdsFromPaths(branchPaths)
        .filter((id) => openspec.changeDirExists(wtPath, id));
      const acceptedIds = branchChangeIds.filter((id) =>
        changeHasDeliverableArtifacts(wtPath, id),
      );
      if (acceptedIds.length === 0) {
        return { present: false as const };
      }
      return {
        present: true as const,
        description: `branch-introduced OpenSpec deliverable(s) at HEAD: ${acceptedIds.join(", ")}`,
      };
    });
  // Applicable gates at claimed HEAD — never hard-code true (#758 R2).
  // Format is checked non-mutating (auto_fix forced off). Test gate runs with
  // max_attempts: 0 so a red suite fails closed without charging model repair.
  const probeGatesGreen =
    deps.probeGatesGreen ??
    (async (wtPath: string, issueNumber: number) => {
      const formatEntries = cfg.format_gate ?? [];
      if (formatEntries.length > 0) {
        const { runFormatGate } = await import("./stages/format-gate.ts");
        const runFmt = deps.runFormatGate ?? runFormatGate;
        const checkCfg = {
          ...cfg,
          format_gate: formatEntries.map((e) => ({
            command: e.command,
            auto_fix: false,
          })),
        };
        const fmt = await runFmt(wtPath, checkCfg, issueNumber);
        if (fmt.status === "blocked") return false;
      }
      if (!cfg.test_gate?.enabled) return true;
      const { runTestGate } = await import("./testgate.ts");
      const runTest = deps.runTestGate ?? runTestGate;
      const testCfg = {
        ...cfg,
        test_gate: { ...cfg.test_gate, max_attempts: 0 },
      };
      const gate = await runTest(testCfg, issueNumber, wtPath);
      return Boolean(gate.skipped || gate.passed);
    });

  const failed = (error: string): RepairPipelineItemResult => ({
    succeeded: false,
    evidence: error,
    error,
  });

  /**
   * #758: first deterministic implementation-ci recipe for no-commits — shared
   * HEAD goal-satisfaction evaluation. Does NOT charge model-repair budget
   * (this recipe is not repair_pipeline_item). On advance: attested evidence +
   * clear blocked for redispatch. On escalate: fail so the next recipe runs.
   */
  const verifyHeadGoal = async (
    input: ExecuteRecoveryInput,
  ): Promise<RepairPipelineItemResult> => {
    const issueNumber = Number(input.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return failed(`verify_head_goal requires a positive numeric item id`);
    }
    const blockerKind = input.diagnostic.detail.blocker_kind;
    const stage = input.diagnostic.detail.stage ?? "implementing";
    // Only no-commits (and equivalent implementation-outcome) blocks are in
    // scope for goal-satisfaction recovery; other implementation-ci kinds fall
    // through so later recipes (rerun_ci / repair) can run.
    if (blockerKind !== "no-commits") {
      return failed(
        `verify_head_goal does not apply to blocker_kind=${blockerKind}; trying next recipe`,
      );
    }
    const wt = await getWorktree(cfg, issueNumber);
    if (!wt) {
      return failed(`verify_head_goal: no managed worktree for #${issueNumber}`);
    }
    const headSha = await gitHead(wt.path);
    if (!headSha) {
      return failed(`verify_head_goal: cannot read HEAD for #${issueNumber}`);
    }
    // Deterministic worktree cleanliness — never hard-code clean (#758 R1 F1).
    const worktreeClean = await isWorktreeClean(wt.path);
    if (!worktreeClean) {
      return failed(
        `verify_head_goal: worktree not clean for #${issueNumber}; cannot certify goal satisfaction`,
      );
    }
    // Stage-supplied goal checks — same classes as normal stage execution.
    // Implementing: branch-introduced OpenSpec deliverable + clean tree +
    // applicable gates proven green via injectable probes (#758 R2).
    // Other stages without a recovery-time checker escalate (fail closed).
    const goalCheck = async () => {
      if (stage === "implementing" || stage === "planning" || stage === "plan-review") {
        const deliverable = await probeImplementDeliverable(wt.path, issueNumber);
        const gatesGreen = await probeGatesGreen(wt.path, issueNumber);
        return implementDeliverablePresentGoalCheck({
          deliverablePresent: deliverable.present,
          worktreeClean: true,
          gatesGreen,
          deliverableDescription: deliverable.description,
        });
      }
      // Fix/pre-merge recovery goal checks need live review partition state;
      // without it, fail closed so repair_pipeline_item can still run.
      return {
        satisfied: false as const,
        note: `verify_head_goal: no recovery-time goal checker for stage ${stage}`,
        rationaleClass: "fix-no-actionable-work",
      };
    };
    const result = await evaluatePostHarnessNoNewCommit({
      headBefore: headSha,
      headAfter: headSha,
      salvaged: false,
      // Worktree proven clean above — same signal as salvageFoundNothing.
      salvageFoundNothing: true,
      stage,
      issueNumber,
      goalCheck,
    });
    if (result.decision !== "advance") {
      return failed(
        `verify_head_goal: HEAD does not satisfy stage goal` +
          (result.decision === "escalate" ? ` (${result.note})` : ` (${result.reason})`),
      );
    }
    // Durable attested evidence is required before clearing the block
    // (#758 R1 finding 3). Swallowing a post failure would redispatch without
    // an audit trail readable on subsequent re-entry.
    try {
      await post(cfg, issueNumber, formatNoopAdvanceEvidenceNote(result.evidence));
    } catch (err) {
      return failed(
        `verify_head_goal: stage goal satisfied but durable evidence could not be recorded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      await clear(cfg, issueNumber);
    } catch (err) {
      return failed(
        `verify_head_goal advanced but could not clear blocked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      succeeded: true,
      evidence:
        `verify_head_goal: stage goal already satisfied at ${headSha.slice(0, 12)} ` +
        `(${result.evidence.rationaleClass}); cleared blocked without model repair`,
      // Same head — not a candidate-changing repair; supervisor must not require
      // a new remote head for this recipe (only repair_pipeline_item does).
      candidateHead: headSha,
    };
  };

  /**
   * #1103: when resync_workflow_state is claimed for a stale-tip /
   * non-fast-forward park, move a present-but-stale managed worktree to the
   * verified PR / remote head (or rematerialize an absent tree). Never
   * force-push. Dirty / local-only unique work refuses typed.
   */
  const resyncStaleTipWorktree = async (
    issueNumber: number,
  ): Promise<RepairPipelineItemResult> => {
    const wt = await getWorktree(cfg, issueNumber);
    if (!wt) {
      const remat: EnsureManagedWorktreeResult = await ensureWorktree(cfg, issueNumber, {
        getOnDiskForIssue: getWorktree,
        resolveOpenPrHeadForBranch: resolvePrHead,
        gitInWorktree: gitInWt,
      });
      if (remat.result === "fail") {
        const missing =
          remat.blockerKind === "worktree-missing" ||
          /no recoverable remote|cannot rematerialize/i.test(remat.reason);
        return failed(
          missing
            ? `unverified-remote-head: ${remat.reason}`
            : `resync_workflow_state rematerialize failed (${remat.blockerKind}): ${remat.reason}`,
        );
      }
      return {
        succeeded: true,
        evidence:
          `resync_workflow_state rematerialized the absent managed worktree onto the ` +
          `verified PR / remote tip (${remat.reason})`,
      };
    }

    const branch = branchName(issueNumber, wt.slug);
    const git = async (args: string[]) => gitInWt(wt.path, args, { ignoreFailure: true });
    const verified = await resolveVerifiedRemoteHead(branch, {
      git,
      resolveOpenPrHead: async () => {
        const pr = await resolvePrHead(cfg, branch);
        return pr?.headSha ?? null;
      },
    });
    if (!verified.ok) {
      return failed(
        `unverified-remote-head: neither an open-PR head nor origin/${branch} could be verified; refusing reset`,
      );
    }

    const status = await git(["status", "--porcelain", "--untracked-files=all"]);
    if (status.code !== 0 || status.stdout.trim() !== "") {
      return failed(
        `dirty-worktree: refusing rematerialize/reset of ${wt.path} (would destroy uncommitted work)`,
      );
    }

    const ancestor = await isAncestorOfVerifiedHead(git, "HEAD", verified.sha);
    if (ancestor !== true) {
      return failed(
        ancestor === null
          ? `local-only-unpushed: cannot verify ancestry of HEAD vs ${verified.sha.slice(0, 7)}; refusing reset`
          : `local-only-unpushed: HEAD is not an ancestor of verified tip ${verified.sha.slice(0, 7)}; refusing reset (no force-push)`,
      );
    }

    const head = await git(["rev-parse", "HEAD"]);
    const localSha = head.stdout.trim();
    if (localSha && localSha === verified.sha) {
      return {
        succeeded: true,
        evidence:
          `resync_workflow_state: managed worktree HEAD already matches verified tip ` +
          `${verified.sha.slice(0, 7)} (${verified.source})`,
      };
    }

    const ff = await git(["merge", "--ff-only", verified.sha]);
    if (ff.code !== 0) {
      const reset = await git(["reset", "--hard", verified.sha]);
      if (reset.code !== 0) {
        return failed(
          `resync_workflow_state: fast-forward and reset --hard to ${verified.sha.slice(0, 7)} failed; no force-push`,
        );
      }
    }
    return {
      succeeded: true,
      evidence:
        `resync_workflow_state moved managed worktree HEAD to verified ` +
        `${verified.source} tip ${verified.sha.slice(0, 7)}`,
    };
  };

  const resyncMechanicalBlock = async (
    input: ExecuteRecoveryInput,
  ): Promise<RepairPipelineItemResult> => {
    const issueNumber = Number(input.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return failed(`recovery action ${input.action} requires a positive numeric item id`);
    }

    const staleTip =
      input.action === "resync_workflow_state" &&
      input.blockerClass === "workflow-state" &&
      isStaleTipPushEvidence({
        reasonCode: input.diagnostic.reason_code,
        blockerKind: input.diagnostic.detail.blocker_kind,
        reason: input.diagnostic.detail.reason,
      });
    if (staleTip) {
      const currency = await resyncStaleTipWorktree(issueNumber);
      if (!currency.succeeded) return currency;
    }

    let before: Awaited<ReturnType<typeof getIssueDetail>>;
    try {
      before = await getDetail(cfg, issueNumber);
    } catch (err) {
      return failed(`cannot inspect live item before ${input.action}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (before.state !== "open") {
      return failed(`item ${input.itemId} is ${before.state}; refusing recovery mutation`);
    }
    if (!before.labels.includes(BLOCKED_LABEL)) {
      return {
        succeeded: true,
        evidence: `recovery action ${input.action} observed the mechanical blocked state already clear; normal whole-item redispatch may proceed`,
      };
    }
    // Stale needs-human from the human-ack gate only. Other needs-human
    // parks (review ceiling, default setBlocked) do not post this warning
    // and keep the existing mechanical clear. Pipeline review output is a
    // false human; operator-scope-change stays parked.
    if (input.diagnostic.detail.blocker_kind === "needs-human") {
      const comments = Array.isArray(before.comments) ? before.comments : null;
      if (comments === null) {
        return failed(
          `recovery action ${input.action} cannot re-evaluate human-ack: issue comments were not available`,
        );
      }
      const hasAckWarning = comments.some((c) =>
        c.body.trimStart().startsWith("## Pipeline: New human input detected"),
      );
      if (hasAckWarning) {
        let actor: string | null;
        try {
          actor = await verifyAuthentication();
        } catch (err) {
          return failed(
            `recovery action ${input.action} cannot re-evaluate human-ack: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        const trusted = buildTrustedOverrideComments(
          comments,
          actor,
          cfg.trusted_override_actors,
        );
        const ackAction = humanAckRecoveryAction(classifyPostPlanComments(comments, trusted));
        if (ackAction === "keep-human") {
          return failed(
            `recovery action ${input.action} re-evaluated human-ack: operator-scope-change remains (not a mechanical false human)`,
          );
        }
        if (ackAction === "replan") {
          return failed(
            `recovery action ${input.action} re-evaluated human-ack: ambiguous-trusted requires in-engine re-plan (not a mechanical clear)`,
          );
        }
      }
    }
    try {
      await clear(cfg, issueNumber);
      const after = await getDetail(cfg, issueNumber);
      if (after.labels.includes(BLOCKED_LABEL)) {
        return failed(`recovery action ${input.action} returned but the blocked label remains`);
      }
    } catch (err) {
      return failed(`recovery action ${input.action} could not clear the mechanical blocked state: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      succeeded: true,
      evidence: staleTip
        ? `recovery action ${input.action} rematerialized or fast-forwarded the managed worktree to the verified PR / remote tip, cleared the mechanical blocked state, and verified normal whole-item redispatch is admissible`
        : `recovery action ${input.action} cleared the mechanical blocked state and verified normal whole-item redispatch is admissible`,
    };
  };

  /**
   * #1020 / #1028 / #1060: deterministic unlink of engine-owned non-product scratch.
   * - workflow-engine-defect: terminal scratch-only recover (unlink + clear blocked).
   * - review-findings: preparatory only — unlink when present, never clear blocked,
   *   never succeed as findings recovery; fall through so repair_pipeline_item runs.
   * Does not invoke the implementer; product dirt fails closed so later recipes run.
   */
  const unlinkEngineScratch = async (
    input: ExecuteRecoveryInput,
  ): Promise<RepairPipelineItemResult> => {
    const issueNumber = Number(input.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return failed(`unlink_engine_scratch requires a positive numeric item id`);
    }
    // Human-decision evidence must never take this path.
    if (input.blockerClass === "specification-decision" || input.blockerClass === "missing-authority") {
      return failed(`unlink_engine_scratch does not apply to human-authority class ${input.blockerClass}`);
    }
    const findingsPrep = input.blockerClass === "review-findings";
    const wt = await getWorktree(cfg, issueNumber);
    if (!wt) {
      return failed(`unlink_engine_scratch: no managed worktree for #${issueNumber}`);
    }
    const extraGlobs = cfg.test_gate?.non_product_dirty_globs ?? [];
    const status = await gitInWt(
      wt.path,
      ["status", "--porcelain", "--untracked-files=all"],
      { ignoreFailure: true },
    );
    if (status.code !== 0) {
      return failed(
        `unlink_engine_scratch: git status failed (exit ${status.code}); cannot classify porcelain`,
      );
    }
    const classified = classifyPorcelainForScratchRecover(status.stdout, extraGlobs);
    if (classified.product.length > 0) {
      return failed(
        `unlink_engine_scratch: product dirt remains (${classified.product.slice(0, 5).join(", ")}); ` +
          `not engine-scratch-only — trying next recipe`,
      );
    }
    // Require current engine-scratch evidence. Clean porcelain or non-scratch
    // workflow-engine failures must fall through to restart/repair — never
    // clear blocked solely because the tree is already clean (#1028 review).
    // #1060 findings prep: same not-applicable fall-through so repair still runs.
    if (classified.untrackedScratch.length === 0) {
      return failed(
        findingsPrep
          ? `unlink_engine_scratch: prep not-applicable for review-findings (no engine-scratch paths) — trying next recipe`
          : `unlink_engine_scratch: no current engine-scratch paths; not scratch-only evidence — trying next recipe`,
      );
    }
    const unlinked: string[] = [];
    for (const scratchPath of classified.untrackedScratch) {
      const clean = await gitInWt(
        wt.path,
        ["clean", "-fd", "--", scratchPath],
        { ignoreFailure: true },
      );
      if (clean.code === 0) unlinked.push(scratchPath);
    }
    // Re-check: product must stay empty after unlink.
    const afterStatus = await gitInWt(
      wt.path,
      ["status", "--porcelain", "--untracked-files=all"],
      { ignoreFailure: true },
    );
    if (afterStatus.code !== 0) {
      return failed(`unlink_engine_scratch: post-unlink git status failed`);
    }
    const after = classifyPorcelainForScratchRecover(afterStatus.stdout, extraGlobs);
    if (after.product.length > 0) {
      return failed(
        `unlink_engine_scratch: product dirt present after unlink (${after.product.slice(0, 5).join(", ")})`,
      );
    }
    if (after.untrackedScratch.length > 0) {
      return failed(
        `unlink_engine_scratch: scratch paths remain after clean (${after.untrackedScratch.join(", ")})`,
      );
    }

    // #1060: under review-findings, unlink is preparatory only. Do not clear
    // pipeline:blocked, do not file sibling as recovered, do not succeed —
    // same-sequence controller continues to repair_pipeline_item.
    if (findingsPrep) {
      return failed(
        `unlink_engine_scratch: prep-complete for review-findings; removed engine scratch ` +
          `[${unlinked.join(", ")}] — findings still require repair_pipeline_item (trying next recipe)`,
      );
    }

    // Clear mechanical blocked when present (scratch-only workflow-engine-defect cause).
    let before: Awaited<ReturnType<typeof getIssueDetail>>;
    try {
      before = await getDetail(cfg, issueNumber);
    } catch (err) {
      return failed(
        `unlink_engine_scratch: cannot inspect live item: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (before.labels.includes(BLOCKED_LABEL)) {
      try {
        await clear(cfg, issueNumber);
        const afterDetail = await getDetail(cfg, issueNumber);
        if (afterDetail.labels.includes(BLOCKED_LABEL)) {
          return failed(`unlink_engine_scratch: cleared but blocked label remains`);
        }
      } catch (err) {
        return failed(
          `unlink_engine_scratch: could not clear blocked: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const evidenceKey =
      (typeof input.diagnostic.evidence_key === "string" && input.diagnostic.evidence_key.trim()) ||
      `engine-scratch:${issueNumber}:${unlinked.sort().join(",") || "clean"}`;
    const notifySibling = async () => {
      if (deps.onEngineClassRecovered) {
        await deps.onEngineClassRecovered({
          issueNumber,
          evidenceKey,
          action: "unlink_engine_scratch",
        });
        return;
      }
      // Default: best-effort live sibling on current train milestone (#1021).
      try {
        const { autoFileEngineClassLiveSibling, realEngineClassLiveSiblingDeps, getTrainMilestoneContext } =
          await import("./stages/engine-class-live-sibling.ts");
        await autoFileEngineClassLiveSibling(
          {
            recoveredIssue: issueNumber,
            evidenceKey,
            milestone: getTrainMilestoneContext(),
            domain: cfg.domain,
            windowHours: cfg.papercuts?.auto_file_window_hours ?? 24,
            maxPerWindow: cfg.papercuts?.auto_file_max_per_window ?? 3,
          },
          realEngineClassLiveSiblingDeps(cfg.repo_dir),
        );
      } catch {
        // Non-fatal
      }
    };
    try {
      await notifySibling();
    } catch {
      // Non-fatal: sibling filing must not reverse recover success.
    }
    return {
      succeeded: true,
      evidence:
        `unlink_engine_scratch: removed engine scratch [${unlinked.join(", ")}] and cleared mechanical block when present`,
    };
  };

  const checkpointOwnedHarnessDirtRecipe = async (
    input: ExecuteRecoveryInput,
  ): Promise<RepairPipelineItemResult> => {
    const issueNumber = Number(input.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return failed(`checkpoint_owned_harness_dirt requires a positive numeric item id`);
    }
    if (input.blockerClass === "specification-decision" || input.blockerClass === "missing-authority") {
      return failed(`checkpoint_owned_harness_dirt does not apply to human-authority class ${input.blockerClass}`);
    }
    const wt = await getWorktree(cfg, issueNumber);
    if (!wt) {
      return failed(`checkpoint_owned_harness_dirt: no managed worktree for #${issueNumber}`);
    }
    const extraGlobs = cfg.test_gate?.non_product_dirty_globs ?? [];
    const rec = await loadOwnershipRecord({
      repoDir: cfg.repo_dir,
      domain: cfg.domain ?? "",
      issue: issueNumber,
    }, deps.ownership);
    const status = await gitInWt(
      wt.path,
      ["status", "--porcelain", "--untracked-files=all"],
      { ignoreFailure: true },
    );
    if (status.code !== 0) {
      return failed(
        `checkpoint_owned_harness_dirt: git status failed (exit ${status.code})`,
      );
    }
    const classified = classifyHarnessMutationDirt({
      porcelain: status.stdout,
      record: rec,
      extraGlobs,
    });
    if (classified.ownedLeftover.length === 0) {
      return failed(
        `checkpoint_owned_harness_dirt: no current owned leftovers — trying next recipe`,
      );
    }
    const pipelineRunId = input.runId || makePipelineRunId(issueNumber);
    const ck = await checkpointOwnedHarnessDirt({
      wtPath: wt.path,
      issueNumber,
      pipelineRunId,
      stageLabel: rec?.stage ?? "implement",
      ownedPaths: classified.ownedLeftover,
    }, deps.ownership);
    if (!ck.checkpointed) {
      return failed(
        `checkpoint_owned_harness_dirt: salvage failed${ck.failureReason ? `: ${ck.failureReason}` : ""}`,
      );
    }
    if (rec) {
      await emitOwnershipEvidence({
        repoDir: cfg.repo_dir,
        domain: cfg.domain ?? "",
        issue: issueNumber,
        record: { ...rec, in_flight: false },
        disposition: classified.unknownProduct.length > 0 ? "checkpointed" : "recovered",
        ownedPathCount: classified.ownedLeftover.length,
        unknownPaths: classified.unknownProduct,
      }).catch(() => {});
    }
    try {
      await clear(cfg, issueNumber);
    } catch (err) {
      return failed(
        `checkpoint_owned_harness_dirt: could not clear blocked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      succeeded: true,
      evidence:
        `checkpoint_owned_harness_dirt: checkpointed owned leftover paths [${classified.ownedLeftover.slice(0, 8).join(", ")}]`,
    };
  };

  return async (input) => {
    const projection = projectStageDiagnostic(input.diagnostic);
    if (projection.disposition !== "recover" || projection.blockerClass !== input.blockerClass) {
      return failed(
        `recovery action ${input.action} refused diagnostic disposition ${projection.disposition} for class ${input.blockerClass}`,
      );
    }
    switch (input.action) {
      case "repair_pipeline_item":
        return repairPipelineItem({
          runId: input.runId,
          itemId: input.itemId,
          attemptId: input.attemptId,
          candidateIdentity: input.candidateIdentity,
          diagnostic: input.diagnostic,
        });
      case "verify_head_goal":
        return verifyHeadGoal(input);
      case "unlink_engine_scratch":
        return unlinkEngineScratch(input);
      case "checkpoint_owned_harness_dirt":
        return checkpointOwnedHarnessDirtRecipe(input);
      case "publish_unpublished_stage_commit": {
        const issueNumber = Number(input.itemId);
        if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
          return failed(`${PUBLISH_UNPUBLISHED_STAGE_COMMIT} requires a positive numeric item id`);
        }
        if (input.blockerClass === "specification-decision" || input.blockerClass === "missing-authority") {
          return failed(
            `${PUBLISH_UNPUBLISHED_STAGE_COMMIT} does not apply to human-authority class ${input.blockerClass}`,
          );
        }
        const published = await executePublishUnpublishedStageCommit(cfg, issueNumber, {
          ...(deps.publishUnpublished ?? {}),
          inspectDeps: {
            ...(deps.publishUnpublished?.inspectDeps ?? {}),
            getOnDiskForIssue: deps.getOnDiskForIssue ?? getOnDiskForIssue,
            gitInWorktree: gitInWt,
            extraGlobs: cfg.test_gate?.non_product_dirty_globs ?? [],
          },
          getIssueDetail: getDetail,
          clearBlocked: clear,
          probeImplementDeliverable:
            deps.publishUnpublished?.probeImplementDeliverable ?? probeImplementDeliverable,
        });
        if (!published.succeeded) {
          return failed(published.error ?? published.evidence);
        }
        return {
          succeeded: true,
          evidence: published.evidence,
        };
      }
      case "wait_and_retry":
      case "rerun_ci":
      case "resync_workflow_state":
      case "retry_upstream_check":
      case "restart_workflow_engine":
        return resyncMechanicalBlock(input);
      case "verify_authentication": {
        let actor: string | null;
        try {
          actor = await verifyAuthentication();
        } catch (err) {
          return failed(
            `authentication is not currently usable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!actor?.trim()) {
          return failed("authentication is not currently usable: the authenticated actor could not be resolved");
        }
        return resyncMechanicalBlock(input);
      }
    }
  };
}

/** One open issue's labels/milestone, as needed to resolve a `milestone` or
 *  `label` selector into a concrete work list. */
export interface SelectorOpenIssue {
  number: number;
  labels: string[];
  milestone: string | null;
}

/** IO seam for {@link resolveSelectorIssues}: listing open issues (for
 *  milestone/label selectors) and reading ROADMAP.md (for roadmap-slice
 *  selectors) — injected so unit tests resolve selectors with no real gh or
 *  filesystem access. */
export interface SelectorResolveDeps {
  listOpenIssues: (cfg: PipelineConfig) => Promise<SelectorOpenIssue[]>;
  readRoadmap: (cfg: PipelineConfig) => Promise<string>;
}

export function realSelectorResolveDeps(): SelectorResolveDeps {
  return {
    listOpenIssues: async (cfg: PipelineConfig): Promise<SelectorOpenIssue[]> => {
      const result = spawnSync(
        "gh",
        ["issue", "list", "--state", "open", "--json", "number,labels,milestone", "--limit", "500"],
        { encoding: "utf8", stdio: "pipe", cwd: cfg.repo_dir },
      );
      if (result.status !== 0) {
        throw new Error(`gh issue list failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`);
      }
      const items = JSON.parse(result.stdout.trim() || "[]") as Array<{
        number: number;
        labels: Array<{ name: string }>;
        milestone: { title: string } | null;
      }>;
      return items.map((item) => ({
        number: item.number,
        labels: item.labels.map((l) => l.name),
        milestone: item.milestone?.title ?? null,
      }));
    },
    readRoadmap: async (cfg: PipelineConfig): Promise<string> =>
      readFileSync(path.join(cfg.repo_dir, "ROADMAP.md"), "utf8"),
  };
}

/** Extracts the issue numbers referenced under a named roadmap slice —
 *  a `**<slice> — ...:**` heading in ROADMAP.md (e.g. `**v1.16.0 — ...**`) —
 *  from its table rows, stopping at the next top-level heading or slice. A
 *  heading marked `(shipped ...)` is never matched: this repo's own
 *  ROADMAP.md reuses a version number between an already-shipped heading and
 *  a still-forward slice of the same name (e.g. two `v1.16.0` headings), and
 *  a loop run must only ever select unshipped work. An unshipped slice's
 *  table leads each row with a bare `| #NNN | What | Why |` issue reference —
 *  the first `#NNN` on the row is taken as the issue number. Deduplicated and
 *  sorted ascending so the resulting work list (and its derived run id) is
 *  deterministic. */
export function extractRoadmapSliceIssues(roadmapText: string, slice: string): number[] {
  const headingRe = /^\*\*(\S+)\s+—/;
  let capturing = false;
  const issues = new Set<number>();
  for (const rawLine of roadmapText.split("\n")) {
    const line = rawLine.trim();
    const heading = headingRe.exec(line);
    if (heading) {
      capturing = heading[1] === slice && !/\(shipped\b/i.test(line);
      continue;
    }
    if (line.startsWith("#")) {
      capturing = false;
      continue;
    }
    if (!capturing || !line.startsWith("|")) continue;
    const match = /#(\d+)/.exec(line);
    if (match) issues.add(Number(match[1]));
  }
  return [...issues].sort((a, b) => a - b);
}

/** Result of resolving a loop selector for fresh work-list compile: issue ids
 *  plus any declared roadmap/slice edges available from the compile context. */
export interface ResolvedSelectorWorkList {
  issues: string[];
  /** Declared issue-level edges from ROADMAP.md / slice graph when available. */
  roadmapDeclaredEdges: readonly RoadmapDeclaredEdge[];
}

async function tryLoadRoadmapDeclaredEdges(
  cfg: PipelineConfig,
  deps: SelectorResolveDeps,
  /** When the caller already has roadmap text (roadmap-slice), reuse it. */
  knownRoadmapText?: string,
): Promise<readonly RoadmapDeclaredEdge[]> {
  try {
    const text = knownRoadmapText ?? (await deps.readRoadmap(cfg));
    return extractRoadmapDeclaredEdges(text);
  } catch {
    // Fail closed: missing/unreadable ROADMAP contributes no edges.
    return [];
  }
}

/** Resolves any {@link LoopSelector} into issue ids + optional roadmap edges
 *  for declared-dependency population at fresh compile (#615). */
export async function resolveSelectorWorkList(
  cfg: PipelineConfig,
  selector: LoopSelector,
  deps: SelectorResolveDeps,
): Promise<ResolvedSelectorWorkList> {
  if (selector.type === "work-list") {
    return {
      issues: selector.value,
      roadmapDeclaredEdges: await tryLoadRoadmapDeclaredEdges(cfg, deps),
    };
  }

  if (selector.type === "milestone" || selector.type === "label") {
    const issues = await deps.listOpenIssues(cfg);
    // Exclude pipeline:epic umbrellas from default milestone/label selectors (#766).
    // Explicit work-list selectors are unchanged (handled above).
    const matches = issues
      .filter((i) => (selector.type === "milestone" ? i.milestone === selector.value : i.labels.includes(selector.value)))
      .filter((i) => !isEpicLabeled(i.labels))
      .map((i) => i.number)
      .sort((a, b) => a - b);
    if (matches.length === 0) {
      throw new Error(`no open issues found for ${selector.type} "${selector.value}"`);
    }
    return {
      issues: matches.map(String),
      roadmapDeclaredEdges: await tryLoadRoadmapDeclaredEdges(cfg, deps),
    };
  }

  const roadmapText = await deps.readRoadmap(cfg);
  const matches = extractRoadmapSliceIssues(roadmapText, selector.value);
  if (matches.length === 0) {
    throw new Error(`roadmap slice "${selector.value}" was not found in ROADMAP.md, or references no issues`);
  }
  // Exclude pipeline:epic parents listed in a slice; children remain eligible (#766).
  // Fail closed when inventory cannot be loaded — fail-open would schedule umbrella
  // epics contrary to deterministic exclusion (review finding ff4513be).
  let open: SelectorOpenIssue[];
  try {
    open = await deps.listOpenIssues(cfg);
  } catch (err) {
    throw new Error(
      `roadmap slice "${selector.value}": cannot load open-issue inventory to exclude ${EPIC_LABEL} parents: ${(err as Error).message}`,
    );
  }
  const epicIds = new Set(
    open.filter((i) => isEpicLabeled(i.labels)).map((i) => i.number),
  );
  const filtered = matches.filter((n) => !epicIds.has(n));
  if (filtered.length === 0) {
    throw new Error(`roadmap slice "${selector.value}" was not found in ROADMAP.md, or references no issues`);
  }
  return {
    issues: filtered.map(String),
    roadmapDeclaredEdges: await tryLoadRoadmapDeclaredEdges(cfg, deps, roadmapText),
  };
}

/** Resolves any {@link LoopSelector} into an explicit, ordered issue-number
 *  work list — the shared compilation step `defaultRunLoopEngine` uses for
 *  every selector type so milestone/label/roadmap-slice selectors reach the
 *  supervisor the same way an explicit issue list already did (#512). */
export async function resolveSelectorIssues(
  cfg: PipelineConfig,
  selector: LoopSelector,
  deps: SelectorResolveDeps,
): Promise<string[]> {
  return (await resolveSelectorWorkList(cfg, selector, deps)).issues;
}

/** Production discovery seam for a fresh work-list compile: body/native reads
 *  via GraphQL/REST, plus any roadmap/slice edges carried from selector
 *  resolution (#615 review finding 2e0c6562). */
export function workListDiscoverDepsForCompile(
  cfg: PipelineConfig,
  roadmapDeclaredEdges: readonly RoadmapDeclaredEdge[] = [],
): WorkListDependencyDiscoverDeps {
  return realWorkListDependencyDiscoverDeps(cfg, {
    getRoadmapDeclaredEdges: async () => roadmapDeclaredEdges,
  });
}

export interface RunLoopEngineInput {
  engine: LoopEngine;
  /** CLI `--engine-track` must reach per-item child advances (FRG candidate soak). */
  engineTrack?: "pinned" | "candidate";
  selector?: LoopSelector;
  /** Parent logical-operation identity for nested train/ship loop admission (#1368). */
  logicalOperationId?: string;
  resumeRunId?: string;
  audit: boolean;
  /** `--new-run` (#568, capability `loop-run-supersession`): only ever true alongside `selector`
   *  — {@link normalizeLoopArgs} refuses it with `--resume` or with no selector present. */
  newRun?: boolean;
  /** One-item command mode: resume the current durable run when active and
   * automatically supersede it when terminal, so a fresh operator invocation
   * never reuses an exhausted recovery ledger. */
  autoSupersedeTerminal?: boolean;
  /**
   * `--audit --follow` (#611): read-only whole-run stage-progress stream.
   * Requires `audit: true` (enforced by normalizeLoopArgs).
   */
  follow?: boolean;
  repoDir: string;
  /**
   * Early run-ready hook (#665): invoked once after exclusive lock and before
   * first item dispatch. Not invoked for `--audit` or failure paths. The engine
   * enriches supervisor context with the selector (null on bare `--resume`).
   */
  onRunReady?: (ctx: LoopRunReadyContext) => void | Promise<void>;
}

export type LoopEngineResult =
  | { kind: "audit"; report: Awaited<ReturnType<typeof auditSupervisor>> }
  | {
      kind: "audit_follow";
      report: Awaited<ReturnType<typeof auditSupervisor>>;
      /** Absolute path of the loop run events.jsonl used for stage follow. */
      events_path: string;
    }
  | { kind: "drive"; result: Awaited<ReturnType<typeof driveSupervisor>> }
  | { kind: "error"; message: string };

export type NewRunSupersessionDecision =
  | { kind: "resume-existing" }
  | { kind: "mint"; newRunId: string }
  | { kind: "refuse" };

/** Pure decision step for `--new-run` (#568 review 1, finding b9472740): distinguishes
 *  re-invoking `--new-run` against an already-minted, not-yet-resumed replacement run
 *  (`chainLength > 0` and the head hasn't terminally stopped — resume it, don't mint a
 *  duplicate) from a genuinely active canonical run with no prior supersession (refuse, per
 *  the "resume, don't supersede, an active run" requirement) and from a terminally-stopped
 *  head that is ready to be superseded (mint the next deterministic run id). */
export function decideNewRunSupersession(
  canonicalRunId: string,
  chainLength: number,
  headStopped: boolean,
): NewRunSupersessionDecision {
  if (!headStopped) {
    return chainLength > 0 ? { kind: "resume-existing" } : { kind: "refuse" };
  }
  return { kind: "mint", newRunId: `${canonicalRunId}-s${chainLength + 1}` };
}

export interface SupersessionMintPlan {
  /** Initialize the replacement run directory — only when it does not already exist. */
  initNewRun: boolean;
  /** Write the retired run's `superseded_by` pointer — only when it is not already correctly set. */
  markSuperseded: boolean;
}

export type SupersessionMintRepairDecision =
  | { kind: "plan"; plan: SupersessionMintPlan }
  | { kind: "conflict"; message: string };

/** Pure decision step for `--new-run`'s mint retry (#568 review 2, finding d4cbf5eb): a crash
 *  between initializing the replacement run and writing the retired run's `superseded_by`
 *  pointer must self-heal on the next `--new-run` invocation rather than wedge the chain
 *  forever. Live state is read once by the caller and passed in here so this decision — same
 *  pattern as {@link decideNewRunSupersession} — stays a pure function with no I/O of its own:
 *  every branch is driven only by what already exists, never re-derived from a fresh read. */
export function planSupersessionMintRepair(input: {
  headRunId: string;
  newRunId: string;
  newRunExists: boolean;
  /** The existing replacement run's `contract.supersedes`, when `newRunExists` is true. */
  existingNewRunSupersedes: string | undefined;
  /** The retired run's current ledger `superseded_by` pointer, if any. */
  headSupersededBy: string | undefined;
}): SupersessionMintRepairDecision {
  if (input.newRunExists && input.existingNewRunSupersedes !== input.headRunId) {
    return {
      kind: "conflict",
      message: `--new-run: existing run "${input.newRunId}" supersedes "${input.existingNewRunSupersedes}", not "${input.headRunId}" — supersession chain conflict`,
    };
  }
  if (input.headSupersededBy && input.headSupersededBy !== input.newRunId) {
    return {
      kind: "conflict",
      message: `--new-run: run "${input.headRunId}" is already superseded by "${input.headSupersededBy}", not "${input.newRunId}" — supersession chain conflict`,
    };
  }
  return {
    kind: "plan",
    plan: {
      initNewRun: !input.newRunExists,
      markSuperseded: !input.headSupersededBy,
    },
  };
}

/** Drives (or audits) the in-repo supervisor for an already-passed preflight —
 *  the replacement for the former external-skill delegation payload (#512).
 *  `--audit` performs zero durable writes (it never resolves gh config); a
 *  fresh start or `--resume` resolves `PipelineConfig` and drives the
 *  supervisor through the real store/observe/dispatch seams. */
async function defaultRunLoopEngine(input: RunLoopEngineInput): Promise<LoopEngineResult> {
  const store = defaultLoopStoreDeps();

  if (input.audit) {
    if (!input.resumeRunId) {
      return {
        kind: "error",
        message:
          "pipeline loop --audit requires --resume <run-id> naming the run to audit " +
          "(canonical run resolution without an explicit id is not yet supported)",
      };
    }
    try {
      const report = await auditSupervisor(store, input.resumeRunId);
      if (input.follow) {
        const dir = loopRunDir(store, input.resumeRunId);
        return {
          kind: "audit_follow",
          report,
          events_path: path.join(dir, "events.jsonl"),
        };
      }
      return { kind: "audit", report };
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
  }

  let cfg: PipelineConfig;
  try {
    cfg = resolveConfig({ repoPath: input.repoDir, profile: input.engine });
  } catch (err) {
    return { kind: "error", message: `config error: ${(err as Error).message}` };
  }
  if (input.engineTrack === "pinned" || input.engineTrack === "candidate") {
    cfg = { ...cfg, engine_track: input.engineTrack };
  }

  let runId: string;
  let resumeExisting = false;
  if (input.resumeRunId) {
    runId = input.resumeRunId;
  } else if (input.selector) {
    let issues: string[];
    let roadmapDeclaredEdges: readonly RoadmapDeclaredEdge[];
    try {
      const resolved = await resolveSelectorWorkList(cfg, input.selector, realSelectorResolveDeps());
      issues = resolved.issues;
      roadmapDeclaredEdges = resolved.roadmapDeclaredEdges;
    } catch (err) {
      return { kind: "error", message: `selector resolution failed: ${(err as Error).message}` };
    }
    // Carry roadmap/slice edges from selector resolution into discovery so an
    // edge declared only in ROADMAP is not dropped on the production path (#615).
    const discoverDeps = workListDiscoverDepsForCompile(cfg, roadmapDeclaredEdges);
    const canonicalRunId = workListRunId(cfg.repo, input.engine, issues);

    const canonicalExists = await loopRunExists(store, canonicalRunId);
    if (canonicalExists && !input.newRun) {
      let existingContract: Awaited<ReturnType<typeof readContract>>;
      try {
        existingContract = await readContract(store, canonicalRunId);
      } catch (err) {
        return {
          kind: "error",
          message: `canonical run selector check failed: ${(err as Error).message}`,
        };
      }
      if (!canonicalSelectorMatches(existingContract.selector, input.selector, issues)) {
        return {
          kind: "error",
          message:
            `canonical run "${canonicalRunId}" was created by another selector and cannot be ` +
            "silently reused; stop the existing run if needed, then use --new-run to preserve the requested selector",
        };
      }
    }
    if (input.newRun || (input.autoSupersedeTerminal && canonicalExists)) {
      if (!canonicalExists) {
        return {
          kind: "error",
          message: `--new-run: no existing run found for this selector (canonical run "${canonicalRunId}") — nothing to supersede`,
        };
      }
      const { headRunId, chainLength } = await resolveSupersessionChainHead(store, canonicalRunId);
      const headLedger = await readLedger(store, headRunId);
      const decision = decideNewRunSupersession(canonicalRunId, chainLength, !!headLedger.stop);
      if (decision.kind === "refuse") {
        if (input.autoSupersedeTerminal) {
          runId = headRunId;
          resumeExisting = true;
        } else {
          return {
            kind: "error",
            message: `--new-run: run "${headRunId}" for this selector is not terminally stopped — resume it instead (--resume ${headRunId})`,
          };
        }
      }
      if (decision.kind === "resume-existing") {
        runId = headRunId;
        resumeExisting = !!input.autoSupersedeTerminal;
      } else if (decision.kind === "mint") {
        const newRunId = decision.newRunId;
        // Re-derive the repair plan from live state on every mint attempt — including a retry
        // where `newRunId` already exists — rather than gating the reverse-pointer write on
        // `newRunId` not yet existing (#568 review 2 finding d4cbf5eb): a crash between
        // initializing the replacement and writing the retired run's `superseded_by` pointer
        // would otherwise wedge the chain forever, since resolveSupersessionChainHead only
        // trusts the retired ledger's own pointer.
        const newRunExists = await loopRunExists(store, newRunId);
        const existingNewRunSupersedes = newRunExists ? (await readContract(store, newRunId)).supersedes : undefined;
        const headLedgerNow = await readLedger(store, headRunId);
        const repair = planSupersessionMintRepair({
          headRunId,
          newRunId,
          newRunExists,
          existingNewRunSupersedes,
          headSupersededBy: headLedgerNow.superseded_by,
        });
        if (repair.kind === "conflict") {
          return { kind: "error", message: repair.message };
        }
        if (repair.plan.initNewRun) {
          let compiled: Awaited<ReturnType<typeof compileWorkListRunFresh>>;
          try {
            compiled = await compileWorkListRunFresh(
              cfg,
              input.engine,
              issues,
              newRunId,
              discoverDeps,
              input.selector,
              { logicalOperationId: input.logicalOperationId },
            );
          } catch (err) {
            return {
              kind: "error",
              message: `work-list compile failed: ${(err as Error).message}`,
            };
          }
          const { contract, ledger } = compiled;
          contract.supersedes = headRunId;
          await initRecoverableRun(store, contract, ledger);
        }
        if (repair.plan.markSuperseded) {
          await markRunSuperseded(store, headRunId, newRunId);
        }
        runId = newRunId;
      }
    } else {
      runId = canonicalRunId;
      if (!canonicalExists) {
        let compiled: Awaited<ReturnType<typeof compileWorkListRunFresh>>;
        try {
          compiled = await compileWorkListRunFresh(
            cfg,
            input.engine,
            issues,
            runId,
            discoverDeps,
            input.selector,
            { logicalOperationId: input.logicalOperationId },
          );
        } catch (err) {
          return {
            kind: "error",
            message: `work-list compile failed: ${(err as Error).message}`,
          };
        }
        const { contract, ledger } = compiled;
        await initRecoverableRun(store, contract, ledger);
      }
    }
  } else {
    return { kind: "error", message: "no selector or --resume run id was provided" };
  }

  const supervisorDeps: SupervisorDeps = {
    store,
    observe: defaultReconcileObserveDeps(cfg),
    dispatchItem: realDispatchItem(cfg, input.engine),
    executeRecovery: realExecuteRecovery(cfg),
    recoverySleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    getChangedFiles: realGetChangedFiles(cfg),
    // Host-local live-advance probe scope (#770 / #634): run-store discovery +
    // domain-scoped issue-run lock + wrapper identity under
    // ~/.pipeline/runs/<domain>/<issue> (#770 review 2 finding 956d20df).
    repoDir: cfg.repo_dir,
    lockDomain: cfg.domain,
    findWrapperPid: (issueNumber) =>
      findWrapperPidForIssue(issueNumber, { domain: cfg.domain }),
    // Recovery coexistence guard: the supervisor takes this same per-issue
    // advance lock (the one every `pipeline run` / override advance serializes
    // through) non-blocking and holds it across a recovery execution, so a
    // concurrent advance and a loop recovery can never write the same managed
    // worktree at once. A non-numeric item id cannot map to a lock path —
    // treat it as busy (fail closed) rather than recovering unlocked.
    acquireItemAdvanceLock: (itemId) => {
      const issueNumber = Number(itemId);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
      const lock = new PipelineLock({ domain: cfg.domain, issueNumber });
      if (!lock.acquire()) return null;
      return { release: () => lock.release() };
    },
    // Mid-advance stage-progress observation (#611): read the linked advance
    // events.jsonl while waiting on the child. Injectable for unit tests.
    readAdvanceEvents: async (eventsPath) => {
      try {
        const text = await fsPromises.readFile(eventsPath, "utf8");
        return parseAdvanceEventsJsonl(text);
      } catch {
        return [];
      }
    },
    // Opt-in durable-run-blocker auto-file (#538): best-effort, gated on
    // resolved config, wrapped so a failure here can never alter the drive
    // result (driveSupervisor's own onDriveEnd call site already swallows any
    // throw — this catch is belt-and-braces).
    onDriveEnd: cfg.durable_runs.auto_file
      ? async () => {
        await autoFileDurableRunBlockers(
          {
            repoDir: cfg.repo_dir,
            domain: cfg.domain,
            windowHours: cfg.durable_runs.auto_file_window_hours,
            maxPerWindow: cfg.durable_runs.auto_file_max_per_window,
            minOccurrences: cfg.durable_runs.auto_file_min_occurrences,
          },
          realAutoFileDeps(cfg.repo_dir),
        ).catch(() => {});
      }
      : undefined,
  };

  try {
    const parentPidRaw = process.env.PIPELINE_LIVENESS_PARENT_PID;
    const parentPid = parentPidRaw ? Number.parseInt(parentPidRaw, 10) : Number.NaN;
    const result = await driveSupervisor(supervisorDeps, {
      runId,
      engine: input.engine as LoopEngineName,
      resume: !!input.resumeRunId || resumeExisting,
      ...(Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
      onRunReady: input.onRunReady
        ? async (ctx) => {
            // Selector is known only at the engine/CLI layer; bare --resume has none.
            await input.onRunReady!({
              ...ctx,
              selector: input.resumeRunId ? null : (input.selector ?? null),
            });
          }
        : undefined,
    });
    return { kind: "drive", result };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

/** IO seam for {@link runLoopCommand}: the same DoctorDeps-shaped preflight
 *  used by `pipeline doctor` and the installer (design.md decision 4: one
 *  implementation, no divergent copies), plus the supervisor drive/audit
 *  entry point — injected so unit tests exercise the whole command with no
 *  real gh/filesystem/subprocess access. */
export interface LoopCliDeps {
  runLoopPreflight: typeof runLoopPreflight;
  runLoopEngine: (input: RunLoopEngineInput) => Promise<LoopEngineResult>;
  /**
   * Write+flush a single stdout line (early handoff). Defaults to
   * {@link writeFlushedStdoutLine}; tests inject a capture sink.
   */
  writeStdoutLine?: (line: string) => void | Promise<void>;
}

const defaultLoopCliDeps: LoopCliDeps = { runLoopPreflight, runLoopEngine: defaultRunLoopEngine };

/** `pipeline loop ...` (#512): normalize arguments, run the deterministic
 *  loop:store-schema-compatibility + native-/goal preflight checks, and — on
 *  success — drive (or resume) the in-repo durable loop supervisor, or render
 *  its read-only audit report. Replaces the former external-skill delegation
 *  payload: the loop path never discovers, requires, or invokes an installed
 *  goal-loop skill. Every preflight failure path exits non-zero with
 *  remediation and performs zero external mutation. */
export async function runLoopCommand(
  opts: CliOpts,
  positionalIssues: string[],
  deps: LoopCliDeps = defaultLoopCliDeps,
): Promise<void> {
  const engine: LoopEngine = opts.profile === "claude" ? "claude" : "codex";
  const raw: RawLoopArgs = {
    milestone: opts.milestone,
    label: opts.label,
    range: opts.range,
    roadmapSlice: opts.roadmapSlice,
    issues: positionalIssues,
    resume: opts.resume,
    audit: opts.audit,
    newRun: opts.newRun,
    follow: opts.follow,
  };

  // Read only the loop.native_goal_attestation key, gh-free (design.md
  // decision 4) — resolveLoopNativeGoalAttestation never shells out, unlike
  // resolveConfig(), so the preflight stays zero-gh-call on every path.
  const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
  const repoDir = findGitRoot(startDir) ?? startDir;
  let attestation: NativeGoalAttestation;
  try {
    attestation = resolveLoopNativeGoalAttestation(repoDir);
  } catch (err) {
    console.error(`pipeline loop: native-goal — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const outcome: LoopPreflightOutcome = await deps.runLoopPreflight(raw, engine, realDoctorDeps(), undefined, attestation);
  if (!outcome.ok) {
    console.error(`pipeline loop: ${outcome.failedCheck} — ${outcome.detail}`);
    if (outcome.remediation) console.error(`  → ${outcome.remediation}`);
    process.exitCode = 1;
    return;
  }

  const writeLine = deps.writeStdoutLine ?? writeFlushedStdoutLine;
  const engineResult = await deps.runLoopEngine({
    engine,
    engineTrack: opts.engineTrack === "pinned" || opts.engineTrack === "candidate" ? opts.engineTrack : undefined,
    selector: outcome.args.selector,
    resumeRunId: outcome.args.resumeRunId,
    audit: outcome.args.audit,
    newRun: outcome.args.newRun,
    follow: outcome.args.follow,
    repoDir,
    // Early handoff (#665): emit only on successful drive attach+lock, before
    // first dispatch. Audit and preflight/engine failure paths never set this
    // callback (audit short-circuits inside the engine before attach).
    onRunReady: outcome.args.audit
      ? undefined
      : async (ctx) => {
          const line = formatLoopRunHandoff(ctx);
          await writeLine(line);
          // Operator aid only — machine contract is the stdout JSON line above.
          console.error(
            `pipeline loop: run ready ${ctx.runId}; events ${ctx.events}`,
          );
        },
  });

  if (engineResult.kind === "error") {
    console.error(`pipeline loop: ${engineResult.message}`);
    process.exitCode = 1;
    return;
  }

  if (engineResult.kind === "audit" || engineResult.kind === "audit_follow") {
    // Human-readable per-item stage table (#611) — operators can pass advance
    // run ids to `pipeline logs <id> --follow` without grepping harness stdout.
    const stageRows = engineResult.report.stage_progress ?? [];
    if (stageRows.length > 0) {
      console.log("Stage progress:");
      for (const row of stageRows) {
        console.log(formatAuditStageTableRow(row));
      }
    }
    console.log(JSON.stringify({ schema_version: "1", engine, ...engineResult.report }));
    if (engineResult.kind === "audit") {
      process.exitCode = 0;
      return;
    }
    // Read-only stage-progress follow: stream clean one-line stage transitions
    // from durable loop events — never per-item harness terminal.log.
    await followLoopStageProgress(engineResult.report.run_id, {
      store: defaultLoopStoreDeps(),
    });
    process.exitCode = 0;
    return;
  }

  process.exitCode = renderLoopDriveResult(engine, engineResult.result);
}

/** Render the shared terminal contract for multi-item and canonical one-item
 * durable drives. Returns the process exit code so command facades cannot
 * diverge on stop/hold/exclusion behavior. */
export function renderLoopDriveResult(
  engine: LoopEngine,
  result: Extract<LoopEngineResult, { kind: "drive" }>["result"],
  commandLabel = "pipeline loop",
  emitMachineOutput = true,
): number {
  const outstandingReady = result.stop?.outstanding_ready ?? [];
  if (outstandingReady.length > 0) {
    console.error(
      `${commandLabel}: stopped with ${outstandingReady.length} item(s) at ready-to-deploy, awaiting an operator-authorized merge: ${outstandingReady.join(", ")}`,
    );
  }

  const heldItemIds = result.heldItemIds ?? [];
  if (result.holdOutstanding && heldItemIds.length > 0) {
    console.error(
      `${commandLabel}: paused with ${heldItemIds.length} item(s) held for a human: ${heldItemIds.join(", ")}`,
    );
  }

  const excludedItemIds = result.excludedItemIds ?? [];
  if (excludedItemIds.length > 0) {
    const total = result.dispatched + excludedItemIds.length;
    const reason = humanizeExclusionReason(result.exclusionReason);
    console.error(
      `${commandLabel}: ${result.dispatched} of ${total} item(s) dispatchable — ${excludedItemIds.length} excluded: ${reason} (${excludedItemIds
        .map((id) => `#${id}`)
        .join(", ")})`,
    );
  }

  if (emitMachineOutput) {
    console.log(
      JSON.stringify({
        schema_version: "1",
        engine,
        run_id: result.runId,
        cycles: result.cycles,
        stop: result.stop,
        hold_outstanding: result.holdOutstanding,
        held_item_ids: heldItemIds,
        all_done: result.allDone,
        resumed: result.resumed,
        dispatched: result.dispatched,
        excluded: excludedItemIds.length,
        excluded_item_ids: excludedItemIds,
        exclusion_reason: result.exclusionReason,
        completion: result.completion,
      }),
    );
  }
  return result.stop || result.holdOutstanding
    ? 1
    : result.completion === "none_dispatchable"
      ? 2
      : 0;
}

export interface SingleIssueCommandDeps {
  resolveConfig: typeof resolveConfig;
  resolveIssueNumber: typeof resolveIssueNumber;
  runLoopEngine: (input: RunLoopEngineInput) => Promise<LoopEngineResult>;
  writeStdoutLine: (line: string) => void | Promise<void>;
}

const defaultSingleIssueCommandDeps: SingleIssueCommandDeps = {
  resolveConfig,
  resolveIssueNumber,
  runLoopEngine: defaultRunLoopEngine,
  writeStdoutLine: writeFlushedStdoutLine,
};

export interface SingleIssueCommandOutput {
  /**
   * Emit the early run handoff and terminal drive object to stdout. Nested
   * machine-readable commands disable this so they retain one JSON document.
   */
  emitMachineOutput?: boolean;
}

/**
 * Compact result from `pipeline single` so legacy adapters (e.g. train's
 * {@link advanceIssueThroughSingle}) can load loop evidence for the attempt
 * without relying on process-global state alone (#1074).
 */
export interface SingleIssueCommandResult {
  exitCode: number;
  /** Durable loop run id when a drive result was returned. */
  runId?: string;
  /** `stop.reason` from the drive result when present. */
  stopReason?: string | null;
  /** Engine / facade error message when no drive completed. */
  engineMessage?: string | null;
}

/** Canonical one-item autonomous drive. The stage machine still performs every
 * normal transition; this facade supplies the same durable supervisor and
 * recovery controller used by `pipeline loop` without requiring an outer
 * multi-item `/goal` bootstrap. */
export async function runSingleIssueCommand(
  rawNumber: string | undefined,
  opts: CliOpts,
  deps: SingleIssueCommandDeps = defaultSingleIssueCommandDeps,
  output: SingleIssueCommandOutput = {},
): Promise<SingleIssueCommandResult> {
  const parsed = Number.parseInt(rawNumber ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== rawNumber) {
    console.error("pipeline single: <number> is required and must be a positive integer");
    process.exitCode = 2;
    return { exitCode: 2, engineMessage: "invalid issue number" };
  }

  let cfg: PipelineConfig;
  try {
    cfg = deps.resolveConfig({
      repoPath: opts.repoPath,
      baseBranch: opts.base,
      profile: opts.profile,
    });
  } catch (err) {
    console.error(`pipeline single: config error: ${(err as Error).message}`);
    process.exitCode = 2;
    return { exitCode: 2, engineMessage: (err as Error).message };
  }

  let issueNumber: number;
  try {
    issueNumber = await deps.resolveIssueNumber(cfg, parsed);
  } catch (err) {
    console.error(`pipeline single: ${(err as Error).message}`);
    process.exitCode = 1;
    return { exitCode: 1, engineMessage: (err as Error).message };
  }

  const engine: LoopEngine = opts.profile === "claude" ? "claude" : "codex";
  const engineResult = await deps.runLoopEngine({
    engine,
    engineTrack: opts.engineTrack === "pinned" || opts.engineTrack === "candidate" ? opts.engineTrack : undefined,
    selector: { type: "work-list", value: [String(issueNumber)] },
    audit: false,
    autoSupersedeTerminal: true,
    repoDir: cfg.repo_dir,
    onRunReady: async (ctx) => {
      if (output.emitMachineOutput !== false) {
        await deps.writeStdoutLine(
          formatLoopRunHandoff({
            ...ctx,
            selector: { type: "work-list", value: [String(issueNumber)] },
          }),
        );
      }
      console.error(`pipeline single: run ready ${ctx.runId}; events ${ctx.events}`);
    },
  });
  if (engineResult.kind === "error") {
    console.error(`pipeline single: ${engineResult.message}`);
    process.exitCode = 1;
    return { exitCode: 1, engineMessage: engineResult.message };
  }
  if (engineResult.kind !== "drive") {
    const msg = "internal error: one-item drive returned an audit result";
    console.error(`pipeline single: ${msg}`);
    process.exitCode = 1;
    return { exitCode: 1, engineMessage: msg };
  }
  const stop = engineResult.result.stop;
  const stopReason =
    stop && typeof stop.reason === "string" && stop.reason.trim()
      ? stop.reason.trim()
      : null;
  const exitCode = renderLoopDriveResult(
    engine,
    engineResult.result,
    "pipeline single",
    output.emitMachineOutput !== false,
  );
  process.exitCode = exitCode;
  return {
    exitCode,
    runId: engineResult.result.runId,
    stopReason,
  };
}

export interface TrainCommandDeps {
  makeTrainDeps(input: {
    repoDir: string;
    repo: string;
    baseBranch: string;
  }): TrainDeps;
  runSingleIssue: typeof runSingleIssueCommand;
  /**
   * Multi-item frontier advance (#1023 / #1028). Production: one loop engine
   * call per frontier. Injected so unit tests never spawn a real loop.
   */
  runAdvanceWave?: (
    issues: readonly number[],
    opts: CliOpts,
    getIssue: TrainDeps["getIssue"],
  ) => Promise<import("./stages/train.ts").AdvanceWaveResult>;
}

const defaultTrainCommandDeps: TrainCommandDeps = {
  makeTrainDeps(input) {
    return realTrainDeps({
      ...input,
      advanceWave: async () => {
        throw new Error("advanceWave must be overridden by runTrainCommand");
      },
    });
  },
  runSingleIssue: runSingleIssueCommand,
};

export async function advanceIssueThroughSingle(
  issue: number,
  opts: CliOpts,
  getIssue: TrainDeps["getIssue"],
  runSingleIssue: typeof runSingleIssueCommand = runSingleIssueCommand,
  /**
   * Optional structured loop evidence for this single-item attempt (#1074).
   * Callers/tests inject stop/block evidence (or a reader that loads it after
   * `pipeline single`) so non-ok STOP text can quote `loop_run_stopped` /
   * `loop_item_blocked` instead of exit-only.
   *
   * When **omitted** (production default), evidence is derived from the
   * `runSingleIssue` return value (`runId` / `stopReason` / `engineMessage`)
   * plus loop events loaded via {@link readLoopEvents}. Explicit `null` or an
   * empty reader keeps exit-code / engine message only — never invents a class.
   */
  evidence?:
    | TrainAdvanceLoopEvidence
    | null
    | (() =>
        | TrainAdvanceLoopEvidence
        | null
        | undefined
        | Promise<TrainAdvanceLoopEvidence | null | undefined>),
  /**
   * Production seam: read loop events.jsonl for the single attempt's run id.
   * Defaults to the same store reader as {@link advanceWaveThroughLoop}.
   * Injected in unit tests (no real loop store / network / subprocess).
   */
  readLoopEvents: (
    runId: string,
  ) => Promise<readonly { kind?: string; data?: unknown }[]> = defaultReadLoopEventsForTrain,
): Promise<AdvanceOutcome> {
  const previousExit = process.exitCode;
  process.exitCode = 0;
  let exit = 0;
  let singleResult: SingleIssueCommandResult | void | undefined;
  try {
    singleResult = await runSingleIssue(String(issue), opts, undefined, {
      // The owning command emits its own single JSON document.
      emitMachineOutput: !opts.json,
    });
    exit = process.exitCode ?? 0;
    if (singleResult && typeof singleResult.exitCode === "number") {
      exit = singleResult.exitCode;
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    process.exitCode = previousExit ?? 0;
  }

  let resolved: TrainAdvanceLoopEvidence | null | undefined;
  if (typeof evidence === "function") {
    resolved = await evidence();
  } else if (evidence !== undefined) {
    // Explicit inject (including null) — do not re-read production store.
    resolved = evidence;
  } else {
    // Production path: structured evidence from the single attempt itself.
    resolved = await loadTrainAdvanceEvidenceFromSingleResult(
      singleResult,
      exit,
      readLoopEvents,
    );
  }

  return classifyTrainAdvanceLabels(await getIssue(issue), exit, resolved, issue);
}

/**
 * Derive train STOP evidence from a `pipeline single` result + optional events.
 * Best-effort event read; never invents stop/block class names.
 */
async function loadTrainAdvanceEvidenceFromSingleResult(
  singleResult: SingleIssueCommandResult | void | undefined,
  exit: number,
  readLoopEvents: (
    runId: string,
  ) => Promise<readonly { kind?: string; data?: unknown }[]>,
): Promise<TrainAdvanceLoopEvidence> {
  const runId =
    singleResult && typeof singleResult.runId === "string" && singleResult.runId.trim()
      ? singleResult.runId.trim()
      : null;
  let events: readonly { kind?: string; data?: unknown }[] = [];
  if (runId) {
    try {
      events = await readLoopEvents(runId);
    } catch {
      events = [];
    }
  }
  const stopFromResult =
    singleResult && typeof singleResult.stopReason === "string"
      ? singleResult.stopReason
      : singleResult?.stopReason === null
        ? null
        : undefined;
  const engineMessage =
    singleResult && typeof singleResult.engineMessage === "string"
      ? singleResult.engineMessage
      : null;
  return extractTrainAdvanceLoopEvidence({
    events,
    stopReason: stopFromResult ?? null,
    exitCode: exit !== 0 ? exit : singleResult?.exitCode ?? 0,
    engineMessage,
  });
}

/**
 * Map live issue labels (+ optional exit code / loop evidence) to a train
 * AdvanceOutcome. When structured loop evidence is present (#1074), non-ok and
 * park diagnostics quote stop reason / blocked class before raw exit code.
 */
export function classifyTrainAdvanceLabels(
  snap: { labels: string[] },
  exit = 0,
  evidence?: TrainAdvanceLoopEvidence | null,
  issue?: number,
): AdvanceOutcome {
  const stageLabel = snap.labels.find((label) => label.startsWith("pipeline:"));
  const stage = stageLabel?.slice("pipeline:".length) ?? null;

  const merged: TrainAdvanceLoopEvidence = {
    ...(evidence ?? {}),
  };
  if (evidence?.exitCode != null) {
    merged.exitCode = evidence.exitCode;
  } else if (exit !== 0) {
    merged.exitCode = exit;
  }
  if (exit !== 0 && (merged.exitCode == null || merged.exitCode === 0)) {
    merged.exitCode = exit;
  }

  const diagnostic =
    hasStructuredTrainAdvanceEvidence(merged) ||
    (merged.exitCode != null && merged.exitCode !== 0) ||
    !!merged.engineMessage
      ? composeTrainAdvanceStopReason(merged, issue)
      : undefined;

  // Current failure (not a recovered, superseded item-block): non-zero exit,
  // engine message, or loop_run_stopped (including a reasonless stop).
  // A still-current loop_item_blocked (itemTerminal !== "ready") is also
  // current failure — R2D label flicker must not merge it (#1095 review-2).
  // Recovered blocks have itemTerminal "ready" (or no remaining block
  // fields). #1074 still forbids masking a real stop / engine failure.
  const mechanicalExhaustionStop = merged.stopReason === "recovery_exhausted";
  const currentFailure =
    exit !== 0 ||
    !!merged.engineMessage ||
    (!!merged.stopReason && !mechanicalExhaustionStop);
  const leftoverItemBlock =
    !!merged.blockedClass ||
    !!merged.blockerKind ||
    !!merged.blockerCommentFirstLine;
  const currentItemBlock = leftoverItemBlock && merged.itemTerminal !== "ready";
  const liveBlocked = snap.labels.includes("blocked");

  if (stage === "ready-to-deploy" && !liveBlocked) {
    if (currentFailure || currentItemBlock) {
      return {
        ok: false,
        error:
          diagnostic ??
          composeTrainAdvanceStopReason(
            { exitCode: exit !== 0 ? exit : 1, engineMessage: merged.engineMessage },
            issue,
          ),
      };
    }
    return { ok: true, terminal: "ready-to-deploy", labels: snap.labels };
  }
  if (stage === "needs-human") {
    return {
      ok: true,
      terminal: "needs-human",
      labels: snap.labels,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  if (liveBlocked) {
    return {
      ok: true,
      terminal: "blocked",
      labels: snap.labels,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  // Non-zero exit, engine failure message, current stop, or still-current
  // item-block evidence without a terminal park label → non-ok (#1074).
  if (currentFailure || leftoverItemBlock) {
    return {
      ok: false,
      error:
        diagnostic ??
        composeTrainAdvanceStopReason(
          { exitCode: exit !== 0 ? exit : 1 },
          issue,
        ),
    };
  }
  return {
    ok: true,
    terminal: "other",
    labels: snap.labels,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/**
 * One multi-item loop engine call for a base-eligible frontier (#1023).
 * Recovery and parallel disjoint advance stay inside the loop; train does not
 * call repair_pipeline_item.
 *
 * When the wave ends non-ok, per-item errors quote structured loop stop /
 * block evidence before raw exit code (#1074).
 */
export async function advanceWaveThroughLoop(
  issues: readonly number[],
  opts: CliOpts,
  getIssue: TrainDeps["getIssue"],
  runLoopEngine: (input: RunLoopEngineInput) => Promise<LoopEngineResult> = defaultRunLoopEngine,
  resolveCfg: typeof resolveConfig = resolveConfig,
  readLoopEvents: (
    runId: string,
  ) => Promise<readonly { kind?: string; data?: unknown }[]> = defaultReadLoopEventsForTrain,
  writeStderrLine: (line: string) => Promise<void> = (line) =>
    writeFlushedStdoutLine(line, process.stderr),
): Promise<import("./stages/train.ts").AdvanceWaveResult> {
  if (issues.length === 0) return new Map();
  let cfg: PipelineConfig;
  try {
    cfg = resolveCfg({
      repoPath: opts.repoPath,
      baseBranch: opts.base,
      profile: opts.profile,
    });
  } catch (err) {
    const out = new Map<number, AdvanceOutcome>();
    for (const n of issues) {
      out.set(n, { ok: false, error: `config error: ${(err as Error).message}` });
    }
    return out;
  }
  const engine: LoopEngine = opts.profile === "claude" ? "claude" : "codex";
  const previousExit = process.exitCode;
  process.exitCode = 0;
  let engineFailed: string | null = null;
  let driveStopReason: string | null = null;
  let driveRunId: string | null = null;
  let linkedLoop: import("./stages/train.ts").LinkedLoopRun | undefined;
  try {
    const engineResult = await runLoopEngine({
      engine,
      engineTrack: opts.engineTrack === "pinned" || opts.engineTrack === "candidate" ? opts.engineTrack : undefined,
      selector: { type: "work-list", value: issues.map(String) },
      audit: false,
      autoSupersedeTerminal: true,
      repoDir: cfg.repo_dir,
      logicalOperationId: opts.parentLogicalOperationId,
      onRunReady: async (ctx) => {
        // Live handoff for composers (Tugboat stage-watch). Stderr only —
        // train --json stdout stays one train_status object (#1184).
        await writeStderrLine(formatLoopRunHandoff(ctx));
        console.error(
          `[train] advance-wave loop ready ${ctx.runId}; issues ${issues.map((n) => `#${n}`).join(", ")}`,
        );
        if (typeof ctx.runId === "string" && ctx.runId.trim() !== "") {
          linkedLoop = {
            runId: ctx.runId,
            ...(typeof ctx.events === "string" && ctx.events.trim() !== ""
              ? { eventsPath: ctx.events }
              : {}),
          };
        }
      },
    });
    if (engineResult.kind === "error") {
      engineFailed = engineResult.message;
    } else if (engineResult.kind === "drive") {
      driveRunId = engineResult.result.runId;
      const stop = engineResult.result.stop;
      if (stop && typeof stop.reason === "string" && stop.reason.trim()) {
        driveStopReason = stop.reason.trim();
      }
    }
  } catch (err) {
    engineFailed = (err as Error).message;
  } finally {
    process.exitCode = previousExit ?? 0;
  }

  let events: readonly { kind?: string; data?: unknown }[] = [];
  if (driveRunId) {
    try {
      events = await readLoopEvents(driveRunId);
    } catch {
      events = [];
    }
  }

  const waveEvidence = extractTrainAdvanceLoopEvidence({
    events,
    stopReason: driveStopReason,
    exitCode:
      engineFailed ? 1 : driveStopReason && driveStopReason !== "recovery_exhausted" ? 1 : 0,
    engineMessage: engineFailed,
  });

  const out = new Map<number, AdvanceOutcome>() as import("./stages/train.ts").AdvanceWaveResult;
  if (linkedLoop) out.loopRun = linkedLoop;
  for (const issue of issues) {
    const scoped = scopeTrainAdvanceEvidenceForIssue(waveEvidence, issue);
    const waveFailed =
      !!engineFailed || (!!driveStopReason && driveStopReason !== "recovery_exhausted");
    const exitForClassify =
      waveFailed || (scoped.exitCode != null && scoped.exitCode !== 0)
        ? scoped.exitCode != null && scoped.exitCode !== 0
          ? scoped.exitCode
          : 1
        : 0;
    try {
      out.set(
        issue,
        classifyTrainAdvanceLabels(await getIssue(issue), exitForClassify, scoped, issue),
      );
    } catch (err) {
      if (engineFailed || hasStructuredTrainAdvanceEvidence(scoped) || scoped.engineMessage) {
        out.set(issue, {
          ok: false,
          error: composeTrainAdvanceStopReason(
            {
              ...scoped,
              engineMessage: scoped.engineMessage ?? engineFailed ?? (err as Error).message,
            },
            issue,
          ),
        });
      } else {
        out.set(issue, { ok: false, error: (err as Error).message });
      }
    }
  }
  return out;
}

/** Production default: read loop events.jsonl for the wave run (best-effort). */
async function defaultReadLoopEventsForTrain(
  runId: string,
): Promise<readonly { kind?: string; data?: unknown }[]> {
  try {
    const { readEvents } = await import("./loop/store.ts");
    return await readEvents(defaultLoopStoreDeps(), runId);
  } catch {
    return [];
  }
}

/** Execute parsed `pipeline train` options through the ordered train engine.
 * The dependency seam keeps the CLI output contract testable without GitHub. */
export async function runTrainCommand(
  opts: CliOpts,
  trainCfg: PipelineConfig,
  deps: TrainCommandDeps = defaultTrainCommandDeps,
): Promise<number> {
  let issueNumbers: number[];
  try {
    issueNumbers = parseIssueList(opts.issues);
  } catch (err) {
    console.error(`pipeline train: ${(err as Error).message}`);
    return 2;
  }
  const milestone = opts.milestone ? String(opts.milestone).trim() : "";
  if (issueNumbers.length === 0 && !milestone) {
    console.error(
      "pipeline train: --issues <n,n> and/or --milestone <title> is required.\n" +
        "  Usage: pipeline train --issues 10,11,12 [--merge] [--json] [--dry-run]\n" +
        "         pipeline train --milestone v1.34.0 [--merge] [--json] [--dry-run]\n" +
        "  Without --merge: advances base-eligible frontiers via one loop wave each.\n" +
        "  With --merge: merge-first prelude for already-R2D open PRs, then serial merge + base containment after each advance wave.\n" +
        "  --dry-run prints a read-only plan and does not advance or merge.\n" +
        "  Never called from the advance loop. No auto_merge config key.",
    );
    return 2;
  }

  const baseDeps = deps.makeTrainDeps({
    repoDir: trainCfg.repo_dir,
    repo: trainCfg.repo,
    baseBranch: trainCfg.base_branch,
  });
  const wave =
    deps.runAdvanceWave ??
    ((issues, waveOpts, getIssue) => advanceWaveThroughLoop(issues, waveOpts, getIssue));
  // Expose train milestone to engine-class live sibling filing (#1021).
  try {
    const { setTrainMilestoneContext } = await import("./stages/engine-class-live-sibling.ts");
    setTrainMilestoneContext(milestone || null);
  } catch {
    // Non-fatal
  }
  const trainResult = await runTrain(
    {
      issues: issueNumbers.length > 0 ? issueNumbers : undefined,
      milestone: milestone || undefined,
      merge: !!opts.merge,
      dryRun: !!opts.dryRun,
      baseBranch: trainCfg.base_branch,
      repoDir: trainCfg.repo_dir,
      repo: trainCfg.repo,
      pipelineConfig: trainCfg,
    },
    {
      ...baseDeps,
      advanceWave: (issues, ctx) =>
        wave(
          issues,
          { ...opts, parentLogicalOperationId: ctx?.logicalOperationId },
          baseDeps.getIssue,
        ),
    },
  );
  try {
    const { setTrainMilestoneContext } = await import("./stages/engine-class-live-sibling.ts");
    setTrainMilestoneContext(null);
  } catch {
    // Non-fatal
  }

  if (opts.json) {
    if (opts.dryRun) {
      if (!trainResult.plan) {
        console.error("pipeline train: --dry-run produced no plan");
        return 2;
      }
      console.log(JSON.stringify(trainResult.plan, null, 2));
    } else {
      console.log(JSON.stringify(trainResult.status, null, 2));
    }
  } else if (!opts.dryRun) {
    const status = trainResult.status;
    console.log(
      `[train] complete=${status.complete} merge_mode=${status.merge_mode} ` +
        `items=${status.items.length}/${status.ordered_issues.length}` +
        (status.blocker ? ` blocker=${JSON.stringify(status.blocker)}` : ""),
    );
    for (const item of status.items) {
      console.log(
        `  #${item.issue}` +
          (item.pr != null ? ` PR #${item.pr}` : "") +
          ` ${item.terminal}` +
          (item.integrated ? " integrated" : "") +
          (item.merge_result_oid ? ` merge=${item.merge_result_oid.slice(0, 12)}` : "") +
          (item.error ? ` err=${item.error}` : ""),
      );
    }
  }
  return trainResult.exitCode;
}

/** Renders a machine-readable `precondition:required=<stage>,observed=<stage>` exclusion reason
 *  (see `loop/supervisor.ts` `formatExclusionReason`) into the short human form the CLI disclosure
 *  line uses (#614, design.md decision 3), e.g. `"need pipeline:ready"`. Falls back to the raw
 *  reason string for any shape this pattern doesn't recognize, and to `"unknown"` when absent. */
function humanizeExclusionReason(reason: string | null): string {
  if (!reason) return "unknown";
  const match = /^precondition:required=([^,]+),observed=/.exec(reason);
  return match ? `need ${match[1]}` : reason;
}

/** Whether `resolvedPath` resolves inside `repoDir` once symlinks are
 *  followed (review 2 finding aa79c7b7) — a purely lexical `startsWith` check
 *  passes for a repository-local symlink whose real target is outside the
 *  repository. Walks up to the nearest ancestor that actually exists on disk
 *  (the target itself, or a not-yet-created parent for a write destination),
 *  resolves *that* ancestor's real path, then re-appends the not-yet-existing
 *  remainder before comparing against the repository's own real path. When
 *  neither the target nor any ancestor exists (e.g. in unit tests against a
 *  nonexistent repo root), there is nothing to resolve, so this defers to the
 *  caller's lexical check rather than failing closed on unrelated I/O errors. */
function isPathWithinRealRoot(repoDir: string, resolvedPath: string): boolean {
  let existingAncestor = resolvedPath;
  const remainder: string[] = [];
  for (;;) {
    try {
      const realAncestor = realpathSync(existingAncestor);
      let repoReal: string;
      try {
        repoReal = realpathSync(repoDir);
      } catch {
        repoReal = repoDir;
      }
      const realTarget = remainder.length > 0 ? path.join(realAncestor, ...remainder) : realAncestor;
      const repoRealRoot = repoReal.endsWith(path.sep) ? repoReal : `${repoReal}${path.sep}`;
      return realTarget === repoReal || realTarget.startsWith(repoRealRoot);
    } catch {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return true;
      }
      remainder.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

/** Resolve `pipeline evals harvest`'s `--out` path, or reject it (review 1
 *  finding a97dc21a; review 2 finding aa79c7b7). A repository write requires
 *  the explicit `--apply` approval action shared with roadmap/sweep/improve —
 *  `--out` without `--apply` is refused rather than silently writing an
 *  unreviewed file, and an approved `--out` path is constrained to resolve
 *  inside the repository — both lexically and, after following symlinks, in
 *  reality — rather than trusting an arbitrary (possibly absolute, `..`-
 *  escaping, or symlink-escaping) caller-supplied path. Returns `{ path:
 *  undefined }` (print to stdout) when `--out` was not supplied at all. Pure
 *  and dependency-free so it is directly unit-testable without invoking the
 *  CLI. */
export function resolveHarvestOutPath(
  repoDir: string,
  outArg: string | undefined,
  apply: boolean,
): { ok: true; path?: string } | { ok: false; error: string } {
  if (!outArg) {
    return { ok: true };
  }
  if (!apply) {
    return { ok: false, error: "--out requires --apply — draft-only mode (the default) only prints to stdout" };
  }
  const outPath = path.resolve(repoDir, outArg);
  const repoRoot = repoDir.endsWith(path.sep) ? repoDir : `${repoDir}${path.sep}`;
  if (outPath !== repoDir && !outPath.startsWith(repoRoot)) {
    return { ok: false, error: `--out must resolve within the repository (${repoDir})` };
  }
  if (!isPathWithinRealRoot(repoDir, outPath)) {
    return { ok: false, error: `--out must resolve within the repository (${repoDir}) even after resolving symlinks` };
  }
  return { ok: true, path: outPath };
}

/** Resolve `pipeline evals harvest --apply`'s promotion destination
 *  (`--fixtures`), or reject it (review 2 finding aa79c7b7). Unlike
 *  `--fixtures` for `plan`/`run`/`grade` (a read-only lookup), harvest
 *  promotion *writes* a fixture file into this directory, so it is
 *  constrained the same way `--out` is: it must resolve inside the
 *  repository, both lexically and after following symlinks. */
export function resolveHarvestFixturesDir(
  repoDir: string,
  fixturesDir: string,
): { ok: true } | { ok: false; error: string } {
  const repoRoot = repoDir.endsWith(path.sep) ? repoDir : `${repoDir}${path.sep}`;
  if (fixturesDir !== repoDir && !fixturesDir.startsWith(repoRoot)) {
    return { ok: false, error: `--fixtures must resolve within the repository (${repoDir}) to promote a fixture into it` };
  }
  if (!isPathWithinRealRoot(repoDir, fixturesDir)) {
    return { ok: false, error: `--fixtures must resolve within the repository (${repoDir}) even after resolving symlinks` };
  }
  return { ok: true };
}

async function main(): Promise<void> {
  // Pre-intercept `pipeline refine-spec --help` before Commander processes the
  // global --help flag. Commander exits 0 on --help before dispatch runs, so
  // without this, both old and new installs exit 0 with generic top-level help —
  // indistinguishable by content. New installs print refine-spec-specific usage
  // mentioning --title and --body; old installs print generic help without them.
  const rawArgs = process.argv.slice(2);
  // `--version --json` is identity (exact 40-hex commit_sha or null). Human
  // `--version` stays Commander / package version. Never invent a SHA (#1151).
  if ((rawArgs.includes("--version") || rawArgs.includes("-V")) && rawArgs.includes("--json")) {
    const engineRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    process.stdout.write(formatPipelineVersionJson(VERSION, resolveEngineCommitSha(engineRoot)));
    process.exit(0);
  }
  if (rawArgs[0] === "grill" && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
    process.stdout.write(
      "Usage: pipeline grill --issue N [--dry-run] [--json]\n" +
      "       pipeline grill --issues N,N,... [--dry-run] [--json]\n" +
      "       pipeline grill --milestone M [--dry-run] [--json]\n" +
      "       pipeline grill --label L [--label L] [--dry-run] [--json]\n" +
      "       pipeline grill status --run-id <id> [--follow] [--json]\n" +
      "       pipeline grill --resume <run-id>\n\n" +
      "Native grill-with-docs admission. Exactly one selector form is required.\n" +
      "Does not merge, deploy, or write the integration branch.\n",
    );
    process.exit(0);
  }
  if (rawArgs[0] === "refine-spec" && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
    process.stdout.write(
      'Usage: pipeline refine-spec --title "<title>" --body "<markdown>" [--json]\n' +
      "       pipeline refine-spec --issue N [--json]\n" +
      "       pipeline refine-spec apply --issue N [--proposal-file PATH]\n\n" +
      "Desk preview. Admission is pipeline grill --issue N.\n" +
      "--title/--body is a gh-free single-call preview.\n" +
      "--issue and apply are compatibility shims that diagnose toward pipeline grill.\n\n" +
      "Options:\n" +
      "  --title <text>           existing issue title to refine (required with --body)\n" +
      "  --body <markdown>        existing issue body to refine (required with --title)\n" +
      "  --issue <n>              fetch and grill GitHub issue N\n" +
      "  apply                    consume a signed preview envelope (stdin XOR --proposal-file)\n" +
      "  --proposal-file <path>   apply: read the envelope from PATH\n" +
      "  --json                   accepted; output is always JSON (no-op)\n" +
      "  --repo-path <path>       override the target repo working tree\n\n" +
      'Output (--title/--body): { "title": string, "body": string, "milestone": string|null }\n' +
      "Output (--issue): one grill-proposal.v1 JSON envelope\n" +
      "Exit code: 0 on success, 2 on usage/drift/challenge, non-zero on harness failure.\n",
    );
    process.exit(0);
  }
  if (rawArgs[0] === "improve" && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
    process.stdout.write(
      "Usage: pipeline improve [--apply] [--top <n>] [--since <date>] [--min-occurrences <n>] [--json]\n\n" +
      "Read-only analyzer: reads .agent-pipeline/runs/**/events.jsonl and summary.json,\n" +
      "clusters recurring failure patterns (review findings, blockers, flaky gates, token waste,\n" +
      "papercuts, and recurring correction_event corrections), and prints a dry-run report.\n" +
      "With --apply, creates GitHub issues for the top clusters.\n\n" +
      "Options:\n" +
      "  --apply                   create GitHub issues for top-N qualifying clusters\n" +
      "  --top <n>                 emit top-N clusters in the report (default: 5)\n" +
      "  --since <date>            restrict to runs on or after this ISO date (e.g. 2026-06-01)\n" +
      "  --min-occurrences <n>     --apply threshold: skip clusters below this count (default: 3;\n" +
      "                            2 for the correction category)\n" +
      "  --json                    emit a JSON array instead of the Markdown-ish report\n" +
      "  --repo-path <path>        override the target repo working tree\n\n" +
      "The command never modifies pipeline labels, branches, PRs, worktrees, or repo files.\n" +
      "Exit code: 0 always (even when no run data is found).\n",
    );
    process.exit(0);
  }
  if (rawArgs[0] === "scoreboard" && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
    process.stdout.write(
      "Usage: pipeline scoreboard [--since <date>] [--until <date>] [--days <n>] [--estimate-cost <harness=usd>] [--bucket <unit>] [--by <dimension>] [--corrections-by <dimension>] [--html <path>] [--json]\n\n" +
      "Read-only factory report: scans .agent-pipeline/runs/*/{run.json,events.jsonl,summary.json}\n" +
      "and prints throughput, autonomy, cost, duration, retry, blocker, fallback, and gate metrics.\n" +
      "Includes pre-merge needs-human rate and by-class breakdown (ci-failed, delta-review,\n" +
      "merge-conflict, OpenSpec, other) derived from durable run events — never issue comments.\n\n" +
      "Stabilization / attribution metrics (#763) — offline from ledgers + optional FRG trend ledger:\n" +
      "  human-touch rates (per attempted / per R2D issue; discrete event counts, not labor minutes)\n" +
      "  escape-recurrence (seed defect classes after fix-release boundary)\n" +
      "  discovery-channel breakdown (live-run | review-batch | papercut-autofile | manual)\n" +
      "  engine-class needs-human release-over-release (prefers FRG trend-ledger observations)\n" +
      "  stratified rates (intervention-free first-attempt R2D, recovery, evidence coverage, …)\n" +
      "  candidate-integrity observability (zeros when #857 events absent; not a gate)\n\n" +
      "Discovery-channel inheritance: events may omit fields and inherit engine version/SHA and\n" +
      "default channel live-run from run.json; missing historical stamps count as missing-attribution\n" +
      "(never silently as live-run). Auto-file bodies stamp discovery-channel papercut-autofile.\n\n" +
      "Non-goals: no human labor minutes from wall-clock; no raw events/day model comparison;\n" +
      "no FRG threshold change; HTML export optional (#427) and not required for these metrics.\n\n" +
      "Dogfood-day queries:\n" +
      "  pipeline scoreboard --days 1 --json\n" +
      "  # → .metrics.pre_merge_needs_human, .metrics.human_touches, .metrics.escape_recurrence,\n" +
      "  #   .metrics.discovery_channel, .metrics.stratified, .metrics.candidate_integrity,\n" +
      "  #   .engine_class_release_series, .outcomes (production/rework; #576)\n\n" +
      "Production outcomes (#576): additive .outcomes section from .agent-pipeline/outcomes/.\n" +
      "Counts by kind and observation_state; observed vs inferred attribution partitioned.\n" +
      "No maintainability_score; merge without deploy is not deploy success; R2D ≠ delivery.\n" +
      "Ingest separately: pipeline outcomes ingest [--fixture path] [--dry-run] [--json]\n\n" +
      "Options:\n" +
      "  --since <date>              window start (ISO-8601)\n" +
      "  --until <date>              window end (ISO-8601)\n" +
      "  --days <n>                  relative N-day window; default is last 30 days\n" +
      "  --estimate-cost <harness=usd>  estimate missing per-call cost; repeatable\n" +
      "  --bucket <unit>             add a chronological day|week time-series (default: none)\n" +
      "  --by <dimension>            group metrics by harness|model|effort|executor (default: none, exactly one)\n" +
      "  --corrections-by <dimension>  group correction/recurrence metrics by repo|stage|harness|model|source_kind|failure_class|proposed_control|implemented_control (default: none, exactly one)\n" +
      "  --html <path>               write a self-contained, offline HTML export of the report to this path (local/archival only)\n" +
      "  --json                      emit one unfenced JSON object\n" +
      "  --repo-path <path>          override the target repo working tree\n\n" +
      "The command never modifies pipeline labels, branches, PRs, worktrees, config, or run artifacts.\n" +
      "Exit code: 0 on success, non-zero only for invalid flags or unreadable report setup.\n",
    );
    process.exit(0);
  }
  if (rawArgs[0] === "config" && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
    process.stdout.write(
      "Usage: pipeline config <schema|validate|sync|repo-map> [--repo-path <path>] [--apply] [--json]\n\n" +
      "Config maintenance commands:\n" +
      "  schema                          print the JSON Schema for .github/pipeline.yml\n" +
      "  validate                        validate .github/pipeline.yml and print diagnostics\n" +
      "  sync                            preview a current scaffold refresh; use --apply to write\n" +
      "  repo-map add <owner/repo>       add an entry to repo_map (creates the block if absent)\n" +
      "  repo-map remove <owner/repo>    remove an entry from repo_map (no-op if absent)\n" +
      "  repo-map list                   print current repo_map entries grouped by relationship\n\n" +
      "Options:\n" +
      "  --repo-path <path>      operate on the git root containing this path\n" +
      "  --apply                 config sync only: write the refreshed file after safe validation\n" +
      "  --json                  validate/sync: emit machine-readable JSON\n" +
      "  --rel <relation>        repo-map add/remove: depends_on or depended_on_by (default: depends_on)\n\n" +
      "Exit code: 0 on success; non-zero for invalid config, unsafe sync, or invalid usage.\n",
    );
    process.exit(0);
  }

  const cmd = buildCmd();
  cmd.parse(process.argv);

  const opts = cmd.opts<CliOpts>();
  let numArg = cmd.args[0];
  const isInit = opts.init || numArg === "init";
  // `pipeline doctor` is a standalone command (like `init`): it runs the
  // preflight checks and exits, with no issue number. Distinct from the
  // `--doctor` flag, which gates a real advance run.
  const isDoctorCommand = numArg === "doctor";
  // `pipeline release <version>` prepares a release PR — no issue number required.
  const isReleaseCommand = numArg === "release";
  // `pipeline ship` owns one exact, event-authorized release shipment.
  const isShipCommand = numArg === "ship";
  // `pipeline intake [--description "<text>"] [--release vX.Y.Z]` — no issue number.
  const isIntakeCommand = numArg === "intake";
  // `pipeline decompose --epic N [--apply] …` — epic work breakdown (#766).
  const isDecomposeCommand = numArg === "decompose";
  // `pipeline sweep [--apply] [--repo <owner/repo>]` — batch backlog re-spec + roadmap reconciliation.
  const isSweepCommand = numArg === "sweep";
  // `pipeline backfill [--apply] [--capability <name>] [--repo <owner/repo>]` — OpenSpec coverage backfill.
  const isBackfillCommand = numArg === "backfill";
  // `pipeline triage <issue> --stage ready|backlog` — set an issue's pre-pipeline stage label.
  const isTriageCommand = numArg === "triage";
  // `pipeline merge <pr>` — human-invoked squash merge of a ready-to-deploy PR.
  const isMergeCommand = numArg === "merge";
  // `pipeline merge-queue --milestone <m> [--apply] [--release-when-complete] …` (#676).
  const isMergeQueueCommand = numArg === "merge-queue";
  // `pipeline train --milestone <m>|--issues <n,n> [--merge] [--json]` — integrate train.
  const isTrainCommand = numArg === "train";
  // `pipeline loop ...` (#451) — deterministic preflight + delegation to goal-loop.
  // Needs no PipelineConfig and calls no gh at all (see command-registry.ts).
  const isLoopCommand = numArg === "loop";
  // `pipeline single <N>` — canonical durable one-item autonomous drive.
  const isSingleCommand = numArg === "single";
  // `pipeline refine-spec --title "<t>" --body "<b>"` — non-mutating spec refinement preview.
  const isRefineSpecCommand = numArg === "refine-spec";
  // `pipeline grill --issue N | --issues | --milestone | --label` — native admission.
  const isGrillCommand = numArg === "grill";

  // `pipeline logs [<run-id>] [-f]` is independent of the original pipeline process
  // and must work even when gh is missing, unauthenticated, or the remote is
  // unavailable. Handle it before config/gh resolution (and before the flag
  // validation below) using only the repo directory (derived from --repo-path or cwd).
  if (numArg === "logs") {
    // Resolve to the git root (same semantics as resolveConfig) so a nested
    // --repo-path still finds the run store under the repository root (#155).
    const logsStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(logsStart) ?? logsStart;
    const logsArg = cmd.args[1];
    const logsRunId =
      typeof logsArg === "string" && logsArg.length > 0 && !logsArg.startsWith("-")
        ? logsArg
        : undefined;
    // Advance events follow: until-terminal default on `run_complete` (#725);
    // --no-until-terminal restores interrupt-only. terminal.log follow stays interrupt-only.
    await runLogs(repoDir, logsRunId, !!opts.follow, !!opts.events, {
      untilTerminal: opts.untilTerminal !== false,
    });
    return;
  }

  // `pipeline loop logs [<run-id>] [--events] [--follow|-f] [--until-terminal|--no-until-terminal]`
  // (#666 / #699): observe a durable loop run's events.jsonl under the loop
  // state home. Nested `logs` must never enter loop preflight or the supervisor
  // drive path. Dispatched before flag validation / config / gh — same offline
  // discipline as advance `pipeline logs`. Default follow exits 0 on
  // loop_run_stopped or loop_run_complete; --no-until-terminal restores interrupt-only.
  if (numArg === "loop" && cmd.args[1] === "logs") {
    const loopLogsArg = cmd.args[2];
    const loopLogsRunId =
      typeof loopLogsArg === "string" && loopLogsArg.length > 0 && !loopLogsArg.startsWith("-")
        ? loopLogsArg
        : undefined;
    // `--events` is accepted for parity with advance logs but the selected
    // artifact is always events.jsonl (loop store has no terminal.log).
    // Commander default for --until-terminal is true; --no-until-terminal → false.
    await runLoopLogs(loopLogsRunId, !!opts.follow, undefined, {
      untilTerminal: opts.untilTerminal !== false,
    });
    return;
  }

  // `pipeline summary <selector>` supports the issue-scoped replacement for
  // `pipeline N --summary` as well as exact run-id selection. Both routes are
  // local/offline. Positive integers derive the same default domain as config
  // resolution, while --domain preserves explicit legacy-fallback selection.
  const summaryTarget = numArg === "summary" ? parseSummaryTarget(cmd.args[1]) : null;
  if (numArg === "summary") {
    const maxSummaryPositionals = maxPositionalsFor("summary");
    if (cmd.args.length > maxSummaryPositionals) {
      const extra = cmd.args.slice(maxSummaryPositionals).join(", ");
      console.error(`pipeline: unexpected argument(s): ${extra}`);
      process.exit(2);
    }
    const summaryStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(summaryStart) ?? summaryStart;
    if (!summaryTarget) {
      console.error(
        "pipeline summary: a positive issue number or run-id is required.\n" +
          "  Usage: pipeline summary <issue-number|run-id>\n" +
          "  Example (issue): pipeline summary 147\n" +
          "  Example (run):   pipeline summary 147-2026-06-20T10-00-00-000Z\n" +
          "  Tip:    pipeline logs   (lists available run-ids)",
      );
      process.exit(2);
    }
    const summaryEntry = lookupCommand("summary");
    const unsupportedSummaryFlags = summaryEntry ? validateFlags(summaryEntry, cmd) : [];
    if (unsupportedSummaryFlags.length > 0) {
      const flags = unsupportedSummaryFlags
        .map((key) => cmd.options.find((option) => option.attributeName() === key)?.long ?? `--${key}`)
        .join(", ");
      console.error(`pipeline: 'pipeline summary' does not support ${flags}.`);
      process.exit(2);
    }
    if (summaryTarget.kind === "run") {
      await runSummaryByRunId(repoDir, summaryTarget.runId);
      return;
    }
    const summaryCfg = {
      domain: opts.domain ?? path.basename(repoDir),
      repo_dir: repoDir,
    } as PipelineConfig;
    await runSummary(summaryCfg, summaryTarget.issueNumber, repoDir);
    return;
  }

  // Unified per-command flag validation via the command registry. Checks that
  // every explicitly-provided CLI flag is in the command's allowedFlags set.
  // merge preserves its exact error message format (downstream tooling asserts it).
  // advance ("all") and run ("all") always return no offending flags.
  // Semantic cross-flag checks (--is-ok, --json, --force, --remove-worktree) remain
  // below as they cannot be expressed as per-command allowlists.
  //
  // Flag-only modes (--init, --cleanup, --remove-worktree) must resolve to their
  // registry entries rather than the advance entry, because numArg is undefined or
  // numeric for these modes and lookupCommand would otherwise return advance (allowedFlags:"all").
  // The override only applies when numArg is absent or numeric — if a named subcommand
  // (e.g. "intake", "release") is in numArg, the subcommand entry governs validation.
  const isNumericOrAbsent = !numArg || /^\d+$/.test(numArg);
  const effectiveCommandKey: string | undefined =
    (opts.removeWorktree && isNumericOrAbsent) ? "remove-worktree" :
    (opts.cleanup && isNumericOrAbsent)        ? "cleanup" :
    (opts.init && isNumericOrAbsent)           ? "init" :
    numArg;
  const entry = lookupCommand(effectiveCommandKey);
  if (entry !== null) {
    const offendingKeys = validateFlags(entry, cmd);
    if (offendingKeys.length > 0) {
      const flags = offendingKeys
        .map((key) => cmd.options.find((o) => o.attributeName() === key)?.long ?? `--${key}`)
        .join(", ");
      if (isMergeCommand) {
        console.error(
          `pipeline: 'pipeline merge' does not support ${flags}. ` +
            `'pipeline merge <pr>' is a human-invoked squash merge; only --repo-path, --base, and --profile apply.`,
        );
      } else if (isMergeQueueCommand) {
        console.error(
          `pipeline: 'pipeline merge-queue' does not support ${flags}. ` +
            `Allowed: --milestone, --apply, --dry-run, --repair, --release-when-complete, ` +
            `--release-version, --repo-path, --base, --profile.`,
        );
      } else if (isTrainCommand) {
        console.error(
          `pipeline: 'pipeline train' does not support ${flags}. ` +
            `Allowed: --milestone, --issues, --merge, --json, --dry-run, --repo-path, --base, --profile.`,
        );
      } else if (opts.removeWorktree && isNumericOrAbsent) {
        console.error(`pipeline: '--remove-worktree' mode does not support ${flags}. These are separate modes.`);
      } else if (opts.cleanup && isNumericOrAbsent) {
        console.error(`pipeline: '--cleanup' does not support ${flags}. These are separate modes.`);
      } else if (opts.init && isNumericOrAbsent) {
        console.error(`pipeline: '--init' does not support ${flags}. These are separate modes.`);
      } else {
        console.error(
          `pipeline: '${numArg}' cannot be combined with ${flags}. These are separate commands.`,
        );
      }
      process.exit(2);
    }
  }

  // Validate machine-mode flags immediately after parsing — before config
  // resolution or any dispatch — so a typo/construction bug can't silently
  // fall through to the mutating advance path.
  if (opts.isOk && !isDoctorCommand) {
    console.error("pipeline: --is-ok is only valid for the doctor command. Usage: pipeline doctor --is-ok");
    process.exit(2);
  }
  // --json and --is-ok are mutually exclusive; reject BEFORE config resolution so
  // the rejection cannot be preceded by config-resolution warnings on stderr (#154).
  if (opts.json && opts.isOk) {
    console.error("pipeline doctor: --json and --is-ok are mutually exclusive — use one or the other.");
    process.exit(2);
  }
  // `--json` is allowed when the resolved command registry entry declares
  // supportsJson (train, doctor, path, release finish, engine-promote, …) or when
  // a flag-only JSON mode applies (`pipeline <N> --status --json`, doctor).
  // Do not hand-maintain a parallel allowlist of command names here — it drifts
  // from COMMAND_REGISTRY and blocks ship/supervisor callers (train --json).
  if (
    opts.json &&
    !allowsJsonFlag({
      entry,
      isDoctor: isDoctorCommand,
      statusMode: !!opts.status,
    })
  ) {
    console.error(
      "pipeline: --json is not valid for this invocation. " +
        "Use a JSON-capable command (registry supportsJson), " +
        "`pipeline doctor --json`, or `pipeline <N> --status --json`.",
    );
    process.exit(2);
  }
  // --sha is a full 40-hex candidate override. Reject malformed values before
  // advance so an invalid override cannot fall through to the PR head (#1243).
  if (opts.sha !== undefined && !normalizeFullSha(opts.sha)) {
    console.error("pipeline: --sha must be a full 40-character hexadecimal SHA");
    process.exit(2);
  }
  // --force is scoped to --remove-worktree; using it alone is a usage error.
  if (opts.force && !opts.removeWorktree) {
    console.error("pipeline: --force requires --remove-worktree. Usage: pipeline <N> --remove-worktree --force");
    process.exit(2);
  }
  // --remove-worktree cannot be combined with conflicting modes.
  if (opts.removeWorktree) {
    const rwConflicts: Array<[string, boolean | string | undefined]> = [
      ["--cleanup", opts.cleanup],
      ["--init (or 'pipeline init')", isInit],
      ["--status", opts.status],
      ["--unblock", opts.unblock !== undefined],
      ["--override", opts.override !== undefined],
      ["--dry-run", opts.dryRun],
      ["--detach", opts.detach],
    ];
    for (const [flag, active] of rwConflicts) {
      if (active) {
        console.error(
          `pipeline: --remove-worktree cannot be combined with ${flag}. These are separate modes.`,
        );
        process.exit(2);
      }
    }
  }
  // Validate release args early. Subcommands: prepare (`release <version>`),
  // finish (`release finish <pr>`), or candidate tag (`release ensure-tag`).
  if (isReleaseCommand) {
    const subEarly = cmd.args[1];
    if (!subEarly) {
      console.error(
        "pipeline release: a version argument or 'finish <pr>' is required.\n" +
          "  Usage: pipeline release <X.Y.Z | major | minor | patch> [--theme \"...\"] [--dry-run|--json] [--no-edit] [--skip-frg]\n" +
          "         pipeline release finish <pr> [--json]\n" +
          "         pipeline release ensure-tag <X.Y.Z> <merge-commit-oid> --packed-candidate <40-hex>\n" +
          "         [--allow-open-soak-defects \"<reason>\"]\n" +
          "  Prepare stops at an open release PR (never tags/merges).\n" +
          "  finish merges an open release PR after checks (never tags).\n" +
          "  ensure-tag is the ship-end tag owner from on-disk HMAC latest.json when FRG is gitignored.\n" +
          "  Tag-derived CHANGELOG refresh runs automatically after auto-tag (#978).",
      );
      process.exit(2);
    }
    if (subEarly === "finish") {
      const prArg = cmd.args[2];
      if (!prArg || !/^[1-9][0-9]*$/.test(prArg)) {
        console.error(
          "pipeline release finish: a positive PR number is required.\n" +
            "  Usage: pipeline release finish <pr> [--json]",
        );
        process.exit(2);
      }
    } else if (subEarly === "ensure-tag") {
      const versionArg = cmd.args[2];
      const oidArg = cmd.args[3];
      const packedArg = typeof opts.packedCandidate === "string" ? opts.packedCandidate : "";
      if (!versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg) || !oidArg || !/^[0-9a-f]{40}$/i.test(oidArg)) {
        console.error(
          "pipeline release ensure-tag: a bare X.Y.Z version and 40-hex merge commit OID are required.\n" +
            "  Usage: pipeline release ensure-tag <X.Y.Z> <merge-commit-oid> --packed-candidate <40-hex>",
        );
        process.exit(2);
      }
      if (!/^[0-9a-f]{40}$/i.test(packedArg)) {
        console.error(
          "pipeline release ensure-tag: --packed-candidate <40-hex> is required.\n" +
            "  Usage: pipeline release ensure-tag <X.Y.Z> <merge-commit-oid> --packed-candidate <40-hex>",
        );
        process.exit(2);
      }
    } else if (/^\d+$/.test(subEarly)) {
      console.error(
        `pipeline release: "${subEarly}" looks like an issue/PR number, not a version.\n` +
          `  Prepare: pipeline release <X.Y.Z | major | minor | patch>\n` +
          `  Finish:  pipeline release finish <pr>`,
      );
      process.exit(2);
    }
  }

  // `pipeline config schema`, `pipeline config validate`, and `pipeline config sync` — dispatch before
  // resolveConfig() so they work without gh auth or a fully resolvable repo.
  if (numArg === "config") {
    await runConfigCommand(cmd.args.slice(1), opts);
    return;
  }

  // `pipeline run <N> [--detach ...]` — subcommand dispatch.
  if (numArg === "run") {
    // Reject extra positionals BEFORE the --detach branch so a malformed detached
    // run (e.g. `pipeline run 123 config validate --detach`) cannot start a real
    // background advance — the post-dispatch guard never runs on the detach path (#156).
    if (cmd.args.length > 2) {
      console.error(`pipeline run: unexpected argument(s): ${cmd.args.slice(2).join(", ")}`);
      process.exit(2);
    }
    if (opts.detach) {
      // Guard: reject mode-selector flags before launching a detached advance,
      // just as the `pipeline N --detach` canonical path does (lines ~591-602).
      const runModeConflicts: Array<[string, boolean | string | undefined]> = [
        ["--status", opts.status],
        ["--summary", opts.summary],
        ["--unblock", opts.unblock !== undefined],
        ["--override", opts.override !== undefined],
        ["--cleanup", opts.cleanup],
        ["--init", opts.init],
      ];
      for (const [flag, active] of runModeConflicts) {
        if (active) {
          console.error(`pipeline run: --detach cannot be combined with ${flag}. These are separate modes.`);
          process.exit(2);
        }
      }
      // Detach path: spawn a background wrapper and exit.
      await handleRunSubcommand(cmd.args[1] ?? "", opts);
      return;
    }
    // Non-detach: `pipeline run <N>` ≡ `pipeline <N>`. Redirect by overriding
    // numArg so the normal lifecycle (kill-switch, preflight, issue/PR
    // resolution) applies identically — avoids duplicating those guards here.
    const runIssueArg = cmd.args[1] ?? "";
    const runNum = Number.parseInt(runIssueArg, 10);
    if (!Number.isFinite(runNum) || runNum <= 0) {
      console.error("pipeline run: <number> argument is required and must be a positive integer");
      process.exitCode = 2;
      return;
    }
    numArg = runIssueArg;
  }

  // `pipeline N --detach`: detach the advance loop to a background process.
  // Equivalent to the legacy `pipeline run N --detach`; `run` is retained as an
  // undocumented alias but `N --detach` is the canonical detached-launch surface.
  // Guard: require exactly one positional (the issue number) and reject incompatible
  // mode-selector flags before dispatching, so e.g. `pipeline 42 config validate --detach`
  // or `pipeline 42 --status --detach` never accidentally start a mutating advance.
  if (opts.detach && numArg && /^\d+$/.test(numArg)) {
    if (cmd.args.length > 1) {
      const extra = cmd.args.slice(1).join(", ");
      console.error(`pipeline: unexpected argument(s): ${extra}`);
      process.exit(2);
    }
    const detachModeConflicts: Array<[string, boolean | string | undefined]> = [
      ["--status", opts.status],
      ["--summary", opts.summary],
      ["--unblock", opts.unblock !== undefined],
      ["--override", opts.override !== undefined],
    ];
    for (const [flag, active] of detachModeConflicts) {
      if (active) {
        console.error(`pipeline: --detach cannot be combined with ${flag}. These are separate modes.`);
        process.exit(2);
      }
    }
    await handleRunSubcommand(numArg, opts);
    return;
  }

  // `pipeline path [--json]` — probe installed hosts and print the result.
  if (numArg === "path") {
    await handlePathSubcommand(opts);
    return;
  }

  // `pipeline controls check [--json] [--strict]` — read-only repository-control
  // drift compare (#695). Never mutates forge settings.
  if (numArg === "controls") {
    await handleControlsCommand(cmd.args.slice(1), opts);
    return;
  }

  // Guard: extra positional arguments are a mistake for the remaining commands
  // (plain `pipeline <N>`, doctor, init). `run <N>`, `release <version>`, and
  // `intake [description]` legitimately have two positionals; `config`/`path`
  // already returned above. `sweep` is a bulk command with no issue number —
  // extra positionals are always a mistake. Catches e.g. "pipeline 123 config validate" (#156).
  // `status <N>` takes two positionals; `unblock <N> "<answer>"` and
  // `override <N> "<spec>"` take three, as does `evals <subcommand>
  // <manifest.json|experiment-dir|harvest-request.json>` (#535).
  // `loop` accepts the keyword plus up to MAX_RANGE_SPAN issue numbers so an
  // explicit issue-list selector reaches normalizeLoopArgs (#554).
  // `handoff` admits documented sub-verbs (`list` = verb only;
  // `show|answer|reject|supersede` = verb + one ID) (#1349).
  const maxPositionals = maxPositionalsFor(cmd.args[0], cmd.args);
  if (cmd.args.length > maxPositionals) {
    const extra = cmd.args.slice(maxPositionals).join(", ");
    console.error(`pipeline: unexpected argument(s): ${extra}`);
    process.exit(2);
  }

  // Pipeline-owned shipment coordinator. JSON stdout is reserved for one
  // terminal status object; all stage progress goes to stderr through the
  // production adapter.
  if (isShipCommand) {
    let shipInput: ShipCliInput;
    try {
      shipInput = normalizeShipCliInput(cmd.args, opts);
    } catch (err) {
      console.error(`pipeline ship: ${(err as Error).message}`);
      process.exit(2);
    }

    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir);
    if (!repoDir) {
      console.error(
        `pipeline ship: no git repo found at or above ${startDir}. Run from inside a checkout, or pass --repo-path.`,
      );
      process.exit(2);
    }
    // Repository identity is part of the stable status key. Use the normal
    // config resolver so the key binds the same explicit/gh-resolved owner/name
    // as every GitHub-mutating stage. Status remains read-only, but requires
    // repository access instead of guessing identity from a remote URL.
    let shipCfg: PipelineConfig;
    try {
      shipCfg = resolveConfig({
        repoPath: repoDir,
        baseBranch: opts.base,
        profile: opts.profile,
      });
    } catch (err) {
      console.error(`pipeline ship: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    const coordinates = {
      repository: shipCfg.repo,
      base_branch: shipCfg.base_branch,
      milestone: shipInput.milestone,
      version: shipInput.version,
    };

    try {
      const {
        defaultShipStateStore,
        runShipCoordinator,
        shipKey,
        validateBuzzShipAuthorization,
        operatorShipIntent,
        OPERATOR_SHIP_FINGERPRINT,
      } = await import("./stages/ship.ts");

      if (shipInput.mode === "status") {
        const key = shipKey(coordinates);
        const status = await defaultShipStateStore().read(key);
        if (!status || status.ship_key !== key) {
          console.log(JSON.stringify({
            schema_version: 1,
            kind: "ship_status",
            ship_key: key,
            status: "none",
            repository: coordinates.repository,
            base_branch: coordinates.base_branch,
            milestone: coordinates.milestone,
            version: coordinates.version,
          }, null, 2));
          return;
        }
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      const operatorMode = !shipInput.authorizationPath;
      let authorization: unknown = null;
      let intent = operatorShipIntent(coordinates);
      let authorizationPublicKey = "";
      let admissionFingerprint = OPERATOR_SHIP_FINGERPRINT;
      if (!operatorMode) {
        const authorizationText = await fsPromises.readFile(shipInput.authorizationPath!, "utf8");
        try {
          authorization = JSON.parse(authorizationText);
        } catch (err) {
          throw new Error(`authorization file is not valid JSON: ${(err as Error).message}`);
        }
        if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
          throw new Error("authorization file must contain one JSON object");
        }
        const authRecord = authorization as Record<string, unknown>;
        intent = {
          ...coordinates,
          event_id: String(authRecord.event_id ?? ""),
          sender_id: String(authRecord.sender_id ?? ""),
          channel_id: String(authRecord.channel_id ?? ""),
          thread_id: String(authRecord.thread_id ?? ""),
        };
        const authorizationPublicKeyPath =
          String(process.env.PIPELINE_SHIP_AUTH_PUBLIC_KEY_FILE ?? DEFAULT_SHIP_AUTH_PUBLIC_KEY_FILE).trim();
        const publicKeyMetadata = await fsPromises.lstat(authorizationPublicKeyPath);
        validateShipAuthorizationPublicKeyFile(authorizationPublicKeyPath, publicKeyMetadata);
        authorizationPublicKey = await fsPromises.readFile(authorizationPublicKeyPath, "utf8");
        // Validate before admission so syntax, expiry, and identity failures do
        // not cause an old coordinate status to be emitted as this request's
        // failure result. The coordinator repeats this check at its trust edge.
        const validatedAuthorization = validateBuzzShipAuthorization(
          authorization,
          intent,
          new Date(),
          authorizationPublicKey,
        );
        admissionFingerprint = validatedAuthorization.fingerprint;
      }
      const { realShipCoordinatorDeps } = await import("./stages/ship-adapter.ts");
      const shipState = defaultShipStateStore();
      const shipTrainReadDeps = realTrainDeps({
        repoDir: shipCfg.repo_dir,
        repo: shipCfg.repo,
        baseBranch: shipCfg.base_branch,
        advanceWave: async () => {
          throw new Error("ship advanceWave must be supplied by the CLI adapter");
        },
      });
      const coordinatorDeps = realShipCoordinatorDeps({
        repoDir: shipCfg.repo_dir,
        repo: shipCfg.repo,
        baseBranch: shipCfg.base_branch,
        profile: opts.profile,
        progress: (message: string) => process.stderr.write(`${message}\n`),
        authorizationPublicKey,
        // Same multi-item loop wave as `runTrainCommand` — not N×single (#1023 / #1028).
        advanceWave: (issues) =>
          advanceWaveThroughLoop(issues, opts, shipTrainReadDeps.getIssue),
        state: shipState,
      });
      try {
        const status = await runShipCoordinator(intent, authorization, coordinatorDeps);
        console.log(JSON.stringify(status, null, 2));
        if (!status.complete) process.exit(1);
      } catch (err) {
        // A lifecycle-stage failure is part of the machine contract when the
        // coordinator persisted it. Print exactly that status once. Failures
        // before admission remain stderr-only.
        const failedStatus = await shipState.read(shipKey(coordinates));
        const message = err instanceof Error ? err.message : String(err);
        const persistedFailure = selectPersistedShipFailureStatus(
          failedStatus,
          admissionFingerprint,
          message,
        );
        if (persistedFailure) {
          console.log(JSON.stringify(persistedFailure, null, 2));
        }
        throw err;
      }
    } catch (err) {
      console.error(`pipeline ship: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early release dispatch — prepare (version) or finish (merge release PR).
  if (isReleaseCommand) {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir);
    if (!repoDir) {
      console.error(
        `pipeline: no git repo found at or above ${startDir}. Run from inside a checkout, or pass --repo-path.`,
      );
      process.exit(2);
    }
    const localCfg = resolveReleaseConfig(repoDir, opts.base, opts.profile);

    // Candidate-engine leaf: create/push the annotated release tag (#1151).
    // Coordinator-side pin processes spawn this verb; they must not import
    // ensureAnnotatedReleaseTag from the pin process.
    if (cmd.args[1] === "ensure-tag") {
      const tagVersion = String(cmd.args[2]);
      const mergeCommitOid = String(cmd.args[3]).toLowerCase();
      try {
        const { runEnsureAnnotatedReleaseTagCli } = await import("./stages/ship-adapter.ts");
        const result = await runEnsureAnnotatedReleaseTagCli({
          repoDir,
          repo: localCfg.repo,
          version: tagVersion,
          mergeCommitOid,
          packedCandidate: String(opts.packedCandidate ?? "").toLowerCase(),
        });
        if (opts.json) {
          console.log(JSON.stringify({
            schema_version: 1,
            kind: "release_ensure_tag",
            version: tagVersion,
            merge_commit_oid: mergeCommitOid,
            packed_candidate: String(opts.packedCandidate ?? "").toLowerCase(),
            result,
          }, null, 2));
        } else {
          console.log(
            `[pipeline release ensure-tag] v${tagVersion} ${result} merge=${mergeCommitOid.slice(0, 12)}`,
          );
        }
      } catch (err) {
        const message = (err as Error).message;
        reportMechanicalFault(undefined, {
          operation: "release_ensure_tag",
          form_id: "release.ensure-tag",
          message,
          fault: "mechanical",
        });
        console.error(`pipeline release ensure-tag: ${message}`);
        process.exitCode = 1;
      }
      return;
    }

    // finish: operator-authorized merge of a prepared release PR (no tag).
    if (cmd.args[1] === "finish") {
      const pr = Number.parseInt(String(cmd.args[2]), 10);
      try {
        const result = await finishReleasePr(
          pr,
          realReleaseFinishDeps(localCfg.repo, localCfg.repo_dir),
        );
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, kind: "release_finish", ...result }, null, 2));
        } else {
          console.log(
            `[pipeline release finish] PR #${result.pr} v${result.version}` +
              (result.alreadyMerged ? " (already merged)" : " merged") +
              (result.mergeCommitOid ? ` merge=${result.mergeCommitOid.slice(0, 12)}` : ""),
          );
        }
      } catch (err) {
        const message = (err as Error).message;
        reportMechanicalFault(undefined, {
          operation: "release_finish",
          form_id: "release.finish",
          message,
          fault: "mechanical",
        });
        console.error(`pipeline release finish: ${message}`);
        process.exitCode = 1;
      }
      return;
    }

    const versionArg = cmd.args[1] as string;
    try {
      validateReleaseMachineOutputMode(opts);
    } catch (err) {
      console.error(`pipeline release: ${(err as Error).message}`);
      process.exit(2);
    }
    try {
      const releaseDeps = realReleaseDeps(localCfg.repo_dir);
      if (opts.json) {
        // Keep stdout as a one-document machine contract. Release preparation
        // progress remains visible on stderr.
        releaseDeps.stdout = (message) => console.error(message);
        releaseDeps.stderr = (message) => console.error(message);
      }
      const result = await runRelease(
        versionArg,
        {
          dryRun: opts.dryRun,
          noEdit: opts.edit === false,
          theme: typeof opts.theme === "string" ? opts.theme : undefined,
          allowOpenSoakDefects:
            typeof opts.allowOpenSoakDefects === "string"
              ? opts.allowOpenSoakDefects
              : undefined,
          skipFrg: !!opts.skipFrg,
        },
        localCfg,
        releaseDeps,
      );
      if (opts.json) {
        if (!result) throw new Error("release prepare returned no identity");
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!opts.dryRun) {
        reportMechanicalFault(undefined, {
          operation: "release_prepare",
          form_id: "release",
          message,
          fault: "mechanical",
        });
      }
      console.error(`pipeline release: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Early intake dispatch — derives repo_dir/base_branch from local git state
  // only; the spec-generation step calls the harness but creates no pipeline
  // stage labels. Dispatch happens before full config resolution.
  if (isIntakeCommand) {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir);
    if (!repoDir) {
      console.error(
        `pipeline: no git repo found at or above ${startDir}. Run from inside a checkout, or pass --repo-path.`,
      );
      process.exit(2);
    }
    const intakeCfg = resolveReleaseConfig(repoDir, opts.base, opts.profile);
    // Description: prefer --description flag, fall back to the second positional arg.
    const descriptionArg = opts.description ?? cmd.args[1];
    try {
      await runIntake(
        { description: descriptionArg ?? "", release: opts.release, dryRun: opts.dryRun },
        intakeCfg,
        realIntakeDeps(repoDir, intakeCfg.intake_model, intakeCfg.intake_effort, intakeCfg.implementer_harness),
      );
    } catch (err) {
      console.error(`pipeline intake: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early decompose dispatch (#766) — no issue-number positional; dry-run default.
  // Uses full resolveConfig for optional decompose.* bounds + harness models.
  if (isDecomposeCommand) {
    if (opts.dryRun && opts.apply) {
      console.error(
        "pipeline decompose: --dry-run and --apply are mutually exclusive — omit one.",
      );
      process.exit(2);
    }
    const epicRaw = opts.epic;
    if (epicRaw === undefined || epicRaw === null || Number.isNaN(Number(epicRaw)) || Number(epicRaw) < 1) {
      console.error(
        "pipeline decompose: --epic <N> is required (positive issue number).\n" +
          "  Usage: pipeline decompose --epic <N> [--description \"…\"] [--apply] [--release vX.Y.Z]",
      );
      process.exit(2);
    }
    let decomposeCfg: import("./types.ts").PipelineConfig;
    try {
      decomposeCfg = resolveConfig({
        repoPath: opts.repoPath,
        baseBranch: opts.base,
        profile: opts.profile,
      });
    } catch (err) {
      console.error(`pipeline decompose: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    const maxEffortOpt = opts.maxEffort
      ? (String(opts.maxEffort).toUpperCase() as EffortBand)
      : undefined;
    try {
      await runDecompose(
        {
          epic: Number(epicRaw),
          description: opts.description,
          apply: !!opts.apply,
          release: opts.release,
          maxChildren: opts.maxChildren,
          maxEffort: maxEffortOpt,
          allowXl: !!opts.allowXl,
        },
        {
          repo_dir: decomposeCfg.repo_dir,
          repo: decomposeCfg.repo,
          base_branch: decomposeCfg.base_branch,
          domain: decomposeCfg.domain,
          intake_timeout: decomposeCfg.intake_timeout,
          models: decomposeCfg.models,
          effort: decomposeCfg.effort,
          harnesses: decomposeCfg.harnesses,
          git: decomposeCfg.git,
          decompose: decomposeCfg.decompose,
        },
        realDecomposeDeps(
          decomposeCfg.repo_dir,
          decomposeCfg.models.intake,
          decomposeCfg.effort.intake,
          decomposeCfg.harnesses.implementer,
          decomposeCfg.git?.push_auth,
        ),
      );
    } catch (err) {
      console.error(`pipeline decompose: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early grill dispatch — no advance loop. Never merge or deploy.
  if (isGrillCommand) {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    const subVerb = cmd.args[1];
    if (subVerb && subVerb !== "status") {
      process.stderr.write(
        `pipeline grill: unexpected argument "${subVerb}" (status is the only grill sub-verb)\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (subVerb !== "status" && !opts.resume) {
      const selector = parseGrillSelector({
        issue: opts.issue,
        issues: opts.issues,
        milestone: opts.milestone,
        label: opts.label,
      });
      if (!selector.ok) {
        process.stderr.write(`pipeline grill: ${selector.reason}\n`);
        process.exitCode = 2;
        return;
      }
    }
    let grillCfg;
    try {
      grillCfg = resolveConfig({ repoPath: repoDir, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      if (subVerb === "status" || opts.resume) {
        console.error(`pipeline grill: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.error(`pipeline grill: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    const grillDeps = realGrillDeps(grillCfg);
    const exitCode = await runGrill(
      {
        issue: opts.issue,
        issues: opts.issues,
        milestone: opts.milestone,
        label: opts.label,
        dryRun: !!opts.dryRun,
        json: !!opts.json,
        follow: !!opts.follow,
        resume: opts.resume,
        runId: opts.runId,
        status: subVerb === "status",
      },
      grillDeps,
    );
    if (exitCode === 2) process.exit(2);
    if (exitCode !== 0) {
      if (!opts.dryRun && subVerb !== "status") {
        reportMechanicalFault(grillDeps.reportObservation, {
          operation: "grill_admit",
          form_id: "grill",
          message: `pipeline grill exited ${exitCode}`,
          fault: "mechanical",
        });
      }
      process.exitCode = exitCode;
    }
    return;
  }

  // Early refine-spec dispatch — no advance loop, no stage-label writes.
  // --title/--body stays gh-free. --issue preview may still read GitHub.
  // apply is a diagnostic shim toward pipeline grill and does not write.
  if (isRefineSpecCommand) {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    const subVerb = cmd.args[1];
    if (subVerb && subVerb !== "apply") {
      usageError(
        `unexpected argument "${subVerb}" (apply is the only refine-spec sub-verb; a positional proposal blob is not accepted)`,
        (t) => process.stderr.write(t),
      );
      return;
    }
    if (opts.issue && (opts.title || opts.body)) {
      usageError("do not mix --issue with --title or --body", (t) => process.stderr.write(t));
      return;
    }
    if (subVerb === "apply") {
      if (!opts.issue) {
        usageError("apply requires --issue N", (t) => process.stderr.write(t));
        return;
      }
      process.stderr.write(
        `pipeline refine-spec apply is a compatibility shim. Use: pipeline grill --issue ${opts.issue}\n`,
      );
      return;
    }
    if (opts.issue) {
      let issueCfg;
      try {
        issueCfg = resolveConfig({ repoPath: repoDir, baseBranch: opts.base, profile: opts.profile });
      } catch (err) {
        console.error(`pipeline refine-spec: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(
        `pipeline refine-spec --issue is no longer the admission writer. Use: pipeline grill --issue ${opts.issue}\n`,
      );
      await runRefineSpecIssuePreview(opts.issue, realGrillIssuePreviewDeps(issueCfg));
      return;
    }
    const refineSpecCfg = resolveReleaseConfig(repoDir, opts.base, opts.profile);
    await runRefineSpec(
      { title: opts.title ?? "", body: opts.body ?? "" },
      realRefineSpecDeps(repoDir, refineSpecCfg.intake_model, refineSpecCfg.implementer_harness),
    );
    return;
  }

  // Early papercut dispatch (#419) — agent-facing, hidden from --help (see the
  // top-level `.argument()` description string above, which intentionally
  // omits "papercut"). No gh auth or full config resolution: this must work
  // unauthenticated, from inside a running stage, without ever blocking,
  // pausing, or failing that stage. The record path is gated on a best-effort,
  // gh-free `papercuts.enabled` lookup (papercutsEnabled) so the feature stays
  // inert by default; a lookup failure also resolves to disabled. Record
  // failures are swallowed at this CLI boundary too (belt-and-suspenders with
  // recordPapercut's own try/catch) — the command always exits zero on the
  // record path.
  if (numArg === "papercut") {
    const papercutStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(papercutStart) ?? papercutStart;
    const deps = realPapercutDeps();
    if (cmd.args[1] === "report") {
      if (!opts.since) {
        console.error(
          "pipeline papercut report: --since is required.\n" +
            "  Usage: pipeline papercut report --since <date> [--until <date>] --json",
        );
        process.exitCode = 2;
        return;
      }
      const events = await reportPapercuts(
        { repoDir, since: opts.since, until: opts.until },
        deps,
      );
      process.stdout.write(JSON.stringify(events) + "\n");
      process.exitCode = 0;
      return;
    }
    try {
      if (await papercutsEnabled(repoDir, deps)) {
        await recordPapercut(
          { repoDir, run: opts.run ?? "", message: opts.message ?? "" },
          deps,
        );
      }
    } catch {
      // Never propagate — recordPapercut is already a total function, this is
      // belt-and-suspenders at the CLI boundary per the spec's non-fatal contract.
    }
    process.exitCode = 0;
    return;
  }

  // Human-question handoff operator surface (#647): list | show | answer | reject | supersede.
  // Mutating verbs are audited and never merge. Labels remain the workflow authority.
  if (numArg === "handoff") {
    const verb = cmd.args[1] as string | undefined;
    const idOrFilter = cmd.args[2] as string | undefined;
    const handoffStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(handoffStart) ?? handoffStart;
    const hq = await import("./human-question-handoff.ts");
    const {
      listHandoffs,
      loadHandoff,
      answerAndPersistHandoff,
      supersedeAndPersistHandoff,
      formatHandoffListHuman,
      formatHandoffShowHuman,
      HANDOFF_CLASSES,
      HANDOFF_STATUSES,
    } = hq;

    const asStatus = (s: string | undefined) => {
      if (!s) return undefined;
      return (HANDOFF_STATUSES as readonly string[]).includes(s) ? s : undefined;
    };

    if (!verb || !["list", "show", "answer", "reject", "supersede"].includes(verb)) {
      console.error(
        "Usage: pipeline handoff list|show|answer|reject|supersede …\n" +
          "  list   [--issue N] [--run-id id] [--filter-status pending] [--batch 1,2,3] [--json]\n" +
          "  show   <handoff-id> --issue N [--json]\n" +
          "  answer <handoff-id> --issue N --text \"…\" [--client-request-id id]\n" +
          "  reject <handoff-id> --issue N [--reason …] [--client-request-id id]\n" +
          "  supersede <handoff-id> --issue N --question \"…\" --class <class> --capability <cap> --candidate-sha <sha> --resume-target <t>",
      );
      process.exitCode = 2;
      return;
    }

    if (verb === "list") {
      const batchIssues = opts.batch
        ? opts.batch.split(/[,\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0)
        : undefined;
      const statusFilter = asStatus(opts.filterStatus) as
        | import("./human-question-handoff.ts").HandoffStatus
        | undefined;
      const handoffs = await listHandoffs(repoDir, {
        issue: opts.issue,
        run_id: opts.runId ?? null,
        status: statusFilter,
        batch_issue_numbers: batchIssues,
      });
      if (opts.json) {
        console.log(JSON.stringify({ schema_version: "1", handoffs }, null, 2));
      } else {
        console.log(formatHandoffListHuman(handoffs));
      }
      process.exitCode = 0;
      return;
    }

    if (!idOrFilter) {
      console.error(`pipeline handoff ${verb}: missing handoff id`);
      process.exitCode = 2;
      return;
    }
    if (!opts.issue) {
      console.error(`pipeline handoff ${verb}: --issue <N> is required`);
      process.exitCode = 2;
      return;
    }

    if (verb === "show") {
      const loaded = await loadHandoff(repoDir, opts.issue, idOrFilter);
      if (!loaded.ok) {
        console.error(`pipeline handoff show: ${loaded.reason}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(loaded.handoff, null, 2));
      } else {
        console.log(formatHandoffShowHuman(loaded.handoff));
      }
      process.exitCode = 0;
      return;
    }

    // Mutating verbs need authenticated identity.
    const { getGhActor } = await import("./gh.ts");
    const actor = await getGhActor();
    if (!actor) {
      console.error(
        `pipeline handoff ${verb}: could not resolve authenticated GitHub identity (gh auth)`,
      );
      process.exitCode = 1;
      return;
    }

    if (verb === "answer" || verb === "reject") {
      if (verb === "answer" && !(opts.text && opts.text.trim())) {
        console.error('pipeline handoff answer: --text "…" is required');
        process.exitCode = 2;
        return;
      }
      const result = await answerAndPersistHandoff(
        repoDir,
        opts.issue,
        idOrFilter,
        {
          decision: verb === "reject" ? "reject" : "answer",
          actor,
          identitySource: "gh",
          authenticated: true,
          answerText: verb === "answer" ? opts.text : opts.reason ?? "rejected",
          clientRequestId: opts.clientRequestId ?? null,
        },
        undefined,
        verb === "answer"
          ? {
              materialize: async (handoff, text) => {
                let cfg;
                try {
                  cfg = resolveConfig({
                    repoPath: repoDir,
                    baseBranch: opts.base,
                    profile: opts.profile,
                  });
                } catch (err) {
                  return { ok: false as const, reason: (err as Error).message, code: "config" };
                }
                let frontierKey: string;
                try {
                  frontierKey = resolveGrillProposalKey(repoDir, defaultGrillProposalKeyDeps, {
                    createIfMissing: false,
                  });
                } catch (err) {
                  return { ok: false as const, reason: (err as Error).message, code: "config" };
                }
                const out = await materializeGrillAnswer(handoff, text, {
                  getIssueBody: async (n) => (await getIssueDetail(cfg, n)).body,
                  updateIssueBody: async (n, body) => {
                    const gh = spawnSync(
                      "gh",
                      ["issue", "edit", String(n), "-R", cfg.repo, "--body", body],
                      { encoding: "utf8", stdio: "pipe", cwd: repoDir },
                    );
                    if (gh.status !== 0) {
                      throw new Error(gh.stderr?.trim() || "gh issue edit failed");
                    }
                  },
                  repoDir,
                  keyDeps: defaultGrillProposalKeyDeps,
                  frontierKey,
                });
                return out.ok
                  ? { ok: true as const, wrote: out.wrote }
                  : { ok: false as const, reason: out.reason, code: out.code };
              },
              withIssueLock: (domain, issueNumber, fn) => withLock(domain, fn, issueNumber),
            }
          : undefined,
      );
      if (!result.ok) {
        console.error(`pipeline handoff ${verb}: ${result.reason}`);
        process.exitCode = result.code === "body_hash_drift" ? 2 : 1;
        return;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              schema_version: "1",
              ok: true,
              duplicate: result.duplicate,
              advances_item: false,
              handoff: result.handoff,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          result.duplicate
            ? `Handoff ${idOrFilter}: duplicate ${verb} (idempotent, no advance).`
            : `Handoff ${idOrFilter}: ${result.handoff.status} by ${actor}. Item is not advanced by this command alone.`,
        );
      }
      process.exitCode = 0;
      return;
    }

    if (verb === "supersede") {
      const q = (opts.question ?? opts.text ?? "").trim();
      const clsRaw = opts.class ?? "missing_context";
      if (!q) {
        console.error("pipeline handoff supersede: --question is required");
        process.exitCode = 2;
        return;
      }
      if (!(HANDOFF_CLASSES as readonly string[]).includes(clsRaw)) {
        console.error(
          `pipeline handoff supersede: --class must be one of ${HANDOFF_CLASSES.join("|")}`,
        );
        process.exitCode = 2;
        return;
      }
      const cls = clsRaw as import("./human-question-handoff.ts").HandoffClass;
      // Authority-bearing supersede without HDR fails closed in canCreateHandoff.
      // Operator CLI defaults supersede to non-authority classes; product_judgment
      // requires separate authority evidence (not invented here).
      const authorityBearing = ["product_judgment", "risk_authority", "override_disposition"].includes(
        cls,
      );
      if (authorityBearing) {
        console.error(
          "pipeline handoff supersede: authority-bearing classes require human-decision-required " +
            "evidence at create; use a non-authority class or the fix-stage park path",
        );
        process.exitCode = 1;
        return;
      }
      const domain = opts.domain ?? "local";
      const result = await supersedeAndPersistHandoff(repoDir, opts.issue, idOrFilter, {
        domain,
        repo: opts.repoPath ?? repoDir,
        issue_number: opts.issue,
        blocked_stage: "needs-human",
        question: q,
        reason: opts.reason ?? `supersedes ${idOrFilter}`,
        handoff_class: cls,
        authority_mode: "non_authority",
        required_capability: opts.capability ? [opts.capability] : ["operator"],
        candidate_sha: opts.candidateSha ?? null,
        tip_present: !!opts.candidateSha,
        human_decision_required: null,
        policy_bound_authority_gate: false,
        resume_target: opts.resumeTarget ?? "override-or-unblock",
      });
      // If authority class without evidence, create fails closed — good.
      if (!result.ok) {
        console.error(`pipeline handoff supersede: ${result.reason}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              schema_version: "1",
              ok: true,
              prior: result.prior,
              replacement: result.replacement,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Handoff ${idOrFilter} superseded by ${result.replacement.handoff_id}. Prior resume path blocked.`,
        );
      }
      process.exitCode = 0;
      return;
    }

    process.exitCode = 2;
    return;
  }

  // Early `pipeline correction record` dispatch (#499) — a narrow, non-mutating
  // command that records exactly one correction_event against an EXISTING run.
  // No config resolution or gh auth required — it locates the run directory
  // host-locally and appends via emitCorrectionEvent. It has no
  // advance/unblock/override/merge/deploy/code-mutation path: on success its
  // only side effect is the one appended, sanitized correction_event.
  if (numArg === "correction") {
    const correctionStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(correctionStart) ?? correctionStart;

    // `pipeline correction attribute` (#501) — a narrow, non-mutating command
    // that appends exactly one control_attribution to the durable repo-level
    // ledger. Unlike `correction record`, this is never scoped to a run — a
    // control_attribution links a correction_key (a factory-level class) to
    // its control, not to any one run — so it needs no run lookup at all.
    if (cmd.args[1] === "attribute") {
      const attrMissing: string[] = [];
      if (!opts.correctionKey) attrMissing.push("--correction-key");
      if (!opts.controlType) attrMissing.push("--control-type");
      if (!opts.disposition) attrMissing.push("--disposition");
      if (attrMissing.length > 0) {
        console.error(`pipeline correction attribute: missing required field(s): ${attrMissing.join(", ")}`);
        process.exitCode = 2;
        return;
      }
      if (!(CORRECTION_PROPOSED_CONTROLS as readonly string[]).includes(opts.controlType!)) {
        console.error(`pipeline correction attribute: --control-type must be one of ${CORRECTION_PROPOSED_CONTROLS.join("|")}`);
        process.exitCode = 2;
        return;
      }
      if (!(CONTROL_ATTRIBUTION_DISPOSITIONS as readonly string[]).includes(opts.disposition!)) {
        console.error(`pipeline correction attribute: --disposition must be one of ${CONTROL_ATTRIBUTION_DISPOSITIONS.join("|")}`);
        process.exitCode = 2;
        return;
      }
      // An effective control's recurrence boundary is the control's actual
      // effective time, not this command's invocation time (#501 review-1
      // finding c98822e3) — required whenever this record ships one.
      const shipsEffectiveControl =
        opts.disposition === "implemented" ||
        (opts.disposition === "superseded" && (opts.effectiveCommit !== undefined || opts.effectiveRelease !== undefined));
      if (shipsEffectiveControl && (!opts.effectiveAt || Number.isNaN(Date.parse(opts.effectiveAt)))) {
        console.error(
          'pipeline correction attribute: --effective-at <iso> is required (and must be a valid ISO timestamp) ' +
            'when --disposition is implemented, or superseded with --effective-commit/--effective-release',
        );
        process.exitCode = 2;
        return;
      }
      let evidenceRefKind: string | undefined;
      let evidenceRefId: string | undefined;
      if (opts.evidenceRef !== undefined) {
        const evidenceSep = opts.evidenceRef.indexOf(":");
        if (evidenceSep === -1) {
          console.error('pipeline correction attribute: --evidence-ref must be "<kind>:<id>"');
          process.exitCode = 2;
          return;
        }
        evidenceRefKind = opts.evidenceRef.slice(0, evidenceSep);
        evidenceRefId = opts.evidenceRef.slice(evidenceSep + 1);
        if (!(EVIDENCE_REF_KINDS as readonly string[]).includes(evidenceRefKind)) {
          console.error(`pipeline correction attribute: --evidence-ref kind must be one of ${EVIDENCE_REF_KINDS.join("|")}`);
          process.exitCode = 2;
          return;
        }
      }

      const attributed = await emitControlAttribution(repoDir, {
        correction_key: opts.correctionKey!,
        control_type: opts.controlType as CorrectionProposedControl,
        disposition: opts.disposition as ControlAttributionDisposition,
        issue: opts.issue ?? null,
        pr: opts.pr ?? null,
        effective_commit: opts.effectiveCommit ?? null,
        effective_release: opts.effectiveRelease ?? null,
        effective_at: opts.effectiveAt ?? null,
        supersedes: opts.supersedes ?? null,
        ...(evidenceRefKind !== undefined
          ? { evidence_ref: { kind: evidenceRefKind as EvidenceRefKind, id: evidenceRefId! } }
          : {}),
        note: opts.note ?? "",
      }, defaultRunStoreDeps);
      if (!attributed) {
        console.error(`pipeline correction attribute: failed to append control_attribution to ${repoDir}.`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = 0;
      return;
    }

    if (cmd.args[1] !== "record") {
      console.error(
        'pipeline correction: unrecognized action.\n' +
          '  Usage: pipeline correction record --issue <N> --source-kind <kind> --failure-class <class> ' +
          '--stage <stage> --evidence-ref <kind:id> --correction-text <text> --reusable <yes|no|unknown> ' +
          '[--proposed-control <control>] [--run-id <id>]\n' +
          '     or: pipeline correction attribute --correction-key <key> --control-type <type> ' +
          '--disposition <implemented|human-owned|rejected|superseded> [--issue <n>] [--pr <n>] ' +
          '[--effective-commit <sha>] [--effective-release <tag>] --effective-at <iso> ' +
          '(required for implemented, or superseded with --effective-commit/--effective-release) ' +
          '[--supersedes <attribution-id>] [--evidence-ref <kind:id>] [--note <text>]',
      );
      process.exitCode = 2;
      return;
    }
    const missing: string[] = [];
    if (opts.issue === undefined) missing.push("--issue");
    if (!opts.sourceKind) missing.push("--source-kind");
    if (!opts.failureClass) missing.push("--failure-class");
    if (!opts.stage) missing.push("--stage");
    if (!opts.evidenceRef) missing.push("--evidence-ref");
    if (!opts.correctionText) missing.push("--correction-text");
    if (!opts.reusable) missing.push("--reusable");
    if (missing.length > 0) {
      console.error(`pipeline correction record: missing required field(s): ${missing.join(", ")}`);
      process.exitCode = 2;
      return;
    }
    // #499 review-2 finding 34d10c78: the command is operator-authorized —
    // `retry`/`repair` are reserved for the Pipeline-owned recovery and
    // repair paths (which derive actor_kind: "pipeline"); accepting them here
    // would let an operator record a manual correction that misattributes
    // itself as an autonomous pipeline action.
    if (!(CORRECTION_HUMAN_SOURCE_KINDS as readonly string[]).includes(opts.sourceKind!)) {
      console.error(`pipeline correction record: --source-kind must be one of ${CORRECTION_HUMAN_SOURCE_KINDS.join("|")}`);
      process.exitCode = 2;
      return;
    }
    if (!(CORRECTION_FAILURE_CLASSES as readonly string[]).includes(opts.failureClass!)) {
      console.error(`pipeline correction record: --failure-class must be one of ${CORRECTION_FAILURE_CLASSES.join("|")}`);
      process.exitCode = 2;
      return;
    }
    if (!(CORRECTION_REUSABLE as readonly string[]).includes(opts.reusable!)) {
      console.error(`pipeline correction record: --reusable must be one of ${CORRECTION_REUSABLE.join("|")}`);
      process.exitCode = 2;
      return;
    }
    if (opts.proposedControl !== undefined && !(CORRECTION_PROPOSED_CONTROLS as readonly string[]).includes(opts.proposedControl)) {
      console.error(`pipeline correction record: --proposed-control must be one of ${CORRECTION_PROPOSED_CONTROLS.join("|")}`);
      process.exitCode = 2;
      return;
    }
    const evidenceSep = opts.evidenceRef!.indexOf(":");
    if (evidenceSep === -1) {
      console.error('pipeline correction record: --evidence-ref must be "<kind>:<id>"');
      process.exitCode = 2;
      return;
    }
    const evidenceRefKind = opts.evidenceRef!.slice(0, evidenceSep);
    const evidenceRefId = opts.evidenceRef!.slice(evidenceSep + 1);
    if (!(EVIDENCE_REF_KINDS as readonly string[]).includes(evidenceRefKind)) {
      console.error(`pipeline correction record: --evidence-ref kind must be one of ${EVIDENCE_REF_KINDS.join("|")}`);
      process.exitCode = 2;
      return;
    }

    const correctionRunDir = opts.runId
      ? runDirPath(repoDir, opts.runId)
      : await latestRunDirForIssue(repoDir, opts.issue!, defaultRunStoreDeps).catch(() => null);
    if (!correctionRunDir) {
      console.error(`pipeline correction record: no run found for issue #${opts.issue} (pass --run-id to target a specific run).`);
      process.exitCode = 1;
      return;
    }

    // #499 finding 9f3a5ede: a constructed path is not a located run — require
    // a readable, parseable run.json AND confirm it actually belongs to
    // --issue before recording anything against it.
    let runMeta: { issue?: number; repo?: string } | null = null;
    try {
      const raw = await defaultRunStoreDeps.readFile(path.join(correctionRunDir, "run.json"));
      runMeta = JSON.parse(raw) as { issue?: number; repo?: string };
    } catch {
      runMeta = null;
    }
    if (!runMeta) {
      console.error(`pipeline correction record: run directory for #${opts.issue} could not be read (missing or malformed run.json).`);
      process.exitCode = 1;
      return;
    }
    if (runMeta.issue !== opts.issue) {
      console.error(`pipeline correction record: run ${path.basename(correctionRunDir)} belongs to issue #${runMeta.issue}, not #${opts.issue}.`);
      process.exitCode = 1;
      return;
    }

    const appended = await emitCorrectionEvent(correctionRunDir, {
      issue: opts.issue!,
      repo: runMeta.repo ?? "",
      run_id: path.basename(correctionRunDir),
      stage: opts.stage!,
      source_kind: opts.sourceKind as CorrectionSourceKind,
      failure_class: opts.failureClass as CorrectionFailureClass,
      reviewed_sha: opts.reviewedSha ?? null,
      head_sha: opts.headSha ?? null,
      evidence_ref: { kind: evidenceRefKind as EvidenceRefKind, id: evidenceRefId },
      correction: opts.correctionText!,
      reusable: opts.reusable as CorrectionReusable,
      ...(opts.proposedControl !== undefined
        ? { proposed_control: opts.proposedControl as CorrectionProposedControl }
        : {}),
    }, defaultRunStoreDeps);
    if (!appended) {
      console.error(`pipeline correction record: failed to append correction_event to run ${path.basename(correctionRunDir)}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
    return;
  }

  // Early `pipeline report` dispatch (#502) — privacy-safe upstream
  // product-fault reporting. Reads the `product_fault` config block directly
  // (gh-free) rather than via resolveConfig, so the command stays inert and
  // works unauthenticated when reporting is disabled or absent — matching
  // the feature's default-inert contract. On success its only side effects
  // are (a) an explicitly-confirmed network submission or a printed manual
  // fallback draft, and (b) one appended local consent/audit record; it never
  // calls `gh` and never creates a GitHub issue itself.
  if (numArg === "report") {
    const reportStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(reportStart) ?? reportStart;
    const result = await runProductFaultReport(
      { repoDir, assumeYes: opts.yes },
      realProductFaultReportDeps(),
    );
    process.exitCode =
      (result.outcome === "submitted" && !result.ok) || result.outcome === "auth-rejected" ? 1 : 0;
    return;
  }

  // Early improve dispatch — no issue number, no config resolution required.
  // Read-only by default; --apply creates GitHub issues via gh issue create only.
  if (numArg === "improve") {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    const { runImprove, realImproveDeps } = await import("./improve.ts");
    try {
      await runImprove(
        {
          apply: !!opts.apply,
          top: opts.top,
          since: opts.since,
          minOccurrences: opts.minOccurrences,
          json: !!opts.json,
          repoDir,
          interventions: !!opts.interventions,
        },
        realImproveDeps(repoDir),
      );
    } catch (err) {
      console.error(`pipeline improve: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // `pipeline factory-release prepare --request <abs.json> --json` (#953 / #908).
  // Durable post-pilot FRG generation + prepare-only release handoff.
  // Two-call protocol; never merges/tags/promotes/installs.
  if (numArg === "factory-release") {
    const verb = cmd.args[1] as string | undefined;
    if (verb !== "prepare") {
      console.error(
        "pipeline factory-release: expected subcommand 'prepare'.\n" +
          "  Usage: pipeline factory-release prepare --request <absolute-off-repo-request.json> --json\n" +
          "  --request must resolve outside the target checkout ($TMPDIR, AGENT_PIPELINE_STATE_HOME, or Tugboat $RUN_DIR).\n" +
          "  Idempotent multi-tick protocol for versions after 1.33.0:\n" +
          "    1) starts/resumes a bound factory-gate pack loop and returns status in_progress\n" +
          "    2) after the bound loop is terminal and scored --from-run (no --observations),\n" +
          "       returns status awaiting_frg_attestation with unsigned artifact digests\n" +
          "    3) after production-owned attestation, returns status complete with release PR\n" +
          "  See docs/factory-reliability-gate-runbook.md",
      );
      process.exit(2);
    }
    if (!opts.json) {
      console.error(
        "pipeline factory-release prepare: --json is required (machine-readable multi-tick protocol).",
      );
      process.exit(2);
    }
    const requestPath = opts.request ? String(opts.request).trim() : "";
    if (!requestPath) {
      console.error(
        "pipeline factory-release prepare: --request <absolute-off-repo-request.json> is required.\n" +
          "  Usage: pipeline factory-release prepare --request <absolute-off-repo-request.json> --json\n" +
          "  --request must resolve outside the target checkout ($TMPDIR, state dir, or Tugboat $RUN_DIR).",
      );
      process.exit(2);
    }
    const startDirFr = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDirFr = findGitRoot(startDirFr) ?? startDirFr;
    try {
      const {
        runFactoryReleasePrepare,
        defaultFactoryReleasePrepareDeps,
        FACTORY_RELEASE_PREPARE_HELP,
      } = await import("./factory-release-prepare.ts");
      if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(FACTORY_RELEASE_PREPARE_HELP);
        process.exit(0);
      }
      if (!path.isAbsolute(requestPath)) {
        console.error(
          "pipeline factory-release prepare: --request must be an absolute path " +
            `(got ${JSON.stringify(requestPath)})`,
        );
        process.exit(2);
      }
      const outcome = await runFactoryReleasePrepare(
        {
          requestPath,
          repoDir: repoDirFr,
          json: true,
          baseBranch: opts.base,
        },
        defaultFactoryReleasePrepareDeps({
          log: (msg) => console.error(msg),
        }),
      );
      console.log(JSON.stringify(outcome.result, null, 2));
      if (outcome.exitCode !== 0) {
        reportMechanicalFault(undefined, {
          operation: "factory_release_prepare",
          form_id: "factory-release.prepare",
          message: `factory-release prepare exit ${outcome.exitCode}`,
          fault: "mechanical",
        });
        process.exitCode = outcome.exitCode;
      }
    } catch (err) {
      const message = (err as Error).message;
      reportMechanicalFault(undefined, {
        operation: "factory_release_prepare",
        form_id: "factory-release.prepare",
        message,
        fault: "mechanical",
      });
      console.error(`pipeline factory-release prepare: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  // `pipeline factory-gate --for <version> [--from-run <id>] [--observations <file>]
  // [--scenario …] [--json] [--no-close-pack]` (#723/#754/#757).
  // Scores a durable loop (or refuses without --from-run) and writes FRG evidence.
  // Never merges or tags. After a release-eligible pass, closes synthetic pack
  // PRs/issues without merge unless --no-close-pack.
  if (numArg === "factory-gate") {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    const versionArg = opts.for ?? (cmd.args[1] as string | undefined);
    if (!versionArg) {
      console.error(
        "pipeline factory-gate: --for <X.Y.Z> is required.\n" +
          "  Usage: pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> \\\n" +
          "           [--observations <file>] [--scenario id=status:detail] [--json] [--no-close-pack]\n" +
          "  See docs/factory-reliability-gate-runbook.md",
      );
      process.exit(2);
    }
    const {
      runFactoryGate,
      parseFrgObservationsJson,
      parseFrgScenarioCliToken,
    } = await import("./factory-reliability-gate.ts");
    const { defaultLoopStoreDeps, readLedger, readContract } = await import("./loop/store.ts");
    const {
      getIssueStateAndLabels,
      listOpenPrsForIssue,
      closePr,
      closeIssue,
    } = await import("./gh.ts");
    try {
      const storeDeps = defaultLoopStoreDeps();
      // Always inject ledger/contract loaders so scoring reuses the durable loop
      // store (no second ledger). Operator starts the pack with `pipeline loop`
      // (shipped runtime), then scores with --from-run.
      // Lazy cfg: only resolveConfig (gh) when post-pass close actually runs.
      let packCfg: PipelineConfig | null = null;
      const getPackCfg = (): PipelineConfig => {
        if (!packCfg) {
          packCfg = resolveConfig({
            repoPath: opts.repoPath ?? repoDir,
            baseBranch: opts.base,
            profile: opts.profile,
          });
        }
        return packCfg;
      };
      // Commander `--no-close-pack` sets closePack=false (same as --no-edit → edit).
      const noClosePack = opts.closePack === false;

      // Observation file + optional --scenario tokens (#757).
      let scenarioOverrides: import("./factory-reliability-gate.ts").FrgScenarioOverride[] = [];
      let compositionOverrides:
        | import("./factory-reliability-gate.ts").FrgCompositionOverride[]
        | undefined;
      let falseHumanAuthorityCount: number | undefined;
      let recoveryAggregates:
        | import("./factory-reliability-gate.ts").FrgRecoveryAggregates
        | undefined;
      let packProvenance:
        | import("./frg-pack-observations.ts").FrgPackProvenance
        | undefined;
      if (opts.observations) {
        const obsPath = path.resolve(repoDir, opts.observations as string);
        const text = await fsPromises.readFile(obsPath, "utf8");
        const obs = parseFrgObservationsJson(text);
        scenarioOverrides = [...(obs.scenarios ?? [])];
        compositionOverrides = obs.composition;
        falseHumanAuthorityCount = obs.false_human_authority_count;
        recoveryAggregates = obs.recovery_aggregates;
        packProvenance = obs.pack_provenance;
      }
      const scenarioTokens: string[] = Array.isArray(opts.scenario)
        ? (opts.scenario as string[])
        : opts.scenario
          ? [String(opts.scenario)]
          : [];
      for (const token of scenarioTokens) {
        const parsed = parseFrgScenarioCliToken(token);
        scenarioOverrides = [
          ...scenarioOverrides.filter((s) => s.id !== parsed.id),
          parsed,
        ];
      }

      const result = await runFactoryGate({
        version: versionArg,
        repoDir,
        fromRun: opts.fromRun,
        label: opts.label,
        milestone: opts.milestone,
        json: !!opts.json,
        noClosePack,
        scenarioOverrides: scenarioOverrides.length > 0 ? scenarioOverrides : undefined,
        compositionOverrides,
        falseHumanAuthorityCount,
        recoveryAggregates,
        packProvenance,
        usedObservationsFile: Boolean(opts.observations),
        packCloseDeps: noClosePack
          ? undefined
          : {
              getIssueStateAndLabels: async (issueNumber) =>
                getIssueStateAndLabels(getPackCfg(), issueNumber),
              // All open associated PRs — not getPrForIssue singleton (#754 review-2).
              findOpenPrsForIssue: async (issueNumber) =>
                listOpenPrsForIssue(getPackCfg(), issueNumber),
              closePr: async (prNumber, comment) =>
                closePr(getPackCfg(), prNumber, comment),
              closeIssue: async (issueNumber, comment) =>
                closeIssue(getPackCfg(), issueNumber, comment),
            },
        loadLedger: async (runId) => readLedger(storeDeps, runId),
        loadContract: async (runId) => {
          try {
            return await readContract(storeDeps, runId);
          } catch {
            return null;
          }
        },
      });
      // #762: factory-gate always soaks the candidate track. Opt-in pin promote
      // only after a release-eligible pass; never merges or tags.
      if (result.exitCode === 0 && opts.promotePinOnPass && result.evidence?.pass) {
        const { promoteProductionPin } = await import("./production-engine-pin.ts");
        const promote = await promoteProductionPin({
          repoDir,
          version: versionArg,
          gitSha: opts.gitSha ?? null,
        });
        if (promote.ok) {
          console.log(
            `[pipeline factory-gate] promoted production pin to ${promote.pin.version} ` +
              `(frg_run_id=${promote.pin.frg_run_id}). Reinstall: ${promote.reinstall_hint}`,
          );
        } else {
          console.error(
            `[pipeline factory-gate] --promote-pin-on-pass refused: ${promote.message}`,
          );
          process.exitCode = 1;
        }
      }
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    } catch (err) {
      console.error(`pipeline factory-gate: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // `pipeline engine-promote --for X.Y.Z` — Phase 4 self-host pin + install.
  if (numArg === "engine-promote") {
    const version = opts.for ? String(opts.for).trim() : "";
    if (!version) {
      console.error(
        "pipeline engine-promote: --for <X.Y.Z> is required.\n" +
          "  Usage: pipeline engine-promote --for <X.Y.Z> [--host all|codex|claude|grok|opencode|omp] [--dry-run] [--json] [--skip-install] [--skip-frg]\n" +
          "  Verifies the GitHub Release, promotes a production-quality pin from a real FRG pass\n" +
          "  (frg_run_id + frg_evidence_path; refuses no-frg-*), installs the exact tag\n" +
          "  to all configured hosts by default (override with --host), and verifies installed version.\n" +
          "  --skip-frg writes a marked non-production-quality pin only. Rolls the pin back if\n" +
          "  install/verify fails after promote. Never merges PRs or creates tags.",
      );
      process.exit(2);
    }
    const startDirEp = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDirEp = findGitRoot(startDirEp);
    if (!repoDirEp) {
      console.error(
        `pipeline engine-promote: no git repo at ${startDirEp}. Run from a checkout or pass --repo-path.`,
      );
      process.exit(2);
    }
    try {
      const {
        runEnginePromote,
        realEnginePromoteDeps,
        DEFAULT_ENGINE_PROMOTE_HOST,
      } = await import("./stages/engine-promote.ts");
      const hostRaw = opts.host ? String(opts.host).trim() : DEFAULT_ENGINE_PROMOTE_HOST;
      const allowedHosts = new Set(["codex", "claude", "grok", "opencode", "omp", "all"]);
      if (!allowedHosts.has(hostRaw)) {
        console.error(`pipeline engine-promote: invalid --host ${hostRaw}`);
        process.exit(2);
      }
      const result = await runEnginePromote(
        {
          version,
          repoDir: repoDirEp,
          host: hostRaw as "codex" | "claude" | "grok" | "opencode" | "omp" | "all",
          dryRun: !!opts.dryRun,
          skipInstall: !!opts.skipInstall,
          allowWithoutFrg: !!opts.skipFrg,
          gitSha: opts.gitSha ?? null,
          pinPath: process.env.AGENT_PIPELINE_PRODUCTION_PIN ?? null,
        },
        realEnginePromoteDeps(repoDirEp),
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `[engine-promote] version=${result.version} tag=${result.tag} ` +
            `release_ok=${result.release_verified} pin_promoted=${result.pin_promoted} ` +
            `install_ran=${result.install_ran} verified=${result.verified}` +
            (result.rolled_back ? " rolled_back=true" : "") +
            (result.error ? ` error=${result.error}` : ""),
        );
        for (const s of result.steps) console.log(`  - ${s}`);
        if (result.reinstall_hint) console.log(`  reinstall: ${result.reinstall_hint}`);
      }
      if (result.error && !opts.dryRun) {
        reportMechanicalFault(undefined, {
          operation: "engine_promote",
          form_id: "engine-promote",
          message: result.error,
          fault: "mechanical",
        });
        process.exitCode = 1;
      } else if (result.error) {
        process.exitCode = 1;
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!opts.dryRun) {
        reportMechanicalFault(undefined, {
          operation: "engine_promote",
          form_id: "engine-promote",
          message,
          fault: "mechanical",
        });
      }
      console.error(`pipeline engine-promote: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  // `pipeline factory-pin show|init|promote|rollback` (#762).
  // Manages the production engine pin on factory pin authority only.
  // Never merges or tags. Never writes a product-local pin by cwd accident.
  if (numArg === "factory-pin") {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const invocationRepoDir = findGitRoot(startDir) ?? startDir;
    const verb = (cmd.args[1] as string | undefined)?.trim() ?? "show";
    const {
      resolveProductionPin,
      formatProductionPinSummary,
      promoteProductionPin,
      initProductionPin,
      rollbackProductionPin,
      resolveFactoryPinAuthority,
      resolveFactoryControlRoot,
      PRODUCTION_ENGINE_PIN_REL,
    } = await import("./production-engine-pin.ts");
    try {
      // Self-dogfood is checkout-role (live REPO_DIR / FACTORY_CONTROL), not
      // package.json GitHub owner/name. A developer clone of this repo must
      // not gain pin-write authority from repository identity (#1237).
      // Pass the control *root* so a managed worktree of REPO_DIR writes
      // $REPO_DIR/.agent-pipeline/production-engine-pin.json, not the worktree.
      const factoryControlRoot = resolveFactoryControlRoot({
        repoDir: invocationRepoDir,
      });
      const authority = resolveFactoryPinAuthority({
        invocationRepoDir,
        targetIsFactoryControl: factoryControlRoot !== null,
        factoryControlDir: factoryControlRoot,
      });
      if (!authority.ok) {
        console.error(
          `pipeline factory-pin: ${authority.message}\n  → ${authority.remediation}`,
        );
        process.exit(1);
      }
      const repoDir = authority.repoDir;
      const pinPathOverride = authority.pinPathOverride;

      if (verb === "show") {
        const load = await resolveProductionPin({
          repoDir,
          overridePath: pinPathOverride,
          readTextFile: async (p) => {
            try {
              return await fsPromises.readFile(p, "utf8");
            } catch {
              return null;
            }
          },
        });
        if (opts.json) {
          console.log(JSON.stringify(load, null, 2));
        } else if (load.kind === "ok") {
          console.log(`Production engine pin (${load.path}):`);
          console.log(`  ${formatProductionPinSummary(load.pin)}`);
          console.log(
            `  Reinstall: npx -y github:accidental-hedge-fund/agent-pipeline#${load.pin.tag} install`,
          );
        } else {
          console.error(
            `pipeline factory-pin show: pin ${load.kind} at ${load.path}` +
              ("detail" in load ? `: ${load.detail}` : "") +
              `\n  Init: pipeline factory-pin init --from-frg <X.Y.Z>`,
          );
          process.exitCode = 1;
        }
        return;
      }
      if (verb === "promote") {
        const version = opts.for;
        if (!version) {
          console.error(
            "pipeline factory-pin promote: --for <X.Y.Z> is required.\n" +
              "  Usage: pipeline factory-pin promote --for <X.Y.Z> [--git-sha <sha>]\n" +
              "  Requires FRG pass:true with a real run_id (not no-frg-*) and writes frg_evidence_path.\n" +
              "  There is no --skip-frg on this command. Never merges or tags.",
          );
          process.exit(2);
        }
        const result = await promoteProductionPin({
          repoDir,
          version,
          gitSha: opts.gitSha ?? null,
          overridePath: pinPathOverride,
        });
        if (!result.ok) {
          console.error(`pipeline factory-pin promote: ${result.message}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, pin: result.pin, path: result.path, reinstall_hint: result.reinstall_hint }, null, 2));
        } else {
          console.log(`Promoted production pin to ${result.pin.version} (${result.path})`);
          console.log(`  frg_run_id=${result.pin.frg_run_id}`);
          console.log(`  Reinstall: ${result.reinstall_hint}`);
          console.log(`  Verify: pipeline doctor  (install:engine-track)`);
        }
        return;
      }
      if (verb === "init") {
        const version = opts.fromFrg ?? opts.for;
        if (!version) {
          console.error(
            "pipeline factory-pin init: --from-frg <X.Y.Z> is required (same FRG pass gate as promote).\n" +
              "  Usage: pipeline factory-pin init --from-frg <X.Y.Z> [--force] [--git-sha <sha>]",
          );
          process.exit(2);
        }
        const result = await initProductionPin({
          repoDir,
          version,
          force: !!opts.force,
          gitSha: opts.gitSha ?? null,
          overridePath: pinPathOverride,
        });
        if (!result.ok) {
          console.error(`pipeline factory-pin init: ${result.message}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, pin: result.pin, path: result.path, reinstall_hint: result.reinstall_hint }, null, 2));
        } else {
          console.log(`Initialized production pin at ${result.path} → ${result.pin.version}`);
          console.log(`  Writes ${PRODUCTION_ENGINE_PIN_REL} (commit for multi-host).`);
          console.log(`  Reinstall: ${result.reinstall_hint}`);
        }
        return;
      }
      if (verb === "rollback") {
        const result = await rollbackProductionPin({
          repoDir,
          toVersion: opts.to ?? null,
          overridePath: pinPathOverride,
          automatic: false,
        });
        if (!result.ok) {
          console.error(`pipeline factory-pin rollback: ${result.message}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, pin: result.pin, path: result.path, reinstall_hint: result.reinstall_hint }, null, 2));
        } else {
          console.log(`Rolled back production pin to ${result.pin.version} (${result.path})`);
          console.log(`  Reinstall: ${result.reinstall_hint}`);
          console.log(`  Verify: pipeline doctor  (install:engine-track)`);
        }
        return;
      }
      console.error(
        `pipeline factory-pin: unknown verb "${verb}". Use show | init | promote | rollback.`,
      );
      process.exit(2);
    } catch (err) {
      console.error(`pipeline factory-pin: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early outcomes dispatch (#576) — host-local store only; no GitHub mutations.
  if (numArg === "outcomes") {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      const { OUTCOMES_HELP } = await import("./outcomes/cli.ts");
      process.stdout.write(OUTCOMES_HELP);
      process.exit(0);
    }
    const verb = cmd.args[1] as string | undefined;
    if (verb !== "ingest" && verb !== "list") {
      console.error(
        'pipeline outcomes: expected subcommand "ingest" or "list".\n' +
          "  Usage: pipeline outcomes ingest [--adapter github] [--fixture <path>] [--dry-run] [--json]\n" +
          "         pipeline outcomes list [--days <n>] [--retention-days <n>] [--json]\n" +
          "  Host-local store under .agent-pipeline/outcomes/; free text redacted; R2D ≠ production delivery.",
      );
      process.exit(2);
    }
    const startDirOut = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDirOut = findGitRoot(startDirOut) ?? startDirOut;
    try {
      const { runOutcomesCli, realOutcomesCliDeps } = await import("./outcomes/cli.ts");
      await runOutcomesCli(
        {
          repoDir: repoDirOut,
          verb,
          adapter: opts.adapter,
          json: !!opts.json,
          dryRun: !!opts.dryRun,
          days: opts.days,
          retentionDays: opts.retentionDays,
          fixturePath: opts.fixture,
        },
        realOutcomesCliDeps(),
      );
    } catch (err) {
      console.error(`pipeline outcomes: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early lineage dispatch (#599) — host-local graph store only; no GitHub mutations.
  if (numArg === "lineage") {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      const { LINEAGE_HELP } = await import("./lineage/cli.ts");
      process.stdout.write(LINEAGE_HELP);
      process.exit(0);
    }
    const verb = cmd.args[1] as string | undefined;
    if (verb !== "export" && verb !== "impact" && verb !== "propose" && verb !== "ingest") {
      console.error(
        'pipeline lineage: expected subcommand "export", "impact", "propose", or "ingest".\n' +
          "  Usage: pipeline lineage export  [--json] [--retention-days <n>]\n" +
          "         pipeline lineage impact  [--json] --node-id <id>\n" +
          "         pipeline lineage propose [--json] [--evidence-node-id <id>]\n" +
          "         pipeline lineage ingest  [--fixture <path>] [--dry-run] [--json]\n" +
          "  Host-local store under .agent-pipeline/lineage/; free text redacted; no silent upstream mutation.",
      );
      process.exit(2);
    }
    const startDirLin = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDirLin = findGitRoot(startDirLin) ?? startDirLin;
    try {
      const { runLineageCli, realLineageCliDeps } = await import("./lineage/cli.ts");
      await runLineageCli(
        {
          repoDir: repoDirLin,
          verb,
          json: !!opts.json,
          dryRun: !!opts.dryRun,
          retentionDays: opts.retentionDays,
          fixturePath: opts.fixture,
          runId: opts.runId,
          nodeId: opts.nodeId,
          newRevision: opts.newRevision,
          newHash: opts.newHash,
          evidenceNodeId: opts.evidenceNodeId,
          includeRecords: !!opts.includeRecords,
        },
        realLineageCliDeps(),
      );
    } catch (err) {
      console.error(`pipeline lineage: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early liveness dispatch (#1332) — discover/claim/reattach only; no recovery or merge.
  if (numArg === "liveness") {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      const { LIVENESS_HELP } = await import("./liveness-cli.ts");
      process.stdout.write(LIVENESS_HELP + "\n");
      process.exit(0);
    }
    const verb = cmd.args[1] as string | undefined;
    if (verb !== "status" && verb !== "restore") {
      console.error(
        'pipeline liveness: expected subcommand "status" or "restore".\n' +
          "  Usage: pipeline liveness status [--json]\n" +
          "         pipeline liveness restore [--json] [--run-id <id>]\n" +
          "  Discover, claim, and reattach only. Does not classify faults, choose recipes, or merge.",
      );
      process.exit(2);
    }
    try {
      const { runLivenessCli, productionProviderDeps } = await import("./liveness-cli.ts");
      const out = await runLivenessCli(
        { verb, json: !!opts.json, runId: opts.runId },
        { provider: productionProviderDeps() },
      );
      process.stdout.write(out.text + (out.text.endsWith("\n") ? "" : "\n"));
    } catch (err) {
      console.error(`pipeline liveness: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early scoreboard dispatch — no issue number, no config resolution, no GitHub calls.
  // It reads only existing run artifacts under .agent-pipeline/runs.
  if (numArg === "scoreboard") {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    const { runScoreboard, realScoreboardDeps } = await import("./scoreboard.ts");
    try {
      await runScoreboard(
        {
          repoDir,
          since: opts.since,
          until: opts.until,
          days: opts.days,
          json: !!opts.json,
          estimateCost: opts.estimateCost,
          bucket: opts.bucket,
          by: opts.by,
          correctionsBy: opts.correctionsBy,
          html: opts.html,
        },
        realScoreboardDeps(),
      );
    } catch (err) {
      console.error(`pipeline scoreboard: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // `pipeline evals plan|run|grade|report` — experiment harness dispatch (#432,
  // #433). Never resolves gh auth and mutatesGitHub is false in the registry:
  // evaluation mode performs no production GitHub writes by construction
  // (evals/gh-eval-surface.ts). grade/report never gate a PR or participate in
  // the state machine — they only read/write files under the experiment dir.
  if (numArg === "evals") {
    const evalsSub = cmd.args[1];
    const pathArg = cmd.args[2];
    if (evalsSub !== "plan" && evalsSub !== "run" && evalsSub !== "grade" && evalsSub !== "report" && evalsSub !== "harvest") {
      console.error(
        'pipeline evals: expected a subcommand — "plan", "run", "grade", "report", or "harvest".\n' +
          "  Usage: pipeline evals <plan|run> <manifest.json> [--trajectory-max-events <n>] [--trajectory-max-bytes <n>]\n" +
          "         pipeline evals grade <experiment-dir> [--judge] [--trajectory-max-events <n>] [--trajectory-max-bytes <n>]\n" +
          "         pipeline evals report <experiment-dir> --baseline <treatment_id> [--link-artifacts]\n" +
          "         pipeline evals harvest <harvest-request.json> [--out <path>] [--apply] [--plan-only]",
      );
      process.exit(2);
    }
    if (!pathArg) {
      const argName = evalsSub === "grade" || evalsSub === "report" ? "<experiment-dir>" : evalsSub === "harvest" ? "<harvest-request.json>" : "<manifest.json>";
      console.error(`pipeline evals ${evalsSub}: a ${argName} argument is required.`);
      process.exit(2);
    }
    let evalsCfg: import("./types.ts").PipelineConfig;
    try {
      evalsCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline evals: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    const fixturesDir = path.resolve(evalsCfg.repo_dir, opts.fixtures ?? "core/evals/fixtures");

    // `pipeline evals harvest` (#535): draft-only by default — never queues,
    // advances, overrides, merges, or deploys, and makes no GitHub call of
    // any kind (harvest.ts imports no gh.ts function). A repository write
    // requires the explicit --apply flag shared with roadmap/sweep/improve.
    if (evalsSub === "harvest") {
      try {
        const requestPath = path.resolve(evalsCfg.repo_dir, pathArg);
        const request = JSON.parse(readFileSync(requestPath, "utf8"));
        const { renderDraft, promoteDraft } = await import("./evals/harvest.ts");
        const draft = renderDraft(request);
        const draftJson = `${JSON.stringify({ fixture: draft.raw, ability: draft.ability, surface: draft.surface }, null, 2)}\n`;
        const outResolution = resolveHarvestOutPath(evalsCfg.repo_dir, opts.out, !!opts.apply);
        if (!outResolution.ok) {
          console.error(`pipeline evals harvest: ${outResolution.error}`);
          process.exit(2);
        }
        if (outResolution.path) {
          writeFileSync(outResolution.path, draftJson);
        } else {
          console.log(draftJson);
        }
        if (opts.apply) {
          const fixturesDirResolution = resolveHarvestFixturesDir(evalsCfg.repo_dir, fixturesDir);
          if (!fixturesDirResolution.ok) {
            console.error(`pipeline evals harvest: ${fixturesDirResolution.error}`);
            process.exit(2);
          }
          const result = await promoteDraft(draft, fixturesDir, { apply: true, planOnly: !!opts.planOnly });
          console.log(`pipeline evals harvest: promoted fixture "${draft.fixture.fixture_id}" to ${result.fixturePath}`);
          if (result.plan) {
            console.log(`pipeline evals harvest: plan-only proof expanded ${result.plan.cells.length} cell(s) — no live model call, no production GitHub write`);
          }
        } else {
          console.log(`pipeline evals harvest: draft-only (pass --apply to promote fixture "${draft.fixture.fixture_id}" into ${fixturesDir})`);
        }
      } catch (err) {
        console.error(`pipeline evals harvest: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    const trajectoryCeilings =
      opts.trajectoryMaxEvents !== undefined || opts.trajectoryMaxBytes !== undefined
        ? {
            maxEvents: opts.trajectoryMaxEvents ?? 200,
            maxBytes: opts.trajectoryMaxBytes ?? 200_000,
          }
        : undefined;

    try {
      if (evalsSub === "plan" || evalsSub === "run") {
        const manifestPath = path.resolve(evalsCfg.repo_dir, pathArg);
        const { planExperiment, runExperiment } = await import("./evals/run.ts");
        if (evalsSub === "plan") {
          const { manifest, plan } = await planExperiment(evalsCfg, manifestPath, fixturesDir);
          console.log(`pipeline evals plan: ${plan.cells.length} cell(s) for experiment "${manifest.experiment_id}"`);
        } else {
          const { manifest, executed } = await runExperiment(evalsCfg, manifestPath, fixturesDir, { trajectoryCeilings });
          console.log(`pipeline evals run: executed ${executed.length} cell(s) for experiment "${manifest.experiment_id}"`);
        }
        return;
      }

      const experimentPath = path.resolve(evalsCfg.repo_dir, pathArg);
      const outputDir = path.dirname(experimentPath);
      const experimentId = path.basename(experimentPath);
      const { loadFixturesFromDir } = await import("./evals/run.ts");
      const fixtures = loadFixturesFromDir(fixturesDir);

      if (evalsSub === "grade") {
        const { gradeExperiment } = await import("./evals/grading/grade.ts");
        const { grades, skipped } = await gradeExperiment(evalsCfg, outputDir, experimentId, fixtures, { verifierCeilings: trajectoryCeilings });
        console.log(`pipeline evals grade: wrote ${grades.length} grade(s) for experiment "${experimentId}" (${skipped.length} cell(s) skipped)`);
        if (opts.judge) {
          console.warn(
            "pipeline evals grade --judge: no judge harness is configured yet — judging requires a caller-supplied invokeJudge (see grading/judge.ts); skipping.",
          );
        }
      } else {
        if (!opts.baseline) {
          console.error("pipeline evals report: --baseline <treatment_id> is required.");
          process.exit(2);
        }
        const { reportExperiment } = await import("./evals/reporting/report.ts");
        const summary = await reportExperiment(outputDir, experimentId, fixtures, {
          baselineTreatmentId: opts.baseline,
          linkArtifacts: !!opts.linkArtifacts,
        });
        console.log(`pipeline evals report: wrote summary.json for experiment "${experimentId}" (${summary.treatments.length} treatment(s), baseline "${opts.baseline}")`);
      }
    } catch (err) {
      console.error(`pipeline evals ${evalsSub}: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early queue dispatch — batch factory operation mode (#305). No issue number;
  // derives repo/config from local git state. Runs pipeline for a set of eligible
  // issues within explicit budget, concurrency, and failure-rate limits.
  if (numArg === "queue") {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    let queueCfg: import("./types.ts").PipelineConfig;
    try {
      queueCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline queue: config error: ${(err as Error).message}`);
      process.exit(2);
    }
    const { runQueue, realQueueDeps, validateQueueOpts } = await import("./stages/queue.ts");
    // Precedence: CLI flag > config value > built-in default.
    const queueConfig = queueCfg.queue ?? {};
    const maxIssues: number = opts.maxIssues ?? queueConfig.max_issues ?? 10;
    const budgetDollars: number | null =
      opts.budgetDollars !== undefined ? opts.budgetDollars :
      queueConfig.budget_dollars !== undefined ? queueConfig.budget_dollars :
      null;
    const concurrency: number = opts.concurrency ?? queueConfig.concurrency ?? 1;
    const maxFailureRate: number = opts.maxFailureRate ?? queueConfig.max_failure_rate ?? 1.0;
    const validationError = validateQueueOpts(maxIssues, budgetDollars, concurrency, maxFailureRate, opts.risk);
    if (validationError) {
      console.error(`pipeline queue: ${validationError}`);
      process.exit(2);
    }
    const batchId = new Date().toISOString().replace(/[:.]/g, "-");
    const queueObservations: import("./operation-observation.ts").OperationObservation[] = [];
    try {
      await runQueue(
        {
          maxIssues,
          budgetDollars,
          concurrency,
          maxFailureRate,
          filters: {
            labels: opts.label && opts.label.length > 0 ? opts.label : undefined,
            milestone: opts.milestone,
            risk: opts.risk as "low" | "medium" | "high" | undefined,
          },
          repoDir: queueCfg.repo_dir,
          profile: opts.profile,
          batchId,
          base: opts.base,
          domain: queueCfg.domain,
          papercuts: queueCfg.papercuts,
          corrections: queueCfg.corrections,
        },
        {
          ...realQueueDeps(queueCfg.repo_dir, opts.profile),
          reportObservation: (obs) => queueObservations.push(obs),
        },
      );
    } catch (err) {
      const message = (err as Error).message;
      reportMechanicalFault((obs) => queueObservations.push(obs), {
        operation: "queue_batch",
        form_id: "queue",
        message,
        fault: "mechanical",
      });
      console.error(`pipeline queue: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Early roadmap dispatch — no issue number, derives repo/config from local git state.
  if (numArg === "roadmap") {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir);
    if (!repoDir) {
      console.error(
        `pipeline: no git repo found at or above ${startDir}. Run from inside a checkout, or pass --repo-path.`,
      );
      process.exit(2);
    }
    let roadmapCfg: import("./types.ts").PipelineConfig;
    try {
      roadmapCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline roadmap: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    const { runRoadmap } = await import("./roadmap/index.ts");
    const { realRoadmapDeps } = await import("./stages/roadmap-deps.ts");
    try {
      await runRoadmap(
        roadmapCfg.repo,
        roadmapCfg.repo_dir,
        roadmapCfg.base_branch,
        roadmapCfg.roadmap ?? {},
        { apply: !!opts.apply, next: opts.next, dryRun: opts.dryRun, repoMap: roadmapCfg.repo_map },
        realRoadmapDeps(roadmapCfg),
      );
    } catch (err) {
      console.error(`pipeline roadmap: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early sweep dispatch — no issue number, uses resolveConfig for repo discovery.
  if (isSweepCommand) {
    // Finding 1: --dry-run and --apply are mutually exclusive for sweep.
    if (opts.dryRun && opts.apply) {
      console.error("pipeline sweep: --dry-run and --apply are mutually exclusive — omit one.");
      process.exit(2);
    }
    let sweepCfg: import("./types.ts").PipelineConfig;
    try {
      sweepCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline sweep: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    const sweepConfig = sweepCfg.sweep ?? {};
    try {
      await runSweep(
        { apply: !!opts.apply, repo: opts.repo },
        { repo_dir: sweepCfg.repo_dir, repo: sweepCfg.repo, base_branch: sweepCfg.base_branch, sweep_timeout: sweepCfg.sweep_timeout },
        sweepConfig,
        realSweepDeps(sweepCfg.repo_dir, sweepCfg.models.sweep, sweepCfg.effort.sweep, sweepCfg.harnesses.implementer),
      );
    } catch (err) {
      console.error(`pipeline sweep: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early backfill dispatch — no issue number; derives repo/config from local git state.
  // Preview by default (non-mutating); --apply opens a spec-only PR.
  if (isBackfillCommand) {
    let backfillCfg: import("./types.ts").PipelineConfig;
    try {
      backfillCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline backfill: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    const { runBackfill, realBackfillDeps } = await import("./stages/backfill.ts");
    try {
      await runBackfill(
        { apply: !!opts.apply, capability: opts.capability },
        { repo_dir: backfillCfg.repo_dir, repo: backfillCfg.repo, base_branch: backfillCfg.base_branch },
        realBackfillDeps(backfillCfg.repo_dir, undefined, backfillCfg.harnesses.implementer),
      );
    } catch (err) {
      console.error(`pipeline backfill: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // `pipeline:loop` (#451) — deterministic preflight + delegation to goal-loop.
  // Deliberately calls resolveConfig for NOTHING: it needs no PipelineConfig and
  // makes no gh call on any path (see command-registry.ts's loop entry), so it
  // is dispatched before the resolveConfig() block below, unlike every command
  // that needs cfg.repo.
  if (isLoopCommand) {
    await runLoopCommand(opts, cmd.args.slice(1));
    return;
  }

  if (isSingleCommand) {
    await runSingleIssueCommand(cmd.args[1], opts);
    return;
  }

  // Early triage dispatch — resolves config for cfg.repo so gh wrappers target the
  // configured repository. The handler validates issue number and stage, then makes
  // the gh calls to read/add/remove labels.
  if (isTriageCommand) {
    // Validate inputs before resolveConfig() so invalid commands never trigger
    // a GitHub API call (resolveConfig calls gh repo view internally).
    const inputError = validateTriageInput(cmd.args[1], opts.stage);
    if (inputError) {
      console.error(`pipeline triage: ${inputError}`);
      process.exit(2);
    }
    let triageCfg: PipelineConfig;
    try {
      triageCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline triage: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    try {
      await runTriage(
        { issueArg: cmd.args[1], stage: opts.stage },
        {
          ...realTriageDeps(triageCfg),
          getReadySnapshot: (n) => realGrillReadySnapshot(triageCfg, n),
        },
      );
    } catch (err) {
      console.error(`pipeline triage: ${(err as Error).message}`);
      if (err instanceof TriageReadyError) process.exit(err.exitCode);
      process.exit(1);
    }
    return;
  }

  // Early merge dispatch — human-invoked squash merge of a ready-to-deploy PR (#217).
  // This is the ONLY path that calls mergePr; the autonomous advance loop never reaches here.
  if (isMergeCommand) {
    const prArgStr = cmd.args[1];
    if (!prArgStr || !/^\d+$/.test(prArgStr)) {
      if (!prArgStr) {
        console.error(
          "pipeline merge: a PR number is required.\n" +
            "  Usage: pipeline merge <pr-number>\n" +
            "  Example: pipeline merge 42",
        );
      } else {
        console.error(
          `pipeline merge: "${prArgStr}" is not a valid PR number.\n` +
            `  A positive integer is required.\n` +
            `  Example: pipeline merge 42`,
        );
      }
      process.exit(2);
    }
    const prNumber = Number.parseInt(prArgStr, 10);
    if (prNumber <= 0) {
      console.error(
        `pipeline merge: PR number must be a positive integer (got ${prNumber}).`,
      );
      process.exit(2);
    }
    let mergeCfg: import("./types.ts").PipelineConfig;
    try {
      mergeCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline merge: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    try {
      const mergeDeps = realMergeDeps(mergeCfg.repo);
      await mergePr(prNumber, {
        ...mergeDeps,
        supervision: realMergeSupervision({
          repo: mergeCfg.repo,
          base: mergeCfg.base_branch,
          repoDir: mergeCfg.repo_dir,
          envelope: "pipeline merge",
          actionIdentity: `pipeline merge ${prNumber}`,
          mergeDeps,
        }),
      });
    } catch (err) {
      console.error(`pipeline merge: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early merge-queue dispatch — operator-authorized sequential R2D merges + optional
  // release-when-complete prepare (#676). Never tags/publishes/merges a release.
  if (isMergeQueueCommand) {
    if (!opts.milestone || String(opts.milestone).trim() === "") {
      console.error(
        "pipeline merge-queue: --milestone <title> is required.\n" +
          "  Usage: pipeline merge-queue --milestone <title> [--apply] [--dry-run] [--repair]\n" +
          "         [--release-when-complete --release-version <major|minor|patch|X.Y.Z>]\n" +
          "  Default is dry-run (no merges). --apply performs sequential merges via the\n" +
          "  existing merge surface. --repair (opt-in) may surgically remediate conflict/CI\n" +
          "  holds then re-gate before merge; dry-run never repairs. --release-when-complete\n" +
          "  is opt-in prepare-only: never tags, publishes to npm, or merges the release PR.",
      );
      process.exit(2);
    }
    let mqCfg: import("./types.ts").PipelineConfig;
    try {
      mqCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline merge-queue: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    try {
      const result = await runMergeQueue(
        {
          milestone: String(opts.milestone).trim(),
          apply: !!opts.apply,
          // Explicit --dry-run forces plan-only even when combined with --apply.
          dryRun: !!opts.dryRun,
          repair: !!opts.repair,
          repairConfig: mqCfg.merge_queue?.repair ?? false,
          repairMaxAttempts: mqCfg.merge_queue?.repair_max_attempts,
          releaseWhenComplete: !!opts.releaseWhenComplete,
          releaseVersion: opts.releaseVersion,
          releaseWhenCompleteConfig: mqCfg.merge_queue?.release_when_complete ?? false,
          repoDir: mqCfg.repo_dir,
          repo: mqCfg.repo,
          baseBranch: mqCfg.base_branch,
          releaseModel: mqCfg.roadmap?.release_model,
        },
        realMergeQueueDeps(mqCfg.repo_dir, mqCfg.repo, undefined, mqCfg),
      );
      if (result.exitCode !== 0) process.exit(result.exitCode);
    } catch (err) {
      console.error(`pipeline merge-queue: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early train dispatch — ordered advance + optional integrate merges (factory Phase 1).
  if (isTrainCommand) {
    let trainCfg: import("./types.ts").PipelineConfig;
    try {
      trainCfg = resolveConfig({ repoPath: opts.repoPath, baseBranch: opts.base, profile: opts.profile });
    } catch (err) {
      console.error(`pipeline train: config error: ${(err as Error).message}`);
      process.exit(1);
    }
    try {
      const exitCode = await runTrainCommand(opts, trainCfg);
      if (exitCode !== 0) process.exit(exitCode);
    } catch (err) {
      console.error(`pipeline train: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Guard: reject unrecognized non-digit positional arguments before resolveConfig()
  // so the user sees a clear usage error rather than a gh auth/repo-discovery failure.
  if (numArg && !/^\d+$/.test(numArg)) {
    const recognized = [
      "init", "doctor", "status", "unblock", "override", "recover-parked", "cleanup",
      "logs", "path", "config", "run", "single", "release", "intake", "decompose", "refine-spec", "grill",
      "roadmap", "sweep", "triage", "merge", "merge-queue", "train", "ship", "summary", "improve", "scoreboard", "outcomes", "lineage", "factory-gate", "factory-release", "factory-pin", "engine-promote", "queue", "backfill", "evals",
      "loop", "controls",
    ];
    if (!recognized.includes(numArg)) {
      console.error(
        `pipeline: unrecognized sub-command "${numArg}".\n` +
          `  Recognized no-issue-number sub-commands: ${recognized.join(", ")}.`,
      );
      process.exit(2);
    }
  }

  let cfg: PipelineConfig;
  try {
    cfg = resolveConfig({
      repoPath: opts.repoPath,
      domainOverride: opts.domain,
      baseBranch: opts.base,
      profile: opts.profile,
      // init must tolerate an invalid existing config: warn + fall back to defaults
      // so label-ensure still runs and the file is preserved rather than blocked.
      tolerateInvalidConfig: isInit,
      // doctor (both standalone and run-start via --doctor) must tolerate a gh failure
      // so it can run its own cli/auth/repo-access checks and print the required
      // per-check summary instead of exiting with code 2 before the doctor checks run.
      tolerateGhFailure: isDoctorCommand || !!opts.doctor,
      // `doctor --is-ok` is a zero-output 0/1 polling gate: suppress non-fatal
      // config-resolution warnings so a valid-but-warning config stays silent (#154).
      quiet: isDoctorCommand && !!opts.isOk,
    });
  } catch (err) {
    const e = err as Error;
    if (isDoctorCommand) {
      // Surface config parse/validation errors as a failing preflight summary (spec: #146)
      // rather than the generic exit-2 path — a broken pipeline.yml is itself a setup
      // defect the doctor command is designed to surface.
      const result: PreflightResult = {
        ok: false,
        checks: [
          {
            id: "config",
            description: "Pipeline config (.github/pipeline.yml) is valid",
            status: "fail",
            detail: `Invalid .github/pipeline.yml: ${e.message}`,
            remediation: `Fix the validation errors in \`.github/pipeline.yml\` and re-run \`pipeline doctor\`.`,
          },
        ],
        ranAt: new Date().toISOString(),
      };
      if (opts.isOk) {
        // --is-ok: zero bytes of output; exit 1 on any failure.
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(formatDoctorJson(result)));
        process.exit(1);
      }
      console.log(formatDoctorSummary(result));
      process.exit(1);
    }
    // JSON status mode must emit a machine-readable error envelope even when config
    // resolution fails (e.g. outside a git checkout, invalid pipeline.yml, gh unreachable).
    // Pipeline Desk polls this path and would fail to parse a prose error on stderr.
    if (opts.status && opts.json) {
      console.log(JSON.stringify({ schema_version: "1", status: "error", error: e.message }));
      process.exit(1);
    }
    console.error(`pipeline: ${e.message}`);
    process.exit(2);
  }

  // #762: CLI --engine-track overrides config for doctor / advance / loop intent.
  if (opts.engineTrack === "pinned" || opts.engineTrack === "candidate") {
    cfg = { ...cfg, engine_track: opts.engineTrack };
  }

  // Legacy `--cleanup` flag form — deprecated; use `pipeline cleanup` instead.
  if (opts.cleanup && isNumericOrAbsent) {
    process.stderr.write(
      "Deprecated: `pipeline --cleanup` is deprecated. Use `pipeline cleanup` instead.\n",
    );
    await runCleanup(cfg);
    return;
  }

  // Positional `pipeline cleanup` keyword dispatch.
  if (numArg === "cleanup") {
    await runCleanup(cfg);
    return;
  }

  if (isInit) {
    // Legacy `--init` flag form — deprecated; use `pipeline init` instead.
    if (opts.init && isNumericOrAbsent) {
      process.stderr.write(
        "Deprecated: `pipeline --init` is deprecated. Use `pipeline init` instead.\n",
      );
    }
    await runInit(cfg);
    return;
  }

  if (isDoctorCommand) {
    await runDoctor(cfg, opts);
    return;
  }

  // Positional `pipeline status <N> [--json]` keyword dispatch.
  // Equivalent to the legacy `pipeline <N> --status [--json]`.
  if (numArg === "status") {
    const statusNumStr = cmd.args[1];
    if (!statusNumStr || !/^\d+$/.test(statusNumStr)) {
      console.error(
        "pipeline status: an issue or PR number is required.\n" +
          "  Usage: pipeline status <N>\n" +
          "  Example: pipeline status 42",
      );
      process.exit(2);
    }
    const statusN = Number.parseInt(statusNumStr, 10);
    let statusIssueNumber: number;
    try {
      statusIssueNumber = await resolveIssueNumber(cfg, statusN, { quiet: !!opts.json });
    } catch (err) {
      const e = err as Error;
      if (opts.json) {
        console.log(JSON.stringify({ schema_version: "1", status: "error", error: e.message }));
        process.exitCode = 1;
      } else {
        console.error(`pipeline: ${e.message}`);
        process.exit(1);
      }
      return;
    }
    await runStatus(cfg, statusIssueNumber, defaultRunStatusDeps, { json: opts.json });
    return;
  }

  // Positional `pipeline unblock <N> "<answer>"` keyword dispatch.
  // Equivalent to the legacy `pipeline <N> --unblock "<answer>"`.
  if (numArg === "unblock") {
    const unblockNumStr = cmd.args[1];
    const unblockAnswer = cmd.args[2];
    if (!unblockNumStr || !/^\d+$/.test(unblockNumStr)) {
      console.error(
        "pipeline unblock: an issue or PR number is required.\n" +
          '  Usage: pipeline unblock <N> "<answer>"\n' +
          '  Example: pipeline unblock 42 "The fix is in branch feat/foo"',
      );
      process.exit(2);
    }
    if (unblockAnswer === undefined) {
      console.error(
        "pipeline unblock: an answer string is required.\n" +
          '  Usage: pipeline unblock <N> "<answer>"\n' +
          '  Example: pipeline unblock 42 "The fix is in branch feat/foo"',
      );
      process.exit(2);
    }
    // Kill-switch check: same gate as the legacy `pipeline N --unblock` form.
    if (isKillSwitchActive(cfg.domain)) {
      console.error(
        `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
      );
      process.exit(0);
    }
    const unblockN = Number.parseInt(unblockNumStr, 10);
    let unblockIssueNumber: number;
    try {
      unblockIssueNumber = await resolveIssueNumber(cfg, unblockN);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runUnblock(cfg, unblockIssueNumber!, unblockAnswer, unblockN);
    return;
  }

  // Positional `pipeline recover-parked <N>` (#1061): one supervisor reflow pass.
  if (numArg === "recover-parked") {
    const rpNumStr = cmd.args[1];
    if (!rpNumStr || !/^\d+$/.test(rpNumStr)) {
      console.error(
        "pipeline recover-parked: an issue or PR number is required.\n" +
          "  Usage: pipeline recover-parked <N> [--json] [--dry-run]\n" +
          "  One supervisor pass per park fingerprint; never auto-overrides HIGH/CRITICAL/security.",
      );
      process.exit(2);
    }
    if (isKillSwitchActive(cfg.domain)) {
      console.error(
        `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
      );
      process.exit(0);
    }
    const rpN = Number.parseInt(rpNumStr, 10);
    let rpIssueNumber: number;
    try {
      rpIssueNumber = await resolveIssueNumber(cfg, rpN);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    const {
      runRecoverParked,
      recoverParkedExitCode,
      reenterAdvanceAfterRecoverParked,
    } = await import("./recover-parked.ts");
    const { runAdvance: runAdvanceForRecover } = await import("./pipeline-run.ts");
    const result = await runRecoverParked(
      cfg,
      rpIssueNumber,
      {
        dryRun: !!opts.dryRun,
      },
      {
        getIssueDetail,
        getPrForIssue,
        getPrDetail,
        postComment,
        clearBlocked,
        getGhActor,
        // Default tryUnlinkEngineScratch = production defaultTryUnlinkEngineScratch.
        reenterAdvance: async (c, issue, reOpts) => {
          // Propagate skipRecoverParked into same-issue advance so a re-park
          // cannot recursively invoke recover-parked on this stack.
          await reenterAdvanceAfterRecoverParked(
            c,
            issue,
            {
              getIssueDetail,
              silentTransition,
              runAdvance: runAdvanceForRecover,
            },
            { ...toAdvanceOpts(opts), skipRecoverParked: reOpts.skipRecoverParked },
          );
        },
        log: (m) => console.log(m),
      },
    );
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(
        `[pipeline] recover-parked #${result.issue}: ${result.status} — ${result.message}`,
      );
    }
    process.exitCode = recoverParkedExitCode(result.status);
    return;
  }

  // Positional `pipeline override <N> "<spec>"` keyword dispatch.
  // Equivalent to the legacy `pipeline <N> --override "<spec>"`.
  if (numArg === "override") {
    const overrideNumStr = cmd.args[1];
    const overrideSpec = cmd.args[2];
    if (!overrideNumStr || !/^\d+$/.test(overrideNumStr)) {
      console.error(
        "pipeline override: an issue or PR number is required.\n" +
          '  Usage: pipeline override <N> "<key|scope>: [<class>:] <reason>"\n' +
          '  Example: pipeline override 42 "abc12345: deferred #99"\n' +
          '  Example: pipeline override 42 "abc12345: high_risk_accept: accept residual remediation_issue_url=https://… risk_acceptance_ref=RA-1"\n' +
          "  Bare reasons map to default_class / implicit low_risk_deferred (#693).",
      );
      process.exit(2);
    }
    if (overrideSpec === undefined) {
      console.error(
        "pipeline override: a spec string is required.\n" +
          '  Usage: pipeline override <N> "<key|scope>: [<class>:] <reason>"\n' +
          '  Example: pipeline override 42 "abc12345: deferred #99"\n' +
          '  Example: pipeline override 42 "abc12345: high_risk_accept: accept residual remediation_issue_url=https://… risk_acceptance_ref=RA-1"\n' +
          "  Bare reasons map to default_class / implicit low_risk_deferred (#693).",
      );
      process.exit(2);
    }
    // Kill-switch check: same gate as the legacy `pipeline N --override` form.
    if (isKillSwitchActive(cfg.domain)) {
      console.error(
        `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
      );
      process.exit(0);
    }
    const overrideN = Number.parseInt(overrideNumStr, 10);
    let overrideIssueNumber: number;
    try {
      overrideIssueNumber = await resolveIssueNumber(cfg, overrideN);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runOverride(cfg, overrideIssueNumber!, overrideSpec, opts, undefined, overrideN);
    return;
  }

  const number = Number.parseInt(numArg ?? "", 10);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(
      `pipeline: argument <number> is required (or use --cleanup, --init, 'pipeline init', 'pipeline doctor', 'pipeline release', 'pipeline intake', or 'pipeline logs')`,
    );
    process.exit(2);
  }

  // --summary (#147) is a local, read-only dump of the issue's evidence bundle.
  // It must work offline (handoff/debugging), so it runs before any gh call,
  // kill-switch check, label-ensure, or lock — and treats <number> as the issue
  // number the bundle is keyed by.
  if (opts.summary) {
    process.stderr.write(
      `Deprecated: \`pipeline ${number} --summary\` is deprecated. Use \`pipeline summary ${number}\` instead.\n`,
    );
    await runSummary(cfg, number, cfg.repo_dir);
    return;
  }

  // ---- Mode dispatch (bypass paths) ----
  // Status is read-only and must run BEFORE the kill-switch check so that
  // `pipeline N --status --json` always emits a parseable JSON envelope even
  // when the kill switch is active.  Unblock and override are recovery actions
  // for a stuck run; blocking them with a kill-switch check would prevent
  // recovery, so they also bypass it (below).
  if (opts.status) {
    process.stderr.write(
      `Deprecated: \`pipeline ${number} --status\` is deprecated. Use \`pipeline status ${number}\` instead.\n`,
    );
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number, { quiet: !!opts.json });
    } catch (err) {
      const e = err as Error;
      if (opts.json) {
        console.log(JSON.stringify({ schema_version: "1", status: "error", error: e.message }));
        process.exitCode = 1;
      } else {
        console.error(`pipeline: ${e.message}`);
        process.exit(1);
      }
      return;
    }
    await runStatus(cfg, issueNumber, defaultRunStatusDeps, { json: opts.json });
    return;
  }

  // --remove-worktree bypasses the kill switch — operators need worktree cleanup
  // most when a kill switch is active due to a stuck run.
  if (opts.removeWorktree) {
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number, { quiet: !!opts.json });
    } catch (err) {
      const e = err as Error;
      if (opts.json) {
        console.log(JSON.stringify({ removed: false, dirty: false, branch: null, worktree: null, error: e.message }));
      } else {
        console.error(`pipeline: ${e.message}`);
      }
      process.exitCode = 1;
      return;
    }
    await runRemoveWorktree(cfg, issueNumber, opts);
    return;
  }

  if (isKillSwitchActive(cfg.domain)) {
    console.error(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    process.exit(0);
  }

  if (opts.unblock !== undefined) {
    process.stderr.write(
      `Deprecated: \`pipeline ${number} --unblock\` is deprecated. Use \`pipeline unblock ${number} "<answer>"\` instead.\n`,
    );
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runUnblock(cfg, issueNumber, opts.unblock, number);
    return;
  }
  if (opts.override !== undefined) {
    process.stderr.write(
      `Deprecated: \`pipeline ${number} --override\` is deprecated. Use \`pipeline override ${number} "<spec>"\` instead.\n`,
    );
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runOverride(cfg, issueNumber, opts.override, opts, undefined, number);
    return;
  }

  // Run-start preflight (#146): runs BEFORE issue/PR resolution so that a broken
  // gh/auth/repo-access environment is caught and reported by the doctor summary
  // rather than a generic issue-resolution error. Opt-in via `doctor.runOnStart`
  // config or the `--doctor` flag. A failing preflight aborts before planning;
  // no planning/implementation/review tokens are consumed.
  const gate = await runStartPreflightGate(cfg, opts);
  if (!gate.proceed) {
    process.exitCode = 1;
    return;
  }

  // Resolve N → issue number (after preflight so env is confirmed healthy).
  let issueNumber: number;
  try {
    issueNumber = await resolveIssueNumber(cfg, number);
  } catch (err) {
    const e = err as Error;
    console.error(`pipeline: ${e.message}`);
    process.exit(1);
  }

  await runAdvance(cfg, issueNumber, toAdvanceOpts(opts));
}

// ---------------------------------------------------------------------------
// Cleanup mode
// ---------------------------------------------------------------------------

async function runCleanup(cfg: PipelineConfig): Promise<void> {
  console.log("[pipeline] cleanup: scanning for merged-PR worktrees...");
  const result = await sweepMergedWorktrees(cfg);
  if (result.removed.length === 0 && result.skipped.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }
  if (result.removed.length > 0) {
    console.log(`Removed ${result.removed.length} worktree(s):`);
    for (const rec of result.removed) {
      console.log(`  - ${rec.branch}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} worktree(s):`);
    for (const { rec, reason } of result.skipped) {
      console.log(`  - ${rec.branch}: ${reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Remove-worktree mode (#296)
// ---------------------------------------------------------------------------

export async function runRemoveWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: Pick<CliOpts, "force" | "json">,
): Promise<void> {
  const result = await removeWorktreeForIssue(cfg, issueNumber, { force: opts.force });

  if (opts.json) {
    console.log(JSON.stringify(result));
    if (!result.removed) process.exitCode = 1;
    return;
  }

  if (result.removed) {
    if (result.dirty) {
      console.warn(
        `[pipeline] #${issueNumber}: warning — worktree had uncommitted changes that were discarded`,
      );
    }
    console.log(`[pipeline] #${issueNumber}: worktree removed`);
    if (result.branch) console.log(`  branch: ${result.branch}`);
    if (result.worktree) console.log(`  path:   ${result.worktree}`);
    return;
  }

  // Failure paths
  if (result.error?.includes("no worktree found") || result.error?.startsWith("ambiguous:")) {
    console.error(`pipeline: #${issueNumber}: ${result.error}`);
  } else if (result.dirty && !opts.force) {
    console.error(`pipeline: #${issueNumber}: ${result.error}`);
    console.error(`  Retry with --force to discard uncommitted changes.`);
  } else {
    console.error(`pipeline: #${issueNumber}: removal failed: ${result.error}`);
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Init mode
// ---------------------------------------------------------------------------

export async function runInit(cfg: PipelineConfig): Promise<void> {
  await ensurePipelineLabels(cfg);
  const { created } = await scaffoldDefaultConfig(cfg.repo_dir, {
    profile: cfg.profile_name,
    harnesses: { implementer: cfg.harnesses.implementer, reviewer: cfg.harnesses.reviewer },
  });
  if (created) {
    console.log(`[pipeline] init: created .github/pipeline.yml with default configuration.`);
  } else {
    console.log(`[pipeline] init: .github/pipeline.yml already exists — skipping scaffold.`);
  }
  const { outcome } = ensureArtifactIgnoreBlock(cfg.repo_dir);
  if (outcome === "created") {
    console.log(`[pipeline] init: created .gitignore with the agent-pipeline artifact block.`);
  } else if (outcome === "updated") {
    console.log(`[pipeline] init: updated the agent-pipeline artifact block in .gitignore.`);
  } else {
    console.log(`[pipeline] init: .gitignore agent-pipeline artifact block already current.`);
  }
  console.log(`[pipeline] init: pipeline labels ensured in ${cfg.repo}.`);
}

// ---------------------------------------------------------------------------
// Config subcommands (#156)
// ---------------------------------------------------------------------------

/**
 * `pipeline config schema`   — print JSON Schema for .github/pipeline.yml
 * `pipeline config validate` — validate config and print structured diagnostics
 * `pipeline config sync`     — preview/apply a scaffold refresh preserving behavior
 */
export async function runConfigCommand(args: string[], opts: CliOpts): Promise<void> {
  const subcmd = args[0];

  if (subcmd === "schema") {
    if (args.length > 1) {
      console.error(`pipeline config schema: unexpected argument(s): ${args.slice(1).join(", ")}`);
      process.exitCode = 2;
      return;
    }
    const schema = generateConfigSchema();
    process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
    process.exitCode = 0;
    return;
  }

  if (subcmd === "validate") {
    if (args.length > 1) {
      console.error(`pipeline config validate: unexpected argument(s): ${args.slice(1).join(", ")}`);
      process.exitCode = 2;
      return;
    }
    const repoPath = opts.repoPath ?? process.cwd();
    const result = validateConfig(repoPath, { profile: opts.profile });

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      if (result.diagnostics.length === 0) {
        console.log("pipeline config: valid (no diagnostics)");
      } else {
        for (const d of result.diagnostics) {
          const prefix = d.severity === "error" ? "ERROR" : "WARN ";
          const loc = d.path ? ` [${d.path}]` : "";
          const lineStr = d.line != null ? ` (line ${d.line})` : "";
          console.log(`  ${prefix}${loc}${lineStr}: ${d.message}`);
        }
        if (result.valid) {
          console.log("pipeline config: valid (warnings only)");
        } else {
          console.log("pipeline config: invalid");
        }
      }
    }

    const hasError = result.diagnostics.some((d) => d.severity === "error");
    process.exitCode = hasError ? 1 : 0;
    return;
  }

  if (subcmd === "sync") {
    if (args.length > 1) {
      console.error(`pipeline config sync: unexpected argument(s): ${args.slice(1).join(", ")}`);
      process.exitCode = 2;
      return;
    }
    const repoPath = opts.repoPath ?? process.cwd();
    const result = syncConfig(repoPath, { apply: !!opts.apply }, { profile: opts.profile });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (!result.ok) {
      console.log("pipeline config sync: blocked");
      for (const d of result.diagnostics) {
        const prefix = d.severity === "error" ? "ERROR" : "WARN ";
        const loc = d.path ? ` [${d.path}]` : "";
        const lineStr = d.line != null ? ` (line ${d.line})` : "";
        console.log(`  ${prefix}${loc}${lineStr}: ${d.message}`);
      }
    } else if (!result.changed) {
      console.log(`pipeline config sync: already current (${result.configPath})`);
    } else if (result.applied) {
      console.log(`pipeline config sync: updated ${result.configPath}`);
    } else {
      console.log(`pipeline config sync: preview for ${result.configPath} (no writes; re-run with --apply to update)`);
      if (result.diff) process.stdout.write(result.diff);
    }
    process.exitCode = result.ok ? 0 : result.inferenceFailure ? 2 : 1;
    return;
  }

  if (subcmd === "repo-map") {
    await runConfigRepoMapCommand(args.slice(1), opts);
    return;
  }

  const sub = subcmd ? `"${subcmd}"` : "(none)";
  console.error(`pipeline config: unknown subcommand ${sub}. Available: schema, validate, sync, repo-map`);
  process.exitCode = 2;
}

/**
 * `pipeline config repo-map add <owner/repo> [--rel depends_on|depended_on_by]`
 * `pipeline config repo-map remove <owner/repo> [--rel depends_on|depended_on_by]`
 * `pipeline config repo-map list`
 */
async function runConfigRepoMapCommand(args: string[], opts: CliOpts): Promise<void> {
  const action = args[0];
  const repoPath = opts.repoPath ?? process.cwd();

  if (action === "list") {
    if (args.length > 1) {
      console.error(`pipeline config repo-map list: unexpected argument(s): ${args.slice(1).join(", ")}`);
      process.exitCode = 2;
      return;
    }
    const result = repoMapList(repoPath, { profile: opts.profile });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (!result.ok) {
      console.error(result.message);
    } else if (result.entries.depends_on.length === 0 && result.entries.depended_on_by.length === 0) {
      console.log(result.message);
    } else {
      console.log(`repo_map (${result.configPath}):`);
      console.log(`  depends_on:`);
      for (const r of result.entries.depends_on) console.log(`    - ${r}`);
      console.log(`  depended_on_by:`);
      for (const r of result.entries.depended_on_by) console.log(`    - ${r}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (action === "add" || action === "remove") {
    const ownerRepo = args[1];
    if (!ownerRepo) {
      console.error(`pipeline config repo-map ${action}: <owner/repo> argument is required`);
      process.exitCode = 2;
      return;
    }
    if (args.length > 2) {
      console.error(`pipeline config repo-map ${action}: unexpected argument(s): ${args.slice(2).join(", ")}`);
      process.exitCode = 2;
      return;
    }
    const rel = opts.rel ?? "depends_on";
    if (rel !== "depends_on" && rel !== "depended_on_by") {
      console.error(`pipeline config repo-map ${action}: --rel must be "depends_on" or "depended_on_by", got "${rel}"`);
      process.exitCode = 2;
      return;
    }
    const result =
      action === "add"
        ? repoMapAdd(repoPath, ownerRepo, rel as RepoMapRelation, { profile: opts.profile })
        : repoMapRemove(repoPath, ownerRepo, rel as RepoMapRelation, { profile: opts.profile });

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.log(result.message);
      if (result.warning) console.warn(`warning: ${result.warning}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const sub = action ? `"${action}"` : "(none)";
  console.error(`pipeline config repo-map: unknown subcommand ${sub}. Available: add, remove, list`);
  process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// Doctor / preflight (#146)
// ---------------------------------------------------------------------------

/** IO seam shared by `runDoctor` and `runStartPreflightGate` so unit tests inject
 *  fakes — no real subprocess/fs/network. */
export interface PreflightCliDeps {
  runPreflight: typeof runPreflight;
  storePreflightResult: typeof storePreflightResult;
  /** RecoverySupervisor observation sink. Standalone doctor must not call this. */
  reportObservation?: ReportOperationObservation;
  /** Test seam: recovery episode writes. Standalone doctor must not call this. */
  writeRecoveryEpisode?: (episode: unknown) => void;
  /** Optional: injected harness-smoke runner for unit tests (#780). */
  runHarnessSmoke?: (
    cfg: PipelineConfig,
    smokeDeps?: HarnessSmokeDeps,
    opts?: { failFast?: boolean; reviewerPromptDelivery?: "argv" | "stdin" },
  ) => ReturnType<typeof runHarnessSmoke>;
  /** Optional: real smoke deps factory; tests omit (orchestration faked via runHarnessSmoke). */
  harnessSmokeDeps?: () => HarnessSmokeDeps;
}

const defaultPreflightCliDeps: PreflightCliDeps = {
  runPreflight,
  storePreflightResult,
  runHarnessSmoke,
  harnessSmokeDeps: () => realHarnessSmokeDeps(realDoctorDeps()),
};

/**
 * Run static preflight, then optionally fold opt-in harness-smoke outcomes (#780).
 * Default doctor (no `--harness-smoke`) remains model-free.
 */
async function runDoctorChecks(
  cfg: PipelineConfig,
  opts: CliOpts,
  deps: PreflightCliDeps,
): Promise<PreflightResult> {
  const failFast = opts.failFast ?? cfg.doctor.failFast;
  const staticResult = await deps.runPreflight(cfg, undefined, { failFast }, VERSION);
  if (!opts.harnessSmoke) {
    return staticResult;
  }
  // Under --fail-fast, do not start paid dynamic smoke after a static failure.
  if (failFast && !staticResult.ok) {
    return staticResult;
  }
  const smokeRunner = deps.runHarnessSmoke ?? runHarnessSmoke;
  const smokeDeps = deps.harnessSmokeDeps?.();
  const smokeChecks = await smokeRunner(
    cfg,
    smokeDeps,
    {
      failFast,
      reviewerPromptDelivery: cfg.harnesses.reviewerPromptDelivery ?? "argv",
    },
  );
  const folded = foldSmokeIntoChecks(staticResult.checks, smokeChecks);
  return {
    schema_version: staticResult.schema_version,
    ok: folded.ok,
    checks: folded.checks,
    ranAt: staticResult.ranAt,
  };
}

/** `pipeline doctor`: run every preflight check, print the summary, persist the
 *  result for `--status`, and set the exit code (0 all-pass, 1 any failure).
 *  With `--json`: emit a single unfenced JSON object instead of prose.
 *  With `--is-ok`: emit zero output; exit 0/1 only (cheap polling gate).
 *  With `--harness-smoke`: also run role-aware dynamic harness smoke (~1 cheap
 *  model call per unique configured treatment) after static checks (#780).
 *  `--json` and `--is-ok` are mutually exclusive. */
export async function runDoctor(
  cfg: PipelineConfig,
  opts: CliOpts,
  deps: PreflightCliDeps = defaultPreflightCliDeps,
): Promise<void> {
  if (opts.json && opts.isOk) {
    console.error(
      "pipeline doctor: --json and --is-ok are mutually exclusive — use one or the other.",
    );
    process.exitCode = 2;
    return;
  }

  if (opts.isOk) {
    // Silent polling gate: run checks, set exit code, zero bytes of output.
    try {
      const result = await runDoctorChecks(cfg, opts, deps);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
    return;
  }

  const result = await runDoctorChecks(cfg, opts, deps);
  await deps.storePreflightResult(cfg, result);

  if (opts.json) {
    console.log(JSON.stringify(formatDoctorJson(result)));
  } else {
    let summary = formatDoctorSummary(result);
    if (opts.harnessSmoke) {
      summary +=
        "\n\nHarness smoke: ~1 cheap model call per unique configured treatment was requested via --harness-smoke.";
    }
    console.log(summary);
  }
  process.exitCode = result.ok ? 0 : 1;
}

/** Run-start preflight gate: when enabled (`doctor.runOnStart` or `--doctor`),
 *  run the checks before planning and report whether the advance may proceed.
 *  Returns `{ proceed: true }` unchanged when the feature is not enabled, so an
 *  ordinary run is byte-for-byte unaffected. */
export async function runStartPreflightGate(
  cfg: PipelineConfig,
  opts: CliOpts,
  deps: PreflightCliDeps = defaultPreflightCliDeps,
): Promise<{ proceed: boolean; result: PreflightResult | null }> {
  const enabled = cfg.doctor.runOnStart || !!opts.doctor;
  if (!enabled) return { proceed: true, result: null };

  console.log(`[pipeline] running preflight (doctor) before planning...`);
  const failFast = opts.failFast ?? cfg.doctor.failFast;
  const result = await deps.runPreflight(cfg, undefined, { failFast }, VERSION);
  await deps.storePreflightResult(cfg, result);
  console.log(formatDoctorSummary(result));
  if (!result.ok) {
    console.error(
      `[pipeline] preflight failed — aborting before planning. Fix the issues above (or run \`pipeline doctor\`) and re-run.`,
    );
    const failing = result.checks.filter((c) => c.status === "fail");
    const capabilityCheck = failing.find((c) =>
      /^(github-auth|repo-access|git-push-auth|cli:|harness:)/.test(c.id),
    );
    reportMechanicalFault(deps.reportObservation, {
      operation: "run_start_preflight",
      form_id: "advance",
      message: failing.map((c) => `${c.id}: ${c.detail}`).join("; ") || "preflight failed",
      fault: capabilityCheck ? "capability" : "mechanical",
      capability_request: capabilityCheck
        ? {
            kind: "capability",
            capability: capabilityCheck.id,
            detail: capabilityCheck.remediation ?? capabilityCheck.detail,
          }
        : null,
    });
    return { proceed: false, result };
  }
  return { proceed: true, result };
}

/** IO seam for {@link resolveIssueNumber} so unit tests inject fakes — no real gh. */
export interface ResolveIssueNumberDeps {
  getItemKind: typeof getItemKind;
  getPrLinkedIssue: typeof getPrLinkedIssue;
}

const defaultResolveIssueNumberDeps: ResolveIssueNumberDeps = { getItemKind, getPrLinkedIssue };

/**
 * Resolve `number` to an issue number. If `number` is already an issue it is
 * returned as-is. If it is a PR the linked closing issue is returned.
 *
 * Pass `quiet: true` (e.g. for JSON status mode) to suppress the prose
 * `[pipeline] #N is a PR → resolved to issue #M` line — that line would
 * precede and corrupt the JSON envelope on stdout.
 */
export async function resolveIssueNumber(
  cfg: PipelineConfig,
  number: number,
  opts: { quiet?: boolean } = {},
  deps: ResolveIssueNumberDeps = defaultResolveIssueNumberDeps,
): Promise<number> {
  const kind = await deps.getItemKind(cfg, number);
  if (kind === "issue") return number;
  // PR → look up linked closing issue.
  const linked = await deps.getPrLinkedIssue(cfg, number);
  if (linked === null) {
    throw new Error(
      `#${number} is a PR with no closing-issue reference. The pipeline is issue-centric. ` +
        `${cfg.invocation}: either add "Closes #<n>" to the PR body, or run against the issue directly.`,
    );
  }
  if (!opts.quiet) {
    console.log(`[pipeline] #${number} is a PR → resolved to issue #${linked}`);
  }
  return linked;
}

// ---------------------------------------------------------------------------
// Status mode
// ---------------------------------------------------------------------------

/** IO seam for {@link runStatus} so unit tests inject fakes — no real gh. */
export interface RunStatusDeps {
  getIssueDetail: typeof getIssueDetail;
  getPrForIssue: typeof getPrForIssue;
  /** Latest stored preflight result (#146); optional so existing callers are unaffected. */
  loadLatestPreflightResult?: typeof loadLatestPreflightResult;
  /** For JSON mode (#154): look up the active worktree for an issue. */
  getForIssue?: (cfg: PipelineConfig, issueNumber: number) => Promise<{ path: string; slug: string } | null>;
  /** For JSON mode (#154): fetch pipeline-label addition events for `last_event`. */
  getLabelEvents?: (cfg: PipelineConfig, issueNumber: number) => Promise<{ label: string; createdAt: string }[]>;
  /** For JSON mode's `possibly_wedged` flag (#398): the most-recent run's
   *  events.jsonl finalized/last-event summary for the issue, or null when no
   *  run directory exists. */
  getLatestRunEvents?: (cfg: PipelineConfig, issueNumber: number) => Promise<RunEventsSummary | null>;
  /**
   * List durable human-question handoffs for status projection (#647).
   * Optional — when absent, status skips the handoff section (ceiling punch-list
   * behavior unchanged).
   */
  listHandoffs?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<
    Array<{
      handoff_id: string;
      status: string;
      handoff_class: string;
      authority_mode: string;
      question: string;
      created_at: string;
    }>
  >;
}

const defaultRunStatusDeps: RunStatusDeps = {
  getIssueDetail,
  getPrForIssue,
  loadLatestPreflightResult,
  getForIssue: getOnDiskForIssue,
  getLabelEvents: getIssueLabelEvents,
  getLatestRunEvents: (cfg, issueNumber) => latestRunEventsSummaryForIssue(cfg.repo_dir, issueNumber),
  listHandoffs: async (cfg, issueNumber) => {
    const { listHandoffs } = await import("./human-question-handoff.ts");
    return listHandoffs(cfg.repo_dir, { issue: issueNumber });
  },
};

export async function runStatus(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: RunStatusDeps = defaultRunStatusDeps,
  statusOpts: { json?: boolean } = {},
): Promise<void> {
  // JSON mode (#154): assemble a stable envelope and emit it; skip all prose.
  if (statusOpts.json) {
    try {
      const detail = await deps.getIssueDetail(cfg, issueNumber);
      const prNumber = await deps.getPrForIssue(cfg, issueNumber);
      const worktreeInfo = deps.getForIssue
        ? await deps.getForIssue(cfg, issueNumber).catch(() => null)
        : null;
      // In JSON mode, label-event failures must propagate to the outer error handler
      // so the envelope reports status:"error" rather than silently returning stale data.
      const labelEvents = deps.getLabelEvents
        ? await deps.getLabelEvents(cfg, issueNumber)
        : [];
      const runEvents = deps.getLatestRunEvents
        ? await deps.getLatestRunEvents(cfg, issueNumber).catch(() => null)
        : null;
      let handoffProj: StatusPayload["handoffs"] | undefined;
      if (deps.listHandoffs) {
        const hs = await deps.listHandoffs(cfg, issueNumber).catch(() => []);
        if (hs.length > 0) {
          handoffProj = hs.map((h) => ({
            handoff_id: h.handoff_id,
            status: h.status,
            handoff_class: h.handoff_class,
            authority_mode: h.authority_mode,
            question_summary:
              h.question.length > 80 ? `${h.question.slice(0, 77)}...` : h.question,
          }));
        }
      }
      const payload: StatusPayload = buildStatusPayload(
        { ...detail, labelEvents },
        prNumber,
        worktreeInfo,
        cfg,
        runEvents,
        new Date(),
        handoffProj,
      );
      console.log(JSON.stringify(payload));
    } catch (err) {
      const e = err as Error;
      console.log(JSON.stringify({ schema_version: "1", status: "error", error: e.message }));
      process.exitCode = 1;
    }
    return;
  }

  const detail = await deps.getIssueDetail(cfg, issueNumber);
  const stage = pickStage(detail.labels);
  const blocked = isBlocked(detail.labels);
  const prNumber = await deps.getPrForIssue(cfg, issueNumber);

  console.log(`#${detail.number} — ${detail.title}`);
  console.log(`State: ${detail.state}`);
  console.log(`Stage: ${stage ?? "(no pipeline label)"}`);
  console.log(`Blocked: ${blocked ? "yes" : "no"}`);
  console.log(`Repo: ${cfg.repo}  domain=${cfg.domain}`);
  if (prNumber) {
    console.log(`PR: #${prNumber} — https://github.com/${cfg.repo}/pull/${prNumber}`);
  } else {
    console.log("PR: (none)");
  }
  console.log(`URL: ${detail.url}`);

  // Last activity / pipeline event from comments.
  const lastPipelineComment = [...detail.comments]
    .reverse()
    .find((c) => c.body.startsWith("## Pipeline:") || c.body.startsWith("## Review "));
  if (lastPipelineComment) {
    const firstLine = lastPipelineComment.body.split("\n", 1)[0];
    console.log(`Last pipeline event: ${firstLine}  (${lastPipelineComment.createdAt})`);
  }

  // Latest review summary, if any.
  const lastReview = [...detail.comments].reverse().find((c) => c.body.startsWith("## Review "));
  if (lastReview) {
    const firstLine = lastReview.body.split("\n", 1)[0];
    console.log(`Last review: ${firstLine}`);
  }

  // #115: parked at `needs-human` → surface the punch-list (unresolved blocking
  // count + resume steps) so the operator knows what to do, not just the bare
  // stage. Gated on the stage so every other stage's output is unchanged.
  if (stage === "needs-human") {
    const punchlist = needsHumanPunchlist(detail.comments);
    console.log("");
    console.log(
      punchlist ??
        `Needs human, but no ${REVIEW_CEILING_MARKER.replace(/^## /, "")} comment was found. ` +
          `Run \`--override "<key>: <reason>"\` (auto-resumes) or fix the residual findings and relabel ` +
          `\`pipeline:needs-human\` → \`pipeline:review-<round>\` to resume.`,
    );
    // #647: list pending human-question handoffs without replacing the punch-list.
    if (deps.listHandoffs) {
      const hs = await deps.listHandoffs(cfg, issueNumber).catch(() => []);
      const pending = hs.filter((h) => h.status === "pending");
      if (pending.length > 0) {
        console.log("");
        console.log(`Human-question handoffs (${pending.length} pending):`);
        for (const h of pending) {
          const q =
            h.question.length > 80 ? `${h.question.slice(0, 77)}...` : h.question;
          console.log(
            `- ${h.handoff_id} [${h.handoff_class}/${h.authority_mode}] — ${q}`,
          );
        }
        console.log(
          "Inspect: pipeline handoff show <id>   Answer: pipeline handoff answer <id> --text \"...\"",
        );
      }
    }
  }

  // #633: warn when the latest run's event stream recorded write failures so
  // operators can see incomplete evidence without reading the original stderr.
  const runEvents = deps.getLatestRunEvents
    ? await deps.getLatestRunEvents(cfg, issueNumber).catch(() => null)
    : null;
  const writeHealthWarning = formatWriteHealthStatusWarning(runEvents?.writeHealth ?? null);
  if (writeHealthWarning) {
    console.log("");
    console.log(writeHealthWarning);
  }

  // #146: surface the latest preflight result if one was stored by a prior
  // `pipeline doctor` run. Absent → omit the section silently (no error).
  const loadPreflight = deps.loadLatestPreflightResult ?? loadLatestPreflightResult;
  const preflight = await loadPreflight(cfg);
  if (preflight) {
    console.log("");
    console.log(formatDoctorSummary(preflight));
  }
}

/**
 * Pure helper (#115): build the `needs-human` punch-list from the issue's
 * comments — the count of still-blocking findings, each finding line tagged
 * `RECURRING (n rounds)` / `NEW` (#133), plus the resume steps. Reads only
 * controlled strings the pipeline itself emits in the latest
 * `## Pipeline: Review ceiling reached` comment (posted at the round ceiling or
 * on a recurrence-triggered early park — same header) and the prior Review-N
 * verdict comments the tags are derived from; returns `null` when no ceiling
 * comment exists (the caller prints a graceful fallback). Total function: no
 * network, git, or subprocess calls.
 */
export function needsHumanPunchlist(
  comments: { author: string; body: string; createdAt: string }[],
): string | null {
  // Latest ceiling comment wins (highest index): a re-run posts a fresh one.
  let ceilingIdx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.startsWith(REVIEW_CEILING_MARKER)) {
      ceilingIdx = i;
      break;
    }
  }
  if (ceilingIdx === -1) return null;

  const body = comments[ceilingIdx].body;
  const findings = ceilingFindingLines(body);
  const count = findings.length;
  const noun = count === 1 ? "finding" : "findings";
  const round = ceilingRound(body) ?? 2;
  return [
    `Needs human: ${count} unresolved blocking ${noun} from the review ceiling.`,
    ...reviewStage.tagCeilingFindingLines(findings, comments, ceilingIdx),
    `To resume:`,
    `- \`--override "<key>: <reason>"\` (audited) — records the decision and auto-resumes.`,
    `- Or fix it by hand and relabel \`pipeline:needs-human\` → \`pipeline:review-${round}\`.`,
  ].join("\n");
}

/** The `- ` bullet lines under the controlled `### Unresolved blocking findings`
 *  heading, stopping at the next `### ` section. Their count is the
 *  blocking-finding count. */
function ceilingFindingLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### Unresolved blocking findings");
  if (start === -1) return [];
  const found: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### ")) break; // next section ends the list
    if (lines[i].startsWith("- ")) found.push(lines[i]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Summary mode (#147 / #261): print the evidence bundle for an issue and exit.
// Read-only; never enters the dispatch loop or mutates GitHub.
// ---------------------------------------------------------------------------

/** Injectable I/O seam for {@link runSummary} and {@link runSummaryByRunId}. */
export interface RunSummaryDeps {
  /** Read the most-recent run-directory summary.json for the issue (run-store path). */
  latestSummaryForIssue: (repoDir: string, issueNumber: number) => Promise<EvidenceBundle | null>;
  /** Read the legacy evidence bundle from the /tmp state dir (legacy path). */
  readBundle: (stateDir: string, issueNumber: number) => Promise<EvidenceBundle | null>;
  /** Raw file read for exact-run-id lookup (runSummaryByRunId). */
  readFile: (p: string) => Promise<string>;
}

export type SummaryTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "run"; runId: string };

/** Distinguish the issue-scoped direct form from an exact run-id selector. */
export function parseSummaryTarget(selector: string | undefined): SummaryTarget | null {
  if (!selector) return null;
  if (/^\d+$/.test(selector)) {
    const issueNumber = Number.parseInt(selector, 10);
    return issueNumber > 0 ? { kind: "issue", issueNumber } : null;
  }
  return { kind: "run", runId: selector };
}

const defaultRunSummaryDeps: RunSummaryDeps = {
  latestSummaryForIssue,
  readBundle,
  readFile: defaultRunStoreDeps.readFile,
};

/** `pipeline N --summary` (#261): prefer the run-directory summary.json for the
 *  most-recent run matching the issue; fall back to the legacy /tmp evidence
 *  bundle only when no run-directory summary is readable. */
export async function runSummary(
  cfg: PipelineConfig,
  issueNumber: number,
  repoDir: string,
  deps: RunSummaryDeps = defaultRunSummaryDeps,
): Promise<void> {
  const stateDir = runStateDir(cfg.domain);

  // Priority 1: run-directory summary.json (durable, survives reboots).
  const runDirBundle = await deps.latestSummaryForIssue(repoDir, issueNumber).catch(() => null);

  // Priority 2: legacy /tmp evidence.json. Catch any error (corrupt JSON, etc.)
  // and treat it as absent — the error message below names both locations.
  const bundle = runDirBundle ?? (await deps.readBundle(stateDir, issueNumber).catch(() => null));

  if (!bundle) {
    console.error(
      `pipeline: no evidence bundle found for #${issueNumber}.\n` +
        `  Run-directory: ${runsDir(repoDir)}/${issueNumber}-*/summary.json\n` +
        `  Legacy path:   ${bundlePath(stateDir, issueNumber)}\n` +
        `A bundle is written once the pipeline runs on this issue.`,
    );
    process.exitCode = 1;
    return;
  }
  printSummary(bundle);
}

/** `pipeline summary <run-id>` (#261): print summary.json from an exact run
 *  directory without requiring domain config or an issue number. Domain-independent:
 *  the run directory is located from the repo root alone. */
export async function runSummaryByRunId(
  repoDir: string,
  runId: string,
  deps: RunSummaryDeps = defaultRunSummaryDeps,
): Promise<void> {
  const summaryPath = path.join(runDirPath(repoDir, runId), "summary.json");
  let raw: string;
  try {
    raw = await deps.readFile(summaryPath);
  } catch {
    console.error(
      `pipeline summary: no summary.json found for run '${runId}'\n` +
        `  Expected: ${summaryPath}`,
    );
    process.exitCode = 1;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      `pipeline summary: summary.json for run '${runId}' is corrupt (invalid JSON)\n` +
        `  Path: ${summaryPath}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!isValidSummaryBundle(parsed)) {
    console.error(
      `pipeline summary: summary.json for run '${runId}' is missing required fields\n` +
        `  Path: ${summaryPath}`,
    );
    process.exitCode = 1;
    return;
  }
  printSummary(parsed);
}

// ---------------------------------------------------------------------------
// Logs mode (#155 / #725): print or follow a run's terminal.log / events.jsonl
// independent of the original pipeline process. Reads from
// .agent-pipeline/runs/<run-id>/. With `--events --follow`, until-terminal is
// the default (exit 0 on `run_complete`); `--no-until-terminal` is interrupt-only.
// ---------------------------------------------------------------------------

/** Options for {@link runLogs} follow mode. */
export interface RunLogsFollowOptions {
  /**
   * When true (default for `--events --follow`), exit 0 after printing a
   * complete JSONL line with advance event type `run_complete`. When false
   * (`--no-until-terminal`), remain open until interrupt. Ignored without
   * `--events --follow` (terminal.log follow stays interrupt-only).
   */
  untilTerminal?: boolean;
}

/**
 * Injectable follow seam for {@link runLogs}. Unit tests inject fakes; production
 * uses line-aware until-terminal for events and interrupt-only tail for terminal.log.
 */
export interface RunLogsDeps {
  followFile(
    logFile: string,
    opts: {
      untilTerminal: boolean;
      events: boolean;
    },
  ): Promise<number | null>;
  stdoutWrite(s: string): void;
  stderrWrite(s: string): void;
}

export function defaultRunLogsDeps(): RunLogsDeps {
  return {
    followFile(logFile, opts) {
      // Until-terminal only applies to structured events follow (#725).
      if (opts.events && opts.untilTerminal) {
        return followEventsWithTerminalExit(
          logFile,
          {
            untilTerminal: true,
            isTerminalLine: isAdvanceRunCompleteLine,
            errorLabel: "pipeline logs",
          },
          defaultFollowEventsIo(),
        );
      }
      // Interrupt-only: terminal.log, or events with --no-until-terminal.
      return followFileWithSignalCleanup(logFile);
    },
    stdoutWrite(s) {
      process.stdout.write(s);
    },
    stderrWrite(s) {
      process.stderr.write(s);
    },
  };
}

export async function runLogs(
  repoDir: string,
  runId: string | undefined,
  follow: boolean,
  events = false,
  followOpts: RunLogsFollowOptions = {},
  deps: RunLogsDeps = defaultRunLogsDeps(),
): Promise<void> {
  // No run-id: list available runs, most recent first, then exit 0.
  if (runId === undefined) {
    const ids = await listRunIds(repoDir);
    if (ids.length === 0) {
      console.log(`No pipeline runs found in ${runsDir(repoDir)}.`);
      return;
    }
    for (const id of ids) console.log(id);
    return;
  }

  const dir = runDirPath(repoDir, runId);
  const fileName = events ? "events.jsonl" : "terminal.log";
  const logFile = path.join(dir, fileName);
  // Default until-terminal ON for events follow only (#725).
  const untilTerminal = events && follow && followOpts.untilTerminal !== false;

  // Check that the run directory exists.
  try {
    await defaultRunStoreDeps.stat(dir);
  } catch {
    console.error(`pipeline logs: unknown run-id '${runId}' (no directory at ${dir})`);
    process.exitCode = 1;
    return;
  }

  if (!follow) {
    // Print the selected run-store log and exit.
    let content: string;
    try {
      content = await defaultRunStoreDeps.readFile(logFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`pipeline logs: ${fileName} not yet written for run '${runId}'`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    process.stdout.write(content);
    return;
  }

  // Pre-check so until-terminal follow fails closed when the stream cannot start
  // (no hang waiting for a never-created file). Interrupt-only tail also fails
  // non-zero on missing files via the follow seam (#155).
  try {
    await defaultRunStoreDeps.stat(logFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const untilNote = events
        ? ` Follow mode streams event lines; by default it exits 0 after ` +
          `run_complete (use --no-until-terminal for interrupt-only).`
        : "";
      console.error(
        `pipeline logs: ${fileName} not yet written for run '${runId}'.${untilNote}`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // --follow: independent of the original pipeline process. Events path defaults
  // to until-terminal (exit 0 on run_complete); terminal.log stays interrupt-only.
  const code = await deps.followFile(logFile, {
    untilTerminal,
    events,
  });
  if (code !== null && code !== 0) {
    process.exitCode = code;
  }
}

// ---------------------------------------------------------------------------
// `pipeline run <N>` subcommand handler
// ---------------------------------------------------------------------------

/** IO seam for tests — override spawnDetached / git-root resolution without touching the
 *  real filesystem, git, or a subprocess. */
export interface RunSubcommandDeps {
  spawnDetached: typeof spawnDetached;
  findGitRoot: typeof findGitRoot;
  cwd: () => string;
  /**
   * Same-host dead-wrapper re-entry (#1332). When provided, a dead holder of a
   * non-terminal run restores through the Liveness Provider instead of minting
   * a new Logical Operation. Live holders still reject duplicate detach.
   */
  restoreDeadDetached?: (input: {
    issueNumber: number;
    domain: string;
    repoDir?: string;
  }) => Promise<{
    ok: boolean;
    runId: string;
    logicalOperationId: string;
    supervisorStarted: boolean;
    reason?: string;
    liveHolder?: { pid: number; hostname: string };
  } | null>;
}
const defaultRunSubcommandDeps: RunSubcommandDeps = {
  spawnDetached,
  findGitRoot,
  cwd: () => process.cwd(),
  restoreDeadDetached: (input) => productionRestoreDeadDetached(input),
};

export async function handleRunSubcommand(
  numStr: string,
  opts: CliOpts,
  partialDeps: Partial<RunSubcommandDeps> = {},
): Promise<void> {
  const deps: RunSubcommandDeps = { ...defaultRunSubcommandDeps, ...partialDeps };
  const number = Number.parseInt(numStr ?? "", 10);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(`pipeline run: <number> argument is required and must be a positive integer`);
    process.exitCode = 2;
    return;
  }

  if (opts.detach) {
    // Resolve the repo BEFORE creating any artifact (#485). A detached launch used to
    // compute `findGitRoot(start) ?? start` — silently falling back to an unvalidated
    // cwd — then create the wrapper dir, log, and run-store pointer, only to have the
    // inner process fail with exit 2 after the damage was done. Fail here instead, with
    // the same message/exit code the inner `resolveConfig` uses, before any write.
    const runStoreStart = opts.repoPath ? path.resolve(opts.repoPath) : deps.cwd();
    const repoDir = deps.findGitRoot(runStoreStart);
    if (!repoDir) {
      console.error(
        `pipeline: no git repo found at or above ${runStoreStart}. Run from inside a checkout, or pass --repo-path.`,
      );
      process.exitCode = 2;
      return;
    }

    // Domain identity for the shared issue-run lock (#634): same derivation as
    // resolveConfig (explicit --domain, else basename of the resolved repo root).
    // Must be known before any lock or wrapper run-dir is created.
    const domain = (opts.domain?.trim() || path.basename(repoDir));
    if (!domain) {
      console.error(`pipeline: could not derive domain for detached run of #${number}`);
      process.exitCode = 2;
      return;
    }

    // Pre-allocate the #155 run-store run id here so the detached caller is given the
    // SAME `.agent-pipeline/runs/<run-id>` the inner run will use. Without this the
    // detached launch exposed only the wrapper dir (pipeline.log/sentinel.json), and a
    // desktop consumer could not find the structured event log without guessing —
    // reintroducing the competing artifact format the #155 contract avoids (#155).
    const runStoreRunId = runIdFor(number, new Date());
    const runStoreDir = runDirPath(repoDir, runStoreRunId);

    // Forward all launch-shaping options so the inner pipeline process respects
    // the same profile / repo / model the caller specified (e.g. --profile claude).
    const passArgs: string[] = [];
    if (opts.profile) passArgs.push("--profile", opts.profile);
    if (opts.repoPath) passArgs.push("--repo-path", opts.repoPath);
    if (opts.base) passArgs.push("--base", opts.base);
    // Always forward domain so the inner process matches the lock key we used.
    passArgs.push("--domain", domain);
    if (opts.model) passArgs.push("--model", opts.model);
    // Forward lifecycle / no-write semantics too. Omitting these silently broke
    // the contract for the highest-risk mode: `pipeline run <N> --detach --dry-run`
    // would otherwise start a REAL background advance that mutates GitHub/worktree
    // after the launcher exits. These boolean flags must reach the inner process
    // (or be rejected) so detached runs preserve dry-run/once/doctor semantics (#153).
    if (opts.dryRun) passArgs.push("--dry-run");
    if (opts.once) passArgs.push("--once");
    if (opts.sha) passArgs.push("--sha", opts.sha);
    if (opts.doctor) passArgs.push("--doctor");
    if (opts.failFast) passArgs.push("--fail-fast");
    // Pin the inner run to the pre-allocated #155 run-store id, and forward
    // --json-events so the detached run's event stream and run directory are
    // discoverable via the documented contract rather than the wrapper artifacts (#155).
    passArgs.push("--run-id", runStoreRunId);
    if (opts.jsonEvents) passArgs.push("--json-events");

    if (deps.restoreDeadDetached) {
      const restored = await deps.restoreDeadDetached({ issueNumber: number, domain, repoDir });
      if (restored?.reason === "live_holder") {
        console.error(
          `pipeline run: issue #${number} is already running` +
            (restored.liveHolder ? ` (held by PID ${restored.liveHolder.pid})` : "") +
            ".",
        );
        process.exitCode = 1;
        return;
      }
      if (restored?.ok) {
        console.log(
          JSON.stringify({
            schema_version: 1,
            kind: "liveness_restore",
            run_id: restored.runId,
            logical_operation_id: restored.logicalOperationId,
            restored: true,
          }),
        );
        return;
      }
    }

    let result: Awaited<ReturnType<typeof spawnDetached>>;
    try {
      result = await deps.spawnDetached(number, passArgs, {
        domain,
        timeout: opts.timeout,
        flockTimeoutMs: opts.flockTimeout,
      });
    } catch (err) {
      console.error(`pipeline run: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    // Machine-readable link from the wrapper dir (which the caller captures from
    // stdout below) to the #155 run store, so a Pipeline Desk caller can discover
    // events.jsonl/terminal.log without parsing any prose (#155). Best-effort.
    try {
      writeFileSync(
        path.join(result.runDir, "run-store.json"),
        JSON.stringify(
          {
            schema_version: 1,
            run_store_run_id: runStoreRunId,
            run_store_dir: runStoreDir,
            events: path.join(runStoreDir, "events.jsonl"),
            terminal_log: path.join(runStoreDir, "terminal.log"),
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      /* best-effort pointer — the run store still exists at runStoreDir */
    }
    console.log(result.runDir);
    console.error(`[pipeline] #${number}: detached run started (PID ${result.pid})`);
    console.error(`[pipeline] #${number}: wrapper supervision: poll ${result.runDir}/sentinel.json (log: ${result.runDir}/pipeline.log)`);
    console.error(`[pipeline] #${number}: structured run artifacts at ${runStoreDir}/ — events.jsonl + terminal.log are the Pipeline Desk contract`);
    console.error(`[pipeline] #${number}: machine-readable link: ${result.runDir}/run-store.json; follow with: pipeline logs ${runStoreRunId} --follow`);
    return;
  }

  // Non-detach: `pipeline run <N>` ≡ `pipeline <N>`. Resolve config and advance.
  let cfg: PipelineConfig;
  try {
    cfg = resolveConfig({
      repoPath: opts.repoPath,
      domainOverride: opts.domain,
      baseBranch: opts.base,
      profile: opts.profile,
    });
  } catch (err) {
    console.error(`pipeline run: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  await runAdvance(cfg, number, toAdvanceOpts(opts));
}

// ---------------------------------------------------------------------------
// `pipeline path [--json]` subcommand handler
// ---------------------------------------------------------------------------

/** IO seam for tests — override discoverHosts. */
export interface PathSubcommandDeps {
  discoverHosts: typeof discoverHosts;
}
const defaultPathSubcommandDeps: PathSubcommandDeps = { discoverHosts };

export async function handlePathSubcommand(
  opts: CliOpts,
  deps: PathSubcommandDeps = defaultPathSubcommandDeps,
): Promise<void> {
  let result: Awaited<ReturnType<typeof discoverHosts>>;
  try {
    result = await deps.discoverHosts();
  } catch (err) {
    console.error(`pipeline path: probe error: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(formatDiscovery(result, !!opts.json));
}

/**
 * `pipeline controls check` — read-only repository-control drift compare (#695).
 * Loads desired state from config, fetches live state via injectable gh reads,
 * prints human or JSON results. Never mutates forge settings.
 */
export async function handleControlsCommand(
  args: string[],
  opts: CliOpts,
): Promise<void> {
  const sub = args[0] ?? "check";
  if (sub !== "check") {
    console.error(
      `pipeline controls: unknown subcommand "${sub}".\n` +
        `  Usage: pipeline controls check [--json] [--strict]`,
    );
    process.exit(2);
  }
  const { resolveConfig } = await import("./config.ts");
  const { runControlsCheck, formatControlsCheckHuman } = await import("./repository-control-drift.ts");
  const { stagedPoliciesFromDecls } = await import("./stage-policy-lifecycle.ts");
  const { ghRunForTest } = await import("./gh.ts");

  let cfg: PipelineConfig;
  try {
    cfg = resolveConfig({
      repoPath: opts.repoPath,
      baseBranch: opts.base,
      profile: opts.profile,
    });
  } catch (err) {
    console.error(`pipeline controls: config error: ${(err as Error).message}`);
    process.exit(2);
    return;
  }

  const desired = cfg.repository_control_desired_state ?? null;
  // Config load already rejects bare enforcing; materialize still validates lineage.
  const staged = stagedPoliciesFromDecls(cfg.staged_policies);
  const lifecycle =
    desired?.policy_id != null
      ? staged.find((p) => p.policy_id === desired.policy_id)?.state ?? null
      : null;

  const out = await runControlsCheck(
    {
      desired,
      lifecycle_state: lifecycle,
      staged_policies: staged,
      strict: !!opts.strict,
      json: !!opts.json,
    },
    {
      ghRun: (args, runOpts) => ghRunForTest(args, runOpts),
    },
  );

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(formatControlsCheckHuman(out));
  }
  process.exit(out.exit_code);
}

// ---------------------------------------------------------------------------
// Unblock mode
// ---------------------------------------------------------------------------

async function runJsonIssue(repoDir: string, runId: string, deps: RunStoreDeps): Promise<number | null> {
  try {
    const raw = await deps.readFile(path.join(runDirPath(repoDir, runId), "run.json"));
    const parsed = JSON.parse(raw) as { issue?: unknown };
    return typeof parsed.issue === "number" && Number.isFinite(parsed.issue) ? parsed.issue : null;
  } catch {
    return null;
  }
}

async function findBlockerClearedRunId(
  repoDir: string,
  issueNumber: number,
  originalNumber: number | undefined = issueNumber,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<string | null> {
  const allIds = await listRunIds(repoDir, deps).catch(() => [] as string[]);
  const prefixNumbers = [originalNumber, issueNumber].filter(
    (n, idx, arr): n is number =>
      typeof n === "number" && Number.isFinite(n) && n > 0 && arr.indexOf(n) === idx,
  );
  for (const n of prefixNumbers) {
    const id = allIds.find((runId) => runId.startsWith(`${n}-`));
    if (id) return id;
  }
  for (const id of allIds) {
    if (await runJsonIssue(repoDir, id, deps) === issueNumber) return id;
  }
  return null;
}

/** Append a blocker_cleared event to the most relevant run directory.
 *  Best-effort: silently skips if no run directory is found. */
async function appendBlockerCleared(
  repoDir: string,
  issueNumber: number,
  originalNumber: number | undefined = issueNumber,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const id = await findBlockerClearedRunId(repoDir, issueNumber, originalNumber, deps);
  if (!id) return;
  await appendEvent(
    runDirPath(repoDir, id),
    { schema_version: RUN_SCHEMA_VERSION, type: "blocker_cleared", at: evidenceTimestamp() },
    deps,
  ).catch(() => {});
}

/**
 * Build the "## Pipeline: Unblocked" comment body, attested via the generic
 * `pipeline-attest` marker (#484). Pure + exported so the PIPELINE_COMMENT_KINDS
 * drift guard exercises the real renderer, and so a verified, trusted-actor
 * instance of this comment can act as an operator-surface acknowledgement
 * anchor in `findUnacknowledgedComments` regardless of the operator's verbatim
 * answer text (e.g. "don't retry — batch it instead").
 */
export function buildUnblockedComment(args: {
  stage: string;
  ts: string;
  answer: string;
}): string {
  const rendered = [
    "## Pipeline: Unblocked",
    "",
    `**Stage**: ${args.stage}`,
    `**Unblocked at**: ${args.ts}`,
    "",
    "### Human input",
    args.answer,
    "",
    "---",
    "*Automated by Claude Code Pipeline Skill*",
  ].join("\n");
  return attestPipelineComment("unblocked", rendered);
}

/** IO seam for {@link runUnblock} so unit tests inject fakes — no real gh. */
export interface RunUnblockDeps {
  getIssueDetail: typeof getIssueDetail;
  postComment: typeof postComment;
  clearBlocked: typeof clearBlocked;
  isKillSwitchActive?: (domain: string) => boolean;
  getGhActor?: typeof getGhActor;
  getCandidateSha?: (cfg: PipelineConfig, issueNumber: number) => Promise<string | null>;
  fulfillTypedRequest?: typeof fulfillTypedRequestAndValidateResume;
  reportObservation?: ReportOperationObservation;
}

const defaultRunUnblockDeps: RunUnblockDeps = {
  getIssueDetail,
  postComment,
  clearBlocked,
};

async function runUnblock(
  cfg: PipelineConfig,
  issueNumber: number,
  answer: string,
  originalNumber: number = issueNumber,
  runStoreDeps: RunStoreDeps = defaultRunStoreDeps,
  deps: RunUnblockDeps = defaultRunUnblockDeps,
): Promise<void> {
  const killSwitch = deps.isKillSwitchActive ?? ((domain: string) => isKillSwitchActive(domain));
  if (killSwitch(cfg.domain)) {
    console.error(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    return;
  }
  const detail = await deps.getIssueDetail(cfg, issueNumber);
  if (!isBlocked(detail.labels)) {
    console.log(`#${issueNumber}: not blocked — nothing to do.`);
    return;
  }
  const stage = pickStage(detail.labels) ?? "(unknown)";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const body = buildUnblockedComment({ stage, ts, answer });
  const actor = (await (deps.getGhActor ?? getGhActor)()) ?? "operator";
  const candidateSha = deps.getCandidateSha
    ? await deps.getCandidateSha(cfg, issueNumber)
    : null;
  const fulfill = deps.fulfillTypedRequest ?? fulfillTypedRequestAndValidateResume;
  const typed = await fulfill({
    repoDir: cfg.repo_dir,
    issueNumber,
    answer,
    actor,
    candidateSha,
    resumeTarget: "override-or-unblock",
    blockedStage: stage,
  });
  if (!typed.resume.ok) {
    console.error(
      `[pipeline] #${issueNumber}: typed-request resume refused (${typed.resume.code}): ${typed.resume.reason}`,
    );
    process.exitCode = 1;
    return;
  }
  await deps.postComment(cfg, issueNumber, body);
  await deps.clearBlocked(cfg, issueNumber);
  await appendBlockerCleared(cfg.repo_dir, issueNumber, originalNumber, runStoreDeps);
  const unblockLine = `[pipeline] #${issueNumber}: unblocked at ${stage}`;
  console.log(unblockLine);

  // #499: the label clear above just succeeded (a throw would have aborted
  // before this point), so the unblock is durably accepted — emit exactly one
  // correction_event. Non-fatal and best-effort: no run directory for this
  // issue (e.g. a very old/foreign run) silently skips emission.
  const unblockRunDir = await latestRunDirForIssue(cfg.repo_dir, originalNumber, runStoreDeps).catch(() => null);
  if (unblockRunDir) {
    await emitCorrectionEvent(unblockRunDir, {
      issue: originalNumber,
      repo: cfg.repo,
      run_id: path.basename(unblockRunDir),
      stage,
      source_kind: "unblock",
      failure_class: "blocker",
      evidence_ref: { kind: "blocker", id: stage },
      correction: answer,
      reusable: "unknown",
    }, runStoreDeps).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Override mode (#17): disposition a review finding so it no longer blocks,
// then auto-resume the advance loop (#135).
// ---------------------------------------------------------------------------

/** IO seam for {@link runOverride} so unit tests inject fakes — no real gh. */
export interface RunOverrideDeps {
  getIssueDetail: typeof getIssueDetail;
  postComment: typeof postComment;
  clearBlocked: typeof clearBlocked;
  silentTransition: typeof silentTransition;
  /** The advance loop re-entered after the disposition is recorded (#135). */
  runAdvance: typeof runAdvance;
  /** Authenticated actor for governed override authority (#693). */
  getGhActor?: typeof getGhActor;
  /** Injectable clock for expiry fields (#693). */
  now?: () => Date;
  isKillSwitchActive?: (domain: string) => boolean;
  getCandidateSha?: (cfg: PipelineConfig, issueNumber: number) => Promise<string | null>;
  fulfillTypedRequest?: typeof fulfillTypedRequestAndValidateResume;
  reportObservation?: ReportOperationObservation;
}

const defaultRunOverrideDeps: RunOverrideDeps = {
  getIssueDetail,
  postComment,
  clearBlocked,
  silentTransition,
  runAdvance,
  getGhActor,
};

export async function runOverride(
  cfg: PipelineConfig,
  issueNumber: number,
  spec: string,
  opts: CliOpts,
  deps: RunOverrideDeps = defaultRunOverrideDeps,
  originalNumber: number = issueNumber,
  runStoreDeps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  // --dry-run is incompatible: --override always records an audited disposition
  // (postComment, clearBlocked, silentTransition).  Allowing the combination would
  // silently mutate label state under the mode advertised as "no GitHub writes".
  if (opts.dryRun) {
    console.error(
      "pipeline: --override cannot be combined with --dry-run — --override always records an audited disposition.",
    );
    process.exitCode = 2;
    return;
  }

  const killSwitch = deps.isKillSwitchActive ?? isKillSwitchActive;
  if (killSwitch(cfg.domain)) {
    console.error(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    return;
  }

  const governance = cfg.override_governance ?? implicitOverrideGovernance();
  const knownClasses = Object.keys(governance.classes);
  const parsed = parseOverrideArg(spec, knownClasses);
  if ("error" in parsed) {
    console.error(`pipeline: ${parsed.error}`);
    process.exit(2);
  }

  const getActor = deps.getGhActor ?? getGhActor;
  const actor = await getActor();
  const identitySource = "gh_actor";
  const createdAt = (deps.now ?? (() => new Date))()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const validated = await validateOverrideRecord({
    governance,
    classId: parsed.classId,
    actor,
    identitySource,
    explanation: parsed.reason,
    trustedAllowlist: cfg.trusted_override_actors,
  });

  const overrideRunDirEarly = await latestRunDirForIssue(
    cfg.repo_dir,
    originalNumber,
    runStoreDeps,
  ).catch(() => null);

  if (!validated.ok) {
    // Refuse path: no post, no label flip, clear error + rejected event (#693).
    if (overrideRunDirEarly) {
      await appendEvent(
        overrideRunDirEarly,
        {
          schema_version: RUN_SCHEMA_VERSION,
          ...buildOverrideEvent("override_rejected", {
            class: parsed.classId,
            actor,
            target:
              parsed.kind === "key"
                ? { kind: "key", key: parsed.key }
                : {
                    kind: "scope",
                    scopeType: parsed.scopeType,
                    scopeValue: parsed.scopeValue,
                  },
            lifecycle: "rejected",
            reason: validated.message,
            at: createdAt,
          }),
        },
        runStoreDeps,
      ).catch(() => {});
      const stateDir = path.dirname(overrideRunDirEarly);
      await recordOverride(stateDir, originalNumber, {
        key:
          parsed.kind === "key"
            ? parsed.key
            : `${parsed.scopeType}:${parsed.scopeValue}`,
        reason: parsed.reason,
        kind: "human-risk-override",
        class: parsed.classId,
        lifecycle: "rejected",
        actor: actor ?? undefined,
        created_at: createdAt,
        authorization_summary: validated.refusal,
      }).catch(() => {});
    }
    console.error(`pipeline: override refused (${validated.refusal}): ${validated.message}`);
    process.exitCode = 2;
    return;
  }

  const detail = await deps.getIssueDetail(cfg, issueNumber);
  const stage = pickStage(detail.labels) ?? "(unknown)";
  const ts = createdAt;

  const target =
    parsed.kind === "key"
      ? ({ kind: "key" as const, key: parsed.key })
      : ({
          kind: "scope" as const,
          scopeType: parsed.scopeType,
          scopeValue: parsed.scopeValue,
        });

  // Fingerprint/region/subject: optional at CLI record time when no live
  // finding objects are available; extractors treat missing subject as
  // legacy_unbound for low-risk compatibility. Validity still enforces
  // expiry and authorization.
  const decision = buildOverrideDecision({
    classId: validated.classId,
    disposition: parsed.disposition,
    target,
    explanation: validated.explanation,
    actor: actor!,
    identitySource,
    authorization: validated.authorization,
    evidenceRefs: validated.evidenceRefs,
    findingFingerprint: null,
    codeRegion: null,
    createdAt: ts,
    maxDurationHours: validated.classPolicy.max_duration_hours,
  });
  const gov = govPayloadFromDecision(decision);

  // Branch on kind: scope dispositions use a distinct sentinel so extractScopedOverrides
  // can read them back; key dispositions keep the existing pipeline-override sentinel.
  let body: string;
  let overrideLogMsg: string;
  if (parsed.kind === "scope") {
    body = scopedOverrideComment({
      scopeType: parsed.scopeType,
      scopeValue: parsed.scopeValue,
      disposition: parsed.disposition,
      reason: validated.explanation,
      stage,
      timestamp: ts,
      footer: cfg.marker_footer,
      gov,
    });
    overrideLogMsg =
      `recorded scoped override for ${parsed.scopeType}:${parsed.scopeValue} ` +
      `(${parsed.disposition}, class=${validated.classId}, expires=${decision.expires_at}).`;
  } else {
    body = overrideComment({
      key: parsed.key,
      disposition: parsed.disposition,
      reason: validated.explanation,
      stage,
      timestamp: ts,
      footer: cfg.marker_footer,
      gov,
    });
    overrideLogMsg =
      `recorded override for finding ${parsed.key} ` +
      `(${parsed.disposition}, class=${validated.classId}, expires=${decision.expires_at}).`;
  }
  await deps.postComment(cfg, issueNumber, body);
  // If the item is blocked (e.g. a review round blocked on this finding), clear
  // the blocker so the resumed run can re-evaluate with the override applied.
  if (isBlocked(detail.labels)) {
    await deps.clearBlocked(cfg, issueNumber);
    await appendBlockerCleared(cfg.repo_dir, issueNumber, originalNumber, runStoreDeps);
  }
  console.log(`[pipeline] #${issueNumber}: ${overrideLogMsg}`);

  // #499: the disposition comment above just posted durably — the operator's
  // judgment (key/scope + disposition + reason) IS the accepted correction.
  // "rejected" is a rejection disposition; every other disposition (e.g.
  // "deferred-#N") is an override. Non-fatal/best-effort: no run directory for
  // this issue silently skips emission.
  const overrideRunDir = overrideRunDirEarly ??
    (await latestRunDirForIssue(cfg.repo_dir, originalNumber, runStoreDeps).catch(() => null));
  if (overrideRunDir) {
    const evidenceRefId = parsed.kind === "key" ? parsed.key : `${parsed.scopeType}:${parsed.scopeValue}`;
    // #499 finding 7971a697: stamp the SHA the overridden/rejected finding was
    // actually raised at (the originating round's comment), not left null —
    // only resolvable for a key-scoped disposition, since a scope override
    // isn't tied to one finding's round. Mirrors the same repair-path fix in
    // review-routing.ts: reuse extractBlockingKeysFromComment (the same
    // marker-or-legacy-fallback logic that identifies a repaired finding) and
    // extractReviewedSha (artifact-then-legacy-sentinel) rather than
    // reimplementing either.
    let overrideReviewedSha: string | null = null;
    if (parsed.kind === "key") {
      const roundComments = detail.comments.filter(
        (c) => c.body.startsWith(REVIEW_MARKER_PREFIX_R1) || c.body.startsWith(REVIEW_MARKER_PREFIX_R2),
      );
      for (let i = roundComments.length - 1; i >= 0; i--) {
        if (extractBlockingKeysFromComment(roundComments[i].body).has(parsed.key)) {
          overrideReviewedSha = extractReviewedSha([roundComments[i]])?.sha ?? null;
          break;
        }
      }
    }
    await emitCorrectionEvent(overrideRunDir, {
      issue: originalNumber,
      repo: cfg.repo,
      run_id: path.basename(overrideRunDir),
      stage,
      source_kind: parsed.disposition === "rejected" ? "rejection" : "override",
      failure_class: "review-finding",
      reviewed_sha: overrideReviewedSha,
      evidence_ref: { kind: "finding", id: evidenceRefId },
      correction: `${parsed.disposition}: ${validated.explanation}`,
      reusable: "unknown",
    }, runStoreDeps).catch(() => {});

    await appendEvent(
      overrideRunDir,
      {
        schema_version: RUN_SCHEMA_VERSION,
        ...buildOverrideEvent("override_recorded", {
          decision_id: decision.decision_id,
          class: decision.class,
          actor: decision.actor,
          target: decision.target,
          lifecycle: "active",
          expires_at: decision.expires_at,
          created_at: decision.created_at,
          at: ts,
        }),
      },
      runStoreDeps,
    ).catch(() => {});

    const stateDir = path.dirname(overrideRunDir);
    await recordOverride(stateDir, originalNumber, {
      key: evidenceRefId,
      reason: validated.explanation,
      kind: "human-risk-override",
      class: decision.class,
      decision_id: decision.decision_id,
      lifecycle: "active",
      expires_at: decision.expires_at,
      created_at: decision.created_at,
      actor: decision.actor,
      authorization_summary: decision.authorization.evidence,
      supersedes: decision.supersedes,
      renewed_from: decision.renewed_from,
      renewal_kind: decision.renewal_kind,
      evidence_subject: decision.evidence_subject,
    }).catch(() => {});
  }

  // #135: the human's judgment WAS the key+reason — everything from here is
  // deterministic (the advance loop re-runs partitionFindings against the
  // sentinel just posted), so re-enter the loop instead of asking for a manual
  // re-run. From needs-human, first flip back to the review round recorded in
  // the ceiling comment — the same relabel the operator previously did by hand.
  // Fail-safe: remaining blockers re-park at needs-human; the resumed loop never
  // advances past an unresolved one, and still stops at ready-to-deploy.
  // #693: auto-resume only after a currently valid governed record (refuse path returned above).
  if (stage === "needs-human") {
    const ceiling = [...detail.comments]
      .reverse()
      .find((c) => c.body.startsWith(REVIEW_CEILING_MARKER));
    const round = ceiling ? ceilingRound(ceiling.body) : null;
    if (round === null) {
      console.error(
        `pipeline: #${issueNumber} is at needs-human but ` +
          (ceiling
            ? `the latest "${REVIEW_CEILING_MARKER.replace(/^## /, "")}" comment does not name the review round to resume. `
            : `no "${REVIEW_CEILING_MARKER.replace(/^## /, "")}" comment was found. `) +
          `The override is recorded; relabel \`pipeline:needs-human\` → \`pipeline:review-<round>\` and re-run to apply it.`,
      );
      process.exitCode = 1;
      return;
    }
    const to: Stage = round === 1 ? "review-1" : "review-2";
    await deps.silentTransition(cfg, issueNumber, "needs-human", to);
    console.log(
      `[pipeline] #${issueNumber}: needs-human → ${to} (resuming the round that hit the ceiling)`,
    );
  }

  const candidateSha = deps.getCandidateSha
    ? await deps.getCandidateSha(cfg, issueNumber)
    : null;
  const fulfill = deps.fulfillTypedRequest ?? fulfillTypedRequestAndValidateResume;
  const typed = await fulfill({
    repoDir: cfg.repo_dir,
    issueNumber,
    answer: validated.explanation,
    actor: actor ?? "operator",
    candidateSha,
    resumeTarget: "override-or-unblock",
    blockedStage: stage,
  });
  if (!typed.resume.ok) {
    console.error(
      `[pipeline] #${issueNumber}: typed-request resume refused (${typed.resume.code}): ${typed.resume.reason}`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await deps.runAdvance(cfg, issueNumber, toAdvanceOpts(opts));
  } catch (err) {
    reportMechanicalFault(deps.reportObservation, {
      operation: "override_resume",
      form_id: "override",
      message: (err as Error).message,
      fault: "mechanical",
    });
    console.error(`pipeline override: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Internal exports for tests (state-transition table tests).
// ---------------------------------------------------------------------------

// dispatch and realPlanningRecoveryDeps are imported from pipeline-run.ts above.
export const _internals = {
  dispatch,
  runInit,
  isAutoLoopRecoverable,
  isAutoLoopEligible,
  canAutoLoopContinue,
  realPlanningRecoveryDeps,
  appendBlockerCleared,
  findBlockerClearedRunId,
  runUnblock,
};

// Suppress unused import warnings for test-only helpers.
void addLabel;
