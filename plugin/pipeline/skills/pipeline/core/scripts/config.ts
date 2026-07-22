// Config loader: per-repo `.github/pipeline.yml` merged with built-in defaults.

import { z } from "zod";
import yaml from "js-yaml";
import { parseDocument, isMap, isSeq, type YAMLSeq } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_CONFIG,
  STAGES,
  MODEL_INVOKING_STAGES,
  EXECUTION_ENVIRONMENT_STAGES,
  MODEL_ENDPOINT_DIALECTS,
  MODEL_ENDPOINT_ROUTING_PARAM_KEYS,
  MODEL_ENDPOINT_RESERVED_HEADERS,
  DESIGN_GATE_TRIGGER_CLASSES,
  type Harness,
  type PipelineConfig,
  type ModelEndpointDialect,
  type ModelEndpointParams,
} from "./types.ts";
import { loadProfile, type PipelineProfile } from "./profile.ts";
import { expandAutoEffort, expandAutoModel, isClaudeOnlyModelAlias } from "./stage-routing.ts";

// A `models.*`/`effort.*` value: an arbitrary alias/effort string, or the
// "auto" sentinel (#366) resolved via stage-routing.ts at config-load time.
const modelOrAuto = z.union([z.string(), z.literal("auto")]);

/**
 * Flatten zod issues, unwrapping `invalid_union` issues (produced by fields
 * that accept either a string or a structured object, e.g. `review_harness`)
 * into their most specific nested branch. Without this, a typo'd key inside
 * the object form (`review_harness: { command, bad_key }`) surfaces only the
 * union's generic "Invalid input" with no key name. This recurses into the
 * union's per-branch issues and prefers a branch that pinpoints an
 * unrecognized key (or otherwise the most specific/longest branch) over a
 * generic type-mismatch branch, so the real problem is reported.
 */
function flattenIssues(issues: readonly z.core.$ZodIssue[], basePath: (string | number)[] = []): z.core.$ZodIssue[] {
  const out: z.core.$ZodIssue[] = [];
  for (const issue of issues) {
    const path = [...basePath, ...issue.path];
    if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
      const branches = issue.errors.map((branchIssues) => flattenIssues(branchIssues, path));
      const preferred =
        branches.find((b) => b.some((i) => i.code === "unrecognized_keys")) ??
        branches.reduce((best, b) => (b.length > best.length ? b : best), branches[0] ?? []);
      out.push(...preferred);
    } else {
      out.push({ ...issue, path } as z.core.$ZodIssue);
    }
  }
  return out;
}

// External stage executors (#314). `agent-system` = a full execution backend
// (OpenCode/HermesAgent/OpenClaw) addressed by provider id + endpoint, valid for
// any model-invoking stage. `model-endpoint` = a raw OpenAI-compatible
// chat/completions endpoint (e.g. local Ollama), valid only for prompt-contained
// stages — enforced by `validateStageExecutorAssignments` below, not by this
// schema (the eligibility rule depends on which stage a name is assigned to,
// which this per-definition schema cannot see).
const AgentSystemExecutorSchema = z
  .object({
    type: z.literal("agent-system"),
    provider: z.string().describe("Provider identifier (e.g. 'opencode', 'hermesagent', 'openclaw')."),
    endpoint: z.string().describe("API endpoint URL that speaks the pipeline's executor contract."),
    credential: z.string().optional().describe("Env-var name (or secret reference) resolved at invocation time — never a literal secret value."),
  })
  .strict();

// OpenRouter's documented `provider` request object (provider-routing
// preferences: https://openrouter.ai/docs/features/provider-routing) — a
// strict field-by-field schema so a malformed or unknown routing key is
// rejected at parse time rather than passed through as an untyped record.
const OpenRouterSortSchema = z.union([
  z.enum(["price", "throughput", "latency"]),
  z.object({ by: z.enum(["price", "throughput", "latency"]), partition: z.enum(["model", "none"]).optional() }).strict(),
]);

const OpenRouterThroughputLatencySchema = z.union([
  z.number(),
  z
    .object({ p50: z.number().optional(), p75: z.number().optional(), p90: z.number().optional(), p99: z.number().optional() })
    .strict(),
]);

