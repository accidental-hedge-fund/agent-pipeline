// Issue-path grill preview and apply (#1072). Title/body refine-spec stays in refine-spec.ts.

import type { TreatmentFingerprint } from "./harness-adapters/treatment-fingerprint.ts";
import { classifyContextProposals, recordRequiredContextHashes } from "./grill-context.ts";
import {
  applyReviewerVerdicts,
  canonicalThinIssueNodes,
  embedDecisionsInBody,
  extractSpecCore,
  hasReviewerChallenge,
  implementerSelfAccepted,
  makeNode,
  MAX_NODES,
  MAX_NODE_TEXT,
  parseDecisionsFromBody,
  type ContextProposal,
  type DecisionNode,
  type DecisionsArtifact,
  type ReviewerVerdictKind,
} from "./grill-decisions.ts";
import { walkDeclaredDependencyClosure, type WalkDependenciesDeps } from "./grill-facts.ts";
import {
  buildGrillFingerprint,
  type GrillFingerprint,
  type ProviderConfigIdentity,
} from "./grill-fingerprint.ts";
import { createPendingGrillHandoffs } from "./grill-handoff.ts";
import { sha256Prefixed } from "./grill-hash.ts";
import {
  defaultGrillProposalKeyDeps,
  fileConsumedNonceStore,
  issueGrillProposal,
  parseEnvelopeBytes,
  resolveGrillProposalKey,
  verifyGrillProposal,
  type ConsumedNonceStore,
  type GrillProposalEnvelope,
  type GrillProposalKeyDeps,
} from "./grill-proposal.ts";
import { listHandoffs, type HandoffStoreDeps } from "./human-question-handoff.ts";
import type { GrillReadySnapshot } from "./grill-ready.ts";
import { buildGrillImplementerPrompt, buildGrillReviewerPrompt } from "./prompts/index.ts";
import { invoke } from "./harness.ts";
import { getIssueDetail } from "./gh.ts";
import { isKillSwitchActive } from "./lock.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

export const GRILL_USAGE =
  'Usage: pipeline refine-spec --title "<title>" --body "<markdown>"\n' +
  "       pipeline refine-spec --issue N [--json]\n" +
  "       pipeline refine-spec apply --issue N [--proposal-file PATH]\n";

export interface HarnessCallResult {
  success: boolean;
  output: string;
  timed_out?: boolean;
}

export interface GrillIssuePreviewDeps {
  getIssue(issueNumber: number): Promise<{ title: string; body: string }>;
  fetchDependencyIssue: WalkDependenciesDeps["fetchIssue"];
  readContextMd(): Promise<string>;
  resolveIntegrationBase(): Promise<string>;
  providerConfig: ProviderConfigIdentity;
  planningTreatment: TreatmentFingerprint;
  runImplementer(prompt: string): Promise<HarnessCallResult>;
  runReviewer(prompt: string): Promise<HarnessCallResult>;
  now(): Date;
  repo: string;
  domain: string;
  repoDir: string;
  keyDeps?: GrillProposalKeyDeps;
  log(msg: string): void;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface GrillIssueApplyDeps {
  getIssue(issueNumber: number): Promise<{ title: string; body: string }>;
  updateIssueBody(issueNumber: number, body: string): Promise<void>;
  isKillSwitchActive(): boolean;
  now(): Date;
  repo: string;
  domain: string;
  repoDir: string;
  keyDeps?: GrillProposalKeyDeps;
  nonceStore?: ConsumedNonceStore;
  handoffStore?: HandoffStoreDeps;
  readStdin(): string;
  readFile(p: string): string;
  stdinHasBytes(): boolean;
  log(msg: string): void;
  writeStderr(text: string): void;
}

function fail(deps: { writeStderr(text: string): void }, message: string, code: number): number {
  deps.writeStderr(`pipeline refine-spec: ${message}\n`);
  process.exitCode = code;
  return code;
}

function parseJsonObject(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/s, "$1").trim();
  return JSON.parse(stripped);
}

function rawImplementerSelfAccepted(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.resolution === "accept" || o.resolution === "resolved" || o.settled_by === "reviewer-accept") return true;
    const p = o.provenance;
    if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      if (rec.settled_by === "reviewer-accept" || rec.reviewer_verdict === "accept") return true;
    }
  }
  return false;
}

