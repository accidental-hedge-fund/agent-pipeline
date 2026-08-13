import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  deriveDeliveryOutcomeId,
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
    candidate_sha: SHA,
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

test("deriveDeliveryOutcomeId is shared for merge and deploy of same SHA", () => {
  const mergeId = deriveDeliveryOutcomeId({ candidateSha: SHA, prNumber: 1200 });
  const deployId = deriveDeliveryOutcomeId({
    candidateSha: SHA,
    prNumber: undefined,
    fallbackSignalId: "deploy:prod",
  });
  assert.equal(mergeId, deployId);
  // Must not include env/deploy markers that would split the chain.
  const oldStyle = deriveOutcomeId(GITHUB_OUTCOME_ADAPTER_ID, "delivery", "deploy", "prod", SHA);
  assert.notEqual(deployId, oldStyle);
});

test("merge then deploy upsert shares one delivery chain record", async () => {
  const deps = memStore();
  const deployFixture: RawOutcomeSignal = {
    signal_id: "deploy:prod:1",
    kind: "deployment",
    payload: {
      sha: SHA,
      environment: "production",
      state: "success",
      at: "2026-08-13T18:00:00Z",
      url: "https://github.com/example/repo/deployments/1",
      pr_number: 1200,
    },
  };

  const first = await ingestOutcomes({
    repoDir: REPO,
    signals: [mergeFixture],
    runs,
    deps,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.equal(first.written, 1);
  const oid = first.outcome_ids[0]!;

  const second = await ingestOutcomes({
    repoDir: REPO,
    signals: [deployFixture],
    runs,
    deps,
    now: new Date("2026-08-13T18:30:00Z"),
  });
  // Same outcome_id → replaced, not a second delivery fact.
  assert.equal(second.replaced, 1);
  assert.equal(second.written, 0);
  assert.deepEqual(second.outcome_ids, [oid]);

  const listed = await listOutcomes(REPO, { retentionDays: 0, includeExpired: true }, deps);
  assert.equal(listed.records.length, 1);
  const rec = listed.records[0]!;
  assert.equal(rec.outcome_id, oid);
  assert.equal(rec.outcome_kind, "delivery");
  assert.equal(rec.delivery?.merge_status, "merged");
  assert.equal(rec.delivery?.merged_sha, SHA);
  assert.equal(rec.delivery?.deploy_status, "succeeded");
  assert.equal(rec.delivery?.deployed_candidate_sha, SHA);
  assert.equal(rec.delivery?.environment, "production");
  // SHA-based observed run linkage without relying only on trailer.
  assert.ok(
    rec.attribution.some(
      (a) =>
        a.target_type === "run" &&
        a.target_id === "576-2026-08-13T15-47-45-000Z" &&
        a.authority === "observed",
    ),
  );
});

test("deployment alone links run via candidate_sha without trailer", () => {
  const deployOnly: RawOutcomeSignal = {
    signal_id: "deploy:only",
    kind: "deployment",
    payload: {
      sha: SHA,
      environment: "staging",
      state: "success",
      at: "2026-08-13T19:00:00Z",
    },
  };
  const rec = githubOutcomeAdapter.normalize(deployOnly, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T19:00:00Z"),
  });
  assert.ok(rec);
  assert.ok(
    rec.attribution.some(
      (a) =>
        a.target_type === "run" &&
        a.method === "direct" &&
        a.authority === "observed" &&
        a.target_id === "576-2026-08-13T15-47-45-000Z",
    ),
  );
  // No trailer in payload — linkage is pure candidate_sha match.
  assert.equal(
    rec.attribution.some((a) => a.method === "trailer"),
    false,
  );
});

// Review 2 finding 0d180995: live discover must fetch merge-commit trailers.
test("live discover fetches merge commit message and links via Pipeline-Run trailer", async () => {
  const trailerOnlyOnCommit =
    "feat: outcomes (#1200)\n\nIssue: #576\nPipeline-Run: 576/2026-08-13T15:47:45Z\n";
  const prListJson = JSON.stringify([
    {
      number: 1200,
      mergedAt: "2026-08-13T16:00:00Z",
      mergeCommit: { oid: SHA },
      // Body deliberately lacks trailers — squash merge puts them on the commit.
      title: "feat: outcomes",
      body: "Implements the feature without trailers in the PR body.",
      url: "https://github.com/example/repo/pull/1200",
    },
  ]);
  const commitJson = JSON.stringify({
    commit: { message: trailerOnlyOnCommit },
  });
  const ghCalls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return prListJson;
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes(`/commits/${SHA}`)) {
      return commitJson;
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };

  const signals = await githubOutcomeAdapter.discover({ repoDir: REPO, gh });
  assert.equal(signals.length, 1);
  // asString trims; durable trailers must still be present on the fetched message.
  assert.match(String(signals[0]!.payload.commit_message), /Pipeline-Run:\s*576\/2026-08-13T15:47:45Z/);
  assert.ok(ghCalls.some((c) => c[0] === "api" && String(c[1]).includes(`/commits/${SHA}`)));

  const rec = githubOutcomeAdapter.normalize(signals[0]!, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.ok(rec);
  assert.ok(
    rec.attribution.some(
      (a) =>
        a.target_type === "run" &&
        a.authority === "observed" &&
        (a.method === "trailer" || a.method === "direct") &&
        a.target_id === "576-2026-08-13T15-47-45-000Z",
    ),
    "merge-commit trailer must yield observed run attribution when body has no trailer",
  );
});

// Prefer commit_message over body when both are present (trailer on commit only).
test("normalize merge prefers commit_message over body for trailer linkage", () => {
  const signal: RawOutcomeSignal = {
    signal_id: "merge:pr:1200",
    kind: "merge",
    payload: {
      pr_number: 1200,
      merged_at: "2026-08-13T16:00:00Z",
      merge_commit_sha: SHA,
      title: "feat: outcomes",
      body: "No trailers here — squash body may omit them.",
      commit_message: "feat: outcomes\n\nIssue: #576\nPipeline-Run: 576/2026-08-13T15:47:45Z\n",
      url: "https://github.com/example/repo/pull/1200",
    },
  };
  const rec = githubOutcomeAdapter.normalize(signal, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.ok(rec);
  assert.ok(
    rec.attribution.some(
      (a) =>
        a.target_type === "run" &&
        a.authority === "observed" &&
        a.target_id === "576-2026-08-13T15-47-45-000Z",
    ),
  );
});

// Review 2 finding 5b9d2331: state=rolled_back must populate delivery.rollback.
test("deployment rolled_back populates delivery.rollback occurred and outcome", () => {
  const rolledBack: RawOutcomeSignal = {
    signal_id: "deploy:prod:rb",
    kind: "deployment",
    payload: {
      sha: SHA,
      environment: "production",
      state: "rolled_back",
      at: "2026-08-13T20:00:00Z",
      url: "https://github.com/example/repo/deployments/9",
    },
  };
  const rec = githubOutcomeAdapter.normalize(rolledBack, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T20:00:00Z"),
  });
  assert.ok(rec);
  assert.equal(rec.delivery?.deploy_status, "rolled_back");
  assert.equal(rec.delivery?.rollback.occurred, true);
  assert.equal(rec.delivery?.rollback.outcome, "unknown");
});

// GitHub inactive = superseded/deactivated deployment, not an observed rollback.
test("deployment inactive does not claim rollback occurred", () => {
  const inactive: RawOutcomeSignal = {
    signal_id: "deploy:prod:inactive",
    kind: "deployment",
    payload: {
      sha: SHA,
      environment: "production",
      state: "inactive",
      at: "2026-08-13T20:02:00Z",
      url: "https://github.com/example/repo/deployments/10",
    },
  };
  const rec = githubOutcomeAdapter.normalize(inactive, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T20:02:00Z"),
  });
  assert.ok(rec);
  assert.equal(rec.delivery?.deploy_status, "unknown");
  assert.equal(rec.delivery?.rollback.occurred, null);
  assert.equal(rec.delivery?.rollback.outcome, null);
});

