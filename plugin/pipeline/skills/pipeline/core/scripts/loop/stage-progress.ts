// Per-item pipeline stage-progress observability for durable loop runs (#611,
// capability `loop-item-stage-progress`).
//
// Pure helpers map advance run-store events → ledger projection deltas, format
// audit stage-table rows and one-line follow events, and apply material updates
// through the existing store write seams. Observation is read-only of the
// child's events.jsonl; this module never writes GitHub labels or merges.

import type { LoopItemLedgerEntry, LoopItemState, LoopLedger } from "./types.ts";
import { appendEvent, readEvents, readLedger, writeLedger, type LoopStoreDeps } from "./store.ts";

/** Stable loop event kind for whole-run stage-progress follow (#611). */
export const LOOP_ITEM_STAGE_PROGRESS = "loop_item_stage_progress";

/** Durable per-item current-stage projection fields (additive on the ledger). */
export interface ItemStageProjection {
  current_stage: string;
  current_stage_round?: number;
  current_stage_updated_at: string;
  advance_run_id?: string;
}

/** One row of the audit stage-progress table. */
export interface StageProgressTableRow {
  item_id: string;
  /** Coarse ledger state (closed set) — never a substitute for current_stage. */
  state: string;
  /** Human stage presentation, e.g. `implementing`, `plan-review (round 1)`, `pending`. */
  stage_presentation: string;
  /** Real advance run-store basename when known; omitted when not mid-advance / unknown. */
  advance_run_id?: string;
  /** True when a durable current_stage projection was recorded. */
  has_projection: boolean;
}

/** Structured payload of a {@link LOOP_ITEM_STAGE_PROGRESS} loop event. */
export interface StageProgressEventData {
  item_id: string;
  stage: string;
  round?: number;
  advance_run_id?: string;
  at: string;
}

/** Minimal advance-event shape the mapper understands (from events.jsonl). */
export interface AdvanceStageEvent {
  type?: string;
  stage?: string;
  round?: number;
  at?: string;
  outcome?: string;
}

/** Result of mapping one advance event onto the current projection. */
export type StageProjectionDelta =
  | { material: false }
  | {
      material: true;
      projection: ItemStageProjection;
    };

/** Map a single advance run event into a material projection delta (or none).
 *  Does not invent a live stage when the store is unconfirmed (caller must only
 *  feed events from a confirmed advance `events.jsonl`). */
export function mapAdvanceEventToStageDelta(
  event: AdvanceStageEvent,
  current: ItemStageProjection | null,
  opts: { advance_run_id?: string; now: string },
): StageProjectionDelta {
  const type = typeof event.type === "string" ? event.type : "";
  const advance_run_id = opts.advance_run_id ?? current?.advance_run_id;

  if (type === "stage_start") {
    const stage = typeof event.stage === "string" && event.stage.length > 0 ? event.stage : null;
    if (!stage) return { material: false };
    const next: ItemStageProjection = {
      current_stage: stage,
      current_stage_updated_at: typeof event.at === "string" && event.at.length > 0 ? event.at : opts.now,
      ...(advance_run_id ? { advance_run_id } : {}),
      // stage_start starts a new stage; clear prior review/fix round unless the
      // stage name itself encodes a round (left to presentation only).
    };
    if (!isMaterialStageChange(current, next)) return { material: false };
    return { material: true, projection: next };
  }

  if (type === "review_verdict") {
    const stage = current?.current_stage ?? "review";
    const round =
      typeof event.round === "number" && Number.isFinite(event.round) ? event.round : current?.current_stage_round;
    const next: ItemStageProjection = {
      current_stage: stage,
      current_stage_updated_at: typeof event.at === "string" && event.at.length > 0 ? event.at : opts.now,
      ...(advance_run_id ? { advance_run_id } : {}),
      ...(round !== undefined ? { current_stage_round: round } : {}),
    };
    if (!isMaterialStageChange(current, next)) return { material: false };
    return { material: true, projection: next };
  }

  if (type === "stage_complete") {
    // Refine presentation only when we have a stage name; do not clear stage.
    const stage =
      (typeof event.stage === "string" && event.stage.length > 0 ? event.stage : null) ??
      current?.current_stage ??
      null;
    if (!stage) return { material: false };
    const next: ItemStageProjection = {
      current_stage: stage,
      current_stage_updated_at: typeof event.at === "string" && event.at.length > 0 ? event.at : opts.now,
      ...(advance_run_id ? { advance_run_id } : {}),
      ...(current?.current_stage_round !== undefined
        ? { current_stage_round: current.current_stage_round }
        : {}),
    };
    // stage_complete without stage/round change is non-material (avoid spam).
    if (!isMaterialStageChange(current, next)) return { material: false };
    return { material: true, projection: next };
  }

  return { material: false };
}

