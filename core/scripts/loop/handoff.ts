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
  /** Parent or admission logical-operation identity when the contract stores it. */
  logical_operation_id?: string;
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
  logical_operation_id?: string;
}

/** Supervisor identity snapshot persisted with the durable pack-loop ack. */
export interface LoopRunHandoffSupervisorSnapshot {
  pid: number;
  boot_id: string;
  started_at: string;
  token: string;
}

/**
 * Durable acknowledgement written to `<run_dir>/loop-run-handoff.json`.
 * Survives a detached parent. Stdout `LoopRunHandoff` remains the live-harness
 * extra and does not include these fields.
 */
export interface DurableLoopRunHandoff extends LoopRunHandoff {
  candidate_sha: string;
  supervisor: LoopRunHandoffSupervisorSnapshot;
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
    ...(typeof ctx.logical_operation_id === "string" && ctx.logical_operation_id.trim()
      ? { logical_operation_id: ctx.logical_operation_id.trim() }
      : {}),
  };
  return JSON.stringify(payload);
}

/**
 * Write one line to stdout and wait for the write completion callback so a
 * piped consumer can observe the handoff before this process continues (and
 * before first item dispatch). Injectable for unit tests.
 *
 * `stream.write()` returning true only means the user-space buffer is below
 * highWaterMark — it does **not** mean the async pipe write finished. Always
 * wait for the write callback (for both true and false returns) and reject on
 * write errors so the caller can surface failure and release the run lock.
 */
export function writeFlushedStdoutLine(
  line: string,
  stream: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const data = line.endsWith("\n") ? line : `${line}\n`;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error | null) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    try {
      // Callback fires when this chunk is flushed (or on error). Do not treat
      // a true return from write() as completion — that only signals buffer room.
      stream.write(data, (err?: Error | null) => settle(err));
    } catch (err) {
      settle(err as Error);
    }
  });
}
