// Git worktree lifecycle for pipeline issues.
//
// Conventions:
//   - Worktree dir: <repo>/.worktrees/pipeline-<issueN>-<slug>
//   - Branch:       pipeline/<issueN>-<slug>
//
// All paths are absolute. Shells out to `git` via execFile.

import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Per-repo worktree-creation mutex (#183)
//
// Serializes `git worktree add` across concurrent pipeline instances in the
// same repo. `git worktree add` writes upstream config to the shared
// .git/config, which two concurrent writers race on .git/config.lock.
// The mutex path is /tmp/pipeline-wt-<hash>.lock where <hash> is an 8-char
// SHA-1 prefix of the repo path — unique per repo, stable across processes.
// ---------------------------------------------------------------------------

/** 8-char hex prefix of SHA-1 of the given path. Used to namespace mutex files. */
export function repoHash(dir: string): string {
  return createHash("sha1").update(dir).digest("hex").slice(0, 8);
}

/** Mutex lock file path for worktree creation, keyed on the canonical Git
 *  common directory so that two linked worktrees of the same repo share the
 *  same mutex even when their `repo_dir` paths differ. */
export function worktreeMutexPath(commonDir: string): string {
  return `/tmp/pipeline-wt-${repoHash(commonDir)}.lock`;
}

/** Resolve the canonical Git common directory (shared across all linked
 *  worktrees).  This is the directory that owns `.git/config`, so two runs
 *  starting from different linked worktrees of the same repo return the same
 *  path and thus the same mutex file. */
async function realResolveGitCommonDir(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeout: 5_000 },
  );
  return stdout.trim();
}

/** Injectable deps for acquireWorktreeMutex — allows unit tests to bypass
 *  real filesystem and PID operations. */
export interface AcquireWorktreeMutexDeps {
  /** Atomically create the lock file with the given content. Returns true if
   *  created, false if the file already exists (EEXIST). Throws on other errors. */
  atomicCreate?: (path: string, content: string) => boolean;
  /** Read the lock file content. Returns null if the file does not exist. */
  readContent?: (path: string) => string | null;
  /** Remove the lock file, ignoring ENOENT. */
  unlink?: (path: string) => void;
  /** Returns true if the process with the given PID is still running. */
  isPidAlive?: (pid: number) => boolean;
  /** Returns the PID to write into the lock file (defaults to process.pid). */
  currentPid?: () => number;
}

function realAtomicCreate(p: string, content: string): boolean {
  try {
    const fd = fs.openSync(p, "wx");
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return false;
    throw err;
  }
}

function realReadContent(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

function realUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
}

function realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true; // process exists but can't signal it
    throw err;
  }
}

/** Acquire the per-repo worktree-creation mutex.
 *
 *  - Clean path → write current PID and return.
 *  - Lock file with dead/invalid PID → reclaim (remove + re-acquire).
 *  - Lock file with live PID → throw; the caller should retry with backoff. */
