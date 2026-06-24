// PID-based file lock with stale-lock recovery.
// Path is /tmp/pipeline-{domain}-{N}.lock when an issueNumber is given (per-issue
// mutex — multiple pipeline runs on different issues coexist), otherwise
// /tmp/pipeline-{domain}.lock (legacy global lock, kept for back-compat).
// Mirrors the Python implementation in ~/.openclaw/scripts/pipeline/lock.py.

import * as fs from "node:fs";

export interface PipelineLockOptions {
  domain: string;
  /** Optional issue number — when provided, lock is per-issue rather than per-domain. */
  issueNumber?: number;
}

export class PipelineLock {
  readonly path: string;
  private acquired = false;

  constructor(opts: PipelineLockOptions) {
    this.path =
      opts.issueNumber !== undefined
        ? `/tmp/pipeline-${opts.domain}-${opts.issueNumber}.lock`
        : `/tmp/pipeline-${opts.domain}.lock`;
  }

  /** Try to acquire the lock. Returns true if acquired. */
  acquire(): boolean {
    try {
      // O_CREAT | O_EXCL: atomic create-or-fail.
      const fd = fs.openSync(this.path, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
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

  private handleExistingLock(): boolean {
    let pidText: string;
    try {
      pidText = fs.readFileSync(this.path, "utf8").trim();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return this.acquire();
      throw err;
    }

    const pid = Number.parseInt(pidText, 10);
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
 * If `issueNumber` is provided the lock is per-issue (`/tmp/pipeline-{domain}-{N}.lock`),
 * letting concurrent pipeline runs on different issues coexist. Without it, the lock
 * is per-domain (legacy behavior).
 */
export async function withLock<T>(
  domain: string,
  fn: () => Promise<T>,
  issueNumber?: number,
): Promise<T> {
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

/** Write the current PID into the repo-stable live-planning marker. */
export function setLivePlanningMarker(repo: string, issueNumber: number): void {
  fs.writeFileSync(livePlanningMarkerPath(repo, issueNumber), String(process.pid));
}

/**
 * Try to create a file with O_CREAT|O_EXCL, writing `content`.
 * Returns true on success, false if the file already exists.
 */
function tryExclCreate(path: string, content: string): boolean {
  try {
    const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return false;
    throw err;
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
