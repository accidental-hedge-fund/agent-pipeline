// Tests for pipeline train (integrated train mode).
// Network- and subprocess-free: TrainDeps are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceWaveFromSingle,
  buildTrainStatus,
  computeBaseEligibleFrontier,
  isIndependentOfHeld,
  orderIssuesByDeclaredDeps,
  orderIssuesForTrain,
  parseIssueList,
  pipelineStageFromLabels,
  runTrain,
  type AdvanceOutcome,
  type AdvanceWaveResult,
  type TrainDeps,
  type TrainIssueSnapshot,
  type TrainOpts,
} from "../scripts/stages/train.ts";
import {
  MERGEABILITY_UNKNOWN_RETRY_DELAY_MS,
  mergePr,
  type MergeDeps,
} from "../scripts/stages/merge.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function snap(
  n: number,
  body: string,
  labels: string[] = ["pipeline:ready"],
  title = `Issue ${n}`,
  state: "open" | "closed" = "open",
): TrainIssueSnapshot {
  return { number: n, title, body, labels, state };
}

function makeDeps(overrides: Partial<TrainDeps> = {}): TrainDeps & {
  advanceCalls: number[];
  waveCalls: number[][];
  mergeCalls: number[];
  fetchCalls: number;
  anyStateCalls: number[];
} {
  const advanceCalls: number[] = [];
  const waveCalls: number[][] = [];
  const mergeCalls: number[] = [];
  const anyStateCalls: number[] = [];
  let fetchCalls = 0;
  const issues = new Map<number, TrainIssueSnapshot>();
  /** Open PRs only — mirrors production getPrForIssue. */
  const openPrByIssue = new Map<number, number>();
  /** Any-state PR (open/closed/merged) — mirrors getPrForIssueAnyState. */
  const anyPrByIssue = new Map<number, number>();
  const prState = new Map<number, { state: "open" | "merged"; oid: string | null; head: string }>();

  const defaultAdvance = async (n: number): Promise<AdvanceOutcome> => {
    advanceCalls.push(n);
    const s = issues.get(n)!;
    s.labels = ["pipeline:ready-to-deploy"];
    return { ok: true, terminal: "ready-to-deploy", labels: s.labels };
  };

  const userAdvanceIssue = overrides.advanceIssue;
  const userAdvanceWave = overrides.advanceWave;

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
    async advanceWave(issueList) {
      waveCalls.push([...issueList]);
      if (userAdvanceWave) return userAdvanceWave(issueList);
      const single = userAdvanceIssue ?? defaultAdvance;
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, await single(n));
      }
      return out;
    },
    async getPrForIssue(n) {
      return openPrByIssue.get(n) ?? null;
    },
    async getPrForIssueAnyState(n) {
      anyStateCalls.push(n);
      return anyPrByIssue.get(n) ?? openPrByIssue.get(n) ?? null;
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
      // After merge, open lookup no longer sees the PR (production open-only).
      for (const [issue, p] of openPrByIssue) {
        if (p === pr) openPrByIssue.delete(issue);
      }
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
    // Always keep our advanceWave wrapper (overrides.advanceWave handled inside).
    advanceWave: async (issueList) => {
      waveCalls.push([...issueList]);
      if (userAdvanceWave) return userAdvanceWave(issueList);
      const single = userAdvanceIssue ?? defaultAdvance;
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, await single(n));
      }
      return out;
    },
  };

  return Object.assign(base, {
    advanceCalls,
    waveCalls,
    mergeCalls,
    anyStateCalls,
    get fetchCalls() {
      return fetchCalls;
    },
    _issues: issues,
    _openPrByIssue: openPrByIssue,
    _anyPrByIssue: anyPrByIssue,
    _prState: prState,
    seedIssue(s: TrainIssueSnapshot) {
      issues.set(s.number, s);
    },
    seedPr(issue: number, pr: number, head = "a".repeat(40)) {
      openPrByIssue.set(issue, pr);
      anyPrByIssue.set(issue, pr);
      prState.set(pr, { state: "open", oid: null, head });
    },
    /** Seed a merged PR visible only via any-state (open lookup returns null). */
    seedMergedPrAnyState(
      issue: number,
      pr: number,
      oid = `merge${pr}${"0".repeat(32)}`.slice(0, 40),
      head = "a".repeat(40),
    ) {
      anyPrByIssue.set(issue, pr);
      openPrByIssue.delete(issue);
      prState.set(pr, { state: "merged", oid, head });
    },
  }) as TrainDeps & {
    advanceCalls: number[];
    waveCalls: number[][];
    mergeCalls: number[];
    anyStateCalls: number[];
    fetchCalls: number;
    seedIssue(s: TrainIssueSnapshot): void;
    seedPr(issue: number, pr: number, head?: string): void;
    seedMergedPrAnyState(issue: number, pr: number, oid?: string, head?: string): void;
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

test("train without merge: advances independent issues to ready-to-deploy", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status.complete, true);
  assert.deepEqual(result.status.ordered_issues, [1, 2]);
  // Independent peers: one multi-item wave.
  assert.equal(deps.waveCalls.length, 1);
  assert.deepEqual(deps.waveCalls[0]!.slice().sort((a, b) => a - b), [1, 2]);
  assert.equal(deps.mergeCalls.length, 0);
  assert.ok(result.status.items.every((i) => i.terminal === "ready-to-deploy"));
});

