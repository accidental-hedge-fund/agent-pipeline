// #1021 / #1028 engine-class live sibling auto-file

import assert from "node:assert/strict";
import test from "node:test";
import {
  autoFileEngineClassLiveSibling,
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
} {
  const issues = [...seed];
  const createCalls: Array<{ title: string; body: string; labels: string[]; milestone?: string }> = [];
  let nextNum = 9000;
  return {
    createCalls,
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
      const i = issues.find((x) => x.number === number);
      if (i) i.state = "CLOSED";
    },
    ghAuthCheck: async () => true,
    now: () => Date.now(),
    withLock: async (_d, fn) => fn(),
    log() {},
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
