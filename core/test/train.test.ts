// Tests for pipeline train (integrated train mode).
// Network- and subprocess-free: TrainDeps are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceWaveFromSingle,
  assertMilestoneIssueDiscoveryLimit,
  buildTrainStatus,
  computeBaseEligibleFrontier,
  emptyFreezeEligibleMilestoneError,
  isIndependentOfHeld,
  MILESTONE_ISSUE_DISCOVERY_LIMIT,
  orderIssuesByDeclaredDeps,
  orderIssuesForTrain,
  parseIssueList,
  pipelineStageFromLabels,
  runTrain,
  selectFreezeEligibleIssues,
  type AdvanceOutcome,
  type AdvanceWaveResult,
  type TrainDeps,
  type TrainIssueSnapshot,
  type TrainOpts,
} from "../scripts/stages/train.ts";
import {
  createTrainEventSession,
  TRAIN_EVENT_TYPES,
} from "../scripts/train-events.ts";
import {
  initRunDir,
  runIdFor,
  trainRunIdFor,
  type RunStoreDeps,
} from "../scripts/run-store.ts";
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

function memRunStore() {
  const files = new Map<string, string>();
  const appends = new Map<string, string[]>();
  const enoent = (p: string): NodeJS.ErrnoException => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  };
  const deps: RunStoreDeps = {
    readFile: async (p) => {
      const base = files.get(p) ?? "";
      const parts = appends.get(p) ?? [];
      if (!files.has(p) && parts.length === 0) throw enoent(p);
      return base + parts.join("");
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    appendFile: async (p, data) => {
      if (!appends.has(p)) appends.set(p, []);
      appends.get(p)!.push(data);
    },
    rename: async () => {
      throw new Error("unused");
    },
    mkdir: async () => {},
    readdir: async () => [],
    stat: async (p) => {
      if (!files.has(p) && !appends.has(p)) throw enoent(p);
      return { mtime: new Date(0) };
    },
  };
  function readFile(p: string): string {
    return (files.get(p) ?? "") + (appends.get(p) ?? []).join("");
  }
  return { files, appends, deps, readFile };
}

