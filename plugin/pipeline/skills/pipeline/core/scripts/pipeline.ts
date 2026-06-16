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
import { spawn } from "node:child_process";
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
  postPrComment,
  silentTransition,
  transition,
} from "./gh.ts";
import { isKillSwitchActive, runStateDir, withLock } from "./lock.ts";
import { overrideComment, parseOverrideArg } from "./review-policy.ts";
import { makePipelineRunId } from "./traceability.ts";
import { branchName, getForIssue, gitInWorktree, sweepMergedWorktrees } from "./worktree.ts";
import {
  bundlePath,
  createBundle,
  finalizeBundle,
  markNotified,
  patchBundleIdentity,
  printSummary,
  readBundle,
  recordOverride,
  recordStage,
} from "./evidence-bundle.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  finalizeRun,
  initRunDir,
  listRunIds,
  runDirPath,
  runIdFor,
  runsDir,
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
  formatDoctorSummary,
  loadLatestPreflightResult,
  runPreflight,
  storePreflightResult,
  type PreflightResult,
} from "./stages/doctor.ts";
import {
  LABEL_PREFIX,
  reviewStageSkipTarget,
  type Outcome,
  type PipelineConfig,
  type Stage,
  type StageOutcome,
} from "./types.ts";

const MAX_ITERATIONS = 12;

// Package version, single-sourced from package.json so a version bump is reflected
// automatically. The path is `../package.json` (core/package.json) and is mirror-safe:
// build.mjs copies `package.json` alongside `scripts/` into the generated plugin, so the
// same relative path resolves in both the dev and installed layouts.
const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

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
}

