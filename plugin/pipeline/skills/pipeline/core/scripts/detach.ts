// Detached launcher for `pipeline run <issue> --detach`.
//
// Two roles:
//   1. Library: spawnDetached() spawns a detached wrapper child; the caller
//      prints the run-directory path and exits.
//   2. Wrapper: when argv[2] === '_wrapper', acquires the per-issue advisory
//      lock, spawns the actual pipeline run, waits for completion, and writes
//      sentinel.json atomically on every exit path.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PipelineLock,
  formatProcessIdentityMarker,
  getProcessStartTime,
  issueRunLockPath,
  issueRunLockHeldToken,
  ISSUE_RUN_LOCK_HELD_ENV,
} from "./lock.ts";

// Re-export process-identity helpers (canonical home is lock.ts) for existing importers.
export { formatProcessIdentityMarker, getProcessStartTime, issueRunLockPath };

// ---------------------------------------------------------------------------
// Process-tree termination (#153)
//
// The watchdog originally killed only the wrapper's own process group
// (`process.kill(-process.pid, ...)`). But pipeline steps intentionally spawn
// shell-backed setup/test/harness work in their OWN process groups
// (`detached: true` in worktree-setup.ts / harness.ts), so those descendants
// survive a wrapper-group kill — they keep mutating the worktree after the run
// is classified `timedOut`. To honor the sentinel contract, the watchdog must
// terminate the full process tree: every process group covering the wrapper and
// all of its descendants. The parsing and group-collection are pure so they can
// be unit-tested with a synthetic process table.
// ---------------------------------------------------------------------------

/** One row of a `ps` snapshot used for tree termination. */
export type ProcInfo = { pid: number; ppid: number; pgid: number };

/** Parse `ps -A -o pid=,ppid=,pgid=` output into rows. Tolerant of leading
 *  whitespace and blank lines; ignores malformed rows. Pure. */
export function parseProcTable(stdout: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return rows;
}

/** Given a process table and a root pid, return the distinct process-group ids
 *  covering the root process and ALL of its descendants. Detached children that
 *  created their own group are therefore included. Pure. */
export function descendantProcessGroups(table: ProcInfo[], rootPid: number): number[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of table) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const pgids = new Set<number>();
  const self = table.find((p) => p.pid === rootPid);
  if (self) pgids.add(self.pgid);
  // BFS over descendants.
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      pgids.add(child.pgid);
      queue.push(child.pid);
    }
  }
  return [...pgids];
}

/** IO seam for {@link killProcessTree} — tests inject a fake snapshot/killer. */
export type KillTreeDeps = {
  snapshot: () => string;
  killGroup: (pgid: number, signal: NodeJS.Signals) => void;
};

const defaultKillTreeDeps: KillTreeDeps = {
  snapshot: () => {
    try {
      const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
      return r.stdout ?? "";
    } catch {
      return "";
    }
  },
  killGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* group already gone */
    }
  },
};

/** Kill the full process tree rooted at `rootPid` with `signal`, including
 *  descendants that placed themselves in their own process groups. Best-effort:
 *  always falls back to killing the root's own group so a snapshot failure still
 *  terminates the wrapper group. Returns the group ids it attempted to kill. */
