// Host-local production-outcome store (#576).
//
// Layout: `.agent-pipeline/outcomes/<outcome_id>.json`
// Optional index: `.agent-pipeline/outcomes/outcomes.jsonl` (append rewrite on upsert)
//
// Outcomes often arrive after runs end; this store is independent of run dirs.
// Inject fs deps for offline unit tests. Write failures are non-fatal for
// batch ingest callers when they choose to catch upsert errors.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { artifactSubdir, OUTCOMES_ARTIFACT } from "../artifact-ignore.ts";
import {
  readProductionOutcome,
  serializeProductionOutcome,
  validateProductionOutcome,
  type ProductionOutcome,
} from "./schema.ts";

export const DEFAULT_OUTCOME_RETENTION_DAYS = 365;

export interface OutcomeStoreDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, content: string) => Promise<void>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
}

export function realOutcomeStoreDeps(): OutcomeStoreDeps {
  return {
    readFile: (p) => fsp.readFile(p, "utf8"),
    writeFile: (p, content) => fsp.writeFile(p, content, "utf8"),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: () => e.isDirectory() }));
    },
    mkdir: (p, opts) => fsp.mkdir(p, opts).then(() => undefined),
    unlink: (p) => fsp.unlink(p),
  };
}

/** Absolute path of the outcomes store directory for a repo. */
export function outcomesDir(repoDir: string): string {
  return artifactSubdir(repoDir, OUTCOMES_ARTIFACT);
}

export function outcomeFilePath(repoDir: string, outcomeId: string): string {
  // Sanitize path segment: no slashes; keep stable id characters.
  const safe = outcomeId.replace(/[/\\]/g, "_");
  return path.join(outcomesDir(repoDir), `${safe}.json`);
}

export function outcomesIndexPath(repoDir: string): string {
  return path.join(outcomesDir(repoDir), "outcomes.jsonl");
}

export interface ListOutcomesOpts {
  /** Retention window in days; records older than this are excluded. */
  retentionDays?: number;
  /** Scoreboard/report window lower bound (ISO). Prefer signal_at, else observed_at. */
  since?: string;
  /** Scoreboard/report window upper bound (ISO). */
  until?: string;
  /** When true, include expired records (default false). */
  includeExpired?: boolean;
  now?: Date;
}

export interface ListOutcomesResult {
  records: ProductionOutcome[];
  diagnostics: Array<{ code: string; message: string; path?: string }>;
}

function relevantTimestamp(record: ProductionOutcome): string | null {
  return record.signal_at ?? record.observed_at ?? null;
}

function isWithinRetention(
  record: ProductionOutcome,
  retentionDays: number,
  now: Date,
): boolean {
  if (retentionDays <= 0) return true;
  const ts = relevantTimestamp(record);
  if (!ts) return true; // unknown age — keep rather than invent expiry
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return true;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return ms >= cutoff;
}

function isInsideWindow(record: ProductionOutcome, since?: string, until?: string): boolean {
  if (!since && !until) return true;
  const ts = relevantTimestamp(record);
  if (!ts) return true;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return true;
  if (since) {
    const s = Date.parse(since);
    if (Number.isFinite(s) && ms < s) return false;
  }
  if (until) {
    const u = Date.parse(until);
    if (Number.isFinite(u) && ms > u) return false;
  }
  return true;
}

