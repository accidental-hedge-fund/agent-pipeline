// Deterministic forward impact + backward proposals (#599).
// Pure with respect to the supplied graph snapshot. No LLM. No silent
// authoritative upstream mutation without explicit approval.

import { createHash } from "node:crypto";
import {
  DRIFT_REASON_CODES,
  LINEAGE_SCHEMA_VERSION,
  makeEdgeShell,
  makeNodeShell,
  redactFreeText,
  type DriftReasonCode,
  type LineageEdge,
  type LineageGraphSnapshot,
  type LineageNode,
} from "./schema.ts";
import { indexNodes, outboundEdges, inboundEdges } from "./graph.ts";
import { makeDomainNodeId } from "./identity.ts";

// ---------------------------------------------------------------------------
// Forward impact
// ---------------------------------------------------------------------------

export interface ImpactAffectedItem {
  node_id: string;
  node_type: string;
  edge_ids: string[];
  drift_reason_codes: DriftReasonCode[];
  path_node_ids: string[];
}

export interface ForwardImpactReport {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  type: "lineage_forward_impact";
  upstream: {
    node_id: string;
    node_type: string;
    prior_revision: string | null;
    new_revision: string | null;
    prior_content_hash: string | null;
    new_content_hash: string | null;
  };
  affected: ImpactAffectedItem[];
  drift_reason_codes: DriftReasonCode[];
  diagnostics: Array<{ code: string; message: string }>;
}

/** Relationships treated as forward (downstream) for impact walk. */
const FORWARD_RELATIONSHIPS = new Set([
  "decomposes_to",
  "implements",
  "verifies",
  "maps_evidence",
  "delivered_by",
  "outcome_of",
  "owned_by",
  "affected_by_policy",
  "invalidates",
  "derived_from", // also walk reverse for derived_from (objective → requirement is reverse of decomposes)
]);

/**
 * Walk directed edges from upstream node to collect downstream impact.
 * `derived_from` is walked reverse (source is downstream of target).
 */
