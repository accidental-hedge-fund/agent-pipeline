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
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { resolveConfig, resolveReleaseConfig, scaffoldDefaultConfig, findGitRoot, generateConfigSchema, validateConfig } from "./config.ts";
import { spawnDetached } from "./detach.ts";
import { discoverHosts, formatDiscovery } from "./discovery.ts";
import {
  GhMetricsCollector,
  addLabel,
  buildAuditSentinel,
  clearBlocked,
  getIssueDetail,
  getIssueLabelEvents,
  getItemKind,
  getPrForIssue,
  getPrLinkedIssue,
  ensurePipelineLabels,
  getGhActor,
  isBlocked,
  pickStage,
  postComment,
  postPrComment,
  reconcileAuditComment,
  setGhCollector,
  setGhRunId,
  silentTransition,
  transition,
} from "./gh.ts";
import { isKillSwitchActive, runStateDir, withLock } from "./lock.ts";
import { overrideComment, parseOverrideArg, scopedOverrideComment } from "./review-policy.ts";
import { makePipelineRunId } from "./traceability.ts";
import { branchName, getForIssue, getOnDiskForIssue, gitInWorktree, sweepMergedWorktrees } from "./worktree.ts";
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
  latestSummaryForIssue,
  listRunIds,
  runDirPath,
  runIdFor,
  runsDir,
  startTerminalLogTee,
  type RunStoreDeps,
  type TerminalLogTee,
} from "./run-store.ts";
import { runRelease } from "./stages/release.ts";
import { runIntake, realIntakeDeps } from "./stages/intake.ts";
import { runRefineSpec, realRefineSpecDeps } from "./stages/refine-spec.ts";
import { runSweep, realSweepDeps } from "./stages/sweep.ts";
import { runTriage, realTriageDeps, validateTriageInput } from "./stages/triage.ts";
import { mergePr, realMergeDeps } from "./stages/merge.ts";
import * as planningStage from "./stages/planning.ts";
import * as reviewStage from "./stages/review.ts";
import * as fixStage from "./stages/fix.ts";
import * as preMergeStage from "./stages/pre_merge.ts";
import * as evalStage from "./stages/eval.ts";
import * as shipchecKStage from "./stages/shipcheck.ts";
import * as deployReady from "./stages/deploy_ready.ts";
import * as autoRecover from "./stages/auto_recover.ts";
import {
  formatDoctorJson,
  formatDoctorSummary,
  loadLatestPreflightResult,
  runPreflight,
  storePreflightResult,
  type PreflightResult,
} from "./stages/doctor.ts";
import { buildStatusPayload, type StatusPayload } from "./status-json.ts";
import {
  LABEL_PREFIX,
  reviewStageSkipTarget,
  type EvidenceBundle,
  type Outcome,
  type PipelineConfig,
  type Stage,
  type StageOutcome,
} from "./types.ts";

const MAX_ITERATIONS = 12;

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
  // `pipeline run <N> --detach` options
  detach?: boolean;
  timeout?: number;
  flockTimeout?: number;
  /** Internal: pre-allocated #155 run-store run id, set by the detached launcher so
   *  the inner run uses the same `.agent-pipeline/runs/<run-id>` the caller was told. */
  runId?: string;
  /** Emit machine-readable JSON (for --status, the doctor command, `pipeline path`, and `pipeline config validate`). */
  json?: boolean;
  /** Doctor: silent exit-0/1 polling gate; no output. Mutually exclusive with --json. */
  isOk?: boolean;
  /** Release: skip opening $EDITOR for ROADMAP review (commit scaffolded ROADMAP as-is).
   *  Commander's `--no-edit` sets `edit: false` here. */
  edit?: boolean;
  /** Intake: short free-text description to spec into a GitHub issue. */
  description?: string;
  /** refine-spec: existing issue title to refine. */
  title?: string;
  /** refine-spec: existing issue body to refine. */
  body?: string;
  /** Intake/release: pin the target release slot (e.g. "v1.6.0" or "1.6.0"). */
  release?: string;
  /** Roadmap/sweep: gate GitHub write-backs (comments, PRs); default is dry-run. */
  apply?: boolean;
  /** Roadmap: emit top-N dependency-safe issues from an existing plan.json. */
  next?: number;
  /** Sweep: override the target GitHub repository (owner/repo). */
  repo?: string;
  /** Triage: target pre-pipeline stage label (ready or backlog). */
  stage?: string;
}

