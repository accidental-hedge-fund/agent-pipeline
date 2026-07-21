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
import type { PipelineConfig } from "../types.ts";
import {
  createEvalGhSurface,
  createRecordingRefusalRecorder,
  type EvalGhSurface,
  type GhRefusalRecord,
} from "./gh-eval-surface.ts";
import { materializeStagePrompt, stagesForMode } from "./stage-adapters.ts";
import type { Cell, CellOutcome, EvalStageName, ExperimentManifest, Fixture } from "./types.ts";

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

export interface CellExecutionResult {
  outcome: CellOutcome;
  materializedPrompt: string;
  effectiveConfig: Record<string, unknown>;
  ghRefusals: GhRefusalRecord[];
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

  let worktreeCreated = false;
  try {
    await createWorktreeFn(cfg, {
      path: identity.worktreePath,
      branch: identity.branch,
      baseCommit: cell.base_sha,
    });
    worktreeCreated = true;
  } catch (err) {
    return {
      outcome: { result_class: "infra_error", error: `worktree creation failed: ${(err as Error).message}` },
      materializedPrompt,
      effectiveConfig,
      ghRefusals: recorder.refusals,
    };
  }

  try {
    const harness = cell.treatment.harness;
    const effectiveHarness = harness ?? "claude";

    const resolvedModel = resolveTreatmentModel(effectiveHarness, cell.treatment);
    if (!resolvedModel.ok) {
      return {
        outcome: { result_class: "infra_error", error: resolvedModel.error },
        materializedPrompt,
        effectiveConfig,
        ghRefusals: recorder.refusals,
      };
    }

    if (harness) {
      let preflightResult: PreflightResultLike;
      try {
        preflightResult = await preflightFn(harness, {
          model: resolvedModel.model,
          effort: cell.treatment.effort,
        });
      } catch (err) {
        return {
          outcome: { result_class: "infra_error", error: `preflight failed: ${(err as Error).message}` },
          materializedPrompt,
          effectiveConfig,
          ghRefusals: recorder.refusals,
        };
      }
      if (!preflightResult.ok) {
        const resultClass = preflightResult.failure === "unauthenticated" ? "auth_error" : "infra_error";
        return {
          outcome: { result_class: resultClass, error: preflightResult.message ?? preflightResult.failure },
          materializedPrompt,
          effectiveConfig,
          ghRefusals: recorder.refusals,
        };
      }
    }

    // Per-cell deadline (review 2 finding cb0500d0): a fixed, shared budget
    // for the whole cell, not a fresh `manifest.timeout` handed to every
    // stage — an end-to-end cell can otherwise run to N times its configured
    // budget before being recorded.
    const cellDeadlineMs = Date.now() + manifest.timeout * 1000;

    const stageDetails: Record<string, unknown>[] = [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const prompt = prompts[i];
      const remainingMs = cellDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        return {
          outcome: {
            result_class: "timeout",
            error: `cell exceeded its ${manifest.timeout}s per-cell timeout before stage "${stage}" could start`,
          },
          materializedPrompt,
          effectiveConfig,
          ghRefusals: recorder.refusals,
        };
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
        return {
          outcome: { result_class: "infra_error", error: `harness invocation failed: ${(err as Error).message}` },
          materializedPrompt,
          effectiveConfig,
          ghRefusals: recorder.refusals,
        };
      }

      if (result.timed_out) {
        return {
          outcome: { result_class: "timeout", error: `stage "${stage}" exceeded the per-cell timeout` },
          materializedPrompt,
          effectiveConfig,
          ghRefusals: recorder.refusals,
        };
      }
      if (result.spawn_error) {
        return {
          outcome: { result_class: "infra_error", error: `stage "${stage}" failed to spawn the harness process` },
          materializedPrompt,
          effectiveConfig,
          ghRefusals: recorder.refusals,
        };
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
          return {
            outcome: { result_class: "auth_error", error: `stage "${stage}" ${authFailure}` },
            materializedPrompt,
            effectiveConfig,
            ghRefusals: recorder.refusals,
          };
        }
      }

      stageDetails.push({
        stage,
        success: result.success,
        exit_code: result.exit_code,
        duration: result.duration,
      });
    }

    return {
      outcome: { result_class: "completed", detail: { stages: stageDetails } },
      materializedPrompt,
      effectiveConfig,
      ghRefusals: recorder.refusals,
    };
  } finally {
    // A teardown failure must never override the primary outcome computed
    // above by rejecting `runCell` (review 2 finding 7f5ab0d8) — log and
    // strand the worktree rather than throw. Matches results.ts's
    // non-fatal-write convention.
    if (worktreeCreated) {
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
