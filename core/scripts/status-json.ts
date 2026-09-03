// Machine-readable status payload for `pipeline <issue> --status --json` (#154).
// Pure assembly logic: no I/O, no subprocess, no network calls.
// The caller provides pre-fetched data; this module maps it to the stable JSON envelope.

import { isBlocked, pickStage } from "./gh.ts";
import {
  extractAuthorityKeysFromComments,
  extractRecoverParkedSpent,
} from "./recover-parked.ts";
import {
  isElevatedWriteHealth,
  type RunEventsSummary,
  type WriteHealthRecord,
} from "./run-store.ts";
import type { PipelineConfig } from "./types.ts";

/** Closed host-guidance projection (#1379). Additive; schema_version stays `"1"`. */
export const HOST_GUIDANCE_VALUES = [
  "continue",
  "recover-parked",
  "human-disposition-required",
  "operator-merge",
] as const;
export type HostGuidance = (typeof HOST_GUIDANCE_VALUES)[number];

// ---------------------------------------------------------------------------
// Envelope shapes (the public JSON contract — field names/types are stable)
// ---------------------------------------------------------------------------

/** Populated when a run is not finalized and has gone quiet past the largest
 *  configured stage timeout — distinguishes a legitimately long stage from a
 *  wedged run (#398). Null otherwise. */
export interface PossiblyWedged {
  last_event_age_ms: number;
  threshold_ms: number;
  last_event_type: string;
}

export interface StatusPayload {
  schema_version: "1";
  status: "ok" | "blocked" | "needs-human" | "waiting" | "error";
  issue: { number: number; title: string };
  stage: string | null;
  pr: { number: number; url: string } | null;
  branch: string | null;
  worktree: string | null;
  last_event: { timestamp: string; description: string } | null;
  review_summary: { verdict: string; findings_count: number; timestamp: string } | null;
  next_action: string;
  /**
   * Host-guidance projection (#1379). Tells a host what it may do next without
   * inferring authority from `next_action` prose. Never authorizes invented
   * `pipeline override`. Additive; schema_version stays `"1"`.
   */
  host_guidance: HostGuidance;
  config: { repo: string; domain: string };
  possibly_wedged: PossiblyWedged | null;
  /**
   * Event-stream write-health for the latest run (#633). Non-null when the run
   * recorded one or more append/sink failures. Null when healthy, absent, or
   * no run-events summary was provided. Additive; schema_version stays `"1"`.
   */
  event_stream_write_health: WriteHealthRecord | null;
  /**
   * Pending/known human-question handoffs for this issue (#647). Additive;
   * absent or empty when no handoffs exist. Schema_version stays `"1"`.
   */
  handoffs?: Array<{
    handoff_id: string;
    status: string;
    handoff_class: string;
    authority_mode: string;
    question_summary?: string;
  }>;
}

export interface StatusErrorEnvelope {
  schema_version: "1";
  status: "error";
  error: string;
}

// ---------------------------------------------------------------------------
// Input shape (matches getIssueDetail's return structure)
// ---------------------------------------------------------------------------

export interface StatusIssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  comments: { author: string; body: string; createdAt: string }[];
  url: string;
  /** Pipeline-label addition events (#154); merged with comments to compute `last_event`. */
  labelEvents?: { label: string; createdAt: string }[];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

export function deriveStatus(
  stage: string | null,
  blocked: boolean,
  state: "open" | "closed",
): StatusPayload["status"] {
  if (state === "closed") return "ok";
  if (stage === null) return "blocked";
  if (blocked) return "blocked";
  if (stage === "needs-human") return "needs-human";
  if (stage === "backlog" || stage === "needs-spec") return "waiting";
  return "ok";
}

const RECOVER_PARKED_SPENT_HEADING = "## Pipeline: recover-parked supervisor pass spent";
const BLOCKER_KIND_RE = /<!--\s*pipeline-blocker-kind:\s*([a-z0-9-]+)\s*-->/gi;
const RESIDUAL_PARK_STAGES = new Set([
  "needs-human",
  "review-1",
  "review-2",
  "fix-1",
  "fix-2",
  "pre-merge",
]);

