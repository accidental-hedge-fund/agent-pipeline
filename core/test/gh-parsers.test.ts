// Pure parser exports from gh.ts and stages/review.ts. No subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addIssueComment,
  createIssue,
  extractHumanPlanComments,
  getHarnessLabel,
  getIssueLabelEvents,
  isBlocked,
  mapRawIssue,
  mapApiIssue,
  type GhApiIssueRaw,
  normalizeClosingRefs,
  parseChecksAggregate,
  parseMergeable,
  parsePrList,
  parsePrMergeState,
  pickStage,
  resolvePrForIssue,
  selectPrForBranch,
  type GhApiRunner,
  type PrCandidate,
} from "../scripts/gh.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import {
  formatReviewComment,
  parseStructuredVerdict,
  parseTextVerdict,
} from "../scripts/stages/review.ts";
import { extractReviewFindings } from "../scripts/stages/fix.ts";
import type { CheckRun, PrDetail } from "../scripts/types.ts";

test("pickStage: returns null when no pipeline label", () => {
  assert.equal(pickStage(["bug", "P1"]), null);
});

test("pickStage: returns furthest-along stage when multiple are present", () => {
  // ready and review-1 both → review-1 is further along.
  assert.equal(pickStage(["pipeline:ready", "pipeline:review-1"]), "review-1");
  assert.equal(
    pickStage(["pipeline:ready-to-deploy", "pipeline:pre-merge"]),
    "ready-to-deploy",
  );
});

test("pickStage: ignores unknown pipeline:* labels", () => {
  assert.equal(pickStage(["pipeline:does-not-exist"]), null);
});

test("isBlocked: detects blocked label", () => {
  assert.equal(isBlocked(["pipeline:ready", "blocked"]), true);
  assert.equal(isBlocked(["pipeline:ready"]), false);
});

test("getHarnessLabel: parses harness:claude / harness:codex", () => {
  assert.equal(getHarnessLabel(["harness:claude"]), "claude");
  assert.equal(getHarnessLabel(["harness:codex"]), "codex");
  assert.equal(getHarnessLabel(["harness:other"]), null);
  assert.equal(getHarnessLabel(["pipeline:ready"]), null);
});

test("parseChecksAggregate: all pass + skipping → passed", () => {
  const checks: CheckRun[] = [
    { name: "lint", state: "COMPLETED", bucket: "pass" },
    { name: "skipped-doc", state: "SKIPPED", bucket: "skipping" },
  ];
  const r = parseChecksAggregate(checks);
  assert.equal(r.passed, true);
  assert.equal(r.pending, false);
  assert.deepEqual(r.failed, []);
});

test("parseChecksAggregate: any fail → not-passed and lists failed", () => {
  const checks: CheckRun[] = [
    { name: "lint", state: "COMPLETED", bucket: "pass" },
    { name: "tests", state: "COMPLETED", bucket: "fail" },
  ];
  const r = parseChecksAggregate(checks);
  assert.equal(r.passed, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, "tests");
});

test("parseChecksAggregate: in_progress → pending", () => {
  const checks: CheckRun[] = [
    { name: "lint", state: "COMPLETED", bucket: "pass" },
    { name: "tests", state: "IN_PROGRESS", bucket: "pending" },
  ];
  const r = parseChecksAggregate(checks);
  assert.equal(r.passed, false); // pending blocks pass
  assert.equal(r.pending, true);
});

