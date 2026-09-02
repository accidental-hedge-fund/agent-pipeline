// Grill-authority handoff create + body materialize (#1072).
// Reuses `pipeline handoff answer`; no second ledger.

import * as path from "node:path";
import { artifactSubdir, GRILL_PROPOSALS_ARTIFACT } from "./artifact-ignore.ts";
import {
  embedDecisionsInBody,
  extractSpecCore,
  nodeDefinitionDigest,
  parseDecisionsFromBody,
  patchNodeInArtifact,
  type DecisionNode,
  type DecisionsArtifact,
} from "./grill-decisions.ts";
import {
  issueGrillFrontier,
  liveMatchesGrillFrontier,
  loadVerifiedGrillFrontier,
  persistGrillFrontier,
} from "./grill-frontier.ts";
import {
  canonicalJson,
  hmacEqual,
  hmacSha256Hex,
  sha256Hex,
  sha256Prefixed,
} from "./grill-hash.ts";
import {
  defaultGrillProposalKeyDeps,
  type GrillProposalKeyDeps,
} from "./grill-proposal.ts";
import { classifyAuthority, isOperatorRequiredClass } from "./grill-taxonomy.ts";
import { typedRequestHandoffClass } from "./grill-settle.ts";
import {
  appendHandoffAudit,
  canCreateHandoff,
  createAndPersistHandoff,
  defaultHandoffStoreDeps,
  listHandoffs,
  saveHandoff,
  supersedeHandoff,
  type CreateHandoffInput,
  type HandoffClass,
  type HandoffStoreDeps,
  type HumanQuestionHandoff,
} from "./human-question-handoff.ts";

export const GRILL_DECLARATION_PREFIX = "grill-v1:";

export function isGrillAuthorityDeclaration(identity: string | null | undefined): boolean {
  return typeof identity === "string" && identity.startsWith(GRILL_DECLARATION_PREFIX);
}

export function grillHandoffClass(nodeClass: string): HandoffClass {
  if (nodeClass === "security" || nodeClass === "irreversible-operations") return "risk_authority";
  return "product_judgment";
}

function hexDigest(value: string): string {
  if (value.startsWith("sha256:") && /^[0-9a-f]{64}$/.test(value.slice(7))) return value.slice(7);
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  return sha256Hex(value);
}

export function grillDeclarationIdentity(input: {
  nodeId: string;
  frontierFp: string;
  bodySha256: string;
  definitionSha256: string;
}): string {
  return `${GRILL_DECLARATION_PREFIX}${input.nodeId}:${hexDigest(input.frontierFp)}:${hexDigest(input.bodySha256)}:${hexDigest(input.definitionSha256)}`;
}

export function parseGrillDeclaration(
  identity: string,
): { nodeId: string; frontierFp: string; bodySha256: string; definitionSha256: string } | null {
  const m =
    /^grill-v1:([a-z][a-z0-9-]{0,62}):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(identity);
  if (!m) return null;
  return { nodeId: m[1]!, frontierFp: m[2]!, bodySha256: m[3]!, definitionSha256: m[4]! };
}

export function liveNodeMatchesGrillBinding(
  node: DecisionNode,
  definitionSha256: string,
): boolean {
  return hexDigest(nodeDefinitionDigest(node)) === hexDigest(definitionSha256);
}

export const GRILL_RECOVERY_SCHEMA = "grill-recovery.v1" as const;
export const GRILL_RECOVERY_KIND = "grill-recovery" as const;
export const GRILL_RECOVERY_MAC_PREFIX = "hmac-sha256:";

export interface GrillRecoveryReceipt {
  schema_version: typeof GRILL_RECOVERY_SCHEMA;
  kind: typeof GRILL_RECOVERY_KIND;
  issued_at: string;
  repo: string;
  issue: number;
  handoff_id: string;
  expected_body_sha256: string;
  mac: string;
}

export function grillRecoveryReceiptPath(
  repoDir: string,
  issueNumber: number,
  handoffId: string,
): string {
  return path.join(
    artifactSubdir(repoDir, GRILL_PROPOSALS_ARTIFACT),
    `recovery-issue-${issueNumber}-handoff-${handoffId}.json`,
  );
}

