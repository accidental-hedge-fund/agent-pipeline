// Native grill-with-docs admission (#1369).
// Select, freeze, auto-settle, write Decisions + domain docs, request pipeline:ready.
// Never merges, deploys, or writes the integration branch.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDeclaredDependencyIds } from "../declared-dependency-grammar.ts";
import {
  addLabel as ghAddLabel,
  getIssueDetail,
  getIssueStateAndLabels,
  ghChildEnv,
  removeLabel as ghRemoveLabel,
} from "../gh.ts";
import { invoke } from "../harness.ts";
import type { PipelineConfig } from "../types.ts";
import { DEFAULT_CONFIG } from "../types.ts";
import {
  findMilestoneNumberByTitle,
  listMilestoneOpenIssuesApiArgs,
  listMilestonesApiArgs,
  parseMilestoneIssuesPages,
  parseMilestonesPages,
  type MilestoneApiRaw,
  type MilestoneIssueApiRaw,
} from "./milestone-open-issues.ts";
import { classifyContextProposals, recordRequiredContextHashes } from "../grill-context.ts";
import {
  canonicalThinIssueNodes,
  DEPENDENCY_FACT_CODES,
  embedDecisionsInBody,
  extractSpecCore,
  makeNode,
  MAX_NODES,
  MAX_NODE_TEXT,
  parseDecisionsFromBody,
  type ContextProposal,
  type DecisionNode,
  type DecisionsArtifact,
} from "../grill-decisions.ts";
import { walkDeclaredDependencyClosure, type FetchedIssue } from "../grill-facts.ts";
import {
  buildGrillFingerprint,
  fingerprintStaleReasons,
  type ProviderConfigIdentity,
} from "../grill-fingerprint.ts";
import {
  issueGrillFrontier,
  loadVerifiedGrillFrontier,
  persistGrillFrontier,
} from "../grill-frontier.ts";
import { createPendingGrillHandoffs, supersedeStaleGrillHandoffs } from "../grill-handoff.ts";
import { sha256Prefixed } from "../grill-hash.ts";
import { planningTreatmentFromConfig } from "../grill-issue.ts";
import {
  defaultGrillProposalKeyDeps,
  resolveGrillProposalKey,
  type GrillProposalKeyDeps,
} from "../grill-proposal.ts";
import { validateDecisionsForReady, type GrillReadySnapshot } from "../grill-ready.ts";
import {
  freezeManifest,
  parseGrillSelector,
  type GrillIneligible,
  type GrillManifest,
  type GrillSelector,
  type GrillSelectorFlags,
} from "../grill-selector.ts";
import {
  parseSignalsFromModel,
  settleRecommendation,
} from "../grill-settle.ts";
import {
  appendGrillEvent,
  emptyLedger,
  grillStatusCounts,
  initGrillRun,
  loadGrillLedger,
  loadGrillManifest,
  newGrillRunId,
  saveGrillLedger,
  type GrillIssueState,
  type GrillLedger,
  type GrillStoreDeps,
} from "../grill-store.ts";
import { AUTO_ACCEPT_ELIGIBILITY_REASON } from "../grill-taxonomy.ts";
import type { TreatmentFingerprint } from "../harness-adapters/treatment-fingerprint.ts";
import { listHandoffs, type HandoffStoreDeps } from "../human-question-handoff.ts";
import { buildGrillAdmissionPrompt } from "../prompts/index.ts";
import { runTriage, type TriageDeps } from "./triage.ts";

export const GRILL_WITH_DOCS_MARKER_RE = /<!--\s*grill-with-docs:v1\.40\.1\s*-->/;

export function hasGrillWithDocsMarker(body: string): boolean {
  return GRILL_WITH_DOCS_MARKER_RE.test(body);
}

export function isGrillMigratedBody(body: string): boolean {
  if (hasGrillWithDocsMarker(body)) return true;
  const parsed = parseDecisionsFromBody(body);
  return parsed.ok;
}

