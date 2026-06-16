// Test/build gate (#15): command detection, override parsing, the real spawn
// wiring, and the bounded generate→test→fix loop (with injected stubs).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectTestCommand,
  enforceTestFixCommitFormat,
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
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
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
 *  tree clean, commit format passes) so the loop keeps iterating. */
function cleanGitDeps(): Pick<TestGateDeps, "gitHead" | "gitDirty" | "verifyTestFix"> {
  let n = 0;
  return {
    gitHead: async () => `head-${n++}`,
    gitDirty: async () => false,
    verifyTestFix: async () => ({ ok: true }),
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

test("detect: echo && real-command is NOT treated as stub", () => {
  // Regression for finding #2: `echo "..." && vitest` must not be skipped
  const dir = scaffold({
    "package.json": JSON.stringify({
      scripts: { test: 'echo "running tests" && vitest' },
    }),
  });
  assert.deepEqual(detectTestCommand(dir), { cmd: "npm", args: ["run", "test"] });
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
// Shell-operator regression tests (#173, #174): configured command runs via
// `bash -c "set -o pipefail; …"` — operators work and piped failures surface.
// ---------------------------------------------------------------------------

test("gate (#173 regression): configured command with && passes when both steps succeed", async () => {
  // Proves `&&` is interpreted by the shell, not passed as a literal arg to the
  // first program. Uses real process spawn (no runTests stub).
  const out = await runTestGate(cfgWith({ command: "true && true" }), 173, tmpRoot, {
    ...cleanGitDeps(),
  });
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 0);
});

test("gate (#173 regression): configured command with && fails when first step fails", async () => {
  // Proves shell short-circuit: false exits non-zero, && stops, gate reports failure.
  const out = await runTestGate(
    cfgWith({ command: "false && true", max_attempts: 0 }),
    173,
    tmpRoot,
    { ...cleanGitDeps() },
  );
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 0);
});

test("gate (#174 regression): piped command fails the gate when an early stage fails (pipefail)", async () => {
  // `false | true`: the first stage fails. Without `set -o pipefail` the shell
  // returns only the LAST stage's status (true → 0) and the gate would falsely
  // pass, masking a broken step (#174). With pipefail the pipeline exits
  // non-zero and the gate must block. Real process spawn (no runTests stub).
  const out = await runTestGate(
    cfgWith({ command: "false | true", max_attempts: 0 }),
    174,
    tmpRoot,
    { ...cleanGitDeps() },
  );
  assert.equal(out.passed, false, "a failing early pipeline stage must fail the gate under pipefail");
  assert.equal(out.attempts, 0);
});

test("gate (#174 regression): piped command passes when every stage succeeds", async () => {
  // pipefail must not break the common case: every stage exits 0 → gate passes.
  const out = await runTestGate(cfgWith({ command: "true | true" }), 174, tmpRoot, {
    ...cleanGitDeps(),
  });
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 0);
});

test("gate (#173 regression): shell-backed configured command passes killProcessGroup=true to runTests", async () => {
  // Shell-wrapped commands spawn descendants (npm, pnpm, test runners). On timeout,
  // only the shell PID is killed unless killProcessGroup is true. Verify the gate
  // threads killProcessGroup=true through to runTests when test_gate.command is set.
  let capturedKillProcessGroup: boolean | undefined;
  await runTestGate(cfgWith({ command: "true" }), 173, "/wt", {
    runTests: async (_cwd, _command, _timeout, killProcessGroup) => {
      capturedKillProcessGroup = killProcessGroup;
      return passResult;
    },
    ...cleanGitDeps(),
  });
  assert.equal(capturedKillProcessGroup, true, "shell-backed command must use killProcessGroup");
});

test("gate (#173 regression): auto-detected command passes killProcessGroup=false to runTests", async () => {
  // Auto-detected commands spawn the binary directly (no shell); descendants are
  // not an issue, so killProcessGroup must remain false.
  let capturedKillProcessGroup: boolean | undefined;
  await runTestGate(cfgWith({}), 173, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async (_cwd, _command, _timeout, killProcessGroup) => {
      capturedKillProcessGroup = killProcessGroup;
      return passResult;
    },
    ...cleanGitDeps(),
  });
  assert.equal(capturedKillProcessGroup, false, "auto-detected command must not use killProcessGroup");
});

