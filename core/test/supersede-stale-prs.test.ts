// Regression tests for supersede-stale-issue-prs (#729).
//
// Injectable seams only — no real network, git, or subprocess as the sole pass path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrCandidate } from "../scripts/gh.ts";
import {
  buildSupersededComment,
  electManagedPrWinner,
  selectSupersedeCandidates,
  supersedeStaleIssuePrs,
  type SupersedeStaleIssuePrsDeps,
} from "../scripts/supersede-stale-prs.ts";
import {
  resumeFromImplementing,
  type ResumeFromImplementingDeps,
} from "../scripts/stages/planning.ts";
import type { TestGateResult } from "../scripts/testgate.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET_REPO = "owner/repo";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repo: TARGET_REPO,
    repo_dir: "/fake/repo",
    base_branch: "main",
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
    baseRefName: opts.base ?? "main",
  };
}

function passedGate(): TestGateResult {
  return { skipped: false, passed: true, attempts: 0 };
}

// ---------------------------------------------------------------------------
// Pure filter
// ---------------------------------------------------------------------------

test("selectSupersedeCandidates: closes only dual-linked non-managed same-base heads", () => {
  const managed = cand(726, "pipeline/601-new-slug");
  const stalePipeline = cand(100, "pipeline/601-old-slug");
  const staleClosing = cand(656, "eval/expanded-corpus", { closes: [601] });
  const selected = selectSupersedeCandidates(
    [managed, stalePipeline, staleClosing],
    {
      issueNumber: 601,
      managedPrNumber: 726,
      managedBranch: "pipeline/601-new-slug",
      targetRepo: TARGET_REPO,
      baseBranch: "main",
    },
  );
  assert.deepEqual(
    selected.map((p) => p.number).sort((a, b) => a - b),
    [100, 656],
  );
});

test("selectSupersedeCandidates: body-only mention (no dual link) is not a candidate", () => {
  // PR that merely "mentions" #601 has no closing ref and no pipeline/601- head.
  const bodyOnly = cand(50, "docs/mention-601");
  const selected = selectSupersedeCandidates([bodyOnly], {
    issueNumber: 601,
    managedPrNumber: 726,
    managedBranch: "pipeline/601-new-slug",
    targetRepo: TARGET_REPO,
    baseBranch: "main",
  });
  assert.deepEqual(selected, []);
});

test("selectSupersedeCandidates: different base is not a candidate", () => {
  const backport = cand(80, "pipeline/601-backport", { base: "release/1.0" });
  const selected = selectSupersedeCandidates([backport], {
    issueNumber: 601,
    managedPrNumber: 726,
    managedBranch: "pipeline/601-new-slug",
    targetRepo: TARGET_REPO,
    baseBranch: "main",
  });
  assert.deepEqual(selected, []);
});

test("selectSupersedeCandidates: fork cannot spoof pipeline branch prefix", () => {
  const spoof = cand(13, "pipeline/601-spoofed", { fork: true });
  const selected = selectSupersedeCandidates([spoof], {
    issueNumber: 601,
    managedPrNumber: 726,
    managedBranch: "pipeline/601-new-slug",
    targetRepo: TARGET_REPO,
    baseBranch: "main",
  });
  assert.deepEqual(selected, []);
});

test("selectSupersedeCandidates: managed head PR is never self-superseded", () => {
  const managed = cand(726, "pipeline/601-new-slug");
  const selected = selectSupersedeCandidates([managed], {
    issueNumber: 601,
    managedPrNumber: 726,
    managedBranch: "pipeline/601-new-slug",
    targetRepo: TARGET_REPO,
    baseBranch: "main",
  });
  assert.deepEqual(selected, []);
});

