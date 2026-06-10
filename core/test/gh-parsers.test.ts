// Pure parser exports from gh.ts and stages/review.ts. No subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHumanPlanComments,
  getHarnessLabel,
  isBlocked,
  parseChecksAggregate,
  parseClosingIssueRefs,
  parseMergeable,
  parsePrMergeState,
  pickStage,
  resolvePrForIssue,
  type ClosingIssueRef,
} from "../scripts/gh.ts";
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
  // #16: the short SHA is visible in the header and the full SHA sentinel last.
  assert.match(md, /\(commit aaaaaaa\)/);
  assert.match(md, new RegExp(`<!-- reviewed-sha: ${"a".repeat(40)} -->\\s*$`));
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

// ---------- parseClosingIssueRefs (#76 regression) ----------

test("parseClosingIssueRefs: constructs nameWithOwner from owner.login + name (realistic gh payload)", () => {
  // gh pr view --json closingIssuesReferences emits repository { id, name, owner { id, login } },
  // NOT repository { nameWithOwner }. This test guards against silent drift.
  const ghPayload = JSON.stringify({
    closingIssuesReferences: [
      {
        number: 42,
        repository: {
          id: "R_kgDOAbc123",
          name: "repo",
          owner: { id: "O_kgDOXyz789", login: "owner" },
        },
      },
      {
        number: 7,
        repository: {
          id: "R_kgDODef456",
          name: "other-repo",
          owner: { id: "O_kgDOUvw012", login: "other-owner" },
        },
      },
    ],
  });
  const refs = parseClosingIssueRefs(ghPayload);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { number: 42, nameWithOwner: "owner/repo" });
  assert.deepEqual(refs[1], { number: 7, nameWithOwner: "other-owner/other-repo" });
});

test("parseClosingIssueRefs: returns empty array when field is absent", () => {
  assert.deepEqual(parseClosingIssueRefs("{}"), []);
});

// ---------- resolvePrForIssue (#76) ----------

const TARGET_REPO = "owner/repo";

function refs(...nums: number[]): ClosingIssueRef[] {
  return nums.map((n) => ({ number: n, nameWithOwner: TARGET_REPO }));
}

test("resolvePrForIssue: branch-prefix match returns the PR without fetching closing refs", async () => {
  let fetches = 0;
  const prs = [
    { number: 7, headRefName: "feat/unrelated" },
    { number: 9, headRefName: "pipeline/42-my-feature" },
  ];
  const result = await resolvePrForIssue(prs, 42, TARGET_REPO, async () => {
    fetches++;
    return [];
  });
  assert.equal(result, 9);
  assert.equal(fetches, 0);
});

test("resolvePrForIssue: branch prefix requires the trailing dash (no pipeline/420-* match for #42)", async () => {
  const prs = [{ number: 9, headRefName: "pipeline/420-other-issue" }];
  assert.equal(await resolvePrForIssue(prs, 42, TARGET_REPO, async () => []), null);
});

test("resolvePrForIssue: falls back to closingIssuesReferences when no pipeline branch", async () => {
  const prs = [
    { number: 7, headRefName: "feat/unrelated" },
    { number: 9, headRefName: "fix/other-work" },
  ];
  const closing: Record<number, ClosingIssueRef[]> = { 7: refs(13), 9: refs(42, 50) };
  assert.equal(
    await resolvePrForIssue(prs, 42, TARGET_REPO, async (n) => closing[n] ?? []),
    9,
  );
});

test("resolvePrForIssue: PR that merely mentions the issue number is NOT matched (#76 regression)", async () => {
  // The original bug: PR #66 closed #20 but hard-coded "issue 42" / "Fixes #42"
  // in its body (a unit-test fixture), and --status resolved it as #42's PR.
  // Body text plays no part in resolution — only closing references count.
  const prs = [
    {
      number: 66,
      headRefName: "fix/testgate-fixture",
      body: "Adds a unit-test fixture that hard-codes issue 42.\n\nFixes #42 appears here only as fixture text.",
    },
  ];
  assert.equal(await resolvePrForIssue(prs, 42, TARGET_REPO, async () => refs(20)), null);
});

test("resolvePrForIssue: cross-repo closing ref is not matched (#76 adversarial regression)", async () => {
  // A PR in cfg.repo closes other/repo#42 — the same number as our target issue
  // but in a different repository. Must not resolve as cfg.repo#42's PR.
  const prs = [{ number: 11, headRefName: "feat/something" }];
  const result = await resolvePrForIssue(prs, 42, TARGET_REPO, async () => [
    { number: 42, nameWithOwner: "other/repo" },
  ]);
  assert.equal(result, null);
});

test("resolvePrForIssue: returns null when no PR matches either strategy", async () => {
  const prs = [{ number: 7, headRefName: "feat/unrelated" }];
  assert.equal(await resolvePrForIssue(prs, 42, TARGET_REPO, async () => []), null);
});

test("resolvePrForIssue: closing ref matches despite mixed casing in owner/repo (#76 review-2 regression)", async () => {
  // GitHub owner/repo identifiers are case-insensitive; cfg.repo may have different
  // casing than what closingIssuesReferences returns (canonical GitHub casing).
  // e.g. cfg uses "Owner/Repo" but GitHub returns "owner/repo" in the API response.
  const prs = [{ number: 11, headRefName: "feat/something" }];
  const result = await resolvePrForIssue(prs, 42, "Owner/Repo", async () => [
    { number: 42, nameWithOwner: "owner/repo" },
  ]);
  assert.equal(result, 11);
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