function trainEventsFromStore(store: ReturnType<typeof memRunStore>): Record<string, unknown>[] {
  const eventsPath = [...store.appends.keys(), ...store.files.keys()].find((p) =>
    /[/\\]train-[^/\\]+[/\\]events\.jsonl$/.test(p),
  );
  if (!eventsPath) return [];
  return store
    .readFile(eventsPath)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function trainEventsPath(store: ReturnType<typeof memRunStore>): string | undefined {
  return [...store.appends.keys(), ...store.files.keys()].find((p) =>
    /[/\\]train-[^/\\]+[/\\]events\.jsonl$/.test(p),
  );
}

function makeDeps(overrides: Partial<TrainDeps> = {}): TrainDeps & {
  advanceCalls: number[];
  waveCalls: number[][];
  mergeCalls: number[];
  fetchCalls: number;
  anyStateCalls: number[];
  store: ReturnType<typeof memRunStore>;
  handoffLines: string[];
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
  const store = memRunStore();
  const handoffLines: string[] = [];
  const defaultNow = () => new Date("2026-08-28T17:28:03.000Z");

  const base: TrainDeps = {
    log() {},
    runStore: store.deps,
    now: defaultNow,
    writeHandoff: (line) => {
      handoffLines.push(line.endsWith("\n") ? line : `${line}\n`);
    },
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
    store,
    handoffLines,
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
    store: ReturnType<typeof memRunStore>;
    handoffLines: string[];
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

  const mutations: Array<{ kind: "merge" | "advance"; id: number }> = [];
  const origMerge = deps.mergeIssuePr.bind(deps);
  const origWave = deps.advanceWave.bind(deps);
  deps.mergeIssuePr = async (pr) => {
    mutations.push({ kind: "merge", id: pr });
    return origMerge(pr);
  };
  deps.advanceWave = async (issues) => {
    for (const n of issues) mutations.push({ kind: "advance", id: n });
    return origWave(issues);
  };

  const result = await runTrain(baseOpts({ issues: [1061, 599], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.ok(mutations.length >= 1, "expected mutations");
  assert.deepEqual(mutations[0], { kind: "merge", id: 1058 }, "first mutation must be merge of already-R2D #A");
  const advanceB = mutations.findIndex((m) => m.kind === "advance" && m.id === 1061);
  const mergeA = mutations.findIndex((m) => m.kind === "merge" && m.id === 1058);
  assert.ok(mergeA !== -1 && (advanceB === -1 || mergeA < advanceB), "must not implement #B before merging #A");
  assert.ok(deps.mergeCalls[0] === 1058, "first merge is the already-R2D PR");
  assert.ok(deps.advanceCalls.includes(1061));
  assert.ok(!deps.advanceCalls.includes(599), "R2D item is not re-advanced");
});

test("train (#1096): merge-first fixture fails if ready sibling is implemented first", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1037, "already r2d", ["pipeline:ready-to-deploy"]));
  deps.seedIssue(snap(1095, "ready sibling", ["pipeline:ready"]));
  deps.seedPr(1037, 1094);
  deps.seedPr(1095, 1100);

  const mutations: Array<{ kind: "merge" | "advance"; id: number }> = [];
  const origMerge = deps.mergeIssuePr.bind(deps);
  const origWave = deps.advanceWave.bind(deps);
  deps.mergeIssuePr = async (pr) => {
    mutations.push({ kind: "merge", id: pr });
    return origMerge(pr);
  };
  deps.advanceWave = async (issues) => {
    for (const n of issues) mutations.push({ kind: "advance", id: n });
    return origWave(issues);
  };

  const result = await runTrain(baseOpts({ issues: [1037, 1095], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual(mutations[0], { kind: "merge", id: 1094 });
  const firstAdvance = mutations.find((m) => m.kind === "advance");
  assert.ok(firstAdvance === undefined || firstAdvance.id !== 1037);
  if (firstAdvance) {
    assert.equal(mutations[0].kind, "merge");
    assert.notEqual(firstAdvance.id, 1094);
  }
  assert.ok(!deps.advanceCalls.includes(1037));
  assert.ok(deps.mergeCalls.includes(1094));
});

test("train (#1096): leftover implementation-ci + live R2D merges A and does not implement B first", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const { extractTrainAdvanceLoopEvidence } = await import(
    "../scripts/stages/train-advance-stop-reason.ts"
  );
  const mutations: Array<{ kind: "merge" | "advance"; id: number }> = [];
  const deps = makeDeps({
    async advanceWave(issueList) {
      for (const n of issueList) mutations.push({ kind: "advance", id: n });
      const evidence = extractTrainAdvanceLoopEvidence({
        events: [
          {
            kind: "loop_item_blocked",
            data: { item_id: "1037", class: "implementation-ci" },
          },
          {
            kind: "loop_item_advance_finished",
            data: { item_id: "1037", outcome: "ready_to_deploy" },
          },
          { kind: "loop_run_complete", data: { outcome: "all_done" } },
        ],
      });
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        const issues = (deps as unknown as { _issues: Map<number, TrainIssueSnapshot> })._issues;
        issues.get(n)!.labels = ["pipeline:ready-to-deploy"];
        out.set(
          n,
          classifyTrainAdvanceLabels(
            { labels: ["pipeline:ready-to-deploy"] },
            0,
            evidence,
            n,
          ),
        );
      }
      return out;
    },
  });
  deps.seedIssue(snap(1037, "leftover ci then r2d", ["pipeline:ready-to-deploy"]));
  deps.seedIssue(snap(1095, "ready sibling", ["pipeline:ready"]));
  deps.seedPr(1037, 1094);
  deps.seedPr(1095, 1100);
  const origMerge = deps.mergeIssuePr.bind(deps);
  deps.mergeIssuePr = async (pr) => {
    mutations.push({ kind: "merge", id: pr });
    return origMerge(pr);
  };

  const result = await runTrain(baseOpts({ issues: [1037, 1095], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual(mutations[0], { kind: "merge", id: 1094 }, "first mutation must be merge of leftover-block R2D #A");
  assert.doesNotMatch(result.status.blocker ?? "", /implementation-ci/);
  const advanceB = mutations.findIndex((m) => m.kind === "advance" && m.id === 1095);
  const mergeA = mutations.findIndex((m) => m.kind === "merge" && m.id === 1094);
  assert.ok(mergeA !== -1 && (advanceB === -1 || mergeA < advanceB));
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

test("train merge: ready-to-deploy with merged (#N) pipeline PR is already-integrated (#1269)", async () => {
  // Bite: after ship train squash-merges `… (#N)` titles, open lookup is null
  // and GitHub records willCloseTarget=false. Any-state must still classify
  // the item already-integrated so resume does not STOP with no-open-PR.
  const deps = makeDeps();
  const items: Array<{ issue: number; pr: number; oid: string }> = [
    { issue: 1258, pr: 1262, oid: "merge1262" + "0".repeat(31) },
    { issue: 1259, pr: 1263, oid: "merge1263" + "0".repeat(31) },
    { issue: 1252, pr: 1267, oid: "merge1267" + "0".repeat(31) },
  ];
  for (const item of items) {
    deps.seedIssue(
      snap(item.issue, "merged", ["pipeline:ready-to-deploy"], `Issue ${item.issue}`),
    );
    deps.seedMergedPrAnyState(item.issue, item.pr, item.oid);
  }

  const result = await runTrain(
    baseOpts({ issues: items.map((i) => i.issue), merge: true }),
    deps,
  );
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.equal(deps.mergeCalls.length, 0, "must not invoke a merge mutation");
  assert.equal(deps.advanceCalls.length, 0);
  assert.ok(
    !/no linked open PR/.test(result.status.blocker ?? ""),
    "must not STOP with ready-to-deploy but has no linked open PR",
  );
  assert.equal(result.status.complete, true);
  assert.equal(result.status.blocker, null);
  assert.equal(result.status.items.length, 3);
  for (const [i, item] of items.entries()) {
    assert.equal(result.status.items[i]!.issue, item.issue);
    assert.equal(result.status.items[i]!.pr, item.pr);
    assert.equal(result.status.items[i]!.terminal, "already-integrated");
    assert.equal(result.status.items[i]!.integrated, true);
  }
  assert.deepEqual(deps.anyStateCalls.slice(0, 3), [1258, 1259, 1252]);
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

test("selectFreezeEligibleIssues: open non-backlog plus closed ready-to-deploy (#1252)", () => {
  const openReady = snap(1, "open", ["pipeline:ready"], "open ready", "open");
  const openR2d = snap(2, "open r2d", ["pipeline:ready-to-deploy"], "open r2d", "open");
  const openBacklog = snap(3, "backlog", ["pipeline:backlog"], "backlog", "open");
  const closedR2d = snap(4, "closed r2d", ["pipeline:ready-to-deploy"], "closed r2d", "closed");
  const closedCancelled = snap(5, "cancelled", [], "cancelled", "closed");
  const closedReady = snap(6, "closed ready", ["pipeline:ready"], "closed ready", "closed");
  const kept = selectFreezeEligibleIssues([
    openReady,
    openR2d,
    openBacklog,
    closedR2d,
    closedCancelled,
    closedReady,
  ]);
  assert.deepEqual(
    kept.map((s) => s.number),
    [1, 2, 4],
    "closed cancelled / closed non-R2D / open backlog must not enter freeze",
  );
});

test("train merge: all-closed R2D milestone is already-integrated, not no-open-issues (#1252)", async () => {
  const deps = makeDeps();
  deps.seedIssue(
    snap(927, "shipped", ["pipeline:ready-to-deploy"], "Issue 927", "closed"),
  );
  deps.seedMergedPrAnyState(927, 1009, "merge1009" + "0".repeat(31));

  const result = await runTrain(
    baseOpts({ issues: undefined, milestone: "v1.39.13", merge: true }),
    deps,
  );
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.equal(result.status.items[0]!.terminal, "already-integrated");
  assert.equal(result.status.items[0]!.integrated, true);
  assert.equal(deps.mergeCalls.length, 0);
  assert.doesNotMatch(result.status.blocker ?? "", /no open issues/);
});

test("train merge: mixed open mergeable + closed integrated in one milestone run (#1252)", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "open r2d", ["pipeline:ready-to-deploy"], "A", "open"));
  deps.seedIssue(
    snap(11, "closed r2d", ["pipeline:ready-to-deploy"], "B", "closed"),
  );
  deps.seedIssue(snap(12, "cancelled", [], "C", "closed"));
  deps.seedPr(10, 100);
  deps.seedMergedPrAnyState(11, 101, "merge101" + "0".repeat(33));

  const result = await runTrain(
    baseOpts({ issues: undefined, milestone: "v1.39.13", merge: true }),
    deps,
  );
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual([...result.status.ordered_issues].sort((a, b) => a - b), [10, 11]);
  assert.deepEqual(deps.mergeCalls, [100], "open mergeable PR must merge");
  const byIssue = new Map(result.status.items.map((item) => [item.issue, item]));
  assert.equal(byIssue.get(11)!.terminal, "already-integrated");
  assert.equal(byIssue.get(11)!.integrated, true);
  assert.equal(byIssue.get(10)!.integrated, true);
  assert.equal(
    result.status.items.filter((item) => item.issue === 11).length,
    1,
    "already-integrated item must not be merged a second time",
  );
});

test("train: empty freeze-eligible milestone fails closed, not open-only (#1252)", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () =>
      runTrain(
        baseOpts({ issues: undefined, milestone: "v-empty", merge: true }),
        deps,
      ),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /no freeze-eligible issues/);
      assert.doesNotMatch(msg, /no open issues/);
      assert.equal(msg, emptyFreezeEligibleMilestoneError("v-empty"));
      return true;
    },
  );
});

test("train: closed non-R2D-only milestone is empty freeze-eligible (#1252)", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "cancelled", [], "cancelled", "closed"));
  await assert.rejects(
    () =>
      runTrain(
        baseOpts({ issues: undefined, milestone: "v-cancelled", merge: true }),
        deps,
      ),
    /no freeze-eligible issues/,
  );
});

