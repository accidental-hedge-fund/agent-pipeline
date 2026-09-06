/** Optional, metadata-only handoff to the host's observability exporter.
 * No HTTP or dashboard SDK runs in a pipeline process. Final accounting owns
 * pipeline usage; native transcript observations supply the detailed timeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeStageAccountingRecord } from "./accounting.ts";
import type { StageAccountingRecord } from "./types.ts";

export interface ObservabilityDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  read: (file: string) => Promise<string>;
  list: (dir: string) => Promise<string[]>;
  write: (file: string, data: object) => Promise<void>;
  remove: (file: string) => Promise<void>;
  warn: (message: string) => void;
  uuid: () => string;
}

export const defaultObservabilityDeps: ObservabilityDeps = {
  env: process.env,
  home: homedir(),
  read: (file) => fs.readFile(file, "utf8"),
  list: (dir) => fs.readdir(dir),
  write: async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  },
  remove: (file) => fs.unlink(file),
  warn: (message) => console.warn(`[pipeline] observability (non-fatal): ${message}`),
  uuid: randomUUID,
};

export function observabilityPaths(deps: ObservabilityDeps) {
  const state = path.join(deps.home, ".local", "state", "agent-observability");
  return {
    inbox: deps.env.AGENT_OBSERVABILITY_INBOX || path.join(state, "inbox"),
    context: path.join(state, "context"),
    config: path.join(deps.home, ".config", "agent-observability", "config.json"),
  };
}

export async function observabilityEnabled(deps = defaultObservabilityDeps): Promise<boolean> {
  if (["0", "off", "false"].includes(deps.env.AGENT_OBSERVABILITY_ENABLED ?? "")) return false;
  if (["1", "on", "true"].includes(deps.env.AGENT_OBSERVABILITY_ENABLED ?? "")) return true;
  try {
    const config = JSON.parse(await deps.read(observabilityPaths(deps).config));
    return config !== null && typeof config === "object" && config.enabled !== false;
  } catch {
    return false;
  }
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
  deps = defaultObservabilityDeps,
): Promise<InvocationObservation | null> {
  if (!await observabilityEnabled(deps)) return null;
  const id = deps.uuid();
  const harness = observabilityHarness(input.harness);
  const runId = path.basename(input.runDir);
  const meta = await runMetadata(input.runDir, deps);
  const metadata = {
    workload: "agent-pipeline", pipeline_run_id: runId, pipeline_stage: input.stage,
    invocation_id: id, accounting_owner: "pipeline", ...meta,
    ...(meta.repo ? { work_item_id: `${meta.repo}#${input.issue}` } : {}),
    issue: input.issue,
  };
  const contextDir = observabilityPaths(deps).context;
  const active = path.join(contextDir, `active--${id}.json`);
  const base = { harness, start_time: input.startedAt, cwd: input.cwd, pid: process.pid, metadata };
  try {
    await deps.write(active, base);
  } catch (error) {
    deps.warn(`cannot record active invocation: ${(error as Error).message}`);
    return null;
  }
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

export function accountingObservation(record: StageAccountingRecord, metadata: Record<string, string> = {}) {
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
  const hasUsage = inclusiveInput != null || output != null;
  const hasCost = r.cost_usd != null;
  return {
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
      pipeline_stage: r.stage, invocation_id: id, issue: r.issue,
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
  deps = defaultObservabilityDeps,
): Promise<void> {
  if (!await observabilityEnabled(deps)) return;
  try {
    const { inbox } = observabilityPaths(deps);
    let files: string[] = [];
    try { files = await deps.list(inbox); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (files.length >= 10_000) throw new Error("inbox reached 10000 files; source accounting retained in run events");
    const event = accountingObservation(record, await runMetadata(runDir, deps));
    const filename = createHash("sha256").update(event.event_id).digest("hex");
    await deps.write(path.join(inbox, `${filename}.json`), event);
  } catch (error) {
    deps.warn(`accounting export failed: ${(error as Error).message}`);
  }
}