test("buildSupersededComment: names managed PR, issue, and pipeline-superseded token", () => {
  const body = buildSupersededComment({ managedPrNumber: 726, issueNumber: 601 });
  assert.match(body, /#726/);
  assert.match(body, /#601/);
  assert.match(body, /pipeline-superseded/);
});

// ---------------------------------------------------------------------------
// Managed-head election (cross-host concurrency #729)
// ---------------------------------------------------------------------------

test("electManagedPrWinner: highest open pipeline/<N>-* PR number wins", () => {
  const winner = electManagedPrWinner(
    [
      cand(100, "pipeline/729-host-a"),
      cand(101, "pipeline/729-host-b"),
      cand(656, "eval/other", { closes: [729] }),
    ],
    {
      issueNumber: 729,
      managedPrNumber: 100,
      managedBranch: "pipeline/729-host-a",
      baseBranch: "main",
    },
  );
  assert.deepEqual(winner, { prNumber: 101, branch: "pipeline/729-host-b" });
});

test("electManagedPrWinner: partial list seeds caller's managed identity", () => {
  // Explicit partial-list source only: managed missing from the list still beats
  // a lower peer. Authoritative complete lists do NOT seed (see closed-managed test).
  const winner = electManagedPrWinner(
    [cand(50, "pipeline/729-old")],
    {
      issueNumber: 729,
      managedPrNumber: 200,
      managedBranch: "pipeline/729-new",
      baseBranch: "main",
      listIsPartial: true,
    },
  );
  assert.deepEqual(winner, { prNumber: 200, branch: "pipeline/729-new" });
});

test("electManagedPrWinner: complete list does not seed absent managed PR", () => {
  const winner = electManagedPrWinner(
    [cand(50, "pipeline/729-old")],
    {
      issueNumber: 729,
      managedPrNumber: 200,
      managedBranch: "pipeline/729-new",
      baseBranch: "main",
      // listIsPartial omitted → authoritative; do not invent a closed winner
    },
  );
  assert.deepEqual(winner, { prNumber: 50, branch: "pipeline/729-old" });
});

// ---------------------------------------------------------------------------
// Helper with injectable I/O
// ---------------------------------------------------------------------------

test("supersedeStaleIssuePrs: default close mode comments then closes non-managed only", async () => {
  const comments: { pr: number; body: string }[] = [];
  const closed: number[] = [];
  const open = [
    cand(726, "pipeline/601-new-slug"),
    cand(656, "eval/expanded-corpus", { closes: [601] }),
  ];
  const deps: SupersedeStaleIssuePrsDeps = {
    listOpenPrs: async () => open,
    postPrComment: async (_cfg, pr, body) => {
      comments.push({ pr, body });
    },
    closePr: async (_cfg, pr) => {
      closed.push(pr);
    },
    log: () => {},
  };
  const result = await supersedeStaleIssuePrs(
    makeCfg(),
    601,
    { prNumber: 726, branch: "pipeline/601-new-slug" },
    deps,
  );
  assert.deepEqual(result.candidates, [656]);
  assert.deepEqual(result.commented, [656]);
  assert.deepEqual(result.closed, [656]);
  assert.deepEqual(closed, [656]);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /pipeline-superseded/);
  assert.match(comments[0].body, /#726/);
  assert.equal(result.wonElection, true);
  assert.equal(result.electedPr, 726);
});

test("supersedeStaleIssuePrs: comment-only posts without close", async () => {
  const comments: number[] = [];
  const closed: number[] = [];
  const deps: SupersedeStaleIssuePrsDeps = {
    listOpenPrs: async () => [
      cand(726, "pipeline/601-new-slug"),
      cand(656, "eval/expanded-corpus", { closes: [601] }),
    ],
    postPrComment: async (_cfg, pr) => {
      comments.push(pr);
    },
    closePr: async (_cfg, pr) => {
      closed.push(pr);
    },
    log: () => {},
  };
  const result = await supersedeStaleIssuePrs(
    makeCfg({ supersede_mode: "comment-only" }),
    601,
    { prNumber: 726, branch: "pipeline/601-new-slug" },
    deps,
  );
  assert.deepEqual(result.commented, [656]);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(closed, []);
  assert.deepEqual(comments, [656]);
  assert.equal(result.wonElection, true);
});

test("supersedeStaleIssuePrs: close failure on one candidate does not block others or throw", async () => {
  const closed: number[] = [];
  const deps: SupersedeStaleIssuePrsDeps = {
    listOpenPrs: async () => [
      cand(100, "pipeline/42-old"),
      cand(101, "pipeline/42-also-old"),
      cand(200, "pipeline/42-new"),
    ],
    postPrComment: async () => {},
    closePr: async (_cfg, pr) => {
      if (pr === 100) throw new Error("permission denied");
      closed.push(pr);
    },
    log: () => {},
  };
  const result = await supersedeStaleIssuePrs(
    makeCfg(),
    42,
    { prNumber: 200, branch: "pipeline/42-new" },
    deps,
  );
  assert.deepEqual(result.candidates, [100, 101]);
  assert.deepEqual(result.closed, [101]);
  assert.ok(result.errors.some((e) => /#100/.test(e)));
  assert.deepEqual(closed, [101]);
  assert.equal(result.wonElection, true);
});

test("supersedeStaleIssuePrs: list failure logs and returns without throw", async () => {
  const deps: SupersedeStaleIssuePrsDeps = {
    listOpenPrs: async () => {
      throw new Error("graphql unavailable");
    },
    postPrComment: async () => {
      throw new Error("should not comment");
    },
    closePr: async () => {
      throw new Error("should not close");
    },
    log: () => {},
  };
  const result = await supersedeStaleIssuePrs(
    makeCfg(),
    42,
    { prNumber: 9, branch: "pipeline/42-x" },
    deps,
  );
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.some((e) => /graphql unavailable/.test(e)));
  // List failure is non-blocking for advance; treat as won so create path continues.
  assert.equal(result.wonElection, true);
});

test("supersedeStaleIssuePrs: concurrent managed heads — only higher PR number closes the other", async () => {
  // Two hosts each advanced the same issue on different managed branches.
  // Host A (PR 100) and Host B (PR 101) both see the same open set.
  const open = [
    cand(100, "pipeline/729-host-a"),
    cand(101, "pipeline/729-host-b"),
  ];
  const closedByA: number[] = [];
  const closedByB: number[] = [];
  const commentsByA: number[] = [];
  const commentsByB: number[] = [];

  const resultA = await supersedeStaleIssuePrs(
    makeCfg(),
    729,
    { prNumber: 100, branch: "pipeline/729-host-a" },
    {
      listOpenPrs: async () => open,
      postPrComment: async (_cfg, pr) => {
        commentsByA.push(pr);
      },
      closePr: async (_cfg, pr) => {
        closedByA.push(pr);
      },
      log: () => {},
    },
  );
  const resultB = await supersedeStaleIssuePrs(
    makeCfg(),
    729,
    { prNumber: 101, branch: "pipeline/729-host-b" },
    {
      listOpenPrs: async () => open,
      postPrComment: async (_cfg, pr) => {
        commentsByB.push(pr);
      },
      closePr: async (_cfg, pr) => {
        closedByB.push(pr);
      },
      log: () => {},
    },
  );

  // Loser must not close or comment on the winner (or anyone).
  assert.equal(resultA.wonElection, false);
  assert.equal(resultA.electedPr, 101);
  assert.deepEqual(resultA.closed, []);
  assert.deepEqual(resultA.commented, []);
  assert.deepEqual(closedByA, []);
  assert.deepEqual(commentsByA, []);

  // Winner closes the losing managed PR only.
  assert.equal(resultB.wonElection, true);
  assert.equal(resultB.electedPr, 101);
  assert.deepEqual(resultB.closed, [100]);
  assert.deepEqual(resultB.commented, [100]);
  assert.deepEqual(closedByB, [100]);
  assert.ok(!closedByB.includes(101), "winner must not self-close");
});

test("supersedeStaleIssuePrs: revalidation before act — loses if higher managed PR appears", async () => {
  // First list: only this managed PR (would win). Second list (revalidate): a
  // higher concurrent managed PR is visible → must not close peers.
  let listCalls = 0;
  const closed: number[] = [];
  const result = await supersedeStaleIssuePrs(
    makeCfg(),
    729,
    { prNumber: 100, branch: "pipeline/729-host-a" },
    {
      listOpenPrs: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          return [
            cand(100, "pipeline/729-host-a"),
            cand(50, "pipeline/729-old"),
          ];
        }
        return [
          cand(100, "pipeline/729-host-a"),
          cand(50, "pipeline/729-old"),
          cand(200, "pipeline/729-host-b"),
        ];
      },
      postPrComment: async () => {
        throw new Error("should not comment after lost revalidation");
      },
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      log: () => {},
    },
  );
  assert.equal(result.wonElection, false);
  assert.equal(result.electedPr, 200);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(closed, []);
  assert.ok(listCalls >= 2, "must re-list before acting");
});

test("supersedeStaleIssuePrs: closed managed PR does not win or close open siblings", async () => {
  // Managed PR was closed (human/external) after create/reuse; authoritative
  // open list has only a dual-linked sibling. Must not seed closed PR as winner
  // and must not comment/close the live sibling.
  const comments: number[] = [];
  const closed: number[] = [];
  const result = await supersedeStaleIssuePrs(
    makeCfg(),
    729,
    { prNumber: 200, branch: "pipeline/729-managed" },
    {
      listOpenPrs: async () => [
        // managed #200 absent — closed
        cand(656, "eval/expanded-corpus", { closes: [729] }),
      ],
      postPrComment: async (_cfg, pr) => {
        comments.push(pr);
      },
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      log: () => {},
    },
  );
  assert.equal(result.wonElection, false);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.commented, []);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(comments, []);
  assert.deepEqual(closed, []);
  assert.ok(result.errors.some((e) => /not an open eligible managed head/.test(e)));
});

