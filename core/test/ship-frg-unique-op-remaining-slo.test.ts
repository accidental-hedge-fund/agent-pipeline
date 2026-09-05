// Remaining unique-operation SLO cells (#1440).
// Hermetic command persist + one live local-git inventory attach. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { FAULT_RECOVERY_MATRIX } from "../scripts/fault-recovery-matrix.ts";
import {
  REQUIRED_LIFECYCLE_CLASSES_1333,
  passingUniqueOperationManifest,
  uniqueOperationSloFailure,
} from "../scripts/operation-reliability.ts";
import {
  FRG_PACK_MANIFEST,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  runFactoryGate,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";
import {
  CANDIDATE_FAULT_RECOVERY_INVENTORY_REL,
  defaultLoadCandidateFaultRecoveryInventory,
  defaultScoreBoundPackLoop,
} from "../scripts/factory-release-prepare.ts";
import { runSingleIssueCommand } from "../scripts/pipeline.ts";
import { persistPublicEntrypointAdmission } from "../scripts/run-store.ts";
import { parseExactGitSha } from "../scripts/ship-end-identity.ts";

const execFileAsync = promisify(execFile);
const GENERIC = "/control-repo/.agent-pipeline/runs";
const STATE_HOME = "/host-state/runs";

function memFs(files: Map<string, string>): FrgFsDeps {
  return {
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async mkdir() {},
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT rename ${from}`);
      files.set(to, v);
      files.delete(from);
    },
    async readdir(p) {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      return [...names].map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

function writeUnboundPrefixRun(files: Map<string, string>, root: string, runId: string): void {
  const dir = `${root}/${runId}`;
  files.set(`${dir}/run.json`, JSON.stringify({ run_id: runId }));
  files.set(`${dir}/events.jsonl`, JSON.stringify({ type: "run_start", run_id: runId }) + "\n");
}

function scoreInput(candidateSha: string) {
  return {
    version: "1.29.1",
    run_id: "frg-1440-live",
    loop_run_id: "loop-pack-only",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready" as const, ready_clean: true },
      { item_id: "2", state: "ready" as const, ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: null,
    unique_operation_manifest: {
      ...passingUniqueOperationManifest({
        release_identity: "1.29.1",
        candidate_sha: candidateSha,
      }),
      live_train_linkage_present: false,
      in_flight_ship: true,
    },
  };
}

test("runSingleIssueCommand persists a single admission on public pipeline single (#1440)", async () => {
  const original = process.exitCode;
  const originalError = console.error;
  process.exitCode = 0;
  console.error = () => {};
  const persisted: Array<{ kind: string; issue?: number; repoDir: string }> = [];
  let childLogicalOperationId: string | undefined;
  try {
    const result = await runSingleIssueCommand(
      "42",
      { profile: "codex" },
      {
        resolveConfig: () =>
          ({
            repo_dir: "/tmp/repo",
            repo: "o/r",
            base_branch: "main",
            domain: "o-r",
          }) as never,
        resolveIssueNumber: async (_c, n) => n,
        persistPublicAdmission: async (opts) => {
          persisted.push({ kind: opts.kind, issue: opts.issue, repoDir: opts.repoDir });
          return {
            acknowledged: true,
            runId: "single-test",
            runDir: "/tmp/repo/.agent-pipeline/runs/single-test",
            logicalOperationId: "lop-single-test",
          } as never;
        },
        runLoopEngine: async (input) => {
          childLogicalOperationId = input.logicalOperationId;
          return ({
          kind: "drive",
          result: {
            runId: "loop-child-of-single",
            cycles: 1,
            stop: null,
            holdOutstanding: false,
            allDone: true,
            resumed: false,
            heldItemIds: [],
            dispatched: 1,
            excludedItemIds: [],
            exclusionReason: null,
            completion: "complete",
          },
          });
        },
        writeStdoutLine: () => {},
      },
      { persistPublicAdmission: true, emitMachineOutput: false },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.runId, "loop-child-of-single");
    assert.deepEqual(persisted, [{ kind: "single", issue: 42, repoDir: "/tmp/repo" }]);
    assert.equal(childLogicalOperationId, "lop-single-test");
  } finally {
    process.exitCode = original;
    console.error = originalError;
  }
});

test("runSingleIssueCommand refuses drive and retains owned evidence after admission failure", async () => {
  const original = process.exitCode;
  const originalError = console.error;
  process.exitCode = 0;
  console.error = () => {};
  let drives = 0;
  const observations: unknown[] = [];
  try {
    const result = await runSingleIssueCommand(
      "42",
      { profile: "codex" },
      {
        resolveConfig: () => ({
          repo_dir: "/candidate",
          repo: "o/r",
          base_branch: "main",
          domain: "github.com/o/r",
        }) as never,
        resolveIssueNumber: async (_c, n) => n,
        persistPublicAdmission: async () => ({
          acknowledged: false,
          kind: "single",
          runId: "single-refused",
          logicalOperationId: "lop-refused",
          repository: "o/r",
          domain: "github.com/o/r",
          issue: 42,
          startedAt: "2026-09-05T00:00:00Z",
          approvedRoot: null,
          runDir: null,
          binding: {},
          failure: {
            kind: "approved_root_unavailable",
            step: "resolve_approved_root",
            diagnostic: "no approved root",
          },
        }) as never,
        reportObservation: (observation) => observations.push(observation),
        runLoopEngine: async () => {
          drives += 1;
          throw new Error("drive must not run");
        },
        writeStdoutLine: () => {},
      },
      { persistPublicAdmission: true, emitMachineOutput: false },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(drives, 0);
    assert.equal(observations.length, 1);
    const observation = observations[0] as {
      logical_operation_id: string;
      run_id: string;
      certainty: string;
      owned: boolean;
      human_owned: boolean;
    };
    assert.equal(observation.logical_operation_id, "lop-refused");
    assert.equal(observation.run_id, "single-refused");
    assert.equal(observation.certainty, "known_absent");
    assert.equal(observation.owned, true);
    assert.equal(observation.human_owned, false);
  } finally {
    process.exitCode = original;
    console.error = originalError;
  }
});

test("runSingleIssueCommand does not persist single for nested/numeric callers (#1440)", async () => {
  const original = process.exitCode;
  const originalError = console.error;
  process.exitCode = 0;
  console.error = () => {};
  let persistCalls = 0;
  try {
    await runSingleIssueCommand(
      "42",
      { profile: "codex" },
      {
        resolveConfig: () =>
          ({
            repo_dir: "/tmp/repo",
            repo: "o/r",
            base_branch: "main",
            domain: "o-r",
          }) as never,
        resolveIssueNumber: async (_c, n) => n,
        persistPublicAdmission: async () => {
          persistCalls += 1;
          return { acknowledged: true, runId: "single-x", runDir: "/x", logicalOperationId: "lop-single-x" } as never;
        },
        runLoopEngine: async () => ({
          kind: "drive",
          result: {
            runId: "loop-nested",
            cycles: 1,
            stop: null,
            holdOutstanding: false,
            allDone: true,
            resumed: false,
            heldItemIds: [],
            dispatched: 1,
            excludedItemIds: [],
            exclusionReason: null,
            completion: "complete",
          },
        }),
        writeStdoutLine: () => {},
      },
      { emitMachineOutput: false },
    );
    assert.equal(persistCalls, 0);
  } finally {
    process.exitCode = original;
    console.error = originalError;
  }
});

test("persistPublicEntrypointAdmission plus mapping observes all three public commands (#1440)", async () => {
  const files = new Map<string, string>();
  const deps = persistMemDeps(files);
  const startedAt = new Date("2026-09-04T21:00:15.000Z");
  await persistPublicEntrypointAdmission(
    { repoDir: "/repo", kind: "single", repo: "o/r", issue: 42, startedAt, factoryControlRoot: "/repo" },
    deps,
  );
  await persistPublicEntrypointAdmission(
    { repoDir: "/repo", kind: "merge", repo: "o/r", startedAt, factoryControlRoot: "/repo" },
    deps,
  );
  await persistPublicEntrypointAdmission(
    { repoDir: "/repo", kind: "merge-queue", repo: "o/r", startedAt, factoryControlRoot: "/repo" },
    deps,
  );
  const kinds = [...files.keys()]
    .filter((k) => k.endsWith("/run.json"))
    .map((k) => JSON.parse(files.get(k)!).kind);
  assert.deepEqual(kinds.sort(), ["merge", "merge-queue", "single"]);
});

function persistMemDeps(files: Map<string, string>) {
  return {
    async readFile(p: string) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async writeFile(p: string, data: string) {
      files.set(p, data);
    },
    async appendFile(p: string, data: string) {
      files.set(p, (files.get(p) ?? "") + data);
    },
    async rename(from: string, to: string) {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    async mkdir() {},
    async fsyncFile() {},
    async fsyncDirectory() {},
    async realpath(p: string) { return p; },
    async readdir() {
      return [];
    },
    async stat(p: string) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { mtime: new Date(0) };
    },
  };
}

test("persist into factory-control generic store is observed by in-flight ship scoring (#1446)", async () => {
  const files = new Map<string, string>();
  const startedAt = new Date("2026-09-04T23:26:39.000Z");
  const persistDeps = persistMemDeps(files);
  for (const kind of ["single", "merge", "merge-queue"] as const) {
    const admission = await persistPublicEntrypointAdmission(
      {
        repoDir: "/candidate-worktree",
        kind,
        repo: "o/r",
        issue: kind === "single" ? 42 : undefined,
        startedAt,
        factoryControlRoot: "/control-repo",
      },
      persistDeps,
    );
    assert.ok(runDir.startsWith("/control-repo/.agent-pipeline/runs/"));
    assert.equal(runDir.includes("/candidate-worktree/"), false);
  }
  writeUnboundPrefixRun(files, GENERIC, "train-host");
  writeUnboundPrefixRun(files, GENERIC, "loop-host");
  writeUnboundPrefixRun(files, GENERIC, "1446-2026-09-04T23-26-39-000Z");
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/candidate-worktree",
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => [STATE_HOME, GENERIC],
      scoreInput: scoreInput("c".repeat(40)),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const observed = result.evidence.operation_reliability!.entrypoint_coverage.observed;
  assert.ok(observed.includes("single"));
  assert.ok(observed.includes("merge"));
  assert.ok(observed.includes("merge-queue"));
});

test("candidate-worktree-only persist is not unique-operation coverage (#1446)", async () => {
  const files = new Map<string, string>();
  const startedAt = new Date("2026-09-04T23:26:39.000Z");
  const persistDeps = persistMemDeps(files);
  for (const kind of ["single", "merge", "merge-queue"] as const) {
    const { runDir } = await persistPublicEntrypointAdmission(
      {
        repoDir: "/candidate-worktree",
        kind,
        repo: "o/r",
        issue: kind === "single" ? 42 : undefined,
        startedAt,
        factoryControlRoot: null,
      },
      persistDeps,
    );
    assert.equal(admission.acknowledged, false);
    if (!admission.acknowledged) {
      assert.equal(admission.failure.kind, "approved_root_unavailable");
      assert.equal(admission.runDir, null);
    }
  }
  assert.equal(files.size, 0);
  writeUnboundPrefixRun(files, GENERIC, "train-host");
  writeUnboundPrefixRun(files, GENERIC, "1446-2026-09-04T23-26-39-000Z");
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/candidate-worktree",
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => [STATE_HOME, GENERIC],
      scoreInput: scoreInput("c".repeat(40)),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.ok(section.entrypoint_coverage.missing.includes("single"));
  assert.ok(section.entrypoint_coverage.missing.includes("merge"));
  assert.ok(section.entrypoint_coverage.missing.includes("merge-queue"));
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.match(uniqueOperationSloFailure(section) ?? "", /missing required coverage/);
});

test("in-flight ship inherits parent train logical id onto scored operation (#1446)", async () => {
  const files = new Map<string, string>();
  const childEvents = `${GENERIC}/loop-1/events.jsonl`;
  files.set(
    `${GENERIC}/train-T/run.json`,
    JSON.stringify({ run_id: "train-T", kind: "train", logical_operation_id: "T" }),
  );
  files.set(
    `${GENERIC}/train-T/events.jsonl`,
    [
      { type: "run_start", entrypoint: "train", logical_operation_id: "T" },
      {
        type: "train_loop_linked",
        loop_run_id: "loop-1",
        events: childEvents,
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  files.set(`${GENERIC}/loop-1/run.json`, JSON.stringify({ run_id: "loop-1", kind: "loop" }));
  files.set(
    `${GENERIC}/loop-1/events.jsonl`,
    JSON.stringify({ type: "run_start", entrypoint: "loop" }) + "\n",
  );
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/candidate-worktree",
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => [STATE_HOME, GENERIC],
      loadCandidateFaultRecoveryInventory: async () => ({
        rows: FAULT_RECOVERY_MATRIX,
        sourceSha: "c".repeat(40),
      }),
      scoreInput: {
        ...scoreInput("c".repeat(40)),
        unique_operation_manifest: {
          ...passingUniqueOperationManifest({
            release_identity: "1.29.1",
            candidate_sha: "c".repeat(40),
          }),
          required_entrypoints: ["train", "loop"],
          required_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
          live_train_linkage_present: false,
          in_flight_ship: true,
        },
      },
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  const train = section.operations.find((o) => o.entrypoints.includes("train"));
  assert.equal(train!.child_logical_operation_id, "T");
  assert.equal(section.integrity.missing_required_coverage, 0);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  return String(stdout).trim();
}

test("live from-run inventory attach when HEAD differs from scored SHA (#1440 4.4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-1440-inv-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "1440@example.test"]);
    await git(root, ["config", "user.name", "pipeline-1440"]);
    await git(root, ["config", "commit.gpgsign", "false"]);
    const invPath = join(root, CANDIDATE_FAULT_RECOVERY_INVENTORY_REL);
    await mkdir(dirname(invPath), { recursive: true });
    await writeFile(
      invPath,
      JSON.stringify({ schema_version: 1, rows: FAULT_RECOVERY_MATRIX }),
    );
    await git(root, ["add", CANDIDATE_FAULT_RECOVERY_INVENTORY_REL]);
    await git(root, ["commit", "-m", "inventory at C"]);
    const scoredSha = parseExactGitSha(await git(root, ["rev-parse", "HEAD"]));
    assert.ok(scoredSha);
    await writeFile(join(root, "HEAD-MISMATCH.txt"), "checkout is not C\n");
    await git(root, ["add", "HEAD-MISMATCH.txt"]);
    await git(root, ["commit", "-m", "HEAD H"]);
    const headSha = parseExactGitSha(await git(root, ["rev-parse", "HEAD"]));
    assert.ok(headSha);
    assert.notEqual(headSha, scoredSha);

    const loaded = await defaultLoadCandidateFaultRecoveryInventory({
      candidateSha: scoredSha,
      repoDir: root,
    });
    assert.equal(loaded.sourceSha, scoredSha);
    assert.equal(loaded.rows.length, FAULT_RECOVERY_MATRIX.length);

    const files = new Map<string, string>();
    writeUnboundPrefixRun(files, GENERIC, "train-host");
    writeUnboundPrefixRun(files, GENERIC, "loop-host");
    writeUnboundPrefixRun(files, GENERIC, "single-host");
    writeUnboundPrefixRun(files, GENERIC, "merge-host");
    writeUnboundPrefixRun(files, GENERIC, "merge-queue-host");
    writeUnboundPrefixRun(files, GENERIC, "1440-2026-09-04T21-00-15-000Z");
    const result = await runFactoryGate(
      {
        version: "1.29.1",
        repoDir: root,
        inFlightShip: true,
        resolveUniqueOperationRunsRoots: () => [STATE_HOME, GENERIC],
        loadCandidateFaultRecoveryInventory: defaultLoadCandidateFaultRecoveryInventory,
        scoreInput: scoreInput(scoredSha),
        stdout: () => {},
        stderr: () => {},
      },
      memFs(files),
    );
    const section = result.evidence.operation_reliability!;
    assert.ok((section.executed_matrix_rows ?? []).length > 0);
    assert.ok((section.executed_matrix_rows ?? []).every((row) => row.candidate_sha === scoredSha));
    for (const cls of REQUIRED_LIFECYCLE_CLASSES_1333) {
      assert.ok(
        (section.executed_matrix_rows ?? []).some((row) => row.lifecycle_class === cls),
        `missing class ${cls}`,
      );
    }
    assert.equal(section.integrity.missing_required_coverage, 1, "only #1301 live train-link remains");
    assert.ok(typeof defaultScoreBoundPackLoop === "function");
    assert.match(uniqueOperationSloFailure(section) ?? "", /missing required coverage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
