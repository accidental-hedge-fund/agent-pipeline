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
import { findWrapperPidForIssue, isCoexistenceFailureEvidence } from "./loop/live-advance.ts";
import { overrideComment, parseOverrideArg, scopedOverrideComment } from "./review-policy.ts";
import {
  attestPipelineComment,
  extractBlockingKeysFromComment,
  extractReviewedSha,
  REVIEW_MARKER_PREFIX_R1,
  REVIEW_MARKER_PREFIX_R2,
} from "./stages/review-parsing.ts";
import { makePipelineRunId } from "./traceability.ts";
import { branchName, getForIssue, getOnDiskForIssue, gitInWorktree, removeWorktreeForIssue, sweepMergedWorktrees } from "./worktree.ts";
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
  isValidSummaryBundle,
  latestRunDirForIssue,
  latestRunEventsSummaryForIssue,
  latestSummaryForIssue,
  listRunIds,
  runDirPath,
  runIdFor,
  runsDir,
  startTerminalLogTee,
  type RunEventsSummary,
  type RunStoreDeps,
  type TerminalLogTee,
} from "./run-store.ts";
import { runRelease } from "./stages/release.ts";
import { runIntake, realIntakeDeps } from "./stages/intake.ts";
import { runRefineSpec, realRefineSpecDeps } from "./stages/refine-spec.ts";
import {
  recordPapercut,
  reportPapercuts,
  papercutsEnabled,
  realPapercutDeps,
  autoFileDurableRunBlockers,
  realAutoFileDeps,
} from "./stages/papercut.ts";
import { runSweep, realSweepDeps } from "./stages/sweep.ts";
import { runTriage, realTriageDeps, validateTriageInput } from "./stages/triage.ts";
import { mergePr, realMergeDeps } from "./stages/merge.ts";
import { runMergeQueue, realMergeQueueDeps } from "./stages/merge-queue.ts";
import * as planningStage from "./stages/planning.ts";
import * as reviewStage from "./stages/review.ts";
import * as fixStage from "./stages/fix.ts";
import * as preMergeStage from "./stages/pre_merge.ts";
import * as evalStage from "./stages/eval.ts";
import * as shipchecKStage from "./stages/shipcheck.ts";
import * as deployReady from "./stages/deploy_ready.ts";
import * as autoRecover from "./stages/auto_recover.ts";
import { emitHumanIntervention, blockerKindToInterventionKind } from "./intervention.ts";
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
import { compileContractItems, type RawContractItem } from "./loop/dependencies.ts";
import {
  discoverDeclaredDependencies,
  extractRoadmapDeclaredEdges,
  realWorkListDependencyDiscoverDeps,
  type RoadmapDeclaredEdge,
  type WorkListDependencyDiscoverDeps,
} from "./loop/work-list-deps.ts";
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
import { buildStatusPayload, type StatusPayload } from "./status-json.ts";
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
import { lookupCommand, validateFlags } from "./command-registry.ts";
import {
  dispatch,
  isAutoLoopRecoverable,
  isAutoLoopEligible,
  canAutoLoopContinue,
  runAdvance,
  realPlanningRecoveryDeps,
  type AdvanceDeps,
  type PlanningRecoveryDeps,
} from "./pipeline-run.ts";

// Re-export for backward compatibility with existing import paths.
export { isAutoLoopRecoverable, isAutoLoopEligible, canAutoLoopContinue };
export type { AdvanceDeps, PlanningRecoveryDeps };