export function computeForwardImpact(
  graph: { nodes: readonly LineageNode[]; edges: readonly LineageEdge[] },
  opts: {
    upstream_node_id: string;
    prior_revision?: string | null;
    new_revision?: string | null;
    prior_content_hash?: string | null;
    new_content_hash?: string | null;
    reason?: DriftReasonCode;
  },
): ForwardImpactReport {
  const diagnostics: Array<{ code: string; message: string }> = [];
  const byId = indexNodes(graph.nodes);
  const upstream = byId.get(opts.upstream_node_id);
  if (!upstream) {
    diagnostics.push({
      code: "unknown_upstream",
      message: `upstream node ${opts.upstream_node_id} not in graph`,
    });
    return {
      schema_version: LINEAGE_SCHEMA_VERSION,
      type: "lineage_forward_impact",
      upstream: {
        node_id: opts.upstream_node_id,
        node_type: "unknown",
        prior_revision: opts.prior_revision ?? null,
        new_revision: opts.new_revision ?? null,
        prior_content_hash: opts.prior_content_hash ?? null,
        new_content_hash: opts.new_content_hash ?? null,
      },
      affected: [],
      drift_reason_codes: [],
      diagnostics,
    };
  }

  const primaryReason: DriftReasonCode =
    opts.reason ??
    (upstream.node_type === "requirement"
      ? "upstream_requirement_revised"
      : upstream.node_type === "objective"
        ? "objective_content_hash_changed"
        : upstream.node_type === "component"
          ? "component_ownership_changed"
          : upstream.node_type === "policy_event"
            ? "policy_event_invalidated"
            : "upstream_requirement_revised");

  const affectedMap = new Map<string, ImpactAffectedItem>();
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; path: string[]; edgeIds: string[] }> = [
    { nodeId: upstream.node_id, path: [upstream.node_id], edgeIds: [] },
  ];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur.nodeId)) continue;
    visited.add(cur.nodeId);

    // Outbound forward edges
    for (const e of graph.edges) {
      if (!FORWARD_RELATIONSHIPS.has(e.relationship)) continue;
      let next: string | null = null;
      if (e.source_id === cur.nodeId && e.relationship !== "derived_from") {
        next = e.target_id;
      } else if (e.target_id === cur.nodeId && e.relationship === "derived_from") {
        // derived_from: objective → requirement; reverse for downstream of requirement is objective (source)
        next = e.source_id;
      } else if (e.target_id === cur.nodeId && e.relationship === "implements") {
        // implements: run → objective; reverse to find runs from objective
        next = e.source_id;
      } else if (e.target_id === cur.nodeId && e.relationship === "outcome_of") {
        // outcome_of: outcome → run; reverse to find production outcomes from run
        next = e.source_id;
      } else {
        continue;
      }
      if (next === cur.nodeId) continue;
      if (next === upstream.node_id) continue;

      const nextNode = byId.get(next);
      if (!nextNode) {
        diagnostics.push({
          code: "missing_downstream_link",
          message: `edge ${e.edge_id} points to missing node ${next}`,
        });
        continue;
      }

      const path = [...cur.path, next];
      const edgeIds = [...cur.edgeIds, e.edge_id];
      const reasons = new Set<DriftReasonCode>([primaryReason]);
      if (nextNode.node_type === "objective") {
        reasons.add("objective_content_hash_changed");
      }
      if (e.reason_codes) {
        for (const c of e.reason_codes) {
          if ((DRIFT_REASON_CODES as readonly string[]).includes(c)) {
            reasons.add(c as DriftReasonCode);
          }
        }
      }

      const existing = affectedMap.get(next);
      if (existing) {
        for (const id of edgeIds) {
          if (!existing.edge_ids.includes(id)) existing.edge_ids.push(id);
        }
        for (const r of reasons) {
          if (!existing.drift_reason_codes.includes(r)) existing.drift_reason_codes.push(r);
        }
      } else if (next !== upstream.node_id) {
        affectedMap.set(next, {
          node_id: next,
          node_type: nextNode.node_type,
          edge_ids: edgeIds,
          drift_reason_codes: [...reasons],
          path_node_ids: path,
        });
      }

      if (!visited.has(next)) {
        queue.push({ nodeId: next, path, edgeIds });
      }
    }
  }

  // Remove upstream from affected
  affectedMap.delete(upstream.node_id);

  const affected = [...affectedMap.values()].sort((a, b) =>
    a.node_id.localeCompare(b.node_id),
  );
  const allCodes = new Set<DriftReasonCode>();
  for (const a of affected) {
    for (const c of a.drift_reason_codes) allCodes.add(c);
  }
  if (affected.length === 0 && !diagnostics.some((d) => d.code === "unknown_upstream")) {
    // still report primary reason on empty for clarity
  }

  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    type: "lineage_forward_impact",
    upstream: {
      node_id: upstream.node_id,
      node_type: upstream.node_type,
      prior_revision: opts.prior_revision ?? upstream.revision,
      new_revision: opts.new_revision ?? null,
      prior_content_hash: opts.prior_content_hash ?? upstream.content_hash,
      new_content_hash: opts.new_content_hash ?? null,
    },
    affected,
    drift_reason_codes: [...allCodes].sort(),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Backward proposals
// ---------------------------------------------------------------------------

export type ProposalAuthorityStatus = "proposal" | "applied" | "refused";

export interface LineageUpdateProposal {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  type: "lineage_update_proposal";
  proposal_id: string;
  target_upstream_node_ids: string[];
  citing_evidence_node_ids: string[];
  citing_edge_ids: string[];
  proposed_change_summary: string;
  authority_status: ProposalAuthorityStatus;
  reason_codes: string[];
  domain: string;
}

export interface BackwardProposalResult {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  type: "lineage_backward_proposals";
  proposals: LineageUpdateProposal[];
  diagnostics: Array<{ code: string; message: string }>;
}

function proposalId(domain: string, parts: string[]): string {
  const h = createHash("sha1").update([domain, ...parts].join("|")).digest("hex").slice(0, 12);
  return makeDomainNodeId(domain, "proposal", h);
}

/** Collect objective/requirement upstream targets from a seed set of node ids. */
function collectUpstreamTargets(
  graph: { edges: readonly LineageEdge[] },
  seedIds: Iterable<string>,
  citingEdges: string[],
): Set<string> {
  const upstreamTargets = new Set<string>();
  for (const seedId of seedIds) {
    upstreamTargets.add(seedId);
    for (const e of graph.edges) {
      if (e.relationship === "derived_from" && e.source_id === seedId) {
        upstreamTargets.add(e.target_id);
        citingEdges.push(e.edge_id);
      }
      if (e.relationship === "decomposes_to" && e.target_id === seedId) {
        upstreamTargets.add(e.source_id);
        citingEdges.push(e.edge_id);
      }
    }
  }
  return upstreamTargets;
}