export const OpenRouterProviderPreferencesSchema = z
  .object({
    order: z.array(z.string()).optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(["allow", "deny"]).optional(),
    zdr: z.boolean().optional(),
    enforce_distillable_text: z.boolean().optional(),
    only: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    quantizations: z.array(z.enum(["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"])).optional(),
    sort: OpenRouterSortSchema.optional(),
    preferred_min_throughput: OpenRouterThroughputLatencySchema.optional(),
    preferred_max_latency: OpenRouterThroughputLatencySchema.optional(),
    max_price: z
      .object({
        prompt: z.number().optional(),
        completion: z.number().optional(),
        request: z.number().optional(),
        image: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Allowlisted `params` block (#434 api-executor-request-controls decision 3):
// a strict passthrough would turn pipeline.yml into an untyped wire-format
// hole where a typo silently no-ops. `provider`/`models` are OpenRouter-only
// routing options — rejected below for any other dialect.
export const ModelEndpointParamsSchema = z
  .object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    seed: z.number().int().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    stop: z.array(z.string()).optional(),
    provider: OpenRouterProviderPreferencesSchema.optional().describe("OpenRouter provider-routing preferences — dialect: openrouter only."),
    models: z.array(z.string()).optional().describe("OpenRouter model fallback list — dialect: openrouter only."),
  })
  .strict();

const ModelEndpointHeaderValueSchema = z.union([z.string(), z.object({ env: z.string() }).strict()]);

const ModelEndpointReasoningSchema = z
  .object({
    effort: z.string().optional(),
    // Opt-in only (#434 decision 2): absent means an effort the declared
    // dialect cannot express fails preflight rather than being dropped.
    on_unsupported: z.literal("record").optional(),
  })
  .strict();

const MODEL_ENDPOINT_ROUTING_PARAM_KEY_SET = new Set<string>(MODEL_ENDPOINT_ROUTING_PARAM_KEYS);
const MODEL_ENDPOINT_RESERVED_HEADER_SET = new Set<string>(MODEL_ENDPOINT_RESERVED_HEADERS);

/**
 * Dialect-dependent checks that a single-field schema cannot express (#434
 * task 1.2): an OpenRouter-only routing option declared for a dialect that
 * doesn't support it, and structured output enabled for a dialect that
 * cannot express it. Shared between the committed-config schema (below) and
 * per-invocation override validation (executors.ts), so the two paths can
 * never drift.
 */
export function validateModelEndpointDialectRules(
  dialect: ModelEndpointDialect,
  params: ModelEndpointParams | undefined,
  structuredOutput: boolean | undefined,
): string[] {
  const errors: string[] = [];
  if (params) {
    for (const key of Object.keys(params)) {
      if (MODEL_ENDPOINT_ROUTING_PARAM_KEY_SET.has(key) && dialect !== "openrouter") {
        errors.push(
          `params.${key} is an OpenRouter-only routing option — the executor declares dialect "${dialect}", not "openrouter"`,
        );
      }
    }
  }
  if (structuredOutput && dialect === "none") {
    errors.push(`structured_output is enabled but dialect "none" cannot express structured output`);
  }
  return errors;
}

const ModelEndpointExecutorSchema = z
  .object({
    type: z.literal("model-endpoint"),
    base_url: z.string().describe("Base URL of an OpenAI-compatible chat/completions endpoint (e.g. http://localhost:11434/v1)."),
    model: z.string().describe("Model name passed in the chat/completions request."),
    credential: z.string().optional().describe("Env-var name (or secret reference) resolved at invocation time — never a literal secret value."),
    dialect: z
      .enum(MODEL_ENDPOINT_DIALECTS)
      .optional()
      .describe(`Wire dialect — one of ${MODEL_ENDPOINT_DIALECTS.join(", ")}. Defaults to "openai" (today's minimal request) when omitted. Never inferred from base_url or model.`),
    params: ModelEndpointParamsSchema.optional().describe("Allowlisted request parameters (temperature, top_p, seed, max_output_tokens, stop, provider/models routing)."),
    headers: z
      .record(z.string(), ModelEndpointHeaderValueSchema)
      .optional()
      .describe("Extra request headers: a non-secret literal string, or { env: VAR_NAME } resolved from the environment at invocation time. Cannot declare authorization or content-type."),
    reasoning: ModelEndpointReasoningSchema.optional().describe("Requested reasoning effort and how an unsupported dialect should handle it."),
    structured_output: z.boolean().optional().describe("Request the dialect's JSON/schema response-format field for a review stage. Transport hint only — verdict validation is unchanged."),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.headers) {
      for (const name of Object.keys(def.headers)) {
        if (MODEL_ENDPOINT_RESERVED_HEADER_SET.has(name.toLowerCase())) {
          ctx.addIssue({
            code: "custom",
            message: `headers cannot declare "${name}" — it would override the credential Authorization header or the fixed content-type`,
            path: ["headers", name],
          });
        }
      }
    }
    const dialect = def.dialect ?? "openai";
    for (const message of validateModelEndpointDialectRules(dialect, def.params, def.structured_output)) {
      ctx.addIssue({ code: "custom", message, path: ["params"] });
    }
  });

const ExecutorDefinitionSchema = z.discriminatedUnion("type", [
  AgentSystemExecutorSchema,
  ModelEndpointExecutorSchema,
]);

const PartialConfigSchema = z.object({
  repo: z.string().optional().describe("GitHub repository in 'owner/name' format (overrides auto-detected value)."),
  base_branch: z.string().optional().describe("Branch that PRs target and worktrees branch from."),
  worktree_root: z.string().optional().describe("Directory (relative to repo root) where pipeline worktrees are created."),
  max_concurrent_worktrees: z.number().int().positive().optional().describe("Maximum number of simultaneous in-flight worktrees."),
  auto_recovery_max_retries: z.number().int().min(0).optional().describe("Number of auto-recovery attempts when implementation blocks."),
  implementation_timeout: z.number().int().positive().optional().describe("Seconds for the implementation harness before timing out."),
  review_timeout: z.number().int().positive().optional().describe("Seconds per review stage."),
  plan_review_timeout: z.number().int().positive().optional().describe("Seconds for the plan-review harness before timing out."),
  fix_timeout: z.number().int().positive().optional().describe("Seconds per fix stage."),
  intake_timeout: z.number().int().positive().optional().describe("Seconds for the intake harness call before timing out."),
  sweep_timeout: z.number().int().positive().optional().describe("Seconds for the sweep harness call before timing out."),
  ci_timeout: z.number().int().positive().optional().describe("Seconds to wait for CI at pre-merge."),
  ci_poll_interval: z.number().int().positive().optional().describe("Seconds between CI status polls."),
  ci_no_run_grace_s: z.number().int().min(0).optional().describe("Seconds to wait before checking for zero check-runs when CI is pending. Default 60; set to 0 to check immediately."),
  ci_mode: z.enum(["github", "local"]).optional().describe("Source of pre-merge CI verification: github (default) waits on gh pr checks; local relies on the current run's local test-gate result and skips the GitHub Actions wait."),
  // Each alias is independently optional so a partial `models:` block (e.g.
  // only `review:`) is valid — resolveConfig fills the rest from DEFAULT_CONFIG
  // and the inert-alias warning keys off which sub-keys were explicitly set.
  models: z
    .object({
      planning: modelOrAuto.optional().describe("Model alias for the planning phase (implementer harness), or \"auto\" to derive it from the stage's task-nature/permanence routing table."),
      implementing: modelOrAuto.optional().describe("Model alias for the implementing phase (implementer harness), or \"auto\"."),
      review: modelOrAuto.optional().describe("Model alias for the review phase (reviewer harness), or \"auto\"."),
      fix: modelOrAuto.optional().describe("Model alias for the fix phase (implementer harness), or \"auto\"."),
      intake: modelOrAuto.optional().describe("Model alias for the intake spec-generation step (always the claude harness, regardless of profile — never inert), or \"auto\"."),
      sweep: modelOrAuto.optional().describe("Model alias for the sweep spec-generation step (always the claude harness, regardless of profile — never inert), or \"auto\"."),
    })
    .strict()
    .optional()
    .describe("Per-phase model aliases. review is honored by both the claude and codex reviewer harnesses; planning/implementing/fix are honored only by the claude implementer harness (codex ignores them). Each key also accepts \"auto\" (#366)."),
  // Per-stage reasoning-effort overrides (#366), parallel to `models`. Each key
  // is independently optional; an absent key emits no effort flag so the
  // operator's global effort setting applies. Also accepts "auto".
  effort: z
    .object({
      planning: modelOrAuto.optional().describe("Reasoning effort for the planning phase (implementer harness), or \"auto\". Also sources plan-review's effort (classified separately as Adversarial/Definitive)."),
      implementing: modelOrAuto.optional().describe("Reasoning effort for the implementing phase (implementer harness), or \"auto\"."),
      review: modelOrAuto.optional().describe("Reasoning effort for the review phase (reviewer harness), or \"auto\". Resolved round-aware (review-1 vs. review-2)."),
      fix: modelOrAuto.optional().describe("Reasoning effort for the fix phase (implementer harness), or \"auto\"."),
      intake: modelOrAuto.optional().describe("Reasoning effort for the intake spec-generation step (always the claude harness), or \"auto\"."),
      sweep: modelOrAuto.optional().describe("Reasoning effort for the sweep spec-generation step (always the claude harness), or \"auto\"."),
    })
    .strict()
    .optional()
    .describe("Per-phase reasoning-effort overrides: codex via -c model_reasoning_effort, claude via --effort (#366)."),
  openspec: z
    .object({
      enabled: z.enum(["auto", "on", "off"]).optional().describe("Whether to require OpenSpec: auto=only when openspec/ exists, on=always, off=never."),
      bootstrap: z.boolean().optional().describe("Run 'openspec init' on repos that lack an openspec/ directory."),
    })
    .strict()
    .optional()
    .describe("OpenSpec spec-driven-development integration settings."),
  last30days: z
    .object({
      enabled: z.boolean().optional().describe("Enable the pre-planning activity brief (opt-in)."),
      timeout: z.number().int().positive().optional().describe("Timeout in seconds for the last-30-days step."),
    })
    .strict()
    .optional()
    .describe("Pre-planning activity brief from the last 30 days of git history."),
  steps: z
    .object({
      plan_review: z.boolean().optional().describe("Cross-harness review of the plan before coding begins."),
      standard_review: z.boolean().optional().describe("First review round (review-1) and its fix round."),
      adversarial_review: z.boolean().optional().describe("Second adversarial review round (review-2) and its fix round."),
      docs: z.boolean().optional().describe("Include documentation update instructions in the implementing prompt."),
    })
    .strict()
    .optional()
    .describe("Toggle optional pipeline steps on or off."),
  // Risk-triggered design-interrogation gate (#436). Opt-in; default disabled
  // so existing repos observe no behavior change. `triggers` selects which
  // built-in risk classes are armed (default: all); `extra_triggers` merges
  // additional path globs into a named class.
  design_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the design-interrogation gate (default false)."),
      triggers: z.array(z.enum(DESIGN_GATE_TRIGGER_CLASSES)).optional().describe("Built-in risk classes armed for trigger evaluation (default: all)."),
      extra_triggers: z
        .partialRecord(z.enum(DESIGN_GATE_TRIGGER_CLASSES), z.array(z.string()))
        .optional()
        .describe("Additional path globs merged into a named trigger class."),
      max_rounds: z.number().int().min(1).optional().describe("Maximum interrogation/response rounds before parking at needs-human (default 2)."),
      block_threshold: z.enum(["critical", "high", "medium", "low"]).optional().describe("Challenges at or above this severity block advancement; below advise only (default medium)."),
      min_confidence: z.number().min(0).max(1).optional().describe("Challenges below this confidence advise rather than block (default 0.6)."),
      limits: z
        .object({
          max_decisions: z.number().int().positive().optional().describe("Maximum decisions retained per record (default 8)."),
          max_field_chars: z.number().int().positive().optional().describe("Maximum characters per free-text field before truncation (default 4000)."),
          max_artifact_bytes: z.number().int().positive().optional().describe("Maximum persisted artifact size in bytes (default 65536)."),
        })
        .strict()
        .optional()
        .describe("Size bounds for the decision-record artifact."),
    })
    .strict()
    .optional()
    .describe("Risk-triggered design-interrogation gate settings (#436). Off by default."),
  test_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the test gate before opening a PR."),
      command: z.string().optional().describe("Explicit test command; auto-detected from lockfile when absent."),
      max_attempts: z.number().int().positive().optional().describe("Maximum fix-harness invocations before blocking."),
      timeout: z.number().int().positive().optional().describe("Seconds per test/build run."),
    })
    .strict()
    .optional()
    .describe("Run the repo's tests/build before opening a PR."),
  eval_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the eval gate (set true to activate; one-time declaration per repo)."),
      command: z.string().optional().describe("Shell command to run evals (required when enabled)."),
      mode: z.enum(["gate", "advisory"]).optional().describe("gate: block on failure; advisory: record result and advance."),
      timeout: z.number().int().positive().optional().describe("Stage-level budget in seconds (shared across attempts)."),
      max_attempts: z.number().int().positive().optional().describe("Total attempts before giving up (1 = no retry)."),
    })
    .strict()
    .optional()
    .describe("Run the repo's eval harness after pre-merge."),
  visual_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the visual gate (set true to activate; one-time declaration per repo)."),
      command: z.string().optional().describe("Shell command to run the E2E/visual suite (required when enabled)."),
      mode: z.enum(["gate", "advisory"]).optional().describe("gate: block on failure; advisory: record result and advance."),
      timeout: z.number().int().positive().optional().describe("Stage-level budget in seconds (shared across attempts)."),
      max_attempts: z.number().int().positive().optional().describe("Total attempts before giving up (1 = no retry)."),
      artifacts_dir: z.string().optional().describe("Worktree-relative directory the command writes screenshots/diffs/traces into."),
    })
    .strict()
    .optional()
    .describe("Run the repo's E2E/visual suite after pre-merge and before eval-gate, capturing artifacts as PR-visible evidence."),
  shipcheck_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the shipcheck gate."),
      mode: z.enum(["advisory", "gate"]).optional().describe("advisory: record findings without blocking; gate: block on failure."),
      max_rounds: z.number().int().min(1).optional().describe("Maximum reviewer invocations before routing to needs-human."),
      rubric_path: z.string().optional().describe("Repo-root-relative path to the Markdown rubric file."),
      block_on_partial: z.boolean().optional().describe("When true and mode=gate, a partial verdict also blocks."),
    })
    .strict()
    .optional()
    .describe("Reviewer-owned acceptance rubric gate after eval-gate."),
  review_policy: z
    .object({
      block_threshold: z.enum(["critical", "high", "medium", "low"]).optional().describe("Findings at or above this severity block progression; below advise only."),
      min_confidence: z.number().min(0).max(1).optional().describe("Findings below this confidence score (0–1) advise rather than block."),
      max_adversarial_rounds: z.number().int().positive().optional().describe("Maximum adversarial review re-runs before routing still-blocking findings to needs-human."),
      risk_proportional: z.boolean().optional().describe("When true and review-1 approved with zero findings (low-risk), review-2 evaluates findings against a raised effective threshold (stricter of configured and 'high'), so medium/low findings advise rather than block. Default false — review-2 blocking unchanged."),
      ceiling_action: z.enum(["park", "demote_and_advance"]).optional().describe("Action at the max_adversarial_rounds round-budget ceiling. park (default): hard-park at needs-human. demote_and_advance: auto-demote below-high findings to advisory, file a follow-up issue, and advance to pre-merge. High/critical findings always park regardless."),
      surface_recurrence_rounds: z.number().int().min(0).optional().describe("Consecutive-round threshold N for the (file + category) surface-recurrence guard (#234). When N same-surface new-key blocking findings appear in N consecutive rounds, the guard fires and routes the cluster through ceiling_action. 0 disables the guard. Default 3."),
    })
    .strict()
    .optional()
    .describe("Controls which review findings block progression vs. merely advise."),
  doctor: z
    .object({
      runOnStart: z.boolean().optional().describe("Run preflight checks before planning; abort on any failure."),
      failFast: z.boolean().optional().describe("Stop at the first failing check instead of collecting all failures."),
    })
    .strict()
    .optional()
    .describe("Deterministic preflight capability check settings."),
  // `pipeline:loop` native-goal capability attestation (#506). Optional;
  // absent/"auto" leaves automatic detection (--help marker, then version
  // floor) unchanged. "available"/"unavailable" is an explicit operator
  // assertion that overrides detection in either direction — see design.md
  // decision 1 and 4 of openspec/changes/loop-native-goal-probe.
  loop: z
    .object({
      native_goal_attestation: z
        .enum(["auto", "available", "unavailable"])
        .optional()
        .describe("Operator attestation of the active engine's native /goal capability: \"auto\" (default) detects automatically; \"available\"/\"unavailable\" overrides detection."),
    })
    .strict()
    .optional()
    .describe("pipeline:loop settings (#506)."),
  // Optional external event sink (#343). Opt-in; unconfigured behavior (local
  // events.jsonl only) is unchanged. `command` names an operator-controlled
  // forwarder that receives each event's JSON line on stdin; `mode` selects
  // additive (local file + sink, default) vs exclusive (sink only). Also
  // overridable via PIPELINE_EVENT_SINK_COMMAND / PIPELINE_EVENT_SINK_MODE.
  event_sink: z
    .object({
      command: z.string().optional().describe("Operator-controlled forwarder command that receives each event JSON line on stdin."),
      mode: z.enum(["additive", "exclusive"]).optional().describe("additive (default): write to the local events.jsonl AND deliver to the sink. exclusive: deliver to the sink only; events.jsonl is not written."),
    })
    .strict()
    .optional()
    .describe("Optional external event sink for run events (#343)."),
  // Opt-in agent-logged friction capture (#419). When enabled, the engine adds
  // identity env vars to harness child processes and injects a prompt
  // instruction telling the agent to log minor friction via `pipeline
  // papercut` instead of stopping. Absent or `enabled: false` → inert.
  papercuts: z
    .object({
      enabled: z.boolean().optional().describe("When true, gate the papercut instruction into prompts and pass run/stage identity to harness child processes."),
      // Opt-in auto-file path (#421). Default off; when on, the engine clusters
      // recurring papercuts and files pipeline:backlog issues without a human
      // running `pipeline improve --apply`.
      auto_file: z.boolean().optional().describe("When true, automatically file pipeline:backlog issues for recurring papercut clusters at run_complete and queue-batch end."),
      auto_file_window_hours: z.number().positive().optional().describe("Trailing window (hours) over which papercut events are clustered for auto-filing."),
      auto_file_max_per_window: z.number().int().positive().optional().describe("Maximum number of issues auto-filed within the trailing window."),
      auto_file_min_occurrences: z.number().int().min(2).optional().describe("Minimum in-window occurrence count a papercut cluster must meet to be auto-filed."),
    })
    .strict()
    .optional()
    .describe("Agent-logged minor-friction capture settings (#419) and opt-in auto-file settings (#421)."),
  // Optional override for the reviewer-role harness (#40). When set, the review
  // step invokes this CLI instead of the profile's default reviewer. An arbitrary
  // string (not an enum) because a custom reviewer CLI name is unconstrained;
  // whether it actually exists is a runtime check (like test_gate/eval_gate
  // `command`). The implementer harness remains profile-only — there is no
  // companion `implementer`/`harnesses` key, and the deleted `harnesses:` block
  // stays rejected by the strict schema.
  // Structured form (#366) adds independent model/effort control for the
  // alternative reviewer harness, alongside the original string shorthand.
  // The string form leaves reviewerModel/reviewerEffort unset so review
  // routing falls back to models.review/effort.review unchanged.
  review_harness: z
    .union([
      z.string(),
      z
        .object({
          command: z.string().describe("Reviewer CLI command (profile default when the whole review_harness key is absent)."),
          model: modelOrAuto.optional().describe("Model override for the reviewer, or \"auto\"."),
          effort: modelOrAuto.optional().describe("Reasoning-effort override for the reviewer, or \"auto\" (resolved round-aware: review-1 Iterative, review-2/plan-review Definitive)."),
          // #492: prompt-delivery channel for a custom reviewer CLI. Default
          // (absent, or "argv") stays the pre-#492 `<cmd> <prompt>` positional
          // shape byte-for-byte; "stdin" opts a CLI that reads its prompt from
          // standard input into that channel instead, which also sidesteps
          // the MAX_ARG_STRLEN per-argument limit for arbitrarily large prompts.
          prompt_delivery: z.enum(["argv", "stdin"]).optional().describe("How the prompt reaches this custom reviewer CLI: \"argv\" (default) as a positional argument, or \"stdin\" written to standard input (avoids the OS per-argument size limit)."),
        })
        .strict(),
    ])
    .optional()
    .describe("Override the reviewer CLI for the review step (profile default when absent). Either a bare command string, or { command, model?, effort?, prompt_delivery? } for independent reviewer model/effort/prompt-delivery control."),
  conventions_md_path: z.string().optional().describe("Repo-root-relative path to the conventions file embedded in stage prompts."),
  domain_name: z.string().optional().describe("Human-readable project name used in prompts and logs."),
  domain_description: z.string().optional().describe("Short description of this repository for prompt context."),
  // Worktree bootstrap: dependency install step (#174). Non-empty string →
  // run that shell command; "" → skip entirely; absent → auto-detect from lockfile.
  setup_command: z.string().optional().describe("Shell command to run in the worktree after creation, before the test gate."),
  // Repo build command run after fix/auto-fix edits (#387). Mirrors setup_command:
  // a bare shell string, run via `bash -c`. Absent → inert, no build runs, no
  // default/guessed command, no auto-detection.
  build_command: z.string().optional().describe("Repo build command run after fix/auto-fix edits; its output is folded into the round commit so committed generated artifacts stay fresh."),
  // Format/lint normalization gate (#182). Each entry runs after implementing
  // and fix-round harnesses exit. auto_fix: true commits changes and re-runs;
  // auto_fix: false blocks on non-zero exit without committing.
  format_gate: z
    .array(
      z.object({ command: z.string(), auto_fix: z.boolean() }).strict(),
    )
    .optional()
    .describe("Formatter/linter commands to run after implementing and fix-round harnesses exit."),
  // Opt-in sandboxed harness execution (#21). When true, the claude implementer
  // uses --permission-mode default instead of bypassPermissions.
  harness_sandbox: z.boolean().optional().describe("Run the claude implementer with --permission-mode default instead of bypassPermissions."),
  // Backlog roadmap engine (#171). Optional per-repo overrides for label
  // filtering, scoring weights, and write-back behaviour.
  roadmap: z
    .object({
      include_labels: z.array(z.string()).optional().describe("Include only issues with at least one of these labels."),
      exclude_labels: z.array(z.string()).optional().describe("Exclude issues that carry any of these labels."),
      score_weights: z
        .object({
          impact: z.number().optional(),
          confidence: z.number().optional(),
          ease: z.number().optional(),
          risk_reduction: z.number().optional(),
          dep_leverage: z.number().optional(),
        })
        .strict()
        .optional()
        .describe("Multiplier overrides for each scoring sub-factor (default: 1.0 each)."),
      hygiene_auto_apply: z.boolean().optional().describe("When true, hygiene actions are applied automatically with --apply (default: false)."),
      pr_docs: z.boolean().optional().describe("When false, skip opening the roadmap.md PR (default: true)."),
      release_model: z.enum(["semver", "continuous"]).optional().describe("How the roadmap groups issues into milestones: 'semver' (default) bundles into version-numbered release lanes; 'continuous' groups by theme/epic for continuous delivery."),
      release_capacity: z
        .object({
          effort_budget: z.number().positive().optional().describe("Per-milestone effort-points capacity budget for the semver model (XS=1 S=2 M=3 L=5 XL=8). An issue with effort_points ≥ budget is isolated into its own milestone. Default: 8."),
          isolate_breaking: z.boolean().optional().describe("When true (default), each breaking-change issue is given its own milestone instead of sharing one with unrelated issues. Tunes capacity-aware semver milestone grouping."),
        })
        .strict()
        .optional()
        .describe("Capacity policy for the semver release model. Controls per-milestone effort budget and breaking-change isolation. Absent block uses capacity-aware defaults."),
      inventory_concurrency: z.number().int().positive().optional().describe("Maximum concurrent harness calls during inventory phase (default: 4)."),
      depgraph_concurrency: z.number().int().positive().optional().describe("Maximum concurrent harness calls during dependency verification (default: 4)."),
      depgraph_verify_cap: z.number().int().positive().optional().describe("Maximum candidates to source-verify; excess go to open_questions (default: 20)."),
    })
    .strict()
    .optional()
    .describe("Backlog roadmap engine settings (#171)."),
  // Sweep backlog maintenance pass (#168). Optional per-repo thresholds for the
  // sufficiency heuristic that determines which issues get re-specced.
  sweep: z
    .object({
      min_body_length: z.number().int().min(0).optional().describe("Minimum body character count for an issue to be considered sufficient (default: 150)."),
      required_sections: z.array(z.string()).optional().describe("Section headings (without ##) that must be present for an issue to be considered sufficient (default: Summary, User story, Acceptance criteria, Out of scope)."),
    })
    .strict()
    .optional()
    .describe("Sweep backlog maintenance pass settings (#168)."),
  // Queue batch factory operation mode (#305). Optional operator defaults.
  // CLI flags take precedence over these config values, which take precedence
  // over the built-in defaults (maxIssues=10, concurrency=1, maxFailureRate=1.0).
  queue: z
    .object({
      max_issues: z.number().int().positive().optional().describe("Maximum number of issues to dispatch in a batch run (default: 10)."),
      budget_dollars: z.number().nonnegative().nullable().optional().describe("Stop launching new runs when cumulative cost reaches this limit in USD; null means unlimited."),
      concurrency: z.number().int().positive().optional().describe("Maximum simultaneously active pipeline runs (default: 1)."),
      max_failure_rate: z.number().min(0).max(1).optional().describe("Halt new launches when failedCount/completedCount reaches this threshold (0.0–1.0); requires at least 3 completed runs (default: 1.0)."),
    })
    .strict()
    .optional()
    .describe("Queue batch factory operation mode defaults (#305). CLI flags override these values."),
  // Multi-actor override trust list (#229). GitHub identities whose
  // `## Pipeline: Finding override` and `## Pipeline: Scope override` comments
  // are trusted in addition to the current actor. Default: [] (actor-only).
  trusted_override_actors: z.array(z.string()).optional().describe("Additional GitHub identities whose override sentinels are trusted besides the current pipeline actor."),
  // Bounded auto-loop mode (#149). Opt-in; disabled by default. When enabled,
  // recoverable stops at allowlisted pipeline-owned stages convert from stop to
  // automatic continuation within explicit round/wall-clock budgets. Parks at
  // `needs-human` with an evidence-backed handoff on exhaustion. Does not grant
  // merge/deploy/publish authority or bypass any human checkpoint.
  auto_loop: z
    .object({
      enabled: z.boolean().optional().describe("Enable bounded auto-loop mode (default false)."),
      max_rounds: z.number().int().positive().optional().describe("Maximum automatic continuations per run before parking at needs-human."),
      max_wallclock_minutes: z.number().int().positive().optional().describe("Wall-clock budget in minutes; independent of max_rounds."),
      stages: z.array(z.enum(STAGES)).optional().describe("Pipeline stages eligible for automatic continuation when a recoverable stop occurs."),
    })
    .strict()
    .optional()
    .describe("Bounded auto-loop mode: continue recoverable stops at allowlisted stages within explicit budgets, then park at needs-human on exhaustion (#149)."),
  // Auto-merge eligibility gate (#306). Opt-in; disabled by default. When enabled,
  // classifies a PR as auto-merge-eligible or needs-human inside shipcheck-gate.
  // Does NOT block ready-to-deploy; produces a classification artifact only.
  auto_merge_eligibility: z
    .object({
      enabled: z.boolean().optional().describe("Enable the auto-merge eligibility gate (default false). When false, the gate is a no-op."),
      max_diff_lines: z.number().int().positive().optional().describe("Hard-deny if total PR diff lines (additions + deletions) exceed this threshold (default 300)."),
      max_files: z.number().int().positive().optional().describe("Hard-deny if changed file count exceeds this threshold (default 10)."),
      deny_paths: z.array(z.string()).optional().describe("Additional glob patterns that always trigger needs-human regardless of other checks (default [])."),
      allow_paths: z.array(z.string()).optional().describe("When non-empty, any changed file not covered by this list triggers needs-human (default [])."),
      min_confidence: z.number().min(0).max(1).optional().describe("LLM judge confidence floor (0–1); outputs below this route to needs-human (default 0.8)."),
    })
    .strict()
    .optional()
    .describe("Auto-merge eligibility gate: classifies PRs as auto-merge-eligible or needs-human after deterministic policy checks and LLM judge evaluation (#306)."),
  // Stage-aware issue context snapshots (#318). Optional per-repo override for
  // the character cap on the human-comment context snapshot injected into
  // planning, review, and shipcheck prompts. Absent → default (8000) applies.
  context_snapshot: z
    .object({
      max_chars: z.number().int().positive().describe("Maximum total character count for human comment bodies in the context snapshot. Oldest entries are dropped first when the cap is exceeded."),
    })
    .strict()
    .optional()
    .describe("Stage-aware issue context snapshot settings (#318)."),
  // Cross-repo dependency map (#312). Declares inter-repo relationships for
  // supplemental planning context and roadmap cross-repo dependency annotations.
  // Declarative only: no cross-repo write, PR creation, label/status sync, or
  // CI gating. Relationships are declared independently per repo; no reverse-edge
  // inference is performed.
  repo_map: z
    .object({
      depends_on: z
        .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo format (exactly one '/')"))
        .optional()
        .describe("Repos this repo consumes (owner/repo strings). The planning stage fetches open issues from these repos as supplemental context."),
      depended_on_by: z
        .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo format (exactly one '/')"))
        .optional()
        .describe("Repos that consume this repo (owner/repo strings). The planning stage fetches open issues from these repos as supplemental context."),
    })
    .strict()
    .optional()
    .describe("Cross-repo dependency map: declares inter-repo relationships for planning context and roadmap cross-repo dependency annotations (#312)."),
  // External stage executors (#314). Opt-in; both keys absent means every
  // model-invoking stage runs through the local claude/codex harness exactly as
  // today. `executors:` declares named provider/endpoint definitions;
  // `stage_executors:` assigns a defined name to a specific stage. The
  // model-endpoint-vs-execution-environment eligibility rule is enforced by
  // `validateStageExecutorAssignments` at parse time (not expressible in this
  // structural schema, since it depends on the *combination* of the two blocks).
  executors: z
    .record(z.string(), ExecutorDefinitionSchema)
    .optional()
    .describe("Named executor definitions (agent-system or model-endpoint) that stage_executors can reference by name."),
  stage_executors: z
    .partialRecord(z.enum(MODEL_INVOKING_STAGES), z.string())
    .optional()
    .describe("Assigns a named executor (from executors:) to a model-invoking stage, delegating that stage's execution to it instead of the local harness."),
}).strict();

