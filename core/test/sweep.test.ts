// Tests for the `pipeline sweep` sub-command (#168).
//
// All tests are network- and filesystem-free: I/O is injected via the
// SweepDeps seam. Each test proves the code bites (assertions on specific
// outcomes, error cases, or missing-dep calls).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import {
  isSufficient,
  isIssueInPerIssueTable,
  isIssueInReleasePlanTable,
  isIssueInDetailSections,
  validateSweepSpecBody,
  filterOutPullRequests,
  runSweep,
  realSweepDeps,
  type SweepDeps,
  type SweepIssue,
  type SweepOpts,
  type SweepConfig,
} from "../scripts/stages/sweep.ts";

// ---------------------------------------------------------------------------
// Minimal ROADMAP fixture (mirrors intake.test.ts)
// ---------------------------------------------------------------------------

const ROADMAP_FIXTURE = `# Roadmap

Everything below v1.5.0 is the post-1.5.0 line.

## Release plan (sem-ver)

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.5.0** ✅ shipped | minor | Pipeline Desk desktop contracts | #153 | Shipped. |
| **v1.6.0** | minor | Intake & backlog automation | #158 | Adds intake. |
| *(none)* | — | Research trackers | #14, #27 | Research only. |

Per-issue sem-ver detail:

| # | Impact | Config | Theme | → Release | Depends on |
|---|--------|--------|-------|-----------|------------|
| #153 | minor | none | desktop | v1.5.0 | — |
| #158 | minor | new sub-command | intake & roadmap sync | v1.6.0 | — |
| #14 | none | — | research | *(none)* | — |
| #27 | none | — | research | *(none)* | — |

## Remaining work — detail

### v1.6.0 — intake & backlog automation (minor)

- **#158** — Front-door intake sub-command.

### Trackers (no release)

- **#14, #27** — research epics.
`;

const FAKE_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const DEFAULT_CFG = { repo_dir: "/fake/repo", repo: "owner/repo", base_branch: "main" };

// ---------------------------------------------------------------------------
// Minimal spec body that passes validation
// ---------------------------------------------------------------------------

const VALID_SPEC_BODY = [
  "## Summary",
  "A retry mechanism for the fix loop that recovers from transient failures.",
  "",
  "## User story",
  "As a pipeline operator,",
  "I want the fix loop to retry on transient errors,",
  "so that a temporary network failure does not block the run.",
  "",
  "## Acceptance criteria",
  "- [ ] Running `pipeline N` with a transient fix error retries up to 3 times.",
  "- [ ] A permanent error still blocks with a clear message.",
  "",
  "## Out of scope",
  "- Retry logic for the planning or review stages.",
].join("\n");

