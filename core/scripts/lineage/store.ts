// Host-local intent-lineage graph store (#599).
//
// Layout:
//   .agent-pipeline/lineage/nodes/<safe_node_id>.json
//   .agent-pipeline/lineage/edges/<safe_edge_id>.json
//   .agent-pipeline/lineage/analyses/<safe_analysis_id>.json  (impact / proposals)
//   .agent-pipeline/lineage/index.jsonl  (optional rewrite on upsert)
//
// Append/upsert by id. Retention filters default export. Inject fs deps for tests.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { artifactSubdir, LINEAGE_ARTIFACT } from "../artifact-ignore.ts";
import {
  LINEAGE_SCHEMA_VERSION,
  readLineageEdge,
  readLineageNode,
  serializeLineageEdge,
  serializeLineageNode,
  type LineageEdge,
  type LineageGraphSnapshot,
  type LineageNode,
} from "./schema.ts";
import { migrateLineageIdentityV1ToV2 } from "./identity.ts";
import type { ForwardImpactReport, LineageUpdateProposal } from "./impact.ts";

/** Default retention window for export (days). Config key: lineage.retention_days */
export const DEFAULT_LINEAGE_RETENTION_DAYS = 365;

export interface LineageStoreDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, content: string) => Promise<void>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
}

export function realLineageStoreDeps(): LineageStoreDeps {
  return {
    readFile: (p) => fsp.readFile(p, "utf8"),
    writeFile: (p, content) => fsp.writeFile(p, content, "utf8"),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: () => e.isDirectory() }));
    },
    mkdir: (p, opts) => fsp.mkdir(p, opts).then(() => undefined),
    unlink: (p) => fsp.unlink(p),
  };
}

export function lineageDir(repoDir: string): string {
  return artifactSubdir(repoDir, LINEAGE_ARTIFACT);
}

export function lineageNodesDir(repoDir: string): string {
  return path.join(lineageDir(repoDir), "nodes");
}

export function lineageEdgesDir(repoDir: string): string {
  return path.join(lineageDir(repoDir), "edges");
}

export function lineageIndexPath(repoDir: string): string {
  return path.join(lineageDir(repoDir), "index.jsonl");
}

export function lineageAnalysesDir(repoDir: string): string {
  return path.join(lineageDir(repoDir), "analyses");
}

function safeId(id: string): string {
  return id.replace(/[/\\:]/g, "_");
}

export interface StoreDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface UpsertResult {
  action: "written" | "replaced" | "skipped";
  id: string;
  diagnostics: StoreDiagnostic[];
}

// ---------------------------------------------------------------------------
// Analysis records (immutable impact / proposal outputs for evidence export)
// ---------------------------------------------------------------------------

export type LineageAnalysisKind = "forward_impact" | "backward_proposals";

export interface LineageAnalysisRecord {
  schema_version: typeof LINEAGE_SCHEMA_VERSION;
  type: "lineage_analysis_record";
  analysis_id: string;
  record_kind: LineageAnalysisKind;
  run_id: string | null;
  computed_at: string;
  /** Set when record_kind is forward_impact. */
  impact?: ForwardImpactReport | null;
  /** Set when record_kind is backward_proposals. */
  proposals?: LineageUpdateProposal[] | null;
  drift_reason_codes: string[];
}

export function analysisFilePath(repoDir: string, analysisId: string): string {
  return path.join(lineageAnalysesDir(repoDir), `${safeId(analysisId)}.json`);
}

export async function upsertAnalysisRecord(
  repoDir: string,
  record: LineageAnalysisRecord,
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<UpsertResult> {
  const diagnostics: StoreDiagnostic[] = [];
  const filePath = analysisFilePath(repoDir, record.analysis_id);
  let action: UpsertResult["action"] = "written";
  try {
    await deps.readFile(filePath);
    action = "replaced";
  } catch {
    action = "written";
  }
  try {
    await deps.mkdir(lineageAnalysesDir(repoDir), { recursive: true });
    await deps.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    diagnostics.push({
      code: "lineage_analysis_write_failed",
      message: (err as Error).message,
      path: filePath,
    });
    return { action: "skipped", id: record.analysis_id, diagnostics };
  }
  return { action, id: record.analysis_id, diagnostics };
}

export interface ListAnalysesOpts {
  runId?: string;
}

export async function listAnalysisRecords(
  repoDir: string,
  opts: ListAnalysesOpts = {},
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<{ records: LineageAnalysisRecord[]; diagnostics: StoreDiagnostic[] }> {
  const diagnostics: StoreDiagnostic[] = [];
  const dir = lineageAnalysesDir(repoDir);
  let files: string[] = [];
  try {
    const entries = await deps.readdir(dir);
    files = entries
      .filter((e) => !e.isDirectory() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        code: "lineage_analyses_unreadable",
        message: (err as Error).message,
        path: dir,
      });
    }
    return { records: [], diagnostics };
  }

  const records: LineageAnalysisRecord[] = [];
  for (const filePath of files) {
    let raw: string;
    try {
      raw = await deps.readFile(filePath);
    } catch (err) {
      diagnostics.push({
        code: "lineage_analysis_unreadable",
        message: (err as Error).message,
        path: filePath,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "lineage_analysis_corrupt",
        message: "invalid JSON",
        path: filePath,
      });
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { type?: string }).type !== "lineage_analysis_record" ||
      typeof (parsed as { analysis_id?: string }).analysis_id !== "string"
    ) {
      diagnostics.push({
        code: "lineage_analysis_invalid",
        message: "failed analysis record shape check",
        path: filePath,
      });
      continue;
    }
    const rec = parsed as LineageAnalysisRecord;
    if (opts.runId) {
      // Include records for this run, and unscoped records (run_id null).
      if (rec.run_id != null && rec.run_id !== opts.runId) continue;
    }
    records.push(rec);
  }

  records.sort((a, b) => a.analysis_id.localeCompare(b.analysis_id));
  return { records, diagnostics };
}

