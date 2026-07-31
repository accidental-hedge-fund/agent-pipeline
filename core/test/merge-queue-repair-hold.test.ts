// Tests for merge-queue surgical conflict/CI repair hold (#675).
//
// Network/git/subprocess free: all I/O via injected DriveDeps fakes.
// Critical paths prove they bite without the hold/re-gate logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  driveCandidatesFromPlan,
  driveMergeQueue,
  evaluateDriveEligibility,
  formatDriveSummary,
  realDriveDeps,
  realMergeQueueRepairDeps,
  runMergeQueueCommand,
  type DriveCandidate,
  type DriveDeps,
  type DriveEligibility,
  type DriveRevalidation,
} from "../scripts/stages/merge_queue_drive.ts";
import type { MergeDeps } from "../scripts/stages/merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import {
  buildHoldRemediation,
  buildMergeQueueRepairPrompt,
  canAttemptRepair,
  classifyEligibility,
  classifyMergeErrorToHoldReason,
  createHold,
  createRepairBudget,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  HOLD_REASON_CHECKS_FAILED,
  HOLD_REASON_MERGE_CONFLICT,
} from "../scripts/stages/merge_queue_hold.ts";
import type { MergeQueueCandidate, MergeQueueDeps } from "../scripts/stages/merge_queue.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLD_TS = path.join(__dirname, "..", "scripts", "stages", "merge_queue_hold.ts");
const DRIVE_TS = path.join(__dirname, "..", "scripts", "stages", "merge_queue_drive.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cand(pr: number, issue: number): DriveCandidate {
  return { prNumber: pr, issueNumber: issue };
}

function makeDriveDeps(opts: {
  revalidate?: (c: DriveCandidate) => Promise<DriveRevalidation> | DriveRevalidation;
  evaluateEligibility?: (
    c: DriveCandidate,
  ) => Promise<DriveEligibility> | DriveEligibility;
  /** Sequential eligibility results per PR (consumed in order). */
  eligibilityQueue?: Map<number, DriveEligibility[]>;
  mergeImpl?: (pr: number) => Promise<void>;
  repair?: DriveDeps["repair"];
}): DriveDeps & {
  mergeCalls: number[];
  eligibilityCalls: number[];
  repairInvokeCalls: number;
  worktreeResolveCalls: number;
} {
  const mergeCalls: number[] = [];
  const eligibilityCalls: number[] = [];
  let repairInvokeCalls = 0;
  let worktreeResolveCalls = 0;
  const queues = opts.eligibilityQueue ?? new Map<number, DriveEligibility[]>();

  const deps: DriveDeps & {
    mergeCalls: number[];
    eligibilityCalls: number[];
    repairInvokeCalls: number;
    worktreeResolveCalls: number;
  } = {
    mergeCalls,
    eligibilityCalls,
    get repairInvokeCalls() {
      return repairInvokeCalls;
    },
    get worktreeResolveCalls() {
      return worktreeResolveCalls;
    },
    async revalidate(c) {
      if (opts.revalidate) return opts.revalidate(c);
      return { kind: "eligible" };
    },
    async evaluateEligibility(c) {
      eligibilityCalls.push(c.prNumber);
      if (opts.evaluateEligibility) return opts.evaluateEligibility(c);
      const q = queues.get(c.prNumber);
      if (q && q.length > 0) return q.shift()!;
      return { kind: "eligible", headRefOid: `sha-${c.prNumber}` };
    },
    async mergePr(pr) {
      mergeCalls.push(pr);
      if (opts.mergeImpl) await opts.mergeImpl(pr);
    },
    repair: opts.repair
      ? {
          async resolveManagedWorktree(c) {
            worktreeResolveCalls++;
            return opts.repair!.resolveManagedWorktree(c);
          },
          async invokeRepair(args) {
            repairInvokeCalls++;
            return opts.repair!.invokeRepair(args);
          },
        }
      : undefined,
    log() {},
  };
  return deps;
}

// ---------------------------------------------------------------------------
// Pure hold model
// ---------------------------------------------------------------------------

