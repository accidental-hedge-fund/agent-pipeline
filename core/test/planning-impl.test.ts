// Regression tests for implementation-step commit reference (#68, 4.1/4.2)
// and plan-revision acknowledgement section (#68, 4.10/4.11).
//
// Tests are against the exported gate functions, not the full `advance` chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapWorktree,
  enforceImplCommitRef,
  enforceOpenspecChangeSingular,
  invokeImplementer,
  type BootstrapWorktreeDeps,
} from "../scripts/stages/planning.ts";
import { verifyPlanRevisionOutput } from "../scripts/verify-harness-commits.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig } from "../scripts/types.ts";

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Implementer harness invocation — models.implementing slot (#70)
//
// Both the standard and OpenSpec implementing paths route through
// `invokeImplementer`, so exercising the wrapper with an injected `invoke` seam
// covers both call sites: the per-repo `models.implementing` alias reaches the
// harness when no CLI override is given, and a CLI `--model` override wins.
// ---------------------------------------------------------------------------

function okResult(): HarnessResult {
  return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 1, timed_out: false };
}

function cfgWithImplementing(alias: string): PipelineConfig {
  return {
    implementation_timeout: 2400,
    models: { planning: "sonnet", implementing: alias, review: "opus", fix: "sonnet" },
  } as unknown as PipelineConfig;
}

test("invokeImplementer: passes cfg.models.implementing to the harness when no CLI override (#70)", async () => {
  let captured: { harness: string; wt: string; prompt: string; model?: string; timeoutSec?: number } | undefined;
  const deps = {
    invoke: async (harness: any, wt: string, prompt: string, opts: any): Promise<HarnessResult> => {
      captured = { harness, wt, prompt, model: opts.model, timeoutSec: opts.timeoutSec };
      return okResult();
    },
  };
  const cfg = cfgWithImplementing("haiku");
  const res = await invokeImplementer("claude", "/wt", "impl prompt", cfg, {}, deps);
  assert.equal(res.success, true);
  // The slot reaches the harness — the gap #70 closed (call sites passed bare opts.model).
  assert.equal(captured?.model, "haiku");
  assert.equal(captured?.timeoutSec, cfg.implementation_timeout);
  assert.equal(captured?.harness, "claude");
  assert.equal(captured?.wt, "/wt");
  assert.equal(captured?.prompt, "impl prompt");
});

test("invokeImplementer: CLI --model override wins over cfg.models.implementing (#70)", async () => {
  let capturedModel: string | undefined;
  const deps = {
    invoke: async (_h: any, _wt: string, _p: string, opts: any): Promise<HarnessResult> => {
      capturedModel = opts.model;
      return okResult();
    },
  };
  await invokeImplementer("claude", "/wt", "p", cfgWithImplementing("haiku"), { model: "opus" }, deps);
  assert.equal(capturedModel, "opus");
});

test("invokeImplementer: forwards cfg.harness_sandbox as sandbox option to invoke (#21)", async () => {
  let capturedSandbox: boolean | undefined;
  const deps = {
    invoke: async (_h: any, _wt: string, _p: string, opts: any): Promise<HarnessResult> => {
      capturedSandbox = opts.sandbox;
      return okResult();
    },
  };
  const cfg = { ...cfgWithImplementing("sonnet"), harness_sandbox: true } as unknown as PipelineConfig;
  await invokeImplementer("claude", "/wt", "p", cfg, {}, deps);
  assert.equal(capturedSandbox, true, "sandbox flag must be forwarded from cfg.harness_sandbox");
});

test("invokeImplementer: harness_sandbox:false forwards sandbox:false to invoke (#21)", async () => {
  let capturedSandbox: boolean | undefined;
  const deps = {
    invoke: async (_h: any, _wt: string, _p: string, opts: any): Promise<HarnessResult> => {
      capturedSandbox = opts.sandbox;
      return okResult();
    },
  };
  const cfg = { ...cfgWithImplementing("sonnet"), harness_sandbox: false } as unknown as PipelineConfig;
  await invokeImplementer("claude", "/wt", "p", cfg, {}, deps);
  assert.equal(capturedSandbox, false, "sandbox:false must be forwarded (default unchanged)");
});

// ---------------------------------------------------------------------------
// Implementation step — issue reference (4.1 / 4.2)
// ---------------------------------------------------------------------------

test("impl: at least one commit contains issue reference → proceeds (4.2)", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement harness verification for #68\n",
  ]));
  assert.equal(result.ok, true);
});

