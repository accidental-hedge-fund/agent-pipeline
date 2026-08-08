// Frozen runtime dependency for the v1.33.0 bootstrap FRG policy.
//
// The credential-scoped attestor imports this wrapper-owned copy. It must not
// resolve any module from the release-candidate checkout. Keep the blocker
// catalogue equal to core/scripts/loop/types.ts for the reviewed #898 artifact.

export const DURABLE_BLOCKER_CLASSES = [
  "transient-rate-limit",
  "workflow-state",
  "implementation-ci",
  "review-findings",
  "environment-auth",
  "specification-decision",
  "missing-authority",
  "upstream-dependency",
  "workflow-engine-defect",
] as const;

export type DurableBlockerClass = (typeof DURABLE_BLOCKER_CLASSES)[number];

export function isDurableBlockerClass(value: unknown): value is DurableBlockerClass {
  return typeof value === "string" && (DURABLE_BLOCKER_CLASSES as readonly string[]).includes(value);
}

// These types are erased by Node's TypeScript loader. They document the narrow
// data shapes used by the frozen scorer without adding another runtime module.
export type LoopItemState = string;

export interface LoopContract {
  schema?: string;
  run_id?: string;
  selector?: { type?: string; value?: string };
  items?: Array<{ id?: string; depends_on?: string[] }>;
}

export interface LoopLedger {
  schema?: string;
  run_id?: string;
  items?: Record<string, {
    state?: string;
    blocked_theme?: string | null;
  }>;
}
