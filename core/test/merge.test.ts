// Tests for the `pipeline merge` sub-command (#217).
//
// All tests are network- and subprocess-free: I/O is injected via the MergeDeps seam.
// The loop-isolation test (last group) asserts that no stage handler imports or
// references any symbol from merge.ts, preserving the never-auto-merge invariant.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mergePr, type MergeDeps } from "../scripts/stages/merge.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGES_DIR = path.join(__dirname, "..", "scripts", "stages");
const PIPELINE_TS = path.join(__dirname, "..", "scripts", "pipeline.ts");
const PIPELINE_SCRIPT = path.join(__dirname, "..", "scripts", "pipeline.ts");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type StatusCheck = {
  name: string;
  status: string;
  conclusion: string | null;
};

function makeDeps(overrides: Partial<MergeDeps> = {}): MergeDeps & {
  mergeCalls: number[];
} {
  const mergeCalls: number[] = [];
  const base: MergeDeps = {
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
        ] satisfies StatusCheck[],
      };
    },
    async ghPrMerge(pr) {
      mergeCalls.push(pr);
    },
    async getIssueLabels(_issueNumber) {
      return ["pipeline:ready-to-deploy"];
    },
    async getPrLinkedIssue(_pr) {
      return 100;
    },
    // By default, getPrForIssue confirms issue #100 maps to PR #42 (the default test PR)
    async getPrForIssue(_issueNumber) {
      return 42;
    },
    log(_msg) {},
    ...overrides,
  };
  return Object.assign(base, { mergeCalls });
}

// ---------------------------------------------------------------------------
// 4.1 Happy path
// ---------------------------------------------------------------------------

test("merge: happy path — mergeable/clean/passing PR at ready-to-deploy succeeds", async () => {
  const deps = makeDeps();
  await mergePr(42, deps);
  assert.deepEqual(deps.mergeCalls, [42], "ghPrMerge should be called exactly once with the PR number");
});

// ---------------------------------------------------------------------------
// 4.2 Conflicted PR is refused
// ---------------------------------------------------------------------------

