// Unit tests for the shared verifyHarnessCommits helper and verifyPlanRevisionOutput (#68).
// All git I/O is injected via VerifyDeps — no real git processes are spawned.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDocumentationFile,
  parseDirtyFiles,
  verifyHarnessCommits,
  verifyPlanRevisionOutput,
  type VerifyDeps,
} from "../scripts/verify-harness-commits.ts";

// ---------------------------------------------------------------------------
// parseDirtyFiles — pure
// ---------------------------------------------------------------------------

test("parseDirtyFiles: empty string returns []", () => {
  assert.deepEqual(parseDirtyFiles(""), []);
});

test("parseDirtyFiles: single modified file", () => {
  assert.deepEqual(parseDirtyFiles(" M core/scripts/foo.ts"), ["core/scripts/foo.ts"]);
});

test("parseDirtyFiles: untracked file", () => {
  assert.deepEqual(parseDirtyFiles("?? newfile.ts"), ["newfile.ts"]);
});

test("parseDirtyFiles: renamed file extracts destination path", () => {
  assert.deepEqual(parseDirtyFiles("R  old.ts -> new.ts"), ["new.ts"]);
});

test("parseDirtyFiles: multiple lines", () => {
  const input = " M README.md\n?? docs/guide.md";
  assert.deepEqual(parseDirtyFiles(input), ["README.md", "docs/guide.md"]);
});

// ---------------------------------------------------------------------------
// isDocumentationFile — pure (allow-list approach for docsOnly, finding 4)
// ---------------------------------------------------------------------------

test("isDocumentationFile: .md file is documentation", () => {
  assert.equal(isDocumentationFile("README.md"), true);
});

test("isDocumentationFile: CLAUDE.md is documentation", () => {
  assert.equal(isDocumentationFile("CLAUDE.md"), true);
});

test("isDocumentationFile: docs/guide.md is documentation", () => {
  assert.equal(isDocumentationFile("docs/guide.md"), true);
});

test("isDocumentationFile: file under docs/ is documentation", () => {
  assert.equal(isDocumentationFile("docs/api-reference.txt"), true);
});

test("isDocumentationFile: named LICENSE file (no extension) is documentation", () => {
  assert.equal(isDocumentationFile("LICENSE"), true);
});

test("isDocumentationFile: named CHANGELOG file is documentation", () => {
  assert.equal(isDocumentationFile("CHANGELOG"), true);
});

test("isDocumentationFile: .ts file is NOT documentation → denied in docs-only mode", () => {
  assert.equal(isDocumentationFile("core/scripts/foo.ts"), false);
});

test("isDocumentationFile: .js file is NOT documentation", () => {
  assert.equal(isDocumentationFile("src/index.js"), false);
});

test("isDocumentationFile: .yaml workflow file is NOT documentation → denied (finding 4)", () => {
  assert.equal(isDocumentationFile(".github/workflows/ci.yml"), false);
});

test("isDocumentationFile: package.json is NOT documentation → denied (finding 4)", () => {
  assert.equal(isDocumentationFile("package.json"), false);
});

test("isDocumentationFile: config JSON outside doc-examples is NOT documentation (finding 4)", () => {
  assert.equal(isDocumentationFile("tsconfig.json"), false);
});

// ---------------------------------------------------------------------------
// verifyHarnessCommits — issue reference check
// ---------------------------------------------------------------------------

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

test("issueNumber: at least one commit contains the reference → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { issueNumber: 42 }, msgsDeps([
    "fix: something\n\nCloses #42",
  ]));
  assert.equal(result.ok, true);
});

test("issueNumber: reference in subject is sufficient", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { issueNumber: 99 }, msgsDeps([
    "implement feature (#99)\n",
  ]));
  assert.equal(result.ok, true);
});

test("issueNumber: no commit contains the reference → blocked", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { issueNumber: 42 }, msgsDeps([
    "fix: something unrelated\n",
    "refactor: another commit\n",
  ]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("#42"), `reason: ${JSON.stringify(result)}`);
});

test("issueNumber: empty range (no commits) → blocked (harness produced nothing, finding 1)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { issueNumber: 42 }, msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

test("issueNumber: empty range with allowEmpty → ok (explicit opt-out, finding 1)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { issueNumber: 42, allowEmpty: true }, msgsDeps([]));
  assert.equal(result.ok, true);
});

