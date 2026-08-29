import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  defaultCollectHybridV2FromRun,
  githubItemObservationsFromLiveIssues,
  overlayLedgerStateFromGitHub,
  resolvePackedCandidateIdentity,
  selectPackPr,
  type HybridV2FromRunArgs,
  type HybridV2FromRunDeps,
  type LayerAProbeRunInput,
  type LoopBindingPresence,
} from "../scripts/frg-hybrid-v2-from-run.ts";
import {
  loadFrgPack,
  defaultFrgPackRoot,
  renderFrgPackIssues,
} from "../scripts/frg-pack-observations.ts";
import { LAUNCHER_REL } from "../scripts/ship-end-candidate.ts";

const PIN_P = "a884d1ed9303eb32bc486063d976c5ad28c74553";
const CANDIDATE_C = "6670cee2b2659bc8350e98c1a2a34b53299b995b";
const CONTROL_REPO = "/control-repo";
const CANDIDATE_ENGINE = "/candidate-engine";

function fakeEngine(engineRoot: string, commitSha: string) {
  return {
    ok: true as const,
    engine: {
      engineRoot,
      launcherPath: path.join(engineRoot, LAUNCHER_REL),
      commitSha,
    },
  };
}

function fakeProbe(
  probe: { id: string; test_file: string; test_name: string },
  input: LayerAProbeRunInput,
) {
  return {
    id: probe.id,
    candidate_git_sha: input.candidateGitSha,
    test_file: probe.test_file,
    test_name: probe.test_name,
    command_argv_sha256: "b".repeat(64),
    stdout_sha256: "c".repeat(64),
    stderr_sha256: "d".repeat(64),
    started_at: "2026-08-18T06:00:00Z",
    finished_at: "2026-08-18T06:00:01Z",
  };
}

function standaloneCollectDeps(overrides: HybridV2FromRunDeps = {}): HybridV2FromRunDeps {
  return {
    gitHead: async () => "a".repeat(40),
    readLoopBinding: async () => ({ present: false }),
    resolveCandidateEngine: async ({ candidateSha, repoDir }) =>
      fakeEngine(repoDir, candidateSha),
    runProbe: async (probe, input) => fakeProbe(probe, input),
    ...overrides,
  };
}

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
      ...standaloneCollectDeps({
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
      }),
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

test("githubItemObservationsFromLiveIssues threads bound PR checks by issue (#1297)", () => {
  const observations = githubItemObservationsFromLiveIssues([
    {
      issue_number: 1290,
      labels: ["factory-gate", "pipeline:ready-to-deploy"],
      pr: {
        number: 1292,
        checks: [{ conclusion: "success" }],
      },
    } as never,
  ]);
  assert.equal(observations["1290"]?.pr_number, 1292);
  assert.equal(observations["1290"]?.checks[0]?.conclusion, "success");
});

test("overlayLedgerStateFromGitHub promotes blocked to ready on R2D plus green checks (#1165)", () => {
  assert.equal(
    overlayLedgerStateFromGitHub("blocked", {
      labels: ["factory-gate", "pipeline:ready-to-deploy"],
      checks: [{ conclusion: "success" }],
    }),
    "ready",
  );
  assert.equal(
    overlayLedgerStateFromGitHub("blocked", {
      labels: ["factory-gate", "pipeline:ready"],
      checks: [{ conclusion: "success" }],
    }),
    "blocked",
  );
  assert.equal(
    overlayLedgerStateFromGitHub("blocked", {
      labels: ["pipeline:ready-to-deploy"],
      checks: [{ conclusion: "failure" }],
    }),
    "blocked",
  );
  assert.equal(
    overlayLedgerStateFromGitHub("ready", {
      labels: ["pipeline:ready-to-deploy"],
      checks: [{ conclusion: "success" }],
    }),
    "ready",
  );
});

test("overlayLedgerStateFromGitHub demotes stale ready when GitHub is not live-ready (#1162)", () => {
  assert.equal(
    overlayLedgerStateFromGitHub("ready", {
      labels: ["factory-gate", "pipeline:ready"],
      checks: [{ conclusion: "success" }],
    }),
    "blocked",
  );
  assert.equal(
    overlayLedgerStateFromGitHub("ready", {
      labels: ["pipeline:ready-to-deploy"],
      checks: [{ conclusion: "failure" }],
    }),
    "blocked",
  );
  assert.equal(
    overlayLedgerStateFromGitHub("ready", {
      labels: ["pipeline:ready-to-deploy"],
      checks: [{ conclusion: "pending" }],
    }),
    "blocked",
  );
});

