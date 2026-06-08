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

import { Command } from "commander";
import { resolveConfig } from "./config.ts";
import {
  addLabel,
  clearBlocked,
  getIssueDetail,
  getItemKind,
  getPrForIssue,
  getPrLinkedIssue,
  ensurePipelineLabels,
  isBlocked,
  pickStage,
  postComment,
  transition,
} from "./gh.ts";
import { isKillSwitchActive, withLock } from "./lock.ts";
import { makePipelineRunId } from "./traceability.ts";
import { sweepMergedWorktrees } from "./worktree.ts";
import * as planningStage from "./stages/planning.ts";
import * as reviewStage from "./stages/review.ts";
import * as fixStage from "./stages/fix.ts";
import * as preMergeStage from "./stages/pre_merge.ts";
import * as evalStage from "./stages/eval.ts";
import * as deployReady from "./stages/deploy_ready.ts";
import * as autoRecover from "./stages/auto_recover.ts";
import { LABEL_PREFIX, reviewStageSkipTarget, type Outcome, type PipelineConfig, type Stage } from "./types.ts";

const MAX_ITERATIONS = 12;

interface CliOpts {
  status?: boolean;
  unblock?: string;
  once?: boolean;
  dryRun?: boolean;
  domain?: string;
  repoPath?: string;
  base?: string;
  model?: string;
  profile?: string;
  cleanup?: boolean;
}

async function main(): Promise<void> {
  const cmd = new Command();
  cmd
    .name("pipeline")
    .description("Advance a GitHub issue/PR through the pipeline state machine.")
    .argument("[number]", "issue or PR number (required unless --cleanup)")
    .option("--cleanup", "sweep pipeline-managed worktrees whose PR is merged and exit")
    .option("--status", "read-only status; print stage and exit")
    .option("--unblock <answer>", "post answer as a comment and clear the blocked label")
    .option("--once", "advance one stage and stop")
    .option("--dry-run", "log what would happen without invoking harnesses or modifying GitHub")
    .option("--domain <name>", "override domain name (default: repo dir basename)")
    .option("--repo-path <path>", "override the target repo working tree")
    .option("--base <branch>", "override the base branch (default: from .github/pipeline.yml or 'main')")
    .option("--model <model>", "override the review/fix model when supported by the selected harness")
    .option("--profile <name>", "shared-core profile to use: codex, claude, or openclaw", process.env.PIPELINE_PROFILE ?? "codex")
    .parse(process.argv);

  const opts = cmd.opts<CliOpts>();
  const numArg = cmd.args[0];

  let cfg: PipelineConfig;
  try {
    cfg = resolveConfig({
      repoPath: opts.repoPath,
      domainOverride: opts.domain,
      baseBranch: opts.base,
      profile: opts.profile,
    });
  } catch (err) {
    const e = err as Error;
    console.error(`pipeline: ${e.message}`);
    process.exit(2);
  }

  if (opts.cleanup) {
    await runCleanup(cfg);
    return;
  }

  const number = Number.parseInt(numArg ?? "", 10);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(`pipeline: argument <number> is required (or use --cleanup)`);
    process.exit(2);
  }

  if (isKillSwitchActive(cfg.domain)) {
    console.error(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    process.exit(0);
  }

  // Resolve N → issue number.
  let issueNumber: number;
  try {
    issueNumber = await resolveIssueNumber(cfg, number);
  } catch (err) {
    const e = err as Error;
    console.error(`pipeline: ${e.message}`);
    process.exit(1);
  }

  // ---- Mode dispatch ----
  if (opts.status) {
    await runStatus(cfg, issueNumber);
    return;
  }
  if (!opts.dryRun && opts.unblock === undefined) {
    await ensurePipelineLabels(cfg);
  }
  if (opts.unblock !== undefined) {
    await runUnblock(cfg, issueNumber, opts.unblock);
    return;
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

async function resolveIssueNumber(cfg: PipelineConfig, number: number): Promise<number> {
  const kind = await getItemKind(cfg, number);
  if (kind === "issue") return number;
  // PR → look up linked closing issue.
  const linked = await getPrLinkedIssue(cfg, number);
  if (linked === null) {
    throw new Error(
      `#${number} is a PR with no closing-issue reference. The pipeline is issue-centric. ` +
        `${cfg.invocation}: either add "Closes #<n>" to the PR body, or run against the issue directly.`,
    );
  }
  console.log(`[pipeline] #${number} is a PR → resolved to issue #${linked}`);
  return linked;
}

// ---------------------------------------------------------------------------
// Status mode
// ---------------------------------------------------------------------------

async function runStatus(cfg: PipelineConfig, issueNumber: number): Promise<void> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const stage = pickStage(detail.labels);
  const blocked = isBlocked(detail.labels);
  const prNumber = await getPrForIssue(cfg, issueNumber);

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
}

// ---------------------------------------------------------------------------
// Unblock mode
// ---------------------------------------------------------------------------

async function runUnblock(cfg: PipelineConfig, issueNumber: number, answer: string): Promise<void> {
  const detail = await getIssueDetail(cfg, issueNumber);
  if (!isBlocked(detail.labels)) {
    console.log(`#${issueNumber}: not blocked — nothing to do.`);
    return;
  }
  const stage = pickStage(detail.labels) ?? "(unknown)";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const body = [
    "## Pipeline: Unblocked",
    "",
    `**Stage**: ${stage}`,
    `**Unblocked at**: ${ts}`,
    "",
    "### Human input",
    answer,
    "",
    "---",
    "*Automated by Claude Code Pipeline Skill*",
  ].join("\n");
  await postComment(cfg, issueNumber, body);
  await clearBlocked(cfg, issueNumber);
  console.log(`[pipeline] #${issueNumber}: unblocked at ${stage}`);
}

// ---------------------------------------------------------------------------
// Advance mode
// ---------------------------------------------------------------------------

async function runAdvance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: CliOpts,
): Promise<void> {
  await withLock(
    cfg.domain,
    async () => {
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

    console.log(`[pipeline] #${issueNumber}: starting at stage=${startStage}`);
    let lastStage: Stage = startStage;
    let transitions = 0;
    const t0 = Date.now();

    // One run id per dispatch (#20): generated before any stage runs and threaded
    // into every commit operation, so all commits this invocation produces — across
    // every stage and re-entry of the loop — carry the same `Pipeline-Run:` trailer.
    const pipelineRunId = makePipelineRunId(issueNumber);
    console.log(`[pipeline] #${issueNumber}: run id ${pipelineRunId}`);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const detail = await getIssueDetail(cfg, issueNumber);
      const stage = pickStage(detail.labels);
      if (!stage) {
        console.log(`[pipeline] #${issueNumber}: pipeline label removed; stopping.`);
        break;
      }

      if (stage === "ready-to-deploy") {
        const out = await deployReady.finalize(cfg, issueNumber);
        printOutcome(issueNumber, stage, out);
        break;
      }

      if (isBlocked(detail.labels)) {
        if (stage === "implementing") {
          console.log(`[pipeline] #${issueNumber}: blocked at implementing — attempting auto-recovery`);
          const out = await autoRecover.tryAutoRecover(cfg, issueNumber);
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
          `[pipeline] To unblock: $pipeline ${issueNumber} --unblock "<answer>"`,
        );
        break;
      }

      // #13: skip disabled review stages, keeping a valid forward path.
      if (
        (stage === "review-1" && !cfg.steps.standard_review) ||
        (stage === "review-2" && !cfg.steps.adversarial_review)
      ) {
        const to = reviewStageSkipTarget(cfg, stage);
        await transition(cfg, issueNumber, stage, to, `${stage} step disabled in this repo's config; skipping.`);
        console.log(`[pipeline] #${issueNumber}: ${stage} → ${to} (step disabled)`);
        transitions++;
        lastStage = to;
        if (opts.once) break;
        continue;
      }

      const out = await dispatch(cfg, issueNumber, stage, opts, pipelineRunId);
      printOutcome(issueNumber, stage, out);

      if (out.advanced) {
        transitions++;
        lastStage = (out as { to: Stage }).to;
      } else {
        // No advance: blocked, waiting, no-op, finalized, error → stop.
        break;
      }

      if (opts.once) break;
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(
      `\n[pipeline] #${issueNumber}: done — ${startStage} → ${lastStage} (${transitions} transitions, ${elapsed}s)`,
    );
    },
    issueNumber,
  );
}

