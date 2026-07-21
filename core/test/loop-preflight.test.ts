// Tests for the pipeline:loop deterministic preflight (#451): the shared
// loop:contract-coherence check, the native-/goal capability check, argument
// normalization, and the fixed-order runLoopPreflight. Every check runs
// through the injectable DoctorDeps seam — no real filesystem, network, or
// subprocess call.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS,
  GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS,
  checkLoopContractCoherence,
  checkNativeGoalCapability,
  discoverGoalLoop,
  goalLoopDiscoveryRoots,
  normalizeLoopArgs,
  runLoopPreflight,
  LoopArgError,
  type RawLoopArgs,
} from "../scripts/loop-preflight.ts";
import type { DoctorDeps, ExecResult } from "../scripts/stages/doctor.ts";

const ROOTS = ["/fake/claude/skills/goal-loop", "/fake/codex/skills/goal-loop"];

interface FakeOverrides {
  execCheck?: (file: string, args: string[]) => boolean;
  exec?: (file: string, args: string[]) => ExecResult;
  fsExists?: (p: string) => boolean;
  readTextFile?: (p: string) => string | null;
}

function fakeDeps(o: FakeOverrides = {}): DoctorDeps {
  return {
    exec: async (f, a) => (o.exec ? o.exec(f, a) : { ok: true, stdout: "", stderr: "" }),
    execCheck: async (f, a) => (o.execCheck ? o.execCheck(f, a) : true),
    fsExists: async (p) => (o.fsExists ? o.fsExists(p) : false),
    fileMtime: async () => 1000,
    readTextFile: async (p) => (o.readTextFile ? o.readTextFile(p) : null),
  };
}

const MANIFEST_OK = '{"package":"goal-loop","version":"0.2.0"}';
const STATE_PY_OK = 'CONTRACT_SCHEMA = "goal-loop/contract@2"\nLEDGER_SCHEMA = "goal-loop/ledger@2"\n';

