// Background-job lifecycle (#1299).
//
// Typed events, allowlisted evidence, join-grace watchdog, mutating-implementer
// preflight, and same-adapter retry bound. Transcript wording and generic
// inactivity are never proof of a background wait.

import { createHash } from "node:crypto";
import {
  BACKGROUND_JOB_LIFECYCLE_EVENT_KINDS,
  BACKGROUND_JOB_LIFECYCLE_EVIDENCE_ALLOWLIST,
  BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS,
  BACKGROUND_JOB_LIFECYCLE_SCHEMA,
  BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  isJsonRecord,
  parseJsonLine,
  type BackgroundJobLifecycleDeclaration,
  type BackgroundJobLifecycleEvent,
  type BackgroundJobLifecycleEventKind,
  type BackgroundJobLifecycleSupported,
} from "./types.ts";

export {
  BACKGROUND_JOB_LIFECYCLE_EVENT_KINDS,
  BACKGROUND_JOB_LIFECYCLE_EVIDENCE_ALLOWLIST,
  BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS,
  BACKGROUND_JOB_LIFECYCLE_SCHEMA,
  BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
};

/** Product-mutating implementer stages that require lifecycle support. */
export const MUTATING_IMPLEMENTER_STAGE_KINDS = [
  "implement",
  "fix-round",
  "test-fix",
  "eval-fix",
  "visual-fix",
] as const;
export type MutatingImplementerStageKind =
  (typeof MUTATING_IMPLEMENTER_STAGE_KINDS)[number];

const EVENT_KIND_SET: ReadonlySet<string> = new Set(BACKGROUND_JOB_LIFECYCLE_EVENT_KINDS);

const FORBIDDEN_EVIDENCE_KEY_RE =
  /^(command|cmd|args|argv|tool_output|toolOutput|prompt|secret|secrets|stdout|stderr|token|api_key|apiKey|password|authorization)$/i;

export function isMutatingImplementerStageKind(
  value: unknown,
): value is MutatingImplementerStageKind {
  return (
    typeof value === "string" &&
    (MUTATING_IMPLEMENTER_STAGE_KINDS as readonly string[]).includes(value)
  );
}

export function requiresBackgroundJobLifecycle(stageKind: unknown): boolean {
  return isMutatingImplementerStageKind(stageKind);
}

export function supportedBackgroundJobLifecycle(
  joinGraceMs?: number,
): BackgroundJobLifecycleSupported {
  return joinGraceMs === undefined
    ? { supported: true, schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA }
    : {
        supported: true,
        schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA,
        join_grace_ms: joinGraceMs,
      };
}

/** Effective join grace: min(declared, pipeline max). Missing/invalid → pipeline max. */
export function effectiveJoinGraceMs(
  decl: BackgroundJobLifecycleDeclaration | undefined | null,
): number {
  if (!decl || !decl.supported) return BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS;
  const declared = decl.join_grace_ms;
  if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) {
    return BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS;
  }
  return Math.min(Math.floor(declared), BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS);
}

/**
 * Structural coherence of a lifecycle declaration. Returns a message naming
 * the field when invalid; null when coherent.
 */
export function backgroundJobLifecycleCoherenceFailure(
  decl: unknown,
): string | null {
  if (decl === undefined || decl === null) {
    return `missing required field "background_job_lifecycle"`;
  }
  if (typeof decl !== "object" || Array.isArray(decl)) {
    return `background_job_lifecycle must be an object (got ${JSON.stringify(decl)})`;
  }
  const rec = decl as Record<string, unknown>;
  if (rec.supported === false) {
    return null;
  }
  if (rec.supported !== true) {
    return `background_job_lifecycle.supported must be true or false`;
  }
  if (rec.schema !== BACKGROUND_JOB_LIFECYCLE_SCHEMA) {
    return (
      `background_job_lifecycle claims support without schema ` +
      `${BACKGROUND_JOB_LIFECYCLE_SCHEMA} (got ${JSON.stringify(rec.schema)})`
    );
  }
  if (rec.join_grace_ms !== undefined) {
    const grace = rec.join_grace_ms;
    if (typeof grace !== "number" || !Number.isInteger(grace) || grace <= 0) {
      return `background_job_lifecycle.join_grace_ms must be a positive integer`;
    }
    if (grace > BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS) {
      return (
        `incoherent join grace: background_job_lifecycle.join_grace_ms ${grace} ` +
        `exceeds pipeline maximum ${BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS}`
      );
    }
  }
  return null;
}

