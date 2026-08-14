// Intent-lineage evidence graph schema (#599).
//
// Versioned nodes/edges with closed enums, provenance, revision, link_state,
// and optional evidence_subject dimensions. Free text is redacted. Readers
// ignore unknown fields under a supported schema_version. No collapsed score.

import { redactSecrets, sanitize } from "../artifact-sanitize.ts";

// ---------------------------------------------------------------------------
// Schema version + closed enums
// ---------------------------------------------------------------------------

export const LINEAGE_SCHEMA_VERSION = 1 as const;

export const NODE_TYPES = [
  "intent_outcome",
  "requirement",
  "objective",
  "decision",
  "run",
  "commit",
  "pr",
  "verification",
  "production_outcome",
  "component",
  "capability",
  "policy_event",
  "override_event",
] as const;
export type LineageNodeType = (typeof NODE_TYPES)[number];

export const RELATIONSHIPS = [
  "implements",
  "derived_from",
  "verifies",
  "delivered_by",
  "outcome_of",
  "decomposes_to",
  "supersedes",
  "invalidates",
  "disputes",
  "owned_by",
  "maps_evidence",
  "affected_by_policy",
] as const;
export type LineageRelationship = (typeof RELATIONSHIPS)[number];

export const LINK_STATES = [
  "active",
  "stale",
  "disputed",
  "missing",
  "unknown",
  "superseded",
] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const PROVENANCE_METHODS = [
  "direct",
  "trailer",
  "adapter",
  "manual",
  "heuristic",
] as const;
export type ProvenanceMethod = (typeof PROVENANCE_METHODS)[number];

export const PROVENANCE_AUTHORITIES = ["observed", "inferred"] as const;
export type ProvenanceAuthority = (typeof PROVENANCE_AUTHORITIES)[number];

