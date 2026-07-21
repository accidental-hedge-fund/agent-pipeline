// Unit tests for external stage executor dispatch (#314): resolution,
// preflight (before-stage), and HTTP dispatch (agent-system / model-endpoint).
// No real network calls — every test injects a fake `fetchImpl`, including a
// throwing fake that proves the unreachable-provider path fails without a live
// network dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  invokeExternalExecutor,
  invokeStageExecutor,
  preflightExecutor,
  resolveStageExecutor,
} from "../scripts/executors.ts";
import {
  EXECUTION_ENVIRONMENT_STAGES,
  MODEL_INVOKING_STAGES,
  PROMPT_CONTAINED_STAGES,
  STAGES,
} from "../scripts/types.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Stage-set invariants (#314 task 2.4) — types are stripped at runtime, so the
// single-sourced relationship between MODEL_INVOKING_STAGES,
// EXECUTION_ENVIRONMENT_STAGES, and PROMPT_CONTAINED_STAGES must be backed by
// a real runtime assertion, not just TypeScript's structural check.
// ---------------------------------------------------------------------------

test("stage sets (#314): EXECUTION_ENVIRONMENT_STAGES ∪ PROMPT_CONTAINED_STAGES exactly equals MODEL_INVOKING_STAGES, disjoint", () => {
  const union = new Set([...EXECUTION_ENVIRONMENT_STAGES, ...PROMPT_CONTAINED_STAGES]);
  assert.deepEqual(union, new Set(MODEL_INVOKING_STAGES));
  const overlap = EXECUTION_ENVIRONMENT_STAGES.filter((s) => (PROMPT_CONTAINED_STAGES as readonly string[]).includes(s));
  assert.deepEqual(overlap, [], "no stage may be both execution-environment and prompt-contained");
});

test("stage sets (#314): every MODEL_INVOKING_STAGES entry is a canonical Stage from types.ts STAGES", () => {
  const stageSet = new Set(STAGES);
  for (const stage of MODEL_INVOKING_STAGES) {
    assert.ok(stageSet.has(stage), `"${stage}" must be a canonical Stage`);
  }
});

function baseCfg(overrides: Partial<Pick<PipelineConfig, "executors" | "stage_executors">> = {}) {
  return {
    executors: {
      "opencode-main": {
        type: "agent-system" as const,
        provider: "opencode",
        endpoint: "https://opencode.internal/api",
        credential: "OPENCODE_API_KEY",
      },
      "local-ollama": {
        type: "model-endpoint" as const,
        base_url: "http://localhost:11434/v1",
        model: "llama3.1:70b",
      },
      "openrouter-review": {
        type: "model-endpoint" as const,
        base_url: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5",
        credential: "OPENROUTER_API_KEY",
        dialect: "openrouter" as const,
        params: { temperature: 0, seed: 7, provider: { order: ["openai"] }, models: ["openai/gpt-5"] },
        headers: { "x-title": "pipeline-eval", "http-referer": { env: "OPENROUTER_REFERER" } },
        reasoning: { effort: "high" },
        structured_output: true,
      },
      "none-dialect": {
        type: "model-endpoint" as const,
        base_url: "http://localhost:11434/v1",
        model: "llama3",
        dialect: "none" as const,
      },
    },
    stage_executors: { planning: "opencode-main", "review-1": "local-ollama" },
    ...overrides,
  } as unknown as PipelineConfig;
}

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// ---------------------------------------------------------------------------
// resolveStageExecutor — resolution + parity
// ---------------------------------------------------------------------------

test("resolveStageExecutor: returns the assigned definition for a configured stage", () => {
  const a = resolveStageExecutor(baseCfg(), "planning");
  assert.equal(a?.name, "opencode-main");
  assert.equal(a?.definition.type, "agent-system");
});

test("resolveStageExecutor: unassigned stage → null (local harness, unchanged)", () => {
  assert.equal(resolveStageExecutor(baseCfg(), "implementing"), null);
});

