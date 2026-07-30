// Tests for merge-queue release-when-complete (#676).
//
// All I/O is injected — no real network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReleaseWhenComplete,
  isReleaseWhenCompleteEnabled,
  maybePrepareReleaseWhenComplete,
  missingReleaseVersionError,
  type ReleaseWhenCompleteHookDeps,
} from "../scripts/stages/merge-queue-release-when-complete.ts";
import {
  runMergeQueue,
  type MergeQueueCandidate,
  type MergeQueueDeps,
  type MergeQueueNonCandidate,
} from "../scripts/stages/merge-queue.ts";

// ---------------------------------------------------------------------------
// Completeness evaluation (task 1.2)
// ---------------------------------------------------------------------------

test("evaluateReleaseWhenComplete: empty R2D + no holds → complete", () => {
  const result = evaluateReleaseWhenComplete({
    remainingCandidates: [],
    heldItems: [],
  });
  assert.equal(result.complete, true);
  assert.equal(result.skipReason, undefined);
  assert.equal(result.remainingCandidateCount, 0);
  assert.equal(result.heldCount, 0);
});

test("evaluateReleaseWhenComplete: remaining R2D → incomplete with candidate reason", () => {
  const result = evaluateReleaseWhenComplete({
    remainingCandidates: [{ issueNumber: 10, prNumber: 100 }],
    heldItems: [],
  });
  assert.equal(result.complete, false);
  assert.ok(result.skipReason?.includes("remaining ready-to-deploy"));
  assert.ok(result.skipReason?.includes("#10"));
  assert.equal(result.remainingCandidateCount, 1);
});

test("evaluateReleaseWhenComplete: holds → incomplete with held reason", () => {
  const result = evaluateReleaseWhenComplete({
    remainingCandidates: [],
    heldItems: [{ issueNumber: 11, prNumber: 111, reason: "CONFLICTING" }],
  });
  assert.equal(result.complete, false);
  assert.ok(result.skipReason?.includes("held item"));
  assert.ok(result.skipReason?.includes("#11"));
  assert.equal(result.heldCount, 1);
});

test("evaluateReleaseWhenComplete: open non-R2D only → complete with warning payload", () => {
  const result = evaluateReleaseWhenComplete({
    remainingCandidates: [],
    heldItems: [],
    openNonCandidates: [
      { issueNumber: 20, title: "still planning" },
      { issueNumber: 21, title: "backlog item" },
    ],
  });
  assert.equal(result.complete, true);
  assert.ok(result.nonCandidateWarning);
  assert.ok(result.nonCandidateWarning?.includes("#20"));
  assert.ok(result.nonCandidateWarning?.includes("#21"));
  assert.equal(result.nonCandidateCount, 2);
});

test("evaluateReleaseWhenComplete: candidates + holds both named in skip reason", () => {
  const result = evaluateReleaseWhenComplete({
    remainingCandidates: [{ issueNumber: 1, prNumber: 10 }],
    heldItems: [{ issueNumber: 2, prNumber: 20, reason: "checks failed" }],
  });
  assert.equal(result.complete, false);
  assert.ok(result.skipReason?.includes("remaining ready-to-deploy"));
  assert.ok(result.skipReason?.includes("held item"));
});

// ---------------------------------------------------------------------------
// Opt-in resolution
// ---------------------------------------------------------------------------

test("isReleaseWhenCompleteEnabled: default off when both unset", () => {
  assert.equal(isReleaseWhenCompleteEnabled(undefined, undefined), false);
  assert.equal(isReleaseWhenCompleteEnabled(false, false), false);
});

test("isReleaseWhenCompleteEnabled: CLI or config enables", () => {
  assert.equal(isReleaseWhenCompleteEnabled(true, false), true);
  assert.equal(isReleaseWhenCompleteEnabled(false, true), true);
  assert.equal(isReleaseWhenCompleteEnabled(true, true), true);
});

// ---------------------------------------------------------------------------
// Hook unit tests (task 5.x)
// ---------------------------------------------------------------------------

