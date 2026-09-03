// Human-intervention taxonomy and factory-debt recording (#302).
//
// Defines the closed `HumanInterventionKind` enum, the event shape, and the
// helpers for emitting events and summarizing them. Imported by stage files
// and run-store.ts; does NOT import from run-store.ts (avoids circular dep).

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import { type BlockerKind } from "./types.ts";
import {
  buildEventAttributionFields,
  isDiscoveryChannel,
  runLevelDiscoveryChannel,
  type DiscoveryChannel,
} from "./engine-attribution.ts";

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const HUMAN_INTERVENTION_KINDS = [
  "ambiguous-issue",
  "product-judgment-required",
  "plan-review-feedback",
  "review-non-convergence",
  "test-build-failure",
  "eval-shipcheck-failure",
  "merge-conflict-or-branch-drift",
  "auth-tooling-preflight-failure",
  "human-risk-override",
  "reviewer-unavailable",
  "unknown",
] as const;

export type HumanInterventionKind = (typeof HUMAN_INTERVENTION_KINDS)[number];

/** Reporting dimension only — these kinds do not grant human ownership. */
export const REPORTING_ONLY_HUMAN_INTERVENTION_KINDS = [
  "review-non-convergence",
  "test-build-failure",
  "eval-shipcheck-failure",
  "merge-conflict-or-branch-drift",
  "auth-tooling-preflight-failure",
  "reviewer-unavailable",
  "unknown",
] as const satisfies readonly HumanInterventionKind[];

