// Grill-authority handoff create + body materialize (#1072).
// Reuses `pipeline handoff answer`; no second ledger.

import {
  embedDecisionsInBody,
  extractSpecCore,
  parseDecisionsFromBody,
  patchNodeInArtifact,
  specCoreSha256,
  type DecisionNode,
  type DecisionsArtifact,
} from "./grill-decisions.ts";
import { sha256Hex, sha256Prefixed } from "./grill-hash.ts";
import { classifyAuthority, isOperatorRequiredClass } from "./grill-taxonomy.ts";
import {
  canCreateHandoff,
  createAndPersistHandoff,
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
}): string {
  return `${GRILL_DECLARATION_PREFIX}${input.nodeId}:${hexDigest(input.frontierFp)}:${hexDigest(input.bodySha256)}`;
}

export function parseGrillDeclaration(
  identity: string,
): { nodeId: string; frontierFp: string; bodySha256: string } | null {
  const m = /^grill-v1:([a-z][a-z0-9-]{0,62}):([0-9a-f]{64}):([0-9a-f]{64})$/.exec(identity);
  if (!m) return null;
  return { nodeId: m[1]!, frontierFp: m[2]!, bodySha256: m[3]! };
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
  const specCore = specCoreSha256(input.proposedBody);
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
      content_hashes: [bodySha, input.frontierFp, node.id, specCore],
      declaration_identity: grillDeclarationIdentity({
        nodeId: node.id,
        frontierFp: input.frontierFp,
        bodySha256: bodySha,
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
}

export type GrillMaterializeResult =
  | { ok: true; body: string; wrote: boolean; artifact: DecisionsArtifact }
  | { ok: false; reason: string; code: "body_hash_drift" | "invalid_artifact" | "node_missing" | "write_failed" };

/**
 * Deterministically patch one operator-required node. Exact body-hash match is
 * the first-answer path. Later sibling answers keep the apply-time spec core
 * and node identity; only resolution/provenance/render may change.
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
  const boundSpecCore = input.handoff.scope.content_hashes?.[3];
  const parsed = parseDecisionsFromBody(input.liveBody);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, code: "invalid_artifact" };
  }
  const node = parsed.artifact.nodes.find((n) => n.id === parsedDecl.nodeId);
  if (!node) {
    return { ok: false, reason: `node ${parsedDecl.nodeId} is missing from the live artifact`, code: "node_missing" };
  }
  const already = node.provenance.reference === `handoff:${input.handoff.handoff_id}`;
  if (already && node.resolution === "resolved") {
    return { ok: true, body: input.liveBody, wrote: false, artifact: parsed.artifact };
  }
  if (liveHash !== boundHash) {
    const liveCore = specCoreSha256(input.liveBody);
    if (!boundSpecCore || liveCore !== boundSpecCore) {
      return {
        ok: false,
        reason: "live issue body hash does not match the grill-authority binding",
        code: "body_hash_drift",
      };
    }
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

export async function materializeGrillAnswer(
  handoff: HumanQuestionHandoff,
  answerText: string,
  deps: GrillMaterializeDeps,
): Promise<GrillMaterializeResult> {
  const liveBody = await deps.getIssueBody(handoff.issue_number);
  const planned = materializeGrillNode({ liveBody, handoff, answerText });
  if (!planned.ok) return planned;
  if (!planned.wrote) return planned;
  try {
    await deps.updateIssueBody(handoff.issue_number, planned.body);
  } catch (err) {
    return { ok: false, reason: (err as Error).message, code: "write_failed" };
  }
  return planned;
}