function parseImplementerNodes(raw: unknown): DecisionNode[] {
  if (!Array.isArray(raw) || raw.length === 0) return canonicalThinIssueNodes();
  const nodes: DecisionNode[] = [];
  for (const item of raw.slice(0, MAX_NODES)) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(o.id)
      ? o.id
      : `n${nodes.length + 1}`;
    const question = typeof o.question === "string" ? o.question.slice(0, MAX_NODE_TEXT) : "";
    const recommendation =
      typeof o.recommendation === "string" ? o.recommendation.slice(0, MAX_NODE_TEXT) : "";
    const cls = typeof o.class === "string" ? o.class : "scope";
    const term_id = typeof o.term_id === "string" ? o.term_id : undefined;
    const node = makeNode({ id, question, recommendation, class: cls, term_id });
    if (o.resolution === "resolved") node.resolution = "resolved";
    nodes.push(node);
  }
  const present = new Set(nodes.map((n) => n.class));
  for (const extra of canonicalThinIssueNodes()) {
    if (!present.has(extra.class)) nodes.push(extra);
  }
  return nodes.slice(0, MAX_NODES);
}

function parseImplementerProposals(raw: unknown): ContextProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextProposal[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.term_id !== "string" || typeof o.definition !== "string") continue;
    out.push({
      term_id: o.term_id,
      definition: o.definition,
      necessity: o.necessity === "required" ? "required" : "advisory",
    });
  }
  return out;
}

export function planningTreatmentFromConfig(cfg: {
  implementer: string;
  planningModel: string;
  planningEffort: string;
}): TreatmentFingerprint {
  return {
    adapterId: cfg.implementer,
    adapterContractVersion: "1",
    cliPath: null,
    cliVersion: null,
    capabilityHash: sha256Prefixed(`grill-planning:${cfg.implementer}`).slice("sha256:".length, "sha256:".length + 16),
    role: "implementer",
    requestedModel: cfg.planningModel,
    resolvedModel: cfg.planningModel,
    requestedEffort: cfg.planningEffort,
    resolvedEffort: cfg.planningEffort,
    sandboxToolPolicy: null,
    promptContractVersion: "grill-preview/v1",
    outputContractVersion: "grill-preview/json",
    fallback: null,
    failureReason: null,
    providerAuthClass: null,
    telemetryCoverage: {
      cost: "unavailable",
      usage: "unavailable",
      resolvedModel: "unavailable",
      throttled: "unavailable",
    },
    costSource: "unknown",
    origin: null,
  };
}

