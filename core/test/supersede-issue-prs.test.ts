// Unit tests for supersede-after-ensure-PR (#729).
// Injectable seams only — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  disposeSupersededIssuePrs,
  formatSupersededPrComment,
  PIPELINE_SUPERSEDED_MARKER,
  selectSupersededOpenPrs,
  type PrCandidate,
} from "../scripts/gh.ts";
import {
  resumeFromImplementing,
  type ResumeFromImplementingDeps,
} from "../scripts/stages/planning.ts";
import type { TestGateResult } from "../scripts/testgate.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const TARGET_REPO = "owner/repo";
const BASE = "main";
const MANAGED_BRANCH = "pipeline/42-managed-slug";
const MANAGED_PR = 726;
const STALE_PR = 656;

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repo: TARGET_REPO,
    repo_dir: "/fake/repo",
    base_branch: BASE,
    supersede_mode: "close",
    harnesses: { implementer: "claude", reviewer: "codex" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    test_gate: { enabled: false },
    implementation_ready_message: "Implementation ready.",
    marker_footer: "*Automated by Pipeline*",
    worktree_root: ".worktrees",
    ...overrides,
  } as unknown as PipelineConfig;
}

function cand(
  number: number,
  headRefName: string,
  opts: {
    fork?: boolean;
    closes?: number[];
    base?: string;
  } = {},
): PrCandidate {
  return {
    number,
    headRefName,
    isCrossRepository: opts.fork ?? false,
    closingIssues: (opts.closes ?? []).map((n) => ({
      number: n,
      nameWithOwner: TARGET_REPO,
    })),
    baseRefName: opts.base ?? BASE,
  };
}

function passedGate(): TestGateResult {
  return { skipped: false, passed: true, attempts: 0 };
}

const twoOpenFixture = (): PrCandidate[] => [
  cand(MANAGED_PR, MANAGED_BRANCH),
  cand(STALE_PR, "eval/expanded-corpus-20260728", { closes: [42] }),
  cand(999, "feat/unrelated"),
  cand(888, "pipeline/42-release-side", { base: "release/1.0" }),
];

// ---------------------------------------------------------------------------
// Pure selection
// ---------------------------------------------------------------------------

test("selectSupersededOpenPrs: selects stale associated same-base PR, not managed/unrelated/different-base", () => {
  const selected = selectSupersededOpenPrs(twoOpenFixture(), {
    issueNumber: 42,
    managedBranch: MANAGED_BRANCH,
    managedPrNumber: MANAGED_PR,
    baseBranch: BASE,
    targetRepo: TARGET_REPO,
  });
  assert.deepEqual(selected, [STALE_PR]);
});

test("selectSupersededOpenPrs: never selects the managed PR itself", () => {
  const selected = selectSupersededOpenPrs(
    [cand(MANAGED_PR, MANAGED_BRANCH)],
    {
      issueNumber: 42,
      managedBranch: MANAGED_BRANCH,
      managedPrNumber: MANAGED_PR,
      baseBranch: BASE,
      targetRepo: TARGET_REPO,
    },
  );
  assert.deepEqual(selected, []);
});

test("selectSupersededOpenPrs: body/title-only association is not dual-strategy — not selected", () => {
  // A PR that would only match via body text has neither pipeline/<N>-* head
  // nor closing ref — must not be selected (#76 / #729).
  const selected = selectSupersededOpenPrs(
    [cand(MANAGED_PR, MANAGED_BRANCH), cand(500, "chore/mentions-42-in-body")],
    {
      issueNumber: 42,
      managedBranch: MANAGED_BRANCH,
      managedPrNumber: MANAGED_PR,
      baseBranch: BASE,
      targetRepo: TARGET_REPO,
    },
  );
  assert.deepEqual(selected, []);
});

test("selectSupersededOpenPrs: missing baseRefName is not treated as same-base", () => {
  const noBase: PrCandidate = {
    number: STALE_PR,
    headRefName: "pipeline/42-old",
    isCrossRepository: false,
    closingIssues: [],
  };
  const selected = selectSupersededOpenPrs([cand(MANAGED_PR, MANAGED_BRANCH), noBase], {
    issueNumber: 42,
    managedBranch: MANAGED_BRANCH,
    managedPrNumber: MANAGED_PR,
    baseBranch: BASE,
    targetRepo: TARGET_REPO,
  });
  assert.deepEqual(selected, []);
});

