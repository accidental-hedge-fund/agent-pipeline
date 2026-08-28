/**
 * Unit tests for the shared implementer-round skeleton (#629).
 * Fake deps only — no real git, network, or harness subprocesses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runHarnessRound,
  type HarnessRoundDeps,
} from "../scripts/harness-round.ts";

function makeDeps(overrides: Partial<HarnessRoundDeps> = {}): HarnessRoundDeps & {
  calls: string[];
  heads: string[];
} {
  const calls: string[] = [];
  const heads = ["sha-before", "sha-before"];
  let headIdx = 0;
  return {
    calls,
    heads,
    gitHead: async () => {
      calls.push("gitHead");
      const h = heads[Math.min(headIdx, heads.length - 1)]!;
      headIdx++;
      return h;
    },
    reattach: async () => {
      calls.push("reattach");
      return { ok: true };
    },
    salvage: async () => {
      calls.push("salvage");
      return { salvaged: false };
    },
    ...overrides,
  };
}

test("runHarnessRound: captures headBefore before invoke", async () => {
  const order: string[] = [];
  let headReads = 0;
  const deps: HarnessRoundDeps = {
    gitHead: async () => {
      order.push(`gitHead-${++headReads}`);
      return "sha-before";
    },
    salvage: async () => ({ salvaged: false }),
  };
  await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    shouldAttemptSalvage: () => false,
    invoke: async () => {
      order.push("invoke");
      return { success: true };
    },
    afterRound: async (ctx) => {
      order.push("after");
      assert.equal(ctx.headBefore, "sha-before");
      return ctx;
    },
    deps,
  });
  assert.deepEqual(order, ["gitHead-1", "invoke", "gitHead-2", "after"]);
});

test("runHarnessRound: salvage on dirty no-commit when shouldAttemptSalvage is true", async () => {
  const calls: string[] = [];
  let headReads = 0;
  const deps: HarnessRoundDeps = {
    gitHead: async () => {
      headReads++;
      calls.push("gitHead");
      // headBefore + headAfter pre-salvage stay equal; post-salvage advances.
      if (headReads <= 2) return "sha-before";
      return "sha-salvaged";
    },
    salvage: async () => {
      calls.push("salvage");
      return { salvaged: true };
    },
  };

  const ctx = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    shouldAttemptSalvage: ({ confirmedNoNewCommit }) => confirmedNoNewCommit,
    invoke: async () => ({ success: true }),
    afterRound: async (c) => c,
    deps,
  });

  assert.equal(ctx.salvaged, true);
  assert.equal(ctx.salvageAttempted, true);
  assert.equal(ctx.ownershipCheckpointFailed, false);
  assert.equal(ctx.ownershipCheckpointed, false);
  assert.equal(ctx.headAfter, "sha-salvaged");
  assert.ok(calls.includes("salvage"));
});

test("runHarnessRound: no salvage on clean no-commit when shouldAttemptSalvage is false", async () => {
  const deps = makeDeps();
  const ctx = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    shouldAttemptSalvage: () => false,
    invoke: async () => ({ success: true }),
    afterRound: async (c) => c,
    deps,
  });
  assert.equal(ctx.salvageAttempted, false);
  assert.equal(ctx.salvaged, false);
  assert.equal(ctx.ownershipCheckpointed, false);
  assert.ok(!deps.calls.includes("salvage"));
});

test("runHarnessRound #758: onCleanNoNewCommit hook runs after clean salvage-found-nothing", async () => {
  const deps = makeDeps({
    salvage: async () => ({ salvaged: false }),
  });
  let hookArgs: { headBefore: string; headAfter: string } | undefined;
  const ctx = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    shouldAttemptSalvage: ({ confirmedNoNewCommit }) => confirmedNoNewCommit,
    invoke: async () => ({ success: true }),
    onCleanNoNewCommit: async ({ headBefore, headAfter }) => {
      hookArgs = { headBefore, headAfter };
      return { decision: "advance", note: "goal ok" };
    },
    afterRound: async (c) => c,
    deps,
  });
  assert.deepEqual(hookArgs, { headBefore: "sha-before", headAfter: "sha-before" });
  assert.deepEqual(ctx.cleanNoNewCommitHookResult, { decision: "advance", note: "goal ok" });
});

test("runHarnessRound #758: onCleanNoNewCommit omitted preserves stage outcome (no default advance)", async () => {
  const deps = makeDeps({
    salvage: async () => ({ salvaged: false }),
  });
  const ctx = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    shouldAttemptSalvage: () => true,
    invoke: async () => ({ success: true }),
    afterRound: async (c) => c,
    deps,
  });
  assert.equal(ctx.cleanNoNewCommitHookResult, undefined);
  assert.equal(ctx.salvageFoundNothing, true);
});

test("runHarnessRound #758: onCleanNoNewCommit does not run after successful salvage", async () => {
  let headReads = 0;
  const deps: HarnessRoundDeps = {
    gitHead: async () => {
      headReads++;
      return headReads <= 2 ? "sha-before" : "sha-salvaged";
    },
    salvage: async () => ({ salvaged: true }),
  };
  let hookRan = false;
  const ctx = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    shouldAttemptSalvage: () => true,
    invoke: async () => ({ success: true }),
    onCleanNoNewCommit: async () => {
      hookRan = true;
      return { decision: "advance" };
    },
    afterRound: async (c) => c,
    deps,
  });
  assert.equal(hookRan, false);
  assert.equal(ctx.salvaged, true);
  assert.equal(ctx.cleanNoNewCommitHookResult, undefined);
});

test("runHarnessRound: reattach failure short-circuits invoke", async () => {
  const deps = makeDeps({
    reattach: async () => {
      deps.calls.push("reattach");
      return { ok: false, stderr: "detached" };
    },
  });
  let invoked = false;
  const result = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    reattach: { wt: { path: "/wt", slug: "s" }, issueNumber: 1 },
    shouldAttemptSalvage: () => false,
    invoke: async () => {
      invoked = true;
      return { success: true };
    },
    onReattachFailed: (stderr) => ({ blocked: true as const, stderr }),
    afterRound: async () => ({ blocked: false as const, stderr: "" }),
    deps,
  });
  assert.deepEqual(result, { blocked: true, stderr: "detached" });
  assert.equal(invoked, false);
  assert.ok(deps.calls.includes("reattach"));
  assert.ok(!deps.calls.includes("gitHead"));
});

test("runHarnessRound: beforeInvoke abort skips invoke", async () => {
  const deps = makeDeps();
  let invoked = false;
  const result = await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "test",
    beforeInvoke: async () => ({ abort: { status: "claim-failed" as const } }),
    shouldAttemptSalvage: () => false,
    invoke: async () => {
      invoked = true;
      return { success: true };
    },
    afterRound: async () => ({ status: "ok" as const }),
    deps,
  });
  assert.deepEqual(result, { status: "claim-failed" });
  assert.equal(invoked, false);
});
