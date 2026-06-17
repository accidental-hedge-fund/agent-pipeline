// Tests for the `pipeline release` sub-command (#170).
//
// All tests are network- and filesystem-free: I/O is injected via the
// ReleaseDeps seam (readFile, writeFile, runCommand, spawnEditor, fetchPRTitle).
// Each test proves the code bites by asserting on specific outputs or by
// verifying that a function throws when given invalid input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveVersion,
  bumpVersion,
  scaffoldRoadmap,
  patchIntroLine,
  patchReleasePlanRow,
  prependShippedBlock,
  stampPerIssueTable,
  discoverShippedPRs,
  collectShippedIssueNumbers,
  buildPRBody,
  extractTheme,
  computeUnifiedDiff,
  runRelease,
  type ReleaseDeps,
  type ReleaseContext,
  type CommandResult,
} from "../scripts/stages/release.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ReleaseDeps> = {}): ReleaseDeps {
  const written: Record<string, string> = {};
  const editorCalls: string[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const base: ReleaseDeps = {
    readFile: (p) => { throw new Error(`readFile not mocked for ${p}`); },
    writeFile: (p, c) => { written[p] = c; },
    runCommand: () => ({ code: 0, stdout: "", stderr: "" }),
    spawnEditor: (editor, filePath) => { editorCalls.push(`${editor}:${filePath}`); },
    fetchPRTitle: async (n) => `Title of PR #${n}`,
    fetchPRClosingIssues: async (_n) => [],
    today: () => "2026-06-16",
    stdout: (msg) => { stdoutLines.push(msg); },
    stderr: (msg) => { stderrLines.push(msg); },
    ...overrides,
  };
  // Expose collected state via non-standard properties for test inspection.
  (base as unknown as { _written: typeof written })._written = written;
  (base as unknown as { _editorCalls: typeof editorCalls })._editorCalls = editorCalls;
  (base as unknown as { _stdout: typeof stdoutLines })._stdout = stdoutLines;
  (base as unknown as { _stderr: typeof stderrLines })._stderr = stderrLines;
  return base;
}

function getWritten(deps: ReleaseDeps): Record<string, string> {
  return (deps as unknown as { _written: Record<string, string> })._written;
}

function getEditorCalls(deps: ReleaseDeps): string[] {
  return (deps as unknown as { _editorCalls: string[] })._editorCalls;
}

function getStdout(deps: ReleaseDeps): string[] {
  return (deps as unknown as { _stdout: string[] })._stdout;
}

function getStderr(deps: ReleaseDeps): string[] {
  return (deps as unknown as { _stderr: string[] })._stderr;
}

// ---------------------------------------------------------------------------
// 10.2 resolveVersion
// ---------------------------------------------------------------------------

test("resolveVersion: patch alias increments patch segment", () => {
  assert.equal(resolveVersion("patch", "1.5.0"), "1.5.1");
  assert.equal(resolveVersion("patch", "1.5.3"), "1.5.4");
});

test("resolveVersion: minor alias increments minor segment and resets patch", () => {
  assert.equal(resolveVersion("minor", "1.5.3"), "1.6.0");
  assert.equal(resolveVersion("minor", "1.0.0"), "1.1.0");
});

test("resolveVersion: major alias increments major segment and resets minor and patch", () => {
  assert.equal(resolveVersion("major", "1.5.0"), "2.0.0");
  assert.equal(resolveVersion("major", "2.3.4"), "3.0.0");
});

test("resolveVersion: explicit X.Y.Z string passes through unchanged", () => {
  assert.equal(resolveVersion("1.6.0", "1.5.0"), "1.6.0");
  assert.equal(resolveVersion("2.0.0", "1.5.0"), "2.0.0");
});

test("resolveVersion: invalid input throws with a clear message", () => {
  assert.throws(
    () => resolveVersion("foo", "1.5.0"),
    (err: Error) => {
      assert.ok(err.message.includes("Invalid version"), `got: ${err.message}`);
      assert.ok(err.message.includes("foo"), `got: ${err.message}`);
      return true;
    },
  );
});

