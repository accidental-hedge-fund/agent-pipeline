// `pipeline loop logs` (#666 / #699, capability `loop-logs-follow`): read-only
// dump or follow of a durable loop run's append-only events.jsonl under the
// loop state home. Path resolution is single-sourced with the durable loop
// store (`resolveStateHome` / `runDir`); no lock, ledger write, or GitHub call.
//
// Follow default (#699): exit successfully after printing a terminal loop
// lifecycle event. Opt out with `--no-until-terminal` for interrupt-only dashboards.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopError } from "./types.ts";
import {
  PIPELINE_STATE_HOME_ENV,
  resolveStateHome,
  runDir,
  type LoopStoreDeps,
} from "./store.ts";

/** Event kind written by the durable loop supervisor when a run stops. */
export const LOOP_RUN_STOPPED_KIND = "loop_run_stopped";
/** Final accounting event written when one supervisor drive resolves, stops, or holds. */
export const LOOP_RUN_COMPLETE_KIND = "loop_run_complete";
/** A new drive incarnation; resets a prior resumable hold completion for follow. */
export const LOOP_DRIVE_STARTED_KIND = "loop_drive_started";

/**
 * Advance run-store completion event type (writers in `run-store.ts` emit
 * `{ type: "run_complete", ... }` — field is `type`, not loop's `kind`).
 */
export const ADVANCE_RUN_COMPLETE_TYPE = "run_complete";

/** Options for {@link runLoopLogs} follow mode. */
export interface LoopLogsFollowOptions {
  /**
   * When true (default with `--follow`), exit 0 after a complete JSONL line
   * whose event kind is `loop_run_stopped` or `loop_run_complete` is printed. When false
   * (`--no-until-terminal`), remain open until interrupt / follow failure.
   * Ignored when follow is false.
   */
  untilTerminal?: boolean;
}

/** Injectable I/O seam for {@link runLoopLogs}. Unit tests inject fakes; no
 *  real filesystem, network, git, or `tail` process is required. */
export interface LoopLogsDeps {
  env: NodeJS.ProcessEnv;
  fsExists(p: string): Promise<boolean>;
  readTextFile(p: string): Promise<string | null>;
  listDir(p: string): Promise<string[]>;
  /** mtime ms for list ordering; `null` when the path is unstatable. */
  mtimeMs(p: string): Promise<number | null>;
  /**
   * Follow `logFile` (line-streaming semantics). Resolves with the child/follow
   * exit code when follow ends (terminal event when untilTerminal, interrupt,
   * error, or child exit). Must not hang forever when the file is absent or
   * the starter fails — fail closed with a non-zero code.
   */
  followFile(
    logFile: string,
    opts?: { untilTerminal?: boolean },
  ): Promise<number | null>;
  stdoutWrite(s: string): void;
  stderrWrite(s: string): void;
}

/** Absolute path to a durable loop run's events.jsonl (via store runDir). */
export function loopEventsPath(
  deps: Pick<LoopStoreDeps, "env" | "hostname">,
  runId: string,
): string {
  return path.join(runDir(deps, runId), "events.jsonl");
}

/** List durable loop run ids under `<state-home>/runs/`, most recent first
 *  when mtime is available. Returns [] when the runs root is absent/empty. */
export async function listLoopRunIds(deps: LoopLogsDeps): Promise<string[]> {
  const root = path.join(resolveStateHome({ env: deps.env, hostname: () => "unused" }), "runs");
  let names: string[];
  try {
    names = await deps.listDir(root);
  } catch {
    return [];
  }
  // Filter path-unsafe names without ever joining them as path segments into
  // a traversal (mirrors store assertSafeRunId).
  const SAFE = /^[A-Za-z0-9._-]+$/;
  const candidates = names.filter((n) => SAFE.test(n) && n !== "." && n !== "..");
  const withMtime = await Promise.all(
    candidates.map(async (name) => {
      const dir = path.join(root, name);
      const exists = await deps.fsExists(dir);
      if (!exists) return null;
      const mtime = (await deps.mtimeMs(dir)) ?? 0;
      return { name, mtime };
    }),
  );
  return withMtime
    .filter((x): x is { name: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.name);
}

/**
 * True when `line` is a complete JSONL record whose event kind is
 * `loop_run_stopped`. Malformed / non-JSON / wrong-kind lines return false
 * (callers keep streaming). Matches store writers: `{ seq, time, kind, data }`.
 */
export function isLoopRunStoppedLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const obj = JSON.parse(trimmed) as { kind?: unknown };
    return obj != null && typeof obj === "object" && obj.kind === LOOP_RUN_STOPPED_KIND;
  } catch {
    return false;
  }
}