export function lifecycleDeclarationsMatch(
  caps: BackgroundJobLifecycleDeclaration | undefined,
  decl: BackgroundJobLifecycleDeclaration | undefined,
): boolean {
  return JSON.stringify(caps ?? null) === JSON.stringify(decl ?? null);
}

const FORBIDDEN_EVIDENCE_SUBSTRINGS = ["command", "tool output", "prompt", "secret"];

export interface RedactedLifecycleEvent {
  ok: true;
  event: BackgroundJobLifecycleEvent;
}

export interface RejectedLifecycleEvent {
  ok: false;
  reason: "malformed" | "forbidden-fields";
}

export type ParsedLifecycleEvent = RedactedLifecycleEvent | RejectedLifecycleEvent;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Strip to the allowlist. Reject when required fields are missing or forbidden keys leak. */
export function redactLifecycleEvent(raw: unknown): ParsedLifecycleEvent {
  if (!isJsonRecord(raw)) return { ok: false, reason: "malformed" };
  const forbidden = Object.keys(raw).filter((k) => FORBIDDEN_EVIDENCE_KEY_RE.test(k));
  if (forbidden.length > 0) {
    return { ok: false, reason: "forbidden-fields" };
  }
  if (
    raw.schema !== BACKGROUND_JOB_LIFECYCLE_SCHEMA ||
    !EVENT_KIND_SET.has(raw.kind as string) ||
    !isNonEmptyString(raw.adapter) ||
    !isNonEmptyString(raw.invocation_id) ||
    !isNonEmptyString(raw.job_id) ||
    !isIsoTimestamp(raw.timestamp) ||
    !isNonEmptyString(raw.state)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const event: BackgroundJobLifecycleEvent = {
    schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA,
    kind: raw.kind as BackgroundJobLifecycleEventKind,
    adapter: raw.adapter,
    invocation_id: raw.invocation_id,
    job_id: raw.job_id,
    timestamp: raw.timestamp,
    state: raw.state,
  };
  return { ok: true, event };
}

export function lifecycleEvidenceContainsForbiddenText(value: unknown): boolean {
  const blob = JSON.stringify(value ?? "").toLowerCase();
  return FORBIDDEN_EVIDENCE_SUBSTRINGS.some((s) => blob.includes(s));
}

/** Persistable allowlisted evidence for one outstanding job. */
export interface BackgroundJobLifecycleEvidence {
  adapter: string;
  invocation_id: string;
  job_id: string;
  timestamps: string[];
  state: string;
}

export function allowlistedLifecycleEvidence(
  event: BackgroundJobLifecycleEvent,
  extraTimestamps: string[] = [],
): BackgroundJobLifecycleEvidence {
  const timestamps = [event.timestamp, ...extraTimestamps].filter(
    (t, i, arr) => arr.indexOf(t) === i,
  );
  return {
    adapter: event.adapter,
    invocation_id: event.invocation_id,
    job_id: event.job_id,
    timestamps,
    state: event.state,
  };
}

export function parseLifecycleJsonl(
  chunk: string,
  defaults: { adapter: string; invocationId: string },
): BackgroundJobLifecycleEvent[] {
  const events: BackgroundJobLifecycleEvent[] = [];
  for (const line of chunk.split("\n")) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (obj.schema !== BACKGROUND_JOB_LIFECYCLE_SCHEMA && obj.type !== BACKGROUND_JOB_LIFECYCLE_SCHEMA) {
      continue;
    }
    const candidate = {
      schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA,
      kind: obj.kind,
      adapter: obj.adapter ?? defaults.adapter,
      invocation_id: obj.invocation_id ?? defaults.invocationId,
      job_id: obj.job_id,
      timestamp: obj.timestamp,
      state: obj.state,
    };
    const parsed = redactLifecycleEvent(candidate);
    if (parsed.ok) events.push(parsed.event);
  }
  return events;
}

interface JobRecord {
  job_id: string;
  adapter: string;
  invocation_id: string;
  started: boolean;
  terminal: "completed" | "failed" | null;
  delivered: boolean;
  joined: boolean;
  conflicting: boolean;
  timestamps: string[];
  state: string;
  terminalAtMs: number | null;
}

