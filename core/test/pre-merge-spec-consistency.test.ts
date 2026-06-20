// OpenSpec spec/code consistency guard (#106). The guard blocks a stale-delta
// archive ONLY when a deterministic file-path check (code moved after the last
// spec change) AND a STRUCTURED `category: spec-divergence` finding marker are
// both present. It must never key off the reviewer's free-text prose — that was
// the adversarially-unwinnable failure of the superseded PR #109.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceSpecConsistencyGuard,
  maybeArchiveOpenspec,
  specDeltaIsStale,
  type AdvancePreMergeDeps,
  type FixCommit,
  type SpecConsistencyDeps,
} from "../scripts/stages/pre_merge.ts";
import { SPEC_DIVERGENCE_CATEGORY, categoryMarker } from "../scripts/review-policy.ts";
import { DELTA_REVIEW_MARKER_PREFIX } from "../scripts/stages/review.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const cfg = { base_branch: "main", repo: "acme/x", repo_dir: "/repo" } as unknown as PipelineConfig;
const ID = "c106";
const impl = (sha: string): FixCommit => ({ sha, paths: ["core/scripts/foo.ts"] });
const spec = (sha: string): FixCommit => ({ sha, paths: [`openspec/changes/${ID}/specs/cap/spec.md`] });

// A review comment as formatReviewComment would render it: the structured marker
// lives in a finding line. The prose-only variant *describes* divergence but
// carries no marker.
const findingLine = (extra: string) =>
  `## Review 2 (Adversarial) — needs-attention\n\n### Findings\n\n**1. [HIGH] x** \`override-key: abc12345\`${extra}\n`;
const reviewWithMarker = findingLine(` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)}`);
const reviewProseOnly =
  `## Review 2 (Adversarial) — needs-attention\n\n### Findings\n\n` +
  `**1. [HIGH] the code diverges from the spec and is inconsistent with the requirement** \`override-key: abc12345\`\n`;

// ---- specDeltaIsStale (pure, order-aware) ----

test("specDeltaIsStale: impl changed, spec never touched → stale", () => {
  assert.equal(specDeltaIsStale(ID, [impl("a")]), true);
});
test("specDeltaIsStale: spec updated AFTER the last impl change → not stale", () => {
  assert.equal(specDeltaIsStale(ID, [impl("a"), spec("b")]), false);
});
test("specDeltaIsStale: impl changed AFTER the last spec update → stale (order-aware)", () => {
  assert.equal(specDeltaIsStale(ID, [spec("a"), impl("b")]), true);
});
test("specDeltaIsStale: no impl change, or empty → not stale", () => {
  assert.equal(specDeltaIsStale(ID, [spec("a")]), false);
  assert.equal(specDeltaIsStale(ID, []), false);
});

// ---- enforceSpecConsistencyGuard ----

function guardDeps(commits: FixCommit[], reviewBody: string | null): {
  deps: SpecConsistencyDeps;
  blocked: string[];
} {
  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => commits,
    getIssueDetail: (async () => ({
      comments: reviewBody ? [{ author: "r", body: reviewBody, createdAt: "t" }] : [],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c, _n, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  return { deps, blocked };
}

test("guard: stale + finding tagged category:spec-divergence → blocked", async () => {
  const { deps, blocked } = guardDeps([impl("a")], reviewWithMarker);
  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /stale spec delta/);
});

test("guard: stale but divergence only in PROSE (no marker) → NOT blocked — the gate ignores prose", async () => {
  const { deps, blocked } = guardDeps([impl("a")], reviewProseOnly);
  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.equal(out, null, "a prose mention of 'diverges/inconsistent' must NOT drive the gate");
  assert.deepEqual(blocked, []);
});

test("guard: not stale (spec updated after impl) → not blocked even with the marker", async () => {
  const { deps } = guardDeps([impl("a"), spec("b")], reviewWithMarker);
  assert.equal(await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps), null);
});

test("guard: no developer commits → not blocked", async () => {
  const { deps } = guardDeps([], reviewWithMarker);
  assert.equal(await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps), null);
});

