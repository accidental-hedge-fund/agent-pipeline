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
  type DeliveryChain,
  type ObservationState,
  type OutcomeAttribution,
  type ProductionOutcome,
} from "./schema.ts";
import { applyDisputedRunAttributions } from "./linkage.ts";

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

const DEPLOY_STATUS_RANK: Record<string, number> = {
  not_observed: 0,
  unknown: 1,
  in_progress: 2,
  succeeded: 3,
  failed: 3,
  rolled_back: 3,
};

const MERGE_STATUS_RANK: Record<string, number> = {
  not_observed: 0,
  unknown: 1,
  not_merged: 2,
  merged: 3,
};

const VERIFICATION_STATUS_RANK: Record<string, number> = {
  not_observed: 0,
  unknown: 1,
  passed: 2,
  failed: 2,
};

const OBSERVATION_STATE_RANK: Record<string, number> = {
  not_observed: 0,
  unknown: 1,
  delayed: 2,
  observed: 3,
  disputed: 4,
};

function preferByRank<T extends string>(a: T, b: T, rank: Record<string, number>): T {
  return (rank[b] ?? 0) >= (rank[a] ?? 0) ? b : a;
}

function preferNonNullString(a: string | null, b: string | null): string | null {
  return b ?? a ?? null;
}

/** Merge delivery-chain fields so later deploy/merge signals update one record. */
export function mergeDeliveryChains(
  existing: DeliveryChain | null,
  incoming: DeliveryChain | null,
): DeliveryChain | null {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return {
    environment: preferNonNullString(existing.environment, incoming.environment),
    deploy_status: preferByRank(existing.deploy_status, incoming.deploy_status, DEPLOY_STATUS_RANK),
    deployed_candidate_sha: preferNonNullString(
      existing.deployed_candidate_sha,
      incoming.deployed_candidate_sha,
    ),
    merge_status: preferByRank(existing.merge_status, incoming.merge_status, MERGE_STATUS_RANK),
    merged_sha: preferNonNullString(existing.merged_sha, incoming.merged_sha),
    verification: {
      status: preferByRank(
        existing.verification.status,
        incoming.verification.status,
        VERIFICATION_STATUS_RANK,
      ),
      evidence_ref: preferNonNullString(
        existing.verification.evidence_ref,
        incoming.verification.evidence_ref,
      ),
      fresh_at: preferNonNullString(existing.verification.fresh_at, incoming.verification.fresh_at),
    },
    rollback: {
      occurred:
        existing.rollback.occurred === true || incoming.rollback.occurred === true
          ? true
          : existing.rollback.occurred === false || incoming.rollback.occurred === false
            ? false
            : null,
      outcome: preferNonNullString(
        existing.rollback.outcome,
        incoming.rollback.outcome,
      ) as DeliveryChain["rollback"]["outcome"],
    },
  };
}

/**
 * Field-level merge for same outcome_id re-ingest (especially delivery chain).
 * Attribution is unioned; multiple runs mark disputed. Does not drop prior claims.
 */
export function mergeOutcomeRecords(
  existing: ProductionOutcome,
  incoming: ProductionOutcome,
): ProductionOutcome {
  const { attribution, observation_state: disputedState } = applyDisputedRunAttributions(
    existing.attribution,
    incoming.attribution,
  );
  // Dedupe non-run targets by type+id (keep first; incoming fills gaps).
  const mergedAttr: OutcomeAttribution[] = [];
  for (const a of attribution) {
    const dup = mergedAttr.find((m) => m.target_type === a.target_type && m.target_id === a.target_id);
    if (!dup) mergedAttr.push({ ...a });
    else if (a.disputed) dup.disputed = true;
  }

  let observation_state: ObservationState = preferByRank(
    existing.observation_state,
    incoming.observation_state,
    OBSERVATION_STATE_RANK,
  );
  if (disputedState === "disputed") observation_state = "disputed";

  const evidence = [...new Set([...existing.evidence_refs, ...incoming.evidence_refs])];
  const diagnostics = [
    ...new Set([...existing.linkage_diagnostics, ...incoming.linkage_diagnostics]),
  ];

  // Same signal re-ingest: last write for summary. Distinct signals: retain both.
  const summary =
    existing.summary === incoming.summary
      ? existing.summary
      : existing.source.signal_ref === incoming.source.signal_ref
        ? incoming.summary
        : `${existing.summary} | ${incoming.summary}`.slice(0, 500);

  // signal_at: earliest known event in the chain; observed_at: latest observation.
  const signalTimes = [existing.signal_at, incoming.signal_at].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  signalTimes.sort();
  const observedTimes = [existing.observed_at, incoming.observed_at].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  observedTimes.sort();

  const sameKind = existing.outcome_kind === incoming.outcome_kind;
  const delivery =
    existing.outcome_kind === "delivery" || incoming.outcome_kind === "delivery"
      ? mergeDeliveryChains(existing.delivery, incoming.delivery)
      : incoming.delivery ?? existing.delivery;

  return {
    ...existing,
    // Prefer existing kind when both delivery; otherwise last write for kind mismatch.
    outcome_kind: sameKind ? existing.outcome_kind : incoming.outcome_kind,
    observation_state,
    observed_at: observedTimes.length ? observedTimes[observedTimes.length - 1]! : null,
    signal_at: signalTimes.length ? signalTimes[0]! : null,
    source: existing.source,
    delivery,
    summary,
    evidence_refs: evidence,
    attribution: mergedAttr,
    linkage_diagnostics: diagnostics,
    supersedes_outcome_id:
      incoming.supersedes_outcome_id ?? existing.supersedes_outcome_id,
  };
}

/**
 * Idempotent upsert by outcome_id.
 * When a record with the same id already exists, field-merge (delivery chain +
 * attribution union) so merge then deploy of the same candidate updates one
 * delivery observation rather than last-write wiping prior chain steps.
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
  let value = validated.value;
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
    const raw = await deps.readFile(filePath);
    existed = true;
    const prior = readProductionOutcome(JSON.parse(raw));
    if (prior) {
      value = mergeOutcomeRecords(prior, value);
      const revalidated = validateProductionOutcome(value);
      if (!revalidated.ok || !revalidated.value) {
        return {
          outcome_id: value.outcome_id,
          action: "skipped_invalid",
          record: null,
          error: revalidated.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        };
      }
      value = revalidated.value;
    }
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
