// Per-cell isolation and execution (openspec/changes/stage-eval-runner).
//
// Every cell gets a fresh worktree at the fixture's base_commit, a unique
// branch, and a unique session identity — all derived from the cell_id so no
// two cells (including replicates) can collide. This module is fully
// dependency-injected: production defaults call into worktree.ts / harness.ts
// / harness-adapters, but tests never touch git, the filesystem, or a
// subprocess (CLAUDE.md's injectable-dep rule).

import * as path from "node:path";
import { createWorktreeAt, removeWorktreeAt } from "../worktree.ts";
import { invoke as harnessInvoke } from "../harness.ts";
import { resolveAdapter } from "../harness-adapters/index.ts";
import { preflightExecutor, invokeExternalExecutor, type ExecutorAssignment } from "../executors.ts";
import type { HarnessResult } from "../harness.ts";
import type { ModelEndpointOverride, ModelInvokingStage, PipelineConfig } from "../types.ts";
import {
  createEvalGhSurface,
  createRecordingRefusalRecorder,
  type EvalGhSurface,
  type GhRefusalRecord,
} from "./gh-eval-surface.ts";
import { materializeStagePrompt, stagesForMode } from "./stage-adapters.ts";
import type { BuildTreatmentTrajectoryInput, RawStageEntry } from "./trajectory/collect.ts";
import type { Cell, CellExecutionClass, CellOutcome, EnvironmentDependency, EvalStageName, ExperimentManifest, Fixture, Treatment } from "./types.ts";

function sanitizeForPath(cellId: string): string {
  return cellId.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Harnesses whose CLI accepts a `provider/model`-formatted model value
 *  (opencode.ts's `-m` flag, design.md decision 4 of #431's cli-harness-adapters
 *  change) — i.e. the only harnesses for which a `provider` treatment axis can
 *  actually change the invocation rather than being silently ignored. */
const PROVIDER_QUALIFIED_HARNESSES = new Set(["opencode"]);

/** Fold a cell's `provider` treatment into the model string handed to the
 *  harness, or report why it cannot. A `provider` value only has an effect for
 *  a harness whose CLI accepts a `provider/model` value; every other harness
 *  is provider-locked (the CLI itself talks to one provider), so a `provider`
 *  treatment there would silently confound cells that differ only by
 *  `provider` (review 1 finding 2b468247) — this is therefore reported as an
 *  incompatible cell rather than executed as a no-op. */
function resolveTreatmentModel(
  harness: string,
  treatment: { provider?: string; model?: string },
): { ok: true; model: string | undefined } | { ok: false; error: string } {
  if (!treatment.provider) {
    return { ok: true, model: treatment.model };
  }
  if (!PROVIDER_QUALIFIED_HARNESSES.has(harness)) {
    return {
      ok: false,
      error: `harness "${harness}" has no separate provider axis — it cannot honor treatment provider "${treatment.provider}"`,
    };
  }
  if (!treatment.model) {
    return {
      ok: false,
      error: `harness "${harness}" requires a "provider/model" formatted model, but the treatment specifies provider "${treatment.provider}" with no model`,
    };
  }
  return { ok: true, model: `${treatment.provider}/${treatment.model}` };
}

/** Env overrides that strip GitHub/git write credentials from the harness
 *  child process (review 1 finding ddab0172; hardened for review 2 finding
 *  c5141ca2): the injected `EvalGhSurface` only refuses calls made through it,
 *  but a real harness is an external CLI that can shell out to `gh`/`git`
 *  directly with the operator's ambient credentials, bypassing that surface
 *  entirely. Redirecting `GH_CONFIG_DIR` to an empty, cell-scoped directory
 *  makes `gh` see no stored login; blanking the token env vars defeats
 *  env-based `gh`/git auth; dropping `SSH_AUTH_SOCK` defeats agent-based
 *  `git push` over SSH.
 *
 *  `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` point git at an empty,
 *  cell-scoped config instead of the operator's real system/global
 *  gitconfig, so a global `credential.helper` (stored HTTPS credentials)
 *  cannot be found; `GIT_SSH_COMMAND` forces ssh to use a nonexistent
 *  identity file and refuse any fallback to a default `~/.ssh` key, so `git
 *  push` over SSH has no usable identity either. Deliberately does NOT
 *  redirect `HOME` itself: the harness CLI's own model-provider credentials
 *  (e.g. `~/.claude`, `~/.codex`, an OS keychain) live under the operator's
 *  real `$HOME`, and the eval runner's job is to exercise that CLI, not lock
 *  it out of its own auth — these vars scope the block to git/ssh/gh
 *  specifically, at the actual process boundary rather than a prompt-only
 *  convention. */
function isolatedGhEnv(worktreeDir: string): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GH_CONFIG_DIR: path.join(worktreeDir, ".eval-gh-config-empty"),
    SSH_AUTH_SOCK: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(worktreeDir, ".eval-gitconfig-empty"),
    GIT_SSH_COMMAND: "ssh -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes -o StrictHostKeyChecking=no",
  };
}