test("resolveStageExecutor: absent executors/stage_executors keys (pre-#314 fixture) → null, does not throw", () => {
  assert.equal(resolveStageExecutor({} as PipelineConfig, "planning"), null);
});

// ---------------------------------------------------------------------------
// preflightExecutor — before-stage: credential presence + reachability
// ---------------------------------------------------------------------------

test("preflightExecutor: credential declared but env var unset → fails, names stage + executor", async () => {
  delete process.env.OPENCODE_API_KEY;
  const a = resolveStageExecutor(baseCfg(), "planning")!;
  const result = await preflightExecutor("planning", a, { fetchImpl: (async () => fakeResponse({})) as unknown as typeof fetch });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /opencode-main/);
    assert.match(result.message, /planning/);
    assert.match(result.message, /OPENCODE_API_KEY/);
  }
});

test("preflightExecutor: credential present + endpoint reachable → ok", async () => {
  process.env.OPENCODE_API_KEY = "test-value";
  try {
    const a = resolveStageExecutor(baseCfg(), "planning")!;
    const result = await preflightExecutor("planning", a, { fetchImpl: (async () => fakeResponse({})) as unknown as typeof fetch });
    assert.deepEqual(result, { ok: true });
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
});

test("preflightExecutor: no credential declared (localhost endpoint) → ok without any env var", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  assert.equal(a.definition.credential, undefined);
  const result = await preflightExecutor("review-1", a, { fetchImpl: (async () => fakeResponse({})) as unknown as typeof fetch });
  assert.deepEqual(result, { ok: true });
});

test("preflightExecutor: unreachable provider (fetch throws) → fails, no real network dependency", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  const throwingFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await preflightExecutor("review-1", a, { fetchImpl: throwingFetch });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /local-ollama/);
    assert.match(result.message, /review-1/);
    assert.match(result.message, /ECONNREFUSED/);
  }
});

// ---------------------------------------------------------------------------
// invokeExternalExecutor — agent-system + model-endpoint dispatch branches
// ---------------------------------------------------------------------------

test("invokeExternalExecutor: agent-system branch POSTs {stage, prompt}, Bearer header, maps {output} to stdout", async () => {
  process.env.OPENCODE_API_KEY = "super-secret-value";
  try {
    const a = resolveStageExecutor(baseCfg(), "planning")!;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return fakeResponse({ output: "the plan text" });
    }) as unknown as typeof fetch;
    const result = await invokeExternalExecutor("planning", a, "PROMPT TEXT", { timeoutSec: 5 }, { fetchImpl });
    assert.equal(capturedUrl, "https://opencode.internal/api");
    assert.equal((capturedInit!.headers as Record<string, string>).authorization, "Bearer super-secret-value");
    const body = JSON.parse(capturedInit!.body as string);
    assert.deepEqual(body, { stage: "planning", prompt: "PROMPT TEXT" });
    assert.equal(result.success, true);
    assert.equal(result.stdout, "the plan text");
    assert.equal(result.executor_name, "opencode-main");
    assert.equal(result.executor_provider, "opencode");
    // The credential VALUE must never leak into the returned result.
    assert.ok(!JSON.stringify(result).includes("super-secret-value"));
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
});

test("invokeExternalExecutor: model-endpoint branch POSTs OpenAI chat/completions, maps choices[0].message.content", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  let capturedUrl = "";
  const fetchImpl = (async (url: string | URL) => {
    capturedUrl = String(url);
    return fakeResponse({ choices: [{ message: { content: '{"verdict":"approve","summary":"x","findings":[],"next_steps":[]}' } }] });
  }) as unknown as typeof fetch;
  const result = await invokeExternalExecutor("review-1", a, "REVIEW PROMPT", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(capturedUrl, "http://localhost:11434/v1/chat/completions");
  assert.equal(result.success, true);
  assert.match(result.stdout, /"verdict":"approve"/);
  assert.equal(result.executor_model, "llama3.1:70b");
});

