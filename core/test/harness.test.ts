// Unit tests for the generalized invoke() seam (#40).
//
// invoke() accepts an arbitrary reviewer-CLI name (`review_harness`, #40). The
// two built-in harnesses keep their invocation shapes; any other string is
// spawned with the prompt as a single positional argument and its stdout is
// captured as the harness output. A CLI that cannot be spawned yields a
// specific, named HarnessResult (with `spawn_error` set so the #39 fallback
// triggers) — never a thrown "Unknown harness".
//
// These exercise the real spawn/capture path against a local temp executable —
// the same local-fake approach config.test.ts uses for `gh` (no network, no git,
// no model). Built-in harness shapes are not spawned here (that would run the
// real claude/codex CLIs); they are unchanged code branches.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import {
  invoke,
  runCapped,
  formatStderrExcerpt,
  parseHarnessTelemetry,
  makeTelemetryForwardTransform,
} from "../scripts/harness.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-harness-test-"));

/** Write an executable shell script at `name` whose body is `body`; returns its path. */
function makeScript(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const cliPath = path.join(dir, name);
  fs.writeFileSync(cliPath, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

test("invoke(): a custom reviewer CLI is spawned and its stdout is captured as output", async () => {
  const verdict = '```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```';
  // Single-quoted heredoc → the JSON (backticks, braces) is emitted verbatim.
  const cli = makeScript("my-reviewer", `cat <<'EOF'\n${verdict}\nEOF`);
  const result = await invoke(cli, tmpRoot, "review this prompt", { stream: false });
  assert.equal(result.success, true);
  assert.equal(result.spawn_error ?? false, false);
  assert.match(result.stdout, /"verdict":"approve"/);
});

test("invoke(): the prompt is passed to a custom CLI as its first positional argument", async () => {
  // The script echoes back $1, proving the prompt is delivered as a positional arg.
  const cli = makeScript("echo-arg", `printf '%s' "$1"`);
  const result = await invoke(cli, tmpRoot, "THE-PROMPT-MARKER", { stream: false });
  assert.equal(result.success, true);
  assert.equal(result.stdout, "THE-PROMPT-MARKER");
});

test("invoke(): accounting records prompt size without raw prompt content", async () => {
  const cli = makeScript("ok", `printf 'done'`);
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  const prompt = "0123456789abcdef";

  const result = await invoke(cli, tmpRoot, prompt, {
    stream: false,
    accounting: {
      runDir,
      issue: 42,
      stage: "review-1",
      modelSlot: "review",
      model: "test-model",
    },
  });

  assert.equal(result.success, true);
  const raw = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
  assert.doesNotMatch(raw, new RegExp(prompt));
  const event = JSON.parse(raw.trim());
  assert.equal(event.type, "stage_accounting");
  assert.equal(event.prompt_chars, 16);
  assert.equal(event.prompt_estimated_tokens, 4);
});

test("invoke(): an unspawnable custom CLI yields a specific named error, not 'Unknown harness'", async () => {
  const missing = `definitely-not-a-real-cli-${path.basename(tmpRoot)}`;
  const result = await invoke(missing, tmpRoot, "prompt", { stream: false });
  assert.equal(result.success, false);
  assert.equal(
    result.spawn_error,
    true,
    "ENOENT must surface as a spawn_error so the #39 self-review fallback triggers",
  );
  assert.match(
    result.stderr,
    new RegExp(`reviewer CLI '${missing}' not found or not executable`),
    "the failure message names the missing CLI explicitly",
  );
  assert.doesNotMatch(result.stderr, /Unknown harness/, "must not regress to the old thrown message");
});

test("invoke(): a custom CLI that exits nonzero is a genuine failure (not a spawn_error)", async () => {
  // A CLI that runs but fails is distinct from a missing one: spawn_error stays
  // false, so invokeReviewer treats it as a real failure (block), not a #39 fallback.
  const cli = makeScript("boom", `echo "nope" >&2\nexit 3`);
  const result = await invoke(cli, tmpRoot, "prompt", { stream: false });
  assert.equal(result.success, false);
  assert.equal(result.exit_code, 3);
  assert.equal(result.spawn_error ?? false, false);
  // The named-CLI message is reserved for spawn failures; a real exit keeps its stderr.
  assert.doesNotMatch(result.stderr, /not found or not executable/);
});

// ---------------------------------------------------------------------------
// sandbox flag (#21) — permission-mode routing for the claude built-in harness
//
// We cannot spawn the real claude/codex CLIs in tests, but we can verify the
// argument routing by putting a fake "claude"/"codex" script on PATH that echoes
// all received arguments to stdout. Each arg is printed on its own line so
// assertions can grep for --permission-mode values without positional fragility.
// ---------------------------------------------------------------------------

test("invoke(): claude with sandbox:true passes --permission-mode default, not bypassPermissions (#21)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "test-prompt", { stream: false, sandbox: true });
    assert.match(result.stdout, /--permission-mode/, "must pass --permission-mode flag");
    assert.match(result.stdout, /\bdefault\b/, "sandbox:true → permission mode must be 'default'");
    assert.doesNotMatch(
      result.stdout,
      /bypassPermissions/,
      "sandbox:true must NOT pass bypassPermissions",
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude with sandbox:false passes --permission-mode bypassPermissions (#21)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "test-prompt", { stream: false, sandbox: false });
    assert.match(result.stdout, /bypassPermissions/, "sandbox:false → permission mode must be bypassPermissions");
    assert.doesNotMatch(
      result.stdout,
      /(?<!\w)default(?!\w)/,
      "sandbox:false must NOT pass --permission-mode default",
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude with sandbox absent (undefined) defaults to bypassPermissions (#21)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    // No sandbox option passed — must be byte-identical to the pre-change default.
    const result = await invoke("claude", tmpRoot, "test-prompt", { stream: false });
    assert.match(result.stdout, /bypassPermissions/, "sandbox absent → permission mode must be bypassPermissions");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): codex with sandbox:true produces args identical to sandbox:false (#21)", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  const oldNoSandbox = process.env.PIPELINE_CODEX_NO_SANDBOX;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  delete process.env.PIPELINE_CODEX_NO_SANDBOX;
  try {
    const [withSandbox, withoutSandbox] = await Promise.all([
      invoke("codex", tmpRoot, "test-prompt", { stream: false, sandbox: true }),
      invoke("codex", tmpRoot, "test-prompt", { stream: false, sandbox: false }),
    ]);
    assert.equal(withSandbox.stdout, withoutSandbox.stdout, "codex args must be identical regardless of sandbox flag");
    assert.match(withSandbox.stdout, /--full-auto/, "default codex invocation must keep --full-auto");
  } finally {
    process.env.PATH = oldPath;
    if (oldNoSandbox === undefined) delete process.env.PIPELINE_CODEX_NO_SANDBOX;
    else process.env.PIPELINE_CODEX_NO_SANDBOX = oldNoSandbox;
  }
});

test("invoke(): PIPELINE_CODEX_NO_SANDBOX=1 switches codex to explicit no-sandbox automation mode", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  const oldNoSandbox = process.env.PIPELINE_CODEX_NO_SANDBOX;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  process.env.PIPELINE_CODEX_NO_SANDBOX = "1";
  try {
    const result = await invoke("codex", tmpRoot, "test-prompt", { stream: false });
    assert.match(
      result.stdout,
      /--dangerously-bypass-approvals-and-sandbox/,
      "explicit env opt-in must use Codex's no-sandbox automation mode",
    );
    assert.doesNotMatch(result.stdout, /--full-auto/, "no-sandbox mode must not also pass --full-auto");
    assert.match(result.stdout, /test-prompt/, "prompt must still be passed through");
  } finally {
    process.env.PATH = oldPath;
    if (oldNoSandbox === undefined) delete process.env.PIPELINE_CODEX_NO_SANDBOX;
    else process.env.PIPELINE_CODEX_NO_SANDBOX = oldNoSandbox;
  }
});

// ---------------------------------------------------------------------------
// lean flag (#220) — single-shot, tool-free, no-MCP generation for the claude
// harness. Used by self-contained spec-generation stages (intake/sweep) so the
// call cannot cold-start MCP servers or spend agentic turns exploring the repo.
// We assert the argv routing via the same fake-claude-on-PATH approach.
// ---------------------------------------------------------------------------

test("invoke(): claude with lean:true appends --tools \"\" and --strict-mcp-config, keeps model, and never swallows the prompt (#220)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "PROMPT-MARKER", { stream: false, lean: true, model: "sonnet" });
    assert.match(result.stdout, /--tools/, "lean must pass --tools to restrict the tool set");
    assert.match(result.stdout, /--strict-mcp-config/, "lean must pass --strict-mcp-config so zero MCP servers load");
    assert.match(result.stdout, /--model\nsonnet/, "model must still be threaded in lean mode");
    // --tools is variadic: its value must be the empty string ("" = disable all
    // tools), immediately followed by a FLAG (never the trailing prompt, which the
    // variadic would otherwise consume).
    const lines = result.stdout.split("\n");
    const toolsIdx = lines.indexOf("--tools");
    assert.ok(toolsIdx !== -1, "--tools must be present");
    assert.equal(lines[toolsIdx + 1], "", "--tools value must be the empty string (disable all built-in tools)");
    assert.equal(lines[toolsIdx + 2], "--strict-mcp-config", "--tools \"\" must be immediately followed by a flag, not the prompt");
    // The prompt must survive as the trailing positional.
    const args = result.stdout.replace(/\n$/, "").split("\n");
    assert.equal(args[args.length - 1], "PROMPT-MARKER", "prompt must reach the CLI as the trailing positional, un-swallowed");
    // Lean must NOT touch auth: --bare (which would disable keychain reads) is forbidden.
    assert.doesNotMatch(result.stdout, /--bare/, "lean must NOT use --bare (it disables keychain reads and breaks OAuth auth)");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude WITHOUT lean is unchanged — no --tools/--strict-mcp-config/--bare (#220)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "test-prompt", { stream: false });
    assert.doesNotMatch(result.stdout, /--tools/, "non-lean must NOT pass --tools");
    assert.doesNotMatch(result.stdout, /--strict-mcp-config/, "non-lean must NOT pass --strict-mcp-config");
    assert.doesNotMatch(result.stdout, /--bare/, "non-lean must NOT pass --bare");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// formatStderrExcerpt — shared helper used by review and plan-review (#40)
// ---------------------------------------------------------------------------

test("formatStderrExcerpt: non-empty stderr → fenced block with header", () => {
  const out = formatStderrExcerpt("error: not found");
  assert.match(out, /CLI output:/);
  assert.match(out, /```/);
  assert.match(out, /error: not found/);
});

test("formatStderrExcerpt: empty stderr → empty string", () => {
  assert.equal(formatStderrExcerpt(""), "");
  assert.equal(formatStderrExcerpt("   "), "");
});

test("formatStderrExcerpt: stderr exceeding max is truncated with marker", () => {
  const long = "x".repeat(600);
  const out = formatStderrExcerpt(long, 500);
  assert.match(out, /…\(truncated\)/);
  assert.ok(!out.includes("x".repeat(501)), "must not exceed max in the excerpt");
});

test("formatStderrExcerpt: stderr at exactly max is not truncated", () => {
  const exact = "y".repeat(500);
  const out = formatStderrExcerpt(exact, 500);
  assert.ok(!out.includes("…(truncated)"), "no truncation marker when length equals max");
});

// ---------------------------------------------------------------------------
// descendant-cleanup (#260) — grandchild process is killed when harness times out
//
// runCapped with killProcessGroup:true must kill the entire process group on
// timeout, including grandchild processes spawned by the direct child.
// ---------------------------------------------------------------------------

test("runCapped: grandchild process is killed when harness times out (#260)", async () => {
  // Write the grandchild PID to a temp file (not stdout) to avoid pipe-buffering
  // races when the process is killed near the moment it finishes writing.
  const pidFile = path.join(tmpRoot, `grandchild-pid-${Date.now()}.txt`);
  const cli = makeScript(
    "spawn-grandchild",
    // Fork a grandchild sleeping well past the timeout, record its PID to a file,
    // then block in wait so the parent (bash) stays alive until the timeout kills it.
    `sleep 9999 &\necho "$!" > "${pidFile}"\nwait`,
  );
  // 2 s timeout. killGraceSec:0.5 keeps total resolution time ~2.7 s instead of 7 s.
  const result = await runCapped(cli, [], tmpRoot, 2, false, "test", { killProcessGroup: true, killGraceSec: 0.5 });

  assert.equal(result.timed_out, true, "result.timed_out must be true after timeout fires");

  // Read the PID from the file written before the timeout fired.
  assert.ok(fs.existsSync(pidFile), `PID file must exist at ${pidFile} — script did not write it before timeout`);
  const grandchildPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `grandchild PID must be a positive integer, got: ${JSON.stringify(fs.readFileSync(pidFile, "utf8"))}`);

  // runCapped now resolves only after the SIGKILL grace has completed, so
  // descendants are guaranteed absent without an additional wait.
  assert.throws(
    () => process.kill(grandchildPid, 0),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH",
    "grandchild must be absent from the OS process table after process-group kill",
  );
});

test("invoke(): a timed-out harness kills its grandchild — proves invoke() threads killProcessGroup into runCapped (#260)", async () => {
  // Bites the ACTUAL bug: invoke() must pass killProcessGroup into runCapped so a
  // detached process group is created and the whole descendant tree is killed on
  // timeout. The runCapped-direct test above passes killProcessGroup itself, so it
  // cannot catch a regression where invoke() stops threading the option. This goes
  // through invoke() with the custom-harness path (any non claude/codex name), so no
  // real model CLI is spawned. If invoke() dropped the option the detached group would
  // not be created, the grandchild would be orphaned, and the ESRCH assertion below
  // would fail.
  const pidFile = path.join(tmpRoot, `invoke-grandchild-pid-${Date.now()}.txt`);
  const cli = makeScript(
    "invoke-spawn-grandchild",
    `sleep 9999 &\necho "$!" > "${pidFile}"\nwait`,
  );
  const result = await invoke(cli, tmpRoot, "prompt", { stream: false, timeoutSec: 1 });

  assert.equal(result.timed_out, true, "invoke() must report timed_out after the 1 s timeout fires");
  assert.ok(fs.existsSync(pidFile), "fake CLI must have recorded its grandchild PID before the timeout");
  const grandchildPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(
    Number.isFinite(grandchildPid) && grandchildPid > 0,
    `grandchild PID must be a positive integer, got ${JSON.stringify(fs.readFileSync(pidFile, "utf8"))}`,
  );
  assert.throws(
    () => process.kill(grandchildPid, 0),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH",
    "invoke() timeout must kill the whole process group — the grandchild must be gone",
  );
});

// ---------------------------------------------------------------------------
// reasoningEffort (#278, #366) — per-stage reasoning-effort override
//
// invoke("codex", ..., { reasoningEffort: "medium" }) must include
// -c model_reasoning_effort=medium in the codex args; invoke("claude", ...)
// must include --effort medium instead (#366); omitting reasoningEffort must
// leave the args unchanged for both harnesses.
// ---------------------------------------------------------------------------

test("invoke(): codex with reasoningEffort:'medium' includes -c model_reasoning_effort=medium in args (#278)", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("codex", tmpRoot, "PROMPT-MARKER", { stream: false, reasoningEffort: "medium" });
    const lines = result.stdout.split("\n");
    const cIdx = lines.indexOf("-c");
    assert.ok(cIdx !== -1, "-c flag must be present in codex args");
    assert.equal(lines[cIdx + 1], "model_reasoning_effort=medium", "-c value must be model_reasoning_effort=medium");
    // Prompt must still be the last positional.
    const args = result.stdout.replace(/\n$/, "").split("\n");
    assert.equal(args[args.length - 1], "PROMPT-MARKER", "prompt must remain the trailing positional");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): codex WITHOUT reasoningEffort has no -c model_reasoning_effort flag (#278)", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("codex", tmpRoot, "PROMPT-MARKER", { stream: false });
    assert.doesNotMatch(result.stdout, /model_reasoning_effort/, "no reasoning-effort flag when reasoningEffort is absent");
    assert.doesNotMatch(result.stdout, /-c\n/, "no -c flag when reasoningEffort is absent");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude with reasoningEffort:'medium' does NOT include the codex -c model_reasoning_effort flag (#278)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "PROMPT-MARKER", { stream: false, reasoningEffort: "medium" });
    assert.doesNotMatch(result.stdout, /model_reasoning_effort/, "claude must not include model_reasoning_effort flag");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude with reasoningEffort:'high' includes --effort high in args (#366)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "PROMPT-MARKER", { stream: false, reasoningEffort: "high" });
    const lines = result.stdout.split("\n");
    const effortIdx = lines.indexOf("--effort");
    assert.ok(effortIdx !== -1, "--effort flag must be present in claude args");
    assert.equal(lines[effortIdx + 1], "high", "--effort value must be 'high'");
    const args = result.stdout.replace(/\n$/, "").split("\n");
    assert.equal(args[args.length - 1], "PROMPT-MARKER", "prompt must remain the trailing positional");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude WITHOUT reasoningEffort has no --effort flag (#366)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "PROMPT-MARKER", { stream: false });
    assert.doesNotMatch(result.stdout, /--effort/, "no --effort flag when reasoningEffort is absent");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// codex model passthrough (#441) — invoke("codex", ..., { model }) must
// include -m <model> in the codex args, alongside the existing effort
// passthrough; the claude branch and custom reviewer CLIs are unaffected.
// ---------------------------------------------------------------------------

test("invoke(): codex with model+effort includes -m <model> and -c model_reasoning_effort=<level> (#441)", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("codex", tmpRoot, "PROMPT-MARKER", {
      stream: false,
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
    const lines = result.stdout.split("\n");
    const mIdx = lines.indexOf("-m");
    assert.ok(mIdx !== -1, "-m flag must be present in codex args");
    assert.equal(lines[mIdx + 1], "gpt-5.6-terra", "-m value must be gpt-5.6-terra");
    const cIdx = lines.indexOf("-c");
    assert.ok(cIdx !== -1, "-c flag must be present in codex args");
    assert.equal(lines[cIdx + 1], "model_reasoning_effort=high", "-c value must be model_reasoning_effort=high");
    const args = result.stdout.replace(/\n$/, "").split("\n");
    assert.equal(args[args.length - 1], "PROMPT-MARKER", "prompt must remain the trailing positional");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): codex with effort only (no model) has no -m flag (#441, today's behavior)", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("codex", tmpRoot, "PROMPT-MARKER", { stream: false, reasoningEffort: "high" });
    const lines = result.stdout.split("\n");
    assert.equal(lines.indexOf("-m"), -1, "no -m flag when model is absent");
    const cIdx = lines.indexOf("-c");
    assert.ok(cIdx !== -1, "-c flag must still be present in codex args");
    assert.equal(lines[cIdx + 1], "model_reasoning_effort=high");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): claude branch model/effort argv is unchanged by the codex -m passthrough (#441)", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "PROMPT-MARKER", {
      stream: false,
      model: "opus",
      reasoningEffort: "high",
    });
    const lines = result.stdout.split("\n");
    const modelIdx = lines.indexOf("--model");
    assert.ok(modelIdx !== -1, "--model flag must be present in claude args");
    assert.equal(lines[modelIdx + 1], "opus");
    assert.equal(lines.indexOf("-m"), -1, "claude must never receive a bare -m flag");
    const effortIdx = lines.indexOf("--effort");
    assert.ok(effortIdx !== -1, "--effort flag must be present in claude args");
    assert.equal(lines[effortIdx + 1], "high");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): a custom reviewer CLI receives neither -m nor --model when a model is set (#441)", async () => {
  const cli = makeScript("my-reviewer", `printf '%s\\n' "$@"`);
  const result = await invoke(cli, tmpRoot, "PROMPT-MARKER", {
    stream: false,
    model: "x",
    reasoningEffort: "high",
  });
  const args = result.stdout.replace(/\n$/, "").split("\n");
  assert.equal(args.length, 1, "custom CLI receives only the prompt as a single positional arg");
  assert.equal(args[0], "PROMPT-MARKER");
});

test("invoke(): a custom reviewer CLI ignores reasoningEffort — no --effort/-c flag emitted (#40, #366)", async () => {
  const cli = makeScript("my-reviewer", `printf '%s\\n' "$@"`);
  const result = await invoke(cli, tmpRoot, "PROMPT-MARKER", { stream: false, reasoningEffort: "high" });
  assert.doesNotMatch(result.stdout, /--effort/, "custom CLI must not receive --effort");
  assert.doesNotMatch(result.stdout, /model_reasoning_effort/, "custom CLI must not receive -c model_reasoning_effort");
  const args = result.stdout.replace(/\n$/, "").split("\n");
  assert.equal(args.length, 1, "custom CLI receives only the prompt as a single positional arg");
  assert.equal(args[0], "PROMPT-MARKER");
});

test("runCapped: grandchild that ignores SIGTERM is killed after SIGKILL grace period (#260)", async () => {
  // Regression for the scenario where the direct child exits on SIGTERM while a
  // grandchild with 'trap '' TERM' survives — runCapped must not resolve until after
  // SIGKILL completes, even though 'close' fires early.
  const pidFile = path.join(tmpRoot, `sigterm-immune-grandchild-${Date.now()}.txt`);
  const cli = makeScript(
    "spawn-sigterm-immune",
    // The subshell sets SIG_IGN for TERM; 'sleep 9999' inside it inherits the
    // disposition and cannot be killed by SIGTERM. The outer bash is not protected
    // and dies on SIGTERM, firing 'close' on the direct child — but the subshell
    // and its sleep stay alive until SIGKILL.
    `(trap '' TERM; sleep 9999) &\necho "$!" > "${pidFile}"\nsleep 9999`,
  );
  // killGraceSec:0.5 keeps total resolution time ~1.7 s (1 s timeout + 0.5 s grace + 0.2 s reap).
  const result = await runCapped(cli, [], tmpRoot, 1, false, "test", { killProcessGroup: true, killGraceSec: 0.5 });

  assert.equal(result.timed_out, true, "result.timed_out must be true");

  assert.ok(fs.existsSync(pidFile), `PID file must exist at ${pidFile}`);
  const grandchildPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `grandchild PID must be a positive integer, got: ${JSON.stringify(fs.readFileSync(pidFile, "utf8"))}`);

  // runCapped resolves only after SIGKILL + reap window — no extra wait needed.
  assert.throws(
    () => process.kill(grandchildPid, 0),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH",
    "SIGTERM-ignoring grandchild must be dead after SIGKILL grace period",
  );
});

// ---------------------------------------------------------------------------
// capture-stream error (#384) — the output-capture pipe breaking mid-run
// (e.g. an EPIPE) before a clean process exit is ever observed. Uses an
// injected spawn to simulate the stream fault deterministically: real OS-level
// pipe faults are not reproducible portably, but the real runCapped
// event-wiring/settle logic under test is unchanged and unfaked.
// ---------------------------------------------------------------------------

test("runCapped: a capture stream erroring mid-run resolves with capture_error, not a hang or a throw (#384)", async () => {
  // A minimal ChildProcess-shaped fake — only the spawn() OS boundary is faked,
  // so the assertions below exercise runCapped's real event-wiring/settle logic.
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999,
    kill: () => true,
  });
  const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;

  setImmediate(() => fakeChild.stdout.emit("error", new Error("EPIPE (simulated)")));

  const result = await runCapped("unused", [], tmpRoot, 30, false, "test", { spawnFn });

  assert.equal(result.capture_error, true);
  assert.equal(result.success, false);
  assert.equal(result.spawn_error ?? false, false, "a capture-stream error is distinct from a spawn error");
});

// ---------------------------------------------------------------------------
// synchronous spawn() throw (#393) — node:child_process spawn() throws
// SYNCHRONOUSLY (not via the async child.on("error") path) for certain argv
// contents, most notably a NUL byte (U+0000) in an argv string. Left
// unguarded, that throw escapes runCapped's Promise executor and crashes the
// whole pipeline process instead of resolving a spawn_error HarnessResult.
// ---------------------------------------------------------------------------

test("runCapped: a synchronous ERR_INVALID_ARG_VALUE (NUL byte) throw from spawn() resolves a spawn_error result instead of rejecting (#393)", async () => {
  const spawnFn = (() => {
    const err = new TypeError(
      "The argument 'args[0]' must be a string without null bytes. Received 'a\\x00b'",
    );
    (err as unknown as { code: string }).code = "ERR_INVALID_ARG_VALUE";
    throw err;
  }) as unknown as typeof import("node:child_process").spawn;

  const result = await runCapped("unused", ["a\0b"], tmpRoot, 30, false, "test", { spawnFn });

  assert.equal(result.success, false);
  assert.equal(result.spawn_error, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.exit_code, -1);
  assert.match(result.stderr, /NUL byte \(U\+0000\) detected in harness argv payload/);
  assert.doesNotMatch(result.stderr, /\x00/, "the raw NUL byte must not be echoed into the captured stderr");
});

test("runCapped: a synchronous spawn() throw NOT related to NUL bytes resolves a spawn_error result without the NUL marker (#393)", async () => {
  const spawnFn = (() => {
    throw new Error("some other synchronous spawn failure");
  }) as unknown as typeof import("node:child_process").spawn;

  const result = await runCapped("unused", [], tmpRoot, 30, false, "test", { spawnFn });

  assert.equal(result.success, false);
  assert.equal(result.spawn_error, true);
  assert.equal(result.timed_out, false);
  assert.match(result.stderr, /some other synchronous spawn failure/);
  assert.doesNotMatch(result.stderr, /NUL byte/, "the generic path must not add the NUL-byte marker");
});

test("invoke(): a prompt containing a real NUL byte resolves a spawn_error result end-to-end instead of throwing (#393)", async () => {
  const cli = makeScript("nul-byte-cli", `printf '%s' "$1"`);
  const result = await invoke(cli, tmpRoot, "prompt with a real \0 NUL byte", { stream: false });

  assert.equal(result.success, false);
  assert.equal(result.spawn_error, true);
  assert.match(result.stderr, /NUL byte \(U\+0000\) detected in harness argv payload/);
});

// ---------------------------------------------------------------------------
// forward-stream error (#384 delta review, key 84c9859e) — the DOWNSTREAM
// side of the pipe (our own stdout/stderr: terminal-log tee, event-sink
// socket) failing while the child command succeeds. Distinct from the
// capture-stream case above: the child's streams are healthy, so the gate
// result must stay tied to the command exit code — a sink write failure is a
// diagnostic, never a failed attempt. Covers both delivery shapes: a
// synchronous throw from write() and an asynchronous 'error' event.
// ---------------------------------------------------------------------------

for (const [shape, makeForwardStdout] of [
  [
    "write() throws synchronously",
    () =>
      Object.assign(new EventEmitter(), {
        write: () => { throw new Error("EPIPE (simulated sink fault)"); },
      }),
  ],
  [
    "stream emits an asynchronous 'error'",
    () => {
      const s = Object.assign(new EventEmitter(), { write: () => true });
      setImmediate(() => s.emit("error", new Error("EPIPE (simulated sink fault)")));
      return s;
    },
  ],
] as const) {
  test(`runCapped: forward-stream failure (${shape}) with a passing command → success, exit 0, diagnostic only (#384 84c9859e)`, async () => {
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 999999,
      kill: () => true,
    });
    const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;
    const forwardTo = {
      stdout: makeForwardStdout() as never,
      stderr: Object.assign(new EventEmitter(), { write: () => true }) as never,
    };

    setImmediate(() => {
      fakeChild.stdout.emit("data", Buffer.from("tests: 10/10 passed\n"));
      // Give the async 'error' shape a tick to deliver before the clean exit.
      setImmediate(() => {
        fakeChild.stdout.emit("data", Buffer.from("done\n"));
        fakeChild.emit("close", 0);
      });
    });

    const result = await runCapped("unused", [], tmpRoot, 30, true, "test", { spawnFn, forwardTo });

    assert.equal(result.success, true, "a sink write failure must not convert a passing command into a failure");
    assert.equal(result.exit_code, 0, "gate outcome derives solely from the command exit code");
    assert.equal(result.capture_error ?? false, false, "sink faults are not capture errors — the child streams were healthy");
    assert.ok(result.stdout.includes("tests: 10/10 passed"), "capture continues after the forward path breaks");
    assert.ok(
      result.stderr.includes("stream-forward error (diagnostic"),
      "the sink fault is recorded as a diagnostic note",
    );
  });
}

// ---------------------------------------------------------------------------
// late forward-stream error (#384 delta review round 2, key 0415ec38) — the
// sink's async EPIPE can arrive AFTER the child has already closed and
// runCapped has settled, by which point the per-call diagnostic listener
// added above has already been detached. Before the fix, this ordering left
// the destination stream with zero 'error' listeners: emitting 'error' with
// no listener throws synchronously inside the emit() call below, which
// would surface as an uncaught exception and crash the whole test process —
// exactly the pipeline crash the finding describes, on a command that
// already exited 0.
// ---------------------------------------------------------------------------

test("runCapped: a forward-stream error arriving after settle is absorbed, not an unhandled crash (#384 0415ec38)", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999,
    kill: () => true,
  });
  const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;
  const forwardTo = {
    stdout: Object.assign(new EventEmitter(), { write: () => true }),
    stderr: Object.assign(new EventEmitter(), { write: () => true }),
  };

  setImmediate(() => {
    fakeChild.stdout.emit("data", Buffer.from("tests: 10/10 passed\n"));
    fakeChild.emit("close", 0);
  });

  const result = await runCapped("unused", [], tmpRoot, 30, true, "test", { spawnFn, forwardTo });

  assert.equal(result.success, true, "a passing command must still resolve successfully");
  assert.equal(result.exit_code, 0, "gate outcome derives solely from the command exit code");

  // The command has already settled and this call's own listener is gone —
  // emitting now reproduces the exact late-arrival race. If this throws, the
  // fix regressed: the destination is left with no 'error' listener.
  assert.doesNotThrow(
    () => forwardTo.stdout.emit("error", new Error("EPIPE (simulated, late)")),
    "a forward error landing after settle must not be an unhandled 'error' event",
  );
});

// ---------------------------------------------------------------------------
// hard secondary deadline (#398) — runCapped must conclude even when a
// detached grandchild survives SIGKILL and keeps the child's stdio pipes open
// (so child.stdout/stderr never emit `close`) and the process-group kill is a
// no-op. The SIGTERM→grace→SIGKILL escalation schedules its own final settle
// as a NESTED setTimeout 200ms after SIGKILL; runCapped now also arms a
// SIBLING failsafe timer at cap-fire time, independent of that chain, so a
// throw or wedge anywhere in the nested path cannot prevent resolution.
//
// To prove the sibling failsafe — not the nested chain's own settle — is what
// resolves the promise, this races the two: hardDeadlineSec is set shorter
// than the chain's fixed 200ms tail, so the failsafe fires first. If the
// failsafe were removed, resolution would only happen ~200ms later, past the
// assertion window below, and this test would fail.
// ---------------------------------------------------------------------------

test("runCapped: the hard secondary deadline resolves timed_out:true ahead of the escalation chain's own settle, even with streams that never close and a no-op group kill (#398)", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999, // nonexistent PID → process.kill(-pid, sig) throws ESRCH: a no-op group kill
    kill: () => true,
  });
  const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;

  const start = Date.now();
  // cap fires at 300ms. killGraceSec:1 + hardDeadlineSec:0 → failsafe fires at
  // cap+1000ms, strictly before the chain's own settle at cap+1000ms+200ms.
  const result = await runCapped("unused", [], tmpRoot, 0.3, false, "test", {
    spawnFn,
    killProcessGroup: true,
    killGraceSec: 1,
    hardDeadlineSec: 0,
  });
  const elapsed = Date.now() - start;

  assert.equal(result.timed_out, true, "must resolve timed_out:true rather than pend forever");
  assert.ok(
    elapsed < 1450,
    `must resolve via the failsafe (~1300ms after start), not the chain's own settle (~1500ms) — took ${elapsed}ms`,
  );
});

