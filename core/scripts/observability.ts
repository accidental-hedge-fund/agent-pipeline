/** Optional, metadata-only handoff to any host-local observability consumer.
 * No HTTP or dashboard SDK runs in a pipeline process. Final accounting owns
 * pipeline usage; native transcript observations supply the detailed timeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeStageAccountingRecord } from "./accounting.ts";
import type { ObservabilityConfig, StageAccountingRecord } from "./types.ts";
import type { RunEvent } from "./run-store.ts";

export const OBSERVABILITY_SCHEMA_VERSION = 1;
export const TELEMETRY_SCHEMA_VERSION = 2;

export interface ObservabilityDeps {
  home: string;
  read: (file: string) => Promise<string>;
  list: (dir: string) => Promise<string[]>;
  write: (file: string, data: object) => Promise<void>;
  remove: (file: string) => Promise<void>;
  warn: (message: string) => void;
  uuid: () => string;
}

export const defaultObservabilityDeps: ObservabilityDeps = {
  home: homedir(),
  read: (file) => fs.readFile(file, "utf8"),
  list: (dir) => fs.readdir(dir),
  write: async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(data)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  },
  remove: (file) => fs.unlink(file),
  warn: (message) => console.warn(`[pipeline] observability (non-fatal): ${message}`),
  uuid: randomUUID,
};

export function observabilityPaths(config: ObservabilityConfig, deps: ObservabilityDeps) {
  const directory = config.exporter.directory;
  const state = directory.startsWith("~/") ? path.join(deps.home, directory.slice(2)) : directory;
  return {
    inbox: path.join(state, "inbox"),
    context: path.join(state, "context"),
  };
}

/** Already-resolved pipeline.yml configuration is the sole feature authority. */
export function observabilityEnabled(config?: ObservabilityConfig): config is ObservabilityConfig {
  return config?.enabled === true && config.exporter?.type === "file";
}

/** Node's test worker may inherit a real HOME and an enrolled collector. Tests
 * must inject their local/in-memory I/O seam, even when fixture YAML opts in.
 * This safety veto cannot enable telemetry; ordinary CLI evaluations are real
 * traffic and are configured independently through pipeline.yml. */
export function observabilityIoEnabled(config: ObservabilityConfig | undefined, deps: ObservabilityDeps): config is ObservabilityConfig {
  const ambientIo = deps === defaultObservabilityDeps ||
    (["read", "list", "write", "remove"] as const).some((key) => deps[key] === defaultObservabilityDeps[key]);
  return observabilityEnabled(config) && !(ambientIo && process.env.NODE_TEST_CONTEXT);
}

function contractMetadata(config?: ObservabilityConfig) {
  return {
    telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
    traffic_class: config?.traffic_class ?? "real",
    execution_purpose: config?.execution_purpose ?? "operational",
    workload_source: "explicit",
  };
}

function jobIdentity(runId: string, metadata: Record<string, string>) {
  const jobId = metadata.logical_operation_id || runId;
  return { job_id: jobId, job_session_id: `pipeline:${metadata.repo || "unknown"}:${jobId}` };
}

function failureClass(outcome: string, status?: number, rateLimited?: boolean | null) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota_exhausted";
  if (status === 429 || (outcome !== "success" && rateLimited === true)) return "rate_limit";
  if (status != null && status >= 500 && status < 600) return "provider_unavailable";
  if (outcome === "timeout") return "timeout";
  if (outcome === "cancelled" || outcome === "aborted") return "cancelled";
  return ["error", "failure", "spawn-error"].includes(outcome) ? "other" : "unknown";
}

export function observabilityHarness(harness: string): string {
  return harness === "claude" ? "claude-code" : harness;
}

