// Unit tests for `pipeline loop logs` (#666 / #699, capability `loop-logs-follow`).
// Path resolution, dump/list/follow contracts, until-terminal exit, and error
// diagnostics — all via injected LoopLogsDeps (no real network, git, or live
// supervisor).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  appendFollowChunk,
  followEventsWithTerminalExit,
  followFileWithSignalCleanup,
  isLoopRunStoppedLine,
  listLoopRunIds,
  loopEventsPath,
  LOOP_RUN_STOPPED_KIND,
  runLoopLogs,
  type FollowEventsIo,
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
  followOptsSeen?: Array<{ untilTerminal?: boolean } | undefined>;
  followExit?: number | null;
  /** When set, followFile simulates line-aware until-terminal using this content. */
  followContent?: string;
}): {
  deps: LoopLogsDeps;
  out: string[];
  err: string[];
  followCalls: string[];
  followOptsSeen: Array<{ untilTerminal?: boolean } | undefined>;
} {
  const files = opts.files ?? new Map<string, string>();
  const dirs = opts.dirs ?? new Set<string>();
  const mtimes = opts.mtimes ?? new Map<string, number>();
  const followCalls = opts.followCalls ?? [];
  const followOptsSeen = opts.followOptsSeen ?? [];
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
    async followFile(logFile, followOpts) {
      followCalls.push(logFile);
      followOptsSeen.push(followOpts);
      if (opts.followContent !== undefined) {
        // Minimal until-terminal simulation: print content and exit 0 if a
        // terminal line is present and untilTerminal is on; otherwise hang is
        // represented by returning followExit (tests that need non-exit use
        // followEventsWithTerminalExit directly).
        const untilTerminal = followOpts?.untilTerminal !== false;
        let pending = "";
        let sawTerminal = false;
        const result = appendFollowChunk(pending, opts.followContent, (line) => {
          out.push(line);
        });
        pending = result.pending;
        sawTerminal = result.sawTerminal;
        if (untilTerminal && sawTerminal) return 0;
        return opts.followExit === undefined ? 0 : opts.followExit;
      }
      return opts.followExit === undefined ? 0 : opts.followExit;
    },
    stdoutWrite(s) {
      out.push(s);
    },
    stderrWrite(s) {
      err.push(s);
    },
  };

  return { deps, out, err, followCalls, followOptsSeen };
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
  const { deps, followCalls, followOptsSeen } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, '{"kind":"x"}\n']]),
    dirs: new Set([runDirFor(RUN_A)]),
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps);
  assert.deepEqual(followCalls, [ep]);
  assert.ok(path.isAbsolute(followCalls[0]!));
  // Default until-terminal is on when follow is set (#699).
  assert.equal(followOptsSeen[0]?.untilTerminal, true);
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
  assert.ok(
    err.some((e) => e.includes("loop_run_stopped") || e.includes("until-terminal") || e.includes("--no-until-terminal")),
    `error should document until-terminal default: ${err.join("")}`,
  );
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
// Until-terminal follow (#699)
// ---------------------------------------------------------------------------

test("isLoopRunStoppedLine: matches store-shaped kind field only", () => {
  assert.equal(
    isLoopRunStoppedLine(
      JSON.stringify({ seq: 1, time: "t", kind: LOOP_RUN_STOPPED_KIND, data: { reason: "supervisor_no_progress" } }),
    ),
    true,
  );
  assert.equal(isLoopRunStoppedLine('{"kind":"loop_item_started"}'), false);
  assert.equal(isLoopRunStoppedLine("not-json"), false);
  assert.equal(isLoopRunStoppedLine(""), false);
  assert.equal(isLoopRunStoppedLine('{"type":"loop_run_stopped"}'), false, "must use kind, not type");
});

test("appendFollowChunk: buffers incomplete lines; detects terminal on complete line", () => {
  const lines: string[] = [];
  let r = appendFollowChunk("", '{"kind":"loop_item_started"}\n{"kind":"loop_run_', (l) => lines.push(l));
  assert.equal(r.sawTerminal, false);
  assert.equal(r.pending, '{"kind":"loop_run_');
  assert.deepEqual(lines, ['{"kind":"loop_item_started"}\n']);

  r = appendFollowChunk(r.pending, 'stopped"}\n', (l) => lines.push(l));
  assert.equal(r.sawTerminal, true);
  assert.equal(r.pending, "");
  assert.equal(lines[1], '{"kind":"loop_run_stopped"}\n');
});