export async function runRefineSpecIssuePreview(
  issueNumber: number,
  deps: GrillIssuePreviewDeps,
): Promise<number> {
  const issue = await deps.getIssue(issueNumber);
  const contextMd = await deps.readContextMd();
  const integrationBase = await deps.resolveIntegrationBase();
  const walk = await walkDeclaredDependencyClosure(
    issueNumber,
    issue.title,
    issue.body,
    { fetchIssue: deps.fetchDependencyIssue },
  );

  const implementerPrompt = buildGrillImplementerPrompt({
    title: issue.title,
    body: issue.body,
    integrationBaseSha: integrationBase,
    contextMd,
    dependencyFacts: walk.facts.map((f) => `${f.code}: ${f.message}`).join("\n") || "(none)",
  });
  deps.log("[pipeline refine-spec] implementer planning-treatment call...");
  let implementerOut: HarnessCallResult;
  try {
    implementerOut = await deps.runImplementer(implementerPrompt);
  } catch (err) {
    return fail(deps, `implementer error: ${(err as Error).message}`, 1);
  }
  if (!implementerOut.success) {
    return fail(
      deps,
      implementerOut.timed_out ? "implementer timed out" : "implementer call failed",
      1,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    const raw = parseJsonObject(implementerOut.output);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(deps, "implementer returned a non-object", 1);
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    return fail(deps, "implementer returned non-JSON output", 1);
  }
  if (typeof parsed.body !== "string" || parsed.body.length === 0) {
    return fail(deps, "implementer response missing body", 1);
  }
  if (rawImplementerSelfAccepted(parsed.nodes)) {
    return fail(deps, "implementer cannot mark its own nodes accept, settled-by: reviewer-accept, or resolved", 1);
  }
  const nodes = parseImplementerNodes(parsed.nodes);
  if (implementerSelfAccepted(nodes)) {
    return fail(deps, "implementer cannot mark its own nodes accept, settled-by: reviewer-accept, or resolved", 1);
  }
  const rawProposals = parseImplementerProposals(parsed.context_proposals);
  const classified = classifyContextProposals(rawProposals, nodes, contextMd);
  const required = recordRequiredContextHashes(
    classified.required_context,
    integrationBase,
    contextMd,
  );

  const fingerprintForReview: GrillFingerprint = buildGrillFingerprint({
    title: issue.title,
    appliedBody: "",
    dependencyClosure: walk.record,
    integrationBaseSha: integrationBase,
    contextMd,
    providerConfig: deps.providerConfig,
    planningTreatment: deps.planningTreatment,
  });

  const reviewArtifact: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes,
    fingerprint: fingerprintForReview,
    required_context: required,
    unresolved_facts: walk.facts,
    context_proposals: classified.proposals,
  };

  const reviewerPrompt = buildGrillReviewerPrompt({
    artifactJson: JSON.stringify(reviewArtifact, null, 2),
    fingerprintJson: JSON.stringify(fingerprintForReview, null, 2),
  });
  deps.log("[pipeline refine-spec] reviewer call on Decisions artifact...");
  let reviewerOut: HarnessCallResult;
  try {
    reviewerOut = await deps.runReviewer(reviewerPrompt);
  } catch (err) {
    return fail(deps, `reviewer error: ${(err as Error).message}`, 1);
  }
  if (!reviewerOut.success) {
    return fail(deps, reviewerOut.timed_out ? "reviewer timed out" : "reviewer call failed", 1);
  }
  let verdicts: Array<{ node_id: string; verdict: ReviewerVerdictKind; reason: string }>;
  try {
    const raw = parseJsonObject(reviewerOut.output);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(deps, "reviewer returned a non-object", 1);
    }
    const v = (raw as Record<string, unknown>).verdicts;
    if (!Array.isArray(v)) return fail(deps, "reviewer verdicts missing", 1);
    verdicts = [];
    for (const item of v) {
      if (item === null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.node_id !== "string") continue;
      if (o.verdict !== "accept" && o.verdict !== "challenge") {
        return fail(deps, "reviewer verdict must be accept or challenge", 1);
      }
      verdicts.push({
        node_id: o.node_id,
        verdict: o.verdict,
        reason: typeof o.reason === "string" ? o.reason : "",
      });
    }
  } catch {
    return fail(deps, "reviewer returned non-JSON output", 1);
  }
  for (const node of nodes) {
    if (!verdicts.some((v) => v.node_id === node.id)) {
      return fail(deps, `reviewer omitted verdict for node ${node.id}`, 1);
    }
  }
  const applied = applyReviewerVerdicts(nodes, verdicts);
  if (!applied.ok) return fail(deps, applied.reason, 1);

  const specBody =
    typeof parsed.body === "string" ? extractSpecCore(parsed.body) : extractSpecCore(issue.body);
  const artifact: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes: applied.nodes,
    fingerprint: {
      ...fingerprintForReview,
      applied_body_sha256: sha256Prefixed(specBody),
    },
    required_context: required,
    unresolved_facts: walk.facts,
    context_proposals: classified.proposals,
  };
  const body = embedDecisionsInBody(specBody, artifact);

  const key = resolveGrillProposalKey(deps.repoDir, deps.keyDeps ?? defaultGrillProposalKeyDeps, {
    createIfMissing: true,
  });
  const signed = issueGrillProposal({
    now: deps.now(),
    repo: deps.repo,
    issue: issueNumber,
    input: {
      title: issue.title,
      body: issue.body,
      title_sha256: sha256Prefixed(issue.title),
      body_sha256: sha256Prefixed(issue.body),
      fingerprint: artifact.fingerprint,
    },
    proposal: {
      body,
      artifact,
      verdicts,
      advisory_title: typeof parsed.title === "string" ? parsed.title : issue.title,
      advisory_milestone: typeof parsed.milestone === "string" ? parsed.milestone : null,
      context_proposals: classified.proposals,
    },
    key,
  });
  if (!signed.ok) return fail(deps, signed.reason, 1);
  deps.writeStdout(`${JSON.stringify(signed.envelope)}\n`);
  process.exitCode = 0;
  return 0;
}