function makeHookDeps(overrides: Partial<ReleaseWhenCompleteHookDeps> = {}) {
  const releaseCalls: Array<{
    version: string;
    opts: { dryRun?: boolean; noEdit?: boolean };
  }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: ReleaseWhenCompleteHookDeps & {
    releaseCalls: typeof releaseCalls;
    logs: string[];
    errors: string[];
  } = {
    releaseCalls,
    logs,
    errors,
    async runRelease(version, opts) {
      releaseCalls.push({ version, opts });
    },
    log(msg) {
      logs.push(msg);
    },
    error(msg) {
      errors.push(msg);
    },
    ...overrides,
  };
  return deps;
}

const emptyComplete = evaluateReleaseWhenComplete({
  remainingCandidates: [],
  heldItems: [],
});

const incompleteRemaining = evaluateReleaseWhenComplete({
  remainingCandidates: [{ issueNumber: 5, prNumber: 50 }],
  heldItems: [],
});

test("hook: default off → release never called", async () => {
  const deps = makeHookDeps();
  const result = await maybePrepareReleaseWhenComplete(
    { enabled: false, version: "minor" },
    emptyComplete,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(result.status, "disabled");
  assert.equal(result.exitNonZero, false);
  assert.equal(deps.releaseCalls.length, 0);
});

test("hook: complete + flag → runRelease with noEdit:true and version", async () => {
  const deps = makeHookDeps();
  const result = await maybePrepareReleaseWhenComplete(
    { enabled: true, version: "minor" },
    emptyComplete,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(result.status, "prepared");
  assert.equal(deps.releaseCalls.length, 1);
  assert.equal(deps.releaseCalls[0].version, "minor");
  assert.equal(deps.releaseCalls[0].opts.noEdit, true);
  assert.equal(deps.releaseCalls[0].opts.dryRun, undefined);
});

test("hook: incomplete → not called, skip reason names candidates", async () => {
  const deps = makeHookDeps();
  const result = await maybePrepareReleaseWhenComplete(
    { enabled: true, version: "patch" },
    incompleteRemaining,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(result.status, "skipped");
  assert.ok(result.skipReason?.includes("remaining ready-to-deploy"));
  assert.equal(deps.releaseCalls.length, 0);
});

test("hook: enabled without version → usage_error, no release call", async () => {
  const deps = makeHookDeps();
  const result = await maybePrepareReleaseWhenComplete(
    { enabled: true },
    emptyComplete,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(result.status, "usage_error");
  assert.equal(result.exitNonZero, true);
  assert.equal(deps.releaseCalls.length, 0);
  assert.ok(deps.errors.some((e) => e.includes(missingReleaseVersionError()) || e.includes("--release-version")));
});

test("hook: dry-run complete + flag → would_prepare, no release call", async () => {
  const deps = makeHookDeps();
  const result = await maybePrepareReleaseWhenComplete(
    { enabled: true, version: "1.2.3", dryRun: true },
    emptyComplete,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(result.status, "would_prepare");
  assert.equal(result.version, "1.2.3");
  assert.equal(deps.releaseCalls.length, 0);
  assert.ok(deps.logs.some((l) => l.includes("would prepare release 1.2.3")));
});

test("hook: prepare failure returns failed and does not throw", async () => {
  const deps = makeHookDeps({
    async runRelease() {
      throw new Error("CI gate failed");
    },
  });
  const result = await maybePrepareReleaseWhenComplete(
    { enabled: true, version: "minor" },
    emptyComplete,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.exitNonZero, true);
  assert.ok(result.error?.includes("release prepare failed"));
  assert.ok(result.error?.includes("CI gate failed"));
});

test("hook: prepare path wires only runRelease (no tag/merge/publish deps)", async () => {
  // The hook deps interface has only runRelease/log/error — no tag, npm
  // publish, or merge-release methods exist to wire. Prove the successful
  // path only invokes runRelease once with prepare-only options.
  const deps = makeHookDeps();
  await maybePrepareReleaseWhenComplete(
    { enabled: true, version: "patch" },
    emptyComplete,
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.equal(deps.releaseCalls.length, 1);
  assert.deepEqual(Object.keys(deps.releaseCalls[0].opts).sort(), ["noEdit"]);
  assert.equal(
    "tag" in deps || "publish" in deps || "mergeReleasePr" in deps,
    false,
  );
});

// ---------------------------------------------------------------------------
// runMergeQueue integration with injected deps (tasks 5.1–5.4)
// ---------------------------------------------------------------------------

function makeMergeQueueDeps(opts: {
  candidates?: MergeQueueCandidate[];
  remainingAfterApply?: MergeQueueCandidate[];
  nonCandidates?: MergeQueueNonCandidate[];
  mergeImpl?: (c: MergeQueueCandidate) => Promise<void>;
  releaseImpl?: MergeQueueDeps["runRelease"];
} = {}): MergeQueueDeps & {
  mergeCalls: MergeQueueCandidate[];
  releaseCalls: Array<{ version: string; opts: { dryRun?: boolean; noEdit?: boolean } }>;
  logs: string[];
  errors: string[];
} {
  const mergeCalls: MergeQueueCandidate[] = [];
  const releaseCalls: Array<{ version: string; opts: { dryRun?: boolean; noEdit?: boolean } }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let listCount = 0;
  const initial = opts.candidates ?? [];
  const remaining = opts.remainingAfterApply ?? [];
  const nonCandidates = opts.nonCandidates ?? [];

  return {
    mergeCalls,
    releaseCalls,
    logs,
    errors,
    async listR2dCandidates() {
      listCount += 1;
      // First call = initial; subsequent = re-query after apply.
      return listCount === 1 ? [...initial] : [...remaining];
    },
    async listOpenNonCandidates() {
      return [...nonCandidates];
    },
    async mergeCandidate(c) {
      mergeCalls.push(c);
      if (opts.mergeImpl) await opts.mergeImpl(c);
    },
    async runRelease(version, releaseOpts) {
      releaseCalls.push({ version, opts: releaseOpts });
      if (opts.releaseImpl) await opts.releaseImpl(version, releaseOpts, { repo_dir: "/r", repo: "o/r" });
    },
    log(msg) {
      logs.push(msg);
    },
    error(msg) {
      errors.push(msg);
    },
  };
}

const baseOpts = {
  milestone: "v1.0.0",
  repoDir: "/repo",
  repo: "org/repo",
};

test("runMergeQueue: default off → release never called after empty complete drive", async () => {
  const deps = makeMergeQueueDeps({ candidates: [], remainingAfterApply: [] });
  const result = await runMergeQueue({ ...baseOpts, apply: true }, deps);
  assert.equal(result.release.status, "disabled");
  assert.equal(deps.releaseCalls.length, 0);
  assert.equal(result.exitCode, 0);
});

test("runMergeQueue: complete + flag → runRelease with noEdit and version", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [{ issueNumber: 1, prNumber: 10, title: "ship it" }],
    remainingAfterApply: [],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenComplete: true,
      releaseVersion: "minor",
    },
    deps,
  );
  assert.equal(result.merged.length, 1);
  assert.equal(result.release.status, "prepared");
  assert.equal(deps.releaseCalls.length, 1);
  assert.equal(deps.releaseCalls[0].version, "minor");
  assert.equal(deps.releaseCalls[0].opts.noEdit, true);
  assert.equal(result.exitCode, 0);
});

test("runMergeQueue: incomplete (remaining R2D) → release not called", async () => {
  const stillThere = [{ issueNumber: 1, prNumber: 10, title: "still open" }];
  const deps = makeMergeQueueDeps({
    candidates: stillThere,
    // Re-query still finds it (e.g. merge was skipped somehow / mid-drive add).
    remainingAfterApply: stillThere,
    async mergeImpl() {
      /* merge "succeeds" but re-query still shows remaining for this test */
    },
  });
  // Force remaining after apply by not clearing — but merge still runs.
  // Actually listR2dCandidates after apply returns remainingAfterApply.
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenComplete: true,
      releaseVersion: "patch",
    },
    deps,
  );
  assert.equal(result.release.status, "skipped");
  assert.ok(result.release.skipReason?.includes("remaining"));
  assert.equal(deps.releaseCalls.length, 0);
});

test("runMergeQueue: held item blocks prepare even when remaining empty", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [{ issueNumber: 2, prNumber: 20, title: "conflicted" }],
    remainingAfterApply: [],
    async mergeImpl() {
      throw new Error("mergeable is CONFLICTING");
    },
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenComplete: true,
      releaseVersion: "minor",
    },
    deps,
  );
  assert.equal(result.held.length, 1);
  assert.equal(result.merged.length, 0);
  assert.equal(result.release.status, "skipped");
  assert.ok(result.release.skipReason?.includes("held"));
  assert.equal(deps.releaseCalls.length, 0);
});

