// Unit tests for PreMergeOfframpClass mapper (#683). Pure — no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRE_MERGE_OFFRAMP_CLASSES,
  isPreMergeOfframpClass,
  toPreMergeOfframpClass,
  zeroPreMergeOfframpClassCounts,
  type PreMergeOfframpClass,
} from "../scripts/pre-merge-offramp.ts";
import { BLOCKER_KINDS } from "../scripts/types.ts";

test("PRE_MERGE_OFFRAMP_CLASSES is a closed non-empty set with required members", () => {
  assert.ok(PRE_MERGE_OFFRAMP_CLASSES.length >= 6);
  for (const required of [
    "ci-failed",
    "delta-review",
    "merge-conflict",
    "openspec-invalid",
    "openspec-stale-delta",
    "other",
  ] as const) {
    assert.ok(PRE_MERGE_OFFRAMP_CLASSES.includes(required), `missing ${required}`);
  }
});

test("isPreMergeOfframpClass accepts only closed members", () => {
  assert.equal(isPreMergeOfframpClass("ci-failed"), true);
  assert.equal(isPreMergeOfframpClass("other"), true);
  assert.equal(isPreMergeOfframpClass("needs-human"), false);
  assert.equal(isPreMergeOfframpClass(null), false);
  assert.equal(isPreMergeOfframpClass(undefined), false);
  assert.equal(isPreMergeOfframpClass(1), false);
});

test("toPreMergeOfframpClass: documented path tags map to themselves", () => {
  assert.equal(toPreMergeOfframpClass({ pathTag: "ci-failed" }), "ci-failed");
  assert.equal(toPreMergeOfframpClass({ pathTag: "delta-review" }), "delta-review");
  assert.equal(toPreMergeOfframpClass({ pathTag: "merge-conflict" }), "merge-conflict");
  assert.equal(toPreMergeOfframpClass({ pathTag: "openspec-invalid" }), "openspec-invalid");
  assert.equal(toPreMergeOfframpClass({ pathTag: "openspec-stale-delta" }), "openspec-stale-delta");
});

test("toPreMergeOfframpClass: pathTag wins over coarser blockerKind", () => {
  assert.equal(
    toPreMergeOfframpClass({ blockerKind: "needs-human", pathTag: "ci-failed" }),
    "ci-failed",
  );
  assert.equal(
    toPreMergeOfframpClass({ blockerKind: "needs-human", pathTag: "delta-review" }),
    "delta-review",
  );
});

test("toPreMergeOfframpClass: residual pathTag 'other' does not short-circuit finer kind", () => {
  // Explicit residual tag is not a fine class — fall through to kind mapping.
  assert.equal(
    toPreMergeOfframpClass({ blockerKind: "merge-conflict", pathTag: "other" }),
    "merge-conflict",
  );
});

test("toPreMergeOfframpClass: BlockerKind maps as specified", () => {
  assert.equal(toPreMergeOfframpClass({ blockerKind: "merge-conflict" }), "merge-conflict");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "openspec-invalid" }), "openspec-invalid");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "openspec-stale-delta" }), "openspec-stale-delta");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "test-gate-exhausted" }), "ci-failed");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "build-failed" }), "ci-failed");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "needs-human" }), "other");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "no-pull-request" }), "other");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "human-decision-required" }), "other");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "head-drift" }), "other");
});

test("toPreMergeOfframpClass: unknown/missing → other", () => {
  assert.equal(toPreMergeOfframpClass({}), "other");
  assert.equal(toPreMergeOfframpClass({ blockerKind: null }), "other");
  assert.equal(toPreMergeOfframpClass({ blockerKind: undefined }), "other");
  assert.equal(toPreMergeOfframpClass({ blockerKind: "not-a-real-kind" }), "other");
  assert.equal(toPreMergeOfframpClass({ pathTag: "bogus" }), "other");
  assert.equal(toPreMergeOfframpClass({ pathTag: null, blockerKind: null }), "other");
});

test("toPreMergeOfframpClass: total over every BlockerKind (returns closed class)", () => {
  for (const kind of BLOCKER_KINDS) {
    const cls = toPreMergeOfframpClass({ blockerKind: kind });
    assert.ok(isPreMergeOfframpClass(cls), `kind ${kind} → ${cls}`);
  }
});

test("toPreMergeOfframpClass: distinct CI vs merge-conflict classes", () => {
  const ci = toPreMergeOfframpClass({ pathTag: "ci-failed", blockerKind: "needs-human" });
  const conflict = toPreMergeOfframpClass({ blockerKind: "merge-conflict" });
  assert.notEqual(ci, conflict);
  assert.equal(ci, "ci-failed");
  assert.equal(conflict, "merge-conflict");
});

test("zeroPreMergeOfframpClassCounts covers every closed class at 0", () => {
  const counts = zeroPreMergeOfframpClassCounts();
  const keys = Object.keys(counts) as PreMergeOfframpClass[];
  assert.deepEqual([...keys].sort(), [...PRE_MERGE_OFFRAMP_CLASSES].sort());
  for (const c of PRE_MERGE_OFFRAMP_CLASSES) {
    assert.equal(counts[c], 0);
  }
});

test("toPreMergeOfframpClass has no I/O (sync pure function)", () => {
  // Smoke: calling many times with varied input never throws and stays total.
  for (let i = 0; i < 50; i++) {
    const cls = toPreMergeOfframpClass({
      blockerKind: BLOCKER_KINDS[i % BLOCKER_KINDS.length],
      pathTag: i % 2 === 0 ? "ci-failed" : undefined,
    });
    assert.ok(isPreMergeOfframpClass(cls));
  }
});
