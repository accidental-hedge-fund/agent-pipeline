/**
 * Universal stage-output contract layer (#777).
 *
 * Versioned, machine-checkable product-output contracts for implementer-facing
 * (and structured-output reviewer) stages, plus one single-sourced format-repair
 * policy. Adapter envelope normalization is intentionally out of scope here —
 * callers validate **after** any adapter/transport normalization.
 *
 * Named Claude / Grok / Codex response shapes live only as golden fixtures;
 * production validate paths never branch on harness or provider name.
 */

import { buildStageDiagnostic, type StageDiagnostic } from "./stage-diagnostic.ts";
import { verifyPlanRevisionOutput } from "./verify-harness-commits.ts";
import {
  isJsonVerdictShaped,
  parseStrictVerdict,
} from "./stages/review-parsing.ts";
import type { BlockerKind } from "./types.ts";

// ---------------------------------------------------------------------------
// Contract kinds & result types
// ---------------------------------------------------------------------------

export const STAGE_OUTPUT_CONTRACT_KINDS = [
  "markdown-sections",
  "json-schema",
  "filesystem-shape",
] as const;
export type StageOutputContractKind = (typeof STAGE_OUTPUT_CONTRACT_KINDS)[number];

export type ContractValidateResult<T = unknown> =
  | { ok: true; value?: T; warning?: string }
  | { ok: false; reason: string };

/**
 * Descriptor for one versioned stage-output contract.
 * `id` includes the version suffix (e.g. `plan-revision.ack@1`).
 */
export interface StageOutputContractDescriptor<TInput = unknown, TValue = unknown> {
  id: string;
  version: number;
  kind: StageOutputContractKind;
  /** Side effect that MUST NOT run until validate returns ok. */
  sideEffectGate: string;
  /** Short format-repair instruction when the contract opts into repair. */
  repairAddendum?: string;
  validate: (input: TInput) => ContractValidateResult<TValue>;
}

/** Minimum in-scope contract ids for #777 (drift-guarded). */
export const REQUIRED_STAGE_OUTPUT_CONTRACT_IDS = [
  "plan-revision.ack@1",
  "openspec.change-singular@1",
  "review.verdict@1",
  /** Cheap implementer ack used only by `pipeline doctor --harness-smoke` (#780). */
  "harness-smoke.implementer@1",
] as const;

/** Contract id for implementer harness-smoke product output (#780). */
export const HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID = "harness-smoke.implementer@1" as const;

/** Contract id for reviewer harness-smoke product output (#780) — production review path. */
export const HARNESS_SMOKE_REVIEWER_CONTRACT_ID = "review.verdict@1" as const;

export type RequiredStageOutputContractId =
  (typeof REQUIRED_STAGE_OUTPUT_CONTRACT_IDS)[number];

/**
 * Structured-output stages not registered in this change. A drift test pins
 * this list so it cannot grow silently without an explicit issue link.
 * Prefer registering low-cost schema-backed stages rather than extending this.
 */