test("hold: reason keys are stable machine strings", () => {
  assert.equal(HOLD_REASON_MERGE_CONFLICT, "merge-conflict");
  assert.equal(HOLD_REASON_CHECKS_FAILED, "checks-failed");
  const h = createHold({
    prNumber: 42,
    issueNumber: 7,
    reason: "merge-conflict",
    summary: "mergeable=CONFLICTING mergeStateStatus=DIRTY",
    lastHeadSha: "abc123",
  });
  assert.equal(h.reason, "merge-conflict");
  assert.match(h.remediation, /PR #42/);
  assert.match(h.remediation, /issue #7/);
  assert.match(h.remediation, /Resolve conflicts/);
});

test("hold: checks-failed remediation names PR and blocking summary", () => {
  const text = buildHoldRemediation({
    reason: "checks-failed",
    prNumber: 99,
    issueNumber: 3,
    summary: "ci (fail); lint (pending)",
    lastHeadSha: "deadbeef",
  });
  assert.match(text, /checks-failed/);
  assert.match(text, /PR #99/);
  assert.match(text, /ci \(fail\)/);
  assert.match(text, /pipeline merge 99|merge-queue --apply/);
});

test("classifyEligibility: conflict → merge-conflict hold", () => {
  const r = classifyEligibility({
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    checksOk: true,
    checksSummary: "ok",
  });
  assert.equal(r.kind, "hold");
  if (r.kind === "hold") assert.equal(r.reason, "merge-conflict");
});

test("classifyEligibility: red checks → checks-failed hold", () => {
  const r = classifyEligibility({
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksOk: false,
    checksSummary: "ci (fail)",
  });
  assert.equal(r.kind, "hold");
  if (r.kind === "hold") assert.equal(r.reason, "checks-failed");
});

test("classifyEligibility: both clean → eligible", () => {
  const r = classifyEligibility({
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksOk: true,
    checksSummary: "1 required pass",
  });
  assert.equal(r.kind, "eligible");
});

test("classifyEligibility: conflict wins over red checks", () => {
  const r = classifyEligibility({
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    checksOk: false,
    checksSummary: "ci (fail)",
  });
  assert.equal(r.kind, "hold");
  if (r.kind === "hold") assert.equal(r.reason, "merge-conflict");
});

test("repair budget: zero max never allows repair", () => {
  const b = createRepairBudget({ maxAttempts: 0 });
  assert.equal(canAttemptRepair(0, b), false);
});

test("repair budget: exhaust after N attempts", () => {
  const b = createRepairBudget({ maxAttempts: 2 });
  assert.equal(canAttemptRepair(0, b), true);
  assert.equal(canAttemptRepair(1, b), true);
  assert.equal(canAttemptRepair(2, b), false);
  assert.equal(DEFAULT_MAX_REPAIR_ATTEMPTS, 1);
});

test("repair budget: wall-clock deadline blocks further repair", () => {
  const b = createRepairBudget({ maxAttempts: 5, maxWallClockMs: 1000, nowMs: 10_000 });
  assert.equal(canAttemptRepair(0, b, 10_500), true);
  assert.equal(canAttemptRepair(0, b, 11_000), false);
});

test("repair prompt forbids broad feature work and encodes surgical discipline", () => {
  const prompt = buildMergeQueueRepairPrompt({
    prNumber: 10,
    issueNumber: 1,
    reason: "merge-conflict",
    summary: "DIRTY",
    worktreePath: "/repo/.worktrees/pipeline-1-slug",
    lastHeadSha: "abc",
  });
  assert.match(prompt, /Surgical Fix Discipline/i);
  assert.match(prompt, /minimal diff/i);
  assert.match(prompt, /Do NOT.*refactor/i);
  assert.match(prompt, /Do NOT.*feature work/i);
  assert.match(prompt, /managed worktree/i);
  assert.match(prompt, /Do NOT squash-merge/i);
});

test("classifyMergeErrorToHoldReason maps conflict and checks messages", () => {
  assert.equal(
    classifyMergeErrorToHoldReason("PR has merge conflicts (mergeable: CONFLICTING)."),
    "merge-conflict",
  );
  assert.equal(
    classifyMergeErrorToHoldReason("PR has failing or pending required checks:\n  - ci (fail)"),
    "checks-failed",
  );
  assert.equal(classifyMergeErrorToHoldReason("API rate limit"), null);
});

// ---------------------------------------------------------------------------
// 6.1 Conflict → hold; zero merge calls
// ---------------------------------------------------------------------------

test("drive: conflict fixture → merge-conflict hold; zero merge surface calls", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "merge-conflict",
      summary: "mergeable=CONFLICTING mergeStateStatus=DIRTY",
      headRefOid: "sha-conflict",
    }),
  });
  const result = await driveMergeQueue([cand(10, 1)], deps);
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.reason, "merge-conflict");
  assert.equal(deps.mergeCalls.length, 0, "must not call mergePr while conflicted");
  assert.equal(result.holds.length, 1);
  assert.match(result.holds[0].remediation, /PR #10/);
  assert.equal(result.stopped, true, "hold is a fail-stop queue point");
  assert.equal(result.exitCode, 1);
});

