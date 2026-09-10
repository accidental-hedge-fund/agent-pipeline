// Exact-candidate two-issue FRG (#1558). All git, forge, process, and cleanup
// operations are injected; this suite performs no network or subprocess I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  EXACT_CANDIDATE_FRG_SCHEMA,
  beginExactCandidateFrg,
  classifyExactCandidateFrgObservation,
  dispatchExactCandidateFrgPair,
  exactCandidateFrgLoopArgv,
  exactCandidateFrgResultPath,
  observeExactCandidateFrgPair,
  observeProductionExactCandidateFrgPass,
  discoverExactCandidateFrgPairIssues,
  parseExactCandidateFrgRecord,
  persistExactCandidateFrgRecord,
  loadExactCandidateFrgRecord,
  reconcileExactCandidateFrgPair,
  runExactCandidateFrg,
  runProductionExactCandidateFrg,
  parseExactCandidateFrgLoopHandoff,
  parseExactCandidateFrgProvenance,
  createProductionExactCandidateFrgDeps,
  defaultProductionExactCandidateFrgIo,
  exactCandidateFrgPathsAreHarmless,
  selectExactCandidateFrgExistingRecord,
  nextExactCandidateFrgEpochId,
  recoverExactCandidateFrgChecks,
  recoverExpectedExactCandidateLoopExit,
  resolveExactCandidateCurrentReviewArtifact,
  renderExactCandidateFrgFixtureBody,
  withReleaseFrgExclusion,
  verifyExactCandidateFrgResult,
  cleanupOwnedFailedSyntheticArtifacts,
  isHistoricalFailedShipEvidencePath,
  type ExactCandidateFrgDeps,
  type ExactCandidateFrgObservation,
  type ExactCandidateFrgRecord,
  type RemoteFixtureMatch,
  type ProductionExactCandidateFrgIo,
} from "../scripts/exact-candidate-frg.ts";
import type { PipelineConfig } from "../scripts/config.ts";
import type { CandidateEngine } from "../scripts/ship-end-candidate.ts";
import { PIPELINE_SUPPRESS_AUTO_FILE_ENV } from "../scripts/stages/papercut.ts";
import { PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV } from "../scripts/loop/pack-loop-liveness.ts";
import { diffFilePaths, encodeReviewArtifact, finalizeReviewArtifactComment } from "../scripts/stages/review-parsing.ts";
import { currentWorkflowEngineExhaustion, fingerprintEvidence } from "../scripts/loop/recovery.ts";
import { workListRunId } from "../scripts/loop/work-list-run-id.ts";
import { buildTesterPolicyHash } from "../scripts/evidence-subject.ts";

const CANDIDATE = "a".repeat(40);
const MOVED = "b".repeat(40);
const ROOT = "/candidate";
const CANONICAL_LOOP = workListRunId("owner/repo", "claude", ["101", "102"]);
const PROVENANCE_TEMPLATE = `<!-- pipeline-frg-instance@1
pack_id={{pack_id}}
manifest_version={{manifest_version}}
manifest_sha256={{manifest_sha256}}
release_version={{release_version}}
pack_run_id={{pack_run_id}}
template_id={{template_id}}
template_sha256={{template_sha256}}
-->`;
const DOCS = `${PROVENANCE_TEMPLATE}\ndocs {{openspec_change_id}}`;
const OPENSPEC = `${PROVENANCE_TEMPLATE}\nopenspec {{openspec_change_id}}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function engine(): CandidateEngine {
  return {
    engineRoot: ROOT,
    launcherPath: `${ROOT}/scripts/pipeline-launcher.mjs`,
    commitSha: CANDIDATE,
    consumer: "factory-gate.exact-pair",
  };
}

function files() {
  const manifest = JSON.stringify({
    schema_version: 1,
    pack_id: "factory-gate-v1",
    manifest_version: 1,
    templates: [
      { id: "clean-docs", title: "test(frg): {{release_version}} {{pack_run_id}} clean docs path", file: "templates/clean-docs.md", sha256: hash(DOCS) },
      { id: "clean-openspec", title: "test(frg): {{release_version}} {{pack_run_id}} clean OpenSpec path", file: "templates/clean-openspec.md", sha256: hash(OPENSPEC) },
    ],
  });
  return new Map([
    [`${ROOT}/core/scripts/frg-packs/factory-gate-v1/manifest.json`, manifest],
    [`${ROOT}/core/scripts/frg-packs/factory-gate-v1/templates/clean-docs.md`, DOCS],
    [`${ROOT}/core/scripts/frg-packs/factory-gate-v1/templates/clean-openspec.md`, OPENSPEC],
    [`${ROOT}/core/package-lock.json`, "lock"],
  ]);
}

function templateBodyForTest(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgRecord["slots"][number]): string {
  return renderExactCandidateFrgFixtureBody(slot.id === "clean-docs" ? DOCS : OPENSPEC, record, slot);
}

function candidateTemplateForPath(file: string): string | null {
  if (file.endsWith("/templates/clean-docs.md")) return DOCS;
  if (file.endsWith("/templates/clean-openspec.md")) return OPENSPEC;
  return null;
}

function taggedRetryFreshCheckoutIo(
  record: ExactCandidateFrgRecord,
  issues: Array<{ number: number; body: string; state: "open" }>,
  counters: { created(): void; writes(): void },
): ProductionExactCandidateFrgIo {
  const slotIo = record.slots.map((slot, index) => {
    const issue = 101 + index;
    const pr = 301 + index;
    const head = String(index + 1).repeat(40);
    const runId = `advance-${index + 1}`;
    const traceRunId = `${issue}/2026-09-08T20:00:00Z`;
    const changeId = `${record.epoch_id}-${slot.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const changedPaths = [
      `core/test/fixtures/frg/${record.epoch_id}/${slot.id}.json`,
      `core/test/frg-${record.epoch_id}-${slot.id}.test.ts`,
      `openspec/changes/archive/2026-09-10-${changeId}/spec.md`,
      `openspec/specs/${changeId}/spec.md`,
    ];
    const prDiff = changedPaths.map((file) =>
      `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+fixture`).join("\n");
    const reviewSubject = {
      schema_version: 1, domain: "github.com/owner/repo", issue, pr, run_id: traceRunId,
      candidate_sha: head, diff_hash: hash(prDiff).slice(0, 16), policy_hash: "2".repeat(64),
      engine_fingerprint: "3".repeat(64), verifier_fingerprint: "4".repeat(64),
      required_evidence_set_revision: "5".repeat(64),
    };
    const summarySubject = { ...reviewSubject, diff_hash: null };
    const testerSubject = { ...reviewSubject, run_id: runId, policy_hash: record.worker_config.gates_sha256 };
    return { issue, pr, head, runId, traceRunId, prDiff, reviewSubject, summarySubject, testerSubject, body: issues[index]!.body };
  });
  return {
    now: () => new Date("2026-09-08T20:10:00.000Z"),
    validateTargetRuntime: async () => ({ domain: "agent-pipeline", repository: record.repository }),
    resolveReleaseStoreRepoDir: async () => "/primary",
    listRecordEpochIds: async () => [],
    listIssues: async () => issues,
    createIssue: async () => { counters.created(); return 999; },
    writeRecord: async () => { counters.writes(); },
    readFile: async (file: string) => files().get(path.resolve(file)) ?? candidateTemplateForPath(file),
    resolveAndPrepareCandidate: async (_input, candidateSha) => {
      assert.equal(candidateSha, CANDIDATE);
      return { ok: true, engine: engine() };
    },
    resolveCandidatePolicy: async () => ({
      repository: record.repository, baseBranch: record.base_branch, domain: "github.com/owner/repo",
      implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
      reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) },
    }),
    loopRunExists: async () => true,
    readLoopDocuments: async () => ({ ...loopResult(), ledger: { ...loopResult().ledger, stop: null } }),
    getIssue: async (_input, issueNumber) => {
      const row = slotIo.find((slot) => slot.issue === issueNumber);
      if (!row) throw new Error(`unexpected issue ${issueNumber}`);
      return { body: row.body, labels: ["pipeline:ready-to-deploy"], state: "open" as const };
    },
    listPrsAnyState: async (_input, issueNumber) => {
      const row = slotIo.find((slot) => slot.issue === issueNumber)!;
      return { numbers: [row.pr], truncated: false };
    },
    listOpenPrs: async (_input, issueNumber) => [slotIo.find((slot) => slot.issue === issueNumber)!.pr],
    getPr: async (_input, prNumber) => {
      const row = slotIo.find((slot) => slot.pr === prNumber)!;
      return { number: row.pr, head_sha: row.head, base_ref: record.base_branch, state: "open", merged: false };
    },
    getRequiredChecks: async () => [{ name: "ci", bucket: "pass" }],
    getPrDiff: async (_input, prNumber) => slotIo.find((slot) => slot.pr === prNumber)!.prDiff,
    readAdvanceSummary: async (_input, advanceRunId) => {
      const row = slotIo.find((slot) => slot.runId === advanceRunId)!;
      return {
        schema_version: 1, schemaVersion: 1, run_id: row.runId, runId: row.traceRunId, issue: row.issue, pr: row.pr,
        branch: `pipeline/${row.issue}-frg`, harnesses: ["claude", "codex"], stages: [], overrides: [], recoveries: [],
        finalState: "ready-to-deploy", finalizedAt: "2026-09-08T20:09:00.000Z", notifiedAt: null,
        evidence_subject: row.summarySubject,
        roles: { implementer: "claude", implementerSource: "repo-config", reviewer: "codex", reviewerSource: "repo-config" },
        reviews: [{
          round: 2, sha: row.head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
          ensemble: { agents: [], coverage: { independent: 1, required: 1 }, outcome: "accepted" },
          evidence_subject: row.reviewSubject,
        }],
      };
    },
    readAdvanceTester: async (_input, advanceRunId) => {
      const row = slotIo.find((slot) => slot.runId === advanceRunId)!;
      return { status: "ok" as const, evidence: {
        schema_version: 1, kind: "tester_evidence", candidate_sha: row.head, run_id: row.runId, issue: row.issue, pr: row.pr,
        worktree_id: "fixture-worktree", config_digest: record.worker_config.gates_sha256,
        toolchain_fingerprint: { node: "v24" }, started_at: "2026-09-08T20:00:00.000Z",
        ended_at: "2026-09-08T20:01:00.000Z", duration_ms: 60_000, overall_status: "passed",
        commands: [{ identity: "npm run ci", exit_code: 0, duration_ms: 60_000, status: "passed", output_excerpt: "ok" }],
        output_excerpt: "ok", producer: { component: "test-build-gate" }, evidence_subject: row.testerSubject,
      } };
    },
  } as unknown as ProductionExactCandidateFrgIo;
}

