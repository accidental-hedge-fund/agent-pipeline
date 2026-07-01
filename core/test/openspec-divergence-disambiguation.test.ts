// OpenSpec spec-divergence disambiguation (#356).
//
// The consistency guard previously treated any stale-delta + category:spec-divergence
// as a blocker, regardless of which direction the divergence flows. This conflated two
// distinct situations:
//   - code-behind-spec: the active spec already requires the behavior; the fix round
//     is expected to change implementation. Blocking is wrong (the #849 failure mode).
//   - spec-behind-code: the accepted implementation moved past the active delta; the
//     spec delta itself must be updated before archiving.
//
// These tests cover the direction signal (emit + read), guard disambiguation, bounded
// repair orchestration, and direction-specific block reasons.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPEC_DIVERGENCE_CATEGORY,
  categoryMarker,
  directionMarker,
  extractSpecDivergenceDirection,
  reviewCommentFlagsSpecDivergence,
} from "../scripts/review-policy.ts";
import {
  codeAlignmentBlockReason,
  enforceSpecConsistencyGuard,
  specDeltaAlignmentBlockReason,
  specDeltaIsStale,
  type BoundedRepairResult,
  type FixCommit,
  type SpecConsistencyDeps,
} from "../scripts/openspec-consistency.ts";
import { formatReviewComment } from "../scripts/stages/review-rendering.ts";
import {
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig, ReviewFinding, ReviewVerdict } from "../scripts/types.ts";

const cfg = { base_branch: "main", repo: "acme/x", repo_dir: "/repo" } as unknown as PipelineConfig;
const ID = "disambiguate-spec-divergence";

const impl = (sha: string): FixCommit => ({ sha, paths: ["core/scripts/foo.ts"] });
const spec = (sha: string): FixCommit => ({ sha, paths: [`openspec/changes/${ID}/specs/cap/spec.md`] });

// ---- 6.1 Direction marker: emit + read round-trip ----

test("directionMarker: renders backtick-wrapped token for each direction", () => {
  assert.equal(directionMarker("code-behind-spec"), "`direction: code-behind-spec`");
  assert.equal(directionMarker("spec-behind-code"), "`direction: spec-behind-code`");
});

test("extractSpecDivergenceDirection: reads code-behind-spec from body", () => {
  const body = `some text ${directionMarker("code-behind-spec")} more text`;
  assert.equal(extractSpecDivergenceDirection(body), "code-behind-spec");
});

test("extractSpecDivergenceDirection: reads spec-behind-code from body", () => {
  const body = `some text ${directionMarker("spec-behind-code")} more text`;
  assert.equal(extractSpecDivergenceDirection(body), "spec-behind-code");
});

test("extractSpecDivergenceDirection: unclassified body yields null", () => {
  const body = `## Review 2 — needs-attention\n${categoryMarker(SPEC_DIVERGENCE_CATEGORY)}\nno direction here`;
  assert.equal(extractSpecDivergenceDirection(body), null);
});

test("extractSpecDivergenceDirection: prose-only mention yields null (drift-guard)", () => {
  const proseBody = [
    "## Review 2 — needs-attention",
    "The code is behind the spec. The spec is stale relative to the code.",
    "spec-behind-code and code-behind-spec are mentioned in prose but no marker.",
  ].join("\n");
  assert.equal(extractSpecDivergenceDirection(proseBody), null,
    "prose mention of direction tokens must NOT be treated as a structured marker");
});

test("formatReviewComment: renders direction marker for spec-divergence finding with direction set", () => {
  const verdict: ReviewVerdict & { _raw?: string } = {
    verdict: "needs-attention",
    summary: "divergence found",
    findings: [{
      severity: "high",
      title: "impl missing isolation",
      body: "the implementation does not isolate per contract",
      confidence: 0.9,
      recommendation: "add isolation",
      category: SPEC_DIVERGENCE_CATEGORY,
      spec_divergence_direction: "code-behind-spec",
    }],
    next_steps: [],
    commitSha: "",
  };
  const comment = formatReviewComment(verdict, 2, "reviewer-bot");
  assert.ok(comment.includes(categoryMarker(SPEC_DIVERGENCE_CATEGORY)),
    "category marker must be present");
  assert.ok(comment.includes(directionMarker("code-behind-spec")),
    "direction marker must be rendered for spec-divergence finding with direction");
});

