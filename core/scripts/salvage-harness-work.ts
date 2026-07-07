// Salvage of uncommitted harness work (#131).
//
// When a harness step (implement, fix round, test-fix) exits leaving uncommitted
// changes in the worktree but no new commit in its range, the pipeline stages and
// commits the leftover work instead of hard-blocking with "No commits found in
// the range" and discarding a potentially complete change. The salvaged commit
// then flows through the SAME downstream verification (commit checks, test gate)
// as a harness-authored commit — salvage never bypasses validation.
//
// A `SalvageDeps` seam is accepted so tests can inject fake git operations
// without spawning real git processes (mirrors `VerifyDeps`).

import { gitInWorktree } from "./worktree.ts";
import { withTrailers } from "./traceability.ts";

export interface SalvageDeps {
  /** `git status --porcelain` output for the worktree ("" when clean).
   *  When the caller supplies a staging scope, `scope` is the pathspec so the
   *  status check is restricted to in-scope paths only. */
  gitStatus?: (wtPath: string, scope?: string) => Promise<string>;
  /**
   * Unstage index entries outside the scope before the scoped git-add.
   * Only invoked when a staging scope is provided. Args are the full
   * `git restore --staged` argument array. Using `--staged` touches only
   * the index; the working-tree content is left intact (no `git restore`
   * without `--staged` is ever called).
   */
  gitRestoreStaged?: (wtPath: string, args: string[]) => Promise<void>;
  /**
   * Stage changes in the worktree using the provided git-add args array.
   * The default implementation passes `["add", "-A", "--", ":(exclude)node_modules"]`
   * so that a node_modules symlink or directory is never staged even if
   * `.git/info/exclude` is absent or stale.  The args are passed through as
   * a parameter so tests can assert the required pathspec without relying on
   * the default implementation.
   */
  gitAddAll?: (wtPath: string, args: string[]) => Promise<void>;
  /** `git commit -m <message>` in the worktree. */
  gitCommit?: (wtPath: string, message: string) => Promise<void>;
}

export type SalvageResult = { salvaged: false } | { salvaged: true; message: string };

// ---------------------------------------------------------------------------
// Default git implementations
// ---------------------------------------------------------------------------

async function defaultGitStatus(wtPath: string, scope?: string): Promise<string> {
  // ignoreFailure: a failing `git status` reads as clean → no salvage → the
  // caller falls through to its existing block path (never worse than today).
  const args = scope
    ? ["status", "--porcelain", "--", scope]
    : ["status", "--porcelain"];
  const res = await gitInWorktree(wtPath, args, { ignoreFailure: true });
  return res.stdout;
}

const SALVAGE_GIT_ADD_ARGS = ["add", "-A", "--", ":(exclude)node_modules"];

async function defaultGitRestoreStaged(wtPath: string, args: string[]): Promise<void> {
  await gitInWorktree(wtPath, args);
}

async function defaultGitAddAll(wtPath: string, args: string[]): Promise<void> {
  await gitInWorktree(wtPath, args);
}

async function defaultGitCommit(wtPath: string, message: string): Promise<void> {
  await gitInWorktree(wtPath, ["commit", "-m", message]);
}

// ---------------------------------------------------------------------------
// Salvage commit message
// ---------------------------------------------------------------------------

/**
 * Build the salvage commit message: a fixed `salvage:` subject (grep-visible,
 * clearly pipeline-owned), a body attributing the commit to the named harness
 * step, and the standard `Issue:` / `Pipeline-Run:` traceability trailers (#20).
 *
 * The downstream message-format gates (fix round, test-fix) match their
 * prescribed subject against the full commit message (subject + body), so a
 * `stageLabel` that includes the step's prescribed commit subject makes the
 * salvaged commit satisfy that gate and the run proceeds to the test gate.
 */
export function buildSalvageCommitMessage(
  issueNumber: number,
  pipelineRunId: string,
  stageLabel: string,
): string {
  const subject = `salvage: stage harness work (#${issueNumber})`;
  const body =
    `Pipeline-salvaged commit: the ${stageLabel} harness completed work in the ` +
    `worktree but exited without committing. The pipeline staged and committed ` +
    `the leftover changes so the normal downstream verification (commit checks, ` +
    `test gate) validates the work instead of discarding it.`;
  return withTrailers(`${subject}\n\n${body}`, issueNumber, pipelineRunId);
}

// ---------------------------------------------------------------------------
// Salvage entry points
// ---------------------------------------------------------------------------

/**
 * Stage and commit leftover uncommitted harness work in the worktree.
 *
 * Returns `{ salvaged: false }` when the worktree is clean (nothing to salvage —
 * the caller keeps its existing block/auto-recover path), or `{ salvaged: true }`
 * after `git add -A` + `git commit` with the salvage message. Git failures from
 * the add/commit seams propagate to the caller.
 *
 * @param stageLabel - Descriptor of the harness step, included verbatim in the
 *   salvage commit body. When the step's commit-range verification prescribes a
 *   message format, include the prescribed subject in the label (see
 *   `fixSalvageStageLabel` / `testFixSalvageStageLabel`) so the salvaged commit
 *   satisfies that gate.
 */
export async function salvageUncommittedWork(
  wtPath: string,
  issueNumber: number,
  pipelineRunId: string,
  stageLabel: string,
  deps: SalvageDeps = {},
  scope?: string,
): Promise<SalvageResult> {
  const status = await (deps.gitStatus ?? defaultGitStatus)(wtPath, scope);
  if (!status.trim()) return { salvaged: false };
  const message = buildSalvageCommitMessage(issueNumber, pipelineRunId, stageLabel);
  if (scope) {
    // Unstage any pre-staged out-of-scope index entries before the scoped add.
    // git-commit stages ALL index entries, not just the ones added in this call,
    // so a pre-staged tasks/todo.md would leak into the commit unless we clear it
    // first. git-restore --staged only touches the index; working-tree content is
    // left intact.
    const restoreArgs = ["restore", "--staged", "--", ".", `:(exclude)${scope}`];
    await (deps.gitRestoreStaged ?? defaultGitRestoreStaged)(wtPath, restoreArgs);
  }
  const addArgs = scope
    ? ["add", "-A", "--", ":(exclude)node_modules", scope]
    : SALVAGE_GIT_ADD_ARGS;
  await (deps.gitAddAll ?? defaultGitAddAll)(wtPath, addArgs);
  await (deps.gitCommit ?? defaultGitCommit)(wtPath, message);
  return { salvaged: true, message };
}

/**
 * Non-throwing wrapper for the stage call sites: a salvage failure must never
 * make the run worse than today's block path, so errors are logged and treated
 * as "nothing salvaged" (the caller falls through to its existing block).
 * Returns `true` only when a salvage commit was created.
 */
export async function trySalvageUncommittedWork(
  wtPath: string,
  issueNumber: number,
  pipelineRunId: string,
  stageLabel: string,
  deps: SalvageDeps = {},
  scope?: string,
): Promise<boolean> {
  try {
    const res = await salvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel, deps, scope);
    if (res.salvaged) {
      console.log(
        `[pipeline] #${issueNumber}: salvaged uncommitted ${stageLabel} harness work into a commit`,
      );
    }
    return res.salvaged;
  } catch (err) {
    console.warn(
      `[pipeline] #${issueNumber}: salvage of uncommitted ${stageLabel} harness work failed: ${(err as Error).message}`,
    );
    return false;
  }
}
