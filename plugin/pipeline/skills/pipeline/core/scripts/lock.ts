// PID-based file lock with stale-lock recovery.
//
// Issue-run mutex (#634): when an issueNumber is given the identity is always
// (domain, issue) at /tmp/pipeline-{domain}-{N}.lock — shared by foreground
// advance and detach. Never issue-number-only. Host-local only (no cross-host
// mutual exclusion; single-host is the supported concurrency scope — #459).
// Without issueNumber: /tmp/pipeline-{domain}.lock (legacy domain-wide lock).
//
// Marker body prefers `pid starttime` (#770 recycled-PID safety) when starttime
// is known; bare PID remains parseable by readers that only need the first token.

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Path construction — single shared identity for advance + detach
// ---------------------------------------------------------------------------

/** Host-local issue-run lock path for `(domain, issueNumber)`. Never issue-only. */
export function issueRunLockPath(domain: string, issueNumber: number): string {
  if (!domain || typeof domain !== "string") {
    throw new Error("issueRunLockPath: domain must be a non-empty string");
  }
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`issueRunLockPath: issueNumber must be a positive integer, got ${issueNumber}`);
  }
  return `/tmp/pipeline-${domain}-${issueNumber}.lock`;
}

/** Legacy domain-wide lock (callers that omit issueNumber). */
export function domainLockPath(domain: string): string {
  if (!domain || typeof domain !== "string") {
    throw new Error("domainLockPath: domain must be a non-empty string");
  }
  return `/tmp/pipeline-${domain}.lock`;
}

// ---------------------------------------------------------------------------
// Process-instance identity for issue-run lock markers (#634 / #770)
// ---------------------------------------------------------------------------

/**
 * Host process starttime token for `pid`.
 * Linux: `/proc/<pid>/stat` field 22 (clock ticks). Darwin/portable: `ps -o lstart=`.
 * Returns null when the process is gone or the token cannot be read.
 */
export function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const i = s.lastIndexOf(")");
    if (i >= 0) {
      const f = s.slice(i + 2).trim().split(/\s+/);
      if (f[19]) return f[19];
    }
  } catch {
    /* not Linux, or process gone — try portable fallback */
  }
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (out.status === 0) {
      const t = (out.stdout ?? "").trim();
      if (t) return t;
    }
  } catch {
    /* ps unavailable */
  }
  return null;
}

/**
 * Body for issue-run lock / detach handshake markers: `pid starttime` when
 * starttime is known, else bare `pid` (readers treat bare pid as non-verifiable
 * for identity probes that require starttime).
 */
export function formatProcessIdentityMarker(
  pid: number = process.pid,
  getStartTime: (p: number) => string | null = getProcessStartTime,
): string {
  const st = getStartTime(pid);
  return st != null && st !== "" ? `${pid} ${st}` : String(pid);
}

/**
 * Env token set by the detach wrapper so the inner advance process does not
 * re-acquire the same issue-run lock the wrapper already holds (#634).
 * Format: `{domain}:{issueNumber}`.
 */
export const ISSUE_RUN_LOCK_HELD_ENV = "PIPELINE_ISSUE_RUN_LOCK_HELD";

export function issueRunLockHeldToken(domain: string, issueNumber: number): string {
  return `${domain}:${issueNumber}`;
}

/** True when the current process is nested under a parent that holds this issue-run lock. */
export function isIssueRunLockHeldByParent(domain: string, issueNumber: number): boolean {
  const v = process.env[ISSUE_RUN_LOCK_HELD_ENV];
  return v === issueRunLockHeldToken(domain, issueNumber);
}

export interface PipelineLockOptions {
  domain: string;
  /** Optional issue number — when provided, lock is per-issue rather than per-domain. */
  issueNumber?: number;
  /**
   * Injectable identity-marker writer (tests). Default: formatProcessIdentityMarker.
   * Domain-wide locks still use bare PID for back-compat with older readers.
   */
  formatMarker?: (pid: number) => string;
}

export class PipelineLock {
  readonly path: string;
  readonly domain: string;
  readonly issueNumber: number | undefined;
  private acquired = false;
  private readonly formatMarker: (pid: number) => string;

  constructor(opts: PipelineLockOptions) {
    this.domain = opts.domain;
    this.issueNumber = opts.issueNumber;
    this.path =
      opts.issueNumber !== undefined
        ? issueRunLockPath(opts.domain, opts.issueNumber)
        : domainLockPath(opts.domain);
    // Per-issue: stronger pid+starttime. Domain-wide: bare PID (legacy).
    this.formatMarker =
      opts.formatMarker ??
      (opts.issueNumber !== undefined
        ? (pid) => formatProcessIdentityMarker(pid)
        : (pid) => String(pid));
  }

