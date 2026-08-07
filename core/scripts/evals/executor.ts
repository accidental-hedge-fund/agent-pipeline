// Per-cell isolation and execution (openspec/changes/stage-eval-runner).
//
// Every cell gets a fresh worktree at the fixture's base_commit, a unique
// branch, and a unique session identity — all derived from the cell_id so no
// two cells (including replicates) can collide. This module is fully
// dependency-injected: production defaults call into worktree.ts / harness.ts
// / harness-adapters, but tests never touch git, the filesystem, or a
// subprocess (CLAUDE.md's injectable-dep rule).

import * as fs from "node:fs";
import * as path from "node:path";
import { createWorktreeAt, removeWorktreeAt } from "../worktree.ts";
import { invoke as harnessInvoke } from "../harness.ts";
import { resolveAdapter } from "../harness-adapters/index.ts";
import { preflightExecutor, invokeExternalExecutor, type ExecutorAssignment } from "../executors.ts";
import type { HarnessResult } from "../harness.ts";
import type { ModelEndpointOverride, ModelInvokingStage, PipelineConfig } from "../types.ts";
import type { GhRefusalRecord } from "./gh-eval-surface.ts";
import { EVAL_AGENT_CONTRACT_PATHS, EVAL_AGENT_CONTRACT_TEXT } from "./agent-contract.ts";
import {
  evalIsolationEnv,
  installBoundaryShim as installBoundaryShimReal,
  isolatedGhEnv,
  readBoundaryDenials as readBoundaryDenialsReal,
  removeBoundaryShim as removeBoundaryShimReal,
} from "./boundary-shim.ts";
import { materializeStagePrompt, stagesForMode } from "./stage-adapters.ts";
import { runPairedCellLoop } from "./paired-loop.ts";
import { isJsonVerdictShaped, parseProseReview, parseStrictVerdict, parseStructuredVerdict } from "../stages/review-parsing.ts";
import type { BuildTreatmentTrajectoryInput, RawStageEntry } from "./trajectory/collect.ts";
import {
  isMultiChangeFixture,
  isPairedEvalMode,
  type BoundaryDenial,
  type BoundaryEvidence,
  type Cell,
  type CellExecutionClass,
  type CellOutcome,
  type EnvironmentDependency,
  type EvalStageName,
  type ExperimentManifest,
  type Fixture,
  type ReviewVerdictParseProvenance,
  type SandboxMode,
  type Treatment,
} from "./types.ts";
import {
  buildStructuralTelemetry,
  computeGrowthFromPaths,
  contentAddressedRepoFingerprint,
  hashPrompt,
  inheritedVerifiers,
  materializeMultiChangeCheckpointPrompt,
  resolveCheckpointCoordinates,
  resolveMultiChangeProfile,
  type MultiChangeCheckpointEvidence,
} from "./multi-change.ts";
import { runMultiChangeCheckpointTreatment } from "./multi-change-treatment.ts";
import { createHash, randomUUID } from "node:crypto";

function sanitizeForPath(cellId: string): string {
  return cellId.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Harnesses whose CLI accepts a `provider/model`-formatted model value
 *  (opencode.ts's `-m` flag, design.md decision 4 of #431's cli-harness-adapters
 *  change) — i.e. the only harnesses for which a `provider` treatment axis can
 *  actually change the invocation rather than being silently ignored. */
const PROVIDER_QUALIFIED_HARNESSES = new Set(["opencode"]);

/** Fold a cell's `provider` treatment into the model string handed to the
 *  harness, or report why it cannot. A `provider` value only has an effect for
 *  a harness whose CLI accepts a `provider/model` value; every other harness
 *  is provider-locked (the CLI itself talks to one provider), so a `provider`
 *  treatment there would silently confound cells that differ only by
 *  `provider` (review 1 finding 2b468247) — this is therefore reported as an
 *  incompatible cell rather than executed as a no-op. */
function resolveTreatmentModel(
  harness: string,
  treatment: { provider?: string; model?: string },
): { ok: true; model: string | undefined } | { ok: false; error: string } {
  if (!treatment.provider) {
    return { ok: true, model: treatment.model };
  }
  if (!PROVIDER_QUALIFIED_HARNESSES.has(harness)) {
    return {
      ok: false,
      error: `harness "${harness}" has no separate provider axis — it cannot honor treatment provider "${treatment.provider}"`,
    };
  }
  if (!treatment.model) {
    return {
      ok: false,
      error: `harness "${harness}" requires a "provider/model" formatted model, but the treatment specifies provider "${treatment.provider}" with no model`,
    };
  }
  return { ok: true, model: `${treatment.provider}/${treatment.model}` };
}

/** Injectable I/O for reading/writing/removing the eval agent contract's
 *  root-instruction files (#607) — no real fs call from a unit test. */
export interface ContractIO {
  readFile: (filePath: string) => string | null;
  writeFile: (filePath: string, content: string) => void;
  removeFile: (filePath: string) => void;
}

export const defaultContractIO: ContractIO = {
  readFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err) {
      // Only a genuinely-absent file is "no prior content" (`null`). Any other
      // read failure (EACCES, EISDIR, …) must propagate, never be silently
      // mistaken for absence — otherwise restore would DELETE a file whose
      // original content merely could not be read (review 2, finding e3e72127).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
  removeFile: (filePath) => {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      // Already absent — restoring "no prior file" is a no-op. Any other unlink
      // failure (EACCES, EISDIR, …) must propagate so it surfaces as a
      // restore_failure, never be silently swallowed as success (finding e3e72127).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  },
};

/** Install the eval agent contract at every root-instruction path (#607),
 *  capturing each path's prior content (or `null` if it didn't exist) so it
 *  can be restored exactly. Never throws — a read/write failure is reported as
 *  `{ ok: false }` so the caller can classify the cell as an infra error
 *  without invoking the harness. The captured `prior` is returned on **both**
 *  paths: a partial install (an earlier path written, a later one failing) must
 *  still restore the already-modified paths, so the caller retains this prior
 *  and restores it rather than leaving the contract behind (review 2, finding
 *  e3e72127). `prior` is populated entry-by-entry as each path is captured, so
 *  on failure it holds exactly the paths that may have been modified. */
export function installEvalContract(
  worktreeDir: string,
  io: ContractIO,
):
  | { ok: true; prior: Record<string, string | null> }
  | { ok: false; error: string; prior: Record<string, string | null> } {
  const prior: Record<string, string | null> = {};
  try {
    for (const rel of EVAL_AGENT_CONTRACT_PATHS) {
      const full = path.join(worktreeDir, rel);
      prior[rel] = io.readFile(full);
      io.writeFile(full, EVAL_AGENT_CONTRACT_TEXT);
    }
    return { ok: true, prior };
  } catch (err) {
    return { ok: false, error: (err as Error).message, prior };
  }
}

/** Restore every root-instruction path to its captured prior content —
 *  removing the file when no prior content existed. Never throws; a failure
 *  is reported as `{ ok: false }` boundary evidence, never fatal to the
 *  cell's primary outcome. */
export function restoreEvalContract(
  worktreeDir: string,
  prior: Record<string, string | null>,
  io: ContractIO,
): { ok: true } | { ok: false; error: string } {
  try {
    for (const [rel, content] of Object.entries(prior)) {
      const full = path.join(worktreeDir, rel);
      if (content === null) io.removeFile(full);
      else io.writeFile(full, content);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface CellIdentity {
  worktreePath: string;
  branch: string;
  sessionId: string;
}

/** Allocate the worktree path, branch name, and session identity for a cell.
 *  A pure function of cell_id: two calls with the same cell_id always agree,
 *  and two different cell_ids (including two replicates of the same
 *  treatment) never collide. */
export function allocateCellIdentity(cfg: PipelineConfig, cell: Cell): CellIdentity {
  const slug = sanitizeForPath(cell.cell_id);
  return {
    worktreePath: path.join(cfg.repo_dir, ".worktrees", "evals", slug),
    branch: `pipeline-eval/${slug}`,
    sessionId: slug,
  };
}

export interface HarnessInvokeArgs {
  harness: string;
  worktreeDir: string;
  prompt: string;
  timeoutSec: number;
  model?: string;
  effort?: string;
  /** Env overrides merged on top of the child process's environment —
   *  PATH deny shim + GitHub/git credential strip (see `evalIsolationEnv`).
   *  Local-CLI write denial does not use an injected EvalGhSurface (#637). */
  env?: NodeJS.ProcessEnv;
  /** Explicit execution sandbox mode for this invocation (#607) — the eval
   *  path always supplies this from the resolved manifest field; it never
   *  reads `PIPELINE_CODEX_NO_SANDBOX`. */
  sandboxMode?: SandboxMode;
}

export interface HarnessInvokeResultLike {
  success: boolean;
  timed_out: boolean;
  spawn_error?: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration: number;
  /** Rate-limit/throttle signal recovered from the adapter's own telemetry
   *  parsing (harness.ts). `null`/absent when the CLI reports no such signal
   *  at all — not the same as "not throttled". */
  throttled?: boolean | null;
}

export interface PreflightResultLike {
  ok: boolean;
  failure?: "missing-cli" | "unauthenticated" | "headless-unavailable" | "unsupported-setting";
  message?: string;
}

export interface CellExecutionDeps {
  createWorktree?: (
    cfg: PipelineConfig,
    opts: { path: string; branch: string; baseCommit: string },
  ) => Promise<{ path: string; branch: string }>;
  removeWorktree?: (cfg: PipelineConfig, opts: { path: string; branch: string }) => Promise<void>;
  invokeHarness?: (args: HarnessInvokeArgs) => Promise<HarnessInvokeResultLike>;
  preflight?: (harness: string, req: { model?: string; effort?: string }) => Promise<PreflightResultLike>;
  /** Run each named check as a shell command in the given worktree and report
   *  pass (exit 0) / fail per check name. Only invoked when the fixture
   *  declares at least one public or hidden check (grading needs the result;
   *  a fixture declaring none never triggers this, so existing callers that
   *  inject no fake are unaffected). `deadlineMs` is the cell's remaining
   *  budget at the time checks start — implementations must cap execution to
   *  it rather than each check's own fixed ceiling. */
  runChecks?: (args: { worktreeDir: string; checks: string[]; deadlineMs: number }) => Promise<Record<string, boolean>>;
  /** Report the repository-relative paths that differ from `baseSha` in the
   *  given worktree. Only invoked when the fixture declares
   *  `allowed_change_paths` (out-of-scope-change grading needs it). */
  getChangedPaths?: (args: { worktreeDir: string; baseSha: string }) => Promise<string[]>;
  /** Fingerprint the worktree tree state for multi-change evidence trails
   *  (#577). Defaults to a content-addressed digest (HEAD + tracked diff +
   *  untracked content hashes). */
  getRepoFingerprint?: (args: { worktreeDir: string }) => Promise<string>;
  /** Full unified diff text for the worktree vs baseSha — used by paired modes
   *  so the reviewer sees the actual primary implementation (#601). */
  getDiff?: (args: { worktreeDir: string; baseSha: string }) => Promise<string>;
  /**
   * Disposable isolated (non-Git, symlink-safe) copy of the post-treatment
   * worktree for multi-change held-out verifier execution (#577). Verifier
   * side effects must not persist into the treatment lineage; defaults to
   * {@link copyIsolatedVerifierTree} under os.tmpdir. Called once per
   * held-out verifier so side effects cannot cascade across checks.
   */
  createVerifierSnapshot?: (worktreeDir: string) => Promise<string>;
  /** Remove a verifier snapshot directory from {@link createVerifierSnapshot}. */
  removeVerifierSnapshot?: (snapshotDir: string) => Promise<void>;
  /** Read source files from the post-step worktree for maintainability telemetry (#577). */
  collectWorktreeSourceFiles?: (args: {
    worktreeDir: string;
    changedPaths: string[];
  }) => Promise<Array<{ path: string; content: string }>>;
  /** Dispatch an API treatment through a named `model-endpoint` executor
   *  (#434 task 6). Only invoked when the cell's treatment declares
   *  `executor`. */
  invokeExecutor?: (args: ExecutorInvokeArgs) => Promise<{ ok: true; result: HarnessResult } | { ok: false; error: string }>;
  /** Run a declared `simulated` environment dependency's deterministic
   *  `setup`/`teardown` shell command in the cell's worktree (review 1
   *  finding ed37a4fd) — only invoked when the fixture declares at least one
   *  `simulated` dependency. `phase` distinguishes setup (run before the
   *  treatment) from teardown (run after, best-effort). */
  runEnvironmentCommand?: (args: { worktreeDir: string; command: string; phase: "setup" | "teardown"; deadlineMs: number }) => Promise<{ ok: boolean; error?: string }>;
  /** Injectable read/write/remove seam for the eval agent contract's
   *  root-instruction files (#607). Defaults to real fs I/O. */
  contractIO?: ContractIO;
  /** Materialize the cell-scoped command-boundary deny-shim directory and
   *  return its path (#607). Defaults to the real shim writer
   *  (boundary-shim.ts); thrown errors are classified as an infra error
   *  before the harness is ever invoked, same as a contract install
   *  failure. */
  installBoundaryShim?: (worktreeDir: string) => string;
  /** Read and parse the cell's process-boundary denial log (#607). Defaults
   *  to the real reader; an absent log means no denial occurred. A genuine
   *  collection failure throws rather than returning `[]`. */
  readBoundaryDenials?: (worktreeDir: string) => BoundaryDenial[];
  /** Remove the cell's boundary control directory (#607) — it lives outside
   *  the cell worktree (a sibling, not a subdirectory), so worktree removal
   *  does not clean it up; this must be called separately during teardown.
   *  Defaults to the real remover. Best-effort: failures are logged, not
   *  thrown, matching the worktree-removal convention below. */
  removeBoundaryShim?: (worktreeDir: string) => void;
}

async function defaultRunChecks(
  args: { worktreeDir: string; checks: string[]; deadlineMs: number },
): Promise<Record<string, boolean>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  // Same isolation fence as harness children / deep preflight (#637): PATH
  // deny shim + credential strip. Boundary shim must already be installed on
  // the worktree (runCell installs it before checks).
  const env = { ...process.env, ...evalIsolationEnv(args.worktreeDir) };
  const results: Record<string, boolean> = {};
  const deadline = Date.now() + args.deadlineMs;
  for (const check of args.checks) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      results[check] = false;
      continue;
    }
    try {
      await execFileAsync("sh", ["-c", check], {
        cwd: args.worktreeDir,
        timeout: Math.min(300_000, remainingMs),
        env,
      });
      results[check] = true;
    } catch {
      results[check] = false;
    }
  }
  return results;
}

async function defaultGetChangedPaths(args: { worktreeDir: string; baseSha: string }): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", args.baseSha], {
      cwd: args.worktreeDir,
      timeout: 30_000,
    });
    return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Content-addressed worktree fingerprint: HEAD + full tracked diff vs HEAD +
 * per-path content hashes of untracked files. Path-only porcelain status is
 * insufficient — two distinct edits to the same path must not alias.
 */