// Regression test for #228 finding 1: the stale-delta guard must read the LATEST
// review comment, including pre-merge delta reviews. If the latest comment is a delta
// review carrying `category: spec-divergence` and the prior full Review 2 does NOT
// carry the marker, the guard must still block (not fall through to the old comment).
test("guard: latest delta review has spec-divergence marker but older Review 2 does not → blocked (#228)", async () => {
  const deltaReviewWithMarker =
    `${DELTA_REVIEW_MARKER_PREFIX} — needs-attention (commit abc1234)\n\n` +
    `### Findings\n\n**1. [HIGH] spec divergence** \`override-key: abc12345\` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)}\n`;
  const olderReview2WithoutMarker = findingLine(""); // no spec-divergence category

  const blocked: string[] = [];
  const deps: SpecConsistencyDeps = {
    branchDeveloperCommits: async () => [impl("a")],
    getIssueDetail: (async () => ({
      comments: [
        { author: "r", body: olderReview2WithoutMarker, createdAt: "2024-01-01T00:00:00Z" },
        { author: "r", body: deltaReviewWithMarker, createdAt: "2024-01-02T00:00:00Z" },
      ],
    })) as unknown as SpecConsistencyDeps["getIssueDetail"],
    setBlocked: (async (_c, _n, reason: string) => {
      blocked.push(reason);
    }) as unknown as SpecConsistencyDeps["setBlocked"],
  };
  const out = await enforceSpecConsistencyGuard(cfg, 1, "/wt", [ID], deps);
  assert.ok(out && !out.advanced && out.status === "blocked",
    "should block because the latest (delta) review has category:spec-divergence");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /stale spec delta/);
});

// ---- computeBranchDeveloperCommits: auto-format commits visible to stale-spec guard (#182 review-2 finding 3) ----
//
// maybeArchiveOpenspec uses deps.branchDeveloperCommits when injected; the
// default implementation is computeBranchDeveloperCommits. We test it indirectly
// here by omitting the dep and providing a gitInWorktree fake that emits an
// auto-format commit alongside a diff touching an implementation file. The guard
// MUST see the commit (so it can detect staleness), verifying that auto-format
// commits are NOT filtered out of the developer-commit list.

