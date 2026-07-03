// External event sink (#343): delivers every run event appended via
// appendEvent (run-store.ts) to an operator-controlled forwarder command, in
// addition to (additive) or instead of (exclusive) the local events.jsonl
// file. The forwarder is an arbitrary shell command supplied by the operator
// (e.g. `logger -t pipeline`, or a script that POSTs to their aggregator);
// this module owns only invoking it with the event line on stdin — no vendor
// clients, no retry/backoff policy, no credential handling.

import { spawn } from "node:child_process";
import type { PipelineConfig } from "./types.ts";
import type { RunStoreDeps } from "./run-store.ts";

// Wall-clock cap for a single delivery. A hung forwarder must not stall the
// pipeline; a slow command is the operator's responsibility, so delivery is
// abandoned (and reported as a non-fatal failure by appendEvent) past this.
const DELIVERY_TIMEOUT_MS = 10_000;

export interface EventSinkDeps {
  /** Deliver one event line to the forwarder command; resolves on a zero
   *  exit code, rejects otherwise. Injectable so tests never spawn a real
   *  subprocess. Defaults to spawning `command` via the shell with `line` on
   *  stdin. */
  deliver?: (command: string, line: string) => Promise<void>;
}

async function defaultDeliver(command: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`event sink command timed out after ${DELIVERY_TIMEOUT_MS / 1000}s: ${command}`));
    }, DELIVERY_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`event sink command "${command}" exited ${code}${stderrBuf.trim() ? `: ${stderrBuf.trim()}` : ""}`));
      }
    });

    child.stdin?.write(line);
    child.stdin?.end();
  });
}

/**
 * Build the `eventSink`/`eventSinkMode` pair of RunStoreDeps from resolved
 * config. Returns `{}` (no-op) when no `event_sink.command` is configured, so
 * spreading the result into runStoreDeps is always safe and leaves behavior
 * unchanged when the feature is unconfigured.
 */
export function buildEventSinkDeps(
  cfg: Pick<PipelineConfig, "event_sink">,
  deps: EventSinkDeps = {},
): Pick<RunStoreDeps, "eventSink" | "eventSinkMode"> {
  if (!cfg.event_sink?.command) return {};
  const { command, mode } = cfg.event_sink;
  const deliver = deps.deliver ?? defaultDeliver;
  return {
    eventSink: (line: string) => deliver(command, line),
    eventSinkMode: mode,
  };
}
