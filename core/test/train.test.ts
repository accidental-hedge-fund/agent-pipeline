// Tests for pipeline train (integrated train mode).
// Network- and subprocess-free: TrainDeps are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTrainStatus,
  orderIssuesByDeclaredDeps,
  parseIssueList,
  pipelineStageFromLabels,
  runTrain,
  type TrainDeps,
  type TrainIssueSnapshot,
  type TrainOpts,
} from "../scripts/stages/train.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function snap(
  n: number,
  body: string,
  labels: string[] = ["pipeline:ready"],
  title = `Issue ${n}`,
): TrainIssueSnapshot {
  return { number: n, title, body, labels, state: "open" };
}

function makeDeps(overrides: Partial<TrainDeps> = {}): TrainDeps & {
  advanceCalls: number[];
  mergeCalls: number[];
  fetchCalls: number;
} {
  const advanceCalls: number[] = [];
  const mergeCalls: number[] = [];
  let fetchCalls = 0;
  const issues = new Map<number, TrainIssueSnapshot>();
  const prByIssue = new Map<number, number>();
  const prState = new Map<number, { state: "open" | "merged"; oid: string | null; head: string }>();

  const base: TrainDeps = {
    log() {},
    async listMilestoneIssues() {
      return [...issues.values()];
    },
    async getIssue(n) {
      const s = issues.get(n);
      if (!s) throw new Error(`missing issue ${n}`);
      return s;
    },
    async advanceIssue(n) {
      advanceCalls.push(n);
      const s = issues.get(n)!;
      s.labels = ["pipeline:ready-to-deploy"];
      return { ok: true, terminal: "ready-to-deploy", labels: s.labels };
    },
    async getPrForIssue(n) {
      return prByIssue.get(n) ?? null;
    },
    async mergeIssuePr(pr) {
      mergeCalls.push(pr);
      const cur = prState.get(pr);
      if (!cur) throw new Error(`unknown pr ${pr}`);
      prState.set(pr, {
        state: "merged",
        oid: `merge${pr}${"0".repeat(32)}`.slice(0, 40),
        head: cur.head,
      });
    },
    async observePr(pr) {
      const cur = prState.get(pr) ?? { state: "open" as const, oid: null, head: "h" };
      return {
        state: cur.state === "merged" ? "merged" : "open",
        mergeCommitOid: cur.oid,
        headRefOid: cur.head,
      };
    },
    async fetchBase() {
      fetchCalls += 1;
    },
    async baseTip() {
      return "b".repeat(40);
    },
    async isAncestor(ancestor, descendant) {
      // Contained when ancestor is a recorded merge oid and tip is our fixed tip
      return descendant === "b".repeat(40) && ancestor.startsWith("merge");
    },
    ...overrides,
  };

  return Object.assign(base, {
    advanceCalls,
    mergeCalls,
    get fetchCalls() {
      return fetchCalls;
    },
    _issues: issues,
    _prByIssue: prByIssue,
    _prState: prState,
    seedIssue(s: TrainIssueSnapshot) {
      issues.set(s.number, s);
    },
    seedPr(issue: number, pr: number, head = "a".repeat(40)) {
      prByIssue.set(issue, pr);
      prState.set(pr, { state: "open", oid: null, head });
    },
  }) as TrainDeps & {
    advanceCalls: number[];
    mergeCalls: number[];
    fetchCalls: number;
    seedIssue(s: TrainIssueSnapshot): void;
    seedPr(issue: number, pr: number, head?: string): void;
  };
}

const baseOpts = (over: Partial<TrainOpts> = {}): TrainOpts => ({
  issues: [1, 2],
  merge: false,
  baseBranch: "main",
  repoDir: "/tmp/repo",
  repo: "o/r",
  ...over,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("parseIssueList: commas and spaces", () => {
  assert.deepEqual(parseIssueList("10, 11 12"), [10, 11, 12]);
  assert.deepEqual(parseIssueList(""), []);
  assert.throws(() => parseIssueList("0"), /invalid issue id/);
  assert.throws(() => parseIssueList("1a"), /invalid issue id/);
});

test("pipelineStageFromLabels: single stage", () => {
  assert.equal(pipelineStageFromLabels(["pipeline:ready-to-deploy"]), "ready-to-deploy");
  assert.equal(pipelineStageFromLabels(["bug"]), null);
  assert.throws(
    () => pipelineStageFromLabels(["pipeline:ready", "pipeline:implementing"]),
    /ambiguous/,
  );
});

test("orderIssuesByDeclaredDeps: depends-on edge reorders", () => {
  const ordered = orderIssuesByDeclaredDeps([
    snap(2, "Depends on: #1"),
    snap(1, "base work"),
  ]);
  assert.deepEqual(ordered, [1, 2]);
});

test("orderIssuesByDeclaredDeps: cycle fails", () => {
  assert.throws(
    () =>
      orderIssuesByDeclaredDeps([
        snap(1, "Depends on: #2"),
        snap(2, "Depends on: #1"),
      ]),
    /cycle|dependency validation/i,
  );
});

test("orderIssuesByDeclaredDeps: empty fails", () => {
  assert.throws(() => orderIssuesByDeclaredDeps([]), /empty/);
});

test("buildTrainStatus: schema envelope", () => {
  const s = buildTrainStatus({
    ordered_issues: [1],
    current_issue: 1,
    current_index: 0,
    next_action: "advance",
    merge_mode: true,
    items: [],
    blocker: null,
    complete: false,
  });
  assert.equal(s.schema_version, 1);
  assert.equal(s.kind, "train_status");
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

test("train without merge: advances each issue to ready-to-deploy", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "Depends on: #1"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [2, 1], merge: false }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status.complete, true);
  assert.deepEqual(result.status.ordered_issues, [1, 2]);
  assert.deepEqual(deps.advanceCalls, [1, 2]);
  assert.equal(deps.mergeCalls.length, 0);
  assert.ok(result.status.items.every((i) => i.terminal === "ready-to-deploy"));
});

test("train with merge: dependent does not start until prerequisite integrated", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "prereq"));
  deps.seedIssue(snap(2, "Depends on: #1"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  let merge2Before1Integrated = false;
  const origMerge = deps.mergeIssuePr.bind(deps);
  deps.mergeIssuePr = async (pr) => {
    if (pr === 102 && !deps.mergeCalls.includes(101)) {
      merge2Before1Integrated = true;
    }
    return origMerge(pr);
  };

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: true }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(merge2Before1Integrated, false);
  assert.deepEqual(deps.mergeCalls, [101, 102]);
  assert.ok(result.status.items.every((i) => i.integrated));
  assert.ok(result.status.items.every((i) => i.merge_result_oid?.startsWith("merge")));
});