export interface CellIdentity {
  worktreePath: string;
  branch: string;
  sessionId: string;
}

/** Allocate the worktree path, branch name, and session identity for a cell.
 *  A pure function of cell_id: two calls with the same cell_id always agree,
 *  and two different cell_ids (including two replicates of the same
 *  treatment) never collide. */
export function allocateCellIdentity(cfg: PipelineConfig, cell: Cell): CellIdentity {
  const slug = sanitizeForPath(cell.cell_id);
  return {
    worktreePath: path.join(cfg.repo_dir, ".worktrees", "evals", slug),
    branch: `pipeline-eval/${slug}`,
    sessionId: slug,
  };
}

export interface HarnessInvokeArgs {
  harness: string;
  worktreeDir: string;
  prompt: string;
  timeoutSec: number;
  model?: string;
  effort?: string;
  gh: EvalGhSurface;
  /** Env overrides merged on top of the child process's environment —
   *  used to strip GitHub/git write credentials (see `isolatedGhEnv`). */
  env?: NodeJS.ProcessEnv;
}

export interface HarnessInvokeResultLike {
  success: boolean;
  timed_out: boolean;
  spawn_error?: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration: number;
  /** Rate-limit/throttle signal recovered from the adapter's own telemetry
   *  parsing (harness.ts). `null`/absent when the CLI reports no such signal
   *  at all — not the same as "not throttled". */
  throttled?: boolean | null;
}

export interface PreflightResultLike {
  ok: boolean;
  failure?: "missing-cli" | "unauthenticated" | "headless-unavailable" | "unsupported-setting";
  message?: string;
}

export interface CellExecutionDeps {
  createWorktree?: (
    cfg: PipelineConfig,
    opts: { path: string; branch: string; baseCommit: string },
  ) => Promise<{ path: string; branch: string }>;
  removeWorktree?: (cfg: PipelineConfig, opts: { path: string; branch: string }) => Promise<void>;
  invokeHarness?: (args: HarnessInvokeArgs) => Promise<HarnessInvokeResultLike>;
  preflight?: (harness: string, req: { model?: string; effort?: string }) => Promise<PreflightResultLike>;
  /** Run each named check as a shell command in the given worktree and report
   *  pass (exit 0) / fail per check name. Only invoked when the fixture
   *  declares at least one public or hidden check (grading needs the result;
   *  a fixture declaring none never triggers this, so existing callers that
   *  inject no fake are unaffected). `deadlineMs` is the cell's remaining
   *  budget at the time checks start — implementations must cap execution to
   *  it rather than each check's own fixed ceiling. */
  runChecks?: (args: { worktreeDir: string; checks: string[]; deadlineMs: number }) => Promise<Record<string, boolean>>;
  /** Report the repository-relative paths that differ from `baseSha` in the
   *  given worktree. Only invoked when the fixture declares
   *  `allowed_change_paths` (out-of-scope-change grading needs it). */
  getChangedPaths?: (args: { worktreeDir: string; baseSha: string }) => Promise<string[]>;
  /** Dispatch an API treatment through a named `model-endpoint` executor
   *  (#434 task 6). Only invoked when the cell's treatment declares
   *  `executor`. */
  invokeExecutor?: (args: ExecutorInvokeArgs) => Promise<{ ok: true; result: HarnessResult } | { ok: false; error: string }>;
  /** Run a declared `simulated` environment dependency's deterministic
   *  `setup`/`teardown` shell command in the cell's worktree (review 1
   *  finding ed37a4fd) — only invoked when the fixture declares at least one
   *  `simulated` dependency. `phase` distinguishes setup (run before the
   *  treatment) from teardown (run after, best-effort). */
  runEnvironmentCommand?: (args: { worktreeDir: string; command: string; phase: "setup" | "teardown"; deadlineMs: number }) => Promise<{ ok: boolean; error?: string }>;
}

