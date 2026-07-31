// Tests for merge-queue sequential drive (#674).
//
// All tests are network- and subprocess-free: I/O is injected via DriveDeps /
// MergeQueueDeps. Loop-isolation asserts advance never imports drive.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  driveMergeQueue,
  revalidateDriveCandidate,
  formatDriveSummary,
  candidatesFromPlan,
  runMergeQueueCommand,
  type DriveCandidate,
  type DriveDeps,
  type DriveEligibility,
  type DriveRevalidation,
} from "../scripts/stages/merge_queue_drive.ts";
import type { MergeQueueCandidate, MergeQueueDeps } from "../scripts/stages/merge_queue.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGES_DIR = path.join(__dirname, "..", "scripts", "stages");
const PIPELINE_RUN_TS = path.join(__dirname, "..", "scripts", "pipeline-run.ts");
const PIPELINE_TS = path.join(__dirname, "..", "scripts", "pipeline.ts");
const DRIVE_TS = path.join(STAGES_DIR, "merge_queue_drive.ts");

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
  mergeImpl?: (pr: number) => Promise<void>;
  onMergeStart?: (pr: number, active: number) => void;
  repair?: DriveDeps["repair"];
}): DriveDeps & {
  mergeCalls: number[];
  revalidateCalls: number[];
  eligibilityCalls: number[];
} {
  const mergeCalls: number[] = [];
  const revalidateCalls: number[] = [];
  const eligibilityCalls: number[] = [];
  let activeMerges = 0;
  let maxConcurrent = 0;

  const deps: DriveDeps & {
    mergeCalls: number[];
    revalidateCalls: number[];
    eligibilityCalls: number[];
    maxConcurrent: number;
  } = {
    mergeCalls,
    revalidateCalls,
    eligibilityCalls,
    maxConcurrent: 0,
    async revalidate(c) {
      revalidateCalls.push(c.prNumber);
      if (opts.revalidate) return opts.revalidate(c);
      return { kind: "eligible" };
    },
    async evaluateEligibility(c) {
      eligibilityCalls.push(c.prNumber);
      if (opts.evaluateEligibility) return opts.evaluateEligibility(c);
      // Default: fully eligible so existing #674 order tests keep working.
      return { kind: "eligible", headRefOid: `sha-${c.prNumber}` };
    },
    async mergePr(pr) {
      activeMerges++;
      maxConcurrent = Math.max(maxConcurrent, activeMerges);
      deps.maxConcurrent = maxConcurrent;
      opts.onMergeStart?.(pr, activeMerges);
      mergeCalls.push(pr);
      try {
        if (opts.mergeImpl) await opts.mergeImpl(pr);
      } finally {
        activeMerges--;
      }
    },
    repair: opts.repair,
    log() {},
  };
  return deps;
}

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

