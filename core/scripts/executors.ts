// External stage executor dispatch (#314): delegates a model-invoking stage to
// a named `agent-system` provider or `model-endpoint` (raw OpenAI-compatible
// chat/completions endpoint) instead of the local claude/codex harness.
//
// Config-parse-time validation (unknown executor name, model-endpoint assigned
// to an execution-environment stage) lives in config.ts — by the time a
// PipelineConfig reaches this module, `cfg.stage_executors` is known-valid.
//
// Two-phase safety, matching the design doc:
//   1. Before the stage runs: `preflightExecutor` checks credential-env-var
//      presence and endpoint reachability. Failure blocks the item with a
//      named stage+provider error — no fallback to a local harness.
//   2. After invocation: the stage's EXISTING outcome-contract path
//      (parseStructuredVerdict + review-policy for review stages) runs on
//      whatever the executor returned, unchanged. This module does not (and
//      cannot) preflight contract compliance — there is no dry-run mode.
//
// Credentials are resolved from the environment at invocation time only and
// are never written to any returned value, log line, or error message — only
// the reference NAME ever appears there (#314 "secrets never in evidence").

import * as path from "node:path";
import type { ExecutorDefinition, ModelInvokingStage, PipelineConfig } from "./types.ts";
import type { HarnessResult } from "./harness.ts";
import type { RunStoreDeps } from "./run-store.ts";
import { buildStageAccountingRecord } from "./accounting.ts";
import { emitStageAccounting } from "./run-store.ts";

export interface ExecutorAssignment {
  name: string;
  definition: ExecutorDefinition;
}

/** Injectable HTTP seam — tests supply a fake so no real network call is ever
 *  made. Defaults to the global `fetch` at call time. */
export interface ExecutorHttpDeps {
  fetchImpl?: typeof fetch;
}

/** Resolve the executor assigned to `stage` in `cfg`, or `null` when no
 *  assignment exists (caller falls back to the local harness — unchanged). */
export function resolveStageExecutor(
  cfg: Pick<PipelineConfig, "stage_executors" | "executors">,
  stage: ModelInvokingStage,
): ExecutorAssignment | null {
  // Defensive optional-chaining, not just a type formality: many existing unit
  // tests build a `PipelineConfig` fixture by hand (predating #314) without
  // these two keys — `resolveConfig()` always sets them to `{}` at minimum, but
  // this function must not crash on a fixture that omits them (parity: an
  // absent block behaves exactly like an empty one).
  const name = cfg.stage_executors?.[stage];
  if (!name) return null;
  const definition = cfg.executors?.[name];
  // Unreachable in practice — config.ts rejects an unknown reference at parse
  // time — but a missing definition here is treated as "no executor" rather
  // than crashing a running pipeline over a defensive gap.
  if (!definition) return null;
  return { name, definition };
}

function providerLabel(definition: ExecutorDefinition): string {
  return definition.type === "agent-system" ? definition.provider : definition.base_url;
}

/** Read the credential value from the environment. Returns undefined when the
 *  definition declares no credential. Never logged, returned in an error
 *  message, or otherwise persisted — only used to build the Authorization
 *  header for the outbound request. */
function resolveCredentialValue(definition: ExecutorDefinition): string | undefined {
  if (!definition.credential) return undefined;
  return process.env[definition.credential] || undefined;
}

export type PreflightResult = { ok: true } | { ok: false; message: string };

const PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * Before-stage preflight (#314): credential-env-var presence + endpoint
 * reachability. Does NOT validate outcome-contract compliance (verdict shape,
 * etc.) — that is enforced after invocation by the stage's existing path.
 */
export async function preflightExecutor(
  stage: ModelInvokingStage,
  assignment: ExecutorAssignment,
  deps: ExecutorHttpDeps = {},
): Promise<PreflightResult> {
  const { name, definition } = assignment;
  if (definition.credential && !process.env[definition.credential]) {
    return {
      ok: false,
      message:
        `executor "${name}" for stage "${stage}" declares credential "${definition.credential}" ` +
        `but that environment variable is not set`,
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const probeUrl = definition.type === "agent-system" ? definition.endpoint : definition.base_url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    // Any response — even a 404/405 for a POST-only endpoint — proves the
    // provider is reachable. Only a thrown network-level error means unreachable.
    await fetchImpl(probeUrl, { method: "GET", signal: controller.signal });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `executor "${name}" (provider "${providerLabel(definition)}") for stage "${stage}" is unreachable: ${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true };
}

export interface InvokeExecutorOptions {
  timeoutSec: number;
  accounting?: {
    runDir: string;
    runStoreDeps?: RunStoreDeps;
    issue: number;
    stage: string;
    modelSlot?: string | null;
    commandCount?: number;
    subprocessCount?: number;
    promptChars?: number;
  };
}

function toHarnessResult(
  name: string,
  definition: ExecutorDefinition,
  partial: Omit<HarnessResult, "executor_name" | "executor_provider" | "executor_model">,
): HarnessResult {
  return {
    ...partial,
    executor_name: name,
    executor_provider: providerLabel(definition),
    ...(definition.type === "model-endpoint" ? { executor_model: definition.model } : {}),
  };
}

/**
 * Dispatch `prompt` to the assigned executor over HTTP and map the result onto
 * the same `HarnessResult` contract a local CLI invocation returns, so
 * downstream stage code (including `parseStructuredVerdict` for review
 * stages) is unchanged. Never throws — network/HTTP failures come back as
 * `success: false` results, exactly like a local harness failure.
 */
export async function invokeExternalExecutor(
  stage: ModelInvokingStage,
  assignment: ExecutorAssignment,
  prompt: string,
  opts: InvokeExecutorOptions,
  deps: ExecutorHttpDeps = {},
): Promise<HarnessResult> {
  const { name, definition } = assignment;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const credential = resolveCredentialValue(definition);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;

  let url: string;
  let body: unknown;
  if (definition.type === "agent-system") {
    url = definition.endpoint;
    body = { stage, prompt };
  } else {
    url = `${definition.base_url.replace(/\/+$/, "")}/chat/completions`;
    body = { model: definition.model, messages: [{ role: "user", content: prompt }] };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutSec * 1000);
  let result: HarnessResult;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const duration = (Date.now() - started) / 1000;
    if (!res.ok) {
      result = toHarnessResult(name, definition, {
        success: false,
        stdout: "",
        stderr: `executor "${name}" for stage "${stage}" returned HTTP ${res.status}`,
        exit_code: res.status,
        duration,
        timed_out: false,
      });
    } else {
      const json: unknown = await res.json();
      const stdout = extractStdout(definition, json);
      result =
        stdout === null
          ? toHarnessResult(name, definition, {
              success: false,
              stdout: "",
              stderr: `executor "${name}" for stage "${stage}" returned a response that does not match the expected contract`,
              exit_code: -1,
              duration,
              timed_out: false,
            })
          : toHarnessResult(name, definition, {
              success: true,
              stdout,
              stderr: "",
              exit_code: 0,
              duration,
              timed_out: false,
            });
    }
  } catch (err) {
    const duration = (Date.now() - started) / 1000;
    const timedOut = err instanceof Error && err.name === "AbortError";
    const reason = err instanceof Error ? err.message : String(err);
    result = toHarnessResult(name, definition, {
      success: false,
      stdout: "",
      stderr: `executor "${name}" for stage "${stage}" request failed: ${reason}`,
      exit_code: -1,
      duration,
      timed_out: timedOut,
    });
  } finally {
    clearTimeout(timer);
  }

  if (opts.accounting) {
    const record = buildStageAccountingRecord({
      runId: path.basename(opts.accounting.runDir),
      issue: opts.accounting.issue,
      stage: opts.accounting.stage,
      harness: name,
      modelSlot: opts.accounting.modelSlot ?? null,
      model: definition.type === "model-endpoint" ? definition.model : null,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: result.duration * 1000,
      commandCount: opts.accounting.commandCount ?? 1,
      subprocessCount: opts.accounting.subprocessCount ?? 1,
      outcome: result.success ? "success" : result.timed_out ? "timeout" : "failure",
      blockerKind: result.success ? null : "harness-failure",
      promptChars: opts.accounting.promptChars ?? prompt.length,
      promptEstimatedTokens: Math.ceil(prompt.length / 4),
      executorProvider: providerLabel(definition),
      executorModel: definition.type === "model-endpoint" ? definition.model : null,
    });
    await emitStageAccounting(opts.accounting.runDir, record, opts.accounting.runStoreDeps).catch(() => {});
  }

  return result;
}

/** Extract the stdout-equivalent text per the definition's response contract.
 *  Returns null when the response does not match the expected shape — treated
 *  as a contract violation by the caller. */
function extractStdout(definition: ExecutorDefinition, json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (definition.type === "agent-system") {
    return typeof obj.output === "string" ? obj.output : null;
  }
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : null;
}

/**
 * Top-level entry point for a stage call site: resolves the assignment,
 * preflights it, and dispatches — or returns `null` when no `stage_executors`
 * assignment exists, signalling the caller to proceed with the local harness
 * exactly as today. A preflight failure returns a failed `HarnessResult` (never
 * throws), naming the stage and provider, with no local-harness fallback.
 */
export async function invokeStageExecutor(
  stage: ModelInvokingStage,
  cfg: Pick<PipelineConfig, "stage_executors" | "executors">,
  prompt: string,
  opts: InvokeExecutorOptions,
  deps: ExecutorHttpDeps = {},
): Promise<HarnessResult | null> {
  const assignment = resolveStageExecutor(cfg, stage);
  if (!assignment) return null;

  const preflight = await preflightExecutor(stage, assignment, deps);
  if (!preflight.ok) {
    return toHarnessResult(assignment.name, assignment.definition, {
      success: false,
      stdout: "",
      stderr: preflight.message,
      exit_code: -1,
      duration: 0,
      timed_out: false,
    });
  }

  return invokeExternalExecutor(stage, assignment, prompt, opts, deps);
}
