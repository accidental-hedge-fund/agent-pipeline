// OpenSpec wrapper tests — pure unit (no `openspec` binary required).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  changeDirExists,
  changeIdsFromPaths,
  isActive,
  isInitialized,
  listChangeDirs,
  openspecContext,
  openspecContextFromDiff,
  parseValidateResult,
  readChangeFile,
  readSpecDeltas,
  shouldPlanWithOpenspec,
  unarchivedChangeIdsFromPrFiles,
} from "../scripts/openspec.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openspec-test-"));
}

test("isInitialized: true only when openspec/ dir exists", () => {
  const dir = tmpDir();
  assert.equal(isInitialized(dir), false);
  fs.mkdirSync(path.join(dir, "openspec"));
  assert.equal(isInitialized(dir), true);
});

test("isActive: off → false and on → true regardless of dir", () => {
  const dir = tmpDir(); // no openspec/
  assert.equal(isActive({ openspec: { enabled: "off" } }, dir), false);
  assert.equal(isActive({ openspec: { enabled: "on" } }, dir), true);
});

test("isActive: auto → follows openspec/ presence", () => {
  const dir = tmpDir();
  assert.equal(isActive({ openspec: { enabled: "auto" } }, dir), false);
  fs.mkdirSync(path.join(dir, "openspec"));
  assert.equal(isActive({ openspec: { enabled: "auto" } }, dir), true);
});

test("parseValidateResult: exit 0 is valid with no issues", () => {
  const r = parseValidateResult(0, "");
  assert.equal(r.valid, true);
  assert.equal(r.issues.length, 0);
  assert.equal(r.unavailable, false);
});

test("parseValidateResult: nonzero exit with JSON issues is invalid and extracts messages", () => {
  const out = JSON.stringify({
    results: [{ item: "add-auth", valid: false, errors: ["missing tasks.md", "spec delta empty"] }],
  });
  const r = parseValidateResult(1, out);
  assert.equal(r.valid, false);
  const msgs = r.issues.map((i) => i.message);
  assert.ok(msgs.includes("missing tasks.md"));
  assert.ok(msgs.includes("spec delta empty"));
});

test("parseValidateResult: nonzero exit with non-JSON falls back to raw text", () => {
  const r = parseValidateResult(2, "Error: openspec workspace is corrupt");
  assert.equal(r.valid, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].message, /workspace is corrupt/);
});

test("parseValidateResult: object with a message field is captured", () => {
  const r = parseValidateResult(1, JSON.stringify({ message: "validation failed: 2 errors" }));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => /2 errors/.test(i.message)));
});

test("parseValidateResult: nested results.changes shape extracts issues", () => {
  const out = JSON.stringify({
    results: { changes: [{ name: "add-auth", valid: false, issues: ["delta missing scenario"] }] },
    summary: { total: 1, valid: 0, invalid: 1 },
  });
  const r = parseValidateResult(1, out);
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => /delta missing scenario/.test(i.message)));
});

test("listChangeDirs: lists change folders excluding archive", () => {
  const dir = tmpDir();
  const changes = path.join(dir, "openspec", "changes");
  fs.mkdirSync(path.join(changes, "add-auth"), { recursive: true });
  fs.mkdirSync(path.join(changes, "fix-bug"), { recursive: true });
  fs.mkdirSync(path.join(changes, "archive"), { recursive: true });
  assert.deepEqual(listChangeDirs(dir).sort(), ["add-auth", "fix-bug"]);
});

test("listChangeDirs: empty when no openspec workspace", () => {
  assert.deepEqual(listChangeDirs(tmpDir()), []);
});

test("changeDirExists + readChangeFile", () => {
  const dir = tmpDir();
  const c = path.join(dir, "openspec", "changes", "add-auth");
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, "proposal.md"), "# Proposal\nbody");
  assert.equal(changeDirExists(dir, "add-auth"), true);
  assert.equal(changeDirExists(dir, "nope"), false);
  assert.match(readChangeFile(dir, "add-auth", "proposal.md") ?? "", /Proposal/);
  assert.equal(readChangeFile(dir, "add-auth", "missing.md"), null);
});

