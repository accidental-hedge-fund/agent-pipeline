// Unit tests for `pipeline loop logs` (#666, capability `loop-logs-follow`).
// Path resolution, dump/list/follow contracts, and error diagnostics — all
// via injected LoopLogsDeps (no real network, git, or live supervisor).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  followFileWithSignalCleanup,
  listLoopRunIds,
  loopEventsPath,
  runLoopLogs,
  type FollowFileProcess,
  type FollowFileSpawn,
  type LoopLogsDeps,
  PIPELINE_STATE_HOME_ENV,
} from "../scripts/loop/logs.ts";
import { LEGACY_PIPELINE_STATE_HOME_ENV, resolveStateHome, runDir } from "../scripts/loop/store.ts";

function makeDeps(opts: {
  env?: NodeJS.ProcessEnv;
  files?: Map<string, string>;
  dirs?: Set<string>;
  mtimes?: Map<string, number>;
  followCalls?: string[];
  followExit?: number | null;
}): {
  deps: LoopLogsDeps;
  out: string[];
  err: string[];
  followCalls: string[];
} {
  const files = opts.files ?? new Map<string, string>();
  const dirs = opts.dirs ?? new Set<string>();
  const mtimes = opts.mtimes ?? new Map<string, number>();
  const followCalls = opts.followCalls ?? [];
  const out: string[] = [];
  const err: string[] = [];

  // Any parent of a known file/dir is also "present" so run-dir existence
  // checks succeed when events.jsonl (or contract.json) is registered.
  function exists(p: string): boolean {
    if (files.has(p) || dirs.has(p)) return true;
    for (const f of files.keys()) {
      if (f === p || f.startsWith(p + path.sep)) return true;
    }
    for (const d of dirs) {
      if (d === p || d.startsWith(p + path.sep)) return true;
    }
    return false;
  }

  const deps: LoopLogsDeps = {
    env: opts.env ?? {},
    async fsExists(p) {
      return exists(p);
    },
    async readTextFile(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async listDir(p) {
      const names = new Set<string>();
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const name = rest.split(path.sep)[0];
          if (name) names.add(name);
        }
      }
      for (const d of dirs) {
        if (d === p) continue;
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const name = rest.split(path.sep)[0];
          if (name) names.add(name);
        } else if (path.dirname(d) === p) {
          names.add(path.basename(d));
        }
      }
      return [...names];
    },
    async mtimeMs(p) {
      return mtimes.has(p) ? mtimes.get(p)! : null;
    },
    async followFile(logFile) {
      followCalls.push(logFile);
      return opts.followExit === undefined ? 0 : opts.followExit;
    },
    stdoutWrite(s) {
      out.push(s);
    },
    stderrWrite(s) {
      err.push(s);
    },
  };

  return { deps, out, err, followCalls };
}

const HOME = "/state/loop-home";
const RUN_A = "loop-aaa";
const RUN_B = "loop-bbb";

function eventsPathFor(runId: string, env: NodeJS.ProcessEnv = { [PIPELINE_STATE_HOME_ENV]: HOME }): string {
  return loopEventsPath({ env, hostname: () => "test" }, runId);
}