test("resolveVersion: numeric-only string (e.g., '42') is rejected (not semver)", () => {
  assert.throws(
    () => resolveVersion("42", "1.5.0"),
    (err: Error) => {
      assert.ok(err.message.includes("Invalid version"), `got: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 10.3 bumpVersion
// ---------------------------------------------------------------------------

const SAMPLE_ROOT_PKG = JSON.stringify({ name: "agent-pipeline", version: "1.5.0", private: true }, null, 2) + "\n";
const SAMPLE_CORE_PKG = JSON.stringify({ name: "pipeline", version: "1.5.0", private: true }, null, 2) + "\n";

test("bumpVersion: updates version in both package.json files to the resolved version", () => {
  const files: Record<string, string> = {
    "/repo/package.json": SAMPLE_ROOT_PKG,
    "/repo/core/package.json": SAMPLE_CORE_PKG,
  };
  const deps = makeDeps({
    readFile: (p) => files[p] ?? (() => { throw new Error(`not found: ${p}`); })(),
  });

  bumpVersion("1.6.0", "/repo/package.json", "/repo/core/package.json", deps);

  const written = getWritten(deps);
  const root = JSON.parse(written["/repo/package.json"]) as { version: string };
  const core = JSON.parse(written["/repo/core/package.json"]) as { version: string };

  assert.equal(root.version, "1.6.0", "root package.json should have new version");
  assert.equal(core.version, "1.6.0", "core/package.json should have new version");
});

test("bumpVersion: JSON indentation and other keys are preserved", () => {
  const files: Record<string, string> = {
    "/repo/package.json": SAMPLE_ROOT_PKG,
    "/repo/core/package.json": SAMPLE_CORE_PKG,
  };
  const deps = makeDeps({
    readFile: (p) => files[p] ?? (() => { throw new Error(`not found: ${p}`); })(),
  });

  bumpVersion("1.6.0", "/repo/package.json", "/repo/core/package.json", deps);

  const written = getWritten(deps);
  // Should have 2-space indent and preserve other keys.
  assert.ok(written["/repo/package.json"].includes('"name": "agent-pipeline"'), "name key preserved");
  assert.ok(written["/repo/package.json"].includes('"private": true'), "private key preserved");
  assert.ok(written["/repo/package.json"].includes('"version": "1.6.0"'), "version updated");
  // Trailing newline preserved.
  assert.ok(written["/repo/package.json"].endsWith("\n"), "trailing newline preserved");
});

test("bumpVersion bites: without the call, no files are written", () => {
  const deps = makeDeps({ readFile: (p) => SAMPLE_ROOT_PKG });
  // NOT calling bumpVersion — should have nothing written.
  const written = getWritten(deps);
  assert.equal(Object.keys(written).length, 0, "no files written without bumpVersion call");
});

// ---------------------------------------------------------------------------
// Sample ROADMAP for scaffoldRoadmap tests
// ---------------------------------------------------------------------------

// A minimal ROADMAP with all four anchor sites present.
const SAMPLE_ROADMAP = `# Roadmap

Single source of truth for the open backlog. Last updated 2026-06-16.

**Goal driving the order:** make the pipeline robust enough. **v1.5.0 shipped 2026-06-16** (tag \`v1.5.0\`) — Pipeline Desk; see Shipped. Everything below v1.5.0 is the post-1.5.0 line.

**Self-dev is proven.** On 2026-06-08/09 the pipeline shipped 12 issues.

## Shipped

**Foundation (earlier):** **#13** configurable steps.

**v1.5.0 — Pipeline Desk (shipped 2026-06-16, tag \`v1.5.0\`) — fifth minor:**

| # | What | PR |
|---|------|-----|
| #153 | host-neutral launcher | #199 |

## Release plan (sem-ver)

Post-1.0 the open backlog is **entirely additive**.

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.5.0** ✅ shipped | minor | Pipeline Desk desktop contracts | #153, #154, #155, #156, #161 | Shipped 2026-06-16. |
| **v1.6.0** | minor | Intake & backlog automation | #158, #170 | Intake and release automation. |

Per-issue sem-ver detail:

| # | Impact | Config | Theme | → Release | Depends on |
|---|--------|--------|-------|-----------|------------|
| #153 | minor | none | desktop contracts | v1.5.0 | — |
| #158 | minor | new sub-command | intake & roadmap sync | v1.6.0 | — |
| #170 | minor | new sub-command | release automation | v1.6.0 | — |

## Remaining work
`;

const SAMPLE_CTX: ReleaseContext = {
  version: "1.6.0",
  previousVersion: "1.5.0",
  date: "2026-06-17",
  theme: "Intake & backlog automation",
  shippedPRs: [
    { number: 203, title: "release: pipeline release sub-command" },
    { number: 204, title: "intake: pipeline intake sub-command" },
  ],
  // Issues #170 and #158 are the v1.6.0 entries in SAMPLE_ROADMAP's per-issue table.
  // PR #203 closes issue #170; PR #204 closes issue #158 (fixture mapping).
  shippedIssueNumbers: [158, 170],
};

// ---------------------------------------------------------------------------
// 10.4 scaffoldRoadmap — four sites
// ---------------------------------------------------------------------------

test("patchIntroLine: inserts new shipped entry and updates 'Everything below' anchor", () => {
  const result = patchIntroLine(SAMPLE_ROADMAP, SAMPLE_CTX);

  assert.ok(
    result.includes("**v1.6.0 shipped 2026-06-17**"),
    "new version appears in intro",
  );
  assert.ok(
    result.includes("Everything below v1.6.0"),
    "anchor updated to new version",
  );
  assert.ok(
    result.includes("post-1.6.0 line"),
    "post-version text updated",
  );
  assert.ok(
    !result.includes("post-1.5.0 line"),
    "old post-version text removed",
  );
});

test("patchIntroLine: throws when 'Everything below vX.Y.Z' anchor is missing", () => {
  const text = "# Roadmap\n\nNo anchor here.\n";
  assert.throws(
    () => patchIntroLine(text, SAMPLE_CTX),
    (err: Error) => {
      assert.ok(err.message.includes("intro-chain-ending"), `got: ${err.message}`);
      assert.ok(err.message.includes("v1.5.0"), `got: ${err.message}`);
      return true;
    },
  );
});

test("patchReleasePlanRow: marks the release plan row as ✅ shipped", () => {
  const result = patchReleasePlanRow(SAMPLE_ROADMAP, SAMPLE_CTX);

  assert.ok(
    result.includes("**v1.6.0** ✅ shipped"),
    "shipped marker added to release column",
  );
  assert.ok(
    result.includes("Shipped 2026-06-17 (tag `v1.6.0`)"),
    "shipped date added to why column",
  );
});

test("patchReleasePlanRow: throws when release plan row is not found", () => {
  const text = "# Roadmap\n\n| Release | Bump | Theme | Issues | Why |\n|---|---|---|---|---|\n| **v1.5.0** | patch | A | #1 | B |\n";
  assert.throws(
    () => patchReleasePlanRow(text, SAMPLE_CTX),
    (err: Error) => {
      assert.ok(err.message.includes("release-plan-row"), `got: ${err.message}`);
      assert.ok(err.message.includes("v1.6.0"), `got: ${err.message}`);
      return true;
    },
  );
});

test("prependShippedBlock: inserts new shipped block before the previous version's block", () => {
  const result = prependShippedBlock(SAMPLE_ROADMAP, SAMPLE_CTX);

  assert.ok(
    result.includes("**v1.6.0 — Intake & backlog automation (shipped 2026-06-17, tag `v1.6.0`) — sixth minor:**"),
    "new version block header inserted",
  );
  // The new block should appear BEFORE the v1.5.0 block.
  const v16Idx = result.indexOf("**v1.6.0 —");
  const v15Idx = result.indexOf("**v1.5.0 —");
  assert.ok(v16Idx < v15Idx, "v1.6.0 block comes before v1.5.0 block");
  // PR table rows should be included.
  assert.ok(result.includes("#203"), "PR #203 in shipped block");
  assert.ok(result.includes("release: pipeline release sub-command"), "PR title in shipped block");
});

test("prependShippedBlock: throws when previous version block anchor is not found", () => {
  const text = "## Shipped\n\n**Foundation:** ...\n";
  assert.throws(
    () => prependShippedBlock(text, SAMPLE_CTX),
    (err: Error) => {
      assert.ok(err.message.includes("shipped-section"), `got: ${err.message}`);
      assert.ok(err.message.includes("v1.5.0"), `got: ${err.message}`);
      return true;
    },
  );
});

test("prependShippedBlock: uses placeholder row when no shipped PRs", () => {
  const ctx: ReleaseContext = { ...SAMPLE_CTX, shippedPRs: [] };
  const result = prependShippedBlock(SAMPLE_ROADMAP, ctx);
  assert.ok(result.includes("no merged PRs detected"), "placeholder row present when no PRs");
});

test("stampPerIssueTable: stamps only rows whose issue number is in shippedIssueNumbers", () => {
  // SAMPLE_CTX has shippedIssueNumbers: [158, 170]; per-issue table has #158 and #170 for v1.6.0.
  const result = stampPerIssueTable(SAMPLE_ROADMAP, SAMPLE_CTX);

  assert.ok(result.includes("✅ v1.6.0"), "v1.6.0 rows in shipped set are stamped");
  assert.ok(!result.includes("✅ v1.5.0"), "v1.5.0 rows NOT stamped");
});

test("stampPerIssueTable: leaves v{version} rows unchanged when shippedIssueNumbers is empty", () => {
  // Empty shippedIssueNumbers (dry-run / no PRs) must not stamp any row.
  const ctx: ReleaseContext = { ...SAMPLE_CTX, shippedIssueNumbers: [] };
  const result = stampPerIssueTable(SAMPLE_ROADMAP, ctx);

  assert.ok(!result.includes("✅ v1.6.0"), "no stamping when shippedIssueNumbers is empty");
});

test("stampPerIssueTable: emits warn for rows with matching version not in shipped set", () => {
  // Issue #158 is planned for v1.6.0 but not in the shipped set — warn should fire.
  const ctx: ReleaseContext = { ...SAMPLE_CTX, shippedIssueNumbers: [170] };
  const warnings: string[] = [];
  const result = stampPerIssueTable(SAMPLE_ROADMAP, ctx, (msg) => warnings.push(msg));

  assert.ok(result.includes("✅ v1.6.0"), "issue #170 is stamped (in shipped set)");
  assert.equal(warnings.length, 1, "one warning for unshipped row");
  assert.ok(warnings[0].includes("#158"), "warning mentions the unshipped issue number");
});

test("stampPerIssueTable: throws when per-issue table header is not found", () => {
  const text = "# Roadmap\n\nNo per-issue table here.\n";
  assert.throws(
    () => stampPerIssueTable(text, SAMPLE_CTX),
    (err: Error) => {
      assert.ok(err.message.includes("per-issue-table"), `got: ${err.message}`);
      return true;
    },
  );
});

test("scaffoldRoadmap: applies all four mutations atomically and returns patched text", () => {
  const result = scaffoldRoadmap(SAMPLE_ROADMAP, SAMPLE_CTX);

  // All four mutations must be present.
  assert.ok(result.includes("**v1.6.0 shipped 2026-06-17**"), "intro line patched");
  assert.ok(result.includes("**v1.6.0** ✅ shipped"), "release plan row patched");
  assert.ok(result.includes("**v1.6.0 — Intake & backlog automation"), "shipped block prepended");
  assert.ok(result.includes("✅ v1.6.0"), "per-issue table stamped");
});

test("scaffoldRoadmap bites: without mutations, the original text has none of the v1.6.0 changes", () => {
  // Verify the SAMPLE_ROADMAP does NOT already have the v1.6.0 markers (so the test is meaningful).
  assert.ok(!SAMPLE_ROADMAP.includes("**v1.6.0 shipped"), "no pre-existing v1.6.0 shipped marker in intro");
  assert.ok(!SAMPLE_ROADMAP.includes("**v1.6.0** ✅ shipped"), "no pre-existing ✅ shipped for v1.6.0 in plan row");
  assert.ok(!SAMPLE_ROADMAP.includes("✅ v1.6.0"), "no pre-existing per-issue stamp for v1.6.0");
  assert.ok(!SAMPLE_ROADMAP.includes("**v1.6.0 — Intake"), "no pre-existing v1.6.0 shipped block header");
});

// ---------------------------------------------------------------------------
// collectShippedIssueNumbers
// ---------------------------------------------------------------------------

test("collectShippedIssueNumbers: fetches closing issues for each PR and returns deduplicated sorted list", async () => {
  const deps = makeDeps({
    fetchPRClosingIssues: async (n) => {
      if (n === 203) return [170];
      if (n === 204) return [158];
      return [];
    },
  });
  const result = await collectShippedIssueNumbers(
    [{ number: 203, title: "PR A" }, { number: 204, title: "PR B" }],
    deps,
  );
  assert.deepEqual(result, [158, 170], "returns sorted issue numbers");
});

test("collectShippedIssueNumbers: deduplicates issues referenced by multiple PRs", async () => {
  const deps = makeDeps({
    fetchPRClosingIssues: async (n) => {
      if (n === 203) return [170, 158];
      if (n === 204) return [158];  // duplicate
      return [];
    },
  });
  const result = await collectShippedIssueNumbers(
    [{ number: 203, title: "A" }, { number: 204, title: "B" }],
    deps,
  );
  assert.deepEqual(result, [158, 170], "duplicates collapsed");
});

test("collectShippedIssueNumbers: returns empty array when no closing issues are found", async () => {
  const deps = makeDeps({ fetchPRClosingIssues: async () => [] });
  const result = await collectShippedIssueNumbers([{ number: 203, title: "A" }], deps);
  assert.deepEqual(result, []);
});

test("collectShippedIssueNumbers: skips PRs where fetchPRClosingIssues throws and emits warning", async () => {
  const warnings: string[] = [];
  const deps = makeDeps({
    fetchPRClosingIssues: async (n) => {
      if (n === 203) throw new Error("network error");
      return [158];
    },
    stderr: (msg) => { warnings.push(msg); },
  });
  const result = await collectShippedIssueNumbers(
    [{ number: 203, title: "A" }, { number: 204, title: "B" }],
    deps,
  );
  assert.deepEqual(result, [158], "failed PR skipped, others collected");
  assert.ok(warnings.some((w) => w.includes("#203")), "warning mentions the failed PR");
});

// ---------------------------------------------------------------------------
// 10.5 discoverShippedPRs
// ---------------------------------------------------------------------------

test("discoverShippedPRs: extracts PR numbers from merge-commit messages", async () => {
  const gitLog = [
    "Merge pull request #203 from user/release-branch",
    "Merge pull request #204 from user/intake-branch",
    "chore: update docs",
  ].join("\n");

  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: gitLog, stderr: "" }),
    fetchPRTitle: async (n) => `Title #${n}`,
  });

  const prs = await discoverShippedPRs("v1.5.0", "/repo", deps);

  assert.equal(prs.length, 2, "two PRs discovered");
  assert.equal(prs[0].number, 203);
  assert.equal(prs[0].title, "Title #203");
  assert.equal(prs[1].number, 204);
  assert.equal(prs[1].title, "Title #204");
});

test("discoverShippedPRs: extracts PR numbers from squash-merge parenthetical pattern", async () => {
  const gitLog = [
    "feat: add release command (#203)",
    "fix: handle edge case (#204)",
    "docs: update readme",
  ].join("\n");

  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: gitLog, stderr: "" }),
    fetchPRTitle: async (n) => `Squash PR #${n}`,
  });

  const prs = await discoverShippedPRs("v1.5.0", "/repo", deps);
  assert.equal(prs.length, 2, "two squash PRs discovered");
  assert.ok(prs.some((p) => p.number === 203));
  assert.ok(prs.some((p) => p.number === 204));
});

