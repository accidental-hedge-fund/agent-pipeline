// Regression tests for review-1 findings (#431 fix round 1):
//  1. claude/codex preflight must distinguish "installed but unauthenticated"
//     from "authenticated" rather than treating presence as auth.
//  2. pi preflight must not skip its headless-availability check when the
//     help probe itself fails to run.
//  3. pi/opencode must reject a requested sandbox mode rather than silently
//     widening permissions, since neither offers an unattended restricted mode.
//
// All exec/execCheck calls are injected fakes — no real subprocess or network
// call, per the adapter contract's `AdapterPreflightDeps` seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAdapter } from "../scripts/harness-adapters/claude.ts";
import { codexAdapter } from "../scripts/harness-adapters/codex.ts";
import { piAdapter } from "../scripts/harness-adapters/pi.ts";
import { opencodeAdapter } from "../scripts/harness-adapters/opencode.ts";
import type { AdapterPreflightDeps } from "../scripts/harness-adapters/types.ts";

interface FakeOverrides {
  execCheck?: (file: string, args: string[]) => boolean;
  exec?: (file: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };
}

function fakeDeps(o: FakeOverrides = {}): AdapterPreflightDeps {
  return {
    exec: async (f, a) => (o.exec ? o.exec(f, a) : { ok: true, stdout: "", stderr: "" }),
    execCheck: async (f, a) => (o.execCheck ? o.execCheck(f, a) : true),
  };
}

// --- Finding 1: claude/codex installed-but-unauthenticated ---

test("claude preflight: installed but logged out is unauthenticated, not authenticated", async () => {
  const deps = fakeDeps({
    execCheck: () => true, // --version succeeds: CLI is installed
    exec: (_f, args) =>
      args.join(" ") === "auth status --json"
        ? { ok: true, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }
        : { ok: true, stdout: "", stderr: "" },
  });
  const result = await claudeAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unauthenticated");
  assert.equal(result.authState, "unauthenticated");
});

test("claude preflight: installed and logged in is authenticated", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: (_f, args) =>
      args.join(" ") === "auth status --json"
        ? { ok: true, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }
        : { ok: true, stdout: "", stderr: "" },
  });
  const result = await claudeAdapter.preflight(deps, {});
  assert.equal(result.ok, true);
  assert.equal(result.authState, "authenticated");
});

test("codex preflight: installed but logged out is unauthenticated, not authenticated", async () => {
  const deps = fakeDeps({
    execCheck: () => true, // --version succeeds: CLI is installed
    exec: (_f, args) => (args.join(" ") === "login status" ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: "", stderr: "" }),
  });
  const result = await codexAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unauthenticated");
  assert.equal(result.authState, "unauthenticated");
});

test("codex preflight: installed and logged in is authenticated", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: (_f, args) =>
      args.join(" ") === "login status"
        ? { ok: true, stdout: "Logged in using ChatGPT", stderr: "" }
        : { ok: true, stdout: "", stderr: "" },
  });
  const result = await codexAdapter.preflight(deps, {});
  assert.equal(result.ok, true);
  assert.equal(result.authState, "authenticated");
});

// --- Finding 2: pi headless probe must not be skipped when it fails ---

test("pi preflight: a failing --help probe blocks as headless-unavailable, never silently passes", async () => {
  const deps = fakeDeps({
    execCheck: () => true, // presence check passes (--version or --help)
    exec: () => ({ ok: false, stdout: "", stderr: "boom" }), // pi --help itself fails to run
  });
  const result = await piAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "headless-unavailable");
});

test("pi preflight: --help succeeding without -p/--print documented blocks as headless-unavailable", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: () => ({ ok: true, stdout: "no headless flags documented here", stderr: "" }),
  });
  const result = await piAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "headless-unavailable");
});

test("pi preflight: --help documents -p and --list-models reports a real model is ready and authenticated", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: (_f, args) =>
      args.includes("--list-models")
        ? { ok: true, stdout: "anthropic/claude-fable-5", stderr: "" }
        : { ok: true, stdout: "-p, --print   Print response and exit", stderr: "" },
  });
  const result = await piAdapter.preflight(deps, {});
  assert.equal(result.ok, true);
  assert.equal(result.authState, "authenticated");
});

// --- Review-2 finding 73d2e88a: pi must fail closed on unverified auth ---

test("pi preflight: --list-models reporting no models blocks as unauthenticated, never passes on an unverified auth state", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: (_f, args) =>
      args.includes("--list-models")
        ? { ok: true, stdout: "No models available. Use /login to log into a provider.", stderr: "" }
        : { ok: true, stdout: "-p, --print   Print response and exit", stderr: "" },
  });
  const result = await piAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unauthenticated");
  assert.equal(result.authState, "unauthenticated");
});

test("pi preflight: a failing --list-models probe blocks as unauthenticated rather than passing", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: (_f, args) =>
      args.includes("--list-models")
        ? { ok: false, stdout: "", stderr: "boom" }
        : { ok: true, stdout: "-p, --print   Print response and exit", stderr: "" },
  });
  const result = await piAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unauthenticated");
});

// --- Review-2 finding 16ab70d8: pi must validate the requested effort ---

test("pi preflight: an invalid --thinking level is rejected as unsupported-setting before invocation", async () => {
  const deps = fakeDeps({ execCheck: () => true });
  const result = await piAdapter.preflight(deps, { effort: "ludicrous" });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unsupported-setting");
});

test("pi preflight: a valid --thinking level passes the effort check", async () => {
  const deps = fakeDeps({
    execCheck: () => true,
    exec: (_f, args) =>
      args.includes("--list-models")
        ? { ok: true, stdout: "anthropic/claude-fable-5", stderr: "" }
        : { ok: true, stdout: "-p, --print   Print response and exit", stderr: "" },
  });
  const result = await piAdapter.preflight(deps, { effort: "high" });
  assert.equal(result.ok, true);
});

// --- Finding 3: pi/opencode must reject a requested sandbox mode ---

test("pi preflight: a requested sandbox mode is rejected as unsupported, not silently widened", async () => {
  const deps = fakeDeps({ execCheck: () => true });
  const result = await piAdapter.preflight(deps, { sandbox: true });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unsupported-setting");
  assert.equal(piAdapter.capabilities.sandbox, false);
});

test("opencode preflight: a requested sandbox mode is rejected as unsupported, not silently widened", async () => {
  const deps = fakeDeps({ execCheck: () => true, exec: () => ({ ok: true, stdout: "anthropic", stderr: "" }) });
  const result = await opencodeAdapter.preflight(deps, { sandbox: true });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unsupported-setting");
  assert.equal(opencodeAdapter.capabilities.sandbox, false);
});

// --- #571: missing-cli guidance must name the maintained npm package ---

test("pi preflight: missing-cli guidance names the maintained package, not the deprecated one", async () => {
  const deps = fakeDeps({ execCheck: () => false });
  const result = await piAdapter.preflight(deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.failure, "missing-cli");
  assert.match(result.message ?? "", /@earendil-works\/pi-coding-agent/);
  assert.doesNotMatch(result.message ?? "", /@mariozechner\/pi-coding-agent/);
});

test("pi/opencode buildInvocation still always passes their unattended auto-approve flag", () => {
  const piInv = piAdapter.buildInvocation({ prompt: "p", worktreeDir: "/tmp/w", sandbox: true });
  assert.ok(piInv.args.includes("-a"));
  const ocInv = opencodeAdapter.buildInvocation({ prompt: "p", worktreeDir: "/tmp/w", sandbox: true });
  assert.ok(ocInv.args.includes("--auto"));
});
