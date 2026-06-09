// Test/build gate (#15): run the target repo's own test/build command inside the
// worktree, and on failure drive a bounded generate→test→fix loop with the
// implementer harness until it passes or attempts are exhausted. A persistent
// failure blocks the item BEFORE a PR is opened (planning) or BEFORE it advances
// (fix rounds) — so broken changes never reach review. Repos with no detectable
// test/build command (and no explicit override) are skipped entirely.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  invoke as defaultInvoke,
  runCapped,
  type HarnessResult,
  type InvokeOptions,
} from "./harness.ts";
import { gitInWorktree } from "./worktree.ts";
import { buildTestFixPrompt } from "./prompts/index.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "./verify-harness-commits.ts";
import type { Harness, PipelineConfig } from "./types.ts";

/** A command split into program + argv — never a raw string at spawn time. */
export interface ParsedCommand {
  cmd: string;
  args: string[];
}

export interface RunTestsResult {
  passed: boolean;
  output: string;
  durationSec: number;
}

export interface TestGateResult {
  /** True when the gate did not run (disabled, or no command detected). */
  skipped: boolean;
  /** Whether the test/build command ultimately passed. Absent when skipped. */
  passed?: boolean;
  /** Number of fix-harness invocations performed (0 if it passed first try). */
  attempts?: number;
  /** Captured failure output / reason, set only when `passed` is false. */
  blockReason?: string;
}

/** Signature of the harness `invoke` — injectable so the loop is unit-testable. */
export type InvokeFn = (
  harness: Harness,
  worktreeDir: string,
  prompt: string,
  opts?: InvokeOptions,
) => Promise<HarnessResult>;