test("impl: reference in commit body → proceeds", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement feature\n\nCloses #68",
  ]));
  assert.equal(result.ok, true);
});

test("impl: no commit references the issue → blocked (4.1)", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement feature\n",
    "add tests\n",
  ]));
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("#68"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("impl: empty commit range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

test("impl: wrong issue number in commits → blocked", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "implement feature for #99\n",
  ]));
  assert.equal(result.ok, false);
});

test("impl: multiple commits, only last references issue → proceeds", async () => {
  const result = await enforceImplCommitRef(68, "/wt", "abc", msgsDeps([
    "chore: setup\n",
    "feat: core logic\n",
    "feat: wire up and close #68\n",
  ]));
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Plan-revision acknowledgement section (4.10 / 4.11)
// ---------------------------------------------------------------------------

test("plan-revision ack: section present with ADDRESSED item → proceeds (4.11)", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] Added commit message format check",
    "",
    "## Revised Plan",
    "Here is the revised plan...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: section present with DEFERRED item → proceeds (4.11)", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [DEFERRED] Skipping trailer check — reason: no prompt currently asks for trailers",
    "",
    "## Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: section present with both items → proceeds", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] Added issue reference check",
    "- [DEFERRED] Refactoring out of scope — reason: separate issue",
    "",
    "## Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: bolded tags (- **[ADDRESSED]**) → proceeds (#56 regression)", () => {
  // Models routinely bold the tag. The live #56 run emitted exactly this format
  // and was wrongly blocked by an over-strict regex that didn't tolerate the **
  // (or other markdown emphasis) between the bullet and the tag.
  const stdout = [
    "## Feedback Incorporated",
    "",
    "- **[ADDRESSED]** Resolve the commitSha type boundary",
    "- **[ADDRESSED]** Strengthen the drift guard",
    "- *[DEFERRED]* Refactor — reason: separate issue",
    "",
    "## Revised Implementation Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: bolded tags satisfy the feedback-coverage count (#56 regression)", () => {
  const feedback = "1. First change\n2. Second change\n3. Third change";
  const stdout = [
    "## Feedback Incorporated",
    "- **[ADDRESSED]** one",
    "- **[ADDRESSED]** two",
    "- **[DEFERRED]** three — reason: out of scope",
    "",
    "## Plan",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout, feedback), { ok: true });
});

test("plan-revision ack: section entirely absent → blocked (4.10)", () => {
  const result = verifyPlanRevisionOutput("## Revised Plan\n\nHere is the plan.");
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("## Feedback Incorporated"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("plan-revision ack: section present but no tagged items → blocked", () => {
  const result = verifyPlanRevisionOutput(
    "## Feedback Incorporated\n\nI considered the feedback carefully.\n\n## Plan\n...",
  );
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("[ADDRESSED]"));
});

test("plan-revision ack: empty output → blocked (4.10)", () => {
  const result = verifyPlanRevisionOutput("");
  assert.equal(result.ok, false);
});

test("plan-revision ack: lowercase section header accepted (case-insensitive)", () => {
  const stdout = "## feedback incorporated\n- [ADDRESSED] done\n## Plan\n...";
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("plan-revision ack: item with lowercase tag accepted (case-insensitive)", () => {
  const stdout = "## Feedback Incorporated\n- [addressed] done\n## Plan\n...";
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

// ---------------------------------------------------------------------------
// OpenSpec change singularity gate (finding 3)
// ---------------------------------------------------------------------------

test("openspec singularity: exactly one fresh change → ok (finding 3)", () => {
  const result = enforceOpenspecChangeSingular(["change-abc"], ["change-abc"]);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.changeId, "change-abc");
});

test("openspec singularity: multiple fresh changes → blocked (finding 3)", () => {
  const result = enforceOpenspecChangeSingular(
    ["change-abc", "change-def"],
    ["change-abc", "change-def"],
  );
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.reason.includes("2 new changes"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("openspec singularity: no fresh, single pre-existing change → ok (fallback)", () => {
  const result = enforceOpenspecChangeSingular([], ["change-abc"]);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.changeId, "change-abc");
});

test("openspec singularity: no fresh, no pre-existing → blocked", () => {
  const result = enforceOpenspecChangeSingular([], []);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("no openspec change"));
});

test("openspec singularity: no fresh, multiple pre-existing → blocked (ambiguous)", () => {
  const result = enforceOpenspecChangeSingular([], ["change-abc", "change-def"]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("no openspec change"));
});

// ---------------------------------------------------------------------------
// bootstrapWorktree — worktree cleanup on install failure (finding 1, review-2)
//
// Regression for: setup failure leaves a live worktree that countActive() counts,
// so a subsequent createWorktree at max_concurrent_worktrees: 1 hits capacity
// instead of reclaiming the failed issue's own stale path.
// ---------------------------------------------------------------------------

const stubCfg = {} as import("../scripts/types.ts").PipelineConfig;

test("bootstrapWorktree: happy path returns ok:true with wt", async () => {
  const deps: BootstrapWorktreeDeps = {
    createWorktree: async () => ({ path: "/wt/pipeline-42-slug", branch: "pipeline/42-slug" }),
    detectAndInstall: async () => ({ skipped: false, command: "pnpm install" }),
    removeWorktree: async () => { throw new Error("should not be called"); },
  };
  const result = await bootstrapWorktree(stubCfg, 42, "slug", deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.wt.path, "/wt/pipeline-42-slug");
    assert.equal(result.setupCommand, "pnpm install");
  }
});

test("bootstrapWorktree: worktree creation failure returns ok:false, does not call removeWorktree", async () => {
  let removeCalled = false;
  const deps: BootstrapWorktreeDeps = {
    createWorktree: async () => { throw new Error("git worktree add failed"); },
    detectAndInstall: async () => { throw new Error("should not be called"); },
    removeWorktree: async () => { removeCalled = true; },
  };
  const result = await bootstrapWorktree(stubCfg, 42, "slug", deps);
  assert.equal(result.ok, false);
  assert.equal(removeCalled, false, "removeWorktree must not be called when createWorktree fails");
  if (!result.ok) {
    assert.equal(result.tag, "worktree-creation-failed");
    assert.ok(result.reason.includes("git worktree add failed"));
  }
});

test("bootstrapWorktree: install failure → removeWorktree called before returning (finding 1 regression)", async () => {
  let removeCalledWith: { issueNumber: number; slug: string } | null = null;
  const deps: BootstrapWorktreeDeps = {
    createWorktree: async () => ({ path: "/wt/pipeline-42-slug", branch: "pipeline/42-slug" }),
    detectAndInstall: async () => { throw new Error("pnpm install exited with code 1"); },
    removeWorktree: async (_cfg, issueNumber, slug) => {
      removeCalledWith = { issueNumber, slug };
    },
  };
  const result = await bootstrapWorktree(stubCfg, 42, "slug", deps);
  assert.equal(result.ok, false);
  assert.ok(removeCalledWith !== null, "removeWorktree must be called to free capacity on retry");
  assert.equal(removeCalledWith!.issueNumber, 42);
  assert.equal(removeCalledWith!.slug, "slug");
  if (!result.ok) {
    assert.equal(result.tag, "worktree-setup-failed");
    assert.ok(result.reason.includes("pnpm install exited with code 1"));
  }
});

test("bootstrapWorktree: unblock-and-rerun at max_concurrent_worktrees: 1 — capacity freed after cleanup", async () => {
  // Simulates the review-2 finding 1 scenario:
  //   run 1: install fails → removeWorktree is called
  //   run 2: createWorktree can proceed (the stale entry was removed)
  let createCallCount = 0;
  let removeCallCount = 0;

  const failingInstallDeps: BootstrapWorktreeDeps = {
    createWorktree: async () => { createCallCount++; return { path: "/wt", branch: "pipeline/42-slug" }; },
    detectAndInstall: async () => { throw new Error("install failed"); },
    removeWorktree: async () => { removeCallCount++; },
  };
  const succeedingInstallDeps: BootstrapWorktreeDeps = {
    createWorktree: async () => { createCallCount++; return { path: "/wt", branch: "pipeline/42-slug" }; },
    detectAndInstall: async () => ({ skipped: false, command: "pnpm install" }),
    removeWorktree: async () => { removeCallCount++; },
  };

  const r1 = await bootstrapWorktree(stubCfg, 42, "slug", failingInstallDeps);
  assert.equal(r1.ok, false, "first run must fail");
  assert.equal(removeCallCount, 1, "cleanup must have run after first failure");
  assert.equal(createCallCount, 1);

  const r2 = await bootstrapWorktree(stubCfg, 42, "slug", succeedingInstallDeps);
  assert.equal(r2.ok, true, "second run must succeed after cleanup freed capacity");
  assert.equal(createCallCount, 2, "createWorktree must be callable again after cleanup");
  assert.equal(removeCallCount, 1, "removeWorktree must not be called on the successful run");
});