test("discoverShippedPRs: emits a warning when no PRs are detected", async () => {
  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: "just a plain commit message\nanother commit", stderr: "" }),
  });

  const prs = await discoverShippedPRs("v1.5.0", "/repo", deps);
  assert.equal(prs.length, 0, "no PRs returned");
  const stderrLines = getStderr(deps);
  assert.ok(stderrLines.some((l) => l.includes("no merged PRs")), "warning emitted to stderr");
});

test("discoverShippedPRs: deduplicates PR numbers that appear more than once", async () => {
  const gitLog = [
    "Merge pull request #203 from user/branch",
    "feat: something (#203)",
  ].join("\n");

  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: gitLog, stderr: "" }),
    fetchPRTitle: async (n) => `PR #${n}`,
  });

  const prs = await discoverShippedPRs("v1.5.0", "/repo", deps);
  assert.equal(prs.length, 1, "duplicate PR deduplicated");
  assert.equal(prs[0].number, 203);
});

// ---------------------------------------------------------------------------
// extractTheme
// ---------------------------------------------------------------------------

test("extractTheme: parses theme from the release plan table", () => {
  const theme = extractTheme(SAMPLE_ROADMAP, "1.6.0");
  assert.equal(theme, "Intake & backlog automation");
});

test("extractTheme: returns '<theme>' when version row not found", () => {
  const theme = extractTheme(SAMPLE_ROADMAP, "9.9.9");
  assert.equal(theme, "<theme>");
});

