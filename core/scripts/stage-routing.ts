// Auto model/effort routing (#366).
//
// `models:` and `effort:` in `.github/pipeline.yml` each accept the sentinel
// "auto" for any per-stage key. This module is the single source of truth for
// expanding that sentinel into a concrete (model, effort) pair, keyed on a
// stage's task NATURE (how mechanical vs. judgment-heavy the work is) and
// output PERMANENCE (how consequential/hard-to-revisit the result is).
//
// Model selection is harness-aware for Mechanical stages, where `gpt-5.5`
// (codex-only) vs `sonnet` (claude-only) is a real fork. Analytical and
// Adversarial stages share one routing-table model (`claude-fable-5`) across
// every cell; for any non-claude harness (codex included, #608 review-2) that
// value is a claude-only alias the harness cannot run, so `modelForHarness`
// resolves it to no model rather than forwarding an unrunnable flag.

import type { Harness, PipelineConfig } from "./types.ts";
import { resolveAdapter } from "./harness-adapters/index.ts";

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
 * Resolve the model a routing cell yields for `harness` (#608, review-2:
 * finding 465f9695). Mechanical cells fork by harness (`gpt-5.5` codex vs.
 * `sonnet` claude). Every Analytical/Adversarial cell has
 * `claudeModel === codexModel`, a claude-only alias (e.g. `claude-fable-5`) —
 * runnable as-is only by the `claude` adapter. For every other harness,
 * including codex, `isClaudeOnlyModelAlias` catches that so the harness gets
 * `undefined` (no known runnable model in this table) instead of an
 * unrunnable claude-exclusive alias reaching its CLI as an invalid model flag.
 */
function modelForHarness(cell: RoutingCell, harness: Harness): string | undefined {
  if (cell.claudeModel !== cell.codexModel) {
    if (harness === "claude") return cell.claudeModel;
    if (harness === "codex") return cell.codexModel;
    return undefined;
  }
  if (harness === "claude") return cell.claudeModel;
  return isClaudeOnlyModelAlias(cell.claudeModel) ? undefined : cell.claudeModel;
}

/**
 * Expand the `"auto"` sentinel for `stage` into a concrete `(model, effort)`
 * pair. `harness` is the resolved role harness backing the stage (#608).
 * Mechanical stages fork the model between `gpt-5.5` (codex) and `sonnet`
 * (claude). Analytical/Adversarial stages route through the shared
 * `claude-fable-5` cell (the full id — never the unrecognized `fable-5`
 * alias), which only the `claude` adapter can run. A harness with no known
 * runnable model for a cell resolves to `""` (no model) rather than another
 * harness's alias — the empty string is falsy everywhere a resolved model
 * reaches an adapter's `if (ctx.model) args.push(...)` check, so no
 * `--model`-equivalent flag is emitted and the harness's own configured
 * default applies. Effort is never remapped by harness.
 */
export function resolveAuto(stage: RoutingStage, harness: Harness): ResolvedAuto {
  const { nature, permanence } = STAGE_ROUTING[stage];
  const cell = ROUTING_MATRIX[nature][permanence];
  return {
    model: modelForHarness(cell, harness) ?? "",
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
 * Reviewer-role model resolution guard (#441, generalized #608): an
 * `auto`-resolved reviewer model that is a claude-only alias must never reach
 * a registered non-claude reviewer invocation — only the `claude` adapter
 * recognizes those aliases, and every Adversarial routing cell resolves
 * `auto` to the same claude-only `claude-fable-5`. When `reviewerHarness`
 * names a registered adapter other than `claude` (codex, grok, opencode, pi),
 * `model` is a claude-only alias, AND `wasAuto` is true, this returns
 * `undefined` so the invocation omits its model flag (the reviewer harness
 * uses its own configured default). Scoped to registered adapters: an
 * unregistered custom reviewer CLI's contract is unconstrained (#40) and
 * `invoke()` forwards the model to it verbatim regardless, so this guard
 * leaves it alone. An *explicit* (non-`auto`) reviewer model — even one that
 * happens to be a claude-only alias like `sonnet` — is always forwarded
 * verbatim so the reviewer CLI can surface its own invalid-model error rather
 * than silently falling back. Single-sourced so every reviewer call site
 * (review-routing, plan-review, pre_merge, roadmap-deps,
 * auto_merge_eligibility, shipcheck) applies the same rule.
 */
export function resolveReviewerModelForHarness(
  model: string | undefined,
  reviewerHarness: string,
  wasAuto: boolean,
): string | undefined {
  if (model === undefined) return undefined;
  const isRegisteredNonClaude = reviewerHarness !== "claude" && resolveAdapter(reviewerHarness) !== null;
  if (wasAuto && isRegisteredNonClaude && isClaudeOnlyModelAlias(model)) return undefined;
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