export function nodeFilePath(repoDir: string, nodeId: string): string {
  return path.join(lineageNodesDir(repoDir), `${safeId(nodeId)}.json`);
}

export function edgeFilePath(repoDir: string, edgeId: string): string {
  return path.join(lineageEdgesDir(repoDir), `${safeId(edgeId)}.json`);
}

export interface ListLineageOpts {
  /** Retention window in days; records older than this are excluded from default export. */
  retentionDays?: number;
  includeExpired?: boolean;
  now?: Date;
  /** Optional domain filter. */
  domain?: string;
  /** Optional run_id filter (nodes/edges whose identity or mapped_identity references it). */
  runId?: string;
}

function relevantTimestamp(nodeOrEdge: {
  provenance: { observed_at: string | null };
}): string | null {
  return nodeOrEdge.provenance.observed_at ?? null;
}

function isWithinRetention(
  record: { provenance: { observed_at: string | null } },
  retentionDays: number,
  now: Date,
): boolean {
  if (retentionDays <= 0) return true;
  const ts = relevantTimestamp(record);
  if (!ts) return true;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return true;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return ms >= cutoff;
}

async function listJsonFiles(
  dir: string,
  deps: LineageStoreDeps,
  diagnostics: StoreDiagnostic[],
  kind: "node" | "edge",
): Promise<string[]> {
  try {
    const entries = await deps.readdir(dir);
    return entries
      .filter((e) => !e.isDirectory() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      diagnostics.push({
        code: kind === "node" ? "missing_lineage_nodes" : "missing_lineage_edges",
        message: `Lineage ${kind} directory is missing.`,
        path: dir,
      });
      return [];
    }
    diagnostics.push({
      code: "lineage_store_unreadable",
      message: (err as Error).message,
      path: dir,
    });
    return [];
  }
}

export interface ListLineageResult {
  nodes: LineageNode[];
  edges: LineageEdge[];
  diagnostics: StoreDiagnostic[];
}

