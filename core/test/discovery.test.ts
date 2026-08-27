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
import {
  discoverHosts,
  resolveManifestSkillPath,
  type DiscoverHostsDeps,
  type DiscoveryResult,
} from "../scripts/discovery.ts";
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
    probeOpenCodeSkill: async () => null,
    // Default tests pin the legacy trio so hostCoverage cases stay focused;
    // registry-driven completeness is covered in a dedicated #784 test.
    listOuterHostIds: () => ["claude", "codex", "opencode"],
    ...overrides,
  };
}

const FAKE_CORE_PATH = "/usr/local/lib/node_modules/pipeline/core";
const FAKE_VERSION = "1.4.0";
const OPENCODE_ABSENT = { available: false, cliBin: null, skillPath: null } as const;

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
  // OpenCode is additive and must not flip hostCoverage (#861).
  assert.equal(result.hosts.opencode.available, false);
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

test("discoverHosts: OpenCode skill alone does not invent Claude/Codex coverage (#861)", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => null,
      which: async () => null,
      probeOpenCodeSkill: async () => "/home/u/.config/opencode/skills/pipeline",
    }),
  );
  assert.equal(result.hostCoverage, "missing");
  assert.equal(result.hosts.opencode.available, true);
  assert.equal(result.hosts.opencode.skillPath, "/home/u/.config/opencode/skills/pipeline");
  assert.equal(result.hosts.claude.available, false);
  assert.equal(result.hosts.codex.available, false);
});

test("discoverHosts: OpenCode present with both CLIs keeps hostCoverage=both (#861)", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => `/usr/local/bin/${cmd}`,
      probeOpenCodeSkill: async () => "/tmp/opencode/skills/pipeline",
    }),
  );
  assert.equal(result.hostCoverage, "both");
  assert.equal(result.hosts.opencode.available, true);
  assert.equal(result.hosts.opencode.cliBin, "/usr/local/bin/opencode");
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

test("handlePathSubcommand: succeeds without .github/pipeline.yml (#1240)", async (t) => {
  const fakeResult: DiscoveryResult = {
    corePath: FAKE_CORE_PATH,
    version: FAKE_VERSION,
    hostCoverage: "both",
    hosts: {
      claude: { available: true, cliBin: "/usr/bin/claude" },
      codex: { available: true, cliBin: "/usr/bin/codex" },
      opencode: { ...OPENCODE_ABSENT },
    },
  };
  const logged: string[] = [];
  t.mock.method(console, "log", (msg: string) => logged.push(msg));
  const deps: PathSubcommandDeps = {
    discoverHosts: async () => fakeResult,
  };
  await handlePathSubcommand({ json: true }, deps);
  assert.equal(logged.length, 1);
  assert.doesNotThrow(() => JSON.parse(logged[0]!));
});

test("handlePathSubcommand --json: serialises DiscoveryResult as valid JSON", async (t) => {
  const fakeResult: DiscoveryResult = {
    corePath: FAKE_CORE_PATH,
    version: FAKE_VERSION,
    hostCoverage: "both",
    hosts: {
      claude: { available: true, cliBin: "/usr/bin/claude" },
      codex: { available: true, cliBin: "/usr/bin/codex" },
      opencode: { ...OPENCODE_ABSENT },
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
      opencode: { ...OPENCODE_ABSENT },
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
      hosts: {
        claude: { available: false, cliBin: null },
        codex: { available: false, cliBin: null },
        opencode: { ...OPENCODE_ABSENT },
      },
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
      opencode: { ...OPENCODE_ABSENT },
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

// ---------------------------------------------------------------------------
// 7. Outer-host registry enumeration (#784)
// ---------------------------------------------------------------------------

test("discoverHosts: registry-driven listing includes synthetic host without built-in table edit (#784)", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => (cmd === "claude" || cmd === "codex" ? `/usr/bin/${cmd}` : null),
      listOuterHostIds: () => ["claude", "codex", "opencode", "synth-third-party"],
    }),
  );
  assert.equal(result.hostCoverage, "both", "legacy hostCoverage must stay Claude/Codex-only");
  assert.ok(result.registeredOuterHosts?.includes("synth-third-party"));
  assert.ok(result.hosts["synth-third-party"], "synthetic host must appear in hosts map");
  assert.equal(result.hosts["synth-third-party"].available, false);
  assert.equal(result.hosts["synth-third-party"].cliBin, null);
});

test("discoverHosts: extra registered hosts do not redefine hostCoverage enum (#784)", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null),
      listOuterHostIds: () => ["claude", "codex", "grok", "opencode", "synth-x"],
    }),
  );
  assert.equal(result.hostCoverage, "claude-only");
  assert.ok(result.hosts.grok || result.registeredOuterHosts?.includes("grok"));
});