function makePlanDeps(candidates: MergeQueueCandidate[]): MergeQueueDeps & {
  listCalls: number;
} {
  const deps: MergeQueueDeps & { listCalls: number } = {
    listCalls: 0,
    async listMilestoneIssues() {
      deps.listCalls++;
      // Return synthetic issues matching candidates so plan rebuilds the list.
      return candidates.map((c) => ({
        number: c.issueNumber,
        labels: ["pipeline:ready-to-deploy"],
      }));
    },
    async getPrForIssue(issueNumber) {
      const c = candidates.find((x) => x.issueNumber === issueNumber);
      return c?.prNumber ?? null;
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
  return deps;
}

// ---------------------------------------------------------------------------
// 4.1 Sequential single-flight order
// ---------------------------------------------------------------------------

test("drive: two candidates merge in order; second starts only after first settles", async () => {
  const order: string[] = [];
  let firstResolve!: () => void;
  const firstGate = new Promise<void>((r) => {
    firstResolve = r;
  });

  const deps = makeDriveDeps({
    async mergeImpl(pr) {
      order.push(`start-${pr}`);
      if (pr === 10) {
        await firstGate;
      }
      order.push(`end-${pr}`);
    },
  });

  const run = driveMergeQueue([cand(10, 1), cand(11, 2)], deps);
  // Let the first merge start and park on the gate.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(deps.mergeCalls, [10], "only first merge started");
  assert.equal(deps.maxConcurrent, 1);
  firstResolve();
  const result = await run;

  assert.equal(result.exitCode, 0);
  assert.deepEqual(deps.mergeCalls, [10, 11]);
  assert.equal(deps.maxConcurrent, 1, "never two concurrent merges");
  assert.deepEqual(order, ["start-10", "end-10", "start-11", "end-11"]);
  assert.deepEqual(
    result.outcomes.map((o) => o.outcome),
    ["merged", "merged"],
  );
});

test("drive: does not schedule a parallel merge pool", async () => {
  const deps = makeDriveDeps({
    async mergeImpl() {
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  await driveMergeQueue([cand(1, 1), cand(2, 2), cand(3, 3)], deps);
  assert.equal(deps.maxConcurrent, 1);
  assert.deepEqual(deps.mergeCalls, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// 4.2 Apply gating
// ---------------------------------------------------------------------------

test("drive entry: without --apply, zero merge calls", async () => {
  const planDeps = makePlanDeps([planCandidate(1, 10), planCandidate(2, 11)]);
  const driveDeps = makeDriveDeps({});
  const lines: string[] = [];
  const code = await runMergeQueueCommand(
    { milestone: "v1" },
    planDeps,
    driveDeps,
    (m) => lines.push(m),
  );
  assert.equal(code, 0);
  assert.equal(driveDeps.mergeCalls.length, 0, "dry-run must not call mergePr");
  assert.equal(driveDeps.revalidateCalls.length, 0);
  assert.ok(lines.join("\n").includes("would-merge") || lines.join("\n").includes("candidate"));
});

test("drive entry: with --apply, sequential merge calls in list order", async () => {
  const planDeps = makePlanDeps([planCandidate(1, 10), planCandidate(2, 11)]);
  const driveDeps = makeDriveDeps({});
  const code = await runMergeQueueCommand(
    { milestone: "v1", apply: true },
    planDeps,
    driveDeps,
    () => {},
  );
  assert.equal(code, 0);
  assert.deepEqual(driveDeps.mergeCalls, [10, 11]);
});

test("drive entry: --apply without driveDeps fails closed with zero merges", async () => {
  const planDeps = makePlanDeps([planCandidate(1, 10)]);
  const code = await runMergeQueueCommand(
    { milestone: "v1", apply: true },
    planDeps,
    undefined,
    () => {},
  );
  assert.equal(code, 1);
  assert.equal(planDeps.listCalls, 0, "must not plan when drive deps missing");
});

test("drive entry: --apply and --dry-run conflict", async () => {
  const planDeps = makePlanDeps([planCandidate(1, 10)]);
  const driveDeps = makeDriveDeps({});
  const code = await runMergeQueueCommand(
    { milestone: "v1", apply: true, dryRun: true },
    planDeps,
    driveDeps,
    () => {},
  );
  assert.equal(code, 2);
  assert.equal(driveDeps.mergeCalls.length, 0);
  assert.equal(planDeps.listCalls, 0);
});

// ---------------------------------------------------------------------------
// 4.3 Already-done skip continues
// ---------------------------------------------------------------------------

test("drive: already-done skip continues to next candidate", async () => {
  const deps = makeDriveDeps({
    revalidate: async (c) => {
      if (c.prNumber === 10) {
        return { kind: "already-done", reason: "already merged" };
      }
      return { kind: "eligible" };
    },
  });
  const result = await driveMergeQueue([cand(10, 1), cand(11, 2)], deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(deps.mergeCalls, [11], "only second candidate merged");
  assert.equal(result.outcomes[0].outcome, "skipped-already-done");
  assert.equal(result.outcomes[1].outcome, "merged");
});

// ---------------------------------------------------------------------------
// 4.4 Hard revalidation fail-stop
// ---------------------------------------------------------------------------

test("drive: hard revalidation failure fail-stops; later not-attempted", async () => {
  const deps = makeDriveDeps({
    revalidate: async (c) => {
      if (c.prNumber === 10) {
        return { kind: "ineligible", reason: "checks not green" };
      }
      return { kind: "eligible" };
    },
  });
  const result = await driveMergeQueue(
    [cand(10, 1), cand(11, 2), cand(12, 3)],
    deps,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(deps.mergeCalls, [], "must not merge on hard revalidation fail");
  assert.equal(result.outcomes[0].outcome, "failed");
  assert.equal(result.outcomes[1].outcome, "not-attempted");
  assert.equal(result.outcomes[2].outcome, "not-attempted");
  assert.ok(!deps.revalidateCalls.includes(11), "must not revalidate after stop");
});

// ---------------------------------------------------------------------------
// 4.5 mergePr throw fail-stop
// ---------------------------------------------------------------------------

test("drive: mergePr throw for conflict holds and fail-stops", async () => {
  // Conflict/checks refusals from mergePr become holds and stop the queue.
  const deps = makeDriveDeps({
    mergeImpl: async (pr) => {
      if (pr === 10) {
        throw new Error(
          "PR has merge conflicts (mergeable: CONFLICTING). Resolve the conflicts.",
        );
      }
    },
  });
  const result = await driveMergeQueue([cand(10, 1), cand(11, 2)], deps);
  assert.equal(result.exitCode, 1, "holds leave non-zero exit for operator attention");
  assert.equal(result.stopped, true, "hold is a fail-stop queue point");
  assert.deepEqual(deps.mergeCalls, [10], "later candidates must not merge after hold");
  assert.equal(result.outcomes[0].outcome, "held");
  assert.equal(result.outcomes[0].hold?.reason, "merge-conflict");
  assert.equal(result.outcomes[1].outcome, "not-attempted");
});

test("drive: mergePr throw for non-hold error still fail-stops", async () => {
  const deps = makeDriveDeps({
    mergeImpl: async (pr) => {
      if (pr === 10) throw new Error("gh pr merge failed: API rate limit");
    },
  });
  const result = await driveMergeQueue([cand(10, 1), cand(11, 2)], deps);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(deps.mergeCalls, [10]);
  assert.equal(result.outcomes[0].outcome, "failed");
  assert.equal(result.outcomes[1].outcome, "not-attempted");
});

// ---------------------------------------------------------------------------
// 4.6 Successful full walk
// ---------------------------------------------------------------------------

test("drive: successful full walk merges all eligible candidates in order", async () => {
  const deps = makeDriveDeps({});
  const result = await driveMergeQueue(
    [cand(10, 1), cand(11, 2), cand(12, 3)],
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stopped, false);
  assert.deepEqual(deps.mergeCalls, [10, 11, 12]);
  assert.ok(result.outcomes.every((o) => o.outcome === "merged"));
});

// ---------------------------------------------------------------------------
// 4.7 Uses mergePr dep (not a bypass); revalidate already-done from gh fields
// ---------------------------------------------------------------------------

test("drive: merges only via deps.mergePr (recorded merge dep)", async () => {
  const src = fs.readFileSync(DRIVE_TS, "utf8");
  // Production path must call mergePr from merge.ts; must not shell gh pr merge directly.
  assert.ok(
    src.includes('from "./merge.ts"') || src.includes("from './merge.ts'"),
    "drive must import merge.ts for the shared merge surface",
  );
  assert.ok(
    !/execFile\([^)]*pr["']?\s*,\s*["']merge/.test(src),
    "drive must not shell gh pr merge directly",
  );
  assert.ok(
    src.includes("mergePr(pr, mergeDeps)") || src.includes("mergePr(pr,"),
    "realDriveDeps must call mergePr(pr, mergeDeps)",
  );
});

test("revalidateDriveCandidate: MERGED is already-done", async () => {
  const result = await revalidateDriveCandidate(cand(42, 7), {
    async ghPrView() {
      return { state: "MERGED", mergedAt: "2026-07-30T12:00:00Z" };
    },
  });
  assert.equal(result.kind, "already-done");
});

test("revalidateDriveCandidate: CLOSED is already-done", async () => {
  const result = await revalidateDriveCandidate(cand(42, 7), {
    async ghPrView() {
      return { state: "CLOSED", mergedAt: null };
    },
  });
  assert.equal(result.kind, "already-done");
});

test("revalidateDriveCandidate: OPEN is eligible", async () => {
  const result = await revalidateDriveCandidate(cand(42, 7), {
    async ghPrView() {
      return { state: "OPEN", mergedAt: null };
    },
  });
  assert.equal(result.kind, "eligible");
});

test("candidatesFromPlan maps plan candidates", () => {
  const mapped = candidatesFromPlan([planCandidate(5, 50), planCandidate(6, 60)]);
  assert.deepEqual(mapped, [
    { prNumber: 50, issueNumber: 5 },
    { prNumber: 60, issueNumber: 6 },
  ]);
});

test("formatDriveSummary lists outcomes", () => {
  const text = formatDriveSummary(
    {
      outcomes: [
        { prNumber: 10, issueNumber: 1, outcome: "merged" },
        {
          prNumber: 11,
          issueNumber: 2,
          outcome: "failed",
          reason: "API error",
        },
        {
          prNumber: 12,
          issueNumber: 3,
          outcome: "not-attempted",
          reason: "stopped after PR #11",
        },
      ],
      holds: [],
      exitCode: 1,
      stopped: true,
    },
    { milestone: "v1", repo: "o/r" },
  );
  assert.match(text, /drive summary/);
  assert.match(text, /merged/);
  assert.match(text, /failed/);
  assert.match(text, /not-attempted/);
  assert.match(text, /stopped on hard failure/);
});

// ---------------------------------------------------------------------------
// Loop isolation
// ---------------------------------------------------------------------------

test("drive: loop-isolation — no advance stage handler imports merge_queue_drive", () => {
  const stageFiles = fs.readdirSync(STAGES_DIR).filter((f) => f.endsWith(".ts"));
  const exempt = new Set([
    "merge_queue_drive.ts",
    "merge_queue.ts",
    "merge_queue_hold.ts",
    "merge.ts",
  ]);
  for (const file of stageFiles.filter((f) => !exempt.has(f))) {
    const content = fs.readFileSync(path.join(STAGES_DIR, file), "utf8");
    assert.ok(
      !content.includes("merge_queue_drive") && !content.includes("driveMergeQueue"),
      `Stage handler ${file} must not import merge_queue_drive (#674)`,
    );
  }
});

test("drive: loop-isolation — dispatch() does not call drive or mergePr", () => {
  const content = fs.readFileSync(PIPELINE_RUN_TS, "utf8");
  const dispatchStart = content.indexOf("export async function dispatch(");
  assert.ok(dispatchStart !== -1);
  const openBrace = content.indexOf("{", dispatchStart);
  let depth = 0;
  let dispatchEnd = openBrace;
  for (let i = openBrace; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) {
        dispatchEnd = i;
        break;
      }
    }
  }
  const body = content.slice(dispatchStart, dispatchEnd + 1);
  assert.ok(!body.includes("mergePr"), "dispatch must not call mergePr");
  assert.ok(
    !body.includes("driveMergeQueue") && !body.includes("merge_queue_drive"),
    "dispatch must not call merge-queue drive",
  );
});

test("drive: pipeline.ts only reaches drive from merge-queue command path", () => {
  const content = fs.readFileSync(PIPELINE_TS, "utf8");
  // Import is fine at top level; ensure advance-related symbols aren't called outside merge-queue block.
  assert.ok(
    content.includes("runMergeQueueCommand") || content.includes("realDriveDeps"),
    "pipeline CLI must wire drive for merge-queue",
  );
  // No auto_merge config key introduced by this module.
  assert.ok(
    !content.includes("auto_merge"),
    "pipeline.ts must not introduce auto_merge",
  );
});

test("drive: pipeline.ts rejects --apply with --dry-run before branching", () => {
  const content = fs.readFileSync(PIPELINE_TS, "utf8");
  // Must not route apply&&dry-run into dry-run success via `apply && !dryRun`.
  assert.ok(
    content.includes("cannot combine --apply and --dry-run"),
    "main() must validate mutually exclusive --apply and --dry-run",
  );
  assert.ok(
    !/const applying = !!opts\.apply && !opts\.dryRun/.test(content),
    "must not silently demote --apply --dry-run to plan-only success",
  );
});

test("drive: pipeline.ts wires production repair deps when --repair is set", () => {
  const content = fs.readFileSync(PIPELINE_TS, "utf8");
  assert.ok(
    content.includes("realMergeQueueRepairDeps"),
    "CLI must import production repair wiring",
  );
  assert.ok(
    /realMergeQueueRepairDeps\s*\(\s*mqCfg\s*\)/.test(content) ||
      content.includes("realMergeQueueRepairDeps(mqCfg)"),
    "CLI must construct repair hooks from config when --repair is set",
  );
  // Must not pass a hard-coded undefined repair when repair flag is present.
  assert.ok(
    !/realDriveDeps\([^)]*undefined,\s*\{\s*expectedBaseBranch/.test(content),
    "must not always pass undefined repair into realDriveDeps",
  );
});

test("drive: merge.test loop-isolation still holds for non-drive stage handlers", () => {
  // Human-only merge-queue modules may import merge.ts; advance stages must not.
  const stageFiles = fs.readdirSync(STAGES_DIR).filter((f) => f.endsWith(".ts"));
  const allowedImportMerge = new Set([
    "merge.ts",
    // #673/#674 underscore modules + #676 hyphenated drive surface on main.
    "merge_queue.ts",
    "merge_queue_drive.ts",
    "merge_queue_hold.ts",
    "merge-queue.ts",
    "merge-queue-release-when-complete.ts",
  ]);
  // Precise match for merge.ts — not merge_queue*.ts.
  const mergeImport =
    /from\s+["']\.\/merge(?:\.ts)?["']|from\s+["']\.\.\/stages\/merge(?:\.ts)?["']/;
  for (const file of stageFiles) {
    if (allowedImportMerge.has(file)) continue;
    const content = fs.readFileSync(path.join(STAGES_DIR, file), "utf8");
    assert.ok(
      !mergeImport.test(content),
      `Stage handler ${file} must not import merge.ts`,
    );
  }
});
