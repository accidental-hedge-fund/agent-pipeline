// Shared merge invariant, exact-candidate claims, owned faults (#1330).
// Injected gh/git/observer seams only. No real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergePr,
  runMergeAttempt,
  type MergeDeps,
  type RequiredCheck,
} from "../scripts/stages/merge.ts";
import {
  MERGE_COOLING_MS,
  MERGE_OPERATION_INVARIANT,
  assertOperatorMergeEnvelope,
  bindMergeClaim,
  claimInvalidationReason,
  classifyMergeFault,
  decideMergeReplay,
  fileMergeClaimStore,
  frozenIssueScopeMatchesLinkedIssue,
  mergeAuthorityFromConfig,
  mergeAuthorityFromRecoverParked,
  mergeClaimKey,
  mergeClaimsCasEqual,
  mergeObservation,
  mergeOperationInvariant,
  memoryMergeClaimStore,
  transitionMergeClaim,
  type MergeClaim,
  type MergeRemoteObservation,
  type MergeSupervisionContext,
} from "../scripts/stages/merge-supervision.ts";
import * as os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_OID = "cccccccccccccccccccccccccccccccccccccccc";
const REPO = "acme/agent-pipeline";

function makeMergeDeps(overrides: Partial<MergeDeps> = {}): MergeDeps & {
  mergeCalls: Array<{ pr: number; headRefOid: string }>;
  viewCalls: number;
} {
  const mergeCalls: Array<{ pr: number; headRefOid: string }> = [];
  let viewCalls = 0;
  const userView = overrides.ghPrView;
  const userMerge = overrides.ghPrMerge;
  const base: MergeDeps = {
    async ghPrView(pr, fields) {
      viewCalls += 1;
      if (userView) return userView(pr, fields);
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: HEAD,
        baseRefName: "main",
      };
    },
    async ghPrChecksRequired(): Promise<RequiredCheck[]> {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll(): Promise<RequiredCheck[]> {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrMerge(pr, headRefOid) {
      if (userMerge) return userMerge(pr, headRefOid);
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
    async sleep() {},
  };
  const {
    ghPrView: _v,
    ghPrMerge: _m,
    ...rest
  } = overrides;
  Object.assign(base, rest);
  const out = Object.assign(base, { mergeCalls }) as MergeDeps & {
    mergeCalls: Array<{ pr: number; headRefOid: string }>;
    viewCalls: number;
  };
  Object.defineProperty(out, "viewCalls", {
    enumerable: true,
    get() {
      return viewCalls;
    },
  });
  return out;
}

function liveOpen(head = HEAD): MergeRemoteObservation {
  return { state: "open", mergeCommitOid: null, headRefOid: head };
}

function liveMerged(head = HEAD, oid = MERGE_OID): MergeRemoteObservation {
  return { state: "merged", mergeCommitOid: oid, headRefOid: head, mergedAt: "2026-09-02T00:00:00Z" };
}

function supervision(
  store: ReturnType<typeof memoryMergeClaimStore>,
  opts: {
    live?: MergeRemoteObservation | (() => MergeRemoteObservation);
    contained?: boolean;
    envelope?: MergeSupervisionContext["envelope"];
    crashBeforeSubmit?: () => void;
    crashAfterSubmit?: () => void;
    observe?: () => Promise<MergeRemoteObservation>;
    now?: () => Date;
  } = {},
): MergeSupervisionContext {
  return {
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    envelope: opts.envelope ?? "pipeline merge",
    actionIdentity: "pipeline merge 42",
    claimStore: store,
    observeMergedPr:
      opts.observe ??
      (async () => {
        const src = opts.live;
        return typeof src === "function" ? src() : (src ?? liveOpen());
      }),
    async fetchBase() {},
    async baseTip() {
      return "d".repeat(40);
    },
    async isAncestor() {
      return opts.contained === true;
    },
    crashBeforeSubmit: opts.crashBeforeSubmit,
    crashAfterSubmit: opts.crashAfterSubmit,
    now: opts.now,
  };
}

test("1.1 merge operation invariant round-trips and process exit is not completion", () => {
  const invariant = mergeOperationInvariant();
  assert.equal(invariant.operation, MERGE_OPERATION_INVARIANT.operation);
  assert.match(invariant.precondition, /MERGEABLE/);
  assert.match(invariant.postcondition, /contained/);
  assert.match(invariant.observer, /GitHub pull-request merge state/);
  assert.match(invariant.candidate_binding, /inspected head/);
  assert.match(invariant.replay_rule, /observe PR state/);
  const obs = mergeObservation({
    pr: 42,
    repository: REPO,
    certainty: "uncertain",
    lifecycle: "cooling",
    complete: false,
    fault: "timeout",
    message: "timed out",
    claim: null,
  });
  assert.equal(obs.process_exit_is_completion, false);
  assert.equal(obs.complete, false);
  assert.equal(obs.human_owned, false);
  assert.equal(obs.cancelled, false);
});

test("1.2 merge is refused if the exact-candidate claim is not persisted", async () => {
  const store: ReturnType<typeof memoryMergeClaimStore> = {
    map: new Map(),
    async load() {
      return null;
    },
    async save() {
      /* swallow — claim never lands */
    },
    async compareAndSwap() {
      return null;
    },
  };
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen() }),
  });
  await assert.rejects(
    () => mergePr(42, deps),
    /claim was not persisted/,
  );
  assert.equal(deps.mergeCalls.length, 0);
});