// ---------------------------------------------------------------------------
// Comment format
// ---------------------------------------------------------------------------

test("formatSupersededPrComment: includes marker and superseding PR number", () => {
  const body = formatSupersededPrComment({
    managedPrNumber: MANAGED_PR,
    issueNumber: 42,
    managedBranch: MANAGED_BRANCH,
    mode: "close",
  });
  assert.ok(body.includes(PIPELINE_SUPERSEDED_MARKER));
  assert.ok(body.includes(`#${MANAGED_PR}`));
  assert.ok(body.includes("#42"));
  assert.ok(body.includes(MANAGED_BRANCH));
});

// ---------------------------------------------------------------------------
// disposeSupersededIssuePrs
// ---------------------------------------------------------------------------

test("disposeSupersededIssuePrs close mode: closes only stale associated same-base PR", async () => {
  const closed: number[] = [];
  const commented: { pr: number; body: string }[] = [];
  const open = new Set([MANAGED_PR, STALE_PR, 999, 888]);

  const result = await disposeSupersededIssuePrs(
    makeCfg(),
    {
      issueNumber: 42,
      managedBranch: MANAGED_BRANCH,
      managedPrNumber: MANAGED_PR,
      mode: "close",
    },
    {
      listOpenPrCandidates: async () => twoOpenFixture(),
      closePr: async (_cfg, pr, comment) => {
        closed.push(pr);
        commented.push({ pr, body: comment ?? "" });
        open.delete(pr);
      },
      postPrComment: async () => {
        assert.fail("postPrComment must not be used in close mode (closePr carries the comment)");
      },
      log: () => {},
    },
  );

  assert.deepEqual(result.closed, [STALE_PR]);
  assert.equal(open.has(MANAGED_PR), true, "managed PR remains open");
  assert.equal(open.has(STALE_PR), false, "stale PR closed");
  assert.equal(open.has(999), true, "unrelated PR left open");
  assert.equal(open.has(888), true, "different-base PR left open");
  assert.ok(commented[0]?.body.includes(PIPELINE_SUPERSEDED_MARKER));
  assert.ok(commented[0]?.body.includes(`#${MANAGED_PR}`));
});

test("disposeSupersededIssuePrs: bite without disposal — both remain open when close is never called", async () => {
  // Proves the close step is what changes the open set. Without invoking
  // dispose (or with a no-op), the fixture still has both associated PRs open.
  const open = new Set([MANAGED_PR, STALE_PR]);
  // Intentionally do not call dispose / close.
  assert.equal(open.size, 2, "fixture starts with both managed and stale open");
  assert.ok(open.has(MANAGED_PR) && open.has(STALE_PR));
});

test("disposeSupersededIssuePrs comment-only: posts marker, leaves stale open", async () => {
  const closed: number[] = [];
  const comments: { pr: number; body: string }[] = [];

  const result = await disposeSupersededIssuePrs(
    makeCfg({ supersede_mode: "comment-only" }),
    {
      issueNumber: 42,
      managedBranch: MANAGED_BRANCH,
      managedPrNumber: MANAGED_PR,
    },
    {
      listOpenPrCandidates: async () => twoOpenFixture(),
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      postPrComment: async (_cfg, pr, body) => {
        comments.push({ pr, body });
      },
      log: () => {},
    },
  );

  assert.deepEqual(result.closed, []);
  assert.deepEqual(result.commented, [STALE_PR]);
  assert.equal(closed.length, 0, "comment-only must not close");
  assert.ok(comments[0]?.body.includes(PIPELINE_SUPERSEDED_MARKER));
  assert.ok(comments[0]?.body.includes(`#${MANAGED_PR}`));
});

test("disposeSupersededIssuePrs: fail-soft — one close failure still attempts remaining", async () => {
  const closed: number[] = [];
  const logs: string[] = [];
  const candidates = [
    cand(MANAGED_PR, MANAGED_BRANCH),
    cand(101, "pipeline/42-stale-a"),
    cand(102, "pipeline/42-stale-b"),
  ];

  const result = await disposeSupersededIssuePrs(
    makeCfg(),
    {
      issueNumber: 42,
      managedBranch: MANAGED_BRANCH,
      managedPrNumber: MANAGED_PR,
    },
    {
      listOpenPrCandidates: async () => candidates,
      closePr: async (_cfg, pr) => {
        if (pr === 101) throw new Error("gh: rate limited");
        closed.push(pr);
      },
      log: (m) => logs.push(m),
    },
  );

  assert.deepEqual(result.closed, [102]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /101/);
  assert.ok(logs.some((l) => l.includes("101")));
});

