// Review ensemble (#645): opt-in parallel multi-agent review at the shared
// `invokeReviewer` seam. Default-off: when `review_ensemble.enabled` is false
// (or the block is absent), callers get the existing single-reviewer path.
//
// When enabled, N configured agents run concurrently against the same worktree
// and prompt material; findings are union-merged + findingKey-deduped with
// rigor-first blocking (no majority-vote approve). Partial failure soft-fails
// when usable agents meet min_usable_agents; zero usable fails closed.

import { invoke, type HarnessResult, type InvokeOptions } from "./harness.ts";
import {
  findingKey,
  severityRank,
} from "./review-policy.ts";
import { invokeReviewer, type ReviewerInvocation } from "./self-review.ts";
import { parseProseReview, parseStrictVerdict } from "./stages/review-parsing.ts";
import {
  buildCoverageSummary,
  isCoverageFailClosed,
  isIndependentlyEligible,
  mapModelFamily,
  mapProviderFamily,
  resolveRequiredIndependent,
  type AggregationOutcome,
  type ReviewerAttemptLineage,
  type ReviewerCoverageSummary,
} from "./reviewer-independence.ts";
import type {
  Harness,
  PipelineConfig,
  ReviewEnsembleConfig,
  ReviewFinding,
  ReviewVerdict,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnsembleFailureClass =
  | "spawn_error"
  | "timeout"
  | "nonzero"
  | "unparseable"
  | "empty"
  | "rejected";

export interface EnsembleAgentIdentity {
  /** Config order index (0-based). */
  index: number;
  role?: "primary";
  /** Configured harness / CLI name. */
  harness: string;
  /** Harness that actually produced output (implementer when self-review). */
  effectiveHarness: string;
  model?: string;
  selfReview: boolean;
  status: "usable" | "failed";
  failureClass?: EnsembleFailureClass;
  /** Cost in USD when known from the harness result path (usually absent). */
  costUsd?: number | null;
  /** Deterministic provider family (#694). */
  providerFamily: string;
  /** Deterministic model family (#694). */
  modelFamily: string;
  /** Implementer harness for this run (#694). */
  implementerHarness: string;
  /** Latency ms when known; null if unknown (#694). */
  latencyMs: number | null;
  /**
   * Cost coverage class for this attempt (#694):
   * requested always; attempted when started; completed when terminal;
   * billable only with known actual/estimated cost.
   */
  costClass: "requested" | "attempted" | "completed" | "billable";
  /** Closed failure class or self-review fallback reason when applicable (#694). */
  failureOrFallbackReason?: string;
  /** Independently eligible under pure rules (#694). */
  independentlyEligible: boolean;
}

export interface EnsembleMergeSummary {
  merge: "union_blocking";
  size: number;
  usable: number;
  failed: number;
}

export interface EnsembleMeta {
  size: number;
  usable: number;
  failed: number;
  merge: "union_blocking";
  agents: EnsembleAgentIdentity[];
  /** Human-readable one-liner for comments / diagnostics. */
  summary: string;
  /** Explicit coverage counts (#694). */
  coverage: {
    configured: number;
    attempted: number;
    usable: number;
    independent: number;
    required: number;
  };
  /** Closed aggregation outcome (#694). */
  aggregation_outcome: AggregationOutcome;
  aggregation_reason: string;
  /** Cost dimensions (#694). */
  cost: {
    requested: number;
    attempted: number;
    completed: number;
    billable: number;
    billable_cost_usd: number | null;
  };
  risk_class: string;
  /** True when a one-shot substitute wave ran (#694). */
  substitute_wave?: boolean;
}

/** Result of an ensemble (or single-agent no-op) invoke. */
export interface EnsembleInvocation extends ReviewerInvocation {
  /**
   * Multi-agent ensemble meta when ensemble ran; also set for single-agent
   * coverage recording when the shared seam emits lineage (#694).
   */
  ensemble?: EnsembleMeta;
  /**
   * When structured merge succeeded, the merged verdict (also serialized into
   * `result.stdout` as a JSON fence for existing parse paths).
   */
  mergedVerdict?: ReviewVerdict;
  /** Coverage summary always present after the shared seam (#694). */
  coverage?: ReviewerCoverageSummary;
}

export type EnsembleOutputKind = "structured" | "plan-review";

export interface ResolvedEnsembleAgent {
  index: number;
  role?: "primary";
  harness: string;
  model?: string;
  effort?: string;
  promptDelivery?: "argv" | "stdin";
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** True when ensemble is enabled and should fan out. */
export function isEnsembleEnabled(cfg: Pick<PipelineConfig, "review_ensemble">): boolean {
  return cfg.review_ensemble?.enabled === true;
}

/** Review stages that share the ensemble fan-out seam (#645). */
export const ENSEMBLE_SEAM_STAGES = ["plan-review", "review-1", "review-2"] as const;
export type EnsembleSeamStage = (typeof ENSEMBLE_SEAM_STAGES)[number];

/**
 * Fail closed when ensemble is enabled and a stage_executor assignment would
 * silently replace multi-agent fan-out with a single external executor.
 * Config-resolve rejects this combo; this guard covers hand-built configs and
 * any path that skipped resolve validation.
 */
export function assertNoEnsembleStageExecutorBypass(
  cfg: Pick<PipelineConfig, "review_ensemble" | "stage_executors">,
  stage: EnsembleSeamStage,
): void {
  if (!isEnsembleEnabled(cfg)) return;
  const name = cfg.stage_executors?.[stage];
  if (!name) return;
  throw new Error(
    `review_ensemble.enabled cannot be combined with stage_executors.${stage}="${name}" — ` +
      `ensemble requires the shared multi-agent reviewer seam and must not be silently replaced by a single stage executor. ` +
      `Remove stage_executors.${stage} or set review_ensemble.enabled: false.`,
  );
}

/**
 * Resolve the ordered ensemble agent list from config + current primary
 * reviewer settings. When ensemble is disabled, returns a single primary agent
 * (for callers that want a uniform list).
 */
export function resolveEnsembleAgents(
  cfg: Pick<PipelineConfig, "review_ensemble" | "harnesses" | "models">,
  opts?: { model?: string; reasoningEffort?: string; promptDelivery?: "argv" | "stdin" },
): ResolvedEnsembleAgent[] {
  const primaryHarness = cfg.harnesses.reviewer;
  const primaryModel = opts?.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review;
  const primaryEffort = opts?.reasoningEffort ?? cfg.harnesses.reviewerEffort;
  const primaryDelivery = opts?.promptDelivery ?? cfg.harnesses.reviewerPromptDelivery;

  if (!isEnsembleEnabled(cfg)) {
    return [
      {
        index: 0,
        role: "primary",
        harness: primaryHarness,
        model: primaryModel,
        effort: primaryEffort,
        promptDelivery: primaryDelivery,
      },
    ];
  }

  const ensemble = cfg.review_ensemble!;
  const agents: ResolvedEnsembleAgent[] = [];
  for (let i = 0; i < ensemble.agents.length; i++) {
    const a = ensemble.agents[i]!;
    if (a.role === "primary") {
      agents.push({
        index: i,
        role: "primary",
        harness: primaryHarness,
        model: a.model ?? primaryModel,
        effort: a.effort ?? primaryEffort,
        promptDelivery: primaryDelivery,
      });
    } else {
      agents.push({
        index: i,
        harness: a.harness!,
        model: a.model ?? primaryModel,
        effort: a.effort ?? primaryEffort,
        // Additional agents default to argv; custom CLIs can set their own later.
        promptDelivery: "argv",
      });
    }
  }
  return agents;
}

/**
 * Resolve substitute agents for the one-shot repair wave (#694). Indices continue
 * after the primary configured list so audit order stays stable.
 */
export function resolveSubstituteAgents(
  cfg: Pick<PipelineConfig, "review_ensemble" | "harnesses" | "models">,
  opts?: { model?: string; reasoningEffort?: string; promptDelivery?: "argv" | "stdin" },
  startIndex = 0,
): ResolvedEnsembleAgent[] {
  const subs = cfg.review_ensemble?.substitute_agents ?? [];
  if (subs.length === 0) return [];
  const primaryHarness = cfg.harnesses.reviewer;
  const primaryModel = opts?.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review;
  const primaryEffort = opts?.reasoningEffort ?? cfg.harnesses.reviewerEffort;
  const primaryDelivery = opts?.promptDelivery ?? cfg.harnesses.reviewerPromptDelivery;
  const agents: ResolvedEnsembleAgent[] = [];
  for (let i = 0; i < subs.length; i++) {
    const a = subs[i]!;
    if (a.role === "primary") {
      agents.push({
        index: startIndex + i,
        role: "primary",
        harness: primaryHarness,
        model: a.model ?? primaryModel,
        effort: a.effort ?? primaryEffort,
        promptDelivery: primaryDelivery,
      });
    } else {
      agents.push({
        index: startIndex + i,
        harness: a.harness!,
        model: a.model ?? primaryModel,
        effort: a.effort ?? primaryEffort,
        promptDelivery: "argv",
      });
    }
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Pure merge
// ---------------------------------------------------------------------------

/**
 * Union-merge findings from multiple agent verdicts, dedupe by `findingKey`,
 * apply max severity / max confidence field merge with config-order tie-break.
 * Top-level verdict is never majority-voted: any merged findings →
 * needs-attention; empty findings from all agents → approve.
 */
export function mergeEnsembleVerdicts(
  agentVerdicts: ReadonlyArray<{ agentIndex: number; verdict: ReviewVerdict }>,
  commitSha = "",
): ReviewVerdict {
  // Preserve first-seen order of keys; within a key, track the winner finding.
  type Group = {
    winner: ReviewFinding;
    winnerAgentIndex: number;
    maxSevRank: number;
    maxConfidence: number;
  };
  const groups = new Map<string, Group>();
  const keyOrder: string[] = [];
  const nextSteps: string[] = [];
  const summaries: string[] = [];

  for (const { agentIndex, verdict } of agentVerdicts) {
    if (verdict.summary?.trim()) summaries.push(verdict.summary.trim());
    for (const step of verdict.next_steps ?? []) {
      if (typeof step === "string" && step.trim() && !nextSteps.includes(step)) {
        nextSteps.push(step);
      }
    }
    for (const f of verdict.findings ?? []) {
      const key = findingKey(f);
      const sevRank = severityRank(f.severity);
      const conf = typeof f.confidence === "number" && Number.isFinite(f.confidence) ? f.confidence : undefined;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          winner: { ...f },
          winnerAgentIndex: agentIndex,
          maxSevRank: sevRank,
          maxConfidence: conf ?? Number.NEGATIVE_INFINITY,
        });
        keyOrder.push(key);
        continue;
      }
      // Max severity wins; on severity ties prefer higher confidence; on full
      // ties prefer earlier agent config order (lower agentIndex).
      const betterSev = sevRank > existing.maxSevRank;
      const sameSev = sevRank === existing.maxSevRank;
      const betterConf =
        sameSev &&
        conf !== undefined &&
        conf > existing.maxConfidence;
      const sameConf =
        sameSev &&
        (conf === undefined
          ? existing.maxConfidence === Number.NEGATIVE_INFINITY
          : conf === existing.maxConfidence);
      const earlierAgent = sameConf && agentIndex < existing.winnerAgentIndex;

      if (betterSev || betterConf || earlierAgent) {
        existing.winner = { ...f };
        existing.winnerAgentIndex = agentIndex;
        existing.maxSevRank = Math.max(existing.maxSevRank, sevRank);
      } else {
        existing.maxSevRank = Math.max(existing.maxSevRank, sevRank);
      }
      if (conf !== undefined) {
        existing.maxConfidence = Math.max(existing.maxConfidence, conf);
      }
      // Canonical severity/confidence always reflect maxes even if body fields
      // came from an earlier agent that had lower confidence later raised.
      const sev = (["low", "medium", "high", "critical"] as const)[
        Math.max(0, Math.min(3, existing.maxSevRank))
      ]!;
      existing.winner = {
        ...existing.winner,
        severity: sev,
        confidence:
          existing.maxConfidence === Number.NEGATIVE_INFINITY
            ? (typeof existing.winner.confidence === "number"
              ? existing.winner.confidence
              : 0)
            : existing.maxConfidence,
      };
    }
  }

  const findings = keyOrder.map((k) => groups.get(k)!.winner);
  const verdict: ReviewVerdict["verdict"] =
    findings.length > 0 ? "needs-attention" : "approve";
  const summaryParts = [
    `Ensemble merge (union_blocking): ${agentVerdicts.length} usable agent(s), ${findings.length} finding(s) after findingKey dedupe.`,
  ];
  if (summaries.length > 0) {
    summaryParts.push(summaries.map((s, i) => `[agent ${agentVerdicts[i]?.agentIndex ?? i}] ${s}`).join(" | "));
  }
  return {
    verdict,
    summary: summaryParts.join(" "),
    findings,
    next_steps: nextSteps,
    commitSha,
  };
}

/**
 * Merge plan-review markdown outputs rigor-first: any NEEDS_REVISION wins;
 * Required Changes and Risks are union-concatenated. Returns a single document
 * with one `## Plan Review Verdict` section for existing planning consumers.
 */
export function mergePlanReviewOutputs(
  agentOutputs: ReadonlyArray<{ agentIndex: number; harness: string; text: string }>,
): string {
  let needsRevision = false;
  const changes: string[] = [];
  const risks: string[] = [];
  const agentNotes: string[] = [];

  for (const { agentIndex, harness, text } of agentOutputs) {
    const upper = text.toUpperCase();
    if (upper.includes("NEEDS_REVISION") || upper.includes("NEEDS REVISION")) {
      needsRevision = true;
    }
    // Collect bullet-like lines under Required Changes / Risks sections loosely.
    const changeSection = extractMarkdownSection(text, "Required Changes");
    const riskSection = extractMarkdownSection(text, "Risks / Checks")
      ?? extractMarkdownSection(text, "Risks");
    for (const line of splitBullets(changeSection)) {
      if (!changes.includes(line)) changes.push(line);
    }
    for (const line of splitBullets(riskSection)) {
      if (!risks.includes(line)) risks.push(line);
    }
    agentNotes.push(`### Agent ${agentIndex} (\`${harness}\`)\n\n${text.trim()}`);
  }

  const verdict = needsRevision ? "NEEDS_REVISION" : "APPROVE";
  const changeBody = changes.length > 0 ? changes.map((c) => `- ${c}`).join("\n") : "- None";
  const riskBody = risks.length > 0 ? risks.map((r) => `- ${r}`).join("\n") : "- None";
  return [
    "## Plan Review Verdict",
    verdict,
    "",
    "## Required Changes",
    changeBody,
    "",
    "## Risks / Checks",
    riskBody,
    "",
    "## Ensemble agent outputs",
    ...agentNotes,
  ].join("\n");
}

function extractMarkdownSection(text: string, heading: string): string | null {
  const re = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "im",
  );
  const m = re.exec(text);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function splitBullets(section: string | null): string[] {
  if (!section) return [];
  const out: string[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.replace(/^\s*[-*]\s+/, "").trim();
    if (!line || /^none\.?$/i.test(line)) continue;
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Usable-verdict parse (structured)
// ---------------------------------------------------------------------------

/**
 * Conservative parse for ensemble usability (#645 review-2).
 *
 * Code-review output is usable only when it satisfies the strict
 * `ReviewVerdict` / `ReviewFinding` schema (`parseStrictVerdict`) or is a
 * recognized prose review (`parseProseReview`). Partial JSON such as
 * `{ "verdict": "approve" }` with missing required fields or unvalidated
 * findings is NOT usable — generic text-fallback invents are never usable.
 */
export function tryParseUsableReviewVerdict(
  output: string,
  commitSha = "",
): ReviewVerdict | null {
  if (!output || !output.trim()) return null;

  const strict = parseStrictVerdict(output, commitSha);
  if (strict) return strict;

  const prose = parseProseReview(output);
  if (prose) return { ...prose, commitSha };
  return null;
}

/**
 * Canonical plan-review verdict token under `## Plan Review Verdict`.
 * Returns null when the section is missing or the first non-empty line is not
 * APPROVE / NEEDS_REVISION (heading-only or freeform prose is unusable).
 */
export function parsePlanReviewVerdictToken(
  output: string,
): "APPROVE" | "NEEDS_REVISION" | null {
  if (typeof output !== "string" || !output.trim()) return null;
  if (!/^##\s+Plan Review Verdict\s*$/im.test(output)) return null;
  const section = extractMarkdownSection(output, "Plan Review Verdict");
  if (section === null || !section.trim()) return null;
  const firstLine = section
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return null;
  // Strip light markdown emphasis (* `) only — keep underscores so NEEDS_REVISION stays intact.
  const token = firstLine.replace(/[*`]+/g, "").trim().toUpperCase();
  if (token === "NEEDS_REVISION" || token === "NEEDS REVISION") {
    return "NEEDS_REVISION";
  }
  if (token === "APPROVE") return "APPROVE";
  // Allow exact "Verdict: APPROVE" / "Verdict: NEEDS_REVISION" only — never freeform
  // prose that merely contains the word APPROVE (e.g. "I cannot approve this plan").
  const verdictPrefixed = token.match(
    /^VERDICT\s*:\s*(APPROVE|NEEDS[_\s]REVISION)\s*$/,
  );
  if (verdictPrefixed) {
    return verdictPrefixed[1] === "APPROVE" ? "APPROVE" : "NEEDS_REVISION";
  }
  return null;
}

/** True when plan-review output has the required section and a valid verdict token. */
export function isUsablePlanReviewOutput(output: string): boolean {
  return parsePlanReviewVerdictToken(output) !== null;
}

function classifyFailure(result: HarnessResult, unparseable: boolean): EnsembleFailureClass {
  if (result.spawn_error) return "spawn_error";
  if (result.timed_out) return "timeout";
  if (!result.success) return "nonzero";
  if (!result.stdout?.trim()) return "empty";
  if (unparseable) return "unparseable";
  return "rejected";
}

function serializeMergedVerdict(v: ReviewVerdict): string {
  // Fenced JSON so parseStructuredVerdict / parseStrictVerdict both accept it.
  const body = {
    verdict: v.verdict,
    summary: v.summary,
    findings: v.findings,
    next_steps: v.next_steps,
  };
  return "```json\n" + JSON.stringify(body, null, 2) + "\n```\n";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface InvokeReviewEnsembleOptions {
  worktreeDir: string;
  prompt: string;
  implementer: Harness;
  /** Output kind: structured JSON/prose (code review) or plan-review markdown. */
  kind: EnsembleOutputKind;
  timeoutSec: number;
  model?: string;
  modelWasAuto?: boolean;
  reasoningEffort?: string;
  promptDelivery?: "argv" | "stdin";
  /** Optional accounting / env fields forwarded to each agent invoke. */
  invokeOpts?: Omit<InvokeOptions, "timeoutSec" | "model" | "modelWasAuto" | "reasoningEffort" | "promptDelivery">;
  /** Bind commit SHA into merged structured verdicts. */
  commitSha?: string;
  /** Injectable invoke used by per-agent invokeReviewer. */
  inv?: typeof invoke;
  /** Injectable per-agent invokeReviewer (defaults to real). */
  invokeReviewerFn?: typeof invokeReviewer;
  /**
   * Structured risk class for min_independent_by_risk lookup (#694).
   * Default "standard". Pure structured input — not free-text.
   */
  riskClass?: string;
}

/**
 * Shared reviewer seam for plan-review / review-1 / review-2 (and SHA-gate
 * re-review). When ensemble is disabled, runs a single `invokeReviewer` and
 * still records coverage counts (#694). When enabled, fans out concurrently,
 * optionally runs one substitute wave, merges usable agents, and returns one
 * disposition-shaped result with independence/quorum coverage.
 */
export async function invokeReviewEnsemble(
  cfg: PipelineConfig,
  options: InvokeReviewEnsembleOptions,
): Promise<EnsembleInvocation> {
  const invokeReviewerFn = options.invokeReviewerFn ?? invokeReviewer;
  const inv = options.inv ?? invoke;
  const implementer = options.implementer;
  const riskClass = (options.riskClass && options.riskClass.trim()) || "standard";
  const minUsable = isEnsembleEnabled(cfg)
    ? cfg.review_ensemble!.min_usable_agents
    : 1;
  const required = resolveRequiredIndependent(
    cfg.review_ensemble?.min_independent_by_risk,
    riskClass,
  );
  const allowQuorumDegrade = cfg.review_ensemble?.allow_quorum_degrade === true;
  const agentTimeout = isEnsembleEnabled(cfg)
    ? (cfg.review_ensemble!.agent_timeout_sec ?? options.timeoutSec)
    : options.timeoutSec;

  type AgentOutcome = {
    agent: ResolvedEnsembleAgent;
    invocation: ReviewerInvocation;
    usable: boolean;
    failureClass?: EnsembleFailureClass;
    parsed?: ReviewVerdict;
    planText?: string;
    attempted: boolean;
    completed: boolean;
  };

  const promptFor = (agent: ResolvedEnsembleAgent): string => {
    const role = agent.role === "primary" ? "primary" : "cross-check";
    return (
      options.prompt +
      `\n\n<!-- ensemble-agent index=${agent.index} harness=${agent.harness} role=${role} -->\n` +
      `You are ensemble agent ${agent.index} (${agent.harness}, ${role}). ` +
      `Review independently; do not assume other agents' findings.\n`
    );
  };

  async function runAgent(agent: ResolvedEnsembleAgent): Promise<AgentOutcome> {
    const invocation = await invokeReviewerFn(
      agent.harness,
      implementer,
      options.worktreeDir,
      isEnsembleEnabled(cfg) ? promptFor(agent) : options.prompt,
      {
        timeoutSec: agentTimeout,
        model: agent.model,
        modelWasAuto: options.modelWasAuto,
        reasoningEffort: agent.effort,
        promptDelivery: agent.promptDelivery,
        ...options.invokeOpts,
        ...(options.invokeOpts?.accounting
          ? {
              accounting: {
                ...options.invokeOpts.accounting,
                stage: `${options.invokeOpts.accounting.stage ?? "review"}#ensemble-${agent.index}-${agent.harness}`,
              },
            }
          : {}),
      },
      inv,
    );

    const completed = true; // harness returned a terminal result
    if (!invocation.result.success || !invocation.result.stdout?.trim()) {
      return {
        agent,
        invocation,
        usable: false,
        failureClass: classifyFailure(invocation.result, false),
        attempted: true,
        completed,
      };
    }

    if (options.kind === "plan-review") {
      if (!isUsablePlanReviewOutput(invocation.result.stdout)) {
        return {
          agent,
          invocation,
          usable: false,
          failureClass: "unparseable",
          attempted: true,
          completed,
        };
      }
      return {
        agent,
        invocation,
        usable: true,
        planText: invocation.result.stdout,
        attempted: true,
        completed,
      };
    }

    const parsed = tryParseUsableReviewVerdict(
      invocation.result.stdout,
      options.commitSha ?? "",
    );
    if (!parsed) {
      return {
        agent,
        invocation,
        usable: false,
        failureClass: "unparseable",
        attempted: true,
        completed,
      };
    }
    return { agent, invocation, usable: true, parsed, attempted: true, completed };
  }

  async function runWave(agents: ResolvedEnsembleAgent[]): Promise<AgentOutcome[]> {
    const started = agents.map((agent) => runAgent(agent));
    const settled = await Promise.allSettled(started);
    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const agent = agents[i]!;
      const failedResult: HarnessResult = {
        success: false,
        stdout: "",
        stderr: String(s.reason ?? "ensemble agent rejected"),
        exit_code: -1,
        duration: 0,
        timed_out: false,
      };
      return {
        agent,
        invocation: {
          result: failedResult,
          effectiveReviewer: agent.harness,
          selfReview: false,
        },
        usable: false,
        failureClass: "rejected" as const,
        attempted: true,
        completed: true,
      };
    });
  }

  function costFromResult(result: HarnessResult): {
    costUsd: number | null;
    billable: boolean;
    costClass: "requested" | "attempted" | "completed" | "billable";
  } {
    // HarnessResult does not currently expose structured cost; treat as completed
    // with unknown cost (never invent billable $0).
    const usageCost =
      result && typeof (result as { cost_usd?: unknown }).cost_usd === "number"
        ? ((result as { cost_usd: number }).cost_usd)
        : null;
    if (usageCost !== null && Number.isFinite(usageCost)) {
      return { costUsd: usageCost, billable: true, costClass: "billable" };
    }
    return { costUsd: null, billable: false, costClass: "completed" };
  }

  function toLineage(o: AgentOutcome): ReviewerAttemptLineage {
    const { costUsd, billable } = costFromResult(o.invocation.result);
    const provider = mapProviderFamily(o.agent.harness, o.agent.model);
    const modelFam = mapModelFamily(o.agent.model);
    const latencyMs =
      typeof o.invocation.result.duration === "number" &&
      Number.isFinite(o.invocation.result.duration)
        ? Math.round(o.invocation.result.duration * 1000)
        : null;
    const selfReview = o.invocation.selfReview;
    const failureOrFallback = o.usable
      ? selfReview
        ? "self_review_fallback"
        : undefined
      : o.failureClass;
    return {
      index: o.agent.index,
      configured_harness: o.agent.harness,
      effective_harness: o.invocation.effectiveReviewer,
      provider_family: provider,
      model_family: modelFam,
      model: o.agent.model,
      self_review: selfReview,
      implementer_harness: implementer,
      status: o.usable ? "usable" : "failed",
      latency_ms: latencyMs,
      attempted: o.attempted,
      completed: o.completed,
      billable,
      cost_usd: costUsd,
      failure_reason: o.usable ? undefined : o.failureClass,
      fallback_reason: selfReview ? "self_review_fallback" : undefined,
    };
  }

  function toIdentity(o: AgentOutcome): EnsembleAgentIdentity {
    const lineage = toLineage(o);
    const { costUsd, billable, costClass } = costFromResult(o.invocation.result);
    const failureOrFallbackReason =
      lineage.fallback_reason ?? lineage.failure_reason;
    return {
      index: o.agent.index,
      role: o.agent.role,
      harness: o.agent.harness,
      effectiveHarness: o.invocation.effectiveReviewer,
      model: o.agent.model,
      selfReview: o.invocation.selfReview,
      status: o.usable ? "usable" : "failed",
      failureClass: o.failureClass,
      costUsd,
      providerFamily: lineage.provider_family,
      modelFamily: lineage.model_family,
      implementerHarness: implementer,
      latencyMs: lineage.latency_ms,
      costClass: o.attempted ? costClass : "requested",
      failureOrFallbackReason,
      independentlyEligible: isIndependentlyEligible(lineage),
    };
  }

  function buildMeta(
    configuredCount: number,
    outcomes: AgentOutcome[],
    summary: string,
    substituteWave: boolean,
  ): { meta: EnsembleMeta; coverage: ReviewerCoverageSummary } {
    const lineages = outcomes.map(toLineage);
    const coverage = buildCoverageSummary({
      attempts: lineages,
      configured: configuredCount,
      minUsable,
      required,
      riskClass,
    });
    const identities = outcomes.map(toIdentity);
    const usableN = outcomes.filter((o) => o.usable).length;
    const meta: EnsembleMeta = {
      size: configuredCount,
      usable: usableN,
      failed: outcomes.length - usableN,
      merge: "union_blocking",
      agents: identities,
      summary,
      coverage: coverage.counts,
      aggregation_outcome: coverage.aggregation_outcome,
      aggregation_reason: coverage.aggregation_reason,
      cost: coverage.cost,
      risk_class: riskClass,
      ...(substituteWave ? { substitute_wave: true } : {}),
    };
    return { meta, coverage };
  }

  // ---- Single-agent path (ensemble disabled) ----
  if (!isEnsembleEnabled(cfg)) {
    // Match pre-#694 invokeReviewer opts: pass through options.model as-is
    // (undefined) so harness-level alias filtering still applies (#441).
    const singleAgent: ResolvedEnsembleAgent = {
      index: 0,
      role: "primary",
      harness: cfg.harnesses.reviewer,
      model: options.model,
      effort: options.reasoningEffort,
      promptDelivery: options.promptDelivery,
    };
    const outcomes = await runWave([singleAgent]);
    const o = outcomes[0]!;
    const summary =
      o.usable
        ? `Single-reviewer coverage: usable=1 independent lineage recorded`
        : `Single-reviewer failed: ${o.failureClass ?? "failed"}`;
    const { meta, coverage } = buildMeta(1, outcomes, summary, false);
    // Single-agent: keep ensemble undefined for #645 consumers that treat
    // ensemble presence as multi-agent; coverage is on the invocation.
    if (!o.usable) {
      return {
        result: o.invocation.result,
        effectiveReviewer: o.invocation.effectiveReviewer,
        selfReview: o.invocation.selfReview,
        coverage,
      };
    }
    return {
      result: o.invocation.result,
      effectiveReviewer: o.invocation.effectiveReviewer,
      selfReview: o.invocation.selfReview,
      coverage,
      ...(options.kind === "structured" && o.parsed
        ? { mergedVerdict: o.parsed }
        : {}),
    };
  }

  // ---- Ensemble path ----
  const agents = resolveEnsembleAgents(cfg, {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    promptDelivery: options.promptDelivery,
  });
  let outcomes = await runWave(agents);
  let substituteWave = false;
  const configuredCount = agents.length;

  const firstCoverage = buildCoverageSummary({
    attempts: outcomes.map(toLineage),
    configured: configuredCount,
    minUsable,
    required,
    riskClass,
  });

  // One-shot substitute wave when coverage fail-closed and substitutes configured.
  if (
    isCoverageFailClosed(firstCoverage.aggregation_outcome, false) &&
    (cfg.review_ensemble?.substitute_agents?.length ?? 0) > 0
  ) {
    const subs = resolveSubstituteAgents(
      cfg,
      {
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        promptDelivery: options.promptDelivery,
      },
      agents.length,
    );
    if (subs.length > 0) {
      const subOutcomes = await runWave(subs);
      outcomes = [...outcomes, ...subOutcomes];
      substituteWave = true;
    }
  }

  const usable = outcomes.filter((o) => o.usable);
  const failed = outcomes.filter((o) => !o.usable);
  const anySelfReview = outcomes.some((o) => o.invocation.selfReview);
  const primaryUsable =
    usable.find((o) => o.agent.role === "primary") ?? usable[0];
  const effectiveReviewer =
    primaryUsable?.invocation.effectiveReviewer ?? cfg.harnesses.reviewer;

  // Coverage uses configured = primary agent list size (not substitutes).
  // Attempted/usable include substitute attempts so rollups stay honest.
  const coverageConfigured = configuredCount;
  let { meta, coverage } = buildMeta(
    coverageConfigured,
    outcomes,
    "",
    substituteWave,
  );
  // Recompute configured count on meta to primary configured (not substitute-inflated size).
  // size field remains primary configured for #645 consumers; usable/failed over all outcomes.
  meta = {
    ...meta,
    size: coverageConfigured,
    usable: usable.length,
    failed: failed.length,
    coverage: {
      ...coverage.counts,
      configured: coverageConfigured,
    },
  };
  coverage = {
    ...coverage,
    counts: { ...coverage.counts, configured: coverageConfigured },
  };

  const coverageLine =
    `coverage configured=${coverage.counts.configured} attempted=${coverage.counts.attempted} ` +
    `usable=${coverage.counts.usable} independent=${coverage.counts.independent} ` +
    `required=${coverage.counts.required} outcome=${coverage.aggregation_outcome}`;

  const failClosed = isCoverageFailClosed(
    coverage.aggregation_outcome,
    allowQuorumDegrade,
  );

  // Merge usable agents even under quorum_unmet so findings are retained.
  let mergedVerdict: ReviewVerdict | undefined;
  let mergedPlanText: string | undefined;
  if (usable.length > 0) {
    if (options.kind === "plan-review") {
      mergedPlanText = mergePlanReviewOutputs(
        usable.map((o) => ({
          agentIndex: o.agent.index,
          harness: o.agent.harness,
          text: o.planText ?? o.invocation.result.stdout,
        })),
      );
    } else {
      mergedVerdict = mergeEnsembleVerdicts(
        usable.map((o) => ({
          agentIndex: o.agent.index,
          verdict: o.parsed!,
        })),
        options.commitSha ?? "",
      );
    }
  }

  const namedFailed = failed
    .map((f) => `${f.agent.harness}#${f.agent.index}(${f.failureClass ?? "failed"})`)
    .join(", ");
  const duration = Math.max(
    0,
    ...outcomes.map((o) => o.invocation.result.duration ?? 0),
  );
  const stderrParts = outcomes
    .map((o) => o.invocation.result.stderr?.trim())
    .filter(Boolean);

  if (failClosed) {
    const findingNote =
      mergedVerdict && mergedVerdict.findings.length > 0
        ? ` Usable agents still reported ${mergedVerdict.findings.length} finding(s) (union retained).`
        : "";
    const summary =
      coverage.aggregation_outcome === "no_usable_reviewers"
        ? `Review ensemble failed closed: no usable reviewers (${coverageLine}). Failed agents: ${namedFailed || "(none named)"}.`
        : `Review ensemble failed closed: independent quorum unmet (${coverageLine}).${findingNote}`;
    meta = { ...meta, summary: `${summary} ${coverage.aggregation_reason}` };
    // When findings exist under quorum_unmet, surface them in stdout so
    // operators can still see union blockers on the block surface.
    const stdout =
      coverage.aggregation_outcome === "quorum_unmet" && mergedVerdict
        ? serializeMergedVerdict(mergedVerdict)
        : "";
    return {
      result: {
        success: false,
        stdout,
        stderr: [summary, ...stderrParts].filter(Boolean).join("\n"),
        exit_code: -1,
        duration,
        timed_out: outcomes.every((o) => o.invocation.result.timed_out),
      },
      effectiveReviewer,
      selfReview: anySelfReview,
      ensemble: meta,
      coverage,
      ...(mergedVerdict ? { mergedVerdict } : {}),
    };
  }

  // Soft-fail / success path (including allow_quorum_degrade advisory).
  const degradeNote =
    coverage.aggregation_outcome === "quorum_unmet" && allowQuorumDegrade
      ? " ADVISORY: quorum_unmet with allow_quorum_degrade — coverage not complete."
      : "";
  const failNote =
    failed.length > 0
      ? `\n\n<!-- ensemble-diagnostics failed=${failed.map((f) => `${f.agent.harness}:${f.failureClass}`).join(",")} -->\n`
      : "";

  if (options.kind === "plan-review") {
    const summary =
      `Ensemble plan-review: ${usable.length}/${coverageConfigured} usable; ${coverageLine}${degradeNote}` +
      (failed.length ? `; failed: ${failed.map((f) => f.agent.harness).join(", ")}` : "");
    meta = { ...meta, summary };
    return {
      result: {
        success: true,
        stdout: (mergedPlanText ?? "") + failNote,
        stderr: stderrParts.join("\n"),
        exit_code: 0,
        duration,
        timed_out: false,
      },
      effectiveReviewer,
      selfReview: anySelfReview,
      ensemble: meta,
      coverage,
    };
  }

  const summary =
    `Ensemble review: ${usable.length}/${coverageConfigured} usable, ` +
    `${mergedVerdict?.findings.length ?? 0} finding(s) after union+findingKey dedupe; ${coverageLine}${degradeNote}` +
    (failed.length
      ? `; failed agents: ${failed.map((f) => `${f.agent.harness}(${f.failureClass})`).join(", ")}`
      : "");
  meta = { ...meta, summary };
  return {
    result: {
      success: true,
      stdout: serializeMergedVerdict(
        mergedVerdict ?? {
          verdict: "approve",
          summary: "Ensemble: no findings from usable agents",
          findings: [],
          next_steps: [],
          commitSha: options.commitSha ?? "",
        },
      ),
      stderr: stderrParts.join("\n"),
      exit_code: 0,
      duration,
      timed_out: false,
    },
    effectiveReviewer,
    selfReview: anySelfReview,
    ensemble: meta,
    coverage,
    mergedVerdict,
  };
}

/** Banner when any ensemble agent used same-harness self-review. */
export function ensembleSelfReviewBanner(
  agents: EnsembleAgentIdentity[],
): string {
  const fellBack = agents.filter((a) => a.selfReview);
  if (fellBack.length === 0) return "";
  const named = fellBack
    .map((a) => `\`${a.harness}\`→\`${a.effectiveHarness}\``)
    .join(", ");
  return (
    `> ⚠️ **Ensemble includes same-harness self-review (#39 / #645 / #694).** ` +
    `Agent(s) fell back to the implementer: ${named}. ` +
    `Self-review does not count as independent coverage when policy forbids it.`
  );
}

/** Short multi-agent identity + coverage line for review comments. */
export function formatEnsembleIdentityLine(ensemble: EnsembleMeta): string {
  const parts = ensemble.agents.map((a) => {
    const label = a.selfReview
      ? `${a.effectiveHarness} (self-review of ${a.harness})`
      : a.harness;
    const lineage = a.providerFamily && a.modelFamily
      ? ` ${a.providerFamily}/${a.modelFamily}`
      : "";
    const st = a.status === "failed" ? ` [failed:${a.failureClass ?? "?"}]` : "";
    const ind = a.independentlyEligible ? " indep" : "";
    return `${label}${lineage}${ind}${st}`;
  });
  const cov = ensemble.coverage
    ? ` cov=${ensemble.coverage.independent}/${ensemble.coverage.required}req` +
      ` outcome=${ensemble.aggregation_outcome}`
    : "";
  return (
    `**Ensemble** (${ensemble.usable}/${ensemble.size} usable, merge=${ensemble.merge}${cov}): ` +
    `${parts.join(", ")}`
  );
}

/** Coverage disclosure line for disposition comments (#694). */
export function formatCoverageDisclosure(
  coverage: ReviewerCoverageSummary | EnsembleMeta | undefined,
): string {
  if (!coverage) return "";
  const counts = "coverage" in coverage && coverage.coverage
    ? coverage.coverage
    : "counts" in coverage
      ? (coverage as ReviewerCoverageSummary).counts
      : null;
  const outcome =
    "aggregation_outcome" in coverage
      ? coverage.aggregation_outcome
      : undefined;
  const reason =
    "aggregation_reason" in coverage ? coverage.aggregation_reason : undefined;
  if (!counts || !outcome) return "";
  const degraded =
    outcome === "same_lineage_fallback" || outcome === "quorum_unmet"
      ? " — independence degraded or unmet"
      : "";
  return (
    `**Reviewer coverage (#694):** configured=${counts.configured} attempted=${counts.attempted} ` +
    `usable=${counts.usable} independent=${counts.independent} required=${counts.required} ` +
    `outcome=\`${outcome}\`${degraded}` +
    (reason ? ` (${reason})` : "")
  );
}

/** Resolve a ReviewEnsembleConfig with defaults applied (for tests / display). */
export function defaultReviewEnsembleConfig(): ReviewEnsembleConfig {
  return {
    enabled: false,
    agents: [],
    min_usable_agents: 1,
    max_agents: 4,
    allow_quorum_degrade: false,
  };
}
