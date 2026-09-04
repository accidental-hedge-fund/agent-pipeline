// Ship FRG unique-operation dual-root collection (#1434).
// Injected run-store/fs/resolver/inventory only — no live network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAULT_RECOVERY_MATRIX,
  MATRIX_COVERAGE_LAYERS,
  MATRIX_LIFECYCLE_CLASSES,
  type ExecutedMatrixRow,
  type FaultRecoveryMatrixRow,
} from "../scripts/fault-recovery-matrix.ts";
import {
  REQUIRED_LIFECYCLE_CLASSES_1333,
  REQUIRED_PUBLIC_ENTRYPOINTS,
  uniqueOperationSloFailure,
  passingUniqueOperationManifest,
} from "../scripts/operation-reliability.ts";
import {
  computeFrgEvidence,
  FRG_PACK_MANIFEST,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  isReleaseEligibleFrgPass,
  runFactoryGate,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";
import { defaultScoreBoundPackLoop } from "../scripts/factory-release-prepare.ts";

const CANDIDATE = "c".repeat(40);
const OTHER = "d".repeat(40);
const STATE_HOME = "/host-state/runs";
const GENERIC = "/control-repo/.agent-pipeline/runs";
const CANDIDATE_REPO = "/candidate-worktree";
const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function executedRowsForSha(sha: string): ExecutedMatrixRow[] {
  const rows: ExecutedMatrixRow[] = [];
  for (const cls of MATRIX_LIFECYCLE_CLASSES) {
    for (const layer of MATRIX_COVERAGE_LAYERS) {
      const cell = FAULT_RECOVERY_MATRIX.find(
        (r) => !r.not_applicable && r.lifecycle_class === cls && r.layer === layer,
      );
      if (!cell) continue;
      rows.push({
        candidate_sha: sha,
        layer: cell.layer,
        lifecycle_class: cell.lifecycle_class,
        operation: cell.operation,
        fault_state: cell.fault_state,
        entrypoint: cell.entrypoint,
        host: cell.host,
        observed_terminal: cell.expected_terminal,
        passed: true,
      });
    }
  }
  return rows;
}

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

function writeUnboundPrefixRun(
  files: Map<string, string>,
  root: string,
  runId: string,
  extra: Record<string, unknown> = {},
): void {
  const dir = `${root}/${runId}`;
  files.set(`${dir}/run.json`, JSON.stringify({ run_id: runId, ...extra }));
  files.set(
    `${dir}/events.jsonl`,
    JSON.stringify({ type: "run_start", run_id: runId }) + "\n",
  );
  files.set(`${dir}/summary.json`, JSON.stringify({ run_id: runId }));
}

function writeBoundRun(
  files: Map<string, string>,
  root: string,
  opts: {
    runId: string;
    entrypoint: string;
    sha?: string;
    logical?: string;
    release?: string;
    nested?: boolean;
    trainChild?: { loopRunId: string; eventsPath: string };
    executed_matrix_rows?: ExecutedMatrixRow[];
  },
): void {
  const dir = `${root}/${opts.runId}`;
  const logical = opts.logical ?? "lop-host";
  const releaseFields =
    opts.release != null && opts.release.trim() !== ""
      ? { release_identity: opts.release, release_version: opts.release }
      : {};
  const shaFields = opts.sha ? { candidate_sha: opts.sha } : {};
  files.set(
    `${dir}/run.json`,
    JSON.stringify({
      run_id: opts.runId,
      kind: opts.entrypoint,
      logical_operation_id: logical,
      nested_logical_operation: opts.nested === true,
      ...shaFields,
      ...releaseFields,
      ...(opts.executed_matrix_rows ? { executed_matrix_rows: opts.executed_matrix_rows } : {}),
    }),
  );
  const events: Record<string, unknown>[] = [
    {
      type: "run_start",
      entrypoint: opts.entrypoint,
      logical_operation_id: logical,
      ...releaseFields,
    },
    { type: "verified_completion", exact_candidate_proof: true },
  ];
  if (opts.trainChild) {
    events.push({
      type: "train_loop_linked",
      logical_operation_id: logical,
      loop_run_id: opts.trainChild.loopRunId,
      events: opts.trainChild.eventsPath,
    });
  }
  files.set(`${dir}/events.jsonl`, events.map((e) => JSON.stringify(e)).join("\n"));
  files.set(
    `${dir}/summary.json`,
    JSON.stringify({
      verified_completion: true,
      logical_operation_id: logical,
      ...shaFields,
      ...releaseFields,
    }),
  );
}

function requiredEntrypointsExceptShip(): string[] {
  return REQUIRED_PUBLIC_ENTRYPOINTS.filter((e) => e !== "ship");
}

function seedPrefixCoverage(files: Map<string, string>, root: string): void {
  writeUnboundPrefixRun(files, root, "train-host");
  writeUnboundPrefixRun(files, root, "loop-host");
  writeUnboundPrefixRun(files, root, "merge-host");
  writeUnboundPrefixRun(files, root, "merge-queue-host");
  writeUnboundPrefixRun(files, root, "mq-host");
  writeUnboundPrefixRun(files, root, "1434-2026-09-04T18-24-39-123Z");
  writeUnboundPrefixRun(files, root, "single-host", { kind: "single" });
}

function scoreInput(over: Record<string, unknown> = {}) {
  return {
    version: "1.29.1",
    run_id: "frg-generic-uop",
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
        candidate_sha: CANDIDATE,
      }),
      live_train_linkage_present: false,
      in_flight_ship: true,
    },
    ...over,
  };
}

