// Shared ship-release-check-wait classifier + wait loop (#1205).
// Injected gh/clock only — no live network, git, or Actions.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  attemptCountFor,
  classifyReleaseChecks,
  emptyRerunBudgetDoc,
  PR_CHECKS_JSON_FIELDS,
  waitForReleasePrChecks,
  withRecordedAttempt,
  ShipReleaseCheckWaitError,
  type ReleaseCheckCapture,
  type ShipReleaseCheckWaitDeps,
} from "../scripts/stages/ship-release-check-wait.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_FAIL_LINK = "https://github.com/o/r/actions/runs/32075787450";

function classify(checks: ReleaseCheckCapture[], extra: Parameters<typeof classifyReleaseChecks>[1] = {}) {
  return classifyReleaseChecks(checks, extra);
}

test("classifyReleaseChecks: all passing checks are green", () => {
  assert.equal(
    classify([
      { name: "test", state: "SUCCESS", bucket: "pass" },
      { name: "lint", state: "SUCCESS", bucket: "pass" },
    ]).outcome,
    "green",
  );
});

test("classifyReleaseChecks: empty capture is green", () => {
  assert.equal(classify([]).outcome, "green");
});

test("classifyReleaseChecks: pending is pending-first over the whole set", () => {
  assert.equal(
    classify([{ name: "test", state: "PENDING", bucket: "pending" }]).outcome,
    "pending",
  );
  assert.equal(
    classify([{ name: "test", state: "QUEUED", bucket: "pending" }]).outcome,
    "pending",
  );
  assert.equal(
    classify([
      { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
      { name: "lint", state: "PENDING", bucket: "pending" },
    ]).outcome,
    "pending",
  );
  assert.equal(
    classify([
      { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
      { name: "lint", state: "IN_PROGRESS", bucket: "pending" },
    ]).outcome,
    "pending",
  );
});

test("classifyReleaseChecks: sole test fail with run id is rerun", () => {
  const result = classify(
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
    { pr: 1109, remaining: 1 },
  );
  assert.equal(result.outcome, "rerun");
  assert.equal(result.sidecar?.run_id, "32075787450");
  assert.match(String(result.sidecar?.reason), /PR #1109/);
});

test("classifyReleaseChecks: non-test product fail is fail with no rerun", () => {
  const result = classify(
    [{ name: "release-build", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
    { pr: 1109, remaining: 1 },
  );
  assert.equal(result.outcome, "fail");
  assert.equal(result.sidecar?.check_name, "release-build");
  assert.match(String(result.sidecar?.reason), /non-flake product fail/);
});

test("classifyReleaseChecks: mixed test fail and product fail is fail", () => {
  const result = classify([
    { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
    { name: "release-build", state: "FAILURE", bucket: "fail", link: "https://github.com/o/r/actions/runs/1" },
  ], { remaining: 1 });
  assert.equal(result.outcome, "fail");
  assert.equal(result.sidecar?.check_name, "release-build");
  assert.match(String(result.sidecar?.reason), /mixed flake and product fail/);
});

test("classifyReleaseChecks: test fail without run id is fail", () => {
  assert.equal(
    classify([{ name: "test", state: "FAILURE", bucket: "fail" }], { remaining: 1 }).outcome,
    "fail",
  );
});

test("classifyReleaseChecks: budget spent on test fail is fail", () => {
  const result = classify(
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
    { pr: 1109, remaining: 0 },
  );
  assert.equal(result.outcome, "fail");
  assert.match(String(result.sidecar?.reason), /rerun budget spent/);
});

test("classifyReleaseChecks: does not read a conclusion field", () => {
  // Pass bucket/state with a misleading conclusion must stay green.
  assert.equal(
    classify([
      {
        name: "test",
        state: "SUCCESS",
        bucket: "pass",
        ...{ conclusion: "FAILURE" },
      } as ReleaseCheckCapture,
    ]).outcome,
    "green",
  );
  // Fail-only-in-conclusion with empty bucket/state is not a fail.
  assert.equal(
    classify([
      {
        name: "test",
        state: "",
        bucket: "",
        ...{ conclusion: "FAILURE" },
      } as ReleaseCheckCapture,
    ]).outcome,
    "green",
  );
});

test("classifyReleaseChecks source never reads conclusion", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../scripts/stages/ship-release-check-wait.ts"),
    "utf8",
  );
  const start = src.indexOf("export function classifyReleaseChecks");
  const next = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, next === -1 ? src.length : next);
  assert.doesNotMatch(body, /conclusion/);
  assert.deepEqual([...PR_CHECKS_JSON_FIELDS], ["name", "state", "bucket", "link"]);
});

test("getPrChecks field set includes name,state,bucket,link and not conclusion", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../scripts/gh.ts"),
    "utf8",
  );
  const start = src.indexOf("export async function getPrChecks");
  const next = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, next === -1 ? src.length : next);
  assert.match(body, /name,state,bucket,/);
  assert.match(body, /link/);
  assert.doesNotMatch(body, /conclusion/);
});

