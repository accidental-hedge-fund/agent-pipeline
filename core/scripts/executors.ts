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
//      presence, endpoint reachability, header/override validity, and
//      reasoning-effort expressibility (#434). Failure blocks the item with a
//      named stage+provider error — no fallback to a local harness.
//   2. After invocation: the stage's EXISTING outcome-contract path
//      (parseStructuredVerdict + review-policy for review stages) runs on
//      whatever the executor returned, unchanged. This module does not (and
//      cannot) preflight contract compliance — there is no dry-run mode.
//
// Credentials are resolved from the environment at invocation time only and
// are never written to any returned value, log line, or error message — only
// the reference NAME ever appears there (#314 "secrets never in evidence").
//
// #434 (api-executor-experiment-controls) extends the model-endpoint path with
// a declared wire dialect, an allowlisted params block, provider-aware
// reasoning/effort, controlled extra headers, a structured-output transport
// hint, a per-invocation override seam, and response provenance capture — see
// openspec/changes/api-executor-experiment-controls/design.md.

import * as path from "node:path";
import type {
  ExecutorDefinition,
  ModelEndpointDialect,
  ModelEndpointExecutorDefinition,
  ModelEndpointOverride,
  ModelEndpointParams,
  ModelEndpointProvenance,
  ModelInvokingStage,
  PipelineConfig,
} from "./types.ts";
import type { HarnessResult } from "./harness.ts";
import type { RunStoreDeps } from "./run-store.ts";
import { buildStageAccountingRecord } from "./accounting.ts";
import { emitStageAccounting } from "./run-store.ts";
import { ModelEndpointParamsSchema, validateModelEndpointDialectRules } from "./config.ts";
import { REVIEW_SCHEMA_FIELDS } from "./review-schema.ts";

export interface ExecutorAssignment {
  name: string;
  definition: ExecutorDefinition;
}

/** Injectable HTTP seam — tests supply a fake so no real network call is ever
 *  made. Defaults to the global `fetch` at call time. `sleepImpl` is the
 *  injectable backoff wait between rate-limit retries (default: a real
 *  `setTimeout`-based sleep); tests inject a no-op so retry tests don't
 *  actually wait. */
export interface ExecutorHttpDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
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

// ---------------------------------------------------------------------------
// #434 model-endpoint request controls
// ---------------------------------------------------------------------------

function resolveDialect(definition: ModelEndpointExecutorDefinition): ModelEndpointDialect {
  return definition.dialect ?? "openai";
}

/** Validate a per-invocation override against the same allowlist/dialect
 *  rules as committed configuration (#434 task 3.2) — reusing config.ts's
 *  schema and dialect-rule function so the two validation paths can never
 *  drift. Returns the first violation found, naming the offending key. */
function validateOverride(
  name: string,
  stage: ModelInvokingStage,
  definition: ModelEndpointExecutorDefinition,
  override: ModelEndpointOverride | undefined,
): PreflightResult {
  if (!override?.params) return { ok: true };
  const parsed = ModelEndpointParamsSchema.safeParse(override.params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path?.join(".") || "<params>";
    return {
      ok: false,
      message:
        `executor "${name}" for stage "${stage}" received an invalid params override: ` +
        `${key}: ${issue?.message ?? "invalid value"}`,
    };
  }
  const dialect = resolveDialect(definition);
  const dialectErrors = validateModelEndpointDialectRules(dialect, override.params, undefined);
  if (dialectErrors.length > 0) {
    return {
      ok: false,
      message: `executor "${name}" for stage "${stage}" received an invalid params override: ${dialectErrors[0]}`,
    };
  }
  return { ok: true };
}

interface MergedModelEndpointRequest {
  model: string;
  params?: ModelEndpointParams;
  effort?: string;
}

/** The committed definition merged with a per-invocation override, computed
 *  in memory (#434 decision 4). Never mutates `definition` or writes to
 *  `.github/pipeline.yml`. */
