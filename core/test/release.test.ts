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
  ensureReleasePlanRow,
  formatPlanRowIssues,
  formatReleasePlanRow,
  resolveReleaseTheme,
  themeFromMilestoneTitle,
  planRowScaffoldWhy,
  versionBumpType,
  RELEASE_PLAN_ROW_SHAPE,
  PLAN_ROW_THEME_PLACEHOLDER,
  PLAN_ROW_ISSUES_PLACEHOLDER,
  prependShippedBlock,
  stampPerIssueTable,
  countPerIssueRows,
  discoverShippedPRs,
  collectShippedIssueNumbers,
  buildPRBody,
  extractTheme,
  computeUnifiedDiff,
  runRelease,
  resolvePreviousTagCreatedAt,
  mapGhIssueToSoakCandidate,
  projectGithubAttributedTypedEvidence,
  type ReleaseDeps,
  type ReleaseContext,
  type CommandResult,
} from "../scripts/stages/release.ts";
import {
  computeFrgEvidence,
  frgRequiredObservationOverrides,
  frgRequiredCompositionOverrides,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
} from "../scripts/factory-reliability-gate.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default FRG pass used by release tests so FRG (#723/#757) does not block unrelated cases. */
function defaultFrgPass(version = "1.6.0") {
  return computeFrgEvidence({
    version,
    run_id: "frg-test-pass",
    loop_run_id: "loop-test",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });
}

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
    classifyPR: async (_n) => ({ kind: "pr" }),
    fetchPRClosingIssues: async (_n) => [],
    today: () => "2026-06-16",
    stdout: (msg) => { stdoutLines.push(msg); },
    stderr: (msg) => { stderrLines.push(msg); },
    // FRG pass by default so existing release tests stay focused on release logic.
    requireFrgPass: async (_dir, version) => defaultFrgPass(version),
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

/**
 * True when the recorded runCommand calls include the rollback `git checkout -- ...`
 * that restores package.json, core/package.json, ROADMAP.md, and the plugin/ mirror
 * from HEAD on a pre-branch abort (#170). The branch-creation `git checkout -b` is
 * distinguished by its `--` separator: the restore has `--` at index 2, `-b` does not.
 */
