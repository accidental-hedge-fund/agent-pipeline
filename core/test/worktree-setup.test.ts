// Unit tests for worktree dependency install step (#174).
// All tests use deps injection — no real filesystem, network, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAndInstall, type SetupDeps } from "../scripts/worktree-setup.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(setup_command?: string): Pick<PipelineConfig, "setup_command"> {
  return { setup_command };
}

/** Build a SetupDeps where existsSync returns true for exactly the listed paths. */
function presentFiles(present: string[]): SetupDeps {
  const set = new Set(present);
  return {
    existsSync: (p: string) => set.has(p),
    spawnCommand: async () => ({ code: 0, stdout: "ok", stderr: "" }),
  };
}

/** Build a SetupDeps where the spawn command exits with the given code. */
function spawnResult(
  present: string[],
  code: number,
  stdout = "",
  stderr = "",
): SetupDeps {
  const set = new Set(present);
  return {
    existsSync: (p: string) => set.has(p),
    spawnCommand: async () => ({ code, stdout, stderr }),
  };
}

// ---------------------------------------------------------------------------
// Explicit opt-out: setup_command: ""
// ---------------------------------------------------------------------------

test("setup_command: '' → skipped (explicit opt-out)", async () => {
  const result = await detectAndInstall("/wt", cfg(""), {
    existsSync: () => { throw new Error("should not be called"); },
    spawnCommand: async () => { throw new Error("should not be called"); },
  });
  assert.equal(result.skipped, true);
});

// ---------------------------------------------------------------------------
// setup_command override
// ---------------------------------------------------------------------------

test("setup_command non-empty → runs via shell, skips lockfile detection", async () => {
  let capturedCmd: string | undefined;
  let capturedShell: boolean | undefined;
  const deps: SetupDeps = {
    existsSync: () => { throw new Error("existsSync should not be called with setup_command"); },
    spawnCommand: async (cmd, _args, _cwd, useShell) => {
      capturedCmd = cmd;
      capturedShell = useShell;
      return { code: 0, stdout: "installed", stderr: "" };
    },
  };
  const result = await detectAndInstall("/wt", cfg("pnpm install --frozen-lockfile"), deps);
  assert.equal(result.skipped, false);
  assert.equal(result.command, "pnpm install --frozen-lockfile");
  assert.equal(capturedCmd, "pnpm install --frozen-lockfile");
  assert.equal(capturedShell, true);
});

test("setup_command multi-step runs via shell", async () => {
  let capturedCmd: string | undefined;
  const deps: SetupDeps = {
    existsSync: () => false,
    spawnCommand: async (cmd) => { capturedCmd = cmd; return { code: 0, stdout: "", stderr: "" }; },
  };
  await detectAndInstall("/wt", cfg("pnpm install && pnpm run build:types"), deps);
  assert.equal(capturedCmd, "pnpm install && pnpm run build:types");
});

test("setup_command exit non-zero → throws with command and exit code", async () => {
  const deps: SetupDeps = {
    existsSync: () => false,
    spawnCommand: async () => ({ code: 1, stdout: "", stderr: "ENOENT: not found" }),
  };
  await assert.rejects(
    () => detectAndInstall("/wt", cfg("my-install-script"), deps),
    (err: Error) => {
      assert.ok(err.message.includes("setup_command exited with code 1"), `message: ${err.message}`);
      assert.ok(err.message.includes("my-install-script"), `message: ${err.message}`);
      return true;
    },
  );
});

test("setup_command override bypasses idempotency check (node_modules present)", async () => {
  let spawnCalled = false;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/node_modules",
    spawnCommand: async () => { spawnCalled = true; return { code: 0, stdout: "", stderr: "" }; },
  };
  const result = await detectAndInstall("/wt", cfg("pnpm install"), deps);
  assert.equal(spawnCalled, true, "setup_command must run even when node_modules is present");
  assert.equal(result.skipped, false);
});

// ---------------------------------------------------------------------------
// Idempotency: node_modules present, no setup_command
// ---------------------------------------------------------------------------

test("node_modules present, no setup_command → skipped", async () => {
  const result = await detectAndInstall("/wt", cfg(undefined), {
    existsSync: (p) => p === "/wt/node_modules",
    spawnCommand: async () => { throw new Error("should not spawn"); },
  });
  assert.equal(result.skipped, true);
});

// ---------------------------------------------------------------------------
// Lockfile detection — pnpm precedence
// ---------------------------------------------------------------------------

test("pnpm-lock.yaml → pnpm install (no shell)", async () => {
  let capturedCmd: string | undefined;
  let capturedArgs: string[] | undefined;
  let capturedShell: boolean | undefined;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/pnpm-lock.yaml",
    spawnCommand: async (cmd, args, _cwd, useShell) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedShell = useShell;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const result = await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(result.skipped, false);
  assert.equal(result.command, "pnpm install");
  assert.equal(capturedCmd, "pnpm");
  assert.deepEqual(capturedArgs, ["install"]);
  assert.equal(capturedShell, false);
});