test("parseMergeable: clean", () => {
  const detail: PrDetail = {
    number: 1,
    title: "",
    body: "",
    state: "open",
    url: "",
    head_ref: "",
    head_sha: "",
    base_ref: "",
    mergeable: true,
    mergeable_state: "CLEAN",
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
  assert.equal(parseMergeable(detail), "clean");
});

test("parseMergeable: conflict via mergeable=false", () => {
  const detail: PrDetail = {
    number: 1,
    title: "",
    body: "",
    state: "open",
    url: "",
    head_ref: "",
    head_sha: "",
    base_ref: "",
    mergeable: false,
    mergeable_state: "DIRTY",
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
  assert.equal(parseMergeable(detail), "conflict");
});

test("parseMergeable: unknown when GH still computing", () => {
  const detail: PrDetail = {
    number: 1,
    title: "",
    body: "",
    state: "open",
    url: "",
    head_ref: "",
    head_sha: "",
    base_ref: "",
    mergeable: null,
    mergeable_state: "UNKNOWN",
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
  assert.equal(parseMergeable(detail), "unknown");
});

// ---------- review verdict parsing ----------

test("parseStructuredVerdict: parses fenced JSON", () => {
  const out = `Some preamble\n\`\`\`json\n${JSON.stringify({
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: [],
  })}\n\`\`\``;
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "approve");
  assert.equal(v.summary, "ok");
});

test("parseStructuredVerdict: parses inline JSON without fences", () => {
  const v = parseStructuredVerdict(
    `verdict here\n${JSON.stringify({
      verdict: "needs-attention",
      summary: "fix it",
      findings: [
        {
          severity: "high",
          title: "Null deref",
          body: "x",
          file: "a.ts",
          line_start: 5,
          line_end: 7,
          confidence: 0.9,
          recommendation: "guard",
        },
      ],
      next_steps: [],
    })}`,
  );
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0].severity, "high");
});

test("parseStructuredVerdict: falls back to text on bad JSON", () => {
  const v = parseStructuredVerdict("** APPROVE **: looks great");
  assert.equal(v.verdict, "approve");
});

test("parseTextVerdict: defaults to needs-attention when uncertain", () => {
  assert.equal(parseTextVerdict("…"), "needs-attention");
});

test("parseTextVerdict: detects request_changes", () => {
  assert.equal(parseTextVerdict("REQUEST_CHANGES: foo"), "needs-attention");
});

test("formatReviewComment: includes findings", () => {
  const md = formatReviewComment(
    {
      verdict: "needs-attention",
      summary: "fix",
      findings: [
        {
          severity: "high",
          title: "Bad",
          body: "explain",
          file: "x.ts",
          line_start: 1,
          line_end: 3,
          confidence: 0.8,
          recommendation: "do better",
        },
      ],
      next_steps: ["follow up"],
      commitSha: "a".repeat(40),
    },
    1,
    "codex",
  );
  assert.match(md, /Review 1 \(Standard\)/);
  assert.match(md, /\[HIGH\] Bad/);
  assert.match(md, /do better/);
  assert.match(md, /follow up/);
  // #16: the short SHA is visible in the header; reviewed-sha sentinel present.
  // #264: artifact block is now the last line (after reviewed-sha).
  assert.match(md, /\(commit aaaaaaa\)/);
  assert.ok(md.includes(`<!-- reviewed-sha: ${"a".repeat(40)} -->`), "reviewed-sha sentinel present");
  assert.match(md, /<!-- review-artifact: [A-Za-z0-9_-]+ -->\s*$/, "artifact block must be last");
});

test("extractReviewFindings: matches Review N with needs-attention", () => {
  const comments = [
    { body: "## Pipeline: review-1" },
    {
      body:
        "## Review 1 (Standard) — needs-attention\n\n### Findings\n\n**1. [HIGH] X**\n",
    },
  ];
  const f = extractReviewFindings(comments, 1);
  assert.match(f, /needs-attention/);
});

test("extractReviewFindings: returns empty when no review found", () => {
  const f = extractReviewFindings([{ body: "random comment" }], 1);
  assert.equal(f, "");
});

// ---------- parsePrMergeState ----------

test("parsePrMergeState: single merged PR → merged=true with prNumber and headSha", () => {
  const stdout = JSON.stringify([{ number: 42, headRefOid: "abc123def456" }]);
  const result = parsePrMergeState(stdout);
  assert.equal(result.merged, true);
  if (result.merged) {
    assert.equal(result.prNumber, 42);
    assert.equal(result.headSha, "abc123def456");
  }
});

test("parsePrMergeState: empty array → merged=false", () => {
  const result = parsePrMergeState("[]");
  assert.equal(result.merged, false);
});

