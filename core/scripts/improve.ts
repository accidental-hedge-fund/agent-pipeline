// Improve analyzer (#303): reads run artifacts read-only and clusters recurring
// failure patterns into candidate improvement work. Default mode prints a dry-run
// report. With --apply, creates GitHub issues for top-N clusters.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { runsDir } from "./run-store.ts";
import { summarizeInterventions } from "./intervention.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClusterCategory = "review-finding" | "blocker" | "flaky-gate" | "token-waste" | "papercut";

export interface ClusterEntry {
  category: ClusterCategory;
  signal: string;
  count: number;
  runIds: string[];
  excerpt: string;
  issueUrl?: string | null;
  /** True when issueUrl points at a pre-existing open issue found by dedup,
   *  rather than one just created by this invocation. */
  alreadyTracked?: boolean;
}

/** An open GitHub issue whose title carries the `[pipeline-improve]` prefix
 *  (#421 dedup). Normalized from `gh api repos/{owner}/{repo}/issues` (REST) pages: the raw
 *  shape uses `html_url`/`created_at`/lowercase `state`, mapped to this shape's
 *  `url`/`createdAt`/uppercase `"OPEN" | "CLOSED"` by `parseOpenImproveIssuesPages`.
 *
 *  `body` (#459 review 2, finding 582c19e6) carries the issue body so callers can check for a
 *  provenance marker before treating an issue as auto-filed — the `[pipeline-improve]` title
 *  prefix and `pipeline:backlog` label are both applied by legitimate non-auto-file paths too
 *  (`pipeline improve --apply`, and `/pipeline:triage` respectively), so neither alone proves an
 *  issue was created by the papercut auto-file path. Optional/defaulted to "" so callers that
 *  never fetched a body (in-memory placeholders) degrade to "no provenance" rather than throwing. */
export interface OpenImproveIssue {
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  labels: string[];
  body?: string;
}

export interface ImproveOpts {
  apply?: boolean;
  top?: number;
  since?: string;
  minOccurrences?: number;
  json?: boolean;
  repoDir: string;
  /** When true, print an intervention summary as JSON instead of the cluster report. */
  interventions?: boolean;
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
  /** List issues (open and closed) whose title carries the `[pipeline-improve]`
   *  prefix. Callers that need dedup filter to `state === "OPEN"` themselves;
   *  callers that need a rate-window count (#421 finding 3) use both states.
   *  Called once per invocation regardless of cluster count. */
  listOpenImproveIssues: () => Promise<OpenImproveIssue[]>;
  log: (msg: string) => void;
}

/** `[pipeline-improve]`-prefixed issue title proposed for a cluster. Shared by
 *  the report, dedup lookup, and issue-creation paths so all three agree on
 *  the same title string. */
export function proposedTitle(c: Pick<ClusterEntry, "category" | "signal">): string {
  return `[pipeline-improve] Recurring ${c.category}: ${c.signal.slice(0, 60)}`;
}

/** `gh api` args for fetching every repo issue, paginated to completion (#421 review 2
 *  finding: `--search ... in:title` scopes the query server-side, but GitHub's search API
 *  hard-caps *any* search at 1,000 total results — no `--limit` value can raise that ceiling,
 *  so repos with 1,000+ `[pipeline-improve]` issues would still silently drop matches. The
 *  plain `repos/{owner}/{repo}/issues` REST endpoint has no such cap: `--paginate` follows
 *  every page to completion, and `--slurp` wraps each page's array into an outer array (see
 *  `getOpenIssues` in `gh.ts` for the same pattern). Title filtering happens client-side in
 *  `listOpenImproveIssues` below. Exported for regression testing. */
export function listOpenImproveIssuesArgs(): string[] {
  return ["api", "repos/{owner}/{repo}/issues?state=all&per_page=100", "--paginate", "--slurp"];
}