test("train merge: already-merged contained PR is idempotent", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "done", ["pipeline:ready-to-deploy"]));
  deps.seedPr(1, 101);
  // Pre-seed as merged with containable oid
  (deps as unknown as { _prState: Map<number, { state: string; oid: string; head: string }> })._prState.set(
    101,
    { state: "merged", oid: "merge101" + "0".repeat(33), head: "a".repeat(40) },
  );

  const result = await runTrain(baseOpts({ issues: [1], merge: true }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(deps.advanceCalls.length, 0);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.status.items[0]!.terminal, "already-integrated");
  assert.equal(result.status.items[0]!.integrated, true);
});

test("train merge: containment failure stops before next item", async () => {
  const deps = makeDeps({
    async isAncestor() {
      return false;
    },
  });
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "Depends on: #1"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /not contained/);
  assert.equal(deps.mergeCalls.length, 1);
  assert.equal(deps.advanceCalls.length, 1); // only #1 advanced
  assert.equal(result.status.items.length, 1);
});

test("train: needs-human parks the train", async () => {
  const deps = makeDeps({
    async advanceIssue(n) {
      return {
        ok: true,
        terminal: "needs-human",
        labels: ["pipeline:needs-human"],
      };
    },
  });
  deps.seedIssue(snap(1, "a"));
  const result = await runTrain(baseOpts({ issues: [1], merge: false }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /needs-human/);
  assert.equal(result.status.next_action, "stopped");
});

test("train: missing selector fails", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => runTrain(baseOpts({ issues: undefined, milestone: undefined }), deps),
    /requires --issues|--milestone/,
  );
});

test("train merge: missing linked PR fails closed", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a", ["pipeline:ready-to-deploy"]));
  // no PR seeded
  const result = await runTrain(baseOpts({ issues: [1], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /no linked open PR/);
});

// ---------------------------------------------------------------------------
// Isolation: advance stage handlers must not import train
// ---------------------------------------------------------------------------

test("train: loop-isolation — stage handlers do not import train", () => {
  const stagesDir = path.join(__dirname, "..", "scripts", "stages");
  const exempt = new Set([
    "merge.ts",
    "merge-queue.ts",
    "merge_queue.ts",
    "merge-queue-release-when-complete.ts",
    "merge_queue_hold.ts",
    "train.ts",
  ]);
  for (const file of fs.readdirSync(stagesDir).filter((f) => f.endsWith(".ts"))) {
    if (exempt.has(file)) continue;
    const content = fs.readFileSync(path.join(stagesDir, file), "utf8");
    assert.ok(
      !content.includes('from "./train') &&
        !content.includes("from './train") &&
        !content.includes("runTrain") &&
        !content.includes("realTrainDeps"),
      `${file} must not import train`,
    );
  }
});

test("train: loop-isolation — dispatch() does not call runTrain", () => {
  const pipelineRunTs = path.join(__dirname, "..", "scripts", "pipeline-run.ts");
  const content = fs.readFileSync(pipelineRunTs, "utf8");
  const dispatchStart = content.indexOf("export async function dispatch(");
  assert.ok(dispatchStart !== -1);
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
  assert.ok(!body.includes("runTrain") && !body.includes("mergePr"));
});

test("train: command registry includes train with merge and issues flags", async () => {
  const { COMMAND_REGISTRY } = await import("../scripts/command-registry.ts");
  assert.ok(COMMAND_REGISTRY.train);
  const flags = COMMAND_REGISTRY.train.allowedFlags;
  assert.ok(flags instanceof Set);
  assert.ok((flags as Set<string>).has("merge"));
  assert.ok((flags as Set<string>).has("issues"));
  assert.ok((flags as Set<string>).has("milestone"));
  assert.equal(COMMAND_REGISTRY.train.supportsJson, true);
});
