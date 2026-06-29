// Advance-loop lifecycle service (#263).
//
// This module is intentionally free of Commander imports so it can be imported
// in test contexts and by other modules without triggering CLI initialization.
// The CLI (pipeline.ts) imports and calls runAdvance; it also re-exports the
// auto-loop helpers and AdvanceDeps so existing import paths continue to work.

import * as path from "node:path";
import { makeTransitionsLogger, singleLifecycleLine, transitionsLogPath } from "./transitions-log.ts";
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
  setGhCollector,
  setGhRunId,
  transition,
} from "./gh.ts";
import { getOnDiskForIssue, gitInWorktree, branchName } from "./worktree.ts";
import { withLock, runStateDir, isLivePlanningActive, tryAcquireLivePlanningMarker } from "./lock.ts";
import {
  bundlePath,
  createBundle,
  finalizeBundle,
  markNotified,
  patchBundleIdentity,
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
  runDirPath,
  runIdFor,
  startTerminalLogTee,
  type RunStoreDeps,
  type TerminalLogTee,
} from "./run-store.ts";
import { makePipelineRunId } from "./traceability.ts";
import { parseOverrideArg } from "./review-policy.ts";
import { emitHumanIntervention, blockerKindToInterventionKind } from "./intervention.ts";
import * as planningStage from "./stages/planning.ts";
import * as reviewStage from "./stages/review.ts";
import * as fixStage from "./stages/fix.ts";
import * as preMergeStage from "./stages/pre_merge.ts";
import * as evalStage from "./stages/eval.ts";
import * as shipchecKStage from "./stages/shipcheck.ts";
import * as deployReady from "./stages/deploy_ready.ts";
import * as autoRecover from "./stages/auto_recover.ts";
import {
  reviewStageSkipTarget,
  type Outcome,
  type PipelineConfig,
  type Stage,
  type StageOutcome,
} from "./types.ts";
import type { CliOpts } from "./pipeline.ts";

// ---------------------------------------------------------------------------
// Module-level constants (local to this module)
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 12;

// Same string as pipeline.ts's REVIEW_CEILING_MARKER — kept in sync manually.
// Defining a local copy avoids a runtime circular import with pipeline.ts.
const REVIEW_CEILING_MARKER = "## Pipeline: Review ceiling reached";

// ---------------------------------------------------------------------------
// Bounded auto-loop helpers (#149) — pure functions, exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * A non-advancing outcome is auto-loop recoverable when it is `waiting` (the
 * stage explicitly signals a retriable temporary state) or `blocked` with a
 * pipeline-owned recovery (i.e. blockerKind is set and is not `needs-human`).
 * Non-recoverable: `error`, `no-op`, `finalized`, and any `blocked` outcome
 * whose blockerKind is `needs-human` or absent (absent → treated as
 * non-recoverable so unannotated stages cannot be silently auto-retried).
 */
export function isAutoLoopRecoverable(out: Outcome): boolean {
  if (out.advanced) return false;
  if (out.status === "waiting") return true;
  if (out.status !== "blocked") return false;
  // Missing blockerKind is treated as non-recoverable (same as needs-human):
  // the pipeline cannot determine a recovery recipe for an unannotated blocker.
  if (!out.blockerKind) return false;
  return out.blockerKind !== "needs-human";
}

/**
 * Decide whether the auto-loop should continue past this outcome at this stage.
 * `plan-review` and `shipcheck-gate` are human-judgment checkpoints and are never
 * eligible even when allowlisted: plan-review's `waiting` return means "a human
 * must review the plan", and a shipcheck verdict failure must not be silently
 * re-run on reviewer nondeterminism (#302) — a failed shipcheck requires a human
 * disposition, not an automatic retry that could flip to pass on a later pass.
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
  /** Inject a fake transitions-log writer in unit tests; real runs use the file-backed writer. */
  logTransition?: (line: string) => void;
  /** Override the issue number used to derive the transitions log path (for PR→issue resolution). */
  transitionsLogN?: number;
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