/** A discoverable, fully-compatible goal-loop install at ROOTS[0]. */
function compatibleDeps(overrides: FakeOverrides = {}): DoctorDeps {
  return fakeDeps({
    fsExists: (p) => p === `${ROOTS[0]}/.goal-loop-manifest.json`,
    readTextFile: (p) => {
      if (p === `${ROOTS[0]}/.goal-loop-manifest.json`) return MANIFEST_OK;
      if (p === `${ROOTS[0]}/state.py`) return STATE_PY_OK;
      return null;
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// discoverGoalLoop
// ---------------------------------------------------------------------------

test("discoverGoalLoop — returns null when no candidate root has a manifest", async () => {
  const result = await discoverGoalLoop(fakeDeps(), ROOTS);
  assert.equal(result, null);
});

test("discoverGoalLoop — finds the first candidate root with a manifest and reads schema ids", async () => {
  const result = await discoverGoalLoop(compatibleDeps(), ROOTS);
  assert.ok(result);
  assert.equal(result!.root, ROOTS[0]);
  assert.equal(result!.manifest.version, "0.2.0");
  assert.equal(result!.contractSchema, "goal-loop/contract@2");
  assert.equal(result!.ledgerSchema, "goal-loop/ledger@2");
});

test("discoverGoalLoop — falls back to the second candidate root", async () => {
  const deps = fakeDeps({
    fsExists: (p) => p === `${ROOTS[1]}/.goal-loop-manifest.json`,
    readTextFile: (p) => {
      if (p === `${ROOTS[1]}/.goal-loop-manifest.json`) return MANIFEST_OK;
      if (p === `${ROOTS[1]}/state.py`) return STATE_PY_OK;
      return null;
    },
  });
  const result = await discoverGoalLoop(deps, ROOTS);
  assert.equal(result?.root, ROOTS[1]);
});

// ---------------------------------------------------------------------------
// goalLoopDiscoveryRoots — engine-aware discovery (#451 review 2, finding 1)
// ---------------------------------------------------------------------------

test("goalLoopDiscoveryRoots — with no engine, checks both hosts (Claude first)", () => {
  const roots = goalLoopDiscoveryRoots(undefined, {});
  assert.equal(roots.length, 3);
  assert.match(roots[0], /\.claude[/\\]skills[/\\]goal-loop$/);
  assert.match(roots[1], /\.codex[/\\]skills[/\\]goal-loop$/);
});

test("goalLoopDiscoveryRoots — claude engine only discovers the Claude store (plus shared)", () => {
  const roots = goalLoopDiscoveryRoots("claude", {});
  assert.equal(roots.length, 2);
  assert.ok(roots.every((r) => !/\.codex[/\\]skills[/\\]goal-loop$/.test(r)));
  assert.match(roots[0], /\.claude[/\\]skills[/\\]goal-loop$/);
});

test("goalLoopDiscoveryRoots — codex engine only discovers the Codex store (plus shared)", () => {
  const roots = goalLoopDiscoveryRoots("codex", {});
  assert.equal(roots.length, 2);
  assert.ok(roots.every((r) => !/\.claude[/\\]skills[/\\]goal-loop$/.test(r)));
  assert.match(roots[0], /\.codex[/\\]skills[/\\]goal-loop$/);
});

test("runLoopPreflight — codex engine does not fall back to a stale Claude-only install", async () => {
  // A compatible install exists ONLY under the Claude root; the active engine is codex.
  // Per finding 1, this must fail closed (goal-loop undiscoverable for codex) rather
  // than silently validating the unrelated Claude install.
  const env = { CLAUDE_CONFIG_DIR: "/home/user/.claude", CODEX_HOME: "/home/user/.codex" } as NodeJS.ProcessEnv;
  const claudeRoot = "/home/user/.claude/skills/goal-loop";
  const deps = fakeDeps({
    fsExists: (p) => p === `${claudeRoot}/.goal-loop-manifest.json`,
    readTextFile: (p) => {
      if (p === `${claudeRoot}/.goal-loop-manifest.json`) return MANIFEST_OK;
      if (p === `${claudeRoot}/state.py`) return STATE_PY_OK;
      return null;
    },
  });
  const codexRoots = goalLoopDiscoveryRoots("codex", env);
  assert.ok(!codexRoots.includes(claudeRoot), "codex-scoped roots must not include the Claude store");
  const outcome = await runLoopPreflight({ milestone: "v2" }, "codex", deps, codexRoots);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failedCheck, "loop:contract-coherence");
});

// ---------------------------------------------------------------------------
// checkLoopContractCoherence — the shared check (doctor scenarios)
// ---------------------------------------------------------------------------

test("checkLoopContractCoherence — supported install passes, detail includes version and schema id", async () => {
  const r = await checkLoopContractCoherence(compatibleDeps(), ROOTS);
  assert.equal(r.status, "pass");
  assert.match(r.detail, /0\.2\.0/);
  assert.match(r.detail, /goal-loop\/contract@2/);
});

test("checkLoopContractCoherence — goal-loop absent fails with install remediation", async () => {
  const r = await checkLoopContractCoherence(fakeDeps(), ROOTS);
  assert.equal(r.status, "fail");
  assert.match(r.remediation ?? "", /install/i);
  assert.match(r.remediation ?? "", /goal-loop/i);
});

test("checkLoopContractCoherence — unsupported (older) contract schema fails naming both sides", async () => {
  const deps = compatibleDeps({
    readTextFile: (p) => {
      if (p === `${ROOTS[0]}/.goal-loop-manifest.json`) return MANIFEST_OK;
      if (p === `${ROOTS[0]}/state.py`) {
        return 'CONTRACT_SCHEMA = "goal-loop/contract@1"\nLEDGER_SCHEMA = "goal-loop/ledger@1"\n';
      }
      return null;
    },
  });
  const r = await checkLoopContractCoherence(deps, ROOTS);
  assert.equal(r.status, "fail");
  assert.match(r.detail, /goal-loop\/contract@1/);
  assert.match(r.detail, new RegExp(GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS[0].replace(/[/@]/g, "\\$&")));
  assert.match(r.remediation ?? "", /align/i);
});

test("checkLoopContractCoherence — newer-than-supported contract also fails (no optimistic pass)", async () => {
  const deps = compatibleDeps({
    readTextFile: (p) => {
      if (p === `${ROOTS[0]}/.goal-loop-manifest.json`) return MANIFEST_OK;
      if (p === `${ROOTS[0]}/state.py`) {
        return 'CONTRACT_SCHEMA = "goal-loop/contract@3"\nLEDGER_SCHEMA = "goal-loop/ledger@2"\n';
      }
      return null;
    },
  });
  const r = await checkLoopContractCoherence(deps, ROOTS);
  assert.equal(r.status, "fail");
  assert.match(r.detail, /goal-loop\/contract@3/);
});

test("checkLoopContractCoherence — unreadable manifest fails", async () => {
  const deps = compatibleDeps({
    readTextFile: (p) => {
      if (p === `${ROOTS[0]}/.goal-loop-manifest.json`) return "not json {{{";
      if (p === `${ROOTS[0]}/state.py`) return STATE_PY_OK;
      return null;
    },
  });
  const r = await checkLoopContractCoherence(deps, ROOTS);
  assert.equal(r.status, "fail");
});

test("GOAL_LOOP_SUPPORTED_*_SCHEMAS pin the verified schema ids", () => {
  assert.deepEqual([...GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS], ["goal-loop/contract@2"]);
  assert.deepEqual([...GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS], ["goal-loop/ledger@2"]);
});

// ---------------------------------------------------------------------------
// checkNativeGoalCapability
// ---------------------------------------------------------------------------

test("checkNativeGoalCapability — passes when the engine's --help advertises /goal", async () => {
  const deps = fakeDeps({ exec: () => ({ ok: true, stdout: "Usage: claude [options]\n  /goal   run autonomous goal mode\n", stderr: "" }) });
  const r = await checkNativeGoalCapability(deps, "claude");
  assert.equal(r.status, "pass");
});

test("checkNativeGoalCapability — fails naming the engine when not advertised", async () => {
  const deps = fakeDeps({ exec: () => ({ ok: true, stdout: "Usage: codex [options]\n", stderr: "" }) });
  const r = await checkNativeGoalCapability(deps, "codex");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /codex/);
  assert.match(r.remediation ?? "", /codex/i);
});

test("checkNativeGoalCapability — fails when the binary itself is unavailable", async () => {
  const deps = fakeDeps({ exec: () => ({ ok: false, stdout: "", stderr: "not found" }) });
  const r = await checkNativeGoalCapability(deps, "claude");
  assert.equal(r.status, "fail");
});

// ---------------------------------------------------------------------------
// normalizeLoopArgs — pure argument normalization
// ---------------------------------------------------------------------------

test("normalizeLoopArgs — milestone selector", () => {
  const args = normalizeLoopArgs({ milestone: "v2" });
  assert.deepEqual(args.selector, { type: "milestone", value: "v2" });
  assert.equal(args.audit, false);
});

test("normalizeLoopArgs — label selector", () => {
  const args = normalizeLoopArgs({ label: ["backlog"] });
  assert.deepEqual(args.selector, { type: "label", value: "backlog" });
});

test("normalizeLoopArgs — range selector normalizes to work-list", () => {
  const args = normalizeLoopArgs({ range: "418-420" });
  assert.deepEqual(args.selector, { type: "work-list", value: ["418", "419", "420"] });
});

test("normalizeLoopArgs — rejects a malformed range", () => {
  assert.throws(() => normalizeLoopArgs({ range: "not-a-range" }), LoopArgError);
});

test("normalizeLoopArgs — rejects a range whose start exceeds its end", () => {
  assert.throws(() => normalizeLoopArgs({ range: "420-418" }), LoopArgError);
});

test("normalizeLoopArgs — rejects a repeated --label selector", () => {
  assert.throws(() => normalizeLoopArgs({ label: ["security", "backlog"] }), LoopArgError);
});

test("normalizeLoopArgs — roadmap-slice selector", () => {
  const args = normalizeLoopArgs({ roadmapSlice: "next" });
  assert.deepEqual(args.selector, { type: "roadmap-slice", value: "next" });
});

test("normalizeLoopArgs — explicit issue list selector", () => {
  const args = normalizeLoopArgs({ issues: ["418", "419", "420"] });
  assert.deepEqual(args.selector, { type: "work-list", value: ["418", "419", "420"] });
});

test("normalizeLoopArgs — rejects a non-numeric issue in the explicit list", () => {
  assert.throws(() => normalizeLoopArgs({ issues: ["abc"] }), LoopArgError);
});

test("normalizeLoopArgs — resume selector", () => {
  const args = normalizeLoopArgs({ resume: "run-123" });
  assert.equal(args.resumeRunId, "run-123");
  assert.equal(args.selector, undefined);
});

test("normalizeLoopArgs — audit combined with a selector", () => {
  const args = normalizeLoopArgs({ milestone: "v2", audit: true });
  assert.equal(args.audit, true);
  assert.deepEqual(args.selector, { type: "milestone", value: "v2" });
});

test("normalizeLoopArgs — audit combined with resume", () => {
  const args = normalizeLoopArgs({ resume: "run-123", audit: true });
  assert.equal(args.audit, true);
  assert.equal(args.resumeRunId, "run-123");
});

test("normalizeLoopArgs — rejects a selector combined with --resume", () => {
  assert.throws(() => normalizeLoopArgs({ milestone: "v2", resume: "run-123" }), LoopArgError);
});

test("normalizeLoopArgs — rejects more than one selector form", () => {
  assert.throws(() => normalizeLoopArgs({ milestone: "v2", range: "1-2" }), LoopArgError);
});

test("normalizeLoopArgs — rejects no selector and no --resume", () => {
  assert.throws(() => normalizeLoopArgs({}), LoopArgError);
});

test("normalizeLoopArgs — standalone audit (no selector, no resume) is accepted read-only", () => {
  const args = normalizeLoopArgs({ audit: true });
  assert.equal(args.audit, true);
  assert.equal(args.selector, undefined);
  assert.equal(args.resumeRunId, undefined);
});

// ---------------------------------------------------------------------------
// runLoopPreflight — fixed order, zero I/O on invalid args
// ---------------------------------------------------------------------------

test("runLoopPreflight — selector-free --audit skips the native-goal gate (#451 delta ac3bdbd2)", async () => {
  // Audit is a read-only report on an existing canonical run: it must work on
  // hosts whose engine lacks native /goal support.
  const deps = compatibleDeps({
    exec: () => ({ ok: true, stdout: "Usage: claude [options]\n", stderr: "" }), // no /goal advertised
  });
  const outcome = await runLoopPreflight({ audit: true }, "claude", deps, ROOTS);
  assert.equal(outcome.ok, true);
  assert.equal((outcome as { args: { audit: boolean } }).args.audit, true);
});

test("runLoopPreflight — --audit combined with a selector still requires native-goal (#451 delta ac3bdbd2)", async () => {
  const deps = compatibleDeps({
    exec: () => ({ ok: true, stdout: "Usage: claude [options]\n", stderr: "" }),
  });
  const outcome = await runLoopPreflight({ milestone: "v2", audit: true }, "claude", deps, ROOTS);
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { failedCheck: string }).failedCheck, "native-goal");
});

