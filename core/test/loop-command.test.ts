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
import {
  formatLoopRunHandoff,
  LOOP_RUN_HANDOFF_KIND,
} from "../scripts/loop/handoff.ts";
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
        result: {
          runId: "loop-abc123",
          cycles: 2,
          stop: null,
          holdOutstanding: false,
          allDone: true,
          resumed: false,
          heldItemIds: [],
          dispatched: 1,
          excludedItemIds: [],
          exclusionReason: null,
          completion: "all_done",
        },
      };
    },
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 0);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.engine, "claude");
  assert.equal(parsed.run_id, "loop-abc123");
  assert.equal(parsed.all_done, true);
  assert.equal(parsed.completion, "all_done");
  assert.equal(parsed.dispatched, 1);
  assert.equal(parsed.excluded, 0);
  assert.deepEqual(parsed.excluded_item_ids, []);
  assert.equal(parsed.exclusion_reason, null);
  assert.equal(parsed.stop, null);
  assert.ok(!err.join("\n").includes("excluded"), "a genuinely all-done run prints no excluded-count line (#614)");
});

test("runLoopCommand — a run resolved none_dispatchable (every item precondition-excluded) is not reported all_done, prints the excluded-count line without --audit, and exits 2 (#614, capability loop-terminal-exclusion-disclosure)", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["607", "608"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async () => ({
      kind: "drive",
      result: {
        runId: "loop-abc123",
        cycles: 1,
        stop: null,
        holdOutstanding: false,
        allDone: false,
        resumed: false,
        heldItemIds: [],
        dispatched: 0,
        excludedItemIds: ["607", "608"],
        exclusionReason: "precondition:required=pipeline:ready,observed=none",
        completion: "none_dispatchable",
      },
    }),
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 2, "none_dispatchable is distinct from both success (0) and stop/hold failure (1)");
  assert.match(err.join("\n"), /0 of 2 item\(s\) dispatchable/);
  assert.match(err.join("\n"), /2 excluded: need pipeline:ready/);
  assert.match(err.join("\n"), /#607, #608/);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.all_done, false);
  assert.equal(parsed.completion, "none_dispatchable");
  assert.equal(parsed.dispatched, 0);
  assert.equal(parsed.excluded, 2);
  assert.deepEqual(parsed.excluded_item_ids, ["607", "608"]);
  assert.equal(parsed.exclusion_reason, "precondition:required=pipeline:ready,observed=none");
});

test("runLoopCommand — a partial_excluded run (some dispatched, some excluded) still exits 0 but discloses the excluded items (#614)", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100", "200"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async () => ({
      kind: "drive",
      result: {
        runId: "loop-abc123",
        cycles: 1,
        stop: null,
        holdOutstanding: false,
        allDone: false,
        resumed: false,
        heldItemIds: [],
        dispatched: 1,
        excludedItemIds: ["100"],
        exclusionReason: "precondition:required=pipeline:ready,observed=pipeline:backlog",
        completion: "partial_excluded",
      },
    }),
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 0, "work happened and the run resolved — a mixed result is not a failure exit");
  assert.match(err.join("\n"), /1 of 2 item\(s\) dispatchable/);
  assert.match(err.join("\n"), /1 excluded: need pipeline:ready \(#100\)/);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.all_done, false);
  assert.equal(parsed.completion, "partial_excluded");
});

test("runLoopCommand — a stop carrying outstanding_ready names the stranded item on stderr and in the JSON (#570, capability loop-needs-human-blocker-disposition)", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100", "200"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async () => ({
      kind: "drive",
      result: {
        runId: "loop-abc123",
        cycles: 3,
        stop: { reason: "run_fatal", time: "2026-07-24T00:00:00.000Z", item_id: "200", outstanding_ready: ["100"] },
        holdOutstanding: false,
        allDone: false,
        resumed: false,
        heldItemIds: [],
        dispatched: 0,
        excludedItemIds: [],
        exclusionReason: null,
        completion: null,
      },
    }),
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 1);
  assert.match(err.join("\n"), /stranded at ready-to-deploy/);
  assert.match(err.join("\n"), /100/);
  const parsed = JSON.parse(out[0]);
  assert.deepEqual(parsed.stop.outstanding_ready, ["100"]);
  assert.equal(parsed.completion, null, "a recorded stop leaves completion null (#614)");
});

