// Tests for roadmap/writeback.ts (#171)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hygieneActionHash,
  hygieneSentinel,
  writePlanJson,
  renderRoadmapMd,
  writeRoadmapMd,
  applyHygiene,
} from "../scripts/roadmap/writeback.ts";
import type { HygieneItem, PlanJson } from "../scripts/roadmap/types.ts";
import type { WritebackDeps } from "../scripts/roadmap/writeback.ts";

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
    gitCreateBranch: async () => {},
    gitCommit: async () => {},
    gitPushBranch: async () => {},
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
