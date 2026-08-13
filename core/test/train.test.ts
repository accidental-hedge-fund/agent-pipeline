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
  parseIssueList,
  pipelineStageFromLabels,
  runTrain,
  type AdvanceOutcome,
  type AdvanceWaveResult,
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

test("train (#1023): independent R2D sibling merges while peer is parked", async () => {
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
  // Peer #1 parked; independent #2 must still merge.
  assert.ok(deps.mergeCalls.includes(102), "independent sibling PR must merge");
  assert.ok(!deps.mergeCalls.includes(101), "parked item must not merge");
  assert.equal(result.exitCode, 1, "held peer still stops train after independents finish");
  assert.match(result.status.blocker ?? "", /held|#1|needs-human/i);
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
