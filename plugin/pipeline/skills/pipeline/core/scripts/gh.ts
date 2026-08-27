// Typed wrappers for the `gh` CLI.
//
// Every helper:
//   - Uses execFile (NOT execShell) so args don't need escaping.
//   - Targets cfg.repo via the `-R owner/name` flag.
//   - Returns parsed typed data, never raw subprocess.Result.
//   - Throws Error on non-zero exit (with stderr) instead of returning a status object.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  attestPipelineComment,
  extractPipelineAttestation,
  isVerifiedPipelineAttestation,
} from "./stages/review-parsing.ts";
import { BUILTIN_ADAPTER_NAMES } from "./harness-adapters/registry.ts";
import {
  BLOCKED_LABEL,
  BLOCKER_RECIPES,
  DEFAULT_BLOCKER_KIND,
  LABEL_PREFIX,
  STAGES,
  type BlockerKind,
  type CheckRun,
  type ItemDetail,
  type PipelineConfig,
  type PrDetail,
  type Stage,
} from "./types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// GhMetricsCollector — per-run gh call instrumentation (#257)
// ---------------------------------------------------------------------------

export interface GhMetricsSummary {
  call_count: number;
  total_ms: number;
  p50_ms: number;
  p95_ms: number;
  slowest_calls: { category: string; elapsed_ms: number }[];
  /**
   * Per-run call counts keyed by stable typed-wrapper name (e.g. `getPrDetail`).
   * Untagged records contribute to aggregates only and are omitted here (#839).
   */
  by_wrapper: Record<string, number>;
}

/** Interpolated percentile over a sorted sample (linear interpolation). Returns 0 for empty. */
function computePercentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const position = (p / 100) * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, n - 1);
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export class GhMetricsCollector {
  private times: number[] = [];
  private _slowest: { category: string; elapsed_ms: number }[] = [];
  private _byWrapper = new Map<string, number>();

  /**
   * Record one completed `gh` invocation.
   * @param category CLI category (first two `gh` args) — used by `slowest_calls`.
   * @param elapsedMs wall time for the attempt.
   * @param wrapperName optional stable typed-helper name (e.g. `getPrChecks`);
   *   never derived from raw args. Empty/undefined → aggregates only, not `by_wrapper`.
   */
  record(category: string, elapsedMs: number, wrapperName?: string): void {
    this.times.push(elapsedMs);
    this._slowest.push({ category, elapsed_ms: elapsedMs });
    this._slowest.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
    if (this._slowest.length > 5) this._slowest.length = 5;
    if (wrapperName) {
      this._byWrapper.set(wrapperName, (this._byWrapper.get(wrapperName) ?? 0) + 1);
    }
  }

  summary(): GhMetricsSummary {
    const by_wrapper: Record<string, number> = {};
    for (const [k, v] of this._byWrapper) by_wrapper[k] = v;
    const n = this.times.length;
    if (n === 0) {
      return {
        call_count: 0,
        total_ms: 0,
        p50_ms: 0,
        p95_ms: 0,
        slowest_calls: [],
        by_wrapper,
      };
    }
    const total_ms = this.times.reduce((a, b) => a + b, 0);
    const sorted = [...this.times].sort((a, b) => a - b);
    return {
      call_count: n,
      total_ms,
      p50_ms: Math.floor(computePercentile(sorted, 50)),
      p95_ms: Math.floor(computePercentile(sorted, 95)),
      slowest_calls: [...this._slowest],
      by_wrapper,
    };
  }
}

/** Module-level active collector — set by pipeline.ts at run start, cleared at run end.
 *  Avoids threading a collector parameter through every gh wrapper function signature. */
let _activeCollector: GhMetricsCollector | undefined;

/** Set the active metrics collector for the current dispatch cycle. Pass undefined to clear. */
export function setGhCollector(collector: GhMetricsCollector | undefined): void {
  _activeCollector = collector;
}

/** Module-level active run ID — set by pipeline.ts at run start, cleared at run end.
 *  Used by transition() and setBlocked() to embed idempotency sentinels without
 *  threading a runId parameter through every call site. */
let _activeRunId: string | undefined;

/** Set the active run ID for the current dispatch cycle. Pass undefined to clear. */
export function setGhRunId(id: string | undefined): void {
  _activeRunId = id;
}

/**
 * Module-level discovery channel for the active run (#763) — set by pipeline-run
 * from the persisted run.json stamp (or the init default). Used by setBlocked so
 * blocker comments inherit the active run's channel rather than hardcoding live-run.
 * Cleared with the rest of per-run module state at dispatch end.
 */
let _activeDiscoveryChannel: import("./engine-attribution.ts").DiscoveryChannel | undefined;

/** Set the active discovery channel for the current dispatch cycle. Pass undefined to clear. */
export function setGhDiscoveryChannel(
  channel: import("./engine-attribution.ts").DiscoveryChannel | undefined,
): void {
  _activeDiscoveryChannel = channel;
}

// ---------------------------------------------------------------------------
// Idempotent audit helpers (#259)
// ---------------------------------------------------------------------------

/** Build the HTML audit sentinel embedded in transition and blocker comments.
 *  The sentinel is invisible in rendered Markdown and anchors idempotency checks. */
export function buildAuditSentinel(runId: string, state: string): string {
  return `<!-- pipeline-audit: run=${runId} state=${state} -->`;
}

/** Retry a comment-post thunk up to `attempts` times with exponential backoff
 *  (1 s base, doubling per attempt). Re-throws the last error after exhaustion.
 *  `sleep` is injectable so unit tests skip the real delay. */
export async function retryComment(
  thunk: () => Promise<void>,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await thunk();
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        await sleep(2 ** i * 1000);
      }
    }
  }
  throw lastErr ?? new Error("retryComment: unknown failure");
}

/** I/O seam for {@link reconcileAuditComment} so unit tests inject fakes — no real network. */
export interface ReconcileAuditDeps {
  postComment: (cfg: PipelineConfig, n: number, body: string) => Promise<void>;
  warn: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Scan the most-recent `comments` (up to 20) for an HTML audit sentinel whose
 *  `state` attribute matches `currentState`. If found, returns immediately (no-op).
 *  If not found, posts `commentBody` as a repair comment (with up to 3 retries) and
 *  logs a warning via `deps.warn`. Re-throws on exhaustion so the caller can surface the failure. */
export async function reconcileAuditComment(
  cfg: PipelineConfig,
  issueNumber: number,
  currentState: string,
  runId: string,
  commentBody: string,
  comments: { author: string; body: string }[],
  trustedActor: string | null,
  deps: ReconcileAuditDeps = { postComment, warn: (m) => console.warn(m) },
): Promise<void> {
  const marker = ` state=${currentState} -->`;
  const recent = comments.slice(-20);
  // Only trust a sentinel when the comment BOTH looks like a pipeline audit comment
  // (starts with "## Pipeline:") AND was authored by the pipeline's own GitHub actor.
  // Body-prefix alone is forgeable: anyone can post "## Pipeline: …<!-- pipeline-audit:
  // state=X -->" to suppress a real audit-repair. When the actor can't be resolved
  // (trustedActor null) we trust nothing and post the repair — failing toward an extra
  // audit comment, never toward suppressing a genuine label-without-audit partial failure.
  const found =
    trustedActor != null &&
    recent.some(
      (c) =>
        c.author === trustedActor &&
        c.body.trimStart().startsWith("## Pipeline:") &&
        c.body.includes("<!-- pipeline-audit:") &&
        c.body.includes(marker),
    );
  if (found) return;
  deps.warn(
    `[pipeline] #${issueNumber}: audit sentinel for state=${currentState} (run=${runId}) missing from recent comments; posting repair`,
  );
  await retryComment(() => deps.postComment(cfg, issueNumber, commentBody), 3, deps.sleep);
}

// Stage priority for picking the "furthest along" pipeline label when multiple
// are applied. Higher priority = further along, so the forward index in
// STAGES IS the priority directly.
const STAGE_PRIORITY: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  STAGES.forEach((s, i) => {
    m[s] = i;
  });
  return m;
})();

/**
 * Config-sourced skill footer block shared by stage-transition and blocked
 * comments. Matches the `---` separator style used by planning / review /
 * deploy_ready builders. Falls back only when callers omit a footer (pure
 * unit tests); production paths pass `cfg.marker_footer`.
 */
function commentFooterBlock(markerFooter?: string | null): string {
  const footer = (markerFooter ?? "*Automated by Claude Code Pipeline Skill*").trim();
  return `\n\n---\n${footer}`;
}

/**
 * Classify a gh CLI error string as transient (worth retrying) or deterministic.
 * Operates case-insensitively. Exported for unit tests.
 *
 * Transient: HTTP 401 bad credentials, HTTP 403 rate-limit, any HTTP 5xx, or
 * network-level errors (ETIMEDOUT, ECONNRESET, ENOTFOUND, socket hang up).
 * Deterministic: HTTP 404, HTTP 422, "not found", "validation failed",
 * "unprocessable", "resource not accessible", or any unrecognized pattern.
 */
export function isTransientGhError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  // HTTP 401 with "bad credentials" — momentary API blip
  if (s.includes("401") && s.includes("bad credentials")) return true;
  // HTTP 403 with rate-limit indicator
  if (s.includes("403") && (s.includes("rate limit") || s.includes("secondary rate limit"))) return true;
  // Any HTTP 5xx status code
  if (/http 5\d\d/.test(s)) return true;
  // Network-level errors
  if (s.includes("etimedout") || s.includes("econnreset") || s.includes("enotfound") || s.includes("socket hang up")) return true;
  return false;
}

/**
 * Error shape thrown by execFileAsync when the subprocess exits non-zero.
 * Exported for use in GhRunOptions.runner fakes in unit tests.
 */
export interface GhSubprocessError {
  stderr?: string | Buffer;
  message: string;
  code?: number;
}

/** Injectable subprocess runner seam for GhRunOptions — matches the signature
 *  used by execFileAsync internally so unit tests can fake subprocess results
 *  without spawning real processes. */
export type GhSubprocessRunner = (args: string[]) => Promise<{ stdout: string }>;

export interface GhRunOptions {
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Number of retries on transient errors. Default 3. */
  retries?: number;
  /** Metrics collector for the current run. Falls back to module-level active collector. */
  collector?: GhMetricsCollector;
  /** Injectable delay function — used by tests to skip real waits during backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable transient-error classifier — replaces `isTransientGhError` when provided. */
  isTransient?: (stderr: string) => boolean;
  /** Injectable subprocess runner — replaces execFileAsync in unit tests. */
  runner?: GhSubprocessRunner;
  /**
   * Stable typed-wrapper name for `GhMetricsCollector` `by_wrapper` breakdown
   * (e.g. `getPrDetail`). Must be a fixed code identifier — never raw args (#839).
   */
  wrapperName?: string;
}

/**
 * Environment for every `gh` child. Host harnesses often export FORCE_COLOR /
 * CLICOLOR; with those set, `gh --json` can emit ANSI-colored stdout that
 * breaks `JSON.parse` in `getIssueDetail` and other typed wrappers (workflow-state
 * false failures: status/summary crash, or partial recovery mis-reads). Always
 * force a machine-readable, uncolored child env without mutating the parent.
 */
export function ghChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  };
}

async function ghRun(args: string[], opts: GhRunOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const collector = opts.collector ?? _activeCollector;
  const _sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const _isTransient = opts.isTransient ?? isTransientGhError;
  const _runner: GhSubprocessRunner = opts.runner ?? ((runArgs) =>
    execFileAsync("gh", runArgs, {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      env: ghChildEnv(),
    })
  );
  const category = args.slice(0, 2).join(" ");
  const wrapperName = opts.wrapperName;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const t0 = performance.now();
    try {
      const { stdout } = await _runner(args);
      collector?.record(category, Math.round(performance.now() - t0), wrapperName);
      return stdout;
    } catch (err) {
      collector?.record(category, Math.round(performance.now() - t0), wrapperName);
      const e = err as GhSubprocessError;
      const combinedStderr = (e.stderr ?? "").toString() || e.message;
      lastErr = new Error(
        `gh ${args.slice(0, 3).join(" ")} failed: ${combinedStderr.trim() || e.message}`,
      );
      if (_isTransient(combinedStderr) && attempt < retries - 1) {
        const backoff = 2 ** attempt * 1000;
        await _sleep(backoff);
        continue;
      }
      throw lastErr;
    }
  }
  // Unreachable, but keep the type checker happy.
  throw lastErr ?? new Error("gh: unknown failure");
}

/** Thin re-export of ghRun that exposes GhRunOptions seams for unit tests.
 *  Not intended for production callers — use the typed wrapper functions instead. */
export async function ghRunForTest(args: string[], opts: GhRunOptions): Promise<string> {
  return ghRun(args, opts);
}

// ---------------------------------------------------------------------------
// Issue / PR detail
// ---------------------------------------------------------------------------

export async function getIssueDetail(
  cfg: PipelineConfig,
  issueNumber: number,
  opts?: GhRunOptions,
): Promise<ItemDetail & { comments: { author: string; body: string; createdAt: string }[] }> {
  const stdout = await ghRun(
    [
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,body,labels,comments,state,url",
      "-R",
      cfg.repo,
    ],
    { ...opts, wrapperName: "getIssueDetail" },
  );
  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    body: string;
    state: string;
    url: string;
    labels: { name: string }[];
    comments: { author?: { login: string }; body: string; createdAt: string }[];
  };
  return {
    number: data.number,
    type: "issue",
    title: data.title,
    body: data.body ?? "",
    state: (data.state.toLowerCase() === "closed" ? "closed" : "open") as "open" | "closed",
    url: data.url,
    labels: (data.labels ?? []).map((l) => l.name),
    comments: (data.comments ?? []).map((c) => ({
      author: c.author?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.createdAt,
    })),
  };
}

/** I/O seam for {@link getIssueLabelEvents}: defaults to the module `gh` runner;
 *  unit tests inject a fake to assert the request shape and simulate responses
 *  without touching the network. */
export type GhApiRunner = (args: string[]) => Promise<string>;

/** Fetch pipeline-label additions for `last_event` (#154).
 *  Uses the GraphQL timeline bounded to the **latest** 100 labeled events
 *  (`timelineItems(last: 100, itemTypes: [LABELED_EVENT])`). A page-1 REST
 *  `issues/{n}/events` scan returns the *oldest* 100 events, so on an issue with
 *  more than 100 events it can exclude the current `pipeline:*` transition and
 *  yield a stale or null `last_event`; the `last: 100` window always includes the
 *  most recent label change. Throws on any GitHub failure so the caller's JSON
 *  error envelope captures the real cause rather than silently returning stale data. */
export async function getIssueLabelEvents(
  cfg: PipelineConfig,
  issueNumber: number,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "getIssueLabelEvents" }),
): Promise<{ label: string; createdAt: string }[]> {
  const [owner, repo] = cfg.repo.split("/");
  const stdout = await run([
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo)" +
      "{issue(number:$num){timelineItems(last:100,itemTypes:[LABELED_EVENT])" +
      "{nodes{__typename ... on LabeledEvent{createdAt label{name}}}}}}}",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `num=${issueNumber}`,
    "--jq",
    '.data.repository.issue.timelineItems.nodes[] | select(.label.name | startswith("pipeline:")) | {label: .label.name, createdAt: .createdAt}',
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { label: string; createdAt: string });
}

/** Lightweight state + label fetch (no comments). Used for worktree-cap
 *  filtering, where we just need to know "is this issue still in-flight?" */