test("invokeExternalExecutor: non-2xx response → success:false, names the executor and stage", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  const fetchImpl = (async () => fakeResponse({}, 500)) as unknown as typeof fetch;
  const result = await invokeExternalExecutor("review-1", a, "x", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(result.success, false);
  assert.match(result.stderr, /local-ollama/);
  assert.match(result.stderr, /HTTP 500/);
});

test("invokeExternalExecutor: response missing the contract-required field → treated as contract violation (success:false)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  const fetchImpl = (async () => fakeResponse({ unexpected: true })) as unknown as typeof fetch;
  const result = await invokeExternalExecutor("review-1", a, "x", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(result.success, false);
  assert.match(result.stderr, /does not match the expected contract/);
});

// ---------------------------------------------------------------------------
// invokeStageExecutor — top-level entry point: null when unassigned, preflight
// gate before dispatch, no silent fallback
// ---------------------------------------------------------------------------

test("invokeStageExecutor: no stage_executors assignment → null (caller falls back to local harness)", async () => {
  const cfg = baseCfg();
  const neverCalled = (async () => {
    throw new Error("must not be called — no assignment for this stage");
  }) as unknown as typeof fetch;
  const result = await invokeStageExecutor("implementing", cfg, "x", { timeoutSec: 5 }, { fetchImpl: neverCalled });
  assert.equal(result, null);
});