export interface GrillIssueRecord {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

export interface GrillHarnessResult {
  success: boolean;
  output: string;
}

export interface GrillDocsPrDeps {
  createWorktree(branch: string, baseRef: string): Promise<string>;
  writeFile(absPath: string, content: string): Promise<void>;
  gitCommit(worktree: string, files: string[], message: string): Promise<void>;
  gitPushBranch(worktree: string, branch: string): Promise<void>;
  createPR(title: string, body: string, base: string, head: string): Promise<string>;
}

export interface GrillDeps {
  getIssue(issueNumber: number): Promise<GrillIssueRecord | null>;
  fetchDependencyIssue(id: number): Promise<FetchedIssue>;
  listMilestoneOpenIssues(title: string): Promise<number[]>;
  listOpenIssuesByLabel(label: string): Promise<number[]>;
  updateIssueBody(issueNumber: number, body: string): Promise<void>;
  getIssueLabels(issueNumber: number): Promise<string[]>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  readContextMd(): Promise<string>;
  resolveIntegrationBase(): Promise<string>;
  listIssueBodyRevisions?(issueNumber: number): Promise<string[]>;
  runImplementer(prompt: string): Promise<GrillHarnessResult>;
  providerConfig: ProviderConfigIdentity;
  planningTreatment: TreatmentFingerprint;
  repo: string;
  domain: string;
  repoDir: string;
  baseBranch: string;
  store: GrillStoreDeps;
  keyDeps?: GrillProposalKeyDeps;
  handoffStore?: HandoffStoreDeps;
  docsPr?: GrillDocsPrDeps;
  now(): Date;
  uuid(): string;
  log(msg: string): void;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  /** Test seam: grill must never push to these. */
  callLog: string[];
}

export interface GrillCliInput extends GrillSelectorFlags {
  dryRun?: boolean;
  json?: boolean;
  follow?: boolean;
  resume?: string;
  runId?: string;
  status?: boolean;
}

export interface GrillReport {
  run_id: string;
  selected: number;
  migrated: number;
  waiting: number;
  ready: number;
  failed: number;
  ineligible: GrillIneligible[];
  issues: GrillIssueState[];
  dry_run: boolean;
}

export const GRILL_USAGE =
  "Usage: pipeline grill --issue N [--dry-run] [--json]\n" +
  "       pipeline grill --issues N,N,... [--dry-run] [--json]\n" +
  "       pipeline grill --milestone M [--dry-run] [--json]\n" +
  "       pipeline grill --label L [--label L] [--dry-run] [--json]\n" +
  "       pipeline grill status --run-id <id> [--follow] [--json]\n" +
  "       pipeline grill --resume <run-id>\n";

function fail(deps: Pick<GrillDeps, "writeStderr">, message: string, code: number): number {
  deps.writeStderr(`pipeline grill: ${message}\n`);
  return code;
}

function parseJsonObject(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/s, "$1").trim();
  return JSON.parse(stripped);
}

export function intersectIds(groups: number[][]): number[] {
  if (groups.length === 0) return [];
  let set = new Set(groups[0]);
  for (const g of groups.slice(1)) {
    const next = new Set(g);
    set = new Set([...set].filter((n) => next.has(n)));
  }
  return [...set].sort((a, b) => a - b);
}

export async function resolveGrillMembership(
  selector: GrillSelector,
  deps: GrillDeps,
): Promise<{ openIds: number[]; ineligible: GrillIneligible[] }> {
  let candidates: number[] = [];
  if (selector.form === "issue") candidates = [selector.issue];
  else if (selector.form === "issues") candidates = selector.issues;
  else if (selector.form === "milestone") {
    candidates = await deps.listMilestoneOpenIssues(selector.milestone);
  } else {
    const groups: number[][] = [];
    for (const label of selector.labels) {
      groups.push(await deps.listOpenIssuesByLabel(label));
    }
    candidates = intersectIds(groups);
  }
  const openIds: number[] = [];
  const ineligible: GrillIneligible[] = [];
  const seen = new Set<number>();
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const issue = await deps.getIssue(id);
    if (!issue || issue.state === "closed") {
      ineligible.push({ issue: id, reason: issue ? "closed" : "missing" });
      continue;
    }
    openIds.push(id);
  }
  openIds.sort((a, b) => a - b);
  return { openIds, ineligible };
}

