// Train-level generic run-store events (#1277).
//
// Observational only: appends go through `appendEvent` (redaction, sink,
// write-health, non-fatal I/O). They do not grant merge or advance authority.

import * as path from "node:path";
import { writeFlushedStdoutLine } from "./loop/handoff.ts";
import { isLogicalOperationId, mintLogicalOperationId } from "./logical-operation.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  initRunDir,
  runDirPath,
  runsDir,
  trainRunIdFor,
  type RunEvent,
  type RunStoreDeps,
  type TrainRunSelector,
} from "./run-store.ts";

export const TRAIN_RUN_HANDOFF_KIND = "train_run_handoff" as const;
export const TRAIN_RUN_HANDOFF_SCHEMA_VERSION = "1" as const;

/** Exclusive mkdir attempts: unsuffixed id plus `-2` … `-8`. */
export const TRAIN_RUN_ID_MAX_EXCLUSIVE_ATTEMPTS = 8;

export type TrainEventsCoverage = "ok" | "degraded" | "unknown";

export interface TrainRunStoreInit {
  session: TrainEventSession | null;
  eventsCoverage: TrainEventsCoverage;
}

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
  proof_disposition?: "newly-merged" | "already-contained";
  final_state?: string;
  elapsed_ms?: number;
  logical_operation_id?: string;
}

export interface TrainEventSession {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly logicalOperationId: string;
  append(
    type: TrainEventType,
    payload?: TrainEventPayload & Record<string, unknown>,
  ): Promise<boolean>;
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
      return appendEvent(opts.runDir, event as RunEvent, store);
    },
  };
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function trainRunIdForAttempt(startedAt: Date, attempt: number): string {
  const base = trainRunIdFor(startedAt);
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

async function openClaimedTrainStore(input: {
  repoDir: string;
  repo: string;
  startedAt: Date;
  mergeMode: boolean;
  orderedIssues: readonly number[];
  selector: TrainRunSelector;
  store: RunStoreDeps;
  now?: () => Date;
  logicalOperationId: string;
  runId: string;
  runDir: string;
}): Promise<TrainEventSession | null> {
  await initRunDir(
    {
      runDir: input.runDir,
      runId: input.runId,
      repo: input.repo,
      profile: null,
      startedAt: input.startedAt.toISOString(),
      kind: "train",
      mergeMode: input.mergeMode,
      selector: input.selector,
      orderedIssues: input.orderedIssues,
      logicalOperationId: input.logicalOperationId,
    },
    input.store,
  );
  const logicalOperationId = input.logicalOperationId.trim();
  if (!isLogicalOperationId(logicalOperationId)) return null;
  try {
    const runRaw = await input.store.readFile(path.join(input.runDir, "run.json"));
    await input.store.readFile(path.join(input.runDir, "events.jsonl"));
    const meta = JSON.parse(runRaw) as Record<string, unknown>;
    if (
      meta.run_id !== input.runId ||
      meta.logical_operation_id !== logicalOperationId ||
      meta.kind !== "train" ||
      meta.repo !== input.repo ||
      meta.merge_mode !== input.mergeMode ||
      JSON.stringify(meta.ordered_issues) !== JSON.stringify(input.orderedIssues) ||
      JSON.stringify(meta.selector) !== JSON.stringify(input.selector)
    ) return null;
  } catch {
    return null;
  }
  const session = createTrainEventSession({
    runDir: input.runDir,
    runId: input.runId,
    logicalOperationId,
    store: input.store,
    now: input.now,
  });
  const started = await session.append("run_start", {
    repo: input.repo,
    merge_mode: input.mergeMode,
    logical_operation_id: logicalOperationId,
  });
  if (!started) return null;
  try {
    const eventsRaw = await input.store.readFile(path.join(input.runDir, "events.jsonl"));
    const lines = eventsRaw.split(/\r?\n/).filter((line) => line.trim());
    const event = JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown> | null;
    if (
      !event ||
      event.type !== "run_start" ||
      event.run_id !== input.runId ||
      event.logical_operation_id !== logicalOperationId ||
      event.merge_mode !== input.mergeMode
    ) return null;
  } catch {
    return null;
  }
  return session;
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
  mintLogicalOperationId?: () => string;
}): Promise<TrainRunStoreInit> {
  const store = input.store ?? defaultRunStoreDeps;
  const logicalOperationId =
    typeof input.logicalOperationId === "string" && input.logicalOperationId.trim()
      ? input.logicalOperationId.trim()
      : (input.mintLogicalOperationId ?? mintLogicalOperationId)();
  if (!isLogicalOperationId(logicalOperationId)) {
    return { session: null, eventsCoverage: "degraded" };
  }
  try {
    await store.mkdir(runsDir(input.repoDir), { recursive: true });
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") {
      return { session: null, eventsCoverage: "unknown" };
    }
  }

  let sawNonEexist = false;
  for (let attempt = 1; attempt <= TRAIN_RUN_ID_MAX_EXCLUSIVE_ATTEMPTS; attempt++) {
    const runId = trainRunIdForAttempt(input.startedAt, attempt);
    const runDir = runDirPath(input.repoDir, runId);
    try {
      await store.mkdir(runDir, { recursive: false });
    } catch (err) {
      if (errnoCode(err) === "EEXIST") continue;
      sawNonEexist = true;
      break;
    }
    const session = await openClaimedTrainStore({
      ...input,
      logicalOperationId,
      store,
      runId,
      runDir,
    });
    if (!session) {
      return { session: null, eventsCoverage: "degraded" };
    }
    return { session, eventsCoverage: "ok" };
  }

  return {
    session: null,
    eventsCoverage: sawNonEexist ? "unknown" : "degraded",
  };
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