test("runMergeQueue: prepare throws after merges → merges remain successful; no second merge", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [
      { issueNumber: 1, prNumber: 10, title: "a" },
      { issueNumber: 2, prNumber: 20, title: "b" },
    ],
    remainingAfterApply: [],
    async releaseImpl() {
      throw new Error("dirty release-managed tree");
    },
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenComplete: true,
      releaseVersion: "1.9.0",
    },
    deps,
  );
  assert.equal(result.merged.length, 2, "both merges must remain recorded as done");
  assert.equal(deps.mergeCalls.length, 2, "no second merge pass");
  assert.equal(result.release.status, "failed");
  assert.equal(result.exitCode, 1);
  assert.ok(result.release.error?.includes("dirty release-managed tree"));
});

test("runMergeQueue: dry-run complete + flag → would_prepare, no merge, no release call", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [], // already complete
    nonCandidates: [{ issueNumber: 99, title: "leftover planning" }],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: false,
      releaseWhenComplete: true,
      releaseVersion: "minor",
    },
    deps,
  );
  assert.equal(result.mode, "dry-run");
  assert.equal(result.merged.length, 0);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.releaseCalls.length, 0, "dry-run must not invoke runRelease");
  assert.equal(result.release.status, "would_prepare");
  assert.ok(deps.logs.some((l) => l.includes("would prepare release minor")));
  assert.ok(deps.logs.some((l) => l.includes("non-candidate") || l.includes("#99")));
});

