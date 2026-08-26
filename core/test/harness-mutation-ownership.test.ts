/**
 * Durable harness mutation ownership (#1246). Fake storage / porcelain / git
 * only — no real network, git, or subprocess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginOwnershipAttempt,
  checkpointOwnedHarnessDirt,
  classifyHarnessMutationDirt,
  emitOwnershipEvidence,
  finishOwnershipAttempt,
  harnessResultClass,
  interruptedIncompleteImplement,
  loadOwnershipRecord,
  ownedLeftoverPathsFromRecord,
  OWNERSHIP_HEARTBEAT_MS,
  porcelainProductDelta,
  recoverInterruptedImplement,
  refreshLastKnownPorcelain,
  runWithMutationOwnership,
  startOwnershipHeartbeat,
  OwnershipSnapshotFailedError,
  type HarnessMutationOwnershipRecord,
  type OwnershipDeps,
  type PorcelainSnapshotEntry,
} from "../scripts/harness-mutation-ownership.ts";
import {
  classifyOwnedWorktreeDirt,
  parsePorcelainEntries,
} from "../scripts/worktree-dirt.ts";
import { runHarnessRound, type HarnessRoundDeps } from "../scripts/harness-round.ts";
import { runFormatGate } from "../scripts/stages/format-gate.ts";
import { runTestGate, type TestGateDeps } from "../scripts/testgate.ts";
import {
  dispatchResume,
  type DispatchResumeDeps,
} from "../scripts/stages/planning.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";
import {
  DEFAULT_RECOVERY_POLICY,
} from "../scripts/loop/recovery.ts";
import {
  buildStageDiagnostic,
  projectStageDiagnostic,
} from "../scripts/stage-diagnostic.ts";

function memoryStore(): {
  files: Map<string, string>;
  deps: Pick<OwnershipDeps, "readFile" | "writeFileAtomic" | "mkdirp">;
} {
  const files = new Map<string, string>();
  return {
    files,
    deps: {
      readFile: async (p) => files.get(p) ?? null,
      writeFileAtomic: async (p, c) => {
        files.set(p, c);
      },
      mkdirp: async () => {},
    },
  };
}

function recordFixture(
  overrides: Partial<HarnessMutationOwnershipRecord> = {},
): HarnessMutationOwnershipRecord {
  return {
    schema_version: 1,
    issue: 758,
    domain: "lyric-utils",
    stage: "implementing",
    attempt_id: "758-implementing-abc-1",
    worktree_path: "/wt",
    pre_head: "head-before",
    pre_porcelain: [],
    in_flight: true,
    updated_at: "2026-08-26T00:00:00Z",
    ...overrides,
  };
}

function makeCfg(): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    domain: "owner-repo",
    base_branch: "main",
    harnesses: { implementer: "claude", reviewer: "codex" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    test_gate: { enabled: false },
    format_gate: [{ command: "cargo fmt", auto_fix: true }],
    implementation_ready_message: "Implementation ready.",
    marker_footer: "*Automated by Pipeline*",
    worktree_root: ".worktrees",
  } as unknown as PipelineConfig;
}

// ---------------------------------------------------------------------------
// 1.1 Durable round-trip after discarding in-memory state
// ---------------------------------------------------------------------------

test("ownership record round-trips after discarding in-memory state", async () => {
  const store = memoryStore();
  const deps: OwnershipDeps = {
    ...store.deps,
    gitHead: async () => "abc123deadbeef",
    gitStatusPorcelain: async () => "",
    now: () => new Date("2026-08-26T21:21:24Z"),
  };
  const started = await beginOwnershipAttempt(
    {
      repoDir: "/repo",
      domain: "lyric-utils",
      issue: 758,
      stage: "implementing",
      wtPath: "/wt",
    },
    deps,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.record.pre_head, "abc123deadbeef");
  assert.equal(started.record.in_flight, true);
  assert.deepEqual(started.record.pre_porcelain, []);

  // New process: same durable map, no JS object identity.
  const hydrated = await loadOwnershipRecord(
    { repoDir: "/repo", domain: "lyric-utils", issue: 758 },
    { readFile: store.deps.readFile },
  );
  assert.ok(hydrated);
  assert.equal(hydrated!.attempt_id, started.record.attempt_id);
  assert.equal(hydrated!.pre_head, "abc123deadbeef");
  assert.notEqual(hydrated, started.record);
});

// ---------------------------------------------------------------------------
// 1.2 Ternary classifier
// ---------------------------------------------------------------------------

test("classifier: clean pre + timeout edits = owned leftovers", () => {
  const rec = recordFixture({
    last_known_porcelain: [{ path: "core/scripts/foo.ts", xy: " M" }],
  });
  const c = classifyHarnessMutationDirt({
    porcelain: " M core/scripts/foo.ts\n",
    record: rec,
  });
  assert.deepEqual(c.ownedLeftover, ["core/scripts/foo.ts"]);
  assert.deepEqual(c.unknownProduct, []);
  assert.deepEqual(c.scratch, []);
});

test("classifier: extra paths after post-snapshot are unknown", () => {
  const rec = recordFixture({
    post_porcelain: [{ path: "core/scripts/foo.ts", xy: " M" }],
  });
  const c = classifyHarnessMutationDirt({
    porcelain: " M core/scripts/foo.ts\n M core/scripts/bar.ts\n",
    record: rec,
  });
  assert.deepEqual(c.ownedLeftover, ["core/scripts/foo.ts"]);
  assert.deepEqual(c.unknownProduct, ["core/scripts/bar.ts"]);
});

test("classifier: missing record ⇒ empty owned set, product is unknown", () => {
  const c = classifyHarnessMutationDirt({
    porcelain: " M core/scripts/foo.ts\n",
    record: null,
  });
  assert.deepEqual(c.ownedLeftover, []);
  assert.deepEqual(c.unknownProduct, ["core/scripts/foo.ts"]);
});

test("classifier: scratch-only is not owned leftover", () => {
  const rec = recordFixture({
    last_known_porcelain: [{ path: "tasks/todo.md", xy: " M" }],
  });
  const c = classifyHarnessMutationDirt({
    porcelain: " M tasks/todo.md\n",
    record: rec,
  });
  assert.deepEqual(c.scratch, ["tasks/todo.md"]);
  assert.deepEqual(c.ownedLeftover, []);
  assert.deepEqual(c.unknownProduct, []);
});

test("classifyOwnedWorktreeDirt: scratch wins over an owned-set membership", () => {
  const c = classifyOwnedWorktreeDirt(
    ["tasks/todo.md", "core/scripts/foo.ts"],
    ["tasks/todo.md", "core/scripts/foo.ts"],
  );
  assert.deepEqual(c.scratch, ["tasks/todo.md"]);
  assert.deepEqual(c.ownedLeftover, ["core/scripts/foo.ts"]);
  assert.deepEqual(c.unknownProduct, []);
});

test("parsePorcelainEntries keeps XY and both rename endpoints", () => {
  const entries = parsePorcelainEntries("R  core/scripts/foo.ts -> tasks/foo.ts\n");
  assert.deepEqual(
    entries.map((e) => e.path),
    ["core/scripts/foo.ts", "tasks/foo.ts"],
  );
  assert.equal(entries[0]?.xy, "R ");
});

// ---------------------------------------------------------------------------
// 1.3 Fail closed: no spawn when pre-snapshot cannot be made durable
// ---------------------------------------------------------------------------

test("beginOwnershipAttempt: write failure does not claim ownership", async () => {
  const started = await beginOwnershipAttempt(
    {
      repoDir: "/repo",
      domain: "d",
      issue: 1,
      stage: "implementing",
      wtPath: "/wt",
    },
    {
      gitHead: async () => "h",
      gitStatusPorcelain: async () => "",
      writeFileAtomic: async () => {
        throw new Error("disk full");
      },
      mkdirp: async () => {},
    },
  );
  assert.equal(started.ok, false);
  if (started.ok) return;
  assert.match(started.reason, /disk full/);
});

test("runWithMutationOwnership: write failure does not spawn", async () => {
  let spawned = false;
  await assert.rejects(
    () =>
      runWithMutationOwnership(
        {
          repoDir: "/repo",
          domain: "d",
          issue: 1,
          stage: "implementing",
          wtPath: "/wt",
          pipelineRunId: "run-1",
          invoke: async () => {
            spawned = true;
            return { success: true, timed_out: false };
          },
        },
        {
          gitHead: async () => "h",
          gitStatusPorcelain: async () => "",
          writeFileAtomic: async () => {
            throw new Error("enospc");
          },
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof OwnershipSnapshotFailedError);
      assert.match((err as Error).message, /enospc|pre-snapshot/);
      return true;
    },
  );
  assert.equal(spawned, false);
});

test("runHarnessRound: spawn does not run before the ownership record exists", async () => {
  const store = memoryStore();
  const order: string[] = [];
  const deps: HarnessRoundDeps = {
    gitHead: async () => "sha-before",
    salvage: async () => ({ salvaged: false }),
  };
  await runHarnessRound({
    wtPath: "/wt",
    issueNumber: 1,
    pipelineRunId: "run-1",
    salvageLabel: "implement",
    shouldAttemptSalvage: () => false,
    mutationOwnership: {
      repoDir: "/repo",
      domain: "d",
      stage: "implementing",
      deps: {
        ...store.deps,
        gitHead: async () => "sha-before",
        gitStatusPorcelain: async () => {
          order.push("status");
          return "";
        },
        now: () => new Date("2026-08-26T00:00:00Z"),
      },
    },
    invoke: async () => {
      order.push("invoke");
      const rec = await loadOwnershipRecord(
        { repoDir: "/repo", domain: "d", issue: 1 },
        store.deps,
      );
      assert.ok(rec, "record must exist before invoke");
      assert.equal(rec!.in_flight, true);
      return { success: true, timed_out: false };
    },
    afterRound: async (ctx) => ctx,
    deps,
  });
  assert.equal(order[0], "status");
  assert.ok(order.includes("invoke"));
  assert.ok(order.indexOf("status") < order.indexOf("invoke"));
});

test("runHarnessRound: write failure skips invoke", async () => {
  let invoked = false;
  await assert.rejects(
    () =>
      runHarnessRound({
        wtPath: "/wt",
        issueNumber: 1,
        pipelineRunId: "run-1",
        salvageLabel: "implement",
        shouldAttemptSalvage: () => false,
        mutationOwnership: {
          repoDir: "/repo",
          domain: "d",
          stage: "implementing",
          deps: {
            gitHead: async () => "h",
            gitStatusPorcelain: async () => "",
            writeFileAtomic: async () => {
              throw new Error("eio");
            },
          },
        },
        invoke: async () => {
          invoked = true;
          return { success: true };
        },
        afterRound: async (ctx) => ctx,
        deps: {
          gitHead: async () => "h",
          salvage: async () => ({ salvaged: false }),
        },
      }),
    OwnershipSnapshotFailedError,
  );
  assert.equal(invoked, false);
});

// ---------------------------------------------------------------------------
// 2.2 Heartbeat last-known + timeout post-snapshot
// ---------------------------------------------------------------------------

test("heartbeat writes last-known porcelain using fake clock", async () => {
  const store = memoryStore();
  let porcelain = "";
  const deps: OwnershipDeps = {
    ...store.deps,
    gitHead: async () => "h",
    gitStatusPorcelain: async () => porcelain,
    now: () => new Date("2026-08-26T00:00:00Z"),
  };
  const started = await beginOwnershipAttempt(
    { repoDir: "/repo", domain: "d", issue: 2, stage: "implementing", wtPath: "/wt" },
    deps,
  );
  assert.equal(started.ok, true);

  porcelain = " M core/scripts/foo.ts\n";
  let intervalFn: (() => void) | undefined;
  const beat = startOwnershipHeartbeat(
    { repoDir: "/repo", domain: "d", issue: 2, wtPath: "/wt" },
    {
      ...deps,
      heartbeatMs: OWNERSHIP_HEARTBEAT_MS,
      setIntervalFn: (fn) => {
        intervalFn = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    },
  );
  assert.ok(intervalFn, "heartbeat must install an interval");
  await refreshLastKnownPorcelain(
    { repoDir: "/repo", domain: "d", issue: 2, wtPath: "/wt" },
    deps,
  );
  beat.stop();
  const rec = await loadOwnershipRecord(
    { repoDir: "/repo", domain: "d", issue: 2 },
    store.deps,
  );
  assert.ok(rec?.last_known_porcelain?.some((e) => e.path === "core/scripts/foo.ts"));
});

test("timeout after product edits checkpoints owned leftovers (no intermediate commit)", async () => {
  const store = memoryStore();
  let porcelain = "";
  const committed: string[][] = [];
  const deps: OwnershipDeps = {
    ...store.deps,
    gitHead: async () => "h",
    gitStatusPorcelain: async () => porcelain,
    now: () => new Date("2026-08-26T00:00:00Z"),
    salvage: async (_wt, _issue, _run, _label, salvageDeps) => {
      committed.push([...(salvageDeps?.onlyPaths ?? [])]);
      porcelain = "";
      return { salvaged: true, message: "salvage" };
    },
  };
  await beginOwnershipAttempt(
    { repoDir: "/repo", domain: "d", issue: 3, stage: "implementing", wtPath: "/wt" },
    deps,
  );
  porcelain = " M core/scripts/foo.ts\n";
  const finish = await finishOwnershipAttempt(
    {
      repoDir: "/repo",
      domain: "d",
      issue: 3,
      wtPath: "/wt",
      pipelineRunId: "run-1",
      resultClass: "timeout",
    },
    deps,
  );
  assert.equal(finish.checkpointed, true);
  assert.deepEqual(committed[0], ["core/scripts/foo.ts"]);
  assert.equal(finish.evidence?.disposition, "recovered");
  const rec = await loadOwnershipRecord(
    { repoDir: "/repo", domain: "d", issue: 3 },
    store.deps,
  );
  assert.equal(rec?.in_flight, false);
});

test("timeout after intermediate commit plus later edits checkpoints later files", async () => {
  const store = memoryStore();
  let porcelain = " M src/lib.rs\n M src/main.rs\n";
  const committed: string[][] = [];
  const deps: OwnershipDeps = {
    ...store.deps,
    gitHead: async () => "head-after-intermediate",
    gitStatusPorcelain: async () => porcelain,
    now: () => new Date("2026-08-26T00:00:00Z"),
    salvage: async (_wt, _issue, _run, _label, salvageDeps) => {
      committed.push([...(salvageDeps?.onlyPaths ?? [])]);
      porcelain = "";
      return { salvaged: true, message: "salvage" };
    },
  };
  const started = await beginOwnershipAttempt(
    { repoDir: "/repo", domain: "d", issue: 4, stage: "implementing", wtPath: "/wt" },
    { ...deps, gitStatusPorcelain: async () => "", gitHead: async () => "head-before" },
  );
  assert.equal(started.ok, true);
  const finish = await finishOwnershipAttempt(
    {
      repoDir: "/repo",
      domain: "d",
      issue: 4,
      wtPath: "/wt",
      pipelineRunId: "run-1",
      resultClass: "timeout",
    },
    deps,
  );
  assert.equal(finish.checkpointed, true);
  assert.ok(committed[0]?.includes("src/lib.rs"));
  assert.ok(committed[0]?.includes("src/main.rs"));
});

// ---------------------------------------------------------------------------
// 2.3 Clear in-flight; later dirty without in-flight is unknown
// ---------------------------------------------------------------------------

test("later dirty tree without current in-flight record classifies as unknown", () => {
  const rec = recordFixture({
    in_flight: false,
    result_class: "success",
    post_porcelain: [],
  });
  const owned = ownedLeftoverPathsFromRecord(rec, ["core/scripts/foo.ts"]);
  assert.deepEqual(owned, []);
  const c = classifyHarnessMutationDirt({
    porcelain: " M core/scripts/foo.ts\n",
    record: rec,
  });
  assert.deepEqual(c.unknownProduct, ["core/scripts/foo.ts"]);
  assert.deepEqual(c.ownedLeftover, []);
});

test("hard-kill with only pre-snapshot treats current product porcelain as owned", () => {
  const rec = recordFixture({ in_flight: true });
  const c = classifyHarnessMutationDirt({
    porcelain: " M core/scripts/foo.ts\n",
    record: rec,
  });
  assert.deepEqual(c.ownedLeftover, ["core/scripts/foo.ts"]);
});

// ---------------------------------------------------------------------------
// 3.1 Mixed owned+unknown checkpoints only owned paths
// ---------------------------------------------------------------------------

test("checkpoint mixed dirt commits only owned paths and leaves unknown unstaged", async () => {
  const added: string[][] = [];
  const restored: string[][] = [];
  let committed = false;
  const result = await checkpointOwnedHarnessDirt(
    {
      wtPath: "/wt",
      issueNumber: 5,
      pipelineRunId: "run-1",
      ownedPaths: ["core/owned.ts"],
    },
    {
      salvage: async (_wt, _i, _r, _l, salvageDeps) => {
        // Delegate to real salvage with fake git so onlyPaths is exercised.
        const { salvageUncommittedWork } = await import("../scripts/salvage-harness-work.ts");
        return salvageUncommittedWork("/wt", 5, "run-1", "implement", {
          gitStatus: async () => " M core/owned.ts\n M core/unknown.ts\n",
          gitRestoreStaged: async (_p, args) => {
            restored.push(args);
          },
          gitAddAll: async (_p, args) => {
            added.push(args);
          },
          gitCommit: async () => {
            committed = true;
          },
          onlyPaths: salvageDeps?.onlyPaths,
        });
      },
    },
  );
  assert.equal(result.checkpointed, true);
  assert.equal(committed, true);
  const addArgs = added.find((a) => a.includes("core/owned.ts"));
  assert.ok(addArgs, "owned path must be staged");
  assert.ok(!addArgs!.includes("core/unknown.ts"), "unknown path must not be staged");
});

test("checkpoint is a no-op when leftovers were already salvaged", async () => {
  let salvageCalls = 0;
  const result = await checkpointOwnedHarnessDirt(
    {
      wtPath: "/wt",
      issueNumber: 6,
      pipelineRunId: "run-1",
      ownedPaths: ["core/owned.ts"],
    },
    {
      salvage: async () => {
        salvageCalls++;
        return { salvaged: false };
      },
    },
  );
  assert.equal(result.checkpointed, false);
  assert.equal(salvageCalls, 1);
});

test("checkpoint empty owned set does not salvage", async () => {
  let salvageCalls = 0;
  const result = await checkpointOwnedHarnessDirt(
    { wtPath: "/wt", issueNumber: 6, pipelineRunId: "run-1", ownedPaths: [] },
    { salvage: async () => { salvageCalls++; return { salvaged: true, message: "x" }; } },
  );
  assert.equal(result.checkpointed, false);
  assert.equal(salvageCalls, 0);
});

// ---------------------------------------------------------------------------
// 3.3 Policy order
// ---------------------------------------------------------------------------

test("default workflow-engine-defect policy orders unlink, checkpoint, then repair", () => {
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  const unlink = recipes.indexOf("unlink_engine_scratch");
  const checkpoint = recipes.indexOf("checkpoint_owned_harness_dirt");
  const repair = recipes.indexOf("repair_pipeline_item");
  assert.ok(unlink >= 0, "unlink_engine_scratch must be present");
  assert.ok(checkpoint >= 0, "checkpoint_owned_harness_dirt must be present");
  assert.ok(repair >= 0, "repair_pipeline_item must be present");
  assert.ok(unlink < checkpoint, "unlink before checkpoint");
  assert.ok(checkpoint < repair, "checkpoint before implementer repair");
});

test("policy-order bite: implementer repair must not be first for leftover evidence", () => {
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  assert.notEqual(recipes[0], "repair_pipeline_item");
});

// ---------------------------------------------------------------------------
// 4.1 Format-gate consults ownership
// ---------------------------------------------------------------------------

test("format gate: unknown product dirt still blocks before auto-fix", async () => {
  const result = await runFormatGate(
    "/wt",
    { format_gate: [{ command: "cargo fmt", auto_fix: true }] },
    42,
    {
      execInWorktree: async () => {
        throw new Error("should not be called");
      },
      gitStatusPorcelain: async () => " M core/scripts/foo.ts\n",
    },
  );
  assert.equal(result.status, "blocked");
  assert.ok(
    result.status === "blocked" && result.reason.includes("pre-existing uncommitted changes"),
  );
});

test("format gate: owned leftovers do not trip unknown-dirt pre-flight and are not auto-format committed", async () => {
  let execCalls = 0;
  let autoFormatCommits = 0;
  const result = await runFormatGate(
    "/wt",
    { format_gate: [{ command: "cargo fmt", auto_fix: true }] },
    758,
    {
      execInWorktree: async () => {
        execCalls++;
        return { code: 0, combined: "" };
      },
      gitStatusPorcelain: async () => " M core/scripts/foo.ts\n",
      gitCommit: async () => {
        autoFormatCommits++;
        return { ok: true };
      },
      ownedLeftoverPaths: ["core/scripts/foo.ts"],
      checkpointOwnedLeftovers: async () => ({ checkpointed: true }),
    },
  );
  assert.equal(result.status, "ok", `unexpected: ${JSON.stringify(result)}`);
  assert.equal(autoFormatCommits, 0, "owned leftovers must not become chore: auto-format");
  assert.ok(execCalls >= 0);
});

test("format gate leftover consult bite: without ownedLeftoverPaths the leftover blocks", async () => {
  const result = await runFormatGate(
    "/wt",
    { format_gate: [{ command: "cargo fmt", auto_fix: true }] },
    758,
    {
      execInWorktree: async () => {
        throw new Error("should not run");
      },
      gitStatusPorcelain: async () => " M core/scripts/foo.ts\n",
    },
  );
  assert.equal(result.status, "blocked");
});

// ---------------------------------------------------------------------------
// 4.2 Test-gate dirty trust
// ---------------------------------------------------------------------------

function testGateCfg(): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    harnesses: { implementer: "claude", reviewer: "codex" },
    test_gate: { enabled: true, command: "echo ok", max_attempts: 0 },
  } as unknown as PipelineConfig;
}

test("test gate: leftover-only does not mint a dirty-trust hard block", async () => {
  let ran = false;
  const out = await runTestGate(
    testGateCfg(),
    7,
    "/wt",
    {
      gitDirty: async () => true,
      gitStatusPorcelain: async () => " M core/scripts/foo.ts\n",
      gitHead: async () => "h",
      runTests: async () => {
        ran = true;
        return { passed: true, output: "ok" };
      },
      ownedLeftoverPaths: ["core/scripts/foo.ts"],
      checkpointOwnedLeftovers: async () => ({ checkpointed: true }),
    } as TestGateDeps,
  );
  assert.notEqual(out.dirtyWorktree, true);
  assert.equal(ran, true);
});

test("test gate: unknown product still attempts-0 hard-blocks with path disclosure", async () => {
  const out = await runTestGate(
    testGateCfg(),
    7,
    "/wt",
    {
      gitDirty: async () => true,
      gitStatusPorcelain: async () => " M core/scripts/unknown.ts\n",
      gitHead: async () => "h",
      runTests: async () => {
        throw new Error("must not run");
      },
    } as TestGateDeps,
  );
  assert.equal(out.dirtyWorktree, true);
  assert.equal(out.attempts, 0);
  assert.match(out.blockReason ?? "", /core\/scripts\/unknown\.ts/);
});

test("test gate: mixed leftover + unknown hard-blocks on unknown after checkpoint", async () => {
  const out = await runTestGate(
    testGateCfg(),
    7,
    "/wt",
    {
      gitDirty: async () => true,
      gitStatusPorcelain: async () => " M core/owned.ts\n M core/unknown.ts\n",
      gitHead: async () => "h",
      runTests: async () => {
        throw new Error("must not run");
      },
      ownedLeftoverPaths: ["core/owned.ts"],
      checkpointOwnedLeftovers: async () => ({ checkpointed: true }),
    } as TestGateDeps,
  );
  assert.equal(out.dirtyWorktree, true);
  assert.match(out.blockReason ?? "", /core\/unknown\.ts/);
});

// ---------------------------------------------------------------------------
// 4.3 #758-class dispatchResume
// ---------------------------------------------------------------------------

test("#758-class: intermediate commit + leftover product files reinvoke implementer, no format-gate block", async () => {
  const cfg = makeCfg();
  let checkpointed = false;
  let implementerCalls = 0;
  let formatBlocked = false;
  let resumePost = false;
  const deps: DispatchResumeDeps = {
    isLivePlanningActive: () => false,
    getForIssue: async () => ({ path: "/wt", branch: "pipeline/758-x", slug: "x" }),
    hasCommitsAhead: async () => true,
    getIssueDetail: async () => ({ title: "p0", body: "" }) as never,
    resumeFromImplementing: async () => {
      resumePost = true;
      formatBlocked = true;
      return {
        advanced: false,
        status: "blocked",
        reason: "Format gate blocked: pre-existing uncommitted changes",
        blockerKind: "needs-human",
      };
    },
    planningAdvance: async () => {
      implementerCalls++;
      return { advanced: true, from: "implementing" as Stage, to: "review-1" as Stage, summary: "reinvoked" };
    },
    recoverInterruptedImplement: async () => {
      checkpointed = true;
      return {
        action: "reinvoke" as const,
        classified: { scratch: [], ownedLeftover: [], unknownProduct: [] },
        checkpointed: true,
        evidence: {
          disposition: "resumed" as const,
          issue: 758,
          attempt_id: "a1",
          owned_path_count: 12,
          at: "2026-08-26T00:00:00Z",
        },
        record: recordFixture({ in_flight: false }),
      };
    },
  };
  const out = await dispatchResume(cfg, 758, { pipelineRunId: "run-2" }, deps);
  assert.equal(checkpointed, true);
  assert.equal(implementerCalls, 1);
  assert.equal(resumePost, false);
  assert.equal(formatBlocked, false);
  assert.equal(out.advanced, true);
});

test("dispatchResume: commits-ahead without interrupted leftovers still resumes post-implement", async () => {
  let resumeCalled = false;
  let implementerCalls = 0;
  const out = await dispatchResume(
    makeCfg(),
    175,
    { pipelineRunId: "run-1" },
    {
      isLivePlanningActive: () => false,
      getForIssue: async () => ({ path: "/wt", branch: "pipeline/175", slug: "x" }),
      hasCommitsAhead: async () => true,
      getIssueDetail: async () => ({ title: "ok", body: "" }) as never,
      resumeFromImplementing: async () => {
        resumeCalled = true;
        return { advanced: true, from: "implementing" as Stage, to: "design-gate" as Stage, summary: "PR" };
      },
      planningAdvance: async () => {
        implementerCalls++;
        return { advanced: true, from: "ready" as Stage, to: "review-1" as Stage, summary: "x" };
      },
      recoverInterruptedImplement: async () => ({
        action: "none" as const,
        classified: { scratch: [], ownedLeftover: [], unknownProduct: [] },
        checkpointed: false,
        record: null,
      }),
    },
  );
  assert.equal(resumeCalled, true);
  assert.equal(implementerCalls, 0);
  assert.equal(out.advanced, true);
});

test("4.4 checkpointed leftovers with satisfied deliverable continue post-implement", async () => {
  let resumeCalled = false;
  let implementerCalls = 0;
  const out = await dispatchResume(
    makeCfg(),
    758,
    { pipelineRunId: "run-1" },
    {
      isLivePlanningActive: () => false,
      getForIssue: async () => ({ path: "/wt", branch: "pipeline/758", slug: "x" }),
      hasCommitsAhead: async () => true,
      getIssueDetail: async () => ({ title: "ok", body: "" }) as never,
      resumeFromImplementing: async () => {
        resumeCalled = true;
        return { advanced: true, from: "implementing" as Stage, to: "design-gate" as Stage, summary: "gates on checkpointed HEAD" };
      },
      planningAdvance: async () => {
        implementerCalls++;
        return { advanced: true, from: "implementing" as Stage, to: "review-1" as Stage, summary: "x" };
      },
      recoverInterruptedImplement: async () => ({
        action: "post-implement" as const,
        classified: { scratch: [], ownedLeftover: [], unknownProduct: [] },
        checkpointed: true,
        evidence: {
          disposition: "recovered" as const,
          issue: 758,
          attempt_id: "a1",
          owned_path_count: 0,
          at: "2026-08-26T00:00:00Z",
        },
        record: recordFixture({ in_flight: false }),
      }),
    },
  );
  assert.equal(resumeCalled, true);
  assert.equal(implementerCalls, 0);
  assert.equal(out.advanced, true);
});

// ---------------------------------------------------------------------------
// 5.1 Terminal evidence tokens
// ---------------------------------------------------------------------------

test("rejected unknown dirt evidence names rejected and discloses paths", async () => {
  const store = memoryStore();
  const rec = recordFixture();
  await saveVia(store, rec);
  const events: unknown[] = [];
  const evidence = await emitOwnershipEvidence(
    {
      repoDir: "/repo",
      domain: rec.domain,
      issue: rec.issue,
      record: rec,
      disposition: "rejected",
      ownedPathCount: 0,
      unknownPaths: ["core/unknown.ts"],
      runDir: "/run",
    },
    {
      ...store.deps,
      now: () => new Date("2026-08-26T00:00:00Z"),
      appendEvent: async (_dir, ev) => {
        events.push(ev);
        return true;
      },
    },
  );
  assert.equal(evidence.disposition, "rejected");
  assert.deepEqual(evidence.unknown_paths, ["core/unknown.ts"]);
  const loaded = await loadOwnershipRecord(
    { repoDir: "/repo", domain: rec.domain, issue: rec.issue },
    store.deps,
  );
  assert.equal(loaded?.last_evidence?.disposition, "rejected");
  assert.equal((events[0] as { type: string }).type, "harness_mutation_ownership");
});

test("successful leftover recovery evidence is checkpointed or recovered", async () => {
  const store = memoryStore();
  const rec = recordFixture();
  await saveVia(store, rec);
  const evidence = await emitOwnershipEvidence(
    {
      repoDir: "/repo",
      domain: rec.domain,
      issue: rec.issue,
      record: rec,
      disposition: "checkpointed",
      ownedPathCount: 2,
    },
    { ...store.deps, now: () => new Date("2026-08-26T00:00:00Z") },
  );
  assert.equal(evidence.disposition, "checkpointed");
  const loaded = await loadOwnershipRecord(
    { repoDir: "/repo", domain: rec.domain, issue: rec.issue },
    store.deps,
  );
  assert.equal(loaded?.last_evidence?.disposition, "checkpointed");
});

async function saveVia(
  store: ReturnType<typeof memoryStore>,
  rec: HarnessMutationOwnershipRecord,
): Promise<void> {
  const { saveOwnershipRecord } = await import("../scripts/harness-mutation-ownership.ts");
  await saveOwnershipRecord(
    { repoDir: "/repo", domain: rec.domain, issue: rec.issue },
    rec,
    store.deps,
  );
}

// ---------------------------------------------------------------------------
// 5.2 Residual leftover block is harness-failure, never human
// ---------------------------------------------------------------------------

test("residual owned-leftover harness-failure projects workflow-engine-defect recover", () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "Owned harness leftovers could not be checkpointed",
  });
  const projection = projectStageDiagnostic(diagnostic);
  assert.equal(projection.blockerClass, "workflow-engine-defect");
  assert.equal(projection.disposition, "recover");
});

test("leftover residual must not park as human-decision-required", () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "Owned harness leftovers could not be checkpointed",
  });
  const projection = projectStageDiagnostic(diagnostic);
  assert.notEqual(projection.disposition, "human_authority");
  assert.notEqual(diagnostic.blockerKind, "needs-human");
  assert.notEqual(diagnostic.blockerKind, "human-decision-required");
});

test("harnessResultClass maps timed_out and nested fix-round results", () => {
  assert.equal(harnessResultClass({ success: false, timed_out: true }), "timeout");
  assert.equal(harnessResultClass({ result: { success: false, timed_out: true } }), "timeout");
  assert.equal(harnessResultClass({ success: false, timed_out: false }), "crash");
  assert.equal(harnessResultClass({ success: true, timed_out: false }), "success");
});

test("porcelainProductDelta detects adds vs pre", () => {
  const pre: PorcelainSnapshotEntry[] = [];
  const post: PorcelainSnapshotEntry[] = [{ path: "core/a.ts", xy: " M" }];
  assert.deepEqual(porcelainProductDelta(pre, post), ["core/a.ts"]);
});

test("interruptedIncompleteImplement is true for in-flight leftovers", () => {
  assert.equal(
    interruptedIncompleteImplement(recordFixture(), {
      scratch: [],
      ownedLeftover: ["core/a.ts"],
      unknownProduct: [],
    }),
    true,
  );
  assert.equal(
    interruptedIncompleteImplement(recordFixture({ in_flight: false, result_class: "success" }), {
      scratch: [],
      ownedLeftover: [],
      unknownProduct: ["core/a.ts"],
    }),
    false,
  );
});

test("recoverInterruptedImplement reinvokes when deliverable is unsatisfied", async () => {
  const store = memoryStore();
  const rec = recordFixture({
    last_known_porcelain: [{ path: "core/a.ts", xy: " M" }],
  });
  await saveVia(store, rec);
  let porcelain = " M core/a.ts\n";
  const out = await recoverInterruptedImplement(
    {
      repoDir: "/repo",
      domain: rec.domain,
      issue: rec.issue,
      wtPath: "/wt",
      pipelineRunId: "run-1",
      deliverablePresent: false,
    },
    {
      ...store.deps,
      gitStatusPorcelain: async () => porcelain,
      now: () => new Date("2026-08-26T00:00:00Z"),
      salvage: async () => {
        porcelain = "";
        return { salvaged: true, message: "s" };
      },
    },
  );
  assert.equal(out.action, "reinvoke");
  assert.equal(out.checkpointed, true);
  assert.equal(out.evidence?.disposition, "resumed");
});
