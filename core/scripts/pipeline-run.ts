// Advance-loop lifecycle service (#263).
//
// This module is intentionally free of Commander imports so it can be imported
// in test contexts and by other modules without triggering CLI initialization.
// The CLI (pipeline.ts) imports and calls runAdvance; it also re-exports the
// auto-loop helpers and AdvanceDeps so existing import paths continue to work.

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  GhMetricsCollector,
  buildAuditSentinel,
  clearBlocked,
  ensurePipelineLabels,
  getGhActor,
  getIssueDetail,
  getPrForIssue,
  isBlocked,
  pickStage,
  postComment,
  postPrComment,
  reconcileAuditComment,
  setBlocked,
  setGhCollector,
  setGhDiscoveryChannel,
  setGhRunId,
  transition,
} from "./gh.ts";
import {
  resolveDispatchDiscoveryChannel,
  runLevelDiscoveryChannel,
  type DiscoveryChannel,
} from "./engine-attribution.ts";
import {
  getOnDiskForIssue,
  gitInWorktree,
  branchName,
  releaseWorktreeForParkedIssue,
  type ParkReleaseDeps,
  type ParkReleaseResult,
} from "./worktree.ts";
import { withLock, runStateDir, isLivePlanningActive, tryAcquireLivePlanningMarker } from "./lock.ts";
import {
  bundlePath,
  createBundle,
  finalizeBundle,
  formatEvidenceCommentBody,
  markNotified,
  patchBundleIdentity,
  recordEngineDrift,
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
  resolveRunEngineIdentity,
  runDirPath,
  runIdFor,
  startTerminalLogTee,
  type RunStoreDeps,
  type BlockerSetEvent,
  type TerminalLogTee,
} from "./run-store.ts";
import { buildEventSinkDeps } from "./event-sink.ts";
import {
  isEngineDriftTransition,
  probeEngineIdentity,
  resolvePinnedEngineIdentity,
  type EngineIdentity,
} from "./engine-identity.ts";
import {
  engineTrackEvidenceFields,
  enforcePinnedTrackPolicy,
  hasProductionPinPathOverride,
  installReceiptPath,
  isFactoryControlRepo,
  PRODUCTION_ENGINE_PIN_REL,
  resolveEngineTrackIntent,
  resolveInstallProvenance,
  resolvePinAuthorityDir,
  resolveProductionPin,
  type EngineTrackIntent,
  type PinInstallProvenance,
  type PinLoadResult,
  type ResolvedEngineTrackIntent,
} from "./production-engine-pin.ts";
import type { RunEngineIdentity } from "./run-store.ts";
import * as fsp from "node:fs/promises";
import {
  OUTER_HOST_UNKNOWN,
  readOuterHostFromEnv,
  resolveOuterHostEvidence,
} from "./outer-hosts/evidence.ts";
import { makePipelineRunId } from "./traceability.ts";
import { parseOverrideArg } from "./review-policy.ts";
import { classifyProductFault, emitProductFault, resolveHostAdapter, resolveProductFaultConfig } from "./product-fault.ts";
import { emitHumanIntervention, blockerKindToInterventionKind } from "./intervention.ts";
import { toPreMergeOfframpClass } from "./pre-merge-offramp.ts";
import { buildStageDiagnostic, projectStageDiagnostic } from "./stage-diagnostic.ts";
import { autoFileCorrections, autoFilePapercuts, realAutoFileDeps } from "./stages/papercut.ts";
import * as planningStage from "./stages/planning.ts";
import * as reviewStage from "./stages/review.ts";
import * as fixStage from "./stages/fix.ts";
import * as preMergeStage from "./stages/pre_merge.ts";
import * as evalStage from "./stages/eval.ts";
import * as visualStage from "./stages/visual.ts";
import * as designGateStage from "./stages/design_gate.ts";
import * as shipchecKStage from "./stages/shipcheck.ts";
import * as deployReady from "./stages/deploy_ready.ts";
import * as autoRecover from "./stages/auto_recover.ts";
import {
  reviewStageSkipTarget,
  type BlockerKind,
  type EvidenceBundle,
  type Outcome,
  type PipelineConfig,
  type Stage,
  type StageOutcome,
} from "./types.ts";
import {
  REVIEW_CEILING_MARKER,
  ceilingRound,
  evidenceTimestamp,
} from "./advance-shared.ts";

/**
 * Thin options bag for the advance loop (#630). Owned outside the Commander
 * surface so pipeline-run.ts never type-imports fat CliOpts from pipeline.ts.
 * Field set is exactly what runAdvance / dispatch read today.
 */