test("train merge: closed R2D without merged PR is not skipped at freeze (#1252)", async () => {
  const deps = makeDeps();
  deps.seedIssue(
    snap(8, "r2d no pr", ["pipeline:ready-to-deploy"], "no pr", "closed"),
  );
  const result = await runTrain(
    baseOpts({ issues: undefined, milestone: "v1.39.13", merge: true }),
    deps,
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /no linked open PR/);
  assert.equal(result.status.items[0]!.issue, 8);
  assert.equal(result.status.items[0]!.integrated, false);
});

test("assertMilestoneIssueDiscoveryLimit: 200-issue cap still fail-closed (#1252)", () => {
  assert.doesNotThrow(() =>
    assertMilestoneIssueDiscoveryLimit(199, "v1.39.13", "ship"),
  );
  assert.throws(
    () => assertMilestoneIssueDiscoveryLimit(200, "v1.39.13", "ship"),
    /ship train: milestone "v1\.39\.13" reached the 200-issue discovery limit/,
  );
  assert.throws(
    () =>
      assertMilestoneIssueDiscoveryLimit(
        MILESTONE_ISSUE_DISCOVERY_LIMIT,
        "v1.39.13",
        "train",
      ),
    /milestone "v1\.39\.13" reached the 200-issue discovery limit/,
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
// Dry-run plan (#1275)
// ---------------------------------------------------------------------------

test("train dry-run: --issues 10,11 is accepted and does not reject the flag", async () => {
  const logs: string[] = [];
  const deps = makeDeps({
    log(msg) {
      logs.push(msg);
    },
    async recoverParked() {
      throw new Error("dry-run must not recover-parked");
    },
  });
  deps.seedIssue(snap(10, "a"));
  deps.seedIssue(snap(11, "b independent"));

  const result = await runTrain(
    baseOpts({ issues: [10, 11], merge: false, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.plan?.kind, "train_plan");
  assert.doesNotMatch(logs.join("\n"), /--dry-run is not supported/);
  assert.equal(deps.waveCalls.length, 0);
  assert.equal(deps.mergeCalls.length, 0);
});

test("train dry-run: merge-mode R2D with open PR does not merge or advance", async () => {
  const deps = makeDeps({
    async recoverParked() {
      throw new Error("dry-run must not recover-parked");
    },
  });
  deps.seedIssue(snap(10, "approved", ["pipeline:ready-to-deploy"]));
  deps.seedPr(10, 20);

  const result = await runTrain(
    baseOpts({ issues: [10], merge: true, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(deps.mergeCalls.length, 0, "mergeIssuePr must not run");
  assert.equal(deps.waveCalls.length, 0, "advanceWave must not run");
  assert.equal(deps.fetchCalls, 0, "dry-run must not fetchBase");
  assert.equal(result.plan?.items[0]?.intended_action, "would-merge");
  assert.equal(result.plan?.items[0]?.pr, 20);
  assert.deepEqual(result.plan?.merge_first, [10]);
});

test("train dry-run: does not mint a run store or train_run_handoff", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "a"));
  deps.seedIssue(snap(11, "b"));

  const result = await runTrain(
    baseOpts({ issues: [10, 11], merge: false, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(trainEventsPath(deps.store), undefined);
  assert.deepEqual(trainEventsFromStore(deps.store), []);
  assert.equal(deps.handoffLines.length, 0);
  assert.equal(deps.store.files.size, 0);
  assert.equal(deps.store.appends.size, 0);
});

test("train dry-run: merge-mode classifies would-merge vs waiting-on-deps", async () => {
  const logs: string[] = [];
  const deps = makeDeps({
    log(msg) {
      logs.push(msg);
    },
  });
  deps.seedIssue(snap(279, "base", ["pipeline:ready-to-deploy"]));
  deps.seedIssue(snap(269, "Depends on: #279", ["pipeline:ready"]));
  deps.seedPr(279, 50);

  const result = await runTrain(
    baseOpts({ issues: [279, 269], merge: true, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.plan?.ordered_issues, [279, 269]);
  assert.deepEqual(result.plan?.merge_first, [279]);
  const byIssue = new Map(result.plan!.items.map((i) => [i.issue, i]));
  assert.equal(byIssue.get(279)?.intended_action, "would-merge");
  assert.equal(byIssue.get(279)?.pr, 50);
  assert.equal(byIssue.get(279)?.on_frontier, true);
  assert.equal(byIssue.get(269)?.intended_action, "waiting-on-deps");
  assert.equal(byIssue.get(269)?.on_frontier, false);

  const human = logs.join("\n");
  assert.match(human, /ordered issues: #279 → #269/);
  assert.match(human, /#279[\s\S]*PR #50[\s\S]*would-merge/);
  assert.match(human, /#269[\s\S]*waiting-on-deps/);
  assert.match(human, /no mutations performed|no merges were performed/);
});

test("train dry-run: non-merge never advertises would-merge", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "a"));
  deps.seedIssue(snap(11, "b independent"));

  const result = await runTrain(
    baseOpts({ issues: [10, 11], merge: false, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.plan?.merge_mode, false);
  assert.deepEqual(result.plan?.merge_first, []);
  for (const item of result.plan!.items) {
    assert.ok(
      item.intended_action === "would-advance" || item.intended_action === "waiting-on-deps",
      `unexpected action ${item.intended_action} for #${item.issue}`,
    );
    assert.notEqual(item.intended_action, "would-merge");
  }
});

test("train dry-run: already-merged R2D is already-integrated without fetchBase", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "landed", ["pipeline:ready-to-deploy"]));
  deps.seedMergedPrAnyState(10, 20);

  const result = await runTrain(
    baseOpts({ issues: [10], merge: true, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.plan?.items[0]?.intended_action, "already-integrated");
  assert.equal(result.plan?.items[0]?.pr, 20);
  assert.deepEqual(result.plan?.merge_first, []);
  assert.equal(deps.fetchCalls, 0);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.waveCalls.length, 0);
});

test("train dry-run: ready-to-deploy with no PR is would-block and still exits 0", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "approved", ["pipeline:ready-to-deploy"]));

  const result = await runTrain(
    baseOpts({ issues: [10], merge: true, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.plan?.items[0]?.intended_action, "would-block");
  assert.equal(result.plan?.items[0]?.pr, null);
  assert.equal(deps.mergeCalls.length, 0);
});

test("train dry-run: needs-human and blocked items are held", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "parked", ["pipeline:needs-human"]));
  deps.seedIssue(snap(11, "stuck", ["pipeline:ready", "blocked"]));

  const result = await runTrain(
    baseOpts({ issues: [10, 11], merge: false, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.plan?.ordered_issues, [10, 11]);
  const byIssue = new Map(result.plan!.items.map((i) => [i.issue, i]));
  assert.equal(byIssue.get(10)?.intended_action, "held");
  assert.equal(byIssue.get(11)?.intended_action, "held");
});

test("train dry-run: dependency cycle fails closed with no plan", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "Depends on: #11"));
  deps.seedIssue(snap(11, "Depends on: #10"));

  await assert.rejects(
    () => runTrain(baseOpts({ issues: [10, 11], merge: false, dryRun: true }), deps),
    /dependency validation/,
  );
  assert.equal(deps.waveCalls.length, 0);
  assert.equal(trainEventsPath(deps.store), undefined);
});

test("train dry-run: second snapshot matches the first", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "a"));
  deps.seedIssue(snap(11, "Depends on: #10"));

  const first = await runTrain(
    baseOpts({ issues: [10, 11], merge: false, dryRun: true }),
    deps,
  );
  const second = await runTrain(
    baseOpts({ issues: [10, 11], merge: false, dryRun: true }),
    deps,
  );
  assert.deepEqual(second.plan?.ordered_issues, first.plan?.ordered_issues);
  assert.deepEqual(
    second.plan?.items.map((i) => i.intended_action),
    first.plan?.items.map((i) => i.intended_action),
  );
});

test("train dry-run: omitting the flag still advances", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "a"));
  deps.seedIssue(snap(11, "b independent"));

  const result = await runTrain(baseOpts({ issues: [10, 11], merge: false }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(result.plan, undefined);
  assert.ok(deps.waveCalls.length > 0, "live train must still call advanceWave");
});

test("train dry-run: milestone freeze-eligible list is planned", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(10, "a"));
  deps.seedIssue(snap(11, "b independent"));

  const result = await runTrain(
    baseOpts({ issues: undefined, milestone: "v1.39.13", merge: false, dryRun: true }),
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.plan?.ordered_issues, [10, 11]);
  assert.equal(deps.waveCalls.length, 0);
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

// ---------------------------------------------------------------------------
// #1074 — train STOP quotes structured loop evidence (not exit-only)
// ---------------------------------------------------------------------------

test("train (#1074): supervisor_no_progress evidence appears in blocker and stays non-zero", async () => {
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, {
          ok: false,
          error: `advance failed for #${n}: supervisor_no_progress`,
        });
      }
      return out;
    },
  });
  deps.seedIssue(snap(1010, "work", ["pipeline:implementing"]));
  deps.seedPr(1010, 5010);

  const logs: string[] = [];
  deps.log = (m) => {
    logs.push(m);
  };

  const result = await runTrain(baseOpts({ issues: [1010], merge: false }), deps);
  assert.equal(result.exitCode, 1);
  assert.equal(result.status.complete, false);
  assert.match(result.status.blocker ?? "", /supervisor_no_progress/);
  assert.match(result.status.blocker ?? "", /1010/);
  assert.doesNotMatch(
    result.status.blocker ?? "",
    /^held: #1010: pipeline (?:single|advance) exited with code 1$/,
  );
  const item = result.status.items.find((i) => i.issue === 1010);
  assert.equal(item?.terminal, "error");
  assert.match(item?.error ?? "", /supervisor_no_progress/);
  assert.ok(logs.some((l) => /supervisor_no_progress/.test(l) && /STOP|park/.test(l)));
});

