import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import type {
  StageAccountingCostSource,
  StageAccountingRecord,
  StageAccountingSummary,
  StageAccountingUsage,
} from "./types.ts";

export const STAGE_ACCOUNTING_SCHEMA_VERSION = 1;

export interface UsageAccountingExtraction {
  usage?: StageAccountingUsage;
  costUsd: number | null;
  harness?: string;
  modelSlot?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface BuildStageAccountingRecordInput {
  runId: string;
  issue: number;
  stage: string;
  harness: string;
  modelSlot?: string | null;
  model?: string | null;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number;
  commandCount?: number;
  subprocessCount?: number;
  outcome: string;
  blockerKind?: string | null;
  usage?: unknown;
  estimatedCostUsd?: number | null;
}

const NUMERIC_USAGE_FIELDS: Record<string, keyof StageAccountingUsage> = {
  input_tokens: "input_tokens",
  inputTokens: "input_tokens",
  prompt_tokens: "prompt_tokens",
  promptTokens: "prompt_tokens",
  output_tokens: "output_tokens",
  outputTokens: "output_tokens",
  completion_tokens: "completion_tokens",
  completionTokens: "completion_tokens",
  total_tokens: "total_tokens",
  totalTokens: "total_tokens",
  cached_input_tokens: "cached_input_tokens",
  cachedInputTokens: "cached_input_tokens",
  cache_read_input_tokens: "cached_input_tokens",
  reasoning_tokens: "reasoning_tokens",
  reasoningTokens: "reasoning_tokens",
  cost_usd: "cost_usd",
  costUsd: "cost_usd",
  total_cost_usd: "cost_usd",
  totalCostUsd: "cost_usd",
};

const COST_FIELDS = new Set(["cost_usd", "costUsd", "total_cost_usd", "totalCostUsd", "cost"]);

export function extractUsageAccounting(input: unknown): UsageAccountingExtraction {
  const parsed = parseMaybeJson(input);
  const usage: StageAccountingUsage = {};
  const identifiers: { harness?: string; modelSlot?: string; model?: string; startedAt?: string; endedAt?: string; durationMs?: number } = {};
  let costUsd: number | null = null;

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, raw] of Object.entries(value)) {
      const usageKey = NUMERIC_USAGE_FIELDS[key];
      const numeric = finiteNonNegative(raw);
      if (usageKey && numeric !== null && usage[usageKey] === undefined) {
        usage[usageKey] = numeric;
      }
      if (COST_FIELDS.has(key) && numeric !== null && costUsd === null) {
        costUsd = numeric;
      }

      if (key === "harness" && identifiers.harness === undefined) {
        identifiers.harness = cleanOptionalString(raw) ?? undefined;
      } else if ((key === "model_slot" || key === "modelSlot") && identifiers.modelSlot === undefined) {
        identifiers.modelSlot = cleanOptionalString(raw) ?? undefined;
      } else if (key === "model" && identifiers.model === undefined) {
        identifiers.model = cleanOptionalString(raw) ?? undefined;
      } else if ((key === "started_at" || key === "startedAt") && identifiers.startedAt === undefined) {
        identifiers.startedAt = isoString(raw) ?? undefined;
      } else if ((key === "ended_at" || key === "endedAt") && identifiers.endedAt === undefined) {
        identifiers.endedAt = isoString(raw) ?? undefined;
      } else if ((key === "duration_ms" || key === "durationMs") && identifiers.durationMs === undefined) {
        identifiers.durationMs = numeric ?? undefined;
      }

      if (isRecord(raw) || Array.isArray(raw)) visit(raw, depth + 1);
    }
  };

  visit(parsed, 0);
  return {
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    costUsd,
    ...identifiers,
  };
}