function passingObservation(record: ExactCandidateFrgRecord, index = 0): ExactCandidateFrgObservation {
  const slot = record.slots[index]!;
  const head = String(index + 1).repeat(40);
  const changeId = `${record.epoch_id}-${slot.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    observed_at: "2026-09-08T20:01:00.000Z",
    issue: {
      source: "forge",
      labels: ["factory-gate", "pipeline:ready-to-deploy"],
      provenance_epoch: record.epoch_id,
      provenance_candidate_sha: record.candidate.sha,
      provenance_template_id: slot.id,
      provenance_template_sha256: slot.template.sha256,
    },
    pr: { source: "forge", number: 301 + index, head_sha: head, state: "open", merged: false },
    ordinary: {
      source: "run_store", advance_run_id: slot.advance_run_id ?? `advance-${index + 1}`,
      loop_item_state: "ready",
      final_state: "ready-to-deploy", regression_proof: null,
    },
    ci: { source: "ci", head_sha: head, required: true, check_count: 1, conclusion: "success" },
    review: { source: "review", head_sha: head, reviewed_head_sha: head, independent: true, advance_run_id: slot.advance_run_id ?? `advance-${index + 1}`, evidence_run_id: `trace-${index + 1}`, evidence_subject_valid: true, verdict: "accepted" },
    tester: {
      source: "tester", head_sha: head, advance_run_id: slot.advance_run_id ?? `advance-${index + 1}`,
      evidence_run_id: slot.advance_run_id ?? `advance-${index + 1}`,
      config_digest: record.worker_config.gates_sha256, evidence_subject_valid: true,
      conclusion: "passed",
    },
    unavailable_sources: [],
    changed_paths: [
      `core/test/fixtures/frg/${record.epoch_id}/${slot.id}.json`,
      `core/test/frg-${record.epoch_id}-${slot.id}.test.ts`,
      `openspec/changes/archive/2026-09-10-${changeId}/spec.md`,
      `openspec/specs/${changeId}/spec.md`,
    ],
  };
}

function loopResult(runId = CANONICAL_LOOP, issues = [101, 102]) {
  const runDir = `/loop/${runId}`;
  return {
    stdout: `${JSON.stringify({
      schema_version: "1", kind: "loop_run_handoff", run_id: runId, run_dir: runDir,
      events: `${runDir}/events.jsonl`, engine: "claude", resumed: false, selector: { type: "work-list", value: issues.map(String) },
    })}\n`,
    contract: {
      run_id: runId, repo: { name: "owner/repo", base_branch: "main" },
      engine: "claude", selector: { type: "work-list", value: issues.map(String) }, items: issues.map((id) => ({ id: String(id) })),
    },
    ledger: { run_id: runId, items: Object.fromEntries(issues.map((id, index) => [String(id), { state: "ready", advance_run_id: `advance-${index + 1}` }])) },
    handoff: {
      schema_version: "1", kind: "loop_run_handoff", run_id: runId, run_dir: runDir,
      events: `${runDir}/events.jsonl`, engine: "claude", resumed: false, selector: null, candidate_sha: CANDIDATE,
      supervisor: { pid: 123, boot_id: "boot", started_at: "2026-09-08T20:00:00.000Z", token: "token" },
    },
  };
}

function exhaustedWorkflowEngineLedger(
  issue: number,
  advanceRunId: string,
  input: { pr?: number; head?: string; stage?: string } = {},
) {
  const evidence = "candidate engine failed while advancing the fixture";
  const evidenceFingerprint = fingerprintEvidence(evidence);
  const candidateEpoch = input.head ?? "";
  const time = "2026-09-08T20:00:00.000Z";
  const item = {
    id: String(issue), state: "blocked", blocked_theme: "workflow-engine-defect",
    history: [{ time, from: "in_progress", to: "blocked", engine: "codex", theme: "workflow-engine-defect", evidence }],
    recovery_budgets_remaining: { "workflow-engine-defect": 0 }, evidence_fingerprint: evidenceFingerprint,
    ...(input.head ? { blocker_candidate_epoch: candidateEpoch, blocker_candidate_head: input.head } : {}),
    current_stage: input.stage ?? "planning", advance_run_id: advanceRunId,
    ...(input.head ? { last_verified_identity: {
      issue_number: issue, issue_open: true, ready_label_present: false, blocked_label_present: true,
      pr_number: input.pr ?? null, pr_state: input.pr ? "open" : null, head_branch: input.pr ? "pipeline/frg" : null, head_sha: input.head,
      merge_commit_sha: null, checks_conclusion: "failure", pipeline_stage: "blocked", observed_at: time,
      logical_candidate_epoch: candidateEpoch,
    } } : {}),
  };
  const coolingTime = "2026-09-08T20:02:00.000Z";
  const cooling = {
    reason: "strategy_cursor_exhausted", time: coolingTime, next_eligible_at: "2026-09-08T20:05:00.000Z",
    item_id: String(issue), theme: "workflow-engine-defect",
    ...(input.head ? { candidate_epoch: candidateEpoch } : {}),
    historical_evidence: "recovery_exhausted",
  };
  return {
    schema: "pipeline/loop-ledger@1", run_id: CANONICAL_LOOP, items: { [String(issue)]: item },
    consecutive_blocked: 1, merge_barrier: null, stop: null, cooling, item_cooling: { [String(issue)]: cooling },
    lifecycle: {
      state: "cooling", owned: true, ownerless: false, human_owned: false, cancelled: false,
      human_authority: false, typed_request: null, logical_operation_id: `loop:${CANONICAL_LOOP}`, updated_at: coolingTime, revision: 1,
    },
    last_native_goal_check: null, last_reconciliation: null, reconciliation_sequence: 1,
    recovery_attempts: [], authority_amendments: [],
  };
}

function baseDeps(over: Partial<ExactCandidateFrgDeps> = {}) {
  let tick = 0;
  const persisted: ExactCandidateFrgRecord[] = [];
  const createdMatches: RemoteFixtureMatch[] = [];
  const source = files();
  const deps: ExactCandidateFrgDeps = {
    now: () => new Date(`2026-09-08T20:00:0${tick++}.000Z`),
    observeOriginMainSha: async () => CANDIDATE,
    resolveAndPrepareDeps: {} as never,
    resolveAndPrepareCandidate: async (_input, candidateSha) => {
      assert.equal(candidateSha, CANDIDATE);
      return { ok: true, engine: engine() };
    },
    resolveCandidatePolicy: async () => ({
      repository: "owner/repo", baseBranch: "main", implementer: "claude", reviewer: "codex", gatesSha256: "c".repeat(64),
      reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) },
    }),
    runCandidateProcess: async (candidate, start) => ({
      ok: true,
      engine: candidate,
      value: await start(candidate, {}, () => true),
    }),
    readCandidateFile: async (file) => {
      const body = source.get(path.resolve(file));
      if (body === undefined) throw new Error(`unexpected candidate read ${file}`);
      return body;
    },
    persist: async (record) => { persisted.push(structuredClone(record)); },
    listFixtureMatches: async () => createdMatches,
    createFixture: async ({ record, slot }) => {
      const issue_number = slot.id === "clean-docs" ? 101 : 102;
      createdMatches.push({
        issue_number, epoch_id: record.epoch_id, candidate_sha: record.candidate.sha,
        slot_id: slot.id, provenance_id: slot.provenance_id,
      });
      return issue_number;
    },
    dispatchOrdinaryLoop: async () => loopResult(),
    observeFixture: async (record, slot) => passingObservation(record, slot.id === "clean-docs" ? 0 : 1),
    reobserveFixtureIdentity: async (record, slot) => {
      const index = slot.id === "clean-docs" ? 0 : 1;
      const observation = passingObservation(record, index);
      return {
        issue_number: slot.issue_number!, issue_open: true, pr_number: observation.pr.number,
        pr_head_sha: observation.pr.head_sha, pr_open: true, merged: false,
      };
    },
    ordinaryLoopNeedsResume: async () => false,
    ...over,
  };
  return { deps, persisted, source };
}

async function begun(over: Partial<ExactCandidateFrgDeps> = {}) {
  const fixture = baseDeps(over);
  const result = await beginExactCandidateFrg({
    repoDir: "/operator-dirty",
    repository: "owner/repo",
    baseBranch: "main",
    releaseVersion: "1.40.1",
    implementer: "claude",
    reviewer: "codex",
    gatesSha256: "c".repeat(64),
  }, fixture.deps);
  return { ...fixture, ...result };
}

test("result parser enforces exact slots and one candidate epoch", async () => {
  const { record } = await begun();
  assert.equal(parseExactCandidateFrgRecord(record), record);
  assert.throws(() => parseExactCandidateFrgRecord({ ...record, slots: [record.slots[0]] }), /exactly two slots/);
  assert.throws(() => parseExactCandidateFrgRecord({ ...record, slots: [...record.slots, record.slots[0]] }), /exactly two slots/);
  assert.throws(() => parseExactCandidateFrgRecord({ ...record, candidate: { ...record.candidate, sha: "short" } }), /exact lowercase/);
  assert.throws(() => parseExactCandidateFrgRecord({ ...record, repository: undefined }), /repository/);
  for (const role of ["implementer", "reviewer"] as const) {
    assert.throws(() => parseExactCandidateFrgRecord({
      ...record, worker_config: { ...record.worker_config, [role]: { command: "codex" } },
    }), /worker_config/, `${role} must be a nonempty string rather than a truthy object`);
  }
  assert.throws(() => parseExactCandidateFrgRecord({ ...record, candidate: { ...record.candidate, lockfile: { ...record.candidate.lockfile, relative_path: "../operator-lock" } } }), /candidate root/);
  const crossed = structuredClone(record);
  crossed.slots[1].epoch_id = "other-epoch";
  assert.throws(() => parseExactCandidateFrgRecord(crossed), /crosses candidate epoch/);
  const duplicateTemplate = structuredClone(record);
  duplicateTemplate.slots[1].template = { ...duplicateTemplate.slots[0].template };
  assert.throws(() => parseExactCandidateFrgRecord(duplicateTemplate), /distinct candidate template files/);
});

test("begin selects fresh origin/main and loads all inputs beneath the prepared candidate", async () => {
  const reads: string[] = [];
  const { record, persisted } = await begun({
    readCandidateFile: async (file) => {
      reads.push(file);
      const body = files().get(path.resolve(file));
      if (body === undefined) throw new Error("operator or installed source requested");
      return body;
    },
  });
  assert.equal(record.schema, EXACT_CANDIDATE_FRG_SCHEMA);
  assert.equal(record.candidate.sha, CANDIDATE);
  assert.equal(record.candidate.engine_root, ROOT);
  assert.equal(record.slots.length, 2);
  assert.deepEqual(record.slots.map((slot) => slot.id), ["clean-docs", "clean-openspec"]);
  assert.ok(reads.every((file) => file.startsWith(`${ROOT}/`)));
  assert.equal(persisted.length, 1, "intended pair is durable before remote mutation");
});

test("outer candidate movement aborts admission before prepare, persist, or fixture creation", async () => {
  let prepared = 0;
  let persisted = 0;
  let created = 0;
  const { deps } = baseDeps({
    observeOriginMainSha: async () => MOVED,
    resolveAndPrepareCandidate: async () => { prepared++; throw new Error("must not prepare moved C"); },
    persist: async () => { persisted++; },
    createFixture: async () => { created++; return 1; },
  });
  await assert.rejects(() => beginExactCandidateFrg({ repoDir: "/operator", repository: "owner/repo", baseBranch: "main",
    releaseVersion: "1.40.1", expectedCandidateSha: CANDIDATE }, deps), /origin\/main moved during/);
  assert.deepEqual({ prepared, persisted, created }, { prepared: 0, persisted: 0, created: 0 });
});

test("candidate C alone supplies worker and Tester policy identity", async () => {
  const gates = "9".repeat(64);
  const { record } = await begun({ resolveCandidatePolicy: async () => ({
    repository: "owner/repo", baseBranch: "main", implementer: "candidate-impl", reviewer: "candidate-review", gatesSha256: gates,
    reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) },
  }) });
  assert.deepEqual(record.worker_config, {
    implementer: "candidate-impl", reviewer: "candidate-review", gates_sha256: gates,
    review_standard_sha256: "2".repeat(64), review_low_risk_round2_sha256: "7".repeat(64), auto_file_repairs: false,
  });
});

test("begin rejects installed/operator roots and fixture-head substitution", async () => {
  const { deps } = baseDeps({
    resolveAndPrepareCandidate: async () => ({
      ok: true,
      engine: { ...engine(), engineRoot: "/installed", launcherPath: "/installed/pipeline", commitSha: MOVED },
    }),
  });
  await assert.rejects(() => beginExactCandidateFrg({
    repoDir: "/operator", repository: "owner/repo", baseBranch: "main", releaseVersion: "1.40.1",
    implementer: "i", reviewer: "r", gatesSha256: "c".repeat(64),
  }, deps), /prepared engine does not match/);
});

test("begin rejects wrong pack/version and template paths escaping the candidate pack", async () => {
  for (const mutate of [
    (manifest: Record<string, unknown>) => { manifest.pack_id = "legacy-pack"; },
    (manifest: Record<string, unknown>) => { manifest.manifest_version = 2; },
    (manifest: Record<string, unknown>) => { (manifest.templates as Array<Record<string, unknown>>)[0]!.file = "../outside.md"; },
    (manifest: Record<string, unknown>) => {
      const templates = manifest.templates as Array<Record<string, unknown>>;
      templates[1]!.file = templates[0]!.file;
      templates[1]!.sha256 = templates[0]!.sha256;
    },
  ]) {
    const source = files();
    const manifestPath = `${ROOT}/core/scripts/frg-packs/factory-gate-v1/manifest.json`;
    const manifest = JSON.parse(String(source.get(manifestPath))) as Record<string, unknown>;
    mutate(manifest);
    source.set(manifestPath, JSON.stringify(manifest));
    const { deps } = baseDeps({
      readCandidateFile: async (file) => source.get(path.resolve(file)) ?? (() => { throw new Error("unexpected escaped read"); })(),
    });
    await assert.rejects(() => beginExactCandidateFrg({
      repoDir: "/operator", repository: "owner/repo", baseBranch: "main", releaseVersion: "1.40.1",
      implementer: "claude", reviewer: "codex", gatesSha256: "c".repeat(64),
    }, deps), /manifest identity|candidate root|escapes the candidate pack|distinct candidate template files/);
  }
});

test("reconciliation adopts one slot and creates only the proven-absent slot", async () => {
  const { record, deps } = await begun();
  let creates = 0;
  const matches: RemoteFixtureMatch[] = [{
    issue_number: 101, epoch_id: record.epoch_id, candidate_sha: CANDIDATE,
    slot_id: "clean-docs", provenance_id: record.slots[0].provenance_id,
  }];
  deps.listFixtureMatches = async () => matches;
  deps.createFixture = async ({ slot }) => { creates++; return slot.id === "clean-openspec" ? 102 : 999; };
  const result = await reconcileExactCandidateFrgPair(record, deps);
  assert.deepEqual(result.slots.map((slot) => slot.issue_number), [101, 102]);
  assert.equal(creates, 1);
});

test("lost create response is reconciled and resume never creates a third issue", async () => {
  const { record, deps } = await begun();
  const remote: RemoteFixtureMatch[] = [];
  let creates = 0;
  deps.listFixtureMatches = async () => [...remote];
  deps.createFixture = async ({ slot }) => {
    creates++;
    const issue = slot.id === "clean-docs" ? 101 : 102;
    remote.push({ issue_number: issue, epoch_id: record.epoch_id, candidate_sha: CANDIDATE, slot_id: slot.id, provenance_id: slot.provenance_id });
    if (slot.id === "clean-docs") throw new Error("response lost");
    return issue;
  };
  const first = await reconcileExactCandidateFrgPair(record, deps);
  assert.deepEqual(first.slots.map((slot) => slot.issue_number), [101, 102]);
  const resumed = await reconcileExactCandidateFrgPair(first, deps);
  assert.deepEqual(resumed.slots.map((slot) => slot.issue_number), [101, 102]);
  assert.equal(creates, 2);
});

test("uncertain absent create waits; a later authoritative absence may retry the same slot", async () => {
  const { record, deps, persisted } = await begun();
  let attempts = 0;
  const remote: RemoteFixtureMatch[] = [];
  deps.listFixtureMatches = async () => [...remote];
  deps.createFixture = async ({ slot }) => {
    attempts++;
    assert.equal(persisted.at(-1)!.slots.find((candidate) => candidate.id === slot.id)!.create_certainty,
      "uncertain", "intent is durable before remote create");
    if (attempts === 1) throw new Error("timeout before remote mutation");
    const issue = slot.id === "clean-docs" ? 101 : 102;
    remote.push({ issue_number: issue, epoch_id: record.epoch_id, candidate_sha: CANDIDATE,
      slot_id: slot.id, provenance_id: slot.provenance_id });
    return issue;
  };
  const first = await reconcileExactCandidateFrgPair(record, deps);
  assert.equal(first.outcome, "external_or_transient_inconclusive");
  assert.equal(first.slots[0].create_certainty, "uncertain");
  const resumed = await reconcileExactCandidateFrgPair(first, deps);
  assert.deepEqual(resumed.slots.map((slot) => slot.issue_number), [101, 102]);
  assert.deepEqual(remote.map((match) => match.issue_number), [101, 102], "retry fills the same pair without a third remote fixture");
  assert.equal(attempts, 3, "one known-pre-mutation timeout is retried before the second slot");
});

test("duplicates and a foreign third claim are gate defects with no create", async () => {
  for (const kind of ["duplicate", "foreign"] as const) {
    const { record, deps } = await begun();
    let creates = 0;
    const base: RemoteFixtureMatch = {
      issue_number: 101, epoch_id: record.epoch_id, candidate_sha: CANDIDATE,
      slot_id: "clean-docs", provenance_id: record.slots[0].provenance_id,
    };
    deps.listFixtureMatches = async () => kind === "duplicate"
      ? [base, { ...base, issue_number: 103 }]
      : [{ ...base, slot_id: "foreign", provenance_id: "x".repeat(64) }];
    deps.createFixture = async () => { creates++; return 999; };
    const result = await reconcileExactCandidateFrgPair(record, deps);
    assert.equal(result.outcome, "gate_defect");
    assert.deepEqual(result.reconciliation_evidence?.map((item) => item.issue_number), kind === "duplicate" ? [101, 103] : [101],
      "terminal reconciliation retains every concrete discovered identity");
    assert.equal(creates, 0);
  }
});

test("whole-epoch conflict blocks mutation even when the current slot is absent", async () => {
  const { record, deps } = await begun();
  const openspec = {
    issue_number: 102, epoch_id: record.epoch_id, candidate_sha: CANDIDATE,
    slot_id: "clean-openspec", provenance_id: record.slots[1].provenance_id,
  };
  deps.listFixtureMatches = async () => [openspec, { ...openspec, issue_number: 103 }];
  let creates = 0;
  deps.createFixture = async () => { creates++; return 101; };
  const result = await reconcileExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "gate_defect");
  assert.match(result.outcome_detail, /duplicate clean-openspec/);
  assert.equal(creates, 0);
});

test("fixture inventory outages become durable waits and preserve uncertain create state", async () => {
  const { record, deps } = await begun();
  deps.listFixtureMatches = async () => { throw new Error("forge offline"); };
  const initial = await reconcileExactCandidateFrgPair(record, deps);
  assert.equal(initial.outcome, "external_or_transient_inconclusive");
  assert.match(initial.external_wait!.probe, /enumerate all issues/);

  let probes = 0;
  deps.listFixtureMatches = async () => {
    probes++;
    if (probes === 1) return [];
    throw new Error("forge offline after create timeout");
  };
  deps.createFixture = async () => { throw new Error("create response lost"); };
  const afterCreate = await reconcileExactCandidateFrgPair(record, deps);
  assert.equal(afterCreate.outcome, "external_or_transient_inconclusive");
  assert.equal(afterCreate.slots[0].create_certainty, "uncertain");
});

test("dispatch uses unchanged ordinary loop with exactly two explicit issues and no merge or label selector", async () => {
  const { record, engine: prepared, deps } = await begun();
  record.slots[0].issue_number = 101;
  record.slots[1].issue_number = 102;
  let argv: readonly string[] = [];
  let env: NodeJS.ProcessEnv = {};
  deps.dispatchOrdinaryLoop = async (input) => {
    argv = input.argv;
    env = input.env;
    await input.onHandoff(JSON.parse(loopResult().stdout));
    return loopResult();
  };
  const dispatched = await dispatchExactCandidateFrgPair(record, prepared, deps);
  assert.deepEqual(argv, ["loop", "101", "102", "--profile", "claude", "--engine-track", "candidate", "--domain", "owner/repo"]);
  assert.doesNotMatch(argv.join(" "), /--label|merge|factory-release|repair/);
  assert.equal(env[PIPELINE_SUPPRESS_AUTO_FILE_ENV], "1");
  assert.equal(env[PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV], "1");
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.PIPELINE_PACK_LOOP_CANDIDATE_SHA, CANDIDATE);
  assert.equal(dispatched.loop_run_id, CANONICAL_LOOP);
  assert.deepEqual(dispatched.slots.map((slot) => slot.advance_run_id), ["advance-1", "advance-2"]);
  assert.throws(() => exactCandidateFrgLoopArgv({ ...record, slots: [record.slots[0], { ...record.slots[1], issue_number: 101 }] }), /distinct/);
});

test("authoritative current green unmerged heads pass; claims and labels alone do not", async () => {
  const { record, deps } = await begun();
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    record.loop_run_id = CANONICAL_LOOP;
    record.loop_dispatch_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
  }
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "passed");
  assert.equal(verifyExactCandidateFrgResult(result, { epoch_id: record.epoch_id, candidate_sha: CANDIDATE }), result);
  for (const mutate of [
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.ingress_claims = { length: 0 } as never; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.issue.labels = ["pipeline:ready-to-deploy", ""] as never; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.unavailable_sources = [3] as never; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.changed_paths = [""]; },
  ]) {
    const malformedArray = structuredClone(result);
    mutate(malformedArray);
    assert.throws(() => parseExactCandidateFrgRecord(malformedArray), /string array/);
  }
  for (const mutate of [
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.observed_at = null as never; },
    (value: ExactCandidateFrgRecord) => { value.created_at = 7 as never; },
    (value: ExactCandidateFrgRecord) => { value.updated_at = "2026-09-08T20:00:00Z"; },
  ]) {
    const malformedTime = structuredClone(result);
    mutate(malformedTime);
    assert.throws(() => parseExactCandidateFrgRecord(malformedTime), /canonical ISO/);
  }
  const malformedCleanupTime = structuredClone(result);
  malformedCleanupTime.cleanup = [{ target: "issue:101", status: "debt", detail: "safe debt", observed_at: 9 as never }];
  malformedCleanupTime.cleanup_debt = true;
  assert.throws(() => parseExactCandidateFrgRecord(malformedCleanupTime), /canonical ISO/);
  const crossedGateEvidence = structuredClone(result);
  crossedGateEvidence.outcome = "gate_defect";
  crossedGateEvidence.gate_evidence = [{ source: "forge", slot_id: "clean-docs", issue_number: 101, pr_number: 301,
    candidate_sha: MOVED, observed_head_sha: "1".repeat(40), fact: "merged=true" }];
  assert.throws(() => parseExactCandidateFrgRecord(crossedGateEvidence), /crosses the recorded candidate/);
  const forged = structuredClone(result);
  forged.outcome = "passed";
  forged.slots[0].observation!.ci.conclusion = "pending";
  forged.slots[0].observation!.ingress_claims = ["worker pass:true", "public hash"];
  assert.throws(() => verifyExactCandidateFrgResult(forged, { epoch_id: record.epoch_id, candidate_sha: CANDIDATE }), /lacks authoritative/);
  for (const mutate of [
    (value: ExactCandidateFrgRecord) => { value.loop_run_id = null; },
    (value: ExactCandidateFrgRecord) => { value.loop_dispatch_certainty = "uncertain"; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].issue_number = null; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].advance_run_id = null; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].create_certainty = "uncertain"; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.ordinary.loop_item_state = "in_progress"; },
  ]) {
    const incomplete = structuredClone(result);
    mutate(incomplete);
    assert.throws(() => verifyExactCandidateFrgResult(incomplete, { epoch_id: record.epoch_id, candidate_sha: CANDIDATE }));
  }
  const prooflessRegression = structuredClone(result);
  prooflessRegression.outcome = "exact_candidate_regression";
  assert.throws(() => parseExactCandidateFrgRecord(prooflessRegression), /requires concrete/);
  const regression = structuredClone(result);
  regression.outcome = "exact_candidate_regression";
  regression.slots[0].observation!.ordinary.regression_proof = {
    source: "run_store", advance_run_id: regression.slots[0].advance_run_id!, candidate_sha: CANDIDATE,
    fixture_pr_head_sha: regression.slots[0].pr_head_sha!, classification: "demonstrated_candidate_regression",
  };
  assert.equal(parseExactCandidateFrgRecord(regression), regression);
  for (const mutate of [
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.ordinary.regression_proof!.advance_run_id = "other-run"; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.ordinary.regression_proof!.candidate_sha = MOVED; },
    (value: ExactCandidateFrgRecord) => { value.slots[0].observation!.ordinary.regression_proof!.fixture_pr_head_sha = MOVED; },
  ]) {
    const crossed = structuredClone(regression);
    mutate(crossed);
    assert.throws(() => parseExactCandidateFrgRecord(crossed), /crosses the recorded/);
  }
  const contradictoryPending = structuredClone(regression);
  contradictoryPending.outcome = "pending";
  assert.throws(() => parseExactCandidateFrgRecord(contradictoryPending), /cannot retain contradictory/);
});

test("wrong-head, stale, merged, non-independent, and worker-config evidence cannot pass", async () => {
  const { record } = await begun();
  const variants: ExactCandidateFrgObservation[] = [];
  const wrongHead = passingObservation(record); wrongHead.ci.head_sha = MOVED; variants.push(wrongHead);
  const merged = passingObservation(record); merged.pr.merged = true; variants.push(merged);
  const review = passingObservation(record); review.review.independent = false; variants.push(review);
  const tester = passingObservation(record); tester.tester.config_digest = "d".repeat(64); variants.push(tester);
  const stale = passingObservation(record); stale.issue.provenance_candidate_sha = MOVED; variants.push(stale);
  const blocked = passingObservation(record); blocked.issue.labels.push("blocked"); variants.push(blocked);
  const needsHuman = passingObservation(record); needsHuman.issue.labels.push("pipeline:needs-human"); variants.push(needsHuman);
  for (const observation of variants) {
    assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], observation), "gate_defect");
  }
});

test("four non-pass classes distinguish fixture revision, infrastructure, and demonstrated candidate regression", async () => {
  const { record } = await begun();
  record.slots[0].advance_run_id = "advance-1";
  const review = passingObservation(record); review.review.verdict = "changes_requested";
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], review), "ordinary_review_revision");
  const incompleteRevision = passingObservation(record);
  incompleteRevision.review.verdict = "changes_requested";
  incompleteRevision.ci.conclusion = "pending";
  incompleteRevision.tester.conclusion = "unavailable";
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], incompleteRevision), "ordinary_review_revision",
    "a conclusive current review revision precedes unrelated pending evidence");
  const outage = passingObservation(record); outage.unavailable_sources = ["ci transport"];
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], outage), "external_or_transient_inconclusive");
  const fixtureRevision = passingObservation(record); fixtureRevision.tester.conclusion = "failed";
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], fixtureRevision), "ordinary_review_revision");
  const regression = passingObservation(record);
  regression.tester.conclusion = "failed";
  regression.ordinary.regression_proof = {
    source: "run_store", advance_run_id: regression.ordinary.advance_run_id, candidate_sha: record.candidate.sha,
    fixture_pr_head_sha: regression.pr.head_sha, classification: "demonstrated_candidate_regression",
  };
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], regression), "exact_candidate_regression");
  const contradictoryPass = passingObservation(record);
  contradictoryPass.ordinary.regression_proof = regression.ordinary.regression_proof;
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], contradictoryPass), "exact_candidate_regression",
    "current canonical regression proof outranks an otherwise pass-shaped observation");
  const defect = passingObservation(record); defect.pr.merged = true;
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], defect), "gate_defect");
});

test("canonical review currency accepts only trusted pipeline-internal successor coverage", async () => {
  const reviewed = "1".repeat(40);
  const current = "2".repeat(40);
  const artifact = {
    round: 2 as const, reviewedSha: reviewed, diffHash: "a".repeat(16), blockingKeys: [], review1Risk: null,
    pipelineRunId: "101/source-trace",
  };
  const body = finalizeReviewArtifactComment(`## Review 2 — approve\n${encodeReviewArtifact(artifact)}`, []);
  const comments = [{ author: "pipeline-bot", body }];
  const accepted = await resolveExactCandidateCurrentReviewArtifact(comments, {
    actor: "pipeline-bot", currentHeadSha: current, currentDiffHash: "b".repeat(16),
  }, async () => "current");
  assert.equal(accepted?.reviewedSha, reviewed, "the shared pipeline-internal currency decision covers an archive successor head");
  assert.equal(await resolveExactCandidateCurrentReviewArtifact(comments, {
    actor: "pipeline-bot", currentHeadSha: current, currentDiffHash: "b".repeat(16),
  }, async () => "superseded"), null);
  assert.equal(await resolveExactCandidateCurrentReviewArtifact(comments, {
    actor: "pipeline-bot", currentHeadSha: current, currentDiffHash: artifact.diffHash,
  }, async () => "superseded"), null, "equal diff alone cannot authorize a superseded prior reviewed SHA");
  assert.equal(await resolveExactCandidateCurrentReviewArtifact(comments, {
    actor: "pipeline-bot", currentHeadSha: current, currentDiffHash: artifact.diffHash,
  }, async () => "unknown"), null, "equal diff alone cannot authorize an unknown prior reviewed SHA");
  const currentArtifact = { ...artifact, reviewedSha: current };
  const currentComments = [{ author: "pipeline-bot", body: finalizeReviewArtifactComment(
    `## Review 2 — approve\n${encodeReviewArtifact(currentArtifact)}`, []) }];
  assert.equal((await resolveExactCandidateCurrentReviewArtifact(currentComments, {
    actor: "pipeline-bot", currentHeadSha: current, currentDiffHash: currentArtifact.diffHash,
  }, async () => "unknown"))?.reviewedSha, current, "the exact current reviewed SHA still requires and accepts its matching diff");
  assert.equal(await resolveExactCandidateCurrentReviewArtifact(comments, {
    actor: "forged-user", currentHeadSha: current, currentDiffHash: artifact.diffHash,
  }, async () => "current"), null);
});

