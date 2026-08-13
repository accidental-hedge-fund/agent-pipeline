// #1021 / #1028 engine-class live sibling auto-file

import assert from "node:assert/strict";
import test from "node:test";
import {
  autoFileEngineClassLiveSibling,
  countsTowardEngineClassLiveSiblingRateCap,
  ENGINE_CLASS_LIVE_SIBLING_LABELS,
  ENGINE_CLASS_LIVE_SIBLING_MARKER,
  engineClassLiveSiblingBody,
  engineClassLiveSiblingTitle,
  type EngineClassLiveSiblingDeps,
  type OpenSiblingIssue,
} from "../scripts/stages/engine-class-live-sibling.ts";
import { BACKLOG_LABEL } from "../scripts/open-soak-defect-preflight.ts";

function makeDeps(seed: OpenSiblingIssue[] = []): EngineClassLiveSiblingDeps & {
  createCalls: Array<{ title: string; body: string; labels: string[]; milestone?: string }>;
  closed: number[];
  issues: OpenSiblingIssue[];
} {
  const issues = [...seed];
  const createCalls: Array<{ title: string; body: string; labels: string[]; milestone?: string }> = [];
  const closed: number[] = [];
  let nextNum = 9000;
  return {
    createCalls,
    closed,
    issues,
    listOpenImproveIssues: async () => issues,
    createIssue: async (title, body, labels, options) => {
      createCalls.push({ title, body, labels, milestone: options?.milestone });
      const n = nextNum++;
      issues.push({
        number: n,
        title,
        body,
        state: "OPEN",
        labels,
        createdAt: new Date().toISOString(),
        milestone: options?.milestone ?? null,
      });
      return `https://github.com/o/r/issues/${n}`;
    },
    closeIssue: async (number) => {
      closed.push(number);
      const i = issues.find((x) => x.number === number);
      if (i) i.state = "CLOSED";
    },
    ghAuthCheck: async () => true,
    now: () => Date.now(),
    withLock: async (_d, fn) => fn(),
    log() {},
  };
}

function siblingIssue(
  number: number,
  evidenceKey: string,
  createdAt: string,
  state: "OPEN" | "CLOSED" = "OPEN",
): OpenSiblingIssue {
  return {
    number,
    title: engineClassLiveSiblingTitle(evidenceKey),
    body: engineClassLiveSiblingBody({ recoveredIssue: 1, evidenceKey }),
    state,
    labels: [...ENGINE_CLASS_LIVE_SIBLING_LABELS],
    createdAt,
    milestone: null,
  };
}

test("labels are ready + engine-class + bug, never backlog", () => {
  assert.ok(ENGINE_CLASS_LIVE_SIBLING_LABELS.includes("pipeline:ready"));
  assert.ok(ENGINE_CLASS_LIVE_SIBLING_LABELS.includes("bug"));
  assert.ok(!ENGINE_CLASS_LIVE_SIBLING_LABELS.includes(BACKLOG_LABEL as never));
});