test("train (#1074): exit-only advance error does not invent a stop class", async () => {
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, {
          ok: false,
          error: `advance failed for #${n}: pipeline advance exited with code 1`,
        });
      }
      return out;
    },
  });
  deps.seedIssue(snap(42, "work", ["pipeline:ready"]));
  deps.seedPr(42, 142);

  const result = await runTrain(baseOpts({ issues: [42], merge: false }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /exited with code 1/);
  assert.doesNotMatch(
    result.status.blocker ?? "",
    /supervisor_no_progress|dependency_deadlock|recovery_exhausted/,
  );
  const item = result.status.items.find((i) => i.issue === 42);
  assert.match(item?.error ?? "", /exited with code 1/);
});

test("train (#1074): recovery_exhausted class + issue in held item error", async () => {
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, {
          ok: false,
          error: `advance failed for #${n}: recovery_exhausted on #${n}`,
        });
      }
      return out;
    },
  });
  deps.seedIssue(snap(839, "work", ["pipeline:fix"]));
  deps.seedPr(839, 1839);

  const result = await runTrain(baseOpts({ issues: [839], merge: false }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /recovery_exhausted/);
  assert.match(result.status.blocker ?? "", /839/);
  const item = result.status.items.find((i) => i.issue === 839);
  assert.match(item?.error ?? "", /recovery_exhausted/);
  assert.match(item?.error ?? "", /#839/);
});