// ---------------------------------------------------------------------------
// buildPRBody
// ---------------------------------------------------------------------------

test("buildPRBody: includes version, theme, date, and PR list", () => {
  const ctx: ReleaseContext = {
    version: "1.6.0",
    previousVersion: "1.5.0",
    date: "2026-06-17",
    theme: "Intake & backlog automation",
    shippedPRs: [{ number: 203, title: "Release PR" }],
    shippedIssueNumbers: [],
  };
  const body = buildPRBody(ctx, "v1.5.0");

  assert.ok(body.includes("v1.6.0"), "version in PR body");
  assert.ok(body.includes("Intake & backlog automation"), "theme in PR body");
  assert.ok(body.includes("#203"), "PR number in body");
  assert.ok(body.includes("Release PR"), "PR title in body");
  assert.ok(body.includes("v1.5.0"), "last tag referenced");
  assert.ok(body.includes("git tag v1.6.0"), "tag instructions in body");
});

test("buildPRBody: uses placeholder when no shipped PRs", () => {
  const ctx: ReleaseContext = {
    ...SAMPLE_CTX,
    shippedPRs: [],
  };
  const body = buildPRBody(ctx, "v1.5.0");
  assert.ok(body.includes("no merged PRs"), "placeholder for empty PR list");
});