export async function getIssueStateAndLabels(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<{ state: "open" | "closed"; labels: string[] } | null> {
  try {
    const stdout = await ghRun(
      [
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "state,labels",
        "-R",
        cfg.repo,
      ],
      { wrapperName: "getIssueStateAndLabels" },
    );
    const data = JSON.parse(stdout) as {
      state: string;
      labels: { name: string }[];
    };
    return {
      state: (data.state.toLowerCase() === "closed" ? "closed" : "open") as
        | "open"
        | "closed",
      labels: (data.labels ?? []).map((l) => l.name),
    };
  } catch {
    return null;
  }
}

/** An issue's open/closed state plus GitHub's own close reason — the evidence the
 *  `durable-run-dependency-integrity` capability needs to classify an external dependency as
 *  `satisfied` (closed as completed) vs. `unsatisfiable` (closed as not planned) vs. `pending`
 *  (open). `stateReason` is null for an open issue. Confirmed real `gh issue view --json` field
 *  names via `gh issue view --json foo` (unknown-field error listing) and a live closed-issue
 *  read (CLAUDE.md golden rule #5) — values observed: "COMPLETED", "NOT_PLANNED". */
export async function getIssueCloseState(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<{ state: "open" | "closed"; stateReason: "completed" | "not_planned" | "reopened" | null } | null> {
  try {
    const stdout = await ghRun(
      [
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "state,stateReason",
        "-R",
        cfg.repo,
      ],
      { wrapperName: "getIssueCloseState" },
    );
    const data = JSON.parse(stdout) as { state: string; stateReason: string | null };
    const state = data.state.toUpperCase() === "CLOSED" ? "closed" : "open";
    const stateReason =
      data.stateReason === "COMPLETED"
        ? "completed"
        : data.stateReason === "NOT_PLANNED"
          ? "not_planned"
          : data.stateReason === "REOPENED"
            ? "reopened"
            : null;
    return { state, stateReason };
  } catch {
    return null;
  }
}

/** Detect issue vs PR via the REST API (PRs have a `pull_request` field). */
export async function getItemKind(
  cfg: PipelineConfig,
  number: number,
): Promise<"issue" | "pull_request"> {
  const stdout = await ghRun(
    [
      "api",
      `/repos/${cfg.repo}/issues/${number}`,
      "--jq",
      "if .pull_request then \"pull_request\" else \"issue\" end",
    ],
    { wrapperName: "getItemKind" },
  );
  const trimmed = stdout.trim();
  return trimmed === "pull_request" ? "pull_request" : "issue";
}

/** For a PR, return the linked closing issue number, or null. */
export async function getPrLinkedIssue(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<number | null> {
  try {
    const stdout = await ghRun(
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "closingIssuesReferences",
        "-R",
        cfg.repo,
      ],
      { wrapperName: "getPrLinkedIssue" },
    );
    const data = JSON.parse(stdout) as {
      closingIssuesReferences?: { number: number }[];
    };
    const refs = data.closingIssuesReferences ?? [];
    return refs.length > 0 ? refs[0].number : null;
  } catch {
    return null;
  }
}

export async function getPrDetail(
  cfg: PipelineConfig,
  prNumber: number,
  opts?: GhRunOptions,
): Promise<PrDetail> {
  const stdout = await ghRun(
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,title,body,state,url,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,isDraft,additions,deletions,changedFiles,mergeCommit",
      "-R",
      cfg.repo,
    ],
    { ...opts, wrapperName: "getPrDetail" },
  );
  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    body: string;
    state: string;
    url: string;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    mergeable: string;
    mergeStateStatus: string;
    isDraft: boolean;
    additions: number;
    deletions: number;
    changedFiles: number;
    mergeCommit: { oid: string } | null;
  };
  const stateUpper = data.state.toUpperCase();
  const state =
    stateUpper === "MERGED" ? "merged" : stateUpper === "CLOSED" ? "closed" : "open";
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    state,
    url: data.url,
    head_ref: data.headRefName,
    head_sha: data.headRefOid,
    base_ref: data.baseRefName,
    mergeable:
      data.mergeable === "MERGEABLE" ? true : data.mergeable === "CONFLICTING" ? false : null,
    mergeable_state: data.mergeStateStatus,
    draft: data.isDraft,
    additions: data.additions,
    deletions: data.deletions,
    changed_files: data.changedFiles,
    merge_commit_sha: data.mergeCommit?.oid ?? null,
  };
}

/**
 * List PR check runs via `gh pr checks --json`.
 *
 * `gh` exits non-zero with a stderr message containing "no checks reported"
 * when the PR has zero observable checks (no workflow runs / no check-runs).
 * That is a valid empty result for pre-merge (#95) and merge (#275) — not a
 * transport failure. Normalize it to `[]` so callers do not spin until
 * `ci_timeout` treating the CLI failure as an indefinite wait (#882).
 *
 * Optional `opts` is for unit tests (injectable runner / retries); production
 * callers omit it.
 */
export async function getPrChecks(
  cfg: PipelineConfig,
  prNumber: number,
  opts?: GhRunOptions,
): Promise<CheckRun[]> {
  try {
    const stdout = await ghRun(
      [
        "pr",
        "checks",
        String(prNumber),
        "--json",
        "name,state,bucket,description,link",
        "-R",
        cfg.repo,
      ],
      { ...opts, wrapperName: "getPrChecks" },
    );
    return JSON.parse(stdout) as CheckRun[];
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (text.toLowerCase().includes("no checks reported")) {
      return [];
    }
    throw err;
  }
}

/**
 * True when `gh pr diff` failed because GitHub refused the whole-PR diff as too
 * large (HTTP 406 media-type cap, or GitHub too-large wording). Pure; exported
 * for unit tests. A SHA/path/command fragment that only contains the digits
 * `406` is not a too-large signal (#1223).
 */
export function isPrDiffTooLargeError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  const hasHttp406 =
    s.includes("http 406") ||
    s.includes("status code: 406") ||
    s.includes("status code 406");
  const hasTooLargeWording =
    s.includes("too_large") ||
    s.includes("exceeded the maximum number of files") ||
    s.includes("exceeded maximum number of files") ||
    s.includes("diff is too large") ||
    s.includes("pullrequest.diff too_large");
  return hasHttp406 || hasTooLargeWording;
}

/** REST list-pull-request-files entry fields used by the 406 fallback (#1223). */
interface PrDiffFileEntry {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
  sha?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changes?: unknown;
  patch?: unknown;
}

const PR_FILES_LIST_CAP = 3000;
/** Before/after files-list bookends; fail closed if the PR is still moving. */
const PR_DIFF_FALLBACK_PIN_ATTEMPTS = 3;

function prDiffRunOpts(opts: GhRunOptions | undefined, extra: GhRunOptions): GhRunOptions {
  return { ...opts, ...extra, wrapperName: "getPrDiff" };
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function entryFilename(entry: PrDiffFileEntry, prNumber: number): string {
  if (typeof entry.filename !== "string" || entry.filename.length === 0) {
    throw new Error(`getPrDiff: files-list entry missing filename for PR #${prNumber}`);
  }
  return entry.filename;
}

function entryFromPath(entry: PrDiffFileEntry, toPath: string): string {
  return typeof entry.previous_filename === "string" && entry.previous_filename.length > 0
    ? entry.previous_filename
    : toPath;
}

function hasNonEmptyPatch(entry: PrDiffFileEntry): boolean {
  return typeof entry.patch === "string" && entry.patch.length > 0;
}

function hasOmittedTextChange(entry: PrDiffFileEntry): boolean {
  return (
    numericField(entry.changes) > 0 ||
    numericField(entry.additions) > 0 ||
    numericField(entry.deletions) > 0
  );
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function diffGitHeader(fromPath: string, toPath: string): string {
  return `diff --git a/${fromPath} b/${toPath}`;
}

function binaryDifferLine(fromPath: string, toPath: string): string {
  return `Binary files a/${fromPath} and b/${toPath} differ`;
}

function unifiedDeletePatch(fromPath: string, _toPath: string, text: string): string {
  const lines = splitTextLines(text);
  const n = lines.length;
  const hunk = n === 0 ? "@@ -0,0 +0,0 @@" : `@@ -1,${n} +0,0 @@`;
  return [
    `--- a/${fromPath}`,
    "+++ /dev/null",
    hunk,
    ...lines.map((line) => `-${line}`),
  ].join("\n");
}

function unifiedAddPatch(_fromPath: string, toPath: string, text: string): string {
  const lines = splitTextLines(text);
  const n = lines.length;
  const hunk = n === 0 ? "@@ -0,0 +0,0 @@" : `@@ -0,0 +1,${n} @@`;
  return [
    "--- /dev/null",
    `+++ b/${toPath}`,
    hunk,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function unifiedReplacePatch(
  fromPath: string,
  toPath: string,
  oldText: string,
  newText: string,
): string {
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  const oldN = oldLines.length;
  const newN = newLines.length;
  const hunk =
    oldN === 0 && newN === 0
      ? "@@ -0,0 +0,0 @@"
      : `@@ -${oldN === 0 ? "0,0" : `1,${oldN}`} +${newN === 0 ? "0,0" : `1,${newN}`} @@`;
  return [
    `--- a/${fromPath}`,
    `+++ b/${toPath}`,
    hunk,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function encodeContentsApiPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

type DecodedBlob = { kind: "text"; text: string } | { kind: "binary" };

function decodeGitBlob(parsed: unknown, path: string, prNumber: number): DecodedBlob {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`getPrDiff: invalid blob JSON for PR #${prNumber} path ${path}`);
  }
  const blob = parsed as { content?: unknown; encoding?: unknown };
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error(`getPrDiff: blob for PR #${prNumber} path ${path} is not base64`);
  }
  const buf = Buffer.from(blob.content, "base64");
  if (buf.includes(0)) return { kind: "binary" };
  return { kind: "text", text: buf.toString("utf8") };
}

function flattenPrFilesPages(parsed: unknown, prNumber: number): PrDiffFileEntry[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`getPrDiff: invalid files-list JSON for PR #${prNumber}`);
  }
  return (parsed as unknown[]).flat() as PrDiffFileEntry[];
}

async function fetchGitBlob(
  cfg: PipelineConfig,
  sha: string,
  path: string,
  prNumber: number,
  opts: GhRunOptions | undefined,
): Promise<DecodedBlob> {
  let stdout: string;
  try {
    stdout = await ghRun(
      ["api", `repos/${cfg.repo}/git/blobs/${sha}`],
      prDiffRunOpts(opts, {}),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `getPrDiff: blob retrieval failed for PR #${prNumber} path ${path}: ${msg}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`getPrDiff: invalid blob JSON for PR #${prNumber} path ${path}`);
  }
  return decodeGitBlob(parsed, path, prNumber);
}

async function fetchPrRevision(
  cfg: PipelineConfig,
  prNumber: number,
  opts: GhRunOptions | undefined,
): Promise<{ baseSha: string; headSha: string }> {
  let stdout: string;
  try {
    stdout = await ghRun(
      ["api", `repos/${cfg.repo}/pulls/${prNumber}`],
      prDiffRunOpts(opts, {}),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`getPrDiff: failed to read PR #${prNumber} revision: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`getPrDiff: invalid PR JSON for PR #${prNumber}`);
  }
  const obj = parsed as { base?: { sha?: unknown }; head?: { sha?: unknown } } | null;
  const baseSha = obj?.base?.sha;
  const headSha = obj?.head?.sha;
  if (typeof baseSha !== "string" || baseSha.length === 0) {
    throw new Error(`getPrDiff: PR #${prNumber} has no base SHA`);
  }
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error(`getPrDiff: PR #${prNumber} has no head SHA`);
  }
  return { baseSha, headSha };
}

async function fetchCompareMergeBaseSha(
  cfg: PipelineConfig,
  baseSha: string,
  headSha: string,
  prNumber: number,
  opts: GhRunOptions | undefined,
): Promise<string> {
  let stdout: string;
  try {
    stdout = await ghRun(
      ["api", `repos/${cfg.repo}/compare/${baseSha}...${headSha}`],
      prDiffRunOpts(opts, {}),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `getPrDiff: failed to read PR #${prNumber} compare merge-base: ${msg}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`getPrDiff: invalid compare JSON for PR #${prNumber}`);
  }
  const sha = (parsed as { merge_base_commit?: { sha?: unknown } } | null)
    ?.merge_base_commit?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error(`getPrDiff: PR #${prNumber} compare has no merge-base SHA`);
  }
  return sha;
}

async function fetchContentsBlobSha(
  cfg: PipelineConfig,
  path: string,
  ref: string,
  prNumber: number,
  opts: GhRunOptions | undefined,
): Promise<string> {
  const encodedPath = encodeContentsApiPath(path);
  let stdout: string;
  try {
    stdout = await ghRun(
      ["api", `repos/${cfg.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`],
      prDiffRunOpts(opts, {}),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `getPrDiff: contents retrieval failed for PR #${prNumber} path ${path}: ${msg}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`getPrDiff: invalid contents JSON for PR #${prNumber} path ${path}`);
  }
  const sha = (parsed as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error(`getPrDiff: contents for PR #${prNumber} path ${path} has no blob sha`);
  }
  return sha;
}

async function materializeOmittedTextPatch(
  cfg: PipelineConfig,
  prNumber: number,
  entry: PrDiffFileEntry,
  fromPath: string,
  toPath: string,
  opts: GhRunOptions | undefined,
  getMergeBaseSha: () => Promise<string>,
): Promise<string> {
  const sha = typeof entry.sha === "string" ? entry.sha : "";
  if (!sha) {
    throw new Error(
      `getPrDiff: omitted text patch for PR #${prNumber} path ${toPath} has no blob sha`,
    );
  }
  const status = typeof entry.status === "string" ? entry.status : "";
  if (status === "removed" || status === "deleted") {
    const decoded = await fetchGitBlob(cfg, sha, toPath, prNumber, opts);
    if (decoded.kind === "binary") return binaryDifferLine(fromPath, toPath);
    return unifiedDeletePatch(fromPath, toPath, decoded.text);
  }
  if (status === "added") {
    const decoded = await fetchGitBlob(cfg, sha, toPath, prNumber, opts);
    if (decoded.kind === "binary") return binaryDifferLine(fromPath, toPath);
    return unifiedAddPatch(fromPath, toPath, decoded.text);
  }
  const newDecoded = await fetchGitBlob(cfg, sha, toPath, prNumber, opts);
  const mergeBaseSha = await getMergeBaseSha();
  const oldSha = await fetchContentsBlobSha(cfg, fromPath, mergeBaseSha, prNumber, opts);
  const oldDecoded = await fetchGitBlob(cfg, oldSha, fromPath, prNumber, opts);
  if (newDecoded.kind === "binary" || oldDecoded.kind === "binary") {
    return binaryDifferLine(fromPath, toPath);
  }
  return unifiedReplacePatch(fromPath, toPath, oldDecoded.text, newDecoded.text);
}

async function composePrDiffFromFilesList(
  cfg: PipelineConfig,
  prNumber: number,
  opts: GhRunOptions | undefined,
): Promise<string> {
  let lastBefore: { baseSha: string; headSha: string } | undefined;
  let lastAfter: { baseSha: string; headSha: string } | undefined;

  for (let attempt = 1; attempt <= PR_DIFF_FALLBACK_PIN_ATTEMPTS; attempt++) {
    const before = await fetchPrRevision(cfg, prNumber, opts);
    const stdout = await ghRun(
      ["api", `repos/${cfg.repo}/pulls/${prNumber}/files?per_page=100`, "--paginate", "--slurp"],
      prDiffRunOpts(opts, { timeoutMs: 120_000 }),
    );
    const after = await fetchPrRevision(cfg, prNumber, opts);
    if (before.baseSha !== after.baseSha || before.headSha !== after.headSha) {
      lastBefore = before;
      lastAfter = after;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`getPrDiff: invalid JSON from files API for PR #${prNumber}`);
    }
    const files = flattenPrFilesPages(parsed, prNumber);
    if (files.length === 0) {
      throw new Error(
        `getPrDiff: empty files list after too-large diff for PR #${prNumber}`,
      );
    }
    if (files.length >= PR_FILES_LIST_CAP) {
      throw new Error(
        `getPrDiff: PR #${prNumber} files list hit GitHub's 3000-file cap ` +
          `(received ${files.length} files). Cannot claim a complete review from a partial list.`,
      );
    }

    const pinnedBaseSha = after.baseSha;
    const pinnedHeadSha = after.headSha;
    let cachedMergeBaseSha: string | undefined;
    const getMergeBaseSha = async (): Promise<string> => {
      if (cachedMergeBaseSha) return cachedMergeBaseSha;
      cachedMergeBaseSha = await fetchCompareMergeBaseSha(
        cfg,
        pinnedBaseSha,
        pinnedHeadSha,
        prNumber,
        opts,
      );
      return cachedMergeBaseSha;
    };

    const blocks: string[] = [];
    for (const entry of files) {
      const toPath = entryFilename(entry, prNumber);
      const fromPath = entryFromPath(entry, toPath);
      const header = diffGitHeader(fromPath, toPath);
      if (hasNonEmptyPatch(entry)) {
        const patch = entry.patch as string;
        blocks.push(patch.startsWith(header) ? patch : `${header}\n${patch}`);
        continue;
      }
      if (!hasOmittedTextChange(entry)) {
        blocks.push(header);
        continue;
      }
      const materialized = await materializeOmittedTextPatch(
        cfg,
        prNumber,
        entry,
        fromPath,
        toPath,
        opts,
        getMergeBaseSha,
      );
      blocks.push(`${header}\n${materialized}`);
    }
    const composed = blocks.join("\n");
    if (!composed) {
      throw new Error(`getPrDiff: composed empty diff for PR #${prNumber}`);
    }
    return composed.endsWith("\n") ? composed : `${composed}\n`;
  }

  const fromPair = lastBefore;
  const toPair = lastAfter;
  throw new Error(
    `getPrDiff: PR #${prNumber} moved during files-list fallback` +
      (fromPair && toPair
        ? ` (base/head ${fromPair.baseSha}/${fromPair.headSha} then ${toPair.baseSha}/${toPair.headSha})`
        : "") +
      `. Cannot compose a consistent diff.`,
  );
}

/**
 * Fetch PR patch text. Fast path: `gh pr diff`. On HTTP 406 / too-large,
 * compose a unified diff from the paginated files list (worktree-independent).
 * Optional `opts` is for unit tests (injectable runner); production callers omit it.
 */
export async function getPrDiff(
  cfg: PipelineConfig,
  prNumber: number,
  opts?: GhRunOptions,
): Promise<string> {
  try {
    return await ghRun(
      ["pr", "diff", String(prNumber), "-R", cfg.repo],
      prDiffRunOpts(opts, { timeoutMs: 60_000, retries: 1 }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isPrDiffTooLargeError(msg)) throw err;
    return await composePrDiffFromFilesList(cfg, prNumber, opts);
  }
}

/**
 * Parse a GitHub Contents API listing of `openspec/changes/` into active change
 * ids (directories only; excludes `archive`). Pure; exported for unit tests.
 * Used by {@link listPrHeadChangeDirs} for tip-tree membership (#714).
 */
export function activeChangeIdsFromContentsEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { name?: unknown; type?: unknown };
    if (e.type === "dir" && typeof e.name === "string" && e.name !== "archive" && e.name.length > 0) {
      ids.push(e.name);
    }
  }
  return ids.sort();
}

/**
 * True when stderr/message looks like an HTTP 404-class response (status signal).
 * Pure; exported for unit tests. Does **not** by itself mean "path missing" —
 * GitHub also 404s private resources when the token lacks access (#714 delta).
 */
export function isHttp404Signal(stderr: string): boolean {
  const s = stderr.toLowerCase();
  // Only explicit HTTP status syntax — never a bare "404" token.
  // SHA/command fragments (e.g. ref a404b…, path …/404/…) must not
  // classify a non-404 failure as path-missing (#714 review: aaa27d9c).
  return (
    s.includes("http 404") ||
    s.includes("status code: 404") ||
    s.includes("status code 404")
  );
}

/**
 * True when the error is clearly auth/permission rather than "path not on tip".
 * Pure; exported for unit tests. Such errors must fail closed — never map to [].
 */
export function isGithubAuthOrPermissionError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("http 401") ||
    s.includes("http 403") ||
    s.includes("status code: 401") ||
    s.includes("status code: 403") ||
    s.includes("bad credentials") ||
    s.includes("resource not accessible") ||
    s.includes("authentication") ||
    s.includes("permission denied") ||
    s.includes("must have push access") ||
    s.includes("required scopes")
  );
}

