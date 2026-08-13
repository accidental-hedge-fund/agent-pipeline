// Drift guard for porcelain dirt sites (#1020).
// Ensures every production porcelain dirt gate is inventoried and shared-classifier
// sites actually reference classifyWorktreeDirt / productDirtyPaths / ENGINE set.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PORCELAIN_DIRT_DISPOSITIONS,
  PORCELAIN_DIRT_SITES,
  assertPorcelainDirtDispositionsClosed,
  diffPorcelainDirtInventory,
  discoverPorcelainDirtModules,
  isPorcelainDirtDisposition,
  porcelainDirtSiteForModule,
} from "../scripts/porcelain-dirt-sites.ts";
import {
  buildStageDiagnostic,
  projectStageDiagnostic,
} from "../scripts/stage-diagnostic.ts";

// ---------------------------------------------------------------------------
// Inventory closedness
// ---------------------------------------------------------------------------

test("porcelain dirt dispositions are closed and total over inventory rows", () => {
  assertPorcelainDirtDispositionsClosed();
  for (const site of PORCELAIN_DIRT_SITES) {
    assert.ok(
      isPorcelainDirtDisposition(site.disposition),
      `${site.site_id} disposition ${site.disposition}`,
    );
  }
  assert.deepEqual([...PORCELAIN_DIRT_DISPOSITIONS], [
    "uses-shared-classifier",
    "not-porcelain-dirt-gate",
    "explicit-exception",
  ]);
});

test("required dirt gates are inventoried with shared classifier", () => {
  const required = [
    "scripts/stages/pre-merge-openspec-archive.ts",
    "scripts/testgate.ts",
    "scripts/stages/format-gate.ts",
    "scripts/worktree-dirt.ts",
  ];
  for (const mod of required) {
    const row = porcelainDirtSiteForModule(mod);
    assert.ok(row, `missing inventory for ${mod}`);
    assert.equal(
      row!.disposition,
      "uses-shared-classifier",
      `${mod} must use shared classifier`,
    );
  }
});

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

test("porcelain dirt drift-guard: every discovered production module has an inventory row", () => {
  const discovered = discoverPorcelainDirtModules();
  assert.ok(
    discovered.length >= 4,
    `expected several porcelain-related modules, got ${discovered.length}: ${discovered.map((d) => d.module).join(", ")}`,
  );
  const { missing, orphans, undeclaredBypass, ok } = diffPorcelainDirtInventory(discovered);
  assert.equal(
    missing.length,
    0,
    `missing inventory for: ${missing.map((m) => m.module).join("; ")}`,
  );
  assert.equal(
    orphans.length,
    0,
    `orphan inventory rows (no production signal): ${orphans.map((o) => o.site_id).join("; ")}`,
  );
  assert.equal(
    undeclaredBypass.length,
    0,
    `uses-shared-classifier without shared classifier symbols: ${undeclaredBypass.map((u) => u.site_id).join("; ")}`,
  );
  assert.equal(ok, true);
});

test("porcelain dirt drift-guard bites when a site is missing from inventory", () => {
  const discovered = discoverPorcelainDirtModules();
  const fake = {
    module: "scripts/stages/fake-porcelain-dirt-gate.ts",
    site_id: "stages.fake-porcelain-dirt-gate",
    absPath: "/tmp/fake-porcelain-dirt-gate.ts",
  };
  const { missing, ok } = diffPorcelainDirtInventory([...discovered, fake]);
  assert.equal(ok, false);
  assert.ok(
    missing.some((m) => m.module === fake.module),
    "fake module must appear in missing",
  );
});

test("ad-hoc bypass of shared classifier fails closed in intent", () => {
  // uses-shared-classifier sites must still reference shared symbols in source.
  const sharedSites = PORCELAIN_DIRT_SITES.filter(
    (s) => s.disposition === "uses-shared-classifier" && s.module !== "scripts/worktree-dirt.ts",
  );
  assert.ok(sharedSites.length >= 3, "expected multiple shared-classifier dirt gates");
  const { undeclaredBypass } = diffPorcelainDirtInventory();
  assert.equal(
    undeclaredBypass.length,
    0,
    `shared-classifier sites missing symbols: ${undeclaredBypass.map((u) => u.module).join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Residual engine-scratch block kind projection (#1020)
// ---------------------------------------------------------------------------

test("residual engine-scratch harness-failure projects workflow-engine-defect recover", () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "Engine-known scratch remains staged after unstage",
  });
  const projection = projectStageDiagnostic(diagnostic);
  assert.equal(projection.blockerClass, "workflow-engine-defect");
  assert.equal(projection.disposition, "recover");
});

test("needs-human does not project as human_authority (true authority is closed class)", () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "needs-human",
    reason: "product dirt before archive",
  });
  const projection = projectStageDiagnostic(diagnostic);
  assert.notEqual(projection.disposition, "human_authority");
  // Product dirt may still use needs-human → workflow-state, not recover-as-scratch.
  assert.equal(projection.blockerClass, "workflow-state");
});

test("human-decision-required with authority evidence remains human_authority", () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "human-decision-required",
    reason: "choose API shape",
    authorityEvidence: [
      {
        category: "product-decision",
        finding_key: "deadbeef",
        finding_fingerprint: "0123456789abcdef",
        reviewed_sha: "abc1234",
      },
    ],
  });
  const projection = projectStageDiagnostic(diagnostic);
  assert.equal(projection.disposition, "human_authority");
});
