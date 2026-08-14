import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEdgeShell, makeNodeShell } from "../scripts/lineage/schema.ts";
import {
  validateGraphIntegrity,
  markEdgesStale,
  findNodeByIdentity,
} from "../scripts/lineage/graph.ts";

const D = "agent-pipeline";

test("edge to unknown node fails integrity check", () => {
  const n = makeNodeShell({
    node_id: `${D}::run:r1`,
    node_type: "run",
    domain: D,
    revision: "1",
    identity: { run_id: "r1" },
  });
  const e = makeEdgeShell({
    edge_id: `${D}::edge:e1`,
    source_id: n.node_id,
    target_id: `${D}::commit:missing`,
    relationship: "delivered_by",
    revision: "1",
  });
  const r = validateGraphIntegrity({ nodes: [n], edges: [e] });
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === "unknown_target"));
});

test("unchanged content keeps stable node identity via find", () => {
  const n = makeNodeShell({
    node_id: `${D}::objective:obj@h1`,
    node_type: "objective",
    domain: D,
    revision: "h1",
    content_hash: "h1",
    identity: { objective_id: "obj-login-retry", content_hash: "h1" },
  });
  const found = findNodeByIdentity([n], "objective", D, "objective_id", "obj-login-retry");
  assert.equal(found?.node_id, n.node_id);
  assert.equal(found?.content_hash, "h1");
});

test("markEdgesStale sets link_state and reason code", () => {
  const e = makeEdgeShell({
    edge_id: `${D}::edge:e1`,
    source_id: `${D}::a:1`,
    target_id: `${D}::b:1`,
    relationship: "verifies",
    revision: "1",
  });
  const next = markEdgesStale([e], () => true, "objective_content_hash_changed");
  assert.equal(next[0].link_state, "stale");
  assert.ok(next[0].reason_codes?.includes("objective_content_hash_changed"));
});

test("fabricated run id on run node fails integrity", () => {
  const n = makeNodeShell({
    node_id: `${D}::run:placeholder`,
    node_type: "run",
    domain: D,
    revision: "1",
    identity: { run_id: "placeholder" },
  });
  // node_id itself may also trip placeholder on validateLineageNode, but integrity checks identity
  const r = validateGraphIntegrity({ nodes: [n], edges: [] });
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === "fabricated_run_id"));
});