// ---------------------------------------------------------------------------
// 6.2 Red checks → hold; zero merge calls
// ---------------------------------------------------------------------------

test("drive: red required checks → checks-failed hold; zero merge surface calls", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "checks-failed",
      summary: "ci (fail)",
      headRefOid: "sha-red",
    }),
  });
  const result = await driveMergeQueue([cand(11, 2)], deps);
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.reason, "checks-failed");
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(result.stopped, true, "hold is a fail-stop queue point");
});

// ---------------------------------------------------------------------------
// 6.3 Successful repair → re-gate → merge once
// ---------------------------------------------------------------------------

test("drive: successful repair then green eligibility → merge surface once", async () => {
  const queue = new Map<number, DriveEligibility[]>([
    [
      10,
      [
        {
          kind: "hold",
          reason: "merge-conflict",
          summary: "DIRTY",
          headRefOid: "sha-old",
        },
        { kind: "eligible", headRefOid: "sha-new" },
      ],
    ],
  ]);
  const prompts: string[] = [];
  const deps = makeDriveDeps({
    eligibilityQueue: queue,
    repair: {
      async resolveManagedWorktree() {
        return { path: "/repo/.worktrees/pipeline-1-x" };
      },
      async invokeRepair(args) {
        prompts.push(args.prompt);
        assert.equal(args.holdReason, "merge-conflict");
        assert.ok(args.prompt.includes("Surgical Fix Discipline"));
        return { ok: true };
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 1,
  });
  assert.equal(result.outcomes[0].outcome, "merged");
  assert.deepEqual(deps.mergeCalls, [10]);
  assert.equal(deps.repairInvokeCalls, 1);
  assert.equal(deps.eligibilityCalls.length, 2, "pre-repair + re-gate");
  assert.equal(result.holds.length, 0);
  assert.ok(prompts[0].includes("minimal diff"));
});

// ---------------------------------------------------------------------------
// 6.4 Budget exhaust → held; no attempt N+1
// ---------------------------------------------------------------------------

test("drive: budget exhaust after N failed repairs → held; no attempt N+1", async () => {
  let repairs = 0;
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "checks-failed",
      summary: "ci (fail)",
      headRefOid: "sha",
    }),
    repair: {
      async resolveManagedWorktree() {
        return { path: "/wt" };
      },
      async invokeRepair() {
        repairs++;
        return { ok: true, detail: "pushed but still red" };
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 2,
  });
  assert.equal(repairs, 2, "exactly max attempts");
  assert.equal(deps.repairInvokeCalls, 2);
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.repairAttempts, 2);
  assert.equal(deps.mergeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 6.5 Hold fail-stop
// ---------------------------------------------------------------------------

test("drive: hold fail-stops later candidates as not-attempted", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: (c) => {
      if (c.prNumber === 10) {
        return {
          kind: "hold",
          reason: "merge-conflict",
          summary: "DIRTY",
          headRefOid: "x",
        };
      }
      return { kind: "eligible", headRefOid: "y" };
    },
  });
  const result = await driveMergeQueue([cand(10, 1), cand(11, 2), cand(12, 3)], deps);
  assert.equal(result.stopped, true);
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[1].outcome, "not-attempted");
  assert.equal(result.outcomes[2].outcome, "not-attempted");
  assert.deepEqual(deps.mergeCalls, []);
  assert.equal(result.holds.length, 1);
  assert.equal(result.exitCode, 1);
});

// ---------------------------------------------------------------------------
// 6.6 Repair disabled never invokes harness
// ---------------------------------------------------------------------------

test("drive: repair-disabled records hold without harness", async () => {
  let resolveCalls = 0;
  let invokeCalls = 0;
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "checks-failed",
      summary: "ci (pending)",
      headRefOid: "sha",
    }),
    repair: {
      async resolveManagedWorktree() {
        resolveCalls++;
        return { path: "/wt" };
      },
      async invokeRepair() {
        invokeCalls++;
        return { ok: true };
      },
    },
  });
  // repairEnabled defaults false
  const result = await driveMergeQueue([cand(10, 1)], deps, { repairEnabled: false });
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(resolveCalls, 0);
  assert.equal(invokeCalls, 0);
  assert.equal(deps.mergeCalls.length, 0);
});

test("drive: maxRepairAttempts 0 never auto-repairs", async () => {
  let invokeCalls = 0;
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "merge-conflict",
      summary: "DIRTY",
      headRefOid: "sha",
    }),
    repair: {
      async resolveManagedWorktree() {
        return { path: "/wt" };
      },
      async invokeRepair() {
        invokeCalls++;
        return { ok: true };
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 0,
  });
  assert.equal(invokeCalls, 0);
  assert.equal(result.outcomes[0].outcome, "held");
});

