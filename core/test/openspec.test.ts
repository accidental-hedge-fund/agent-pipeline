// OpenSpec wrapper tests — pure unit (no `openspec` binary required).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isActive, isInitialized, parseValidateResult } from "../scripts/openspec.ts";

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
