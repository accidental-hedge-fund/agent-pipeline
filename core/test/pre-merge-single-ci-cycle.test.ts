// Pre-merge happy path runs exactly one CI cycle (#91). With the docs harness
// removed, a single advance() call goes PR → SHA gate → archive (no worktree,
// skipped) → CI (green) → mergeability (clean) → terminal stage — it never
// returns the old "docs pushed; CI needs to re-run" waiting round, regardless
// of cfg.steps.docs. Deps are injected via AdvancePreMergeDeps, the same DI
// pattern as pre-merge-sha-gate.test.ts.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  isPipelineInternalCommit,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
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