/**
 * Whether a failed `openspec/changes` Contents list may be treated as empty.
 * Only when the error is a 404-class signal, is **not** auth/permission-shaped,
 * **and** a tip-root Contents probe already succeeded (proves the tip is listable
 * with current credentials). Pure; exported for unit tests (#714 delta 4706fcc2).
 */
export function shouldTreatContents404AsEmpty(
  openspecErrorMessage: string,
  tipRootListSucceeded: boolean,
): boolean {
  if (!tipRootListSucceeded) return false;
  if (isGithubAuthOrPermissionError(openspecErrorMessage)) return false;
  return isHttp404Signal(openspecErrorMessage);
}

/**
 * Active OpenSpec change ids present on the reviewed PR head tree (tip membership).
 *
 * Lists `openspec/changes/` via the GitHub Contents API at the PR head SHA — the
 * authoritative final tree, not a cumulative PR changed-file list. Archive-path
 * subtraction on cumulative paths can mask a reintroduced `openspec/changes/<id>/`
 * when both path families appear in the PR (#714 review 2).
 *
 * Missing `openspec/changes` on a **readable** tip → []. Auth/permission failures
 * and ambiguous 404s (tip root also unlistable) throw so callers fail closed —
 * never invent an empty active set from a bare "404"/"not found" substring
 * (#714 pre-merge delta override-key 4706fcc2).
 */
export async function listPrHeadChangeDirs(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<string[]> {
  const detail = await getPrDetail(cfg, prNumber);
  const ref = detail.head_sha;
  if (!ref) {
    throw new Error(`PR #${prNumber} has no head SHA — cannot list OpenSpec tip-tree change dirs`);
  }
  const refQ = encodeURIComponent(ref);
  let stdout: string;
  try {
    stdout = await ghRun(
      ["api", `repos/${cfg.repo}/contents/openspec/changes?ref=${refQ}`],
      { retries: 1, wrapperName: "listPrHeadChangeDirs" },
    );
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Auth/permission: fail closed immediately (do not map to []).
    if (isGithubAuthOrPermissionError(msg)) throw err;
    // Only 404-class signals may mean "path absent on tip" — still confirm tip root.
    if (!isHttp404Signal(msg)) throw err;
    let tipRootOk = false;
    try {
      await ghRun(
        ["api", `repos/${cfg.repo}/contents/?ref=${refQ}`],
        { retries: 1, wrapperName: "listPrHeadChangeDirs" },
      );
      tipRootOk = true;
    } catch (probeErr) {
      const probeMsg = ((probeErr as Error).message ?? "").trim();
      throw new Error(
        `listPrHeadChangeDirs: openspec/changes unavailable for PR #${prNumber} ` +
          `and tip root is not listable at ${ref.slice(0, 12)} — failing closed ` +
          `(possible auth/permission obscuring 404). openspec: ${msg.trim()}; ` +
          `tip-root: ${probeMsg || "unknown"}`,
      );
    }
    if (shouldTreatContents404AsEmpty(msg, tipRootOk)) return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `listPrHeadChangeDirs: invalid JSON from contents API for PR #${prNumber}`,
    );
  }
  return activeChangeIdsFromContentsEntries(parsed);
}

/**
 * The PR's commits, oldest-first (base → head). Used by the pre-merge review-SHA
 * gate (#16) to classify the commits that landed since a review verdict: a
 * developer commit invalidates the verdict, pipeline-internal commits (docs /
 * openspec archive) do not.
 */
