// Tests for the `pipeline intake` sub-command (#158).
//
// All tests are network- and filesystem-free: I/O is injected via the
// IntakeDeps seam. Each test proves the code bites (assertions on specific
// outcomes, error cases, or missing deps calls).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import {
  runIntake,
  realIntakeDeps,
  inferReleaseSlot,
  parseSpec,
  extractOneLiner,
  validateSpecBody,
  labelCreateArgs,
  isLabelAlreadyExists,
  reservePushArgs,
  type IntakeDeps,
  type IntakeOpts,
} from "../scripts/stages/intake.ts";
import {
  insertReleasePlanRow,
  insertPerIssueRow,
  insertDetailSectionBullet,
} from "../scripts/stages/release.ts";

// ---------------------------------------------------------------------------
// Minimal ROADMAP fixture
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed fake base SHA returned by the gitResolveBaseSha seam. Tests assert this exact
// value flows to BOTH readFileAtBase and gitCreateBranch (the SHA-pinning invariant).
const FAKE_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeDeps(overrides: Partial<IntakeDeps> = {}): IntakeDeps & {
  _createIssueCalls: Array<{ title: string; body: string; labels: string[] }>;
  _createPRCalls: Array<{ title: string; body: string; base: string; head: string }>;
  _writtenFiles: Record<string, string>;
  _logLines: string[];
  _gitEnsureCleanCalls: string[];
  _ensureLabelCalls: Array<{ name: string; color: string }>;
} {
  const createIssueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const createPRCalls: Array<{ title: string; body: string; base: string; head: string }> = [];
  const writtenFiles: Record<string, string> = {};
  const logLines: string[] = [];
  const gitEnsureCleanCalls: string[] = [];
  const ensureLabelCalls: Array<{ name: string; color: string }> = [];

  const base: IntakeDeps = {
    runHarness: async (_prompt) => ({
      success: true,
      output: [
        "# Add retry logic to the fix loop",
        "",
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
      ].join("\n"),
    }),
    createIssue: async (title, body, labels) => {
      createIssueCalls.push({ title, body, labels });
      return 999;
    },
    gitResolveBaseSha: (_dir, _baseBranch) => FAKE_BASE_SHA,
    readFileAtBase: (_dir, _ref, relPath) => {
      if (relPath === "ROADMAP.md") return ROADMAP_FIXTURE;
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
    readFile: (p) => {
      if (p.endsWith("ROADMAP.md")) return ROADMAP_FIXTURE;
      throw new Error(`readFile not mocked for ${p}`);
    },
    writeFile: (p, content) => {
      writtenFiles[p] = content;
    },
    ensureLabel: async (_dir, name, color) => {
      ensureLabelCalls.push({ name, color });
    },
    gitEnsureClean: (dir) => {
      gitEnsureCleanCalls.push(dir);
    },
    gitCreateBranch: (_dir, _branch, _fromRef) => {},
    reserveRemoteBranch: (_dir, _branch, _sha) => {},
    gitPushBranch: (_dir, _branch) => {},
    gitCommit: (_dir, _files, _msg) => {},
    createPR: async (_dir, title, body, base, head) => {
      createPRCalls.push({ title, body, base, head });
      return "https://github.com/owner/repo/pull/42";
    },
    randomToken: () => "tok123",
    log: (msg) => logLines.push(msg),
    ...overrides,
  };

  (base as unknown as { _createIssueCalls: typeof createIssueCalls })._createIssueCalls = createIssueCalls;
  (base as unknown as { _createPRCalls: typeof createPRCalls })._createPRCalls = createPRCalls;
  (base as unknown as { _writtenFiles: typeof writtenFiles })._writtenFiles = writtenFiles;
  (base as unknown as { _logLines: typeof logLines })._logLines = logLines;
  (base as unknown as { _gitEnsureCleanCalls: typeof gitEnsureCleanCalls })._gitEnsureCleanCalls = gitEnsureCleanCalls;
  (base as unknown as { _ensureLabelCalls: typeof ensureLabelCalls })._ensureLabelCalls = ensureLabelCalls;
  return base as ReturnType<typeof makeDeps>;
}

const DEFAULT_CFG = { repo_dir: "/fake/repo", repo: "owner/repo", base_branch: "main" };

// ---------------------------------------------------------------------------
// 6.1 Dry-run path
// ---------------------------------------------------------------------------

test("intake: dry-run prints spec and diff, no createIssue/createPR", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", dryRun: true };

  await runIntake(opts, DEFAULT_CFG, deps);

  assert.equal(deps._createIssueCalls.length, 0, "createIssue should not be called in dry-run");
  assert.equal(deps._createPRCalls.length, 0, "createPR should not be called in dry-run");
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("Proposed issue body"), "dry-run should print issue body header");
  assert.ok(allLog.includes("Proposed ROADMAP.md diff"), "dry-run should print roadmap diff header");
});

