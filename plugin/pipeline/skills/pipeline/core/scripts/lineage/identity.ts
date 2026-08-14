// Component and capability identity helpers (#599).
//
// Domain-scoped keys so path `core/scripts` in domain A never collides with
// domain B. Ownership metadata is routing/impact only — never merge authority.

import { createHash } from "node:crypto";
import {
  isPlaceholderIdentity,
  makeNodeShell,
  type LineageEdge,
  type LineageNode,
} from "./schema.ts";

/** Separator between domain and local key in global ids. */
export const DOMAIN_ID_SEP = "::";

export interface ComponentIdentity {
  domain: string;
  /** Local key (path prefix or module key); not domain-prefixed. */
  local_key: string;
  /** Global form: `{domain}::component:{local_key}` */
  component_id: string;
  /** Node id for a component node: `{domain}::component:{local_key}` */
  node_id: string;
}

export interface CapabilityIdentity {
  domain: string;
  local_key: string;
  capability_id: string;
  node_id: string;
}

export interface OwnershipMetadata {
  team_key?: string | null;
  codeowners_path?: string | null;
  attestation_route?: string | null;
  [key: string]: unknown;
}

function assertDomain(domain: string): string {
  const d = domain.trim();
  if (!d || isPlaceholderIdentity(d)) {
    throw new Error("component/capability identity requires a non-empty domain");
  }
  if (d.includes(DOMAIN_ID_SEP)) {
    throw new Error(`domain must not contain "${DOMAIN_ID_SEP}"`);
  }
  return d;
}

function assertLocalKey(localKey: string, kind: "component" | "capability"): string {
  const k = localKey.trim();
  if (!k || isPlaceholderIdentity(k)) {
    throw new Error(`${kind} local_key must be non-empty and non-placeholder`);
  }
  return k;
}

/** Resolve stable domain-scoped component identity. Unchanged path → stable id. */
export function resolveComponentId(domain: string, localKey: string): ComponentIdentity {
  const d = assertDomain(domain);
  const key = assertLocalKey(localKey, "component");
  const component_id = `${d}${DOMAIN_ID_SEP}component:${key}`;
  return {
    domain: d,
    local_key: key,
    component_id,
    node_id: component_id,
  };
}

/** Resolve stable domain-scoped capability identity. */
export function resolveCapabilityId(domain: string, localKey: string): CapabilityIdentity {
  const d = assertDomain(domain);
  const key = assertLocalKey(localKey, "capability");
  const capability_id = `${d}${DOMAIN_ID_SEP}capability:${key}`;
  return {
    domain: d,
    local_key: key,
    capability_id,
    node_id: capability_id,
  };
}

/**
 * Encode a local identifier so path separators cannot collide distinct paths.
 * Percent-escapes `%` before `/` and `\` so the mapping is injective:
 * literal `a%2Fb` → `a%252Fb` while path `a/b` → `a%2Fb` (distinct).
 * Reversible for unchanged input and stable.
 */
export function encodeLocalId(localId: string): string {
  return localId.replace(/[%/\\]/g, (ch) => {
    if (ch === "%") return "%25";
    if (ch === "/") return "%2F";
    return "%5C";
  });
}

/**
 * Legacy (v1 schema) local-id encoder: only `/` and `\` were escaped, so a
 * literal percent remained `%` and `a%2Fb` collided with `a/b`. Used by the
 * v1→v2 identity migration to detect and rewrite stored ids deterministically.
 */
export function encodeLocalIdV1(localId: string): string {
  return localId.replace(/[/\\]/g, (ch) => (ch === "/" ? "%2F" : "%5C"));
}

/**
 * Rewrite a stored v1 node_id to the v2 injective encoding, or null when the
 * stored id was already v2 (no `%` to re-escape). `localId` is the canonical
 * artifact local key (path, id, sha, …) recorded on the node's identity.
 */
export function migrateV1NodeId(
  storedNodeId: string,
  domain: string,
  nodeType: string,
  localId: string,
): string | null {
  const local = String(localId ?? "").trim();
  if (!local) return null;
  const v2 = makeDomainNodeId(domain, nodeType, local);
  if (v2 === storedNodeId) return null;
  const v1 = `${assertDomain(domain)}${DOMAIN_ID_SEP}${nodeType}:${encodeLocalIdV1(local)}`;
  return v1 === storedNodeId ? v2 : null;
}

