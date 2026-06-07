// Test/build gate (#15): command detection, override parsing, the real spawn
// wiring, and the bounded generate→test→fix loop (with injected stubs).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectTestCommand,
  runTestGate,
  runTests,
  shellSplit,
  type ParsedCommand,
  type RunTestsResult,
  type TestGateDeps,
} from "../scripts/testgate.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-testgate-"));

function scaffold(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function cfgWith(testGate: Partial<PipelineConfig["test_gate"]>): PipelineConfig {
  return {
    profile_name: "codex",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "—",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_merge: false,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    test_gate: { enabled: true, max_attempts: 3, timeout: 300, ...testGate },
  };
}

function okInvoke(): HarnessResult {
  return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 1, timed_out: false };
}

/** Deps where every fix invocation looks like a clean commit (HEAD advances,
 *  tree clean) so the loop keeps iterating. */
function cleanGitDeps(): Pick<TestGateDeps, "gitHead" | "gitDirty"> {
  let n = 0;
  return {
    gitHead: async () => `head-${n++}`,
    gitDirty: async () => false,
  };
}

const passResult: RunTestsResult = { passed: true, output: "ok", durationSec: 1 };
const failResult: RunTestsResult = { passed: false, output: "FAIL: 1 test failed", durationSec: 1 };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("detect: package.json test script + pnpm lock → pnpm run test", () => {
  const dir = scaffold({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "pnpm-lock.yaml": "",
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "pnpm", args: ["run", "test"] });
});

test("detect: yarn lock selects yarn", () => {
  const dir = scaffold({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "yarn.lock": "",
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "yarn", args: ["run", "test"] });
});

test("detect: no lockfile defaults to npm", () => {
  const dir = scaffold({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
  assert.deepEqual(detectTestCommand(dir), { cmd: "npm", args: ["run", "test"] });
});

test("detect: npm placeholder/echo stub test script is ignored", () => {
  const dir = scaffold({
    "package.json": JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
  });
  assert.equal(detectTestCommand(dir), null);
});

test("detect: no test script falls back to build:check", () => {
  const dir = scaffold({
    "package.json": JSON.stringify({ scripts: { "build:check": "tsc --noEmit", build: "tsc" } }),
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "npm", args: ["run", "build:check"] });
});

test("detect: build fallback order prefers typecheck over build", () => {
  const dir = scaffold({
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "tsc" } }),
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "npm", args: ["run", "typecheck"] });
});

test("detect: go.mod → go test ./...", () => {
  const dir = scaffold({ "go.mod": "module x\n" });
  assert.deepEqual(detectTestCommand(dir), { cmd: "go", args: ["test", "./..."] });
});

test("detect: Cargo.toml → cargo test", () => {
  const dir = scaffold({ "Cargo.toml": "[package]\nname = \"x\"\n" });
  assert.deepEqual(detectTestCommand(dir), { cmd: "cargo", args: ["test"] });
});

test("detect: pyproject.toml alone is NOT enough for pytest", () => {
  const dir = scaffold({ "pyproject.toml": "[project]\nname = \"x\"\n" });
  assert.equal(detectTestCommand(dir), null);
});

test("detect: pyproject.toml + pytest.ini → pytest", () => {
  const dir = scaffold({ "pyproject.toml": "[project]\nname = \"x\"\n", "pytest.ini": "[pytest]\n" });
  assert.deepEqual(detectTestCommand(dir), { cmd: "pytest", args: [] });
});

test("detect: pyproject.toml with [tool.pytest.ini_options] → pytest", () => {
  const dir = scaffold({
    "pyproject.toml": "[project]\nname = \"x\"\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n",
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "pytest", args: [] });
});

test("detect: root conftest.py → pytest", () => {
  const dir = scaffold({ "conftest.py": "" });
  assert.deepEqual(detectTestCommand(dir), { cmd: "pytest", args: [] });
});

test("detect: Makefile with test target → make test", () => {
  const dir = scaffold({ "Makefile": "build:\n\tgo build\n\ntest:\n\tgo test ./...\n" });
  assert.deepEqual(detectTestCommand(dir), { cmd: "make", args: ["test"] });
});

test("detect: Makefile without a test target → null", () => {
  const dir = scaffold({ "Makefile": "build:\n\tgo build\n" });
  assert.equal(detectTestCommand(dir), null);
});

test("detect: empty dir → null", () => {
  const dir = scaffold({});
  assert.equal(detectTestCommand(dir), null);
});

test("detect: package.json wins over go.mod (precedence)", () => {
  const dir = scaffold({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "go.mod": "module x\n",
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "npm", args: ["run", "test"] });
});

// ---------------------------------------------------------------------------
// shellSplit
// ---------------------------------------------------------------------------

test("shellSplit: simple two-token command", () => {
  assert.deepEqual(shellSplit("npm test"), { cmd: "npm", args: ["test"] });
});

test("shellSplit: subcommand with colon", () => {
  assert.deepEqual(shellSplit("pnpm run test:ci"), { cmd: "pnpm", args: ["run", "test:ci"] });
});

test("shellSplit: single token", () => {
  assert.deepEqual(shellSplit("pytest"), { cmd: "pytest", args: [] });
});