// ---------------------------------------------------------------------------
// Re-gate failures after repair stay held
// ---------------------------------------------------------------------------

test("drive: repair that leaves checks red does not merge", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "checks-failed",
      summary: "ci (fail)",
      headRefOid: "sha",
    }),
    repair: {
      async resolveManagedWorktree() {
        return { path: "/wt" };
      },
      async invokeRepair() {
        return { ok: true };
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 1,
  });
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.reason, "checks-failed");
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.repairInvokeCalls, 1);
});

test("drive: missing managed worktree holds without merge", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "merge-conflict",
      summary: "DIRTY",
      headRefOid: "sha",
    }),
    repair: {
      async resolveManagedWorktree() {
        return null;
      },
      async invokeRepair() {
        throw new Error("must not invoke without worktree");
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 1,
  });
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.repairInvokeCalls, 0);
  assert.equal(result.outcomes[0].hold?.repairAttempts, 1);
});

// ---------------------------------------------------------------------------
// Review 2 regressions: base re-assert + durable hold on repair infra failure
// ---------------------------------------------------------------------------

test("evaluateDriveEligibility: wrong base is non-repairable ineligible", async () => {
  const result = await evaluateDriveEligibility(cand(5, 1), {
    expectedBaseBranch: "main",
    async ghPrView() {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "abc",
        baseRefName: "release-1",
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [];
    },
  });
  assert.equal(result.kind, "ineligible");
  if (result.kind === "ineligible") {
    assert.match(result.reason, /wrong base/);
    assert.match(result.reason, /release-1/);
    assert.match(result.reason, /main/);
  }
});

test("drive: retargeted base fails without mergePr (pre-merge revalidation)", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "ineligible",
      reason: "wrong base: baseRefName=staging expected=main",
      headRefOid: "sha-retarget",
    }),
  });
  const result = await driveMergeQueue(
    [cand(10, 1), cand(11, 2)],
    deps,
  );
  assert.equal(result.outcomes[0].outcome, "failed");
  assert.match(result.outcomes[0].reason ?? "", /wrong base/);
  assert.equal(result.outcomes[1].outcome, "not-attempted");
  assert.equal(deps.mergeCalls.length, 0, "must not merge after base retarget");
  assert.equal(result.stopped, true);
  assert.equal(result.exitCode, 1);
});

test("drive: post-repair re-gate wrong base does not merge", async () => {
  const queue = new Map<number, DriveEligibility[]>([
    [
      10,
      [
        {
          kind: "hold",
          reason: "merge-conflict",
          summary: "DIRTY",
          headRefOid: "sha-old",
        },
        {
          kind: "ineligible",
          reason: "wrong base: baseRefName=other expected=main",
          headRefOid: "sha-new",
        },
      ],
    ],
  ]);
  const deps = makeDriveDeps({
    eligibilityQueue: queue,
    repair: {
      async resolveManagedWorktree() {
        return { path: "/wt" };
      },
      async invokeRepair() {
        return { ok: true };
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 1,
  });
  assert.equal(result.outcomes[0].outcome, "failed");
  assert.match(result.outcomes[0].reason ?? "", /wrong base/);
  assert.equal(deps.mergeCalls.length, 0);
  assert.equal(deps.repairInvokeCalls, 1);
  assert.equal(result.stopped, true);
});

test("drive: resolveManagedWorktree rejection records hold and fail-stops", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: (c) => {
      if (c.prNumber === 10) {
        return {
          kind: "hold",
          reason: "merge-conflict",
          summary: "DIRTY",
          headRefOid: "sha-10",
        };
      }
      return { kind: "eligible", headRefOid: "sha-11" };
    },
    repair: {
      async resolveManagedWorktree() {
        throw new Error("worktree resolver crashed");
      },
      async invokeRepair() {
        throw new Error("must not invoke after resolver throw");
      },
    },
  });
  const result = await driveMergeQueue([cand(10, 1), cand(11, 2)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 1,
  });
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.reason, "merge-conflict");
  assert.match(result.outcomes[0].hold?.summary ?? "", /repair-infra-error/);
  assert.match(result.outcomes[0].hold?.summary ?? "", /worktree resolver crashed/);
  assert.equal(result.outcomes[0].hold?.repairAttempts, 1);
  assert.equal(result.outcomes[1].outcome, "not-attempted");
  assert.deepEqual(deps.mergeCalls, [], "later candidates must not merge after hold");
  assert.equal(result.stopped, true);
  assert.equal(result.exitCode, 1, "holds leave non-zero exit");
});

