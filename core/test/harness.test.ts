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
import { invoke, runCapped, formatStderrExcerpt } from "../scripts/harness.ts";
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
