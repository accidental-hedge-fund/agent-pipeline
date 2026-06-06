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
  parseValidateResult,
  readChangeFile,
  readSpecDeltas,
  shouldPlanWithOpenspec,
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