/** True for a store-shaped loop completion record (uses `kind`, never `type`). */
export function isLoopRunCompleteLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const obj = JSON.parse(trimmed) as { kind?: unknown };
    return obj != null && typeof obj === "object" && obj.kind === LOOP_RUN_COMPLETE_KIND;
  } catch {
    return false;
  }
}

/** Terminal loop lifecycle predicate used by default follow. */
export function isLoopTerminalLine(line: string): boolean {
  return isLoopRunStoppedLine(line) || isLoopRunCompleteLine(line);
}

/** True when a resumed/new supervisor drive supersedes an earlier resumable completion. */
export function isLoopDriveStartedLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const obj = JSON.parse(trimmed) as { kind?: unknown };
    return obj != null && typeof obj === "object" && obj.kind === LOOP_DRIVE_STARTED_KIND;
  } catch {
    return false;
  }
}

/**
 * True when `line` is a complete JSONL advance run-store event with
 * `type: "run_complete"`. Malformed / non-JSON / wrong-type lines return false.
 */
export function isAdvanceRunCompleteLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const obj = JSON.parse(trimmed) as { type?: unknown };
    return obj != null && typeof obj === "object" && obj.type === ADVANCE_RUN_COMPLETE_TYPE;
  } catch {
    return false;
  }
}

/**
 * Append a follow chunk to a line buffer. Invokes `onLine` for each complete
 * newline-terminated line (including the trailing `\n`). Incomplete trailing
 * bytes remain in `pending`. Returns whether any complete line matched
 * `isTerminalLine` (default: loop stop/complete). A later drive-start line
 * resets a historical resumable completion when replaying the existing file.
 */
export function appendFollowChunk(
  pending: string,
  chunk: string,
  onLine: (line: string) => void,
  isTerminalLine: (line: string) => boolean = isLoopTerminalLine,
  isTerminalResetLine: (line: string) => boolean = isLoopDriveStartedLine,
): { pending: string; sawTerminal: boolean } {
  let buf = pending + chunk;
  let sawTerminal = false;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl + 1);
    buf = buf.slice(nl + 1);
    onLine(line);
    // Strip trailing newline for detection (JSON.parse of "…\n" fails).
    const forDetect = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (isTerminalResetLine(forDetect)) {
      sawTerminal = false;
    } else if (isTerminalLine(forDetect)) {
      sawTerminal = true;
    }
  }
  return { pending: buf, sawTerminal };
}

/**
 * Dump or follow a durable loop run's events.jsonl.
 *
 * - No run-id → list available loop run ids (exit 0; empty home is friendly).
 * - One-shot → print full current events.jsonl (always events.jsonl; `--events`
 *   is accepted for parity but does not change the selected artifact).
 * - `--follow` → stream lines (existing + newly appended). **Default**
 *   until-terminal: exit 0 after printing a loop stop/completion line (historical
 *   or live). `--no-until-terminal` restores interrupt-only follow.
 *   SIGINT/SIGTERM remain valid stop conditions in both modes.
 *
 * Read-only: acquires no durable loop lock and writes no run artifacts.
 */
export async function runLoopLogs(
  runId: string | undefined,
  follow: boolean,
  deps: LoopLogsDeps = defaultLoopLogsDeps(),
  followOpts: LoopLogsFollowOptions = {},
): Promise<void> {
  const home = resolveStateHome({ env: deps.env, hostname: () => "unused" });
  // Default until-terminal ON whenever follow is requested (#699).
  const untilTerminal = followOpts.untilTerminal !== false;

  if (runId === undefined) {
    const ids = await listLoopRunIds(deps);
    if (ids.length === 0) {
      deps.stdoutWrite(`No loop runs found in ${path.join(home, "runs")}.\n`);
      return;
    }
    for (const id of ids) deps.stdoutWrite(`${id}\n`);
    return;
  }

  let dir: string;
  let eventsFile: string;
  try {
    dir = runDir({ env: deps.env, hostname: () => "unused" }, runId);
    eventsFile = path.join(dir, "events.jsonl");
  } catch (err) {
    const msg = err instanceof LoopError ? err.message : (err as Error).message;
    deps.stderrWrite(`pipeline loop logs: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await deps.fsExists(dir))) {
    deps.stderrWrite(
      `pipeline loop logs: unknown run-id '${runId}'\n` +
        `  Expected: ${path.join(home, "runs", runId)}/\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!follow) {
    const content = await deps.readTextFile(eventsFile);
    if (content === null) {
      deps.stderrWrite(
        `pipeline loop logs: events.jsonl not yet written for run '${runId}'\n` +
          `  Path: ${eventsFile}\n`,
      );
      process.exitCode = 1;
      return;
    }
    deps.stdoutWrite(content);
    return;
  }

  // Pre-check so follow fails closed when the stream cannot start (no hang).
  if (!(await deps.fsExists(eventsFile))) {
    deps.stderrWrite(
      `pipeline loop logs: events.jsonl not yet written for run '${runId}'\n` +
        `  Path: ${eventsFile}\n` +
        `  Follow mode streams event lines; by default it exits 0 after ` +
        `loop_run_stopped/loop_run_complete (use --no-until-terminal for interrupt-only).\n`,
    );
    process.exitCode = 1;
    return;
  }

  const code = await deps.followFile(eventsFile, { untilTerminal });
  if (code !== null && code !== 0) {
    process.exitCode = code;
  }
}

/**
 * Spawn `tail -f` and keep the child wired to parent SIGINT/SIGTERM so a
 * direct signal to the Node CLI does not orphan the follower (#666 review).
 * Handlers are one-shot and removed when follow settles (child exit, error,
 * or interrupt). Resolves with conventional shell status 130 (SIGINT) /
 * 143 (SIGTERM) when interrupted; otherwise the child exit code.
 *
 * Used for interrupt-only follow (`--no-until-terminal`). The default
 * until-terminal path uses {@link followEventsWithTerminalExit} instead so
 * lines can be inspected for terminal loop lifecycle events.
 *
 * `io.spawn` / `io.process` are injectable for unit tests — no real process
 * or signal is required.
 */
export type FollowFileSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit" },
) => {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): void;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
};

