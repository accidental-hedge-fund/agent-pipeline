// Post-harness format/lint normalization gate (#182).
//
// Runs configured format_gate entries (in order) inside the worktree after the
// implementing and fix-round harnesses exit. auto_fix: true entries commit any
// worktree changes produced by the command and re-run to verify stability.
// auto_fix: false entries block immediately on non-zero exit. A no-op when
// format_gate is absent or empty.

import { spawn } from "node:child_process";
import { gitInWorktree } from "../worktree.ts";
import { runTestGate, testGateBlockReason } from "../testgate.ts";
import type { TestGateResult } from "../testgate.ts";
import {
  classifyWorktreeDirt,
  parsePorcelainPaths,
  productDirtyPaths,
} from "../worktree-dirt.ts";
import type { PipelineConfig, Stage } from "../types.ts";
import type { RunStoreDeps } from "../run-store.ts";

export type FormatGateResult =
  | { status: "ok"; committed: boolean }
  | { status: "blocked"; reason: string };

export interface FormatGateDeps {
  /** Run a shell command in the worktree, capturing combined stdout+stderr. */
  execInWorktree?: (wtPath: string, cmd: string) => Promise<{ code: number; combined: string }>;
  /**
   * Returns true when the worktree has **product-relevant** uncommitted changes
   * (#873). Non-product scratch (tasks/**, .pipeline-prompt-*, config extensions)
   * alone must not report dirty for gate trust. Injected tests may continue to
   * drive a pure boolean; production defaults classify porcelain paths.
   */
  gitIsDirty?: (wtPath: string) => Promise<boolean>;
  /** Stage product changes and create a commit with the given message. Returns ok/error. */
  gitCommit?: (wtPath: string, message: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Raw `git status --porcelain` for product-dirt classification (#873). */
  gitStatusPorcelain?: (wtPath: string) => Promise<string>;
}

/**
 * Run every format_gate entry in config.format_gate (in order) inside the
 * worktree. Returns { status: "ok" } when all pass, or { status: "blocked",
 * reason } on the first failure. A no-op when format_gate is absent or empty.
 *
 * `scratchExtraGlobs` is unioned with the engine-known non-product set when
 * classifying dirt (#873); typically `cfg.test_gate.non_product_dirty_globs`.
 */
export async function runFormatGate(
  wtPath: string,
  config: Pick<PipelineConfig, "format_gate">,
  issueNumber: number,
  deps: FormatGateDeps = {},
  scratchExtraGlobs: readonly string[] = [],
): Promise<FormatGateResult> {
  const entries = config.format_gate;
  if (!entries || entries.length === 0) return { status: "ok", committed: false };

  const exec = deps.execInWorktree ?? defaultExecInWorktree;
  const porcelainFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  // Product-dirt check: prefer porcelain classification when available; fall
  // back to the injectable gitIsDirty boolean (test seams / legacy).
  const isProductDirty =
    deps.gitIsDirty ??
    (async (p: string) => {
      const paths = parsePorcelainPaths(await porcelainFn(p));
      return productDirtyPaths(paths, scratchExtraGlobs).length > 0;
    });
  const commitFn =
    deps.gitCommit ??
    ((p: string, message: string) => defaultGitCommit(p, message, scratchExtraGlobs, porcelainFn));
  let committed = false;

  // Pre-flight: block if the worktree already has product dirt before any
  // auto-fix command runs — we cannot distinguish pre-existing harness
  // leftovers from command output, so sweeping them into an auto-format commit
  // is incorrect. Scratch-only dirt is ignored for this trust check (#873).
  const hasAutoFix = entries.some((e) => e.auto_fix);
  if (hasAutoFix && (await isProductDirty(wtPath))) {
    return {
      status: "blocked",
      reason:
        "Format gate blocked: pre-existing uncommitted changes found in worktree before any format command ran " +
        "(product paths only; engine-known scratch such as tasks/todo.md is ignored)",
    };
  }

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
      // Commit product changes the command produced (not scratch), then re-run
      // to verify stability. Scratch-only dirt does not trigger a commit.
      if (await isProductDirty(wtPath)) {
        const commitResult = await commitFn(wtPath, `chore: auto-format (#${issueNumber})`);
        if (!commitResult.ok) {
          return {
            status: "blocked",
            reason: `Format gate auto-format commit failed: ${commitResult.error}`,
          };
        }
        committed = true;
        const r2 = await exec(wtPath, command);
        if (r2.code !== 0) {
          return {
            status: "blocked",
            reason: `Format gate command '${command}' failed after auto-fix:\n${r2.combined}`,
          };
        }
        // Verify the re-run itself did not produce more product changes
        // (non-stable formatter). Scratch-only residual is fine (#873).
        if (await isProductDirty(wtPath)) {
          return {
            status: "blocked",
            reason: `Format gate command '${command}' is non-stable: re-run after auto-fix still produced uncommitted product changes`,
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

  return { status: "ok", committed };
}

// ---------------------------------------------------------------------------
// Format ↔ test convergence (#182)
// ---------------------------------------------------------------------------

export type FormatTestGateResult =
  | { ok: true; gate: TestGateResult }
  // `source` identifies why it blocked so the caller can pass the matching
  // literal BlockerKind: "test" → test-gate-exhausted; "build" (#387: a
  // declared build_command failed while rebuilding artifacts) → build-failed;
  // "format" (a format/lint failure) and "noconverge" (gates still mutating at
  // the round cap) → needs-human.
  | { ok: false; reason: string; source: "format" | "test" | "noconverge" | "build" };

export interface FormatTestGateDeps {
  runFormatGate?: typeof runFormatGate;
  runTestGate?: typeof runTestGate;
  /**
   * Build-artifact rebuild-and-fold (#387), run after a format-gate auto-fix
   * commit and before the test gate re-runs, so a formatter-created commit's
   * generated artifacts stay fresh too — not just the round's initial commit.
   * Absent (the default) is a no-op: only the fix stage supplies this (gated
   * on a declared `build_command`), so other `runFormatAndTestGates` callers
   * (e.g. the `implementing` stage) are unaffected, per #387's non-goal of
   * scoping build behavior to fix/auto-fix commits.
   */
  foldBuildArtifacts?: (wtPath: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Maximum format↔test iterations before proceeding with whatever passed last. */
export const MAX_FORMAT_TEST_ROUNDS = 3;

/**
 * Run the format/lint gate and the test/build gate to a fixed point (#182).
 *
 * Each iteration runs the format gate FIRST (it may commit auto-format changes)
 * then the test gate (its fix loop may commit fix-harness changes). The loop
 * converges when an iteration produces no new commit — which guarantees the
 * final state has been BOTH formatted and tested. This closes two gaps a fixed
 * test-then-format ordering left open: an auto-format commit can no longer ship
 * untested (the test gate always runs after the last format), and a test-fix
 * commit can no longer ship unformatted (the format gate always runs after the
 * last test-fix mutation, and a resulting format commit re-triggers the test
 * gate). Returns the final TestGateResult, or a blocked reason + blocker kind.
 */
export async function runFormatAndTestGates(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  stage: Stage,
  pipelineRunId: string,
  stateDir: string | undefined,
  deps: FormatTestGateDeps = {},
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
): Promise<FormatTestGateResult> {
  const fmt = deps.runFormatGate ?? runFormatGate;
  const test = deps.runTestGate ?? runTestGate;

  let gate: TestGateResult = { skipped: true };
  let converged = false;
  const scratchExtraGlobs = cfg.test_gate?.non_product_dirty_globs ?? [];
  for (let round = 0; round < MAX_FORMAT_TEST_ROUNDS; round++) {
    const fmtResult = await fmt(wtPath, cfg, issueNumber, {}, scratchExtraGlobs);
    if (fmtResult.status === "blocked") {
      return { ok: false, reason: fmtResult.reason, source: "format" };
    }

    // #387 review-2 finding 1: a format-gate auto-fix commit can modify source
    // after the round's initial build-artifact fold already ran, leaving
    // generated artifacts stale. Fold again here, before the test gate
    // re-runs, so a formatter-created commit's artifacts stay fresh too.
    if (fmtResult.committed && deps.foldBuildArtifacts) {
      const buildFold = await deps.foldBuildArtifacts(wtPath);
      if (!buildFold.ok) {
        return { ok: false, reason: buildFold.reason, source: "build" };
      }
    }

    gate = await test(cfg, issueNumber, wtPath, {}, pipelineRunId, stage, stateDir, runDir, runStoreDeps);
    if (!gate.skipped && !gate.passed) {
      return { ok: false, reason: testGateBlockReason(gate), source: gate.buildFailure ? "build" : "test" };
    }

    // Converged: the format gate committed nothing this round AND the test gate's
    // fix loop made no commit (attempts === 0), so the pushed state is
    // simultaneously formatted and tested. Otherwise loop to re-verify both gates
    // against whatever the last mutation produced.
    if (!fmtResult.committed && (gate.attempts ?? 0) === 0) {
      converged = true;
      break;
    }
  }

  // Did NOT reach a fixed point within the cap: the last round still produced a
  // commit (an auto-format change or a test-gate fix), so the final state may be
  // unformatted or untested. Block rather than advancing a non-converged state.
  if (!converged) {
    return {
      ok: false,
      reason:
        `Format and test gates did not converge after ${MAX_FORMAT_TEST_ROUNDS} rounds — ` +
        `the last round still produced a commit, so the pushed state may be unformatted ` +
        `or untested. Investigate the format_gate / test_gate interaction (e.g. a formatter ` +
        `and the test-fix harness fighting over the same files).`,
      source: "noconverge",
    };
  }
  return { ok: true, gate };
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

async function defaultGitStatusPorcelain(wtPath: string): Promise<string> {
  const r = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return r.stdout;
}

/**
 * `git restore --staged` argv to drop pre-staged scratch from the index so it
 * cannot ride into an auto-format commit (#873 review). Pure — no I/O.
 * Returns null when there is nothing to unstage.
 */
export function unstageScratchArgs(scratchPaths: readonly string[]): string[] | null {
  if (scratchPaths.length === 0) return null;
  return ["restore", "--staged", "--", ...scratchPaths];
}

/**
 * `git commit` argv restricted to product paths only. Pathspec form keeps
 * pre-staged scratch out of the commit even if it re-enters the index between
 * unstage and commit (#873 review). Pure — no I/O.
 */
export function productOnlyCommitArgs(
  message: string,
  productPaths: readonly string[],
): string[] {
  return ["commit", "-m", message, "--", ...productPaths];
}

/**
 * Stage only product-relevant dirty paths and commit (#873). Pre-staged scratch
 * is unstaged first and the commit is pathspec-limited to product paths so
 * tasks/todo.md (and other scratch) never fold into chore: auto-format history.
 */
async function defaultGitCommit(
  wtPath: string,
  message: string,
  scratchExtraGlobs: readonly string[] = [],
  porcelainFn: (p: string) => Promise<string> = defaultGitStatusPorcelain,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const paths = parsePorcelainPaths(await porcelainFn(wtPath));
  const { product, scratch } = classifyWorktreeDirt(paths, scratchExtraGlobs);
  if (product.length === 0) {
    return { ok: false, error: "no product-relevant changes to commit" };
  }
  // Unstage pre-staged scratch so it cannot ride into the auto-format commit.
  // Index-only; working-tree scratch remains dirty for the operator/agent.
  const unstage = unstageScratchArgs(scratch);
  if (unstage) {
    await gitInWorktree(wtPath, unstage, { ignoreFailure: true });
  }
  const addResult = await gitInWorktree(wtPath, ["add", "--", ...product], { ignoreFailure: true });
  if (addResult.code !== 0) {
    const detail = (addResult.stderr.trim() || addResult.stdout.trim());
    return { ok: false, error: `git add failed (exit ${addResult.code}): ${detail}` };
  }
  const commitResult = await gitInWorktree(
    wtPath,
    productOnlyCommitArgs(message, product),
    { ignoreFailure: true },
  );
  if (commitResult.code !== 0) {
    const detail = (commitResult.stderr.trim() || commitResult.stdout.trim());
    return { ok: false, error: `git commit failed (exit ${commitResult.code}): ${detail}` };
  }
  return { ok: true };
}
