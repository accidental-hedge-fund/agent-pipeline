// Tests for the ignored-artifact-warning detector (#445).
//
// Unit: detectIgnoredArtifacts via fake IgnoredArtifactDeps — no real git
// processes. Covers: a change-referenced ignored file surfaces a warning +
// event; unreferenced ignored clutter does not; a git failure is swallowed
// (non-fatal); an empty harness range is a no-op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIgnoredArtifacts, type IgnoredArtifactDeps } from "../scripts/ignored-artifact-warning.ts";

test("detectIgnoredArtifacts: ignored file referenced by the committed diff → warning names the file and rule (4.1)", async () => {
  const emitted: unknown[] = [];
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => ["benchmark/regime_4cell/results.json"],
    gitDiffText: async () =>
      "diff --git a/core/test/regime.test.ts b/core/test/regime.test.ts\n" +
      "+  assert.ok(fs.existsSync('benchmark/regime_4cell/results.json'));\n",
    gitCheckIgnore: async (_wt, filePath) => {
      assert.equal(filePath, "benchmark/regime_4cell/results.json");
      return { source: ".gitignore", line: 3, pattern: "*.json" };
    },
    emitEvent: async (files) => {
      emitted.push(files);
    },
  };

  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);

  assert.deepEqual(files, [
    { path: "benchmark/regime_4cell/results.json", source: ".gitignore", line: 3, pattern: "*.json" },
  ]);
  assert.equal(emitted.length, 1, "emitEvent invoked exactly once");
  assert.deepEqual(emitted[0], files);
});

test("detectIgnoredArtifacts: unreferenced ignored clutter → no warning, no event (4.2)", async () => {
  const emitted: unknown[] = [];
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => ["__pycache__/foo.pyc", "node_modules/left-pad/index.js"],
    gitDiffText: async () =>
      "diff --git a/core/scripts/foo.ts b/core/scripts/foo.ts\n+export const x = 1;\n",
    gitCheckIgnore: async () => {
      throw new Error("gitCheckIgnore should not be called for unreferenced files");
    },
    emitEvent: async (files) => {
      emitted.push(files);
    },
  };

  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);

  assert.deepEqual(files, []);
  assert.equal(emitted.length, 0);
});

test("detectIgnoredArtifacts: a referenced file among clutter is the only one flagged", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => ["__pycache__/foo.pyc", "benchmark/regime_4cell/results.json"],
    gitDiffText: async () => "references benchmark/regime_4cell/results.json only\n",
    gitCheckIgnore: async () => ({ source: ".gitignore", line: 1, pattern: "*.json" }),
  };

  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);

  assert.deepEqual(files.map((f) => f.path), ["benchmark/regime_4cell/results.json"]);
});

test("detectIgnoredArtifacts: git failure in gitListIgnored → no warning, does not throw (4.3)", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => {
      throw new Error("git ls-files failed: fatal: not a git repository");
    },
  };
  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);
  assert.deepEqual(files, []);
});

test("detectIgnoredArtifacts: git failure in gitDiffText → no warning, does not throw (4.3)", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => ["a.json"],
    gitDiffText: async () => {
      throw new Error("git diff failed");
    },
  };
  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);
  assert.deepEqual(files, []);
});

test("detectIgnoredArtifacts: git failure in gitCheckIgnore → no warning, does not throw (4.3)", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => ["a.json"],
    gitDiffText: async () => "references a.json\n",
    gitCheckIgnore: async () => {
      throw new Error("git check-ignore failed");
    },
  };
  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);
  assert.deepEqual(files, []);
});

test("detectIgnoredArtifacts: empty harness range (headBefore === headAfter) → no-op (4.4)", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => {
      throw new Error("must not be called for an empty range");
    },
  };
  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha1", deps);
  assert.deepEqual(files, []);
});

test("detectIgnoredArtifacts: missing headBefore/headAfter → no-op", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => {
      throw new Error("must not be called");
    },
  };
  assert.deepEqual(await detectIgnoredArtifacts("/wt", "", "sha2", deps), []);
  assert.deepEqual(await detectIgnoredArtifacts("/wt", "sha1", "", deps), []);
});

test("detectIgnoredArtifacts: no ignored files at all → no-op, gitDiffText not called", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => [],
    gitDiffText: async () => {
      throw new Error("must not be called when there are no ignored files");
    },
  };
  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);
  assert.deepEqual(files, []);
});

test("detectIgnoredArtifacts: unresolvable ignore rule still reports the file with null rule fields", async () => {
  const deps: IgnoredArtifactDeps = {
    gitListIgnored: async () => ["benchmark/regime_4cell/results.json"],
    gitDiffText: async () => "references benchmark/regime_4cell/results.json\n",
    gitCheckIgnore: async () => null,
  };
  const files = await detectIgnoredArtifacts("/wt", "sha1", "sha2", deps);
  assert.deepEqual(files, [
    { path: "benchmark/regime_4cell/results.json", source: null, line: null, pattern: null },
  ]);
});