test("normalizeLoopArgs — a --range spanning more than MAX_RANGE_SPAN issues is rejected before expansion (#451 delta 95357c6b)", () => {
  assert.throws(
    () => normalizeLoopArgs({ range: "1-99999999999" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopArgError);
      assert.match((err as Error).message, /maximum is 1000/);
      return true;
    },
  );
});

test("normalizeLoopArgs — a --range at exactly MAX_RANGE_SPAN issues expands", () => {
  const args = normalizeLoopArgs({ range: "1-1000" });
  assert.equal((args.selector as { value: string[] }).value.length, 1000);
});

test("normalizeLoopArgs — an unsafe equal-endpoint --range is rejected before span check (#451 review 1, finding dcb2a0a3)", () => {
  assert.throws(
    () => normalizeLoopArgs({ range: "9007199254740992-9007199254740992" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopArgError);
      assert.match((err as Error).message, /safe integers/);
      return true;
    },
  );
});

test("normalizeLoopArgs — a --range reaching an unsafe endpoint is rejected before span check (#451 review 1, finding dcb2a0a3)", () => {
  assert.throws(
    () => normalizeLoopArgs({ range: "9007199254740991-9007199254740992" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopArgError);
      assert.match((err as Error).message, /safe integers/);
      return true;
    },
  );
});

