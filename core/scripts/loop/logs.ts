// `pipeline loop logs` (#666, capability `loop-logs-follow`): read-only dump
// or follow of a durable loop run's append-only events.jsonl under the loop
// state home. Path resolution is single-sourced with the durable loop store
// (`resolveStateHome` / `runDir`); no lock, ledger write, or GitHub call.

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
   * Follow `logFile` (tail semantics). Resolves with the child exit code when
   * follow ends (interrupt, error, or child exit). Must not hang forever when
   * the file is absent or the starter fails — fail closed with a non-zero code.
   */
  followFile(logFile: string): Promise<number | null>;
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
 * Dump or follow a durable loop run's events.jsonl.
 *
 * - No run-id → list available loop run ids (exit 0; empty home is friendly).
 * - One-shot → print full current events.jsonl (always events.jsonl; `--events`
 *   is accepted for parity but does not change the selected artifact).
 * - `--follow` → stream new lines until interrupt (SIGINT/SIGTERM) or follow
 *   failure. Does **not** auto-exit on a terminal stop event (matches advance
 *   `pipeline logs --follow`).
 *
 * Read-only: acquires no durable loop lock and writes no run artifacts.
 */
export async function runLoopLogs(
  runId: string | undefined,
  follow: boolean,
  deps: LoopLogsDeps = defaultLoopLogsDeps(),
): Promise<void> {
  const home = resolveStateHome({ env: deps.env, hostname: () => "unused" });

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
        `  Follow mode streams until interrupt (SIGINT/SIGTERM); it does not ` +
        `auto-exit on terminal stop events.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Follow stops on interrupt or follow failure — not on loop_run_stopped.
  const code = await deps.followFile(eventsFile);
  if (code !== null && code !== 0) {
    process.exitCode = code;
  }
}

/** Real-filesystem + `tail -f` defaults. Follow inherits stdio so operators see
 *  lines as they are appended; the process remains open until interrupt. */
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
    followFile(logFile) {
      return new Promise<number | null>((resolve) => {
        const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" });
        tail.on("error", (err) => {
          process.stderr.write(`pipeline loop logs: failed to start tail: ${err.message}\n`);
          process.exitCode = 1;
          resolve(1);
        });
        tail.on("exit", (code) => {
          resolve(code);
        });
      });
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
