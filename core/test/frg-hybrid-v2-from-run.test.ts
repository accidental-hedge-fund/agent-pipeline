import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCollectHybridV2FromRun, selectPackPr } from "../scripts/frg-hybrid-v2-from-run.ts";
import { loadFrgPack, defaultFrgPackRoot } from "../scripts/frg-pack-observations.ts";

test("selectPackPr prefers the open titled pack PR", () => {
  const pr = selectPackPr(1121, [
    { title: "other (#9)", state: "open", number: 9 },
    { title: "docs (#1121)", state: "closed", number: 1123 },
    { title: "docs (#1121)", state: "open", number: 1200 },
  ]);
  assert.equal(pr?.number, 1200);
});

test("selectPackPr accepts a closed titled pack PR after factory-gate auto-close", () => {
  const pr = selectPackPr(1122, [
    { title: "openspec (#1122)", state: "closed", number: 1124 },
    { title: "unrelated (#7)", state: "open", number: 7 },
  ]);
  assert.equal(pr?.number, 1124);
});

test("selectPackPr returns undefined when no PR exists", () => {
  assert.equal(selectPackPr(1121, []), undefined);
});

test("collect lists pack PRs with --state all so a post-score close can still bind", async () => {
  const pack = await loadFrgPack(defaultFrgPackRoot());
  const calls: string[][] = [];
  try {
  await defaultCollectHybridV2FromRun(
    {
      repoDir: "/repo",
      version: "1.39.3",
      fromRun: "loop-e293186c04a17d17",
      contract: {
        items: [{ id: "1121" }, { id: "1122" }],
        repo: { base_branch: "main" },
        selector: { type: "label", value: "factory-gate" },
      } as never,
      ledger: { items: {} } as never,
    },
    {
      loadPack: async () => pack,
      gitHead: async () => "a".repeat(40),
      runProbe: async (probe, input) => ({
        id: probe.id,
        candidate_git_sha: input.candidateGitSha,
        test_file: probe.test_file,
        test_name: probe.test_name,
        command_argv_sha256: "b".repeat(64),
        stdout_sha256: "c".repeat(64),
        stderr_sha256: "d".repeat(64),
        started_at: "2026-08-18T00:00:00Z",
        finished_at: "2026-08-18T00:00:01Z",
      }),
      ghJson: async (args) => {
        calls.push(args);
        if (args[0] === "repo") return { nameWithOwner: "org/agent-pipeline" };
        if (args[0] === "issue" && args[2] === "1121") {
          return {
            number: 1121,
            id: "I1",
            title: "docs",
            body: "template_id=clean-docs\npack_run_id=pack-1393-goal-ship-1.39.3",
            createdAt: "2026-08-18T05:08:57Z",
            labels: [{ name: "factory-gate" }, { name: "pipeline:ready-to-deploy" }],
          };
        }
        if (args[0] === "issue" && args[2] === "1122") {
          return {
            number: 1122,
            id: "I2",
            title: "openspec",
            body: "template_id=clean-openspec\npack_run_id=pack-1393-goal-ship-1.39.3",
            createdAt: "2026-08-18T05:08:59Z",
            labels: [{ name: "factory-gate" }, { name: "pipeline:ready-to-deploy" }],
          };
        }
        if (args[0] === "pr") {
          const issue = args.includes("1121") ? 1121 : 1122;
          return [
            {
              number: issue === 1121 ? 1123 : 1124,
              id: issue === 1121 ? "P1" : "P2",
              headRefOid: "e".repeat(40),
              baseRefName: "main",
              files: [{ path: "core/test/x.ts" }],
              title: `pack (#${issue})`,
              state: "closed",
            },
          ];
        }
        if (args[0] === "api") {
          return [{ check_runs: [{ id: 1, name: "test", head_sha: "e".repeat(40), conclusion: "success" }] }];
        }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
    },
  );
  } catch {
    // Observation schema after PR lookup is out of scope; this test only
    // locks the pack-PR list state.
  }
  const prLists = calls.filter((args) => args[0] === "pr" && args[1] === "list");
  assert.equal(prLists.length, 2);
  for (const args of prLists) {
    const stateIdx = args.indexOf("--state");
    assert.ok(stateIdx >= 0);
    assert.equal(args[stateIdx + 1], "all");
  }
});
