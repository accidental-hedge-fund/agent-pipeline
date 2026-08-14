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
        // outcome_of: outcome → run; reverse not needed for requirement→objective
        continue;
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

/**
 * Emit non-applied proposals from downstream evidence (outcomes, failures).
 * Never mutates authoritative upstream content.
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
    // Find linked runs via outcome_of edges
    const outEdges = outboundEdges(graph.edges, ev.node_id, {
      relationships: ["outcome_of"],
    });
    const runIds = outEdges
      .map((e) => e.target_id)
      .filter((id) => byId.get(id)?.node_type === "run");

    // From runs, find implements edges to objectives
    const objectiveIds = new Set<string>();
    const citingEdges = [...outEdges.map((e) => e.edge_id)];
    for (const runId of runIds) {
      for (const e of graph.edges) {
        if (e.relationship === "implements" && e.source_id === runId) {
          objectiveIds.add(e.target_id);
          citingEdges.push(e.edge_id);
        }
      }
    }

    // From objectives, walk derived_from / reverse decomposes_to to requirements
    const upstreamTargets = new Set<string>();
    for (const objId of objectiveIds) {
      upstreamTargets.add(objId);
      for (const e of graph.edges) {
        if (e.relationship === "derived_from" && e.source_id === objId) {
          upstreamTargets.add(e.target_id);
          citingEdges.push(e.edge_id);
        }
        if (e.relationship === "decomposes_to" && e.target_id === objId) {
          upstreamTargets.add(e.source_id);
          citingEdges.push(e.edge_id);
        }
      }
    }

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
      `Review upstream assumptions after ${kind} evidence ${ev.identity?.outcome_id ?? ev.node_id}`,
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
      reason_codes: ["downstream_outcome_evidence"],
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
// Apply path (approval required)
// ---------------------------------------------------------------------------

export type ApprovalAuthority = "human" | "repository_workflow";

export interface ProposalApproval {
  authority: ApprovalAuthority;
  /** Authenticated human login or workflow id. */
  actor_id: string;
  approved_at: string;
  note?: string | null;
}

export interface ApplyProposalResult {
  ok: boolean;
  authority_status: ProposalAuthorityStatus;
  diagnostic?: { code: string; message: string };
  /** New decision node / supersession artifacts when applied (in-memory only). */
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** Explicit: apply never merges or releases. */
  grants_merge_authority: false;
}

/**
 * Apply a proposal only with explicit human or repository-workflow approval.
 * Unauthorized attempts fail closed and record unauthorized_upstream_mutation.
 */
export function applyLineageProposal(
  proposal: LineageUpdateProposal,
  approval: ProposalApproval | null | undefined,
  opts: {
    /** Optional callback that mutates authoritative upstream; default is no-op record only. */
    mutateUpstream?: (proposal: LineageUpdateProposal) => void;
  } = {},
): ApplyProposalResult {
  if (!approval || !approval.actor_id?.trim()) {
    return {
      ok: false,
      authority_status: "refused",
      diagnostic: {
        code: "unauthorized_upstream_mutation",
        message: "apply refused: human or repository-workflow approval required",
      },
      nodes: [],
      edges: [],
      grants_merge_authority: false,
    };
  }
  if (approval.authority !== "human" && approval.authority !== "repository_workflow") {
    return {
      ok: false,
      authority_status: "refused",
      diagnostic: {
        code: "unauthorized_upstream_mutation",
        message: "apply refused: invalid approval authority",
      },
      nodes: [],
      edges: [],
      grants_merge_authority: false,
    };
  }

  // Record decision provenance; do not rewrite history without supersession.
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
    },
    decision_status: "answered",
    producer: "lineage.apply",
    observed_at: approval.approved_at,
  });

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

  if (opts.mutateUpstream) {
    opts.mutateUpstream(proposal);
  }

  return {
    ok: true,
    authority_status: "applied",
    nodes: [decisionNode],
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