export async function runRefineSpecApply(
  issueNumber: number,
  opts: { proposalFile?: string; positionalProposal?: string },
  deps: GrillIssueApplyDeps,
): Promise<number> {
  if (opts.positionalProposal) {
    return fail(deps, "a positional proposal blob is not accepted; use stdin or --proposal-file", 2);
  }
  const fileSet = typeof opts.proposalFile === "string" && opts.proposalFile.length > 0;
  const stdinSet = deps.stdinHasBytes();
  if (fileSet && stdinSet) {
    return fail(deps, "provide stdin XOR --proposal-file, not both", 2);
  }
  if (!fileSet && !stdinSet) {
    return fail(deps, "apply requires stdin or --proposal-file", 2);
  }
  let raw: string;
  try {
    raw = fileSet ? deps.readFile(opts.proposalFile!) : deps.readStdin();
  } catch (err) {
    return fail(deps, `failed to read proposal: ${(err as Error).message}`, 2);
  }
  if (!raw || raw.trim().length === 0) {
    return fail(deps, "proposal input is empty", 2);
  }
  const parsed = parseEnvelopeBytes(raw);
  if (!parsed.ok) return fail(deps, parsed.reason, 2);
  const envelope: GrillProposalEnvelope = parsed.envelope;
  let key: string;
  try {
    key = resolveGrillProposalKey(deps.repoDir, deps.keyDeps ?? defaultGrillProposalKeyDeps, {
      createIfMissing: false,
    });
  } catch (err) {
    return fail(deps, (err as Error).message, 2);
  }
  const verified = verifyGrillProposal(envelope, key, deps.now(), {
    repo: deps.repo,
    issue: issueNumber,
  });
  if (!verified.ok) return fail(deps, verified.reason, 2);
  if (hasReviewerChallenge(envelope.proposal.artifact.nodes)) {
    return fail(deps, "proposal contains a reviewer challenge", 2);
  }
  const nonceStore = deps.nonceStore ?? fileConsumedNonceStore(deps.repoDir, deps.keyDeps);
  if (nonceStore.isConsumed(envelope.nonce)) {
    return fail(deps, "proposal nonce already consumed", 2);
  }
  if (deps.isKillSwitchActive()) {
    return fail(
      deps,
      `kill switch is active (/tmp/pipeline-${deps.domain}.disabled). Remove it to re-enable apply.`,
      2,
    );
  }
  const live = await deps.getIssue(issueNumber);
  if (live.title !== envelope.input.title || live.body !== envelope.input.body) {
    return fail(deps, "live title/body drifted from the proposal input", 2);
  }
  const bodyCheck = parseDecisionsFromBody(envelope.proposal.body);
  if (!bodyCheck.ok) return fail(deps, `proposal body is not a valid Decisions artifact: ${bodyCheck.reason}`, 2);
  const created = await createPendingGrillHandoffs(
    deps.repoDir,
    {
      domain: deps.domain,
      repo: deps.repo,
      issueNumber,
      artifact: envelope.proposal.artifact,
      proposedBody: envelope.proposal.body,
      frontierFp: envelope.proposal.artifact.fingerprint.planning_treatment_sha256,
    },
    deps.handoffStore,
  );
  if (!created.ok) return fail(deps, `handoff create failed: ${created.reason}`, 2);
  try {
    await deps.updateIssueBody(issueNumber, envelope.proposal.body);
  } catch (err) {
    return fail(deps, `GitHub body write failed: ${(err as Error).message}`, 1);
  }
  nonceStore.consume(envelope.nonce);
  deps.log(`[pipeline refine-spec] applied Decisions body to #${issueNumber}`);
  process.exitCode = 0;
  return 0;
}

export function usageError(message: string, writeStderr: (t: string) => void): number {
  writeStderr(`pipeline refine-spec: ${message}\n${GRILL_USAGE}`);
  process.exitCode = 2;
  return 2;
}

function gitIntegrationBase(repoDir: string, baseBranch: string): string {
  const r = spawnSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
    encoding: "utf8",
    cwd: repoDir,
  });
  if (r.status !== 0) {
    throw new Error(`could not resolve integration base origin/${baseBranch}: ${r.stderr?.trim() ?? ""}`);
  }
  return r.stdout.trim();
}

