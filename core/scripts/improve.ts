// Improve analyzer (#303): reads run artifacts read-only and clusters recurring
// failure patterns into candidate improvement work. Default mode prints a dry-run
// report. With --apply, creates GitHub issues for top-N clusters.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { runsDir } from "./run-store.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClusterCategory = "review-finding" | "blocker" | "flaky-gate" | "token-waste";

export interface ClusterEntry {
  category: ClusterCategory;
  signal: string;
  count: number;
  runIds: string[];
  excerpt: string;
  issueUrl?: string | null;
}

export interface ImproveOpts {
  apply?: boolean;
  top?: number;
  since?: string;
  minOccurrences?: number;
  json?: boolean;
  repoDir: string;
}

export interface ImproveDeps {
  readFile: (p: string) => Promise<string>;
  /** Read a file line by line — returns an async iterable of raw line strings. */
  readLines: (p: string) => AsyncIterable<string>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  /** Create a GitHub issue and return its URL. Used only when --apply is set. */
  createIssue: (title: string, body: string) => Promise<string>;
  /** Check gh auth status. Returns true if authenticated. */
  ghAuthCheck: () => Promise<boolean>;
  log: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

async function* realReadLines(p: string): AsyncIterable<string> {
  try {
    await fsp.access(p);
  } catch {
    return;
  }
  const stream = createReadStream(p, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    yield line;
  }
}

export function realImproveDeps(repoDir: string): ImproveDeps {
  return {
    readFile: (p) => fsp.readFile(p, "utf8"),
    readLines: (p) => realReadLines(p),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries as Array<{ name: string; isDirectory(): boolean }>;
    },
    createIssue: async (title, body) => {
      const r = spawnSync("gh", ["issue", "create", "--title", title, "--body", body], {
        encoding: "utf8",
        cwd: repoDir,
      });
      if (r.status !== 0) {
        throw new Error(`gh issue create failed: ${r.stderr?.trim() ?? "unknown error"}`);
      }
      return (r.stdout ?? "").trim();
    },
    ghAuthCheck: async () => {
      const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8", cwd: repoDir });
      return r.status === 0;
    },
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// normalizeSignal
// ---------------------------------------------------------------------------

/** Normalize a signal string for clustering: lowercase, strip issue/PR/SHA/line-number
 *  tokens, collapse whitespace. */
export function normalizeSignal(str: string): string {
  return str
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "")
    .replace(/#\d+/g, "")
    .replace(/\bline\s+\d+\b/g, "")
    .replace(/:\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// discoverRuns
// ---------------------------------------------------------------------------

export interface RunInfo {
  runId: string;
  dir: string;
  startedAt: string | null;
}

/** Discover run directories under runsDirectory. Applies --since filter when provided.
 *  Runs with missing run.json are always included (cannot be excluded by --since). */
export async function discoverRuns(
  runsDirectory: string,
  since?: string,
  deps?: Pick<ImproveDeps, "readFile" | "readdir">,
): Promise<RunInfo[]> {
  const readFile = deps?.readFile ?? ((p: string) => fsp.readFile(p, "utf8"));
  const readdir =
    deps?.readdir ??
    (async (p: string) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries as Array<{ name: string; isDirectory(): boolean }>;
    });

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(runsDirectory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const sinceMs = since ? Date.parse(since) : null;
  const runs: RunInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDirectory, entry.name);
    const runJsonPath = path.join(dir, "run.json");

    let startedAt: string | null = null;
    try {
      const raw = await readFile(runJsonPath);
      const meta = JSON.parse(raw) as { started_at?: string };
      startedAt = meta.started_at ?? null;
    } catch {
      // Missing or unreadable run.json — include regardless of --since
    }

    if (sinceMs !== null && startedAt !== null) {
      const runMs = Date.parse(startedAt);
      if (!isNaN(runMs) && runMs < sinceMs) continue;
    }

    runs.push({ runId: entry.name, dir, startedAt });
  }

  return runs;
}

// ---------------------------------------------------------------------------
// readEventsLines — streaming, line by line
// ---------------------------------------------------------------------------

/** Read events.jsonl streaming line by line, skip corrupt/partial lines.
 *  Returns an async iterable of parsed event objects. Unknown fields are preserved. */
export async function* readEventsLines(
  eventsJsonlPath: string,
  deps?: Pick<ImproveDeps, "readLines">,
): AsyncIterable<Record<string, unknown>> {
  const reader = deps?.readLines ?? realReadLines;
  for await (const line of reader(eventsJsonlPath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Corrupt or partial line — skip silently
    }
  }
}

// ---------------------------------------------------------------------------
// Clustering engine — internal accumulation (keys + counts only, not full records)
// ---------------------------------------------------------------------------

interface ClusterAccum {
  category: ClusterCategory;
  signal: string;
  count: number;
  runIds: Set<string>;
  excerpt: string;
}

function truncateExcerpt(s: string): string {
  if (s.length <= 200) return s;
  return s.slice(0, 197) + "...";
}

/** Extract review findings from a review_verdict event and accumulate into clusters.
 *  Only normalized keys and occurrence counts are stored — not full event records. */
export function clusterReviewFindings(
  event: Record<string, unknown>,
  runId: string,
  clusters: Map<string, ClusterAccum>,
): void {
  if (event["type"] !== "review_verdict") return;
  const findings = event["findings"];
  if (!Array.isArray(findings)) return;
  for (const f of findings) {
    if (typeof f !== "object" || f === null) continue;
    const obj = f as Record<string, unknown>;
    const title = typeof obj["title"] === "string" ? obj["title"] : "";
    const body = typeof obj["body"] === "string" ? obj["body"] : "";
    if (!title) continue;
    const normalized = normalizeSignal(title);
    const key = `review-finding:${normalized}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.count++;
      existing.runIds.add(runId);
    } else {
      clusters.set(key, {
        category: "review-finding",
        signal: normalized,
        count: 1,
        runIds: new Set([runId]),
        excerpt: truncateExcerpt(body || title),
      });
    }
  }
}

/** Extract blocker reason from a blocker_set event and accumulate into clusters.
 *  Only normalized keys and occurrence counts are stored — not full event records. */
export function clusterBlockers(
  event: Record<string, unknown>,
  runId: string,
  clusters: Map<string, ClusterAccum>,
): void {
  if (event["type"] !== "blocker_set") return;
  const reason = typeof event["reason"] === "string" ? event["reason"] : "";
  if (!reason) return;
  const normalized = normalizeSignal(reason);
  const key = `blocker:${normalized}`;
  const existing = clusters.get(key);
  if (existing) {
    existing.count++;
    existing.runIds.add(runId);
  } else {
    clusters.set(key, {
      category: "blocker",
      signal: normalized,
      count: 1,
      runIds: new Set([runId]),
      excerpt: truncateExcerpt(reason),
    });
  }
}

/** Extract stage errors from stage_complete events and accumulate into clusters.
 *  Only stage name keys and occurrence counts are stored — not full event records. */
export function clusterFlakyGates(
  event: Record<string, unknown>,
  runId: string,
  clusters: Map<string, ClusterAccum>,
): void {
  if (event["type"] !== "stage_complete") return;
  if (event["outcome"] !== "error") return;
  const stage = typeof event["stage"] === "string" ? event["stage"] : "";
  if (!stage) return;
  const key = `flaky-gate:${stage}`;
  const existing = clusters.get(key);
  if (existing) {
    existing.count++;
    existing.runIds.add(runId);
  } else {
    clusters.set(key, {
      category: "flaky-gate",
      signal: stage,
      count: 1,
      runIds: new Set([runId]),
      excerpt: truncateExcerpt(`Stage "${stage}" completed with outcome: error`),
    });
  }
}

/** Cluster token waste from a summary JSON. Skipped silently if absent or schema mismatch.
 *  Returns true if the summary had recognizable token/duration fields. */
export function clusterTokenWaste(
  summaryJson: unknown,
  runId: string,
  clusters: Map<string, ClusterAccum>,
): boolean {
  if (!summaryJson || typeof summaryJson !== "object") return false;
  const obj = summaryJson as Record<string, unknown>;
  const totalTokens = typeof obj["total_tokens"] === "number" ? obj["total_tokens"] : null;
  const durationMs = typeof obj["elapsed_ms"] === "number" ? obj["elapsed_ms"] : null;
  if (totalTokens === null && durationMs === null) return false;

  const highTokens = totalTokens !== null && totalTokens > 200_000;
  const longDuration = durationMs !== null && durationMs > 30 * 60 * 1000;

  if (highTokens || longDuration) {
    const parts: string[] = [];
    if (highTokens) parts.push(`${totalTokens} tokens`);
    if (longDuration) parts.push(`${Math.round((durationMs ?? 0) / 60_000)}min`);
    const signal = parts.join(", ");
    const key = `token-waste:${runId}`;
    if (!clusters.has(key)) {
      clusters.set(key, {
        category: "token-waste",
        signal,
        count: 1,
        runIds: new Set([runId]),
        excerpt: truncateExcerpt(`Run ${runId}: ${signal}`),
      });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// clustersToEntries — convert internal map to sorted ClusterEntry[]
// ---------------------------------------------------------------------------

export function clustersToEntries(
  clusters: Map<string, ClusterAccum>,
  top: number,
): ClusterEntry[] {
  return [...clusters.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((c) => ({
      category: c.category,
      signal: c.signal,
      count: c.count,
      runIds: [...c.runIds],
      excerpt: c.excerpt,
    }));
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function formatReport(clusters: ClusterEntry[], tokenWasteSkipped: boolean): string {
  const lines: string[] = ["# pipeline improve — cluster report", ""];
  if (clusters.length === 0) {
    lines.push("No recurring patterns found in the analyzed run data.");
    lines.push("");
  }
  for (const c of clusters) {
    const proposedTitle = `[pipeline-improve] Recurring ${c.category}: ${c.signal.slice(0, 60)}`;
    lines.push(`## [${c.category}] ${c.signal.slice(0, 80)}`);
    lines.push(`**Occurrences**: ${c.count}`);
    lines.push(`**Affected runs**: ${c.runIds.join(", ")}`);
    lines.push(`**Excerpt**: ${c.excerpt}`);
    lines.push(`**Proposed issue title**: ${proposedTitle}`);
    if (c.issueUrl) lines.push(`**Created issue**: ${c.issueUrl}`);
    lines.push("");
  }
  if (tokenWasteSkipped) {
    lines.push(
      "_Note: token-waste analysis was skipped — run summaries did not contain token-count or duration data._",
    );
    lines.push("");
  }
  return lines.join("\n");
}

/** Emit a JSON array of cluster objects. Each element has category, signal, count,
 *  runIds, excerpt, and (when --apply was used) issueUrl. */
export function formatJson(clusters: ClusterEntry[]): string {
  return JSON.stringify(
    clusters.map((c) => ({
      category: c.category,
      signal: c.signal,
      count: c.count,
      runIds: c.runIds,
      excerpt: c.excerpt,
      ...(c.issueUrl !== undefined ? { issueUrl: c.issueUrl } : {}),
    })),
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Apply mode
// ---------------------------------------------------------------------------

export async function applyIssues(
  clusters: ClusterEntry[],
  opts: { minOccurrences?: number },
  deps: Pick<ImproveDeps, "createIssue" | "ghAuthCheck" | "log">,
): Promise<void> {
  const minOcc = opts.minOccurrences ?? 3;

  const authed = await deps.ghAuthCheck();
  if (!authed) {
    throw new Error(
      "gh is not authenticated. Run `gh auth login` before using --apply.",
    );
  }

  const qualifying = clusters.filter((c) => c.count >= minOcc);
  for (const c of qualifying) {
    const title = `[pipeline-improve] Recurring ${c.category}: ${c.signal.slice(0, 60)}`;
    const body = [
      `## Recurring pattern detected by \`pipeline improve\``,
      ``,
      `**Category**: ${c.category}`,
      `**Signal**: ${c.signal}`,
      `**Occurrences**: ${c.count}`,
      ``,
      `### Affected run IDs`,
      ...c.runIds.map((id) => `- ${id}`),
      ``,
      `### Evidence excerpt`,
      "```",
      c.excerpt,
      "```",
      ``,
      `---`,
      `_Generated by \`pipeline improve\`. Verify the pattern independently before acting._`,
    ].join("\n");
    const url = await deps.createIssue(title, body);
    c.issueUrl = url || null;
    deps.log(`Created issue: ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runImprove(opts: ImproveOpts, deps: ImproveDeps): Promise<void> {
  const runsDirPath = runsDir(opts.repoDir);
  const top = opts.top ?? 5;
  const minOcc = opts.minOccurrences ?? 3;

  const runs = await discoverRuns(runsDirPath, opts.since, deps);

  if (runs.length === 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify([]) + "\n");
    } else {
      deps.log(`No run data found under ${runsDirPath}.`);
    }
    return;
  }

  const clusters = new Map<string, ClusterAccum>();
  let tokenWasteSkipped = true;

  for (const run of runs) {
    const eventsPath = path.join(run.dir, "events.jsonl");
    for await (const event of readEventsLines(eventsPath, deps)) {
      clusterReviewFindings(event, run.runId, clusters);
      clusterBlockers(event, run.runId, clusters);
      clusterFlakyGates(event, run.runId, clusters);
    }

    const summaryPath = path.join(run.dir, "summary.json");
    try {
      const raw = await deps.readFile(summaryPath);
      const summary = JSON.parse(raw) as unknown;
      const hadData = clusterTokenWaste(summary, run.runId, clusters);
      if (hadData) tokenWasteSkipped = false;
    } catch {
      // Missing or unreadable summary.json — skip silently
    }
  }

  const entries = clustersToEntries(clusters, top);

  if (opts.apply) {
    const applyDeps: Pick<ImproveDeps, "createIssue" | "ghAuthCheck" | "log"> = opts.json
      ? { createIssue: deps.createIssue, ghAuthCheck: deps.ghAuthCheck, log: (msg) => { process.stderr.write(msg + "\n"); } }
      : deps;
    await applyIssues(entries, { minOccurrences: minOcc }, applyDeps);
    if (opts.json) {
      for (const e of entries) {
        if (e.issueUrl === undefined) e.issueUrl = null;
      }
    }
  }

  if (opts.json) {
    process.stdout.write(formatJson(entries) + "\n");
    if (tokenWasteSkipped) {
      process.stderr.write(
        "(token-waste analysis skipped — no token-count or duration data in run summaries)\n",
      );
    }
  } else {
    deps.log(formatReport(entries, tokenWasteSkipped));
  }
}