// ---------------------------------------------------------------------------
// Fake deps factory
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  _updateCalls: Array<{ repo: string; num: number; body: string }>;
  _harnessCalls: string[];
  _createPRCalls: Array<{ title: string; body: string; base: string; head: string }>;
  _logLines: string[];
  _writtenFiles: Record<string, string>;
  _gitEnsureCleanCalls: string[];
  _branchCalls: Array<{ branch: string; fromRef: string }>;
  _reserveBranchCalls: Array<{ branch: string; sha: string }>;
  _callOrder: string[];
} {
  const updateCalls: Array<{ repo: string; num: number; body: string }> = [];
  const harnessCalls: string[] = [];
  const createPRCalls: Array<{ title: string; body: string; base: string; head: string }> = [];
  const logLines: string[] = [];
  const writtenFiles: Record<string, string> = {};
  const gitEnsureCleanCalls: string[] = [];
  const branchCalls: Array<{ branch: string; fromRef: string }> = [];
  const reserveBranchCalls: Array<{ branch: string; sha: string }> = [];
  // Tracks the order of key operations for ordering assertions.
  const callOrder: string[] = [];

  const base: SweepDeps = {
    listIssues: async (_repo) => [],
    updateIssueBody: async (repo, num, body) => {
      callOrder.push("updateIssueBody");
      updateCalls.push({ repo, num, body });
    },
    runHarness: async (_prompt) => {
      harnessCalls.push(_prompt);
      return { success: true, output: VALID_SPEC_BODY };
    },
    readFile: (_p) => ROADMAP_FIXTURE,
    writeFile: (p, content) => { writtenFiles[p] = content; },
    gitResolveBaseSha: (_dir, _branch) => FAKE_BASE_SHA,
    readFileAtBase: (_dir, _ref, relPath) => {
      if (relPath === "ROADMAP.md") return ROADMAP_FIXTURE;
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
    gitEnsureClean: (dir) => { gitEnsureCleanCalls.push(dir); },
    gitCreateBranch: (_dir, branch, fromRef) => { branchCalls.push({ branch, fromRef }); },
    reserveRemoteBranch: (_dir, branch, sha) => {
      callOrder.push("reserveRemoteBranch");
      reserveBranchCalls.push({ branch, sha });
    },
    gitPushBranch: (_dir, _branch) => {},
    gitCommit: (_dir, _files, _msg) => {},
    createPR: async (_dir, title, body, base, head) => {
      createPRCalls.push({ title, body, base, head });
      return "https://github.com/owner/repo/pull/99";
    },
    today: () => "2026-06-17",
    randomToken: () => "abc123",
    log: (msg) => logLines.push(msg),
    ...overrides,
  };

  (base as unknown as { _updateCalls: typeof updateCalls })._updateCalls = updateCalls;
  (base as unknown as { _harnessCalls: typeof harnessCalls })._harnessCalls = harnessCalls;
  (base as unknown as { _createPRCalls: typeof createPRCalls })._createPRCalls = createPRCalls;
  (base as unknown as { _logLines: typeof logLines })._logLines = logLines;
  (base as unknown as { _writtenFiles: typeof writtenFiles })._writtenFiles = writtenFiles;
  (base as unknown as { _gitEnsureCleanCalls: typeof gitEnsureCleanCalls })._gitEnsureCleanCalls = gitEnsureCleanCalls;
  (base as unknown as { _branchCalls: typeof branchCalls })._branchCalls = branchCalls;
  (base as unknown as { _reserveBranchCalls: typeof reserveBranchCalls })._reserveBranchCalls = reserveBranchCalls;
  (base as unknown as { _callOrder: typeof callOrder })._callOrder = callOrder;
  return base as ReturnType<typeof makeDeps>;
}

// ---------------------------------------------------------------------------
// 2. isSufficient unit tests (task 2.2)
// ---------------------------------------------------------------------------

test("isSufficient: sufficient body with all sections passes", () => {
  const body = [
    "## Summary",
    "A full description of the feature.",
    "",
    "## User story",
    "As a user, I want this, so that that.",
    "",
    "## Acceptance criteria",
    "- [ ] It works when Y.",
    "",
    "## Out of scope",
    "- Nothing else.",
  ].join("\n");
  assert.ok(isSufficient(body), "should be sufficient");
});

test("isSufficient: single-sentence body fails", () => {
  assert.ok(!isSufficient("Add retry logic."), "single sentence should be thin");
});

test("isSufficient: body below min_body_length fails", () => {
  const body = "## Summary\nShort.\n## User story\nAs a user.";
  assert.ok(!isSufficient(body, { min_body_length: 500 }), "too short should be thin");
});

test("isSufficient: missing required sections fails", () => {
  const body = "## Summary\n" + "x".repeat(200);
  assert.ok(!isSufficient(body), "only 1 section should be thin");
});

test("isSufficient: configurable min_body_length — 200-char body is thin with threshold 300", () => {
  const body = "## Summary\n" + "x".repeat(190) + "\n## User story\nAs a user, I want.\n## Acceptance criteria\n- [ ] ok.\n## Out of scope\n- none.";
  assert.ok(isSufficient(body), "should pass default threshold (150)");
  assert.ok(!isSufficient(body, { min_body_length: 300 }), "should fail threshold of 300");
});

test("isSufficient: uses custom required_sections when configured", () => {
  const body = "## Summary\nA thing.\n## Custom\nYes.\n## Done\nDone.\n" + "x".repeat(120);
  assert.ok(!isSufficient(body), "should fail default sections");
  assert.ok(isSufficient(body, { required_sections: ["Summary", "Custom"] }), "should pass custom sections");
});

// ---------------------------------------------------------------------------
// 5. ROADMAP presence checks
// ---------------------------------------------------------------------------

test("isIssueInPerIssueTable: detects present issue", () => {
  assert.ok(isIssueInPerIssueTable(ROADMAP_FIXTURE, 158), "#158 is in table");
  assert.ok(!isIssueInPerIssueTable(ROADMAP_FIXTURE, 168), "#168 is NOT in table");
});

test("isIssueInReleasePlanTable: detects present issue", () => {
  assert.ok(isIssueInReleasePlanTable(ROADMAP_FIXTURE, 158), "#158 is in release plan");
  assert.ok(!isIssueInReleasePlanTable(ROADMAP_FIXTURE, 168), "#168 is NOT in release plan");
});

test("isIssueInDetailSections: detects present issue", () => {
  assert.ok(isIssueInDetailSections(ROADMAP_FIXTURE, 158), "#158 is in detail sections");
  assert.ok(!isIssueInDetailSections(ROADMAP_FIXTURE, 168), "#168 is NOT in detail sections");
});

// ---------------------------------------------------------------------------
// 9.1 Dry-run path: no writes, report printed
// ---------------------------------------------------------------------------

test("sweep: dry-run — no updateIssueBody, no createPR called", async () => {
  const thinIssue: SweepIssue = { number: 42, title: "add retry logic", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [thinIssue] });
  const opts: SweepOpts = { apply: false };

  await runSweep(opts, DEFAULT_CFG, {}, deps);

  assert.equal(deps._updateCalls.length, 0, "updateIssueBody should not be called in dry-run");
  assert.equal(deps._createPRCalls.length, 0, "createPR should not be called in dry-run");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("preview mode"), "should print preview notice");
  assert.ok(allLog.includes("Sweep Summary"), "should print summary report");
});