const NEXT_ACTION_RECOVER_PARKED =
  "Residual review park — run `pipeline recover-parked` once for the current park fingerprint. If the issue remains parked, stop and request an exact operator-supplied disposition. Do not invent `pipeline override` or remove `blocked`.";
const NEXT_ACTION_HUMAN_DISPOSITION =
  "Human disposition required — stop and request an exact operator-supplied disposition. Do not invent a finding key or reason and do not invoke `pipeline override`.";

/** Latest `pipeline-blocker-kind` marker in comments (guidance only; fail closed, no trust). */
export function latestBlockerKindLoose(
  comments: readonly { body: string }[],
): string | null {
  let last: string | null = null;
  for (const c of comments) {
    BLOCKER_KIND_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BLOCKER_KIND_RE.exec(c.body ?? "")) !== null) {
      last = m[1]!.toLowerCase();
    }
  }
  BLOCKER_KIND_RE.lastIndex = 0;
  return last;
}

function hasResidualReviewEvidence(comments: readonly { body: string }[]): boolean {
  return comments.some((c) => {
    const body = c.body ?? "";
    return (
      (body.startsWith("## Review ") || body.startsWith("## Delta review")) &&
      (body.includes("### Findings") ||
        body.includes("override-key") ||
        body.includes("blocking-keys") ||
        body.includes("blockingKeys"))
    );
  });
}

/**
 * Recover-parked spend projection from issue comments already available to
 * status assembly. Fail closed to `unknown` when a spend heading is present
 * without a parseable fingerprint record.
 */
export function classifyRecoverParkedSpend(args: {
  issue: number;
  stage: string | null;
  comments: readonly { body: string }[];
}): "unspent" | "spent" | "unknown" {
  const headingPresent = args.comments.some((c) =>
    (c.body ?? "").includes(RECOVER_PARKED_SPENT_HEADING),
  );
  const spent = extractRecoverParkedSpent(args.comments);
  if (headingPresent && spent.length === 0) return "unknown";
  if (args.stage == null) {
    return spent.some((s) => s.issue === args.issue) ? "unknown" : "unspent";
  }
  const relevant = spent.filter((s) => s.issue === args.issue && s.stage === args.stage);
  if (relevant.length > 0) return "spent";
  return "unspent";
}

/**
 * Host-guidance projection (#1379). Residual parks: unspent → `recover-parked`;
 * spent, unknown spend, or true human-authority → `human-disposition-required`.
 * Never returns a value that authorizes invented `pipeline override`.
 */
export function deriveHostGuidance(args: {
  stage: string | null;
  blocked: boolean;
  issue: number;
  comments: readonly { body: string }[];
}): HostGuidance {
  if (args.stage === "ready-to-deploy" && !args.blocked) return "operator-merge";

  const kind = latestBlockerKindLoose(args.comments);
  const authority = extractAuthorityKeysFromComments(args.comments);
  const parked = args.blocked || args.stage === "needs-human";
  const humanAuthorityPark =
    parked &&
    (kind === "human-decision-required" || authority.wholeParkAuthority === true);
  if (humanAuthorityPark) return "human-disposition-required";

  const residualPark =
    args.stage === "needs-human" ||
    (args.blocked && kind === "needs-human") ||
    (args.blocked &&
      args.stage != null &&
      RESIDUAL_PARK_STAGES.has(args.stage) &&
      hasResidualReviewEvidence(args.comments));
  if (!residualPark) return "continue";

  const spend = classifyRecoverParkedSpend(args);
  if (spend === "unspent") return "recover-parked";
  return "human-disposition-required";
}

