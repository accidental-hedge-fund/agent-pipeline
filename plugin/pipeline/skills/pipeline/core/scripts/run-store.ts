// Run-store (#155): stable run directory, append-only event log, and run artifacts.
//
// Layout: <repoDir>/.agent-pipeline/runs/<run-id>/
//   run.json      – immutable identity metadata (written once at initRunDir)
//   events.jsonl  – append-only O_APPEND event log (one JSON object per line)
//   terminal.log  – raw combined stdout/stderr (tee started after initRunDir)
//   summary.json  – finalized evidence bundle (written at finalizeRun)
//
// All writes are non-fatal: I/O errors are caught and logged. Readers tolerate
// missing files, corrupt tail lines, and unknown fields (forward-compat).

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvidenceBundle } from "./types.ts";
import { redactSecrets, sanitize, sanitizeDeep } from "./artifact-sanitize.ts";

export const RUN_SCHEMA_VERSION = 1;

export type RunId = string;

/** Produce the run-id from issue number and dispatch start time.
 *  Format: `<issue>-<YYYY-MM-DDTHH-MM-SSZ>` (filesystem-safe; colons replaced with hyphens). */
export function runIdFor(issue: number, startedAt: Date): RunId {
  const iso = startedAt.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return `${issue}-${iso}`;
}

/** Root directory that holds all run subdirectories for a repo. */
export function runsDir(repoDir: string): string {
  return path.join(repoDir, ".agent-pipeline", "runs");
}

/** Absolute path of a single run's directory. */
export function runDirPath(repoDir: string, runId: RunId): string {
  return path.join(runsDir(repoDir), runId);
}

// ---------------------------------------------------------------------------
// Event types — all carry schema_version, type, at
// ---------------------------------------------------------------------------

interface RunEventBase {
  schema_version: number;
  type: string;
  at: string;
}

export interface RunStartEvent extends RunEventBase {
  type: "run_start";
  run_id: RunId;
  issue: number;
  repo: string;
}
export interface RunCompleteEvent extends RunEventBase {
  type: "run_complete";
  final_state: string;
  elapsed_ms: number;
}
export interface StageStartEvent extends RunEventBase {
  type: "stage_start";
  stage: string;
}
export interface StageCompleteEvent extends RunEventBase {
  type: "stage_complete";
  stage: string;
  outcome: string;
}
export interface PrCreatedEvent extends RunEventBase {
  type: "pr_created";
  pr: number;
}
export interface PrUpdatedEvent extends RunEventBase {
  type: "pr_updated";
  pr: number;
}
export interface WorktreeCreatedEvent extends RunEventBase {
  type: "worktree_created";
  _localPath: string;
}
export interface WorktreeRemovedEvent extends RunEventBase {
  type: "worktree_removed";
  _localPath: string;
}
export interface ReviewVerdictEvent extends RunEventBase {
  type: "review_verdict";
  round: number;
  sha: string;
  verdict: string;
  finding_counts: Record<string, number>;
}
export interface BlockerSetEvent extends RunEventBase {
  type: "blocker_set";
  reason: string;
}
export interface BlockerClearedEvent extends RunEventBase {
  type: "blocker_cleared";
}

export type RunEvent =
  | RunStartEvent
  | RunCompleteEvent
  | StageStartEvent
  | StageCompleteEvent
  | PrCreatedEvent
  | PrUpdatedEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | ReviewVerdictEvent
  | BlockerSetEvent
  | BlockerClearedEvent;

// ---------------------------------------------------------------------------
// Deps — injectable I/O seam; unit tests inject in-memory fakes
// ---------------------------------------------------------------------------

export interface RunStoreDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  /** Append to file using O_APPEND semantics (create if absent). */
  appendFile: (p: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat: (p: string) => Promise<{ mtime: Date }>;
  /** When set, each appended event line is also passed here (--json-events mode). */
  stdoutWrite?: (line: string) => void;
}

export const defaultRunStoreDeps: RunStoreDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  readdir: async (p) => {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries as Array<{ name: string; isDirectory(): boolean }>;
  },
  stat: (p) => fsp.stat(p),
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// initRunDir
// ---------------------------------------------------------------------------

export interface RunMeta {
  schema_version: number;
  run_id: RunId;
  issue: number;
  repo: string;
  profile: string | null;
  started_at: string;
}

export interface InitRunDirOpts {
  runDir: string;
  runId: RunId;
  issue: number;
  repo: string;
  profile: string | null;
  startedAt: string;
}

/** Create the run directory, write run.json, create events.jsonl, append run_start.
 *  Non-fatal: I/O errors are caught and logged. */