test("sweep: dry-run — proposed spec printed for thin issue", async () => {
  const thinIssue: SweepIssue = { number: 42, title: "add retry logic", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [thinIssue] });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("Proposed spec for #42"), "should print proposed spec header");
  assert.ok(allLog.includes("## Summary"), "should print spec content");
});

test("sweep: dry-run — roadmap diff printed, no branch created", async () => {
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [thinIssue] });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._branchCalls.length, 0, "no branch should be created in dry-run");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("ROADMAP.md diff"), "should print roadmap diff");
});

// ---------------------------------------------------------------------------
// 9.2 --apply path: thin issues updated, sufficient skipped, roadmap PR opened
// ---------------------------------------------------------------------------

test("sweep: --apply — thin issue body is updated", async () => {
  const thinIssue: SweepIssue = { number: 42, title: "add retry logic", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [thinIssue] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._updateCalls.length, 1, "updateIssueBody should be called for thin issue");
  assert.equal(deps._updateCalls[0].num, 42);
  assert.ok(deps._updateCalls[0].body.includes("## Summary"), "new body should have Summary section");
});

test("sweep: --apply — sufficient issue is NOT updated", async () => {
  const sufficientBody = VALID_SPEC_BODY + "\n" + "x".repeat(50);
  const sufficientIssue: SweepIssue = { number: 99, title: "already specced", body: sufficientBody };
  const deps = makeDeps({ listIssues: async () => [sufficientIssue] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._updateCalls.length, 0, "updateIssueBody should NOT be called for sufficient issue");
});

test("sweep: --apply — roadmap PR opened for absent issues", async () => {
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [thinIssue] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._createPRCalls.length, 1, "createPR should be called");
  const pr = deps._createPRCalls[0];
  assert.ok(pr.title.includes("sweep"), "PR title should mention sweep");
  assert.equal(pr.base, "main", "PR should target main branch");
  assert.ok(pr.head.includes("sweep/"), "PR head should use sweep/ branch convention");
});

test("sweep: --apply — roadmap delivery failure propagates a non-zero exit (runSweep throws) (#168 review-2)", async () => {
  // After issue bodies are rewritten, a ROADMAP delivery failure must NOT be swallowed —
  // runSweep must throw so the CLI exits non-zero (automation keys off exit status). Otherwise
  // a partial bulk mutation (issues rewritten, ROADMAP PR missing) looks like success.
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    createPR: async () => { throw new Error("gh pr create failed: no push access"); },
  });
  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /roadmap reconciliation was not delivered/,
  );
  assert.equal(deps._updateCalls.length, 1, "issue body was rewritten before the delivery failure (partial mutation)");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("roadmap delivery failed"), "recovery message is still printed before the throw");
});

test("sweep: --apply — gitCommit failure prints phase-specific recovery (commit ROADMAP first) (#168 review-2)", async () => {
  // If gitCommit fails after writeFile there is NO reconciliation commit on the branch, so a
  // bare push+PR would open a PR with no ROADMAP change. The recovery must instruct committing
  // ROADMAP.md first.
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    gitCommit: () => { throw new Error("git commit failed: pre-commit hook rejected"); },
  });
  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /roadmap reconciliation was not delivered/,
  );
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("failed during the commit step"), "names the failed delivery phase");
  assert.ok(allLog.includes("commit was NOT created"), "warns the reconciliation commit is missing");
  assert.ok(/git add ROADMAP\.md && git commit/.test(allLog), "recovery instructs committing ROADMAP.md first");
  assert.equal(deps._createPRCalls.length, 0, "no PR opened when the commit fails");
});

test("sweep: --apply — gitPushBranch failure prints push/PR-only recovery (commit already exists) (#168 review-2)", async () => {
  // Contrast: when the commit succeeded but push failed, the reconciliation IS committed —
  // the recovery is push/PR-only and must NOT tell the user to recreate the commit.
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    gitPushBranch: () => { throw new Error("git push failed: transient network error"); },
  });
  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /roadmap reconciliation was not delivered/,
  );
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("failed during the push step"), "names the push phase");
  assert.ok(allLog.includes("only push/PR remains"), "push/PR-only recovery when the commit exists");
  assert.ok(!allLog.includes("commit was NOT created"), "does NOT tell the user to recreate the commit");
});