test("runCapped: without a run-store context, no harness_timeout event is recorded and behavior is unchanged (bare caller, #398)", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999,
    kill: () => true,
  });
  const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;

  // Matches testgate.ts/eval.ts: no timeoutEvent opt at all.
  const result = await runCapped("unused", [], tmpRoot, 0.1, false, "test-gate", {
    spawnFn,
    killProcessGroup: true,
    killGraceSec: 0.1,
    hardDeadlineSec: 0.1,
  });

  assert.equal(result.timed_out, true, "the failsafe still resolves it with no run-store context");
});

// ---------------------------------------------------------------------------
// harness_timeout event recording (#398) — appended to the run store at the
// moment the wall-clock cap fires, before/independent of resolution.
// ---------------------------------------------------------------------------

function fakeRunStoreDeps(): { deps: RunStoreDeps; appended: string[] } {
  const appended: string[] = [];
  const deps: RunStoreDeps = {
    readFile: async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async () => {},
    appendFile: async (_p, data) => {
      appended.push(data);
    },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date() }),
  };
  return { deps, appended };
}

test("runCapped: appends a harness_timeout event to the run store at cap-fire time (#398)", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999,
    kill: () => true,
  });
  const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;
  const { deps, appended } = fakeRunStoreDeps();

  const result = await runCapped("unused", [], tmpRoot, 0.1, false, "review-1", {
    spawnFn,
    killProcessGroup: true,
    killGraceSec: 0.1,
    hardDeadlineSec: 0.1,
    timeoutEvent: { runDir: "/tmp/fake-run", runStoreDeps: deps, stage: "review-1" },
  });

  assert.equal(result.timed_out, true);
  assert.equal(appended.length, 1, "exactly one event must be appended to events.jsonl");
  const event = JSON.parse(appended[0]) as Record<string, unknown>;
  assert.equal(event.type, "harness_timeout");
  assert.equal(event.stage, "review-1");
  assert.equal(event.timeout_sec, 0.1);
  assert.equal(event.schema_version, 1);
  assert.ok(typeof event.at === "string" && (event.at as string).length > 0);
});