test("shellSplit: double-quoted arg with spaces", () => {
  assert.deepEqual(shellSplit('pytest -k "unit tests"'), {
    cmd: "pytest",
    args: ["-k", "unit tests"],
  });
});

test("shellSplit: single-quoted arg with spaces", () => {
  assert.deepEqual(shellSplit("pytest -k 'unit tests'"), {
    cmd: "pytest",
    args: ["-k", "unit tests"],
  });
});

test("shellSplit: collapses runs of whitespace", () => {
  assert.deepEqual(shellSplit("  npm   run   test  "), { cmd: "npm", args: ["run", "test"] });
});

test("shellSplit: backslash escapes inside double quotes", () => {
  assert.deepEqual(shellSplit('echo "a\\"b"'), { cmd: "echo", args: ['a"b'] });
});

test("shellSplit: empty/whitespace-only string throws", () => {
  assert.throws(() => shellSplit("   "), /empty/);
});

// ---------------------------------------------------------------------------
// runTests — real spawn wiring (node is always available under `node --test`)
// ---------------------------------------------------------------------------

test("runTests: passing command → passed true", async () => {
  const res = await runTests(tmpRoot, { cmd: "node", args: ["-e", "process.exit(0)"] }, 30);
  assert.equal(res.passed, true);
});

test("runTests: failing command → passed false with output", async () => {
  const res = await runTests(
    tmpRoot,
    { cmd: "node", args: ["-e", "console.error('boom'); process.exit(1)"] },
    30,
  );
  assert.equal(res.passed, false);
  assert.match(res.output, /boom/);
});

// ---------------------------------------------------------------------------
// runTestGate — the bounded loop (injected stubs)
// ---------------------------------------------------------------------------

test("gate: disabled → skipped, never runs tests", async () => {
  let ran = false;
  const out = await runTestGate(cfgWith({ enabled: false }), 1, "/wt", {
    runTests: async () => {
      ran = true;
      return passResult;
    },
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
  });
  assert.deepEqual(out, { skipped: true });
  assert.equal(ran, false);
});

test("gate: no command detected → skipped", async () => {
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => null,
    runTests: async () => passResult,
  });
  assert.deepEqual(out, { skipped: true });
});

test("gate: initial run passes → attempts 0, no fix invoked", async () => {
  let invoked = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => passResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    ...cleanGitDeps(),
  });
  assert.equal(out.skipped, false);
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 0);
  assert.equal(invoked, 0);
});

test("gate: fail then fix then pass → attempts 1", async () => {
  let n = 0;
  let invoked = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => (n++ === 0 ? failResult : passResult),
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    ...cleanGitDeps(),
  });
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 1);
  assert.equal(invoked, 1);
});

test("gate: max_attempts 2, both post-fix fail → blocked with reason", async () => {
  let invoked = 0;
  const out = await runTestGate(cfgWith({ max_attempts: 2 }), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => failResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    ...cleanGitDeps(),
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 2);
  assert.equal(invoked, 2);
  assert.match(out.blockReason ?? "", /FAIL/);
});

test("gate (regression / core AC): max_attempts 3, always fail → exactly 3 fix invocations", async () => {
  let invoked = 0;
  const out = await runTestGate(cfgWith({ max_attempts: 3 }), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => failResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    ...cleanGitDeps(),
  });
  assert.equal(invoked, 3);
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 3);
});

test("gate: fix harness leaves tree dirty without committing → blocked immediately", async () => {
  let invoked = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => failResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    gitHead: async () => "same-sha", // HEAD never moves
    gitDirty: async () => true, // but the tree is dirty
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 1);
  assert.equal(invoked, 1);
  assert.match(out.blockReason ?? "", /uncommitted/i);
});

test("gate: fix harness itself fails → blocked with harness reason", async () => {
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => failResult,
    invoke: async () => ({
      success: false,
      stdout: "",
      stderr: "",
      exit_code: 2,
      duration: 5,
      timed_out: false,
    }),
    ...cleanGitDeps(),
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 1);
  assert.match(out.blockReason ?? "", /Fix harness/);
});

test("gate: huge failure output is truncated in blockReason", async () => {
  const huge = "x".repeat(20_000);
  const out = await runTestGate(cfgWith({ max_attempts: 1 }), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => ({ passed: false, output: huge, durationSec: 1 }),
    invoke: async () => okInvoke(),
    ...cleanGitDeps(),
  });
  assert.equal(out.passed, false);
  assert.match(out.blockReason ?? "", /output truncated/);
  assert.ok((out.blockReason ?? "").length < huge.length);
});

test("gate: explicit command override bypasses detection", async () => {
  let detectCalled = false;
  let seen: ParsedCommand | null = null;
  const out = await runTestGate(cfgWith({ command: "pnpm run test:ci" }), 1, "/wt", {
    detectTestCommand: () => {
      detectCalled = true;
      return { cmd: "npm", args: ["test"] };
    },
    runTests: async (_cwd, command) => {
      seen = command;
      return passResult;
    },
    ...cleanGitDeps(),
  });
  assert.equal(detectCalled, false);
  assert.deepEqual(seen, { cmd: "pnpm", args: ["run", "test:ci"] });
  assert.equal(out.passed, true);
});