test("sweep: --apply — no PR if ROADMAP already in sync", async () => {
  // #158 is already in all three ROADMAP structures in the fixture.
  const sufficientBody = VALID_SPEC_BODY + "\n" + "x".repeat(50);
  const alreadyInRoadmap: SweepIssue = { number: 158, title: "intake sub-command", body: sufficientBody };
  const deps = makeDeps({ listIssues: async () => [alreadyInRoadmap] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._createPRCalls.length, 0, "no PR if ROADMAP already in sync");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("already in sync"), "should log in-sync message");
});

// ---------------------------------------------------------------------------
// 9.3 Idempotent re-run: re-specced issues are recognized as sufficient
// ---------------------------------------------------------------------------

test("sweep: idempotent — second run skips already-specced issues", async () => {
  // Simulate a second run: the issue body is now the valid spec from the first run.
  const alreadySpecced: SweepIssue = { number: 42, title: "add retry logic", body: VALID_SPEC_BODY };
  const deps = makeDeps({ listIssues: async () => [alreadySpecced] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._harnessCalls.length, 0, "no harness call for already-specced issue");
  assert.equal(deps._updateCalls.length, 0, "no update for already-specced issue");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("left-as-is"), "should report left-as-is");
});

// ---------------------------------------------------------------------------
// 9.4 Blocked issue: harness failure records blocked, continues
// ---------------------------------------------------------------------------

test("sweep: blocked issue appears in report with reason; remaining issues processed", async () => {
  const thin1: SweepIssue = { number: 10, title: "issue 10", body: "Short." };
  const thin2: SweepIssue = { number: 11, title: "issue 11", body: "Short." };
  let call = 0;
  const deps = makeDeps({
    listIssues: async () => [thin1, thin2],
    runHarness: async (_p) => {
      call++;
      if (call === 1) return { success: false, output: "model timeout" };
      return { success: true, output: VALID_SPEC_BODY };
    },
  });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("BLOCKED"), "blocked issue should appear in report");
  // Second issue should still be processed.
  assert.equal(deps._updateCalls.length, 1, "second issue should still be updated");
  assert.equal(deps._updateCalls[0].num, 11);
});

test("sweep: harness exception records blocked, does not abort", async () => {
  const thinIssue: SweepIssue = { number: 5, title: "throwing issue", body: "x" };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    runHarness: async (_p) => { throw new Error("connection refused"); },
  });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("BLOCKED"), "blocked issue should appear in report");
  assert.ok(allLog.includes("connection refused"), "reason should include the error message");
});

// ---------------------------------------------------------------------------
// 9.5 Roadmap reconciliation dry-run: diff printed, no branch
// ---------------------------------------------------------------------------

test("sweep: roadmap dry-run — diff printed, no branch, no PR", async () => {
  const absent: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [absent] });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._branchCalls.length, 0, "no branch in dry-run");
  assert.equal(deps._createPRCalls.length, 0, "no PR in dry-run");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("ROADMAP.md diff"), "diff should be printed");
});

// ---------------------------------------------------------------------------
// 9.6 Roadmap reconciliation --apply: branch created, PR opened, no direct commit to default branch
// ---------------------------------------------------------------------------

test("sweep: --apply roadmap — branch forks from pinned base SHA", async () => {
  const absent: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [absent] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.ok(deps._branchCalls.length > 0, "branch should be created");
  assert.equal(deps._branchCalls[0].fromRef, FAKE_BASE_SHA, "branch forks from the pinned base SHA");
});

test("sweep: --apply roadmap — ROADMAP.md is written in the new branch", async () => {
  const absent: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [absent] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  const roadmapWritten = Object.keys(deps._writtenFiles).some((p) => p.endsWith("ROADMAP.md"));
  assert.ok(roadmapWritten, "ROADMAP.md should be written");
  const written = deps._writtenFiles[Object.keys(deps._writtenFiles).find((p) => p.endsWith("ROADMAP.md"))!];
  assert.ok(written.includes("#168"), "ROADMAP should include the new issue");
});

// ---------------------------------------------------------------------------
// 9.7 Config override: min_body_length 300 causes 200-char body to be thin
// ---------------------------------------------------------------------------