test("1.2 claim is bound before ghPrMerge", async () => {
  const store = memoryMergeClaimStore();
  let live = liveOpen();
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: () => live, contained: true }),
    async ghPrMerge(pr, headRefOid) {
      const claim = await store.load(mergeClaimKey(REPO, pr));
      assert.ok(claim, "claim must exist before ghPrMerge");
      assert.equal(claim!.outcome, "submitted");
      assert.equal(claim!.inspected_head, headRefOid);
      assert.equal(claim!.repository, REPO);
      assert.equal(claim!.base, "main");
      assert.deepEqual(claim!.frozen_issue_scope, [100]);
      assert.equal(claim!.pr, 42);
      assert.equal(claim!.action_identity, "pipeline merge 42");
      live = liveMerged();
      deps.mergeCalls.push({ pr, headRefOid });
    },
  });
  await mergePr(42, deps);
  assert.equal(deps.mergeCalls.length, 1);
  const done = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(done?.outcome, "complete");
});

test("1.3 claim binds MERGEABLE+CLEAN head, not an earlier UNKNOWN read", async () => {
  const store = memoryMergeClaimStore();
  let live = liveOpen(HEAD2);
  let views = 0;
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: () => live, contained: true }),
    async ghPrView() {
      views += 1;
      if (views === 1) {
        return {
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          headRefOid: HEAD,
          baseRefName: "main",
        };
      }
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: HEAD2,
        baseRefName: "main",
      };
    },
    async ghPrMerge(pr, headRefOid) {
      live = liveMerged(HEAD2);
      deps.mergeCalls.push({ pr, headRefOid });
    },
  });
  await mergePr(42, deps);
  assert.equal(deps.mergeCalls.length, 1);
  assert.equal(deps.mergeCalls[0]!.headRefOid, HEAD2);
  const claim = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(claim?.inspected_head, HEAD2);
  assert.notEqual(claim?.inspected_head, HEAD);
});

test("1.4 standalone pipeline merge still runs existing gates", async () => {
  const deps = makeMergeDeps({
    async ghPrView() {
      return {
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        headRefOid: HEAD,
      };
    },
  });
  await assert.rejects(() => mergePr(42, deps), /CONFLICTING/);
  assert.equal(deps.mergeCalls.length, 0);
});

test("2.1 already-merged contained PR does not call ghPrMerge a second time", async () => {
  const store = memoryMergeClaimStore();
  const claim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
  });
  await store.save({ ...claim, outcome: "started" });
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveMerged(), contained: true }),
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "complete");
  assert.equal(result.observation.complete, true);
  assert.equal(deps.mergeCalls.length, 0);
});

