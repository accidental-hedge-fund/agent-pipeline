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

  record(category: string, elapsedMs: number): void {
    this.times.push(elapsedMs);
    this._slowest.push({ category, elapsed_ms: elapsedMs });
    this._slowest.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
    if (this._slowest.length > 5) this._slowest.length = 5;
  }

  summary(): GhMetricsSummary {
    const n = this.times.length;
    if (n === 0) {
      return { call_count: 0, total_ms: 0, p50_ms: 0, p95_ms: 0, slowest_calls: [] };
    }
    const total_ms = this.times.reduce((a, b) => a + b, 0);
    const sorted = [...this.times].sort((a, b) => a - b);
    return {
      call_count: n,
      total_ms,
      p50_ms: Math.floor(computePercentile(sorted, 50)),
      p95_ms: Math.floor(computePercentile(sorted, 95)),
      slowest_calls: [...this._slowest],
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

const COMMENT_FOOTER = "\n\n---\n*Automated by Claude Code Pipeline Skill*";

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
}

async function ghRun(args: string[], opts: GhRunOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const collector = opts.collector ?? _activeCollector;
  const _sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const _isTransient = opts.isTransient ?? isTransientGhError;
  const _runner: GhSubprocessRunner = opts.runner ?? ((runArgs) =>
    execFileAsync("gh", runArgs, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
  );
  const category = args.slice(0, 2).join(" ");
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const t0 = performance.now();
    try {
      const { stdout } = await _runner(args);
      collector?.record(category, Math.round(performance.now() - t0));
      return stdout;
    } catch (err) {
      collector?.record(category, Math.round(performance.now() - t0));
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
): Promise<ItemDetail & { comments: { author: string; body: string; createdAt: string }[] }> {
  const stdout = await ghRun([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "number,title,body,labels,comments,state,url",
    "-R",
    cfg.repo,
  ]);
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
  run: GhApiRunner = (args) => ghRun(args),
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
    const stdout = await ghRun([
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "state,labels",
      "-R",
      cfg.repo,
    ]);
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

/** Detect issue vs PR via the REST API (PRs have a `pull_request` field). */
export async function getItemKind(
  cfg: PipelineConfig,
  number: number,
): Promise<"issue" | "pull_request"> {
  const stdout = await ghRun([
    "api",
    `/repos/${cfg.repo}/issues/${number}`,
    "--jq",
    "if .pull_request then \"pull_request\" else \"issue\" end",
  ]);
  const trimmed = stdout.trim();
  return trimmed === "pull_request" ? "pull_request" : "issue";
}

/** For a PR, return the linked closing issue number, or null. */
export async function getPrLinkedIssue(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<number | null> {
  try {
    const stdout = await ghRun([
      "pr",
      "view",
      String(prNumber),
      "--json",
      "closingIssuesReferences",
      "-R",
      cfg.repo,
    ]);
    const data = JSON.parse(stdout) as {
      closingIssuesReferences?: { number: number }[];
    };
    const refs = data.closingIssuesReferences ?? [];
    return refs.length > 0 ? refs[0].number : null;
  } catch {
    return null;
  }
}

export async function getPrDetail(cfg: PipelineConfig, prNumber: number): Promise<PrDetail> {
  const stdout = await ghRun([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,body,state,url,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,isDraft,additions,deletions,changedFiles",
    "-R",
    cfg.repo,
  ]);
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
  };
}

export async function getPrChecks(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<CheckRun[]> {
  const stdout = await ghRun([
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "name,state,bucket,description,link",
    "-R",
    cfg.repo,
  ]);
  return JSON.parse(stdout) as CheckRun[];
}

export async function getPrDiff(cfg: PipelineConfig, prNumber: number): Promise<string> {
  const stdout = await ghRun(
    ["pr", "diff", String(prNumber), "-R", cfg.repo],
    { timeoutMs: 60_000 },
  );
  return stdout;
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
  const stdout = await ghRun([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "commits",
    "-R",
    cfg.repo,
  ]);
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

export function getHarnessLabel(labels: string[]): "claude" | "codex" | null {
  for (const name of labels) {
    if (name.startsWith("harness:")) {
      const h = name.slice("harness:".length);
      if (h === "claude" || h === "codex") return h;
    }
  }
  return null;
}


export async function ensurePipelineLabels(cfg: PipelineConfig): Promise<void> {
  const desired: { name: string; color: string; description: string }[] = [
    { name: BLOCKED_LABEL, color: "D73A4A", description: "Pipeline blocked awaiting human or external action" },
    { name: "harness:claude", color: "6F42C1", description: "Pipeline item owned by Claude primary harness" },
    { name: "harness:codex", color: "0052CC", description: "Pipeline item owned by Codex primary harness" },
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
    runOpts,
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
 * Post a comment on the PULL REQUEST (not the linked issue). The pipeline does all
 * its review bookkeeping on the issue, but a human merges the PR — so findings the
 * pipeline advanced past as advisory can slip the merge button if they live only
 * on the issue. This surfaces them where the merge decision is made.
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
    await ghRun([
      "issue", "edit", String(n),
      "--remove-label", `${LABEL_PREFIX}${from}`,
      "--add-label", `${LABEL_PREFIX}${to}`,
      "-R", c.repo,
    ]);
  });
  const _postComment = deps.postComment ?? postComment;
  const _sleep = deps.sleep;

  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const harness = getHarnessLabel(
    (await _getIssueDetail(cfg, issueNumber)).labels,
  ) ?? "unassigned";

  const effectiveRunId = _activeRunId ?? "unknown";
  const lines = [
    `## Pipeline: ${toStage.replace(/-/g, " ")}`,
    "",
    `**Harness**: ${harness}`,
    `**Transition**: \`${fromStage}\` → \`${toStage}\``,
    `**Timestamp**: ${ts}`,
  ];
  if (summary) {
    lines.push("", "### Summary", summary);
  }
  const comment = lines.join("\n") + COMMENT_FOOTER + "\n" + buildAuditSentinel(effectiveRunId, toStage);

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
}): string {
  return [
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
  ].join("\n") + COMMENT_FOOTER;
}

/** I/O seam for {@link setBlocked} so unit tests inject fakes — no real network. */
export interface SetBlockedDeps {
  getIssueDetail?: (cfg: PipelineConfig, n: number) => Promise<{ labels: string[] }>;
  addBlockedLabel?: (cfg: PipelineConfig, n: number) => Promise<void>;
  postComment?: (cfg: PipelineConfig, n: number, body: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
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
  const body = buildBlockedComment({ issueNumber, stageStr, harness, ts, reason, kind })
    + "\n" + buildAuditSentinel(effectiveRunId, "blocked");

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
  const stdout = await ghRun([
    "api",
    `repos/${cfg.repo}/commits/${sha}/check-runs`,
    "--jq",
    ".total_count",
  ]);
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
  const stdout = await ghRun([
    "api",
    `repos/${cfg.repo}/commits/${sha}/check-runs`,
    "--jq",
    "[.check_runs[] | select(.conclusion == \"success\")] | length",
  ]);
  const n = parseInt(stdout.trim(), 10);
  return isNaN(n) ? 0 : n;
}

export async function closePr(cfg: PipelineConfig, prNumber: number): Promise<void> {
  await ghRun(["pr", "close", String(prNumber), "-R", cfg.repo]);
}

export async function reopenPr(cfg: PipelineConfig, prNumber: number): Promise<void> {
  await ghRun(["pr", "reopen", String(prNumber), "-R", cfg.repo]);
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

/** Parse `gh pr list --json number,headRefName,isCrossRepository,closingIssuesReferences`
 *  into PrCandidate[]. One query carries everything resolvePrForIssue needs.
 *  Exported for tests. */
export function parsePrList(stdout: string): PrCandidate[] {
  const data = JSON.parse(stdout) as {
    number: number;
    headRefName: string;
    isCrossRepository?: boolean;
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
 *  Pure and synchronous: resolution does no per-PR API calls (#97). */
export function resolvePrForIssue(
  prs: PrCandidate[],
  issueNumber: number,
  targetRepo: string,
): number | null {
  const branchPrefix = `pipeline/${issueNumber}-`;
  for (const pr of prs) {
    // A fork PR's headRefName is only the branch name and can spoof the prefix,
    // so the fast path trusts it only for same-repo (non-fork) PRs (#76).
    if (!pr.isCrossRepository && pr.headRefName.startsWith(branchPrefix)) return pr.number;
  }

  const target = targetRepo.toLowerCase();
  for (const pr of prs) {
    if (
      pr.closingIssues.some(
        (r) => r.nameWithOwner.toLowerCase() === target && r.number === issueNumber,
      )
    ) {
      return pr.number;
    }
  }
  return null;
}

export async function getPrForIssue(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<number | null> {
  // A single list query carries number + branch + fork flag + closing refs, so
  // resolution never fans out to one `gh pr view` per open PR (#97). A transient
  // failure on an unrelated PR can no longer abort the shared resolver.
  const stdout = await ghRun([
    "pr",
    "list",
    "--json",
    "number,headRefName,isCrossRepository,closingIssuesReferences",
    "--state",
    "open",
    "-L",
    "100",
    "-R",
    cfg.repo,
  ]);
  return resolvePrForIssue(parsePrList(stdout), issueNumber, cfg.repo);
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
  const stdout = await ghRun([
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
  ]);
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
// and review stages (see transition()/postComment call sites).
export const PIPELINE_COMMENT_HEADERS: readonly string[] = [
  "## Implementation Plan",
  "## Revised Implementation Plan",
  "## Plan Review",
  "## Review 1",
  "## Review 2",
  "## Fix 1",
  "## Fix 2",
  "## Pipeline:",
  "## Pre-Planning Context",
];

const PLAN_COMMENT_HEADER = "## Implementation Plan";

/** Was this comment body posted by the pipeline (vs. a human)? */
function isPipelineComment(body: string): boolean {
  const head = body.trimStart();
  return PIPELINE_COMMENT_HEADERS.some((h) => head.startsWith(h));
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
}

/**
 * Fetch all milestones for a repo.
 * Uses `gh api repos/<repo>/milestones`.
 */
export async function getMilestones(repo: string): Promise<Array<{ id: number; number: number; title: string }>> {
  const stdout = await ghRun(["api", `repos/${repo}/milestones?state=all`, "--paginate", "--slurp"], {
    timeoutMs: 30_000,
  });
  // --slurp wraps each page array into an outer array. Flatten before mapping.
  const raw = (JSON.parse(stdout) as GhMilestoneRaw[][]).flat();
  return raw.map((m) => ({ id: m.id, number: m.number, title: m.title }));
}

/**
 * Create a milestone in a repo and return its number.
 */
export async function createMilestone(
  repo: string,
  title: string,
  dueOn?: string,
): Promise<number> {
  const args = [
    "api",
    `repos/${repo}/milestones`,
    "--method",
    "POST",
    "--field",
    `title=${title}`,
  ];
  if (dueOn) args.push("--field", `due_on=${dueOn}`);

  const stdout = await ghRun(args, { timeoutMs: 30_000, retries: 1 });
  const result = JSON.parse(stdout) as { number: number };
  return result.number;
}

/**
 * Return the login of the currently-authenticated GitHub user, or null if the
 * lookup fails (not authenticated, network error). Used by the diff-hash cache
 * in advanceReview to reject forged review comments from other commenters (#228).
 */
export async function getGhActor(): Promise<string | null> {
  try {
    const login = await ghRun(["api", "user", "--jq", ".login"], { timeoutMs: 10_000, retries: 1 });
    return login.trim() || null;
  } catch {
    return null;
  }
}
