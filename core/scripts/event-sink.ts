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
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";

// Wall-clock cap for a single delivery. A hung forwarder must not stall the
// pipeline; a slow command is the operator's responsibility, so delivery is
// abandoned (and reported as a non-fatal failure by appendEvent) past this.
const DELIVERY_TIMEOUT_MS = 10_000;

// Sink failure messages are logged (console.warn via appendEvent) and must
// never leak the operator's command text: forwarder commands are allowed to
// carry their own auth (curl headers, inline env assignments), so echoing the
// command on a transient failure would persist credentials into pipeline logs.
// stderr is capped and redacted for the same reason before it is surfaced.
const STDERR_EXCERPT_MAX_CHARS = 200;

function redactForLog(text: string): string {
  return sanitize(redactSecrets(text));
}

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
      reject(new Error(`event sink command timed out after ${DELIVERY_TIMEOUT_MS / 1000}s`));
    }, DELIVERY_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length >= STDERR_EXCERPT_MAX_CHARS) return;
      stderrBuf += chunk.toString("utf8");
    });

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
        const stderrExcerpt = redactForLog(stderrBuf.trim()).slice(0, STDERR_EXCERPT_MAX_CHARS);
        reject(new Error(`event sink command exited ${code}${stderrExcerpt ? `: ${stderrExcerpt}` : ""}`));
      }
    });

    // Covers the *asynchronous* EPIPE case (an early-exiting forwarder: the
    // write is accepted, then the stream emits 'error' on a later tick) —
    // regression-tested by "stdin EPIPE from an early-exiting forwarder..."
    // in event-sink.test.ts, which fails with an uncaught EPIPE if this
    // handler is removed.
    //
    // An EPIPE here is information about a dead pipe, not a delivery outcome
    // (#403): the forwarder exited without reading stdin, so `close` is
    // imminent and must settle the promise from the exit code — settling
    // here too would race EPIPE-vs-close timing and surface a nondeterministic
    // `write EPIPE` instead of the exit-code-shaped message. Any other stdin
    // error keeps the prior immediate-reject behavior.
    child.stdin?.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(err);
    });

    // A synchronous throw from the underlying stream write (e.g. an EPIPE
    // detected inline rather than via the 'error' event above) must resolve
    // through the same rejection path — never escape uncaught and take down
    // whatever else the process is doing concurrently (#384).
    try {
      child.stdin?.write(line);
      child.stdin?.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
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