test("2.2 timeout maps to uncertain and the next attempt observes before replay", async () => {
  const store = memoryMergeClaimStore();
  const first = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen() }),
    async ghPrMerge() {
      throw new Error("gh pr merge failed: timed out after 60000ms");
    },
  });
  const owned = await runMergeAttempt(42, first);
  assert.equal(owned.kind, "owned");
  assert.equal(owned.observation.certainty, "uncertain");
  assert.equal(owned.observation.fault, "timeout");
  assert.equal(owned.observation.human_owned, false);
  assert.equal(owned.observation.complete, false);

  const second = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen() }),
  });
  const waited = await runMergeAttempt(42, second);
  assert.equal(waited.kind, "owned");
  assert.equal(waited.observation.certainty, "uncertain");
  assert.equal(second.mergeCalls.length, 0, "must observe; must not replay while uncertain");
});

test("2.3 stale head refuses merge under the old claim SHA", async () => {
  const store = memoryMergeClaimStore();
  const stale = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
  });
  await store.save(stale);
  const reason = claimInvalidationReason(stale, {
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    headRefOid: HEAD2,
  });
  assert.equal(reason, "head_drift");

  let live = liveOpen(HEAD2);
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: () => live, contained: true }),
    async ghPrView() {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: HEAD2,
        baseRefName: "main",
      };
    },
    async ghPrMerge(pr, headRefOid) {
      live = liveMerged(HEAD2);
      deps.mergeCalls.push({ pr, headRefOid });
    },
  });
  await mergePr(42, deps);
  assert.ok(
    !deps.mergeCalls.some((c) => c.headRefOid === HEAD),
    "must not submit --match-head-commit for the stale SHA",
  );
  if (deps.mergeCalls.length > 0) {
    assert.equal(deps.mergeCalls[0]!.headRefOid, HEAD2);
  }
});

test("2.4 six merge fault classes stay owned, not ownerless STOP", () => {
  const classes = [
    ["PR has merge conflicts (mergeable: CONFLICTING).", "conflict"],
    ["PR has failing or pending required checks:\n  - ci (fail)", "check_drift"],
    ["inspected head moved; stale claim", "head_drift"],
    ["PR mergeability is not yet computed (UNKNOWN).", "unknown_mergeability"],
    ["gh pr merge failed: timed out", "timeout"],
    ["gh pr merge failed: unreadable response", "uncertain_merge_response"],
  ] as const;
  for (const [message, expected] of classes) {
    assert.equal(classifyMergeFault(message), expected, message);
    const obs = mergeObservation({
      pr: 1,
      repository: REPO,
      certainty: expected === "timeout" || expected === "uncertain_merge_response" ? "uncertain" : "known_absent",
      lifecycle: "cooling",
      complete: false,
      fault: expected,
      message,
      claim: null,
    });
    assert.equal(obs.human_owned, false);
    assert.equal(obs.complete, false);
    assert.equal(obs.cancelled, false);
    assert.notEqual(obs.lifecycle, "complete");
  }
});

test("2.5 operator mergePr still exits via throw; supervised result stays owned", async () => {
  const store = memoryMergeClaimStore();
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen() }),
    async ghPrView() {
      return {
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        headRefOid: HEAD,
      };
    },
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "owned");
  assert.equal(result.observation.fault, "conflict");
  await assert.rejects(() => mergePr(42, deps), /CONFLICTING/);
  assert.equal(deps.mergeCalls.length, 0);
});

test("6.1 merge authority is only the original typed envelope", () => {
  assert.doesNotThrow(() => assertOperatorMergeEnvelope("pipeline merge"));
  assert.doesNotThrow(() => assertOperatorMergeEnvelope("pipeline merge-queue --apply"));
  assert.doesNotThrow(() => assertOperatorMergeEnvelope("pipeline train --merge"));
  assert.throws(
    () => assertOperatorMergeEnvelope("host retry"),
    /envelope must be/,
  );
  assert.throws(
    () => mergeAuthorityFromConfig({ auto_merge: true }),
    /repository configuration cannot authorize merges/,
  );
  assert.throws(
    () => mergeAuthorityFromRecoverParked(),
    /recover-parked does not grant merge authority/,
  );
});

