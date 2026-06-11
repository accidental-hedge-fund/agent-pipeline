// Regression tests for fix-round commit message format verification (#68).
// Tests enforceFixCommitGate directly so the full advanceFix call chain (GitHub
// API, git, harness) does not need to be mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceFixCommitGate, extractAllReviewFindingsHistory } from "../scripts/stages/fix.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Cross-round finding history (1.0.1 convergence: stop the fixer reverting prior fixes)
// ---------------------------------------------------------------------------

const r2 = (n: number) => ({
  body: `## Review 2 (Adversarial) — needs-attention\n\n### Findings\n\nfinding ${n}`,
});

test("extractAllReviewFindingsHistory: empty when fewer than two matching rounds", () => {
  assert.equal(extractAllReviewFindingsHistory([], 2), "");
  assert.equal(extractAllReviewFindingsHistory([r2(1)], 2), "", "only the current round → no prior history");
  assert.equal(
    extractAllReviewFindingsHistory([{ body: "## Implementation Plan" }, r2(1)], 2),
    "",
  );
});

test("extractAllReviewFindingsHistory: joins prior rounds, excluding the most recent (current) one", () => {
  const out = extractAllReviewFindingsHistory([r2(1), r2(2), r2(3)], 2);
  assert.match(out, /Prior review 2 attempt 1/);
  assert.match(out, /Prior review 2 attempt 2/);
  assert.match(out, /finding 1/);
  assert.match(out, /finding 2/);
  assert.doesNotMatch(out, /finding 3/); // the latest is supplied verbatim as current findings
});

// ---------------------------------------------------------------------------
// Fix round 1 (4.3 / 4.4)
// ---------------------------------------------------------------------------

test("fix round 1: matching commit message → proceeds (ok)", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fix: address review 1 findings (#42)\n"]),
  );
  assert.equal(result.ok, true);
});

test("fix round 1: case-insensitive match → proceeds", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["Fix: Address Review 1 Findings (#42)\n"]),
  );
  assert.equal(result.ok, true);
});

test("fix round 1: non-matching commit message → blocked (4.3)", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fixed stuff\n"]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("Fix round 1 commit message does not match prescribed format"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("fix round 1: completely unrelated commit message → blocked", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["feat: add new feature (#42)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 1: empty commit range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await enforceFixCommitGate(1, 42, "/wt", "abc", msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

test("fix round 1: correct format for wrong round number → blocked", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fix: address review 2 findings (#42)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 1: wrong issue number → blocked", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fix: address review 1 findings (#99)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 1: multiple commits — at least one matches → proceeds", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps([
      "chore: minor cleanup\n",
      "fix: address review 1 findings (#42)\n",
    ]),
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Fix round 2 (4.3 / 4.4 equivalent)
// ---------------------------------------------------------------------------

test("fix round 2: matching commit message → proceeds (4.4)", async () => {
  const result = await enforceFixCommitGate(
    2, 7, "/wt", "abc",
    msgsDeps(["fix: address review 2 findings (#7)\n"]),
  );
  assert.equal(result.ok, true);
});

test("fix round 2: round 1 message → blocked for round 2", async () => {
  const result = await enforceFixCommitGate(
    2, 7, "/wt", "abc",
    msgsDeps(["fix: address review 1 findings (#7)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 2: non-matching message → blocked (4.3)", async () => {
  const result = await enforceFixCommitGate(
    2, 7, "/wt", "abc",
    msgsDeps(["wip: fixing things\n"]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("Fix round 2 commit message does not match prescribed format"),
  );
});
