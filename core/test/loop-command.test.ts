// Tests for `pipeline loop ...` CLI dispatch (#451): runLoopCommand wraps
// runLoopPreflight with a JSON success envelope / non-zero failure exit, and
// buildCmd()/COMMAND_REGISTRY expose the loop flags and dispatch keyword.
// The injected LoopCliDeps means no real goal-loop discovery, gh, or engine
// binary is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runLoopCommand, buildCmd, decideNewRunSupersession, planSupersessionMintRepair, type CliOpts, type LoopCliDeps } from "../scripts/pipeline.ts";
import { runLoopPreflight as realRunLoopPreflight, type LoopPreflightOutcome } from "../scripts/loop-preflight.ts";
import type { DoctorDeps } from "../scripts/stages/doctor.ts";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loop-command-test-"));

/** A repo with no gh reachable — resolveLoopNativeGoalAttestation only ever
 *  reads `.github/pipeline.yml` off disk, so no fake `gh` stub is needed. */
function makeFakeRepo(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (content !== null) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "pipeline.yml"), content);
  }
  return dir;
}

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

const NEVER_CALLED_ENGINE = async (): Promise<never> => {
  throw new Error("runLoopEngine must not be called when the preflight fails or short-circuits");
};

function fakeAuditReport(runId: string) {
  return {
    run_id: runId,
    process: null,
    action_evidence: [],
    consecutive_no_progress: 0,
    stop: null,
    status: { run_id: runId } as unknown,
  };
}

test("runLoopCommand — preflight failure exits non-zero with remediation, prints no JSON", async () => {
  let calls = 0;
  const deps: LoopCliDeps = {
    runLoopPreflight: async () => {
      calls++;
      return {
        ok: false,
        failedCheck: "loop:store-schema-compatibility",
        detail: "no installed goal-loop skill could be discovered",
        remediation: "Install goal-loop.",
      } satisfies LoopPreflightOutcome;
    },
    runLoopEngine: NEVER_CALLED_ENGINE,
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() => runLoopCommand({ milestone: "v2" } as CliOpts, [], deps));
  assert.equal(calls, 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.equal(out.length, 0, "no JSON handoff is printed on a failing preflight");
  assert.match(err.join("\n"), /loop:store-schema-compatibility/);
  assert.match(err.join("\n"), /Install goal-loop/);
});

test("runLoopCommand — success drives the supervisor and prints its result as JSON, exiting 0", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async (input) => {
      assert.equal(input.engine, "claude");
      assert.deepEqual(input.selector, { type: "work-list", value: ["100"] });
      return {
        kind: "drive",
        result: { runId: "loop-abc123", cycles: 2, stop: null, holdOutstanding: false, allDone: true, resumed: false },
      };
    },
  };
  process.exitCode = undefined;
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 0);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.engine, "claude");
  assert.equal(parsed.run_id, "loop-abc123");
  assert.equal(parsed.all_done, true);
  assert.equal(parsed.stop, null);
});

test("runLoopCommand — a run-engine error (e.g. an unsupported selector type) exits non-zero", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "milestone", value: "v2" }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async () => ({ kind: "error", message: "unsupported selector" }),
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.equal(out.length, 0);
  assert.match(err.join("\n"), /unsupported selector/);
});

test("runLoopCommand — an invalid loop.native_goal_attestation value fails closed before the preflight runs (#506)", async () => {
  let calls = 0;
  const deps: LoopCliDeps = {
    runLoopPreflight: async () => {
      calls++;
      return { ok: true, args: { selector: undefined, resumeRunId: undefined, audit: true } } satisfies LoopPreflightOutcome;
    },
    runLoopEngine: NEVER_CALLED_ENGINE,
  };
  const repoPath = makeFakeRepo("loop:\n  native_goal_attestation: sometimes\n");
  process.exitCode = undefined;
  const { err } = await withCapturedConsole(() =>
    runLoopCommand({ audit: true, repoPath } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.equal(calls, 0, "preflight must not run when the attestation config itself is invalid");
  assert.match(err.join("\n"), /native_goal_attestation/);
});

test("runLoopCommand — threads the resolved attestation from pipeline.yml into runLoopPreflight (#506)", async () => {
  let receivedAttestation: unknown;
  const deps: LoopCliDeps = {
    runLoopPreflight: async (_raw, _engine, _doctorDeps, _roots, attestation) => {
      receivedAttestation = attestation;
      return { ok: true, args: { selector: undefined, resumeRunId: "run-1", audit: true } } satisfies LoopPreflightOutcome;
    },
    runLoopEngine: async () => ({ kind: "audit", report: fakeAuditReport("run-1") }),
  };
  const repoPath = makeFakeRepo("loop:\n  native_goal_attestation: available\n");
  process.exitCode = undefined;
  await withCapturedConsole(() => runLoopCommand({ audit: true, repoPath } as CliOpts, [], deps));
  assert.equal(process.exitCode, 0);
  process.exitCode = 0;
  assert.equal(receivedAttestation, "available");
});

test("runLoopCommand — engine defaults to codex when --profile is absent (matches the CLI's own default)", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({ ok: true, args: { selector: undefined, resumeRunId: "run-1", audit: true } }) satisfies LoopPreflightOutcome,
    runLoopEngine: async (input) => {
      assert.equal(input.resumeRunId, "run-1");
      assert.equal(input.audit, true);
      return { kind: "audit", report: fakeAuditReport("run-1") };
    },
  };
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ resume: "run-1", audit: true } as CliOpts, [], deps),
  );
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.engine, "codex");
  assert.equal(parsed.run_id, "run-1");
});

