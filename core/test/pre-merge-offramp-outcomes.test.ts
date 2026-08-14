// Regression: pre-merge blocked outcomes carry blockerKind / offrampPathTag
// so orchestrator emission can write a stable offramp_class (#683).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  enforceOpenspecActiveChangeGuard,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import { toPreMergeOfframpClass } from "../scripts/pre-merge-offramp.ts";
import type { Outcome, PipelineConfig } from "../scripts/types.ts";

const SHA_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR_NUMBER = 683;

const reviewComment =
  `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

function makeCfg(ciMode: "github" | "local" = "github"): PipelineConfig {
  return {
    ci_mode: ciMode,
    ci_no_run_grace_s: 60,
    steps: { docs: false },
    eval_gate: { enabled: false },
    shipcheck_gate: { enabled: false },
    base_branch: "main",
  } as unknown as PipelineConfig;
}

function makeBaseDeps(overrides: Partial<AdvancePreMergeDeps> = {}): AdvancePreMergeDeps {
  return {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewComment }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getPrCommits: async () => [],
    getForIssue: async () => null,
    listPrHeadChangeDirs: async () => [],
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async () => {},
    getGhActor: async () => "test-actor",
    getPrDiff: async () => "",
    rebaseAlreadyAttempted: () => true,
    tryRebaseAndPush: async () => false,
    ...overrides,
  };
}

function outcomeClass(out: Outcome): string | null {
  if (out.advanced || out.status !== "blocked") return null;
  return toPreMergeOfframpClass({
    blockerKind: out.blockerKind,
    pathTag: out.offrampPathTag,
  });
}

test("pre-merge CI failure outcome maps to ci-failed class (#683)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({
    getPrChecks: async () =>
      [{ name: "ci", bucket: "fail", state: "FAILURE" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >,
  });
  const out = await advance(makeCfg("github"), 683, {}, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "blocked");
  assert.equal(out.reason, "CI failed");
  // Post-#679 permanent CI failure uses ci-exhausted label + #683 ci-failed path tag.
  assert.equal(out.blockerKind, "ci-exhausted");
  assert.equal(out.offrampPathTag, "ci-failed");
  assert.equal(outcomeClass(out), "ci-failed");
});

test("pre-merge local test-gate failure maps to ci-failed class (#683)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({
    readRunEvents: async () => [
      {
        schema_version: 1,
        type: "stage_accounting",
        at: "2026-06-30T00:00:00Z",
        run_id: "683-run",
        issue: 683,
        stage: "test-gate",
        harness: "test-gate",
        model_slot: null,
        model: null,
        started_at: "2026-06-30T00:00:00Z",
        ended_at: "2026-06-30T00:01:00Z",
        duration_ms: 60000,
        command_count: 1,
        subprocess_count: 1,
        outcome: "failure",
        blocker_kind: "test-gate-exhausted",
        cost_source: "unknown",
        cost_usd: null,
        pr_head_sha: SHA_HEAD,
      },
    ] as never,
  });
  const out = await advance(makeCfg("local"), 683, { runDir: "/fake/run/dir" }, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "blocked");
  assert.equal(out.blockerKind, "needs-human");
  assert.equal(out.offrampPathTag, "ci-failed");
  assert.equal(outcomeClass(out), "ci-failed");
});

test("pre-merge no-PR blocked outcome is residual other (#683)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({ getPrForIssue: async () => null });
  const out = await advance(makeCfg(), 683, {}, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "blocked");
  assert.equal(out.blockerKind, "needs-human");
  assert.equal(out.offrampPathTag, undefined);
  assert.equal(outcomeClass(out), "other");
});

test("pre-merge residual conflict after resolve budget exhausts as product failure, not merge-conflict park (#683/#1065)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({
    getPrChecks: async () =>
      [{ name: "ci", bucket: "pass", state: "SUCCESS" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >,
    // Fresh re-fetch after CI still conflicting
    getPrDetail: async () =>
      ({ head_sha: SHA_HEAD, mergeable: false, mergeable_state: "DIRTY" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getForIssue: async () => ({ path: "/fake/wt", slug: "slug" }) as Awaited<
      ReturnType<NonNullable<AdvancePreMergeDeps["getForIssue"]>>
    >,
    rebaseAlreadyAttempted: () => true,
    // Resolve budget already spent → product/engine-owned terminal (#1065).
    conflictResolveAttemptedForHead: () => true,
  });
  const out = await advance(makeCfg("github"), 683, {}, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "blocked");
  // #1065: residual conflict is review-findings product failure, not merge-conflict
  // “manual rebase needed” human park. Offramp maps via kind (other for review-findings).
  assert.equal(out.blockerKind, "review-findings");
  assert.notEqual(out.blockerKind, "merge-conflict");
  assert.equal(outcomeClass(out), "other");
});

test("pre-merge active OpenSpec change guard maps to openspec-invalid (#683)", async (t) => {
  t.mock.method(console, "log", () => {});
  // Direct guard unit: PR-head tip tree still has unarchived openspec/changes/<id>/.
  const out = await enforceOpenspecActiveChangeGuard(makeCfg("github"), 683, PR_NUMBER, {
    getForIssue: async () => null,
    listPrHeadChangeDirs: async () => ["foo"],
    setBlocked: async () => {},
  });
  assert.ok(out);
  assert.equal(out!.advanced, false);
  assert.equal(out!.status, "blocked");
  assert.equal(out!.blockerKind, "openspec-invalid");
  assert.equal(outcomeClass(out!), "openspec-invalid");
});

test("pre-merge waiting path does not produce a blocked class (#683)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({
    getPrChecks: async () =>
      [{ name: "ci", bucket: "pending", state: "PENDING" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >,
  });
  const out = await advance(makeCfg("github"), 683, {}, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "waiting");
  assert.equal(outcomeClass(out), null);
});

test("pre-merge local no-worktree precondition maps to residual other, not ci-failed (#683 review 2)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({
    readRunEvents: async () => [] as never,
    getForIssue: async () => null,
  listPrHeadChangeDirs: async () => [],
  });
  const out = await advance(makeCfg("local"), 683, { runDir: "/fake/run/dir" }, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "blocked");
  assert.equal(out.blockerKind, "needs-human");
  assert.equal(out.offrampPathTag, undefined);
  assert.equal(outcomeClass(out), "other");
});

test("pre-merge local skipped inline gate maps to residual other, not ci-failed (#683 review 2)", async (t) => {
  t.mock.method(console, "log", () => {});
  const deps = makeBaseDeps({
    readRunEvents: async () => [] as never,
    getForIssue: async () =>
      ({ path: "/fake/wt", slug: "slug" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getForIssue"]>>
      >,
    runTestGate: async () =>
      ({ skipped: true, passed: false, attempts: 0 }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["runTestGate"]>>
      >,
  });
  const out = await advance(makeCfg("local"), 683, { runDir: "/fake/run/dir" }, deps);
  assert.equal(out.advanced, false);
  assert.equal(out.status, "blocked");
  assert.equal(out.blockerKind, "needs-human");
  assert.equal(out.offrampPathTag, undefined);
  assert.equal(outcomeClass(out), "other");
});
