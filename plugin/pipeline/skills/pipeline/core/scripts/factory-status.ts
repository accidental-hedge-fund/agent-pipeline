// Factory aggregate status (#891) — pure, versioned, allowlisted read model.
//
// `assembleFactoryStatus` maps injected controller/service, loop, process,
// pin, provider, write-health, and cost sources into a remote-safe envelope.
// No GitHub, git, ledger, lock, service, or run-artifact mutation.
//
// Health represents process liveness, durable progress, and expected waiting
// as independent dimensions. Coarse classification follows strict stuck/dead
// rules; missing telemetry stays unknown.

// ---------------------------------------------------------------------------
// Schema / public envelope
// ---------------------------------------------------------------------------

export const FACTORY_STATUS_SCHEMA_VERSION = "1" as const;

export type FactoryStatusTopLevel = "ok" | "degraded" | "error";

/** Coarse operator-facing controller health class. */
export type FactoryCoarseHealth =
  | "healthy"
  | "waiting"
  | "suspected_stuck"
  | "dead"
  | "unknown";

export type Attribution = "present" | "unknown" | "legacy" | "not_applicable" | "error";

export type CostCoverageKind = "actual" | "estimated" | "unknown";

export type ExpectedWaitKind =
  | "ci"
  | "provider_cooldown"
  | "recovery_backoff"
  | "dependency"
  | "capacity"
  | "human"
  | "dispatch"
  | "unknown";

export type ProcessLivenessState =
  | "live"
  | "stale"
  | "dead"
  | "unknown"
  | "write_failed";

export type DurableProgressState = "recent" | "idle" | "unknown";

export type ExpectedWaitingState = "waiting" | "none" | "unknown";

export interface FactoryStatusHealthDimensions {
  process_liveness: {
    state: ProcessLivenessState;
    heartbeat_at: string | null;
    attribution: Attribution;
    detail: string | null;
  };
  durable_progress: {
    state: DurableProgressState;
    last_progress_at: string | null;
    attribution: Attribution;
  };
  expected_waiting: {
    state: ExpectedWaitingState;
    kind: ExpectedWaitKind | null;
    deadline: string | null;
    attribution: Attribution;
  };
  coarse: FactoryCoarseHealth;
}

export interface FactoryStatusItemRow {
  item_id: string;
  state: string;
  stage: string | null;
  advance_run_id: string | null;
  pr: number | null;
  candidate: string | null;
}