export const DECISION_STATUSES = ["answered", "deferred", "open"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DRIFT_REASON_CODES = [
  "upstream_requirement_revised",
  "objective_content_hash_changed",
  "component_ownership_changed",
  "policy_event_invalidated",
  "verification_subject_mismatch",
  "missing_downstream_link",
  "unauthorized_upstream_mutation",
] as const;
export type DriftReasonCode = (typeof DRIFT_REASON_CODES)[number];

export const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export interface LineageProvenance {
  producer: string;
  method: ProvenanceMethod;
  authority: ProvenanceAuthority;
  observed_at: string | null;
}

export interface LineageNodeProvenance {
  producer: string;
  observed_at: string | null;
}

/** Shared #692-style dimensions on verifies/maps_evidence edges when known. */
export interface MappedEvidenceIdentity {
  candidate_sha: string | null;
  policy_hash: string | null;
  verifier_fingerprint: string | null;
  run_id: string | null;
}

export interface LineageNode {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  type: "lineage_node";
  node_id: string;
  node_type: LineageNodeType;
  domain: string;
  revision: string;
  content_hash: string | null;
  component_id?: string | null;
  capability_id?: string | null;
  /** Bounded redacted free text; never secrets/prompts/source dumps. */
  summary: string | null;
  /** Type-specific identity material (objective_id, path, outcome_id, …). */
  identity: Record<string, unknown>;
  provenance: LineageNodeProvenance;
  /** Optional ownership metadata for component/capability nodes. */
  ownership?: Record<string, unknown> | null;
  /** Decision status when node_type === "decision". */
  decision_status?: DecisionStatus | null;
}

export interface LineageEdge {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  type: "lineage_edge";
  edge_id: string;
  source_id: string;
  target_id: string;
  relationship: LineageRelationship;
  provenance: LineageProvenance;
  revision: string;
  link_state: LinkState;
  /** Optional mapped-evidence identity block (#692 composition). */
  mapped_identity?: MappedEvidenceIdentity | null;
  reason_codes?: DriftReasonCode[] | string[];
  diagnostics?: string[];
}

export interface LineageGraphSnapshot {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  issues: ValidationIssue[];
  value: T | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Normalize a commit SHA: full 40-char hex lowercase, else null. Never invent. */
export function normalizeFullSha(sha: string | null | undefined): string | null {
  if (typeof sha !== "string") return null;
  const t = sha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(t)) return null;
  return t;
}

/** Reject placeholder-like identity strings that look fabricated. */
export function isPlaceholderIdentity(value: string): boolean {
  const t = value.trim().toLowerCase();
  if (!t) return true;
  if (t === "unknown" || t === "null" || t === "undefined" || t === "n/a" || t === "none") return true;
  if (/^0{7,}$/.test(t)) return true;
  if (/^placeholder/.test(t)) return true;
  if (t === "deadbeef" || t === "cafebabe") return true;
  // Short hex that looks like a truncated SHA placeholder
  if (/^(abc+|def+|fff+|000+){1,}$/.test(t) && t.length < 40) return true;
  return false;
}

export function redactFreeText(text: string, maxLen = 500): string {
  return sanitize(redactSecrets(text)).slice(0, maxLen);
}

export function isDomainScopedNodeId(nodeId: string, domain?: string): boolean {
  if (!nodeId.includes("::")) return false;
  if (domain != null && domain !== "") {
    return nodeId.startsWith(`${domain}::`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateNodeProvenance(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): LineageNodeProvenance {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: "provenance object required" });
    return { producer: "", observed_at: null };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.producer !== "string" || !o.producer.trim()) {
    issues.push({ path: `${path}.producer`, message: "required non-empty string" });
  }
  if (o.observed_at !== null && o.observed_at !== undefined && typeof o.observed_at !== "string") {
    issues.push({ path: `${path}.observed_at`, message: "must be ISO string or null" });
  }
  return {
    producer: typeof o.producer === "string" ? o.producer.trim() : "",
    observed_at: typeof o.observed_at === "string" ? o.observed_at : null,
  };
}

function validateEdgeProvenance(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): LineageProvenance {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ path, message: "provenance object required" });
    return { producer: "", method: "direct", authority: "inferred", observed_at: null };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.producer !== "string" || !o.producer.trim()) {
    issues.push({ path: `${path}.producer`, message: "required non-empty string" });
  }
  if (!isOneOf(o.method, PROVENANCE_METHODS)) {
    issues.push({ path: `${path}.method`, message: "invalid provenance method" });
  }
  if (!isOneOf(o.authority, PROVENANCE_AUTHORITIES)) {
    issues.push({ path: `${path}.authority`, message: "invalid authority" });
  }
  if (o.observed_at !== null && o.observed_at !== undefined && typeof o.observed_at !== "string") {
    issues.push({ path: `${path}.observed_at`, message: "must be ISO string or null" });
  }
  return {
    producer: typeof o.producer === "string" ? o.producer.trim() : "",
    method: isOneOf(o.method, PROVENANCE_METHODS) ? o.method : "heuristic",
    authority: isOneOf(o.authority, PROVENANCE_AUTHORITIES) ? o.authority : "inferred",
    observed_at: typeof o.observed_at === "string" ? o.observed_at : null,
  };
}