test("gate (#173 regression): whitespace-only configured command blocks immediately, never runs the shell", async () => {
  // Regression for review-2 finding: a whitespace-only body exits 0 (empty shell
  // script). It must be caught before spawn and block the gate.
  let ran = false;
  const out = await runTestGate(cfgWith({ command: "   " }), 173, "/wt", {
    runTests: async () => {
      ran = true;
      return passResult;
    },
    ...cleanGitDeps(),
  });
  assert.equal(ran, false, "runTests must not be called for whitespace-only command");
  assert.equal(out.skipped, false);
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 0);
  assert.match(out.blockReason ?? "", /empty or whitespace-only/);
});

test("gate (#173 regression): empty-string configured command blocks immediately, never falls back to auto-detect", async () => {
  // Regression for review-2 finding: `command: ""` is an explicit misconfiguration;
  // it must block rather than silently fall back to auto-detection with an empty label.
  let detectCalled = false;
  let ran = false;
  const out = await runTestGate(cfgWith({ command: "" }), 173, "/wt", {
    detectTestCommand: () => {
      detectCalled = true;
      return { cmd: "npm", args: ["test"] };
    },
    runTests: async () => {
      ran = true;
      return passResult;
    },
    ...cleanGitDeps(),
  });
  assert.equal(detectCalled, false, "auto-detection must not run for explicitly-set empty command");
  assert.equal(ran, false, "runTests must not be called for empty command");
  assert.equal(out.skipped, false);
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 0);
  assert.match(out.blockReason ?? "", /empty or whitespace-only/);
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

test("gate: dirty worktree before initial run → blocked at attempts 0 (no fix invoked)", async () => {
  // Regression for finding #1: gate must check clean state before the first run,
  // not only after a fix attempt.
  let invoked = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => passResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    gitDirty: async () => true, // dirty from the start
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 0);
  assert.equal(invoked, 0);
  assert.match(out.blockReason ?? "", /uncommitted/i);
});

test("gate: fix harness leaves tree dirty without committing → blocked immediately", async () => {
  // gitDirty returns false on the initial check so the first test run proceeds,
  // then returns true after the fix attempt to simulate uncommitted leftovers.
  let invoked = 0;
  let dirtyCall = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => failResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    gitDirty: async () => {
      dirtyCall++;
      return dirtyCall > 1; // clean on initial check, dirty after the fix
    },
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 1);
  assert.equal(invoked, 1);
  assert.match(out.blockReason ?? "", /uncommitted/i);
});

test("gate (regression / finding #1, post-pass): initial pass that leaves tree dirty → blocked at attempts 0", async () => {
  // Regression: test command exits 0 but generates uncommitted artifacts
  // (snapshots, tsbuildinfo, lock-file updates). The gate must block even though
  // the command itself succeeded, because committed state ≠ tested state.
  let invoked = 0;
  let dirtyCall = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => passResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    gitDirty: async () => {
      dirtyCall++;
      return dirtyCall > 1; // clean on pre-test check, dirty after the passing run
    },
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 0);
  assert.equal(invoked, 0);
  assert.match(out.blockReason ?? "", /generated artifacts|committed state/i);
});

test("gate (regression / finding #1, post-fix-pass): post-fix pass that leaves tree dirty → blocked", async () => {
  // Regression: test command passes after a fix attempt but leaves uncommitted
  // artifacts. Must block even though the re-run succeeded.
  let n = 0;
  let invoked = 0;
  let dirtyCall = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => (n++ === 0 ? failResult : passResult),
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    gitDirty: async () => {
      dirtyCall++;
      // call 1: pre-test check → clean
      // call 2: post-fix dirty check → clean (harness committed its changes)
      // call 3: post-pass dirty check → dirty (re-run generated artifacts)
      return dirtyCall > 2;
    },
  });
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 1);
  assert.equal(invoked, 1);
  assert.match(out.blockReason ?? "", /generated artifacts|committed state/i);
});

