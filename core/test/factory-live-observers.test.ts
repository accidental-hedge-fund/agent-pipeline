// Factory CLI live-observer wiring (#890 review finding 25b9759a).
//
// Injected git/gh/pin/loop seams only — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildFactoryMacroDeps,
  childStatusFromLoopStatus,
  computeEffectiveConfigFingerprints,
  observeFactoryBaseSha,
  observeFactoryGithubSnapshot,
  observeFactoryRepoIdentity,
  type FactoryLiveObserverDeps,
} from "../scripts/factory/live-observers.ts";
import { FactoryError } from "../scripts/factory/types.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import type { FactoryStoreDeps } from "../scripts/factory/store.ts";
import type { LoopStoreDeps, LoopStatus } from "../scripts/loop/store.ts";

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_CONFIG,
    repo: "acme/widgets",
    base_branch: "main",
    domain: "widgets",
    harnesses: {
      implementer: "claude",
      reviewer: "codex",
      implementerSource: "profile" as const,
      reviewerSource: "profile" as const,
    },
    factory: { macro_controller: { enabled: true } },
    ...overrides,
  };
}

function fakeLoopStore(): LoopStoreDeps {
  return {
    async fsExists() {
      return false;
    },
    async readTextFile() {
      return null;
    },
    async writeFileAtomic() {},
    async createFileExclusive() {
      return true;
    },
    async removeFile() {},
    async removeFileIfMatches() {
      return true;
    },
    async appendLine() {},
    async mkdirp() {},
    async renameDirExclusive() {
      return true;
    },
    async listDir() {
      return [];
    },
    async isPidAlive() {
      return false;
    },
    hostname: () => "test-host",
    pid: () => 1,
    now: () => new Date("2026-08-07T21:00:00.000Z"),
    env: {},
  } as unknown as LoopStoreDeps;
}

function fakeStore(): FactoryStoreDeps {
  return {
    async fsExists() {
      return false;
    },
    async readTextFile() {
      return null;
    },
    async writeFileAtomic() {},
    async createFileExclusive() {
      return true;
    },
    async removeFile() {},
    async removeFileIfMatches() {
      return true;
    },
    async appendLine() {},
    async mkdirp() {},
    async listDir() {
      return [];
    },
    async isPidAlive() {
      return false;
    },
    hostname: () => "test-host",
    pid: () => 1,
    now: () => new Date("2026-08-07T21:00:00.000Z"),
    uuid: () => "uuid-1",
    env: { AGENT_PIPELINE_FACTORY_STATE_HOME: "/tmp/factory-test" },
  } as unknown as FactoryStoreDeps;
}

