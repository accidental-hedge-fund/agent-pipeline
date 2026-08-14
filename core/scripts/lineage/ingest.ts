// Deterministic lineage ingest projectors (#599).
//
// Project authoritative identities into nodes/edges without inventing ids.
// Offline-testable with fixtures; partial sources are non-fatal.

import { createHash } from "node:crypto";
import {
  isPlaceholderIdentity,
  makeEdgeShell,
  makeNodeShell,
  normalizeFullSha,
  redactFreeText,
  type DecisionStatus,
  type LineageEdge,
  type LineageNode,
  type MappedEvidenceIdentity,
  type ProvenanceAuthority,
  type ProvenanceMethod,
} from "./schema.ts";
import { contentHash, makeDomainNodeId, makeComponentNode, resolveComponentId } from "./identity.ts";
import { findNodeByIdentity } from "./graph.ts";

export interface IngestDiagnostic {
  code: string;
  message: string;
  ref?: string;
}

export interface IngestResult {
  nodes: LineageNode[];
  edges: LineageEdge[];
  diagnostics: IngestDiagnostic[];
}

function edgeId(
  domain: string,
  relationship: string,
  sourceId: string,
  targetId: string,
  rev = "1",
): string {
  const basis = `${domain}|${relationship}|${sourceId}|${targetId}|${rev}`;
  const h = createHash("sha1").update(basis).digest("hex").slice(0, 12);
  return makeDomainNodeId(domain, "edge", `${relationship}:${h}`);
}

// ---------------------------------------------------------------------------
// Source shapes (fixtures / adapters)
// ---------------------------------------------------------------------------

export interface ObjectiveSource {
  objective_id: string;
  content_hash: string;
  summary?: string | null;
  domain: string;
  /** Prior content hash when superseding. */
  prior_content_hash?: string | null;
}

export interface RequirementSource {
  domain: string;
  /** e.g. openspec/specs/foo/spec.md */
  path: string;
  content_hash: string;
  summary?: string | null;
  issue?: number | null;
}

export interface IntentSource {
  domain: string;
  intent_id: string;
  summary?: string | null;
  issue?: number | null;
}

export interface RunSource {
  domain: string;
  run_id: string;
  issue?: number | null;
  pr?: number | null;
  started_at?: string | null;
}

export interface CommitSource {
  domain: string;
  sha: string;
  /** Pipeline-Run trailer value when present. */
  pipeline_run_trailer?: string | null;
  issue_trailer?: string | null;
  pr?: number | null;
}

export interface PrSource {
  domain: string;
  pr: number;
  title?: string | null;
}

export interface VerificationSource {
  domain: string;
  verification_id: string;
  kind?: string | null;
  objective_id?: string | null;
  run_id?: string | null;
  mapped_identity?: MappedEvidenceIdentity | null;
}

export interface OutcomeAttributionSource {
  target_type: "run" | "commit" | "pr" | "issue" | "component";
  target_id: string;
  method: ProvenanceMethod;
  authority: ProvenanceAuthority;
  disputed?: boolean;
}

export interface OutcomeSource {
  domain: string;
  outcome_id: string;
  outcome_kind?: string;
  observation_state?: string;
  summary?: string | null;
  attribution: OutcomeAttributionSource[];
}

export interface DecisionSource {
  domain: string;
  decision_id: string;
  status: DecisionStatus;
  summary?: string | null;
  producer?: string;
}

export interface PolicyEventSource {
  domain: string;
  event_id: string;
  policy_hash?: string | null;
  summary?: string | null;
  affects_run_id?: string | null;
}

export interface OverrideEventSource {
  domain: string;
  event_id: string;
  run_id?: string | null;
  finding_key?: string | null;
  summary?: string | null;
}