/**
 * Emit non-applied proposals from downstream evidence (outcomes, failures).
 * Never mutates authoritative upstream content.
 *
 * Verification evidence walks inbound `verifies` / `maps_evidence` edges to
 * objectives/requirements (not `outcome_of`, which is outcome→run only).
 */
export function computeBackwardProposals(
  graph: { nodes: readonly LineageNode[]; edges: readonly LineageEdge[] },
  opts: {
    /** Prefer starting from this outcome/verification node. */
    evidence_node_id?: string;
    domain?: string;
  } = {},
): BackwardProposalResult {
  const diagnostics: Array<{ code: string; message: string }> = [];
  const byId = indexNodes(graph.nodes);
  const proposals: LineageUpdateProposal[] = [];

  const evidenceNodes = opts.evidence_node_id
    ? [byId.get(opts.evidence_node_id)].filter(Boolean) as LineageNode[]
    : graph.nodes.filter(
        (n) =>
          n.node_type === "production_outcome" ||
          n.node_type === "verification",
      );

  for (const ev of evidenceNodes) {
    const citingEdges: string[] = [];
    const seedIds = new Set<string>();
    const reasonCodes: string[] = [];

    if (ev.node_type === "verification") {
      // verifies / maps_evidence: objective|requirement → verification
      const inbound = inboundEdges(graph.edges, ev.node_id, {
        relationships: ["verifies", "maps_evidence"],
      });
      for (const e of inbound) {
        citingEdges.push(e.edge_id);
        const src = byId.get(e.source_id);
        if (
          src &&
          (src.node_type === "objective" ||
            src.node_type === "requirement" ||
            src.node_type === "intent_outcome")
        ) {
          seedIds.add(e.source_id);
        }
        // Preserve link-state diagnostics for non-active mapping edges
        if (e.link_state !== "active") {
          diagnostics.push({
            code: "verification_mapping_link_state",
            message: `evidence ${ev.node_id} edge ${e.edge_id} link_state=${e.link_state}`,
          });
        }
      }
      reasonCodes.push("downstream_verification_evidence");
    } else {
      // production_outcome (and other outcome-like): outcome_of → run → implements → objective
      const outEdges = outboundEdges(graph.edges, ev.node_id, {
        relationships: ["outcome_of"],
      });
      citingEdges.push(...outEdges.map((e) => e.edge_id));
      const runIds = outEdges
        .map((e) => e.target_id)
        .filter((id) => byId.get(id)?.node_type === "run");

      for (const runId of runIds) {
        for (const e of graph.edges) {
          if (e.relationship === "implements" && e.source_id === runId) {
            seedIds.add(e.target_id);
            citingEdges.push(e.edge_id);
          }
        }
      }
      reasonCodes.push("downstream_outcome_evidence");
    }

    const upstreamTargets = collectUpstreamTargets(graph, seedIds, citingEdges);

    if (upstreamTargets.size === 0) {
      diagnostics.push({
        code: "no_upstream_for_evidence",
        message: `no upstream targets for evidence ${ev.node_id}`,
      });
      continue;
    }

    const kind =
      typeof ev.identity?.outcome_kind === "string" ? ev.identity.outcome_kind : ev.node_type;
    const summary = redactFreeText(
      `Review upstream assumptions after ${kind} evidence ${ev.identity?.outcome_id ?? ev.identity?.verification_id ?? ev.node_id}`,
      300,
    );

    proposals.push({
      schema_version: LINEAGE_SCHEMA_VERSION,
      type: "lineage_update_proposal",
      proposal_id: proposalId(ev.domain, [ev.node_id, ...upstreamTargets]),
      target_upstream_node_ids: [...upstreamTargets].sort(),
      citing_evidence_node_ids: [ev.node_id],
      citing_edge_ids: [...new Set(citingEdges)].sort(),
      proposed_change_summary: summary,
      authority_status: "proposal",
      reason_codes: reasonCodes,
      domain: opts.domain ?? ev.domain,
    });
  }

  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    type: "lineage_backward_proposals",
    proposals,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Apply path (authenticated approval required)
// ---------------------------------------------------------------------------

export type ApprovalAuthority = "human" | "repository_workflow";

/**
 * Caller-supplied approval claim. Shape alone is NOT sufficient authority —
 * {@link ApprovalVerifier} must bind it to an authenticated surface.
 */
export interface ProposalApproval {
  authority: ApprovalAuthority;
  /** Claimed human login or workflow id (must be verified, not trusted raw). */
  actor_id: string;
  approved_at: string;
  note?: string | null;
  /**
   * Optional opaque approval record id when the host resolves a stored
   * approval rather than an online identity check.
   */
  approval_id?: string;
}

/**
 * Injected dependency that authenticates an approval claim for a specific
 * proposal. Hosts bind this to live credentials (e.g. gh user) or a
 * repository-owned workflow attestation. Unit tests inject fakes.
 */
export interface ApprovalVerifier {
  /**
   * Return true only when `approval` is valid for `proposal` and issued by a
   * configured authority. Must fail closed on missing records, wrong proposal
   * targets, unconfigured workflows, or forged actor identity.
   */
  verify(approval: ProposalApproval, proposal: LineageUpdateProposal): boolean;
}

export interface ApplyProposalResult {
  ok: boolean;
  authority_status: ProposalAuthorityStatus;
  diagnostic?: { code: string; message: string };
  /** New decision node / revision / supersession artifacts when applied. */
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** Explicit: apply never merges or releases. */
  grants_merge_authority: false;
}

/**
 * Durable result of an approved upstream mutation adapter.
 * Must include the new authoritative revision(s) and supersession linkage
 * so history is never rewritten silently.
 */
export interface UpstreamMutationResult {
  /** New revision nodes for authoritative upstream artifacts. */
  revised_nodes: LineageNode[];
  /**
   * Edges with relationship `supersedes` linking each new revision (source)
   * to the prior authoritative node (target). At least one required when
   * revised_nodes is non-empty.
   */
  supersession_edges: LineageEdge[];
}

export interface ApplyProposalOpts {
  /**
   * Required for successful apply. Missing verifier fails closed — caller
   * shape checks alone never authorize mutation.
   */
  approvalVerifier?: ApprovalVerifier;
  /**
   * Optional mutation adapter. When provided it MUST return revised nodes and
   * supersession edges; invalid returns fail closed and do not mark applied.
   * When omitted, apply records decision provenance only (no upstream rewrite).
   */
  mutateUpstream?: (proposal: LineageUpdateProposal) => UpstreamMutationResult;
}

function refuseUnauthorized(message: string): ApplyProposalResult {
  return {
    ok: false,
    authority_status: "refused",
    diagnostic: {
      code: "unauthorized_upstream_mutation",
      message,
    },
    nodes: [],
    edges: [],
    grants_merge_authority: false,
  };
}

function refuseMissingSupersession(message: string): ApplyProposalResult {
  return {
    ok: false,
    authority_status: "refused",
    diagnostic: {
      code: "missing_revision_or_supersession",
      message,
    },
    nodes: [],
    edges: [],
    grants_merge_authority: false,
  };
}

/**
 * Validate mutation adapter output: revised nodes + supersedes edges required.
 */
export function validateUpstreamMutationResult(
  mutation: UpstreamMutationResult | null | undefined,
): { ok: true; result: UpstreamMutationResult } | { ok: false; message: string } {
  if (!mutation || typeof mutation !== "object") {
    return {
      ok: false,
      message: "mutation adapter must return revised_nodes and supersession_edges",
    };
  }
  const revised = mutation.revised_nodes;
  const edges = mutation.supersession_edges;
  if (!Array.isArray(revised) || revised.length === 0) {
    return {
      ok: false,
      message: "mutation adapter must return at least one revised_node",
    };
  }
  if (!Array.isArray(edges) || edges.length === 0) {
    return {
      ok: false,
      message: "mutation adapter must return supersession_edges (relationship supersedes)",
    };
  }
  const revisedIds = new Set(revised.map((n) => n.node_id));
  let supersedesCount = 0;
  for (const e of edges) {
    if (e.relationship !== "supersedes") {
      return {
        ok: false,
        message: `supersession edge ${e.edge_id} must use relationship supersedes`,
      };
    }
    if (!revisedIds.has(e.source_id)) {
      return {
        ok: false,
        message: `supersession edge ${e.edge_id} source must be a revised node`,
      };
    }
    if (!e.target_id?.trim()) {
      return {
        ok: false,
        message: `supersession edge ${e.edge_id} must reference prior node as target`,
      };
    }
    supersedesCount += 1;
  }
  if (supersedesCount === 0) {
    return {
      ok: false,
      message: "no valid supersedes edges in mutation result",
    };
  }
  return { ok: true, result: mutation };
}

/**
 * Apply a proposal only with verified human or repository-workflow approval.
 * Unauthorized attempts fail closed and record unauthorized_upstream_mutation.
 * Caller-asserted actor_id/authority strings are never sufficient alone.
 * When a mutation adapter is provided, apply requires durable revision +
 * supersession provenance in the adapter return value.
 */
export function applyLineageProposal(
  proposal: LineageUpdateProposal,
  approval: ProposalApproval | null | undefined,
  opts: ApplyProposalOpts = {},
): ApplyProposalResult {
  if (!approval || !approval.actor_id?.trim()) {
    return refuseUnauthorized(
      "apply refused: human or repository-workflow approval required",
    );
  }
  if (approval.authority !== "human" && approval.authority !== "repository_workflow") {
    return refuseUnauthorized("apply refused: invalid approval authority");
  }
  if (!opts.approvalVerifier) {
    return refuseUnauthorized(
      "apply refused: authenticated approval verifier required",
    );
  }
  let verified = false;
  try {
    verified = opts.approvalVerifier.verify(approval, proposal) === true;
  } catch {
    verified = false;
  }
  if (!verified) {
    return refuseUnauthorized(
      "apply refused: approval not authenticated for this proposal",
    );
  }

  // When mutation is requested, require revision + supersession before applying.
  let mutationResult: UpstreamMutationResult | null = null;
  if (opts.mutateUpstream) {
    let raw: UpstreamMutationResult;
    try {
      raw = opts.mutateUpstream(proposal);
    } catch (err) {
      return refuseMissingSupersession(
        `mutation adapter threw: ${(err as Error).message}`,
      );
    }
    const validated = validateUpstreamMutationResult(raw);
    if (!validated.ok) {
      return refuseMissingSupersession(
        `apply refused: ${validated.message}`,
      );
    }
    mutationResult = validated.result;
  }

  // Record decision provenance with supersession history when mutation ran.
  const decisionLocal = `apply:${proposal.proposal_id}`;
  const decisionNode = makeNodeShell({
    node_id: makeDomainNodeId(proposal.domain, "decision", decisionLocal),
    node_type: "decision",
    domain: proposal.domain,
    revision: "1",
    summary: redactFreeText(
      `Approved lineage proposal ${proposal.proposal_id} by ${approval.authority}:${approval.actor_id}`,
      300,
    ),
    identity: {
      decision_id: decisionLocal,
      proposal_id: proposal.proposal_id,
      approval_authority: approval.authority,
      actor_id: approval.actor_id,
      ...(approval.approval_id ? { approval_id: approval.approval_id } : {}),
      ...(mutationResult
        ? {
            revised_node_ids: mutationResult.revised_nodes.map((n) => n.node_id),
            supersession_edge_ids: mutationResult.supersession_edges.map((e) => e.edge_id),
          }
        : {}),
    },
    decision_status: "answered",
    producer: "lineage.apply",
    observed_at: approval.approved_at,
  });

  const nodes: LineageNode[] = [decisionNode];
  const edges: LineageEdge[] = [];
  for (const target of proposal.target_upstream_node_ids) {
    edges.push(
      makeEdgeShell({
        edge_id: makeDomainNodeId(
          proposal.domain,
          "edge",
          `decision:${decisionNode.node_id}:${target}`,
        ),
        source_id: decisionNode.node_id,
        target_id: target,
        relationship: "implements",
        revision: "1",
        method: "manual",
        authority: "observed",
        producer: "lineage.apply",
        observed_at: approval.approved_at,
      }),
    );
  }

  if (mutationResult) {
    nodes.push(...mutationResult.revised_nodes);
    edges.push(...mutationResult.supersession_edges);
  }

  return {
    ok: true,
    authority_status: "applied",
    nodes,
    edges,
    grants_merge_authority: false,
  };
}

// ---------------------------------------------------------------------------
// Completeness gate (default off)
// ---------------------------------------------------------------------------

export interface CompletenessGateConfig {
  /** When false/undefined, gate never blocks. */
  enabled?: boolean;
  /**
   * Required observed relationships per objective (e.g. ["verifies"]).
   * Default when enabled: ["verifies"].
   */
  required_relationships?: LineageEdge["relationship"][];
  /** When true, only authority=observed edges satisfy the gate. */
  require_observed?: boolean;
}

export interface CompletenessGateResult {
  ok: boolean;
  blocked: boolean;
  failures: Array<{
    objective_id: string;
    node_id: string;
    reason_code: DriftReasonCode;
    message: string;
  }>;
  diagnostics: Array<{ code: string; message: string }>;
}

/**
 * Optional lineage completeness gate. Default off — incomplete lineage does
 * not block and does not invent links.
 */
export function evaluateLineageCompletenessGate(
  graph: { nodes: readonly LineageNode[]; edges: readonly LineageEdge[] },
  config: CompletenessGateConfig | null | undefined,
): CompletenessGateResult {
  if (!config?.enabled) {
    return {
      ok: true,
      blocked: false,
      failures: [],
      diagnostics: [
        {
          code: "completeness_gate_off",
          message: "lineage completeness gate disabled or omitted; not blocking",
        },
      ],
    };
  }

  const required = config.required_relationships ?? ["verifies"];
  const requireObserved = config.require_observed !== false;
  const failures: CompletenessGateResult["failures"] = [];
  const diagnostics: CompletenessGateResult["diagnostics"] = [];

  const objectives = graph.nodes.filter((n) => n.node_type === "objective");
  for (const obj of objectives) {
    const objId = String(obj.identity?.objective_id ?? obj.node_id);
    for (const rel of required) {
      const matches = graph.edges.filter(
        (e) =>
          e.source_id === obj.node_id &&
          e.relationship === rel &&
          e.link_state === "active",
      );
      const observed = matches.filter((e) => e.provenance.authority === "observed");
      const ok = requireObserved ? observed.length > 0 : matches.length > 0;
      if (!ok) {
        failures.push({
          objective_id: objId,
          node_id: obj.node_id,
          reason_code: "missing_downstream_link",
          message: `missing required ${requireObserved ? "observed " : ""}${rel} edge for objective ${objId}`,
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    blocked: failures.length > 0,
    failures,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Human-readable summaries
// ---------------------------------------------------------------------------

export function formatImpactReportHuman(report: ForwardImpactReport): string {
  const lines: string[] = [
    "# lineage forward impact",
    `Upstream: ${report.upstream.node_type} ${report.upstream.node_id}`,
    `Prior revision: ${report.upstream.prior_revision ?? "—"} → new: ${report.upstream.new_revision ?? "—"}`,
    `Drift reason codes: ${report.drift_reason_codes.join(", ") || "(none)"}`,
    "",
    `Affected (${report.affected.length}):`,
  ];
  if (report.affected.length === 0) {
    lines.push("  (none)");
  } else {
    for (const a of report.affected) {
      lines.push(
        `  - ${a.node_type} ${a.node_id} [${a.drift_reason_codes.join(", ")}]`,
      );
    }
  }
  if (report.diagnostics.length) {
    lines.push("", "Diagnostics:");
    for (const d of report.diagnostics) {
      lines.push(`  [${d.code}] ${d.message}`);
    }
  }
  return lines.join("\n");
}

export function formatProposalsHuman(result: BackwardProposalResult): string {
  const lines: string[] = [
    "# lineage update proposals",
    `Count: ${result.proposals.length}`,
    "",
  ];
  if (result.proposals.length === 0) {
    lines.push("(no proposals)");
  } else {
    for (const p of result.proposals) {
      lines.push(`- ${p.proposal_id} [${p.authority_status}]`);
      lines.push(`  targets: ${p.target_upstream_node_ids.join(", ")}`);
      lines.push(`  evidence: ${p.citing_evidence_node_ids.join(", ")}`);
      lines.push(`  ${p.proposed_change_summary}`);
      lines.push(`  reasons: ${p.reason_codes.join(", ")}`);
    }
  }
  if (result.diagnostics.length) {
    lines.push("", "Diagnostics:");
    for (const d of result.diagnostics) {
      lines.push(`  [${d.code}] ${d.message}`);
    }
  }
  lines.push("");
  lines.push("Note: proposals are non-applied; approval required before upstream mutation.");
  return lines.join("\n");
}