async function defaultRunChecks(
  args: { worktreeDir: string; checks: string[]; deadlineMs: number },
): Promise<Record<string, boolean>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const results: Record<string, boolean> = {};
  const deadline = Date.now() + args.deadlineMs;
  for (const check of args.checks) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      results[check] = false;
      continue;
    }
    try {
      await execFileAsync("sh", ["-c", check], { cwd: args.worktreeDir, timeout: Math.min(300_000, remainingMs) });
      results[check] = true;
    } catch {
      results[check] = false;
    }
  }
  return results;
}

async function defaultGetChangedPaths(args: { worktreeDir: string; baseSha: string }): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", args.baseSha], {
      cwd: args.worktreeDir,
      timeout: 30_000,
    });
    return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Command-line tokens that reach outside the cell's isolated worktree — the
 *  GitHub CLI (a production GitHub write), raw network clients, and `git
 *  push`/`git remote` (a repository write to a real remote). A declared
 *  `simulated`/`forbidden` dependency's `setup`/`teardown` is supposed to be a
 *  deterministic, in-worktree stand-in (a local stub, a fixture file, an
 *  in-memory server) — not a live call to the very surface the eval is
 *  isolating against (review 2 finding dc817cec). Matched as whole words so a
 *  path component or unrelated flag containing these substrings is not
 *  falsely flagged. */
const FORBIDDEN_SIMULATION_TOOLING = [
  /(^|[\s;&|])gh(\s|$)/,
  /(^|[\s;&|])curl(\s|$)/,
  /(^|[\s;&|])wget(\s|$)/,
  /(^|[\s;&|])ssh(\s|$)/,
  /(^|[\s;&|])scp(\s|$)/,
  /(^|[\s;&|])sftp(\s|$)/,
  /(^|[\s;&|])(nc|netcat)(\s|$)/,
  /(^|[\s;&|])telnet(\s|$)/,
  /(^|[\s;&|])git\s+push(\s|$)/,
  /(^|[\s;&|])git\s+remote(\s|$)/,
];

function findForbiddenSimulationTooling(command: string): RegExpMatchArray | null {
  for (const pattern of FORBIDDEN_SIMULATION_TOOLING) {
    const match = command.match(pattern);
    if (match) return match;
  }
  return null;
}

async function defaultRunEnvironmentCommand(
  args: { worktreeDir: string; command: string; phase: "setup" | "teardown"; deadlineMs: number },
): Promise<{ ok: boolean; error?: string }> {
  const forbidden = findForbiddenSimulationTooling(args.command);
  if (forbidden) {
    return {
      ok: false,
      error: `environment ${args.phase} command references ${JSON.stringify(forbidden[0].trim())} — GitHub-write and external/network tooling is not permitted in a simulated/forbidden dependency stand-in`,
    };
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync("sh", ["-c", args.command], {
      cwd: args.worktreeDir,
      timeout: Math.max(1, args.deadlineMs),
      env: { ...process.env, ...isolatedGhEnv(args.worktreeDir) },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `environment ${args.phase} command failed: ${(err as Error).message}` };
  }
}

async function realPreflight(
  harness: string,
  req: { model?: string; effort?: string },
): Promise<PreflightResultLike> {
  const adapter = resolveAdapter(harness);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const exec = async (file: string, args: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, { timeout: 10_000 });
      return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, stdout: (e.stdout ?? "").toString(), stderr: (e.stderr ?? "").toString() };
    }
  };
  const execCheck = async (file: string, args: string[]) => (await exec(file, args)).ok;
  const result = await adapter.preflight({ exec, execCheck }, req);
  return { ok: result.ok, failure: result.failure, message: result.message };
}

async function realInvokeHarness(args: HarnessInvokeArgs): Promise<HarnessInvokeResultLike> {
  const result = await harnessInvoke(args.harness, args.worktreeDir, args.prompt, {
    timeoutSec: args.timeoutSec,
    model: args.model,
    effort: args.effort,
    stream: false,
    env: args.env,
  });
  return result;
}

