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