// ---------- normalizeClosingRefs + parsePrList (#76/#97) ----------

test("normalizeClosingRefs: constructs nameWithOwner from owner.login + name (realistic gh shape)", () => {
  // gh emits repository { id, name, owner { id, login } }, NOT a nameWithOwner field.
  const raw = [
    { number: 42, repository: { name: "repo", owner: { login: "owner" } } },
    { number: 7, repository: { name: "other-repo", owner: { login: "other-owner" } } },
  ];
  assert.deepEqual(normalizeClosingRefs(raw), [
    { number: 42, nameWithOwner: "owner/repo" },
    { number: 7, nameWithOwner: "other-owner/other-repo" },
  ]);
});

test("normalizeClosingRefs: undefined/empty and repository-less refs are dropped", () => {
  assert.deepEqual(normalizeClosingRefs(undefined), []);
  assert.deepEqual(normalizeClosingRefs([]), []);
  assert.deepEqual(normalizeClosingRefs([{ number: 9 }]), []); // no repository → dropped
});

test("parsePrList: a single list query yields candidates carrying their closing refs (#97)", () => {
  // The shape of `gh pr list --json number,headRefName,isCrossRepository,closingIssuesReferences`.
  const stdout = JSON.stringify([
    {
      number: 96,
      headRefName: "pipeline/76-fix",
      isCrossRepository: false,
      closingIssuesReferences: [
        { number: 76, repository: { name: "repo", owner: { login: "owner" } } },
      ],
    },
    { number: 7, headRefName: "feat/x", isCrossRepository: true },
  ]);
  const prs = parsePrList(stdout);
  assert.equal(prs.length, 2);
  assert.deepEqual(prs[0], {
    number: 96,
    headRefName: "pipeline/76-fix",
    isCrossRepository: false,
    closingIssues: [{ number: 76, nameWithOwner: "owner/repo" }],
  });
  assert.equal(prs[1].isCrossRepository, true);
  assert.deepEqual(prs[1].closingIssues, [], "missing closing refs → empty");
});

// ---------- resolvePrForIssue (#76/#97) — pure, synchronous, single-call ----------

const TARGET_REPO = "owner/repo";

function cand(
  number: number,
  headRefName: string,
  opts: { fork?: boolean; closes?: number[] } = {},
): PrCandidate {
  return {
    number,
    headRefName,
    isCrossRepository: opts.fork ?? false,
    closingIssues: (opts.closes ?? []).map((n) => ({ number: n, nameWithOwner: TARGET_REPO })),
  };
}

test("resolvePrForIssue: branch-prefix match returns the PR (no closing refs needed)", () => {
  const prs = [cand(7, "feat/unrelated"), cand(9, "pipeline/42-my-feature")];
  assert.equal(resolvePrForIssue(prs, 42, TARGET_REPO), 9);
});

test("resolvePrForIssue: a FORK PR cannot spoof the branch fast path (#76 adversarial regression)", () => {
  // Fork branch can be `pipeline/42-*` without closing #42 → must not match.
  const prs = [cand(13, "pipeline/42-spoofed", { fork: true })];
  assert.equal(resolvePrForIssue(prs, 42, TARGET_REPO), null);
});

test("resolvePrForIssue: a same-repo branch match still wins even with a fork PR present (#76)", () => {
  const prs = [cand(13, "pipeline/42-spoofed", { fork: true }), cand(9, "pipeline/42-real")];
  assert.equal(resolvePrForIssue(prs, 42, TARGET_REPO), 9);
});

test("resolvePrForIssue: branch prefix requires the trailing dash (no pipeline/420-* match for #42)", () => {
  assert.equal(resolvePrForIssue([cand(9, "pipeline/420-other-issue")], 42, TARGET_REPO), null);
});

test("resolvePrForIssue: falls back to closingIssuesReferences when no pipeline branch", () => {
  const prs = [cand(7, "feat/unrelated", { closes: [13] }), cand(9, "fix/other-work", { closes: [42, 50] })];
  assert.equal(resolvePrForIssue(prs, 42, TARGET_REPO), 9);
});