function parseImplementerNodes(
  raw: unknown,
): Array<DecisionNode & { depends_on?: string[]; signalsRaw: Record<string, unknown> }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return canonicalThinIssueNodes().map((n) => ({ ...n, signalsRaw: {} }));
  }
  const nodes: Array<DecisionNode & { depends_on?: string[]; signalsRaw: Record<string, unknown> }> = [];
  for (const item of raw.slice(0, MAX_NODES)) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id =
      typeof o.id === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(o.id)
        ? o.id
        : `n${nodes.length + 1}`;
    const question = typeof o.question === "string" ? o.question.slice(0, MAX_NODE_TEXT) : "";
    const recommendation =
      typeof o.recommendation === "string" ? o.recommendation.slice(0, MAX_NODE_TEXT) : "";
    const cls = typeof o.class === "string" ? o.class : "scope";
    const term_id = typeof o.term_id === "string" ? o.term_id : undefined;
    const node = makeNode({ id, question, recommendation, class: cls, term_id });
    const depends_on = Array.isArray(o.depends_on)
      ? o.depends_on.filter((d): d is string => typeof d === "string")
      : undefined;
    nodes.push({ ...node, depends_on, signalsRaw: o });
  }
  const present = new Set(nodes.map((n) => n.class));
  for (const extra of canonicalThinIssueNodes()) {
    if (!present.has(extra.class)) nodes.push({ ...extra, signalsRaw: {} });
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

/** Shared settlement used by --issue and batch. */
export function settleFrontierNodes(
  rawNodes: Array<DecisionNode & { depends_on?: string[]; signalsRaw: Record<string, unknown> }>,
  factText: string,
): DecisionNode[] {
  const byId = new Map(rawNodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const out = new Map<string, DecisionNode>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of rawNodes) {
      if (out.has(node.id)) continue;
      const deps = node.depends_on ?? [];
      if (deps.some((d) => !done.has(d) && byId.has(d))) continue;
      progressed = true;
      const signals = parseSignalsFromModel(node.signalsRaw, node.class);
      if (factText && node.question && factText.toLowerCase().includes(node.question.toLowerCase().slice(0, 40))) {
        signals.discoverable_from_facts = true;
      }
      const result = settleRecommendation(node, signals);
      if (result.kind === "auto-accept") {
        out.set(node.id, {
          ...node,
          resolution: "resolved",
          provenance: {
            settled_by: "auto-accept",
            reference: null,
            reviewer_verdict: null,
            reviewer_reason: null,
            eligibility_reason: result.eligibility_reason,
          },
        });
        done.add(node.id);
        continue;
      }
      if (result.kind === "typed-request") {
        out.set(node.id, {
          ...node,
          resolution: "unresolved",
          typed_request: result.request,
          provenance: {
            settled_by: "none",
            reference: null,
            reviewer_verdict: null,
            reviewer_reason: null,
            eligibility_reason: result.reason,
          },
        });
        continue;
      }
      out.set(node.id, node);
    }
  }
  for (const node of rawNodes) {
    if (!out.has(node.id)) out.set(node.id, node);
  }
  return rawNodes.map((n) => {
    const settled = out.get(n.id)!;
    const { depends_on: _d, signalsRaw: _s, ...rest } = settled as typeof n;
    void _d;
    void _s;
    return rest;
  });
}

function formatReport(report: GrillReport): string {
  const lines = [
    `grill run ${report.run_id}${report.dry_run ? " (dry-run)" : ""}`,
    `selected: ${report.selected}  migrated: ${report.migrated}  waiting: ${report.waiting}  ready: ${report.ready}  failed: ${report.failed}`,
  ];
  for (const issue of report.issues) {
    lines.push(
      `#${issue.issue} ${issue.status}${issue.migrated ? " migrated" : ""}` +
        (issue.typed_requests.length
          ? ` requests=${issue.typed_requests.map((r) => r.kind).join(",")}`
          : "") +
        (issue.ready_gate.reason ? ` ready=${issue.ready_gate.reason}` : "") +
        (issue.error ? ` error=${issue.error}` : ""),
    );
    for (const ev of issue.evidence) lines.push(`  - ${ev}`);
  }
  for (const inel of report.ineligible) {
    lines.push(`#${inel.issue} ineligible (${inel.reason})`);
  }
  return `${lines.join("\n")}\n`;
}

function reportFrom(manifest: GrillManifest, ledger: GrillLedger, dryRun: boolean): GrillReport {
  const counts = grillStatusCounts(ledger, manifest.issue_ids.length);
  return {
    run_id: manifest.run_id,
    ...counts,
    ineligible: manifest.ineligible,
    issues: manifest.issue_ids.map((id) => ledger.issues[String(id)]).filter(Boolean) as GrillIssueState[],
    dry_run: dryRun,
  };
}

