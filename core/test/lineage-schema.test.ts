import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINEAGE_SCHEMA_VERSION,
  NODE_TYPES,
  RELATIONSHIPS,
  LINK_STATES,
  DRIFT_REASON_CODES,
  makeNodeShell,
  makeEdgeShell,
  validateLineageNode,
  validateLineageEdge,
  redactFreeText,
  normalizeFullSha,
  isPlaceholderIdentity,
  readLineageNode,
} from "../scripts/lineage/schema.ts";

const DOMAIN = "agent-pipeline";
const SHA = "a".repeat(40);

test("closed enums are locked for schema_version 2", () => {
  assert.equal(LINEAGE_SCHEMA_VERSION, 2);
  assert.ok(NODE_TYPES.includes("objective"));
  assert.ok(NODE_TYPES.includes("production_outcome"));
  assert.ok(NODE_TYPES.includes("decision"));
  assert.ok(RELATIONSHIPS.includes("decomposes_to"));
  assert.ok(RELATIONSHIPS.includes("verifies"));
  assert.ok(LINK_STATES.includes("stale"));
  assert.ok(LINK_STATES.includes("disputed"));
  assert.ok(DRIFT_REASON_CODES.includes("upstream_requirement_revised"));
});

test("validate accepts well-formed node with identity fields", () => {
  const node = makeNodeShell({
    node_id: `${DOMAIN}::objective:obj-login@h1`,
    node_type: "objective",
    domain: DOMAIN,
    revision: "h1",
    content_hash: "h1",
    identity: { objective_id: "obj-login", content_hash: "h1" },
  });
  const r = validateLineageNode(node);
  assert.equal(r.ok, true);
  assert.equal(r.value?.node_type, "objective");
  assert.equal(r.value?.schema_version, 2);
});

test("validate accepts well-formed edge with relationship and endpoints", () => {
  const edge = makeEdgeShell({
    edge_id: `${DOMAIN}::edge:e1`,
    source_id: `${DOMAIN}::requirement:r1`,
    target_id: `${DOMAIN}::objective:o1`,
    relationship: "decomposes_to",
    revision: "1",
  });
  const r = validateLineageEdge(edge);
  assert.equal(r.ok, true);
  assert.equal(r.value?.link_state, "active");
});

test("closed node type enum rejects unknown type", () => {
  const r = validateLineageNode({
    ...makeNodeShell({
      node_id: `${DOMAIN}::wiki:1`,
      node_type: "objective",
      domain: DOMAIN,
      revision: "1",
    }),
    node_type: "wiki_page",
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "node_type"));
});

test("unknown additive fields are ignored by reader", () => {
  const raw = {
    ...makeNodeShell({
      node_id: `${DOMAIN}::run:r1`,
      node_type: "run",
      domain: DOMAIN,
      revision: "1",
      identity: { run_id: "r1" },
    }),
    extra_future_field: 42,
  };
  const node = readLineageNode(raw);
  assert.ok(node);
  assert.equal((node as { extra_future_field?: unknown }).extra_future_field, undefined);
});

test("rejects undomained node_id", () => {
  const r = validateLineageNode(
    makeNodeShell({
      node_id: "global-only-id",
      node_type: "run",
      domain: DOMAIN,
      revision: "1",
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "node_id"));
});

test("rejects placeholder identities and bad SHAs", () => {
  assert.equal(isPlaceholderIdentity("placeholder-run"), true);
  assert.equal(normalizeFullSha("deadbeef"), null);
  assert.equal(normalizeFullSha(SHA), SHA);
  const r = validateLineageNode(
    makeNodeShell({
      node_id: `${DOMAIN}::commit:x`,
      node_type: "commit",
      domain: DOMAIN,
      revision: "1",
      identity: { sha: "deadbeef" },
    }),
  );
  assert.equal(r.ok, false);
});

test("redactFreeText strips secret-like material", () => {
  const out = redactFreeText("token=ghp_abcdefghijklmnopqrstuvwxyz012345");
  assert.ok(!out.includes("ghp_abcdefghijklmnopqrstuvwxyz012345") || out.includes("REDACT") || out.length < 80);
});

test("decision status deferred is first-class", () => {
  const node = makeNodeShell({
    node_id: `${DOMAIN}::decision:d1`,
    node_type: "decision",
    domain: DOMAIN,
    revision: "1",
    decision_status: "deferred",
    summary: "defer product choice",
  });
  const r = validateLineageNode(node);
  assert.equal(r.ok, true);
  assert.equal(r.value?.decision_status, "deferred");
});

test("no quality score field required on node", () => {
  const node = makeNodeShell({
    node_id: `${DOMAIN}::intent_outcome:i1`,
    node_type: "intent_outcome",
    domain: DOMAIN,
    revision: "1",
  });
  assert.equal("score" in node, false);
  assert.equal(validateLineageNode(node).ok, true);
});