test("yarn.lock (no pnpm-lock.yaml) → yarn install", async () => {
  let capturedCmd: string | undefined;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/yarn.lock",
    spawnCommand: async (cmd) => { capturedCmd = cmd; return { code: 0, stdout: "", stderr: "" }; },
  };
  const result = await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(result.skipped, false);
  assert.equal(result.command, "yarn install");
  assert.equal(capturedCmd, "yarn");
});

test("package-lock.json (no pnpm/yarn lock) → npm ci", async () => {
  let capturedCmd: string | undefined;
  let capturedArgs: string[] | undefined;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/package-lock.json",
    spawnCommand: async (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const result = await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(result.skipped, false);
  assert.equal(result.command, "npm ci");
  assert.equal(capturedCmd, "npm");
  assert.deepEqual(capturedArgs, ["ci"]);
});

test("pnpm-lock.yaml takes precedence over yarn.lock and package-lock.json", async () => {
  let capturedCmd: string | undefined;
  const deps: SetupDeps = {
    existsSync: (p) =>
      p === "/wt/pnpm-lock.yaml" || p === "/wt/yarn.lock" || p === "/wt/package-lock.json",
    spawnCommand: async (cmd) => { capturedCmd = cmd; return { code: 0, stdout: "", stderr: "" }; },
  };
  await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(capturedCmd, "pnpm", "pnpm must win over yarn and npm when all lockfiles present");
});

test("yarn.lock takes precedence over package-lock.json", async () => {
  let capturedCmd: string | undefined;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/yarn.lock" || p === "/wt/package-lock.json",
    spawnCommand: async (cmd) => { capturedCmd = cmd; return { code: 0, stdout: "", stderr: "" }; },
  };
  await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(capturedCmd, "yarn", "yarn must win over npm when both lockfiles present");
});

// ---------------------------------------------------------------------------
// No lockfile, no setup_command
// ---------------------------------------------------------------------------

test("no lockfile, no setup_command → skipped without error", async () => {
  const result = await detectAndInstall("/wt", cfg(undefined), {
    existsSync: () => false,
    spawnCommand: async () => { throw new Error("should not spawn"); },
  });
  assert.equal(result.skipped, true);
});

// ---------------------------------------------------------------------------
// Auto-detected install exits non-zero → throws
// ---------------------------------------------------------------------------

test("pnpm install exits non-zero → throws with command name and exit code", async () => {
  const deps = spawnResult(["/wt/pnpm-lock.yaml"], 1, "", "ERR: peer deps conflict");
  await assert.rejects(
    () => detectAndInstall("/wt", cfg(undefined), deps),
    (err: Error) => {
      assert.ok(err.message.includes("pnpm install"), `message: ${err.message}`);
      assert.ok(err.message.includes("code 1"), `message: ${err.message}`);
      return true;
    },
  );
});

test("npm ci exits non-zero → throws with command name", async () => {
  const deps = spawnResult(["/wt/package-lock.json"], 2, "", "npm ci failed");
  await assert.rejects(
    () => detectAndInstall("/wt", cfg(undefined), deps),
    (err: Error) => {
      assert.ok(err.message.includes("npm ci"), `message: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Regression: detectAndInstall is not a no-op when pnpm-lock.yaml is present
// This test would fail if detectAndInstall always returned {skipped:true}
// ---------------------------------------------------------------------------

test("regression: detectAndInstall runs pnpm install when pnpm-lock.yaml is present (not a no-op)", async () => {
  let wasCalled = false;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/pnpm-lock.yaml",
    spawnCommand: async () => { wasCalled = true; return { code: 0, stdout: "", stderr: "" }; },
  };
  const result = await detectAndInstall("/wt", cfg(undefined), deps);
  assert.ok(wasCalled, "spawnCommand must be called when pnpm-lock.yaml is present");
  assert.equal(result.skipped, false, "result must not be skipped");
  assert.equal(result.command, "pnpm install");
});

// ---------------------------------------------------------------------------
// CWD: the install is run in the worktree path, not the repo root
// ---------------------------------------------------------------------------

test("install command is run in the worktree path", async () => {
  let capturedCwd: string | undefined;
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/pnpm-lock.yaml",
    spawnCommand: async (_cmd, _args, cwd) => { capturedCwd = cwd; return { code: 0, stdout: "", stderr: "" }; },
  };
  await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(capturedCwd, "/wt");
});

test("setup_command is run in the worktree path", async () => {
  let capturedCwd: string | undefined;
  const deps: SetupDeps = {
    existsSync: () => false,
    spawnCommand: async (_cmd, _args, cwd) => { capturedCwd = cwd; return { code: 0, stdout: "", stderr: "" }; },
  };
  await detectAndInstall("/wt", cfg("my-setup"), deps);
  assert.equal(capturedCwd, "/wt");
});

// ---------------------------------------------------------------------------
// Return values: stdout/stderr are surfaced in the result
// ---------------------------------------------------------------------------

test("install result carries stdout and stderr from the command", async () => {
  const deps: SetupDeps = {
    existsSync: (p) => p === "/wt/pnpm-lock.yaml",
    spawnCommand: async () => ({ code: 0, stdout: "Packages: +42\ndone", stderr: "warn: something" }),
  };
  const result = await detectAndInstall("/wt", cfg(undefined), deps);
  assert.equal(result.stdout, "Packages: +42\ndone");
  assert.equal(result.stderr, "warn: something");
});
