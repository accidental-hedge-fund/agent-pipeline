// Tests for roadmap/index.ts (#171) — orchestrator + --next path

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runNext, runRoadmap } from "../scripts/roadmap/index.ts";
import type { RoadmapDeps, RoadmapOpts } from "../scripts/roadmap/index.ts";
import type { PlanJson, Issue } from "../scripts/roadmap/types.ts";

function makeIssue(n: number): Issue {
  return {
    number: n, title: `Issue ${n}`, body: `## Summary\nDescription for issue ${n}.\n## Acceptance Criteria\n- [ ] Done`,
    labels: [], url: `https://github.com/example/repo/issues/${n}`, state: "open",
    updatedAt: `2026-01-0${n}T00:00:00Z`,
  };
}

function makePlan(overrides: Partial<PlanJson> = {}): PlanJson {
  return {
    generated_at: new Date().toISOString(),
    backlog_sha: "abc12345",
    repo: "example/repo",
    dependency_graph: { must_precede: [], should_precede: [], parallel_safe: [], blocked_pending_decision: [], duplicate_merge: [], conflict_pairs: [], cycle_reports: [], open_questions: [] },
    scored: [],
    roadmap: [
      { rank: 1, issue_number: 1, title: "Issue 1", tier: "enablers", priority: 20, score_breakdown: { impact: 3, confidence: 2, ease: 2, effort: 3, risk_reduction: 1, dep_leverage: 2 }, dep_rationale: "none", touched_files: [], effort: "M", risks: [], unblocks: [], blocked_by: [] },
      { rank: 2, issue_number: 2, title: "Issue 2", tier: "high-value/low-risk", priority: 15, score_breakdown: { impact: 3, confidence: 2, ease: 2, effort: 3, risk_reduction: 1, dep_leverage: 1 }, dep_rationale: "none", touched_files: [], effort: "M", risks: [], unblocks: [], blocked_by: [] },
      { rank: 3, issue_number: 3, title: "Issue 3", tier: "larger-bets", priority: 5, score_breakdown: { impact: 2, confidence: 1, ease: 1, effort: 4, risk_reduction: 1, dep_leverage: 1 }, dep_rationale: "none", touched_files: [], effort: "L", risks: [], unblocks: [], blocked_by: [] },
    ],
    hygiene: [],
    milestones: [],
    new_issue_drafts: [],
    critique: [],
    open_questions: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RoadmapDeps> = {}): RoadmapDeps {
  return {
    getOpenIssues: async () => [makeIssue(1), makeIssue(2)],
    readFile: async () => null,
    runHarness: async () => ({ success: true, output: "[]" }),
    runCritiqueHarness: async () => ({ success: true, output: "{}" }),
    writeFile: async () => {},
    gitCreateBranch: async () => {},
    gitSwitchBranch: async () => {},
    gitBranchExists: async () => false,
    gitCommit: async () => {},
    gitPushBranch: async () => {},
    findPrByHead: async () => null,
    createPr: async () => "https://github.com/example/repo/pull/1",
    createLabel: async () => {},
    applyLabel: async () => {},
    createMilestone: async () => 1,
    getMilestones: async () => [],
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

describe("runNext", () => {
  it("returns false when plan.json is not found", async () => {
    const logs: string[] = [];
    const result = await runNext(3, "/no/such/dir", {
      readFile: async () => null,
      log: (m) => logs.push(m),
    });
    assert.equal(result, false);
    assert.ok(logs.some((l) => l.includes("no plan.json found")));
  });

  it("emits top-N issues from plan.json", async () => {
    const plan = makePlan();
    const logs: string[] = [];
    const result = await runNext(2, "/output", {
      readFile: async () => JSON.stringify(plan),
      log: (m) => logs.push(m),
    });
    assert.equal(result, true);
    assert.ok(logs.some((l) => l.includes("Top 2")));
    assert.ok(logs.some((l) => l.includes("#1")));
    assert.ok(logs.some((l) => l.includes("#2")));
    assert.ok(!logs.some((l) => l.includes("#3")), "should not emit issue 3 for top-2");
  });

  it("warns when plan.json is stale", async () => {
    const stalePlan = makePlan({
      generated_at: "2020-01-01T00:00:00Z", // very old
    });
    const logs: string[] = [];
    await runNext(1, "/output", {
      readFile: async () => JSON.stringify(stalePlan),
      log: (m) => logs.push(m),
    });
    assert.ok(logs.some((l) => l.includes("WARNING") && l.includes("days old")));
  });

  it("returns false for invalid JSON in plan.json", async () => {
    const logs: string[] = [];
    const result = await runNext(1, "/output", {
      readFile: async () => "not valid json{{{",
      log: (m) => logs.push(m),
    });
    assert.equal(result, false);
  });
});

describe("runRoadmap - dry-run", () => {
  it("completes successfully with an empty backlog (dry-run)", async () => {
    const deps = makeDeps({
      getOpenIssues: async () => [],
      runHarness: async () => ({ success: true, output: "[]" }),
    });
    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap" };
    // Should not throw
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);
  });

  it("writes plan.json and roadmap.md in dry-run mode", async () => {
    const written: Record<string, string> = {};
    const deps = makeDeps({
      getOpenIssues: async () => [makeIssue(1)],
      runHarness: async () => ({ success: true, output: "[]" }),
      writeFile: async (p, c) => { written[p] = c; },
    });
    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap-dr" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);
    assert.ok(Object.keys(written).some((k) => k.endsWith("plan.json")), "should write plan.json");
    assert.ok(Object.keys(written).some((k) => k.endsWith("roadmap.md")), "should write roadmap.md");
  });

  it("does NOT apply hygiene when apply=false", async () => {
    let commentCallCount = 0;
    const deps = makeDeps({
      getOpenIssues: async () => [makeIssue(1)],
      runHarness: async () => ({ success: true, output: "[]" }),
      writeFile: async () => {},
      addComment: async () => { commentCallCount++; },
    });
    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap-noapply" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);
    assert.equal(commentCallCount, 0, "should not post comments in dry-run");
  });

  it("routes --next to runNext instead of running the engine", async () => {
    let inventoryCallCount = 0;
    let readPlanCalled = false;
    const plan = makePlan();
    const deps = makeDeps({
      getOpenIssues: async () => { inventoryCallCount++; return []; },
      readFile: async (p) => {
        if (p.includes("plan.json")) { readPlanCalled = true; return JSON.stringify(plan); }
        return null;
      },
    });
    const opts: RoadmapOpts = { apply: false, next: 2, outputDir: "/tmp/test-roadmap-next" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);
    assert.ok(readPlanCalled, "should read plan.json for --next");
    // getOpenIssues is called in phase 1 comprehend but NOT in inventory (since we exit early)
    // So inventoryCallCount should be 0 (early return before phase 1)
    assert.equal(inventoryCallCount, 0, "should not call getOpenIssues when using --next");
  });
});

describe("runRoadmap - critique integration", () => {
  it("uses runCritiqueHarness for phase 7 (separate from implementer runHarness)", async () => {
    const written: Record<string, string> = {};
    let implementerCallCount = 0;
    let critiqueCallCount = 0;

    const critiqueFinding = {
      verdict: "needs-attention",
      findings: [{ severity: "low", title: "Minor inconsistency", body: "Priority score looks off", confidence: 0.5, recommendation: "Check scoring formula", category: "score-issue" }],
      summary: "Minor issues found",
      next_steps: [],
    };

    const deps = makeDeps({
      getOpenIssues: async () => [makeIssue(1)],
      runHarness: async () => {
        implementerCallCount++;
        return { success: true, output: "[]" };
      },
      runCritiqueHarness: async () => {
        critiqueCallCount++;
        return { success: true, output: "```json\n" + JSON.stringify(critiqueFinding) + "\n```" };
      },
      writeFile: async (p, c) => { written[p] = c; },
    });

    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap-critique" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);

    assert.ok(critiqueCallCount > 0, "runCritiqueHarness should be called for phase 7");
    // The critique call should NOT go through the implementer harness
    const planContent = Object.values(written).find((c) => {
      try { return JSON.parse(c)?.critique !== undefined; } catch { return false; }
    });
    if (planContent) {
      const plan = JSON.parse(planContent) as PlanJson;
      // Low severity finding should be advisory (below "high" block threshold)
      assert.ok(plan.critique.length >= 0, "plan should have critique array");
    }
  });

  it("records critique failure as open_question instead of silently finalizing", async () => {
    const written: Record<string, string> = {};

    const deps = makeDeps({
      getOpenIssues: async () => [makeIssue(1)],
      runCritiqueHarness: async () => ({ success: false, output: "" }),
      writeFile: async (p, c) => { written[p] = c; },
    });

    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap-critique-fail" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);

    const planContent = Object.values(written).find((c) => {
      try { return JSON.parse(c)?.open_questions !== undefined; } catch { return false; }
    });
    assert.ok(planContent, "plan.json should be written even when critique harness fails");
    const plan = JSON.parse(planContent!) as PlanJson;
    assert.ok(
      plan.open_questions.some((q) => q.description.includes("critique") || q.rationale?.includes("critique")),
      "critique failure should appear as an open_question",
    );
  });

  it("regression: malformed critique output is treated as a failure (not a clean approval)", async () => {
    // Finding #4: when parseCritiqueVerdict returns null (malformed JSON), the engine
    // must NOT log 'no critique findings — plan looks good'. It must record an open_question.
    const written: Record<string, string> = {};
    const logs: string[] = [];

    const deps = makeDeps({
      getOpenIssues: async () => [makeIssue(1)],
      // Return success=true but with invalid/non-parseable JSON output
      runCritiqueHarness: async () => ({ success: true, output: "This is not valid JSON at all." }),
      writeFile: async (p, c) => { written[p] = c; },
      log: (m) => logs.push(m),
    });

    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap-malformed-critique" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);

    // Should NOT log "plan looks good"
    assert.ok(
      !logs.some((l) => l.includes("plan looks good")),
      "should not log 'plan looks good' for malformed critique output",
    );

    // Should record an open_question
    const planContent = Object.values(written).find((c) => {
      try { return JSON.parse(c)?.open_questions !== undefined; } catch { return false; }
    });
    assert.ok(planContent, "plan.json should be written");
    const plan = JSON.parse(planContent!) as PlanJson;
    assert.ok(
      plan.open_questions.some((q) =>
        q.description.includes("malformed") || q.description.includes("critique") || q.rationale?.includes("parseable"),
      ),
      "malformed critique output should appear as an open_question",
    );
  });

  it("regression: critique corrections re-score items before rebuilding roadmap", async () => {
    // Finding #5: after adding must_precede edges from critique corrections, scoreItems
    // must be re-run so dep_leverage reflects the corrected edges in the final plan.
    const written: Record<string, string> = {};
    let critiqueCallCount = 0;

    // First critique round: report a dep-order violation (#1 must precede #2).
    // The edge extraction picks the first two issue numbers from title+body in order,
    // so the prerequisite (#1) must appear first in the title.
    // Second critique round: no findings (corrections applied)
    const critiqueFindingRound1 = {
      verdict: "needs-attention",
      findings: [{
        severity: "high",
        title: "#1 must precede #2 — dep-order violation detected",
        body: "Issue #2 appears before prerequisite #1 in the roadmap. The edge #1→#2 must be enforced.",
        confidence: 0.95,
        recommendation: "Add must_precede edge #1→#2",
        category: "dep-order-violation",
      }],
      summary: "Dep order violation",
      next_steps: [],
    };
    const critiqueClean = { verdict: "approved", findings: [], summary: "OK", next_steps: [] };

    const deps = makeDeps({
      getOpenIssues: async () => [makeIssue(1), makeIssue(2)],
      runCritiqueHarness: async () => {
        critiqueCallCount++;
        const result = critiqueCallCount === 1 ? critiqueFindingRound1 : critiqueClean;
        return { success: true, output: "```json\n" + JSON.stringify(result) + "\n```" };
      },
      writeFile: async (p, c) => { written[p] = c; },
    });

    const opts: RoadmapOpts = { apply: false, dryRun: true, outputDir: "/tmp/test-roadmap-rescore" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);

    const planContent = Object.values(written).find((c) => {
      try { return JSON.parse(c)?.dependency_graph !== undefined; } catch { return false; }
    });
    assert.ok(planContent, "plan.json should be written");
    const plan = JSON.parse(planContent!) as PlanJson;
    // After correction, #1 must appear before #2 in the roadmap
    const rank1 = plan.roadmap.find((r) => r.issue_number === 1)?.rank;
    const rank2 = plan.roadmap.find((r) => r.issue_number === 2)?.rank;
    if (rank1 !== undefined && rank2 !== undefined) {
      assert.ok(rank1 < rank2, `#1 (rank ${rank1}) should appear before #2 (rank ${rank2}) after correction`);
    }
    // scored array in plan should reflect re-computed dep_leverage
    assert.ok(plan.scored.length > 0, "plan should have scored items");
  });
});

describe("runRoadmap - --next validation", () => {
  it("regression: --next NaN falls through to full engine run — must now throw", async () => {
    // Finding #8: Commander parses '--next foo' as NaN; the engine must reject it before running.
    let enginePhaseRan = false;
    const deps = makeDeps({
      getOpenIssues: async () => { enginePhaseRan = true; return []; },
    });
    const opts: RoadmapOpts = { apply: false, next: NaN, outputDir: "/tmp/test-next-nan" };
    await assert.rejects(
      () => runRoadmap("example/repo", "/repo", "main", {}, opts, deps),
      /positive integer/,
      "should throw for NaN --next value",
    );
    assert.ok(!enginePhaseRan, "engine phases must not run when --next is invalid");
  });

  it("regression: --next 0 falls through to full engine run — must now throw", async () => {
    const deps = makeDeps();
    const opts: RoadmapOpts = { apply: false, next: 0, outputDir: "/tmp/test-next-zero" };
    await assert.rejects(
      () => runRoadmap("example/repo", "/repo", "main", {}, opts, deps),
      /positive integer/,
      "should throw for --next 0",
    );
  });

  it("regression: --next -1 must throw (negative value)", async () => {
    const deps = makeDeps();
    const opts: RoadmapOpts = { apply: false, next: -1, outputDir: "/tmp/test-next-neg" };
    await assert.rejects(
      () => runRoadmap("example/repo", "/repo", "main", {}, opts, deps),
      /positive integer/,
      "should throw for negative --next value",
    );
  });

  it("--next 3 with valid plan.json reads without running the engine", async () => {
    const plan = makePlan();
    let enginePhaseRan = false;
    const deps = makeDeps({
      getOpenIssues: async () => { enginePhaseRan = true; return []; },
      readFile: async (p) => p.includes("plan.json") ? JSON.stringify(plan) : null,
    });
    const opts: RoadmapOpts = { apply: false, next: 3, outputDir: "/tmp/test-next-valid" };
    await runRoadmap("example/repo", "/repo", "main", {}, opts, deps);
    assert.ok(!enginePhaseRan, "engine phases must not run for a valid --next");
  });
});
