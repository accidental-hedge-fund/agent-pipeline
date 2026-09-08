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
  parseExactCandidateFrgRecord,
  persistExactCandidateFrgRecord,
  reconcileExactCandidateFrgPair,
  runExactCandidateFrg,
  verifyExactCandidateFrgResult,
  type ExactCandidateFrgDeps,
  type ExactCandidateFrgObservation,
  type ExactCandidateFrgRecord,
  type RemoteFixtureMatch,
} from "../scripts/exact-candidate-frg.ts";
import type { CandidateEngine } from "../scripts/ship-end-candidate.ts";
import { PIPELINE_SUPPRESS_AUTO_FILE_ENV } from "../scripts/stages/papercut.ts";

const CANDIDATE = "a".repeat(40);
const MOVED = "b".repeat(40);
const ROOT = "/candidate";
const DOCS = "docs {{release_version}} {{pack_run_id}} {{pack_id}} {{manifest_version}} {{manifest_sha256}} {{template_id}} {{template_sha256}}";
const OPENSPEC = "openspec {{release_version}} {{pack_run_id}} {{pack_id}} {{manifest_version}} {{manifest_sha256}} {{template_id}} {{template_sha256}}";
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
    templates: [
      { id: "clean-docs", file: "templates/clean-docs.md", sha256: hash(DOCS) },
      { id: "clean-openspec", file: "templates/clean-openspec.md", sha256: hash(OPENSPEC) },
    ],
  });
  return new Map([
    [`${ROOT}/core/scripts/frg-packs/factory-gate-v1/manifest.json`, manifest],
    [`${ROOT}/core/scripts/frg-packs/factory-gate-v1/templates/clean-docs.md`, DOCS],
    [`${ROOT}/core/scripts/frg-packs/factory-gate-v1/templates/clean-openspec.md`, OPENSPEC],
    [`${ROOT}/core/package-lock.json`, "lock"],
  ]);
}

function passingObservation(record: ExactCandidateFrgRecord, index = 0): ExactCandidateFrgObservation {
  const slot = record.slots[index]!;
  const head = String(index + 1).repeat(40);
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
    ci: { source: "ci", head_sha: head, required: true, conclusion: "success" },
    review: { source: "review", head_sha: head, independent: true, verdict: "accepted" },
    tester: {
      source: "tester", head_sha: head,
      worker_config_sha256: record.worker_config.gates_sha256,
      conclusion: "passed",
    },
    unavailable_sources: [],
  };
}

function baseDeps(over: Partial<ExactCandidateFrgDeps> = {}) {
  let tick = 0;
  const persisted: ExactCandidateFrgRecord[] = [];
  const source = files();
  const deps: ExactCandidateFrgDeps = {
    now: () => new Date(`2026-09-08T20:00:0${tick++}.000Z`),
    observeOriginMainSha: async () => CANDIDATE,
    resolveAndPrepareDeps: {} as never,
    resolveAndPrepareCandidate: async (_input, candidateSha) => {
      assert.equal(candidateSha, CANDIDATE);
      return { ok: true, engine: engine() };
    },
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
    listFixtureMatches: async () => [],
    createFixture: async ({ slot }) => slot.id === "clean-docs" ? 101 : 102,
    dispatchOrdinaryLoop: async () => ({ run_id: "ordinary-loop-1" }),
    observeFixture: async (record, slot) => passingObservation(record, slot.id === "clean-docs" ? 0 : 1),
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
  assert.throws(() => parseExactCandidateFrgRecord({ ...record, candidate: { ...record.candidate, lockfile: { ...record.candidate.lockfile, relative_path: "../operator-lock" } } }), /candidate root/);
  const crossed = structuredClone(record);
  crossed.slots[1].epoch_id = "other-epoch";
  assert.throws(() => parseExactCandidateFrgRecord(crossed), /crosses candidate epoch/);
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
  const { record, deps } = await begun();
  let creates = 0;
  deps.createFixture = async () => { creates++; throw new Error("timeout"); };
  const first = await reconcileExactCandidateFrgPair(record, deps);
  assert.equal(first.outcome, "external_or_transient_inconclusive");
  assert.equal(first.slots[0].create_certainty, "uncertain");
  assert.equal(creates, 1);
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
    assert.equal(creates, 0);
  }
});

test("dispatch uses unchanged ordinary loop with exactly two explicit issues and no merge or label selector", async () => {
  const { record, engine: prepared, deps } = await begun();
  record.slots[0].issue_number = 101;
  record.slots[1].issue_number = 102;
  let argv: readonly string[] = [];
  let env: NodeJS.ProcessEnv = {};
  deps.dispatchOrdinaryLoop = async (input) => { argv = input.argv; env = input.env; return { run_id: "ordinary-loop-7" }; };
  const dispatched = await dispatchExactCandidateFrgPair(record, prepared, deps);
  assert.deepEqual(argv, ["loop", "101", "102", "--engine-track", "candidate"]);
  assert.doesNotMatch(argv.join(" "), /--label|merge|factory-release|repair/);
  assert.equal(env[PIPELINE_SUPPRESS_AUTO_FILE_ENV], "1");
  assert.deepEqual(dispatched.slots.map((slot) => slot.ordinary_run_id), ["ordinary-loop-7", "ordinary-loop-7"]);
  assert.throws(() => exactCandidateFrgLoopArgv({ ...record, slots: [record.slots[0], { ...record.slots[1], issue_number: 101 }] }), /distinct/);
});