export interface LineageIngestInput {
  domain: string;
  intents?: readonly IntentSource[];
  requirements?: readonly RequirementSource[];
  objectives?: readonly ObjectiveSource[];
  runs?: readonly RunSource[];
  commits?: readonly CommitSource[];
  prs?: readonly PrSource[];
  verifications?: readonly VerificationSource[];
  outcomes?: readonly OutcomeSource[];
  decisions?: readonly DecisionSource[];
  policy_events?: readonly PolicyEventSource[];
  override_events?: readonly OverrideEventSource[];
  /** Optional existing graph for supersession detection. */
  existing_nodes?: readonly LineageNode[];
  now?: Date;
  producer?: string;
}

// ---------------------------------------------------------------------------
// Projectors
// ---------------------------------------------------------------------------

export function projectObjective(
  src: ObjectiveSource,
  opts: {
    producer?: string;
    observed_at?: string | null;
    existing?: readonly LineageNode[];
  } = {},
): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];

  if (!src.objective_id?.trim() || isPlaceholderIdentity(src.objective_id)) {
    diagnostics.push({
      code: "missing_objective_id",
      message: "objective_id missing or placeholder; not inventing",
      ref: src.objective_id,
    });
    return { nodes, edges, diagnostics };
  }
  if (!src.content_hash?.trim()) {
    diagnostics.push({
      code: "missing_content_hash",
      message: "objective content_hash required",
      ref: src.objective_id,
    });
    return { nodes, edges, diagnostics };
  }

  const localId = `${src.objective_id}@${src.content_hash.slice(0, 16)}`;
  const node_id = makeDomainNodeId(src.domain, "objective", localId);
  const observed_at = opts.observed_at ?? null;
  const node = makeNodeShell({
    node_id,
    node_type: "objective",
    domain: src.domain,
    revision: src.content_hash,
    content_hash: src.content_hash,
    summary: src.summary ?? null,
    identity: {
      objective_id: src.objective_id,
      content_hash: src.content_hash,
    },
    producer: opts.producer ?? "lineage.ingest.objective",
    observed_at,
  });
  nodes.push(node);

  // Supersession: prior hash or existing objective with same objective_id different hash
  const priorHash = src.prior_content_hash;
  const existing = opts.existing ?? [];
  const prior =
    priorHash != null
      ? existing.find(
          (n) =>
            n.node_type === "objective" &&
            n.domain === src.domain &&
            n.identity?.objective_id === src.objective_id &&
            n.content_hash === priorHash,
        )
      : existing.find(
          (n) =>
            n.node_type === "objective" &&
            n.domain === src.domain &&
            n.identity?.objective_id === src.objective_id &&
            n.content_hash !== src.content_hash,
        );

  if (prior && prior.node_id !== node_id) {
    edges.push(
      makeEdgeShell({
        edge_id: edgeId(src.domain, "supersedes", node_id, prior.node_id, src.content_hash),
        source_id: node_id,
        target_id: prior.node_id,
        relationship: "supersedes",
        revision: src.content_hash,
        method: "direct",
        authority: "observed",
        producer: opts.producer ?? "lineage.ingest.objective",
        observed_at,
        reason_codes: ["objective_content_hash_changed"],
      }),
    );
  }

  return { nodes, edges, diagnostics };
}

export function projectRequirement(src: RequirementSource, producer = "lineage.ingest.requirement"): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  if (!src.path?.trim() || !src.content_hash?.trim()) {
    diagnostics.push({
      code: "missing_requirement_identity",
      message: "path and content_hash required",
      ref: src.path,
    });
    return { nodes: [], edges: [], diagnostics };
  }
  const localId = `${src.path}@${src.content_hash.slice(0, 16)}`;
  const node_id = makeDomainNodeId(src.domain, "requirement", localId);
  const node = makeNodeShell({
    node_id,
    node_type: "requirement",
    domain: src.domain,
    revision: src.content_hash,
    content_hash: src.content_hash,
    summary: src.summary ?? null,
    identity: {
      path: src.path,
      content_hash: src.content_hash,
      issue: src.issue ?? null,
    },
    producer,
  });
  return { nodes: [node], edges: [], diagnostics };
}