test("6.1 recover-parked and pipeline.yml cannot grant merge", () => {
  const recover = fs.readFileSync(
    path.join(repoRoot, "core/scripts/recover-parked.ts"),
    "utf8",
  );
  assert.doesNotMatch(recover, /mergePr\(/);
  assert.doesNotMatch(recover, /ghPrMerge/);
  assert.doesNotMatch(recover, /gh pr merge/);
  const schema = fs.readFileSync(path.join(repoRoot, "core/scripts/types.ts"), "utf8");
  assert.doesNotMatch(schema, /\bauto_merge\s*:/);
  const pipelineYmlTemplate = fs.readFileSync(
    path.join(repoRoot, "core/scripts/config.ts"),
    "utf8",
  );
  assert.doesNotMatch(pipelineYmlTemplate, /\bauto_merge\s*:/);
});

test("4.1 production train does not wire recoverParked", () => {
  const pipeline = fs.readFileSync(
    path.join(repoRoot, "core/scripts/pipeline.ts"),
    "utf8",
  );
  const start = pipeline.indexOf("export async function runTrainCommand");
  assert.ok(start !== -1);
  const body = pipeline.slice(start, start + 8000);
  assert.doesNotMatch(body, /recoverParked\s*:/);
  assert.doesNotMatch(body, /runRecoverParked/);
  const train = fs.readFileSync(
    path.join(repoRoot, "core/scripts/stages/train.ts"),
    "utf8",
  );
  assert.doesNotMatch(train, /await deps\.recoverParked/);
  assert.doesNotMatch(train, /recover-parked once/);
});

test("3.1 merge-queue apply uses mergePr, not a looser mergeability rule", () => {
  const mq = fs.readFileSync(
    path.join(repoRoot, "core/scripts/stages/merge-queue.ts"),
    "utf8",
  );
  assert.match(mq, /await mergePr\(/);
  assert.match(mq, /envelope: "pipeline merge-queue --apply"/);
  assert.doesNotMatch(mq, /mergeable === "UNKNOWN"[\s\S]{0,80}ghPrMerge/);
  const invariant = MERGE_OPERATION_INVARIANT;
  assert.match(invariant.precondition, /MERGEABLE and CLEAN/);
});

test("6.2 supervisor and CLI docs name recover-parked as operator CLI, not a train recoverer", () => {
  const supervisor = fs.readFileSync(path.join(repoRoot, "docs/supervisor.md"), "utf8");
  assert.doesNotMatch(supervisor, /train does this automatically/);
  assert.match(supervisor, /pipeline recover-parked/);
  assert.match(supervisor, /does \*\*not\*\* auto-invoke recover-parked/);
  const cliDocs = fs.readFileSync(path.join(repoRoot, "docs/cli.md"), "utf8");
  assert.match(cliDocs, /pipeline recover-parked/);
  const context = fs.readFileSync(path.join(repoRoot, "CONTEXT.md"), "utf8");
  assert.match(context, /\*\*RecoverySupervisor\*\*:/);
  assert.match(context, /\*\*Independent-sibling continuation\*\*:/);
});

test("decideMergeReplay: complete claim plus merged+contained is known_complete", () => {
  const claim: MergeClaim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
  });
  const decision = decideMergeReplay({
    claim: { ...claim, outcome: "complete" },
    live: liveMerged(),
    contained: true,
  });
  assert.equal(decision.action, "complete");
  assert.equal(decision.certainty, "known_complete");
});

test("decideMergeReplay: complete claim plus merged-but-not-contained waits", () => {
  const claim: MergeClaim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
  });
  const decision = decideMergeReplay({
    claim: { ...claim, outcome: "complete" },
    live: liveMerged(),
    contained: false,
  });
  assert.equal(decision.action, "wait");
  assert.equal(decision.certainty, "uncertain");
});

test("decideMergeReplay: submitted plus delayed-open waits and does not may_submit", () => {
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  const claim: MergeClaim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
    now: startedAt,
  });
  const decision = decideMergeReplay({
    claim: { ...claim, outcome: "submitted" },
    live: liveOpen(),
    contained: false,
    now: new Date(startedAt.getTime() + 1_000),
  });
  assert.equal(decision.action, "wait");
  assert.equal(decision.certainty, "uncertain");
});

test("decideMergeReplay: uncertain plus cooling-elapsed open is known_absent", () => {
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  const claim: MergeClaim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
    now: startedAt,
  });
  const decision = decideMergeReplay({
    claim: transitionMergeClaim({ ...claim, outcome: "uncertain" }, "uncertain", startedAt),
    live: liveOpen(),
    contained: false,
    now: new Date(startedAt.getTime() + MERGE_COOLING_MS),
  });
  assert.equal(decision.action, "may_submit");
  assert.equal(decision.certainty, "known_absent");
});