test("train without merge (#1028): code dependent waits for base containment, not mere R2D", async () => {
  // Bite: finished (R2D) parent without integrated must not schedule the child.
  const deps = makeDeps();
  deps.seedIssue(snap(1, "prereq"));
  deps.seedIssue(snap(2, "Depends on: #1"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [2, 1], merge: false }), deps);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(deps.waveCalls, [[1]]);
  assert.deepEqual(deps.advanceCalls, [1]);
  assert.equal(deps.mergeCalls.length, 0);
  assert.match(result.status.blocker ?? "", /#2 waits on #1|not integrated/i);
  const item1 = result.status.items.find((i) => i.issue === 1);
  assert.equal(item1?.terminal, "ready-to-deploy");
  assert.equal(item1?.integrated, false);
  assert.ok(!result.status.items.some((i) => i.issue === 2 && i.terminal === "ready-to-deploy"));
});

test("train (#1023): independent peers use one advance-wave call per frontier", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(deps.waveCalls.length, 1, "one multi-item wave, not N×single loops at train layer");
  assert.deepEqual(deps.waveCalls[0]!.slice().sort((a, b) => a - b), [1, 2]);
});

test("train (#1063): merge-mode does not merge independent sibling while peer is parked", async () => {
  const deps = makeDeps({
    async advanceIssue(n) {
      deps.advanceCalls.push(n);
      const issues = (deps as unknown as { _issues: Map<number, TrainIssueSnapshot> })._issues;
      if (n === 1) {
        issues.get(1)!.labels = ["pipeline:needs-human"];
        return { ok: true, terminal: "needs-human", labels: ["pipeline:needs-human"] };
      }
      issues.get(n)!.labels = ["pipeline:ready-to-deploy"];
      return { ok: true, terminal: "ready-to-deploy", labels: ["pipeline:ready-to-deploy"] };
    },
  });
  deps.seedIssue(snap(1, "will park"));
  deps.seedIssue(snap(2, "independent ready"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(deps.advanceCalls, [1], "serial ship advances one item");
  assert.equal(deps.mergeCalls.length, 0, "must not merge a sibling after a park");
  assert.match(result.status.blocker ?? "", /needs-human|will not implement/i);
});

test("orderIssuesForTrain: merge-mode puts R2D before newer ready (#1063)", () => {
  const ordered = orderIssuesForTrain(
    [
      snap(1061, "new work", ["pipeline:ready"]),
      snap(599, "approved", ["pipeline:ready-to-deploy"]),
    ],
    true,
  );
  assert.deepEqual(ordered, [599, 1061]);
});

test("train (#1063): merge-first R2D before implementing newer sibling", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(599, "approved", ["pipeline:ready-to-deploy"]));
  deps.seedIssue(snap(1061, "newer sibling", ["pipeline:ready"]));
  deps.seedPr(599, 1058);
  deps.seedPr(1061, 1064);

  const result = await runTrain(baseOpts({ issues: [1061, 599], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.ok(deps.mergeCalls[0] === 1058, "first merge is the already-R2D PR");
  assert.ok(deps.advanceCalls.includes(1061));
  assert.ok(!deps.advanceCalls.includes(599), "R2D item is not re-advanced");
});

test("train (#1063): already-blocked sibling stops before implementing the next", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1074, "parked", ["pipeline:pre-merge", "blocked"]));
  deps.seedIssue(snap(1073, "next ready", ["pipeline:ready"]));
  deps.seedPr(1074, 1079);
  deps.seedPr(1073, 1082);

  const result = await runTrain(baseOpts({ issues: [1074, 1073], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.equal(deps.advanceCalls.length, 0, "must not implement #1073");
  assert.match(result.status.blocker ?? "", /1074|blocked|will not implement/i);
});

test("computeBaseEligibleFrontier: code child waits for integrated parent", () => {
  const frontier = computeBaseEligibleFrontier({
    ordered: [1, 2],
    finished: new Set(),
    held: new Set(),
    integrated: new Set(),
    codeDeps: new Map([[1, []], [2, [1]]]),
  });
  assert.deepEqual(frontier, [1]);
  // Finished (R2D) without base containment is not enough (#1028).
  const finishedOnly = computeBaseEligibleFrontier({
    ordered: [1, 2],
    finished: new Set([1]),
    held: new Set(),
    integrated: new Set(),
    codeDeps: new Map([[1, []], [2, [1]]]),
  });
  assert.deepEqual(finishedOnly, [], "child must wait until parent is integrated on base");
  const after = computeBaseEligibleFrontier({
    ordered: [1, 2],
    finished: new Set([1]),
    held: new Set(),
    integrated: new Set([1]),
    codeDeps: new Map([[1, []], [2, [1]]]),
  });
  assert.deepEqual(after, [2]);
});

test("isIndependentOfHeld: edge fails closed", () => {
  const deps = new Map<number, number[]>([[1, []], [2, [1]]]);
  assert.equal(isIndependentOfHeld(2, new Set([1]), deps), false);
  assert.equal(isIndependentOfHeld(3, new Set([1]), new Map([[3, []], [1, []]])), true);
});

test("train (#1023): unproven independence fails closed — dep-linked R2D not merged while peer held", async () => {
  // Bite: #1 parks; #2 declares Depends on #1 so independence is unproven.
  // #2 must not enter the frontier (code-dep barrier) and must not merge.
  // Separately, isIndependentOfHeld fails closed on the reverse edge so the
  // merge-wave guard never merges a dep-linked pair under the independent-sibling rule.
  const deps = makeDeps({
    async advanceIssue(n) {
      deps.advanceCalls.push(n);
      const issues = (deps as unknown as { _issues: Map<number, TrainIssueSnapshot> })._issues;
      if (n === 1) {
        issues.get(1)!.labels = ["pipeline:needs-human"];
        return { ok: true, terminal: "needs-human", labels: ["pipeline:needs-human"] };
      }
      issues.get(n)!.labels = ["pipeline:ready-to-deploy"];
      return { ok: true, terminal: "ready-to-deploy", labels: ["pipeline:ready-to-deploy"] };
    },
  });
  deps.seedIssue(snap(1, "prereq will park"));
  deps.seedIssue(snap(2, "Depends on: #1"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: true }), deps);
  assert.deepEqual(deps.waveCalls, [[1]], "only base-eligible #1 advances; #2 waits on code dep");
  assert.equal(deps.mergeCalls.length, 0, "no merge while dep-linked peer is held / not integrated");
  assert.ok(!deps.mergeCalls.includes(102));
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /held|#1|needs-human|no base-eligible|waits on/i);
  // Pure guard: if #2 were ever R2D alongside held #1, independence fails closed.
  assert.equal(
    isIndependentOfHeld(2, new Set([1]), new Map([[1, []], [2, [1]]])),
    false,
    "dep edge must fail closed for independent-sibling merge",
  );
});

test("train (#1023): merge wave is serial with base proof between merges", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a independent"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const mergeOrder: number[] = [];
  /** Snapshot of merge count at each fetchBase (containment proof). */
  const fetchAtMergeCount: number[] = [];
  let mergesDone = 0;
  const origMerge = deps.mergeIssuePr.bind(deps);
  const origFetch = deps.fetchBase.bind(deps);
  deps.mergeIssuePr = async (pr) => {
    // Prove serial: the previous merge must already be recorded (no parallel merges).
    assert.equal(mergeOrder.length, mergesDone, "mergeIssuePr must not overlap");
    mergeOrder.push(pr);
    mergesDone += 1;
    return origMerge(pr);
  };
  deps.fetchBase = async (baseBranch) => {
    fetchAtMergeCount.push(mergesDone);
    return origFetch(baseBranch);
  };

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual(mergeOrder, [101, 102], "merges are one-at-a-time in frontier order");
  // Containment fetch runs after each merge mutation (merge count 1 then 2).
  assert.ok(
    fetchAtMergeCount.filter((n) => n === 1).length >= 1,
    "fetchBase after first merge for containment",
  );
  assert.ok(
    fetchAtMergeCount.filter((n) => n === 2).length >= 1,
    "fetchBase after second merge for containment",
  );
  // #1063: merge-mode advances one item at a time, then merges, then the next.
  assert.deepEqual(deps.waveCalls, [[1], [2]]);
});

test("train (#1023): production wiring is multi-item loop, not N×single / advanceWaveFromSingle", () => {
  const pipelinePath = path.join(__dirname, "..", "scripts", "pipeline.ts");
  const trainPath = path.join(__dirname, "..", "scripts", "stages", "train.ts");
  const pipeline = fs
    .readFileSync(pipelinePath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const trainSrc = fs.readFileSync(trainPath, "utf8");

  // runTrainCommand default wave seam
  const trainCmdStart = pipeline.indexOf("export async function runTrainCommand");
  assert.ok(trainCmdStart !== -1);
  const trainCmdSlice = pipeline.slice(trainCmdStart, trainCmdStart + 2500);
  assert.ok(
    trainCmdSlice.includes("advanceWaveThroughLoop"),
    "runTrainCommand must default to advanceWaveThroughLoop",
  );
  assert.ok(
    !trainCmdSlice.includes("advanceWaveFromSingle"),
    "runTrainCommand must not wire production N×single via advanceWaveFromSingle",
  );
  assert.ok(
    !trainCmdSlice.includes("advanceIssueThroughSingle"),
    "runTrainCommand must not N× advanceIssueThroughSingle for frontiers",
  );

  // Train orchestrator must not host a second recoverer
  assert.ok(
    !trainSrc.includes("repair_pipeline_item"),
    "train must not call repair_pipeline_item; recovery stays inside the loop wave",
  );
  // advanceWaveFromSingle may exist for tests only — production CLI must not default to it
  assert.ok(
    trainSrc.includes("export function advanceWaveFromSingle"),
    "serial adapter may exist for tests/legacy adapters",
  );
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

// ---------------------------------------------------------------------------
// #1071 — train inherits shared UNKNOWN mergeability retry (no train-local mole)
// ---------------------------------------------------------------------------

test("train (#1071): first UNKNOWN then MERGEABLE via real mergePr — merges and continues", async () => {
  // Hermetic: wire mergeIssuePr → real mergePr with injected UNKNOWN→MERGEABLE
  // sequence + fake sleep. Must NOT mock mergeIssuePr as an instant success.
  // Regression vs #1059 20:04Z class: first-attempt UNKNOWN must not STOP the ship
  // when a later in-budget re-read is MERGEABLE+CLEAN.
  const logs: string[] = [];
  const sleepCalls: number[] = [];
  const realMergeCalls: Array<{ pr: number; headRefOid: string }> = [];
  let mergeabilityViews = 0;

  const mergeDeps: MergeDeps = {
    async ghPrView(_pr, _fields) {
      mergeabilityViews += 1;
      if (mergeabilityViews === 1) {
        return {
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          headRefOid: "unknown-head-sha-001",
        };
      }
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "clean-head-sha-002",
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrMerge(pr, headRefOid) {
      realMergeCalls.push({ pr, headRefOid });
    },
    async getIssueLabels() {
      return ["pipeline:ready-to-deploy"];
    },
    async getPrLinkedIssue() {
      return 1059;
    },
    async getPrForIssue() {
      return 1070;
    },
    log(msg) {
      logs.push(msg);
    },
    async sleep(ms) {
      sleepCalls.push(ms);
    },
  };

  let deps!: ReturnType<typeof makeDeps>;
  deps = makeDeps({
    log(msg) {
      logs.push(msg);
    },
    async mergeIssuePr(pr) {
      // Shared merge surface only — no train-local UNKNOWN recoverer.
      await mergePr(pr, mergeDeps);
      // Mirror default post-merge fixture state so observePr + containment work.
      const self = deps as unknown as {
        mergeCalls: number[];
        _prState: Map<number, { state: string; oid: string | null; head: string }>;
        _openPrByIssue: Map<number, number>;
      };
      self.mergeCalls.push(pr);
      const cur = self._prState.get(pr);
      if (!cur) throw new Error(`unknown pr ${pr}`);
      self._prState.set(pr, {
        state: "merged",
        oid: `merge${pr}${"0".repeat(32)}`.slice(0, 40),
        head: cur.head,
      });
      for (const [issue, p] of self._openPrByIssue) {
        if (p === pr) self._openPrByIssue.delete(issue);
      }
    },
  });
  deps.seedIssue(
    snap(1059, "ship notify", ["pipeline:ready-to-deploy"], "Issue 1059"),
  );
  deps.seedPr(1059, 1070);

  const result = await runTrain(baseOpts({ issues: [1059], merge: true }), deps);

  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.equal(mergeabilityViews, 2, "shared surface re-reads once after UNKNOWN");
  assert.deepEqual(sleepCalls, [MERGEABILITY_UNKNOWN_RETRY_DELAY_MS]);
  assert.equal(realMergeCalls.length, 1, "squash merge runs once after CLEAN");
  assert.equal(
    realMergeCalls[0]!.headRefOid,
    "clean-head-sha-002",
    "bind --match-head-commit to successful read, not UNKNOWN-read SHA",
  );
  assert.deepEqual(deps.mergeCalls, [1070]);
  assert.equal(result.status.items[0]!.integrated, true);
  assert.equal(result.status.complete, true);
  assert.equal(result.status.blocker, null);

  // #1059-class first-attempt terminal is illegal when in-budget success applies.
  const stopLogs = logs.filter((l) => l.includes("[train] STOP:"));
  const unknownStop = stopLogs.find(
    (l) =>
      l.includes("merge failed for #1059 PR #1070") &&
      l.includes("PR mergeability is not yet computed (UNKNOWN)"),
  );
  assert.equal(
    unknownStop,
    undefined,
    "must not STOP the ship on first-attempt UNKNOWN when budget would succeed",
  );
  assert.ok(
    !result.status.items.some(
      (i) =>
        typeof i.error === "string" &&
        i.error.includes("PR mergeability is not yet computed (UNKNOWN)"),
    ),
    "item error must not be first-attempt UNKNOWN refuse after successful in-budget path",
  );
});

test("train merge: already-merged contained PR is idempotent", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "done", ["pipeline:ready-to-deploy"]));
  // Still on open map so open-only path finds it (pre-open-removal merge case).
  deps.seedPr(1, 101);
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

test("train merge: closed issue + merged PR + stale R2D is already-integrated (#1014)", async () => {
  // Bite: open-only getPrForIssue returns null after merge; without any-state
  // reconciliation the train hard-stops with "no linked open PR".
  const deps = makeDeps();
  deps.seedIssue(
    snap(927, "shipped", ["pipeline:ready-to-deploy"], "Issue 927", "closed"),
  );
  deps.seedMergedPrAnyState(927, 1009, "merge1009" + "0".repeat(31));

  const result = await runTrain(baseOpts({ issues: [927], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.equal(deps.advanceCalls.length, 0);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.status.items[0]!.terminal, "already-integrated");
  assert.equal(result.status.items[0]!.integrated, true);
  assert.equal(result.status.items[0]!.pr, 1009);
  assert.equal(result.status.complete, true);
  assert.equal(result.status.blocker, null);
});

test("train merge: closed+merged+R2D continues to next work-list item (#1014)", async () => {
  const deps = makeDeps();
  deps.seedIssue(
    snap(927, "shipped", ["pipeline:ready-to-deploy"], "Issue 927", "closed"),
  );
  deps.seedIssue(snap(1010, "next", ["pipeline:ready"]));
  deps.seedMergedPrAnyState(927, 1009, "merge1009" + "0".repeat(31));
  deps.seedPr(1010, 1012);

  const result = await runTrain(baseOpts({ issues: [927, 1010], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.equal(deps.mergeCalls.length, 1);
  assert.deepEqual(deps.mergeCalls, [1012]);
  assert.equal(result.status.items[0]!.terminal, "already-integrated");
  assert.equal(result.status.items[1]!.integrated, true);
});

test("train merge: open R2D + since-merged PR (any-state only) is already-integrated (#1014)", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "done", ["pipeline:ready-to-deploy"])); // open issue
  deps.seedMergedPrAnyState(1, 55, "merge55" + "0".repeat(33));

  const result = await runTrain(baseOpts({ issues: [1], merge: true }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.status.items[0]!.terminal, "already-integrated");
  assert.equal(result.status.items[0]!.integrated, true);
});

test("train merge: reopened pre-R2D issue with only historical merged PR advances (#1014 review)", async () => {
  // Bite: unrestricted any-state early reconciliation treated a reopened
  // pipeline:ready issue as already-integrated from its prior merged PR and
  // skipped unfinished work before advanceIssue. Any-state short-circuit is
  // R2D-only; pre-R2D must still advance.
  const deps = makeDeps();
  deps.seedIssue(snap(42, "new work after reopen", ["pipeline:ready"]));
  // Only historical merged timeline PR — no open PR yet.
  deps.seedMergedPrAnyState(42, 900, "merge900" + "0".repeat(32));

  const result = await runTrain(baseOpts({ issues: [42], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual(deps.advanceCalls, [42], "pre-R2D must advance, not skip as integrated");
  assert.equal(deps.mergeCalls.length, 0, "historical merged PR is not re-merged");
  // After advance reaches R2D with no new open PR, merge-wave may correctly
  // classify the historical merged PR as already-integrated. The bug was
  // skipping *before* advance.
  assert.equal(result.status.items[0]!.integrated, true);
  assert.equal(result.status.items[0]!.terminal, "already-integrated");
  assert.equal(result.status.items[0]!.pr, 900);
});

test("train merge: reopened pre-R2D with historical merged + new open PR merges new work (#1014 review)", async () => {
  // Same reopen scenario, but advance surfaces a new open PR for the new work.
  // Early any-state must not skip; the new open PR must be merged.
  const advanceCalls: number[] = [];
  const deps = makeDeps({
    async advanceIssue(n) {
      advanceCalls.push(n);
      const issues = (deps as unknown as { _issues: Map<number, TrainIssueSnapshot> })._issues;
      const s = issues.get(n)!;
      s.labels = ["pipeline:ready-to-deploy"];
      // New work PR appears only after advance (not present for early reconcile).
      deps.seedPr(n, 901);
      return { ok: true, terminal: "ready-to-deploy", labels: s.labels };
    },
  });
  deps.seedIssue(snap(42, "new work after reopen", ["pipeline:ready"]));
  deps.seedMergedPrAnyState(42, 900, "merge900" + "0".repeat(32));

  const result = await runTrain(baseOpts({ issues: [42], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual(advanceCalls, [42]);
  assert.deepEqual(deps.mergeCalls, [901]);
  assert.equal(result.status.items[0]!.pr, 901);
  assert.equal(result.status.items[0]!.integrated, true);
  assert.equal(result.status.items[0]!.terminal, "ready-to-deploy");
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

test("train merge: open-lookup race to merged + uncontained stops before merge (#1014 review-2)", async () => {
  // Bite: getPrForIssue still returns the PR (stale open) while observePr sees
  // merged with an OID not in base. Old code gated containment-failed on
  // openPr == null, so R2D continued to mergeIssuePr for an already-merged PR.
  const deps = makeDeps({
    async isAncestor() {
      return false;
    },
  });
  deps.seedIssue(snap(1, "done", ["pipeline:ready-to-deploy"]));
  deps.seedPr(1, 101);
  (
    deps as unknown as {
      _prState: Map<number, { state: string; oid: string; head: string }>;
    }
  )._prState.set(101, {
    state: "merged",
    oid: "merge101" + "0".repeat(33),
    head: "a".repeat(40),
  });

  const result = await runTrain(baseOpts({ issues: [1], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /not contained/);
  assert.ok(
    !/no linked open PR/.test(result.status.blocker ?? ""),
    "must be containment class, not no-open-PR",
  );
  assert.equal(deps.advanceCalls.length, 0);
  assert.equal(deps.mergeCalls.length, 0, "must not merge after uncontained merge observation");
  assert.equal(result.status.items[0]!.integrated, false);
  assert.equal(result.status.items[0]!.pr, 101);
});

test("train merge: pre-R2D open-lookup race merged uncontained stops before advance (#1014 review-2)", async () => {
  // Same race on a pre-R2D item: uncontained merge observation must stop the
  // train before advanceIssue mutates state.
  const deps = makeDeps({
    async isAncestor() {
      return false;
    },
  });
  deps.seedIssue(snap(1, "still in progress", ["pipeline:ready"]));
  deps.seedPr(1, 101);
  (
    deps as unknown as {
      _prState: Map<number, { state: string; oid: string; head: string }>;
    }
  )._prState.set(101, {
    state: "merged",
    oid: "merge101" + "0".repeat(33),
    head: "a".repeat(40),
  });

  const result = await runTrain(baseOpts({ issues: [1], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /not contained/);
  assert.equal(deps.advanceCalls.length, 0, "must not advance after uncontained merge");
  assert.equal(deps.mergeCalls.length, 0);
});

test("train: needs-human parks the train", async () => {
  const deps = makeDeps({
    async advanceIssue(_n) {
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
  assert.match(result.status.blocker ?? "", /needs-human|held/i);
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
    // Operator-authorized ship composition; never imported by advance dispatch.
    "ship-adapter.ts",
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