test("drive: invokeRepair rejection records hold and fail-stops", async () => {
  const deps = makeDriveDeps({
    evaluateEligibility: (c) => {
      if (c.prNumber === 20) {
        return {
          kind: "hold",
          reason: "checks-failed",
          summary: "ci (fail)",
          headRefOid: "sha-20",
        };
      }
      return { kind: "eligible", headRefOid: "sha-21" };
    },
    repair: {
      async resolveManagedWorktree() {
        return { path: "/wt" };
      },
      async invokeRepair() {
        throw new Error("harness process killed");
      },
    },
  });
  const result = await driveMergeQueue([cand(20, 3), cand(21, 4)], deps, {
    repairEnabled: true,
    maxRepairAttempts: 2,
  });
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.reason, "checks-failed");
  assert.match(result.outcomes[0].hold?.summary ?? "", /harness process killed/);
  assert.equal(result.outcomes[0].hold?.repairAttempts, 1);
  assert.equal(result.outcomes[1].outcome, "not-attempted");
  assert.deepEqual(deps.mergeCalls, []);
  assert.equal(result.stopped, true);
});

// ---------------------------------------------------------------------------
// evaluateDriveEligibility with injected gh fixtures
// ---------------------------------------------------------------------------

test("evaluateDriveEligibility: conflict fixture holds without real I/O", async () => {
  const result = await evaluateDriveEligibility(cand(5, 1), {
    async ghPrView() {
      return {
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        headRefOid: "abc",
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [];
    },
  });
  assert.equal(result.kind, "hold");
  if (result.kind === "hold") {
    assert.equal(result.reason, "merge-conflict");
    assert.equal(result.headRefOid, "abc");
  }
});

test("evaluateDriveEligibility: red checks hold", async () => {
  const result = await evaluateDriveEligibility(cand(5, 1), {
    async ghPrView() {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "abc",
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "fail" }];
    },
    async ghPrChecksAll() {
      return [];
    },
  });
  assert.equal(result.kind, "hold");
  if (result.kind === "hold") assert.equal(result.reason, "checks-failed");
});

test("evaluateDriveEligibility: green is eligible", async () => {
  const result = await evaluateDriveEligibility(cand(5, 1), {
    async ghPrView() {
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "abc",
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [];
    },
  });
  assert.equal(result.kind, "eligible");
});

// ---------------------------------------------------------------------------
// CLI entry: --repair requires --apply; summary surfaces holds
// ---------------------------------------------------------------------------

function planCandidate(issue: number, pr: number): MergeQueueCandidate {
  return {
    issueNumber: issue,
    prNumber: pr,
    headRefOid: `sha-${pr}`,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checksSummary: "1 required pass",
    plannedAction: "would-merge",
  };
}

function makePlanDeps(candidates: MergeQueueCandidate[]): MergeQueueDeps {
  return {
    async listMilestoneIssues() {
      return candidates.map((c) => ({
        number: c.issueNumber,
        labels: ["pipeline:ready-to-deploy"],
      }));
    },
    async getPrForIssue(issueNumber) {
      return candidates.find((x) => x.issueNumber === issueNumber)?.prNumber ?? null;
    },
    async ghPrView(pr) {
      const c = candidates.find((x) => x.prNumber === pr);
      return {
        mergeable: c?.mergeable ?? "MERGEABLE",
        mergeStateStatus: c?.mergeStateStatus ?? "CLEAN",
        headRefOid: c?.headRefOid ?? "abc",
        baseRefName: c?.baseRefName ?? "main",
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [];
    },
    log() {},
  };
}

test("CLI: --repair without --apply is usage error", async () => {
  const lines: string[] = [];
  const code = await runMergeQueueCommand(
    { milestone: "v1", repair: true },
    makePlanDeps([planCandidate(1, 10)]),
    makeDriveDeps({}),
    (m) => lines.push(m),
  );
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /--repair requires --apply/);
});

// ---------------------------------------------------------------------------
// Apply planning → drive hold/repair (regression for #675 review finding)
// Planning filters conflicted/red PRs as skips; apply must still feed them
// through drive eligibility so holds and optional repair run.
// ---------------------------------------------------------------------------