/** Seams overridable in tests; default to the real implementations in prod. */
export interface TestGateDeps {
  invoke?: InvokeFn;
  runTests?: (cwd: string, command: ParsedCommand, timeoutSec: number) => Promise<RunTestsResult>;
  detectTestCommand?: (repoDir: string) => ParsedCommand | null;
  gitHead?: (cwd: string) => Promise<string>;
  gitDirty?: (cwd: string) => Promise<boolean>;
  /** Verify commit message format after each test-fix attempt (#68). Injectable for tests. */
  verifyTestFix?: (wtPath: string, headBefore: string) => Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Test-fix commit format gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Verifies that at least one commit in `headBefore..HEAD` matches the expected
 * test-fix commit message format. Exported so tests can exercise the gate
 * without mocking the full `runTestGate` call chain.
 */
export async function enforceTestFixCommitFormat(
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(
    wtPath,
    headBefore,
    {
      messagePattern: {
        pattern: new RegExp(
          `fix:\\s+resolve test/build failures \\(#${issueNumber}\\)`,
          "i",
        ),
        description: "Test-fix commit message does not match prescribed format",
      },
    },
    deps,
  );
}

const MAX_BLOCK_OUTPUT = 8000;

// ---------------------------------------------------------------------------
// The bounded generate→test→fix loop.
// ---------------------------------------------------------------------------

/**
 * Run the repo's test/build command in `wtPath`. If it fails, invoke the
 * implementer harness with the failure output and re-run, up to
 * `cfg.test_gate.max_attempts` fix invocations. Returns the outcome; the caller
 * blocks the item when `!skipped && !passed`.
 *
 * `max_attempts` is the maximum number of fix-harness invocations. So for
 * `max_attempts: 3`: initial run → (fix → run) ×3. Passing after attempt N
 * yields `{passed: true, attempts: N}`; passing on the initial run yields
 * `{passed: true, attempts: 0}`.
 */
export async function runTestGate(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  deps: TestGateDeps = {},
): Promise<TestGateResult> {
  if (!cfg.test_gate.enabled) return { skipped: true };

  const invokeFn = deps.invoke ?? defaultInvoke;
  const runTestsFn = deps.runTests ?? runTests;
  const detectFn = deps.detectTestCommand ?? detectTestCommand;
  const gitHeadFn = deps.gitHead ?? defaultGitHead;
  const gitDirtyFn = deps.gitDirty ?? defaultGitDirty;
  const verifyTestFixFn =
    deps.verifyTestFix ??
    ((wt: string, hb: string) => enforceTestFixCommitFormat(issueNumber, wt, hb));

  const command = cfg.test_gate.command ? shellSplit(cfg.test_gate.command) : detectFn(wtPath);
  if (!command) return { skipped: true };

  const label = formatCommand(command);
  console.log(`[pipeline] #${issueNumber}: test gate running \`${label}\``);

  // Require a clean worktree before the first trusted test run. If uncommitted
  // changes exist, what's tested diverges from what's committed, so the gate
  // result can't be trusted.
  if (await gitDirtyFn(wtPath)) {
    return {
      skipped: false,
      passed: false,
      attempts: 0,
      blockReason:
        "Worktree has uncommitted changes before the test gate ran. " +
        "All changes must be committed so test results can be trusted.",
    };
  }

  let { passed, output } = await runTestsFn(wtPath, command, cfg.test_gate.timeout);
  if (passed) {
    // A passing run can still generate uncommitted artifacts (tsbuildinfo,
    // snapshots, lock-file updates). If it does, the committed state diverges
    // from what was tested — block so artifacts are committed and the gate reruns.
    if (await gitDirtyFn(wtPath)) {
      return {
        skipped: false,
        passed: false,
        attempts: 0,
        blockReason:
          "Test/build command left uncommitted changes in the working tree. " +
          "Commit any generated artifacts (snapshots, tsbuildinfo, lock-file updates) " +
          "so the gate certifies the exact committed state.",
      };
    }
    console.log(`[pipeline] #${issueNumber}: test gate passed`);
    return { skipped: false, passed: true, attempts: 0 };
  }

  const harness = cfg.harnesses.implementer;
  for (let attempt = 1; attempt <= cfg.test_gate.max_attempts; attempt++) {
    console.log(
      `[pipeline] #${issueNumber}: test gate failed; fix attempt ${attempt}/${cfg.test_gate.max_attempts} (${harness})`,
    );

    const fixHeadBefore = await gitHeadFn(wtPath);

    const prompt = buildTestFixPrompt({
      issueNumber,
      command: label,
      attempt,
      maxAttempts: cfg.test_gate.max_attempts,
      output,
    });
    const fixRes = await invokeFn(harness, wtPath, prompt, {
      timeoutSec: cfg.fix_timeout,
      model: cfg.models.fix,
    });
    if (!fixRes.success) {
      const reason = fixRes.timed_out
        ? `Fix harness (${harness}) timed out after ${fixRes.duration.toFixed(0)}s on test-gate fix attempt ${attempt}.`
        : `Fix harness (${harness}) failed (exit ${fixRes.exit_code}) on test-gate fix attempt ${attempt}.`;
      return { skipped: false, passed: false, attempts: attempt, blockReason: reason };
    }

    // Require a clean worktree after every fix attempt regardless of whether HEAD
    // advanced. If uncommitted changes remain, the test run would certify state
    // that can't be pushed as-is, defeating the gate's trust invariant.
    if (await gitDirtyFn(wtPath)) {
      return {
        skipped: false,
        passed: false,
        attempts: attempt,
        blockReason:
          "Fix harness left uncommitted changes in the working tree. " +
          "Test results can't be trusted — stage and commit the fix before re-running.",
      };
    }

    // Verify the test-fix commit message format (#68).
    if (fixHeadBefore) {
      const commitCheck = await verifyTestFixFn(wtPath, fixHeadBefore);
      if (!commitCheck.ok) {
        return { skipped: false, passed: false, attempts: attempt, blockReason: commitCheck.reason };
      }
    }

    ({ passed, output } = await runTestsFn(wtPath, command, cfg.test_gate.timeout));
    if (passed) {
      if (await gitDirtyFn(wtPath)) {
        return {
          skipped: false,
          passed: false,
          attempts: attempt,
          blockReason:
            "Test/build command left uncommitted changes in the working tree. " +
            "Commit any generated artifacts (snapshots, tsbuildinfo, lock-file updates) " +
            "so the gate certifies the exact committed state.",
        };
      }
      console.log(`[pipeline] #${issueNumber}: test gate passed after ${attempt} fix attempt(s)`);
      return { skipped: false, passed: true, attempts: attempt };
    }
  }

  return {
    skipped: false,
    passed: false,
    attempts: cfg.test_gate.max_attempts,
    blockReason: truncate(output, MAX_BLOCK_OUTPUT),
  };
}

/** Format a gate failure into a markdown blocker comment body. Generic across
 *  the planning (pre-PR) and fix (pre-advance) seams. */
export function testGateBlockReason(gate: TestGateResult): string {
  return (
    `Test/build gate failed after ${gate.attempts ?? 0} fix attempt(s); ` +
    "the repo's own test/build command is still failing, so the item was not advanced.\n\n" +
    "```\n" +
    (gate.blockReason ?? "(no output captured)") +
    "\n```"
  );
}

// ---------------------------------------------------------------------------
// Running the command.
// ---------------------------------------------------------------------------

/**
 * Spawn the test/build command with NO shell involvement (mirrors
 * harness.runCapped), capping output and enforcing a wall-clock timeout. A
 * non-zero exit, a timeout, or a spawn error all count as a failure.
 */
export async function runTests(
  cwd: string,
  command: ParsedCommand,
  timeoutSec: number,
): Promise<RunTestsResult> {
  const res = await runCapped(
    command.cmd,
    command.args,
    cwd,
    timeoutSec,
    true,
    `test-gate:${command.cmd}`,
  );
  let output = combineOutput(res);
  if (res.timed_out) {
    output = `${output}\n\n[test gate timed out after ${timeoutSec}s]`;
  }
  return { passed: res.success, output, durationSec: res.duration };
}

// ---------------------------------------------------------------------------
// Detection: first match wins. Explicit `test_gate.command` (handled by the
// caller) takes precedence over everything here.
// ---------------------------------------------------------------------------

export function detectTestCommand(repoDir: string): ParsedCommand | null {
  const pkgPath = path.join(repoDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const cmd = detectFromPackageJson(repoDir, pkgPath);
    if (cmd) return cmd;
  }
  if (fs.existsSync(path.join(repoDir, "go.mod"))) {
    return { cmd: "go", args: ["test", "./..."] };
  }
  if (fs.existsSync(path.join(repoDir, "Cargo.toml"))) {
    return { cmd: "cargo", args: ["test"] };
  }
  if (hasPytest(repoDir)) {
    return { cmd: "pytest", args: [] };
  }
  const makefile = path.join(repoDir, "Makefile");
  if (fs.existsSync(makefile) && hasMakeTestTarget(makefile)) {
    return { cmd: "make", args: ["test"] };
  }
  return null;
}

function detectFromPackageJson(repoDir: string, pkgPath: string): ParsedCommand | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const rawScripts = pkg && typeof pkg === "object" ? (pkg as { scripts?: unknown }).scripts : null;
  const scripts: Record<string, unknown> =
    rawScripts && typeof rawScripts === "object" ? (rawScripts as Record<string, unknown>) : {};
  const pm = detectPackageManager(repoDir);