test("resolvePrForIssue: PR that merely mentions the issue number is NOT matched (#76 regression)", () => {
  // The original bug: a PR closing #20 but hard-coding "Fixes #42" in its body was
  // resolved as #42's PR. Body text plays no part — only closing references count.
  const prs = [cand(66, "fix/testgate-fixture", { closes: [20] })];
  assert.equal(resolvePrForIssue(prs, 42, TARGET_REPO), null);
});

test("resolvePrForIssue: cross-repo closing ref is not matched (#76 adversarial regression)", () => {
  // A PR in cfg.repo closes other/repo#42 — same number, different repo.
  const prs: PrCandidate[] = [
    {
      number: 11,
      headRefName: "feat/something",
      isCrossRepository: false,
      closingIssues: [{ number: 42, nameWithOwner: "other/repo" }],
    },
  ];
  assert.equal(resolvePrForIssue(prs, 42, TARGET_REPO), null);
});

test("resolvePrForIssue: returns null when no PR matches either strategy", () => {
  assert.equal(resolvePrForIssue([cand(7, "feat/unrelated")], 42, TARGET_REPO), null);
});

test("resolvePrForIssue: closing ref matches despite mixed casing in owner/repo (#76 review-2 regression)", () => {
  // GitHub owner/repo identifiers are case-insensitive; cfg.repo casing may differ
  // from the canonical casing closingIssuesReferences returns.
  const prs: PrCandidate[] = [
    {
      number: 11,
      headRefName: "feat/something",
      isCrossRepository: false,
      closingIssues: [{ number: 42, nameWithOwner: "owner/repo" }],
    },
  ];
  assert.equal(resolvePrForIssue(prs, 42, "Owner/Repo"), 11);
});

// ---------- selectPrForBranch (#175 adversarial regression) ----------

test("selectPrForBranch: returns same-repo PR with exact branch match", () => {
  const data = [
    { number: 10, headRefName: "pipeline/175-my-fix", isCrossRepository: false },
    { number: 11, headRefName: "pipeline/99-other", isCrossRepository: false },
  ];
  assert.equal(selectPrForBranch(data, "pipeline/175-my-fix"), 10);
});

test("selectPrForBranch: fork PR with identical headRefName is rejected (#175 adversarial regression)", () => {
  // A contributor fork can expose the same branch name; it must not be reused as the
  // pipeline's own PR (which would bind review at the wrong PR / wrong trust boundary).
  const data = [
    { number: 99, headRefName: "pipeline/175-my-fix", isCrossRepository: true },
  ];
  assert.equal(selectPrForBranch(data, "pipeline/175-my-fix"), null);
});

test("selectPrForBranch: same-repo PR wins when fork PR has same branch name (#175 adversarial regression)", () => {
  const data = [
    { number: 99, headRefName: "pipeline/175-my-fix", isCrossRepository: true },
    { number: 10, headRefName: "pipeline/175-my-fix", isCrossRepository: false },
  ];
  assert.equal(selectPrForBranch(data, "pipeline/175-my-fix"), 10);
});

test("selectPrForBranch: returns null when no PR matches the branch", () => {
  const data = [
    { number: 10, headRefName: "pipeline/99-other", isCrossRepository: false },
  ];
  assert.equal(selectPrForBranch(data, "pipeline/175-my-fix"), null);
});

// ---------- extractHumanPlanComments (#26) ----------

const PLAN_BODY = "## Implementation Plan\n\nDo the thing.";

test("extractHumanPlanComments: empty when all comments precede the plan comment", () => {
  const comments = [
    { author: "alice", body: "early thought", createdAt: "2026-06-01T00:00:00Z" },
    { author: "pipeline", body: PLAN_BODY, createdAt: "2026-06-02T00:00:00Z" },
  ];
  assert.deepEqual(extractHumanPlanComments(comments, PLAN_BODY), []);
});