test("driveCandidatesFromPlan includes holdable plan skips, not hard skips", () => {
  const mapped = driveCandidatesFromPlan({
    candidates: [planCandidate(1, 10)],
    skips: [
      {
        issueNumber: 2,
        prNumber: 20,
        reason: "non-mergeable",
        detail: "mergeable=CONFLICTING",
      },
      {
        issueNumber: 3,
        prNumber: 30,
        reason: "checks-not-green",
        detail: "ci fail",
      },
      {
        issueNumber: 4,
        prNumber: null,
        reason: "missing-pr",
        detail: "no PR",
      },
      {
        issueNumber: 5,
        prNumber: 50,
        reason: "wrong-base",
        detail: "base=dev",
      },
      {
        issueNumber: 6,
        prNumber: 60,
        reason: "empty-head-sha",
        detail: "empty",
      },
    ],
  });
  assert.deepEqual(
    mapped.map((c) => c.prNumber),
    [10, 20, 30],
    "only green candidates + non-mergeable/checks-not-green reach drive",
  );
  assert.deepEqual(
    mapped.map((c) => c.issueNumber),
    [1, 2, 3],
  );
});

/** Plan deps that can mark some issues conflicted or red-checks at planning time. */
function makePlanDepsWithStates(
  items: Array<{
    issueNumber: number;
    prNumber: number | null;
    mergeable?: string;
    mergeStateStatus?: string;
    headRefOid?: string;
    baseRefName?: string;
    checks?: Array<{ name: string; bucket: string }>;
  }>,
): MergeQueueDeps {
  return {
    async listMilestoneIssues() {
      return items.map((i) => ({
        number: i.issueNumber,
        labels: ["pipeline:ready-to-deploy"],
      }));
    },
    async getPrForIssue(issueNumber) {
      return items.find((x) => x.issueNumber === issueNumber)?.prNumber ?? null;
    },
    async ghPrView(pr) {
      const c = items.find((x) => x.prNumber === pr);
      return {
        mergeable: c?.mergeable ?? "MERGEABLE",
        mergeStateStatus: c?.mergeStateStatus ?? "CLEAN",
        headRefOid: c?.headRefOid ?? `sha-${pr}`,
        baseRefName: c?.baseRefName ?? "main",
      };
    },
    async ghPrChecksRequired(pr) {
      const c = items.find((x) => x.prNumber === pr);
      return c?.checks ?? [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [];
    },
    log() {},
  };
}

test("CLI apply: planning-time conflicted PR reaches drive hold path (not dropped)", async () => {
  // Plan classifies #20 as non-mergeable skip and #10 as candidate. Apply must
  // still drive #20 through eligibility so a stable merge-conflict hold is recorded.
  const planDeps = makePlanDepsWithStates([
    {
      issueNumber: 1,
      prNumber: 10,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    },
    {
      issueNumber: 2,
      prNumber: 20,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    },
  ]);
  const driveDeps = makeDriveDeps({
    evaluateEligibility: (c) => {
      if (c.prNumber === 20) {
        return {
          kind: "hold",
          reason: "merge-conflict",
          summary: "mergeable=CONFLICTING mergeStateStatus=DIRTY",
          headRefOid: "sha-20",
        };
      }
      return { kind: "eligible", headRefOid: `sha-${c.prNumber}` };
    },
  });
  const lines: string[] = [];
  const code = await runMergeQueueCommand(
    { milestone: "v1", apply: true },
    planDeps,
    driveDeps,
    (m) => lines.push(m),
  );

  assert.equal(code, 1, "holds yield non-zero exit");
  assert.deepEqual(driveDeps.mergeCalls, [10], "only green PR merges");
  assert.ok(
    driveDeps.eligibilityCalls.includes(20),
    "conflicted plan-skip must reach evaluateEligibility",
  );
  assert.ok(
    driveDeps.eligibilityCalls.includes(10),
    "eligible candidate still re-gated",
  );
  const out = lines.join("\n");
  assert.match(out, /non-mergeable|CONFLICTING|DIRTY/);
  assert.match(out, /held/);
  assert.match(out, /merge-conflict/);
  assert.ok(
    !out.includes("No eligible candidates to merge") ||
      driveDeps.eligibilityCalls.includes(20),
    "must not short-circuit before driving the conflicted PR",
  );
});

test("CLI apply --repair: planning-time checks-not-green PR enters repair loop", async () => {
  const planDeps = makePlanDepsWithStates([
    {
      issueNumber: 5,
      prNumber: 50,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checks: [{ name: "ci", bucket: "fail" }],
    },
  ]);
  let repairInvokes = 0;
  const driveDeps = makeDriveDeps({
    eligibilityQueue: new Map([
      [
        50,
        [
          {
            kind: "hold",
            reason: "checks-failed",
            summary: "ci (fail)",
            headRefOid: "sha-50-pre",
          },
          {
            kind: "eligible",
            headRefOid: "sha-50-post",
          },
        ],
      ],
    ]),
    repair: {
      async resolveManagedWorktree() {
        return { path: "/tmp/managed/pipeline-50" };
      },
      async invokeRepair() {
        repairInvokes++;
        return { ok: true, detail: "fixed ci" };
      },
    },
  });
  const code = await runMergeQueueCommand(
    { milestone: "v1", apply: true, repair: true, maxRepairAttempts: 1 },
    planDeps,
    driveDeps,
    () => {},
  );

  assert.equal(code, 0, "successful repair then merge exits 0");
  assert.equal(repairInvokes, 1, "repair harness must run for plan-time red PR");
  assert.deepEqual(driveDeps.mergeCalls, [50]);
  assert.ok(
    driveDeps.eligibilityCalls.includes(50),
    "plan-time checks-not-green must not be dropped before drive",
  );
});

test("CLI dry-run: conflicted PR stays plan skip only; zero drive/merge", async () => {
  const planDeps = makePlanDepsWithStates([
    {
      issueNumber: 2,
      prNumber: 20,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    },
  ]);
  const driveDeps = makeDriveDeps({});
  const lines: string[] = [];
  const code = await runMergeQueueCommand(
    { milestone: "v1" },
    planDeps,
    driveDeps,
    (m) => lines.push(m),
  );
  assert.equal(code, 0);
  assert.equal(driveDeps.mergeCalls.length, 0);
  assert.equal(driveDeps.eligibilityCalls.length, 0);
  assert.match(lines.join("\n"), /non-mergeable/);
  assert.ok(!lines.join("\n").includes("held"), "dry-run must not record holds");
});

test("formatDriveSummary surfaces held items and remediation", () => {
  const hold = createHold({
    prNumber: 11,
    issueNumber: 2,
    reason: "checks-failed",
    summary: "ci (fail)",
    lastHeadSha: "dead",
    repairAttempts: 1,
  });
  const text = formatDriveSummary(
    {
      outcomes: [
        { prNumber: 10, issueNumber: 1, outcome: "merged" },
        {
          prNumber: 11,
          issueNumber: 2,
          outcome: "held",
          reason: "checks-failed",
          hold,
        },
        {
          prNumber: 12,
          issueNumber: 3,
          outcome: "not-attempted",
          reason: "stopped after held PR #11",
        },
      ],
      holds: [hold],
      exitCode: 1,
      stopped: true,
    },
    { milestone: "v1" },
  );
  assert.match(text, /held/);
  assert.match(text, /remediation:/);
  assert.match(text, /Outstanding holds/);
  assert.match(text, /stopped on hold \(fail-stop\)/);
  assert.match(text, /repair_attempts=1/);
});

// ---------------------------------------------------------------------------
// 6.7 Bite tests: logic is present in source
// ---------------------------------------------------------------------------

test("bite: hold module and drive encode fail-stop + re-gate", () => {
  const holdSrc = fs.readFileSync(HOLD_TS, "utf8");
  const driveSrc = fs.readFileSync(DRIVE_TS, "utf8");
  assert.ok(holdSrc.includes('"merge-conflict"'));
  assert.ok(holdSrc.includes('"checks-failed"'));
  assert.ok(driveSrc.includes("evaluateEligibility"));
  assert.ok(driveSrc.includes("held"));
  assert.ok(
    driveSrc.includes("fail-stop") || driveSrc.includes("Fail-stop"),
    "drive must document fail-stop on hold",
  );
  assert.ok(driveSrc.includes("buildMergeQueueRepairPrompt"));
  assert.ok(driveSrc.includes("realMergeQueueRepairDeps"), "production repair wiring must exist");
  // Must not introduce an auto_merge config key (prose denial of auto_merge is fine).
  assert.ok(
    !/auto_merge\s*[:=]/.test(driveSrc) && !/auto_merge\s*[:=]/.test(holdSrc),
    "must not introduce auto_merge config assignment",
  );
});

test("bite: without evaluateEligibility green path, conflict would incorrectly merge — guard present", async () => {
  // If someone removes hold classification and always merges when revalidate is
  // "eligible", this test fails by asserting zero merge on conflict fixture.
  const deps = makeDriveDeps({
    evaluateEligibility: () => ({
      kind: "hold",
      reason: "merge-conflict",
      summary: "DIRTY",
      headRefOid: "x",
    }),
  });
  await driveMergeQueue([cand(1, 1)], deps);
  assert.equal(
    deps.mergeCalls.length,
    0,
    "regression: conflict must not reach mergePr",
  );
});

// ---------------------------------------------------------------------------
// Production repair wiring (injected — no real harness/git)
// ---------------------------------------------------------------------------

function minimalCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    profile_name: "test",
    invocation: "test",
    review_mode: "prompt-harness",
    marker_footer: "",
    implementation_ready_message: "",
    conventions_default: "",
    domain: "test",
    repo: "o/r",
    repo_dir: "/tmp/repo",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 4,
    auto_recovery_max_retries: 1,
    implementation_timeout: 60,
    review_timeout: 60,
    plan_review_timeout: 60,
    fix_timeout: 120,
    intake_timeout: 60,
    sweep_timeout: 60,
    ci_timeout: 60,
    ci_poll_interval: 5,
    ci_no_run_grace_s: 0,
    ci_mode: "github",
    pre_merge_ci_assertion_fix: false,
    pre_merge_ci_rerun_enabled: true,
    harnesses: {
      implementer: "codex",
      reviewer: "claude",
      implementerSource: "profile",
      reviewerSource: "profile",
    },
    models: {
      planning: "m",
      implementing: "m",
      review: "m",
      fix: "m",
      intake: "m",
      sweep: "m",
    },
    effort: {},
    ...overrides,
  } as PipelineConfig;
}