// Package version, single-sourced from package.json so a version bump is reflected
// automatically. The path is `../package.json` (core/package.json) and is mirror-safe:
// build.mjs copies `package.json` alongside `scripts/` into the generated plugin, so the
// same relative path resolves in both the dev and installed layouts.
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
  /** Emit machine-readable JSON (for --status, the doctor command, `pipeline path`, and `pipeline config validate/sync`). */
  json?: boolean;
  /** Doctor: silent exit-0/1 polling gate; no output. Mutually exclusive with --json. */
  isOk?: boolean;
  /** Release: skip opening $EDITOR for ROADMAP review (commit scaffolded ROADMAP as-is).
   *  Commander's `--no-edit` sets `edit: false` here. */
  edit?: boolean;
  /**
   * factory-gate: post-pass pack auto-close (#754). Default true.
   * Commander's `--no-close-pack` sets `closePack: false`.
   */
  closePack?: boolean;
  /** Intake: short free-text description to spec into a GitHub issue. */
  description?: string;
  /** refine-spec: existing issue title to refine. */
  title?: string;
  /** refine-spec: existing issue body to refine. */
  body?: string;
  /** Intake/release: pin the target release slot (e.g. "v1.6.0" or "1.6.0"). */
  release?: string;
  /** release: theme for a scaffolded release-plan row when missing (#730). */
  theme?: string;
  /** Roadmap/sweep: gate GitHub write-backs (comments, PRs); default is dry-run. */
  apply?: boolean;
  /** Roadmap: emit top-N dependency-safe issues from an existing plan.json. */
  next?: number;
  /** Sweep: override the target GitHub repository (owner/repo). */
  repo?: string;
  /** Triage: target pre-pipeline stage label (ready or backlog). */
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
  /** factory-gate: durable loop run id to score (#723). */
  fromRun?: string;
  /** scoreboard: restrict analysis to runs on or before this ISO date. */
  until?: string;
  /** scoreboard: use a relative N-day window. */
  days?: number;
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
  /** queue / merge-queue: filter eligible issues to those belonging to this milestone title. */
  milestone?: string;
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
 * (#554). Other commands keep their pre-existing caps.
 */
export function maxPositionalsFor(command: string | undefined): number {
  if (
    command === "run" ||
    command === "single" ||
    command === "release" ||
    command === "intake" ||
    command === "triage" ||
    command === "merge" ||
    command === "merge-queue" ||
    command === "status" ||
    command === "papercut" ||
    command === "correction"
  ) {
    return 2;
  }
  if (command === "unblock" || command === "override" || command === "evals") {
    return 3;
  }
  // loop keyword + up to MAX_RANGE_SPAN issue numbers (same ceiling as --range).
  if (command === "loop") {
    return 1 + MAX_RANGE_SPAN;
  }
  return 1; // refine-spec and plain advance take only the keyword / issue number
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
    .argument("[number]", "issue or PR number (required unless --cleanup or --remove-worktree), or a subcommand: init | doctor | status | unblock | override | cleanup | logs | path | config | run | single | release | factory-gate | intake | triage | roadmap | sweep | merge | merge-queue | summary | improve | scoreboard | queue | backfill | evals | loop | correction | report")
    .option("--cleanup", "sweep pipeline-managed worktrees whose PR is merged and exit")
    .option("--init", "ensure pipeline labels and scaffold .github/pipeline.yml (no issue number required)")
    .option("--doctor", "run the deterministic preflight checks before advancing; abort the run on any failure")
    .option("--fail-fast", "doctor: stop at the first failing check instead of collecting all failures")
    .option("--is-ok", "doctor: silent exit-0/1 gate (no output); mutually exclusive with --json")
    .option("--status", "read-only status; print stage and exit")
    .option("--json", "emit machine-readable JSON (for --status or the doctor command)")
    .option("--summary", "print the human-readable evidence-bundle summary for <number> and exit")
    .option("--unblock <answer>", "post answer as a comment and clear the blocked label")
    .option(
      "--override <spec>",
      'disposition a review finding so it no longer blocks, then auto-resume the advance loop: "<override-key>: <reason>" (key from the review comment; reason may lead with "rejected" or "deferred #N")',
    )
    .option("--once", "advance one stage and stop")
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
      "release: theme for a scaffolded release-plan row when missing (overrides milestone title; default: plan-row theme, milestone title, or <theme>)",
    )
    .option("--description <text>", "intake: short free-text description to spec into a GitHub issue")
    .option("--title <text>", "refine-spec: existing issue title to refine")
    .option("--body <markdown>", "refine-spec: existing issue body to refine")
    .option("--release <version>", "intake/release: pin the target release slot (e.g. v1.6.0)")
    .option("--apply", "roadmap/sweep/backfill/improve/config sync: execute write-backs; default is dry-run/preview")
    .option("--next <n>", "roadmap: emit top-N dependency-safe issues from existing plan.json without re-running the engine", Number)
    .option("--repo <owner/repo>", "sweep/backfill: override the target GitHub repository (default: current repo from gh config)")
    .option("--stage <stage>", "triage: target pre-pipeline stage label (ready or backlog)")
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
    .option("--for <version>", "factory-gate: target release version X.Y.Z (required)", undefined)
    .option("--from-run <run-id>", "factory-gate: score an existing durable loop run id")
    .option(
      "--no-close-pack",
      "factory-gate: skip auto-close of synthetic pack PRs/issues after a release-eligible pass",
    )
    .option("--since <date>", "improve/scoreboard: restrict analysis to runs on or after this ISO date (e.g. 2026-06-01)")
    .option("--until <date>", "scoreboard: restrict analysis to runs on or before this ISO date (e.g. 2026-06-15)")
    .option("--days <n>", "scoreboard: analyze the last N days (default: 30)", Number)
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
    .option("--milestone <M>", "queue / merge-queue / loop: filter issues to this milestone title")
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
    .option("--issue <n>", "correction record: issue number to record the correction against", Number)
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

/** Derives a deterministic run id for an explicit issue-number selector
 *  (`--range` or a bare issue list) — the only selector the in-repo compiler
 *  below resolves without a GitHub query. Stable across repeated invocations
 *  of the same list so a second `pipeline loop 100 101` naturally resumes the
 *  same run instead of creating a duplicate. */
export function workListRunId(repo: string, engine: LoopEngine, issues: readonly string[]): string {
  const hash = crypto.createHash("sha256").update(`${repo}:${engine}:${issues.join(",")}`).digest("hex").slice(0, 16);
  return `loop-${hash}`;
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
): { contract: import("./loop/recovery.ts").LoopContractInit; ledger: LoopLedger } {
  const contract: import("./loop/recovery.ts").LoopContractInit = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: runId,
    engine,
    repo: { name: cfg.repo, base_branch: cfg.base_branch },
    selector: { type: "work-list", value: issues },
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
 */
export async function compileWorkListRunFresh(
  cfg: PipelineConfig,
  engine: LoopEngine,
  issues: readonly string[],
  runId: string,
  discoverDeps: WorkListDependencyDiscoverDeps = realWorkListDependencyDiscoverDeps(cfg),
): Promise<{ contract: import("./loop/recovery.ts").LoopContractInit; ledger: LoopLedger }> {
  const rawItems = await discoverDeclaredDependencies(issues, discoverDeps);
  return compileWorkListRun(cfg, engine, issues, runId, rawItems);
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
  opts?: { runId?: string },
): string[] {
  const args = [scriptPath, String(issueNumber), "--profile", engine, "--repo-path", repoDir];
  if (opts?.runId) args.push("--run-id", opts.runId);
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
          dispatchItemChildArgs(scriptPath, issueNumber, engine, cfg.repo_dir, pin ? { runId: pin.pipeline_run_id } : undefined),
          { stdio: "inherit" },
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
      if (pin && storeReady) {
        eventsTextForClassify = readEventsTextFn(pin.events_path);
      }
      let resolution = lastStageDiagnosticFromEventsJsonl(eventsTextForClassify ?? "");
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

  const failed = (error: string): RepairPipelineItemResult => ({
    succeeded: false,
    evidence: error,
    error,
  });

  const resyncMechanicalBlock = async (
    input: ExecuteRecoveryInput,
  ): Promise<RepairPipelineItemResult> => {
    const issueNumber = Number(input.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      return failed(`recovery action ${input.action} requires a positive numeric item id`);
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
      evidence: `recovery action ${input.action} cleared the mechanical blocked state and verified normal whole-item redispatch is admissible`,
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
    const matches = issues
      .filter((i) => (selector.type === "milestone" ? i.milestone === selector.value : i.labels.includes(selector.value)))
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
  return {
    issues: matches.map(String),
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
  selector?: LoopSelector;
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
            compiled = await compileWorkListRunFresh(cfg, input.engine, issues, newRunId, discoverDeps);
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
          compiled = await compileWorkListRunFresh(cfg, input.engine, issues, runId, discoverDeps);
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
    // Host-local live-advance probe scope (#770): run-store discovery + domain
    // + production wrapper/process identity under ~/.pipeline/runs/<issue>
    // (#770 review 2 finding 956d20df).
    repoDir: cfg.repo_dir,
    lockDomain: cfg.domain,
    findWrapperPid: (issueNumber) => findWrapperPidForIssue(issueNumber),
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
    const result = await driveSupervisor(supervisorDeps, {
      runId,
      engine: input.engine as LoopEngineName,
      resume: !!input.resumeRunId || resumeExisting,
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
): number {
  const outstandingReady = result.stop?.outstanding_ready ?? [];
  if (outstandingReady.length > 0) {
    console.error(
      `${commandLabel}: stopped with ${outstandingReady.length} item(s) stranded at ready-to-deploy, awaiting human merge: ${outstandingReady.join(", ")}`,
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

/** Canonical one-item autonomous drive. The stage machine still performs every
 * normal transition; this facade supplies the same durable supervisor and
 * recovery controller used by `pipeline loop` without requiring an outer
 * multi-item `/goal` bootstrap. */
export async function runSingleIssueCommand(
  rawNumber: string | undefined,
  opts: CliOpts,
  deps: SingleIssueCommandDeps = defaultSingleIssueCommandDeps,
): Promise<void> {
  const parsed = Number.parseInt(rawNumber ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== rawNumber) {
    console.error("pipeline single: <number> is required and must be a positive integer");
    process.exitCode = 2;
    return;
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
    return;
  }

  let issueNumber: number;
  try {
    issueNumber = await deps.resolveIssueNumber(cfg, parsed);
  } catch (err) {
    console.error(`pipeline single: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const engine: LoopEngine = opts.profile === "claude" ? "claude" : "codex";
  const engineResult = await deps.runLoopEngine({
    engine,
    selector: { type: "work-list", value: [String(issueNumber)] },
    audit: false,
    autoSupersedeTerminal: true,
    repoDir: cfg.repo_dir,
    onRunReady: async (ctx) => {
      await deps.writeStdoutLine(formatLoopRunHandoff({ ...ctx, selector: { type: "work-list", value: [String(issueNumber)] } }));
      console.error(`pipeline single: run ready ${ctx.runId}; events ${ctx.events}`);
    },
  });
  if (engineResult.kind === "error") {
    console.error(`pipeline single: ${engineResult.message}`);
    process.exitCode = 1;
    return;
  }
  if (engineResult.kind !== "drive") {
    console.error("pipeline single: internal error: one-item drive returned an audit result");
    process.exitCode = 1;
    return;
  }
  process.exitCode = renderLoopDriveResult(engine, engineResult.result, "pipeline single");
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
  if (rawArgs[0] === "refine-spec" && (rawArgs.includes("--help") || rawArgs.includes("-h"))) {
    process.stdout.write(
      'Usage: pipeline refine-spec --title "<title>" --body "<markdown>" [--json]\n\n' +
      "Non-mutating spec refinement: given an existing issue title and body,\n" +
      "runs a single model harness call and emits a JSON object to stdout.\n\n" +
      "Options:\n" +
      "  --title <text>      existing issue title to refine (required)\n" +
      "  --body <markdown>   existing issue body to refine (required)\n" +
      "  --json              accepted; output is always JSON (no-op)\n" +
      "  --repo-path <path>  override the target repo working tree\n\n" +
      'Output: { "title": string, "body": string, "milestone": string|null }\n' +
      "Exit code: 0 on success, non-zero on harness failure or missing --title/--body.\n",
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
      "Dogfood-day query (one-day class breakdown as JSON):\n" +
      "  pipeline scoreboard --days 1 --json\n" +
      "  # → .metrics.pre_merge_needs_human  (rate + by_class)\n\n" +
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
  // `pipeline intake [--description "<text>"] [--release vX.Y.Z]` — no issue number.
  const isIntakeCommand = numArg === "intake";
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
  // `pipeline loop ...` (#451) — deterministic preflight + delegation to goal-loop.
  // Needs no PipelineConfig and calls no gh at all (see command-registry.ts).
  const isLoopCommand = numArg === "loop";
  // `pipeline single <N>` — canonical durable one-item autonomous drive.
  const isSingleCommand = numArg === "single";
  // `pipeline refine-spec --title "<t>" --body "<b>"` — non-mutating spec refinement preview.
  const isRefineSpecCommand = numArg === "refine-spec";

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

  // `pipeline summary <run-id>` — exact-selection form: print summary.json from a
  // specific run directory without requiring domain config or an issue number (#261).
  // Dispatched early (before config/gh resolution) like `logs`, since it is
  // domain-independent and must work offline.
  if (numArg === "summary") {
    const summaryStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(summaryStart) ?? summaryStart;
    const summaryRunId = cmd.args[1];
    if (!summaryRunId) {
      console.error(
        "pipeline summary: a run-id argument is required.\n" +
          "  Usage: pipeline summary <run-id>\n" +
          "  Example: pipeline summary 147-2026-06-20T10-00-00-000Z\n" +
          "  Tip:    pipeline logs   (lists available run-ids)",
      );
      process.exit(2);
    }
    await runSummaryByRunId(repoDir, summaryRunId);
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
  // `pipeline path --json`, `pipeline config validate/sync --json`, `pipeline refine-spec --json`,
  // `pipeline improve --json`, `pipeline scoreboard --json`, `pipeline status <N> --json`, and
  // `--remove-worktree --json` legitimately emit JSON — exempt from the status-only guard.
  if (opts.json && !isDoctorCommand && !opts.status && !opts.removeWorktree && numArg !== "path" && numArg !== "config" && numArg !== "refine-spec" && numArg !== "improve" && numArg !== "scoreboard" && numArg !== "status" && numArg !== "papercut" && numArg !== "factory-gate") {
    console.error("pipeline: --json requires --status or the doctor command. Usage: pipeline <N> --status --json  OR  pipeline doctor --json");
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
  // Validate the release version argument early (before config resolution) so a
  // malformed invocation fails cleanly without requiring gh auth or a valid config.
  if (isReleaseCommand) {
    const versionArgEarly = cmd.args[1];
    if (!versionArgEarly) {
      console.error(
        "pipeline release: a version argument is required.\n" +
          "  Usage: pipeline release <X.Y.Z | major | minor | patch> [--theme \"...\"] [--dry-run] [--no-edit]\n" +
          "  Example: pipeline release 1.6.0  OR  pipeline release minor\n" +
          "  Unshipped release-plan row shape (auto-scaffolded when missing if `| *(none)* |` is present):\n" +
          "    | **vX.Y.Z** | major|minor|patch | <theme> | #N, #M | <why> |\n" +
          "  Columns: Release | Bump | Theme | Issues | Why this bump. Shipped rows use `✅ shipped` and are never overwritten.\n" +
          "  If the plan row cannot be inserted, release fails before any version bump with a copy-pasteable row for ROADMAP.md.",
      );
      process.exit(2);
    }
    if (/^\d+$/.test(versionArgEarly)) {
      console.error(
        `pipeline release: "${versionArgEarly}" looks like an issue number, not a version.\n` +
          `  Provide a semver string (e.g., 1.6.0) or an alias (major, minor, patch).`,
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
  const maxPositionals = maxPositionalsFor(cmd.args[0]);
  if (cmd.args.length > maxPositionals) {
    const extra = cmd.args.slice(maxPositionals).join(", ");
    console.error(`pipeline: unexpected argument(s): ${extra}`);
    process.exit(2);
  }

  // Early release dispatch — derives repo_dir/base_branch from local git state
  // only; no `gh` call. This means dry-run and CI-failure paths never call any
  // GitHub API before runRelease itself gates on CI passing.
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
    const versionArg = cmd.args[1] as string;
    try {
      await runRelease(
        versionArg,
        {
          dryRun: opts.dryRun,
          noEdit: opts.edit === false,
          theme: typeof opts.theme === "string" ? opts.theme : undefined,
        },
        localCfg,
      );
    } catch (err) {
      console.error(`pipeline release: ${(err as Error).message}`);
      process.exit(1);
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

  // Early refine-spec dispatch — no issue number, no `gh` call. Still resolves
  // the implementer role locally (repo `harnesses:` block / profile, #608) so
  // the harness invocation below routes through the same role every other
  // implementer-role path uses — resolveReleaseConfig makes no network call.
  // Non-mutating: no GitHub writes, no git writes, no filesystem writes.
  if (isRefineSpecCommand) {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
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
    // #499 review-2 finding 34d10c78: the manual command is human-only —
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

  // `pipeline factory-gate --for <version> [--from-run <id>] [--json] [--no-close-pack]` (#723/#754).
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
          "  Usage: pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> [--json] [--no-close-pack]\n" +
          "  See docs/factory-reliability-gate-runbook.md",
      );
      process.exit(2);
    }
    const { runFactoryGate } = await import("./factory-reliability-gate.ts");
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
      const result = await runFactoryGate({
        version: versionArg,
        repoDir,
        fromRun: opts.fromRun,
        label: opts.label,
        milestone: opts.milestone,
        json: !!opts.json,
        noClosePack,
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
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    } catch (err) {
      console.error(`pipeline factory-gate: ${(err as Error).message}`);
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
      process.exit(1);
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
        realQueueDeps(queueCfg.repo_dir, opts.profile),
      );
    } catch (err) {
      console.error(`pipeline queue: ${(err as Error).message}`);
      process.exit(1);
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
      await runTriage({ issueArg: cmd.args[1], stage: opts.stage }, realTriageDeps(triageCfg));
    } catch (err) {
      console.error(`pipeline triage: ${(err as Error).message}`);
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
      await mergePr(prNumber, realMergeDeps(mergeCfg.repo));
    } catch (err) {
      console.error(`pipeline merge: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early merge-queue dispatch — human-gated sequential R2D merges + optional
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
        realMergeQueueDeps(mqCfg.repo_dir, mqCfg.repo),
      );
      if (result.exitCode !== 0) process.exit(result.exitCode);
    } catch (err) {
      console.error(`pipeline merge-queue: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Guard: reject unrecognized non-digit positional arguments before resolveConfig()
  // so the user sees a clear usage error rather than a gh auth/repo-discovery failure.
  if (numArg && !/^\d+$/.test(numArg)) {
    const recognized = [
      "init", "doctor", "status", "unblock", "override", "cleanup",
      "logs", "path", "config", "run", "single", "release", "intake", "refine-spec",
      "roadmap", "sweep", "triage", "merge", "merge-queue", "summary", "improve", "scoreboard", "factory-gate", "queue", "backfill", "evals",
      "loop",
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

  // Legacy `--cleanup` flag form — deprecated; use `pipeline cleanup` or
  // `/pipeline:cleanup` instead.
  if (opts.cleanup && isNumericOrAbsent) {
    process.stderr.write(
      "Deprecated: `pipeline --cleanup` is deprecated. Use `pipeline cleanup` or `/pipeline:cleanup` instead.\n",
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
    // Legacy `--init` flag form — deprecated; use `pipeline init` or `/pipeline:init` instead.
    if (opts.init && isNumericOrAbsent) {
      process.stderr.write(
        "Deprecated: `pipeline --init` is deprecated. Use `pipeline init` or `/pipeline:init` instead.\n",
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

  // Positional `pipeline override <N> "<spec>"` keyword dispatch.
  // Equivalent to the legacy `pipeline <N> --override "<spec>"`.
  if (numArg === "override") {
    const overrideNumStr = cmd.args[1];
    const overrideSpec = cmd.args[2];
    if (!overrideNumStr || !/^\d+$/.test(overrideNumStr)) {
      console.error(
        "pipeline override: an issue or PR number is required.\n" +
          '  Usage: pipeline override <N> "<key>: <reason>"\n' +
          '  Example: pipeline override 42 "abc123: deferred #99"',
      );
      process.exit(2);
    }
    if (overrideSpec === undefined) {
      console.error(
        "pipeline override: a spec string is required.\n" +
          '  Usage: pipeline override <N> "<key>: <reason>"\n' +
          '  Example: pipeline override 42 "abc123: deferred #99"',
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
      `Deprecated: \`pipeline ${number} --summary\` is deprecated. Use \`/pipeline:summary ${number}\` instead.\n`,
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
      `Deprecated: \`pipeline ${number} --status\` is deprecated. Use \`pipeline status ${number}\` or \`/pipeline:status\` instead.\n`,
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
      `Deprecated: \`pipeline ${number} --unblock\` is deprecated. Use \`pipeline unblock ${number} "<answer>"\` or \`/pipeline:unblock\` instead.\n`,
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
      `Deprecated: \`pipeline ${number} --override\` is deprecated. Use \`pipeline override ${number} "<spec>"\` or \`/pipeline:override\` instead.\n`,
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
    process.exit(1);
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

  await runAdvance(cfg, issueNumber, opts);
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
  const { created } = await scaffoldDefaultConfig(cfg.repo_dir);
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
    process.exitCode = result.ok ? 0 : 1;
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
}

const defaultPreflightCliDeps: PreflightCliDeps = { runPreflight, storePreflightResult };

/** `pipeline doctor`: run every preflight check, print the summary, persist the
 *  result for `--status`, and set the exit code (0 all-pass, 1 any failure).
 *  With `--json`: emit a single unfenced JSON object instead of prose.
 *  With `--is-ok`: emit zero output; exit 0/1 only (cheap polling gate).
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
      const failFast = opts.failFast ?? cfg.doctor.failFast;
      const result = await deps.runPreflight(cfg, undefined, { failFast }, VERSION);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
    return;
  }

  const failFast = opts.failFast ?? cfg.doctor.failFast;
  const result = await deps.runPreflight(cfg, undefined, { failFast }, VERSION);
  await deps.storePreflightResult(cfg, result);

  if (opts.json) {
    console.log(JSON.stringify(formatDoctorJson(result)));
  } else {
    console.log(formatDoctorSummary(result));
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

/** First line of the punch-list comment posted when a review round hits the
 *  round ceiling and parks the item at `needs-human` (emitted by review.ts's
 *  `reviewCeilingComment`). A controlled string the pipeline owns end-to-end. */
const REVIEW_CEILING_MARKER = "## Pipeline: Review ceiling reached";

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
}

const defaultRunStatusDeps: RunStatusDeps = {
  getIssueDetail,
  getPrForIssue,
  loadLatestPreflightResult,
  getForIssue: getOnDiskForIssue,
  getLabelEvents: getIssueLabelEvents,
  getLatestRunEvents: (cfg, issueNumber) => latestRunEventsSummaryForIssue(cfg.repo_dir, issueNumber),
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
      const payload: StatusPayload = buildStatusPayload(
        { ...detail, labelEvents },
        prNumber,
        worktreeInfo,
        cfg,
        runEvents,
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

/**
 * The review round recorded in a ceiling comment (#135) — the round `--override`
 * auto-resumes into. Reads the controlled `Review N re-ran …` line the pipeline
 * itself emits (review.ts's `reviewCeilingComment`). Line-anchored and
 * first-match-wins: the controlled line precedes any reviewer-authored finding
 * text, so injected content later in the body can never override it (the
 * e8b1f0b4 lesson — a whole-body `pipeline:review-N` regex matched finding
 * prose). Returns null when the line is absent.
 */
export function ceilingRound(body: string): 1 | 2 | null {
  const m = body.match(/^Review ([12]) re-ran /m);
  return m ? (Number(m[1]) as 1 | 2) : null;
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
}
const defaultRunSubcommandDeps: RunSubcommandDeps = { spawnDetached, findGitRoot, cwd: () => process.cwd() };

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
    if (opts.domain) passArgs.push("--domain", opts.domain);
    if (opts.model) passArgs.push("--model", opts.model);
    // Forward lifecycle / no-write semantics too. Omitting these silently broke
    // the contract for the highest-risk mode: `pipeline run <N> --detach --dry-run`
    // would otherwise start a REAL background advance that mutates GitHub/worktree
    // after the launcher exits. These boolean flags must reach the inner process
    // (or be rejected) so detached runs preserve dry-run/once/doctor semantics (#153).
    if (opts.dryRun) passArgs.push("--dry-run");
    if (opts.once) passArgs.push("--once");
    if (opts.doctor) passArgs.push("--doctor");
    if (opts.failFast) passArgs.push("--fail-fast");
    // Pin the inner run to the pre-allocated #155 run-store id, and forward
    // --json-events so the detached run's event stream and run directory are
    // discoverable via the documented contract rather than the wrapper artifacts (#155).
    passArgs.push("--run-id", runStoreRunId);
    if (opts.jsonEvents) passArgs.push("--json-events");

    let result: Awaited<ReturnType<typeof spawnDetached>>;
    try {
      result = await deps.spawnDetached(number, passArgs, {
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

  await runAdvance(cfg, number, opts);
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
  const detail = await deps.getIssueDetail(cfg, issueNumber);
  if (!isBlocked(detail.labels)) {
    console.log(`#${issueNumber}: not blocked — nothing to do.`);
    return;
  }
  const stage = pickStage(detail.labels) ?? "(unknown)";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const body = buildUnblockedComment({ stage, ts, answer });
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
}

const defaultRunOverrideDeps: RunOverrideDeps = {
  getIssueDetail,
  postComment,
  clearBlocked,
  silentTransition,
  runAdvance,
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
  const parsed = parseOverrideArg(spec);
  if ("error" in parsed) {
    console.error(`pipeline: ${parsed.error}`);
    process.exit(2);
  }
  const detail = await deps.getIssueDetail(cfg, issueNumber);
  const stage = pickStage(detail.labels) ?? "(unknown)";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  // Branch on kind: scope dispositions use a distinct sentinel so extractScopedOverrides
  // can read them back; key dispositions keep the existing pipeline-override sentinel.
  let body: string;
  let overrideLogMsg: string;
  if (parsed.kind === "scope") {
    body = scopedOverrideComment({
      scopeType: parsed.scopeType,
      scopeValue: parsed.scopeValue,
      disposition: parsed.disposition,
      reason: parsed.reason,
      stage,
      timestamp: ts,
      footer: cfg.marker_footer,
    });
    overrideLogMsg = `recorded scoped override for ${parsed.scopeType}:${parsed.scopeValue} (${parsed.disposition}).`;
  } else {
    body = overrideComment({
      key: parsed.key,
      disposition: parsed.disposition,
      reason: parsed.reason,
      stage,
      timestamp: ts,
      footer: cfg.marker_footer,
    });
    overrideLogMsg = `recorded override for finding ${parsed.key} (${parsed.disposition}).`;
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
  const overrideRunDir = await latestRunDirForIssue(cfg.repo_dir, originalNumber, runStoreDeps).catch(() => null);
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
      correction: `${parsed.disposition}: ${parsed.reason}`,
      reusable: "unknown",
    }, runStoreDeps).catch(() => {});
  }

  // #135: the human's judgment WAS the key+reason — everything from here is
  // deterministic (the advance loop re-runs partitionFindings against the
  // sentinel just posted), so re-enter the loop instead of asking for a manual
  // re-run. From needs-human, first flip back to the review round recorded in
  // the ceiling comment — the same relabel the operator previously did by hand.
  // Fail-safe: remaining blockers re-park at needs-human; the resumed loop never
  // advances past an unresolved one, and still stops at ready-to-deploy.
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
  await deps.runAdvance(cfg, issueNumber, opts);
}

/** ISO 8601 timestamp at seconds precision — local copy for appendBlockerCleared. */
function evidenceTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
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
