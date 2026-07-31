// Shared material-event filter for host progress notify (#742).
//
// Pure observation layer over advance and loop `events.jsonl` lines. Prints
// skill-material one-liners suitable for host Monitor / Grok `monitor` /
// Codex chat bubbles. Never rewrites the run-store file.
//
// Event field inventory (engine writers — do not invent shapes):
// - Advance (`run-store.ts` / stages): JSON objects with `type` (not `kind`):
//   run_start, stage_start, stage_complete, pr_created, pr_updated,
//   review_verdict, gate_result, blocker_set, blocker_cleared, run_complete, …
// - Loop (`loop/store.ts` appendEvent): JSON objects with `kind` + `data`:
//   loop_item_started, loop_item_transitioned, loop_item_blocked,
//   loop_item_advance_linked, loop_item_advance_finished,
//   loop_item_stage_progress, loop_item_progress, loop_run_stopped, …

import * as fs from "node:fs";
import * as readline from "node:readline";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Single-source kind lists (imported by filter + drift-guards)
// ---------------------------------------------------------------------------

/** Advance event `type` values that warrant host progress notify. */
export const ADVANCE_MATERIAL_KINDS = [
  "run_start",
  "stage_start",
  "stage_complete",
  "pr_created",
  "pr_updated",
  "review_verdict",
  "gate_result",
  "blocker_set",
  "blocker_cleared",
  "run_complete",
] as const;

export type AdvanceMaterialKind = (typeof ADVANCE_MATERIAL_KINDS)[number];

/** Loop event `kind` values that warrant host progress notify (must set). */
export const LOOP_MATERIAL_KINDS = [
  "loop_item_started",
  "loop_item_transitioned",
  "loop_item_blocked",
  "loop_item_advance_linked",
  "loop_item_advance_finished",
  "loop_item_stage_progress",
  "loop_item_progress",
  "loop_run_stopped",
] as const;

export type LoopMaterialKind = (typeof LOOP_MATERIAL_KINDS)[number];

/**
 * Loop kinds that MAY surface when present, with burst suppression (not every
 * identical poll). Documented in host skill "should notify" lists.
 */
export const LOOP_OPTIONAL_MATERIAL_KINDS = [
  "loop_schedule_evaluated",
  "loop_reconciled",
  "loop_merge_barrier_cleared",
  "loop_item_paused",
  "loop_item_waiting",
  "loop_item_resumed",
  "loop_item_abandoned",
  "loop_item_skipped",
  "loop_item_precondition_excluded",
  "loop_recovery_attempt",
  "loop_run_superseded",
] as const;

export type LoopOptionalMaterialKind = (typeof LOOP_OPTIONAL_MATERIAL_KINDS)[number];

const ADVANCE_SET = new Set<string>(ADVANCE_MATERIAL_KINDS);
const LOOP_MUST_SET = new Set<string>(LOOP_MATERIAL_KINDS);
const LOOP_OPTIONAL_SET = new Set<string>(LOOP_OPTIONAL_MATERIAL_KINDS);

/** Definitive pre-merge progress statuses (always material when on loop stream). */
export const LOOP_PROGRESS_DEFINITIVE_STATUSES = [
  "pass",
  "fail",
  "approve",
  "needs_attention",
  "attempted",
  "success",
  "exhausted",
  "blocked",
  "advanced",
  "started",
] as const;

const DEFINITIVE_STATUS = new Set<string>(LOOP_PROGRESS_DEFINITIVE_STATUSES);

// ---------------------------------------------------------------------------
// Stateful filter
// ---------------------------------------------------------------------------

export interface MaterialFilterOptions {
  /**
   * When true, emit the original JSONL line (still material-selected) instead
   * of a human one-liner. Default false (one-liners for host bubbles).
   */
  jsonl?: boolean;
}

export interface MaterialFilterState {
  /** Last emitted spam fingerprint (gate/poll burst collapse). */
  lastBurstFp: string | null;
  /** True after first ci/waiting in the current stretch (loop_item_progress). */
  ciWaitingOpen: boolean;
  /** Last optional-kind decision fingerprint (schedule/reconcile bursts). */
  lastOptionalFp: string | null;
}