test("runCapped: no harness_timeout event is appended on a normal pre-cap exit", async () => {
  const cli = makeScript("quick-exit", "exit 0");
  const { deps, appended } = fakeRunStoreDeps();

  const result = await runCapped(cli, [], tmpRoot, 30, false, "review-1", {
    timeoutEvent: { runDir: "/tmp/fake-run", runStoreDeps: deps, stage: "review-1" },
  });

  assert.equal(result.timed_out, false);
  assert.equal(appended.length, 0, "no harness_timeout event on a normal, non-timing-out exit");
});

test("invoke(): threads opts.accounting into runCapped's timeoutEvent context — harness_timeout is recorded on invoke()'s own timeout path (#398)", async () => {
  const cli = makeScript("slow-cli", "sleep 5");
  const { deps, appended } = fakeRunStoreDeps();

  const result = await invoke(cli, tmpRoot, "a prompt", {
    stream: false,
    timeoutSec: 0.3,
    accounting: {
      runDir: "/tmp/fake-run",
      runStoreDeps: deps,
      issue: 398,
      stage: "review-1",
    },
  });

  assert.equal(result.timed_out, true);
  const timeoutEvents = appended
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.type === "harness_timeout");
  assert.equal(timeoutEvents.length, 1, "invoke() must thread accounting into runCapped's timeoutEvent");
  assert.equal(timeoutEvents[0].stage, "review-1");
});

