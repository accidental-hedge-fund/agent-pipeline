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
import { parseProseReview } from "./stages/review-parsing.ts";
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
}

/** Result of an ensemble (or single-agent no-op) invoke. */
export interface EnsembleInvocation extends ReviewerInvocation {
  /** Present only when ensemble ran (enabled + ≥1 configured agent path). */
  ensemble?: EnsembleMeta;
  /**
   * When structured merge succeeded, the merged verdict (also serialized into
   * `result.stdout` as a JSON fence for existing parse paths).
   */
  mergedVerdict?: ReviewVerdict;
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
 * Conservative parse for ensemble usability: JSON fence/inline or recognized
 * prose review. Returns null when output is not a usable structured verdict
 * (generic text-fallback invents are NOT usable).
 */
export function tryParseUsableReviewVerdict(
  output: string,
  commitSha = "",
): ReviewVerdict | null {
  if (!output || !output.trim()) return null;

  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]!);
  const inlineMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]!);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as Partial<ReviewVerdict>;
      if (data.verdict === "approve" || data.verdict === "needs-attention") {
        const findings = Array.isArray(data.findings)
          ? (data.findings as ReviewFinding[])
          : [];
        // approve + findings → needs-attention (same as parseStrictVerdict)
        const effective =
          data.verdict === "approve" && findings.length > 0
            ? "needs-attention"
            : data.verdict;
        return {
          verdict: effective,
          summary: typeof data.summary === "string" ? data.summary : "",
          findings,
          next_steps: Array.isArray(data.next_steps)
            ? (data.next_steps as string[])
            : [],
          commitSha,
        };
      }
    } catch {
      // try next
    }
  }

  const prose = parseProseReview(output);
  if (prose) return { ...prose, commitSha };
  return null;
}

export function isUsablePlanReviewOutput(output: string): boolean {
  return typeof output === "string" && output.includes("## Plan Review Verdict");
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
}

/**
 * Shared reviewer seam for plan-review / review-1 / review-2 (and SHA-gate
 * re-review). When ensemble is disabled, delegates to a single `invokeReviewer`
 * call. When enabled, fans out concurrently, merges usable agents, and returns
 * one disposition-shaped result.
 */