export function createMaterialFilterState(): MaterialFilterState {
  return {
    lastBurstFp: null,
    ciWaitingOpen: false,
    lastOptionalFp: null,
  };
}

/**
 * Process one events.jsonl line. Returns a notify line, or `null` to suppress.
 * Mutates `state` for spam / first-waiting rules.
 */
export function filterMaterialLine(
  line: string,
  state: MaterialFilterState = createMaterialFilterState(),
  opts: MaterialFilterOptions = {},
): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj == null || typeof obj !== "object") return null;

  // Advance events use `type`; loop events use `kind`.
  const advanceType = typeof obj.type === "string" ? obj.type : null;
  const loopKind = typeof obj.kind === "string" ? obj.kind : null;

  if (advanceType && ADVANCE_SET.has(advanceType)) {
    return filterAdvance(advanceType, obj, state, opts, trimmed);
  }
  if (loopKind && LOOP_MUST_SET.has(loopKind)) {
    return filterLoopMust(loopKind, obj, state, opts, trimmed);
  }
  if (loopKind && LOOP_OPTIONAL_SET.has(loopKind)) {
    return filterLoopOptional(loopKind, obj, state, opts, trimmed);
  }
  return null;
}

function emit(
  opts: MaterialFilterOptions,
  raw: string,
  oneLiner: string,
): string {
  return opts.jsonl ? raw : oneLiner;
}

function filterAdvance(
  type: string,
  obj: Record<string, unknown>,
  state: MaterialFilterState,
  opts: MaterialFilterOptions,
  raw: string,
): string | null {
  if (type === "gate_result") {
    const gate = typeof obj.gate === "string" ? obj.gate : "";
    const result = typeof obj.result === "string" ? obj.result : "";
    const reason = typeof obj.reason === "string" ? obj.reason : "";

    // Suppress OpenSpec skipped spam entirely (re-poll noise).
    if (/openspec/i.test(gate) && result === "skipped") {
      return null;
    }

    // CI partial = waiting-style poll; first only per identical burst fingerprint.
    if (/^ci$/i.test(gate) && result === "partial") {
      const fp = `gate|${gate}|${result}|${reason}`;
      if (state.lastBurstFp === fp) return null;
      state.lastBurstFp = fp;
      return emit(opts, raw, formatAdvanceOneLiner(type, obj));
    }

    // Definitive gate outcomes clear partial-burst state.
    state.lastBurstFp = null;
    return emit(opts, raw, formatAdvanceOneLiner(type, obj));
  }

  // stage_accounting / polling-shaped stage_complete spam is not in the allow
  // list. For allow-listed kinds, collapse exact identical consecutive bursts
  // (e.g. repeated pre_merge.advancePolling-shaped gate-adjacent noise if it
  // ever lands on an allow-listed type with the same fingerprint).
  const fp = advanceFingerprint(type, obj);
  if (fp && state.lastBurstFp === fp) return null;
  // Only sticky-fingerprint kinds that re-poll; lifecycle events always pass.
  if (type === "gate_result") {
    state.lastBurstFp = fp;
  } else {
    state.lastBurstFp = null;
  }
  // Reset CI waiting stretch when advance progresses past pre-merge wait noise.
  if (type === "stage_complete" || type === "blocker_set" || type === "run_complete") {
    state.ciWaitingOpen = false;
  }
  return emit(opts, raw, formatAdvanceOneLiner(type, obj));
}

function advanceFingerprint(type: string, obj: Record<string, unknown>): string {
  if (type === "gate_result") {
    return `gate|${obj.gate ?? ""}|${obj.result ?? ""}|${obj.reason ?? ""}`;
  }
  return `${type}|${JSON.stringify(obj)}`;
}

