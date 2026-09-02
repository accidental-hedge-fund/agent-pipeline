// Early machine-readable advance run handoff (#1049).
//
// Plain numeric `pipeline <N>` creates a run-store directory whose basename
// is `runIdFor` (filesystem-safe). The commit-trailer id from
// `makePipelineRunId` is a different string and is not a `pipeline logs`
// run-id. This formatter emits the run-store basename plus the absolute
// events path so a host can follow without scraping prose.

import { writeFlushedStdoutLine } from "./loop/handoff.ts";

/** Discriminator for the early stdout handoff JSON object. */
export const ADVANCE_RUN_HANDOFF_KIND = "advance_run_handoff" as const;

export const ADVANCE_RUN_HANDOFF_SCHEMA_VERSION = "1" as const;

/**
 * Nested loop/train children inherit stdio. This env tells the child not to
 * write `advance_run_handoff` onto the parent's machine stdout (train --json).
 */
export const PIPELINE_NESTED_ADVANCE_ENV = "PIPELINE_NESTED_ADVANCE" as const;

export const PIPELINE_NESTED_ADVANCE_VALUE = "1" as const;

/** Env bag for a nested numeric `pipeline <N>` child. */
export function nestedAdvanceChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...parentEnv, [PIPELINE_NESTED_ADVANCE_ENV]: PIPELINE_NESTED_ADVANCE_VALUE };
}

/** True when this process is a nested `pipeline/loop-execution@1` child. */
export function isNestedAdvanceChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PIPELINE_NESTED_ADVANCE_ENV] === PIPELINE_NESTED_ADVANCE_VALUE;
}

/**
 * True only for a top-level direct `runAdvance` call. Nested children (loop
 * dispatch spawn, in-process recover-parked re-entry) must not emit.
 * Public mutating `pipeline <N>` is no longer a top-level `runAdvance` owner.
 */
export function shouldEmitAdvanceRunHandoff(input: {
  emitAdvanceHandoff?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (input.emitAdvanceHandoff === false) return false;
  return !isNestedAdvanceChild(input.env ?? process.env);
}

/** Wire shape of the early advance handoff JSON object written to stdout. */
export interface AdvanceRunHandoff {
  schema_version: typeof ADVANCE_RUN_HANDOFF_SCHEMA_VERSION;
  kind: typeof ADVANCE_RUN_HANDOFF_KIND;
  run_id: string;
  run_dir: string;
  events: string;
}

/**
 * Pure formatter: one JSON object (no trailing newline) with
 * `kind: "advance_run_handoff"`. No I/O.
 */
export function formatAdvanceRunHandoff(input: {
  runId: string;
  runDir: string;
  events: string;
}): string {
  const payload: AdvanceRunHandoff = {
    schema_version: ADVANCE_RUN_HANDOFF_SCHEMA_VERSION,
    kind: ADVANCE_RUN_HANDOFF_KIND,
    run_id: input.runId,
    run_dir: input.runDir,
    events: input.events,
  };
  return JSON.stringify(payload);
}

/**
 * Flush one `advance_run_handoff` JSON line. Production writes stdout.
 * Tests inject `writeLine`. Write failure is visible (not swallowed).
 */
export async function flushAdvanceRunHandoff(
  input: { runId: string; runDir: string; events: string },
  writeLine?: (line: string) => Promise<void> | void,
): Promise<void> {
  const line = formatAdvanceRunHandoff(input);
  const write =
    writeLine ?? ((payload: string) => writeFlushedStdoutLine(payload));
  await write(line);
}