/** ISO 8601 timestamp at seconds precision (matches the CLI's other stamps). */
function evidenceTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
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
 * Post a single comment recording the local evidence-bundle path so a maintainer
 * can find it (#147). Targets the PR when one exists, else the issue. Skipped when
 * a notification was already recorded for this run; marks the bundle notified
 * after posting. Best-effort — wrapped by the caller.
 */
async function notifyBundlePath(
  cfg: PipelineConfig,
  issueNumber: number,
  stateDir: string,
  alreadyNotifiedAt: string | null,
): Promise<void> {
  if (alreadyNotifiedAt) return;
  const p = bundlePath(stateDir, issueNumber);
  const body = [
    "## Pipeline: Evidence bundle",
    "",
    `Run evidence written to: \`${p}\``,
    "",
    `Print a human-readable summary with \`${cfg.invocation} ${issueNumber} --summary\`.`,
    "",
    "---",
    "*Automated by Claude Code Pipeline Skill*",
  ].join("\n");
  const pr = await getPrForIssue(cfg, issueNumber).catch(() => null);
  if (pr) {
    await postPrComment(cfg, pr, body);
  } else {
    await postComment(cfg, issueNumber, body);
  }
  await markNotified(stateDir, issueNumber);
}

/** The review round recorded in a ceiling comment — local copy for runAdvance use.
 *  The exported version in pipeline.ts is the canonical one; this avoids a circular import. */
function ceilingRound(body: string): 1 | 2 | null {
  const m = body.match(/^Review ([12]) re-ran /m);
  return m ? (Number(m[1]) as 1 | 2) : null;
}

// ---------------------------------------------------------------------------
// Stage dispatch
// ---------------------------------------------------------------------------

export async function dispatch(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  opts: CliOpts,
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
    case "review-1":
      return reviewStage.advanceReview(cfg, issueNumber, 1, { dryRun, model, stateDir, runDir, runStoreDeps });
    case "review-2":
      return reviewStage.advanceReview(cfg, issueNumber, 2, { dryRun, model, stateDir, runDir, runStoreDeps });
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
    case "eval-gate":
      return evalStage.advanceEval(cfg, issueNumber, { dryRun, stateDir, runDir, runStoreDeps });
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
    case "implementing":
      // Re-entry: if a worktree with commits exists, resume the post-implementation
      // steps (gate → push → PR → review-1) without re-planning or re-implementing.
      // Falls back to "waiting" when no such worktree exists (mid-flight guard).
      return planningStage.dispatchResume(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
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
  opts: CliOpts,
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
    if (!opts.dryRun) await ensurePipelineLabels(cfg);
    try {
    const startDetail = await getIssueDetail(cfg, issueNumber);
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

    // Transitions log (#324): append lifecycle lines to a dedicated per-issue file so
    // operators can `tail -f` without a grep filter. Skipped under --dry-run (stateDir
    // undefined). The injected seam (deps.logTransition) lets unit tests use a fake.
    const logT = deps.logTransition ?? (stateDir ? makeTransitionsLogger(transitionsLogPath(cfg.domain, deps.transitionsLogN ?? issueNumber)) : undefined);
    function tlog(line: string): void {
      console.log(line);
      // Mirror only a single physical lifecycle line to the transitions log.
      // Blocked-outcome reason fields can embed newlines with non-lifecycle gate output;
      // the done line uses a leading \n for terminal visual spacing. Both are stripped
      // here so only the [pipeline] #N: header appears in the transitions log (#324).
      logT?.(singleLifecycleLine(line));
    }

    // Run directory (#155): stable artifact directory per dispatch. Initialized
    // before the first stage so it survives a mid-run crash. Also starts the
    // terminal.log tee here so it captures all subsequent output including the
    // 'starting' and 'run id' lines below. Skipped under --dry-run.
    // runStoreDeps is mutated after the tee starts so --json-events events bypass it.
    let runDir: string | undefined;
    let terminalTee: TerminalLogTee | undefined;
    const runStoreDeps: RunStoreDeps = { ...defaultRunStoreDeps };
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
      await initRunDir(
        { runDir, runId, issue: issueNumber, repo: cfg.repo, profile: opts.profile ?? null, startedAt: runStartedAtIso },
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

    // Outer try/finally: stop tee only AFTER the final 'done' line is printed so
    // that line is captured in terminal.log (the inner finally runs first).
    try {

    tlog(`[pipeline] #${issueNumber}: starting at stage=${startStage}`);

    // One run id per dispatch (#20): generated before any stage runs and threaded
    // into every commit operation, so all commits this invocation produces — across
    // every stage and re-entry of the loop — carry the same `Pipeline-Run:` trailer.
    const pipelineRunId = makePipelineRunId(issueNumber, runStartedAt);
    setGhRunId(pipelineRunId);
    tlog(`[pipeline] #${issueNumber}: run id ${pipelineRunId}`);

    if (stateDir) {
      let bundlePr: number | null = null;
      try {
        bundlePr = await getPrForIssue(cfg, issueNumber);
      } catch {
        /* no PR yet, or lookup failed — record null */
      }
      const startWt = await getOnDiskForIssue(cfg, issueNumber).catch(() => null);
      const bundleBranch = startWt ? branchName(issueNumber, startWt.slug) : null;
      const harnesses = Array.from(new Set([cfg.harnesses.implementer, cfg.harnesses.reviewer]));
      await createBundle(stateDir, {
        runId: pipelineRunId,
        issue: issueNumber,
        pr: bundlePr,
        branch: bundleBranch,
        harnesses,
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
    try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const detail = await getIssueDetail(cfg, issueNumber);
      const stage = pickStage(detail.labels);
      if (!stage) {
        tlog(`[pipeline] #${issueNumber}: pipeline label removed; stopping.`);
        break;
      }
      finalStage = stage;

      // Reconcile audit comments (#259): if a prior run's label write succeeded but its
      // comment post failed, the sentinel is missing. Detect and repair the gap.
      // Resolve the pipeline's own GitHub actor once so a sentinel is only trusted from a
      // pipeline-authored comment — body-prefix text alone is forgeable (security review).
      const auditTrustedActor = opts.dryRun ? null : await getGhActor();
      // Skip stage-sentinel repair for manually-applied entry-point stages ("ready", "backlog")
      // since those are never created by transition() and have no sentinel to repair.
      if (!opts.dryRun && stage !== "ready" && stage !== "backlog") {
        const repairBody = [
          `## Pipeline: Audit Repair`,
          ``,
          `The audit sentinel for stage \`${stage}\` was missing from the recent comment history. Posting retroactively.`,
          ``,
          buildAuditSentinel(pipelineRunId, stage),
          ``,
          `---`,
          `*Automated by Claude Code Pipeline Skill*`,
        ].join("\n");
        await reconcileAuditComment(
          cfg, issueNumber, stage, pipelineRunId, repairBody, detail.comments, auditTrustedActor,
        );
      }
      // Blocked-sentinel repair runs regardless of stage — an issue can be blocked while at
      // pipeline:ready (label write succeeded, comment post failed) and we must not skip it.
      if (!opts.dryRun && isBlocked(detail.labels)) {
        const blockedRepairBody = [
          `## Pipeline: Blocked (audit repair)`,
          ``,
          `The audit sentinel for \`blocked\` state was missing from the recent comment history. Posting retroactively.`,
          ``,
          `> **Note**: The original block reason could not be recovered — the blocker comment was not recorded.`,
          ``,
          `### How to unblock`,
          `Remove the \`pipeline:blocked\` label and re-apply the active stage label (e.g. \`pipeline:fix-1\`) to resume the pipeline.`,
          ``,
          buildAuditSentinel(pipelineRunId, "blocked"),
          ``,
          `---`,
          `*Automated by Claude Code Pipeline Skill*`,
        ].join("\n");
        await reconcileAuditComment(
          cfg, issueNumber, "blocked", pipelineRunId, blockedRepairBody, detail.comments, auditTrustedActor,
        );
      }

      if (stage === "ready-to-deploy") {
        // The terminal stage is handled outside the common dispatch block, so emit
        // its stage_start / stage_complete lifecycle events explicitly — otherwise a
        // consumer cannot reconstruct the full ordered timeline from events.jsonl (#155).
        const rtdStage = evidenceStageName(stage);
        const rtdEnteredAt = evidenceTimestamp();
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
        printOutcome(issueNumber, stage, out, tlog);
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
        break;
      }

      if (isBlocked(detail.labels)) {
        if (stage === "implementing") {
          console.log(`[pipeline] #${issueNumber}: blocked at implementing — attempting auto-recovery`);
          const out = await autoRecover.tryAutoRecover(cfg, issueNumber, stateDir);
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
        const wtBefore = await getOnDiskForIssue(cfg, issueNumber).catch(() => null);
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
        out = await dispatch(cfg, issueNumber, stage, opts, pipelineRunId, stateDir, runDir, runStoreDeps);
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
        throw err;
      }

      // Post-dispatch: collect commits produced during this stage (before recording exit).
      // stageCommits is declared outside the stateDir block so it is also available
      // for the stage_complete event appended to events.jsonl below.
      const stageExitedAt = evidenceTimestamp();
      let stageCommits: string[] = [];
      if (!dispatchOwnsLifecycle && stateDir) {
        const wtAfter = await getOnDiskForIssue(cfg, issueNumber).catch(() => null);
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
              [
                `## Pipeline: Auto-Loop Continuation (${autoLoopRoundsSpent}/${cfg.auto_loop.max_rounds})`,
                "",
                `Automatically continuing past recoverable stop at \`${stage}\`:`,
                `- **Reason**: ${out.reason}`,
                `- **Rounds remaining**: ${roundsRemaining}`,
                `- **Wall-clock remaining**: ${minutesRemaining.toFixed(1)} minutes`,
                "",
                "---",
                cfg.marker_footer,
              ].join("\n"),
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
          // Budget exhausted after at least one continuation: park at needs-human.
          const elapsedMinutes = (nowFn() - t0) / 60_000;
          console.log(
            `[pipeline] #${issueNumber}: auto-loop budget exhausted after ${autoLoopRoundsSpent} ` +
            `continuation(s) — parking at needs-human`,
          );
          if (!opts.dryRun) {
            await transition(cfg, issueNumber, stage, "needs-human", "auto-loop budget exhausted");
            await clearBlocked(cfg, issueNumber).catch(() => {});
            finalStage = "needs-human";
            await postComment(
              cfg,
              issueNumber,
              [
                "## Pipeline: Auto-Loop Budget Exhausted",
                "",
                `The bounded auto-loop ran ${autoLoopRoundsSpent}/${cfg.auto_loop.max_rounds} round(s) and cannot continue:`,
                `- **Stage**: \`${stage}\``,
                `- **Last outcome**: ${out.status} — ${out.reason}`,
                `- **Rounds used**: ${autoLoopRoundsSpent} / ${cfg.auto_loop.max_rounds}`,
                `- **Time used**: ${elapsedMinutes.toFixed(1)} / ${cfg.auto_loop.max_wallclock_minutes} minutes`,
                "",
                "The issue is parked at `needs-human`. To resume:",
                "- Fix the underlying issue and re-run `pipeline <N>` after relabeling to the appropriate stage.",
                "- Or record an audited disposition with `--override \"<key>: <reason>\"` if applicable.",
                "",
                "---",
                cfg.marker_footer,
              ].join("\n"),
            ).catch(() => {});
            if (runDir) {
              await emitHumanIntervention(runDir, {
                kind: blockerKindToInterventionKind(out.status === "blocked" ? (out.blockerKind ?? "needs-human") : "needs-human"),
                stage: auditStage,
                issue: issueNumber,
                detail: `auto-loop budget exhausted after ${autoLoopRoundsSpent}/${cfg.auto_loop.max_rounds} rounds: ${out.reason}`,
              }, runStoreDeps).catch(() => {});
            }
            if (stateDir) {
              await recordRecovery(stateDir, issueNumber, {
                trigger: "bounded-auto-loop:exhausted",
                round: autoLoopRoundsSpent + 1,
                at: evidenceTimestamp(),
              }).catch(() => {});
            }
          }
        } else {
          // Not eligible or no rounds spent: stop as today.
          if (out.status === "blocked" && runDir) {
            await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "blocker_set", at: evidenceTimestamp(), reason: out.reason }, runStoreDeps).catch(() => {});
            await emitHumanIntervention(runDir, {
              kind: blockerKindToInterventionKind(out.blockerKind ?? "needs-human"),
              stage: auditStage,
              issue: issueNumber,
              detail: out.reason,
            }, runStoreDeps).catch(() => {});
          }
        }
        break;
      }

      if (opts.once) break;
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
          const latestPr = await getPrForIssue(cfg, issueNumber).catch(() => null);
          const latestWt = await getOnDiskForIssue(cfg, issueNumber).catch(() => null);
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
          await notifyBundlePath(cfg, issueNumber, stateDir, finalized.notifiedAt);
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
    }
    },
    issueNumber,
  );
}