// ---------------------------------------------------------------------------
// #434 stage-eval-runner integration — binding an API treatment to a named
// model-endpoint executor with deterministic per-cell overrides.
// ---------------------------------------------------------------------------

/** The eval mode/stage pairs a `model-endpoint` executor can be bound to — the
 *  same prompt-contained restriction `config.ts` enforces for a committed
 *  `stage_executors:` assignment (executors.ts, external-stage-executors). */
const API_TREATMENT_STAGE_MAP: Partial<Record<EvalStageName, ModelInvokingStage>> = {
  "plan-review": "plan-review",
  review: "review-1",
};

/** Derive the per-cell override deterministically from the treatment's own
 *  coordinates (#434 task 6.1) — a pure function of `treatment`, so replaying
 *  the same plan from the same manifest/seed always resolves the same
 *  override (manifest.ts's cell_id is already a pure function of the same
 *  coordinates, which is what gives this determinism for free). */
export function deriveModelEndpointOverride(treatment: Treatment): ModelEndpointOverride {
  return {
    ...(treatment.model !== undefined ? { model: treatment.model } : {}),
    ...(treatment.params !== undefined ? { params: treatment.params } : {}),
    ...(treatment.effort !== undefined ? { effort: treatment.effort } : {}),
  };
}

export interface ExecutorInvokeArgs {
  cfg: PipelineConfig;
  stage: ModelInvokingStage;
  executorName: string;
  prompt: string;
  timeoutSec: number;
  override: ModelEndpointOverride;
}

/** `{ok:false}` for every failure that must be classified `infra_error` (never
 *  a completed treatment outcome, #434 task 6.2): an unknown executor name, an
 *  executor that isn't a `model-endpoint`, or any preflight failure (missing
 *  credential/header env var, invalid override, unreachable endpoint,
 *  unsupported effort). `{ok:true}` carries the executor's `HarnessResult` —
 *  itself may still be `success:false` (e.g. a non-2xx response), which IS a
 *  genuine treatment outcome, mirroring how a local-CLI harness failure is
 *  handled below. */
async function realInvokeExecutor(
  args: ExecutorInvokeArgs,
): Promise<{ ok: true; result: HarnessResult } | { ok: false; error: string }> {
  const definition = args.cfg.executors?.[args.executorName];
  if (!definition) {
    return { ok: false, error: `executor "${args.executorName}" is not defined under executors: in pipeline config` };
  }
  if (definition.type !== "model-endpoint") {
    return { ok: false, error: `executor "${args.executorName}" is a "${definition.type}" executor — API treatments require a model-endpoint executor` };
  }
  const assignment: ExecutorAssignment = { name: args.executorName, definition };
  const preflight = await preflightExecutor(args.stage, assignment, {}, args.override);
  if (!preflight.ok) {
    return { ok: false, error: preflight.message };
  }
  const result = await invokeExternalExecutor(args.stage, assignment, args.prompt, { timeoutSec: args.timeoutSec }, {}, args.override);
  return { ok: true, result };
}

export interface CellExecutionResult {
  outcome: CellOutcome;
  materializedPrompt: string;
  effectiveConfig: Record<string, unknown>;
  ghRefusals: GhRefusalRecord[];
  /** Raw (pre-sanitize, pre-bound) treatment trajectory input (#536) — the
   *  caller (run.ts) builds and persists the artifact from this via
   *  trajectory/collect.ts + trajectory/store.ts. Collected best-effort for
   *  every result_class, including infra_error/auth_error/timeout, since
   *  diagnosing *why* a cell didn't complete is exactly the trajectory's job. */
  trajectory: BuildTreatmentTrajectoryInput;
}

/** Execute exactly one cell: fresh isolated worktree at the fixture's
 *  base_commit, run the stage(s) its mode requires from frozen inputs, tear
 *  the worktree down, and classify the outcome. Never throws — every failure
 *  mode is captured as a result_class. */
