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

/**
 * Signal descendant process groups of `rootPid` **excluding** the root process's
 * own group. Used on abnormal wrapper shutdown so the wrapper stays alive long
 * enough to confirm children are gone and only then release the issue-run lock
 * (SIGKILL of the wrapper's own group would skip exit handlers — #634 review 2).
 */
export function killDescendantGroupsOnly(
  rootPid: number,
  signal: NodeJS.Signals,
  deps: KillTreeDeps = defaultKillTreeDeps,
): number[] {
  const table = parseProcTable(deps.snapshot());
  const self = table.find((p) => p.pid === rootPid);
  const selfPgid = self?.pgid ?? rootPid;
  const groups = descendantProcessGroups(table, rootPid).filter((g) => g !== selfPgid);
  for (const pgid of groups) deps.killGroup(pgid, signal);
  return groups;
}

/** Grace after SIGTERM before escalating to SIGKILL on abnormal wrapper shutdown. */
export const ABNORMAL_SHUTDOWN_GRACE_MS = 5_000;

/** Additional wait after SIGKILL before treating termination as unconfirmed. */
export const ABNORMAL_SHUTDOWN_HARD_WAIT_MS = 2_000;

/** Minimal child shape for {@link waitForChildClose} / {@link terminateWrapperChildren}. */
export type WaitableChild = {
  on(event: "close" | "error", cb: (...args: unknown[]) => void): unknown;
  kill?(signal?: NodeJS.Signals): boolean;
  pid?: number | undefined;
  /** Set after exit on real ChildProcess — used to detect already-exited children. */
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
};

export type WaitForChildCloseDeps = {
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/**
 * Resolve when `child` has exited (`close`/`error`, or already-set exit/signal
 * codes), or when `timeoutMs` elapses (returns false). `undefined` child → true.
 */
export function waitForChildClose(
  child: WaitableChild | undefined,
  timeoutMs: number,
  deps: WaitForChildCloseDeps = {},
): Promise<boolean> {
  if (!child) return Promise.resolve(true);
  // Already exited (close may have fired before we subscribed).
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);

  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearT(timer);
      resolve(ok);
    };
    const timer = setT(() => done(false), timeoutMs);
    child.on("close", () => done(true));
    child.on("error", () => done(true));
  });
}