test("issueNumber: only one of several commits references it → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { issueNumber: 5 }, msgsDeps([
    "chore: formatting\n",
    "feat: implement #5\n",
    "test: add tests\n",
  ]));
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// verifyHarnessCommits — messagePattern check
// ---------------------------------------------------------------------------

test("messagePattern: matching commit → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    messagePattern: {
      pattern: /fix: address review 1 findings \(#42\)/i,
      description: "fix round 1 format mismatch",
    },
  }, msgsDeps(["fix: address review 1 findings (#42)\n"]));
  assert.equal(result.ok, true);
});

test("messagePattern: no matching commit → blocked with description", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    messagePattern: {
      pattern: /fix: address review 1 findings \(#42\)/i,
      description: "fix round 1 format mismatch",
    },
  }, msgsDeps(["fix: some unrelated message\n"]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason === "fix round 1 format mismatch");
});

test("messagePattern: case-insensitive match → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    messagePattern: {
      pattern: /fix: resolve test\/build failures \(#7\)/i,
      description: "test-fix format",
    },
  }, msgsDeps(["FIX: Resolve Test/Build Failures (#7)\n"]));
  assert.equal(result.ok, true);
});

test("messagePattern: empty range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    messagePattern: {
      pattern: /fix: address review 1 findings \(#1\)/i,
      description: "mismatch",
    },
  }, msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

// ---------------------------------------------------------------------------
// verifyHarnessCommits — requireTrailers check
// ---------------------------------------------------------------------------

test("requireTrailers: all commits carry required trailers → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    requireTrailers: ["Issue", "Pipeline-Run"],
  }, msgsDeps([
    "feat: something\n\nIssue: #42\nPipeline-Run: run-123\n",
    "fix: another\n\nIssue: #42\nPipeline-Run: run-123\n",
  ]));
  assert.equal(result.ok, true);
});

test("requireTrailers: commit missing a trailer → blocked", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    requireTrailers: ["Issue"],
  }, msgsDeps([
    "feat: something without issue trailer\n",
  ]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes('"Issue:"'));
});

test("requireTrailers: empty range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    requireTrailers: ["Issue"],
  }, msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

// ---------------------------------------------------------------------------
// verifyHarnessCommits — docsOnly check
// ---------------------------------------------------------------------------

function filesDeps(diffFiles: string[], dirtyFiles: string[]): VerifyDeps {
  return {
    gitMessages: async () => [],
    gitDiffFiles: async () => diffFiles,
    gitDirtyFiles: async () => dirtyFiles,
  };
}

test("docsOnly: all committed files are docs → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps(["README.md", "CLAUDE.md", "docs/guide.md"], []));
  assert.equal(result.ok, true);
});

test("docsOnly: committed .ts file → blocked", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps(["README.md", "core/scripts/foo.ts"], []));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("core/scripts/foo.ts"));
});

test("docsOnly: uncommitted dirty .ts file → blocked (pre-commit check)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps([], ["core/scripts/foo.ts"]));
  assert.equal(result.ok, false);
});

test("docsOnly: no files changed (empty docs run) → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps([], []));
  assert.equal(result.ok, true);
});

test("docsOnly: .js file in dirty list → blocked", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps([], ["src/app.js"]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("src/app.js"));
});

test("docsOnly: combination of doc and app code → blocked, lists denied file", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps(["README.md", "src/main.ts"], []));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("src/main.ts") && !result.reason.includes("README.md"));
});

test("docsOnly: package.json in committed files → blocked (finding 4)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps(["README.md", "package.json"], []));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("package.json"));
});

test("docsOnly: workflow config file → blocked (finding 4)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", { docsOnly: true },
    filesDeps([".github/workflows/ci.yml"], []));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("ci.yml"));
});

// ---------------------------------------------------------------------------
// verifyHarnessCommits — pathConstraint check (finding 3)
// ---------------------------------------------------------------------------

function diffFilesDeps(diffFiles: string[]): VerifyDeps {
  return {
    gitMessages: async () => [],
    gitDiffFiles: async () => diffFiles,
    gitDirtyFiles: async () => [],
  };
}