test("deployment rolled_back preserves provider rollback_outcome when present", () => {
  const rolledBack: RawOutcomeSignal = {
    signal_id: "deploy:prod:rb2",
    kind: "deployment",
    payload: {
      sha: SHA,
      environment: "production",
      state: "rolled_back",
      rollback_outcome: "succeeded",
      at: "2026-08-13T20:05:00Z",
    },
  };
  const rec = githubOutcomeAdapter.normalize(rolledBack, {
    repoDir: REPO,
    runs,
    now: new Date("2026-08-13T20:05:00Z"),
  });
  assert.ok(rec);
  assert.equal(rec.delivery?.deploy_status, "rolled_back");
  assert.equal(rec.delivery?.rollback.occurred, true);
  assert.equal(rec.delivery?.rollback.outcome, "succeeded");
});

// Review 2 finding bb8f74f1: squash/rebase merge SHA ≠ candidate SHA must still
// share one delivery identity with a later deploy of the pipeline candidate.
test("squash merge then candidate deploy share one delivery outcome_id", async () => {
  const candidateSha = "a".repeat(40);
  const mergeCommitSha = "b".repeat(40);
  assert.notEqual(candidateSha, mergeCommitSha);

  const squashRuns: RunIdentity[] = [
    {
      run_id: "576-2026-08-13T15-47-45-000Z",
      issue: 576,
      pr: 1200,
      started_at: "2026-08-13T15:47:45Z",
      candidate_sha: candidateSha,
    },
  ];

  const squashMerge: RawOutcomeSignal = {
    signal_id: "merge:pr:1200:squash",
    kind: "merge",
    payload: {
      pr_number: 1200,
      merged_at: "2026-08-13T16:00:00Z",
      merge_commit_sha: mergeCommitSha,
      title: "feat: outcomes (squash)",
      // Trailers only on the merge commit — resolves the run whose candidate differs.
      commit_message:
        "feat: outcomes (#1200)\n\nIssue: #576\nPipeline-Run: 576/2026-08-13T15:47:45Z\n",
      body: "No trailers in PR body.",
      url: "https://github.com/example/repo/pull/1200",
    },
  };

  const deployCandidate: RawOutcomeSignal = {
    signal_id: "deploy:prod:candidate",
    kind: "deployment",
    payload: {
      sha: candidateSha,
      environment: "production",
      state: "success",
      at: "2026-08-13T18:00:00Z",
      url: "https://github.com/example/repo/deployments/2",
      pr_number: 1200,
    },
  };

  const mergeRec = githubOutcomeAdapter.normalize(squashMerge, {
    repoDir: REPO,
    runs: squashRuns,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.ok(mergeRec);
  assert.equal(mergeRec.delivery?.merged_sha, mergeCommitSha);
  // Identity keys on uniquely resolved run candidate, not the squash merge commit.
  assert.equal(
    mergeRec.outcome_id,
    deriveDeliveryOutcomeId({ candidateSha, prNumber: 1200 }),
  );

  const deps = memStore();
  const first = await ingestOutcomes({
    repoDir: REPO,
    signals: [squashMerge],
    runs: squashRuns,
    deps,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.equal(first.written, 1);
  const oid = first.outcome_ids[0]!;

  const second = await ingestOutcomes({
    repoDir: REPO,
    signals: [deployCandidate],
    runs: squashRuns,
    deps,
    now: new Date("2026-08-13T18:30:00Z"),
  });
  assert.equal(second.replaced, 1);
  assert.equal(second.written, 0);
  assert.deepEqual(second.outcome_ids, [oid]);

  const listed = await listOutcomes(REPO, { retentionDays: 0, includeExpired: true }, deps);
  assert.equal(listed.records.length, 1);
  const rec = listed.records[0]!;
  assert.equal(rec.delivery?.merge_status, "merged");
  assert.equal(rec.delivery?.merged_sha, mergeCommitSha);
  assert.equal(rec.delivery?.deploy_status, "succeeded");
  assert.equal(rec.delivery?.deployed_candidate_sha, candidateSha);
});

// End-to-end: rolled_back deploy upserts rollback fields onto the delivery chain.
test("rolled_back deployment upserts rollback chain on existing delivery", async () => {
  const deps = memStore();
  const first = await ingestOutcomes({
    repoDir: REPO,
    signals: [mergeFixture],
    runs,
    deps,
    now: new Date("2026-08-13T17:00:00Z"),
  });
  assert.equal(first.written, 1);
  const oid = first.outcome_ids[0]!;

  const rolledBack: RawOutcomeSignal = {
    signal_id: "deploy:prod:rb-e2e",
    kind: "deployment",
    payload: {
      sha: SHA,
      environment: "production",
      state: "rolled_back",
      at: "2026-08-13T21:00:00Z",
      url: "https://github.com/example/repo/deployments/11",
      pr_number: 1200,
    },
  };
  const second = await ingestOutcomes({
    repoDir: REPO,
    signals: [rolledBack],
    runs,
    deps,
    now: new Date("2026-08-13T21:30:00Z"),
  });
  assert.equal(second.replaced, 1);
  assert.deepEqual(second.outcome_ids, [oid]);

  const listed = await listOutcomes(REPO, { retentionDays: 0, includeExpired: true }, deps);
  assert.equal(listed.records.length, 1);
  const rec = listed.records[0]!;
  assert.equal(rec.delivery?.deploy_status, "rolled_back");
  assert.equal(rec.delivery?.rollback.occurred, true);
  assert.equal(rec.delivery?.rollback.outcome, "unknown");
  assert.equal(rec.delivery?.merge_status, "merged");
});