async function dispatch(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  opts: CliOpts,
  pipelineRunId: string,
): Promise<Outcome> {
  const dryRun = !!opts.dryRun;
  const model = opts.model;
  switch (stage) {
    case "ready":
      return planningStage.advance(cfg, issueNumber, { dryRun, model, pipelineRunId });
    case "review-1":
      return reviewStage.advanceReview(cfg, issueNumber, 1, { dryRun, model });
    case "review-2":
      return reviewStage.advanceReview(cfg, issueNumber, 2, { dryRun, model });
    case "fix-1":
      return fixStage.advanceFix(cfg, issueNumber, 1, { dryRun, model, pipelineRunId });
    case "fix-2":
      return fixStage.advanceFix(cfg, issueNumber, 2, { dryRun, model, pipelineRunId });
    case "pre-merge":
      // Use the polling wrapper, not bare advance(). Bare advance returns
      // "waiting" after docs push / on pending CI / after rebase — that
      // pattern was inherited from openclaw's 30-min cron model and would
      // exit the loop, requiring the user to re-invoke. Our skill is
      // manual-only, so pre-merge owns the wait itself, capped at
      // cfg.ci_timeout.
      return preMergeStage.advancePolling(cfg, issueNumber, { dryRun, model, pipelineRunId });
    case "eval-gate":
      return evalStage.advanceEval(cfg, issueNumber, { dryRun });
    case "ready-to-deploy":
      return deployReady.finalize(cfg, issueNumber);
    case "backlog":
      return {
        advanced: false,
        status: "waiting",
        reason: "backlog is a triage stage; promote to pipeline:ready manually",
      };
    case "planning":
    case "plan-review":
    case "implementing":
      return {
        advanced: false,
        status: "waiting",
        reason: `${stage} is set mid-flight by the planning/plan-review handler; nothing to do at this point.`,
      };
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Internal exports for tests (state-transition table tests).
// ---------------------------------------------------------------------------

export const _internals = { dispatch };

// Suppress unused import warnings for test-only helpers.
void addLabel;
