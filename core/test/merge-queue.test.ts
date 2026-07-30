// Tests for the `pipeline merge-queue` dry-run planner (#673).
//
// All tests are network- and subprocess-free: I/O is injected via MergeQueueDeps.
// Loop-isolation asserts stage handlers and the advance loop never import merge_queue.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planMergeQueue,
  formatMergeQueuePlan,
  runMergeQueueDryRun,
  isMergeableClean,
  evaluateChecksGate,
  recoverGhPrChecksFromExecError,
  type MergeQueueDeps,
  type RequiredCheck,
  type MergeQueueIssue,
} from "../scripts/stages/merge_queue.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGES_DIR = path.join(__dirname, "..", "scripts", "stages");
const PIPELINE_RUN_TS = path.join(__dirname, "..", "scripts", "pipeline-run.ts");
const PIPELINE_TS = path.join(__dirname, "..", "scripts", "pipeline.ts");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureIssue {
  number: number;
  labels: string[];
  pr?: number | null;
  mergeable?: string;
  mergeStateStatus?: string;
  headRefOid?: string;
  baseRefName?: string;
  requiredChecks?: RequiredCheck[] | "none-configured";
  allChecks?: RequiredCheck[];
}

function makeDeps(fixtures: FixtureIssue[]): MergeQueueDeps & {
  mergeWriteCalls: number;
  listCalls: number;
} {
  const byIssue = new Map(fixtures.map((f) => [f.number, f]));
  const byPr = new Map(
    fixtures.filter((f) => f.pr != null).map((f) => [f.pr as number, f]),
  );
  const deps: MergeQueueDeps & {
    mergeWriteCalls: number;
    listCalls: number;
  } = {
    mergeWriteCalls: 0,
    listCalls: 0,
    async listMilestoneIssues(_milestone) {
      deps.listCalls++;
      return fixtures.map(
        (f): MergeQueueIssue => ({ number: f.number, labels: f.labels }),
      );
    },
    async getPrForIssue(issueNumber) {
      const f = byIssue.get(issueNumber);
      if (!f || f.pr === null || f.pr === undefined) return null;
      return f.pr;
    },
    async ghPrView(pr, _fields) {
      const f = byPr.get(pr);
      assert.ok(f, `unexpected ghPrView for PR #${pr}`);
      return {
        mergeable: f.mergeable ?? "MERGEABLE",
        mergeStateStatus: f.mergeStateStatus ?? "CLEAN",
        headRefOid: f.headRefOid ?? "abc123def456",
        baseRefName: f.baseRefName ?? "main",
      };
    },
    async ghPrChecksRequired(pr) {
      const f = byPr.get(pr);
      assert.ok(f, `unexpected ghPrChecksRequired for PR #${pr}`);
      if (f.requiredChecks === "none-configured") {
        const err = Object.assign(new Error("Command failed"), {
          stderr: "no required checks reported on the 'main' branch",
        });
        throw err;
      }
      return f.requiredChecks ?? [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll(pr) {
      const f = byPr.get(pr);
      assert.ok(f, `unexpected ghPrChecksAll for PR #${pr}`);
      return f.allChecks ?? [];
    },
    log() {},
  };

  return deps;
}

const CLEAN_R2D = (issue: number, pr: number, head = `sha-${issue}`): FixtureIssue => ({
  number: issue,
  labels: ["pipeline:ready-to-deploy"],
  pr,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: head,
  requiredChecks: [{ name: "ci", bucket: "pass" }],
});

// ---------------------------------------------------------------------------
// isMergeableClean helper
// ---------------------------------------------------------------------------

test("merge-queue: isMergeableClean requires MERGEABLE and CLEAN", () => {
  assert.equal(isMergeableClean("MERGEABLE", "CLEAN"), true);
  assert.equal(isMergeableClean("CONFLICTING", "DIRTY"), false);
  assert.equal(isMergeableClean("UNKNOWN", "UNKNOWN"), false);
  assert.equal(isMergeableClean("MERGEABLE", "BEHIND"), false);
});

// ---------------------------------------------------------------------------
// 3.1 R2D-only
// ---------------------------------------------------------------------------

test("merge-queue: non-R2D milestone issues are not merge candidates", async () => {
  const deps = makeDeps([
    CLEAN_R2D(10, 100),
    {
      number: 11,
      labels: ["pipeline:pre-merge"],
      pr: 101,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].issueNumber, 10);
  assert.equal(plan.candidates[0].prNumber, 100);
  assert.ok(!plan.candidates.some((c) => c.issueNumber === 11));
  // Non-R2D is filtered before resolve — not listed as a skip either.
  assert.ok(!plan.skips.some((s) => s.issueNumber === 11));
});

// ---------------------------------------------------------------------------
// 3.2 Missing PR
// ---------------------------------------------------------------------------

test("merge-queue: missing PR is skipped with reason missing-pr", async () => {
  const deps = makeDeps([
    {
      number: 20,
      labels: ["pipeline:ready-to-deploy"],
      pr: null,
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skips.length, 1);
  assert.equal(plan.skips[0].reason, "missing-pr");
  assert.equal(plan.skips[0].issueNumber, 20);
  assert.equal(plan.skips[0].prNumber, null);
});

// ---------------------------------------------------------------------------
// 3.3 Non-mergeable / UNKNOWN
// ---------------------------------------------------------------------------

test("merge-queue: CONFLICTING PR is skipped as non-mergeable", async () => {
  const deps = makeDeps([
    {
      number: 30,
      labels: ["pipeline:ready-to-deploy"],
      pr: 300,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skips[0].reason, "non-mergeable");
  assert.ok(plan.skips[0].detail.includes("CONFLICTING"));
});

test("merge-queue: UNKNOWN mergeability is skipped as non-mergeable", async () => {
  const deps = makeDeps([
    {
      number: 31,
      labels: ["pipeline:ready-to-deploy"],
      pr: 301,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skips[0].reason, "non-mergeable");
});

// ---------------------------------------------------------------------------
// 3.4 Checks not green
// ---------------------------------------------------------------------------

test("merge-queue: failing required check is skipped as checks-not-green", async () => {
  const deps = makeDeps([
    {
      number: 40,
      labels: ["pipeline:ready-to-deploy"],
      pr: 400,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: "deadbeef",
      requiredChecks: [
        { name: "ci", bucket: "pass" },
        { name: "lint", bucket: "fail" },
      ],
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skips[0].reason, "checks-not-green");
  assert.ok(plan.skips[0].detail.includes("lint"));
});

test("merge-queue: pending required check is skipped as checks-not-green", async () => {
  const deps = makeDeps([
    {
      number: 41,
      labels: ["pipeline:ready-to-deploy"],
      pr: 401,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      requiredChecks: [{ name: "slow-ci", bucket: "pending" }],
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.skips[0].reason, "checks-not-green");
});

test("merge-queue: recoverGhPrChecksFromExecError parses stdout from non-zero gh exit", () => {
  const pendingJson = JSON.stringify([{ name: "ci", bucket: "pending" }]);
  // Shape mirrors node:child_process execFile rejection (exit 8 = pending).
  const err = Object.assign(new Error("Command failed: gh pr checks ... exit code 8"), {
    code: 8,
    stdout: pendingJson,
    stderr: "",
  });
  const recovered = recoverGhPrChecksFromExecError(err);
  assert.deepEqual(recovered, [{ name: "ci", bucket: "pending" }]);
  assert.equal(recoverGhPrChecksFromExecError(new Error("network down")), null);
  assert.equal(
    recoverGhPrChecksFromExecError(Object.assign(new Error("bad"), { stdout: "not-json" })),
    null,
  );
});

test("merge-queue: evaluateChecksGate treats rejected-process pending checks as not green", async () => {
  const pendingJson = JSON.stringify([
    { name: "ci", bucket: "pass" },
    { name: "slow", bucket: "pending" },
  ]);
  const deps = {
    async ghPrChecksRequired() {
      const err = Object.assign(new Error("Command failed with exit code 8"), {
        code: 8,
        stdout: pendingJson,
        stderr: "",
      });
      throw err;
    },
    async ghPrChecksAll() {
      throw new Error("should not call all when required recovered");
    },
  };
  const result = await evaluateChecksGate(99, deps);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("slow"));
  assert.ok(result.detail.includes("pending"));
});

test("merge-queue: plan skips as checks-not-green when ghPrChecksRequired rejects with pending JSON stdout", async () => {
  const pendingJson = JSON.stringify([{ name: "required-ci", bucket: "pending" }]);
  const deps = makeDeps([
    {
      number: 42,
      labels: ["pipeline:ready-to-deploy"],
      pr: 420,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: "pending-sha",
    },
  ]);
  deps.ghPrChecksRequired = async () => {
    throw Object.assign(new Error("Command failed with exit code 8"), {
      code: 8,
      stdout: pendingJson,
      stderr: "",
    });
  };
  const plan = await planMergeQueue({ milestone: "v1", baseBranch: "main" }, deps);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skips.length, 1);
  assert.equal(plan.skips[0].reason, "checks-not-green");
  assert.ok(plan.skips[0].detail.includes("required-ci"));
});

// ---------------------------------------------------------------------------
// Base-branch gate
// ---------------------------------------------------------------------------

test("merge-queue: clean R2D PR targeting a different base is skipped as wrong-base", async () => {
  const deps = makeDeps([
    {
      number: 60,
      labels: ["pipeline:ready-to-deploy"],
      pr: 600,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: "release-sha",
      baseRefName: "release/1.0",
      requiredChecks: [{ name: "ci", bucket: "pass" }],
    },
    CLEAN_R2D(61, 610, "main-sha"), // base defaults to main
  ]);
  const plan = await planMergeQueue({ milestone: "v1", baseBranch: "main" }, deps);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].issueNumber, 61);
  assert.equal(plan.skips.length, 1);
  assert.equal(plan.skips[0].issueNumber, 60);
  assert.equal(plan.skips[0].reason, "wrong-base");
  assert.ok(plan.skips[0].detail.includes("release/1.0"));
  assert.ok(plan.skips[0].detail.includes("configured=main"));
});

// ---------------------------------------------------------------------------
// 3.5 Happy path + order
// ---------------------------------------------------------------------------

test("merge-queue: clean MERGEABLE R2D PR is a candidate with would-merge; order by issue", async () => {
  const deps = makeDeps([
    CLEAN_R2D(100, 1000, "sha100"),
    CLEAN_R2D(42, 420, "sha42"),
    CLEAN_R2D(75, 750, "sha75"),
  ]);
  const plan = await planMergeQueue({ milestone: "v1.28.2" }, deps);
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(
    plan.candidates.map((c) => c.issueNumber),
    [42, 75, 100],
  );
  assert.deepEqual(
    plan.candidates.map((c) => c.prNumber),
    [420, 750, 1000],
  );
  for (const c of plan.candidates) {
    assert.equal(c.plannedAction, "would-merge");
    assert.equal(c.mergeable, "MERGEABLE");
    assert.equal(c.mergeStateStatus, "CLEAN");
    assert.ok(c.headRefOid.length > 0);
    assert.ok(c.checksSummary.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 3.6 Dry-run never merges; idempotent
// ---------------------------------------------------------------------------

test("merge-queue: dry-run never invokes write/merge deps; plan is idempotent", async () => {
  const fixtures = [CLEAN_R2D(5, 50), CLEAN_R2D(6, 60)];
  const deps = makeDeps(fixtures);
  // Intentionally no merge method on deps — structural proof dry-run has no merge seam.
  assert.equal("ghPrMerge" in deps, false);

  const plan1 = await planMergeQueue({ milestone: "v1" }, deps);
  const plan2 = await planMergeQueue({ milestone: "v1" }, deps);

  assert.deepEqual(
    plan1.candidates.map((c) => ({ i: c.issueNumber, p: c.prNumber, a: c.plannedAction })),
    plan2.candidates.map((c) => ({ i: c.issueNumber, p: c.prNumber, a: c.plannedAction })),
  );
  assert.deepEqual(
    plan1.skips.map((s) => ({ i: s.issueNumber, r: s.reason })),
    plan2.skips.map((s) => ({ i: s.issueNumber, r: s.reason })),
  );
  assert.equal(deps.mergeWriteCalls, 0);
  assert.ok(deps.listCalls >= 2);

  // Formatter footer
  const text = formatMergeQueuePlan(plan1, "owner/repo");
  assert.ok(text.includes("No merges were performed"));
  assert.ok(text.includes("issue #5"));
  assert.ok(text.includes("PR #50"));
  assert.ok(text.includes("would-merge"));
});

test("merge-queue: empty plan exits 0 and reports zero candidates", async () => {
  const deps = makeDeps([
    { number: 1, labels: ["pipeline:pre-merge"] },
  ]);
  const lines: string[] = [];
  const code = await runMergeQueueDryRun(
    { milestone: "empty-m" },
    deps,
    (m) => lines.push(m),
  );
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.ok(out.includes("(none)") || out.includes("0 candidate"));
  assert.ok(out.includes("No merges were performed"));
});

test("merge-queue: missing --milestone exits non-zero with usage", async () => {
  const deps = makeDeps([]);
  const lines: string[] = [];
  const code = await runMergeQueueDryRun(
    { milestone: undefined },
    deps,
    (m) => lines.push(m),
  );
  assert.equal(code, 2);
  assert.ok(lines.join("\n").includes("--milestone"));
  assert.equal(deps.listCalls, 0, "must not list issues without a selector");
});

test("merge-queue: premature --apply fails closed without planning", async () => {
  const deps = makeDeps([CLEAN_R2D(1, 10)]);
  const lines: string[] = [];
  const code = await runMergeQueueDryRun(
    { milestone: "v1", apply: true },
    deps,
    (m) => lines.push(m),
  );
  assert.equal(code, 2);
  assert.ok(lines.join("\n").toLowerCase().includes("not implemented") || lines.join("\n").includes("#674"));
  assert.equal(deps.listCalls, 0, "must not plan when apply fails closed");
});

// ---------------------------------------------------------------------------
// Fallback checks parity with merge
// ---------------------------------------------------------------------------

test("merge-queue: no required checks + failing observable → checks-not-green", async () => {
  const deps = makeDeps([
    {
      number: 50,
      labels: ["pipeline:ready-to-deploy"],
      pr: 500,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      requiredChecks: "none-configured",
      allChecks: [{ name: "security", bucket: "fail" }],
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.skips[0].reason, "checks-not-green");
});

test("merge-queue: no required checks + all green → candidate", async () => {
  const deps = makeDeps([
    {
      number: 51,
      labels: ["pipeline:ready-to-deploy"],
      pr: 501,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: "fallback-sha",
      requiredChecks: "none-configured",
      allChecks: [{ name: "test", bucket: "pass" }],
    },
  ]);
  const plan = await planMergeQueue({ milestone: "v1" }, deps);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].plannedAction, "would-merge");
});

// ---------------------------------------------------------------------------
// 3.7 Advance / loop isolation
// ---------------------------------------------------------------------------

test("merge-queue: loop-isolation — no advance stage handler imports merge_queue", () => {
  const stageFiles = fs.readdirSync(STAGES_DIR).filter((f) => f.endsWith(".ts"));
  // Human-only modules: merge_queue itself + merge (per-PR primitive; neither is advance).
  const exempt = new Set(["merge_queue.ts", "merge.ts"]);
  const checkFiles = stageFiles.filter((f) => !exempt.has(f));

  for (const file of checkFiles) {
    const content = fs.readFileSync(path.join(STAGES_DIR, file), "utf8");
    const hasImport =
      content.includes("merge_queue") ||
      content.includes("merge-queue");
    assert.ok(
      !hasImport,
      `Stage handler ${file} must not import or reference merge_queue — advance must stay merge-queue-free (#673)`,
    );
  }
});

test("merge-queue: loop-isolation — dispatch() in pipeline-run.ts does not call merge-queue", () => {
  const content = fs.readFileSync(PIPELINE_RUN_TS, "utf8");
  const dispatchStart = content.indexOf("export async function dispatch(");
  assert.ok(dispatchStart !== -1, "dispatch() must exist in pipeline-run.ts");
  const openBrace = content.indexOf("{", dispatchStart);
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
  const body = content.slice(dispatchStart, dispatchEnd + 1);
  assert.ok(
    !body.includes("merge_queue") &&
      !body.includes("merge-queue") &&
      !body.includes("planMergeQueue") &&
      !body.includes("runMergeQueueDryRun"),
    "dispatch() must not reference merge-queue planner symbols",
  );
});

test("merge-queue: pipeline.ts advance path does not call runMergeQueueDryRun outside merge-queue branch", () => {
  // pipeline.ts may import runMergeQueueDryRun for the human keyword only;
  // advance loop is in pipeline-run.ts (checked above). Also ensure no auto_merge key.
  const content = fs.readFileSync(PIPELINE_TS, "utf8");
  assert.ok(
    content.includes("isMergeQueueCommand") || content.includes("merge-queue"),
    "CLI should wire merge-queue keyword",
  );
  // Config schema lives elsewhere; smoke that pipeline.ts does not introduce auto_merge wiring.
  assert.ok(
    !content.includes("auto_merge:") && !content.includes("autoMerge"),
    "pipeline.ts must not wire an auto_merge config key for merge-queue",
  );
});
