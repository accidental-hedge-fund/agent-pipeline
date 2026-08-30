// Grill-authority handoff create + body materialize (#1072).
// Reuses `pipeline handoff answer`; no second ledger.

import {
  embedDecisionsInBody,
  extractSpecCore,
  nodeDefinitionDigest,
  parseDecisionsFromBody,
  patchNodeInArtifact,
  type DecisionNode,
  type DecisionsArtifact,
} from "./grill-decisions.ts";
import { sha256Hex, sha256Prefixed } from "./grill-hash.ts";
import { classifyAuthority, isOperatorRequiredClass } from "./grill-taxonomy.ts";
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
    if (!classified.operatorRequired) continue;
    if (node.resolution === "resolved" && node.provenance.settled_by === "handoff") continue;
    out.push({
      domain: input.domain,
      repo: input.repo,
      issue_number: input.issueNumber,
      blocked_stage: "triage",
      question: node.question,
      reason: `grill-authority node ${node.id} (${node.class})`,
      handoff_class: grillHandoffClass(node.class),
      authority_mode: "authority",
      required_capability: ["authority"],
      candidate_sha: null,
      tip_present: false,
      policy_bound_authority_gate: true,
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
        eligible_actors: [],
        resolution_summary: "grill-authority: any authenticated GitHub actor via pipeline handoff answer",
      },
    });
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
}

export type GrillMaterializeResult =
  | { ok: true; body: string; wrote: boolean; artifact: DecisionsArtifact }
  | { ok: false; reason: string; code: "body_hash_drift" | "invalid_artifact" | "node_missing" | "write_failed" };

/**
 * Deterministically patch one operator-required node. Exact live-body SHA-256
 * match is required. Spec-core equality does not authorize a drifted body.
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
  const already = node.provenance.reference === `handoff:${input.handoff.handoff_id}`;
  if (already && node.resolution === "resolved") {
    return { ok: true, body: input.liveBody, wrote: false, artifact: parsed.artifact };
  }
  if (liveHash !== boundHash) {
    return {
      ok: false,
      reason: "live issue body hash does not match the grill-authority binding",
      code: "body_hash_drift",
    };
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

export async function materializeGrillAnswer(
  handoff: HumanQuestionHandoff,
  answerText: string,
  deps: GrillMaterializeDeps,
): Promise<GrillMaterializeResult> {
  const liveBody = await deps.getIssueBody(handoff.issue_number);
  const planned = materializeGrillNode({ liveBody, handoff, answerText });
  if (!planned.ok) return planned;
  if (planned.wrote) {
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
  }
  return planned;
}