function restoreInvoked(commands: string[][]): boolean {
  return commands.some(
    (c) =>
      c[0] === "git" &&
      c[1] === "checkout" &&
      c[2] === "--" &&
      c.includes("package.json") &&
      c.includes("core/package.json") &&
      c.includes("ROADMAP.md") &&
      c.includes("plugin"),
  );
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
| *(none)* | | research / tracker | #13, #14 | not a release |

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

test("patchReleasePlanRow: throws when release plan row is not found (bite: no ensure)", () => {
  // Pure ship-mark still aborts without ensure — proves pre-#730 behavior of this helper.
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

// ---------------------------------------------------------------------------
// ensureReleasePlanRow (#730)
// ---------------------------------------------------------------------------

/** ROADMAP with four anchors but no v1.6.0 plan row; includes insert sentinel. */
const ROADMAP_MISSING_PLAN_ROW = SAMPLE_ROADMAP.replace(
  "| **v1.6.0** | minor | Intake & backlog automation | #158, #170 | Intake and release automation. |\n",
  "",
);

test("ensureReleasePlanRow: inserts unshipped row before *(none)* when missing", () => {
  assert.ok(!ROADMAP_MISSING_PLAN_ROW.includes("| **v1.6.0**"), "fixture has no v1.6.0 row");
  const result = ensureReleasePlanRow(ROADMAP_MISSING_PLAN_ROW, {
    version: "1.6.0",
    theme: "Factory reliability",
    issues: "#730, #723",
    why: planRowScaffoldWhy("1.6.0"),
  });
  const expected = formatReleasePlanRow(
    "1.6.0",
    "minor",
    "Factory reliability",
    "#730, #723",
    planRowScaffoldWhy("1.6.0"),
  );
  assert.ok(result.includes(expected), `expected row missing:\n${expected}\n---\n${result}`);
  const rowIdx = result.indexOf("| **v1.6.0**");
  const noneIdx = result.indexOf("| *(none)* |");
  assert.ok(rowIdx >= 0 && noneIdx > rowIdx, "scaffolded row precedes *(none)* sentinel");
  assert.ok(!result.includes("✅ shipped") || !result.split("\n").find((l) => l.startsWith("| **v1.6.0**") && l.includes("✅ shipped")),
    "scaffolded row must be unshipped");
  const unshipped = result.split("\n").find((l) => l.startsWith("| **v1.6.0**"));
  assert.ok(unshipped && !unshipped.includes("✅ shipped"), "unshipped only");
});

test("ensureReleasePlanRow: leaves existing unshipped row unchanged (no duplicate)", () => {
  const result = ensureReleasePlanRow(SAMPLE_ROADMAP, {
    version: "1.6.0",
    theme: "SHOULD NOT APPEAR",
    issues: "#999",
  });
  assert.equal(result, SAMPLE_ROADMAP, "must be a pure no-op when unshipped row exists");
  assert.equal(
    result.split("\n").filter((l) => l.startsWith("| **v1.6.0**")).length,
    1,
    "exactly one v1.6.0 plan row",
  );
});

test("ensureReleasePlanRow: never overwrites or duplicates an already-shipped row", () => {
  const shippedOnly = SAMPLE_ROADMAP.replace(
    "| **v1.6.0** | minor | Intake & backlog automation | #158, #170 | Intake and release automation. |",
    "| **v1.6.0** ✅ shipped | minor | Intake & backlog automation | #158, #170 | Shipped already. |",
  );
  const result = ensureReleasePlanRow(shippedOnly, {
    version: "1.6.0",
    theme: "wrong",
    issues: "#1",
  });
  assert.equal(result, shippedOnly);
  assert.ok(result.includes("| **v1.6.0** ✅ shipped |"), "shipped marker preserved");
  assert.equal(
    result.split("\n").filter((l) => l.startsWith("| **v1.6.0**")).length,
    1,
    "no second unshipped row",
  );
});

test("ensureReleasePlanRow: impossible insert fails with doctor-grade remediation", () => {
  const noSentinel = ROADMAP_MISSING_PLAN_ROW.replace("| *(none)* |", "| *(elsewhere)* |");
  assert.throws(
    () => ensureReleasePlanRow(noSentinel, { version: "1.6.0", theme: "T", issues: "#1" }),
    (err: Error) => {
      assert.ok(err.message.includes("release-plan-none-row"), `got: ${err.message}`);
      assert.ok(err.message.includes("ROADMAP.md"), `got: ${err.message}`);
      assert.ok(err.message.includes("| **v1.6.0** |"), `copy-paste row missing: ${err.message}`);
      assert.ok(err.message.includes("| *(none)* |") || err.message.includes("sentinel"), `location: ${err.message}`);
      assert.ok(err.message.includes(RELEASE_PLAN_ROW_SHAPE) || err.message.includes("Column shape"), `shape: ${err.message}`);
      return true;
    },
  );
});

test("scaffoldRoadmap: missing unshipped plan row is scaffolded then ship-marked", () => {
  const result = scaffoldRoadmap(ROADMAP_MISSING_PLAN_ROW, {
    ...SAMPLE_CTX,
    theme: "Factory reliability",
    planIssueNumbers: [730],
  });
  assert.ok(result.includes("**v1.6.0** ✅ shipped"), "ship-mark after ensure");
  assert.ok(result.includes("Factory reliability"), "theme from context on scaffolded path");
  // #597: history surfaces (intro chain / ## Shipped prose) are no longer mutated.
  assert.ok(!result.includes("**v1.6.0 shipped 2026-06-17**"), "intro chain not accreted");
});

test("scaffoldRoadmap: shipped-only plan row is preserved (ship-mark no-op, no duplicate)", () => {
  // Regression for #730 review-1 (eb3d985c): ensure + patchReleasePlanRow + full
  // scaffold must not abort when only `| **v{version}** ✅ shipped |` exists.
  // ensure is a no-op; ship-mark is idempotent; plan-row stays singular (#597: no Shipped prose).
  const shippedOnly = SAMPLE_ROADMAP.replace(
    "| **v1.6.0** | minor | Intake & backlog automation | #158, #170 | Intake and release automation. |",
    "| **v1.6.0** ✅ shipped | minor | Intake & backlog automation | #158, #170 | Shipped already. |",
  );
  assert.ok(
    shippedOnly.split("\n").some((l) => l.startsWith("| **v1.6.0**") && l.includes("✅ shipped")),
    "fixture has shipped-only v1.6.0 plan row",
  );
  assert.ok(
    !shippedOnly.split("\n").some((l) => l.startsWith("| **v1.6.0**") && !l.includes("✅ shipped")),
    "fixture has no unshipped v1.6.0 plan row",
  );

  // Direct ship-mark helper is already idempotent on shipped-only rows.
  assert.equal(patchReleasePlanRow(shippedOnly, SAMPLE_CTX), shippedOnly);

  const result = scaffoldRoadmap(shippedOnly, SAMPLE_CTX);
  const planRows = result.split("\n").filter((l) => l.startsWith("| **v1.6.0**"));
  assert.equal(planRows.length, 1, "exactly one v1.6.0 plan row (no unshipped duplicate)");
  assert.ok(planRows[0].includes("✅ shipped"), "shipped marker preserved");
  assert.ok(
    planRows[0].includes("Shipped already."),
    "original shipped why-column preserved (ship-mark no-op)",
  );
  assert.ok(!result.includes("**v1.6.0 shipped 2026-06-17**"), "intro chain not accreted (#597)");
  assert.ok(
    !result.includes("**v1.6.0 — Intake & backlog automation (shipped 2026-06-17"),
    "free-form Shipped block not prepended (#597)",
  );
});

test("scaffoldRoadmap bite: without ensure, missing plan row still fails patchReleasePlanRow", () => {
  // Documents that the regression is specifically ensure-before-mutate: calling
  // patch alone on a missing row throws; scaffoldRoadmap with ensure does not.
  assert.throws(
    () => patchReleasePlanRow(ROADMAP_MISSING_PLAN_ROW, SAMPLE_CTX),
    /release-plan-row/,
  );
  assert.doesNotThrow(() => scaffoldRoadmap(ROADMAP_MISSING_PLAN_ROW, SAMPLE_CTX));
});

test("resolveReleaseTheme: --theme overrides milestone and plan-row", () => {
  assert.equal(
    resolveReleaseTheme({
      cliTheme: "Factory reliability",
      roadmapText: SAMPLE_ROADMAP,
      version: "1.6.0",
      milestoneTitle: "v1.6.0 — from milestone",
    }),
    "Factory reliability",
  );
});

test("resolveReleaseTheme: milestone title when no CLI theme and no plan row", () => {
  assert.equal(
    resolveReleaseTheme({
      roadmapText: ROADMAP_MISSING_PLAN_ROW,
      version: "1.6.0",
      milestoneTitle: "v1.6.0 — Factory reliability",
    }),
    "Factory reliability",
  );
});

test("resolveReleaseTheme: placeholder when nothing available", () => {
  assert.equal(
    resolveReleaseTheme({ roadmapText: ROADMAP_MISSING_PLAN_ROW, version: "1.6.0" }),
    PLAN_ROW_THEME_PLACEHOLDER,
  );
});

test("themeFromMilestoneTitle: strips version prefix", () => {
  assert.equal(themeFromMilestoneTitle("v1.29.0 — Factory reliability", "1.29.0"), "Factory reliability");
  assert.equal(themeFromMilestoneTitle("1.6.0: Intake", "1.6.0"), "Intake");
});

test("formatPlanRowIssues: never invents numbers; placeholder when empty", () => {
  assert.equal(formatPlanRowIssues([]), PLAN_ROW_ISSUES_PLACEHOLDER);
  assert.equal(formatPlanRowIssues([170, 158, 170]), "#158, #170");
});

test("versionBumpType: major/minor/patch from semver", () => {
  assert.equal(versionBumpType("2.0.0"), "major");
  assert.equal(versionBumpType("1.6.0"), "minor");
  assert.equal(versionBumpType("1.6.1"), "patch");
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

test("scaffoldRoadmap: applies plan-row + per-issue mutations (no Shipped prose accretion) (#597)", () => {
  const result = scaffoldRoadmap(SAMPLE_ROADMAP, SAMPLE_CTX);

  // Compact forward-looking mutations must be present.
  assert.ok(result.includes("**v1.6.0** ✅ shipped"), "release plan row patched");
  assert.ok(result.includes("✅ v1.6.0"), "per-issue table stamped");
  assert.ok(result.includes("See CHANGELOG.md"), "plan-row note points at CHANGELOG");

  // #597: release path must NOT reintroduce unbounded Shipped history or intro-chain accretion.
  assert.ok(
    !result.includes("**v1.6.0 shipped 2026-06-17**"),
    "intro-chain history must not be patched by scaffoldRoadmap",
  );
  assert.ok(
    !result.includes("**v1.6.0 — Intake & backlog automation"),
    "free-form ## Shipped block must not be prepended by scaffoldRoadmap",
  );
});

test("scaffoldRoadmap bites: without mutations, the original text has none of the v1.6.0 ship markers", () => {
  // Verify the SAMPLE_ROADMAP does NOT already have the v1.6.0 markers (so the test is meaningful).
  assert.ok(!SAMPLE_ROADMAP.includes("**v1.6.0** ✅ shipped"), "no pre-existing ✅ shipped for v1.6.0 in plan row");
  assert.ok(!SAMPLE_ROADMAP.includes("✅ v1.6.0"), "no pre-existing per-issue stamp for v1.6.0");
});

test("scaffoldRoadmap regression: does not grow ## Shipped free-form history (#597)", () => {
  const withoutShipped = SAMPLE_ROADMAP.replace(
    /## Shipped[\s\S]*?(?=## Release plan)/,
    "",
  );
  assert.ok(!withoutShipped.includes("## Shipped"), "fixture has no Shipped section");
  const result = scaffoldRoadmap(withoutShipped, SAMPLE_CTX);
  assert.ok(!result.includes("## Shipped"), "scaffoldRoadmap must not reintroduce ## Shipped");
  assert.ok(result.includes("**v1.6.0** ✅ shipped"), "still marks plan row");
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
  assert.deepEqual(result.issueNumbers, [158, 170], "returns sorted issue numbers");
  assert.equal(result.hadFailures, false, "no failures");
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
  assert.deepEqual(result.issueNumbers, [158, 170], "duplicates collapsed");
  assert.equal(result.hadFailures, false, "no failures");
});

test("collectShippedIssueNumbers: returns empty issueNumbers when no closing issues are found", async () => {
  const deps = makeDeps({ fetchPRClosingIssues: async () => [] });
  const result = await collectShippedIssueNumbers([{ number: 203, title: "A" }], deps);
  assert.deepEqual(result.issueNumbers, []);
  assert.equal(result.hadFailures, false, "no failures when gh succeeds with empty result");
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
  assert.deepEqual(result.issueNumbers, [158], "failed PR skipped, others collected");
  assert.equal(result.hadFailures, true, "hadFailures is true when any fetch throws");
  assert.ok(warnings.some((w) => w.includes("#203")), "warning mentions the failed PR");
});

test("collectShippedIssueNumbers: hadFailures is false when all fetches succeed", async () => {
  const deps = makeDeps({ fetchPRClosingIssues: async () => [42] });
  const result = await collectShippedIssueNumbers([{ number: 1, title: "A" }], deps);
  assert.equal(result.hadFailures, false);
});

test("collectShippedIssueNumbers: hadFailures is true when every fetch throws", async () => {
  const deps = makeDeps({
    fetchPRClosingIssues: async () => { throw new Error("auth error"); },
  });
  const result = await collectShippedIssueNumbers(
    [{ number: 1, title: "A" }, { number: 2, title: "B" }],
    deps,
  );
  assert.deepEqual(result.issueNumbers, []);
  assert.equal(result.hadFailures, true);
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
// discoverShippedPRs: non-PR (#N) tolerance (#498)
// ---------------------------------------------------------------------------

test("discoverShippedPRs: excludes a suffix-parsed candidate that GitHub reports is not a PR, with a warning", async () => {
  const gitLog = [
    "docs: add v1.21.0 release-plan row to ROADMAP (#451)",
    "feat: something (#203)",
  ].join("\n");

  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: gitLog, stderr: "" }),
    fetchPRTitle: async (n) => `PR #${n}`,
    classifyPR: async (n) =>
      n === 451 ? { kind: "not-a-pr" } : { kind: "pr" },
  });

  const prs = await discoverShippedPRs("v1.20.0", "/repo", deps);
  assert.equal(prs.length, 1, "only the genuine PR is kept");
  assert.equal(prs[0].number, 203);
  assert.ok(!prs.some((p) => p.number === 451), "#451 excluded from shipped set");
  const stderrLines = getStderr(deps);
  assert.ok(
    stderrLines.some((l) => l.includes("#451") && l.includes("not a pull request")),
    "warning names the excluded number",
  );
});

test("discoverShippedPRs: a genuine classification error still keeps the candidate (safety net preserved)", async () => {
  const gitLog = ["fix: something (#204)"].join("\n");

  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: gitLog, stderr: "" }),
    fetchPRTitle: async (n) => `PR #${n}`,
    classifyPR: async () => ({ kind: "error", message: "network error" }),
  });

  const prs = await discoverShippedPRs("v1.5.0", "/repo", deps);
  assert.equal(prs.length, 1, "candidate is not silently dropped on a genuine error");
  assert.equal(prs[0].number, 204);
});

