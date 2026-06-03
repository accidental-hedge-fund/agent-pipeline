import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCodeReviewCommand, parseTextVerdict } from "../scripts/stages/review.ts";

test("buildClaudeCodeReviewCommand: review-1 uses Claude Code standard review companion", () => {
  const command = buildClaudeCodeReviewCommand(
    { base_branch: "main" },
    1,
    { model: "sonnet", companionPath: "/tmp/claude-companion.mjs" },
  );

  assert.equal(command.cmd, "node");
  assert.equal(command.label, "$cc:review");
  assert.deepEqual(command.args, [
    "/tmp/claude-companion.mjs",
    "review",
    "--view-state",
    "on-success",
    "--scope",
    "branch",
    "--base",
    "main",
    "--model",
    "sonnet",
  ]);
});

test("buildClaudeCodeReviewCommand: review-2 uses Claude Code adversarial review companion", () => {
  const command = buildClaudeCodeReviewCommand(
    { base_branch: "staging" },
    2,
    {
      model: "opus",
      focusText: "challenge rollback safety",
      companionPath: "/tmp/claude-companion.mjs",
    },
  );

  assert.equal(command.label, "$cc:adversarial-review");
  assert.deepEqual(command.args, [
    "/tmp/claude-companion.mjs",
    "adversarial-review",
    "--view-state",
    "on-success",
    "--scope",
    "branch",
    "--base",
    "staging",
    "--model",
    "opus",
    "challenge rollback safety",
  ]);
});

test("parseTextVerdict: Claude Code no-finding language approves", () => {
  assert.equal(parseTextVerdict("# Claude Code Review\n\nNo material findings."), "approve");
  assert.equal(parseTextVerdict("No issues found in the branch diff."), "approve");
});
