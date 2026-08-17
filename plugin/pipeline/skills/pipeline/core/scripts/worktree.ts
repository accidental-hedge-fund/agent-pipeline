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

/** Derive the set of pipeline-managed worktree roots from `git worktree list
 *  --porcelain` output: one `path.resolve(<checkout>, worktreeRoot)` per
 *  registered checkout (`worktree <path>` line), de-duplicated. This listing
 *  is common-dir-wide, so it is identical regardless of which linked checkout
 *  invoked `git`, and the resulting root set is therefore independent of
 *  which checkout is `cfg.repo_dir` (#472). An absolute `worktreeRoot`
 *  resolves to itself for every checkout, so the set collapses to one root.
 *
 *  Pure (no I/O) so it is unit-testable without real git. */
export function resolveManagedRoots(porcelainStdout: string, worktreeRoot: string): string[] {
  const roots = new Set<string>();
  for (const line of porcelainStdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const checkout = line.slice("worktree ".length).trim();
      roots.add(path.resolve(checkout, worktreeRoot));
    }
  }
  return [...roots];
}

/** Parse `git worktree list --porcelain` output into pipeline worktree records.
 *
 *  A worktree is identified by issue + slug from its `pipeline/<N>-<slug>`
 *  branch when it is checked out on that branch. When it is **off its branch**
 *  — git emits no `branch` line for a detached HEAD, which happens while a
 *  stage checks out a specific SHA inside the worktree (e.g. the review→fix
 *  handoff) — we fall back to deriving the identity from the on-disk directory
 *  name `pipeline-<N>-<slug>` under one of the configured worktree roots.
 *  Without that fallback a present, git-registered worktree is invisible the
 *  moment it is not on its branch, so the fix stage's {@link getForIssue}
 *  falsely reports "No worktree found" and blocks a converging run (#223).
 *
 *  `worktreeRoots` accepts either a single root (legacy call sites) or the
 *  full managed-root set from {@link resolveManagedRoots} — a record is
 *  `underManagedRoot: true` when its parent directory equals ANY root in the
 *  set, so a worktree created under a linked checkout's root is recognized
 *  regardless of which checkout is doing the listing (#472).
 *
 *  Pure (no I/O) so the parsing + matching is unit-testable without real git. */
