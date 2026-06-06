// Prompt loader: every template loads, placeholders substitute, unfilled
// placeholders fail loud.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDocsUpdatePrompt,
  buildFixPrompt,
  buildImplementingPrompt,
  buildPlanningOpenspecPrompt,
  buildPlanningPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
  substitute,
} from "../scripts/prompts/index.ts";
import type { PipelineConfig } from "../scripts/types.ts";

function dummyConfig(): PipelineConfig {
  return {
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_merge: false,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    domain_name: "Widget",
    domain_description: "the example widget service",
  };
}

test("substitute: simple replacement", () => {
  const out = substitute("hello {{name}}!", { name: "world" });
  assert.equal(out, "hello world!");
});

test("substitute: multiple occurrences and keys", () => {
  const out = substitute("{{a}} - {{b}} - {{a}}", { a: "1", b: "2" });
  assert.equal(out, "1 - 2 - 1");
});

test("substitute: throws on unfilled placeholder", () => {
  assert.throws(
    () => substitute("hello {{missing}}!", { other: "ok" }),
    /Unfilled prompt placeholder/,
  );
});

test("planning prompt: builds with all keys substituted", () => {
  const out = buildPlanningPrompt({
    cfg: dummyConfig(),
    issueNumber: 42,
    title: "Add feature X",
    body: "do the thing",
  });
  assert.match(out, /#42/);
  assert.match(out, /Add feature X/);
  assert.match(out, /do the thing/);
  assert.match(out, /Widget/); // domain_name
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("planning prompt: empty body becomes (no description)", () => {
  const out = buildPlanningPrompt({
    cfg: dummyConfig(),
    issueNumber: 1,
    title: "t",
    body: "",
  });
  assert.match(out, /\(no description\)/);
});

test("planning_openspec prompt: builds with all keys + OpenSpec guidance", () => {
  const out = buildPlanningOpenspecPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "Add feature Y",
    body: "spec it",
  });
  assert.match(out, /#7/);
  assert.match(out, /Add feature Y/);
  assert.match(out, /OpenSpec/);
  assert.match(out, /openspec\/changes/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("review_standard: injects OpenSpec spec context when provided", () => {
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    body: "b",
    plan: "p",
    diff: "d",
    specContext: "REQ: user must be able to log in",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /must be able to log in/);
});

test("review_standard: no spec section + no leftover placeholders when specContext absent", () => {
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    body: "b",
    plan: "p",
    diff: "d",
  });
  assert.doesNotMatch(out, /Intended Behavior/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("review_adversarial: injects OpenSpec spec context when provided", () => {
  const out = buildReviewAdversarialPrompt({
    cfg: dummyConfig(),
    issueNumber: 6,
    title: "t",
    body: "b",
    diff: "d",
    specContext: "REQ: tokens must expire",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /tokens must expire/);
});

test("plan_review prompt: includes plan, implementer, and reviewer", () => {
  const out = buildPlanReviewPrompt({
    cfg: dummyConfig(),
    issueNumber: 101,
    title: "Plan me",
    body: "Body",
    plan: "PLAN-CONTENT",
    implementer: "codex",
    reviewer: "claude",
  });
  assert.match(out, /PLAN-CONTENT/);
  assert.match(out, /codex/);
  assert.match(out, /claude/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("plan_revision prompt: includes review feedback", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 102,
    title: "Revise me",
    body: "Body",
    plan: "ORIGINAL-PLAN",
    feedback: "REVIEW-FEEDBACK",
    implementer: "claude",
    reviewer: "codex",
  });
  assert.match(out, /ORIGINAL-PLAN/);
  assert.match(out, /REVIEW-FEEDBACK/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("implementing prompt: includes plan", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 100,
    title: "Title",
    body: "Body",
    plan: "PLAN-CONTENT-XYZ",
  });
  assert.match(out, /PLAN-CONTENT-XYZ/);
});

test("review_standard: includes plan + diff and the JSON schema", () => {
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "T",
    body: "B",
    plan: "PLAN",
    diff: "diff --git a/x b/x\n+hello\n",
  });
  assert.match(out, /PLAN/);
  assert.match(out, /\+hello/);
  assert.match(out, /"verdict"/);
  assert.match(out, /"findings"/);
});

test("review_adversarial: omits review1 section when not provided", () => {
  const out = buildReviewAdversarialPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "T",
    body: "B",
    diff: "diff",
  });
  assert.doesNotMatch(out, /Review 1 Summary/);
});

test("review_adversarial: includes review1 section when provided", () => {
  const out = buildReviewAdversarialPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "T",
    body: "B",
    diff: "diff",
    review1Summary: "ROUND-ONE-SUMMARY",
  });
  assert.match(out, /Review 1 Summary/);
  assert.match(out, /ROUND-ONE-SUMMARY/);
});

test("fix prompt: round 1 = standard, round 2 = adversarial", () => {
  const r1 = buildFixPrompt({
    issueNumber: 5,
    title: "t",
    reviewFindings: "FINDINGS-X",
    fixRound: 1,
  });
  const r2 = buildFixPrompt({
    issueNumber: 5,
    title: "t",
    reviewFindings: "FINDINGS-X",
    fixRound: 2,
  });
  assert.match(r1, /standard/);
  assert.match(r2, /adversarial/);
  assert.match(r1, /FINDINGS-X/);
  assert.match(r2, /FINDINGS-X/);
});

test("docs_update prompt: contains diff", () => {
  const out = buildDocsUpdatePrompt({
    cfg: dummyConfig(),
    issueNumber: 99,
    title: "T",
    diff: "DIFF-CONTENT",
  });
  assert.match(out, /DIFF-CONTENT/);
});

test("review prompt: large diff is truncated", () => {
  const big = "x".repeat(60_000);
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 1,
    title: "t",
    body: "b",
    plan: "p",
    diff: big,
  });
  assert.match(out, /diff truncated at 50KB/);
});