function memoryBudget() {
  let doc = emptyRerunBudgetDoc();
  return {
    async loadAttemptCount(pr: number, headSha: string) {
      return attemptCountFor(doc, pr, headSha);
    },
    async recordAttempt(pr: number, headSha: string, runId: string) {
      doc = withRecordedAttempt(doc, pr, headSha, runId, "2026-08-21T00:00:00.000Z");
    },
    snapshot() {
      return doc;
    },
  };
}

function waitDeps(over: Partial<ShipReleaseCheckWaitDeps> & {
  getPrChecks: ShipReleaseCheckWaitDeps["getPrChecks"];
}): ShipReleaseCheckWaitDeps {
  const budget = memoryBudget();
  return {
    rerunFailedWorkflows: async () => ({ attempted: true, runIds: ["32075787450"] }),
    sleep: async () => {},
    loadAttemptCount: budget.loadAttemptCount,
    recordAttempt: budget.recordAttempt,
    maxAttempts: 3,
    intervalMs: 0,
    rerunBudget: 1,
    ...over,
  };
}

test("waitForReleasePrChecks: pending does not request rerun or return green", async () => {
  const polls: number[] = [];
  let reruns = 0;
  await assert.rejects(
    () => waitForReleasePrChecks({
      pr: 945,
      headSha: "b".repeat(40),
      deps: waitDeps({
        maxAttempts: 2,
        getPrChecks: async () => {
          polls.push(1);
          return [{ name: "test", state: "PENDING", bucket: "pending" }];
        },
        rerunFailedWorkflows: async () => {
          reruns++;
          return { attempted: true, runIds: ["1"] };
        },
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "pending");
      assert.match(err.message, /still pending/);
      assert.match(err.message, /retry the same ship command/);
      return true;
    },
  );
  assert.equal(polls.length, 2);
  assert.equal(reruns, 0);
});

test("waitForReleasePrChecks: flake-eligible test fail requests rerun before a second wait", async () => {
  const calls: string[] = [];
  const polls: ReleaseCheckCapture[][] = [
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
    [{ name: "test", state: "PENDING", bucket: "pending" }],
  ];
  await assert.rejects(
    () => waitForReleasePrChecks({
      pr: 945,
      headSha: "b".repeat(40),
      deps: waitDeps({
        maxAttempts: 2,
        getPrChecks: async () => {
          calls.push("checks");
          return polls.shift() ?? [{ name: "test", state: "PENDING", bucket: "pending" }];
        },
        rerunFailedWorkflows: async () => {
          calls.push("rerun");
          return { attempted: true, runIds: ["32075787450"] };
        },
        sleep: async () => {
          calls.push("sleep");
        },
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "pending");
      return true;
    },
  );
  assert.deepEqual(calls, ["checks", "rerun", "sleep", "checks"]);
});

test("waitForReleasePrChecks: missing run id fails closed without looping", async () => {
  let polls = 0;
  let reruns = 0;
  await assert.rejects(
    () => waitForReleasePrChecks({
      pr: 945,
      headSha: "b".repeat(40),
      deps: waitDeps({
        maxAttempts: 5,
        getPrChecks: async () => {
          polls++;
          return [{ name: "test", state: "FAILURE", bucket: "fail" }];
        },
        rerunFailedWorkflows: async () => {
          reruns++;
          return { attempted: true, runIds: ["1"] };
        },
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "fail");
      assert.match(err.message, /no workflow run id/);
      return true;
    },
  );
  assert.equal(polls, 1);
  assert.equal(reruns, 0);
});

test("waitForReleasePrChecks: failed rerun request is fail without looping", async () => {
  let polls = 0;
  await assert.rejects(
    () => waitForReleasePrChecks({
      pr: 945,
      headSha: "b".repeat(40),
      deps: waitDeps({
        maxAttempts: 5,
        getPrChecks: async () => {
          polls++;
          return [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }];
        },
        rerunFailedWorkflows: async () => ({
          attempted: false,
          runIds: ["32075787450"],
          reason: "re-run failed: denied",
        }),
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "fail");
      assert.match(err.message, /rerun failed/);
      return true;
    },
  );
  assert.equal(polls, 1);
});

test("waitForReleasePrChecks: green after wait returns without fail", async () => {
  const polls = [
    [{ name: "test", state: "PENDING", bucket: "pending" }],
    [{ name: "test", state: "SUCCESS", bucket: "pass" }],
  ];
  await waitForReleasePrChecks({
    pr: 945,
    headSha: "b".repeat(40),
    deps: waitDeps({
      maxAttempts: 5,
      getPrChecks: async () => polls.shift() ?? [{ name: "test", state: "SUCCESS", bucket: "pass" }],
    }),
  });
  assert.equal(polls.length, 0);
});

test("waitForReleasePrChecks: second test fail after budget is terminal", async () => {
  const budget = memoryBudget();
  const polls = [
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
  ];
  let reruns = 0;
  await assert.rejects(
    () => waitForReleasePrChecks({
      pr: 945,
      headSha: "b".repeat(40),
      deps: waitDeps({
        maxAttempts: 5,
        loadAttemptCount: budget.loadAttemptCount,
        recordAttempt: budget.recordAttempt,
        getPrChecks: async () => polls.shift() ?? [],
        rerunFailedWorkflows: async () => {
          reruns++;
          return { attempted: true, runIds: ["32075787450"] };
        },
      }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "fail");
      assert.match(err.message, /rerun budget spent/);
      return true;
    },
  );
  assert.equal(reruns, 1);
  assert.equal(attemptCountFor(budget.snapshot(), 945, "b".repeat(40)), 1);
});

test("in-engine ship-adapter adopts the shared waiter (Tugboat is not the only implementation)", () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, "../scripts/stages/ship-adapter.ts"),
    "utf8",
  );
  const start = adapter.indexOf("async convergeReleaseFinish");
  assert.ok(start !== -1, "convergeReleaseFinish must exist");
  const next = adapter.indexOf("\n    async ", start + 1);
  const body = adapter.slice(start, next === -1 ? adapter.length : next);
  const waitIdx = body.indexOf("waitForReleasePrChecks");
  const finishIdx = body.indexOf("operations.finishRelease");
  assert.ok(waitIdx !== -1, "convergeReleaseFinish must call waitForReleasePrChecks");
  assert.ok(finishIdx !== -1, "convergeReleaseFinish must still call finishRelease");
  assert.ok(waitIdx < finishIdx, "waiter must run before finishRelease");
  assert.match(body, /existing\?\.finish/, "already-finished observation must skip wait");
});