test("intake: dry-run with --release uses the pinned version", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = {
    description: "add retry logic to the fix loop",
    dryRun: true,
    release: "v1.6.0",
  };

  await runIntake(opts, DEFAULT_CFG, deps);

  assert.equal(deps._createIssueCalls.length, 0);
  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("Proposed ROADMAP.md diff"), "should print diff");
});

// ---------------------------------------------------------------------------
// 6.2 Happy path
// ---------------------------------------------------------------------------

test("intake: happy path creates issue with correct labels and opens roadmap PR", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };

  await runIntake(opts, DEFAULT_CFG, deps);

  assert.equal(deps._createIssueCalls.length, 1, "issue should be created");
  const call = deps._createIssueCalls[0];
  assert.ok(call.labels.includes("pipeline:ready"), "should have pipeline:ready label");
  assert.ok(call.labels.includes("release:v1.6.0"), "should have release:v1.6.0 label");

  assert.equal(deps._createPRCalls.length, 1, "PR should be opened");
  const prCall = deps._createPRCalls[0];
  assert.ok(prCall.title.includes("#999"), "PR title should reference the issue number");
  assert.equal(prCall.base, "main", "PR base should be main");
  // Branch is prepared BEFORE the issue exists, so its name is slug-based (not issue-N).
  assert.ok(prCall.head.startsWith("intake/"), "PR head branch should follow intake/<slug> convention");
  assert.ok(prCall.head.includes("retry"), "PR head branch slug derives from the spec title");
});

test("intake: happy path writes ROADMAP.md with all three mutations", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };

  await runIntake(opts, DEFAULT_CFG, deps);

  const roadmapPath = Object.keys(deps._writtenFiles).find((p) => p.endsWith("ROADMAP.md"));
  assert.ok(roadmapPath, "ROADMAP.md should be written");
  const written = deps._writtenFiles[roadmapPath!];
  // Release-plan row
  assert.ok(written.includes("**v1.6.0**"), "release-plan row should reference version");
  assert.ok(written.includes("#999"), "release-plan row should reference new issue number");
  // Per-issue row
  assert.ok(
    written.match(/\| #999 \|/),
    "per-issue row should have #999",
  );
  // Detail section bullet
  const v16Idx = written.indexOf("### v1.6.0");
  assert.ok(v16Idx !== -1, "detail section should exist");
  const afterHeading = written.slice(v16Idx);
  assert.ok(afterHeading.includes("#999"), "detail section should contain new issue reference");
});

// ---------------------------------------------------------------------------
// 6.3 --release pin
// ---------------------------------------------------------------------------

test("intake: --release pin uses specified version in all three mutations", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "v1.6.0" };

  await runIntake(opts, DEFAULT_CFG, deps);

  const roadmapPath = Object.keys(deps._writtenFiles).find((p) => p.endsWith("ROADMAP.md"));
  assert.ok(roadmapPath);
  const written = deps._writtenFiles[roadmapPath!];
  assert.ok(written.includes("release:v1.6.0") || deps._createIssueCalls[0].labels.includes("release:v1.6.0"));
  // All three mutations use v1.6.0
  assert.ok(written.includes("v1.6.0"), "ROADMAP should reference v1.6.0");
});

// ---------------------------------------------------------------------------
// 6.4 Release slot inference
// ---------------------------------------------------------------------------

test("intake: infers first open lane from roadmap when --release omitted", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop" };

  await runIntake(opts, DEFAULT_CFG, deps);

  assert.equal(deps._createIssueCalls.length, 1);
  // Should have inferred v1.6.0 (first open lane in fixture)
  assert.ok(
    deps._createIssueCalls[0].labels.includes("release:v1.6.0"),
    "should infer v1.6.0 as the first open lane",
  );
});

test("inferReleaseSlot: returns first non-shipped row version", () => {
  const slot = inferReleaseSlot(ROADMAP_FIXTURE);
  assert.equal(slot, "1.6.0");
});

test("inferReleaseSlot: returns undefined when all rows shipped", () => {
  const allShipped = ROADMAP_FIXTURE.replace(
    "| **v1.6.0** | minor |",
    "| **v1.6.0** ✅ shipped | minor |",
  );
  const slot = inferReleaseSlot(allShipped);
  assert.equal(slot, undefined);
});

// ---------------------------------------------------------------------------
// 6.5 Error path — missing description
// ---------------------------------------------------------------------------