// ---------------------------------------------------------------------------
// papercut identity env (#419) — opts.env merges into the child's environment
// only when explicitly supplied; absent opts.env is a byte-for-byte no-op.
// ---------------------------------------------------------------------------

test("runCapped: opts.env is merged into the spawned child's environment when supplied", async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 123456,
    kill: () => true,
  });
  const spawnFn = ((cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    capturedEnv = options.env;
    setImmediate(() => fakeChild.emit("close", 0));
    return fakeChild;
  }) as unknown as typeof import("node:child_process").spawn;

  await runCapped("unused", [], tmpRoot, 30, false, "test", {
    spawnFn,
    env: { PIPELINE_RUN_ID: "419-x", PIPELINE_STAGE: "implementing" },
  });

  assert.ok(capturedEnv, "spawn options.env must be set when opts.env is supplied");
  assert.equal(capturedEnv!.PIPELINE_RUN_ID, "419-x");
  assert.equal(capturedEnv!.PIPELINE_STAGE, "implementing");
  // process.env is still inherited underneath the additions.
  assert.equal(capturedEnv!.PATH, process.env.PATH);
});

test("runCapped: no opts.env → spawn options carry no env key at all (byte-for-byte no-op on the default path)", async () => {
  let capturedOptions: { env?: NodeJS.ProcessEnv } | undefined;
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 123457,
    kill: () => true,
  });
  const spawnFn = ((cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    capturedOptions = options;
    setImmediate(() => fakeChild.emit("close", 0));
    return fakeChild;
  }) as unknown as typeof import("node:child_process").spawn;

  await runCapped("unused", [], tmpRoot, 30, false, "test", { spawnFn });

  assert.equal(
    "env" in (capturedOptions ?? {}),
    false,
    "spawn options must not carry an env key when opts.env is absent — the child inherits process.env exactly as before #419",
  );
});

