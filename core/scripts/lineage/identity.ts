// Component and capability identity helpers (#599).
//
// Domain-scoped keys so path `core/scripts` in domain A never collides with
// domain B. Ownership metadata is routing/impact only — never merge authority.

import { createHash } from "node:crypto";
import {
  isPlaceholderIdentity,
  makeNodeShell,
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
 * Build a global node_id for an artifact type under a domain.
 * Form: `{domain}::{node_type}:{local_id}`
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
  // Commit SHAs and similar may contain colons rarely; sanitize path seps only.
  const safeLocal = local.replace(/[/\\]/g, "_");
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
