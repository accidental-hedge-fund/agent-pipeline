import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountingObservation, beginInvocationObservation, enqueueAccountingObservation,
  nativeSessionId, observabilityEnabled, observabilityPaths, type ObservabilityDeps,
  createLifecycleObservationSink, defaultObservabilityDeps,
} from "../scripts/observability.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import { buildStageAccountingRecord } from "../scripts/accounting.ts";
import { appendEvent, emitStageAccounting, type RunStoreDeps } from "../scripts/run-store.ts";

function fixture() {
  const files = new Map<string, string>();
  const warnings: string[] = [];
  let n = 0;
  const deps: ObservabilityDeps = {
    home: "/host",
    read: async (p) => { if (!files.has(p)) throw new Error("missing"); return files.get(p)!; },
    list: async (p) => [...files.keys()].filter((f) => f.startsWith(`${p}/`)),
    write: async (p, value) => { files.set(p, JSON.stringify(value)); },
    remove: async (p) => { files.delete(p); },
    warn: (m) => warnings.push(m), uuid: () => `invocation-${++n}`,
  };
  files.set("/repo/.agent-pipeline/runs/run-1/run.json", JSON.stringify({ repo: "owner/repo", loop_run_id: "loop-1" }));
  return { deps, files, warnings };
}

const runDir = "/repo/.agent-pipeline/runs/run-1";
const enabledConfig = { ...DEFAULT_CONFIG.observability, enabled: true };
function record(overrides = {}) {
  return buildStageAccountingRecord({
    runId: "run-1", invocationId: "inv-1", issue: 42, stage: "review-1", harness: "claude",
    startedAt: "2026-09-06T00:00:00Z", endedAt: "2026-09-06T00:01:00Z", outcome: "success",
    ...overrides,
  });
}

test("absent or explicitly disabled pipeline.yml config does no I/O regardless of host enrollment or legacy env", async () => {
  const { deps, files } = fixture();
  files.set("/host/.config/agent-observability/config.json", "{}");
  (deps as any).env = { AGENT_OBSERVABILITY_ENABLED: "1", AGENT_OBSERVABILITY_INBOX: "/wrong" };
  deps.read = deps.list = async () => { assert.fail("disabled feature must not read ambient configuration or sources"); };
  deps.write = async () => { assert.fail("disabled feature must not write"); };
  for (const config of [undefined, DEFAULT_CONFIG.observability]) {
    assert.equal(observabilityEnabled(config), false);
    await enqueueAccountingObservation(runDir, record(), config, deps);
    assert.equal(await beginInvocationObservation({ runDir, issue: 42, stage: "planning", harness: "codex", cwd: "/repo", startedAt: "2026-09-06T00:00:00Z" }, config, deps), null);
  }
  assert.equal(files.size, 2);
});

test("only configured file spool controls destinations; tilde expansion is host portable", async () => {
  const { deps, files } = fixture();
  (deps as any).env = { AGENT_OBSERVABILITY_ENABLED: "0", AGENT_OBSERVABILITY_INBOX: "/wrong" };
  assert.deepEqual(observabilityPaths(enabledConfig, deps), {
    inbox: "/host/.local/state/agent-pipeline/observability/inbox",
    context: "/host/.local/state/agent-pipeline/observability/context",
  });
  const config = { enabled: true, exporter: { type: "file" as const, directory: "/custom/pipeline-spool" } };
  await enqueueAccountingObservation(runDir, record(), config, deps);
  assert.ok([...files.keys()].some((p) => p.startsWith("/custom/pipeline-spool/inbox/")));
  assert.ok(![...files.keys()].some((p) => p.startsWith("/wrong")));
});

