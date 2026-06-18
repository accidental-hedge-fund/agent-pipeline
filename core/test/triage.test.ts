// Tests for the `pipeline triage` sub-command (#216).
//
// All tests are network- and filesystem-free: I/O is injected via the
// TriageDeps seam. Each test proves the code bites (asserting on specific
// outcomes, call counts, and error messages).

import { test } from "node:test";
import assert from "node:assert/strict";
import { runTriage, type TriageDeps, type TriageInput } from "../scripts/stages/triage.ts";

// ---------------------------------------------------------------------------
// Fake deps factory
// ---------------------------------------------------------------------------

function makeDeps(
  labels: string[],
  overrides: Partial<TriageDeps> = {},
): TriageDeps & {
  _addCalls: Array<{ issueNumber: number; label: string }>;
  _removeCalls: Array<{ issueNumber: number; label: string }>;
  _logLines: string[];
} {
  const addCalls: Array<{ issueNumber: number; label: string }> = [];
  const removeCalls: Array<{ issueNumber: number; label: string }> = [];
  const logLines: string[] = [];

  const base: TriageDeps = {
    getIssueLabels: async (_issueNumber) => labels,
    addLabel: async (issueNumber, label) => {
      addCalls.push({ issueNumber, label });
    },
    removeLabel: async (issueNumber, label) => {
      removeCalls.push({ issueNumber, label });
    },
    log: (msg) => logLines.push(msg),
    ...overrides,
  };

  (base as unknown as { _addCalls: typeof addCalls })._addCalls = addCalls;
  (base as unknown as { _removeCalls: typeof removeCalls })._removeCalls = removeCalls;
  (base as unknown as { _logLines: typeof logLines })._logLines = logLines;
  return base as ReturnType<typeof makeDeps>;
}

// ---------------------------------------------------------------------------
// 4.1 Happy path — set ready from backlog
// ---------------------------------------------------------------------------

test("triage: sets pipeline:ready and removes pipeline:backlog", async () => {
  const deps = makeDeps(["pipeline:backlog", "bug"]);
  const input: TriageInput = { issueArg: "42", stage: "ready" };

  await runTriage(input, deps);

  assert.equal(deps._removeCalls.length, 1, "should remove exactly one label");
  assert.equal(deps._removeCalls[0].label, "pipeline:backlog");
  assert.equal(deps._removeCalls[0].issueNumber, 42);
  assert.equal(deps._addCalls.length, 1, "should add exactly one label");
  assert.equal(deps._addCalls[0].label, "pipeline:ready");
  assert.equal(deps._addCalls[0].issueNumber, 42);
});

// ---------------------------------------------------------------------------
// 4.2 Happy path — set backlog from ready
// ---------------------------------------------------------------------------

test("triage: sets pipeline:backlog and removes pipeline:ready", async () => {
  const deps = makeDeps(["pipeline:ready"]);
  const input: TriageInput = { issueArg: "10", stage: "backlog" };

  await runTriage(input, deps);

  assert.equal(deps._removeCalls.length, 1);
  assert.equal(deps._removeCalls[0].label, "pipeline:ready");
  assert.equal(deps._addCalls.length, 1);
  assert.equal(deps._addCalls[0].label, "pipeline:backlog");
});

// ---------------------------------------------------------------------------
// 4.3 Idempotent no-op: already set, no writes
// ---------------------------------------------------------------------------

test("triage: idempotent — already has pipeline:ready, no writes", async () => {
  const deps = makeDeps(["pipeline:ready", "enhancement"]);
  const input: TriageInput = { issueArg: "7", stage: "ready" };

  await runTriage(input, deps);

  assert.equal(deps._addCalls.length, 0, "should not call addLabel");
  assert.equal(deps._removeCalls.length, 0, "should not call removeLabel");
  const log = deps._logLines.join("\n");
  assert.ok(log.includes("already set"), "should log 'already set'");
  assert.ok(log.includes("pipeline:ready"), "should name the label");
});