test("train (#1095): merge-mode merges recovered-block-then-R2D and does not STOP on implementation-ci", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const { extractTrainAdvanceLoopEvidence } = await import(
    "../scripts/stages/train-advance-stop-reason.ts"
  );
  const deps = makeDeps({
    async advanceWave(issueList) {
      const evidence = extractTrainAdvanceLoopEvidence({
        events: [
          {
            kind: "loop_item_blocked",
            data: { item_id: "1037", class: "implementation-ci" },
          },
          {
            kind: "loop_item_advance_finished",
            data: { item_id: "1037", outcome: "ready_to_deploy" },
          },
          { kind: "loop_run_complete", data: { outcome: "all_done" } },
        ],
      });
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        const issues = (deps as unknown as { _issues: Map<number, TrainIssueSnapshot> })._issues;
        issues.get(n)!.labels = ["pipeline:ready-to-deploy"];
        out.set(
          n,
          classifyTrainAdvanceLabels(
            { labels: ["pipeline:ready-to-deploy"] },
            0,
            evidence,
            n,
          ),
        );
      }
      return out;
    },
  });
  deps.seedIssue(snap(1037, "recovered ci then r2d", ["pipeline:implementing"]));
  deps.seedPr(1037, 2095);

  const result = await runTrain(baseOpts({ issues: [1037], merge: true }), deps);
  assert.equal(result.exitCode, 0, result.status.blocker ?? "ok");
  assert.deepEqual(deps.mergeCalls, [2095]);
  assert.doesNotMatch(result.status.blocker ?? "", /implementation-ci/);
  const item = result.status.items.find((i) => i.issue === 1037);
  assert.notEqual(item?.terminal, "error");
  assert.doesNotMatch(item?.error ?? "", /implementation-ci on #1037/);
});