export function projectIntent(src: IntentSource, producer = "lineage.ingest.intent"): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  if (!src.intent_id?.trim() || isPlaceholderIdentity(src.intent_id)) {
    diagnostics.push({
      code: "missing_intent_id",
      message: "intent_id missing; not inventing",
    });
    return { nodes: [], edges: [], diagnostics };
  }
  const node_id = makeDomainNodeId(src.domain, "intent_outcome", src.intent_id);
  const node = makeNodeShell({
    node_id,
    node_type: "intent_outcome",
    domain: src.domain,
    revision: "1",
    summary: src.summary ?? null,
    identity: { intent_id: src.intent_id, issue: src.issue ?? null },
    producer,
  });
  return { nodes: [node], edges: [], diagnostics };
}

export function projectRun(src: RunSource, producer = "lineage.ingest.run"): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  if (!src.run_id?.trim() || isPlaceholderIdentity(src.run_id)) {
    diagnostics.push({
      code: "missing_run_id",
      message: "run_id missing or placeholder; not inventing",
      ref: src.run_id,
    });
    return { nodes: [], edges: [], diagnostics };
  }
  const node_id = makeDomainNodeId(src.domain, "run", src.run_id);
  const node = makeNodeShell({
    node_id,
    node_type: "run",
    domain: src.domain,
    revision: "1",
    identity: {
      run_id: src.run_id,
      issue: src.issue ?? null,
      pr: src.pr ?? null,
    },
    producer,
    observed_at: src.started_at ?? null,
  });
  return { nodes: [node], edges: [], diagnostics };
}

export function projectCommit(
  src: CommitSource,
  runNodes: readonly LineageNode[],
  producer = "lineage.ingest.commit",
): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  const edges: LineageEdge[] = [];
  const sha = normalizeFullSha(src.sha);
  if (!sha) {
    diagnostics.push({
      code: "invalid_commit_sha",
      message: "commit sha must be full 40-char hex; not inventing",
      ref: src.sha,
    });
    return { nodes: [], edges: [], diagnostics };
  }
  const node_id = makeDomainNodeId(src.domain, "commit", sha);
  const node = makeNodeShell({
    node_id,
    node_type: "commit",
    domain: src.domain,
    revision: sha,
    identity: { sha, pr: src.pr ?? null },
    producer,
  });

  // Trailer join → observed commit→run (delivered_by / implements direction: run delivered by commit)
  if (src.pipeline_run_trailer) {
    const trailer = src.pipeline_run_trailer.trim();
    // Pipeline-Run: 599/2026-08-14T02:58:43Z or full run_id
    const matchRun = runNodes.find((n) => {
      if (n.node_type !== "run") return false;
      const rid = String(n.identity?.run_id ?? "");
      return rid === trailer || rid.endsWith(trailer) || rid.includes(trailer) || trailer.includes(rid);
    });
    if (matchRun) {
      edges.push(
        makeEdgeShell({
          edge_id: edgeId(src.domain, "delivered_by", matchRun.node_id, node_id),
          source_id: matchRun.node_id,
          target_id: node_id,
          relationship: "delivered_by",
          revision: sha,
          method: "trailer",
          authority: "observed",
          producer,
        }),
      );
    } else {
      diagnostics.push({
        code: "unresolved_pipeline_run_trailer",
        message: "Pipeline-Run trailer present but no matching run node",
        ref: trailer,
      });
    }
  }

  return { nodes: [node], edges, diagnostics };
}

export function projectPr(src: PrSource, producer = "lineage.ingest.pr"): IngestResult {
  const node_id = makeDomainNodeId(src.domain, "pr", String(src.pr));
  const node = makeNodeShell({
    node_id,
    node_type: "pr",
    domain: src.domain,
    revision: "1",
    summary: src.title != null ? redactFreeText(src.title, 200) : null,
    identity: { pr: src.pr },
    producer,
  });
  return { nodes: [node], edges: [], diagnostics: [] };
}