/** True when stage name or round differs (or first projection). */
export function isMaterialStageChange(
  previous: ItemStageProjection | null | undefined,
  next: ItemStageProjection,
): boolean {
  if (!previous) return true;
  if (previous.current_stage !== next.current_stage) return true;
  if ((previous.current_stage_round ?? null) !== (next.current_stage_round ?? null)) return true;
  // Advance-run id becoming known is material for drill-down surfaces.
  if (!previous.advance_run_id && next.advance_run_id) return true;
  return false;
}

/** Read projection fields from a ledger item entry (absent → null). */
export function projectionFromItem(item: LoopItemLedgerEntry | undefined | null): ItemStageProjection | null {
  if (!item || typeof item.current_stage !== "string" || item.current_stage.length === 0) return null;
  const proj: ItemStageProjection = {
    current_stage: item.current_stage,
    current_stage_updated_at:
      typeof item.current_stage_updated_at === "string" && item.current_stage_updated_at.length > 0
        ? item.current_stage_updated_at
        : "",
  };
  if (typeof item.current_stage_round === "number" && Number.isFinite(item.current_stage_round)) {
    proj.current_stage_round = item.current_stage_round;
  }
  if (typeof item.advance_run_id === "string" && item.advance_run_id.length > 0) {
    proj.advance_run_id = item.advance_run_id;
  }
  return proj;
}

/** Apply projection fields onto a ledger item entry (immutable). */
export function withStageProjection(item: LoopItemLedgerEntry, projection: ItemStageProjection): LoopItemLedgerEntry {
  const next: LoopItemLedgerEntry = {
    ...item,
    current_stage: projection.current_stage,
    current_stage_updated_at: projection.current_stage_updated_at,
  };
  if (projection.current_stage_round !== undefined) {
    next.current_stage_round = projection.current_stage_round;
  } else {
    delete next.current_stage_round;
  }
  if (projection.advance_run_id) {
    next.advance_run_id = projection.advance_run_id;
  } else {
    delete next.advance_run_id;
  }
  return next;
}

/** Human stage presentation: `implementing` or `plan-review (round 1)`. */
export function formatStagePresentation(stage: string, round?: number): string {
  if (round !== undefined && Number.isFinite(round)) return `${stage} (round ${round})`;
  return stage;
}

/** Format one audit stage-table row for an item. */
export function formatAuditStageTableRow(row: StageProgressTableRow): string {
  const id = row.item_id.startsWith("#") ? row.item_id : `#${row.item_id}`;
  const stageCol = row.stage_presentation.padEnd(24);
  if (row.advance_run_id) {
    return `${id}  ${stageCol}(advance run ${row.advance_run_id})`;
  }
  if (row.state === "pending" || row.stage_presentation === "pending" || row.stage_presentation === "queued") {
    return `${id}  ${stageCol}(queued)`;
  }
  return `${id}  ${stageCol}`.trimEnd();
}

/** Build the audit stage table from a ledger (pure). Prefer real advance_run_id. */
export function buildStageProgressTable(ledger: LoopLedger): StageProgressTableRow[] {
  const ids = Object.keys(ledger.items).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  return ids.map((id) => stageProgressRowForItem(id, ledger.items[id]));
}

export function stageProgressRowForItem(itemId: string, item: LoopItemLedgerEntry): StageProgressTableRow {
  const proj = projectionFromItem(item);
  if (proj) {
    return {
      item_id: itemId,
      state: item.state,
      stage_presentation: formatStagePresentation(proj.current_stage, proj.current_stage_round),
      ...(proj.advance_run_id ? { advance_run_id: proj.advance_run_id } : {}),
      has_projection: true,
    };
  }
  // No projection: present coarse state; queued/pending never invent an advance run id.
  const presentation =
    item.state === "pending"
      ? "pending"
      : item.state === "in_progress"
        ? "in_progress"
        : item.state === "ready"
          ? "ready-to-deploy"
          : item.state === "blocked"
            ? "blocked"
            : item.state;
  return {
    item_id: itemId,
    state: item.state,
    stage_presentation: presentation,
    has_projection: false,
  };
}