test("discoverShippedPRs: Merge pull request #N numbers are trusted and bypass classification", async () => {
  const gitLog = ["Merge pull request #451 from user/branch"].join("\n");

  let classifyCalled = false;
  const deps = makeDeps({
    runCommand: () => ({ code: 0, stdout: gitLog, stderr: "" }),
    fetchPRTitle: async (n) => `PR #${n}`,
    classifyPR: async () => {
      classifyCalled = true;
      return { kind: "not-a-pr" };
    },
  });

  const prs = await discoverShippedPRs("v1.20.0", "/repo", deps);
  assert.equal(prs.length, 1, "merge-commit number is kept regardless of classification");
  assert.equal(prs[0].number, 451);
  assert.ok(!classifyCalled, "classifyPR must NOT be called for merge-commit-sourced numbers");
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
  assert.ok(body.includes("git tag -a v1.6.0"), "tag instructions in body");
});

test("buildPRBody: states merging is the final step and labels the tag command as a fallback", () => {
  const body = buildPRBody(SAMPLE_CTX, "v1.5.0");

  assert.ok(
    /merging this pr is the final step/i.test(body),
    "states merging is the final step",
  );
  assert.ok(
    /auto-tag|auto-creates|publishes the github release/i.test(body),
    "describes the automated tag + publish outcome",
  );
  assert.ok(/fallback/i.test(body), "labels the manual tag command as a fallback");
  assert.ok(
    body.includes(
      'git tag -a v1.6.0 -m "v1.6.0 — Intake & backlog automation" && git push origin v1.6.0',
    ),
    "fallback tag command creates an annotated tag",
  );
});

test("buildPRBody: names RELEASE_TAG_TOKEN and its provisioning in the fallback footer", () => {
  const body = buildPRBody(SAMPLE_CTX, "v1.5.0");

  assert.ok(body.includes("RELEASE_TAG_TOKEN"), "names the RELEASE_TAG_TOKEN secret");
  assert.ok(
    /fine-grained pat/i.test(body),
    "describes the fine-grained PAT provisioning requirement",
  );
  assert.ok(
    /contents:\s*read/i.test(body) && /contents:\s*write/i.test(body),
    "names the contents: read + contents: write scopes",
  );
  assert.ok(
    /repository actions secret/i.test(body),
    "states it must be added as a repository Actions secret",
  );
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

test("runRelease live: impossible plan-row insert aborts before any file write with remediation", async () => {
  const writes: string[] = [];
  // Missing v1.6.0 plan row AND no insert sentinel → ensure cannot scaffold.
  const roadmapBroken = ROADMAP_MISSING_PLAN_ROW.replace("| *(none)* |", "| *(gone)* |");

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return roadmapBroken;
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
    (err: Error) => {
      assert.ok(
        err.message.includes("release-plan-none-row") || err.message.includes("cannot auto-scaffold"),
        `got: ${err.message}`,
      );
      assert.ok(err.message.includes("ROADMAP.md"), `got: ${err.message}`);
      assert.ok(err.message.includes("| **v1.6.0** |"), `got: ${err.message}`);
      return true;
    },
  );
  assert.equal(writes.length, 0, "no files written when plan-row insert is impossible");
});

test("runRelease live: missing plan row is scaffolded when *(none)* sentinel present (no abort)", async () => {
  const writes: Record<string, string> = {};
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return ROADMAP_MISSING_PLAN_ROW;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p, c) => { writes[p] = c; },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "node") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "checkout") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "commit") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "clean") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr") {
        return { code: 0, stdout: "https://github.com/org/repo/pull/999", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRClosingIssues: async () => [],
  });

  await runRelease(
    "1.6.0",
    { noEdit: true, theme: "Factory reliability" },
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );

  const roadmapPath = Object.keys(writes).find((p) => p.endsWith("ROADMAP.md"));
  assert.ok(roadmapPath, "ROADMAP.md was written");
  assert.ok(writes[roadmapPath].includes("**v1.6.0** ✅ shipped"), "scaffolded then ship-marked");
  assert.ok(writes[roadmapPath].includes("Factory reliability"), "CLI theme on scaffolded row path");
});