test("realMergeQueueRepairDeps: resolves managed worktree and invokes harness", async () => {
  let resolveIssue: number | null = null;
  let invokeArgs: { harness: string; cwd: string; prompt: string } | null = null;
  const repair = realMergeQueueRepairDeps(minimalCfg(), {
    async getOnDiskForIssue(_cfg, issueNumber) {
      resolveIssue = issueNumber;
      return { path: "/managed/wt-7", slug: "slug" };
    },
    async invokeFn(harness, worktreeDir, prompt) {
      invokeArgs = { harness, cwd: worktreeDir, prompt };
      return {
        success: true,
        stdout: "",
        stderr: "",
        exit_code: 0,
        duration: 1,
        timed_out: false,
      };
    },
  });
  const wt = await repair.resolveManagedWorktree(cand(42, 7));
  assert.deepEqual(wt, { path: "/managed/wt-7" });
  assert.equal(resolveIssue, 7);
  const result = await repair.invokeRepair({
    candidate: cand(42, 7),
    holdReason: "merge-conflict",
    summary: "DIRTY",
    worktreePath: "/managed/wt-7",
    lastHeadSha: "abc",
    prompt: "surgical repair prompt",
  });
  assert.equal(result.ok, true);
  assert.equal(invokeArgs?.harness, "codex");
  assert.equal(invokeArgs?.cwd, "/managed/wt-7");
  assert.equal(invokeArgs?.prompt, "surgical repair prompt");
});