function emptyJob(jobId: string, adapter: string, invocationId: string): JobRecord {
  return {
    job_id: jobId,
    adapter,
    invocation_id: invocationId,
    started: false,
    terminal: null,
    delivered: false,
    joined: false,
    conflicting: false,
    timestamps: [],
    state: "unknown",
    terminalAtMs: null,
  };
}

export type LifecycleWatchdogOutcome =
  | { kind: "continue" }
  | { kind: "joined" }
  | {
      kind: "background_wait";
      evidence: BackgroundJobLifecycleEvidence;
    }
  | { kind: "outer_timeout" };

export interface LifecycleSupervisorSnapshot {
  jobs: ReadonlyArray<{
    job_id: string;
    started: boolean;
    terminal: JobRecord["terminal"];
    delivered: boolean;
    joined: boolean;
    conflicting: boolean;
  }>;
}

/**
 * Incremental join-grace supervisor. Pure: callers inject nowMs.
 * Identical duplicate events are idempotent. Conflicting state is not a join.
 */
export class BackgroundJobLifecycleSupervisor {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly seenFingerprints = new Set<string>();
  private backgroundWait: BackgroundJobLifecycleEvidence | null = null;
  private readonly opts: {
    joinGraceMs: number;
    outerDeadlineMs: number;
    nowMs: () => number;
    startedAtMs?: number;
  };

  constructor(opts: {
    joinGraceMs: number;
    outerDeadlineMs: number;
    nowMs: () => number;
    startedAtMs?: number;
  }) {
    this.opts = opts;
  }

  snapshot(): LifecycleSupervisorSnapshot {
    return {
      jobs: [...this.jobs.values()].map((j) => ({
        job_id: j.job_id,
        started: j.started,
        terminal: j.terminal,
        delivered: j.delivered,
        joined: j.joined,
        conflicting: j.conflicting,
      })),
    };
  }

  feed(raw: unknown): ParsedLifecycleEvent {
    const parsed = redactLifecycleEvent(raw);
    if (!parsed.ok) return parsed;
    const event = parsed.event;
    const fp = `${event.job_id}|${event.kind}|${event.state}|${event.timestamp}`;
    if (this.seenFingerprints.has(fp)) {
      return parsed;
    }
    this.seenFingerprints.add(fp);
    const nowMs = this.opts.nowMs();
    let job = this.jobs.get(event.job_id);
    if (!job) {
      job = emptyJob(event.job_id, event.adapter, event.invocation_id);
      this.jobs.set(event.job_id, job);
    }
    job.timestamps.push(event.timestamp);
    job.state = event.state;
    switch (event.kind) {
      case "job_started":
        job.started = true;
        break;
      case "job_completed":
        if (job.terminal === "failed") job.conflicting = true;
        else if (job.terminal === null) {
          job.terminal = "completed";
          job.terminalAtMs = nowMs;
        }
        break;
      case "job_failed":
        if (job.terminal === "completed") job.conflicting = true;
        else if (job.terminal === null) {
          job.terminal = "failed";
          job.terminalAtMs = nowMs;
        }
        break;
      case "notification_delivered":
        job.delivered = true;
        break;
      case "foreground_joined":
        job.joined = true;
        break;
    }
    return parsed;
  }

  evaluate(): LifecycleWatchdogOutcome {
    if (this.backgroundWait) {
      return { kind: "background_wait", evidence: this.backgroundWait };
    }
    const nowMs = this.opts.nowMs();
    const startedAt = this.opts.startedAtMs ?? 0;
    for (const job of this.jobs.values()) {
      if (job.conflicting) continue;
      if (job.terminal && job.terminalAtMs != null) {
        const joined = job.delivered && job.joined;
        if (!joined && nowMs - job.terminalAtMs >= this.opts.joinGraceMs) {
          this.backgroundWait = {
            adapter: job.adapter,
            invocation_id: job.invocation_id,
            job_id: job.job_id,
            timestamps: job.timestamps.slice(),
            state: job.state,
          };
          return { kind: "background_wait", evidence: this.backgroundWait };
        }
      }
    }
    if (nowMs - startedAt >= this.opts.outerDeadlineMs) {
      const outstandingRunning = [...this.jobs.values()].some(
        (j) => j.started && j.terminal === null,
      );
      if (outstandingRunning) return { kind: "outer_timeout" };
      return { kind: "outer_timeout" };
    }
    const jobs = [...this.jobs.values()];
    if (
      jobs.length > 0 &&
      jobs.every((j) => j.terminal && j.delivered && j.joined && !j.conflicting)
    ) {
      return { kind: "joined" };
    }
    return { kind: "continue" };
  }
}

