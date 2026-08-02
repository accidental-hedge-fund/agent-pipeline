// Tests for merge-queue surgical conflict/CI repair holds (#675).
//
// All I/O is injected — no real network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHoldRemediation,
  buildSurgicalRepairPrompt,
  canAttemptRepair,
  claimRepairAttempt,
  classifyEligibility,
  classifyFromMergeError,
  classifyQueueEligibility,
  createHold,
  createRepairBudget,
  type EligibilitySnapshot,
} from "../scripts/stages/merge_queue_hold.ts";
import {
  runMergeQueue,
  isRepairEnabled,
  realMergeQueueDeps,
  runDeterministicConflictRebase,
  runSharedMechanicalRepair,
  type MergeQueueCandidate,
  type MergeQueueDeps,
  type MergeQueueNonCandidate,
} from "../scripts/stages/merge-queue.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pure classification / hold / budget (tasks 1.x, 5.6)
// ---------------------------------------------------------------------------

test("classifyEligibility: conflict wins over checks-failed", () => {
  const snap: EligibilitySnapshot = {
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    checksOk: false,
    checksDetail: "ci (fail)",
    headRefOid: "abc",
  };
  assert.equal(classifyEligibility(snap), "merge-conflict");
});

test("classifyEligibility: checks-failed when mergeable clean but checks red", () => {
  const snap: EligibilitySnapshot = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksOk: false,
    checksDetail: "ci (fail)",
  };
  assert.equal(classifyEligibility(snap), "checks-failed");
});

test("classifyEligibility: null when eligible", () => {
  assert.equal(
    classifyEligibility({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checksOk: true,
      headRefOid: "deadbeef",
    }),
    null,
  );
});

test("classifyFromMergeError: conflict and checks messages", () => {
  assert.equal(
    classifyFromMergeError("PR has merge conflicts (mergeable: CONFLICTING)."),
    "merge-conflict",
  );
  assert.equal(
    classifyFromMergeError("PR has failing or pending required checks:\n  - ci (fail)"),
    "checks-failed",
  );
  assert.equal(classifyFromMergeError("totally unrelated boom"), null);
});

test("buildHoldRemediation: merge-conflict names PR and issue", () => {
  const text = buildHoldRemediation({
    reason: "merge-conflict",
    prNumber: 42,
    issueNumber: 10,
    summary: "mergeable=CONFLICTING",
  });
  assert.ok(text.includes("PR #42"));
  assert.ok(text.includes("issue #10"));
  assert.ok(text.includes("merge-conflict"));
  assert.ok(text.includes("pipeline merge 42") || text.includes("merge 42"));
});

test("buildHoldRemediation: checks-failed references evidence", () => {
  const text = buildHoldRemediation({
    reason: "checks-failed",
    prNumber: 42,
    summary: "ci (fail)",
  });
  assert.ok(text.includes("PR #42"));
  assert.ok(text.includes("ci (fail)"));
  assert.ok(text.includes("checks-failed"));
});

test("createHold: budget exhaust is manual-repair without human authority", () => {
  const hold = createHold({
    issueNumber: 10,
    prNumber: 42,
    reason: "merge-conflict",
    summary: "still conflicting",
    headSha: "abc123",
    repairAttemptsUsed: 1,
    budgetExhausted: true,
  });
  assert.equal(hold.outcome, "manual-repair");
  assert.equal(hold.humanAuthority, false);
  assert.equal(hold.reason, "merge-conflict");
  assert.equal(hold.repairAttemptsUsed, 1);
  assert.ok(hold.remediation.includes("PR #42"));
});

test("repair budget: canAttemptRepair and claim", () => {
  const state = createRepairBudget(1, { nowMs: 1000 });
  assert.equal(canAttemptRepair(state, 1000), true);
  const next = claimRepairAttempt(state);
  assert.equal(next.attemptsUsed, 1);
  assert.equal(canAttemptRepair(next, 1000), false);
  assert.equal(state.attemptsUsed, 0, "claim must not mutate input");
});

test("repair budget: zero max attempts means no implementer repair", () => {
  const state = createRepairBudget(0, { nowMs: 0 });
  assert.equal(canAttemptRepair(state, 0), false);
});

test("repair budget: wall-clock deadline blocks further attempts", () => {
  const state = createRepairBudget(5, { maxWallClockMs: 100, nowMs: 1000 });
  assert.equal(canAttemptRepair(state, 1000), true);
  assert.equal(canAttemptRepair(state, 1100), false);
});