test("pathConstraint: all committed files under allowed prefix → ok", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "committed files outside openspec/",
    },
  }, diffFilesDeps(["openspec/changes/abc/proposal.md", "openspec/changes/abc/tasks.md"]));
  assert.equal(result.ok, true);
});

test("pathConstraint: file outside allowed prefix → blocked (finding 3)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "OpenSpec authoring committed non-openspec files",
    },
  }, diffFilesDeps(["openspec/changes/abc/proposal.md", "src/index.ts"]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("non-openspec files"));
});

test("pathConstraint: no committed files → ok (no violation)", async () => {
  const result = await verifyHarnessCommits("/wt", "abc", {
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "committed files outside openspec/",
    },
  }, diffFilesDeps([]));
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// verifyPlanRevisionOutput — pure
// ---------------------------------------------------------------------------

test("verifyPlanRevisionOutput: contains section with ADDRESSED item → ok", () => {
  const stdout = `## Feedback Incorporated\n- [ADDRESSED] Updated the commit format\n\n## Revised Plan\n...`;
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("verifyPlanRevisionOutput: contains section with DEFERRED item → ok", () => {
  const stdout = `## Feedback Incorporated\n- [DEFERRED] Skip for now — reason: out of scope\n\n## Plan\n...`;
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("verifyPlanRevisionOutput: section missing entirely → blocked", () => {
  const result = verifyPlanRevisionOutput("## Revised Plan\n\nSome plan here.");
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("## Feedback Incorporated"));
});

test("verifyPlanRevisionOutput: section present but no ADDRESSED/DEFERRED items → blocked", () => {
  const result = verifyPlanRevisionOutput(
    "## Feedback Incorporated\n\nI looked at the feedback.\n\n## Plan\n..."
  );
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("[ADDRESSED]"));
});

test("verifyPlanRevisionOutput: case-insensitive section header match", () => {
  const stdout = `## feedback incorporated\n- [ADDRESSED] something\n## Plan\n...`;
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("verifyPlanRevisionOutput: empty string → blocked", () => {
  const result = verifyPlanRevisionOutput("");
  assert.equal(result.ok, false);
});

test("verifyPlanRevisionOutput: both ADDRESSED and DEFERRED items → ok", () => {
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] Fixed the trailer check",
    "- [DEFERRED] Refactor the docs prompt — reason: out of scope for this PR",
    "",
    "## Revised Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout), { ok: true });
});

test("verifyPlanRevisionOutput: tagged items only in plan body, not in section → blocked (finding 5)", () => {
  const stdout = [
    "## Summary",
    "I [ADDRESSED] everything in the summary.",
    "",
    "## Feedback Incorporated",
    "Considered all feedback carefully.",
    "",
    "## Plan",
    "- [ADDRESSED] Implementation step",
  ].join("\n");
  const result = verifyPlanRevisionOutput(stdout);
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("[ADDRESSED]"));
});

test("verifyPlanRevisionOutput: with feedback — fewer ack items than feedback items → blocked (finding 5)", () => {
  const feedback = [
    "**1.** Add commit format check",
    "**2.** Add trailer validation",
    "**3.** Tighten docs path check",
  ].join("\n");
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] commit format (#1)",
    "",
    "## Plan",
    "...",
  ].join("\n");
  const result = verifyPlanRevisionOutput(stdout, feedback);
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("acknowledges only 1 of 3"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("verifyPlanRevisionOutput: with feedback — all items acknowledged → ok (finding 5)", () => {
  const feedback = [
    "**1.** Add commit format check",
    "**2.** Add trailer validation",
    "**3.** Tighten docs path check",
  ].join("\n");
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] commit format (#1)",
    "- [ADDRESSED] trailer validation (#2)",
    "- [DEFERRED] docs path check (#3) — reason: separate PR",
    "",
    "## Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout, feedback), { ok: true });
});

test("verifyPlanRevisionOutput: with feedback — no detectable items in feedback → ok (no count enforcement)", () => {
  const feedback = "The plan looks mostly fine. Consider tightening the docs check.";
  const stdout = [
    "## Feedback Incorporated",
    "- [ADDRESSED] tightened docs check",
    "",
    "## Plan",
    "...",
  ].join("\n");
  assert.deepEqual(verifyPlanRevisionOutput(stdout, feedback), { ok: true });
});