export function projectVerification(
  src: VerificationSource,
  graphNodes: readonly LineageNode[],
  producer = "lineage.ingest.verification",
): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  const edges: LineageEdge[] = [];
  if (!src.verification_id?.trim() || isPlaceholderIdentity(src.verification_id)) {
    diagnostics.push({
      code: "missing_verification_id",
      message: "verification_id missing; not inventing",
    });
    return { nodes: [], edges: [], diagnostics };
  }
  // Do not invent run_id
  if (src.run_id != null && isPlaceholderIdentity(src.run_id)) {
    diagnostics.push({
      code: "placeholder_run_id",
      message: "refusing placeholder run_id on verification",
      ref: src.run_id,
    });
    src = { ...src, run_id: null };
  }

  const node_id = makeDomainNodeId(src.domain, "verification", src.verification_id);
  const node = makeNodeShell({
    node_id,
    node_type: "verification",
    domain: src.domain,
    revision: "1",
    identity: {
      verification_id: src.verification_id,
      kind: src.kind ?? null,
      run_id: src.run_id ?? null,
      objective_id: src.objective_id ?? null,
    },
    producer,
  });

  if (src.objective_id) {
    const obj = findNodeByIdentity(graphNodes, "objective", src.domain, "objective_id", src.objective_id);
    // Prefer matching content-hash-bearing objective if multiple — any match
    const objNode =
      obj ??
      graphNodes.find(
        (n) =>
          n.node_type === "objective" &&
          n.domain === src.domain &&
          n.identity?.objective_id === src.objective_id,
      );
    if (objNode) {
      const mid: MappedEvidenceIdentity = {
        candidate_sha: src.mapped_identity?.candidate_sha ?? null,
        policy_hash: src.mapped_identity?.policy_hash ?? null,
        verifier_fingerprint: src.mapped_identity?.verifier_fingerprint ?? null,
        run_id: src.run_id ?? src.mapped_identity?.run_id ?? null,
      };
      edges.push(
        makeEdgeShell({
          edge_id: edgeId(src.domain, "verifies", objNode.node_id, node_id),
          source_id: objNode.node_id,
          target_id: node_id,
          relationship: "verifies",
          revision: "1",
          method: "direct",
          authority: "observed",
          producer,
          mapped_identity: mid,
        }),
      );
    } else {
      diagnostics.push({
        code: "unresolved_objective_for_verification",
        message: "verification references objective not in graph",
        ref: src.objective_id,
      });
    }
  }

  if (src.run_id) {
    const runNode = graphNodes.find(
      (n) => n.node_type === "run" && n.identity?.run_id === src.run_id,
    );
    if (!runNode) {
      diagnostics.push({
        code: "unresolved_run_for_verification",
        message: "verification run_id not resolvable; not fabricating run node",
        ref: src.run_id,
      });
    }
  }

  return { nodes: [node], edges, diagnostics };
}