test("buildSurgicalRepairPrompt: forbids feature expansion and merge", () => {
  const prompt = buildSurgicalRepairPrompt({
    reason: "merge-conflict",
    prNumber: 7,
    issueNumber: 3,
    summary: "DIRTY",
  });
  assert.ok(prompt.includes("minimal diff") || prompt.includes("Minimal diff") || prompt.includes("**minimal diff**"));
  assert.ok(prompt.toLowerCase().includes("do not") || prompt.includes("Do not"));
  assert.ok(prompt.includes("refactor") || prompt.includes("feature"));
  assert.ok(!prompt.includes("gh pr merge"));
  assert.ok(prompt.includes("Do not") && prompt.toLowerCase().includes("merge the pr"));
});

test("isRepairEnabled: default off; flag or config on", () => {
  assert.equal(isRepairEnabled(undefined, undefined), false);
  assert.equal(isRepairEnabled(false, false), false);
  assert.equal(isRepairEnabled(true, false), true);
  assert.equal(isRepairEnabled(false, true), true);
});

// ---------------------------------------------------------------------------
// Drive fixtures
// ---------------------------------------------------------------------------

function makeDeps(opts: {
  candidates?: MergeQueueCandidate[];
  remainingAfterApply?: MergeQueueCandidate[];
  nonCandidates?: MergeQueueNonCandidate[];
  /** Per-PR eligibility snapshots (shift on each evaluate call when array). */
  eligibility?: Map<number, EligibilitySnapshot | EligibilitySnapshot[]>;
  mergeImpl?: (c: MergeQueueCandidate) => Promise<void>;
  deterministicImpl?: MergeQueueDeps["attemptDeterministicRepair"];
  mechanicalImpl?: MergeQueueDeps["attemptMechanicalRepair"];
  nowSeq?: number[];
} = {}): MergeQueueDeps & {
  mergeCalls: MergeQueueCandidate[];
  deterministicCalls: number;
  mechanicalCalls: number;
  mechanicalPrompts: string[];
  evaluateCalls: number;
  logs: string[];
} {
  const mergeCalls: MergeQueueCandidate[] = [];
  const mechanicalPrompts: string[] = [];
  let deterministicCalls = 0;
  let mechanicalCalls = 0;
  let evaluateCalls = 0;
  let listCount = 0;
  let nowIdx = 0;
  const logs: string[] = [];
  const eligibilityCursors = new Map<number, number>();

  const deps: MergeQueueDeps & {
    mergeCalls: MergeQueueCandidate[];
    deterministicCalls: number;
    mechanicalCalls: number;
    mechanicalPrompts: string[];
    evaluateCalls: number;
    logs: string[];
  } = {
    mergeCalls,
    get deterministicCalls() {
      return deterministicCalls;
    },
    get mechanicalCalls() {
      return mechanicalCalls;
    },
    mechanicalPrompts,
    get evaluateCalls() {
      return evaluateCalls;
    },
    logs,
    async listR2dCandidates() {
      listCount += 1;
      const initial = opts.candidates ?? [];
      const remaining = opts.remainingAfterApply ?? [];
      return listCount === 1 ? [...initial] : [...remaining];
    },
    async listOpenNonCandidates() {
      return [...(opts.nonCandidates ?? [])];
    },
    async mergeCandidate(c) {
      mergeCalls.push(c);
      if (opts.mergeImpl) await opts.mergeImpl(c);
    },
    async evaluateEligibility(c) {
      evaluateCalls += 1;
      if (!opts.eligibility) {
        return {
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          checksOk: true,
          headRefOid: "sha-ok",
        };
      }
      const entry = opts.eligibility.get(c.prNumber);
      if (!entry) {
        return {
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          checksOk: true,
          headRefOid: "sha-ok",
        };
      }
      if (Array.isArray(entry)) {
        const idx = eligibilityCursors.get(c.prNumber) ?? 0;
        eligibilityCursors.set(c.prNumber, idx + 1);
        return entry[Math.min(idx, entry.length - 1)]!;
      }
      return entry;
    },
    async attemptDeterministicRepair(c, reason, snap) {
      deterministicCalls += 1;
      if (opts.deterministicImpl) {
        return opts.deterministicImpl(c, reason, snap);
      }
      return { changed: false, headSha: snap.headRefOid, evidence: "det noop" };
    },
    async attemptMechanicalRepair(c, reason, snap, prompt) {
      mechanicalCalls += 1;
      mechanicalPrompts.push(prompt);
      if (opts.mechanicalImpl) {
        return opts.mechanicalImpl(c, reason, snap, prompt);
      }
      return { succeeded: false, evidence: "mech fail", error: "mech fail" };
    },
    now() {
      if (opts.nowSeq && opts.nowSeq.length > 0) {
        const v = opts.nowSeq[Math.min(nowIdx, opts.nowSeq.length - 1)]!;
        nowIdx += 1;
        return v;
      }
      return 1_000_000;
    },
    async runRelease() {},
    log(msg) {
      logs.push(msg);
    },
    error() {},
  };
  return deps;
}

const baseOpts = {
  milestone: "v1.0.0",
  repoDir: "/repo",
  repo: "org/repo",
  apply: true as const,
};

