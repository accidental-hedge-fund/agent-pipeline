import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanionReviewCommand, parseTextVerdict, reviewerLabel } from "../scripts/stages/review.ts";

test("buildCompanionReviewCommand: claude-companion review-1 → $cc:review (view-state + Claude model)", () => {
  const command = buildCompanionReviewCommand(
    "claude-companion",
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

test("buildCompanionReviewCommand: claude-companion review-2 → $cc:adversarial-review (focus text last)", () => {
  const command = buildCompanionReviewCommand(
    "claude-companion",
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

test("buildCompanionReviewCommand: codex-companion review-1 → /codex:review (no view-state, no model)", () => {
  // codex-companion's native review rejects unknown flags (parsed as focus text)
  // and takes no Claude model name, so neither --view-state nor --model is sent
  // even though a model is supplied.
  const command = buildCompanionReviewCommand(
    "codex-companion",
    { base_branch: "main" },
    1,
    { model: "opus", companionPath: "/tmp/codex-companion.mjs" },
  );

  assert.equal(command.cmd, "node");
  assert.equal(command.label, "/codex:review");
  assert.deepEqual(command.args, [
    "/tmp/codex-companion.mjs",
    "review",
    "--scope",
    "branch",
    "--base",
    "main",
  ]);
});

test("buildCompanionReviewCommand: codex-companion review-2 → /codex:adversarial-review (focus last, still no model)", () => {
  const command = buildCompanionReviewCommand(
    "codex-companion",
    { base_branch: "main" },
    2,
    {
      model: "opus",
      focusText: "challenge rollback safety",
      companionPath: "/tmp/codex-companion.mjs",
    },
  );

  assert.equal(command.label, "/codex:adversarial-review");
  assert.deepEqual(command.args, [
    "/tmp/codex-companion.mjs",
    "adversarial-review",
    "--scope",
    "branch",
    "--base",
    "main",
    "challenge rollback safety",
  ]);
});

test("buildCompanionReviewCommand: PIPELINE_CODEX_COMPANION overrides the default path", () => {
  const prev = process.env.PIPELINE_CODEX_COMPANION;
  process.env.PIPELINE_CODEX_COMPANION = "/env/codex-companion.mjs";
  try {
    const command = buildCompanionReviewCommand("codex-companion", { base_branch: "main" }, 1);
    assert.equal(command.args[0], "/env/codex-companion.mjs");
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_CODEX_COMPANION;
    else process.env.PIPELINE_CODEX_COMPANION = prev;
  }
});

test("buildCompanionReviewCommand: codex-companion resolves to a codex-companion.mjs path when nothing is overridden", () => {
  const prev = process.env.PIPELINE_CODEX_COMPANION;
  delete process.env.PIPELINE_CODEX_COMPANION;
  try {
    const command = buildCompanionReviewCommand("codex-companion", { base_branch: "main" }, 1);
    // first existing candidate, else the first candidate as a fallback — either ends in the script name
    assert.match(command.args[0], /codex-companion\.mjs$/);
  } finally {
    if (prev !== undefined) process.env.PIPELINE_CODEX_COMPANION = prev;
  }
});

test("buildCompanionReviewCommand: claude-companion resolves to a claude-companion.mjs path when nothing is overridden", () => {
  const prev = process.env.PIPELINE_CC_COMPANION;
  delete process.env.PIPELINE_CC_COMPANION;
  try {
    const command = buildCompanionReviewCommand("claude-companion", { base_branch: "main" }, 1);
    assert.match(command.args[0], /claude-companion\.mjs$/);
  } finally {
    if (prev !== undefined) process.env.PIPELINE_CC_COMPANION = prev;
  }
});

test("reviewerLabel: reflects the configured review mode", () => {
  assert.equal(
    reviewerLabel({ review_mode: "codex-companion", harnesses: { implementer: "claude", reviewer: "codex" } }),
    "Codex (/codex:review + /codex:adversarial-review)",
  );
  assert.equal(
    reviewerLabel({ review_mode: "claude-companion", harnesses: { implementer: "codex", reviewer: "claude" } }),
    "Claude Code ($cc:review + $cc:adversarial-review)",
  );
  assert.equal(
    reviewerLabel({ review_mode: "prompt-harness", harnesses: { implementer: "claude", reviewer: "codex" } }),
    "codex",
  );
});

test("parseTextVerdict: Claude Code no-finding language approves", () => {
  assert.equal(parseTextVerdict("# Claude Code Review\n\nNo material findings."), "approve");
  assert.equal(parseTextVerdict("No issues found in the branch diff."), "approve");
});
