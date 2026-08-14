import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestLineageArtifacts } from "../scripts/lineage/ingest.ts";
import { validateGraphIntegrity } from "../scripts/lineage/graph.ts";
import {
  computeForwardImpact,
  computeBackwardProposals,
  applyLineageProposal,
} from "../scripts/lineage/impact.ts";
import { buildLineageExportSection } from "../scripts/lineage/export.ts";
import { contentHash } from "../scripts/lineage/identity.ts";

const D = "agent-pipeline";
const SHA = "e".repeat(40);
const RUN_ID = "599/2026-08-14T02:58:43Z";
const OBJ_ID = "obj-login-retry";
const OUTCOME_ID = "github:reversion:pr-42";

/**
 * End-to-end fixture: intent → requirement → #575 objective → run/commit →
 * verification → #576 outcome, then forward impact + backward proposal.
 */
test("e2e fixture chain supports forward impact and backward proposal", () => {
  const reqHash1 = contentHash("requirement body v1");
  const objHash1 = contentHash("objective contract v1");

  const g = ingestLineageArtifacts({
    domain: D,
    intents: [
      {
        domain: D,
        intent_id: "intent-bidirectional-lineage",
        issue: 599,
        summary: "Bidirectional intent lineage",
      },
    ],
    requirements: [
      {
        domain: D,
        path: "openspec/specs/intent-lineage-graph/spec.md",
        content_hash: reqHash1,
        issue: 599,
      },
    ],
    objectives: [
      {
        domain: D,
        objective_id: OBJ_ID,
        content_hash: objHash1,
        summary: "Stable objective_id + content hash",
      },
    ],
    runs: [{ domain: D, run_id: RUN_ID, issue: 599, pr: 42 }],
    commits: [
      {
        domain: D,
        sha: SHA,
        pipeline_run_trailer: RUN_ID,
        pr: 42,
      },
    ],
    prs: [{ domain: D, pr: 42, title: "feat: lineage #599" }],
    verifications: [
      {
        domain: D,
        verification_id: "shipcheck-1",
        kind: "shipcheck",
        objective_id: OBJ_ID,
        run_id: RUN_ID,
        mapped_identity: {
          candidate_sha: SHA,
          policy_hash: "policy-abc",
          verifier_fingerprint: "verifier-xyz",
          run_id: RUN_ID,
        },
      },
    ],
    outcomes: [
      {
        domain: D,
        outcome_id: OUTCOME_ID,
        outcome_kind: "reversion",
        observation_state: "observed",
        summary: "PR reverted after deploy",
        attribution: [
          {
            target_type: "run",
            target_id: RUN_ID,
            method: "trailer",
            authority: "observed",
          },
          {
            target_type: "commit",
            target_id: SHA,
            method: "direct",
            authority: "observed",
          },
          {
            target_type: "component",
            target_id: "core/scripts",
            method: "heuristic",
            authority: "inferred",
          },
        ],
      },
    ],
    decisions: [
      {
        domain: D,
        decision_id: "defer-ui",
        status: "deferred",
        summary: "No hosted UI in v1",
      },
    ],
  });

  const integrity = validateGraphIntegrity({ nodes: g.nodes, edges: g.edges });
  assert.equal(integrity.ok, true, JSON.stringify(integrity.diagnostics, null, 2));

  // Composition: same objective_id / outcome_id as source stores
  const obj = g.nodes.find((n) => n.node_type === "objective")!;
  assert.equal(obj.identity?.objective_id, OBJ_ID);
  assert.equal(obj.content_hash, objHash1);
  const outcome = g.nodes.find((n) => n.node_type === "production_outcome")!;
  assert.equal(outcome.identity?.outcome_id, OUTCOME_ID);

  // evidence_subject dimensions on verifies edge
  const verifies = g.edges.find((e) => e.relationship === "verifies")!;
  assert.ok(verifies);
  assert.equal(verifies.mapped_identity?.candidate_sha, SHA);
  assert.equal(verifies.mapped_identity?.policy_hash, "policy-abc");
  assert.equal(verifies.mapped_identity?.verifier_fingerprint, "verifier-xyz");
  assert.equal(verifies.mapped_identity?.run_id, RUN_ID);

  // Many-to-many outcomes: three attribution edges
  const outcomeEdges = g.edges.filter(
    (e) => e.source_id === outcome.node_id && e.relationship === "outcome_of",
  );
  assert.ok(outcomeEdges.length >= 2);

  // Forward impact after upstream requirement revision
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  const reqHash2 = contentHash("requirement body v2");
  const impact = computeForwardImpact(g, {
    upstream_node_id: req.node_id,
    prior_content_hash: reqHash1,
    new_content_hash: reqHash2,
    new_revision: reqHash2,
    reason: "upstream_requirement_revised",
  });
  assert.ok(impact.affected.some((a) => a.node_type === "objective"));
  assert.ok(
    impact.affected.some(
      (a) => a.node_id === obj.node_id || a.drift_reason_codes.length > 0,
    ),
  );
  assert.ok(
    impact.affected.some((a) => a.node_id === outcome.node_id),
    "forward impact must reach linked production_outcome via reverse outcome_of",
  );
  assert.ok(impact.drift_reason_codes.includes("upstream_requirement_revised"));

  // Backward proposal from reversion outcome
  const proposals = computeBackwardProposals(g, { evidence_node_id: outcome.node_id });
  assert.ok(proposals.proposals.length >= 1);
  const prop = proposals.proposals[0];
  assert.equal(prop.authority_status, "proposal");
  assert.ok(prop.citing_evidence_node_ids.includes(outcome.node_id));
  assert.ok(prop.target_upstream_node_ids.length >= 1);

  // Unauthorized apply refused (missing approval and missing verifier)
  const refused = applyLineageProposal(prop, undefined);
  assert.equal(refused.ok, false);
  assert.equal(refused.diagnostic?.code, "unauthorized_upstream_mutation");
  const forged = applyLineageProposal(
    prop,
    { authority: "human", actor_id: "someone", approved_at: "2026-08-14T00:00:00Z" },
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.diagnostic?.code, "unauthorized_upstream_mutation");

  // Export slice
  const section = buildLineageExportSection({
    nodes: g.nodes,
    edges: g.edges,
    run_id: RUN_ID,
    impact,
    proposals: proposals.proposals,
  });
  assert.ok(section.node_count > 0);
  assert.ok(section.objective_ids.includes(OBJ_ID));
  assert.ok(section.drift_reason_codes.includes("upstream_requirement_revised"));
  assert.ok((section.proposal_refs?.length ?? 0) >= 1);
});

test("one intent decomposes to multiple objectives and runs", () => {
  const g = ingestLineageArtifacts({
    domain: D,
    intents: [{ domain: D, intent_id: "intent-multi" }],
    objectives: [
      { domain: D, objective_id: "o1", content_hash: "h1" },
      { domain: D, objective_id: "o2", content_hash: "h2" },
    ],
    runs: [
      { domain: D, run_id: "run-a" },
      { domain: D, run_id: "run-b" },
    ],
    requirements: [
      { domain: D, path: "openspec/specs/x/spec.md", content_hash: "rh" },
    ],
  });
  const intent = g.nodes.find((n) => n.node_type === "intent_outcome")!;
  const decomposes = g.edges.filter(
    (e) => e.relationship === "decomposes_to" && e.source_id === intent.node_id,
  );
  // intent → requirement
  assert.ok(decomposes.length >= 1);
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  const toObj = g.edges.filter(
    (e) => e.relationship === "decomposes_to" && e.source_id === req.node_id,
  );
  assert.ok(toObj.length >= 2);
});
