// Post-harness format/lint normalization gate (#182).
//
// Runs configured format_gate entries (in order) inside the worktree after the
// implementing and fix-round harnesses exit. auto_fix: true entries commit any
// worktree changes produced by the command and re-run to verify stability.
// auto_fix: false entries block immediately on non-zero exit. A no-op when
// format_gate is absent or empty.

import { spawn } from "node:child_process";
import { gitInWorktree } from "../worktree.ts";
import type { PipelineConfig } from "../types.ts";

export type FormatGateResult =
  | { status: "ok" }
  | { status: "blocked"; reason: string };

export interface FormatGateDeps {
  /** Run a shell command in the worktree, capturing combined stdout+stderr. */
  execInWorktree?: (wtPath: string, cmd: string) => Promise<{ code: number; combined: string }>;
  /** Returns true when the worktree has uncommitted changes. */
  gitIsDirty?: (wtPath: string) => Promise<boolean>;
  /** Stage all changes and create a commit with the given message. */
  gitCommit?: (wtPath: string, message: string) => Promise<void>;
}

/**
 * Run every format_gate entry in config.format_gate (in order) inside the
 * worktree. Returns { status: "ok" } when all pass, or { status: "blocked",
 * reason } on the first failure. A no-op when format_gate is absent or empty.
 */
export async function runFormatGate(
  wtPath: string,
  config: Pick<PipelineConfig, "format_gate">,
  issueNumber: number,
  deps: FormatGateDeps = {},
): Promise<FormatGateResult> {
  const entries = config.format_gate;
  if (!entries || entries.length === 0) return { status: "ok" };

  const exec = deps.execInWorktree ?? defaultExecInWorktree;
  const isDirty = deps.gitIsDirty ?? defaultGitIsDirty;
  const commitFn = deps.gitCommit ?? defaultGitCommit;

  for (const entry of entries) {
    const { command, auto_fix } = entry;

    if (auto_fix) {
      // Run the auto-fix command; block if it fails to run at all.
      const r1 = await exec(wtPath, command);
      if (r1.code !== 0) {
        return {
          status: "blocked",
          reason: `Format gate command '${command}' failed:\n${r1.combined}`,
        };
      }
      // Commit any changes the command produced, then re-run to verify stability.
      if (await isDirty(wtPath)) {
        await commitFn(wtPath, `chore: auto-format (#${issueNumber})`);
        const r2 = await exec(wtPath, command);
        if (r2.code !== 0) {
          return {
            status: "blocked",
            reason: `Format gate command '${command}' failed after auto-fix:\n${r2.combined}`,
          };
        }
      }
    } else {
      // Check-only: block immediately on non-zero exit, no worktree mutation.
      const r = await exec(wtPath, command);
      if (r.code !== 0) {
        return {
          status: "blocked",
          reason: `Format gate command '${command}' failed:\n${r.combined}`,
        };
      }
    }
  }

  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

const MAX_OUTPUT = 10_000;

async function defaultExecInWorktree(
  wtPath: string,
  cmd: string,
): Promise<{ code: number; combined: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: wtPath });
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    child.on("close", (code) => {
      const combined = Buffer.concat(chunks).toString("utf8").slice(0, MAX_OUTPUT);
      resolve({ code: code ?? 1, combined });
    });
    child.on("error", (err) => {
      resolve({ code: 1, combined: err.message });
    });
  });
}

async function defaultGitIsDirty(wtPath: string): Promise<boolean> {
  const r = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return r.stdout.trim().length > 0;
}

async function defaultGitCommit(wtPath: string, message: string): Promise<void> {
  await gitInWorktree(wtPath, ["add", "-A"], { ignoreFailure: true });
  await gitInWorktree(wtPath, ["commit", "-m", message], { ignoreFailure: true });
}