export async function getPrCommits(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<{ oid: string; messageHeadline: string }[]> {
  const stdout = await ghRun(
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "commits",
      "-R",
      cfg.repo,
    ],
    { wrapperName: "getPrCommits" },
  );
  const data = JSON.parse(stdout) as {
    commits?: { oid: string; messageHeadline?: string }[];
  };
  return (data.commits ?? []).map((c) => ({
    oid: c.oid,
    messageHeadline: c.messageHeadline ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Stage / label helpers
// ---------------------------------------------------------------------------

export function pickStage(labels: string[]): Stage | null {
  const stages: string[] = [];
  for (const name of labels) {
    if (name.startsWith(LABEL_PREFIX)) {
      stages.push(name.slice(LABEL_PREFIX.length));
    }
  }
  if (stages.length === 0) return null;
  // Pick the furthest-along stage if multiple are present.
  let best = stages[0];
  for (const s of stages) {
    if ((STAGE_PRIORITY[s] ?? -1) > (STAGE_PRIORITY[best] ?? -1)) best = s;
  }
  return STAGES.includes(best as Stage) ? (best as Stage) : null;
}

export function isBlocked(labels: string[]): boolean {
  return labels.includes(BLOCKED_LABEL);
}

/**
 * Parse the first `harness:<name>` issue label with a non-empty suffix.
 * Accepts any harness name (claude, codex, grok, opencode, pi, …) — not only
 * the historical claude/codex pair (#954).
 */
export function getHarnessLabel(labels: string[]): string | null {
  for (const name of labels) {
    if (name.startsWith("harness:")) {
      const h = name.slice("harness:".length);
      if (h) return h;
    }
  }
  return null;
}

/**
 * Desired pipeline labels for bootstrap (blocked + every built-in harness + stages).
 * Pure + exported so unit tests can assert the harness set without network I/O.
 */
export function desiredPipelineLabels(): { name: string; color: string; description: string }[] {
  return [
    { name: BLOCKED_LABEL, color: "D73A4A", description: "Pipeline blocked awaiting human or external action" },
    ...BUILTIN_ADAPTER_NAMES.map((name) => ({
      name: `harness:${name}`,
      // Preserve historical colors for the original pair; other adapters share purple.
      color: name === "codex" ? "0052CC" : "6F42C1",
      description: `Pipeline item owned by ${name.charAt(0).toUpperCase()}${name.slice(1)} primary harness`,
    })),
    ...STAGES.map((stage) => ({
      name: `${LABEL_PREFIX}${stage}`,
      color:
        stage === "ready-to-deploy"
          ? "0E8A16"
          : stage === "needs-human"
            ? "D93F0B"
            : stage.includes("review")
              ? "5319E7"
              : "1D76DB",
      description: `Pipeline stage: ${stage}`,
    })),
  ];
}

export async function ensurePipelineLabels(cfg: PipelineConfig): Promise<void> {
  const desired = desiredPipelineLabels();

  const stdout = await ghRun([
    "label",
    "list",
    "-R",
    cfg.repo,
    "--json",
    "name",
    "-L",
    "500",
  ]);
  const existing = new Set((JSON.parse(stdout) as { name: string }[]).map((l) => l.name));

  for (const label of desired) {
    if (existing.has(label.name)) continue;
    try {
      await ghRun([
        "label",
        "create",
        label.name,
        "--color",
        label.color,
        "--description",
        label.description,
        "-R",
        cfg.repo,
      ]);
      console.log(`[pipeline] created missing label ${label.name} in ${cfg.repo}`);
    } catch (err) {
      const e = err as Error;
      if (!e.message.toLowerCase().includes("already exists")) throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Mutations: labels, comments, transitions
// ---------------------------------------------------------------------------

export async function addLabel(
  cfg: PipelineConfig,
  issueNumber: number,
  label: string,
): Promise<void> {
  await ghRun([
    "issue",
    "edit",
    String(issueNumber),
    "--add-label",
    label,
    "-R",
    cfg.repo,
  ]);
}

export async function addLabelToPr(
  cfg: PipelineConfig,
  prNumber: number,
  label: string,
): Promise<void> {
  await ghRun([
    "pr",
    "edit",
    String(prNumber),
    "--add-label",
    label,
    "-R",
    cfg.repo,
  ]);
}

export async function removeLabel(
  cfg: PipelineConfig,
  issueNumber: number,
  label: string,
): Promise<void> {
  await ghRun([
    "issue",
    "edit",
    String(issueNumber),
    "--remove-label",
    label,
    "-R",
    cfg.repo,
  ]);
}

export async function postComment(
  cfg: PipelineConfig,
  issueNumber: number,
  body: string,
  runOpts: GhRunOptions = {},
): Promise<void> {
  await ghRun(
    ["issue", "comment", String(issueNumber), "--body", body, "-R", cfg.repo],
    { ...runOpts, wrapperName: "postComment" },
  );
}

/**
 * Create a GitHub issue and return its number. Delegates to `ghRun` so it
 * inherits the default 30 s timeout and three-attempt rate-limit retry.
 * On a non-zero exit, `ghRun` throws with the `gh` stderr included.
 *
 * An optional `run` seam is accepted so unit tests can inject a fake without
 * making real network calls (same pattern as `getIssueLabelEvents`).
 */
export async function createIssue(
  cfg: PipelineConfig,
  title: string,
  body: string,
  labels: string[],
  run: GhApiRunner = (args) => ghRun(args, { retries: 1 }),
): Promise<number> {
  const args = ["issue", "create", "--title", title, "--body", body, "-R", cfg.repo];
  for (const label of labels) {
    args.push("--label", label);
  }
  const stdout = await run(args);
  const url = stdout.trim();
  const m = url.match(/\/(\d+)\/?$/);
  if (!m) throw new Error(`createIssue: could not parse issue number from gh output: ${url}`);
  return Number.parseInt(m[1], 10);
}

/**
 * Append a comment to an existing GitHub issue. Delegates to `ghRun` so it
 * inherits the default 30 s timeout and three-attempt rate-limit retry.
 * On a non-zero exit, `ghRun` throws with the `gh` stderr included.
 *
 * An optional `run` seam is accepted so unit tests can inject a fake without
 * making real network calls (same pattern as `getIssueLabelEvents`).
 */
export async function addIssueComment(
  cfg: PipelineConfig,
  issueNumber: number,
  body: string,
  run: GhApiRunner = (args) => ghRun(args, { retries: 1 }),
): Promise<void> {
  const args = ["issue", "comment", String(issueNumber), "--body", body, "-R", cfg.repo];
  await run(args);
}

/**
 * List issue comments with REST numeric ids.
 * `gh issue view --json comments` returns GraphQL node ids (`IC_kw…`), which
 * cannot PATCH `/issues/comments/{id}`. Confirmed on issue #1238: REST `id` is
 * numeric; view JSON `id` is the node id.
 */
export async function listIssueCommentsWithIds(
  cfg: PipelineConfig,
  issueNumber: number,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "listIssueCommentsWithIds" }),
): Promise<{ id: number; body: string; author: string; createdAt: string }[]> {
  const [owner, repo] = cfg.repo.split("/");
  const stdout = await run([
    "api",
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    "--paginate",
    "--slurp",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "[]");
  } catch (err) {
    throw new Error(`listIssueCommentsWithIds: invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`listIssueCommentsWithIds: expected an array, got ${typeof parsed}`);
  }
  // `--paginate --slurp` yields T[][] (array of pages). A single-page fake may
  // still be T[]. `flat()` handles both.
  const raw = (parsed as unknown[]).flat() as Array<{
    id: number;
    body?: string;
    user?: { login?: string };
    created_at?: string;
  }>;
  return raw.map((c) => ({
    id: c.id,
    body: c.body ?? "",
    author: c.user?.login ?? "unknown",
    createdAt: c.created_at ?? "",
  }));
}

/**
 * Update an existing issue comment by REST numeric id.
 * `-f body=` keeps the injectable `GhApiRunner` argv-only (no stdin).
 */
export async function updateIssueComment(
  cfg: PipelineConfig,
  commentId: number,
  body: string,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "updateIssueComment" }),
): Promise<void> {
  const [owner, repo] = cfg.repo.split("/");
  await run([
    "api",
    "--method",
    "PATCH",
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    "-f",
    `body=${body}`,
  ]);
}

/**
 * Delete an existing issue comment by REST numeric id.
 */
export async function deleteIssueComment(
  cfg: PipelineConfig,
  commentId: number,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "deleteIssueComment" }),
): Promise<void> {
  const [owner, repo] = cfg.repo.split("/");
  await run([
    "api",
    "--method",
    "DELETE",
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
  ]);
}

/**
 * Post a comment on the PULL REQUEST (not the linked issue). The pipeline does
 * its review bookkeeping on the issue, but merge authority is separate from the
 * advance path. Findings that advanced as advisory can be missed if they live
 * only on the issue. This surfaces them where the merge decision is made.
 */
export async function postPrComment(
  cfg: PipelineConfig,
  prNumber: number,
  body: string,
  runOpts: GhRunOptions = {},
): Promise<void> {
  await ghRun(
    ["pr", "comment", String(prNumber), "--body", body, "-R", cfg.repo],
    runOpts,
  );
}

/** I/O seam for {@link transition} so unit tests inject fakes — no real network. */
export interface TransitionDeps {
  getIssueDetail?: (cfg: PipelineConfig, n: number) => Promise<{ labels: string[] }>;
  editLabels?: (cfg: PipelineConfig, n: number, from: string, to: string) => Promise<void>;
  postComment?: (cfg: PipelineConfig, n: number, body: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the "## Pipeline: <stage>" transition comment body. Pure + exported so
 * the PIPELINE_COMMENT_KINDS behavioral drift guard exercises the actual
 * renderer instead of a synthetic body (#471 review 1).
 */
export function buildTransitionComment(args: {
  fromStage: Stage;
  toStage: Stage;
  harness: string;
  ts: string;
  summary: string;
  runId: string;
  /** Active config `marker_footer`. Production always passes this. */
  markerFooter?: string | null;
}): string {
  const lines = [
    `## Pipeline: ${args.toStage.replace(/-/g, " ")}`,
    "",
    `**Harness**: ${args.harness}`,
    `**Transition**: \`${args.fromStage}\` → \`${args.toStage}\``,
    `**Timestamp**: ${args.ts}`,
  ];
  if (args.summary) {
    lines.push("", "### Summary", args.summary);
  }
  const rendered =
    lines.join("\n") +
    commentFooterBlock(args.markerFooter) +
    "\n" +
    buildAuditSentinel(args.runId, args.toStage);
  return attestPipelineComment("stage-transition", rendered);
}

export async function transition(
  cfg: PipelineConfig,
  issueNumber: number,
  fromStage: Stage,
  toStage: Stage,
  summary: string,
  deps: TransitionDeps = {},
): Promise<void> {
  const _getIssueDetail = deps.getIssueDetail ?? getIssueDetail;
  const _editLabels = deps.editLabels ?? (async (c, n, from, to) => {
    await ghRun(
      [
        "issue", "edit", String(n),
        "--remove-label", `${LABEL_PREFIX}${from}`,
        "--add-label", `${LABEL_PREFIX}${to}`,
        "-R", c.repo,
      ],
      { wrapperName: "transition" },
    );
  });
  const _postComment = deps.postComment ?? postComment;
  const _sleep = deps.sleep;

  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const harness = getHarnessLabel(
    (await _getIssueDetail(cfg, issueNumber)).labels,
  ) ?? "unassigned";

  const effectiveRunId = _activeRunId ?? "unknown";
  const comment = buildTransitionComment({
    fromStage,
    toStage,
    harness,
    ts,
    summary,
    runId: effectiveRunId,
    markerFooter: cfg.marker_footer,
  });

  await _editLabels(cfg, issueNumber, fromStage, toStage);
  await retryComment(() => _postComment(cfg, issueNumber, comment), 3, _sleep);
}

/** Swap pipeline labels without posting a comment. Used for silent skip paths. */
export async function silentTransition(
  cfg: PipelineConfig,
  issueNumber: number,
  fromStage: Stage,
  toStage: Stage,
): Promise<void> {
  await ghRun([
    "issue",
    "edit",
    String(issueNumber),
    "--remove-label",
    `${LABEL_PREFIX}${fromStage}`,
    "--add-label",
    `${LABEL_PREFIX}${toStage}`,
    "-R",
    cfg.repo,
  ]);
}

/**
 * Render a blocker recipe (`BLOCKER_RECIPES[kind]`) for a concrete issue by
 * substituting the `{{N}}` issue-number placeholder. Pure + exported so the
 * snapshot test pins the rendered text without going through `setBlocked`'s I/O.
 */
export function renderRecipe(kind: BlockerKind, issueNumber: number): string {
  return BLOCKER_RECIPES[kind].replaceAll("{{N}}", String(issueNumber));
}

/**
 * Build the "## Pipeline: Blocked" comment body. Pure + exported for unit tests
 * (`setBlocked` itself does real `gh` I/O). The "### How to unblock" section
 * renders the kind-specific recipe (#134) — the generic `--unblock` hint is the
 * wrong verb for most blocker classes.
 */
export function buildBlockedComment(args: {
  issueNumber: number;
  stageStr: string;
  harness: string;
  ts: string;
  reason: string;
  kind: BlockerKind;
  /** Active config `marker_footer`. Production always passes this. */
  markerFooter?: string | null;
  /** Engine version for attribution stamp (#763). Defaults to unknown. */
  engineVersion?: string | null;
  /** Engine commit SHA for attribution stamp (#763). Defaults to unknown. */
  engineCommitSha?: string | null;
  /** Discovery channel when known (#763). Defaults to live-run for advance parks. */
  discoveryChannel?: import("./engine-attribution.ts").DiscoveryChannel | null;
}): string {
  // Lazy import keeps gh.ts load light for paths that never block; markers are pure.
  // Machine-readable kind marker so capacity admission can re-classify after a
  // failed clearBlocked + re-dispatch without a fresh blocker_set event (#718).
  // Engine + discovery stamps (#763) are additive HTML comments.
  let attribution = "";
  try {
    // Dynamic-style static import at module level would cycle; use require via
    // pre-imported helpers when available. Inline markers match engine-attribution
    // grammar so parsers stay single-sourced in tests.
    const version =
      typeof args.engineVersion === "string" && args.engineVersion.trim()
        ? args.engineVersion.trim()
        : "unknown";
    const sha =
      typeof args.engineCommitSha === "string" && args.engineCommitSha.trim()
        ? args.engineCommitSha.trim()
        : "unknown";
    const channel = args.discoveryChannel ?? "live-run";
    attribution =
      `\n<!-- pipeline:engine version=${version} sha=${sha} -->` +
      `\n<!-- pipeline:discovery-channel ${channel} -->`;
  } catch {
    attribution =
      `\n<!-- pipeline:engine version=unknown sha=unknown -->` +
      `\n<!-- pipeline:discovery-channel live-run -->`;
  }
  return (
    [
      `## Pipeline: Blocked at ${String(args.stageStr).replace(/-/g, " ")}`,
      "",
      `**Harness**: ${args.harness}`,
      `**Blocked since**: ${args.ts}`,
      "",
      "### Why",
      args.reason,
      "",
      "### How to unblock",
      renderRecipe(args.kind, args.issueNumber),
    ].join("\n") +
    commentFooterBlock(args.markerFooter) +
    `\n<!-- pipeline-blocker-kind: ${args.kind} -->` +
    attribution
  );
}

/**
 * Read the latest trusted `<!-- pipeline-blocker-kind: … -->` from issue
 * comments (most recent verified pipeline "## Pipeline: Blocked" body).
 * Pure; used when advance events lack a `blocker_set` (early-blocked
 * re-dispatch after capacity clear failure).
 *
 * Trust model (#718 review b5108544 / 69894186): only a comment that (1) is
 * authored by the pipeline actor (`trustedAuthor`), (2) carries a verified
 * `pipeline-attest` marker with kind `blocked`, and (3) belongs to the
 * **current** `blocked`-label incarnation (`blockedLabeledAt` — the latest
 * application time of the `blocked` label; comment `createdAt` must be at or
 * after that timestamp) may authorize capacity reclassification /
 * `clearBlocked`. An older authentic capacity marker left from a prior hold
 * must not clear a later product/human hold whose blocker comment was lost.
 * Missing `trustedAuthor`, missing `blockedLabeledAt`, or a comment without a
 * usable `createdAt` fails closed (returns null → product needs-human).
 */
export function lastBlockerKindFromComments(
  comments: readonly {
    body: string;
    author?: string | null;
    createdAt?: string | null;
  }[],
  opts?: {
    trustedAuthor?: string | null;
    /** ISO timestamp of the latest `blocked` label application on the issue. */
    blockedLabeledAt?: string | null;
  },
): string | null {
  const trustedAuthor = opts?.trustedAuthor;
  if (trustedAuthor == null || trustedAuthor === "") return null;

  // Bind fallback to the current blocked-label incarnation (#718 69894186).
  // Without this, a stale authentic capacity comment can clear a later hold.
  const blockedLabeledAt = opts?.blockedLabeledAt;
  if (blockedLabeledAt == null || blockedLabeledAt === "") return null;
  const notBeforeMs = Date.parse(blockedLabeledAt);
  if (!Number.isFinite(notBeforeMs)) return null;

  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c) continue;
    if (c.author !== trustedAuthor) continue;
    const createdAt = c.createdAt;
    if (createdAt == null || createdAt === "") continue;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || createdMs < notBeforeMs) continue;
    const body = c.body ?? "";
    if (!body.includes("## Pipeline: Blocked")) continue;
    const attestation = extractPipelineAttestation(body);
    if (attestation === null || attestation.kind !== "blocked") continue;
    if (!isVerifiedPipelineAttestation(body)) continue;
    const m = body.match(/<!--\s*pipeline-blocker-kind:\s*([a-z0-9-]+)\s*-->/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * ISO timestamp of the latest application of the plain `blocked` label
 * (not `pipeline:*`) on the issue, from the newest LABELED_EVENT window.
 * Pure over a pre-fetched event list so unit tests inject events without
 * network. Returns null when no `blocked` labeled event is present.
 */
export function latestBlockedLabeledAtFromEvents(
  events: readonly { label: string; createdAt: string }[],
): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const e of events) {
    if (e.label !== BLOCKED_LABEL) continue;
    const ms = Date.parse(e.createdAt);
    if (!Number.isFinite(ms)) continue;
    if (ms >= latestMs) {
      latestMs = ms;
      latest = e.createdAt;
    }
  }
  return latest;
}

/**
 * Fetch the latest `blocked`-label application timestamp for capacity-comment
 * incarnation binding (#718 69894186). Uses the same GraphQL latest-100
 * LABELED_EVENT window as {@link getIssueLabelEvents}, but selects the plain
 * `blocked` label (which that helper deliberately excludes). Throws on GitHub
 * failure so the caller can fail closed rather than use a stale marker.
 */
export async function getLatestBlockedLabeledAt(
  cfg: PipelineConfig,
  issueNumber: number,
  run: GhApiRunner = (args) => ghRun(args),
): Promise<string | null> {
  const [owner, repo] = cfg.repo.split("/");
  const stdout = await run([
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo)" +
      "{issue(number:$num){timelineItems(last:100,itemTypes:[LABELED_EVENT])" +
      "{nodes{__typename ... on LabeledEvent{createdAt label{name}}}}}}}",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `num=${issueNumber}`,
    "--jq",
    `.data.repository.issue.timelineItems.nodes[] | select(.label.name == "${BLOCKED_LABEL}") | {label: .label.name, createdAt: .createdAt}`,
  ]);
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { label: string; createdAt: string });
  return latestBlockedLabeledAtFromEvents(events);
}

/**
 * Build the full attested "blocked" comment body ({@link buildBlockedComment}
 * plus the audit sentinel and attestation marker). Pure + exported so the
 * PIPELINE_COMMENT_KINDS drift guard exercises the real renderer (#471).
 */
export function buildAttestedBlockedComment(args: {
  issueNumber: number;
  stageStr: string;
  harness: string;
  ts: string;
  reason: string;
  kind: BlockerKind;
  runId: string;
  markerFooter?: string | null;
  engineVersion?: string | null;
  engineCommitSha?: string | null;
  discoveryChannel?: import("./engine-attribution.ts").DiscoveryChannel | null;
}): string {
  const rendered = buildBlockedComment(args) + "\n" + buildAuditSentinel(args.runId, "blocked");
  return attestPipelineComment("blocked", rendered);
}

/** I/O seam for {@link setBlocked} so unit tests inject fakes — no real network. */
export interface SetBlockedDeps {
  getIssueDetail?: (cfg: PipelineConfig, n: number) => Promise<{ labels: string[] }>;
  addBlockedLabel?: (cfg: PipelineConfig, n: number) => Promise<void>;
  postComment?: (cfg: PipelineConfig, n: number, body: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Active-run discovery channel for the blocker stamp (#763). Prefer this over
   * the module-level {@link setGhDiscoveryChannel} value when both are set.
   * Validated against the closed vocabulary; invalid values fall through to the
   * module-level stamp, then live-run only when no more-specific context exists.
   */
  discoveryChannel?: import("./engine-attribution.ts").DiscoveryChannel | null;
}

export async function setBlocked(
  cfg: PipelineConfig,
  issueNumber: number,
  reason: string,
  stage: Stage | null = null,
  kind: BlockerKind = DEFAULT_BLOCKER_KIND,
  deps: SetBlockedDeps = {},
): Promise<void> {
  const _getIssueDetail = deps.getIssueDetail ?? getIssueDetail;
  const _addBlockedLabel = deps.addBlockedLabel ?? (async (c, n) => {
    await ghRun(["issue", "edit", String(n), "--add-label", BLOCKED_LABEL, "-R", c.repo]);
  });
  const _postComment = deps.postComment ?? postComment;
  const _sleep = deps.sleep;

  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const detail = await _getIssueDetail(cfg, issueNumber);
  const stageStr = stage ?? pickStage(detail.labels) ?? "unknown";
  const harness = getHarnessLabel(detail.labels) ?? "unassigned";

  const effectiveRunId = _activeRunId ?? "unknown";
  // Engine + discovery stamps on blocker comments (#763). Best-effort: unresolved
  // identity becomes explicit unknown markers inside buildBlockedComment.
  let engineVersion: string | null = null;
  let engineCommitSha: string | null = null;
  try {
    const { resolvePinnedEngineIdentity } = await import("./engine-identity.ts");
    const id = resolvePinnedEngineIdentity();
    if (id) {
      engineVersion = id.version;
      engineCommitSha = id.commit_sha ?? null;
    }
  } catch {
    // non-fatal — markers still emit unknown
  }
  // Prefer deps > module-level active-run stamp > live-run default. Never stamp
  // live-run when the active run was explicitly review-batch / manual / etc.
  const { isDiscoveryChannel, DEFAULT_LIVE_RUN_CHANNEL } = await import("./engine-attribution.ts");
  const discoveryChannel =
    (deps.discoveryChannel != null && isDiscoveryChannel(deps.discoveryChannel)
      ? deps.discoveryChannel
      : null) ??
    (_activeDiscoveryChannel != null && isDiscoveryChannel(_activeDiscoveryChannel)
      ? _activeDiscoveryChannel
      : null) ??
    DEFAULT_LIVE_RUN_CHANNEL;
  const body = buildAttestedBlockedComment({
    issueNumber,
    stageStr,
    harness,
    ts,
    reason,
    kind,
    runId: effectiveRunId,
    markerFooter: cfg.marker_footer,
    engineVersion,
    engineCommitSha,
    discoveryChannel,
  });

  await _addBlockedLabel(cfg, issueNumber);
  await retryComment(() => _postComment(cfg, issueNumber, body), 3, _sleep);
}

export async function clearBlocked(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<void> {
  await ghRun([
    "issue",
    "edit",
    String(issueNumber),
    "--remove-label",
    BLOCKED_LABEL,
    "-R",
    cfg.repo,
  ]);
}

/**
 * Return the total check-run count for a specific commit SHA.
 * Uses the Checks API rather than `gh pr checks` so it can query any SHA
 * (including the pre-archive commit) independently of a PR's current HEAD.
 */
export async function getHeadCheckRunCount(
  cfg: PipelineConfig,
  sha: string,
): Promise<number> {
  const stdout = await ghRun(
    [
      "api",
      `repos/${cfg.repo}/commits/${sha}/check-runs`,
      "--jq",
      ".total_count",
    ],
    { wrapperName: "getHeadCheckRunCount" },
  );
  const n = parseInt(stdout.trim(), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Return the count of check-runs with conclusion=success for a specific commit SHA.
 * Used by the no-run recovery path to verify the pre-archive SHA was actually green
 * (not just that any check-run exists — failed or pending runs must not qualify).
 */
export async function getSuccessfulCheckRunCount(
  cfg: PipelineConfig,
  sha: string,
): Promise<number> {
  const stdout = await ghRun(
    [
      "api",
      `repos/${cfg.repo}/commits/${sha}/check-runs`,
      "--jq",
      "[.check_runs[] | select(.conclusion == \"success\")] | length",
    ],
    { wrapperName: "getSuccessfulCheckRunCount" },
  );
  const n = parseInt(stdout.trim(), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Return the number of unresolved review-comment threads on a pull request.
 * Uses the GraphQL `reviewThreads` API (the REST API has no equivalent).
 * Returns 0 on query failure — callers that need a hard-deny on failure should
 * wrap this in their own error boundary.
 */
export async function getUnresolvedReviewThreadCount(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<number> {
  const [owner, repo] = cfg.repo.split("/");
  const stdout = await ghRun([
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved}}}}}",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `num=${prNumber}`,
    "--jq",
    "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length",
  ]);
  const n = parseInt(stdout.trim(), 10);
  return isNaN(n) ? 0 : n;
}

export async function closePr(
  cfg: PipelineConfig,
  prNumber: number,
  comment?: string,
): Promise<void> {
  const args = ["pr", "close", String(prNumber), "-R", cfg.repo];
  if (comment !== undefined && comment !== "") {
    args.push("--comment", comment);
  }
  await ghRun(args);
}

/**
 * Close a GitHub issue, optionally leaving a closing comment (`gh issue close --comment`).
 * Does not merge PRs; issue-only disposition.
 */
export async function closeIssue(
  cfg: PipelineConfig,
  issueNumber: number,
  comment?: string,
): Promise<void> {
  const args = ["issue", "close", String(issueNumber), "-R", cfg.repo];
  if (comment !== undefined && comment !== "") {
    args.push("--comment", comment);
  }
  await ghRun(args);
}

export async function reopenPr(cfg: PipelineConfig, prNumber: number): Promise<void> {
  await ghRun(["pr", "reopen", String(prNumber), "-R", cfg.repo]);
}

// ---------------------------------------------------------------------------
// Pre-merge CI recovery helpers (#679)
// ---------------------------------------------------------------------------

/**
 * Extract a GitHub Actions workflow run id from a check `link` URL.
 * Accepts forms like:
 *   https://github.com/o/r/actions/runs/123456789
 *   https://github.com/o/r/actions/runs/123456789/job/987
 * Returns null when the link is missing or not an actions run URL.
 */
export function extractWorkflowRunId(link: string | undefined | null): string | null {
  if (!link) return null;
  const m = link.match(/\/actions\/runs\/(\d+)/);
  return m?.[1] ?? null;
}

export interface RerunFailedWorkflowsResult {
  /** True when at least one re-run was successfully requested. */
  attempted: boolean;
  /** Run ids we attempted to re-run. */
  runIds: string[];
  /** Human-readable note when no re-run could be requested. */
  reason?: string;
}

/**
 * Re-run failed jobs for the workflow run(s) associated with definitive failed
 * checks (`gh run rerun <id> --failed`). Dedupes by run id. Returns
 * `{ attempted: false }` when no run id can be resolved or every re-run call fails —
 * callers must treat that as "re-run unavailable" and continue the recovery ladder
 * without spinning.
 */
export async function rerunFailedWorkflows(
  cfg: PipelineConfig,
  failedChecks: CheckRun[],
): Promise<RerunFailedWorkflowsResult> {
  const runIds = new Set<string>();
  for (const c of failedChecks) {
    const id = extractWorkflowRunId(c.link);
    if (id) runIds.add(id);
  }
  if (runIds.size === 0) {
    return { attempted: false, runIds: [], reason: "no workflow run id in check links" };
  }
  const attemptedIds: string[] = [];
  const errors: string[] = [];
  for (const id of runIds) {
    try {
      await ghRun(["run", "rerun", id, "--failed", "-R", cfg.repo], { retries: 1 });
      attemptedIds.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${id}: ${msg}`);
    }
  }
  if (attemptedIds.length === 0) {
    return {
      attempted: false,
      runIds: [...runIds],
      reason: `re-run failed: ${errors.join("; ")}`,
    };
  }
  return { attempted: true, runIds: attemptedIds };
}

const LOG_EXCERPT_MAX_CHARS = 2500;
const LOG_EXCERPT_MAX_LINES = 40;

/**
 * Fetch a bounded log excerpt for a failed check via `gh run view --log-failed`.
 * Returns null on any failure (best-effort; never invents content).
 */
export async function fetchCheckLogExcerpt(
  cfg: PipelineConfig,
  check: CheckRun,
): Promise<string | null> {
  const runId = extractWorkflowRunId(check.link);
  if (!runId) return null;
  try {
    const stdout = await ghRun(
      ["run", "view", runId, "--log-failed", "-R", cfg.repo],
      { retries: 1, timeoutMs: 60_000 },
    );
    return trimLogExcerpt(stdout);
  } catch {
    return null;
  }
}

/** Keep the last meaningful lines of a CI log, hard-capped by lines and chars. */
export function trimLogExcerpt(raw: string, maxLines = LOG_EXCERPT_MAX_LINES, maxChars = LOG_EXCERPT_MAX_CHARS): string | null {
  if (!raw || !raw.trim()) return null;
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const tail = lines.slice(-maxLines);
  let text = tail.join("\n");
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    // Drop a partial first line after char truncation.
    const nl = text.indexOf("\n");
    if (nl > 0 && nl < 200) text = text.slice(nl + 1);
  }
  return text.trim() || null;
}

// ---------------------------------------------------------------------------
// Worktree cleanup: merged-PR detection
// ---------------------------------------------------------------------------

/** Pure parser — exposed for unit tests. */
export function parsePrMergeState(
  stdout: string,
): { merged: true; prNumber: number; headSha: string } | { merged: false } {
  const prs = JSON.parse(stdout) as { number: number; headRefOid: string }[];
  if (prs.length === 0) return { merged: false };
  return { merged: true, prNumber: prs[0].number, headSha: prs[0].headRefOid };
}

/** Returns the merge state for a specific branch by exact `--head` match.
 *  On gh/auth/API failure returns `{ merged: false, error }` so callers can
 *  distinguish "unmerged PR" from "lookup failed". */
export async function getPrMergeState(
  cfg: PipelineConfig,
  branch: string,
): Promise<{ merged: true; prNumber: number; headSha: string } | { merged: false; error?: string }> {
  try {
    const stdout = await ghRun([
      "pr", "list",
      "--state", "merged",
      "--head", branch,
      "--json", "number,headRefOid",
      "-L", "10",
      "-R", cfg.repo,
    ]);
    return parsePrMergeState(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { merged: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// PR creation + lookup
// ---------------------------------------------------------------------------

export interface CreatePrOptions {
  branch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export async function createPr(
  cfg: PipelineConfig,
  opts: CreatePrOptions,
): Promise<number> {
  const args = [
    "pr",
    "create",
    "--head",
    opts.branch,
    "--base",
    cfg.base_branch,
    "--title",
    opts.title,
    "--body",
    opts.body,
    "-R",
    cfg.repo,
  ];
  if (opts.draft) args.push("--draft");
  const stdout = await ghRun(args, { timeoutMs: 60_000, retries: 1 });
  const url = stdout.trim();
  const match = url.match(/\/pull\/(\d+)\/?$/);
  if (!match) throw new Error(`Could not parse PR number from gh output: ${url}`);
  return Number.parseInt(match[1], 10);
}

/** Structured closing-issue reference returned by the GH API (includes repo). */
export interface ClosingIssueRef {
  number: number;
  nameWithOwner: string;
}

/** Minimal open-PR shape needed by resolvePrForIssue. Carries the PR's own
 *  closing-issue references so resolution needs a single `gh pr list` call —
 *  no per-PR `gh pr view` fan-out (#76/#97). */
export interface PrCandidate {
  number: number;
  headRefName: string;
  /** True when the head branch lives in a fork, not cfg.repo. A fork PR's
   *  headRefName is only the branch name and can spoof `pipeline/<N>-`, so the
   *  branch fast path must not trust it (#76). */
  isCrossRepository: boolean;
  /** The issues this PR closes, repo-qualified (from the same list query). */
  closingIssues: ClosingIssueRef[];
  /**
   * Base branch name (e.g. `main`). Present on GraphQL open-list nodes
   * (`baseRefName`, verified live). Used by supersede selection (#729) to
   * skip intentional different-base PRs. Optional so legacy fixtures / list
   * paths without base still resolve association; missing base never matches
   * the same-base supersede filter.
   */
  baseRefName?: string;
}

/** Normalize a gh `closingIssuesReferences` array into ClosingIssueRef[]. gh
 *  emits `repository { id, name, owner { id, login } }` (NOT a `nameWithOwner`
 *  field), so the repo-qualified name is reconstructed as `owner.login/name`.
 *  Refs without a repository are dropped. Exported for tests. */
export function normalizeClosingRefs(
  raw:
    | { number: number; repository?: { name: string; owner: { login: string } } }[]
    | undefined,
): ClosingIssueRef[] {
  return (raw ?? [])
    .filter((r) => r.repository)
    .map((r) => ({
      number: r.number,
      nameWithOwner: `${r.repository!.owner.login}/${r.repository!.name}`,
    }));
}

/** Parse `gh pr list --json number,headRefName,isCrossRepository,closingIssuesReferences[,baseRefName]`
 *  into PrCandidate[]. One query carries everything resolvePrForIssue needs.
 *  Exported for tests. */
export function parsePrList(stdout: string): PrCandidate[] {
  const data = JSON.parse(stdout) as {
    number: number;
    headRefName: string;
    isCrossRepository?: boolean;
    baseRefName?: string;
    closingIssuesReferences?: {
      number: number;
      repository?: { name: string; owner: { login: string } };
    }[];
  }[];
  return data.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName,
    isCrossRepository: pr.isCrossRepository ?? false,
    closingIssues: normalizeClosingRefs(pr.closingIssuesReferences),
    ...(typeof pr.baseRefName === "string" && pr.baseRefName
      ? { baseRefName: pr.baseRefName }
      : {}),
  }));
}

/** Resolve the PR for an issue from a single PR-list fetch, in two strategies:
 *    1. Head branch starts with `pipeline/<N>-` AND the PR is not from a fork
 *       (a fork PR can spoof the branch name).
 *    2. The PR's closingIssuesReferences contains the issue in targetRepo
 *       (authoritative link).
 *  Returns null when neither matches. Deliberately NO body/title text search —
 *  a PR that merely mentions `#N` must not resolve as issue N's PR (#76).
 *  Cross-repo closing refs (OWNER/REPO#N targeting a different repo) are ignored.
 *  Pure and synchronous: resolution does no per-PR API calls (#97).
 *  When multiple open PRs match (replacement + abandoned draft), returns the
 *  first under the branch-then-closing-ref order; callers that must dispose
 *  every match should use {@link resolveOpenPrsForIssue}. */
export function resolvePrForIssue(
  prs: PrCandidate[],
  issueNumber: number,
  targetRepo: string,
): number | null {
  const all = resolveOpenPrsForIssue(prs, issueNumber, targetRepo);
  return all.length === 0 ? null : all[0]!;
}

/**
 * All open PRs associated with an issue under the same dual strategies as
 * {@link resolvePrForIssue} (pipeline branch prefix, then same-repo closing
 * refs). Order: list order, branch matches first (same preference as the
 * singleton resolver), then closing-ref-only matches; each PR number once.
 * Pure / synchronous (#97). Used by FRG pack auto-close (#754) so multiple
 * open associated PRs are not silently left open.
 */
export function resolveOpenPrsForIssue(
  prs: PrCandidate[],
  issueNumber: number,
  targetRepo: string,
): number[] {
  const branchPrefix = `pipeline/${issueNumber}-`;
  const target = targetRepo.toLowerCase();
  const seen = new Set<number>();
  const out: number[] = [];

  for (const pr of prs) {
    // A fork PR's headRefName is only the branch name and can spoof the prefix,
    // so the fast path trusts it only for same-repo (non-fork) PRs (#76).
    if (!pr.isCrossRepository && pr.headRefName.startsWith(branchPrefix)) {
      if (!seen.has(pr.number)) {
        seen.add(pr.number);
        out.push(pr.number);
      }
    }
  }

  for (const pr of prs) {
    if (seen.has(pr.number)) continue;
    if (
      pr.closingIssues.some(
        (r) => r.nameWithOwner.toLowerCase() === target && r.number === issueNumber,
      )
    ) {
      seen.add(pr.number);
      out.push(pr.number);
    }
  }
  return out;
}

/** One page of open repository PRs from the GraphQL query in
 *  {@link getPrForIssue}. Field shape verified against live `gh api graphql`
 *  (number, headRefName, baseRefName, isCrossRepository, closingIssuesReferences.nodes
 *  with repository.name + owner.login — same nested repo shape as
 *  `gh pr list --json`). baseRefName verified 2026-08-01 on live open PRs. */
interface OpenPrsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    number: number;
    headRefName: string;
    baseRefName?: string;
    isCrossRepository?: boolean;
    closingIssuesReferences?: {
      nodes: {
        number: number;
        repository?: { name: string; owner: { login: string } };
      }[];
    };
  }[];
}

const OPEN_PRS_PAGE_SIZE = 100;
/** Safety bound only — 50 pages × 100 = 5000 open PRs, far above realistic
 *  open-PR volume. Hitting the bound without exhausting pages fails visibly
 *  (never silent `null` after mid-list truncation) — #623 / design Decision 3. */
const OPEN_PRS_MAX_PAGES = 50;

const OPEN_PRS_QUERY =
  "query($owner:String!,$repo:String!,$after:String){repository(owner:$owner,name:$repo)" +
  `{pullRequests(first:${OPEN_PRS_PAGE_SIZE},states:OPEN,after:$after)` +
  "{pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName isCrossRepository " +
  "closingIssuesReferences(first:50){nodes{number repository{name owner{login}}}}}}}}";

/** Map GraphQL open-PR nodes into {@link PrCandidate}[]. Exported for tests. */
export function mapOpenPrGraphQlNodes(nodes: OpenPrsPage["nodes"]): PrCandidate[] {
  return nodes.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName,
    isCrossRepository: pr.isCrossRepository ?? false,
    closingIssues: normalizeClosingRefs(pr.closingIssuesReferences?.nodes),
    ...(typeof pr.baseRefName === "string" && pr.baseRefName
      ? { baseRefName: pr.baseRefName }
      : {}),
  }));
}

/**
 * Enumerate all open PR candidates via paginated GraphQL (shared by
 * {@link getPrForIssue} and {@link listOpenPrsForIssue}). Fail-closed on
 * GraphQL errors / missing connection / page safety bound (#623).
 */
async function fetchOpenPrCandidates(
  cfg: PipelineConfig,
  run: GhApiRunner,
  caller: string,
): Promise<PrCandidate[]> {
  const [owner, repo] = cfg.repo.split("/");
  const candidates: PrCandidate[] = [];
  let after: string | null = null;

  for (let page = 0; page < OPEN_PRS_MAX_PAGES; page++) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${OPEN_PRS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const stdout = await run(args);
    // Fail closed on GraphQL errors / missing connection: callers treat null as
    // "no open PR" and may create a duplicate or hand off incorrectly (#623
    // review-2). Partial envelopes with `errors` must not look like an
    // exhausted open-PR set.
    const envelope = JSON.parse(stdout) as {
      data?: { repository?: { pullRequests?: OpenPrsPage } | null } | null;
      errors?: Array<{ message?: string }>;
    };
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      const messages = envelope.errors
        .map((e) => (typeof e.message === "string" && e.message ? e.message : "unknown"))
        .join("; ");
      throw new Error(`${caller}: GraphQL errors for ${cfg.repo}: ${messages}`);
    }
    const pullRequests = envelope.data?.repository?.pullRequests;
    if (!pullRequests) {
      throw new Error(
        `${caller}: GraphQL response for ${cfg.repo} missing repository.pullRequests ` +
          `(null repository or connection — not an authoritative empty open-PR set)`,
      );
    }
    candidates.push(...mapOpenPrGraphQlNodes(pullRequests.nodes));
    if (!pullRequests.pageInfo.hasNextPage) {
      return candidates;
    }
    after = pullRequests.pageInfo.endCursor;
  }

  // Safety bound hit with more open PRs remaining — fail visibly rather than
  // return null as if the issue had no open PR (#623).
  throw new Error(
    `${caller}: open PR list for ${cfg.repo} exceeded safety bound ` +
      `(${OPEN_PRS_MAX_PAGES} pages × ${OPEN_PRS_PAGE_SIZE}); refusing to resolve after truncation`,
  );
}

/** Resolve the open PR for an issue via dual strategy ({@link resolvePrForIssue}).
 *
 *  Enumerates **all** open PR candidates via paginated GraphQL (number + branch
 *  + fork flag + closing refs per node) so resolution never fans out to one
 *  `gh pr view` per open PR (#97) and never silently drops a match past a
 *  fixed first-page / `-L 100` window (#623 — same truncation class as #511's
 *  historical path). Optional {@link GhApiRunner} injects fakes for unit tests. */
export async function getPrForIssue(
  cfg: PipelineConfig,
  issueNumber: number,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "getPrForIssue" }),
): Promise<number | null> {
  const candidates = await fetchOpenPrCandidates(cfg, run, "getPrForIssue");
  return resolvePrForIssue(candidates, issueNumber, cfg.repo);
}

/**
 * All open PRs associated with an issue (same dual strategies and open-list
 * completeness as {@link getPrForIssue}). Used by FRG post-pass pack close so
 * every open associated PR is disposed, not only the singleton match (#754).
 */
export async function listOpenPrsForIssue(
  cfg: PipelineConfig,
  issueNumber: number,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "listOpenPrsForIssue" }),
): Promise<number[]> {
  const candidates = await fetchOpenPrCandidates(cfg, run, "listOpenPrsForIssue");
  return resolveOpenPrsForIssue(candidates, issueNumber, cfg.repo);
}

