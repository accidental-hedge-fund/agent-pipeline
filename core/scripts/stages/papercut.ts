// `pipeline papercut` sub-command (#419): record one agent-logged friction
// event mid-run without disturbing the run, and read papercuts back over a
// time window. Agent-facing, not human-facing — see command-registry.ts and
// the hidden-from-help wiring in pipeline.ts.
//
// The record path is a total function: it never throws, and its caller (the
// CLI boundary in pipeline.ts) always exits zero. An I/O failure here must
// never become a stage failure, a blocker, or a non-zero run outcome.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  emitPapercut as realEmitPapercut,
  runDirPath,
  runsDir,
  type PapercutEvent,
} from "../run-store.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecordPapercutOpts {
  repoDir: string;
  /** Run id — required (per the issue's documented `--run` contract). */
  run: string;
  /** Free-text friction message (the `-m/--message` flag). */
  message: string;
  /** Explicit overrides; when absent, fall back to the engine-supplied
   *  PIPELINE_* environment variables, then to null. */
  stage?: string | null;
  harness?: string | null;
  model?: string | null;
}

export interface ReportPapercutsOpts {
  repoDir: string;
  /** ISO-8601 date string — lower bound (inclusive) of the report window. */
  since: string;
  /** ISO-8601 date string — upper bound (inclusive). Unbounded when absent. */
  until?: string;
}

export interface PapercutDeps {
  /** Append one papercut event to the named run. Injectable so tests can
   *  fake/throw without touching the filesystem. */
  emitPapercut: (
    runDir: string,
    payload: {
      run_id: string;
      issue: number;
      stage: string | null;
      harness: string | null;
      model: string | null;
      message: string;
    },
  ) => Promise<void>;
  readFile: (p: string) => Promise<string>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  /** Write a non-fatal diagnostic message (stderr substitute). */
  log: (msg: string) => void;
}

export function realPapercutDeps(): PapercutDeps {
  return {
    emitPapercut: (runDir, payload) => realEmitPapercut(runDir, payload),
    readFile: (p) => fsp.readFile(p, "utf8"),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries as Array<{ name: string; isDirectory(): boolean }>;
    },
    log: (msg) => console.warn(msg),
  };
}

// ---------------------------------------------------------------------------
// recordPapercut
// ---------------------------------------------------------------------------

/** Record one papercut event for `opts.run`. Never throws — any failure
 *  (including an unreadable run.json or a throwing emitPapercut) is caught,
 *  logged via deps.log, and swallowed so the caller can always exit zero. */
export async function recordPapercut(
  opts: RecordPapercutOpts,
  deps: PapercutDeps,
): Promise<void> {
  try {
    const runDir = runDirPath(opts.repoDir, opts.run);

    // Issue number: read from run.json (written once by initRunDir at run
    // start) — the single source of truth for a run's issue. Absent/unreadable
    // → 0 rather than throwing; this is a best-effort record, not a hard read.
    let issue = 0;
    try {
      const raw = await deps.readFile(path.join(runDir, "run.json"));
      const meta = JSON.parse(raw) as { issue?: number };
      if (typeof meta.issue === "number") issue = meta.issue;
    } catch {
      // No run.json (e.g. an out-of-run manual invocation) — issue stays 0.
    }

    const stage = opts.stage ?? process.env.PIPELINE_STAGE ?? null;
    const harness = opts.harness ?? process.env.PIPELINE_HARNESS ?? null;
    const model = opts.model ?? process.env.PIPELINE_MODEL ?? null;

    await deps.emitPapercut(runDir, {
      run_id: opts.run,
      issue,
      stage,
      harness,
      model,
      message: opts.message,
    });
  } catch (err) {
    deps.log(
      `[pipeline] papercut: record failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// reportPapercuts
// ---------------------------------------------------------------------------

/** Scan every run's events.jsonl under `.agent-pipeline/runs/` and return the
 *  papercut events whose `at` timestamp falls within [since, until], sorted
 *  ascending by `at`. Unreadable run directories/files and malformed lines are
 *  skipped silently — a single bad run must not abort the report. */
export async function reportPapercuts(
  opts: ReportPapercutsOpts,
  deps: PapercutDeps,
): Promise<PapercutEvent[]> {
  const sinceMs = Date.parse(opts.since);
  const untilMs = opts.until !== undefined ? Date.parse(opts.until) : Infinity;

  const dir = runsDir(opts.repoDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.readdir(dir);
  } catch {
    return [];
  }

  const results: PapercutEvent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = await deps.readFile(path.join(dir, entry.name, "events.jsonl"));
    } catch {
      continue; // unreadable/missing — skip this run
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { type?: unknown }).type !== "papercut"
      ) {
        continue;
      }
      const event = parsed as PapercutEvent;
      const atMs = Date.parse(event.at);
      if (!Number.isFinite(atMs)) continue;
      if (atMs < sinceMs || atMs > untilMs) continue;
      results.push(event);
    }
  }

  results.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return results;
}