test("formatReviewComment: no direction marker when spec_divergence_direction is absent", () => {
  const verdict: ReviewVerdict & { _raw?: string } = {
    verdict: "needs-attention",
    summary: "divergence found",
    findings: [{
      severity: "high",
      title: "impl missing isolation",
      body: "the implementation does not isolate per contract",
      confidence: 0.9,
      recommendation: "add isolation",
      category: SPEC_DIVERGENCE_CATEGORY,
    }],
    next_steps: [],
    commitSha: "",
  };
  const comment = formatReviewComment(verdict, 2, "reviewer-bot");
  assert.ok(comment.includes(categoryMarker(SPEC_DIVERGENCE_CATEGORY)),
    "category marker must be present");
  assert.ok(!comment.includes("`direction:"),
    "direction marker must NOT be rendered when spec_divergence_direction is absent");
});

test("formatReviewComment: no direction marker for non-spec-divergence category", () => {
  const verdict: ReviewVerdict & { _raw?: string } = {
    verdict: "needs-attention",
    summary: "correctness issue",
    findings: [{
      severity: "medium",
      title: "off-by-one",
      body: "the loop iterates one too many times",
      confidence: 0.8,
      recommendation: "fix the loop bound",
      category: "correctness",
      spec_divergence_direction: "code-behind-spec" as ReviewFinding["spec_divergence_direction"],
    }],
    next_steps: [],
    commitSha: "",
  };
  const comment = formatReviewComment(verdict, 2, "reviewer-bot");
  assert.ok(!comment.includes("`direction:"),
    "direction marker must NOT be rendered for non-spec-divergence category");
});

// ---- 6.2 Post-fix evaluation ----

test("post-fix evaluation: pre-fix code-behind-spec marker resolved by fix round — guard returns null", async () => {
  // Scenario: review said code-behind-spec (pre-fix), fix commit changed impl after spec.
  // The structural check says stale (impl after spec), but direction is code-behind-spec
  // → the fix is expected to change impl → not stale in the direction sense → advance.
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    `**1. [HIGH] impl missing isolation** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("code-behind-spec")}`,
  ].join("\n");
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")], // impl after spec → stale structurally
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "2024-01-02T00:00:00Z" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async () => {}) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.equal(out, null, "code-behind-spec direction + structural stale → must NOT block (guard returns null)");
});

