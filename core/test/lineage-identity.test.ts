import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveComponentId,
  resolveCapabilityId,
  makeDomainNodeId,
  componentIdsCollideAcrossDomains,
  attachOwnership,
  makeComponentNode,
  validateOwnedByComponentId,
  contentHash,
} from "../scripts/lineage/identity.ts";
import { makeEdgeShell, makeNodeShell } from "../scripts/lineage/schema.ts";
import { validateGraphIntegrity } from "../scripts/lineage/graph.ts";

test("domain-scoped component id is required for cross-repo use", () => {
  const a = resolveComponentId("repo-a", "core/scripts");
  const b = resolveComponentId("repo-b", "core/scripts");
  assert.notEqual(a.component_id, b.component_id);
  assert.ok(a.component_id.startsWith("repo-a::"));
  assert.ok(b.component_id.startsWith("repo-b::"));
  assert.equal(componentIdsCollideAcrossDomains("repo-a", "repo-b", "core/scripts"), false);
});

test("unchanged boundary keeps stable id", () => {
  const first = resolveComponentId("agent-pipeline", "core/scripts");
  const second = resolveComponentId("agent-pipeline", "core/scripts");
  assert.equal(first.component_id, second.component_id);
  assert.equal(first.node_id, second.node_id);
});

test("empty component id is invalid for ownership edges", () => {
  assert.equal(validateOwnedByComponentId(""), "empty_component_id");
  assert.equal(validateOwnedByComponentId(null), "empty_component_id");
  const comp = makeComponentNode("d", "mod", { ownership: { team_key: "platform" } });
  const req = makeNodeShell({
    node_id: "d::requirement:r1",
    node_type: "requirement",
    domain: "d",
    revision: "1",
  });
  // empty component_id on target
  const badComp = { ...comp, component_id: "" };
  const edge = makeEdgeShell({
    edge_id: "d::edge:owned",
    source_id: req.node_id,
    target_id: badComp.node_id,
    relationship: "owned_by",
    revision: "1",
  });
  const integrity = validateGraphIntegrity({ nodes: [req, badComp], edges: [edge] });
  assert.equal(integrity.ok, false);
  assert.ok(integrity.diagnostics.some((d) => d.code === "empty_component_id"));
});

test("ownership metadata is attachable and not merge authority", () => {
  const node = makeComponentNode("d", "core/scripts");
  const owned = attachOwnership(node, { team_key: "platform", codeowners_path: "CODEOWNERS" });
  assert.equal(owned.ownership?.team_key, "platform");
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
  const literalSlash = makeDomainNodeId(
    "agent-pipeline",
    "requirement",
    "openspec/specs/a/b/spec.md@h1",
  );
  // a%2Fb (literal percent) must NOT equal a/b (encoded slash)
  assert.notEqual(literalPercent, slashPath);
  assert.notEqual(literalPercent, literalSlash);
  // literal percent is escaped as %25 (readable), while real slashes encode %2F
  assert.ok(literalPercent.includes("%252F"));
  // A literal a%2Fb path is distinct from a/b after encoding
  assert.notEqual(
    makeDomainNodeId("agent-pipeline", "requirement", "a%2Fb"),
    makeDomainNodeId("agent-pipeline", "requirement", "a/b"),
  );
});