/**
 * Canonical local id for each lineage node type, read from the recorded
 * identity material. Returns null when the node carries no usable local key.
 */
export function canonicalLocalIdForNode(node: {
  node_type: string;
  identity: Record<string, unknown>;
}): string | null {
  const id = node.identity;
  const pick = (k: string): string | null => {
    const v = id[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  switch (node.node_type) {
    case "requirement":
      return pick("path");
    case "component":
    case "capability":
      return pick("local_key") ?? pick("component_id") ?? pick("capability_id");
    case "objective":
      return pick("objective_id");
    case "intent_outcome":
      return pick("intent_id");
    case "run":
      return pick("run_id");
    case "commit":
      return pick("sha");
    case "pr":
      return pick("pr") ?? pick("pr_number");
    case "verification":
      return pick("verification_id");
    case "production_outcome":
      return pick("outcome_id");
    case "decision":
      return pick("decision_id");
    case "policy_event":
    case "override_event":
      return pick("event_id");
    default:
      return null;
  }
}

export interface IdentityMigrationResult {
  nodes: LineageNode[];
  edges: LineageEdge[];
  rewritten: number;
  ambiguous: number;
  diagnostics: Array<{ code: string; message: string }>;
}

/**
 * Deterministic v1→v2 identity rewrite for a lineage graph. Rewrites node ids
 * that still use the legacy (collision-prone) local-id encoding, remaps every
 * edge endpoint, and fails closed on ambiguous/colliding ids.
 *
 * Collision rule (#599 6af379e4): v1 allowed a literal `a%2Fb` and a slash
 * path `a/b` to share the stored id `…:a%2Fb`. A legacy id is colliding when
 * its nodes' canonical v2 identities differ; nothing under that id is
 * rewritten and `legacy_identity_collision` requires manual reconciliation.
 *
 * False-positive rule (#599 2d1b8f8d): a normal v2 slash-path node stores
 * `%2F` legitimately. Only ids that are neither valid v2 (canonical local id)
 * nor uniquely migratable v1 are flagged as `legacy_identity_ambiguous`.
 */
export function migrateLineageIdentityV1ToV2(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
): IdentityMigrationResult {
  const diagnostics: IdentityMigrationResult["diagnostics"] = [];
  const oldToNew = new Map<string, string>();
  let rewritten = 0;
  let ambiguous = 0;

  // Group every stored id by the FINAL v2 identity of the nodes that use it.
  // Distinct finals for one stored id = legacy collision (refuse rewrite).
  const finalsByStored = new Map<string, Set<string>>();
  const localByStored = new Map<LineageNode, string | null>();
  for (const n of nodes) {
    const local = canonicalLocalIdForNode(n);
    localByStored.set(n, local);
    if (!n.node_id) continue;
    if (!local) continue;
    const v2 = makeDomainNodeId(n.domain, n.node_type, local);
    let finals = finalsByStored.get(n.node_id);
    if (!finals) {
      finals = new Set();
      finalsByStored.set(n.node_id, finals);
    }
    finals.add(v2);
  }
  const collisionIds = new Set<string>();
  for (const [storedId, finals] of finalsByStored) {
    if (finals.size > 1) collisionIds.add(storedId);
  }

  const rewrittenNodes: LineageNode[] = nodes.map((n) => {
    if (!n.node_id) return n;
    if (collisionIds.has(n.node_id)) {
      diagnostics.push({
        code: "legacy_identity_collision",
        message: `legacy node_id ${n.node_id} maps to multiple v2 identities; manual reconciliation required`,
      });
      return n;
    }
    const local = localByStored.get(n);
    if (!local) return n;
    const v2 = makeDomainNodeId(n.domain, n.node_type, local);
    if (v2 === n.node_id) return n; // already current format
    rewritten += 1;
    oldToNew.set(n.node_id, v2);
    return { ...n, node_id: v2 };
  });

  const rewrittenEdges: LineageEdge[] = edges.map((edge) => {
    if (collisionIds.has(edge.source_id) || collisionIds.has(edge.target_id)) {
      // Refuse endpoint rewrite on a colliding id; leave the edge untouched so
      // the diagnostic (above) drives manual reconciliation instead of
      // retargeting an unrelated artifact.
      return edge;
    }
    const source = oldToNew.get(edge.source_id) ?? edge.source_id;
    const target = oldToNew.get(edge.target_id) ?? edge.target_id;
    if (source === edge.source_id && target === edge.target_id) return edge;
    return { ...edge, source_id: source, target_id: target };
  });

  // Fail closed: a stored percent-bearing id that is neither valid v2 nor
  // migratable v1 cannot be attributed — flag it, do not guess.
  for (const node of nodes) {
    if (!node.node_id || !(node.node_id.includes("%2F") || node.node_id.includes("%5C"))) continue;
    if (oldToNew.has(node.node_id) || collisionIds.has(node.node_id)) continue;
    const local = localByStored.get(node);
    if (local) {
      const v2 = makeDomainNodeId(node.domain, node.node_type, local);
      if (v2 === node.node_id) continue; // valid v2
    } else {
      // No canonical local key: cannot prove v2 or v1 → ambiguous.
    }
    ambiguous += 1;
    diagnostics.push({
      code: "legacy_identity_ambiguous",
      message: `cannot deterministically attribute legacy node_id ${node.node_id}; record left unrewritten`,
    });
  }

  return { nodes: rewrittenNodes, edges: rewrittenEdges, rewritten, ambiguous, diagnostics };
}

/**
 * Build a global node_id for an artifact type under a domain.
 * Form: `{domain}::{node_type}:{encoded_local_id}`
 *
 * Local ids use collision-free encoding for path separators so repository-native
 * paths like `openspec/specs/a_b/spec.md` and `openspec/specs/a/b/spec.md` never
 * share one node identity.
 */
export function makeDomainNodeId(
  domain: string,
  nodeType: string,
  localId: string,
): string {
  const d = assertDomain(domain);
  const local = localId.trim();
  if (!local || isPlaceholderIdentity(local)) {
    throw new Error("local id must be non-empty and non-placeholder");
  }
  const safeLocal = encodeLocalId(local);
  return `${d}${DOMAIN_ID_SEP}${nodeType}:${safeLocal}`;
}

/** True when two domains cannot share an unqualified path as one global id. */
export function componentIdsCollideAcrossDomains(
  domainA: string,
  domainB: string,
  localKey: string,
): boolean {
  if (domainA === domainB) return true; // same domain → same id (not a collision bug)
  const a = resolveComponentId(domainA, localKey);
  const b = resolveComponentId(domainB, localKey);
  return a.component_id === b.component_id;
}

/** Attach ownership metadata to a component node (does not grant merge authority). */
export function attachOwnership(
  node: LineageNode,
  ownership: OwnershipMetadata,
): LineageNode {
  if (node.node_type !== "component" && node.node_type !== "capability") {
    // Allow attach for impact metadata on other types without inventing authority.
  }
  return {
    ...node,
    ownership: { ...(node.ownership ?? {}), ...ownership },
  };
}

/** Build a component lineage node with optional ownership. */
export function makeComponentNode(
  domain: string,
  localKey: string,
  opts: {
    revision?: string;
    ownership?: OwnershipMetadata | null;
    summary?: string | null;
    producer?: string;
    observed_at?: string | null;
  } = {},
): LineageNode {
  const id = resolveComponentId(domain, localKey);
  return makeNodeShell({
    node_id: id.node_id,
    node_type: "component",
    domain: id.domain,
    revision: opts.revision ?? "1",
    component_id: id.component_id,
    identity: { local_key: id.local_key, component_id: id.component_id },
    ownership: opts.ownership ?? null,
    summary: opts.summary ?? null,
    producer: opts.producer,
    observed_at: opts.observed_at,
  });
}

/** Content hash helper for identity stability tests (sha256 hex of utf8). */
export function contentHash(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Validate that an owned_by edge target/source component identity is non-empty.
 * Returns diagnostic code or null if ok.
 */
export function validateOwnedByComponentId(componentId: string | null | undefined): string | null {
  if (componentId == null || !String(componentId).trim()) {
    return "empty_component_id";
  }
  if (isPlaceholderIdentity(String(componentId))) {
    return "placeholder_component_id";
  }
  return null;
}