export const STAGE_OUTPUT_CONTRACT_FOLLOW_UPS: ReadonlyArray<{
  id: string;
  issue: string;
  note: string;
}> = [
  {
    id: "shipcheck.verdict",
    issue: "#777-followup",
    note: "Shipcheck structured verdict — register when shipcheck schema constant is single-sourced for repair",
  },
  {
    id: "design.interrogation",
    issue: "#777-followup",
    note: "Design-gate interrogation/response shapes",
  },
  {
    id: "auto-merge.judge",
    issue: "#777-followup",
    note: "Auto-merge eligibility judge structured output",
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, StageOutputContractDescriptor>();

export function registerStageOutputContract<TInput, TValue>(
  contract: StageOutputContractDescriptor<TInput, TValue>,
): void {
  if (!contract.id.includes("@")) {
    throw new Error(
      `stage-output contract id must include a version suffix (@N): ${contract.id}`,
    );
  }
  if (registry.has(contract.id)) {
    throw new Error(`stage-output contract already registered: ${contract.id}`);
  }
  registry.set(contract.id, contract as StageOutputContractDescriptor);
}

/** Test-only: clear and re-seed built-in contracts. */
export function resetStageOutputContractRegistryForTests(): void {
  registry.clear();
  registerBuiltInContracts();
}

export function getStageOutputContract(
  id: string,
): StageOutputContractDescriptor | undefined {
  return registry.get(id);
}

export function listStageOutputContracts(): StageOutputContractDescriptor[] {
  return [...registry.values()];
}

export function validateStageOutput<TInput = unknown, TValue = unknown>(
  id: string,
  input: TInput,
): ContractValidateResult<TValue> {
  const contract = registry.get(id);
  if (!contract) {
    return { ok: false, reason: `unknown stage-output contract: ${id}` };
  }
  return contract.validate(input) as ContractValidateResult<TValue>;
}

// ---------------------------------------------------------------------------
// Pure validators (product shape only — no harness/provider name)
// ---------------------------------------------------------------------------

export interface PlanRevisionAckInput {
  stdout: string;
  feedback?: string;
}

export function validatePlanRevisionAck(
  input: PlanRevisionAckInput,
): ContractValidateResult {
  const result = verifyPlanRevisionOutput(input.stdout, input.feedback);
  if (!result.ok) return { ok: false, reason: result.reason };
  return result.warning ? { ok: true, warning: result.warning } : { ok: true };
}

export interface OpenspecSingularInput {
  fresh: string[];
  all: string[];
}

/**
 * Exactly-one new OpenSpec change directory (or single pre-existing fallback).
 * Pure FS-shape check — same acceptance criteria as planning's singularity gate.
 */
export function validateOpenspecChangeSingular(
  input: OpenspecSingularInput,
): ContractValidateResult<{ changeId: string }> {
  const { fresh, all } = input;
  if (fresh.length > 1) {
    return {
      ok: false,
      reason: `OpenSpec authoring produced ${fresh.length} new changes (${fresh.join(", ")}) — expected exactly one`,
    };
  }
  const changeId = fresh[0] ?? (all.length === 1 ? all[0] : undefined);
  if (!changeId) {
    return { ok: false, reason: "no openspec change created" };
  }
  return { ok: true, value: { changeId } };
}

/**
 * Schema-shaped review verdict (JSON with verdict discriminator + findings array).
 * Distinguishes unparseable product shape from a valid empty-findings verdict.
 * Does not apply severity policy.
 */
export function validateReviewVerdict(
  stdout: string,
): ContractValidateResult {
  // Strict parse accepts full schema; isJsonVerdictShaped accepts approve/needs-attention
  // with a findings array (including empty) — both are valid product shapes.
  if (isJsonVerdictShaped(stdout) || parseStrictVerdict(stdout) !== null) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "Review output is not a schema-satisfying verdict JSON object (missing/invalid verdict or findings)",
  };
}

/**
 * Cheap implementer smoke ack (#780): a tiny structured JSON object the canned
 * harness-smoke prompt is designed to emit. Not used by production stages.
 */
export function validateHarnessSmokeImplementer(
  stdout: string,
): ContractValidateResult {
  const text = stdout.trim();
  // Accept fenced or bare JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  // Prefer a single JSON object in the text (first `{...}` span).
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      ok: false,
      reason: "Implementer smoke output is not a JSON object with ok:true",
    };
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { ok?: unknown }).ok === true
    ) {
      return { ok: true };
    }
  } catch {
    // fall through
  }
  return {
    ok: false,
    reason: "Implementer smoke output is not a JSON object with ok:true",
  };
}

// ---------------------------------------------------------------------------
// Repair addenda (contract-specific text only; loop is shared)
// ---------------------------------------------------------------------------

export const PLAN_REVISION_ACK_REPAIR_ADDENDUM = [
  "FORMAT REPAIR (required — previous output failed the machine-checkable acknowledgement contract):",
  "- Emit `## Feedback Incorporated` exactly once as a **line-start** level-2 heading (never glued to preamble text on the same line).",
  "- Under it, list each feedback item as a line-start bullet: `- [ADDRESSED] …` or `- [DEFERRED] … — reason: …`.",
  "- Do not wrap that section only inside a code fence.",
  "- Then re-emit the complete revised plan (not only the acknowledgement fragment).",
].join("\n");

export const OPENSPEC_SINGULAR_REPAIR_ADDENDUM = [
  "FORMAT REPAIR (required — previous OpenSpec authoring failed the change-singularity contract):",
  "- Leave **exactly one** change directory under `openspec/changes/`.",
  "- If multiple new changes were created, merge intent into a single change and remove the extras.",
  "- If none was created, author exactly one complete change (proposal.md, design.md, tasks.md, specs).",
  "- Do not advance with multiple sibling change folders.",
].join("\n");