test("runLoopCommand — a stop with no outstanding ready item prints no stranded-item stderr line", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async () => ({
      kind: "drive",
      result: {
        runId: "loop-abc123",
        cycles: 1,
        stop: { reason: "run_fatal", time: "2026-07-24T00:00:00.000Z", item_id: "100", outstanding_ready: [] },
        holdOutstanding: false,
        allDone: false,
        resumed: false,
        heldItemIds: [],
        dispatched: 0,
        excludedItemIds: [],
        exclusionReason: null,
        completion: null,
      },
    }),
  };
  process.exitCode = undefined;
  const { err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 1);
  assert.ok(!err.join("\n").includes("stranded"), "no ready item outstanding — no stranded-item disclosure line");
});

test("runLoopCommand — a terminal outstanding hold names every held item on stderr and in the JSON (#581, capability loop-blocked-item-hold-continuation)", async () => {
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100", "200"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: async () => ({
      kind: "drive",
      result: {
        runId: "loop-abc123",
        cycles: 3,
        stop: null,
        holdOutstanding: true,
        heldItemIds: ["100", "200"],
        allDone: false,
        resumed: false,
        dispatched: 0,
        excludedItemIds: [],
        exclusionReason: null,
        completion: null,
      },
    }),
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ milestone: "v2", profile: "claude" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 1);
  assert.match(err.join("\n"), /paused with 2 item\(s\) held for a human/);
  assert.match(err.join("\n"), /100, 200/);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.hold_outstanding, true);
  assert.deepEqual(parsed.held_item_ids, ["100", "200"]);
  assert.equal(parsed.completion, null, "an outstanding hold leaves completion null (#614)");
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
        result: {
          runId: "loop-noskill",
          cycles: 1,
          stop: null,
          holdOutstanding: false,
          allDone: true,
          resumed: false,
          heldItemIds: [],
          dispatched: 1,
          excludedItemIds: [],
          exclusionReason: null,
          completion: "all_done",
        },
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

// ---------------------------------------------------------------------------
// Early run handoff (#665, capability loop-early-run-handoff)
// ---------------------------------------------------------------------------

test("formatLoopRunHandoff — pure formatter emits kind loop_run_handoff with required fields and no I/O side effects", () => {
  const line = formatLoopRunHandoff({
    runId: "loop-abc",
    runDir: "/state/runs/loop-abc",
    events: "/state/runs/loop-abc/events.jsonl",
    engine: "claude",
    resumed: false,
    selector: { type: "work-list", value: ["100"] },
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.schema_version, "1");
  assert.equal(parsed.kind, LOOP_RUN_HANDOFF_KIND);
  assert.equal(parsed.run_id, "loop-abc");
  assert.equal(parsed.run_dir, "/state/runs/loop-abc");
  assert.equal(parsed.events, "/state/runs/loop-abc/events.jsonl");
  assert.equal(parsed.engine, "claude");
  assert.equal(parsed.resumed, false);
  assert.deepEqual(parsed.selector, { type: "work-list", value: ["100"] });
  assert.ok(!line.includes("\n"), "formatter returns a single JSON object without a trailing newline");
});

test("runLoopCommand — successful fresh drive emits exactly one loop_run_handoff before the first mocked dispatch (#665)", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    writeStdoutLine: (line) => {
      lines.push(line.replace(/\n$/, ""));
      order.push("handoff");
    },
    runLoopEngine: async (input) => {
      assert.ok(input.onRunReady, "CLI must wire onRunReady on the drive path");
      // Simulate supervisor: handoff fires, then dispatch would block, then terminal result.
      await input.onRunReady!({
        runId: "loop-fresh-1",
        runDir: "/tmp/loop-state/runs/loop-fresh-1",
        events: "/tmp/loop-state/runs/loop-fresh-1/events.jsonl",
        engine: "claude",
        resumed: false,
        selector: input.selector ?? null,
      });
      order.push("dispatch");
      return {
        kind: "drive",
        result: {
          runId: "loop-fresh-1",
          cycles: 1,
          stop: null,
          holdOutstanding: false,
          allDone: true,
          resumed: false,
          heldItemIds: [],
          dispatched: 1,
          excludedItemIds: [],
          exclusionReason: null,
          completion: "all_done",
        },
      };
    },
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ profile: "claude" } as CliOpts, ["100"], deps),
  );
  assert.equal(process.exitCode, 0);
  assert.deepEqual(order, ["handoff", "dispatch"], "handoff must complete before first dispatch");
  assert.equal(lines.length, 1, "exactly one early handoff line");
  const handoff = JSON.parse(lines[0]);
  assert.equal(handoff.kind, LOOP_RUN_HANDOFF_KIND);
  assert.equal(handoff.run_id, "loop-fresh-1");
  assert.equal(handoff.events, "/tmp/loop-state/runs/loop-fresh-1/events.jsonl");
  assert.equal(handoff.run_dir, "/tmp/loop-state/runs/loop-fresh-1");
  assert.equal(handoff.engine, "claude");
  assert.equal(handoff.resumed, false);
  assert.deepEqual(handoff.selector, { type: "work-list", value: ["100"] });
  assert.ok(path.isAbsolute(handoff.run_dir));
  assert.ok(path.isAbsolute(handoff.events));
  // Terminal summary still printed; must not reuse the handoff kind.
  const terminal = JSON.parse(out[0]);
  assert.notEqual(terminal.kind, LOOP_RUN_HANDOFF_KIND);
  assert.equal(terminal.run_id, "loop-fresh-1");
  assert.equal(terminal.all_done, true);
  assert.match(err.join("\n"), /run ready loop-fresh-1/);
});

