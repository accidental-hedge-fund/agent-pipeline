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
}

export interface HarnessInvokeResultLike {
  success: boolean;
  timed_out: boolean;
  spawn_error?: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration: number;
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
    if (harness) {
      const preflightResult = await preflightFn(harness, {
        model: cell.treatment.model,
        effort: cell.treatment.effort,
      });
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

    const stageDetails: Record<string, unknown>[] = [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const prompt = prompts[i];
      let result: HarnessInvokeResultLike;
      try {
        result = await invokeHarnessFn({
          harness: harness ?? "claude",
          worktreeDir: identity.worktreePath,
          prompt,
          timeoutSec: manifest.timeout,
          model: cell.treatment.model,
          effort: cell.treatment.effort,
          gh: ghSurface,
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
    if (worktreeCreated) {
      await removeWorktreeFn(cfg, { path: identity.worktreePath, branch: identity.branch });
    }
  }
}
