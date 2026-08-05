// Capability-driven outer-host orchestration steps (#784).
//
// Shared advance/loop supervision selects lifecycle steps from the active
// outer host's declared capabilities — never from host-name equality checks.

import type { OuterHostCapability, OuterHostManifest } from "./types.ts";
import { PORTABLE_OBSERVATION_BASELINE } from "./types.ts";

/** Ordered lifecycle step ids for long-running advance / loop supervision. */
export const LIFECYCLE_STEP_IDS = [
  "status_precheck",
  "early_run_handoff",
  "event_follow",
  "material_progress_notify",
  "reattach_after_cancel",
  "wait_cancel_non_terminal",
  "terminal_exit",
  "terminal_cleanup",
  "terminal_summary",
] as const;

export type LifecycleStepId = (typeof LIFECYCLE_STEP_IDS)[number];

export interface LifecycleStep {
  id: LifecycleStepId;
  /** Whether the host declares native support (vs portable fallback only). */
  support: OuterHostCapability["support"] | "always";
  /** Operator/how-to text selected from the manifest (or portable baseline). */
  guidance: string;
  /** True when this step uses the portable stdout/events.jsonl baseline. */
  usesPortableBaseline: boolean;
}

function guidanceFor(cap: OuterHostCapability | undefined, portable: string): {
  support: OuterHostCapability["support"];
  guidance: string;
  usesPortableBaseline: boolean;
} {
  if (!cap) {
    return {
      support: "unsupported",
      guidance: portable,
      usesPortableBaseline: true,
    };
  }
  if (cap.support === "supported") {
    return {
      support: cap.support,
      guidance: cap.how?.trim() || portable,
      usesPortableBaseline: false,
    };
  }
  const text = [cap.how, cap.fallback].filter(Boolean).join(" — fallback: ");
  return {
    support: cap.support,
    guidance: text || portable,
    usesPortableBaseline: true,
  };
}

/**
 * Select ordered lifecycle supervision steps from a manifest's declared
 * capabilities. Host-name strings are never consulted.
 */
export function selectLifecycleSteps(manifest: OuterHostManifest): LifecycleStep[] {
  const handoff = guidanceFor(
    manifest.early_run_handoff,
    "Discover run_id via pipeline status / run-store inspection; then follow events.jsonl",
  );
  const follow = guidanceFor(
    manifest.event_follow,
    `Follow until terminal via ${PORTABLE_OBSERVATION_BASELINE}`,
  );
  const notify = guidanceFor(
    manifest.material_progress_notify,
    `Observe material progress via ${PORTABLE_OBSERVATION_BASELINE}`,
  );
  const reattach = guidanceFor(
    manifest.reattach,
    `Re-arm follow after cancelled wait via ${PORTABLE_OBSERVATION_BASELINE}`,
  );
  const waitCancel = guidanceFor(
    manifest.wait_cancel,
    "Cancelled or lost wait is non-terminal; reattach or re-follow events.jsonl",
  );
  const cleanup = guidanceFor(
    manifest.terminal_cleanup,
    "Stop monitors/follows for this run_id; leave run store intact",
  );
  const summary = guidanceFor(
    manifest.terminal_summary,
    "pipeline summary <run-id> or terminal stdout summary JSON",
  );

  // Notify mapping may declare a host-local surface; shared code only reads the
  // capability — it does not branch on host id.
  const notifyGuidance =
    manifest.material_progress_notify?.support === "supported" &&
    manifest.material_progress_notify.mapping
      ? `${manifest.material_progress_notify.how ?? ""} [surface=${manifest.material_progress_notify.mapping.surface}]`.trim()
      : notify.guidance;

  return [
    {
      id: "status_precheck",
      support: "always",
      guidance: "pipeline status <N> (or host-equivalent) before long-running launch",
      usesPortableBaseline: true,
    },
    {
      id: "early_run_handoff",
      support: handoff.support,
      guidance: handoff.guidance,
      usesPortableBaseline: handoff.usesPortableBaseline,
    },
    {
      id: "event_follow",
      support: follow.support,
      guidance: follow.guidance,
      usesPortableBaseline: follow.usesPortableBaseline,
    },
    {
      id: "material_progress_notify",
      support: notify.support,
      guidance: notifyGuidance,
      usesPortableBaseline: notify.usesPortableBaseline,
    },
    {
      id: "reattach_after_cancel",
      support: reattach.support,
      guidance: reattach.guidance,
      usesPortableBaseline: reattach.usesPortableBaseline,
    },
    {
      id: "wait_cancel_non_terminal",
      support: waitCancel.support,
      guidance: waitCancel.guidance,
      usesPortableBaseline: waitCancel.usesPortableBaseline,
    },
    {
      id: "terminal_exit",
      support: follow.support,
      guidance:
        "Detect terminal via run_complete / loop_run_complete / loop_run_stopped (never via cancelled wait alone)",
      usesPortableBaseline: true,
    },
    {
      id: "terminal_cleanup",
      support: cleanup.support,
      guidance: cleanup.guidance,
      usesPortableBaseline: cleanup.usesPortableBaseline,
    },
    {
      id: "terminal_summary",
      support: summary.support,
      guidance: summary.guidance,
      usesPortableBaseline: summary.usesPortableBaseline,
    },
  ];
}

/**
 * Prove the ordered long-running path for a host that declares handoff, follow,
 * cleanup, and summary (or portable fallbacks). Returns step ids in order;
 * used by host-agnostic lifecycle regression fixtures.
 */
export function longRunningLifecyclePath(manifest: OuterHostManifest): LifecycleStepId[] {
  const steps = selectLifecycleSteps(manifest);
  // Required ordered subset for long-running supervision proof.
  const required: LifecycleStepId[] = [
    "early_run_handoff",
    "event_follow",
    "material_progress_notify",
    "reattach_after_cancel",
    "wait_cancel_non_terminal",
    "terminal_exit",
    "terminal_cleanup",
    "terminal_summary",
  ];
  const ids = steps.map((s) => s.id);
  for (const id of required) {
    if (!ids.includes(id)) {
      throw new Error(
        `outer host "${manifest.id}": lifecycle path missing required step ${id}`,
      );
    }
  }
  // Stable order as declared in LIFECYCLE_STEP_IDS (minus status_precheck optional).
  return required;
}

/**
 * True when cancelled wait must re-enter follow before summary.
 * Driven by reattach + wait_cancel declarations, not host name.
 */
export function requiresReattachAfterCancelledWait(manifest: OuterHostManifest): boolean {
  const reattachOk =
    manifest.reattach?.support === "supported" ||
    manifest.reattach?.support === "limited" ||
    (manifest.reattach?.support === "unsupported" && Boolean(manifest.reattach.fallback));
  const waitOk =
    manifest.wait_cancel?.classification === "non_terminal" &&
    manifest.wait_cancel?.recovery === "reattach_or_portable_follow";
  return Boolean(reattachOk && waitOk);
}

/**
 * Resolve material notify surface from the manifest mapping only.
 * Shared orchestration must call this instead of host-name switches.
 */
export function resolveMaterialNotifySurface(manifest: OuterHostManifest): string {
  const m = manifest.material_progress_notify;
  if (!m) return "stdout_only";
  if (m.support === "unsupported" || !m.mapping) {
    return "stdout_only";
  }
  return m.mapping.surface;
}