export function buildStageAccountingRecord(input: BuildStageAccountingRecordInput): StageAccountingRecord {
  const usage = extractUsageAccounting(input.usage);
  const cost = classifyCost(usage.costUsd, input.estimatedCostUsd);
  const startedAt = isoString(input.startedAt) ?? new Date(0).toISOString();
  const endedAt = isoString(input.endedAt) ?? usage.endedAt ?? null;
  const durationMs = nonNegativeInteger(
    input.durationMs ?? usage.durationMs ?? durationBetween(startedAt, endedAt),
  );

  const record: StageAccountingRecord = {
    schema_version: STAGE_ACCOUNTING_SCHEMA_VERSION,
    run_id: cleanRequiredString(input.runId),
    issue: nonNegativeInteger(input.issue),
    stage: cleanRequiredString(input.stage),
    harness: cleanRequiredString(usage.harness ?? input.harness),
    model_slot: cleanOptionalString(usage.modelSlot ?? input.modelSlot ?? null),
    model: cleanOptionalString(usage.model ?? input.model ?? null),
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    command_count: nonNegativeInteger(input.commandCount ?? 1),
    subprocess_count: nonNegativeInteger(input.subprocessCount ?? 1),
    outcome: cleanRequiredString(input.outcome),
    blocker_kind: cleanOptionalString(input.blockerKind ?? null),
    cost_source: cost.source,
    cost_usd: cost.usd,
    ...(usage.usage ? { usage: usage.usage } : {}),
  };
  return sanitizeStageAccountingRecord(record);
}

export function sanitizeStageAccountingRecord(record: StageAccountingRecord): StageAccountingRecord {
  const cost = classifyCost(
    record.cost_source === "actual" ? record.cost_usd : null,
    record.cost_source === "estimated" ? record.cost_usd : null,
    record.cost_source,
  );
  const cleaned: StageAccountingRecord = {
    schema_version: STAGE_ACCOUNTING_SCHEMA_VERSION,
    run_id: cleanRequiredString(record.run_id),
    issue: nonNegativeInteger(record.issue),
    stage: cleanRequiredString(record.stage),
    harness: cleanRequiredString(record.harness),
    model_slot: cleanOptionalString(record.model_slot),
    model: cleanOptionalString(record.model),
    started_at: isoString(record.started_at) ?? new Date(0).toISOString(),
    ended_at: isoString(record.ended_at),
    duration_ms: nonNegativeInteger(record.duration_ms),
    command_count: nonNegativeInteger(record.command_count),
    subprocess_count: nonNegativeInteger(record.subprocess_count),
    outcome: cleanRequiredString(record.outcome),
    blocker_kind: cleanOptionalString(record.blocker_kind),
    cost_source: cost.source,
    cost_usd: cost.usd,
  };
  const usage = sanitizeUsage(record.usage);
  if (usage) cleaned.usage = usage;
  return cleaned;
}

export function accountingSummary(records: StageAccountingRecord[]): StageAccountingSummary {
  let actual = 0;
  let estimated = 0;
  let unknown = 0;
  for (const record of records) {
    if (record.cost_source === "actual" && typeof record.cost_usd === "number") {
      actual += record.cost_usd;
    } else if (record.cost_source === "estimated" && typeof record.cost_usd === "number") {
      estimated += record.cost_usd;
    } else if (record.cost_source === "unknown") {
      unknown++;
    }
  }
  return {
    records,
    totals: {
      record_count: records.length,
      actual_cost_usd: roundUsd(actual),
      estimated_cost_usd: roundUsd(estimated),
      unknown_cost_count: unknown,
    },
  };
}

function classifyCost(
  actualCostUsd: number | null | undefined,
  estimatedCostUsd: number | null | undefined,
  forced?: StageAccountingCostSource,
): { source: StageAccountingCostSource; usd: number | null } {
  const actual = finiteNonNegative(actualCostUsd);
  const estimate = finiteNonNegative(estimatedCostUsd);
  if (forced === "actual" && actual !== null) return { source: "actual", usd: roundUsd(actual) };
  if (forced === "estimated" && estimate !== null) return { source: "estimated", usd: roundUsd(estimate) };
  if (actual !== null) return { source: "actual", usd: roundUsd(actual) };
  if (estimate !== null) return { source: "estimated", usd: roundUsd(estimate) };
  return { source: "unknown", usd: null };
}

function sanitizeUsage(input: StageAccountingUsage | undefined): StageAccountingUsage | undefined {
  if (!input) return undefined;
  const usage: StageAccountingUsage = {};
  for (const key of Object.values(NUMERIC_USAGE_FIELDS)) {
    const value = finiteNonNegative(input[key]);
    if (value !== null && usage[key] === undefined) usage[key] = value;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseMaybeJson(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanRequiredString(value: unknown): string {
  return cleanOptionalString(value) ?? "";
}

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitize(redactSecrets(value));
  return cleaned.length > 0 ? cleaned : null;
}

function isoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function durationBetween(start: string, end: string | null): number {
  if (!end) return 0;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return endMs - startMs;
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function nonNegativeInteger(value: unknown): number {
  const numeric = finiteNonNegative(value);
  return numeric === null ? 0 : Math.round(numeric);
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}
