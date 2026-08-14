// Pure graph integrity + helpers for the intent-lineage graph (#599).
// Offline-testable; no network/git/fs.

import {
  isDomainScopedNodeId,
  isPlaceholderIdentity,
  NODE_TYPES,
  RELATIONSHIPS,
  LINK_STATES,
  type LineageEdge,
  type LineageGraphSnapshot,
  type LineageNode,
  type ValidationIssue,
} from "./schema.ts";
import { validateOwnedByComponentId } from "./identity.ts";

export interface GraphIntegrityDiagnostic {
  code: string;
  message: string;
  path?: string;
  edge_id?: string;
  node_id?: string;
}

export interface GraphIntegrityResult {
  ok: boolean;
  diagnostics: GraphIntegrityDiagnostic[];
}

/** Index nodes by id (last writer wins if duplicates; diagnostic recorded). */
export function indexNodes(nodes: readonly LineageNode[]): Map<string, LineageNode> {
  const map = new Map<string, LineageNode>();
  for (const n of nodes) {
    map.set(n.node_id, n);
  }
  return map;
}

/**
 * Pure integrity check: endpoint existence, closed enums (already on records),
 * domain-scoped ids, no placeholder fabricated SHAs/run ids, owned_by component.
 */
export function validateGraphIntegrity(
  graph: LineageGraphSnapshot | { nodes: readonly LineageNode[]; edges: readonly LineageEdge[] },
): GraphIntegrityResult {
  const diagnostics: GraphIntegrityDiagnostic[] = [];
  const byId = indexNodes(graph.nodes);

  const seenNodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (seenNodeIds.has(n.node_id)) {
      diagnostics.push({
        code: "duplicate_node_id",
        message: `duplicate node_id ${n.node_id}`,
        node_id: n.node_id,
      });
    }
    seenNodeIds.add(n.node_id);

    if (!NODE_TYPES.includes(n.node_type)) {
      diagnostics.push({
        code: "invalid_node_type",
        message: `unknown node_type ${n.node_type}`,
        node_id: n.node_id,
      });
    }
    if (!isDomainScopedNodeId(n.node_id, n.domain)) {
      diagnostics.push({
        code: "undomained_node_id",
        message: "node_id must include domain scope",
        node_id: n.node_id,
      });
    }
    if (n.node_type === "commit") {
      const sha = n.identity?.sha;
      if (typeof sha === "string" && (isPlaceholderIdentity(sha) || !/^[0-9a-f]{40}$/i.test(sha))) {
        diagnostics.push({
          code: "fabricated_sha",
          message: "commit identity sha is placeholder or not full 40-char hex",
          node_id: n.node_id,
        });
      }
    }
    if (n.node_type === "run") {
      const rid = n.identity?.run_id;
      if (typeof rid === "string" && isPlaceholderIdentity(rid)) {
        diagnostics.push({
          code: "fabricated_run_id",
          message: "run identity run_id is placeholder",
          node_id: n.node_id,
        });
      }
    }
  }

  const seenEdgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (seenEdgeIds.has(e.edge_id)) {
      diagnostics.push({
        code: "duplicate_edge_id",
        message: `duplicate edge_id ${e.edge_id}`,
        edge_id: e.edge_id,
      });
    }
    seenEdgeIds.add(e.edge_id);

    if (!RELATIONSHIPS.includes(e.relationship)) {
      diagnostics.push({
        code: "invalid_relationship",
        message: `unknown relationship ${e.relationship}`,
        edge_id: e.edge_id,
      });
    }
    if (!LINK_STATES.includes(e.link_state)) {
      diagnostics.push({
        code: "invalid_link_state",
        message: `unknown link_state ${e.link_state}`,
        edge_id: e.edge_id,
      });
    }

    if (!byId.has(e.source_id)) {
      diagnostics.push({
        code: "unknown_source",
        message: `edge source_id ${e.source_id} absent from graph`,
        edge_id: e.edge_id,
        path: "source_id",
      });
    }
    if (!byId.has(e.target_id)) {
      diagnostics.push({
        code: "unknown_target",
        message: `edge target_id ${e.target_id} absent from graph`,
        edge_id: e.edge_id,
        path: "target_id",
      });
    }

    if (e.relationship === "owned_by") {
      const source = byId.get(e.source_id);
      const target = byId.get(e.target_id);
      const compId =
        target?.component_id ??
        source?.component_id ??
        (typeof target?.identity?.component_id === "string"
          ? target.identity.component_id
          : null);
      const bad = validateOwnedByComponentId(
        typeof compId === "string" ? compId : target?.node_type === "component" ? target.node_id : null,
      );
      if (bad === "empty_component_id" || (target?.node_type === "component" && !target.component_id && !target.node_id)) {
        diagnostics.push({
          code: "empty_component_id",
          message: "owned_by edge requires non-empty component_id",
          edge_id: e.edge_id,
        });
      }
      // Explicit empty component_id field
      if (target?.component_id === "") {
        diagnostics.push({
          code: "empty_component_id",
          message: "owned_by edge has empty component_id",
          edge_id: e.edge_id,
        });
      }
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

/** Outbound edges from a node (source → target direction for forward impact). */
export function outboundEdges(
  edges: readonly LineageEdge[],
  nodeId: string,
  opts: { relationships?: readonly string[]; linkStates?: readonly string[] } = {},
): LineageEdge[] {
  return edges.filter((e) => {
    if (e.source_id !== nodeId) return false;
    if (opts.relationships && !opts.relationships.includes(e.relationship)) return false;
    if (opts.linkStates && !opts.linkStates.includes(e.link_state)) return false;
    return true;
  });
}

/** Inbound edges to a node (for backward proposals). */
export function inboundEdges(
  edges: readonly LineageEdge[],
  nodeId: string,
  opts: { relationships?: readonly string[]; linkStates?: readonly string[] } = {},
): LineageEdge[] {
  return edges.filter((e) => {
    if (e.target_id !== nodeId) return false;
    if (opts.relationships && !opts.relationships.includes(e.relationship)) return false;
    if (opts.linkStates && !opts.linkStates.includes(e.link_state)) return false;
    return true;
  });
}

/**
 * Mark matching edges stale with a reason code (pure; returns new edge list).
 */
export function markEdgesStale(
  edges: readonly LineageEdge[],
  predicate: (e: LineageEdge) => boolean,
  reasonCode: string,
): LineageEdge[] {
  return edges.map((e) => {
    if (!predicate(e)) return e;
    if (e.link_state === "superseded" || e.link_state === "missing") return e;
    const codes = new Set([...(e.reason_codes ?? []), reasonCode]);
    return {
      ...e,
      link_state: "stale" as const,
      reason_codes: [...codes],
    };
  });
}

/** Find node by identity field (e.g. objective_id) under domain. */
export function findNodeByIdentity(
  nodes: readonly LineageNode[],
  nodeType: string,
  domain: string,
  field: string,
  value: string,
): LineageNode | undefined {
  return nodes.find(
    (n) =>
      n.node_type === nodeType &&
      n.domain === domain &&
      n.identity?.[field] === value,
  );
}

export type { ValidationIssue };
