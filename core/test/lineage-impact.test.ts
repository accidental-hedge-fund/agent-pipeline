import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestLineageArtifacts } from "../scripts/lineage/ingest.ts";
import {
  computeForwardImpact,
  computeBackwardProposals,
  applyLineageProposal,
  evaluateLineageCompletenessGate,
  formatImpactReportHuman,
} from "../scripts/lineage/impact.ts";

const D = "agent-pipeline";
const SHA = "c".repeat(40);

function chainGraph() {
  return ingestLineageArtifacts({
    domain: D,
    intents: [{ domain: D, intent_id: "intent-1", issue: 1 }],
    requirements: [
      {
        domain: D,
        path: "openspec/specs/foo/spec.md",
        content_hash: "reqH1",
        summary: "requirement v1",
      },
    ],
    objectives: [
      { domain: D, objective_id: "obj-a", content_hash: "objHa" },
      { domain: D, objective_id: "obj-b", content_hash: "objHb" },
    ],
    runs: [{ domain: D, run_id: "run-1", issue: 1 }],
    commits: [{ domain: D, sha: SHA, pipeline_run_trailer: "run-1" }],
    verifications: [
      {
        domain: D,
        verification_id: "v1",
        objective_id: "obj-a",
        run_id: "run-1",
        mapped_identity: {
          candidate_sha: SHA,
          policy_hash: "p1",
          verifier_fingerprint: "vf",
          run_id: "run-1",
        },
      },
    ],
    outcomes: [
      {
        domain: D,
        outcome_id: "github:reversion:1",
        outcome_kind: "reversion",
        observation_state: "observed",
        attribution: [
          {
            target_type: "run",
            target_id: "run-1",
            method: "trailer",
            authority: "observed",
          },
        ],
      },
    ],
  });
}

test("requirement revision marks downstream objectives stale in impact report", () => {
  const g = chainGraph();
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  const report = computeForwardImpact(g, {
    upstream_node_id: req.node_id,
    prior_content_hash: "reqH1",
    new_content_hash: "reqH2",
    new_revision: "reqH2",
    reason: "upstream_requirement_revised",
  });
  const objAffected = report.affected.filter((a) => a.node_type === "objective");
  assert.ok(objAffected.length >= 2, `expected 2 objectives, got ${objAffected.length}: ${JSON.stringify(report.affected)}`);
  assert.ok(report.drift_reason_codes.includes("upstream_requirement_revised"));
  const human = formatImpactReportHuman(report);
  assert.ok(human.includes("obj-a") || human.includes("objective"));
  assert.ok(human.includes("upstream_requirement_revised"));
});

test("forward pass does not require network or model", () => {
  const g = chainGraph();
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  const report = computeForwardImpact(g, { upstream_node_id: req.node_id });
  assert.equal(report.type, "lineage_forward_impact");
  assert.ok(Array.isArray(report.affected));
});

test("outcome-driven proposal is non-applied", () => {
  const g = chainGraph();
  const outcome = g.nodes.find((n) => n.node_type === "production_outcome")!;
  const result = computeBackwardProposals(g, { evidence_node_id: outcome.node_id });
  assert.ok(result.proposals.length >= 1);
  const p = result.proposals[0];
  assert.equal(p.authority_status, "proposal");
  assert.ok(p.citing_evidence_node_ids.includes(outcome.node_id));
  assert.ok(p.target_upstream_node_ids.length >= 1);
  // Authoritative requirement content unchanged — we only emit proposals
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  assert.equal(req.content_hash, "reqH1");
});

test("agent apply without approval is refused", () => {
  const g = chainGraph();
  const outcome = g.nodes.find((n) => n.node_type === "production_outcome")!;
  const { proposals } = computeBackwardProposals(g, { evidence_node_id: outcome.node_id });
  const applied = applyLineageProposal(proposals[0], null);
  assert.equal(applied.ok, false);
  assert.equal(applied.authority_status, "refused");
  assert.equal(applied.diagnostic?.code, "unauthorized_upstream_mutation");
  assert.equal(applied.grants_merge_authority, false);
});

test("approved apply records decision provenance", () => {
  const g = chainGraph();
  const outcome = g.nodes.find((n) => n.node_type === "production_outcome")!;
  const { proposals } = computeBackwardProposals(g, { evidence_node_id: outcome.node_id });
  const applied = applyLineageProposal(proposals[0], {
    authority: "human",
    actor_id: "alice",
    approved_at: "2026-08-14T00:00:00Z",
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.authority_status, "applied");
  assert.equal(applied.nodes[0].node_type, "decision");
  assert.equal(applied.nodes[0].decision_status, "answered");
  assert.equal(applied.grants_merge_authority, false);
});

test("default-off completeness gate does not block", () => {
  const g = chainGraph();
  // Strip verifies to simulate incomplete lineage
  const incomplete = {
    nodes: g.nodes,
    edges: g.edges.filter((e) => e.relationship !== "verifies"),
  };
  const gate = evaluateLineageCompletenessGate(incomplete, null);
  assert.equal(gate.ok, true);
  assert.equal(gate.blocked, false);
});

test("armed gate fails on missing required observed verifies", () => {
  const g = chainGraph();
  const incomplete = {
    nodes: g.nodes,
    edges: g.edges.filter((e) => e.relationship !== "verifies"),
  };
  const gate = evaluateLineageCompletenessGate(incomplete, {
    enabled: true,
    required_relationships: ["verifies"],
    require_observed: true,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked, true);
  assert.ok(gate.failures.some((f) => f.reason_code === "missing_downstream_link"));
  assert.ok(gate.failures.some((f) => f.objective_id === "obj-a" || f.objective_id === "obj-b"));
});

test("armed gate passes when observed verifies present for each objective", () => {
  const g = chainGraph();
  // Only obj-a has verifies — obj-b fails
  const gate = evaluateLineageCompletenessGate(g, {
    enabled: true,
    required_relationships: ["verifies"],
  });
  assert.equal(gate.blocked, true);
  // Add verifies for obj-b
  const objB = g.nodes.find((n) => n.identity?.objective_id === "obj-b")!;
  const vNode = g.nodes.find((n) => n.node_type === "verification")!;
  const edges = [
    ...g.edges,
    {
      ...g.edges.find((e) => e.relationship === "verifies")!,
      edge_id: `${D}::edge:v-b`,
      source_id: objB.node_id,
      target_id: vNode.node_id,
    },
  ];
  const gate2 = evaluateLineageCompletenessGate({ nodes: g.nodes, edges }, { enabled: true });
  assert.equal(gate2.ok, true);
});