test("invokeStageExecutor: preflight failure blocks before dispatch — never sends the prompt request", async () => {
  const cfg = baseCfg();
  let dispatchCalls = 0;
  const fetchImpl = (async (url: string | URL) => {
    dispatchCalls++;
    if (String(url) === "http://localhost:11434/v1") throw new Error("ECONNREFUSED"); // preflight probe
    return fakeResponse({ choices: [{ message: { content: "should not reach here" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeStageExecutor("review-1", cfg, "x", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(result!.success, false);
  assert.match(result!.stderr, /local-ollama/);
  assert.match(result!.stderr, /review-1/);
  assert.equal(dispatchCalls, 1, "only the preflight probe ran — the dispatch POST never fired");
});

test("invokeStageExecutor: successful preflight → dispatches and returns the mapped result", async () => {
  const cfg = baseCfg();
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (!init) return fakeResponse({}); // preflight GET probe
    return fakeResponse({ choices: [{ message: { content: "verdict text" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeStageExecutor("review-1", cfg, "x", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(result!.success, true);
  assert.equal(result!.stdout, "verdict text");
});

// ---------------------------------------------------------------------------
// Evidence — accounting record carries executor/provider/model, never a secret
// ---------------------------------------------------------------------------

test("invokeExternalExecutor: accounting emits executor evidence and never the credential value", async () => {
  process.env.OPENCODE_API_KEY = "super-secret-value";
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "executor-evidence-"));
  try {
    const { initRunDir } = await import("../scripts/run-store.ts");
    const runDir = path.join(tmp, "42-2026-01-01T00-00-00-000Z");
    await initRunDir({
      runDir,
      runId: "42-2026-01-01T00-00-00-000Z",
      issue: 42,
      repo: "acme/widgets",
      profile: null,
      startedAt: new Date().toISOString(),
    });

    const a = resolveStageExecutor(baseCfg(), "planning")!;
    const fetchImpl = (async () => fakeResponse({ output: "plan text" })) as unknown as typeof fetch;
    await invokeExternalExecutor(
      "planning",
      a,
      "prompt",
      { timeoutSec: 5, accounting: { runDir, issue: 42, stage: "planning", modelSlot: "planning" } },
      { fetchImpl },
    );

    const eventsRaw = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    assert.ok(!eventsRaw.includes("super-secret-value"), "credential value must never appear in run evidence");
    const accountingLine = eventsRaw.split("\n").find((l) => l.includes("stage_accounting"));
    assert.ok(accountingLine, "a stage_accounting event was emitted");
    const parsed = JSON.parse(accountingLine!);
    assert.equal(parsed.harness, "opencode-main");
    assert.equal(parsed.executor_provider, "opencode");
  } finally {
    delete process.env.OPENCODE_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #434 api-executor-request-controls — dialect-aware request construction
// ---------------------------------------------------------------------------

function assignmentFor(name: string) {
  return { name, definition: baseCfg().executors[name] } as ReturnType<typeof resolveStageExecutor> & object;
}

test("invokeExternalExecutor: no params/dialect declared → byte-identical to the pre-#434 minimal request", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  let captured: unknown;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  assert.deepEqual(captured, { model: "llama3.1:70b", messages: [{ role: "user", content: "PROMPT" }] });
});

test("invokeExternalExecutor: openrouter dialect sends allowlisted params, reasoning, structured output and headers (#434)", async () => {
  process.env.OPENROUTER_API_KEY = "or-secret";
  process.env.OPENROUTER_REFERER = "https://pipeline.internal";
  try {
    const a = assignmentFor("openrouter-review");
    let captured: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      captured = JSON.parse(init!.body as string);
      capturedHeaders = init!.headers as Record<string, string>;
      return fakeResponse({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const result = await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
    assert.equal(result.success, true);
    const body = captured as Record<string, unknown>;
    assert.equal(body.model, "openai/gpt-5");
    assert.equal(body.temperature, 0);
    assert.equal(body.seed, 7);
    assert.deepEqual(body.provider, { order: ["openai"] });
    assert.deepEqual(body.models, ["openai/gpt-5"]);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.ok(body.response_format, "structured_output should add a response_format field");
    assert.equal(capturedHeaders?.["x-title"], "pipeline-eval");
    assert.equal(capturedHeaders?.["http-referer"], "https://pipeline.internal");
    assert.equal(capturedHeaders?.["X-OpenRouter-Metadata"], "enabled");
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_REFERER;
  }
});

test("invokeExternalExecutor: openai dialect encodes effort via reasoning_effort (#434)", async () => {
  const cfg = baseCfg({
    executors: {
      ...baseCfg().executors,
      "openai-review": {
        type: "model-endpoint" as const,
        base_url: "https://api.openai.com/v1",
        model: "gpt-5",
        reasoning: { effort: "medium" },
      },
    },
  });
  const assignment = { name: "openai-review", definition: cfg.executors["openai-review"] };
  let captured: unknown;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  await invokeExternalExecutor("review-1", assignment, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  assert.equal((captured as Record<string, unknown>).reasoning_effort, "medium");
});

test("invokeExternalExecutor: dialect 'none' with an unsupported effort and no opt-in fails preflight, no HTTP request issued (#434)", async () => {
  const a = assignmentFor("none-dialect");
  let dispatched = false;
  const fetchImpl = (async () => {
    dispatched = true;
    return fakeResponse({});
  }) as unknown as typeof fetch;
  const preflight = await preflightExecutor("review-1", a, { fetchImpl }, { effort: "high" });
  assert.equal(preflight.ok, false);
  if (!preflight.ok) {
    assert.match(preflight.message, /none-dialect/);
    assert.match(preflight.message, /review-1/);
    assert.match(preflight.message, /"none"/);
    assert.match(preflight.message, /high/);
  }
  assert.equal(dispatched, false);
});

test("invokeExternalExecutor: dialect 'none' with on_unsupported: record sends the request without effort and records it unsupported (#434)", async () => {
  const cfg = baseCfg({
    executors: {
      ...baseCfg().executors,
      "none-opt-in": {
        type: "model-endpoint" as const,
        base_url: "http://localhost:11434/v1",
        model: "llama3",
        dialect: "none" as const,
        reasoning: { effort: "high", on_unsupported: "record" as const },
      },
    },
  });
  const assignment = { name: "none-opt-in", definition: cfg.executors["none-opt-in"] };
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeExternalExecutor("review-1", assignment, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(result.success, true);
  assert.ok(!("reasoning" in (captured ?? {})) && !("reasoning_effort" in (captured ?? {})));
  assert.equal(result.executor_provenance?.effort_support, "unsupported");
  assert.equal(result.executor_provenance?.resolved_effort, null);
});

test("preflightExecutor: header referencing an unset env var fails, naming stage, executor, header, and variable (#434)", async () => {
  delete process.env.OPENROUTER_REFERER;
  process.env.OPENROUTER_API_KEY = "or-secret";
  try {
    const a = assignmentFor("openrouter-review");
    const fetchImpl = (async () => fakeResponse({})) as unknown as typeof fetch;
    const result = await preflightExecutor("review-1", a, { fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /openrouter-review/);
      assert.match(result.message, /review-1/);
      assert.match(result.message, /http-referer/);
      assert.match(result.message, /OPENROUTER_REFERER/);
    }
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("invokeExternalExecutor: env-referenced header value never reaches the returned result or its JSON serialization (#434)", async () => {
  process.env.OPENROUTER_API_KEY = "or-secret";
  process.env.OPENROUTER_REFERER = "https://super-secret-referer.internal";
  try {
    const a = assignmentFor("openrouter-review");
    const fetchImpl = (async () => fakeResponse({ choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch;
    const result = await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
    assert.ok(!JSON.stringify(result).includes("https://super-secret-referer.internal"));
    assert.ok(!JSON.stringify(result).includes("or-secret"));
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_REFERER;
  }
});

// ---------------------------------------------------------------------------
// #434 task 3 — per-invocation override seam
// ---------------------------------------------------------------------------

test("invokeExternalExecutor: a model override reaches the request; committed config object is untouched (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl }, { model: "llama3.1:8b" });
  assert.equal(captured?.model, "llama3.1:8b");
  assert.equal(a.definition.model, "llama3.1:70b", "committed definition object must be unmodified");
});

test("invokeExternalExecutor: no override → parity with the committed definition (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    captured = JSON.parse(init!.body as string);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(captured?.model, "llama3.1:70b");
});

test("invokeExternalExecutor: an invalid override (unknown param key) is rejected with no HTTP request issued (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  let dispatched = false;
  const fetchImpl = (async () => {
    dispatched = true;
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeExternalExecutor(
    "review-1",
    a,
    "PROMPT",
    { timeoutSec: 5 },
    { fetchImpl },
    { params: { temperatur: 0 } as unknown as Record<string, unknown> },
  );
  assert.equal(result.success, false);
  assert.match(result.stderr, /temperatur/);
  assert.equal(dispatched, false);
});

test("invokeExternalExecutor: an OpenRouter-only routing override on a non-openrouter dialect is rejected, no HTTP request issued (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!; // local-ollama has no dialect → default "openai"
  let dispatched = false;
  const fetchImpl = (async () => {
    dispatched = true;
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeExternalExecutor(
    "review-1",
    a,
    "PROMPT",
    { timeoutSec: 5 },
    { fetchImpl },
    { params: { provider: { order: ["openai"] } } },
  );
  assert.equal(result.success, false);
  assert.match(result.stderr, /provider/);
  assert.equal(dispatched, false);
});

test("invokeExternalExecutor: a malformed provider-routing override (wrong field type) is rejected, no HTTP request issued (#434)", async () => {
  const a = assignmentFor("openrouter-review");
  let dispatched = false;
  const fetchImpl = (async () => {
    dispatched = true;
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeExternalExecutor(
    "review-1",
    a,
    "PROMPT",
    { timeoutSec: 5 },
    { fetchImpl },
    { params: { provider: { order: "openai" } as unknown as Record<string, unknown> } },
  );
  assert.equal(result.success, false);
  assert.match(result.stderr, /order/);
  assert.equal(dispatched, false);
});

test("invokeExternalExecutor: two concurrent invocations with different model overrides do not interfere (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  const capturedModels: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    capturedModels.push(body.model);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  await Promise.all([
    invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl }, { model: "model-a" }),
    invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl }, { model: "model-b" }),
  ]);
  assert.deepEqual(new Set(capturedModels), new Set(["model-a", "model-b"]));
});

// ---------------------------------------------------------------------------
// #434 task 4 — response provenance capture
// ---------------------------------------------------------------------------

test("invokeExternalExecutor: OpenRouter-shaped response provenance is captured verbatim (#434)", async () => {
  process.env.OPENROUTER_API_KEY = "or-secret";
  process.env.OPENROUTER_REFERER = "ref";
  try {
    const a = assignmentFor("openrouter-review");
    let sentHeaders: Headers | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init!.headers);
      return fakeResponse({
        id: "gen-abc123",
        model: "openai/gpt-5-2026-01-01",
        choices: [{ message: { content: '{"verdict":"approve","summary":"x","findings":[],"next_steps":[]}' }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cost: 0.0042,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
        // OpenRouter's documented router-metadata shape
        // (https://openrouter.ai/docs/guides/features/router-metadata),
        // opted into via the `X-OpenRouter-Metadata: enabled` request header —
        // NOT a top-level `provider` field, which chat/completions responses
        // never carry.
        openrouter_metadata: {
          requested: "openai/gpt-5",
          endpoints: { available: [{ provider: "OpenAI", model: "openai/gpt-5-2026-01-01", selected: true }] },
        },
      });
    }) as unknown as typeof fetch;
    const result = await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
    assert.equal(sentHeaders?.get("x-openrouter-metadata"), "enabled");
    const prov = result.executor_provenance!;
    assert.equal(prov.requested_model, "openai/gpt-5");
    assert.equal(prov.resolved_model, "openai/gpt-5-2026-01-01");
    assert.equal(prov.upstream_provider, "OpenAI");
    assert.equal(prov.request_id, "gen-abc123");
    assert.equal(prov.finish_reason, "stop");
    assert.equal(prov.cost_usd, 0.0042);
    assert.equal(prov.usage?.prompt_tokens, 100);
    assert.equal(prov.usage?.completion_tokens, 50);
    assert.equal(prov.usage?.cached_input_tokens, 20);
    assert.equal(prov.usage?.reasoning_tokens, 10);
    assert.ok(typeof prov.duration_ms === "number");
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_REFERER;
  }
});

test("invokeExternalExecutor: openrouter_metadata with no selected endpoint records a null provider, never guessed (#434)", async () => {
  const a = assignmentFor("openrouter-review");
  process.env.OPENROUTER_API_KEY = "or-secret";
  process.env.OPENROUTER_REFERER = "ref";
  try {
    const fetchImpl = (async () =>
      fakeResponse({
        id: "gen-1",
        model: "openai/gpt-5",
        choices: [{ message: { content: '{"verdict":"approve","summary":"x","findings":[],"next_steps":[]}' } }],
        openrouter_metadata: { requested: "openai/gpt-5", endpoints: { available: [] } },
      })) as unknown as typeof fetch;
    const result = await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
    assert.equal(result.executor_provenance?.upstream_provider, null);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_REFERER;
  }
});

test("invokeExternalExecutor: the openai dialect does not send the OpenRouter metadata opt-in header (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!; // local-ollama has no dialect → default "openai"
  let sentHeaders: Headers | undefined;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    sentHeaders = new Headers(init!.headers);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  assert.equal(sentHeaders?.get("x-openrouter-metadata"), null);
});

test("invokeExternalExecutor: generic OpenAI-compatible response provenance is captured (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  const fetchImpl = (async () =>
    fakeResponse({
      id: "chatcmpl-xyz",
      model: "llama3.1:70b",
      choices: [{ message: { content: "verdict text" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })) as unknown as typeof fetch;
  const result = await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  const prov = result.executor_provenance!;
  assert.equal(prov.request_id, "chatcmpl-xyz");
  assert.equal(prov.resolved_model, "llama3.1:70b");
  assert.equal(prov.upstream_provider, null, "generic OpenAI-compatible responses report no provider field");
  assert.equal(prov.finish_reason, "stop");
  assert.equal(prov.cost_usd, null, "no cost field reported");
  assert.equal(prov.usage?.prompt_tokens, 10);
});

test("invokeExternalExecutor: response with no provider/usage/cost records null, never derived from the model slug (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  const fetchImpl = (async () =>
    fakeResponse({
      choices: [{ message: { content: "verdict text" } }],
    })) as unknown as typeof fetch;
  const result = await invokeExternalExecutor("review-1", a, "PROMPT", { timeoutSec: 5 }, { fetchImpl });
  const prov = result.executor_provenance!;
  assert.equal(prov.upstream_provider, null);
  assert.equal(prov.resolved_model, null);
  assert.equal(prov.cost_usd, null);
  assert.equal(prov.usage, null);
  assert.equal(prov.finish_reason, null);
});

test("invokeExternalExecutor: rate-limit (429) is retried and observed in provenance (#434)", async () => {
  const a = resolveStageExecutor(baseCfg(), "review-1")!;
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return fakeResponse({}, 429);
    return fakeResponse({ choices: [{ message: { content: "ok" } }] });
  }) as unknown as typeof fetch;
  const result = await invokeExternalExecutor(
    "review-1",
    a,
    "PROMPT",
    { timeoutSec: 5 },
    { fetchImpl, sleepImpl: async () => {} },
  );
  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.equal(result.executor_provenance?.retry_count, 1);
  assert.equal(result.executor_provenance?.rate_limited, true);
});

test("invokeExternalExecutor: model-endpoint request payload is recorded in accounting evidence with headers by name only, never a resolved secret (#434)", async () => {
  process.env.OPENROUTER_API_KEY = "or-secret-value";
  process.env.OPENROUTER_REFERER = "https://super-secret-referer.internal";
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "executor-provenance-"));
  try {
    const { initRunDir } = await import("../scripts/run-store.ts");
    const runDir = path.join(tmp, "43-2026-01-01T00-00-00-000Z");
    await initRunDir({
      runDir,
      runId: "43-2026-01-01T00-00-00-000Z",
      issue: 43,
      repo: "acme/widgets",
      profile: null,
      startedAt: new Date().toISOString(),
    });

    const a = assignmentFor("openrouter-review");
    const fetchImpl = (async () =>
      fakeResponse({
        id: "gen-1",
        model: "openai/gpt-5",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
        openrouter_metadata: { endpoints: { available: [{ provider: "OpenAI", selected: true }] } },
      })) as unknown as typeof fetch;
    await invokeExternalExecutor(
      "review-1",
      a,
      "prompt",
      { timeoutSec: 5, accounting: { runDir, issue: 43, stage: "review-1", modelSlot: "review" } },
      { fetchImpl },
    );

    const eventsRaw = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    assert.ok(!eventsRaw.includes("or-secret-value"));
    assert.ok(!eventsRaw.includes("https://super-secret-referer.internal"));
    const accountingLine = eventsRaw.split("\n").find((l) => l.includes("stage_accounting"));
    const parsed = JSON.parse(accountingLine!);
    assert.equal(parsed.provider_auth_class, "api-key:model-endpoint");
    assert.equal(parsed.upstream_provider, "OpenAI");
    assert.equal(parsed.request_id, "gen-1");
    assert.equal(parsed.cost_source, "actual");
    assert.equal(parsed.request_payload.headers["http-referer"], "env:OPENROUTER_REFERER");
    assert.equal(parsed.request_payload.headers["x-title"], "pipeline-eval");
    assert.equal(parsed.request_payload.headers["X-OpenRouter-Metadata"], "enabled");
    assert.deepEqual(parsed.request_payload.messages, [{ role: "user", content: "prompt" }]);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_REFERER;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