test("candidate movement marks old evidence stale without rebinding it", async () => {
  const { record, deps } = await begun({ observeOriginMainSha: async () => CANDIDATE });
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    record.loop_run_id = CANONICAL_LOOP;
    slot.advance_run_id = `advance-${index + 1}`;
  }
  deps.observeOriginMainSha = async () => MOVED;
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "stale_candidate");
  assert.equal(result.candidate.sha, CANDIDATE);
  assert.ok(result.slots.every((slot) => slot.candidate_sha === CANDIDATE));
});

test("pair observation final-bookends candidate and both fixture identities", async () => {
  const { record, deps } = await begun();
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    record.loop_run_id = CANONICAL_LOOP;
    slot.advance_run_id = `advance-${index + 1}`;
  }
  let candidateReads = 0;
  deps.observeOriginMainSha = async () => ++candidateReads === 1 ? CANDIDATE : MOVED;
  assert.equal((await observeExactCandidateFrgPair(record, deps)).outcome, "stale_candidate");

  deps.observeOriginMainSha = async () => CANDIDATE;
  deps.reobserveFixtureIdentity = async (current, slot) => {
    const index = slot.id === "clean-docs" ? 0 : 1;
    const observation = passingObservation(current, index);
    return {
      issue_number: slot.issue_number!, issue_open: true, pr_number: observation.pr.number,
      pr_head_sha: slot.id === "clean-docs" ? MOVED : observation.pr.head_sha, pr_open: true, merged: false,
    };
  };
  assert.equal((await observeExactCandidateFrgPair(record, deps)).outcome, "gate_defect");
});

test("final bookend preserves a current non-ready review revision", async () => {
  const { record, deps } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.advance_run_id = `advance-${index + 1}`; });
  deps.observeFixture = async (current, slot) => {
    const observation = passingObservation(current, slot.id === "clean-docs" ? 0 : 1);
    if (slot.id === "clean-docs") {
      observation.review.verdict = "changes_requested";
      observation.ci.conclusion = "pending";
      observation.tester.conclusion = "unavailable";
      observation.issue.labels = ["blocked", "pipeline:review-1"];
    }
    return observation;
  };
  const readyRequirements: boolean[] = [];
  deps.reobserveFixtureIdentity = async (current, slot, options) => {
    readyRequirements.push(options?.requireReady ?? true);
    const observation = passingObservation(current, slot.id === "clean-docs" ? 0 : 1);
    return { issue_number: slot.issue_number!, issue_open: true, pr_number: observation.pr.number,
      pr_head_sha: observation.pr.head_sha, pr_open: true, merged: false };
  };
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "ordinary_review_revision");
  assert.deepEqual(readyRequirements, [false, true]);
});

test("normalized ingress contradictions are retained in the persisted slot observation", async () => {
  const { record, deps, persisted } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
  });
  deps.observeFixture = async (current, slot) => {
    const observation = passingObservation(current, slot.id === "clean-docs" ? 0 : 1);
    if (slot.id === "clean-docs") observation.ingress_claims = ["ordinary-summary:worker-role-mismatch"];
    return observation;
  };
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "gate_defect");
  assert.deepEqual(result.slots[0].observation?.ingress_claims, ["ordinary-summary:worker-role-mismatch"]);
  assert.deepEqual(persisted.at(-1)?.slots[0].observation?.ingress_claims, ["ordinary-summary:worker-role-mismatch"]);
});

test("result is persisted before cleanup and cleanup debt cannot invalidate pass", async () => {
  const order: string[] = [];
  const { record, deps } = await begun({
    persist: async (saved) => { if (saved.outcome === "passed") order.push(saved.cleanup.length ? "persist-cleanup" : "persist-result"); },
    cleanup: async (cleanupInput) => {
      order.push("cleanup");
      cleanupInput.candidate.sha = MOVED;
      cleanupInput.outcome = "gate_defect";
      return [{ target: "branch/frg", status: "debt", detail: "identity moved; no mutation", observed_at: "2026-09-08T20:02:00.000Z" }];
    },
  });
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    record.loop_run_id = CANONICAL_LOOP;
    slot.advance_run_id = `advance-${index + 1}`;
  }
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.deepEqual(order, ["persist-result", "cleanup", "persist-cleanup"]);
  assert.equal(result.outcome, "passed");
  assert.equal(result.candidate.sha, CANDIDATE, "cleanup receives an isolated snapshot and cannot rewrite persisted proof");
  assert.equal(result.cleanup_debt, true);
  assert.match(result.cleanup[0]!.detail, /no mutation/);
});

test("production cleanup records deterministic debt when the remote has no conditional close operation", async () => {
  const { record } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
    slot.pr_number = 301 + index;
    slot.pr_head_sha = String(index + 1).repeat(40);
    slot.observation = passingObservation(record, index);
  });
  const io = {
    now: () => new Date("2026-09-08T20:10:00.000Z"),
    readFile: async (file: string) => candidateTemplateForPath(file),
    getIssue: async (_input: unknown, issueNumber: number) => {
      const slot = record.slots.find((item) => item.issue_number === issueNumber)!;
      return { body: templateBodyForTest(record, slot), labels: ["pipeline:ready-to-deploy"], state: "open" as const };
    },
    listPrsAnyState: async (_input: unknown, issue: number) => ({ numbers: [issue + 200], truncated: false }),
    listOpenPrs: async () => [],
    getPr: async (_input: unknown, prNumber: number) => {
      const slot = record.slots.find((item) => item.pr_number === prNumber)!;
      return { number: prNumber, head_sha: slot.pr_head_sha!, base_ref: record.base_branch, state: "open", merged: false };
    },
  } as unknown as ProductionExactCandidateFrgIo;
  const deps = createProductionExactCandidateFrgDeps({ repoDir: "/operator", repository: record.repository,
    baseBranch: record.base_branch, releaseVersion: record.release_version }, io);
  const facts = await deps.cleanup!(record);
  assert.ok(facts.every((fact) => fact.status === "debt"));
  assert.ok(facts.some((fact) => /conditional remote mutation/.test(fact.detail)));
});

function ownedCleanupRecord(): ExactCandidateFrgRecord {
  return {
    slots: [
      {
        id: "clean-docs",
        issue_number: 101,
        provenance_id: "prov-docs",
        pr_number: 301,
        pr_head_sha: "1".repeat(40),
      },
      {
        id: "clean-openspec",
        issue_number: 102,
        provenance_id: "prov-openspec",
        pr_number: 302,
        pr_head_sha: "2".repeat(40),
      },
    ],
    epoch_id: "frg-1.40.1-aaaaaaaaaaaa",
    candidate: { sha: CANDIDATE },
  } as ExactCandidateFrgRecord;
}

function provenanceBody(record: ExactCandidateFrgRecord, slot: ExactCandidateFrgRecord["slots"][number]): string {
  return `<!-- pipeline-exact-frg:v1 epoch=${record.epoch_id} candidate=${record.candidate.sha} slot=${slot.id} provenance=${slot.provenance_id} -->\nfixture`;
}

test("owned failed synthetic identity can be cleaned after identity match", async () => {
  const record = ownedCleanupRecord();
  const closed: string[] = [];
  const facts = await cleanupOwnedFailedSyntheticArtifacts(record, {
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    getIssue: async (issueNumber) => {
      const slot = record.slots.find((item) => item.issue_number === issueNumber)!;
      return { body: provenanceBody(record, slot), labels: ["factory-gate"], state: "open" };
    },
    getPr: async (prNumber) => {
      const slot = record.slots.find((item) => item.pr_number === prNumber)!;
      return { number: prNumber, head_sha: slot.pr_head_sha!, state: "open", merged: false };
    },
    closeIssue: async (issueNumber) => { closed.push(`issue:${issueNumber}`); },
    closePr: async (prNumber) => { closed.push(`pr:${prNumber}`); },
    observeBranch: async (name) => {
      const issueNumber = Number(name.match(/pipeline\/(\d+)-frg/)?.[1]);
      const slot = record.slots.find((item) => item.issue_number === issueNumber)!;
      return { name, sha: slot.pr_head_sha! };
    },
    deleteBranch: async (name) => { closed.push(`branch:${name}`); },
    observeWorktree: async (worktreePath) => {
      const issueNumber = Number(worktreePath.match(/pipeline-(\d+)-frg/)?.[1]);
      return { path: worktreePath, owned: true, identity: `issue:${issueNumber}` };
    },
    deleteOwnedWorktree: async (worktreePath) => { closed.push(`worktree:${worktreePath}`); },
  });
  assert.deepEqual(closed, [
    "issue:101", "pr:301", "branch:pipeline/101-frg", "worktree:.worktrees/pipeline-101-frg",
    "issue:102", "pr:302", "branch:pipeline/102-frg", "worktree:.worktrees/pipeline-102-frg",
  ]);
  assert.ok(facts.every((fact) => fact.status === "cleaned"));
  assert.ok(!facts.some((fact) => /operator completed live cleanup/i.test(fact.detail)));
});

test("unrelated issues, pull requests, and user worktrees stay unchanged with cleanup debt", async () => {
  const record = ownedCleanupRecord();
  const closed: string[] = [];
  const facts = await cleanupOwnedFailedSyntheticArtifacts(record, {
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    getIssue: async (issueNumber) => ({
      body: `unrelated issue #${issueNumber} without exact-frg provenance`,
      labels: ["bug"],
      state: "open",
    }),
    getPr: async (prNumber) => ({
      number: prNumber + 50,
      head_sha: "9".repeat(40),
      state: "open",
      merged: false,
    }),
    closeIssue: async (issueNumber) => { closed.push(`issue:${issueNumber}`); },
    closePr: async (prNumber) => { closed.push(`pr:${prNumber}`); },
    observeBranch: async (name) => ({ name, sha: "9".repeat(40) }),
    deleteBranch: async (name) => { closed.push(`branch:${name}`); },
    observeWorktree: async (worktreePath) => ({
      path: "/home/user/.worktrees/feat-other",
      owned: false,
      identity: "user",
    }),
    deleteOwnedWorktree: async (worktreePath) => { closed.push(`worktree:${worktreePath}`); },
  });
  assert.deepEqual(closed, []);
  assert.ok(facts.every((fact) => fact.status === "debt"));
  assert.ok(facts.some((fact) => fact.target.startsWith("issue:") && /no longer matches/.test(fact.detail)));
  assert.ok(facts.some((fact) => fact.target.startsWith("pr:") && /no longer matches/.test(fact.detail)));
  assert.ok(facts.some((fact) => fact.target.startsWith("worktree:") && /not the recorded owned synthetic worktree/.test(fact.detail)));
});