test("invoke(): opts.env reaches the real spawned child's environment end-to-end", async () => {
  const cli = makeScript("print-run-id", `printf '%s' "$PIPELINE_RUN_ID"`);
  const result = await invoke(cli, tmpRoot, "prompt", {
    stream: false,
    env: { PIPELINE_RUN_ID: "419-real" },
  });
  assert.equal(result.stdout, "419-real");
});

test("invoke(): no opts.env → the real spawned child sees no PIPELINE_RUN_ID (default path unchanged)", async () => {
  const cli = makeScript("print-run-id-absent", `printf '%s' "${"$"}{PIPELINE_RUN_ID:-<unset>}"`);
  const result = await invoke(cli, tmpRoot, "prompt", { stream: false });
  assert.equal(result.stdout, "<unset>");
});

// ---------------------------------------------------------------------------
// #429 — actual per-call cost capture from harness telemetry
//
// Fixture lines below are structurally faithful reproductions of real output
// captured from the installed `claude`/`codex` CLIs in telemetry mode
// (design.md — verified against the installed CLIs, per golden rule #5), with
// identifiers replaced by markers so tests can assert they are never persisted
// or forwarded.
// ---------------------------------------------------------------------------

const CLAUDE_TELEMETRY_FIXTURE = [
  `{"type":"system","subtype":"init","session_id":"SECRET-SESSION-abc123"}`,
  `{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}`,
  `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}}`,
  `{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784644800}}`,
  `{"type":"result","subtype":"success","is_error":false,"result":"hello world","session_id":"SECRET-SESSION-abc123","total_cost_usd":0.0014383,"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":8133,"output_tokens":123}}`,
].join("\n");

