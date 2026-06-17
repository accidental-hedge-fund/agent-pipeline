// Tests for the `pipeline intake` sub-command (#158).
//
// All tests are network- and filesystem-free: I/O is injected via the
// IntakeDeps seam. Each test proves the code bites (assertions on specific
// outcomes, error cases, or missing deps calls).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runIntake,
  inferReleaseSlot,
  parseSpec,
  extractOneLiner,
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

function makeDeps(overrides: Partial<IntakeDeps> = {}): IntakeDeps & {
  _createIssueCalls: Array<{ title: string; body: string; labels: string[] }>;
  _createPRCalls: Array<{ title: string; body: string; base: string; head: string }>;
  _writtenFiles: Record<string, string>;
  _logLines: string[];
} {
  const createIssueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const createPRCalls: Array<{ title: string; body: string; base: string; head: string }> = [];
  const writtenFiles: Record<string, string> = {};
  const logLines: string[] = [];

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
    readFile: (p) => {
      if (p.endsWith("ROADMAP.md")) return ROADMAP_FIXTURE;
      throw new Error(`readFile not mocked for ${p}`);
    },
    writeFile: (p, content) => {
      writtenFiles[p] = content;
    },
    gitCreateBranch: (_dir, _branch) => {},
    gitCommit: (_dir, _files, _msg) => {},
    createPR: async (_dir, title, body, base, head) => {
      createPRCalls.push({ title, body, base, head });
      return "https://github.com/owner/repo/pull/42";
    },
    log: (msg) => logLines.push(msg),
    ...overrides,
  };

  (base as unknown as { _createIssueCalls: typeof createIssueCalls })._createIssueCalls = createIssueCalls;
  (base as unknown as { _createPRCalls: typeof createPRCalls })._createPRCalls = createPRCalls;
  (base as unknown as { _writtenFiles: typeof writtenFiles })._writtenFiles = writtenFiles;
  (base as unknown as { _logLines: typeof logLines })._logLines = logLines;
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
  assert.ok(prCall.head.startsWith("intake/issue-999-"), "PR head branch should follow intake/issue-N- convention");
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
    readFile: (p) => {
      if (p.endsWith("ROADMAP.md")) return roadmapWithoutNoneRow;
      throw new Error(`readFile not mocked for ${p}`);
    },
  });
  const opts: IntakeOpts = { description: "add retry logic", release: "1.6.0" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /ROADMAP anchor not found/,
  );
});

test("intake: exits non-zero with anchor name when detail section is absent for version", async () => {
  const roadmapWithoutSection = ROADMAP_FIXTURE.replace(
    "### v1.6.0 — intake & backlog automation (minor)",
    "### v1.7.0 — something else (minor)",
  );
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("ROADMAP.md")) return roadmapWithoutSection;
      throw new Error(`readFile not mocked for ${p}`);
    },
  });
  const opts: IntakeOpts = { description: "add retry logic", release: "1.6.0" };

  await assert.rejects(
    () => runIntake(opts, DEFAULT_CFG, deps),
    /ROADMAP anchor not found.*detail-section/,
  );
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