test("readSpecDeltas: concatenates spec delta markdown under a change", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "add-auth", "specs", "auth");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "## ADDED Requirement: login\nuser can log in");
  const out = readSpecDeltas(dir, "add-auth");
  assert.match(out, /Requirement: login/);
  assert.match(out, /user can log in/);
});

test("readSpecDeltas: empty string when the change has no specs", () => {
  assert.equal(readSpecDeltas(tmpDir(), "nope"), "");
});

test("parseValidateResult: real validate --json {items} failure yields clean messages", () => {
  // Shape confirmed against openspec 1.4.1: { items: [...], summary: { totals }, byType }.
  const out = JSON.stringify({
    items: [
      { id: "add-auth", type: "change", valid: false, issues: ["missing tasks.md", "empty spec delta"] },
    ],
    summary: { totals: { items: 1, passed: 0, failed: 1 } },
    version: "1.0",
  });
  const r = parseValidateResult(1, out);
  assert.equal(r.valid, false);
  const msgs = r.issues.map((i) => i.message);
  assert.ok(msgs.includes("missing tasks.md"));
  assert.ok(msgs.includes("empty spec delta"));
});

test("changeIdsFromPaths: distinct active change ids, excludes archive + non-change paths", () => {
  const paths = [
    "openspec/changes/add-auth/proposal.md",
    "openspec/changes/add-auth/tasks.md",
    "openspec/changes/archive/2026-01-01-old/specs/x/spec.md",
    "src/index.ts",
    "openspec/specs/auth/spec.md",
  ];
  assert.deepEqual(changeIdsFromPaths(paths).sort(), ["add-auth"]);
});

test("unarchivedChangeIdsFromPrFiles: active-only id is unarchived", () => {
  const paths = ["openspec/changes/foo/proposal.md", "openspec/changes/foo/tasks.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), ["foo"]);
});

test("unarchivedChangeIdsFromPrFiles: archived-only id is not unarchived", () => {
  const paths = ["openspec/changes/archive/foo/proposal.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: id present both active and archived nets to none remaining", () => {
  const paths = [
    "openspec/changes/foo/proposal.md",
    "openspec/changes/archive/foo/proposal.md",
  ];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: no openspec/changes paths → empty", () => {
  const paths = ["src/index.ts", "openspec/specs/auth/spec.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: nested paths and multiple ids", () => {
  const paths = [
    "openspec/changes/foo/specs/x/spec.md",
    "openspec/changes/bar/proposal.md",
    "openspec/changes/archive/bar/proposal.md",
  ];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths).sort(), ["foo"]);
});

test("unarchivedChangeIdsFromPrFiles: archive id itself excluded from active set", () => {
  const paths = ["openspec/changes/archive/proposal.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("shouldPlanWithOpenspec: off → false, on → true", () => {
  const d = tmpDir();
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "off", bootstrap: true } }, d), false);
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "on", bootstrap: false } }, d), true);
});

test("shouldPlanWithOpenspec: auto follows init, or bootstrap when uninitialized", () => {
  const d = tmpDir();
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "auto", bootstrap: false } }, d), false);
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "auto", bootstrap: true } }, d), true);
  fs.mkdirSync(path.join(d, "openspec"));
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "auto", bootstrap: false } }, d), true);
});

test("openspecContext: returns spec deltas when OpenSpec is active with a change", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs", "feature");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "## ADDED Requirement: must support batch mode");
  const result = openspecContext({ openspec: { enabled: "on" } }, dir);
  assert.match(result, /must support batch mode/);
});

test("openspecContext: returns empty string when OpenSpec is inactive (mode off)", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "## ADDED Requirement");
  assert.equal(openspecContext({ openspec: { enabled: "off" } }, dir), "");
});

