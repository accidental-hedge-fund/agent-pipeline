// Tests for roadmap/writeback.ts (#171, #632)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hygieneActionHash,
  hygieneSentinel,
  writePlanJson,
  renderRoadmapMd,
  writeRoadmapMd,
  applyHygiene,
  applyMilestones,
  openRoadmapPr,
  buildRoadmapCommitMessage,
} from "../scripts/roadmap/writeback.ts";
import {
  planRoadmapThrowawayWorktreeAdd,
  planRoadmapThrowawayWorktreePath,
  roadmapBranchFetchRefspec,
  roadmapDayBranchPushRefspec,
  roadmapThrowawayWorktreeDir,
  shouldForceRemoveRoadmapWorktree,
} from "../scripts/stages/roadmap-deps.ts";
import type { CrossRepoDep, HygieneItem, MilestoneSpec, PlanJson } from "../scripts/roadmap/types.ts";
import type { WritebackDeps } from "../scripts/roadmap/writeback.ts";

/** Distinct throwaway path used by default test deps (≠ operator repoDir). */
const DEFAULT_WT = "/tmp/roadmap-throwaway-wt";

function makePlan(overrides: Partial<PlanJson> = {}): PlanJson {
  return {
    generated_at: "2026-01-01T00:00:00Z",
    backlog_sha: "abc12345",
    repo: "example/repo",
    dependency_graph: {
      must_precede: [],
      should_precede: [],
      parallel_safe: [],
      blocked_pending_decision: [],
      duplicate_merge: [],
      conflict_pairs: [],
      cycle_reports: [],
      open_questions: [],
    },
    scored: [],
    roadmap: [],
    hygiene: [],
    milestones: [],
    new_issue_drafts: [],
    critique: [],
    open_questions: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WritebackDeps> = {}): WritebackDeps {
  return {
    writeFile: async () => {},
    readFile: async () => null,
    withThrowawayWorktree: async (_repoDir, _branch, _baseRef, fn) => fn(DEFAULT_WT),
    gitCommit: async () => {},
    gitPushBranch: async () => {},
    findPrByHead: async () => null,
    createPr: async () => "https://github.com/example/repo/pull/1",
    createLabel: async () => {},
    applyLabel: async () => {},
    createMilestone: async () => 1,
    getMilestones: async () => [],
    assignIssueMilestone: async () => {},
    closeIssue: async () => {},
    addComment: async () => {},
    editIssue: async () => {},
    createIssue: async () => 42,
    getIssueState: async () => "open",
    getIssueComments: async () => [],
    log: () => {},
    ...overrides,
  };
}

describe("hygieneActionHash", () => {
  it("returns a 12-char hex string", () => {
    const item: HygieneItem = {
      issue_number: 42,
      action: "close",
      comment_text: "Closing as duplicate.",
      evidence: "same as #40",
    };
    const hash = hygieneActionHash(item);
    assert.match(hash, /^[0-9a-f]{12}$/);
  });

  it("is stable for same input", () => {
    const item: HygieneItem = { issue_number: 1, action: "spike", comment_text: "c", evidence: "e" };
    assert.equal(hygieneActionHash(item), hygieneActionHash(item));
  });

  it("differs for different issue numbers", () => {
    const a: HygieneItem = { issue_number: 1, action: "close", comment_text: "c", evidence: "e" };
    const b: HygieneItem = { issue_number: 2, action: "close", comment_text: "c", evidence: "e" };
    assert.notEqual(hygieneActionHash(a), hygieneActionHash(b));
  });
});

describe("hygieneSentinel", () => {
  it("produces the expected sentinel format", () => {
    const sentinel = hygieneSentinel("abc123def456");
    assert.equal(sentinel, "<!-- roadmap-run:abc123def456 -->");
  });
});

describe("writePlanJson", () => {
  it("writes plan.json to the output directory", async () => {
    const writes: Record<string, string> = {};
    const deps = makeDeps({
      writeFile: async (p, content) => { writes[p] = content; },
    });
    const plan = makePlan();
    await writePlanJson(plan, "/output", deps);
    assert.ok("/output/plan.json" in writes, "should write plan.json");
    const parsed = JSON.parse(writes["/output/plan.json"]);
    assert.equal(parsed.repo, "example/repo");
    assert.equal(parsed.backlog_sha, "abc12345");
  });

  it("round-trips: written JSON parses back to the same plan", async () => {
    const writes: Record<string, string> = {};
    const deps = makeDeps({ writeFile: async (p, c) => { writes[p] = c; } });
    const plan = makePlan({ roadmap: [{ rank: 1, issue_number: 1, title: "Issue 1", tier: "enablers", priority: 10, score_breakdown: { impact: 3, confidence: 2, ease: 2, effort: 3, risk_reduction: 1, dep_leverage: 1 }, dep_rationale: "none", touched_files: [], effort: "M", risks: [], unblocks: [], blocked_by: [] }] });
    await writePlanJson(plan, "/out", deps);
    const parsed = JSON.parse(writes["/out/plan.json"]) as PlanJson;
    assert.equal(parsed.roadmap[0].issue_number, 1);
    assert.equal(parsed.roadmap[0].tier, "enablers");
  });
});

describe("renderRoadmapMd", () => {
  it("includes the repo name and generated date", () => {
    const plan = makePlan();
    const md = renderRoadmapMd(plan);
    assert.ok(md.includes("example/repo"), "should include repo name");
    assert.ok(md.includes("2026-01-01"), "should include date");
  });

  it("renders roadmap entries by tier", () => {
    const plan = makePlan({
      roadmap: [
        {
          rank: 1, issue_number: 5, title: "Enable CI", tier: "enablers", priority: 20,
          score_breakdown: { impact: 3, confidence: 2, ease: 2, effort: 3, risk_reduction: 1, dep_leverage: 2 },
          dep_rationale: "No hard deps", touched_files: [], effort: "M", risks: [], unblocks: [], blocked_by: [],
        },
      ],
    });
    const md = renderRoadmapMd(plan);
    assert.ok(md.includes("RM-5"), "should include stable issue ID");
    assert.ok(md.includes("Enable CI"), "should include issue title");
    assert.ok(md.includes("enablers"), "should include tier name");
  });

  it("includes hygiene proposals section when hygiene is present", () => {
    const plan = makePlan({
      hygiene: [{ issue_number: 3, action: "close", comment_text: "Closing as stale.", evidence: "no activity" }],
    });
    const md = renderRoadmapMd(plan);
    assert.ok(md.includes("Hygiene Proposals"), "should have hygiene section");
    assert.ok(md.includes("#3"), "should reference hygiene issue");
  });

  it("includes DONE tracker section", () => {
    const md = renderRoadmapMd(makePlan());
    assert.ok(md.includes("DONE tracker"), "should have done tracker");
  });

  it("includes open questions when present", () => {
    const plan = makePlan({
      open_questions: [{ description: "Should we merge #5 and #6?", related_issues: [5, 6] }],
    });
    const md = renderRoadmapMd(plan);
    assert.ok(md.includes("Open Questions"), "should have open questions section");
    assert.ok(md.includes("Should we merge"), "should include the question text");
  });
});

describe("applyHygiene - dry-run", () => {
  it("does not call any write ops when apply=false", async () => {
    let closeCallCount = 0;
    let commentCallCount = 0;
    const deps = makeDeps({
      closeIssue: async () => { closeCallCount++; },
      addComment: async () => { commentCallCount++; },
    });
    const hygiene: HygieneItem[] = [
      { issue_number: 1, action: "close", comment_text: "Closing.", evidence: "stale" },
    ];
    await applyHygiene(hygiene, "example/repo", { apply: false }, deps);
    assert.equal(closeCallCount, 0, "dry-run should not close issues");
    assert.equal(commentCallCount, 0, "dry-run should not post comments");
  });
});

describe("applyHygiene - idempotency", () => {
  it("skips action if sentinel already present in comments", async () => {
    const item: HygieneItem = { issue_number: 7, action: "spike", comment_text: "Spike advice.", evidence: "research" };
    const hash = hygieneActionHash(item);
    const sentinel = hygieneSentinel(hash);

    let commentCallCount = 0;
    const deps = makeDeps({
      getIssueComments: async () => [{ body: `Some existing comment.\n\n${sentinel}` }],
      addComment: async () => { commentCallCount++; },
    });

    await applyHygiene([item], "example/repo", { apply: true }, deps);
    assert.equal(commentCallCount, 0, "should not re-post when sentinel is already present");
  });

  it("posts comment when sentinel is absent", async () => {
    const item: HygieneItem = { issue_number: 8, action: "spike", comment_text: "Spike advice.", evidence: "research" };
    let commentCallCount = 0;
    const deps = makeDeps({
      getIssueComments: async () => [],
      addComment: async () => { commentCallCount++; },
    });

    await applyHygiene([item], "example/repo", { apply: true }, deps);
    assert.equal(commentCallCount, 1, "should post comment when sentinel is absent");
  });
});

describe("applyMilestones - idempotency", () => {
  it("dry-run logs without calling getMilestones or createMilestone", async () => {
    let getMilestonesCount = 0;
    let createCount = 0;
    const deps = makeDeps({
      getMilestones: async () => { getMilestonesCount++; return []; },
      createMilestone: async () => { createCount++; return 1; },
    });
    const milestones: MilestoneSpec[] = [{ title: "v1.7.0", issue_numbers: [1], rationale: "test" }];
    await applyMilestones(milestones, "example/repo", false, deps);
    assert.equal(getMilestonesCount, 0, "dry-run must not call getMilestones");
    assert.equal(createCount, 0, "dry-run must not call createMilestone");
  });

  it("creates a new milestone when none exists with that title", async () => {
    let createCount = 0;
    const deps = makeDeps({
      getMilestones: async () => [],
      createMilestone: async () => { createCount++; return 10; },
    });
    const milestones: MilestoneSpec[] = [{ title: "v1.7.0", issue_numbers: [5], rationale: "test" }];
    await applyMilestones(milestones, "example/repo", true, deps);
    assert.equal(createCount, 1, "should create milestone when none exists");
  });

  it("reuses an existing open milestone instead of creating a duplicate", async () => {
    let createCount = 0;
    let assignedTitle: string | undefined;
    const deps = makeDeps({
      getMilestones: async () => [{ id: 10, number: 10, title: "v1.7.0" }],
      createMilestone: async () => { createCount++; return 99; },
      assignIssueMilestone: async (_repo, _n, title) => { assignedTitle = title; },
    });
    const milestones: MilestoneSpec[] = [{ title: "v1.7.0", issue_numbers: [5], rationale: "test" }];
    await applyMilestones(milestones, "example/repo", true, deps);
    assert.equal(createCount, 0, "should not create milestone that already exists");
    assert.equal(assignedTitle, "v1.7.0");
  });

  it("regression: reuses a closed milestone returned by getMilestones (state=all fix)", async () => {
    // applyMilestones reuses any milestone returned by getMilestones regardless of state.
    // The gh.ts fix (state=all) ensures closed milestones appear in that list so they
    // are reused here instead of triggering a duplicate-creation failure on GitHub.
    let createCount = 0;
    const deps = makeDeps({
      getMilestones: async () => [{ id: 99, number: 99, title: "epic:auth" }],
      createMilestone: async () => { createCount++; return 100; },
    });
    const milestones: MilestoneSpec[] = [{ title: "epic:auth", issue_numbers: [1, 2], rationale: "auth group" }];
    await applyMilestones(milestones, "example/repo", true, deps);
    assert.equal(createCount, 0, "closed milestone in getMilestones result must be reused, not recreated");
  });
});

describe("openRoadmapPr - isolation + refresh + commit metadata (#632)", () => {
  it("never commits or creates PR against the operator repoDir; uses throwaway worktree path", async () => {
    const operatorRepo = "/operator/checkout";
    const wtPath = "/tmp/wt-roadmap-isolated";
    const commitDirs: string[] = [];
    const pushDirs: string[] = [];
    const writePaths: string[] = [];
    const createPrDirs: string[] = [];
    let withWtCalls = 0;
    let withWtRepoDir: string | undefined;
    let withWtBase: string | undefined;
    let withWtBranch: string | undefined;

    const deps = makeDeps({
      withThrowawayWorktree: async (repoDir, branch, baseRef, fn) => {
        withWtCalls++;
        withWtRepoDir = repoDir;
        withWtBranch = branch;
        withWtBase = baseRef;
        return fn(wtPath);
      },
      writeFile: async (p) => { writePaths.push(p); },
      gitCommit: async (dir) => { commitDirs.push(dir); },
      gitPushBranch: async (dir) => { pushDirs.push(dir); },
      createPr: async (dir) => {
        createPrDirs.push(dir);
        return "https://github.com/example/repo/pull/1";
      },
    });

    const plan = makePlan();
    await openRoadmapPr(plan, operatorRepo, "develop", deps);

    assert.equal(withWtCalls, 1, "must open a throwaway worktree");
    assert.equal(withWtRepoDir, operatorRepo);
    assert.equal(withWtBase, "develop", "worktree base must be the configured baseBranch");
    assert.ok(withWtBranch?.startsWith("roadmap/"), `branch should be day-keyed, got ${withWtBranch}`);
    assert.deepEqual(commitDirs, [wtPath], "gitCommit must use worktree path, not operator repoDir");
    assert.deepEqual(pushDirs, [wtPath], "gitPushBranch must use worktree path");
    assert.deepEqual(createPrDirs, [wtPath]);
    assert.ok(
      writePaths.every((p) => p.startsWith(wtPath + "/") || p.startsWith(wtPath + "\\")),
      `docs write must target worktree, got: ${writePaths.join(", ")}`,
    );
    assert.ok(!commitDirs.includes(operatorRepo));
    assert.ok(!writePaths.some((p) => p.startsWith(operatorRepo + "/")));
  });

  it("existing PR + identical branch-head content: no commit, no createPr, returns URL", async () => {
    const existingPrUrl = "https://github.com/example/repo/pull/42";
    let commitCount = 0;
    let prCreateCount = 0;
    let pushCount = 0;
    const plan = makePlan();
    const md = renderRoadmapMd(plan);

    const deps = makeDeps({
      findPrByHead: async () => existingPrUrl,
      // Branch-head content via worktree path (not operator checkout).
      readFile: async (p) => (p.includes("docs/roadmaps/") ? md : null),
      gitCommit: async () => { commitCount++; },
      gitPushBranch: async () => { pushCount++; },
      createPr: async () => {
        prCreateCount++;
        return "https://github.com/example/repo/pull/99";
      },
    });

    const result = await openRoadmapPr(plan, "/repo", "main", deps);
    assert.equal(result, existingPrUrl);
    assert.equal(commitCount, 0, "identical content must not commit");
    assert.equal(pushCount, 0);
    assert.equal(prCreateCount, 0, "must not open a duplicate PR");
  });

  it("existing PR + different branch-head content: commit+push, no createPr, returns same URL", async () => {
    const existingPrUrl = "https://github.com/example/repo/pull/42";
    let commitCount = 0;
    let pushCount = 0;
    let prCreateCount = 0;
    let commitDir: string | undefined;
    const plan = makePlan();

    const deps = makeDeps({
      findPrByHead: async () => existingPrUrl,
      // Stale content on the day-keyed branch head (worktree), not operator tree.
      readFile: async (p) => (p.includes("docs/roadmaps/") ? "# stale roadmap\n" : null),
      gitCommit: async (dir) => {
        commitCount++;
        commitDir = dir;
      },
      gitPushBranch: async () => { pushCount++; },
      createPr: async () => {
        prCreateCount++;
        return "https://github.com/example/repo/pull/99";
      },
    });

    const result = await openRoadmapPr(plan, "/repo", "main", deps);
    assert.equal(result, existingPrUrl, "must return existing PR URL after refresh");
    assert.equal(commitCount, 1, "differing content must commit");
    assert.equal(pushCount, 1);
    assert.equal(prCreateCount, 0, "must not create a duplicate PR");
    assert.equal(commitDir, DEFAULT_WT, "refresh commit must land in throwaway worktree");
  });

  it("content comparison uses worktree (branch head), not operator working tree alone", async () => {
    const existingPrUrl = "https://github.com/example/repo/pull/7";
    const plan = makePlan();
    const md = renderRoadmapMd(plan);
    const operatorRepo = "/operator/repo";
    const wtPath = "/tmp/wt-branch-head";
    const readPaths: string[] = [];
    let commitCount = 0;

    const deps = makeDeps({
      findPrByHead: async () => existingPrUrl,
      withThrowawayWorktree: async (_repoDir, _branch, _base, fn) => fn(wtPath),
      // Operator tree has different/missing docs; branch head (worktree) matches render → no-op.
      readFile: async (p) => {
        readPaths.push(p);
        if (p.startsWith(operatorRepo)) {
          return "# operator dirty tree — must not drive comparison\n";
        }
        if (p.startsWith(wtPath) && p.includes("docs/roadmaps/")) {
          return md;
        }
        return null;
      },
      gitCommit: async () => { commitCount++; },
    });

    const result = await openRoadmapPr(plan, operatorRepo, "main", deps);
    assert.equal(result, existingPrUrl);
    assert.equal(commitCount, 0, "must no-op when branch head matches, even if operator tree differs");
    assert.ok(
      readPaths.some((p) => p.startsWith(wtPath)),
      "must read docs from worktree path",
    );
    assert.ok(
      !readPaths.some((p) => p.startsWith(operatorRepo + "/")),
      "must not use operator repoDir path for content comparison",
    );
  });

  it("no PR + unchanged branch-head docs: returns null without createPr", async () => {
    let prCreateCount = 0;
    let commitCount = 0;
    const plan = makePlan();
    const md = renderRoadmapMd(plan);
    const deps = makeDeps({
      findPrByHead: async () => null,
      readFile: async () => md,
      gitCommit: async () => { commitCount++; },
      createPr: async () => {
        prCreateCount++;
        return "https://github.com/example/repo/pull/1";
      },
    });
    const result = await openRoadmapPr(plan, "/repo", "main", deps);
    assert.equal(result, null);
    assert.equal(commitCount, 0);
    assert.equal(prCreateCount, 0);
  });

  it("no PR + new content: commit+push+createPr via worktree; baseRef passed to worktree helper", async () => {
    let baseRefSeen: string | undefined;
    let prCreateCount = 0;
    const deps = makeDeps({
      findPrByHead: async () => null,
      readFile: async () => null,
      withThrowawayWorktree: async (_repo, _branch, baseRef, fn) => {
        baseRefSeen = baseRef;
        return fn(DEFAULT_WT);
      },
      createPr: async () => {
        prCreateCount++;
        return "https://github.com/example/repo/pull/1";
      },
    });
    await openRoadmapPr(makePlan(), "/repo", "develop", deps);
    assert.equal(baseRefSeen, "develop");
    assert.equal(prCreateCount, 1);
  });

  it("commit message has no fossil #171 / fake run id", async () => {
    let commitMsg = "";
    const deps = makeDeps({
      readFile: async () => null,
      gitCommit: async (_dir, _files, message) => { commitMsg = message; },
    });
    await openRoadmapPr(makePlan(), "/repo", "main", deps);
    assert.ok(!commitMsg.includes("Issue: #171"), "must not hardcode fossil Issue: #171");
    assert.ok(
      !commitMsg.includes("Pipeline-Run: 171/2026-06-17T04:37:16Z"),
      "must not hardcode fossil Pipeline-Run from #171",
    );
    assert.ok(!commitMsg.includes("Issue:"), "default path must omit Issue trailer");
    assert.ok(!commitMsg.includes("Pipeline-Run:"), "default path must omit Pipeline-Run trailer");
    assert.match(commitMsg, /^docs: roadmap for example\/repo \(generated 2026-01-01\)$/);
  });

  it("with full issue+run context, commit message carries both trailers", async () => {
    let commitMsg = "";
    const deps = makeDeps({
      readFile: async () => null,
      gitCommit: async (_dir, _files, message) => { commitMsg = message; },
    });
    await openRoadmapPr(makePlan(), "/repo", "main", deps, {
      issueNumber: 632,
      pipelineRunId: "632/2026-08-03T16:19:17Z",
    });
    assert.ok(commitMsg.includes("Issue: #632"));
    assert.ok(commitMsg.includes("Pipeline-Run: 632/2026-08-03T16:19:17Z"));
    assert.ok(commitMsg.includes("\n\nIssue: #632\n"), "trailers separated by blank line");
  });

  it("partial context (only issue or only run) invents neither trailer", async () => {
    for (const trace of [
      { issueNumber: 632 },
      { pipelineRunId: "632/2026-08-03T16:19:17Z" },
    ] as const) {
      let commitMsg = "";
      const deps = makeDeps({
        readFile: async () => null,
        gitCommit: async (_dir, _files, message) => { commitMsg = message; },
      });
      await openRoadmapPr(makePlan(), "/repo", "main", deps, trace);
      assert.ok(!commitMsg.includes("Issue:"), `partial ${JSON.stringify(trace)} must omit Issue`);
      assert.ok(!commitMsg.includes("Pipeline-Run:"), `partial ${JSON.stringify(trace)} must omit Pipeline-Run`);
    }
  });
});

describe("planRoadmapThrowawayWorktreeAdd - detached tip + remote preference (#632)", () => {
  const branch = "roadmap/repo-2026-08-03";
  const baseRef = "main";
  const wtDir = "/repo/.worktrees/roadmap+repo-2026-08-03+deadbeef";

  it("fetch refspec writes the remote-tracking ref, not just FETCH_HEAD", () => {
    assert.equal(
      roadmapBranchFetchRefspec(branch),
      `${branch}:refs/remotes/origin/${branch}`,
    );
  });

  it("push refspec publishes detached HEAD to day-branch (FF only)", () => {
    // Regression #632 review-2 62b576be: never attach worktree to shared day branch.
    assert.equal(roadmapDayBranchPushRefspec(branch), `HEAD:refs/heads/${branch}`);
    assert.ok(!roadmapDayBranchPushRefspec(branch).includes("--force"));
  });

  it("successful fetch detaches at origin/<branch> even when a stale local branch exists", () => {
    // Prefer remote tip; must NOT use -B / checkout the shared day-branch name
    // (that would move the operator's HEAD if they are already on that branch).
    const plan = planRoadmapThrowawayWorktreeAdd({
      branch,
      baseRef,
      wtDir,
      fetchStatus: 0,
      fetchStderr: "",
      localBranchExists: true,
    });
    assert.equal(plan.kind, "add");
    if (plan.kind !== "add") return;
    assert.deepEqual(plan.addArgs, [
      "worktree", "add", "--detach", wtDir, `origin/${branch}`,
    ]);
    assert.ok(!plan.addArgs.includes("-B"), "must not reset shared day-branch with -B");
    assert.ok(!plan.addArgs.includes("-b"), "must not create shared day-branch in worktree");
    // Day-branch name must not appear as the worktree branch to check out —
    // only as part of origin/<branch> commit-ish.
    assert.ok(!plan.addArgs.includes(branch), "must not attach worktree to shared day-branch ref");
  });

  it("successful fetch detaches at origin/<branch> when local branch is missing", () => {
    // Fresh operator checkout: no local day-branch; remote PR branch exists.
    const plan = planRoadmapThrowawayWorktreeAdd({
      branch,
      baseRef,
      wtDir,
      fetchStatus: 0,
      fetchStderr: "",
      localBranchExists: false,
    });
    assert.equal(plan.kind, "add");
    if (plan.kind !== "add") return;
    assert.deepEqual(plan.addArgs, [
      "worktree", "add", "--detach", wtDir, `origin/${branch}`,
    ]);
    assert.ok(!plan.addArgs.includes(baseRef), "must not fall through to baseRef when remote exists");
    assert.ok(!plan.addArgs.includes("-B"));
  });

  it("missing remote ref + no local branch detaches at baseRef (new day branch)", () => {
    const plan = planRoadmapThrowawayWorktreeAdd({
      branch,
      baseRef,
      wtDir,
      fetchStatus: 128,
      fetchStderr: `fatal: couldn't find remote ref ${branch}`,
      localBranchExists: false,
    });
    assert.equal(plan.kind, "add");
    if (plan.kind !== "add") return;
    assert.deepEqual(plan.addArgs, [
      "worktree", "add", "--detach", wtDir, baseRef,
    ]);
    // Must not create the shared day-branch name locally via -b (operator may
    // later check it out; push publishes HEAD:refs/heads/<day-branch> instead).
    assert.ok(!plan.addArgs.includes("-b"));
    assert.ok(!plan.addArgs.includes(branch));
  });

  it("missing remote ref + local branch detaches at local tip (not yet pushed)", () => {
    const plan = planRoadmapThrowawayWorktreeAdd({
      branch,
      baseRef,
      wtDir,
      fetchStatus: 128,
      fetchStderr: `fatal: couldn't find remote ref ${branch}`,
      localBranchExists: true,
    });
    assert.equal(plan.kind, "add");
    if (plan.kind !== "add") return;
    // Detach at the commit-ish named by the local branch without checking it out
    // as a branch (shared ref stays put if operator is on it).
    assert.deepEqual(plan.addArgs, ["worktree", "add", "--detach", wtDir, branch]);
    assert.ok(!plan.addArgs.includes("-B"));
    assert.ok(!plan.addArgs.includes("-b"));
  });

  it("non-missing fetch failure fails closed (does not silently start from baseRef)", () => {
    // Existing PR path: network/auth failure must not create a divergent branch
    // from base that then non-fast-forward-fails (or worse, rewrites) on push.
    const plan = planRoadmapThrowawayWorktreeAdd({
      branch,
      baseRef,
      wtDir,
      fetchStatus: 1,
      fetchStderr: "fatal: unable to access 'https://github.com/example/repo.git/': Could not resolve host",
      localBranchExists: false,
    });
    assert.equal(plan.kind, "error");
    if (plan.kind !== "error") return;
    assert.match(plan.message, /fetch origin/);
    assert.match(plan.message, /refs\/remotes\/origin\//);
    assert.ok(!plan.message.includes("worktree add"), "must not plan a worktree add on hard fetch failure");
  });
});

describe("roadmap throwaway path + cleanup ownership (#632 review-2 41f999b5)", () => {
  const branch = "roadmap/repo-2026-08-03";
  const repoDir = "/operator/checkout";

  it("path embeds invocation id (not PID alone) under .worktrees", () => {
    const id = "a1b2c3d4e5f67890";
    const dir = roadmapThrowawayWorktreeDir(repoDir, branch, id);
    // branch "roadmap/repo-2026-08-03" → safe "roadmap+repo-2026-08-03"
    assert.equal(dir, `${repoDir}/.worktrees/roadmap+roadmap+repo-2026-08-03+${id}`);
    assert.ok(dir.includes(id), "must embed collision-resistant invocation id");
    assert.ok(!dir.endsWith(`+${process.pid}`), "must not rely on recycled PID alone");
  });

  it("pre-existing path fails closed — no force-remove of foreign worktree", () => {
    // Regression: old code removed path derived only from PID with
    // `git worktree remove --force` before create, deleting uncommitted work
    // left by a crashed prior process that shared a recycled PID.
    const plan = planRoadmapThrowawayWorktreePath({
      repoDir,
      branch,
      invocationId: "recycled-pid-path",
      pathExists: true,
    });
    assert.equal(plan.kind, "error");
    if (plan.kind !== "error") return;
    assert.match(plan.message, /already exists/);
    assert.match(plan.message, /refusing to force-remove/);
  });

  it("absent path is ready for create", () => {
    const plan = planRoadmapThrowawayWorktreePath({
      repoDir,
      branch,
      invocationId: "fresh-token",
      pathExists: false,
    });
    assert.equal(plan.kind, "ready");
    if (plan.kind !== "ready") return;
    assert.equal(
      plan.wtDir,
      roadmapThrowawayWorktreeDir(repoDir, branch, "fresh-token"),
    );
  });

  it("force-remove only when this invocation created the worktree", () => {
    assert.equal(shouldForceRemoveRoadmapWorktree(true), true);
    assert.equal(
      shouldForceRemoveRoadmapWorktree(false),
      false,
      "must not force-remove a path this invocation did not create",
    );
  });
});

describe("buildRoadmapCommitMessage", () => {
  it("omits trailers without full context", () => {
    const plan = makePlan();
    assert.equal(
      buildRoadmapCommitMessage(plan),
      "docs: roadmap for example/repo (generated 2026-01-01)",
    );
    assert.equal(
      buildRoadmapCommitMessage(plan, { issueNumber: 1 }),
      "docs: roadmap for example/repo (generated 2026-01-01)",
    );
  });

  it("appends both trailers when fully supplied", () => {
    const msg = buildRoadmapCommitMessage(makePlan(), {
      issueNumber: 10,
      pipelineRunId: "10/2026-01-01T00:00:00Z",
    });
    assert.equal(
      msg,
      "docs: roadmap for example/repo (generated 2026-01-01)\n\nIssue: #10\nPipeline-Run: 10/2026-01-01T00:00:00Z",
    );
  });
});

// ---------------------------------------------------------------------------
// renderRoadmapMd: cross-repo section (#312)
// ---------------------------------------------------------------------------

describe("renderRoadmapMd: cross_repo", () => {
  it("emits Cross-Repo Dependencies section when cross_repo is non-empty", () => {
    const crossRepo: CrossRepoDep[] = [
      { local_issue: 5, repo: "acme/shared-lib", direction: "depends_on", rationale: "local issue text references `acme/shared-lib`" },
    ];
    const plan = makePlan({
      dependency_graph: {
        must_precede: [], should_precede: [], parallel_safe: [],
        blocked_pending_decision: [], duplicate_merge: [], conflict_pairs: [],
        cycle_reports: [], open_questions: [], cross_repo: crossRepo,
      },
    });
    const md = renderRoadmapMd(plan);
    assert.ok(md.includes("## Cross-Repo Dependencies"), "must emit section header");
    assert.ok(md.includes("**#5**"), "must reference local issue");
    assert.ok(md.includes("acme/shared-lib"), "must include repo name");
    assert.ok(md.includes("depends_on"), "must include direction");
    assert.ok(md.includes("local issue text references"), "must include rationale");
  });

  it("omits Cross-Repo Dependencies section when cross_repo is empty", () => {
    const plan = makePlan({
      dependency_graph: {
        must_precede: [], should_precede: [], parallel_safe: [],
        blocked_pending_decision: [], duplicate_merge: [], conflict_pairs: [],
        cycle_reports: [], open_questions: [], cross_repo: [],
      },
    });
    const md = renderRoadmapMd(plan);
    assert.ok(!md.includes("## Cross-Repo Dependencies"), "section must be absent when cross_repo is empty");
  });

  it("omits Cross-Repo Dependencies section when cross_repo is undefined (legacy plans)", () => {
    const plan = makePlan();
    // dependency_graph from makePlan() does not include cross_repo at all — runtime undefined.
    const md = renderRoadmapMd(plan);
    assert.ok(!md.includes("## Cross-Repo Dependencies"), "section must be absent when cross_repo is undefined");
  });

  it("cross_repo entries do not appear in Must Precede section", () => {
    const crossRepo: CrossRepoDep[] = [
      { local_issue: 7, repo: "acme/lib", direction: "depended_on_by", rationale: "test" },
    ];
    const plan = makePlan({
      dependency_graph: {
        must_precede: [], should_precede: [], parallel_safe: [],
        blocked_pending_decision: [], duplicate_merge: [], conflict_pairs: [],
        cycle_reports: [], open_questions: [], cross_repo: crossRepo,
      },
    });
    const md = renderRoadmapMd(plan);
    const mustPrecedeIdx = md.indexOf("## Dependency Graph");
    const crossRepoIdx = md.indexOf("## Cross-Repo Dependencies");
    // Cross-repo section must appear after dependency graph section (if it appears)
    if (mustPrecedeIdx >= 0 && crossRepoIdx >= 0) {
      assert.ok(crossRepoIdx > mustPrecedeIdx, "cross-repo section must appear after dep graph");
    }
    // The annotation entry must appear in the cross-repo section, not duplicate into dep graph
    const crossRepoSection = md.slice(crossRepoIdx);
    assert.ok(crossRepoSection.includes("acme/lib"), "repo name must appear in cross-repo section");
  });
});