  /** Try to acquire the lock. Returns true if acquired. */
  acquire(): boolean {
    try {
      // O_CREAT | O_EXCL: atomic create-or-fail.
      const fd = fs.openSync(this.path, "wx");
      try {
        fs.writeSync(fd, this.formatMarker(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      this.acquired = true;
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        return this.handleExistingLock();
      }
      throw err;
    }
  }

  /**
   * Retry acquire until `timeoutMs` elapses (detach wrapper). Throws a
   * human-readable error when the lock remains held by a live process.
   */
  async acquireWithTimeout(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.acquire()) return;
      if (Date.now() >= deadline) {
        let holder = "";
        try {
          holder = ` (held by PID ${fs.readFileSync(this.path, "utf8").trim()})`;
        } catch {
          /* vanished */
        }
        const scope =
          this.issueNumber !== undefined
            ? `issue #${this.issueNumber}`
            : `domain ${this.domain}`;
        throw new Error(
          `pipeline: ${scope} is already running${holder}. ` +
            `Wait for the run to finish or remove ${this.path} if it is stale.`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, 200));
    }
  }

  private handleExistingLock(): boolean {
    let pidText: string;
    try {
      pidText = fs.readFileSync(this.path, "utf8").trim();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return this.acquire();
      throw err;
    }

    // First token is the PID; optional starttime follows (#770 / #634 markers).
    const pid = Number.parseInt(pidText.split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      // Garbage in lock file → treat as stale.
      this.removeStale();
      return this.acquire();
    }

    try {
      // Signal 0 just probes whether the process exists.
      process.kill(pid, 0);
      // Process is alive → lock is held.
      return false;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ESRCH") {
        // No such process → stale lock.
        this.removeStale();
        return this.acquire();
      }
      if (e.code === "EPERM") {
        // Process exists but we can't signal it. Be conservative and say held.
        return false;
      }
      throw err;
    }
  }

  private removeStale(): void {
    try {
      fs.unlinkSync(this.path);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }

  release(): void {
    if (!this.acquired) return;
    try {
      fs.unlinkSync(this.path);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
    this.acquired = false;
  }
}

/**
 * Run `fn` while holding the pipeline lock. Throws if the lock is held.
 *
 * If `issueNumber` is provided the lock is the shared issue-run mutex
 * (`/tmp/pipeline-{domain}-{N}.lock`) used by both foreground advance and
 * detach. Without it, the lock is per-domain (legacy behavior).
 *
 * When the detach wrapper already holds the issue-run lock, it sets
 * {@link ISSUE_RUN_LOCK_HELD_ENV} so the inner advance process skips re-acquire
 * (parent owns release for the wrapper lifetime).
 */
export async function withLock<T>(
  domain: string,
  fn: () => Promise<T>,
  issueNumber?: number,
): Promise<T> {
  if (issueNumber !== undefined && isIssueRunLockHeldByParent(domain, issueNumber)) {
    return await fn();
  }
  const lock = new PipelineLock({ domain, issueNumber });
  if (!lock.acquire()) {
    const scope = issueNumber !== undefined ? `for #${issueNumber}` : `(domain-wide)`;
    throw new Error(
      `Pipeline lock held by another process ${scope}: ${lock.path}. ` +
        "Wait for the other run to finish, or remove the file if you're sure it's stale.",
    );
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Per-domain run/state directory (#147). Shares the `/tmp/pipeline-{domain}`
 * namespace already owned by the lock + kill-switch files; the trailing path
 * component is a directory (no extension), so it never collides with the
 * `pipeline-{domain}.lock` / `pipeline-{domain}-{N}.lock` / `.disabled` files.
 * Per-run, issue-scoped artifacts (e.g. the evidence bundle) live under
 * `<runStateDir>/<issueNumber>/`.
 */
export function runStateDir(domain: string): string {
  return `/tmp/pipeline-${domain}`;
}

/** Kill switch path. If this file exists, the pipeline refuses to run. */
export function killSwitchPath(domain: string): string {
  return `/tmp/pipeline-${domain}.disabled`;
}

export function isKillSwitchActive(domain: string): boolean {
  return fs.existsSync(killSwitchPath(domain));
}

// ---------------------------------------------------------------------------
// Repo-stable live-planning marker (#271 cross-domain/worktree guard).
//
// Path uses the GitHub repo slug (owner/name → owner-name) rather than the
// domain so the signal is stable across worktrees of the same repo that
// happen to resolve different domain basenames.
// ---------------------------------------------------------------------------

export function livePlanningMarkerPath(repo: string, issueNumber: number): string {
  const safeRepo = repo.replace(/\//g, "-");
  return `/tmp/pipeline-planning-${safeRepo}-${issueNumber}.live`;
}

/**
 * Write the current PID into the repo-stable live-planning marker using an
 * atomic temp-file + rename so the marker is never visible as empty.
 * Safe to call whether the marker already exists (overwrite) or not (create).
 */
export function setLivePlanningMarker(repo: string, issueNumber: number): void {
  const markerPath = livePlanningMarkerPath(repo, issueNumber);
  const tmpPath = markerPath + ".set." + process.pid;
  fs.writeFileSync(tmpPath, String(process.pid));
  fs.renameSync(tmpPath, markerPath);
}

/**
 * Atomically publish `content` at `path` using a temp-file + hard-link
 * strategy so the marker is never visible as empty.
 *
 * Writes content to a per-PID temp file first (full content present before
 * any other process can observe the marker path), then hard-links the temp
 * file into `path`. `link(2)` is atomic: if `path` already exists the call
 * fails with EEXIST and we return false without touching the existing file.
 * The temp file is always removed in the finally block.
 */
function tryExclCreate(path: string, content: string): boolean {
  const tmpPath = path + ".claim." + process.pid;
  // Remove any stale hard link from a prior crashed attempt so it cannot
  // mutate an already-published marker when the OS reuses this PID.
  try { fs.unlinkSync(tmpPath); } catch { /* ENOENT is fine */ }
  fs.writeFileSync(tmpPath, content);
  try {
    fs.linkSync(tmpPath, path);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

/** Return true when the PID read from `path` belongs to a live process. */
function isFilePidAlive(path: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  const pid = Number.parseInt(text, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true;
    return false;
  }
}

/**
 * Atomically claim the live-planning marker for the current process.
 *
 * Uses O_CREAT|O_EXCL so only one caller wins when the marker is absent.
 * When a stale (dead-PID) marker exists, reclamation is serialized through a
 * per-marker cleanup lock (also PID-stamped so stale cleanup locks are
 * reclaimed without blocking future runs).
 *
 * Returns true when this process owns the marker, false when a live process
 * holds it (or the reclamation race was lost — caller should wait and retry).
 */
export function tryAcquireLivePlanningMarker(repo: string, issueNumber: number): boolean {
  const markerPath = livePlanningMarkerPath(repo, issueNumber);
  const pid = String(process.pid);

  // 1. Happy path: no marker — claim it atomically.
  if (tryExclCreate(markerPath, pid)) return true;

  // 2. Marker exists; if the owner is alive we must wait.
  if (isLivePlanningActive(repo, issueNumber)) return false;

  // 3. Stale marker. Serialize reclamation with a per-marker cleanup lock so
  //    two concurrent callers cannot both unlink+recreate (TOCTOU).
  const cleanupPath = markerPath + ".cleanup";
  if (!tryExclCreate(cleanupPath, pid)) {
    // Cleanup lock is held by someone. If their PID is dead, reclaim the lock.
    if (isFilePidAlive(cleanupPath)) return false; // live reclaimer — wait
    try {
      fs.unlinkSync(cleanupPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
    // Retry acquiring the cleanup lock once; if another process beats us, wait.
    if (!tryExclCreate(cleanupPath, pid)) return false;
  }

  // 4. We hold the cleanup lock. Reclaim the stale main marker.
  try {
    // Re-check: the marker might have been reclaimed between step 2 and now.
    if (isLivePlanningActive(repo, issueNumber)) return false;
    try {
      fs.unlinkSync(markerPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
    // A fresh process could have claimed the marker between our unlink and this
    // create; if so we lose gracefully.
    return tryExclCreate(markerPath, pid);
  } finally {
    try {
      fs.unlinkSync(cleanupPath);
    } catch {
      // ignore
    }
  }
}

/** Remove the repo-stable live-planning marker (no-op if absent). */
export function clearLivePlanningMarker(repo: string, issueNumber: number): void {
  try {
    fs.unlinkSync(livePlanningMarkerPath(repo, issueNumber));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }
}

/**
 * Return true when another process is actively running the planning stage for
 * this repo+issue. Uses the same PID-probe logic as {@link PipelineLock}.
 */
export function isLivePlanningActive(repo: string, issueNumber: number): boolean {
  const markerPath = livePlanningMarkerPath(repo, issueNumber);
  let pidText: string;
  try {
    pidText = fs.readFileSync(markerPath, "utf8").trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw err;
  }
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true;
    throw err;
  }
}
