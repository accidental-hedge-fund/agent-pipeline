// Auto model/effort routing (#366).
//
// `models:` and `effort:` in `.github/pipeline.yml` each accept the sentinel
// "auto" for any per-stage key. This module is the single source of truth for
// expanding that sentinel into a concrete (model, effort) pair, keyed on a
// stage's task NATURE (how mechanical vs. judgment-heavy the work is) and
// output PERMANENCE (how consequential/hard-to-revisit the result is).
//
// Model selection is harness-aware only for Mechanical stages, where
// `gpt-5.5` (codex-only) vs `sonnet` (claude-only) is a real fork. Analytical
// and Adversarial stages resolve to the same model regardless of which
// harness backs them — an Analytical stage backed by codex (e.g. `planning`
// under the `claude` profile, where the reviewer is codex... no, planning is
// always the implementer) still resolves to a claude-only alias; if that
// alias is inert for the active harness, the existing inert-alias advisory
// (`warnInertModelAliases`) already covers it, exactly as it would for an
// explicit (non-auto) override.

import type { Harness, PipelineConfig } from "./types.ts";

export type StageNature = "mechanical" | "analytical" | "adversarial";
export type StagePermanence = "ephemeral" | "iterative" | "definitive";

/** The concrete stages `resolveAuto` can classify. `fix` covers both fix-1 and
 *  fix-2 (identical classification); `plan-review` is distinct from `planning`
 *  even though both are driven by the same `models.planning`/`effort.planning`
 *  config key (see config.ts's `plan_review_effort` derivation). */
export type RoutingStage =
  | "intake"
  | "sweep"
  | "planning"
  | "implementing"
  | "fix"
  | "plan-review"
  | "review-1"
  | "review-2";

interface StageClassification {
  nature: StageNature;
  permanence: StagePermanence;
}

export const STAGE_ROUTING: Record<RoutingStage, StageClassification> = {
  intake: { nature: "analytical", permanence: "ephemeral" },
  sweep: { nature: "analytical", permanence: "ephemeral" },
  planning: { nature: "analytical", permanence: "iterative" },
  implementing: { nature: "mechanical", permanence: "iterative" },
  fix: { nature: "mechanical", permanence: "iterative" },
  "plan-review": { nature: "adversarial", permanence: "definitive" },
  "review-1": { nature: "adversarial", permanence: "iterative" },
  "review-2": { nature: "adversarial", permanence: "definitive" },
};

interface RoutingCell {
  claudeModel: string;
  codexModel: string;
  effort: string;
}

/**
 * (nature, permanence) → (model, effort). `codexModel` only differs from
 * `claudeModel` for Mechanical stages (`gpt-5.5` is codex-only); every other
 * cell uses the same model for both harnesses, so harness-inertness for those
 * is governed by the existing inert-alias advisory, not this table.
 */
const ROUTING_MATRIX: Record<StageNature, Record<StagePermanence, RoutingCell>> = {
  mechanical: {
    ephemeral: { claudeModel: "sonnet", codexModel: "gpt-5.5", effort: "low" },
    iterative: { claudeModel: "sonnet", codexModel: "gpt-5.5", effort: "low" },
    definitive: { claudeModel: "sonnet", codexModel: "sonnet", effort: "medium" },
  },
  analytical: {
    ephemeral: { claudeModel: "sonnet", codexModel: "sonnet", effort: "low" },
    iterative: { claudeModel: "opus", codexModel: "opus", effort: "medium" },
    definitive: { claudeModel: "claude-fable-5", codexModel: "claude-fable-5", effort: "high" },
  },
  adversarial: {
    ephemeral: { claudeModel: "claude-fable-5", codexModel: "claude-fable-5", effort: "medium" },
    iterative: { claudeModel: "claude-fable-5", codexModel: "claude-fable-5", effort: "high" },
    definitive: { claudeModel: "claude-fable-5", codexModel: "claude-fable-5", effort: "max" },
  },
};

export interface ResolvedAuto {
  model: string;
  effort: string;
}