export interface AdvanceOpts {
  dryRun?: boolean;
  model?: string;
  once?: boolean;
  override?: string;
  jsonEvents?: boolean;
  profile?: string;
  runId?: string;
  /**
   * Two-track engine intent (#762). When set, overrides config `engine_track`.
   * Factory control (agent-pipeline) defaults to pinned; ordinary non-factory
   * advances leave policy inactive unless this is set. Candidate is for
   * intentional FRG/eval soaks.
   */
  engineTrack?: "pinned" | "candidate";
  /**
   * Run-level discovery channel for this dispatch (#763). Validated against the
   * closed vocabulary. Ordinary advance omits this and stamps `live-run`.
   * Batch/manual entrypoints pass `review-batch` / `manual` so initRunDir and
   * setBlocked inherit the non-live channel. On resume, a persisted
   * `run.json.discovery_channel` wins over this field (written-once).
   */
  discoveryChannel?: DiscoveryChannel;
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildAuditRepairComment(stage: Stage, runId: string): string {
  return reviewStage.attestPipelineComment(
    "audit-repair",
    [
      `## Pipeline: Audit Repair`,
      ``,
      `The audit sentinel for stage \`${stage}\` was missing from the recent comment history. Posting retroactively.`,
      ``,
      buildAuditSentinel(runId, stage),
      ``,
      `---`,
      `*Automated by Claude Code Pipeline Skill*`,
    ].join("\n"),
  );
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildAuditRepairBlockedComment(runId: string): string {
  return reviewStage.attestPipelineComment(
    "audit-repair-blocked",
    [
      `## Pipeline: Blocked (audit repair)`,
      ``,
      `The audit sentinel for \`blocked\` state was missing from the recent comment history. Posting retroactively.`,
      ``,
      `> **Note**: The original block reason could not be recovered — the blocker comment was not recorded.`,
      ``,
      `### How to unblock`,
      `Remove the \`blocked\` label and re-apply the active stage label (e.g. \`pipeline:fix-1\`) to resume the pipeline.`,
      ``,
      buildAuditSentinel(runId, "blocked"),
      ``,
      `---`,
      `*Automated by Claude Code Pipeline Skill*`,
    ].join("\n"),
  );
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildAutoLoopContinuationComment(
  cfg: PipelineConfig,
  roundsSpent: number,
  stage: Stage,
  reason: string,
  roundsRemaining: number,
  minutesRemaining: number,
): string {
  return reviewStage.attestPipelineComment(
    "auto-loop-continuation",
    [
      `## Pipeline: Auto-Loop Continuation (${roundsSpent}/${cfg.auto_loop.max_rounds})`,
      "",
      `Automatically continuing past recoverable stop at \`${stage}\`:`,
      `- **Reason**: ${reason}`,
      `- **Rounds remaining**: ${roundsRemaining}`,
      `- **Wall-clock remaining**: ${minutesRemaining.toFixed(1)} minutes`,
      "",
      "---",
      cfg.marker_footer,
    ].join("\n"),
  );
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildAutoLoopExhaustedComment(
  cfg: PipelineConfig,
  roundsSpent: number,
  stage: Stage,
  outStatus: string,
  outReason: string,
  elapsedMinutes: number,
): string {
  return reviewStage.attestPipelineComment(
    "auto-loop-exhausted",
    [
      "## Pipeline: Auto-Loop Budget Exhausted",
      "",
      `The bounded auto-loop ran ${roundsSpent}/${cfg.auto_loop.max_rounds} round(s) and cannot continue:`,
      `- **Stage**: \`${stage}\``,
      `- **Last outcome**: ${outStatus} — ${outReason}`,
      `- **Rounds used**: ${roundsSpent} / ${cfg.auto_loop.max_rounds}`,
      `- **Time used**: ${elapsedMinutes.toFixed(1)} / ${cfg.auto_loop.max_wallclock_minutes} minutes`,
      "",
      `The issue remains blocked at \`${stage}\` with its mechanical blocker kind preserved. To resume:`,
      "- Fix the underlying issue, clear the block, and re-run `pipeline <N>`.",
      "",
      "---",
      cfg.marker_footer,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Module-level constants (local to this module)
// ---------------------------------------------------------------------------

/**
 * Safety backstop on stage dispatches per advance invocation. Residual
 * re-entry (pre-merge → review/fix → pre-merge) plus disabled skip stages can
 * burn this budget on the transition *into* ready-to-deploy; terminal
 * finalize is guaranteed separately via {@link shouldRunDeferredTerminalFinalize}
 * so PR tagging / Pipeline Complete never depend on a free iteration slot (#773).
 */
export const MAX_ITERATIONS = 12;

/**
 * Whether this advance invocation must still run {@link deployReady.finalize}
 * after the main loop exits. True when the run ended at ready-to-deploy without
 * having entered the in-loop terminal branch (typical cause: {@link MAX_ITERATIONS}
 * exhausted on the advance that labeled the issue R2D — #770/#773).
 *
 * Pure; exported for unit tests.
 */
export function shouldRunDeferredTerminalFinalize(args: {
  dryRun: boolean;
  alreadyFinalized: boolean;
  finalStage: Stage | null | undefined;
}): boolean {
  if (args.dryRun || args.alreadyFinalized) return false;
  return args.finalStage === "ready-to-deploy";
}

// ---------------------------------------------------------------------------
// Bounded auto-loop helpers (#149) — pure functions, exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * A non-advancing outcome is auto-loop recoverable when it is `waiting` (the
 * stage explicitly signals a retriable temporary state) or `blocked` with a
 * pipeline-owned recovery (i.e. blockerKind is set and is neither a generic
 * `needs-human` block nor an explicit `human-decision-required` authority stop).
 * Non-recoverable: `error`, `no-op`, `finalized`, and any `blocked` outcome
 * whose blockerKind requires human authority or is absent (absent → treated as
 * non-recoverable so unannotated stages cannot be silently auto-retried).
 */
export function isAutoLoopRecoverable(out: Outcome): boolean {
  if (out.advanced) return false;
  if (out.status === "waiting") return true;
  if (out.status !== "blocked") return false;
  // Missing blockerKind is treated as non-recoverable (same as needs-human):
  // the pipeline cannot determine a recovery recipe for an unannotated blocker.
  if (!out.blockerKind) return false;
  // Capacity is an ops admission wait and review non-convergence requires a
  // candidate-changing durable repair. Re-driving the same stage cannot
  // satisfy either invariant. Human-required blocks also stay out.
  if (
    out.blockerKind === "needs-human" ||
    out.blockerKind === "human-decision-required" ||
    out.blockerKind === "review-findings" ||
    out.blockerKind === "worktree-capacity"
  ) {
    return false;
  }
  return true;
}

type BlockedOutcome = Extract<Outcome, { advanced: false; status: "blocked" }>;

/** Only an attested fix-stage authority decision is a human-required block. */
export function isHumanAuthorityBlocker(
  kind: BlockerKind | undefined,
  diagnostic?: unknown,
): boolean {
  return kind === "human-decision-required" &&
    projectStageDiagnostic(diagnostic).disposition === "human_authority";
}

/**
 * Preserve a stage's typed block when the in-process retry budget is exhausted.
 * Waiting outcomes have no blocker kind, so one is materialized: pre-merge
 * waits are CI-shaped (`ci-exhausted`); every other stage's wait keeps
 * `needs-human` — the closed BLOCKER_KINDS member that honestly names a
 * generic workflow-state block. It projects to `workflow-state` recovery
 * (see mechanicalReasonCodeForKind), not a human-authority hold — only an
 * attested `human-decision-required` decision is that (isHumanAuthorityBlocker).
 */
export function autoLoopExhaustedBlockedOutcome(out: Outcome, stage: Stage): BlockedOutcome {
  if (!out.advanced && out.status === "blocked" && out.blockerKind) {
    return out;
  }
  const reason = out.advanced ? out.summary : out.reason;
  // An expired wait is workflow state, not evidence of an engine defect:
  // pre-merge waits are CI-shaped (`ci-exhausted` → implementation-ci); any
  // other stage's wait (cross-domain planning contention, triage) keeps the
  // generic workflow-state kind so the durable supervisor recovers it
  // (non-fatal) instead of run_fataling the loop as a `harness-failure`
  // workflow-engine-defect it never was.
  const blockerKind: BlockerKind = stage === "pre-merge" ? "ci-exhausted" : "needs-human";
  const exhaustedReason = `auto-loop budget exhausted at ${stage}: ${reason}`;
  const offrampPathTag = stage === "pre-merge" ? "ci-failed" as const : undefined;
  return {
    advanced: false,
    status: "blocked",
    reason: exhaustedReason,
    blockerKind,
    diagnostic: buildStageDiagnostic({
      blockerKind,
      reason: exhaustedReason,
      stage,
      ...(offrampPathTag ? { offrampClass: offrampPathTag } : {}),
    }),
    ...(offrampPathTag ? { offrampPathTag } : {}),
  };
}

interface BlockedOutcomeEventDeps {
  appendEvent?: typeof appendEvent;
  emitHumanIntervention?: typeof emitHumanIntervention;
  randomUUID?: () => string;
}

/**
 * Emit canonical evidence for every blocked outcome. Human-intervention
 * telemetry is reserved for explicit authority decisions; mechanical blocks
 * remain visible solely through `blocker_set` and their structural kind.
 */
export async function emitBlockedOutcomeEvents(
  runDir: string,
  issueNumber: number,
  stage: Stage,
  out: BlockedOutcome,
  runStoreDeps: RunStoreDeps,
  deps: BlockedOutcomeEventDeps = {},
): Promise<BlockerSetEvent> {
  const doAppendEvent = deps.appendEvent ?? appendEvent;
  const doEmitHumanIntervention = deps.emitHumanIntervention ?? emitHumanIntervention;
  const blockerKind = out.blockerKind ?? "needs-human";
  const pathTag = "offrampPathTag" in out ? out.offrampPathTag : undefined;
  const offrampClass = stage === "pre-merge"
    ? toPreMergeOfframpClass({ blockerKind, pathTag: pathTag ?? null })
    : undefined;
  // Every valid mechanical producer emits the canonical diagnostic inline.
  // Human authority is the one intentional exception: it cannot be
  // synthesized without current finding/candidate attestation.
  const diagnostic = out.diagnostic ?? (
    blockerKind === "human-decision-required"
      ? undefined
      : buildStageDiagnostic({
          blockerKind,
          reason: out.reason,
          stage,
          ...(offrampClass !== undefined ? { offrampClass } : {}),
        })
  );
  const offrampId = (deps.randomUUID ?? randomUUID)();
  const blockerEvent: BlockerSetEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "blocker_set",
    at: evidenceTimestamp(),
    reason: out.reason,
    ...(diagnostic ? { diagnostic } : {}),
    stage,
    blocker_kind: blockerKind,
    offramp_id: offrampId,
    ...(stage === "pre-merge"
      ? {
          offramp_class: offrampClass!,
        }
      : {}),
  };
  await doAppendEvent(runDir, blockerEvent, runStoreDeps).catch(() => {});
  if (isHumanAuthorityBlocker(blockerKind, diagnostic)) {
    await doEmitHumanIntervention(runDir, {
      kind: blockerKindToInterventionKind(blockerKind),
      stage,
      issue: issueNumber,
      detail: out.reason,
      offramp_id: offrampId,
    }, runStoreDeps).catch(() => {});
  }
  return blockerEvent;
}

/**
 * Decide whether the auto-loop should continue past this outcome at this stage.
 * `plan-review` and `shipcheck-gate` are never auto-loop eligible even when
 * allowlisted. Plan-review is an independent-agent review step with an optional
 * human feedback window — not a recovery-retry surface and not a human sign-off
 * gate — so the auto-loop must not re-drive it. A shipcheck verdict failure must
 * not be silently re-run on reviewer nondeterminism (#302): a failed shipcheck
 * requires a human disposition, not an automatic retry that could flip to pass
 * on a later pass.
 */
export function isAutoLoopEligible(
  out: Outcome,
  stage: Stage,
  autoLoop: PipelineConfig["auto_loop"],
): boolean {
  if (!autoLoop.enabled) return false;
  if (!isAutoLoopRecoverable(out)) return false;
  if (stage === "plan-review" || stage === "shipcheck-gate") return false;
  return (autoLoop.stages as string[]).includes(stage);
}

/**
 * Check whether both the round and wall-clock budgets allow another continuation.
 * `startMs` and `nowMs` are millisecond timestamps injected so tests use a fake clock.
 */
export function canAutoLoopContinue(
  autoLoop: PipelineConfig["auto_loop"],
  roundsSpent: number,
  startMs: number,
  nowMs: number,
): boolean {
  if (roundsSpent >= autoLoop.max_rounds) return false;
  const elapsedMinutes = (nowMs - startMs) / 60_000;
  if (elapsedMinutes >= autoLoop.max_wallclock_minutes) return false;
  return true;
}

/** IO seam for {@link runAdvance}: inject a fake clock for wall-clock budgeting in tests. */
export interface AdvanceDeps {
  now?: () => number;
  /** Seam over `resolvePinnedEngineIdentity` (#450) — the identity captured
   *  once at run start and written into `run.json`. */
  resolvePinnedEngineIdentity?: () => EngineIdentity | null;
  /** Seam over `probeEngineIdentity` (#450) — re-read at each stage boundary
   *  and compared against the pinned identity to detect mid-run drift. */
  probeEngineIdentity?: () => EngineIdentity | null;
  /**
   * #762: attach track / pin_version / git_sha on fresh engine identity.
   * Injected so unit tests supply classification without real pin I/O.
   * Production default uses pin already enforced at run start.
   */
  resolveEngineTrackFields?: (
    base: EngineIdentity,
    intent: EngineTrackIntent,
  ) => Pick<RunEngineIdentity, "track" | "pin_version" | "git_sha">;
  /**
   * #762: load production pin + enforce pinned-track policy at run start.
   * Injected for hermetic tests (default: real pin file + enforcePinnedTrackPolicy).
   * Return `{ ok: false }` to refuse the advance before stages run.
   * Under pinned intent every failed enforcement result must refuse (fail closed).
   * Called only when two-track policy is active (`intent` non-null).
   */
  enforceEngineTrack?: (input: {
    /** Pin-authority directory (factory control checkout), not always target repo. */
    repoDir: string;
    intent: EngineTrackIntent;
    runningVersion: string | null;
    pinPathOverride?: string | null;
    /** Engine core root for install-receipt resolution (optional). */
    engineRoot?: string | null;
    /** Pre-resolved provenance for hermetic tests (skips receipt I/O). */
    installProvenance?: PinInstallProvenance | null;
  }) => Promise<
    | {
        ok: true;
        track: "pinned" | "candidate";
        pin_version?: string;
        /** Pin SHA only when track is verified pinned — never for candidate. */
        git_sha?: string;
      }
    | { ok: false; code: string; message: string; remediation: string }
  >;
  /**
   * Park-release hook (#718): free a safe managed worktree when the advance
   * durable-parks so capacity is not stranded. Injected for unit tests.
   */
  releaseParkedWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    parkDeps?: ParkReleaseDeps,
  ) => Promise<ParkReleaseResult>;
  /**
   * Hermetic-drive seams (#787): the gh/worktree/dispatch calls the advance
   * loop makes, injectable so a unit test can drive the REAL runAdvance —
   * including the canonical `blocker_set` emission — with no network, git, or
   * subprocess. Production callers omit them; every default is the real
   * module-level implementation.
   */
  ensurePipelineLabels?: typeof ensurePipelineLabels;
  getIssueDetail?: typeof getIssueDetail;
  getGhActor?: typeof getGhActor;
  getPrForIssue?: typeof getPrForIssue;
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  postComment?: typeof postComment;
  postPrComment?: typeof postPrComment;
  dispatch?: typeof dispatch;
}

/**
 * Whether a non-advancing outcome is a durable park that should attempt
 * park-release (#718). Transient auto-loop-eligible waits/blocks that will
 * re-enter the harness in-process must not release.
 */
export function isDurableParkOutcome(out: Outcome): boolean {
  if (out.advanced) return false;
  if (out.status === "blocked") return true;
  if (out.status === "finalized") {
    // needs-human terminal and ready-to-deploy both finalize; deploy_ready
    // already removes the worktree, and release is idempotent when absent.
    return true;
  }
  // waiting / no-op / error: waiting may be mid-process CI or cross-domain
  // planning contention — do not release; error is not a deliberate park.
  return false;
}

/** Best-effort park-release; never throws into the advance loop. */
export async function maybeReleaseWorktreeOnPark(
  cfg: PipelineConfig,
  issueNumber: number,
  out: Outcome,
  dryRun: boolean,
  deps: AdvanceDeps = {},
): Promise<ParkReleaseResult | null> {
  if (dryRun || !isDurableParkOutcome(out)) return null;
  // Capacity-only blocks never created a worktree; release is a no-op absent.
  // Still safe to call for other blocked kinds that may hold a tree.
  const releaseFn = deps.releaseParkedWorktree ?? releaseWorktreeForParkedIssue;
  try {
    const result = await releaseFn(cfg, issueNumber);
    if (result.action === "released") {
      console.log(`[pipeline] #${issueNumber}: park-release: ${result.reason}`);
    } else if (result.action === "retained") {
      console.log(`[pipeline] #${issueNumber}: park-release retained: ${result.reason}`);
    }
    return result;
  } catch (err) {
    console.log(
      `[pipeline] #${issueNumber}: park-release failed (non-fatal): ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Planning crash-recovery deps (#271)
// ---------------------------------------------------------------------------

/** IO seam for the stranded-planning crash-recovery path in {@link dispatch}.
 *  Inject fakes in unit tests; production uses {@link realPlanningRecoveryDeps}. */
export interface PlanningRecoveryDeps {
  transition: typeof transition;
  planningAdvance: typeof planningStage.advance;
  /** Check if a live planning process is active for this repo+issue (repo-stable). */
  isLivePlanningActive?: (repo: string, issueNumber: number) => boolean;
  /** Atomically claim the live-planning marker; returns false if a live process already holds it. */
  tryAcquireLivePlanningMarker?: (repo: string, issueNumber: number) => boolean;
}

export function realPlanningRecoveryDeps(): PlanningRecoveryDeps {
  return { transition, planningAdvance: planningStage.advance, isLivePlanningActive, tryAcquireLivePlanningMarker };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Map a stage {@link Outcome} to the evidence-bundle stage outcome enum. */
function evidenceOutcome(out: Outcome): StageOutcome {
  if (out.advanced) return "advanced";
  switch (out.status) {
    case "blocked":
      return "blocked";
    case "error":
      return "error";
    default:
      return "skipped"; // waiting | no-op | finalized
  }
}

/** Audit stage name for a dispatched label. */
function evidenceStageName(stage: Stage): string {
  return stage;
}

/** The `ready` dispatch owns an internal planning → plan-review → implementing
 *  lifecycle, so the outer loop must not wrap it in a single synthetic stage. */
function dispatchOwnsStageLifecycle(stage: Stage): boolean {
  return stage === "ready";
}

/** #502: true only for JS's own runtime error types (TypeError, RangeError,
 *  ReferenceError) — Agent Pipeline never intentionally throws these for an
 *  operational failure (a `gh`/git/harness/target-repo failure always throws
 *  a plain `Error` with a descriptive message). Their presence at this
 *  boundary reliably indicates a bug in the engine's own code, not an
 *  external failure, so this is the one signal safe to classify as an
 *  `engineCrash` without risking misclassifying target-repo/environment
 *  failures as product faults (see product-fault.ts). */
export function isEngineOwnedCrash(err: unknown): boolean {
  return err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError;
}

/**
 * #502: classify and (when it qualifies) emit a `product_fault` event for a
 * dispatch-stage crash. Extracted from the dispatch catch site below so it is
 * independently unit-testable without driving the whole `runAdvance` loop —
 * a target-repo/gh/harness failure (a plain `Error`) never reaches
 * `classifyProductFault`, only `isEngineOwnedCrash` errors do.
 */
export async function classifyAndEmitDispatchCrash(
  err: unknown,
  ctx: {
    runDir: string;
    stage: string;
    pipelineVersion: string;
    hostAdapter: string;
    runStoreDeps: RunStoreDeps;
    /** Resolved `product_fault.enabled` — absent/disabled config must produce
     *  no event and no external delivery (default-inert requirement). */
    productFaultEnabled: boolean;
  },
): Promise<void> {
  if (!ctx.productFaultEnabled) return;
  if (!isEngineOwnedCrash(err)) return;
  const errorClass = (err as Error).name || "Error";
  const classification = classifyProductFault({
    errorClass,
    errorMessage: (err as Error).message ?? String(err),
    stage: ctx.stage,
    pipelineVersion: ctx.pipelineVersion,
    hostAdapter: ctx.hostAdapter,
    signal: { engineCrash: true },
  });
  if (!classification) return;
  await emitProductFault(ctx.runDir, {
    classification,
    pipelineVersion: ctx.pipelineVersion,
    hostAdapter: ctx.hostAdapter,
    stage: ctx.stage,
    errorClass,
  }, ctx.runStoreDeps);
}

export function printOutcome(issueNumber: number, fromStage: Stage, out: Outcome, tlog: (line: string) => void): void {
  if (out.advanced) {
    const oo = out as { from: Stage; to: Stage; summary: string };
    tlog(`[pipeline] #${issueNumber}: ${oo.from} → ${oo.to}: ${oo.summary}`);
  } else {
    const oo = out as { status: string; reason: string };
    tlog(`[pipeline] #${issueNumber}: at ${fromStage} — ${oo.status}: ${oo.reason}`);
  }
}

/**
 * Post a single self-contained finalization comment (#147, #377): a labeled run
 * id, a per-stage timing table, and the local evidence-bundle path demoted to
 * secondary/optional context. Targets the PR when one exists, else the issue.
 * Skipped when a notification was already recorded for this run; marks the
 * bundle notified after posting. Best-effort — wrapped by the caller.
 */
async function notifyBundlePath(
  cfg: PipelineConfig,
  issueNumber: number,
  stateDir: string,
  bundle: EvidenceBundle,
  deps: AdvanceDeps = {},
): Promise<void> {
  if (bundle.notifiedAt) return;
  const p = bundlePath(stateDir, issueNumber);
  const body = formatEvidenceCommentBody(bundle, p, `${cfg.invocation} ${issueNumber} --summary`);
  const pr = await (deps.getPrForIssue ?? getPrForIssue)(cfg, issueNumber).catch(() => null);
  if (pr) {
    await (deps.postPrComment ?? postPrComment)(cfg, pr, body);
  } else {
    await (deps.postComment ?? postComment)(cfg, issueNumber, body);
  }
  await markNotified(stateDir, issueNumber);
}

// ---------------------------------------------------------------------------
// Stage dispatch
// ---------------------------------------------------------------------------

export async function dispatch(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  opts: AdvanceOpts,
  pipelineRunId: string,
  stateDir?: string,
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
  recoveryDeps?: PlanningRecoveryDeps,
): Promise<Outcome> {
  const dryRun = !!opts.dryRun;
  const model = opts.model;
  switch (stage) {
    case "ready": {
      // Atomically claim the live-planning marker before calling planningAdvance.
      // A plain check-then-call would be racy: two different-domain runs can
      // both observe no marker and both enter planningAdvance before either
      // writes it.  O_CREAT|O_EXCL inside tryAcquireLivePlanningMarker is
      // atomic at the OS level; only one caller gets true.  planningStage.advance()
      // will overwrite (same PID) and clear the marker in its own finally block.
      const readyDeps = recoveryDeps ?? realPlanningRecoveryDeps();
      const tryAcquire = readyDeps.tryAcquireLivePlanningMarker ?? tryAcquireLivePlanningMarker;
      if (!tryAcquire(cfg.repo, issueNumber)) {
        return {
          advanced: false,
          status: "waiting",
          reason: `planning is active under a different domain — waiting for it to complete`,
        };
      }
      return readyDeps.planningAdvance(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    }
    case "design-gate":
      return designGateStage.advanceDesignGate(cfg, issueNumber, { dryRun, stateDir });
    case "review-1":
      return reviewStage.advanceReview(cfg, issueNumber, 1, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "review-2":
      return reviewStage.advanceReview(cfg, issueNumber, 2, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "fix-1":
      return fixStage.advanceFix(cfg, issueNumber, 1, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "fix-2":
      return fixStage.advanceFix(cfg, issueNumber, 2, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "pre-merge":
      // Use the polling wrapper, not bare advance(). Bare advance returns
      // "waiting" after docs push / on pending CI / after rebase — that
      // pattern was inherited from openclaw's 30-min cron model and would
      // exit the loop, requiring the user to re-invoke. Our skill is
      // manual-only, so pre-merge owns the wait itself, capped at
      // cfg.ci_timeout.
      return preMergeStage.advancePolling(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "visual-gate":
      return visualStage.advanceVisual(cfg, issueNumber, { dryRun, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "eval-gate":
      return evalStage.advanceEval(cfg, issueNumber, { dryRun, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "shipcheck-gate":
      return shipchecKStage.advance(cfg, issueNumber, { dryRun, stateDir, runDir, runStoreDeps });
    case "ready-to-deploy":
      return deployReady.finalize(cfg, issueNumber, runDir, runStoreDeps);
    case "needs-human":
      // Terminal off-ramp; the loop breaks before reaching dispatch, but keep the
      // switch exhaustive so it never falls through to the unknown-stage error.
      return {
        advanced: false,
        status: "finalized",
        reason: "needs-human is terminal; a human must override or fix the residual findings",
      };
    case "backlog":
      return {
        advanced: false,
        status: "waiting",
        reason: "backlog is a triage stage; promote to pipeline:ready manually",
      };
    case "planning":
    case "plan-review": {
      // The per-issue lock (domain-scoped) is already held by this process.  A
      // concurrent run with the SAME domain would have failed at lock acquisition.
      // However, a run from a different worktree or --domain value holds a different
      // lock file and can reach dispatch simultaneously.  To distinguish a live
      // cross-domain run from a crash-stranded one, check the repo-stable
      // live-planning marker (#271 review-2 finding 1).
      const deps = recoveryDeps ?? realPlanningRecoveryDeps();
      const checkLive = deps.isLivePlanningActive ?? isLivePlanningActive;
      if (checkLive(cfg.repo, issueNumber)) {
        return {
          advanced: false,
          status: "waiting",
          reason: `planning is active under a different domain — waiting for it to complete`,
        };
      }
      console.log(
        `[pipeline] #${issueNumber}: recovered stranded planning attempt — restarting from ready`,
      );
      if (!dryRun) {
        await deps.transition(cfg, issueNumber, stage, "ready", "recovered crashed planning attempt — restarting");
      }
      return deps.planningAdvance(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    }
    case "implementing": {
      // Re-entry: gated on the same repo-stable live-planning marker as the
      // `planning`/`plan-review` recovery (#382). Live owner → waiting; no live
      // owner + commits ahead → resume post-implementation steps (#175); no
      // live owner + no commits → crash-stranded, roll back to `ready` and
      // restart planning.
      const implDeps = recoveryDeps ?? realPlanningRecoveryDeps();
      return planningStage.dispatchResume(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps }, {
        isLivePlanningActive: implDeps.isLivePlanningActive,
        transition: implDeps.transition,
        planningAdvance: implDeps.planningAdvance,
      });
    }
    default:
      return { advanced: false, status: "error", reason: `unknown stage ${stage}` };
  }
}

// ---------------------------------------------------------------------------
// Advance mode lifecycle
// ---------------------------------------------------------------------------

export async function runAdvance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts,
  deps: AdvanceDeps = {},
): Promise<void> {
  const nowFn = deps.now ?? (() => Date.now());
  await withLock(
    cfg.domain,
    async () => {
    // Instantiate a metrics collector for this dispatch cycle (#257).
    const ghCollector = new GhMetricsCollector();
    setGhCollector(ghCollector);
    // Ensure pipeline labels exist inside the collector scope so label-list/create
    // calls are captured in the run's gh_metrics_summary (#257 finding 1).
    if (!opts.dryRun) await (deps.ensurePipelineLabels ?? ensurePipelineLabels)(cfg);
    try {
    const startDetail = await (deps.getIssueDetail ?? getIssueDetail)(cfg, issueNumber);
    if (startDetail.state === "closed") {
      console.error(`#${issueNumber} is closed; nothing to advance.`);
      return;
    }
    const startStage = pickStage(startDetail.labels);
    if (!startStage) {
      console.error(
        `#${issueNumber} has no \`pipeline:*\` label. The pipeline is opt-in — add a ` +
          `\`pipeline:ready\` label manually if you want to push it through, then re-run the selected pipeline profile.`,
      );
      process.exitCode = 1;
      return;
    }

    // Compute timing and init the run directory + terminal.log tee BEFORE the first
    // console.log so that terminal.log captures the full run output (finding #6).
    let lastStage: Stage = startStage;
    let transitions = 0;
    const t0 = nowFn();
    const runStartedAt = new Date(t0);
    // Auto-loop budget tracking (#149): rounds spent and wall-clock start.
    let autoLoopRoundsSpent = 0;
    const runStartedAtIso = runStartedAt.toISOString().replace(/\.\d+Z$/, "Z");

    // Evidence bundle (#147): a write-only, per-run audit artifact. Skipped
    // entirely under --dry-run (which writes nothing locally and posts nothing to
    // GitHub) — `stateDir` is then undefined and every record/notify call below is
    // guarded on it. Every call is also best-effort: a failed read/write never
    // affects label transitions or the run outcome (the bundle is a supplement;
    // GitHub labels/comments stay authoritative).
    const stateDir = opts.dryRun ? undefined : runStateDir(cfg.domain);

    function tlog(line: string): void {
      console.log(line);
    }

    // Run directory (#155): stable artifact directory per dispatch. Initialized
    // before the first stage so it survives a mid-run crash. Also starts the
    // terminal.log tee here so it captures all subsequent output including the
    // 'starting' and 'run id' lines below. Skipped under --dry-run.
    // runStoreDeps is mutated after the tee starts so --json-events events bypass it.
    let runDir: string | undefined;
    let terminalTee: TerminalLogTee | undefined;
    // Engine identity this run is pinned to (#450) — resolved once at run start
    // and compared against the on-disk identity at each stage boundary below.
    let pinnedEngine: RunEngineIdentity | undefined;
    let lastObservedEngine: EngineIdentity | undefined;
    // Discovery channel for this dispatch (#763). Re-resolved below when a
    // persisted run.json stamp exists (resume). Default: opts or live-run.
    let activeDiscoveryChannel: DiscoveryChannel = resolveDispatchDiscoveryChannel({
      explicit: opts.discoveryChannel,
    });
    const eventSinkDeps = buildEventSinkDeps(cfg);
    const runStoreDeps: RunStoreDeps = {
      ...defaultRunStoreDeps,
      ...eventSinkDeps,
      // summaryEvents (#343): in-memory accumulator so finalizeRun can enrich
      // summary.json from events delivered this run. Only needed in exclusive
      // sink mode, where events.jsonl is never written (see run-store.ts
      // finalizeRun) — additive/no-sink mode keeps reading events.jsonl so a
      // resumed run also picks up events appended by an earlier process.
      ...(eventSinkDeps.eventSinkMode === "exclusive" ? { summaryEvents: [] } : {}),
    };
    if (stateDir) {
      // Use the run id pinned by a detached launcher when present, so the detached
      // caller and the inner run share one `.agent-pipeline/runs/<run-id>` (#155).
      const runId = opts.runId ?? runIdFor(issueNumber, runStartedAt);
      runDir = runDirPath(cfg.repo_dir, runId);
      // stdoutWrite for initRunDir uses the original stdout (before tee starts);
      // this ensures run_start appears on stdout without going to terminal.log.
      if (opts.jsonEvents) {
        runStoreDeps.stdoutWrite = process.stdout.write.bind(process.stdout) as (s: string) => void;
      }

      // #762 two-track: resolve intent + pin before first init so evidence
      // captures track once and pinned intent can refuse a mislabeled run.
      // Policy is factory-scoped: ordinary non-factory advances (product
      // repos without explicit --engine-track / engine_track) leave intent
      // inactive and do not require a production pin. Factory control
      // defaults to pinned and fail-closes on missing/invalid pin, version
      // mismatch, or unverified install provenance. Pin authority is the
      // factory control checkout (or explicit pin path), not every target
      // product repoDir. Candidate intent never claims pin git_sha.
      const factoryControlContext = isFactoryControlRepo(cfg.repo);
      const trackIntent: ResolvedEngineTrackIntent = resolveEngineTrackIntent({
        command: "advance",
        cliTrack: opts.engineTrack ?? null,
        configTrack: cfg.engine_track ?? null,
        factoryControlContext,
      });
      const baseForGate = (deps.resolvePinnedEngineIdentity ?? resolvePinnedEngineIdentity)();
      // Pin authority: factory control dir / self-dogfood / explicit pin path.
      // Never fall back to an arbitrary product target under active track intent.
      const pinPathOverride = cfg.production_engine_pin_path ?? null;
      const pinAuthority = resolvePinAuthorityDir({
        targetRepoDir: cfg.repo_dir,
        targetIsFactoryControl: factoryControlContext,
        // Active two-track intent: product targets are not pin authority.
        allowTargetFallback: trackIntent === null,
      });
      const hasPinOverride = hasProductionPinPathOverride(pinPathOverride);
      let trackForEvidence: "pinned" | "candidate" | undefined;
      let pinVersionForEvidence: string | undefined;
      let gitShaForEvidence: string | undefined;

      if (trackIntent !== null) {
        // Pinned intent without factory-control authority or pin-path override
        // must refuse — a product-local pin (or missing product pin) is not
        // production-pin authority.
        if (trackIntent === "pinned" && !pinAuthority.ok && !hasPinOverride) {
          console.error(
            `[pipeline] #${issueNumber}: engine-track policy refused (${pinAuthority.code}): ${pinAuthority.message}\n` +
              `  → ${pinAuthority.remediation}`,
          );
          return;
        }
        const enforce =
          deps.enforceEngineTrack ??
          (async (input) => {
            const readTextFile = async (p: string): Promise<string | null> => {
              try {
                return await fsp.readFile(p, "utf8");
              } catch {
                return null;
              }
            };
            // Without factory authority and without pin override, do not load
            // a product-local pin (candidate intent continues with missing pin).
            let pinLoad: PinLoadResult;
            if (!pinAuthority.ok && !hasPinOverride) {
              pinLoad = {
                kind: "missing",
                path: PRODUCTION_ENGINE_PIN_REL,
              };
            } else {
              pinLoad = await resolveProductionPin({
                repoDir: input.repoDir,
                readTextFile,
                overridePath: input.pinPathOverride ?? null,
              });
            }
            let installProvenance: PinInstallProvenance | null | undefined =
              input.installProvenance;
            if (installProvenance === undefined) {
              const engineRoot = input.engineRoot ?? baseForGate?.root ?? null;
              let receiptText: string | null = null;
              if (engineRoot) {
                receiptText = await readTextFile(installReceiptPath(engineRoot));
              }
              // Working-tree signal: engine root lives under the control repo
              // (or a worktree path under it). Tag installs live outside repoDir.
              const isWorkingTree = Boolean(
                engineRoot &&
                  (engineRoot === input.repoDir ||
                    engineRoot.startsWith(input.repoDir + path.sep) ||
                    engineRoot.includes(`${path.sep}.worktrees${path.sep}`)),
              );
              installProvenance = resolveInstallProvenance({
                receiptText,
                isWorkingTree,
                workingTreeDetail: isWorkingTree
                  ? "engine root is under the control-repo / worktree checkout"
                  : undefined,
              });
            }
            const r = enforcePinnedTrackPolicy({
              intent: input.intent,
              pinLoad,
              runningVersion: input.runningVersion,
              installProvenance,
            });
            if (!r.ok) {
              return {
                ok: false as const,
                code: r.code,
                message: r.message,
                remediation: r.remediation,
              };
            }
            // git_sha only for verified pinned track (never pin SHA on candidate).
            return {
              ok: true as const,
              ...engineTrackEvidenceFields({
                track: r.classification.track,
                pin: r.pin,
              }),
            };
          });
        // Authority dir when resolved; with pin-path override alone, pin load
        // uses the override and repoDir is only a working-tree comparison base.
        const pinAuthorityDir = pinAuthority.ok ? pinAuthority.dir : cfg.repo_dir;
        const enforcement = await enforce({
          repoDir: pinAuthorityDir,
          intent: trackIntent,
          runningVersion: baseForGate?.version ?? null,
          pinPathOverride,
          engineRoot: baseForGate?.root ?? null,
        });
        // Fail closed under every failed pinned-track enforcement result.
        // Intentional soaks must pass --engine-track candidate (or config).
        if (!enforcement.ok) {
          console.error(
            `[pipeline] #${issueNumber}: engine-track policy refused (${enforcement.code}): ${enforcement.message}\n` +
              `  → ${enforcement.remediation}`,
          );
          return;
        }
        trackForEvidence = enforcement.track;
        pinVersionForEvidence = enforcement.pin_version;
        // Candidate evidence must never inherit the production pin SHA.
        gitShaForEvidence =
          enforcement.track === "pinned" ? enforcement.git_sha : undefined;
      }

      // Resumed dispatch (#450): reuse the engine identity already recorded in
      // this run's run.json when it exists, rather than re-resolving the
      // current on-disk identity — initRunDir below is idempotent and will NOT
      // overwrite an existing run.json, so pinnedEngine must match what was
      // actually written or drift checks would compare the current identity to
      // itself and silently suppress a real drift event.
      //
      // #762: on first init only, attach track + optional pin_version/git_sha
      // when two-track policy is active. Non-factory inactive policy omits
      // track (consumers treat missing track as unknown). Resume reuses the
      // written engine object wholesale (including track).
      pinnedEngine = await resolveRunEngineIdentity(
        runDir,
        () => {
          const base = (deps.resolvePinnedEngineIdentity ?? resolvePinnedEngineIdentity)();
          if (!base) return undefined;
          if (trackIntent === null) {
            // Non-factory: no track claim.
            return base;
          }
          if (deps.resolveEngineTrackFields) {
            return { ...base, ...deps.resolveEngineTrackFields(base, trackIntent) };
          }
          const fields: Pick<RunEngineIdentity, "track" | "pin_version" | "git_sha" | "commit_sha"> = {
            track: trackForEvidence ?? (trackIntent === "candidate" ? "candidate" : "pinned"),
          };
          if (pinVersionForEvidence) fields.pin_version = pinVersionForEvidence;
          if (gitShaForEvidence) fields.git_sha = gitShaForEvidence;
          // Engine checkout SHA (#763) — from resolvePinnedEngineIdentity; never invent.
          if (base.commit_sha) fields.commit_sha = base.commit_sha;
          return { ...base, ...fields };
        },
        runStoreDeps,
      );
      lastObservedEngine = pinnedEngine;
      // Outer-host identity (#784): from PIPELINE_OUTER_HOST when set; never
      // invent from implementer/reviewer adapter id. Omit when unknown.
      const outerHostResolved = resolveOuterHostEvidence({
        explicit: readOuterHostFromEnv(process.env),
        implementerAdapterId: cfg.harnesses?.implementer ?? null,
        reviewerAdapterId: cfg.harnesses?.reviewer ?? null,
      });
      const outerHost =
        outerHostResolved === OUTER_HOST_UNKNOWN ? null : outerHostResolved;
      // Discovery channel for this dispatch (#763): prefer a persisted run.json
      // stamp on resume (written-once), else the entrypoint override, else live-run.
      // Must be resolved before initRunDir so first-write persists the channel.
      let persistedDiscovery: DiscoveryChannel | null = null;
      try {
        const raw = await runStoreDeps.readFile(path.join(runDir, "run.json"));
        persistedDiscovery = runLevelDiscoveryChannel(
          JSON.parse(raw) as Record<string, unknown>,
        );
      } catch {
        /* first init — no run.json yet */
      }
      activeDiscoveryChannel = resolveDispatchDiscoveryChannel({
        explicit: opts.discoveryChannel,
        persisted: persistedDiscovery,
      });
      await initRunDir(
        {
          runDir,
          runId,
          issue: issueNumber,
          repo: cfg.repo,
          profile: opts.profile ?? null,
          startedAt: runStartedAtIso,
          engine: pinnedEngine,
          outerHost,
          discoveryChannel: activeDiscoveryChannel,
        },
        runStoreDeps,
      ).catch(() => {});
      // Start the terminal.log tee (directory exists after initRunDir).
      try {
        terminalTee = startTerminalLogTee(path.join(runDir, "terminal.log"));
        // Switch subsequent appendEvent calls to rawWrite so JSON lines bypass terminal.log.
        if (opts.jsonEvents) {
          runStoreDeps.stdoutWrite = terminalTee.rawWrite;
        }
      } catch {
        /* non-fatal — run continues without tee */
      }
    }

    // Mid-run engine drift (#450): re-probe the on-disk engine identity at each
    // stage boundary and compare it to the identity this run pinned at start.
    // Advisory only — never blocks, retries, or changes a stage outcome; a
    // failed probe (or the absence of a pinned identity, e.g. a pre-#450 run
    // directory) is silently treated as "no drift". Only state TRANSITIONS are
    // recorded (compared against the last-observed identity, not the pinned one
    // on every call), so a single update mid-run produces exactly one event.
    async function checkEngineDrift(stageName: string): Promise<void> {
      if (!pinnedEngine || !runDir) return;
      const observed = (deps.probeEngineIdentity ?? probeEngineIdentity)();
      if (!observed) return;
      const last = lastObservedEngine ?? pinnedEngine;
      const drifted = isEngineDriftTransition(last, observed);
      lastObservedEngine = observed;
      if (!drifted) return;
      const at = evidenceTimestamp();
      console.warn(
        `[pipeline] #${issueNumber}: engine drift detected at ${stageName} — pinned ${pinnedEngine.version} ` +
          `(${pinnedEngine.templates_fingerprint.slice(0, 12)}) vs on-disk ${observed.version} ` +
          `(${observed.templates_fingerprint.slice(0, 12)}). This run continues against its pinned snapshot.`,
      );
      await appendEvent(
        runDir,
        { schema_version: RUN_SCHEMA_VERSION, type: "engine_drift", at, stage: stageName, pinned: pinnedEngine, observed },
        runStoreDeps,
      ).catch(() => {});
      if (stateDir) {
        await recordEngineDrift(stateDir, issueNumber, {
          at,
          stage: stageName,
          pinned: pinnedEngine,
          observed,
        }).catch(() => {});
      }
    }

    // Outer try/finally: stop tee only AFTER the final 'done' line is printed so
    // that line is captured in terminal.log (the inner finally runs first).
    try {

    tlog(`[pipeline] #${issueNumber}: starting at stage=${startStage}`);

    // One run id per dispatch (#20): generated before any stage runs and threaded
    // into every commit operation, so all commits this invocation produces — across
    // every stage and re-entry of the loop — carry the same `Pipeline-Run:` trailer.
    const pipelineRunId = makePipelineRunId(issueNumber, runStartedAt);
    setGhRunId(pipelineRunId);
    // Module-level channel for setBlocked / stage parks (#763): same closed-set
    // value written to run.json (or opts/live-run when dry-run has no run dir).
    // Never force live-run over a resolved review-batch / manual stamp.
    setGhDiscoveryChannel(activeDiscoveryChannel);
    tlog(`[pipeline] #${issueNumber}: run id ${pipelineRunId}`);

    if (stateDir) {
      let bundlePr: number | null = null;
      try {
        bundlePr = await (deps.getPrForIssue ?? getPrForIssue)(cfg, issueNumber);
      } catch {
        /* no PR yet, or lookup failed — record null */
      }
      const startWt = await (deps.getOnDiskForIssue ?? getOnDiskForIssue)(cfg, issueNumber).catch(() => null);
      const bundleBranch = startWt ? branchName(issueNumber, startWt.slug) : null;
      const harnesses = Array.from(new Set([cfg.harnesses.implementer, cfg.harnesses.reviewer]));
      await createBundle(stateDir, {
        runId: pipelineRunId,
        issue: issueNumber,
        pr: bundlePr,
        branch: bundleBranch,
        harnesses,
        roles: {
          implementer: cfg.harnesses.implementer,
          implementerSource: cfg.harnesses.implementerSource,
          reviewer: cfg.harnesses.reviewer,
          reviewerSource: cfg.harnesses.reviewerSource,
        },
      }).catch(() => {});
      // An override supplied on THIS invocation carries the full human reason. The
      // review stage applies it deterministically; record it here, where the reason
      // text is available, now that the bundle exists.
      if (opts.override) {
        const parsedOverride = parseOverrideArg(opts.override);
        if (!("error" in parsedOverride)) {
          const overrideRef = parsedOverride.kind === "key"
            ? parsedOverride.key
            : `${parsedOverride.scopeType}:${parsedOverride.scopeValue}`;
          await recordOverride(stateDir, issueNumber, {
            key: overrideRef,
            reason: parsedOverride.reason,
            kind: "human-risk-override",
          }).catch(() => {});
          await emitHumanIntervention(runDir, {
            kind: "human-risk-override",
            stage: null,
            issue: issueNumber,
            detail: `override applied: ${overrideRef} — ${parsedOverride.reason}`,
            ref: overrideRef,
          }, runStoreDeps).catch(() => {});
        }
      }
    }

    // Tracks the stage the run ends at — recorded as the bundle's terminal state.
    let finalStage: Stage = startStage;
    // Tracks the most recently seen branch so the finally block can patch bundle
    // identity even when deployReady.finalize() has already removed the worktree.
    let lastKnownBranch: string | null = null;
    // Whether deploy_ready.finalize ran this invocation (#773). Residual re-entry
    // can exhaust MAX_ITERATIONS on the advance that labels the issue R2D, leaving
    // PR tagging / Pipeline Complete unrun unless we defer-finalize after the loop.
    let deployReadyFinalized = false;

    /** Run terminal finalize + lifecycle events. Shared by in-loop R2D branch and post-loop guarantee. */
    async function runTerminalFinalize(reason: "in-loop" | "deferred"): Promise<Outcome> {
      const rtdStage = evidenceStageName("ready-to-deploy");
      const rtdEnteredAt = evidenceTimestamp();
      if (reason === "deferred") {
        tlog(
          `[pipeline] #${issueNumber}: terminal finalize deferred past iteration budget ` +
            `(MAX_ITERATIONS=${MAX_ITERATIONS}); running deploy_ready.finalize now`,
        );
      }
      if (runDir) {
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at: rtdEnteredAt, stage: rtdStage }, runStoreDeps).catch(() => {});
      }
      let out: Outcome;
      try {
        out = await deployReady.finalize(cfg, issueNumber, runDir, runStoreDeps);
      } catch (err) {
        if (runDir) {
          await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: evidenceTimestamp(), stage: rtdStage, outcome: "error", commits: [] }, runStoreDeps).catch(() => {});
        }
        throw err;
      }
      if (runDir) {
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: evidenceTimestamp(), stage: rtdStage, outcome: evidenceOutcome(out), commits: [] }, runStoreDeps).catch(() => {});
      }
      deployReadyFinalized = true;
      printOutcome(issueNumber, "ready-to-deploy", out, tlog);
      return out;
    }

    try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const detail = await (deps.getIssueDetail ?? getIssueDetail)(cfg, issueNumber);
      const stage = pickStage(detail.labels);
      if (!stage) {
        tlog(`[pipeline] #${issueNumber}: pipeline label removed; stopping.`);
        break;
      }
      finalStage = stage;
      await checkEngineDrift(evidenceStageName(stage));

      // Reconcile audit comments (#259): if a prior run's label write succeeded but its
      // comment post failed, the sentinel is missing. Detect and repair the gap.
      // Resolve the pipeline's own GitHub actor once so a sentinel is only trusted from a
      // pipeline-authored comment — body-prefix text alone is forgeable (security review).
      const auditTrustedActor = opts.dryRun ? null : await (deps.getGhActor ?? getGhActor)();
      // Skip stage-sentinel repair for manually-applied entry-point stages ("ready", "backlog")
      // since those are never created by transition() and have no sentinel to repair.
      if (!opts.dryRun && stage !== "ready" && stage !== "backlog") {
        const repairBody = buildAuditRepairComment(stage, pipelineRunId);
        await reconcileAuditComment(
          cfg, issueNumber, stage, pipelineRunId, repairBody, detail.comments, auditTrustedActor,
        );
      }
      // Blocked-sentinel repair runs regardless of stage — an issue can be blocked while at
      // pipeline:ready (label write succeeded, comment post failed) and we must not skip it.
      if (!opts.dryRun && isBlocked(detail.labels)) {
        const blockedRepairBody = buildAuditRepairBlockedComment(pipelineRunId);
        await reconcileAuditComment(
          cfg, issueNumber, "blocked", pipelineRunId, blockedRepairBody, detail.comments, auditTrustedActor,
        );
      }

      if (stage === "ready-to-deploy") {
        // The terminal stage is handled outside the common dispatch block, so emit
        // its stage_start / stage_complete lifecycle events explicitly — otherwise a
        // consumer cannot reconstruct the full ordered timeline from events.jsonl (#155).
        await runTerminalFinalize("in-loop");
        break;
      }

      if (stage === "needs-human") {
        const ceiling = [...detail.comments]
          .reverse()
          .find((c) => c.body.startsWith(REVIEW_CEILING_MARKER));
        const round = ceiling ? ceilingRound(ceiling.body) : null;
        const resumeLabel = round !== null ? `pipeline:review-${round}` : "pipeline:review-<round>";
        console.log(
          `[pipeline] #${issueNumber}: parked at needs-human — a review round hit the round ceiling. ` +
            `Disposition a finding with --override "<key>: <reason>" (records the decision and auto-resumes), ` +
            `or fix the residual findings and relabel pipeline:needs-human → ${resumeLabel} to resume.`,
        );
        if (ceiling) console.log(ceiling.body);
        // Already parked: free capacity when the managed worktree is safe (#718).
        await maybeReleaseWorktreeOnPark(
          cfg,
          issueNumber,
          { advanced: false, status: "finalized", reason: "needs-human" },
          !!opts.dryRun,
          deps,
        );
        break;
      }

      if (isBlocked(detail.labels)) {
        if (stage === "implementing") {
          console.log(`[pipeline] #${issueNumber}: blocked at implementing — attempting auto-recovery`);
          const out = await autoRecover.tryAutoRecover(cfg, issueNumber, stateDir, runDir, runStoreDeps);
          printOutcome(issueNumber, stage, out, tlog);
          if (out.advanced) {
            transitions++;
            lastStage = (out as { to: Stage }).to;
            if (opts.once) break;
            continue;
          }
        }
        console.log(`[pipeline] #${issueNumber}: blocked at ${stage}; surface latest blocker:`);
        const blockerComment = [...detail.comments]
          .reverse()
          .find((c) => c.body.startsWith("## Pipeline: Blocked"));
        if (blockerComment) {
          console.log(blockerComment.body);
        }
        console.log(
          `[pipeline] #${issueNumber}: follow the "### How to unblock" steps in the comment above to resume.`,
        );
        // Already blocked: free capacity when the managed worktree is safe (#718).
        await maybeReleaseWorktreeOnPark(
          cfg,
          issueNumber,
          { advanced: false, status: "blocked", reason: "already blocked" },
          !!opts.dryRun,
          deps,
        );
        break;
      }

      // #13: skip disabled review stages, keeping a valid forward path.
      if (
        (stage === "review-1" && !cfg.steps.standard_review) ||
        (stage === "review-2" && !cfg.steps.adversarial_review)
      ) {
        const to = reviewStageSkipTarget(cfg, stage);
        const skipStage = evidenceStageName(stage);
        const skipEnteredAt = evidenceTimestamp();
        await transition(cfg, issueNumber, stage, to, `${stage} step disabled in this repo's config; skipping.`);
        tlog(`[pipeline] #${issueNumber}: ${stage} → ${to} (step disabled)`);
        transitions++;
        lastStage = to;
        finalStage = to;
        if (stateDir) {
          await recordStage(stateDir, issueNumber, {
            stage: skipStage,
            enteredAt: skipEnteredAt,
            exitedAt: evidenceTimestamp(),
            outcome: "skipped",
          }).catch(() => {});
        }
        if (runDir) {
          await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at: skipEnteredAt, stage: skipStage }, runStoreDeps).catch(() => {});
          await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: evidenceTimestamp(), stage: skipStage, outcome: "skipped", commits: [] }, runStoreDeps).catch(() => {});
        }
        if (opts.once) break;
        continue;
      }

      const dispatchOwnsLifecycle = dispatchOwnsStageLifecycle(stage);

      // Pre-dispatch: capture worktree HEAD so we can record which commits the stage produced.
      let headBeforeDispatch = "";
      if (!dispatchOwnsLifecycle && stateDir) {
        const wtBefore = await (deps.getOnDiskForIssue ?? getOnDiskForIssue)(cfg, issueNumber).catch(() => null);
        if (wtBefore) {
          headBeforeDispatch = (
            await gitInWorktree(wtBefore.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
          ).stdout.trim();
        }
      }

      const auditStage = evidenceStageName(stage);
      const stageEnteredAt = evidenceTimestamp();
      if (!dispatchOwnsLifecycle && stateDir) {
        await recordStage(stateDir, issueNumber, {
          stage: auditStage,
          enteredAt: stageEnteredAt,
        }).catch(() => {});
      }
      if (!dispatchOwnsLifecycle && runDir) {
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at: stageEnteredAt, stage: auditStage }, runStoreDeps).catch(() => {});
      }
      let out: Outcome;
      try {
        out = await (deps.dispatch ?? dispatch)(cfg, issueNumber, stage, opts, pipelineRunId, stateDir, runDir, runStoreDeps);
      } catch (err) {
        // Stage threw — record an error outcome before rethrowing so the bundle
        // never shows a perpetually in-progress stage.
        const errAt = evidenceTimestamp();
        if (!dispatchOwnsLifecycle && stateDir) {
          await recordStage(stateDir, issueNumber, {
            stage: auditStage,
            exitedAt: errAt,
            outcome: "error",
            commits: [],
          }).catch(() => {});
        }
        if (!dispatchOwnsLifecycle && runDir) {
          await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: errAt, stage: auditStage, outcome: "error", commits: [] }, runStoreDeps).catch(() => {});
        }
        // #502: a stage crash with a native JS error type (never intentionally
        // thrown for a gh/git/harness/target-repo failure — see
        // isEngineOwnedCrash) is a probable Agent Pipeline defect, distinct
        // from every other evidence class recorded above. Gated on the
        // resolved product_fault config so an installation with no (or a
        // disabled) product_fault block stays fully inert — no new
        // events.jsonl artifact and no delivery to any configured external
        // event sink.
        if (runDir) {
          const productFaultConfig = await resolveProductFaultConfig(cfg.repo_dir, runStoreDeps);
          await classifyAndEmitDispatchCrash(err, {
            runDir,
            stage: auditStage,
            pipelineVersion: pinnedEngine?.version ?? "",
            hostAdapter: resolveHostAdapter(),
            runStoreDeps,
            productFaultEnabled: productFaultConfig.enabled,
          });
        }
        throw err;
      }

      // Post-dispatch: collect commits produced during this stage (before recording exit).
      // stageCommits is declared outside the stateDir block so it is also available
      // for the stage_complete event appended to events.jsonl below.
      const stageExitedAt = evidenceTimestamp();
      let stageCommits: string[] = [];
      if (!dispatchOwnsLifecycle && stateDir) {
        const wtAfter = await (deps.getOnDiskForIssue ?? getOnDiskForIssue)(cfg, issueNumber).catch(() => null);
        if (wtAfter) {
          lastKnownBranch = branchName(issueNumber, wtAfter.slug);
          // If no worktree existed before dispatch (e.g., planning creates it), fall
          // back to origin/<base_branch> so all planning commits are captured.
          const rangeStart = headBeforeDispatch || `origin/${cfg.base_branch}`;
          const logResult = await gitInWorktree(
            wtAfter.path,
            ["log", "--pretty=format:%H", `${rangeStart}..HEAD`],
            { ignoreFailure: true },
          );
          stageCommits = logResult.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        }
        await recordStage(stateDir, issueNumber, {
          stage: auditStage,
          exitedAt: stageExitedAt,
          outcome: evidenceOutcome(out),
          commits: stageCommits,
        }).catch(() => {});
      }
      if (!dispatchOwnsLifecycle && runDir) {
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: stageExitedAt, stage: auditStage, outcome: evidenceOutcome(out), commits: stageCommits }, runStoreDeps).catch(() => {});
      }
      printOutcome(issueNumber, stage, out, tlog);

      if (out.advanced) {
        transitions++;
        lastStage = (out as { to: Stage }).to;
        finalStage = lastStage; // keep final-state accurate when --once breaks after an advance
      } else {
        // Record every structural block before any in-process recovery clears it.
        // This is the canonical child evidence consumed by durable supervision.
        if (out.status === "blocked" && runDir) {
          await emitBlockedOutcomeEvents(
            runDir,
            issueNumber,
            auditStage,
            out,
            runStoreDeps,
          );
        }
        // Non-advancing: check auto-loop eligibility before stopping (#149).
        const eligible = isAutoLoopEligible(out, stage, cfg.auto_loop);
        if (eligible && canAutoLoopContinue(cfg.auto_loop, autoLoopRoundsSpent, t0, nowFn())) {
          // Auto-loop: perform recovery and continue within budget.
          autoLoopRoundsSpent++;
          if (!opts.dryRun && out.status === "blocked") {
            await clearBlocked(cfg, issueNumber).catch(() => {});
          }
          const nowMs = nowFn();
          const roundsRemaining = cfg.auto_loop.max_rounds - autoLoopRoundsSpent;
          const minutesRemaining = Math.max(
            0,
            cfg.auto_loop.max_wallclock_minutes - (nowMs - t0) / 60_000,
          );
          console.log(
            `[pipeline] #${issueNumber}: auto-loop round ${autoLoopRoundsSpent}/${cfg.auto_loop.max_rounds}: ` +
            `continuing past ${out.status} at ${stage} ` +
            `(${roundsRemaining} rounds, ${minutesRemaining.toFixed(1)}m remaining)`,
          );
          if (!opts.dryRun) {
            await postComment(
              cfg,
              issueNumber,
              buildAutoLoopContinuationComment(cfg, autoLoopRoundsSpent, stage, out.reason, roundsRemaining, minutesRemaining),
            ).catch(() => {});
            if (stateDir) {
              await recordRecovery(stateDir, issueNumber, {
                trigger: `bounded-auto-loop:${out.status}:${stage}`,
                round: autoLoopRoundsSpent,
                at: evidenceTimestamp(),
              }).catch(() => {});
            }
          }
          if (opts.once) break;
          continue;
        } else if (eligible && autoLoopRoundsSpent > 0) {
          // Budget exhausted after at least one continuation: preserve or
          // materialize a typed mechanical block at the current stage.
          const elapsedMinutes = (nowFn() - t0) / 60_000;
          const exhaustedOutcome = autoLoopExhaustedBlockedOutcome(out, stage);
          console.log(
            `[pipeline] #${issueNumber}: auto-loop budget exhausted after ${autoLoopRoundsSpent} ` +
            `continuation(s) — remaining blocked at ${stage} (${exhaustedOutcome.blockerKind})`,
          );
          if (!opts.dryRun) {
            if (out.status !== "blocked") {
              await setBlocked(
                cfg,
                issueNumber,
                exhaustedOutcome.reason,
                stage,
                exhaustedOutcome.blockerKind,
              );
              if (runDir) {
                await emitBlockedOutcomeEvents(
                  runDir,
                  issueNumber,
                  auditStage,
                  exhaustedOutcome,
                  runStoreDeps,
                );
              }
            }
            await postComment(
              cfg,
              issueNumber,
              buildAutoLoopExhaustedComment(cfg, autoLoopRoundsSpent, stage, out.status, out.reason, elapsedMinutes),
            ).catch(() => {});
            if (stateDir) {
              await recordRecovery(stateDir, issueNumber, {
                trigger: "bounded-auto-loop:exhausted",
                round: autoLoopRoundsSpent + 1,
                at: evidenceTimestamp(),
              }).catch(() => {});
            }
          }
          out = exhaustedOutcome;
        } else {
          // Not eligible or no rounds spent: stop as today.
          // The block event was emitted above. No generic human-intervention
          // event is synthesized for mechanical or untyped blocks.
        }
        // Durable park sink (#718): free a safe managed worktree so capacity is
        // not stranded while this issue waits. Mid-process auto-loop continues
        // above never reach this path.
        await maybeReleaseWorktreeOnPark(cfg, issueNumber, out, !!opts.dryRun, deps);
        break;
      }

      if (opts.once) break;
    }

    // Deferred terminal finalize (#773): residual re-entry can exhaust
    // MAX_ITERATIONS on the stage that silent-transitions the issue to
    // ready-to-deploy, leaving no free iteration for the in-loop R2D branch.
    // deploy_ready.finalize is idempotent (summary comment + PR label + worktree
    // removal); run it here so PR tagging never depends on spare budget.
    if (
      shouldRunDeferredTerminalFinalize({
        dryRun: !!opts.dryRun,
        alreadyFinalized: deployReadyFinalized,
        finalStage,
      })
    ) {
      await runTerminalFinalize("deferred");
    }
    } finally {
      // Finalize + notify however the loop ended — normal, blocked, or thrown.
      // Best-effort so audit I/O never masks the real run outcome. Skipped under
      // --dry-run (stateDir undefined): no local write, no GitHub comment.
      if (stateDir) {
        try {
          // Refresh PR/branch — may have been null at bundle creation if planning
          // hadn't run yet. Only patch non-null values: deployReady removes the
          // worktree before this block runs, so latestBranch is null on a successful
          // ready-to-deploy run. Overwriting with null would erase the captured branch.
          const latestPr = await (deps.getPrForIssue ?? getPrForIssue)(cfg, issueNumber).catch(() => null);
          const latestWt = await (deps.getOnDiskForIssue ?? getOnDiskForIssue)(cfg, issueNumber).catch(() => null);
          // deployReady.finalize() removes the worktree before this block runs, so
          // latestWt may be null on a successful run. Fall back to the last branch we
          // observed during the dispatch loop so the bundle is never finalized with
          // branch: null after a complete run.
          const latestBranch = latestWt ? branchName(issueNumber, latestWt.slug) : lastKnownBranch;
          const identityPatch: { pr?: number | null; branch?: string | null } = {};
          if (latestPr !== null) identityPatch.pr = latestPr;
          if (latestBranch !== null) identityPatch.branch = latestBranch;
          if (identityPatch.pr !== undefined || identityPatch.branch !== undefined) {
            await patchBundleIdentity(stateDir, issueNumber, identityPatch).catch(() => {});
          }
          const finalized = await finalizeBundle(stateDir, issueNumber, finalStage);
          // Run-store finalization (#155): write summary.json + run_complete event before
          // notifyBundlePath so that finalizeRun does not overwrite the notifiedAt stamp
          // that markNotified writes to evidence.json (finding #5).
          // Metrics are NOT passed here — gh_metrics_summary is emitted after notification
          // so that notification gh calls (getPrForIssue/postPrComment) are captured (#257).
          if (runDir) {
            await finalizeRun(runDir, finalized, stateDir, issueNumber, runStartedAtIso, runStoreDeps).catch(() => {});
          }
          // Opt-in papercut auto-file (#421): best-effort, gated on resolved
          // config, wrapped so a failure here can never alter the run's outcome.
          if (cfg.papercuts.enabled && cfg.papercuts.auto_file) {
            await autoFilePapercuts(
              {
                repoDir: cfg.repo_dir,
                domain: cfg.domain,
                windowHours: cfg.papercuts.auto_file_window_hours,
                maxPerWindow: cfg.papercuts.auto_file_max_per_window,
                minOccurrences: cfg.papercuts.auto_file_min_occurrences,
              },
              realAutoFileDeps(cfg.repo_dir),
            ).catch(() => {});
          }
          // Opt-in correction auto-file (#500): correction_event capture (#499) is
          // unconditional, so this gates only on auto_file (no capture-side enabled flag,
          // unlike papercuts). Best-effort, wrapped so a failure can never alter the run's outcome.
          if (cfg.corrections.auto_file) {
            await autoFileCorrections(
              {
                repoDir: cfg.repo_dir,
                domain: cfg.domain,
                windowHours: cfg.corrections.auto_file_window_hours,
                maxPerWindow: cfg.corrections.auto_file_max_per_window,
                minOccurrences: cfg.corrections.auto_file_min_occurrences,
              },
              realAutoFileDeps(cfg.repo_dir),
            ).catch(() => {});
          }
          await notifyBundlePath(cfg, issueNumber, stateDir, finalized, deps);
        } catch {
          /* audit-only — ignore */
        }
        // Emit gh_metrics_summary unconditionally after the notification attempt so
        // a notification failure does not suppress the summary (#257 finding 2).
        if (runDir) {
          await emitGhMetrics(runDir, ghCollector.summary(), runStoreDeps).catch(() => {});
        }
      }
    }

    const elapsed = Math.round((nowFn() - t0) / 1000);
    tlog(
      `\n[pipeline] #${issueNumber}: done — ${startStage} → ${lastStage} (${transitions} transitions, ${elapsed}s)`,
    );

    } finally {
      // Stop the terminal.log tee AFTER the final 'done' line above is written so
      // that line is captured in terminal.log (the inner finally runs first).
      if (terminalTee) {
        await terminalTee.stop().catch(() => {});
      }
    }
    } finally {
      // Clear module-level per-run state when this dispatch cycle ends (#257, #259).
      setGhCollector(undefined);
      setGhRunId(undefined);
      setGhDiscoveryChannel(undefined);
    }
    },
    issueNumber,
  );
}