export function deriveNextAction(
  stage: string | null,
  blocked: boolean,
  hostGuidance?: HostGuidance,
): string {
  if (hostGuidance === "recover-parked") return NEXT_ACTION_RECOVER_PARKED;
  if (hostGuidance === "human-disposition-required") return NEXT_ACTION_HUMAN_DISPOSITION;
  if (blocked) {
    return "Unblock with `--unblock \"<answer>\"` or fix the blocker, then re-run.";
  }
  const actions: Record<string, string> = {
    backlog: "Promote to `pipeline:ready` manually.",
    "needs-spec":
      "Admission hold — apply a complete spec, then re-admit with `pipeline triage <N> --stage ready`.",
    ready: "Pipeline will run planning and implementation.",
    planning: "Planning is in progress.",
    "plan-review": "Plan review is in progress.",
    "pre-code-attestation":
      "Pre-code human attestation gate will run next (inert unless enabled and a risk trigger matched).",
    implementing: "Implementation is in progress.",
    "design-gate": "Design-interrogation gate will run next (inert unless enabled and a risk trigger matched).",
    "review-1": "Standard review will run next.",
    "review-2": "Adversarial review will run next.",
    "fix-1": "Fix pass 1 will run next.",
    "fix-2": "Fix pass 2 will run next.",
    "pre-merge": "Pre-merge checks (CI, docs) will run next.",
    "eval-gate": "Eval gate will run next.",
    "shipcheck-gate": "Shipcheck will run next.",
    "ready-to-deploy": "Ready to deploy — awaiting an operator-authorized merge.",
    // Fail closed: without spend evidence, do not advertise autonomous override.
    "needs-human": NEXT_ACTION_HUMAN_DISPOSITION,
  };
  if (stage === null) return "Add a `pipeline:ready` label to start the pipeline.";
  return actions[stage] ?? `Pipeline is at stage \`${stage}\`.`;
}