export const REVIEW_VERDICT_REPAIR_ADDENDUM = [
  "FORMAT REPAIR (required — previous reviewer output failed the machine-checkable verdict contract):",
  "- Emit a single JSON object matching the review verdict schema (fields: verdict, summary, findings, next_steps).",
  "- `verdict` must be `\"approve\"` or `\"needs-attention\"`; `findings` must be an array (may be empty).",
  "- Prefer a fenced ```json block. Do not return prose-only or partial JSON.",
].join("\n");

// ---------------------------------------------------------------------------
// Built-in registration
// ---------------------------------------------------------------------------

function registerBuiltInContracts(): void {
  registerStageOutputContract({
    id: "plan-revision.ack@1",
    version: 1,
    kind: "markdown-sections",
    sideEffectGate: "post revised plan comment",
    repairAddendum: PLAN_REVISION_ACK_REPAIR_ADDENDUM,
    validate: validatePlanRevisionAck,
  });

  registerStageOutputContract({
    id: "openspec.change-singular@1",
    version: 1,
    kind: "filesystem-shape",
    sideEffectGate: "advance past OpenSpec authoring with selected changeId",
    repairAddendum: OPENSPEC_SINGULAR_REPAIR_ADDENDUM,
    validate: validateOpenspecChangeSingular,
  });

  registerStageOutputContract({
    id: "review.verdict@1",
    version: 1,
    kind: "json-schema",
    sideEffectGate: "accept review verdict for severity/policy advancement",
    repairAddendum: REVIEW_VERDICT_REPAIR_ADDENDUM,
    validate: (stdout: string) => validateReviewVerdict(stdout),
  });

  registerStageOutputContract({
    id: HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID,
    version: 1,
    kind: "json-schema",
    sideEffectGate: "accept doctor harness-smoke implementer treatment as ready",
    validate: (stdout: string) => validateHarnessSmokeImplementer(stdout),
  });
}

registerBuiltInContracts();

// ---------------------------------------------------------------------------
// Shared format-repair policy (single re-prompt by default)
// ---------------------------------------------------------------------------

/** Default automatic re-prompt budget: one repair → two validation attempts total. */
export const DEFAULT_FORMAT_REPAIR_BUDGET = 1;

export type FormatRepairInvokeOk<TOutput> = { success: true; output: TOutput };
export type FormatRepairInvokeFail = { success: false; reason: string };
export type FormatRepairInvokeResult<TOutput> =
  | FormatRepairInvokeOk<TOutput>
  | FormatRepairInvokeFail;

export type FormatRepairLoopResult<TOutput> =
  | {
      status: "ok";
      output: TOutput;
      attempts: number;
      repaired: boolean;
      warning?: string;
    }
  | {
      status: "contract-exhausted";
      reason: string;
      output: TOutput;
      attempts: number;
    }
  | {
      status: "invoke-failed";
      reason: string;
      attempts: number;
    };

/**
 * Single-sourced format-repair policy for registered stage-output contracts.
 *
 * 1. Validate `initialOutput`.
 * 2. On pure shape failure and budget remaining, call `repairInvoke` once
 *    (caller appends contract repairAddendum to the product prompt).
 * 3. Re-validate. Never performs a second automatic repair under the default budget.
 *
 * Invoke/process failures are returned as `invoke-failed` so stages keep their
 * existing mechanical harness mappings (timeout, non-zero exit).
 */
export async function runFormatRepairLoop<TOutput>(options: {
  validate: (output: TOutput) => ContractValidateResult;
  initialOutput: TOutput;
  /**
   * Re-invoke the harness with a format-repair addendum. Called at most
   * `budget` times (default 1). Must not perform additional internal shape retries.
   */
  repairInvoke: () => Promise<FormatRepairInvokeResult<TOutput>>;
  budget?: number;
}): Promise<FormatRepairLoopResult<TOutput>> {
  const budget = options.budget ?? DEFAULT_FORMAT_REPAIR_BUDGET;
  if (budget < 0 || !Number.isInteger(budget)) {
    throw new Error(`format-repair budget must be a non-negative integer; got ${budget}`);
  }

  let output = options.initialOutput;
  let attempts = 1;
  let repaired = false;

  let check = options.validate(output);
  if (check.ok) {
    return {
      status: "ok",
      output,
      attempts,
      repaired: false,
      ...(check.warning ? { warning: check.warning } : {}),
    };
  }

  let repairsLeft = budget;
  while (!check.ok && repairsLeft > 0) {
    repairsLeft -= 1;
    const repair = await options.repairInvoke();
    attempts += 1;
    if (!repair.success) {
      return { status: "invoke-failed", reason: repair.reason, attempts };
    }
    output = repair.output;
    repaired = true;
    check = options.validate(output);
  }

  if (check.ok) {
    return {
      status: "ok",
      output,
      attempts,
      repaired,
      ...(check.warning ? { warning: check.warning } : {}),
    };
  }

  return {
    status: "contract-exhausted",
    reason: check.reason,
    output,
    attempts,
  };
}