test("realMergeQueueRepairDeps: missing worktree returns null without invoke", async () => {
  let invokeCalls = 0;
  const repair = realMergeQueueRepairDeps(minimalCfg(), {
    async getOnDiskForIssue() {
      return null;
    },
    async invokeFn() {
      invokeCalls++;
      return {
        success: true,
        stdout: "",
        stderr: "",
        exit_code: 0,
        duration: 0,
        timed_out: false,
      };
    },
  });
  assert.equal(await repair.resolveManagedWorktree(cand(1, 1)), null);
  assert.equal(invokeCalls, 0);
});

test("realDriveDeps: threads expectedBaseBranch into mergePr gate", async () => {
  const mergeCalls: number[] = [];
  const viewedFields: string[][] = [];
  const mergeDeps: MergeDeps = {
    async ghPrView(_pr, fields) {
      viewedFields.push([...fields]);
      return {
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "head-sha",
        baseRefName: "staging", // retargeted off expected main
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [{ name: "ci", bucket: "pass" }];
    },
    async ghPrMerge(pr) {
      mergeCalls.push(pr);
    },
    async getIssueLabels() {
      return ["pipeline:ready-to-deploy"];
    },
    async getPrLinkedIssue() {
      return 1;
    },
    async getPrForIssue() {
      return 10;
    },
    log() {},
  };
  const drive = realDriveDeps("o/r", mergeDeps, undefined, {
    expectedBaseBranch: "main",
  });
  // Eligibility rejects wrong base without merge.
  const elig = await drive.evaluateEligibility(cand(10, 1));
  assert.equal(elig.kind, "ineligible");
  // Direct merge path also rejects retarget (immediately-pre-merge gate).
  await assert.rejects(
    () => drive.mergePr(10),
    (err: Error) => {
      assert.match(err.message, /base branch mismatch|baseRefName/);
      return true;
    },
  );
  assert.equal(mergeCalls.length, 0, "must not merge after base retarget at merge gate");
  assert.ok(
    viewedFields.some((f) => f.includes("baseRefName")),
    "merge gate must request baseRefName when expected base is set",
  );
});