export function killProcessTree(
  rootPid: number,
  signal: NodeJS.Signals,
  deps: KillTreeDeps = defaultKillTreeDeps,
): number[] {
  const table = parseProcTable(deps.snapshot());
  const groups = descendantProcessGroups(table, rootPid);
  if (groups.length === 0) groups.push(rootPid); // fallback: at least our own group
  // Kill descendant groups first, the wrapper's own group last (killing our own
  // group with SIGKILL terminates this process immediately).
  const ordered = [...groups.filter((g) => g !== rootPid), ...groups.filter((g) => g === rootPid)];
  for (const pgid of ordered) deps.killGroup(pgid, signal);
  return ordered;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SentinelData = {
  exitCode: number;
  durationMs: number;
  completedAt: string;
  timedOut?: true;
};

export type SpawnDetachedOpts = {
  /**
   * Pipeline domain (same identity as foreground advance — config domain /
   * `--domain` / basename of resolved repo). Required for the shared
   * issue-run lock and domain-scoped wrapper run paths (#634).
   */
  domain: string;
  /** Watchdog timeout in seconds. Absent = no watchdog. */
  timeout?: number;
  /** Advisory lock acquisition timeout in ms. Default 5000. */
  flockTimeoutMs?: number;
};

export type SpawnDetachedResult = {
  runDir: string;
  pid: number;
};

/** IO seam for unit tests — only cover the parts that can't use a real tmpdir. */
export type SpawnDetachedDeps = {
  homedir: () => string;
  now: () => number;
  /** Process PID used in run-dir name. Injectable so tests get a deterministic path. */
  pid: () => number;
  spawn: typeof spawn;
  /** Wait for the wrapper's lock handshake. Injectable so tests need not run a real wrapper. */
  awaitLockHandshake: (runDir: string, timeoutMs: number) => Promise<LockHandshake>;
};

const defaultSpawnDeps: SpawnDetachedDeps = {
  homedir: os.homedir,
  now: () => Date.now(),
  pid: () => process.pid,
  spawn,
  awaitLockHandshake: awaitLockHandshakeDefault,
};

// ---------------------------------------------------------------------------
// Path helpers (exported for tests)
//
// Wrapper run artifacts live under ~/.pipeline/runs/<domain>/<issue>/ so two
// repos that share an issue number never interleave logs/sentinels (#634).
// The mutual-exclusion lock itself is the shared issue-run path under /tmp
// (see issueRunLockPath / PipelineLock) — not a second home-dir mutex.
// ---------------------------------------------------------------------------

export function issueRunsDir(homedir: string, domain: string, issue: number): string {
  if (!domain) throw new Error("issueRunsDir: domain is required");
  return path.join(homedir, ".pipeline", "runs", domain, String(issue));
}

/**
 * Shared issue-run lock path for detach diagnostics / live probes.
 * Domain-scoped; never issue-number-only. Same path as foreground advance.
 */
export function lockFilePath(domain: string, issue: number): string {
  return issueRunLockPath(domain, issue);
}

export function makeRunDir(homedir: string, domain: string, issue: number, ts: string): string {
  return path.join(issueRunsDir(homedir, domain, issue), ts);
}

// ---------------------------------------------------------------------------
// Sentinel write (exported for tests)
// ---------------------------------------------------------------------------

export function writeSentinel(runDirPath: string, data: SentinelData): void {
  const tmp = path.join(runDirPath, "sentinel.tmp");
  const final = path.join(runDirPath, "sentinel.json");
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, final);
}

// ---------------------------------------------------------------------------
// Lock-ownership handshake (#153 / #634)
//
// The launcher must NOT acquire the per-issue lock and then transfer it to the
// child after spawn(): if the launcher dies in the window between spawn() and
// the transfer, the wrapper runs while the lock names a dead launcher PID, and a
// later run treats the lock as stale and starts a concurrent duplicate. Instead
// the WRAPPER acquires the lock itself (so the lock always names a live process
// for its whole life) and writes a handshake file; the launcher waits for that
// file before reporting the run started, so a concurrent launch is still
// rejected synchronously.
// ---------------------------------------------------------------------------

/** Written by the wrapper into its run dir once it holds the per-issue lock. */
export const LOCK_ACQUIRED_FILE = ".lock-acquired";
/** Written by the wrapper into its run dir when the lock is held by another run. */
export const LOCK_FAILED_FILE = ".lock-failed";

/** Outcome of waiting for the wrapper's lock handshake. */
export type LockHandshake = { acquired: boolean; holder?: string };

/** Poll a run dir for the wrapper's lock handshake file. Resolves
 *  `{ acquired: true }` when `.lock-acquired` appears, `{ acquired: false, holder }`
 *  when `.lock-failed` appears, and `{ acquired: false }` on timeout. */
async function awaitLockHandshakeDefault(runDir: string, timeoutMs: number): Promise<LockHandshake> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(path.join(runDir, LOCK_ACQUIRED_FILE))) return { acquired: true };
    try {
      const holder = fs.readFileSync(path.join(runDir, LOCK_FAILED_FILE), "utf8").trim();
      return { acquired: false, holder: holder || undefined };
    } catch {
      /* not failed yet */
    }
    if (Date.now() >= deadline) return { acquired: false };
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// spawnDetached (library mode)
// ---------------------------------------------------------------------------

const DETACH_TS = fileURLToPath(new URL("./detach.ts", import.meta.url));

/**
 * Spawn a detached wrapper process that runs `pipeline <issue> [pipelineArgs]`
 * in a new process group, surviving the launcher's exit. The wrapper writes
 * `sentinel.json` to the run directory on every exit path.
 *
 * The shared issue-run lock (`(domain, issue)` → `/tmp/pipeline-{domain}-{N}.lock`)
 * is acquired by the WRAPPER (not the launcher) so a launcher death cannot
 * strand a dead-PID lock. The same path is used by foreground advance, so
 * dual-entry races are closed (#634).
 *
 * Returns the run-directory path (for the caller to print) and the wrapper PID.
 */
