import assert from "node:assert/strict";
import test from "node:test";
import { createRepairPipelineItemExecutor } from "../scripts/loop/repair-pipeline-item.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

function cfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
    harnesses: {
      ...DEFAULT_CONFIG.harnesses,
      implementer: "any-registered-adapter",
    },
    effort: { ...DEFAULT_CONFIG.effort, fix: "high" },
  };
}

function input() {
  return {
    runId: "loop-1",
    itemId: "42",
    attemptId: "attempt-1",
    candidateIdentity: `repo=owner/repo|base=main|pr=7|head=${HEAD}|advance=run-1|attempt=0`,
    diagnostic: buildStageDiagnostic({
      reasonCode: "openspec-archive-apply-conflict",
      evidenceKey: "openspec-archive-apply-conflict:change-a:archive_spec_update_failed",
      blockerKind: "openspec-invalid",
      reason: "archive could not apply the delta",
      stage: "pre-merge",
      offrampClass: "openspec-invalid",
    }),
  };
}

test("repair_pipeline_item uses the configured repair transaction and only succeeds after push", async () => {
  const calls: string[] = [];
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "Repair archive",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked", "pipeline:pre-merge"],
    }),
    invoke: async (_harness, _worktree, _prompt, opts) => {
      assert.equal(opts.reasoningEffort, "high");
      return {
        success: true,
        stdout: "",
        stderr: "",
        exit_code: 0,
        duration: 1,
        timed_out: false,
      };
    },
    performRepair: async (resolvedCfg, issueNumber, runId, findings, title, _wt, _git, invokeFn) => {
      assert.equal(resolvedCfg.harnesses.implementer, "any-registered-adapter");
      assert.equal(issueNumber, 42);
      assert.equal(runId, "loop-1");
      assert.equal(title, "Repair archive");
      assert.match(findings, /openspec-archive-apply-conflict/);
      await invokeFn(resolvedCfg.harnesses.implementer, "/repo/.worktrees/42", "repair", {});
      calls.push("repair");
      return { status: "fix-committed", headSha: NEXT };
    },
    clearBlocked: async () => {
      calls.push("clear");
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.deepEqual(calls, ["repair", "clear"]);
  assert.match(result.evidence, new RegExp(`${HEAD}.*${NEXT}`));
});

test("repair_pipeline_item resolves every configured implementer through the same adapter contract", async () => {
  const adapters = ["claude", "codex", "grok", "extension-adapter"];
  const invoked: string[] = [];

  for (const adapter of adapters) {
    const configured = cfg();
    configured.harnesses = { ...configured.harnesses, implementer: adapter };
    const execute = createRepairPipelineItemExecutor(configured, {
      getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
      gitInWorktree: async () => ({ code: 0, stdout: `${HEAD}\n`, stderr: "" }),
      getIssueDetail: async () => ({
        number: 42,
        type: "issue",
        title: "Repair archive",
        body: "",
        state: "open",
        url: "https://example.test/42",
        labels: ["blocked"],
      }),
      invoke: async (harness, _worktree, _prompt, opts) => {
        invoked.push(harness);
        assert.equal(opts.reasoningEffort, "high");
        return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 1, timed_out: false };
      },
      performRepair: async (resolvedCfg, _issue, _run, _findings, _title, _wt, _git, invokeFn) => {
        await invokeFn(resolvedCfg.harnesses.implementer, "/repo/.worktrees/42", "repair", {});
        return { status: "fix-committed", headSha: NEXT };
      },
      clearBlocked: async () => {},
    });

    assert.equal((await execute(input())).succeeded, true);
  }

  assert.deepEqual(invoked, adapters);
});

test("repair_pipeline_item refuses stale candidate identity before model execution", async () => {
  let repaired = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => ({
      code: 0,
      stdout: args[0] === "log" ? "feat: unrelated concurrent change\n" : `${NEXT}\n`,
      stderr: "",
    }),
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.equal(repaired, false);
  assert.match(result.error ?? "", /candidate moved/);
});

test("repair_pipeline_item reconciles its already-pushed commit after a crash without replaying the model", async () => {
  let repaired = false;
  let cleared = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => ({
      code: 0,
      stdout:
        args[0] === "log"
          ? "fix: pipeline recovery attempt-1 for #42\n"
          : args[0] === "ls-remote"
            ? `${NEXT}\trefs/heads/pipeline/issue-42-repair\n`
            : `${NEXT}\n`,
      stderr: "",
    }),
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
    clearBlocked: async () => {
      cleared = true;
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.equal(repaired, false);
  assert.equal(cleared, true);
  assert.match(result.evidence, /without replaying the implementer/);
});

test("repair_pipeline_item pushes its clean marked commit after a crash before push without replaying the model", async () => {
  let repaired = false;
  let cleared = false;
  let pushed = false;
  let remoteReads = 0;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "push") pushed = true;
      if (args[0] === "ls-remote") remoteReads++;
      return {
        code: 0,
        stdout:
          args[0] === "log"
            ? "fix: pipeline recovery attempt-1 for #42\n"
          : args[0] === "ls-remote"
              ? `${remoteReads === 1 ? HEAD : NEXT}\trefs/heads/pipeline/issue-42-repair\n`
              : args[0] === "status"
                ? ""
                : args[0] === "rev-parse" && args[1] === "HEAD^"
                  ? `${HEAD}\n`
                  : args[0] === "rev-parse"
                    ? `${NEXT}\n`
                    : "",
        stderr: "",
      };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "Repair archive",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked", "pipeline:pre-merge"],
    }),
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
    clearBlocked: async () => {
      cleared = true;
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.equal(pushed, true);
  assert.equal(repaired, false);
  assert.equal(cleared, true);
});

test("repair_pipeline_item charges a clean model no-op as failure instead of claiming repair", async () => {
  let cleared = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async () => ({ code: 0, stdout: `${HEAD}\n`, stderr: "" }),
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "Repair archive",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked"],
    }),
    performRepair: async () => ({
      status: "noop-clean",
      headSha: HEAD,
      diagnostic: "no changes",
    }),
    clearBlocked: async () => {
      cleared = true;
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.equal(cleared, false);
  assert.match(result.error ?? "", /no verifiable candidate change/);
});

for (const fixture of [
  { name: "closed issue", state: "closed", labels: ["blocked"], error: /closed issue/ },
  { name: "ready issue", state: "open", labels: ["pipeline:ready-to-deploy"], error: /already ready to deploy/ },
] as const) {
  test(`repair_pipeline_item refuses substantive model work for a ${fixture.name}`, async () => {
    let repaired = false;
    const execute = createRepairPipelineItemExecutor(cfg(), {
      getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
      gitInWorktree: async () => ({ code: 0, stdout: `${HEAD}\n`, stderr: "" }),
      getIssueDetail: async () => ({
        number: 42,
        type: "issue",
        title: "Superseded repair",
        body: "",
        state: fixture.state,
        url: "https://example.test/42",
        labels: [...fixture.labels],
      }),
      performRepair: async () => {
        repaired = true;
        return { status: "fix-committed", headSha: NEXT };
      },
    });

    const result = await execute(input());
    assert.equal(result.succeeded, false);
    assert.equal(repaired, false);
    assert.match(result.error ?? "", fixture.error);
  });
}