test("train (#1095): merge-mode does not merge a live blocked item on leftover class", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        const issues = (deps as unknown as { _issues: Map<number, TrainIssueSnapshot> })._issues;
        issues.get(n)!.labels = ["pipeline:implementing", "blocked"];
        out.set(
          n,
          classifyTrainAdvanceLabels(
            { labels: ["pipeline:implementing", "blocked"] },
            0,
            { blockedClass: "implementation-ci", blockedIssue: n },
            n,
          ),
        );
      }
      return out;
    },
  });
  deps.seedIssue(snap(1037, "still blocked", ["pipeline:implementing", "blocked"]));
  deps.seedPr(1037, 2095);

  const result = await runTrain(baseOpts({ issues: [1037], merge: true }), deps);
  assert.equal(result.exitCode, 1);
  assert.equal(deps.mergeCalls.length, 0);
  const item = result.status.items.find((i) => i.issue === 1037);
  assert.notEqual(item?.terminal, "ready-to-deploy");
});

test("train (#1074): held aggregation preserves enriched per-item reason", async () => {
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        if (n === 1) {
          out.set(n, {
            ok: false,
            error: "advance failed for #1: dependency_deadlock",
          });
        } else {
          // Peer also fails independently so both are held
          out.set(n, {
            ok: false,
            error: "advance failed for #2: supervisor_no_progress",
          });
        }
      }
      return out;
    },
  });
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);

  const result = await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  assert.equal(result.exitCode, 1);
  assert.match(result.status.blocker ?? "", /dependency_deadlock/);
  assert.match(result.status.blocker ?? "", /supervisor_no_progress/);
  assert.doesNotMatch(
    result.status.blocker ?? "",
    /^held: #1: pipeline advance exited with code 1; #2: pipeline advance exited with code 1$/,
  );
});

// ---------------------------------------------------------------------------
// Train structured event stream (#1277)
// ---------------------------------------------------------------------------