export async function spawnDetached(
  issueNumber: number,
  pipelineArgs: string[],
  opts: SpawnDetachedOpts,
  deps: SpawnDetachedDeps = defaultSpawnDeps,
): Promise<SpawnDetachedResult> {
  const domain = opts.domain?.trim();
  if (!domain) {
    throw new Error("pipeline: spawnDetached requires a non-empty domain for the issue-run lock");
  }
  const { timeout, flockTimeoutMs = 5000 } = opts;
  const home = deps.homedir();

  // Shared issue-run lock path (diagnostics only here — wrapper acquires it).
  const lp = lockFilePath(domain, issueNumber);

  // Create a collision-proof run directory: millisecond-precision timestamp +
  // PID so two launches within the same second (or same millisecond on fast
  // systems) never share a directory. `mkdirSync(..., { recursive: true })`
  // reuses an existing directory, so we also assert the selected dir has no
  // leftover sentinel.json from a previous run.
  const ts = new Date(deps.now())
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 23)         // include milliseconds: YYYY-MM-DDTHH-mm-ss-mmm
    .replace("T", "_")
    + `-p${deps.pid()}`;  // add PID to prevent same-ms collisions
  const rd = makeRunDir(home, domain, issueNumber, ts);
  fs.mkdirSync(rd, { recursive: true });
  if (fs.existsSync(path.join(rd, "sentinel.json"))) {
    throw new Error(
      `pipeline: run directory collision — ${rd} already contains sentinel.json from a prior run. ` +
        `Remove ${rd} if you want to start fresh.`,
    );
  }

  // Log file: wrapper stdout + stderr are appended here.
  const logPath = path.join(rd, "pipeline.log");
  const logFd = fs.openSync(logPath, "a");

  const wrapperArgs = [
    "--experimental-strip-types",
    DETACH_TS,
    "_wrapper",
    "--run-dir",
    rd,
    "--issue",
    String(issueNumber),
    "--domain",
    domain,
    "--flock-timeout",
    String(flockTimeoutMs),
    ...(timeout !== undefined ? ["--timeout", String(timeout)] : []),
    ...(pipelineArgs.length > 0 ? ["--", ...pipelineArgs] : []),
  ];

  const child = deps.spawn(process.execPath, wrapperArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  fs.closeSync(logFd);

  if (child.pid === undefined) {
    throw new Error(`pipeline: failed to spawn detached process for #${issueNumber}`);
  }

  // Wait for the wrapper to acquire the lock and signal readiness before we
  // report the run started. The wrapper owns the lock for its whole life, so the
  // lock file always names a live PID (no parent-death transfer race). A
  // concurrent launch for the same domain+issue loses the wrapper's atomic
  // acquire and reports failure here.
  const handshake = await deps.awaitLockHandshake(rd, flockTimeoutMs + 2000);
  if (!handshake.acquired) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* wrapper already exited after writing .lock-failed */
    }
    throw new Error(
      `pipeline: issue #${issueNumber} is already running` +
        (handshake.holder ? ` (held by PID ${handshake.holder})` : "") +
        `. Wait for the run to finish or remove ${lp} if it is stale.`,
    );
  }

  child.unref();
  return { runDir: rd, pid: child.pid };
}

// ---------------------------------------------------------------------------
// Wrapper mode — entry point when argv[2] === '_wrapper'
// ---------------------------------------------------------------------------

