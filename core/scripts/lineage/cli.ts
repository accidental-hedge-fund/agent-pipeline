// Operator entrypoint for intent lineage (#599).
//
//   pipeline lineage export  [--json] [--run-id <id>] [--retention-days N]
//   pipeline lineage impact  [--json] --node-id <id> [--new-revision <r>]
//   pipeline lineage propose [--json] [--evidence-node-id <id>]
//
// Host-local store under .agent-pipeline/lineage/. No hosted UI. Free text redacted.
// Does not mutate GitHub, stages, or merge state.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_LINEAGE_RETENTION_DAYS,
  listLineage,
  loadGraphSnapshot,
  realLineageStoreDeps,
  upsertGraph,
  type LineageStoreDeps,
} from "./store.ts";
import {
  computeBackwardProposals,
  computeForwardImpact,
  formatImpactReportHuman,
  formatProposalsHuman,
  type CompletenessGateConfig,
  evaluateLineageCompletenessGate,
} from "./impact.ts";
import { buildLineageExportSection, formatLineageExportHuman } from "./export.ts";
import { ingestLineageArtifacts, type LineageIngestInput } from "./ingest.ts";
import { validateGraphIntegrity } from "./graph.ts";
import { LINEAGE_SCHEMA_VERSION } from "./schema.ts";

export const LINEAGE_HELP = `Usage: pipeline lineage <export|impact|propose|ingest> [options]

Intent-lineage evidence graph (host-local store; #599).

  pipeline lineage export  [--json] [--run-id <id>] [--retention-days <n>] [--include-records]
  pipeline lineage impact  [--json] --node-id <id> [--new-revision <r>] [--new-hash <h>]
  pipeline lineage propose [--json] [--evidence-node-id <id>]
  pipeline lineage ingest  [--json] [--fixture <path>] [--dry-run]

Notes:
  - Default store: .agent-pipeline/lineage/ (host-local; customer-hosted safe).
  - Free-text fields are secret-redacted; no raw prompts/source/secrets.
  - Domain-scoped node ids prevent cross-repo issue/path collisions.
  - Retention default: ${DEFAULT_LINEAGE_RETENTION_DAYS} days (config key: lineage.retention_days).
  - Completeness gate default off (config key: lineage.completeness_gate).
  - Backward proposals never silently edit authoritative upstream artifacts.
  - No hosted UI required — JSON and human-readable summaries only.
`;

export type LineageVerb = "export" | "impact" | "propose" | "ingest";

export interface LineageCliOpts {
  repoDir: string;
  verb: LineageVerb;
  json?: boolean;
  dryRun?: boolean;
  retentionDays?: number;
  runId?: string;
  nodeId?: string;
  newRevision?: string;
  newHash?: string;
  evidenceNodeId?: string;
  includeRecords?: boolean;
  fixturePath?: string;
  now?: Date;
}

export interface LineageCliDeps {
  store: LineageStoreDeps;
  readFile: (p: string) => Promise<string>;
  log: (msg: string) => void;
}

export function realLineageCliDeps(): LineageCliDeps {
  return {
    store: realLineageStoreDeps(),
    readFile: (p) => fsp.readFile(p, "utf8"),
    log: (msg) => {
      process.stdout.write(`${msg}\n`);
    },
  };
}

export async function runLineageExport(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<ReturnType<typeof buildLineageExportSection>> {
  const retentionDays = opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS;
  const listed = await listLineage(
    opts.repoDir,
    { retentionDays, now: opts.now, runId: opts.runId },
    deps.store,
  );
  return buildLineageExportSection({
    nodes: listed.nodes,
    edges: listed.edges,
    run_id: opts.runId,
    include_records: opts.includeRecords,
    skip_reason:
      listed.nodes.length === 0 && listed.diagnostics.some((d) => d.code === "missing_lineage_store")
        ? "missing_lineage_store"
        : listed.nodes.length === 0
          ? "no_lineage_projected"
          : null,
  });
}

export async function runLineageImpact(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<ReturnType<typeof computeForwardImpact>> {
  if (!opts.nodeId?.trim()) {
    throw new Error("lineage impact requires --node-id <id>");
  }
  const graph = await loadGraphSnapshot(
    opts.repoDir,
    { retentionDays: opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS, now: opts.now },
    deps.store,
  );
  return computeForwardImpact(graph, {
    upstream_node_id: opts.nodeId,
    new_revision: opts.newRevision ?? null,
    new_content_hash: opts.newHash ?? null,
  });
}

export async function runLineagePropose(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<ReturnType<typeof computeBackwardProposals>> {
  const graph = await loadGraphSnapshot(
    opts.repoDir,
    { retentionDays: opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS, now: opts.now },
    deps.store,
  );
  return computeBackwardProposals(graph, {
    evidence_node_id: opts.evidenceNodeId,
  });
}

export async function runLineageIngest(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<{
  written_nodes: number;
  written_edges: number;
  diagnostics: Array<{ code: string; message: string; ref?: string }>;
  integrity_ok: boolean;
  dry_run: boolean;
}> {
  if (!opts.fixturePath) {
    throw new Error("lineage ingest requires --fixture <path> (JSON LineageIngestInput)");
  }
  const raw = await deps.readFile(opts.fixturePath);
  const input = JSON.parse(raw) as LineageIngestInput;
  const result = ingestLineageArtifacts(input);
  const integrity = validateGraphIntegrity({ nodes: result.nodes, edges: result.edges });

  if (!opts.dryRun) {
    await upsertGraph(
      opts.repoDir,
      { nodes: result.nodes, edges: result.edges },
      deps.store,
    );
  }

  return {
    written_nodes: result.nodes.length,
    written_edges: result.edges.length,
    diagnostics: [...result.diagnostics, ...integrity.diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      ref: d.edge_id ?? d.node_id,
    }))],
    integrity_ok: integrity.ok,
    dry_run: !!opts.dryRun,
  };
}

export async function runLineageCli(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<void> {
  if (opts.verb === "export") {
    const section = await runLineageExport(opts, deps);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ schema_version: LINEAGE_SCHEMA_VERSION, type: "lineage_export", ...section }, null, 2)}\n`,
      );
      return;
    }
    deps.log(formatLineageExportHuman(section));
    return;
  }

  if (opts.verb === "impact") {
    const report = await runLineageImpact(opts, deps);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    deps.log(formatImpactReportHuman(report));
    return;
  }

  if (opts.verb === "propose") {
    const result = await runLineagePropose(opts, deps);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    deps.log(formatProposalsHuman(result));
    return;
  }

  if (opts.verb === "ingest") {
    const summary = await runLineageIngest(opts, deps);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ schema_version: LINEAGE_SCHEMA_VERSION, type: "lineage_ingest", ...summary }, null, 2)}\n`,
      );
      return;
    }
    deps.log("# pipeline lineage ingest");
    deps.log(`Nodes: ${summary.written_nodes}; edges: ${summary.written_edges}${summary.dry_run ? " (dry-run)" : ""}`);
    deps.log(`Integrity: ${summary.integrity_ok ? "ok" : "diagnostics present"}`);
    if (summary.diagnostics.length) {
      deps.log("Diagnostics:");
      for (const d of summary.diagnostics) {
        deps.log(`  [${d.code}] ${d.message}`);
      }
    }
    deps.log("");
    deps.log("Privacy: store is host-local under .agent-pipeline/lineage/; free text redacted.");
    return;
  }

  throw new Error(`unknown lineage verb: ${(opts as LineageCliOpts).verb}`);
}

export type { CompletenessGateConfig };
export { evaluateLineageCompletenessGate };
