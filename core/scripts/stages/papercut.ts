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
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import {
  emitPapercut as realEmitPapercut,
  runDirPath,
  runsDir,
  type PapercutEvent,
} from "../run-store.ts";
import {
  clusterCorrections,
  clusterDurableRunBlockers,
  clusterPapercuts,
  clustersToEntries,
  collectFindingSeverities,
  proposedTitle,
  qualifiesDurableRunBlocker,
  readEventsLines,
  realImproveDeps,
  renderControlProposal,
  type ClusterAccum,
  type ClusterEntry,
  type OpenImproveIssue,
} from "../improve.ts";
import { redactSecrets, sanitize } from "../artifact-sanitize.ts";
import { withLock } from "../lock.ts";
import { defaultLoopStoreDeps, readDurableRunBlockerOccurrences, type DurableBlockerOccurrence } from "../loop/store.ts";

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
// papercutsEnabled
// ---------------------------------------------------------------------------

/** Best-effort, gh-free check of whether `papercuts.enabled` is set in
 *  `<repoDir>/.github/pipeline.yml`. Deliberately does not call the full
 *  `resolveConfig()` (which shells out to `gh repo view`) — the papercut CLI
 *  boundary must work unauthenticated and never throw. Any read/parse failure
 *  (missing file, invalid YAML, non-object root) resolves to false, matching
 *  the feature's documented inert-by-default contract. */
