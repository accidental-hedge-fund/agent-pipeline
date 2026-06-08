// Git worktree lifecycle for pipeline issues.
//
// Conventions:
//   - Worktree dir: <repo>/.worktrees/pipeline-<issueN>-<slug>
//   - Branch:       pipeline/<issueN>-<slug>
//
// All paths are absolute. Shells out to `git` via execFile.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getIssueStateAndLabels, getPrMergeState } from "./gh.ts";
import type { PipelineConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function worktreeRoot(cfg: PipelineConfig): string {
  return path.resolve(cfg.repo_dir, cfg.worktree_root);
}

export function worktreePath(cfg: PipelineConfig, issueNumber: number, slug: string): string {
  return path.join(worktreeRoot(cfg), `pipeline-${issueNumber}-${slug}`);
}

export function branchName(issueNumber: number, slug: string): string {
  return `pipeline/${issueNumber}-${slug}`;
}

async function git(
  cfg: PipelineConfig,
  cwd: string,
  args: string[],
  opts: { ignoreFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
    if (opts.ignoreFailure) {
      return {
        stdout: (e.stdout ?? "").toString(),
        stderr: (e.stderr ?? "").toString(),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

export interface WorktreeRecord {
  path: string;
  branch?: string;
  issueNumber?: number;
  slug?: string;
}

/** Raw on-disk listing — every git worktree whose branch starts with
 *  `pipeline/<N>-<slug>`. Includes worktrees for issues that are already
 *  closed or sitting at `pipeline:ready-to-deploy`. */
export async function listOnDisk(cfg: PipelineConfig): Promise<WorktreeRecord[]> {
  const { stdout } = await git(cfg, cfg.repo_dir, ["worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) records.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      if (current?.path) records.push(current);
      current = null;
    }
  }
  if (current?.path) records.push(current);

  const pipelineRecords: WorktreeRecord[] = [];
  for (const rec of records) {
    if (!rec.branch?.startsWith("pipeline/")) continue;
    const rest = rec.branch.slice("pipeline/".length);
    const m = rest.match(/^(\d+)-(.+)$/);
    if (m) {
      rec.issueNumber = Number.parseInt(m[1], 10);
      rec.slug = m[2];
      pipelineRecords.push(rec);
    }
  }
  return pipelineRecords;
}

/** Worktrees backing issues that are still in-flight — open on GitHub AND
 *  not already at `pipeline:ready-to-deploy`. This is what
 *  `max_concurrent_worktrees` should gate on; closed-issue and terminal
 *  worktrees occupy disk but no longer represent active work.
 *  On `gh` lookup failure we treat the worktree as active (fail safe — never
 *  let a transient API blip silently uncap concurrency). */
export async function listActive(cfg: PipelineConfig): Promise<WorktreeRecord[]> {
  const onDisk = await listOnDisk(cfg);
  const states = await Promise.all(
    onDisk.map((rec) =>
      rec.issueNumber === undefined
        ? Promise.resolve(null)
        : getIssueStateAndLabels(cfg, rec.issueNumber),
    ),
  );
  return onDisk.filter((_, i) => {
    const s = states[i];
    if (s === null) return true; // treat unknown as active
    if (s.state === "closed") return false;
    if (s.labels.includes("pipeline:ready-to-deploy")) return false;
    return true;
  });
}

export async function countActive(cfg: PipelineConfig): Promise<number> {
  return (await listActive(cfg)).length;
}

export async function getForIssue(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<{ path: string; slug: string } | null> {
  for (const rec of await listActive(cfg)) {
    if (rec.issueNumber === issueNumber && rec.slug) {
      return { path: rec.path, slug: rec.slug };
    }
  }
  return null;
}

export async function branchExists(
  cfg: PipelineConfig,
  branch: string,
): Promise<boolean> {
  const { code } = await git(
    cfg,
    cfg.repo_dir,
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    { ignoreFailure: true },
  );
  return code === 0;
}

export async function createWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
): Promise<{ path: string; branch: string }> {
  const active = await countActive(cfg);
  if (active >= cfg.max_concurrent_worktrees) {
    throw new Error(
      `At worktree capacity (${active}/${cfg.max_concurrent_worktrees}). ` +
        "Wait for an issue to complete before starting new work.",
    );
  }

  const wtPath = worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);

  // If a worktree already exists at the path, remove it (stale).
  if (fs.existsSync(wtPath)) {
    await removeWorktree(cfg, issueNumber, slug);
  }

  // Ensure the worktree root exists.
  fs.mkdirSync(worktreeRoot(cfg), { recursive: true });

  // Fetch the latest base branch.
  await git(cfg, cfg.repo_dir, ["fetch", "origin", cfg.base_branch], { ignoreFailure: false });

  // If the branch exists from a prior failed attempt, delete it.
  await git(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });

  // Create the worktree.
  const { code, stderr } = await git(
    cfg,
    cfg.repo_dir,
    ["worktree", "add", wtPath, "-b", branch, `origin/${cfg.base_branch}`],
    { ignoreFailure: true },
  );
  if (code !== 0) {
    throw new Error(`git worktree add failed: ${stderr.trim()}`);
  }
  return { path: wtPath, branch };
}

export async function removeWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
): Promise<void> {
  const wtPath = worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);
  if (fs.existsSync(wtPath)) {
    await git(cfg, cfg.repo_dir, ["worktree", "remove", wtPath, "--force"], { ignoreFailure: true });
  }
  await git(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });
}