test("authoritative current green unmerged heads pass; claims and labels alone do not", async () => {
  const { record, deps } = await begun();
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    slot.ordinary_run_id = "ordinary-loop-1";
  }
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "passed");
  assert.equal(verifyExactCandidateFrgResult(result, { epoch_id: record.epoch_id, candidate_sha: CANDIDATE }), result);
  const forged = structuredClone(result);
  forged.outcome = "passed";
  forged.slots[0].observation!.ci.conclusion = "pending";
  forged.slots[0].observation!.ingress_claims = ["worker pass:true", "public hash"];
  assert.throws(() => verifyExactCandidateFrgResult(forged, { epoch_id: record.epoch_id, candidate_sha: CANDIDATE }), /lacks authoritative/);
});

test("wrong-head, stale, merged, non-independent, and worker-config evidence cannot pass", async () => {
  const { record } = await begun();
  const variants: ExactCandidateFrgObservation[] = [];
  const wrongHead = passingObservation(record); wrongHead.ci.head_sha = MOVED; variants.push(wrongHead);
  const merged = passingObservation(record); merged.pr.merged = true; variants.push(merged);
  const review = passingObservation(record); review.review.independent = false; variants.push(review);
  const tester = passingObservation(record); tester.tester.worker_config_sha256 = "d".repeat(64); variants.push(tester);
  const stale = passingObservation(record); stale.issue.provenance_candidate_sha = MOVED; variants.push(stale);
  for (const observation of variants) {
    assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], observation), "gate_defect");
  }
});

test("four non-pass classes map deterministically", async () => {
  const { record } = await begun();
  const review = passingObservation(record); review.review.verdict = "changes_requested";
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], review), "ordinary_review_revision");
  const outage = passingObservation(record); outage.unavailable_sources = ["ci"];
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], outage), "external_or_transient_inconclusive");
  const regression = passingObservation(record); regression.tester.conclusion = "failed";
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], regression), "exact_candidate_regression");
  const defect = passingObservation(record); defect.pr.merged = true;
  assert.equal(classifyExactCandidateFrgObservation(record, record.slots[0], defect), "gate_defect");
});

test("candidate movement marks old evidence stale without rebinding it", async () => {
  const { record, deps } = await begun({ observeOriginMainSha: async () => CANDIDATE });
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    slot.ordinary_run_id = "ordinary-loop-1";
  }
  deps.observeOriginMainSha = async () => MOVED;
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.equal(result.outcome, "stale_candidate");
  assert.equal(result.candidate.sha, CANDIDATE);
  assert.ok(result.slots.every((slot) => slot.candidate_sha === CANDIDATE));
});

test("result is persisted before cleanup and cleanup debt cannot invalidate pass", async () => {
  const order: string[] = [];
  const { record, deps } = await begun({
    persist: async (saved) => { if (saved.outcome === "passed") order.push(saved.cleanup.length ? "persist-cleanup" : "persist-result"); },
    cleanup: async () => {
      order.push("cleanup");
      return [{ target: "branch/frg", status: "debt", detail: "identity moved; no mutation", observed_at: "2026-09-08T20:02:00.000Z" }];
    },
  });
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    slot.ordinary_run_id = "ordinary-loop-1";
  }
  const result = await observeExactCandidateFrgPair(record, deps);
  assert.deepEqual(order, ["persist-result", "cleanup", "persist-cleanup"]);
  assert.equal(result.outcome, "passed");
  assert.equal(result.cleanup_debt, true);
  assert.match(result.cleanup[0]!.detail, /no mutation/);
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
  assert.deepEqual(result.slots.map((slot) => slot.ordinary_run_id), ["ordinary-loop-1", "ordinary-loop-1"]);
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

test("atomic result store writes outside fixture control and renames last", async () => {
  const { record } = await begun();
  const actions: string[] = [];
  await persistExactCandidateFrgRecord("/release-owner", record, {
    mkdir: async (directory) => { actions.push(`mkdir:${directory}`); },
    writeFile: async (file, body) => {
      actions.push(`write:${file}`);
      assert.equal(JSON.parse(body).candidate.sha, CANDIDATE);
    },
    rename: async (from, to) => { actions.push(`rename:${from}->${to}`); },
  });
  const destination = exactCandidateFrgResultPath("/release-owner", record.epoch_id);
  assert.equal(actions[0], `mkdir:${path.dirname(destination)}`);
  assert.match(actions[1]!, /\.tmp-/);
  assert.equal(actions[2], `rename:${destination}.tmp-${process.pid}->${destination}`);
  assert.doesNotMatch(destination, /candidate|fixture/);
});

test("release-path verifier is the exact-pair contract, not legacy scoring", async () => {
  const { verifyReleasePathExactCandidateFrg } = await import("../scripts/factory-reliability-gate.ts");
  const { record, deps } = await begun();
  for (const [index, slot] of record.slots.entries()) {
    slot.issue_number = 101 + index;
    slot.ordinary_run_id = "ordinary-loop-1";
  }
  const passed = await observeExactCandidateFrgPair(record, deps);
  assert.equal(verifyReleasePathExactCandidateFrg(passed, {
    epoch_id: record.epoch_id,
    candidate_sha: CANDIDATE,
  }), passed);
  assert.throws(() => verifyReleasePathExactCandidateFrg({ pass: true, score: 100 }, {
    epoch_id: record.epoch_id,
    candidate_sha: CANDIDATE,
  }), /schema/);
});