test("computeBranchDeveloperCommits (via guard): auto-format commit changing impl files IS visible to stale-spec guard", async () => {
  const blocked: string[] = [];
  // Build a fake log: one auto-format commit that touches an implementation file.
  // gitInWorktree is called for: "diff --name-only" (candidates), "log" (commits), and
  // "diff --name-only sha^..sha" (per-commit paths). We discriminate by the args.
  const fakeGit = (async (_wt: string, args: string[]) => {
    // 1. diff for candidates (three-dot form: origin/main...HEAD)
    if (args[0] === "diff" && args.some((a) => a.includes("..."))) {
      return { stdout: `openspec/changes/${ID}/specs/cap/spec.md`, stderr: "", code: 0 };
    }
    // 2. log to enumerate commits
    if (args[0] === "log") {
      const sha = "autoFmtSha";
      const msg = `chore: auto-format (#42)`;
      return { stdout: `${sha}\x1f${msg}`, stderr: "", code: 0 };
    }
    // 3. per-commit diff (sha^..sha)
    if (args[0] === "diff" && args.some((a) => a.includes("^"))) {
      return { stdout: "core/scripts/foo.ts", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as typeof import("../scripts/worktree.ts").gitInWorktree;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: fakeGit,
    changeDirExists: () => true,
    // No branchDeveloperCommits override → uses computeBranchDeveloperCommits default
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewWithMarker, createdAt: "t" }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    setBlocked: (async (_c, _n, reason: string) => {
      blocked.push(reason);
    }) as AdvancePreMergeDeps["setBlocked"],
    openspecArchive: (async () => ({ success: true, unavailable: false, output: "" })) as AdvancePreMergeDeps["openspecArchive"],
  };

  const out = await maybeArchiveOpenspec(cfg, 1, "run", deps);
  // The auto-format commit changed an impl file → stale-spec guard fires → blocked
  assert.ok(out && !out.advanced && out.status === "blocked",
    `expected blocked outcome; got: ${JSON.stringify(out)}`);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /stale spec delta/);
});

// ---- maybeArchiveOpenspec: archive commit failure blocks and prevents push (#255) ----

test("maybeArchiveOpenspec: archive succeeds but git commit fails → blocked, no push attempted", async () => {
  const blocked: string[] = [];
  let pushCalled = false;
  const COMMIT_STDERR = "pre-commit hook rejected: lint failed";

  const fakeGit = (async (_wt: string, args: string[]) => {
    // candidates diff (three-dot form)
    if (args[0] === "diff" && args.some((a) => a.includes("..."))) {
      return { stdout: `openspec/changes/${ID}/specs/cap/spec.md`, stderr: "", code: 0 };
    }
    // git add -A
    if (args[0] === "add") {
      return { stdout: "", stderr: "", code: 0 };
    }
    // git status --porcelain: non-empty diff so commit is attempted (XY format: 2 status chars + space + path)
    if (args[0] === "status") {
      return { stdout: "M  openspec/specs/openspec-integration/spec.md", stderr: "", code: 0 };
    }
    // git commit: fail with a hook rejection
    if (args[0] === "commit") {
      return { stdout: "", stderr: COMMIT_STDERR, code: 1 };
    }
    // git push: must NOT be called
    if (args[0] === "push") {
      pushCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as typeof import("../scripts/worktree.ts").gitInWorktree;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: fakeGit,
    changeDirExists: () => true,
    branchDeveloperCommits: async () => [], // no stale-delta condition
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    setBlocked: (async (_c, _n, reason: string) => {
      blocked.push(reason);
    }) as AdvancePreMergeDeps["setBlocked"],
    openspecArchive: (async () => ({ success: true, unavailable: false, output: "" })) as AdvancePreMergeDeps["openspecArchive"],
  };

  const out = await maybeArchiveOpenspec(cfg, 1, "run", deps);

  assert.ok(out && !out.advanced && out.status === "blocked",
    `expected blocked outcome; got: ${JSON.stringify(out)}`);
  assert.equal(blocked.length, 1, "setBlocked must be called exactly once");
  assert.match(blocked[0], /archive commit failed/i, "block reason must mention archive commit failure");
  assert.match(blocked[0], new RegExp(COMMIT_STDERR), "block reason must include the commit stderr");
  assert.equal(pushCalled, false, "git push must NOT be called when commit fails");
});

// ---- maybeArchiveOpenspec: pre-archive cleanliness guard (#255 review-2) ----

test("maybeArchiveOpenspec: pre-existing dirty tracked file outside openspec/ → blocked before archive is called", async () => {
  const archiveCalls: string[] = [];
  const blocked: string[] = [];

  const fakeGit = (async (_wt: string, args: string[]) => {
    if (args[0] === "diff" && args.some((a) => a.includes("..."))) {
      return { stdout: `openspec/changes/${ID}/specs/cap/spec.md`, stderr: "", code: 0 };
    }
    // Pre-archive status --porcelain: dirty file outside openspec/ (XY format)
    if (args[0] === "status") {
      return { stdout: " M core/scripts/stages/pre_merge.ts", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as typeof import("../scripts/worktree.ts").gitInWorktree;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: fakeGit,
    changeDirExists: () => true,
    branchDeveloperCommits: async () => [],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    setBlocked: (async (_c, _n, reason: string) => {
      blocked.push(reason);
    }) as AdvancePreMergeDeps["setBlocked"],
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
  };

  const out = await maybeArchiveOpenspec(cfg, 1, "run", deps);

  assert.ok(out && !out.advanced && out.status === "blocked",
    `expected blocked outcome; got: ${JSON.stringify(out)}`);
  assert.deepEqual(archiveCalls, [], "archive must NOT run when worktree is dirty outside openspec/");
  assert.equal(blocked.length, 1, "setBlocked must be called exactly once");
  assert.match(blocked[0], /dirty/i, "block reason must mention dirty state");
});

// ---- maybeArchiveOpenspec end-to-end: the guard prevents the archive ----

test("maybeArchiveOpenspec: stale delta + spec-divergence marker → blocked, archive never called", async () => {
  const archiveCalls: string[] = [];
  const blocked: string[] = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) =>
      args[0] === "diff" && args.includes("--name-only")
        ? { stdout: `openspec/changes/${ID}/specs/cap/spec.md\ncore/scripts/foo.ts`, stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    branchDeveloperCommits: async () => [impl("a")],
    getIssueDetail: (async () => ({
      comments: [{ author: "r", body: reviewWithMarker, createdAt: "t" }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    setBlocked: (async (_c, _n, reason: string) => {
      blocked.push(reason);
    }) as AdvancePreMergeDeps["setBlocked"],
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
  };
  const out = await maybeArchiveOpenspec(cfg, 1, "run", deps);
  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.deepEqual(archiveCalls, [], "archive must NOT run when the guard blocks");
  assert.equal(blocked.length, 1);
});