function runDirFor(runId: string, env: NodeJS.ProcessEnv = { [PIPELINE_STATE_HOME_ENV]: HOME }): string {
  return runDir({ env, hostname: () => "test" }, runId);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("loop-logs: state-home override is honored for events path", () => {
  const env = { [PIPELINE_STATE_HOME_ENV]: HOME };
  assert.equal(
    eventsPathFor(RUN_A, env),
    path.join(HOME, "runs", RUN_A, "events.jsonl"),
  );
  assert.equal(
    resolveStateHome({ env, hostname: () => "test" }),
    HOME,
  );
});

test("loop-logs: legacy PIPELINE_STATE_HOME override is honored when AGENT_PIPELINE_STATE_HOME is unset", () => {
  const env = { [LEGACY_PIPELINE_STATE_HOME_ENV]: "/legacy/home" };
  assert.equal(
    resolveStateHome({ env, hostname: () => "test" }),
    "/legacy/home",
  );
  assert.equal(
    eventsPathFor(RUN_A, env),
    path.join("/legacy/home", "runs", RUN_A, "events.jsonl"),
  );
});

test("loop-logs: XDG_STATE_HOME layout when no explicit override", () => {
  const env = { XDG_STATE_HOME: "/xdg/state" };
  assert.equal(
    resolveStateHome({ env, hostname: () => "test" }),
    path.join("/xdg/state", "agent-pipeline", "loop"),
  );
});

test("loop-logs: path-unsafe run ids are rejected without reading outside runs root", async () => {
  const { deps, err, followCalls } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
  });
  process.exitCode = undefined;
  await runLoopLogs("../escape", false, deps);
  assert.equal(process.exitCode, 1);
  assert.ok(err.some((e) => e.includes("invalid run id") || e.includes("..")), `got: ${err.join("")}`);
  assert.equal(followCalls.length, 0);
  process.exitCode = 0;
});

test("loop-logs: path-separator run id is rejected", async () => {
  const { deps, err } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
  });
  process.exitCode = undefined;
  await runLoopLogs("foo/bar", false, deps);
  assert.equal(process.exitCode, 1);
  assert.ok(err.some((e) => e.includes("invalid run id")), `got: ${err.join("")}`);
  process.exitCode = 0;
});

test("loop-logs: resolution never consults .agent-pipeline/runs/", async () => {
  // Plant an advance-style store that would be wrong if consulted.
  const advancePath = path.join("/repo", ".agent-pipeline", "runs", RUN_A, "events.jsonl");
  const loopPath = eventsPathFor(RUN_A);
  const files = new Map<string, string>([
    [advancePath, '{"type":"advance_only"}\n'],
    // loop run missing → unknown, not the advance file
  ]);
  const { deps, out, err } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files,
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, false, deps);
  assert.equal(process.exitCode, 1);
  assert.equal(out.join(""), "");
  assert.ok(err.some((e) => e.includes("unknown run-id") && e.includes(RUN_A)));
  assert.ok(err.some((e) => e.includes(path.join(HOME, "runs", RUN_A))));
  assert.ok(!err.some((e) => e.includes(".agent-pipeline/runs")), "must not mention advance store");
  assert.notEqual(loopPath, advancePath);
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Dump contract
// ---------------------------------------------------------------------------

test("loop-logs: one-shot dump prints current events.jsonl and exits 0", async () => {
  const events = '{"kind":"loop_item_started","item":"1"}\n{"kind":"loop_run_stopped"}\n';
  const ep = eventsPathFor(RUN_A);
  const { deps, out, err } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, events]]),
    dirs: new Set([runDirFor(RUN_A)]),
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, false, deps);
  assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  assert.equal(out.join(""), events);
  assert.equal(err.join(""), "");
  process.exitCode = 0;
});

test("loop-logs: dump without --events still selects events.jsonl (always)", async () => {
  // runLoopLogs has no events flag — selected artifact is always events.jsonl.
  const events = '{"kind":"loop_schedule_evaluated"}\n';
  const ep = eventsPathFor(RUN_A);
  const { deps, out } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, events]]),
    dirs: new Set([runDirFor(RUN_A)]),
  });
  await runLoopLogs(RUN_A, false, deps);
  assert.equal(out.join(""), events);
});

test("loop-logs: unknown run id names expected state-home layout", async () => {
  const { deps, err } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
  });
  process.exitCode = undefined;
  await runLoopLogs("loop-missing", false, deps);
  assert.equal(process.exitCode, 1);
  const text = err.join("");
  assert.ok(text.includes("unknown run-id") && text.includes("loop-missing"), text);
  assert.ok(text.includes(path.join(HOME, "runs", "loop-missing")), text);
  process.exitCode = 0;
});