async function main(): Promise<void> {
  const cmd = new Command();
  cmd
    .name("pipeline")
    .description("Advance a GitHub issue/PR through the pipeline state machine.")
    .version(VERSION, "-V, --version", "print version and exit")
    .argument("[number]", "issue or PR number, or a subcommand: init | doctor | logs")
    .allowExcessArguments(true)
    .option("--cleanup", "sweep pipeline-managed worktrees whose PR is merged and exit")
    .option("--init", "ensure pipeline labels and scaffold .github/pipeline.yml (no issue number required)")
    .option("--doctor", "run the deterministic preflight checks before advancing; abort the run on any failure")
    .option("--fail-fast", "doctor: stop at the first failing check instead of collecting all failures")
    .option("--status", "read-only status; print stage and exit")
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
    .option("-f, --follow", "follow mode for 'pipeline logs <run-id> --follow': stream new output as appended")
    .parse(process.argv);

  const opts = cmd.opts<CliOpts>();
  const numArg = cmd.args[0];
  const isInit = opts.init || numArg === "init";
  // `pipeline doctor` is a standalone command (like `init`): it runs the
  // preflight checks and exits, with no issue number. Distinct from the
  // `--doctor` flag, which gates a real advance run.
  const isDoctorCommand = numArg === "doctor";

  // `pipeline logs [<run-id>] [-f]` is independent of the original pipeline process
  // and must work even when gh is missing, unauthenticated, or the remote is
  // unavailable. Handle it before config/gh resolution using only the repo directory
  // (derived from --repo-path or cwd).
  if (numArg === "logs") {
    const repoDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const logsArg = cmd.args[1];
    const logsRunId =
      typeof logsArg === "string" && logsArg.length > 0 && !logsArg.startsWith("-")
        ? logsArg
        : undefined;
    await runLogs(repoDir, logsRunId, !!opts.follow);
    return;
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
      console.log(formatDoctorSummary(result));
      process.exit(1);
    }
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

  if (isDoctorCommand) {
    await runDoctor(cfg, opts);
    return;
  }

  const number = Number.parseInt(numArg ?? "", 10);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(
      `pipeline: argument <number> is required (or use --cleanup, --init, 'pipeline init', 'pipeline doctor', or 'pipeline logs')`,
    );
    process.exit(2);
  }

  // --summary (#147) is a local, read-only dump of the issue's evidence bundle.
  // It must work offline (handoff/debugging), so it runs before any gh call,
  // kill-switch check, label-ensure, or lock — and treats <number> as the issue
  // number the bundle is keyed by.
  if (opts.summary) {
    await runSummary(cfg, number);
    return;
  }

  if (isKillSwitchActive(cfg.domain)) {
    console.error(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    process.exit(0);
  }

  // ---- Mode dispatch (bypass paths) ----
  // Status, unblock, and override resolve their own issue number and bypass the
  // run-start preflight gate: status is read-only, and unblock/override are recovery
  // actions for a stuck run (blocking them with a preflight failure would prevent
  // recovery).
  if (opts.status) {
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runStatus(cfg, issueNumber);
    return;
  }
  if (opts.unblock !== undefined) {
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runUnblock(cfg, issueNumber, opts.unblock);
    return;
  }
  if (opts.override !== undefined) {
    let issueNumber: number;
    try {
      issueNumber = await resolveIssueNumber(cfg, number);
    } catch (err) {
      const e = err as Error;
      console.error(`pipeline: ${e.message}`);
      process.exit(1);
    }
    await runOverride(cfg, issueNumber, opts.override, opts);
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

  if (!opts.dryRun) {
    await ensurePipelineLabels(cfg);
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
 *  result for `--status`, and set the exit code (0 all-pass, 1 any failure). */
export async function runDoctor(
  cfg: PipelineConfig,
  opts: CliOpts,
  deps: PreflightCliDeps = defaultPreflightCliDeps,
): Promise<void> {
  const failFast = opts.failFast ?? cfg.doctor.failFast;
  const result = await deps.runPreflight(cfg, undefined, { failFast });
  await deps.storePreflightResult(cfg, result);
  console.log(formatDoctorSummary(result));
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
  const result = await deps.runPreflight(cfg, undefined, { failFast });
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
  /** Latest stored preflight result (#146); optional so existing callers are unaffected. */
  loadLatestPreflightResult?: typeof loadLatestPreflightResult;
}

const defaultRunStatusDeps: RunStatusDeps = { getIssueDetail, getPrForIssue, loadLatestPreflightResult };

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
// Summary mode (#147): print the evidence bundle for an issue and exit. Read-only;
// never enters the dispatch loop or mutates GitHub.
// ---------------------------------------------------------------------------

export async function runSummary(cfg: PipelineConfig, issueNumber: number): Promise<void> {
  const stateDir = runStateDir(cfg.domain);
  // readBundle returns null when absent; a corrupt/unreadable file throws — treat
  // both as "no usable bundle" and exit non-zero so the failure is visible.
  const bundle = await readBundle(stateDir, issueNumber).catch(() => null);
  if (!bundle) {
    console.error(
      `pipeline: no evidence bundle found for #${issueNumber} ` +
        `(expected ${bundlePath(stateDir, issueNumber)}). ` +
        `A bundle is written once the pipeline runs on this issue.`,
    );
    process.exitCode = 1;
    return;
  }
  printSummary(bundle);
}

// ---------------------------------------------------------------------------
// Logs mode (#155): print or follow a run's terminal.log independent of the
// original pipeline process. Reads from .agent-pipeline/runs/<run-id>/.
// ---------------------------------------------------------------------------

export async function runLogs(
  repoDir: string,
  runId: string | undefined,
  follow: boolean,
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
  const logFile = path.join(dir, "terminal.log");

  // Check that the run directory exists.
  try {
    await defaultRunStoreDeps.stat(dir);
  } catch {
    console.error(`pipeline logs: unknown run-id '${runId}' (no directory at ${dir})`);
    process.exitCode = 1;
    return;
  }

  if (!follow) {
    // Print terminal.log and exit.
    let content: string;
    try {
      content = await defaultRunStoreDeps.readFile(logFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`pipeline logs: terminal.log not yet written for run '${runId}'`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    process.stdout.write(content);
    return;
  }

  // --follow: tail -f, independent of the original pipeline process.
  const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" });
  tail.on("error", (err) => {
    console.error(`pipeline logs: failed to start tail: ${err.message}`);
    process.exitCode = 1;
  });
  tail.on("exit", (code) => {
    if (code !== null && code !== 0) process.exitCode = code;
  });
  // Remain open until the user sends SIGINT/SIGTERM.
  await new Promise<void>(() => {});
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
  const body = overrideComment({
    key: parsed.key,
    disposition: parsed.disposition,
    reason: parsed.reason,
    stage,
    timestamp: ts,
    footer: cfg.marker_footer,
  });
  await deps.postComment(cfg, issueNumber, body);
  // If the item is blocked (e.g. a review round blocked on this finding), clear
  // the blocker so the resumed run can re-evaluate with the override applied.
  if (isBlocked(detail.labels)) {
    await deps.clearBlocked(cfg, issueNumber);
  }
  console.log(
    `[pipeline] #${issueNumber}: recorded override for finding ${parsed.key} (${parsed.disposition}).`,
  );

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

    // Compute timing and init the run directory + terminal.log tee BEFORE the first
    // console.log so that terminal.log captures the full run output (finding #6).
    let lastStage: Stage = startStage;
    let transitions = 0;
    const t0 = Date.now();
    const runStartedAt = new Date(t0);
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
      const runId = runIdFor(issueNumber, runStartedAt);
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

      if (stage === "ready-to-deploy") {
        const out = await deployReady.finalize(cfg, issueNumber);
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
        out = await dispatch(cfg, issueNumber, stage, opts, pipelineRunId, stateDir, runDir);
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
        // No advance: blocked, waiting, no-op, finalized, error → stop.
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
          if (runDir) {
            await finalizeRun(runDir, finalized, stateDir, issueNumber, runStartedAtIso, runStoreDeps).catch(() => {});
          }
          await notifyBundlePath(cfg, issueNumber, stateDir, finalized.notifiedAt);
        } catch {
          /* audit-only — ignore */
        }
      }
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
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
    },
    issueNumber,
  );
}

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

async function dispatch(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  opts: CliOpts,
  pipelineRunId: string,
  stateDir?: string,
  runDir?: string,
): Promise<Outcome> {
  const dryRun = !!opts.dryRun;
  const model = opts.model;
  switch (stage) {
    case "ready":
      return planningStage.advance(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir, runDir });
    case "review-1":
      return reviewStage.advanceReview(cfg, issueNumber, 1, { dryRun, model, stateDir, runDir });
    case "review-2":
      return reviewStage.advanceReview(cfg, issueNumber, 2, { dryRun, model, stateDir, runDir });
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
      return {
        advanced: false,
        status: "waiting",
        reason: `${stage} is set mid-flight by the planning/plan-review handler; nothing to do at this point.`,
      };
    case "implementing":
      // Re-entry: if a worktree with commits exists, resume the post-implementation
      // steps (gate → push → PR → review-1) without re-planning or re-implementing.
      // Falls back to "waiting" when no such worktree exists (mid-flight guard).
      return planningStage.dispatchResume(cfg, issueNumber, { dryRun, model, pipelineRunId, stateDir });
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
