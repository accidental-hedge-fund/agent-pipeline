// Pure parser exports from gh.ts and stages/review.ts. No subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getHarnessLabel,
  isBlocked,
  parseChecksAggregate,
  parseMergeable,
  parsePrMergeState,
  pickStage,
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