test("historical HMAC latest.json is not current-candidate authority", async () => {
  assert.equal(isHistoricalFailedShipEvidencePath(".agent-pipeline/frg/1.40.1/latest.json"), true);
  assert.equal(isHistoricalFailedShipEvidencePath("/repo/.agent-pipeline/frg/1.39.0/attestor.json"), true);
  assert.equal(isHistoricalFailedShipEvidencePath(".agent-pipeline/frg/exact-pair/frg-1.40.1-aaaaaaaaaaaa.json"), false);
  const { record, deps, persisted } = await begun();
  const reads: string[] = [];
  const originalRead = deps.readCandidateFile;
  deps.readCandidateFile = async (file) => {
    reads.push(file);
    assert.equal(isHistoricalFailedShipEvidencePath(file), false, `current proof must not read ${file}`);
    return originalRead(file);
  };
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
  });
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "passed");
  assert.equal(reads.some((file) => isHistoricalFailedShipEvidencePath(file)), false);
  assert.equal(persisted.at(-1)?.outcome, "passed");
  assert.throws(
    () => verifyExactCandidateFrgResult(
      { pass: true, integrity: { attestation: "hmac" }, candidate_sha: "b".repeat(40) },
      { epoch_id: record.epoch_id, candidate_sha: CANDIDATE },
    ),
    /schema/,
  );
});

test("absent old scorer does not block a current exact-pair proof", async () => {
  const { record, deps } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
  });
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "passed");
  verifyExactCandidateFrgResult(result, { epoch_id: result.epoch_id, candidate_sha: CANDIDATE });
});

test("legacy score, HMAC, qualification, and public-hash shapes cannot satisfy verifier", () => {
  for (const legacy of [
    { pass: true, score: 100 },
    { pass: true, integrity: { attestation: "hmac" } },
    { candidate_sha: CANDIDATE, matrix_version: 8, rows: [] },
    { public_hash: "f".repeat(64) },
  ]) {
    assert.throws(() => verifyExactCandidateFrgResult(legacy, { epoch_id: "x", candidate_sha: CANDIDATE }), /schema/);
  }
});

test("one runner tick composes exact pair creation, ordinary loop, and observation", async () => {
  const { deps } = baseDeps();
  const result = await runExactCandidateFrg({
    repoDir: "/operator", repository: "owner/repo", baseBranch: "main", releaseVersion: "1.40.1",
    implementer: "claude", reviewer: "codex", gatesSha256: "c".repeat(64),
  }, deps);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.slots.map((slot) => slot.issue_number), [101, 102]);
  assert.equal(result.loop_run_id, CANONICAL_LOOP);
  assert.deepEqual(result.slots.map((slot) => slot.advance_run_id), ["advance-1", "advance-2"]);
});

test("outer runner preserves the newest streamed handoff on dispatch failure", async () => {
  const { record, deps } = await begun();
  deps.dispatchOrdinaryLoop = async ({ onHandoff }) => {
    await onHandoff(JSON.parse(loopResult("durable-loop-after-error").stdout));
    throw new Error("child transport disappeared");
  };
  const result = await runExactCandidateFrg({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, operationalDomain: record.operational_domain,
  }, deps, record);
  assert.equal(result.outcome, "external_or_transient_inconclusive");
  assert.equal(result.loop_run_id, "durable-loop-after-error");
  assert.equal(result.loop_dispatch_certainty, "uncertain");
});

test("candidate policy and input drift during the loop fails before observation", async () => {
  const { record, deps, source } = await begun();
  let observed = false;
  deps.dispatchOrdinaryLoop = async () => {
    source.set(`${ROOT}/core/package-lock.json`, "mutated candidate lockfile");
    return loopResult();
  };
  deps.observeFixture = async () => { observed = true; throw new Error("must not observe drifted C"); };
  const result = await runExactCandidateFrg({ repoDir: "/operator", repository: record.repository,
    baseBranch: record.base_branch, releaseVersion: record.release_version, operationalDomain: record.operational_domain }, deps, record);
  assert.equal(result.outcome, "gate_defect");
  assert.match(result.outcome_detail, /candidate C changed before observation/);
  assert.equal(observed, false);
});

test("resume rejects changed release, repository, or worker bindings", async () => {
  const { record, deps } = await begun();
  const result = await runExactCandidateFrg({
    repoDir: "/operator", repository: "other/repo", baseBranch: "main", releaseVersion: "1.40.1",
    implementer: "claude", reviewer: "codex", gatesSha256: "c".repeat(64),
  }, deps, record);
  assert.equal(result.outcome, "gate_defect");
  assert.match(result.outcome_detail, /resume input/);
  assert.equal(result.repository, "owner/repo");
});

test("candidate prepare lock contention remains retryable in the same epoch", async () => {
  const { record, deps } = await begun();
  record.outcome = "external_or_transient_inconclusive";
  record.external_wait = { probe: "observer", wake_condition: "available" };
  let locked = true;
  deps.resolveAndPrepareCandidate = async () => locked
    ? { ok: false, kind: "lock", error: "owned" }
    : { ok: true, engine: engine() };
  const input = { repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, operationalDomain: record.operational_domain };
  const waiting = await runExactCandidateFrg(input, deps, record);
  assert.equal(waiting.outcome, "external_or_transient_inconclusive");
  assert.match(waiting.external_wait!.probe, /re-prepare the exact recorded candidate/);
  locked = false;
  const resumed = await runExactCandidateFrg(input, deps, waiting);
  assert.equal(resumed.candidate.sha, record.candidate.sha);
});

test("candidate readiness outage preserves the same owned pair for retry", async () => {
  const { record, deps } = await begun();
  record.outcome = "external_or_transient_inconclusive";
  record.external_wait = { probe: "provider", wake_condition: "retry" };
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; });
  deps.resolveAndPrepareCandidate = async () => ({ ok: false, kind: "readiness", error: "registry timeout" });
  const result = await runExactCandidateFrg({ repoDir: "/operator", repository: record.repository,
    baseBranch: record.base_branch, releaseVersion: record.release_version }, deps, record);
  assert.equal(result.outcome, "external_or_transient_inconclusive");
  assert.deepEqual(result.slots.map((slot) => slot.issue_number), [101, 102]);
  assert.match(result.external_wait!.probe, /re-prepare/);
});

test("resume rematerializes the same candidate at a new validated root", async () => {
  const { record, deps, source } = await begun();
  record.outcome = "external_or_transient_inconclusive";
  record.external_wait = { probe: "observer", wake_condition: "available" };
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.advance_run_id = `advance-${index + 1}`; });
  deps.resolveAndPrepareCandidate = async () => ({ ok: true, engine: {
    ...engine(), engineRoot: "/candidate-rematerialized", launcherPath: "/candidate-rematerialized/scripts/pipeline-launcher.mjs",
  } });
  deps.readCandidateFile = async (file) => source.get(path.resolve(file).replace("/candidate-rematerialized", ROOT))!;
  deps.listFixtureMatches = async () => record.slots.map((slot) => ({
    issue_number: slot.issue_number!, epoch_id: record.epoch_id, candidate_sha: CANDIDATE,
    slot_id: slot.id, provenance_id: slot.provenance_id,
  }));
  const result = await runExactCandidateFrg({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, implementer: record.worker_config.implementer,
    reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  }, deps, record);
  assert.equal(result.outcome, "passed");
  assert.equal(result.candidate.engine_root, "/candidate-rematerialized");
});

test("stored pass stays immutable, resumes cleanup only, and survives origin observer outages", async () => {
  const { record, deps, persisted, source } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
  });
  const passed = await observeExactCandidateFrgPair(record, deps);
  assert.equal(passed.outcome, "passed");
  let observations = 0;
  deps.observeFixture = async (current, slot) => {
    observations++;
    const observation = passingObservation(current, slot.id === "clean-docs" ? 0 : 1);
    observation.pr.merged = true;
    observation.pr.state = "merged";
    return observation;
  };
  deps.cleanup = async (current) => current.slots.map((slot) => ({
    target: `issue:${slot.issue_number}`, status: "debt", detail: "already closed; package-3 will reconcile", observed_at: "2026-09-08T20:10:00.000Z",
  }));
  const input = {
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, implementer: record.worker_config.implementer,
    reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  };
  const retained = await runExactCandidateFrg(input, deps, passed);
  assert.equal(retained.outcome, "passed");
  assert.equal(retained.cleanup.length, 2);
  assert.equal(retained.cleanup_debt, true);
  assert.equal(observations, 0, "cleanup retry never re-runs fixture qualification");

  deps.observeOriginMainSha = async () => { throw new Error("remote unavailable"); };
  await assert.rejects(() => runExactCandidateFrg(input, deps, retained), /preserving durable pass/);
  assert.equal(persisted.at(-1)!.outcome, "passed");
});

test("cleanup fact combinations never invalidate a durable pass", async () => {
  const { record, deps } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; slot.advance_run_id = `advance-${index + 1}`; });
  const passed = await observeExactCandidateFrgPair(record, deps);
  passed.operational_domain = "agent-pipeline";
  const input = { repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, operationalDomain: passed.operational_domain };
  for (const statuses of [["cleaned", "cleaned"], ["cleaned", "debt"], ["debt", "debt"]] as const) {
    const existing = structuredClone(passed);
    existing.cleanup = statuses.map((status, index) => ({
      target: `issue:${101 + index}`, status, detail: status, observed_at: "2026-09-08T20:10:00.000Z",
    }));
    existing.cleanup_debt = statuses.includes("debt");
    let observed = false;
    deps.observeFixture = async () => { observed = true; throw new Error("must not observe"); };
    const retained = await runExactCandidateFrg(input, deps, existing);
    assert.equal(retained.outcome, "passed");
    assert.equal(observed, false);
  }
});

test("production movement probes use the release target origin, not an alternate candidate root", async () => {
  const { record } = await begun();
  record.candidate.engine_root = "/alternate-clean-candidate";
  record.candidate.launcher_path = "/alternate-clean-candidate/scripts/pipeline-launcher.mjs";
  let observedRepoDir = "";
  const input = {
    repoDir: "/release-target", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, implementer: record.worker_config.implementer,
    reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  };
  const deps = createProductionExactCandidateFrgDeps(input, {
    now: () => new Date(), observeOriginMainSha: async (repoDir) => { observedRepoDir = repoDir; return MOVED; },
    writeRecord: async () => {},
  } as unknown as ProductionExactCandidateFrgIo, "/release-target");
  assert.equal((await runExactCandidateFrg(input, deps, record)).outcome, "stale_candidate");
  assert.equal(observedRepoDir, "/release-target");
});

test("atomic result store writes outside fixture control and renames last", async () => {
  const { record } = await begun();
  const actions: string[] = [];
  let durableBody = "";
  await persistExactCandidateFrgRecord("/release-owner", record, {
    mkdir: async (directory) => { actions.push(`mkdir:${directory}`); },
    writeFile: async (file, body) => {
      actions.push(`write:${file}`);
      assert.equal(JSON.parse(body).candidate.sha, CANDIDATE);
      durableBody = body;
    },
    rename: async (from, to) => { actions.push(`rename:${from}->${to}`); },
    syncFile: async (file) => { actions.push(`sync-file:${file}`); },
    syncDir: async (directory) => { actions.push(`sync-dir:${directory}`); },
  });
  const destination = exactCandidateFrgResultPath("/release-owner", record.epoch_id);
  assert.equal(actions[0], `mkdir:${path.dirname(destination)}`);
  assert.match(actions[1]!, /\.tmp-/);
  assert.equal(actions[2], `sync-file:${destination}.tmp-${process.pid}`);
  assert.equal(actions[3], `rename:${destination}.tmp-${process.pid}->${destination}`);
  assert.equal(actions[4], `sync-dir:${path.dirname(destination)}`);
  assert.doesNotMatch(destination, /candidate|fixture/);
  const loaded = await loadExactCandidateFrgRecord("/release-owner", record.epoch_id, {
    readFile: async (file) => file === destination ? durableBody : null,
  });
  assert.deepEqual(loaded, record, "a restart reloads the exact persisted candidate and intended pair");
});

test("rendering deterministically removes the OpenSpec placeholder before create", async () => {
  const source = files();
  const bodyWithPlaceholder = OPENSPEC + " {{openspec_change_id}}";
  source.set(`${ROOT}/core/scripts/frg-packs/factory-gate-v1/templates/clean-openspec.md`, bodyWithPlaceholder);
  const manifest = JSON.parse(String(source.get(`${ROOT}/core/scripts/frg-packs/factory-gate-v1/manifest.json`)));
  manifest.templates[1].sha256 = hash(bodyWithPlaceholder);
  source.set(`${ROOT}/core/scripts/frg-packs/factory-gate-v1/manifest.json`, JSON.stringify(manifest));
  const { record, deps } = await begun({
    readCandidateFile: async (file) => source.get(path.resolve(file)) ?? (() => { throw new Error("missing"); })(),
  });
  let createdBody = "";
  const matches: RemoteFixtureMatch[] = [];
  deps.listFixtureMatches = async () => matches;
  deps.createFixture = async ({ record: current, slot, body }) => {
    if (slot.id === "clean-openspec") createdBody = body;
    const issue_number = slot.id === "clean-docs" ? 101 : 102;
    matches.push({
      issue_number, epoch_id: current.epoch_id, candidate_sha: current.candidate.sha,
      slot_id: slot.id, provenance_id: slot.provenance_id,
    });
    return issue_number;
  };
  await reconcileExactCandidateFrgPair(record, deps);
  assert.doesNotMatch(createdBody, /{{openspec_change_id}}/);
  assert.match(createdBody, new RegExp(`${record.epoch_id}-clean-openspec`));
});

test("canonical handoff rejects wrong selector, duplicate children, and multiple handoffs", () => {
  const good = loopResult();
  assert.deepEqual(parseExactCandidateFrgLoopHandoff(good.stdout, good.contract, good.ledger, good.handoff, [101, 102], CANDIDATE).advance_run_ids, ["advance-1", "advance-2"]);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout, { ...good.contract, selector: { type: "label", value: "factory-gate" } }, good.ledger, good.handoff, [101, 102], CANDIDATE), /exact two-item work-list/);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout, good.contract, { ...good.ledger, items: { "101": { advance_run_id: "same" }, "102": { advance_run_id: "same" } } }, good.handoff, [101, 102], CANDIDATE), /distinct child/);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout, good.contract, { ...good.ledger, items: { ...good.ledger.items, "103": { advance_run_id: "advance-3" } } }, good.handoff, [101, 102], CANDIDATE), /exact fixture pair/);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout, { ...good.contract, repo: { name: "other/repo", base_branch: "main" } }, good.ledger, good.handoff, [101, 102], CANDIDATE, "owner/repo", "main"), /repository/);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout + good.stdout, good.contract, good.ledger, good.handoff, [101, 102], CANDIDATE), /exactly one/);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout, good.contract, good.ledger, { ...good.handoff, candidate_sha: MOVED }, [101, 102], CANDIDATE), /exact engine candidate/);
  assert.throws(() => parseExactCandidateFrgLoopHandoff(good.stdout, good.contract, good.ledger, good.handoff,
    [101, 102], CANDIDATE, "owner/repo", "main", "codex"), /engine/);
  const noncanonical = loopResult("not-the-canonical-work-list");
  assert.throws(() => parseExactCandidateFrgLoopHandoff(noncanonical.stdout, noncanonical.contract, noncanonical.ledger,
    noncanonical.handoff, [101, 102], CANDIDATE, "owner/repo", "main", "claude"), /canonical work-list identity/);
});

test("streamed loop handoff is durable before process failure and restart resumes that exact loop", async () => {
  const { record, engine: prepared, deps, persisted } = await begun();
  record.slots[0].issue_number = 101;
  record.slots[1].issue_number = 102;
  deps.dispatchOrdinaryLoop = async (input) => {
    await input.onHandoff(JSON.parse(loopResult().stdout));
    throw new Error("process interrupted");
  };
  await assert.rejects(() => dispatchExactCandidateFrgPair(record, prepared, deps), /process interrupted/);
  const durable = persisted.at(-1)!;
  assert.equal(durable.loop_run_id, CANONICAL_LOOP);
  assert.deepEqual(durable.slots.map((slot) => slot.advance_run_id), [null, null]);

  let resumeArgv: readonly string[] = [];
  deps.dispatchOrdinaryLoop = async (input) => {
    resumeArgv = input.argv;
    await input.onHandoff({ ...JSON.parse(loopResult().stdout), resumed: true, selector: null });
    return loopResult();
  };
  const resumed = await dispatchExactCandidateFrgPair(durable, prepared, deps);
  assert.deepEqual(resumeArgv, ["loop", "--resume", CANONICAL_LOOP, "--profile", "claude", "--engine-track", "candidate", "--domain", "owner/repo"]);
  assert.deepEqual(resumed.slots.map((slot) => slot.advance_run_id), ["advance-1", "advance-2"]);
});