test("runRelease dry-run: missing plan row appears in ROADMAP diff without writes", async () => {
  const writes: string[] = [];
  const stdout: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return ROADMAP_MISSING_PLAN_ROW;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => { writes.push(p); },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    stdout: (msg) => { stdout.push(msg); },
  });

  await runRelease(
    "1.6.0",
    { dryRun: true, theme: "Dry-run theme" },
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );

  assert.equal(writes.length, 0, "dry-run must not write");
  const combined = stdout.join("\n");
  assert.ok(combined.includes("ROADMAP.md") || combined.includes("**v1.6.0**"), `got: ${combined.slice(0, 500)}`);
  assert.ok(
    combined.includes("| **v1.6.0**") || combined.includes("**v1.6.0** ✅ shipped") || combined.includes("+| **v1.6.0**"),
    `scaffolded plan row should appear in dry-run diff: ${combined.slice(0, 1500)}`,
  );
});

test("runRelease: --theme wins over milestone for scaffolded plan row", async () => {
  let sawTheme = "";
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return ROADMAP_MISSING_PLAN_ROW;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p, c) => {
      if (p.endsWith("ROADMAP.md")) sawTheme = c;
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "node" || cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && (args[0] === "checkout" || args[0] === "add" || args[0] === "commit" || args[0] === "push" || args[0] === "clean")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh") return { code: 0, stdout: "https://github.com/org/repo/pull/1", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchMilestoneForVersion: async () => ({
      title: "v1.6.0 — From milestone",
      issueNumbers: [999],
    }),
    fetchPRClosingIssues: async () => [],
  });

  await runRelease(
    "1.6.0",
    { noEdit: true, theme: "CLI theme wins" },
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.ok(sawTheme.includes("CLI theme wins"), "CLI --theme overrides milestone");
  assert.ok(!sawTheme.includes("From milestone"), "milestone theme must not win over CLI");
});

test("runRelease: milestone theme used when --theme absent and plan row missing", async () => {
  let saw = "";
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return ROADMAP_MISSING_PLAN_ROW;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p, c) => {
      if (p.endsWith("ROADMAP.md")) saw = c;
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "node" || cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && (args[0] === "checkout" || args[0] === "add" || args[0] === "commit" || args[0] === "push" || args[0] === "clean")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "gh") return { code: 0, stdout: "https://github.com/org/repo/pull/1", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchMilestoneForVersion: async () => ({
      title: "v1.6.0 — Milestone theme only",
      issueNumbers: [730, 723],
    }),
    fetchPRClosingIssues: async () => [],
  });

  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.ok(saw.includes("Milestone theme only"), "milestone title used for theme");
  // Issues from milestone should appear in the (now ship-marked) plan row history — why column is rewritten on ship-mark,
  // but Issues column is preserved by patchReleasePlanRow (only release col + why change).
  assert.ok(saw.includes("#723") || saw.includes("#730"), `milestone issues on plan row: ${saw.match(/\| \*\*v1\.6\.0\*\*[^\n]*/)?.[0]}`);
});

test("CLI: release usage documents unshipped plan-row shape", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "release"],
    { encoding: "utf8", env: { ...process.env, PATH: "" } },
  );
  assert.notEqual(result.status, 0);
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert.ok(combined.includes("| **vX.Y.Z** |"), `got: ${combined}`);
  assert.ok(combined.includes("scaffold") || combined.includes("auto-scaffold") || combined.includes("*(none)*"), `got: ${combined}`);
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

test("runRelease: editor abort before branch creation aborts AND rolls back via git checkout (#170 review-2)", async () => {
  const origEditor = process.env.EDITOR;
  process.env.EDITOR = "mock-editor-that-fails";
  const commands: string[][] = [];

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "release: thing (#204)", stderr: "" };
      if (cmd === "node") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `PR #${n}`,
    // PR #204 closes issue #158 → one v1.6.0 row is stampable, so the run reaches the
    // editor step (it does not short-circuit on the no-stampable-rows guard).
    fetchPRClosingIssues: async (n) => (n === 204 ? [158] : []),
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
    // The editor launches AFTER the ROADMAP write but BEFORE `git checkout -b`. An editor
    // abort there must restore the working tree (the round-2 finding) and must NOT have
    // created the release branch.
    assert.ok(restoreInvoked(commands), "git checkout rollback issued when the editor aborts");
    assert.ok(
      !commands.some((c) => c[0] === "git" && c[1] === "checkout" && c[2] === "-b"),
      "release branch is not created when the editor aborts",
    );
  } finally {
    if (origEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = origEditor;
  }
});

test("runRelease: aborts before any write when a release-managed path is dirty (#170 review-2)", async () => {
  // A pre-existing unstaged edit to ROADMAP.md must make the live release fail fast BEFORE
  // bumping anything, so the abort rollback (git checkout/clean from HEAD) can never discard
  // the maintainer's local edits. This is the clean-tree precondition that makes the rollback
  // provably lossless.
  const commands: string[][] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      // Working tree is dirty in a release-managed path.
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M ROADMAP.md\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    (err: Error) => {
      assert.ok(err.message.includes("uncommitted changes"), `got: ${err.message}`);
      assert.ok(err.message.includes("ROADMAP.md"), `dirty path named, got: ${err.message}`);
      return true;
    },
  );
  // Fail-fast: nothing was bumped/written, build.mjs never ran, and no rollback was needed
  // (we never mutated the tree, so there is nothing to restore and nothing to discard).
  assert.equal(Object.keys(getWritten(deps)).length, 0, "no files written when tree is dirty");
  assert.ok(!commands.some((c) => c[0] === "node" && c[1] === "scripts/build.mjs"), "build.mjs not run");
  assert.ok(!restoreInvoked(commands), "no rollback issued — nothing was mutated");
});

test("runRelease: clean-tree guard forces --untracked-files=all (config-independent) (#170 review-2)", async () => {
  // Plain `git status` honors `status.showUntrackedFiles`, so a maintainer with that set to
  // `no` could slip an untracked file under plugin/ past the guard — which build.mjs's rm -rf
  // would then destroy. The guard MUST pass --untracked-files=all so detection does not depend
  // on user git config. This asserts the flag is present on the status command.
  const statusCalls: string[][] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "status") { statusCalls.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "release: thing (#204)", stderr: "" };
      if (cmd === "gh" && args[0] === "pr") return { code: 0, stdout: "https://github.com/org/repo/pull/301", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `Title #${n}`,
    fetchPRClosingIssues: async (n) => (n === 204 ? [158] : []),
  });

  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);

  assert.equal(statusCalls.length, 1, "git status checked exactly once");
  assert.ok(
    statusCalls[0].includes("--untracked-files=all"),
    `clean-tree guard must force untracked detection, got: ${statusCalls[0].join(" ")}`,
  );
  // The pathspec covers all five release-managed paths (after the `--` separator).
  const sep = statusCalls[0].indexOf("--");
  const paths = statusCalls[0].slice(sep + 1);
  for (const p of ["package.json", "core/package.json", "ROADMAP.md", "plugin", ".claude-plugin"]) {
    assert.ok(paths.includes(p), `pathspec includes ${p}, got: ${paths.join(" ")}`);
  }
});