type PartialConfig = z.infer<typeof PartialConfigSchema>;

const EXECUTION_ENVIRONMENT_STAGE_SET = new Set<string>(EXECUTION_ENVIRONMENT_STAGES);

/**
 * Enforce the model-endpoint / execution-environment stage-eligibility matrix
 * (#314) at config-parse time, never mid-run: every `stage_executors:` name
 * must exist in `executors:`, and a `model-endpoint`-type executor may only be
 * assigned to a prompt-contained stage. Throws a single Error naming the
 * offending stage + executor on the first violation found; a no-op when either
 * block is absent (parity with pre-#314 configs).
 */
function validateStageExecutorAssignments(fileConfig: PartialConfig): void {
  if (!fileConfig.stage_executors) return;
  for (const [stage, name] of Object.entries(fileConfig.stage_executors)) {
    const definition = fileConfig.executors?.[name];
    if (!definition) {
      throw new Error(
        `stage_executors.${stage} references unknown executor "${name}" — add it under executors:`,
      );
    }
    if (definition.type === "model-endpoint" && EXECUTION_ENVIRONMENT_STAGE_SET.has(stage)) {
      throw new Error(
        `stage "${stage}" cannot be assigned model-endpoint executor "${name}" — model-endpoint ` +
          `executors are only valid for prompt-contained stages (plan-review, review-1, review-2); ` +
          `"${stage}" requires repo/tool access and needs an agent-system executor or the local harness`,
      );
    }
  }
}

export interface ResolveOptions {
  repoPath?: string;        // path to the target repo's working tree
  domainOverride?: string;  // --domain X (used as the "domain" name in logs)
  baseBranch?: string;      // --base
  profile?: string;         // shared-core profile name
  tolerateInvalidConfig?: boolean; // warn + fall back to defaults instead of throwing on invalid config (used by init)
  /** When true, a `gh repo view` failure sets repo="" instead of throwing.
   *  Used by `pipeline doctor` so the command can run its own cli/auth/repo-access
   *  checks and report proper remediation even when gh is missing or auth is expired. */
  tolerateGhFailure?: boolean;
  /** When true, suppress non-fatal config-resolution warnings (`console.warn`).
   *  Used by `pipeline doctor --is-ok`, whose documented contract is a zero-output
   *  0/1 polling gate — a valid config that merely emits a warning (e.g. an inert
   *  `models.*` alias) must not write to stderr (#154). */
  quiet?: boolean;
}

/**
 * Resolve a PipelineConfig from cwd or explicit repoPath:
 *   1. Walk up from repoPath / cwd to find a .git dir → that's the repo root.
 *   2. Discover owner/name via `gh repo view`.
 *   3. If `<repo>/.github/pipeline.yml` exists, parse + validate; merge with defaults.
 *   4. CLI overrides (baseBranch) win.
 */
export function resolveConfig(opts: ResolveOptions = {}): PipelineConfig {
  const profile = loadProfile(opts.profile ?? process.env.PIPELINE_PROFILE ?? "codex");
  const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
  const repoDir = findGitRoot(startDir);
  if (!repoDir) {
    throw new Error(
      `${profile.invocation}: no git repo found at or above ${startDir}. Run from inside a checkout, or pass --repo-path.`,
    );
  }

  // Load file config BEFORE gh repo discovery so doctor.runOnStart can be
  // detected and incorporated into tolerateGhFailure. Without this ordering a
  // repo with doctor.runOnStart: true would still exit via the generic config-
  // error path when gh is missing/auth-expired — before the preflight gate ran.
  const configPath = path.join(repoDir, ".github", "pipeline.yml");
  let fileConfig: z.infer<typeof PartialConfigSchema> = {};
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === "object") {
      const result = PartialConfigSchema.safeParse(parsed);
      if (!result.success) {
        const errors = flattenIssues(result.error.issues)
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        if (opts.tolerateInvalidConfig) {
          if (!opts.quiet) {
            console.warn(`[pipeline] init: ${configPath} has validation errors — using defaults. Fix the file to apply custom settings.\n  ${errors}`);
          }
          // fileConfig stays as {} — all defaults apply
        } else {
          throw new Error(`Invalid ${configPath}: ${errors}`);
        }
      } else {
        fileConfig = result.data;
        try {
          validateStageExecutorAssignments(fileConfig);
        } catch (err) {
          const message = (err as Error).message;
          if (opts.tolerateInvalidConfig) {
            if (!opts.quiet) {
              console.warn(`[pipeline] init: ${configPath} has validation errors — using defaults. Fix the file to apply custom settings.\n  ${message}`);
            }
            fileConfig = { ...fileConfig, executors: undefined, stage_executors: undefined };
          } else {
            throw new Error(`Invalid ${configPath}: ${message}`);
          }
        }
      }
    }
  }

  // tolerateGhFailure: caller flag (standalone doctor / --doctor) OR
  // doctor.runOnStart: true from the local config.  In both cases resolveConfig
  // must not throw on a gh failure so that the preflight gate can run and report
  // the real CLI/auth/repo-access failure with actionable remediation text.
  const tolerateGhFailure = opts.tolerateGhFailure || (fileConfig.doctor?.runOnStart === true);

  // Discover owner/name via gh.
  let repo: string;
  try {
    const out = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    repo = out.trim();
  } catch (err) {
    if (!tolerateGhFailure) {
      throw new Error(
        `Failed to discover GitHub repo for ${repoDir} via 'gh repo view'. Make sure 'gh' is authenticated.`,
      );
    }
    // gh unavailable or auth expired: set repo="" so the caller can still run
    // doctor checks (cli:gh, github-auth, repo-access) which surface the real failure.
    repo = "";
  }

  // External event sink (#343). Env vars override file config, consistent
  // with CLI-over-file precedence used elsewhere in this loader. Absent
  // command (from both file and env) means no active sink.
  const envSinkMode = process.env.PIPELINE_EVENT_SINK_MODE;
  if (envSinkMode !== undefined && envSinkMode !== "additive" && envSinkMode !== "exclusive") {
    throw new Error(
      `Invalid PIPELINE_EVENT_SINK_MODE: "${envSinkMode}" (must be "additive" or "exclusive").`,
    );
  }
  const sinkCommand = process.env.PIPELINE_EVENT_SINK_COMMAND ?? fileConfig.event_sink?.command;
  const eventSink = sinkCommand
    ? {
        command: sinkCommand,
        mode: (envSinkMode as "additive" | "exclusive" | undefined) ?? fileConfig.event_sink?.mode ?? "additive",
      }
    : undefined;

  // Reviewer-model alias guard (#454): a Claude-only reviewer model alias
  // (`models.review` or `review_harness.model`) against a codex reviewer must
  // be rejected here, at config-parse time — #441 made the reviewer alias
  // load-bearing (passed through to `codex exec -m <model>`), so a config that
  // pre-#441 harmlessly carried a Claude alias against codex (previously
  // inert) now 400s mid-run instead. Runs before the review_harness
  // destructuring below so a tolerated violation is stripped from fileConfig
  // before it's read into reviewerCommand/reviewerModelRaw.
  {
    const reviewHarnessCfgForGuard = fileConfig.review_harness;
    const reviewerCommandForGuard =
      typeof reviewHarnessCfgForGuard === "string" ? reviewHarnessCfgForGuard : reviewHarnessCfgForGuard?.command;
    const effectiveReviewerHarness = reviewerCommandForGuard ?? profile.harnesses.reviewer;
    const violation = findReviewerModelAliasViolation(fileConfig, effectiveReviewerHarness);
    if (violation) {
      const message = reviewerModelAliasErrorMessage(violation.path, violation.value, effectiveReviewerHarness);
      if (opts.tolerateInvalidConfig) {
        if (!opts.quiet) {
          console.warn(
            `[pipeline] init: ${configPath} has validation errors — using defaults. Fix the file to apply custom settings.\n  ${message}`,
          );
        }
        fileConfig =
          violation.path === "models.review"
            ? { ...fileConfig, models: { ...fileConfig.models, review: undefined } }
            : {
                ...fileConfig,
                review_harness:
                  typeof fileConfig.review_harness === "object"
                    ? { ...fileConfig.review_harness, model: undefined }
                    : fileConfig.review_harness,
              };
      } else {
        throw new Error(`Invalid ${configPath}: ${message}`);
      }
    }
  }

  // review_harness (#40, #366): either a bare command string, or a structured
  // { command, model?, effort? } form that additionally targets the reviewer's
  // own model/effort. The string form leaves reviewerModel/reviewerEffort
  // unset, so review-routing/plan-review fall back to models.review/effort.review.
  const reviewHarnessCfg = fileConfig.review_harness;
  const reviewerCommand = typeof reviewHarnessCfg === "string" ? reviewHarnessCfg : reviewHarnessCfg?.command;
  const reviewerModelRaw = typeof reviewHarnessCfg === "object" ? reviewHarnessCfg.model : undefined;
  const reviewerEffortRaw = typeof reviewHarnessCfg === "object" ? reviewHarnessCfg.effort : undefined;
  // #492: defaults to "argv" — the pre-#492 `<cmd> <prompt>` positional shape.
  const reviewerPromptDelivery =
    typeof reviewHarnessCfg === "object" ? (reviewHarnessCfg.prompt_delivery ?? "argv") : "argv";
  const implementerHarness = profile.harnesses.implementer;

  const merged: PipelineConfig = {
    profile_name: profile.name,
    invocation: profile.invocation,
    review_mode: profile.reviewMode,
    marker_footer: profile.markerFooter,
    implementation_ready_message: profile.implementationReadyMessage,
    conventions_default: profile.conventionsDefault,
    domain: opts.domainOverride ?? path.basename(repoDir),
    repo: fileConfig.repo ?? repo,
    repo_dir: repoDir,
    base_branch: opts.baseBranch ?? fileConfig.base_branch ?? DEFAULT_CONFIG.base_branch,
    worktree_root: fileConfig.worktree_root ?? DEFAULT_CONFIG.worktree_root,
    max_concurrent_worktrees:
      fileConfig.max_concurrent_worktrees ?? DEFAULT_CONFIG.max_concurrent_worktrees,
    auto_recovery_max_retries:
      fileConfig.auto_recovery_max_retries ?? DEFAULT_CONFIG.auto_recovery_max_retries,
    implementation_timeout:
      fileConfig.implementation_timeout ?? DEFAULT_CONFIG.implementation_timeout,
    review_timeout: fileConfig.review_timeout ?? DEFAULT_CONFIG.review_timeout,
    plan_review_timeout: fileConfig.plan_review_timeout ?? DEFAULT_CONFIG.plan_review_timeout,
    fix_timeout: fileConfig.fix_timeout ?? DEFAULT_CONFIG.fix_timeout,
    intake_timeout: fileConfig.intake_timeout ?? DEFAULT_CONFIG.intake_timeout,
    sweep_timeout: fileConfig.sweep_timeout ?? DEFAULT_CONFIG.sweep_timeout,
    ci_timeout: fileConfig.ci_timeout ?? DEFAULT_CONFIG.ci_timeout,
    ci_poll_interval: fileConfig.ci_poll_interval ?? DEFAULT_CONFIG.ci_poll_interval,
    ci_no_run_grace_s: fileConfig.ci_no_run_grace_s ?? DEFAULT_CONFIG.ci_no_run_grace_s,
    ci_mode: fileConfig.ci_mode ?? DEFAULT_CONFIG.ci_mode,
    // Harness roles are profile-relative; the implementer can never be set by
    // repo config (the strict schema rejects a `harnesses:` key outright). The
    // reviewer defaults to the profile's value but is overridden here by the
    // optional `review_harness` key (#40) when present, so all stage code can
    // keep reading only `cfg.harnesses.reviewer`. reviewerModel is fully
    // resolved (Adversarial `auto` is model-invariant across rounds);
    // reviewerEffort is left as-authored (possibly "auto") since its
    // resolution is round-aware and happens at each reviewer call site.
    harnesses: {
      implementer: implementerHarness,
      reviewer: reviewerCommand ?? profile.harnesses.reviewer,
      reviewerModel: expandAutoModel(reviewerModelRaw, "review-2", "claude"),
      reviewerModelWasAuto: reviewerModelRaw === "auto",
      reviewerEffort: reviewerEffortRaw,
      reviewerPromptDelivery,
    },
    models: {
      planning: expandAutoModel(fileConfig.models?.planning, "planning", implementerHarness) ?? DEFAULT_CONFIG.models.planning,
      implementing: expandAutoModel(fileConfig.models?.implementing, "implementing", implementerHarness) ?? DEFAULT_CONFIG.models.implementing,
      review: expandAutoModel(fileConfig.models?.review, "review-2", "claude") ?? DEFAULT_CONFIG.models.review,
      // Undefined (no `models.review` in file config) resolves to the same
      // claude-fable-5 default as an explicit `"auto"`, and must be treated
      // identically by the reviewer-model guard (#441 finding 3e79bbb5):
      // without a user-authored non-auto value, a codex reviewer must still
      // fall back to its own default rather than receive a claude-only alias.
      reviewWasAuto: fileConfig.models?.review === "auto" || fileConfig.models?.review === undefined,
      fix: expandAutoModel(fileConfig.models?.fix, "fix", implementerHarness) ?? DEFAULT_CONFIG.models.fix,
      intake: expandAutoModel(fileConfig.models?.intake, "intake", "claude") ?? DEFAULT_CONFIG.models.intake,
      sweep: expandAutoModel(fileConfig.models?.sweep, "sweep", "claude") ?? DEFAULT_CONFIG.models.sweep,
    },
    // effort.review is deliberately left as-authored (possibly "auto"): it
    // backs review-1 (Iterative) and review-2 (Definitive), which resolve
    // "auto" differently, so round-aware expansion happens in review-routing.ts.
    // The rest are single-stage keys, fully resolved here.
    effort: {
      planning: expandAutoEffort(fileConfig.effort?.planning, "planning", implementerHarness),
      implementing: expandAutoEffort(fileConfig.effort?.implementing, "implementing", implementerHarness),
      review: fileConfig.effort?.review,
      fix: expandAutoEffort(fileConfig.effort?.fix, "fix", implementerHarness),
      intake: expandAutoEffort(fileConfig.effort?.intake, "intake", "claude"),
      sweep: expandAutoEffort(fileConfig.effort?.sweep, "sweep", "claude"),
    },
    // Plan-review's own resolved effort: same `effort.planning` config key as
    // above, but classified Adversarial/Definitive (not Analytical/Iterative
    // like the `planning` stage itself) — see stage-routing.ts. Defaults to
    // "medium" when effort.planning is unset, preserving the prior hardcoded cap.
    plan_review_effort: expandAutoEffort(fileConfig.effort?.planning, "plan-review", "claude") ?? DEFAULT_CONFIG.plan_review_effort,
    openspec: {
      enabled: fileConfig.openspec?.enabled ?? DEFAULT_CONFIG.openspec.enabled,
      bootstrap: fileConfig.openspec?.bootstrap ?? DEFAULT_CONFIG.openspec.bootstrap,
    },
    last30days: {
      enabled: fileConfig.last30days?.enabled ?? DEFAULT_CONFIG.last30days.enabled,
      timeout: fileConfig.last30days?.timeout ?? DEFAULT_CONFIG.last30days.timeout,
    },
    steps: {
      plan_review: fileConfig.steps?.plan_review ?? DEFAULT_CONFIG.steps.plan_review,
      standard_review: fileConfig.steps?.standard_review ?? DEFAULT_CONFIG.steps.standard_review,
      adversarial_review: fileConfig.steps?.adversarial_review ?? DEFAULT_CONFIG.steps.adversarial_review,
      docs: fileConfig.steps?.docs ?? DEFAULT_CONFIG.steps.docs,
    },
    design_gate: {
      enabled: fileConfig.design_gate?.enabled ?? DEFAULT_CONFIG.design_gate.enabled,
      triggers: fileConfig.design_gate?.triggers ?? DEFAULT_CONFIG.design_gate.triggers,
      extra_triggers: fileConfig.design_gate?.extra_triggers ?? DEFAULT_CONFIG.design_gate.extra_triggers,
      max_rounds: fileConfig.design_gate?.max_rounds ?? DEFAULT_CONFIG.design_gate.max_rounds,
      block_threshold: fileConfig.design_gate?.block_threshold ?? DEFAULT_CONFIG.design_gate.block_threshold,
      min_confidence: fileConfig.design_gate?.min_confidence ?? DEFAULT_CONFIG.design_gate.min_confidence,
      limits: {
        max_decisions: fileConfig.design_gate?.limits?.max_decisions ?? DEFAULT_CONFIG.design_gate.limits.max_decisions,
        max_field_chars: fileConfig.design_gate?.limits?.max_field_chars ?? DEFAULT_CONFIG.design_gate.limits.max_field_chars,
        max_artifact_bytes: fileConfig.design_gate?.limits?.max_artifact_bytes ?? DEFAULT_CONFIG.design_gate.limits.max_artifact_bytes,
      },
    },
    test_gate: {
      enabled: fileConfig.test_gate?.enabled ?? DEFAULT_CONFIG.test_gate.enabled,
      command: fileConfig.test_gate?.command,
      max_attempts: fileConfig.test_gate?.max_attempts ?? DEFAULT_CONFIG.test_gate.max_attempts,
      timeout: fileConfig.test_gate?.timeout ?? DEFAULT_CONFIG.test_gate.timeout,
    },
    eval_gate: {
      enabled: fileConfig.eval_gate?.enabled ?? DEFAULT_CONFIG.eval_gate.enabled,
      command: fileConfig.eval_gate?.command,
      mode: fileConfig.eval_gate?.mode ?? DEFAULT_CONFIG.eval_gate.mode,
      timeout: fileConfig.eval_gate?.timeout ?? DEFAULT_CONFIG.eval_gate.timeout,
      max_attempts: fileConfig.eval_gate?.max_attempts ?? DEFAULT_CONFIG.eval_gate.max_attempts,
    },
    visual_gate: {
      enabled: fileConfig.visual_gate?.enabled ?? DEFAULT_CONFIG.visual_gate.enabled,
      command: fileConfig.visual_gate?.command,
      mode: fileConfig.visual_gate?.mode ?? DEFAULT_CONFIG.visual_gate.mode,
      timeout: fileConfig.visual_gate?.timeout ?? DEFAULT_CONFIG.visual_gate.timeout,
      max_attempts: fileConfig.visual_gate?.max_attempts ?? DEFAULT_CONFIG.visual_gate.max_attempts,
      artifacts_dir: fileConfig.visual_gate?.artifacts_dir ?? DEFAULT_CONFIG.visual_gate.artifacts_dir,
    },
    shipcheck_gate: {
      enabled: fileConfig.shipcheck_gate?.enabled ?? DEFAULT_CONFIG.shipcheck_gate.enabled,
      mode: fileConfig.shipcheck_gate?.mode ?? DEFAULT_CONFIG.shipcheck_gate.mode,
      max_rounds: fileConfig.shipcheck_gate?.max_rounds ?? DEFAULT_CONFIG.shipcheck_gate.max_rounds,
      rubric_path: fileConfig.shipcheck_gate?.rubric_path ?? DEFAULT_CONFIG.shipcheck_gate.rubric_path,
      block_on_partial: fileConfig.shipcheck_gate?.block_on_partial ?? DEFAULT_CONFIG.shipcheck_gate.block_on_partial,
    },
    review_policy: {
      block_threshold:
        fileConfig.review_policy?.block_threshold ?? DEFAULT_CONFIG.review_policy.block_threshold,
      min_confidence:
        fileConfig.review_policy?.min_confidence ?? DEFAULT_CONFIG.review_policy.min_confidence,
      max_adversarial_rounds:
        fileConfig.review_policy?.max_adversarial_rounds ??
        DEFAULT_CONFIG.review_policy.max_adversarial_rounds,
      risk_proportional:
        fileConfig.review_policy?.risk_proportional ?? DEFAULT_CONFIG.review_policy.risk_proportional,
      ceiling_action:
        fileConfig.review_policy?.ceiling_action ?? DEFAULT_CONFIG.review_policy.ceiling_action,
      surface_recurrence_rounds:
        fileConfig.review_policy?.surface_recurrence_rounds ??
        DEFAULT_CONFIG.review_policy.surface_recurrence_rounds,
    },
    doctor: {
      runOnStart: fileConfig.doctor?.runOnStart ?? DEFAULT_CONFIG.doctor.runOnStart,
      failFast: fileConfig.doctor?.failFast ?? DEFAULT_CONFIG.doctor.failFast,
    },
    loop: {
      native_goal_attestation:
        fileConfig.loop?.native_goal_attestation ?? DEFAULT_CONFIG.loop.native_goal_attestation,
    },
    papercuts: {
      enabled: fileConfig.papercuts?.enabled ?? DEFAULT_CONFIG.papercuts.enabled,
      auto_file: fileConfig.papercuts?.auto_file ?? DEFAULT_CONFIG.papercuts.auto_file,
      auto_file_window_hours:
        fileConfig.papercuts?.auto_file_window_hours ?? DEFAULT_CONFIG.papercuts.auto_file_window_hours,
      auto_file_max_per_window:
        fileConfig.papercuts?.auto_file_max_per_window ?? DEFAULT_CONFIG.papercuts.auto_file_max_per_window,
      auto_file_min_occurrences:
        fileConfig.papercuts?.auto_file_min_occurrences ?? DEFAULT_CONFIG.papercuts.auto_file_min_occurrences,
    },
    conventions_md_path: fileConfig.conventions_md_path,
    domain_name: fileConfig.domain_name,
    domain_description: fileConfig.domain_description,
    setup_command: fileConfig.setup_command,
    build_command: fileConfig.build_command,
    format_gate: fileConfig.format_gate ?? DEFAULT_CONFIG.format_gate,
    harness_sandbox: fileConfig.harness_sandbox ?? DEFAULT_CONFIG.harness_sandbox,
    trusted_override_actors: fileConfig.trusted_override_actors,
    auto_loop: {
      enabled: fileConfig.auto_loop?.enabled ?? DEFAULT_CONFIG.auto_loop.enabled,
      max_rounds: fileConfig.auto_loop?.max_rounds ?? DEFAULT_CONFIG.auto_loop.max_rounds,
      max_wallclock_minutes: fileConfig.auto_loop?.max_wallclock_minutes ?? DEFAULT_CONFIG.auto_loop.max_wallclock_minutes,
      stages: fileConfig.auto_loop?.stages ?? DEFAULT_CONFIG.auto_loop.stages,
    },
    roadmap: fileConfig.roadmap
      ? { ...fileConfig.roadmap, release_model: fileConfig.roadmap.release_model ?? "semver" }
      : fileConfig.roadmap,
    sweep: fileConfig.sweep,
    queue: fileConfig.queue,
    context_snapshot: fileConfig.context_snapshot,
    auto_merge_eligibility: {
      enabled: fileConfig.auto_merge_eligibility?.enabled ?? DEFAULT_CONFIG.auto_merge_eligibility.enabled,
      max_diff_lines: fileConfig.auto_merge_eligibility?.max_diff_lines ?? DEFAULT_CONFIG.auto_merge_eligibility.max_diff_lines,
      max_files: fileConfig.auto_merge_eligibility?.max_files ?? DEFAULT_CONFIG.auto_merge_eligibility.max_files,
      deny_paths: fileConfig.auto_merge_eligibility?.deny_paths ?? DEFAULT_CONFIG.auto_merge_eligibility.deny_paths,
      allow_paths: fileConfig.auto_merge_eligibility?.allow_paths ?? DEFAULT_CONFIG.auto_merge_eligibility.allow_paths,
      min_confidence: fileConfig.auto_merge_eligibility?.min_confidence ?? DEFAULT_CONFIG.auto_merge_eligibility.min_confidence,
    },
    repo_map: {
      depends_on: fileConfig.repo_map?.depends_on ?? DEFAULT_CONFIG.repo_map.depends_on,
      depended_on_by: fileConfig.repo_map?.depended_on_by ?? DEFAULT_CONFIG.repo_map.depended_on_by,
    },
    event_sink: eventSink,
    executors: fileConfig.executors ?? DEFAULT_CONFIG.executors,
    stage_executors: fileConfig.stage_executors ?? DEFAULT_CONFIG.stage_executors,
  };
  if (!opts.quiet) {
    warnInertModelAliases(fileConfig.models, merged.harnesses);
    warnInertEffort(fileConfig.effort, merged.harnesses);
  }
  return merged;
}

