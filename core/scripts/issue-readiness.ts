// Shared issue-implementation-readiness admission gate (#1238).
//
// One function in front of every GitHub issue pickup path. Disabled by default.
// When enabled, re-fetches title/body/labels, reuses a hash-and-treatment-bound
// owned comment when it matches, otherwise invokes the resolved Implementer
// with the planning treatment. Writes only that comment and the
// ready → needs-spec label transition.

import { createHash } from "node:crypto";
import {
  addLabel as ghAddLabel,
  deleteIssueComment,
  getGhActor,
  getIssueDetail,
  isHttp404Signal,
  listIssueCommentsWithIds,
  pickStage,
  postComment,
  removeLabel as ghRemoveLabel,
  updateIssueComment,
} from "./gh.ts";
import { invoke, type HarnessResult } from "./harness.ts";
import { buildIssueReadinessPrompt } from "./prompts/index.ts";
import {
  attestPipelineComment,
  extractPipelineAttestation,
  isVerifiedPipelineAttestation,
} from "./stages/review-parsing.ts";
import { LABEL_PREFIX, STAGES, type IssueReadinessVerdict, type PipelineConfig, type Stage } from "./types.ts";

export const ISSUE_READINESS_MARKER_PREFIX = "<!-- pipeline-issue-readiness";

export const ISSUE_READINESS_CANONICAL_HEADINGS = [
  "Summary",
  "User story",
  "Acceptance criteria",
  "Out of scope",
  "Open questions",
] as const;

const MARKER_RE =
  /<!-- pipeline-issue-readiness verdict=(ready|needs_spec) hash=([0-9a-f]{64}) implementer=(\S+) model=(\S+) effort=(\S+) -->/;

/** First evaluation plus this many restarts when live title/body drifts mid-call. */
const ISSUE_READINESS_INPUT_DRIFT_ATTEMPTS = 3;

export type IssueReadinessKind =
  | "ready"
  | "needs_spec"
  | "gate-unavailable"
  | "stale-dispatch"
  | "mutation-failed";

const ISSUE_READINESS_ATTEST_KINDS = new Set([
  "issue-readiness-admission",
  "issue-readiness-needs-spec",
]);

export interface IssueReadinessTreatment {
  implementer: string;
  model: string;
  effort: string;
}

export interface IssueReadinessRecord {
  verdict: "ready" | "needs_spec";
  hash: string;
  treatment: IssueReadinessTreatment;
}

export type IssueReadinessResult =
  | { kind: "ready"; reused: boolean; hash: string; treatment: IssueReadinessTreatment }
  | {
      kind: "needs_spec";
      reused: boolean;
      hash: string;
      treatment: IssueReadinessTreatment;
      deficiencies: string[];
      proposed_body: string;
    }
  | { kind: "gate-unavailable"; reason: string }
  | { kind: "stale-dispatch"; observedStage: Stage | null }
  | { kind: "mutation-failed"; reason: string };

export interface IssueReadinessComment {
  id: number;
  body: string;
  author: string;
}

export interface IssueReadinessDeps {
  fetchIssue(issueNumber: number): Promise<{
    title: string;
    body: string;
    labels: string[];
  }>;
  listComments(issueNumber: number): Promise<IssueReadinessComment[]>;
  getPipelineActor(): Promise<string | null>;
  createComment(issueNumber: number, body: string): Promise<void>;
  updateComment(commentId: number, body: string): Promise<void>;
  deleteComment(commentId: number): Promise<void>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  invokeImplementer(input: {
    harness: string;
    prompt: string;
    model: string;
    effort: string | undefined;
    timeoutSec: number;
  }): Promise<Pick<HarnessResult, "success" | "stdout" | "stderr" | "timed_out">>;
  now(): Date;
}

export interface EvaluateIssueReadinessOpts {
  dryRun?: boolean;
  deps?: IssueReadinessDeps;
}

export function resolvedPlanningTreatment(cfg: PipelineConfig): IssueReadinessTreatment {
  return {
    implementer: cfg.harnesses.implementer,
    model: cfg.models.planning,
    effort: cfg.effort.planning && cfg.effort.planning.length > 0 ? cfg.effort.planning : "-",
  };
}