test("gate (regression / finding #1): dirty state after fix always blocks, regardless of HEAD movement", async () => {
  // Previously only blocked when HEAD did NOT move. Now the dirty check is
  // unconditional — even if the fix harness committed something, leftover
  // uncommitted changes must block the gate.
  let invoked = 0;
  let dirtyCall = 0;
  const out = await runTestGate(cfgWith({}), 1, "/wt", {
    detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
    runTests: async () => failResult,
    invoke: async () => {
      invoked++;
      return okInvoke();
    },
    gitDirty: async () => {
      dirtyCall++;
      return dirtyCall > 1; // clean on initial check, dirty after fix
    },
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

test("gate (regression / #48, CI parity): explicit CI command fails on second step → gate blocks", async () => {
  // Models the #45 scenario: npm test passes locally, but the CI-only step
  // (build.mjs --check, plugin-mirror sync) would fail on a stale artifact.
  // With test_gate.command: "npm run ci", the gate runs the full CI command and
  // must block even though npm test alone would have passed.
  let seenCommand: ParsedCommand | null = null;
  const out = await runTestGate(cfgWith({ command: "npm run ci", max_attempts: 1 }), 48, "/wt", {
    runTests: async (_cwd, command) => {
      seenCommand = command;
      return { passed: false, output: "Error: plugin mirror out of sync with core/", durationSec: 1 };
    },
    invoke: async () => okInvoke(),
    ...cleanGitDeps(),
  });
  // Gate must use the configured command wrapped in `bash -c` with pipefail
  // (not auto-detect, not tokenized).
  assert.deepEqual(seenCommand, { cmd: "bash", args: ["-c", "set -o pipefail\nnpm run ci"] });
  // Gate blocks: full CI command failed
  assert.equal(out.passed, false);
  assert.match(out.blockReason ?? "", /plugin mirror/i);
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
  assert.deepEqual(seen, { cmd: "bash", args: ["-c", "set -o pipefail\npnpm run test:ci"] });
  assert.equal(out.passed, true);
});

// ---------------------------------------------------------------------------
// Traceability trailer enforcement on fix-harness commits (#20)
// ---------------------------------------------------------------------------

const FIXED_RUN_ID = "1/2026-06-08T14:32:00Z";

test("gate (regression / #20, trailer enforcement): fix harness creates commit without trailers → blocked", async () => {
  // The harness "succeeds" and leaves a clean tree, but the commit it produced
  // has no Issue: or Pipeline-Run: trailers. The gate must block.
  let invoked = 0;
  const out = await runTestGate(
    cfgWith({}),
    1,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => failResult,
      invoke: async () => {
        invoked++;
        return okInvoke();
      },
      gitHead: async () => "head-before",
      gitDirty: async () => false,
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => ["fix: correct the test\n\nNo trailers here."],
    },
    FIXED_RUN_ID,
  );
  assert.equal(out.passed, false);
  assert.equal(invoked, 1);
  assert.match(out.blockReason ?? "", /trailers/i);
});

test("gate (regression / #20, trailer enforcement): fix harness creates commit with correct trailers → allowed", async () => {
  // Harness succeeds, commit has both required trailers → gate continues.
  let n = 0;
  const out = await runTestGate(
    cfgWith({}),
    1,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => (n++ === 0 ? failResult : passResult),
      invoke: async () => okInvoke(),
      gitHead: async () => "head-before",
      gitDirty: async () => false,
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [
        `fix: correct the test\n\nIssue: #1\nPipeline-Run: ${FIXED_RUN_ID}`,
      ],
    },
    FIXED_RUN_ID,
  );
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 1);
});

test("gate (regression / #20, trailer enforcement): no new commits after fix → not blocked on trailers", async () => {
  // Harness succeeds, tree clean, but made no commits (messages []) → trailer
  // validation passes since there are no commits to validate.
  let n = 0;
  const out = await runTestGate(
    cfgWith({}),
    1,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => (n++ === 0 ? failResult : passResult),
      invoke: async () => okInvoke(),
      gitHead: async () => "head-before",
      gitDirty: async () => false,
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [],
    },
    FIXED_RUN_ID,
  );
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 1);
});

test("gate (regression / #20, trailer enforcement): multiple fix commits, one missing trailers → blocked", async () => {
  // Two commits: the first compliant, the second not. Gate must block.
  let invoked = 0;
  const out = await runTestGate(
    cfgWith({}),
    1,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => failResult,
      invoke: async () => {
        invoked++;
        return okInvoke();
      },
      gitHead: async () => "head-before",
      gitDirty: async () => false,
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [
        `fix: first\n\nIssue: #1\nPipeline-Run: ${FIXED_RUN_ID}`,
        "fix: second\n\nNo trailers.",
      ],
    },
    FIXED_RUN_ID,
  );
  assert.equal(out.passed, false);
  assert.equal(invoked, 1);
  assert.match(out.blockReason ?? "", /trailers/i);
});

// ---------------------------------------------------------------------------
// Uncommitted-work salvage in the test-fix loop (#131)
// ---------------------------------------------------------------------------

