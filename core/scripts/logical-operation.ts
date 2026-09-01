// Logical-operation identity (#1368).
//
// Opaque immutable root-admission id, distinct from physical `run_id`.
// Resume binding is explicit durable identity — never guessed from issue
// number, recency, PATH candidate, or comment prose.

import * as crypto from "node:crypto";

export const LOGICAL_OPERATION_ID_PREFIX = "lop-" as const;

/** Mint an opaque logical-operation id. Not derived from run_id, issue, or time. */
export function mintLogicalOperationId(
  randomBytes: (n: number) => Buffer = (n) => crypto.randomBytes(n),
): string {
  return `${LOGICAL_OPERATION_ID_PREFIX}${randomBytes(16).toString("hex")}`;
}

export function isLogicalOperationId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(LOGICAL_OPERATION_ID_PREFIX) && value.length > LOGICAL_OPERATION_ID_PREFIX.length;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Resolve the logical-operation id from valid resume bindings, in design order:
 * written run directory, loop-store contract, parent handoff, named-run resume.
 * If none is present, mint a new id. Never copies by issue number or recency.
 */
export function resolveLogicalOperationId(input: {
  written?: string | null;
  loopStore?: string | null;
  parent?: string | null;
  namedRun?: string | null;
  mint?: () => string;
}): string {
  const written = nonEmpty(input.written);
  if (written) return written;
  const loopStore = nonEmpty(input.loopStore);
  if (loopStore) return loopStore;
  const parent = nonEmpty(input.parent);
  if (parent) return parent;
  const namedRun = nonEmpty(input.namedRun);
  if (namedRun) return namedRun;
  return (input.mint ?? mintLogicalOperationId)();
}