async function defaultGetRepoFingerprint(args: { worktreeDir: string }): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const head = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: args.worktreeDir,
      timeout: 15_000,
    });
    // Full patch covers staged + unstaged tracked content relative to HEAD.
    let trackedDiff = "";
    try {
      const diff = await execFileAsync("git", ["diff", "HEAD"], {
        cwd: args.worktreeDir,
        timeout: 60_000,
        maxBuffer: 40 * 1024 * 1024,
      });
      trackedDiff = diff.stdout;
    } catch (err) {
      const e = err as { stdout?: string; code?: number };
      // git diff exits 0 even with differences; nonzero is a real failure unless stdout present.
      if (typeof e.stdout === "string") trackedDiff = e.stdout;
      else throw err;
    }
    const untrackedList = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: args.worktreeDir, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const untrackedPaths = untrackedList.stdout
      .split("\0")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .sort();
    const untrackedFiles: Array<{ path: string; contentSha256: string }> = [];
    for (const rel of untrackedPaths) {
      const abs = path.join(args.worktreeDir, rel);
      let contentSha256: string;
      try {
        const st = await fs.promises.lstat(abs);
        if (st.isSymbolicLink()) {
          const target = await fs.promises.readlink(abs);
          contentSha256 = createHash("sha256").update(`symlink:${target}`).digest("hex");
        } else if (st.isFile()) {
          const buf = await fs.promises.readFile(abs);
          contentSha256 = createHash("sha256").update(buf).digest("hex");
        } else {
          contentSha256 = createHash("sha256").update(`special:${st.mode}`).digest("hex");
        }
      } catch (err) {
        contentSha256 = createHash("sha256")
          .update(`missing:${(err as Error).message}`)
          .digest("hex");
      }
      untrackedFiles.push({ path: rel, contentSha256 });
    }
    return contentAddressedRepoFingerprint({
      headSha: head.stdout.trim(),
      trackedDiff,
      untrackedFiles,
    });
  } catch (err) {
    return createHash("sha256").update(`fingerprint-error:${(err as Error).message}`).digest("hex");
  }
}

/**
 * Copy a treatment worktree into an independent, non-Git filesystem tree for
 * held-out verifier execution. Skips `.git` metadata (gitfile or directory)
 * so verifier git commands cannot mutate lineage refs, and materializes
 * symlinks as regular file/directory copies of their targets when the target
 * resolves inside the source tree (external or broken links are omitted).
 */
export async function copyIsolatedVerifierTree(srcDir: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const root = path.resolve(srcDir);

  function isInsideRoot(resolved: string): boolean {
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  async function materialize(srcPath: string, destPath: string): Promise<void> {
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(srcPath);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = await fs.promises.readlink(srcPath);
      } catch {
        return;
      }
      const resolved = path.resolve(path.dirname(srcPath), target);
      if (!isInsideRoot(resolved)) {
        // External symlink — omit rather than escape the snapshot boundary.
        return;
      }
      try {
        const targetSt = await fs.promises.stat(resolved);
        if (targetSt.isDirectory()) {
          await fs.promises.mkdir(destPath, { recursive: true });
          const entries = await fs.promises.readdir(resolved);
          for (const name of entries) {
            if (name === ".git") continue;
            await materialize(path.join(resolved, name), path.join(destPath, name));
          }
        } else if (targetSt.isFile()) {
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          await fs.promises.copyFile(resolved, destPath);
        }
      } catch {
        // Broken link — omit.
      }
      return;
    }
    if (st.isDirectory()) {
      await fs.promises.mkdir(destPath, { recursive: true });
      const entries = await fs.promises.readdir(srcPath);
      for (const name of entries) {
        if (name === ".git") continue;
        await materialize(path.join(srcPath, name), path.join(destPath, name));
      }
      return;
    }
    if (st.isFile()) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(srcPath, destPath);
    }
  }

  await materialize(root, destDir);
}

/** Disposable isolated filesystem copy of the treatment worktree for held-out verifiers. */
async function defaultCreateVerifierSnapshot(worktreeDir: string): Promise<string> {
  const os = await import("node:os");
  const snapshotDir = path.join(os.tmpdir(), `pipeline-eval-mc-verifier-${randomUUID()}`);
  await copyIsolatedVerifierTree(worktreeDir, snapshotDir);
  return snapshotDir;
}

