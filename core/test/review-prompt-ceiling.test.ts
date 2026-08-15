// Pure helper tests for review prompt character ceiling (#1054).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkReviewPromptSize,
  DEFAULT_REVIEW_PROMPT_CHAR_CEILING,
  formatReviewPromptTooLargeReason,
  resolveReviewPromptCharCeiling,
} from "../scripts/review-prompt-ceiling.ts";

test("resolveReviewPromptCharCeiling: missing → Codex default 1048576", () => {
  assert.equal(resolveReviewPromptCharCeiling(undefined), DEFAULT_REVIEW_PROMPT_CHAR_CEILING);
  assert.equal(resolveReviewPromptCharCeiling(null), DEFAULT_REVIEW_PROMPT_CHAR_CEILING);
  assert.equal(DEFAULT_REVIEW_PROMPT_CHAR_CEILING, 1_048_576);
});

test("resolveReviewPromptCharCeiling: unlimited / unknown → Codex default", () => {
  assert.equal(resolveReviewPromptCharCeiling("unlimited"), 1_048_576);
  assert.equal(resolveReviewPromptCharCeiling("unknown"), 1_048_576);
});

test("resolveReviewPromptCharCeiling: finite declared max is used", () => {
  assert.equal(resolveReviewPromptCharCeiling(131_071), 131_071);
  assert.equal(resolveReviewPromptCharCeiling(10), 10);
});

test("resolveReviewPromptCharCeiling: non-positive / non-integer finite values fall back", () => {
  assert.equal(resolveReviewPromptCharCeiling(0), 1_048_576);
  assert.equal(resolveReviewPromptCharCeiling(-1), 1_048_576);
  assert.equal(resolveReviewPromptCharCeiling(1.5), 1_048_576);
});

test("checkReviewPromptSize: under ceiling → ok", () => {
  const check = checkReviewPromptSize("hello", 10);
  assert.equal(check.ok, true);
  assert.equal(check.measured, 5);
  assert.equal(check.ceiling, 10);
});

test("checkReviewPromptSize: exactly at ceiling → ok", () => {
  const check = checkReviewPromptSize("12345", 5);
  assert.equal(check.ok, true);
  assert.equal(check.measured, 5);
});

test("checkReviewPromptSize: over ceiling → not ok with measured/ceiling", () => {
  const check = checkReviewPromptSize("123456", 5);
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.equal(check.measured, 6);
    assert.equal(check.ceiling, 5);
  }
});

test("checkReviewPromptSize: default Codex ceiling boundary", () => {
  const under = "x".repeat(1_048_576);
  const over = "x".repeat(1_048_577);
  assert.equal(checkReviewPromptSize(under, 1_048_576).ok, true);
  assert.equal(checkReviewPromptSize(over, 1_048_576).ok, false);
});

test("formatReviewPromptTooLargeReason names round, measured, and ceiling", () => {
  const reason = formatReviewPromptTooLargeReason(1, 1_356_383, 1_048_576);
  assert.match(reason, /review-1/);
  assert.match(reason, /measured=1356383/);
  assert.match(reason, /ceiling=1048576/);
  assert.match(reason, /will fail again/);
  assert.ok(!reason.includes("re-run as-is"));
});