test("observeFactoryBaseSha prefers origin/<branch> 40-char SHA", async () => {
  const calls: string[][] = [];
  const sha40 = "a".repeat(40);
  const deps: Pick<FactoryLiveObserverDeps, "git"> = {
    async git(_dir, args) {
      calls.push(args);
      if (args.includes("origin/main")) {
        return { stdout: `${sha40}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "missing", code: 128 };
    },
  };
  const got = await observeFactoryBaseSha(deps, "/repo", "main");
  assert.equal(got, sha40);
  assert.deepEqual(calls[0], ["rev-parse", "--verify", "origin/main"]);
});

test("observeFactoryBaseSha falls back to local branch then fails closed", async () => {
  const sha40 = "b".repeat(40);
  let n = 0;
  const deps: Pick<FactoryLiveObserverDeps, "git"> = {
    async git(_dir, args) {
      n++;
      if (args.includes("origin/main")) return { stdout: "", stderr: "x", code: 128 };
      if (args.includes("main") && !args.includes("refs/heads")) {
        return { stdout: sha40, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "x", code: 128 };
    },
  };
  assert.equal(await observeFactoryBaseSha(deps, "/repo", "main"), sha40);
  assert.ok(n >= 2);

  await assert.rejects(
    () =>
      observeFactoryBaseSha(
        {
          async git() {
            return { stdout: "not-a-sha", stderr: "", code: 0 };
          },
        },
        "/repo",
        "main",
      ),
    (err: unknown) => err instanceof FactoryError && /unable to observe base SHA/.test(err.message),
  );
});

test("observeFactoryRepoIdentity uses resolved config repo/base_branch", async () => {
  const id = await observeFactoryRepoIdentity(makeCfg({ repo: "acme/widgets", base_branch: "staging" }), {
    repoDir: "/repo",
    baseBranch: "main",
  });
  assert.deepEqual(id, { name: "acme/widgets", base_branch: "staging" });

  await assert.rejects(
    () =>
      observeFactoryRepoIdentity(makeCfg({ repo: "" }), {
        repoDir: "/repo",
        baseBranch: "main",
      }),
    (err: unknown) =>
      err instanceof FactoryError && /unable to observe repository identity/.test(err.message),
  );
});

function contractedGithub(
  overrides: Record<string, unknown> = {},
): {
  selector: { type: "milestone" | "label" | "range" | "issues" | "explicit"; value: string };
  issue_ids: string[];
  pr_ids: string[];
  milestones: string[];
  dependency_edges: { from: string; to: string }[];
} {
  return {
    selector: { type: "milestone", value: "v2" },
    issue_ids: ["1", "3"],
    pr_ids: [],
    milestones: ["v2"],
    dependency_edges: [{ from: "1", to: "3" }],
    ...overrides,
  };
}

function githubObserverDeps(
  overrides: Partial<
    Pick<
      FactoryLiveObserverDeps,
      | "getIssue"
      | "getPull"
      | "listOpenIssues"
      | "listDependencyEdges"
      | "listMilestones"
    >
  > = {},
): Pick<
  FactoryLiveObserverDeps,
  | "getIssue"
  | "getPull"
  | "listOpenIssues"
  | "listDependencyEdges"
  | "listMilestones"
> {
  return {
    async getIssue(_repo, n) {
      return { number: n, state: "open" };
    },
    async getPull(_repo, n) {
      return { number: n, state: "OPEN" };
    },
    async listOpenIssues() {
      return [
        { number: 1, labels: [], milestone: "v2" },
        { number: 3, labels: [], milestone: "v2" },
      ];
    },
    async listDependencyEdges(_repo, issueIds) {
      const s = new Set(issueIds.map(String));
      const edges: { from: string; to: string }[] = [];
      if (s.has("1") && s.has("3")) edges.push({ from: "1", to: "3" });
      return edges;
    },
    async listMilestones() {
      return ["v2", "v3"];
    },
    ...overrides,
  };
}

test("observeFactoryGithubSnapshot resolves membership and edges from live queries", async () => {
  const listCalls: string[] = [];
  const deps = githubObserverDeps({
    async listOpenIssues(repo) {
      listCalls.push(repo);
      return [
        { number: 1, labels: [], milestone: "v2" },
        { number: 3, labels: [], milestone: "v2" },
        { number: 9, labels: [], milestone: "v3" },
      ];
    },
  });
  const ok = await observeFactoryGithubSnapshot(deps, {
    repo: "acme/widgets",
    // Contracted issue_ids deliberately stale — live membership must win.
    contracted: contractedGithub({ issue_ids: ["1", "3", "999"], dependency_edges: [] }),
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.observed?.issue_ids, ["1", "3"]);
  assert.deepEqual(ok.observed?.milestones, ["v2"]);
  assert.deepEqual(ok.observed?.dependency_edges, [{ from: "1", to: "3" }]);
  assert.deepEqual(listCalls, ["acme/widgets"]);
  // Contracted issue 999 must not be copied into observed.
  assert.ok(!ok.observed?.issue_ids.includes("999"));
});

test("observeFactoryGithubSnapshot fails closed when contracted PR is missing", async () => {
  const missingPr = await observeFactoryGithubSnapshot(
    githubObserverDeps({
      async getPull() {
        return null;
      },
    }),
    {
      repo: "acme/widgets",
      contracted: contractedGithub({ pr_ids: ["9"], dependency_edges: [] }),
    },
  );
  assert.equal(missingPr.ok, false);
  assert.match(missingPr.detail ?? "", /9/);
});

test("observeFactoryGithubSnapshot fails closed when selector milestone title is gone", async () => {
  const missingMs = await observeFactoryGithubSnapshot(
    githubObserverDeps({
      async listMilestones() {
        return ["v3"];
      },
      async listOpenIssues() {
        return [];
      },
    }),
    {
      repo: "acme/widgets",
      contracted: contractedGithub({
        selector: { type: "milestone", value: "gone" },
        issue_ids: [],
        milestones: ["gone"],
        dependency_edges: [],
      }),
    },
  );
  assert.equal(missingMs.ok, false);
  assert.match(missingMs.detail ?? "", /gone/);
});

test("observeFactoryGithubSnapshot never invents success for empty/invalid repo", async () => {
  const deps = githubObserverDeps({
    async listOpenIssues() {
      throw new Error("should not be called for invalid repo");
    },
  });
  const r = await observeFactoryGithubSnapshot(deps, {
    repo: "not-a-repo",
    contracted: contractedGithub({ issue_ids: [] }),
  });
  assert.equal(r.ok, false);
});

test("regression: live membership drift is observed (not contract-echoed) when label selection changes", async () => {
  // Bite check for finding 9d28f0d2: observing only contracted issue existence
  // would still return issue_ids ["1","3"] when the label membership shrank.
  const deps = githubObserverDeps({
    async listOpenIssues() {
      // Only #1 still has label "ship"; #3 lost it.
      return [
        { number: 1, labels: ["ship"], milestone: null },
        { number: 3, labels: ["other"], milestone: null },
      ];
    },
    async listDependencyEdges(_repo, issueIds) {
      assert.deepEqual(issueIds, ["1"]);
      return [];
    },
  });
  const snap = await observeFactoryGithubSnapshot(deps, {
    repo: "acme/widgets",
    contracted: contractedGithub({
      selector: { type: "label", value: "ship" },
      issue_ids: ["1", "3"],
      milestones: [],
      dependency_edges: [{ from: "1", to: "3" }],
    }),
  });
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.observed?.issue_ids, ["1"]);
  assert.deepEqual(snap.observed?.dependency_edges, []);
  assert.notDeepEqual(snap.observed?.issue_ids, ["1", "3"]);
});

test("regression: dependency edges come from live discovery, not contract edge filter", async () => {
  const deps = githubObserverDeps({
    async listOpenIssues() {
      return [
        { number: 1, labels: [], milestone: "v2" },
        { number: 3, labels: [], milestone: "v2" },
      ];
    },
    async listDependencyEdges(_repo, issueIds) {
      assert.deepEqual([...issueIds].sort(), ["1", "3"]);
      // Live graph differs from contracted {from:1,to:3}.
      return [{ from: "3", to: "1" }];
    },
  });
  const snap = await observeFactoryGithubSnapshot(deps, {
    repo: "acme/widgets",
    contracted: contractedGithub({
      issue_ids: ["1", "3"],
      dependency_edges: [{ from: "1", to: "3" }],
    }),
  });
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.observed?.dependency_edges, [{ from: "3", to: "1" }]);
});

test("observeFactoryGithubSnapshot fails closed when open-issue or dependency queries are unavailable", async () => {
  const noList = await observeFactoryGithubSnapshot(
    githubObserverDeps({
      async listOpenIssues() {
        return null;
      },
    }),
    { repo: "acme/widgets", contracted: contractedGithub() },
  );
  assert.equal(noList.ok, false);
  assert.match(noList.detail ?? "", /open-issue listing unavailable/);

  const noDeps = await observeFactoryGithubSnapshot(
    githubObserverDeps({
      async listDependencyEdges() {
        return null;
      },
    }),
    { repo: "acme/widgets", contracted: contractedGithub() },
  );
  assert.equal(noDeps.ok, false);
  assert.match(noDeps.detail ?? "", /dependency-edge discovery unavailable/);
});

test("computeEffectiveConfigFingerprints is stable and pin-sensitive", () => {
  const cfg = makeCfg();
  const a = computeEffectiveConfigFingerprints(cfg, null);
  const b = computeEffectiveConfigFingerprints(cfg, null);
  assert.deepEqual(a, b);
  for (const k of ["authority_policy", "engine_pin", "configuration", "treatment"] as const) {
    assert.equal(a[k].length, 64);
    assert.notEqual(a[k], "unknown");
  }
  const withPin = computeEffectiveConfigFingerprints(cfg, {
    version: "1.2.3",
    tag: "v1.2.3",
    git_sha: "c".repeat(40),
  });
  assert.notEqual(withPin.engine_pin, a.engine_pin);
  // Same pin content → same engine_pin fingerprint.
  assert.equal(
    withPin.engine_pin,
    computeEffectiveConfigFingerprints(cfg, {
      version: "1.2.3",
      tag: "v1.2.3",
      git_sha: "c".repeat(40),
    }).engine_pin,
  );
  void sha; // keep helper available if assertion style changes
});

test("buildFactoryMacroDeps wires real observers — no synthetic unknown/ok:true defaults", async () => {
  const sha40 = "d".repeat(40);
  const issueCalls: number[] = [];
  const macro = buildFactoryMacroDeps({
    store: fakeStore(),
    cfg: makeCfg({ repo: "acme/widgets", base_branch: "main" }) as never,
    repoDir: "/repo",
    observers: {
      async git(_dir, args) {
        if (args.includes("origin/main") || args.includes("main")) {
          return { stdout: sha40, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "missing", code: 128 };
      },
      async getIssue(_repo, n) {
        issueCalls.push(n);
        return { number: n, state: "open" };
      },
      async getPull(_repo, n) {
        return { number: n, state: "OPEN" };
      },
      async listOpenIssues() {
        return [{ number: 42, labels: [], milestone: null }];
      },
      async listDependencyEdges() {
        return [];
      },
      async listMilestones() {
        return ["v2"];
      },
      async readEnginePin() {
        return null;
      },
      loopStore: fakeLoopStore(),
      now: () => new Date("2026-08-07T21:00:00.000Z"),
    },
  });

  assert.equal(await macro.observeBaseSha("/repo", "main"), sha40);
  assert.deepEqual(await macro.observeRepoIdentity({ repoDir: "/repo", baseBranch: "main" }), {
    name: "acme/widgets",
    base_branch: "main",
  });
  const contracted = contractedGithub({
    issue_ids: ["42"],
    milestones: [],
    dependency_edges: [],
    selector: { type: "issues", value: "42" },
  });
  const gh = await macro.observeGithubSnapshot({
    repo: "acme/widgets",
    contracted,
  });
  assert.equal(gh.ok, true);
  assert.deepEqual(gh.observed?.issue_ids, ["42"]);
  assert.deepEqual(issueCalls, [42]);

  const fps = await macro.readConfigFingerprints();
  assert.notEqual(fps.authority_policy, "unknown");
  assert.notEqual(fps.configuration, "unknown");
  assert.equal(fps.configuration.length, 64);

  // start without linked loop fails closed (no invented loop id).
  await assert.rejects(
    () =>
      macro.startOrResumeLoop({
        factory_run_id: "frun-1",
        revision: 1,
        loop_run_id: null,
        action_id: "a1",
      }),
    (err: unknown) =>
      err instanceof FactoryError && /cannot create a new durable loop/.test(err.message),
  );
  // Linked loop is observed by identity only.
  assert.deepEqual(
    await macro.startOrResumeLoop({
      factory_run_id: "frun-1",
      revision: 1,
      loop_run_id: "loop-existing",
      action_id: "a1",
    }),
    { loop_run_id: "loop-existing" },
  );

  // Missing loop → not_found (never fabricate running).
  assert.deepEqual(await macro.observeLoop("missing-loop"), { state: "not_found" });
});

test("childStatusFromLoopStatus maps stop and active items", () => {
  const base: LoopStatus = {
    run_id: "loop-1",
    engine: "e",
    repo: { name: "acme/widgets", base_branch: "main" } as never,
    canonical_hash: "h",
    items: { "1": { state: "in_progress" } },
    active_items: ["1"],
    recovery_budgets_remaining: null,
    consecutive_blocked: 0,
    merge_barrier: null as never,
    stop: null,
    lock: { holder: null, staleness: null },
    last_reconciliation: null,
    event_count: 0,
    outstanding_requests: {},
    authority_amendments: [],
    supervisor: null,
    action_evidence: [],
    consecutive_no_progress: 0,
    supersedes: null,
    superseded_by: null,
  };
  assert.deepEqual(childStatusFromLoopStatus(base), { state: "running", run_id: "loop-1" });

  const done: LoopStatus = {
    ...base,
    items: { "1": { state: "ready" }, "2": { state: "ready" } },
    active_items: [],
    stop: { reason: "complete", at: "t" } as never,
  };
  const completed = childStatusFromLoopStatus(done);
  assert.equal(completed.state, "completed");
  if (completed.state === "completed") {
    assert.equal(completed.all_items_terminal, true);
    assert.equal(completed.all_ready_to_deploy, true);
  }
});

test("regression: synthetic unknown fingerprints and ok:true without getIssue must not be the CLI default", async () => {
  // Bite check for finding 25b9759a: buildFactoryMacroDeps must not return
  // literal "unknown" fingerprints or unconditional {ok:true} GitHub snapshots.
  const issueCalls: number[] = [];
  const macro = buildFactoryMacroDeps({
    store: fakeStore(),
    cfg: makeCfg() as never,
    repoDir: "/repo",
    observers: {
      async git() {
        return { stdout: "e".repeat(40), stderr: "", code: 0 };
      },
      async getIssue(_r, n) {
        issueCalls.push(n);
        return null;
      },
      async getPull() {
        return null;
      },
      async listOpenIssues() {
        return [];
      },
      async listDependencyEdges() {
        return [];
      },
      async listMilestones() {
        return [];
      },
      async readEnginePin() {
        return null;
      },
      loopStore: fakeLoopStore(),
      now: () => new Date(),
    },
  });
  const fps = await macro.readConfigFingerprints();
  assert.notEqual(fps.authority_policy, "unknown");
  assert.notEqual(fps.engine_pin, "unknown");
  assert.notEqual(fps.configuration, "unknown");
  assert.notEqual(fps.treatment, "unknown");

  const snap = await macro.observeGithubSnapshot({
    repo: "acme/widgets",
    contracted: contractedGithub({
      issue_ids: ["99"],
      milestones: [],
      dependency_edges: [],
      selector: { type: "issues", value: "99" },
    }),
  });
  // Explicit selector with unreadable #99 → empty membership + ok snapshot that
  // will drift vs contract (or empty edges). Membership is observed, not echoed.
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.observed?.issue_ids, []);
  assert.equal(issueCalls.length, 1);
});