/**
 * Find a Claude-only reviewer model alias configured against a codex reviewer
 * (#454). Checks both reviewer model sources — `models.review` and the
 * structured `review_harness.model` — against the same effective
 * `reviewerHarness` (the caller resolves `review_harness.command` overriding
 * the profile default, exactly as `resolveConfig()`'s `merged.harnesses.reviewer`
 * does). Only an explicit (non-`"auto"`) value is a violation: `"auto"`
 * resolves through its own claude-only-alias guard at the reviewer call site
 * (`resolveReviewerModelForHarness` in stage-routing.ts), never reaching codex.
 * `review_harness.model` is checked first since, when both are set, it is the
 * value that actually reaches the reviewer invocation.
 */
function findReviewerModelAliasViolation(
  fileConfig: z.infer<typeof PartialConfigSchema>,
  reviewerHarness: string,
): { path: "review_harness.model" | "models.review"; value: string } | undefined {
  if (reviewerHarness !== "codex") return undefined;
  const reviewHarnessCfg = fileConfig.review_harness;
  const reviewerModelRaw = typeof reviewHarnessCfg === "object" ? reviewHarnessCfg.model : undefined;
  if (reviewerModelRaw !== undefined && reviewerModelRaw !== "auto" && isClaudeOnlyModelAlias(reviewerModelRaw)) {
    return { path: "review_harness.model", value: reviewerModelRaw };
  }
  const reviewModelRaw = fileConfig.models?.review;
  if (reviewModelRaw !== undefined && reviewModelRaw !== "auto" && isClaudeOnlyModelAlias(reviewModelRaw)) {
    return { path: "models.review", value: reviewModelRaw };
  }
  return undefined;
}

function reviewerModelAliasErrorMessage(path: string, value: string, harness: string): string {
  return (
    `${path} is set to "${value}", a Claude-only model alias, but the reviewer harness is "${harness}" — ` +
    `codex does not support Claude model aliases and will reject it mid-run. Use an account-supported ` +
    `OpenAI model id (e.g. "gpt-5.6-terra" or a "gpt-5.x-codex" model), or "auto" to let the pipeline ` +
    `resolve a codex-appropriate default (falling back to your ~/.codex/config.toml default model).`
  );
}

// Each `models.*` alias is honored by exactly one harness role. `models.review`
// drives the reviewer; `models.planning`/`models.implementing`/`models.fix` drive
// the implementer.
const MODEL_ALIAS_ROLES = [
  { key: "review", role: "reviewer" },
  { key: "planning", role: "implementer" },
  { key: "implementing", role: "implementer" },
  { key: "fix", role: "implementer" },
] as const;

/**
 * Warn (non-blocking) about `models.*` aliases that were explicitly set in
 * `.github/pipeline.yml` but are silently inert because the backing harness
 * ignores model aliases for that role:
 * - implementer-role keys (`planning`/`implementing`/`fix`): inert when the
 *   implementer harness is `codex` (implementer model passthrough is not
 *   implemented — `harness.ts` passes `--model` only on the `claude` branch).
 * - the reviewer-role key (`review`): inert only when the reviewer is a
 *   **custom** CLI (neither `claude` nor `codex`) — the codex reviewer now
 *   honors the model via `codex exec -m <model>`.
 * Advisory only: no throw, no fallback, and the resolved config is unchanged
 * (the inert alias is preserved in `config.models`). Keys absent from
 * `fileConfig.models` take their value from DEFAULT_CONFIG and never warn —
 * only user-authored, inert config does.
 */
function warnInertModelAliases(
  fileModels: z.infer<typeof PartialConfigSchema>["models"],
  harnesses: PipelineConfig["harnesses"],
): void {
  if (!fileModels) return;
  for (const { key, role } of MODEL_ALIAS_ROLES) {
    const value = fileModels[key];
    if (value === undefined) continue;
    const harness = harnesses[role];
    const isInert = role === "reviewer" ? harness !== "claude" && harness !== "codex" : harness === "codex";
    if (!isInert) continue;
    console.warn(
      `[pipeline] config warning: models.${key} is set to "${value}" but the ${role} harness is "${harness}" — model aliases are not honored by that harness. The setting is ignored.`,
    );
  }
}

/**
 * Warn (non-blocking) about `effort.review` when the effective reviewer is a
 * custom CLI (`review_harness` set to something other than "claude" or
 * "codex"), which honors neither `--model` nor `--effort`. Both built-in
 * harnesses honor per-stage effort (claude via `--effort`, codex via
 * `-c model_reasoning_effort`), so `effort.planning`/`implementing`/`fix`/
 * `intake`/`sweep` can never be inert — only a custom reviewer CLI backing
 * `effort.review` can be. Advisory only: no throw, and the resolved config is
 * unchanged (the inert value is preserved in `config.effort.review`).
 */
function warnInertEffort(
  fileEffort: z.infer<typeof PartialConfigSchema>["effort"],
  harnesses: PipelineConfig["harnesses"],
): void {
  const value = fileEffort?.review;
  if (value === undefined) return;
  if (harnesses.reviewer === "claude" || harnesses.reviewer === "codex") return;
  console.warn(
    `[pipeline] config warning: effort.review is set to "${value}" but the reviewer is the custom CLI "${harnesses.reviewer}" — it accepts neither a --model nor an --effort flag, so per-stage effort is ignored.`,
  );
}

export function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the minimal config needed by `pipeline release` without calling `gh`.
 * Reads repo_dir from the provided git root and base_branch from pipeline.yml
 * (local file only — no network calls).
 *
 * Uses the same YAML parse + Zod schema validation as resolveConfig, so a
 * malformed or schema-violating config surfaces an error rather than silently
 * falling back to "main". Falls back to the default branch only when the config
 * file is absent or base_branch is genuinely unset.
 */
