// Early machine-readable loop run handoff (#665, capability
// `loop-early-run-handoff`). Pure formatting + an injectable stdout write/flush
// seam so a streaming harness can parse `run_id` + absolute `events` path
// before the first multi-minute item dispatch, without scraping prose.

import type { LoopEngineName } from "./types.ts";
import type { LoopSelector } from "../loop-preflight.ts";

/** Discriminator for the early stdout handoff JSON object. */
export const LOOP_RUN_HANDOFF_KIND = "loop_run_handoff" as const;

export const LOOP_RUN_HANDOFF_SCHEMA_VERSION = "1" as const;

/** Context available once a durable run is exclusively locked and ready to drive. */
export interface LoopRunReadyContext {
  runId: string;
  /** Absolute path to `<state-home>/runs/<run_id>`. */
  runDir: string;
  /** Absolute path to that run's `events.jsonl`. */
  events: string;
  engine: LoopEngineName | string;
  /** Whether this process attached with resume semantics. */
  resumed: boolean;
  /**
   * Normalized selector used to start/target the run, when known.
   * Null/omitted on bare `--resume <run-id>` (no selector).
   */
  selector?: LoopSelector | null;
}

/** Wire shape of the early handoff JSON object written to stdout. */
export interface LoopRunHandoff {
  schema_version: typeof LOOP_RUN_HANDOFF_SCHEMA_VERSION;
  kind: typeof LOOP_RUN_HANDOFF_KIND;
  run_id: string;
  run_dir: string;
  events: string;
  engine: string;
  resumed: boolean;
  selector: LoopSelector | null;
}

/**
 * Pure formatter: one JSON object (no trailing newline) with
 * `kind: "loop_run_handoff"`. No I/O.
 */
export function formatLoopRunHandoff(ctx: LoopRunReadyContext): string {
  const payload: LoopRunHandoff = {
    schema_version: LOOP_RUN_HANDOFF_SCHEMA_VERSION,
    kind: LOOP_RUN_HANDOFF_KIND,
    run_id: ctx.runId,
    run_dir: ctx.runDir,
    events: ctx.events,
    engine: String(ctx.engine),
    resumed: !!ctx.resumed,
    selector: ctx.selector ?? null,
  };
  return JSON.stringify(payload);
}

/**
 * Write one line to stdout and flush so a piped consumer can parse the handoff
 * while the supervisor is still running. Injectable for unit tests.
 *
 * Prefer `write` of the line including trailing newline; when `write` returns
 * false (backpressure), wait on `drain` before returning.
 */
export function writeFlushedStdoutLine(
  line: string,
  stream: NodeJS.WritableStream = process.stdout,
): void | Promise<void> {
  const data = line.endsWith("\n") ? line : `${line}\n`;
  const ok = stream.write(data);
  if (ok) return;
  return new Promise<void>((resolve) => {
    stream.once("drain", () => resolve());
  });
}