export function hashIssueReadinessInput(
  title: string,
  body: string,
  treatment: IssueReadinessTreatment,
): string {
  const payload = JSON.stringify({
    title,
    body,
    implementer: treatment.implementer,
    model: treatment.model,
    effort: treatment.effort,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function formatIssueReadinessMarker(
  verdict: "ready" | "needs_spec",
  hash: string,
  treatment: IssueReadinessTreatment,
): string {
  return `${ISSUE_READINESS_MARKER_PREFIX} verdict=${verdict} hash=${hash} implementer=${treatment.implementer} model=${treatment.model} effort=${treatment.effort} -->`;
}

export function parseIssueReadinessMarker(body: string): IssueReadinessRecord | null {
  const m = body.match(MARKER_RE);
  if (!m) return null;
  return {
    verdict: m[1] as "ready" | "needs_spec",
    hash: m[2],
    treatment: { implementer: m[3], model: m[4], effort: m[5] },
  };
}

export function recordsMatch(
  record: IssueReadinessRecord,
  hash: string,
  treatment: IssueReadinessTreatment,
): boolean {
  return (
    record.hash === hash &&
    record.treatment.implementer === treatment.implementer &&
    record.treatment.model === treatment.model &&
    record.treatment.effort === treatment.effort
  );
}

export function realIssueReadinessDeps(cfg: PipelineConfig): IssueReadinessDeps {
  return {
    fetchIssue: async (issueNumber) => {
      const detail = await getIssueDetail(cfg, issueNumber);
      return { title: detail.title, body: detail.body, labels: detail.labels };
    },
    listComments: async (issueNumber) => listIssueCommentsWithIds(cfg, issueNumber),
    getPipelineActor: () => getGhActor(),
    createComment: async (issueNumber, body) => {
      await postComment(cfg, issueNumber, body);
    },
    updateComment: async (commentId, body) => {
      await updateIssueComment(cfg, commentId, body);
    },
    deleteComment: async (commentId) => {
      await deleteIssueComment(cfg, commentId);
    },
    addLabel: async (issueNumber, label) => {
      await ghAddLabel(cfg, issueNumber, label);
    },
    removeLabel: async (issueNumber, label) => {
      await ghRemoveLabel(cfg, issueNumber, label);
    },
    invokeImplementer: async (input) => {
      const result = await invoke(input.harness, cfg.repo_dir, input.prompt, {
        stream: false,
        model: input.model,
        reasoningEffort: input.effort === "-" ? undefined : input.effort,
        lean: true,
        timeoutSec: input.timeoutSec,
        role: "implementer",
      });
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timed_out,
      };
    },
    now: () => new Date(),
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in harness output");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseIssueReadinessVerdict(output: string): IssueReadinessVerdict {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(output);
  } catch (err) {
    throw new Error(`issue-readiness schema: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("issue-readiness schema: response is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.verdict !== "ready" && obj.verdict !== "needs_spec") {
    throw new Error("issue-readiness schema: verdict must be ready or needs_spec");
  }
  if (!Array.isArray(obj.deficiencies) || !obj.deficiencies.every((d) => typeof d === "string")) {
    throw new Error("issue-readiness schema: deficiencies must be a string array");
  }
  if (typeof obj.proposed_body !== "string") {
    throw new Error("issue-readiness schema: proposed_body must be a string");
  }
  if (obj.verdict === "needs_spec") {
    if (obj.deficiencies.length === 0) {
      throw new Error("issue-readiness schema: needs_spec requires deficiencies");
    }
    if (obj.proposed_body.trim().length === 0) {
      throw new Error("issue-readiness schema: needs_spec requires proposed_body");
    }
    if (!proposedBodyHasCanonicalHeadings(obj.proposed_body)) {
      throw new Error(
        "issue-readiness schema: needs_spec proposed_body must contain canonical headings in order",
      );
    }
  }
  return {
    verdict: obj.verdict,
    deficiencies: obj.deficiencies as string[],
    proposed_body: obj.proposed_body,
  };
}

export function proposedBodyHasCanonicalHeadings(body: string): boolean {
  let lastIndex = -1;
  for (const heading of ISSUE_READINESS_CANONICAL_HEADINGS) {
    const m = new RegExp(`^##\\s+${heading}\\s*$`, "im").exec(body);
    if (!m) return false;
    if (m.index <= lastIndex) return false;
    lastIndex = m.index;
  }
  return true;
}

function isOwnedReadinessComment(comment: IssueReadinessComment, actor: string): boolean {
  if (comment.author !== actor) return false;
  if (!isVerifiedPipelineAttestation(comment.body)) return false;
  const attestation = extractPipelineAttestation(comment.body);
  if (!attestation || !ISSUE_READINESS_ATTEST_KINDS.has(attestation.kind)) return false;
  return parseIssueReadinessMarker(comment.body) !== null;
}

function ownedReadinessComments(
  comments: IssueReadinessComment[],
  actor: string,
): { comment: IssueReadinessComment; record: IssueReadinessRecord }[] {
  const found: { comment: IssueReadinessComment; record: IssueReadinessRecord }[] = [];
  for (const comment of comments) {
    if (!isOwnedReadinessComment(comment, actor)) continue;
    const record = parseIssueReadinessMarker(comment.body);
    if (record) found.push({ comment, record });
  }
  found.sort((a, b) => a.comment.id - b.comment.id);
  return found;
}

function findOwnedReadinessComment(
  comments: IssueReadinessComment[],
  actor: string,
): { comment: IssueReadinessComment; record: IssueReadinessRecord } | undefined {
  return ownedReadinessComments(comments, actor)[0];
}

type LiveReadyCheck =
  | { status: "ready"; title: string; body: string; labels: string[] }
  | { status: "stale"; observedStage: Stage | null }
  | { status: "unavailable"; reason: string };

async function requireLiveReady(
  deps: IssueReadinessDeps,
  issueNumber: number,
): Promise<LiveReadyCheck> {
  let live: { title: string; body: string; labels: string[] };
  try {
    live = await deps.fetchIssue(issueNumber);
  } catch (err) {
    return { status: "unavailable", reason: `live re-fetch failed: ${(err as Error).message}` };
  }
  const observedStage = pickStage(live.labels);
  if (observedStage !== "ready") {
    return { status: "stale", observedStage };
  }
  return { status: "ready", title: live.title, body: live.body, labels: live.labels };
}

function liveReadyToResult(
  live: Exclude<LiveReadyCheck, { status: "ready" }>,
): Extract<IssueReadinessResult, { kind: "stale-dispatch" | "gate-unavailable" }> {
  if (live.status === "stale") {
    return { kind: "stale-dispatch", observedStage: live.observedStage };
  }
  return { kind: "gate-unavailable", reason: live.reason };
}

function renderOwnedComment(input: {
  verdict: "ready" | "needs_spec";
  hash: string;
  treatment: IssueReadinessTreatment;
  deficiencies: string[];
  proposed_body: string;
  evaluatedAt: string;
}): string {
  const marker = formatIssueReadinessMarker(input.verdict, input.hash, input.treatment);
  if (input.verdict === "ready") {
    return [
      "## Pipeline: issue-readiness admission",
      "",
      "Verdict: **ready**.",
      "",
      `Evaluated at ${input.evaluatedAt}. Bound to title/body hash \`${input.hash.slice(0, 12)}\` and planning treatment \`${input.treatment.implementer}\` / \`${input.treatment.model}\` / \`${input.treatment.effort}\`.`,
      "",
      marker,
    ].join("\n");
  }
  const deficiencies = input.deficiencies.map((d) => `- ${d}`).join("\n");
  return [
    "## Pipeline: issue-readiness — needs spec",
    "",
    "This issue is not executable as written. Apply the proposed body (or an equivalent complete spec), then re-admit with `pipeline triage <N> --stage ready`.",
    "",
    "### Deficiencies",
    "",
    deficiencies,
    "",
    "### Proposed revised body",
    "",
    input.proposed_body.trim(),
    "",
    `Evaluated at ${input.evaluatedAt}. Bound to title/body hash \`${input.hash.slice(0, 12)}\` and planning treatment \`${input.treatment.implementer}\` / \`${input.treatment.model}\` / \`${input.treatment.effort}\`.`,
    "",
    marker,
  ].join("\n");
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildIssueReadinessComment(input: {
  verdict: "ready" | "needs_spec";
  hash: string;
  treatment: IssueReadinessTreatment;
  deficiencies: string[];
  proposed_body: string;
  evaluatedAt: string;
}): string {
  const kind = input.verdict === "ready" ? "issue-readiness-admission" : "issue-readiness-needs-spec";
  return attestPipelineComment(kind, renderOwnedComment(input));
}

async function reconcileOwnedReadinessComments(
  deps: IssueReadinessDeps,
  issueNumber: number,
  actor: string,
  body: string,
): Promise<void> {
  const comments = await deps.listComments(issueNumber);
  const owned = ownedReadinessComments(comments, actor);
  if (owned.length === 0) {
    throw new Error("owned readiness comment missing after persist");
  }
  const canonical = owned[0].comment;
  if (canonical.body !== body) {
    await deps.updateComment(canonical.id, body);
  }
  for (const extra of owned.slice(1)) {
    try {
      await deps.deleteComment(extra.comment.id);
    } catch (err) {
      if (!isHttp404Signal((err as Error).message)) {
        throw err;
      }
    }
  }
}

async function persistOwnedComment(
  deps: IssueReadinessDeps,
  issueNumber: number,
  actor: string,
  owned: IssueReadinessComment | undefined,
  body: string,
): Promise<void> {
  if (owned) {
    await deps.updateComment(owned.id, body);
  } else {
    await deps.createComment(issueNumber, body);
  }
  await reconcileOwnedReadinessComments(deps, issueNumber, actor, body);
}

const NEEDS_SPEC_LABEL = `${LABEL_PREFIX}needs-spec`;
const READY_LABEL = `${LABEL_PREFIX}ready`;
const LABEL_TRANSITION_ATTEMPTS = 2;

async function applyNeedsSpecLabels(deps: IssueReadinessDeps, issueNumber: number, labels: string[]): Promise<void> {
  if (!labels.includes(NEEDS_SPEC_LABEL)) {
    await deps.addLabel(issueNumber, NEEDS_SPEC_LABEL);
  }
  if (labels.includes(READY_LABEL)) {
    await deps.removeLabel(issueNumber, READY_LABEL);
  }
}

function pipelineStageNames(labels: string[]): Stage[] {
  const found: Stage[] = [];
  for (const name of labels) {
    if (!name.startsWith(LABEL_PREFIX)) continue;
    const stage = name.slice(LABEL_PREFIX.length);
    if ((STAGES as readonly string[]).includes(stage)) found.push(stage as Stage);
  }
  return found;
}

/** True only when the sole pipeline stage label is needs-spec. */
function needsSpecTransitionComplete(labels: string[]): boolean {
  const stages = pipelineStageNames(labels);
  return stages.length === 1 && stages[0] === "needs-spec";
}

function simultaneousNonNeedsSpecStages(labels: string[]): Stage[] {
  return pipelineStageNames(labels).filter((stage) => stage !== "needs-spec");
}

function readyOnlyForNeedsSpecTransition(labels: string[]): boolean {
  const others = simultaneousNonNeedsSpecStages(labels);
  return others.length === 1 && others[0] === "ready";
}

function observedConflictingStage(labels: string[]): Stage | null {
  const others = simultaneousNonNeedsSpecStages(labels);
  return others.find((stage) => stage !== "ready") ?? pickStage(labels);
}

async function dropNeedsSpecOverlayVerified(
  deps: IssueReadinessDeps,
  issueNumber: number,
  labels: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!labels.includes(NEEDS_SPEC_LABEL)) return { ok: true };
  try {
    await deps.removeLabel(issueNumber, NEEDS_SPEC_LABEL);
  } catch (err) {
    if (!isHttp404Signal((err as Error).message)) {
      return {
        ok: false,
        reason: `live stage is ${observedConflictingStage(labels) ?? "none"}; failed to drop needs-spec overlay: ${(err as Error).message}`,
      };
    }
  }
  const verify = await fetchIssueLabels(deps, issueNumber);
  if ("error" in verify) {
    return {
      ok: false,
      reason: `live stage is ${observedConflictingStage(labels) ?? "none"}; failed to drop needs-spec overlay: live re-fetch failed: ${verify.error}`,
    };
  }
  if (verify.labels.includes(NEEDS_SPEC_LABEL)) {
    return {
      ok: false,
      reason: `live stage is ${observedConflictingStage(verify.labels) ?? "none"}; failed to drop needs-spec overlay`,
    };
  }
  return { ok: true };
}

async function staleAfterNeedsSpecLabels(
  deps: IssueReadinessDeps,
  issueNumber: number,
  labels: string[],
  wroteLabels: boolean,
): Promise<LabelTransitionResult> {
  const observed = observedConflictingStage(labels);
  if (wroteLabels || labels.includes(NEEDS_SPEC_LABEL)) {
    const dropped = await dropNeedsSpecOverlayVerified(deps, issueNumber, labels);
    if (!dropped.ok) return { status: "incomplete", reason: dropped.reason };
  }
  return { status: "stale", observedStage: observed };
}

async function fetchIssueLabels(
  deps: IssueReadinessDeps,
  issueNumber: number,
): Promise<{ labels: string[] } | { error: string }> {
  try {
    const live = await deps.fetchIssue(issueNumber);
    return { labels: live.labels };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function persistOwnedCommentVerified(
  deps: IssueReadinessDeps,
  issueNumber: number,
  actor: string,
  owned: IssueReadinessComment | undefined,
  body: string,
): Promise<{ status: "ok" } | { status: "absent"; reason: string } | { status: "unconfirmed"; reason: string }> {
  try {
    await persistOwnedComment(deps, issueNumber, actor, owned, body);
    return { status: "ok" };
  } catch (err) {
    const reason = (err as Error).message;
    try {
      const listed = ownedReadinessComments(await deps.listComments(issueNumber), actor);
      if (listed.some((item) => item.comment.body === body)) return { status: "ok" };
      await reconcileOwnedReadinessComments(deps, issueNumber, actor, body);
      const again = ownedReadinessComments(await deps.listComments(issueNumber), actor);
      if (again.some((item) => item.comment.body === body)) return { status: "ok" };
      return again.length === 0
        ? { status: "absent", reason }
        : { status: "unconfirmed", reason };
    } catch (verifyErr) {
      return { status: "unconfirmed", reason: `${reason}; re-fetch failed: ${(verifyErr as Error).message}` };
    }
  }
}

async function compensateOwnedComment(
  deps: IssueReadinessDeps,
  issueNumber: number,
  actor: string,
  previous: IssueReadinessComment | undefined,
  desiredBody: string,
): Promise<boolean> {
  try {
    if (previous) {
      await deps.updateComment(previous.id, previous.body);
      return true;
    }
    const owned = ownedReadinessComments(await deps.listComments(issueNumber), actor);
    for (const item of owned) {
      if (item.comment.body !== desiredBody) continue;
      try {
        await deps.deleteComment(item.comment.id);
      } catch (err) {
        if (!isHttp404Signal((err as Error).message)) throw err;
      }
    }
    const remaining = ownedReadinessComments(await deps.listComments(issueNumber), actor);
    return !remaining.some((item) => item.comment.body === desiredBody);
  } catch {
    return false;
  }
}

type LabelTransitionResult =
  | { status: "ok" }
  | { status: "stale"; observedStage: Stage | null }
  | { status: "unavailable"; reason: string }
  | { status: "incomplete"; reason: string };

async function applyNeedsSpecLabelsVerified(
  deps: IssueReadinessDeps,
  issueNumber: number,
): Promise<LabelTransitionResult> {
  let lastReason = "label transition failed";
  let wroteLabels = false;
  for (let attempt = 1; attempt <= LABEL_TRANSITION_ATTEMPTS; attempt++) {
    const fetched = await fetchIssueLabels(deps, issueNumber);
    if ("error" in fetched) {
      if (!wroteLabels && attempt === 1) {
        return { status: "unavailable", reason: `live re-fetch failed: ${fetched.error}` };
      }
      return { status: "incomplete", reason: `live re-fetch failed: ${fetched.error}` };
    }
    if (needsSpecTransitionComplete(fetched.labels)) return { status: "ok" };
    if (!readyOnlyForNeedsSpecTransition(fetched.labels)) {
      return staleAfterNeedsSpecLabels(deps, issueNumber, fetched.labels, wroteLabels);
    }
    try {
      await applyNeedsSpecLabels(deps, issueNumber, fetched.labels);
      wroteLabels = true;
    } catch (err) {
      wroteLabels = true;
      lastReason = (err as Error).message;
      continue;
    }
    const verify = await fetchIssueLabels(deps, issueNumber);
    if ("error" in verify) {
      lastReason = `live re-fetch failed: ${verify.error}`;
      continue;
    }
    if (needsSpecTransitionComplete(verify.labels)) return { status: "ok" };
    if (!readyOnlyForNeedsSpecTransition(verify.labels)) {
      return staleAfterNeedsSpecLabels(deps, issueNumber, verify.labels, true);
    }
    lastReason = "label transition did not stick";
  }
  return { status: "incomplete", reason: lastReason };
}

type NeedsSpecCommit =
  | { kind: "committed" }
  | Extract<IssueReadinessResult, { kind: "gate-unavailable" | "stale-dispatch" | "mutation-failed" }>;

async function finalizeNeedsSpecLabels(
  deps: IssueReadinessDeps,
  issueNumber: number,
  actor: string,
  comment:
    | { mutated: false }
    | { mutated: true; previous: IssueReadinessComment | undefined; desiredBody: string },
): Promise<NeedsSpecCommit> {
  const labels = await applyNeedsSpecLabelsVerified(deps, issueNumber);
  if (labels.status === "ok") return { kind: "committed" };
  if (labels.status === "stale") {
    if (comment.mutated) {
      const undone = await compensateOwnedComment(
        deps,
        issueNumber,
        actor,
        comment.previous,
        comment.desiredBody,
      );
      if (!undone) {
        return {
          kind: "mutation-failed",
          reason: `owned comment persisted but live stage is ${labels.observedStage ?? "none"}`,
        };
      }
    }
    return { kind: "stale-dispatch", observedStage: labels.observedStage };
  }
  if (!comment.mutated && (labels.status === "unavailable" || labels.status === "incomplete")) {
    const fetched = await fetchIssueLabels(deps, issueNumber);
    if (
      "labels" in fetched &&
      pickStage(fetched.labels) === "ready" &&
      !fetched.labels.includes(NEEDS_SPEC_LABEL)
    ) {
      return {
        kind: "gate-unavailable",
        reason: labels.status === "unavailable" ? labels.reason : `GitHub mutation failed: ${labels.reason}`,
      };
    }
  }
  const detail = labels.status === "unavailable" || labels.status === "incomplete" ? labels.reason : "label transition failed";
  return { kind: "mutation-failed", reason: `GitHub mutation incomplete: ${detail}` };
}

async function commitNeedsSpecWrites(
  deps: IssueReadinessDeps,
  issueNumber: number,
  actor: string,
  owned: IssueReadinessComment | undefined,
  body: string,
): Promise<NeedsSpecCommit> {
  const persist = await persistOwnedCommentVerified(deps, issueNumber, actor, owned, body);
  if (persist.status === "absent") {
    return { kind: "gate-unavailable", reason: `GitHub mutation failed: ${persist.reason}` };
  }
  if (persist.status === "unconfirmed") {
    return { kind: "mutation-failed", reason: `owned readiness comment write did not verify: ${persist.reason}` };
  }
  return finalizeNeedsSpecLabels(deps, issueNumber, actor, {
    mutated: true,
    previous: owned,
    desiredBody: body,
  });
}

/**
 * Shared admission gate. Callers skip this entirely when
 * `cfg.issue_readiness.enabled` is false.
 */
type InputDrift = { kind: "input-changed"; issue: { title: string; body: string; labels: string[] } };

async function confirmLiveInput(
  deps: IssueReadinessDeps,
  issueNumber: number,
  hash: string,
  treatment: IssueReadinessTreatment,
): Promise<LiveReadyCheck | InputDrift> {
  const live = await requireLiveReady(deps, issueNumber);
  if (live.status !== "ready") return live;
  const liveHash = hashIssueReadinessInput(live.title, live.body, treatment);
  if (liveHash !== hash) {
    return {
      kind: "input-changed",
      issue: { title: live.title, body: live.body, labels: live.labels },
    };
  }
  return live;
}

export async function evaluateIssueReadiness(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: EvaluateIssueReadinessOpts = {},
): Promise<IssueReadinessResult> {
  const deps = opts.deps ?? realIssueReadinessDeps(cfg);
  const dryRun = !!opts.dryRun;
  const treatment = resolvedPlanningTreatment(cfg);

  let issue: { title: string; body: string; labels: string[] };
  try {
    issue = await deps.fetchIssue(issueNumber);
  } catch (err) {
    return { kind: "gate-unavailable", reason: `fresh fetch failed: ${(err as Error).message}` };
  }

  const observedStage = pickStage(issue.labels);
  if (observedStage !== "ready") {
    return { kind: "stale-dispatch", observedStage };
  }

  let actor: string;
  try {
    const lookedUp = await deps.getPipelineActor();
    if (!lookedUp) {
      return { kind: "gate-unavailable", reason: "pipeline actor lookup failed" };
    }
    actor = lookedUp;
  } catch (err) {
    return { kind: "gate-unavailable", reason: `pipeline actor lookup failed: ${(err as Error).message}` };
  }

  for (let attempt = 1; attempt <= ISSUE_READINESS_INPUT_DRIFT_ATTEMPTS; attempt++) {
    const result = await evaluateIssueReadinessAttempt({
      cfg,
      issueNumber,
      deps,
      dryRun,
      treatment,
      issue,
      actor,
    });
    if (result.kind !== "input-changed") return result;
    issue = result.issue;
  }
  return {
    kind: "gate-unavailable",
    reason: "issue title/body changed during admission evaluation",
  };
}

async function evaluateIssueReadinessAttempt(input: {
  cfg: PipelineConfig;
  issueNumber: number;
  deps: IssueReadinessDeps;
  dryRun: boolean;
  treatment: IssueReadinessTreatment;
  issue: { title: string; body: string; labels: string[] };
  actor: string;
}): Promise<IssueReadinessResult | InputDrift> {
  const { cfg, issueNumber, deps, dryRun, treatment, issue, actor } = input;
  const observedStage = pickStage(issue.labels);
  if (observedStage !== "ready") {
    return { kind: "stale-dispatch", observedStage };
  }

  const hash = hashIssueReadinessInput(issue.title, issue.body, treatment);

  let comments: IssueReadinessComment[] = [];
  try {
    comments = await deps.listComments(issueNumber);
  } catch (err) {
    return { kind: "gate-unavailable", reason: `comment list failed: ${(err as Error).message}` };
  }

  const owned = findOwnedReadinessComment(comments, actor);

  if (owned?.record && recordsMatch(owned.record, hash, treatment)) {
    if (owned.record.verdict === "ready") {
      if (!dryRun) {
        const live = await confirmLiveInput(deps, issueNumber, hash, treatment);
        if ("kind" in live) return live;
        if (live.status !== "ready") return liveReadyToResult(live);
      }
      return { kind: "ready", reused: true, hash, treatment };
    }
    if (!dryRun) {
      const live = await confirmLiveInput(deps, issueNumber, hash, treatment);
      if ("kind" in live) return live;
      if (live.status !== "ready") return liveReadyToResult(live);
      const committed = await finalizeNeedsSpecLabels(deps, issueNumber, actor, { mutated: false });
      if (committed.kind !== "committed") return committed;
    }
    return {
      kind: "needs_spec",
      reused: true,
      hash,
      treatment,
      deficiencies: [],
      proposed_body: "",
    };
  }

  const prompt = buildIssueReadinessPrompt({
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
  });

  let harness: Pick<HarnessResult, "success" | "stdout" | "stderr" | "timed_out">;
  try {
    harness = await deps.invokeImplementer({
      harness: treatment.implementer,
      prompt,
      model: treatment.model,
      effort: treatment.effort,
      timeoutSec: cfg.issue_readiness.timeout,
    });
  } catch (err) {
    return { kind: "gate-unavailable", reason: `harness invoke failed: ${(err as Error).message}` };
  }

  if (harness.timed_out) {
    return { kind: "gate-unavailable", reason: "admission harness timed out" };
  }
  if (!harness.success) {
    return {
      kind: "gate-unavailable",
      reason: `admission harness failed: ${(harness.stderr || harness.stdout || "no output").slice(0, 400)}`,
    };
  }

  let verdict: IssueReadinessVerdict;
  try {
    verdict = parseIssueReadinessVerdict(harness.stdout);
  } catch (err) {
    return { kind: "gate-unavailable", reason: (err as Error).message };
  }

  const evaluatedAt = deps.now().toISOString().replace(/\.\d+Z$/, "Z");
  const commentBody = buildIssueReadinessComment({
    verdict: verdict.verdict,
    hash,
    treatment,
    deficiencies: verdict.deficiencies,
    proposed_body: verdict.proposed_body,
    evaluatedAt,
  });

  if (!dryRun) {
    const live = await confirmLiveInput(deps, issueNumber, hash, treatment);
    if ("kind" in live) return live;
    if (live.status !== "ready") return liveReadyToResult(live);
    if (verdict.verdict === "needs_spec") {
      const committed = await commitNeedsSpecWrites(
        deps,
        issueNumber,
        actor,
        owned?.comment,
        commentBody,
      );
      if (committed.kind !== "committed") return committed;
    } else {
      const persist = await persistOwnedCommentVerified(
        deps,
        issueNumber,
        actor,
        owned?.comment,
        commentBody,
      );
      if (persist.status === "absent") {
        return { kind: "gate-unavailable", reason: `GitHub mutation failed: ${persist.reason}` };
      }
      if (persist.status === "unconfirmed") {
        return {
          kind: "mutation-failed",
          reason: `owned readiness comment write did not verify: ${persist.reason}`,
        };
      }
      const after = await confirmLiveInput(deps, issueNumber, hash, treatment);
      if ("kind" in after) {
        await compensateOwnedComment(deps, issueNumber, actor, owned?.comment, commentBody);
        return after;
      }
      if (after.status !== "ready") {
        const undone = await compensateOwnedComment(deps, issueNumber, actor, owned?.comment, commentBody);
        if (!undone) {
          return {
            kind: "mutation-failed",
            reason: `owned ready comment persisted but live stage is ${after.status === "stale" ? (after.observedStage ?? "none") : "unconfirmed"}`,
          };
        }
        return liveReadyToResult(after);
      }
    }
  }

  if (verdict.verdict === "ready") {
    return { kind: "ready", reused: false, hash, treatment };
  }
  return {
    kind: "needs_spec",
    reused: false,
    hash,
    treatment,
    deficiencies: verdict.deficiencies,
    proposed_body: verdict.proposed_body,
  };
}

export function needsSpecSummary(result: Extract<IssueReadinessResult, { kind: "needs_spec" }>): string {
  const listed = result.deficiencies.length > 0 ? result.deficiencies.join("; ") : "spec is not executable";
  return `issue-readiness: needs_spec: ${listed}`;
}

export function gateUnavailableSummary(result: Extract<IssueReadinessResult, { kind: "gate-unavailable" }>): string {
  return `issue-readiness: gate-unavailable: ${result.reason}`;
}

export function mutationFailedSummary(result: Extract<IssueReadinessResult, { kind: "mutation-failed" }>): string {
  return `issue-readiness: mutation-failed: ${result.reason}`;
}

export function eventsTextHasGateUnavailable(eventsText: string | null | undefined): boolean {
  if (!eventsText) return false;
  for (const line of eventsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        event.type === "gate_result" &&
        event.gate === "issue_readiness" &&
        typeof event.reason === "string" &&
        event.reason.startsWith("gate-unavailable")
      ) {
        return true;
      }
    } catch {
      /* skip corrupt lines */
    }
  }
  return false;
}