/**
 * Build and return the configured Commander program (without parsing).
 * Exported so tests can parse synthetic argv slices and verify CLI behaviour.
 */
export function buildCmd(): Command {
  const cmd = new Command();
  cmd
    .name("pipeline")
    .description("Advance a GitHub issue/PR through the pipeline state machine.")
    .version(VERSION, "-V, --version", "print version and exit")
    // Allow 'pipeline run <N> ...', 'pipeline path', 'pipeline config <verb>', and
    // 'pipeline logs <id>' — they pass a second positional Commander would reject.
    .allowExcessArguments(true)
    .argument("[number]", "issue or PR number (required unless --cleanup), or a subcommand: init | doctor | logs | path | config | run | release | intake | refine-spec | triage | roadmap | sweep | merge | summary")
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
    .option("-f, --follow", "follow mode for 'pipeline logs <run-id> --follow': stream new output as appended")
    // `pipeline run <N> --detach` options
    .option("--detach", "run the pipeline in a detached background process (survives launcher exit)")
    .option("--timeout <seconds>", "watchdog: kill the detached run after this many seconds and write a non-zero sentinel", Number)
    .option("--flock-timeout <ms>", "max ms to wait for the per-issue advisory lock (default: 5000)", Number)
    .option("--run-id <id>", "internal: pin the run-store run id (set by the detached launcher so the inner run uses the caller's run directory)")
    .option("--no-edit", "release: skip opening $EDITOR after ROADMAP scaffold (commit as scaffolded)")
    .option("--description <text>", "intake: short free-text description to spec into a GitHub issue")
    .option("--title <text>", "refine-spec: existing issue title to refine")
    .option("--body <markdown>", "refine-spec: existing issue body to refine")
    .option("--release <version>", "intake/release: pin the target release slot (e.g. v1.6.0)")
    .option("--apply", "roadmap/sweep: execute GitHub write-backs (issue updates, roadmap PR); default is dry-run")
    .option("--next <n>", "roadmap: emit top-N dependency-safe issues from existing plan.json without re-running the engine", Number)
    .option("--repo <owner/repo>", "sweep: override the target GitHub repository (default: current repo from gh config)")
    .option("--stage <stage>", "triage: target pre-pipeline stage label (ready or backlog)");
  // Note: `--json` is defined once above; it serves --status, the doctor command,
  // `pipeline path`, and `pipeline config validate` (path/config are exempted from
  // the --status-only check). `allowExcessArguments(true)` (above) permits the
  // second positional of `run <N>`, `path`, `config <verb>`, and `logs <id>`.
  return cmd;
}

