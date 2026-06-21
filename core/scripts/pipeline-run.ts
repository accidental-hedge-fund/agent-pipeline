// Advance-loop lifecycle service. Encapsulates the per-issue run lifecycle that
// was previously inlined in pipeline.ts's runAdvance: locking, GhMetrics setup,
// ensurePipelineLabels, evidence bundle, run directory, terminal log tee,
// stage-loop with audit-sentinel repair and auto-loop, event writes, and
// finalization. The CLI layer (pipeline.ts) calls runAdvance with resolved
// values; no Commander types cross this boundary.
//
// IMPORTANT: This module must never import from pipeline.ts or commander.
// The one-way dependency (CLI → service) is enforced by a unit test.

import * as path from "node:path";
import type { CliOpts } from "./cli-types.ts";
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
import { runStateDir, withLock } from "./lock.ts";
import { parseOverrideArg } from "./review-policy.ts";
import { makePipelineRunId } from "./traceability.ts";
import { branchName, getForIssue, gitInWorktree } from "./worktree.ts";
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

// ---------------------------------------------------------------------------
// Shared string constant — owned here and re-exported so pipeline.ts's
// runStatus / runOverride / needsHumanPunchlist can reference it without
// importing from this module in the wrong direction.
// ---------------------------------------------------------------------------

/** First line of the punch-list comment posted when a review round hits the
 *  round ceiling and parks the item at `needs-human` (emitted by review.ts's
 *  `reviewCeilingComment`). A controlled string the pipeline owns end-to-end. */
export const REVIEW_CEILING_MARKER = "## Pipeline: Review ceiling reached";

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

// ---------------------------------------------------------------------------
// Bounded auto-loop helpers (#149) — pure functions, exported for unit tests.
// ---------------------------------------------------------------------------

export const MAX_ITERATIONS = 12;

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
 * `plan-review` is a human-feedback checkpoint and is never eligible even when
 * allowlisted, because its `waiting` return means "a human must review the plan".
 */
export function isAutoLoopEligible(
  out: Outcome,
  stage: Stage,
  autoLoop: PipelineConfig["auto_loop"],
): boolean {
  if (!autoLoop.enabled) return false;
  if (!isAutoLoopRecoverable(out)) return false;
  if (stage === "plan-review") return false;
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
}