// ---------------------------------------------------------------------------
// resumeFromImplementing wiring (#729)
// ---------------------------------------------------------------------------

test("resumeFromImplementing: create path runs supersede after createPr", async () => {
  const callLog: string[] = [];
  let supersedeManaged: { prNumber: number; branch: string } | null = null;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({ ok: true, ran: false }),
    getPrForBranch: async () => null,
    createPr: async () => {
      callLog.push("createPr");
      return 726;
    },
    gitInWorktree: async (_p, args) => {
      if (args[0] === "push") callLog.push("push");
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async () => {},
    transition: async () => {
      callLog.push("transition");
    },
    supersedeStaleIssuePrs: async (_cfg, _n, managed) => {
      callLog.push("supersede");
      supersedeManaged = managed;
      return {
        candidates: [],
        commented: [],
        closed: [],
        errors: [],
        wonElection: true,
        electedPr: managed.prNumber,
      };
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    601,
    { path: "/fake/wt", branch: "pipeline/601-new-slug" },
    {
      prTitle: "[Pipeline] #601",
      prBody: "Closes #601",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.deepEqual(supersedeManaged, { prNumber: 726, branch: "pipeline/601-new-slug" });
  const createIdx = callLog.indexOf("createPr");
  const supersedeIdx = callLog.indexOf("supersede");
  const transitionIdx = callLog.indexOf("transition");
  assert.ok(createIdx >= 0);
  assert.ok(supersedeIdx > createIdx, "supersede after create");
  assert.ok(transitionIdx > supersedeIdx, "transition after supersede");
});

test("resumeFromImplementing: exact-head reuse still runs supersede", async () => {
  let supersedeCalled = false;
  let createCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({ ok: true, ran: false }),
    getPrForBranch: async () => 726,
    createPr: async () => {
      createCalled = true;
      return 999;
    },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
    supersedeStaleIssuePrs: async (_cfg, _n, managed) => {
      supersedeCalled = true;
      assert.equal(managed.prNumber, 726);
      return {
        candidates: [656],
        commented: [656],
        closed: [656],
        errors: [],
        wonElection: true,
        electedPr: 726,
      };
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    601,
    { path: "/fake/wt", branch: "pipeline/601-new-slug" },
    {
      prTitle: "[Pipeline] #601",
      prBody: "Closes #601",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.ok(supersedeCalled, "reuse path must still supersede siblings");
  assert.ok(!createCalled, "exact-head reuse must not create");
});

test("resumeFromImplementing: multi-PR fixture closes only non-managed head via supersede deps", async () => {
  const closed: number[] = [];
  const comments: number[] = [];
  const open = [
    cand(656, "eval/expanded-corpus", { closes: [601] }),
    // managed head not open yet at list time after create — but filter would skip it
  ];

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({ ok: true, ran: false }),
    getPrForBranch: async () => null,
    createPr: async () => 726,
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
    // Use production helper with injected gh deps so the close path is real logic.
    supersedeDeps: {
      listOpenPrs: async () => [
        ...open,
        cand(726, "pipeline/601-new-slug"),
      ],
      postPrComment: async (_cfg, pr) => {
        comments.push(pr);
      },
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      log: () => {},
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    601,
    { path: "/fake/wt", branch: "pipeline/601-new-slug" },
    {
      prTitle: "[Pipeline] #601",
      prBody: "Closes #601",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.deepEqual(closed, [656]);
  assert.deepEqual(comments, [656]);
  assert.ok(!closed.includes(726), "managed PR must not be closed");
});

test("resumeFromImplementing: lost managed-head election stops without transition or setBlocked", async () => {
  let transitioned = false;
  let blocked = false;
  const closed: number[] = [];

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({ ok: true, ran: false }),
    getPrForBranch: async () => null,
    createPr: async () => 100,
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {
      blocked = true;
    },
    transition: async () => {
      transitioned = true;
    },
    // Production helper: concurrent peer 101 wins; 100 must not close 101.
    supersedeDeps: {
      listOpenPrs: async () => [
        cand(100, "pipeline/729-host-a"),
        cand(101, "pipeline/729-host-b"),
      ],
      postPrComment: async () => {
        throw new Error("loser must not comment");
      },
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      log: () => {},
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    729,
    { path: "/fake/wt", branch: "pipeline/729-host-a" },
    {
      prTitle: "[Pipeline] #729",
      prBody: "Closes #729",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-loser",
    },
    deps,
  );

  assert.equal(result.advanced, false);
  assert.equal(result.status, "waiting");
  assert.match(result.reason ?? "", /#101/);
  assert.equal(transitioned, false, "loser must not transition toward design-gate");
  assert.equal(blocked, false, "loser must not setBlocked (would stall the winner)");
  assert.deepEqual(closed, [], "loser must not close the winning managed PR");
});

test("resumeFromImplementing: closed managed PR does not close siblings or advance", async () => {
  // Regression #729 adversarial: managed PR closed externally after create;
  // open sibling remains. Sweep must not comment/close the sibling; post-implement
  // must not transition away from implementing.
  let transitioned = false;
  let blocked = false;
  const closed: number[] = [];
  const comments: number[] = [];

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({ ok: true, ran: false }),
    getPrForBranch: async () => null,
    createPr: async () => 200,
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {
      blocked = true;
    },
    transition: async () => {
      transitioned = true;
    },
    supersedeDeps: {
      listOpenPrs: async () => [
        // Managed #200 absent (closed); sibling still open and dual-linked.
        cand(656, "eval/expanded-corpus", { closes: [729] }),
      ],
      postPrComment: async (_cfg, pr) => {
        comments.push(pr);
      },
      closePr: async (_cfg, pr) => {
        closed.push(pr);
      },
      log: () => {},
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    729,
    { path: "/fake/wt", branch: "pipeline/729-managed" },
    {
      prTitle: "[Pipeline] #729",
      prBody: "Closes #729",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-closed-managed",
    },
    deps,
  );

  assert.equal(result.advanced, false);
  assert.equal(result.status, "waiting");
  assert.match(result.reason ?? "", /no longer an open eligible managed head/);
  assert.equal(transitioned, false, "must not transition with a closed managed PR");
  assert.equal(blocked, false, "must not setBlocked");
  assert.deepEqual(closed, [], "must not close open sibling");
  assert.deepEqual(comments, [], "must not comment-flag open sibling");
});

test("bite: resumeFromImplementing source must call supersede after managed PR is known", () => {
  // Source-level bite: removing the supersede call from the post-implement path
  // fails this test even when unit tests inject a no-op.
  const planningSrc = fs.readFileSync(
    path.join(REPO_ROOT, "core/scripts/stages/planning.ts"),
    "utf8",
  );
  const createIdx = planningSrc.indexOf("prCreator(");
  const supersedeIdx = planningSrc.indexOf("supersedeStaleIssuePrs");
  // Call site (not only the import / type reference): look for the invocation after create.
  const callIdx = planningSrc.indexOf("const supersede = deps.supersedeStaleIssuePrs");
  const transitionIdx = planningSrc.indexOf('trans(cfg, issueNumber, "implementing", "design-gate"');
  const electionGuardIdx = planningSrc.indexOf("wonElection === false");
  assert.ok(createIdx >= 0, "create path present");
  assert.ok(supersedeIdx >= 0, "supersede import/reference present");
  assert.ok(callIdx >= 0, "supersede call wiring present");
  assert.ok(callIdx > createIdx, "supersede after create");
  assert.ok(transitionIdx > callIdx, "transition after supersede");
  assert.ok(
    electionGuardIdx > callIdx && electionGuardIdx < transitionIdx,
    "lost-election guard must sit between supersede and transition",
  );
});