async function main(): Promise<void> {
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
  // `pipeline triage <issue> --stage ready|backlog` — set an issue's pre-pipeline stage label.
  const isTriageCommand = numArg === "triage";
  // `pipeline merge <pr>` — human-invoked squash merge of a ready-to-deploy PR.
  const isMergeCommand = numArg === "merge";
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
    await runLogs(repoDir, logsRunId, !!opts.follow);
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

  // Reject every flag the merge sub-command does not intentionally support, before ANY other
  // flag validation or dispatch, so an irreversible squash merge is never reachable from an
  // ambiguous or unintended invocation, AND so `pipeline merge` reports a single consistent
  // error for every unsupported flag (rather than a grab-bag of mode-specific messages like
  // the --json/--is-ok checks below). This is an ALLOWLIST, not a denylist: `pipeline merge`
  // resolves config with only --repo-path / --base / --profile, so ANY other explicitly
  // provided option (run, log, doctor, release, or machine-output modes such as --detach /
  // --json / --is-ok / --no-edit / --domain) is rejected. A denylist would silently let any
  // newly-added global flag through to the merge path — the exact gap that kept recurring
  // (#217). Using commander's option-value source makes the guard exhaustive by construction:
  // a new global option is rejected unless it is deliberately added to the allowlist.
  if (isMergeCommand) {
    const MERGE_ALLOWED_OPTS = new Set(["repoPath", "base", "profile"]);
    const offending = cmd.options
      .map((o) => o.attributeName())
      .filter((key) => !MERGE_ALLOWED_OPTS.has(key) && cmd.getOptionValueSource(key) === "cli");
    if (offending.length > 0) {
      const flags = offending
        .map((key) => cmd.options.find((o) => o.attributeName() === key)?.long ?? `--${key}`)
        .join(", ");
      console.error(
        `pipeline: 'pipeline merge' does not support ${flags}. ` +
          `'pipeline merge <pr>' is a human-invoked squash merge; only --repo-path, --base, and --profile apply.`,
      );
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
  // `pipeline path --json`, `pipeline config validate --json`, and `pipeline refine-spec --json`
  // legitimately emit JSON, so exempt those subcommands from the status/doctor-only --json requirement.
  if (opts.json && !isDoctorCommand && !opts.status && numArg !== "path" && numArg !== "config" && numArg !== "refine-spec") {
    console.error("pipeline: --json requires --status or the doctor command. Usage: pipeline <N> --status --json  OR  pipeline doctor --json");
    process.exit(2);
  }
  // Reject 'pipeline doctor' combined with side-effecting modes. cleanup and init
  // are separate standalone operations; running either when doctor was intended
  // would silently ignore the doctor intent and mutate state.
  if (isDoctorCommand && (opts.cleanup || isInit)) {
    const flag = opts.cleanup ? "--cleanup" : "--init (or 'pipeline init')";
    console.error(`pipeline: 'pipeline doctor' cannot be combined with ${flag}. These are separate commands.`);
    process.exit(2);
  }
  // Reject 'pipeline release' combined with modes that imply an issue number or
  // a different standalone command.
  if (isReleaseCommand && (opts.cleanup || isInit || isDoctorCommand || opts.status)) {
    const conflict = opts.cleanup
      ? "--cleanup"
      : isInit
        ? "--init (or 'pipeline init')"
        : isDoctorCommand
          ? "doctor"
          : "--status";
    console.error(`pipeline: 'pipeline release' cannot be combined with ${conflict}. These are separate commands.`);
    process.exit(2);
  }
  // Reject 'pipeline intake' combined with issue-advance modes or other standalone
  // commands.  Intake is a write-once operation; mixing it with read-only, cleanup,
  // or advance flags leads to ambiguous (and potentially mutating) behaviour.
  if (isIntakeCommand) {
    const intakeConflicts: Array<[string, boolean | string | undefined]> = [
      ["--status", opts.status],
      ["--cleanup", opts.cleanup],
      ["--init (or 'pipeline init')", isInit],
      ["doctor", isDoctorCommand],
      ["--doctor", opts.doctor],
      ["--unblock", opts.unblock !== undefined],
      ["--override", opts.override !== undefined],
    ];
    for (const [flag, active] of intakeConflicts) {
      if (active) {
        console.error(
          `pipeline: 'pipeline intake' cannot be combined with ${flag}. These are separate commands.`,
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
          "  Usage: pipeline release <X.Y.Z | major | minor | patch>\n" +
          "  Example: pipeline release 1.6.0  OR  pipeline release minor",
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

  // `pipeline config schema` and `pipeline config validate` — dispatch before
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
  const maxPositionals =
    cmd.args[0] === "run" ||
    cmd.args[0] === "release" ||
    cmd.args[0] === "intake" ||
    cmd.args[0] === "triage" ||
    cmd.args[0] === "merge"
      ? 2
      : 1; // refine-spec takes only flags (no extra positionals)
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
    const localCfg = resolveReleaseConfig(repoDir, opts.base);
    const versionArg = cmd.args[1] as string;
    try {
      await runRelease(versionArg, { dryRun: opts.dryRun, noEdit: opts.edit === false }, localCfg);
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
    const intakeCfg = resolveReleaseConfig(repoDir, opts.base);
    // Description: prefer --description flag, fall back to the second positional arg.
    const descriptionArg = opts.description ?? cmd.args[1];
    try {
      await runIntake(
        { description: descriptionArg ?? "", release: opts.release, dryRun: opts.dryRun },
        intakeCfg,
        realIntakeDeps(repoDir, intakeCfg.intake_model),
      );
    } catch (err) {
      console.error(`pipeline intake: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early refine-spec dispatch — no issue number, no config resolution required.
  // Non-mutating: no GitHub writes, no git writes, no filesystem writes.
  if (isRefineSpecCommand) {
    const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(startDir) ?? startDir;
    await runRefineSpec(
      { title: opts.title ?? "", body: opts.body ?? "" },
      realRefineSpecDeps(repoDir),
    );
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
        { apply: !!opts.apply, next: opts.next, dryRun: opts.dryRun },
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
        realSweepDeps(sweepCfg.repo_dir, sweepCfg.models.sweep),
      );
    } catch (err) {
      console.error(`pipeline sweep: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Early triage dispatch — resolves config for cfg.repo so gh wrappers target the
  // configured repository. The handler validates issue number and stage, then makes
  // the gh calls to read/add/remove labels.
  if (isTriageCommand) {
    const triageConflicts: Array<[string, boolean | string | undefined]> = [
      ["--dry-run", opts.dryRun],
      ["--status", opts.status],
      ["--summary", opts.summary],
      ["--cleanup", opts.cleanup],
      ["--init (or 'pipeline init')", isInit],
      ["doctor", isDoctorCommand],
      ["--doctor", opts.doctor],
      ["--unblock", opts.unblock !== undefined],
      ["--override", opts.override !== undefined],
      ["--detach", opts.detach],
    ];
    for (const [flag, active] of triageConflicts) {
      if (active) {
        console.error(
          `pipeline: 'pipeline triage' cannot be combined with ${flag}. These are separate commands.`,
        );
        process.exit(2);
      }
    }
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

  // Guard: reject unrecognized non-digit positional arguments before resolveConfig()
  // so the user sees a clear usage error rather than a gh auth/repo-discovery failure.
  if (numArg && !/^\d+$/.test(numArg)) {
    const recognized = ["init", "doctor", "logs", "path", "config", "run", "release", "intake", "refine-spec", "roadmap", "sweep", "triage", "merge", "summary"];
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
      `pipeline: argument <number> is required (or use --cleanup, --init, 'pipeline init', 'pipeline doctor', 'pipeline release', 'pipeline intake', or 'pipeline logs')`,
    );
    process.exit(2);
  }

  // --summary (#147) is a local, read-only dump of the issue's evidence bundle.
  // It must work offline (handoff/debugging), so it runs before any gh call,
  // kill-switch check, label-ensure, or lock — and treats <number> as the issue
  // number the bundle is keyed by.
  if (opts.summary) {
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

  if (isKillSwitchActive(cfg.domain)) {
    console.error(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    process.exit(0);
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
// Config subcommands (#156)
// ---------------------------------------------------------------------------

/**
 * `pipeline config schema`  — print JSON Schema for .github/pipeline.yml
 * `pipeline config validate` — validate config and print structured diagnostics
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

  const sub = subcmd ? `"${subcmd}"` : "(none)";
  console.error(`pipeline config: unknown subcommand ${sub}. Available: schema, validate`);
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
}

const defaultRunStatusDeps: RunStatusDeps = {
  getIssueDetail,
  getPrForIssue,
  loadLatestPreflightResult,
  getForIssue: getOnDiskForIssue,
  getLabelEvents: getIssueLabelEvents,
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
      const payload: StatusPayload = buildStatusPayload(
        { ...detail, labelEvents },
        prNumber,
        worktreeInfo,
        cfg,
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

  // --follow: tail -f, independent of the original pipeline process. Resolve when
  // the tail child exits or errors — including the case where terminal.log does
  // not exist yet — so a failed follow exits non-zero and releases the caller
  // instead of awaiting an unresolvable promise forever (#155).
  await new Promise<void>((resolve) => {
    const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" });
    tail.on("error", (err) => {
      console.error(`pipeline logs: failed to start tail: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
    tail.on("exit", (code) => {
      if (code !== null && code !== 0) process.exitCode = code;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// `pipeline run <N>` subcommand handler
// ---------------------------------------------------------------------------

/** IO seam for tests — override spawnDetached without touching the real filesystem. */
export interface RunSubcommandDeps {
  spawnDetached: typeof spawnDetached;
}
const defaultRunSubcommandDeps: RunSubcommandDeps = { spawnDetached };

export async function handleRunSubcommand(
  numStr: string,
  opts: CliOpts,
  deps: RunSubcommandDeps = defaultRunSubcommandDeps,
): Promise<void> {
  const number = Number.parseInt(numStr ?? "", 10);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(`pipeline run: <number> argument is required and must be a positive integer`);
    process.exitCode = 2;
    return;
  }

  if (opts.detach) {
    // Pre-allocate the #155 run-store run id here so the detached caller is given the
    // SAME `.agent-pipeline/runs/<run-id>` the inner run will use. Without this the
    // detached launch exposed only the wrapper dir (pipeline.log/sentinel.json), and a
    // desktop consumer could not find the structured event log without guessing —
    // reintroducing the competing artifact format the #155 contract avoids (#155).
    const runStoreRunId = runIdFor(number, new Date());
    // Resolve the repo dir with the SAME git-root semantics resolveConfig uses for the
    // inner run (findGitRoot of the start path), so a nested --repo-path still points the
    // pointer at <repo-root>/.agent-pipeline/runs/... and not a checkout subdirectory (#155).
    const runStoreStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
    const repoDir = findGitRoot(runStoreStart) ?? runStoreStart;
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

/** Append a blocker_cleared event to the most recent run directory for issueNumber.
 *  Best-effort: silently skips if no run directory is found. */
async function appendBlockerCleared(repoDir: string, issueNumber: number): Promise<void> {
  const allIds = await listRunIds(repoDir).catch(() => [] as string[]);
  const id = allIds.find((runId) => runId.startsWith(`${issueNumber}-`));
  if (!id) return;
  await appendEvent(
    runDirPath(repoDir, id),
    { schema_version: RUN_SCHEMA_VERSION, type: "blocker_cleared", at: evidenceTimestamp() },
    defaultRunStoreDeps,
  ).catch(() => {});
}

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
  await appendBlockerCleared(cfg.repo_dir, issueNumber);
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
    await appendBlockerCleared(cfg.repo_dir, issueNumber);
  }
  console.log(`[pipeline] #${issueNumber}: ${overrideLogMsg}`);

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
        const wtBefore = await getOnDiskForIssue(cfg, issueNumber).catch(() => null);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Internal exports for tests (state-transition table tests).
// ---------------------------------------------------------------------------

export const _internals = { dispatch, runInit, isAutoLoopRecoverable, isAutoLoopEligible, canAutoLoopContinue };

// Suppress unused import warnings for test-only helpers.
void addLabel;