export async function papercutsEnabled(
  repoDir: string,
  deps: Pick<PapercutDeps, "readFile">,
): Promise<boolean> {
  try {
    const text = await deps.readFile(path.join(repoDir, ".github", "pipeline.yml"));
    const parsed = yaml.load(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const block = (parsed as { papercuts?: unknown }).papercuts;
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    return (block as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
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

/** Machine-readable marker (#459 review 2, finding 582c19e6) embedded in every
 *  auto-filed issue body by `buildAutoFileBody`. Neither the `[pipeline-improve]`
 *  title prefix (also used by `pipeline improve --apply`) nor the `pipeline:backlog`
 *  label (also applied by `/pipeline:triage` to human-managed issues) alone proves an
 *  issue was created by this auto-file path — reconciliation below requires this marker
 *  in the body before treating an issue as a reconciliation candidate, so a human-managed
 *  or otherwise-provenanced `pipeline:backlog` issue is never closed as a dupe or cap
 *  overflow. */
export const AUTO_FILE_PROVENANCE_MARKER = "<!-- pipeline:papercut-auto-filed -->";

/** Same role as `AUTO_FILE_PROVENANCE_MARKER`, but for issues auto-filed from
 *  recurring `correction` clusters (#500) — kept distinct so a papercut- and a
 *  correction-sourced auto-filed issue are never confused with each other by
 *  reconciliation, even though both reuse the same reconciliation function. */
export const CORRECTION_AUTO_FILE_PROVENANCE_MARKER = "<!-- pipeline:correction-auto-filed -->";

/** Same role as `AUTO_FILE_PROVENANCE_MARKER`/`CORRECTION_AUTO_FILE_PROVENANCE_MARKER`,
 *  but for issues auto-filed from durable-run-blocker clusters (#538) — kept distinct so
 *  reconciliation never conflates the three auto-file sources. */
export const DURABLE_RUN_BLOCKER_AUTO_FILE_PROVENANCE_MARKER = "<!-- pipeline:durable-run-blocker-auto-filed -->";

/** Post-create read-back reconciliation (#459, hardened for review finding
 *  f09ce15de2e6911a): re-list improve issues once and correct two distinct
 *  cross-host races against that single snapshot.
 *
 *  1. Duplicate-title: when `title` now maps to more than one **open** issue
 *     (a foreign host raced into the same create in the pre-create check's
 *     TOCTOU window), keep the lowest-numbered open issue and close the rest
 *     with a comment naming the survivor.
 *  2. Rate-cap overflow: two hosts near the cap can both pass the pre-create
 *     cap check (which only reads GitHub *before* either create lands) and
 *     then file *different* titles, overshooting `maxPerWindow` in a way the
 *     duplicate-title check above cannot see (different titles never look
 *     like dupes of each other). Recompute the in-window open auto-filed set
 *     from the same snapshot and close every issue past the lowest-numbered
 *     `maxPerWindow` survivors.
 *
 *  Both candidate sets are additionally restricted to issues whose body carries
 *  `AUTO_FILE_PROVENANCE_MARKER` (#459 review 2, finding 582c19e6) — a human-managed or
 *  `pipeline improve --apply`-created `pipeline:backlog`/`[pipeline-improve]`-titled issue
 *  never carries this marker and so is never a reconciliation candidate.
 *
 *  Both rules pick survivors by ascending issue number, so two hosts
 *  reconciling independently — potentially against different snapshots taken
 *  at different times — always converge on the same surviving set once every
 *  host's post-create reconciliation has run. Total: any failure (list or
 *  close) is caught, logged non-fatal, and left for a later trigger to
 *  reconcile — it never propagates. */
async function reconcilePostCreateState(
  title: string,
  deps: AutoFileDeps,
  cutoffMs: number,
  maxPerWindow: number,
  marker: string,
  logPrefix: string,
): Promise<void> {
  let issues: OpenImproveIssue[];
  try {
    issues = await deps.listOpenImproveIssues();
  } catch (err) {
    deps.log(
      `[pipeline] ${logPrefix}: reconciliation list failed (non-fatal) — ${title}: ${(err as Error).message}`,
    );
    return;
  }

  const closedNumbers = new Set<number>();

  const isAutoFiled = (i: OpenImproveIssue): boolean => (i.body ?? "").includes(marker);

  const dupes = issues
    .filter((i) => i.state === "OPEN" && i.title === title && isAutoFiled(i))
    .map((i) => ({ issue: i, number: issueNumberFromUrl(i.url) }))
    .filter((x): x is { issue: OpenImproveIssue; number: number } => x.number !== null)
    .sort((a, b) => a.number - b.number);
  if (dupes.length > 1) {
    const survivor = dupes[0];
    for (const dup of dupes.slice(1)) {
      try {
        await deps.closeIssue(
          dup.number,
          `Closed as a duplicate of #${survivor.number} — a concurrent pipeline run on another ` +
            `host auto-filed the same cluster (cross-host auto-file reconciliation).`,
        );
        closedNumbers.add(dup.number);
        deps.log(
          `[pipeline] ${logPrefix}: reconciled cross-host duplicate — closed #${dup.number}, kept #${survivor.number}`,
        );
      } catch (err) {
        deps.log(
          `[pipeline] ${logPrefix}: reconciliation close failed (non-fatal) for #${dup.number}: ${(err as Error).message}`,
        );
      }
    }
  }

  const inWindow = issues
    .filter((i) => i.state === "OPEN" && i.labels.includes("pipeline:backlog") && isAutoFiled(i))
    .map((i) => ({ number: issueNumberFromUrl(i.url), createdMs: Date.parse(i.createdAt) }))
    .filter(
      (x): x is { number: number; createdMs: number } =>
        x.number !== null &&
        !closedNumbers.has(x.number) &&
        Number.isFinite(x.createdMs) &&
        x.createdMs >= cutoffMs,
    )
    .sort((a, b) => a.number - b.number);
  for (const over of inWindow.slice(maxPerWindow)) {
    try {
      await deps.closeIssue(
        over.number,
        `Closed to enforce the auto-file rate cap (${maxPerWindow} per window) — a concurrent ` +
          `pipeline run on another host filed past the cap before this host's pre-create check ` +
          `observed it (cross-host auto-file reconciliation).`,
      );
      deps.log(`[pipeline] ${logPrefix}: reconciled rate-cap overflow — closed #${over.number}`);
    } catch (err) {
      deps.log(
        `[pipeline] ${logPrefix}: reconciliation close failed (non-fatal) for #${over.number}: ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// autoFilePapercuts (#421)
// ---------------------------------------------------------------------------

export interface AutoFileOpts {
  repoDir: string;
  /** Pipeline domain (#421 finding 2) — the repository-wide lock namespace
   *  shared by the run-finalization and queue-batch auto-file triggers, so
   *  concurrent invocations cannot double-file or exceed the rate cap. */
  domain: string;
  windowHours: number;
  maxPerWindow: number;
  minOccurrences: number;
}

export interface AutoFileDeps {
  /** Same lookup used by `improve --apply` (#421 D3) — one call per invocation,
   *  returning both open and closed `[pipeline-improve]` issues. Dedup filters
   *  to `state === "OPEN"`; the rate-window cap counts both states (#421 finding 3). */
  listOpenImproveIssues: () => Promise<OpenImproveIssue[]>;
  /** Create a GitHub issue with the given labels and return its URL. */
  createIssue: (title: string, body: string, labels: string[]) => Promise<string>;
  /** Close an issue with an explanatory comment (#459 cross-host duplicate
   *  reconciliation). Injectable so tests never touch real gh. */
  closeIssue: (number: number, comment: string) => Promise<void>;
  ghAuthCheck: () => Promise<boolean>;
  readLines: (p: string) => AsyncIterable<string>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  /** Read-only projection over the durable-loop store's ledgers (#538) — a
   *  distinct source from `readLines`/`readdir` above, which read
   *  `.agent-pipeline/runs/`. Used only by `autoFileDurableRunBlockers`. */
  readDurableRunBlockerOccurrences: () => Promise<DurableBlockerOccurrence[]>;
  /** Current time in epoch ms — injectable so tests control the trailing window. */
  now: () => number;
  /** Repository-wide critical section (#421 finding 2) — injectable so tests
   *  never touch the real /tmp lock file; the real impl delegates to
   *  `withLock` from `../lock.ts`. Throws when another process holds the lock. */
  withLock: <T>(domain: string, fn: () => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
}

export function realAutoFileDeps(repoDir: string): AutoFileDeps {
  const improveDeps = realImproveDeps(repoDir);
  return {
    listOpenImproveIssues: improveDeps.listOpenImproveIssues,
    ghAuthCheck: improveDeps.ghAuthCheck,
    readLines: improveDeps.readLines,
    readdir: improveDeps.readdir,
    readDurableRunBlockerOccurrences: () => readDurableRunBlockerOccurrences(defaultLoopStoreDeps()),
    now: () => Date.now(),
    withLock: (domain, fn) => withLock(domain, fn),
    log: (msg) => console.warn(msg),
    createIssue: async (title, body, labels) => {
      const args = ["issue", "create", "--title", title, "--body", body];
      for (const label of labels) args.push("--label", label);
      const r = spawnSync("gh", args, { encoding: "utf8", cwd: repoDir });
      if (r.status !== 0) {
        throw new Error(`gh issue create failed: ${r.stderr?.trim() ?? "unknown error"}`);
      }
      return (r.stdout ?? "").trim();
    },
    closeIssue: async (number, comment) => {
      const r = spawnSync(
        "gh",
        ["issue", "close", String(number), "--comment", comment],
        { encoding: "utf8", cwd: repoDir },
      );
      if (r.status !== 0) {
        throw new Error(`gh issue close failed: ${r.stderr?.trim() ?? "unknown error"}`);
      }
    },
  };
}

/** Extract the issue number from a `gh`-authored issue URL
 *  (`https://github.com/{owner}/{repo}/issues/{number}`). Returns null for any
 *  URL that doesn't match — callers must treat that as "can't determine a
 *  reliable ordering" rather than guessing. */
export function issueNumberFromUrl(url: string): number | null {
  const m = url.match(/\/issues\/(\d+)(?:[/?#].*)?$/);
  return m ? Number(m[1]) : null;
}

/** Agent-reported-provenance banner + sanitized evidence detail, following
 *  the same `sanitize(redactSecrets(...))` composition used elsewhere for
 *  artifacts assembled from stored events (#421 D7 — belt-and-braces:
 *  papercut messages are already screened/redacted at write time). */
function buildAutoFileBody(c: ClusterEntry, windowHours: number): string {
  const detail = [
    `**Signal**: ${c.signal}`,
    `**Occurrences**: ${c.count} (trailing ${windowHours}h window)`,
    ``,
    `### Affected run IDs`,
    ...c.runIds.map((id) => `- ${id}`),
    ``,
    `### Evidence excerpt`,
    "```",
    c.excerpt,
    "```",
  ].join("\n");
  return [
    AUTO_FILE_PROVENANCE_MARKER,
    `## Agent-reported friction (auto-filed by \`pipeline\`)`,
    ``,
    `_This issue was filed automatically by the pipeline from agent-reported friction ` +
      `(\`pipeline papercut\`). The content below is agent-reported, not human-authored ` +
      `or human-verified — verify independently before acting._`,
    ``,
    sanitize(redactSecrets(detail)),
  ].join("\n");
}

/** Correction-cluster analogue of `buildAutoFileBody` (#500): agent/pipeline-reported-
 *  provenance banner, sanitized evidence bundle, and the control-level proposal —
 *  reusing `renderControlProposal` so the auto-filed body agrees with the report and
 *  `--apply` issue body. Also states the single-host concurrency framing required by
 *  #459: the dedup/rate-cap and post-create reconciliation below are inherited from the
 *  papercut auto-file path's cross-host mechanism, but no cross-host global-dedup
 *  guarantee is newly asserted for the correction source. */
function buildCorrectionAutoFileBody(c: ClusterEntry, windowHours: number): string {
  const ev = c.correction;
  const detail = [
    `**Signal**: ${c.signal}`,
    `**Occurrences**: ${c.count} (trailing ${windowHours}h window)`,
    ...(ev
      ? [
        `**Distinct runs**: ${ev.distinctRunCount}`,
        `**Distinct items (issues/PRs)**: ${ev.distinctItemIds.join(", ") || "none"}`,
        `**First seen**: ${ev.firstSeen ?? "unknown"}`,
        `**Last seen**: ${ev.lastSeen ?? "unknown"}`,
        `**Affected stages**: ${ev.stages.join(", ") || "none"}`,
        `**Affected actors**: ${ev.actors.join(", ") || "none"}`,
        ...(ev.severities.length > 0 ? [`**Severity evidence**: ${ev.severities.join(", ")}`] : []),
      ]
      : []),
    ``,
    `### Affected run IDs`,
    ...c.runIds.map((id) => `- ${id}`),
    ``,
    `### Evidence excerpt`,
    "```",
    c.excerpt,
    "```",
    ``,
    ...renderControlProposal(c),
  ].join("\n");
  return [
    CORRECTION_AUTO_FILE_PROVENANCE_MARKER,
    `## Recurring correction detected by \`pipeline\` (auto-filed)`,
    ``,
    `_This issue was filed automatically by the pipeline from recurring \`correction_event\` ` +
      `records (#499/#500). The content below is agent/pipeline-reported, not human-authored ` +
      `or human-verified — verify independently before acting._`,
    ``,
    `_Concurrency scope (#459): correction auto-filing is supported single-host. The dedup, ` +
      `rate-cap, and post-create reconciliation checks below reuse the papercut auto-file ` +
      `path's cross-host mechanism, but that is described only as inherited behaviour — no new ` +
      `cross-host global-deduplication guarantee is asserted for the correction source._`,
    ``,
    sanitize(redactSecrets(detail)),
  ].join("\n");
}

/** Durable-run-blocker analogue of `buildAutoFileBody`/`buildCorrectionAutoFileBody`
 *  (#538): agent/pipeline-reported-provenance banner, sanitized ledger reproduction
 *  context (run ids, item ids, blocker class, evidence fingerprint, evidence excerpt),
 *  and the suggested-milestone note. The filed issue carries only `pipeline:backlog` —
 *  no milestone is ever assigned; the suggestion is advisory prose only. */
function buildDurableRunBlockerAutoFileBody(c: ClusterEntry, windowHours: number): string {
  const ev = c.durableRunBlocker;
  const detail = [
    `**Blocker class**: ${ev?.blockerClass ?? c.signal}`,
    `**Evidence fingerprint**: ${ev?.fingerprint ?? "unknown"}`,
    `**Terminal stop**: ${ev?.terminal ? "yes" : "no"}`,
    `**Distinct runs affected (trailing ${windowHours}h window)**: ${c.count}`,
    `**Affected item ids**: ${ev?.itemIds.join(", ") || "none"}`,
    `**Suggested milestone (advisory only — never auto-assigned)**: ${ev?.suggestedMilestone ?? "unknown"}`,
    ``,
    `### Affected run IDs`,
    ...c.runIds.map((id) => `- ${id}`),
    ``,
    `### Evidence excerpt`,
    "```",
    c.excerpt,
    "```",
  ].join("\n");
  return [
    DURABLE_RUN_BLOCKER_AUTO_FILE_PROVENANCE_MARKER,
    `## Durable-run blocker detected by \`pipeline:loop\` (auto-filed)`,
    ``,
    `_This issue was filed automatically by the pipeline from a durable \`pipeline:loop\` run's ` +
      `typed blocker classification (#509). The content below is agent/pipeline-reported, not ` +
      `human-authored or human-verified — verify independently before acting. Milestone assignment ` +
      `stays a human decision: the suggestion above is advisory only._`,
    ``,
    sanitize(redactSecrets(detail)),
  ].join("\n");
}

/** Shape shared by `autoFilePapercuts` and `autoFileCorrections` (#500): which
 *  event type to cluster, how to accumulate it, how to render its issue body,
 *  the provenance marker reconciliation uses to recognize its own issues, and
 *  the log-line prefix. */
interface AutoFileCategory {
  eventType: string;
  clusterFn: (
    event: Record<string, unknown>,
    runId: string,
    clusters: Map<string, ClusterAccum>,
    findingSeverities?: Map<string, string>,
  ) => void;
  buildBody: (c: ClusterEntry, windowHours: number) => string;
  marker: string;
  logPrefix: string;
  /** Overrides the default `.agent-pipeline/runs/` events.jsonl scan below with
   *  a category-specific cluster source (#538) — used by the durable-run-blocker
   *  category, whose evidence lives under the loop state home instead. */
  buildClusters?: (opts: AutoFileOpts, deps: AutoFileDeps) => Promise<Map<string, ClusterAccum>>;
  /** Overrides the default `count >= opts.minOccurrences` qualification check
   *  (#538) — used by the durable-run-blocker category's OR-based rule
   *  (terminal stop OR recurs across >= minOccurrences distinct runs). */
  qualifies?: (c: ClusterEntry, opts: AutoFileOpts) => boolean;
}

/** Cluster in-window events of `category.eventType` across every run under
 *  `.agent-pipeline/runs/` and file one `pipeline:backlog` issue per qualifying,
 *  not-already-tracked cluster, up to the per-window rate cap. Total: every
 *  failure (unauthenticated gh, unreadable run artifacts, a throwing
 *  issue-creation call) is caught, logged as a non-fatal warning, and
 *  swallowed — this function can never fail a run, a stage, or a batch. Shared
 *  by `autoFilePapercuts` (#421) and `autoFileCorrections` (#500) so both reuse
 *  the exact same minimum-occurrence, dedup, rate-cap, sanitization, and
 *  cross-host reconciliation machinery. */
async function autoFileClusterCategory(
  opts: AutoFileOpts,
  deps: AutoFileDeps,
  category: AutoFileCategory,
): Promise<void> {
  try {
    const authed = await deps.ghAuthCheck();
    if (!authed) {
      deps.log(`[pipeline] ${category.logPrefix}: skipped (gh not authenticated)`);
      return;
    }

    // `.agent-pipeline/runs/` is a different evidence source from the durable-loop
    // store's ledgers (#538) — a category with its own `buildClusters` reads
    // neither this directory nor its listing, so its absence must never short-
    // circuit that category (e.g. a repo that only runs `pipeline:loop`).
    const dir = runsDir(opts.repoDir);
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    if (!category.buildClusters) {
      try {
        entries = await deps.readdir(dir);
      } catch {
        return;
      }
    }

    const windowMs = opts.windowHours * 60 * 60 * 1000;
    const cutoffMs = deps.now() - windowMs;

    const clusters = category.buildClusters
      ? await category.buildClusters(opts, deps)
      : new Map<string, ClusterAccum>();
    if (!category.buildClusters) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runId = entry.name;
        const eventsPath = path.join(dir, runId, "events.jsonl");
        // Per-run findingKey -> severity lookup (#500 review 2 finding
        // 02b2a1921d7c779a), mirroring runImprove — lets a correction cluster's
        // evidence bundle resolve severity via evidence_ref even on this
        // reduced, single-event-type-filtered scan.
        const findingSeverities = new Map<string, string>();
        for await (const event of readEventsLines(eventsPath, deps)) {
          collectFindingSeverities(event, findingSeverities);
          if ((event as { type?: unknown }).type !== category.eventType) continue;
          const at = typeof event["at"] === "string" ? Date.parse(event["at"] as string) : NaN;
          if (!Number.isFinite(at) || at < cutoffMs) continue;
          category.clusterFn(event, runId, clusters, findingSeverities);
        }
      }
    }

    const allEntries = clustersToEntries(clusters, Number.MAX_SAFE_INTEGER);
    const qualifying = category.qualifies
      ? allEntries.filter((c) => category.qualifies!(c, opts))
      : allEntries.filter((c) => c.count >= opts.minOccurrences);
    if (qualifying.length === 0) return;

    // Concurrency (#421 finding 2): the dedup lookup, cap calculation, and issue
    // creation below must be a single critical section shared by every trigger
    // (run-finalization and queue-batch) — otherwise two concurrent invocations
    // can observe the same empty snapshot and both file past the cap, or file
    // duplicate titles before either issue is visible to the other. withLock
    // throws if another process holds the lock; the outer catch below swallows
    // that (this invocation simply skips filing — a later trigger will retry).
    await deps.withLock(opts.domain, async () => {
      // Dedup (#421 D3) — same lookup applyIssues() uses, called once per invocation.
      const openIssues = await deps.listOpenImproveIssues();
      const byTitle = new Map(openIssues.filter((i) => i.state === "OPEN").map((i) => [i.title, i]));

      const toFile: ClusterEntry[] = [];
      for (const c of qualifying) {
        const title = proposedTitle(c);
        if (byTitle.has(title)) {
          deps.log(`[pipeline] ${category.logPrefix}: already tracked — ${title}`);
          continue;
        }
        toFile.push(c);
      }
      if (toFile.length === 0) return;

      const filedInWindowCount = (issues: OpenImproveIssue[]): number =>
        issues.filter((i) => {
          if (!i.labels.includes("pipeline:backlog")) return false;
          const createdMs = Date.parse(i.createdAt);
          return Number.isFinite(createdMs) && createdMs >= cutoffMs;
        }).length;

      for (const c of toFile) {
        const title = proposedTitle(c);
        // Re-check byTitle (#421 finding 4): two qualifying clusters whose signals
        // differ only past the 60-char truncation in proposedTitle() must not both
        // file an issue for the same title within one invocation.
        if (byTitle.has(title)) {
          deps.log(`[pipeline] ${category.logPrefix}: already tracked — ${title}`);
          continue;
        }

        // Cross-host cap + dedup (#459): `withLock` only serializes this host.
        // Re-read GitHub-authored issue state immediately before creating so a
        // duplicate title or a cap-filling issue filed by another host (or by
        // this host's own prior iteration, once created) is counted before we
        // file — rather than trusting the single up-front `openIssues` snapshot
        // for the whole loop.
        let freshIssues: OpenImproveIssue[];
        try {
          freshIssues = await deps.listOpenImproveIssues();
        } catch (err) {
          deps.log(
            `[pipeline] ${category.logPrefix}: cross-host state check failed (non-fatal), skipping — ${title}: ${(err as Error).message}`,
          );
          continue;
        }
        const freshOpenTitle = freshIssues.find((i) => i.state === "OPEN" && i.title === title);
        if (freshOpenTitle) {
          byTitle.set(title, freshOpenTitle);
          deps.log(`[pipeline] ${category.logPrefix}: already tracked (cross-host) — ${title}`);
          continue;
        }
        if (filedInWindowCount(freshIssues) >= opts.maxPerWindow) {
          deps.log(`[pipeline] ${category.logPrefix}: deferred (rate cap) — ${title}`);
          continue;
        }

        try {
          const body = category.buildBody(c, opts.windowHours);
          const url = await deps.createIssue(title, body, ["pipeline:backlog"]);
          deps.log(`[pipeline] ${category.logPrefix}: created ${url}`);
          byTitle.set(title, { title, url, state: "OPEN", createdAt: "", labels: ["pipeline:backlog"], body });
          await reconcilePostCreateState(title, deps, cutoffMs, opts.maxPerWindow, category.marker, category.logPrefix);
        } catch (err) {
          deps.log(`[pipeline] ${category.logPrefix}: create failed (non-fatal): ${(err as Error).message}`);
        }
      }
    });
  } catch (err) {
    deps.log(`[pipeline] ${category.logPrefix} failed (non-fatal): ${(err as Error).message}`);
  }
}

const PAPERCUT_AUTO_FILE_CATEGORY: AutoFileCategory = {
  eventType: "papercut",
  clusterFn: clusterPapercuts,
  buildBody: buildAutoFileBody,
  marker: AUTO_FILE_PROVENANCE_MARKER,
  logPrefix: "papercut auto-file",
};

const CORRECTION_AUTO_FILE_CATEGORY: AutoFileCategory = {
  eventType: "correction_event",
  clusterFn: clusterCorrections,
  buildBody: buildCorrectionAutoFileBody,
  marker: CORRECTION_AUTO_FILE_PROVENANCE_MARKER,
  logPrefix: "correction auto-file",
};

/** Builds `durable-run-blocker` clusters from the durable-loop store's ledgers
 *  (#538) instead of `.agent-pipeline/runs/` events.jsonl — the evidence source
 *  the other two categories scan. Honors the same trailing-window semantics
 *  (`opts.windowHours` against `deps.now()`) via each occurrence's own
 *  evidence timestamp. */
async function buildDurableRunBlockerClusters(opts: AutoFileOpts, deps: AutoFileDeps): Promise<Map<string, ClusterAccum>> {
  const occurrences = await deps.readDurableRunBlockerOccurrences();
  const windowMs = opts.windowHours * 60 * 60 * 1000;
  const cutoffMs = deps.now() - windowMs;
  const clusters = new Map<string, ClusterAccum>();
  for (const occurrence of occurrences) {
    const at = Date.parse(occurrence.time);
    if (!Number.isFinite(at) || at < cutoffMs) continue;
    clusterDurableRunBlockers(occurrence, clusters);
  }
  return clusters;
}

const DURABLE_RUN_BLOCKER_AUTO_FILE_CATEGORY: AutoFileCategory = {
  eventType: "loop_item_blocked",
  clusterFn: () => {
    throw new Error("durable-run-blocker uses buildClusters, not the events.jsonl clusterFn path");
  },
  buildBody: buildDurableRunBlockerAutoFileBody,
  marker: DURABLE_RUN_BLOCKER_AUTO_FILE_PROVENANCE_MARKER,
  logPrefix: "durable-run-blocker auto-file",
  buildClusters: buildDurableRunBlockerClusters,
  qualifies: (c, opts) => qualifiesDurableRunBlocker(c, opts.minOccurrences),
};

/** Opt-in papercut auto-file (#421). See `autoFileClusterCategory` for the
 *  shared machinery and its totality/non-fatal contract. */
export async function autoFilePapercuts(opts: AutoFileOpts, deps: AutoFileDeps): Promise<void> {
  return autoFileClusterCategory(opts, deps, PAPERCUT_AUTO_FILE_CATEGORY);
}

/** Opt-in correction auto-file (#500): reuses the exact same minimum-occurrence,
 *  open-issue dedup, per-window rate cap, sanitization, provenance, and
 *  cross-host reconciliation machinery as `autoFilePapercuts` (#421), keyed on
 *  `correction` clusters instead of `papercut` clusters. Off/inert unless the
 *  caller gates it on `config.corrections.auto_file` — see `pipeline-run.ts`
 *  and `stages/queue.ts`. Honors the single-host concurrency scope of #459 —
 *  see `buildCorrectionAutoFileBody` for the documented framing. */
export async function autoFileCorrections(opts: AutoFileOpts, deps: AutoFileDeps): Promise<void> {
  return autoFileClusterCategory(opts, deps, CORRECTION_AUTO_FILE_CATEGORY);
}

/** Opt-in durable-run-blocker auto-file (#538, capability
 *  `durable-run-blocker-auto-file`): reuses `autoFileClusterCategory`'s dedup,
 *  rate-cap, sanitization, provenance, and cross-host reconciliation machinery
 *  unchanged, keyed on `durable-run-blocker` clusters built from the
 *  durable-loop store's ledgers instead of `.agent-pipeline/runs/` events.
 *  Qualification is the OR-based rule from `qualifiesDurableRunBlocker`
 *  (terminal stop OR recurs across >= minOccurrences distinct runs), not the
 *  plain count threshold `autoFilePapercuts`/`autoFileCorrections` use.
 *  Off/inert unless the caller gates it on `config.durable_runs.auto_file` —
 *  see `pipeline.ts`. */
export async function autoFileDurableRunBlockers(opts: AutoFileOpts, deps: AutoFileDeps): Promise<void> {
  return autoFileClusterCategory(opts, deps, DURABLE_RUN_BLOCKER_AUTO_FILE_CATEGORY);
}