export function resolveReleaseConfig(
  repoDir: string,
  baseBranchOverride?: string,
): { repo_dir: string; repo: string; base_branch: string; release_model?: 'semver' | 'continuous'; intake_model: string; intake_effort?: string; intake_timeout: number } {
  let baseBranch = DEFAULT_CONFIG.base_branch;
  let releaseModel: 'semver' | 'continuous' | undefined;
  // Intake always runs through the claude harness (see stages/intake.ts), so this
  // alias is never inert; default it here and let pipeline.yml's models.intake override.
  let intakeModel: string = DEFAULT_CONFIG.models.intake;
  // effort.intake likewise always reaches the claude harness; unset by default so no
  // --effort flag is emitted (#366 review-1 finding: previously accepted but dropped).
  let intakeEffort: string | undefined;
  let intakeTimeout: number = DEFAULT_CONFIG.intake_timeout;
  const configPath = path.join(repoDir, ".github", "pipeline.yml");
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    // yaml.load throws YAMLException on malformed YAML — propagate to surface the config problem.
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === "object") {
      const result = PartialConfigSchema.safeParse(parsed);
      if (!result.success) {
        const errors = flattenIssues(result.error.issues)
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid ${configPath}: ${errors}`);
      }
      if (typeof result.data.base_branch === "string") {
        baseBranch = result.data.base_branch;
      }
      if (result.data.roadmap?.release_model) {
        releaseModel = result.data.roadmap.release_model;
      }
      if (result.data.models?.intake) {
        intakeModel = expandAutoModel(result.data.models.intake, "intake", "claude") ?? intakeModel;
      }
      if (result.data.effort?.intake) {
        intakeEffort = expandAutoEffort(result.data.effort.intake, "intake", "claude");
      }
      if (typeof result.data.intake_timeout === "number") {
        intakeTimeout = result.data.intake_timeout;
      }
    }
  }
  return {
    repo_dir: repoDir,
    repo: "",
    base_branch: baseBranchOverride ?? baseBranch,
    release_model: releaseModel,
    intake_model: intakeModel,
    intake_effort: intakeEffort,
    intake_timeout: intakeTimeout,
  };
}

/**
 * Resolve just `loop.native_goal_attestation` from `.github/pipeline.yml`,
 * with no `gh` call — mirrors {@link resolveReleaseConfig}'s gh-free pattern.
 * `pipeline:loop` preflight (loop-preflight.ts) must stay read-only and make
 * zero external calls before its checks pass, so it cannot go through
 * `resolveConfig()` (which always shells out to `gh repo view`).
 */
export function resolveLoopNativeGoalAttestation(repoDir: string): "auto" | "available" | "unavailable" {
  const configPath = path.join(repoDir, ".github", "pipeline.yml");
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG.loop.native_goal_attestation;
  const text = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== "object") return DEFAULT_CONFIG.loop.native_goal_attestation;
  const result = PartialConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = flattenIssues(result.error.issues)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid ${configPath}: ${errors}`);
  }
  return result.data.loop?.native_goal_attestation ?? DEFAULT_CONFIG.loop.native_goal_attestation;
}

/**
 * Read the conventions excerpt to embed in stage prompts. Falls back to a
 * stub if the configured path doesn't exist. Truncates to keep prompts
 * focused.
 */
export function readConventions(cfg: PipelineConfig, capChars = 8000): string {
  const filePath = cfg.conventions_md_path
    ? path.resolve(cfg.repo_dir, cfg.conventions_md_path)
    : path.join(cfg.repo_dir, cfg.conventions_default ?? "CLAUDE.md");
  if (!fs.existsSync(filePath)) {
    return "(no conventions file found — agents will use repo conventions inferred from the codebase)";
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length <= capChars) return text;

  // Cap for any preserved carry-forward content to keep total output bounded.
  const sectionCap = Math.floor(capChars / 4);

  // Scan for ALL supported carry-forward headings — Lessons or Gotchas (including
  // combined headings like "Lessons / Gotchas") — anywhere in the file. A
  // maintainer-curated section can sit at any depth, so we preserve every such
  // section the plain cap would drop or clip, not just the first match. (Looking
  // at only the first heading let an early in-cap section hide a later after-cap
  // one — the #19 review-ceiling finding.) Each section ends at the next heading
  // of the same or higher level (or EOF).
  const carryRe = /^(#+)[ \t]+(Lessons|Gotchas)\b/gim;
  const sections = [...text.matchAll(carryRe)].map((m) => {
    const level = m[1]!.length;
    const headingLineEnd = text.indexOf("\n", m.index);
    const afterHeadingLine = headingLineEnd >= 0 ? text.slice(headingLineEnd + 1) : "";
    const nextHeadingRe = new RegExp(`^#{1,${level}}[ \\t]+`, "m");
    const nextM = nextHeadingRe.exec(afterHeadingLine);
    const end = nextM ? headingLineEnd + 1 + nextM.index : text.length;
    return { start: m.index, end };
  });

  // A section is "at risk" of truncation when it is not fully inside the head
  // excerpt: its body extends past the cap, or it starts after the cap entirely.
  // Sections wholly within the head already ride along in text.slice(0, capChars).
  const atRisk = sections.filter((s) => s.end > capChars);
  if (atRisk.length === 0) {
    return text.slice(0, capChars) + "\n\n[…conventions truncated]";
  }

  // If any at-risk section crosses the cap boundary, cut the head at that
  // section's start so the section is included whole exactly once (no
  // duplication). Otherwise keep the full head and append the after-cap section(s).
  const crossing = atRisk.filter((s) => s.start < capChars);
  const headCut = crossing.length ? Math.min(...crossing.map((s) => s.start)) : capChars;

  let out = text.slice(0, headCut).trimEnd() + "\n\n[…conventions truncated]";
  // Water-fill the carry-forward budget (sectionCap) across at-risk sections in
  // document order. Before spending on a section, RESERVE a minimum share for each
  // later section the budget can still afford, then let this section use whatever
  // is left over its own minimum. One rule, all layouts:
  //   • the reserve stops an earlier/larger section from consuming the budget and
  //     starving later ones (a big section is clipped, not allowed to hog);
  //   • giving back the reserve when few sections remain lets an early section grow
  //     and lets compact sections cost only their actual size — so every section
  //     that fits is fully included and a large early section is still represented;
  //   • spending is always bounded by `remaining`, so the total stays within
  //     sectionCap no matter how many sections exist.
  // Sections that no longer fit even minimally are disclosed, never silently dropped.
  const SEP = "\n\n";
  const CLIP_MARKER = "\n\n[…lessons section truncated]";
  const MIN_SHARE = 120; // guaranteed minimum representation per section (heading + a little)
  const MIN_PIECE = 40; // minimum useful clipped text before the marker
  let remaining = sectionCap;
  let appended = 0;
  for (let i = 0; i < atRisk.length; i++) {
    const s = atRisk[i]!;
    const sectionsAfter = atRisk.length - i - 1;
    // How many later sections can still get their minimum (minus this one's minimum).
    const affordableAfter = Math.max(0, Math.floor(remaining / MIN_SHARE) - 1);
    const reserve = Math.min(sectionsAfter, affordableAfter) * MIN_SHARE;
    const allow = remaining - reserve;
    const full = text.slice(s.start, s.end).trimEnd();
    const costFull = SEP.length + full.length;
    if (costFull <= allow) {
      out += SEP + full;
      remaining -= costFull;
      appended++;
    } else if (allow >= SEP.length + MIN_PIECE + CLIP_MARKER.length) {
      const textRoom = allow - SEP.length - CLIP_MARKER.length;
      const piece = full.slice(0, textRoom).trimEnd() + CLIP_MARKER;
      out += SEP + piece;
      remaining -= SEP.length + piece.length;
      appended++;
    }
    // else: not enough budget to represent this section meaningfully → omit it
    // (disclosed below) and keep scanning; a later smaller section may still fit.
  }
  const omitted = atRisk.length - appended;
  if (omitted > 0) {
    out += SEP + `[…${omitted} more lessons/gotchas section(s) truncated]`;
  }
  return out;
}

export function domainContext(cfg: PipelineConfig): { name: string; description: string } {
  return {
    name: cfg.domain_name ?? cfg.repo.split("/")[1] ?? cfg.domain,
    description: cfg.domain_description ?? "this repository",
  };
}

// ---------------------------------------------------------------------------
// JSON Schema generation (#156)
// ---------------------------------------------------------------------------

/**
 * Returns the JSON Schema (draft-2020-12) for `.github/pipeline.yml`, derived
 * from `PartialConfigSchema`. Used by `pipeline config schema`.
 */
export function generateConfigSchema(): object {
  return z.toJSONSchema(PartialConfigSchema);
}

// ---------------------------------------------------------------------------
// Config validation (#156): never-throws alternative to resolveConfig()
// ---------------------------------------------------------------------------

/** Dotted paths of fields whose misconfiguration changes review coverage or
 *  paid-call volume. A bad value in any of these is always severity "error"
 *  with rigorGating:true so that a typo never silently degrades rigor. */
export const RIGOR_GATING_PATHS: readonly string[] = [
  "review_policy.block_threshold",
  "review_policy.min_confidence",
  "review_policy.max_adversarial_rounds",
  "review_policy.risk_proportional",
  "review_policy.ceiling_action",
  "review_policy.surface_recurrence_rounds",
  "steps.plan_review",
  "steps.standard_review",
  "steps.adversarial_review",
  "eval_gate.enabled",
  "eval_gate.mode",
  "visual_gate.enabled",
  "visual_gate.mode",
  "shipcheck_gate.enabled",
  "shipcheck_gate.mode",
  "shipcheck_gate.max_rounds",
  "shipcheck_gate.block_on_partial",
];

const RIGOR_GATING_SET = new Set(RIGOR_GATING_PATHS);

export interface Diagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
  line?: number;
  rigorGating?: true;
}

export interface ValidateConfigResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export interface ValidateConfigDeps {
  /** Read file contents; return null if the file does not exist. Defaults to fs.readFileSync. */
  readFile?: (filePath: string) => string | null;
  /** Find the git root above startDir; return null if none found. Defaults to the internal findGitRoot. */
  findGitRoot?: (startDir: string) => string | null;
  /** Harnesses used for inert-model detection. When absent, loaded from `profile` (or PIPELINE_PROFILE env var). */
  harnesses?: { implementer: string; reviewer: string };
  /** Profile name to load harnesses from when `harnesses` is not injected. Defaults to PIPELINE_PROFILE env var or "codex". */
  profile?: string;
}

export interface SyncConfigDeps extends ValidateConfigDeps {
  /** Write file contents. Defaults to fs.writeFileSync. */
  writeFile?: (filePath: string, content: string) => void;
}

export interface SyncConfigResult {
  ok: boolean;
  changed: boolean;
  applied: boolean;
  configPath: string;
  candidate?: string;
  diff?: string;
  diagnostics: Diagnostic[];
}

const defaultReadFile = (fp: string): string | null => {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
};

const defaultWriteFile = (fp: string, content: string): void => {
  fs.writeFileSync(fp, content, "utf8");
};