test("sweep: config override min_body_length=300 causes 200-char body to be thin", async () => {
  const body200 = "## Summary\n" + "x".repeat(180) + "\n## User story\nAs a user.\n## Acceptance criteria\n- [ ] ok.\n## Out of scope\n- none.";
  const issue: SweepIssue = { number: 77, title: "config override test", body: body200 };
  const deps = makeDeps({ listIssues: async () => [issue] });
  const sweepConfig: SweepConfig = { min_body_length: 300 };

  await runSweep({ apply: false }, DEFAULT_CFG, sweepConfig, deps);

  assert.equal(deps._harnessCalls.length, 1, "harness should be called for thin issue (threshold 300)");
});

// ---------------------------------------------------------------------------
// 9.8 --repo flag: accepted when matching cfg.repo; rejected when different
// ---------------------------------------------------------------------------

test("sweep: --repo matching cfg.repo is accepted and passed to listIssues", async () => {
  const capturedRepos: string[] = [];
  const deps = makeDeps({
    listIssues: async (repo) => { capturedRepos.push(repo); return []; },
  });
  // --repo matches cfg.repo — no-op override, must not throw
  await runSweep({ apply: false, repo: DEFAULT_CFG.repo }, DEFAULT_CFG, {}, deps);

  assert.equal(capturedRepos.length, 1);
  assert.equal(capturedRepos[0], DEFAULT_CFG.repo, "should use cfg.repo when --repo matches");
});

test("sweep: defaults to cfg.repo when --repo is absent", async () => {
  const capturedRepos: string[] = [];
  const deps = makeDeps({
    listIssues: async (repo) => { capturedRepos.push(repo); return []; },
  });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  assert.equal(capturedRepos[0], "owner/repo", "should use cfg.repo when --repo omitted");
});

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------

test("sweep: summary report includes per-issue action and reason", async () => {
  const thin: SweepIssue = { number: 5, title: "thin issue", body: "x" };
  const deps = makeDeps({ listIssues: async () => [thin] });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("#5 thin issue"), "report should include issue number and title");
});

test("sweep: summary report includes aggregate counts", async () => {
  const thin: SweepIssue = { number: 5, title: "thin", body: "x" };
  const deps = makeDeps({ listIssues: async () => [thin] });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("inspected"), "report should include aggregate count line");
});

test("sweep: summary report indicates preview-only when --apply is absent", async () => {
  const deps = makeDeps({ listIssues: async () => [] });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("Preview only") || allLog.includes("no writes"), "should indicate preview mode");
});

test("sweep: summary report indicates writes applied when --apply is present", async () => {
  const deps = makeDeps({ listIssues: async () => [] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("Writes applied") || allLog.includes("applied"), "should indicate writes applied");
});

// ---------------------------------------------------------------------------
// validateSweepSpecBody
// ---------------------------------------------------------------------------

test("validateSweepSpecBody: accepts body with all required sections", () => {
  assert.doesNotThrow(() => validateSweepSpecBody(VALID_SPEC_BODY));
});

test("validateSweepSpecBody: throws when required section is missing", () => {
  const noUserStory = VALID_SPEC_BODY.replace("## User story\n", "## Something else\n");
  assert.throws(() => validateSweepSpecBody(noUserStory), /missing required sections.*User story/);
});

test("validateSweepSpecBody: throws when no checkable criteria", () => {
  const noCheckbox = VALID_SPEC_BODY.replace(/- \[ \]/g, "*");
  assert.throws(() => validateSweepSpecBody(noCheckbox), /no checkable acceptance criteria/);
});

// ---------------------------------------------------------------------------
// Finding 2: --repo guard (cross-repo rejection)
// ---------------------------------------------------------------------------

test("sweep: --repo differs from cfg.repo throws before any writes", async () => {
  const deps = makeDeps({ listIssues: async () => [] });

  await assert.rejects(
    () => runSweep({ apply: true, repo: "other/repo" }, DEFAULT_CFG, {}, deps),
    /--repo "other\/repo" differs from the configured repo/,
  );
  assert.equal(deps._updateCalls.length, 0, "no issue writes should have occurred");
});

// ---------------------------------------------------------------------------
// Finding 3: preflight ordering — git failure must abort before issue updates
// ---------------------------------------------------------------------------

test("sweep: --apply preflight failure aborts before any issue updates", async () => {
  const thinIssue: SweepIssue = { number: 42, title: "thin issue", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    gitEnsureClean: (_dir) => { throw new Error("ROADMAP.md has uncommitted changes"); },
  });

  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /uncommitted changes/,
  );
  assert.equal(deps._updateCalls.length, 0, "no issue updates should have occurred after preflight failure");
});

// ---------------------------------------------------------------------------
// Finding 4: issue-number prefix disambiguation (#15 vs #158)
// ---------------------------------------------------------------------------

