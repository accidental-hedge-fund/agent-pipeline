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
          return { runId: "single-test", runDir: "/tmp/repo/.agent-pipeline/runs/single-test" };
        },
        runLoopEngine: async () => ({
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
        }),
        writeStdoutLine: () => {},
      },
      { persistPublicAdmission: true, emitMachineOutput: false },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.runId, "loop-child-of-single");
    assert.deepEqual(persisted, [{ kind: "single", issue: 42, repoDir: "/tmp/repo" }]);
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
          return { runId: "single-x", runDir: "/x" };
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
  const deps = {
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
    async rename() {},
    async mkdir() {},
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
  const startedAt = new Date("2026-09-04T21:00:15.000Z");
  await persistPublicEntrypointAdmission(
    { repoDir: "/repo", kind: "single", repo: "o/r", issue: 42, startedAt },
    deps,
  );
  await persistPublicEntrypointAdmission(
    { repoDir: "/repo", kind: "merge", repo: "o/r", startedAt },
    deps,
  );
  await persistPublicEntrypointAdmission(
    { repoDir: "/repo", kind: "merge-queue", repo: "o/r", startedAt },
    deps,
  );
  const kinds = [...files.keys()]
    .filter((k) => k.endsWith("/run.json"))
    .map((k) => JSON.parse(files.get(k)!).kind);
  assert.deepEqual(kinds.sort(), ["merge", "merge-queue", "single"]);
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