test("runMergeQueue: dry-run non-empty queue → would-not-prepare with skip reason", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [{ issueNumber: 3, prNumber: 30, title: "pending" }],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: false,
      releaseWhenComplete: true,
      releaseVersion: "minor",
    },
    deps,
  );
  assert.equal(result.release.status, "skipped");
  assert.ok(result.release.skipReason?.includes("remaining"));
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.releaseCalls.length, 0);
});

test("runMergeQueue: dry-run without flag never mentions preparing a release as an action", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [{ issueNumber: 3, prNumber: 30, title: "pending" }],
  });
  const result = await runMergeQueue({ ...baseOpts, apply: false }, deps);
  assert.equal(result.release.status, "disabled");
  assert.equal(deps.releaseCalls.length, 0);
  const joined = deps.logs.join("\n");
  assert.ok(joined.includes("release-when-complete is off"));
  assert.ok(!joined.includes("would prepare release"));
  assert.ok(!joined.includes("preparing release"));
});

test("runMergeQueue: enabled without version exits usage error before merges", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [{ issueNumber: 1, prNumber: 10, title: "a" }],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenComplete: true,
      // no releaseVersion
    },
    deps,
  );
  assert.equal(result.release.status, "usage_error");
  assert.equal(result.exitCode, 2);
  assert.equal(deps.mergeCalls.length, 0, "must not merge before usage gate");
  assert.equal(deps.releaseCalls.length, 0);
});

test("runMergeQueue: config true enables without CLI flag", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [],
    remainingAfterApply: [],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenCompleteConfig: true,
      releaseVersion: "patch",
    },
    deps,
  );
  assert.equal(result.release.status, "prepared");
  assert.equal(deps.releaseCalls.length, 1);
  assert.equal(deps.releaseCalls[0].version, "patch");
});

