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
import { getIssueStateAndLabels } from "./gh.ts";
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

interface WorktreeRecord {
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
