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
  /** `git status --porcelain` output for the worktree ("" when clean). */
  gitStatus?: (wtPath: string) => Promise<string>;
  /** `git add -A` in the worktree. */
  gitAddAll?: (wtPath: string) => Promise<void>;
  /** `git commit -m <message>` in the worktree. */
  gitCommit?: (wtPath: string, message: string) => Promise<void>;
}

export type SalvageResult = { salvaged: false } | { salvaged: true; message: string };

// ---------------------------------------------------------------------------
// Default git implementations
// ---------------------------------------------------------------------------

async function defaultGitStatus(wtPath: string): Promise<string> {
  // ignoreFailure: a failing `git status` reads as clean → no salvage → the
  // caller falls through to its existing block path (never worse than today).
  const res = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout;
}

async function defaultGitAddAll(wtPath: string): Promise<void> {
  await gitInWorktree(wtPath, ["add", "-A"]);
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
): Promise<SalvageResult> {
  const status = await (deps.gitStatus ?? defaultGitStatus)(wtPath);
  if (!status.trim()) return { salvaged: false };
  const message = buildSalvageCommitMessage(issueNumber, pipelineRunId, stageLabel);
  await (deps.gitAddAll ?? defaultGitAddAll)(wtPath);
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
): Promise<boolean> {
  try {
    const res = await salvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel, deps);
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