  // A real `test` script wins — but skip the npm placeholder / echo stubs.
  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  if (testScript.trim() && !isStubScript(testScript)) {
    return { cmd: pm, args: ["run", "test"] };
  }

  // Otherwise fall back to a build/typecheck script if one exists.
  for (const key of ["build:check", "typecheck", "type-check", "build"]) {
    const v = scripts[key];
    if (typeof v === "string" && v.trim()) {
      return { cmd: pm, args: ["run", key] };
    }
  }
  return null;
}

function detectPackageManager(repoDir: string): string {
  if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoDir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** True for the npm placeholder and echo-only stubs (no executable after echo).
 *  Splits on compound shell operators so `echo "..." && vitest` is NOT a stub,
 *  while `echo "Error: no test specified" && exit 1` is. */
function isStubScript(script: string): boolean {
  const cmds = script.split(/&&|\|\|?|;/).map((s) => s.trim()).filter(Boolean);
  return cmds.every((cmd) => /^echo\b|^exit\b/.test(cmd));
}

/** pytest is only auto-detected with a concrete marker — `pyproject.toml`
 *  alone is NOT sufficient (it's used by many non-pytest Python projects). */
function hasPytest(repoDir: string): boolean {
  if (fs.existsSync(path.join(repoDir, "pytest.ini"))) return true;
  if (fs.existsSync(path.join(repoDir, "conftest.py"))) return true;
  const pyproject = path.join(repoDir, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    try {
      if (fs.readFileSync(pyproject, "utf8").includes("[tool.pytest")) return true;
    } catch {
      // unreadable → treat as no marker
    }
  }
  return false;
}

function hasMakeTestTarget(makefile: string): boolean {
  try {
    return /^test[ \t]*:/m.test(fs.readFileSync(makefile, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// shellSplit: parse the `test_gate.command` override into program + argv.
// Handles unquoted whitespace, single quotes (literal), and double quotes
// (with backslash escapes for \" and \\). No shell is ever spawned.
// ---------------------------------------------------------------------------

export function shellSplit(raw: string): ParsedCommand {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === '"' || next === "\\") {
          cur += next;
          i++;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inDouble = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(cur);
  if (tokens.length === 0) {
    throw new Error("test_gate.command is empty after parsing");
  }
  return { cmd: tokens[0], args: tokens.slice(1) };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function formatCommand(c: ParsedCommand): string {
  return [c.cmd, ...c.args].join(" ");
}

function combineOutput(res: HarnessResult): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "\n\n[…output truncated]";
}

async function defaultGitHead(cwd: string): Promise<string> {
  const res = await gitInWorktree(cwd, ["rev-parse", "HEAD"], { ignoreFailure: true });
  return res.stdout.trim();
}

async function defaultGitDirty(cwd: string): Promise<boolean> {
  const res = await gitInWorktree(cwd, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout.trim().length > 0;
}