test("from-run collect does not throw did-not-finish-clean when GitHub is R2D over blocked ledger (#1165)", async () => {
  const pack = await loadFrgPack(defaultFrgPackRoot());
  let err: Error | null = null;
  try {
    await defaultCollectHybridV2FromRun(
      {
        repoDir: "/repo",
        version: "1.39.6",
        fromRun: "loop-d4ddcf07837a6ae0",
        contract: {
          items: [{ id: "1158" }, { id: "1159" }],
          repo: { base_branch: "main" },
          selector: { type: "label", value: "factory-gate" },
        } as never,
        ledger: {
          items: {
            "1158": { state: "blocked", advance_run_id: "advance-1158", blocked_theme: "recovery_exhausted" },
            "1159": { state: "blocked", advance_run_id: "advance-1159", blocked_theme: "recovery_exhausted" },
          },
        } as never,
      },
      {
        loadPack: async () => pack,
        ...standaloneCollectDeps({
        ghJson: async (args) => {
          if (args[0] === "repo") return { nameWithOwner: "org/agent-pipeline" };
          if (args[0] === "issue") {
            const n = Number(args[2]);
            const template = n === 1158 ? "clean-docs" : "clean-openspec";
            return {
              number: n,
              id: `I${n}`,
              title: template,
              body: `template_id=${template}\npack_run_id=pack-1396-goal-ship-1.39.6`,
              createdAt: "2026-08-20T05:08:57Z",
              labels: [{ name: "factory-gate" }, { name: "pipeline:ready-to-deploy" }],
            };
          }
          if (args[0] === "pr") {
            const issue = args.includes("1158") ? 1158 : 1159;
            return [
              {
                number: issue + 10,
                id: `P${issue}`,
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
        }),
      },
    );
  } catch (e) {
    err = e as Error;
  }
  if (err) {
    assert.doesNotMatch(
      err.message,
      /did not finish clean at ready-to-deploy/,
      `overlay must prevent ledger-blocked throw; got: ${err.message}`,
    );
  }
});

async function collectFromRunWithGitHub(opts: {
  ledgerState: string;
  labels: Array<{ name: string }>;
  conclusion: string;
}): Promise<void> {
  const pack = await loadFrgPack(defaultFrgPackRoot());
  await defaultCollectHybridV2FromRun(
    {
      repoDir: "/repo",
      version: "1.39.6",
      fromRun: "loop-d4ddcf07837a6ae0",
      contract: {
        items: [{ id: "1158" }, { id: "1159" }],
        repo: { base_branch: "main" },
        selector: { type: "label", value: "factory-gate" },
      } as never,
      ledger: {
        items: {
          "1158": { state: opts.ledgerState, advance_run_id: "advance-1158", blocked_theme: null },
          "1159": { state: opts.ledgerState, advance_run_id: "advance-1159", blocked_theme: null },
        },
      } as never,
    },
    {
      loadPack: async () => pack,
      ...standaloneCollectDeps({
      ghJson: async (args) => {
        if (args[0] === "repo") return { nameWithOwner: "org/agent-pipeline" };
        if (args[0] === "issue") {
          const n = Number(args[2]);
          const template = n === 1158 ? "clean-docs" : "clean-openspec";
          return {
            number: n,
            id: `I${n}`,
            title: template,
            body: `template_id=${template}\npack_run_id=pack-1396-goal-ship-1.39.6`,
            createdAt: "2026-08-20T05:08:57Z",
            labels: opts.labels,
          };
        }
        if (args[0] === "pr") {
          const issue = args.includes("1158") ? 1158 : 1159;
          return [
            {
              number: issue + 10,
              id: `P${issue}`,
              headRefOid: "e".repeat(40),
              baseRefName: "main",
              files: [{ path: "core/test/x.ts" }],
              title: `pack (#${issue})`,
              state: "closed",
            },
          ];
        }
        if (args[0] === "api") {
          return [{ check_runs: [{ id: 1, name: "test", head_sha: "e".repeat(40), conclusion: opts.conclusion }] }];
        }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
      }),
    },
  );
}

test("from-run collect throws when ready ledger is missing GitHub ready-to-deploy (#1162)", async () => {
  await assert.rejects(
    () =>
      collectFromRunWithGitHub({
        ledgerState: "ready",
        labels: [{ name: "factory-gate" }, { name: "pipeline:ready" }],
        conclusion: "success",
      }),
    /did not finish clean at ready-to-deploy/,
  );
});

test("from-run collect throws when ready ledger has a failed GitHub check (#1162)", async () => {
  await assert.rejects(
    () =>
      collectFromRunWithGitHub({
        ledgerState: "ready",
        labels: [{ name: "factory-gate" }, { name: "pipeline:ready-to-deploy" }],
        conclusion: "failure",
      }),
    /did not finish clean at ready-to-deploy/,
  );
});

test("resolvePackedCandidateIdentity stamps binding C, not standalone HEAD (#1298)", () => {
  assert.deepEqual(
    resolvePackedCandidateIdentity({
      request: { sha: CANDIDATE_C },
      binding: { present: true, candidateGitSha: CANDIDATE_C },
    }),
    { ok: true, mode: "ship-path", sha: CANDIDATE_C },
  );
  assert.deepEqual(
    resolvePackedCandidateIdentity({
      request: null,
      binding: { present: true, candidateGitSha: CANDIDATE_C },
    }),
    { ok: true, mode: "ship-path", sha: CANDIDATE_C },
  );
  assert.deepEqual(resolvePackedCandidateIdentity({ request: null, binding: { present: false } }), {
    ok: true,
    mode: "standalone",
  });
});

test("resolvePackedCandidateIdentity fails closed on missing, malformed, or conflicting sources (#1298)", () => {
  const missing = resolvePackedCandidateIdentity({
    request: { sha: CANDIDATE_C },
    binding: { present: false },
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /missing ship-path factory-release-binding/);

  const malformedBinding = resolvePackedCandidateIdentity({
    request: { sha: CANDIDATE_C },
    binding: { present: true, candidateGitSha: "not-a-sha" },
  });
  assert.equal(malformedBinding.ok, false);
  if (!malformedBinding.ok) assert.match(malformedBinding.error, /factory-release-binding.json/);

  const malformedRequest = resolvePackedCandidateIdentity({
    request: { sha: PIN_P.slice(0, 7) },
    binding: { present: true, candidateGitSha: CANDIDATE_C },
  });
  assert.equal(malformedRequest.ok, false);
  if (!malformedRequest.ok) assert.match(malformedRequest.error, /integrated_candidate.git_sha/);

  const conflict = resolvePackedCandidateIdentity({
    request: { sha: PIN_P },
    binding: { present: true, candidateGitSha: CANDIDATE_C },
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.match(conflict.error, /conflict/);
});

const ISSUE_DOCS = 12981;
const ISSUE_OPEN_SPEC = 12982;
const PACK_RUN_ID = "pack-13915-goal-ship-1.39.15";
const LOOP_RUN_ID = "loop-frg-1298";

async function collectPackedCandidate(opts: {
  requestCandidateGitSha?: string;
  binding: LoopBindingPresence;
  gitHead?: HybridV2FromRunDeps["gitHead"];
  resolveCandidateEngine?: HybridV2FromRunDeps["resolveCandidateEngine"];
  runProbe?: HybridV2FromRunDeps["runProbe"];
  ghJson?: HybridV2FromRunDeps["ghJson"];
}): Promise<{
  observations: Awaited<ReturnType<typeof defaultCollectHybridV2FromRun>>;
  probeInputs: LayerAProbeRunInput[];
  engineCalls: Array<{ repoDir: string; candidateSha: string }>;
  gitHeadCalls: string[];
}> {
  const pack = await loadFrgPack(defaultFrgPackRoot());
  const rendered = renderFrgPackIssues(pack, {
    release_version: "1.39.15",
    pack_run_id: PACK_RUN_ID,
  });
  const probeInputs: LayerAProbeRunInput[] = [];
  const engineCalls: Array<{ repoDir: string; candidateSha: string }> = [];
  const gitHeadCalls: string[] = [];
  const args: HybridV2FromRunArgs = {
    repoDir: CONTROL_REPO,
    version: "1.39.15",
    fromRun: LOOP_RUN_ID,
    requestCandidateGitSha: opts.requestCandidateGitSha,
    contract: {
      items: [{ id: String(ISSUE_DOCS) }, { id: String(ISSUE_OPEN_SPEC) }],
      repo: { base_branch: "main" },
      selector: { type: "label", value: "factory-gate" },
    } as never,
    ledger: {
      items: {
        [String(ISSUE_DOCS)]: { state: "ready", advance_run_id: "advance-docs", blocked_theme: null },
        [String(ISSUE_OPEN_SPEC)]: { state: "ready", advance_run_id: "advance-openspec", blocked_theme: null },
      },
    } as never,
  };
  const observations = await defaultCollectHybridV2FromRun(args, {
    loadPack: async () => pack,
    readLoopBinding: async () => opts.binding,
    gitHead: async (repoDir) => {
      gitHeadCalls.push(repoDir);
      if (opts.gitHead) return opts.gitHead(repoDir);
      throw new Error(`gitHead(${repoDir}) must not run`);
    },
    resolveCandidateEngine: async (engineOpts) => {
      engineCalls.push(engineOpts);
      if (opts.resolveCandidateEngine) return opts.resolveCandidateEngine(engineOpts);
      return fakeEngine(CANDIDATE_ENGINE, engineOpts.candidateSha);
    },
    runProbe: async (probe, input) => {
      probeInputs.push(input);
      if (opts.runProbe) return opts.runProbe(probe, input);
      return fakeProbe(probe, input);
    },
    ghJson: opts.ghJson ?? (async (ghArgs) => {
      if (ghArgs[0] === "repo") return { nameWithOwner: "org/agent-pipeline" };
      if (ghArgs[0] === "issue") {
        const n = Number(ghArgs[2]);
        const renderedIssue = n === ISSUE_DOCS ? rendered[0] : rendered[1];
        if (!renderedIssue) throw new Error(`missing rendered issue ${n}`);
        return {
          number: n,
          id: `ISSUE_${n}`,
          title: renderedIssue.title,
          body: renderedIssue.body,
          createdAt: n === ISSUE_DOCS ? "2026-08-18T05:08:57Z" : "2026-08-18T05:08:59Z",
          labels: [{ name: "factory-gate" }, { name: "pipeline:ready" }, { name: "pipeline:ready-to-deploy" }],
        };
      }
      if (ghArgs[0] === "pr") {
        const search = String(ghArgs[ghArgs.indexOf("--search") + 1] ?? "");
        const issue = search.startsWith(`${ISSUE_DOCS} `) ? ISSUE_DOCS : ISSUE_OPEN_SPEC;
        const renderedIssue = issue === ISSUE_DOCS ? rendered[0] : rendered[1];
        const files =
          renderedIssue?.provenance.template_id === "clean-openspec"
            ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
            : ["docs/frg-fixture.md"];
        return [
          {
            number: issue + 10,
            id: `PR_${issue}`,
            headRefOid: "e".repeat(40),
            baseRefName: "main",
            files: files.map((p) => ({ path: p })),
            title: renderedIssue?.title,
            state: "closed",
          },
        ];
      }
      if (ghArgs[0] === "api") {
        return [{ check_runs: [{ id: 1, name: "test", head_sha: "e".repeat(40), conclusion: "success" }] }];
      }
      throw new Error(`unexpected gh ${ghArgs.join(" ")}`);
    }),
  });
  return { observations, probeInputs, engineCalls, gitHeadCalls };
}

test("from-run collect stamps request packed candidate C when control HEAD is pin P (#1298)", async () => {
  const { observations, probeInputs, engineCalls, gitHeadCalls } = await collectPackedCandidate({
    requestCandidateGitSha: CANDIDATE_C,
    binding: { present: true, candidateGitSha: CANDIDATE_C },
    gitHead: async (repoDir) => {
      throw new Error(`gitHead(${repoDir}) must not be used for ship-path identity`);
    },
  });
  assert.equal(observations.pack_provenance.candidate_git_sha, CANDIDATE_C);
  assert.notEqual(observations.pack_provenance.candidate_git_sha, PIN_P);
  assert.ok(probeInputs.length > 0);
  for (const input of probeInputs) {
    assert.equal(input.candidateGitSha, CANDIDATE_C);
    assert.equal(input.candidateEngineDir, CANDIDATE_ENGINE);
    assert.equal(input.repoDir, CONTROL_REPO);
    assert.notEqual(input.candidateEngineDir, CONTROL_REPO);
  }
  for (const probe of observations.pack_provenance.probes) {
    assert.equal(probe.candidate_git_sha, CANDIDATE_C);
  }
  assert.deepEqual(
    engineCalls,
    [{ repoDir: CONTROL_REPO, candidateSha: CANDIDATE_C }],
  );
  assert.deepEqual(gitHeadCalls, []);
});

test("from-run collect CLI binding-only path stamps C without gitHead(repoDir) (#1298)", async () => {
  const { observations, gitHeadCalls } = await collectPackedCandidate({
    binding: { present: true, candidateGitSha: CANDIDATE_C },
  });
  assert.equal(observations.pack_provenance.candidate_git_sha, CANDIDATE_C);
  assert.deepEqual(gitHeadCalls, []);
});

test("from-run collect fails closed before probes when ship-path binding is missing (#1298)", async () => {
  let probes = 0;
  await assert.rejects(
    () =>
      collectPackedCandidate({
        requestCandidateGitSha: CANDIDATE_C,
        binding: { present: false },
        runProbe: async (probe, input) => {
          probes++;
          return fakeProbe(probe, input);
        },
      }),
    /missing ship-path factory-release-binding/,
  );
  assert.equal(probes, 0);
});

test("from-run collect fails closed before probes on malformed present binding (#1298)", async () => {
  let probes = 0;
  await assert.rejects(
    () =>
      collectPackedCandidate({
        requestCandidateGitSha: CANDIDATE_C,
        binding: { present: true, candidateGitSha: "not-a-sha" },
        runProbe: async (probe, input) => {
          probes++;
          return fakeProbe(probe, input);
        },
      }),
    /factory-release-binding.json candidate_git_sha/,
  );
  assert.equal(probes, 0);
});

test("from-run collect fails closed before probes when request and binding conflict (#1298)", async () => {
  let probes = 0;
  await assert.rejects(
    () =>
      collectPackedCandidate({
        requestCandidateGitSha: PIN_P,
        binding: { present: true, candidateGitSha: CANDIDATE_C },
        runProbe: async (probe, input) => {
          probes++;
          return fakeProbe(probe, input);
        },
      }),
    /packed-candidate SHAs conflict/,
  );
  assert.equal(probes, 0);
});

test("from-run collect fails closed before TAP when candidate engine for C cannot be resolved (#1298)", async () => {
  let probes = 0;
  await assert.rejects(
    () =>
      collectPackedCandidate({
        requestCandidateGitSha: CANDIDATE_C,
        binding: { present: true, candidateGitSha: CANDIDATE_C },
        resolveCandidateEngine: async () => ({
          ok: false,
          error: `cannot resolve candidate engine at ${CANDIDATE_C}: need a clean checkout at that SHA`,
        }),
        runProbe: async (probe, input) => {
          probes++;
          return fakeProbe(probe, input);
        },
      }),
    /cannot resolve candidate engine/,
  );
  assert.equal(probes, 0);
});

test("from-run collect rejects pin-source TAP labeled as packed candidate C (#1298)", async () => {
  await assert.rejects(
    () =>
      collectPackedCandidate({
        requestCandidateGitSha: CANDIDATE_C,
        binding: { present: true, candidateGitSha: CANDIDATE_C },
        runProbe: async (probe, input) => ({
          ...fakeProbe(probe, input),
          candidate_git_sha: PIN_P,
        }),
      }),
    /not bound to the exact candidate test probe/,
  );
});

test("standalone from-run collect keeps repoDir HEAD when no request and no binding (#1298)", async () => {
  const { observations, probeInputs, gitHeadCalls } = await collectPackedCandidate({
    binding: { present: false },
    gitHead: async (repoDir) => {
      assert.equal(repoDir, CONTROL_REPO);
      return PIN_P;
    },
    resolveCandidateEngine: async ({ repoDir, candidateSha }) => {
      assert.equal(candidateSha, PIN_P);
      return fakeEngine(repoDir, candidateSha);
    },
  });
  assert.equal(observations.pack_provenance.candidate_git_sha, PIN_P);
  assert.deepEqual(gitHeadCalls, [CONTROL_REPO]);
  for (const input of probeInputs) {
    assert.equal(input.candidateGitSha, PIN_P);
    assert.equal(input.candidateEngineDir, CONTROL_REPO);
  }
});