function validateMappedIdentity(
  raw: unknown,
  issues: ValidationIssue[],
  path: string,
): MappedEvidenceIdentity | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path, message: "mapped_identity must be object or null" });
    return null;
  }
  const o = raw as Record<string, unknown>;
  let candidate_sha: string | null = null;
  if (o.candidate_sha != null) {
    candidate_sha = normalizeFullSha(String(o.candidate_sha));
    if (candidate_sha === null) {
      issues.push({
        path: `${path}.candidate_sha`,
        message: "must be full 40-char hex SHA or null",
      });
    }
  }
  const policy_hash =
    o.policy_hash == null ? null : typeof o.policy_hash === "string" ? o.policy_hash : null;
  if (o.policy_hash != null && typeof o.policy_hash !== "string") {
    issues.push({ path: `${path}.policy_hash`, message: "must be string or null" });
  }
  const verifier_fingerprint =
    o.verifier_fingerprint == null
      ? null
      : typeof o.verifier_fingerprint === "string"
        ? o.verifier_fingerprint
        : null;
  if (o.verifier_fingerprint != null && typeof o.verifier_fingerprint !== "string") {
    issues.push({ path: `${path}.verifier_fingerprint`, message: "must be string or null" });
  }
  let run_id: string | null = null;
  if (o.run_id != null) {
    if (typeof o.run_id !== "string" || isPlaceholderIdentity(o.run_id)) {
      issues.push({ path: `${path}.run_id`, message: "must be non-placeholder string or null" });
    } else {
      run_id = o.run_id;
    }
  }
  return { candidate_sha, policy_hash, verifier_fingerprint, run_id };
}

/**
 * Validate and normalize a lineage node. Unknown additive fields are ignored
 * (not copied). Rejects unknown node_type and placeholder ids.
 */
export function validateLineageNode(input: unknown): ValidationResult<LineageNode> {
  const issues: ValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "", message: "node must be an object" }], value: null };
  }
  const o = input as Record<string, unknown>;

  if (o.schema_version !== LINEAGE_SCHEMA_VERSION) {
    issues.push({ path: "schema_version", message: `must be ${LINEAGE_SCHEMA_VERSION}` });
  }
  if (o.type !== "lineage_node") {
    issues.push({ path: "type", message: 'must be "lineage_node"' });
  }
  if (typeof o.node_id !== "string" || !o.node_id.trim() || isPlaceholderIdentity(o.node_id)) {
    issues.push({ path: "node_id", message: "required non-placeholder string" });
  }
  if (!isOneOf(o.node_type, NODE_TYPES)) {
    issues.push({ path: "node_type", message: "invalid or unknown node_type for schema_version 1" });
  }
  if (typeof o.domain !== "string" || !o.domain.trim()) {
    issues.push({ path: "domain", message: "required non-empty domain" });
  }
  if (typeof o.revision !== "string" || !o.revision.trim()) {
    issues.push({ path: "revision", message: "required revision string" });
  }
  if (o.content_hash !== null && o.content_hash !== undefined && typeof o.content_hash !== "string") {
    issues.push({ path: "content_hash", message: "must be string or null" });
  }

  const domain = typeof o.domain === "string" ? o.domain.trim() : "";
  const node_id = typeof o.node_id === "string" ? o.node_id.trim() : "";
  if (domain && node_id && !isDomainScopedNodeId(node_id, domain)) {
    issues.push({
      path: "node_id",
      message: "node_id must be domain-scoped (domain::…)",
    });
  }

  if (o.node_type === "commit" && typeof o.identity === "object" && o.identity !== null) {
    const sha = (o.identity as Record<string, unknown>).sha;
    if (sha != null && normalizeFullSha(String(sha)) === null) {
      issues.push({ path: "identity.sha", message: "commit sha must be full 40-char hex" });
    }
  }

  if (o.node_type === "run" && typeof o.identity === "object" && o.identity !== null) {
    const rid = (o.identity as Record<string, unknown>).run_id;
    if (typeof rid === "string" && isPlaceholderIdentity(rid)) {
      issues.push({ path: "identity.run_id", message: "placeholder run_id forbidden" });
    }
  }

  if (o.node_type === "decision") {
    if (o.decision_status != null && !isOneOf(o.decision_status, DECISION_STATUSES)) {
      issues.push({ path: "decision_status", message: "must be answered|deferred|open" });
    }
  }

  // Empty component_id is invalid when present on ownership-bearing edges later;
  // at node level, empty string is rejected if field is set.
  if (o.component_id !== undefined && o.component_id !== null) {
    if (typeof o.component_id !== "string" || !o.component_id.trim()) {
      issues.push({ path: "component_id", message: "must be non-empty string or null" });
    }
  }
  if (o.capability_id !== undefined && o.capability_id !== null) {
    if (typeof o.capability_id !== "string" || !o.capability_id.trim()) {
      issues.push({ path: "capability_id", message: "must be non-empty string or null" });
    }
  }

  const provenance = validateNodeProvenance(o.provenance, issues, "provenance");

  let identity: Record<string, unknown> = {};
  if (o.identity !== undefined && o.identity !== null) {
    if (typeof o.identity !== "object" || Array.isArray(o.identity)) {
      issues.push({ path: "identity", message: "must be object" });
    } else {
      identity = { ...(o.identity as Record<string, unknown>) };
    }
  }

  const summary =
    o.summary == null
      ? null
      : typeof o.summary === "string"
        ? redactFreeText(o.summary, 500)
        : null;
  if (o.summary != null && typeof o.summary !== "string") {
    issues.push({ path: "summary", message: "must be string or null" });
  }

  if (issues.length > 0) {
    return { ok: false, issues, value: null };
  }

  const node: LineageNode = {
    schema_version: LINEAGE_SCHEMA_VERSION,
    type: "lineage_node",
    node_id,
    node_type: o.node_type as LineageNodeType,
    domain,
    revision: String(o.revision).trim(),
    content_hash: o.content_hash == null ? null : String(o.content_hash),
    component_id:
      o.component_id == null || o.component_id === undefined
        ? null
        : String(o.component_id).trim(),
    capability_id:
      o.capability_id == null || o.capability_id === undefined
        ? null
        : String(o.capability_id).trim(),
    summary,
    identity,
    provenance,
    ownership:
      o.ownership == null || o.ownership === undefined
        ? null
        : typeof o.ownership === "object" && !Array.isArray(o.ownership)
          ? (o.ownership as Record<string, unknown>)
          : null,
    decision_status:
      o.node_type === "decision" && isOneOf(o.decision_status, DECISION_STATUSES)
        ? o.decision_status
        : o.node_type === "decision"
          ? null
          : undefined,
  };
  return { ok: true, issues: [], value: node };
}