export async function invokeReviewEnsemble(
  cfg: PipelineConfig,
  options: InvokeReviewEnsembleOptions,
): Promise<EnsembleInvocation> {
  const invokeReviewerFn = options.invokeReviewerFn ?? invokeReviewer;
  const inv = options.inv ?? invoke;

  if (!isEnsembleEnabled(cfg)) {
    const single = await invokeReviewerFn(
      cfg.harnesses.reviewer,
      options.implementer,
      options.worktreeDir,
      options.prompt,
      {
        timeoutSec: options.timeoutSec,
        model: options.model,
        modelWasAuto: options.modelWasAuto,
        reasoningEffort: options.reasoningEffort,
        promptDelivery: options.promptDelivery,
        ...options.invokeOpts,
      },
      inv,
    );
    return single;
  }

  const agents = resolveEnsembleAgents(cfg, {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    promptDelivery: options.promptDelivery,
  });
  const minUsable = cfg.review_ensemble!.min_usable_agents;
  const agentTimeout =
    cfg.review_ensemble!.agent_timeout_sec ?? options.timeoutSec;

  // Optional identity suffix only — core prompt material is identical.
  const promptFor = (agent: ResolvedEnsembleAgent): string => {
    const role = agent.role === "primary" ? "primary" : "cross-check";
    return (
      options.prompt +
      `\n\n<!-- ensemble-agent index=${agent.index} harness=${agent.harness} role=${role} -->\n` +
      `You are ensemble agent ${agent.index} (${agent.harness}, ${role}). ` +
      `Review independently; do not assume other agents' findings.\n`
    );
  };

  type AgentOutcome = {
    agent: ResolvedEnsembleAgent;
    invocation: ReviewerInvocation;
    usable: boolean;
    failureClass?: EnsembleFailureClass;
    parsed?: ReviewVerdict;
    planText?: string;
  };

  const started = agents.map(async (agent): Promise<AgentOutcome> => {
    const invocation = await invokeReviewerFn(
      agent.harness,
      options.implementer,
      options.worktreeDir,
      promptFor(agent),
      {
        timeoutSec: agentTimeout,
        model: agent.model,
        modelWasAuto: options.modelWasAuto,
        reasoningEffort: agent.effort,
        promptDelivery: agent.promptDelivery,
        ...options.invokeOpts,
        // Per-agent accounting stage suffix so concurrent agents don't collide
        // on identical (issue, stage) accounting rows when present.
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

    if (!invocation.result.success || !invocation.result.stdout?.trim()) {
      return {
        agent,
        invocation,
        usable: false,
        failureClass: classifyFailure(invocation.result, false),
      };
    }

    if (options.kind === "plan-review") {
      if (!isUsablePlanReviewOutput(invocation.result.stdout)) {
        return {
          agent,
          invocation,
          usable: false,
          failureClass: "unparseable",
        };
      }
      return {
        agent,
        invocation,
        usable: true,
        planText: invocation.result.stdout,
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
      };
    }
    return { agent, invocation, usable: true, parsed };
  });

  const settled = await Promise.allSettled(started);
  const outcomes: AgentOutcome[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    // Unexpected throw from invoke — treat as failed agent.
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
    };
  });

  const usable = outcomes.filter((o) => o.usable);
  const failed = outcomes.filter((o) => !o.usable);

  const agentIdentities: EnsembleAgentIdentity[] = outcomes.map((o) => ({
    index: o.agent.index,
    role: o.agent.role,
    harness: o.agent.harness,
    effectiveHarness: o.invocation.effectiveReviewer,
    model: o.agent.model,
    selfReview: o.invocation.selfReview,
    status: o.usable ? "usable" : "failed",
    failureClass: o.failureClass,
  }));

  const metaBase = {
    size: agents.length,
    usable: usable.length,
    failed: failed.length,
    merge: "union_blocking" as const,
    agents: agentIdentities,
  };

  const anySelfReview = outcomes.some((o) => o.invocation.selfReview);
  // Primary-effective reviewer for banner / label: first usable primary, else
  // first usable agent, else configured primary.
  const primaryUsable =
    usable.find((o) => o.agent.role === "primary") ?? usable[0];
  const effectiveReviewer =
    primaryUsable?.invocation.effectiveReviewer ?? cfg.harnesses.reviewer;

  if (usable.length < minUsable) {
    const named = failed
      .map(
        (f) =>
          `${f.agent.harness}#${f.agent.index}(${f.failureClass ?? "failed"})`,
      )
      .join(", ");
    const stderr = outcomes
      .map((o) => o.invocation.result.stderr?.trim())
      .filter(Boolean)
      .join("\n");
    const summary =
      `Review ensemble failed closed: usable ${usable.length} < min_usable_agents ${minUsable}. ` +
      `Failed agents: ${named || "(none named)"}.`;
    const duration = Math.max(
      0,
      ...outcomes.map((o) => o.invocation.result.duration ?? 0),
    );
    return {
      result: {
        success: false,
        stdout: "",
        stderr: [summary, stderr].filter(Boolean).join("\n"),
        exit_code: -1,
        duration,
        timed_out: outcomes.every((o) => o.invocation.result.timed_out),
      },
      effectiveReviewer,
      selfReview: anySelfReview,
      ensemble: { ...metaBase, summary },
    };
  }

  // Soft-fail path: merge usable agents.
  if (options.kind === "plan-review") {
    const mergedText = mergePlanReviewOutputs(
      usable.map((o) => ({
        agentIndex: o.agent.index,
        harness: o.agent.harness,
        text: o.planText ?? o.invocation.result.stdout,
      })),
    );
    const failNote =
      failed.length > 0
        ? `\n\n<!-- ensemble-diagnostics failed=${failed.map((f) => `${f.agent.harness}:${f.failureClass}`).join(",")} -->\n`
        : "";
    const summary =
      `Ensemble plan-review: ${usable.length}/${agents.length} usable` +
      (failed.length ? `; failed: ${failed.map((f) => f.agent.harness).join(", ")}` : "");
    const duration = Math.max(
      0,
      ...outcomes.map((o) => o.invocation.result.duration ?? 0),
    );
    return {
      result: {
        success: true,
        stdout: mergedText + failNote,
        stderr: failed
          .map((f) => f.invocation.result.stderr?.trim())
          .filter(Boolean)
          .join("\n"),
        exit_code: 0,
        duration,
        timed_out: false,
      },
      effectiveReviewer,
      selfReview: anySelfReview,
      ensemble: { ...metaBase, summary },
    };
  }

  // Structured merge
  const mergedVerdict = mergeEnsembleVerdicts(
    usable.map((o) => ({
      agentIndex: o.agent.index,
      verdict: o.parsed!,
    })),
    options.commitSha ?? "",
  );
  const summary =
    `Ensemble review: ${usable.length}/${agents.length} usable, ` +
    `${mergedVerdict.findings.length} finding(s) after union+findingKey dedupe` +
    (failed.length
      ? `; failed agents: ${failed.map((f) => `${f.agent.harness}(${f.failureClass})`).join(", ")}`
      : "");
  const duration = Math.max(
    0,
    ...outcomes.map((o) => o.invocation.result.duration ?? 0),
  );
  return {
    result: {
      success: true,
      stdout: serializeMergedVerdict(mergedVerdict),
      stderr: failed
        .map((f) => f.invocation.result.stderr?.trim())
        .filter(Boolean)
        .join("\n"),
      exit_code: 0,
      duration,
      timed_out: false,
    },
    effectiveReviewer,
    selfReview: anySelfReview,
    ensemble: { ...metaBase, summary },
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
    `> ⚠️ **Ensemble includes same-harness self-review (#39 / #645).** ` +
    `Agent(s) fell back to the implementer: ${named}. ` +
    `A same-harness review is weaker than an independent cross-harness review — weigh it accordingly.`
  );
}

/** Short multi-agent identity line for review comments. */
export function formatEnsembleIdentityLine(ensemble: EnsembleMeta): string {
  const parts = ensemble.agents.map((a) => {
    const label = a.selfReview
      ? `${a.effectiveHarness} (self-review of ${a.harness})`
      : a.harness;
    const st = a.status === "failed" ? ` [failed:${a.failureClass ?? "?"}]` : "";
    return `${label}${st}`;
  });
  return `**Ensemble** (${ensemble.usable}/${ensemble.size} usable, merge=${ensemble.merge}): ${parts.join(", ")}`;
}

/** Resolve a ReviewEnsembleConfig with defaults applied (for tests / display). */
export function defaultReviewEnsembleConfig(): ReviewEnsembleConfig {
  return {
    enabled: false,
    agents: [],
    min_usable_agents: 1,
    max_agents: 4,
  };
}
