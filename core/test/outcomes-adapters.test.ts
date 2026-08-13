import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  deriveOutcomeId,
  githubOutcomeAdapter,
  GITHUB_OUTCOME_ADAPTER_ID,
  ingestOutcomes,
  listOutcomeAdapters,
  type RawOutcomeSignal,
} from "../scripts/outcomes/adapters.ts";
import { listOutcomes, type OutcomeStoreDeps } from "../scripts/outcomes/store.ts";
import type { RunIdentity } from "../scripts/outcomes/linkage.ts";

const SHA = "d".repeat(40);
const REPO = "/repo";

function memStore(): OutcomeStoreDeps & { files: Map<string, string> } {
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
      let any = false;
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          any = true;
          names.add(k.slice(prefix.length).split(path.sep)[0]!);
        }
      }
      if (!any) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return [...names].filter(Boolean).map((name) => ({
        name,
        isDirectory: () => false,
      }));
    },
    mkdir: async () => {},
  };
}

const runs: RunIdentity[] = [
  {
    run_id: "576-2026-08-13T15-47-45-000Z",
    issue: 576,
    pr: 1200,
    started_at: "2026-08-13T15:47:45Z",
  },
];

const mergeFixture: RawOutcomeSignal = {
  signal_id: "merge:pr:1200",
  kind: "merge",
  payload: {
    pr_number: 1200,
    merged_at: "2026-08-13T16:00:00Z",
    merge_commit_sha: SHA,
    title: "feat: outcomes",
    body: "Implements #576\n\nIssue: #576\nPipeline-Run: 576/2026-08-13T15:47:45Z\n",
    url: "https://github.com/example/repo/pull/1200",
  },
};

const revertFixture: RawOutcomeSignal = {
  signal_id: "revert:pr:1201",
  kind: "revert",
  payload: {
    pr_number: 1201,
    original_pr: 1200,
    merged_at: "2026-08-14T10:00:00Z",
    merge_commit_sha: "e".repeat(40),
    title: "Revert feat outcomes",
    body: "Reverts #1200\n\nIssue: #576\nPipeline-Run: 576/2026-08-13T15:47:45Z\n",
    url: "https://github.com/example/repo/pull/1201",
  },
};

test("adapter id is stable and required", () => {
  const listed = listOutcomeAdapters();
  assert.ok(listed.some((a) => a.id === GITHUB_OUTCOME_ADAPTER_ID));
  assert.equal(githubOutcomeAdapter.id, "github");
});

test("deriveOutcomeId is stable and distinct", () => {
  const a = deriveOutcomeId("github", "reversion", 1, SHA);
  const b = deriveOutcomeId("github", "reversion", 1, SHA);
  const c = deriveOutcomeId("github", "reversion", 2, "f".repeat(40));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("merge signal produces delivery without claiming deploy success", async () => {
  const rec = githubOutcomeAdapter.normalize(mergeFixture, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.ok(rec);
  assert.equal(rec.outcome_kind, "delivery");
  assert.equal(rec.delivery?.merge_status, "merged");
  assert.equal(rec.delivery?.merged_sha, SHA);
  assert.equal(rec.delivery?.deploy_status, "not_observed");
  assert.ok(rec.attribution.some((a) => a.target_type === "run" && a.authority === "observed"));
  assert.ok(rec.linkage_diagnostics.includes("deployment_signal_absent"));
  assert.equal(rec.source.adapter_id, "github");
});

test("revert signal produces reversion outcome", () => {
  const rec = githubOutcomeAdapter.normalize(revertFixture, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-14T11:00:00Z"),
  });
  assert.ok(rec);
  assert.equal(rec.outcome_kind, "reversion");
  assert.ok(rec.attribution.some((a) => a.target_type === "pr" && a.target_id === "1200"));
});

test("missing deployment is not success", () => {
  const rec = githubOutcomeAdapter.normalize(mergeFixture, { repoDir: REPO, runs });
  assert.notEqual(rec?.delivery?.deploy_status, "succeeded");
});

test("end-to-end fixture ingest is offline and idempotent", async () => {
  const deps = memStore();
  let ghCalls = 0;
  const gh = async () => {
    ghCalls++;
    throw new Error("network forbidden in unit test");
  };
  const first = await ingestOutcomes({
    repoDir: REPO,
    signals: [mergeFixture, revertFixture],
    runs,
    gh,
    deps,
    now: new Date("2026-08-14T12:00:00Z"),
  });
  assert.equal(ghCalls, 0);
  assert.equal(first.written, 2);
  assert.equal(first.skipped, 0);

  const second = await ingestOutcomes({
    repoDir: REPO,
    signals: [mergeFixture, revertFixture],
    runs,
    deps,
    now: new Date("2026-08-14T12:00:00Z"),
  });
  assert.equal(second.written, 0);
  assert.equal(second.replaced, 2);

  const listed = await listOutcomes(REPO, { retentionDays: 0, includeExpired: true }, deps);
  assert.equal(listed.records.length, 2);
});

test("bad signal is non-fatal", async () => {
  const deps = memStore();
  const bad: RawOutcomeSignal = {
    signal_id: "bad",
    kind: "other",
    payload: {},
  };
  const summary = await ingestOutcomes({
    repoDir: REPO,
    signals: [bad, mergeFixture],
    runs,
    deps,
  });
  assert.equal(summary.written, 1);
  assert.ok(summary.skipped >= 1);
  assert.ok(summary.diagnostics.length >= 1);
});

test("ingest dry-run does not write", async () => {
  const deps = memStore();
  const summary = await ingestOutcomes({
    repoDir: REPO,
    signals: [mergeFixture],
    runs,
    deps,
    dryRun: true,
  });
  assert.equal(summary.written, 1);
  assert.equal(summary.dry_run, true);
  assert.equal(deps.files.size, 0);
});