export interface InjectedLifecycleEvent {
  atMs: number;
  event: unknown;
}

export interface RunInjectedLifecycleInput {
  events: InjectedLifecycleEvent[];
  joinGraceMs: number;
  outerDeadlineMs: number;
  adapter: string;
  invocationId: string;
  /** Optional waiting-prose transcript — never used as classifier proof. */
  transcript?: string;
}

export interface InjectedLifecycleResult {
  background_wait: boolean;
  timed_out: boolean;
  evidence: BackgroundJobLifecycleEvidence | null;
  durationMs: number;
  outcome: LifecycleWatchdogOutcome["kind"];
}

/**
 * Drive the supervisor over an injected event stream with a fake clock.
 * No subprocess. Completes as soon as join grace or the outer cap fires.
 */
export function runInjectedLifecycleSupervisor(
  input: RunInjectedLifecycleInput,
): InjectedLifecycleResult {
  let nowMs = 0;
  const supervisor = new BackgroundJobLifecycleSupervisor({
    joinGraceMs: input.joinGraceMs,
    outerDeadlineMs: input.outerDeadlineMs,
    nowMs: () => nowMs,
    startedAtMs: 0,
  });
  const sorted = [...input.events].sort((a, b) => a.atMs - b.atMs);
  const ticks = new Set<number>([0, input.outerDeadlineMs]);
  for (const item of sorted) ticks.add(item.atMs);
  for (const item of sorted) {
    if (item.event && typeof item.event === "object") {
      const rec = item.event as Record<string, unknown>;
      if (rec.kind === "job_completed" || rec.kind === "job_failed") {
        ticks.add(item.atMs + input.joinGraceMs);
      }
    }
  }
  const timeline = [...ticks].sort((a, b) => a - b);
  let eventIdx = 0;
  for (const t of timeline) {
    nowMs = t;
    while (eventIdx < sorted.length && sorted[eventIdx].atMs <= t) {
      supervisor.feed(sorted[eventIdx].event);
      eventIdx += 1;
    }
    const outcome = supervisor.evaluate();
    if (outcome.kind === "background_wait") {
      return {
        background_wait: true,
        timed_out: false,
        evidence: outcome.evidence,
        durationMs: nowMs,
        outcome: "background_wait",
      };
    }
    if (outcome.kind === "outer_timeout") {
      return {
        background_wait: false,
        timed_out: true,
        evidence: null,
        durationMs: nowMs,
        outcome: "outer_timeout",
      };
    }
    if (outcome.kind === "joined") {
      return {
        background_wait: false,
        timed_out: false,
        evidence: null,
        durationMs: nowMs,
        outcome: "joined",
      };
    }
  }
  nowMs = input.outerDeadlineMs;
  const finalOutcome = supervisor.evaluate();
  if (finalOutcome.kind === "background_wait") {
    return {
      background_wait: true,
      timed_out: false,
      evidence: finalOutcome.evidence,
      durationMs: nowMs,
      outcome: "background_wait",
    };
  }
  return {
    background_wait: false,
    timed_out: true,
    evidence: null,
    durationMs: nowMs,
    outcome: "outer_timeout",
  };
}

export interface InvocationFingerprintInput {
  adapter: string;
  stageKind?: string | null;
  model?: string | null;
  effort?: string | null;
  promptHash?: string | null;
}

export function hashPromptForFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

