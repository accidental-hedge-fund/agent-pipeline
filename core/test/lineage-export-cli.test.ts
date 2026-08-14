import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ingestLineageArtifacts } from "../scripts/lineage/ingest.ts";
import { computeForwardImpact, computeBackwardProposals } from "../scripts/lineage/impact.ts";
import {
  buildLineageExportSection,
  formatLineageExportHuman,
} from "../scripts/lineage/export.ts";
import { upsertGraph, type LineageStoreDeps } from "../scripts/lineage/store.ts";
import { runLineageExport, type LineageCliDeps } from "../scripts/lineage/cli.ts";

const D = "agent-pipeline";
const SHA = "d".repeat(40);
const REPO = "/repo-lineage";

function memStore(): LineageStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    readdir: async (p) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          const name = k.slice(prefix.length).split(path.sep)[0];
          if (name) names.add(name);
        }
      }
      if (names.size === 0 && ![...files.keys()].some((k) => k.startsWith(p))) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => !name.includes("."),
      }));
    },
    mkdir: async () => {},
  };
}

test("missing lineage is explicit in export section", () => {
  const section = buildLineageExportSection({ nodes: [], edges: [] });
  assert.equal(section.node_count, 0);
  assert.equal(section.skip_reason, "no_lineage_projected");
  const human = formatLineageExportHuman(section);
  assert.ok(human.includes("no_lineage_projected") || human.includes("NOT claimed"));
});

test("human-readable summary includes drift codes when impact ran", () => {
  const g = ingestLineageArtifacts({
    domain: D,
    requirements: [{ domain: D, path: "openspec/specs/x/spec.md", content_hash: "h1" }],
    objectives: [{ domain: D, objective_id: "obj-x", content_hash: "oh" }],
    runs: [{ domain: D, run_id: "run-x" }],
  });
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  const impact = computeForwardImpact(g, {
    upstream_node_id: req.node_id,
    reason: "objective_content_hash_changed",
  });
  // Force reason onto report for export visibility
  if (!impact.drift_reason_codes.includes("objective_content_hash_changed")) {
    impact.drift_reason_codes.push("objective_content_hash_changed");
  }
  const section = buildLineageExportSection({
    nodes: g.nodes,
    edges: g.edges,
    impact,
  });
  const human = formatLineageExportHuman(section);
  assert.ok(
    section.drift_reason_codes.includes("objective_content_hash_changed") ||
      section.drift_reason_codes.includes("upstream_requirement_revised"),
  );
  assert.ok(human.includes("drift_reason_codes"));
  assert.ok(section.objective_ids.includes("obj-x"));
});

test("JSON export shape is available without UI", () => {
  const g = ingestLineageArtifacts({
    domain: D,
    objectives: [{ domain: D, objective_id: "obj-y", content_hash: "h" }],
  });
  const section = buildLineageExportSection({
    nodes: g.nodes,
    edges: g.edges,
    include_records: true,
  });
  const json = JSON.stringify(section);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema_version, 1);
  assert.ok(parsed.objective_ids.includes("obj-y"));
  assert.ok(Array.isArray(parsed.nodes));
});

test("export CLI reads store with injected deps", async () => {
  const store = memStore();
  const g = ingestLineageArtifacts({
    domain: D,
    runs: [{ domain: D, run_id: "run-cli" }],
    objectives: [{ domain: D, objective_id: "obj-cli", content_hash: "h" }],
  });
  // Stamp observed_at for retention
  const nodes = g.nodes.map((n) => ({
    ...n,
    provenance: { ...n.provenance, observed_at: "2026-08-01T00:00:00Z" },
  }));
  await upsertGraph(REPO, { nodes, edges: g.edges }, store);
  const deps: LineageCliDeps = {
    store,
    readFile: store.readFile,
    log: () => {},
  };
  const section = await runLineageExport(
    { repoDir: REPO, verb: "export", retentionDays: 365 },
    deps,
  );
  assert.ok(section.node_count >= 1);
  assert.ok(section.objective_ids.includes("obj-cli"));
});

test("proposals appear in export section refs", () => {
  const g = ingestLineageArtifacts({
    domain: D,
    objectives: [{ domain: D, objective_id: "obj-z", content_hash: "h" }],
    runs: [{ domain: D, run_id: "run-z" }],
    outcomes: [
      {
        domain: D,
        outcome_id: "out-z",
        outcome_kind: "reversion",
        attribution: [
          {
            target_type: "run",
            target_id: "run-z",
            method: "direct",
            authority: "observed",
          },
        ],
      },
    ],
  });
  const proposals = computeBackwardProposals(g);
  const section = buildLineageExportSection({
    nodes: g.nodes,
    edges: g.edges,
    proposals: proposals.proposals,
  });
  assert.ok((section.proposal_refs?.length ?? 0) >= 1);
});