function mergeOverride(
  definition: ModelEndpointExecutorDefinition,
  override: ModelEndpointOverride | undefined,
): MergedModelEndpointRequest {
  return {
    model: override?.model ?? definition.model,
    params: override?.params ? { ...definition.params, ...override.params } : definition.params,
    effort: override?.effort ?? definition.reasoning?.effort,
  };
}

type EffortOutcome =
  | { kind: "none" }
  | { kind: "encoded"; fragment: Record<string, unknown>; resolvedEffort: string }
  | { kind: "unsupported" }
  | { kind: "fail"; message: string };

/**
 * The reasoning/effort adapter (#434 decision 2): exactly one of three
 * outcomes for a requested effort — encoded in the dialect's wire form,
 * recorded as unsupported (only when the definition explicitly opts in), or
 * a preflight failure (the default when the dialect cannot express it). Never
 * silently drops a requested effort.
 */
function encodeEffort(
  name: string,
  stage: ModelInvokingStage,
  definition: ModelEndpointExecutorDefinition,
  requestedEffort: string | undefined,
): EffortOutcome {
  if (!requestedEffort) return { kind: "none" };
  const dialect = resolveDialect(definition);
  // Verified wire fields (task 4.1): OpenAI's chat/completions API accepts a
  // top-level `reasoning_effort` string for reasoning-capable models;
  // OpenRouter's unified reasoning API accepts a `reasoning: { effort }`
  // object (https://openrouter.ai/docs/use-cases/reasoning-tokens).
  if (dialect === "openai") {
    return { kind: "encoded", fragment: { reasoning_effort: requestedEffort }, resolvedEffort: requestedEffort };
  }
  if (dialect === "openrouter") {
    return { kind: "encoded", fragment: { reasoning: { effort: requestedEffort } }, resolvedEffort: requestedEffort };
  }
  // dialect === "none": a genuinely minimal endpoint that cannot express
  // reasoning effort at all.
  if (definition.reasoning?.on_unsupported === "record") {
    return { kind: "unsupported" };
  }
  return {
    kind: "fail",
    message:
      `executor "${name}" for stage "${stage}" declares dialect "none", which cannot express requested ` +
      `reasoning effort "${requestedEffort}" — set reasoning.on_unsupported: record to run this cell anyway ` +
      `with the effort recorded as unsupported`,
  };
}

type HeaderResolution =
  | { ok: true; headers: Record<string, string>; recorded: Record<string, string> }
  | { ok: false; message: string };

/**
 * Resolve `headers:` (literal or `env:` reference) at invocation time only
 * (#434 decision 6). `recorded` carries header NAMES plus, for an `env:`
 * value, the reference name — never a resolved value — so evidence can be
 * built directly from it without depending on pattern-based redaction.
 */
function resolveHeaders(
  name: string,
  stage: ModelInvokingStage,
  definition: ModelEndpointExecutorDefinition,
): HeaderResolution {
  const headers: Record<string, string> = {};
  const recorded: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(definition.headers ?? {})) {
    if (typeof value === "string") {
      headers[headerName] = value;
      recorded[headerName] = value;
      continue;
    }
    const resolved = process.env[value.env];
    if (!resolved) {
      return {
        ok: false,
        message:
          `executor "${name}" for stage "${stage}" declares header "${headerName}" referencing ` +
          `environment variable "${value.env}", which is not set`,
      };
    }
    headers[headerName] = resolved;
    recorded[headerName] = `env:${value.env}`;
  }
  return { ok: true, headers, recorded };
}

function buildParamsFragment(dialect: ModelEndpointDialect, params: ModelEndpointParams | undefined): Record<string, unknown> {
  if (!params) return {};
  const fragment: Record<string, unknown> = {};
  if (params.temperature !== undefined) fragment.temperature = params.temperature;
  if (params.top_p !== undefined) fragment.top_p = params.top_p;
  if (params.seed !== undefined) fragment.seed = params.seed;
  // Mapped onto the classic, widely-supported `max_tokens` chat/completions
  // field (both OpenAI-compatible dialects accept it) rather than
  // introducing a second output-cap field name.
  if (params.max_output_tokens !== undefined) fragment.max_tokens = params.max_output_tokens;
  if (params.stop !== undefined) fragment.stop = params.stop;
  if (dialect === "openrouter") {
    if (params.provider !== undefined) fragment.provider = params.provider;
    if (params.models !== undefined) fragment.models = params.models;
  }
  return fragment;
}

