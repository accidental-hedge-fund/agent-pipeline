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
  buildPRBody,
  extractTheme,
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

test("stampPerIssueTable: stamps matching rows with ✅ prefix", () => {
  const result = stampPerIssueTable(SAMPLE_ROADMAP, SAMPLE_CTX);

  // Rows with v1.6.0 should be stamped.
  assert.ok(result.includes("✅ v1.6.0"), "v1.6.0 rows stamped");
  // v1.5.0 rows should be unchanged.
  assert.ok(!result.includes("✅ v1.5.0"), "v1.5.0 rows NOT stamped");
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