/**
 * Validate and normalize a lineage edge.
 */
export function validateLineageEdge(input: unknown): ValidationResult<LineageEdge> {
  const issues: ValidationIssue[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: "", message: "edge must be an object" }], value: null };
  }
  const o = input as Record<string, unknown>;

  if (o.schema_version !== LINEAGE_SCHEMA_VERSION) {
    issues.push({ path: "schema_version", message: `must be ${LINEAGE_SCHEMA_VERSION}` });
  }
  if (o.type !== "lineage_edge") {
    issues.push({ path: "type", message: 'must be "lineage_edge"' });
  }
  if (typeof o.edge_id !== "string" || !o.edge_id.trim() || isPlaceholderIdentity(o.edge_id)) {
    issues.push({ path: "edge_id", message: "required non-placeholder string" });
  }
  if (typeof o.source_id !== "string" || !o.source_id.trim() || isPlaceholderIdentity(o.source_id)) {
    issues.push({ path: "source_id", message: "required non-placeholder string" });
  }
  if (typeof o.target_id !== "string" || !o.target_id.trim() || isPlaceholderIdentity(o.target_id)) {
    issues.push({ path: "target_id", message: "required non-placeholder string" });
  }
  if (!isOneOf(o.relationship, RELATIONSHIPS)) {
    issues.push({ path: "relationship", message: "invalid relationship" });
  }
  if (!isOneOf(o.link_state, LINK_STATES)) {
    issues.push({ path: "link_state", message: "invalid link_state" });
  }
  if (typeof o.revision !== "string" || !o.revision.trim()) {
    issues.push({ path: "revision", message: "required revision string" });
  }

  // owned_by with empty component context is validated at graph/apply layer via
  // empty component_id on related nodes; here reject empty relationship only.

  const provenance = validateEdgeProvenance(o.provenance, issues, "provenance");
  const mapped_identity = validateMappedIdentity(o.mapped_identity, issues, "mapped_identity");

  if (issues.length > 0) {
    return { ok: false, issues, value: null };
  }

  const reason_codes: string[] = [];
  if (Array.isArray(o.reason_codes)) {
    for (const c of o.reason_codes) {
      if (typeof c === "string") reason_codes.push(c);
    }
  }
  const diagnostics: string[] = [];
  if (Array.isArray(o.diagnostics)) {
    for (const d of o.diagnostics) {
      if (typeof d === "string") diagnostics.push(redactFreeText(d, 200));
    }
  }

  const edge: LineageEdge = {
    schema_version: LINEAGE_SCHEMA_VERSION,
    type: "lineage_edge",
    edge_id: String(o.edge_id).trim(),
    source_id: String(o.source_id).trim(),
    target_id: String(o.target_id).trim(),
    relationship: o.relationship as LineageRelationship,
    provenance,
    revision: String(o.revision).trim(),
    link_state: o.link_state as LinkState,
    mapped_identity,
    reason_codes: reason_codes.length ? reason_codes : undefined,
    diagnostics: diagnostics.length ? diagnostics : undefined,
  };
  return { ok: true, issues: [], value: edge };
}

