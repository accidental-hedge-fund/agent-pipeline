// Regression tests for fix-round commit message format verification (#68) and
// OpenSpec spec-delta validation (#106). Tests enforceFixCommitGate and
// enforceOpenspecSpecDeltaValidation directly so the full advanceFix call chain
// (GitHub API, git, harness) does not need to be mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceFixCommitGate, enforceOpenspecSpecDeltaValidation } from "../scripts/stages/fix.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";
import type { ValidateResult } from "../scripts/openspec.ts";

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

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

// ---------------------------------------------------------------------------
// enforceOpenspecSpecDeltaValidation — spec-delta validation gate (#106)
// ---------------------------------------------------------------------------

function makeValidateDeps(opts: {
  changedFiles: string[];
  validateResult?: ValidateResult;
}): {
  gitDiffFiles: (wt: string, from: string, to: string) => Promise<string[]>;
  openspecValidateItem: (wt: string, id: string) => Promise<ValidateResult>;
  validateCalls: string[];
} {
  const validateCalls: string[] = [];
  return {
    gitDiffFiles: async () => opts.changedFiles,
    openspecValidateItem: async (_wt, id) => {
      validateCalls.push(id);
      return opts.validateResult ?? { valid: true, issues: [], unavailable: false, raw: "" };
    },
    validateCalls,
  };
}

test("enforceOpenspecSpecDeltaValidation: no spec files changed → ok, validateItem not called", async () => {
  const deps = makeValidateDeps({ changedFiles: ["core/scripts/foo.ts", "plugin/scripts/foo.ts"] });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.validateCalls, [], "validateItem must not be called when no spec files changed");
});

test("enforceOpenspecSpecDeltaValidation: spec files changed + validation passes → ok", async () => {
  const deps = makeValidateDeps({
    changedFiles: [
      "core/scripts/foo.ts",
      "openspec/changes/c106/specs/cap/spec.md",
    ],
    validateResult: { valid: true, issues: [], unavailable: false, raw: "" },
  });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.validateCalls, ["c106"], "validateItem must be called for the changed change");
});

test("enforceOpenspecSpecDeltaValidation: spec files changed + validation fails → blocked", async () => {
  const deps = makeValidateDeps({
    changedFiles: ["openspec/changes/c106/specs/cap/spec.md"],
    validateResult: {
      valid: false,
      issues: [{ message: "Requirement is missing SHALL keyword" }],
      unavailable: false,
      raw: "Requirement is missing SHALL keyword",
    },
  });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.reason.includes("c106"),
    "block reason must name the failing change",
  );
  assert.ok(
    !result.ok && result.reason.includes("SHALL"),
    "block reason must include the validation issue",
  );
});

test("enforceOpenspecSpecDeltaValidation: validation unavailable (binary missing) → ok (non-blocking)", async () => {
  const deps = makeValidateDeps({
    changedFiles: ["openspec/changes/c106/specs/cap/spec.md"],
    validateResult: { valid: false, issues: [], unavailable: true, raw: "openspec not found" },
  });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, true, "missing openspec binary must not block the fix round");
});

test("enforceOpenspecSpecDeltaValidation: headBefore === headAfter → ok without calling validateItem", async () => {
  const deps = makeValidateDeps({ changedFiles: ["openspec/changes/c106/specs/cap/spec.md"] });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "same", "same", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.validateCalls, [], "no diff when SHAs are equal");
});
