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
  "release", "intake", "sweep", "triage", "merge", "merge-queue",
  "refine-spec", "logs", "summary", "path", "config", "run", "single", "improve",
  "scoreboard", "roadmap", "loop", "correction", "report",
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
// 2.7b  loop: --new-run is accepted by flag validation (#610); bidirectional
// sync guard so a registered `loop:`-namespaced option can never again drift
// out of the loop allowlist unnoticed (the one-directional 2.7 cross-check
// above only catches a stale allowlist entry, not a missing one).
// ---------------------------------------------------------------------------

test("command-registry: loop.allowedFlags includes newRun (#610)", () => {
  const entry = COMMAND_REGISTRY.loop;
  assert.ok((entry.allowedFlags as Set<string>).has("newRun"));
  const cmd = fakeCmdWithCliFlag("newRun");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("command-registry: loop.allowedFlags includes follow, events, untilTerminal for nested loop logs (#666/#699)", () => {
  const entry = COMMAND_REGISTRY.loop;
  const flags = entry.allowedFlags as Set<string>;
  assert.ok(flags.has("follow"));
  assert.ok(flags.has("events"));
  assert.ok(flags.has("untilTerminal"), "until-terminal / --no-until-terminal (#699)");
  assert.deepEqual(validateFlags(entry, fakeCmdWithCliFlag("follow")), []);
  assert.deepEqual(validateFlags(entry, fakeCmdWithCliFlag("events")), []);
  assert.deepEqual(validateFlags(entry, fakeCmdWithCliFlag("untilTerminal")), []);
});

test("command-registry: logs.allowedFlags includes untilTerminal for advance events follow (#725)", () => {
  const entry = COMMAND_REGISTRY.logs;
  const flags = entry.allowedFlags as Set<string>;
  assert.ok(flags.has("follow"));
  assert.ok(flags.has("events"));
  assert.ok(flags.has("untilTerminal"), "until-terminal / --no-until-terminal on advance logs (#725)");
  assert.deepEqual(validateFlags(entry, fakeCmdWithCliFlag("untilTerminal")), []);
});

test("command-registry: every 'loop:'-namespaced registered option is in the loop allowlist", () => {
  const cmd = buildCmd();
  const loopOptions = cmd.options.filter((o) => (o as { description?: string }).description?.startsWith("loop:"));
  assert.ok(loopOptions.length > 0, "expected at least one 'loop:'-namespaced option to be registered");

  const allowed = COMMAND_REGISTRY.loop.allowedFlags as Set<string>;
  const missing = loopOptions
    .map((o) => o.attributeName())
    .filter((attr) => !allowed.has(attr));

  assert.deepEqual(
    missing,
    [],
    `'loop:'-namespaced options missing from COMMAND_REGISTRY.loop.allowedFlags: ${JSON.stringify(missing)}`,
  );
});

// ---------------------------------------------------------------------------
// 2.8  issue-scoped commands require an issue number; repo-scoped commands do not
// ---------------------------------------------------------------------------

test("command-registry: needsIssueNumber is true for issue-scoped commands", () => {
  assert.equal(COMMAND_REGISTRY.advance.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.run.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.single.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.status.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.unblock.needsIssueNumber, true);
  assert.equal(COMMAND_REGISTRY.override.needsIssueNumber, true);
});

test("command-registry: needsIssueNumber is false for named sub-commands that operate without an issue", () => {
  // Commands that act on the repo/environment, not a specific issue.
  const issueAgnosticKeys = [
    "init", "doctor", "cleanup", "release", "intake", "sweep",
    "triage", "merge", "merge-queue", "refine-spec", "logs", "summary", "path",
    "config", "improve", "scoreboard", "roadmap", "correction",
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

test("command-registry: merge-queue entry is an operator-authorized sequential merge surface (#676)", () => {
  const entry = COMMAND_REGISTRY["merge-queue"];
  assert.ok(entry, "merge-queue must be registered");
  assert.equal(entry.needsIssueNumber, false);
  // mutatesGitHub true: --apply performs sequential merges; dry-run is default but not exclusive.
  assert.equal(entry.mutatesGitHub, true);
  assert.equal(entry.needsConfig, true);
  assert.equal(entry.needsGhAuth, true);
  assert.notEqual(entry.allowedFlags, "all");
  const flags = entry.allowedFlags as Set<string>;
  for (const required of [
    "milestone",
    "dryRun",
    "repoPath",
    "base",
    "profile",
    "apply",
    "releaseWhenComplete",
    "releaseVersion",
  ]) {
    assert.ok(flags.has(required), `merge-queue.allowedFlags must include ${required}`);
  }
  assert.equal(lookupCommand("merge-queue"), entry);
});

test("command-registry: merge-queue rejects unsupported flags via validateFlags", () => {
  const entry = COMMAND_REGISTRY["merge-queue"];
  const offending = validateFlags(entry, fakeCmdWithCliFlag("jsonEvents"));
  assert.deepEqual(offending, ["jsonEvents"]);
  assert.deepEqual(validateFlags(entry, fakeCmdWithCliFlag("milestone")), []);
  assert.deepEqual(validateFlags(entry, fakeCmdWithCliFlag("dryRun")), []);
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

test("command-registry: scoreboard.allowedFlags includes bucket (#425)", () => {
  const entry = COMMAND_REGISTRY.scoreboard;
  assert.ok((entry.allowedFlags as Set<string>).has("bucket"));
  const cmd = fakeCmdWithCliFlag("bucket");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("command-registry: scoreboard.allowedFlags includes by (#437)", () => {
  const entry = COMMAND_REGISTRY.scoreboard;
  assert.ok((entry.allowedFlags as Set<string>).has("by"));
  const cmd = fakeCmdWithCliFlag("by");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("command-registry: scoreboard.allowedFlags includes html (#427)", () => {
  const entry = COMMAND_REGISTRY.scoreboard;
  assert.ok((entry.allowedFlags as Set<string>).has("html"));
  const cmd = fakeCmdWithCliFlag("html");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

// ---------------------------------------------------------------------------
// papercut (#419) — registered, agent-facing, hidden from --help
// ---------------------------------------------------------------------------

test("command-registry: papercut is registered with needsIssueNumber:false and needsGhAuth:false", () => {
  const entry = COMMAND_REGISTRY.papercut;
  assert.ok(entry !== undefined);
  assert.equal(entry.needsIssueNumber, false);
  assert.equal(entry.needsGhAuth, false);
  assert.equal(entry.mutatesGitHub, false);
  assert.equal(entry.supportsJson, true);
  for (const flag of ["repoPath", "profile", "run", "message", "since", "until", "json"]) {
    assert.ok(
      (entry.allowedFlags as Set<string>).has(flag) || UNIVERSAL_FLAGS.has(flag),
      `papercut.allowedFlags should include "${flag}"`,
    );
  }
});

test("command-registry: lookupCommand('papercut') returns the papercut entry", () => {
  const entry = lookupCommand("papercut");
  assert.equal(entry, COMMAND_REGISTRY.papercut);
});

test("pipeline --help output contains no papercut entry", async () => {
  const { buildCmd } = await import("../scripts/pipeline.ts");
  const help = buildCmd().helpInformation();
  assert.ok(
    !/\bpapercut\b/.test(help),
    `--help output should not mention "papercut":\n${help}`,
  );
});