export async function runCell(
  cfg: PipelineConfig,
  cell: Cell,
  fixture: Fixture,
  manifest: ExperimentManifest,
  deps: CellExecutionDeps = {},
): Promise<CellExecutionResult> {
  const createWorktreeFn = deps.createWorktree ?? ((c, o) => createWorktreeAt(c, o));
  const removeWorktreeFn = deps.removeWorktree ?? ((c, o) => removeWorktreeAt(c, o));
  const invokeHarnessFn = deps.invokeHarness ?? realInvokeHarness;
  const preflightFn = deps.preflight ?? realPreflight;

  const identity = allocateCellIdentity(cfg, cell);
  const recorder = createRecordingRefusalRecorder();
  const ghSurface = createEvalGhSurface(recorder);

  const stages: EvalStageName[] = stagesForMode(cell.mode, fixture);
  const prompts = stages.map((stage) => materializeStagePrompt(stage, fixture));
  const materializedPrompt = prompts.join("\n\n---\n\n");
  const effectiveConfig: Record<string, unknown> = {
    mode: cell.mode,
    treatment: cell.treatment,
    timeout: manifest.timeout,
  };

  // Treatment trajectory collection (#536): best-effort, capability-aware.
  // No harness/executor this engine drives exposes structured tool-call
  // telemetry today, so that channel is always recorded `unavailable` with a
  // reason rather than fabricated as an empty-but-successful channel (task
  // 3.1). Populated across every return below via `finish()` so a cell that
  // never reaches a harness invocation (e.g. worktree creation failure) still
  // yields a trajectory recording what did happen.
  const trajectoryExecutionClass: CellExecutionClass = cell.treatment.executor ? "api-key" : "local-cli";
  const trajectoryActions: string[] = [];
  const trajectoryStages: RawStageEntry[] = [];
  const TOOL_EVENTS_UNAVAILABLE: BuildTreatmentTrajectoryInput["toolEvents"] = {
    availability: { available: false, reason: "harness/executor does not expose structured tool-call telemetry" },
  };
  function finish(outcome: CellOutcome): CellExecutionResult {
    return {
      outcome,
      materializedPrompt,
      effectiveConfig,
      ghRefusals: recorder.refusals,
      trajectory: {
        cell_id: cell.cell_id,
        experiment_id: cell.experiment_id,
        execution_class: trajectoryExecutionClass,
        stages: trajectoryStages,
        actions: trajectoryActions,
        toolEvents: TOOL_EVENTS_UNAVAILABLE,
        producedArtifacts: (outcome.detail?.changed_paths as string[] | undefined) ?? [],
        result_class: outcome.result_class,
        error: outcome.error,
      },
    };
  }

  // A fixture-declared `forbidden` dependency must still be *deterministically
  // denied at the dependency boundary* rather than refusing the whole cell
  // before it runs (review 2 finding d906091a): a permitted fixture mode
  // whose sole purpose is to measure whether a treatment respects a
  // forbidden service/data boundary is otherwise unmeasurable — it never
  // gets a worktree, a harness invocation, or a grading signal. Its declared
  // `setup`/`teardown` is expected to install the deterministic denial (a
  // stub that refuses/errors, matching its declared `expected` outputs/
  // errors) the same way a `simulated` dependency installs its deterministic
  // stand-in, so both run through the same environment-command path;
  // `expected` is carried into `detail.environment` below so checks/graders
  // can assess whether the treatment honored the boundary.
  const environment: EnvironmentDependency[] = fixture.environment ?? [];
  const simulated = environment.filter((d) => d.mode === "simulated" || d.mode === "forbidden");
  const environmentDetail =
    environment.length > 0 ? environment.map((d) => ({ name: d.name, mode: d.mode, expected: d.expected })) : undefined;
  const runEnvironmentCommandFn = deps.runEnvironmentCommand ?? defaultRunEnvironmentCommand;

  let worktreeCreated = false;
  try {
    await createWorktreeFn(cfg, {
      path: identity.worktreePath,
      branch: identity.branch,
      baseCommit: cell.base_sha,
    });
    worktreeCreated = true;
    trajectoryActions.push(`created worktree at ${identity.branch}`);
  } catch (err) {
    trajectoryActions.push(`worktree creation failed: ${(err as Error).message}`);
    return finish({ result_class: "infra_error", error: `worktree creation failed: ${(err as Error).message}` });
  }

  try {
    // Each declared `simulated` dependency's deterministic stand-in must be
    // in place before the treatment runs (review 1 finding ed37a4fd) — its
    // teardown runs in the `finally` below, before worktree removal.
    for (const dep of simulated) {
      const setupDeadlineMs = Math.max(1000, manifest.timeout * 1000);
      const result = await runEnvironmentCommandFn({
        worktreeDir: identity.worktreePath,
        command: dep.setup,
        phase: "setup",
        deadlineMs: setupDeadlineMs,
      });
      if (!result.ok) {
        const error = `simulated dependency ${JSON.stringify(dep.name)} ${result.error}`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
      trajectoryActions.push(`ran setup for simulated dependency ${JSON.stringify(dep.name)}`);
    }

    // API treatment path (#434 task 6): the cell binds to a named
    // model-endpoint executor instead of a local CLI harness. Kept entirely
    // separate from the harness path below — a model-endpoint executor is
    // only ever valid for a single prompt-contained stage, never the
    // multi-stage end-to-end mode a local CLI harness can run.
    if (cell.treatment.executor) {
      const invokeExecutorFn = deps.invokeExecutor ?? realInvokeExecutor;
      if (stages.length !== 1 || !(stages[0] in API_TREATMENT_STAGE_MAP)) {
        const error =
          `API treatment executor "${cell.treatment.executor}" is only valid for a single-stage ` +
          `"plan-review" or "review" cell — mode "${cell.mode}" requires ${stages.length} stage(s)`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
      const pipelineStage = API_TREATMENT_STAGE_MAP[stages[0]]!;
      const override = deriveModelEndpointOverride(cell.treatment);
      trajectoryActions.push(`invoking API executor "${cell.treatment.executor}" for stage "${pipelineStage}"`);
      const invoked = await invokeExecutorFn({
        cfg,
        stage: pipelineStage,
        executorName: cell.treatment.executor,
        prompt: prompts[0],
        timeoutSec: manifest.timeout,
        override,
      });
      if (!invoked.ok) {
        trajectoryActions.push(`API executor invocation failed: ${invoked.error}`);
        return finish({ result_class: "infra_error", error: invoked.error });
      }
      const result = invoked.result;
      trajectoryStages.push({
        stage: pipelineStage,
        message: prompts[0],
        output: result.stdout,
        error: result.success ? undefined : result.stderr,
        duration_ms: Math.round(result.duration * 1000),
        success: result.success,
      });
      const executionClass: CellExecutionClass = "api-key";
      const detail: Record<string, unknown> = {
        stages: [{ stage: pipelineStage, success: result.success, exit_code: result.exit_code, duration: result.duration }],
        execution_class: executionClass,
        executor_provenance: result.executor_provenance ?? null,
      };
      const findings = parseReviewFindings(result.stdout);
      if (findings !== undefined) detail.findings = findings;
      if (environmentDetail !== undefined) detail.environment = environmentDetail;
      return finish({ result_class: "completed", detail });
    }

    const harness = cell.treatment.harness;
    const effectiveHarness = harness ?? "claude";

    const resolvedModel = resolveTreatmentModel(effectiveHarness, cell.treatment);
    if (!resolvedModel.ok) {
      trajectoryActions.push(resolvedModel.error);
      return finish({ result_class: "infra_error", error: resolvedModel.error });
    }

    if (harness) {
      let preflightResult: PreflightResultLike;
      try {
        preflightResult = await preflightFn(harness, {
          model: resolvedModel.model,
          effort: cell.treatment.effort,
        });
      } catch (err) {
        const error = `preflight failed: ${(err as Error).message}`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
      if (!preflightResult.ok) {
        const resultClass = preflightResult.failure === "unauthenticated" ? "auth_error" : "infra_error";
        const error = preflightResult.message ?? preflightResult.failure;
        trajectoryActions.push(`preflight failed: ${error}`);
        return finish({ result_class: resultClass, error });
      }
      trajectoryActions.push(`preflight passed for harness "${harness}"`);
    }

    // Per-cell deadline (review 2 finding cb0500d0): a fixed, shared budget
    // for the whole cell, not a fresh `manifest.timeout` handed to every
    // stage — an end-to-end cell can otherwise run to N times its configured
    // budget before being recorded.
    const cellDeadlineMs = Date.now() + manifest.timeout * 1000;

    const stageDetails: Record<string, unknown>[] = [];
    let reviewFindings: unknown[] | undefined;
    let planningOutputText: string | undefined;
    let planningSelfAssessment: unknown;
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const prompt = prompts[i];
      const remainingMs = cellDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        const error = `cell exceeded its ${manifest.timeout}s per-cell timeout before stage "${stage}" could start`;
        trajectoryActions.push(error);
        return finish({ result_class: "timeout", error });
      }

      let result: HarnessInvokeResultLike;
      try {
        result = await invokeHarnessFn({
          harness: effectiveHarness,
          worktreeDir: identity.worktreePath,
          prompt,
          timeoutSec: Math.max(1, Math.ceil(remainingMs / 1000)),
          model: resolvedModel.model,
          effort: cell.treatment.effort,
          gh: ghSurface,
          env: isolatedGhEnv(identity.worktreePath),
        });
      } catch (err) {
        const error = `harness invocation failed: ${(err as Error).message}`;
        trajectoryActions.push(`stage "${stage}": ${error}`);
        return finish({ result_class: "infra_error", error });
      }

      // Record this stage's bounded output/error/timing/success regardless of
      // outcome below — a timed-out or failed stage is exactly what a
      // maintainer needs to see in the trajectory (#536).
      trajectoryStages.push({
        stage,
        message: prompt,
        output: result.stdout,
        error: result.success ? undefined : result.stderr,
        duration_ms: Math.round(result.duration * 1000),
        success: result.success,
      });

      if (result.timed_out) {
        return finish({ result_class: "timeout", error: `stage "${stage}" exceeded the per-cell timeout` });
      }
      if (result.spawn_error) {
        return finish({ result_class: "infra_error", error: `stage "${stage}" failed to spawn the harness process` });
      }

      // Invocation-time auth/quota/rate-limit refusals must not be counted as
      // a treatment outcome (review 2 finding f97442bc) — only reachable once
      // timeout/spawn_error have been ruled out above.
      if (!result.success) {
        const authFailure = await classifyPostInvocationFailure(result, preflightFn, effectiveHarness, {
          model: resolvedModel.model,
          effort: cell.treatment.effort,
        });
        if (authFailure) {
          return finish({ result_class: "auth_error", error: `stage "${stage}" ${authFailure}` });
        }
      }

      trajectoryActions.push(`invoked stage "${stage}" via harness "${effectiveHarness}" (${result.success ? "success" : "failure"})`);
      stageDetails.push({
        stage,
        success: result.success,
        exit_code: result.exit_code,
        duration: result.duration,
      });

      // Grading-relevant stage output, captured here because it does not
      // survive worktree teardown: review-mode findings (parsed from the
      // harness's review-verdict JSON, best-effort) and planning-mode output
      // text / self-assessment.
      if (stage === "review") {
        const findings = parseReviewFindings(result.stdout);
        if (findings !== undefined) reviewFindings = findings;
      }
      if (stage === "planning") {
        planningOutputText = result.stdout;
        planningSelfAssessment = parseSelfAssessment(result.stdout);
      }
    }

    const cliExecutionClass: CellExecutionClass = "local-cli";
    const detail: Record<string, unknown> = { stages: stageDetails, execution_class: cliExecutionClass };
    const allChecks = [...fixture.public_checks, ...(fixture.hidden_checks ?? [])];
    if (allChecks.length > 0) {
      // Checks run against the cell's remaining budget, not a fresh ceiling
      // of their own (review 1 finding 4e04eddd) — a cell whose treatment
      // already consumed the deadline must not spend further unbounded time
      // in checks and still come back `completed`.
      const remainingForChecks = cellDeadlineMs - Date.now();
      if (remainingForChecks <= 0) {
        const error = `cell exceeded its ${manifest.timeout}s per-cell timeout before checks could start`;
        trajectoryActions.push(error);
        return finish({ result_class: "timeout", error });
      }
      const runChecksFn = deps.runChecks ?? defaultRunChecks;
      // Note: check bodies/results (`detail.checks`) are verifier-only
      // material — deliberately NOT recorded on the trajectory, only in the
      // grader's own verifier evidence artifact (hidden-material
      // containment, #536 task 5).
      detail.checks = await runChecksFn({
        worktreeDir: identity.worktreePath,
        checks: allChecks,
        deadlineMs: remainingForChecks,
      });
      trajectoryActions.push(`ran ${allChecks.length} check(s) in the cell's worktree`);
      if (Date.now() > cellDeadlineMs) {
        const error = `cell exceeded its ${manifest.timeout}s per-cell timeout while running checks`;
        trajectoryActions.push(error);
        return finish({ result_class: "timeout", error });
      }
    }
    if (fixture.allowed_change_paths !== undefined) {
      const getChangedPathsFn = deps.getChangedPaths ?? defaultGetChangedPaths;
      detail.changed_paths = await getChangedPathsFn({ worktreeDir: identity.worktreePath, baseSha: cell.base_sha });
    }
    if (reviewFindings !== undefined) detail.findings = reviewFindings;
    if (planningOutputText !== undefined) detail.output_text = planningOutputText;
    if (planningSelfAssessment !== undefined) detail.self_assessment = planningSelfAssessment;
    if (environmentDetail !== undefined) detail.environment = environmentDetail;

    return finish({ result_class: "completed", detail });
  } finally {
    // A teardown failure must never override the primary outcome computed
    // above by rejecting `runCell` (review 2 finding 7f5ab0d8) — log and
    // strand the worktree rather than throw. Matches results.ts's
    // non-fatal-write convention.
    if (worktreeCreated) {
      // Each simulated dependency's declared teardown runs best-effort,
      // before the worktree itself is removed (review 1 finding ed37a4fd) —
      // a teardown failure is logged, not thrown, matching the worktree
      // removal convention just below.
      for (const dep of simulated) {
        try {
          await runEnvironmentCommandFn({
            worktreeDir: identity.worktreePath,
            command: dep.teardown,
            phase: "teardown",
            deadlineMs: 30_000,
          });
        } catch (err) {
          console.warn(`[pipeline] evals: simulated dependency ${JSON.stringify(dep.name)} teardown failed (non-fatal): ${(err as Error).message}`);
        }
      }
      try {
        await removeWorktreeFn(cfg, { path: identity.worktreePath, branch: identity.branch });
      } catch (err) {
        console.warn(
          `[pipeline] evals: worktree removal failed (non-fatal, worktree may be stranded at ${identity.worktreePath}): ${(err as Error).message}`,
        );
      }
    }
  }
}

/** Best-effort extraction of `findings` from a review-mode harness's stdout,
 *  which is expected to be the review-verdict JSON (review-schema.ts) when
 *  the harness followed the prompt. Returns `undefined` — not a grading
 *  failure — when stdout is not that shape; the review grader then reports
 *  every seeded defect as an unmatched false negative rather than throwing. */
function parseReviewFindings(stdout: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).findings)) {
      return (parsed as Record<string, unknown>).findings as unknown[];
    }
  } catch {
    // Not JSON — leave undefined.
  }
  return undefined;
}