test("loop-logs: missing events.jsonl on dump names events.jsonl", async () => {
  const dir = runDirFor(RUN_A);
  const { deps, err } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    dirs: new Set([dir]),
    // run dir exists, events file does not
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, false, deps);
  assert.equal(process.exitCode, 1);
  const text = err.join("");
  assert.ok(text.includes("events.jsonl"), text);
  assert.ok(text.includes(RUN_A), text);
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// List contract
// ---------------------------------------------------------------------------

test("loop-logs: list mode prints run ids most-recent first and exits 0", async () => {
  const dirA = runDirFor(RUN_A);
  const dirB = runDirFor(RUN_B);
  const { deps, out } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    dirs: new Set([dirA, dirB]),
    mtimes: new Map([
      [dirA, 1000],
      [dirB, 2000],
    ]),
  });
  process.exitCode = undefined;
  await runLoopLogs(undefined, false, deps);
  assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  assert.deepEqual(out.join("").trim().split("\n"), [RUN_B, RUN_A]);
  process.exitCode = 0;
});

test("loop-logs: list mode reports empty when no loop runs exist", async () => {
  const { deps, out } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
  });
  process.exitCode = undefined;
  await runLoopLogs(undefined, false, deps);
  assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  assert.ok(out.join("").includes("No loop runs found"), out.join(""));
  assert.ok(out.join("").includes(path.join(HOME, "runs")), out.join(""));
  process.exitCode = 0;
});

test("listLoopRunIds: returns [] for empty home", async () => {
  const { deps } = makeDeps({ env: { [PIPELINE_STATE_HOME_ENV]: HOME } });
  assert.deepEqual(await listLoopRunIds(deps), []);
});

// ---------------------------------------------------------------------------
// Follow contract
// ---------------------------------------------------------------------------

test("loop-logs: follow invokes follow seam with resolved absolute events path", async () => {
  const ep = eventsPathFor(RUN_A);
  const { deps, followCalls } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, '{"kind":"x"}\n']]),
    dirs: new Set([runDirFor(RUN_A)]),
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps);
  assert.deepEqual(followCalls, [ep]);
  assert.ok(path.isAbsolute(followCalls[0]!));
  process.exitCode = 0;
});

test("loop-logs: follow fails non-zero when events.jsonl is absent", async () => {
  const { deps, err, followCalls } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    dirs: new Set([runDirFor(RUN_A)]),
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps);
  assert.equal(process.exitCode, 1);
  assert.equal(followCalls.length, 0, "must not start follow when file is missing");
  assert.ok(err.some((e) => e.includes("events.jsonl")), err.join(""));
  process.exitCode = 0;
});

test("loop-logs: follow propagates non-zero exit from follow seam", async () => {
  const ep = eventsPathFor(RUN_A);
  const { deps } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, "{}\n"]]),
    dirs: new Set([runDirFor(RUN_A)]),
    followExit: 2,
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps);
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// followFileWithSignalCleanup — SIGTERM/SIGINT must not orphan tail (#666)
// ---------------------------------------------------------------------------

function makeFakeFollowIo(): {
  spawn: FollowFileSpawn;
  process: FollowFileProcess;
  killSignals: NodeJS.Signals[];
  fireSignal(sig: "SIGINT" | "SIGTERM"): void;
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
  emitError(err: Error): void;
  handlersInstalled(): { sigint: boolean; sigterm: boolean };
} {
  const killSignals: NodeJS.Signals[] = [];
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let onError: ((err: Error) => void) | undefined;
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();

  const spawn: FollowFileSpawn = (_command, _args, _options) => ({
    kill(signal) {
      if (signal) killSignals.push(signal);
      return true;
    },
    on(event, listener) {
      if (event === "error") onError = listener as (err: Error) => void;
      if (event === "exit") {
        onExit = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
      }
    },
  });

  const proc: FollowFileProcess = {
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    stderr: { write() {} },
  };

  return {
    spawn,
    process: proc,
    killSignals,
    fireSignal(sig) {
      const h = listeners.get(sig);
      assert.ok(h, `expected ${sig} handler to be installed`);
      h();
    },
    emitExit(code, signal) {
      assert.ok(onExit, "expected exit listener");
      onExit(code, signal);
    },
    emitError(err) {
      assert.ok(onError, "expected error listener");
      onError(err);
    },
    handlersInstalled() {
      return { sigint: listeners.has("SIGINT"), sigterm: listeners.has("SIGTERM") };
    },
  };
}