function readContextMdFile(repoDir: string): string {
  const p = path.join(repoDir, "CONTEXT.md");
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function realGrillIssuePreviewDeps(cfg: PipelineConfig): GrillIssuePreviewDeps {
  const implementer = cfg.harnesses.implementer;
  const reviewer = cfg.harnesses.reviewer;
  const planningModel = cfg.models.planning;
  const planningEffort = cfg.effort.planning;
  const providerConfig = {
    implementer,
    reviewer,
    planning_model: planningModel,
    planning_effort: planningEffort,
  };
  return {
    repo: cfg.repo,
    domain: cfg.domain,
    repoDir: cfg.repo_dir,
    providerConfig,
    planningTreatment: planningTreatmentFromConfig({
      implementer,
      planningModel,
      planningEffort,
    }),
    now: () => new Date(),
    log: (msg) => process.stderr.write(msg + "\n"),
    writeStdout: (t) => process.stdout.write(t),
    writeStderr: (t) => process.stderr.write(t),
    getIssue: async (n) => {
      const d = await getIssueDetail(cfg, n);
      return { title: d.title, body: d.body };
    },
    fetchDependencyIssue: async (id) => {
      try {
        const d = await getIssueDetail(cfg, id);
        return { ok: true, title: d.title, body: d.body };
      } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        if (msg.includes("404") || msg.includes("not found")) {
          return { ok: false, code: "missing" };
        }
        return { ok: false, code: "inaccessible" };
      }
    },
    readContextMd: async () => readContextMdFile(cfg.repo_dir),
    resolveIntegrationBase: async () => gitIntegrationBase(cfg.repo_dir, cfg.base_branch),
    runImplementer: async (prompt) => {
      const result = await invoke(implementer, cfg.repo_dir, prompt, {
        stream: false,
        model: planningModel,
        reasoningEffort: planningEffort,
        lean: true,
        timeoutSec: cfg.intake_timeout ?? DEFAULT_CONFIG.intake_timeout,
      });
      return { success: result.success, output: result.stdout, timed_out: result.timed_out };
    },
    runReviewer: async (prompt) => {
      const result = await invoke(reviewer, cfg.repo_dir, prompt, {
        stream: false,
        model: cfg.models.review,
        reasoningEffort: cfg.effort.review,
        lean: true,
        timeoutSec: cfg.review_timeout ?? DEFAULT_CONFIG.review_timeout,
      });
      return { success: result.success, output: result.stdout, timed_out: result.timed_out };
    },
  };
}

export function realGrillIssueApplyDeps(cfg: PipelineConfig): GrillIssueApplyDeps {
  return {
    repo: cfg.repo,
    domain: cfg.domain,
    repoDir: cfg.repo_dir,
    now: () => new Date(),
    log: (msg) => process.stderr.write(msg + "\n"),
    writeStderr: (t) => process.stderr.write(t),
    isKillSwitchActive: () => isKillSwitchActive(cfg.domain),
    stdinHasBytes: () => !process.stdin.isTTY,
    readStdin: () => fs.readFileSync(0, "utf8"),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    getIssue: async (n) => {
      const d = await getIssueDetail(cfg, n);
      return { title: d.title, body: d.body };
    },
    updateIssueBody: async (n, body) => {
      const result = spawnSync(
        "gh",
        ["issue", "edit", String(n), "-R", cfg.repo, "--body", body],
        { encoding: "utf8", stdio: "pipe", cwd: cfg.repo_dir },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `gh issue edit failed (${result.status})`);
      }
    },
  };
}

export async function realGrillReadySnapshot(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<GrillReadySnapshot> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const contextMd = readContextMdFile(cfg.repo_dir);
  const integrationBaseSha = gitIntegrationBase(cfg.repo_dir, cfg.base_branch);
  const walk = await walkDeclaredDependencyClosure(issueNumber, detail.title, detail.body, {
    fetchIssue: async (id) => {
      try {
        const d = await getIssueDetail(cfg, id);
        return { ok: true as const, title: d.title, body: d.body };
      } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        if (msg.includes("404") || msg.includes("not found")) {
          return { ok: false as const, code: "missing" as const };
        }
        return { ok: false as const, code: "inaccessible" as const };
      }
    },
  });
  const providerConfig = {
    implementer: cfg.harnesses.implementer,
    reviewer: cfg.harnesses.reviewer,
    planning_model: cfg.models.planning,
    planning_effort: cfg.effort.planning,
  };
  const planningTreatment = planningTreatmentFromConfig({
    implementer: cfg.harnesses.implementer,
    planningModel: cfg.models.planning,
    planningEffort: cfg.effort.planning,
  });
  const fingerprint = buildGrillFingerprint({
    title: detail.title,
    appliedBody: extractSpecCore(detail.body),
    dependencyClosure: walk.record,
    integrationBaseSha,
    contextMd,
    providerConfig,
    planningTreatment,
  });
  const handoffs = await listHandoffs(cfg.repo_dir, { issue: issueNumber });
  return {
    title: detail.title,
    body: detail.body,
    comments: detail.comments,
    fingerprint,
    contextMd,
    integrationBaseSha,
    handoffs,
  };
}