test("partial handoff is validated before resume and harvests only the exact durable children", async () => {
  const { record, deps } = await begun();
  record.outcome = "external_or_transient_inconclusive";
  record.external_wait = { probe: "loop", wake_condition: "resume" };
  record.loop_run_id = CANONICAL_LOOP;
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; });
  deps.listFixtureMatches = async () => record.slots.map((slot) => ({
    issue_number: slot.issue_number!, epoch_id: record.epoch_id, candidate_sha: record.candidate.sha,
    slot_id: slot.id, provenance_id: slot.provenance_id,
  }));
  let dispatches = 0;
  deps.dispatchOrdinaryLoop = async () => {
    dispatches++;
    assert.equal(record.slots[0].advance_run_id, null, "source fixture is not mutated");
    return loopResult();
  };
  deps.ordinaryLoopNeedsResume = async () => true;
  deps.validateOrdinaryLoop = async () => ["advance-1", null];
  const input = { repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version };
  const resumed = await runExactCandidateFrg(input, deps, record);
  assert.equal(dispatches, 1);
  assert.deepEqual(resumed.slots.map((slot) => slot.advance_run_id), ["advance-1", "advance-2"]);

  const invalid = structuredClone(record);
  deps.validateOrdinaryLoop = async () => { throw new Error("wrong candidate or selector"); };
  dispatches = 0;
  const rejected = await runExactCandidateFrg(input, deps, invalid);
  assert.equal(rejected.outcome, "gate_defect");
  assert.equal(dispatches, 0, "invalid durable handoff is rejected before candidate process mutation");
});

test("initial partial child linkage stays externally resumable on the same canonical parent", async () => {
  const { record, deps } = await begun();
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; });
  deps.listFixtureMatches = async () => record.slots.map((slot) => ({ issue_number: slot.issue_number!, epoch_id: record.epoch_id,
    candidate_sha: record.candidate.sha, slot_id: slot.id, provenance_id: slot.provenance_id }));
  deps.dispatchOrdinaryLoop = async () => {
    const result = loopResult();
    result.ledger.items["102"].advance_run_id = null as never;
    return result;
  };
  let observations = 0;
  deps.observeFixture = async (...args) => { observations++; return observation(...args); };
  const result = await runExactCandidateFrg({ repoDir: "/operator", repository: record.repository,
    baseBranch: record.base_branch, releaseVersion: record.release_version }, deps, record);
  assert.equal(result.outcome, "external_or_transient_inconclusive");
  assert.equal(result.loop_run_id, CANONICAL_LOOP);
  assert.deepEqual(result.slots.map((slot) => slot.advance_run_id), ["advance-1", null]);
  assert.equal(observations, 0);
});

test("pre-handoff interruption persists uncertain admission and retries the identical canonical work-list", async () => {
  const { record, engine: prepared, deps, persisted } = await begun();
  record.slots[0].issue_number = 101;
  record.slots[1].issue_number = 102;
  deps.dispatchOrdinaryLoop = async () => { throw new Error("crash before stdout handoff"); };
  await assert.rejects(() => dispatchExactCandidateFrgPair(record, prepared, deps), /crash before stdout/);
  const uncertain = persisted.at(-1)!;
  assert.equal(uncertain.loop_run_id, null);
  assert.equal(uncertain.loop_dispatch_certainty, "uncertain");
  let retryArgv: readonly string[] = [];
  deps.dispatchOrdinaryLoop = async ({ argv }) => { retryArgv = argv; return loopResult(); };
  const recovered = await dispatchExactCandidateFrgPair(uncertain, prepared, deps);
  assert.deepEqual(retryArgv, ["loop", "101", "102", "--profile", "claude", "--engine-track", "candidate", "--domain", "owner/repo"]);
  assert.equal(recovered.loop_run_id, CANONICAL_LOOP);
  assert.equal(recovered.loop_dispatch_certainty, "known_complete");
});

test("pre-handoff restart adopts only the authenticated canonical run and resumes it", async () => {
  const { record, deps } = await begun();
  record.outcome = "external_or_transient_inconclusive";
  record.external_wait = { probe: "loop", wake_condition: "reattach" };
  record.loop_dispatch_certainty = "uncertain";
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; });
  deps.listFixtureMatches = async () => record.slots.map((slot) => ({ issue_number: slot.issue_number!, epoch_id: record.epoch_id,
    candidate_sha: record.candidate.sha, slot_id: slot.id, provenance_id: slot.provenance_id }));
  deps.discoverOrdinaryLoop = async () => ({ runId: CANONICAL_LOOP, children: ["advance-1", null] });
  deps.ordinaryLoopNeedsResume = async () => true;
  let argv: readonly string[] = [];
  deps.dispatchOrdinaryLoop = async (request) => { argv = request.argv; return loopResult(); };
  const result = await runExactCandidateFrg({ repoDir: "/operator", repository: record.repository,
    baseBranch: record.base_branch, releaseVersion: record.release_version, operationalDomain: record.operational_domain }, deps, record);
  assert.deepEqual(argv, ["loop", "--resume", CANONICAL_LOOP, "--profile", "claude", "--engine-track", "candidate", "--domain", record.operational_domain]);
  assert.equal(result.loop_run_id, CANONICAL_LOOP);
  assert.deepEqual(result.slots.map((slot) => slot.advance_run_id), ["advance-1", "advance-2"]);
});

test("production canonical-run discovery distinguishes absence from invalid durable ownership", async () => {
  const { record } = await begun();
  record.loop_engine = "claude";
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; });
  let exists = false;
  let discoveredRunId = "";
  let invalid = false;
  let beforePublicHandoff = false;
  const io = {
    now: () => new Date(),
    loopRunExists: async (runId: string) => { discoveredRunId = runId; return exists; },
    readLoopDocuments: async (runId: string) => {
      const documents = loopResult(runId);
      if (invalid) documents.contract.repo.name = "other/repo";
      documents.ledger.items["102"].advance_run_id = null as never;
      if (beforePublicHandoff) {
        documents.ledger.items["101"].advance_run_id = null as never;
        documents.handoff = null as never;
      }
      return documents;
    },
  } as unknown as ProductionExactCandidateFrgIo;
  const deps = createProductionExactCandidateFrgDeps({ repoDir: "/linked", repository: record.repository,
    baseBranch: record.base_branch, releaseVersion: record.release_version }, io, "/primary");
  assert.equal(await deps.discoverOrdinaryLoop!(record), null);
  assert.equal(discoveredRunId, workListRunId(record.repository, "claude", ["101", "102"]));
  exists = true;
  beforePublicHandoff = true;
  assert.deepEqual((await deps.discoverOrdinaryLoop!(record))?.children, [null, null],
    "pre-public crash adopts only a child-free exact canonical contract");
  beforePublicHandoff = false;
  assert.deepEqual(await deps.discoverOrdinaryLoop!(record), {
    runId: discoveredRunId, children: ["advance-1", null],
  });
  beforePublicHandoff = true;
  const oneChildWithoutHandoff = loopResult(discoveredRunId);
  oneChildWithoutHandoff.ledger.items["102"].advance_run_id = null as never;
  oneChildWithoutHandoff.handoff = null as never;
  io.readLoopDocuments = async () => oneChildWithoutHandoff;
  await assert.rejects(() => deps.discoverOrdinaryLoop!(record), /durable handoff/);
  io.readLoopDocuments = async (runId: string) => {
    const documents = loopResult(runId);
    documents.ledger.items["102"].advance_run_id = null as never;
    if (invalid) documents.contract.repo.name = "other/repo";
    return documents;
  };
  beforePublicHandoff = false;
  invalid = true;
  await assert.rejects(() => deps.discoverOrdinaryLoop!(record), /repository does not match/);
});

test("ordinary revision resumes the same pair and exact loop without creating replacements", async () => {
  const { record, deps } = await begun();
  record.outcome = "ordinary_review_revision";
  record.outcome_detail = "review requested changes";
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
  });
  deps.listFixtureMatches = async () => record.slots.map((slot) => ({
    issue_number: slot.issue_number!, epoch_id: record.epoch_id, candidate_sha: CANDIDATE, slot_id: slot.id, provenance_id: slot.provenance_id,
  }));
  let creates = 0;
  let dispatches = 0;
  deps.createFixture = async () => { creates++; return 999; };
  let resumeArgv: readonly string[] = [];
  deps.dispatchOrdinaryLoop = async (input) => { dispatches++; resumeArgv = input.argv; return loopResult(); };
  const result = await runExactCandidateFrg({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
    implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  }, deps, record);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.slots.map((slot) => slot.issue_number), [101, 102]);
  assert.equal(creates, 0);
  assert.equal(dispatches, 1);
  assert.deepEqual(resumeArgv, ["loop", "--resume", CANONICAL_LOOP, "--profile", "claude", "--engine-track", "candidate", "--domain", "owner/repo"]);
});

test("a stopped external wait resumes the same loop while an observer-only wait does not", async () => {
  for (const stopped of [true, false]) {
    const { record, deps } = await begun();
    record.outcome = "external_or_transient_inconclusive";
    record.outcome_detail = "external wait";
    record.external_wait = { probe: "observer", wake_condition: "available" };
    record.loop_run_id = CANONICAL_LOOP;
    record.slots.forEach((slot, index) => {
      slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; slot.advance_run_id = `advance-${index + 1}`;
    });
    deps.listFixtureMatches = async () => record.slots.map((slot) => ({
      issue_number: slot.issue_number!, epoch_id: record.epoch_id, candidate_sha: CANDIDATE, slot_id: slot.id, provenance_id: slot.provenance_id,
    }));
    deps.ordinaryLoopNeedsResume = async () => stopped;
    let dispatches = 0;
    deps.dispatchOrdinaryLoop = async (input) => { dispatches++; assert.equal(input.argv[2], CANONICAL_LOOP); return loopResult(); };
    await runExactCandidateFrg({
      repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
      implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
    }, deps, record);
    assert.equal(dispatches, stopped ? 1 : 0);
  }
});

test("production reattaches the same loop and leaves lifecycle disposition to its supervisor", async () => {
  const { record } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  let ledger: unknown = exhaustedWorkflowEngineLedger(101, "advance-1", { stage: "implementing" });
  const production = createProductionExactCandidateFrgDeps({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
    implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
  }, { readLoopDocuments: async () => ({ ...loopResult(), ledger }) } as unknown as ProductionExactCandidateFrgIo);
  assert.equal(await production.ordinaryLoopNeedsResume!(record), true, "owned cooling resumes the same loop");
  ledger = {
    ...exhaustedWorkflowEngineLedger(101, "advance-1", { stage: "implementing" }), cooling: null, item_cooling: {},
    lifecycle: { ...exhaustedWorkflowEngineLedger(101, "advance-1").lifecycle, state: "external-condition-wait" },
  };
  assert.equal(await production.ordinaryLoopNeedsResume!(record), true, "an owned external wait resumes the same loop");
  ledger = {
    ...exhaustedWorkflowEngineLedger(101, "advance-1"), cooling: null, item_cooling: {},
    items: { "101": { ...exhaustedWorkflowEngineLedger(101, "advance-1").items["101"], state: "ready" } },
    lifecycle: { ...exhaustedWorkflowEngineLedger(101, "advance-1").lifecycle, state: "succeeded" },
  };
  assert.equal(await production.ordinaryLoopNeedsResume!(record), true, "terminal no-op disposition belongs to the ordinary supervisor");
  ledger = { ...ledger as object, stop: { reason: "run_fatal", time: "2026-09-08T20:03:00.000Z", outstanding_ready: [] } };
  assert.equal(await production.ordinaryLoopNeedsResume!(record), true, "the ordinary supervisor resolves stale compatibility state");
  ledger = {
    ...exhaustedWorkflowEngineLedger(101, "advance-1"),
    lifecycle: { ...exhaustedWorkflowEngineLedger(101, "advance-1").lifecycle, state: "typed-input-wait" },
    stop: { reason: "run_fatal", time: "2026-09-08T20:03:00.000Z", outstanding_ready: [] },
  };
  assert.equal(await production.ordinaryLoopNeedsResume!(record), true, "the ordinary supervisor preserves typed input while considering siblings");
  ledger = {
    ...exhaustedWorkflowEngineLedger(101, "advance-1"), cooling: null, item_cooling: {}, stop: null,
    items: { "101": { ...exhaustedWorkflowEngineLedger(101, "advance-1").items["101"], state: "skipped" } },
    lifecycle: { ...exhaustedWorkflowEngineLedger(101, "advance-1").lifecycle, state: "active" },
  };
  assert.equal(await production.ordinaryLoopNeedsResume!(record), true, "the ordinary supervisor owns skipped terminal disposition");
});

test("candidate regression proof requires the current canonical block transition and ordered lifecycle", () => {
  const valid = exhaustedWorkflowEngineLedger(101, "advance-1", { pr: 301, head: "1".repeat(40) });
  assert.ok(currentWorkflowEngineExhaustion(valid as never, "101"));
  const wrongTransition = structuredClone(valid);
  wrongTransition.items["101"].history.at(-1)!.from = "blocked";
  assert.equal(currentWorkflowEngineExhaustion(wrongTransition as never, "101"), null);
  const invalidLifecycleTime = structuredClone(valid);
  invalidLifecycleTime.lifecycle.updated_at = "not-a-time";
  assert.equal(currentWorkflowEngineExhaustion(invalidLifecycleTime as never, "101"), null);
});

test("production adapter enumerates exact parsed provenance and does not trust labels", async () => {
  const { record } = await begun();
  const exactBody = templateBodyForTest(record, record.slots[0]);
  const io = { now: () => new Date(), readFile: async (file: string) => candidateTemplateForPath(file), writeRecord: async () => {},
    listIssues: async () => [{ number: 101, body: exactBody, state: "open" }, { number: 999, body: "factory-gate pipeline:ready", state: "open" }],
  } as unknown as ProductionExactCandidateFrgIo;
  const deps = createProductionExactCandidateFrgDeps({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
    implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  }, io);
  assert.deepEqual(await deps.listFixtureMatches(record), [{
    issue_number: 101, epoch_id: record.epoch_id, candidate_sha: record.candidate.sha,
    slot_id: "clean-docs", provenance_id: record.slots[0].provenance_id,
  }]);
  assert.equal(parseExactCandidateFrgProvenance("factory-gate pass:true").length, 0);

  io.listIssues = async () => [{ number: 101, body: `${exactBody}\nmalicious extra instruction`, state: "open" }];
  assert.equal((await deps.listFixtureMatches(record))[0]!.slot_id, "foreign", "copied nonce with edited body is not owned");

  io.listIssues = async () => [{ number: 101, body: exactBody, state: "closed" }];
  assert.equal((await deps.listFixtureMatches(record))[0]!.slot_id, "foreign", "closed provenance cannot be adopted or replaced");
});

test("production creation uses ordinary admission only, and path proof is exact-slot-owned", async () => {
  const { record } = await begun();
  let labels: string[] = [];
  let recordRoot = "";
  let loopArgv: readonly string[] = [];
  const io = {
    now: () => new Date(), readFile: async (file: string) => candidateTemplateForPath(file),
    writeRecord: async (repoDir: string) => { recordRoot = repoDir; },
    createIssue: async (_repository: string, _title: string, _body: string, observed: string[]) => { labels = observed; return 101; },
    runCandidateLoop: async (_engine: CandidateEngine, argv: readonly string[]) => { loopArgv = argv; return loopResult().stdout; },
    readLoopDocuments: async () => loopResult(),
  } as unknown as ProductionExactCandidateFrgIo;
  const deps = createProductionExactCandidateFrgDeps({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
    implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  }, io, "/primary-checkout");
  await deps.createFixture({ record, slot: record.slots[0], title: "fixture", body: "body" });
  await deps.persist(record);
  assert.deepEqual(labels, ["pipeline:ready"]);
  assert.equal(recordRoot, "/primary-checkout", "release records use the shared primary-root resolution");
  await deps.dispatchOrdinaryLoop({ engine: engine(), argv: ["loop", "101", "102", "--engine-track", "candidate"], env: {}, onHandoff: async () => {} });
  assert.deepEqual(loopArgv.slice(-2), ["--candidate-target-primary", "/primary-checkout"]);
  const changeId = `${record.epoch_id}-clean-openspec`.replaceAll(".", "-");
  assert.equal(exactCandidateFrgPathsAreHarmless(record, record.slots[1], [
    `core/test/fixtures/frg/${record.epoch_id}/clean-openspec.json`,
    `core/test/frg-${record.epoch_id}-clean-openspec.test.ts`,
    `openspec/changes/archive/2026-09-10-${changeId}/spec.md`,
    `openspec/specs/${changeId}/spec.md`,
  ]), true);
  assert.equal(exactCandidateFrgPathsAreHarmless(record, record.slots[1], [
    `core/test/fixtures/frg/${record.epoch_id}/clean-openspec.json`,
    `core/test/frg-${record.epoch_id}-clean-openspec.test.ts`,
    `openspec/changes/archive/2026-09-10-${changeId}-sibling/spec.md`,
    `openspec/specs/${changeId}/spec.md`,
  ]), false, "archive directory must have the exact run-owned change-id suffix");
  assert.equal(exactCandidateFrgPathsAreHarmless(record, record.slots[0], [
    `core/test/fixtures/frg/${record.epoch_id}/clean-docs.json`,
    `core/test/frg-${record.epoch_id}-clean-docs.test.ts`,
  ]), true, "clean-docs remains harmless when the ordinary run correctly decides no OpenSpec change is needed");
  assert.equal(exactCandidateFrgPathsAreHarmless(record, record.slots[1], ["openspec/specs/foreign/spec.md"]), false);
  const allowed = `core/test/fixtures/frg/${record.epoch_id}/clean-openspec.json`;
  assert.deepEqual(diffFilePaths(`diff --git a/core/scripts/config.ts b/${allowed}`), ["core/scripts/config.ts", allowed]);
  assert.ok(diffFilePaths(`diff --git "a/bad\\303\\251.ts" "b/${allowed}"`).includes("__unparseable_git_diff_header__"));
});

