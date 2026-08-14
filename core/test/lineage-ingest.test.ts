import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingestLineageArtifacts,
  projectObjective,
  projectCommit,
  projectOutcome,
  projectRun,
} from "../scripts/lineage/ingest.ts";
import { validateGraphIntegrity } from "../scripts/lineage/graph.ts";

const D = "agent-pipeline";
const SHA = "b".repeat(40);

test("objective projection uses dossier identity and is stable on resume", () => {
  const a = projectObjective({
    domain: D,
    objective_id: "obj-login-retry",
    content_hash: "H1",
  });
  const b = projectObjective({
    domain: D,
    objective_id: "obj-login-retry",
    content_hash: "H1",
  });
  assert.equal(a.nodes[0].node_id, b.nodes[0].node_id);
  assert.equal(a.nodes[0].identity?.objective_id, "obj-login-retry");
  assert.equal(a.nodes[0].content_hash, "H1");
});

test("content change yields supersession edge not silent overwrite", () => {
  const first = projectObjective({
    domain: D,
    objective_id: "obj-login-retry",
    content_hash: "H1",
  });
  const second = projectObjective(
    {
      domain: D,
      objective_id: "obj-login-retry",
      content_hash: "H2",
      prior_content_hash: "H1",
    },
    { existing: first.nodes },
  );
  assert.notEqual(first.nodes[0].node_id, second.nodes[0].node_id);
  assert.ok(second.edges.some((e) => e.relationship === "supersedes"));
  assert.ok(second.edges[0].reason_codes?.includes("objective_content_hash_changed"));
});

test("missing run id is not fabricated", () => {
  const r = projectRun({ domain: D, run_id: "" });
  assert.equal(r.nodes.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === "missing_run_id"));
});

test("Pipeline-Run trailer join is observed", () => {
  const run = projectRun({ domain: D, run_id: "599/2026-08-14T02:58:43Z" });
  const commit = projectCommit(
    {
      domain: D,
      sha: SHA,
      pipeline_run_trailer: "599/2026-08-14T02:58:43Z",
    },
    run.nodes,
  );
  assert.equal(commit.edges.length, 1);
  assert.equal(commit.edges[0].provenance.method, "trailer");
  assert.equal(commit.edges[0].provenance.authority, "observed");
});

test("empty outcome store is non-fatal", () => {
  const result = ingestLineageArtifacts({
    domain: D,
    runs: [{ domain: D, run_id: "run-1" }],
    objectives: [{ domain: D, objective_id: "o1", content_hash: "h" }],
    outcomes: [],
  });
  assert.ok(result.nodes.some((n) => n.node_type === "run"));
  assert.ok(result.diagnostics.some((d) => d.code === "empty_outcome_store"));
});

test("observed run attribution becomes observed lineage edge", () => {
  const run = projectRun({ domain: D, run_id: "run-1" });
  const out = projectOutcome(
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
    run.nodes,
  );
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].provenance.authority, "observed");
  assert.equal(out.edges[0].relationship, "outcome_of");
});

test("disputed outcome remains disputed in lineage", () => {
  const run = projectRun({ domain: D, run_id: "run-1" });
  const out = projectOutcome(
    {
      domain: D,
      outcome_id: "oid-d",
      observation_state: "disputed",
      attribution: [
        {
          target_type: "run",
          target_id: "run-1",
          method: "heuristic",
          authority: "inferred",
          disputed: true,
        },
      ],
    },
    run.nodes,
  );
  assert.equal(out.edges[0].link_state, "disputed");
});

test("title similarity alone would be inferred — heuristic method on edge", () => {
  // Ingest does not invent title joins; callers pass authority=inferred
  const run = projectRun({ domain: D, run_id: "run-1" });
  const out = projectOutcome(
    {
      domain: D,
      outcome_id: "oid-i",
      attribution: [
        {
          target_type: "run",
          target_id: "run-1",
          method: "heuristic",
          authority: "inferred",
        },
      ],
    },
    run.nodes,
  );
  assert.equal(out.edges[0].provenance.authority, "inferred");
  assert.equal(out.edges[0].provenance.method, "heuristic");
});

test("OpenSpec path revision projects as requirement identity", () => {
  const result = ingestLineageArtifacts({
    domain: D,
    requirements: [
      {
        domain: D,
        path: "openspec/specs/foo/spec.md",
        content_hash: "abc123",
      },
    ],
  });
  const req = result.nodes.find((n) => n.node_type === "requirement");
  assert.ok(req);
  assert.equal(req!.identity?.path, "openspec/specs/foo/spec.md");
  assert.equal(req!.content_hash, "abc123");
});

test("fixture chain ingests with integrity", () => {
  const result = ingestLineageArtifacts({
    domain: D,
    intents: [{ domain: D, intent_id: "intent-599", issue: 599 }],
    requirements: [
      {
        domain: D,
        path: "openspec/specs/intent-lineage-graph/spec.md",
        content_hash: "reqH1",
      },
    ],
    objectives: [{ domain: D, objective_id: "obj-lineage", content_hash: "objH1" }],
    runs: [{ domain: D, run_id: "599/2026-08-14T02:58:43Z", issue: 599 }],
    commits: [
      {
        domain: D,
        sha: SHA,
        pipeline_run_trailer: "599/2026-08-14T02:58:43Z",
      },
    ],
    verifications: [
      {
        domain: D,
        verification_id: "verify-1",
        objective_id: "obj-lineage",
        run_id: "599/2026-08-14T02:58:43Z",
        mapped_identity: {
          candidate_sha: SHA,
          policy_hash: "pol1",
          verifier_fingerprint: "vf1",
          run_id: "599/2026-08-14T02:58:43Z",
        },
      },
    ],
    outcomes: [
      {
        domain: D,
        outcome_id: "github:delivery:1",
        outcome_kind: "delivery",
        observation_state: "observed",
        attribution: [
          {
            target_type: "run",
            target_id: "599/2026-08-14T02:58:43Z",
            method: "trailer",
            authority: "observed",
          },
          {
            target_type: "commit",
            target_id: SHA,
            method: "direct",
            authority: "observed",
          },
        ],
      },
    ],
  });
  const integrity = validateGraphIntegrity({ nodes: result.nodes, edges: result.edges });
  assert.equal(integrity.ok, true, JSON.stringify(integrity.diagnostics));
  assert.ok(result.nodes.some((n) => n.node_type === "objective"));
  assert.ok(result.edges.some((e) => e.relationship === "verifies"));
  const verifies = result.edges.find((e) => e.relationship === "verifies");
  assert.equal(verifies?.mapped_identity?.candidate_sha, SHA);
  assert.equal(verifies?.mapped_identity?.policy_hash, "pol1");
});
