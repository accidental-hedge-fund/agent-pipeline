// Train-level generic run-store events (#1277).
//
// Observational only: appends go through `appendEvent` (redaction, sink,
// write-health, non-fatal I/O). They do not grant merge or advance authority.

import * as path from "node:path";
import { writeFlushedStdoutLine } from "./loop/handoff.ts";
import { mintLogicalOperationId } from "./logical-operation.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  initRunDir,
  runDirPath,
  trainRunIdFor,
  type RunEvent,
  type RunStoreDeps,
  type TrainRunSelector,
} from "./run-store.ts";

export const TRAIN_RUN_HANDOFF_KIND = "train_run_handoff" as const;
export const TRAIN_RUN_HANDOFF_SCHEMA_VERSION = "1" as const;

export const TRAIN_EVENT_TYPES = [
  "run_start",
  "train_work_list_resolved",
  "train_wave_started",
  "train_loop_linked",
  "train_item_started",
  "train_item_completed",
  "train_pr_created",
  "train_merge_attempted",
  "train_merge_proven",
  "train_merge_integrated",
  "train_sibling_halted",
  "train_wave_ended",
  "run_complete",
] as const;

export type TrainEventType = (typeof TRAIN_EVENT_TYPES)[number];

export interface TrainRunHandoff {
  schema_version: typeof TRAIN_RUN_HANDOFF_SCHEMA_VERSION;
  kind: typeof TRAIN_RUN_HANDOFF_KIND;
  run_id: string;
  run_dir: string;
  events: string;
}

export interface TrainEventPayload {
  issue?: number;
  pr?: number;
  ordered_issues?: readonly number[];
  frontier?: readonly number[];
  loop_run_id?: string;
  events?: string;
  wave?: number;
  terminal?: string;
  merge_mode?: boolean;
  repo?: string;
  complete?: boolean;
  blocker?: string | null;
  item_count?: number;
  merge_result_oid?: string | null;
  final_state?: string;
  elapsed_ms?: number;
  logical_operation_id?: string;
}

export interface TrainEventSession {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly logicalOperationId: string;
  append(type: TrainEventType, payload?: TrainEventPayload & Record<string, unknown>): Promise<void>;
}

export function formatTrainRunHandoff(input: {
  runId: string;
  runDir: string;
  events: string;
}): string {
  const payload: TrainRunHandoff = {
    schema_version: TRAIN_RUN_HANDOFF_SCHEMA_VERSION,
    kind: TRAIN_RUN_HANDOFF_KIND,
    run_id: input.runId,
    run_dir: input.runDir,
    events: input.events,
  };
  return JSON.stringify(payload);
}

export function createTrainEventSession(opts: {
  runDir: string;
  runId: string;
  logicalOperationId: string;
  store?: RunStoreDeps;
  now?: () => Date;
}): TrainEventSession {
  const store = opts.store ?? defaultRunStoreDeps;
  const now = opts.now ?? (() => new Date());
  let seq = 0;
  return {
    runId: opts.runId,
    runDir: opts.runDir,
    eventsPath: path.join(opts.runDir, "events.jsonl"),
    logicalOperationId: opts.logicalOperationId,
    async append(type, payload = {}) {
      seq += 1;
      const event: Record<string, unknown> = {
        schema_version: RUN_SCHEMA_VERSION,
        seq,
        type,
        at: now().toISOString(),
        run_id: opts.runId,
        logical_operation_id: opts.logicalOperationId,
      };
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined) continue;
        event[key] = Array.isArray(value) ? [...value] : value;
      }
      await appendEvent(opts.runDir, event as RunEvent, store);
    },
  };
}

export async function initTrainRunStore(input: {
  repoDir: string;
  repo: string;
  startedAt: Date;
  mergeMode: boolean;
  orderedIssues: readonly number[];
  selector: TrainRunSelector;
  store?: RunStoreDeps;
  now?: () => Date;
  logicalOperationId?: string | null;
}): Promise<TrainEventSession> {
  const runId = trainRunIdFor(input.startedAt);
  const runDir = runDirPath(input.repoDir, runId);
  const store = input.store ?? defaultRunStoreDeps;
  await initRunDir(
    {
      runDir,
      runId,
      repo: input.repo,
      profile: null,
      startedAt: input.startedAt.toISOString(),
      kind: "train",
      mergeMode: input.mergeMode,
      selector: input.selector,
      orderedIssues: input.orderedIssues,
      logicalOperationId: input.logicalOperationId,
    },
    store,
  );
  let logicalOperationId = typeof input.logicalOperationId === "string" && input.logicalOperationId.trim()
    ? input.logicalOperationId.trim()
    : "";
  if (!logicalOperationId) {
    try {
      const raw = await store.readFile(path.join(runDir, "run.json"));
      const meta = JSON.parse(raw) as { logical_operation_id?: unknown };
      if (typeof meta.logical_operation_id === "string" && meta.logical_operation_id.trim()) {
        logicalOperationId = meta.logical_operation_id.trim();
      }
    } catch {
      /* initRunDir is non-fatal; mint below if unreadable */
    }
  }
  if (!logicalOperationId) {
    logicalOperationId = mintLogicalOperationId();
  }
  const session = createTrainEventSession({
    runDir,
    runId,
    logicalOperationId,
    store,
    now: input.now,
  });
  await session.append("run_start", {
    repo: input.repo,
    merge_mode: input.mergeMode,
    logical_operation_id: logicalOperationId,
  });
  return session;
}

export async function flushTrainRunHandoff(
  session: TrainEventSession,
  writeLine?: (line: string) => Promise<void> | void,
): Promise<void> {
  const line = formatTrainRunHandoff({
    runId: session.runId,
    runDir: session.runDir,
    events: session.eventsPath,
  });
  const write =
    writeLine ??
    ((payload: string) => writeFlushedStdoutLine(payload, process.stderr));
  try {
    await write(line);
  } catch {
    // Observational: handoff failure must not change train mutations.
  }
}
