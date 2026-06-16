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
  AWAITING_APPROVAL_LABEL,
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

interface GhRunOptions {
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Number of retries on rate-limit errors. Default 3. */
  retries?: number;
}

async function ghRun(args: string[], opts: GhRunOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { stdout } = await execFileAsync("gh", args, {
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024, // 50 MB
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string; code?: number };
      const stderr = (e.stderr ?? "").toString();
      lastErr = new Error(
        `gh ${args.slice(0, 3).join(" ")} failed: ${stderr.trim() || e.message}`,
      );
      if (stderr.toLowerCase().includes("rate limit") && attempt < retries - 1) {
        const backoff = 2 ** attempt * 1000;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw lastErr;
    }
  }
  // Unreachable, but keep the type checker happy.
  throw lastErr ?? new Error("gh: unknown failure");
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
    { name: AWAITING_APPROVAL_LABEL, color: "FBCA04", description: "Pipeline paused awaiting human approval at a declared checkpoint" },
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
): Promise<void> {
  await ghRun([
    "issue",
    "comment",
    String(issueNumber),
    "--body",
    body,
    "-R",
    cfg.repo,
  ]);
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
): Promise<void> {
  await ghRun([
    "pr",
    "comment",
    String(prNumber),
    "--body",
    body,
    "-R",
    cfg.repo,
  ]);
}

export async function transition(
  cfg: PipelineConfig,
  issueNumber: number,
  fromStage: Stage,
  toStage: Stage,
  summary: string,
): Promise<void> {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const harness = getHarnessLabel(
    (await getIssueDetail(cfg, issueNumber)).labels,
  ) ?? "unassigned";

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
  const comment = lines.join("\n") + COMMENT_FOOTER;

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
  await postComment(cfg, issueNumber, comment);
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

export async function setBlocked(
  cfg: PipelineConfig,
  issueNumber: number,
  reason: string,
  stage: Stage | null = null,
  kind: BlockerKind = DEFAULT_BLOCKER_KIND,
): Promise<void> {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const detail = await getIssueDetail(cfg, issueNumber);
  const stageStr = stage ?? pickStage(detail.labels) ?? "unknown";
  const harness = getHarnessLabel(detail.labels) ?? "unassigned";

  const body = buildBlockedComment({ issueNumber, stageStr, harness, ts, reason, kind });

  await ghRun([
    "issue",
    "edit",
    String(issueNumber),
    "--add-label",
    BLOCKED_LABEL,
    "-R",
    cfg.repo,
  ]);
  await postComment(cfg, issueNumber, body);
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

export async function applyAwaitingApprovalLabel(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<void> {
  await addLabel(cfg, issueNumber, AWAITING_APPROVAL_LABEL);
}

export async function removeAwaitingApprovalLabel(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<void> {
  await removeLabel(cfg, issueNumber, AWAITING_APPROVAL_LABEL);
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
  const stdout = await ghRun(args, { timeoutMs: 60_000 });
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

/**
 * Fetch the conversation comments on a PULL REQUEST (not the linked issue).
 * Used by the approval-checkpoint gate to post and read checkpoint comments on
 * the PR thread when one exists, so the approval gate is visible where the
 * merge decision is made (#23, Finding 5).
 */
export async function getPrComments(
  cfg: PipelineConfig,
  prNumber: number,
): Promise<{ author: string; body: string; createdAt: string }[]> {
  const stdout = await ghRun([
    "pr",
    "view",
    String(prNumber),
    "--json",
    "comments",
    "-R",
    cfg.repo,
  ]);
  const data = JSON.parse(stdout) as {
    comments?: { author?: { login: string }; body: string; createdAt: string }[];
  };
  return (data.comments ?? []).map((c) => ({
    author: c.author?.login ?? "unknown",
    body: c.body ?? "",
    createdAt: c.createdAt,
  }));
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