test("runLoopCommand — --resume path emits handoff with resumed:true before first dispatch (#665)", async () => {
  const order: string[] = [];
  const lines: string[] = [];
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: undefined, resumeRunId: "loop-resume-1", audit: false },
      }) satisfies LoopPreflightOutcome,
    writeStdoutLine: (line) => {
      lines.push(line.replace(/\n$/, ""));
      order.push("handoff");
    },
    runLoopEngine: async (input) => {
      assert.equal(input.resumeRunId, "loop-resume-1");
      await input.onRunReady!({
        runId: "loop-resume-1",
        runDir: "/tmp/loop-state/runs/loop-resume-1",
        events: "/tmp/loop-state/runs/loop-resume-1/events.jsonl",
        engine: "codex",
        resumed: true,
        // Engine enriches: bare --resume has null selector.
        selector: input.resumeRunId ? null : (input.selector ?? null),
      });
      order.push("dispatch");
      return {
        kind: "drive",
        result: {
          runId: "loop-resume-1",
          cycles: 1,
          stop: null,
          holdOutstanding: false,
          allDone: true,
          resumed: true,
          heldItemIds: [],
          dispatched: 1,
          excludedItemIds: [],
          exclusionReason: null,
          completion: "all_done",
        },
      };
    },
  };
  process.exitCode = undefined;
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ resume: "loop-resume-1" } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 0);
  assert.deepEqual(order, ["handoff", "dispatch"]);
  const handoff = JSON.parse(lines[0]);
  assert.equal(handoff.kind, LOOP_RUN_HANDOFF_KIND);
  assert.equal(handoff.resumed, true);
  assert.equal(handoff.selector, null);
  const terminal = JSON.parse(out[0]);
  assert.equal(terminal.resumed, true);
  assert.notEqual(terminal.kind, LOOP_RUN_HANDOFF_KIND);
});

test("runLoopCommand — preflight failure emits no loop_run_handoff (#665)", async () => {
  const lines: string[] = [];
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: false,
        failedCheck: "loop:store-schema-compatibility",
        detail: "broken",
        remediation: "fix it",
      }) satisfies LoopPreflightOutcome,
    runLoopEngine: NEVER_CALLED_ENGINE,
    writeStdoutLine: (line) => lines.push(line),
  };
  process.exitCode = undefined;
  const { out } = await withCapturedConsole(() => runLoopCommand({ milestone: "v2" } as CliOpts, [], deps));
  assert.equal(process.exitCode, 1);
  assert.equal(lines.length, 0);
  assert.equal(out.length, 0);
  process.exitCode = 0;
});