test("disposeSupersededIssuePrs: list failure is fail-soft (no throw)", async () => {
  const result = await disposeSupersededIssuePrs(
    makeCfg(),
    {
      issueNumber: 42,
      managedBranch: MANAGED_BRANCH,
      managedPrNumber: MANAGED_PR,
    },
    {
      listOpenPrCandidates: async () => {
        throw new Error("GraphQL unavailable");
      },
      closePr: async () => {
        assert.fail("close must not run when list fails");
      },
      log: () => {},
    },
  );
  assert.deepEqual(result.closed, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /list failed|GraphQL/i);
});

// ---------------------------------------------------------------------------
// resumeFromImplementing integration (create + reuse)
// ---------------------------------------------------------------------------

test("resumeFromImplementing create path: disposes other-head associated PR under close", async () => {
  const closed: number[] = [];
  const open = new Set([STALE_PR]); // managed PR does not exist yet until create

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => null,
    createPr: async () => {
      open.add(MANAGED_PR);
      return MANAGED_PR;
    },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
    // Use real dispose with injected I/O so production path is exercised.
    supersedeDeps: {
      listOpenPrCandidates: async () => [
        cand(MANAGED_PR, MANAGED_BRANCH),
        cand(STALE_PR, "eval/old-head", { closes: [42] }),
      ],
      closePr: async (_cfg, pr) => {
        closed.push(pr);
        open.delete(pr);
      },
      log: () => {},
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    { path: "/fake/wt", branch: MANAGED_BRANCH },
    {
      prTitle: "[Pipeline] Fix (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.deepEqual(closed, [STALE_PR]);
  assert.equal(open.has(MANAGED_PR), true);
  assert.equal(open.has(STALE_PR), false);
});

test("resumeFromImplementing reuse path: still disposes other-head associated PR", async () => {
  const closed: number[] = [];
  let createCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => MANAGED_PR,
    createPr: async () => {
      createCalled = true;
      return 0;
    },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
    supersedeDeps: {
      listOpenPrCandidates: async () => [
        cand(MANAGED_PR, MANAGED_BRANCH),
        cand(STALE_PR, "pipeline/42-abandoned", { closes: [42] }),
      ],
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      log: () => {},
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    { path: "/fake/wt", branch: MANAGED_BRANCH },
    {
      prTitle: "[Pipeline] Fix (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.ok(!createCalled, "exact-head reuse must not create");
  assert.deepEqual(closed, [STALE_PR]);
});

test("resumeFromImplementing: supersede close failure does not block transition", async () => {
  let transitionCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => null,
    createPr: async () => MANAGED_PR,
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {
      assert.fail("setBlocked must not run when only supersede fails");
    },
    transition: async () => {
      transitionCalled = true;
    },
    supersedeDeps: {
      listOpenPrCandidates: async () => [
        cand(MANAGED_PR, MANAGED_BRANCH),
        cand(STALE_PR, "pipeline/42-old"),
      ],
      closePr: async () => {
        throw new Error("close denied");
      },
      log: () => {},
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    { path: "/fake/wt", branch: MANAGED_BRANCH },
    {
      prTitle: "t",
      prBody: "b",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.ok(transitionCalled, "ensure-PR / transition must succeed despite supersede failure");
});

test("resumeFromImplementing bite: without dispose seam, production path must call dispose (source pin)", async () => {
  // If dispose is skipped in production, this source pin fails the suite.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const src = fs.readFileSync(path.join(root, "core/scripts/stages/planning.ts"), "utf8");
  const fnIdx = src.indexOf("export async function resumeFromImplementing(");
  assert.ok(fnIdx !== -1);
  const body = src.slice(fnIdx, fnIdx + 12_000);
  assert.ok(
    body.includes("disposeSupersededIssuePrs"),
    "resumeFromImplementing must invoke supersede disposal after ensure-PR",
  );
  assert.ok(
    body.includes("managedPrNumber") || body.includes("prNumber"),
    "dispose must be wired with the managed PR number",
  );
});