export function issueGrillRecoveryReceipt(input: {
  repo: string;
  issue: number;
  handoffId: string;
  expectedBody: string;
  now: Date;
  key: string;
}): GrillRecoveryReceipt {
  const issuedAt = input.now.toISOString().replace(/\.\d+Z$/, "Z");
  const unsigned: Omit<GrillRecoveryReceipt, "mac"> = {
    schema_version: GRILL_RECOVERY_SCHEMA,
    kind: GRILL_RECOVERY_KIND,
    issued_at: issuedAt,
    repo: input.repo,
    issue: input.issue,
    handoff_id: input.handoffId,
    expected_body_sha256: sha256Prefixed(input.expectedBody),
  };
  const mac = `${GRILL_RECOVERY_MAC_PREFIX}${hmacSha256Hex(input.key, canonicalJson(unsigned))}`;
  return { ...unsigned, mac };
}

export function verifyGrillRecoveryReceipt(
  record: GrillRecoveryReceipt,
  key: string,
  expected: { repo: string; issue: number; handoffId: string },
): { ok: true; expected_body_sha256: string } | { ok: false; reason: string } {
  if (record.schema_version !== GRILL_RECOVERY_SCHEMA || record.kind !== GRILL_RECOVERY_KIND) {
    return { ok: false, reason: "unknown grill-recovery schema" };
  }
  if (record.issue !== expected.issue) {
    return { ok: false, reason: "grill-recovery issue does not match" };
  }
  if (record.repo !== expected.repo) {
    return { ok: false, reason: "grill-recovery repo does not match" };
  }
  if (record.handoff_id !== expected.handoffId) {
    return { ok: false, reason: "grill-recovery handoff does not match" };
  }
  const { mac, ...unsigned } = record;
  const expectedMac = hmacSha256Hex(key, canonicalJson(unsigned));
  const actualMac =
    typeof mac === "string" && mac.startsWith(GRILL_RECOVERY_MAC_PREFIX)
      ? mac.slice(GRILL_RECOVERY_MAC_PREFIX.length)
      : "";
  if (!hmacEqual(expectedMac, actualMac)) {
    return { ok: false, reason: "grill-recovery MAC verification failed" };
  }
  if (typeof record.expected_body_sha256 !== "string") {
    return { ok: false, reason: "grill-recovery expected body hash missing" };
  }
  return { ok: true, expected_body_sha256: record.expected_body_sha256 };
}

export function persistGrillRecoveryReceipt(
  repoDir: string,
  record: GrillRecoveryReceipt,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
): void {
  const file = grillRecoveryReceiptPath(repoDir, record.issue, record.handoff_id);
  deps.mkdir(path.dirname(file));
  deps.writeFile(file, `${JSON.stringify(record)}\n`);
}

export function loadVerifiedGrillRecoveryReceipt(
  repoDir: string,
  handoff: HumanQuestionHandoff,
  key: string,
  deps: GrillProposalKeyDeps = defaultGrillProposalKeyDeps,
): { expected_body_sha256: string } | null {
  const file = grillRecoveryReceiptPath(repoDir, handoff.issue_number, handoff.handoff_id);
  if (!deps.exists(file)) return null;
  try {
    const parsed: unknown = JSON.parse(deps.readFile(file));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.schema_version !== GRILL_RECOVERY_SCHEMA || o.kind !== GRILL_RECOVERY_KIND) return null;
    if (typeof o.mac !== "string" || typeof o.repo !== "string" || typeof o.issue !== "number") {
      return null;
    }
    if (typeof o.handoff_id !== "string" || typeof o.expected_body_sha256 !== "string") return null;
    if (typeof o.issued_at !== "string") return null;
    const verified = verifyGrillRecoveryReceipt(o as unknown as GrillRecoveryReceipt, key, {
      repo: handoff.repo,
      issue: handoff.issue_number,
      handoffId: handoff.handoff_id,
    });
    return verified.ok ? { expected_body_sha256: verified.expected_body_sha256 } : null;
  } catch {
    return null;
  }
}