test("zero-exit merge does not complete without merged+contained observation", async () => {
  const store = memoryMergeClaimStore();
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen(), contained: false }),
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "owned");
  assert.equal(result.observation.complete, false);
  assert.equal(result.observation.certainty, "uncertain");
  assert.equal(deps.mergeCalls.length, 1);
  const claim = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(claim?.outcome, "uncertain");
});

test("uncertain claim becomes retryable after cooling proves the PR still open", async () => {
  const store = memoryMergeClaimStore();
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  let now = startedAt;
  let live = liveOpen();
  const first = makeMergeDeps({
    supervision: supervision(store, {
      live: () => live,
      contained: false,
      now: () => now,
    }),
    async ghPrMerge() {
      throw new Error("gh pr merge failed: timed out after 60000ms");
    },
  });
  const owned = await runMergeAttempt(42, first);
  assert.equal(owned.kind, "owned");
  assert.equal(owned.observation.certainty, "uncertain");
  const mid = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(mid?.outcome, "uncertain");

  now = new Date(startedAt.getTime() + MERGE_COOLING_MS);
  const second = makeMergeDeps({
    supervision: supervision(store, {
      live: () => live,
      contained: true,
      now: () => now,
    }),
    async ghPrMerge(pr, headRefOid) {
      live = liveMerged();
      second.mergeCalls.push({ pr, headRefOid });
    },
  });
  const retried = await runMergeAttempt(42, second);
  assert.equal(retried.kind, "complete");
  assert.equal(second.mergeCalls.length, 1, "proven-absent uncertain claim may submit once");
  const done = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(done?.outcome, "complete");
});

test("compareAndSwap: exclusive create admits only one owner", async () => {
  const store = memoryMergeClaimStore();
  const claim = bindMergeClaim({
    repository: REPO,
    base: "main",
    frozenIssueScope: [100],
    pr: 42,
    inspectedHead: HEAD,
    actionIdentity: "pipeline merge 42",
  });
  const first = await store.compareAndSwap(null, claim);
  const second = await store.compareAndSwap(null, claim);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(mergeClaimsCasEqual(first, claim), true);
});

test("frozenIssueScopeMatchesLinkedIssue requires exact single-issue match", () => {
  assert.equal(frozenIssueScopeMatchesLinkedIssue([], 100), true);
  assert.equal(frozenIssueScopeMatchesLinkedIssue([100], 100), true);
  assert.equal(frozenIssueScopeMatchesLinkedIssue([100], 200), false);
  assert.equal(frozenIssueScopeMatchesLinkedIssue([100, 200], 100), false);
});

test("concurrent invocations: only the CAS winner calls ghPrMerge", async () => {
  const store = memoryMergeClaimStore();
  let live = liveOpen();
  const make = () => {
    const deps = makeMergeDeps({
      supervision: supervision(store, { live: () => live, contained: true }),
      async ghPrMerge(pr, headRefOid) {
        live = liveMerged();
        deps.mergeCalls.push({ pr, headRefOid });
      },
    });
    return deps;
  };
  const a = make();
  const b = make();
  const [ra, rb] = await Promise.all([runMergeAttempt(42, a), runMergeAttempt(42, b)]);
  const merges = a.mergeCalls.length + b.mergeCalls.length;
  assert.equal(merges, 1, "exactly one process may submit ghPrMerge");
  assert.ok(
    ra.kind === "complete" || rb.kind === "complete",
    "one caller completes after the winner submits",
  );
  const loser = ra.kind === "complete" ? rb : ra;
  if (loser.kind === "owned") {
    assert.equal(loser.observation.complete, false);
    assert.equal(loser.observation.human_owned, false);
  }
});

test("relinked issue: frozen queue scope must match the live closing issue", async () => {
  const store = memoryMergeClaimStore();
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen(), contained: true }),
    async getPrLinkedIssue() {
      return 200;
    },
    async getPrForIssue(issueNumber) {
      return issueNumber === 200 ? 42 : null;
    },
    async getIssueLabels() {
      return ["pipeline:ready-to-deploy"];
    },
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "owned");
  assert.match(result.observation.message, /does not match frozen candidate scope/);
  assert.equal(deps.mergeCalls.length, 0);
});