/** List outcomes; missing store → zero records + diagnostic (never throws). */
export async function listOutcomes(
  repoDir: string,
  opts: ListOutcomesOpts = {},
  deps: OutcomeStoreDeps = realOutcomeStoreDeps(),
): Promise<ListOutcomesResult> {
  const dir = outcomesDir(repoDir);
  const diagnostics: ListOutcomesResult["diagnostics"] = [];
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      diagnostics.push({
        code: "missing_outcome_store",
        message: "Outcome store directory is missing.",
        path: dir,
      });
      return { records: [], diagnostics };
    }
    diagnostics.push({
      code: "outcome_store_unreadable",
      message: `Outcome store could not be read: ${(err as Error).message}`,
      path: dir,
    });
    return { records: [], diagnostics };
  }

  const retentionDays = opts.retentionDays ?? DEFAULT_OUTCOME_RETENTION_DAYS;
  const now = opts.now ?? new Date();
  const records: ProductionOutcome[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name === "outcomes.jsonl") continue;
    const filePath = path.join(dir, entry.name);
    let raw: string;
    try {
      raw = await deps.readFile(filePath);
    } catch (err) {
      diagnostics.push({
        code: "outcome_file_unreadable",
        message: (err as Error).message,
        path: filePath,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "outcome_file_corrupt",
        message: "invalid JSON",
        path: filePath,
      });
      continue;
    }
    const record = readProductionOutcome(parsed);
    if (!record) {
      diagnostics.push({
        code: "outcome_file_invalid",
        message: "failed schema validation",
        path: filePath,
      });
      continue;
    }
    if (!opts.includeExpired && !isWithinRetention(record, retentionDays, now)) {
      continue;
    }
    if (!isInsideWindow(record, opts.since, opts.until)) {
      continue;
    }
    records.push(record);
  }

  records.sort((a, b) => {
    const ta = relevantTimestamp(a) ?? "";
    const tb = relevantTimestamp(b) ?? "";
    return ta.localeCompare(tb);
  });

  if (records.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      code: "empty_outcome_store",
      message: "Outcome store has no records.",
      path: dir,
    });
  }

  return { records, diagnostics };
}

export interface UpsertResult {
  outcome_id: string;
  action: "written" | "replaced" | "skipped_invalid";
  record: ProductionOutcome | null;
  error?: string;
}

/**
 * Idempotent upsert by outcome_id.
 * Same id replaces the prior record (merge rule: last write wins for fields;
 * attribution arrays from the new record replace the old, so re-ingest of the
 * same signal does not double-count).
 */
export async function upsertOutcome(
  repoDir: string,
  record: ProductionOutcome,
  deps: OutcomeStoreDeps = realOutcomeStoreDeps(),
): Promise<UpsertResult> {
  const validated = validateProductionOutcome(record);
  if (!validated.ok || !validated.value) {
    return {
      outcome_id: typeof record?.outcome_id === "string" ? record.outcome_id : "",
      action: "skipped_invalid",
      record: null,
      error: validated.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
    };
  }
  const value = validated.value;
  const dir = outcomesDir(repoDir);
  try {
    await deps.mkdir(dir, { recursive: true });
  } catch (err) {
    return {
      outcome_id: value.outcome_id,
      action: "skipped_invalid",
      record: null,
      error: `mkdir failed: ${(err as Error).message}`,
    };
  }

  const filePath = outcomeFilePath(repoDir, value.outcome_id);
  let existed = false;
  try {
    await deps.readFile(filePath);
    existed = true;
  } catch {
    existed = false;
  }

  const body = serializeProductionOutcome(value);
  try {
    await deps.writeFile(filePath, body);
  } catch (err) {
    return {
      outcome_id: value.outcome_id,
      action: "skipped_invalid",
      record: null,
      error: `write failed: ${(err as Error).message}`,
    };
  }

  // Best-effort index rewrite (non-fatal).
  try {
    await rewriteIndex(repoDir, deps);
  } catch {
    /* ignore */
  }

  return {
    outcome_id: value.outcome_id,
    action: existed ? "replaced" : "written",
    record: value,
  };
}

async function rewriteIndex(repoDir: string, deps: OutcomeStoreDeps): Promise<void> {
  const listed = await listOutcomes(repoDir, { includeExpired: true, retentionDays: 0 }, deps);
  const lines = listed.records.map((r) =>
    JSON.stringify({
      outcome_id: r.outcome_id,
      outcome_kind: r.outcome_kind,
      observation_state: r.observation_state,
      signal_at: r.signal_at,
      observed_at: r.observed_at,
    }),
  );
  await deps.writeFile(outcomesIndexPath(repoDir), lines.length ? `${lines.join("\n")}\n` : "");
}

/** Read a single outcome by id; null if missing/invalid. */
export async function readOutcome(
  repoDir: string,
  outcomeId: string,
  deps: OutcomeStoreDeps = realOutcomeStoreDeps(),
): Promise<ProductionOutcome | null> {
  try {
    const raw = await deps.readFile(outcomeFilePath(repoDir, outcomeId));
    return readProductionOutcome(JSON.parse(raw));
  } catch {
    return null;
  }
}