/** True when a pending/answered grill-authority record is the applied artifact's current binding. */
export function isCurrentGrillAuthorityHandoff(
  handoff: HumanQuestionHandoff,
  artifact: DecisionsArtifact,
  currentIdentities: ReadonlySet<string>,
): boolean {
  if (handoff.status === "superseded" || handoff.superseded_by) return false;
  if (handoff.status !== "pending" && handoff.status !== "answered") return false;
  if (!isGrillAuthorityDeclaration(handoff.declaration_identity)) return false;
  const identity = handoff.declaration_identity ?? "";
  if (currentIdentities.has(identity)) return true;
  if (handoff.status !== "answered") return false;
  const decl = parseGrillDeclaration(identity);
  if (!decl) return false;
  const live = artifact.nodes.find((n) => n.id === decl.nodeId);
  if (!live) return false;
  if (live.provenance.settled_by !== "handoff") return false;
  if (live.provenance.reference !== `handoff:${handoff.handoff_id}`) return false;
  return liveNodeMatchesGrillBinding(live, decl.definitionSha256);
}

function currentGrillDeclarationIdentities(input: {
  artifact: DecisionsArtifact;
  proposedBody: string;
  frontierFp: string;
  issueNumber: number;
}): Set<string> {
  const identities = new Set<string>();
  for (const created of grillAuthorityCreateInputs({
    domain: "unused",
    repo: "unused",
    issueNumber: input.issueNumber,
    artifact: input.artifact,
    proposedBody: input.proposedBody,
    frontierFp: input.frontierFp,
  })) {
    if (created.declaration_identity) identities.add(created.declaration_identity);
  }
  return identities;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * After an applied refinement writes a new body, mark prior pending/answered
 * grill-authority records superseded unless they are still the current binding.
 * Pending/answered mismatches stay fail-closed until this explicit supersession.
 */
export async function supersedeStaleGrillHandoffs(
  repoDir: string,
  input: {
    issueNumber: number;
    artifact: DecisionsArtifact;
    proposedBody: string;
    frontierFp: string;
    currentHandoffs: HumanQuestionHandoff[];
  },
  deps?: HandoffStoreDeps,
): Promise<{ ok: true; superseded: HumanQuestionHandoff[] } | { ok: false; reason: string }> {
  const store = deps ?? defaultHandoffStoreDeps;
  const currentIdentities = currentGrillDeclarationIdentities(input);
  for (const h of input.currentHandoffs) {
    if (h.declaration_identity) currentIdentities.add(h.declaration_identity);
  }
  const replacementByNode = new Map<string, HumanQuestionHandoff>();
  for (const h of input.currentHandoffs) {
    const decl = parseGrillDeclaration(h.declaration_identity ?? "");
    if (decl) replacementByNode.set(decl.nodeId, h);
  }
  try {
    const existing = await listHandoffs(
      repoDir,
      { issue: input.issueNumber, status: ["pending", "answered"] },
      store,
    );
    for (const h of existing) {
      if (h.status !== "pending") continue;
      if (!h.declaration_identity || !currentIdentities.has(h.declaration_identity)) continue;
      const decl = parseGrillDeclaration(h.declaration_identity);
      if (decl && !replacementByNode.has(decl.nodeId)) replacementByNode.set(decl.nodeId, h);
    }
    const superseded: HumanQuestionHandoff[] = [];
    for (const prior of existing) {
      if (!isGrillAuthorityDeclaration(prior.declaration_identity)) continue;
      if (isCurrentGrillAuthorityHandoff(prior, input.artifact, currentIdentities)) continue;
      const decl = parseGrillDeclaration(prior.declaration_identity ?? "");
      const replacement = decl ? replacementByNode.get(decl.nodeId) : undefined;
      if (replacement && replacement.handoff_id === prior.handoff_id) continue;
      let nextPrior: HumanQuestionHandoff;
      if (replacement) {
        const linked = supersedeHandoff({ prior, replacement });
        nextPrior = linked.prior;
        await saveHandoff(repoDir, linked.prior, store);
        await saveHandoff(repoDir, linked.replacement, store);
        replacementByNode.set(decl!.nodeId, linked.replacement);
      } else {
        nextPrior = { ...prior, status: "superseded", superseded_by: null };
        await saveHandoff(repoDir, nextPrior, store);
      }
      await appendHandoffAudit(
        repoDir,
        {
          schema_version: 1,
          at: nowIso(),
          op: "supersede",
          handoff_id: prior.handoff_id,
          issue_number: input.issueNumber,
          detail: replacement
            ? `applied refinement superseded grill-authority binding with ${replacement.handoff_id}`
            : "applied refinement superseded grill-authority binding with no replacement node",
          status_after: "superseded",
          evidence: {
            superseded_by: replacement?.handoff_id ?? null,
            node_id: decl?.nodeId ?? null,
          },
        },
        store,
      );
      superseded.push(nextPrior);
    }
    return { ok: true, superseded };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export interface GrillHandoffCreateInput {
  domain: string;
  repo: string;
  issueNumber: number;
  artifact: DecisionsArtifact;
  proposedBody: string;
  frontierFp: string;
}

export function grillAuthorityCreateInputs(input: GrillHandoffCreateInput): CreateHandoffInput[] {
  const bodySha = sha256Prefixed(input.proposedBody);
  const out: CreateHandoffInput[] = [];
  for (const node of input.artifact.nodes) {
    const classified = classifyAuthority(node.class);
    if (!classified.operatorRequired && !node.typed_request) continue;
    if (node.resolution === "resolved" && node.provenance.settled_by === "auto-accept") continue;
    if (node.resolution === "resolved" && node.provenance.settled_by === "handoff") continue;
    const request = node.typed_request;
    const handoffClass = request
      ? typedRequestHandoffClass(request, node.class)
      : grillHandoffClass(node.class);
    const nonAuthority = handoffClass === "missing_context";
    const created: CreateHandoffInput = {
      domain: input.domain,
      repo: input.repo,
      issue_number: input.issueNumber,
      blocked_stage: "triage",
      question: node.question,
      reason: request
        ? `grill ${request} node ${node.id} (${node.class})`
        : `grill-authority node ${node.id} (${node.class})`,
      handoff_class: handoffClass,
      authority_mode: nonAuthority ? "non_authority" : "authority",
      required_capability: nonAuthority ? ["missing_context"] : ["authority"],
      candidate_sha: null,
      tip_present: false,
      policy_bound_authority_gate: !nonAuthority,
      human_decision_required: null,
      content_hashes: [bodySha, input.frontierFp, node.id, nodeDefinitionDigest(node)],
      declaration_identity: grillDeclarationIdentity({
        nodeId: node.id,
        frontierFp: input.frontierFp,
        bodySha256: bodySha,
        definitionSha256: nodeDefinitionDigest(node),
      }),
      resume_target: "triage",
      resume_preconditions: ["grill-authority-answer"],
      resolution_evidence: {
        unresolved: false,
        eligible_actors: request === "AuthorityRequest" ? ["authenticated-github-actor"] : [],
        resolution_summary: "grill-authority: any authenticated GitHub actor via pipeline handoff answer",
      },
    };
    if (request) {
      created.typed_request = request;
      if (request === "DecisionRequest") {
        created.decision_package = {
          recommendation: node.recommendation,
          rationale: node.rationale ?? "",
          alternatives: node.alternatives ?? [],
          risk: node.risk ?? "",
          evidence: node.evidence ?? [],
        };
      } else if (request === "CapabilityRequest") {
        if (node.capability_request) created.capability_request = node.capability_request;
      } else if (request === "AuthorityRequest") {
        if (node.authority_request) created.authority_request = node.authority_request;
      }
    }
    out.push(created);
  }
  return out;
}

export async function createPendingGrillHandoffs(
  repoDir: string,
  input: GrillHandoffCreateInput,
  deps?: HandoffStoreDeps,
): Promise<{ ok: true; created: HumanQuestionHandoff[] } | { ok: false; reason: string }> {
  const created: HumanQuestionHandoff[] = [];
  for (const raw of grillAuthorityCreateInputs(input)) {
    const gated = canCreateHandoff(raw);
    if (!gated.ok) return { ok: false, reason: gated.reason };
    const persisted = await createAndPersistHandoff(repoDir, raw, deps);
    if (!persisted.ok) return { ok: false, reason: persisted.reason };
    created.push(persisted.handoff);
  }
  return { ok: true, created };
}

export interface GrillMaterializeDeps {
  getIssueBody(issueNumber: number): Promise<string>;
  updateIssueBody(issueNumber: number, body: string): Promise<void>;
  /** When set, pending sibling grill-authority handoffs rebind to the new body hash. */
  repoDir?: string;
  handoffStore?: HandoffStoreDeps;
  /** When set with repoDir, Pipeline writes the next authenticated frontier. */
  keyDeps?: GrillProposalKeyDeps;
  frontierKey?: string;
  now?: () => Date;
  /**
   * Host-local domain+issue lock for the grill-answer transaction.
   * Production uses `withLock` from `lock.ts`. Tests inject a fake.
   */
  withIssueLock?: <T>(
    domain: string,
    issueNumber: number,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export type GrillMaterializeResult =
  | { ok: true; body: string; wrote: boolean; artifact: DecisionsArtifact }
  | { ok: false; reason: string; code: "body_hash_drift" | "invalid_artifact" | "node_missing" | "write_failed" };

/**
 * Deterministically patch one operator-required node. Exact live-body SHA-256
 * match is required before any already-materialized recovery. Spec-core
 * equality does not authorize a drifted body. No-write healing of a post-write
 * body is only permitted when a verified recovery receipt matches.
 */
export function materializeGrillNode(input: {
  liveBody: string;
  handoff: HumanQuestionHandoff;
  answerText: string;
}): GrillMaterializeResult {
  const parsedDecl = parseGrillDeclaration(input.handoff.declaration_identity ?? "");
  if (!parsedDecl) {
    return { ok: false, reason: "handoff is not a grill-authority record", code: "invalid_artifact" };
  }
  const liveHash = sha256Prefixed(input.liveBody);
  const boundHash = input.handoff.scope.content_hashes?.[0];
  const parsed = parseDecisionsFromBody(input.liveBody);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, code: "invalid_artifact" };
  }
  const node = parsed.artifact.nodes.find((n) => n.id === parsedDecl.nodeId);
  if (!node) {
    return { ok: false, reason: `node ${parsedDecl.nodeId} is missing from the live artifact`, code: "node_missing" };
  }
  if (!liveNodeMatchesGrillBinding(node, parsedDecl.definitionSha256)) {
    return {
      ok: false,
      reason: "live node definition does not match the grill-authority binding",
      code: "invalid_artifact",
    };
  }
  if (liveHash !== boundHash) {
    return {
      ok: false,
      reason: "live issue body hash does not match the grill-authority binding",
      code: "body_hash_drift",
    };
  }
  const already = node.provenance.reference === `handoff:${input.handoff.handoff_id}`;
  if (already && node.resolution === "resolved") {
    return { ok: true, body: input.liveBody, wrote: false, artifact: parsed.artifact };
  }
  if (!isOperatorRequiredClass(node.class) && classifyAuthority(node.class).operatorRequired) {
    // unknown class still operator-required via classifyAuthority
  }
  const patchedNode: DecisionNode = {
    ...node,
    resolution: "resolved",
    provenance: {
      ...node.provenance,
      settled_by: "handoff",
      reference: `handoff:${input.handoff.handoff_id}`,
    },
  };
  const artifact = patchNodeInArtifact(parsed.artifact, node.id, {
    resolution: patchedNode.resolution,
    provenance: patchedNode.provenance,
  });
  const spec = extractSpecCore(input.liveBody);
  const nextBody = embedDecisionsInBody(spec, artifact);
  return { ok: true, body: nextBody, wrote: true, artifact };
}

/**
 * Rebind remaining pending grill-authority handoffs on the same issue to
 * `newBody`'s SHA-256. The answered record keeps the hash it authorized.
 */
export async function refreshPendingSiblingGrillHandoffs(
  repoDir: string,
  input: { answeredHandoff: HumanQuestionHandoff; newBody: string },
  deps: HandoffStoreDeps = defaultHandoffStoreDeps,
): Promise<void> {
  const newBodySha = sha256Prefixed(input.newBody);
  const pending = await listHandoffs(
    repoDir,
    { issue: input.answeredHandoff.issue_number, status: "pending" },
    deps,
  );
  for (const h of pending) {
    if (h.handoff_id === input.answeredHandoff.handoff_id) continue;
    if (!isGrillAuthorityDeclaration(h.declaration_identity)) continue;
    const decl = parseGrillDeclaration(h.declaration_identity);
    if (!decl) continue;
    const nextIdentity = grillDeclarationIdentity({
      nodeId: decl.nodeId,
      frontierFp: decl.frontierFp,
      bodySha256: newBodySha,
      definitionSha256: decl.definitionSha256,
    });
    const hashes = [...(h.scope.content_hashes ?? [])];
    if (h.declaration_identity === nextIdentity && hashes[0] === newBodySha) continue;
    hashes[0] = newBodySha;
    await saveHandoff(
      repoDir,
      {
        ...h,
        declaration_identity: nextIdentity,
        scope: { ...h.scope, content_hashes: hashes },
      },
      deps,
    );
  }
}

function healGrillAnswerFromReceipt(
  liveBody: string,
  handoff: HumanQuestionHandoff,
  deps: GrillMaterializeDeps,
): GrillMaterializeResult | null {
  if (!deps.repoDir || !deps.frontierKey) return null;
  const parsedDecl = parseGrillDeclaration(handoff.declaration_identity ?? "");
  if (!parsedDecl) return null;
  const parsed = parseDecisionsFromBody(liveBody);
  if (!parsed.ok) return null;
  const node = parsed.artifact.nodes.find((n) => n.id === parsedDecl.nodeId);
  if (!node) return null;
  if (node.provenance.reference !== `handoff:${handoff.handoff_id}`) return null;
  if (node.resolution !== "resolved") return null;
  if (!liveNodeMatchesGrillBinding(node, parsedDecl.definitionSha256)) return null;
  const receipt = loadVerifiedGrillRecoveryReceipt(
    deps.repoDir,
    handoff,
    deps.frontierKey,
    deps.keyDeps ?? defaultGrillProposalKeyDeps,
  );
  if (!receipt) return null;
  if (hexDigest(sha256Prefixed(liveBody)) !== hexDigest(receipt.expected_body_sha256)) {
    return null;
  }
  return { ok: true, body: liveBody, wrote: false, artifact: parsed.artifact };
}

function persistPlannedFrontier(
  handoff: HumanQuestionHandoff,
  planned: { body: string; artifact: DecisionsArtifact },
  deps: GrillMaterializeDeps,
): GrillMaterializeResult | null {
  if (!deps.repoDir || !deps.frontierKey) return null;
  try {
    persistGrillFrontier(
      deps.repoDir,
      issueGrillFrontier({
        repo: handoff.repo,
        issue: handoff.issue_number,
        body: planned.body,
        artifact: planned.artifact,
        now: (deps.now ?? (() => new Date()))(),
        key: deps.frontierKey,
      }),
      deps.keyDeps ?? defaultGrillProposalKeyDeps,
    );
    return null;
  } catch (err) {
    return {
      ok: false,
      reason: `frontier persist failed: ${(err as Error).message}`,
      code: "write_failed",
    };
  }
}

/**
 * Persist `planned` only when it still matches the live body. If a sibling
 * (or other writer) already advanced the live body and persisted a matching
 * frontier, keep that frontier instead of replacing it with a stale one.
 */
async function commitGrillFrontier(
  handoff: HumanQuestionHandoff,
  planned: { body: string; artifact: DecisionsArtifact },
  deps: GrillMaterializeDeps,
): Promise<GrillMaterializeResult | null> {
  if (!deps.repoDir || !deps.frontierKey) return null;
  let liveNow: string;
  try {
    liveNow = await deps.getIssueBody(handoff.issue_number);
  } catch (err) {
    return {
      ok: false,
      reason: `live body re-read failed: ${(err as Error).message}`,
      code: "write_failed",
    };
  }
  const liveHash = hexDigest(sha256Prefixed(liveNow));
  const plannedHash = hexDigest(sha256Prefixed(planned.body));
  if (liveHash !== plannedHash) {
    const parsed = parseDecisionsFromBody(liveNow);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, code: "invalid_artifact" };
    }
    const parsedDecl = parseGrillDeclaration(handoff.declaration_identity ?? "");
    const node = parsedDecl
      ? parsed.artifact.nodes.find((n) => n.id === parsedDecl.nodeId)
      : undefined;
    const ours =
      node != null &&
      node.resolution === "resolved" &&
      node.provenance.reference === `handoff:${handoff.handoff_id}`;
    const existing = loadVerifiedGrillFrontier(
      deps.repoDir,
      handoff.issue_number,
      deps.frontierKey,
      handoff.repo,
      deps.keyDeps ?? defaultGrillProposalKeyDeps,
    );
    if (
      ours &&
      existing &&
      liveMatchesGrillFrontier(liveNow, parsed.artifact.nodes, existing).ok
    ) {
      return { ok: true, body: liveNow, wrote: false, artifact: parsed.artifact };
    }
    return {
      ok: false,
      reason: "live issue body advanced past this grill-answer frontier",
      code: "body_hash_drift",
    };
  }
  return persistPlannedFrontier(handoff, planned, deps);
}

export async function materializeGrillAnswer(
  handoff: HumanQuestionHandoff,
  answerText: string,
  deps: GrillMaterializeDeps,
): Promise<GrillMaterializeResult> {
  const run = () => materializeGrillAnswerUnlocked(handoff, answerText, deps);
  if (deps.withIssueLock) {
    return deps.withIssueLock(handoff.domain, handoff.issue_number, run);
  }
  return run();
}

async function materializeGrillAnswerUnlocked(
  handoff: HumanQuestionHandoff,
  answerText: string,
  deps: GrillMaterializeDeps,
): Promise<GrillMaterializeResult> {
  const liveBody = await deps.getIssueBody(handoff.issue_number);
  const planned = materializeGrillNode({ liveBody, handoff, answerText });
  if (!planned.ok) {
    if (planned.code !== "body_hash_drift") return planned;
    const healed = healGrillAnswerFromReceipt(liveBody, handoff, deps);
    if (!healed) return planned;
    // A prior write may have failed mid-sibling-rebind; heal must finish that work
    // before persisting the frontier.
    if (deps.repoDir) {
      try {
        await refreshPendingSiblingGrillHandoffs(
          deps.repoDir,
          { answeredHandoff: handoff, newBody: healed.body },
          deps.handoffStore,
        );
      } catch (err) {
        return {
          ok: false,
          reason: `pending sibling rebind failed: ${(err as Error).message}`,
          code: "write_failed",
        };
      }
    }
    const frontierOut = await commitGrillFrontier(handoff, healed, deps);
    if (frontierOut) return frontierOut;
    return healed;
  }
  if (planned.wrote) {
    if (deps.repoDir && deps.frontierKey) {
      try {
        persistGrillRecoveryReceipt(
          deps.repoDir,
          issueGrillRecoveryReceipt({
            repo: handoff.repo,
            issue: handoff.issue_number,
            handoffId: handoff.handoff_id,
            expectedBody: planned.body,
            now: (deps.now ?? (() => new Date()))(),
            key: deps.frontierKey,
          }),
          deps.keyDeps ?? defaultGrillProposalKeyDeps,
        );
      } catch (err) {
        return {
          ok: false,
          reason: `recovery receipt persist failed: ${(err as Error).message}`,
          code: "write_failed",
        };
      }
    }
    try {
      await deps.updateIssueBody(handoff.issue_number, planned.body);
    } catch (err) {
      return { ok: false, reason: (err as Error).message, code: "write_failed" };
    }
  }
  if (deps.repoDir) {
    try {
      await refreshPendingSiblingGrillHandoffs(
        deps.repoDir,
        { answeredHandoff: handoff, newBody: planned.body },
        deps.handoffStore,
      );
    } catch (err) {
      return {
        ok: false,
        reason: `pending sibling rebind failed: ${(err as Error).message}`,
        code: "write_failed",
      };
    }
    const frontierOut = await commitGrillFrontier(handoff, planned, deps);
    if (frontierOut) return frontierOut;
  }
  return planned;
}