/**
 * Full open-PR candidate set (paginated GraphQL), including `baseRefName` when
 * present. Used by supersede disposal (#729) so selection can apply dual-strategy
 * association and the same-base filter without a second fan-out.
 */
export async function listOpenPrCandidates(
  cfg: PipelineConfig,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "listOpenPrCandidates" }),
): Promise<PrCandidate[]> {
  return fetchOpenPrCandidates(cfg, run, "listOpenPrCandidates");
}

// ---------------------------------------------------------------------------
// Supersede open associated PRs after managed PR ensure (#729)
// ---------------------------------------------------------------------------

/** Configured disposition for non-managed open associated PRs (#729). */
export type SupersedeMode = "close" | "comment-only";

export interface SelectSupersededOpenPrsArgs {
  issueNumber: number;
  managedBranch: string;
  managedPrNumber: number;
  baseBranch: string;
  targetRepo: string;
}

/**
 * Pure selection of open PR numbers to supersede after managed PR ensure (#729).
 *
 * Candidates must already be open. Association uses the same dual strategies as
 * {@link resolveOpenPrsForIssue} (no title/body search). Excludes: the managed
 * PR M, any PR whose head is the managed branch H, dual-strategy non-matches,
 * and PRs whose base is not `baseBranch` (missing base never matches).
 *
 * Callers that perform destructive close MUST first confirm the caller's managed
 * PR is the GitHub-elected canonical via {@link electCanonicalManagedIssuePr};
 * this pure selector does not itself gate on election.
 */