test("runLoopCommand — engine/lock failure emits no loop_run_handoff (#665)", async () => {
  const lines: string[] = [];
  let onRunReadyPresent = false;
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    writeStdoutLine: (line) => lines.push(line),
    runLoopEngine: async (input) => {
      onRunReadyPresent = typeof input.onRunReady === "function";
      // Lock held: engine returns error without calling onRunReady.
      return {
        kind: "error",
        message:
          'loop run "loop-x" is already locked by claude pid 9 on host-b — use --resume to take over a provably-dead holder',
      };
    },
  };
  process.exitCode = undefined;
  const { out, err } = await withCapturedConsole(() =>
    runLoopCommand({ profile: "claude" } as CliOpts, ["100"], deps),
  );
  assert.equal(process.exitCode, 1);
  assert.ok(onRunReadyPresent, "drive path still wires onRunReady even when the engine later fails");
  assert.equal(lines.length, 0, "no handoff when lock/drive fails before ready");
  assert.equal(out.length, 0);
  assert.match(err.join("\n"), /already locked/);
  process.exitCode = 0;
});

test("runLoopCommand — --audit emits no loop_run_handoff and does not wire onRunReady (#665)", async () => {
  const lines: string[] = [];
  let sawOnRunReady: unknown = "unset";
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({ ok: true, args: { selector: undefined, resumeRunId: "run-1", audit: true } }) satisfies LoopPreflightOutcome,
    writeStdoutLine: (line) => lines.push(line),
    runLoopEngine: async (input) => {
      sawOnRunReady = input.onRunReady;
      return { kind: "audit", report: fakeAuditReport("run-1") };
    },
  };
  process.exitCode = undefined;
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ resume: "run-1", audit: true } as CliOpts, [], deps),
  );
  assert.equal(process.exitCode, 0);
  assert.equal(sawOnRunReady, undefined, "audit must not wire onRunReady");
  assert.equal(lines.length, 0);
  const parsed = JSON.parse(out[0]);
  assert.notEqual(parsed.kind, LOOP_RUN_HANDOFF_KIND);
  assert.equal(parsed.run_id, "run-1");
});

test("runLoopCommand — regression: only terminal run_id after completion fails the before-first-dispatch assertion (#665)", async () => {
  // Proves the primary regression: an implementation that only prints run_id
  // in the terminal summary after the supervisor completes cannot satisfy
  // "handoff before first dispatch".
  const order: string[] = [];
  const lines: string[] = [];
  const deps: LoopCliDeps = {
    runLoopPreflight: async () =>
      ({
        ok: true,
        args: { selector: { type: "work-list", value: ["100"] }, resumeRunId: undefined, audit: false },
      }) satisfies LoopPreflightOutcome,
    writeStdoutLine: (line) => {
      lines.push(line.replace(/\n$/, ""));
      order.push("handoff");
    },
    runLoopEngine: async (_input) => {
      // Pre-change behavior: never call onRunReady; only return terminal result.
      order.push("dispatch");
      return {
        kind: "drive",
        result: {
          runId: "loop-late-only",
          cycles: 1,
          stop: null,
          holdOutstanding: false,
          allDone: true,
          resumed: false,
          heldItemIds: [],
          dispatched: 1,
          excludedItemIds: [],
          exclusionReason: null,
          completion: "all_done",
        },
      };
    },
  };
  process.exitCode = undefined;
  const { out } = await withCapturedConsole(() =>
    runLoopCommand({ profile: "claude" } as CliOpts, ["100"], deps),
  );
  assert.equal(process.exitCode, 0);
  // Terminal summary still has run_id (pre-change surface).
  assert.equal(JSON.parse(out[0]).run_id, "loop-late-only");
  // But the early handoff never fired — this is the regression that #665 fixes
  // when the engine/supervisor actually invoke onRunReady before dispatch.
  assert.equal(lines.length, 0);
  assert.deepEqual(order, ["dispatch"]);
  assert.notDeepEqual(
    order,
    ["handoff", "dispatch"],
    "regression fixture: without onRunReady invocation, order is only dispatch",
  );
});