test("isIssueInReleasePlanTable: #15 not falsely detected when only #158 present", () => {
  const roadmap = [
    "## Release plan (sem-ver)",
    "| Release | Bump | Theme | Issues | Why this bump |",
    "|---|---|---|---|---|",
    "| **v1.0.0** | minor | test | #158 | reason |",
    "| *(none)* | — | — | — | — |",
  ].join("\n");
  assert.ok(!isIssueInReleasePlanTable(roadmap, 15), "#15 should NOT be detected when only #158 is present");
  assert.ok(isIssueInReleasePlanTable(roadmap, 158), "#158 should be detected");
});

test("isIssueInDetailSections: #15 not falsely detected when only #158 present", () => {
  const roadmap = [
    "### v1.0.0 — test (minor)",
    "- **#158** — some feature.",
  ].join("\n");
  assert.ok(!isIssueInDetailSections(roadmap, 15), "#15 should NOT be detected when only #158 is present");
  assert.ok(isIssueInDetailSections(roadmap, 158), "#158 should be detected");
});

// ---------------------------------------------------------------------------
// Finding 5: all issues returned by listIssues are processed (no 200-cap)
// ---------------------------------------------------------------------------

test("sweep: processes all issues returned by listIssues — no hard cap in orchestrator", async () => {
  const manyIssues: SweepIssue[] = Array.from({ length: 201 }, (_, i) => ({
    number: i + 1,
    title: `issue ${i + 1}`,
    body: "Short.",
  }));
  const deps = makeDeps({ listIssues: async () => manyIssues });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._harnessCalls.length, 201, "all 201 thin issues should be passed to the harness");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("201 inspected"), "report should count all 201 issues");
});

// ---------------------------------------------------------------------------
// Finding 6: roadmap mutations are atomic — partial success is rolled back
// ---------------------------------------------------------------------------

test("sweep: roadmap mutation failure is atomic — release-plan row not committed when per-issue row fails", async () => {
  // A ROADMAP with a release plan (so insertReleasePlanRow can succeed) but
  // no per-issue table header (so insertPerIssueRow will throw). The atomicity
  // fix ensures neither insertion appears in mutatedRoadmap on failure.
  const partialRoadmap = [
    "# Roadmap",
    "",
    "## Release plan (sem-ver)",
    "",
    "| Release | Bump | Theme | Issues | Why this bump |",
    "|---|---|---|---|---|",
    "| **v2.0.0** | minor | test | — | test |",
    "| *(none)* | — | — | — | — |",
    "",
    "Per-issue sem-ver detail:",
    "",
    "_(no per-issue table — triggers insertPerIssueRow failure)_",
    "",
    "## Remaining work — detail",
    "",
    "### v2.0.0 — test (minor)",
    "",
    "nothing.",
  ].join("\n");

  const newIssue: SweepIssue = { number: 777, title: "new issue", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [newIssue],
    readFileAtBase: (_dir, _ref, relPath) => {
      if (relPath === "ROADMAP.md") return partialRoadmap;
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
  });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  // The error must be reported.
  assert.ok(allLog.includes("could not add #777"), "should report the roadmap mutation error for #777");
  // With the atomic fix, mutatedRoadmap === roadmapAtBase when ANY mutation for an issue
  // fails, so the diff is empty — the "no changes" message is logged instead of a diff.
  assert.ok(allLog.includes("no changes"), "diff should be empty when atomic mutation is rolled back");
});

// ---------------------------------------------------------------------------
// CLI: sweep dispatched correctly
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

test("CLI: pipeline sweep is listed in recognized sub-commands on unrecognized cmd error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "unknowncmd"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2, `expected exit 2; stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("sweep"), `expected sweep listed in recognized sub-commands; stderr:\n${result.stderr}`);
});

// Finding 7: extra positional argument to sweep exits with usage error
test("CLI: pipeline sweep 123 exits with usage error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "sweep", "123"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2, `expected exit 2; stderr:\n${result.stderr}`);
  assert.ok(
    result.stderr.includes("unexpected argument") || result.stderr.includes("123"),
    `expected usage error about unexpected argument; stderr:\n${result.stderr}`,
  );
});

