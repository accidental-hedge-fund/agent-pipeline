// Regression tests for #95: a CONFLICTING PR creates no pull_request check
// runs (GitHub cannot build the merge ref), so pre-merge must detect the
// conflict BEFORE the CI poll and route to the rebase path — not poll for
// checks that can never appear until ci_timeout. Deps are injected via
// AdvancePreMergeDeps, the same DI pattern as pre-merge-single-ci-cycle.test.ts.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { advance, type AdvancePreMergeDeps } from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const SHA_HEAD = "3333333333333333333333333333333333333333";
const PR_NUMBER = 83;
const ISSUE = 95;
// Path that does not exist on disk: openspec.isActive() auto-detection finds
// no openspec/ workspace there, so the archive and spec-validation steps skip.
const WT_PATH = "/nonexistent/pipeline-95-wt";

function makeCfg(): PipelineConfig {
  return { eval_gate: { enabled: false } } as unknown as PipelineConfig;
}

interface Rec {
  ciPolls: number;
  rebaseCalls: number;
  marked: string[];
  blocked: string[];
}

type PrDetailFake = Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;

/**
 * Deps where everything up to the conflict pre-check passes: PR found, no
 * prior review comment (SHA gate skips), worktree present, rebase marker
 * absent and rebase succeeding unless overridden.
 */
function makeDeps(prDetail: Partial<PrDetailFake>): { deps: AdvancePreMergeDeps; rec: Rec } {
  const rec: Rec = { ciPolls: 0, rebaseCalls: 0, marked: [], blocked: [] };
  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [] }) as unknown as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () => ({ head_sha: SHA_HEAD, ...prDetail }) as PrDetailFake,
    getPrCommits: async () => [],
    getPrChecks: async () => {
      rec.ciPolls++;
      return [{ name: "ci", bucket: "pass" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >;
    },
    getForIssue: async () => ({ path: WT_PATH, slug: "conflict-detection" }),
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => {
      rec.blocked.push(reason);
    },
    tryRebaseAndPush: async () => {
      rec.rebaseCalls++;
      return true;
    },
    rebaseAlreadyAttempted: () => false,
    markRebaseAttempted: (wtPath) => {
      rec.marked.push(wtPath);
    },
  };
  return { deps, rec };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

test("CONFLICTING PR skips the CI poll and rebases (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "rebase-resolved; CI re-running",
  });
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 1, "rebase attempted exactly once");
  assert.deepEqual(rec.marked, [WT_PATH], "rebase marked as attempted on success");
  assert.deepEqual(rec.blocked, []);
});

test("CONFLICTING PR with rebase already attempted blocks, no second rebase (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.rebaseAlreadyAttempted = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, { advanced: false, status: "blocked", reason: "merge conflict" });
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 0, "no second rebase attempt once the marker is set");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /merge conflict/);
  assert.match(rec.blocked[0], /manual rebase needed/);
});

test("CONFLICTING PR whose rebase fails blocks with a conflict-specific reason (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, { advanced: false, status: "blocked", reason: "merge conflict" });
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 1);
  assert.deepEqual(rec.marked, [], "a failed rebase is not marked as attempted");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /merge conflict/);
  assert.match(rec.blocked[0], /manual rebase needed/);
});

test("UNKNOWN mergeability does not enter the early-conflict path; CI poll proceeds (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "" });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  // CI was consulted (green), and the gate then waits on mergeability — the
  // normal pre-#95 flow, with no rebase or conflict block.
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "GitHub still computing mergeability",
  });
  assert.equal(rec.ciPolls, 1, "UNKNOWN mergeability still polls CI as before");
  assert.equal(rec.rebaseCalls, 0);
  assert.deepEqual(rec.blocked, []);
});

test("non-conflicting PR with zero checks (no CI workflow) still advances (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: true, mergeable_state: "CLEAN" });
  deps.getPrChecks = async () => {
    rec.ciPolls++;
    return [];
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, {
    advanced: true,
    from: "pre-merge",
    to: "ready-to-deploy",
    summary: `PR #${PR_NUMBER} pre-merge gates passed`,
  });
  assert.equal(rec.ciPolls, 1, "zero checks treated as passing, exactly one consult");
  assert.equal(rec.rebaseCalls, 0);
  assert.deepEqual(rec.blocked, []);
});
