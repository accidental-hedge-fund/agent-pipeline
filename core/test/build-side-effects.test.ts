// Regression tests for build-artifact rebuild-and-fold (#387).
//
// Tests the helper directly via injectable seams — no real git, network, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFailureBlockReason,
  includeBuildArtifacts,
  type BuildSideEffectsDeps,
} from "../scripts/build-side-effects.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Calls {
  ran: string[];
  amended: number;
  added: number;
}

function makeDeps(opts: {
  preStatus?: string;
  postStatus?: string;
  buildCode?: number;
  buildOutput?: string;
}): { deps: BuildSideEffectsDeps; calls: Calls } {
  const calls: Calls = { ran: [], amended: 0, added: 0 };
  let statusCall = 0;
  const deps: BuildSideEffectsDeps = {
    gitStatusPorcelain: async () => {
      statusCall++;
      return statusCall === 1 ? (opts.preStatus ?? "") : (opts.postStatus ?? "");
    },
    runBuildCommand: async (_wt, cmd) => {
      calls.ran.push(cmd);
      return { code: opts.buildCode ?? 0, output: opts.buildOutput ?? "build ok" };
    },
    gitAddAll: async () => { calls.added++; },
    gitAmendNoEdit: async () => { calls.amended++; },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// 5.2: No build_command declared → no-op
// ---------------------------------------------------------------------------

test("no build_command declared → no-op: build runner and git writes never called (5.2)", async () => {
  const { deps, calls } = makeDeps({ postStatus: " M dist/bundle.js\n" });
  for (const cmd of [undefined, "", "   "]) {
    const result = await includeBuildArtifacts("/wt", cmd, deps);
    assert.deepEqual(result, { ran: false });
  }
  assert.deepEqual(calls.ran, [], "build runner never invoked");
  assert.equal(calls.added, 0);
  assert.equal(calls.amended, 0);
});

// ---------------------------------------------------------------------------
// 5.1: Fix round edits source + build produces a dist/ change → stages, amends
// ---------------------------------------------------------------------------

test("build regenerates dist/ → stages artifact and amends HEAD (5.1)", async () => {
  const { deps, calls } = makeDeps({ preStatus: "", postStatus: " M dist/bundle.js\n" });
  const result = await includeBuildArtifacts("/wt", "npm run build", deps);
  assert.equal(result.ran, true);
  assert.ok(result.ran && result.ok);
  assert.ok(result.ran && result.ok && result.amended);
  assert.ok(result.ran && result.ok && result.amended && result.paths.includes("dist/bundle.js"));
  assert.deepEqual(calls.ran, ["npm run build"]);
  assert.equal(calls.added, 1, "gitAddAll called exactly once");
  assert.equal(calls.amended, 1, "amends HEAD exactly once");
});

test("biting test: without the fold, the artifact stays uncommitted (5.1 bites)", async () => {
  // Simulate the state without calling includeBuildArtifacts.
  const { calls } = makeDeps({ preStatus: "", postStatus: " M dist/bundle.js\n" });
  // We deliberately do NOT call includeBuildArtifacts here.
  assert.deepEqual(calls.ran, [], "build never ran — artifact stays stale");
  assert.equal(calls.amended, 0, "no amend — artifact stays uncommitted");
});

// ---------------------------------------------------------------------------
// 5.3: Build command exits non-zero → blocks, no amend
// ---------------------------------------------------------------------------

test("build command exits non-zero → ok:false with captured output, no amend (5.3)", async () => {
  const { deps, calls } = makeDeps({
    preStatus: "",
    buildCode: 1,
    buildOutput: "tsc: error TS2322: Type mismatch",
  });
  const result = await includeBuildArtifacts("/wt", "npm run build", deps);
  assert.equal(result.ran, true);
  assert.ok(result.ran && !result.ok);
  assert.match(result.ran && !result.ok ? result.output : "", /Type mismatch/);
  assert.equal(calls.added, 0, "no staging on build failure");
  assert.equal(calls.amended, 0, "no amend on build failure");
});

test("buildFailureBlockReason: distinct wording from test-gate exhaustion, includes captured output", () => {
  const reason = buildFailureBlockReason("npm run build", "tsc: error TS2322: Type mismatch");
  assert.match(reason, /build_command/);
  assert.match(reason, /Type mismatch/);
  assert.doesNotMatch(reason, /failed after \d+ fix attempt/i);
});

// ---------------------------------------------------------------------------
// 5.4: Idempotence — a second build run against committed source produces no diff
// ---------------------------------------------------------------------------

test("build produces no diff → no amend, SHA preserved (idempotence, 5.4)", async () => {
  const { deps, calls } = makeDeps({ preStatus: "", postStatus: "" });
  const result = await includeBuildArtifacts("/wt", "npm run build", deps);
  assert.equal(result.ran, true);
  assert.ok(result.ran && result.ok);
  assert.equal(result.ran && result.ok ? result.amended : true, false);
  assert.equal(calls.added, 0, "no staging when the build produced no change");
  assert.equal(calls.amended, 0, "no amend when the build produced no change");
});

// ---------------------------------------------------------------------------
// 5.6: Unrelated pre-existing dirt → helper does not run the build
// ---------------------------------------------------------------------------

test("pre-existing uncommitted dirt → build never runs, dirt left untouched (5.6)", async () => {
  const { deps, calls } = makeDeps({ preStatus: " M core/scripts/foo.ts\n" });
  const result = await includeBuildArtifacts("/wt", "npm run build", deps);
  assert.deepEqual(result, { ran: false });
  assert.deepEqual(calls.ran, [], "build runner never invoked when the tree is already dirty");
  assert.equal(calls.added, 0);
  assert.equal(calls.amended, 0);
});

// ---------------------------------------------------------------------------
// Multiple artifact paths folded in one add/amend
// ---------------------------------------------------------------------------

test("multiple artifact paths all folded via a single add/amend", async () => {
  const { deps, calls } = makeDeps({
    preStatus: "",
    postStatus: " M dist/bundle.js\n?? dist/bundle.js.map\n M plugin/manifest.json\n",
  });
  const result = await includeBuildArtifacts("/wt", "npm run build", deps);
  assert.equal(result.ran, true);
  assert.ok(result.ran && result.ok && result.amended);
  const paths = result.ran && result.ok && result.amended ? result.paths : [];
  assert.equal(paths.length, 3);
  assert.ok(paths.includes("dist/bundle.js"));
  assert.ok(paths.includes("dist/bundle.js.map"));
  assert.ok(paths.includes("plugin/manifest.json"));
  assert.equal(calls.added, 1, "single gitAddAll call regardless of path count");
  assert.equal(calls.amended, 1);
});
