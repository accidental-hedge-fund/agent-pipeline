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
      if (args[0] === "update-ref") {
        if (args[1] === "-d") {
          assert.deepEqual(args, ["update-ref", "-d", "refs/pipeline-recovery/attempt-1"]);
          calls.push("breadcrumb-drop");
        } else {
          assert.deepEqual(args, ["update-ref", "refs/pipeline-recovery/attempt-1", HEAD]);
          calls.push("breadcrumb");
        }
        return { code: 0, stdout: "", stderr: "" };
      }
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
  // The durable pre-invocation breadcrumb must land BEFORE the harness seam
  // runs (crash-window proof of authorship) and retire on controlled return.
  assert.deepEqual(calls, ["breadcrumb", "repair", "breadcrumb-drop", "clear"]);
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
  assert.match(result.error ?? "", /category=noop-clean/);
  assert.match(result.error ?? "", /status=noop-clean/);
  assert.match(result.error ?? "", /diagnostic=no changes/);
});

test("repair_pipeline_item #1060: harness error with diagnostic is category harness-error with tail", async () => {
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
      status: "error",
      diagnostic: "implementer crashed: exit 1\nstderr: stacktrace line 99",
    }),
  });
  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /status=error/);
  assert.match(result.error ?? "", /category=harness-error/);
  assert.match(result.error ?? "", /implementer crashed/);
  assert.match(result.error ?? "", /did not produce a committed and pushed repair/);
  assert.notEqual(
    result.error,
    "configured implementer did not produce a committed and pushed repair for " + HEAD,
    "must not collapse to generic-only string",
  );
});

test("repair_pipeline_item #1060: bare error with residual porcelain is dirt-blocked with path summary", async () => {
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "status") {
        return {
          code: 0,
          stdout: "?? artifacts/challenge-response-599.json\n M core/scripts/identity.ts\n",
          stderr: "",
        };
      }
      if (args[0] === "update-ref") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "Repair archive",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked"],
    }),
    // Bare pre-dirty-style error with no diagnostic (historical autofix shape).
    performRepair: async () => ({ status: "error" }),
  });
  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /category=dirt-blocked/);
  assert.match(result.error ?? "", /engine-scratch:artifacts\/challenge-response-599\.json|product:core\/scripts\/identity\.ts/);
  assert.match(result.error ?? "", /status=error/);
});

test("repair_pipeline_item #1060: no diagnostic and clean tree is category no-diagnostic", async () => {
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "Repair archive",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked"],
    }),
    performRepair: async () => ({ status: "error" }),
  });
  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /category=no-diagnostic/);
  assert.match(result.error ?? "", /no diagnostic was captured/);
  assert.match(result.error ?? "", /status=error/);
});

test("repair_pipeline_item hard-syncs a present-but-stale worktree when the remote still holds the claimed head", async () => {
  const STALE = "d".repeat(40);
  let synced = false;
  let fetched = false;
  let repaired = false;
  let ancestryChecked = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "log") return { code: 0, stdout: "feat: human push landed upstream\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${HEAD}\trefs/heads/pipeline/42-repair\n`, stderr: "" };
      }
      if (args[0] === "fetch") {
        fetched = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        // Strictly behind: the stale HEAD is an ancestor of the claimed head.
        assert.deepEqual(args, ["merge-base", "--is-ancestor", "HEAD", HEAD]);
        ancestryChecked = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "reset") {
        assert.deepEqual(args, ["reset", "--hard", HEAD]);
        synced = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD^") {
        return { code: 0, stdout: `${"e".repeat(40)}\n`, stderr: "" };
      }
      return { code: 0, stdout: `${synced ? HEAD : STALE}\n`, stderr: "" };
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
    clearBlocked: async () => {},
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.equal(fetched, true);
  assert.equal(ancestryChecked, true);
  assert.equal(synced, true);
  assert.equal(repaired, true);
  assert.equal(result.candidateHead, NEXT);
});

test("repair_pipeline_item still fails candidate-moved when the remote head differs from the claim", async () => {
  let destructive = false;
  let repaired = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "fetch" || args[0] === "reset") destructive = true;
      if (args[0] === "log") return { code: 0, stdout: "feat: unrelated concurrent change\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${"f".repeat(40)}\trefs/heads/pipeline/42-repair\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD^") {
        return { code: 0, stdout: `${"e".repeat(40)}\n`, stderr: "" };
      }
      return { code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
    },
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.equal(destructive, false);
  assert.equal(repaired, false);
  assert.match(result.error ?? "", /candidate moved/);
});