export function acquireWorktreeMutex(
  mutexPath: string,
  deps: AcquireWorktreeMutexDeps = {},
): void {
  const atomicCreate = deps.atomicCreate ?? realAtomicCreate;
  const readContent = deps.readContent ?? realReadContent;
  const unlink = deps.unlink ?? realUnlink;
  const isPidAlive = deps.isPidAlive ?? realIsPidAlive;
  const currentPid = deps.currentPid ?? (() => process.pid);

  const created = atomicCreate(mutexPath, String(currentPid()));
  if (created) return; // acquired cleanly

  // File exists — check whether the holder is still alive.
  const content = readContent(mutexPath);
  if (content === null) {
    // File disappeared between the EEXIST and the read (rare race). Retry.
    return acquireWorktreeMutex(mutexPath, deps);
  }

  const holderPid = Number.parseInt(content, 10);
  const isValidPid = Number.isFinite(holderPid) && holderPid > 0;

  if (isValidPid && isPidAlive(holderPid)) {
    // Live process holds the mutex — signal the caller to wait.
    throw new Error(
      `Worktree mutex held by process ${holderPid}: ${mutexPath}. ` +
      "Wait for the concurrent worktree creation to finish, or remove the file if you are sure it is stale.",
    );
  }

  // PID is dead OR invalid/garbage — serialize the reclaim sequence with a
  // short-lived reclaimer lock.  Routing BOTH cases through the reclaim lock
  // prevents two concurrent reclaimers (whether they read a dead PID or
  // garbage content) from both unlinking and racing to reacquire: the second
  // unlink would delete the first's freshly-acquired lock.
  const reclaimPath = mutexPath + ".reclaim";
  const reclaimCreated = atomicCreate(reclaimPath, String(currentPid()));
  if (!reclaimCreated) {
    // Another reclaimer holds the reclaim lock.
    const reclaimContent = readContent(reclaimPath);
    if (reclaimContent !== null) {
      const reclaimPid = Number.parseInt(reclaimContent, 10);
      if (Number.isFinite(reclaimPid) && reclaimPid > 0 && isPidAlive(reclaimPid)) {
        // Live reclaimer in progress.  Throw so createWorktree's bounded
        // sleep loop handles the wait — synchronous recursion here would
        // overflow the stack if the reclaimer holds the lock for a long time.
        throw new Error(
          `Worktree mutex held by process ${reclaimPid} (reclaimer): ${mutexPath}. ` +
          "Wait for the concurrent worktree creation to finish, or remove the file if you are sure it is stale.",
        );
      }
    }
    // Stale or unreadable reclaim lock — remove and restart from scratch.
    unlink(reclaimPath);
    return acquireWorktreeMutex(mutexPath, deps);
  }
  try {
    // Re-verify content while holding the reclaimer lock.  If another
    // reclaimer already won the race and reacquired, restart without
    // unlinking the (now-live) main lock.
    const current = readContent(mutexPath);
    if (current !== content) {
      return acquireWorktreeMutex(mutexPath, deps);
    }
    unlink(mutexPath);
  } finally {
    unlink(reclaimPath);
  }
  return acquireWorktreeMutex(mutexPath, deps);
}