export interface FactoryStatusEnvelope {
  schema_version: typeof FACTORY_STATUS_SCHEMA_VERSION;
  status: FactoryStatusTopLevel;
  generated_at: string;
  health: FactoryStatusHealthDimensions;
  controller: {
    kind: "macro" | "loop_supervisor" | "unknown";
    service_controller: string | null;
    mode: string | null;
    revision: number | null;
    hostname: string | null;
    pid: number | null;
    attribution: Attribution;
  };
  run: {
    factory_run_id: string | null;
    loop_run_id: string | null;
    contract_hash: string | null;
    coarse_phase: string | null;
    engine: string | null;
    treatment_fingerprint: string | null;
    authority_fingerprint: string | null;
    engine_pin: string | null;
    attribution: Attribution;
  };
  items: {
    active_count: number;
    queued_count: number;
    held_count: number;
    rows: FactoryStatusItemRow[];
    attribution: Attribution;
  };
  operation: {
    id: string | null;
    started_at: string | null;
    deadline: string | null;
    attribution: Attribution;
  };
  next_action: {
    code: string | null;
    attribution: Attribution;
  };
  lock_liveness: {
    holder_present: boolean | null;
    host_class: "same_host" | "cross_host" | "none" | "unknown";
    staleness: string | null;
    attribution: Attribution;
  };
  provider: {
    cooldown: boolean | null;
    cooldown_until: string | null;
    attribution: Attribution;
  };
  write_health: {
    elevated: boolean | null;
    summary: string | null;
    attribution: Attribution;
  };
  cost: {
    coverage: CostCoverageKind;
    actual_usd: number | null;
    estimated_usd: number | null;
    attribution: Attribution;
  };
  sources: Record<string, Attribution>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Explicit public field allowlist (remote-safe contract)
// ---------------------------------------------------------------------------

/** Top-level keys permitted on the public envelope. Nested objects are built
 *  only from named fields in {@link assembleFactoryStatus}; free-form dumps
 *  of source objects are never attached. */
export const FACTORY_STATUS_PUBLIC_TOP_LEVEL_KEYS = [
  "schema_version",
  "status",
  "generated_at",
  "health",
  "controller",
  "run",
  "items",
  "operation",
  "next_action",
  "lock_liveness",
  "provider",
  "write_health",
  "cost",
  "sources",
  "error",
] as const;

// ---------------------------------------------------------------------------
// Injected source shapes (tests seed canaries into every registered key)
// ---------------------------------------------------------------------------

/** Registered source object keys for the canary suite. Adding a source without
 *  covering it in canary fixtures fails the guard test. */
export const FACTORY_STATUS_SOURCE_KEYS = [
  "macroController",
  "loopStatus",
  "processIdentity",
  "lockSummary",
  "pin",
  "provider",
  "writeHealth",
  "cost",
  "actionEvidenceTail",
] as const;

export type FactoryStatusSourceKey = (typeof FACTORY_STATUS_SOURCE_KEYS)[number];

/** Optional #890-shaped macro-controller projection (narrow interface). */
export interface FactoryMacroControllerSource {
  factory_run_id?: string | null;
  revision?: number | null;
  canonical_hash?: string | null;
  coarse_phase?: string | null;
  next_action?: string | null;
  service_controller?: string | null;
  mode?: string | null;
  identities?: {
    service_controller?: string | null;
    outer_host?: string | null;
    implementer_treatment?: string | null;
    reviewer_treatment?: string | null;
    privileged_mutation_actor?: string | null;
  } | null;
  fingerprints?: {
    authority_policy?: string | null;
    engine_pin?: string | null;
    configuration?: string | null;
    treatment?: string | null;
  } | null;
  linked_runs?: {
    loop_run_id?: string | null;
    loop_contract_hash?: string | null;
    advance_run_id?: string | null;
  } | null;
  /** Forbidden when assembled — canary/secret fields that must never leak. */
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryLoopStatusSource {
  run_id?: string | null;
  engine?: string | null;
  canonical_hash?: string | null;
  items?: Record<
    string,
    {
      state?: string;
      current_stage?: string;
      advance_run_id?: string;
      pr?: number | null;
      candidate?: string | null;
      /** Free text that must never pass through. */
      title?: string;
      hold_reason?: string;
      comment?: string;
    }
  > | null;
  active_items?: string[] | null;
  stop?: { reason?: string; time?: string } | null;
  consecutive_no_progress?: number | null;
  event_count?: number | null;
  // Forbidden
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryProcessIdentitySource {
  run_id?: string | null;
  engine?: string | null;
  pid?: number | null;
  hostname?: string | null;
  boot_id?: string | null;
  started_at?: string | null;
  heartbeat_at?: string | null;
  consecutive_no_progress?: number | null;
  current_operation?: string | null;
  operation_started_at?: string | null;
  operation_deadline?: string | null;
  expected_wait_kind?: string | null;
  expected_wait_deadline?: string | null;
  last_durable_progress_at?: string | null;
  heartbeat_write_error?: string | null;
  // Forbidden
  token?: string | null;
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryLockSummarySource {
  holder_present?: boolean | null;
  hostname?: string | null;
  pid?: number | null;
  engine?: string | null;
  staleness?: string | null;
  // Forbidden
  token?: string | null;
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryPinSource {
  version?: string | null;
  tag?: string | null;
  track?: string | null;
  // Forbidden
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryProviderSource {
  cooldown?: boolean | null;
  cooldown_until?: string | null;
  // Forbidden — never invent remaining quota %
  remaining_quota_percent?: number | null;
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryWriteHealthSource {
  elevated?: boolean | null;
  summary_code?: string | null;
  // Forbidden free text
  detail?: string | null;
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryCostSource {
  coverage?: CostCoverageKind | null;
  actual_usd?: number | null;
  estimated_usd?: number | null;
  // Forbidden
  remaining_quota_percent?: number | null;
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryActionEvidenceTailSource {
  last_progress_at?: string | null;
  last_action?: string | null;
  // Forbidden
  next_action_prose?: string | null;
  outcome_text?: string | null;
  lock_token?: string | null;
  bearer_token?: string | null;
  credentials?: string | null;
  secret_ref?: string | null;
  env?: Record<string, string> | null;
  prompt?: string | null;
  tool_output?: string | null;
  reason?: string | null;
  issue_title?: string | null;
  comment_body?: string | null;
  hold_reason?: string | null;
  [extra: string]: unknown;
}

export interface FactoryStatusSources {
  macroController?: FactoryMacroControllerSource | null | { __error: string };
  loopStatus?: FactoryLoopStatusSource | null | { __error: string };
  processIdentity?: FactoryProcessIdentitySource | null | { __error: string };
  lockSummary?: FactoryLockSummarySource | null | { __error: string };
  pin?: FactoryPinSource | null | { __error: string };
  provider?: FactoryProviderSource | null | { __error: string };
  writeHealth?: FactoryWriteHealthSource | null | { __error: string };
  cost?: FactoryCostSource | null | { __error: string };
  actionEvidenceTail?: FactoryActionEvidenceTailSource | null | { __error: string };
}

export interface FactoryStatusProbes {
  /** Local hostname for same-host classification. */
  localHostname(): string;
  /** Whether a same-host pid is alive. Only called when hostname matches. */
  isPidAlive?(pid: number): boolean | Promise<boolean>;
}

export interface FactoryStatusClock {
  now(): Date;
}

/** Default liveness bound: heartbeat older than this is stale (ms). */
export const DEFAULT_LIVENESS_BOUND_MS = 90_000;

/** Default independent heartbeat cadence (ms). Injectable in tests. */
export const DEFAULT_INDEPENDENT_HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const ALLOWED_NEXT_ACTION_CODES = new Set([
  "await_adoption",
  "start_loop",
  "resume_loop",
  "observe_loop",
  "start_advance",
  "resume_advance",
  "observe_advance",
  "operator_merge",
  "operator_release",
  "observe_engine_pin",
  "replan_required",
  "factory_idle",
  "none",
  "dispatch_item",
  "reconcile",
  "start_item",
  "block_item",
  "abandon_item",
  "resume",
  "stop",
  "noop",
  "exclude_item",
  "wait_ci",
  "wait_provider",
  "wait_backoff",
  "wait_dependency",
  "wait_capacity",
  "wait_human",
  "unknown",
]);

const ALLOWED_WAIT_KINDS = new Set<ExpectedWaitKind>([
  "ci",
  "provider_cooldown",
  "recovery_backoff",
  "dependency",
  "capacity",
  "human",
  "dispatch",
  "unknown",
]);

const ALLOWED_ITEM_STATES = new Set([
  "pending",
  "ready",
  "in_progress",
  "blocked",
  "paused",
  "waiting",
  "done",
  "abandoned",
  "excluded",
  "unknown",
]);

/** Coarse-code a free-text next action; never pass raw prose through. */
export function sanitizeNextActionCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const trimmed = raw.trim();
  if (ALLOWED_NEXT_ACTION_CODES.has(trimmed)) return trimmed;
  // Map common free-text patterns to coarse codes without carrying payload.
  const lower = trimmed.toLowerCase();
  if (lower.includes("human") || lower.includes("operator")) return "wait_human";
  if (lower.includes("ci")) return "wait_ci";
  if (lower.includes("cooldown") || lower.includes("rate limit")) return "wait_provider";
  if (lower.includes("backoff") || lower.includes("retry")) return "wait_backoff";
  if (lower.includes("depend")) return "wait_dependency";
  if (lower.includes("capacity") || lower.includes("concurren")) return "wait_capacity";
  if (lower.includes("dispatch")) return "dispatch_item";
  if (lower.includes("merge")) return "operator_merge";
  if (lower.includes("release")) return "operator_release";
  if (lower.includes("stop")) return "stop";
  if (lower.includes("idle") || lower.includes("none")) return "none";
  return "unknown";
}

export function sanitizeWaitKind(raw: unknown): ExpectedWaitKind | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (ALLOWED_WAIT_KINDS.has(raw as ExpectedWaitKind)) return raw as ExpectedWaitKind;
  return "unknown";
}

function sanitizeItemState(raw: unknown): string {
  if (typeof raw === "string" && ALLOWED_ITEM_STATES.has(raw)) return raw;
  if (typeof raw === "string" && /^[a-z][a-z0-9_-]{0,40}$/i.test(raw)) return "unknown";
  return "unknown";
}

function sanitizeStage(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Pipeline stages are short tokens; refuse free text.
  if (/^[a-z][a-z0-9_-]{0,40}$/i.test(raw)) return raw;
  return null;
}

function isErrorSource(v: unknown): v is { __error: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "__error" in v &&
    typeof (v as { __error: unknown }).__error === "string"
  );
}

/** Strip anything that looks like a secret/canary/prompt from error messages. */
export function sanitizeErrorMessage(msg: unknown): string {
  if (typeof msg !== "string" || msg.length === 0) return "status_assembly_failed";
  // Drop secret-looking tokens and instruction-like free text.
  let s = msg.replace(/CANARY_SECRET_\w+/g, "[redacted]");
  s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  s = s.replace(/secret:\/\/\S+/gi, "[redacted]");
  // Instruction-like payloads must never ride through error strings.
  s = s.replace(/ignore\s+previous\s+instructions[\s\S]{0,200}/gi, "[redacted]");
  s = s.replace(/exfiltrate\s+\w+/gi, "[redacted]");
  // Cap length so residual free text cannot carry full prompts.
  if (s.length > 120) s = s.slice(0, 120) + "…";
  return s;
}

// ---------------------------------------------------------------------------
// Health classification (pure)
// ---------------------------------------------------------------------------

export interface HealthClassificationInput {
  nowMs: number;
  livenessBoundMs?: number;
  heartbeatAt: string | null | undefined;
  heartbeatWriteError?: string | null;
  processHostname?: string | null;
  processPid?: number | null;
  localHostname: string;
  pidAlive?: boolean | null; // null = insufficient evidence
  lastDurableProgressAt?: string | null;
  operationId?: string | null;
  operationStartedAt?: string | null;
  operationDeadline?: string | null;
  expectedWaitKind?: ExpectedWaitKind | null;
  expectedWaitDeadline?: string | null;
  controllerTerminal?: boolean;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function classifyFactoryHealth(input: HealthClassificationInput): FactoryStatusHealthDimensions {
  const bound = input.livenessBoundMs ?? DEFAULT_LIVENESS_BOUND_MS;
  const heartbeatMs = parseIsoMs(input.heartbeatAt);
  const progressMs = parseIsoMs(input.lastDurableProgressAt);
  const opDeadlineMs = parseIsoMs(input.operationDeadline);
  const waitDeadlineMs = parseIsoMs(input.expectedWaitDeadline);
  const opStartedMs = parseIsoMs(input.operationStartedAt);

  // --- process liveness dimension ---
  let livenessState: ProcessLivenessState = "unknown";
  let livenessDetail: string | null = null;
  let livenessAttr: Attribution = "unknown";

  if (input.heartbeatWriteError) {
    livenessState = "write_failed";
    livenessDetail = "heartbeat_persistence_failed";
    livenessAttr = "present";
  } else if (heartbeatMs == null) {
    livenessState = "unknown";
    livenessAttr = "legacy";
  } else {
    livenessAttr = "present";
    const age = input.nowMs - heartbeatMs;
    if (age <= bound) {
      livenessState = "live";
    } else {
      livenessState = "stale";
    }
  }

  // Same-host dead proof can upgrade stale → dead for process_liveness.state.
  const hostMatches =
    typeof input.processHostname === "string" &&
    input.processHostname.length > 0 &&
    input.processHostname === input.localHostname;
  const hostCross =
    typeof input.processHostname === "string" &&
    input.processHostname.length > 0 &&
    input.processHostname !== input.localHostname;

  if (livenessState === "stale" && hostMatches && input.pidAlive === false) {
    livenessState = "dead";
    livenessDetail = "same_host_pid_absent";
  }

  // --- durable progress ---
  let progressState: DurableProgressState = "unknown";
  let progressAttr: Attribution = "unknown";
  if (progressMs != null) {
    progressAttr = "present";
    // "Recent" = within 2× liveness bound of now (coarse; not stuck signal alone).
    progressState = input.nowMs - progressMs <= bound * 2 ? "recent" : "idle";
  } else {
    progressAttr = "legacy";
    progressState = "unknown";
  }

  // --- expected waiting ---
  let waitState: ExpectedWaitingState = "none";
  let waitAttr: Attribution = "unknown";
  let waitKind: ExpectedWaitKind | null = input.expectedWaitKind ?? null;
  const waitDeadline = input.expectedWaitDeadline ?? null;

  if (waitKind != null || waitDeadlineMs != null) {
    waitAttr = "present";
    if (waitDeadlineMs != null && input.nowMs < waitDeadlineMs) {
      waitState = "waiting";
    } else if (waitDeadlineMs != null && input.nowMs >= waitDeadlineMs) {
      waitState = "none"; // deadline passed — not "waiting" anymore
    } else if (waitKind != null) {
      waitState = "waiting";
    }
  } else {
    waitAttr = "legacy";
    waitState = "none";
    waitKind = null;
  }

  // --- coarse classification ---
  let coarse: FactoryCoarseHealth = "unknown";

  if (input.controllerTerminal && livenessState !== "live") {
    coarse = livenessState === "dead" ? "dead" : "unknown";
  } else if (livenessState === "write_failed") {
    coarse = "unknown";
  } else if (livenessState === "dead") {
    coarse = "dead";
  } else if (livenessState === "stale") {
    if (hostCross) {
      coarse = "unknown";
    } else if (hostMatches && input.pidAlive === false) {
      coarse = "dead";
    } else {
      // Insufficient same-host absence proof.
      coarse = "unknown";
    }
  } else if (livenessState === "live") {
    // Healthy waiting: expected wait before deadline.
    const waitingHealthy =
      waitState === "waiting" &&
      waitDeadlineMs != null &&
      input.nowMs < waitDeadlineMs;

    // suspected_stuck: live + explicitly started operation past deadline + no durable progress since start
    const opExplicit =
      typeof input.operationId === "string" &&
      input.operationId.length > 0 &&
      opDeadlineMs != null &&
      opStartedMs != null;
    const opOverdue = opExplicit && input.nowMs > opDeadlineMs!;
    const noProgressSinceOp =
      opExplicit &&
      (progressMs == null || progressMs < opStartedMs!);

    if (opOverdue && noProgressSinceOp && !waitingHealthy) {
      coarse = "suspected_stuck";
    } else if (waitingHealthy) {
      coarse = "waiting";
    } else {
      coarse = "healthy";
    }
  } else {
    coarse = "unknown";
  }

  return {
    process_liveness: {
      state: livenessState,
      heartbeat_at: input.heartbeatAt ?? null,
      attribution: livenessAttr,
      detail: livenessDetail,
    },
    durable_progress: {
      state: progressState,
      last_progress_at: input.lastDurableProgressAt ?? null,
      attribution: progressAttr,
    },
    expected_waiting: {
      state: waitState,
      kind: waitKind,
      deadline: waitDeadline,
      attribution: waitAttr,
    },
    coarse,
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function emptyHealth(generatedAttribution: Attribution = "unknown"): FactoryStatusHealthDimensions {
  return {
    process_liveness: {
      state: "unknown",
      heartbeat_at: null,
      attribution: generatedAttribution,
      detail: null,
    },
    durable_progress: {
      state: "unknown",
      last_progress_at: null,
      attribution: generatedAttribution,
    },
    expected_waiting: {
      state: "none",
      kind: null,
      deadline: null,
      attribution: generatedAttribution,
    },
    coarse: "unknown",
  };
}

function sourceAttribution(v: unknown): Attribution {
  if (v === undefined) return "not_applicable";
  if (v === null) return "unknown";
  if (isErrorSource(v)) return "error";
  return "present";
}

function asPresentSource<T>(v: T | null | undefined | { __error: string }): T | null {
  if (v == null || isErrorSource(v)) return null;
  return v;
}

export interface AssembleFactoryStatusOptions {
  sources: FactoryStatusSources;
  clock: FactoryStatusClock;
  probes: FactoryStatusProbes;
  livenessBoundMs?: number;
  /** When true, force top-level error even if some sources loaded. */
  forceError?: string;
}

/**
 * Pure assembler: maps injected sources into the allowlisted envelope.
 * Never mutates sources; never reads the filesystem or network.
 */
export function assembleFactoryStatus(opts: AssembleFactoryStatusOptions): FactoryStatusEnvelope {
  const generated_at = opts.clock.now().toISOString();
  const sources = opts.sources;
  const sourceAttrs: Record<string, Attribution> = {};
  for (const key of FACTORY_STATUS_SOURCE_KEYS) {
    sourceAttrs[key] = sourceAttribution(sources[key]);
  }

  if (opts.forceError) {
    return {
      schema_version: FACTORY_STATUS_SCHEMA_VERSION,
      status: "error",
      generated_at,
      health: emptyHealth("error"),
      controller: {
        kind: "unknown",
        service_controller: null,
        mode: null,
        revision: null,
        hostname: null,
        pid: null,
        attribution: "error",
      },
      run: {
        factory_run_id: null,
        loop_run_id: null,
        contract_hash: null,
        coarse_phase: null,
        engine: null,
        treatment_fingerprint: null,
        authority_fingerprint: null,
        engine_pin: null,
        attribution: "error",
      },
      items: {
        active_count: 0,
        queued_count: 0,
        held_count: 0,
        rows: [],
        attribution: "error",
      },
      operation: {
        id: null,
        started_at: null,
        deadline: null,
        attribution: "error",
      },
      next_action: { code: null, attribution: "error" },
      lock_liveness: {
        holder_present: null,
        host_class: "unknown",
        staleness: null,
        attribution: "error",
      },
      provider: {
        cooldown: null,
        cooldown_until: null,
        attribution: "error",
      },
      write_health: {
        elevated: null,
        summary: null,
        attribution: "error",
      },
      cost: {
        coverage: "unknown",
        actual_usd: null,
        estimated_usd: null,
        attribution: "error",
      },
      sources: sourceAttrs,
      error: sanitizeErrorMessage(opts.forceError),
    };
  }

  const macro = asPresentSource(sources.macroController);
  const loop = asPresentSource(sources.loopStatus);
  const proc = asPresentSource(sources.processIdentity);
  const lock = asPresentSource(sources.lockSummary);
  const pin = asPresentSource(sources.pin);
  const provider = asPresentSource(sources.provider);
  const writeHealth = asPresentSource(sources.writeHealth);
  const cost = asPresentSource(sources.cost);
  const evidence = asPresentSource(sources.actionEvidenceTail);

  // Primary projection: loop status, process identity, or macro controller.
  // Missing all primary sources is still a valid snapshot (empty/legacy factory)
  // with explicit unknown attribution — not a hard error.
  const hasPrimary = macro != null || loop != null || proc != null;
  const anySourceError = FACTORY_STATUS_SOURCE_KEYS.some((k) => isErrorSource(sources[k]));
  const primaryErrors = (["loopStatus", "processIdentity", "macroController"] as const).some(
    (k) => isErrorSource(sources[k]),
  );

  // Hard error only when every primary reader failed (not merely absent).
  if (!hasPrimary && primaryErrors && !loop && !proc && !macro) {
    const errKey = (["loopStatus", "processIdentity", "macroController"] as const).find((k) =>
      isErrorSource(sources[k]),
    );
    const errMsg =
      errKey && isErrorSource(sources[errKey])
        ? sources[errKey].__error
        : "primary_source_unavailable";
    return assembleFactoryStatus({ ...opts, forceError: errMsg });
  }

  // Controller identity
  let controllerKind: FactoryStatusEnvelope["controller"]["kind"] = "unknown";
  let controllerAttr: Attribution = "unknown";
  let serviceController: string | null = null;
  let mode: string | null = null;
  let revision: number | null = null;

  if (macro) {
    controllerKind = "macro";
    controllerAttr = "present";
    serviceController =
      (typeof macro.service_controller === "string" && macro.service_controller) ||
      (typeof macro.identities?.service_controller === "string" && macro.identities.service_controller) ||
      null;
    mode = typeof macro.mode === "string" ? macro.mode : null;
    revision = typeof macro.revision === "number" ? macro.revision : null;
  } else if (proc || loop) {
    controllerKind = "loop_supervisor";
    controllerAttr = proc ? "present" : "legacy";
    serviceController = "loop-supervisor";
    mode = "loop";
    revision = null;
  } else {
    controllerAttr = "not_applicable";
  }

  // Run block
  const runAttr: Attribution =
    macro || loop ? "present" : proc ? "legacy" : "unknown";
  const factoryRunId =
    (typeof macro?.factory_run_id === "string" && macro.factory_run_id) || null;
  const loopRunId =
    (typeof macro?.linked_runs?.loop_run_id === "string" && macro.linked_runs.loop_run_id) ||
    (typeof loop?.run_id === "string" && loop.run_id) ||
    (typeof proc?.run_id === "string" && proc.run_id) ||
    null;
  const contractHash =
    (typeof macro?.canonical_hash === "string" && macro.canonical_hash) ||
    (typeof macro?.linked_runs?.loop_contract_hash === "string" &&
      macro.linked_runs.loop_contract_hash) ||
    (typeof loop?.canonical_hash === "string" && loop.canonical_hash) ||
    null;
  const coarsePhase =
    (typeof macro?.coarse_phase === "string" && macro.coarse_phase) || null;
  const engine =
    (typeof loop?.engine === "string" && loop.engine) ||
    (typeof proc?.engine === "string" && proc.engine) ||
    null;
  const treatmentFp =
    (typeof macro?.fingerprints?.treatment === "string" && macro.fingerprints.treatment) ||
    null;
  const authorityFp =
    (typeof macro?.fingerprints?.authority_policy === "string" &&
      macro.fingerprints.authority_policy) ||
    null;
  const enginePin =
    (typeof macro?.fingerprints?.engine_pin === "string" && macro.fingerprints.engine_pin) ||
    (typeof pin?.version === "string" && pin.version) ||
    (typeof pin?.tag === "string" && pin.tag) ||
    null;

  // Items
  const rows: FactoryStatusItemRow[] = [];
  let activeCount = 0;
  let queuedCount = 0;
  let heldCount = 0;
  let itemsAttr: Attribution = "unknown";

  if (loop?.items && typeof loop.items === "object") {
    itemsAttr = "present";
    for (const [itemId, raw] of Object.entries(loop.items)) {
      const state = sanitizeItemState(raw?.state);
      const stage = sanitizeStage(raw?.current_stage);
      const advance =
        typeof raw?.advance_run_id === "string" && raw.advance_run_id.length > 0
          ? raw.advance_run_id
          : null;
      const pr = typeof raw?.pr === "number" && Number.isFinite(raw.pr) ? raw.pr : null;
      const candidate =
        typeof raw?.candidate === "string" && /^[A-Za-z0-9._/-]{1,80}$/.test(raw.candidate)
          ? raw.candidate
          : null;
      rows.push({
        item_id: /^[A-Za-z0-9._-]+$/.test(itemId) ? itemId : "unknown",
        state,
        stage,
        advance_run_id: advance,
        pr,
        candidate,
      });
      if (state === "in_progress") activeCount++;
      else if (state === "pending" || state === "ready") queuedCount++;
      else if (state === "paused" || state === "waiting" || state === "blocked") heldCount++;
    }
    if (Array.isArray(loop.active_items)) {
      activeCount = Math.max(activeCount, loop.active_items.length);
    }
  } else if (loop) {
    itemsAttr = "legacy";
  }

  // Operation
  const opId =
    (typeof proc?.current_operation === "string" && proc.current_operation) || null;
  const opStarted =
    (typeof proc?.operation_started_at === "string" && proc.operation_started_at) || null;
  const opDeadline =
    (typeof proc?.operation_deadline === "string" && proc.operation_deadline) || null;
  const opAttr: Attribution =
    opId || opDeadline ? "present" : proc ? "legacy" : "unknown";

  // Next action — coarse code only
  const nextRaw =
    (typeof macro?.next_action === "string" && macro.next_action) ||
    (typeof evidence?.last_action === "string" && evidence.last_action) ||
    null;
  const nextCode = sanitizeNextActionCode(nextRaw);
  const nextAttr: Attribution = nextRaw != null ? "present" : "unknown";

  // Lock / liveness summary (never tokens)
  let holderPresent: boolean | null = null;
  let hostClass: FactoryStatusEnvelope["lock_liveness"]["host_class"] = "unknown";
  let staleness: string | null = null;
  let lockAttr: Attribution = "unknown";

  if (lock) {
    lockAttr = "present";
    holderPresent = lock.holder_present === true;
    staleness = typeof lock.staleness === "string" ? lock.staleness : null;
    if (!holderPresent) {
      hostClass = "none";
    } else if (typeof lock.hostname === "string" && lock.hostname.length > 0) {
      hostClass =
        lock.hostname === opts.probes.localHostname() ? "same_host" : "cross_host";
    } else {
      hostClass = "unknown";
    }
  } else if (proc?.hostname) {
    lockAttr = "legacy";
    holderPresent = true;
    hostClass =
      proc.hostname === opts.probes.localHostname() ? "same_host" : "cross_host";
  }

  // Provider
  let providerCooldown: boolean | null = null;
  let providerUntil: string | null = null;
  let providerAttr: Attribution = sourceAttribution(sources.provider);
  if (provider) {
    providerCooldown = typeof provider.cooldown === "boolean" ? provider.cooldown : null;
    providerUntil =
      typeof provider.cooldown_until === "string" ? provider.cooldown_until : null;
  }

  // Write health
  let elevated: boolean | null = null;
  let whSummary: string | null = null;
  let whAttr: Attribution = sourceAttribution(sources.writeHealth);
  if (writeHealth) {
    elevated = typeof writeHealth.elevated === "boolean" ? writeHealth.elevated : null;
    if (
      typeof writeHealth.summary_code === "string" &&
      /^[a-z][a-z0-9_-]{0,40}$/i.test(writeHealth.summary_code)
    ) {
      whSummary = writeHealth.summary_code;
    }
  }

  // Cost honesty — never invent zero or quota %
  let costCoverage: CostCoverageKind = "unknown";
  let actualUsd: number | null = null;
  let estimatedUsd: number | null = null;
  let costAttr: Attribution = sourceAttribution(sources.cost);
  if (cost) {
    if (cost.coverage === "actual" || cost.coverage === "estimated" || cost.coverage === "unknown") {
      costCoverage = cost.coverage;
    } else if (typeof cost.actual_usd === "number" && Number.isFinite(cost.actual_usd)) {
      costCoverage = "actual";
    } else if (typeof cost.estimated_usd === "number" && Number.isFinite(cost.estimated_usd)) {
      costCoverage = "estimated";
    } else {
      costCoverage = "unknown";
    }
    if (costCoverage === "actual" && typeof cost.actual_usd === "number" && Number.isFinite(cost.actual_usd)) {
      actualUsd = cost.actual_usd;
    }
    if (
      costCoverage === "estimated" &&
      typeof cost.estimated_usd === "number" &&
      Number.isFinite(cost.estimated_usd)
    ) {
      estimatedUsd = cost.estimated_usd;
    }
    // Deliberately ignore remaining_quota_percent and do not emit it.
  } else if (sources.cost === undefined) {
    costAttr = "not_applicable";
  } else if (sources.cost === null) {
    costAttr = "unknown";
  }

  // Progress timestamp
  const lastProgress =
    (typeof proc?.last_durable_progress_at === "string" && proc.last_durable_progress_at) ||
    (typeof evidence?.last_progress_at === "string" && evidence.last_progress_at) ||
    null;

  // Wait fields
  const waitKind = sanitizeWaitKind(proc?.expected_wait_kind);
  const waitDeadline =
    (typeof proc?.expected_wait_deadline === "string" && proc.expected_wait_deadline) ||
    (providerUntil && providerCooldown ? providerUntil : null);

  // Pid probe for classification
  let pidAlive: boolean | null = null;
  const pid = typeof proc?.pid === "number" ? proc.pid : typeof lock?.pid === "number" ? lock.pid : null;
  const processHostname =
    (typeof proc?.hostname === "string" && proc.hostname) ||
    (typeof lock?.hostname === "string" && lock.hostname) ||
    null;
  if (
    processHostname != null &&
    processHostname === opts.probes.localHostname() &&
    pid != null &&
    opts.probes.isPidAlive
  ) {
    const alive = opts.probes.isPidAlive(pid);
    // classify is sync; if probe returns a Promise we treat as insufficient (null).
    if (typeof alive === "boolean") pidAlive = alive;
    else pidAlive = null;
  } else if (processHostname != null && processHostname !== opts.probes.localHostname()) {
    pidAlive = null; // cross-host — never claim dead
  }

  const health = classifyFactoryHealth({
    nowMs: opts.clock.now().getTime(),
    livenessBoundMs: opts.livenessBoundMs,
    heartbeatAt: typeof proc?.heartbeat_at === "string" ? proc.heartbeat_at : null,
    heartbeatWriteError:
      typeof proc?.heartbeat_write_error === "string" ? proc.heartbeat_write_error : null,
    processHostname,
    processPid: pid,
    localHostname: opts.probes.localHostname(),
    pidAlive,
    lastDurableProgressAt: lastProgress,
    operationId: opId,
    operationStartedAt: opStarted,
    operationDeadline: opDeadline,
    expectedWaitKind: waitKind ?? (providerCooldown ? "provider_cooldown" : null),
    expectedWaitDeadline: waitDeadline,
    controllerTerminal: Boolean(loop?.stop),
  });

  // Top-level status
  let topStatus: FactoryStatusTopLevel = "ok";
  if (anySourceError) topStatus = "degraded";
  // Optional-only failures still degrade when primary is ok.
  const optionalErrors = (["pin", "provider", "writeHealth", "cost", "macroController"] as const).some(
    (k) => isErrorSource(sources[k]),
  );
  if (optionalErrors && hasPrimary) topStatus = "degraded";

  // Macro absent → not_applicable for mode/revision when we used loop supervisor
  if (!macro && controllerKind === "loop_supervisor") {
    // revision already null; mode set; attribution stays
  }

  return {
    schema_version: FACTORY_STATUS_SCHEMA_VERSION,
    status: topStatus,
    generated_at,
    health,
    controller: {
      kind: controllerKind,
      service_controller: serviceController,
      mode: macro ? mode : controllerKind === "loop_supervisor" ? "loop" : mode,
      revision: macro ? revision : null,
      hostname: processHostname,
      pid,
      attribution: controllerAttr,
    },
    run: {
      factory_run_id: factoryRunId,
      loop_run_id: loopRunId,
      contract_hash: contractHash,
      coarse_phase: coarsePhase,
      engine,
      treatment_fingerprint: treatmentFp,
      authority_fingerprint: authorityFp,
      engine_pin: enginePin,
      attribution: runAttr,
    },
    items: {
      active_count: activeCount,
      queued_count: queuedCount,
      held_count: heldCount,
      rows,
      attribution: itemsAttr,
    },
    operation: {
      id: opId,
      started_at: opStarted,
      deadline: opDeadline,
      attribution: opAttr,
    },
    next_action: {
      code: nextCode,
      attribution: nextAttr,
    },
    lock_liveness: {
      holder_present: holderPresent,
      host_class: hostClass,
      staleness,
      attribution: lockAttr,
    },
    provider: {
      cooldown: providerCooldown,
      cooldown_until: providerUntil,
      attribution: providerAttr,
    },
    write_health: {
      elevated,
      summary: whSummary,
      attribution: whAttr,
    },
    cost: {
      coverage: costCoverage,
      actual_usd: actualUsd,
      estimated_usd: estimatedUsd,
      attribution: costAttr,
    },
    sources: sourceAttrs,
  };
}

// ---------------------------------------------------------------------------
// Human rendering (derived only from allowlisted envelope)
// ---------------------------------------------------------------------------

export function formatFactoryStatusHuman(env: FactoryStatusEnvelope): string {
  const lines: string[] = [];
  lines.push(`Factory status: ${env.status} (schema ${env.schema_version})`);
  lines.push(`Generated: ${env.generated_at}`);
  lines.push(
    `Health: coarse=${env.health.coarse} liveness=${env.health.process_liveness.state} ` +
      `progress=${env.health.durable_progress.state} waiting=${env.health.expected_waiting.state}` +
      (env.health.expected_waiting.kind
        ? `(${env.health.expected_waiting.kind})`
        : ""),
  );
  lines.push(
    `Controller: kind=${env.controller.kind} service=${env.controller.service_controller ?? "—"} ` +
      `mode=${env.controller.mode ?? "—"} revision=${env.controller.revision ?? "—"} ` +
      `host=${env.controller.hostname ?? "—"} pid=${env.controller.pid ?? "—"} ` +
      `[${env.controller.attribution}]`,
  );
  lines.push(
    `Run: factory=${env.run.factory_run_id ?? "—"} loop=${env.run.loop_run_id ?? "—"} ` +
      `phase=${env.run.coarse_phase ?? "—"} engine=${env.run.engine ?? "—"} ` +
      `pin=${env.run.engine_pin ?? "—"} [${env.run.attribution}]`,
  );
  lines.push(
    `Items: active=${env.items.active_count} queued=${env.items.queued_count} ` +
      `held=${env.items.held_count} [${env.items.attribution}]`,
  );
  for (const row of env.items.rows.slice(0, 20)) {
    lines.push(
      `  - ${row.item_id}: state=${row.state} stage=${row.stage ?? "—"} ` +
        `advance=${row.advance_run_id ?? "—"} pr=${row.pr ?? "—"}`,
    );
  }
  lines.push(
    `Operation: id=${env.operation.id ?? "—"} deadline=${env.operation.deadline ?? "—"} ` +
      `[${env.operation.attribution}]`,
  );
  lines.push(
    `Next action: ${env.next_action.code ?? "—"} [${env.next_action.attribution}]`,
  );
  lines.push(
    `Lock/liveness: holder=${env.lock_liveness.holder_present ?? "—"} ` +
      `host_class=${env.lock_liveness.host_class} staleness=${env.lock_liveness.staleness ?? "—"}`,
  );
  lines.push(
    `Provider: cooldown=${env.provider.cooldown ?? "—"} until=${env.provider.cooldown_until ?? "—"}`,
  );
  lines.push(
    `Write health: elevated=${env.write_health.elevated ?? "—"} summary=${env.write_health.summary ?? "—"}`,
  );
  lines.push(
    `Cost: coverage=${env.cost.coverage}` +
      (env.cost.actual_usd != null ? ` actual_usd=${env.cost.actual_usd}` : "") +
      (env.cost.estimated_usd != null ? ` estimated_usd=${env.cost.estimated_usd}` : ""),
  );
  if (env.error) {
    lines.push(`Error: ${env.error}`);
  }
  const srcParts = Object.entries(env.sources).map(([k, v]) => `${k}=${v}`);
  lines.push(`Sources: ${srcParts.join(" ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Independent heartbeat (controller-owned cadence)
// ---------------------------------------------------------------------------

export interface IndependentHeartbeatDeps {
  /** Persist the process identity record (token-guarded store seam). */
  writeProcess(record: import("./loop/types.ts").LoopSupervisorProcess): Promise<void>;
  now(): Date;
  /** Injectable sleep; production uses setTimeout. */
  sleep(ms: number): Promise<void>;
  /** Interval between refreshes. */
  intervalMs: number;
  /** Return current process record to refresh. */
  getRecord(): import("./loop/types.ts").LoopSupervisorProcess;
  /** Mutate local record after successful write (or failed write marker). */
  setRecord(record: import("./loop/types.ts").LoopSupervisorProcess): void;
  /** When false, the loop stops (lock loss / terminal). */
  shouldContinue(): boolean;
}

export interface IndependentHeartbeatHandle {
  /** Resolves when the loop has fully stopped. */
  stop(): Promise<void>;
  /** Last persistence error message, if any. */
  lastWriteError(): string | null;
}

/**
 * Start a controller-owned independent heartbeat loop. Advances heartbeat_at
 * on a bounded cadence without requiring model/worker progress messages.
 * Stops when `shouldContinue()` is false or `stop()` is called.
 * `stop()` interrupts any in-flight sleep so callers do not wait the full interval.
 */
export function startIndependentHeartbeat(deps: IndependentHeartbeatDeps): IndependentHeartbeatHandle {
  let stopped = false;
  let lastWriteError: string | null = null;
  let loopPromise: Promise<void> | null = null;
  let wakeSleep: (() => void) | null = null;

  const interruptibleSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        wakeSleep = null;
        resolve();
      };
      wakeSleep = done;
      void Promise.resolve(deps.sleep(ms)).then(done, done);
    });

  const tick = async () => {
    while (!stopped && deps.shouldContinue()) {
      await interruptibleSleep(deps.intervalMs);
      if (stopped || !deps.shouldContinue()) break;
      const base = deps.getRecord();
      const next = {
        ...base,
        heartbeat_at: deps.now().toISOString(),
      };
      // Clear prior write error on attempt; re-set if write fails.
      delete (next as { heartbeat_write_error?: string }).heartbeat_write_error;
      try {
        await deps.writeProcess(next);
        lastWriteError = null;
        deps.setRecord(next);
      } catch (err) {
        lastWriteError = err instanceof Error ? err.message : String(err);
        const failed = {
          ...base,
          heartbeat_write_error: sanitizeErrorMessage(lastWriteError),
        };
        deps.setRecord(failed as import("./loop/types.ts").LoopSupervisorProcess);
        // Do not claim healthy liveness after a failed write.
      }
    }
  };

  loopPromise = tick();

  return {
    async stop() {
      stopped = true;
      wakeSleep?.();
      if (loopPromise) await loopPromise.catch(() => {});
    },
    lastWriteError() {
      return lastWriteError;
    },
  };
}

/**
 * Project a raw loop status + process record into factory status sources
 * without copying tokens or free-text hold reasons.
 */
export function projectLoopSourcesForFactoryStatus(input: {
  loopStatus?: {
    run_id: string;
    engine: string;
    canonical_hash: string;
    items: Record<
      string,
      {
        state: string;
        current_stage?: string;
        advance_run_id?: string;
      }
    >;
    active_items: string[];
    stop: { reason?: string; time?: string } | null;
    lock?: {
      holder: {
        hostname: string;
        pid: number;
        engine: string;
        token?: string;
      } | null;
      staleness: string | null;
    };
    supervisor?: {
      run_id: string;
      engine: string;
      pid: number;
      hostname: string;
      boot_id: string;
      started_at: string;
      heartbeat_at: string;
      token?: string;
      consecutive_no_progress: number;
      current_operation?: string | null;
      operation_started_at?: string | null;
      operation_deadline?: string | null;
      expected_wait_kind?: string | null;
      expected_wait_deadline?: string | null;
      last_durable_progress_at?: string | null;
      heartbeat_write_error?: string | null;
    } | null;
    action_evidence?: Array<{
      time: string;
      action: string;
      progress: string;
      outcome?: string;
    }>;
  } | null;
  pin?: { version?: string; tag?: string; track?: string } | null;
  provider?: { cooldown?: boolean; cooldown_until?: string } | null;
  writeHealth?: { elevated?: boolean; summary_code?: string } | null;
  cost?: {
    coverage?: CostCoverageKind;
    actual_usd?: number | null;
    estimated_usd?: number | null;
  } | null;
  macroController?: FactoryMacroControllerSource | null;
}): FactoryStatusSources {
  const sources: FactoryStatusSources = {};

  if (input.macroController !== undefined) {
    sources.macroController = input.macroController;
  }

  if (input.loopStatus) {
    const ls = input.loopStatus;
    const items: FactoryLoopStatusSource["items"] = {};
    for (const [id, row] of Object.entries(ls.items ?? {})) {
      items![id] = {
        state: row.state,
        current_stage: row.current_stage,
        advance_run_id: row.advance_run_id,
        // deliberately omit title/hold_reason/comment
      };
    }
    sources.loopStatus = {
      run_id: ls.run_id,
      engine: ls.engine,
      canonical_hash: ls.canonical_hash,
      items,
      active_items: ls.active_items,
      stop: ls.stop
        ? {
            // reason free text dropped — only presence of stop matters for terminal flag
            time: ls.stop.time,
          }
        : null,
    };

    if (ls.lock) {
      sources.lockSummary = {
        holder_present: ls.lock.holder != null,
        hostname: ls.lock.holder?.hostname ?? null,
        pid: ls.lock.holder?.pid ?? null,
        engine: ls.lock.holder?.engine ?? null,
        staleness: ls.lock.staleness,
        // token deliberately omitted
      };
    }

    if (ls.supervisor) {
      const s = ls.supervisor;
      sources.processIdentity = {
        run_id: s.run_id,
        engine: s.engine,
        pid: s.pid,
        hostname: s.hostname,
        boot_id: s.boot_id,
        started_at: s.started_at,
        heartbeat_at: s.heartbeat_at,
        consecutive_no_progress: s.consecutive_no_progress,
        current_operation: s.current_operation ?? null,
        operation_started_at: s.operation_started_at ?? null,
        operation_deadline: s.operation_deadline ?? null,
        expected_wait_kind: s.expected_wait_kind ?? null,
        expected_wait_deadline: s.expected_wait_deadline ?? null,
        last_durable_progress_at: s.last_durable_progress_at ?? null,
        heartbeat_write_error: s.heartbeat_write_error ?? null,
        // token deliberately omitted
      };
    }

    if (ls.action_evidence && ls.action_evidence.length > 0) {
      const progressEntries = ls.action_evidence.filter((e) => e.progress === "progress");
      const last = progressEntries[progressEntries.length - 1] ?? ls.action_evidence[ls.action_evidence.length - 1];
      sources.actionEvidenceTail = {
        last_progress_at: last?.time ?? null,
        last_action: typeof last?.action === "string" ? last.action : null,
        // outcome free text omitted
      };
    }
  }

  if (input.pin !== undefined) sources.pin = input.pin;
  if (input.provider !== undefined) sources.provider = input.provider;
  if (input.writeHealth !== undefined) sources.writeHealth = input.writeHealth;
  if (input.cost !== undefined) sources.cost = input.cost;

  return sources;
}