test("body declares Depends on recovered issue and marker", () => {
  const body = engineClassLiveSiblingBody({
    recoveredIssue: 1013,
    evidenceKey: "ek-1",
    milestone: "v1.38.1",
  });
  assert.ok(body.includes(ENGINE_CLASS_LIVE_SIBLING_MARKER));
  assert.match(body, /Depends on: #1013/);
  assert.match(body, /v1\.38\.1/);
});

test("files one sibling per evidence_key with milestone", async () => {
  const deps = makeDeps();
  const r1 = await autoFileEngineClassLiveSibling(
    {
      recoveredIssue: 10,
      evidenceKey: "fp-abc",
      milestone: "v1.38.1",
      domain: "test",
      windowHours: 24,
      maxPerWindow: 3,
    },
    deps,
  );
  assert.equal(r1.filed, true);
  assert.equal(deps.createCalls.length, 1);
  assert.deepEqual(deps.createCalls[0]!.labels, [...ENGINE_CLASS_LIVE_SIBLING_LABELS]);
  assert.equal(deps.createCalls[0]!.milestone, "v1.38.1");
  assert.match(deps.createCalls[0]!.body, /Depends on: #10/);

  const r2 = await autoFileEngineClassLiveSibling(
    {
      recoveredIssue: 10,
      evidenceKey: "fp-abc",
      milestone: "v1.38.1",
      domain: "test",
      windowHours: 24,
      maxPerWindow: 3,
    },
    deps,
  );
  assert.equal(r2.filed, false);
  assert.equal(r2.skippedReason, "duplicate evidence_key");
  assert.equal(deps.createCalls.length, 1, "no second create");
});

test("no milestone does not invent one", async () => {
  const deps = makeDeps();
  await autoFileEngineClassLiveSibling(
    {
      recoveredIssue: 5,
      evidenceKey: "fp-x",
      milestone: null,
      domain: "test",
      windowHours: 24,
      maxPerWindow: 3,
    },
    deps,
  );
  assert.equal(deps.createCalls[0]!.milestone, undefined);
});

test("title is stable for evidence key", () => {
  assert.equal(
    engineClassLiveSiblingTitle("k"),
    engineClassLiveSiblingTitle("k"),
  );
});

test("countsTowardEngineClassLiveSiblingRateCap: open + marker + in-window only", () => {
  const now = Date.now();
  const cutoff = now - 24 * 3600_000;
  const open = siblingIssue(1, "k1", new Date(now - 1000).toISOString());
  assert.equal(countsTowardEngineClassLiveSiblingRateCap(open, cutoff), true);
  assert.equal(
    countsTowardEngineClassLiveSiblingRateCap(
      { ...open, state: "CLOSED" },
      cutoff,
    ),
    false,
  );
  assert.equal(
    countsTowardEngineClassLiveSiblingRateCap(
      { ...open, body: "no marker" },
      cutoff,
    ),
    false,
  );
  assert.equal(
    countsTowardEngineClassLiveSiblingRateCap(
      siblingIssue(2, "k2", new Date(cutoff - 1000).toISOString()),
      cutoff,
    ),
    false,
  );
});

test("post-create rate-cap reconcile closes excess distinct-key siblings (cross-host overshoot)", async () => {
  // Two hosts each pass pre-create (cap free on host-local view) and create
  // distinct evidence keys. Post-create must enforce the category-wide window
  // cap: keep lowest-numbered open survivor(s), close the rest.
  const now = Date.now();
  const deps = makeDeps();
  let listPhase = 0;
  const concurrentPeer = siblingIssue(
    50,
    "fp-host-b-earlier",
    new Date(now - 200).toISOString(),
  );
  const baseList = deps.listOpenImproveIssues;
  deps.listOpenImproveIssues = async () => {
    listPhase += 1;
    const current = await baseList();
    // Phase 1 = pre-create: empty (both hosts saw cap free).
    // Phase 2+ = post-create: inject concurrent host's distinct-key issue with
    // a lower number so reconcile keeps it and closes our create.
    if (listPhase === 1) return [];
    if (!current.some((i) => i.number === concurrentPeer.number)) {
      current.push(concurrentPeer);
    }
    return current;
  };

  const result = await autoFileEngineClassLiveSibling(
    {
      recoveredIssue: 10,
      evidenceKey: "fp-host-a-new",
      milestone: "v1.38.1",
      domain: "test",
      windowHours: 24,
      maxPerWindow: 1,
    },
    deps,
  );
  assert.equal(result.filed, true);
  assert.equal(deps.createCalls.length, 1);
  // Lowest number (#50 concurrent) survives; our create (#9000) is overflow.
  assert.ok(
    deps.closed.includes(result.issueNumber!),
    `rate-cap overflow must close the higher-numbered sibling; closed=${deps.closed.join(",")}`,
  );
  assert.equal(concurrentPeer.state, "OPEN", "lowest-numbered survivor stays open");
});

test("post-create rate-cap reconcile keeps maxPerWindow lowest-numbered survivors", async () => {
  const now = Date.now();
  // After create of #9000, surface three other in-window marked siblings so
  // total open marked = 4 with maxPerWindow=2 → close the two highest.
  const peers = [
    siblingIssue(10, "k-a", new Date(now - 3000).toISOString()),
    siblingIssue(20, "k-b", new Date(now - 2000).toISOString()),
    siblingIssue(30, "k-c", new Date(now - 1000).toISOString()),
  ];
  const deps = makeDeps();
  let listPhase = 0;
  const baseList = deps.listOpenImproveIssues;
  deps.listOpenImproveIssues = async () => {
    listPhase += 1;
    const current = await baseList();
    if (listPhase === 1) return [];
    for (const p of peers) {
      if (!current.some((i) => i.number === p.number)) current.push(p);
    }
    return current;
  };

  const result = await autoFileEngineClassLiveSibling(
    {
      recoveredIssue: 99,
      evidenceKey: "k-new",
      domain: "test",
      windowHours: 24,
      maxPerWindow: 2,
    },
    deps,
  );
  assert.equal(result.filed, true);
  // Survivors: #10, #20. Closed: #30 and #9000 (created).
  assert.ok(deps.closed.includes(30));
  assert.ok(deps.closed.includes(result.issueNumber!));
  assert.ok(!deps.closed.includes(10));
  assert.ok(!deps.closed.includes(20));
});
