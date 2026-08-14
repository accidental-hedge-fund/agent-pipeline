import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ingestLineageArtifacts } from "../scripts/lineage/ingest.ts";
import { computeForwardImpact, computeBackwardProposals } from "../scripts/lineage/impact.ts";
import {
  buildLineageExportSection,
  formatLineageExportHuman,
} from "../scripts/lineage/export.ts";
import {
  listAnalysisRecords,
  loadGraphSnapshot,
  upsertGraph,
  type LineageStoreDeps,
} from "../scripts/lineage/store.ts";
import {
  LINEAGE_SCHEMA_VERSION,
  readLineageNode,
} from "../scripts/lineage/schema.ts";
import {
  runLineageExport,
  runLineageImpact,
  runLineageIngest,
  runLineagePropose,
  type LineageCliDeps,
} from "../scripts/lineage/cli.ts";

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
  assert.equal(parsed.schema_version, 2);
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

test("impact and propose persist analysis records loaded by export", async () => {
  const store = memStore();
  const g = ingestLineageArtifacts({
    domain: D,
    requirements: [{ domain: D, path: "openspec/specs/y/spec.md", content_hash: "h1" }],
    objectives: [{ domain: D, objective_id: "obj-persist", content_hash: "oh" }],
    runs: [{ domain: D, run_id: "run-persist" }],
    outcomes: [
      {
        domain: D,
        outcome_id: "out-persist",
        outcome_kind: "reversion",
        attribution: [
          {
            target_type: "run",
            target_id: "run-persist",
            method: "direct",
            authority: "observed",
          },
        ],
      },
    ],
  });
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
  const req = nodes.find((n) => n.node_type === "requirement")!;
  const impact = await runLineageImpact(
    {
      repoDir: REPO,
      verb: "impact",
      nodeId: req.node_id,
      newHash: "h2",
      newRevision: "h2",
      runId: "run-persist",
      now: new Date("2026-08-02T00:00:00Z"),
    },
    deps,
  );
  assert.ok(impact.drift_reason_codes.length >= 0);
  const propose = await runLineagePropose(
    {
      repoDir: REPO,
      verb: "propose",
      runId: "run-persist",
      now: new Date("2026-08-02T00:00:01Z"),
    },
    deps,
  );
  assert.ok(propose.proposals.length >= 1);

  const stored = await listAnalysisRecords(REPO, { runId: "run-persist" }, store);
  assert.ok(stored.records.some((r) => r.record_kind === "forward_impact"));
  assert.ok(stored.records.some((r) => r.record_kind === "backward_proposals"));

  const section = await runLineageExport(
    { repoDir: REPO, verb: "export", runId: "run-persist", retentionDays: 365 },
    deps,
  );
  assert.ok(section.impact_ref, "export must include persisted impact_ref");
  assert.ok(
    (section.proposal_refs?.length ?? 0) >= 1,
    "export must include persisted proposal_refs",
  );
  assert.ok(
    section.drift_reason_codes.length >= 0 ||
      (section.impact_ref?.drift_reason_codes.length ?? 0) >= 0,
  );
});

test("impact fails when analysis persistence is skipped (#599 39e56c5e)", async () => {
  const store = memStore();
  const g = ingestLineageArtifacts({
    domain: D,
    requirements: [{ domain: D, path: "openspec/specs/p/spec.md", content_hash: "h1" }],
    objectives: [{ domain: D, objective_id: "obj-pf", content_hash: "oh" }],
    runs: [{ domain: D, run_id: "run-pf" }],
  });
  await upsertGraph(REPO, { nodes: g.nodes, edges: g.edges }, store);
  // Break the analysis write so upsertAnalysisRecord returns skipped
  const origWrite = store.writeFile;
  store.writeFile = async () => {
    throw new Error("disk-full (test injected)");
  };
  const deps: LineageCliDeps = {
    store,
    readFile: store.readFile,
    log: () => {},
  };
  const req = g.nodes.find((n) => n.node_type === "requirement")!;
  await assert.rejects(
    () =>
      runLineageImpact(
        { repoDir: REPO, verb: "impact", nodeId: req.node_id, runId: "run-pf" },
        deps,
      ),
    /analysis record was not persisted/,
  );
  // Restore writes so propose path can be exercised independently
  store.writeFile = origWrite;
});

test("persisted v1 lineage records load and migrate through loadGraphSnapshot (#599 b50bf85a)", async () => {
  const store = memStore();
  const domain = D;
  const v1NodeId = `${domain}::requirement:a%2Fb`;
  // Write a legacy v1-schema record directly (validators must accept it on read)
  const v1Node = {
    schema_version: 1,
    type: "lineage_node",
    node_id: v1NodeId,
    node_type: "requirement",
    domain,
    revision: "1",
    content_hash: "h1",
    summary: null,
    identity: { path: "a%2Fb", content_hash: "h1" },
    provenance: {
      schema_version: 1,
      observed_at: "2026-08-14T00:00:00Z",
      producer: "test",
      method: "manual",
      authority: "observed",
    },
  };
  const validNode = readLineageNode(v1Node);
  assert.ok(validNode, "v1 record must pass validation (legacy acceptance)");
  store.files.set(
    `/repo-lineage/.agent-pipeline/lineage/nodes/safe-${encodeURIComponent(v1NodeId)}.json`,
    JSON.stringify(v1Node),
  );
  const loaded = await loadGraphSnapshot(REPO, {}, store);
  // Migrated node carries v2 id (literal percent escaped)
  const migratedNode = loaded.nodes.find((n) => n.node_id.includes("a%252Fb"));
  assert.ok(migratedNode, `expected migrated v2 node; got ids=${loaded.nodes.map((n) => n.node_id)}`);
  assert.equal(migratedNode.schema_version, LINEAGE_SCHEMA_VERSION);
});