// Finding 1: --apply --dry-run combination exits with error
test("CLI: pipeline sweep --apply --dry-run exits with error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "sweep", "--apply", "--dry-run"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2, `expected exit 2; stderr:\n${result.stderr}`);
  assert.ok(
    result.stderr.includes("mutually exclusive"),
    `expected mutually exclusive error; stderr:\n${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// Review 2 — Finding 1: PR filtering
// ---------------------------------------------------------------------------

test("filterOutPullRequests: drops items with pull_request field, keeps plain issues", () => {
  const items = [
    { number: 1, title: "a real issue", body: "some body", pull_request: undefined },
    { number: 2, title: "an open PR", body: "PR body", pull_request: { url: "https://..." } },
    { number: 3, title: "another issue", body: null },
  ];
  const result = filterOutPullRequests(items);
  assert.equal(result.length, 2, "should drop the PR entry");
  assert.equal(result[0].number, 1);
  assert.equal(result[1].number, 3);
  assert.equal(result[1].body, "", "null body should become empty string");
});

test("filterOutPullRequests: all items are PRs → empty result", () => {
  const items = [
    { number: 10, title: "pr", body: "x", pull_request: { url: "u" } },
    { number: 11, title: "pr2", body: "y", pull_request: {} },
  ];
  assert.equal(filterOutPullRequests(items).length, 0);
});

test("sweep: issues returned by listIssues are swept; PR entries must be excluded by the dep impl", async () => {
  // The orchestrator receives the filtered list from SweepDeps.listIssues.
  // This test verifies the orchestrator only processes what listIssues returns,
  // not that it re-filters — the filter lives in realSweepDeps.listIssues.
  const thinIssue: SweepIssue = { number: 5, title: "real issue", body: "Short." };
  const deps = makeDeps({
    // listIssues already returns only issues (no PRs) — per the SweepDeps contract
    listIssues: async () => [thinIssue],
  });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  assert.equal(deps._harnessCalls.length, 1, "harness called once for the one real issue");
});

// ---------------------------------------------------------------------------
// Review 2 — Finding 2: branch reservation before issue writes
// ---------------------------------------------------------------------------

test("sweep: --apply reserves remote branch before any issue body update", async () => {
  const thinIssue: SweepIssue = { number: 42, title: "thin", body: "Short." };
  const deps = makeDeps({ listIssues: async () => [thinIssue] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  const reserveIdx = deps._callOrder.indexOf("reserveRemoteBranch");
  const updateIdx = deps._callOrder.indexOf("updateIssueBody");
  assert.ok(reserveIdx >= 0, "reserveRemoteBranch should be called");
  assert.ok(updateIdx >= 0, "updateIssueBody should be called");
  assert.ok(reserveIdx < updateIdx, "reserveRemoteBranch must precede updateIssueBody");
});

test("sweep: --apply reserveRemoteBranch failure aborts before any issue writes", async () => {
  const thinIssue: SweepIssue = { number: 42, title: "thin", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    reserveRemoteBranch: (_dir, _branch, _sha) => {
      throw new Error("branch already exists on origin");
    },
  });

  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /already exists on origin/,
  );
  assert.equal(deps._updateCalls.length, 0, "no issue writes should occur after reservation failure");
});

test("sweep: --apply branch name includes today's date and a random token", async () => {
  const deps = makeDeps({ listIssues: async () => [] });

  await runSweep({ apply: true }, DEFAULT_CFG, {}, deps);

  assert.ok(deps._branchCalls.length > 0, "gitCreateBranch should be called");
  const branchName = deps._branchCalls[0].branch;
  assert.ok(branchName.startsWith("sweep/2026-06-17"), "branch should start with sweep/<today>");
  assert.ok(branchName.includes("abc123"), "branch should include the random token");
});

// ---------------------------------------------------------------------------
// Review 3 — Finding 1: roadmap delivery failure after issue writes → recovery path
// ---------------------------------------------------------------------------

test("sweep: createPR failure after issue updates — reports rewritten issue, delivery failure, and recovery command", async () => {
  // #168 is absent from the fixture ROADMAP, so a roadmap PR would be attempted.
  // createPR throws to simulate a post-issue-write delivery failure.
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    createPR: async () => { throw new Error("gh pr create: authentication required"); },
  });

  // MUST propagate the failure (after printing the summary + recovery) so the CLI exits
  // non-zero — but the issue rewrite + recovery instructions + summary still happen first.
  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /roadmap reconciliation was not delivered/,
  );

  // 1. The issue body was updated before the PR failure.
  assert.equal(deps._updateCalls.length, 1, "issue body should have been updated before PR failure");
  assert.equal(deps._updateCalls[0].num, 168, "the updated issue number should be #168");

  const allLog = deps._logLines.join("\n");

  // 2. Delivery failure is reported.
  assert.ok(allLog.includes("roadmap delivery failed"), "should report roadmap delivery failure");
  assert.ok(allLog.includes("authentication required"), "should include the underlying error message");

  // 3. Actionable recovery path is shown: branch name and gh pr create command.
  assert.ok(allLog.includes("sweep/2026-06-17"), "should show the reserved branch name");
  assert.ok(allLog.includes("gh pr create"), "should show a manual gh pr create command");

  // 4. Summary report is still printed (before the throw).
  assert.ok(allLog.includes("Sweep Summary"), "summary report should be printed despite PR failure");

  // 5. The summary shows the rewritten issue.
  assert.ok(allLog.includes("#168"), "summary should include the rewritten issue number");

  // 6. Summary indicates delivery was blocked (not falsely claiming success).
  assert.ok(
    allLog.includes("ROADMAP delivery BLOCKED") || allLog.includes("BLOCKED"),
    "summary should indicate roadmap delivery was blocked",
  );
});

test("sweep: gitPushBranch failure after issue updates — recovery path printed, summary still appears, then throws", async () => {
  const thinIssue: SweepIssue = { number: 168, title: "sweep sub-command", body: "Short." };
  const deps = makeDeps({
    listIssues: async () => [thinIssue],
    gitPushBranch: (_dir, _branch) => { throw new Error("push rejected: remote branch diverged"); },
  });

  await assert.rejects(
    () => runSweep({ apply: true }, DEFAULT_CFG, {}, deps),
    /roadmap reconciliation was not delivered/,
  );

  assert.equal(deps._updateCalls.length, 1, "issue body should have been updated before push failure");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("roadmap delivery failed"), "should report delivery failure");
  assert.ok(allLog.includes("push rejected"), "should include push error message");
  assert.ok(allLog.includes("Sweep Summary"), "summary should still be printed");
});

// ---------------------------------------------------------------------------
// Review 2 — Finding 3: *(none)* row recognition
// ---------------------------------------------------------------------------

test("isIssueInReleasePlanTable: detects issues in *(none)* release-plan row", () => {
  const roadmap = [
    "## Release plan (sem-ver)",
    "| Release | Bump | Theme | Issues | Why this bump |",
    "|---|---|---|---|---|",
    "| **v1.6.0** | minor | Intake | #158 | Adds intake. |",
    "| *(none)* | — | Research trackers | #14, #27 | Research only. |",
  ].join("\n");
  assert.ok(isIssueInReleasePlanTable(roadmap, 14), "#14 should be detected in *(none)* row");
  assert.ok(isIssueInReleasePlanTable(roadmap, 27), "#27 should be detected in *(none)* row");
  assert.ok(isIssueInReleasePlanTable(roadmap, 158), "#158 should still be detected in versioned row");
  assert.ok(!isIssueInReleasePlanTable(roadmap, 99), "#99 absent should not be detected");
});

test("sweep: reconciliation does not add release-plan row for issue already in *(none)* row", async () => {
  // #14 is in the per-issue table and in the *(none)* release-plan row; the reconciliation
  // must NOT add a new versioned release-plan row for it (Finding 3).
  const issue14: SweepIssue = { number: 14, title: "research tracker", body: VALID_SPEC_BODY + "\n" + "x".repeat(50) };
  const deps = makeDeps({
    listIssues: async () => [issue14],
  });

  await runSweep({ apply: false }, DEFAULT_CFG, {}, deps);

  const allLog = deps._logLines.join("\n");
  // If #14 would have been incorrectly added, the diff would mention it.
  // With the fix, #14 is already in all structures so the diff should be empty.
  assert.ok(
    allLog.includes("no changes") || !allLog.includes("| #14 |"),
    "should not add a release-plan row for #14 already in *(none)* row",
  );
});

// ---------------------------------------------------------------------------
// realSweepDeps harness wiring (#220) — sweep re-specs thin issues from their
// own title/body, a self-contained transform, so its real runHarness must
// invoke claude with a PINNED model and the lean flags (no tools / no MCP).
// Proven against a fake `claude` on PATH (no real network/model call).
// ---------------------------------------------------------------------------

test("sweep: realSweepDeps.runHarness forwards the pinned model and lean flags to claude (#220)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-wt-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-claude-"));
  const cli = path.join(binDir, "claude");
  fs.writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' "$@"\n`);
  fs.chmodSync(cli, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const result = await realSweepDeps(tmp, "test-model-xyz").runHarness("SPEC-PROMPT");
    assert.equal(result.success, true);
    assert.match(result.output, /--model\ntest-model-xyz/, "the pinned sweep model must reach claude");
    assert.match(result.output, /--tools/, "lean mode must pass --tools");
    assert.match(result.output, /--strict-mcp-config/, "lean mode must pass --strict-mcp-config");
    assert.doesNotMatch(result.output, /--bare/, "must NOT use --bare (would break OAuth auth)");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("sweep: realSweepDeps defaults the model to DEFAULT_CONFIG.models.sweep when unset (#220)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-wt-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-claude-"));
  const cli = path.join(binDir, "claude");
  fs.writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' "$@"\n`);
  fs.chmodSync(cli, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const result = await realSweepDeps(tmp).runHarness("X");
    assert.match(
      result.output,
      new RegExp(`--model\\n${DEFAULT_CONFIG.models.sweep}`),
      "default model must be DEFAULT_CONFIG.models.sweep",
    );
  } finally {
    process.env.PATH = oldPath;
  }
});
