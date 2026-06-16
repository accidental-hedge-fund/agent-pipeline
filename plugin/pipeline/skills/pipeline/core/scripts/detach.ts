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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
};

const defaultSpawnDeps: SpawnDetachedDeps = {
  homedir: os.homedir,
  now: () => Date.now(),
  pid: () => process.pid,
  spawn,
};

// ---------------------------------------------------------------------------
// Path helpers (exported for tests)
// ---------------------------------------------------------------------------

export function issueRunsDir(homedir: string, issue: number): string {
  return path.join(homedir, ".pipeline", "runs", String(issue));
}

export function lockFilePath(homedir: string, issue: number): string {
  return path.join(issueRunsDir(homedir, issue), ".lock");
}

export function makeRunDir(homedir: string, issue: number, ts: string): string {
  return path.join(issueRunsDir(homedir, issue), ts);
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
// Advisory lock helpers
// ---------------------------------------------------------------------------

/** Atomically create the lock file with own PID. Returns true on success. */
function tryWriteLock(lp: string): boolean {
  try {
    const fd = fs.openSync(lp, "wx");
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Returns true when the process recorded in the lock file is alive. */
function lockHolderAlive(lp: string): boolean {
  let pidText: string;
  try {
    pidText = fs.readFileSync(lp, "utf8").trim();
  } catch {
    return false; // file vanished — not held
  }
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // alive
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = alive but permission denied
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeStaleLock(lp: string): void {
  try {
    fs.unlinkSync(lp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Acquire the advisory lock, retrying until timeoutMs elapses.
 * Throws with a human-readable message if the lock cannot be acquired.
 */
async function acquireLock(lp: string, issue: number, timeoutMs: number): Promise<void> {
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryWriteLock(lp)) return;
    // Lock held — check liveness.
    if (!lockHolderAlive(lp)) {
      removeStaleLock(lp);
      continue; // retry immediately
    }
    if (Date.now() >= deadline) {
      let holder = "";
      try {
        holder = ` (held by PID ${fs.readFileSync(lp, "utf8").trim()})`;
      } catch {}
      throw new Error(
        `pipeline: issue #${issue} is already running${holder}. ` +
          `Wait for the run to finish or remove ${lp} if it is stale.`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 200));
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
 * The advisory lock is acquired HERE (in the foreground) so a concurrent
 * second invocation for the same issue fails non-zero before the first call
 * returns. After spawning the wrapper, the lock file is updated with the
 * child's PID so the child's lifetime holds the lock.
 *
 * Returns the run-directory path (for the caller to print) and the wrapper PID.
 */
export async function spawnDetached(
  issueNumber: number,
  pipelineArgs: string[],
  opts: SpawnDetachedOpts = {},
  deps: SpawnDetachedDeps = defaultSpawnDeps,
): Promise<SpawnDetachedResult> {
  const { timeout, flockTimeoutMs = 5000 } = opts;
  const home = deps.homedir();

  // Acquire the advisory lock in the foreground so a concurrent second call
  // fails with a clear error before this function returns.
  const lp = lockFilePath(home, issueNumber);
  await acquireLock(lp, issueNumber, flockTimeoutMs);

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
  const rd = makeRunDir(home, issueNumber, ts);
  fs.mkdirSync(rd, { recursive: true });
  if (fs.existsSync(path.join(rd, "sentinel.json"))) {
    removeStaleLock(lp);
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
    "--flock-timeout",
    String(flockTimeoutMs),
    "--lock-pre-acquired", // foreground already holds the lock
    ...(timeout !== undefined ? ["--timeout", String(timeout)] : []),
    ...(pipelineArgs.length > 0 ? ["--", ...pipelineArgs] : []),
  ];

  const child = deps.spawn(process.execPath, wrapperArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  fs.closeSync(logFd);

  if (child.pid === undefined) {
    // Spawn failed — release the lock we held.
    removeStaleLock(lp);
    throw new Error(`pipeline: failed to spawn detached process for #${issueNumber}`);
  }

  // Transfer lock ownership to the child process. The wrapper will clean up
  // the lock file on every exit path; it skips re-acquisition (--lock-pre-acquired).
  fs.writeFileSync(lp, String(child.pid));

  child.unref();
  return { runDir: rd, pid: child.pid };
}

// ---------------------------------------------------------------------------
// Wrapper mode — entry point when argv[2] === '_wrapper'
// ---------------------------------------------------------------------------

export async function runWrapper(argv: string[]): Promise<void> {
  // Parse: _wrapper --run-dir <dir> --issue <N> [--timeout <s>] [--flock-timeout <ms>]
  //        [--lock-pre-acquired] [-- args...]
  const args = argv.slice(1); // skip '_wrapper'
  let runDirPath = "";
  let issueNumber = 0;
  let timeout: number | undefined;
  let flockTimeoutMs = 5000;
  let lockPreAcquired = false;
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
    } else if (a === "--timeout") {
      timeout = Number(args[++i]);
    } else if (a === "--flock-timeout") {
      flockTimeoutMs = Number(args[++i]);
    } else if (a === "--lock-pre-acquired") {
      lockPreAcquired = true;
    }
    i++;
  }

  if (!runDirPath || !issueNumber) {
    process.stderr.write("detach wrapper: missing --run-dir or --issue\n");
    process.exit(1);
  }

  const home = os.homedir();
  const lp = lockFilePath(home, issueNumber);
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

  // 'exit' fires on process.exit() but NOT on SIGKILL. SIGTERM is handled below.
  process.on("exit", (code) => {
    doWriteSentinel(code ?? 1);
    removeStaleLock(lp);
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`detach wrapper: uncaught exception: ${err}\n`);
    doWriteSentinel(1);
    removeStaleLock(lp);
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    if (innerProcess) innerProcess.kill("SIGTERM");
    doWriteSentinel(143);
    removeStaleLock(lp);
    process.exit(143);
  });

  // Acquire the advisory lock (skipped when the foreground launcher already holds it).
  if (!lockPreAcquired) {
    try {
      await acquireLock(lp, issueNumber, flockTimeoutMs);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      // No sentinel: lock acquisition failure means the run never started.
      process.exit(1);
    }
  }

  // Watchdog timer.
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeout !== undefined) {
    watchdogTimer = setTimeout(() => {
      // Write sentinel BEFORE sending SIGKILL (SIGKILL cannot be caught).
      doWriteSentinel(-1, true);
      removeStaleLock(lp);
      try {
        // Kill the entire process group (wrapper + inner pipeline).
        process.kill(-process.pid, "SIGKILL");
      } catch {}
      process.exit(-1);
    }, timeout * 1000);
    // Don't keep the event loop alive solely for the watchdog.
    watchdogTimer.unref();
  }

  // Spawn the inner pipeline run.
  const pipelineTs = fileURLToPath(new URL("./pipeline.ts", import.meta.url));
  const innerArgs = [
    "--experimental-strip-types",
    pipelineTs,
    String(issueNumber),
    ...pipelinePassArgs,
  ];

  innerProcess = spawn(process.execPath, innerArgs, {
    stdio: ["ignore", "inherit", "inherit"],
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