test("trainRunIdFor: train- prefix, distinct from issue-prefixed advance ids", () => {
  const at = new Date("2026-08-28T17:28:03.000Z");
  const trainId = trainRunIdFor(at);
  const advanceId = runIdFor(10, at);
  assert.equal(trainId, "train-2026-08-28T17-28-03-000Z");
  assert.equal(advanceId, "10-2026-08-28T17-28-03-000Z");
  assert.notEqual(trainId, advanceId);
  assert.ok(trainId.startsWith("train-"));
  assert.ok(!/^\d+-/.test(trainId), "train id must not collide with <issue>-… ids");
});

test("initRunDir train: run.json is not a fake single-issue advance record", async () => {
  const store = memRunStore();
  const runId = trainRunIdFor(new Date("2026-08-28T17:28:03.000Z"));
  const runDir = `/tmp/repo/.agent-pipeline/runs/${runId}`;
  await initRunDir(
    {
      runDir,
      runId,
      repo: "o/r",
      profile: null,
      startedAt: "2026-08-28T17:28:03.000Z",
      kind: "train",
      mergeMode: true,
      selector: { issues: [10, 11] },
      orderedIssues: [10, 11],
    },
    store.deps,
  );
  const meta = JSON.parse(store.readFile(`${runDir}/run.json`));
  assert.equal(meta.kind, "train");
  assert.equal(meta.merge_mode, true);
  assert.deepEqual(meta.ordered_issues, [10, 11]);
  assert.notEqual(meta.issue, 10, "train run.json must not identify as issue 10");
  assert.equal(meta.issue, undefined);
});

test("train appendEvent helper: monotonic seq 1,2,3 and unknown fields", async () => {
  const store = memRunStore();
  const runDir = "/tmp/repo/.agent-pipeline/runs/train-seq";
  const session = createTrainEventSession({
    runDir,
    runId: "train-seq",
    store: store.deps,
    now: () => new Date("2026-08-28T17:28:03.000Z"),
  });
  await session.append("run_start", { extra: "keep-me" });
  await session.append("train_work_list_resolved", { ordered_issues: [10, 11] });
  await session.append("run_complete", { final_state: "complete", elapsed_ms: 1 });
  const lines = store
    .readFile(`${runDir}/events.jsonl`)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.seq, 1);
  assert.equal(lines[1]!.seq, 2);
  assert.equal(lines[2]!.seq, 3);
  assert.equal(lines[0]!.extra, "keep-me");
  assert.equal(lines[0]!.schema_version, 1);
  assert.equal(lines[0]!.run_id, "train-seq");
  assert.equal(lines[0]!.type, "run_start");
});

test("train events: events.jsonl exists before the first advanceWave (#1277 1.1)", async () => {
  let sawEventsBeforeWave = false;
  const deps = makeDeps({
    async advanceWave(issueList) {
      sawEventsBeforeWave = trainEventsPath(deps.store) != null;
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, { ok: true, terminal: "ready-to-deploy", labels: ["pipeline:ready-to-deploy"] });
      }
      return out;
    },
  });
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);
  const result = await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(deps.waveCalls.length, 1);
  assert.ok(sawEventsBeforeWave, "train events.jsonl must exist before the first advanceWave");
  const eventsPath = trainEventsPath(deps.store);
  assert.ok(eventsPath, "expected a train-*/events.jsonl path");
  assert.match(eventsPath!, /[/\\]train-[^/\\]+[/\\]events\.jsonl$/);
});

test("train events: train_loop_linked records a confirmed wave loop id (#1277 1.2)", async () => {
  const loopId = "2026-08-28T17-28-03-000Z";
  const loopEvents = `/abs/state/runs/${loopId}/events.jsonl`;
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, { ok: true, terminal: "ready-to-deploy", labels: ["pipeline:ready-to-deploy"] });
      }
      out.loopRun = { runId: loopId, eventsPath: loopEvents };
      return out;
    },
  });
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);
  await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  const events = trainEventsFromStore(deps.store);
  const linked = events.find((e) => e.type === "train_loop_linked");
  assert.ok(linked, "train stream must contain train_loop_linked");
  assert.equal(linked!.loop_run_id, loopId);
  assert.equal(linked!.events, loopEvents);
  assert.ok(!events.some((e) => JSON.stringify(e).includes("/training")));
  assert.ok(!events.some((e) => JSON.stringify(e).includes("0 errors")));
});

test("train events: omits train_loop_linked when the loop store is unconfirmed", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);
  await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  const events = trainEventsFromStore(deps.store);
  assert.ok(!events.some((e) => e.type === "train_loop_linked"));
});