export function projectOutcome(
  src: OutcomeSource,
  graphNodes: readonly LineageNode[],
  producer = "lineage.ingest.outcome",
): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  const edges: LineageEdge[] = [];
  if (!src.outcome_id?.trim() || isPlaceholderIdentity(src.outcome_id)) {
    diagnostics.push({
      code: "missing_outcome_id",
      message: "outcome_id missing; not inventing",
    });
    return { nodes: [], edges: [], diagnostics };
  }

  const node_id = makeDomainNodeId(src.domain, "production_outcome", src.outcome_id);
  const disputed = src.observation_state === "disputed";
  const node = makeNodeShell({
    node_id,
    node_type: "production_outcome",
    domain: src.domain,
    revision: "1",
    summary: src.summary ?? null,
    identity: {
      outcome_id: src.outcome_id,
      outcome_kind: src.outcome_kind ?? null,
      observation_state: src.observation_state ?? null,
    },
    producer,
  });

  for (const attr of src.attribution) {
    if (!attr.target_id?.trim() || isPlaceholderIdentity(attr.target_id)) {
      diagnostics.push({
        code: "missing_attribution_target",
        message: "attribution target_id missing; not inventing",
        ref: attr.target_type,
      });
      continue;
    }

    let targetNodeId: string | null = null;
    if (attr.target_type === "run") {
      const run = graphNodes.find(
        (n) => n.node_type === "run" && n.identity?.run_id === attr.target_id,
      );
      targetNodeId = run?.node_id ?? null;
      if (!targetNodeId) {
        diagnostics.push({
          code: "unresolved_run_attribution",
          message: "outcome run attribution not resolvable",
          ref: attr.target_id,
        });
        // Do not fabricate; optional missing diagnostic edge not written without endpoints
        continue;
      }
    } else if (attr.target_type === "commit") {
      const sha = normalizeFullSha(attr.target_id);
      if (!sha) {
        diagnostics.push({
          code: "invalid_commit_attribution",
          message: "commit attribution must be full SHA",
          ref: attr.target_id,
        });
        continue;
      }
      const commit = graphNodes.find(
        (n) => n.node_type === "commit" && n.identity?.sha === sha,
      );
      targetNodeId = commit?.node_id ?? makeDomainNodeId(src.domain, "commit", sha);
      // If commit node not in graph yet, skip edge (caller should project commits first)
      if (!commit) {
        diagnostics.push({
          code: "unresolved_commit_attribution",
          message: "commit node not in graph for attribution",
          ref: sha,
        });
        continue;
      }
    } else if (attr.target_type === "component") {
      const comp = resolveComponentId(src.domain, attr.target_id);
      let cnode = graphNodes.find((n) => n.node_id === comp.node_id);
      if (!cnode) {
        // Project component node for shared identity vocabulary
        cnode = makeComponentNode(src.domain, attr.target_id, { producer });
        // will be added below
        graphNodes = [...graphNodes, cnode];
      }
      targetNodeId = cnode.node_id;
    } else if (attr.target_type === "pr") {
      const prNode = graphNodes.find(
        (n) => n.node_type === "pr" && String(n.identity?.pr) === String(attr.target_id),
      );
      targetNodeId = prNode?.node_id ?? null;
      if (!targetNodeId) {
        diagnostics.push({
          code: "unresolved_pr_attribution",
          message: "pr attribution not resolvable",
          ref: String(attr.target_id),
        });
        continue;
      }
    } else {
      diagnostics.push({
        code: "unresolved_attribution_target",
        message: `attribution target_type ${attr.target_type} not linked`,
        ref: attr.target_id,
      });
      continue;
    }

    const link_state = disputed || attr.disputed ? "disputed" : "active";
    edges.push(
      makeEdgeShell({
        edge_id: edgeId(
          src.domain,
          "outcome_of",
          node_id,
          targetNodeId!,
          attr.target_type,
        ),
        source_id: node_id,
        target_id: targetNodeId!,
        relationship: "outcome_of",
        revision: "1",
        method: attr.method,
        authority: attr.authority,
        producer,
        link_state,
      }),
    );
  }

  // Collect any component nodes we synthesized
  const extraNodes: LineageNode[] = [];
  for (const attr of src.attribution) {
    if (attr.target_type === "component" && attr.target_id?.trim()) {
      const comp = resolveComponentId(src.domain, attr.target_id);
      if (!graphNodes.some((n) => n.node_id === comp.node_id) && !extraNodes.some((n) => n.node_id === comp.node_id)) {
        extraNodes.push(makeComponentNode(src.domain, attr.target_id, { producer }));
      }
    }
  }

  // Fix: when we resolved component via graphNodes mutation, include those
  const componentNodesFromEdges: LineageNode[] = [];
  for (const attr of src.attribution) {
    if (attr.target_type !== "component" || !attr.target_id?.trim()) continue;
    const comp = resolveComponentId(src.domain, attr.target_id);
    componentNodesFromEdges.push(makeComponentNode(src.domain, attr.target_id, { producer }));
  }

  // Dedupe component nodes
  const byId = new Map<string, LineageNode>();
  byId.set(node.node_id, node);
  for (const n of componentNodesFromEdges) byId.set(n.node_id, n);

  return {
    nodes: [...byId.values()],
    edges,
    diagnostics,
  };
}