export function parseWorktreePorcelain(
  stdout: string,
  worktreeRoots: string | string[],
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

  const roots = new Set(
    (Array.isArray(worktreeRoots) ? worktreeRoots : [worktreeRoots]).map((r) => path.resolve(r)),
  );
  const pipelineRecords: WorktreeRecord[] = [];
  for (const rec of records) {
    let issueNumber: number | undefined;
    let slug: string | undefined;
    const parentDir = path.resolve(path.dirname(rec.path));
    const underRoot = roots.has(parentDir);

    // Prefer the branch when the worktree is on its pipeline branch.
    const branchMatch = rec.branch?.startsWith("pipeline/")
      ? rec.branch.slice("pipeline/".length).match(/^(\d+)-(.+)$/)
      : null;
    if (branchMatch) {
      issueNumber = Number.parseInt(branchMatch[1], 10);
      slug = branchMatch[2];
    } else if (rec.branch === undefined && underRoot) {
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
      // Mark whether the path is directly under any managed worktree root so
      // callers can guard destructive operations (reclaim, sweep, removal) to
      // managed paths without recomputing a single root from cfg.repo_dir
      // (wrong for linked launches, and wrong across linked checkouts).
      rec.underManagedRoot = underRoot;
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
  // Resolve managed roots from EVERY registered checkout, not just the main
  // one — this listing is common-dir-wide, so it is identical from any linked
  // checkout, and a worktree created under a different linked checkout's root
  // is therefore still recognized as managed (#472; previously #223 fixed
  // only the "launched from a linked worktree" half of this).
  const roots = resolveManagedRoots(stdout, cfg.worktree_root);
  return parseWorktreePorcelain(stdout, roots);
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

export interface GetOnDiskForIssueDeps {
  listOnDisk?: (cfg: PipelineConfig, deps?: ListOnDiskDeps) => Promise<WorktreeRecord[]>;
}

/** Fast path: resolve a worktree path for a known issue by reading on-disk
 *  records only — zero GitHub API calls. Use this instead of {@link getForIssue}
 *  for bookkeeping callers that only need the path, not active-state filtering.
 *  Returns null if no on-disk record exists for the issue. */
export async function getOnDiskForIssue(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: GetOnDiskForIssueDeps = {},
): Promise<{ path: string; slug: string } | null> {
  const listFn = deps.listOnDisk ?? listOnDisk;
  for (const rec of await listFn(cfg)) {
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
  /** Random fraction in [0, 1) used to jitter the fetch retry backoff
   *  (injectable so tests are deterministic; defaults to Math.random). */
  jitter?: () => number;
  /** Write `node_modules` to `.git/info/exclude` inside the worktree (idempotent). */
  writeNodeModulesExclude?: (worktreePath: string) => Promise<void>;
  /** Return lstat of the given path, or null if ENOENT. */
  lstatPath?: (p: string) => Promise<{ isSymbolicLink(): boolean } | null>;
  /** Remove the file or symlink at the given path. */
  unlinkPath?: (p: string) => Promise<void>;
  /** Stamp the worktree as pipeline-owned (see {@link writeManagedMarker}). */
  writeManagedMarker?: (worktreePath: string) => Promise<void>;
  /** Dirty-workdir check used before create-time reclaim (#622). */
  hasDirtyWorkdir?: (worktreePath: string) => Promise<boolean>;
  /** Local-only (unpushed) commit check used before create-time reclaim (#622).
   *  Same tier results as {@link RemoveWorktreeDeps.hasLocalOnlyCommits}. */
  hasLocalOnlyCommits?: (
    cfg: PipelineConfig,
    worktreePath: string | null,
    branch: string,
  ) => Promise<boolean | "unverifiable" | null>;
  /**
   * When the pipeline branch has no remote tip (e.g. remote branch deleted while
   * an open PR remains), resolve that PR's head SHA so resume after park-release
   * can recreate at the PR head rather than from base (#718 review ac32c448).
   */
  resolveOpenPrHeadForBranch?: (
    cfg: PipelineConfig,
    branch: string,
  ) => Promise<{ prNumber: number; headSha: string } | null>;
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

/** Resolve the per-worktree Git admin directory (`<commondir>/worktrees/<name>`
 *  for a linked worktree, or the `.git` directory itself for the main
 *  checkout). Distinct from the COMMON git dir resolved in
 *  {@link realWriteNodeModulesExclude} — this is unique per worktree, which is
 *  what makes it a suitable home for a per-worktree ownership marker: it lives
 *  outside the working tree (invisible to `git status`) and is deleted
 *  automatically when the worktree is deregistered. Returns null when the
 *  worktree directory (and therefore its `.git` marker) is already gone. */
async function resolvePerWorktreeGitDir(worktreePath: string): Promise<string | null> {
  const gitMarker = path.join(worktreePath, ".git");
  const stat = await fs.promises.stat(gitMarker).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (stat === null) return null;
  if (stat.isFile()) {
    const content = await fs.promises.readFile(gitMarker, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error(`Malformed .git file at ${gitMarker}: ${content.slice(0, 80)}`);
    return path.resolve(worktreePath, match[1].trim());
  }
  return gitMarker;
}

const PIPELINE_MANAGED_MARKER_FILE = "pipeline-managed";

/** Stamp `worktreePath` as created by `createWorktree`, so a later removal
 *  from a *different* linked checkout (#472) can verify the worktree is
 *  actually pipeline-owned rather than merely sitting under a Git-registered
 *  checkout's `.worktrees` directory by coincidence (review-2 finding
 *  578ebd21: registration + path placement + branch naming do not by
 *  themselves establish that Pipeline created a worktree). */
export async function writeManagedMarker(worktreePath: string): Promise<void> {
  const gitDir = await resolvePerWorktreeGitDir(worktreePath);
  if (gitDir === null) return;
  await fs.promises.writeFile(path.join(gitDir, PIPELINE_MANAGED_MARKER_FILE), "");
}

/** Check the marker written by {@link writeManagedMarker}. */
export async function hasManagedMarker(worktreePath: string): Promise<boolean> {
  const gitDir = await resolvePerWorktreeGitDir(worktreePath);
  if (gitDir === null) return false;
  return fs.existsSync(path.join(gitDir, PIPELINE_MANAGED_MARKER_FILE));
}

/** Resolve the exact on-disk marker path for a worktree, for the explicit
 *  operator adoption hint in cross-checkout refusals (#472 delta 38f7a75e).
 *  Null when the per-worktree git dir cannot be resolved. */
export async function managedMarkerPath(worktreePath: string): Promise<string | null> {
  const gitDir = await resolvePerWorktreeGitDir(worktreePath);
  if (gitDir === null) return null;
  return path.join(gitDir, PIPELINE_MANAGED_MARKER_FILE);
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

// ---------------------------------------------------------------------------
// Worktree capacity error (#718) — machine-distinguishable admission failure
// ---------------------------------------------------------------------------

/** Stable identity string for pure worktree capacity refusals. */
export const WORKTREE_CAPACITY_ERROR_CODE = "worktree-capacity" as const;

/** Message prefix thrown by {@link createWorktree} when other-active worktrees
 *  are at `max_concurrent_worktrees`. Distinct from dirty-reclaim and git-add
 *  failures so admission disposition can route capacity as ops, not product. */
export const WORKTREE_CAPACITY_MESSAGE_PREFIX = "At worktree capacity";

/**
 * Typed capacity refusal from {@link createWorktree}. Prefer
 * {@link isWorktreeCapacityError} over free-text scraping.
 */
export class WorktreeCapacityError extends Error {
  readonly code = WORKTREE_CAPACITY_ERROR_CODE;
  readonly otherActive: number;
  readonly maxConcurrent: number;

  constructor(otherActive: number, maxConcurrent: number) {
    super(
      `${WORKTREE_CAPACITY_MESSAGE_PREFIX} (${otherActive}/${maxConcurrent}). ` +
        "Wait for an issue to complete before starting new work.",
    );
    this.name = "WorktreeCapacityError";
    this.otherActive = otherActive;
    this.maxConcurrent = maxConcurrent;
  }
}

/** True when `err` is a pure worktree capacity admission failure (#718). */
export function isWorktreeCapacityError(err: unknown): err is WorktreeCapacityError {
  if (err instanceof WorktreeCapacityError) return true;
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (code === WORKTREE_CAPACITY_ERROR_CODE) return true;
  }
  // Message-prefix fallback for deps/fakes that throw plain Errors with the
  // stable prefix (tests and older call sites).
  if (err instanceof Error && err.message.startsWith(WORKTREE_CAPACITY_MESSAGE_PREFIX)) {
    return true;
  }
  return false;
}

export async function createWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  deps: CreateWorktreeDeps = {},
): Promise<{ path: string; branch: string }> {
  const existsFn = deps.existsSync ?? fs.existsSync;
  // Injected remove seam (tests) OR race-safe default — never the force-delete
  // removeWorktree used by terminal deploy/auto_recover paths (#622 review-2).
  const removeFn = deps.removeWorktree;
  const listActiveFn = deps.listActive ?? listActive;
  const mkdirFn = deps.mkdirSync ?? ((p: string, opts: { recursive: boolean }) => { fs.mkdirSync(p, opts); });
  const gitFn = deps.gitCmd ?? git;
  const resolveGitCommonDirFn = deps.resolveGitCommonDir ?? realResolveGitCommonDir;
  const acquireMutexFn = deps.acquireMutex ?? ((p: string) => acquireWorktreeMutex(p));
  const releaseMutexFn = deps.releaseMutex ?? releaseWorktreeMutex;
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitterFn = deps.jitter ?? Math.random;
  const writeNodeModulesExcludeFn = deps.writeNodeModulesExclude ?? realWriteNodeModulesExclude;
  const lstatPathFn = deps.lstatPath ?? realLstatPath;
  const unlinkPathFn = deps.unlinkPath ?? realUnlinkPath;
  const writeManagedMarkerFn = deps.writeManagedMarker ?? writeManagedMarker;
  const dirtyFn = deps.hasDirtyWorkdir ?? hasDirtyWorkdir;
  const localOnlyFn = deps.hasLocalOnlyCommits ?? checkLocalOnlyCommits;
  const resolveOpenPrHeadFn = deps.resolveOpenPrHeadForBranch ?? resolveOpenPrHeadForBranch;

  const wtPath = worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);

  type ReclaimCandidate = {
    path: string;
    branch: string;
    slug: string;
    /** Discovered path for linked-launch remove; undefined for collision-only. */
    resolvedPath?: string;
    /** Branch tip captured at preflight; null when no local branch ref exists. */
    expectedBranchOid: string | null;
  };

  /** Apply operator-remove safety without force before any reclaim mutation (#622).
   *  Routes through worktree lifecycle reconcile then evaluateRemoveSafety (#759).
   *  Throws a clear error and never mutates on a blocking result. */
  async function assertReclaimSafe(candidatePath: string, candidateBranch: string): Promise<void> {
    // Lazy import avoids circular init: reconcile-and-converge imports evaluateRemoveSafety from this module.
    const { reconcileWorktreeLifecycle } = await import("./reconcile-and-converge.ts");
    const pathOnDisk = existsFn(candidatePath);
    let dirty = false;
    if (pathOnDisk) {
      dirty = await dirtyFn(candidatePath);
    }
    const localOnly = await localOnlyFn(cfg, pathOnDisk ? candidatePath : null, candidateBranch);
    const reconciled = reconcileWorktreeLifecycle({
      required: true,
      managedPresent: true,
      pathExists: pathOnDisk,
      dirty,
      localOnly,
      actualBranch: candidateBranch,
      force: false,
    });
    if (
      reconciled.actions.some(
        (a) => a.kind === "refuse_unsafe_remove" || a.kind === "fail_closed",
      )
    ) {
      const reason =
        reconciled.removeSafety && !reconciled.removeSafety.ok
          ? reconciled.removeSafety.error
          : reconciled.actions[0]?.reason ?? "reclaim refused by worktree reconcile";
      throw new Error(
        `Cannot reclaim worktree for issue #${issueNumber} at ${candidatePath} ` +
          `(branch ${candidateBranch}): ${reason}`,
      );
    }
    const safety = evaluateRemoveSafety({ dirty, localOnly, force: false });
    if (!safety.ok) {
      throw new Error(
        `Cannot reclaim worktree for issue #${issueNumber} at ${candidatePath} ` +
          `(branch ${candidateBranch}): ${safety.error}`,
      );
    }
  }

  /** Resolve local branch tip OID, or null when the ref is missing. */
  async function resolveBranchOid(candidateBranch: string): Promise<string | null> {
    const r = await gitFn(
      cfg,
      cfg.repo_dir,
      ["rev-parse", "--verify", `refs/heads/${candidateBranch}`],
      { ignoreFailure: true },
    );
    if (r.code !== 0) return null;
    const oid = r.stdout.trim();
    return oid.length > 0 ? oid : null;
  }

  /**
   * Race-safe reclaim mutation (#622 review-2 finding c0028d2d):
   *  - non-force `git worktree remove` so a late dirty edit refuses deletion
   *  - compare-and-delete branch via `git update-ref -d` with the preflight OID
   *    so a tip that moved after safety checks is not force-deleted
   * Throws on any failure so a refused reclaim does not silently discard work.
   */
  async function raceSafeReclaimRemove(candidate: ReclaimCandidate): Promise<void> {
    const candidatePath = candidate.resolvedPath ?? candidate.path;
    if (existsFn(candidatePath)) {
      const rm = await gitFn(
        cfg,
        cfg.repo_dir,
        ["worktree", "remove", candidatePath],
        { ignoreFailure: true },
      );
      if (rm.code !== 0) {
        throw new Error(
          `Cannot reclaim worktree for issue #${issueNumber} at ${candidatePath} ` +
            `(branch ${candidate.branch}): worktree remove refused ` +
            `(possible late dirty changes): ${rm.stderr.trim()}`,
        );
      }
    }
    if (candidate.expectedBranchOid !== null) {
      const del = await gitFn(
        cfg,
        cfg.repo_dir,
        ["update-ref", "-d", `refs/heads/${candidate.branch}`, candidate.expectedBranchOid],
        { ignoreFailure: true },
      );
      if (del.code !== 0) {
        throw new Error(
          `Cannot reclaim worktree for issue #${issueNumber} at ${candidatePath} ` +
            `(branch ${candidate.branch}): branch tip changed since safety check ` +
            `(refusing branch delete): ${del.stderr.trim()}`,
        );
      }
    }
  }

  async function performReclaim(candidate: ReclaimCandidate): Promise<void> {
    // Revalidate immediately before mutation so a stale preflight verdict cannot
    // authorize force-like discard of work created after the check.
    await assertReclaimSafe(candidate.path, candidate.branch);
    if (candidate.expectedBranchOid !== null) {
      const currentOid = await resolveBranchOid(candidate.branch);
      if (currentOid !== candidate.expectedBranchOid) {
        throw new Error(
          `Cannot reclaim worktree for issue #${issueNumber} at ${candidate.path} ` +
            `(branch ${candidate.branch}): branch tip changed since safety check ` +
            `(refusing reclaim)`,
        );
      }
    }
    if (removeFn) {
      await removeFn(cfg, issueNumber, candidate.slug, candidate.resolvedPath);
    } else {
      await raceSafeReclaimRemove(candidate);
    }
  }

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
  //
  // Reclaim is never silent force-delete (#622): dirty workdirs and blocking
  // local-only tiers refuse with a clear error (same ladder as operator remove
  // without --force). Clean candidates may still be removed so create proceeds.
  //
  // Preflight ALL candidates before ANY mutation (#622 review-2 finding 37cc1885)
  // so a later unsafe candidate cannot leave earlier clean worktrees already
  // destroyed. Mutation uses non-force remove + OID-gated branch delete.
  const active = await listActiveFn(cfg);
  const mine = active.filter((r) => r.issueNumber === issueNumber && r.slug);

  const reclaimCandidates: ReclaimCandidate[] = [];
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
    const recBranch = rec.branch ?? branchName(issueNumber, rec.slug!);
    await assertReclaimSafe(rec.path, recBranch);
    // Pass rec.path so removal targets the discovered path directly, not a path
    // recomputed from cfg.repo_dir (which is wrong when launched from a linked worktree).
    reclaimCandidates.push({
      path: rec.path,
      branch: recBranch,
      slug: rec.slug!,
      resolvedPath: rec.path,
      expectedBranchOid: await resolveBranchOid(recBranch),
    });
  }
  // Also clear any directory left at the *current* slug path that listActive did
  // not classify as active (e.g. a closed/terminal lookup) so the
  // `git worktree add` below cannot collide with it. Same safety gates as above.
  if (existsFn(wtPath) && !mine.some((r) => r.slug === slug)) {
    await assertReclaimSafe(wtPath, branch);
    reclaimCandidates.push({
      path: wtPath,
      branch,
      slug,
      expectedBranchOid: await resolveBranchOid(branch),
    });
  }

  // Mutations only after every candidate passed preflight.
  for (const candidate of reclaimCandidates) {
    await performReclaim(candidate);
  }

  const otherActive = active.filter((r) => r.issueNumber !== issueNumber).length;
  if (otherActive >= cfg.max_concurrent_worktrees) {
    throw new WorktreeCapacityError(otherActive, cfg.max_concurrent_worktrees);
  }

  // Ensure the worktree root exists.
  mkdirFn(worktreeRoot(cfg), { recursive: true });

  // Serialize the base-branch fetch and git worktree add across concurrent
  // pipeline instances in the same repo. The mutex critical section covers
  // the fetch (#402) as well as the pre-add stale-branch cleanup and
  // `git worktree add` (#183) — two overlapping fetches of the same repo can
  // otherwise race on the refs/remotes/origin/<base> ref lock, blocking
  // whichever run loses the race. The mutex is held only for the duration of
  // these subprocess calls so it never blocks unrelated pipeline work.
  //
  // The mutex is keyed on the canonical Git common directory (not cfg.repo_dir)
  // so two runs from different linked worktrees of the same repo share one
  // mutex even though their cfg.repo_dir paths differ.
  const commonDir = await resolveGitCommonDirFn(cfg.repo_dir);
  const mutexPath = worktreeMutexPath(commonDir);

  // Wait up to 150 s (60 s fetch subprocess timeout + 60 s add subprocess
  // timeout + 30 s margin) so a live holder that is mid-fetch-then-add
  // cannot outlast the wait.
  const MUTEX_POLL_MS = 200;
  const MUTEX_TIMEOUT_MS = 150_000;
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
    // Fetch the latest base branch, retrying on transient ref-lock contention
    // (#402) left by a git process the mutex cannot coordinate with — e.g. a
    // developer's manual `git fetch` or a lock left by a crashed pipeline git.
    // The mutex above is the primary defense; this retry is belt-and-suspenders,
    // scoped strictly to the ref-lock signature so auth/network/missing-remote
    // failures still throw immediately.
    const FETCH_MAX_ATTEMPTS = 4;
    let lastFetchStderr = "";
    let fetched = false;
    for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleepFn(200 * 2 ** (attempt - 1) + jitterFn() * 200); // 200-400ms, 400-600ms, 800-1000ms
      }
      const { code, stderr } = await gitFn(
        cfg,
        cfg.repo_dir,
        ["fetch", "origin", cfg.base_branch],
        { ignoreFailure: true },
      );
      if (code === 0) {
        fetched = true;
        break;
      }
      lastFetchStderr = stderr;
      if (!stderr.includes("cannot lock ref") && !stderr.includes("unable to update local ref")) {
        throw new Error(`git fetch origin ${cfg.base_branch} failed: ${lastFetchStderr.trim()}`);
      }
    }
    if (!fetched) {
      throw new Error(`git fetch origin ${cfg.base_branch} failed: ${lastFetchStderr.trim()}`);
    }

    // Prefer an existing remote tip for this pipeline branch when present so
    // resume after park-release (#718) recreates the worktree at the pushed
    // head rather than discarding remote commits by branching from base.
    // When the remote branch is gone but an open PR remains, recover from the
    // PR head SHA (fetch pull/N/head) so park-release's open-PR recoverability
    // is reconstructible at create time (#718 review ac32c448).
    const lsRemote = await gitFn(
      cfg,
      cfg.repo_dir,
      ["ls-remote", "origin", `refs/heads/${branch}`],
      { ignoreFailure: true },
    );
    const remoteTip =
      lsRemote.code === 0 && (lsRemote.stdout.trim().split(/\s+/)[0] ?? "").length > 0
        ? lsRemote.stdout.trim().split(/\s+/)[0]!
        : null;
    let startPoint = `origin/${cfg.base_branch}`;
    if (remoteTip) {
      // Populate the remote-tracking ref so worktree add can start from the
      // verified ls-remote tip. Fetch MUST succeed and origin/<branch> MUST
      // resolve to that tip — a failed fetch must not fall through to a
      // pre-existing stale remote-tracking ref (#718 review 9ab37b7c).
      const fetchBranch = await gitFn(
        cfg,
        cfg.repo_dir,
        ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`],
        { ignoreFailure: true },
      );
      if (fetchBranch.code !== 0) {
        throw new Error(
          `git fetch origin ${branch} failed (cannot recreate worktree at verified remote tip): ${fetchBranch.stderr.trim()}`,
        );
      }
      const localRef = await gitFn(
        cfg,
        cfg.repo_dir,
        ["rev-parse", `refs/remotes/origin/${branch}`],
        { ignoreFailure: true },
      );
      const localSha = localRef.stdout.trim();
      if (localRef.code !== 0 || localSha !== remoteTip) {
        throw new Error(
          `origin/${branch} does not match remote tip ${remoteTip} after fetch ` +
            `(got ${localSha || "missing"}); refusing stale startPoint for worktree recreate`,
        );
      }
      startPoint = `origin/${branch}`;
    } else {
      const prHead = await resolveOpenPrHeadFn(cfg, branch);
      if (prHead && prHead.headSha.length > 0) {
        // Fetch the PR head ref so the commit object is local even when the
        // named branch was deleted on the remote.
        const fetchPr = await gitFn(
          cfg,
          cfg.repo_dir,
          ["fetch", "origin", `pull/${prHead.prNumber}/head:refs/remotes/origin/${branch}`],
          { ignoreFailure: true },
        );
        if (fetchPr.code === 0) {
          startPoint = `origin/${branch}`;
        } else {
          // Fallback: fetch by SHA (may already be reachable) and start there.
          await gitFn(cfg, cfg.repo_dir, ["fetch", "origin", prHead.headSha], {
            ignoreFailure: true,
          });
          startPoint = prHead.headSha;
        }
      }
    }

    // If the branch exists from a prior failed attempt, delete it.
    await gitFn(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });

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
        ["worktree", "add", wtPath, "-b", branch, startPoint],
        { ignoreFailure: true },
      );
      if (code === 0) {
        // Bootstrap: write node_modules to .git/info/exclude so `git add` never
        // stages a node_modules entry regardless of type (dir, symlink, file).
        await writeNodeModulesExcludeFn(wtPath);
        // Stamp ownership so a cross-checkout removal (#472) can prove this
        // worktree was actually created by the pipeline (review-2 finding 578ebd21).
        await writeManagedMarkerFn(wtPath);
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

/**
 * Result of {@link removeManagedWorktreeSafely} — production stages that
 * historically force-removed without the ladder (#759 / #622) go through this
 * single wrapper so every path evaluates `evaluateRemoveSafety` once.
 */
export type SafeRemoveResult =
  | { removed: true; path: string; branch: string }
  | {
      removed: false;
      reason: string;
      path?: string;
      branch?: string;
      blockReason?: "local-only" | "unverifiable" | "verification-failed" | "dirty";
    };

export interface SafeRemoveDeps {
  hasDirtyWorkdir?: (wtPath: string) => Promise<boolean>;
  hasLocalOnlyCommits?: (
    cfg: PipelineConfig,
    wtPath: string | null,
    branch: string,
  ) => Promise<LocalOnlyCommitResult>;
  pathExists?: (p: string) => boolean;
  removeWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    resolvedPath?: string,
  ) => Promise<void>;
  /**
   * When true, dirty trees may be force-removed if local-only is clean.
   * Default false. Terminal deploy_ready may pass true only with a written
   * site comment documenting why force is acceptable.
   */
  force?: boolean;
}

/**
 * Single shared remove wrapper: evaluate `evaluateRemoveSafety` once, then
 * mutate only when ok. Call sites in auto_recover / deploy_ready / park release
 * should prefer this over bare `removeWorktree` (#759).
 */
export async function removeManagedWorktreeSafely(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  resolvedPath?: string,
  deps: SafeRemoveDeps = {},
): Promise<SafeRemoveResult> {
  const dirtyFn = deps.hasDirtyWorkdir ?? hasDirtyWorkdir;
  const localOnlyFn = deps.hasLocalOnlyCommits ?? checkLocalOnlyCommits;
  const existsFn = deps.pathExists ?? fs.existsSync;
  const removeFn = deps.removeWorktree ?? removeWorktree;
  const force = !!deps.force;
  const wtPath = resolvedPath ?? worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);
  const pathOnDisk = existsFn(wtPath);
  let dirty = false;
  if (pathOnDisk) {
    dirty = await dirtyFn(wtPath);
  }
  const localOnly = await localOnlyFn(cfg, pathOnDisk ? wtPath : null, branch);
  const safety = evaluateRemoveSafety({ dirty, localOnly, force });
  if (!safety.ok) {
    return {
      removed: false,
      reason: safety.error,
      path: wtPath,
      branch,
      blockReason: safety.blockReason,
    };
  }
  await removeFn(cfg, issueNumber, slug, resolvedPath);
  return { removed: true, path: wtPath, branch };
}

export interface CreateWorktreeAtDeps {
  existsSync?: (p: string) => boolean;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  gitCmd?: (
    cfg: PipelineConfig,
    cwd: string,
    args: string[],
    opts?: { ignoreFailure?: boolean; timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  resolveGitCommonDir?: (repoDir: string) => Promise<string>;
  acquireMutex?: (path: string) => void;
  releaseMutex?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
  writeNodeModulesExclude?: (worktreePath: string) => Promise<void>;
}

/** Create a worktree at an explicit path/branch, checked out at an arbitrary
 *  base commit rather than at `origin/<base_branch>` HEAD. Used by the eval
 *  runner (core/scripts/evals/) to isolate one experiment cell per fixture's
 *  frozen `base_commit`. Deliberately does not carry createWorktree's
 *  issue-capacity/reclaim logic — eval cells are not tracked per-issue and
 *  each gets a unique path, so there is nothing to reclaim. */
export async function createWorktreeAt(
  cfg: PipelineConfig,
  opts: { path: string; branch: string; baseCommit: string },
  deps: CreateWorktreeAtDeps = {},
): Promise<{ path: string; branch: string }> {
  const existsFn = deps.existsSync ?? fs.existsSync;
  const mkdirFn = deps.mkdirSync ?? ((p: string, o: { recursive: boolean }) => { fs.mkdirSync(p, o); });
  const gitFn = deps.gitCmd ?? git;
  const resolveGitCommonDirFn = deps.resolveGitCommonDir ?? realResolveGitCommonDir;
  const acquireMutexFn = deps.acquireMutex ?? ((p: string) => acquireWorktreeMutex(p));
  const releaseMutexFn = deps.releaseMutex ?? releaseWorktreeMutex;
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const writeNodeModulesExcludeFn = deps.writeNodeModulesExclude ?? realWriteNodeModulesExclude;

  const { path: wtPath, branch, baseCommit } = opts;
  if (existsFn(wtPath)) {
    throw new Error(`Eval worktree path already exists: ${wtPath}`);
  }
  mkdirFn(path.dirname(wtPath), { recursive: true });

  const commonDir = await resolveGitCommonDirFn(cfg.repo_dir);
  const mutexPath = worktreeMutexPath(commonDir);

  const MUTEX_POLL_MS = 200;
  const MUTEX_TIMEOUT_MS = 150_000;
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
    await gitFn(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });
    const { code, stderr } = await gitFn(
      cfg,
      cfg.repo_dir,
      ["worktree", "add", wtPath, "-b", branch, baseCommit],
      { ignoreFailure: true },
    );
    if (code !== 0) {
      throw new Error(`git worktree add failed: ${stderr.trim()}`);
    }
    await writeNodeModulesExcludeFn(wtPath);
    return { path: wtPath, branch };
  } finally {
    releaseMutexFn(mutexPath);
  }
}

/** Remove a worktree created by createWorktreeAt, scoped strictly to the
 *  given path/branch (never resolved from an issue number). */
export async function removeWorktreeAt(
  cfg: PipelineConfig,
  opts: { path: string; branch: string },
  deps: { existsSync?: (p: string) => boolean; gitCmd?: typeof git } = {},
): Promise<void> {
  const existsFn = deps.existsSync ?? fs.existsSync;
  const gitFn = deps.gitCmd ?? git;
  if (existsFn(opts.path)) {
    await gitFn(cfg, cfg.repo_dir, ["worktree", "remove", opts.path, "--force"], { ignoreFailure: true });
  }
  await gitFn(cfg, cfg.repo_dir, ["branch", "-D", opts.branch], { ignoreFailure: true });
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
  opts: { ignoreFailure?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 50 * 1024 * 1024,
      // Forward child env when provided (e.g. HTTPS-token askpass from
      // runConfiguredGitPush). Omit when unset so process.env is inherited.
      ...(opts.env ? { env: opts.env } : {}),
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

// ---------------------------------------------------------------------------
// ensureManagedWorktree — rematerialize missing managed worktree (#769)
// ---------------------------------------------------------------------------

/** Stable gate id for durable rematerialize evidence (dogfood greps). */
export const WORKTREE_REMATERIALIZE_GATE = "worktree-rematerialize" as const;

/** Result of {@link ensureManagedWorktree}. Fixed contract for all call sites. */
export type EnsureManagedWorktreeResult =
  | {
      result: "pass";
      worktree: { path: string; slug: string; branch: string };
      reason: string;
      blockerKind?: undefined;
    }
  | {
      result: "skipped";
      worktree: { path: string; slug: string; branch?: string };
      reason: string;
      blockerKind?: undefined;
    }
  | {
      result: "fail";
      worktree: null;
      reason: string;
      blockerKind: "worktree-creation-failed" | "worktree-capacity" | "worktree-missing";
    };

/** Injectable deps for {@link ensureManagedWorktree}. No real network/git in tests. */
export interface EnsureManagedWorktreeDeps {
  getOnDiskForIssue?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ path: string; slug: string } | null>;
  createWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    createDeps?: CreateWorktreeDeps,
  ) => Promise<{ path: string; branch: string }>;
  /**
   * Remove a just-created mismatched worktree after post-create HEAD verification
   * fails (#769 review-2). Defaults to {@link removeWorktree}. Callers/tests inject
   * fakes; production path is scoped to the managed worktree root only.
   */
  removeWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    resolvedPath?: string,
  ) => Promise<void>;
  /** Issue title for slugify (defaults to getIssueDetail). */
  getIssueTitle?: (cfg: PipelineConfig, issueNumber: number) => Promise<string>;
  gitCmd?: CreateWorktreeDeps["gitCmd"];
  resolveOpenPrHeadForBranch?: CreateWorktreeDeps["resolveOpenPrHeadForBranch"];
  gitInWorktree?: typeof gitInWorktree;
  /** Extra create deps forwarded into createWorktree (reclaim fakes, etc.). */
  createWorktreeDeps?: CreateWorktreeDeps;
  /** When set, always append gate_result for pass/fail/skipped. */
  runDir?: string;
  runStoreDeps?: import("./run-store.ts").RunStoreDeps;
  /** Path existence check used after HEAD-mismatch cleanup (defaults to fs.existsSync). */
  existsSync?: (p: string) => boolean;
}

const REMATERIALIZE_REASON_MAX = 400;

function boundRematerializeReason(reason: string): string {
  const t = reason.replace(/\s+/g, " ").trim();
  if (t.length <= REMATERIALIZE_REASON_MAX) return t;
  return t.slice(0, REMATERIALIZE_REASON_MAX - 1) + "…";
}

async function recordRematerializeGate(
  deps: EnsureManagedWorktreeDeps,
  result: "pass" | "fail" | "skipped",
  reason: string,
): Promise<void> {
  if (!deps.runDir) return;
  try {
    const { appendEvent, RUN_SCHEMA_VERSION } = await import("./run-store.ts");
    await appendEvent(
      deps.runDir,
      {
        schema_version: RUN_SCHEMA_VERSION,
        type: "gate_result",
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        gate: WORKTREE_REMATERIALIZE_GATE,
        result,
        reason: boundRematerializeReason(reason),
      },
      deps.runStoreDeps,
    );
  } catch {
    // Best-effort: durable evidence must not change control flow.
  }
}

async function defaultGetIssueTitle(cfg: PipelineConfig, issueNumber: number): Promise<string> {
  const { getIssueDetail } = await import("./gh.ts");
  const detail = await getIssueDetail(cfg, issueNumber);
  return detail.title ?? "";
}

/** True when `candidatePath` resolves strictly under this checkout's managed
 *  worktree root (`<repo_dir>/<worktree_root>/…`). Used to scope destructive
 *  cleanup after post-create HEAD mismatch so remove never targets paths
 *  outside the managed root. */
function isUnderManagedWorktreeRoot(cfg: PipelineConfig, candidatePath: string): boolean {
  const root = worktreeRoot(cfg);
  const resolved = path.resolve(candidatePath);
  const rel = path.relative(root, resolved);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Ensure a managed on-disk worktree exists for the issue before a stage that
 * requires one (OpenSpec archive, pre-merge autofix, fix write path) (#769).
 *
 * - On-disk path present → `skipped` (no force recreate).
 * - Absent / stale metadata without path → rematerialize via {@link createWorktree}
 *   (same startPoint + #622 reclaim safety), then verify HEAD vs open-PR head
 *   SHA (or verified remote tip).
 * - Post-create HEAD mismatch → remove/quarantine the just-created managed
 *   path before returning fail, so a later getOnDiskForIssue cannot treat the
 *   mismatched tree as a valid present worktree (#769 review-2).
 * - Failures map to typed `blockerKind`s; when `runDir` is set, always records
 *   a `gate_result` with gate `worktree-rematerialize`.
 */
export async function ensureManagedWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: EnsureManagedWorktreeDeps = {},
): Promise<EnsureManagedWorktreeResult> {
  const getOnDiskFn = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const createFn = deps.createWorktree ?? createWorktree;
  const removeFn = deps.removeWorktree ?? removeWorktree;
  const getTitleFn = deps.getIssueTitle ?? defaultGetIssueTitle;
  const gitFn = deps.gitCmd ?? git;
  const resolveOpenPrHeadFn = deps.resolveOpenPrHeadForBranch ?? resolveOpenPrHeadForBranch;
  const gitWtFn = deps.gitInWorktree ?? gitInWorktree;
  const existsFn = deps.existsSync ?? ((p: string) => fs.existsSync(p));

  const existing = await getOnDiskFn(cfg, issueNumber);
  if (existing) {
    const reason = "already-present";
    await recordRematerializeGate(deps, "skipped", reason);
    return {
      result: "skipped",
      worktree: {
        path: existing.path,
        slug: existing.slug,
        branch: branchName(issueNumber, existing.slug),
      },
      reason,
    };
  }

  let title: string;
  try {
    title = await getTitleFn(cfg, issueNumber);
  } catch (err) {
    const reason = boundRematerializeReason(
      `cannot resolve issue title for rematerialize: ${(err as Error).message ?? String(err)}`,
    );
    await recordRematerializeGate(deps, "fail", reason);
    return { result: "fail", worktree: null, reason, blockerKind: "worktree-missing" };
  }
  const slug = slugify(title) || `issue-${issueNumber}`;
  const branch = branchName(issueNumber, slug);

  // Recoverability pre-check: do not create from base alone when rematerializing.
  const lsRemote = await gitFn(
    cfg,
    cfg.repo_dir,
    ["ls-remote", "origin", `refs/heads/${branch}`],
    { ignoreFailure: true },
  );
  const remoteTip =
    lsRemote.code === 0 && (lsRemote.stdout.trim().split(/\s+/)[0] ?? "").length > 0
      ? lsRemote.stdout.trim().split(/\s+/)[0]!
      : null;

  let prHead: { prNumber: number; headSha: string } | null = null;
  try {
    prHead = await resolveOpenPrHeadFn(cfg, branch);
  } catch {
    prHead = null;
  }
  const prSha = prHead && prHead.headSha.length > 0 ? prHead.headSha : null;

  if (!remoteTip && !prSha) {
    const reason = boundRematerializeReason(
      `no recoverable remote branch or open PR head for ${branch}; cannot rematerialize managed worktree`,
    );
    await recordRematerializeGate(deps, "fail", reason);
    return { result: "fail", worktree: null, reason, blockerKind: "worktree-missing" };
  }

  // Intended tip: prefer open-PR head when present, else verified remote tip.
  const intendedSha = prSha ?? remoteTip!;

  let created: { path: string; branch: string };
  try {
    created = await createFn(cfg, issueNumber, slug, {
      ...deps.createWorktreeDeps,
      gitCmd: deps.createWorktreeDeps?.gitCmd ?? gitFn,
      resolveOpenPrHeadForBranch:
        deps.createWorktreeDeps?.resolveOpenPrHeadForBranch ?? resolveOpenPrHeadFn,
    });
  } catch (err) {
    if (isWorktreeCapacityError(err)) {
      const reason = boundRematerializeReason(err.message);
      await recordRematerializeGate(deps, "fail", reason);
      return { result: "fail", worktree: null, reason, blockerKind: "worktree-capacity" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const reason = boundRematerializeReason(`rematerialize create failed: ${msg}`);
    await recordRematerializeGate(deps, "fail", reason);
    return { result: "fail", worktree: null, reason, blockerKind: "worktree-creation-failed" };
  }

  const headRes = await gitWtFn(created.path, ["rev-parse", "HEAD"], { ignoreFailure: true });
  const headSha = headRes.code === 0 ? headRes.stdout.trim() : "";
  if (!headSha || headSha !== intendedSha) {
    // Safety scope: destructive remove is limited to the just-created path and
    // only when that path is under this checkout's managed worktree root.
    // Leaving a mismatched tree on disk would let a later getOnDiskForIssue
    // classify it as present, skip rematerialize, and run archive/autofix/fix
    // on the wrong revision (#769 review-2 finding f9fac3ac).
    let cleanupNote = "";
    if (isUnderManagedWorktreeRoot(cfg, created.path)) {
      try {
        await removeFn(cfg, issueNumber, slug, created.path);
        if (existsFn(created.path)) {
          cleanupNote =
            "; mismatched worktree cleanup incomplete — path still present under managed root; remove before re-run";
        } else {
          cleanupNote = "; mismatched worktree removed from managed root";
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cleanupNote = `; mismatched worktree cleanup failed: ${msg}`;
      }
    } else {
      cleanupNote =
        "; mismatched path outside managed worktree root — refused automatic cleanup";
    }
    const reason = boundRematerializeReason(
      `worktree HEAD after rematerialize (${headSha || "unresolved"}) does not match intended tip ${intendedSha}` +
        cleanupNote,
    );
    await recordRematerializeGate(deps, "fail", reason);
    return { result: "fail", worktree: null, reason, blockerKind: "worktree-creation-failed" };
  }

  const source = prSha ? `open PR head ${intendedSha.slice(0, 7)}` : `origin/${branch} ${intendedSha.slice(0, 7)}`;
  const reason = boundRematerializeReason(`recreated from ${source}`);
  await recordRematerializeGate(deps, "pass", reason);
  return {
    result: "pass",
    worktree: { path: created.path, slug, branch: created.branch },
    reason,
  };
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
// Per-issue worktree removal (#296) + shared pre-remove safety (#622)
// ---------------------------------------------------------------------------

/** Local-only (unpushed) commit verification tier — shared by operator remove
 *  and create-time reclaim. */
export type LocalOnlyCommitResult = boolean | "unverifiable" | null;

export type RemoveSafetyInput = {
  /** Whether the workdir is dirty (ignored when path is not on disk). */
  dirty: boolean;
  /** Result of local-only commit verification. */
  localOnly: LocalOnlyCommitResult;
  /** Operator `--force`. Reclaim always passes false. */
  force: boolean;
};

export type RemoveSafetyResult =
  | { ok: true }
  | { ok: false; error: string; blockReason: "local-only" | "unverifiable" | "verification-failed" | "dirty" };

/**
 * Pure pre-remove safety ladder shared by `removeWorktreeForIssue` and
 * create-time reclaim (#622). Encodes the operator remove tier table once so
 * the two paths cannot drift:
 *
 *  - localOnly `true` → always block (even with force)
 *  - localOnly `"unverifiable"` → block without force; allow with force
 *  - localOnly `null` → always block (verification hard-failure)
 *  - dirty without force → block
 *  - otherwise → ok to remove
 *
 * Free of git/network side effects: consumes already-computed inputs only.
 * Order matches operator remove: local-only is evaluated before dirty so dirty
 * state does not hide unpushed commits.
 */
export function evaluateRemoveSafety(input: RemoveSafetyInput): RemoveSafetyResult {
  const { dirty, localOnly, force } = input;
  if (localOnly === true) {
    return {
      ok: false,
      error: "branch has local-only commits not pushed to remote; push first",
      blockReason: "local-only",
    };
  }
  if (localOnly === "unverifiable" && !force) {
    return {
      ok: false,
      error:
        "cannot verify all commits are merged (remote branch deleted, commits not reachable from base); " +
        "use --force to proceed if work was squash-merged",
      blockReason: "unverifiable",
    };
  }
  if (localOnly === null) {
    return {
      ok: false,
      error: "commit verification failed (git/network/auth error); check connectivity and retry",
      blockReason: "verification-failed",
    };
  }
  if (dirty && !force) {
    return {
      ok: false,
      error: "uncommitted changes; use --force to discard",
      blockReason: "dirty",
    };
  }
  return { ok: true };
}

export interface RemoveWorktreeResult {
  removed: boolean;
  dirty: boolean;
  branch: string | null;
  worktree: string | null;
  error: string | null;
}

export interface RemoveWorktreeDeps {
  listOnDisk?: (cfg: PipelineConfig) => Promise<WorktreeRecord[]>;
  hasDirtyWorkdir?: (worktreePath: string) => Promise<boolean>;
  /** pathOnDisk: true when the directory exists; false when git still has the
   *  entry registered but the directory is already gone (stale registration). */
  removeWorktree?: (cfg: PipelineConfig, issueNumber: number, slug: string, pathOnDisk: boolean, resolvedPath?: string, force?: boolean) => Promise<void>;
  pathExists?: (p: string) => boolean;
  /** Returns:
   *  - true              → definitively has local-only commits (hard block, never bypassed)
   *  - false             → no local-only commits (safe to delete)
   *  - "unverifiable"    → remote branch deleted + commits not reachable from base branch
   *                        (squash-merge ambiguity; blocked without --force, allowed with)
   *  - null              → git/network/auth/stale-ref error (hard block, not bypassed by --force)
   *  worktreePath is null for stale registrations (path no longer on disk). */
  hasLocalOnlyCommits?: (cfg: PipelineConfig, worktreePath: string | null, branch: string) => Promise<boolean | "unverifiable" | null>;
  /** Check the ownership marker written by {@link writeManagedMarker}. Consulted
   *  only for a candidate discovered under a *different* checkout's managed root
   *  (cross-checkout removal, #472) — see {@link removeWorktreeForIssue}. */
  hasManagedMarker?: (worktreePath: string) => Promise<boolean>;
}

/** Returns:
 *  - true           → definitively has local-only commits (hard block)
 *  - false          → no local-only commits or all commits already merged (safe)
 *  - "unverifiable" → remote branch deleted AND commits not reachable from base
 *                     (squash-merge ambiguity; soft block, bypassable with --force)
 *  - null           → git/network/auth/stale-ref error (hard failure, not bypassable)
 *
 *  Remote-branch present: verifies live ref via `git ls-remote` and confirms the
 *  local tracking ref matches (guards against stale refs/remotes/ masking local commits).
 *  Checks both origin/<branch>..HEAD (detached HEAD) and origin/<branch>..<branch>
 *  (branch ref ahead after detach).
 *
 *  Remote-branch absent (e.g. GitHub deleted PR head after merge): falls back to
 *  reachability from origin/<base_branch>. All reachable → false (merged via regular
 *  merge). Some unreachable → "unverifiable" (squash-merge where SHAs differ). */
async function checkLocalOnlyCommits(
  cfg: PipelineConfig,
  worktreePath: string | null,
  branch: string,
): Promise<boolean | "unverifiable" | null> {
  // Verify the live remote ref (guards against stale local tracking refs).
  const lsR = await git(cfg, cfg.repo_dir, ["ls-remote", "origin", `refs/heads/${branch}`], { ignoreFailure: true });
  if (lsR.code !== 0) return null; // network/auth failure — hard block

  const remoteSha = lsR.stdout.trim().split(/\s+/)[0] ?? "";

  if (remoteSha) {
    // Remote branch exists — confirm local tracking ref is current before trusting ranges.
    const localRefR = await git(cfg, cfg.repo_dir, ["rev-parse", `refs/remotes/origin/${branch}`], { ignoreFailure: true });
    if (localRefR.code !== 0 || localRefR.stdout.trim() !== remoteSha) return null; // stale — hard block

    if (worktreePath !== null) {
      const headR = await git(cfg, worktreePath, ["log", "--oneline", `origin/${branch}..HEAD`], { ignoreFailure: true });
      if (headR.code !== 0) return null;
      if (headR.stdout.trim().length > 0) return true;
      const branchR = await git(cfg, cfg.repo_dir, ["log", "--oneline", `origin/${branch}..${branch}`], { ignoreFailure: true });
      if (branchR.code !== 0) return null;
      return branchR.stdout.trim().length > 0;
    }
    const r = await git(cfg, cfg.repo_dir, ["log", "--oneline", `origin/${branch}..${branch}`], { ignoreFailure: true });
    if (r.code !== 0) return null;
    return r.stdout.trim().length > 0;
  }

  // Remote branch absent (e.g. GitHub deleted PR head after merge).
  // Check reachability from origin/<base_branch>:
  //   all reachable  → false (regular merge, safe to delete)
  //   some unreachable → "unverifiable" (squash-merge; soft block, --force allowed)
  //   git error       → null (hard block)
  const baseBranch = cfg.base_branch ?? "main";
  if (worktreePath !== null) {
    const headR = await git(cfg, worktreePath, ["log", "--oneline", `origin/${baseBranch}..HEAD`], { ignoreFailure: true });
    if (headR.code !== 0) return null;
    const branchR = await git(cfg, cfg.repo_dir, ["log", "--oneline", `origin/${baseBranch}..${branch}`], { ignoreFailure: true });
    if (branchR.code !== 0) return null;
    if (headR.stdout.trim().length === 0 && branchR.stdout.trim().length === 0) return false;
    return "unverifiable"; // squash-merge ambiguity — remote deleted, commits not in base
  }
  // Stale registration + remote absent
  const r = await git(cfg, cfg.repo_dir, ["log", "--oneline", `origin/${baseBranch}..${branch}`], { ignoreFailure: true });
  if (r.code !== 0) return null;
  return r.stdout.trim().length === 0 ? false : "unverifiable";
}

/** Remove-worktree dep default: throws on failure so the caller can capture the message. */
async function realRemoveWorktreeOp(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  pathOnDisk: boolean,
  resolvedPath?: string,
  force?: boolean,
): Promise<void> {
  const wtPath = resolvedPath ?? worktreePath(cfg, issueNumber, slug);
  const branch = branchName(issueNumber, slug);
  if (pathOnDisk) {
    const rmArgs = force
      ? ["worktree", "remove", "--force", wtPath]
      : ["worktree", "remove", wtPath];
    const r = await git(cfg, cfg.repo_dir, rmArgs, { ignoreFailure: true });
    if (r.code !== 0) {
      throw new Error(`git worktree remove failed: ${r.stderr.trim()}`);
    }
  } else {
    // Directory gone but still git-registered — deregister the stale entry only.
    // --force is required; it is scoped to wtPath and does not prune other worktrees.
    const r = await git(cfg, cfg.repo_dir, ["worktree", "remove", "--force", wtPath], { ignoreFailure: true });
    if (r.code !== 0) {
      throw new Error(`git worktree remove (stale) failed: ${r.stderr.trim()}`);
    }
  }
  const br = await git(cfg, cfg.repo_dir, ["branch", "-D", branch], { ignoreFailure: true });
  if (br.code !== 0) {
    throw new Error(`git branch -D failed: ${br.stderr.trim()}`);
  }
}

/** Remove the on-disk worktree for issue N regardless of PR merge state.
 *
 *  - Dirty + no force → `{ removed: false, dirty: true, error: "uncommitted changes" }`
 *  - Dirty + force → removes anyway, returns `{ removed: true, dirty: true }`
 *  - Not found → `{ removed: false, error: "no worktree found …" }`
 *  - git failure → `{ removed: false, error: git-error-message }`
 *
 *  All deps are injectable for unit tests (no real git, network, or filesystem). */
export async function removeWorktreeForIssue(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: { force?: boolean },
  deps: RemoveWorktreeDeps = {},
): Promise<RemoveWorktreeResult> {
  const listFn = deps.listOnDisk ?? listOnDisk;
  const dirtyFn = deps.hasDirtyWorkdir ?? hasDirtyWorkdir;
  const removeFn = deps.removeWorktree ?? realRemoveWorktreeOp;
  const existsFn = deps.pathExists ?? fs.existsSync;
  const localOnlyFn = deps.hasLocalOnlyCommits ?? checkLocalOnlyCommits;

  const records = await listFn(cfg);
  // Legacy fallback for records with no underManagedRoot (test-injected, or a
  // caller-supplied listOnDisk that predates #472's root-set classification):
  // treat cfg.repo_dir's own root as managed, matching pre-#472 behavior.
  const legacyRoot = path.resolve(cfg.repo_dir, cfg.worktree_root);
  const isManaged = (r: WorktreeRecord): boolean =>
    r.underManagedRoot !== undefined
      ? r.underManagedRoot
      : r.path === legacyRoot || r.path.startsWith(legacyRoot + path.sep);

  const matches = records.filter((r) => r.issueNumber === issueNumber && !!r.slug && isManaged(r));

  if (matches.length > 1) {
    const candidates = matches.map((r) => r.path).join(", ");
    return {
      removed: false,
      dirty: false,
      branch: null,
      worktree: null,
      error:
        `ambiguous: multiple managed worktrees found for issue #${issueNumber}: ${candidates}. ` +
        "Remove the intended worktree explicitly (e.g. `git worktree remove <path>`).",
    };
  }

  const rec = matches[0];
  if (!rec || !rec.slug) {
    // Best-effort diagnostic: name the configured root plus every managed
    // root already observed among on-disk records, without an extra git call.
    const searchedRoots = new Set<string>([legacyRoot]);
    for (const r of records) {
      if (r.underManagedRoot === true) searchedRoots.add(path.resolve(path.dirname(r.path)));
    }
    return {
      removed: false,
      dirty: false,
      branch: null,
      worktree: null,
      error: `no worktree found for issue #${issueNumber} (searched managed roots: ${[...searchedRoots].join(", ")})`,
    };
  }

  const branch = rec.branch ?? branchName(issueNumber, rec.slug);
  const worktreeP = rec.path;

  const pathOnDisk = existsFn(worktreeP);

  // Cross-checkout ownership gate (review-2 finding 578ebd21): a Git-registered
  // checkout other than this invocation's own repo_dir is not, by itself, proof
  // that Pipeline created a worktree under that checkout's managed root — a
  // developer could have a linked checkout of the same repo with its own
  // unrelated `.worktrees/pipeline-<N>-<slug>` nested worktree. Require the
  // ownership marker createWorktree stamps before allowing a *cross-checkout*
  // removal. This does not change same-checkout behavior (the pre-#472 trust
  // boundary), matching "existing removal safety behavior SHALL be preserved
  // for cross-checkout records" — the marker check is new, additive safety,
  // not a change to the existing dirty/local-commits/force semantics below.
  const legacyRootForCrossCheckCheck = path.resolve(cfg.repo_dir, cfg.worktree_root);
  const isCrossCheckout = path.resolve(path.dirname(worktreeP)) !== legacyRootForCrossCheckCheck;
  if (isCrossCheckout && pathOnDisk) {
    const hasMarkerFn = deps.hasManagedMarker ?? hasManagedMarker;
    if (!(await hasMarkerFn(worktreeP))) {
      // Fail closed for every marker-less cross-checkout candidate (#472
      // delta findings bcee1979 + 38f7a75e): Git registration, managed-root
      // placement, and even the canonical `pipeline/<N>-<slug>` branch name
      // establish location and identity but NOT ownership — the branch
      // namespace is not exclusive, so automatic adoption could delete a
      // developer-owned worktree. Legacy recovery is an explicit, audited,
      // stamp-only operator step performed in a SEPARATE invocation: the
      // refusal names the exact marker path to create, and only a subsequent
      // --remove-worktree (which then sees the marker and runs the unchanged
      // dirty/local-commit safety flow) may remove anything.
      const markerPath = await managedMarkerPath(worktreeP);
      const adoptHint =
        markerPath !== null
          ? `If YOU created it via the pipeline before ownership markers existed, adopt it explicitly ` +
            `(stamp-only, nothing is removed): \`touch "${markerPath}"\` — then re-run --remove-worktree.`
          : "If you own it, remove it explicitly with `git worktree remove`.";
      return {
        removed: false,
        dirty: false,
        branch,
        worktree: worktreeP,
        error:
          `worktree at ${worktreeP} is registered under a linked checkout's managed root but carries no ` +
          `pipeline ownership marker; refusing cross-checkout removal. ${adoptHint}`,
      };
    }
  }

  let dirty = false;
  if (pathOnDisk) {
    dirty = await dirtyFn(worktreeP);
  }

  // Shared pre-remove safety ladder (#622): local-only tiers + dirty/force.
  // Pass null when path is absent so the impl uses the branch-ref fallback.
  // Local-only is evaluated before dirty so dirty state does not hide unpushed
  // commits (see evaluateRemoveSafety).
  const localOnly = await localOnlyFn(cfg, pathOnDisk ? worktreeP : null, branch);
  const safety = evaluateRemoveSafety({ dirty, localOnly, force: !!opts.force });
  if (!safety.ok) {
    return {
      removed: false,
      dirty: safety.blockReason === "dirty" ? true : dirty,
      branch,
      worktree: worktreeP,
      error: safety.error,
    };
  }

  try {
    await removeFn(cfg, issueNumber, rec.slug, pathOnDisk, worktreeP, opts.force);
  } catch (err) {
    return {
      removed: false,
      dirty,
      branch,
      worktree: worktreeP,
      error: (err as Error).message,
    };
  }

  return {
    removed: true,
    dirty,
    branch,
    worktree: worktreeP,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Park-release for durable holds (#718)
// ---------------------------------------------------------------------------

export type ParkReleaseAction = "released" | "retained" | "absent";

export interface ParkReleaseResult {
  action: ParkReleaseAction;
  /** Human-readable retain/release reason for operators (log / hold text). */
  reason: string;
  branch: string | null;
  worktree: string | null;
}

export interface ParkReleaseDeps {
  listOnDisk?: (cfg: PipelineConfig) => Promise<WorktreeRecord[]>;
  hasDirtyWorkdir?: (worktreePath: string) => Promise<boolean>;
  hasLocalOnlyCommits?: (
    cfg: PipelineConfig,
    worktreePath: string | null,
    branch: string,
  ) => Promise<LocalOnlyCommitResult>;
  pathExists?: (p: string) => boolean;
  /** True when branch tip is present on the remote (ls-remote). */
  hasRemoteBranchTip?: (cfg: PipelineConfig, branch: string) => Promise<boolean>;
  /**
   * Open PR recoverability for park-release when remote tip is absent.
   * Must return a non-empty head SHA so create can reconstruct from that commit
   * (#718 review ac32c448). Boolean-only "PR exists" is insufficient.
   */
  resolveOpenPrHeadForBranch?: (
    cfg: PipelineConfig,
    branch: string,
  ) => Promise<{ prNumber: number; headSha: string } | null>;
  /**
   * Perform the on-disk remove. Defaults to non-force operator remove path
   * (worktree remove + local branch delete). Never deletes remote branch/PR.
   */
  removeWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    pathOnDisk: boolean,
    resolvedPath?: string,
    force?: boolean,
  ) => Promise<void>;
}

async function realHasRemoteBranchTip(cfg: PipelineConfig, branch: string): Promise<boolean> {
  const lsR = await git(cfg, cfg.repo_dir, ["ls-remote", "origin", `refs/heads/${branch}`], {
    ignoreFailure: true,
  });
  if (lsR.code !== 0) return false;
  const sha = lsR.stdout.trim().split(/\s+/)[0] ?? "";
  return sha.length > 0;
}

/** Resolve open same-repo PR head SHA for a branch (create + park-release). */
export async function resolveOpenPrHeadForBranch(
  cfg: PipelineConfig,
  branch: string,
): Promise<{ prNumber: number; headSha: string } | null> {
  // Lazy import avoids circular init with gh.ts (which imports worktree helpers).
  const { getPrForBranch, getPrDetail } = await import("./gh.ts");
  try {
    const prNumber = await getPrForBranch(cfg, branch);
    if (prNumber === null) return null;
    const detail = await getPrDetail(cfg, prNumber);
    const headSha = (detail.head_sha ?? "").trim();
    if (!headSha) return null;
    return { prNumber, headSha };
  } catch {
    return null;
  }
}

/**
 * On durable park/hold, release a managed worktree when safe so
 * `max_concurrent_worktrees` capacity frees for other items (#718 Policy A).
 *
 * Safety (fail-closed): under managed root, clean workdir, no definitive
 * local-only commits, and remote tip **or** open PR for recoverability.
 * Dirty / local-only / unverifiable / missing-remote parks retain the tree
 * with a visible reason. Idempotent when no managed worktree is on disk.
 * Never deletes the remote branch or open PR.
 */
export async function releaseWorktreeForParkedIssue(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: ParkReleaseDeps = {},
): Promise<ParkReleaseResult> {
  const listFn = deps.listOnDisk ?? listOnDisk;
  const dirtyFn = deps.hasDirtyWorkdir ?? hasDirtyWorkdir;
  const localOnlyFn = deps.hasLocalOnlyCommits ?? checkLocalOnlyCommits;
  const existsFn = deps.pathExists ?? fs.existsSync;
  const remoteTipFn = deps.hasRemoteBranchTip ?? realHasRemoteBranchTip;
  const resolveOpenPrHeadFn = deps.resolveOpenPrHeadForBranch ?? resolveOpenPrHeadForBranch;
  const removeFn = deps.removeWorktree ?? realRemoveWorktreeOp;

  const records = await listFn(cfg);
  const legacyRoot = path.resolve(cfg.repo_dir, cfg.worktree_root);
  const isManaged = (r: WorktreeRecord): boolean =>
    r.underManagedRoot !== undefined
      ? r.underManagedRoot
      : r.path === legacyRoot || r.path.startsWith(legacyRoot + path.sep);

  const matches = records.filter((r) => r.issueNumber === issueNumber && !!r.slug && isManaged(r));
  if (matches.length === 0) {
    return {
      action: "absent",
      reason: `no managed worktree on disk for issue #${issueNumber}`,
      branch: null,
      worktree: null,
    };
  }
  if (matches.length > 1) {
    const candidates = matches.map((r) => r.path).join(", ");
    return {
      action: "retained",
      reason:
        `ambiguous: multiple managed worktrees for issue #${issueNumber} (${candidates}); ` +
        "refusing automatic park-release",
      branch: null,
      worktree: null,
    };
  }

  const rec = matches[0]!;
  // Out-of-managed-root records are filtered by isManaged above, but also
  // refuse explicit underManagedRoot === false if a caller injects raw list.
  if (rec.underManagedRoot === false) {
    return {
      action: "retained",
      reason: `worktree ${rec.path} is outside the managed root; park-release never auto-removes it`,
      branch: rec.branch ?? branchName(issueNumber, rec.slug!),
      worktree: rec.path,
    };
  }

  const branch = rec.branch ?? branchName(issueNumber, rec.slug!);
  const worktreeP = rec.path;
  const pathOnDisk = existsFn(worktreeP);

  let dirty = false;
  if (pathOnDisk) {
    dirty = await dirtyFn(worktreeP);
  }
  const localOnly = await localOnlyFn(cfg, pathOnDisk ? worktreeP : null, branch);

  // Single evaluateRemoveSafety decision for dirty/local-only (#759 parked
  // release). Prior code re-checked the same policy via early returns and a
  // second evaluateRemoveSafety call — those could disagree in wording and
  // counted as two independent preflights.
  const safety = evaluateRemoveSafety({ dirty, localOnly, force: false });
  if (!safety.ok) {
    const reason =
      safety.blockReason === "dirty"
        ? `dirty worktree at ${worktreeP}; park-release retains uncommitted work`
        : safety.blockReason === "local-only"
          ? `local-only (unpushed) commits on ${branch}; park-release retains the worktree`
          : safety.blockReason === "verification-failed"
            ? `cannot verify local-only state for ${branch} (git/network/auth); park-release retains the worktree`
            : safety.error;
    return {
      action: "retained",
      reason,
      branch,
      worktree: worktreeP,
    };
  }

  const hasRemoteTip = await remoteTipFn(cfg, branch);
  // Open PR is an alternate recoverability path only when we can resolve a
  // non-empty PR head SHA — createWorktree reconstructs from that head when
  // the remote branch tip is absent (#718 review ac32c448).
  const openPrHead = hasRemoteTip ? null : await resolveOpenPrHeadFn(cfg, branch);
  const hasRecoverableOpenPr = openPrHead !== null && openPrHead.headSha.length > 0;
  // Open PR is an alternate recoverability path when remote-tip verification is
  // marginal (e.g. unverifiable after squash ambiguity) — still require no
  // definitive local-only commits (handled above via evaluateRemoveSafety).
  if (localOnly === "unverifiable" && !hasRecoverableOpenPr && !hasRemoteTip) {
    return {
      action: "retained",
      reason:
        `local-only verification unverifiable for ${branch} and no open PR with resolvable head; ` +
        "park-release retains the worktree",
      branch,
      worktree: worktreeP,
    };
  }
  if (!hasRemoteTip && !hasRecoverableOpenPr) {
    return {
      action: "retained",
      reason:
        `no remote branch tip and no open PR with resolvable head for ${branch}; ` +
        "park-release retains the worktree (missing remote recoverability)",
      branch,
      worktree: worktreeP,
    };
  }

  try {
    await removeFn(cfg, issueNumber, rec.slug!, pathOnDisk, worktreeP, false);
  } catch (err) {
    return {
      action: "retained",
      reason: `park-release remove failed: ${(err as Error).message}`,
      branch,
      worktree: worktreeP,
    };
  }

  return {
    action: "released",
    reason: hasRemoteTip
      ? `released managed worktree for #${issueNumber} (clean + remote tip on ${branch})`
      : `released managed worktree for #${issueNumber} (clean + open PR #${openPrHead!.prNumber} head ${openPrHead!.headSha.slice(0, 8)} for ${branch})`,
    branch,
    worktree: worktreeP,
  };
}

// ---------------------------------------------------------------------------
// Worktree sweep (cleanup of merged-PR worktrees)
// ---------------------------------------------------------------------------

/** Pure parser — exposed for unit tests. */
export function parseDirtyWorkdir(statusOutput: string): boolean {
  return statusOutput.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Worktree-state blocker disclosure (#486)
// ---------------------------------------------------------------------------

/** Max number of changed paths listed verbatim in a worktree-state section
 *  before the remainder is summarized as "…and N more". */
const WORKTREE_STATE_FILE_LIMIT = 10;

/**
 * Render a `git status --short` porcelain listing into a Markdown section
 * describing recoverable worktree state — staged/unstaged/untracked counts
 * plus a bounded, deterministic file list. Returns `null` for empty input
 * (clean worktree — the caller omits the section entirely). Pure and
 * exported for direct unit testing (#486).
 */
export function renderWorktreeStateSection(shortStatus: string): string | null {
  const lines = shortStatus
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const paths: string[] = [];
  for (const line of lines) {
    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim() || line.trim();
    if (code === "??") {
      untracked++;
    } else {
      if (code[0] !== undefined && code[0] !== " ") staged++;
      if (code[1] !== undefined && code[1] !== " ") unstaged++;
    }
    paths.push(filePath);
  }

  const counts: string[] = [];
  if (staged > 0) counts.push(`${staged} staged`);
  if (unstaged > 0) counts.push(`${unstaged} unstaged`);
  if (untracked > 0) counts.push(`${untracked} untracked`);

  const shown = paths.slice(0, WORKTREE_STATE_FILE_LIMIT);
  const omitted = paths.length - shown.length;
  const fileListLines = shown.map((p) => `- \`${p}\``);
  if (omitted > 0) fileListLines.push(`- …and ${omitted} more`);

  return [
    "### Worktree state (recoverable work)",
    "",
    `${counts.join(", ")} (${paths.length} ${paths.length === 1 ? "entry" : "entries"} total) — this may be ` +
      "in-progress work worth reviewing before it is discarded.",
    "",
    ...fileListLines,
  ].join("\n");
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