// ---------------------------------------------------------------------------
// 6.8 — a host with no goal-loop skill installed at any root still starts and
// runs, end to end through runLoopCommand (real runLoopPreflight, fake
// DoctorDeps, fake supervisor drive) — no external-skill subprocess recorded
// on any path.
// ---------------------------------------------------------------------------

test("runLoopCommand — a host with no goal-loop skill installed at any root starts, executes, and reports a run id (#512)", async () => {
  const fakeDoctorDeps: DoctorDeps = {
    exec: async () => ({ ok: true, stdout: "/goal autonomous mode", stderr: "" }),
    execCheck: async () => true,
    fsExists: async () => false, // no goal-loop install discoverable at any root
    fileMtime: async () => 1000,
    readTextFile: async () => null,
  };
  let engineCalled = false;
  const deps: LoopCliDeps = {
    runLoopPreflight: (raw, engine, _realDeps, roots, attestation) =>
      realRunLoopPreflight(raw, engine, fakeDoctorDeps, roots, attestation),
    runLoopEngine: async (input) => {
      engineCalled = true;
      assert.deepEqual(input.selector, { type: "work-list", value: ["100"] });
      return {
        kind: "drive",
        result: { runId: "loop-noskill", cycles: 1, stop: null, holdOutstanding: false, allDone: true, resumed: false },
      };
    },
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() => runLoopCommand({ profile: "claude" } as CliOpts, ["100"], deps));
  assert.equal(process.exitCode, 0);
  assert.equal(err.length, 0, "no install-remediation failure on a host with no goal-loop skill installed");
  assert.ok(engineCalled);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.run_id, "loop-noskill");
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

// ---------------------------------------------------------------------------
// decideNewRunSupersession (#568 review 1, finding b9472740): re-invoking
// `--new-run` against an already-minted, not-yet-resumed replacement run must
// resume it rather than reject it or mint a duplicate.
// ---------------------------------------------------------------------------

test("decideNewRunSupersession — a terminally-stopped head with no prior supersession mints the first replacement", () => {
  const decision = decideNewRunSupersession("run-1", 0, true);
  assert.deepEqual(decision, { kind: "mint", newRunId: "run-1-s1" });
});

test("decideNewRunSupersession — a terminally-stopped head already once superseded mints the next deterministic replacement", () => {
  const decision = decideNewRunSupersession("run-1", 2, true);
  assert.deepEqual(decision, { kind: "mint", newRunId: "run-1-s3" });
});

test("regression (#568 review 1, finding b9472740): re-invoking --new-run against an existing, not-yet-resumed replacement run resumes it instead of erroring", () => {
  // chainLength > 0 means the head is itself a run a prior --new-run call already minted; it
  // simply hasn't reached a terminal stop yet (the operator hasn't driven/resumed it).
  const decision = decideNewRunSupersession("run-1", 1, false);
  assert.deepEqual(decision, { kind: "resume-existing" });
});

test("decideNewRunSupersession — a genuinely active canonical run with no prior supersession is refused, not resumed or minted", () => {
  const decision = decideNewRunSupersession("run-1", 0, false);
  assert.deepEqual(decision, { kind: "refuse" });
});

// ---------------------------------------------------------------------------
// planSupersessionMintRepair (#568 review 2, finding d4cbf5eb): a crash between
// initializing the replacement run and writing the retired run's superseded_by
// pointer must self-heal on the next --new-run invocation instead of wedging
// the supersession chain forever.
// ---------------------------------------------------------------------------

test("planSupersessionMintRepair — a fresh mint plans to both initialize the replacement and link the retired run", () => {
  const decision = planSupersessionMintRepair({
    headRunId: "run-1",
    newRunId: "run-1-s1",
    newRunExists: false,
    existingNewRunSupersedes: undefined,
    headSupersededBy: undefined,
  });
  assert.deepEqual(decision, { kind: "plan", plan: { initNewRun: true, markSuperseded: true } });
});

test("regression (#568 review 2, finding d4cbf5eb): a retry after the replacement was initialized but the reverse pointer write was interrupted repairs the pointer without re-initializing", () => {
  const decision = planSupersessionMintRepair({
    headRunId: "run-1",
    newRunId: "run-1-s1",
    newRunExists: true,
    existingNewRunSupersedes: "run-1",
    headSupersededBy: undefined,
  });
  assert.deepEqual(decision, { kind: "plan", plan: { initNewRun: false, markSuperseded: true } });
});

test("planSupersessionMintRepair — a fully completed mint retried again is a pure no-op", () => {
  const decision = planSupersessionMintRepair({
    headRunId: "run-1",
    newRunId: "run-1-s1",
    newRunExists: true,
    existingNewRunSupersedes: "run-1",
    headSupersededBy: "run-1-s1",
  });
  assert.deepEqual(decision, { kind: "plan", plan: { initNewRun: false, markSuperseded: false } });
});

test("planSupersessionMintRepair — an existing replacement run that supersedes a different head is a conflict, never silently overwritten", () => {
  const decision = planSupersessionMintRepair({
    headRunId: "run-1",
    newRunId: "run-1-s1",
    newRunExists: true,
    existingNewRunSupersedes: "run-0",
    headSupersededBy: undefined,
  });
  assert.equal(decision.kind, "conflict");
});

test("planSupersessionMintRepair — a retired run already superseded by a different run is a conflict, never silently overwritten", () => {
  const decision = planSupersessionMintRepair({
    headRunId: "run-1",
    newRunId: "run-1-s2",
    newRunExists: false,
    existingNewRunSupersedes: undefined,
    headSupersededBy: "run-1-s1",
  });
  assert.equal(decision.kind, "conflict");
});