export type FollowFileProcess = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  stderr: { write(s: string): void };
};

export function followFileWithSignalCleanup(
  logFile: string,
  io: {
    spawn?: FollowFileSpawn;
    process?: FollowFileProcess;
  } = {},
): Promise<number | null> {
  const doSpawn: FollowFileSpawn =
    io.spawn ??
    ((command, args, options) =>
      spawn(command, [...args], options) as ReturnType<FollowFileSpawn>);
  const proc: FollowFileProcess = io.process ?? process;

  return new Promise<number | null>((resolve) => {
    let settled = false;
    let interrupted: NodeJS.Signals | null = null;
    // Populated before any signal can fire (handlers installed after spawn).
    let onSigint: () => void = () => {};
    let onSigterm: () => void = () => {};

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      proc.removeListener("SIGINT", onSigint);
      proc.removeListener("SIGTERM", onSigterm);
      resolve(code);
    };

    const interruptStatus = (sig: NodeJS.Signals): number =>
      sig === "SIGINT" ? 130 : 143;

    let tail: ReturnType<FollowFileSpawn>;
    try {
      tail = doSpawn("tail", ["-f", logFile], { stdio: "inherit" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      proc.stderr.write(`pipeline loop logs: failed to start tail: ${msg}\n`);
      settle(1);
      return;
    }

    const onParentSignal = (sig: NodeJS.Signals) => {
      if (settled || interrupted) return;
      interrupted = sig;
      // One-shot: do not re-enter; exit path settles after the child dies.
      proc.removeListener("SIGINT", onSigint);
      proc.removeListener("SIGTERM", onSigterm);
      try {
        tail.kill(sig);
      } catch {
        // Child already gone — still report interrupted status.
        settle(interruptStatus(sig));
      }
    };
    onSigint = () => onParentSignal("SIGINT");
    onSigterm = () => onParentSignal("SIGTERM");

    proc.on("SIGINT", onSigint);
    proc.on("SIGTERM", onSigterm);

    tail.on("error", (err) => {
      proc.stderr.write(`pipeline loop logs: failed to start tail: ${err.message}\n`);
      settle(1);
    });
    tail.on("exit", (code, signal) => {
      if (interrupted) {
        settle(interruptStatus(interrupted));
        return;
      }
      if (signal === "SIGINT") {
        settle(130);
        return;
      }
      if (signal === "SIGTERM") {
        settle(143);
        return;
      }
      settle(code);
    });
  });
}

/** Injectable I/O for {@link followEventsWithTerminalExit} (unit tests). */
export type FollowEventsIo = {
  /** Read next available bytes from `offset`; empty string when nothing new. */
  readFrom(path: string, offset: number): Promise<{ data: string; nextOffset: number }>;
  /** Wait until the file may have grown, or until aborted. */
  waitForMore(path: string, signal: AbortSignal): Promise<void>;
  stdoutWrite(s: string): void;
  stderrWrite(s: string): void;
  process: FollowFileProcess;
};

/**
 * Line-aware follow: print complete lines, optionally exit 0 when a line
 * matches `isTerminalLine` (default: loop stop/completion; advance
 * `run_complete` via {@link isAdvanceRunCompleteLine}). Reads existing content
 * from offset 0 first (historical terminal ends follow without hanging).
 * Incomplete trailing bytes are buffered until a newline arrives.
 */
export async function followEventsWithTerminalExit(
  logFile: string,
  opts: {
    untilTerminal: boolean;
    /** Default: {@link isLoopTerminalLine}. */
    isTerminalLine?: (line: string) => boolean;
    /** Prefix for read-failure diagnostics (default: pipeline loop logs). */
    errorLabel?: string;
  },
  io: FollowEventsIo,
): Promise<number | null> {
  const proc = io.process;
  const ac = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  let onSigint: () => void = () => {};
  let onSigterm: () => void = () => {};
  const isTerminalLine = opts.isTerminalLine ?? isLoopTerminalLine;
  const errorLabel = opts.errorLabel ?? "pipeline loop logs";

  const interruptStatus = (sig: NodeJS.Signals): number =>
    sig === "SIGINT" ? 130 : 143;

  const cleanup = () => {
    ac.abort();
    proc.removeListener("SIGINT", onSigint);
    proc.removeListener("SIGTERM", onSigterm);
  };

  onSigint = () => {
    if (interrupted) return;
    interrupted = "SIGINT";
    ac.abort();
  };
  onSigterm = () => {
    if (interrupted) return;
    interrupted = "SIGTERM";
    ac.abort();
  };
  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);

  let offset = 0;
  let pending = "";

  try {
    for (;;) {
      if (interrupted) return interruptStatus(interrupted);

      let batch: { data: string; nextOffset: number };
      try {
        batch = await io.readFrom(logFile, offset);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderrWrite(`${errorLabel}: failed to read events: ${msg}\n`);
        return 1;
      }

      if (batch.data.length > 0) {
        offset = batch.nextOffset;
        const result = appendFollowChunk(
          pending,
          batch.data,
          (line) => {
            io.stdoutWrite(line);
          },
          isTerminalLine,
        );
        pending = result.pending;
        if (opts.untilTerminal && result.sawTerminal) {
          return 0;
        }
      }

      if (interrupted) return interruptStatus(interrupted);

      try {
        await io.waitForMore(logFile, ac.signal);
      } catch {
        // Aborted via signal — loop re-checks interrupted.
      }
    }
  } finally {
    cleanup();
  }
}