export function readLineageNode(input: unknown): LineageNode | null {
  return validateLineageNode(input).value;
}

export function readLineageEdge(input: unknown): LineageEdge | null {
  return validateLineageEdge(input).value;
}

export function serializeLineageNode(node: LineageNode): string {
  return `${JSON.stringify(node, null, 2)}\n`;
}

export function serializeLineageEdge(edge: LineageEdge): string {
  return `${JSON.stringify(edge, null, 2)}\n`;
}

/** Build a minimal valid node shell for tests/projectors. */
export function makeNodeShell(partial: {
  node_id: string;
  node_type: LineageNodeType;
  domain: string;
  revision: string;
  content_hash?: string | null;
  summary?: string | null;
  identity?: Record<string, unknown>;
  producer?: string;
  observed_at?: string | null;
  component_id?: string | null;
  capability_id?: string | null;
  ownership?: Record<string, unknown> | null;
  decision_status?: DecisionStatus | null;
}): LineageNode {
  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    type: "lineage_node",
    node_id: partial.node_id,
    node_type: partial.node_type,
    domain: partial.domain,
    revision: partial.revision,
    content_hash: partial.content_hash ?? null,
    component_id: partial.component_id ?? null,
    capability_id: partial.capability_id ?? null,
    summary: partial.summary != null ? redactFreeText(partial.summary) : null,
    identity: partial.identity ?? {},
    provenance: {
      producer: partial.producer ?? "lineage",
      observed_at: partial.observed_at ?? null,
    },
    ownership: partial.ownership ?? null,
    decision_status: partial.decision_status,
  };
}

/** Build a minimal valid edge shell for tests/projectors. */
export function makeEdgeShell(partial: {
  edge_id: string;
  source_id: string;
  target_id: string;
  relationship: LineageRelationship;
  revision: string;
  link_state?: LinkState;
  method?: ProvenanceMethod;
  authority?: ProvenanceAuthority;
  producer?: string;
  observed_at?: string | null;
  mapped_identity?: MappedEvidenceIdentity | null;
  reason_codes?: string[];
  diagnostics?: string[];
}): LineageEdge {
  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    type: "lineage_edge",
    edge_id: partial.edge_id,
    source_id: partial.source_id,
    target_id: partial.target_id,
    relationship: partial.relationship,
    provenance: {
      producer: partial.producer ?? "lineage",
      method: partial.method ?? "direct",
      authority: partial.authority ?? "observed",
      observed_at: partial.observed_at ?? null,
    },
    revision: partial.revision,
    link_state: partial.link_state ?? "active",
    mapped_identity: partial.mapped_identity ?? null,
    reason_codes: partial.reason_codes,
    diagnostics: partial.diagnostics,
  };
}