test("duplicate release-owned records for current candidate fail closed", async () => {
  const { record } = await begun();
  const duplicate = structuredClone(record);
  duplicate.epoch_id = `${record.epoch_id}-duplicate`;
  duplicate.slots.forEach((slot) => { slot.epoch_id = duplicate.epoch_id; });
  assert.throws(() => selectExactCandidateFrgExistingRecord([record, duplicate], CANDIDATE), /multiple release-owned records/);
  assert.equal(selectExactCandidateFrgExistingRecord([record], MOVED), null,
    "a prior candidate is finalized separately and cannot delay current admission");
  record.outcome = "stale_candidate";
  assert.equal(selectExactCandidateFrgExistingRecord([record], CANDIDATE), null);
  assert.equal(nextExactCandidateFrgEpochId([record], record.release_version, CANDIDATE),
    `frg-${record.release_version}-${CANDIDATE.slice(0, 12)}-r2`, "C1 returning after C2 gets a fresh preserved generation");
});

test("production record discovery ignores unrelated corruption but fails on relevant corruption", async () => {
  const { record, deps } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.create_certainty = "known_complete"; slot.advance_run_id = `advance-${index + 1}`; });
  const passed = await observeExactCandidateFrgPair(record, deps);
  passed.operational_domain = "agent-pipeline";
  passed.cleanup = passed.slots.map((slot) => ({ target: `issue:${slot.issue_number}`, status: "debt", detail: "deferred", observed_at: passed.updated_at }));
  passed.cleanup_debt = true;
  let relevantCorrupt = false;
  let writes = 0;
  const io = {
    validateTargetRuntime: async () => ({ domain: passed.operational_domain, repository: passed.repository }), resolveReleaseStoreRepoDir: async () => "/primary",
    listRecordEpochIds: async () => ["frg-9.9.9-unrelated", passed.epoch_id],
    readFile: async (file: string) => file.endsWith(`${passed.epoch_id}.json`) ? (relevantCorrupt ? "{" : JSON.stringify(passed)) : "{",
    observeOriginMainSha: async () => CANDIDATE, writeRecord: async () => { writes++; }, now: () => new Date(),
  } as unknown as ProductionExactCandidateFrgIo;
  const input = { repoDir: "/linked", repository: passed.repository, baseBranch: passed.base_branch,
    releaseVersion: passed.release_version, operationalDomain: passed.operational_domain };
  assert.equal((await runProductionExactCandidateFrg(input, io)).outcome, "passed");
  io.observeOriginMainSha = async () => { throw new Error("remote timeout"); };
  await assert.rejects(() => runProductionExactCandidateFrg(input, io), /preserving durable pass/);
  assert.equal(writes, 0, "wrapper outage never overwrites durable pass");
  io.observeOriginMainSha = async () => CANDIDATE;
  relevantCorrupt = true;
  await assert.rejects(() => runProductionExactCandidateFrg(input, io), /JSON/);
});

test("production wrapper rejects movement from the caller-pinned candidate before record or fixture work", async () => {
  let inventoryCalls = 0;
  const io = {
    validateTargetRuntime: async () => ({ domain: "agent-pipeline", repository: "owner/repo" }),
    resolveReleaseStoreRepoDir: async () => "/primary",
    observeOriginMainSha: async () => MOVED,
    listRecordEpochIds: async () => { inventoryCalls++; return []; },
  } as unknown as ProductionExactCandidateFrgIo;
  await assert.rejects(() => runProductionExactCandidateFrg({
    repoDir: "/linked", repository: "owner/repo", baseBranch: "main",
    releaseVersion: "1.40.1", expectedCandidateSha: CANDIDATE,
  }, io), /moved before exact-candidate FRG admission/);
  assert.equal(inventoryCalls, 0);
});

test("default production composition freezes the requested profile for target domain and candidate policy", async () => {
  const calls: Array<{ repoPath?: string; profile?: string }> = [];
  const configFor = (repoPath: string, profile: string): PipelineConfig => ({
    repo_dir: repoPath,
    repo: "owner/repo",
    base_branch: "main",
    domain: repoPath === "/primary" ? "canonical-domain" : path.basename(repoPath),
    harnesses: profile === "claude"
      ? { implementer: "claude", reviewer: "codex" }
      : { implementer: "codex", reviewer: "claude" },
    test_gate: { enabled: true, command: profile === "claude" ? "npm run candidate-ci" : "npm test", timeout: 120 },
    tester_evidence: { max_output_chars: profile === "claude" ? 4096 : 1024 },
    review_policy: { block_threshold: "medium", min_confidence: profile === "claude" ? 0.91 : 0.5 },
  } as unknown as PipelineConfig);
  const input = {
    repoDir: "/linked/operator",
    repository: "owner/repo",
    baseBranch: "main",
    releaseVersion: "1.40.1",
    loopEngine: "claude" as const,
  };
  const io = defaultProductionExactCandidateFrgIo(input, {
    resolvePrimaryRepoDir: async () => "/primary",
    resolveConfigFn: (options) => {
      calls.push({ repoPath: options.repoPath, profile: options.profile });
      return configFor(options.repoPath!, options.profile!);
    },
  });
  const policy = await io.resolveCandidatePolicy("/separate/candidate");
  assert.deepEqual(calls, [
    { repoPath: "/linked/operator", profile: "claude" },
    { repoPath: "/separate/candidate", profile: "claude" },
    { repoPath: "/primary", profile: "claude" },
  ]);
  assert.equal(policy.domain, "canonical-domain");
  assert.equal(policy.implementer, "claude");
  assert.equal(policy.reviewer, "codex");
  assert.notEqual(policy.gatesSha256, buildTesterPolicyHash({
    command_identity: "npm test", enabled: true, timeout: 120, max_output_chars: 1024,
  }));

  const unavailablePrimary = defaultProductionExactCandidateFrgIo(input, {
    resolveConfigFn: (options) => configFor(options.repoPath!, options.profile!),
    listWorktrees: async () => { throw new Error("worktree probe timed out"); },
  });
  await assert.rejects(() => runProductionExactCandidateFrg(input, unavailablePrimary), /worktree probe timed out/,
    "release admission stops before record inventory or fixture creation when the canonical primary is unobservable");
});

test("production rejects invalid target-primary bindings before remote mutation", async () => {
  let inventoryCalls = 0;
  const base = {
    validateTargetRuntime: async () => ({ domain: "agent-pipeline", repository: "other/repository" }),
    resolveReleaseStoreRepoDir: async () => "/primary",
    listRecordEpochIds: async () => { inventoryCalls++; return []; },
  } as unknown as ProductionExactCandidateFrgIo;
  const input = { repoDir: "/linked", repository: "owner/repo", baseBranch: "main", releaseVersion: "1.40.1" };
  await assert.rejects(() => runProductionExactCandidateFrg(input, base), /target primary origin other\/repository/);
  assert.equal(inventoryCalls, 0);

  base.validateTargetRuntime = async () => ({ domain: "agent-pipeline", repository: "owner/repo" });
  base.resolveReleaseStoreRepoDir = async () => "../not-canonical";
  await assert.rejects(() => runProductionExactCandidateFrg(input, base), /normalized absolute path/);
  assert.equal(inventoryCalls, 0);
});

test("production observer waits for zero PRs and rejects incomplete, multiple, or historical linked PRs", async () => {
  const { record } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.slots[0].issue_number = 101;
  record.slots[0].advance_run_id = "advance-1";
  const body = templateBodyForTest(record, record.slots[0]);
  for (const scenario of [
    { open: [] as number[], linked: [] as number[], merged: false, expected: /has not created a PR/ },
    { open: [1, 2], linked: [1, 2], merged: false, expected: /exactly one current open PR/ },
    { open: [2], linked: [2, 1], merged: true, expected: /history contains merged PR/ },
  ]) {
    const io = { now: () => new Date(), readFile: async (file: string) => candidateTemplateForPath(file), writeRecord: async () => {},
      resolveCandidatePolicy: async () => ({ repository: record.repository, baseBranch: record.base_branch, domain: "github.com/owner/repo", implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256, reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) } }),
      readLoopDocuments: async () => ({ ...loopResult(), ledger: { ...loopResult().ledger, stop: null } }),
      getIssue: async () => ({ body, labels: ["pipeline:ready-to-deploy"], state: "open" }),
      listPrsAnyState: async () => ({ numbers: scenario.linked, truncated: false }), listOpenPrs: async () => scenario.open,
      getPr: async (_input: unknown, pr: number) => ({ number: pr, head_sha: "1".repeat(40), base_ref: record.base_branch,
        state: pr === scenario.open[0] ? "open" : "closed", merged: scenario.merged && pr === 1 }),
    } as unknown as ProductionExactCandidateFrgIo;
    const deps = createProductionExactCandidateFrgDeps({
      repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
      implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
    }, io);
    await assert.rejects(() => deps.observeFixture(record, record.slots[0]), scenario.expected);
  }
});

test("pre-PR stops without a current candidate identity remain external", async () => {
  const { record, deps } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.slots.forEach((slot, index) => { slot.issue_number = 101 + index; slot.advance_run_id = `advance-${index + 1}`; });
  const production = createProductionExactCandidateFrgDeps({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
    implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
  }, {
    now: () => new Date(), readFile: async (file: string) => candidateTemplateForPath(file), resolveCandidatePolicy: async () => ({ repository: record.repository, baseBranch: "main", domain: "github.com/owner/repo", implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256, reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) } }),
    getIssue: async (_input, issue) => ({ body: templateBodyForTest(record, record.slots[issue - 101]!), labels: ["pipeline:planning"], state: "open" }),
    readLoopDocuments: async () => ({ ...loopResult(), ledger: { ...loopResult().ledger, stop: { reason: "run_fatal", outstanding_ready: [] } } }),
    listPrsAnyState: async () => ({ numbers: [], truncated: false }), listOpenPrs: async () => [],
  } as unknown as ProductionExactCandidateFrgIo);
  deps.observeFixture = production.observeFixture;
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "external_or_transient_inconclusive");

  let retainedProof: ExactCandidateFrgRecord | null = null;
  const fixtureLocalHead = "6".repeat(40);
  for (const stage of ["planning", "plan-review", "implementing"]) {
    const exhausted = createProductionExactCandidateFrgDeps({
      repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
      implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
    }, {
      now: () => new Date(), readFile: async (file: string) => candidateTemplateForPath(file), resolveCandidatePolicy: async () => ({ repository: record.repository, baseBranch: "main", domain: "github.com/owner/repo", implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256, reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) } }),
      getIssue: async (_input, issue) => ({ body: templateBodyForTest(record, record.slots[issue - 101]!), labels: [`pipeline:${stage}`], state: "open" }),
      readLoopDocuments: async () => {
        const ledger = exhaustedWorkflowEngineLedger(101, "advance-1", { stage, head: fixtureLocalHead });
        assert.ok(currentWorkflowEngineExhaustion(ledger as never, "101"));
        return { ...loopResult(), ledger };
      },
      listPrsAnyState: async () => ({ numbers: [], truncated: false }), listOpenPrs: async () => [],
    } as unknown as ProductionExactCandidateFrgIo);
    deps.observeFixture = exhausted.observeFixture;
    const failed = await observeExactCandidateFrgPair(record, deps);
    assert.equal(failed.outcome, "exact_candidate_regression", stage);
    assert.deepEqual(failed.slots[0].failure_evidence, {
      source: "run_store", classification: "demonstrated_candidate_regression", issue_number: 101,
      advance_run_id: "advance-1", candidate_sha: CANDIDATE, stage, pr_number: null, pr_head_sha: null,
    });
    retainedProof = failed;
  }
  const wrongChild = createProductionExactCandidateFrgDeps({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
  }, {
    now: () => new Date(), readFile: async (file: string) => candidateTemplateForPath(file),
    resolveCandidatePolicy: async () => ({ repository: record.repository, baseBranch: "main", domain: "github.com/owner/repo",
      implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
      reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) } }),
    getIssue: async (_input, issue) => ({ body: templateBodyForTest(record, record.slots[issue - 101]!), labels: ["pipeline:planning"], state: "open" }),
    readLoopDocuments: async () => ({ ...loopResult(), ledger: exhaustedWorkflowEngineLedger(101, "wrong-child", { head: fixtureLocalHead }) }),
    listPrsAnyState: async () => ({ numbers: [], truncated: false }), listOpenPrs: async () => [],
  } as unknown as ProductionExactCandidateFrgIo);
  deps.observeFixture = wrongChild.observeFixture;
  assert.notEqual((await observeExactCandidateFrgPair(record, deps)).outcome, "exact_candidate_regression",
    "a different child run cannot promote the pre-PR exhaustion proof");
  assert.ok(retainedProof);
  const waiting = structuredClone(retainedProof);
  waiting.outcome = "external_or_transient_inconclusive";
  waiting.outcome_detail = "final candidate observer unavailable";
  waiting.external_wait = { probe: "git ls-remote", wake_condition: "origin/main is observable" };
  waiting.cleanup = [];
  waiting.cleanup_debt = false;
  let dispatches = 0;
  deps.dispatchOrdinaryLoop = async () => { dispatches++; return loopResult(); };
  const same = await runExactCandidateFrg({ repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, operationalDomain: record.operational_domain }, deps, waiting);
  assert.equal(same.outcome, "exact_candidate_regression");
  assert.equal(dispatches, 0, "retained current-candidate proof promotes without another loop or observation");
  deps.observeOriginMainSha = async () => MOVED;
  const moved = await runExactCandidateFrg({ repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, operationalDomain: record.operational_domain }, deps, waiting);
  assert.equal(moved.outcome, "stale_candidate");
  assert.ok(moved.slots[0].failure_evidence, "candidate movement does not erase retained failure evidence");
});