/** A minimal JSON-schema-shaped object built from the single-sourced verdict
 *  field manifest (review-schema.ts) — a transport hint only (#434 decision
 *  5). The authoritative contract remains `parseStructuredVerdict` +
 *  `review_policy` gating, unchanged by whether this was sent or honored. */
function buildVerdictResponseFormat(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of REVIEW_SCHEMA_FIELDS.verdict) properties[field] = {};
  return {
    type: "json_schema",
    json_schema: {
      name: "review_verdict",
      schema: {
        type: "object",
        properties,
        required: REVIEW_SCHEMA_FIELDS.verdict,
        additionalProperties: true,
      },
    },
  };
}

interface BuiltModelEndpointRequest {
  body: Record<string, unknown>;
  recordedPayload: Record<string, unknown>;
  effortOutcome: EffortOutcome;
  requestedModel: string;
}

/** Build the dialect-aware request body plus a redaction-safe record of what
 *  was sent (#434 tasks 2.1–2.4, 4.3). Returns `{ok:false}` only for the
 *  effort-adapter's preflight-failure outcome — everything else that can go
 *  wrong (override/header validity) is checked by the caller beforehand. */
function buildModelEndpointRequest(
  name: string,
  stage: ModelInvokingStage,
  definition: ModelEndpointExecutorDefinition,
  prompt: string,
  override: ModelEndpointOverride | undefined,
  recordedHeaders: Record<string, string>,
): { ok: true; request: BuiltModelEndpointRequest } | { ok: false; message: string } {
  const dialect = resolveDialect(definition);
  const merged = mergeOverride(definition, override);
  const effortOutcome = encodeEffort(name, stage, definition, merged.effort);
  if (effortOutcome.kind === "fail") return { ok: false, message: effortOutcome.message };

  const paramsFragment = buildParamsFragment(dialect, merged.params);
  const structuredOutputRequested = Boolean(definition.structured_output) && dialect !== "none";
  const effortFragment = effortOutcome.kind === "encoded" ? effortOutcome.fragment : {};

  const body: Record<string, unknown> = {
    model: merged.model,
    messages: [{ role: "user", content: prompt }],
    ...paramsFragment,
    ...effortFragment,
    ...(structuredOutputRequested ? { response_format: buildVerdictResponseFormat() } : {}),
  };

  // The recorded payload reflects exactly what was transmitted after override
  // merging — never the committed configuration — including the sent
  // `messages`, which are redacted for secrets at write time by the existing
  // `sanitizeDeep`/`redactSecrets` pass applied to every accounting record
  // (accounting.ts) (#434 api-executor-response-provenance: "exact sent
  // request payload").
  const recordedPayload: Record<string, unknown> = {
    model: merged.model,
    messages: body.messages,
    ...paramsFragment,
    ...effortFragment,
    ...(structuredOutputRequested ? { response_format: true } : {}),
    ...(Object.keys(recordedHeaders).length > 0 ? { headers: recordedHeaders } : {}),
  };

  return { ok: true, request: { body, recordedPayload, effortOutcome, requestedModel: merged.model } };
}

/**
 * Before-stage preflight (#314, extended by #434): credential-env-var
 * presence, endpoint reachability, override validity, header env-var
 * presence, and reasoning-effort expressibility. Does NOT validate
 * outcome-contract compliance (verdict shape, etc.) — that is enforced after
 * invocation by the stage's existing path.
 */