export async function initRunDir(
  opts: InitRunDirOpts,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    await deps.mkdir(opts.runDir, { recursive: true });

    const meta: RunMeta = {
      schema_version: RUN_SCHEMA_VERSION,
      run_id: opts.runId,
      issue: opts.issue,
      repo: opts.repo,
      profile: opts.profile,
      started_at: opts.startedAt,
    };
    await deps.writeFile(
      path.join(opts.runDir, "run.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
    );

    // Create empty events.jsonl
    await deps.writeFile(path.join(opts.runDir, "events.jsonl"), "");

    // Append the run_start event
    const event: RunStartEvent = {
      schema_version: RUN_SCHEMA_VERSION,
      type: "run_start",
      at: opts.startedAt,
      run_id: opts.runId,
      issue: opts.issue,
      repo: opts.repo,
    };
    await appendEvent(opts.runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: initRunDir failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

/** Append a JSON event line to events.jsonl. Non-fatal on I/O error.
 *  If deps.stdoutWrite is set, also passes the line there (--json-events mode). */
export async function appendEvent(
  runDir: string,
  event: RunEvent,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  try {
    await deps.appendFile(path.join(runDir, "events.jsonl"), line);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: appendEvent failed (non-fatal): ${(err as Error).message}`,
    );
    return;
  }
  if (deps.stdoutWrite) {
    deps.stdoutWrite(line);
  }
}

// ---------------------------------------------------------------------------
// readEvents
// ---------------------------------------------------------------------------

/** Read events.jsonl: missing file → []; corrupt or partial tail line → skipped;
 *  unknown fields → preserved unchanged (forward-compat). */
export async function readEvents(
  runDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await deps.readFile(path.join(runDir, "events.jsonl"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as RunEvent);
    } catch {
      // Partial or corrupt line (e.g. from a mid-write crash) — skip silently
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// finalizeRun
// ---------------------------------------------------------------------------

/** Finalize the run: append run_complete, write summary.json, write legacy evidence.json.
 *  summary.json and legacy write are atomic (tmp + rename). Legacy write failure is non-fatal. */
export async function finalizeRun(
  runDir: string,
  bundle: EvidenceBundle,
  stateDir: string,
  issue: number,
  startedAt: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const now = nowIso();
  const startMs = Date.parse(startedAt);
  const elapsedMs = Number.isFinite(startMs) ? Date.parse(now) - startMs : 0;

  // Append run_complete before writing summary.json
  const completeEvent: RunCompleteEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "run_complete",
    at: now,
    final_state: bundle.finalState ?? "unknown",
    elapsed_ms: elapsedMs,
  };
  await appendEvent(runDir, completeEvent, deps);

  // Serialize bundle — same sanitization as evidence-bundle.ts writeBundle
  const summaryWithVersion = { ...bundle, schema_version: RUN_SCHEMA_VERSION };
  const cleanedBundle = sanitizeDeep(summaryWithVersion);
  const serialized = sanitize(redactSecrets(`${JSON.stringify(cleanedBundle, null, 2)}\n`));

  // Write summary.json atomically
  const summaryPath = path.join(runDir, "summary.json");
  try {
    const tmp = `${summaryPath}.tmp`;
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, summaryPath);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: summary.json write failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Write legacy evidence.json (non-fatal; keeps existing consumers working)
  const legacyDir = path.join(stateDir, String(issue));
  const legacyPath = path.join(legacyDir, "evidence.json");
  try {
    await deps.mkdir(legacyDir, { recursive: true });
    const tmp = `${legacyPath}.tmp`;
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, legacyPath);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: legacy evidence.json write failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// listRunIds — for `pipeline logs` (no-arg form)
// ---------------------------------------------------------------------------

/** List run-ids available in .agent-pipeline/runs/, sorted by mtime descending.
 *  Returns [] when the directory is absent or empty. */
export async function listRunIds(
  repoDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<string[]> {
  const dir = runsDir(repoDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const withMtime = await Promise.all(
    dirs.map(async (e) => {
      try {
        const st = await deps.stat(path.join(dir, e.name));
        return { name: e.name, mtime: st.mtime.getTime() };
      } catch {
        return { name: e.name, mtime: 0 };
      }
    }),
  );

  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Terminal log tee — patches process.stdout/stderr to mirror output to a file.
// Separate from the injectable deps pattern: this operates on global process state.
// ---------------------------------------------------------------------------

export interface TerminalLogTee {
  /** Write directly to the original stdout, bypassing terminal.log.
   *  Used by --json-events mode so JSON event lines are not captured in terminal.log. */
  rawWrite: (chunk: string) => void;
  /** Restore the original write functions and close the log stream. */
  stop(): Promise<void>;
}

/** Start a tee that mirrors process.stdout and process.stderr to terminal.log at logPath.
 *  Returns a handle with rawWrite (for --json-events bypass) and stop().
 *  The logPath directory must exist before calling this function. */
export function startTerminalLogTee(logPath: string): TerminalLogTee {
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  // Save originals before patching
  const origStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const origStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;

  function makePatch(
    orig: typeof origStdoutWrite,
  ): typeof origStdoutWrite {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (...args: any[]): boolean {
      const [chunk, enc] = args;
      if (typeof chunk === "string") {
        logStream.write(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8");
      } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        logStream.write(chunk as Buffer);
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return (orig as (...a: any[]) => boolean)(...args);
    } as typeof origStdoutWrite;
  }

  (process.stdout as { write: typeof origStdoutWrite }).write = makePatch(origStdoutWrite);
  (process.stderr as { write: typeof origStderrWrite }).write = makePatch(origStderrWrite);

  return {
    rawWrite(chunk: string): void {
      origStdoutWrite(chunk);
    },
    stop(): Promise<void> {
      (process.stdout as { write: typeof origStdoutWrite }).write = origStdoutWrite;
      (process.stderr as { write: typeof origStderrWrite }).write = origStderrWrite;
      return new Promise<void>((resolve) => {
        logStream.end(() => resolve());
      });
    },
  };
}
