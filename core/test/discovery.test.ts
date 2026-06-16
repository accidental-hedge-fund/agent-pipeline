// Tests for core/scripts/discovery.ts (#153).
//
// Covers:
//   1. All four hostCoverage states: both / claude-only / codex-only / missing
//   2. corePath and version populated when a probe hits
//   3. corePath null when no probe hits
//   4. Probe error bubbles as thrown error (non-zero exit path)
//   5. Regression: pipeline path --json handler serialises DiscoveryResult as JSON
//   6. Regression: pipeline --version flag contract is unchanged

import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverHosts, type DiscoverHostsDeps, type DiscoveryResult } from "../scripts/discovery.ts";
import { handlePathSubcommand, type PathSubcommandDeps } from "../scripts/pipeline.ts";
import type { CliOpts } from "../scripts/pipeline.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<DiscoverHostsDeps>): DiscoverHostsDeps {
  return {
    which: async () => null,
    probeCandidates: async () => null,
    readVersion: async () => null,
    ...overrides,
  };
}

const FAKE_CORE_PATH = "/usr/local/lib/node_modules/pipeline/core";
const FAKE_VERSION = "1.4.0";

// ---------------------------------------------------------------------------
// 1. hostCoverage states
// ---------------------------------------------------------------------------

test("discoverHosts: both hosts installed → hostCoverage=both", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => `/usr/local/bin/${cmd}`,
    }),
  );
  assert.equal(result.hostCoverage, "both");
  assert.equal(result.hosts.claude.available, true);
  assert.equal(result.hosts.codex.available, true);
  assert.equal(result.hosts.claude.cliBin, "/usr/local/bin/claude");
  assert.equal(result.hosts.codex.cliBin, "/usr/local/bin/codex");
});

test("discoverHosts: claude only → hostCoverage=claude-only", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null),
    }),
  );
  assert.equal(result.hostCoverage, "claude-only");
  assert.equal(result.hosts.claude.available, true);
  assert.equal(result.hosts.codex.available, false);
  assert.equal(result.hosts.codex.cliBin, null);
});

test("discoverHosts: codex only → hostCoverage=codex-only", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => (cmd === "codex" ? "/usr/bin/codex" : null),
    }),
  );
  assert.equal(result.hostCoverage, "codex-only");
  assert.equal(result.hosts.claude.available, false);
  assert.equal(result.hosts.codex.available, true);
});

test("discoverHosts: neither host → hostCoverage=missing", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => null,
      which: async () => null,
    }),
  );
  assert.equal(result.hostCoverage, "missing");
  assert.equal(result.hosts.claude.available, false);
  assert.equal(result.hosts.codex.available, false);
});

// ---------------------------------------------------------------------------
// 2. corePath and version populated
// ---------------------------------------------------------------------------

test("discoverHosts: corePath and version from first probe hit", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => `/bin/${cmd}`,
    }),
  );
  assert.equal(result.corePath, FAKE_CORE_PATH);
  assert.equal(result.version, FAKE_VERSION);
});

// ---------------------------------------------------------------------------
// 3. corePath null when no probe hits
// ---------------------------------------------------------------------------

test("discoverHosts: corePath null when no candidate resolves", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => null,
      which: async () => null,
    }),
  );
  assert.equal(result.corePath, null);
  assert.equal(result.version, null);
});

test("discoverHosts: version null when corePath is null", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => null,
      readVersion: async () => { throw new Error("should not be called"); },
      which: async () => null,
    }),
  );
  assert.equal(result.version, null);
});

test("discoverHosts: hosts installed but no pipeline core → hostCoverage=missing", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => null, // no core found
      which: async (cmd) => `/usr/local/bin/${cmd}`, // both CLIs reachable
    }),
  );
  assert.equal(result.hostCoverage, "missing");
  assert.equal(result.corePath, null);
  // Host reachability is still reported accurately even when the core is absent.
  assert.equal(result.hosts.claude.available, true);
  assert.equal(result.hosts.codex.available, true);
});

// ---------------------------------------------------------------------------
// 4. Probe error bubbles
// ---------------------------------------------------------------------------

test("discoverHosts: probe error throws (not swallowed)", async () => {
  await assert.rejects(
    () =>
      discoverHosts(
        makeDeps({
          probeCandidates: async () => {
            throw new Error("npm root -g failed");
          },
        }),
      ),
    /npm root -g failed/,
  );
});

// Regression for Finding 5: npm-ENOENT (npm not on PATH) was silently treated
// as null → the discovery result showed "missing" instead of a probe error.
// The default probeCandidatesDefault now throws on ENOENT; this test confirms
// the error propagates through discoverHosts to handlePathSubcommand.
test("discoverHosts: npm-ENOENT probe error propagates (regression: was silently nil)", async () => {
  const enoentErr = Object.assign(new Error("npm not found"), { code: "ENOENT" });
  await assert.rejects(
    () =>
      discoverHosts(
        makeDeps({
          probeCandidates: async () => { throw enoentErr; },
        }),
      ),
    /ENOENT|npm not found/,
  );
});