test("repair_pipeline_item fails closed instead of syncing over a dirty stale worktree", async () => {
  let destructive = false;
  let repaired = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "fetch" || args[0] === "reset") destructive = true;
      if (args[0] === "log") return { code: 0, stdout: "feat: unrelated concurrent change\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: " M core/scripts/pipeline.ts\n", stderr: "" };
      return { code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
    },
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.equal(destructive, false);
  assert.equal(repaired, false);
  assert.match(result.error ?? "", /uncommitted changes/);
});

test("repair_pipeline_item treats a case-differing worktree head as the claimed head", async () => {
  const reconciliationOps: string[] = [];
  let repaired = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (["log", "ls-remote", "fetch", "reset", "status"].includes(args[0])) {
        reconciliationOps.push(args[0]);
      }
      return { code: 0, stdout: `${HEAD.toUpperCase()}\n`, stderr: "" };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "Repair archive",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked"],
    }),
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
    clearBlocked: async () => {},
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.equal(repaired, true);
  assert.deepEqual(reconciliationOps, []);
});

test("repair_pipeline_item reconciles an interrupted unmarked commit by stamping the marker instead of wedging", async () => {
  const UNMARKED = NEXT;
  const AMENDED = "c".repeat(40);
  let amended = false;
  let pushed = false;
  let repaired = false;
  let cleared = false;
  let breadcrumbChecked = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        // Our-crash scenario: this attempt's pre-invocation breadcrumb exists
        // and records the claimed head, so adoption is provably ours.
        assert.deepEqual(args, ["rev-parse", "--verify", "--quiet", "refs/pipeline-recovery/attempt-1"]);
        breadcrumbChecked = true;
        return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "commit" && args[1] === "--amend") {
        assert.match(args[3] ?? "", /^fix: pipeline recovery attempt-1 for #42/);
        assert.match(args[3] ?? "", /Pipeline-Run: loop-1/);
        amended = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "push") {
        pushed = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout: `${pushed ? AMENDED : HEAD}\trefs/heads/pipeline/42-repair\n`,
          stderr: "",
        };
      }
      if (args[0] === "log") {
        return { code: 0, stdout: "wip: partial repair from crashed attempt\n", stderr: "" };
      }
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD^") {
        return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${amended ? AMENDED : UNMARKED}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
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
  assert.equal(breadcrumbChecked, true);
  assert.equal(amended, true);
  assert.equal(pushed, true);
  assert.equal(repaired, false);
  assert.equal(cleared, true);
  assert.equal(result.candidateHead, AMENDED);
  assert.match(result.evidence, /without replaying the implementer/);
});