test("production observer derives current checks, independent review, Tester, provenance, and harmless paths", async () => {
  const { record } = await begun();
  const slot = record.slots[0];
  const issue = 101;
  const pr = 301;
  const head = "1".repeat(40);
  const runId = "advance-1";
  const traceRunId = "101/2026-09-08T20:00:00Z";
  record.loop_run_id = CANONICAL_LOOP;
  slot.issue_number = issue;
  slot.advance_run_id = runId;
  const changeId = `${record.epoch_id}-${slot.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const changedPaths = [
    `core/test/fixtures/frg/${record.epoch_id}/${slot.id}.json`,
    `core/test/frg-${record.epoch_id}-${slot.id}.test.ts`,
    `openspec/changes/archive/2026-09-10-${changeId}/spec.md`,
    `openspec/specs/${changeId}/spec.md`,
  ];
  const prDiff = changedPaths.map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+fixture`).join("\n");
  const reviewSubject = {
    schema_version: 1, domain: "github.com/owner/repo", issue, pr, run_id: traceRunId,
    candidate_sha: head, diff_hash: hash(prDiff).slice(0, 16), policy_hash: "2".repeat(64),
    engine_fingerprint: "3".repeat(64), verifier_fingerprint: "4".repeat(64),
    required_evidence_set_revision: "5".repeat(64),
  };
  const summarySubject = { ...reviewSubject, diff_hash: null };
  const testerSubject = { ...reviewSubject, run_id: runId, policy_hash: record.worker_config.gates_sha256 };
  const summaryBase = {
    schema_version: 1, schemaVersion: 1, run_id: runId, runId: traceRunId, issue, pr,
    branch: "pipeline/101-frg", harnesses: ["claude", "codex"], stages: [], overrides: [], recoveries: [],
    finalState: "ready-to-deploy", finalizedAt: "2026-09-08T20:09:00.000Z", notifiedAt: null,
    evidence_subject: summarySubject,
    roles: { implementer: "claude", implementerSource: "repo-config", reviewer: "codex", reviewerSource: "repo-config" },
  };
  const body = templateBodyForTest(record, slot);
  const io = {
    now: () => new Date("2026-09-08T20:10:00.000Z"),
    readFile: async (file: string) => candidateTemplateForPath(file),
    writeRecord: async () => {},
    resolveCandidatePolicy: async () => ({ repository: record.repository, baseBranch: record.base_branch, domain: "github.com/owner/repo", implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256, reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) } }),
    getIssue: async () => ({ body, labels: ["pipeline:ready-to-deploy"], state: "open" }),
    listPrsAnyState: async () => ({ numbers: [pr], truncated: false }), listOpenPrs: async () => [pr],
    getPr: async () => ({ number: pr, head_sha: head, base_ref: record.base_branch, state: "open", merged: false }),
    getRequiredChecks: async () => [{ name: "ci", bucket: "pass" }],
    getPrDiff: async () => prDiff,
    readAdvanceSummary: async () => ({ ...summaryBase,
      reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        ensemble: { agents: [], coverage: { independent: 1, required: 1 }, outcome: "accepted" }, evidence_subject: reviewSubject }],
    }),
    readLoopDocuments: async () => ({ ...loopResult(), ledger: { ...loopResult().ledger, stop: null } }),
    readAdvanceTester: async () => ({ status: "ok", evidence: {
      schema_version: 1, kind: "tester_evidence", candidate_sha: head, run_id: runId, issue, pr,
      worktree_id: "fixture-worktree", config_digest: record.worker_config.gates_sha256,
      toolchain_fingerprint: { node: "v24" }, started_at: "2026-09-08T20:00:00.000Z",
      ended_at: "2026-09-08T20:01:00.000Z", duration_ms: 60_000, overall_status: "passed",
      commands: [{ identity: "npm run ci", exit_code: 0, duration_ms: 60_000, status: "passed", output_excerpt: "ok" }],
      output_excerpt: "ok", producer: { component: "test-build-gate" }, evidence_subject: testerSubject,
    } }),
  } as unknown as ProductionExactCandidateFrgIo;
  const deps = createProductionExactCandidateFrgDeps({
    repoDir: "/operator", repository: record.repository, baseBranch: record.base_branch, releaseVersion: record.release_version,
    implementer: record.worker_config.implementer, reviewer: record.worker_config.reviewer, gatesSha256: record.worker_config.gates_sha256,
  }, io);
  const observed = await deps.observeFixture(record, slot);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, observed), "passed");
  assert.equal(observed.ci.check_count, 1);
  assert.equal(observed.review.independent, true);
  assert.equal(observed.review.evidence_subject_valid, true);
  assert.equal(observed.tester.evidence_subject_valid, true);

  const priorAdvanceRunId = "101-prior-evidence-run";
  const priorReviewedHead = "9".repeat(40);
  const priorReviewSubject = { ...reviewSubject, candidate_sha: priorReviewedHead };
  const priorSummarySubject = { ...summarySubject, candidate_sha: priorReviewedHead };
  const originalTesterRead = io.readAdvanceTester;
  const currentTester = await originalTesterRead(undefined as never, runId);
  assert.equal(currentTester.status, "ok");
  const sourceTester = {
    ...currentTester.evidence, run_id: priorAdvanceRunId, pr: null, evidence_subject: undefined,
  };
  const adoptedTester = {
    ...sourceTester, pr, evidence_subject: { ...testerSubject, run_id: priorAdvanceRunId },
  };
  const sourceSummary = {
    ...summaryBase, run_id: priorAdvanceRunId, pr: null,
    evidence_subject: { ...summarySubject, run_id: `${traceRunId}/tester-source`, pr: null }, reviews: [],
  };
  io.readAdvanceSummary = async (_input, requestedRun) => requestedRun === priorAdvanceRunId
    ? sourceSummary : ({ ...summaryBase, reviews: [] });
  io.readCurrentReviewEvidence = async () => ({
    advanceRunId: priorAdvanceRunId,
    reviewedHeadSha: priorReviewedHead,
    reviewedDiffHash: reviewSubject.diff_hash,
    summary: { ...summaryBase, run_id: priorAdvanceRunId, evidence_subject: priorSummarySubject,
      reviews: [{ round: 2, sha: priorReviewedHead, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        ensemble: { agents: [], coverage: { independent: 1, required: 1 }, outcome: "accepted" }, evidence_subject: priorReviewSubject }],
    },
  });
  io.readAdvanceTester = async (_input, requestedRun) => requestedRun === runId
    ? { status: "ok", evidence: adoptedTester }
    : requestedRun === priorAdvanceRunId ? { status: "ok", evidence: sourceTester } : { status: "missing" };
  const successor = await deps.observeFixture(record, slot);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, successor), "gate_defect",
    "a currency-qualified prior-head review cannot prove an exact current-head FRG pass");
  assert.equal(successor.review.advance_run_id, priorAdvanceRunId);
  assert.equal(successor.review.evidence_run_id, traceRunId);
  assert.equal(successor.review.head_sha, head);
  assert.equal(successor.review.reviewed_head_sha, priorReviewedHead);
  assert.equal(successor.tester.advance_run_id, runId, "the copied artifact belongs to the current child run");
  assert.equal(successor.tester.evidence_run_id, priorAdvanceRunId, "embedded Tester authority remains bound to its source run");
  io.readCurrentReviewEvidence = async () => ({
    advanceRunId: runId, reviewedHeadSha: priorReviewedHead, reviewedDiffHash: reviewSubject.diff_hash,
    summary: { ...summaryBase, reviews: [{ round: 2, sha: priorReviewedHead, verdict: "approved", findingCounts: {},
      harness: "codex", selfReview: false, evidence_subject: priorReviewSubject }] },
  });
  const sameRunArchive = await deps.observeFixture(record, slot);
  assert.equal(sameRunArchive.review.reviewed_head_sha, priorReviewedHead);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, sameRunArchive), "gate_defect",
    "even the same physical run cannot use a pre-archive review row as exact-head proof");
  io.readCurrentReviewEvidence = async () => ({
    advanceRunId: priorAdvanceRunId, reviewedHeadSha: priorReviewedHead, reviewedDiffHash: reviewSubject.diff_hash,
    summary: { ...summaryBase, run_id: priorAdvanceRunId, evidence_subject: priorSummarySubject,
      reviews: [{ round: 2, sha: priorReviewedHead, verdict: "needs-attention", findingCounts: {},
        harness: "codex", selfReview: false, evidence_subject: priorReviewSubject }] },
  });
  const successorRevision = await deps.observeFixture(record, slot);
  assert.equal(successorRevision.review.head_sha, head);
  assert.equal(successorRevision.review.reviewed_head_sha, priorReviewedHead);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, successorRevision), "gate_defect",
    "prior-head changes requested cannot classify the exact current head as needing revision");
  io.readCurrentReviewEvidence = async () => ({
    advanceRunId: priorAdvanceRunId, reviewedHeadSha: priorReviewedHead, reviewedDiffHash: reviewSubject.diff_hash,
    summary: { ...summaryBase, run_id: priorAdvanceRunId,
      evidence_subject: { ...priorSummarySubject, domain: "wrong-domain" },
      reviews: [{ round: 2, sha: priorReviewedHead, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: priorReviewSubject }],
    },
  });
  const crossedReviewSource = await deps.observeFixture(record, slot);
  assert.ok(crossedReviewSource.ingress_claims.includes("review-evidence:source-summary-mismatch"));
  assert.equal(classifyExactCandidateFrgObservation(record, slot, crossedReviewSource), "gate_defect");
  io.readCurrentReviewEvidence = async () => ({
    advanceRunId: priorAdvanceRunId, reviewedHeadSha: priorReviewedHead, reviewedDiffHash: reviewSubject.diff_hash,
    summary: { ...summaryBase, run_id: priorAdvanceRunId,
      evidence_subject: { ...priorSummarySubject, engine_fingerprint: "8".repeat(64) },
      reviews: [{ round: 2, sha: priorReviewedHead, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: { ...priorReviewSubject, engine_fingerprint: "8".repeat(64) } }],
    },
  });
  const crossedReviewFamily = await deps.observeFixture(record, slot);
  assert.ok(crossedReviewFamily.ingress_claims.includes("review-evidence:source-summary-mismatch"));
  assert.equal(classifyExactCandidateFrgObservation(record, slot, crossedReviewFamily), "gate_defect");
  io.readAdvanceTester = async (_input, requestedRun) => requestedRun === runId
    ? { status: "ok", evidence: adoptedTester } : { status: "missing" };
  const orphanedAdoption = await deps.observeFixture(record, slot);
  assert.ok(orphanedAdoption.ingress_claims.includes("tester-evidence:source-run-mismatch"));
  assert.equal(classifyExactCandidateFrgObservation(record, slot, orphanedAdoption), "gate_defect");
  io.readAdvanceTester = async (_input, requestedRun) => requestedRun === runId
    ? { status: "ok", evidence: adoptedTester }
    : { status: "malformed", reason: "unreadable: target store temporarily unavailable" };
  await assert.rejects(() => deps.observeFixture(record, slot), /source evidence observer unavailable/);
  let sourceReads = 0;
  io.readAdvanceTester = async (_input, requestedRun) => {
    if (requestedRun !== runId) sourceReads++;
    return requestedRun === runId
      ? { status: "ok", evidence: { ...adoptedTester, run_id: "../outside-run-store" } }
      : { status: "missing" };
  };
  const traversal = await deps.observeFixture(record, slot);
  assert.equal(sourceReads, 0, "an untrusted embedded run id is rejected before any source artifact read");
  assert.equal(traversal.tester.evidence_run_id, "unavailable", "unsafe source identity is normalized before persistence");
  assert.equal(classifyExactCandidateFrgObservation(record, slot, traversal), "gate_defect");
  const traversalRecord = structuredClone(record);
  traversalRecord.slots[1].issue_number = 102;
  traversalRecord.slots[1].advance_run_id = "advance-2";
  let persistedTraversal: ExactCandidateFrgRecord | null = null;
  const traversalPair = await observeExactCandidateFrgPair(traversalRecord, {
    ...deps, observeOriginMainSha: async () => CANDIDATE,
    observeFixture: async (_pair, candidateSlot) => candidateSlot.id === slot.id
      ? traversal : passingObservation(traversalRecord, 1),
    reobserveFixtureIdentity: async (_pair, candidateSlot) => ({
      issue_number: candidateSlot.issue_number!, issue_open: true,
      pr_number: candidateSlot.id === slot.id ? traversal.pr.number : 302,
      pr_head_sha: candidateSlot.id === slot.id ? traversal.pr.head_sha : "2".repeat(40),
      pr_open: true, merged: false,
    }),
    persist: async (saved) => { persistedTraversal = structuredClone(saved); }, cleanup: undefined,
  });
  assert.equal(traversalPair.outcome, "gate_defect");
  assert.equal(traversalPair.slots[0].observation!.tester.evidence_run_id, "unavailable");
  assert.equal(parseExactCandidateFrgRecord(persistedTraversal).outcome, "gate_defect",
    "unsafe embedded source identity persists as a normalized gate defect rather than escaping record validation");
  io.readAdvanceTester = async (_input, requestedRun) => requestedRun === runId
    ? { status: "ok", evidence: { ...adoptedTester, run_id: "" } } : { status: "missing" };
  const emptySourceId = await deps.observeFixture(record, slot);
  assert.equal(emptySourceId.tester.evidence_run_id, "unavailable");
  assert.ok(emptySourceId.ingress_claims.includes("tester-evidence:source-run-mismatch"));
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
      ensemble: { agents: [], coverage: { independent: 1, required: 1 }, outcome: "accepted" }, evidence_subject: reviewSubject }],
  });
  io.readAdvanceTester = originalTesterRead;
  io.readCurrentReviewEvidence = async () => null;

  io.listPrsAnyState = async () => ({ numbers: [pr, 300], truncated: false });
  io.getPr = async (_input, number) => number === pr
    ? ({ number: pr, head_sha: head, base_ref: record.base_branch, state: "open", merged: false })
    : ({ number, head_sha: "0".repeat(40), base_ref: record.base_branch, state: "closed", merged: false });
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "passed",
    "an ordinary closed-unmerged predecessor does not invalidate its sole current successor");
  io.getPr = async (_input, number) => number === pr
    ? ({ number: pr, head_sha: head, base_ref: record.base_branch, state: "open", merged: false })
    : ({ number, head_sha: "0".repeat(40), base_ref: record.base_branch, state: "closed", merged: true });
  await assert.rejects(() => deps.observeFixture(record, slot), /history contains merged PR/);
  const retainedMerged = await observeExactCandidateFrgPair(record, {
    ...deps, observeOriginMainSha: async () => CANDIDATE, persist: async () => {}, cleanup: undefined,
  });
  assert.equal(retainedMerged.outcome, "gate_defect");
  assert.deepEqual(retainedMerged.gate_evidence, [{
    source: "forge", slot_id: slot.id, issue_number: issue, pr_number: 300,
    candidate_sha: CANDIDATE, observed_head_sha: "0".repeat(40),
    fact: "linked PR state=closed; merged=true",
  }]);
  assert.equal(parseExactCandidateFrgRecord(structuredClone(retainedMerged)).outcome, "gate_defect",
    "normalized merged identity survives durable parse/resume");
  io.listPrsAnyState = async () => ({ numbers: [pr], truncated: false });
  io.getPr = async () => ({ number: pr, head_sha: head, base_ref: record.base_branch, state: "open", merged: false });

  const readyLoopDocuments = io.readLoopDocuments;
  io.readLoopDocuments = async () => {
    const documents = await readyLoopDocuments();
    return { ...documents, ledger: { ...documents.ledger, items: {
      ...documents.ledger.items, [String(issue)]: { ...documents.ledger.items[String(issue)], state: "in_progress" },
    } } };
  };
  const beforeLoopTransition = await deps.observeFixture(record, slot);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, beforeLoopTransition), "external_or_transient_inconclusive",
    "child evidence cannot pass before the ordinary supervisor durably transitions its item ready");
  io.readLoopDocuments = async () => {
    const documents = await readyLoopDocuments();
    return { ...documents, ledger: { ...documents.ledger, items: {
      ...documents.ledger.items, [String(issue)]: { ...documents.ledger.items[String(issue)], advance_run_id: "other-child" },
    } } };
  };
  await assert.rejects(() => deps.observeFixture(record, slot), /crosses the recorded child run/);
  io.readLoopDocuments = readyLoopDocuments;

  const readPassingSummary = io.readAdvanceSummary;
  io.readAdvanceSummary = async () => ({ ...summaryBase, schema_version: 7,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject }],
  });
  const malformed = await deps.observeFixture(record, slot);
  assert.deepEqual(malformed.ingress_claims, ["ordinary-summary:malformed"]);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, malformed), "gate_defect");
  for (const mismatch of [
    { run_id: "other-physical-run" }, { issue: 999 }, { pr: 999 },
  ]) {
    io.readAdvanceSummary = async () => ({ ...summaryBase, ...mismatch,
      reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: reviewSubject }],
    });
    const crossed = await deps.observeFixture(record, slot);
    assert.ok(crossed.ingress_claims.includes("ordinary-summary:run-identity-mismatch"));
    assert.equal(classifyExactCandidateFrgObservation(record, slot, crossed), "gate_defect");
  }
  io.readAdvanceSummary = async () => { throw new Error("run-store read timeout"); };
  await assert.rejects(() => deps.observeFixture(record, slot), /run-store read timeout/,
    "an unreadable observer remains a retryable outer wait rather than malformed evidence");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
      evidence_subject: { ...reviewSubject, policy_hash: "7".repeat(64) } }],
  });
  assert.equal((await deps.observeFixture(record, slot)).review.evidence_subject_valid, false,
    "round-2 low-risk policy cannot be inferred without current Review-1 proof");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [
      { round: 1, sha: head, verdict: "approved", findingCounts: { medium: 1 }, harness: "codex", selfReview: false, evidence_subject: reviewSubject },
      { round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: { ...reviewSubject, policy_hash: "7".repeat(64) } },
    ],
  });
  assert.equal((await deps.observeFixture(record, slot)).review.evidence_subject_valid, false,
    "a current Review-1 with findings cannot authorize the low-risk policy hash");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [
      { round: 1, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: { ...reviewSubject, candidate_sha: MOVED } },
      { round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: { ...reviewSubject, policy_hash: "7".repeat(64) } },
    ],
  });
  assert.equal((await deps.observeFixture(record, slot)).review.evidence_subject_valid, false,
    "a Review-1 subject for another candidate cannot authorize the low-risk policy hash");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [
      { round: 1, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject },
      { round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
        evidence_subject: { ...reviewSubject, policy_hash: "7".repeat(64) } },
    ],
  });
  assert.equal((await deps.observeFixture(record, slot)).review.evidence_subject_valid, true,
    "current zero-finding approved Review-1 proves the low-risk round-2 producer policy");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
      evidence_subject: { ...reviewSubject, policy_hash: "8".repeat(64), diff_hash: "6".repeat(16) } }],
  });
  assert.equal((await deps.observeFixture(record, slot)).review.evidence_subject_valid, false,
    "a non-current diff and unknown review policy hash cannot qualify");
  io.readAdvanceSummary = readPassingSummary;

  const readPassingTester = io.readAdvanceTester;
  io.readAdvanceTester = async (...args) => {
    const read = await readPassingTester(...args);
    assert.equal(read.status, "ok");
    return { status: "ok", evidence: { ...read.evidence, commands: read.evidence.commands.map((command) => ({ ...command, exit_code: 1 })) } };
  };
  const inconsistentTester = await deps.observeFixture(record, slot);
  assert.equal(inconsistentTester.tester.conclusion, "unavailable", "internally inconsistent Tester evidence fails closed");
  assert.notEqual(classifyExactCandidateFrgObservation(record, slot, inconsistentTester), "passed");
  io.readAdvanceTester = async () => ({ status: "malformed", reason: "overall_status contradicts commands" });
  const malformedTester = await deps.observeFixture(record, slot);
  assert.deepEqual(malformedTester.ingress_claims, ["tester-evidence:malformed"]);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, malformedTester), "gate_defect");
  io.readAdvanceTester = async (...args) => {
    const read = await readPassingTester(...args);
    assert.equal(read.status, "ok");
    return { status: "ok", evidence: { ...read.evidence, evidence_subject: { schema_version: 99 } as never } };
  };
  const malformedTesterSubject = await deps.observeFixture(record, slot);
  assert.equal(malformedTesterSubject.tester.evidence_subject_valid, false);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, malformedTesterSubject), "gate_defect");
  io.readAdvanceTester = readPassingTester;

  io.getIssue = async () => ({ body, labels: [], state: "open" });
  await assert.rejects(() => deps.reobserveFixtureIdentity(record, slot), /no longer open and ready-to-deploy/);
  io.getIssue = async () => ({ body: body.replace(slot.provenance_id, "forged-provenance"), labels: ["pipeline:ready-to-deploy"], state: "open" });
  await assert.rejects(() => deps.reobserveFixtureIdentity(record, slot), /provenance moved/);
  io.getIssue = async () => ({ body, labels: ["pipeline:ready-to-deploy"], state: "open" });
  io.listPrsAnyState = async () => ({ numbers: [pr, 999], truncated: false });
  await assert.rejects(() => deps.reobserveFixtureIdentity(record, slot), /linked PR inventory moved/);
  io.listPrsAnyState = async () => ({ numbers: [pr], truncated: false });

  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [
      { round: 1, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject },
      { round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject },
      { round: 2, sha: head, verdict: "needs-attention", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject },
    ],
  });
  const revision = await deps.observeFixture(record, slot);
  assert.equal(revision.review.verdict, "changes_requested", "the latest current-head review controls the verdict");
  assert.equal(classifyExactCandidateFrgObservation(record, slot, revision), "ordinary_review_revision");

  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ sha: head, verdict: "approved", evidence_subject: reviewSubject }],
  }) as never;
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "gate_defect");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false,
      model: {} as never, evidence_subject: reviewSubject }],
  });
  const malformedModel = await deps.observeFixture(record, slot);
  assert.ok(malformedModel.ingress_claims.includes("ordinary-summary:malformed"));
  assert.equal(classifyExactCandidateFrgObservation(record, slot, malformedModel), "gate_defect");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{
      round: 2, sha: head, verdict: "approved", findingCounts: {}, evidence_subject: reviewSubject,
      ensemble: { agents: [{ status: "usable" }] },
    }],
  }) as never;
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "gate_defect");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: " ", selfReview: false, evidence_subject: reviewSubject }],
  });
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "gate_defect");
  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, evidence_subject: reviewSubject,
      ensemble: { agents: [{ harness: "codex", effectiveHarness: " ", selfReview: false, status: "usable" }] } }],
  }) as never;
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "gate_defect");

  io.readAdvanceSummary = async () => ({ ...summaryBase,
    roles: { implementer: "grok", implementerSource: "repo-config", reviewer: "codex", reviewerSource: "repo-config" },
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject }],
  });
  const roleMismatch = await deps.observeFixture(record, slot);
  assert.ok(roleMismatch.ingress_claims.includes("ordinary-summary:worker-role-mismatch"));
  assert.equal(classifyExactCandidateFrgObservation(record, slot, roleMismatch), "gate_defect");

  io.readAdvanceSummary = async () => ({ ...summaryBase,
    reviews: [{ round: 2, sha: MOVED, verdict: "needs-attention", findingCounts: {}, harness: "codex", selfReview: false,
      evidence_subject: { ...reviewSubject, candidate_sha: MOVED, run_id: "stale/trace-run" } }],
  });
  const staleReview = await deps.observeFixture(record, slot);
  assert.equal(staleReview.review.head_sha, MOVED);
  assert.equal(staleReview.review.evidence_run_id, "stale/trace-run");
  assert.equal(classifyExactCandidateFrgObservation(record, slot, staleReview), "external_or_transient_inconclusive");

  io.readAdvanceSummary = async () => ({ ...summaryBase, finalState: "blocked",
    reviews: [{ round: 2, sha: head, verdict: "approved", findingCounts: {}, harness: "codex", selfReview: false, evidence_subject: reviewSubject }],
  });
  io.getRequiredChecks = async () => [{ name: "ci", bucket: "fail" }];
  io.readLoopDocuments = async () => ({
    ...loopResult(), ledger: exhaustedWorkflowEngineLedger(issue, runId, { pr, head, stage: "pre-merge" }),
  });
  io.readAdvanceTester = async () => ({ status: "missing" });
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "exact_candidate_regression",
    "current post-PR supervisor exhaustion proves candidate regression with green CI and missing Tester");
  io.readAdvanceTester = async () => ({ status: "ok", evidence: {
    schema_version: 1, kind: "tester_evidence", candidate_sha: head, run_id: runId, issue, pr,
    worktree_id: "fixture-worktree", config_digest: record.worker_config.gates_sha256,
    toolchain_fingerprint: { node: "v24" }, started_at: "2026-09-08T20:00:00.000Z",
    ended_at: "2026-09-08T20:01:00.000Z", duration_ms: 60_000, overall_status: "failed",
    commands: [{ identity: "npm run ci", exit_code: 1, duration_ms: 60_000, status: "failed", output_excerpt: "candidate engine failure" }],
    output_excerpt: "candidate engine failure", producer: { component: "test-build-gate" }, evidence_subject: testerSubject,
  } });
  const regression = await deps.observeFixture(record, slot);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, regression), "exact_candidate_regression",
    "a head-bound failed ordinary recovery episode demonstrates candidate regression");
  io.readLoopDocuments = async () => ({ ...loopResult(), ledger: {
    ...exhaustedWorkflowEngineLedger(issue, runId, { pr, head, stage: "pre-merge" }),
    cooling: null, item_cooling: {}, lifecycle: { ...exhaustedWorkflowEngineLedger(issue, runId, { pr, head }).lifecycle, state: "active" },
    recovery_attempts: [{
      item_id: String(issue), seq: 0, time: "2026-09-08T20:01:00.000Z", class: "workflow-engine-defect",
      action: "repair_pipeline_item", actions: ["repair_pipeline_item"], outcome: "failed",
    }],
  } });
  const supersededRegression = await deps.observeFixture(record, slot);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, supersededRegression), "ordinary_review_revision");

  io.getRequiredChecks = async () => [{ name: "ci", bucket: "pass" }];
  io.readLoopDocuments = async () => ({
    ...loopResult(), ledger: exhaustedWorkflowEngineLedger(issue, runId, { pr, head, stage: "pre-merge" }),
  });
  io.readAdvanceTester = async () => ({ status: "ok", evidence: {
    schema_version: 1, kind: "tester_evidence", candidate_sha: MOVED, run_id: runId, issue, pr,
    worktree_id: "stale-fixture-worktree", config_digest: record.worker_config.gates_sha256,
    toolchain_fingerprint: { node: "v24" }, started_at: "2026-09-08T19:00:00.000Z",
    ended_at: "2026-09-08T19:01:00.000Z", duration_ms: 60_000, overall_status: "failed",
    commands: [{ identity: "npm run ci", exit_code: 1, duration_ms: 60_000, status: "failed", output_excerpt: "stale failure" }],
    output_excerpt: "stale failure", producer: { component: "test-build-gate" },
    evidence_subject: { ...testerSubject, candidate_sha: MOVED },
  } });
  const staleFailureWithProof = await deps.observeFixture(record, slot);
  assert.equal(staleFailureWithProof.tester.head_sha, MOVED);
  assert.equal(classifyExactCandidateFrgObservation(record, slot, staleFailureWithProof), "exact_candidate_regression",
    "the bound exhaustion proof controls independently of stale failed Tester evidence");
  io.readLoopDocuments = async () => ({ ...loopResult(), ledger: {
    ...exhaustedWorkflowEngineLedger(issue, runId, { pr, head }), cooling: null, item_cooling: {},
    lifecycle: { ...exhaustedWorkflowEngineLedger(issue, runId, { pr, head }).lifecycle, state: "active" },
  } });
  assert.equal(classifyExactCandidateFrgObservation(record, slot, await deps.observeFixture(record, slot)), "gate_defect",
    "stale failed Tester evidence cannot request ordinary revision without regression proof");

  const unsafe = structuredClone(observed);
  unsafe.changed_paths = ["core/scripts/config.ts"];
  assert.equal(classifyExactCandidateFrgObservation(record, slot, unsafe), "gate_defect");
});

