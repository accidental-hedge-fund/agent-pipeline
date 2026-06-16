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
import { invoke, formatStderrExcerpt } from "../scripts/harness.ts";

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
  process.env.PATH = `${path.dirname(cli)}:${oldPath}`;
  try {
    const [withSandbox, withoutSandbox] = await Promise.all([
      invoke("codex", tmpRoot, "test-prompt", { stream: false, sandbox: true }),
      invoke("codex", tmpRoot, "test-prompt", { stream: false, sandbox: false }),
    ]);
    assert.equal(withSandbox.stdout, withoutSandbox.stdout, "codex args must be identical regardless of sandbox flag");
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
