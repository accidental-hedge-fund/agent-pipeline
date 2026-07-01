// Lock-file side-effect inclusion (#358).
//
// After a fix-round harness commits source changes, it may leave lock-file side-
// effects (package-lock.json, yarn.lock, pnpm-lock.yaml) uncommitted. This module
// detects and folds those into the round's HEAD commit so the worktree is clean
// before the format/test gates run.
//
// Injectable seams (gitStatusPorcelain, gitAddPaths, gitAmendNoEdit) allow unit
// tests to drive the logic with fakes — no real git, network, or subprocess calls.

import { gitInWorktree } from "./worktree.ts";

export interface LockfileSideEffectsDeps {
  /** Returns raw `git status --porcelain` output for the worktree. */
  gitStatusPorcelain?: (wtPath: string) => Promise<string>;
  /** Stages the given paths via `git add -- <paths>`. */
  gitAddPaths?: (wtPath: string, paths: string[]) => Promise<void>;
  /** Amends HEAD without changing the commit message via `git commit --amend --no-edit`. */
  gitAmendNoEdit?: (wtPath: string) => Promise<void>;
}

export type LockfileInclusionResult =
  | { included: false }
  | { included: true; paths: string[] };

// ---------------------------------------------------------------------------
// Lock-file name recognition
// ---------------------------------------------------------------------------

const LOCK_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

/** Returns true when the basename of a porcelain path is a recognized lock file. */
export function isLockFilePath(p: string): boolean {
  const parts = p.replace(/\\/g, "/").split("/");
  return LOCK_BASENAMES.has(parts[parts.length - 1]);
}

// ---------------------------------------------------------------------------
// Default git implementations
// ---------------------------------------------------------------------------

async function defaultGitStatusPorcelain(wtPath: string): Promise<string> {
  const res = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout;
}

async function defaultGitAddPaths(wtPath: string, paths: string[]): Promise<void> {
  await gitInWorktree(wtPath, ["add", "--", ...paths]);
}

async function defaultGitAmendNoEdit(wtPath: string): Promise<void> {
  await gitInWorktree(wtPath, ["commit", "--amend", "--no-edit"]);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Detect uncommitted lock-file changes in the worktree and fold them into HEAD.
 *
 * When at least one recognized lock file (`package-lock.json`, `yarn.lock`, or
 * `pnpm-lock.yaml`) appears in `git status --porcelain`, this function stages
 * only those paths and amends HEAD via `git commit --amend --no-edit`, preserving
 * the round commit's message and `Issue:`/`Pipeline-Run:` trailers.
 *
 * Returns `{ included: false }` when no lock file is dirty (no git writes occur).
 * Returns `{ included: true; paths }` listing the lock-file paths that were folded in.
 *
 * Only lock files are staged — non-lock uncommitted paths are left untouched.
 */
export async function includeLockfileSideEffects(
  wtPath: string,
  deps: LockfileSideEffectsDeps = {},
): Promise<LockfileInclusionResult> {
  const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const addFn = deps.gitAddPaths ?? defaultGitAddPaths;
  const amendFn = deps.gitAmendNoEdit ?? defaultGitAmendNoEdit;

  const raw = await statusFn(wtPath);

  // Parse porcelain output: each line is "XY path" or "XY old -> new" (rename).
  // We only care about the working-tree filename (last segment after " -> " if any).
  const lockPaths: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain v1: columns 0-1 are status codes, column 2 is a space, then the path.
    const pathPart = line.slice(3);
    // Handle rename: "old -> new" — we want the destination.
    const filePath = pathPart.includes(" -> ") ? pathPart.split(" -> ")[1] : pathPart;
    const trimmed = filePath.trim();
    if (trimmed && isLockFilePath(trimmed)) {
      lockPaths.push(trimmed);
    }
  }

  if (lockPaths.length === 0) return { included: false };

  await addFn(wtPath, lockPaths);
  await amendFn(wtPath);

  return { included: true, paths: lockPaths };
}