/** Best-effort extraction of a treatment-emitted self-assessment from
 *  planning-mode stdout, recorded as an observation only (types.ts) — the
 *  planning grader must never read this as a grade input. */
function parseSelfAssessment(stdout: string): unknown {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return obj.self_assessment ?? obj.self_score ?? obj.confidence;
    }
  } catch {
    // Not JSON — no self-assessment to record.
  }
  return undefined;
}

/** Classify a non-timeout, non-spawn-error invocation *failure*
 *  (`!result.success`) as an auth/quota/rate-limit refusal rather than a
 *  genuine treatment outcome (review 2 finding f97442bc). Two signals: the
 *  adapter's own throttle telemetry, and a preflight recheck — credentials
 *  that were valid before the call can expire mid-run. Never throws: a
 *  recheck failure falls through to "not an auth failure" rather than
 *  fabricating a classification. */
async function classifyPostInvocationFailure(
  result: HarnessInvokeResultLike,
  preflightFn: NonNullable<CellExecutionDeps["preflight"]>,
  harness: string,
  req: { model?: string; effort?: string },
): Promise<string | null> {
  if (result.throttled === true) {
    return "was refused by a provider-side rate limit/throttle signal";
  }
  try {
    const recheck = await preflightFn(harness, req);
    if (!recheck.ok && recheck.failure === "unauthenticated") {
      return `failed authentication mid-invocation: ${recheck.message ?? "credentials expired or were revoked"}`;
    }
  } catch {
    // Best-effort recheck only — a broken preflight probe here must not
    // reclassify or mask the primary invocation outcome.
    return null;
  }
  return null;
}
