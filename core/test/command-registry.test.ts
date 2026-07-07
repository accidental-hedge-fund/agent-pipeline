// Unit tests for command-registry.ts (#263).
//
// Covers:
//   2.1  Coverage guard: every recognized dispatch keyword has a registry entry.
//   2.2  merge entry shape: mutatesGitHub=true, allowedFlags excludes json/isOk/detach/jsonEvents.
//   2.3  lookupCommand: undefined and numeric strings → advance entry (allowedFlags: "all").
//   2.4  lookupCommand: unknown keyword → null.
//   2.5  validateFlags: returns offending key when flag is not in allowlist and is "cli"-sourced.
//   2.6  validateFlags: advance entry returns [] (allowedFlags: "all").
//   2.7  Cross-check: every attribute name in every allowedFlags Set exists in buildCmd().options.
//   2.8  needsIssueNumber: true only for advance and run; false for all named sub-commands.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_REGISTRY,
  lookupCommand,
  validateFlags,
  UNIVERSAL_FLAGS,
  type CommandEntry,
} from "../scripts/command-registry.ts";
import { buildCmd } from "../scripts/pipeline.ts";

// ---------------------------------------------------------------------------
// 2.1  Coverage guard
// ---------------------------------------------------------------------------

// These are the named keywords the dispatch block in pipeline.ts recognizes.
const DISPATCH_KEYWORDS = [
  "init", "doctor", "status", "unblock", "override", "cleanup",
  "release", "intake", "sweep", "triage", "merge",
  "refine-spec", "logs", "summary", "path", "config", "run", "improve",
  "scoreboard", "roadmap",
];