function filterLoopMust(
  kind: string,
  obj: Record<string, unknown>,
  state: MaterialFilterState,
  opts: MaterialFilterOptions,
  raw: string,
): string | null {
  const data =
    obj.data != null && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : {};

  if (kind === "loop_item_progress") {
    return filterLoopItemProgress(data, state, opts, raw);
  }

  // Linkage / stage progress / terminals always material.
  if (
    kind === "loop_item_advance_linked" ||
    kind === "loop_item_advance_finished" ||
    kind === "loop_item_stage_progress" ||
    kind === "loop_run_stopped" ||
    kind === "loop_item_started" ||
    kind === "loop_item_transitioned" ||
    kind === "loop_item_blocked"
  ) {
    if (kind === "loop_item_advance_finished" || kind === "loop_run_stopped") {
      state.ciWaitingOpen = false;
      state.lastBurstFp = null;
    }
    return emit(opts, raw, formatLoopOneLiner(kind, data));
  }

  return emit(opts, raw, formatLoopOneLiner(kind, data));
}

function filterLoopItemProgress(
  data: Record<string, unknown>,
  state: MaterialFilterState,
  opts: MaterialFilterOptions,
  raw: string,
): string | null {
  const domain = typeof data.domain === "string" ? data.domain : "";
  const step = typeof data.step === "string" ? data.step : "";
  const status = typeof data.status === "string" ? data.status : "";

  // OpenSpec skipped spam on progress mirror.
  if (step === "openspec_archive" && status === "skipped") {
    return null;
  }

  // First CI waiting only per stretch.
  if (
    (domain === "pre_merge" || domain === "") &&
    step === "ci" &&
    status === "waiting"
  ) {
    if (state.ciWaitingOpen) return null;
    state.ciWaitingOpen = true;
    state.lastBurstFp = null;
    return emit(opts, raw, formatLoopOneLiner("loop_item_progress", data));
  }

  // Definitive outcomes always material; close waiting stretch.
  if (DEFINITIVE_STATUS.has(status) || status === "fail" || status === "pass") {
    if (step === "ci" || status === "pass" || status === "fail" || status === "advanced" || status === "blocked") {
      state.ciWaitingOpen = false;
    }
    // Collapse identical consecutive definitive progress lines (re-mirror).
    const fp = `progress|${domain}|${step}|${status}|${JSON.stringify(data.detail ?? {})}`;
    if (state.lastBurstFp === fp) return null;
    state.lastBurstFp = fp;
    return emit(opts, raw, formatLoopOneLiner("loop_item_progress", data));
  }

  // Unknown status: drop (not material).
  return null;
}

function filterLoopOptional(
  kind: string,
  obj: Record<string, unknown>,
  state: MaterialFilterState,
  opts: MaterialFilterOptions,
  raw: string,
): string | null {
  const data =
    obj.data != null && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : {};
  // Burst-suppress identical schedule/reconcile evaluations.
  const fp = `opt|${kind}|${stableJson(data)}`;
  if (state.lastOptionalFp === fp) return null;
  state.lastOptionalFp = fp;
  return emit(opts, raw, formatLoopOneLiner(kind, data));
}

function stableJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// One-liners
// ---------------------------------------------------------------------------

export function formatAdvanceOneLiner(
  type: string,
  obj: Record<string, unknown>,
): string {
  switch (type) {
    case "run_start":
      return `[run_start] issue=#${obj.issue ?? "?"} run=${obj.run_id ?? "?"}`;
    case "stage_start":
      return `[stage_start] ${obj.stage ?? "?"}`;
    case "stage_complete":
      return `[stage_complete] ${obj.stage ?? "?"} → ${obj.outcome ?? "?"}`;
    case "pr_created":
      return `[pr_created] #${obj.pr ?? "?"}`;
    case "pr_updated":
      return `[pr_updated] #${obj.pr ?? "?"}`;
    case "review_verdict":
      return `[review_verdict] round=${obj.round ?? "?"} ${obj.verdict ?? "?"}`;
    case "gate_result":
      return `[gate_result] ${obj.gate ?? "?"}=${obj.result ?? "?"}${obj.reason ? ` (${obj.reason})` : ""}`;
    case "blocker_set":
      return `[blocker_set] ${obj.reason ?? obj.blocker_kind ?? "?"}`;
    case "blocker_cleared":
      return `[blocker_cleared]`;
    case "run_complete":
      return `[run_complete] ${obj.final_state ?? "?"}`;
    default:
      return `[${type}]`;
  }
}