/** Raw shape of one issue as returned by `gh api repos/{owner}/{repo}/issues`. */
export interface RawApiIssue {
  title: string;
  state: string;
  created_at: string;
  html_url: string;
  labels: Array<{ name: string }>;
  /** Present on pull requests; absent on issues. The REST issues endpoint lists both. */
  pull_request?: unknown;
  body?: string | null;
}

/** Flatten `--slurp`-wrapped pages (`[[page1...], [page2...], ...]`), drop pull requests, and
 *  filter to `[pipeline-improve]`-titled issues. Pure and exported so completeness across many
 *  pages (#421 review 2 round 2: no truncation at 1,000+ matches) can be regression-tested
 *  without a real `gh` process. */
export function parseOpenImproveIssuesPages(pages: RawApiIssue[][]): OpenImproveIssue[] {
  return pages
    .flat()
    .filter((i) => !i.pull_request && i.title.startsWith("[pipeline-improve]"))
    .map((i) => ({
      title: i.title,
      url: i.html_url,
      state: (i.state?.toLowerCase() === "closed" ? "CLOSED" : "OPEN") as "OPEN" | "CLOSED",
      createdAt: i.created_at,
      labels: (i.labels ?? []).map((l) => l.name),
      body: i.body ?? "",
    }));
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
    listOpenImproveIssues: async () => {
      // state=all (not "open"): the auto-file rate-window cap (#421 finding 3)
      // must count closed auto-filed issues too, so callers that need only open
      // issues (dedup) filter on `state === "OPEN"` themselves.
      const r = spawnSync("gh", listOpenImproveIssuesArgs(), { encoding: "utf8", cwd: repoDir });
      if (r.status !== 0) {
        throw new Error(`gh issue list failed: ${r.stderr?.trim() ?? "unknown error"}`);
      }
      const pages = JSON.parse(r.stdout || "[]") as RawApiIssue[][];
      return parseOpenImproveIssuesPages(pages);
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

export interface ClusterAccum {
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

/** Cluster token waste from a summary JSON. Reads per-stage command durations from
 *  the real EvidenceBundle shape (stages[].commands[].durationMs). Stages whose total
 *  command duration meets or exceeds the high-duration threshold are clustered by stage
 *  name so the same slow stage across runs produces one cluster. Skipped silently if
 *  absent or schema mismatch. Returns true if recognizable stage duration data was found. */
export function clusterTokenWaste(
  summaryJson: unknown,
  runId: string,
  clusters: Map<string, ClusterAccum>,
): boolean {
  if (!summaryJson || typeof summaryJson !== "object") return false;
  const obj = summaryJson as Record<string, unknown>;
  const stages = obj["stages"];
  if (!Array.isArray(stages) || stages.length === 0) return false;

  const HIGH_DURATION_MS = 30 * 60 * 1000;
  let hadData = false;

  for (const stage of stages) {
    if (!stage || typeof stage !== "object") continue;
    const s = stage as Record<string, unknown>;
    const stageName = typeof s["stage"] === "string" ? s["stage"] : "";
    if (!stageName) continue;
    const commands = s["commands"];
    if (!Array.isArray(commands)) continue;

    hadData = true;
    let totalDurationMs = 0;
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== "object") continue;
      const c = cmd as Record<string, unknown>;
      const d = typeof c["durationMs"] === "number" ? c["durationMs"] : 0;
      totalDurationMs += d;
    }

    if (totalDurationMs >= HIGH_DURATION_MS) {
      const durationMin = Math.round(totalDurationMs / 60_000);
      const signal = `high-duration:${stageName}`;
      const key = `token-waste:stage:${stageName}`;
      const existing = clusters.get(key);
      if (existing) {
        existing.count++;
        existing.runIds.add(runId);
      } else {
        clusters.set(key, {
          category: "token-waste",
          signal,
          count: 1,
          runIds: new Set([runId]),
          excerpt: truncateExcerpt(`Stage "${stageName}" took ${durationMin}min in run ${runId}`),
        });
      }
    }
  }
  return hadData;
}

/** Extract a papercut message from a `papercut` event and accumulate into
 *  clusters. Keyed on `papercut:${normalizeSignal(message)}` so an
 *  agent-reported papercut can never collide with a telemetry-derived
 *  cluster (#421 category isolation) even when the normalized text matches. */
export function clusterPapercuts(
  event: Record<string, unknown>,
  runId: string,
  clusters: Map<string, ClusterAccum>,
): void {
  if (event["type"] !== "papercut") return;
  const message = typeof event["message"] === "string" ? event["message"] : "";
  if (!message) return;
  const normalized = normalizeSignal(message);
  const key = `papercut:${normalized}`;
  const existing = clusters.get(key);
  if (existing) {
    existing.count++;
    existing.runIds.add(runId);
  } else {
    clusters.set(key, {
      category: "papercut",
      signal: normalized,
      count: 1,
      runIds: new Set([runId]),
      excerpt: truncateExcerpt(message),
    });
  }
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
    lines.push(`## [${c.category}] ${c.signal.slice(0, 80)}`);
    lines.push(`**Occurrences**: ${c.count}`);
    lines.push(`**Affected runs**: ${c.runIds.join(", ")}`);
    lines.push(`**Excerpt**: ${c.excerpt}`);
    lines.push(`**Proposed issue title**: ${proposedTitle(c)}`);
    if (c.issueUrl && c.alreadyTracked) {
      lines.push(`**Already tracked**: ${c.issueUrl}`);
    } else if (c.issueUrl) {
      lines.push(`**Created issue**: ${c.issueUrl}`);
    }
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
      ...(c.alreadyTracked !== undefined ? { alreadyTracked: c.alreadyTracked } : {}),
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
  deps: Pick<ImproveDeps, "createIssue" | "ghAuthCheck" | "listOpenImproveIssues" | "log">,
): Promise<void> {
  const minOcc = opts.minOccurrences ?? 3;

  const authed = await deps.ghAuthCheck();
  if (!authed) {
    throw new Error(
      "gh is not authenticated. Run `gh auth login` before using --apply.",
    );
  }

  // Fetched once per invocation regardless of cluster count (#421 D3).
  const openIssues = await deps.listOpenImproveIssues();
  const byTitle = new Map(openIssues.filter((i) => i.state === "OPEN").map((i) => [i.title, i]));

  const qualifying = clusters.filter((c) => c.count >= minOcc);
  for (const c of qualifying) {
    const title = proposedTitle(c);
    const existing = byTitle.get(title);
    if (existing) {
      c.issueUrl = existing.url;
      c.alreadyTracked = true;
      deps.log(`Already tracked: ${existing.url}`);
      continue;
    }
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
    // Reserve the title in-memory (#421 finding 4): two clusters whose signals
    // differ only past the 60-char truncation in proposedTitle() must not both
    // create an issue for the same title within one invocation.
    byTitle.set(title, { title, url: url || "", state: "OPEN", createdAt: "", labels: [] });
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

  // --interventions: collect all human_intervention events and emit a summary.
  if (opts.interventions) {
    const allEvents: Record<string, unknown>[] = [];
    for (const run of runs) {
      const eventsPath = path.join(run.dir, "events.jsonl");
      for await (const event of readEventsLines(eventsPath, deps)) {
        if ((event as { type?: unknown }).type === "human_intervention") {
          allEvents.push(event as Record<string, unknown>);
        }
      }
    }
    const summary = summarizeInterventions(allEvents);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

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
      clusterPapercuts(event, run.runId, clusters);
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
    const applyDeps: Pick<ImproveDeps, "createIssue" | "ghAuthCheck" | "listOpenImproveIssues" | "log"> = opts.json
      ? {
        createIssue: deps.createIssue,
        ghAuthCheck: deps.ghAuthCheck,
        listOpenImproveIssues: deps.listOpenImproveIssues,
        log: (msg) => { process.stderr.write(msg + "\n"); },
      }
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