/** Release the per-repo worktree-creation mutex. */
export function releaseWorktreeMutex(mutexPath: string): void {
  try {
    fs.unlinkSync(mutexPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
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
  /** True when the record's path is directly under the pipeline-managed worktree
   *  root as determined by parseWorktreePorcelain. False means the worktree shares
   *  a pipeline branch name but lives outside the managed root (e.g. a developer's
   *  checkout). Undefined means the record was constructed without parsing (test
   *  injection) and the path-based fallback guard in sweepMergedWorktrees applies. */
  underManagedRoot?: boolean;
}

/** Parse `git worktree list --porcelain` output into pipeline worktree records.
 *
 *  A worktree is identified by issue + slug from its `pipeline/<N>-<slug>`
 *  branch when it is checked out on that branch. When it is **off its branch**
 *  — git emits no `branch` line for a detached HEAD, which happens while a
 *  stage checks out a specific SHA inside the worktree (e.g. the review→fix
 *  handoff) — we fall back to deriving the identity from the on-disk directory
 *  name `pipeline-<N>-<slug>` under the configured worktree root. Without that
 *  fallback a present, git-registered worktree is invisible the moment it is
 *  not on its branch, so the fix stage's {@link getForIssue} falsely reports
 *  "No worktree found" and blocks a converging run (#223).
 *
 *  Pure (no I/O) so the parsing + matching is unit-testable without real git. */
export function parseWorktreePorcelain(
  stdout: string,
  worktreeRootAbs: string,
): WorktreeRecord[] {
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

  const root = path.resolve(worktreeRootAbs);
  const pipelineRecords: WorktreeRecord[] = [];
  for (const rec of records) {
    let issueNumber: number | undefined;
    let slug: string | undefined;

    // Prefer the branch when the worktree is on its pipeline branch.
    const branchMatch = rec.branch?.startsWith("pipeline/")
      ? rec.branch.slice("pipeline/".length).match(/^(\d+)-(.+)$/)
      : null;
    if (branchMatch) {
      issueNumber = Number.parseInt(branchMatch[1], 10);
      slug = branchMatch[2];
    } else if (rec.branch === undefined && path.resolve(path.dirname(rec.path)) === root) {
      // Off-branch (detached) fallback: only for records with NO branch line in
      // the porcelain output (rec.branch === undefined). A worktree that IS on a
      // branch but not a pipeline/* branch must NOT be matched by directory name —
      // that would misidentify e.g. a pipeline-named dir checked out on main.
      const pathMatch = path.basename(rec.path).match(/^pipeline-(\d+)-(.+)$/);
      if (pathMatch) {
        issueNumber = Number.parseInt(pathMatch[1], 10);
        slug = pathMatch[2];
      }
    }

    if (issueNumber !== undefined && slug !== undefined) {
      rec.issueNumber = issueNumber;
      rec.slug = slug;
      // Mark whether the path is directly under the managed worktree root so
      // callers can guard destructive operations (reclaim, sweep) to managed
      // paths without recomputing the root from cfg.repo_dir (wrong for linked
      // launches).
      rec.underManagedRoot = path.resolve(path.dirname(rec.path)) === root;
      pipelineRecords.push(rec);
    }
  }
  return pipelineRecords;
}

export interface ListOnDiskDeps {
  gitCmd?: (
    cfg: PipelineConfig,
    cwd: string,
    args: string[],
    opts?: { ignoreFailure?: boolean; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Raw on-disk listing — every pipeline worktree (`pipeline/<N>-<slug>` branch
 *  or `pipeline-<N>-<slug>` directory under the worktree root). Includes
 *  worktrees for issues that are already closed or sitting at
 *  `pipeline:ready-to-deploy`. */
export async function listOnDisk(cfg: PipelineConfig, deps: ListOnDiskDeps = {}): Promise<WorktreeRecord[]> {
  const gitFn = deps.gitCmd ?? git;
  const { stdout } = await gitFn(cfg, cfg.repo_dir, ["worktree", "list", "--porcelain"]);
  // Derive the pipeline worktree root from the FIRST "worktree <path>" line —
  // git always lists the main (non-linked) worktree first. Using cfg.repo_dir
  // directly is wrong when the CLI is launched from a linked worktree: cfg.repo_dir
  // would be the linked worktree path, so path.resolve(cfg.repo_dir, cfg.worktree_root)
  // would point to a non-existent nested .worktrees rather than the repo-level one,
  // causing detached sibling worktrees to fall through the off-branch guard (#223).
  const firstWorktreeLine = stdout.split("\n").find((l) => l.startsWith("worktree "));
  const mainRepoRoot = firstWorktreeLine
    ? firstWorktreeLine.slice("worktree ".length).trim()
    : cfg.repo_dir;
  return parseWorktreePorcelain(stdout, path.resolve(mainRepoRoot, cfg.worktree_root));
}

/** Worktrees backing issues that are still in-flight — open on GitHub AND
 *  not already at `pipeline:ready-to-deploy`. This is what
 *  `max_concurrent_worktrees` should gate on; closed-issue and terminal
 *  worktrees occupy disk but no longer represent active work.
 *  On `gh` lookup failure we treat the worktree as active (fail safe — never
 *  let a transient API blip silently uncap concurrency). */
/** Injectable seam for {@link listActive} / {@link getForIssue}: the per-worktree
 *  GitHub state lookup (one `getIssueStateAndLabels` call per on-disk worktree) and
 *  the on-disk listing can be faked and counted in tests/benchmarks. Both default to
 *  the real implementations, so production behavior is unchanged. */
export interface ListActiveDeps {
  listOnDisk?: (cfg: PipelineConfig) => Promise<WorktreeRecord[]>;
  getIssueStateAndLabels?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ state: "open" | "closed"; labels: string[] } | null>;
}

export async function listActive(cfg: PipelineConfig, deps: ListActiveDeps = {}): Promise<WorktreeRecord[]> {
  const listOnDiskFn = deps.listOnDisk ?? listOnDisk;
  const getStateFn = deps.getIssueStateAndLabels ?? getIssueStateAndLabels;
  const onDisk = await listOnDiskFn(cfg);
  const states = await Promise.all(
    onDisk.map((rec) =>
      rec.issueNumber === undefined
        ? Promise.resolve(null)
        : getStateFn(cfg, rec.issueNumber),
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
  deps: ListActiveDeps = {},
): Promise<{ path: string; slug: string } | null> {
  for (const rec of await listActive(cfg, deps)) {
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

export interface CreateWorktreeDeps {
  listActive?: (cfg: PipelineConfig) => Promise<WorktreeRecord[]>;
  existsSync?: (p: string) => boolean;
  removeWorktree?: (cfg: PipelineConfig, issueNumber: number, slug: string, resolvedPath?: string) => Promise<void>;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  gitCmd?: (
    cfg: PipelineConfig,
    cwd: string,
    args: string[],
    opts?: { ignoreFailure?: boolean; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Resolve the canonical Git common directory shared by all linked worktrees.
   *  Two runs from different linked worktrees of the same repo must return the
   *  same path so they share the same per-repo mutex file. */
  resolveGitCommonDir?: (repoDir: string) => Promise<string>;
  /** Acquire the per-repo worktree-creation mutex; throws if a live process holds it. */
  acquireMutex?: (path: string) => void;
  /** Release the per-repo worktree-creation mutex. */
  releaseMutex?: (path: string) => void;
  /** Sleep for the given number of milliseconds (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Write `node_modules` to `.git/info/exclude` inside the worktree (idempotent). */
  writeNodeModulesExclude?: (worktreePath: string) => Promise<void>;
  /** Return lstat of the given path, or null if ENOENT. */
  lstatPath?: (p: string) => Promise<{ isSymbolicLink(): boolean } | null>;
  /** Remove the file or symlink at the given path. */
  unlinkPath?: (p: string) => Promise<void>;
}

export async function realWriteNodeModulesExclude(worktreePath: string): Promise<void> {
  const gitMarker = path.join(worktreePath, ".git");
  let excludeDir: string;

  // A linked worktree (created with `git worktree add`) has a .git FILE rather
  // than a .git directory.  The file contains "gitdir: <real-gitdir-path>" that
  // points to the per-worktree metadata directory under the main repo's .git/worktrees/<name>.
  // Git resolves info/exclude through the COMMON git dir (the main .git/), not the
  // per-worktree dir, so writing to <per-worktree>/info/exclude has no effect.
  // We read the 'commondir' file Git always writes in the per-worktree dir to
  // find the common git dir and write there instead.
  const stat = await fs.promises.stat(gitMarker).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (stat !== null && stat.isFile()) {
    const content = await fs.promises.readFile(gitMarker, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error(`Malformed .git file at ${gitMarker}: ${content.slice(0, 80)}`);
    const perWorktreeGitDir = path.resolve(worktreePath, match[1].trim());
    // 'commondir' holds the path (relative or absolute) to the common git dir.
    const commondirContent = await fs.promises.readFile(
      path.join(perWorktreeGitDir, "commondir"),
      "utf8",
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    const commonGitDir = commondirContent !== null
      ? path.resolve(perWorktreeGitDir, commondirContent.trim())
      : perWorktreeGitDir;
    excludeDir = path.join(commonGitDir, "info");
  } else {
    excludeDir = path.join(gitMarker, "info");
  }

  const excludeFile = path.join(excludeDir, "exclude");
  await fs.promises.mkdir(excludeDir, { recursive: true });
  let existing = "";
  try {
    existing = await fs.promises.readFile(excludeFile, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
  if (!existing.split("\n").some((line) => line.trim() === "node_modules")) {
    await fs.promises.appendFile(excludeFile, "node_modules\n");
  }
}

async function realLstatPath(p: string): Promise<{ isSymbolicLink(): boolean } | null> {
  try {
    return await fs.promises.lstat(p);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function realUnlinkPath(p: string): Promise<void> {
  await fs.promises.unlink(p);
}

export async function createWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  deps: CreateWorktreeDeps = {},
): Promise<{ path: string; branch: string }> {
  const existsFn = deps.existsSync ?? fs.existsSync;
  const removeFn = deps.removeWorktree ?? removeWorktree;
  const listActiveFn = deps.listActive ?? listActive;
  const mkdirFn = deps.mkdirSync ?? ((p: string, opts: { recursive: boolean }) => { fs.mkdirSync(p, opts); });
  const gitFn = deps.gitCmd ?? git;
  const resolveGitCommonDirFn = deps.resolveGitCommonDir ?? realResolveGitCommonDir;
  const acquireMutexFn = deps.acquireMutex ?? ((p: string) => acquireWorktreeMutex(p));
  const releaseMutexFn = deps.releaseMutex ?? releaseWorktreeMutex;
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const writeNodeModulesExcludeFn = deps.writeNodeModulesExclude ?? realWriteNodeModulesExclude;
  const lstatPathFn = deps.lstatPath ?? realLstatPath;
  const unlinkPathFn = deps.unlinkPath ?? realUnlinkPath;

  const wtPath = worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);

  // Reclaim this issue's existing worktree(s) BEFORE the capacity check so they
  // never block its own retry. Two interacting rules, both keyed by ISSUE
  // NUMBER (never the freshly-computed slug path):
  //
  //  1. Remove EVERY active worktree recorded for this issue — not just the one
  //     at the current slug, and not just the first. A title change between a
  //     blocked run and the retry shifts the slug, and an issue can accumulate
  //     more than one stale `pipeline-<N>-<slug>` worktree across repeated title
  //     changes, so a slug-keyed or single-record reclaim leaves a self-owned
  //     stale worktree behind.
  //  2. Count capacity over OTHER issues only. Even if (1) somehow leaves a
  //     record, this issue's own slots must never count against
  //     max_concurrent_worktrees — we are (re)creating its worktree right now.
  //
  // Together these close the review-2 capacity-deadlock class (stale reclaim
  // keyed to mutable slug / reclaim removes only one worktree): setup-throw,
  // setup-success-then-block, title/slug change, and multi-stale accumulation.
  const active = await listActiveFn(cfg);
  const mine = active.filter((r) => r.issueNumber === issueNumber && r.slug);
  for (const rec of mine) {
    // Only reclaim worktrees explicitly under the managed root. A record with
    // underManagedRoot === false is a developer checkout that shares the pipeline
    // branch name but lives outside .worktrees/ — force-removing it would destroy
    // untracked work the pipeline never created. Records without underManagedRoot
    // (test-injected, undefined) are allowed through for backwards compatibility.
    if (rec.underManagedRoot === false) {
      console.log(`[pipeline] #${issueNumber}: skipping reclaim of out-of-managed-root worktree ${rec.path}`);
      continue;
    }
    // Pass rec.path so removal targets the discovered path directly, not a path
    // recomputed from cfg.repo_dir (which is wrong when launched from a linked worktree).
    await removeFn(cfg, issueNumber, rec.slug!, rec.path);
  }
  // Also clear any directory left at the *current* slug path that listActive did
  // not classify as active (e.g. a closed/terminal lookup) so the
  // `git worktree add` below cannot collide with it.
  if (existsFn(wtPath) && !mine.some((r) => r.slug === slug)) {
    await removeFn(cfg, issueNumber, slug);
  }

  const otherActive = active.filter((r) => r.issueNumber !== issueNumber).length;
  if (otherActive >= cfg.max_concurrent_worktrees) {
    throw new Error(
      `At worktree capacity (${otherActive}/${cfg.max_concurrent_worktrees}). ` +
        "Wait for an issue to complete before starting new work.",
    );
  }

  // Ensure the worktree root exists.
  mkdirFn(worktreeRoot(cfg), { recursive: true });

  // Fetch the latest base branch.
  await gitFn(cfg, cfg.repo_dir, ["fetch", "origin", cfg.base_branch], { ignoreFailure: false });

  // If the branch exists from a prior failed attempt, delete it.
  await gitFn(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });

  // Serialize git worktree add across concurrent pipeline instances in the
  // same repo. The mutex is held only for the duration of the subprocess call
  // so it never blocks unrelated pipeline work. A retry loop handles transient
  // .git/config.lock contention (belt-and-suspenders for cases the mutex
  // cannot prevent, e.g. a stale lock left by a crashed git process).
  //
  // The mutex is keyed on the canonical Git common directory (not cfg.repo_dir)
  // so two runs from different linked worktrees of the same repo share one
  // mutex even though their cfg.repo_dir paths differ.
  const commonDir = await resolveGitCommonDirFn(cfg.repo_dir);
  const mutexPath = worktreeMutexPath(commonDir);

  // Wait up to 90 s (the git subprocess timeout of 60 s plus 30 s margin)
  // so a live holder that is mid-git-worktree-add cannot outlast the wait.
  const MUTEX_POLL_MS = 200;
  const MUTEX_TIMEOUT_MS = 90_000;
  let mutexWaited = 0;
  for (;;) {
    try {
      acquireMutexFn(mutexPath);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Worktree mutex held by process") || mutexWaited >= MUTEX_TIMEOUT_MS) {
        throw err;
      }
      await sleepFn(MUTEX_POLL_MS);
      mutexWaited += MUTEX_POLL_MS;
    }
  }

  try {
    // 1 initial attempt + 3 retries = 4 total, matching the spec.
    const MAX_ATTEMPTS = 4;
    let lastStderr = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleepFn(200 * 2 ** (attempt - 1)); // 200ms, 400ms, 800ms
        // A failed `git worktree add -b <branch>` creates the branch before
        // it tries to write the config, so a config-lock failure leaves a
        // dangling branch.  Delete it before retrying so `-b <branch>` does
        // not immediately fail with "branch already exists".
        await gitFn(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });
      }
      const { code, stderr } = await gitFn(
        cfg,
        cfg.repo_dir,
        ["worktree", "add", wtPath, "-b", branch, `origin/${cfg.base_branch}`],
        { ignoreFailure: true },
      );
      if (code === 0) {
        // Bootstrap: write node_modules to .git/info/exclude so `git add` never
        // stages a node_modules entry regardless of type (dir, symlink, file).
        await writeNodeModulesExcludeFn(wtPath);
        // Remove a pre-existing node_modules symlink — left by a prior aborted run
        // that symlinked the primary checkout's deps without committing the exclude.
        const nmPath = path.join(wtPath, "node_modules");
        const stat = await lstatPathFn(nmPath);
        if (stat !== null && stat.isSymbolicLink()) {
          console.log(`[pipeline] #${issueNumber}: removing node_modules symlink: ${nmPath}`);
          await unlinkPathFn(nmPath);
        }
        return { path: wtPath, branch };
      }
      lastStderr = stderr;
      if (!stderr.includes("could not lock config file")) {
        throw new Error(`git worktree add failed: ${lastStderr.trim()}`);
      }
    }
    throw new Error(`git worktree add failed: ${lastStderr.trim()}`);
  } finally {
    releaseMutexFn(mutexPath);
  }
}

export async function removeWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  resolvedPath?: string,
): Promise<void> {
  // Use the caller-supplied path when available so that linked-worktree launches
  // (where cfg.repo_dir is a linked path) remove the correct sibling, not a
  // non-existent nested path under the linked worktree's own directory.
  const wtPath = resolvedPath ?? worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);
  if (fs.existsSync(wtPath)) {
    await git(cfg, cfg.repo_dir, ["worktree", "remove", wtPath, "--force"], { ignoreFailure: true });
  }
  await git(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });
}

// ---------------------------------------------------------------------------
// Detached HEAD recovery
// ---------------------------------------------------------------------------

/** Reattach a detached worktree to its pipeline branch before any mutating stage.
 *
 *  The review stage may check out a specific SHA for comparison, leaving the
 *  worktree in detached HEAD. If the fix harness then commits, those commits
 *  land on detached HEAD — not on the pipeline branch ref. The subsequent
 *  `git push origin pipeline/<N>-<slug>` pushes the local branch ref (unchanged)
 *  and exits 0 with "Everything up-to-date", so the PR branch never receives
 *  the fix commits (#223 review-2 finding 2).
 *
 *  Call this before invoking any harness. No-op when the worktree already has a
 *  branch; creates/resets the pipeline branch at the current HEAD otherwise. */
export async function reattachIfDetached(
  wt: WorktreeRecord,
  issueNumber: number,
  gitFn?: (
    cwd: string,
    args: string[],
    opts?: { ignoreFailure?: boolean; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>,
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  if (wt.branch !== undefined) return { ok: true };
  const fn = gitFn ?? gitInWorktree;
  const branch = branchName(issueNumber, wt.slug!);
  const result = await fn(wt.path, ["checkout", "-B", branch], { ignoreFailure: true });
  if (result.code !== 0) return { ok: false, stderr: result.stderr };
  return { ok: true };
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
   *  caller can report partial success rather than silently claiming removal.
   *  resolvedPath overrides the computed path so linked-launch sweeps remove
   *  the correct sibling path rather than one derived from cfg.repo_dir. */
  removeWorktree: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    pathOnDisk: boolean,
    resolvedPath?: string,
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
  resolvedPath?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const wtPath = resolvedPath ?? worktreePath(cfg, issueNumber, slug);
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

  // Use underManagedRoot when set by parseWorktreePorcelain (real discovery path)
  // so that linked-launch sweeps use the canonical root rather than one derived
  // from cfg.repo_dir (which would be /linked-wt/.worktrees — non-existent).
  // When underManagedRoot is not set (test-injected records), fall back to the
  // cfg.repo_dir path check for backwards compatibility with existing tests.
  const candidates = onDisk.filter((rec) => {
    if (rec.underManagedRoot !== undefined) return rec.underManagedRoot;
    const root = path.resolve(cfg.repo_dir, cfg.worktree_root);
    return rec.path === root || rec.path.startsWith(root + path.sep);
  });

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
      const result = await d.removeWorktree(cfg, rec.issueNumber, rec.slug, false, rec.path);
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

    const result = await d.removeWorktree(cfg, rec.issueNumber, rec.slug, true, rec.path);
    if (result.ok) {
      removed.push(rec);
    } else {
      skipped.push({ rec, reason: `removal failed: ${result.reason}` });
    }
  }

  return { removed, skipped };
}