export function selectSupersededOpenPrs(
  candidates: PrCandidate[],
  args: SelectSupersededOpenPrsArgs,
): number[] {
  const associated = resolveOpenPrsForIssue(
    candidates,
    args.issueNumber,
    args.targetRepo,
  );
  const byNumber = new Map(candidates.map((c) => [c.number, c]));
  const out: number[] = [];
  for (const n of associated) {
    if (n === args.managedPrNumber) continue;
    const pr = byNumber.get(n);
    if (!pr) continue;
    if (pr.headRefName === args.managedBranch) continue;
    if (pr.baseRefName !== args.baseBranch) continue;
    out.push(n);
  }
  return out;
}

export interface ElectCanonicalManagedIssuePrArgs {
  issueNumber: number;
  /** Caller's ensured managed PR number (used when {@link seedCallerIfAbsent}). */
  managedPrNumber: number;
  baseBranch: string;
  targetRepo: string;
  /**
   * When true, seed `managedPrNumber` even if absent from `candidates`.
   * **Partial-list sources only** (list lag). The production
   * {@link listOpenPrCandidates} path is authoritative (complete open set or
   * throw) and MUST leave this false — seeding a closed PR would elect it and
   * can dispose live sibling PRs (#729 review).
   */
  seedCallerIfAbsent?: boolean;
}

/**
 * GitHub-authoritative election of the single canonical open managed pipeline PR
 * for issue N (#729 concurrency).
 *
 * Contenders are same-repo open PRs whose head starts with `pipeline/<N>-` and
 * whose base is `baseBranch`. Optionally (partial lists only), the caller's
 * `managedPrNumber` may be seeded via {@link ElectCanonicalManagedIssuePrArgs.seedCallerIfAbsent}.
 * The winner is the **highest PR number** (newest GitHub object wins), so two
 * hosts reconciling independently converge on the same survivor without a
 * host-local lock. Non-pipeline associated heads (closing-ref only) are never
 * contenders — they are dispose targets for the winner only.
 *
 * Returns `null` when there are no contenders (empty open managed set and no
 * seed). Pure / synchronous; unit-testable without network.
 */
export function electCanonicalManagedIssuePr(
  candidates: PrCandidate[],
  args: ElectCanonicalManagedIssuePrArgs,
): number | null {
  const branchPrefix = `pipeline/${args.issueNumber}-`;
  const contenders = new Set<number>();
  if (args.seedCallerIfAbsent) {
    contenders.add(args.managedPrNumber);
  }
  for (const c of candidates) {
    if (c.isCrossRepository) continue;
    if (c.baseRefName !== args.baseBranch) continue;
    if (!c.headRefName.startsWith(branchPrefix)) continue;
    contenders.add(c.number);
  }
  if (contenders.size === 0) return null;
  let winner = -1;
  for (const n of contenders) {
    if (n > winner) winner = n;
  }
  return winner;
}

/**
 * True when the caller's managed PR is present in an authoritative open-PR
 * snapshot with the expected same-repo head and base (eligible to be elected
 * or to dispose). Closed or head-mismatched PRs are not open contenders.
 */
export function isManagedPrOpenOnHead(
  candidates: PrCandidate[],
  args: {
    managedPrNumber: number;
    managedBranch: string;
    baseBranch: string;
  },
): boolean {
  for (const c of candidates) {
    if (c.number !== args.managedPrNumber) continue;
    if (c.isCrossRepository) continue;
    if (c.headRefName !== args.managedBranch) continue;
    if (c.baseRefName !== args.baseBranch) continue;
    return true;
  }
  return false;
}

/** Stable marker in supersession comments (auditable / greppable). */
export const PIPELINE_SUPERSEDED_MARKER = "pipeline-superseded";

/**
 * Structured supersession comment body. Always includes
 * {@link PIPELINE_SUPERSEDED_MARKER} and names the superseding PR.
 */
export function formatSupersededPrComment(opts: {
  managedPrNumber: number;
  issueNumber: number;
  managedBranch: string;
  mode: SupersedeMode;
}): string {
  const action =
    opts.mode === "comment-only"
      ? "Leaving this PR open (supersede_mode: comment-only); prefer the managed head."
      : "Closing this PR as abandoned relative to the current pipeline head.";
  return [
    `${PIPELINE_SUPERSEDED_MARKER}: superseded by PR #${opts.managedPrNumber} for issue #${opts.issueNumber}`,
    `(managed head: ${opts.managedBranch}). ${action}`,
  ].join(" ");
}

/** Injectable GitHub seams for supersede disposal (no merge / force-push / delete). */
export interface DisposeSupersededIssuePrsDeps {
  listOpenPrCandidates?: (
    cfg: PipelineConfig,
  ) => Promise<PrCandidate[]>;
  closePr?: (
    cfg: PipelineConfig,
    prNumber: number,
    comment?: string,
  ) => Promise<void>;
  postPrComment?: (
    cfg: PipelineConfig,
    prNumber: number,
    body: string,
  ) => Promise<void>;
  log?: (msg: string) => void;
}

export interface DisposeSupersededIssuePrsResult {
  /** PR numbers closed under `close` mode. */
  closed: number[];
  /** PR numbers that received a supersede comment (both modes). */
  commented: number[];
  /** Non-fatal diagnostics (list failure or per-PR close/comment failure). */
  errors: string[];
  /**
   * Whether this run's managed PR is the GitHub-elected canonical open managed
   * pipeline PR for the issue. `true` when list fails (fail-soft: do not strand
   * advance on list outage). `false` when another concurrent managed head wins
   * the election — caller must not transition as if this PR is the live head.
   */
  isCanonical: boolean;
  /** Elected canonical PR number when known (omitted on list failure). */
  canonicalPrNumber?: number;
}

/**
 * After managed PR create/reuse for issue N on head H, dispose other open
 * associated same-base PRs under the active supersede mode (#729).
 *
 * Cross-host safety: uses the authoritative open-PR list
 * ({@link listOpenPrCandidates} — complete set or throw). Requires the caller's
 * managed PR number **and** managed head to still be present and open before any
 * elect/dispose. Elects a single canonical open managed pipeline PR via
 * {@link electCanonicalManagedIssuePr} (highest PR number among same-base
 * `pipeline/<N>-*` heads; **no** caller seed on this path), re-lists and
 * re-elects immediately before any close/comment, and only the winner disposes.
 * A non-canonical run (lost election **or** managed PR absent/closed) closes
 * nothing (including not closing the winner or live siblings) and returns
 * `isCanonical: false` so the resume path can stop without advancing on a closed PR.
 *
 * Fail-soft: list failure or per-PR close/comment failure is logged and does
 * not throw. Never merges, force-pushes, or deletes branches.
 */
export async function disposeSupersededIssuePrs(
  cfg: PipelineConfig,
  opts: {
    issueNumber: number;
    managedBranch: string;
    managedPrNumber: number;
    /** Defaults to `cfg.supersede_mode` then `close`. */
    mode?: SupersedeMode;
  },
  deps: DisposeSupersededIssuePrsDeps = {},
): Promise<DisposeSupersededIssuePrsResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const mode: SupersedeMode = opts.mode ?? cfg.supersede_mode ?? "close";
  const list =
    deps.listOpenPrCandidates ??
    ((c: PipelineConfig) => listOpenPrCandidates(c));
  const closeFn = deps.closePr ?? closePr;
  const commentFn = deps.postPrComment ?? postPrComment;

  const result: DisposeSupersededIssuePrsResult = {
    closed: [],
    commented: [],
    errors: [],
    // List outage: fail-soft and allow advance (no election evidence to deny it).
    isCanonical: true,
  };

  // Authoritative production list: never seed a missing managed PR (closed PR
  // must not win election and dispose live siblings).
  const electArgs: ElectCanonicalManagedIssuePrArgs = {
    issueNumber: opts.issueNumber,
    managedPrNumber: opts.managedPrNumber,
    baseBranch: cfg.base_branch,
    targetRepo: cfg.repo,
    seedCallerIfAbsent: false,
  };
  const presenceArgs = {
    managedPrNumber: opts.managedPrNumber,
    managedBranch: opts.managedBranch,
    baseBranch: cfg.base_branch,
  };

  /** Apply election after confirming managed PR is still open on head H. */
  const electIfManagedOpen = (
    candidates: PrCandidate[],
    phase: "initial" | "revalidation",
  ): { ok: true; canonical: number } | { ok: false } => {
    if (!isManagedPrOpenOnHead(candidates, presenceArgs)) {
      result.isCanonical = false;
      const elected = electCanonicalManagedIssuePr(candidates, electArgs);
      if (elected !== null) result.canonicalPrNumber = elected;
      log(
        `[pipeline] #${opts.issueNumber}: managed PR #${opts.managedPrNumber} ` +
          `on head ${opts.managedBranch} is not present in the authoritative open-PR list` +
          (phase === "revalidation" ? " (revalidation)" : "") +
          `; treating as non-canonical and skipping supersede dispose` +
          (elected !== null ? ` (open canonical contender PR #${elected})` : ""),
      );
      return { ok: false };
    }
    const canonical = electCanonicalManagedIssuePr(candidates, electArgs);
    if (canonical === null || canonical !== opts.managedPrNumber) {
      result.isCanonical = false;
      if (canonical !== null) result.canonicalPrNumber = canonical;
      const phaseNote =
        phase === "revalidation"
          ? "lost canonical election on revalidation"
          : "non-canonical managed PR";
      log(
        `[pipeline] #${opts.issueNumber}: ${phaseNote} #${opts.managedPrNumber}` +
          (canonical !== null
            ? ` (GitHub-elected canonical is PR #${canonical})`
            : " (no open managed contenders)") +
          `; skipping supersede dispose`,
      );
      return { ok: false };
    }
    result.canonicalPrNumber = canonical;
    return { ok: true, canonical };
  };

  let candidates: PrCandidate[];
  try {
    candidates = await list(cfg);
  } catch (err) {
    const msg =
      `supersede open-PR list failed for issue #${opts.issueNumber}: ` +
      `${(err as Error).message}`;
    result.errors.push(msg);
    log(`[pipeline] #${opts.issueNumber}: ${msg}`);
    return result;
  }

  // First election against the open snapshot (requires managed PR still open).
  const first = electIfManagedOpen(candidates, "initial");
  if (!first.ok) return result;
  let canonical = first.canonical;

  // Re-list + re-elect immediately before destructive dispose (TOCTOU / cross-host).
  try {
    candidates = await list(cfg);
  } catch (err) {
    const msg =
      `supersede revalidation list failed for issue #${opts.issueNumber}: ` +
      `${(err as Error).message}`;
    result.errors.push(msg);
    log(`[pipeline] #${opts.issueNumber}: ${msg}`);
    // Fail-soft: first election said we won; list flap must not block advance.
    return result;
  }
  const second = electIfManagedOpen(candidates, "revalidation");
  if (!second.ok) return result;
  canonical = second.canonical;

  const targets = selectSupersededOpenPrs(candidates, {
    issueNumber: opts.issueNumber,
    managedBranch: opts.managedBranch,
    managedPrNumber: opts.managedPrNumber,
    baseBranch: cfg.base_branch,
    targetRepo: cfg.repo,
  });

  if (targets.length === 0) {
    return result;
  }

  for (const prNumber of targets) {
    // Never dispose the elected canonical (defensive — selection already excludes M).
    if (prNumber === canonical) continue;
    const body = formatSupersededPrComment({
      managedPrNumber: opts.managedPrNumber,
      issueNumber: opts.issueNumber,
      managedBranch: opts.managedBranch,
      mode,
    });
    try {
      if (mode === "comment-only") {
        await commentFn(cfg, prNumber, body);
        result.commented.push(prNumber);
        log(
          `[pipeline] #${opts.issueNumber}: supersede comment on PR #${prNumber} ` +
            `(comment-only; superseding PR #${opts.managedPrNumber})`,
        );
      } else {
        await closeFn(cfg, prNumber, body);
        result.closed.push(prNumber);
        result.commented.push(prNumber);
        log(
          `[pipeline] #${opts.issueNumber}: closed superseded PR #${prNumber} ` +
            `(superseding PR #${opts.managedPrNumber})`,
        );
      }
    } catch (err) {
      const msg =
        `supersede dispose failed for PR #${prNumber} (issue #${opts.issueNumber}): ` +
        `${(err as Error).message}`;
      result.errors.push(msg);
      log(`[pipeline] #${opts.issueNumber}: ${msg}`);
    }
  }

  return result;
}

