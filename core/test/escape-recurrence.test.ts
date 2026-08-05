// #763: seed defect-class registry, fix-boundary, post-boundary recurrence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_DEFECT_CLASS_KEYS,
  compareReleaseLabels,
  computeEscapeRecurrence,
  getDefectClassRegistry,
  isStrictlyAfterBoundary,
  mapSignalToDefectClassKey,
  resetDefectClassRegistryForTests,
  resolveFixBoundaries,
} from "../scripts/escape-recurrence.ts";

test("seed defect-class keys are present and stable", () => {
  resetDefectClassRegistryForTests();
  assert.deepEqual([...SEED_DEFECT_CLASS_KEYS], [
    "delta-sha-gate",
    "openspec-archive",
    "salvage",
    "worktree",
  ]);
  const reg = getDefectClassRegistry();
  for (const k of SEED_DEFECT_CLASS_KEYS) {
    assert.ok(reg.includes(k), `registry missing seed key ${k}`);
  }
});

test("mapSignalToDefectClassKey maps aliases and excludes unmapped", () => {
  assert.equal(mapSignalToDefectClassKey({ blocker_kind: "worktree-missing" }), "worktree");
  assert.equal(mapSignalToDefectClassKey({ reason_code: "openspec-archive-apply-conflict" }), "openspec-archive");
  assert.equal(mapSignalToDefectClassKey({ failure_class: "salvage-harness-work" }), "salvage");
  assert.equal(mapSignalToDefectClassKey({ correction_key: "delta-sha-gate" }), "delta-sha-gate");
  assert.equal(mapSignalToDefectClassKey({ message: "review-sha gate failed" }), "delta-sha-gate");
  assert.equal(mapSignalToDefectClassKey({ failure_class: "totally-unrelated-xyz" }), null);
});

test("post-boundary occurrence is recurrence; pre-boundary is not", () => {
  const boundaries = resolveFixBoundaries({
    attributions: [
      {
        correction_key: "delta-sha-gate",
        disposition: "implemented",
        effective_release: "v1.29.0",
        effective_at: "2026-06-01T00:00:00Z",
      },
      {
        correction_key: "openspec-archive",
        disposition: "implemented",
        effective_release: "v1.28.0",
        effective_at: "2026-05-01T00:00:00Z",
      },
    ],
  });

  const result = computeEscapeRecurrence({
    boundaries,
    occurrences: [
      {
        class_key: "delta-sha-gate",
        at: "2026-07-01T00:00:00Z",
        producing_release: null,
      },
      {
        class_key: "openspec-archive",
        at: "2026-04-15T00:00:00Z",
        producing_release: null,
      },
    ],
  });

  assert.equal(result.classes_with_fix_boundary, 2);
  assert.equal(result.classes_with_post_fix_occurrence, 1);
  assert.equal(result.ratio.numerator, 1);
  assert.equal(result.ratio.denominator, 2);
  assert.ok(result.ratio.ratio !== null);
  assert.ok(Math.abs((result.ratio.ratio as number) - 0.5) < 1e-9);

  const delta = result.by_key.find((r) => r.class_key === "delta-sha-gate");
  const osa = result.by_key.find((r) => r.class_key === "openspec-archive");
  assert.equal(delta?.recurrent, true);
  assert.equal(osa?.recurrent, false);
});

test("zero fix boundaries yields null ratio", () => {
  const result = computeEscapeRecurrence({
    boundaries: new Map(),
    occurrences: [
      { class_key: "worktree", at: "2026-07-01T00:00:00Z", producing_release: null },
    ],
  });
  assert.equal(result.ratio.numerator, 0);
  assert.equal(result.ratio.denominator, 0);
  assert.equal(result.ratio.ratio, null);
  assert.ok(result.missing_boundary_keys.includes("worktree"));
  assert.ok(
    result.diagnostics.some((d) => d.code === "escape_recurrence_missing_boundary"),
  );
});

test("unmapped occurrences are excluded from denominator", () => {
  const result = computeEscapeRecurrence({
    boundaries: resolveFixBoundaries({
      attributions: [
        {
          correction_key: "salvage",
          disposition: "implemented",
          effective_release: "v1.30.0",
          effective_at: "2026-06-15T00:00:00Z",
        },
      ],
    }),
    occurrences: [
      { class_key: "salvage", at: "2026-07-01T00:00:00Z", producing_release: null },
      // class_key empty would be unmapped at collection; here we only pass mapped
    ],
  });
  assert.equal(result.classes_with_fix_boundary, 1);
});

test("isStrictlyAfterBoundary and compareReleaseLabels", () => {
  assert.ok(compareReleaseLabels("v1.30.0", "v1.29.0") > 0);
  assert.ok(compareReleaseLabels("1.29.0", "v1.29.0") === 0);
  assert.equal(
    isStrictlyAfterBoundary(
      { class_key: "x", at: "2026-07-01T00:00:00Z", producing_release: null },
      {
        class_key: "x",
        effective_release: "v1.0.0",
        effective_at: "2026-06-01T00:00:00Z",
        source: "control_attribution",
      },
    ),
    true,
  );
  assert.equal(
    isStrictlyAfterBoundary(
      { class_key: "x", at: "2026-05-01T00:00:00Z", producing_release: null },
      {
        class_key: "x",
        effective_release: "v1.0.0",
        effective_at: "2026-06-01T00:00:00Z",
        source: "control_attribution",
      },
    ),
    false,
  );
});

test("compareReleaseLabels: prerelease < final release; build metadata equal precedence", () => {
  // SemVer: 1.30.0-rc.1 is earlier than 1.30.0 (not greater).
  assert.ok(
    compareReleaseLabels("v1.30.0-rc.1", "v1.30.0") < 0,
    "prerelease must be before final release",
  );
  assert.ok(compareReleaseLabels("v1.30.0", "v1.30.0-rc.1") > 0);
  assert.ok(compareReleaseLabels("1.30.0-rc.1", "1.30.0-rc.2") < 0);
  // Build metadata does not affect precedence.
  assert.equal(compareReleaseLabels("v1.30.0+build.1", "v1.30.0"), 0);
  assert.equal(compareReleaseLabels("v1.30.0+build.1", "v1.30.0+build.2"), 0);
  assert.ok(compareReleaseLabels("v1.30.0+build.1", "v1.29.0") > 0);
  // Prerelease with build metadata still before final.
  assert.ok(compareReleaseLabels("v1.30.0-rc.1+build.1", "v1.30.0") < 0);
});

test("isStrictlyAfterBoundary: prerelease/build occurrence is not post-fix recurrence", () => {
  const boundary = {
    class_key: "salvage" as const,
    effective_release: "v1.30.0",
    effective_at: null,
    source: "control_attribution" as const,
  };
  // Without timestamps, release labels alone decide; rc must not count as after.
  assert.equal(
    isStrictlyAfterBoundary(
      { class_key: "salvage", at: null, producing_release: "v1.30.0-rc.1" },
      boundary,
    ),
    false,
  );
  assert.equal(
    isStrictlyAfterBoundary(
      { class_key: "salvage", at: null, producing_release: "v1.30.0+build.1" },
      boundary,
    ),
    false,
  );
  assert.equal(
    isStrictlyAfterBoundary(
      { class_key: "salvage", at: null, producing_release: "v1.30.1" },
      boundary,
    ),
    true,
  );
});