const CODEX_TELEMETRY_FIXTURE = [
  `{"type":"thread.started","thread_id":"SECRET-THREAD-xyz"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hello world"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":14385,"cached_input_tokens":10496,"output_tokens":6,"reasoning_output_tokens":0}}`,
].join("\n");

// ---------------------------------------------------------------------------
// parseHarnessTelemetry — pure envelope parser (never throws, tasks.md 1.5)
// ---------------------------------------------------------------------------

test("parseHarnessTelemetry: claude fixture → text/costUsd/usage from the terminal result line", () => {
  const telemetry = parseHarnessTelemetry("claude", CLAUDE_TELEMETRY_FIXTURE);
  assert.equal(telemetry.text, "hello world");
  assert.equal(telemetry.costUsd, 0.0014383);
  assert.equal(telemetry.usage?.input_tokens, 10);
  assert.equal(telemetry.usage?.cache_read_input_tokens, 8133);
  assert.equal(telemetry.usage?.output_tokens, 123);
});

test("parseHarnessTelemetry: codex fixture → agent_message text, turn.completed usage, no cost field", () => {
  const telemetry = parseHarnessTelemetry("codex", CODEX_TELEMETRY_FIXTURE);
  assert.equal(telemetry.text, "hello world");
  assert.equal(telemetry.costUsd, null, "codex never reports a per-call cost field");
  assert.equal(telemetry.usage?.input_tokens, 14385);
  assert.equal(telemetry.usage?.cached_input_tokens, 10496);
  assert.equal(telemetry.usage?.output_tokens, 6);
});

