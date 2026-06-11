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
import { Command } from "commander";
import { resolveConfig, scaffoldDefaultConfig } from "./config.ts";
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
import { overrideComment, parseOverrideArg } from "./review-policy.ts";
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

// Package version, single-sourced from package.json so a version bump is reflected
// automatically. The path is `../package.json` (core/package.json) and is mirror-safe:
// build.mjs copies `package.json` alongside `scripts/` into the generated plugin, so the
// same relative path resolves in both the dev and installed layouts.
const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

interface CliOpts {
  status?: boolean;
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
}

async function main(): Promise<void> {
  const cmd = new Command();
  cmd
    .name("pipeline")
    .description("Advance a GitHub issue/PR through the pipeline state machine.")
    .version(VERSION, "-V, --version", "print version and exit")
    .argument("[number]", "issue or PR number (required unless --cleanup)")
    .option("--cleanup", "sweep pipeline-managed worktrees whose PR is merged and exit")
    .option("--init", "ensure pipeline labels and scaffold .github/pipeline.yml (no issue number required)")
    .option("--status", "read-only status; print stage and exit")
    .option("--unblock <answer>", "post answer as a comment and clear the blocked label")
    .option(
      "--override <spec>",
      'disposition a review finding so it no longer blocks: "<override-key>: <reason>" (key from the review comment; reason may lead with "rejected" or "deferred #N")',
    )
    .option("--once", "advance one stage and stop")
    .option("--dry-run", "log what would happen without invoking harnesses or modifying GitHub")
    .option("--domain <name>", "override domain name (default: repo dir basename)")
    .option("--repo-path <path>", "override the target repo working tree")
    .option("--base <branch>", "override the base branch (default: from .github/pipeline.yml or 'main')")
    .option("--model <model>", "override the review/fix model when supported by the selected harness")
    .option("--profile <name>", "shared-core profile to use: codex or claude", process.env.PIPELINE_PROFILE ?? "codex")
    .parse(process.argv);

  const opts = cmd.opts<CliOpts>();
  const numArg = cmd.args[0];
  const isInit = opts.init || numArg === "init";

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

  if (isInit) {
    await runInit(cfg);
    return;
  }

  const number = Number.parseInt(numArg ?? "", 10);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(`pipeline: argument <number> is required (or use --cleanup, --init, or 'pipeline init')`);
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
  if (!opts.dryRun && opts.unblock === undefined && opts.override === undefined) {
    await ensurePipelineLabels(cfg);
  }
  if (opts.unblock !== undefined) {
    await runUnblock(cfg, issueNumber, opts.unblock);
    return;
  }
  if (opts.override !== undefined) {
    await runOverride(cfg, issueNumber, opts.override);
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
  console.log(`[pipeline] init: pipeline labels ensured in ${cfg.repo}.`);
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

/** First line of the punch-list comment posted when a review round hits the
 *  round ceiling and parks the item at `needs-human` (emitted by review.ts's
 *  `reviewCeilingComment`). A controlled string the pipeline owns end-to-end. */
const REVIEW_CEILING_MARKER = "## Pipeline: Review ceiling reached";

/** IO seam for {@link runStatus} so unit tests inject fakes — no real gh. */
export interface RunStatusDeps {
  getIssueDetail: typeof getIssueDetail;
  getPrForIssue: typeof getPrForIssue;
}

const defaultRunStatusDeps: RunStatusDeps = { getIssueDetail, getPrForIssue };

export async function runStatus(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: RunStatusDeps = defaultRunStatusDeps,
): Promise<void> {
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
          `Override (\`--override "<key>: <reason>"\`) or fix the residual findings, then relabel ` +
          `\`pipeline:needs-human\` → \`pipeline:review-2\` to resume.`,
    );
  }
}

/**
 * Pure helper (#115): build the `needs-human` punch-list from the issue's
 * comments — the count of still-blocking findings plus the resume steps. Reads
 * only controlled strings the pipeline itself emits in the latest
 * `## Pipeline: Review ceiling reached` comment; returns `null` when no such
 * comment exists (the caller prints a graceful fallback). Total function: no
 * network, git, or subprocess calls.
 */
export function needsHumanPunchlist(
  comments: { author: string; body: string; createdAt: string }[],
): string | null {
  // Latest ceiling comment wins (highest index): a re-run posts a fresh one.
  let body: string | undefined;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.startsWith(REVIEW_CEILING_MARKER)) {
      body = comments[i].body;
      break;
    }
  }
  if (body === undefined) return null;

  const count = countCeilingFindings(body);
  const noun = count === 1 ? "finding" : "findings";
  return [
    `Needs human: ${count} unresolved blocking ${noun} from the review ceiling.`,
    `To resume: accept a finding with \`--override "<key>: <reason>"\` (audited) or fix it by hand,`,
    `then relabel \`pipeline:needs-human\` → \`pipeline:review-2\`.`,
  ].join("\n");
}

/** Count the `- ` bullets under the controlled `### Unresolved blocking findings`
 *  heading, stopping at the next `### ` section. */
function countCeilingFindings(body: string): number {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### Unresolved blocking findings");
  if (start === -1) return 0;
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### ")) break; // next section ends the list
    if (lines[i].startsWith("- ")) count++;
  }
  return count;
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
// Override mode (#17): disposition a review finding so it no longer blocks
// ---------------------------------------------------------------------------

async function runOverride(cfg: PipelineConfig, issueNumber: number, spec: string): Promise<void> {
  const parsed = parseOverrideArg(spec);
  if ("error" in parsed) {
    console.error(`pipeline: ${parsed.error}`);
    process.exit(2);
  }
  const detail = await getIssueDetail(cfg, issueNumber);
  const stage = pickStage(detail.labels) ?? "(unknown)";
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const body = overrideComment({
    key: parsed.key,
    disposition: parsed.disposition,
    reason: parsed.reason,
    stage,
    timestamp: ts,
    footer: cfg.marker_footer,
  });
  await postComment(cfg, issueNumber, body);
  // If the item is blocked (e.g. a review round blocked on this finding), clear
  // the blocker so a subsequent run can re-evaluate with the override applied.
  if (isBlocked(detail.labels)) {
    await clearBlocked(cfg, issueNumber);
  }
  console.log(
    `[pipeline] #${issueNumber}: recorded override for finding ${parsed.key} (${parsed.disposition}). ` +
      `Re-run the pipeline to advance with the override applied.`,
  );
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

      if (stage === "needs-human") {
        console.log(
          `[pipeline] #${issueNumber}: parked at needs-human — a review round hit the round ceiling. ` +
            `Override (--override) or fix the residual findings, then relabel pipeline:needs-human → pipeline:review-2 to resume.`,
        );
        const ceiling = [...detail.comments]
          .reverse()
          .find((c) => c.body.startsWith(REVIEW_CEILING_MARKER));
        if (ceiling) console.log(ceiling.body);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Internal exports for tests (state-transition table tests).
// ---------------------------------------------------------------------------

export const _internals = { dispatch, runInit };

// Suppress unused import warnings for test-only helpers.
void addLabel;
