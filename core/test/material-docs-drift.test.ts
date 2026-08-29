// Offline drift guard: durable docs must name every shared material-kind
// constant and suppression class (#1049). No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADVANCE_MATERIAL_KINDS,
  LOOP_MATERIAL_KINDS,
  LOOP_OPTIONAL_MATERIAL_KINDS,
  LOOP_PROGRESS_DEFINITIVE_STATUSES,
  TRAIN_MATERIAL_KINDS,
} from "../scripts/material-filter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONCEPTS = join(here, "..", "..", "docs", "concepts.md");

test("docs/concepts.md names every shared material kind and suppression class", () => {
  const docs = readFileSync(CONCEPTS, "utf8");
  for (const kind of ADVANCE_MATERIAL_KINDS) {
    assert.ok(docs.includes(kind), `durable docs missing advance kind ${kind}`);
  }
  for (const kind of LOOP_MATERIAL_KINDS) {
    assert.ok(docs.includes(kind), `durable docs missing loop kind ${kind}`);
  }
  for (const kind of LOOP_OPTIONAL_MATERIAL_KINDS) {
    assert.ok(docs.includes(kind), `durable docs missing optional loop kind ${kind}`);
  }
  for (const kind of TRAIN_MATERIAL_KINDS) {
    assert.ok(docs.includes(kind), `durable docs missing train kind ${kind}`);
  }
  for (const status of LOOP_PROGRESS_DEFINITIVE_STATUSES) {
    assert.ok(
      docs.includes(`\`${status}\``) || docs.includes(status),
      `durable docs missing definitive status ${status}`,
    );
  }
  assert.match(docs, /CI `partial`/);
  assert.match(docs, /OpenSpec `skipped`/);
  assert.match(docs, /first CI `waiting`/);
});

test("deleting a kind class from durable docs would fail the guard", () => {
  const docs = readFileSync(CONCEPTS, "utf8");
  const droppedAdvance = docs.replaceAll("stage_complete", "");
  assert.ok(!droppedAdvance.includes("stage_complete"));
  const droppedLoop = docs.replaceAll("loop_item_advance_linked", "");
  assert.ok(!droppedLoop.includes("loop_item_advance_linked"));
  const droppedTrain = docs.replaceAll("train_loop_linked", "");
  assert.ok(!droppedTrain.includes("train_loop_linked"));
  const droppedStatus = docs.replaceAll("`exhausted`", "");
  assert.ok(!droppedStatus.includes("`exhausted`"));
});
