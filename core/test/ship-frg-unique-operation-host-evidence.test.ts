// Ship FRG unique-operation scoring from control-host durable evidence (#1428).
// Injected run-store/fs only — no live network, git, or subprocess.

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
  parseFrgObservationsFile,
  runFactoryGate,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";
import {
  collectFrgPackObservations,
  loadFrgPack,
  renderFrgPackIssues,
  type LoadedFrgPack,
  type VerifiedFrgPackRun,
} from "../scripts/frg-pack-observations.ts";
import * as crypto from "node:crypto";

const CANDIDATE = "c".repeat(40);
const OTHER = "d".repeat(40);
const HOST_RUNS = "/host-state/runs";
const CANDIDATE_REPO = "/candidate-worktree";
const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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

function writeHostRun(
  files: Map<string, string>,
  root: string,
  opts: {
    runId: string;
    entrypoint: string;
    sha: string;
    logical?: string;
    nested?: boolean;
    release?: string;
    trainChild?: { loopRunId: string; eventsPath: string };
    executed_matrix_rows?: ExecutedMatrixRow[];
    parentOnlyTrainLink?: boolean;
  },
): void {
  const dir = `${root}/${opts.runId}`;
  const logical = opts.logical ?? "lop-host";
  const releaseFields =
    opts.release != null && opts.release.trim() !== ""
      ? { release_identity: opts.release, release_version: opts.release }
      : {};
  files.set(
    `${dir}/run.json`,
    JSON.stringify({
      run_id: opts.runId,
      kind: opts.entrypoint,
      logical_operation_id: logical,
      candidate_sha: opts.sha,
      nested_logical_operation: opts.nested === true,
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
  if (opts.parentOnlyTrainLink) {
    events.push({ type: "train_loop_linked", logical_operation_id: logical });
  } else if (opts.trainChild) {
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
      candidate_sha: opts.sha,
      ...releaseFields,
    }),
  );
}

function writeFollowableChild(
  files: Map<string, string>,
  loopRunId: string,
  eventsPath: string,
  sha: string,
  logical = "lop-host",
  release?: string,
): void {
  const dir = eventsPath.replace(/\/events\.jsonl$/, "");
  const releaseFields =
    release != null && release.trim() !== ""
      ? { release_identity: release, release_version: release }
      : {};
  files.set(
    `${dir}/run.json`,
    JSON.stringify({
      run_id: loopRunId,
      kind: "loop",
      logical_operation_id: logical,
      candidate_sha: sha,
      nested_logical_operation: true,
      ...releaseFields,
    }),
  );
  files.set(
    `${dir}/events.jsonl`,
    [
      {
        type: "run_start",
        entrypoint: "loop",
        logical_operation_id: logical,
        nested: true,
        ...releaseFields,
      },
      { type: "verified_completion", exact_candidate_proof: true },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  files.set(
    `${dir}/loop-run-handoff.json`,
    JSON.stringify({
      kind: "loop_run_handoff",
      run_id: loopRunId,
      events: eventsPath,
      logical_operation_id: logical,
      candidate_sha: sha,
      ...releaseFields,
    }),
  );
}

function requiredEntrypointsExceptShip(): string[] {
  return REQUIRED_PUBLIC_ENTRYPOINTS.filter((e) => e !== "ship");
}

function seedHostCoverage(
  files: Map<string, string>,
  root: string,
  sha: string,
  opts: {
    includeShip?: boolean;
    followableTrain?: boolean;
    parentOnlyTrain?: boolean;
    release?: string;
    trainChildRoot?: string;
  } = {},
): void {
  const childId = "loop-host-child";
  const childRoot = opts.trainChildRoot ?? root;
  const childEvents = `${childRoot}/${childId}/events.jsonl`;
  const entrypoints = opts.includeShip
    ? [...REQUIRED_PUBLIC_ENTRYPOINTS]
    : requiredEntrypointsExceptShip();
  for (const entrypoint of entrypoints) {
    writeHostRun(files, root, {
      runId: `host-${entrypoint}`,
      entrypoint,
      sha,
      release: opts.release,
      nested: entrypoint !== "train",
      trainChild:
        entrypoint === "train" && opts.followableTrain !== false && !opts.parentOnlyTrain
          ? { loopRunId: childId, eventsPath: childEvents }
          : undefined,
      parentOnlyTrainLink: entrypoint === "train" && opts.parentOnlyTrain === true,
      executed_matrix_rows: entrypoint === "train" ? executedRowsForSha(sha) : undefined,
    });
  }
  if (opts.followableTrain !== false && !opts.parentOnlyTrain) {
    writeFollowableChild(files, childId, childEvents, sha, "lop-host", opts.release);
  }
}

function scoreInput(over: Record<string, unknown> = {}) {
  return {
    version: "1.29.1",
    run_id: "frg-host-uop",
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

test("host store train/merge are collected when candidate worktree runs are empty (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, { release: "1.29.1" });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.ok(section.entrypoint_coverage.observed.includes("train"));
  assert.ok(section.entrypoint_coverage.observed.includes("merge"));
  assert.ok(!section.entrypoint_coverage.missing.includes("ship"));
  assert.equal(section.exclusions.length, 0);
  assert.equal(uniqueOperationSloFailure(section), null);
  assert.equal(
    isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }),
    true,
  );
});

test("other-candidate host runs do not satisfy the scored candidate (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, OTHER, { release: "1.29.1" });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
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

test("empty host store remains fail-closed even with pack-ready labels (#1428)", async () => {
  const files = new Map<string, string>();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.equal(section.operations.length, 0);
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(section.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("empty host store stays fail-closed when candidate worktree has matching unique-ops (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, join(CANDIDATE_REPO, ".agent-pipeline", "runs"), CANDIDATE, {
    release: "1.29.1",
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.equal(section.operations.length, 0);
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(section.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("#1301 live train_loop_linked is scored from the host train stream (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, { followableTrain: true, release: "1.29.1" });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const train = result.evidence.operation_reliability!.operations.find((op) =>
    op.entrypoints.includes("train"),
  );
  assert.ok(train);
  assert.equal(uniqueOperationSloFailure(result.evidence.operation_reliability!), null);
});

test("#1301 parent-only train_loop_linked is not followable child linkage (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, { parentOnlyTrain: true, release: "1.29.1" });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(section.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("host train handoff into a candidate-worktree child remains ineligible (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, {
    followableTrain: true,
    release: "1.29.1",
    trainChildRoot: join(CANDIDATE_REPO, ".agent-pipeline", "runs"),
  });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(section.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("candidate-matching host artifacts without release identity remain ineligible (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE);
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
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

test("mismatched release identity host artifacts remain ineligible (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, { release: "1.28.0" });
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
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

test("#1333 executed rows from host evidence feed coverage; helper stamps still fail (#1428)", async () => {
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, { release: "1.29.1" });
  const withRows = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  assert.equal(uniqueOperationSloFailure(withRows.evidence.operation_reliability!), null);

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
  assert.equal(stamped.operation_reliability!.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(stamped, { requireAttestation: false }), false);
});

test("absent #1333 executed rows fail as missing required coverage, not an exclusion (#1428)", async () => {
  const files = new Map<string, string>();
  const childId = "loop-host-child";
  const childEvents = `${HOST_RUNS}/${childId}/events.jsonl`;
  for (const entrypoint of requiredEntrypointsExceptShip()) {
    writeHostRun(files, HOST_RUNS, {
      runId: `host-${entrypoint}`,
      entrypoint,
      sha: CANDIDATE,
      release: "1.29.1",
      nested: entrypoint !== "train",
      trainChild:
        entrypoint === "train" ? { loopRunId: childId, eventsPath: childEvents } : undefined,
    });
  }
  writeFollowableChild(files, childId, childEvents, CANDIDATE, "lop-host", "1.29.1");
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: scoreInput(),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  const section = result.evidence.operation_reliability!;
  assert.ok(section.integrity.missing_required_coverage > 0);
  assert.equal(section.exclusions.length, 0);
  assert.match(uniqueOperationSloFailure(section) ?? "", /missing required coverage/);
});

function makeEvidenceBundle(pack: LoadedFrgPack, releaseVersion: string): VerifiedFrgPackRun {
  const packRunId = "frg-pack-run-1428";
  const loopRunId = "loop-frg-1428";
  const startedAt = "2026-09-04T12:00:00.000Z";
  const rendered = renderFrgPackIssues(pack, {
    release_version: releaseVersion,
    pack_run_id: packRunId,
  });
  const issueNumbers = rendered.map((_, index) => 1424 + index);
  return {
    schema_version: 1,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: releaseVersion,
    candidate_git_sha: CANDIDATE,
    pack_run_id: packRunId,
    loop_run_id: loopRunId,
    repository: "owner/repo",
    base_branch: "main",
    started_at: startedAt,
    contract: {
      artifact_sha256: digest("contract"),
      selector: { ...pack.manifest.selector },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((issueNumber) => ({ issue_number: issueNumber, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: digest("ledger"),
      items: issueNumbers.map((issueNumber, index) => ({
        issue_number: issueNumber,
        state: "ready",
        advance_run_id: `advance-${index + 1}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: digest("events"),
      event_ids: issueNumbers.map((issueNumber, index) => `event:${index + 1}:item-${issueNumber}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: digest("actions"),
      action_ids: issueNumbers.map((issueNumber, index) => `action:${index + 1}:item-${issueNumber}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files = issue.provenance.template_id === "clean-openspec"
        ? [
            "openspec/changes/archive/2026-09-04-frg/proposal.md",
            "openspec/specs/frg/spec.md",
          ]
        : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-09-04T12:00:0${index + 1}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2424 + index,
          node_id: `PR_${2424 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [
            {
              id: `CHECK_${issueNumber}`,
              name: "ci",
              head_sha: head,
              conclusion: "success",
            },
          ],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: CANDIDATE,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: digest(`argv:${probe.id}`),
      stdout_sha256: digest(`stdout:${probe.id}`),
      stderr_sha256: digest(`stderr:${probe.id}`),
      started_at: `2026-09-04T12:01:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-09-04T12:01:${String(index).padStart(2, "0")}.500Z`,
    })),
  };
}

test("hybrid v2 pack proofs + host unique-ops without this ship pass structurally (#1428)", async () => {
  const pack = await loadFrgPack();
  const observations = parseFrgObservationsFile(
    collectFrgPackObservations(pack, makeEvidenceBundle(pack, "1.40.1")),
  );
  const loopRunId = observations.pack_provenance!.loop_run_id;
  const issueIds = observations.pack_provenance!.issues.map((issue) => String(issue.issue_number));
  const files = new Map<string, string>();
  seedHostCoverage(files, HOST_RUNS, CANDIDATE, { release: "1.40.1" });
  const result = await runFactoryGate(
    {
      version: "1.40.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: {
        version: "1.40.1",
        run_id: "frg-1428-hybrid",
        loop_run_id: loopRunId,
        pack_id: FRG_PACK_MANIFEST.pack_id,
        items: issueIds.map((item_id) => ({ item_id, state: "ready" as const, ready_clean: true })),
        scenario_overrides: observations.scenarios,
        composition_overrides: observations.composition,
        false_human_authority_count: observations.false_human_authority_count,
        pack_provenance: observations.pack_provenance,
        attestation_key: null,
        unique_operation_manifest: {
          ...passingUniqueOperationManifest({
            candidate_sha: CANDIDATE,
            release_identity: "1.40.1",
          }),
          live_train_linkage_present: false,
          in_flight_ship: true,
        },
      },
      stdout: () => {},
      stderr: () => {},
    },
    memFs(files),
  );
  assert.ok(!result.evidence.operation_reliability!.entrypoint_coverage.missing.includes("ship"));
  assert.equal(
    isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }),
    true,
  );
  assert.equal(isReleaseEligibleFrgPass(result.evidence), false, "HMAC remains required by default");
});

test("hybrid v2 pack proofs without host unique-ops stay fail-closed (#1428)", async () => {
  const pack = await loadFrgPack();
  const observations = parseFrgObservationsFile(
    collectFrgPackObservations(pack, makeEvidenceBundle(pack, "1.40.1")),
  );
  const loopRunId = observations.pack_provenance!.loop_run_id;
  const issueIds = observations.pack_provenance!.issues.map((issue) => String(issue.issue_number));
  const result = await runFactoryGate(
    {
      version: "1.40.1",
      repoDir: CANDIDATE_REPO,
      uniqueOperationRunsRoot: HOST_RUNS,
      inFlightShip: true,
      scoreInput: {
        version: "1.40.1",
        run_id: "frg-1428-empty-host",
        loop_run_id: loopRunId,
        pack_id: FRG_PACK_MANIFEST.pack_id,
        items: issueIds.map((item_id) => ({ item_id, state: "ready" as const, ready_clean: true })),
        scenario_overrides: observations.scenarios,
        composition_overrides: observations.composition,
        false_human_authority_count: observations.false_human_authority_count,
        pack_provenance: observations.pack_provenance,
        attestation_key: null,
        unique_operation_manifest: {
          ...passingUniqueOperationManifest({
            candidate_sha: CANDIDATE,
            release_identity: "1.40.1",
          }),
          live_train_linkage_present: false,
          in_flight_ship: true,
        },
      },
      stdout: () => {},
      stderr: () => {},
    },
    memFs(new Map()),
  );
  assert.ok(result.evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(result.evidence.operation_reliability!.exclusions.length, 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence, { requireAttestation: false }), false);
});

test("prepare structural eligibility uses optional HMAC; tag path still requires it (#1428)", () => {
  const src = readFileSync(join(CORE_ROOT, "scripts/factory-release-prepare.ts"), "utf8");
  assert.match(src, /isReleaseEligibleFrgPass\(scored, \{ requireAttestation: false \}\)/);
  assert.match(src, /isReleaseEligibleFrgPass\(evidence, \{ requireAttestation: true \}\)/);
});