test("accounting output is metadata-only, preserves unknowns, and includes qualified work item", async () => {
  const { deps, files } = fixture();
  const r = record({ model: "requested-only", requestPayload: { secret: "RAW REQUEST" } });
  (r as any).input = "PRIVATE PROMPT";
  await enqueueAccountingObservation(runDir, r, enabledConfig, deps);
  const event = JSON.parse([...files].find(([p]) => p.includes("/inbox/"))![1]);
  assert.equal(event.kind, "session");
  assert.equal(event.schema_version, 1);
  assert.equal(event.producer, "agent-pipeline");
  assert.equal(event.metadata.workload, "agent-pipeline");
  assert.equal(event.metadata.work_item_id, "owner/repo#42");
  assert.equal(event.metadata.loop_run_id, "loop-1");
  assert.equal(event.metadata.coverage, "lifecycle_only");
  assert.ok(!("cost_usd" in event));
  assert.ok(!("usage" in event));
  assert.ok(!("model" in event), "do not report requested model as observed model");
  assert.doesNotMatch(JSON.stringify(event), /RAW REQUEST|PRIVATE PROMPT/);
});

test("inclusive token accounting retains Claude cache writes and avoids double-counting Codex cache", () => {
  const claude = accountingObservation(record({ usage: {
    input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5,
  } }));
  assert.deepEqual(claude.usage, { input: 130, output: 5, cache_read: 100, cache_write: 20 });
  const codex = accountingObservation(record({ harness: "codex", usage: {
    input_tokens: 110, cached_input_tokens: 100, output_tokens: 15, reasoning_output_tokens: 10,
  } }));
  assert.deepEqual(codex.usage, { input: 110, output: 15, cache_read: 100, reasoning: 10 });
});

test("reported cost is labeled reported and billing stays unknown for subscription CLI", () => {
  const event = accountingObservation(record({ usage: { total_cost_usd: 0.25 } }));
  assert.equal(event.cost_usd, 0.25);
  assert.equal(event.cost_basis, "reported");
  assert.equal(event.metadata.billing_basis, "unknown");
});

test("same record has stable event id; separate retries have distinct ids", () => {
  assert.equal(accountingObservation(record()).event_id, accountingObservation(record()).event_id);
  assert.notEqual(accountingObservation(record()).event_id, accountingObservation(record({ invocationId: "inv-2" })).event_id);
});

test("inbox is bounded and write errors never fail the stage", async () => {
  const { deps, warnings } = fixture();
  deps.list = async () => Array(10_000).fill("queued.json");
  deps.write = async () => { assert.fail("queue full must not write"); };
  await enqueueAccountingObservation(runDir, record(), enabledConfig, deps);
  assert.match(warnings[0], /10000/);
  deps.list = async () => [];
  deps.write = async () => { throw new Error("disk full"); };
  await assert.doesNotReject(enqueueAccountingObservation(runDir, record(), enabledConfig, deps));
  assert.match(warnings[1], /disk full/);
});

test("pipeline identity reaches children without papercuts and marker precedes streamed session mapping", async () => {
  const { deps, files } = fixture();
  const observation = await beginInvocationObservation({
    runDir, issue: 42, stage: "review-1", harness: "codex", cwd: "/repo", startedAt: "2026-09-06T00:00:00Z",
  }, enabledConfig, deps);
  assert.ok(observation);
  assert.equal(observation.env.AGENT_OBSERVABILITY_WORKLOAD, "agent-pipeline");
  assert.equal(observation.env.AGENT_OBSERVABILITY_ACCOUNTING_OWNER, "pipeline");
  assert.equal(observation.env.PIPELINE_INVOCATION_ID, observation.id);
  const marker = "/host/.local/state/agent-pipeline/observability/context/active--invocation-1.json";
  assert.ok(files.has(marker), "must exist before caller starts child");
  observation.feed('{"type":"thread.started","thread_');
  observation.feed('id":"native-123"}\n');
  await observation.finish("", "2026-09-06T00:01:00Z");
  assert.ok(!files.has(marker));
  const context = JSON.parse(files.get("/host/.local/state/agent-pipeline/observability/context/codex--native-123.json")!);
  assert.equal(context.schema_version, 1);
  assert.equal(context.producer, "agent-pipeline");
  assert.equal(context.metadata.invocation_id, observation.id);
  assert.equal(context.metadata.accounting_owner, "pipeline");
  assert.equal(context.metadata.work_item_id, "owner/repo#42");
});