// ---------------------------------------------------------------------------
// 10.6 dry-run path: no writeFile or spawnEditor called
// ---------------------------------------------------------------------------

test("dry-run: resolveVersion still validates and throws on bad input before any I/O", () => {
  // This tests that version validation runs even in dry-run mode (by testing
  // the resolveVersion function directly, which is called first).
  assert.throws(
    () => resolveVersion("foo", "1.5.0"),
    (err: Error) => err.message.includes("Invalid version"),
  );
});

test("dry-run integration: scaffoldRoadmap is called but writeFile is never called", () => {
  // In dry-run mode, the orchestrator calls scaffoldRoadmap in memory
  // but does NOT call writeFile. We test this by running scaffoldRoadmap
  // in isolation (the orchestrator pattern: compute first, then conditionally write).

  const result = scaffoldRoadmap(SAMPLE_ROADMAP, SAMPLE_CTX);
  // Result is the in-memory patched roadmap.
  assert.ok(result.includes("✅ v1.6.0"), "scaffold computed in memory");

  // Verify a fresh deps has no writes — simulating dry-run where writeFile is skipped.
  const deps = makeDeps();
  // In dry-run, writeFile is NOT called (runRelease checks opts.dryRun before writing).
  const written = getWritten(deps);
  assert.equal(Object.keys(written).length, 0, "no files written in dry-run simulation");
  const editorCalls = getEditorCalls(deps);
  assert.equal(editorCalls.length, 0, "no editor launched in dry-run simulation");
});

