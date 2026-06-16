// Machine-readable status payload for `pipeline <issue> --status --json` (#154).
// Pure assembly logic: no I/O, no subprocess, no network calls.
// The caller provides pre-fetched data; this module maps it to the stable JSON envelope.

import { isBlocked, pickStage } from "./gh.ts";
import type { PipelineConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Envelope shapes (the public JSON contract — field names/types are stable)
// ---------------------------------------------------------------------------

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
  config: { repo: string; domain: string };
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
  if (stage === "backlog") return "waiting";
  return "ok";
}

export function deriveNextAction(stage: string | null, blocked: boolean): string {
  if (blocked) {
    return "Unblock with `--unblock \"<answer>\"` or fix the blocker, then re-run.";
  }
  const actions: Record<string, string> = {
    backlog: "Promote to `pipeline:ready` manually.",
    ready: "Pipeline will run planning and implementation.",
    planning: "Planning is in progress.",
    "plan-review": "Plan review is in progress.",
    implementing: "Implementation is in progress.",
    "review-1": "Standard review will run next.",
    "review-2": "Adversarial review will run next.",
    "fix-1": "Fix pass 1 will run next.",
    "fix-2": "Fix pass 2 will run next.",
    "pre-merge": "Pre-merge checks (CI, docs) will run next.",
    "eval-gate": "Eval gate will run next.",
    "shipcheck-gate": "Shipcheck will run next.",
    "ready-to-deploy": "Ready to deploy — awaiting human merge.",
    "needs-human":
      "Human decision required — use `--override \"<key>: <reason>\"` or fix residual findings.",
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
// Payload assembler
// ---------------------------------------------------------------------------

export function buildStatusPayload(
  detail: StatusIssueDetail,
  prNumber: number | null,
  worktreeInfo: { path: string; slug: string } | null,
  cfg: Pick<PipelineConfig, "repo" | "domain">,
): StatusPayload {
  const stage = pickStage(detail.labels);
  const blocked = isBlocked(detail.labels);

  const pr =
    prNumber !== null
      ? { number: prNumber, url: `https://github.com/${cfg.repo}/pull/${prNumber}` }
      : null;

  const branch = worktreeInfo ? `pipeline/${detail.number}-${worktreeInfo.slug}` : null;
  const worktree = worktreeInfo ? worktreeInfo.path : null;

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
    next_action: deriveNextAction(stage, blocked),
    config: { repo: cfg.repo, domain: cfg.domain },
  };
}