test("extractHumanPlanComments: empty when only pipeline comments follow the plan", () => {
  // Includes the `## Pipeline: plan review` transition comment posted between
  // the plan and the reviewer feedback — it must not be read as human input.
  const comments = [
    { author: "bot", body: PLAN_BODY, createdAt: "2026-06-02T00:00:00Z" },
    { author: "bot", body: "## Pipeline: plan review\n\n...", createdAt: "2026-06-02T00:01:00Z" },
    { author: "bot", body: "## Plan Review\n\nlooks ok", createdAt: "2026-06-02T00:02:00Z" },
  ];
  assert.deepEqual(extractHumanPlanComments(comments, PLAN_BODY), []);
});

test("extractHumanPlanComments: returns human comments that follow the plan", () => {
  const comments = [
    { author: "bot", body: PLAN_BODY, createdAt: "2026-06-02T00:00:00Z" },
    { author: "bot", body: "## Pipeline: plan review", createdAt: "2026-06-02T00:01:00Z" },
    { author: "carol", body: "Please also handle the empty case.", createdAt: "2026-06-02T00:03:00Z" },
    { author: "bot", body: "## Plan Review\n\nok", createdAt: "2026-06-02T00:04:00Z" },
    { author: "dave", body: "Use the existing util instead.", createdAt: "2026-06-02T00:05:00Z" },
  ];
  assert.deepEqual(extractHumanPlanComments(comments, PLAN_BODY), [
    { author: "carol", body: "Please also handle the empty case." },
    { author: "dave", body: "Use the existing util instead." },
  ]);
});

test("extractHumanPlanComments: empty when no plan comment exists at all", () => {
  const comments = [
    { author: "alice", body: "random comment", createdAt: "2026-06-01T00:00:00Z" },
    { author: "bob", body: "another one", createdAt: "2026-06-02T00:00:00Z" },
  ];
  assert.deepEqual(extractHumanPlanComments(comments, PLAN_BODY), []);
});

// ---------------------------------------------------------------------------
// getIssueLabelEvents — latest-window fetch (#154 review-2 regression)
//
// The bug: the previous implementation read REST `issues/{n}/events?per_page=100`,
// which returns the OLDEST 100 events. On an issue with >100 events the current
// `pipeline:*` transition is excluded, so `last_event` goes stale/null. The fix
// fetches the LATEST window via GraphQL `timelineItems(last:100, LABELED_EVENT)`.
// ---------------------------------------------------------------------------

const LABEL_CFG = { repo: "accidental-hedge-fund/agent-pipeline" } as PipelineConfig;