/** List nodes and edges; missing store → empty + diagnostics (never throws). */
export async function listLineage(
  repoDir: string,
  opts: ListLineageOpts = {},
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<ListLineageResult> {
  const diagnostics: StoreDiagnostic[] = [];
  const retentionDays = opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS;
  const now = opts.now ?? new Date();

  const nodePaths = await listJsonFiles(lineageNodesDir(repoDir), deps, diagnostics, "node");
  const edgePaths = await listJsonFiles(lineageEdgesDir(repoDir), deps, diagnostics, "edge");

  // If both dirs missing, also note missing root store once.
  if (
    diagnostics.some((d) => d.code === "missing_lineage_nodes") &&
    diagnostics.some((d) => d.code === "missing_lineage_edges")
  ) {
    diagnostics.push({
      code: "missing_lineage_store",
      message: "Lineage store directory is missing.",
      path: lineageDir(repoDir),
    });
  }

  const nodes: LineageNode[] = [];
  for (const filePath of nodePaths) {
    let raw: string;
    try {
      raw = await deps.readFile(filePath);
    } catch (err) {
      diagnostics.push({
        code: "lineage_node_unreadable",
        message: (err as Error).message,
        path: filePath,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "lineage_node_corrupt",
        message: "invalid JSON",
        path: filePath,
      });
      continue;
    }
    const node = readLineageNode(parsed);
    if (!node) {
      diagnostics.push({
        code: "lineage_node_invalid",
        message: "failed schema validation",
        path: filePath,
      });
      continue;
    }
    if (!opts.includeExpired && !isWithinRetention(node, retentionDays, now)) continue;
    if (opts.domain && node.domain !== opts.domain) continue;
    if (opts.runId) {
      const rid = node.identity?.run_id;
      if (rid !== opts.runId && node.node_type === "run") continue;
      // Keep non-run nodes when filtering by run — caller may filter further via edges.
    }
    nodes.push(node);
  }

  const edges: LineageEdge[] = [];
  for (const filePath of edgePaths) {
    let raw: string;
    try {
      raw = await deps.readFile(filePath);
    } catch (err) {
      diagnostics.push({
        code: "lineage_edge_unreadable",
        message: (err as Error).message,
        path: filePath,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      diagnostics.push({
        code: "lineage_edge_corrupt",
        message: "invalid JSON",
        path: filePath,
      });
      continue;
    }
    const edge = readLineageEdge(parsed);
    if (!edge) {
      diagnostics.push({
        code: "lineage_edge_invalid",
        message: "failed schema validation",
        path: filePath,
      });
      continue;
    }
    if (!opts.includeExpired && !isWithinRetention(edge, retentionDays, now)) continue;
    if (opts.runId) {
      const mid = edge.mapped_identity?.run_id;
      // keep edge if mapped to run or endpoints may reference run nodes — include all if no mid
      if (mid != null && mid !== opts.runId) continue;
    }
    edges.push(edge);
  }

  return { nodes, edges, diagnostics };
}

export async function loadGraphSnapshot(
  repoDir: string,
  opts: ListLineageOpts = {},
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<LineageGraphSnapshot & { diagnostics: StoreDiagnostic[] }> {
  const listed = await listLineage(repoDir, opts, deps);
  // Deterministic v1→v2 identity migration (#599 b775d25c): any legacy stored
  // id that collided (literal `%` vs encoded `/`) is rewritten from the
  // recorded canonical identity; ambiguous leftovers fail closed with a
  // diagnostic rather than being silently re-keyed.
  const migrated = migrateLineageIdentityV1ToV2(listed.nodes, listed.edges);
  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    nodes: migrated.nodes,
    edges: migrated.edges,
    diagnostics: [...listed.diagnostics, ...migrated.diagnostics],
  };
}

async function rewriteIndex(
  repoDir: string,
  deps: LineageStoreDeps,
): Promise<void> {
  try {
    const listed = await listLineage(repoDir, { includeExpired: true, retentionDays: 0 }, deps);
    const lines: string[] = [];
    for (const n of listed.nodes) {
      lines.push(
        JSON.stringify({
          kind: "node",
          id: n.node_id,
          node_type: n.node_type,
          domain: n.domain,
          revision: n.revision,
        }),
      );
    }
    for (const e of listed.edges) {
      lines.push(
        JSON.stringify({
          kind: "edge",
          id: e.edge_id,
          relationship: e.relationship,
          source_id: e.source_id,
          target_id: e.target_id,
        }),
      );
    }
    await deps.mkdir(lineageDir(repoDir), { recursive: true });
    await deps.writeFile(lineageIndexPath(repoDir), lines.map((l) => `${l}\n`).join(""));
  } catch {
    // index is optional; non-fatal
  }
}

export async function upsertNode(
  repoDir: string,
  node: LineageNode,
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<UpsertResult> {
  const diagnostics: StoreDiagnostic[] = [];
  const filePath = nodeFilePath(repoDir, node.node_id);
  let action: UpsertResult["action"] = "written";
  try {
    await deps.readFile(filePath);
    action = "replaced";
  } catch {
    action = "written";
  }
  try {
    await deps.mkdir(lineageNodesDir(repoDir), { recursive: true });
    await deps.writeFile(filePath, serializeLineageNode(node));
    await rewriteIndex(repoDir, deps);
  } catch (err) {
    diagnostics.push({
      code: "lineage_node_write_failed",
      message: (err as Error).message,
      path: filePath,
    });
    return { action: "skipped", id: node.node_id, diagnostics };
  }
  return { action, id: node.node_id, diagnostics };
}

export async function upsertEdge(
  repoDir: string,
  edge: LineageEdge,
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<UpsertResult> {
  const diagnostics: StoreDiagnostic[] = [];
  const filePath = edgeFilePath(repoDir, edge.edge_id);
  let action: UpsertResult["action"] = "written";
  try {
    await deps.readFile(filePath);
    action = "replaced";
  } catch {
    action = "written";
  }
  try {
    await deps.mkdir(lineageEdgesDir(repoDir), { recursive: true });
    await deps.writeFile(filePath, serializeLineageEdge(edge));
    await rewriteIndex(repoDir, deps);
  } catch (err) {
    diagnostics.push({
      code: "lineage_edge_write_failed",
      message: (err as Error).message,
      path: filePath,
    });
    return { action: "skipped", id: edge.edge_id, diagnostics };
  }
  return { action, id: edge.edge_id, diagnostics };
}

/** Upsert many nodes/edges; continues on partial failures. */
export async function upsertGraph(
  repoDir: string,
  graph: { nodes?: readonly LineageNode[]; edges?: readonly LineageEdge[] },
  deps: LineageStoreDeps = realLineageStoreDeps(),
): Promise<{ nodes: UpsertResult[]; edges: UpsertResult[] }> {
  const nodes: UpsertResult[] = [];
  const edges: UpsertResult[] = [];
  for (const n of graph.nodes ?? []) {
    nodes.push(await upsertNode(repoDir, n, deps));
  }
  for (const e of graph.edges ?? []) {
    edges.push(await upsertEdge(repoDir, e, deps));
  }
  return { nodes, edges };
}