export function harnessInvocationFingerprint(input: InvocationFingerprintInput): string {
  const payload = {
    adapter: input.adapter,
    stageKind: input.stageKind ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    promptHash: input.promptHash ?? null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export interface PreviousLifecycleInvocation {
  adapter: string;
  fingerprint: string;
  reason: string;
}

export function sameAdapterRetryForbidden(opts: {
  adapter: string;
  fingerprint: string;
  previous?: PreviousLifecycleInvocation | null;
}): boolean {
  return (
    opts.previous?.reason === "harness-background-wait" &&
    opts.previous.adapter === opts.adapter &&
    opts.previous.fingerprint === opts.fingerprint
  );
}

/** Recipes that re-invoke the same adapter or publish salvaged work. */
export const HARNESS_BACKGROUND_WAIT_FORBIDDEN_RECIPES = [
  "repair_pipeline_item",
  "publish_unpublished_stage_commit",
] as const;

export function filterRecipesForHarnessBackgroundWait<T extends string>(
  recipes: readonly T[],
): T[] {
  const forbidden = new Set<string>(HARNESS_BACKGROUND_WAIT_FORBIDDEN_RECIPES);
  return recipes.filter((r) => !forbidden.has(r));
}

export function capabilityRefusalMessage(adapterName: string): string {
  return (
    `[harness ${adapterName}] adapter omits background_job_lifecycle. ` +
    `Mutating implementation work (implement, fix-round, test-fix, eval-fix, visual-fix) ` +
    `requires an explicit declaration. This is a typed capability-refusal, not a transient spawn error — ` +
    `retrying the same invocation cannot succeed without changing the adapter or the declaration.`
  );
}

/** Bounded malformed-declaration refusal; `coherenceFailure` already names the field. */
export function malformedLifecycleRefusalMessage(
  adapterName: string,
  coherenceFailure: string,
): string {
  return (
    `[harness ${adapterName}] adapter declares a malformed background_job_lifecycle: ${coherenceFailure}. ` +
    `This is a typed capability-refusal, not a transient spawn error — ` +
    `retrying the same invocation cannot succeed without changing the adapter or the declaration.`
  );
}

/** Recipes that mutate a worktree or invent a session after a never-started harness. */
export const NEVER_STARTED_PREFLIGHT_FORBIDDEN_RECIPES = [
  "unlink_engine_scratch",
  "checkpoint_owned_harness_dirt",
  "publish_unpublished_stage_commit",
] as const;

export function filterRecipesForNeverStartedPreflight<T extends string>(
  recipes: readonly T[],
): T[] {
  const forbidden = new Set<string>(NEVER_STARTED_PREFLIGHT_FORBIDDEN_RECIPES);
  return recipes.filter((r) => !forbidden.has(r));
}

/**
 * Historical / incident protocol fixture shape. Transcript mentions of a
 * background test run must not flip support.
 */
export interface BackgroundJobProtocolFixture {
  adapter: string;
  provenance: string;
  raw_protocol: string;
  observed_event_types: string[];
  transcript_excerpt?: string;
  proves_job_identity: boolean;
  proves_start: boolean;
  proves_complete_or_fail: boolean;
  proves_notification_delivery: boolean;
  proves_foreground_join: boolean;
  background_job_lifecycle: BackgroundJobLifecycleDeclaration;
}

export function protocolProvesBackgroundJobLifecycle(
  fixture: BackgroundJobProtocolFixture,
): boolean {
  return (
    fixture.proves_job_identity &&
    fixture.proves_start &&
    fixture.proves_complete_or_fail &&
    fixture.proves_notification_delivery &&
    fixture.proves_foreground_join
  );
}

export function protocolFixtureSupportIsHonest(
  fixture: BackgroundJobProtocolFixture,
): boolean {
  const canProve = protocolProvesBackgroundJobLifecycle(fixture);
  if (canProve) return fixture.background_job_lifecycle.supported === true;
  return fixture.background_job_lifecycle.supported === false;
}

export function backgroundWaitBlockReason(opts: {
  adapter: string;
  jobId?: string;
  salvageFailureReason?: string;
  salvaged?: boolean;
}): string {
  const jobBit = opts.jobId ? ` job ${opts.jobId}` : " a background job";
  const salvageBit = opts.salvageFailureReason
    ? ` Salvage of uncommitted work also failed: ${opts.salvageFailureReason}`
    : opts.salvaged
      ? " Uncommitted work was salvaged; the stage outcome remains harness-background-wait."
      : "";
  return (
    `Implementation harness (${opts.adapter}) missed delivery or foreground-join for` +
    `${jobBit} after typed complete/fail (harness-background-wait).${salvageBit}`
  );
}