export function formatLoopOneLiner(
  kind: string,
  data: Record<string, unknown>,
): string {
  const item = data.item_id != null ? ` item=${data.item_id}` : "";
  switch (kind) {
    case "loop_item_started":
      return `[loop_item_started]${item}`;
    case "loop_item_transitioned":
      return `[loop_item_transitioned]${item} ${data.from ?? "?"}→${data.to ?? "?"}`;
    case "loop_item_blocked":
      return `[loop_item_blocked]${item} ${data.reason ?? data.class ?? ""}`.trimEnd();
    case "loop_item_advance_linked":
      return `[loop_item_advance_linked]${item} run=${data.pipeline_run_id ?? "?"}`;
    case "loop_item_advance_finished":
      return `[loop_item_advance_finished]${item} ${data.outcome ?? data.result ?? "done"}`;
    case "loop_item_stage_progress":
      return `[loop_item_stage_progress]${item} ${data.stage ?? "?"}${data.round != null ? ` r${data.round}` : ""}`;
    case "loop_item_progress":
      return `[loop_item_progress]${item} ${data.domain ?? "?"}/${data.step ?? "?"} ${data.status ?? "?"}`;
    case "loop_run_stopped":
      return `[loop_run_stopped] ${data.reason ?? "stopped"}`;
    default:
      return `[${kind}]${item}`;
  }
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Filter many lines; returns emitted one-liners (or raw JSONL when opts.jsonl). */
export function filterMaterialLines(
  lines: Iterable<string>,
  opts: MaterialFilterOptions = {},
  state: MaterialFilterState = createMaterialFilterState(),
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const emitted = filterMaterialLine(line, state, opts);
    if (emitted != null) out.push(emitted);
  }
  return out;
}

/** Filter a multi-line blob (file contents / one-shot dump). */
export function filterMaterialText(
  text: string,
  opts: MaterialFilterOptions = {},
): string {
  const lines = text.split(/\r?\n/);
  // Preserve trailing newline semantics: last empty split is not a line.
  const filtered = filterMaterialLines(lines, opts);
  return filtered.length === 0 ? "" : filtered.join("\n") + "\n";
}

/**
 * Async line pump: read from an async iterable of chunks or lines and write
 * material lines via `write`. Used by CLI and optional logs --material follow.
 */
export async function pumpMaterialFilter(
  source: AsyncIterable<string> | Readable,
  write: (line: string) => void,
  opts: MaterialFilterOptions = {},
): Promise<void> {
  const state = createMaterialFilterState();
  const rl = readline.createInterface({
    input: source as Readable,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const emitted = filterMaterialLine(line, state, opts);
    if (emitted != null) write(emitted.endsWith("\n") ? emitted : emitted + "\n");
  }
}

// ---------------------------------------------------------------------------
// CLI: node --experimental-strip-types material-filter.ts [file|-] [--jsonl]
// ---------------------------------------------------------------------------

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Match both .ts source and any mirrored .mjs copy basenames.
  return /material-filter\.(ts|mjs|js)$/.test(entry.replace(/\\/g, "/"));
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  let jsonl = false;
  let file: string | undefined;
  for (const a of args) {
    if (a === "--jsonl") jsonl = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: material-filter [--jsonl] [file|-]\n" +
          "  Read advance/loop events.jsonl lines from file or stdin;\n" +
          "  print material one-liners (or JSONL with --jsonl).\n" +
          "  Observation only — does not modify the source file.\n",
      );
      return;
    } else if (!a.startsWith("-")) {
      file = a;
    }
  }

  const opts: MaterialFilterOptions = { jsonl };
  const write = (s: string) => {
    process.stdout.write(s);
  };

  if (file && file !== "-") {
    const text = fs.readFileSync(file, "utf8");
    process.stdout.write(filterMaterialText(text, opts));
    return;
  }

  await pumpMaterialFilter(process.stdin, write, opts);
}

if (isMain()) {
  main(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
