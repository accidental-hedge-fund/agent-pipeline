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
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import {
  defaultLoopStoreDeps,
  readDurableRunBlockerOccurrences,
  type DurableBlockerOccurrence,
} from "./loop/store.ts";
import type { DurableBlockerClass } from "./loop/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClusterCategory =
  | "review-finding"
  | "blocker"
  | "flaky-gate"
  | "token-waste"
  | "papercut"
  | "correction"
  | "durable-run-blocker";

/** Next control level named by a correction proposal (#500). `undetermined` is
 *  a compiler-side sentinel, never an emitted `proposed_control` value — it
 *  means no consistent bounded evidence justified naming one of the other five. */
export type ControlLevel =
  | "instruction"
  | "skill-rubric"
  | "eval"
  | "deterministic-gate"
  | "human-judgment"
  | "undetermined";

/** Bounded evidence bundle carried only by `correction`-category clusters
 *  (#500). Every field is derived purely from the `correction_event` contract
 *  (#499) — never from raw-text similarity or an LLM. */
export interface CorrectionEvidence {
  /** The event contract's deterministic `correction_key` (#499) — the cluster's
   *  identity. Used as the dedup/title identity for auto-filed issues so that
   *  issue-level dedup never depends on free-text correction prose (#500 review 1). */
  correctionKey: string;
  distinctRunCount: number;
  distinctItemIds: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  stages: string[];
  actors: string[];
  failureClasses: string[];
  controlLevel: ControlLevel;
  /** Severity values (`critical`/`high`/`medium`/`low`) of finding evidence for this
   *  cluster's corrections, when available (#500 review 2 finding 02b2a1921d7c779a).
   *  `correction_event` (#499) itself never carries severity/impact — this is
   *  cross-referenced from the same run's `review_verdict` finding records via
   *  `evidence_ref: { kind: "finding", id }`. Empty when no correction in the
   *  cluster references a finding whose severity could be resolved. */
  severities: string[];
}

/** Bounded evidence bundle carried only by `durable-run-blocker`-category
 *  clusters (#538, capability `durable-run-blocker-auto-file`). Every field
 *  is derived purely from the durable-loop store's typed blocker records
 *  (#509) via {@link readDurableRunBlockerOccurrences} — never from raw-text
 *  similarity or an LLM. Milestone assignment stays a human decision:
 *  `suggestedMilestone` is advisory text only, never applied to a filed issue. */
export interface DurableRunBlockerEvidence {
  blockerClass: DurableBlockerClass;
  fingerprint: string;
  /** True when any occurrence in this cluster was a durable run's terminal
   *  {@link LoopStopRecord}. */
  terminal: boolean;
  itemIds: string[];
  suggestedMilestone: string;
}

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
  /** Populated only when category === "correction" (#500). */
  correction?: CorrectionEvidence;
  /** Populated only when category === "durable-run-blocker" (#538). */
  durableRunBlocker?: DurableRunBlockerEvidence;
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
  /** Read-only projection over the durable-loop store's ledgers (#538,
   *  capability `durable-run-blocker-auto-file`) — a distinct source from
   *  `readLines`/`readdir` above, which read `.agent-pipeline/runs/`. */
  readDurableRunBlockerOccurrences: () => Promise<DurableBlockerOccurrence[]>;
  log: (msg: string) => void;
}

/** `[pipeline-improve]`-prefixed issue title proposed for a cluster. Shared by
 *  the report, dedup lookup, and issue-creation paths so all three agree on
 *  the same title string.
 *
 *  For `correction` clusters, the title's identity is the deterministic
 *  `correction_key` (#500 review 1 finding fcb8ee87) rather than free-text
 *  `signal` prose — two different `correction_key`s that happen to normalize
 *  to identical prose must not collide, and the same `correction_key` whose
 *  source prose changes must still dedup against its prior issue. Prose stays
 *  in the issue body as descriptive evidence only. */