test("openspecContext: returns empty string when no change dirs exist", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "openspec", "changes"), { recursive: true });
  assert.equal(openspecContext({ openspec: { enabled: "on" } }, dir), "");
});

test("openspecContext: returns empty string when active change has no spec deltas", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "openspec", "changes", "empty-change"), { recursive: true });
  assert.equal(openspecContext({ openspec: { enabled: "on" } }, dir), "");
});

test("openspecContext: uses the first change dir when multiple exist", () => {
  const dir = tmpDir();
  const changes = path.join(dir, "openspec", "changes");
  const s1 = path.join(changes, "aaa-change", "specs");
  const s2 = path.join(changes, "zzz-change", "specs");
  fs.mkdirSync(s1, { recursive: true });
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s1, "spec.md"), "REQ-AAA");
  fs.writeFileSync(path.join(s2, "spec.md"), "REQ-ZZZ");
  const result = openspecContext({ openspec: { enabled: "on" } }, dir);
  // Should return spec deltas from whichever change listChangeDirs() picks first.
  assert.ok(result === "REQ-AAA" || result.includes("REQ-AAA") || result === "REQ-ZZZ" || result.includes("REQ-ZZZ"));
  // Should NOT include both (only the first change is used).
  assert.ok(!(result.includes("REQ-AAA") && result.includes("REQ-ZZZ")));
});

// ---------------------------------------------------------------------------
// openspecContextFromDiff — regression for multi-change worktrees in fix rounds
// ---------------------------------------------------------------------------

test("openspecContextFromDiff: returns inactive string when OpenSpec is off", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "REQ-X");
  const result = openspecContextFromDiff({ openspec: { enabled: "off" } }, dir, [
    "openspec/changes/my-change/proposal.md",
  ]);
  assert.equal(result, "");
});

test("openspecContextFromDiff: returns the matching change's spec deltas", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "new-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "REQ-NEW");
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, [
    "src/index.ts",
    "openspec/changes/new-change/proposal.md",
    "openspec/changes/new-change/tasks.md",
  ]);
  assert.match(result, /REQ-NEW/);
});

test("openspecContextFromDiff: returns empty string when diff has no OpenSpec change paths", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "REQ-X");
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, [
    "src/index.ts",
    "README.md",
  ]);
  assert.equal(result, "");
});

test("openspecContextFromDiff: multi-change worktree — selects only the branch-introduced change", () => {
  // Regression: worktree has a pre-existing 'old-change' AND this branch's 'new-change'.
  // openspecContext() would pick changes[0] (alphabetically 'new-change' here, but
  // ordering is filesystem-dependent). openspecContextFromDiff must pick only 'new-change'
  // regardless of ordering, because only 'new-change' appears in the branch diff paths.
  const dir = tmpDir();
  const oldSpecs = path.join(dir, "openspec", "changes", "old-change", "specs");
  const newSpecs = path.join(dir, "openspec", "changes", "new-change", "specs");
  fs.mkdirSync(oldSpecs, { recursive: true });
  fs.mkdirSync(newSpecs, { recursive: true });
  fs.writeFileSync(path.join(oldSpecs, "spec.md"), "REQ-OLD-UNRELATED");
  fs.writeFileSync(path.join(newSpecs, "spec.md"), "REQ-NEW-CORRECT");

  // Branch diff only references new-change (old-change was already on base branch).
  const diffPaths = [
    "src/feature.ts",
    "openspec/changes/new-change/proposal.md",
    "openspec/changes/new-change/specs/spec.md",
  ];
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, diffPaths);
  assert.match(result, /REQ-NEW-CORRECT/);
  assert.ok(!result.includes("REQ-OLD-UNRELATED"), "must not include the pre-existing change's spec deltas");
});

test("openspecContextFromDiff: returns empty string when diff references a change not on disk", () => {
  // e.g. the diff references openspec/changes/gone-change/ but it was archived/deleted.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "openspec", "changes"), { recursive: true });
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, [
    "openspec/changes/gone-change/proposal.md",
  ]);
  assert.equal(result, "");
});