test("parseHarnessTelemetry: truncated final line (cut off mid-object) degrades to nulls, never throws", () => {
  const truncated = CLAUDE_TELEMETRY_FIXTURE.split("\n").slice(0, -1).join("\n") +
    `\n{"type":"result","subtype":"success","result":"cut off half`;
  assert.doesNotThrow(() => parseHarnessTelemetry("claude", truncated));
  const telemetry = parseHarnessTelemetry("claude", truncated);
  assert.equal(telemetry.text, null);
  assert.equal(telemetry.costUsd, null);
  assert.equal(telemetry.usage, null);
});

test("parseHarnessTelemetry: non-JSON noise interleaved with envelope lines is skipped, not fatal", () => {
  const withNoise = [
    "warning: some deprecation notice on stderr-like text",
    "",
    CLAUDE_TELEMETRY_FIXTURE,
    "trailing garbage that is not JSON at all {{{",
  ].join("\n");
  const telemetry = parseHarnessTelemetry("claude", withNoise);
  assert.equal(telemetry.text, "hello world");
  assert.equal(telemetry.costUsd, 0.0014383);
});

test("parseHarnessTelemetry: empty input → null/empty result, never throws", () => {
  assert.doesNotThrow(() => parseHarnessTelemetry("claude", ""));
  const claude = parseHarnessTelemetry("claude", "");
  assert.deepEqual(claude, { text: null, costUsd: null, usage: null });
  const codex = parseHarnessTelemetry("codex", "");
  assert.deepEqual(codex, { text: null, costUsd: null, usage: null });
});

test("parseHarnessTelemetry: a custom reviewer CLI name always yields the empty result", () => {
  const telemetry = parseHarnessTelemetry("my-custom-reviewer", CLAUDE_TELEMETRY_FIXTURE);
  assert.deepEqual(telemetry, { text: null, costUsd: null, usage: null });
});

// ---------------------------------------------------------------------------
// makeTelemetryForwardTransform — live terminal forwarding of assistant text
// only, never raw envelope JSON (tasks.md 2.3)
// ---------------------------------------------------------------------------

test("makeTelemetryForwardTransform('claude'): forwards only content_block_delta text, never raw envelope JSON", () => {
  const transform = makeTelemetryForwardTransform("claude");
  let forwarded = "";
  for (const line of CLAUDE_TELEMETRY_FIXTURE.split("\n")) {
    forwarded += transform(`${line}\n`);
  }
  assert.equal(forwarded, "hello world");
  assert.doesNotMatch(forwarded, /"type"/, "raw envelope JSON must never be forwarded");
  assert.doesNotMatch(forwarded, /SECRET-SESSION/, "session identifiers must never be forwarded");
});

test("makeTelemetryForwardTransform('codex'): forwards only the completed agent_message text, never raw envelope JSON", () => {
  const transform = makeTelemetryForwardTransform("codex");
  let forwarded = "";
  for (const line of CODEX_TELEMETRY_FIXTURE.split("\n")) {
    forwarded += transform(`${line}\n`);
  }
  assert.equal(forwarded, "hello world\n");
  assert.doesNotMatch(forwarded, /"type"/, "raw envelope JSON must never be forwarded");
  assert.doesNotMatch(forwarded, /SECRET-THREAD/, "thread identifiers must never be forwarded");
});