function dualRoots(): string[] {
  return [STATE_HOME, GENERIC];
}

test("empty candidate worktree plus populated generic host store observes required entrypoints under in-flight ship (#1434)", async () => {
  const files = new Map<string, string>();
  seedPrefixCoverage(files, GENERIC);
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const observed = result.evidence.operation_reliability!.entrypoint_coverage.observed;
  assert.ok(observed.includes("train"));
  assert.ok(observed.includes("loop"));
  assert.ok(observed.includes("merge"));
  assert.ok(observed.includes("merge-queue"));
  assert.ok(observed.includes("drive"));
  assert.ok(observed.includes("single"));
  assert.ok(!observed.includes("ship"));
});

test("candidate-worktree-only artifacts fail when both host roots are empty (#1434)", async () => {
  const files = new Map<string, string>();
  writeBoundRun(files, join(CANDIDATE_REPO, ".agent-pipeline", "runs"), {
    runId: "train-candidate",
    entrypoint: "train",
    sha: CANDIDATE,
    release: "1.29.1",
    executed_matrix_rows: executedRowsForSha(CANDIDATE),
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.equal(section.operations.length, 0);
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("train_loop_linked events path in the candidate worktree is not loaded (#1434)", async () => {
  const files = new Map<string, string>();
  const childId = "loop-escape";
  const childEvents = `${CANDIDATE_REPO}/.agent-pipeline/runs/${childId}/events.jsonl`;
  writeBoundRun(files, GENERIC, {
    runId: "train-host",
    entrypoint: "train",
    sha: CANDIDATE,
    release: "1.29.1",
    trainChild: { loopRunId: childId, eventsPath: childEvents },
  });
  writeBoundRun(files, join(CANDIDATE_REPO, ".agent-pipeline", "runs"), {
    runId: childId,
    entrypoint: "loop",
    sha: CANDIDATE,
    release: "1.29.1",
    nested: true,
    logical: "lop-host",
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  const train = section.operations.find((op) => op.entrypoints.includes("train"));
  assert.ok(train);
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("same durable run_id in both host roots is scored once (#1434)", async () => {
  const files = new Map<string, string>();
  writeBoundRun(files, STATE_HOME, {
    runId: "train-dup",
    entrypoint: "train",
    sha: CANDIDATE,
    release: "1.29.1",
  });
  writeBoundRun(files, GENERIC, {
    runId: "train-dup",
    entrypoint: "train",
    sha: CANDIDATE,
    release: "1.29.1",
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const trainOps = result.evidence.operation_reliability!.operations.filter((op) =>
    op.entrypoints.includes("train"),
  );
  assert.equal(trainOps.length, 1);
  assert.deepEqual(trainOps[0]!.run_ids, ["train-dup"]);
});

test("in-flight ship with no uniqueOperationRunsRoot still reads an injected generic store (#1434)", async () => {
  const files = new Map<string, string>();
  seedPrefixCoverage(files, GENERIC);
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const observed = result.evidence.operation_reliability!.entrypoint_coverage.observed;
  assert.ok(observed.includes("train"));
  assert.ok(observed.includes("loop"));
});

test("empty generic store and empty loop state-home stay fail-closed even with pack-ready labels (#1434)", async () => {
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(new Map()),
  );
  const section = result.evidence.operation_reliability!;
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(section.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("standalone factory-gate without inFlightShip keeps strict SHA binding (#1434)", async () => {
  const files = new Map<string, string>();
  seedPrefixCoverage(files, GENERIC);
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: {
        ...scoreInput(),
        unique_operation_manifest: {
          ...passingUniqueOperationManifest({
            release_identity: "1.29.1",
            candidate_sha: CANDIDATE,
          }),
          live_train_linkage_present: false,
          in_flight_ship: true,
        },
        factory_release_binding: { candidate_git_sha: CANDIDATE },
      },
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.equal(section.operations.length, 0);
  assert.ok(!section.entrypoint_coverage.observed.includes("train"));
});

test("unbound train/loop artifacts are kept for in-flight ship and dropped for standalone (#1434)", async () => {
  const files = new Map<string, string>();
  writeUnboundPrefixRun(files, GENERIC, "train-host");
  writeUnboundPrefixRun(files, GENERIC, "loop-host");
  const inFlight = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const inFlightObserved = inFlight.evidence.operation_reliability!.entrypoint_coverage.observed;
  assert.ok(inFlightObserved.includes("train"));
  assert.ok(inFlightObserved.includes("loop"));

  const standalone = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: {
        ...scoreInput(),
        unique_operation_manifest: {
          ...passingUniqueOperationManifest({
            release_identity: "1.29.1",
            candidate_sha: CANDIDATE,
          }),
          live_train_linkage_present: false,
        },
      },
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const standaloneObserved = standalone.evidence.operation_reliability!.entrypoint_coverage.observed;
  assert.ok(!standaloneObserved.includes("train"));
  assert.ok(!standaloneObserved.includes("loop"));
});

test("other-candidate SHA and mismatched release still drop during in-flight ship (#1434)", async () => {
  const files = new Map<string, string>();
  writeBoundRun(files, GENERIC, {
    runId: "train-other",
    entrypoint: "train",
    sha: OTHER,
    release: "1.29.1",
  });
  writeBoundRun(files, GENERIC, {
    runId: "loop-mismatch",
    entrypoint: "loop",
    sha: CANDIDATE,
    release: "1.28.0",
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const observed = result.evidence.operation_reliability!.entrypoint_coverage.observed;
  assert.ok(!observed.includes("train"));
  assert.ok(!observed.includes("loop"));
});

test("fallback-identity unbound train/loop do not inflate missing_correlation or ownerless_terminal (#1434)", async () => {
  const files = new Map<string, string>();
  writeUnboundPrefixRun(files, GENERIC, "train-host");
  writeUnboundPrefixRun(files, GENERIC, "loop-host");
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.equal(section.integrity.missing_correlation, 0);
  assert.equal(section.ownerless_terminal.numerator, 0);
  assert.equal(section.clean_completion.numerator, 0);
  assert.ok(section.entrypoint_coverage.observed.includes("train"));
  assert.ok(section.entrypoint_coverage.observed.includes("loop"));
});

test("in-flight complete inventory covers all five #1333 classes for the scored SHA (#1434)", async () => {
  const files = new Map<string, string>();
  seedPrefixCoverage(files, GENERIC);
  const withoutInventory = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const withInventory = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      loadCandidateFaultRecoveryInventory: async () => ({
        rows: FAULT_RECOVERY_MATRIX,
        sourceSha: CANDIDATE,
      }),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const before = withoutInventory.evidence.operation_reliability!.integrity.missing_required_coverage;
  const after = withInventory.evidence.operation_reliability!.integrity.missing_required_coverage;
  assert.equal(after, before - REQUIRED_LIFECYCLE_CLASSES_1333.length);
  assert.equal(after, 1, "only #1301 live train-loop linkage should remain missing");
});

test("inventory from a different SHA does not populate #1333 coverage (#1434)", async () => {
  const files = new Map<string, string>();
  seedPrefixCoverage(files, GENERIC);
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      loadCandidateFaultRecoveryInventory: async () => ({
        rows: FAULT_RECOVERY_MATRIX,
        sourceSha: OTHER,
      }),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  assert.match(
    uniqueOperationSloFailure(result.evidence.operation_reliability!) ?? "",
    /missing required coverage/,
  );
});

test("helper covered_lifecycle_classes stamps still fail promotion (#1434)", async () => {
  const stamped = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-stamp",
    loop_run_id: "loop-stamp",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: null,
    unique_operations: requiredEntrypointsExceptShip().map((entrypoint) => ({
      run_id: `run-${entrypoint}`,
      logical_operation_id: "lop-stamp",
      parent_logical_operation_id: "lop-stamp",
      entrypoint,
      nested: entrypoint !== "train",
      postcondition_proof: true,
      terminal: "verified_success" as const,
      train_loop_linked: entrypoint === "train" || entrypoint === "loop",
      child_logical_operation_id: "lop-stamp",
      candidate_sha: CANDIDATE,
      covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    })),
    unique_operation_manifest: {
      ...passingUniqueOperationManifest({
        candidate_sha: CANDIDATE,
        release_identity: "1.29.1",
      }),
      covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
      in_flight_ship: true,
    },
    matrix_covered_lifecycle_classes: [],
    in_flight_ship: true,
  });
  assert.ok(stamped.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(isReleaseEligibleFrgPass(stamped, { requireAttestation: false }), false);
});

test("incomplete inventory does not mint #1333 coverage (#1434)", async () => {
  const files = new Map<string, string>();
  seedPrefixCoverage(files, GENERIC);
  const incomplete: FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX.filter(
    (row) => row.fault_state !== "unseen_provider_error_shape",
  );
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      inFlightShip: true,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      loadCandidateFaultRecoveryInventory: async () => ({
        rows: incomplete,
        sourceSha: CANDIDATE,
      }),
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  assert.match(
    uniqueOperationSloFailure(result.evidence.operation_reliability!) ?? "",
    /missing required coverage/,
  );
});

test("standalone factory-gate does not mint inventory rows (#1434)", async () => {
  const files = new Map<string, string>();
  writeBoundRun(files, GENERIC, {
    runId: "train-bound",
    entrypoint: "train",
    sha: CANDIDATE,
    release: "1.29.1",
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      resolveUniqueOperationRunsRoots: () => dualRoots(),
      loadCandidateFaultRecoveryInventory: async () => ({
        rows: FAULT_RECOVERY_MATRIX,
        sourceSha: CANDIDATE,
      }),
      scoreInput: {
        ...scoreInput(),
        unique_operation_manifest: {
          ...passingUniqueOperationManifest({
            release_identity: "1.29.1",
            candidate_sha: CANDIDATE,
          }),
          live_train_linkage_present: false,
        },
      },
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  assert.match(
    uniqueOperationSloFailure(result.evidence.operation_reliability!) ?? "",
    /missing required coverage/,
  );
});

test("defaultScoreBoundPackLoop sets inFlightShip and uses the dual-root resolver (#1434)", () => {
  assert.equal(typeof defaultScoreBoundPackLoop, "function");
  const src = readFileSync(join(CORE_ROOT, "scripts/factory-release-prepare.ts"), "utf8");
  assert.match(src, /inFlightShip: true/);
  assert.match(src, /resolveUniqueOperationRunsRoots: args\.resolveUniqueOperationRunsRoots/);
  assert.match(src, /loadCandidateFaultRecoveryInventory/);
  assert.match(src, /isReleaseEligibleFrgPass\(scored, \{ requireAttestation: false \}\)/);
  assert.match(src, /isReleaseEligibleFrgPass\(evidence, \{ requireAttestation: true \}\)/);
});

test("CLI factory-gate runFactoryGate call passes env and does not set inFlightShip (#1434)", () => {
  const src = readFileSync(join(CORE_ROOT, "scripts/pipeline.ts"), "utf8");
  const start = src.indexOf('numArg === "factory-gate"');
  assert.ok(start >= 0);
  const callStart = src.indexOf("await runFactoryGate({", start);
  assert.ok(callStart >= 0);
  const call = src.slice(callStart, src.indexOf("});", callStart) + 3);
  assert.match(call, /env: process\.env/);
  assert.equal(/inFlightShip:\s*true/.test(call), false);
});

test("runbook names both host roots and the in-flight missing-field keep rule (#1434)", () => {
  const runbook = readFileSync(
    join(CORE_ROOT, "..", "docs/factory-reliability-gate-runbook.md"),
    "utf8",
  );
  assert.ok(runbook.includes("Unique-operation reliability (#1368 / #1428 / #1434)"));
  assert.ok(runbook.includes("resolveStateHome()>/runs"));
  assert.ok(runbook.includes(".agent-pipeline/runs"));
  assert.ok(runbook.includes("injectable dual-root resolver"));
  assert.ok(runbook.includes("opts.inFlightShip === true"));
  assert.ok(runbook.includes("sourceSha"));
  assert.equal(
    runbook.includes("Ship FRG scoring reads that evidence from the **control-host** durable store"),
    false,
  );
});
