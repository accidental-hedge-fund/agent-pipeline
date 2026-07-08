// Build-artifact rebuild-and-fold (#387).
//
// When a repo declares a `build_command`, fix and auto-fix rounds run it after
// committing source edits and fold any resulting artifact changes into that
// round's HEAD commit — so committed generated artifacts (dist/, a plugin
// manifest, a generated mirror) stay fresh and a repo's separate CI
// artifact-drift check never fails on drift the round itself introduced.
// Mirrors the `lockfile-side-effects.ts` (#358) seam pattern one level up: a
// package-manager side-effect there, a build-command side-effect here.
//
// Callers gate the call on a clean post-commit worktree (the round already
// produced a commit and left no uncommitted dirt), so any change observed
// after the build is unambiguously attributable to the build itself — no
// filtering by path/name is needed here, unlike the lock-file helper.
//
// Injectable seams (runBuildCommand, gitStatusPorcelain, gitAddAll,
// gitAmendNoEdit) allow unit tests to drive the logic with fakes — no real
// git, network, or subprocess calls.

import { gitInWorktree } from "./worktree.ts";
import { runCapped } from "./harness.ts";
import { truncate } from "./stages/eval.ts";

export interface BuildSideEffectsDeps {
  /** Runs the declared build command in the worktree; returns its exit code and combined output. */
  runBuildCommand?: (wtPath: string, command: string) => Promise<{ code: number; output: string }>;
  /** Returns raw `git status --porcelain` output for the worktree. */
  gitStatusPorcelain?: (wtPath: string) => Promise<string>;
  /** Stages every worktree change via `git add -A`. */
  gitAddAll?: (wtPath: string) => Promise<void>;
  /** Amends HEAD without changing the commit message via `git commit --amend --no-edit`. */
  gitAmendNoEdit?: (wtPath: string) => Promise<void>;
}

export type BuildArtifactResult =
  | { ran: false }
  | { ran: true; ok: false; output: string }
  | { ran: true; ok: true; amended: false }
  | { ran: true; ok: true; amended: true; paths: string[] };

// Wall-clock cap for a single build-command run. Mirrors setup_command's
// SETUP_TIMEOUT_MS (worktree-setup.ts) — a build is a comparable one-shot
// worktree bootstrap step, not an operator-configurable per-repo knob.
const BUILD_TIMEOUT_SEC = 5 * 60;

// Captured build output included in block reasons; truncated via the shared
// head+tail elision helper (stages/eval.ts) so a long failure log doesn't blow
// out the GitHub comment body limit while preserving both the command's setup
// context and its (usually tail-located) failure summary.
const MAX_BUILD_OUTPUT = 8000;

function combineOutput(res: { stdout: string; stderr: string }): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

async function defaultRunBuildCommand(
  wtPath: string,
  command: string,
): Promise<{ code: number; output: string }> {
  const res = await runCapped(
    "bash",
    ["-c", `set -o pipefail\n${command}`],
    wtPath,
    BUILD_TIMEOUT_SEC,
    false,
    "build-command",
    { killProcessGroup: true },
  );
  let output = combineOutput(res);
  if (res.timed_out) {
    output = `${output}\n\n[build command timed out after ${BUILD_TIMEOUT_SEC}s]`;
  }
  return { code: res.success ? 0 : (res.exit_code || 1), output };
}

async function defaultGitStatusPorcelain(wtPath: string): Promise<string> {
  const res = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout;
}

async function defaultGitAddAll(wtPath: string): Promise<void> {
  await gitInWorktree(wtPath, ["add", "-A"]);
}

async function defaultGitAmendNoEdit(wtPath: string): Promise<void> {
  await gitInWorktree(wtPath, ["commit", "--amend", "--no-edit"]);
}

/** Extracts the worktree-relative path(s) from `git status --porcelain` output. */
function parsePorcelainPaths(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3);
    if (pathPart.includes(" -> ")) {
      const dst = pathPart.slice(pathPart.indexOf(" -> ") + 4).trim();
      if (dst) paths.push(dst);
    } else {
      const trimmed = pathPart.trim();
      if (trimmed) paths.push(trimmed);
    }
  }
  return paths;
}

/**
 * Run the declared build command and fold any resulting worktree changes into HEAD.
 *
 * Returns `{ ran: false }` immediately when no `buildCommand` is declared (inert),
 * or when the worktree already has uncommitted changes before the build would run
 * — an unrelated pre-existing dirty path is left untouched so the caller's own
 * dirty-worktree gate still fires on it downstream, and no build/git write occurs.
 *
 * Otherwise runs the command; a non-zero exit yields `{ ran: true, ok: false,
 * output }` with no git writes. On success, stages any resulting worktree change
 * (necessarily build-introduced, since the tree was verified clean beforehand) and
 * amends HEAD via `git commit --amend --no-edit`, preserving the round commit's
 * message and trailers. When the build produces no diff, no amend occurs.
 */
export async function includeBuildArtifacts(
  wtPath: string,
  buildCommand: string | undefined,
  deps: BuildSideEffectsDeps = {},
): Promise<BuildArtifactResult> {
  const cmd = buildCommand?.trim();
  if (!cmd) return { ran: false };

  const runFn = deps.runBuildCommand ?? defaultRunBuildCommand;
  const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const addAllFn = deps.gitAddAll ?? defaultGitAddAll;
  const amendFn = deps.gitAmendNoEdit ?? defaultGitAmendNoEdit;

  // Guard on a clean worktree immediately before the build runs (#387 tasks 2.2,
  // 5.6): any change observed after the build is then unambiguously attributable
  // to the build itself, and an unrelated pre-existing dirty path is never swept
  // into the fold.
  const preStatus = await statusFn(wtPath);
  if (preStatus.trim()) return { ran: false };

  const res = await runFn(wtPath, cmd);
  if (res.code !== 0) {
    return { ran: true, ok: false, output: truncate(res.output, MAX_BUILD_OUTPUT) };
  }

  const postStatus = await statusFn(wtPath);
  const paths = parsePorcelainPaths(postStatus);
  if (paths.length === 0) {
    return { ran: true, ok: true, amended: false };
  }

  await addAllFn(wtPath);
  await amendFn(wtPath);
  return { ran: true, ok: true, amended: true, paths };
}

/**
 * Block-reason text for a failed build command, distinct from the test-gate's
 * "failed after N fix attempt(s)" wording so operators/recovery tooling can
 * tell a build failure from a genuine test failure.
 */
export function buildFailureBlockReason(command: string, output: string): string {
  return (
    `Declared build_command '${command}' failed while rebuilding generated artifacts ` +
    `for this round's commit:\n\n\`\`\`\n${truncate(output, MAX_BUILD_OUTPUT)}\n\`\`\``
  );
}
