// Lock-file side-effect inclusion (#358).
//
// After a fix-round harness commits source changes, it may leave lock-file side-
// effects (package-lock.json, yarn.lock, pnpm-lock.yaml) uncommitted. This module
// detects and folds those into the round's HEAD commit so the worktree is clean
// before the format/test gates run.
//
// Injectable seams (gitStatusPorcelain, gitAddPaths, gitAmendNoEdit, gitRestoreStaged,
// gitRmCached) allow unit tests to drive the logic with fakes — no real git, network,
// or subprocess calls.

import { gitInWorktree } from "./worktree.ts";

export interface LockfileSideEffectsDeps {
  /** Returns raw `git status --porcelain` output for the worktree. */
  gitStatusPorcelain?: (wtPath: string) => Promise<string>;
  /** Stages the given paths via `git add -- <paths>`. */
  gitAddPaths?: (wtPath: string, paths: string[]) => Promise<void>;
  /** Amends HEAD without changing the commit message via `git commit --amend --no-edit`. */
  gitAmendNoEdit?: (wtPath: string) => Promise<void>;
  /** Unstages the given paths via `git restore --staged -- <paths>`. */
  gitRestoreStaged?: (wtPath: string, paths: string[]) => Promise<void>;
  /** Removes paths from the index via `git rm --cached -- <paths>` (for staged deletions). */
  gitRmCached?: (wtPath: string, paths: string[]) => Promise<void>;
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

async function defaultGitRestoreStaged(wtPath: string, paths: string[]): Promise<void> {
  await gitInWorktree(wtPath, ["restore", "--staged", "--", ...paths]);
}

async function defaultGitRmCached(wtPath: string, paths: string[]): Promise<void> {
  await gitInWorktree(wtPath, ["rm", "--cached", "--", ...paths]);
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
 * Any pre-existing staged non-lock entries are temporarily unstaged before the
 * amend so they are not swept into the lock-file amend commit, then restored to
 * staged afterward.
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
  const restoreStagedFn = deps.gitRestoreStaged ?? defaultGitRestoreStaged;
  const rmCachedFn = deps.gitRmCached ?? defaultGitRmCached;

  const raw = await statusFn(wtPath);

  // Parse porcelain output: each line is "XY path" or "XY old -> new" (rename).
  // X = index (staged) status; Y = worktree status.
  // We only care about the working-tree filename (last segment after " -> " if any).
  const lockPaths: string[] = [];
  // Pre-staged non-lock entries that must be temporarily unstaged before the amend
  // so they are not swept into the lock-file amend commit.
  const preStagedNonLock: Array<{ path: string; isDeletion: boolean }> = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain v1: columns 0-1 are status codes, column 2 is a space, then the path.
    const x = line[0];
    const pathPart = line.slice(3);

    if (pathPart.includes(" -> ")) {
      // Rename/copy porcelain entry: "src -> dst". Track both sides so neither
      // the staged deletion (src) nor the staged addition (dst) is swept into
      // the lock-file amend.
      const arrowIdx = pathPart.indexOf(" -> ");
      const src = pathPart.slice(0, arrowIdx).trim();
      const dst = pathPart.slice(arrowIdx + 4).trim();
      if (!dst) continue;
      if (isLockFilePath(dst)) {
        lockPaths.push(dst);
      } else if (x !== ' ' && x !== '?') {
        preStagedNonLock.push({ path: src, isDeletion: true });
        preStagedNonLock.push({ path: dst, isDeletion: false });
      }
    } else {
      const trimmed = pathPart.trim();
      if (!trimmed) continue;
      if (isLockFilePath(trimmed)) {
        lockPaths.push(trimmed);
      } else if (x !== ' ' && x !== '?') {
        // Non-lock file already staged — preserve its staged state through the amend.
        preStagedNonLock.push({ path: trimmed, isDeletion: x === 'D' });
      }
    }
  }

  if (lockPaths.length === 0) return { included: false };

  // Temporarily unstage non-lock staged entries so the amend only picks up lock files.
  if (preStagedNonLock.length > 0) {
    await restoreStagedFn(wtPath, preStagedNonLock.map((e) => e.path));
  }

  await addFn(wtPath, lockPaths);
  await amendFn(wtPath);

  // Restore the pre-existing staged state for non-lock entries.
  if (preStagedNonLock.length > 0) {
    const toAdd = preStagedNonLock.filter((e) => !e.isDeletion).map((e) => e.path);
    const toRm = preStagedNonLock.filter((e) => e.isDeletion).map((e) => e.path);
    if (toAdd.length > 0) await addFn(wtPath, toAdd);
    if (toRm.length > 0) await rmCachedFn(wtPath, toRm);
  }

  return { included: true, paths: lockPaths };
}