async function orderByDependencies(
  ids: number[],
  deps: GrillDeps,
): Promise<number[]> {
  const remaining = new Set(ids);
  const ordered: number[] = [];
  const depMap = new Map<number, number[]>();
  for (const id of ids) {
    const issue = await deps.getIssue(id);
    const text = issue ? `${issue.title}\n${extractSpecCore(issue.body)}` : "";
    const raw = parseDeclaredDependencyIds(text, String(id));
    depMap.set(
      id,
      raw.map(Number).filter((n) => remaining.has(n) && n !== id),
    );
  }
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (depMap.get(id) ?? []).every((d) => !remaining.has(d)));
    const batch = ready.length > 0 ? ready.sort((a, b) => a - b) : [[...remaining].sort((a, b) => a - b)[0]!];
    for (const id of batch) {
      remaining.delete(id);
      ordered.push(id);
    }
  }
  return ordered;
}

function discoverableFactText(contextMd: string, depFacts: string, body: string): string {
  return `${contextMd}\n${depFacts}\n${extractSpecCore(body)}`;
}

async function readySnapshotFor(
  issue: GrillIssueRecord,
  artifact: DecisionsArtifact,
  deps: GrillDeps,
  contextMd: string,
  integrationBase: string,
  frontier: GrillReadySnapshot["frontier"],
): Promise<GrillReadySnapshot> {
  const handoffs = await listHandoffs(deps.repoDir, { issue: issue.number }, deps.handoffStore);
  return {
    title: issue.title,
    body: issue.body,
    fingerprint: artifact.fingerprint,
    contextMd,
    integrationBaseSha: integrationBase,
    handoffs,
    comments: [],
    frontier,
  };
}

async function promoteReady(issueNumber: number, deps: GrillDeps, snapshot: GrillReadySnapshot): Promise<void> {
  const triageDeps: TriageDeps = {
    getIssueLabels: (n) => deps.getIssueLabels(n),
    addLabel: (n, l) => deps.addLabel(n, l),
    removeLabel: (n, l) => deps.removeLabel(n, l),
    log: deps.log,
    getReadySnapshot: async () => snapshot,
  };
  await runTriage({ issueArg: String(issueNumber), stage: "ready" }, triageDeps);
}