export async function preflightExecutor(
  stage: ModelInvokingStage,
  assignment: ExecutorAssignment,
  deps: ExecutorHttpDeps = {},
  override?: ModelEndpointOverride,
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

  if (definition.type === "model-endpoint") {
    const overrideResult = validateOverride(name, stage, definition, override);
    if (!overrideResult.ok) return overrideResult;

    const headerResult = resolveHeaders(name, stage, definition);
    if (!headerResult.ok) return headerResult;

    const merged = mergeOverride(definition, override);
    const effortOutcome = encodeEffort(name, stage, definition, merged.effort);
    if (effortOutcome.kind === "fail") return { ok: false, message: effortOutcome.message };
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

/** Read the selected upstream provider out of OpenRouter's documented router
 *  metadata (https://openrouter.ai/docs/guides/features/router-metadata):
 *  opted into via the `X-OpenRouter-Metadata: enabled` request header (sent
 *  for the `openrouter` dialect — see invokeExternalExecutor), surfaced on the
 *  response body as `openrouter_metadata.endpoints.available[]`, the entry
 *  with `selected: true` naming the provider that served the request. Chat
 *  completions responses carry no top-level `provider` field — reading one
 *  would always be `undefined` and defeat provider attribution. Returns
 *  `null` when the metadata is absent (e.g. a non-OpenRouter dialect, or the
 *  endpoint didn't honor the opt-in header) — never guessed from another
 *  field. */
function extractOpenRouterProvider(obj: Record<string, unknown>): string | null {
  const metadata = isRecord(obj.openrouter_metadata) ? obj.openrouter_metadata : undefined;
  const endpoints = metadata && isRecord(metadata.endpoints) ? metadata.endpoints : undefined;
  const available = endpoints && Array.isArray(endpoints.available) ? endpoints.available : [];
  const selected = available.find((entry) => isRecord(entry) && entry.selected === true) as Record<string, unknown> | undefined;
  return selected ? stringOrNull(selected.provider) : null;
}

/** Real HTTP-response fields verified against OpenRouter's and OpenAI's
 *  documented chat/completions response shapes (task 4.1):
 *   - OpenRouter: top-level `id` (request id), `openrouter_metadata` (upstream
 *     provider attribution — see `extractOpenRouterProvider` above), `model`
 *     (resolved model), `choices[0].finish_reason`,
 *     `usage.prompt_tokens`/`completion_tokens`/`total_tokens`, and — only when
 *     the request opts in to `usage: {include: true}` — `usage.cost` plus
 *     `usage.prompt_tokens_details.cached_tokens` /
 *     `usage.completion_tokens_details.reasoning_tokens`.
 *   - Generic OpenAI-compatible: `id`, `model`, `choices[0].finish_reason`,
 *     `usage.prompt_tokens`/`completion_tokens`/`total_tokens` — no router
 *     metadata and no `cost` field, both `null` rather than guessed.
 *  Any field absent from the parsed body stays `null` — never derived from
 *  another field, the model string, or `base_url` (#434 decision 7). */
function extractProvenance(
  requestedModel: string,
  json: unknown,
  effortOutcome: EffortOutcome,
  requestedEffort: string | undefined,
  durationMs: number,
  retryCount: number,
  rateLimited: boolean,
): ModelEndpointProvenance {
  const obj = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const usageObj = isRecord(obj.usage) ? obj.usage : undefined;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const firstChoice = isRecord(choices[0]) ? (choices[0] as Record<string, unknown>) : undefined;

  const promptDetails = usageObj && isRecord(usageObj.prompt_tokens_details) ? usageObj.prompt_tokens_details : undefined;
  const completionDetails = usageObj && isRecord(usageObj.completion_tokens_details) ? usageObj.completion_tokens_details : undefined;

  const usage = usageObj
    ? {
        ...(numberOrUndefined(usageObj.prompt_tokens) !== undefined ? { prompt_tokens: numberOrUndefined(usageObj.prompt_tokens) } : {}),
        ...(numberOrUndefined(usageObj.completion_tokens) !== undefined ? { completion_tokens: numberOrUndefined(usageObj.completion_tokens) } : {}),
        ...(numberOrUndefined(usageObj.total_tokens) !== undefined ? { total_tokens: numberOrUndefined(usageObj.total_tokens) } : {}),
        ...(promptDetails && numberOrUndefined(promptDetails.cached_tokens) !== undefined
          ? { cached_input_tokens: numberOrUndefined(promptDetails.cached_tokens) }
          : {}),
        ...(completionDetails && numberOrUndefined(completionDetails.reasoning_tokens) !== undefined
          ? { reasoning_tokens: numberOrUndefined(completionDetails.reasoning_tokens) }
          : {}),
      }
    : null;

  return {
    requested_model: requestedModel,
    resolved_model: stringOrNull(obj.model),
    // Never derived from `model`'s slug prefix (e.g. "openai/gpt-5") — only
    // from the documented `openrouter_metadata` the endpoint itself reported.
    upstream_provider: extractOpenRouterProvider(obj),
    request_id: stringOrNull(obj.id),
    finish_reason: firstChoice ? stringOrNull(firstChoice.finish_reason) : null,
    usage: usage && Object.keys(usage).length > 0 ? usage : null,
    cost_usd: usageObj ? numberOrNull(usageObj.cost) : null,
    retry_count: retryCount,
    rate_limited: rateLimited || null,
    duration_ms: durationMs,
    requested_effort: requestedEffort ?? null,
    resolved_effort: effortOutcome.kind === "encoded" ? effortOutcome.resolvedEffort : null,
    effort_support: effortOutcome.kind === "encoded" ? "encoded" : effortOutcome.kind === "unsupported" ? "unsupported" : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RETRY_AFTER_MS = 1000;

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: { headers: { get(name: string): string | null } }): number {
  const header = res.headers.get("retry-after");
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

/**
 * Dispatch `prompt` to the assigned executor over HTTP and map the result onto
 * the same `HarnessResult` contract a local CLI invocation returns, so
 * downstream stage code (including `parseStructuredVerdict` for review
 * stages) is unchanged. Never throws — network/HTTP failures come back as
 * `success: false` results, exactly like a local harness failure.
 *
 * `override` (#434) applies a per-invocation model/params/effort override in
 * memory over the committed definition — never written to
 * `.github/pipeline.yml`. Invalid overrides and header/effort preflight
 * failures are all checked before any HTTP request is issued.
 */
export async function invokeExternalExecutor(
  stage: ModelInvokingStage,
  assignment: ExecutorAssignment,
  prompt: string,
  opts: InvokeExecutorOptions,
  deps: ExecutorHttpDeps = {},
  override?: ModelEndpointOverride,
): Promise<HarnessResult> {
  const { name, definition } = assignment;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const credential = resolveCredentialValue(definition);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;

  let url: string;
  let body: unknown;
  let effortOutcome: EffortOutcome = { kind: "none" };
  let requestedModel: string | undefined;
  let requestedEffort: string | undefined;
  let recordedPayload: Record<string, unknown> | undefined;

  if (definition.type === "agent-system") {
    url = definition.endpoint;
    body = { stage, prompt };
  } else {
    if (override) {
      const overrideResult = validateOverride(name, stage, definition, override);
      if (!overrideResult.ok) {
        return toHarnessResult(name, definition, {
          success: false,
          stdout: "",
          stderr: overrideResult.message,
          exit_code: -1,
          duration: 0,
          timed_out: false,
        });
      }
    }
    const headerResult = resolveHeaders(name, stage, definition);
    if (!headerResult.ok) {
      return toHarnessResult(name, definition, {
        success: false,
        stdout: "",
        stderr: headerResult.message,
        exit_code: -1,
        duration: 0,
        timed_out: false,
      });
    }
    Object.assign(headers, headerResult.headers);

    // Opt-in header for OpenRouter's router metadata (task 4.1 fix): without
    // it, `openrouter_metadata` is absent from the response body and
    // `extractOpenRouterProvider` has nothing to read. Recorded alongside the
    // declared headers since it's a fixed, non-secret value sent on every
    // openrouter-dialect request.
    const recordedHeaders = { ...headerResult.recorded };
    if (resolveDialect(definition) === "openrouter") {
      headers["X-OpenRouter-Metadata"] = "enabled";
      recordedHeaders["X-OpenRouter-Metadata"] = "enabled";
    }

    const built = buildModelEndpointRequest(name, stage, definition, prompt, override, recordedHeaders);
    if (!built.ok) {
      return toHarnessResult(name, definition, {
        success: false,
        stdout: "",
        stderr: built.message,
        exit_code: -1,
        duration: 0,
        timed_out: false,
      });
    }
    url = `${definition.base_url.replace(/\/+$/, "")}/chat/completions`;
    body = built.request.body;
    effortOutcome = built.request.effortOutcome;
    requestedModel = built.request.requestedModel;
    requestedEffort = override?.effort ?? definition.reasoning?.effort;
    recordedPayload = built.request.recordedPayload;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutSec * 1000);
  let result: HarnessResult;
  let retryCount = 0;
  let rateLimited = false;
  try {
    let res: Response;
    for (;;) {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429 && retryCount < MAX_RATE_LIMIT_RETRIES) {
        rateLimited = true;
        retryCount++;
        await sleepImpl(retryAfterMs(res));
        continue;
      }
      if (res.status === 429) rateLimited = true;
      break;
    }
    const duration = (Date.now() - started) / 1000;
    if (!res!.ok) {
      result = toHarnessResult(name, definition, {
        success: false,
        stdout: "",
        stderr: `executor "${name}" for stage "${stage}" returned HTTP ${res!.status}`,
        exit_code: res!.status,
        duration,
        timed_out: false,
      });
    } else {
      const json: unknown = await res!.json();
      const stdout = extractStdout(definition, json);
      const provenance =
        definition.type === "model-endpoint"
          ? extractProvenance(requestedModel!, json, effortOutcome, requestedEffort, Math.round(duration * 1000), retryCount, rateLimited)
          : undefined;
      result =
        stdout === null
          ? toHarnessResult(name, definition, {
              success: false,
              stdout: "",
              stderr: `executor "${name}" for stage "${stage}" returned a response that does not match the expected contract`,
              exit_code: -1,
              duration,
              timed_out: false,
              ...(provenance ? { executor_provenance: provenance } : {}),
            })
          : toHarnessResult(name, definition, {
              success: true,
              stdout,
              stderr: "",
              exit_code: 0,
              duration,
              timed_out: false,
              ...(provenance ? { executor_provenance: provenance } : {}),
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
    const provenance = result.executor_provenance;
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
      // Execution class (#434 decision 8): an API-key model-endpoint
      // invocation is always distinct from a local-CLI harness invocation,
      // which records "unknown" (harness.ts) or a probed "oauth:..."/
      // "api-key:..." class — never both classes for the same field value by
      // construction, since only this dispatch path ever writes "api-key:".
      providerAuthClass: definition.type === "model-endpoint" ? "api-key:model-endpoint" : null,
      requestedModel: provenance?.requested_model ?? null,
      resolvedModel: provenance?.resolved_model ?? null,
      upstreamProvider: provenance?.upstream_provider ?? null,
      requestId: provenance?.request_id ?? null,
      finishReason: provenance?.finish_reason ?? null,
      retryCount: provenance?.retry_count ?? null,
      rateLimited: provenance?.rate_limited ?? null,
      requestedEffort: provenance?.requested_effort ?? null,
      resolvedEffort: provenance?.resolved_effort ?? null,
      effortSupport: provenance?.effort_support ?? null,
      requestPayload: recordedPayload ?? null,
      usage:
        provenance && (provenance.usage || provenance.cost_usd !== null)
          ? { ...(provenance.usage ?? {}), cost_usd: provenance.cost_usd ?? undefined }
          : undefined,
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
 *
 * `override` (#434) is the eval runner's per-cell seam: an optional
 * model/params/effort override applied only for this invocation.
 */
export async function invokeStageExecutor(
  stage: ModelInvokingStage,
  cfg: Pick<PipelineConfig, "stage_executors" | "executors">,
  prompt: string,
  opts: InvokeExecutorOptions,
  deps: ExecutorHttpDeps = {},
  override?: ModelEndpointOverride,
): Promise<HarnessResult | null> {
  const assignment = resolveStageExecutor(cfg, stage);
  if (!assignment) return null;

  const preflight = await preflightExecutor(stage, assignment, deps, override);
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

  return invokeExternalExecutor(stage, assignment, prompt, opts, deps, override);
}
