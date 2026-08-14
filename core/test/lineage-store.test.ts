import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { makeNodeShell, makeEdgeShell } from "../scripts/lineage/schema.ts";
import {
  listLineage,
  upsertNode,
  upsertEdge,
  lineageDir,
  type LineageStoreDeps,
} from "../scripts/lineage/store.ts";

const REPO = "/repo";
const D = "agent-pipeline";

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
          const rest = k.slice(prefix.length);
          const name = rest.split(path.sep)[0];
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
        isDirectory: () => !name.endsWith(".json") && !name.endsWith(".jsonl"),
      }));
    },
    mkdir: async () => {},
    unlink: async (p) => {
      files.delete(p);
    },
  };
}

test("empty store reads as zero records", async () => {
  const deps = memStore();
  const listed = await listLineage(REPO, {}, deps);
  assert.equal(listed.nodes.length, 0);
  assert.equal(listed.edges.length, 0);
  assert.ok(listed.diagnostics.some((d) => d.code === "missing_lineage_store" || d.code === "missing_lineage_nodes"));
});

test("upsert node/edge is idempotent", async () => {
  const deps = memStore();
  const node = makeNodeShell({
    node_id: `${D}::run:r1`,
    node_type: "run",
    domain: D,
    revision: "1",
    identity: { run_id: "r1" },
    observed_at: "2026-08-01T00:00:00Z",
  });
  const first = await upsertNode(REPO, node, deps);
  assert.equal(first.action, "written");
  const second = await upsertNode(REPO, { ...node, summary: "updated" }, deps);
  assert.equal(second.action, "replaced");
  const listed = await listLineage(REPO, { includeExpired: true, retentionDays: 0 }, deps);
  assert.equal(listed.nodes.length, 1);
  assert.equal(listed.nodes[0].summary, "updated");
});

test("retention excludes expired records", async () => {
  const deps = memStore();
  await upsertNode(
    REPO,
    makeNodeShell({
      node_id: `${D}::run:old`,
      node_type: "run",
      domain: D,
      revision: "1",
      identity: { run_id: "old" },
      observed_at: "2020-01-01T00:00:00Z",
    }),
    deps,
  );
  await upsertNode(
    REPO,
    makeNodeShell({
      node_id: `${D}::run:new`,
      node_type: "run",
      domain: D,
      revision: "1",
      identity: { run_id: "new" },
      observed_at: "2026-08-01T00:00:00Z",
    }),
    deps,
  );
  const listed = await listLineage(
    REPO,
    { retentionDays: 30, now: new Date("2026-08-13T00:00:00Z") },
    deps,
  );
  assert.equal(listed.nodes.length, 1);
  assert.equal(listed.nodes[0].identity?.run_id, "new");
});

test("corrupt file is non-fatal partial read", async () => {
  const deps = memStore();
  const dir = path.join(lineageDir(REPO), "nodes");
  deps.files.set(path.join(dir, "bad.json"), "{not json");
  await upsertNode(
    REPO,
    makeNodeShell({
      node_id: `${D}::run:ok`,
      node_type: "run",
      domain: D,
      revision: "1",
      identity: { run_id: "ok" },
      observed_at: "2026-08-01T00:00:00Z",
    }),
    deps,
  );
  const listed = await listLineage(REPO, { includeExpired: true, retentionDays: 0 }, deps);
  assert.equal(listed.nodes.length, 1);
  assert.ok(listed.diagnostics.some((d) => d.code === "lineage_node_corrupt"));
});

test("edge upsert works", async () => {
  const deps = memStore();
  const edge = makeEdgeShell({
    edge_id: `${D}::edge:e1`,
    source_id: `${D}::a:1`,
    target_id: `${D}::b:1`,
    relationship: "implements",
    revision: "1",
    observed_at: "2026-08-01T00:00:00Z",
  });
  await upsertEdge(REPO, edge, deps);
  const listed = await listLineage(REPO, { includeExpired: true, retentionDays: 0 }, deps);
  assert.equal(listed.edges.length, 1);
});
