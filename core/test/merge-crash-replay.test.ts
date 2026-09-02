// Fresh-process crash fixtures for exact-candidate merge (#1330).
// Injected observer/mutation deps only. Real network, git, and subprocess fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runMergeAttempt,
  type MergeDeps,
  type RequiredCheck,
} from "../scripts/stages/merge.ts";
import {
  bindMergeClaim,
  mergeClaimKey,
  memoryMergeClaimStore,
  type MergeRemoteObservation,
  type MergeSupervisionContext,
} from "../scripts/stages/merge-supervision.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE_OID = "cccccccccccccccccccccccccccccccccccccccc";
const REPO = "acme/agent-pipeline";
const FORBIDDEN_IO = "crash tests must not perform real network, git, or subprocess";

function liveOpen(): MergeRemoteObservation {
  return { state: "open", mergeCommitOid: null, headRefOid: HEAD };
}

function liveMerged(): MergeRemoteObservation {
  return {
    state: "merged",
    mergeCommitOid: MERGE_OID,
    headRefOid: HEAD,
    mergedAt: "2026-09-02T00:00:00Z",
  };
}

function crashDeps(input: {
  store: ReturnType<typeof memoryMergeClaimStore>;
  live: MergeRemoteObservation;
  contained: boolean;
  crashBeforeSubmit?: () => void;
  crashAfterSubmit?: () => void;
  mergeImpl?: MergeDeps["ghPrMerge"];
}): MergeDeps & { mergeCalls: Array<{ pr: number; headRefOid: string }> } {
  const mergeCalls: Array<{ pr: number; headRefOid: string }> = [];
  const supervision: MergeSupervisionContext = {
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    envelope: "pipeline merge",
    actionIdentity: "pipeline merge 42",
    claimStore: input.store,
    observeMergedPr: async () => input.live,
    async fetchBase() {},
    async baseTip() {
      return "d".repeat(40);
    },
    async isAncestor() {
      return input.contained;
    },
    crashBeforeSubmit: input.crashBeforeSubmit,
    crashAfterSubmit: input.crashAfterSubmit,
  };
  const deps: MergeDeps & { mergeCalls: Array<{ pr: number; headRefOid: string }> } = {
    mergeCalls,
    async ghPrView() {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: HEAD,
        state: input.live.state === "merged" ? "MERGED" : "OPEN",
        mergedAt: input.live.mergedAt ?? null,
        mergeCommit: input.live.mergeCommitOid
          ? { oid: input.live.mergeCommitOid }
          : null,
      };
    },
    async ghPrChecksRequired(): Promise<RequiredCheck[]> {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll(): Promise<RequiredCheck[]> {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrMerge(pr, headRefOid) {
      if (input.mergeImpl) return input.mergeImpl(pr, headRefOid);
      mergeCalls.push({ pr, headRefOid });
    },
    async getIssueLabels() {
      return ["pipeline:ready-to-deploy"];
    },
    async getPrLinkedIssue() {
      return 100;
    },
    async getPrForIssue() {
      return 42;
    },
    log() {},
    async sleep() {
      throw new Error(FORBIDDEN_IO);
    },
    supervision,
  };
  return deps;
}

test("5.1 crash before submission does not merge until gates re-prove the same head", async () => {
  const store = memoryMergeClaimStore();
  const first = crashDeps({
    store,
    live: liveOpen(),
    contained: false,
    crashBeforeSubmit: () => {
      throw new Error("injected crash before ghPrMerge");
    },
  });
  await assert.rejects(() => runMergeAttempt(42, first), /injected crash before/);
  assert.equal(first.mergeCalls.length, 0);
  const started = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(started?.outcome, "started");
  assert.equal(started?.inspected_head, HEAD);

  const second = crashDeps({ store, live: liveOpen(), contained: false });
  const result = await runMergeAttempt(42, second);
  assert.equal(result.kind, "complete");
  assert.equal(second.mergeCalls.length, 1);
  assert.equal(second.mergeCalls[0]!.headRefOid, HEAD);
  assert.equal(result.observation.human_owned, false);
  assert.equal(result.observation.cancelled, false);
});

test("5.2 crash after submission reconciles and does not remarge when postcondition is proven", async () => {
  const store = memoryMergeClaimStore();
  let remote = liveOpen();
  const first = crashDeps({
    store,
    live: remote,
    contained: false,
    crashAfterSubmit: () => {
      throw new Error("injected crash after ghPrMerge");
    },
    async mergeImpl(pr, headRefOid) {
      first.mergeCalls.push({ pr, headRefOid });
      remote = liveMerged();
    },
  });
  await assert.rejects(() => runMergeAttempt(42, first), /injected crash after/);
  assert.equal(first.mergeCalls.length, 1);
  const mid = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(mid?.outcome, "started");

  const second = crashDeps({ store, live: remote, contained: true });
  const result = await runMergeAttempt(42, second);
  assert.equal(result.kind, "complete");
  assert.equal(result.observation.complete, true);
  assert.equal(second.mergeCalls.length, 0, "must not submit a second merge");
});

test("5.3 crash after response persistence does not remarge a known-complete claim", async () => {
  const store = memoryMergeClaimStore();
  const claim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
  });
  await store.save({ ...claim, outcome: "complete" });
  const deps = crashDeps({ store, live: liveMerged(), contained: true });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "complete");
  assert.equal(deps.mergeCalls.length, 0);
  const again = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(again?.outcome, "complete");
});

test("5.4 crash tests perform no real network, git, or subprocess", () => {
  const src = fs.readFileSync(
    path.join(here, "merge-crash-replay.test.ts"),
    "utf8",
  );
  const importLines = src
    .split("\n")
    .filter((line) => /^\s*import\s/.test(line))
    .join("\n");
  assert.doesNotMatch(importLines, /child_process/);
  assert.doesNotMatch(importLines, /node:https/);
  assert.doesNotMatch(importLines, /node:net/);
  assert.doesNotMatch(src, /\bspawnSync\(/);
  assert.doesNotMatch(src, /\bexecFile\(/);
  assert.match(src, /FORBIDDEN_IO/);
});