test("gate (#131): fix harness edits but doesn't commit → salvage runs, tests re-run and pass", async () => {
  let runs = 0;
  let dirty = false;
  const salvageCalls: string[] = [];
  const out = await runTestGate(
    cfgWith({}),
    42,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => (runs++ === 0 ? failResult : passResult),
      invoke: async () => {
        dirty = true; // the harness edited the worktree without committing
        return okInvoke();
      },
      gitHead: async () => "h0", // HEAD never advances: no harness commit
      gitDirty: async () => dirty,
      salvage: async (_wt, _issue, _run, stageLabel) => {
        salvageCalls.push(stageLabel);
        dirty = false; // salvage committed the leftover work
        return true;
      },
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [],
    },
    "42/2026-06-12T18:14:44Z",
  );
  assert.equal(out.passed, true);
  assert.equal(out.attempts, 1);
  assert.equal(salvageCalls.length, 1);
  assert.match(salvageCalls[0], /test-fix/);
  assert.match(
    salvageCalls[0],
    /fix: resolve test\/build failures \(#42\)/,
    "stage label carries the prescribed subject for the format gate",
  );
});

test("gate (#131, bites): salvage that salvages nothing → dirty block exactly as before", async () => {
  // Same scenario, but the salvage no-ops (pre-#131 behavior): the leftover
  // work stays uncommitted and the existing dirty block must fire.
  let dirty = false;
  const out = await runTestGate(
    cfgWith({}),
    42,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => failResult,
      invoke: async () => {
        dirty = true;
        return okInvoke();
      },
      gitHead: async () => "h0",
      gitDirty: async () => dirty,
      salvage: async () => false,
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [],
    },
    "42/2026-06-12T18:14:44Z",
  );
  assert.equal(out.passed, false);
  assert.match(out.blockReason ?? "", /Fix harness left uncommitted changes/);
});

test("gate (#131): salvaged but tests still fail → blocked with the test-gate reason", async () => {
  // Salvage never bypasses validation: a broken salvaged change exhausts the
  // fix attempts and blocks with the captured test output.
  let dirty = false;
  let salvaged = 0;
  const out = await runTestGate(
    cfgWith({ max_attempts: 1 }),
    42,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => failResult,
      invoke: async () => {
        dirty = true;
        return okInvoke();
      },
      gitHead: async () => "h0",
      gitDirty: async () => dirty,
      salvage: async () => {
        salvaged++;
        dirty = false;
        return true;
      },
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [],
    },
    "42/2026-06-12T18:14:44Z",
  );
  assert.equal(salvaged, 1);
  assert.equal(out.passed, false);
  assert.equal(out.attempts, 1);
  assert.match(out.blockReason ?? "", /FAIL: 1 test failed/);
});

test("gate (#131): clean worktree with no commit → salvage not attempted, no-commit block unchanged", async () => {
  const salvageCalls: string[] = [];
  const out = await runTestGate(
    cfgWith({}),
    42,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => failResult,
      invoke: async () => okInvoke(),
      gitHead: async () => "h0",
      gitDirty: async () => false, // genuinely empty harness run
      salvage: async (_wt, _issue, _run, stageLabel) => {
        salvageCalls.push(stageLabel);
        return true;
      },
      // Real format gate over an empty range → the existing no-commit block.
      verifyTestFix: (wt, hb) =>
        enforceTestFixCommitFormat(42, wt, hb, {
          gitMessages: async () => [],
          gitDiffFiles: async () => [],
          gitDirtyFiles: async () => [],
        }),
      gitCommitMessages: async () => [],
    },
    "42/2026-06-12T18:14:44Z",
  );
  assert.equal(salvageCalls.length, 0, "clean worktree must not attempt salvage");
  assert.equal(out.passed, false);
  assert.match(out.blockReason ?? "", /No commits found in the range/);
});

test("gate (#131): harness committed AND left dirt → salvage not attempted, dirty block unchanged", async () => {
  let head = 0;
  let dirtyCalls = 0;
  const salvageCalls: string[] = [];
  const out = await runTestGate(
    cfgWith({}),
    42,
    "/wt",
    {
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      runTests: async () => failResult,
      invoke: async () => okInvoke(),
      gitHead: async () => `h${head++}`, // HEAD advances: the harness committed
      gitDirty: async () => dirtyCalls++ > 0, // clean pre-gate, dirty after the fix
      salvage: async (_wt, _issue, _run, stageLabel) => {
        salvageCalls.push(stageLabel);
        return true;
      },
      verifyTestFix: async () => ({ ok: true }),
      gitCommitMessages: async () => [],
    },
    "42/2026-06-12T18:14:44Z",
  );
  assert.equal(salvageCalls.length, 0, "salvage applies only to the no-new-commit case");
  assert.equal(out.passed, false);
  assert.match(out.blockReason ?? "", /Fix harness left uncommitted changes/);
});