/**
 * Expand the `"auto"` sentinel for `stage` into a concrete `(model, effort)`
 * pair. `harness` is the concrete harness backing the stage under the active
 * profile — only consulted for Mechanical stages, where it forks the model
 * between `gpt-5.5` (codex) and `sonnet` (claude). Adversarial stages always
 * resolve `claude-fable-5` (the full id — never the unrecognized `fable-5`
 * alias) regardless of harness, so alternative-harness routing is
 * profile-independent by construction.
 */
export function resolveAuto(stage: RoutingStage, harness: Harness): ResolvedAuto {
  const { nature, permanence } = STAGE_ROUTING[stage];
  const cell = ROUTING_MATRIX[nature][permanence];
  return {
    model: harness === "codex" ? cell.codexModel : cell.claudeModel,
    effort: cell.effort,
  };
}

/** Expand a raw `models.*`/`effort.*` config value for `stage`: `"auto"` is
 *  routed through {@link resolveAuto}, `undefined` stays `undefined`, any other
 *  string passes through unchanged. Never returns the literal `"auto"`. */
export function expandAutoModel(
  raw: string | undefined,
  stage: RoutingStage,
  harness: Harness,
): string | undefined {
  if (raw === "auto") return resolveAuto(stage, harness).model;
  return raw;
}

export function expandAutoEffort(
  raw: string | undefined,
  stage: RoutingStage,
  harness: Harness,
): string | undefined {
  if (raw === "auto") return resolveAuto(stage, harness).effort;
  return raw;
}

/** Model ids the claude CLI recognizes that codex does not (#441). The
 *  Adversarial routing cells above resolve `auto` to `claude-fable-5` for
 *  every reviewer harness — the only alias that reaches this check via auto
 *  expansion — but the set also covers the other short claude aliases and any
 *  `claude-*` id so an explicitly-authored claude alias is caught the same way. */
const CLAUDE_ONLY_MODEL_ALIASES = new Set(["claude-fable-5", "sonnet", "opus", "haiku"]);

export function isClaudeOnlyModelAlias(model: string): boolean {
  return CLAUDE_ONLY_MODEL_ALIASES.has(model) || model.startsWith("claude-");
}

/**
 * Reviewer-role model resolution guard (#441): an `auto`-resolved reviewer
 * model that is a claude-only alias must never reach a codex reviewer
 * invocation — codex has no equivalent and would reject it, and every
 * Adversarial routing cell resolves `auto` to the same claude-only
 * `claude-fable-5`. When `reviewerHarness` is `"codex"`, `model` is a
 * claude-only alias, AND `wasAuto` is true, this returns `undefined` so the
 * invocation omits `-m` (codex uses its configured default). An *explicit*
 * (non-`auto`) reviewer model — even one that happens to be a claude-only
 * alias like `sonnet` — is always forwarded verbatim so codex can surface its
 * own invalid-model error rather than silently falling back. Single-sourced
 * so every reviewer call site (review-routing, plan-review, pre_merge,
 * roadmap-deps, auto_merge_eligibility, shipcheck) applies the same rule.
 */
export function resolveReviewerModelForHarness(
  model: string | undefined,
  reviewerHarness: string,
  wasAuto: boolean,
): string | undefined {
  if (model === undefined) return undefined;
  if (wasAuto && reviewerHarness === "codex" && isClaudeOnlyModelAlias(model)) return undefined;
  return model;
}

/**
 * Whether the reviewer model that will reach {@link resolveReviewerModelForHarness}
 * (via the `optsModel ?? cfg.harnesses.reviewerModel ?? cfg.models.review`
 * chain every reviewer call site uses) originated from the `"auto"` sentinel
 * (#441). `optsModel` (a CLI `--model` override) is always explicit. Mirrors
 * the same precedence the model value itself is resolved with, so the two
 * never disagree about which source won.
 */
export function reviewerModelSourceWasAuto(
  cfg: Pick<PipelineConfig, "harnesses" | "models">,
  optsModel: string | undefined,
): boolean {
  if (optsModel !== undefined) return false;
  if (cfg.harnesses.reviewerModel !== undefined) return !!cfg.harnesses.reviewerModelWasAuto;
  return !!cfg.models.reviewWasAuto;
}