export async function grillOneIssue(
  issueNumber: number,
  deps: GrillDeps,
  opts: { dryRun: boolean; state: GrillIssueState },
): Promise<GrillIssueState> {
  const state = opts.state;
  const live = await deps.getIssue(issueNumber);
  if (!live || live.state === "closed") {
    return {
      ...state,
      status: "ineligible",
      evidence: [`closed or missing at evaluation`],
    };
  }
  const contextMd = await deps.readContextMd();
  const integrationBase = await deps.resolveIntegrationBase();
  const walk = await walkDeclaredDependencyClosure(issueNumber, live.title, live.body, {
    fetchIssue: deps.fetchDependencyIssue,
  });
  const depFacts = walk.facts.map((f) => `${f.code}: ${f.message}`).join("\n") || "(none)";
  state.facts = walk.facts.map((f) => f.code);
  const migrated = isGrillMigratedBody(live.body);
  state.migrated = migrated || hasGrillWithDocsMarker(live.body);

  const existing = parseDecisionsFromBody(live.body);
  if (existing.ok) {
    const liveFp = buildGrillFingerprint({
      title: live.title,
      appliedBody: extractSpecCore(live.body),
      dependencyClosure: walk.record,
      integrationBaseSha: integrationBase,
      contextMd,
      providerConfig: deps.providerConfig,
      planningTreatment: deps.planningTreatment,
    });
    const stale = fingerprintStaleReasons(existing.artifact.fingerprint, liveFp);
    if (stale.length > 0) {
      state.evidence.push(`stale recommendations: ${stale.join(", ")}`);
    } else {
      const key = resolveGrillProposalKey(deps.repoDir, deps.keyDeps ?? defaultGrillProposalKeyDeps, {
        createIfMissing: true,
      });
      const frontier = loadVerifiedGrillFrontier(
        deps.repoDir,
        issueNumber,
        key,
        deps.repo,
        deps.keyDeps ?? defaultGrillProposalKeyDeps,
      );
      const snap = await readySnapshotFor(
        { ...live, body: live.body },
        { ...existing.artifact, fingerprint: liveFp },
        deps,
        contextMd,
        integrationBase,
        frontier,
      );
      const ready = validateDecisionsForReady({ ...snap, fingerprint: liveFp, body: live.body });
      if (ready.ok) {
        state.ready_gate = { ok: true };
        if (opts.dryRun) {
          state.status = "ready";
          state.evidence.push("dry-run: existing artifact is ready");
          return state;
        }
        const labels = live.labels.filter((l) => l.startsWith("pipeline:"));
        if (labels.length === 1 && labels[0] === "pipeline:ready") {
          state.status = "ready";
          state.evidence.push("idempotent: already pipeline:ready");
          return state;
        }
        await promoteReady(issueNumber, deps, { ...snap, body: live.body, fingerprint: liveFp });
        state.status = "ready";
        state.evidence.push("promoted existing fingerprint-current artifact");
        return state;
      }
      state.ready_gate = { ok: false, reason: ready.reason, code: ready.code };
    }
  }

  const prompt = buildGrillAdmissionPrompt({
    title: live.title,
    body: live.body,
    integrationBaseSha: integrationBase,
    contextMd,
    dependencyFacts: depFacts,
  });
  deps.log(`[pipeline grill] #${issueNumber} implementer frontier round`);
  let implementerOut: GrillHarnessResult;
  try {
    implementerOut = await deps.runImplementer(prompt);
  } catch (err) {
    state.status = "failed";
    state.error = `implementer error: ${(err as Error).message}`;
    return state;
  }
  if (!implementerOut.success) {
    state.status = "failed";
    state.error = "implementer call failed";
    return state;
  }
  let parsed: Record<string, unknown>;
  try {
    const raw = parseJsonObject(implementerOut.output);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      state.status = "failed";
      state.error = "implementer returned a non-object";
      return state;
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    state.status = "failed";
    state.error = "implementer returned non-JSON output";
    return state;
  }
  if (typeof parsed.body !== "string" || parsed.body.length === 0) {
    state.status = "failed";
    state.error = "implementer response missing body";
    return state;
  }
  const factText = discoverableFactText(contextMd, depFacts, live.body);
  const rawNodes = parseImplementerNodes(parsed.nodes);
  const nodes = settleFrontierNodes(rawNodes, factText);
  const rawProposals = parseImplementerProposals(parsed.context_proposals);
  const classified = classifyContextProposals(rawProposals, nodes, contextMd);
  const required = recordRequiredContextHashes(classified.required_context, integrationBase, contextMd);
  const specBody = extractSpecCore(parsed.body);
  const signedWalk = await walkDeclaredDependencyClosure(issueNumber, live.title, specBody, {
    fetchIssue: deps.fetchDependencyIssue,
  });
  const fingerprint = buildGrillFingerprint({
    title: live.title,
    appliedBody: specBody,
    dependencyClosure: signedWalk.record,
    integrationBaseSha: integrationBase,
    contextMd,
    providerConfig: deps.providerConfig,
    planningTreatment: deps.planningTreatment,
  });
  const artifact: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes,
    fingerprint,
    required_context: required,
    unresolved_facts: signedWalk.facts,
    context_proposals: classified.proposals,
  };
  const newBody = embedDecisionsInBody(specBody, artifact);
  state.accepted_node_ids = nodes.filter((n) => n.provenance.settled_by === "auto-accept").map((n) => n.id);
  state.typed_requests = nodes
    .filter((n) => n.typed_request && n.resolution !== "resolved")
    .map((n) => ({
      node_id: n.id,
      kind: n.typed_request!,
      handoff_class: n.typed_request === "CapabilityRequest" ? "missing_context" : "product_judgment",
    }));
  for (const p of classified.proposals) {
    state.docs_actions.push({
      kind: "context_term",
      term_id: p.term_id,
      payload_sha256: sha256Prefixed(`${p.term_id}\n${p.definition}`),
      necessity: p.necessity,
    });
  }
  if (opts.dryRun) {
    const blockingFacts = signedWalk.facts.filter((f) =>
      (DEPENDENCY_FACT_CODES as readonly string[]).includes(f.code),
    );
    const waitingDocs = classified.required_context.terms.length > 0 && !required.integration_base_sha;
    state.status = blockingFacts.length || state.typed_requests.length || waitingDocs ? "waiting" : "ready";
    state.evidence.push("dry-run: no mutations");
    state.ready_gate = {
      ok: state.status === "ready",
      reason: waitingDocs ? "required documentation" : state.typed_requests[0]?.kind,
    };
    return state;
  }

  const key = resolveGrillProposalKey(deps.repoDir, deps.keyDeps ?? defaultGrillProposalKeyDeps, {
    createIfMissing: true,
  });
  const frontierFp = sha256Prefixed(newBody);
  const handoffResult = await createPendingGrillHandoffs(
    deps.repoDir,
    {
      domain: deps.domain,
      repo: deps.repo,
      issueNumber,
      artifact,
      proposedBody: newBody,
      frontierFp,
    },
    deps.handoffStore,
  );
  if (!handoffResult.ok) {
    state.status = "failed";
    state.error = handoffResult.reason;
    return state;
  }
  for (const h of handoffResult.created) {
    const rec = state.typed_requests.find((t) => h.question && h.question.includes(""));
    void rec;
  }

  if (state.last_body_sha256 !== sha256Prefixed(newBody)) {
    await deps.updateIssueBody(issueNumber, newBody);
    state.last_body_sha256 = sha256Prefixed(newBody);
    state.evidence.push("wrote Decisions body");
  } else {
    state.evidence.push("skipped duplicate body write");
  }

  const frontier = issueGrillFrontier({
    repo: deps.repo,
    issue: issueNumber,
    body: newBody,
    artifact,
    now: deps.now(),
    key,
  });
  persistGrillFrontier(deps.repoDir, frontier, deps.keyDeps ?? defaultGrillProposalKeyDeps);
  const currentHandoffs = await listHandoffs(
    deps.repoDir,
    { issue: issueNumber },
    deps.handoffStore,
  );
  await supersedeStaleGrillHandoffs(
    deps.repoDir,
    { issueNumber, artifact, proposedBody: newBody, frontierFp, currentHandoffs },
    deps.handoffStore,
  );

  const applied = await deps.getIssue(issueNumber);
  const appliedBody = applied?.body ?? newBody;
  const snap = await readySnapshotFor(
    { ...live, body: appliedBody },
    artifact,
    deps,
    contextMd,
    integrationBase,
    frontier,
  );
  const waitingDocs = classified.required_context.terms.length > 0 && !required.integration_base_sha;
  if (waitingDocs) {
    state.status = "waiting";
    state.evidence.push("waiting for required documentation on trusted base");
    return state;
  }
  const ready = validateDecisionsForReady({ ...snap, body: appliedBody });
  if (!ready.ok) {
    state.ready_gate = { ok: false, reason: ready.reason, code: ready.code };
    state.status = state.typed_requests.length ? "waiting" : "waiting";
    state.evidence.push(`ready gate: ${ready.reason}`);
    return state;
  }
  state.ready_gate = { ok: true };
  await promoteReady(issueNumber, deps, { ...snap, body: appliedBody });
  state.status = "ready";
  state.evidence.push("promoted pipeline:ready");
  return state;
}