function deriveLastEvent(
  comments: { author: string; body: string; createdAt: string }[],
  labelEvents?: { label: string; createdAt: string }[],
): { timestamp: string; description: string } | null {
  type Candidate = { timestamp: string; description: string };
  const candidates: Candidate[] = [];

  for (const c of comments) {
    if (c.body.startsWith("## Pipeline:") || c.body.startsWith("## Review ")) {
      candidates.push({ timestamp: c.createdAt, description: c.body.split("\n", 1)[0] });
    }
  }

  for (const e of labelEvents ?? []) {
    candidates.push({ timestamp: e.createdAt, description: `Label changed to \`${e.label}\`` });
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((latest, c) => (c.timestamp > latest.timestamp ? c : latest));
}

function deriveReviewSummary(
  comments: { author: string; body: string; createdAt: string }[],
): { verdict: string; findings_count: number; timestamp: string } | null {
  const last = [...comments].reverse().find((c) => c.body.startsWith("## Review "));
  if (!last) return null;
  const firstLine = last.body.split("\n", 1)[0];
  // "## Review 1 — approved (commit abc)" or "## Review 2 (Adversarial) — needs-attention (commit abc)"
  const verdictMatch = firstLine.match(/—\s*([a-z][a-z-]*)/);
  const verdict = verdictMatch ? verdictMatch[1] : "unknown";
  // Count numbered finding bullets (e.g. "**1. [HIGH] ...")
  const lines = last.body.split("\n");
  let inFindings = false;
  let count = 0;
  for (const line of lines) {
    if (line.trim() === "### Findings") {
      inFindings = true;
      continue;
    }
    if (inFindings && line.startsWith("###")) break;
    if (inFindings && /^\*\*\d+\./.test(line)) count++;
  }
  return { verdict, findings_count: count, timestamp: last.createdAt };
}

// ---------------------------------------------------------------------------
// possibly_wedged (#398)
// ---------------------------------------------------------------------------

/** Config fields whose values are wall-clock stage timeouts, used to derive
 *  the staleness threshold for `possibly_wedged`. */
export type StageTimeoutConfig = Pick<
  PipelineConfig,
  | "implementation_timeout"
  | "review_timeout"
  | "plan_review_timeout"
  | "fix_timeout"
  | "ci_timeout"
  | "test_gate"
  | "eval_gate"
>;

/** Small margin added on top of the largest configured stage timeout before a
 *  quiet run is flagged `possibly_wedged`, so a stage legitimately still
 *  running near its cap is not mistaken for a wedge. */
const WEDGE_MARGIN_MS = 60_000;

/** The largest configured wall-clock stage timeout (seconds) across the
 *  advance-loop stages — the staleness threshold below which a quiet,
 *  unfinalized run is presumed to be running a long stage rather than wedged.
 *  Tolerates a partial/fake `cfg` (as used by some existing test fixtures that
 *  only carry `repo`/`domain`): a missing field contributes 0 rather than
 *  throwing. */
export function largestConfiguredStageTimeoutSec(cfg: Partial<StageTimeoutConfig>): number {
  return Math.max(
    cfg.implementation_timeout ?? 0,
    cfg.review_timeout ?? 0,
    cfg.plan_review_timeout ?? 0,
    cfg.fix_timeout ?? 0,
    cfg.ci_timeout ?? 0,
    cfg.test_gate?.timeout ?? 0,
    cfg.eval_gate?.timeout ?? 0,
  );
}

function derivePossiblyWedged(
  runEvents: RunEventsSummary | null | undefined,
  thresholdMs: number,
  now: Date,
): PossiblyWedged | null {
  if (!runEvents || runEvents.finalized || !runEvents.lastEvent) return null;
  const lastEventAgeMs = now.getTime() - Date.parse(runEvents.lastEvent.at);
  if (!Number.isFinite(lastEventAgeMs) || lastEventAgeMs <= thresholdMs) return null;
  return {
    last_event_age_ms: lastEventAgeMs,
    threshold_ms: thresholdMs,
    last_event_type: runEvents.lastEvent.type,
  };
}

// ---------------------------------------------------------------------------
// Payload assembler
// ---------------------------------------------------------------------------

export function buildStatusPayload(
  detail: StatusIssueDetail,
  prNumber: number | null,
  worktreeInfo: { path: string; slug: string } | null,
  cfg: Pick<PipelineConfig, "repo" | "domain"> & StageTimeoutConfig,
  runEvents: RunEventsSummary | null = null,
  now: Date = new Date(),
  handoffs?: StatusPayload["handoffs"],
): StatusPayload {
  const stage = pickStage(detail.labels);
  const blocked = isBlocked(detail.labels);

  const pr =
    prNumber !== null
      ? { number: prNumber, url: `https://github.com/${cfg.repo}/pull/${prNumber}` }
      : null;

  const branch = worktreeInfo ? `pipeline/${detail.number}-${worktreeInfo.slug}` : null;
  const worktree = worktreeInfo ? worktreeInfo.path : null;

  const writeHealth = runEvents?.writeHealth ?? null;
  const hostGuidance = deriveHostGuidance({
    stage,
    blocked,
    issue: detail.number,
    comments: detail.comments,
  });
  return {
    schema_version: "1",
    status: deriveStatus(stage, blocked, detail.state),
    issue: { number: detail.number, title: detail.title },
    stage,
    pr,
    branch,
    worktree,
    last_event: deriveLastEvent(detail.comments, detail.labelEvents),
    review_summary: deriveReviewSummary(detail.comments),
    next_action: deriveNextAction(stage, blocked, hostGuidance),
    host_guidance: hostGuidance,
    config: { repo: cfg.repo, domain: cfg.domain },
    possibly_wedged: derivePossiblyWedged(runEvents, largestConfiguredStageTimeoutSec(cfg) * 1000 + WEDGE_MARGIN_MS, now),
    // Elevated only — healthy/absent must not invent a failure (#633).
    event_stream_write_health: isElevatedWriteHealth(writeHealth) ? writeHealth : null,
    ...(handoffs && handoffs.length > 0 ? { handoffs } : {}),
  };
}

/** One-line prose warning when event-stream write-health is elevated (#633). */
export function formatWriteHealthStatusWarning(
  health: WriteHealthRecord | null | undefined,
): string | null {
  if (!isElevatedWriteHealth(health)) return null;
  const crit = health!.worst_criticality ?? "best-effort";
  const lastType = health!.last_event_type ?? "unknown";
  const lastErr = health!.last_error ?? "unknown error";
  return (
    `WARNING: event stream write failure — evidence may be incomplete ` +
    `(failures=${health!.failure_count}, worst=${crit}, last_type=${lastType}, last_error=${lastErr})`
  );
}