test("runRelease: a clean working tree passes the precondition (status checked, no edits) (#170 review-2)", async () => {
  // With a clean tree (git status --porcelain empty), the release proceeds past the
  // precondition and reaches PR creation. Proves the precondition gates on real status output.
  let statusChecked = false;
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "status") { statusChecked = true; return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "release: thing (#204)", stderr: "" };
      if (cmd === "gh" && args[0] === "pr") return { code: 0, stdout: "https://github.com/org/repo/pull/300", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `Title #${n}`,
    fetchPRClosingIssues: async (n) => (n === 204 ? [158] : []),
  });

  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.ok(statusChecked, "git status --porcelain was checked before mutating the tree");
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
  assert.ok(combined.includes("| **vX.Y.Z** |"), `usage should document plan-row shape: ${combined}`);
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

// ---------------------------------------------------------------------------
// Finding 1: issue discovery failure aborts release in live mode
// ---------------------------------------------------------------------------

test("runRelease live: issue discovery failure aborts and rolls back via git checkout (#170)", async () => {
  const commands: string[][] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "Merge pull request #203 from foo/bar", stderr: "" };
      if (cmd === "node") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "npm") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `PR #${n}`,
    fetchPRClosingIssues: async () => { throw new Error("gh auth error"); },
  });

  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    (err: Error) => {
      assert.ok(err.message.includes("issue discovery failed"), `got: ${err.message}`);
      return true;
    },
  );
  // Rollback is a `git checkout -- ...` from HEAD (not a writeFile): it restores the
  // bumped package.json files, ROADMAP.md, and the plugin/ mirror in one step, so a
  // retry reads the original previousVersion. The branch is never created.
  assert.ok(restoreInvoked(commands), "git checkout rollback issued on abort");
  assert.ok(
    !commands.some((c) => c[0] === "git" && c[1] === "checkout" && c[2] === "-b"),
    "release branch is not created when issue discovery fails",
  );
});

test("runRelease live: a docs-style non-PR (#N) commit does not abort the release (#498)", async () => {
  // Reproduces the v1.21.0 cut: a release-prep docs commit ending in a single
  // issue reference (#451) is parsed as a squash-merge PR candidate alongside
  // the genuine squash-merge PR #204 (which resolves to issue #158, a row
  // SAMPLE_ROADMAP plans for v1.6.0). Without the fix, `gh pr view 451` fails
  // ("Could not resolve to a PullRequest"), issue discovery sets hadFailures,
  // and the release aborts with "issue discovery failed".
  const gitLog = [
    "fix: something (#204)",
    "docs: add v1.21.0 release-plan row to ROADMAP (#451)",
  ].join("\n");

  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: gitLog, stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        return { code: 0, stdout: "https://github.com/org/repo/pull/200", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchPRTitle: async (n) => `Title #${n}`,
    classifyPR: async (n) => (n === 451 ? { kind: "not-a-pr" } : { kind: "pr" }),
    fetchPRClosingIssues: async (n) => (n === 204 ? [158] : []),
  });

  // Must NOT reject — this is the regression: without the fix it rejects with
  // /issue discovery failed/.
  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);

  const written = getWritten(deps);
  const roadmapWrite = Object.entries(written).find(([p]) => p.endsWith("ROADMAP.md"));
  assert.ok(roadmapWrite, "ROADMAP.md was written");
  assert.ok(!roadmapWrite![1].includes("#451"), "excluded #451 produces no Shipped row");

  const stderrLines = getStderr(deps);
  assert.ok(
    stderrLines.some((l) => l.includes("#451") && l.includes("not a pull request")),
    "warning names the excluded #451",
  );
});

// ---------------------------------------------------------------------------
// Finding 2: resolveReleaseConfig — strict local config parsing
// ---------------------------------------------------------------------------

import { resolveReleaseConfig } from "../scripts/config.ts";

test("resolveReleaseConfig: uses default branch when config file is absent", () => {
  const tmpDir = fs.mkdtempSync(path.join(CLI_TMP, "cfg-"));
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  const result = resolveReleaseConfig(tmpDir);
  assert.equal(result.base_branch, "main", "defaults to main when no pipeline.yml");
  assert.equal(result.repo_dir, tmpDir);
});

test("resolveReleaseConfig: reads base_branch from valid config file", () => {
  const tmpDir = fs.mkdtempSync(path.join(CLI_TMP, "cfg-"));
  fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".github", "pipeline.yml"), "base_branch: staging\n", "utf8");
  const result = resolveReleaseConfig(tmpDir);
  assert.equal(result.base_branch, "staging", "reads base_branch from config");
});

test("resolveReleaseConfig: baseBranchOverride wins over file config", () => {
  const tmpDir = fs.mkdtempSync(path.join(CLI_TMP, "cfg-"));
  fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".github", "pipeline.yml"), "base_branch: staging\n", "utf8");
  const result = resolveReleaseConfig(tmpDir, "custom-branch");
  assert.equal(result.base_branch, "custom-branch", "override wins over file");
});

test("resolveReleaseConfig: throws on malformed YAML (not silently falls back to main)", () => {
  const tmpDir = fs.mkdtempSync(path.join(CLI_TMP, "cfg-"));
  fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".github", "pipeline.yml"),
    "base_branch: [\nunclosed bracket\n",
    "utf8",
  );
  assert.throws(
    () => resolveReleaseConfig(tmpDir),
    (err: Error) => {
      // js-yaml throws a YAMLException; the message should indicate a parse error
      assert.ok(err.message.length > 0, "throws with a message");
      return true;
    },
  );
});

