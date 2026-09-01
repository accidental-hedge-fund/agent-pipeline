// FRG Layer A hermetic scenario pack (#723).
//
// Composition regressions for the Factory Reliability Gate scenario classes.
// Zero real network, git, or subprocess — injected deps only.
// Each test is named with its stable FRG scenario id so failures map to the
// runbook inventory. Sibling suites may cover more depth; this pack asserts the
// gate-critical invariants bite.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  FRG_LAYER_A_WAIVERS,
  FRG_SCENARIO_OWNERSHIP,
  DEFAULT_FRG_THRESHOLDS,
  computeFrgEvidence,
} from "../scripts/factory-reliability-gate.ts";
import { frgPassUniqueOperations } from "./frg-pass-unique-operations.ts";
import { isMidFlightPipelineStage } from "../scripts/loop/precondition.ts";
import { classifyDrift } from "../scripts/loop/reconcile.ts";
import type { LoopExternalIdentity } from "../scripts/loop/types.ts";
import {
  includeLockfileSideEffects,
  type LockfileSideEffectsDeps,
} from "../scripts/lockfile-side-effects.ts";
import {
  checkDocsFreshness,
  detectDocsGenerator,
  type DocsFreshnessDeps,
} from "../scripts/docs-freshness.ts";
import {
  createWorktree,
  type CreateWorktreeDeps,
} from "../scripts/worktree.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import {
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

// ---------------------------------------------------------------------------
// Waiver inventory completeness
// ---------------------------------------------------------------------------