test("train events: train_run_handoff on stderr before the first wave (#1277 1.3)", async () => {
  let handoffBeforeWave = false;
  const deps = makeDeps({
    async advanceWave(issueList) {
      handoffBeforeWave = deps.handoffLines.some((line) => {
        try {
          const obj = JSON.parse(line) as { kind?: string; run_id?: string; events?: string };
          return obj.kind === "train_run_handoff" && typeof obj.run_id === "string" && typeof obj.events === "string";
        } catch {
          return false;
        }
      });
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        out.set(n, { ok: true, terminal: "ready-to-deploy", labels: ["pipeline:ready-to-deploy"] });
      }
      return out;
    },
  });
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);
  const result = await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  assert.ok(handoffBeforeWave, "train_run_handoff must flush before the first wave");
  assert.equal(result.status.run_id, "train-2026-08-28T17-28-03-000Z");
  const parsed = JSON.parse(deps.handoffLines[0]!) as {
    kind: string;
    run_id: string;
    events: string;
  };
  assert.equal(parsed.kind, "train_run_handoff");
  assert.equal(parsed.run_id, result.status.run_id);
  assert.ok(parsed.events.endsWith("events.jsonl"));
});

test("train events: STOP after init still writes run_complete (#1277 1.4)", async () => {
  const deps = makeDeps({
    async advanceIssue() {
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
  const events = trainEventsFromStore(deps.store);
  const complete = events.find((e) => e.type === "run_complete");
  assert.ok(complete, "events.jsonl must contain type run_complete after STOP");
  assert.equal(complete!.final_state, "stopped");
  assert.equal(typeof complete!.elapsed_ms, "number");
});

test("train events: missing selector creates no train run directory", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => runTrain(baseOpts({ issues: undefined, milestone: undefined }), deps),
    /requires --issues|--milestone/,
  );
  assert.equal(trainEventsPath(deps.store), undefined);
});

test("train events: non-merge catalog has work-list/wave/item types and no merge types", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);
  await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  const events = trainEventsFromStore(deps.store);
  const types = events.map((e) => e.type);
  for (const required of [
    "run_start",
    "train_work_list_resolved",
    "train_wave_started",
    "train_item_started",
    "train_item_completed",
    "train_pr_created",
    "train_wave_ended",
    "run_complete",
  ]) {
    assert.ok(types.includes(required), `missing ${required}`);
  }
  assert.ok(!types.includes("train_merge_attempted"));
  assert.ok(!types.includes("train_merge_proven"));
  assert.ok(!types.includes("train_merge_integrated"));
  const workList = events.find((e) => e.type === "train_work_list_resolved");
  assert.deepEqual(workList!.ordered_issues, [1, 2]);
  const started = events.find((e) => e.type === "train_item_started" && e.issue === 1);
  assert.ok(started);
  assert.equal(started!.schema_version, 1);
  assert.equal(typeof started!.seq, "number");
  assert.equal(started!.run_id, "train-2026-08-28T17-28-03-000Z");
  assert.ok(typeof started!.at === "string" && started!.at.includes("T"));
});

test("train events: merge-mode catalog records attempted, proven, integrated", async () => {
  const deps = makeDeps();
  deps.seedIssue(snap(1, "a", ["pipeline:ready-to-deploy"]));
  deps.seedPr(1, 20);
  await runTrain(baseOpts({ issues: [1], merge: true }), deps);
  const events = trainEventsFromStore(deps.store);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("train_merge_attempted"), "missing train_merge_attempted");
  assert.ok(types.includes("train_merge_proven"), "missing train_merge_proven");
  assert.ok(types.includes("train_merge_integrated"), "missing train_merge_integrated");
  const attempted = events.find((e) => e.type === "train_merge_attempted");
  assert.equal(attempted!.issue, 1);
  assert.equal(attempted!.pr, 20);
});

test("train events: sibling halt is recorded while independents continue", async () => {
  const deps = makeDeps({
    async advanceWave(issueList) {
      const out: AdvanceWaveResult = new Map();
      for (const n of issueList) {
        if (n === 1) {
          out.set(n, {
            ok: true,
            terminal: "needs-human",
            labels: ["pipeline:needs-human"],
          });
        } else {
          out.set(n, {
            ok: true,
            terminal: "ready-to-deploy",
            labels: ["pipeline:ready-to-deploy"],
          });
        }
      }
      return out;
    },
  });
  deps.seedIssue(snap(1, "a"));
  deps.seedIssue(snap(2, "b independent"));
  deps.seedPr(1, 101);
  deps.seedPr(2, 102);
  await runTrain(baseOpts({ issues: [1, 2], merge: false }), deps);
  const events = trainEventsFromStore(deps.store);
  const halted = events.find((e) => e.type === "train_sibling_halted");
  assert.ok(halted, "expected train_sibling_halted");
  assert.equal(halted!.issue, 1);
  assert.ok(events.some((e) => e.type === "train_item_completed" && e.issue === 2));
});

test("train events: TRAIN_EVENT_TYPES catalog is closed", () => {
  assert.deepEqual([...TRAIN_EVENT_TYPES], [
    "run_start",
    "train_work_list_resolved",
    "train_wave_started",
    "train_loop_linked",
    "train_item_started",
    "train_item_completed",
    "train_pr_created",
    "train_merge_attempted",
    "train_merge_proven",
    "train_merge_integrated",
    "train_sibling_halted",
    "train_wave_ended",
    "run_complete",
  ]);
});