// ---------------------------------------------------------------------------
// 8. Manifest-driven discovery probes (#784) — skill_path vs which <host-id>
// ---------------------------------------------------------------------------

const GROK_MANIFEST_MIN = {
  manifestVersion: 1,
  id: "grok",
  displayName: "Grok Build",
  origin: "builtin" as const,
  install: {
    support: "supported" as const,
    mode: "symlink-claude" as const,
    basePath: { env: null, defaultHomeSegments: [".grok"] as const },
    skillsRelative: ["skills"] as const,
    skillDirName: "pipeline",
    overlayDir: "hosts/claude",
    overlayFiles: [] as const,
    overlayDirs: [] as const,
    managedArtifacts: {
      skillTree: true,
      commandsGlob: null,
      commandsDirRelative: null,
      commandsKind: "none" as const,
    },
    userOwnedExclusion: "symlink only",
    postInstall: "n/a",
    installOrder: 40,
  },
  invocation: {
    support: "supported" as const,
    skillPathHint: "~/.grok/skills/pipeline",
    commandSurface: "pipeline skill",
    discoveryProbe: "test -L ~/.grok/skills/pipeline || test -d ~/.grok/skills/pipeline",
    discovery: { kind: "skill_path" as const },
  },
  early_run_handoff: { support: "supported" as const, how: "handoff" },
  event_follow: { support: "supported" as const, how: "follow" },
  reattach: { support: "supported" as const, how: "reattach" },
  wait_cancel: {
    support: "supported" as const,
    classification: "non_terminal" as const,
    recovery: "reattach_or_portable_follow" as const,
    how: "non-terminal",
  },
  material_progress_notify: {
    support: "supported" as const,
    how: "monitor",
    mapping: {
      surface: "grok_monitor_lines" as const,
      tools: ["monitor"] as const,
      filter: "scripts/material-filter.mjs",
    },
    fallback: "stdout",
  },
  terminal_cleanup: { support: "supported" as const, how: "stop" },
  terminal_summary: { support: "supported" as const, how: "summary" },
};

test("discoverHosts: Grok is available via skill_path probe without a grok CLI (#784)", async () => {
  const grokSkill = "/home/u/.grok/skills/pipeline";
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      // No `grok` binary — the pre-fix bug used which("grok") and reported unavailable.
      which: async (cmd) =>
        cmd === "claude" || cmd === "codex" ? `/usr/bin/${cmd}` : null,
      listOuterHostIds: () => ["claude", "codex", "grok", "opencode"],
      resolveOuterHost: (id) => (id === "grok" ? (GROK_MANIFEST_MIN as never) : null),
      skillPathPresent: (p) => p === grokSkill,
      homeDir: () => "/home/u",
      envGet: () => undefined,
    }),
  );
  assert.equal(result.hosts.grok.available, true, "installed Grok skill path must mark available");
  assert.equal(
    (result.hosts.grok as { skillPath?: string | null }).skillPath,
    grokSkill,
  );
  assert.equal(result.hosts.grok.cliBin, null, "skill_path probe must not invent a grok CLI");
  assert.equal(result.hostCoverage, "both", "Grok must not redefine hostCoverage");
});

test("discoverHosts: Grok skill_path absent → available false even when which(grok) would not run (#784)", async () => {
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async () => null,
      listOuterHostIds: () => ["claude", "codex", "grok", "opencode"],
      resolveOuterHost: (id) => (id === "grok" ? (GROK_MANIFEST_MIN as never) : null),
      skillPathPresent: () => false,
      homeDir: () => "/home/u",
      envGet: () => undefined,
    }),
  );
  assert.equal(result.hosts.grok.available, false);
  assert.equal((result.hosts.grok as { skillPath?: string | null }).skillPath, null);
});

test("discoverHosts: which_or_skill_path host available from skill when CLI missing (#784)", async () => {
  const skill = "/home/u/.ext/skills/pipeline";
  const ext = {
    ...GROK_MANIFEST_MIN,
    id: "ext-host",
    displayName: "Ext",
    install: {
      ...GROK_MANIFEST_MIN.install,
      mode: "tree" as const,
      basePath: { env: null, defaultHomeSegments: [".ext"] as const },
    },
    invocation: {
      ...GROK_MANIFEST_MIN.invocation,
      discoveryProbe: "which ext-host or skill path",
      discovery: { kind: "which_or_skill_path" as const, whichCommand: "ext-host" },
    },
  };
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async () => null,
      listOuterHostIds: () => ["claude", "codex", "opencode", "ext-host"],
      resolveOuterHost: (id) => (id === "ext-host" ? (ext as never) : null),
      skillPathPresent: (p) => p === skill,
      homeDir: () => "/home/u",
      envGet: () => undefined,
    }),
  );
  assert.equal(result.hosts["ext-host"].available, true);
  assert.equal((result.hosts["ext-host"] as { skillPath?: string | null }).skillPath, skill);
});

