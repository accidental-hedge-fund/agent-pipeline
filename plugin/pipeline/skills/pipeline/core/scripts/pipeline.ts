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
  clearBlocked,
  getIssueDetail,
  getIssueLabelEvents,
  getItemKind,
  getPrForIssue,
  getPrLinkedIssue,
  ensurePipelineLabels,
  isBlocked,
  pickStage,
  postComment,
  silentTransition,
} from "./gh.ts";
import { isKillSwitchActive, runStateDir } from "./lock.ts";
import { overrideComment, parseOverrideArg, scopedOverrideComment } from "./review-policy.ts";
import { getForIssue, sweepMergedWorktrees } from "./worktree.ts";
import {
  bundlePath,
  printSummary,
  readBundle,
} from "./evidence-bundle.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  isValidSummaryBundle,
  latestSummaryForIssue,
  listRunIds,
  runDirPath,
  runIdFor,
  runsDir,
  type RunStoreDeps,
} from "./run-store.ts";
import { runRelease } from "./stages/release.ts";
import { runIntake, realIntakeDeps } from "./stages/intake.ts";
import { runSweep, realSweepDeps } from "./stages/sweep.ts";
import { runTriage, realTriageDeps, validateTriageInput } from "./stages/triage.ts";
import { mergePr, realMergeDeps } from "./stages/merge.ts";
import {
  formatDoctorJson,
  formatDoctorSummary,
  loadLatestPreflightResult,
  runPreflight,
  storePreflightResult,
  type PreflightResult,
} from "./stages/doctor.ts";
import { type CliOpts } from "./cli-types.ts";
import { COMMAND_REGISTRY } from "./command-registry.ts";
import {
  runAdvance,
  dispatch,
  REVIEW_CEILING_MARKER,
  ceilingRound,
  isAutoLoopRecoverable,
  isAutoLoopEligible,
  canAutoLoopContinue,
  type AdvanceDeps,
} from "./pipeline-run.ts";
import * as reviewStage from "./stages/review.ts";
import { buildStatusPayload, type StatusPayload } from "./status-json.ts";
import {
  type EvidenceBundle,
  type PipelineConfig,
  type Stage,
} from "./types.ts";

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

// CliOpts is defined in cli-types.ts; re-exported here for backward compatibility
// so existing importers (tests, etc.) can continue using `from "./pipeline.ts"`.
export type { CliOpts } from "./cli-types.ts";
// ceilingRound is defined in pipeline-run.ts; re-exported here so
// pipeline-override.test.ts can continue importing from pipeline.ts.
export { ceilingRound } from "./pipeline-run.ts";

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
    .argument("[number]", "issue or PR number (required unless --cleanup), or a subcommand: init | doctor | logs | path | config | run | release | intake | triage | roadmap | sweep | merge | summary")
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

  // Generic registry flag guard: resolve the subcommand key from COMMAND_REGISTRY and
  // reject any explicitly-provided flag absent from that command's allowedFlags.
  // Replaces the previous hand-written per-command guard blocks (merge, doctor, release,
  // intake, triage). `logs`, `summary`, `config`, and `path` dispatch before this point
  // and are intentionally not gated here; their registry entries exist for coverage.
  const subCmd = numArg && !/^\d+$/.test(numArg) ? numArg : "advance";
  const registryEntry = COMMAND_REGISTRY[subCmd];
  if (registryEntry) {
    const offending = cmd.options
      .map((o) => o.attributeName())
      .filter((key) => !registryEntry.allowedFlags.has(key as keyof CliOpts) && cmd.getOptionValueSource(key) === "cli");
    if (offending.length > 0) {
      const flags = offending
        .map((key) => cmd.options.find((o) => o.attributeName() === key)?.long ?? `--${key}`)
        .join(", ");
      const cmdLabel = subCmd === "advance" ? `pipeline ${numArg ?? "<N>"}` : `pipeline ${subCmd}`;
      console.error(`pipeline: '${cmdLabel}' does not support ${flags}.`);
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
  // `pipeline path --json` and `pipeline config validate --json` legitimately emit
  // JSON, so exempt those subcommands from the status/doctor-only --json requirement.
  if (opts.json && !isDoctorCommand && !opts.status && numArg !== "path" && numArg !== "config") {
    console.error("pipeline: --json requires --status or the doctor command. Usage: pipeline <N> --status --json  OR  pipeline doctor --json");
    process.exit(2);
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
      : 1;
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
    const recognized = Object.keys(COMMAND_REGISTRY).filter(k => k !== "advance");
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
  getForIssue,
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
    { schema_version: RUN_SCHEMA_VERSION, type: "blocker_cleared", at: new Date().toISOString().replace(/\.\d+Z$/, "Z") },
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Internal exports for tests (state-transition table tests).
// ---------------------------------------------------------------------------

// dispatch and auto-loop helpers are imported from pipeline-run.ts.
export const _internals = { dispatch, runInit, isAutoLoopRecoverable, isAutoLoopEligible, canAutoLoopContinue };