// Convenience helpers used by stage handlers.

export async function gitInWorktree(
  cwd: string,
  args: string[],
  opts: { ignoreFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
    if (opts.ignoreFailure) {
      return {
        stdout: (e.stdout ?? "").toString(),
        stderr: (e.stderr ?? "").toString(),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

export async function hasCommitsAhead(cwd: string, baseBranch: string): Promise<boolean> {
  const { stdout } = await gitInWorktree(
    cwd,
    ["log", `origin/${baseBranch}..HEAD`, "--oneline"],
    { ignoreFailure: true },
  );
  return stdout.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Worktree sweep (cleanup of merged-PR worktrees)
// ---------------------------------------------------------------------------

/** Pure parser — exposed for unit tests. */
export function parseDirtyWorkdir(statusOutput: string): boolean {
  return statusOutput.trim().length > 0;
}

/** Pure — exposed for unit tests. Fail-closed: a non-zero exit code (e.g. index lock,
 *  permission error) is treated as dirty so the worktree is never silently removed. */
export function isDirtyResult(code: number, stdout: string): boolean {
  if (code !== 0) return true;
  return parseDirtyWorkdir(stdout);
}

export async function hasDirtyWorkdir(worktreePath: string): Promise<boolean> {
  const { stdout, code } = await gitInWorktree(
    worktreePath,
    ["status", "--porcelain"],
    { ignoreFailure: true },
  );
  return isDirtyResult(code, stdout);
}

async function getWorktreeHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await gitInWorktree(
    worktreePath,
    ["rev-parse", "HEAD"],
    { ignoreFailure: true },
  );
  return stdout.trim();
}

export interface SweepResult {
  removed: WorktreeRecord[];
  skipped: Array<{ rec: WorktreeRecord; reason: string }>;
}

export interface SweepDeps {
  listOnDisk: (cfg: PipelineConfig) => Promise<WorktreeRecord[]>;
  getPrMergeState: (
    cfg: PipelineConfig,
    branch: string,
  ) => Promise<{ merged: true; prNumber: number; headSha: string } | { merged: false; error?: string }>;
  hasDirtyWorkdir: (worktreePath: string) => Promise<boolean>;
  getWorktreeHeadSha: (worktreePath: string) => Promise<string>;
  /** Attempt to remove a worktree and its branch; returns ok/failure so the
   *  caller can report partial success rather than silently claiming removal. */
  removeWorktree: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    pathOnDisk: boolean,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  pathExists: (p: string) => boolean;
}

/** Sweep-specific removal that verifies both worktree deregistration and
 *  branch deletion succeeded before reporting the worktree as removed. */
async function sweepRemoveWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  pathOnDisk: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const wtPath = worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);

  if (pathOnDisk) {
    // Non-forced: if the worktree still has uncommitted changes git will refuse,
    // giving us a second safety net beyond the dirty-check above.
    const r = await git(cfg, cfg.repo_dir, ["worktree", "remove", wtPath], { ignoreFailure: true });
    if (r.code !== 0) {
      return { ok: false, reason: `git worktree remove failed: ${r.stderr.trim()}` };
    }
  } else {
    // Directory is already gone — deregister the specific stale entry only.
    // --force is required because the directory is missing; it is scoped to
    // wtPath and does NOT prune unrelated worktrees (unlike git worktree prune).
    const r = await git(cfg, cfg.repo_dir, ["worktree", "remove", "--force", wtPath], { ignoreFailure: true });
    if (r.code !== 0) {
      return { ok: false, reason: `git worktree remove (stale) failed: ${r.stderr.trim()}` };
    }
  }

  const br = await git(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });
  if (br.code !== 0) {
    return { ok: false, reason: `git branch -D failed: ${br.stderr.trim()}` };
  }

  return { ok: true };
}

/** Remove pipeline-managed worktrees whose PR has already been merged.
 *  Only touches worktrees under cfg.worktree_root with pipeline/<N>-<slug> branches.
 *  Skips dirty worktrees (uncommitted changes) and worktrees whose local HEAD
 *  diverges from the merged PR's head SHA (may have unpushed commits).
 *  Deps are injectable for unit testing; defaults use real implementations. */
export async function sweepMergedWorktrees(
  cfg: PipelineConfig,
  deps?: Partial<SweepDeps>,
): Promise<SweepResult> {
  const d: SweepDeps = {
    listOnDisk,
    getPrMergeState,
    hasDirtyWorkdir,
    getWorktreeHeadSha,
    removeWorktree: sweepRemoveWorktree,
    pathExists: fs.existsSync,
    ...deps,
  };

  const onDisk = await d.listOnDisk(cfg);
  const root = path.resolve(cfg.repo_dir, cfg.worktree_root);

  const candidates = onDisk.filter(
    (rec) => rec.path === root || rec.path.startsWith(root + path.sep),
  );

  const removed: WorktreeRecord[] = [];
  const skipped: Array<{ rec: WorktreeRecord; reason: string }> = [];

  for (const rec of candidates) {
    if (!rec.branch || rec.issueNumber === undefined || !rec.slug) continue;

    const mergeState = await d.getPrMergeState(cfg, rec.branch);
    if (!mergeState.merged) {
      if (mergeState.error !== undefined) {
        skipped.push({ rec, reason: `could not determine PR merge state: ${mergeState.error}` });
      }
      continue;
    }

    // Path gone on disk but still registered — deregister and clean branch.
    if (!d.pathExists(rec.path)) {
      const result = await d.removeWorktree(cfg, rec.issueNumber, rec.slug, false);
      if (result.ok) {
        removed.push(rec);
      } else {
        skipped.push({ rec, reason: `removal failed: ${result.reason}` });
      }
      continue;
    }

    const dirty = await d.hasDirtyWorkdir(rec.path);
    if (dirty) {
      skipped.push({ rec, reason: "uncommitted changes" });
      continue;
    }

    const localSha = await d.getWorktreeHeadSha(rec.path);
    if (localSha && localSha !== mergeState.headSha) {
      skipped.push({
        rec,
        reason: "local HEAD differs from merged PR SHA (may have unpushed commits)",
      });
      continue;
    }

    const result = await d.removeWorktree(cfg, rec.issueNumber, rec.slug, true);
    if (result.ok) {
      removed.push(rec);
    } else {
      skipped.push({ rec, reason: `removal failed: ${result.reason}` });
    }
  }

  return { removed, skipped };
}