async function openDocsPrIfNeeded(ledger: GrillLedger, deps: GrillDeps, dryRun: boolean): Promise<void> {
  if (dryRun || !deps.docsPr) return;
  const actions = Object.values(ledger.issues).flatMap((i) => i.docs_actions);
  const unique = new Map<string, (typeof actions)[number]>();
  for (const a of actions) {
    if (!unique.has(a.payload_sha256)) unique.set(a.payload_sha256, a);
  }
  if (unique.size === 0) return;
  if (ledger.docs_pr_url) return;
  const branch = `docs/grill-${ledger.run_id}`.replace(/[^A-Za-z0-9._/-]/g, "-");
  const worktree = await deps.docsPr.createWorktree(branch, deps.baseBranch);
  const contextMd = await deps.readContextMd();
  let next = contextMd.trimEnd();
  const files = ["CONTEXT.md"];
  for (const action of unique.values()) {
    if (action.kind === "context_term" && action.term_id && !next.includes(`**${action.term_id}**:`)) {
      next += `\n\n**${action.term_id}**:\nSettled by pipeline grill.\n`;
    }
  }
  await deps.docsPr.writeFile(`${worktree}/CONTEXT.md`, `${next}\n`);
  await deps.docsPr.gitCommit(worktree, files, `docs(context): grill glossary terms (${ledger.run_id})`);
  await deps.docsPr.gitPushBranch(worktree, branch);
  const url = await deps.docsPr.createPR(
    `docs: grill glossary (${ledger.run_id})`,
    "Domain terms settled by pipeline grill. Do not merge from admission.",
    deps.baseBranch,
    branch,
  );
  ledger.docs_pr_url = url;
}