async function defaultRemoveVerifierSnapshot(snapshotDir: string): Promise<void> {
  await fs.promises.rm(snapshotDir, { recursive: true, force: true });
}

/**
 * Read source-like files under the worktree for maintainability telemetry.
 * Unions changed paths with multi-change sandbox modules so cumulative LOC
 * reflects the post-step tree before teardown.
 */
async function defaultCollectWorktreeSourceFiles(args: {
  worktreeDir: string;
  changedPaths: string[];
}): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  const tryRead = async (rel: string) => {
    const norm = rel.replace(/\\/g, "/");
    if (seen.has(norm)) return;
    seen.add(norm);
    if (norm.includes("..") || path.isAbsolute(norm)) return;
    const abs = path.join(args.worktreeDir, norm);
    try {
      const st = await fs.promises.lstat(abs);
      if (!st.isFile() || st.isSymbolicLink()) return;
      const content = await fs.promises.readFile(abs, "utf8");
      out.push({ path: norm, content });
    } catch {
      // missing / unreadable
    }
  };
  for (const p of args.changedPaths) await tryRead(p);

  const sandboxRoot = path.join(args.worktreeDir, "core/evals/sandboxes");
  try {
    const walkSandbox = async (dir: string, relFromSandbox: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const rel = relFromSandbox ? `${relFromSandbox}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (ent.name === ".git" || ent.name === "node_modules") continue;
          await walkSandbox(path.join(dir, ent.name), rel);
        } else if (ent.isFile()) {
          await tryRead(`core/evals/sandboxes/${rel}`);
        }
      }
    };
    await walkSandbox(sandboxRoot, "");
  } catch {
    // no sandbox tree in this worktree
  }
  return out;
}

/** Hard cap on total reviewable paired-mode diff size (tracked + untracked).
 *  Exceeding this fails closed as infra_error rather than silently truncating
 *  reviewer input (#601 review 2 8c015b1f). */
export const PAIRED_DIFF_MAX_BYTES = 20 * 1024 * 1024;

/** Injectable execFile seam for {@link collectPairedWorktreeDiff} tests. */
export type CollectPairedDiffExec = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Collect the full unified diff of the worktree vs baseSha for paired-mode review.
 * Includes every untracked (non-ignored) path — never silently truncates the
 * untracked list. Throws when a complete reviewable diff cannot be collected
 * (tracked failure, untracked listing failure, per-file failure without
 * stdout, or total size over {@link PAIRED_DIFF_MAX_BYTES}) so the pair loop
 * records infra_error rather than grading a partial review body
 * (#601 review 1/2 8c015b1f). A legitimate empty worktree returns "".
 *
 * Tracked `git diff <baseSha>` (no `--exit-code`) MUST exit 0 for a complete
 * result. Nonzero exit is a collection failure even when stdout is nonempty —
 * partial stdout after a mid-stream error must not be graded as the full diff.
 * Untracked paths still use `git diff --no-index`, which exits 1 when files
 * differ and is the only documented complete-output nonzero case here.
 */
export async function collectPairedWorktreeDiff(args: {
  worktreeDir: string;
  baseSha: string;
  /** Test seam — defaults to promisified child_process.execFile. */
  execFile?: CollectPairedDiffExec;
}): Promise<string> {
  let execFileAsync = args.execFile;
  if (!execFileAsync) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    execFileAsync = promisify(execFile) as CollectPairedDiffExec;
  }
  let tracked: string;
  try {
    // Include unstaged/untracked worktree edits the primary made without committing
    // (paired implement/fix prompts forbid commits).
    const result = await execFileAsync("git", ["diff", args.baseSha], {
      cwd: args.worktreeDir,
      timeout: 30_000,
      maxBuffer: PAIRED_DIFF_MAX_BYTES,
    });
    tracked = result.stdout;
  } catch (err) {
    const e = err as {
      message?: string;
      code?: string | number;
      killed?: boolean;
      signal?: string;
      stdout?: string;
    };
    // Plain `git diff <base>` without --exit-code exits 0 on success (even when
    // files differ). Any rejected invocation is incomplete review input —
    // never accept partial stdout (#601 review 8c015b1f).
    throw new Error(
      `failed to collect tracked worktree diff vs ${args.baseSha}` +
        (e.code !== undefined ? ` (code=${e.code})` : "") +
        (e.killed ? " (killed)" : "") +
        (e.signal ? ` (signal=${e.signal})` : "") +
        (typeof e.stdout === "string" && e.stdout.length > 0
          ? " (partial stdout discarded)"
          : "") +
        `: ${e.message ?? String(err)}`,
    );
  }

  let namesOut: string;
  try {
    const { stdout: names } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: args.worktreeDir, timeout: 30_000 },
    );
    namesOut = names;
  } catch (err) {
    const e = err as { message?: string };
    throw new Error(
      `failed to list untracked worktree paths for paired review diff: ${e.message ?? String(err)}`,
    );
  }

  const files = namesOut.split("\n").map((l) => l.trim()).filter(Boolean);
  let totalBytes = Buffer.byteLength(tracked, "utf8");
  if (totalBytes > PAIRED_DIFF_MAX_BYTES) {
    throw new Error(
      `worktree diff exceeds ${PAIRED_DIFF_MAX_BYTES} byte limit ` +
        `(tracked alone is ${totalBytes} bytes) — cannot collect a complete reviewable diff`,
    );
  }

  let untracked = "";
  for (const file of files) {
    let content: string;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-index", "--", "/dev/null", file],
        {
          cwd: args.worktreeDir,
          timeout: 10_000,
          maxBuffer: Math.min(2 * 1024 * 1024, PAIRED_DIFF_MAX_BYTES),
        },
      );
      content = stdout;
    } catch (err) {
      // git diff --no-index exits 1 when files differ — stdout still holds the diff.
      // maxBuffer / kill / signal means the diff is incomplete — fail closed.
      const e = err as {
        stdout?: string;
        message?: string;
        code?: string | number;
        killed?: boolean;
        signal?: string;
      };
      const incomplete =
        e.killed ||
        e.signal ||
        e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        (typeof e.message === "string" && /maxBuffer|ENOBUFS/i.test(e.message));
      if (
        !incomplete &&
        typeof e.stdout === "string" &&
        e.stdout.length > 0
      ) {
        content = e.stdout;
      } else {
        throw new Error(
          `failed to collect untracked diff for ${JSON.stringify(file)}` +
            (e.code !== undefined ? ` (code=${e.code})` : "") +
            (e.killed ? " (killed)" : "") +
            (e.signal ? ` (signal=${e.signal})` : "") +
            `: ${e.message ?? String(err)} — cannot collect a complete reviewable diff`,
        );
      }
    }
    const nextBytes = totalBytes + Buffer.byteLength(content, "utf8");
    if (nextBytes > PAIRED_DIFF_MAX_BYTES) {
      throw new Error(
        `worktree diff exceeds ${PAIRED_DIFF_MAX_BYTES} byte limit after including ` +
          `untracked path ${JSON.stringify(file)} (${files.length} untracked paths total) — ` +
          `cannot collect a complete reviewable diff`,
      );
    }
    untracked += content;
    totalBytes = nextBytes;
  }
  return `${tracked}${untracked}`;
}

const defaultGetDiff = collectPairedWorktreeDiff;

/** Command-line tokens that reach outside the cell's isolated worktree — the
 *  GitHub CLI (a production GitHub write), raw network clients, and `git
 *  push`/`git remote` (a repository write to a real remote). A declared
 *  `simulated`/`forbidden` dependency's `setup`/`teardown` is supposed to be a
 *  deterministic, in-worktree stand-in (a local stub, a fixture file, an
 *  in-memory server) — not a live call to the very surface the eval is
 *  isolating against (review 2 finding dc817cec). Matched as whole words so a
 *  path component or unrelated flag containing these substrings is not
 *  falsely flagged. */
const FORBIDDEN_SIMULATION_TOOLING = [
  /(^|[\s;&|])gh(\s|$)/,
  /(^|[\s;&|])curl(\s|$)/,
  /(^|[\s;&|])wget(\s|$)/,
  /(^|[\s;&|])ssh(\s|$)/,
  /(^|[\s;&|])scp(\s|$)/,
  /(^|[\s;&|])sftp(\s|$)/,
  /(^|[\s;&|])(nc|netcat)(\s|$)/,
  /(^|[\s;&|])telnet(\s|$)/,
  /(^|[\s;&|])git\s+push(\s|$)/,
  /(^|[\s;&|])git\s+remote(\s|$)/,
];

function findForbiddenSimulationTooling(command: string): RegExpMatchArray | null {
  for (const pattern of FORBIDDEN_SIMULATION_TOOLING) {
    const match = command.match(pattern);
    if (match) return match;
  }
  return null;
}

async function defaultRunEnvironmentCommand(
  args: { worktreeDir: string; command: string; phase: "setup" | "teardown"; deadlineMs: number },
): Promise<{ ok: boolean; error?: string }> {
  const forbidden = findForbiddenSimulationTooling(args.command);
  if (forbidden) {
    return {
      ok: false,
      error: `environment ${args.phase} command references ${JSON.stringify(forbidden[0].trim())} — GitHub-write and external/network tooling is not permitted in a simulated/forbidden dependency stand-in`,
    };
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync("sh", ["-c", args.command], {
      cwd: args.worktreeDir,
      timeout: Math.max(1, args.deadlineMs),
      env: { ...process.env, ...isolatedGhEnv(args.worktreeDir) },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `environment ${args.phase} command failed: ${(err as Error).message}` };
  }
}

async function realPreflight(
  harness: string,
  req: { model?: string; effort?: string },
): Promise<PreflightResultLike> {
  const adapter = resolveAdapter(harness);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const exec = async (file: string, args: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, { timeout: 10_000 });
      return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, stdout: (e.stdout ?? "").toString(), stderr: (e.stderr ?? "").toString() };
    }
  };
  const execCheck = async (file: string, args: string[]) => (await exec(file, args)).ok;
  const result = await adapter.preflight({ exec, execCheck }, req);
  return { ok: result.ok, failure: result.failure, message: result.message };
}

/** The real `invokeHarness` dep (#621) — maps the eval domain's `effort` axis
 *  onto `InvokeOptions.reasoningEffort`, the only field `invoke()` reads.
 *  `HarnessInvokeArgs.effort` and `InvokeOptions.reasoningEffort` are two
 *  names for the same coordinate; passing `effort` straight through (as a key
 *  named `effort`) is silently discarded since there is no `tsc` step to
 *  catch the mismatch — see `harness.test.ts`'s eval-path argv tests (#621). */
export async function realInvokeHarness(args: HarnessInvokeArgs): Promise<HarnessInvokeResultLike> {
  const result = await harnessInvoke(args.harness, args.worktreeDir, args.prompt, {
    timeoutSec: args.timeoutSec,
    model: args.model,
    reasoningEffort: args.effort,
    stream: false,
    env: args.env,
    sandboxMode: args.sandboxMode,
  });
  return result;
}

// ---------------------------------------------------------------------------
// #434 stage-eval-runner integration — binding an API treatment to a named
// model-endpoint executor with deterministic per-cell overrides.
// ---------------------------------------------------------------------------

/** The eval mode/stage pairs a `model-endpoint` executor can be bound to — the
 *  same prompt-contained restriction `config.ts` enforces for a committed
 *  `stage_executors:` assignment (executors.ts, external-stage-executors). */
const API_TREATMENT_STAGE_MAP: Partial<Record<EvalStageName, ModelInvokingStage>> = {
  "plan-review": "plan-review",
  review: "review-1",
};

/** Derive the per-cell override deterministically from the treatment's own
 *  coordinates (#434 task 6.1) — a pure function of `treatment`, so replaying
 *  the same plan from the same manifest/seed always resolves the same
 *  override (manifest.ts's cell_id is already a pure function of the same
 *  coordinates, which is what gives this determinism for free). */
export function deriveModelEndpointOverride(treatment: Treatment): ModelEndpointOverride {
  return {
    ...(treatment.model !== undefined ? { model: treatment.model } : {}),
    ...(treatment.params !== undefined ? { params: treatment.params } : {}),
    ...(treatment.effort !== undefined ? { effort: treatment.effort } : {}),
  };
}

export interface ExecutorInvokeArgs {
  cfg: PipelineConfig;
  stage: ModelInvokingStage;
  executorName: string;
  prompt: string;
  timeoutSec: number;
  override: ModelEndpointOverride;
}

/** `{ok:false}` for every failure that must be classified `infra_error` (never
 *  a completed treatment outcome, #434 task 6.2): an unknown executor name, an
 *  executor that isn't a `model-endpoint`, or any preflight failure (missing
 *  credential/header env var, invalid override, unreachable endpoint,
 *  unsupported effort). `{ok:true}` carries the executor's `HarnessResult` —
 *  itself may still be `success:false` (e.g. a non-2xx response), which IS a
 *  genuine treatment outcome, mirroring how a local-CLI harness failure is
 *  handled below. */
async function realInvokeExecutor(
  args: ExecutorInvokeArgs,
): Promise<{ ok: true; result: HarnessResult } | { ok: false; error: string }> {
  const definition = args.cfg.executors?.[args.executorName];
  if (!definition) {
    return { ok: false, error: `executor "${args.executorName}" is not defined under executors: in pipeline config` };
  }
  if (definition.type !== "model-endpoint") {
    return { ok: false, error: `executor "${args.executorName}" is a "${definition.type}" executor — API treatments require a model-endpoint executor` };
  }
  const assignment: ExecutorAssignment = { name: args.executorName, definition };
  const preflight = await preflightExecutor(args.stage, assignment, {}, args.override);
  if (!preflight.ok) {
    return { ok: false, error: preflight.message };
  }
  const result = await invokeExternalExecutor(args.stage, assignment, args.prompt, { timeoutSec: args.timeoutSec }, {}, args.override);
  return { ok: true, result };
}

export interface CellExecutionResult {
  outcome: CellOutcome;
  materializedPrompt: string;
  effectiveConfig: Record<string, unknown>;
  ghRefusals: GhRefusalRecord[];
  /** Isolation-boundary evidence for this cell (#607) — present only when at
   *  least one process-level denial, `gh`-surface refusal, or contract
   *  restore failure occurred. Absent means no denial occurred. */
  boundaryEvidence?: BoundaryEvidence;
  /** Present only when collecting boundary evidence itself failed —
   *  distinguishable from "no denials occurred". */
  boundaryEvidenceError?: string;
  /** Raw (pre-sanitize, pre-bound) treatment trajectory input (#536) — the
   *  caller (run.ts) builds and persists the artifact from this via
   *  trajectory/collect.ts + trajectory/store.ts. Collected best-effort for
   *  every result_class, including infra_error/auth_error/timeout, since
   *  diagnosing *why* a cell didn't complete is exactly the trajectory's job. */
  trajectory: BuildTreatmentTrajectoryInput;
}

/**
 * Multi-change lineage (#577): ordered checkpoints on one worktree with fresh
 * session context each step. Quality non-strict failures continue the lineage;
 * infra/auth/timeout abort with the existing non-quality result classes.
 */
async function runMultiChangeLineage(args: {
  cfg: PipelineConfig;
  cell: Cell;
  fixture: Fixture;
  manifest: ExperimentManifest;
  identity: CellIdentity;
  cellDeadlineMs: number;
  trajectoryActions: string[];
  trajectoryStages: RawStageEntry[];
  environmentDetail: unknown;
  invokeHarnessFn: NonNullable<CellExecutionDeps["invokeHarness"]>;
  preflightFn: NonNullable<CellExecutionDeps["preflight"]>;
  deps: CellExecutionDeps;
  finish: (outcome: CellOutcome) => CellExecutionResult;
  setMaterializedPrompt: (prompt: string) => void;
}): Promise<CellExecutionResult> {
  const {
    cfg,
    cell,
    fixture,
    manifest,
    identity,
    cellDeadlineMs,
    trajectoryActions,
    trajectoryStages,
    environmentDetail,
    invokeHarnessFn,
    preflightFn,
    deps,
    finish,
    setMaterializedPrompt,
  } = args;

  const checkpoints = fixture.checkpoints ?? [];
  if (checkpoints.length === 0) {
    return finish({
      result_class: "infra_error",
      error: `multi-change fixture "${fixture.fixture_id}" has no checkpoints`,
    });
  }

  const profile = resolveMultiChangeProfile(cell.treatment, cell.mode);
  const evidence: MultiChangeCheckpointEvidence[] = [];
  const promptParts: string[] = [];
  let previousChangedPaths: string[] = [];
  let previousProductionLoc = 0;
  let previousTestLoc = 0;
  const getChangedPathsFn = deps.getChangedPaths ?? defaultGetChangedPaths;
  const getRepoFingerprintFn = deps.getRepoFingerprint ?? defaultGetRepoFingerprint;
  const runChecksFn = deps.runChecks ?? defaultRunChecks;
  const getDiffFn = deps.getDiff ?? defaultGetDiff;
  const createVerifierSnapshotFn = deps.createVerifierSnapshot ?? defaultCreateVerifierSnapshot;
  const removeVerifierSnapshotFn = deps.removeVerifierSnapshot ?? defaultRemoveVerifierSnapshot;
  const collectSourceFilesFn = deps.collectWorktreeSourceFiles ?? defaultCollectWorktreeSourceFiles;

  for (let k = 0; k < checkpoints.length; k++) {
    const checkpoint = checkpoints[k];
    const remainingMs = cellDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      const error = `multi-change cell exceeded its ${manifest.timeout}s timeout before checkpoint "${checkpoint.checkpoint_id}"`;
      trajectoryActions.push(error);
      return finish({
        result_class: "timeout",
        error,
        detail: {
          multi_change: {
            profile,
            checkpoints: evidence,
            aborted: { checkpoint_id: checkpoint.checkpoint_id, result_class: "timeout" },
          },
          ...(environmentDetail !== undefined ? { environment: environmentDetail } : {}),
        },
      });
    }

    // Fresh session identity per checkpoint — no chat carry-over.
    const sessionId = `${identity.sessionId}-cp-${checkpoint.checkpoint_id}`;
    const coords = resolveCheckpointCoordinates(cell.treatment, checkpoint);
    const effectiveHarness = coords.harness ?? cell.treatment.harness ?? "claude";
    const resolvedModel = resolveTreatmentModel(effectiveHarness, {
      provider: cell.treatment.provider,
      model: coords.model,
    });
    if (!resolvedModel.ok) {
      trajectoryActions.push(resolvedModel.error);
      return finish({
        result_class: "infra_error",
        error: resolvedModel.error,
        detail: {
          multi_change: {
            profile,
            checkpoints: evidence,
            aborted: { checkpoint_id: checkpoint.checkpoint_id, result_class: "infra_error" },
          },
        },
      });
    }

    const prompt = materializeMultiChangeCheckpointPrompt(fixture, checkpoint, profile);
    promptParts.push(prompt);
    setMaterializedPrompt(promptParts.join("\n\n---\n\n"));

    // Optional preflight for harness credentials (auth classification).
    if (coords.harness ?? cell.treatment.harness) {
      try {
        const preflightResult = await preflightFn(effectiveHarness, {
          model: resolvedModel.model,
          effort: coords.effort,
        });
        if (!preflightResult.ok) {
          const resultClass = preflightResult.failure === "unauthenticated" ? "auth_error" : "infra_error";
          const error = preflightResult.message ?? preflightResult.failure ?? "preflight failed";
          trajectoryActions.push(`checkpoint "${checkpoint.checkpoint_id}" preflight failed: ${error}`);
          return finish({
            result_class: resultClass,
            error,
            detail: {
              multi_change: {
                profile,
                checkpoints: evidence,
                aborted: { checkpoint_id: checkpoint.checkpoint_id, result_class: resultClass },
              },
            },
          });
        }
      } catch (err) {
        const error = `preflight failed: ${(err as Error).message}`;
        trajectoryActions.push(`checkpoint "${checkpoint.checkpoint_id}": ${error}`);
        return finish({
          result_class: "infra_error",
          error,
          detail: {
            multi_change: {
              profile,
              checkpoints: evidence,
              aborted: { checkpoint_id: checkpoint.checkpoint_id, result_class: "infra_error" },
            },
          },
        });
      }
    }

    // Treatment graph: bare = implement only; pipeline-current / adversarial
    // = implement + production review_policy + finding-resolution fix rounds
    // (shared disclosed implement prompt; review/fix graph differs).
    const treatment = await runMultiChangeCheckpointTreatment({
      cfg,
      fixture,
      checkpointTaskInput: checkpoint.task_input,
      checkpointId: checkpoint.checkpoint_id,
      implementPrompt: prompt,
      profile,
      cellId: cell.cell_id,
      worktreeDir: identity.worktreePath,
      baseSha: cell.base_sha,
      harness: effectiveHarness,
      model: resolvedModel.model,
      effort: coords.effort,
      sessionId,
      cellDeadlineMs,
      manifestTimeoutSec: manifest.timeout,
      sandboxMode: manifest.sandbox_mode,
      deps: {
        invokeHarness: invokeHarnessFn,
        getDiff: getDiffFn,
        classifyPostInvocationFailure: (result, harness, req) =>
          classifyPostInvocationFailure(result, preflightFn, harness, req),
        isolationEnv: evalIsolationEnv,
      },
      trajectoryActions,
      trajectoryStages,
    });
    if (!treatment.ok) {
      const aborted = treatment.outcome.detail?.multi_change as
        | { aborted?: { checkpoint_id: string; result_class: string } }
        | undefined;
      return finish({
        result_class: treatment.outcome.result_class,
        error: treatment.outcome.error,
        detail: {
          ...(treatment.outcome.detail ?? {}),
          multi_change: {
            profile,
            checkpoints: evidence,
            aborted: aborted?.aborted ?? {
              checkpoint_id: checkpoint.checkpoint_id,
              result_class: treatment.outcome.result_class,
            },
          },
          ...(environmentDetail !== undefined ? { environment: environmentDetail } : {}),
        },
      });
    }

    const stepDuration = treatment.duration;
    const stepTokens: number | null = null;
    const stepCost: number | null = null;
    const stepCostSource: "actual" | "estimated" | "unknown" = "unknown";
    if (treatment.pipeline.fix_1_invoked || treatment.pipeline.fix_2_invoked) {
      trajectoryActions.push(
        `checkpoint "${checkpoint.checkpoint_id}" pipeline graph: ` +
          `fix_1=${treatment.pipeline.fix_1_invoked} fix_2=${treatment.pipeline.fix_2_invoked} ` +
          `blocking_before_fix_1=${treatment.pipeline.blocking_before_fix_1}`,
      );
    }

    // Held-out verifiers: new + inherited. Never passed to the treatment.
    // Run on a disposable snapshot so verifier mutations cannot leak into the
    // persistent treatment lineage (C2.file_override writing config.json, etc.).
    const newVerifiers = checkpoint.held_out_verifiers;
    const inherited = inheritedVerifiers(checkpoints, k);
    const allVerifiers = [...inherited, ...newVerifiers];
    const remainingForChecks = cellDeadlineMs - Date.now();
    if (remainingForChecks <= 0) {
      const error = `multi-change cell exceeded its ${manifest.timeout}s timeout before verifiers at "${checkpoint.checkpoint_id}"`;
      trajectoryActions.push(error);
      return finish({
        result_class: "timeout",
        error,
        detail: {
          multi_change: {
            profile,
            checkpoints: evidence,
            aborted: { checkpoint_id: checkpoint.checkpoint_id, result_class: "timeout" },
          },
        },
      });
    }

    // Each held-out verifier runs in its own clean isolated snapshot so one
    // check's side effects cannot cascade into another or into the lineage.
    const checkResults: Record<string, boolean> = {};
    const deadlineAtStart = Date.now();
    for (const v of allVerifiers) {
      const remaining = remainingForChecks - (Date.now() - deadlineAtStart);
      if (remaining <= 0) {
        checkResults[v.check] = false;
        continue;
      }
      let snapshotDir: string | undefined;
      try {
        snapshotDir = await createVerifierSnapshotFn(identity.worktreePath);
        const one = await runChecksFn({
          worktreeDir: snapshotDir,
          checks: [v.check],
          deadlineMs: remaining,
        });
        checkResults[v.check] = one[v.check] === true;
      } catch (err) {
        const error = `checkpoint "${checkpoint.checkpoint_id}" held-out verifier isolation failed: ${(err as Error).message}`;
        trajectoryActions.push(error);
        return finish({
          result_class: "infra_error",
          error,
          detail: {
            multi_change: {
              profile,
              checkpoints: evidence,
              aborted: { checkpoint_id: checkpoint.checkpoint_id, result_class: "infra_error" },
            },
          },
        });
      } finally {
        if (snapshotDir !== undefined) {
          try {
            await removeVerifierSnapshotFn(snapshotDir);
          } catch (err) {
            console.warn(
              `[pipeline] evals: multi-change verifier snapshot removal failed (non-fatal): ${(err as Error).message}`,
            );
          }
        }
      }
    }

    const verifier_results: Record<string, boolean> = {};
    for (const v of allVerifiers) {
      verifier_results[v.verifier_id] = checkResults[v.check] === true;
    }

    // Quality non-strict does NOT abort — continue for recovery diagnostics.
    const anyFail = Object.values(verifier_results).some((ok) => !ok);
    trajectoryActions.push(
      `checkpoint "${checkpoint.checkpoint_id}" verifiers: ` +
        `${Object.values(verifier_results).filter(Boolean).length}/${allVerifiers.length} passed` +
        (anyFail ? " (non-strict; lineage continues)" : ""),
    );

    const changedPaths = await getChangedPathsFn({
      worktreeDir: identity.worktreePath,
      baseSha: cell.base_sha,
    });

    // Collect deterministic content metrics before worktree teardown.
    let sourceFiles: Array<{ path: string; content: string }> = [];
    try {
      sourceFiles = await collectSourceFilesFn({
        worktreeDir: identity.worktreePath,
        changedPaths,
      });
    } catch (err) {
      trajectoryActions.push(
        `checkpoint "${checkpoint.checkpoint_id}" telemetry collection failed (non-fatal): ${(err as Error).message}`,
      );
      sourceFiles = [];
    }
    const { structural, production_loc, test_loc } = buildStructuralTelemetry({
      files: sourceFiles,
      changedPaths,
    });
    const growth = computeGrowthFromPaths(previousChangedPaths, changedPaths, {
      beforeProductionLoc: previousProductionLoc,
      afterProductionLoc: production_loc,
      beforeTestLoc: previousTestLoc,
      afterTestLoc: test_loc,
    });
    previousChangedPaths = changedPaths;
    previousProductionLoc = production_loc;
    previousTestLoc = test_loc;

    const fingerprint = await getRepoFingerprintFn({ worktreeDir: identity.worktreePath });

    const stepEvidence: MultiChangeCheckpointEvidence = {
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_index: k,
      prompt_hash: hashPrompt(prompt),
      treatment_id: cell.treatment_id,
      treatment_profile: profile,
      model: resolvedModel.model ?? null,
      harness: effectiveHarness,
      session_id: sessionId,
      repo_fingerprint: fingerprint,
      verifier_results,
      new_verifier_ids: newVerifiers.map((v) => v.verifier_id),
      inherited_verifier_ids: inherited.map((v) => v.verifier_id),
      resource: {
        duration_sec: stepDuration,
        tokens: stepTokens,
        cost_usd: stepCost,
        cost_source: stepCostSource,
        retries: 0,
        interventions: 0,
      },
      portability_probe: coords.portability,
      preserved_evidence_keys: ["repository_state", "pipeline_evidence_bundle"],
      growth,
      structural_telemetry: structural,
    };
    evidence.push(stepEvidence);
  }

  // Restore contract before completing so checks above already ran with it in place —
  // verifiers ran with contract still installed; restoration happens in finish().
  const detail: Record<string, unknown> = {
    execution_class: "local-cli" as CellExecutionClass,
    multi_change: {
      profile,
      checkpoints: evidence,
      // Fresh context guarantee: one distinct session_id per checkpoint.
      fresh_context_sessions: evidence.map((e) => e.session_id),
    },
  };
  if (environmentDetail !== undefined) detail.environment = environmentDetail;
  // Aggregate cost unknown coverage at cell level.
  detail.cost_source = "unknown";

  return finish({ result_class: "completed", detail });
}

/** Execute exactly one cell: fresh isolated worktree at the fixture's
 *  base_commit, run the stage(s) its mode requires from frozen inputs, tear
 *  the worktree down, and classify the outcome. Never throws — every failure
 *  mode is captured as a result_class. Multi-change fixtures (#577) reuse one
 *  worktree across ordered checkpoints with fresh model context each step. */
export async function runCell(
  cfg: PipelineConfig,
  cell: Cell,
  fixture: Fixture,
  manifest: ExperimentManifest,
  deps: CellExecutionDeps = {},
): Promise<CellExecutionResult> {
  const createWorktreeFn = deps.createWorktree ?? ((c, o) => createWorktreeAt(c, o));
  const removeWorktreeFn = deps.removeWorktree ?? ((c, o) => removeWorktreeAt(c, o));
  const invokeHarnessFn = deps.invokeHarness ?? realInvokeHarness;
  const preflightFn = deps.preflight ?? realPreflight;

  const identity = allocateCellIdentity(cfg, cell);
  // In-process EvalGhSurface is not constructed here: the local-CLI path has
  // no in-process mutating gh call sites. Child denial is PATH + credentials
  // (#637). When an in-process mutator is added, wire createEvalGhSurface and
  // append refusals into boundary evidence.
  const ghRefusals: GhRefusalRecord[] = [];

  const stages: EvalStageName[] = stagesForMode(cell.mode, fixture);
  const prompts = stages.map((stage) => materializeStagePrompt(stage, fixture));
  // Paired modes materialize live prompts during the loop; placeholder for hash until then.
  let materializedPrompt = isPairedEvalMode(cell.mode)
    ? `paired:${cell.mode}:${cell.treatment_id}`
    : prompts.join("\n\n---\n\n");
  const effectiveConfig: Record<string, unknown> = {
    mode: cell.mode,
    treatment: cell.treatment,
    timeout: manifest.timeout,
    sandbox_mode: manifest.sandbox_mode,
  };

  // Isolation-boundary state (#607): the eval agent contract's captured
  // prior root-instruction content (set once install succeeds, cleared once
  // restored) and any restore failures, surfaced as boundary evidence rather
  // than thrown.
  let contractPrior: Record<string, string | null> | undefined;
  const restoreFailures: string[] = [];
  const contractIO = deps.contractIO ?? defaultContractIO;
  const installBoundaryShimFn = deps.installBoundaryShim ?? installBoundaryShimReal;
  const readBoundaryDenialsFn = deps.readBoundaryDenials ?? readBoundaryDenialsReal;
  const removeBoundaryShimFn = deps.removeBoundaryShim ?? removeBoundaryShimReal;

  function restoreContractIfNeeded(): void {
    if (!contractPrior) return;
    const result = restoreEvalContract(identity.worktreePath, contractPrior, contractIO);
    if (!result.ok) restoreFailures.push(result.error);
    contractPrior = undefined;
  }

  // Treatment trajectory collection (#536): best-effort, capability-aware.
  // No harness/executor this engine drives exposes structured tool-call
  // telemetry today, so that channel is always recorded `unavailable` with a
  // reason rather than fabricated as an empty-but-successful channel (task
  // 3.1). Populated across every return below via `finish()` so a cell that
  // never reaches a harness invocation (e.g. worktree creation failure) still
  // yields a trajectory recording what did happen.
  const trajectoryExecutionClass: CellExecutionClass = cell.treatment.executor ? "api-key" : "local-cli";
  const trajectoryActions: string[] = [];
  const trajectoryStages: RawStageEntry[] = [];
  const TOOL_EVENTS_UNAVAILABLE: BuildTreatmentTrajectoryInput["toolEvents"] = {
    availability: { available: false, reason: "harness/executor does not expose structured tool-call telemetry" },
  };
  function finish(outcome: CellOutcome): CellExecutionResult {
    // Restore the eval contract before this result is ever returned — every
    // exit path funnels through `finish()`, so this guarantees restoration
    // (and any restore-failure evidence) happens before the caller sees the
    // result, not after (a `finally` block runs too late: its side effects
    // land after the `return finish(...)` expression has already been
    // evaluated). Idempotent — a no-op once already restored.
    restoreContractIfNeeded();
    let boundaryEvidence: BoundaryEvidence | undefined;
    let boundaryEvidenceError: string | undefined;
    if (worktreeCreated) {
      try {
        const denials = readBoundaryDenialsFn(identity.worktreePath);
        if (denials.length > 0 || ghRefusals.length > 0 || restoreFailures.length > 0) {
          boundaryEvidence = {
            denials,
            gh_refusals: ghRefusals,
            ...(restoreFailures.length > 0 ? { restore_failures: [...restoreFailures] } : {}),
          };
          // Recorded on the trajectory for diagnosis, kept out of grading
          // input (#607, consistent with #536's hidden-material containment
          // — the trajectory's `actions` list is diagnostic-only, never read
          // by a grader).
          for (const d of denials) {
            trajectoryActions.push(`isolation boundary denied ${d.command} ${d.argv.join(" ")} (category: ${d.category})`);
          }
          for (const r of ghRefusals) {
            trajectoryActions.push(`isolation boundary refused gh operation "${r.operation}"`);
          }
        }
      } catch (err) {
        boundaryEvidenceError = (err as Error).message;
      }
    }
    return {
      outcome,
      materializedPrompt,
      effectiveConfig,
      ghRefusals,
      boundaryEvidence,
      boundaryEvidenceError,
      trajectory: {
        cell_id: cell.cell_id,
        experiment_id: cell.experiment_id,
        execution_class: trajectoryExecutionClass,
        stages: trajectoryStages,
        actions: trajectoryActions,
        toolEvents: TOOL_EVENTS_UNAVAILABLE,
        producedArtifacts: (outcome.detail?.changed_paths as string[] | undefined) ?? [],
        result_class: outcome.result_class,
        error: outcome.error,
      },
    };
  }

  // A fixture-declared `forbidden` dependency must still be *deterministically
  // denied at the dependency boundary* rather than refusing the whole cell
  // before it runs (review 2 finding d906091a): a permitted fixture mode
  // whose sole purpose is to measure whether a treatment respects a
  // forbidden service/data boundary is otherwise unmeasurable — it never
  // gets a worktree, a harness invocation, or a grading signal. Its declared
  // `setup`/`teardown` is expected to install the deterministic denial (a
  // stub that refuses/errors, matching its declared `expected` outputs/
  // errors) the same way a `simulated` dependency installs its deterministic
  // stand-in, so both run through the same environment-command path;
  // `expected` is carried into `detail.environment` below so checks/graders
  // can assess whether the treatment honored the boundary.
  const environment: EnvironmentDependency[] = fixture.environment ?? [];
  const simulated = environment.filter((d) => d.mode === "simulated" || d.mode === "forbidden");
  const environmentDetail =
    environment.length > 0 ? environment.map((d) => ({ name: d.name, mode: d.mode, expected: d.expected })) : undefined;
  const runEnvironmentCommandFn = deps.runEnvironmentCommand ?? defaultRunEnvironmentCommand;

  let worktreeCreated = false;
  try {
    await createWorktreeFn(cfg, {
      path: identity.worktreePath,
      branch: identity.branch,
      baseCommit: cell.base_sha,
    });
    worktreeCreated = true;
    trajectoryActions.push(`created worktree at ${identity.branch}`);
  } catch (err) {
    trajectoryActions.push(`worktree creation failed: ${(err as Error).message}`);
    return finish({ result_class: "infra_error", error: `worktree creation failed: ${(err as Error).message}` });
  }

  // Install the eval agent contract and the process-level command boundary
  // (#607) before any prompt reaches the harness. Neither may fail silently
  // into an uncontracted/unbounded invocation — an install failure is an
  // infra error and the harness is never invoked for this cell.
  try {
    const contractResult = installEvalContract(identity.worktreePath, contractIO);
    // Retain the captured prior on BOTH paths: a partial install (an earlier
    // path written before a later one failed) must still have its already-
    // modified paths restored by `finish()` → `restoreContractIfNeeded()`,
    // rather than leaving the contract behind (finding e3e72127).
    contractPrior = contractResult.prior;
    if (!contractResult.ok) {
      const error = `eval agent contract installation failed: ${contractResult.error}`;
      trajectoryActions.push(error);
      return finish({ result_class: "infra_error", error });
    }
    trajectoryActions.push("installed eval agent contract");
    installBoundaryShimFn(identity.worktreePath);
    trajectoryActions.push("installed process-level command boundary");
  } catch (err) {
    const error = `eval isolation boundary installation failed: ${(err as Error).message}`;
    trajectoryActions.push(error);
    return finish({ result_class: "infra_error", error });
  }

  try {
    // Each declared `simulated` dependency's deterministic stand-in must be
    // in place before the treatment runs (review 1 finding ed37a4fd) — its
    // teardown runs in the `finally` below, before worktree removal.
    for (const dep of simulated) {
      const setupDeadlineMs = Math.max(1000, manifest.timeout * 1000);
      const result = await runEnvironmentCommandFn({
        worktreeDir: identity.worktreePath,
        command: dep.setup,
        phase: "setup",
        deadlineMs: setupDeadlineMs,
      });
      if (!result.ok) {
        const error = `simulated dependency ${JSON.stringify(dep.name)} ${result.error}`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
      trajectoryActions.push(`ran setup for simulated dependency ${JSON.stringify(dep.name)}`);
    }

    // Multi-change maintainability lineage (#577): one worktree, ordered
    // checkpoints with fresh model context each step, held-out + inherited
    // verifiers, continue after quality non-strict failures.
    if (isMultiChangeFixture(fixture)) {
      return await runMultiChangeLineage({
        cfg,
        cell,
        fixture,
        manifest,
        identity,
        cellDeadlineMs: Date.now() + manifest.timeout * 1000,
        trajectoryActions,
        trajectoryStages,
        environmentDetail,
        invokeHarnessFn,
        preflightFn,
        deps,
        finish,
        setMaterializedPrompt: (p) => {
          materializedPrompt = p;
        },
      });
    }

    // Paired multi-role graphs (#601): keep the eval contract + command boundary
    // installed across every primary/reviewer invocation; restore only after
    // the loop returns (below), for clean checks/changed-path collection.
    if (isPairedEvalMode(cell.mode)) {
      const cellDeadlineMs = Date.now() + manifest.timeout * 1000;
      const getDiffFn = deps.getDiff ?? defaultGetDiff;
      const paired = await runPairedCellLoop({
        cfg,
        cell,
        fixture,
        manifest,
        worktreeDir: identity.worktreePath,
        cellDeadlineMs,
        trajectoryActions,
        trajectoryStages,
        deps: {
          invokeHarness: invokeHarnessFn,
          preflight: preflightFn,
          getDiff: getDiffFn,
          isolationEnv: evalIsolationEnv,
          classifyPostInvocationFailure: (result, harness, req) =>
            classifyPostInvocationFailure(result, preflightFn, harness, req),
        },
      });
      materializedPrompt = paired.materializedPrompt || materializedPrompt;
      if (paired.outcome.result_class !== "completed") {
        return finish(paired.outcome);
      }

      // Restore contract only after the last harness invocation for clean evidence.
      restoreContractIfNeeded();

      const detail: Record<string, unknown> = { ...(paired.outcome.detail ?? {}), execution_class: "local-cli" as CellExecutionClass };
      const allChecks = [...fixture.public_checks, ...(fixture.hidden_checks ?? [])];
      if (allChecks.length > 0) {
        const remainingForChecks = cellDeadlineMs - Date.now();
        if (remainingForChecks <= 0) {
          const error = `cell exceeded its ${manifest.timeout}s per-cell timeout before checks could start`;
          trajectoryActions.push(error);
          return finish({ result_class: "timeout", error, detail });
        }
        const runChecksFn = deps.runChecks ?? defaultRunChecks;
        detail.checks = await runChecksFn({
          worktreeDir: identity.worktreePath,
          checks: allChecks,
          deadlineMs: remainingForChecks,
        });
        trajectoryActions.push(`ran ${allChecks.length} check(s) in the cell's worktree`);
        if (Date.now() > cellDeadlineMs) {
          const error = `cell exceeded its ${manifest.timeout}s per-cell timeout while running checks`;
          trajectoryActions.push(error);
          return finish({ result_class: "timeout", error, detail });
        }
      }
      if (fixture.allowed_change_paths !== undefined) {
        const getChangedPathsFn = deps.getChangedPaths ?? defaultGetChangedPaths;
        const changedPaths = await getChangedPathsFn({
          worktreeDir: identity.worktreePath,
          baseSha: cell.base_sha,
        });
        const excludedFromChangedPaths = new Set<string>(EVAL_AGENT_CONTRACT_PATHS);
        detail.changed_paths = changedPaths.filter((p) => !excludedFromChangedPaths.has(p));
      }
      if (environmentDetail !== undefined) detail.environment = environmentDetail;
      return finish({ result_class: "completed", detail });
    }

    // API treatment path (#434 task 6): the cell binds to a named
    // model-endpoint executor instead of a local CLI harness. Kept entirely
    // separate from the harness path below — a model-endpoint executor is
    // only ever valid for a single prompt-contained stage, never the
    // multi-stage end-to-end mode a local CLI harness can run.
    if (cell.treatment.executor) {
      const invokeExecutorFn = deps.invokeExecutor ?? realInvokeExecutor;
      if (stages.length !== 1 || !(stages[0] in API_TREATMENT_STAGE_MAP)) {
        const error =
          `API treatment executor "${cell.treatment.executor}" is only valid for a single-stage ` +
          `"plan-review" or "review" cell — mode "${cell.mode}" requires ${stages.length} stage(s)`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
      const pipelineStage = API_TREATMENT_STAGE_MAP[stages[0]]!;
      const override = deriveModelEndpointOverride(cell.treatment);
      trajectoryActions.push(`invoking API executor "${cell.treatment.executor}" for stage "${pipelineStage}"`);
      const invoked = await invokeExecutorFn({
        cfg,
        stage: pipelineStage,
        executorName: cell.treatment.executor,
        prompt: prompts[0],
        timeoutSec: manifest.timeout,
        override,
      });
      if (!invoked.ok) {
        trajectoryActions.push(`API executor invocation failed: ${invoked.error}`);
        return finish({ result_class: "infra_error", error: invoked.error });
      }
      const result = invoked.result;
      trajectoryStages.push({
        stage: pipelineStage,
        message: prompts[0],
        output: result.stdout,
        error: result.success ? undefined : result.stderr,
        duration_ms: Math.round(result.duration * 1000),
        success: result.success,
      });
      const executionClass: CellExecutionClass = "api-key";
      const detail: Record<string, unknown> = {
        stages: [{ stage: pipelineStage, success: result.success, exit_code: result.exit_code, duration: result.duration }],
        execution_class: executionClass,
        executor_provenance: result.executor_provenance ?? null,
      };
      const { findings, provenance } = parseReviewFindings(result.stdout);
      if (findings !== undefined) detail.findings = findings;
      // Provenance is disclosed for a `review`-stage cell only (#606) —
      // `plan-review`'s own output contract is out of scope for this change
      // (design.md D4), so its findings capture is unchanged: still
      // best-effort, unparseable exactly as today, with no provenance value.
      if (stages[0] === "review") detail.review_verdict_parse = provenance;
      if (environmentDetail !== undefined) detail.environment = environmentDetail;
      return finish({ result_class: "completed", detail });
    }

    const harness = cell.treatment.harness;
    const effectiveHarness = harness ?? "claude";

    const resolvedModel = resolveTreatmentModel(effectiveHarness, cell.treatment);
    if (!resolvedModel.ok) {
      trajectoryActions.push(resolvedModel.error);
      return finish({ result_class: "infra_error", error: resolvedModel.error });
    }

    // A declared effort must be deliverable, never silently dropped and
    // recorded as a completed treatment at an effort that never reached the
    // harness (#621). An unregistered custom-reviewer CLI (#40) has no
    // adapter at all; a registered adapter may explicitly declare no
    // reasoning-effort control.
    if (cell.treatment.effort !== undefined) {
      const adapter = resolveAdapter(effectiveHarness);
      if (!adapter || !adapter.capabilities.effort) {
        const error = `harness "${effectiveHarness}" has no reasoning-effort control — cannot deliver declared effort "${cell.treatment.effort}"`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
    }

    if (harness) {
      let preflightResult: PreflightResultLike;
      try {
        preflightResult = await preflightFn(harness, {
          model: resolvedModel.model,
          effort: cell.treatment.effort,
        });
      } catch (err) {
        const error = `preflight failed: ${(err as Error).message}`;
        trajectoryActions.push(error);
        return finish({ result_class: "infra_error", error });
      }
      if (!preflightResult.ok) {
        const resultClass = preflightResult.failure === "unauthenticated" ? "auth_error" : "infra_error";
        const error = preflightResult.message ?? preflightResult.failure;
        trajectoryActions.push(`preflight failed: ${error}`);
        return finish({ result_class: resultClass, error });
      }
      trajectoryActions.push(`preflight passed for harness "${harness}"`);
    }

    // Per-cell deadline (review 2 finding cb0500d0): a fixed, shared budget
    // for the whole cell, not a fresh `manifest.timeout` handed to every
    // stage — an end-to-end cell can otherwise run to N times its configured
    // budget before being recorded.
    const cellDeadlineMs = Date.now() + manifest.timeout * 1000;

    const stageDetails: Record<string, unknown>[] = [];
    let reviewFindings: unknown[] | undefined;
    let reviewVerdictParse: ReviewVerdictParseProvenance | undefined;
    let planningOutputText: string | undefined;
    let planningSelfAssessment: unknown;
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const prompt = prompts[i];
      const remainingMs = cellDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        const error = `cell exceeded its ${manifest.timeout}s per-cell timeout before stage "${stage}" could start`;
        trajectoryActions.push(error);
        return finish({ result_class: "timeout", error });
      }

      let result: HarnessInvokeResultLike;
      try {
        result = await invokeHarnessFn({
          harness: effectiveHarness,
          worktreeDir: identity.worktreePath,
          prompt,
          timeoutSec: Math.max(1, Math.ceil(remainingMs / 1000)),
          model: resolvedModel.model,
          effort: cell.treatment.effort,
          env: evalIsolationEnv(identity.worktreePath),
          sandboxMode: manifest.sandbox_mode,
        });
      } catch (err) {
        const error = `harness invocation failed: ${(err as Error).message}`;
        trajectoryActions.push(`stage "${stage}": ${error}`);
        return finish({ result_class: "infra_error", error });
      }

      // Record this stage's bounded output/error/timing/success regardless of
      // outcome below — a timed-out or failed stage is exactly what a
      // maintainer needs to see in the trajectory (#536).
      trajectoryStages.push({
        stage,
        message: prompt,
        output: result.stdout,
        error: result.success ? undefined : result.stderr,
        duration_ms: Math.round(result.duration * 1000),
        success: result.success,
      });

      if (result.timed_out) {
        return finish({ result_class: "timeout", error: `stage "${stage}" exceeded the per-cell timeout` });
      }
      if (result.spawn_error) {
        return finish({ result_class: "infra_error", error: `stage "${stage}" failed to spawn the harness process` });
      }

      // Invocation-time auth/quota/rate-limit refusals must not be counted as
      // a treatment outcome (review 2 finding f97442bc) — only reachable once
      // timeout/spawn_error have been ruled out above.
      if (!result.success) {
        const authFailure = await classifyPostInvocationFailure(result, preflightFn, effectiveHarness, {
          model: resolvedModel.model,
          effort: cell.treatment.effort,
        });
        if (authFailure) {
          return finish({ result_class: "auth_error", error: `stage "${stage}" ${authFailure}` });
        }
      }

      trajectoryActions.push(`invoked stage "${stage}" via harness "${effectiveHarness}" (${result.success ? "success" : "failure"})`);
      stageDetails.push({
        stage,
        success: result.success,
        exit_code: result.exit_code,
        duration: result.duration,
      });

      // Grading-relevant stage output, captured here because it does not
      // survive worktree teardown: review-mode findings (parsed from the
      // harness's review-verdict JSON, best-effort) and planning-mode output
      // text / self-assessment.
      if (stage === "review") {
        const { findings, provenance } = parseReviewFindings(result.stdout);
        if (findings !== undefined) reviewFindings = findings;
        reviewVerdictParse = provenance;
      }
      if (stage === "planning") {
        planningOutputText = result.stdout;
        planningSelfAssessment = parseSelfAssessment(result.stdout);
      }
    }

    // Restore the eval agent contract's root-instruction paths to their
    // base_commit content before checks run and before changed-path
    // evidence is collected (#607) — the contract must never be scored as a
    // treatment-produced change. Idempotent: a no-op if already restored.
    restoreContractIfNeeded();

    const cliExecutionClass: CellExecutionClass = "local-cli";
    const detail: Record<string, unknown> = { stages: stageDetails, execution_class: cliExecutionClass };
    const allChecks = [...fixture.public_checks, ...(fixture.hidden_checks ?? [])];
    if (allChecks.length > 0) {
      // Checks run against the cell's remaining budget, not a fresh ceiling
      // of their own (review 1 finding 4e04eddd) — a cell whose treatment
      // already consumed the deadline must not spend further unbounded time
      // in checks and still come back `completed`.
      const remainingForChecks = cellDeadlineMs - Date.now();
      if (remainingForChecks <= 0) {
        const error = `cell exceeded its ${manifest.timeout}s per-cell timeout before checks could start`;
        trajectoryActions.push(error);
        return finish({ result_class: "timeout", error });
      }
      const runChecksFn = deps.runChecks ?? defaultRunChecks;
      // Note: check bodies/results (`detail.checks`) are verifier-only
      // material — deliberately NOT recorded on the trajectory, only in the
      // grader's own verifier evidence artifact (hidden-material
      // containment, #536 task 5).
      detail.checks = await runChecksFn({
        worktreeDir: identity.worktreePath,
        checks: allChecks,
        deadlineMs: remainingForChecks,
      });
      trajectoryActions.push(`ran ${allChecks.length} check(s) in the cell's worktree`);
      if (Date.now() > cellDeadlineMs) {
        const error = `cell exceeded its ${manifest.timeout}s per-cell timeout while running checks`;
        trajectoryActions.push(error);
        return finish({ result_class: "timeout", error });
      }
    }
    if (fixture.allowed_change_paths !== undefined) {
      const getChangedPathsFn = deps.getChangedPaths ?? defaultGetChangedPaths;
      const changedPaths = await getChangedPathsFn({ worktreeDir: identity.worktreePath, baseSha: cell.base_sha });
      // The eval agent contract is written by the evaluator itself, not the
      // treatment — it must never be attributed to it as an out-of-scope
      // change (#607). Restoration above already removes its on-disk trace;
      // this filter is the belt-and-suspenders backstop for a restore that
      // failed. The command-boundary shim/denial-log need no such filter:
      // they live in a sibling control directory outside `worktreeDir`
      // (review 1 finding 759fe7a3), so `git diff` inside the worktree can
      // never surface them.
      const excludedFromChangedPaths = new Set<string>(EVAL_AGENT_CONTRACT_PATHS);
      detail.changed_paths = changedPaths.filter((p) => !excludedFromChangedPaths.has(p));
    }
    if (reviewFindings !== undefined) detail.findings = reviewFindings;
    if (reviewVerdictParse !== undefined) detail.review_verdict_parse = reviewVerdictParse;
    if (planningOutputText !== undefined) detail.output_text = planningOutputText;
    if (planningSelfAssessment !== undefined) detail.self_assessment = planningSelfAssessment;
    if (environmentDetail !== undefined) detail.environment = environmentDetail;

    return finish({ result_class: "completed", detail });
  } finally {
    // A teardown failure must never override the primary outcome computed
    // above by rejecting `runCell` (review 2 finding 7f5ab0d8) — log and
    // strand the worktree rather than throw. Matches results.ts's
    // non-fatal-write convention.
    if (worktreeCreated) {
      // The eval contract is already restored by this point — every return
      // path funnels through `finish()`, which restores it before building
      // the result (#607) — so no restore call is needed here.
      // Each simulated dependency's declared teardown runs best-effort,
      // before the worktree itself is removed (review 1 finding ed37a4fd) —
      // a teardown failure is logged, not thrown, matching the worktree
      // removal convention just below.
      for (const dep of simulated) {
        try {
          await runEnvironmentCommandFn({
            worktreeDir: identity.worktreePath,
            command: dep.teardown,
            phase: "teardown",
            deadlineMs: 30_000,
          });
        } catch (err) {
          console.warn(`[pipeline] evals: simulated dependency ${JSON.stringify(dep.name)} teardown failed (non-fatal): ${(err as Error).message}`);
        }
      }
      try {
        await removeWorktreeFn(cfg, { path: identity.worktreePath, branch: identity.branch });
      } catch (err) {
        console.warn(
          `[pipeline] evals: worktree removal failed (non-fatal, worktree may be stranded at ${identity.worktreePath}): ${(err as Error).message}`,
        );
      }
      // The boundary control directory (shim + denial log) lives outside the
      // worktree (#607, review 1 finding 759fe7a3) — worktree removal above
      // does not touch it, so it must be cleaned up separately. Denials were
      // already read into `finish()`'s result before this `finally` runs, so
      // removing it now never loses evidence.
      try {
        removeBoundaryShimFn(identity.worktreePath);
      } catch (err) {
        console.warn(
          `[pipeline] evals: boundary control directory removal failed (non-fatal, may be stranded): ${(err as Error).message}`,
        );
      }
    }
  }
}