export type TerminateWrapperChildrenDeps = {
  killInner: (child: WaitableChild, signal: NodeJS.Signals) => void;
  killDescendants: (rootPid: number, signal: NodeJS.Signals) => number[];
  waitForClose: (child: WaitableChild | undefined, timeoutMs: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
};

const defaultTerminateChildrenDeps: TerminateWrapperChildrenDeps = {
  killInner: (child, signal) => {
    try {
      child.kill?.(signal);
    } catch {
      /* already gone */
    }
  },
  killDescendants: (rootPid, signal) => killDescendantGroupsOnly(rootPid, signal),
  waitForClose: (child, timeoutMs) => waitForChildClose(child, timeoutMs),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Terminate the inner pipeline process and detached descendant groups, then
 * **await confirmed exit** of the inner child (grace → SIGKILL escalate).
 *
 * Does **not** kill the wrapper process itself and does **not** release the
 * issue-run lock — the caller must release only after this resolves (or leave
 * the lock for stale recovery if the wrapper cannot exit cleanly).
 *
 * Returns `"confirmed"` when the inner process is observed gone; `"unconfirmed"`
 * if the hard wait elapsed without a close event.
 */
export async function terminateWrapperChildren(
  opts: {
    inner: WaitableChild | undefined;
    wrapperPid: number;
    graceMs?: number;
    hardWaitMs?: number;
  },
  deps: Partial<TerminateWrapperChildrenDeps> = {},
): Promise<"confirmed" | "unconfirmed"> {
  const d: TerminateWrapperChildrenDeps = { ...defaultTerminateChildrenDeps, ...deps };
  const graceMs = opts.graceMs ?? ABNORMAL_SHUTDOWN_GRACE_MS;
  const hardWaitMs = opts.hardWaitMs ?? ABNORMAL_SHUTDOWN_HARD_WAIT_MS;

  if (opts.inner) d.killInner(opts.inner, "SIGTERM");
  d.killDescendants(opts.wrapperPid, "SIGTERM");

  const exitedSoft = await d.waitForClose(opts.inner, graceMs);
  if (exitedSoft) {
    // Inner is gone; still SIGKILL any detached descendant groups that outlived it.
    d.killDescendants(opts.wrapperPid, "SIGKILL");
    return "confirmed";
  }

  if (opts.inner) d.killInner(opts.inner, "SIGKILL");
  d.killDescendants(opts.wrapperPid, "SIGKILL");
  const exitedHard = await d.waitForClose(opts.inner, hardWaitMs);
  // Brief settle so kill signals can take effect before the wrapper releases.
  await d.sleep(Math.min(hardWaitMs, 250));
  return exitedHard ? "confirmed" : "unconfirmed";
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

/** Env key carrying JSON map of adapter command → absolute CLI path (#636). */
export const PIPELINE_HARNESS_CLI_PATHS_ENV = "PIPELINE_HARNESS_CLI_PATHS";

/**
 * Pack a detach-launch environment so harness CLI discovery stays equivalent
 * to the foreground launcher (#636). Never strips or replaces PATH; optionally
 * records absolute executable paths resolved before launch.
 *
 * Pure — unit-testable without a real spawn.
 */
export function packDetachHarnessEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: {
    /** Absolute paths keyed by adapter command name (or CLI id). */
    absoluteCliPaths?: Record<string, string>;
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // Explicitly preserve PATH (and empty-string PATH is still "set") so a later
  // consumer cannot treat omission as "rebuild a minimal PATH".
  if (baseEnv.PATH !== undefined) env.PATH = baseEnv.PATH;
  const paths = opts.absoluteCliPaths;
  if (paths && Object.keys(paths).length > 0) {
    env[PIPELINE_HARNESS_CLI_PATHS_ENV] = JSON.stringify(paths);
  }
  return env;
}

/**
 * Assert foreground vs detach harness-discovery parity for one command (#636).
 * Fails when foreground can resolve the command but a stripped detach PATH
 * cannot, unless an absolute path was packed for that command.
 *
 * Pure — inject `resolve` (e.g. lookup on a synthetic PATH map).
 */
export function assertHarnessDiscoveryParity(opts: {
  command: string;
  /** PATH string as seen by the foreground launcher. */
  foregroundPath: string | undefined;
  /** PATH string as packed for the detached child. */
  detachPath: string | undefined;
  /**
   * Resolve `command` under `pathEnv` to an absolute path, or null when
   * missing. Tests inject a fake; production may use `command -v` semantics.
   */
  resolve: (command: string, pathEnv: string | undefined) => string | null;
  /** Absolute path packed for this command, if any. */
  absolutePacked?: string | null;
}): { ok: true } | { ok: false; message: string } {
  const fg = opts.resolve(opts.command, opts.foregroundPath);
  if (!fg) {
    // Foreground cannot resolve either — parity holds (both missing).
    return { ok: true };
  }
  if (opts.absolutePacked && opts.absolutePacked.startsWith("/")) {
    return { ok: true };
  }
  const bg = opts.resolve(opts.command, opts.detachPath);
  if (bg) {
    // Same or different absolute path is fine as long as resolution succeeds.
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `harness discovery PATH parity failed for "${opts.command}": ` +
      `resolvable in foreground PATH but not under detach PATH, and no absolute ` +
      `executable was packed. Preserve PATH or pack the absolute path before detach.`,
  };
}

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
  /**
   * Absolute harness CLI paths resolved before launch (#636). Packed into the
   * wrapper/child environment so detached invoke does not depend on a narrower
   * PATH than the launcher.
   */
  absoluteCliPaths?: Record<string, string>;
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

  // #636: preserve harness-discovery PATH equivalence with the foreground
  // launcher; never spawn detach with a stripped/replaced PATH. Optionally
  // pack absolute CLI paths resolved before launch.
  const detachEnv = packDetachHarnessEnv(process.env, {
    absoluteCliPaths: opts.absoluteCliPaths,
  });

  const child = deps.spawn(process.execPath, wrapperArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: detachEnv,
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
  let shuttingDown = false;
  let innerProcess: ReturnType<typeof spawn> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

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

  /**
   * Abnormal paths (SIGTERM / watchdog / uncaughtException): write sentinel,
   * await confirmed child/tree termination, THEN exit so the 'exit' handler
   * releases the issue-run lock only after the inner work is gone (#634 r2).
   * Never release the lock before children are terminated — a concurrent
   * advance/detach would otherwise overlap a still-running inner pipeline.
   */
  async function beginAbnormalShutdown(exitCode: number, timedOut?: true): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
    doWriteSentinel(exitCode, timedOut);
    try {
      await terminateWrapperChildren({
        inner: innerProcess,
        wrapperPid: process.pid,
      });
    } catch {
      /* best-effort — still exit so the lock is released via 'exit' after attempt */
    }
    // Lock release happens in process.on('exit') — only after this point.
    process.exit(exitCode === -1 ? 1 : exitCode);
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

  // 'exit' fires on process.exit() but NOT on SIGKILL. SIGTERM/watchdog go
  // through beginAbnormalShutdown (await children → process.exit → here).
  process.on("exit", (code) => {
    doWriteSentinel(code ?? 1);
    releaseLock();
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`detach wrapper: uncaught exception: ${err}\n`);
    void beginAbnormalShutdown(1);
  });

  process.on("SIGTERM", () => {
    void beginAbnormalShutdown(143);
  });

  // Watchdog timer — terminate children and await exit before lock release.
  if (timeout !== undefined) {
    watchdogTimer = setTimeout(() => {
      void beginAbnormalShutdown(-1, true);
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

  // #636: inherit the wrapper env (including preserved PATH and any packed
  // absolute harness CLI paths) rather than rebuilding a minimal env.
  const innerEnv = packDetachHarnessEnv(process.env);
  innerEnv[ISSUE_RUN_LOCK_HELD_ENV] = issueRunLockHeldToken(domain, issueNumber);

  innerProcess = spawn(process.execPath, innerArgs, {
    stdio: ["ignore", "inherit", "inherit"],
    env: innerEnv,
  });

  const exitCode = await new Promise<number>((resolve) => {
    innerProcess!.on("close", (code) => resolve(code ?? 1));
    innerProcess!.on("error", () => resolve(1));
  });

  if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
  // If SIGTERM/watchdog already owns shutdown, do not race process.exit — that
  // path awaits tree termination before the shared exit-handler lock release.
  if (shuttingDown) return;

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