export async function runGrill(input: GrillCliInput, deps: GrillDeps): Promise<number> {
  if (deps.callLog.some((c) => c.startsWith("merge") || c === "ship" || c.includes("train --merge"))) {
    return fail(deps, "internal: forbidden merge/ship call already recorded", 1);
  }
  if (input.status) {
    const runId = input.runId ?? input.resume;
    if (!runId) return fail(deps, "status requires --run-id", 2);
    const manifest = await loadGrillManifest(deps.store, runId);
    const ledger = await loadGrillLedger(deps.store, runId);
    const report = reportFrom(manifest, ledger, false);
    deps.writeStdout(input.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    if (input.follow) {
      if (ledger.status === "complete" || ledger.status === "failed") return 0;
      return 0;
    }
    return 0;
  }

  let manifest: GrillManifest;
  let ledger: GrillLedger;
  if (input.resume) {
    manifest = await loadGrillManifest(deps.store, input.resume);
    ledger = await loadGrillLedger(deps.store, input.resume);
  } else {
    const parsed = parseGrillSelector(input);
    if (!parsed.ok) return fail(deps, parsed.reason, 2);
    const membership = await resolveGrillMembership(parsed.selector, deps);
    const runId = newGrillRunId(deps.now(), deps.uuid());
    const base = await deps.resolveIntegrationBase();
    manifest = freezeManifest({
      runId,
      selector: parsed.selector,
      openIds: membership.openIds,
      ineligible: membership.ineligible,
      repo: deps.repo,
      createdAt: deps.now().toISOString(),
      integrationBaseSha: base,
    });
    ledger = emptyLedger(runId, manifest.issue_ids);
    if (!input.dryRun) {
      await initGrillRun(deps.store, manifest, ledger);
      await appendGrillEvent(deps.store, runId, { type: "run_started", issue_ids: manifest.issue_ids });
    }
  }

  const dryRun = !!input.dryRun;
  const ordered = await orderByDependencies(manifest.issue_ids, deps);
  const completed = new Set<number>();
  for (const id of ordered) {
    const prior = ledger.issues[String(id)] ?? emptyLedger(manifest.run_id, [id]).issues[String(id)]!;
    if (prior.status === "ready" || prior.status === "failed" || prior.status === "ineligible") {
      completed.add(id);
      continue;
    }
    try {
      const next = await grillOneIssue(id, deps, { dryRun, state: { ...prior } });
      ledger.issues[String(id)] = next;
      if (next.status === "failed") {
        completed.add(id);
      } else if (next.status === "ready" || next.status === "waiting" || next.status === "ineligible") {
        completed.add(id);
      }
    } catch (err) {
      ledger.issues[String(id)] = {
        ...prior,
        status: "failed",
        error: (err as Error).message,
        evidence: [...prior.evidence, "isolated failure"],
      };
      completed.add(id);
    }
  }

  if (!dryRun) {
    await openDocsPrIfNeeded(ledger, deps, dryRun);
    const states = Object.values(ledger.issues);
    if (states.some((s) => s.status === "failed") && states.every((s) => s.status !== "pending" && s.status !== "in_progress")) {
      ledger.status = states.every((s) => s.status === "failed") ? "failed" : "complete";
    } else if (states.some((s) => s.status === "waiting")) {
      ledger.status = "waiting";
    } else {
      ledger.status = "complete";
    }
    await saveGrillLedger(deps.store, ledger);
  }

  const report = reportFrom(manifest, ledger, dryRun);
  deps.writeStdout(input.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  if (report.failed > 0 && report.ready === 0 && report.waiting === 0) return 1;
  return 0;
}

export function realGrillPlanningTreatment(cfg: {
  implementer: string;
  planningModel: string;
  planningEffort: string;
}): TreatmentFingerprint {
  return planningTreatmentFromConfig(cfg);
}

export { AUTO_ACCEPT_ELIGIBILITY_REASON };

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
  try {
    return fs.readFileSync(path.join(repoDir, "CONTEXT.md"), "utf8");
  } catch {
    return "";
  }
}

function parseSlurpPages<T>(stdout: string): T[][] {
  const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) return [];
  if (parsed.length > 0 && Array.isArray(parsed[0])) return parsed as T[][];
  return [parsed as T[]];
}