// ---------------------------------------------------------------------------
// Advance mode
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

    console.log(`[pipeline] #${issueNumber}: starting at stage=${startStage}`);

    // One run id per dispatch (#20): generated before any stage runs and threaded
    // into every commit operation, so all commits this invocation produces — across
    // every stage and re-entry of the loop — carry the same `Pipeline-Run:` trailer.
    const pipelineRunId = makePipelineRunId(issueNumber, runStartedAt);
    setGhRunId(pipelineRunId);
    console.log(`[pipeline] #${issueNumber}: run id ${pipelineRunId}`);

    if (stateDir) {
      let bundlePr: number | null = null;
      try {
        bundlePr = await getPrForIssue(cfg, issueNumber);
      } catch {
        /* no PR yet, or lookup failed — record null */
      }
      const startWt = await getForIssue(cfg, issueNumber).catch(() => null);
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
          await recordOverride(stateDir, issueNumber, {
            key: parsedOverride.key,
            reason: parsedOverride.reason,
          }).catch(() => {});
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
        console.log(`[pipeline] #${issueNumber}: pipeline label removed; stopping.`);
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
        printOutcome(issueNumber, stage, out);
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
          printOutcome(issueNumber, stage, out);
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
        console.log(`[pipeline] #${issueNumber}: ${stage} → ${to} (step disabled)`);
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

      // Pre-dispatch: capture worktree HEAD so we can record which commits the stage produced.
      let headBeforeDispatch = "";
      if (stateDir) {
        const wtBefore = await getForIssue(cfg, issueNumber).catch(() => null);
        if (wtBefore) {
          headBeforeDispatch = (
            await gitInWorktree(wtBefore.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
          ).stdout.trim();
        }
      }

      const auditStage = evidenceStageName(stage);
      const stageEnteredAt = evidenceTimestamp();
      if (stateDir) {
        await recordStage(stateDir, issueNumber, {
          stage: auditStage,
          enteredAt: stageEnteredAt,
        }).catch(() => {});
      }
      if (runDir) {
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at: stageEnteredAt, stage: auditStage }, runStoreDeps).catch(() => {});
      }
      let out: Outcome;
      try {
        out = await dispatch(cfg, issueNumber, stage, opts, pipelineRunId, stateDir, runDir, runStoreDeps);
      } catch (err) {
        // Stage threw — record an error outcome before rethrowing so the bundle
        // never shows a perpetually in-progress stage.
        const errAt = evidenceTimestamp();
        if (stateDir) {
          await recordStage(stateDir, issueNumber, {
            stage: auditStage,
            exitedAt: errAt,
            outcome: "error",
            commits: [],
          }).catch(() => {});
        }
        if (runDir) {
          await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: errAt, stage: auditStage, outcome: "error", commits: [] }, runStoreDeps).catch(() => {});
        }
        throw err;
      }

      // Post-dispatch: collect commits produced during this stage (before recording exit).
      // stageCommits is declared outside the stateDir block so it is also available
      // for the stage_complete event appended to events.jsonl below.
      const stageExitedAt = evidenceTimestamp();
      let stageCommits: string[] = [];
      if (stateDir) {
        const wtAfter = await getForIssue(cfg, issueNumber).catch(() => null);
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
      if (runDir) {
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "stage_complete", at: stageExitedAt, stage: auditStage, outcome: evidenceOutcome(out), commits: stageCommits }, runStoreDeps).catch(() => {});
      }
      printOutcome(issueNumber, stage, out);

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
          const latestWt = await getForIssue(cfg, issueNumber).catch(() => null);
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
    console.log(
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

// ---------------------------------------------------------------------------
// Private helpers for the advance loop
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

/** Audit stage name for a dispatched label. The `ready` label drives the
 *  planning+implementation arc, so record it under the clearer name "planning"
 *  — the same name the test gate records its commands under, so they merge. */
function evidenceStageName(stage: Stage): string {
  return stage === "ready" ? "planning" : stage;
}

/** ISO 8601 timestamp at seconds precision (matches the CLI's other stamps). */
function evidenceTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
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

export async function dispatch(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  opts: CliOpts,
  pipelineRunId: string,
  stateDir?: string,
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
): Promise<Outcome> {
  const dryRun = !!opts.dryRun;
  const model = opts.model;
  switch (stage) {
    case "ready":
      return planningStage.advance(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    case "review-1":
      return reviewStage.advanceReview(cfg, issueNumber, 1, { dryRun, model, stateDir, runDir, runStoreDeps });
    case "review-2":
      return reviewStage.advanceReview(cfg, issueNumber, 2, { dryRun, model, stateDir, runDir, runStoreDeps });
    case "fix-1":
      return fixStage.advanceFix(cfg, issueNumber, 1, { dryRun, model, pipelineRunId, stateDir });
    case "fix-2":
      return fixStage.advanceFix(cfg, issueNumber, 2, { dryRun, model, pipelineRunId, stateDir });
    case "pre-merge":
      // Use the polling wrapper, not bare advance(). Bare advance returns
      // "waiting" after docs push / on pending CI / after rebase — that
      // pattern was inherited from openclaw's 30-min cron model and would
      // exit the loop, requiring the user to re-invoke. Our skill is
      // manual-only, so pre-merge owns the wait itself, capped at
      // cfg.ci_timeout.
      return preMergeStage.advancePolling(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir });
    case "eval-gate":
      return evalStage.advanceEval(cfg, issueNumber, { dryRun, stateDir });
    case "shipcheck-gate":
      return shipchecKStage.advance(cfg, issueNumber, { dryRun, stateDir });
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
    case "plan-review":
      return {
        advanced: false,
        status: "waiting",
        reason: `${stage} is set mid-flight by the planning/plan-review handler; nothing to do at this point.`,
      };
    case "implementing":
      // Re-entry: if a worktree with commits exists, resume the post-implementation
      // steps (gate → push → PR → review-1) without re-planning or re-implementing.
      // Falls back to "waiting" when no such worktree exists (mid-flight guard).
      return planningStage.dispatchResume(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir, runStoreDeps });
    default:
      return { advanced: false, status: "error", reason: `unknown stage ${stage}` };
  }
}

function printOutcome(issueNumber: number, fromStage: Stage, out: Outcome): void {
  if (out.advanced) {
    const oo = out as { from: Stage; to: Stage; summary: string };
    console.log(`[pipeline] #${issueNumber}: ${oo.from} → ${oo.to}: ${oo.summary}`);
  } else {
    const oo = out as { status: string; reason: string };
    console.log(`[pipeline] #${issueNumber}: at ${fromStage} — ${oo.status}: ${oo.reason}`);
  }
}