test("command-registry: every recognized dispatch keyword has a registry entry", () => {
  for (const kw of DISPATCH_KEYWORDS) {
    assert.ok(
      kw in COMMAND_REGISTRY,
      `keyword "${kw}" is recognized by the dispatch block but has no COMMAND_REGISTRY entry`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2.2  merge entry shape
// ---------------------------------------------------------------------------

test("command-registry: merge entry has mutatesGitHub:true", () => {
  assert.equal(COMMAND_REGISTRY.merge.mutatesGitHub, true);
});

test("command-registry: merge allowedFlags does not include jsonEvents, detach, json, isOk", () => {
  const af = COMMAND_REGISTRY.merge.allowedFlags;
  assert.notEqual(af, "all", "merge must have an explicit allowedFlags Set, not 'all'");
  const set = af as Set<string>;
  for (const forbidden of ["jsonEvents", "detach", "json", "isOk"]) {
    assert.equal(
      set.has(forbidden),
      false,
      `merge.allowedFlags must not contain "${forbidden}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2.3  lookupCommand: numeric / undefined → advance entry
// ---------------------------------------------------------------------------

test("command-registry: lookupCommand(undefined) returns advance entry", () => {
  const entry = lookupCommand(undefined);
  assert.ok(entry !== null, "should return advance entry, not null");
  assert.equal(entry, COMMAND_REGISTRY.advance);
  assert.equal(entry.allowedFlags, "all");
});

test("command-registry: lookupCommand('123') returns advance entry", () => {
  const entry = lookupCommand("123");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.advance);
  assert.equal(entry.allowedFlags, "all");
});

test("command-registry: lookupCommand('0') returns advance entry", () => {
  const entry = lookupCommand("0");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.advance);
});

// ---------------------------------------------------------------------------
// 2.4  lookupCommand: unknown keyword → null
// ---------------------------------------------------------------------------

test("command-registry: lookupCommand('unknown-cmd') returns null", () => {
  assert.equal(lookupCommand("unknown-cmd"), null);
});

test("command-registry: lookupCommand('') returns null (empty string is not numeric, not registered)", () => {
  assert.equal(lookupCommand(""), null);
});

// ---------------------------------------------------------------------------
// 2.5  validateFlags: returns offending key for non-allowlisted "cli"-sourced flag
// ---------------------------------------------------------------------------

/** Build a minimal CmdLike with one explicit CLI flag. */
function fakeCmdWithCliFlag(flagKey: string): { options: { attributeName(): string }[]; getOptionValueSource(k: string): string } {
  return {
    options: [
      { attributeName: () => flagKey },
    ],
    getOptionValueSource: (k: string) => (k === flagKey ? "cli" : "default"),
  };
}

test("command-registry: validateFlags returns offending key when flag is outside allowlist", () => {
  const entry = COMMAND_REGISTRY.merge;
  const cmd = fakeCmdWithCliFlag("jsonEvents"); // not in merge's allowlist
  const offending = validateFlags(entry, cmd);
  assert.deepEqual(offending, ["jsonEvents"]);
});

test("command-registry: validateFlags returns [] when flag is inside allowlist", () => {
  const entry = COMMAND_REGISTRY.merge;
  const cmd = fakeCmdWithCliFlag("repoPath"); // in merge's allowlist
  const offending = validateFlags(entry, cmd);
  assert.deepEqual(offending, []);
});

test("command-registry: validateFlags returns [] when flag is default-sourced (not explicitly CLI-set)", () => {
  const entry = COMMAND_REGISTRY.doctor;
  const cmd = {
    options: [{ attributeName: () => "cleanup" }],
    getOptionValueSource: (_k: string) => "default" as string,
  };
  assert.deepEqual(validateFlags(entry, cmd), []);
});

// ---------------------------------------------------------------------------
// 2.6  validateFlags: advance entry with allowedFlags:"all" always returns []
// ---------------------------------------------------------------------------

test("command-registry: validateFlags returns [] for advance entry (allowedFlags:all)", () => {
  const entry = COMMAND_REGISTRY.advance;
  const cmd = fakeCmdWithCliFlag("jsonEvents");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("command-registry: validateFlags returns [] for run entry (allowedFlags:all)", () => {
  const entry = COMMAND_REGISTRY.run;
  const cmd = fakeCmdWithCliFlag("model");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

// ---------------------------------------------------------------------------
// 2.7  Cross-check: attribute names in every allowedFlags Set exist in buildCmd()
// ---------------------------------------------------------------------------

test("command-registry: every attribute name in every allowedFlags Set exists in buildCmd().options", () => {
  const cmd = buildCmd();
  const knownAttrNames = new Set(cmd.options.map((o) => o.attributeName()));

  const stale: Array<{ command: string; attr: string }> = [];
  for (const [keyword, entry] of Object.entries(COMMAND_REGISTRY)) {
    if (entry.allowedFlags === "all") continue;
    for (const attr of entry.allowedFlags) {
      if (!knownAttrNames.has(attr)) {
        stale.push({ command: keyword, attr });
      }
    }
  }

  assert.deepEqual(
    stale,
    [],
    `Stale attribute names in COMMAND_REGISTRY allowedFlags sets: ${JSON.stringify(stale)}`,
  );
});

// ---------------------------------------------------------------------------
// 2.8  needsIssueNumber: advance and run require an issue number; named sub-commands do not
// ---------------------------------------------------------------------------

test("command-registry: needsIssueNumber is true for advance, run, status, unblock, override", () => {
  assert.equal(COMMAND_REGISTRY.advance.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.run.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.status.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.unblock.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.override.needsIssueNumber, true);
});

test("command-registry: needsIssueNumber is false for named sub-commands that operate without an issue", () => {
  // Commands that act on the repo/environment, not a specific issue.
  const issueAgnosticKeys = [
    "init", "doctor", "cleanup", "release", "intake", "sweep",
    "triage", "merge", "refine-spec", "logs", "summary", "path",
    "config", "improve", "scoreboard", "roadmap",
  ];
  for (const key of issueAgnosticKeys) {
    const entry = COMMAND_REGISTRY[key as keyof typeof COMMAND_REGISTRY] as CommandEntry | undefined;
    assert.ok(entry !== undefined, `Expected COMMAND_REGISTRY to have key "${key}"`);
    assert.equal(
      entry.needsIssueNumber,
      false,
      `${key}.needsIssueNumber should be false`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2.9  lookupCommand: new keyword entries resolve correctly
// ---------------------------------------------------------------------------

test("command-registry: lookupCommand('status') returns status entry with needsIssueNumber:true", () => {
  const entry = lookupCommand("status");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.status);
  assert.equal(entry.needsIssueNumber, true);
  assert.equal(entry.mutatesGitHub, false);
});

test("command-registry: lookupCommand('unblock') returns unblock entry with needsIssueNumber:true", () => {
  const entry = lookupCommand("unblock");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.unblock);
  assert.equal(entry.needsIssueNumber, true);
  assert.equal(entry.mutatesGitHub, true);
});

test("command-registry: lookupCommand('override') returns override entry with needsIssueNumber:true", () => {
  const entry = lookupCommand("override");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.override);
  assert.equal(entry.needsIssueNumber, true);
  assert.equal(entry.allowedFlags, "all");
});

test("command-registry: lookupCommand('cleanup') returns cleanup entry with needsIssueNumber:false", () => {
  const entry = lookupCommand("cleanup");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.cleanup);
  assert.equal(entry.needsIssueNumber, false);
});

// ---------------------------------------------------------------------------
// 2.10  UNIVERSAL_FLAGS: host-injected --profile tolerated on every command (#383)
// ---------------------------------------------------------------------------

test("command-registry: UNIVERSAL_FLAGS contains 'profile'", () => {
  assert.ok(
    UNIVERSAL_FLAGS.has("profile"),
    "UNIVERSAL_FLAGS must contain 'profile' so the host-injected flag is tolerated everywhere",
  );
});

// Mirrors hosts/_shared/entry.template.mjs: `[...passthrough, "--profile", PROFILE]`.
// The wrapper injects --profile into every invocation unless the caller already
// passed one, regardless of whether the target command declares it.
const PROFILE_FREE_COMMANDS = ["refine-spec", "scoreboard", "release"];

for (const keyword of PROFILE_FREE_COMMANDS) {
  test(`command-registry: wrapper-injected --profile is tolerated on '${keyword}' (does not reject on profile)`, () => {
    const entry = COMMAND_REGISTRY[keyword];
    assert.ok(entry, `expected a registry entry for "${keyword}"`);
    assert.notEqual(
      entry.allowedFlags,
      "all",
      `"${keyword}" should have an explicit allowedFlags set for this test to be meaningful`,
    );
    assert.equal(
      (entry.allowedFlags as Set<string>).has("profile"),
      false,
      `"${keyword}" should not need to declare "profile" in allowedFlags — UNIVERSAL_FLAGS covers it`,
    );
    const cmd = fakeCmdWithCliFlag("profile");
    const offending = validateFlags(entry, cmd);
    assert.deepEqual(
      offending,
      [],
      `wrapper-injected --profile must not be reported as offending for "${keyword}"`,
    );
  });
}

test("command-registry: a genuinely unsupported flag on a profile-free command is still rejected", () => {
  const entry = COMMAND_REGISTRY.scoreboard;
  const cmd = fakeCmdWithCliFlag("bogus");
  assert.deepEqual(validateFlags(entry, cmd), ["bogus"]);
});