async function runMetadata(runDir: string, deps: ObservabilityDeps): Promise<Record<string, string>> {
  try {
    const meta = JSON.parse(await deps.read(path.join(runDir, "run.json")));
    return {
      ...(typeof meta.repo === "string" ? { repo: meta.repo } : {}),
      ...(typeof meta.loop_run_id === "string" ? { loop_run_id: meta.loop_run_id } : {}),
      ...(typeof meta.logical_operation_id === "string" ? { logical_operation_id: meta.logical_operation_id } : {}),
      ...(typeof meta.profile === "string" ? { profile: meta.profile } : {}),
      ...(typeof meta.started_at === "string" ? { run_started_at: meta.started_at } : {}),
      ...(typeof meta.repo === "string" && Number.isInteger(meta.issue) && meta.issue > 0 ? { work_item_id: `${meta.repo}#${meta.issue}` } : {}),
    };
  } catch {
    return {};
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

/** Read only known envelope identity locations; never scan arbitrary output. */
export function nativeSessionId(harness: string, line: string): string | null {
  try {
    const e = JSON.parse(line);
    const id = harness === "claude-code" ? e.session_id
      : harness === "codex" ? (e.type === "thread.started" ? e.thread_id : e.type === "session_meta" ? e.payload?.id : null)
      : harness === "grok" ? (e.sessionId ?? e.params?.sessionId)
      : harness === "omp" && e.type === "session" ? e.id : null;
    return safeId(id) ? id : null;
  } catch {
    return null;
  }
}

export interface InvocationObservation {
  id: string;
  env: NodeJS.ProcessEnv;
  feed: (chunk: string) => void;
  finish: (stdout: string, endedAt: string) => Promise<void>;
}

/** Write an active marker before spawn. Exporters defer unmapped same-harness
 * sessions while it exists, closing the transcript-before-identity race. */
export async function beginInvocationObservation(
  input: { runDir: string; issue: number; stage: string; harness: string; cwd: string; startedAt: string },
  config?: ObservabilityConfig,
  deps = defaultObservabilityDeps,
): Promise<InvocationObservation | null> {
  if (!observabilityIoEnabled(config, deps)) return null;
  const id = deps.uuid();
  const harness = observabilityHarness(input.harness);
  const runId = path.basename(input.runDir);
  const meta = await runMetadata(input.runDir, deps);
  const metadata = {
    ...contractMetadata(config), ...jobIdentity(runId, meta),
    workload: "agent-pipeline", pipeline_run_id: runId, pipeline_stage: input.stage,
    invocation_id: id, accounting_owner: "pipeline", ...meta,
    ...(meta.repo ? { work_item_id: `${meta.repo}#${input.issue}` } : {}),
    issue: input.issue,
  };
  const contextDir = observabilityPaths(config, deps).context;
  const active = path.join(contextDir, `active--${id}.json`);
  const base = { schema_version: OBSERVABILITY_SCHEMA_VERSION, producer: "agent-pipeline", harness, start_time: input.startedAt, cwd: input.cwd, pid: process.pid, metadata };
  try {
    await deps.write(active, base);
  } catch (error) {
    deps.warn(`cannot record active invocation: ${(error as Error).message}`);
    return null;
  }
  await enqueueObservation({
    schema_version: OBSERVABILITY_SCHEMA_VERSION, producer: "agent-pipeline",
    event_id: `pipeline:invocation-start:${id}`, session_id: `pipeline:${runId}:${id}`,
    harness, kind: "session", name: `pipeline ${input.stage} invocation started`,
    start_time: input.startedAt, end_time: input.startedAt,
    metadata: { ...metadata, attempt_id: id, record_grain: "lifecycle", accounting_role: "supplementary",
      coverage: "lifecycle_only", usage_completeness: "unknown", timing_quality: "completion_only",
      telemetry_event: "invocation_start", lifecycle_phase: "start", outcome: "unknown" },
  }, config, deps).catch((error) => deps.warn(`invocation start export failed: ${(error as Error).message}`));
  let buffer = "";
  const ids = new Set<string>();
  let pending = Promise.resolve();
  let failed = false;
  const consume = (line: string) => {
    const sessionId = nativeSessionId(harness, line);
    if (!sessionId || ids.has(sessionId)) return;
    ids.add(sessionId);
    pending = pending.then(async () => {
      await deps.write(path.join(contextDir, `${harness}--${sessionId}.json`), {
        ...base, session_id: sessionId,
      });
    }).catch((error) => {
      failed = true;
      deps.warn(`cannot record native session context: ${(error as Error).message}`);
    });
  };
  return {
    id,
    env: {
      AGENT_OBSERVABILITY_WORKLOAD: "agent-pipeline",
      AGENT_OBSERVABILITY_ACCOUNTING_OWNER: "pipeline",
      AI_OBSERVABILITY_WORKLOAD: "agent-pipeline",
      AI_OBSERVABILITY_ACCOUNTING_OWNER: "pipeline",
      PIPELINE_RUN_ID: runId, PIPELINE_STAGE: input.stage,
      PIPELINE_ISSUE: String(input.issue), PIPELINE_HARNESS: harness,
      PIPELINE_INVOCATION_ID: id,
      ...(meta.repo ? { PIPELINE_REPO: meta.repo } : {}),
    },
    feed(chunk) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      // Identity lives in short envelope records; never retain an unbounded
      // assistant message or other content while searching for its delimiter.
      if (buffer.length > 100_000) buffer = "";
    },
    async finish(stdout, endedAt) {
      for (const line of stdout.split("\n")) consume(line);
      if (buffer) consume(buffer);
      await pending;
      if (ids.size > 0 && !failed) {
        await deps.remove(active).catch((error) => deps.warn(`cannot retire invocation marker: ${(error as Error).message}`));
      } else {
        // Keep the bounded time interval visible to exporter health; never
        // silently reclassify an unresolved pipeline session as interactive.
        await deps.write(active, { ...base, end_time: endedAt, unresolved: true }).catch(() => {});
        deps.warn(`native session identity unavailable for ${harness} invocation ${id}`);
      }
    },
  };
}

export function accountingObservation(record: StageAccountingRecord, metadata: Record<string, string> = {}, config?: ObservabilityConfig) {
  const r = sanitizeStageAccountingRecord(record);
  const harness = observabilityHarness(r.harness);
  const id = r.invocation_id || createHash("sha256").update(JSON.stringify(r)).digest("hex");
  const u = r.usage;
  const input = u?.input_tokens ?? u?.prompt_tokens;
  const output = u?.output_tokens ?? u?.completion_tokens;
  const cacheRead = u?.cached_input_tokens;
  const cacheWrite = u?.cache_creation_input_tokens;
  // Claude and Grok headless input excludes cache; Codex/OpenAI includes it.
  const inclusiveInput = input == null ? undefined : input +
    (["claude-code", "grok"].includes(harness) ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0);
  const synthetic = config?.traffic_class === "synthetic";
  const hasUsage = !synthetic && (inclusiveInput != null || output != null);
  const hasCost = !synthetic && r.cost_usd != null;
  return {
    schema_version: OBSERVABILITY_SCHEMA_VERSION, producer: "agent-pipeline",
    event_id: `pipeline:${id}`, harness,
    // This is explicitly an invocation aggregate, never a fabricated native session.
    session_id: `pipeline:${r.run_id}:${id}`,
    kind: hasUsage || hasCost ? "generation" : "session",
    name: `pipeline ${r.stage}`,
    start_time: r.started_at, end_time: r.ended_at ?? r.started_at,
    ...(r.resolved_model ? { model: r.resolved_model } : {}),
    ...(r.upstream_provider ? { provider: r.upstream_provider } : {}),
    ...(hasUsage ? { usage: {
      ...(inclusiveInput != null ? { input: inclusiveInput } : {}),
      ...(output != null ? { output } : {}),
      ...(cacheRead != null ? { cache_read: cacheRead } : {}),
      ...(cacheWrite != null ? { cache_write: cacheWrite } : {}),
      ...(u?.reasoning_tokens != null ? { reasoning: u.reasoning_tokens } : {}),
    } } : {}),
    ...(hasCost ? { cost_usd: r.cost_usd } : {}),
    cost_basis: r.cost_source === "actual" ? "reported" : r.cost_source,
    metadata: {
      ...metadata, workload: "agent-pipeline", pipeline_run_id: r.run_id,
      ...contractMetadata(config), ...jobIdentity(r.run_id, metadata),
      pipeline_stage: r.stage, invocation_id: id, issue: r.issue,
      attempt_id: id, record_grain: "invocation_aggregate",
      accounting_role: synthetic ? "supplementary" : "authoritative",
      usage_completeness: "unknown", timing_quality: r.ended_at ? "aggregate" : "completion_only",
      failure_class: failureClass(r.outcome, r.http_status ?? undefined, r.rate_limited),
      ...(r.http_status != null ? { status_code: r.http_status } : {}),
      ...(metadata.repo ? { work_item_id: `${metadata.repo}#${r.issue}` } : {}),
      accounting_owner: "pipeline", coverage: hasUsage ? "aggregate_usage" : hasCost ? "reported_cost_only" : "lifecycle_only",
      currency: "USD", billing_basis: r.provider_auth_class?.startsWith("api-key:") ? "api" : "unknown",
      outcome: r.outcome, requested_model: r.requested_model ?? r.model,
      ...(typeof r.fallback === "boolean" ? { fallback: r.fallback } : {}),
      ...(r.retry_count != null ? { retry_count: r.retry_count } : {}),
      ...(r.adapter_cli_version ? { harness_version: r.adapter_cli_version } : {}),
    },
  };
}

/** Injectable and bounded local queue. Export failure cannot fail a stage. */
export async function enqueueAccountingObservation(
  runDir: string,
  record: StageAccountingRecord,
  config?: ObservabilityConfig,
  deps = defaultObservabilityDeps,
): Promise<void> {
  if (!observabilityIoEnabled(config, deps)) return;
  try {
    await enqueueObservation(accountingObservation(record, await runMetadata(runDir, deps), config), config, deps);
  } catch (error) {
    deps.warn(`accounting export failed: ${(error as Error).message}`);
  }
}

async function enqueueObservation(event: { event_id: string; [key: string]: unknown }, config: ObservabilityConfig, deps: ObservabilityDeps): Promise<void> {
  const { inbox } = observabilityPaths(config, deps);
  let files: string[] = [];
  try { files = await deps.list(inbox); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (files.length >= 10_000) throw new Error("inbox reached 10000 files; source accounting retained in run events");
  const filename = createHash("sha256").update(event.event_id).digest("hex");
  await deps.write(path.join(inbox, `${filename}.json`), event);
}

/** A per-run dispatcher projects durable lifecycle evidence into cost-free
 * observations. Never exports arbitrary run-event payloads. Missing resumed
 * start events mean unknown timing, not an invented interval or attempt count. */
export function createLifecycleObservationSink(config?: ObservabilityConfig, deps = defaultObservabilityDeps) {
  const starts = new Map<string, { at: string; id: string }>();
  return async (runDir: string, event: RunEvent): Promise<void> => {
    if (!observabilityIoEnabled(config, deps)) return;
    if (!["run_start", "run_complete", "stage_start", "stage_complete"].includes(event.type)) return;
    try {
      const source = event as unknown as Record<string, unknown>;
      const runId = path.basename(runDir);
      const meta = await runMetadata(runDir, deps);
      const stage = typeof source.stage === "string" ? source.stage : undefined;
      const starting = event.type.endsWith("_start");
      const key = `${runDir}:${stage ?? "run"}`;
      // Source stage timestamps have seconds precision. Distinct same-clock
      // attempts must not overwrite each other's spool records. Delivery
      // retries retain the ID in the committed envelope, not a recreated event.
      const identity = JSON.stringify([runId, event.type, event.at, stage ?? null, source.seq ?? deps.uuid()]);
      const id = `pipeline:lifecycle:${createHash("sha256").update(identity).digest("hex")}`;
      const start = starts.get(key);
      const startedAt = starting ? event.at : start?.at ?? (!stage ? meta.run_started_at : undefined);
      const measured = !!startedAt && Number.isFinite(Date.parse(startedAt)) && Date.parse(startedAt) <= Date.parse(event.at);
      const rawOutcome = typeof source.outcome === "string" && ["success", "failure", "error", "timeout", "cancelled", "aborted", "advanced", "blocked", "waiting", "skipped", "parked", "needs-human", "ready-to-deploy"].includes(source.outcome) ? source.outcome : undefined;
      const finalState = typeof source.final_state === "string" && /^[a-z0-9:_-]{1,80}$/i.test(source.final_state) ? source.final_state : undefined;
      const outcome = starting ? "unknown" : rawOutcome ?? (finalState === "pipeline:ready-to-deploy" || finalState === "ready-to-deploy" ? "success" : "unknown");
      const observation = {
        schema_version: OBSERVABILITY_SCHEMA_VERSION, producer: "agent-pipeline",
        event_id: id, session_id: `pipeline:${runId}`, harness: "agent-pipeline",
        kind: "session", name: stage ? `pipeline ${stage} ${starting ? "started" : "completed"}` : `pipeline run ${starting ? "started" : "completed"}`,
        start_time: measured ? startedAt : event.at, end_time: event.at,
        metadata: {
          ...contractMetadata(config), ...meta, ...jobIdentity(runId, meta),
          workload: "agent-pipeline", pipeline_run_id: runId,
          ...(stage ? { pipeline_stage: stage, attempt_id: starting ? id : start?.id ?? "unknown" } : {}),
          ...(finalState ? { final_state: finalState } : {}),
          record_grain: "lifecycle", accounting_role: "supplementary", accounting_scope: stage ? "stage" : "run",
          coverage: "lifecycle_only", usage_completeness: "unknown",
          timing_quality: starting ? "completion_only" : measured ? "measured" : "unknown",
          telemetry_event: event.type, lifecycle_phase: starting ? "start" : "complete", outcome,
          failure_class: failureClass(outcome),
        },
      };
      await enqueueObservation(observation, config, deps);
      if (starting) starts.set(key, { at: event.at, id });
      else starts.delete(key);
    } catch (error) {
      deps.warn(`lifecycle export failed: ${(error as Error).message}`);
    }
  };
}
