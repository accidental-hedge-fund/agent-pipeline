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

test("buildEventSinkDeps (default deliver): an unspawnable command rejects rather than hanging", async () => {
  const cfg: Pick<PipelineConfig, "event_sink"> = {
    event_sink: { command: "/no/such/executable-343", mode: "additive" },
  };
  const result = buildEventSinkDeps(cfg);
  await assert.rejects(() => Promise.resolve(result.eventSink!("line\n")));
});