test("runLoopPreflight — invalid args short-circuit before any check runs (zero I/O)", async () => {
  let calls = 0;
  const deps = fakeDeps({
    exec: () => {
      calls++;
      return { ok: true, stdout: "", stderr: "" };
    },
    fsExists: () => {
      calls++;
      return false;
    },
    readTextFile: () => {
      calls++;
      return null;
    },
  });
  const outcome = await runLoopPreflight({}, "claude", deps, ROOTS);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failedCheck, "args");
  assert.equal(calls, 0, "no I/O primitive should be invoked when argument normalization fails");
});

test("runLoopPreflight — contract-coherence failure short-circuits before the native-goal check", async () => {
  let nativeGoalCalled = false;
  const deps = fakeDeps({
    exec: () => {
      nativeGoalCalled = true;
      return { ok: true, stdout: "/goal", stderr: "" };
    },
    fsExists: () => false, // goal-loop undiscoverable
  });
  const outcome = await runLoopPreflight({ milestone: "v2" }, "claude", deps, ROOTS);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.failedCheck, "loop:contract-coherence");
  assert.equal(nativeGoalCalled, false, "native-goal must not run once contract-coherence has failed");
});

test("runLoopPreflight — native-goal failure reported after a passing contract-coherence check", async () => {
  const deps = compatibleDeps({ exec: () => ({ ok: true, stdout: "no autonomous mode here", stderr: "" }) });
  const outcome = await runLoopPreflight({ milestone: "v2" }, "codex", deps, ROOTS);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.failedCheck, "native-goal");
    assert.match(outcome.detail, /codex/);
  }
});

test("runLoopPreflight — all checks pass returns the normalized args", async () => {
  const deps = compatibleDeps({ exec: () => ({ ok: true, stdout: "/goal autonomous mode", stderr: "" }) });
  const outcome = await runLoopPreflight({ resume: "run-abc" }, "claude", deps, ROOTS);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.args.resumeRunId, "run-abc");
});

test("runLoopPreflight — standalone audit passes through the same read-only DoctorDeps seam with no selector/resume", async () => {
  const deps = compatibleDeps({ exec: () => ({ ok: true, stdout: "/goal autonomous mode", stderr: "" }) });
  const outcome = await runLoopPreflight({ audit: true }, "claude", deps, ROOTS);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.args.audit, true);
    assert.equal(outcome.args.selector, undefined);
    assert.equal(outcome.args.resumeRunId, undefined);
  }
  // DoctorDeps exposes no write primitive (exec/execCheck/fsExists/fileMtime/readTextFile
  // are all reads), so a standalone audit run that only exercises this seam is read-only
  // by construction — it has no lock, ledger, or GitHub-mutation call available to make.
});
