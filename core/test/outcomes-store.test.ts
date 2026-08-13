import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  emptyDeliveryChain,
  makeOutcomeShell,
} from "../scripts/outcomes/schema.ts";
import {
  listOutcomes,
  mergeDeliveryChains,
  mergeOutcomeRecords,
  outcomesDir,
  upsertOutcome,
  type OutcomeStoreDeps,
} from "../scripts/outcomes/store.ts";

const REPO = "/repo";
const SHA = "b".repeat(40);

function memStore(): OutcomeStoreDeps & { files: Map<string, string>; writes: string[] } {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files,
    writes,
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, content) => {
      writes.push(p);
      files.set(p, content);
    },
    readdir: async (p) => {
      if (![...files.keys()].some((k) => k.startsWith(p))) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      const names = new Set<string>();
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      for (const k of files.keys()) {
        if (!k.startsWith(prefix) && k !== p) continue;
        const rest = k.slice(prefix.length);
        const name = rest.split(path.sep)[0];
        if (name) names.add(name);
      }
      // Also if we only have files under dir
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const name = rest.split(path.sep)[0];
          if (name) names.add(name);
        }
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => false,
      }));
    },
    mkdir: async () => {},
    unlink: async (p) => {
      files.delete(p);
    },
  };
}

function sample(id: string, signalAt: string) {
  return makeOutcomeShell({
    outcome_id: id,
    outcome_kind: "delivery",
    observation_state: "observed",
    adapter_id: "github",
    signal_ref: id,
    summary: `s ${id}`,
    signal_at: signalAt,
    observed_at: signalAt,
    delivery: emptyDeliveryChain({
      merge_status: "merged",
      merged_sha: SHA,
      deploy_status: "not_observed",
    }),
  });
}

test("empty store reads as zero records", async () => {
  const deps = memStore();
  const listed = await listOutcomes(REPO, {}, deps);
  assert.equal(listed.records.length, 0);
  assert.ok(listed.diagnostics.some((d) => d.code === "missing_outcome_store"));
});

test("upsert is idempotent by outcome_id", async () => {
  const deps = memStore();
  const a = sample("oid-1", "2026-08-01T00:00:00Z");
  const first = await upsertOutcome(REPO, a, deps);
  assert.equal(first.action, "written");
  const second = await upsertOutcome(
    REPO,
    { ...a, summary: "updated summary" },
    deps,
  );
  assert.equal(second.action, "replaced");
  const listed = await listOutcomes(REPO, { includeExpired: true, retentionDays: 0 }, deps);
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].summary, "updated summary");
});

test("retention excludes expired records", async () => {
  const deps = memStore();
  await upsertOutcome(REPO, sample("old", "2020-01-01T00:00:00Z"), deps);
  await upsertOutcome(REPO, sample("new", "2026-08-01T00:00:00Z"), deps);
  const listed = await listOutcomes(
    REPO,
    { retentionDays: 30, now: new Date("2026-08-13T00:00:00Z") },
    deps,
  );
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].outcome_id, "new");
});

test("write failure is non-fatal to caller (skipped_invalid)", async () => {
  const deps = memStore();
  deps.writeFile = async () => {
    throw new Error("disk full");
  };
  const result = await upsertOutcome(REPO, sample("x", "2026-08-01T00:00:00Z"), deps);
  assert.equal(result.action, "skipped_invalid");
  assert.ok(result.error?.includes("disk full"));
});

test("outcomesDir is under .agent-pipeline/outcomes", () => {
  assert.equal(outcomesDir("/r"), path.join("/r", ".agent-pipeline", "outcomes"));
});

test("mergeDeliveryChains preserves merge when deploy arrives later", () => {
  const merged = mergeDeliveryChains(
    emptyDeliveryChain({
      merge_status: "merged",
      merged_sha: SHA,
      deploy_status: "not_observed",
    }),
    emptyDeliveryChain({
      environment: "production",
      deploy_status: "succeeded",
      deployed_candidate_sha: SHA,
      merge_status: "unknown",
      merged_sha: null,
    }),
  );
  assert.ok(merged);
  assert.equal(merged.merge_status, "merged");
  assert.equal(merged.merged_sha, SHA);
  assert.equal(merged.deploy_status, "succeeded");
  assert.equal(merged.deployed_candidate_sha, SHA);
  assert.equal(merged.environment, "production");
});

test("upsert field-merges delivery chain for same outcome_id", async () => {
  const deps = memStore();
  const id = "github:delivery:shared";
  const mergeRec = makeOutcomeShell({
    outcome_id: id,
    outcome_kind: "delivery",
    observation_state: "observed",
    adapter_id: "github",
    signal_ref: "merge:1",
    summary: "Merged: feat",
    signal_at: "2026-08-13T16:00:00Z",
    observed_at: "2026-08-13T16:05:00Z",
    delivery: emptyDeliveryChain({
      merge_status: "merged",
      merged_sha: SHA,
      deploy_status: "not_observed",
    }),
    attribution: [
      {
        target_type: "pr",
        target_id: "9",
        method: "adapter",
        authority: "observed",
        confidence: 1,
      },
    ],
    evidence_refs: ["merge:1"],
  });
  const deployRec = makeOutcomeShell({
    outcome_id: id,
    outcome_kind: "delivery",
    observation_state: "observed",
    adapter_id: "github",
    signal_ref: "deploy:1",
    summary: "Deployment succeeded to production",
    signal_at: "2026-08-13T18:00:00Z",
    observed_at: "2026-08-13T18:05:00Z",
    delivery: emptyDeliveryChain({
      environment: "production",
      deploy_status: "succeeded",
      deployed_candidate_sha: SHA,
      merge_status: "unknown",
    }),
    attribution: [
      {
        target_type: "commit",
        target_id: SHA,
        method: "adapter",
        authority: "observed",
        confidence: 1,
      },
    ],
    evidence_refs: ["deploy:1"],
  });

  await upsertOutcome(REPO, mergeRec, deps);
  const up = await upsertOutcome(REPO, deployRec, deps);
  assert.equal(up.action, "replaced");
  assert.equal(up.record?.delivery?.merge_status, "merged");
  assert.equal(up.record?.delivery?.deploy_status, "succeeded");
  assert.equal(up.record?.delivery?.merged_sha, SHA);
  assert.equal(up.record?.delivery?.deployed_candidate_sha, SHA);
  assert.ok(up.record?.attribution.some((a) => a.target_type === "pr"));
  assert.ok(up.record?.attribution.some((a) => a.target_type === "commit"));
  assert.equal(up.record?.signal_at, "2026-08-13T16:00:00Z");
  assert.equal(up.record?.observed_at, "2026-08-13T18:05:00Z");

  const pure = mergeOutcomeRecords(mergeRec, deployRec);
  assert.equal(pure.delivery?.merge_status, "merged");
  assert.equal(pure.delivery?.deploy_status, "succeeded");
});
