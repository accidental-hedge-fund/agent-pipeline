import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentHash,
  encodeLocalId,
  makeDomainNodeId,
  migrateLineageIdentityV1ToV2,
  migrateV1NodeId,
  resolveCapabilityId,
  resolveComponentId,
} from "../scripts/lineage/identity.ts";
import { makeEdgeShell, makeNodeShell } from "../scripts/lineage/schema.ts";

test("domain-scoped component id is required for cross-repo use", () => {
  const id = resolveComponentId("agent-pipeline", "core");
  assert.equal(id.component_id, "agent-pipeline::component:core");
  assert.equal(id.node_id, id.component_id);
  assert.equal(id.domain, "agent-pipeline");
  assert.equal(id.local_key, "core");
});

test("unchanged boundary keeps stable id", () => {
  const a = resolveComponentId("d1", "a/b");
  const b = resolveComponentId("d1", "a/b");
  assert.deepEqual(a, b);
});

test("empty component id is invalid for ownership edges", () => {
  assert.throws(() => resolveComponentId("d1", "  "));
});

test("ownership metadata is attachable and not merge authority", () => {
  const owned = makeNodeShell({
    node_id: resolveComponentId("d2", "api").node_id,
    node_type: "component",
    domain: "d2",
    revision: "1",
    identity: { local_key: "api", component_id: "d2::component:api" },
    ownership: { team_key: "platform", attestation_route: "component-owner" },
    producer: "test",
    observed_at: "2026-08-14T00:00:00Z",
  });
  assert.equal((owned.ownership as { team_key?: string }).team_key, "platform");
  // Schema has no merge_authorized field — ownership alone is routing metadata
  assert.equal((owned.ownership as { merge_authorized?: boolean }).merge_authorized, undefined);
});

test("capability ids are domain-scoped", () => {
  const cap = resolveCapabilityId("d1", "ship-path");
  assert.equal(cap.capability_id, "d1::capability:ship-path");
});

test("content hash is stable for unchanged material", () => {
  assert.equal(contentHash("same"), contentHash("same"));
  assert.notEqual(contentHash("a"), contentHash("b"));
});

test("cross-domain issue numbers do not collide", () => {
  const a = makeDomainNodeId("domain-a", "intent_outcome", "issue-42");
  const b = makeDomainNodeId("domain-b", "intent_outcome", "issue-42");
  assert.notEqual(a, b);
});

test("path-derived node ids are collision-safe for slash vs underscore paths", () => {
  const withUnderscore = makeDomainNodeId(
    "agent-pipeline",
    "requirement",
    "openspec/specs/a_b/spec.md@h1",
  );
  const withSlash = makeDomainNodeId(
    "agent-pipeline",
    "requirement",
    "openspec/specs/a/b/spec.md@h1",
  );
  assert.notEqual(withUnderscore, withSlash);
  assert.ok(withUnderscore.includes("%2F"));
  assert.ok(withSlash.includes("%2F"));
  // Same path twice is stable
  assert.equal(
    makeDomainNodeId("agent-pipeline", "requirement", "openspec/specs/a/b/spec.md@h1"),
    withSlash,
  );
});

test("literal percent path cannot collide with a separator-encoded path (#599 b775d25c)", () => {
  const literalPercent = makeDomainNodeId(
    "agent-pipeline",
    "requirement",
    "openspec/specs/a%2Fb/spec.md@h1",
  );
  const slashPath = makeDomainNodeId(
    "agent-pipeline",
    "requirement",
    "openspec/specs/a/b/spec.md@h1",
  );
  assert.notEqual(literalPercent, slashPath);
  // literal percent is escaped as %25, and never left as %2F
  assert.ok(literalPercent.includes("%252F"));
  assert.ok(!literalPercent.includes("a%2Fb"));
  // Short forms are distinct too
  assert.notEqual(
    makeDomainNodeId("agent-pipeline", "requirement", "a%2Fb"),
    makeDomainNodeId("agent-pipeline", "requirement", "a/b"),
  );
});

test("v1 legacy node ids are deterministically migrated to v2 (#599 b775d25c)", () => {
  const domain = "agent-pipeline";
  const legacyLocal = "a%2Fb";
  const v1NodeId = `${domain}::requirement:${legacyLocal}`; // what v1 persisted
  const v2 = migrateV1NodeId(v1NodeId, domain, "requirement", legacyLocal);
  assert.equal(v2, `${domain}::requirement:a%252Fb`);
  // Already-v2 ids stay put (returns null = no migration needed)
  assert.equal(migrateV1NodeId(v2!, domain, "requirement", legacyLocal), null);
  // A plain path without percent never had legacy ambiguity
  assert.equal(
    migrateV1NodeId(`${domain}::requirement:a%2Fb`, domain, "requirement", "a/b"),
    null,
  );
});

test("migrateLineageIdentityV1ToV2 rewrites graph endpoints", () => {
  const domain = "agent-pipeline";
  const legacyId = `${domain}::requirement:a%2Fb`;
  const v2Id = `${domain}::requirement:a%252Fb`;
  const nodes = [
    makeNodeShell({
      node_id: legacyId,
      node_type: "requirement",
      domain,
      revision: "1",
      identity: { path: "a%2Fb" },
      producer: "test",
      observed: "2026-08-14T00:00:00Z",
    }),
  ];
  const edges = [
    makeEdgeShell({
      edge_id: `${domain}::edge:e1`,
      source_id: legacyId,
      target_id: `${domain}::run:r1`,
      relationship: "validates",
      method: "manual",
      authority: "observed",
      producer: "test",
      observed: "2026-08-14T00:00:00Z",
    }),
  ];
  const migrated = migrateLineageIdentityV1ToV2(nodes, edges);
  assert.equal(migrated.rewritten, 1);
  assert.equal(migrated.nodes[0].node_id, v2Id);
  assert.equal(migrated.edges[0].source_id, v2Id);
  assert.equal(migrated.edges[0].target_id, `${domain}::run:r1`);
});

test("encodeLocalId escapes percent before separators", () => {
  assert.equal(encodeLocalId("a/b"), "a%2Fb");
  assert.equal(encodeLocalId("a%2Fb"), "a%252Fb");
  assert.equal(encodeLocalId("a\\b"), "a%5Cb");
  assert.equal(encodeLocalId("a%5Cb"), "a%255Cb");
});