test("loop-logs: default follow exits 0 when loop_run_stopped is delivered (#699)", async () => {
  const ep = eventsPathFor(RUN_A);
  const content =
    '{"seq":1,"time":"t","kind":"loop_item_started","data":{}}\n' +
    '{"seq":2,"time":"t","kind":"loop_run_stopped","data":{"reason":"supervisor_no_progress"}}\n';
  const { deps, out, followOptsSeen } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, content]]),
    dirs: new Set([runDirFor(RUN_A)]),
    followContent: content,
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps); // default untilTerminal
  assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  assert.equal(followOptsSeen[0]?.untilTerminal, true);
  assert.ok(out.join("").includes(LOOP_RUN_STOPPED_KIND), out.join(""));
  process.exitCode = 0;
});

test("loop-logs: historical loop_run_stopped ends follow without hang (#699)", async () => {
  // Content already contains terminal — follow seam must process and return 0
  // (not leave follow open waiting for new appends).
  const ep = eventsPathFor(RUN_A);
  const content = '{"kind":"loop_run_stopped","data":{"reason":"done"}}\n';
  const { deps, out } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, content]]),
    dirs: new Set([runDirFor(RUN_A)]),
    followContent: content,
    // If until-terminal were ignored, a hang would be represented by non-zero
    // only when followExit is set — we assert exit stays 0 with terminal present.
    followExit: 99,
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps, { untilTerminal: true });
  assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  assert.ok(out.join("").includes("loop_run_stopped"));
  process.exitCode = 0;
});

test("loop-logs: --no-until-terminal does not exit solely on loop_run_stopped (#699)", async () => {
  const ep = eventsPathFor(RUN_A);
  const content = '{"kind":"loop_run_stopped","data":{}}\n';
  const { deps, followOptsSeen } = makeDeps({
    env: { [PIPELINE_STATE_HOME_ENV]: HOME },
    files: new Map([[ep, content]]),
    dirs: new Set([runDirFor(RUN_A)]),
    followContent: content,
    // Without until-terminal exit, follow seam falls through to followExit.
    followExit: 0,
  });
  process.exitCode = undefined;
  await runLoopLogs(RUN_A, true, deps, { untilTerminal: false });
  assert.equal(followOptsSeen[0]?.untilTerminal, false);
  // Seam was invoked; terminal content alone did not force a special path
  // beyond whatever followExit returned (0 here).
  assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  process.exitCode = 0;
});

test("followEventsWithTerminalExit: exits 0 on terminal with injectable stream", async () => {
  const lines = [
    '{"kind":"loop_item_started"}\n',
    '{"kind":"loop_run_stopped","data":{"reason":"x"}}\n',
  ];
  let idx = 0;
  const out: string[] = [];
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const io: FollowEventsIo = {
    async readFrom(_p, offset) {
      if (idx >= lines.length) return { data: "", nextOffset: offset };
      const data = lines[idx++]!;
      return { data, nextOffset: offset + data.length };
    },
    async waitForMore(_p, signal) {
      if (signal.aborted) throw new Error("aborted");
      // After all lines delivered, wait would hang forever in production;
      // tests should have already exited on terminal.
      throw new Error("should not wait after terminal");
    },
    stdoutWrite(s) {
      out.push(s);
    },
    stderrWrite() {},
    process: {
      on(event, listener) {
        listeners.set(event, listener);
      },
      removeListener(event, listener) {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
      stderr: { write() {} },
    },
  };
  const code = await followEventsWithTerminalExit("/fake/events.jsonl", { untilTerminal: true }, io);
  assert.equal(code, 0);
  assert.equal(out.join(""), lines.join(""));
  assert.deepEqual([...listeners.keys()], [], "signal handlers cleaned up");
});

test("followEventsWithTerminalExit: --no-until-terminal keeps reading past terminal", async () => {
  const chunks = [
    '{"kind":"loop_run_stopped"}\n',
    '{"kind":"loop_item_started"}\n',
  ];
  let idx = 0;
  let waits = 0;
  const out: string[] = [];
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const io: FollowEventsIo = {
    async readFrom(_p, offset) {
      if (idx >= chunks.length) return { data: "", nextOffset: offset };
      const data = chunks[idx++]!;
      return { data, nextOffset: offset + data.length };
    },
    async waitForMore(_p, signal) {
      waits++;
      if (waits >= 2) {
        // Simulate interrupt after observing content past terminal.
        listeners.get("SIGINT")?.();
        throw new Error("aborted");
      }
      if (signal.aborted) throw new Error("aborted");
    },
    stdoutWrite(s) {
      out.push(s);
    },
    stderrWrite() {},
    process: {
      on(event, listener) {
        listeners.set(event, listener);
      },
      removeListener(event, listener) {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
      stderr: { write() {} },
    },
  };
  const code = await followEventsWithTerminalExit("/fake/events.jsonl", { untilTerminal: false }, io);
  assert.equal(code, 130, "interrupt ends interrupt-only follow");
  assert.ok(out.join("").includes("loop_run_stopped"));
  assert.ok(out.join("").includes("loop_item_started"), "must not stop solely on terminal");
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