/** Production read/poll I/O for {@link followEventsWithTerminalExit}. */
export function defaultFollowEventsIo(
  env: {
    stdoutWrite?: (s: string) => void;
    stderrWrite?: (s: string) => void;
    process?: FollowFileProcess;
    pollMs?: number;
  } = {},
): FollowEventsIo {
  const pollMs = env.pollMs ?? 100;
  const proc: FollowFileProcess = env.process ?? process;
  return {
    async readFrom(filePath, offset) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, "r");
        const st = fs.fstatSync(fd);
        if (st.size <= offset) {
          return { data: "", nextOffset: offset };
        }
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, offset);
        return {
          data: buf.subarray(0, n).toString("utf8"),
          nextOffset: offset + n,
        };
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore close errors
          }
        }
      }
    },
    waitForMore(_path, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, pollMs);
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    stdoutWrite: env.stdoutWrite ?? ((s) => process.stdout.write(s)),
    stderrWrite: env.stderrWrite ?? ((s) => process.stderr.write(s)),
    process: proc,
  };
}

/** Real-filesystem defaults. Follow is line-aware; until-terminal is default. */
export function defaultLoopLogsDeps(env: NodeJS.ProcessEnv = process.env): LoopLogsDeps {
  return {
    env,
    async fsExists(p) {
      return fs.existsSync(p);
    },
    async readTextFile(p) {
      try {
        return await fs.promises.readFile(p, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async listDir(p) {
      try {
        return await fs.promises.readdir(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
    async mtimeMs(p) {
      try {
        const st = await fs.promises.stat(p);
        return st.mtime.getTime();
      } catch {
        return null;
      }
    },
    followFile(logFile, opts) {
      const untilTerminal = opts?.untilTerminal !== false;
      if (!untilTerminal) {
        // Interrupt-only: pure tail -f (no line inspection required).
        return followFileWithSignalCleanup(logFile);
      }
      return followEventsWithTerminalExit(
        logFile,
        { untilTerminal: true },
        defaultFollowEventsIo(),
      );
    },
    stdoutWrite(s) {
      process.stdout.write(s);
    },
    stderrWrite(s) {
      process.stderr.write(s);
    },
  };
}

/** Re-export the env override name for diagnostics/tests. */
export { PIPELINE_STATE_HOME_ENV };
