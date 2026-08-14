// Evidence-bundle / summary lineage export slice (#599).
// JSON + human-readable without a hosted UI.

import { LINEAGE_SCHEMA_VERSION, type LineageEdge, type LineageNode } from "./schema.ts";
import type { ForwardImpactReport, LineageUpdateProposal } from "./impact.ts";

export interface LineageExportSection {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  /** Explicit skip/empty reason when no lineage for the run. */
  skip_reason?: string | null;
  node_count: number;
  edge_count: number;
  objective_ids: string[];
  drift_reason_codes: string[];
  impact_ref?: ForwardImpactReport | null;
  proposal_refs?: LineageUpdateProposal[];
  nodes?: LineageNode[];
  edges?: LineageEdge[];
}

export interface BuildLineageExportOpts {
  nodes: readonly LineageNode[];
  edges: readonly LineageEdge[];
  /** When set, filter to nodes/edges related to this run_id. */
  run_id?: string | null;
  impact?: ForwardImpactReport | null;
  proposals?: LineageUpdateProposal[] | null;
  /** Include full node/edge arrays in export (default false for compact summary). */
  include_records?: boolean;
  skip_reason?: string | null;
}

/**
 * Build the lineage section for evidence bundle / summary.json.
 * Missing lineage is explicit (skip_reason or zero counts), never silent complete attribution.
 */
export function buildLineageExportSection(opts: BuildLineageExportOpts): LineageExportSection {
  let nodes = [...opts.nodes];
  let edges = [...opts.edges];

  if (opts.run_id) {
    const runNodeIds = new Set(
      nodes
        .filter((n) => n.node_type === "run" && n.identity?.run_id === opts.run_id)
        .map((n) => n.node_id),
    );
    // Include edges that touch run nodes or mapped_identity.run_id
    const relatedEdgeIds = new Set<string>();
    const relatedNodeIds = new Set<string>(runNodeIds);
    for (const e of edges) {
      if (
        runNodeIds.has(e.source_id) ||
        runNodeIds.has(e.target_id) ||
        e.mapped_identity?.run_id === opts.run_id
      ) {
        relatedEdgeIds.add(e.edge_id);
        relatedNodeIds.add(e.source_id);
        relatedNodeIds.add(e.target_id);
      }
    }
    // Expand once for objective/commit neighbors
    for (const e of edges) {
      if (relatedNodeIds.has(e.source_id) || relatedNodeIds.has(e.target_id)) {
        relatedEdgeIds.add(e.edge_id);
        relatedNodeIds.add(e.source_id);
        relatedNodeIds.add(e.target_id);
      }
    }
    nodes = nodes.filter((n) => relatedNodeIds.has(n.node_id));
    edges = edges.filter((e) => relatedEdgeIds.has(e.edge_id));
  }

  const objective_ids = [
    ...new Set(
      nodes
        .filter((n) => n.node_type === "objective")
        .map((n) => String(n.identity?.objective_id ?? n.node_id)),
    ),
  ].sort();

  const drift_reason_codes = new Set<string>();
  if (opts.impact) {
    for (const c of opts.impact.drift_reason_codes) drift_reason_codes.add(c);
    for (const a of opts.impact.affected) {
      for (const c of a.drift_reason_codes) drift_reason_codes.add(c);
    }
  }
  for (const e of edges) {
    for (const c of e.reason_codes ?? []) drift_reason_codes.add(c);
  }

  let skip_reason = opts.skip_reason ?? null;
  if (nodes.length === 0 && edges.length === 0 && !skip_reason) {
    skip_reason = "no_lineage_projected";
  }

  const section: LineageExportSection = {
    schema_version: LINEAGE_SCHEMA_VERSION,
    skip_reason,
    node_count: nodes.length,
    edge_count: edges.length,
    objective_ids,
    drift_reason_codes: [...drift_reason_codes].sort(),
    impact_ref: opts.impact ?? null,
    proposal_refs: opts.proposals ? [...opts.proposals] : [],
  };

  if (opts.include_records) {
    section.nodes = nodes;
    section.edges = edges;
  }

  return section;
}

export function formatLineageExportHuman(section: LineageExportSection): string {
  const lines: string[] = [
    "# lineage export",
    `schema_version: ${section.schema_version}`,
    `nodes: ${section.node_count}  edges: ${section.edge_count}`,
  ];
  if (section.skip_reason) {
    lines.push(`skip_reason: ${section.skip_reason}`);
  }
  if (section.objective_ids.length) {
    lines.push(`objectives: ${section.objective_ids.join(", ")}`);
  } else {
    lines.push("objectives: (none)");
  }
  if (section.drift_reason_codes.length) {
    lines.push(`drift_reason_codes: ${section.drift_reason_codes.join(", ")}`);
  } else {
    lines.push("drift_reason_codes: (none)");
  }
  if (section.impact_ref && section.impact_ref.affected.length) {
    lines.push("", "Impact affected:");
    for (const a of section.impact_ref.affected) {
      lines.push(
        `  - ${a.node_type} ${a.node_id} [${a.drift_reason_codes.join(", ")}]`,
      );
    }
  }
  if (section.proposal_refs && section.proposal_refs.length) {
    lines.push("", `Proposals: ${section.proposal_refs.length}`);
    for (const p of section.proposal_refs) {
      lines.push(`  - ${p.proposal_id} [${p.authority_status}]`);
    }
  }
  if (section.node_count === 0 && section.skip_reason) {
    lines.push("");
    lines.push("Note: missing lineage is explicit; complete intent-to-outcome attribution is NOT claimed.");
  }
  return lines.join("\n");
}