const CONFLICT_SNAP: EligibilitySnapshot = {
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
  checksOk: true,
  headRefOid: "sha-conflict",
};

const CHECKS_FAIL_SNAP: EligibilitySnapshot = {
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  checksOk: false,
  checksDetail: "ci (fail)",
  headRefOid: "sha-red",
};

const CLEAN_SNAP: EligibilitySnapshot = {
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  checksOk: true,
  headRefOid: "sha-green",
};

// ---------------------------------------------------------------------------
// Drive: conflict → hold; no merge when repair off (5.1)
// ---------------------------------------------------------------------------

test("drive: conflict snapshot → merge-conflict hold; zero merge calls when repair off", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 10, prNumber: 100, title: "a" }],
    remainingAfterApply: [],
    eligibility: new Map([[100, CONFLICT_SNAP]]),
  });
  const result = await runMergeQueue({ ...baseOpts, repair: false }, deps);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.reason, "merge-conflict");
  assert.ok(result.held[0]!.remediation?.includes("PR #100"));
  assert.equal(result.merged.length, 0);
  assert.equal(deps.mergeCalls.length, 0, "must not call mergePr on conflict");
  assert.equal(deps.mechanicalCalls, 0);
  assert.equal(deps.deterministicCalls, 0);
  assert.equal(result.exitCode, 1);
});

// ---------------------------------------------------------------------------
// Drive: checks-failed; no merge while red (5.2)
// ---------------------------------------------------------------------------

test("drive: blocking checks → checks-failed hold; no merge while red", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 11, prNumber: 111, title: "b" }],
    remainingAfterApply: [],
    eligibility: new Map([[111, CHECKS_FAIL_SNAP]]),
  });
  const result = await runMergeQueue({ ...baseOpts }, deps);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.reason, "checks-failed");
  assert.ok(result.held[0]!.summary?.includes("ci (fail)"));
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.merged.length, 0);
});

// ---------------------------------------------------------------------------
// Drive: hold A, continue B/C (5.3)
// ---------------------------------------------------------------------------

test("drive: hold item A for conflict and continue to B and C", async () => {
  const deps = makeDeps({
    candidates: [
      { issueNumber: 1, prNumber: 10, title: "A" },
      { issueNumber: 2, prNumber: 20, title: "B" },
      { issueNumber: 3, prNumber: 30, title: "C" },
    ],
    remainingAfterApply: [],
    eligibility: new Map([
      [10, CONFLICT_SNAP],
      [20, CLEAN_SNAP],
      [30, CLEAN_SNAP],
    ]),
  });
  const result = await runMergeQueue({ ...baseOpts }, deps);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.prNumber, 10);
  assert.equal(result.held[0]!.reason, "merge-conflict");
  assert.equal(result.merged.length, 2);
  assert.deepEqual(
    result.merged.map((m) => m.prNumber),
    [20, 30],
  );
  assert.equal(deps.mergeCalls.length, 2);
});

// ---------------------------------------------------------------------------
// Drive: successful repair → re-eligible → single mergePr (5.4)
// ---------------------------------------------------------------------------

test("drive: successful repair stub → re-eligible → single mergePr call", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 5, prNumber: 50, title: "fixme" }],
    remainingAfterApply: [],
    eligibility: new Map([
      [
        50,
        [
          CONFLICT_SNAP,
          CONFLICT_SNAP, // after deterministic still conflicting
          CLEAN_SNAP, // after mechanical
        ],
      ],
    ]),
    async mechanicalImpl() {
      return { succeeded: true, headSha: "sha-green", evidence: "pushed fix" };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.merged.length, 1);
  assert.equal(result.held.length, 0);
  assert.equal(deps.mergeCalls.length, 1, "exactly one merge after re-gate");
  assert.equal(deps.mechanicalCalls, 1);
  assert.ok(deps.mechanicalPrompts[0]?.includes("minimal diff") || deps.mechanicalPrompts[0]?.includes("**minimal diff**"));
  assert.equal(result.exitCode, 0);
});

// ---------------------------------------------------------------------------
// Drive: budget exhaust → held with evidence; no further claim (5.5)
// ---------------------------------------------------------------------------

test("drive: budget exhaust → held with evidence; no further implementer claim; no force-merge", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 6, prNumber: 60, title: "stuck" }],
    remainingAfterApply: [],
    eligibility: new Map([[60, CONFLICT_SNAP]]),
    async mechanicalImpl() {
      return { succeeded: false, evidence: "still broken", error: "still broken" };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.reason, "merge-conflict");
  assert.equal(result.held[0]!.outcome, "manual-repair");
  assert.equal(result.held[0]!.humanAuthority, false);
  assert.equal(result.held[0]!.repairAttemptsUsed, 1);
  assert.equal(deps.mechanicalCalls, 1);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.merged.length, 0);
});