/** One page of an issue's `CONNECTED_EVENT`/`CROSS_REFERENCED_EVENT` timeline,
 *  as returned by the GraphQL query in {@link getPrForIssueAnyState}. */
interface IssueTimelinePage {
  hasPreviousPage: boolean;
  startCursor: string | null;
  nodes: {
    __typename: string;
    willCloseTarget?: boolean;
    subject?: { __typename?: string; number?: number; headRefName?: string; isCrossRepository?: boolean } | null;
    source?: { __typename?: string; number?: number; headRefName?: string; isCrossRepository?: boolean } | null;
  }[];
}

/** Picks the most recent same-repo PR linked to the issue from one timeline
 *  page: a `ConnectedEvent` (manual link) always counts; a
 *  `CrossReferencedEvent` counts only when `willCloseTarget` is true (mirrors
 *  `closingIssuesReferences` semantics — a PR that merely mentions the issue
 *  does not match). Fork PRs (`isCrossRepository`) are excluded, same as
 *  {@link resolvePrForIssue}. Scans newest-first within the page. Exported for
 *  tests. */
export function pickPrFromTimelinePage(nodes: IssueTimelinePage["nodes"]): number | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const pr =
      node.__typename === "ConnectedEvent"
        ? node.subject
        : node.__typename === "CrossReferencedEvent" && node.willCloseTarget
          ? node.source
          : null;
    if (pr && pr.__typename === "PullRequest" && pr.number !== undefined && !pr.isCrossRepository) {
      return pr.number;
    }
  }
  return null;
}

const ISSUE_TIMELINE_QUERY =
  "query($owner:String!,$repo:String!,$num:Int!,$before:String){repository(owner:$owner,name:$repo)" +
  "{issue(number:$num){timelineItems(last:50,before:$before,itemTypes:[CONNECTED_EVENT,CROSS_REFERENCED_EVENT])" +
  "{pageInfo{hasPreviousPage startCursor}nodes{__typename " +
  "... on ConnectedEvent{subject{__typename ... on PullRequest{number headRefName isCrossRepository}}} " +
  "... on CrossReferencedEvent{willCloseTarget source{__typename ... on PullRequest{number headRefName isCrossRepository}}}}}}}}";

/** Same resolution as {@link getPrForIssue} but across every PR state (open,
 *  closed, merged) — used by reconciliation (#511), which must still find a
 *  since-merged PR to observe `pr_state: "merged"` (an open-only lookup would
 *  never see it, defeating forward drift detection).
 *
 *  Resolves via the issue's own `CONNECTED_EVENT`/`CROSS_REFERENCED_EVENT`
 *  timeline (paginated backward through history) rather than a repository-wide
 *  `gh pr list` scan: the timeline is scoped to this one issue, so it cannot
 *  lose a historical merged PR to an unrelated bounded-size repo-wide list
 *  (#511 review-2 finding — a fixed `-L 100` repo-wide scan silently drops
 *  older PRs once a repo has passed 100 total PRs). */
export async function getPrForIssueAnyState(
  cfg: PipelineConfig,
  issueNumber: number,
  run: GhApiRunner = (args) => ghRun(args, { wrapperName: "getPrForIssueAnyState" }),
): Promise<number | null> {
  const [owner, repo] = cfg.repo.split("/");
  let before: string | null = null;
  // Safety bound only — 40 pages * 50 events = 2000 timeline events for a
  // single issue, far beyond any real issue's link history.
  for (let page = 0; page < 40; page++) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${ISSUE_TIMELINE_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `num=${issueNumber}`,
    ];
    if (before) args.push("-F", `before=${before}`);
    const stdout = await run(args);
    const data = JSON.parse(stdout) as {
      data: { repository: { issue: { timelineItems: IssueTimelinePage } | null } };
    };
    const timelineItems = data.data.repository.issue?.timelineItems;
    if (!timelineItems) return null;
    const found = pickPrFromTimelinePage(timelineItems.nodes);
    if (found !== null) return found;
    if (!timelineItems.pageInfo.hasPreviousPage) return null;
    before = timelineItems.pageInfo.startCursor;
  }
  return null;
}

/** Select the first same-repo PR whose headRefName exactly equals {@link branch}.
 *  Fork PRs (isCrossRepository === true) are excluded — they can share branch names
 *  with pipeline branches and must not be reused as the pipeline's own PR. */
export function selectPrForBranch(
  data: { number: number; headRefName: string; isCrossRepository: boolean }[],
  branch: string,
): number | null {
  const match = data.find((pr) => pr.headRefName === branch && !pr.isCrossRepository);
  return match ? match.number : null;
}

/** Look up the open same-repo PR whose head branch exactly equals {@link branch}.
 *  Unlike getPrForIssue, this is scoped to one specific branch so stale PRs
 *  from prior slugs (pipeline/N-old-slug) are never returned. Fork PRs sharing
 *  the same headRefName are excluded via the isCrossRepository guard. */
export async function getPrForBranch(
  cfg: PipelineConfig,
  branch: string,
): Promise<number | null> {
  const stdout = await ghRun(
    [
      "pr",
      "list",
      "--json",
      "number,headRefName,isCrossRepository",
      "--state",
      "open",
      "-L",
      "100",
      "-R",
      cfg.repo,
    ],
    { wrapperName: "getPrForBranch" },
  );
  const data = JSON.parse(stdout) as {
    number: number;
    headRefName: string;
    isCrossRepository: boolean;
  }[];
  return selectPrForBranch(data, branch);
}

// ---------------------------------------------------------------------------
// Comment search helpers (used to recover the latest review for fix.ts)
// ---------------------------------------------------------------------------

export async function listIssueComments(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<{ author: string; body: string; createdAt: string }[]> {
  const detail = await getIssueDetail(cfg, issueNumber);
  return detail.comments;
}

export function findLatestCommentMatching(
  comments: { author: string; body: string; createdAt: string }[],
  predicate: (body: string) => boolean,
): { author: string; body: string; createdAt: string } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (predicate(comments[i].body)) return comments[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Human plan feedback (#26)
// ---------------------------------------------------------------------------

// Comment-body header prefixes the pipeline itself posts. A comment whose body
// begins with one of these was generated by the pipeline, not a human. The
// `## Pipeline:` prefix covers stage-transition and blocked comments — without
// it the `## Pipeline: plan review` transition posted between the plan comment
// and the reviewer feedback would be misread as human input on every run. The
// enumerated review/plan headers match the comments posted across the planning
// and review stages (see transition()/postComment call sites). `## Review <N>`
// (any positive integer N) is matched separately via REVIEW_ROUND_RE below since
// review rounds are unbounded.
export const PIPELINE_COMMENT_HEADERS: readonly string[] = [
  "## Implementation Plan",
  "## Revised Implementation Plan",
  "## Plan Review",
  "## Pre-merge Delta Review",
  "## Fix 1",
  "## Fix 2",
  "## Pipeline:",
  "## Pre-Planning Context",
  // Design-gate stage posts (heading is DESIGN_GATE_COMMENT_HEADING). Without
  // this entry, `classifyComment` treats design-interrogation progress as
  // human input and `findUnacknowledgedComments` false-blocks review-1.
  "## Design Interrogation",
  // Pre-code attestation gate posts (#575).
  "## Pre-Code Attestation",
];

// ---------------------------------------------------------------------------
// PIPELINE_COMMENT_KINDS — single-sourced registry (#471)
// ---------------------------------------------------------------------------

/**
 * How a registered comment kind is verified as authentic pipeline output:
 *   - "pipeline-attest": the builder calls `attestPipelineComment(kind, body)`
 *     as its last step (#471).
 *   - "review-artifact": the builder embeds a `<!-- review-artifact: … -->`
 *     record instead (`formatReviewComment` / `formatDeltaReviewComment`,
 *     #264/#390) — the older, review-specific verification path.
 *   - "exempt": deliberately left unverified. `reason` is required and is
 *     asserted present by the drift-guard test; see each entry's reason for
 *     why attesting it would be unsafe or is out of scope.
 */
export type PipelineCommentVerification = "pipeline-attest" | "review-artifact" | "exempt";

/**
 * Single-sourced enumeration of every comment TYPE ("kind") the pipeline
 * posts to an issue or PR (#471). This registry is:
 *   - the enumeration source for the behavioral drift-guard test (renders
 *     each "pipeline-attest"/"review-artifact" kind via its real builder and
 *     asserts it verifies + self-excludes from `findUnacknowledgedComments`
 *     where applicable), and
 *   - the target the source drift-guard test checks every `## Pipeline…`
 *     heading literal in `core/scripts/` against — a literal not covered by
 *     an entry here (or, previously, a test-local allowlist; now folded into
 *     the "exempt" entries below) fails that test.
 *
 * `heading` is the literal (or literal prefix, for dynamic-suffix headings)
 * each kind's rendered body starts with — documentation for humans and the
 * anchor the source guard matches against; it is NOT itself the attestation.
 * `exactOnly: true` marks a `heading` that is a short, structurally generic
 * prefix (e.g. the bare `## Pipeline: ` transition prefix) — the source guard
 * requires an EXACT literal match for these rather than the looser
 * `literal.startsWith(heading)` check, so a genuinely new, unattested
 * `## Pipeline: <something new>` comment type cannot silently hide behind the
 * transition prefix and pass the guard (#471 review 1).
 *
 * `operatorSurface: true` marks a kind the engine renders in DIRECT RESPONSE
 * to an operator CLI invocation, wrapping operator-supplied free text
 * (`pipeline unblock`, `pipeline override`) (#484). These three kinds are the
 * only ones an operator has, by construction, already been heard on — see
 * `isVerifiedOperatorSurfaceComment` and `findUnacknowledgedComments`' anchor
 * rule.
 */
export const PIPELINE_COMMENT_KINDS: readonly {
  kind: string;
  heading: string;
  verify: PipelineCommentVerification;
  exactOnly?: boolean;
  operatorSurface?: boolean;
  reason?: string;
}[] = [
  { kind: "stage-transition", heading: "## Pipeline: ", verify: "pipeline-attest", exactOnly: true },
  { kind: "blocked", heading: "## Pipeline: Blocked at ", verify: "pipeline-attest" },
  { kind: "audit-repair", heading: "## Pipeline: Audit Repair", verify: "pipeline-attest" },
  { kind: "audit-repair-blocked", heading: "## Pipeline: Blocked (audit repair)", verify: "pipeline-attest" },
  { kind: "review-advance-severity", heading: "## Pipeline: Review ", verify: "pipeline-attest" },
  { kind: "review-ceiling", heading: "## Pipeline: Review ceiling reached — human decision required", verify: "pipeline-attest" },
  { kind: "review-ceiling-demotion", heading: "## Pipeline: Review ceiling — findings demoted and deferred", verify: "pipeline-attest" },
  { kind: "delta-round-ceiling", heading: "## Pipeline: Pre-merge delta round ceiling reached — human decision required", verify: "pipeline-attest" },
  { kind: "delta-round-ceiling-demotion", heading: "## Pipeline: Pre-merge delta round ceiling — findings demoted and deferred", verify: "pipeline-attest" },
  { kind: "new-human-input-warning", heading: "## Pipeline: New human input detected", verify: "pipeline-attest" },
  { kind: "pipeline-complete", heading: "## Pipeline Complete", verify: "pipeline-attest" },
  { kind: "auto-recovery", heading: "## Pipeline: Auto-Recovery", verify: "pipeline-attest" },
  { kind: "auto-recovery-limit", heading: "## Pipeline: Auto-Recovery Limit", verify: "pipeline-attest" },
  { kind: "auto-loop-continuation", heading: "## Pipeline: Auto-Loop Continuation", verify: "pipeline-attest" },
  { kind: "auto-loop-exhausted", heading: "## Pipeline: Auto-Loop Budget Exhausted", verify: "pipeline-attest" },
  { kind: "evidence-bundle", heading: "## Pipeline: Evidence bundle", verify: "pipeline-attest" },
  { kind: "pre-merge-rerun-identity", heading: "## Pipeline: Re-running review — prior runner identity differs", verify: "pipeline-attest" },
  { kind: "pre-merge-rerun-scope", heading: "## Pipeline: Re-running review — scoped override active", verify: "pipeline-attest" },
  { kind: "pre-merge-diff-unchanged", heading: "## Pipeline: Diff unchanged since last review; verdict reused", verify: "pipeline-attest" },
  { kind: "pre-merge-stale-review", heading: "## Pipeline: Re-running review", verify: "pipeline-attest" },
  // Review verdicts (#264/#390) — verified via the existing review-artifact path, not
  // the generic attestation marker. Headings are "## Review <N>" (REVIEW_ROUND_RE) and
  // "## Pre-merge Delta Review", neither of which starts with "## Pipeline", so the
  // source guard (which only scans `## Pipeline…` literals) never checks these; they are
  // listed here purely so the registry enumerates every posted comment type per spec.
  { kind: "review-verdict", heading: "## Review ", verify: "review-artifact" },
  { kind: "pre-merge-delta-review", heading: "## Pre-merge Delta Review", verify: "review-artifact" },
  // Design-gate interrogation progress (#436). Heading does not start with
  // `## Pipeline`, so it is listed here for classification + attestation; the
  // source guard only scans `## Pipeline…` literals. Challenge prose often
  // trips NEGATION_PATTERNS ("instead", "do not", …), so attestation is
  // required for self-exclusion from findUnacknowledgedComments.
  {
    kind: "design-interrogation",
    heading: "## Design Interrogation",
    verify: "pipeline-attest",
  },
  // Pre-code human attestation gate (#575). Heading does not start with
  // `## Pipeline`, so it is listed for classification + attestation; the
  // source guard only scans `## Pipeline…` literals.
  {
    kind: "pre-code-attestation",
    heading: "## Pre-Code Attestation",
    verify: "pipeline-attest",
  },
  // Deliberately unattested/unverified comment types, with justification. Moved here
  // (from a prior test-local allowlist) so there is exactly one exported registry.
  {
    kind: "pre-planning-context",
    heading: "## Pre-Planning Context",
    verify: "exempt",
    reason:
      "Wraps THIRD-PARTY human comment excerpts (buildContextSnapshot output) inline — not operator-authored " +
      "free text — posted BEFORE the plan anchor so it is never in findUnacknowledgedComments' scan window. " +
      "Attesting the wrapper would immunize the embedded human excerpts it carries; unlike the operator-surface " +
      "kinds below, the embedded text here was never a direct response to a CLI invocation the operator issued.",
  },
  {
    kind: "unblocked",
    heading: "## Pipeline: Unblocked",
    verify: "pipeline-attest",
    operatorSurface: true,
  },
  {
    kind: "finding-override",
    heading: "## Pipeline: Finding override",
    verify: "pipeline-attest",
    operatorSurface: true,
  },
  {
    kind: "recover-parked-spent",
    heading: "## Pipeline: recover-parked supervisor pass spent",
    verify: "pipeline-attest",
  },
  {
    kind: "scope-override",
    heading: "## Pipeline: Scope override",
    verify: "pipeline-attest",
    operatorSurface: true,
  },
  {
    kind: "finding-does-not-reproduce",
    heading: "## Pipeline: Finding does not reproduce",
    verify: "pipeline-attest",
  },
  {
    kind: "pre-merge-autofix-noop",
    heading: "## Pipeline: Pre-merge auto-fix no-op",
    verify: "pipeline-attest",
  },
  {
    kind: "pre-merge-autofix-attempt",
    heading: "## Pipeline: Pre-merge auto-fix attempt",
    verify: "pipeline-attest",
  },
  {
    kind: "needs-human-decision",
    heading: "## Pipeline: Human decision required",
    verify: "pipeline-attest",
  },
  {
    kind: "human-question-handoff",
    heading: "## Pipeline: Human-question handoff",
    verify: "pipeline-attest",
  },
  {
    kind: "noop-advance-evidence",
    heading: "## Pipeline: noop-advance evidence",
    verify: "pipeline-attest",
  },
  {
    kind: "issue-readiness-admission",
    heading: "## Pipeline: issue-readiness admission",
    verify: "pipeline-attest",
  },
  {
    kind: "issue-readiness-needs-spec",
    heading: "## Pipeline: issue-readiness — needs spec",
    verify: "pipeline-attest",
  },
  {
    kind: "pipeline-classifier-prefix",
    heading: "## Pipeline:",
    verify: "exempt",
    exactOnly: true,
    reason:
      "The bare classification prefix in PIPELINE_COMMENT_HEADERS/status-json.ts/pipeline.ts, used to " +
      "recognize ANY pipeline comment for human/pipeline triage — not itself a distinct posted comment type.",
  },
];

// Kinds the engine renders in direct response to an operator CLI invocation
// (`pipeline unblock`, `pipeline override`), derived from the registry so
// there is exactly one place marking them (#484).
const OPERATOR_SURFACE_KINDS: ReadonlySet<string> = new Set(
  PIPELINE_COMMENT_KINDS.filter((e) => e.operatorSurface).map((e) => e.kind),
);

/**
 * True when `body` is a verified, untampered `pipeline-attest` comment whose
 * attested `kind` is one of the operator-surface kinds (#484) — i.e. it was
 * rendered by the engine in direct response to an operator CLI invocation,
 * not merely styled to look like one. Kind membership is read from the
 * attestation PAYLOAD, never from a heading literal, so a forged heading with
 * a copied marker for a different (non-operator-surface) kind does not
 * qualify. Callers must still check comment authorship/trust separately —
 * this predicate answers only "is this verified operator-surface output",
 * not "is this trustworthy" (trust is a property of who posted it).
 */
export function isVerifiedOperatorSurfaceComment(body: string): boolean {
  const attestation = extractPipelineAttestation(body);
  if (attestation === null || !OPERATOR_SURFACE_KINDS.has(attestation.kind)) return false;
  return isVerifiedPipelineAttestation(body);
}

// Matches "## Review 1", "## Review 2", "## Review 3", ... — review rounds are
// unbounded, so a fixed header list would miss round 3+ (#390).
const REVIEW_ROUND_RE = /^## Review \d+\b/;

// Pipeline machine-sentinel HTML markers (#16/#229/#259/#390). These are
// invisible in rendered Markdown and can appear anywhere in the body (not just
// the leading header), so they are matched via substring, not prefix.
const PIPELINE_SENTINEL_MARKERS: readonly string[] = [
  "<!-- pipeline-audit:",
  "<!-- pipeline-override",
  "<!-- pipeline-override-scope",
  "<!-- pipeline-blocking-keys",
  "<!-- pipeline-blocking-surfaces",
  "<!-- reviewed-sha",
  // Generic pipeline attestation marker (#471) — any attested comment is
  // structurally pipeline regardless of its heading, matching how the other
  // sentinels above are treated.
  "<!-- pipeline-attest:",
];

const PLAN_COMMENT_HEADER = "## Implementation Plan";

/** Structural pipeline-marker test shared by isPipelineComment and classifyComment:
 *  a known header prefix, a `## Review <N>` round heading, or a sentinel HTML marker. */
function hasPipelineMarker(body: string): boolean {
  const head = body.trimStart();
  return (
    PIPELINE_COMMENT_HEADERS.some((h) => head.startsWith(h)) ||
    REVIEW_ROUND_RE.test(head) ||
    PIPELINE_SENTINEL_MARKERS.some((m) => body.includes(m))
  );
}

/** Was this comment body posted by the pipeline (vs. a human)? */
function isPipelineComment(body: string): boolean {
  return hasPipelineMarker(body);
}

/**
 * Classify a comment body as 'human' or 'pipeline'.
 * Empty bodies are treated as pipeline-authored (no human wrote a blank comment).
 */
export function classifyComment(body: string): 'human' | 'pipeline' {
  const head = body.trimStart();
  if (!head) return 'pipeline';
  return hasPipelineMarker(body) ? 'pipeline' : 'human';
}

/**
 * Identify human comments left on the posted plan (#26). Comments arrive in
 * chronological order, so the function anchors on the plan comment — the exact
 * body we posted if present, else the most recent comment opening with
 * `## Implementation Plan` (GitHub may normalise line endings) — and returns
 * every later comment that is NOT pipeline-generated, preserving order. Returns
 * `[]` when no plan comment is found or nothing human follows it.
 */
export function extractHumanPlanComments(
  comments: { author: string; body: string; createdAt: string }[],
  planCommentBody: string,
): { author: string; body: string }[] {
  let planIdx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body === planCommentBody) {
      planIdx = i;
      break;
    }
  }
  if (planIdx === -1) {
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].body.trimStart().startsWith(PLAN_COMMENT_HEADER)) {
        planIdx = i;
        break;
      }
    }
  }
  if (planIdx === -1) return [];

  const human: { author: string; body: string }[] = [];
  for (let i = planIdx + 1; i < comments.length; i++) {
    if (isPipelineComment(comments[i].body)) continue;
    human.push({ author: comments[i].author, body: comments[i].body });
  }
  return human;
}