test("unresolved native session leaves a completed marker; failed sidecar never releases deferral", async () => {
  const { deps, files, warnings } = fixture();
  const input = { runDir, issue: 42, stage: "fix-1", harness: "grok", cwd: "/repo", startedAt: "2026-09-06T00:00:00Z" };
  const observation = (await beginInvocationObservation(input, enabledConfig, deps))!;
  await observation.finish("arbitrary text", "2026-09-06T00:01:00Z");
  const marker = JSON.parse(files.get("/host/.local/state/agent-pipeline/observability/context/active--invocation-1.json")!);
  assert.equal(marker.unresolved, true);
  assert.equal(marker.end_time, "2026-09-06T00:01:00Z");
  assert.equal(warnings.length, 1);
});

test("native identity extraction is harness-specific and rejects path traversal", () => {
  assert.equal(nativeSessionId("claude-code", '{"session_id":"native-claude"}'), "native-claude");
  assert.equal(nativeSessionId("grok", '{"type":"end","sessionId":"native-grok"}'), "native-grok");
  assert.equal(nativeSessionId("omp", '{"type":"session","id":"native-omp"}'), "native-omp");
  assert.equal(nativeSessionId("codex", '{"session_id":"wrong-shape"}'), null);
  assert.equal(nativeSessionId("claude-code", '{"session_id":"../../sensitive"}'), null);
});

test("run-store sink gets final sanitized accounting and failure does not propagate", async () => {
  const events: object[] = [];
  const deps = {
    appendFile: async () => {},
    accountingSink: async (_dir: string, r: object, config: object) => { assert.equal(config, enabledConfig); events.push(r); },
  } as unknown as RunStoreDeps;
  await emitStageAccounting(runDir, Object.assign(record(), { secret_prompt: "PRIVATE" }), deps, enabledConfig);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  deps.accountingSink = async () => { throw new Error("offline"); };
  await assert.doesNotReject(emitStageAccounting(runDir, record(), deps));
});

test("test workers veto every ambient telemetry read/write even with explicit opt-in", async () => {
  const originalContext = process.env.NODE_TEST_CONTEXT;
  const original = { ...defaultObservabilityDeps };
  let calls = 0;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  defaultObservabilityDeps.read = async () => { calls++; return '{"enabled":true}'; };
  defaultObservabilityDeps.list = async () => { calls++; return []; };
  defaultObservabilityDeps.write = async () => { calls++; };
  defaultObservabilityDeps.remove = async () => { calls++; };
  try {
    assert.equal(await beginInvocationObservation({ runDir, issue: 42, stage: "review", harness: "grok", cwd: "/repo", startedAt: "2026-09-06T00:00:00Z" }, enabledConfig), null);
    await enqueueAccountingObservation(runDir, record(), enabledConfig);
    await createLifecycleObservationSink(enabledConfig)(runDir, { schema_version: 1, type: "stage_start", at: "2026-09-06T00:00:00Z", stage: "review" });
    assert.equal(calls, 0, "an enrolled HOME must not receive fixture telemetry");
  } finally {
    Object.assign(defaultObservabilityDeps, original);
    if (originalContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalContext;
  }
});

test("v2 distinguishes genuine paid evaluations from mocked synthetic fixtures", () => {
  const r = record({ usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.0042 } });
  const real = accountingObservation(r, {}, { ...enabledConfig, traffic_class: "real", execution_purpose: "evaluation" });
  assert.equal(real.schema_version, 1, "wire envelope stays compatible");
  assert.equal(real.metadata.telemetry_schema_version, 2);
  assert.equal(real.metadata.execution_purpose, "evaluation");
  assert.equal(real.kind, "generation");
  assert.equal(real.cost_usd, 0.0042);
  assert.equal(real.metadata.record_grain, "invocation_aggregate");
  assert.equal(real.metadata.usage_completeness, "unknown", "available buckets are not proof of complete source accounting");
  const synthetic = accountingObservation(r, {}, { ...enabledConfig, traffic_class: "synthetic", execution_purpose: "test" });
  assert.equal(synthetic.kind, "session");
  assert.equal(synthetic.metadata.accounting_role, "supplementary");
  assert.equal(synthetic.metadata.traffic_class, "synthetic");
  assert.ok(!("usage" in synthetic));
  assert.ok(!("cost_usd" in synthetic));
});