test("retargeted base: live baseRefName must equal the configured base", async () => {
  const store = memoryMergeClaimStore();
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen(), contained: true }),
    async ghPrView() {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: HEAD,
        baseRefName: "release/1.0",
      };
    },
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "owned");
  assert.match(result.observation.message, /does not match configured base/);
  assert.equal(deps.mergeCalls.length, 0);
});

test("final pre-submit read refuses a relinked issue after inspection", async () => {
  const store = memoryMergeClaimStore();
  let linkedReads = 0;
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen(), contained: true }),
    async getPrLinkedIssue() {
      linkedReads += 1;
      return linkedReads <= 2 ? 100 : 200;
    },
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "owned");
  assert.match(result.observation.message, /does not match frozen candidate scope/);
  assert.equal(deps.mergeCalls.length, 0);
});

test("final pre-submit read refuses a retargeted base after inspection", async () => {
  const store = memoryMergeClaimStore();
  let views = 0;
  const deps = makeMergeDeps({
    supervision: supervision(store, { live: liveOpen(), contained: true }),
    async ghPrView() {
      views += 1;
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: HEAD,
        baseRefName: views === 1 ? "main" : "release/1.0",
      };
    },
  });
  const result = await runMergeAttempt(42, deps);
  assert.equal(result.kind, "owned");
  assert.match(result.observation.message, /does not match configured base/);
  assert.equal(deps.mergeCalls.length, 0);
});

test("decideMergeReplay: cooling uses transitioned_at, not started_at", () => {
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  const submittedAt = new Date(startedAt.getTime() + MERGE_COOLING_MS);
  const claim: MergeClaim = transitionMergeClaim(
    bindMergeClaim({
      repository: REPO,
      base: "main",
      frozenIssueScope: [100],
      pr: 42,
      inspectedHead: HEAD,
      actionIdentity: "pipeline merge 42",
      now: startedAt,
    }),
    "submitted",
    submittedAt,
  );
  const decision = decideMergeReplay({
    claim,
    live: liveOpen(),
    contained: false,
    now: submittedAt,
  });
  assert.equal(decision.action, "wait");
  assert.equal(decision.certainty, "uncertain");
});

test("delayed visibility: aged started_at does not skip cooling after uncertain submit", async () => {
  const store = memoryMergeClaimStore();
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  let now = startedAt;
  const first = makeMergeDeps({
    supervision: supervision(store, {
      live: liveOpen(),
      contained: false,
      now: () => now,
    }),
    async ghPrMerge() {
      now = new Date(startedAt.getTime() + MERGE_COOLING_MS);
      throw new Error("gh pr merge failed: timed out after 60000ms");
    },
  });
  const owned = await runMergeAttempt(42, first);
  assert.equal(owned.kind, "owned");
  const mid = await store.load(mergeClaimKey(REPO, 42));
  assert.equal(mid?.outcome, "uncertain");
  assert.ok(mid?.transitioned_at);
  assert.notEqual(mid?.transitioned_at, mid?.started_at);

  const second = makeMergeDeps({
    supervision: supervision(store, {
      live: liveOpen(),
      contained: false,
      now: () => now,
    }),
  });
  const waited = await runMergeAttempt(42, second);
  assert.equal(waited.kind, "owned");
  assert.equal(waited.observation.certainty, "uncertain");
  assert.equal(second.mergeCalls.length, 0, "must not remarge while cooling from uncertain transition");
});

test("fileMergeClaimStore compareAndSwap exclusive-creates the claim file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-merge-cas-"));
  try {
    const store = fileMergeClaimStore(dir);
    const claim = bindMergeClaim({
      repository: REPO,
      base: "main",
      frozenIssueScope: [100],
      pr: 42,
      inspectedHead: HEAD,
      actionIdentity: "pipeline merge 42",
    });
    const first = await store.compareAndSwap(null, claim);
    const second = await store.compareAndSwap(null, claim);
    assert.ok(first);
    assert.equal(second, null);
    const loaded = await store.load(mergeClaimKey(REPO, 42));
    assert.equal(loaded?.inspected_head, HEAD);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