/** One-line follow/progress rendering of a structured stage-progress event. */
export function formatStageProgressFollowLine(data: StageProgressEventData): string {
  const id = data.item_id.startsWith("#") ? data.item_id : `#${data.item_id}`;
  const stage = formatStagePresentation(data.stage, data.round);
  if (data.advance_run_id) {
    return `${data.at}  ${id}  ${stage}  (advance run ${data.advance_run_id})`;
  }
  return `${data.at}  ${id}  ${stage}`;
}

/** Parse a loop event record into stage-progress data when kind matches. */
export function parseStageProgressEventData(kind: string, data: unknown): StageProgressEventData | null {
  if (kind !== LOOP_ITEM_STAGE_PROGRESS) return null;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.item_id !== "string" || typeof d.stage !== "string") return null;
  const out: StageProgressEventData = {
    item_id: d.item_id,
    stage: d.stage,
    at: typeof d.at === "string" ? d.at : "",
  };
  if (typeof d.round === "number" && Number.isFinite(d.round)) out.round = d.round;
  if (typeof d.advance_run_id === "string" && d.advance_run_id.length > 0) {
    out.advance_run_id = d.advance_run_id;
  }
  return out;
}

/** Terminal dispatch outcome → optional stage presentation for reconciliation. */
export function terminalStageForOutcome(outcome: string): string | null {
  switch (outcome) {
    case "ready_to_deploy":
      return "ready-to-deploy";
    case "blocked_needs_human":
      return "blocked";
    case "abandoned":
      return "abandoned";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Apply a material stage projection to the ledger and append a structured
 * loop event. No-op when the delta is not material. Returns the updated ledger.
 */
export async function recordItemStageProgress(
  store: LoopStoreDeps,
  input: {
    runId: string;
    token: string;
    itemId: string;
    projection: ItemStageProjection;
  },
): Promise<LoopLedger> {
  const ledger = await readLedger(store, input.runId);
  const item = ledger.items[input.itemId];
  if (!item) return ledger;

  const previous = projectionFromItem(item);
  if (!isMaterialStageChange(previous, input.projection)) return ledger;

  const updatedItem = withStageProjection(item, input.projection);
  const newLedger: LoopLedger = {
    ...ledger,
    items: { ...ledger.items, [input.itemId]: updatedItem },
  };
  await writeLedger(store, newLedger, input.token);

  const eventData: StageProgressEventData = {
    item_id: input.itemId,
    stage: input.projection.current_stage,
    at: input.projection.current_stage_updated_at,
    ...(input.projection.current_stage_round !== undefined
      ? { round: input.projection.current_stage_round }
      : {}),
    ...(input.projection.advance_run_id ? { advance_run_id: input.projection.advance_run_id } : {}),
  };
  await appendEvent(store, input.runId, input.token, LOOP_ITEM_STAGE_PROGRESS, eventData);
  return newLedger;
}

/**
 * Fold a batch of advance events into successive material ledger updates.
 * Processes events in order; skips non-material duplicates.
 */
export async function applyAdvanceEventsToStageProgress(
  store: LoopStoreDeps,
  input: {
    runId: string;
    token: string;
    itemId: string;
    advance_run_id: string;
    events: AdvanceStageEvent[];
    /** Already-consumed event count (line offset); only events after this are applied. */
    fromIndex?: number;
  },
): Promise<{ ledger: LoopLedger; nextIndex: number; updates: number }> {
  let ledger = await readLedger(store, input.runId);
  const from = input.fromIndex ?? 0;
  let updates = 0;
  const now = store.now().toISOString();

  for (let i = from; i < input.events.length; i++) {
    const item = ledger.items[input.itemId];
    if (!item) break;
    const current = projectionFromItem(item);
    // Prefer the real linked advance id; never invent a synthetic-only drill-down.
    const delta = mapAdvanceEventToStageDelta(input.events[i], current, {
      advance_run_id: input.advance_run_id,
      now,
    });
    if (!delta.material) continue;
    ledger = await recordItemStageProgress(store, {
      runId: input.runId,
      token: input.token,
      itemId: input.itemId,
      projection: delta.projection,
    });
    updates++;
  }
  return { ledger, nextIndex: input.events.length, updates };
}

/**
 * On terminal dispatch outcome, reconcile stage presentation with the outcome
 * without inventing a live advance path when none was linked.
 */
export async function reconcileTerminalStageProgress(
  store: LoopStoreDeps,
  input: {
    runId: string;
    token: string;
    itemId: string;
    outcome: string;
    advance_run_id?: string;
  },
): Promise<LoopLedger> {
  const terminalStage = terminalStageForOutcome(input.outcome);
  if (!terminalStage) {
    // Still mirror advance_run_id when known without inventing a stage.
    if (!input.advance_run_id) return readLedger(store, input.runId);
    const ledger = await readLedger(store, input.runId);
    const item = ledger.items[input.itemId];
    if (!item) return ledger;
    const prev = projectionFromItem(item);
    if (prev?.advance_run_id === input.advance_run_id) return ledger;
    if (!prev) return ledger;
    return recordItemStageProgress(store, {
      runId: input.runId,
      token: input.token,
      itemId: input.itemId,
      projection: { ...prev, advance_run_id: input.advance_run_id },
    });
  }

  const ledger = await readLedger(store, input.runId);
  const item = ledger.items[input.itemId];
  if (!item) return ledger;
  const prev = projectionFromItem(item);
  const now = store.now().toISOString();
  const projection: ItemStageProjection = {
    current_stage: terminalStage,
    current_stage_updated_at: now,
    ...(input.advance_run_id
      ? { advance_run_id: input.advance_run_id }
      : prev?.advance_run_id
        ? { advance_run_id: prev.advance_run_id }
        : {}),
  };
  return recordItemStageProgress(store, {
    runId: input.runId,
    token: input.token,
    itemId: input.itemId,
    projection,
  });
}

/** Status-item fields for current-stage when present. */
export function statusItemStageFields(item: LoopItemLedgerEntry): {
  state: LoopItemState;
  current_stage?: string;
  current_stage_round?: number;
  advance_run_id?: string;
} {
  const base: {
    state: LoopItemState;
    current_stage?: string;
    current_stage_round?: number;
    advance_run_id?: string;
  } = { state: item.state };
  const proj = projectionFromItem(item);
  if (!proj) return base;
  base.current_stage = proj.current_stage;
  if (proj.current_stage_round !== undefined) base.current_stage_round = proj.current_stage_round;
  if (proj.advance_run_id) base.advance_run_id = proj.advance_run_id;
  return base;
}

/**
 * Default advance-events reader: parse JSONL text into event objects.
 * Returns [] when text is null/empty or unparseable lines are skipped.
 */
export function parseAdvanceEventsJsonl(text: string | null): AdvanceStageEvent[] {
  if (!text) return [];
  const out: AdvanceStageEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AdvanceStageEvent;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/**
 * Read-only whole-run stage-progress follow (#611).
 *
 * Streams clean one-line stage transitions from the durable loop `events.jsonl`
 * (`loop_item_stage_progress` only). Does **not** re-emit harness stdout or
 * per-item `terminal.log`. Acquires no store lock, writes no ledger, holds no
 * run-liveness reservation. Stops on SIGINT/SIGTERM (unless `once` is set).
 */
export async function followLoopStageProgress(
  runId: string,
  opts: {
    store: LoopStoreDeps;
    /** Poll interval ms (default 500). */
    pollMs?: number;
    /** Injectable sleep for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** When true, print historical stage events once and return (no poll loop). */
    once?: boolean;
    stdoutWrite?: (s: string) => void;
    stderrWrite?: (s: string) => void;
  },
): Promise<void> {
  const write = opts.stdoutWrite ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.stderrWrite ?? ((s: string) => process.stderr.write(s));
  const pollMs = opts.pollMs ?? 500;
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  writeErr(`pipeline loop: following stage progress for run ${runId} (Ctrl-C to stop)\n`);

  let seenSeq = -1;
  const emitFromEvents = async (): Promise<void> => {
    let events: Array<{ seq: number; time: string; kind: string; data: unknown }>;
    try {
      events = await readEvents(opts.store, runId);
    } catch {
      return;
    }
    for (const ev of events) {
      if (ev.seq <= seenSeq) continue;
      seenSeq = ev.seq;
      const data = parseStageProgressEventData(ev.kind, ev.data);
      if (!data) continue;
      if (!data.at) data.at = ev.time;
      write(formatStageProgressFollowLine(data) + "\n");
    }
  };

  await emitFromEvents();
  if (opts.once) return;

  let stop = false;
  const onSig = () => {
    stop = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  try {
    while (!stop) {
      await sleepFn(pollMs);
      if (stop) break;
      await emitFromEvents();
    }
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  }
}