// ---------------------------------------------------------------------------
// Drive: merge error classification without pre-eval (legacy path)
// ---------------------------------------------------------------------------

test("drive: mergeCandidate throw CONFLICTING → typed hold when no eligibility pre-gate needed", async () => {
  // Disable evaluate by not providing progressive snaps that block merge —
  // use clean eligibility so merge is attempted, then throw.
  const deps = makeDeps({
    candidates: [{ issueNumber: 7, prNumber: 70, title: "throw" }],
    remainingAfterApply: [],
    eligibility: new Map([[70, CLEAN_SNAP]]),
    async mergeImpl() {
      throw new Error("PR has merge conflicts (mergeable: CONFLICTING). Resolve them.");
    },
  });
  // No repair — hold from merge throw classification after re-eval may still
  // say clean; classifyFromMergeError supplies merge-conflict.
  // After throw we re-evaluate and get CLEAN_SNAP which is eligible — then we'd
  // try to hold from error path. Looking at code: on merge throw with fromErr,
  // we reEvaluate and if snapshot classifies, use that. CLEAN would make
  // classified null, then `classifyEligibility(snapshot) ?? fromErr` → fromErr.
  const result = await runMergeQueue({ ...baseOpts, repair: false }, deps);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.reason, "merge-conflict");
  assert.equal(result.merged.length, 0);
});

// ---------------------------------------------------------------------------
// Dry-run / repair-disabled zero side effects (5.7)
// ---------------------------------------------------------------------------

test("drive: dry-run with --repair performs zero repair and zero merge side effects", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 8, prNumber: 80, title: "plan" }],
    eligibility: new Map([[80, CONFLICT_SNAP]]),
  });
  const result = await runMergeQueue(
    { ...baseOpts, apply: false, dryRun: true, repair: true },
    deps,
  );
  assert.equal(result.mode, "dry-run");
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.mechanicalCalls, 0);
  assert.equal(deps.deterministicCalls, 0);
  assert.equal(result.held.length, 0);
  assert.ok(deps.logs.some((l) => l.includes("repair flag ignored")));
});

test("drive: repair disabled performs zero repair side effects on conflict", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 9, prNumber: 90, title: "c" }],
    remainingAfterApply: [],
    eligibility: new Map([[90, CONFLICT_SNAP]]),
  });
  await runMergeQueue({ ...baseOpts, repair: false }, deps);
  assert.equal(deps.mechanicalCalls, 0);
  assert.equal(deps.deterministicCalls, 0);
  assert.equal(deps.mergeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Successful det-only repair without mechanical (re-query turns green)
// ---------------------------------------------------------------------------

test("drive: deterministic remediation alone can restore eligibility without mechanical", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 12, prNumber: 120, title: "flaky-checks" }],
    remainingAfterApply: [],
    eligibility: new Map([
      [120, [CHECKS_FAIL_SNAP, CLEAN_SNAP]],
    ]),
    async deterministicImpl(_c, _r, snap) {
      return { changed: false, headSha: snap.headRefOid, evidence: "checks settled" };
    },
  });
  // Remove mechanical so only det runs.
  delete (deps as { attemptMechanicalRepair?: unknown }).attemptMechanicalRepair;

  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.merged.length, 1);
  assert.equal(deps.mergeCalls.length, 1);
  assert.equal(deps.deterministicCalls, 1);
  assert.equal(deps.mechanicalCalls, 0);
});

// ---------------------------------------------------------------------------
// Isolation: advance stages do not import merge-queue drive repair
// ---------------------------------------------------------------------------

test("isolation: stage handlers do not import merge-queue drive for merging", () => {
  const stagesDir = path.join(__dirname, "..", "scripts", "stages");
  const forbidden = [
    "planning.ts",
    "review.ts",
    "fix.ts",
    "pre_merge.ts",
    "deploy_ready.ts",
    "auto_recover.ts",
  ];
  for (const name of forbidden) {
    const body = fs.readFileSync(path.join(stagesDir, name), "utf8");
    assert.ok(
      !body.includes('from "./merge-queue.ts"') &&
        !body.includes("from './merge-queue.ts'") &&
        !body.includes("runMergeQueue"),
      `${name} must not import merge-queue drive`,
    );
  }
});

test("isolation: no auto_merge key in merge_queue config schema surface", () => {
  const configPath = path.join(__dirname, "..", "scripts", "config.ts");
  const typesPath = path.join(__dirname, "..", "scripts", "types.ts");
  const configBody = fs.readFileSync(configPath, "utf8");
  const typesBody = fs.readFileSync(typesPath, "utf8");
  // merge_queue object must not introduce an auto_merge property key
  const mqBlock = configBody.slice(
    configBody.indexOf("merge_queue: z"),
    configBody.indexOf("context_snapshot: z"),
  );
  assert.ok(
    !/\bauto_merge\s*:/.test(mqBlock),
    "merge_queue schema must not add auto_merge property",
  );
  assert.ok(
    typesBody.includes("No `auto_merge` key") || typesBody.includes("no auto_merge"),
  );
});

