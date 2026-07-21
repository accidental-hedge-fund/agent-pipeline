// Shared deterministic helpers for the graders: allowed-change-path
// matching, line-range overlap, severity ranking, and the base-commit check
// baseline (design.md decision 3 — "a regression is measured, not inferred").

import * as path from "node:path";
import { createWorktreeAt, removeWorktreeAt } from "../../worktree.ts";
import type { PipelineConfig } from "../../types.ts";

/** A changed path is in scope when it equals a declared allowed path or sits
 *  under one as a directory prefix. */
export function isPathAllowed(changedPath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => changedPath === allowed || changedPath.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

export function countOutOfScopeChanges(changedPaths: string[], allowedPaths: string[]): number {
  return changedPaths.filter((p) => !isPathAllowed(p, allowedPaths)).length;
}

/** Two inclusive line ranges overlap when neither ends before the other
 *  starts. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Unranked/unknown severities rank as 0 rather than throwing — a finding
 *  reporting an unrecognized severity string is still comparable, just at
 *  the bottom of the scale. */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.toLowerCase()] ?? 0;
}

export interface CheckRunnerDeps {
  runChecks?: (args: { worktreeDir: string; checks: string[] }) => Promise<Record<string, boolean>>;
  createWorktree?: (
    cfg: PipelineConfig,
    opts: { path: string; branch: string; baseCommit: string },
  ) => Promise<{ path: string; branch: string }>;
  removeWorktree?: (cfg: PipelineConfig, opts: { path: string; branch: string }) => Promise<void>;
}

async function defaultRunChecks(args: { worktreeDir: string; checks: string[] }): Promise<Record<string, boolean>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const results: Record<string, boolean> = {};
  for (const check of args.checks) {
    try {
      await execFileAsync("sh", ["-c", check], { cwd: args.worktreeDir, timeout: 300_000 });
      results[check] = true;
    } catch {
      results[check] = false;
    }
  }
  return results;
}

/** Establish the base-commit check baseline for one fixture: create a scratch
 *  worktree at `baseCommit`, run every declared check there, tear it down.
 *  Callers memoize by `(fixture_id, base_commit)` (grade.ts) so this runs at
 *  most once per fixture per grading pass, regardless of how many cells
 *  reference it (design.md's "Baseline check cost" trade-off). */
export async function runBaselineChecks(
  cfg: PipelineConfig,
  fixtureId: string,
  baseCommit: string,
  checks: string[],
  deps: CheckRunnerDeps = {},
): Promise<Record<string, boolean>> {
  if (checks.length === 0) return {};
  const createWorktreeFn = deps.createWorktree ?? ((c, o) => createWorktreeAt(c, o));
  const removeWorktreeFn = deps.removeWorktree ?? ((c, o) => removeWorktreeAt(c, o));
  const runChecksFn = deps.runChecks ?? defaultRunChecks;

  const slug = `baseline-${fixtureId}-${baseCommit}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const worktreeDir = path.join(cfg.repo_dir, ".worktrees", "eval-baselines", slug);
  const branch = `pipeline-eval-baseline/${slug}`;

  await createWorktreeFn(cfg, { path: worktreeDir, branch, baseCommit });
  try {
    return await runChecksFn({ worktreeDir, checks });
  } finally {
    try {
      await removeWorktreeFn(cfg, { path: worktreeDir, branch });
    } catch (err) {
      console.warn(`[pipeline] evals: baseline worktree removal failed (non-fatal): ${(err as Error).message}`);
    }
  }
}
