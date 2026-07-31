// Integration + unit tests for `pipeline logs` (#155 hang fix; #725 until-terminal).
// Unit tests inject follow seams only — no network/git/live advance process.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  followEventsWithTerminalExit,
  isAdvanceRunCompleteLine,
  type FollowEventsIo,
} from "../scripts/loop/logs.ts";
import { runLogs, type RunLogsDeps } from "../scripts/pipeline.ts";

test("runLogs --follow returns (does not hang) when terminal.log is missing (#155)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runlogs-"));
  const runId = "42-2026-06-16T00-00-00Z";
  // Run dir exists (so the directory stat passes) but terminal.log does NOT —
  // pre-check fails closed with non-zero exit (no hang awaiting a missing file).
  const runDir = path.join(tmp, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), "{}");

  const savedExit = process.exitCode;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("runLogs --follow hung (did not resolve)")), 5000);
    });
    await Promise.race([runLogs(tmp, runId, true), timeout]);
    assert.ok(
      process.exitCode !== undefined && process.exitCode !== 0,
      `expected a non-zero exitCode after a failed follow; got ${String(process.exitCode)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    process.exitCode = savedExit;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runLogs --events prints events.jsonl from the run store", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runlogs-events-"));
  const runId = "42-2026-06-16T00-00-00Z";
  const runDir = path.join(tmp, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), "{}");
  const eventLine = JSON.stringify({
    schema_version: 1,
    type: "stage_start",
    at: "2026-06-16T00:00:00Z",
    stage: "pre-merge",
  }) + "\n";
  fs.writeFileSync(path.join(runDir, "events.jsonl"), eventLine);

  const originalWrite = process.stdout.write;
  let output = "";
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    await runLogs(tmp, runId, false, true);
    assert.ok(output.includes(eventLine), `expected output to include event line; got:\n${output}`);
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runLogs --events reports missing events.jsonl by name", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runlogs-events-missing-"));
  const runId = "42-2026-06-16T00-00-00Z";
  const runDir = path.join(tmp, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), "{}");

  const originalError = console.error;
  const savedExit = process.exitCode;
  const errors: string[] = [];
  try {
    console.error = (msg?: unknown) => { errors.push(String(msg)); };
    await runLogs(tmp, runId, false, true);
    assert.ok(
      errors.some((line) => line.includes("events.jsonl not yet written")),
      `expected events.jsonl diagnostic, got:\n${errors.join("\n")}`,
    );
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = originalError;
    process.exitCode = savedExit;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #725: until-terminal default on advance events follow (run_complete)
// ---------------------------------------------------------------------------

function makeTmpRunWithEvents(content: string): { tmp: string; runId: string; eventsPath: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runlogs-ut-"));
  const runId = "725-2026-07-31T00-00-00Z";
  const runDir = path.join(tmp, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), "{}");
  const eventsPath = path.join(runDir, "events.jsonl");
  fs.writeFileSync(eventsPath, content);
  return { tmp, runId, eventsPath };
}

test("isAdvanceRunCompleteLine: matches type run_complete only", () => {
  assert.equal(
    isAdvanceRunCompleteLine(
      JSON.stringify({ schema_version: 1, type: "run_complete", at: "t", final_state: "ready-to-deploy" }),
    ),
    true,
  );
  assert.equal(
    isAdvanceRunCompleteLine(JSON.stringify({ type: "stage_complete", stage: "review-1" })),
    false,
  );
  assert.equal(isAdvanceRunCompleteLine('{"kind":"loop_run_stopped"}'), false);
  assert.equal(isAdvanceRunCompleteLine("not-json"), false);
  assert.equal(isAdvanceRunCompleteLine(""), false);
});

test("runLogs: default --events --follow exits 0 when run_complete is delivered (#725)", async () => {
  const complete = JSON.stringify({
    schema_version: 1,
    type: "run_complete",
    at: "2026-07-31T00:00:00Z",
    final_state: "ready-to-deploy",
    elapsed_ms: 1,
  }) + "\n";
  const prior = JSON.stringify({ schema_version: 1, type: "stage_start", at: "t", stage: "planning" }) + "\n";
  const { tmp, runId } = makeTmpRunWithEvents(prior + complete);

  const followOptsSeen: Array<{ untilTerminal: boolean; events: boolean }> = [];
  const deps: RunLogsDeps = {
    async followFile(_path, opts) {
      followOptsSeen.push(opts);
      // Simulate default until-terminal: exit 0 when untilTerminal is true.
      return opts.untilTerminal ? 0 : 99;
    },
    stdoutWrite() {},
    stderrWrite() {},
  };

  process.exitCode = undefined;
  try {
    await runLogs(tmp, runId, true, true, {}, deps);
    assert.equal(followOptsSeen.length, 1);
    assert.equal(followOptsSeen[0]!.untilTerminal, true);
    assert.equal(followOptsSeen[0]!.events, true);
    assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  } finally {
    process.exitCode = 0;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runLogs: historical run_complete ends follow without hang (#725)", async () => {
  const complete = JSON.stringify({
    schema_version: 1,
    type: "run_complete",
    at: "2026-07-31T00:00:00Z",
    final_state: "ready-to-deploy",
    elapsed_ms: 1,
  }) + "\n";
  const { tmp, runId, eventsPath } = makeTmpRunWithEvents(complete);

  // Production-path until-terminal via injectable stream (no real poll hang).
  const lines = [complete];
  let idx = 0;
  const out: string[] = [];
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const io: FollowEventsIo = {
    async readFrom(_p, offset) {
      if (idx >= lines.length) return { data: "", nextOffset: offset };
      const data = lines[idx++]!;
      return { data, nextOffset: offset + data.length };
    },
    async waitForMore() {
      throw new Error("should not wait after historical terminal");
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

  const deps: RunLogsDeps = {
    followFile(logFile, opts) {
      assert.equal(logFile, eventsPath);
      assert.equal(opts.untilTerminal, true);
      assert.equal(opts.events, true);
      return followEventsWithTerminalExit(
        logFile,
        { untilTerminal: true, isTerminalLine: isAdvanceRunCompleteLine },
        io,
      );
    },
    stdoutWrite() {},
    stderrWrite() {},
  };

  process.exitCode = undefined;
  try {
    await runLogs(tmp, runId, true, true, {}, deps);
    assert.equal(out.join(""), complete);
    assert.equal(process.exitCode === undefined || process.exitCode === 0, true);
  } finally {
    process.exitCode = 0;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runLogs: --no-until-terminal does not exit solely on run_complete (#725)", async () => {
  const complete = JSON.stringify({
    schema_version: 1,
    type: "run_complete",
    at: "2026-07-31T00:00:00Z",
    final_state: "ready-to-deploy",
    elapsed_ms: 1,
  }) + "\n";
  const { tmp, runId } = makeTmpRunWithEvents(complete);

  const followOptsSeen: Array<{ untilTerminal: boolean; events: boolean }> = [];
  const deps: RunLogsDeps = {
    async followFile(_path, opts) {
      followOptsSeen.push(opts);
      // Interrupt-only path: seam returns whatever followExit would; not forced by run_complete.
      return 0;
    },
    stdoutWrite() {},
    stderrWrite() {},
  };

  process.exitCode = undefined;
  try {
    await runLogs(tmp, runId, true, true, { untilTerminal: false }, deps);
    assert.equal(followOptsSeen[0]!.untilTerminal, false);
    assert.equal(followOptsSeen[0]!.events, true);
  } finally {
    process.exitCode = 0;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("followEventsWithTerminalExit: advance run_complete exits 0 with injectable stream (#725)", async () => {
  const lines = [
    '{"schema_version":1,"type":"stage_start","at":"t","stage":"planning"}\n',
    '{"schema_version":1,"type":"run_complete","at":"t","final_state":"ready-to-deploy","elapsed_ms":1}\n',
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
    async waitForMore() {
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
  const code = await followEventsWithTerminalExit(
    "/fake/events.jsonl",
    { untilTerminal: true, isTerminalLine: isAdvanceRunCompleteLine },
    io,
  );
  assert.equal(code, 0);
  assert.equal(out.join(""), lines.join(""));
  assert.deepEqual([...listeners.keys()], [], "signal handlers cleaned up");
});

test("followEventsWithTerminalExit: advance --no-until-terminal keeps reading past run_complete (#725)", async () => {
  const chunks = [
    '{"type":"run_complete","final_state":"ready-to-deploy"}\n',
    '{"type":"stage_start","stage":"planning"}\n',
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
  const code = await followEventsWithTerminalExit(
    "/fake/events.jsonl",
    { untilTerminal: false, isTerminalLine: isAdvanceRunCompleteLine },
    io,
  );
  assert.equal(code, 130, "interrupt ends interrupt-only follow");
  assert.ok(out.join("").includes("run_complete"));
  assert.ok(out.join("").includes("stage_start"), "must not stop solely on terminal");
});

test("runLogs: terminal.log follow is not until-terminal by default (#725)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runlogs-term-"));
  const runId = "725-2026-07-31T00-00-00Z";
  const runDir = path.join(tmp, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "terminal.log"), "hello\n");

  const followOptsSeen: Array<{ untilTerminal: boolean; events: boolean }> = [];
  const deps: RunLogsDeps = {
    async followFile(_path, opts) {
      followOptsSeen.push(opts);
      return 0;
    },
    stdoutWrite() {},
    stderrWrite() {},
  };

  try {
    await runLogs(tmp, runId, true, false, { untilTerminal: true }, deps);
    assert.equal(followOptsSeen[0]!.events, false);
    // untilTerminal flag is only true when events && follow && not opted out
    assert.equal(followOptsSeen[0]!.untilTerminal, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