function ghSpawn(args: string[], cwd: string): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    cwd,
    env: ghChildEnv(),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args[0]} failed`);
  }
  return result.stdout;
}

export function realGrillDeps(cfg: PipelineConfig): GrillDeps {
  const implementer = cfg.harnesses.implementer;
  const planningModel = cfg.models.planning;
  const planningEffort = cfg.effort.planning;
  return {
    repo: cfg.repo,
    domain: cfg.domain,
    repoDir: cfg.repo_dir,
    baseBranch: cfg.base_branch,
    callLog: [],
    providerConfig: {
      implementer,
      reviewer: cfg.harnesses.reviewer,
      planning_model: planningModel,
      planning_effort: planningEffort,
    },
    planningTreatment: planningTreatmentFromConfig({
      implementer,
      planningModel,
      planningEffort,
    }),
    store: {
      fsExists: async (p) => fs.existsSync(p),
      readTextFile: async (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      },
      writeFileAtomic: async (p, content) => {
        const dir = path.dirname(p);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, content, "utf8");
        fs.renameSync(tmp, p);
      },
      createFileExclusive: async (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        try {
          const fd = fs.openSync(p, "wx");
          fs.writeFileSync(fd, content, "utf8");
          fs.closeSync(fd);
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw err;
        }
      },
      mkdirp: async (p) => {
        fs.mkdirSync(p, { recursive: true });
      },
      listDir: async (p) => {
        try {
          return fs.readdirSync(p);
        } catch {
          return [];
        }
      },
      now: () => new Date(),
      uuid: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      env: process.env,
    },
    now: () => new Date(),
    uuid: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    log: (msg) => process.stderr.write(`${msg}\n`),
    writeStdout: (t) => process.stdout.write(t),
    writeStderr: (t) => process.stderr.write(t),
    getIssue: async (n) => {
      try {
        const d = await getIssueDetail(cfg, n);
        return {
          number: n,
          title: d.title,
          body: d.body,
          labels: d.labels ?? [],
          state: (d.state?.toLowerCase() === "closed" ? "closed" : "open") as "open" | "closed",
        };
      } catch {
        return null;
      }
    },
    fetchDependencyIssue: async (id) => {
      try {
        const d = await getIssueDetail(cfg, id);
        return { ok: true, title: d.title, body: d.body };
      } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        if (msg.includes("404") || msg.includes("not found")) return { ok: false, code: "missing" };
        return { ok: false, code: "inaccessible" };
      }
    },
    listMilestoneOpenIssues: async (title) => {
      const msOut = ghSpawn(listMilestonesApiArgs(cfg.repo), cfg.repo_dir);
      const milestoneNumber = findMilestoneNumberByTitle(
        parseMilestonesPages(parseSlurpPages<MilestoneApiRaw>(msOut)),
        title,
      );
      if (milestoneNumber === null) throw new Error(`milestone "${title}" not found`);
      const issueOut = ghSpawn(listMilestoneOpenIssuesApiArgs(cfg.repo, milestoneNumber), cfg.repo_dir);
      return parseMilestoneIssuesPages(parseSlurpPages<MilestoneIssueApiRaw>(issueOut)).map((i) => i.number);
    },
    listOpenIssuesByLabel: async (label) => {
      const out = ghSpawn(
        ["api", `repos/${cfg.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`, "--paginate", "--slurp"],
        cfg.repo_dir,
      );
      return parseMilestoneIssuesPages(parseSlurpPages<MilestoneIssueApiRaw>(out)).map((i) => i.number);
    },
    updateIssueBody: async (n, body) => {
      const result = spawnSync(
        "gh",
        ["issue", "edit", String(n), "-R", cfg.repo, "--body", body],
        { encoding: "utf8", stdio: "pipe", cwd: cfg.repo_dir, env: ghChildEnv() },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `gh issue edit failed (${result.status})`);
      }
    },
    getIssueLabels: async (n) => {
      const result = await getIssueStateAndLabels(cfg, n);
      return result?.labels ?? [];
    },
    addLabel: async (n, label) => {
      await ghAddLabel(cfg, n, label);
    },
    removeLabel: async (n, label) => {
      await ghRemoveLabel(cfg, n, label);
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
      return { success: result.success, output: result.stdout };
    },
  };
}
