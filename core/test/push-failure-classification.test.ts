/**
 * #1103: non-fast-forward push is workflow-state, never a rate-limit wait.
 * Injected deps only — no real network, git, or subprocess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  classifyPushFailure,
  decideAncestorPushAfterNoop,
  isStaleTipPushEvidence,
  isTransientPushError,
  NON_FAST_FORWARD_PUSH_STDERR_1038,
  pushWithCurrencyCheck,
  resolveVerifiedRemoteHead,
  type GitPushResult,
} from "../scripts/transient-wrappers.ts";
import { buildStageDiagnostic, projectPipelineReasonCode } from "../scripts/stage-diagnostic.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { realExecuteRecovery } from "../scripts/pipeline.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";
import { isTransientRetryableSite } from "../scripts/escalation-dispositions.ts";

const LOCAL_1038 = "8ea2d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE_1038 = "bb208baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIX_PUSH_SITE = "stages.fix:push-failed#0";
const FAIL_CLOSED_SITE = "gh:dynamic#0";

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "owner/repo", repo_dir: "/repo", base_branch: "main" };
}

function pushGit(stderr: string, code = 1): (args: string[]) => Promise<GitPushResult> {
  return async (args) => {
    if (args[0] === "push") return { stdout: "", stderr, code };
    return { stdout: "", stderr: "", code: 0 };
  };
}

function recordingGit(
  impl: (args: string[]) => Promise<GitPushResult> | GitPushResult,
  sink: string[][],
): (args: string[]) => Promise<GitPushResult> {
  return async (args) => {
    sink.push([...args]);
    return impl(args);
  };
}

function assertNoForcePush(argv: string[][]): void {
  for (const args of argv) {
    assert.equal(args.includes("--force"), false, `force-push forbidden: ${args.join(" ")}`);
    assert.equal(
      args.includes("--force-with-lease"),
      false,
      `force-with-lease forbidden: ${args.join(" ")}`,
    );
  }
}

function issueDetail(labels: string[]) {
  return {
    number: 1038,
    type: "issue" as const,
    title: "t",
    body: "",
    state: "open" as const,
    url: "https://example.test/1038",
    labels,
  };
}

function staleTipInput() {
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-state",
    blockerKind: "push-failed",
    reason: NON_FAST_FORWARD_PUSH_STDERR_1038,
    stage: "fix-1",
  });
  return {
    runId: "loop-73346e80c28e4e77-s1",
    itemId: "1038",
    blockerClass: "workflow-state" as const,
    attemptId: "attempt-1",
    candidateIdentity: `repo=owner/repo|head=${LOCAL_1038}|attempt=0`,
    action: "resync_workflow_state" as const,
    diagnostic,
    evidence: {
      pr_number: 1102,
      pipeline_run_id: "loop-73346e80c28e4e77-s1",
      candidate_identity: "pr:1102:run:loop-73346e80c28e4e77-s1",
    },
  };
}

// ---------------------------------------------------------------------------
// Classifier + wrapper
// ---------------------------------------------------------------------------

test("#1038 fixture classifies as workflow-state with head_drift", () => {
  assert.match(NON_FAST_FORWARD_PUSH_STDERR_1038, /non-fast-forward/i);
  assert.match(NON_FAST_FORWARD_PUSH_STDERR_1038, /! \[rejected\]/);
  assert.match(NON_FAST_FORWARD_PUSH_STDERR_1038, /fetch first/i);
  assert.match(NON_FAST_FORWARD_PUSH_STDERR_1038, /behind/i);

  const classified = classifyPushFailure(NON_FAST_FORWARD_PUSH_STDERR_1038);
  assert.equal(classified.reason_code, "workflow-state");
  assert.equal(classified.head_drift, true);
  assert.equal(classified.retryable, false);
  assert.equal(isTransientPushError(NON_FAST_FORWARD_PUSH_STDERR_1038), false);
});

test("classifyPushFailure is case-insensitive for nff tokens", () => {
  for (const stderr of [
    "NON-FAST-FORWARD",
    "Rejected by remote",
    "please Fetch First then push",
  ]) {
    const classified = classifyPushFailure(stderr);
    assert.equal(classified.reason_code, "workflow-state", stderr);
    assert.equal(classified.head_drift, true, stderr);
    assert.equal(classified.retryable, false, stderr);
  }
});

test("HTTP 5xx / connection-reset without nff tokens stay transient-infra", () => {
  for (const stderr of [
    "HTTP 502 Bad Gateway",
    "connection reset by peer",
    "RPC failed; curl 56 Recv failure",
    "early EOF",
    "could not read from remote repository",
  ]) {
    const classified = classifyPushFailure(stderr);
    assert.equal(classified.reason_code, "transient-infra", stderr);
    assert.equal(classified.head_drift, false, stderr);
    assert.equal(classified.retryable, true, stderr);
  }
});

test("wrapper: #1038 fixture on transient-retryable site is workflow-state, not retried", async () => {
  assert.equal(isTransientRetryableSite(FIX_PUSH_SITE), true);
  let pushes = 0;
  const argv: string[][] = [];
  const result = await pushWithCurrencyCheck("pipeline/1038-x", {
    siteId: FIX_PUSH_SITE,
    sleep: async () => {},
    expectedLocalSha: LOCAL_1038,
    git: recordingGit(async (args) => {
      if (args[0] === "push") {
        pushes++;
        return { stdout: "", stderr: NON_FAST_FORWARD_PUSH_STDERR_1038, code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }, argv),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason_code, "workflow-state");
    assert.equal(result.head_drift, true);
    assert.equal(result.attempts, 1);
  }
  assert.equal(pushes, 1);
  assertNoForcePush(argv);
});

test("wrapper: fail-closed siteId still classifies #1038 fixture as workflow-state", async () => {
  assert.equal(isTransientRetryableSite(FAIL_CLOSED_SITE), false);
  const result = await pushWithCurrencyCheck("pipeline/1038-x", {
    siteId: FAIL_CLOSED_SITE,
    sleep: async () => {},
    git: pushGit(NON_FAST_FORWARD_PUSH_STDERR_1038),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason_code, "workflow-state");
    assert.equal(result.head_drift, true);
    assert.equal(result.attempts, 1);
  }
});

test("wrapper: HTTP 502 still retries after currency re-sync on the same site", async () => {
  let pushes = 0;
  const result = await pushWithCurrencyCheck("pipeline/1038-x", {
    siteId: FIX_PUSH_SITE,
    sleep: async () => {},
    expectedLocalSha: LOCAL_1038,
    git: async (args) => {
      if (args[0] === "push") {
        pushes++;
        if (pushes === 1) return { stdout: "", stderr: "HTTP 502 Bad Gateway", code: 1 };
        return { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${LOCAL_1038}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(pushes, 2);
});

test("wrapper: connection-reset still retries on the same site", async () => {
  let pushes = 0;
  const result = await pushWithCurrencyCheck("pipeline/1038-x", {
    siteId: FIX_PUSH_SITE,
    sleep: async () => {},
    expectedLocalSha: LOCAL_1038,
    git: async (args) => {
      if (args[0] === "push") {
        pushes++;
        if (pushes === 1) return { stdout: "", stderr: "connection reset by peer", code: 1 };
        return { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${LOCAL_1038}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(pushes, 2);
});

// ---------------------------------------------------------------------------
// End-to-end chain (task 4.1 / 4.2)
// ---------------------------------------------------------------------------

test("#1038 e2e: fixture → wrapper → fix diagnostic → durable workflow-state → resync, never wait_and_retry", async () => {
  const pushResult = await pushWithCurrencyCheck("pipeline/1038-x", {
    siteId: FIX_PUSH_SITE,
    sleep: async () => {},
    git: pushGit(NON_FAST_FORWARD_PUSH_STDERR_1038),
  });
  assert.equal(pushResult.ok, false);
  if (pushResult.ok) return;

  // Fix-stage diagnostic uses the wrapper reason_code (no site ternary).
  const diagnostic = buildStageDiagnostic({
    reasonCode: pushResult.reason_code,
    blockerKind: "push-failed",
    reason: pushResult.reason,
    stage: "fix-1",
  });
  assert.equal(diagnostic.reason_code, "workflow-state");
  assert.equal(diagnostic.detail.blocker_kind, "push-failed");

  const projection = projectPipelineReasonCode(diagnostic.reason_code);
  assert.equal(projection.blockerClass, "workflow-state");
  assert.notEqual(projection.blockerClass, "transient-rate-limit");

  const recipes = DEFAULT_RECOVERY_POLICY["workflow-state"].recipes;
  assert.equal(recipes[0], "resync_workflow_state");
  assert.equal(recipes.includes("wait_and_retry"), false);

  assert.equal(
    isStaleTipPushEvidence({
      reasonCode: diagnostic.reason_code,
      blockerKind: diagnostic.detail.blocker_kind,
      reason: diagnostic.detail.reason,
    }),
    true,
  );

  // Pre-fix mapping that parked #1038 (documented so this test would have bitten).
  const preFixWrapper = { reason_code: "transient-infra" as const, head_drift: false };
  const preFixReason = preFixWrapper.head_drift ? "workflow-state" : "transient-infra";
  assert.equal(preFixReason, "transient-infra");
  assert.equal(projectPipelineReasonCode(preFixReason).blockerClass, "transient-rate-limit");
  assert.deepEqual(DEFAULT_RECOVERY_POLICY["transient-rate-limit"].recipes, ["wait_and_retry"]);
});

test("durable projection of #1038 fixture is workflow-state, not transient-rate-limit", () => {
  const classified = classifyPushFailure(NON_FAST_FORWARD_PUSH_STDERR_1038);
  assert.equal(projectPipelineReasonCode(classified.reason_code).blockerClass, "workflow-state");
  assert.notEqual(
    projectPipelineReasonCode(classified.reason_code).blockerClass,
    "transient-rate-limit",
  );
});

// ---------------------------------------------------------------------------
// Source pins: callers emit wrapper reason_code
// ---------------------------------------------------------------------------

test("source pin: fix.ts emits pushResult.reason_code and has no head_drift ternary", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /reasonCode:\s*pushResult\.reason_code/);
  assert.doesNotMatch(
    src,
    /pushResult\.head_drift\s*\?\s*"workflow-state"\s*:\s*"transient-infra"/,
  );
  assert.match(src, /decideAncestorPushAfterNoop/);
});

test("source pin: planning.ts emits pushResult.reason_code on push-failed", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/planning.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /reasonCode:\s*pushResult\.reason_code/);
  assert.match(src, /blockerKind:\s*"push-failed"/);
});

test("source pin: wrapper classifies before retry eligibility on every path", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/transient-wrappers.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /export function classifyPushFailure/);
  assert.match(src, /export const NON_FAST_FORWARD_PUSH_STDERR_1038/);
  assert.match(src, /classifiedPushFailure/);
});

// ---------------------------------------------------------------------------
// Noop ancestry skip-push (task 4.4)
// ---------------------------------------------------------------------------

test("noop ancestry: remote-ahead skips push", async () => {
  const argv: string[][] = [];
  const decision = await decideAncestorPushAfterNoop("pipeline/1038-x", {
    localHead: LOCAL_1038,
    resolveOpenPrHead: async () => REMOTE_1038,
    git: recordingGit(async (args) => {
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        assert.equal(args[2], LOCAL_1038);
        assert.equal(args[3], REMOTE_1038);
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }, argv),
  });
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.verifiedHead, REMOTE_1038);
    assert.equal(decision.source, "open-pr");
  }
  assert.equal(argv.some((a) => a[0] === "push"), false);
  assert.equal(argv.some((a) => a[0] === "reset"), false);
  assertNoForcePush(argv);
});

test("noop ancestry: equal HEAD and verified remote skip push", async () => {
  const decision = await decideAncestorPushAfterNoop("pipeline/1038-x", {
    localHead: REMOTE_1038,
    resolveOpenPrHead: async () => REMOTE_1038,
    git: async (args) => {
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(decision.action, "skip");
});

test("noop ancestry: local-ahead / diverged uses the wrapper (does not skip)", async () => {
  const decision = await decideAncestorPushAfterNoop("pipeline/1038-x", {
    localHead: LOCAL_1038,
    resolveOpenPrHead: async () => REMOTE_1038,
    git: async (args) => {
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(decision.action, "push");
  if (decision.action === "push") {
    assert.equal(decision.reason, "local-ahead-or-diverged");
  }
});

test("noop ancestry: unverified remote does not skip and does not reset", async () => {
  const argv: string[][] = [];
  const decision = await decideAncestorPushAfterNoop("pipeline/1038-x", {
    localHead: LOCAL_1038,
    resolveOpenPrHead: async () => null,
    git: recordingGit(async (args) => {
      if (args[0] === "fetch") return { stdout: "", stderr: "could not resolve host", code: 128 };
      return { stdout: "", stderr: "fatal", code: 128 };
    }, argv),
  });
  assert.equal(decision.action, "push");
  if (decision.action === "push") {
    assert.equal(decision.reason, "unverified-remote-head");
  }
  assert.equal(argv.some((a) => a[0] === "reset"), false);
  assert.equal(argv.some((a) => a[0] === "merge"), false);
  assertNoForcePush(argv);
});

test("resolveVerifiedRemoteHead prefers open-PR head over origin branch", async () => {
  const verified = await resolveVerifiedRemoteHead("pipeline/1038-x", {
    resolveOpenPrHead: async () => REMOTE_1038,
    git: async (args) => {
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("FETCH_HEAD")) {
        return { stdout: "ffffffffffffffffffffffffffffffffffffffff\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.sha, REMOTE_1038);
    assert.equal(verified.source, "open-pr");
  }
});

// ---------------------------------------------------------------------------
// Recovery recipe (task 4.5)
// ---------------------------------------------------------------------------

test("resync_workflow_state for #1038 rematerializes/fast-forwards, never wait_and_retry, never force-push", async () => {
  const argv: string[][] = [];
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/1038", slug: "1038-x" }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: 1102, headSha: REMOTE_1038 }),
    gitInWorktree: async (_path, args) => {
      argv.push([...args]);
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${LOCAL_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "merge" && args[1] === "--ff-only") {
        assert.equal(args[2], REMOTE_1038);
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () =>
      issueDetail(clears === 0 ? ["blocked", "pipeline:fix-1"] : ["pipeline:fix-1"]),
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => assert.fail("repair must not run for resync"),
  });

  const result = await execute(staleTipInput());
  assert.equal(result.succeeded, true);
  assert.equal(clears, 1);
  assert.match(result.evidence, /fast-forwarded|moved managed worktree|rematerialized/i);
  assert.ok(argv.some((a) => a[0] === "merge" && a[1] === "--ff-only"));
  assertNoForcePush(argv);
  assert.equal(DEFAULT_RECOVERY_POLICY["workflow-state"].recipes.includes("wait_and_retry"), false);
});

test("resync_workflow_state rematerializes an absent tree onto the verified tip", async () => {
  let rematCalls = 0;
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => null,
    ensureManagedWorktree: async () => {
      rematCalls++;
      return {
        result: "pass",
        worktree: { path: "/wt/1038", slug: "1038-x", branch: "pipeline/1038-x" },
        reason: "recreated from open PR head bb208ba",
      };
    },
    getIssueDetail: async () =>
      issueDetail(clears === 0 ? ["blocked", "pipeline:fix-1"] : ["pipeline:fix-1"]),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(staleTipInput());
  assert.equal(result.succeeded, true);
  assert.equal(rematCalls, 1);
  assert.equal(clears, 1);
});

test("dirty worktree refuses rematerialize/reset typed and is not wait_and_retry", async () => {
  const argv: string[][] = [];
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/1038", slug: "1038-x" }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: 1102, headSha: REMOTE_1038 }),
    gitInWorktree: async (_path, args) => {
      argv.push([...args]);
      if (args[0] === "status") return { stdout: " M core/scripts/fix.ts\n", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => issueDetail(["blocked", "pipeline:fix-1"]),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(staleTipInput());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? result.evidence, /dirty-worktree/);
  assert.equal(clears, 0);
  assert.equal(argv.some((a) => a[0] === "reset"), false);
  assert.equal(argv.some((a) => a[0] === "merge"), false);
  assertNoForcePush(argv);
  assert.equal(DEFAULT_RECOVERY_POLICY["workflow-state"].recipes[1], "repair_pipeline_item");
  assert.equal(DEFAULT_RECOVERY_POLICY["workflow-state"].recipes.includes("wait_and_retry"), false);
});

test("local-only unique commits refuse reset typed and are not wait_and_retry", async () => {
  const argv: string[][] = [];
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/1038", slug: "1038-x" }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: 1102, headSha: REMOTE_1038 }),
    gitInWorktree: async (_path, args) => {
      argv.push([...args]);
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { stdout: `${REMOTE_1038}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => issueDetail(["blocked", "pipeline:fix-1"]),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(staleTipInput());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? result.evidence, /local-only-unpushed/);
  assert.equal(clears, 0);
  assert.equal(argv.some((a) => a[0] === "reset"), false);
  assertNoForcePush(argv);
});

test("unverified remote head refuses without mutate", async () => {
  const argv: string[][] = [];
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/1038", slug: "1038-x" }),
    resolveOpenPrHeadForBranch: async () => null,
    gitInWorktree: async (_path, args) => {
      argv.push([...args]);
      if (args[0] === "fetch") return { stdout: "", stderr: "fatal: unable to access", code: 128 };
      return { stdout: "", stderr: "fatal", code: 128 };
    },
    getIssueDetail: async () => issueDetail(["blocked", "pipeline:fix-1"]),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(staleTipInput());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? result.evidence, /unverified-remote-head/);
  assert.equal(clears, 0);
  assert.equal(argv.some((a) => a[0] === "reset"), false);
  assert.equal(argv.some((a) => a[0] === "merge"), false);
  assertNoForcePush(argv);
});

test("merge-conflict workflow-state resync does not rematerialize (stale-tip scope)", async () => {
  let remat = 0;
  let gitCalls = 0;
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x" }),
    ensureManagedWorktree: async () => {
      remat++;
      return { result: "fail", worktree: null, reason: "should not run", blockerKind: "worktree-missing" };
    },
    gitInWorktree: async () => {
      gitCalls++;
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () =>
      issueDetail(clears === 0 ? ["blocked", "pipeline:pre-merge"] : ["pipeline:pre-merge"]),
    clearBlocked: async () => {
      clears++;
    },
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "cannot apply base",
    stage: "pre-merge",
  });
  const result = await execute({
    ...staleTipInput(),
    itemId: "42",
    diagnostic,
  });
  assert.equal(result.succeeded, true);
  assert.equal(remat, 0);
  assert.equal(gitCalls, 0);
  assert.equal(clears, 1);
});
