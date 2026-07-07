// Unit tests for the event-sink factory (#343). buildEventSinkDeps() never
// spawns a real subprocess in these tests — delivery is injected via
// EventSinkDeps.deliver, and the real spawn-based default is exercised only
// with a local temp fake executable (same approach as harness.test.ts's
// custom-reviewer-CLI tests: no network, no gh, no auth).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildEventSinkDeps } from "../scripts/event-sink.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-event-sink-test-"));

function makeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const cliPath = path.join(dir, "forwarder");
  fs.writeFileSync(cliPath, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

test("buildEventSinkDeps: returns {} (no-op) when event_sink is unconfigured", () => {
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: undefined };
  const result = buildEventSinkDeps(cfg);
  assert.deepEqual(result, {});
});

test("buildEventSinkDeps: returns an eventSink + eventSinkMode when command is configured", () => {
  const cfg: Pick<PipelineConfig, "event_sink"> = {
    event_sink: { command: "logger -t pipeline", mode: "additive" },
  };
  const result = buildEventSinkDeps(cfg);
  assert.equal(typeof result.eventSink, "function");
  assert.equal(result.eventSinkMode, "additive");
});

test("buildEventSinkDeps: eventSink delegates to deliver() with (command, line)", async () => {
  const calls: Array<{ command: string; line: string }> = [];
  const cfg: Pick<PipelineConfig, "event_sink"> = {
    event_sink: { command: "my-forwarder", mode: "exclusive" },
  };
  const result = buildEventSinkDeps(cfg, {
    deliver: async (command, line) => { calls.push({ command, line }); },
  });
  await result.eventSink!('{"type":"stage_start"}\n');
  assert.deepEqual(calls, [{ command: "my-forwarder", line: '{"type":"stage_start"}\n' }]);
  assert.equal(result.eventSinkMode, "exclusive");
});

test("buildEventSinkDeps: eventSink propagates a deliver() rejection (caller — appendEvent — treats it as non-fatal)", async () => {
  const cfg: Pick<PipelineConfig, "event_sink"> = {
    event_sink: { command: "my-forwarder", mode: "additive" },
  };
  const result = buildEventSinkDeps(cfg, {
    deliver: async () => { throw new Error("boom"); },
  });
  await assert.rejects(() => Promise.resolve(result.eventSink!("line\n")), /boom/);
});

// ---------------------------------------------------------------------------
// Default deliver(): real spawn against a local temp fake executable.
// ---------------------------------------------------------------------------

test("buildEventSinkDeps (default deliver): the event line is delivered to the forwarder's stdin", async () => {
  const captured = path.join(tmpRoot, "captured.txt");
  const cli = makeScript(`cat > "${captured}"`);
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);
  await result.eventSink!('{"type":"stage_start"}\n');
  assert.equal(fs.readFileSync(captured, "utf8"), '{"type":"stage_start"}\n');
});

test("buildEventSinkDeps (default deliver): a non-zero exit rejects with exit code and a redacted stderr excerpt, never the raw command", async () => {
  const cli = makeScript(`echo "forwarder failed" >&2\nexit 1`);
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);
  await assert.rejects(
    () => Promise.resolve(result.eventSink!("line\n")),
    (err: Error) =>
      err.message.includes("exited 1") &&
      err.message.includes("forwarder failed") &&
      !err.message.includes(cli),
  );
});

// Regression (#343 review 1, finding 2): forwarder commands may embed their own
// auth (e.g. curl headers, inline env assignments) — a sink failure must never
// echo the raw command text or an unredacted secret into pipeline logs.
test("buildEventSinkDeps (default deliver): sink failure messages never leak a command-embedded secret", async () => {
  const cli = makeScript(`echo "calling API_KEY=super-secret-value" >&2\nexit 1`);
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);
  await assert.rejects(
    () => Promise.resolve(result.eventSink!("line\n")),
    (err: Error) => !err.message.includes("super-secret-value") && err.message.includes("[REDACTED]"),
  );
});