// ---------------------------------------------------------------------------
// Review-1 regressions (#675 fix round 1)
// ---------------------------------------------------------------------------

test("classifyQueueEligibility: open + R2D + clean is eligible; closed/MERGED is already-done; lost R2D is policy", () => {
  assert.equal(
    classifyQueueEligibility({
      ...CLEAN_SNAP,
      prState: "OPEN",
      issueHasR2d: true,
    }).kind,
    "eligible",
  );
  assert.equal(
    classifyQueueEligibility({
      ...CLEAN_SNAP,
      prState: "MERGED",
      issueHasR2d: true,
    }).kind,
    "already-done",
  );
  assert.equal(
    classifyQueueEligibility({
      ...CLEAN_SNAP,
      prState: "CLOSED",
      issueHasR2d: true,
    }).kind,
    "already-done",
  );
  const policy = classifyQueueEligibility({
    ...CLEAN_SNAP,
    prState: "OPEN",
    issueHasR2d: false,
  });
  assert.equal(policy.kind, "policy");
  assert.equal(
    classifyQueueEligibility({
      ...CONFLICT_SNAP,
      prState: "OPEN",
      issueHasR2d: true,
    }).kind,
    "hold",
  );
});

test("realMergeQueueDeps wires production attemptMechanicalRepair seam", () => {
  // Smoke: production deps always expose the shared mechanical seam (cfg
  // optional for call wiring; missing cfg fails closed at invoke time).
  const deps = realMergeQueueDeps("/tmp/repo-does-not-need-to-exist", "org/repo");
  assert.equal(typeof deps.attemptMechanicalRepair, "function");
  assert.equal(typeof deps.attemptDeterministicRepair, "function");
  assert.equal(typeof deps.evaluateEligibility, "function");
});

test("runSharedMechanicalRepair uses injected shared repair path (no network)", async () => {
  const cfg = {
    harnesses: { implementer: "claude" },
  } as unknown as PipelineConfig;
  let repairCalls = 0;
  const result = await runSharedMechanicalRepair(
    { issueNumber: 42, prNumber: 7, title: "fix me" },
    "surgical prompt body",
    cfg,
    {
      async getOnDiskForIssue() {
        return { path: "/managed/wt", slug: "slug" };
      },
      async ensureManagedWorktree() {
        throw new Error("should not rematerialize when worktree exists");
      },
      async gitInWorktree() {
        throw new Error("git should not run when repair is injected");
      },
      async performRepair(
        _cfg,
        issueNumber,
        _runId,
        findingsText,
        _title,
        wt,
      ) {
        repairCalls += 1;
        assert.equal(issueNumber, 42);
        assert.equal(findingsText, "surgical prompt body");
        assert.equal(wt.path, "/managed/wt");
        return { status: "fix-committed", headSha: "abc123def" };
      },
      async invoke() {
        throw new Error("invoke should not run when performRepair is injected");
      },
    },
  );
  assert.equal(repairCalls, 1);
  assert.equal(result.succeeded, true);
  assert.equal(result.headSha, "abc123def");
});

// ---------------------------------------------------------------------------
// Deterministic conflict rebase/restack (#675 review-2: before implementer)
// ---------------------------------------------------------------------------

const EXPECTED_SHA = "aaaaaaa1bbbbbbb1ccccccc1ddddddd1eeeeeee1";
const AFTER_REBASE_SHA = "bbbbbbb2ccccccc2ddddddd2eeeeeee2fffffff2";