export function interventionKindGrantsHumanOwnership(kind: HumanInterventionKind): boolean {
  return !(REPORTING_ONLY_HUMAN_INTERVENTION_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export interface HumanInterventionEvent {
  schema_version: 1;
  type: "human_intervention";
  at: string;
  kind: HumanInterventionKind;
  stage: string | null;
  issue: number;
  detail: string;
  ref?: string | null;
  /**
   * Shared id pairing this intervention with a co-emitted `blocker_set` for the
   * same off-ramp (#683 review 2). Additive optional — absent on pre-pair
   * historical events.
   */
  offramp_id?: string;
  /**
   * Optional correlation to a durable human-question handoff (#647). Kind alone
   * never authorizes resume; handoff resume rules apply independently.
   * Additive optional — does not change HumanInterventionKind.
   */
  handoff_id?: string;
  /**
   * Engine + discovery attribution (#763). New producers stamp discovery_channel
   * from the caller or from the active run's persisted `run.json` channel.
   * Historical events without these fields remain countable; collectors may
   * still inherit from run.json when the event field is absent.
   */
  engine_version?: string;
  engine_commit_sha?: string | null;
  discovery_channel?: DiscoveryChannel;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Minimal deps for appending an event line. Structurally compatible with
 *  `RunStoreDeps` so callers can pass `opts.runStoreDeps` directly. */
export interface EmitInterventionDeps {
  appendFile: (p: string, data: string) => Promise<void>;
  /** Optional: read run.json for write-time discovery-channel resolution (#763). */
  readFile?: (p: string) => Promise<string>;
  stdoutWrite?: (line: string) => void;
}

const defaultEmitDeps: EmitInterventionDeps = {
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
  readFile: (p) => fsp.readFile(p, "utf8"),
};

/**
 * Resolve discovery_channel for a newly written intervention event.
 * Priority: validated caller payload → persisted run.json stamp.
 * Never invents live-run when both are absent/invalid.
 */
async function resolveInterventionDiscoveryChannel(
  runDir: string,
  payloadChannel: DiscoveryChannel | null | undefined,
  deps: EmitInterventionDeps,
): Promise<DiscoveryChannel | undefined> {
  if (isDiscoveryChannel(payloadChannel)) return payloadChannel;
  const readFile = deps.readFile ?? defaultEmitDeps.readFile;
  if (!readFile) return undefined;
  try {
    const raw = await readFile(path.join(runDir, "run.json"));
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const fromRun = runLevelDiscoveryChannel(meta);
    return fromRun ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append a `human_intervention` event to `events.jsonl`.
 *
 * Non-fatal: any I/O failure is caught and logged as a warning — the calling
 * stage's outcome is never affected by a failed event write.
 * When `runDir` is undefined the call is a no-op.
 *
 * The `detail` and `ref` fields are subject to the write-time injection
 * denylist (same redaction applied to all run-artifact values).
 */
export async function emitHumanIntervention(
  runDir: string | undefined,
  payload: {
    kind: HumanInterventionKind;
    stage: string | null;
    issue: number;
    detail: string;
    ref?: string | null;
    /** Shared pair id with co-emitted blocker_set (#683 review 2). */
    offramp_id?: string;
    /** Optional correlation to a durable human-question handoff (#647). */
    handoff_id?: string;
    /** Optional engine identity for attribution stamps (#763). */
    engine_version?: string | null;
    engine_commit_sha?: string | null;
    discovery_channel?: DiscoveryChannel | null;
  },
  deps: EmitInterventionDeps = defaultEmitDeps,
): Promise<void> {
  if (!runDir) return;
  try {
    // Attribution enrichment is best-effort: failure to resolve identity must
    // never change the stage outcome (non-fatal emission remains).
    // Prefer caller-supplied channel; else stamp from run.json so the event is
    // offline-classifiable without collector-side inheritance. Never invent
    // live-run when both are absent/invalid (#763 pre-merge delta b32309e8).
    const discoveryChannel = await resolveInterventionDiscoveryChannel(
      runDir,
      payload.discovery_channel,
      deps,
    );
    if (discoveryChannel === undefined) {
      console.warn(
        "[pipeline] intervention: unresolved discovery_channel for human_intervention " +
          `(issue ${payload.issue}); event written without channel stamp`,
      );
    }
    const attribution = buildEventAttributionFields({
      version: payload.engine_version,
      commit_sha: payload.engine_commit_sha,
      discovery_channel: discoveryChannel,
    });
    const event: HumanInterventionEvent = {
      schema_version: 1,
      type: "human_intervention",
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      kind: payload.kind,
      stage: payload.stage,
      issue: payload.issue,
      detail: sanitize(redactSecrets(payload.detail)),
      ...(payload.ref != null
        ? { ref: sanitize(redactSecrets(String(payload.ref))) }
        : {}),
      ...(payload.offramp_id != null && payload.offramp_id !== ""
        ? { offramp_id: payload.offramp_id }
        : {}),
      ...(payload.handoff_id != null && payload.handoff_id !== ""
        ? { handoff_id: payload.handoff_id }
        : {}),
      ...attribution,
    };
    const line = `${JSON.stringify(event)}\n`;
    await deps.appendFile(path.join(runDir, "events.jsonl"), line);
    if (deps.stdoutWrite) {
      deps.stdoutWrite(line);
    }
  } catch (err) {
    console.warn(
      `[pipeline] intervention: emitHumanIntervention failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

export interface InterventionSummary {
  total: number;
  byKind: Record<HumanInterventionKind, number>;
  items: HumanInterventionEvent[];
}

/** Build a zero-initialized `byKind` record for all known kinds. */
function zeroByKind(): Record<HumanInterventionKind, number> {
  const out = {} as Record<HumanInterventionKind, number>;
  for (const k of HUMAN_INTERVENTION_KINDS) {
    out[k] = 0;
  }
  return out;
}

/**
 * Aggregate `human_intervention` events by kind over an optional time window.
 *
 * - Accepts the full event array from one or more `events.jsonl` files
 *   (unknown fields are preserved; non-`human_intervention` events are ignored).
 * - When `windowMs` is provided, only events whose `at` timestamp falls within
 *   the last `windowMs` milliseconds of the most recent event's timestamp are
 *   counted.
 * - Unrecognized `kind` strings are counted under `"unknown"`.
 * - An empty or all-filtered array returns a zero summary.
 */
export function summarizeInterventions(
  events: Record<string, unknown>[],
  windowMs?: number,
): InterventionSummary {
  // Filter for human_intervention events only.
  let items = events.filter(
    (e): e is HumanInterventionEvent =>
      e.type === "human_intervention" &&
      typeof e.at === "string" &&
      typeof e.issue === "number",
  ) as HumanInterventionEvent[];

  // Apply time-window filter when requested.
  if (windowMs !== undefined && windowMs >= 0 && items.length > 0) {
    const maxAt = items.reduce(
      (max, e) => Math.max(max, Date.parse(e.at) || 0),
      0,
    );
    const cutoff = maxAt - windowMs;
    items = items.filter((e) => (Date.parse(e.at) || 0) >= cutoff);
  }

  const byKind = zeroByKind();
  for (const item of items) {
    const k: HumanInterventionKind =
      HUMAN_INTERVENTION_KINDS.includes(item.kind as HumanInterventionKind)
        ? (item.kind as HumanInterventionKind)
        : "unknown";
    byKind[k]++;
  }

  return { total: items.length, byKind, items };
}

// ---------------------------------------------------------------------------
// Blocker-kind mapping
// ---------------------------------------------------------------------------

/**
 * Map a `BlockerKind` value to the closest `HumanInterventionKind` for emission
 * at the common `blocker_set` orchestrator point. Guarantees ordering:
 * `blocker_set` is written first by the orchestrator, then this function is
 * called to emit the `human_intervention` event immediately after.
 */
export function blockerKindToInterventionKind(kind: BlockerKind): HumanInterventionKind {
  switch (kind) {
    case "test-gate-exhausted":
    case "review-findings":
    case "ci-exhausted":
    case "no-commits":
    case "push-failed":
    case "build-failed":
      return "test-build-failure";
    case "eval-gate-failed":
    case "eval-gate-misconfigured":
    case "shipcheck-failed":
      return "eval-shipcheck-failure";
    case "merge-conflict":
    case "head-drift":
      return "merge-conflict-or-branch-drift";
    case "worktree-missing":
    case "worktree-creation-failed":
    case "worktree-capacity":
    case "worktree-setup-failed":
    case "pr-creation-failed":
    case "plan-gen-failed":
      return "auth-tooling-preflight-failure";
    case "harness-failure":
    case "review-independent-quorum-unmet":
    case "review-no-usable-reviewers":
    case "review-prompt-too-large":
      return "reviewer-unavailable";
    case "openspec-invalid":
    case "openspec-stale-delta":
    case "no-pull-request":
    case "needs-human":
    case "human-decision-required":
      return "product-judgment-required";
    default:
      return "unknown";
  }
}