export function proposedTitle(
  c: Pick<ClusterEntry, "category" | "signal" | "correction" | "durableRunBlocker">,
): string {
  if (c.category === "correction" && c.correction) {
    return `[pipeline-improve] Recurring correction: ${c.correction.correctionKey}`;
  }
  if (c.category === "durable-run-blocker" && c.durableRunBlocker) {
    return `[pipeline-improve] Durable-run blocker: ${c.durableRunBlocker.blockerClass}:${c.durableRunBlocker.fingerprint}`;
  }
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
    readDurableRunBlockerOccurrences: () => readDurableRunBlockerOccurrences(defaultLoopStoreDeps()),
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
  // correction-specific accumulation (#500) — populated only for category === "correction".
  /** Distinct `correction_id`s seen. `count` mirrors this set's size so that
   *  repeated delivery/replay of one correction_id (#499 idempotency) never
   *  double-counts an occurrence. */
  correctionIds?: Set<string>;
  /** The `correction_key` this cluster is keyed on — the title/dedup identity
   *  for auto-filed correction issues (#500 review 1). */
  correctionKey?: string;
  itemIds?: Set<string>;
  stages?: Set<string>;
  actors?: Set<string>;
  failureClasses?: Set<string>;
  /** `proposed_control` recorded per distinct `correction_id` — including an
   *  empty string when a distinct occurrence carries no `proposed_control` at
   *  all. A cluster only gets a deterministic control level when this set has
   *  exactly one member and it's a valid, non-empty level; any absent or
   *  mixed occurrence yields a second distinct member and falls back to
   *  `undetermined` (#500 review 1 finding cc5edfd1). */
  proposedControls?: Set<string>;
  firstSeen?: string;
  lastSeen?: string;
  /** Severity values resolved via `evidence_ref` cross-reference — see
   *  `CorrectionEvidence.severities`. */
  severities?: Set<string>;
  // durable-run-blocker-specific accumulation (#538) — populated only for
  // category === "durable-run-blocker". `itemIds` above is reused as-is.
  /** The `DurableBlockerClass` this cluster is keyed on. */
  blockerClass?: DurableBlockerClass;
  /** The `evidence_fingerprint` this cluster is keyed on — the title/dedup
   *  identity for auto-filed durable-run-blocker issues. */
  fingerprint?: string;
  /** True once any occurrence folded into this cluster was a durable run's
   *  terminal stop attributable to it. Sticky — never reset back to false. */
  terminal?: boolean;
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

/** Index a `review_verdict` event's per-finding `key -> severity` into `out` (#500
 *  review 2 finding 02b2a1921d7c779a). `correction_event` (#499) never carries
 *  severity itself; a finding-derived correction's `evidence_ref.id` equals the
 *  originating finding's `findingKey` (see `correction.test.ts`), so severity is
 *  cross-referenced from this same run's `review_verdict` records rather than
 *  invented or guessed. */
export function collectFindingSeverities(
  event: Record<string, unknown>,
  out: Map<string, string>,
): void {
  if (event["type"] !== "review_verdict") return;
  const findings = event["findings"];
  if (!Array.isArray(findings)) return;
  for (const f of findings) {
    if (typeof f !== "object" || f === null) continue;
    const obj = f as Record<string, unknown>;
    const key = typeof obj["key"] === "string" ? obj["key"] : "";
    const severity = typeof obj["severity"] === "string" ? obj["severity"] : "";
    if (key && severity) out.set(key, severity);
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

/**
 * Extract a `correction_event` (#499) and accumulate into clusters keyed on
 * `correction:${correction_key}` (#500). Cluster *identity* is the event
 * contract's deterministic `correction_key` — never `normalizeSignal` free
 * text — so category isolation and cluster membership never depend on prose
 * similarity or a model. `normalizeSignal` is used only to derive the
 * human-readable `signal`/excerpt label, matching the other categories.
 *
 * Occurrence counting collapses duplicate deliveries/replays of one
 * `correction_id` (#499 idempotency guarantee) to a single occurrence: the
 * cluster's `count` always mirrors `correctionIds.size`, so re-processing the
 * same event twice (e.g. a corrupt/retried run artifact) never inflates it.
 *
 * `findingSeverities` (#500 review 2 finding 02b2a1921d7c779a) is an optional
 * `findingKey -> severity` lookup — see `collectFindingSeverities` — used to
 * resolve severity evidence for a finding-derived correction via its
 * `evidence_ref`. Absent when the caller has no severity data for this run.
 */
export function clusterCorrections(
  event: Record<string, unknown>,
  runId: string,
  clusters: Map<string, ClusterAccum>,
  findingSeverities?: Map<string, string>,
): void {
  if (event["type"] !== "correction_event") return;
  const correctionKey = typeof event["correction_key"] === "string" ? event["correction_key"] : "";
  const correctionId = typeof event["correction_id"] === "string" ? event["correction_id"] : "";
  if (!correctionKey || !correctionId) return;

  const correctionText = typeof event["correction"] === "string" ? event["correction"] : "";
  const stage = typeof event["stage"] === "string" ? event["stage"] : null;
  const actorKind = typeof event["actor_kind"] === "string" ? event["actor_kind"] : "";
  const failureClass = typeof event["failure_class"] === "string" ? event["failure_class"] : "";
  const issue = typeof event["issue"] === "number" ? event["issue"] : null;
  const at = typeof event["at"] === "string" ? event["at"] : "";
  const proposedControl = typeof event["proposed_control"] === "string" ? event["proposed_control"] : "";
  const evidenceRef = event["evidence_ref"];
  const severity =
    findingSeverities && typeof evidenceRef === "object" && evidenceRef !== null
      ? (() => {
        const ref = evidenceRef as Record<string, unknown>;
        if (ref["kind"] !== "finding" || typeof ref["id"] !== "string") return "";
        return findingSeverities.get(ref["id"]) ?? "";
      })()
      : "";

  const key = `correction:${correctionKey}`;
  let existing = clusters.get(key);
  if (!existing) {
    existing = {
      category: "correction",
      // Belt-and-braces (#500, matching #421 D7): correction text is already
      // sanitized/redacted at emission time (correction.ts), but re-sanitize
      // here so a secret can never reach a report line via a raw artifact read.
      signal: normalizeSignal(sanitize(redactSecrets(correctionText || correctionKey))),
      count: 0,
      runIds: new Set(),
      excerpt: truncateExcerpt(sanitize(redactSecrets(correctionText || correctionKey))),
      correctionIds: new Set(),
      correctionKey,
      itemIds: new Set(),
      stages: new Set(),
      actors: new Set(),
      failureClasses: new Set(),
      proposedControls: new Set(),
      severities: new Set(),
    };
    clusters.set(key, existing);
  }

  existing.runIds.add(runId);
  if (issue !== null) existing.itemIds!.add(String(issue));
  if (stage) existing.stages!.add(stage);
  if (actorKind) existing.actors!.add(actorKind);
  if (failureClass) existing.failureClasses!.add(failureClass);
  if (severity) existing.severities!.add(severity);
  if (at) {
    if (!existing.firstSeen || at < existing.firstSeen) existing.firstSeen = at;
    if (!existing.lastSeen || at > existing.lastSeen) existing.lastSeen = at;
  }
  if (!existing.correctionIds!.has(correctionId)) {
    existing.correctionIds!.add(correctionId);
    existing.count = existing.correctionIds!.size;
    // Recorded once per distinct correction_id, including "" when absent, so
    // an occurrence with no proposed_control is never silently dropped from
    // consideration — it shows up as a second distinct member alongside any
    // real level and correctly forces `undetermined` (#500 review 1 finding
    // a239bc44cbf42e7f).
    existing.proposedControls!.add(proposedControl);
  }
}

/** Deterministic, advisory-only milestone suggestion per {@link DurableBlockerClass}
 *  (#538). Never assigned to a filed issue — surfaced only as report/body prose so
 *  the "does this join the current release?" decision stays human. */
const SUGGESTED_MILESTONE_BY_BLOCKER_CLASS: Record<DurableBlockerClass, string> = {
  "transient-rate-limit": "next reliability-hardening milestone",
  "workflow-state": "next reliability-hardening milestone",
  "implementation-ci": "next reliability-hardening milestone",
  "environment-auth": "next operational-hardening milestone",
  "specification-decision": "next spec/process milestone",
  "missing-authority": "next spec/process milestone",
  "upstream-dependency": "next dependency-hardening milestone",
  "workflow-engine-defect": "next engine defect-fix milestone",
};

/** Deterministic *suggested* milestone for a durable-run-blocker cluster —
 *  advisory text only (#538). Exported so the report, `--apply` issue body,
 *  and auto-file body all agree on the same suggestion. */
export function suggestMilestoneForBlockerClass(blockerClass: DurableBlockerClass): string {
  return SUGGESTED_MILESTONE_BY_BLOCKER_CLASS[blockerClass];
}

/**
 * Extract a {@link DurableBlockerOccurrence} (#538, capability
 * `durable-run-blocker-auto-file`) and accumulate into clusters keyed on
 * `durable-run-blocker:<class>:<fingerprint>`. Cluster identity is the pair
 * `(blockerClass, fingerprint)` — never free-text prose — so title/dedup
 * identity never depends on the evidence excerpt's wording.
 *
 * `count` always mirrors `runIds.size` (distinct affected runs), matching the
 * qualification rule: a cluster qualifies to file when a terminal stop is
 * attributable to it OR it recurs across >= 2 distinct runs — never on raw
 * occurrence count within a single run. `terminal` is sticky: once any
 * occurrence in the cluster was a terminal stop, it stays true.
 */
export function clusterDurableRunBlockers(
  occurrence: DurableBlockerOccurrence,
  clusters: Map<string, ClusterAccum>,
): void {
  const key = `durable-run-blocker:${occurrence.blockerClass}:${occurrence.fingerprint}`;
  // Belt-and-braces (#538, matching #421 D7 / #500): ledger evidence text is
  // never sanitized at write time (loop/recovery.ts records the raw evidence
  // string), so sanitize here before it ever reaches a report line or issue body.
  const sanitizedExcerpt = sanitize(redactSecrets(occurrence.evidenceExcerpt));

  let existing = clusters.get(key);
  if (!existing) {
    existing = {
      category: "durable-run-blocker",
      signal: occurrence.blockerClass,
      count: 0,
      runIds: new Set(),
      excerpt: truncateExcerpt(sanitizedExcerpt),
      itemIds: new Set(),
      blockerClass: occurrence.blockerClass,
      fingerprint: occurrence.fingerprint,
      terminal: false,
    };
    clusters.set(key, existing);
  }

  existing.runIds.add(occurrence.runId);
  existing.itemIds!.add(occurrence.itemId);
  existing.count = existing.runIds.size;
  if (occurrence.terminal) existing.terminal = true;
}

/** Qualification predicate for a `durable-run-blocker` cluster (#538): fires
 *  when a terminal stop is attributable to it OR it recurs across a
 *  configured minimum of distinct runs (floored at 2 — a single non-terminal
 *  occurrence never qualifies). Exported so the report/`--apply` path
 *  (`applyIssues` below) and the auto-file path (`stages/papercut.ts`) agree
 *  on the exact same rule. */
export function qualifiesDurableRunBlocker(c: Pick<ClusterEntry, "runIds" | "durableRunBlocker">, minOccurrences: number): boolean {
  if (!c.durableRunBlocker) return false;
  if (c.durableRunBlocker.terminal) return true;
  const floor = Math.max(2, minOccurrences);
  return c.runIds.length >= floor;
}

/**
 * Name the next control level for a correction cluster (#500). This is a pure
 * function of the cluster's `proposedControls` set — the deterministic,
 * bounded `proposed_control` field recorded per-event by #499 — and never
 * consults raw text or an LLM, so cluster qualification/identity/level are
 * unaffected by whether any enrichment dep is present.
 *
 * Enforces the graduation ladder (`documented rule -> skill/rubric -> eval ->
 * deterministic gate`) by construction: the compiler only ever *repeats* a
 * level every event in the cluster already agreed on at emission time. It
 * never escalates — an absent or mixed `proposed_control` set (zero or 2+
 * distinct values) always falls back to `"undetermined"` rather than guessing
 * or inventing an `eval`/`deterministic-gate` level from partial evidence.
 */
export function proposeControlLevel(cluster: { proposedControls?: Iterable<string> }): ControlLevel {
  const distinct = new Set(cluster.proposedControls ?? []);
  if (distinct.size !== 1) return "undetermined";
  const [level] = distinct;
  if ((CONTROL_LEVELS as readonly string[]).includes(level)) {
    return level as ControlLevel;
  }
  return "undetermined";
}

const CONTROL_LEVELS = [
  "instruction",
  "skill-rubric",
  "eval",
  "deterministic-gate",
  "human-judgment",
] as const;

const CONTROL_LEVEL_ACCEPTANCE_CRITERIA: Record<ControlLevel, string[]> = {
  instruction: [
    "Add or update a documented instruction covering this failure class and stage.",
    "The next occurrence of this correction_key is prevented or caught earlier by the updated instruction.",
  ],
  "skill-rubric": [
    "Add or update a skill/rubric that encodes the correction as a checklist item.",
    "A reviewer or agent following the skill/rubric catches this failure class before it recurs.",
  ],
  eval: [
    "Add a golden-task eval that reproduces this failure class and asserts the corrected behavior.",
    "The eval fails without the fix and passes with it (proves the eval bites).",
  ],
  "deterministic-gate": [
    "Add a deterministic validator/gate that blocks this failure class before it reaches review.",
    "The gate fires on a reproduction of this failure class and is silent otherwise (no false positives on passing runs).",
  ],
  "human-judgment": [
    "Document the judgment boundary this correction reflects (taste, strategy, product judgment, or authority) rather than encoding it as a rule.",
    "Revisit only if this correction_key keeps recurring with materially new evidence.",
  ],
  undetermined: [
    "A human reviews the evidence below and selects one of: instruction, skill-rubric, eval, deterministic-gate, or human-judgment.",
    "No control level is proposed automatically until that review happens.",
  ],
};

/** Rationale line tying the named control level to the cluster's evidence
 *  (#500). Deterministic and template-based — never an LLM call. */
function controlLevelRationale(c: ClusterEntry): string {
  const ev = c.correction;
  if (!ev) return "";
  if (ev.controlLevel === "undetermined") {
    return `${c.count} correction occurrence(s) did not carry a single consistent proposed_control ` +
      `(absent or mixed across occurrences) — the graduation ladder (documented rule -> skill/rubric ` +
      `-> eval -> deterministic gate) is never escalated without consistent bounded evidence.`;
  }
  return `Every one of ${c.count} correction occurrence(s) in this cluster consistently recorded ` +
    `proposed_control: "${ev.controlLevel}" (failure_class: ${ev.failureClasses.join(", ") || "unknown"}).`;
}

/** Render the control-level proposal block (level, rationale, acceptance
 *  criteria) for a qualifying correction cluster — shared by the report and
 *  the auto-file/`--apply` issue body so all three surfaces agree. */
export function renderControlProposal(c: ClusterEntry): string[] {
  const ev = c.correction;
  if (!ev) return [];
  const lines = [
    `**Next control level**: ${ev.controlLevel}`,
    `**Rationale**: ${controlLevelRationale(c)}`,
    `**Acceptance criteria**:`,
    ...CONTROL_LEVEL_ACCEPTANCE_CRITERIA[ev.controlLevel].map((s) => `- ${s}`),
  ];
  return lines;
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
    .map((c) => {
      const entry: ClusterEntry = {
        category: c.category,
        signal: c.signal,
        count: c.count,
        runIds: [...c.runIds],
        excerpt: c.excerpt,
      };
      if (c.category === "correction") {
        entry.correction = {
          correctionKey: c.correctionKey ?? "",
          distinctRunCount: c.runIds.size,
          distinctItemIds: [...(c.itemIds ?? [])],
          firstSeen: c.firstSeen ?? null,
          lastSeen: c.lastSeen ?? null,
          stages: [...(c.stages ?? [])],
          actors: [...(c.actors ?? [])],
          failureClasses: [...(c.failureClasses ?? [])],
          controlLevel: proposeControlLevel({ proposedControls: c.proposedControls }),
          severities: [...(c.severities ?? [])].sort(),
        };
      }
      if (c.category === "durable-run-blocker" && c.blockerClass && c.fingerprint) {
        entry.durableRunBlocker = {
          blockerClass: c.blockerClass,
          fingerprint: c.fingerprint,
          terminal: c.terminal ?? false,
          itemIds: [...(c.itemIds ?? [])],
          suggestedMilestone: suggestMilestoneForBlockerClass(c.blockerClass),
        };
      }
      return entry;
    });
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
    if (c.correction) {
      lines.push(`**Distinct runs**: ${c.correction.distinctRunCount}`);
      lines.push(`**Distinct items (issues/PRs)**: ${c.correction.distinctItemIds.join(", ") || "none"}`);
      lines.push(`**First seen**: ${c.correction.firstSeen ?? "unknown"}`);
      lines.push(`**Last seen**: ${c.correction.lastSeen ?? "unknown"}`);
      lines.push(`**Affected stages**: ${c.correction.stages.join(", ") || "none"}`);
      lines.push(`**Affected actors**: ${c.correction.actors.join(", ") || "none"}`);
      if (c.correction.severities.length > 0) {
        lines.push(`**Severity evidence**: ${c.correction.severities.join(", ")}`);
      }
      lines.push(...renderControlProposal(c));
    }
    if (c.durableRunBlocker) {
      lines.push(`**Blocker class**: ${c.durableRunBlocker.blockerClass}`);
      lines.push(`**Evidence fingerprint**: ${c.durableRunBlocker.fingerprint}`);
      lines.push(`**Terminal stop**: ${c.durableRunBlocker.terminal ? "yes" : "no"}`);
      lines.push(`**Affected item ids**: ${c.durableRunBlocker.itemIds.join(", ") || "none"}`);
      lines.push(`**Suggested milestone**: ${c.durableRunBlocker.suggestedMilestone} (advisory only — never auto-assigned)`);
    }
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
      ...(c.correction !== undefined ? { correction: c.correction } : {}),
      ...(c.durableRunBlocker !== undefined ? { durableRunBlocker: c.durableRunBlocker } : {}),
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

/** Per-category default `--min-occurrences` threshold: the `correction`
 *  category defaults to 2 (#500 — singletons stay visible in report/`--json`
 *  but are never filed), every other category keeps the pre-existing default
 *  of 3. An explicit `opts.minOccurrences` overrides every category uniformly. */
function minOccurrencesFor(category: ClusterCategory, opts: { minOccurrences?: number }): number {
  if (opts.minOccurrences !== undefined) return opts.minOccurrences;
  return category === "correction" || category === "durable-run-blocker" ? 2 : 3;
}

/** Whether a cluster qualifies to file, honoring the `durable-run-blocker`
 *  category's distinct OR-based rule (#538) instead of the plain
 *  `count >= minOccurrences` threshold every other category uses. */
function qualifiesToFile(c: ClusterEntry, opts: { minOccurrences?: number }): boolean {
  if (c.category === "durable-run-blocker") {
    return qualifiesDurableRunBlocker(c, minOccurrencesFor(c.category, opts));
  }
  return c.count >= minOccurrencesFor(c.category, opts);
}

export async function applyIssues(
  clusters: ClusterEntry[],
  opts: { minOccurrences?: number },
  deps: Pick<ImproveDeps, "createIssue" | "ghAuthCheck" | "listOpenImproveIssues" | "log">,
): Promise<void> {
  const authed = await deps.ghAuthCheck();
  if (!authed) {
    throw new Error(
      "gh is not authenticated. Run `gh auth login` before using --apply.",
    );
  }

  // Fetched once per invocation regardless of cluster count (#421 D3).
  const openIssues = await deps.listOpenImproveIssues();
  const byTitle = new Map(openIssues.filter((i) => i.state === "OPEN").map((i) => [i.title, i]));

  const qualifying = clusters.filter((c) => qualifiesToFile(c, opts));
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
      ...(c.correction
        ? [
          ``,
          `### Correction evidence bundle`,
          `- Distinct runs: ${c.correction.distinctRunCount}`,
          `- Distinct items (issues/PRs): ${c.correction.distinctItemIds.join(", ") || "none"}`,
          `- First seen: ${c.correction.firstSeen ?? "unknown"}`,
          `- Last seen: ${c.correction.lastSeen ?? "unknown"}`,
          `- Affected stages: ${c.correction.stages.join(", ") || "none"}`,
          `- Affected actors: ${c.correction.actors.join(", ") || "none"}`,
          ...(c.correction.severities.length > 0 ? [`- Severity evidence: ${c.correction.severities.join(", ")}`] : []),
          ``,
          ...renderControlProposal(c),
        ]
        : []),
      ...(c.durableRunBlocker
        ? [
          ``,
          `### Durable-run blocker evidence`,
          `- Blocker class: ${c.durableRunBlocker.blockerClass}`,
          `- Evidence fingerprint: ${c.durableRunBlocker.fingerprint}`,
          `- Terminal stop: ${c.durableRunBlocker.terminal ? "yes" : "no"}`,
          `- Affected item ids: ${c.durableRunBlocker.itemIds.join(", ") || "none"}`,
          `- Suggested milestone (advisory only — never auto-assigned): ${c.durableRunBlocker.suggestedMilestone}`,
        ]
        : []),
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

  // Durable-run-blocker evidence (#538) lives under the loop state home, a
  // distinct source from `.agent-pipeline/runs/` above — read independently
  // so a report/`--apply` still surfaces these clusters even when no
  // `.agent-pipeline/runs/` data exists (e.g. a repo that only runs
  // `pipeline:loop`).
  const durableOccurrences = await deps.readDurableRunBlockerOccurrences();
  const sinceMs = opts.since ? Date.parse(opts.since) : null;

  if (runs.length === 0 && durableOccurrences.length === 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify([]) + "\n");
    } else {
      deps.log(`No run data found under ${runsDirPath}.`);
    }
    return;
  }

  const clusters = new Map<string, ClusterAccum>();
  let tokenWasteSkipped = true;

  for (const occurrence of durableOccurrences) {
    if (sinceMs !== null) {
      const occMs = Date.parse(occurrence.time);
      if (!isNaN(occMs) && occMs < sinceMs) continue;
    }
    clusterDurableRunBlockers(occurrence, clusters);
  }

  for (const run of runs) {
    const eventsPath = path.join(run.dir, "events.jsonl");
    // Per-run findingKey -> severity lookup (#500 review 2 finding 02b2a1921d7c779a):
    // populated as review_verdict events stream by, so a later correction_event in
    // the same run's append-only log can resolve its evidence_ref's severity.
    const findingSeverities = new Map<string, string>();
    for await (const event of readEventsLines(eventsPath, deps)) {
      collectFindingSeverities(event, findingSeverities);
      clusterReviewFindings(event, run.runId, clusters);
      clusterBlockers(event, run.runId, clusters);
      clusterFlakyGates(event, run.runId, clusters);
      clusterPapercuts(event, run.runId, clusters);
      clusterCorrections(event, run.runId, clusters, findingSeverities);
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
    await applyIssues(entries, { minOccurrences: opts.minOccurrences }, applyDeps);
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