test("repair_pipeline_item refuses to adopt an unmarked commit without this attempt's breadcrumb", async () => {
  // A human's local commit in the managed worktree has exactly the adoptable
  // shape (clean tree, unpushed, parent == claimed head, remote still at the
  // claim). Without the attempt's durable pre-invocation breadcrumb it must
  // NOT be amended (message destroyed) or pushed (published).
  const HUMAN = NEXT;
  let amended = false;
  let pushed = false;
  let repaired = false;
  let cleared = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        // No breadcrumb: this attempt never reached its harness invocation.
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "commit" && args[1] === "--amend") {
        amended = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "push") {
        pushed = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${HEAD}\trefs/heads/pipeline/42-repair\n`, stderr: "" };
      }
      if (args[0] === "log") {
        return { code: 0, stdout: "feat: human work committed locally\n", stderr: "" };
      }
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD^") {
        return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${HUMAN}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
    clearBlocked: async () => {
      cleared = true;
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.equal(amended, false);
  assert.equal(pushed, false);
  assert.equal(repaired, false);
  assert.equal(cleared, false);
  assert.match(result.error ?? "", /candidate moved/);
  assert.match(result.error ?? "", /cannot prove it authored/);
});

test("repair_pipeline_item refuses to hard-sync away local-only commits in a diverged stale worktree", async () => {
  // Two or more clean unpushed local commits: HEAD is NOT an ancestor of the
  // claimed head, so `reset --hard` would silently destroy them.
  const DIVERGED = "d".repeat(40);
  let reset = false;
  let repaired = false;
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "log") return { code: 0, stdout: "feat: local work not on the claim\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${HEAD}\trefs/heads/pipeline/42-repair\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "merge-base") {
        assert.deepEqual(args, ["merge-base", "--is-ancestor", "HEAD", HEAD]);
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "reset") {
        reset = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD^") {
        return { code: 0, stdout: `${"e".repeat(40)}\n`, stderr: "" };
      }
      return { code: 0, stdout: `${DIVERGED}\n`, stderr: "" };
    },
    performRepair: async () => {
      repaired = true;
      return { status: "fix-committed", headSha: NEXT };
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.equal(reset, false);
  assert.equal(repaired, false);
  assert.match(result.error ?? "", /local commits present; refusing to discard/);
});

test("repair_pipeline_item succeeds with a warning when label clear keeps failing on the already-on-remote path", async () => {
  let clearAttempts = 0;
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
      assert.fail("already-on-remote reconciliation must not replay the implementer");
    },
    clearBlocked: async () => {
      clearAttempts++;
      throw new Error("label API 502");
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.equal(clearAttempts, 2);
  assert.equal(result.candidateHead, NEXT);
  assert.match(result.evidence, /without replaying the implementer/);
  assert.match(result.evidence, /could not be cleared after a retry/);
  assert.match(result.evidence, /label API 502/);
});

test("repair_pipeline_item succeeds with a warning when label clear keeps failing on the push-then-verify path", async () => {
  let clearAttempts = 0;
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
    performRepair: async () => {
      assert.fail("push-then-verify reconciliation must not replay the implementer");
    },
    clearBlocked: async () => {
      clearAttempts++;
      throw new Error("label API 502");
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, true);
  assert.equal(pushed, true);
  assert.equal(clearAttempts, 2);
  assert.equal(result.candidateHead, NEXT);
  assert.match(result.evidence, /could not be cleared after a retry/);
  assert.match(result.evidence, /label API 502/);
});

test("repair_pipeline_item returns success with a recorded warning when label clear fails after a verified push", async () => {
  let clearAttempts = 0;
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
      labels: ["blocked", "pipeline:pre-merge"],
    }),
    performRepair: async () => ({ status: "fix-committed", headSha: NEXT }),
    clearBlocked: async () => {
      clearAttempts++;
      throw new Error("label API 502");
    },
  });

  const result = await execute(input());
  // succeeded:true is the supervisor's contract for not charging the attempt,
  // so a budget-1 run_fatal class does not end the run on a label hiccup.
  assert.equal(result.succeeded, true);
  assert.equal(clearAttempts, 2);
  assert.equal(result.candidateHead, NEXT);
  assert.match(result.evidence, /could not be cleared after a retry/);
  assert.match(result.evidence, /label API 502/);
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

test("repair_pipeline_item #629: substantive path uses performPreMergeAutoFix (shared-round consumer), not a private full skeleton", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const src = await readFile(
    fileURLToPath(new URL("../scripts/loop/repair-pipeline-item.ts", import.meta.url)),
    "utf8",
  );
  // Shell exemption: recovery may own breadcrumb/ownership, but substantive work
  // must go through performPreMergeAutoFix (shared-helper-backed).
  assert.match(src, /performPreMergeAutoFix/);
  assert.match(src, /performRepair \?\? performPreMergeAutoFix/);
  // Documented consumer-via-auto-fix disposition (not a private full skeleton).
  assert.match(src, /#629/);
  assert.match(src, /breadcrumb/);
  // No private headBefore → invoke → salvage skeleton in this shell file.
  assert.doesNotMatch(src, /const headBefore\s*=/);
  assert.doesNotMatch(src, /trySalvageUncommittedWork\s*\(/);
});

test("repair_pipeline_item #629: refuses unmarked human commits (ownership proof)", async () => {
  // Unpushed commit on claimed head without breadcrumb → refuse.
  const execute = createRepairPipelineItemExecutor(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/42", slug: "repair" }),
    gitInWorktree: async (_dir, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { code: 0, stdout: `${NEXT}\n`, stderr: "" };
      }
      if (args[0] === "log") {
        return { code: 0, stdout: "feat: human WIP\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD^") {
        return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("refs/pipeline-recovery/attempt-1")) {
        // No breadcrumb → refuse.
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    performRepair: async () => {
      throw new Error("must not invoke substantive repair for unmarked human commit");
    },
  });

  const result = await execute(input());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? result.evidence, /cannot prove it authored|refusing to adopt/i);
});