// ---------------------------------------------------------------------------
// #784 review-2: alternateHomeSegments (Codex ~/.agents) must not false-negative
// ---------------------------------------------------------------------------

const CODEX_MANIFEST_MIN = {
  manifestVersion: 1 as const,
  id: "codex-alt",
  displayName: "Codex Alternate",
  origin: "extension" as const,
  install: {
    support: "supported" as const,
    mode: "tree" as const,
    basePath: {
      env: "CODEX_HOME" as string | null,
      defaultHomeSegments: [".codex"] as const,
      alternateHomeSegments: [".agents"] as const,
      skillsUnderBase: true,
    },
    skillsRelative: ["skills"] as const,
    skillDirName: "pipeline",
    overlayDir: "",
    overlayFiles: [] as const,
    overlayDirs: [] as const,
    managedArtifacts: {
      skillTree: true,
      commandsGlob: null,
      commandsDirRelative: ["agents"] as const,
      commandsKind: "codex-prompt" as const,
    },
    userOwnedExclusion: "managed only",
    postInstall: "restart",
    installOrder: 20,
  },
  invocation: {
    support: "supported" as const,
    skillPathHint: "~/.codex/skills/pipeline",
    commandSurface: "$pipeline",
    discoveryProbe: "skill path",
    discovery: { kind: "skill_path" as const },
  },
  early_run_handoff: { support: "supported" as const, how: "handoff" },
  event_follow: { support: "supported" as const, how: "follow" },
  reattach: { support: "supported" as const, how: "reattach" },
  wait_cancel: {
    support: "supported" as const,
    classification: "non_terminal" as const,
    recovery: "reattach_or_portable_follow" as const,
    how: "non-terminal",
  },
  material_progress_notify: {
    support: "supported" as const,
    how: "status",
    mapping: {
      surface: "codex_chat_status" as const,
      tools: ["chat"] as const,
      filter: "scripts/material-filter.mjs",
    },
    fallback: "stdout",
  },
  terminal_cleanup: { support: "supported" as const, how: "stop" },
  terminal_summary: { support: "supported" as const, how: "summary" },
};

test("resolveManifestSkillPath: prefers .agents skill when primary .codex is absent (#784)", () => {
  const agentsSkill = "/home/u/.agents/skills/pipeline";
  const resolved = resolveManifestSkillPath(CODEX_MANIFEST_MIN as never, {
    homeDir: () => "/home/u",
    envGet: () => undefined,
    pathPresent: (p) => p === agentsSkill || p === "/home/u/.agents",
  });
  assert.equal(resolved, agentsSkill);
});

test("discoverHosts: skill_path-only install under alternateHomeSegments is available (#784)", async () => {
  const agentsSkill = "/home/u/.agents/skills/pipeline";
  const result = await discoverHosts(
    makeDeps({
      probeCandidates: async () => FAKE_CORE_PATH,
      readVersion: async () => FAKE_VERSION,
      which: async () => null,
      listOuterHostIds: () => ["claude", "codex", "opencode", "codex-alt"],
      resolveOuterHost: (id) =>
        id === "codex-alt" ? (CODEX_MANIFEST_MIN as never) : null,
      // Only alternate skill tree present — primary ~/.codex/skills/pipeline missing.
      skillPathPresent: (p) => p === agentsSkill || p === "/home/u/.agents",
      homeDir: () => "/home/u",
      envGet: () => undefined,
    }),
  );
  assert.equal(
    result.hosts["codex-alt"].available,
    true,
    "alternate-path-only install must not false-negative",
  );
  assert.equal(
    (result.hosts["codex-alt"] as { skillPath?: string | null }).skillPath,
    agentsSkill,
  );
});

test("resolveManifestSkillPath: env override still wins over alternate (#784)", () => {
  const resolved = resolveManifestSkillPath(CODEX_MANIFEST_MIN as never, {
    homeDir: () => "/home/u",
    envGet: (k) => (k === "CODEX_HOME" ? "/custom/codex" : undefined),
    pathPresent: () => false,
  });
  assert.equal(resolved, "/custom/codex/skills/pipeline");
});