export async function runWrapper(argv: string[]): Promise<void> {
  // Parse: _wrapper --run-dir <dir> --issue <N> --domain <d> [--timeout <s>]
  //        [--flock-timeout <ms>] [-- args...]
  const args = argv.slice(1); // skip '_wrapper'
  let runDirPath = "";
  let issueNumber = 0;
  let domain = "";
  let timeout: number | undefined;
  let flockTimeoutMs = 5000;
  const pipelinePassArgs: string[] = [];

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      pipelinePassArgs.push(...args.slice(i + 1));
      break;
    }
    if (a === "--run-dir") {
      runDirPath = args[++i];
    } else if (a === "--issue") {
      issueNumber = Number(args[++i]);
    } else if (a === "--domain") {
      domain = String(args[++i] ?? "").trim();
    } else if (a === "--timeout") {
      timeout = Number(args[++i]);
    } else if (a === "--flock-timeout") {
      flockTimeoutMs = Number(args[++i]);
    }
    i++;
  }

  if (!runDirPath || !issueNumber || !domain) {
    process.stderr.write("detach wrapper: missing --run-dir, --issue, or --domain\n");
    process.exit(1);
  }

  // Shared issue-run lock (same path as foreground advance).
  const issueLock = new PipelineLock({ domain, issueNumber });
  const lp = issueLock.path;
  const startMs = Date.now();
  let sentinelWritten = false;
  let innerProcess: ReturnType<typeof spawn> | undefined;

  function doWriteSentinel(exitCode: number, timedOut?: true): void {
    if (sentinelWritten) return;
    sentinelWritten = true;
    try {
      writeSentinel(runDirPath, {
        exitCode,
        durationMs: Date.now() - startMs,
        completedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        ...(timedOut ? { timedOut: true as const } : {}),
      });
    } catch {
      // best-effort — never throw from cleanup
    }
  }

  function releaseLock(): void {
    issueLock.release();
  }

  // Acquire the shared issue-run lock FIRST — before registering exit handlers
  // and before any work — and signal the launcher via a handshake file. The
  // wrapper owns the lock for its whole life (#153 / #634). Acquiring before
  // the 'exit' handler is registered means a concurrent-rejection exit writes
  // no sentinel (the run never started).
  try {
    await issueLock.acquireWithTimeout(flockTimeoutMs);
  } catch (err) {
    let holder = "";
    try {
      holder = fs.readFileSync(lp, "utf8").trim();
    } catch {
      /* lock vanished between the failed acquire and this read */
    }
    try {
      fs.writeFileSync(path.join(runDirPath, LOCK_FAILED_FILE), holder);
    } catch {
      /* best-effort handshake */
    }
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  try {
    // pid + starttime so coexistence probes can reject recycled PIDs (#770).
    fs.writeFileSync(path.join(runDirPath, LOCK_ACQUIRED_FILE), formatProcessIdentityMarker());
  } catch {
    /* best-effort handshake — the launcher's wait will time out and clean up */
  }

  // 'exit' fires on process.exit() but NOT on SIGKILL. SIGTERM is handled below.
  process.on("exit", (code) => {
    doWriteSentinel(code ?? 1);
    releaseLock();
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`detach wrapper: uncaught exception: ${err}\n`);
    doWriteSentinel(1);
    releaseLock();
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    if (innerProcess) innerProcess.kill("SIGTERM");
    doWriteSentinel(143);
    releaseLock();
    process.exit(143);
  });

  // Watchdog timer.
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeout !== undefined) {
    watchdogTimer = setTimeout(() => {
      // Write sentinel BEFORE sending SIGKILL (SIGKILL cannot be caught).
      doWriteSentinel(-1, true);
      releaseLock();
      // Kill the entire process TREE, not just the wrapper's own group: pipeline
      // steps spawn shell/setup/harness work in their own process groups, which a
      // bare `kill(-process.pid)` would leave running after the timeout sentinel.
      killProcessTree(process.pid, "SIGKILL");
      process.exit(-1);
    }, timeout * 1000);
    // Don't keep the event loop alive solely for the watchdog.
    watchdogTimer.unref();
  }

  // Spawn the inner pipeline run. Mark the issue-run lock as held by this
  // wrapper so the child's withLock skips re-acquire (#634 dual-entry share).
  const pipelineTs = fileURLToPath(new URL("./pipeline.ts", import.meta.url));
  const innerArgs = [
    "--experimental-strip-types",
    pipelineTs,
    String(issueNumber),
    // Ensure domain reaches the inner process even if the launcher omitted
    // --domain from pipelinePassArgs (we always have it for the lock).
    ...(pipelinePassArgs.includes("--domain")
      ? pipelinePassArgs
      : ["--domain", domain, ...pipelinePassArgs]),
  ];

  innerProcess = spawn(process.execPath, innerArgs, {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      [ISSUE_RUN_LOCK_HELD_ENV]: issueRunLockHeldToken(domain, issueNumber),
    },
  });

  const exitCode = await new Promise<number>((resolve) => {
    innerProcess!.on("close", (code) => resolve(code ?? 1));
    innerProcess!.on("error", () => resolve(1));
  });

  if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);

  // process.on('exit') writes the sentinel via doWriteSentinel(exitCode).
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

if (process.argv[2] === "_wrapper") {
  runWrapper(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`detach wrapper: ${err}\n`);
    process.exit(1);
  });
}