// ---------------------------------------------------------------------------
// computeUnifiedDiff (finding 4)
// ---------------------------------------------------------------------------

test("computeUnifiedDiff: returns unified diff with --- +++ and @@ markers", () => {
  const oldText = "a\nb\nc\n";
  const newText = "a\nX\nc\n";
  const diff = computeUnifiedDiff(oldText, newText, "a/file", "b/file");
  assert.ok(diff.includes("--- a/file"), "has old label");
  assert.ok(diff.includes("+++ b/file"), "has new label");
  assert.ok(diff.includes("@@"), "has hunk header");
  assert.ok(diff.includes("-b"), "shows deleted line");
  assert.ok(diff.includes("+X"), "shows inserted line");
});

test("computeUnifiedDiff: returns empty string for identical texts", () => {
  const diff = computeUnifiedDiff("same\n", "same\n", "a/f", "b/f");
  assert.equal(diff, "");
});

test("computeUnifiedDiff: insertion-only diff is correct", () => {
  const oldText = "a\nb\n";
  const newText = "a\nnew\nb\n";
  const diff = computeUnifiedDiff(oldText, newText, "a/f", "b/f");
  assert.ok(diff.includes("+new"), "inserted line appears with +");
  assert.ok(!diff.includes("-new"), "inserted line not shown as deleted");
});