test("post-fix evaluation: spec-behind-code divergence at post-fix head is unresolved", async () => {
  // Scenario: review says spec-behind-code, impl changed after spec → stale + direction
  // means the spec delta is still stale at post-fix head → should block.
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    `**1. [HIGH] spec is stale** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");
  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked",
    "spec-behind-code direction + structural stale → must block");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /spec-delta alignment/);
});

// ---- 6.3 Regression: #849 shape ----

test("regression #849: active spec requires behavior, review flags impl as code-behind-spec, fix changes impl → advance", async () => {
  // This is the #849 failure mode: the pipeline was blocking with openspec-stale-delta
  // even though the spec was correct and the fix round was supposed to change impl.
  //
  // Setup: spec commit then impl commit (structural stale), review says code-behind-spec.
  // Expected: guard returns null (advance), not blocked.
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    "",
    "**1. [HIGH] per-contract chat isolation missing** `override-key: deadbeef`",
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("code-behind-spec")}`,
    "The spec already requires per-contract isolation; the implementation does not enforce it.",
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    // Commits: spec was written first, then impl fix (fix round changed impl only)
    branchDeveloperCommits: async () => [spec("spec1"), impl("impl-fix")],
    getIssueDetail: (async () => ({
      comments: [{ author: "pipeline", body: reviewBody, createdAt: "2024-02-01T00:00:00Z" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.equal(out, null,
    "guard must return null (advance) when direction is code-behind-spec — this was the #849 false block");
  assert.deepEqual(blocked, [], "setBlocked must NOT be called for code-behind-spec direction");
});

// ---- 6.4 Regression: true stale-delta shape ----

test("true stale-delta: spec-behind-code + successful code-frozen repair → guard clears", async () => {
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    pipelineRunId: "356/run1",
    attemptBoundedRepair: async () => "cleared",
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.equal(out, null,
    "guard must return null (advance) after a successful bounded spec-delta repair");
  assert.deepEqual(blocked, [], "setBlocked must NOT be called when repair succeeds");
});

test("true stale-delta: spec-behind-code + repair cannot be verified without code changes → blocks", async () => {
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    pipelineRunId: "356/run1",
    attemptBoundedRepair: async () => "not-verifiable",
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked",
    "must block when repair cannot be verified without code changes");
  assert.equal(out.blockerKind, "openspec-stale-delta");
  assert.match(blocked[0], /spec-delta alignment/);
  assert.match(blocked[0], /cannot be verified without also changing application code/);
});

test("true stale-delta: no repair dep provided → blocks immediately with spec-delta reason", async () => {
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    // No attemptBoundedRepair dep → skip repair and block immediately
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.equal(out.blockerKind, "openspec-stale-delta");
  assert.match(blocked[0], /spec-delta alignment/);
});

// ---- 6.5 Bounded repair orchestration ----

test("bounded repair: disallowed-file result → blocked with disallowed reason", async () => {
  const reviewBody = [
    "## Review 2 — needs-attention",
    `${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [impl("a")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    attemptBoundedRepair: async () => "disallowed-files",
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.match(blocked[0], /spec-delta alignment/);
  assert.match(blocked[0], /outside the allowed set/);
});

test("bounded repair: invalid openspec result → blocked with invalid reason", async () => {
  const reviewBody = [
    "## Review 2 — needs-attention",
    `${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  const repairCalls: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [impl("a")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    attemptBoundedRepair: async (changeId, _issueNum, _runId) => {
      repairCalls.push(changeId);
      return "invalid";
    },
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.deepEqual(repairCalls, [ID], "repair must be attempted with the stale change ID");
  assert.match(blocked[0], /spec-delta alignment/);
  assert.match(blocked[0], /invalid OpenSpec/);
});

test("bounded repair: repair bounded to one attempt (already-attempted → block immediately)", async () => {
  const reviewBody = [
    "## Review 2 — needs-attention",
    `${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  let repairCount = 0;
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [impl("a")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    attemptBoundedRepair: async () => {
      repairCount++;
      return "already-attempted";
    },
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.equal(repairCount, 1, "repair dep is called exactly once even when it reports already-attempted");
  assert.match(blocked[0], /spec-delta alignment/);
  assert.match(blocked[0], /second automatic attempt is not allowed/);
});

test("bounded repair: still-stale after repair → block with still-stale reason", async () => {
  const reviewBody = [
    "## Review 2 — needs-attention",
    `${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [impl("a")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    attemptBoundedRepair: async () => "still-stale",
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.match(blocked[0], /stale-delta guard still shows/);
});

// ---- 6.6 Block reasons ----

test("block reasons: specDeltaAlignmentBlockReason states spec-delta alignment for each repair result", () => {
  const reasons: Array<[BoundedRepairResult | null, RegExp]> = [
    [null, /spec-delta alignment/],
    ["disallowed-files", /outside the allowed set/],
    ["invalid", /invalid OpenSpec/],
    ["still-stale", /stale-delta guard still shows/],
    ["not-verifiable", /cannot be verified without also changing application code/],
    ["already-attempted", /second automatic attempt is not allowed/],
    ["error", /unexpected error/],
  ];
  for (const [result, pattern] of reasons) {
    const reason = specDeltaAlignmentBlockReason(ID, result);
    assert.match(reason, /spec-delta alignment/, `repair result ${String(result)}: must mention 'spec-delta alignment'`);
    assert.match(reason, pattern, `repair result ${String(result)}: must match specific pattern`);
  }
});

test("block reasons: codeAlignmentBlockReason mentions code alignment and direction", () => {
  const reason = codeAlignmentBlockReason(ID);
  assert.match(reason, /code alignment/i);
  assert.match(reason, /code-behind-spec/);
  assert.match(reason, /implementation must be changed/);
});

// ---- Guard invariants (ensure no regression on existing behavior) ----

test("guard: no developer commits → not blocked (invariant)", async () => {
  const reviewBody = `${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`;
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async () => {}) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  assert.equal(await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps), null);
});

test("guard: spec updated after impl → not stale → not blocked even with spec-behind-code marker", async () => {
  const reviewBody = `${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`;
  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [impl("a"), spec("b")], // spec after impl → NOT stale
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.equal(out, null, "not stale → must not block even with spec-behind-code");
  assert.deepEqual(blocked, []);
});

test("guard: stale but no spec-divergence marker in latest review → not blocked", async () => {
  const noMarkerBody = "## Review 2 (Adversarial) — needs-attention\n\nAll good.";
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: noMarkerBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async () => {}) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  assert.equal(await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps), null);
});

test("guard: guard runs at pre-merge time via maybeArchiveOpenspec (stale-delta guard active)", async () => {
  // Verify the guard is still active at archive time: spec-behind-code stale delta
  // must block before archive is called.
  const reviewBody = [
    "## Review 2 (Adversarial) — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: deadbeef\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const archiveCalls: string[] = [];
  const blocked: string[] = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_wt: string, args: string[]) => {
      if (args[0] === "diff" && args.some((a: string) => a.includes("..."))) {
        return { stdout: `openspec/changes/${ID}/specs/cap/spec.md`, stderr: "", code: 0 };
      }
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    branchDeveloperCommits: async () => [spec("s"), impl("i")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as AdvancePreMergeDeps["setBlocked"],
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
  };

  const out = await maybeArchiveOpenspec(cfg, 1, "run", deps);
  assert.ok(out && !out.advanced && out.status === "blocked",
    "stale-delta guard must block at pre-merge when direction is spec-behind-code");
  assert.deepEqual(archiveCalls, [], "archive must NOT run when the guard blocks");
  assert.match(blocked[0], /spec-delta alignment/);
});

// ---- Finding 2 regression: pre-fix marker staleness (#356) ----

test("regression finding-2: spec-behind-code marker from pre-fix review does not block when review SHA predates HEAD", async () => {
  // Scenario: review was done on commit "review-sha-old", then a fix commit
  // landed ("fix-sha-new"). The review body carries <!-- reviewed-sha: review-sha-old -->.
  // The guard must NOT block because the direction marker predates the fix commit.
  const OLD_SHA = "aabbccddeeff00112233445566778899aabbccdd";
  const NEW_SHA = "1122334455667788990011223344556677889900";
  const reviewBody = [
    "## Review 1 — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
    "",
    `<!-- reviewed-sha: ${OLD_SHA} -->`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl(NEW_SHA)], // impl after spec → stale structurally
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    getHeadSha: async () => NEW_SHA, // HEAD is the fix commit, not the reviewed commit
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.equal(out, null,
    "guard must return null (advance) when the spec-behind-code marker is from a pre-fix review");
  assert.deepEqual(blocked, [], "setBlocked must NOT be called for a stale pre-fix marker");
});

test("regression finding-2: spec-behind-code marker is valid when review SHA matches HEAD", async () => {
  // Scenario: review was done on the current HEAD; the direction marker is fresh.
  // The guard must block (the spec is genuinely stale at the current head).
  const HEAD_SHA = "aabbccddeeff00112233445566778899aabbccdd";
  const reviewBody = [
    "## Review 1 — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: abc12345\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
    "",
    `<!-- reviewed-sha: ${HEAD_SHA} -->`,
  ].join("\n");

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [spec("a"), impl("b")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c: unknown, _n: unknown, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
    getHeadSha: async () => HEAD_SHA, // HEAD matches the reviewed SHA → marker is current
  };

  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked",
    "guard must block when the review SHA matches HEAD and direction is spec-behind-code");
  assert.match(blocked[0], /spec-delta alignment/);
});

// ---- Finding 1 production-path: repair dep is wired at pre-merge (#356) ----

test("production path (pre-merge): maybeArchiveOpenspec calls attemptBoundedRepair for spec-behind-code", async () => {
  // Verify that maybeArchiveOpenspec wires the repair dep. When deps.attemptBoundedRepair
  // is provided, the guard must call it (not block immediately without attempting repair).
  const reviewBody = [
    "## Review 2 — needs-attention",
    `**1. [HIGH] spec stale** \`override-key: deadbeef\``,
    ` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}`,
  ].join("\n");

  const repairCalls: string[] = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_wt: string, args: string[]) => {
      if (args[0] === "diff" && args.some((a: string) => a.includes("..."))) {
        return { stdout: `openspec/changes/${ID}/specs/cap/spec.md`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    branchDeveloperCommits: async () => [spec("s"), impl("i")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewBody, createdAt: "t" }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    setBlocked: (async () => {}) as AdvancePreMergeDeps["setBlocked"],
    openspecArchive: (async () => ({ success: true, unavailable: false, output: "" })) as AdvancePreMergeDeps["openspecArchive"],
    // Production-path test: inject a fake repair dep to prove it is wired and called.
    attemptBoundedRepair: async (changeId) => {
      repairCalls.push(changeId);
      return "still-stale"; // block after repair attempt
    },
  };

  const out = await maybeArchiveOpenspec(cfg, 1, "run", deps);
  assert.deepEqual(repairCalls, [ID], "maybeArchiveOpenspec must call attemptBoundedRepair for spec-behind-code");
  assert.ok(out && !out.advanced && out.status === "blocked",
    "must block when repair returns still-stale");
  assert.match(out.reason ?? "", /stale-delta guard still shows/);
});
