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
  clusterPapercuts,
  clustersToEntries,
  proposedTitle,
  readEventsLines,
  realImproveDeps,
  type ClusterAccum,
  type ClusterEntry,
  type OpenImproveIssue,
} from "../improve.ts";
import { redactSecrets, sanitize } from "../artifact-sanitize.ts";
import { withLock } from "../lock.ts";

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
): Promise<void> {
  let issues: OpenImproveIssue[];
  try {
    issues = await deps.listOpenImproveIssues();
  } catch (err) {
    deps.log(
      `[pipeline] papercut auto-file: reconciliation list failed (non-fatal) — ${title}: ${(err as Error).message}`,
    );
    return;
  }

  const closedNumbers = new Set<number>();

  const dupes = issues
    .filter((i) => i.state === "OPEN" && i.title === title)
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
          `[pipeline] papercut auto-file: reconciled cross-host duplicate — closed #${dup.number}, kept #${survivor.number}`,
        );
      } catch (err) {
        deps.log(
          `[pipeline] papercut auto-file: reconciliation close failed (non-fatal) for #${dup.number}: ${(err as Error).message}`,
        );
      }
    }
  }

  const inWindow = issues
    .filter((i) => i.state === "OPEN" && i.labels.includes("pipeline:backlog"))
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
      deps.log(`[pipeline] papercut auto-file: reconciled rate-cap overflow — closed #${over.number}`);
    } catch (err) {
      deps.log(
        `[pipeline] papercut auto-file: reconciliation close failed (non-fatal) for #${over.number}: ${(err as Error).message}`,
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
    `## Agent-reported friction (auto-filed by \`pipeline\`)`,
    ``,
    `_This issue was filed automatically by the pipeline from agent-reported friction ` +
      `(\`pipeline papercut\`). The content below is agent-reported, not human-authored ` +
      `or human-verified — verify independently before acting._`,
    ``,
    sanitize(redactSecrets(detail)),
  ].join("\n");
}

/** Cluster in-window `papercut` events across every run under `.agent-pipeline/runs/`
 *  and file one `pipeline:backlog` issue per qualifying, not-already-tracked cluster,
 *  up to the per-window rate cap. Total: every failure (unauthenticated gh, unreadable
 *  run artifacts, a throwing issue-creation call) is caught, logged as a non-fatal
 *  warning, and swallowed — this function can never fail a run, a stage, or a batch. */
export async function autoFilePapercuts(opts: AutoFileOpts, deps: AutoFileDeps): Promise<void> {
  try {
    const authed = await deps.ghAuthCheck();
    if (!authed) {
      deps.log("[pipeline] papercut auto-file: skipped (gh not authenticated)");
      return;
    }

    const dir = runsDir(opts.repoDir);
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await deps.readdir(dir);
    } catch {
      return;
    }

    const windowMs = opts.windowHours * 60 * 60 * 1000;
    const cutoffMs = deps.now() - windowMs;

    const clusters = new Map<string, ClusterAccum>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const eventsPath = path.join(dir, runId, "events.jsonl");
      for await (const event of readEventsLines(eventsPath, deps)) {
        if ((event as { type?: unknown }).type !== "papercut") continue;
        const at = typeof event["at"] === "string" ? Date.parse(event["at"] as string) : NaN;
        if (!Number.isFinite(at) || at < cutoffMs) continue;
        clusterPapercuts(event, runId, clusters);
      }
    }

    const allEntries = clustersToEntries(clusters, Number.MAX_SAFE_INTEGER);
    const qualifying = allEntries.filter((c) => c.count >= opts.minOccurrences);
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
          deps.log(`[pipeline] papercut auto-file: already tracked — ${title}`);
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
          deps.log(`[pipeline] papercut auto-file: already tracked — ${title}`);
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
            `[pipeline] papercut auto-file: cross-host state check failed (non-fatal), skipping — ${title}: ${(err as Error).message}`,
          );
          continue;
        }
        const freshOpenTitle = freshIssues.find((i) => i.state === "OPEN" && i.title === title);
        if (freshOpenTitle) {
          byTitle.set(title, freshOpenTitle);
          deps.log(`[pipeline] papercut auto-file: already tracked (cross-host) — ${title}`);
          continue;
        }
        if (filedInWindowCount(freshIssues) >= opts.maxPerWindow) {
          deps.log(`[pipeline] papercut auto-file: deferred (rate cap) — ${title}`);
          continue;
        }

        try {
          const body = buildAutoFileBody(c, opts.windowHours);
          const url = await deps.createIssue(title, body, ["pipeline:backlog"]);
          deps.log(`[pipeline] papercut auto-file: created ${url}`);
          byTitle.set(title, { title, url, state: "OPEN", createdAt: "", labels: ["pipeline:backlog"] });
          await reconcilePostCreateState(title, deps, cutoffMs, opts.maxPerWindow);
        } catch (err) {
          deps.log(`[pipeline] papercut auto-file: create failed (non-fatal): ${(err as Error).message}`);
        }
      }
    });
  } catch (err) {
    deps.log(`[pipeline] papercut auto-file failed (non-fatal): ${(err as Error).message}`);
  }
}