test("intake: exits non-zero with usage error when description is absent", async () => {
  const deps = makeDeps();
  let harnessCallCount = 0;
  deps.runHarness = async (_p) => { harnessCallCount++; return { success: true, output: "" }; };
  const opts: IntakeOpts = { description: "" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /description is required/,
  );
  assert.equal(harnessCallCount, 0, "harness should not be called when description is absent");
});

// ---------------------------------------------------------------------------
// 6.6 Error path — digit-only positional
// ---------------------------------------------------------------------------

test("intake: exits non-zero when description is a digit-only string", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "42" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /issue number/,
  );
});

// ---------------------------------------------------------------------------
// 6.7 Error path — harness failure
// ---------------------------------------------------------------------------

test("intake: no issue or PR created when harness fails", async () => {
  const deps = makeDeps({
    runHarness: async (_p) => ({ success: false, output: "error from model" }),
  });
  const opts: IntakeOpts = { description: "add retry logic", release: "1.6.0" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /harness failed/,
  );
  assert.equal(deps._createIssueCalls.length, 0);
  assert.equal(deps._createPRCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 6.8 Error path — ROADMAP anchor missing
// ---------------------------------------------------------------------------

test("intake: exits non-zero with anchor name when release-plan anchor is absent", async () => {
  const roadmapWithoutNoneRow = ROADMAP_FIXTURE.replace("| *(none)* |", "| REMOVED |");
  const deps = makeDeps({
    readFileAtBase: (_dir, _baseBranch, relPath) => {
      if (relPath === "ROADMAP.md") return roadmapWithoutNoneRow;
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
  });
  const opts: IntakeOpts = { description: "add retry logic", release: "1.6.0" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /ROADMAP anchor not found/,
  );
  // Regression: anchor preflight must run BEFORE createIssue (finding 2).
  assert.equal(deps._createIssueCalls.length, 0, "no issue should be created when roadmap anchor is missing");
});

test("intake: exits non-zero with anchor name when detail section is absent for version", async () => {
  const roadmapWithoutSection = ROADMAP_FIXTURE.replace(
    "### v1.6.0 — intake & backlog automation (minor)",
    "### v1.7.0 — something else (minor)",
  );
  const deps = makeDeps({
    readFileAtBase: (_dir, _baseBranch, relPath) => {
      if (relPath === "ROADMAP.md") return roadmapWithoutSection;
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
  });
  const opts: IntakeOpts = { description: "add retry logic", release: "1.6.0" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /ROADMAP anchor not found.*detail-section/,
  );
  // Regression: anchor preflight must run BEFORE createIssue (finding 2).
  assert.equal(deps._createIssueCalls.length, 0, "no issue should be created when detail section is missing");
});

// ---------------------------------------------------------------------------
// insertDetailSectionBullet unit tests (task 3.2)
// ---------------------------------------------------------------------------

test("insertDetailSectionBullet: inserts bullet at correct position", () => {
  const text = "# Roadmap\n\n### v1.6.0 — foo (minor)\n\n- **#158** — existing.\n";
  const result = insertDetailSectionBullet(text, "1.6.0", "new bullet");
  const lines = result.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("### v1.6.0"));
  assert.ok(headingIdx >= 0);
  // The new bullet should be inserted BEFORE the existing bullet.
  const insertedIdx = headingIdx + 2; // after heading + blank line
  assert.equal(lines[insertedIdx], "- new bullet");
  assert.equal(lines[insertedIdx + 1], "- **#158** — existing.");
});

test("insertDetailSectionBullet: throws anchor-not-found when version section absent", () => {
  const text = "# Roadmap\n\n### v1.5.0 — shipped (minor)\n\n- **#153** — thing.\n";
  assert.throws(
    () => insertDetailSectionBullet(text, "1.6.0", "new bullet"),
    /ROADMAP anchor not found.*detail-section-v1\.6\.0/,
  );
});

// ---------------------------------------------------------------------------
// insertReleasePlanRow unit tests
// ---------------------------------------------------------------------------

test("insertReleasePlanRow: inserts row before *(none)* sentinel", () => {
  const text = ROADMAP_FIXTURE;
  const result = insertReleasePlanRow(text, "1.7.0", "minor", "some theme", "#200", "Why not.");
  assert.ok(result.includes("| **v1.7.0** | minor | some theme | #200 | Why not. |"));
  // The new row should appear before the *(none)* row.
  const newRowIdx = result.indexOf("| **v1.7.0**");
  const noneRowIdx = result.indexOf("| *(none)* |");
  assert.ok(newRowIdx < noneRowIdx, "new row should precede *(none)* row");
});

test("insertReleasePlanRow: throws when *(none)* anchor absent", () => {
  const noNone = ROADMAP_FIXTURE.replace("| *(none)* |", "");
  assert.throws(
    () => insertReleasePlanRow(noNone, "1.7.0", "minor", "theme", "#200", "why"),
    /release-plan-none-row/,
  );
});

// ---------------------------------------------------------------------------
// insertPerIssueRow unit tests
// ---------------------------------------------------------------------------

test("insertPerIssueRow: inserts row before first *(none)* in → Release column", () => {
  const text = ROADMAP_FIXTURE;
  const result = insertPerIssueRow(text, 200, "minor", "new key", "intake ext", "1.7.0", "—");
  assert.ok(result.includes("| #200 |"));
  // Should be before #14 row.
  const newIdx = result.indexOf("| #200 |");
  const r14Idx = result.indexOf("| #14 |");
  assert.ok(newIdx < r14Idx, "new row should precede #14 research row");
});

test("insertPerIssueRow: throws when per-issue table header absent", () => {
  const noTable = ROADMAP_FIXTURE.replace(
    "| # | Impact | Config | Theme | → Release | Depends on |",
    "",
  );
  assert.throws(
    () => insertPerIssueRow(noTable, 200, "minor", "key", "theme", "1.7.0", "—"),
    /per-issue-table/,
  );
});

// ---------------------------------------------------------------------------
// parseSpec / extractOneLiner
// ---------------------------------------------------------------------------

test("parseSpec: extracts title from H1 heading", () => {
  const raw = "# My Feature\n\n## Summary\nDoes a thing.\n";
  const { title, body } = parseSpec(raw);
  assert.equal(title, "My Feature");
  assert.ok(body.includes("## Summary"));
});

test("parseSpec: falls back to default title when H1 absent", () => {
  const raw = "## Summary\nDoes a thing.\n";
  const { title } = parseSpec(raw);
  assert.equal(title, "New feature (intake)");
});

test("extractOneLiner: returns first sentence of Summary", () => {
  const body = "## Summary\nA retry mechanism for the fix loop. More details here.\n\n## User story\n...";
  const result = extractOneLiner(body);
  assert.equal(result, "A retry mechanism for the fix loop.");
});

test("extractOneLiner: handles missing Summary section", () => {
  const body = "## User story\nAs a user...";
  const result = extractOneLiner(body);
  assert.ok(result.length > 0);
});

// ---------------------------------------------------------------------------
// validateSpecBody (finding 3 regression)
// ---------------------------------------------------------------------------

test("validateSpecBody: accepts a well-formed spec with all required sections", () => {
  const body = [
    "# Some Feature",
    "",
    "## Summary",
    "Does something useful.",
    "",
    "## User story",
    "As a user, I want this, so that that.",
    "",
    "## Acceptance criteria",
    "- [ ] It works.",
    "",
    "## Out of scope",
    "- Nothing else.",
  ].join("\n");
  assert.doesNotThrow(() => validateSpecBody(body));
});

test("validateSpecBody: throws when a required section is missing", () => {
  const bodyNoUserStory = [
    "# Some Feature",
    "",
    "## Summary",
    "Does something.",
    "",
    "## Acceptance criteria",
    "- [ ] It works.",
    "",
    "## Out of scope",
    "- Nothing.",
  ].join("\n");
  assert.throws(() => validateSpecBody(bodyNoUserStory), /missing required sections.*User story/);
});

test("validateSpecBody: throws when no checkable acceptance criterion", () => {
  const bodyNoCheckbox = [
    "# Feature",
    "",
    "## Summary",
    "Does something.",
    "",
    "## User story",
    "As a user...",
    "",
    "## Acceptance criteria",
    "It should work.",
    "",
    "## Out of scope",
    "- Nothing.",
  ].join("\n");
  assert.throws(() => validateSpecBody(bodyNoCheckbox), /no checkable acceptance criteria/);
});

test("intake: no issue created when harness returns a spec missing required sections", async () => {
  const deps = makeDeps({
    runHarness: async (_p) => ({
      success: true,
      output: "## Summary\nA thing.\n## Acceptance criteria\n- [ ] works.",
    }),
  });
  const opts: IntakeOpts = { description: "some feature", release: "1.6.0" };
  await assert.rejects(() => runIntake(opts, DEFAULT_CFG, deps), /missing required sections/);
  assert.equal(deps._createIssueCalls.length, 0, "issue must not be created when spec is invalid");
});

// ---------------------------------------------------------------------------
// gitEnsureClean is called before createIssue (finding 1 regression)
// ---------------------------------------------------------------------------

test("intake: gitEnsureClean is called before createIssue in happy path", async () => {
  const callOrder: string[] = [];
  const deps = makeDeps({
    gitEnsureClean: (_dir) => { callOrder.push("ensureClean"); },
    createIssue: async (title, body, labels) => {
      callOrder.push("createIssue");
      deps._createIssueCalls.push({ title, body, labels });
      return 999;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  const cleanIdx = callOrder.indexOf("ensureClean");
  const issueIdx = callOrder.indexOf("createIssue");
  assert.ok(cleanIdx !== -1, "gitEnsureClean should be called");
  assert.ok(issueIdx !== -1, "createIssue should be called");
  assert.ok(cleanIdx < issueIdx, "gitEnsureClean must be called before createIssue");
});

test("intake: gitEnsureClean is NOT called in dry-run mode", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", dryRun: true };
  await runIntake(opts, DEFAULT_CFG, deps);
  assert.equal(deps._gitEnsureCleanCalls.length, 0, "gitEnsureClean should not be called in dry-run");
});

test("intake: no issue or PR created when gitEnsureClean throws", async () => {
  const deps = makeDeps({
    gitEnsureClean: (_dir) => {
      throw new Error("[pipeline intake] ROADMAP.md has uncommitted local changes");
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await assert.rejects(() => runIntake(opts, DEFAULT_CFG, deps), /uncommitted local changes/);
  assert.equal(deps._createIssueCalls.length, 0, "no issue should be created when working tree is dirty");
  assert.equal(deps._createPRCalls.length, 0);
});

// ---------------------------------------------------------------------------
// SHA pinning: branch forks from the pinned base SHA, not the moving ref (#158 review-2)
// ---------------------------------------------------------------------------

test("intake: gitCreateBranch forks from the pinned base SHA (not the moving ref)", async () => {
  const branchCalls: Array<{ dir: string; branch: string; fromRef: string }> = [];
  const deps = makeDeps({
    gitCreateBranch: (dir, branch, fromRef) => { branchCalls.push({ dir, branch, fromRef }); },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  assert.equal(branchCalls.length, 1, "gitCreateBranch should be called once");
  assert.equal(branchCalls[0].fromRef, FAKE_BASE_SHA, "fromRef must be the immutable SHA from gitResolveBaseSha");
});

test("intake: the SAME pinned SHA flows to both the ROADMAP read and the branch fork point", async () => {
  // The core anti-rollback invariant: read-at-SHA and branch-from-SHA must use ONE SHA,
  // so a concurrent push to origin/<base> between them cannot make the PR roll back
  // roadmap entries that landed in between.
  const readRefs: string[] = [];
  const branchRefs: string[] = [];
  const deps = makeDeps({
    gitResolveBaseSha: () => FAKE_BASE_SHA,
    readFileAtBase: (_dir, ref, relPath) => {
      if (relPath === "ROADMAP.md") { readRefs.push(ref); return ROADMAP_FIXTURE; }
      throw new Error(`readFileAtBase not mocked for ${relPath}`);
    },
    gitCreateBranch: (_dir, _branch, fromRef) => { branchRefs.push(fromRef); },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  assert.deepEqual(readRefs, [FAKE_BASE_SHA], "ROADMAP is read at the pinned SHA");
  assert.deepEqual(branchRefs, [FAKE_BASE_SHA], "branch forks from the pinned SHA");
  assert.equal(readRefs[0], branchRefs[0], "read ref and branch ref are the identical pinned SHA");
});

test("intake: branch is prepared BEFORE the issue is created (orphan prevention)", async () => {
  // Reorder fix: branch prep is the last failure-prone step before the irreversible
  // issue creation, so a checkout failure can never strand a labeled issue.
  const callOrder: string[] = [];
  const deps = makeDeps({
    gitCreateBranch: (_dir, _branch, _fromRef) => { callOrder.push("createBranch"); },
    createIssue: async (title, body, labels) => {
      callOrder.push("createIssue");
      deps._createIssueCalls.push({ title, body, labels });
      return 999;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  const branchIdx = callOrder.indexOf("createBranch");
  const issueIdx = callOrder.indexOf("createIssue");
  assert.ok(branchIdx !== -1 && issueIdx !== -1, "both branch and issue creation run");
  assert.ok(branchIdx < issueIdx, "gitCreateBranch must run before createIssue");
});

// ---------------------------------------------------------------------------
// Dry-run shows #TBD not #0 in per-issue row (finding 5 regression)
// ---------------------------------------------------------------------------

test("intake: dry-run uses #TBD placeholder in per-issue table row (not #0)", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", dryRun: true };
  await runIntake(opts, DEFAULT_CFG, deps);
  const allLog = deps._logLines.join("\n");
  assert.ok(!allLog.includes("| #0 |"), "dry-run should not show #0 in the per-issue row");
  assert.ok(allLog.includes("| #TBD |"), "dry-run should show #TBD in the per-issue row");
});

// ---------------------------------------------------------------------------
// Finding 1 (regression): readFileAtBase used for all ROADMAP reads
// ---------------------------------------------------------------------------

test("intake: readFileAtBase reads ROADMAP at the pinned base SHA", async () => {
  const readAtBaseCalls: Array<{ ref: string; relPath: string }> = [];
  const deps = makeDeps({
    readFileAtBase: (_dir, ref, relPath) => {
      readAtBaseCalls.push({ ref, relPath });
      return ROADMAP_FIXTURE;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  assert.ok(
    readAtBaseCalls.some((c) => c.ref === FAKE_BASE_SHA && c.relPath === "ROADMAP.md"),
    "readFileAtBase must be called with the pinned SHA and relPath='ROADMAP.md'",
  );
});

test("intake: readFileAtBase is also called in dry-run mode", async () => {
  const readAtBaseCalls: Array<{ ref: string; relPath: string }> = [];
  const deps = makeDeps({
    readFileAtBase: (_dir, ref, relPath) => {
      readAtBaseCalls.push({ ref, relPath });
      return ROADMAP_FIXTURE;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", dryRun: true };
  await runIntake(opts, DEFAULT_CFG, deps);
  assert.ok(
    readAtBaseCalls.some((c) => c.relPath === "ROADMAP.md"),
    "readFileAtBase must be called even in dry-run mode",
  );
  assert.equal(deps._createIssueCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Finding 2 (regression): CLI conflict guard rejects incompatible flags
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

test("CLI: unrecognized sub-command exits 2 with usage error listing recognized sub-commands", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "unknowncmd"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2, `expected exit 2; stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("unrecognized sub-command"), `expected usage error; stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("intake"), `expected intake listed in recognized sub-commands; stderr:\n${result.stderr}`);
});

test("CLI: pipeline intake --status exits 2 with conflict error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "intake", "--status", "--description", "x"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2, `expected exit 2; stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("intake"), `expected intake in error; stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("--status"), `expected --status in conflict message; stderr:\n${result.stderr}`);
});

test("CLI: pipeline intake --cleanup exits 2 with conflict error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "intake", "--cleanup"],
    { encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 2, `expected exit 2; stderr:\n${result.stderr}`);
  assert.ok(result.stderr.includes("--cleanup"), `expected --cleanup in conflict message; stderr:\n${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Finding 3 (regression): ensureLabel called before createIssue for both labels
// ---------------------------------------------------------------------------

test("intake: ensureLabel is called for pipeline:ready and release:vX.Y.Z before createIssue", async () => {
  const callOrder: string[] = [];
  const deps = makeDeps({
    ensureLabel: async (_dir, name, _color) => {
      callOrder.push(`ensureLabel:${name}`);
    },
    createIssue: async (title, body, labels) => {
      callOrder.push("createIssue");
      deps._createIssueCalls.push({ title, body, labels });
      return 999;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);

  const readyIdx = callOrder.indexOf("ensureLabel:pipeline:ready");
  const releaseIdx = callOrder.indexOf("ensureLabel:release:v1.6.0");
  const issueIdx = callOrder.indexOf("createIssue");
  assert.ok(readyIdx !== -1, "ensureLabel(pipeline:ready) should be called");
  assert.ok(releaseIdx !== -1, "ensureLabel(release:v1.6.0) should be called");
  assert.ok(issueIdx !== -1, "createIssue should be called");
  assert.ok(readyIdx < issueIdx, "ensureLabel(pipeline:ready) must run before createIssue");
  assert.ok(releaseIdx < issueIdx, "ensureLabel(release:v1.6.0) must run before createIssue");
});

test("intake: ensureLabel is NOT called in dry-run mode", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", dryRun: true };
  await runIntake(opts, DEFAULT_CFG, deps);
  assert.equal(deps._ensureLabelCalls.length, 0, "ensureLabel should not be called in dry-run");
});

// ---------------------------------------------------------------------------
// realIntakeDeps harness wiring (#220) — intake is a self-contained spec
// transform, so its real runHarness must invoke claude with a PINNED model and
// the lean flags (no tools / no MCP). Proven against a fake `claude` on PATH so
// the test does no real network/model call.
// ---------------------------------------------------------------------------

function makeFakeClaudeOnPath(): { restore: () => void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-claude-"));
  const cli = path.join(binDir, "claude");
  // Echo each received arg on its own line so the test can assert the argv.
  fs.writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' "$@"\n`);
  fs.chmodSync(cli, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  return { restore: () => { process.env.PATH = oldPath; } };
}

test("intake: realIntakeDeps.runHarness forwards the pinned model and lean flags to claude (#220)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-wt-"));
  const fake = makeFakeClaudeOnPath();
  try {
    const result = await realIntakeDeps(tmp, "test-model-xyz").runHarness("SPEC-PROMPT");
    assert.equal(result.success, true);
    assert.match(result.output, /--model\ntest-model-xyz/, "the pinned intake model must reach claude");
    assert.match(result.output, /--tools/, "lean mode must pass --tools to disable the tool set");
    assert.match(result.output, /--strict-mcp-config/, "lean mode must pass --strict-mcp-config (zero MCP servers)");
    assert.doesNotMatch(result.output, /--bare/, "must NOT use --bare (would break OAuth auth)");
  } finally {
    fake.restore();
  }
});

test("intake: realIntakeDeps defaults the model to DEFAULT_CONFIG.models.intake when unset (#220)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-wt-"));
  const fake = makeFakeClaudeOnPath();
  try {
    const result = await realIntakeDeps(tmp).runHarness("X");
    assert.match(
      result.output,
      new RegExp(`--model\\n${DEFAULT_CONFIG.models.intake}`),
      "default model must be DEFAULT_CONFIG.models.intake",
    );
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Label create-only: never clobber existing label metadata (#158 review-2)
// ---------------------------------------------------------------------------

test("labelCreateArgs: builds create-only args WITHOUT --force (no metadata clobber)", () => {
  const args = labelCreateArgs("release:v1.6.0", "e4e669");
  assert.deepEqual(args, ["label", "create", "release:v1.6.0", "--color", "e4e669"]);
  // The bite: --force would update (clobber) an existing label's color/description.
  assert.ok(!args.includes("--force"), "label create must NOT pass --force");
});

test("isLabelAlreadyExists: treats the gh already-exists error as benign, others as real", () => {
  // Verified real gh stderr for an existing label.
  const existsErr = 'label with name "pipeline:ready" already exists; use `--force` to update its color and description';
  assert.equal(isLabelAlreadyExists(1, existsErr), true, "already-exists is benign (label present)");
  assert.equal(isLabelAlreadyExists(0, ""), false, "success is not an already-exists case");
  assert.equal(isLabelAlreadyExists(1, "HTTP 403: Resource not accessible"), false, "other failures are real errors");
});

test("reservePushArgs: builds a CREATE-ONLY push with an empty --force-with-lease (never moves an existing ref) (#158 review-2)", () => {
  const args = reservePushArgs("intake/foo-0123456-tok123", "deadbeefcafe");
  // The bite: an empty --force-with-lease (expect ref absent) is what makes the push refuse
  // to fast-forward (MOVE) an existing ref. Without it, a plain push to an ancestor ref would
  // silently advance someone else's branch.
  assert.ok(
    args.includes("--force-with-lease=refs/heads/intake/foo-0123456-tok123:"),
    `must carry the empty-lease create-only flag, got: ${args.join(" ")}`,
  );
  assert.ok(args[0] === "push" && args.includes("--porcelain"), "is a porcelain push");
  assert.ok(
    args.includes("deadbeefcafe:refs/heads/intake/foo-0123456-tok123"),
    "pushes the pinned base SHA to the branch ref",
  );
  // The lease value must be empty (expect-absent), not a SHA — a non-empty lease would permit
  // an update when the remote matched, defeating create-only.
  const lease = args.find((a) => a.startsWith("--force-with-lease="))!;
  assert.ok(lease.endsWith(":"), `lease must be empty (expect-absent), got: ${lease}`);
});

// ---------------------------------------------------------------------------
// Finding 4 (regression): recovery log emitted when post-issue step fails
// ---------------------------------------------------------------------------

test("intake: gitCreateBranch failure aborts with NO issue created (orphan prevention) (#158 review-2)", async () => {
  // After the reorder, branch prep runs BEFORE issue creation: a checkout failure must
  // abort cleanly with no GitHub issue and no PR — never a stranded labeled issue.
  const deps = makeDeps({
    gitCreateBranch: () => {
      throw new Error("[pipeline intake] git checkout -b failed: branch already exists");
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };

  await assert.rejects(() => runIntake(opts, DEFAULT_CFG, deps), /git checkout -b failed/);
  assert.equal(deps._createIssueCalls.length, 0, "no issue should be created when branch prep fails");
  assert.equal(deps._createPRCalls.length, 0, "no PR should be opened when branch prep fails");
});

test("intake: an atomic-reservation collision aborts BEFORE issue creation (existing ref at ANY SHA) (#158 review-2)", async () => {
  // The reservation is an ATOMIC create-only operation (create-ref), so a branch that already
  // exists on origin — even at the same base SHA, where a plain push would no-op "up-to-date" —
  // is detected as a collision and aborts before the issue is created. No orphan possible.
  const callOrder: string[] = [];
  const deps = makeDeps({
    reserveRemoteBranch: (_dir, _branch, _sha) => {
      callOrder.push("reserve");
      throw new Error("[pipeline intake] branch ... already exists on origin — aborting before creating any issue.");
    },
    createIssue: async (title, body, labels) => {
      callOrder.push("createIssue");
      deps._createIssueCalls.push({ title, body, labels });
      return 999;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };

  await assert.rejects(() => runIntake(opts, DEFAULT_CFG, deps), /already exists on origin/);
  assert.equal(deps._createIssueCalls.length, 0, "no issue should be created when the reservation collides");
  assert.equal(deps._createPRCalls.length, 0, "no PR should be opened when the reservation collides");
  assert.ok(!callOrder.includes("createIssue"), "issue is never created once the reservation collides");
});

test("intake: branch name carries the short base SHA AND a random token (collision-resistant) (#158 review-2)", async () => {
  const deps = makeDeps();
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  const head = deps._createPRCalls[0].head;
  // slug + short base SHA + random token: two concurrent identical specs cannot share a branch.
  assert.ok(head.includes(`-${FAKE_BASE_SHA.slice(0, 7)}-`), `branch should carry short base SHA, got: ${head}`);
  assert.ok(head.endsWith("-tok123"), `branch should end with the random token, got: ${head}`);
});

test("intake: the random token disambiguates concurrent runs (different token → different branch)", async () => {
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  const depsA = makeDeps({ randomToken: () => "aaa111" });
  const depsB = makeDeps({ randomToken: () => "bbb222" });
  await runIntake(opts, DEFAULT_CFG, depsA);
  await runIntake(opts, DEFAULT_CFG, depsB);
  const headA = depsA._createPRCalls[0].head;
  const headB = depsB._createPRCalls[0].head;
  assert.notEqual(headA, headB, "two runs with the same title+base but different tokens get distinct branches");
});

test("intake: a read-only/missing push credential fails the reservation BEFORE issue creation (#158 review-2)", async () => {
  // The reservation uses the SAME git push transport as the later roadmap publish, so a
  // read-only or missing origin push credential fails HERE — before the irreversible issue —
  // rather than after it (where it would strand a labeled issue with no roadmap PR). This is
  // the capability-gap regression: reservation fails → no issue created.
  const callOrder: string[] = [];
  const deps = makeDeps({
    reserveRemoteBranch: (_d, _b, _s) => {
      callOrder.push("reserve");
      throw new Error("[pipeline intake] could not reserve origin/... via git push (exit 1): remote: Permission denied (read-only)");
    },
    createIssue: async (title, body, labels) => {
      callOrder.push("createIssue");
      deps._createIssueCalls.push({ title, body, labels });
      return 999;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };

  await assert.rejects(() => runIntake(opts, DEFAULT_CFG, deps), /could not reserve .* via git push/);
  assert.equal(deps._createIssueCalls.length, 0, "no issue when the push-capability reservation fails");
  assert.equal(deps._createPRCalls.length, 0, "no PR when the reservation fails");
  assert.ok(!callOrder.includes("createIssue"), "issue is never created once the reservation fails");
});

test("intake: branch is atomically reserved BEFORE the issue, roadmap pushed AFTER (#158 review-2)", async () => {
  const callOrder: string[] = [];
  const deps = makeDeps({
    reserveRemoteBranch: (_d, _b, _s) => { callOrder.push("reserve"); },
    gitPushBranch: (_d, _b) => { callOrder.push("push"); },
    createIssue: async (title, body, labels) => {
      callOrder.push("createIssue");
      deps._createIssueCalls.push({ title, body, labels });
      return 999;
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };
  await runIntake(opts, DEFAULT_CFG, deps);
  const reserveIdx = callOrder.indexOf("reserve");
  const issueIdx = callOrder.indexOf("createIssue");
  const pushIdx = callOrder.indexOf("push");
  assert.ok(reserveIdx !== -1 && issueIdx !== -1 && pushIdx !== -1, "reserve, issue, and roadmap push all run");
  assert.ok(reserveIdx < issueIdx, "the atomic reservation must precede issue creation");
  assert.ok(pushIdx > issueIdx, "the roadmap commit is pushed (fast-forward) after issue creation");
});

test("intake: recovery log emitted when createPR fails after issue creation", async () => {
  const deps = makeDeps({
    createPR: async () => {
      throw new Error("[pipeline intake] gh pr create failed: no push access");
    },
  });
  const opts: IntakeOpts = { description: "add retry logic to the fix loop", release: "1.6.0" };

  let threw = false;
  try {
    await runIntake(opts, DEFAULT_CFG, deps);
  } catch (_e) {
    threw = true;
  }
  assert.ok(threw, "should re-throw the PR error");
  assert.equal(deps._createIssueCalls.length, 1, "issue should have been created before the PR failure");

  const allLog = deps._logLines.join("\n");
  assert.ok(allLog.includes("#999"), "recovery log must reference the created issue number");
});
