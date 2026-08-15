/**
 * Neutral pipeline-commits module (#629): classification truth table and
 * module-boundary regression nets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  isPipelineInternalCommit,
  OPENSPEC_ARCHIVE_PREFIX,
  VISUAL_PUBLISH_COMMIT_PREFIX,
  VISUAL_PUBLISH_COMMIT_PATTERN,
} from "../scripts/pipeline-commits.ts";

test("isPipelineInternalCommit: OpenSpec archive prefix is internal", () => {
  assert.equal(isPipelineInternalCommit("chore: archive OpenSpec change(s) for #16"), true);
  assert.equal(
    isPipelineInternalCommit(`${OPENSPEC_ARCHIVE_PREFIX}99`),
    true,
  );
});

test("isPipelineInternalCommit: exact visual publish is internal", () => {
  assert.equal(isPipelineInternalCommit("chore: publish visual-gate evidence for #16"), true);
  assert.equal(
    isPipelineInternalCommit(`${VISUAL_PUBLISH_COMMIT_PREFIX}1`),
    true,
  );
  assert.ok(VISUAL_PUBLISH_COMMIT_PATTERN.test(`${VISUAL_PUBLISH_COMMIT_PREFIX}42`));
});

test("isPipelineInternalCommit: near-miss visual publish is NOT internal", () => {
  assert.equal(
    isPipelineInternalCommit("chore: publish visual-gate evidence for #463 and also refactor auth"),
    false,
  );
  assert.equal(isPipelineInternalCommit("chore: publish visual-gate evidence for #463x"), false);
  assert.equal(isPipelineInternalCommit("chore: publish visual-gate evidence for #"), false);
});

test("isPipelineInternalCommit: docs, auto-format, auto-fix are NOT internal", () => {
  assert.equal(isPipelineInternalCommit("docs: update documentation for #16"), false);
  assert.equal(isPipelineInternalCommit("chore: auto-format (#182)"), false);
  assert.equal(isPipelineInternalCommit("fix: pre-merge auto-fix for #359"), false);
  assert.equal(isPipelineInternalCommit("fix: address review 1 findings (#16)"), false);
  assert.equal(isPipelineInternalCommit("feat: add a thing"), false);
});

test("isPipelineInternalCommit: exact docs regenerate heal is internal (#1081)", () => {
  assert.equal(isPipelineInternalCommit("docs: regenerate generated docs (#1081)"), true);
  assert.equal(isPipelineInternalCommit("docs: regenerate generated docs (#1)"), true);
  assert.equal(isPipelineInternalCommit("docs: regenerate generated docs (#1081) and refactor"), false);
  assert.equal(isPipelineInternalCommit("docs: regenerate CHANGELOG for v1.39.0"), false);
});

test("pipeline-commits.ts source pin: neutral module has no stages/ imports", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/pipeline-commits.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(src, /from\s+["']\.\/stages\//);
  assert.doesNotMatch(src, /from\s+["']\.\.\/stages\//);
  assert.doesNotMatch(src, /from\s+["']\.\/stages\//);
  // No stage path imports at all.
  for (const line of src.split("\n")) {
    if (!/^\s*import\s/.test(line)) continue;
    assert.doesNotMatch(line, /stages\//, `unexpected stages import: ${line}`);
  }
});

test("shipcheck.ts source pin: does not import pre_merge for classification", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/shipcheck.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    src,
    /from\s+["']\.\/pre_merge\.ts["']/,
    "shipcheck must not import pre_merge",
  );
  assert.match(
    src,
    /from\s+["']\.\.\/pipeline-commits\.ts["']/,
    "shipcheck must import isPipelineInternalCommit from pipeline-commits",
  );
  assert.match(src, /isPipelineInternalCommit/);
});

test("visual publish prefix is single-sourced with the classifier", () => {
  const subject = `${VISUAL_PUBLISH_COMMIT_PREFIX}629`;
  assert.equal(isPipelineInternalCommit(subject), true);
  assert.equal(isPipelineInternalCommit(`${subject} trailing`), false);
});