test("runMergeQueue: hook does not expose tag/npm/merge-release operations", async () => {
  const deps = makeMergeQueueDeps({ candidates: [], remainingAfterApply: [] });
  await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      releaseWhenComplete: true,
      releaseVersion: "minor",
    },
    deps,
  );
  // MergeQueueDeps has no tag/publish/mergeRelease fields — only runRelease.
  const depKeys = Object.keys(deps).filter(
    (k) => !["mergeCalls", "releaseCalls", "logs", "errors"].includes(k),
  );
  for (const forbidden of ["tag", "createTag", "npmPublish", "publish", "mergeReleasePr", "ghPrMergeRelease"]) {
    assert.equal(depKeys.includes(forbidden), false, `must not wire ${forbidden}`);
  }
  assert.ok(depKeys.includes("runRelease"));
  assert.equal(deps.releaseCalls[0]?.opts.noEdit, true);
});

// ---------------------------------------------------------------------------
// Review 1 regressions (#676): dry-run overrides apply; PR lookup fail-closed
// ---------------------------------------------------------------------------

test("runMergeQueue: --apply + --dry-run forces dry-run (no merges, no release)", async () => {
  // Finding 4df8287d: dry-run must win over apply so operators who pass both
  // never perform live sequential merges or release prepare.
  const deps = makeMergeQueueDeps({
    candidates: [{ issueNumber: 1, prNumber: 10, title: "would merge" }],
    remainingAfterApply: [],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      dryRun: true,
      releaseWhenComplete: true,
      releaseVersion: "minor",
    },
    deps,
  );
  assert.equal(result.mode, "dry-run");
  assert.equal(deps.mergeCalls.length, 0, "must not merge when dryRun is set");
  assert.equal(deps.releaseCalls.length, 0, "must not call runRelease when dryRun is set");
  // Non-empty current queue → would-not-prepare (dry-run uses current state).
  assert.equal(result.release.status, "skipped");
  assert.ok(result.release.skipReason?.includes("remaining"));
});

test("runMergeQueue: --apply + --dry-run on already-complete queue still does not prepare", async () => {
  const deps = makeMergeQueueDeps({
    candidates: [],
    remainingAfterApply: [],
  });
  const result = await runMergeQueue(
    {
      ...baseOpts,
      apply: true,
      dryRun: true,
      releaseWhenComplete: true,
      releaseVersion: "1.2.3",
    },
    deps,
  );
  assert.equal(result.mode, "dry-run");
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.releaseCalls.length, 0, "would_prepare must not invoke runRelease");
  assert.equal(result.release.status, "would_prepare");
});

test("runMergeQueue: PR discovery failure during completion re-query skips release prepare", async () => {
  // Finding 7254b2e7: a failed PR lookup must not empty the remaining-candidate
  // set and falsely mark the queue complete (which would prepare a release).
  const mergeCalls: MergeQueueCandidate[] = [];
  const releaseCalls: Array<{ version: string; opts: { dryRun?: boolean; noEdit?: boolean } }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let listCount = 0;
  const deps: MergeQueueDeps = {
    async listR2dCandidates() {
      listCount += 1;
      if (listCount === 1) {
        return [{ issueNumber: 7, prNumber: 70, title: "merged then re-query fails" }];
      }
      // Simulate gh pr list failure during post-drive completeness re-query.
      throw new Error(
        "[merge-queue] gh pr list failed for issue #7 (exit 1): API rate limit",
      );
    },
    async listOpenNonCandidates() {
      return [];
    },
    async mergeCandidate(c) {
      mergeCalls.push(c);
    },
    async runRelease(version, opts) {
      releaseCalls.push({ version, opts });
    },
    log(msg) {
      logs.push(msg);
    },
    error(msg) {
      errors.push(msg);
    },
  };

  await assert.rejects(
    () =>
      runMergeQueue(
        {
          ...baseOpts,
          apply: true,
          releaseWhenComplete: true,
          releaseVersion: "minor",
        },
        deps,
      ),
    /gh pr list failed for issue #7/,
  );
  assert.equal(mergeCalls.length, 1, "merge already performed must remain done");
  assert.equal(releaseCalls.length, 0, "must not prepare release when re-query fails");
  assert.equal(listCount, 2, "re-query must have been attempted");
});