test("merge: conflicted PR — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("CONFLICTING"), `expected CONFLICTING in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.3 Dirty mergeStateStatus is refused
// ---------------------------------------------------------------------------

test("merge: dirty mergeStateStatus — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("DIRTY"), `expected DIRTY in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.4 Unknown mergeability is refused
// ---------------------------------------------------------------------------

test("merge: unknown mergeability — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        statusCheckRollup: [],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("UNKNOWN"), `expected UNKNOWN in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.5 Failing required check is refused
// ---------------------------------------------------------------------------

test("merge: failing required check — refuses, names the check, and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "build", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
        ] satisfies StatusCheck[],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("build"), `expected failing check name in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.6 Pending required check is refused
// ---------------------------------------------------------------------------

test("merge: pending required check — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "slow-ci", status: "IN_PROGRESS", conclusion: null },
        ] satisfies StatusCheck[],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("slow-ci"), `expected pending check name in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.7 Wrong issue stage is refused
// ---------------------------------------------------------------------------

test("merge: linked issue at wrong stage — refuses, names the stage, and does not merge", async () => {
  const deps = makeDeps({
    async getIssueLabels(_issueNumber) {
      return ["pipeline:review-2"];
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("pipeline:review-2"),
        `expected current stage in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.8 No linked issue is refused
// ---------------------------------------------------------------------------

test("merge: no linked issue — refuses and does not merge", async () => {
  const deps = makeDeps({
    async getPrLinkedIssue(_pr) {
      return null;
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.toLowerCase().includes("no linked pipeline issue") ||
          err.message.toLowerCase().includes("closing-issue"),
        `expected no-linked-issue message in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.9 Non-CLEAN mergeStateStatus variants are refused (finding 2)
// ---------------------------------------------------------------------------

test("merge: BEHIND mergeStateStatus — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", statusCheckRollup: [] };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("BEHIND"), `expected BEHIND in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: BLOCKED mergeStateStatus — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", statusCheckRollup: [] };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("BLOCKED"), `expected BLOCKED in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: HAS_HOOKS mergeStateStatus — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return { mergeable: "MERGEABLE", mergeStateStatus: "HAS_HOOKS", statusCheckRollup: [] };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.includes("HAS_HOOKS"), `expected HAS_HOOKS in: ${err.message}`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: UNKNOWN mergeStateStatus (with MERGEABLE) — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return { mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN", statusCheckRollup: [] };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(err.message.length > 0, `expected non-empty error`);
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.10 Non-SUCCESS/NEUTRAL check conclusions are blocked (finding 3)
// ---------------------------------------------------------------------------

test("merge: ACTION_REQUIRED check conclusion — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "security-scan", status: "COMPLETED", conclusion: "ACTION_REQUIRED" },
        ] satisfies StatusCheck[],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("security-scan"),
        `expected check name in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: SKIPPED check conclusion — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "optional-check", status: "COMPLETED", conclusion: "SKIPPED" },
        ] satisfies StatusCheck[],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("optional-check"),
        `expected check name in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: null check conclusion — refuses and does not merge", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "mystery-check", status: "COMPLETED", conclusion: null },
        ] satisfies StatusCheck[],
      };
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("mystery-check"),
        `expected check name in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: NEUTRAL check conclusion — passes through (not blocking)", async () => {
  const deps = makeDeps({
    async ghPrView(_pr, _fields) {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [
          { name: "neutral-check", status: "COMPLETED", conclusion: "NEUTRAL" },
          { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
        ] satisfies StatusCheck[],
      };
    },
  });
  await mergePr(42, deps);
  assert.deepEqual(deps.mergeCalls, [42], "ghPrMerge should be called for NEUTRAL conclusion");
});

// ---------------------------------------------------------------------------
// 4.11 Issue-stage cross-validation via getPrForIssue (finding 4)
// ---------------------------------------------------------------------------

test("merge: getPrForIssue returns different PR — refuses (cross-repo guard)", async () => {
  const deps = makeDeps({
    async getPrForIssue(_issueNumber) {
      return 99; // issue resolves to PR #99, not #42
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("99") || err.message.includes("does not resolve"),
        `expected cross-validation message in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

test("merge: getPrForIssue returns null — refuses (issue not found in repo)", async () => {
  const deps = makeDeps({
    async getPrForIssue(_issueNumber) {
      return null; // issue does not resolve to any open PR in this repo
    },
  });
  await assert.rejects(
    () => mergePr(42, deps),
    (err: Error) => {
      assert.ok(
        err.message.includes("null") || err.message.includes("does not resolve"),
        `expected cross-validation failure message in: ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(deps.mergeCalls.length, 0, "ghPrMerge must not be called");
});

// ---------------------------------------------------------------------------
// 4.12 CLI flag rejections for merge (finding 1)
// ---------------------------------------------------------------------------

test("CLI: 'pipeline merge 42 --status' exits non-zero with incompatibility message", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "merge", "42", "--status"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0, "should exit non-zero");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(
    combined.includes("cannot be combined"),
    `expected incompatibility message, got: ${combined}`,
  );
});

test("CLI: 'pipeline merge 42 --dry-run' exits non-zero with incompatibility message", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "merge", "42", "--dry-run"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0, "should exit non-zero");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(
    combined.includes("cannot be combined"),
    `expected incompatibility message, got: ${combined}`,
  );
});

// ---------------------------------------------------------------------------
// 4.14 Loop-isolation guarantee
//
// Reads every stage handler file and asserts none of them import from merge.ts.
// Also reads pipeline.ts and verifies the dispatch() function body does not
// reference mergePr, preserving the never-auto-merge structural invariant.
// ---------------------------------------------------------------------------

test("merge: loop-isolation — no stage handler imports from merge.ts", () => {
  const stageFiles = fs.readdirSync(STAGES_DIR).filter((f) => f.endsWith(".ts"));
  // merge.ts itself is excluded — it IS the module; checking it for self-references
  // would trivially pass and is not meaningful.
  const checkFiles = stageFiles.filter((f) => f !== "merge.ts");

  for (const file of checkFiles) {
    const content = fs.readFileSync(path.join(STAGES_DIR, file), "utf8");
    const hasImport =
      content.includes('from "./merge') ||
      content.includes('from "../stages/merge') ||
      content.includes('require("./merge') ||
      content.includes("require('../stages/merge");
    assert.ok(
      !hasImport,
      `Stage handler ${file} must not import from merge.ts — the autonomous loop must stay merge-free (#217)`,
    );
  }
});

test("merge: loop-isolation — dispatch() in pipeline.ts does not call mergePr", () => {
  const content = fs.readFileSync(PIPELINE_TS, "utf8");

  // Extract the dispatch() function body by finding its declaration and the
  // closing brace at the same indentation level. We look for the function text
  // between "async function dispatch(" and the balanced closing "}" so that the
  // test is robust to formatting changes.
  const dispatchStart = content.indexOf("async function dispatch(");
  assert.ok(dispatchStart !== -1, "dispatch() function must exist in pipeline.ts");

  // Find the end of the dispatch function by counting braces from the opening '{'.
  const openBrace = content.indexOf("{", dispatchStart);
  assert.ok(openBrace !== -1, "dispatch() function must have an opening brace");

  let depth = 0;
  let dispatchEnd = openBrace;
  for (let i = openBrace; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) {
        dispatchEnd = i;
        break;
      }
    }
  }

  const dispatchBody = content.slice(dispatchStart, dispatchEnd + 1);
  assert.ok(
    !dispatchBody.includes("mergePr"),
    "dispatch() must not call mergePr — the advance loop must never invoke the merge handler (#217)",
  );
});
