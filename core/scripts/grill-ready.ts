// Model-free Decisions validator for `pipeline triage N --stage ready` (#1072).

import {
  DEPENDENCY_FACT_CODES,
  parseDecisionsFromBody,
  unresolvedAuthorityNodes,
  type DecisionsArtifact,
} from "./grill-decisions.ts";
import { requiredContextSatisfied } from "./grill-context.ts";
import { fingerprintStaleReasons, type GrillFingerprint } from "./grill-fingerprint.ts";
import type { GrillFrontierBinding } from "./grill-frontier.ts";
import { liveMatchesGrillFrontier } from "./grill-frontier.ts";
import {
  isGrillAuthorityDeclaration,
  liveNodeMatchesGrillBinding,
  parseGrillDeclaration,
} from "./grill-handoff.ts";
import type { HumanQuestionHandoff } from "./human-question-handoff.ts";

export interface GrillReadySnapshot {
  title: string;
  body: string;
  fingerprint: GrillFingerprint;
  contextMd: string;
  integrationBaseSha: string;
  handoffs: HumanQuestionHandoff[];
  comments: Array<{ body: string }>;
  /** Pipeline-produced HMAC-verified frontier. Null/omitted fails closed. */
  frontier?: GrillFrontierBinding | null;
}

export type ReadyValidationFailure = {
  ok: false;
  reason: string;
  code:
    | "missing_artifact"
    | "invalid_artifact"
    | "unresolved_authority"
    | "unresolved_fact"
    | "stale_fingerprint"
    | "required_context"
    | "invalid_provenance"
    | "comment_is_not_spec";
};

export type ReadyValidation = { ok: true; artifact: DecisionsArtifact } | ReadyValidationFailure;

export function validateDecisionsForReady(snapshot: GrillReadySnapshot): ReadyValidation {
  const parsed = parseDecisionsFromBody(snapshot.body);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      code: parsed.code === "missing" ? "missing_artifact" : "invalid_artifact",
    };
  }
  const artifact = parsed.artifact;
  if (!snapshot.frontier) {
    return {
      ok: false,
      reason: "authenticated Decisions frontier is missing",
      code: "invalid_provenance",
    };
  }
  const frontierMatch = liveMatchesGrillFrontier(snapshot.body, artifact.nodes, snapshot.frontier);
  if (!frontierMatch.ok) {
    return {
      ok: false,
      reason: frontierMatch.reason,
      code: "invalid_provenance",
    };
  }
  for (const h of snapshot.handoffs) {
    if (!isGrillAuthorityDeclaration(h.declaration_identity)) continue;
    // Ignore only explicitly superseded records. Pending/answered stay fail-closed.
    if (h.status === "superseded" || h.superseded_by) continue;
    if (h.status !== "pending" && h.status !== "answered") continue;
    const decl = parseGrillDeclaration(h.declaration_identity ?? "");
    if (!decl) {
      return {
        ok: false,
        reason: "grill-authority handoff declaration is malformed",
        code: "invalid_provenance",
      };
    }
    const live = artifact.nodes.find((n) => n.id === decl.nodeId);
    if (!live) {
      return {
        ok: false,
        reason: `grill-authority node ${decl.nodeId} is missing from the live artifact`,
        code: "invalid_provenance",
      };
    }
    if (!liveNodeMatchesGrillBinding(live, decl.definitionSha256)) {
      return {
        ok: false,
        reason: `node ${live.id} definition does not match the grill-authority binding`,
        code: "invalid_provenance",
      };
    }
  }
  const unresolved = unresolvedAuthorityNodes(artifact.nodes);
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: `unresolved operator-required nodes: ${unresolved.map((n) => n.id).join(", ")}`,
      code: "unresolved_authority",
    };
  }
  const blockingFacts = artifact.unresolved_facts.filter((f) =>
    (DEPENDENCY_FACT_CODES as readonly string[]).includes(f.code),
  );
  if (blockingFacts.length > 0) {
    return {
      ok: false,
      reason: `unresolved dependency facts: ${blockingFacts.map((f) => f.code).join(", ")}`,
      code: "unresolved_fact",
    };
  }
  for (const node of artifact.nodes) {
    if (node.provenance.settled_by === "handoff") {
      const id = (node.provenance.reference ?? "").replace(/^handoff:/, "");
      const match = snapshot.handoffs.find(
        (h) =>
          h.handoff_id === id &&
          h.status === "answered" &&
          isGrillAuthorityDeclaration(h.declaration_identity) &&
          parseGrillDeclaration(h.declaration_identity ?? "")?.nodeId === node.id,
      );
      if (!match) {
        return {
          ok: false,
          reason: `node ${node.id} claims handoff provenance that is not in the answered ledger`,
          code: "invalid_provenance",
        };
      }
    }
  }
  if (!requiredContextSatisfied(artifact.required_context, snapshot.integrationBaseSha, snapshot.contextMd)) {
    return {
      ok: false,
      reason: "required CONTEXT.md terms are missing or hashes do not match the trusted base",
      code: "required_context",
    };
  }
  const stale = fingerprintStaleReasons(artifact.fingerprint, snapshot.fingerprint);
  if (stale.length > 0) {
    return {
      ok: false,
      reason: `stale fingerprints: ${stale.join(", ")}`,
      code: "stale_fingerprint",
    };
  }
  return { ok: true, artifact };
}