test("followFileWithSignalCleanup: SIGTERM kills tail child and resolves interrupted status", async () => {
  const io = makeFakeFollowIo();
  const done = followFileWithSignalCleanup("/tmp/events.jsonl", {
    spawn: io.spawn,
    process: io.process,
  });
  assert.deepEqual(io.handlersInstalled(), { sigint: true, sigterm: true });

  io.fireSignal("SIGTERM");
  assert.deepEqual(io.killSignals, ["SIGTERM"], "parent SIGTERM must be forwarded to tail");
  assert.deepEqual(
    io.handlersInstalled(),
    { sigint: false, sigterm: false },
    "handlers are one-shot and removed on interrupt",
  );

  // Child exits after receiving the forwarded signal (await before settle).
  io.emitExit(null, "SIGTERM");
  assert.equal(await done, 143);
});

test("followFileWithSignalCleanup: SIGINT kills tail child and resolves 130", async () => {
  const io = makeFakeFollowIo();
  const done = followFileWithSignalCleanup("/tmp/events.jsonl", {
    spawn: io.spawn,
    process: io.process,
  });
  io.fireSignal("SIGINT");
  assert.deepEqual(io.killSignals, ["SIGINT"]);
  io.emitExit(null, "SIGINT");
  assert.equal(await done, 130);
  assert.deepEqual(io.handlersInstalled(), { sigint: false, sigterm: false });
});

test("followFileWithSignalCleanup: child exit removes signal handlers without interrupt", async () => {
  const io = makeFakeFollowIo();
  const done = followFileWithSignalCleanup("/tmp/events.jsonl", {
    spawn: io.spawn,
    process: io.process,
  });
  io.emitExit(0, null);
  assert.equal(await done, 0);
  assert.equal(io.killSignals.length, 0);
  assert.deepEqual(io.handlersInstalled(), { sigint: false, sigterm: false });
});

test("followFileWithSignalCleanup: spawn error settles non-zero and removes handlers", async () => {
  const io = makeFakeFollowIo();
  const done = followFileWithSignalCleanup("/tmp/events.jsonl", {
    spawn: io.spawn,
    process: io.process,
  });
  io.emitError(new Error("tail not found"));
  assert.equal(await done, 1);
  assert.deepEqual(io.handlersInstalled(), { sigint: false, sigterm: false });
});

// ---------------------------------------------------------------------------
// Nested dispatch: runLoopCommand must not be the only path — covered by
// CLI-level early branch; here prove the pure logs handler never needs a lock
// token or store write (deps expose no write/lock methods).
// ---------------------------------------------------------------------------

test("loop-logs: LoopLogsDeps has no lock or write surface (read-only contract)", () => {
  const { deps } = makeDeps({ env: { [PIPELINE_STATE_HOME_ENV]: HOME } });
  const keys = Object.keys(deps).sort();
  assert.deepEqual(keys, [
    "env",
    "followFile",
    "fsExists",
    "listDir",
    "mtimeMs",
    "readTextFile",
    "stderrWrite",
    "stdoutWrite",
  ]);
  assert.ok(!keys.includes("acquireLock"));
  assert.ok(!keys.includes("writeFileAtomic"));
  assert.ok(!keys.includes("appendLine"));
});