// handlePathSubcommand must exit non-zero when the probe propagates ENOENT.
test("handlePathSubcommand: npm-ENOENT probe error sets exit code 1", async (t) => {
  t.mock.method(console, "error", () => {});
  const enoentErr = Object.assign(new Error("install-location probe failed: `npm` is not on PATH"), {
    code: "ENOENT",
  });
  const deps: PathSubcommandDeps = {
    discoverHosts: async () => { throw enoentErr; },
  };
  const origExitCode = process.exitCode;
  try {
    await handlePathSubcommand({ json: true }, deps);
    assert.equal(process.exitCode, 1, "exit code must be 1 when npm probe errors");
  } finally {
    process.exitCode = origExitCode;
  }
});

// ---------------------------------------------------------------------------
// 5. pipeline path --json handler
// ---------------------------------------------------------------------------

test("handlePathSubcommand --json: serialises DiscoveryResult as valid JSON", async (t) => {
  const fakeResult: DiscoveryResult = {
    corePath: FAKE_CORE_PATH,
    version: FAKE_VERSION,
    hostCoverage: "both",
    hosts: {
      claude: { available: true, cliBin: "/usr/bin/claude" },
      codex: { available: true, cliBin: "/usr/bin/codex" },
    },
  };

  const logged: string[] = [];
  t.mock.method(console, "log", (msg: string) => logged.push(msg));

  const deps: PathSubcommandDeps = {
    discoverHosts: async () => fakeResult,
  };
  const opts: CliOpts = { json: true };
  await handlePathSubcommand(opts, deps);

  assert.equal(logged.length, 1, `expected exactly one console.log call; got ${logged.length}`);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(logged[0]); }, "output must be valid JSON");
  const r = parsed as DiscoveryResult;
  assert.equal(r.hostCoverage, "both");
  assert.equal(r.corePath, FAKE_CORE_PATH);
  assert.equal(r.version, FAKE_VERSION);
  assert.equal(r.hosts.claude.available, true);
  assert.equal(r.hosts.codex.available, true);
});

test("handlePathSubcommand --json: missing install JSON has null corePath", async (t) => {
  const fakeResult: DiscoveryResult = {
    corePath: null,
    version: null,
    hostCoverage: "missing",
    hosts: {
      claude: { available: false, cliBin: null },
      codex: { available: false, cliBin: null },
    },
  };

  const logged: string[] = [];
  t.mock.method(console, "log", (msg: string) => logged.push(msg));

  const deps: PathSubcommandDeps = { discoverHosts: async () => fakeResult };
  await handlePathSubcommand({ json: true }, deps);

  const r = JSON.parse(logged[0]) as DiscoveryResult;
  assert.equal(r.hostCoverage, "missing");
  assert.equal(r.corePath, null);
  assert.equal(r.version, null);
});

test("handlePathSubcommand --json: exit code 0 for missing install (not an error)", async () => {
  const deps: PathSubcommandDeps = {
    discoverHosts: async () => ({
      corePath: null,
      version: null,
      hostCoverage: "missing" as const,
      hosts: { claude: { available: false, cliBin: null }, codex: { available: false, cliBin: null } },
    }),
  };
  const origExitCode = process.exitCode;
  try {
    await handlePathSubcommand({ json: true }, deps);
    assert.notEqual(process.exitCode, 1, "exit code must not be 1 for missing install");
  } finally {
    process.exitCode = origExitCode;
  }
});

test("handlePathSubcommand: probe error sets exit code 1", async (t) => {
  t.mock.method(console, "error", () => {});
  const deps: PathSubcommandDeps = {
    discoverHosts: async () => { throw new Error("probe failed"); },
  };
  const origExitCode = process.exitCode;
  try {
    await handlePathSubcommand({ json: true }, deps);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = origExitCode;
  }
});

test("handlePathSubcommand human-readable: prints core path and coverage", async (t) => {
  const fakeResult: DiscoveryResult = {
    corePath: "/path/to/core",
    version: "1.0.0",
    hostCoverage: "claude-only",
    hosts: {
      claude: { available: true, cliBin: "/usr/bin/claude" },
      codex: { available: false, cliBin: null },
    },
  };

  const logged: string[] = [];
  t.mock.method(console, "log", (msg: string) => logged.push(msg));

  const deps: PathSubcommandDeps = { discoverHosts: async () => fakeResult };
  await handlePathSubcommand({}, deps); // no --json

  const combined = logged.join("\n");
  assert.match(combined, /\/path\/to\/core/);
  assert.match(combined, /claude-only/);
  assert.match(combined, /1\.0\.0/);
});

// ---------------------------------------------------------------------------
// 6. Regression: --version flag unaffected
// ---------------------------------------------------------------------------

test("VERSION export is still a semver string (detach/discovery imports do not break it)", async () => {
  const { VERSION } = await import("../scripts/pipeline.ts");
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