/** Convert a 0-based character offset in `text` to a 1-indexed line number. */
function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Build a dotted-path → 1-indexed source-line resolver from raw YAML text, so
 * validation diagnostics for unknown keys and bad values carry a line a desktop
 * editor can attach to (#156). Uses the `yaml` CST (`parseDocument` node ranges)
 * rather than regex scanning, so it is correct for flow mappings
 * (`review_policy: { block_threshold: typo }`) and never matches config-like text
 * inside a block scalar. Returns a resolver that yields undefined when the path
 * cannot be located or the source cannot be parsed positionally.
 */
export function buildLineLookup(text: string): (dotPath: string) => number | undefined {
  let doc: ReturnType<typeof parseDocument> | undefined;
  try {
    doc = parseDocument(text, { keepSourceTokens: false });
  } catch {
    return () => undefined;
  }
  type RangedNode = { range?: [number, number, number] };
  type Pair = { key?: ({ value?: unknown } & RangedNode) };
  return (dotPath: string): number | undefined => {
    if (!dotPath) return undefined;
    const segments = dotPath.split(".");
    const last = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1);
    try {
      // Prefer the offending KEY's source range over the value's, so a multiline
      // mapping value (`block_threshold:\n    typo: true`) still points at the key
      // line, not the nested value line.
      const parent = parentPath.length === 0 ? doc!.contents : doc!.getIn(parentPath, true);
      const items = (parent as { items?: Pair[] } | undefined)?.items;
      if (Array.isArray(items)) {
        for (const pair of items) {
          if (pair?.key && String(pair.key.value) === last) {
            const keyOffset = pair.key.range?.[0];
            if (typeof keyOffset === "number") return lineFromOffset(text, keyOffset);
          }
        }
      }
      // Fallback to the value node range (e.g. sequence indices, or when the key
      // range is unavailable).
      const node = doc!.getIn(segments, true) as RangedNode | undefined;
      const offset = node?.range?.[0];
      return typeof offset === "number" ? lineFromOffset(text, offset) : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * Validate `.github/pipeline.yml` at the git root of `repoPath` without throwing.
 * All error conditions are returned as structured `Diagnostic` objects.
 * Exits 1 semantics are determined by the caller based on `severity: "error"` diagnostics.
 */
export function validateConfig(
  repoPath: string,
  deps: ValidateConfigDeps = {},
): ValidateConfigResult {
  const diagnostics: Diagnostic[] = [];

  // 1. Find git root
  const findGitRootFn = deps.findGitRoot ?? findGitRoot;
  const resolvedStart = path.resolve(repoPath);
  const gitRoot = findGitRootFn(resolvedStart);
  if (!gitRoot) {
    diagnostics.push({
      severity: "error",
      path: "",
      message: `No git repository found at or above ${resolvedStart}.`,
    });
    return { valid: false, diagnostics };
  }

  // 2. Read pipeline.yml
  const readFileFn = deps.readFile ?? defaultReadFile;
  const configPath = path.join(gitRoot, ".github", "pipeline.yml");
  const text = readFileFn(configPath);
  if (text === null) {
    diagnostics.push({
      severity: "error",
      path: "",
      message: `Config file not found: ${configPath}`,
    });
    return { valid: false, diagnostics };
  }

  // 3. Parse YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err: unknown) {
    const yamlErr = err as { mark?: { line?: number }; message?: string };
    const rawLine = yamlErr?.mark?.line;
    const diag: Diagnostic = {
      severity: "error",
      path: "",
      message: `YAML parse error: ${yamlErr?.message ?? String(err)}`,
    };
    if (typeof rawLine === "number") {
      diag.line = rawLine + 1; // js-yaml uses 0-indexed lines
    }
    diagnostics.push(diag);
    return { valid: false, diagnostics };
  }

  // 4. Null YAML (empty file, "---", "~", "null") is valid (no overrides applied).
  // Any other non-object root (scalar, boolean, number, sequence) is an error.
  if (parsed == null) {
    return { valid: true, diagnostics: [] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      severity: "error",
      path: "",
      message: `Config must be a YAML mapping (object), got ${Array.isArray(parsed) ? "sequence" : typeof parsed}.`,
    });
    return { valid: false, diagnostics };
  }

  // 5. Zod validation
  const result = PartialConfigSchema.safeParse(parsed);
  if (!result.success) {
    const lineOf = buildLineLookup(text);
    for (const issue of flattenIssues(result.error.issues)) {
      if (issue.code === "unrecognized_keys") {
        // Each unknown key becomes its own diagnostic
        const parentPath = issue.path.join(".");
        for (const key of (issue as { path: (string | number)[]; keys: string[]; message: string }).keys) {
          const dotPath = parentPath ? `${parentPath}.${key}` : key;
          const diag: Diagnostic = {
            severity: "error",
            path: dotPath,
            message: `Unrecognized key: "${key}"`,
          };
          const line = lineOf(dotPath);
          if (line !== undefined) diag.line = line;
          diagnostics.push(diag);
        }
      } else {
        const dotPath = issue.path.join(".");
        const diag: Diagnostic = {
          severity: "error",
          path: dotPath,
          message: issue.message,
        };
        const line = lineOf(dotPath);
        if (line !== undefined) diag.line = line;
        if (RIGOR_GATING_SET.has(dotPath)) {
          diag.rigorGating = true;
        }
        diagnostics.push(diag);
      }
    }
    return { valid: false, diagnostics };
  }

  // 6. Inert-model / inert-effort alias detection
  const fileConfig = result.data;
  {
    let harnesses = deps.harnesses;
    if (!harnesses) {
      try {
        const profileName = deps.profile ?? process.env.PIPELINE_PROFILE ?? "codex";
        harnesses = loadProfile(profileName).harnesses;
      } catch {
        // Profile unavailable — skip inert warnings rather than failing
        harnesses = undefined;
      }
    }
    // Apply review_harness from the file config (same override resolveConfig applies),
    // so inert-alias detection reflects the actual effective reviewer at runtime.
    // review_harness may be the string shorthand or the structured { command, ... } form.
    const reviewerCommand =
      typeof fileConfig.review_harness === "string"
        ? fileConfig.review_harness
        : fileConfig.review_harness?.command;
    if (harnesses && reviewerCommand) {
      harnesses = { ...harnesses, reviewer: reviewerCommand };
    }
    // Reviewer-model alias guard (#454): severity error, not the inert-alias
    // warning below — a Claude-only alias against a codex reviewer is no
    // longer inert (#441 passes it through to `codex exec -m`), so
    // `config validate` must exit 1 rather than merely warn. The MODEL_ALIAS_ROLES
    // loop below never also warns for this combination (its reviewer isInert
    // check already excludes "codex"), so no contradictory diagnostic is emitted.
    if (harnesses) {
      const violation = findReviewerModelAliasViolation(fileConfig, harnesses.reviewer);
      if (violation) {
        diagnostics.push({
          severity: "error",
          path: violation.path,
          message: reviewerModelAliasErrorMessage(violation.path, violation.value, harnesses.reviewer),
        });
      }
    }
    if (harnesses && fileConfig.models) {
      for (const { key, role } of MODEL_ALIAS_ROLES) {
        const value = fileConfig.models[key];
        if (value === undefined) continue;
        const harness = harnesses[role];
        const isInert = role === "reviewer" ? harness !== "claude" && harness !== "codex" : harness === "codex";
        if (!isInert) continue;
        diagnostics.push({
          severity: "warning",
          path: `models.${key}`,
          message: `models.${key} is set to "${value}" but the ${role} harness is "${harness}" — model aliases are not honored by that harness. The setting is ignored at runtime.`,
        });
      }
    }
    if (harnesses && fileConfig.effort?.review !== undefined && harnesses.reviewer !== "claude" && harnesses.reviewer !== "codex") {
      diagnostics.push({
        severity: "warning",
        path: "effort.review",
        message: `effort.review is set to "${fileConfig.effort.review}" but the reviewer is the custom CLI "${harnesses.reviewer}" — it accepts neither a --model nor an --effort flag, so per-stage effort is ignored at runtime.`,
      });
    }
  }

  // 6b. visual_gate: enabling the stage without a command is a config error
  // (not merely a runtime block, unlike eval_gate) — a typo'd/omitted command
  // must never let `visual_gate.enabled: true` silently pass validation.
  if (fileConfig.visual_gate?.enabled && !fileConfig.visual_gate?.command?.trim()) {
    diagnostics.push({
      severity: "error",
      path: "visual_gate.command",
      message: "visual_gate.enabled is true but no command is configured. Set visual_gate.command in .github/pipeline.yml.",
    });
  }
  // A declared artifacts_dir that resolves outside the repo root can never be a
  // valid worktree-relative path, regardless of which issue worktree runs it.
  if (fileConfig.visual_gate?.artifacts_dir !== undefined) {
    const resolved = path.resolve(gitRoot, fileConfig.visual_gate.artifacts_dir);
    const rel = path.relative(gitRoot, resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      diagnostics.push({
        severity: "error",
        path: "visual_gate.artifacts_dir",
        message: `visual_gate.artifacts_dir ("${fileConfig.visual_gate.artifacts_dir}") must resolve inside the repository root, not escape it.`,
      });
    }
  }

  // 7. Stage-executor eligibility (#314) — same rule resolveConfig() throws on;
  // surfaced here as a diagnostic instead so `pipeline config validate`/`sync`
  // never throw.
  try {
    validateStageExecutorAssignments(fileConfig);
  } catch (err) {
    diagnostics.push({
      severity: "error",
      path: "stage_executors",
      message: (err as Error).message,
    });
  }

  const hasError = diagnostics.some((d) => d.severity === "error");
  return { valid: !hasError, diagnostics };
}

function parseValidPartialConfig(text: string): PartialConfig | null {
  const parsed = yaml.load(text);
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = PartialConfigSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string" && value.includes("\n")) return JSON.stringify(value);
  return yaml.dump(value, { lineWidth: -1 }).trim();
}

function yamlInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => yamlScalar(item)).join(", ")}]`;
  return yamlScalar(value);
}

function yamlBlock(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  return yaml
    .dump(value, { lineWidth: -1, noRefs: true })
    .trimEnd()
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function hasOwn(obj: object | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function renderModelLines(models: PartialConfig["models"]): string {
  const d = DEFAULT_CONFIG.models;
  const keys = ["planning", "implementing", "review", "fix", "intake", "sweep"] as const;
  const comments: Record<typeof keys[number], string> = {
    planning: "implementer harness",
    implementing: "implementer harness",
    review: "reviewer harness",
    fix: "implementer harness",
    intake: "intake spec-generation — always the claude harness (never inert)",
    sweep: "sweep spec-generation — always the claude harness (never inert)",
  };
  if (!models) {
    return [
      "# models: # per-phase model alias. review is honored by both the claude and codex reviewer harnesses (a Claude alias like \"sonnet\" against a codex reviewer is a config error, not honored); planning/implementing/fix are honored only by the claude implementer harness (codex ignores them). A custom reviewer/implementer CLI ignores its alias too — setting an inert one prints a warning. Each key also accepts \"auto\" (#366). Uncomment to override.",
      ...keys.map((key) => `#   ${key}: ${yamlScalar(d[key])} # ${comments[key]}`),
    ].join("\n");
  }
  return [
    "models: # per-phase model alias. review is honored by both the claude and codex reviewer harnesses (a Claude alias like \"sonnet\" against a codex reviewer is a config error, not honored); planning/implementing/fix are honored only by the claude implementer harness (codex ignores them). A custom reviewer/implementer CLI ignores its alias too — setting an inert one prints a warning. Each key also accepts \"auto\".",
    ...keys.map((key) =>
      hasOwn(models, key)
        ? `  ${key}: ${yamlScalar(models[key])} # ${comments[key]}`
        : `#   ${key}: ${yamlScalar(d[key])} # ${comments[key]}`,
    ),
  ].join("\n");
}

function renderEffortLines(effort: PartialConfig["effort"]): string {
  const keys = ["planning", "implementing", "review", "fix", "intake", "sweep"] as const;
  const comments: Record<typeof keys[number], string> = {
    planning: "implementer harness — also sources plan-review's effort (Adversarial/Definitive)",
    implementing: "implementer harness",
    review: "reviewer harness — resolved round-aware (review-1 vs. review-2)",
    fix: "implementer harness",
    intake: "intake spec-generation — always the claude harness",
    sweep: "sweep spec-generation — always the claude harness",
  };
  if (!effort) {
    return [
      "# effort: # per-phase reasoning effort — codex via -c model_reasoning_effort, claude via --effort (#366). Each key also accepts \"auto\". Absent key: no flag (operator's global setting applies). Uncomment to override.",
      ...keys.map((key) => `#   ${key}: medium # ${comments[key]}`),
    ].join("\n");
  }
  return [
    "effort: # per-phase reasoning effort — codex via -c model_reasoning_effort, claude via --effort (#366). Each key also accepts \"auto\".",
    ...keys.map((key) =>
      hasOwn(effort, key)
        ? `  ${key}: ${yamlScalar(effort[key])} # ${comments[key]}`
        : `#   ${key}: medium # ${comments[key]}`,
    ),
  ].join("\n");
}

/** Render the `review_harness:` block for either the string shorthand or the
 *  structured `{ command, model?, effort? }` form (#366). */
function renderReviewHarnessBlock(reviewHarness: PartialConfig["review_harness"]): string {
  if (reviewHarness === undefined) {
    return "# review_harness: my-reviewer # override the reviewer CLI for the review step (default: the profile's reviewer). The CLI receives the JSON-verdict prompt as a positional arg and must print a fenced JSON verdict block on stdout. The implementer harness is not configurable.\n#   Or a structured form for independent reviewer model/effort/prompt-delivery control:\n# review_harness:\n#   command: my-reviewer\n#   model: auto # or an explicit alias\n#   effort: auto # or an explicit level (round-aware: review-1 Iterative, review-2/plan-review Definitive)\n#   prompt_delivery: argv # or \"stdin\" if the CLI reads its prompt from standard input (avoids the OS per-argument size limit)";
  }
  if (typeof reviewHarness === "string") {
    return `review_harness: ${yamlScalar(reviewHarness)} # override the reviewer CLI for the review step`;
  }
  const lines = [
    "review_harness: # override the reviewer CLI, and optionally its model/effort/prompt-delivery (#366, #492)",
    `  command: ${yamlScalar(reviewHarness.command)}`,
  ];
  if (reviewHarness.model !== undefined) lines.push(`  model: ${yamlScalar(reviewHarness.model)} # or "auto"`);
  if (reviewHarness.effort !== undefined) lines.push(`  effort: ${yamlScalar(reviewHarness.effort)} # or "auto" (round-aware: review-1 Iterative, review-2/plan-review Definitive)`);
  if (reviewHarness.prompt_delivery !== undefined) lines.push(`  prompt_delivery: ${yamlScalar(reviewHarness.prompt_delivery)} # "argv" (default) or "stdin"`);
  return lines.join("\n");
}

function renderMaybeScalar(key: string, value: unknown, comment: string): string {
  return `${key}: ${yamlScalar(value)} # ${comment}`;
}

function renderOptionalArray(key: string, value: unknown, commentedTemplate: string[]): string {
  if (value === undefined) return commentedTemplate.join("\n");
  if (Array.isArray(value) && value.length === 0) return `${key}: []`;
  return `${key}:\n${yamlBlock(value, 2)}`;
}