test("nonzero gh checks JSON remains authoritative red or pending evidence", () => {
  assert.deepEqual(recoverExactCandidateFrgChecks(Object.assign(new Error("exit 1"), {
    stdout: JSON.stringify([{ name: "ci", bucket: "fail" }]),
  })), [{ name: "ci", bucket: "fail" }]);
  assert.deepEqual(recoverExactCandidateFrgChecks(Object.assign(new Error("exit 8"), {
    stdout: JSON.stringify([{ name: "ci", bucket: "pending" }]),
  })), [{ name: "ci", bucket: "pending" }]);
  assert.equal(recoverExactCandidateFrgChecks(new Error("network outage")), null);
});

test("ordinary loop terminal exits 1 and 2 preserve canonical stdout while launch errors do not", () => {
  const stdout = loopResult().stdout;
  assert.equal(recoverExpectedExactCandidateLoopExit({ exitCode: 1, stdout }), stdout);
  assert.equal(recoverExpectedExactCandidateLoopExit({ exitCode: 2, stdout }), stdout);
  assert.equal(recoverExpectedExactCandidateLoopExit({ exitCode: 1, stdout: "not a handoff" }), null);
  assert.equal(recoverExpectedExactCandidateLoopExit({ exitCode: 127, stdout }), null);
});

test("same-host release/FRG exclusion releases on failure and refuses contention", async () => {
  const events: string[] = [];
  await assert.rejects(() => withReleaseFrgExclusion("owner-repo", async () => { events.push("run"); throw new Error("boom"); }, () => ({
    acquire: () => { events.push("acquire"); return true; }, release: () => { events.push("release"); },
  })), /boom/);
  assert.deepEqual(events, ["acquire", "run", "release"]);
  await assert.rejects(() => withReleaseFrgExclusion("owner-repo", async () => undefined, () => ({ acquire: () => false, release: () => {} })), /already held/);
});

test("tagged retry discovers exactly one forge pair and never treats local pass as proof", async () => {
  const { record } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.outcome = "passed";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
    slot.pr_number = 301 + index;
    slot.pr_head_sha = String(index + 1).repeat(40);
    slot.observation = passingObservation(record, index);
  });
  const issues = record.slots.map((slot, index) => ({
    number: 101 + index,
    body: templateBodyForTest(record, slot),
    state: "open" as const,
  }));
  const discovered = discoverExactCandidateFrgPairIssues(issues, CANDIDATE, record.release_version);
  assert.equal(discovered.epoch_id, record.epoch_id);
  assert.equal(discovered.slots["clean-docs"].issue_number, 101);
  assert.equal(discovered.slots["clean-openspec"].issue_number, 102);
  assert.throws(() => discoverExactCandidateFrgPairIssues([], CANDIDATE, record.release_version), /exactly one exact-pair epoch/);
  assert.throws(() => discoverExactCandidateFrgPairIssues([issues[0]!], CANDIDATE, record.release_version), /exactly one clean-openspec/);

  let created = 0;
  let writes = 0;
  const input = {
    repoDir: "/linked", repository: record.repository, baseBranch: record.base_branch,
    releaseVersion: record.release_version, operationalDomain: "agent-pipeline",
  };
  const missingLoopIo = {
    now: () => new Date(),
    validateTargetRuntime: async () => ({ domain: "agent-pipeline", repository: record.repository }),
    resolveReleaseStoreRepoDir: async () => "/primary",
    listRecordEpochIds: async () => [],
    listIssues: async () => issues,
    createIssue: async () => { created++; return 999; },
    writeRecord: async () => { writes++; },
    readFile: async (file: string) => files().get(path.resolve(file)) ?? candidateTemplateForPath(file),
    resolveAndPrepareCandidate: async (_input: unknown, candidateSha: string) => {
      assert.equal(candidateSha, CANDIDATE);
      return { ok: true, engine: engine() };
    },
    resolveCandidatePolicy: async () => ({
      repository: record.repository, baseBranch: record.base_branch, domain: "github.com/owner/repo",
      implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
      reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) },
    }),
    loopRunExists: async () => false,
    readLoopDocuments: async () => { throw new Error("loop store must not be required after absence"); },
  } as unknown as ProductionExactCandidateFrgIo;
  await assert.rejects(
    () => observeProductionExactCandidateFrgPass(input, CANDIDATE, missingLoopIo),
    /authoritative observations; refusing to create a replacement pair/,
  );
  assert.equal(created, 0);
  assert.equal(writes, 0);

  const reconstructed = await observeProductionExactCandidateFrgPass(
    input, CANDIDATE, taggedRetryFreshCheckoutIo(record, issues, { created: () => created++, writes: () => writes++ }),
  );
  assert.equal(reconstructed.epoch_id, record.epoch_id);
  assert.equal(reconstructed.loop_run_id, CANONICAL_LOOP);
  assert.equal(created, 0);
  assert.equal(writes, 0);

  let observedIssues = 0;
  const staleLocalIo = {
    now: () => new Date(),
    validateTargetRuntime: async () => ({ domain: "agent-pipeline", repository: record.repository }),
    resolveReleaseStoreRepoDir: async () => "/primary",
    listRecordEpochIds: async () => [record.epoch_id],
    listIssues: async () => issues,
    createIssue: async () => { created++; return 999; },
    readFile: async (file: string) => file.endsWith(`${record.epoch_id}.json`) ? JSON.stringify(record) : candidateTemplateForPath(file),
    resolveCandidatePolicy: async () => ({
      repository: record.repository, baseBranch: record.base_branch, domain: "github.com/owner/repo",
      implementer: "claude", reviewer: "codex", gatesSha256: record.worker_config.gates_sha256,
      reviewPolicyHashes: { standard: "2".repeat(64), lowRiskRound2: "7".repeat(64) },
    }),
    getIssue: async () => { observedIssues++; throw new Error("forge unavailable"); },
    writeRecord: async () => undefined,
  } as unknown as ProductionExactCandidateFrgIo;
  await assert.rejects(
    () => observeProductionExactCandidateFrgPass(input, CANDIDATE, staleLocalIo),
    /forge unavailable/,
  );
  assert.ok(observedIssues > 0, "local passed JSON must be re-observed from forge");
  assert.equal(created, 0);
});

test("tagged reconstruction ignores historical latest.json and still proceeds without an old scorer", async () => {
  const { record } = await begun();
  record.loop_run_id = CANONICAL_LOOP;
  record.loop_dispatch_certainty = "known_complete";
  record.outcome = "passed";
  record.slots.forEach((slot, index) => {
    slot.issue_number = 101 + index;
    slot.create_certainty = "known_complete";
    slot.advance_run_id = `advance-${index + 1}`;
    slot.pr_number = 301 + index;
    slot.pr_head_sha = String(index + 1).repeat(40);
    slot.observation = passingObservation(record, index);
  });
  const issues = record.slots.map((slot, index) => ({
    number: 101 + index,
    body: templateBodyForTest(record, slot),
    state: "open" as const,
  }));
  const reads: string[] = [];
  const base = taggedRetryFreshCheckoutIo(record, issues, { created: () => undefined, writes: () => undefined });
  const io: ProductionExactCandidateFrgIo = {
    ...base,
    readFile: async (file) => {
      reads.push(file);
      assert.equal(isHistoricalFailedShipEvidencePath(file), false, `must not consult ${file}`);
      return base.readFile(file);
    },
  };
  const reconstructed = await observeProductionExactCandidateFrgPass(
    {
      repoDir: "/linked", repository: record.repository, baseBranch: record.base_branch,
      releaseVersion: record.release_version, operationalDomain: "agent-pipeline",
    },
    CANDIDATE,
    io,
  );
  assert.equal(reconstructed.outcome, "passed");
  assert.equal(reconstructed.candidate.sha, CANDIDATE);
  assert.equal(reads.some((file) => isHistoricalFailedShipEvidencePath(file)), false);
});