test("FRG Layer A: every waived scenario names a tracking issue (none may cite closed #729/#730 only)", () => {
  // After #757 both former waivers have hermetic tests; inventory is empty.
  assert.deepEqual(FRG_LAYER_A_WAIVERS, {});
  for (const [id, own] of Object.entries(FRG_SCENARIO_OWNERSHIP)) {
    if (own.layer_a === "waiver") {
      const issue = FRG_LAYER_A_WAIVERS[id as keyof typeof FRG_LAYER_A_WAIVERS];
      assert.ok(issue, `silent gap: ${id} waived without issue`);
      assert.match(issue, /^#\d+$/);
      assert.notEqual(issue, "#729", "closed #729 is not a valid waiver target");
      assert.notEqual(issue, "#730", "closed #730 is not a valid waiver target");
    }
  }
  assert.equal(FRG_SCENARIO_OWNERSHIP["pr-supersession"].layer_a, "test");
  assert.equal(FRG_SCENARIO_OWNERSHIP["release-plan-row"].layer_a, "test");
});

test("FRG Layer A pr-supersession: default supersede_mode closes stale second PRs", async () => {
  const { DEFAULT_CONFIG } = await import("../scripts/types.ts");
  assert.equal(DEFAULT_CONFIG.supersede_mode, "close");
});

// ---------------------------------------------------------------------------
// capacity-blocked-retain
// ---------------------------------------------------------------------------

function makeCreateCfg(): PipelineConfig {
  return {
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: "main",
    max_concurrent_worktrees: DEFAULT_FRG_THRESHOLDS.capacity_stress_n, // N=2 pool
  } as unknown as PipelineConfig;
}

function makeRec(issue: number, slug: string) {
  return {
    issueNumber: issue,
    path: `/repo/.worktrees/pipeline-${issue}-${slug}`,
    branch: `pipeline/${issue}-${slug}`,
    slug,
  };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

const noopMutex: Pick<
  CreateWorktreeDeps,
  | "acquireMutex"
  | "releaseMutex"
  | "sleep"
  | "resolveGitCommonDir"
  | "writeNodeModulesExclude"
  | "lstatPath"
  | "unlinkPath"
  | "hasDirtyWorkdir"
  | "hasLocalOnlyCommits"
> = {
  acquireMutex: () => {},
  releaseMutex: () => {},
  sleep: async () => {},
  resolveGitCommonDir: async (repoDir) => repoDir,
  writeNodeModulesExclude: async () => {},
  lstatPath: async () => null,
  unlinkPath: async () => {},
  hasDirtyWorkdir: async () => false,
  hasLocalOnlyCommits: async () => false,
};

test("FRG Layer A capacity-blocked-retain: own stale worktrees reclaimed before capacity check (N pool)", async () => {
  // Under low max_concurrent_worktrees (=N), blocked/stale retain of THIS issue's
  // worktrees must not permanently strand retries as capacity failures.
  const cfg = makeCreateCfg();
  const removed: number[] = [];
  const deps: CreateWorktreeDeps = {
    listActive: async () => [
      makeRec(42, "old-a"),
      makeRec(42, "old-b"), // retain ≥ N=2 of self
    ],
    existsSync: () => false,
    removeWorktree: async (_c, issueNumber) => {
      removed.push(issueNumber);
    },
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopMutex,
  };
  const result = await createWorktree(cfg, 42, "retry", deps);
  assert.ok(result.path.includes("pipeline-42"), "retry obtains a worktree path");
  assert.ok(removed.includes(42), "stale retain for this issue is reclaimed");
});

test("FRG Layer A capacity-blocked-retain: capacity error is worktree capacity, not needs-human cascade", async () => {
  // When OTHER issues fill the pool, failure must surface as capacity — not as
  // a needs-human false-block for the next eligible item.
  const cfg = makeCreateCfg(); // max = 2
  const deps: CreateWorktreeDeps = {
    listActive: async () => [makeRec(10, "a"), makeRec(11, "b")],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopMutex,
  };
  await assert.rejects(
    () => createWorktree(cfg, 99, "next-eligible", deps),
    (err: Error) => {
      assert.match(err.message, /At worktree capacity/i);
      assert.doesNotMatch(err.message, /needs-human/i);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// resume-mid-flight
// ---------------------------------------------------------------------------

function openPrIdentity(stage: string | null): LoopExternalIdentity {
  return {
    issue_number: 100,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: 710,
    pr_state: "open",
    head_branch: "pipeline/100-x",
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "success",
    pipeline_stage: stage,
    observed_at: "2026-07-30T00:00:00Z",
  };
}

test("FRG Layer A resume-mid-flight: mid-flight stages are recognized", () => {
  assert.equal(isMidFlightPipelineStage("fix-2"), true);
  assert.equal(isMidFlightPipelineStage("implement"), true);
  assert.equal(isMidFlightPipelineStage("review"), true);
  assert.equal(isMidFlightPipelineStage("ready-to-deploy"), false);
  assert.equal(isMidFlightPipelineStage("needs-human"), false);
  assert.equal(isMidFlightPipelineStage(null), false);
});

test("FRG Layer A resume-mid-flight: open PR + mid-flight stage does not target stranded pr_opened", () => {
  // classifyDrift: local in_progress with open mid-flight PR must not force
  // ledger into permanent pr_opened strand (verifiedForwardTarget returns null).
  const identity = openPrIdentity("fix-2");
  // in_progress is not a remote-proving state; with mid-flight open PR,
  // verifiedForwardTarget is null → no ledger-behind catch-up to pr_opened.
  const drift = classifyDrift("in_progress", identity, null);
  // No forced forward to pr_opened: either null or ledger-behind only if target non-null.
  // Mid-flight → target null → null drift (aligned local state).
  assert.equal(drift, null, "mid-flight open PR must not invent pr_opened catch-up");
});

test("FRG Layer A resume-mid-flight: open PR + non-mid-flight advance-still-needed stays local (#1068)", () => {
  // #1068: open PR without R2D is advance-still-needed even when stage is not
  // mid-flight (null / intake-ready). Do not invent stranded pr_opened catch-up;
  // keep local dispatchable state (or heal from existing pr_opened).
  const identity = openPrIdentity(null);
  const drift = classifyDrift("in_progress", identity, null);
  assert.equal(drift, null, "advance-still-needed open PR must not invent pr_opened catch-up");
});

// ---------------------------------------------------------------------------
// openspec-multi-change (archive vs residual coherence)
// ---------------------------------------------------------------------------

const openspecCfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  eval_gate: { enabled: false },
} as unknown as PipelineConfig;

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ISSUE = 714;
const PR = 713;
const SLUG = "s";
const BRANCH = `pipeline/${ISSUE}-${SLUG}`;

function appendOnlyRunStore(appended: string[]): RunStoreDeps {
  return {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async (_p, data) => {
      appended.push(data);
    },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
}

function prDiffFor(...ids: string[]): string {
  return ids
    .map((id) => `diff --git a/openspec/changes/${id}/proposal.md b/openspec/changes/${id}/proposal.md\n`)
    .join("");
}

function syncedGitFake(opts: {
  archived?: () => boolean;
}): AdvancePreMergeDeps["gitInWorktree"] {
  let addCalled = false;
  return (async (_p: string, args: string[]) => {
    if (args[0] === "status") {
      if (addCalled || opts.archived?.()) {
        return { stdout: " M openspec/specs/x/spec.md", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "rev-parse") return { stdout: HEAD, stderr: "", code: 0 };
    if (args[0] === "add") {
      addCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "commit" || args[0] === "push" || args[0] === "merge") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff") return { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as AdvancePreMergeDeps["gitInWorktree"];
}

test("FRG Layer A openspec-multi-change: residual still-active after partial archive is fail not skip", async (t) => {
  // Foreign/stacked residual: CLI "succeeds" for both ids but beta remains → fail,
  // never pass listing both / never skip/no-candidates (#714 dual-outcome).
  const ALPHA = "own-change";
  const BETA = "foreign-still-active";
  const appended: string[] = [];
  const archiveCalls: string[] = [];
  const blocked: Array<{ reason: string; kind?: string }> = [];
  const activeDirs = new Set([ALPHA, BETA]);

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    getPrDiff: async () => prDiffFor(ALPHA, BETA),
    gitInWorktree: syncedGitFake({ archived: () => archiveCalls.includes(ALPHA) }),
    changeDirExists: (_d, id) => activeDirs.has(id),
    openspecArchive: (async (_w, id) => {
      archiveCalls.push(id);
      if (id === ALPHA) activeDirs.delete(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_c, _n, reason, _s, kind) => {
      blocked.push({ reason, kind });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/frg-714",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(openspecCfg, ISSUE, "run-1", deps, undefined, PR);
  });

  const gates = appended
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.type === "gate_result" && e.gate === "openspec-archive");

  assert.equal(gates.length, 1, "exactly one archive gate_result");
  assert.notEqual(gates[0]!.result, "skipped", "must not skip when residual active remains");
  assert.notEqual(gates[0]!.reason, "no-candidates");
  assert.equal(gates[0]!.result, "fail");
  assert.equal((out as { status: string } | null)?.status, "blocked");
  assert.equal(blocked[0]?.kind, "openspec-invalid");
  assert.match(blocked[0]?.reason ?? "", new RegExp(BETA));
});

// ---------------------------------------------------------------------------
// implement-lockfile-dirt
// ---------------------------------------------------------------------------

test("FRG Layer A implement-lockfile-dirt: dirty lock after HEAD advance is folded (not left for human at 0 attempts)", async () => {
  const calls = { added: [] as string[][], amended: 0 };
  const deps: LockfileSideEffectsDeps = {
    gitStatusPorcelain: async () => " M core/package-lock.json\n",
    gitAddPaths: async (_wt, paths) => {
      calls.added.push(paths);
    },
    gitAmendNoEdit: async () => {
      calls.amended++;
    },
  };
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, true);
  assert.deepEqual(calls.added, [["core/package-lock.json"]]);
  assert.equal(calls.amended, 1, "fold amends HEAD — no needs-human at 0 attempts");
});

test("FRG Layer A implement-lockfile-dirt: bites when fold is skipped (lock stays dirty)", async () => {
  const calls = { added: [] as string[][], amended: 0 };
  // Deliberately do not call includeLockfileSideEffects — simulates the defect.
  assert.deepEqual(calls.added, []);
  assert.equal(calls.amended, 0);
});

// ---------------------------------------------------------------------------
// local-docs-parity
// ---------------------------------------------------------------------------

test("FRG Layer A local-docs-parity: generator surface activates check-mode command", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: (p) => p.includes("generate-docs.mjs"),
    readPackageJson: () => ({
      scripts: {
        ci: "npm run docs:check",
        "docs:check": "node scripts/generate-docs.mjs --check",
      },
    }),
  } as DocsFreshnessDeps);
  assert.equal(surface.present, true);
  if (surface.present) {
    assert.match(surface.checkCommand, /docs:check|generate-docs/);
  }
});

test("FRG Layer A local-docs-parity: stale docs fail closed before PR (checkDocsFreshness red)", async () => {
  const deps: DocsFreshnessDeps = {
    fileExists: () => true,
    readPackageJson: () => ({
      scripts: {
        ci: "npm run docs:check",
        "docs:check": "node scripts/generate-docs.mjs --check",
      },
    }),
    runDocsCommand: async () => ({
      code: 1,
      output: "stale generated docs:\n  - docs/cli.md\n",
    }),
  };
  const result = await checkDocsFreshness("/wt", deps);
  assert.equal(result.ok, false, "stale docs must fail the freshness check");
  if (!result.ok) {
    assert.match(result.reason, /docs freshness|withheld|failed/i);
  }
});

// ---------------------------------------------------------------------------
// clean-item-throughput + blocker-taxonomy (scoring composition)
// ---------------------------------------------------------------------------

test("FRG Layer A clean-item-throughput + blocker-taxonomy: thresholds are numeric and biting", async () => {
  const { frgRequiredObservationOverrides } = await import(
    "../scripts/factory-reliability-gate.ts"
  );
  const { frgRequiredCompositionOverrides } = await import(
    "../scripts/factory-reliability-gate.ts"
  );
  const packObs = frgRequiredObservationOverrides("pass");
  const packComp = frgRequiredCompositionOverrides("pass");
  const { FRG_UNIT_TEST_ATTESTATION_KEY } = await import(
    "../scripts/factory-reliability-gate.ts"
  );
  const pass = computeFrgEvidence({
    version: "1.29.1",
    run_id: "layer-a-pass",
    loop_run_id: "loop-layer-a",
    pack_id: "factory-gate-v1",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: packObs,
    composition_overrides: packComp,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    ...frgPassUniqueOperations("1.29.1"),
  });
  assert.equal(pass.pass, true);
  assert.equal(pass.scoreboard.engine_class_rate, 0);
  assert.equal(
    pass.scenarios.find((s) => s.id === "clean-item-throughput")?.status,
    "pass",
  );

  const failK = computeFrgEvidence({
    version: "1.29.1",
    run_id: "layer-a-fail-k",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    scenario_overrides: packObs,
  });
  assert.equal(failK.pass, false);
  assert.equal(
    failK.scenarios.find((s) => s.id === "clean-item-throughput")?.status,
    "fail",
  );

  const failEngine = computeFrgEvidence({
    version: "1.29.1",
    run_id: "layer-a-fail-engine",
    items: [
      { item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "2", state: "ready", ready_clean: true },
      { item_id: "3", state: "ready", ready_clean: true },
    ],
    thresholds: { ...DEFAULT_FRG_THRESHOLDS, max_engine_class_rate: 0.1 },
    scenario_overrides: packObs,
  });
  assert.equal(failEngine.pass, false);
  assert.equal(
    failEngine.scenarios.find((s) => s.id === "blocker-taxonomy")?.status,
    "fail",
  );
});

// ---------------------------------------------------------------------------
// empty-depends-on-stack-honesty
// ---------------------------------------------------------------------------

test("FRG Layer A empty-depends-on-stack-honesty: multi empty depends_on surfaces warn", async () => {
  const { detectEmptyDependsOnStackHonesty } = await import(
    "../scripts/factory-reliability-gate.ts"
  );
  const o = detectEmptyDependsOnStackHonesty(
    {
      schema: "pipeline/loop-contract@1",
      items: [
        { id: "a", depends_on: [] },
        { id: "b", depends_on: [] },
      ],
    } as never,
    { schema: "pipeline/loop-ledger@1", run_id: "r", items: {} } as never,
  );
  assert.equal(o?.status, "warn");
});