/** Shared fake git for clean rebase path: no prior rebase, clean worktree, matching SHAs. */
function cleanRebaseGit(
  gitCalls: string[][],
  opts: {
    cwd?: string;
    headAfterRebase?: string;
    pushCode?: number;
    rebaseCode?: number;
    remoteSha?: string;
    localHead?: string;
  } = {},
) {
  let headRevCount = 0;
  const localHead = opts.localHead ?? EXPECTED_SHA;
  const remoteSha = opts.remoteSha ?? EXPECTED_SHA;
  const after = opts.headAfterRebase ?? AFTER_REBASE_SHA;
  return async (cwd: string, args: string[]) => {
    if (opts.cwd) assert.equal(cwd, opts.cwd, "git must stay in managed worktree root");
    gitCalls.push([...args]);
    // Prior-rebase probe
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "REBASE_HEAD") {
      return { stdout: "", stderr: "fatal: Needed a single revision", code: 1 };
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      headRevCount += 1;
      const sha = headRevCount === 1 ? localHead : after;
      return { stdout: `${sha}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse" && String(args[1]).startsWith("refs/remotes/origin/")) {
      return { stdout: `${remoteSha}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "rebase" && args[1] === "origin/main") {
      return { stdout: "", stderr: "", code: opts.rebaseCode ?? 0 };
    }
    if (args[0] === "rebase" && args[1] === "origin/staging") {
      return { stdout: "", stderr: "", code: opts.rebaseCode ?? 0 };
    }
    if (args[0] === "rebase" && args[1] === "--abort") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "push") {
      return { stdout: "", stderr: opts.pushCode ? "rejected" : "", code: opts.pushCode ?? 0 };
    }
    if (args[0] === "reset" && args[1] === "--hard") {
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

test("runDeterministicConflictRebase: clean rebase then bound force-with-lease push", async () => {
  const cfg = { base_branch: "main" } as unknown as PipelineConfig;
  const gitCalls: string[][] = [];
  const result = await runDeterministicConflictRebase(
    { issueNumber: 42, prNumber: 7, title: "restack me" },
    cfg,
    {
      async getOnDiskForIssue() {
        return { path: "/managed/wt", slug: "slug" };
      },
      async ensureManagedWorktree() {
        throw new Error("should not rematerialize when worktree exists");
      },
      gitInWorktree: cleanRebaseGit(gitCalls, { cwd: "/managed/wt" }),
    },
    EXPECTED_SHA,
  );
  assert.equal(result.changed, true);
  assert.equal(result.headSha, AFTER_REBASE_SHA);
  assert.ok(result.evidence.includes("deterministic clean rebase"));
  assert.ok(result.evidence.includes("origin/main"));
  assert.ok(result.evidence.includes("pipeline/42-slug"));
  // Bound lease to eligibility snapshot head
  const push = gitCalls.find((a) => a[0] === "push");
  assert.ok(push, "must push");
  assert.ok(
    push!.some((a) => a.startsWith("--force-with-lease=refs/heads/pipeline/42-slug:")),
    `expected bound force-with-lease, got ${JSON.stringify(push)}`,
  );
  assert.ok(push!.includes(`HEAD:refs/heads/pipeline/42-slug`));
  assert.ok(gitCalls.some((a) => a[0] === "rebase" && a[1] === "origin/main"));
});

test("runDeterministicConflictRebase: rebase conflict aborts only our session without push", async () => {
  const cfg = { base_branch: "main" } as unknown as PipelineConfig;
  const gitCalls: string[][] = [];
  const result = await runDeterministicConflictRebase(
    { issueNumber: 9, prNumber: 90, title: "conflicted" },
    cfg,
    {
      async getOnDiskForIssue() {
        return { path: "/managed/wt", slug: "s" };
      },
      async ensureManagedWorktree() {
        throw new Error("should not rematerialize");
      },
      gitInWorktree: cleanRebaseGit(gitCalls, { rebaseCode: 1 }),
    },
    EXPECTED_SHA,
  );
  assert.equal(result.changed, false);
  assert.equal(result.headSha, EXPECTED_SHA);
  assert.ok(result.evidence.includes("failed"));
  assert.ok(result.evidence.includes("aborted our session"));
  assert.ok(
    gitCalls.some((a) => a[0] === "rebase" && a[1] === "--abort"),
    "must abort only the rebase we started",
  );
  assert.ok(
    !gitCalls.some((a) => a[0] === "push"),
    "must not push after failed rebase",
  );
});

test("runDeterministicConflictRebase: pre-existing rebase is fail-closed (no abort)", async () => {
  const cfg = { base_branch: "main" } as unknown as PipelineConfig;
  const gitCalls: string[][] = [];
  const result = await runDeterministicConflictRebase(
    { issueNumber: 11, prNumber: 110, title: "manual rebase" },
    cfg,
    {
      async getOnDiskForIssue() {
        return { path: "/managed/wt", slug: "s" };
      },
      async gitInWorktree(_cwd, args) {
        gitCalls.push([...args]);
        if (args[0] === "rev-parse" && args[2] === "REBASE_HEAD") {
          return { stdout: "mid-rebase\n", stderr: "", code: 0 }; // rebase in progress
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    },
    EXPECTED_SHA,
  );
  assert.equal(result.changed, false);
  assert.ok(result.evidence.includes("rebase already in progress"));
  assert.ok(
    !gitCalls.some((a) => a[0] === "rebase" && a[1] === "--abort"),
    "must not abort operator-owned rebase",
  );
  assert.ok(!gitCalls.some((a) => a[0] === "push"));
});

test("runDeterministicConflictRebase: force-with-lease bound to snapshot; push fail restores HEAD", async () => {
  const cfg = { base_branch: "main" } as unknown as PipelineConfig;
  const gitCalls: string[][] = [];
  const result = await runDeterministicConflictRebase(
    { issueNumber: 42, prNumber: 7, title: "push fail" },
    cfg,
    {
      async getOnDiskForIssue() {
        return { path: "/managed/wt", slug: "slug" };
      },
      gitInWorktree: cleanRebaseGit(gitCalls, { pushCode: 1 }),
    },
    EXPECTED_SHA,
  );
  assert.equal(result.changed, false);
  assert.equal(result.headSha, EXPECTED_SHA);
  assert.ok(result.evidence.includes("force-with-lease push"));
  assert.ok(result.evidence.includes("local branch restored"));
  assert.ok(
    gitCalls.some((a) => a[0] === "reset" && a[1] === "--hard" && a[2] === EXPECTED_SHA),
    "must restore pre-rebase SHA after push failure",
  );
});

test("runDeterministicConflictRebase: stale remote head fails closed without rebase", async () => {
  const cfg = { base_branch: "main" } as unknown as PipelineConfig;
  const gitCalls: string[][] = [];
  const result = await runDeterministicConflictRebase(
    { issueNumber: 42, prNumber: 7, title: "stale remote" },
    cfg,
    {
      async getOnDiskForIssue() {
        return { path: "/managed/wt", slug: "slug" };
      },
      gitInWorktree: cleanRebaseGit(gitCalls, {
        remoteSha: "cccccccc3ddddddd3eeeeeee3fffffff3aaaaaaa3",
      }),
    },
    EXPECTED_SHA,
  );
  assert.equal(result.changed, false);
  assert.ok(result.evidence.includes("stale or divergent remote head"));
  assert.ok(
    !gitCalls.some((a) => a[0] === "rebase" && a[1]?.startsWith("origin/")),
    "must not rebase when remote head diverged from snapshot",
  );
});

test("runDeterministicConflictRebase: rematerializes managed worktree when missing", async () => {
  const cfg = { base_branch: "staging" } as unknown as PipelineConfig;
  let ensureCalls = 0;
  const gitCalls: string[][] = [];
  const result = await runDeterministicConflictRebase(
    { issueNumber: 3, prNumber: 30, title: "need wt" },
    cfg,
    {
      async getOnDiskForIssue() {
        return null;
      },
      async ensureManagedWorktree() {
        ensureCalls += 1;
        return {
          result: "pass" as const,
          worktree: {
            path: "/new/wt",
            slug: "need-wt",
            branch: "pipeline/3-need-wt",
          },
          reason: "rematerialized",
        };
      },
      gitInWorktree: cleanRebaseGit(gitCalls, {
        cwd: "/new/wt",
        headAfterRebase: EXPECTED_SHA, // no-op restack
      }),
    },
    EXPECTED_SHA,
  );
  assert.equal(ensureCalls, 1);
  assert.equal(result.changed, false);
  assert.ok(result.evidence.includes("already up to date"));
});

test("drive: deterministic conflict repair is attempted before mechanical implementer", async () => {
  const order: string[] = [];
  const deps = makeDeps({
    candidates: [{ issueNumber: 50, prNumber: 500, title: "order" }],
    remainingAfterApply: [],
    eligibility: new Map([
      [
        500,
        [
          CONFLICT_SNAP, // preflight
          CONFLICT_SNAP, // after det still conflicting
          CONFLICT_SNAP, // after mechanical still conflicting
        ],
      ],
    ]),
    async deterministicImpl(_c, reason) {
      order.push(`det:${reason}`);
      assert.equal(reason, "merge-conflict");
      return {
        changed: false,
        headSha: "sha-conflict",
        evidence: "deterministic rebase failed (conflicts); aborted",
      };
    },
    async mechanicalImpl() {
      order.push("mech");
      return { succeeded: false, evidence: "mech fail", error: "mech fail" };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  // Spec: deterministic-first — first call must be det before any implementer.
  assert.equal(order[0], "det:merge-conflict");
  assert.ok(order.includes("mech"), "mechanical implementer must run after det fails");
  assert.ok(
    order.indexOf("det:merge-conflict") < order.indexOf("mech"),
    "deterministic rebase/restack must precede implementer repair",
  );
  assert.equal(deps.mechanicalCalls, 1);
  assert.ok(deps.deterministicCalls >= 1);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.reason, "merge-conflict");
  assert.equal(deps.mergeCalls.length, 0);
});

test("drive: successful deterministic rebase alone restores eligibility without mechanical", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 51, prNumber: 510, title: "clean-restack" }],
    remainingAfterApply: [],
    eligibility: new Map([
      [
        510,
        [
          CONFLICT_SNAP, // preflight conflict
          CLEAN_SNAP, // after clean restack re-gate
        ],
      ],
    ]),
    async deterministicImpl() {
      return {
        changed: true,
        headSha: "sha-green",
        evidence: "deterministic clean rebase onto origin/main; pushed pipeline/51-slug",
      };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.merged.length, 1);
  assert.equal(deps.deterministicCalls, 1);
  assert.equal(deps.mechanicalCalls, 0, "must not invoke implementer after clean restack");
  assert.equal(deps.mergeCalls.length, 1);
});

test("drive: evaluateEligibility rejection holds item A and continues to B", async () => {
  const deps = makeDeps({
    candidates: [
      { issueNumber: 1, prNumber: 10, title: "A" },
      { issueNumber: 2, prNumber: 20, title: "B" },
    ],
    remainingAfterApply: [],
    eligibility: new Map([[20, CLEAN_SNAP]]),
  });
  // Override evaluate to throw for PR 10 only.
  const originalEval = deps.evaluateEligibility!.bind(deps);
  deps.evaluateEligibility = async (c) => {
    if (c.prNumber === 10) throw new Error("github read timeout");
    return originalEval(c);
  };

  const result = await runMergeQueue({ ...baseOpts }, deps);
  assert.equal(result.held.length, 1);
  assert.ok(
    String(result.held[0]!.reason).includes("eligibility preflight failed") ||
      String(result.held[0]!.summary).includes("github read timeout"),
  );
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0]!.prNumber, 20);
  assert.equal(deps.mergeCalls.length, 1);
});

test("drive: mechanical repair rejection is charged, held, and does not abandon batch", async () => {
  const deps = makeDeps({
    candidates: [
      { issueNumber: 1, prNumber: 10, title: "A" },
      { issueNumber: 2, prNumber: 20, title: "B" },
    ],
    remainingAfterApply: [],
    eligibility: new Map([
      [10, CONFLICT_SNAP],
      [20, CLEAN_SNAP],
    ]),
    async mechanicalImpl() {
      throw new Error("harness timeout");
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.prNumber, 10);
  assert.equal(result.held[0]!.repairAttemptsUsed, 1);
  assert.equal(result.held[0]!.outcome, "manual-repair");
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0]!.prNumber, 20);
  assert.equal(deps.mechanicalCalls, 1);
  assert.equal(deps.mergeCalls.length, 1, "only B merges; A never force-merged");
});

test("drive: post-repair re-gate refuses merge when PR is no longer open", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 5, prNumber: 50, title: "fixme" }],
    remainingAfterApply: [],
    eligibility: new Map([
      [
        50,
        [
          CONFLICT_SNAP,
          CONFLICT_SNAP, // after deterministic
          {
            ...CLEAN_SNAP,
            prState: "MERGED",
            issueHasR2d: true,
          },
        ],
      ],
    ]),
    async mechanicalImpl() {
      return { succeeded: true, headSha: "sha-green", evidence: "pushed" };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.merged.length, 0, "must not call merge after MERGED re-gate");
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.held.length, 0, "already-done is not a hold");
  assert.ok(deps.logs.some((l) => l.includes("already-done")));
});