test("getIssueLabelEvents: queries the LATEST bounded window, not page-1 REST events", async () => {
  let captured: string[] = [];
  const run: GhApiRunner = async (args) => {
    captured = args;
    return "";
  };
  await getIssueLabelEvents(LABEL_CFG, 154, run);
  const joined = captured.join(" ");
  // Must use the GraphQL latest-window query…
  assert.ok(captured.includes("graphql"), "must call the GraphQL endpoint");
  assert.ok(/timelineItems\(last:\s*100/.test(joined), "must request the LATEST 100 (last:100) window");
  assert.ok(joined.includes("LABELED_EVENT"), "must filter to labeled events");
  // …and must NOT use the old oldest-first page-1 REST scan.
  assert.ok(!/issues\/\d+\/events/.test(joined), "must not read the page-1 REST events endpoint");
  assert.ok(!joined.includes("per_page=100"), "must not use the page-1 per_page scan");
});

test("getIssueLabelEvents: newer pipeline label in the latest window is returned even when older events exceed the page size", async () => {
  // Simulate an issue whose total events exceed 100: the GraphQL last:100 window
  // returns only the most-recent labeled events, including the current transition.
  // (The old page-1 scan would have returned the oldest events and missed this.)
  const run: GhApiRunner = async () =>
    [
      JSON.stringify({ label: "pipeline:review-2", createdAt: "2026-06-16T20:55:42Z" }),
      JSON.stringify({ label: "pipeline:needs-human", createdAt: "2026-06-16T21:02:11Z" }),
    ].join("\n");
  const events = await getIssueLabelEvents(LABEL_CFG, 154, run);
  assert.equal(events.length, 2);
  // The newest pipeline label must be present so deriveLastEvent can surface it.
  const newest = events.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  assert.equal(newest.label, "pipeline:needs-human");
  assert.equal(newest.createdAt, "2026-06-16T21:02:11Z");
});

test("getIssueLabelEvents: a GitHub failure propagates (so the status JSON error envelope captures it)", async () => {
  const run: GhApiRunner = async () => {
    throw new Error("GraphQL: rate limited");
  };
  await assert.rejects(() => getIssueLabelEvents(LABEL_CFG, 154, run), /rate limited/);
});

// ---------------------------------------------------------------------------
// mapRawIssue (getOpenIssues pure parser, #171)
// ---------------------------------------------------------------------------

test("mapRawIssue: maps fields correctly for an open issue", () => {
  const raw = {
    number: 42,
    title: "Add dark mode",
    body: "As a user I want dark mode.",
    labels: [{ name: "enhancement" }, { name: "p2" }],
    url: "https://github.com/example/repo/issues/42",
    state: "OPEN",
    updatedAt: "2026-01-15T00:00:00Z",
  };
  const issue = mapRawIssue(raw);
  assert.equal(issue.number, 42);
  assert.equal(issue.title, "Add dark mode");
  assert.equal(issue.body, "As a user I want dark mode.");
  assert.deepEqual(issue.labels, ["enhancement", "p2"]);
  assert.equal(issue.state, "open");
  assert.equal(issue.updatedAt, "2026-01-15T00:00:00Z");
});

test("mapRawIssue: maps CLOSED state correctly", () => {
  const raw = {
    number: 1,
    title: "Old issue",
    body: "",
    labels: [],
    url: "https://github.com/example/repo/issues/1",
    state: "closed",
    updatedAt: undefined,
  };
  const issue = mapRawIssue(raw);
  assert.equal(issue.state, "closed");
});

test("mapRawIssue: handles null/undefined body gracefully", () => {
  const raw = {
    number: 5,
    title: "No body",
    body: null as unknown as string,
    labels: [],
    url: "https://github.com/example/repo/issues/5",
    state: "open",
    updatedAt: undefined,
  };
  const issue = mapRawIssue(raw);
  assert.equal(issue.body, "");
});

test("mapRawIssue: labels array is extracted from {name} objects", () => {
  const raw = {
    number: 7,
    title: "Labeled issue",
    body: "body",
    labels: [{ name: "bug" }, { name: "needs-triage" }],
    url: "",
    state: "open",
    updatedAt: undefined,
  };
  const issue = mapRawIssue(raw);
  assert.deepEqual(issue.labels, ["bug", "needs-triage"]);
});

// ---------------------------------------------------------------------------
// mapApiIssue (paginated getOpenIssues, finding #7 regression)
// The gh api repos/<repo>/issues endpoint returns snake_case fields and
// includes pull requests alongside issues. mapApiIssue must translate correctly.
// ---------------------------------------------------------------------------

test("mapApiIssue: maps html_url and updated_at correctly", () => {
  const raw: GhApiIssueRaw = {
    number: 42,
    title: "Add dark mode",
    body: "As a user I want dark mode.",
    labels: [{ name: "enhancement" }],
    html_url: "https://github.com/example/repo/issues/42",
    state: "open",
    updated_at: "2026-01-15T00:00:00Z",
  };
  const issue = mapApiIssue(raw);
  assert.equal(issue.number, 42);
  assert.equal(issue.url, "https://github.com/example/repo/issues/42", "url should map from html_url");
  assert.equal(issue.updatedAt, "2026-01-15T00:00:00Z", "updatedAt should map from updated_at");
  assert.equal(issue.state, "open");
  assert.deepEqual(issue.labels, ["enhancement"]);
});

test("mapApiIssue: handles null body gracefully", () => {
  const raw: GhApiIssueRaw = {
    number: 5,
    title: "No body",
    body: null,
    labels: [],
    html_url: "https://github.com/example/repo/issues/5",
    state: "open",
  };
  const issue = mapApiIssue(raw);
  assert.equal(issue.body, "");
});

test("mapApiIssue: pull_request field is present — caller must filter PRs", () => {
  // The GitHub API includes PRs under the issues endpoint. PRs have a pull_request field.
  // getOpenIssues filters them via raw.filter(r => !r.pull_request).
  // This test verifies mapApiIssue does NOT crash on a PR-shaped entry and that the
  // pull_request field is detectable for filtering.
  const pr: GhApiIssueRaw = {
    number: 100,
    title: "Add feature (PR)",
    body: "PR body",
    labels: [],
    html_url: "https://github.com/example/repo/pull/100",
    state: "open",
    pull_request: { url: "https://api.github.com/repos/example/repo/pulls/100" },
  };
  // The caller filters: raw.filter(r => !r.pull_request)
  assert.ok(pr.pull_request !== undefined, "PR entry should have pull_request field for filtering");
  // mapApiIssue itself maps correctly even for PRs (the filter happens before this call)
  const mapped = mapApiIssue(pr);
  assert.equal(mapped.number, 100);
});

// ---------------------------------------------------------------------------
// Multi-page pagination parsing regression (#171, finding 1 round 2)
// gh api --paginate without --slurp emits each page as a separate JSON array
// on stdout, producing "[...]\n[...]" which JSON.parse throws on.
// With --slurp, gh wraps all pages into [[page1...], [page2...]] which is valid
// JSON. The caller must .flat() before filtering PRs.
// ---------------------------------------------------------------------------

test("getOpenIssues pagination: --slurp output (array-of-arrays) round-trips via flat()+filter()", () => {
  const page1: GhApiIssueRaw[] = [
    { number: 1, title: "Issue one", body: "body", labels: [], html_url: "https://github.com/x/y/issues/1", state: "open" },
    { number: 2, title: "Issue two", body: "body", labels: [], html_url: "https://github.com/x/y/issues/2", state: "open" },
  ];
  const page2: GhApiIssueRaw[] = [
    { number: 3, title: "Issue three", body: "body", labels: [], html_url: "https://github.com/x/y/issues/3", state: "open" },
    // A PR entry that must be filtered out
    { number: 4, title: "A PR", body: "", labels: [], html_url: "https://github.com/x/y/pull/4", state: "open", pull_request: { url: "https://api.github.com/repos/x/y/pulls/4" } },
  ];

  // Simulate what gh api --paginate --slurp produces: [[...page1...], [...page2...]]
  const slurpedStdout = JSON.stringify([page1, page2]);

  // Verify the format is valid JSON (would throw without --slurp on multi-page responses)
  const parsed = JSON.parse(slurpedStdout) as GhApiIssueRaw[][];
  const flattened = parsed.flat();
  const issues = flattened.filter((r) => !r.pull_request).map(mapApiIssue);

  assert.equal(issues.length, 3, "should include all 3 issues across both pages");
  assert.equal(issues[0].number, 1);
  assert.equal(issues[1].number, 2);
  assert.equal(issues[2].number, 3);
});

test("getOpenIssues pagination: non-slurped multi-page JSON is invalid and JSON.parse throws", () => {
  // Without --slurp, gh api --paginate writes each page as a separate JSON array on stdout.
  const page1Json = JSON.stringify([{ number: 1, title: "A", body: "", labels: [], html_url: "u", state: "open" }]);
  const page2Json = JSON.stringify([{ number: 2, title: "B", body: "", labels: [], html_url: "u", state: "open" }]);
  const nonSlurpedStdout = page1Json + "\n" + page2Json;

  // This is what breaks without --slurp: two adjacent JSON documents are not valid JSON.
  assert.throws(
    () => JSON.parse(nonSlurpedStdout),
    "multi-page non-slurped stdout must throw on JSON.parse to document why --slurp is required",
  );
});

// ---------------------------------------------------------------------------
// createIssue / addIssueComment — shared gh.ts helpers (#256)
// ---------------------------------------------------------------------------

const GH_WRITE_CFG = {
  repo: "accidental-hedge-fund/agent-pipeline",
  repo_dir: "/tmp",
} as PipelineConfig;

test("createIssue: correct gh args and issue-number extraction", async () => {
  let capturedArgs: string[] = [];
  const fakeRun: GhApiRunner = async (args) => {
    capturedArgs = args;
    return "https://github.com/accidental-hedge-fund/agent-pipeline/issues/42\n";
  };
  const num = await createIssue(GH_WRITE_CFG, "My title", "My body", ["bug", "P2"], fakeRun);
  assert.equal(num, 42);
  assert.ok(capturedArgs.includes("issue"), "must use 'issue' subcommand");
  assert.ok(capturedArgs.includes("create"), "must use 'create' subcommand");
  assert.equal(capturedArgs[capturedArgs.indexOf("--title") + 1], "My title");
  assert.equal(capturedArgs[capturedArgs.indexOf("--body") + 1], "My body");
  assert.equal(capturedArgs[capturedArgs.indexOf("-R") + 1], GH_WRITE_CFG.repo);
  // Each label must appear after a --label flag.
  const labelIdxs = capturedArgs
    .map((a, i) => (a === "--label" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(labelIdxs.length, 2, "must pass one --label per label");
  assert.deepEqual(
    labelIdxs.map((i) => capturedArgs[i + 1]),
    ["bug", "P2"],
  );
});

test("createIssue: works with no labels", async () => {
  const fakeRun: GhApiRunner = async () =>
    "https://github.com/accidental-hedge-fund/agent-pipeline/issues/7\n";
  const num = await createIssue(GH_WRITE_CFG, "Title", "Body", [], fakeRun);
  assert.equal(num, 7);
});

test("createIssue: non-zero exit propagates as an error", async () => {
  const fakeRun: GhApiRunner = async () => {
    throw new Error("gh issue create failed: rate limit exceeded");
  };
  await assert.rejects(
    () => createIssue(GH_WRITE_CFG, "T", "B", [], fakeRun),
    /rate limit exceeded/,
  );
});

test("createIssue: unparseable url throws descriptive error", async () => {
  const fakeRun: GhApiRunner = async () => "not-a-url\n";
  await assert.rejects(
    () => createIssue(GH_WRITE_CFG, "T", "B", [], fakeRun),
    /could not parse issue number/,
  );
});

test("createIssue: timeout surfaces as an error rather than hanging", async () => {
  const fakeRun: GhApiRunner = async () => {
    throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
  };
  await assert.rejects(
    () => createIssue(GH_WRITE_CFG, "T", "B", [], fakeRun),
    /ETIMEDOUT/,
  );
});

test("addIssueComment: correct gh args", async () => {
  let capturedArgs: string[] = [];
  const fakeRun: GhApiRunner = async (args) => {
    capturedArgs = args;
    return "";
  };
  await addIssueComment(GH_WRITE_CFG, 99, "Hello world", fakeRun);
  assert.ok(capturedArgs.includes("issue"), "must use 'issue' subcommand");
  assert.ok(capturedArgs.includes("comment"), "must use 'comment' subcommand");
  assert.equal(capturedArgs[capturedArgs.indexOf("comment") + 1], "99");
  assert.equal(capturedArgs[capturedArgs.indexOf("--body") + 1], "Hello world");
  assert.equal(capturedArgs[capturedArgs.indexOf("-R") + 1], GH_WRITE_CFG.repo);
});

test("addIssueComment: non-zero exit propagates as an error", async () => {
  const fakeRun: GhApiRunner = async () => {
    throw new Error("gh issue comment failed: Not Found");
  };
  await assert.rejects(
    () => addIssueComment(GH_WRITE_CFG, 1, "body", fakeRun),
    /Not Found/,
  );
});

test("addIssueComment: timeout surfaces as an error rather than hanging", async () => {
  const fakeRun: GhApiRunner = async () => {
    throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
  };
  await assert.rejects(
    () => addIssueComment(GH_WRITE_CFG, 1, "body", fakeRun),
    /ETIMEDOUT/,
  );
});