// ---------------------------------------------------------------------------
// 4.4 Operator reset from mid-flight: pipeline:planning → pipeline:backlog
// ---------------------------------------------------------------------------

test("triage: removes pipeline:planning and adds pipeline:backlog", async () => {
  const deps = makeDeps(["pipeline:planning", "enhancement"]);
  const input: TriageInput = { issueArg: "99", stage: "backlog" };

  await runTriage(input, deps);

  assert.equal(deps._removeCalls.length, 1);
  assert.equal(deps._removeCalls[0].label, "pipeline:planning");
  assert.equal(deps._addCalls.length, 1);
  assert.equal(deps._addCalls[0].label, "pipeline:backlog");
});

// ---------------------------------------------------------------------------
// 4.5 Multiple pipeline:* labels (corrupted state) → cleaned up
// ---------------------------------------------------------------------------

test("triage: removes both pipeline:ready and pipeline:planning, adds pipeline:backlog", async () => {
  const deps = makeDeps(["pipeline:ready", "pipeline:planning"]);
  const input: TriageInput = { issueArg: "55", stage: "backlog" };

  await runTriage(input, deps);

  const removedLabels = deps._removeCalls.map((c) => c.label).sort();
  assert.deepEqual(removedLabels, ["pipeline:planning", "pipeline:ready"]);
  assert.equal(deps._addCalls.length, 1);
  assert.equal(deps._addCalls[0].label, "pipeline:backlog");
});

// ---------------------------------------------------------------------------
// 4.6 Error path — --stage planning rejected
// ---------------------------------------------------------------------------

test("triage: rejects --stage planning with a clear error, no writes", async () => {
  const deps = makeDeps([]);
  const input: TriageInput = { issueArg: "42", stage: "planning" };

  await assert.rejects(
    () => runTriage(input, deps),
    (err: Error) => {
      assert.ok(err.message.includes('"planning"'), "error should name the rejected stage");
      assert.ok(err.message.includes("backlog") && err.message.includes("ready"), "error should list allowed values");
      return true;
    },
  );
  assert.equal(deps._addCalls.length, 0, "should not call addLabel");
  assert.equal(deps._removeCalls.length, 0, "should not call removeLabel");
});

// ---------------------------------------------------------------------------
// 4.7 Error path — --stage review-2 rejected
// ---------------------------------------------------------------------------

test("triage: rejects --stage review-2 with a clear error, no writes", async () => {
  const deps = makeDeps([]);
  const input: TriageInput = { issueArg: "42", stage: "review-2" };

  await assert.rejects(
    () => runTriage(input, deps),
    (err: Error) => {
      assert.ok(err.message.includes('"review-2"'), "error should name the rejected stage");
      return true;
    },
  );
  assert.equal(deps._addCalls.length, 0);
  assert.equal(deps._removeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 4.8 Error path — missing --stage flag
// ---------------------------------------------------------------------------

test("triage: rejects missing --stage with a usage error", async () => {
  const deps = makeDeps([]);
  const input: TriageInput = { issueArg: "42", stage: undefined };

  await assert.rejects(
    () => runTriage(input, deps),
    (err: Error) => {
      assert.ok(err.message.includes("--stage"), "error should mention --stage");
      assert.ok(err.message.includes("required"), "error should say it is required");
      return true;
    },
  );
  assert.equal(deps._addCalls.length, 0);
  assert.equal(deps._removeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 4.9 Error path — non-numeric issue argument
// ---------------------------------------------------------------------------

test("triage: rejects non-numeric issue argument with a clear error", async () => {
  const deps = makeDeps([]);
  const input: TriageInput = { issueArg: "abc", stage: "ready" };

  await assert.rejects(
    () => runTriage(input, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("positive integer") || err.message.includes("abc"),
        "error should describe the problem",
      );
      return true;
    },
  );
  assert.equal(deps._addCalls.length, 0);
  assert.equal(deps._removeCalls.length, 0);
});