function renderConfigTemplate(config: PartialConfig = {}, source: "init" | "sync" = "sync"): string {
  const d = DEFAULT_CONFIG;
  const openspec = { ...d.openspec, ...config.openspec };
  const last30days = { ...d.last30days, ...config.last30days };
  const steps = { ...d.steps, ...config.steps };
  const testGate = { ...d.test_gate, ...config.test_gate };
  const evalGate = { ...d.eval_gate, ...config.eval_gate };
  const visualGate = { ...d.visual_gate, ...config.visual_gate };
  const shipcheckGate = { ...d.shipcheck_gate, ...config.shipcheck_gate };
  const reviewPolicy = { ...d.review_policy, ...config.review_policy };
  const doctor = { ...d.doctor, ...config.doctor };
  const loopCfg = { ...d.loop, ...config.loop };
  const papercuts = { ...d.papercuts, ...config.papercuts };
  const autoLoop = { ...d.auto_loop, ...config.auto_loop };

  const optionalTop: string[] = [];
  if (config.repo !== undefined) optionalTop.push(renderMaybeScalar("repo", config.repo, "GitHub repo override (owner/name)"));
  if (config.domain_name !== undefined) optionalTop.push(renderMaybeScalar("domain_name", config.domain_name, "human-readable project name used in prompts"));
  if (config.domain_description !== undefined) optionalTop.push(renderMaybeScalar("domain_description", config.domain_description, "short project description used in prompts"));
  if (config.conventions_md_path !== undefined) optionalTop.push(renderMaybeScalar("conventions_md_path", config.conventions_md_path, "repo-root-relative conventions file embedded in prompts"));

  const reviewPolicyOptional: string[] = [];
  if (hasOwn(config.review_policy, "risk_proportional")) {
    reviewPolicyOptional.push(`  risk_proportional: ${yamlScalar(reviewPolicy.risk_proportional)} # when true and review-1 approved with 0 findings, review-2 only blocks on high/critical findings (#232)`);
  } else {
    reviewPolicyOptional.push(`  # risk_proportional: ${yamlScalar(d.review_policy.risk_proportional)} # when true and review-1 approved with 0 findings, review-2 only blocks on high/critical findings (#232)`);
  }
  if (hasOwn(config.review_policy, "ceiling_action")) {
    reviewPolicyOptional.push(`  ceiling_action: ${yamlScalar(reviewPolicy.ceiling_action)} # park | demote_and_advance (#233)`);
  } else {
    reviewPolicyOptional.push(`  # ceiling_action: ${yamlScalar(d.review_policy.ceiling_action)} # park (default): hard-park at needs-human; demote_and_advance: auto-demote below-high findings and advance (#233)`);
  }
  if (hasOwn(config.review_policy, "surface_recurrence_rounds")) {
    reviewPolicyOptional.push(`  surface_recurrence_rounds: ${yamlScalar(reviewPolicy.surface_recurrence_rounds)} # same-surface recurrence guard; 0 disables (#234)`);
  } else {
    reviewPolicyOptional.push(`  # surface_recurrence_rounds: ${yamlScalar(d.review_policy.surface_recurrence_rounds)} # same-surface recurrence guard; 0 disables (#234)`);
  }

  const parts = [
    source === "init"
      ? "# Pipeline configuration for this repo — created by `pipeline init`."
      : "# Pipeline configuration for this repo — synced with `pipeline config sync`.",
    "# Every key is shown at its current default value; edit any line to override.",
    "# Delete a key to fall back to the built-in default. Lines that are commented",
    "# out (e.g. the `command:` entries) are optional overrides — uncomment to set.",
    "",
    ...optionalTop,
    optionalTop.length ? "" : undefined,
    `base_branch: ${yamlScalar(config.base_branch ?? d.base_branch)} # branch PRs target and worktrees branch from`,
    `worktree_root: ${yamlScalar(config.worktree_root ?? d.worktree_root)} # dir (relative to repo) holding pipeline worktrees`,
    `max_concurrent_worktrees: ${yamlScalar(config.max_concurrent_worktrees ?? d.max_concurrent_worktrees)} # cap on simultaneous in-flight worktrees`,
    `auto_recovery_max_retries: ${yamlScalar(config.auto_recovery_max_retries ?? d.auto_recovery_max_retries)} # auto-recovery attempts when implementation blocks`,
    `implementation_timeout: ${yamlScalar(config.implementation_timeout ?? d.implementation_timeout)} # seconds for the implementation harness`,
    `review_timeout: ${yamlScalar(config.review_timeout ?? d.review_timeout)} # seconds per review stage`,
    `plan_review_timeout: ${yamlScalar(config.plan_review_timeout ?? d.plan_review_timeout)} # seconds for the plan-review harness (shorter cap; fails fast on runaway review)`,
    `fix_timeout: ${yamlScalar(config.fix_timeout ?? d.fix_timeout)} # seconds per fix stage`,
    `intake_timeout: ${yamlScalar(config.intake_timeout ?? d.intake_timeout)} # seconds for the intake harness call before timing out`,
    `sweep_timeout: ${yamlScalar(config.sweep_timeout ?? d.sweep_timeout)} # seconds for the sweep harness call before timing out`,
    `ci_timeout: ${yamlScalar(config.ci_timeout ?? d.ci_timeout)} # seconds to wait for CI at pre-merge`,
    `ci_poll_interval: ${yamlScalar(config.ci_poll_interval ?? d.ci_poll_interval)} # seconds between CI status polls`,
    `ci_no_run_grace_s: ${yamlScalar(config.ci_no_run_grace_s ?? d.ci_no_run_grace_s)} # seconds to wait before checking for zero check-runs when CI appears pending; set to 0 to check immediately`,
    `ci_mode: ${yamlScalar(config.ci_mode ?? d.ci_mode)} # github (default): wait for GitHub Actions check-runs; local: rely on the current run's local test-gate result and skip the GitHub Actions wait`,
    "",
    renderModelLines(config.models),
    "",
    renderEffortLines(config.effort),
    "",
    renderReviewHarnessBlock(config.review_harness),
    "",
    "openspec:",
    `  enabled: ${yamlScalar(openspec.enabled)} # auto | on | off`,
    `  bootstrap: ${yamlScalar(openspec.bootstrap)} # if true, run \`openspec init\` on repos lacking openspec/`,
    "",
    "last30days:",
    `  enabled: ${yamlScalar(last30days.enabled)} # opt-in pre-planning activity brief`,
    `  timeout: ${yamlScalar(last30days.timeout)} # seconds`,
    "",
    "steps: # turn optional steps off for speed/preference (default: all on)",
    `  plan_review: ${yamlScalar(steps.plan_review)} # cross-harness review of the plan before coding`,
    `  standard_review: ${yamlScalar(steps.standard_review)} # review-1 (and its fix round)`,
    `  adversarial_review: ${yamlScalar(steps.adversarial_review)} # review-2 (and its fix round)`,
    `  docs: ${yamlScalar(steps.docs)} # include the docs-update instruction in the implementing prompt`,
    "",
    "test_gate: # run the repo's tests/build before opening a PR",
    `  enabled: ${yamlScalar(testGate.enabled)} # set false to disable entirely`,
    testGate.command !== undefined
      ? `  command: ${yamlScalar(testGate.command)} # explicit command; auto-detected when absent`
      : "  # command: pnpm test # explicit command; auto-detected when absent",
    `  max_attempts: ${yamlScalar(testGate.max_attempts)} # fix-harness invocations before blocking`,
    `  timeout: ${yamlScalar(testGate.timeout)} # seconds per test/build run`,
    "",
    "visual_gate: # run the repo's E2E/visual suite after pre-merge and before eval-gate",
    `  enabled: ${yamlScalar(visualGate.enabled)} # set true to enable (one-time declaration per repo)`,
    visualGate.command !== undefined
      ? `  command: ${yamlScalar(visualGate.command)} # shell command to run; required when enabled`
      : "  # command: npx playwright test # shell command to run; required when enabled",
    `  mode: ${yamlScalar(visualGate.mode)} # gate: block on fail | advisory: record and advance`,
    `  timeout: ${yamlScalar(visualGate.timeout)} # stage-level budget in seconds (shared across attempts)`,
    `  max_attempts: ${yamlScalar(visualGate.max_attempts)} # total attempts before giving up (1 = no retry)`,
    `  artifacts_dir: ${yamlScalar(visualGate.artifacts_dir)} # worktree-relative dir the command writes screenshots/diffs/traces into`,
    "",
    "eval_gate: # run the repo's eval harness after pre-merge",
    `  enabled: ${yamlScalar(evalGate.enabled)} # set true to enable (one-time declaration per repo)`,
    evalGate.command !== undefined
      ? `  command: ${yamlScalar(evalGate.command)} # shell command to run; required when enabled`
      : "  # command: pnpm evals # shell command to run; required when enabled",
    `  mode: ${yamlScalar(evalGate.mode)} # gate: block on fail | advisory: record and advance`,
    `  timeout: ${yamlScalar(evalGate.timeout)} # stage-level budget in seconds (shared across attempts)`,
    `  max_attempts: ${yamlScalar(evalGate.max_attempts)} # total attempts before giving up (1 = no retry)`,
    "",
    config.shipcheck_gate !== undefined
      ? [
        "shipcheck_gate: # reviewer-owned acceptance rubric after eval-gate (#148)",
        `  enabled: ${yamlScalar(shipcheckGate.enabled)} # set true to enable`,
        `  mode: ${yamlScalar(shipcheckGate.mode)} # advisory: record findings without blocking | gate: block on fail`,
        `  max_rounds: ${yamlScalar(shipcheckGate.max_rounds)} # max reviewer invocations before needs-human`,
        `  rubric_path: ${yamlScalar(shipcheckGate.rubric_path)} # repo-root-relative path to Markdown rubric file`,
        `  block_on_partial: ${yamlScalar(shipcheckGate.block_on_partial)} # when true and mode=gate, partial verdict also blocks`,
      ].join("\n")
      : [
        "# shipcheck_gate: # reviewer-owned acceptance rubric after eval-gate (#148). Disabled by default.",
        `#   enabled: ${yamlScalar(d.shipcheck_gate.enabled)} # set true to enable`,
        `#   mode: ${yamlScalar(d.shipcheck_gate.mode)} # advisory: record findings without blocking | gate: block on fail`,
        `#   max_rounds: ${yamlScalar(d.shipcheck_gate.max_rounds)} # max reviewer invocations before needs-human`,
        `#   rubric_path: ${yamlScalar(d.shipcheck_gate.rubric_path)} # repo-root-relative path to Markdown rubric file`,
        `#   block_on_partial: ${yamlScalar(d.shipcheck_gate.block_on_partial)} # when true and mode=gate, partial verdict also blocks`,
      ].join("\n"),
    "",
    "review_policy: # which review findings block progression vs. merely advise (#17)",
    `  block_threshold: ${yamlScalar(reviewPolicy.block_threshold)} # critical|high|medium|low — findings below this advise, not block (set 'low' to block on every finding)`,
    `  min_confidence: ${yamlScalar(reviewPolicy.min_confidence)} # 0..1 — findings below this confidence advise, not block`,
    `  max_adversarial_rounds: ${yamlScalar(reviewPolicy.max_adversarial_rounds)} # cap review-round re-runs; after this, still-blocking findings go advisory and the item routes to needs-human`,
    ...reviewPolicyOptional,
    "",
    "doctor: # deterministic preflight capability check (#146) — run `pipeline doctor` standalone, or enable run-start gating here",
    `  runOnStart: ${yamlScalar(doctor.runOnStart)} # if true, run the preflight checks before planning and abort the run on any failure`,
    `  failFast: ${yamlScalar(doctor.failFast)} # if true, stop at the first failing check instead of collecting all failures`,
    "",
    config.loop !== undefined
      ? `loop: # pipeline:loop native-goal capability attestation (#506)\n${yamlBlock(config.loop, 2)}`
      : [
        "# loop: # pipeline:loop native-goal capability attestation (#506) — uncomment to override automatic detection",
        `#   native_goal_attestation: ${yamlScalar(loopCfg.native_goal_attestation)} # auto (default): detect via --help marker / version floor | available|unavailable: explicit operator override`,
      ].join("\n"),
    "",
    config.papercuts !== undefined
      ? `papercuts: # agent-logged minor-friction capture (#419) — opt in to record friction via 'pipeline papercut' without stopping the run\n${yamlBlock(config.papercuts, 2)}`
      : [
        "# papercuts: # agent-logged minor-friction capture (#419) — uncomment to enable 'pipeline papercut' and its prompt instruction",
        "#   enabled: true",
        "#   auto_file: false # opt in (#421) to auto-file pipeline:backlog issues for recurring papercut clusters at run_complete and queue-batch end",
        `#   auto_file_window_hours: ${yamlScalar(papercuts.auto_file_window_hours)} # trailing window over which papercuts are clustered for auto-filing`,
        `#   auto_file_max_per_window: ${yamlScalar(papercuts.auto_file_max_per_window)} # max issues auto-filed within the window`,
        `#   auto_file_min_occurrences: ${yamlScalar(papercuts.auto_file_min_occurrences)} # min in-window occurrences a cluster must meet to be auto-filed`,
      ].join("\n"),
    "",
    config.auto_loop !== undefined
      ? [
        "auto_loop: # bounded auto-loop mode (#149)",
        `  enabled: ${yamlScalar(autoLoop.enabled)} # set true to enable`,
        `  max_rounds: ${yamlScalar(autoLoop.max_rounds)} # maximum automatic continuations per run before parking at needs-human`,
        `  max_wallclock_minutes: ${yamlScalar(autoLoop.max_wallclock_minutes)} # wall-clock budget in minutes (independent of max_rounds)`,
        `  stages: ${yamlInline(autoLoop.stages)} # allowlisted stages eligible for automatic continuation`,
      ].join("\n")
      : [
        "# auto_loop: # bounded auto-loop mode (#149) — opt-in; disabled by default",
        `#   enabled: ${yamlScalar(d.auto_loop.enabled)} # set true to enable; when false (default) the advance loop is byte-for-byte unchanged`,
        `#   max_rounds: ${yamlScalar(d.auto_loop.max_rounds)} # maximum automatic continuations per run before parking at needs-human`,
        `#   max_wallclock_minutes: ${yamlScalar(d.auto_loop.max_wallclock_minutes)} # wall-clock budget in minutes (independent of max_rounds)`,
        "#   # stages: [eval-gate, shipcheck-gate] # allowlisted stages eligible for automatic continuation",
        "#   #   Known stages: backlog, ready, planning, plan-review, implementing,",
        "#   #                 review-1, fix-1, review-2, fix-2, pre-merge, eval-gate,",
        "#   #                 shipcheck-gate, ready-to-deploy, needs-human",
      ].join("\n"),
    "",
    config.setup_command !== undefined
      ? `setup_command: ${yamlScalar(config.setup_command)} # shell command to run in the worktree after creation, before the test gate; empty string skips`
      : [
        '# setup_command: "pnpm install" # shell command to run in the worktree after creation, before the test gate (#174)',
        "#   Auto-detected from lockfile when absent (pnpm-lock.yaml -> pnpm install, yarn.lock -> yarn install, package-lock.json -> npm ci)",
        '#   Set to "" to skip the install step entirely (opt-out). Examples:',
        '#     setup_command: ""                                       # opt-out',
        '#     setup_command: "pnpm install --frozen-lockfile"         # override auto-detection',
        '#     setup_command: "pnpm install && pnpm run build:types"   # multi-step setup',
      ].join("\n"),
    "",
    config.build_command !== undefined
      ? `build_command: ${yamlScalar(config.build_command)} # shell command run after fix/auto-fix edits; its output is folded into the round commit`
      : [
        '# build_command: "npm run build" # repo build command run after fix/auto-fix edits (#387)',
        "#   When declared, fix and auto-fix rounds run it after committing source edits and fold any",
        "#   resulting generated-artifact changes (dist/, a plugin manifest, …) into the round commit,",
        "#   so committed artifacts stay fresh and a CI artifact-drift check never fails on drift the",
        "#   round itself introduced. Absent (default): no build runs, no auto-detection, no fallback.",
      ].join("\n"),
    "",
    renderOptionalArray("format_gate", config.format_gate, [
      "# format_gate: [] # run formatter/linter commands after the implementing and fix-round harnesses (#182)",
      "#   Each entry runs in the worktree root. auto_fix: true commits any changes and re-runs to verify;",
      "#   auto_fix: false blocks immediately on non-zero exit. Default: [] (no gate; existing behavior).",
      "#   Examples (Rust repo):",
      "#     - command: cargo fmt",
      "#       auto_fix: true",
      "#     - command: cargo clippy -D warnings",
      "#       auto_fix: false",
      "#   Examples (JS/TS repo):",
      "#     - command: eslint --fix src/",
      "#       auto_fix: true",
    ]),
    "",
    config.harness_sandbox !== undefined
      ? `harness_sandbox: ${yamlScalar(config.harness_sandbox)} # set true to run the claude implementer with --permission-mode default`
      : [
        "# harness_sandbox: false # set true to run the claude implementer with --permission-mode default",
        "#   instead of bypassPermissions (#21). The codex harness is already sandboxed",
        "#   via --full-auto and is unaffected. Default false -> current invocation unchanged.",
      ].join("\n"),
    "",
    config.event_sink !== undefined
      ? `event_sink: # optional external event sink (#343) — deliver run events.jsonl records to an operator-controlled forwarder\n${yamlBlock(config.event_sink, 2)}`
      : [
        "# event_sink: # optional external event sink (#343) — uncomment to deliver run events.jsonl records to an operator-controlled forwarder",
        '#   command: "logger -t pipeline" # forwarder command; receives each event JSON line on stdin. Unset -> no sink (local events.jsonl only, unchanged).',
        "#   mode: additive # additive (default): write events.jsonl AND deliver to the sink | exclusive: sink only (events.jsonl is not written)",
        "#   Env overrides: PIPELINE_EVENT_SINK_COMMAND, PIPELINE_EVENT_SINK_MODE (win over file config). Delivery failures are non-fatal.",
      ].join("\n"),
    config.roadmap !== undefined ? `\nroadmap:\n${yamlBlock(config.roadmap, 2)}` : undefined,
    config.sweep !== undefined ? `\nsweep:\n${yamlBlock(config.sweep, 2)}` : undefined,
    config.trusted_override_actors !== undefined ? `\ntrusted_override_actors:\n${yamlBlock(config.trusted_override_actors, 2)}` : undefined,
    config.queue !== undefined ? `\nqueue:\n${yamlBlock(config.queue, 2)}` : undefined,
    config.auto_merge_eligibility !== undefined ? `\nauto_merge_eligibility:\n${yamlBlock(config.auto_merge_eligibility, 2)}` : undefined,
    config.context_snapshot !== undefined ? `\ncontext_snapshot:\n${yamlBlock(config.context_snapshot, 2)}` : undefined,
    config.repo_map !== undefined
      ? [
        "",
        "repo_map: # cross-repo dependency map (#312) — declare inter-repo relationships for planning context",
        `  depends_on: ${yamlInline(config.repo_map.depends_on ?? [])} # owner/repo strings this repo consumes`,
        `  depended_on_by: ${yamlInline(config.repo_map.depended_on_by ?? [])} # owner/repo strings that consume this repo`,
      ].join("\n")
      : [
        "",
        "# repo_map: # cross-repo dependency map (#312) — uncomment to declare inter-repo relationships",
        "#   # When set, the planning stage fetches open issues from declared repos as supplemental context.",
        "#   # Relationships are declared independently per repo; no reverse-edge inference is performed.",
        "#   depends_on: [] # owner/repo strings this repo consumes (e.g. - acme/shared-lib)",
        "#   depended_on_by: [] # owner/repo strings that consume this repo (e.g. - acme/consumer-app)",
      ].join("\n"),
    config.executors !== undefined ? `\nexecutors:\n${yamlBlock(config.executors, 2)}` : undefined,
    config.stage_executors !== undefined ? `\nstage_executors:\n${yamlBlock(config.stage_executors, 2)}` : undefined,
    config.executors === undefined && config.stage_executors === undefined
      ? [
        "",
        "# executors: # external stage executors (#314) — uncomment to delegate model-invoking stages to an external agent system or model endpoint",
        "#   opencode-main:",
        "#     type: agent-system # full execution backend (OpenCode/HermesAgent/OpenClaw), valid for any model-invoking stage",
        "#     provider: opencode",
        "#     endpoint: https://opencode.internal/api",
        "#     credential: OPENCODE_API_KEY # env-var NAME resolved at invocation time — never a literal secret value",
        "#   local-ollama:",
        "#     type: model-endpoint # raw OpenAI-compatible chat/completions endpoint; valid ONLY for plan-review/review-1/review-2",
        "#     base_url: http://localhost:11434/v1",
        "#     model: llama3.1:70b",
        "# stage_executors: # assign a name from executors: to a model-invoking stage; unassigned stages use the local claude/codex harness unchanged",
        "#   planning: opencode-main",
        "#   review-1: local-ollama",
        "#   review-2: local-ollama",
        "#   Known model-invoking stages: planning, plan-review, implementing, review-1, fix-1, review-2, fix-2, shipcheck-gate",
      ].join("\n")
      : undefined,
  ].filter((line): line is string => line !== undefined);

  return `${parts.join("\n")}\n`;
}

function configPathFor(repoRoot: string): string {
  return path.join(repoRoot, ".github", "pipeline.yml");
}