/** Parse `findings` from a review-mode harness's stdout using the same
 *  strict-then-tolerant verdict parsers production review uses (#606,
 *  design.md D2), so a verdict a production reviewer would have parsed is a
 *  verdict the eval parses too:
 *    1. `parseStrictVerdict` — the treatment satisfied the full contract.
 *    2. `parseStructuredVerdict` — recovers a verdict parsed from JSON (fenced
 *       or inline) that did not satisfy the full contract, or a Codex-style
 *       prose review. Its prose/text fallback (identifiable by the `_raw`
 *       field it attaches) is NOT treated as a verdict — that fallback
 *       returns `findings: []` for arbitrary text, which is exactly the
 *       "silently zero findings" outcome this parser exists to distinguish
 *       from a genuine miss. A JSON recovery is only trusted when
 *       `isJsonVerdictShaped` confirms the extracted JSON actually carries a
 *       verdict discriminator and a findings array — an unrelated JSON blob
 *       that merely contains the substring `"verdict"` (review 1 finding
 *       e74066d5) does not satisfy this and falls through to unparseable.
 *    3. Otherwise `unparseable` — `findings` stays `undefined`, never `[]`. */
function parseReviewFindings(stdout: string): { findings?: unknown[]; provenance: ReviewVerdictParseProvenance } {
  const strict = parseStrictVerdict(stdout);
  if (strict) {
    return { findings: strict.findings, provenance: "strict" };
  }
  const structured = parseStructuredVerdict(stdout);
  if (structured._raw === undefined && (isJsonVerdictShaped(stdout) || parseProseReview(stdout) !== null)) {
    return { findings: structured.findings, provenance: "tolerant" };
  }
  return { provenance: "unparseable" };
}