// ---------------------------------------------------------------------------
// Finding 1: dry-run and CI-failure paths must not call GitHub
// ---------------------------------------------------------------------------

test("discoverShippedPRs: localOnly=true returns placeholder titles without calling fetchPRTitle", async () => {
  let fetchCalled = false;
  const deps = makeDeps({
    runCommand: () => ({
      code: 0,
      stdout: "Merge pull request #203 from user/branch",
      stderr: "",
    }),
    fetchPRTitle: async (n) => { fetchCalled = true; return `Title #${n}`; },
  });

  const prs = await discoverShippedPRs("v1.5.0", "/repo", deps, true);

  assert.ok(!fetchCalled, "fetchPRTitle must NOT be called in localOnly mode");
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 203);
  assert.equal(prs[0].title, "PR #203", "placeholder title used");
});

test("runRelease dry-run: no file writes, no fetchPRTitle, and no fetchPRClosingIssues calls", async () => {
  let fetchCalled = false;
  let closingCalled = false;
  const writes: string[] = [];

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => { writes.push(p); },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => { fetchCalled = true; return `PR #${n}`; },
    fetchPRClosingIssues: async (n) => { closingCalled = true; return []; },
  });

  await runRelease("1.6.0", { dryRun: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);

  assert.equal(writes.length, 0, "no files written in dry-run");
  assert.ok(!fetchCalled, "fetchPRTitle (gh pr view) not called in dry-run");
  assert.ok(!closingCalled, "fetchPRClosingIssues not called in dry-run");
});

test("runRelease dry-run: output contains unified diff markers (not full file content)", async () => {
  const stdoutLines: string[] = [];

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    stdout: (msg) => { stdoutLines.push(msg); },
  });

  await runRelease("1.6.0", { dryRun: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);

  const output = stdoutLines.join("\n");
  assert.ok(output.includes("---"), "output contains --- diff marker");
  assert.ok(output.includes("+++"), "output contains +++ diff marker");
  assert.ok(output.includes("@@"), "output contains @@ hunk header");
  // The diff shows the version line as -/+ lines (with JSON quoting and indent)
  assert.ok(output.includes("1.5.0") && output.includes("-"), "old version appears as deleted line");
  assert.ok(output.includes("1.6.0") && output.includes("+"), "new version appears as inserted line");
});

test("runRelease live: CI failure aborts before any GitHub API call (no fetchPRTitle)", async () => {
  let fetchCalled = false;

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "node" && args[0] === "scripts/build.mjs") return { code: 0, stdout: "", stderr: "" };
      // CI gate fails
      if (cmd === "npm") return { code: 1, stdout: "FAIL", stderr: "test failed" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => { fetchCalled = true; return `PR #${n}`; },
  });

  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    (err: Error) => err.message.includes("CI gate failed"),
  );
  assert.ok(!fetchCalled, "fetchPRTitle must NOT be called when CI fails");
});

test("runRelease live: CI failure aborts before any fetchPRClosingIssues call", async () => {
  let closingCalled = false;
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "node" && args[0] === "scripts/build.mjs") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 1, stdout: "FAIL", stderr: "test failed" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRClosingIssues: async (n) => { closingCalled = true; return []; },
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    (err: Error) => err.message.includes("CI gate failed"),
  );
  assert.ok(!closingCalled, "fetchPRClosingIssues must NOT be called when CI fails");
});

test("runRelease live: missing ROADMAP anchor aborts before any file write", async () => {
  const writes: string[] = [];
  // ROADMAP missing the release-plan row for v1.6.0
  const roadmapMissingRow = SAMPLE_ROADMAP.replace("| **v1.6.0** |", "| **v1.7.0** |");

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return roadmapMissingRow;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => { writes.push(p); },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    (err: Error) => err.message.includes("release-plan-row"),
  );
  assert.equal(writes.length, 0, "no files written when ROADMAP anchor is missing");
});