test("logical operation joins physical runs without changing invocation identity", () => {
  const meta = { repo: "owner/repo", logical_operation_id: "op-123" };
  const a = accountingObservation(record(), meta);
  const b = accountingObservation(record({ runId: "run-resume", invocationId: "inv-resume" }), meta);
  assert.equal(a.metadata.job_session_id, b.metadata.job_session_id);
  assert.notEqual(a.session_id, b.session_id);
  assert.notEqual(a.event_id, b.event_id);
  assert.equal(a.metadata.attempt_id, "inv-1");
  assert.equal(a.metadata.pipeline_run_id, "run-1");
});

test("structured HTTP status separates quota exhaustion, auth, rate limit, and provider failure", () => {
  for (const [status, expected] of [[402, "quota_exhausted"], [401, "auth"], [429, "rate_limit"], [503, "provider_unavailable"]] as const) {
    const event = accountingObservation(record({ outcome: "failure", httpStatus: status }));
    assert.equal(event.metadata.status_code, status);
    assert.equal(event.metadata.failure_class, expected);
  }
  assert.equal(accountingObservation(record({ httpStatus: 900 })).metadata.status_code, undefined);
  assert.equal(accountingObservation(record({ outcome: "success", rateLimited: true })).metadata.failure_class, "unknown");
});

test("durable run/stage lifecycle is cost-free, scoped, and measured only with start evidence", async () => {
  const { deps, files } = fixture();
  const sink = createLifecycleObservationSink(enabledConfig, deps);
  const source = { schema_version: 1, stage: "review", private_prompt: "PRIVATE" };
  await sink(runDir, { ...source, type: "stage_start", at: "2026-09-06T00:00:00Z" });
  await sink(runDir, { ...source, type: "stage_complete", at: "2026-09-06T00:01:00Z", outcome: "success" });
  const events = [...files].filter(([p]) => p.includes("/inbox/")).map(([, v]) => JSON.parse(v));
  assert.equal(events.length, 2);
  assert.equal(events[1].metadata.timing_quality, "measured");
  assert.equal(events[0].metadata.attempt_id, events[1].metadata.attempt_id);
  assert.equal(events[1].start_time, "2026-09-06T00:00:00Z");
  for (const event of events) {
    assert.equal(event.kind, "session");
    assert.equal(event.metadata.record_grain, "lifecycle");
    assert.ok(!("usage" in event));
    assert.ok(!("cost_usd" in event));
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE|private_prompt/);
  }
  await sink(runDir, { ...source, type: "stage_complete", stage: "fix", at: "2026-09-06T00:02:00Z", outcome: "error" });
  const last = JSON.parse([...files].filter(([p]) => p.includes("/inbox/")).at(-1)![1]);
  assert.equal(last.metadata.timing_quality, "unknown");
  assert.equal(last.metadata.attempt_id, "unknown");
});

test("lifecycle projection follows durable local/exclusive delivery and cannot affect its outcome", async () => {
  const observed: object[] = [];
  const store = { appendFile: async () => {}, observabilitySink: async (_dir: string, event: object) => { observed.push(event); } } as unknown as RunStoreDeps;
  const event = { schema_version: 1, type: "stage_start" as const, stage: "review", at: "2026-09-06T00:00:00Z" };
  assert.equal(await appendEvent(runDir, event, store), true);
  assert.equal(observed.length, 1);
  store.eventSink = async () => {};
  store.eventSinkMode = "exclusive";
  assert.equal(await appendEvent(runDir, event, store), true);
  assert.equal(observed.length, 2);
  store.observabilitySink = async () => { throw new Error("offline"); };
  assert.equal(await appendEvent(runDir, event, store), true);
});

test("same-clock stage attempts have distinct lifecycle IDs", async () => {
  const { deps, files } = fixture();
  const sink = createLifecycleObservationSink(enabledConfig, deps);
  const start = { schema_version: 1, type: "stage_start" as const, stage: "review", at: "2026-09-06T00:00:00Z" };
  await sink(runDir, start);
  await sink(runDir, { ...start, type: "stage_complete", outcome: "waiting" });
  await sink(runDir, start);
  const events = [...files].filter(([p]) => p.includes("/inbox/")).map(([, v]) => JSON.parse(v));
  assert.equal(events.length, 3);
  assert.notEqual(events[0].metadata.attempt_id, events[2].metadata.attempt_id);
});
