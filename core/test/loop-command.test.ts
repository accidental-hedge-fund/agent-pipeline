// Tests for `pipeline loop ...` CLI dispatch (#451): runLoopCommand wraps
// runLoopPreflight with a JSON success envelope / non-zero failure exit, and
// buildCmd()/COMMAND_REGISTRY expose the loop flags and dispatch keyword.
// The injected LoopCliDeps means no real goal-loop discovery, gh, or engine
// binary is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoopCommand, buildCmd, type CliOpts, type LoopCliDeps } from "../scripts/pipeline.ts";
import type { LoopPreflightOutcome } from "../scripts/loop-preflight.ts";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";

async function withCapturedConsole(fn: () => Promise<void>): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

test("runLoopCommand — preflight failure exits non-zero with remediation, prints no JSON", async () => {
  let calls = 0;
  const deps: LoopCliDeps = {
    runLoopPreflight: async () => {
      calls++;
      return {
        ok: false,
        failedCheck: "loop:contract-coherence",
        detail: "no installed goal-loop skill could be discovered",
        remediation: "Install goal-loop.",
      } satisfies LoopPreflightOutcome;
    },
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() => runLoopCommand({ milestone: "v2" } as CliOpts, [], deps));
  assert.equal(calls, 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.equal(out.length, 0, "no JSON handoff is printed on a failing preflight");
  assert.match(err.join("\n"), /loop:contract-coherence/);
  assert.match(err.join("\n"), /Install goal-loop/);
});

test("runLoopCommand — success prints a JSON handoff envelope and exits 0", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "milestone", value: "v2" }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
  };
  process.exitCode = undefined;
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 0);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.engine, "claude");
  assert.deepEqual(parsed.selector, { type: "milestone", value: "v2" });
  assert.equal(parsed.resume_run_id, null);
  assert.equal(parsed.audit, false);
});

test("runLoopCommand — engine defaults to codex when --profile is absent (matches the CLI's own default)", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({ ok: true, args: { selector: undefined, resumeRunId: "run-1", audit: true } }) satisfies LoopPreflightOutcome,
  };
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ resume: "run-1", audit: true } as CliOpts, [], deps),
  );
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.engine, "codex");
  assert.equal(parsed.resume_run_id, "run-1");
  assert.equal(parsed.audit, true);
});

// ---------------------------------------------------------------------------
// CLI surface plumbing
// ---------------------------------------------------------------------------

test("buildCmd — declares every loop flag attribute referenced by COMMAND_REGISTRY.loop", () => {
  const cmd = buildCmd();
  const known = new Set(cmd.options.map((o) => o.attributeName()));
  const loopEntry = COMMAND_REGISTRY.loop;
  assert.ok(loopEntry, "COMMAND_REGISTRY must have a loop entry");
  assert.ok(loopEntry.allowedFlags instanceof Set);
  for (const flag of loopEntry.allowedFlags as Set<string>) {
    if (flag === "profile") continue; // universal flag, asserted elsewhere
    assert.ok(known.has(flag), `buildCmd() is missing a Commander option for loop flag "${flag}"`);
  }
});

test("COMMAND_REGISTRY.loop — needs no config, no gh auth, and mutates nothing", () => {
  const loopEntry = COMMAND_REGISTRY.loop;
  assert.equal(loopEntry.needsIssueNumber, false);
  assert.equal(loopEntry.needsConfig, false);
  assert.equal(loopEntry.needsGhAuth, false);
  assert.equal(loopEntry.mutatesGitHub, false);
});