export function projectDecision(src: DecisionSource, producer?: string): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  if (!src.decision_id?.trim() || isPlaceholderIdentity(src.decision_id)) {
    diagnostics.push({ code: "missing_decision_id", message: "decision_id missing" });
    return { nodes: [], edges: [], diagnostics };
  }
  const node_id = makeDomainNodeId(src.domain, "decision", src.decision_id);
  // Never store raw model reasoning — summary only, redacted/bounded
  const node = makeNodeShell({
    node_id,
    node_type: "decision",
    domain: src.domain,
    revision: "1",
    summary: src.summary != null ? redactFreeText(src.summary, 300) : null,
    identity: { decision_id: src.decision_id },
    decision_status: src.status,
    producer: producer ?? src.producer ?? "lineage.ingest.decision",
  });
  return { nodes: [node], edges: [], diagnostics };
}

export function projectPolicyEvent(src: PolicyEventSource, graphNodes: readonly LineageNode[]): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  const edges: LineageEdge[] = [];
  if (!src.event_id?.trim()) {
    diagnostics.push({ code: "missing_policy_event_id", message: "event_id required" });
    return { nodes: [], edges: [], diagnostics };
  }
  const node_id = makeDomainNodeId(src.domain, "policy_event", src.event_id);
  const node = makeNodeShell({
    node_id,
    node_type: "policy_event",
    domain: src.domain,
    revision: src.policy_hash ?? "1",
    content_hash: src.policy_hash ?? null,
    summary: src.summary ?? null,
    identity: {
      event_id: src.event_id,
      policy_hash: src.policy_hash ?? null,
      affects_run_id: src.affects_run_id ?? null,
    },
    producer: "lineage.ingest.policy_event",
  });

  // Mark dependent maps_evidence/verifies edges as stale conceptually — emit invalidates edges to verification nodes of that run
  if (src.affects_run_id) {
    for (const n of graphNodes) {
      if (n.node_type !== "verification") continue;
      if (n.identity?.run_id === src.affects_run_id) {
        edges.push(
          makeEdgeShell({
            edge_id: edgeId(src.domain, "invalidates", node_id, n.node_id),
            source_id: node_id,
            target_id: n.node_id,
            relationship: "invalidates",
            revision: src.policy_hash ?? "1",
            method: "direct",
            authority: "observed",
            producer: "lineage.ingest.policy_event",
            reason_codes: ["policy_event_invalidated"],
          }),
        );
        edges.push(
          makeEdgeShell({
            edge_id: edgeId(src.domain, "affected_by_policy", n.node_id, node_id),
            source_id: n.node_id,
            target_id: node_id,
            relationship: "affected_by_policy",
            revision: src.policy_hash ?? "1",
            method: "direct",
            authority: "observed",
            producer: "lineage.ingest.policy_event",
            link_state: "stale",
            reason_codes: ["policy_event_invalidated"],
          }),
        );
      }
    }
  }

  return { nodes: [node], edges, diagnostics };
}

export function projectOverrideEvent(src: OverrideEventSource): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  if (!src.event_id?.trim()) {
    diagnostics.push({ code: "missing_override_event_id", message: "event_id required" });
    return { nodes: [], edges: [], diagnostics };
  }
  const node_id = makeDomainNodeId(src.domain, "override_event", src.event_id);
  const node = makeNodeShell({
    node_id,
    node_type: "override_event",
    domain: src.domain,
    revision: "1",
    summary: src.summary ?? null,
    identity: {
      event_id: src.event_id,
      run_id: src.run_id ?? null,
      finding_key: src.finding_key ?? null,
    },
    producer: "lineage.ingest.override_event",
  });
  // Override does not grant product authority — node only
  return { nodes: [node], edges: [], diagnostics };
}

/**
 * Full ingest pass: project all provided sources into a partial graph.
 * Does not invent missing identities. Empty outcome list is non-fatal.
 */