// ---------------------------------------------------------------------------
// Pure parser exports (covered by gh-parsers.test.ts)
// ---------------------------------------------------------------------------

export function parseChecksAggregate(checks: CheckRun[]): {
  passed: boolean;
  pending: boolean;
  failed: { name: string; bucket: string }[];
} {
  let passed = true;
  let pending = false;
  const failed: { name: string; bucket: string }[] = [];
  for (const c of checks) {
    const bucket = (c.bucket ?? "").toLowerCase();
    if (bucket === "pass" || bucket === "skipping") continue;
    if (bucket === "fail" || bucket === "cancel") {
      passed = false;
      failed.push({ name: c.name ?? "unknown", bucket });
    } else {
      pending = true;
    }
  }
  return { passed: passed && !pending, pending, failed };
}

export function parseMergeable(detail: PrDetail): "clean" | "conflict" | "unknown" {
  if (detail.mergeable === true) return "clean";
  if (detail.mergeable === false) return "conflict";
  // Fall back to mergeable_state for cases gh returns null.
  const state = (detail.mergeable_state ?? "").toUpperCase();
  if (state === "CLEAN" || state === "HAS_HOOKS") return "clean";
  if (state === "DIRTY" || state === "BEHIND" || state === "BLOCKED") return "conflict";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Roadmap engine helpers (#171)
// ---------------------------------------------------------------------------

export interface OpenIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
  state: "open" | "closed";
  updatedAt?: string;
  /** Present when the API payload includes milestone (roadmap recon #910). */
  milestone?: { number: number; title: string } | null;
}

interface GhIssueRaw {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  url: string;
  state: string;
  updatedAt?: string;
}

/**
 * Map a raw `gh issue list --json` entry to the typed `OpenIssue` shape.
 * Exported for unit testing.
 */
export function mapRawIssue(issue: GhIssueRaw): OpenIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: (issue.labels ?? []).map((l) => l.name),
    url: issue.url,
    state: (issue.state?.toLowerCase() === "closed" ? "closed" : "open") as "open" | "closed",
    updatedAt: issue.updatedAt,
  };
}

/**
 * Shape returned by `gh api repos/<repo>/issues` (REST API).
 * Field names differ from `gh issue list --json` (snake_case, html_url, etc.).
 */
export interface GhApiIssueRaw {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  html_url: string;
  state: string;
  updated_at?: string;
  /** Present on pull requests; absent on issues. Used to filter PRs out. */
  pull_request?: unknown;
  milestone?: { number: number; title: string } | null;
}

/**
 * Map a raw `gh api repos/<repo>/issues` entry to the typed `OpenIssue` shape.
 * Exported for unit testing.
 */
export function mapApiIssue(issue: GhApiIssueRaw): OpenIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: (issue.labels ?? []).map((l) => l.name),
    url: issue.html_url,
    state: (issue.state?.toLowerCase() === "closed" ? "closed" : "open") as "open" | "closed",
    updatedAt: issue.updated_at,
    milestone: issue.milestone
      ? { number: issue.milestone.number, title: issue.milestone.title }
      : issue.milestone === null
        ? null
        : undefined,
  };
}

/**
 * Fetch ALL open issues from a repo via paginated `gh api` calls.
 * Uses `gh api repos/<repo>/issues --paginate` so repositories with more than
 * 100 open issues are not silently truncated (the old `gh issue list --limit 500` cap).
 * PRs are filtered out (the GitHub API includes them under the issues endpoint).
 */
export async function getOpenIssues(
  repo: string,
  opts: { labels?: string[] } = {},
): Promise<OpenIssue[]> {
  let apiPath = `repos/${repo}/issues?state=open&per_page=100`;
  if (opts.labels && opts.labels.length > 0) {
    apiPath += `&labels=${encodeURIComponent(opts.labels.join(","))}`;
  }

  const stdout = await ghRun(["api", apiPath, "--paginate", "--slurp"], { timeoutMs: 120_000 });
  // --slurp wraps each page array into an outer array: [[page1...], [page2...]]. Flatten before filtering.
  const raw = (JSON.parse(stdout) as GhApiIssueRaw[][]).flat();
  // Filter PRs: the GitHub API lists PRs under the issues endpoint; PRs have a pull_request field.
  return raw.filter((r) => !r.pull_request).map(mapApiIssue);
}

interface GhMilestoneRaw {
  id: number;
  number: number;
  title: string;
  state?: string;
  description?: string | null;
  open_issues?: number;
  closed_issues?: number;
}

export interface GhMilestoneDetailed {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  description: string;
  open_issues: number;
  closed_issues: number;
}

/**
 * Fetch all milestones for a repo.
 * Uses `gh api repos/<repo>/milestones`.
 */
export async function getMilestones(repo: string): Promise<Array<{ id: number; number: number; title: string }>> {
  const detailed = await listMilestonesDetailed(repo);
  return detailed.map((m) => ({ id: m.id, number: m.number, title: m.title }));
}

/**
 * Fetch all milestones with state, description, and issue counts (#910).
 */
export async function listMilestonesDetailed(repo: string): Promise<GhMilestoneDetailed[]> {
  const stdout = await ghRun(["api", `repos/${repo}/milestones?state=all`, "--paginate", "--slurp"], {
    timeoutMs: 30_000,
  });
  // --slurp wraps each page array into an outer array. Flatten before mapping.
  const raw = (JSON.parse(stdout) as GhMilestoneRaw[][]).flat();
  return raw.map((m) => ({
    id: m.id,
    number: m.number,
    title: m.title,
    state: (m.state?.toLowerCase() === "closed" ? "closed" : "open") as "open" | "closed",
    description: m.description ?? "",
    open_issues: m.open_issues ?? 0,
    closed_issues: m.closed_issues ?? 0,
  }));
}

/**
 * Create a milestone in a repo and return its number.
 */
export async function createMilestone(
  repo: string,
  title: string,
  descriptionOrDueOn?: string,
  dueOn?: string,
): Promise<number> {
  // Back-compat: third arg was dueOn (ISO date). If it looks like a due date, treat as dueOn.
  let description: string | undefined;
  let due: string | undefined;
  if (dueOn !== undefined) {
    description = descriptionOrDueOn;
    due = dueOn;
  } else if (descriptionOrDueOn !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}/.test(descriptionOrDueOn)) {
      due = descriptionOrDueOn;
    } else {
      description = descriptionOrDueOn;
    }
  }

  const args = [
    "api",
    `repos/${repo}/milestones`,
    "--method",
    "POST",
    "--field",
    `title=${title}`,
  ];
  if (description) args.push("--field", `description=${description}`);
  if (due) args.push("--field", `due_on=${due}`);

  const stdout = await ghRun(args, { timeoutMs: 30_000, retries: 1 });
  const result = JSON.parse(stdout) as { number: number };
  return result.number;
}

/**
 * Reopen a closed milestone (#910).
 */
export async function reopenMilestone(repo: string, milestoneNumber: number): Promise<void> {
  await ghRun(
    [
      "api",
      `repos/${repo}/milestones/${milestoneNumber}`,
      "--method",
      "PATCH",
      "--field",
      "state=open",
    ],
    { timeoutMs: 30_000, retries: 1 },
  );
}

/**
 * Update milestone title and/or description (#910).
 */
export async function updateMilestone(
  repo: string,
  milestoneNumber: number,
  opts: { title?: string; description?: string },
): Promise<void> {
  const args = [
    "api",
    `repos/${repo}/milestones/${milestoneNumber}`,
    "--method",
    "PATCH",
  ];
  if (opts.title !== undefined) args.push("--field", `title=${opts.title}`);
  if (opts.description !== undefined) args.push("--field", `description=${opts.description}`);
  if (opts.title === undefined && opts.description === undefined) return;
  await ghRun(args, { timeoutMs: 30_000, retries: 1 });
}

/**
 * Clear an issue's milestone assignment (#910).
 */
export async function clearIssueMilestone(repo: string, issueNumber: number): Promise<void> {
  await ghRun(
    ["issue", "edit", String(issueNumber), "--remove-milestone", "-R", repo],
    { timeoutMs: 30_000, retries: 1 },
  );
}

/**
 * Open-issue snapshots with milestone fields for reconciliation fingerprinting (#910).
 */
export async function listOpenIssueMilestoneSnapshots(
  repo: string,
): Promise<
  Array<{
    number: number;
    state: "open" | "closed";
    milestone_number: number | null;
    milestone_title: string | null;
    updatedAt?: string;
    labels: string[];
  }>
> {
  const issues = await getOpenIssues(repo);
  return issues.map((i) => ({
    number: i.number,
    state: i.state,
    milestone_number: i.milestone?.number ?? null,
    milestone_title: i.milestone?.title ?? null,
    updatedAt: i.updatedAt,
    labels: i.labels,
  }));
}

/**
 * Return the login of the currently-authenticated GitHub user, or null if the
 * lookup fails (not authenticated, network error). Used by the diff-hash cache
 * in advanceReview to reject forged review comments from other commenters (#228).
 */
export async function getGhActor(): Promise<string | null> {
  try {
    const login = await ghRun(
      ["api", "user", "--jq", ".login"],
      { timeoutMs: 10_000, retries: 1, wrapperName: "getGhActor" },
    );
    return login.trim() || null;
  } catch {
    return null;
  }
}