test("drive: post-repair re-gate holds when linked issue lost R2D", async () => {
  const deps = makeDeps({
    candidates: [{ issueNumber: 5, prNumber: 50, title: "fixme" }],
    remainingAfterApply: [],
    eligibility: new Map([
      [
        50,
        [
          CONFLICT_SNAP,
          CONFLICT_SNAP,
          {
            ...CLEAN_SNAP,
            prState: "OPEN",
            issueHasR2d: false,
          },
        ],
      ],
    ]),
    async mechanicalImpl() {
      return { succeeded: true, headSha: "sha-green", evidence: "pushed" };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(deps.mergeCalls.length, 0, "must not merge without R2D policy");
  assert.equal(result.merged.length, 0);
  assert.equal(result.held.length, 1);
  assert.ok(
    String(result.held[0]!.reason).includes("ready-to-deploy") ||
      String(result.held[0]!.summary).includes("ready-to-deploy"),
  );
});

test("drive: deterministic repair rejection holds-and-continues without escaping", async () => {
  const deps = makeDeps({
    candidates: [
      { issueNumber: 1, prNumber: 10, title: "A" },
      { issueNumber: 2, prNumber: 20, title: "B" },
    ],
    remainingAfterApply: [],
    eligibility: new Map([
      [10, CONFLICT_SNAP],
      [20, CLEAN_SNAP],
    ]),
    async deterministicImpl() {
      throw new Error("rebase worktree boom");
    },
    async mechanicalImpl() {
      return { succeeded: false, evidence: "still conflict", error: "still conflict" };
    },
  });
  const result = await runMergeQueue(
    { ...baseOpts, repair: true, repairMaxAttempts: 1 },
    deps,
  );
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.prNumber, 10);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0]!.prNumber, 20);
  assert.ok(deps.deterministicCalls >= 1, "deterministic was invoked (may retry each ladder pass)");
  assert.equal(deps.mechanicalCalls, 1, "mechanical still attempted after det throw");
});