test("makeTelemetryForwardTransform: a JSON line split across two chunk boundaries is still parsed once complete", () => {
  const transform = makeTelemetryForwardTransform("claude");
  const line = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"split-ok"}}}\n`;
  const mid = Math.floor(line.length / 2);
  const first = transform(line.slice(0, mid));
  const second = transform(line.slice(mid));
  assert.equal(first, "", "an incomplete line must not be forwarded yet");
  assert.equal(second, "split-ok", "the completed line is forwarded once the boundary chunk arrives");
});

// ---------------------------------------------------------------------------
// invoke() end-to-end telemetry wiring — fake claude/codex CLIs on PATH emit
// the recorded fixtures verbatim, proving the whole path: stdout reconstruction,
// accounting cost_source classification, and no persisted secrets (tasks.md 3.3/3.4).
// ---------------------------------------------------------------------------

test("invoke(): a claude telemetry-mode call reconstructs stdout as the final assistant text and records cost_source:actual", async () => {
  const cli = makeScript("claude", `cat <<'HARNESS_EOF'\n${CLAUDE_TELEMETRY_FIXTURE}\nHARNESS_EOF`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  try {
    const result = await invoke("claude", tmpRoot, "prompt", {
      stream: false,
      accounting: { runDir, issue: 429, stage: "review-1" },
    });
    assert.equal(result.success, true);
    assert.equal(result.stdout, "hello world", "stdout must be the reconstructed assistant text, not the raw JSONL");

    const raw = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim();
    assert.doesNotMatch(raw, /SECRET-SESSION/, "session_id must never be persisted");
    assert.doesNotMatch(raw, /hello world/, "assistant text must never be persisted into the accounting record");
    const event = JSON.parse(raw);
    assert.equal(event.cost_source, "actual");
    assert.equal(event.cost_usd, 0.0014);
    assert.equal(event.usage.input_tokens, 10);
    assert.equal(event.usage.output_tokens, 123);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): a codex telemetry-mode call reconstructs stdout as the agent_message text and records tokens with a non-actual cost_source", async () => {
  const cli = makeScript("codex", `cat <<'HARNESS_EOF'\n${CODEX_TELEMETRY_FIXTURE}\nHARNESS_EOF`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  try {
    const result = await invoke("codex", tmpRoot, "prompt", {
      stream: false,
      accounting: { runDir, issue: 429, stage: "review-1" },
    });
    assert.equal(result.success, true);
    assert.equal(result.stdout, "hello world");

    const raw = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim();
    const event = JSON.parse(raw);
    assert.notEqual(event.cost_source, "actual", "codex telemetry never reports a cost field");
    assert.equal(event.cost_source, "unknown");
    assert.equal(event.cost_usd, null);
    assert.equal(event.usage.input_tokens, 14385);
    assert.equal(event.usage.cached_input_tokens, 10496);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): PIPELINE_HARNESS_TELEMETRY=off restores the plain-text argv for claude and codex", async () => {
  const claudeCli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  const oldTelemetry = process.env.PIPELINE_HARNESS_TELEMETRY;
  process.env.PATH = `${path.dirname(claudeCli)}:${oldPath}`;
  process.env.PIPELINE_HARNESS_TELEMETRY = "off";
  try {
    const claudeResult = await invoke("claude", tmpRoot, "test-prompt", { stream: false });
    assert.match(claudeResult.stdout, /--output-format\ntext/, "kill-switch must restore --output-format text");
    assert.doesNotMatch(claudeResult.stdout, /stream-json/, "kill-switch must not pass stream-json");
    assert.doesNotMatch(claudeResult.stdout, /--include-partial-messages/, "kill-switch must not pass --include-partial-messages");

    const codexCli = makeScript("codex", `printf '%s\\n' "$@"`);
    process.env.PATH = `${path.dirname(codexCli)}:${oldPath}`;
    const codexResult = await invoke("codex", tmpRoot, "test-prompt", { stream: false });
    assert.doesNotMatch(codexResult.stdout, /--json/, "kill-switch must not pass --json to codex");
  } finally {
    process.env.PATH = oldPath;
    if (oldTelemetry === undefined) delete process.env.PIPELINE_HARNESS_TELEMETRY;
    else process.env.PIPELINE_HARNESS_TELEMETRY = oldTelemetry;
  }
});

test("invoke(): telemetry mode is the default — claude passes --verbose --output-format stream-json --include-partial-messages", async () => {
  const cli = makeScript("claude", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("claude", tmpRoot, "test-prompt", { stream: false });
    assert.match(result.stdout, /--verbose/);
    assert.match(result.stdout, /--output-format\nstream-json/);
    assert.match(result.stdout, /--include-partial-messages/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): telemetry mode is the default — codex passes --json", async () => {
  const cli = makeScript("codex", `printf '%s\\n' "$@"`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const result = await invoke("codex", tmpRoot, "test-prompt", { stream: false });
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /--full-auto/, "the sandbox flag must still be present alongside --json");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invoke(): an unparseable claude envelope falls back to the raw captured output and cost_source:unknown, without failing the stage", async () => {
  const cli = makeScript("claude", `printf 'plain text with no JSON envelope at all\\n'`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  try {
    const result = await invoke("claude", tmpRoot, "prompt", {
      stream: false,
      accounting: { runDir, issue: 429, stage: "review-1" },
    });
    assert.equal(result.success, true, "unparseable telemetry must not fail the stage");
    assert.match(result.stdout, /plain text with no JSON envelope at all/, "raw captured output is the fallback stdout");
    const event = JSON.parse(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim());
    assert.equal(event.cost_source, "unknown");
    assert.equal(event.cost_usd, null);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runCapped: telemetry captureMode:'tail' preserves the final result line even when total output exceeds MAX_OUTPUT", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999,
    kill: () => true,
  });
  const spawnFn = (() => fakeChild) as unknown as typeof import("node:child_process").spawn;
  const finalLine = `{"type":"result","subtype":"success","result":"hello world","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}\n`;

  setImmediate(() => {
    // Emit well over MAX_OUTPUT (100_000 chars) of filler before the essential
    // final line, simulating a verbose stream-json call whose delta events
    // dwarf the final envelope. Head-mode capture would drop the final line
    // entirely; tail-mode must preserve it.
    const filler = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}}\n`;
    for (let i = 0; i < 1200; i++) fakeChild.stdout.emit("data", Buffer.from(filler));
    fakeChild.stdout.emit("data", Buffer.from(finalLine));
    fakeChild.emit("close", 0);
  });

  const result = await runCapped("unused", [], tmpRoot, 30, false, "test", {
    spawnFn,
    captureMode: "tail",
  });

  assert.equal(result.success, true);
  const telemetry = parseHarnessTelemetry("claude", result.stdout);
  assert.equal(telemetry.text, "hello world", "the final result line must survive tail-mode capture");
  assert.equal(telemetry.costUsd, 0.01);
});
