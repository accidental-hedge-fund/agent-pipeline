// Regression tests for implementation-step commit reference (#68, 4.1/4.2)
// and plan-revision acknowledgement section (#68, 4.10/4.11).
//
// Tests are against the exported gate functions, not the full `advance` chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceImplCommitRef, enforceOpenspecChangeSingular } from "../scripts/stages/planning.ts";
import { verifyPlanRevisionOutput } from "../scripts/verify-harness-commits.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Implementation step — issue reference (4.1 / 4.2)
// ---------------------------------------------------------------------------

test("impl: at least one commit contains issue reference → proceeds (4.2)", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement harness verification for #68\n",
  ]));
  assert.equal(result.ok, true);
});

test("impl: reference in commit body → proceeds", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement feature\n\nCloses #68",
  ]));
  assert.equal(result.ok, true);
});

test("impl: no commit references the issue → blocked (4.1)", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement feature\n",
    "add tests\n",
  ]));
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("#68"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("impl: empty commit range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

test("impl: wrong issue number in commits → blocked", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement feature for #99\n",
  ]));
  assert.equal(result.ok, false);
});

test("impl: multiple commits, only last references issue → proceeds", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "chore: setup\n",
    "feat: core logic\n",
    "feat: wire up and close #68\n",
  ]));
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Plan-revision acknowledgement section (4.10 / 4.11)
// ---------------------------------------------------------------------------

test("plan-revision ack: section present with ADDRESSED item → proceeds (4.11)", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] Added commit message format check",
    "",
    "## Revised Plan",
    "Here is the revised plan...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: section present with DEFERRED item → proceeds (4.11)", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [DEFERRED] Skipping trailer check — reason: no prompt currently asks for trailers",
    "",
    "## Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: section present with both items → proceeds", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] Added issue reference check",
    "- [DEFERRED] Refactoring out of scope — reason: separate issue",
    "",
    "## Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: section entirely absent → blocked (4.10)", () => {
  const result = verifyPlanRevisionOutput("## Revised Plan\n\nHere is the plan.");
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("## Feedback Incorporated"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("plan-revision ack: section present but no tagged items → blocked", () => {
  const result = verifyPlanRevisionOutput(
    "## Feedback Incorporated\n\nI considered the feedback carefully.\n\n## Plan\n...",
  );
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("[ADDRESSED]"));
});

test("plan-revision ack: empty output → blocked (4.10)", () => {
  const result = verifyPlanRevisionOutput("");
  assert.equal(result.ok, false);
});

test("plan-revision ack: lowercase section header accepted (case-insensitive)", () => {
  const stdout = "## feedback incorporated\n- [ADDRESSED] done\n## Plan\n...";
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: item with lowercase tag accepted (case-insensitive)", () => {
  const stdout = "## Feedback Incorporated\n- [addressed] done\n## Plan\n...";
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

// ---------------------------------------------------------------------------
// OpenSpec change singularity gate (finding 3)
// ---------------------------------------------------------------------------

test("openspec singularity: exactly one fresh change → ok (finding 3)", () => {
  const result = enforceOpenspecChangeSingular(["change-abc"], ["change-abc"]);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.changeId, "change-abc");
});

test("openspec singularity: multiple fresh changes → blocked (finding 3)", () => {
  const result = enforceOpenspecChangeSingular(
    ["change-abc", "change-def"],
    ["change-abc", "change-def"],
  );
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.reason.includes("2 new changes"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("openspec singularity: no fresh, single pre-existing change → ok (fallback)", () => {
  const result = enforceOpenspecChangeSingular([], ["change-abc"]);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.changeId, "change-abc");
});

test("openspec singularity: no fresh, no pre-existing → blocked", () => {
  const result = enforceOpenspecChangeSingular([], []);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("no openspec change"));
});

test("openspec singularity: no fresh, multiple pre-existing → blocked (ambiguous)", () => {
  const result = enforceOpenspecChangeSingular([], ["change-abc", "change-def"]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("no openspec change"));
});