function normalizeForSync(config: PartialConfig): unknown {
  const d = DEFAULT_CONFIG;
  return {
    repo: config.repo,
    base_branch: config.base_branch ?? d.base_branch,
    worktree_root: config.worktree_root ?? d.worktree_root,
    max_concurrent_worktrees: config.max_concurrent_worktrees ?? d.max_concurrent_worktrees,
    auto_recovery_max_retries: config.auto_recovery_max_retries ?? d.auto_recovery_max_retries,
    implementation_timeout: config.implementation_timeout ?? d.implementation_timeout,
    review_timeout: config.review_timeout ?? d.review_timeout,
    plan_review_timeout: config.plan_review_timeout ?? d.plan_review_timeout,
    fix_timeout: config.fix_timeout ?? d.fix_timeout,
    intake_timeout: config.intake_timeout ?? d.intake_timeout,
    sweep_timeout: config.sweep_timeout ?? d.sweep_timeout,
    ci_timeout: config.ci_timeout ?? d.ci_timeout,
    ci_poll_interval: config.ci_poll_interval ?? d.ci_poll_interval,
    ci_no_run_grace_s: config.ci_no_run_grace_s ?? d.ci_no_run_grace_s,
    ci_mode: config.ci_mode ?? d.ci_mode,
    models: { ...d.models, ...config.models },
    openspec: { ...d.openspec, ...config.openspec },
    last30days: { ...d.last30days, ...config.last30days },
    steps: { ...d.steps, ...config.steps },
    test_gate: { ...d.test_gate, ...config.test_gate },
    eval_gate: { ...d.eval_gate, ...config.eval_gate },
    visual_gate: { ...d.visual_gate, ...config.visual_gate },
    shipcheck_gate: { ...d.shipcheck_gate, ...config.shipcheck_gate },
    review_policy: { ...d.review_policy, ...config.review_policy },
    doctor: { ...d.doctor, ...config.doctor },
    loop: { ...d.loop, ...config.loop },
    papercuts: { ...d.papercuts, ...config.papercuts },
    setup_command: config.setup_command,
    build_command: config.build_command,
    conventions_md_path: config.conventions_md_path,
    domain_name: config.domain_name,
    domain_description: config.domain_description,
    format_gate: config.format_gate ?? d.format_gate,
    harness_sandbox: config.harness_sandbox ?? d.harness_sandbox,
    trusted_override_actors: config.trusted_override_actors,
    auto_loop: { ...d.auto_loop, ...config.auto_loop },
    roadmap: config.roadmap
      ? { ...config.roadmap, release_model: config.roadmap.release_model ?? "semver" }
      : undefined,
    sweep: config.sweep,
    queue: config.queue,
    auto_merge_eligibility: config.auto_merge_eligibility,
    context_snapshot: config.context_snapshot,
    repo_map: config.repo_map,
    event_sink: config.event_sink,
    executors: config.executors,
    stage_executors: config.stage_executors,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function configSyncDiff(before: string, after: string, relPath = ".github/pipeline.yml"): string {
  if (before === after) return "";
  const beforeLines = before.trimEnd().split("\n");
  const afterLines = after.trimEnd().split("\n");
  return [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function syncConfig(
  repoPath: string,
  opts: { apply?: boolean } = {},
  deps: SyncConfigDeps = {},
): SyncConfigResult {
  const findGitRootFn = deps.findGitRoot ?? findGitRoot;
  const readFileFn = deps.readFile ?? defaultReadFile;
  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  const resolvedStart = path.resolve(repoPath);
  const gitRoot = findGitRootFn(resolvedStart);
  const fallbackPath = configPathFor(gitRoot ?? resolvedStart);
  if (!gitRoot) {
    return {
      ok: false,
      changed: false,
      applied: false,
      configPath: fallbackPath,
      diagnostics: [{ severity: "error", path: "", message: `No git repository found at or above ${resolvedStart}.` }],
    };
  }

  const configPath = configPathFor(gitRoot);
  const current = readFileFn(configPath);
  if (current === null) {
    return {
      ok: false,
      changed: false,
      applied: false,
      configPath,
      diagnostics: [{ severity: "error", path: "", message: `Config file not found: ${configPath}. Run \`pipeline init\` to create one.` }],
    };
  }

  const validation = validateConfig(gitRoot, deps);
  const blocking = validation.diagnostics.filter((d) => d.severity === "error");
  if (blocking.length > 0) {
    return { ok: false, changed: false, applied: false, configPath, diagnostics: validation.diagnostics };
  }

  const parsed = parseValidPartialConfig(current);
  if (!parsed) {
    return { ok: false, changed: false, applied: false, configPath, diagnostics: validation.diagnostics };
  }

  const candidate = renderConfigTemplate(parsed);
  const candidateValidation = validateConfig(gitRoot, {
    ...deps,
    readFile: (p) => (path.resolve(p) === path.resolve(configPath) ? candidate : readFileFn(p)),
  });
  const candidateErrors = candidateValidation.diagnostics.filter((d) => d.severity === "error");
  if (candidateErrors.length > 0) {
    return { ok: false, changed: false, applied: false, configPath, candidate, diagnostics: candidateValidation.diagnostics };
  }

  const reparsed = parseValidPartialConfig(candidate);
  if (!reparsed || stableJson(normalizeForSync(parsed)) !== stableJson(normalizeForSync(reparsed))) {
    return {
      ok: false,
      changed: false,
      applied: false,
      configPath,
      candidate,
      diagnostics: [{ severity: "error", path: "", message: "Synced config candidate would change effective configuration; refusing to write." }],
    };
  }

  const changed = current !== candidate;
  if (opts.apply && changed) writeFileFn(configPath, candidate);
  return {
    ok: true,
    changed,
    applied: Boolean(opts.apply && changed),
    configPath,
    candidate,
    diff: configSyncDiff(current, candidate),
    diagnostics: validation.diagnostics,
  };
}

/**
 * Write a commented starter `.github/pipeline.yml` to the repo if absent.
 * Uses exclusive-create (`flag: "wx"`) so a concurrent second call never
 * clobbers an existing file — EEXIST → { created: false }.
 */
export async function scaffoldDefaultConfig(repoDir: string): Promise<{ created: boolean }> {
  const configDir = path.join(repoDir, ".github");
  const configPath = path.join(configDir, "pipeline.yml");

  fs.mkdirSync(configDir, { recursive: true });

  try {
    fs.writeFileSync(configPath, buildConfigTemplate(), { flag: "wx" });
    return { created: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { created: false };
    throw e;
  }
}

export function buildConfigTemplate(): string {
  return renderConfigTemplate({}, "init");
}

// ---------------------------------------------------------------------------
// repo_map add/remove/list (#367): surgical Document edits that touch only the
// repo_map block, preserving all other keys, comments, and formatting verbatim.
// ---------------------------------------------------------------------------

export type RepoMapRelation = "depends_on" | "depended_on_by";

export interface RepoMapMutationDeps {
  /** Read file contents; return null if the file does not exist. Defaults to fs.readFileSync. */
  readFile?: (filePath: string) => string | null;
  /** Write file contents. Defaults to fs.writeFileSync. */
  writeFile?: (filePath: string, content: string) => void;
  /** Find the git root above startDir; return null if none found. Defaults to the internal findGitRoot. */
  findGitRoot?: (startDir: string) => string | null;
  /** Best-effort GitHub reachability check for `repoMapAdd`. Returns true when reachable.
   *  Defaults to `gh repo view <owner/repo>`. A false result never aborts the write — it
   *  only attaches a warning to an otherwise-successful result. */
  checkReachable?: (ownerRepo: string) => boolean;
  /** Harnesses used for inert-model detection during post-write validation (see ValidateConfigDeps). */
  harnesses?: { implementer: string; reviewer: string };
  /** Profile name to load harnesses from when `harnesses` is not injected. */
  profile?: string;
}

export interface RepoMapResult {
  ok: boolean;
  changed: boolean;
  noop: boolean;
  configPath: string;
  message: string;
  warning?: string;
  errorKind?: "invalid-owner-repo" | "missing-config" | "not-git-repo" | "invalid-config";
}

export interface RepoMapListResult {
  ok: boolean;
  configPath: string;
  entries: Record<RepoMapRelation, string[]>;
  message: string;
  errorKind?: "missing-config" | "not-git-repo";
}

const OWNER_REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Validate an `owner/repo` string against the same format the config schema enforces
 * (exactly one '/', non-empty segments, no whitespace). Returns an error message when
 * invalid, or null when valid.
 */
export function validateOwnerRepo(value: string): string | null {
  if (!OWNER_REPO_RE.test(value)) {
    return `Invalid owner/repo "${value}": expected exactly one "/" with non-empty owner and repo segments and no whitespace.`;
  }
  return null;
}

function defaultCheckReachable(ownerRepo: string): boolean {
  try {
    execFileSync("gh", ["repo", "view", ownerRepo, "--json", "name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

interface LoadedRepoMapDoc {
  ok: true;
  gitRoot: string;
  configPath: string;
  text: string;
}

function loadRepoMapConfig(
  repoPath: string,
  deps: RepoMapMutationDeps,
): LoadedRepoMapDoc | { ok: false; result: RepoMapResult } {
  const findGitRootFn = deps.findGitRoot ?? findGitRoot;
  const readFileFn = deps.readFile ?? defaultReadFile;
  const resolvedStart = path.resolve(repoPath);
  const gitRoot = findGitRootFn(resolvedStart);
  if (!gitRoot) {
    return {
      ok: false,
      result: {
        ok: false,
        changed: false,
        noop: false,
        configPath: configPathFor(resolvedStart),
        message: `No git repository found at or above ${resolvedStart}.`,
        errorKind: "not-git-repo",
      },
    };
  }
  const configPath = configPathFor(gitRoot);
  const text = readFileFn(configPath);
  if (text === null) {
    return {
      ok: false,
      result: {
        ok: false,
        changed: false,
        noop: false,
        configPath,
        message: `Config file not found: ${configPath}. Run \`pipeline init\` to create one.`,
        errorKind: "missing-config",
      },
    };
  }
  return { ok: true, gitRoot, configPath, text };
}

/** Get (creating if absent) the `repo_map.<rel>` sequence node in `doc`. */
function repoMapSeq(doc: ReturnType<typeof parseDocument>, rel: RepoMapRelation): YAMLSeq {
  if (!doc.hasIn(["repo_map"])) doc.set("repo_map", doc.createNode({}));
  if (!doc.hasIn(["repo_map", rel])) doc.setIn(["repo_map", rel], doc.createNode([]));
  const node = doc.getIn(["repo_map", rel], true);
  if (!isSeq(node)) {
    throw new Error(`repo_map.${rel} in the config file is not a list.`);
  }
  return node;
}

/** Find the index of `value` in a YAML sequence's plain scalar items. */
function findSeqIndex(seq: YAMLSeq, value: string): number {
  return seq.items.findIndex((item) => {
    const v = item && typeof item === "object" && "value" in item ? (item as { value: unknown }).value : item;
    return v === value;
  });
}

/**
 * Locate the source character range of the top-level `repo_map:` pair
 * (key through the end of its value), so an edit can splice just that
 * range rather than re-serializing the whole document (#367 review 1).
 */
function findRepoMapRange(doc: ReturnType<typeof parseDocument>): [number, number] | null {
  if (!isMap(doc.contents)) return null;
  type RangedNode = { range?: [number, number, number] };
  const pair = doc.contents.items.find((p) => String((p.key as { value?: unknown } | null)?.value) === "repo_map");
  const keyRange = (pair?.key as RangedNode | null)?.range;
  if (!keyRange) return null;
  const valueRange = (pair?.value as RangedNode | null)?.range;
  return [keyRange[0], valueRange ? valueRange[2] : keyRange[2]];
}

/**
 * Apply `mutate` to a fresh parse of `text` and splice only the resulting
 * `repo_map:` block back into the original source, so every byte outside
 * `repo_map` — unrelated keys, comments, and formatting — survives verbatim.
 * Falls back to appending the rendered block when `repo_map` was absent.
 */
function spliceRepoMapBlock(text: string, mutate: (doc: ReturnType<typeof parseDocument>) => void): string {
  const doc = parseDocument(text);
  const existingRange = findRepoMapRange(doc);
  mutate(doc);
  const candidate = doc.toString();
  const candidateRange = findRepoMapRange(parseDocument(candidate));
  if (!candidateRange) return candidate;
  const newBlock = candidate.slice(candidateRange[0], candidateRange[1]);
  if (existingRange) {
    return text.slice(0, existingRange[0]) + newBlock + text.slice(existingRange[1]);
  }
  const needsNewline = text.length > 0 && !text.endsWith("\n");
  return text + (needsNewline ? "\n" : "") + newBlock;
}

/**
 * Add `ownerRepo` to `repo_map.<rel>` in `.github/pipeline.yml`, creating the
 * `repo_map` block (and target list) when absent. Idempotent: adding an entry
 * already present is a no-op success. Best-effort checks GitHub reachability
 * after a successful write; a reachability failure warns but never aborts.
 */
export function repoMapAdd(
  repoPath: string,
  ownerRepo: string,
  rel: RepoMapRelation,
  deps: RepoMapMutationDeps = {},
): RepoMapResult {
  const formatError = validateOwnerRepo(ownerRepo);
  if (formatError) {
    return { ok: false, changed: false, noop: false, configPath: "", message: formatError, errorKind: "invalid-owner-repo" };
  }

  const loaded = loadRepoMapConfig(repoPath, deps);
  if (!loaded.ok) return loaded.result;
  const { gitRoot, configPath, text } = loaded;

  const checkDoc = parseDocument(text);
  const existing = repoMapSeq(checkDoc, rel).toJSON() as string[];
  if (existing.includes(ownerRepo)) {
    return {
      ok: true,
      changed: false,
      noop: true,
      configPath,
      message: `${ownerRepo} is already present in repo_map.${rel} — no change made.`,
    };
  }

  const candidate = spliceRepoMapBlock(text, (doc) => {
    repoMapSeq(doc, rel);
    doc.addIn(["repo_map", rel], ownerRepo);
  });

  const readFileFn = deps.readFile ?? defaultReadFile;
  const candidateValidation = validateConfig(gitRoot, {
    ...deps,
    readFile: (p) => (path.resolve(p) === path.resolve(configPath) ? candidate : readFileFn(p)),
  });
  const errors = candidateValidation.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    return {
      ok: false,
      changed: false,
      noop: false,
      configPath,
      message: `Adding ${ownerRepo} to repo_map.${rel} would produce an invalid config: ${errors.map((e) => e.message).join("; ")}`,
      errorKind: "invalid-config",
    };
  }

  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  writeFileFn(configPath, candidate);

  const checkReachableFn = deps.checkReachable ?? defaultCheckReachable;
  const warning = checkReachableFn(ownerRepo)
    ? undefined
    : `${ownerRepo} could not be reached on GitHub (no access, not found, or a transient error) — added anyway.`;

  return {
    ok: true,
    changed: true,
    noop: false,
    configPath,
    message: `Added ${ownerRepo} to repo_map.${rel}.`,
    warning,
  };
}

/**
 * Remove `ownerRepo` from `repo_map.<rel>` in `.github/pipeline.yml`. Tolerant:
 * when the entry (or the whole repo_map/list) is absent, this is a no-op success
 * that carries a warning rather than an error.
 */
export function repoMapRemove(
  repoPath: string,
  ownerRepo: string,
  rel: RepoMapRelation,
  deps: RepoMapMutationDeps = {},
): RepoMapResult {
  const formatError = validateOwnerRepo(ownerRepo);
  if (formatError) {
    return { ok: false, changed: false, noop: false, configPath: "", message: formatError, errorKind: "invalid-owner-repo" };
  }

  const loaded = loadRepoMapConfig(repoPath, deps);
  if (!loaded.ok) return loaded.result;
  const { configPath, text } = loaded;

  const notPresent: RepoMapResult = {
    ok: true,
    changed: false,
    noop: true,
    configPath,
    message: `${ownerRepo} is not present in repo_map.${rel} — nothing to remove.`,
    warning: `${ownerRepo} was not present in repo_map.${rel}.`,
  };

  const checkDoc = parseDocument(text);
  if (!checkDoc.hasIn(["repo_map", rel])) return notPresent;
  const checkNode = checkDoc.getIn(["repo_map", rel], true);
  if (!isSeq(checkNode)) {
    throw new Error(`repo_map.${rel} in the config file is not a list.`);
  }
  if (findSeqIndex(checkNode, ownerRepo) === -1) return notPresent;

  const candidate = spliceRepoMapBlock(text, (doc) => {
    const node = doc.getIn(["repo_map", rel], true) as YAMLSeq;
    node.items.splice(findSeqIndex(node, ownerRepo), 1);
  });

  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  writeFileFn(configPath, candidate);

  return {
    ok: true,
    changed: true,
    noop: false,
    configPath,
    message: `Removed ${ownerRepo} from repo_map.${rel}.`,
  };
}

/** List current repo_map entries grouped by relationship kind. */
export function repoMapList(repoPath: string, deps: RepoMapMutationDeps = {}): RepoMapListResult {
  const loaded = loadRepoMapConfig(repoPath, deps);
  if (!loaded.ok) {
    return {
      ok: false,
      configPath: loaded.result.configPath,
      entries: { depends_on: [], depended_on_by: [] },
      message: loaded.result.message,
      errorKind: loaded.result.errorKind === "invalid-owner-repo" || loaded.result.errorKind === "invalid-config"
        ? undefined
        : loaded.result.errorKind,
    };
  }
  const { configPath, text } = loaded;
  const doc = parseDocument(text);

  const readList = (rel: RepoMapRelation): string[] => {
    if (!doc.hasIn(["repo_map", rel])) return [];
    const node = doc.getIn(["repo_map", rel], true);
    return isSeq(node) ? (node.toJSON() as string[]) : [];
  };

  const entries: Record<RepoMapRelation, string[]> = {
    depends_on: readList("depends_on"),
    depended_on_by: readList("depended_on_by"),
  };
  const total = entries.depends_on.length + entries.depended_on_by.length;

  return {
    ok: true,
    configPath,
    entries,
    message: total === 0 ? "No repo_map entries." : `${total} repo_map entr${total === 1 ? "y" : "ies"}.`,
  };
}