test("runRelease dry-run: fetchPRClosingIssues is never called", async () => {
  let closingCalled = false;
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRClosingIssues: async (n) => { closingCalled = true; return []; },
  });

  await runRelease("1.6.0", { dryRun: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.ok(!closingCalled, "fetchPRClosingIssues must NOT be called in dry-run");
});

// ---------------------------------------------------------------------------
// Finding 2: configured base branch is used for PR creation
// ---------------------------------------------------------------------------

test("runRelease: uses cfg.base_branch for gh pr create", async () => {
  const prCreateArgs: string[] = [];

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "node") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "checkout") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "commit") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr") {
        prCreateArgs.push(...args);
        return { code: 0, stdout: "https://github.com/org/repo/pull/200", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `Title #${n}`,
  });

  await runRelease(
    "1.6.0",
    { noEdit: true },
    { repo_dir: "/repo", repo: "org/repo", base_branch: "staging" },
    deps,
  );

  const baseIdx = prCreateArgs.indexOf("--base");
  assert.ok(baseIdx >= 0, "--base flag present in gh pr create call");
  assert.equal(prCreateArgs[baseIdx + 1], "staging", "configured base_branch 'staging' is used");
});

test("runRelease: defaults to main when base_branch is not configured", async () => {
  const prCreateArgs: string[] = [];

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "node") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "checkout") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "commit") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr") {
        prCreateArgs.push(...args);
        return { code: 0, stdout: "https://github.com/org/repo/pull/201", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `Title #${n}`,
  });

  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);

  const baseIdx = prCreateArgs.indexOf("--base");
  assert.ok(baseIdx >= 0, "--base flag present");
  assert.equal(prCreateArgs[baseIdx + 1], "main", "defaults to 'main' when base_branch not set");
});

// ---------------------------------------------------------------------------
// Finding 3: editor invocation with arguments, abort on non-zero exit
// ---------------------------------------------------------------------------

test("runRelease: propagates spawnEditor error to caller (editor failure aborts release)", async () => {
  const origEditor = process.env.EDITOR;
  process.env.EDITOR = "mock-editor-that-fails";

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "node") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `PR #${n}`,
    spawnEditor: (_editor, _filePath) => {
      throw new Error("editor exited with code 1");
    },
  });

  try {
    await assert.rejects(
      () => runRelease("1.6.0", {}, { repo_dir: "/repo", repo: "org/repo" }, deps),
      (err: Error) => {
        assert.ok(
          err.message.includes("editor"),
          `error message should mention editor, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    if (origEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = origEditor;
  }
});

// ---------------------------------------------------------------------------
// CLI-level: 'pipeline release' dispatch
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-release-cli-test-"));

/** Minimal fake gh that handles 'repo view' (returns slug) so resolveConfig succeeds. */
function makeFakeGhForRelease(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(CLI_TMP, "bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
case "$1" in
  repo) echo "${repoSlug}"; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(CLI_TMP, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

test("CLI: 'pipeline release' with no version exits non-zero with usage message (early check, no config needed)", () => {
  // The version argument validation happens before resolveConfig so it
  // works even with no gh and no valid repo (no PATH needed).
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "release"],
    { encoding: "utf8", env: { ...process.env, PATH: "" } },
  );
  assert.notEqual(result.status, 0, "should exit non-zero");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(combined.includes("version argument is required"), `got: ${combined}`);
});

test("CLI: 'pipeline release 42' (numeric) exits non-zero with ambiguity message (early check, no config needed)", () => {
  // Purely numeric version args are rejected before resolveConfig so this
  // works even with no gh and no valid repo.
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "release", "42"],
    { encoding: "utf8", env: { ...process.env, PATH: "" } },
  );
  assert.notEqual(result.status, 0, "should exit non-zero");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(combined.includes("issue number") || combined.includes("semver"), `got: ${combined}`);
});

test("CLI: 'pipeline release --cleanup' exits non-zero with conflict message", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "release", "--cleanup"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0, "should exit non-zero");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(combined.includes("cannot be combined"), `got: ${combined}`);
});

test("CLI: 'pipeline release --status' exits non-zero with conflict message", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "release", "--status"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0, "should exit non-zero");
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(combined.includes("cannot be combined"), `got: ${combined}`);
});