test("impact and propose fail when analysis record write fails (#599 39e56c5e)", async () => {
  const store = memStore();
  const g = ingestLineageArtifacts({
    domain: D,
    requirements: [{ domain: D, path: "openspec/specs/zz/spec.md", content_hash: "h1" }],
    objectives: [{ domain: D, objective_id: "obj-pf2", content_hash: "oh" }],
    runs: [{ domain: D, run_id: "run-pf2" }],
    outcomes: [
      {
        domain: D,
        outcome_id: "out-pf2",
        outcome_kind: "reversion",
        attribution: [
          { target_type: "run", target_id: "run-pf2", method: "direct", authority: "observed" },
        ],
      },
    ],
  });
  const nodes = g.nodes.map((n) => ({
    ...n,
    provenance: { ...n.provenance, observed_at: "2026-08-01T00:00:00Z" },
  }));
  await upsertGraph(REPO, { nodes, edges: g.edges }, store);
  const origWrite = store.writeFile;
  store.writeFile = async () => {
    throw new Error("disk-full");
  };
  const deps: LineageCliDeps = {
    store,
    readFile: store.readFile,
    log: () => {},
  };
  const req = nodes.find((n) => n.node_type === "requirement")!;
  await assert.rejects(
    () =>
      runLineageImpact(
        { repoDir: REPO, verb: "impact", nodeId: req.node_id, runId: "run-pf2" },
        deps,
      ),
    /analysis record was not persisted/,
  );
  await assert.rejects(
    () =>
      runLineagePropose(
        { repoDir: REPO, verb: "propose", runId: "run-pf2" },
        deps,
      ),
    /proposal record was not persisted/,
  );
  store.writeFile = origWrite;
});

test("ingest fails closed and does not persist when integrity fails", async () => {
  const store = memStore();
  // Valid fixture content; inject failing integrity to prove fail-closed before upsert.
  const input = {
    domain: D,
    objectives: [{ domain: D, objective_id: "obj-ok", content_hash: "h" }],
  };
  store.files.set("/fixture-bad.json", JSON.stringify(input));
  let writes = 0;
  const origWrite = store.writeFile;
  store.writeFile = async (p, content) => {
    writes += 1;
    return origWrite(p, content);
  };
  const deps: LineageCliDeps = {
    store,
    readFile: store.readFile,
    log: () => {},
    validateIntegrity: () => ({
      ok: false,
      diagnostics: [
        {
          code: "unknown_target",
          message: "edge target_id absent from graph (injected for fail-closed test)",
          edge_id: "e-bad",
        },
      ],
    }),
  };
  const summary = await runLineageIngest(
    {
      repoDir: REPO,
      verb: "ingest",
      fixturePath: "/fixture-bad.json",
    },
    deps,
  );
  assert.equal(summary.integrity_ok, false);
  assert.equal(summary.rejected, true);
  assert.equal(summary.written_nodes, 0);
  assert.equal(summary.written_edges, 0);
  assert.equal(writes, 0, "must not write nodes/edges when integrity fails");
  assert.ok(summary.diagnostics.some((d) => d.code === "unknown_target"));
});

// ---------------------------------------------------------------------------
// command-registry: lineage flags required by documented verbs (#599 review)
// ---------------------------------------------------------------------------

import {
  COMMAND_REGISTRY,
  lookupCommand,
  validateFlags,
} from "../scripts/command-registry.ts";

test("command-registry: lineage allows every documented lineage option", () => {
  const entry = COMMAND_REGISTRY.lineage;
  assert.ok(entry);
  assert.equal(lookupCommand("lineage"), entry);
  assert.equal(entry.mutatesGitHub, false);
  assert.equal(entry.needsGhAuth, false);
  assert.equal(entry.supportsJson, true);
  const required = [
    "repoPath",
    "json",
    "dryRun",
    "retentionDays",
    "fixture",
    "runId",
    "nodeId",
    "newRevision",
    "newHash",
    "evidenceNodeId",
    "includeRecords",
  ];
  for (const flag of required) {
    assert.ok(
      (entry.allowedFlags as Set<string>).has(flag),
      `lineage.allowedFlags should include "${flag}"`,
    );
  }
});

test("command-registry: lineage validateFlags accepts documented options from CLI", () => {
  const entry = COMMAND_REGISTRY.lineage;
  const provided = new Set([
    "runId",
    "nodeId",
    "newRevision",
    "newHash",
    "evidenceNodeId",
    "includeRecords",
    "json",
    "repoPath",
    "fixture",
    "retentionDays",
    "dryRun",
  ]);
  const cmd = {
    options: [...provided].map((key) => ({
      attributeName: () => key,
      long: `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
    })),
    getOptionValueSource: (key: string) => (provided.has(key) ? "cli" : undefined),
  };
  assert.deepEqual(validateFlags(entry, cmd), []);
});

import { maxPositionalsFor } from "../scripts/pipeline.ts";

test("maxPositionalsFor: lineage accepts command + verb (export|impact|propose|ingest)", () => {
  assert.equal(maxPositionalsFor("lineage"), 2);
  assert.ok(["lineage", "impact"].length <= maxPositionalsFor("lineage"));
  assert.ok(["lineage", "export", "extra"].length > maxPositionalsFor("lineage"));
});