/**
 * Convenience: validate via a registered contract id through the shared repair loop.
 */
export async function runContractWithFormatRepair<TOutput>(options: {
  contractId: string;
  /** Map harness/product output into the contract's validate input. */
  toValidateInput: (output: TOutput) => unknown;
  initialOutput: TOutput;
  repairInvoke: () => Promise<FormatRepairInvokeResult<TOutput>>;
  budget?: number;
}): Promise<FormatRepairLoopResult<TOutput>> {
  return runFormatRepairLoop({
    validate: (output) => validateStageOutput(options.contractId, options.toValidateInput(output)),
    initialOutput: options.initialOutput,
    repairInvoke: options.repairInvoke,
    budget: options.budget,
  });
}

// ---------------------------------------------------------------------------
// Terminal harness-contract diagnostics
// ---------------------------------------------------------------------------

/**
 * Build a `pipeline/stage-diagnostic@1` record for exhausted pure shape failure.
 * Uses additive reason `harness-contract` on coarse `harness-failure` so recovery
 * projects engine-owned (not human_authority).
 */
export function buildHarnessContractDiagnostic(input: {
  reason: string;
  stage?: string;
  evidenceKey?: string;
  /** Coarse kind carrying the additive harness-contract reason; default harness-failure. */
  blockerKind?: Extract<BlockerKind, "harness-failure" | "needs-human">;
}): StageDiagnostic {
  return buildStageDiagnostic({
    reasonCode: "harness-contract",
    blockerKind: input.blockerKind ?? "harness-failure",
    reason: input.reason,
    stage: input.stage,
    evidenceKey: input.evidenceKey,
  });
}

// ---------------------------------------------------------------------------
// Golden fixtures (adapter identity is catalog metadata only)
// ---------------------------------------------------------------------------

/**
 * Golden response-shape fixture for drift-guarded regression.
 * `adapter` names the origin harness for humans/tests only — never used by
 * {@link evaluateGoldenFixture} or production validate paths.
 */
export interface StageOutputGoldenFixture {
  /** Stable fixture id (e.g. `grok-midline-ack`). */
  id: string;
  /** Adapter/harness name for catalog only — never a validation branch. */
  adapter: string;
  contractId: string;
  /** Product output after envelope normalization. */
  input: unknown;
  expectOk: boolean;
  description?: string;
}

const goldenFixtures: StageOutputGoldenFixture[] = [];

/**
 * Extension-adapter / built-in golden-fixture registration hook (#783-aligned).
 * Fixtures are evaluated by the same central validate path as production.
 */
export function registerGoldenFixture(fixture: StageOutputGoldenFixture): void {
  if (!fixture.id || !fixture.contractId) {
    throw new Error("golden fixture requires id and contractId");
  }
  if (goldenFixtures.some((f) => f.id === fixture.id)) {
    throw new Error(`golden fixture already registered: ${fixture.id}`);
  }
  goldenFixtures.push(fixture);
}

/** Test-only reset of extension/built-in golden fixtures. */
export function resetGoldenFixturesForTests(): void {
  goldenFixtures.length = 0;
}

export function listGoldenFixtures(): readonly StageOutputGoldenFixture[] {
  return goldenFixtures;
}

/** Evaluate a fixture via the central contract validate function (no provider branch). */
export function evaluateGoldenFixture(
  fixture: StageOutputGoldenFixture,
): ContractValidateResult {
  return validateStageOutput(fixture.contractId, fixture.input);
}

// ---------------------------------------------------------------------------
// Layering note (envelope vs product schema)
// ---------------------------------------------------------------------------

/**
 * Documented layering for tests and callers:
 * 1. Adapter envelope normalization (transport / telemetry frames) — harness adapters
 * 2. Stage-output-contract validate — product shape (this module)
 *
 * Validation acceptance MUST NOT read harness or provider name. A regression
 * test scans this module source for forbidden provider-branch patterns.
 */
export const STAGE_OUTPUT_LAYERING = {
  order: ["adapter-envelope-normalization", "stage-output-contract-validate"] as const,
  providerBranchForbidden: true,
} as const;