export function ingestLineageArtifacts(input: LineageIngestInput): IngestResult {
  const diagnostics: IngestDiagnostic[] = [];
  const nodes: LineageNode[] = [...(input.existing_nodes ?? [])];
  const edges: LineageEdge[] = [];
  const producer = input.producer ?? "lineage.ingest";
  const observed_at = (input.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");

  const merge = (r: IngestResult) => {
    diagnostics.push(...r.diagnostics);
    for (const n of r.nodes) {
      const idx = nodes.findIndex((x) => x.node_id === n.node_id);
      if (idx >= 0) nodes[idx] = n;
      else nodes.push(n);
    }
    edges.push(...r.edges);
  };

  for (const i of input.intents ?? []) merge(projectIntent(i, producer));
  for (const r of input.requirements ?? []) merge(projectRequirement(r, producer));
  for (const o of input.objectives ?? []) {
    merge(projectObjective(o, { producer, observed_at, existing: nodes }));
  }
  for (const r of input.runs ?? []) merge(projectRun(r, producer));
  for (const p of input.prs ?? []) merge(projectPr(p, producer));
  for (const c of input.commits ?? []) merge(projectCommit(c, nodes, producer));
  for (const v of input.verifications ?? []) merge(projectVerification(v, nodes, producer));

  if (!input.outcomes || input.outcomes.length === 0) {
    diagnostics.push({
      code: "empty_outcome_store",
      message: "no production outcomes provided; continuing with partial graph",
    });
  } else {
    for (const o of input.outcomes) merge(projectOutcome(o, nodes, producer));
  }

  for (const d of input.decisions ?? []) merge(projectDecision(d, producer));
  for (const p of input.policy_events ?? []) merge(projectPolicyEvent(p, nodes));
  for (const o of input.override_events ?? []) merge(projectOverrideEvent(o));

  // Link intent → requirement → objective decomposes when single intent/req present
  const intents = nodes.filter((n) => n.node_type === "intent_outcome");
  const reqs = nodes.filter((n) => n.node_type === "requirement");
  const objectives = nodes.filter((n) => n.node_type === "objective");
  const runs = nodes.filter((n) => n.node_type === "run");

  for (const intent of intents) {
    for (const req of reqs) {
      if (req.domain !== intent.domain) continue;
      edges.push(
        makeEdgeShell({
          edge_id: edgeId(intent.domain, "decomposes_to", intent.node_id, req.node_id),
          source_id: intent.node_id,
          target_id: req.node_id,
          relationship: "decomposes_to",
          revision: "1",
          method: "direct",
          authority: "observed",
          producer,
        }),
      );
    }
  }
  for (const req of reqs) {
    for (const obj of objectives) {
      if (obj.domain !== req.domain) continue;
      edges.push(
        makeEdgeShell({
          edge_id: edgeId(req.domain, "decomposes_to", req.node_id, obj.node_id),
          source_id: req.node_id,
          target_id: obj.node_id,
          relationship: "decomposes_to",
          revision: obj.revision,
          method: "direct",
          authority: "observed",
          producer,
        }),
      );
      edges.push(
        makeEdgeShell({
          edge_id: edgeId(req.domain, "derived_from", obj.node_id, req.node_id),
          source_id: obj.node_id,
          target_id: req.node_id,
          relationship: "derived_from",
          revision: obj.revision,
          method: "direct",
          authority: "observed",
          producer,
        }),
      );
    }
  }
  for (const obj of objectives) {
    for (const run of runs) {
      if (run.domain !== obj.domain) continue;
      edges.push(
        makeEdgeShell({
          edge_id: edgeId(obj.domain, "implements", run.node_id, obj.node_id),
          source_id: run.node_id,
          target_id: obj.node_id,
          relationship: "implements",
          revision: "1",
          method: "direct",
          authority: "inferred",
          producer,
        }),
      );
    }
  }

  // Dedupe edges by edge_id
  const edgeById = new Map<string, LineageEdge>();
  for (const e of edges) edgeById.set(e.edge_id, e);

  // Return only newly projected + existing? Spec wants connected graph — return all nodes we hold
  // Prefer returning only nodes from this ingest domain that we know about; keep full set.
  return {
    nodes: [...nodes],
    edges: [...edgeById.values()],
    diagnostics,
  };
}

export { contentHash };