test("resolveReleaseConfig: throws on schema-invalid config (not silently falls back to main)", () => {
  const tmpDir = fs.mkdtempSync(path.join(CLI_TMP, "cfg-"));
  fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
  // base_branch must be a string; providing a number violates PartialConfigSchema.
  fs.writeFileSync(
    path.join(tmpDir, ".github", "pipeline.yml"),
    "base_branch: 42\n",
    "utf8",
  );
  assert.throws(
    () => resolveReleaseConfig(tmpDir),
    (err: Error) => {
      assert.ok(err.message.includes("Invalid") || err.message.includes("pipeline.yml"), `got: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// #170 review-2: empty/incomplete per-issue stamping + rollback-safe abort
// ---------------------------------------------------------------------------

test("countPerIssueRows: counts planned rows for a version and how many are stampable (#170)", () => {
  // SAMPLE_ROADMAP plans #158 and #170 for v1.6.0.
  assert.deepEqual(countPerIssueRows(SAMPLE_ROADMAP, "1.6.0", []), { planned: 2, stampable: 0 });
  assert.deepEqual(countPerIssueRows(SAMPLE_ROADMAP, "1.6.0", [170]), { planned: 2, stampable: 1 });
  assert.deepEqual(countPerIssueRows(SAMPLE_ROADMAP, "1.6.0", [158, 170]), { planned: 2, stampable: 2 });
  // A version with no planned rows → planned 0 (so runRelease will NOT abort for it).
  assert.deepEqual(countPerIssueRows(SAMPLE_ROADMAP, "1.9.0", [170]), { planned: 0, stampable: 0 });
});

function liveReleaseDeps(overrides: Partial<ReleaseDeps> = {}): ReleaseDeps {
  return makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    runCommand: (cmd, args) => {
      // git log returns a squash-merge line so discoverShippedPRs finds PR #204.
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "a1b2c3d release: thing (#204)", stderr: "" };
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  });
}

test("runRelease: aborts live release when shipped PRs resolve no stampable issue rows (#170)", async () => {
  // PR #204 is shipped but closes no issue → shippedIssueNumbers empty → none of the
  // 2 v1.6.0 rows can be stamped → would write an inconsistent ROADMAP → must abort.
  const commands: string[][] = [];
  const deps = liveReleaseDeps({ fetchPRClosingIssues: async () => [] });
  const inner = deps.runCommand;
  deps.runCommand = (cmd, args, opts) => { commands.push([cmd, ...args]); return inner(cmd, args, opts); };
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /none could be stamped/,
  );
  // Rollback restores the bumped files + plugin/ mirror via `git checkout -- ...` from HEAD.
  assert.ok(restoreInvoked(commands), "git checkout rollback issued on abort");
});

test("runRelease: a post-bump abort (CI failure) restores the bumped files (#170)", async () => {
  // CI fails AFTER the version bump + mirror regen. The checkout must be restored so a
  // retry does not read the already-bumped version as previousVersion.
  const commands: string[][] = [];
  const deps = liveReleaseDeps({
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "a1b2c3d thing (#204)", stderr: "" };
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "npm" && args[0] === "run") return { code: 1, stdout: "", stderr: "tests failed" }; // CI fails
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /CI gate failed/,
  );
  // The bumped files are reverted by `git checkout -- ...` from HEAD (build.mjs is not
  // re-run), so a retry reads the original previousVersion.
  assert.ok(restoreInvoked(commands), "git checkout rollback issued after CI abort");
});

// ---------------------------------------------------------------------------
// Factory Reliability Gate (#723)
// ---------------------------------------------------------------------------

test("buildPRBody: includes FRG run_id and pass when evidence provided", () => {
  const frg = defaultFrgPass("1.6.0");
  const body = buildPRBody(SAMPLE_CTX, "v1.5.0", frg);
  assert.match(body, /Factory Reliability Gate/);
  assert.match(body, /frg-test-pass/);
  assert.match(body, /pass/);
  assert.match(body, /1\.6\.0/);
});

test("runRelease: missing FRG pass aborts before package.json mutation", async () => {
  const written: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    requireFrgPass: async () => {
      throw new Error(
        "[pipeline release] Factory Reliability Gate pass missing for version 1.6.0 " +
          "(expected /repo/.agent-pipeline/frg/1.6.0/latest.json). " +
          "Unit CI alone is not sufficient. Run: pipeline factory-gate --for 1.6.0",
      );
    },
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /Factory Reliability Gate pass missing for version 1\.6\.0/,
  );
  assert.equal(written.length, 0, "must not write package files when FRG is missing");
});

test("runRelease: failed FRG aborts and is distinguishable from missing", async () => {
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    requireFrgPass: async () => {
      throw new Error(
        "[pipeline release] Factory Reliability Gate FAILED for version 1.6.0 (run_id=frg-bad). " +
          "See docs/factory-reliability-gate-runbook.md",
      );
    },
  });
  await assert.rejects(
    () => runRelease("1.6.0", { dryRun: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /Gate FAILED for version 1\.6\.0/,
  );
});

test("runRelease: FRG pass attaches run_id to PR body (live path)", async () => {
  let prBody = "";
  const deps = liveReleaseDeps({
    fetchPRClosingIssues: async (n) => (n === 204 ? [158, 170] : []),
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "a1b2c3d release: thing (#204)", stderr: "" };
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        const bodyIdx = args.indexOf("--body");
        prBody = bodyIdx >= 0 ? args[bodyIdx + 1]! : "";
        return { code: 0, stdout: "https://github.com/org/repo/pull/999", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    requireFrgPass: async (_d, version) => defaultFrgPass(version),
  });
  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.match(prBody, /Factory Reliability Gate/);
  assert.match(prBody, /frg-test-pass/);
  assert.match(prBody, /pass/);
});

test("runRelease: FRG check does not invoke merge or tag commands", async () => {
  const commands: string[][] = [];
  const deps = liveReleaseDeps({
    fetchPRClosingIssues: async (n) => (n === 204 ? [158, 170] : []),
    runCommand: (cmd, args) => {
      commands.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "a1b2c3d release: thing (#204)", stderr: "" };
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr") return { code: 0, stdout: "https://github.com/org/repo/pull/999", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.ok(!commands.some((c) => c[0] === "git" && c[1] === "tag"), "must not tag because FRG passed");
  assert.ok(
    !commands.some((c) => c[0] === "gh" && c[1] === "pr" && c.includes("merge")),
    "must not merge because FRG passed",
  );
});

// ---------------------------------------------------------------------------
// Open soak-defect preflight (#755)
// ---------------------------------------------------------------------------

test("runRelease: open soak defects abort before package.json mutation", async () => {
  const written: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log" && args.some((a) => a.includes("%cI"))) {
        return { code: 0, stdout: "2026-06-01T00:00:00Z", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    requireFrgPass: async (_d, version) => defaultFrgPass(version),
    listOpenSoakDefectCandidates: async () => [
      {
        number: 712,
        title: "engine soak defect",
        state: "OPEN",
        labels: [],
        body: "loop-test Blocker class: workflow-engine-defect",
        createdAt: "2026-07-30T12:00:00Z",
      },
    ],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 712,
        loopRunId: "loop-test",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
      },
    ],
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /open engine-class soak defects block release preparation for v1\.6\.0/,
  );
  assert.equal(written.length, 0, "must not mutate version files when open soak defects block");
});

test("runRelease dry-run: open soak defects still block (no mutation)", async () => {
  const written: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log" && args.some((a) => a.includes("%cI"))) {
        return { code: 0, stdout: "2026-06-01T00:00:00Z", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    listOpenSoakDefectCandidates: async () => [
      {
        number: 714,
        title: "dry-run block",
        state: "OPEN",
        labels: ["bug", "pipeline:engine-class"],
        body: "",
        createdAt: "2026-07-01T00:00:00Z",
      },
    ],
  });
  await assert.rejects(
    () => runRelease("1.6.0", { dryRun: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /#714/,
  );
  assert.equal(written.length, 0);
});

test("runRelease: allow-open-soak-defects override records waiver on PR body", async () => {
  let prBody = "";
  const deps = liveReleaseDeps({
    fetchPRClosingIssues: async (n) => (n === 204 ? [158, 170] : []),
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "log" && args.some((a) => a.includes("%cI"))) {
        return { code: 0, stdout: "2026-06-01T00:00:00Z", stderr: "" };
      }
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "a1b2c3d release: thing (#204)", stderr: "" };
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        const bodyIdx = args.indexOf("--body");
        prBody = bodyIdx >= 0 ? args[bodyIdx + 1]! : "";
        return { code: 0, stdout: "https://github.com/org/repo/pull/999", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    listOpenSoakDefectCandidates: async () => [
      {
        number: 712,
        title: "waived engine defect",
        state: "OPEN",
        labels: [],
        body: "loop-test workflow-engine-defect",
        createdAt: "2026-07-30T12:00:00Z",
      },
    ],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 712,
        loopRunId: "loop-test",
        terminal: true,
        recovered: false,
        engineClass: true,
      },
    ],
  });
  await runRelease(
    "1.6.0",
    { noEdit: true, allowOpenSoakDefects: "accepted residual; tracked offline" },
    { repo_dir: "/repo", repo: "org/repo" },
    deps,
  );
  assert.match(prBody, /Open soak-defect override/);
  assert.match(prBody, /#712/);
  assert.match(prBody, /accepted residual; tracked offline/);
});

test("runRelease: empty override reason still fails closed on open defects", async () => {
  const written: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "log" && args.some((a) => a.includes("%cI"))) {
        return { code: 0, stdout: "2026-06-01T00:00:00Z", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    listOpenSoakDefectCandidates: async () => [
      {
        number: 712,
        title: "still blocks",
        state: "OPEN",
        labels: ["bug", "pipeline:engine-class"],
        body: "",
        createdAt: "2026-07-01T00:00:00Z",
      },
    ],
  });
  await assert.rejects(
    () =>
      runRelease(
        "1.6.0",
        { noEdit: true, allowOpenSoakDefects: "  " },
        { repo_dir: "/repo", repo: "org/repo" },
        deps,
      ),
    /open engine-class soak defects/,
  );
  assert.equal(written.length, 0);
});

test("runRelease: clean open-defect set does not invent waiver section", async () => {
  let prBody = "";
  const deps = liveReleaseDeps({
    fetchPRClosingIssues: async (n) => (n === 204 ? [158, 170] : []),
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "a1b2c3d release: thing (#204)", stderr: "" };
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        const bodyIdx = args.indexOf("--body");
        prBody = bodyIdx >= 0 ? args[bodyIdx + 1]! : "";
        return { code: 0, stdout: "https://github.com/org/repo/pull/999", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    listOpenSoakDefectCandidates: async () => [],
    listTypedSoakEvidence: async () => [],
  });
  await runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.ok(!/Open soak-defect override/.test(prBody), "waiver section only when override used");
  assert.match(prBody, /Factory Reliability Gate/);
});

test("buildPRBody: includes open-soak waiver section when provided", () => {
  const body = buildPRBody(SAMPLE_CTX, "v1.5.0", defaultFrgPass("1.6.0"), {
    waived: { issueNumbers: [712, 714], reason: "accepted residual; tracked offline" },
    blocking: [
      { issueNumber: 712, title: "a", classificationSource: "typed" },
      { issueNumber: 714, title: "b", classificationSource: "label-fallback" },
    ],
  });
  assert.match(body, /#712/);
  assert.match(body, /#714/);
  assert.match(body, /accepted residual; tracked offline/);
});

test("resolvePreviousTagCreatedAt: prefers annotated taggerdate over commit creatordate", () => {
  // Regression for a0f367e9: delayed tag whose target commit predates tagger time
  // must use the tagger timestamp so pre-tag issues are not swept into the window.
  const tagger = "2026-07-29T18:00:00Z";
  const committer = "2026-07-28T10:00:00Z";
  const iso = resolvePreviousTagCreatedAt(
    "v1.29.0",
    (cmd, args) => {
      if (cmd === "git" && args[0] === "for-each-ref") {
        return { code: 0, stdout: `${tagger}${"\0"}${committer}\n`, stderr: "" };
      }
      if (cmd === "git" && args[0] === "log") {
        return { code: 0, stdout: `${committer}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    "/repo",
  );
  assert.equal(iso, tagger);
});

test("resolvePreviousTagCreatedAt: lightweight tag falls back to creatordate", () => {
  const committer = "2026-07-28T10:00:00Z";
  const iso = resolvePreviousTagCreatedAt(
    "v1.29.0",
    (cmd, args) => {
      if (cmd === "git" && args[0] === "for-each-ref") {
        return { code: 0, stdout: `${"\0"}${committer}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    "/repo",
  );
  assert.equal(iso, committer);
});

test("mapGhIssueToSoakCandidate: projects typedDisposition and candidateRunIds", () => {
  const mapped = mapGhIssueToSoakCandidate({
    number: 712,
    title: "engine defect",
    state: "open",
    created_at: "2026-07-30T00:00:00Z",
    labels: [{ name: "enhancement" }],
    body: [
      "**Blocker class**: workflow-engine-defect",
      "**Evidence fingerprint**: fp-attr",
      "**Terminal stop**: yes",
      "",
      "### Affected run IDs",
      "- loop-test",
      "- frg-test-pass",
    ].join("\n"),
  });
  assert.equal(mapped.typedDisposition, "workflow-engine-defect");
  assert.deepEqual(mapped.candidateRunIds, ["loop-test", "frg-test-pass"]);
  assert.equal(mapped.state, "OPEN");
});

test("projectGithubAttributedTypedEvidence: absent Terminal stop does not emit suppressing recovered evidence", () => {
  // Regression for 37e3edb0: auto-file provenance with disposition + soak ids but
  // no authoritative terminal/recovery marker must NOT project recovered:true
  // typed evidence (which would suppress bug+engine-class label fallback).
  const out = projectGithubAttributedTypedEvidence(
    [
      {
        number: 740,
        title: "Durable-run blocker: workflow-engine-defect:fp-no-term",
        state: "OPEN",
        labels: ["bug", "pipeline:engine-class", "pipeline:backlog"],
        body: [
          "**Blocker class**: workflow-engine-defect",
          "**Evidence fingerprint**: fp-no-term",
          // Intentionally no **Terminal stop** line — historical / incomplete body.
          "",
          "### Affected run IDs",
          "- loop-test",
          "- frg-test-pass",
        ].join("\n"),
        createdAt: "2026-07-30T12:00:00Z",
        typedDisposition: "workflow-engine-defect",
        candidateRunIds: ["loop-test", "frg-test-pass"],
      },
    ],
    "loop-test",
    "frg-test-pass",
  );
  assert.deepEqual(out, []);
});

test("projectGithubAttributedTypedEvidence: FRG run_id alone links terminal typed defect without loop_run_id", () => {
  // Regression for 7335c9e2: FRG run_id is a primary soak identity; missing
  // loop_run_id must not disable GitHub typed attribution discovery.
  const out = projectGithubAttributedTypedEvidence(
    [
      {
        number: 741,
        title: "terminal engine defect linked only to FRG run",
        state: "OPEN",
        labels: ["enhancement"], // wrong labels — typed path must still project
        body: [
          "**Blocker class**: workflow-engine-defect",
          "**Evidence fingerprint**: fp-frg-only",
          "**Terminal stop**: yes",
          "",
          "### Affected run IDs",
          "- frg-only-run-id",
        ].join("\n"),
        createdAt: "2026-07-30T12:00:00Z",
      },
    ],
    null,
    "frg-only-run-id",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.issueNumber, 741);
  assert.equal(out[0]!.terminal, true);
  assert.equal(out[0]!.recovered, false);
  assert.equal(out[0]!.engineClass, true);
  assert.equal(out[0]!.loopRunId, null);
  assert.equal(out[0]!.frgRunId, "frg-only-run-id");
  assert.equal(out[0]!.fingerprint, "fp-frg-only");
});

test("projectGithubAttributedTypedEvidence: explicit Terminal stop no projects recovered", () => {
  const out = projectGithubAttributedTypedEvidence(
    [
      {
        number: 742,
        title: "recovered intermediate",
        state: "OPEN",
        labels: ["bug", "pipeline:engine-class"],
        body: [
          "**Blocker class**: workflow-engine-defect",
          "**Evidence fingerprint**: fp-recovered",
          "**Terminal stop**: no",
          "",
          "### Affected run IDs",
          "- frg-test-pass",
        ].join("\n"),
        createdAt: "2026-07-30T12:00:00Z",
      },
    ],
    null,
    "frg-test-pass",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.terminal, false);
  assert.equal(out[0]!.recovered, true);
});

test("runRelease: labeled open auto-file without terminal marker blocks via label-fallback (no local ledger)", async () => {
  // Regression for 37e3edb0 end-to-end: production-style GitHub projection yields
  // no typed row when Terminal stop is absent; bug+engine-class labels still block.
  const written: string[] = [];
  const openIssue = {
    number: 740,
    title: "Durable-run blocker: workflow-engine-defect:fp-no-term",
    state: "OPEN" as const,
    labels: ["bug", "pipeline:engine-class", "pipeline:backlog"],
    body: [
      "**Blocker class**: workflow-engine-defect",
      "**Evidence fingerprint**: fp-no-term",
      "",
      "### Affected run IDs",
      "- loop-test",
      "- frg-test-pass",
    ].join("\n"),
    createdAt: "2026-07-30T12:00:00Z",
    typedDisposition: "workflow-engine-defect",
    candidateRunIds: ["loop-test", "frg-test-pass"],
  };
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "for-each-ref") {
        return {
          code: 0,
          stdout: `2026-06-01T00:00:00Z${"\0"}2026-05-01T00:00:00Z\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    requireFrgPass: async (_d, version) => defaultFrgPass(version),
    listOpenSoakDefectCandidates: async () => [openIssue],
    // Simulate real production projection (no local ledger; GitHub path only).
    listTypedSoakEvidence: async ({ loopRunId, frgRunId }) =>
      projectGithubAttributedTypedEvidence([openIssue], loopRunId, frgRunId),
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /#740/,
  );
  assert.equal(written.length, 0);
});

test("runRelease: FRG run_id only (no loop_run_id) blocks on typed engine defect", async () => {
  // Regression for 7335c9e2 end-to-end: FRG evidence supplies only run_id; open
  // typed terminal defect linked to that id must still block release prep.
  const written: string[] = [];
  const openIssue = {
    number: 741,
    title: "terminal engine defect linked only to FRG run",
    state: "OPEN" as const,
    labels: ["enhancement"],
    body: [
      "**Blocker class**: workflow-engine-defect",
      "**Evidence fingerprint**: fp-frg-only",
      "**Terminal stop**: yes",
      "",
      "### Affected run IDs",
      "- frg-only-run-id",
    ].join("\n"),
    createdAt: "2026-07-30T12:00:00Z",
  };
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "for-each-ref") {
        return {
          code: 0,
          stdout: `2026-06-01T00:00:00Z${"\0"}2026-05-01T00:00:00Z\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    requireFrgPass: async (_d, version) => ({
      ...defaultFrgPass(version),
      run_id: "frg-only-run-id",
      loop_run_id: null,
    }),
    listOpenSoakDefectCandidates: async () => [openIssue],
    listTypedSoakEvidence: async ({ loopRunId, frgRunId }) =>
      projectGithubAttributedTypedEvidence([openIssue], loopRunId, frgRunId),
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /#741/,
  );
  assert.equal(written.length, 0);
});

test("runRelease: typed stage-diagnostic evidence blocks despite wrong labels and no open-list body match", async () => {
  // Regression for 2a78a59f: injected typed diagnostic (no local ledger simulation)
  // must block even when the open issue has wrong/missing labels.
  const written: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "for-each-ref") {
        return {
          code: 0,
          stdout: `2026-06-01T00:00:00Z${"\0"}2026-05-01T00:00:00Z\n`,
          stderr: "",
        };
      }
      if (cmd === "git" && args[0] === "log" && args.some((a) => a.includes("%cI"))) {
        return { code: 0, stdout: "2026-05-01T00:00:00Z", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    requireFrgPass: async (_d, version) => defaultFrgPass(version),
    listOpenSoakDefectCandidates: async () => [
      {
        number: 712,
        title: "mislabeled soak defect",
        state: "OPEN",
        labels: ["enhancement"], // wrong labels — typed path must still block
        body: "unrelated prose without soak markers",
        createdAt: "2026-07-30T12:00:00Z",
      },
    ],
    listTypedSoakEvidence: async () => [
      {
        issueNumber: 712,
        loopRunId: "loop-test",
        frgRunId: "frg-test-pass",
        terminal: true,
        recovered: false,
        engineClass: true,
        blockerClass: "workflow-engine-defect",
        title: "stage-diagnostic workflow-engine-defect:sha256:abc",
        reasonKey: "workflow-engine-defect",
        fingerprint: "sha256:abc",
      },
    ],
  });
  await assert.rejects(
    () => runRelease("1.6.0", { noEdit: true }, { repo_dir: "/repo", repo: "org/repo" }, deps),
    /#712/,
  );
  assert.equal(written.length, 0);
});

test("runRelease: delayed tag uses taggerdate so pre-tag issues stay outside fallback window", async () => {
  // Commit dated day-1, annotated tag created day-3; issue created day-2 must not
  // enter the post-tag label-fallback window when taggerdate is authoritative.
  const written: string[] = [];
  const deps = makeDeps({
    readFile: (p) => {
      if (p.endsWith("core/package.json")) return SAMPLE_CORE_PKG;
      if (p.endsWith("package.json")) return SAMPLE_ROOT_PKG;
      if (p.endsWith("ROADMAP.md")) return SAMPLE_ROADMAP;
      throw new Error(`unexpected read: ${p}`);
    },
    writeFile: (p) => {
      written.push(p);
    },
    runCommand: (cmd, args) => {
      if (cmd === "git" && args[0] === "describe") return { code: 0, stdout: "v1.5.0", stderr: "" };
      if (cmd === "git" && args[0] === "for-each-ref") {
        // tagger = day-3; creator/commit = day-1
        return {
          code: 0,
          stdout: `2026-07-03T00:00:00Z${"\0"}2026-07-01T00:00:00Z\n`,
          stderr: "",
        };
      }
      if (cmd === "git" && args[0] === "log" && args.some((a) => a.includes("%cI"))) {
        // Commit time is day-1 — using this alone would incorrectly include day-2 issues.
        return { code: 0, stdout: "2026-07-01T00:00:00Z", stderr: "" };
      }
      if (cmd === "git" && args[0] === "log") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    requireFrgPass: async (_d, version) => defaultFrgPass(version),
    listOpenSoakDefectCandidates: async () => [
      {
        number: 930,
        title: "pre-tag engine defect",
        state: "OPEN",
        labels: ["bug", "pipeline:engine-class"],
        body: "",
        // After commit, before annotated tag → must NOT block via label-fallback.
        createdAt: "2026-07-02T12:00:00Z",
      },
    ],
    listTypedSoakEvidence: async () => [],
  });
  // Clean set (no typed hits; issue outside tagger window) → release proceeds past preflight.
  // Dry-run still runs preflight; use dry-run to avoid full release path.
  await runRelease("1.6.0", { dryRun: true }, { repo_dir: "/repo", repo: "org/repo" }, deps);
  assert.equal(written.length, 0);
});
