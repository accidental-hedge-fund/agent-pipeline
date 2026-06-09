// Regression tests for the docs-update docs-only file constraint (#68, 4.7/4.8/4.9).
// Tests enforceDocsOnlyGate directly — the full advance/updateDocs chain is
// not exercised, consistent with how pre-merge-sha-gate.test.ts tests
// enforceReviewShaGate in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceDocsCommitMessageGate, enforceDocsOnlyGate } from "../scripts/stages/pre_merge.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";

function filesDeps(diffFiles: string[], dirtyFiles: string[]): VerifyDeps {
  return {
    gitMessages: async () => [],
    gitDiffFiles: async () => diffFiles,
    gitDirtyFiles: async () => dirtyFiles,
  };
}

// ---------------------------------------------------------------------------
// 4.7: docs-update blocks when a modified file path matches the deny-list
// ---------------------------------------------------------------------------

test("docs-only: .ts file in committed diff → blocked (4.7)", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(
    ["README.md", "core/scripts/foo.ts"],
    [],
  ));
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("core/scripts/foo.ts"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("docs-only: .ts file in dirty (uncommitted) tree → blocked (4.7)", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(
    [],
    ["core/scripts/bar.ts"],
  ));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("core/scripts/bar.ts"));
});

test("docs-only: .js file in src/ → blocked", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(["src/app.js"], []));
  assert.equal(result.ok, false);
});

test("docs-only: file under plugin/ → blocked", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(["plugin/foo.ts"], []));
  assert.equal(result.ok, false);
});

test("docs-only: blocked outcome lists all denied files", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(
    ["core/a.ts", "core/b.ts"],
    [],
  ));
  assert.equal(result.ok, false);
  assert.ok("reason" in result);
  assert.ok(result.reason.includes("core/a.ts") && result.reason.includes("core/b.ts"));
});

// ---------------------------------------------------------------------------
// 4.8: docs-update proceeds when all modified files are doc-only
// ---------------------------------------------------------------------------

test("docs-only: only .md files modified → proceeds (4.8)", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(
    ["README.md", "CLAUDE.md", "docs/runbook.md"],
    [],
  ));
  assert.equal(result.ok, true);
});

test("docs-only: .yaml config file modified → blocked (finding 4: not a documentation file)", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(
    [".github/pipeline.yml"],
    [],
  ));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("pipeline.yml"));
});

test("docs-only: mix of doc files in committed and dirty → proceeds if none are app code", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps(
    ["README.md"],
    ["docs/new-guide.md"],
  ));
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// 4.9: docs-update proceeds (no block) when no commits are produced
// ---------------------------------------------------------------------------

test("docs-only: no committed changes, no dirty files → proceeds (4.9)", async () => {
  const result = await enforceDocsOnlyGate("/wt", "abc", filesDeps([], []));
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// enforceDocsCommitMessageGate (#68 review-2 finding 3)
// ---------------------------------------------------------------------------

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

test("docs commit message: correct prefix → ok", async () => {
  const result = await enforceDocsCommitMessageGate("/wt", "abc", 42,
    msgsDeps(["docs: update documentation for #42\n"]));
  assert.equal(result.ok, true);
});

test("docs commit message: case-insensitive match → ok", async () => {
  const result = await enforceDocsCommitMessageGate("/wt", "abc", 42,
    msgsDeps(["Docs: Update Documentation For #42\n"]));
  assert.equal(result.ok, true);
});

test("docs commit message: wrong prefix → blocked", async () => {
  const result = await enforceDocsCommitMessageGate("/wt", "abc", 42,
    msgsDeps(["chore: update docs (#42)\n"]));
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("docs: update documentation for #42"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("docs commit message: wrong issue number → blocked", async () => {
  const result = await enforceDocsCommitMessageGate("/wt", "abc", 42,
    msgsDeps(["docs: update documentation for #99\n"]));
  assert.equal(result.ok, false);
});

test("docs commit message: no harness commits (allowEmpty) → ok", async () => {
  // Harness left dirty files; pipeline will commit. allowEmpty means no commits = ok.
  const result = await enforceDocsCommitMessageGate("/wt", "abc", 42, msgsDeps([]));
  assert.equal(result.ok, true);
});
