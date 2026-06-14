// Pre-merge happy path runs exactly one CI cycle (#91). With the docs harness
// removed, a single advance() call goes PR → SHA gate → archive (no worktree,
// skipped) → CI (green) → mergeability (clean) → terminal stage — it never
// returns the old "docs pushed; CI needs to re-run" waiting round, regardless
// of cfg.steps.docs. Deps are injected via AdvancePreMergeDeps, the same DI
// pattern as pre-merge-sha-gate.test.ts.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance,
  isPipelineInternalCommit,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import { readBundle } from "../scripts/evidence-bundle.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";

const SHA_HEAD = "2222222222222222222222222222222222222222";
const PR_NUMBER = 99;

function makeCfg(docs: boolean): PipelineConfig {
  return {
    steps: { docs },
    eval_gate: { enabled: false },
  } as unknown as PipelineConfig;
}

interface Rec {
  ciPolls: number;
  transitions: { from: Stage; to: Stage }[];
  blocked: string[];
}

/** Happy-path deps: PR found, fresh review verdict on HEAD, green CI, clean merge. */
function makeDeps(): { deps: AdvancePreMergeDeps; rec: Rec } {
  const rec: Rec = { ciPolls: 0, transitions: [], blocked: [] };
  const reviewComment =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;
  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewComment }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      ({ head_sha: SHA_HEAD, mergeable: true }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getPrCommits: async () => [],
    getPrChecks: async () => {
      rec.ciPolls++;
      return [{ name: "ci", bucket: "pass" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >;
    },
    getForIssue: async () => null, // no worktree → archive + spec gates skip
    postComment: async () => {},
    transition: async (_cfg, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_cfg, _n, reason) => {
      rec.blocked.push(reason);
    },
  };
  return { deps, rec };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

for (const docs of [true, false]) {
  test(`pre-merge happy path: one CI cycle straight to ready-to-deploy (steps.docs=${docs}) (#91)`, async (t) => {
    const { deps, rec } = makeDeps();
    let out;
    await quiet(t, async () => {
      out = await advance(makeCfg(docs), 91, {}, deps);
    });
    // One advance() call is terminal — no intermediate waiting round in which
    // the old docs step pushed a commit and forced CI to re-run.
    assert.deepEqual(out, {
      advanced: true,
      from: "pre-merge",
      to: "ready-to-deploy",
      summary: `PR #${PR_NUMBER} pre-merge gates passed`,
    });
    assert.equal(rec.ciPolls, 1, "CI consulted exactly once on the happy path");
    assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "ready-to-deploy" }]);
    assert.deepEqual(rec.blocked, []);
  });
}

// ---------------------------------------------------------------------------
// Stale-snapshot regression (#95): conflict developed after CI passed
// ---------------------------------------------------------------------------

test("pre-merge: post-CI conflict is caught by fresh Step 2 fetch, not stale pre-CI snapshot (#95)", async (t) => {
  t.mock.method(console, "log", () => {});

  // Track getPrDetail call order: call 1 = Step 0.5 (early check), call 2 = Step 2 (after CI).
  let getPrDetailCalls = 0;
  let rebaseCalled = false;

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR_NUMBER,
    // No review comment → SHA gate returns null without calling getPrDetail.
    getIssueDetail: async () => ({ comments: [] }) as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>>,
    getPrDetail: async () => {
      getPrDetailCalls++;
      if (getPrDetailCalls === 1) {
        // Step 0.5 early check: clean — should NOT trigger early-conflict path.
        return { head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" } as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;
      }
      // Step 2 after CI: PR became conflicting while CI was running.
      return { head_sha: SHA_HEAD, mergeable: false, mergeable_state: "DIRTY" } as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;
    },
    getPrCommits: async () => [],
    getPrChecks: async () => [{ name: "ci", bucket: "pass" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getForIssue: async () => ({ path: "/fake/wt", slug: "slug" }) as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getForIssue"]>>>,
    rebaseAlreadyAttempted: () => false,
    tryRebaseAndPush: async () => { rebaseCalled = true; return true; },
    markRebaseAttempted: () => {},
    setBlocked: async () => {},
    transition: async () => {},
    postComment: async () => {},
  };

  const out = await advance(makeCfg(false), 95, {}, deps);

  // Must NOT advance — the post-CI conflict must be caught.
  assert.equal(out.advanced, false, "must not advance when conflict detected at Step 2");
  assert.equal(out.status, "waiting");
  assert.equal(out.reason, "rebase-resolved; CI re-running");
  assert.equal(rebaseCalled, true, "tryRebaseAndPush must be invoked for the post-CI conflict");
  assert.equal(getPrDetailCalls, 2, "getPrDetail called once before CI and once after CI passes");
});

// ---------------------------------------------------------------------------
// Finding 7 regression: stateDir wired into advance — CI check recorded
// ---------------------------------------------------------------------------

test("pre-merge: CI check result recorded in evidence bundle when stateDir provided (finding 7)", async (t) => {
  t.mock.method(console, "log", () => {});

  const dir = await mkdtemp(join(tmpdir(), "pre-merge-evidence-test-"));
  try {
    const SHA = "3333333333333333333333333333333333333333";
    const PR = 88;

    const deps: AdvancePreMergeDeps = {
      getPrForIssue: async () => PR,
      getIssueDetail: async () => ({ comments: [] }) as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>>,
      getPrDetail: async () => ({ head_sha: SHA, mergeable: true, mergeable_state: "CLEAN" }) as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>,
      getPrCommits: async () => [],
      getPrChecks: async () => [{ name: "ci", bucket: "pass" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
      getForIssue: async () => null, // no worktree → archive + spec gates skip
      postComment: async () => {},
      transition: async () => {},
      setBlocked: async () => {},
    };

    await advance(makeCfg(false), 88, { stateDir: dir }, deps);

    const bundle = await readBundle(dir, 88);
    assert.ok(bundle, "evidence bundle must be created by advance when stateDir provided");
    const preMerge = bundle!.stages.find((s) => s.stage === "pre-merge");
    // The orchestrator records stage enter/exit; CI command appears via recordCommand inside advance.
    // Without a worktree there is no archive push or rebase, so only the CI check is recorded.
    const ciCmd = bundle!.stages
      .flatMap((s) => s.commands)
      .find((c) => c.cmd.startsWith("gh pr checks"));
    assert.ok(ciCmd, "gh pr checks command must be recorded in evidence bundle");
    assert.equal(ciCmd!.exitCode, 0, "passed CI checks must have exitCode 0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isPipelineInternalCommit — only the OpenSpec archive prefix survives (#91)
// ---------------------------------------------------------------------------

test("isPipelineInternalCommit: archive prefix only; docs commits are developer commits (#91)", () => {
  assert.equal(isPipelineInternalCommit("chore: archive OpenSpec change(s) for #91"), true);
  // The pre-merge docs harness no longer exists, so its old commit prefix can
  // only come from a developer and must trigger a re-review.
  assert.equal(isPipelineInternalCommit("docs: update documentation for #91"), false);
  assert.equal(isPipelineInternalCommit("docs: rewrite the README intro"), false);
  assert.equal(isPipelineInternalCommit("chore: bump deps"), false);
  assert.equal(isPipelineInternalCommit("feat: add a thing"), false);
});