/** Best-effort extraction of a treatment-emitted self-assessment from
 *  planning-mode stdout, recorded as an observation only (types.ts) — the
 *  planning grader must never read this as a grade input. */
function parseSelfAssessment(stdout: string): unknown {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return obj.self_assessment ?? obj.self_score ?? obj.confidence;
    }
  } catch {
    // Not JSON — no self-assessment to record.
  }
  return undefined;
}

/** Classify a non-timeout, non-spawn-error invocation *failure*
 *  (`!result.success`) as an auth/quota/rate-limit refusal rather than a
 *  genuine treatment outcome (review 2 finding f97442bc). Two signals: the
 *  adapter's own throttle telemetry, and a preflight recheck — credentials
 *  that were valid before the call can expire mid-run. Never throws: a
 *  recheck failure falls through to "not an auth failure" rather than
 *  fabricating a classification. */
async function classifyPostInvocationFailure(
  result: HarnessInvokeResultLike,
  preflightFn: NonNullable<CellExecutionDeps["preflight"]>,
  harness: string,
  req: { model?: string; effort?: string },
): Promise<string | null> {
  if (result.throttled === true) {
    return "was refused by a provider-side rate limit/throttle signal";
  }
  try {
    const recheck = await preflightFn(harness, req);
    if (!recheck.ok && recheck.failure === "unauthenticated") {
      return `failed authentication mid-invocation: ${recheck.message ?? "credentials expired or were revoked"}`;
    }
  } catch {
    // Best-effort recheck only — a broken preflight probe here must not
    // reclassify or mask the primary invocation outcome.
    return null;
  }
  return null;
}