// Regression (#343 review 2, finding 1): a forwarder that exits before
// consuming stdin can make child.stdin emit an unhandled EPIPE stream error
// on write. Without a stdin error handler that error escapes as an uncaught
// exception rather than the promise rejection appendEvent catches.
test("buildEventSinkDeps (default deliver): stdin EPIPE from an early-exiting forwarder rejects instead of crashing the process", async () => {
  const cli = makeScript(`exit 0`);
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);
  const oversizedLine = "x".repeat(8 * 1024 * 1024) + "\n";

  let uncaught: unknown;
  const onUncaught = (err: unknown) => { uncaught = err; };
  process.on("uncaughtException", onUncaught);
  try {
    await result.eventSink!(oversizedLine).catch(() => { /* rejection is expected/acceptable */ });
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, undefined);
});

// Regression (#343 review 2, finding 2): stderr must be capped while reading,
// not only after the process closes, so a verbose/broken forwarder cannot
// force unbounded string retention before the cap is applied.
test("buildEventSinkDeps (default deliver): stderr accumulation is capped while reading, not only at close", async () => {
  const cli = makeScript(`for i in $(seq 1 50); do head -c 100000 /dev/zero | tr '\\0' 'e'; done 1>&2\nexit 1`);
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);
  await assert.rejects(
    () => Promise.resolve(result.eventSink!("line\n")),
    (err: Error) => err.message.includes("exited 1") && err.message.length < 300,
  );
});

// Pre-merge delta regression (#343): the stderr cap drops chunks once the
// buffer is full, so a quoted secret assignment whose closing quote arrives in
// a dropped chunk reaches redaction unterminated. The unterminated tail must
// still be redacted — never logged raw.
test("buildEventSinkDeps (default deliver): quoted secret split across chunks with the closing quote past the cap is still redacted", async () => {
  const cli = makeScript(
    [
      `printf 'OPENAI_API_KEY="' >&2`,
      // 250 chars of secret value: pushes the buffer past the 200-char cap
      `printf 'leakmarker%.0s' $(seq 1 25) >&2`,
      // closing quote in a later chunk, dropped by the cap
      `sleep 0.2`,
      `printf '"' >&2`,
      `exit 1`,
    ].join("\n"),
  );
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);
  await assert.rejects(
    () => Promise.resolve(result.eventSink!("line\n")),
    (err: Error) =>
      err.message.includes("exited 1") &&
      !err.message.includes("leakmarker") &&
      err.message.includes("[REDACTED]"),
  );
});

// #384: a synchronous throw from the underlying stream write (e.g. the
// low-level socket write rejecting an EPIPE inline rather than emitting the
// stream's 'error' event) must resolve through the same rejection path and
// clean up the child process immediately — never leave a dangling delivery
// timer or an un-killed forwarder process waiting on the 10s timeout.
test("buildEventSinkDeps (default deliver): a synchronous throw from the stdin write settles the delivery promise (no uncaught exception)", async () => {
  const net = await import("node:net");
  const cli = makeScript(`cat > /dev/null`);
  const cfg: Pick<PipelineConfig, "event_sink"> = { event_sink: { command: cli, mode: "additive" } };
  const result = buildEventSinkDeps(cfg);

  const origWrite = net.Socket.prototype.write;
  net.Socket.prototype.write = function () {
    throw new Error("synthetic synchronous write failure");
  };

  let uncaught: unknown;
  const onUncaught = (err: unknown) => { uncaught = err; };
  process.on("uncaughtException", onUncaught);
  try {
    await assert.rejects(
      () => Promise.resolve(result.eventSink!("line\n")),
      /synthetic synchronous write failure/,
    );
  } finally {
    net.Socket.prototype.write = origWrite;
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, undefined);
});

test("buildEventSinkDeps (default deliver): an unspawnable command rejects rather than hanging", async () => {
  const cfg: Pick<PipelineConfig, "event_sink"> = {
    event_sink: { command: "/no/such/executable-343", mode: "additive" },
  };
  const result = buildEventSinkDeps(cfg);
  await assert.rejects(() => Promise.resolve(result.eventSink!("line\n")));
});
