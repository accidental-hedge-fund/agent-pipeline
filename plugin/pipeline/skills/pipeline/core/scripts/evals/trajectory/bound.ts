// Deterministic head/tail bounding for trajectory/verifier artifact channels
// (#536, eval-trajectory-artifacts task 2.2). Pure functions: bounding the
// same input with the same ceilings twice yields byte-identical output.

import type { TruncationInfo } from "./types.ts";

export interface BoundCeilings {
  /** Max array length for a bounded item channel (e.g. tool_events, stages). */
  maxEvents: number;
  /** Max serialized byte size for a bounded item channel or text blob. */
  maxBytes: number;
}

export const DEFAULT_TRAJECTORY_CEILINGS: BoundCeilings = {
  maxEvents: 200,
  maxBytes: 200_000,
};

const NO_TRUNCATION: TruncationInfo = { status: "none", dropped_event_count: 0, dropped_byte_count: 0 };

function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Merge per-channel truncation accounting into one overall record. */
export function mergeTruncations(parts: TruncationInfo[]): TruncationInfo {
  let droppedEvents = 0;
  let droppedBytes = 0;
  let truncated = false;
  for (const p of parts) {
    droppedEvents += p.dropped_event_count;
    droppedBytes += p.dropped_byte_count;
    if (p.status === "truncated") truncated = true;
  }
  return {
    status: truncated ? "truncated" : "none",
    dropped_event_count: droppedEvents,
    dropped_byte_count: droppedBytes,
  };
}

/** Deterministic head/tail retention over a homogeneous item array: when
 *  `items.length` exceeds `ceilings.maxEvents`, keep a head+tail split and
 *  drop the middle. The retained set is then trimmed further, one item at a
 *  time from the middle outward, until its total serialized size is within
 *  `ceilings.maxBytes`. Every dropped item is accounted for in the returned
 *  `TruncationInfo`. */
export function boundItems<T>(
  items: readonly T[],
  ceilings: BoundCeilings,
  serialize: (item: T) => string,
): { items: T[]; truncation: TruncationInfo } {
  let working = items.slice();
  let droppedEvents = 0;
  let droppedBytes = 0;

  if (working.length > ceilings.maxEvents) {
    const headCount = Math.ceil(ceilings.maxEvents / 2);
    const tailCount = ceilings.maxEvents - headCount;
    const head = working.slice(0, headCount);
    const tail = tailCount > 0 ? working.slice(working.length - tailCount) : [];
    const middle = working.slice(headCount, working.length - tailCount);
    droppedEvents += middle.length;
    droppedBytes += middle.reduce((sum, item) => sum + utf8Len(serialize(item)), 0);
    working = [...head, ...tail];
  }

  let totalBytes = working.reduce((sum, item) => sum + utf8Len(serialize(item)), 0);
  while (totalBytes > ceilings.maxBytes && working.length > 0) {
    const midIndex = Math.floor(working.length / 2);
    const removed = working.splice(midIndex, 1)[0];
    const removedBytes = utf8Len(serialize(removed));
    droppedEvents += 1;
    droppedBytes += removedBytes;
    totalBytes -= removedBytes;
  }

  if (droppedEvents === 0) {
    return { items: working, truncation: NO_TRUNCATION };
  }
  return {
    items: working,
    truncation: { status: "truncated", dropped_event_count: droppedEvents, dropped_byte_count: droppedBytes },
  };
}

/** Deterministic head/tail retention over a single text blob. */
export function boundText(text: string, maxBytes: number): { text: string; truncation: TruncationInfo } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncation: NO_TRUNCATION };
  }
  const headBytes = Math.ceil(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = bytes.subarray(0, headBytes).toString("utf8");
  const tail = tailBytes > 0 ? bytes.subarray(bytes.length - tailBytes).toString("utf8") : "";
  const droppedBytes = bytes.length - headBytes - tailBytes;
  return {
    text: `${head}\n...[truncated ${droppedBytes} bytes]...\n${tail}`,
    truncation: { status: "truncated", dropped_event_count: 1, dropped_byte_count: droppedBytes },
  };
}
