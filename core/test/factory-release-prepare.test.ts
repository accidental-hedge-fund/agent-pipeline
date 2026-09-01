// Unit tests for durable post-pilot factory-release prepare (#953 / #908).
// All I/O is injected — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactSubdir, FACTORY_RELEASE_ARTIFACT } from "../scripts/artifact-ignore.ts";
import {
  buildFactoryReleaseUnsignedDigestBinding,
  compareSemver,
  CANDIDATE_LOOP_DENIED_FRG_ENV,
  defaultFactoryReleasePrepareDeps,
  defaultObserveAttestation,
  defaultResolveShipPathFromRun,
  defaultResumeBoundPackLoop,
  defaultSpawnCandidateLoop,
  defaultStartBoundPackLoop,
  FACTORY_RELEASE_PREPARE_HELP,
  FACTORY_RELEASE_ROOT_REL,
  factoryReleaseCheckpointPath,
  factoryReleaseLoopBindingPath,
  factoryReleaseRequestFingerprint,
  factoryReleaseVersionIndexPath,
  sanitizeCandidateLoopEnv,
  factoryReleasePackInstancePath,
  factoryReleaseWorkDir,
  generateDurableUnsignedFrg,
  honestLatestJsonBindsRequest,
  isBoundPackLoopTerminal,
  isPathInsideCheckout,
  REQUEST_INSIDE_CHECKOUT_TOKEN,
  resolveRequestPathForContainment,
  runFactoryReleasePrepare,
  selectExistingReleaseFromContainingPrs,
  selectExistingReleaseRow,
  isPendingLoopDispatch,
  isPostPilotReleaseVersion,
  observeDetachedChildStart,
  parseFactoryReleasePrepareRequest,
  persistFactoryReleaseLoopBinding,
  productionCreateOrReusePackIssues,
  productionDispatchPackLoop,
  rejectForbiddenRequestFields,
  targetCheckoutsForPrepare,
  unsignedDigestBindingMismatch,
  assertCandidateInvocation,
  freezeCandidateInvocation,
  formatPackLoopLastError,
  type CandidateInvocation,
  type FactoryReleaseFrgPayload,
  type FactoryReleasePrepareDeps,
  type FactoryReleasePrepareRequest,
  type ObservedAttestation,
  type ScoreBoundPackLoopArgs,
  type UnsignedFrgGenerationResult,
} from "../scripts/factory-release-prepare.ts";
import {
  FRG_PACK_MANIFEST,
  FRG_SCENARIO_IDS,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  computeAttestorRunId,
  computeFrgEvidence,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  isReleaseEligibleFrgPass,
  verifyFrgAttestation,
  type FrgEvidence,
} from "../scripts/factory-reliability-gate.ts";
import {
  collectFrgPackObservations,
  FRG_HYBRID_PILOT_VERSION,
  loadFrgPack,
  renderFrgPackIssues,
  type LoadedFrgPack,
} from "../scripts/frg-pack-observations.ts";
import { frgPassUniqueOperations } from "./frg-pass-unique-operations.ts";

const MANIFEST_SHA = "a".repeat(64);
const CANDIDATE = "b".repeat(40);
const ACTION_ID = "action-ship-1.34.0-001";
const OBSERVE_HMAC = { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY };

function baseRequest(over: Partial<FactoryReleasePrepareRequest> = {}): FactoryReleasePrepareRequest {
  return {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: ACTION_ID,
    repository: "org/agent-pipeline",
    base_branch: "main",
    target_version: "1.34.0",
    milestone: "v1.34.0",
    integrated_candidate: { git_sha: CANDIDATE, version: "1.33.0" },
    production_pin: {
      version: "1.33.0",
      tag: "v1.33.0",
      git_sha: "c".repeat(40),
    },
    frg_manifest: { pack_id: "factory-gate-v1", sha256: MANIFEST_SHA },
    ...over,
  };
}

function boundLoopArtifacts(over: {
  loop_run_id?: string;
  item_state?: string;
  stop?: unknown;
  runner_observations_text?: string;
} = {}) {
  const loopRunId = over.loop_run_id ?? "loop-bound-134";
  return {
    loop_run_id: loopRunId,
    contract_text: JSON.stringify({
      schema: "pipeline.loop.contract/v1",
      run_id: loopRunId,
      selector: { type: "label", value: "factory-gate" },
      items: [
        { id: "1", depends_on: [] },
        { id: "2", depends_on: [] },
      ],
    }),
    ledger_text: JSON.stringify({
      stop: over.stop ?? null,
      items: {
        "1": { state: over.item_state ?? "pending" },
        "2": { state: over.item_state ?? "pending" },
      },
    }),
    events_text: "\n",
    action_evidence_text: "{}\n",
    runner_observations_text: over.runner_observations_text,
  };
}

function unsignedEligibleScoreEvidence(
  loopRunId: string,
): import("../scripts/factory-reliability-gate.ts").FrgEvidence {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-unsigned-eligible",
    loop_run_id: loopRunId,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    false_human_authority_count: 0,
    attestation_key: null,
    ...frgPassUniqueOperations("1.29.1"),
  });
  assert.equal(evidence.pass, false, "unsigned mint must not invent pass:true");
  assert.equal(
    isReleaseEligibleFrgPass(evidence, { requireAttestation: false }),
    true,
    "omitted HMAC must still be structurally eligible",
  );
  return evidence;
}

function failScoreEvidence(loopRunId: string, version = "1.34.0"): import("../scripts/factory-reliability-gate.ts").FrgEvidence {
  return {
    schema_version: 1,
    version,
    run_id: "frg-score-fail",
    loop_run_id: loopRunId,
    pack_id: "factory-gate-v1",
    pass: false,
    scenarios: FRG_SCENARIO_IDS.map((id) => ({
      id,
      status: "not_observed" as const,
      detail: "unit fail score",
    })),
    composition: { dimensions: [], missing: ["openspec-bearing-item"] },
    scoreboard: {
      item_count: 2,
      ready_clean_count: 0,
      engine_class_count: 0,
      product_class_count: 0,
      human_authority_count: 0,
      engine_class_rate: 0,
      per_item: [],
    },
    thresholds: { min_clean_ready_to_deploy: 2, capacity_stress_n: 2, max_engine_class_rate: 0.25 },
    integrity: { producer: "pipeline-factory-gate" },
    notes: ["unit fail score"],
  } as import("../scripts/factory-reliability-gate.ts").FrgEvidence;
}

function fakePack(): LoadedFrgPack {
  return {
    root_dir: "/pack/factory-gate-v1",
    manifest_sha256: MANIFEST_SHA,
    manifest: {
      schema_version: 1,
      pack_id: "factory-gate-v1",
      manifest_version: 1,
      selector: { type: "label", value: "factory-gate" },
      issue_labels: ["factory-gate", "pipeline:ready"],
      minimum_fresh_issues: 2,
      required_scenario_ids: [...FRG_PACK_MANIFEST.required_scenario_ids],
      auto_scored_scenario_ids: ["clean-item-throughput", "blocker-taxonomy"],
      required_composition_ids: [],
      pilot_policy: {
        id: "factory-gate-v1-hybrid-v1",
        release_version: "1.33.0",
        replacement_issue: 908,
        live_scenario_ids: [],
        live_composition_ids: [],
        layer_a_probes: [],
      },
      templates: [],
      fault_recipes: [],
    },
    template_bodies: new Map(),
    recipes: new Map(),
  } as unknown as LoadedFrgPack;
}

function packWithTemplates(): LoadedFrgPack {
  const base = fakePack();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      templates: [
        {
          id: "clean-docs",
          title: "FRG docs {{release_version}}",
          file: "templates/clean-docs.md",
          sha256: "1".repeat(64),
          clean_path: true,
        },
        {
          id: "clean-openspec",
          title: "FRG openspec {{release_version}}",
          file: "templates/clean-openspec.md",
          sha256: "2".repeat(64),
          clean_path: true,
        },
      ],
    },
    template_bodies: new Map([
      [
        "clean-docs",
        [
          "pack={{pack_id}}",
          "manifest_version={{manifest_version}}",
          "manifest_sha256={{manifest_sha256}}",
          "release={{release_version}}",
          "pack_run_id={{pack_run_id}}",
          "template_id={{template_id}}",
          "template_sha256={{template_sha256}}",
        ].join("\n"),
      ],
      [
        "clean-openspec",
        [
          "pack={{pack_id}}",
          "manifest_version={{manifest_version}}",
          "manifest_sha256={{manifest_sha256}}",
          "release={{release_version}}",
          "pack_run_id={{pack_run_id}}",
          "template_id={{template_id}}",
          "template_sha256={{template_sha256}}",
        ].join("\n"),
      ],
    ]),
  } as LoadedFrgPack;
}

function unsignedPayload(over: Partial<FactoryReleaseFrgPayload> = {}): FactoryReleaseFrgPayload {
  const art = (n: number) => ({
    path: `/tmp/factory-release/art-${n}.json`,
    sha256: String(n).repeat(64).slice(0, 64),
  });
  return {
    pack_id: "factory-gate-v1",
    manifest_path: "/pack/factory-gate-v1/manifest.json",
    manifest_sha256: MANIFEST_SHA,
    pack_run_id: "pack-134",
    loop_run_id: "loop-134",
    frg_run_id: "frg-134",
    evidence_created_at: "2026-08-10T12:00:00Z",
    observations: art(1),
    evidence_bundle: art(2),
    contract: art(3),
    ledger: art(4),
    events: art(5),
    action_evidence: art(6),
    ...over,
  };
}

function releaseEligibleEvidence(
  version = "1.34.0",
  opts?: { unsigned?: FactoryReleaseFrgPayload; request?: FactoryReleasePrepareRequest },
): FrgEvidence {
  // Build via computeFrgEvidence so fingerprints + attestation match.
  // Post-pilot evidence without hybrid-v2 pack_provenance is not release-eligible.
  const unsigned = opts?.unsigned ?? unsignedPayload();
  const request = opts?.request ?? baseRequest();
  const scenarioPass = (id: (typeof FRG_SCENARIO_IDS)[number]) => ({
    id,
    status: "pass" as const,
    detail: "unit",
    observed: id === "capacity-blocked-retain" ? 2 : null,
    threshold: id === "capacity-blocked-retain" ? 2 : null,
  });
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const evidence = computeFrgEvidence({
    version,
    run_id: unsigned.frg_run_id,
    loop_run_id: unsigned.loop_run_id,
    pack_id: "factory-gate-v1",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: FRG_SCENARIO_IDS.map((id) => scenarioPass(id)),
    composition_overrides: [
      "openspec-bearing-item",
      "fix-rereview-cycle",
      "concurrency-contention",
      "managed-worktree-dirt",
      "process-restart-hydration",
      "forge-http-5xx-backoff",
      "ci-pending-red-recovery",
      "same-head-noop-reentry",
      "capacity-live-run-coexistence",
      "recovery-controller-one-item",
      "recovery-controller-multi-item",
    ].map((id) => ({
      id: id as never,
      status: "pass" as const,
      detail: "unit",
      source: "observation" as const,
      observed: null,
    })),
    false_human_authority_count: 0,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    factory_release_binding: binding,
  });
  assert.equal(evidence.pack_provenance, null);
  assert.equal(evidence.pass, false);
  assert.deepEqual(evidence.factory_release_binding, binding);
  return evidence;
}

function observeForUnsigned(
  unsigned: FactoryReleaseFrgPayload,
  request: FactoryReleasePrepareRequest = baseRequest(),
): ObservedAttestation {
  const evidence = releaseEligibleEvidence(request.target_version, { unsigned, request });
  return {
    frg_run_id: unsigned.frg_run_id,
    evidence_path: `/repo/.agent-pipeline/frg/${request.target_version}/${unsigned.frg_run_id}/evidence.json`,
    evidence_sha256: crypto.createHash("sha256").update("e").digest("hex"),
    latest_path: `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`,
    latest_sha256: crypto.createHash("sha256").update("e").digest("hex"),
    evidence,
  };
}

async function hybridFromRunEvidence(opts: {
  request: FactoryReleasePrepareRequest;
  unsigned: FactoryReleaseFrgPayload;
  runId: string;
  includeBinding?: boolean;
  notesBinding?: boolean;
  /** Scored pack candidate; defaults to the request integrated candidate. */
  packCandidateGitSha?: string;
}): Promise<FrgEvidence> {
  const pack = await loadFrgPack();
  const issueNumbers = [1112, 1113];
  const packCandidate = opts.packCandidateGitSha ?? opts.request.integrated_candidate.git_sha;
  const rendered = renderFrgPackIssues(pack, {
    release_version: opts.request.target_version,
    pack_run_id: opts.unsigned.pack_run_id,
  });
  const collected = collectFrgPackObservations(pack, {
    schema_version: 1,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: opts.request.target_version,
    candidate_git_sha: packCandidate,
    pack_run_id: opts.unsigned.pack_run_id,
    loop_run_id: opts.unsigned.loop_run_id,
    repository: opts.request.repository,
    base_branch: opts.request.base_branch,
    started_at: "2026-08-18T02:54:58.000Z",
    contract: {
      artifact_sha256: "b".repeat(64),
      selector: { type: "label", value: "factory-gate" },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((n) => ({ issue_number: n, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: "c".repeat(64),
      items: issueNumbers.map((n) => ({
        issue_number: n,
        state: "ready",
        advance_run_id: `adv-${n}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: "d".repeat(64),
      event_ids: issueNumbers.map((n) => `event:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: "e".repeat(64),
      action_ids: issueNumbers.map((n) => `action:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files =
        issue.provenance.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-18T02:55:0${index}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2100 + index,
          node_id: `PR_${2100 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [{ id: `CHECK_${issueNumber}`, name: "ci", head_sha: head, conclusion: "success" }],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: packCandidate,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: "1".repeat(64),
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "3".repeat(64),
      started_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  const binding = buildFactoryReleaseUnsignedDigestBinding(opts.request, opts.unsigned);
  const evidence = computeFrgEvidence({
    version: opts.request.target_version,
    run_id: opts.runId,
    loop_run_id: opts.unsigned.loop_run_id,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: issueNumbers.map((n) => ({
      item_id: String(n),
      state: "ready" as const,
      ready_clean: true,
    })),
    scenario_overrides: collected.scenarios.map((s) => ({
      id: s.id as never,
      status: s.status,
      detail: s.detail,
      observed: s.observed,
      threshold: s.threshold,
      source: s.source,
      proof_ids: s.proof_ids,
    })),
    composition_overrides: collected.composition.map((d) => ({
      id: d.id as never,
      status: d.status,
      detail: d.detail,
      source: d.source,
      observed: d.observed,
      proof_ids: d.proof_ids,
    })),
    false_human_authority_count: collected.false_human_authority_count,
    pack_provenance: collected.pack_provenance,
    factory_release_binding: opts.includeBinding === false ? undefined : binding,
    notes: opts.notesBinding ? [`factory_release_binding:${JSON.stringify(binding)}`] : undefined,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    score_source: "from-run",
    work_list: "factory-gate-pack",
    ...frgPassUniqueOperations(opts.request.target_version),
  });
  return evidence;
}

function memoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(p: string) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async writeFile(p: string, body: string) {
      files.set(p, body);
    },
    async mkdir() {},
    async fileExists(p: string) {
      return files.has(p);
    },
    async readRequestText(p: string) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`missing request ${p}`);
      return v;
    },
  };
}

function hermeticPrepareDeps(
  overrides: Partial<FactoryReleasePrepareDeps> = {},
): FactoryReleasePrepareDeps {
  return defaultFactoryReleasePrepareDeps({
    listRemainingOpenMilestoneIssues: async () => [],
    ...overrides,
  });
}

function makeDeps(opts: {
  fs: ReturnType<typeof memoryFs>;
  generate?: FactoryReleasePrepareDeps["generateUnsignedFrg"];
  observe?: FactoryReleasePrepareDeps["observeAttestation"];
  observeExistingRelease?: FactoryReleasePrepareDeps["observeExistingRelease"];
  runRelease?: FactoryReleasePrepareDeps["runRelease"];
  generateCalls?: { n: number };
  releaseCalls?: { n: number };
}): FactoryReleasePrepareDeps {
  const generateCalls = opts.generateCalls ?? { n: 0 };
  const releaseCalls = opts.releaseCalls ?? { n: 0 };
  return hermeticPrepareDeps({
    env: {}, // no attestation key in candidate
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => opts.fs.readRequestText(p),
    readFile: (p) => opts.fs.readFile(p),
    writeFile: (p, body) => opts.fs.writeFile(p, body),
    mkdir: () => opts.fs.mkdir(),
    fileExists: (p) => opts.fs.fileExists(p),
    loadPack: async () => fakePack(),
    generateUnsignedFrg: async (request, ctx) => {
      generateCalls.n++;
      if (opts.generate) return opts.generate(request, ctx);
      return {
        frg: unsignedPayload(),
        structurally_eligible: true,
      };
    },
    observeAttestation: async (request, unsigned, ctx) => {
      if (opts.observe) return opts.observe(request, unsigned, ctx);
      return null;
    },
    observeExistingRelease: opts.observeExistingRelease ?? (async () => null),
    runRelease: async (version, releaseOpts, cfg) => {
      releaseCalls.n++;
      if (opts.runRelease) return opts.runRelease(version, releaseOpts, cfg);
      return {
        schema_version: 1,
        kind: "release_prepare",
        version,
        pr: 1340,
        base: "main",
        head_oid: "d".repeat(40),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

test("compareSemver and isPostPilotReleaseVersion", () => {
  assert.equal(compareSemver("1.34.0", "1.33.0"), 1);
  assert.equal(compareSemver("1.33.0", "1.33.0"), 0);
  assert.equal(compareSemver("1.32.0", "1.33.0"), -1);
  assert.equal(isPostPilotReleaseVersion("1.34.0"), true);
  assert.equal(isPostPilotReleaseVersion(FRG_HYBRID_PILOT_VERSION), false);
});

test("honestLatestJsonBindsRequest requires attested hybrid-v2 on this candidate", () => {
  const request = baseRequest();
  const bound = {
    version: "1.34.0",
    pass: true,
    pack_id: "factory-gate-v1",
    loop_run_id: "loop-bound",
    run_id: "frg-bound",
    integrity: { attestation: { alg: "hmac-sha256", mac: "ab" } },
    pack_provenance: { candidate_git_sha: CANDIDATE },
  };
  assert.equal(honestLatestJsonBindsRequest(request, bound), true);
  assert.equal(
    honestLatestJsonBindsRequest(request, { ...bound, pass: false }),
    false,
  );
  assert.equal(
    honestLatestJsonBindsRequest(request, {
      ...bound,
      pack_provenance: { candidate_git_sha: "d".repeat(40) },
    }),
    false,
  );
  assert.equal(
    honestLatestJsonBindsRequest(request, {
      ...bound,
      factory_release_binding: { candidate_git_sha: CANDIDATE },
      pack_provenance: { candidate_git_sha: "d".repeat(40) },
    }),
    false,
    "binding C must not hide scored provenance D",
  );
  assert.equal(
    honestLatestJsonBindsRequest(request, {
      ...bound,
      factory_release_binding: { candidate_git_sha: CANDIDATE },
      pack_provenance: { candidate_git_sha: CANDIDATE },
    }),
    true,
  );
  assert.equal(
    honestLatestJsonBindsRequest(request, { ...bound, integrity: {} }),
    false,
  );
});

test("selectExistingReleaseRow matches an open PR whose head is the candidate", () => {
  const request = baseRequest();
  const hit = selectExistingReleaseRow(request, [
    { number: 99, headRefOid: "e".repeat(40), baseRefName: "main", state: "OPEN" },
    { number: 1120, headRefOid: CANDIDATE, baseRefName: "main", state: "OPEN" },
  ]);
  assert.deepEqual(hit, { pr: 1120, head_oid: CANDIDATE, version: "1.34.0" });
  assert.equal(
    selectExistingReleaseRow(request, [
      { number: 1120, headRefOid: CANDIDATE, baseRefName: "other", state: "OPEN" },
    ]),
    null,
  );
});

test("selectExistingReleaseFromContainingPrs reuses a later PR HEAD that still contains the candidate", () => {
  const request = baseRequest();
  const later = "f".repeat(40);
  const hit = selectExistingReleaseFromContainingPrs(request, [
    { number: 1120, headRefOid: later, baseRefName: "main", state: "open" },
  ]);
  assert.deepEqual(hit, { pr: 1120, head_oid: later, version: "1.34.0" });
});

test("generateDurableUnsignedFrg reuses candidate-bound latest.json and does not start a pack", async () => {
  const request = baseRequest();
  const latest = {
    version: "1.34.0",
    pass: true,
    pack_id: "factory-gate-v1",
    loop_run_id: "loop-reuse",
    run_id: "frg-reuse",
    created_at: "2026-08-18T00:00:00Z",
    integrity: { attestation: { alg: "hmac-sha256", mac: "ab" } },
    pack_provenance: { candidate_git_sha: CANDIDATE, pack_run_id: "pack-reuse" },
  };
  const files = new Map<string, string>([
    ["/repo/.agent-pipeline/frg/1.34.0/latest.json", JSON.stringify(latest)],
  ]);
  let started = 0;
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir: "/repo/.agent-pipeline/factory-release/reuse",
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      fileExists: async (p) => files.has(p),
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      startBoundPackLoop: async () => {
        started += 1;
        throw new Error("must not start a second pack");
      },
    },
  );
  assert.equal(started, 0);
  assert.equal(result.structurally_eligible, true);
  assert.equal(result.frg.frg_run_id, "frg-reuse");
  assert.equal(result.frg.loop_run_id, "loop-reuse");
  assert.equal(result.frg.pack_run_id, "pack-reuse");
});

test("prepare completes from candidate-bound latest.json without runRelease or a second pack", async () => {
  const request = baseRequest();
  const requestPath = "/tmp/req-reuse-latest.json";
  const mem = memoryFs();
  await mem.writeFile(requestPath, JSON.stringify(request));
  const unsigned = unsignedPayload({
    frg_run_id: "frg-reuse",
    loop_run_id: "loop-reuse",
  });
  let releaseCalls = 0;
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    generateUnsignedFrg: async () => ({
      frg: unsigned,
      structurally_eligible: true,
    }),
    observeAttestation: async () => ({
      frg_run_id: "frg-reuse",
      evidence_path: "/repo/.agent-pipeline/frg/1.34.0/latest.json",
      evidence_sha256: "a".repeat(64),
      latest_path: "/repo/.agent-pipeline/frg/1.34.0/latest.json",
      latest_sha256: "a".repeat(64),
      evidence: {
        version: "1.34.0",
        pass: true,
        pack_id: "factory-gate-v1",
        loop_run_id: "loop-reuse",
        run_id: "frg-reuse",
        integrity: { attestation: { alg: "hmac-sha256", mac: "ab" } },
        pack_provenance: { candidate_git_sha: CANDIDATE },
        factory_release_binding: buildFactoryReleaseUnsignedDigestBinding(request, unsigned),
      } as never,
    }),
    observeExistingRelease: async () => ({
      pr: 1120,
      head_oid: CANDIDATE,
      version: "1.34.0",
    }),
    runRelease: async () => {
      releaseCalls += 1;
      throw new Error("must not open a second release PR");
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "complete");
  if (outcome.result.status !== "complete") return;
  assert.equal(outcome.result.release_pr.number, 1120);
  assert.equal(outcome.result.release_pr.head_oid, CANDIDATE);
  assert.equal(releaseCalls, 0);
});

test("rejectForbiddenRequestFields refuses pass claims and credentials", () => {
  assert.throws(() => rejectForbiddenRequestFields({ pass: true }), /forbidden field/);
  assert.throws(
    () => rejectForbiddenRequestFields({ nested: { attestation_key: "secret" } }),
    /forbidden field/,
  );
  assert.doesNotThrow(() =>
    rejectForbiddenRequestFields({ action_id: "x", target_version: "1.34.0" }),
  );
});

test("parseFactoryReleasePrepareRequest accepts a bound 1.34 request", () => {
  const req = parseFactoryReleasePrepareRequest(baseRequest());
  assert.equal(req.target_version, "1.34.0");
  assert.equal(req.integrated_candidate.git_sha, CANDIDATE);
  assert.equal(req.frg_manifest.pack_id, "factory-gate-v1");
});

test("parseFactoryReleasePrepareRequest refuses hybrid pilot version", () => {
  assert.throws(
    () => parseFactoryReleasePrepareRequest(baseRequest({ target_version: "1.33.0" })),
    /only after v1\.33\.0/,
  );
});

test("parseFactoryReleasePrepareRequest refuses caller-authored pass", () => {
  assert.throws(
    () =>
      parseFactoryReleasePrepareRequest({
        ...baseRequest(),
        pass: true,
      } as unknown),
    /forbidden field/,
  );
});

test("parseFactoryReleasePrepareRequest refuses wrong pack id", () => {
  assert.throws(
    () =>
      parseFactoryReleasePrepareRequest(
        baseRequest({
          frg_manifest: { pack_id: "other-pack", sha256: MANIFEST_SHA },
        }),
      ),
    /pack_id must be factory-gate-v1/,
  );
});

// ---------------------------------------------------------------------------
// Two-call protocol
// ---------------------------------------------------------------------------

test("first call returns awaiting_frg_attestation without opening a release PR", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const releaseCalls = { n: 0 };
  const generateCalls = { n: 0 };
  const deps = makeDeps({ fs: mem, releaseCalls, generateCalls });

  const outcome = await runFactoryReleasePrepare(
    { requestPath, repoDir: "/repo", json: true },
    deps,
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "awaiting_frg_attestation");
  if (outcome.result.status !== "awaiting_frg_attestation") return;
  assert.equal(outcome.result.kind, "factory_release_frg_checkpoint");
  assert.equal(outcome.result.target_version, "1.34.0");
  assert.equal(outcome.result.candidate_git_sha, CANDIDATE);
  assert.equal(outcome.result.frg.pack_run_id, "pack-134");
  assert.equal(outcome.result.frg.frg_run_id, "frg-134");
  assert.ok(outcome.result.frg.observations.sha256);
  assert.equal(releaseCalls.n, 0, "must not open release PR on first call");
  assert.equal(generateCalls.n, 1);
  // No release_pr field on awaiting result
  assert.equal("release_pr" in outcome.result, false);
});

test("second call after attestation returns complete via shared runRelease", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const releaseCalls = { n: 0 };
  const generateCalls = { n: 0 };
  let attested = false;
  let boundUnsigned: FactoryReleaseFrgPayload | null = null;

  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    generateCalls,
    observe: async (_req, unsigned) => {
      if (!attested) return null;
      boundUnsigned = unsigned;
      return observeForUnsigned(unsigned, request);
    },
  });

  const first = await runFactoryReleasePrepare(
    { requestPath, repoDir: "/repo", json: true },
    deps,
  );
  assert.equal(first.result.status, "awaiting_frg_attestation");
  assert.equal(releaseCalls.n, 0);

  attested = true;
  const second = await runFactoryReleasePrepare(
    { requestPath, repoDir: "/repo", json: true },
    deps,
  );
  assert.equal(second.exitCode, 0);
  assert.equal(second.result.status, "complete");
  if (second.result.status !== "complete") return;
  assert.equal(second.result.release_pr.number, 1340);
  assert.equal(second.result.release_pr.base_oid, CANDIDATE);
  assert.equal(second.result.frg.run_id, boundUnsigned?.frg_run_id ?? "frg-134");
  assert.equal(releaseCalls.n, 1);
  // Idempotent: generate only once across both calls
  assert.equal(generateCalls.n, 1);
});

test("post-attestation reuses an already-merged release PR and does not call runRelease (#1115)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const releaseCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    observe: async (_req, unsigned) => observeForUnsigned(unsigned, request),
    observeExistingRelease: async () => ({
      pr: 1109,
      head_oid: "f".repeat(40),
      version: "1.34.0",
    }),
  });
  const outcome = await runFactoryReleasePrepare(
    { requestPath, repoDir: "/repo", json: true },
    deps,
  );
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "complete");
  if (outcome.result.status !== "complete") return;
  assert.equal(outcome.result.release_pr.number, 1109);
  assert.equal(releaseCalls.n, 0);
});

test("idempotent re-entry at awaiting does not create a second pack", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const generateCalls = { n: 0 };
  const deps = makeDeps({ fs: mem, generateCalls });

  const a = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  const b = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(a.result.status, "awaiting_frg_attestation");
  assert.equal(b.result.status, "awaiting_frg_attestation");
  assert.equal(generateCalls.n, 1, "second tick must re-observe, not re-generate");
  if (a.result.status === "awaiting_frg_attestation" && b.result.status === "awaiting_frg_attestation") {
    assert.equal(a.result.checkpoint, b.result.checkpoint);
    assert.equal(a.result.frg.pack_run_id, b.result.frg.pack_run_id);
  }
});

test("idempotent re-entry at complete does not open a second PR", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const releaseCalls = { n: 0 };
  const generateCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    generateCalls,
    observe: async (_req, unsigned) => observeForUnsigned(unsigned, request),
  });

  const a = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  const b = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(a.result.status, "complete");
  assert.equal(b.result.status, "complete");
  assert.equal(releaseCalls.n, 1, "second complete tick must not re-run release");
  assert.equal(generateCalls.n, 1);
  if (a.result.status === "complete" && b.result.status === "complete") {
    assert.equal(a.result.release_pr.number, b.result.release_pr.number);
  }
});

test("structural FRG failure blocks complete and does not open a release PR", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const releaseCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    generate: async () =>
      ({
        frg: unsignedPayload(),
        structurally_eligible: false,
        defect_class: "scenario_missing",
        message: "FRG failed for 1.34.0: required scenario not_observed",
      }) satisfies UnsignedFrgGenerationResult,
  });

  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.status, "failed");
  if (outcome.result.status !== "failed") return;
  assert.equal(outcome.result.defect_class, "scenario_missing");
  assert.match(outcome.result.message, /1\.34\.0/);
  assert.equal(releaseCalls.n, 0);
});

test("refuses attestation key in candidate environment", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const deps = makeDeps({ fs: mem });
  deps.env = { PIPELINE_FRG_ATTESTATION_KEY: "should-not-be-here" };

  await assert.rejects(
    () => runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps),
    /PIPELINE_FRG_ATTESTATION_KEY/,
  );
});

test("stale foreign evidence (wrong loop_run_id) is refused at attestation", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const evidence = releaseEligibleEvidence();
  (evidence as { loop_run_id: string }).loop_run_id = "loop-FOREIGN";
  const deps = makeDeps({
    fs: mem,
    observe: async () => ({
      frg_run_id: evidence.run_id,
      evidence_path: "/repo/e.json",
      evidence_sha256: "e".repeat(64),
      latest_path: "/repo/l.json",
      latest_sha256: "e".repeat(64),
      evidence,
    }),
  });

  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.status, "failed");
  if (outcome.result.status === "failed") {
    assert.equal(outcome.result.defect_class, "attestation_mismatch");
  }
});

// ---------------------------------------------------------------------------
// Review 1 regressions (#953)
// ---------------------------------------------------------------------------

test("terminal score path ignores runner observations (does not pass --observations)", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-layer-a";
  const scoreArgs: ScoreBoundPackLoopArgs[] = [];
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: fakePack(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      fileExists: async (p) => files.has(p),
      reconcilePackLoop: async () =>
        boundLoopArtifacts({
          loop_run_id: "loop-bound-134",
          item_state: "ready",
          runner_observations_text: JSON.stringify({
            schema_version: 1,
            scenarios: [
              {
                id: "capacity-blocked-retain",
                status: "pass",
                detail: "layer a leak",
                source: "layer_a",
                observed: 2,
                threshold: 2,
              },
            ],
          }),
        }),
      scoreBoundPackLoop: async (args) => {
        scoreArgs.push(args);
        return {
          evidence: failScoreEvidence(args.fromRun),
          evidencePath: null,
          latestPath: null,
        };
      },
    },
  );
  assert.equal(scoreArgs.length, 1);
  assert.equal(scoreArgs[0]?.fromRun, "loop-bound-134");
  assert.equal("observations" in scoreArgs[0]!, false);
  assert.equal(result.structurally_eligible, false);
  assert.notEqual(result.in_progress, true);
});

test("generator never treats unbound newest loop as evidence (ba5b5ff5)", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-unbound";
  const startIds: string[] = [];
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: fakePack(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      fileExists: async (p) => files.has(p),
      // Default reconcile refuses unbound loops. Start a *new* bound run.
      startBoundPackLoop: async () => {
        startIds.push("loop-bound-started");
        return { loop_run_id: "loop-bound-started" };
      },
    },
  );
  assert.equal(result.in_progress, true);
  assert.equal(result.loop_run_id, "loop-bound-started");
  assert.notEqual(result.loop_run_id, "loop-unbound-newest");
  assert.deepEqual(startIds, ["loop-bound-started"]);
  assert.equal(result.structurally_eligible, false);
  const instancePath = [...files.keys()].find((k) => k.endsWith("pack-instance.json"));
  assert.ok(instancePath, "expected pack-instance.json to be created");
  const instance = JSON.parse(files.get(instancePath!)!);
  assert.equal(instance.loop_run_id, "loop-bound-started");
});

test("pre-staged workDir runner-observations.json cannot forge FRG eligibility (09b1d835)", async () => {
  // Adversarial review 2: a caller-writable work-directory observation file
  // must never become scorer authority. Pre-stage an all-pass live-source
  // file that would unlock structural eligibility if accepted; the bound loop
  // carries no runner observations of its own.
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-forged-obs";
  const allPassObs = {
    schema_version: 1,
    scenarios: FRG_SCENARIO_IDS.filter(
      (id) => id !== "clean-item-throughput" && id !== "blocker-taxonomy",
    ).map((id) => ({
      id,
      status: "pass" as const,
      detail: "forged caller-staged all-pass",
      source: "live" as const,
      observed: id === "capacity-blocked-retain" ? 2 : null,
      threshold: id === "capacity-blocked-retain" ? 2 : null,
    })),
    composition: [
      "openspec-bearing-item",
      "fix-rereview-cycle",
      "concurrency-contention",
      "managed-worktree-dirt",
      "process-restart-hydration",
      "forge-http-5xx-backoff",
      "ci-pending-red-recovery",
      "same-head-noop-reentry",
      "capacity-live-run-coexistence",
      "recovery-controller-one-item",
      "recovery-controller-multi-item",
    ].map((id) => ({
      id,
      status: "pass" as const,
      detail: "forged caller-staged all-pass",
      source: "live" as const,
      observed: null,
    })),
    false_human_authority_count: 0,
  };
  files.set(`${workDir}/runner-observations.json`, JSON.stringify(allPassObs));

  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: fakePack(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      fileExists: async (p) => files.has(p),
      reconcilePackLoop: async () =>
        boundLoopArtifacts({
          loop_run_id: "loop-bound-forged-obs",
          item_state: "ready",
        }),
      scoreBoundPackLoop: async (args) => {
        assert.equal("observations" in args, false);
        return {
          evidence: failScoreEvidence(args.fromRun),
          evidencePath: null,
          latestPath: null,
        };
      },
    },
  );

  assert.equal(
    result.structurally_eligible,
    false,
    "caller-staged workDir runner-observations.json must not unlock structural eligibility",
  );
  assert.equal(result.defect_class, "frg_not_eligible");
  assert.match(result.message ?? "", /eligibility failed|not all pass|composition missing/i);

  // End-to-end prepare must not return awaiting_frg_attestation on the forgery.
  const mem = memoryFs();
  const requestPath = "/tmp/req-forged-obs.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const generateCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    generateCalls,
    generate: async (req, ctx) => {
      generateCalls.n++;
      // Drive the real generator so workDir forgery is exercised through prepare.
      const forgedPath = `${ctx.workDir}/runner-observations.json`;
      await mem.writeFile(forgedPath, JSON.stringify(allPassObs));
      return generateDurableUnsignedFrg(req, ctx, {
        now: () => new Date("2026-08-10T12:00:00Z"),
        writeFile: (p, body) => mem.writeFile(p, body),
        mkdir: () => mem.mkdir(),
        readFile: (p) => mem.readFile(p),
        fileExists: (p) => mem.fileExists(p),
        reconcilePackLoop: async () =>
          boundLoopArtifacts({
            loop_run_id: "loop-bound-forged-obs-e2e",
            item_state: "ready",
          }),
        scoreBoundPackLoop: async (args) => ({
          evidence: failScoreEvidence(args.fromRun),
          evidencePath: null,
          latestPath: null,
        }),
      });
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.status, "failed");
  if (outcome.result.status === "failed") {
    assert.equal(outcome.result.defect_class, "frg_not_eligible");
  }
  assert.notEqual(outcome.result.status, "awaiting_frg_attestation");
});

test("attestation without unsigned digest binding is refused (5782ec4d)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const expected = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  assert.equal(
    unsignedDigestBindingMismatch(expected, null),
    "factory_release_binding missing or not an object",
  );
  assert.ok(
    unsignedDigestBindingMismatch(expected, {
      ...expected,
      artifacts: { ...expected.artifacts, observations_sha256: "f".repeat(64) },
    })?.includes("observations_sha256"),
  );

  const mem = memoryFs();
  // Evidence present with matching ids but NO factory_release_binding digests.
  const evidence = computeFrgEvidence({
    version: "1.34.0",
    run_id: unsigned.frg_run_id,
    loop_run_id: unsigned.loop_run_id,
    pack_id: "factory-gate-v1",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: FRG_SCENARIO_IDS.map((id) => ({
      id,
      status: "pass" as const,
      detail: "unit",
      observed: id === "capacity-blocked-retain" ? 2 : null,
      threshold: id === "capacity-blocked-retain" ? 2 : null,
    })),
    composition_overrides: [
      "openspec-bearing-item",
      "fix-rereview-cycle",
      "concurrency-contention",
      "managed-worktree-dirt",
      "process-restart-hydration",
      "forge-http-5xx-backoff",
      "ci-pending-red-recovery",
      "same-head-noop-reentry",
      "capacity-live-run-coexistence",
      "recovery-controller-one-item",
      "recovery-controller-multi-item",
    ].map((id) => ({
      id: id as never,
      status: "pass" as const,
      detail: "unit",
      source: "observation" as const,
      observed: null,
    })),
    false_human_authority_count: 0,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  const evidencePath = `/repo/.agent-pipeline/frg/1.34.0/${unsigned.frg_run_id}/evidence.json`;
  await mem.writeFile(evidencePath, JSON.stringify(evidence));

  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
  );
  assert.equal(observed.status, "rejected");
  if (observed.status === "rejected") {
    assert.equal(observed.reason, "missing_factory_release_binding");
    assert.equal(observed.expected_frg_run_id, unsigned.frg_run_id);
  }
});

test("handoff without evidence returns awaiting null without recursion (90ccb9ff)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const workDir = "/tmp/handoff-crash-window";
  await mem.writeFile(
    `${workDir}/attestation-handoff.json`,
    JSON.stringify({
      kind: "frg_attestation_handoff",
      status: "complete",
      frg_run_id: unsigned.frg_run_id,
      frg_evidence_path: `/repo/.agent-pipeline/frg/1.34.0/${unsigned.frg_run_id}/evidence.json`,
      frg_latest_path: "/repo/.agent-pipeline/frg/1.34.0/latest.json",
    }),
  );
  // Evidence files intentionally absent — crash window after handoff store.
  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
  );
  assert.equal(observed.status, "absent");
});

test("attestation with matching unsigned digests is accepted (5782ec4d positive)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const evidence = releaseEligibleEvidence("1.34.0", { unsigned, request });
  const evidencePath = `/repo/.agent-pipeline/frg/1.34.0/${unsigned.frg_run_id}/evidence.json`;
  // Serialize with factory_release_binding field for the observer.
  const wire = {
    ...evidence,
    factory_release_binding: binding,
  };
  await mem.writeFile(evidencePath, JSON.stringify(wire));

  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
  );
  // Matching digests are not enough: 1.34.0 without hybrid-v2 pack_provenance
  // is not release-eligible, so the observer must not accept the artifact.
  assert.notEqual(observed.status, "accepted");
});

test("default generateUnsigned starts a bound loop and does not invent pass", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    startBoundPackLoop: async () => ({ loop_run_id: "loop-default-start" }),
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });

  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "in_progress");
  if (outcome.result.status === "in_progress") {
    assert.equal(outcome.result.loop_run_id, "loop-default-start");
    assert.equal("pass" in outcome.result, false);
  }
  assert.notEqual(outcome.result.status, "complete");
});

test("factory-release prepare leftover open issue fails closed before pack-loop start (#1354)", async () => {
  const mem = memoryFs();
  const request = baseRequest({ milestone: "v1.40.1" });
  const requestPath = "/tmp/req-remaining-open.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  let packLoopStarts = 0;
  const generateCalls = { n: 0 };
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    listRemainingOpenMilestoneIssues: async ({ milestone }) => {
      assert.equal(milestone, "v1.40.1");
      return [1344];
    },
    startBoundPackLoop: async () => {
      packLoopStarts += 1;
      return { loop_run_id: "loop-must-not-start" };
    },
    generateUnsignedFrg: async () => {
      generateCalls.n += 1;
      throw new Error("must not generate unsigned FRG");
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  await assert.rejects(
    () => runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps),
    /milestone v1\.40\.1 still has open issues: #1344/,
  );
  assert.equal(packLoopStarts, 0);
  assert.equal(generateCalls.n, 0);
});

test("request fingerprint is stable for the same binding", () => {
  const a = factoryReleaseRequestFingerprint(baseRequest());
  const b = factoryReleaseRequestFingerprint(baseRequest());
  assert.equal(a, b);
  const c = factoryReleaseRequestFingerprint(
    baseRequest({ action_id: "other-action" }),
  );
  assert.notEqual(a, c);
});

test("hybrid pilot version is not post-pilot", () => {
  assert.equal(isPostPilotReleaseVersion("1.33.0"), false);
  assert.equal(isPostPilotReleaseVersion("1.34.0"), true);
  assert.equal(isPostPilotReleaseVersion("2.0.0"), true);
});

test("isBoundPackLoopTerminal: pending is not terminal; ready/stop is", () => {
  assert.equal(isBoundPackLoopTerminal(boundLoopArtifacts({ item_state: "pending" })), false);
  assert.equal(isBoundPackLoopTerminal(boundLoopArtifacts({ item_state: "ready" })), true);
  assert.equal(
    isBoundPackLoopTerminal(boundLoopArtifacts({ item_state: "pending", stop: { reason: "done" } })),
    true,
  );
});

// ---------------------------------------------------------------------------
// #1037: start / resume / unbound refusal / --from-run score
// ---------------------------------------------------------------------------

test("first prepare with no bound loop dispatches start and returns in_progress", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-1037-first.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const startCalls: string[] = [];
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    startBoundPackLoop: async () => {
      startCalls.push("loop-1037-a");
      return { loop_run_id: "loop-1037-a" };
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });

  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "in_progress");
  if (outcome.result.status !== "in_progress") return;
  assert.equal(outcome.result.loop_run_id, "loop-1037-a");
  assert.ok(outcome.result.checkpoint);
  assert.equal("pass" in outcome.result, false);
  assert.deepEqual(startCalls, ["loop-1037-a"]);

  const fingerprint = factoryReleaseRequestFingerprint(request);
  const instancePath = factoryReleasePackInstancePath(
    factoryReleaseWorkDir("/repo", fingerprint),
  );
  const instance = JSON.parse(await mem.readFile(instancePath));
  assert.equal(instance.loop_run_id, "loop-1037-a");
});

test("second prepare with the same request resumes the same loop_run_id", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-1037-resume.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const startCalls: string[] = [];
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    startBoundPackLoop: async () => {
      startCalls.push("loop-1037-resume");
      return { loop_run_id: "loop-1037-resume" };
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });

  const first = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  const second = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(first.result.status, "in_progress");
  assert.equal(second.result.status, "in_progress");
  if (first.result.status === "in_progress" && second.result.status === "in_progress") {
    assert.equal(first.result.loop_run_id, "loop-1037-resume");
    assert.equal(second.result.loop_run_id, first.result.loop_run_id);
  }
  assert.equal(startCalls.length, 1, "second tick must resume, not start another pack");
});

test("unbound newest factory-gate loop is not adopted as the bound run", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-unbound-1037";
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: fakePack(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      fileExists: async (p) => files.has(p),
      startBoundPackLoop: async () => ({ loop_run_id: "loop-request-bound" }),
    },
  );
  assert.equal(result.in_progress, true);
  assert.equal(result.loop_run_id, "loop-request-bound");
  assert.notEqual(result.loop_run_id, "loop-unbound-newest");
});

test("terminal score uses --from-run and does not pass --observations; fail stays fail", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-score";
  const scoreCalls: ScoreBoundPackLoopArgs[] = [];
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: fakePack(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      fileExists: async (p) => files.has(p),
      reconcilePackLoop: async () =>
        boundLoopArtifacts({ loop_run_id: "loop-terminal-1037", item_state: "ready" }),
      scoreBoundPackLoop: async (args) => {
        scoreCalls.push(args);
        return {
          evidence: failScoreEvidence(args.fromRun),
          evidencePath: null,
          latestPath: null,
        };
      },
    },
  );

  assert.equal(scoreCalls.length, 1);
  assert.equal(scoreCalls[0]?.fromRun, "loop-terminal-1037");
  assert.equal(scoreCalls[0]?.version, "1.34.0");
  assert.equal("observations" in (scoreCalls[0] ?? {}), false);
  assert.equal(result.structurally_eligible, false);
  assert.equal(result.defect_class, "frg_not_eligible");
  assert.notEqual(result.in_progress, true);

  const latestPath = [...files.keys()].find((k) => k.endsWith("/latest.json"));
  assert.ok(latestPath, "fail MAY write latest.json");
  const latest = JSON.parse(files.get(latestPath!)!);
  assert.equal(latest.pass, false);
});

test("omitted HMAC on structurally eligible terminal pack is awaiting, not frg_not_eligible (#1147)", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-unsigned-eligible";
  const scoreCalls: ScoreBoundPackLoopArgs[] = [];
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: fakePack(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      fileExists: async (p) => files.has(p),
      reconcilePackLoop: async () =>
        boundLoopArtifacts({ loop_run_id: "loop-unsigned-eligible", item_state: "ready" }),
      scoreBoundPackLoop: async (args) => {
        scoreCalls.push(args);
        return {
          evidence: unsignedEligibleScoreEvidence(args.fromRun),
          evidencePath: null,
          latestPath: null,
        };
      },
    },
  );

  assert.equal(scoreCalls.length, 1);
  assert.equal("observations" in (scoreCalls[0] ?? {}), false);
  assert.equal(result.structurally_eligible, true);
  assert.notEqual(result.defect_class, "frg_not_eligible");
  assert.equal(result.frg.loop_run_id, "loop-unsigned-eligible");
  const latestPath = [...files.keys()].find((k) => k.endsWith("/latest.json"));
  assert.ok(latestPath, "unsigned eligible score still writes latest.json");
  const latest = JSON.parse(files.get(latestPath!)!);
  assert.equal(latest.pass, false, "unsigned latest.json must stay pass:false");
  assert.equal(latest.integrity?.attestation, undefined);

  const mem = memoryFs();
  const requestPath = "/tmp/req-unsigned-eligible.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const generateCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    generateCalls,
    generate: async (req, ctx) => {
      generateCalls.n++;
      return generateDurableUnsignedFrg(req, ctx, {
        now: () => new Date("2026-08-10T12:00:00Z"),
        writeFile: (p, body) => mem.writeFile(p, body),
        mkdir: () => mem.mkdir(),
        readFile: (p) => mem.readFile(p),
        fileExists: (p) => mem.fileExists(p),
        reconcilePackLoop: async () =>
          boundLoopArtifacts({ loop_run_id: "loop-unsigned-eligible-e2e", item_state: "ready" }),
        scoreBoundPackLoop: async (args) => ({
          evidence: unsignedEligibleScoreEvidence(args.fromRun),
          evidencePath: null,
          latestPath: null,
        }),
      });
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "awaiting_frg_attestation");
  if (outcome.result.status === "awaiting_frg_attestation") {
    assert.equal(outcome.result.frg.loop_run_id, "loop-unsigned-eligible-e2e");
    assert.ok(outcome.result.frg.observations.sha256);
    assert.ok(outcome.result.frg.evidence_bundle.sha256);
  }
  assert.notEqual(outcome.result.status, "failed");
  if (outcome.result.status === "failed") {
    assert.notEqual(outcome.result.defect_class, "frg_not_eligible");
  }
});

test("stale omitted-HMAC failed checkpoint is re-observed as awaiting (#1147)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-stale-omitted-hmac.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const fingerprint = factoryReleaseRequestFingerprint(request);
  const checkpointPath = factoryReleaseCheckpointPath("/repo", fingerprint);
  await mem.writeFile(
    checkpointPath,
    JSON.stringify({
      schema_version: 1,
      kind: "factory_release_checkpoint_store",
      request_fingerprint: fingerprint,
      phase: "failed",
      request,
      failure: {
        defect_class: "frg_not_eligible",
        message: "release-eligible attestation omitted",
      },
      updated_at: "2026-08-19T19:44:19Z",
    }),
  );
  const generateCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    generateCalls,
    generate: async () => ({
      frg: unsignedPayload({
        loop_run_id: "loop-stale-omitted-hmac",
        frg_run_id: "frg-stale-omitted-hmac",
      }),
      structurally_eligible: true,
    }),
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(generateCalls.n, 1, "stale omitted-HMAC failed checkpoint must re-generate");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "awaiting_frg_attestation");
  if (outcome.result.status === "awaiting_frg_attestation") {
    assert.equal(outcome.result.frg.loop_run_id, "loop-stale-omitted-hmac");
  }
  const stored = JSON.parse(mem.files.get(checkpointPath)!);
  assert.equal(stored.phase, "awaiting_frg_attestation");
  assert.equal(stored.failure, undefined);
});

test("defaultStartBoundPackLoop creates pack issues and dispatches candidate loop", async () => {
  const renderedSeen: string[] = [];
  const dispatched: Array<{ engineTrack: string; label: string; n: number }> = [];
  const result = await defaultStartBoundPackLoop(
    {
      repoDir: "/repo",
      workDir: "/tmp/work",
      request: baseRequest(),
      pack: packWithTemplates(),
      packRunId: "pack-1340-action",
      frgRunId: "frg-x",
      requestFingerprint: "f".repeat(64),
      writeFile: async () => {},
      readFile: async () => {
        throw new Error("ENOENT");
      },
      fileExists: async () => false,
      now: () => new Date("2026-08-10T12:00:00Z"),
    },
    {
      createOrReusePackIssues: async ({ rendered }) => {
        renderedSeen.push(...rendered.map((r) => r.provenance.template_id));
        assert.ok(rendered.length >= 2);
        return { issue_numbers: [101, 102] };
      },
      dispatchPackLoop: async (input) => {
        dispatched.push({
          engineTrack: input.engineTrack,
          label: input.label,
          n: input.issue_numbers.length,
        });
        return { loop_run_id: "loop-dispatch-1037" };
      },
    },
  );
  assert.equal(result?.loop_run_id, "loop-dispatch-1037");
  assert.deepEqual(renderedSeen, ["clean-docs", "clean-openspec"]);
  assert.deepEqual(dispatched, [{ engineTrack: "candidate", label: "factory-gate", n: 2 }]);
});

test("productionCreateOrReusePackIssues reuses matching pack_run_id issues", async () => {
  const created: string[] = [];
  const result = await productionCreateOrReusePackIssues(
    {
      repoDir: "/repo",
      request: baseRequest(),
      pack: packWithTemplates(),
      packRunId: "pack-reuse-1",
      rendered: [
        {
          title: "docs",
          body: "pack_run_id=pack-reuse-1 template_id=clean-docs",
          labels: ["factory-gate"],
          provenance: {
            pack_id: "factory-gate-v1",
            manifest_version: 1,
            manifest_sha256: MANIFEST_SHA,
            release_version: "1.34.0",
            pack_run_id: "pack-reuse-1",
            template_id: "clean-docs",
            template_sha256: "1".repeat(64),
          },
        },
        {
          title: "openspec",
          body: "pack_run_id=pack-reuse-1 template_id=clean-openspec",
          labels: ["factory-gate"],
          provenance: {
            pack_id: "factory-gate-v1",
            manifest_version: 1,
            manifest_sha256: MANIFEST_SHA,
            release_version: "1.34.0",
            pack_run_id: "pack-reuse-1",
            template_id: "clean-openspec",
            template_sha256: "2".repeat(64),
          },
        },
      ],
    },
    {
      listOpenPackIssues: async () => [
        {
          number: 55,
          title: "docs",
          body: "pack_run_id=pack-reuse-1 template_id=clean-docs",
        },
      ],
      createIssue: async (title) => {
        created.push(title);
        return 56;
      },
    },
  );
  assert.deepEqual(result.issue_numbers, [55, 56]);
  assert.deepEqual(created, ["openspec"]);
});

test("observeDetachedChildStart rejects child error and does not unref", async () => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  let unrefed = false;
  child.unref = () => {
    unrefed = true;
  };
  const pending = observeDetachedChildStart(child);
  const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  child.emit("error", err);
  await assert.rejects(pending, /ENOENT/);
  assert.equal(unrefed, false);
});

test("observeDetachedChildStart resolves on spawn and unrefs", async () => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  let unrefed = false;
  child.unref = () => {
    unrefed = true;
  };
  const pending = observeDetachedChildStart(child);
  child.emit("spawn");
  await pending;
  assert.equal(unrefed, true);
});

test("productionDispatchPackLoop persists binding before spawn", async () => {
  const events: string[] = [];
  const files = new Map<string, string>();
  const persistCtx = {
    repoDir: "/repo",
    workDir: "/tmp/frg-work-persist-order",
    request: baseRequest(),
    pack: packWithTemplates(),
    packRunId: "pack-1340-order",
    frgRunId: "frg-order",
    requestFingerprint: factoryReleaseRequestFingerprint(baseRequest()),
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
    now: () => new Date("2026-08-10T12:00:00Z"),
  };
  const result = await productionDispatchPackLoop(
    {
      repoDir: "/repo",
      request: baseRequest(),
      pack: packWithTemplates(),
      packRunId: "pack-1340-order",
      issue_numbers: [101, 102],
      engineTrack: "candidate",
      label: "factory-gate",
      persistCtx,
      candidateInvocation: testInvocation("loop-persist-order"),
    },
    {
      fileExists: () => true,
      initBoundLoop: async () => {
        events.push("init");
        return { loop_run_id: "loop-persist-order" };
      },
      spawnCandidateLoop: async () => {
        events.push("spawn");
        const bindingPath = factoryReleaseLoopBindingPath("loop-persist-order");
        assert.equal(files.has(bindingPath), true, "binding must exist before spawn");
        const binding = JSON.parse(files.get(bindingPath)!);
        assert.equal(isPendingLoopDispatch(binding), true);
        const instance = JSON.parse(files.get(factoryReleasePackInstancePath(persistCtx.workDir))!);
        assert.equal(instance.loop_run_id, "loop-persist-order");
        return { dispatch_state: "dispatched" as const };
      },
    },
  );
  assert.equal(result.loop_run_id, "loop-persist-order");
  assert.deepEqual(events, ["init", "spawn"]);
  const binding = JSON.parse(files.get(factoryReleaseLoopBindingPath("loop-persist-order"))!);
  assert.equal(binding.dispatch_state, "dispatched");
});

test("crash after persist before spawn resumes the same bound run", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-crash-window";
  const spawnCalls: string[] = [];
  const startCalls: string[] = [];
  const resumeCalls: string[] = [];
  const fs = {
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
  };
  const first = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fs.writeFile,
      mkdir: async () => {},
      readFile: fs.readFile,
      fileExists: fs.fileExists,
      createOrReusePackIssues: async () => {
        startCalls.push("create");
        return { issue_numbers: [101, 102] };
      },
      dispatchPackLoop: async (input) =>
        productionDispatchPackLoop(
          { ...input, candidateInvocation: testInvocation("loop-crash-window") },
          {
          fileExists: () => true,
          initBoundLoop: async () => ({ loop_run_id: "loop-crash-window" }),
          persistBinding: async (id) => {
            if (!input.persistCtx) throw new Error("missing persistCtx");
            await persistFactoryReleaseLoopBinding(input.persistCtx, id, "bound");
            throw new Error("simulated crash after persist");
          },
          spawnCandidateLoop: async () => {
            spawnCalls.push("first");
          },
        }),
    },
  );
  assert.equal(first.in_progress, undefined);
  assert.equal(first.defect_class, "pack_loop_start_failed");
  assert.deepEqual(spawnCalls, []);
  const binding = JSON.parse(files.get(factoryReleaseLoopBindingPath("loop-crash-window"))!);
  assert.equal(isPendingLoopDispatch(binding), true);
  const instance = JSON.parse(files.get(factoryReleasePackInstancePath(workDir))!);
  assert.equal(instance.loop_run_id, "loop-crash-window");

  const second = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fs.writeFile,
      mkdir: async () => {},
      readFile: fs.readFile,
      fileExists: fs.fileExists,
      createOrReusePackIssues: async () => {
        startCalls.push("create-again");
        return { issue_numbers: [101, 102] };
      },
      dispatchPackLoop: async () => {
        startCalls.push("dispatch-again");
        return { loop_run_id: "loop-second-pack" };
      },
      resumeBoundPackLoop: async ({ loop_run_id }) => {
        resumeCalls.push(loop_run_id);
        return { dispatch_state: "dispatched" as const };
      },
    },
  );
  assert.equal(second.in_progress, true);
  assert.equal(second.loop_run_id, "loop-crash-window");
  assert.deepEqual(resumeCalls, ["loop-crash-window"]);
  assert.deepEqual(startCalls, ["create"]);
  assert.notEqual(second.loop_run_id, "loop-second-pack");
});

test("failed detached spawn is retried on the same bound run", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-spawn-enoent";
  const spawnAttempts: string[] = [];
  const startCalls: string[] = [];
  const fs = {
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
  };
  const spawnOnce = async (label: string) => {
    spawnAttempts.push(label);
    if (spawnAttempts.length === 1) {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    }
  };
  const first = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fs.writeFile,
      mkdir: async () => {},
      readFile: fs.readFile,
      fileExists: fs.fileExists,
      createOrReusePackIssues: async () => {
        startCalls.push("create");
        return { issue_numbers: [101, 102] };
      },
      dispatchPackLoop: async (input) =>
        productionDispatchPackLoop(
          { ...input, candidateInvocation: testInvocation("loop-spawn-enoent") },
          {
          fileExists: () => true,
          initBoundLoop: async () => ({ loop_run_id: "loop-spawn-enoent" }),
          spawnCandidateLoop: async () => spawnOnce("first"),
        }),
    },
  );
  assert.equal(first.defect_class, "pack_loop_start_failed");
  assert.match(first.message ?? "", /ENOENT/);
  assert.notEqual(first.in_progress, true);
  const binding = JSON.parse(files.get(factoryReleaseLoopBindingPath("loop-spawn-enoent"))!);
  assert.equal(isPendingLoopDispatch(binding), true);
  assert.equal(
    JSON.parse(files.get(factoryReleasePackInstancePath(workDir))!).loop_run_id,
    "loop-spawn-enoent",
  );

  const second = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fs.writeFile,
      mkdir: async () => {},
      readFile: fs.readFile,
      fileExists: fs.fileExists,
      createOrReusePackIssues: async () => {
        startCalls.push("create-again");
        return { issue_numbers: [103, 104] };
      },
      dispatchPackLoop: async () => {
        startCalls.push("dispatch-again");
        return { loop_run_id: "loop-other" };
      },
      resumeBoundPackLoop: async ({ loop_run_id }) => {
        await spawnOnce(`resume:${loop_run_id}`);
        return { dispatch_state: "dispatched" as const };
      },
    },
  );
  assert.equal(second.in_progress, true);
  assert.equal(second.loop_run_id, "loop-spawn-enoent");
  assert.deepEqual(spawnAttempts, ["first", "resume:loop-spawn-enoent"]);
  assert.deepEqual(startCalls, ["create"]);
  const after = JSON.parse(files.get(factoryReleaseLoopBindingPath("loop-spawn-enoent"))!);
  assert.equal(after.dispatch_state, "dispatched");
});

function dirtyFrgSigningEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    PIPELINE_BIN: "/opt/pipeline",
    HOME: "/home/wrapper",
    PIPELINE_FRG_ATTESTATION_KEY: "production-attestor-secret",
    PIPELINE_FRG_ATTESTATION_KEY_FILE: "/secrets/frg-attestation.key",
  };
}

const CANDIDATE_LAUNCHER = "/candidate-engine/scripts/pipeline-launcher.mjs";
const PIN_LAUNCHER = "/opt/pipeline";

function testInvocation(loopRunId: string, sha = CANDIDATE): CandidateInvocation {
  return freezeCandidateInvocation({
    executable: CANDIDATE_LAUNCHER,
    loopRunId,
    candidateSha: sha,
  });
}

function capturingCandidateSpawn(captured: {
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: readonly string[];
  stdio?: unknown;
}) {
  return (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; stdio?: unknown },
  ) => {
    captured.command = command;
    captured.args = args;
    captured.env = options.env;
    captured.stdio = options.stdio;
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    };
    child.unref = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

function validHandoff(loopRunId: string, sha = CANDIDATE) {
  return {
    schema_version: "1",
    kind: "loop_run_handoff",
    run_id: loopRunId,
    run_dir: `/state/runs/${loopRunId}`,
    events: `/state/runs/${loopRunId}/events.jsonl`,
    engine: "claude",
    resumed: false,
    selector: null,
    candidate_sha: sha,
    supervisor: {
      pid: 4242,
      boot_id: "boot-1",
      started_at: "2026-08-29T00:00:00.000Z",
      token: "tok",
    },
  };
}

function spawnDepsForHandoff(loopRunId: string, captured: Parameters<typeof capturingCandidateSpawn>[0]) {
  const invocation = testInvocation(loopRunId);
  return {
    spawn: capturingCandidateSpawn(captured),
    env: dirtyFrgSigningEnv(),
    fileExists: () => true,
    readHandoff: async () => validHandoff(loopRunId),
    readSupervisor: async () => validHandoff(loopRunId).supervisor,
    realpath: (p: string) => p,
    storeRunDir: `/state/runs/${loopRunId}`,
    sleep: async () => {},
    now: () => new Date("2026-08-29T00:00:01.000Z"),
    invocation,
  };
}

test("sanitizeCandidateLoopEnv drops FRG signing credential and path vars", () => {
  const sanitized = sanitizeCandidateLoopEnv(dirtyFrgSigningEnv());
  for (const name of CANDIDATE_LOOP_DENIED_FRG_ENV) {
    assert.equal(sanitized[name], undefined, `${name} must be absent`);
    assert.equal(Object.hasOwn(sanitized, name), false, `${name} must be deleted`);
  }
  assert.equal(sanitized.PATH, "/usr/bin");
  assert.equal(sanitized.PIPELINE_BIN, "/opt/pipeline");
  assert.equal(dirtyFrgSigningEnv().PIPELINE_FRG_ATTESTATION_KEY, "production-attestor-secret");
});

test("dispatch spawn strips FRG signing vars from the candidate loop environment", async () => {
  const captured: { env?: NodeJS.ProcessEnv; command?: string; args?: readonly string[] } = {};
  const files = new Map<string, string>();
  const persistCtx = {
    repoDir: "/repo",
    workDir: "/tmp/frg-work-env-dispatch",
    request: baseRequest(),
    pack: packWithTemplates(),
    packRunId: "pack-1340-env",
    frgRunId: "frg-env",
    requestFingerprint: factoryReleaseRequestFingerprint(baseRequest()),
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
    now: () => new Date("2026-08-10T12:00:00Z"),
  };
  await productionDispatchPackLoop(
    {
      repoDir: "/repo",
      request: baseRequest(),
      pack: packWithTemplates(),
      packRunId: "pack-1340-env",
      issue_numbers: [101, 102],
      engineTrack: "candidate",
      label: "factory-gate",
      persistCtx,
      candidateInvocation: testInvocation("loop-env-dispatch"),
    },
    {
      fileExists: () => true,
      initBoundLoop: async () => ({ loop_run_id: "loop-env-dispatch" }),
      spawnCandidateLoop: (args) =>
        defaultSpawnCandidateLoop(
          { ...args, candidateInvocation: args.candidateInvocation, requestCandidateSha: CANDIDATE },
          {
            ...spawnDepsForHandoff("loop-env-dispatch", captured),
            env: dirtyFrgSigningEnv(),
          },
        ),
    },
  );
  assert.ok(captured.env, "dispatch must pass an explicit child env");
  for (const name of CANDIDATE_LOOP_DENIED_FRG_ENV) {
    assert.equal(captured.env![name], undefined, `${name} must not reach dispatch child`);
    assert.equal(Object.hasOwn(captured.env!, name), false);
  }
  assert.equal(captured.env!.PATH, "/usr/bin");
  assert.equal(captured.command, CANDIDATE_LAUNCHER);
  assert.notEqual(captured.command, PIN_LAUNCHER);
  assert.notEqual(captured.command, "pipeline");
  assert.deepEqual(captured.args, [
    "loop",
    "--resume",
    "loop-env-dispatch",
    "--engine-track",
    "candidate",
    "--profile",
    "claude",
  ]);
  assert.notEqual(captured.stdio, "ignore");
});

test("resume spawn strips FRG signing vars from the candidate loop environment", async () => {
  const captured: { env?: NodeJS.ProcessEnv; command?: string; args?: readonly string[] } = {};
  await defaultResumeBoundPackLoop(
    {
      repoDir: "/repo",
      loop_run_id: "loop-env-resume",
      candidateInvocation: testInvocation("loop-env-resume"),
      requestCandidateSha: CANDIDATE,
    },
    {
      ...spawnDepsForHandoff("loop-env-resume", captured),
      env: dirtyFrgSigningEnv(),
    },
  );
  assert.ok(captured.env, "resume must pass an explicit child env");
  for (const name of CANDIDATE_LOOP_DENIED_FRG_ENV) {
    assert.equal(captured.env![name], undefined, `${name} must not reach resume child`);
    assert.equal(Object.hasOwn(captured.env!, name), false);
  }
  assert.equal(captured.env!.HOME, "/home/wrapper");
  assert.equal(captured.command, CANDIDATE_LAUNCHER);
  assert.notEqual(captured.command, PIN_LAUNCHER);
  assert.deepEqual(captured.args, [
    "loop",
    "--resume",
    "loop-env-resume",
    "--engine-track",
    "candidate",
    "--profile",
    "claude",
  ]);
});

test("pack-loop spawn execs the candidate launcher, not PATH pipeline, when PIPELINE_BIN is unset (#1296)", async () => {
  const captured: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv; stdio?: unknown } = {};
  const invocation = freezeCandidateInvocation({
    executable: CANDIDATE_LAUNCHER,
    loopRunId: "loop-mixed-binary",
    candidateSha: CANDIDATE,
  });
  assert.equal(invocation.argv.includes("--engine-track"), true);
  const result = await defaultSpawnCandidateLoop(
    {
      repoDir: "/repo",
      loop_run_id: "loop-mixed-binary",
      candidateInvocation: invocation,
      requestCandidateSha: CANDIDATE,
    },
    {
      ...spawnDepsForHandoff("loop-mixed-binary", captured),
      env: { PATH: "/usr/bin", HOME: "/home/wrapper" },
    },
  );
  assert.equal(captured.command, CANDIDATE_LAUNCHER);
  assert.notEqual(captured.command, "pipeline");
  assert.notEqual(captured.command, PIN_LAUNCHER);
  assert.equal(captured.env?.PIPELINE_BIN, undefined);
  assert.equal(result.dispatch_state, "dispatched");
  assert.notEqual(captured.stdio, "ignore");
});

test("missing candidate invocation fails closed and does not exec PATH pipeline", async () => {
  await assert.rejects(
    () =>
      defaultSpawnCandidateLoop(
        { repoDir: "/repo", loop_run_id: "loop-missing-inv" },
        { env: { PIPELINE_BIN: PIN_LAUNCHER }, fileExists: () => true },
      ),
    /missing typed candidate invocation/,
  );
});

test("pre-handoff child exit 1 persists failed and surfaces stderr", async () => {
  const captured: { command?: string } = {};
  const childFactory = (
    command: string,
    _args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    captured.command = command;
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    };
    child.unref = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 99;
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.emit(
        "data",
        'recovery policy for "workflow-engine-defect" names a recipe outside the permitted recovery-recipe catalogue\n',
      );
      child.emit("exit", 1);
    });
    return child;
  };
  let wrote: { path?: string; body?: string; mode?: number } = {};
  let clock = Date.parse("2026-08-29T00:00:01.000Z");
  const result = await defaultSpawnCandidateLoop(
    {
      repoDir: "/repo",
      loop_run_id: "loop-pre-handoff",
      candidateInvocation: testInvocation("loop-pre-handoff"),
      requestCandidateSha: CANDIDATE,
    },
    {
      spawn: childFactory as never,
      env: { PATH: "/usr/bin" },
      fileExists: () => true,
      readHandoff: async () => null,
      readSupervisor: async () => null,
      sleep: async () => {
        clock += 50;
      },
      now: () => new Date(clock),
      observationMs: 1_000,
      storeRunDir: "/state/runs/loop-pre-handoff",
      writeFile: async (p, body, mode) => {
        wrote = { path: p, body, mode };
      },
      evidencePath: "/state/runs/loop-pre-handoff/pack-loop-stderr.txt",
    },
  );
  assert.equal(result.dispatch_state, "failed");
  assert.match(result.last_error ?? "", /pack-loop child exit 1/);
  assert.match(result.last_error ?? "", /recovery-recipe catalogue/);
  assert.match(result.last_error ?? "", /evidence:/);
  assert.equal(wrote.mode, 0o600);
  assert.equal(captured.command, CANDIDATE_LAUNCHER);
});

test("OS spawn throw leaves dispatch_state bound", async () => {
  const result = await defaultSpawnCandidateLoop(
    {
      repoDir: "/repo",
      loop_run_id: "loop-enoent",
      candidateInvocation: testInvocation("loop-enoent"),
      requestCandidateSha: CANDIDATE,
    },
    {
      spawn: () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
      fileExists: () => true,
      env: {},
    },
  );
  assert.equal(result.dispatch_state, "bound");
  assert.match(result.last_error ?? "", /ENOENT/);
});

test("handoff SHA mismatch fails closed", async () => {
  const captured: { command?: string } = {};
  const result = await defaultSpawnCandidateLoop(
    {
      repoDir: "/repo",
      loop_run_id: "loop-sha-mismatch",
      candidateInvocation: testInvocation("loop-sha-mismatch"),
      requestCandidateSha: CANDIDATE,
    },
    {
      ...spawnDepsForHandoff("loop-sha-mismatch", captured),
      readHandoff: async () => validHandoff("loop-sha-mismatch", "f".repeat(40)),
    },
  );
  assert.equal(result.dispatch_state, "failed");
  assert.match(result.last_error ?? "", /handoff_mismatch|candidate_sha/);
});

test("malformed handoff stops a still-running child before return", async () => {
  const captured: {
    killed?: NodeJS.Signals | number;
    unrefed: boolean;
    pipesDestroyed: number;
  } = { unrefed: false, pipesDestroyed: 0 };
  const childFactory = (
    _command: string,
    _args: readonly string[],
    _options: { env?: NodeJS.ProcessEnv },
  ) => {
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      kill: (signal?: NodeJS.Signals | number) => boolean;
      stdout: EventEmitter & { destroy: () => void };
      stderr: EventEmitter & { destroy: () => void };
      pid: number;
    };
    child.unref = () => {
      captured.unrefed = true;
    };
    child.kill = (signal) => {
      captured.killed = signal ?? "SIGTERM";
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    };
    child.stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
    child.stderr = new EventEmitter() as EventEmitter & { destroy: () => void };
    child.stdout.destroy = () => {
      captured.pipesDestroyed += 1;
    };
    child.stderr.destroy = () => {
      captured.pipesDestroyed += 1;
    };
    child.pid = 77;
    queueMicrotask(() => {
      child.emit("spawn");
      child.stderr.emit("data", "handoff identity mismatch from child\n");
    });
    return child;
  };
  const result = await defaultSpawnCandidateLoop(
    {
      repoDir: "/repo",
      loop_run_id: "loop-malformed-running",
      candidateInvocation: testInvocation("loop-malformed-running"),
      requestCandidateSha: CANDIDATE,
    },
    {
      spawn: childFactory as never,
      env: { PATH: "/usr/bin" },
      fileExists: () => true,
      readHandoff: async () => validHandoff("loop-malformed-running", "f".repeat(40)),
      readSupervisor: async () => validHandoff("loop-malformed-running").supervisor,
      realpath: (p: string) => p,
      storeRunDir: "/state/runs/loop-malformed-running",
      sleep: async () => {},
      now: () => new Date("2026-08-29T00:00:01.000Z"),
    },
  );
  assert.equal(result.dispatch_state, "failed");
  assert.match(result.last_error ?? "", /handoff_mismatch|candidate_sha/);
  assert.equal(captured.killed, "SIGTERM");
  assert.equal(captured.unrefed, true);
  assert.equal(captured.pipesDestroyed, 2);
});

test("resume OS accept persists starting so a later invoke does not spawn a second child", async () => {
  const files = new Map<string, string>();
  const request = baseRequest();
  const workDir = "/tmp/frg-work-resume-os-accept";
  const loopRunId = "loop-resume-os-accept";
  const fingerprint = factoryReleaseRequestFingerprint(request);
  const packRunId = `pack-${request.target_version.replace(/\./g, "")}-${request.action_id}`.slice(
    0,
    200,
  );
  const invocation = testInvocation(loopRunId);
  const bindingPath = factoryReleaseLoopBindingPath(loopRunId);
  files.set(
    bindingPath,
    JSON.stringify({
      schema_version: 1,
      kind: "factory_release_loop_binding",
      request_fingerprint: fingerprint,
      target_version: request.target_version,
      candidate_git_sha: CANDIDATE,
      pack_id: "factory-gate-v1",
      manifest_sha256: MANIFEST_SHA,
      pack_run_id: packRunId,
      frg_run_id: "frg-resume-os-accept",
      loop_run_id: loopRunId,
      dispatch_state: "dispatched",
      candidate_invocation: {
        executable: invocation.executable,
        argv: [...invocation.argv],
        candidateSha: invocation.candidateSha,
      },
    }),
  );
  files.set(
    factoryReleasePackInstancePath(workDir),
    JSON.stringify({
      schema_version: 1,
      kind: "factory_release_pack_instance",
      request_fingerprint: fingerprint,
      target_version: request.target_version,
      candidate_git_sha: CANDIDATE,
      pack_id: "factory-gate-v1",
      manifest_sha256: MANIFEST_SHA,
      pack_run_id: packRunId,
      frg_run_id: "frg-resume-os-accept",
      loop_run_id: loopRunId,
      created_at: "2026-08-10T12:00:00Z",
      updated_at: "2026-08-10T12:00:00Z",
    }),
  );
  const fsOps = {
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
  };
  let spawnCount = 0;
  const spawnResumeChild = () => {
    spawnCount += 1;
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    };
    child.unref = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 5150;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const deadPid = {
    schema_version: 1 as const,
    kind: "pack_loop_liveness" as const,
    loop_run_id: loopRunId,
    status: "not-live" as const,
    reason: "dead_pid" as const,
    observed_at: "2026-08-10T12:00:00Z",
  };
  const first = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      probePackLoopLiveness: async () => deadPid,
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues during resume");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      spawnDeps: {
        spawn: spawnResumeChild as never,
        fileExists: () => true,
        readHandoff: async () => null,
        readSupervisor: async () => null,
        sleep: async () => {},
        observationMs: 30_000,
        onAccepted: async () => {
          throw new Error("simulated parent crash after OS accept");
        },
      },
    },
  );
  assert.equal(first.defect_class, "pack_loop_start_failed");
  assert.match(first.message ?? "", /simulated parent crash after OS accept/);
  assert.equal(spawnCount, 1);
  const afterAccept = JSON.parse(files.get(bindingPath)!);
  assert.equal(afterAccept.dispatch_state, "starting");
  assert.equal(afterAccept.resume_count, 1);
  assert.equal(typeof afterAccept.observation_deadline, "string");
  assert.equal(afterAccept.spawn_attempt.pid, 5150);

  const second = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      probePackLoopLiveness: async () => ({
        ...deadPid,
        status: "unknown" as const,
        reason: "no_handoff" as const,
      }),
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues while observing starting");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      spawnDeps: {
        spawn: spawnResumeChild as never,
        fileExists: () => true,
      },
    },
  );
  assert.equal(second.in_progress, true);
  assert.equal(second.loop_run_id, loopRunId);
  assert.equal(spawnCount, 1, "in-window starting must not spawn a second child");
  assert.equal(JSON.parse(files.get(bindingPath)!).dispatch_state, "starting");
});

function seedLoopBinding(files: Map<string, string>, over: {
  loopRunId: string;
  workDir: string;
  dispatch_state: "bound" | "starting" | "dispatched";
  observation_deadline?: string;
  resume_count?: number;
}) {
  const request = baseRequest();
  const fingerprint = factoryReleaseRequestFingerprint(request);
  const packRunId = `pack-${request.target_version.replace(/\./g, "")}-${request.action_id}`.slice(
    0,
    200,
  );
  const invocation = testInvocation(over.loopRunId);
  const bindingPath = factoryReleaseLoopBindingPath(over.loopRunId);
  const binding: Record<string, unknown> = {
    schema_version: 1,
    kind: "factory_release_loop_binding",
    request_fingerprint: fingerprint,
    target_version: request.target_version,
    candidate_git_sha: CANDIDATE,
    pack_id: "factory-gate-v1",
    manifest_sha256: MANIFEST_SHA,
    pack_run_id: packRunId,
    frg_run_id: "frg-seed",
    loop_run_id: over.loopRunId,
    dispatch_state: over.dispatch_state,
    candidate_invocation: {
      executable: invocation.executable,
      argv: [...invocation.argv],
      candidateSha: invocation.candidateSha,
    },
  };
  if (over.observation_deadline) binding.observation_deadline = over.observation_deadline;
  if (over.resume_count !== undefined) binding.resume_count = over.resume_count;
  files.set(bindingPath, JSON.stringify(binding));
  files.set(
    factoryReleasePackInstancePath(over.workDir),
    JSON.stringify({
      schema_version: 1,
      kind: "factory_release_pack_instance",
      request_fingerprint: fingerprint,
      target_version: request.target_version,
      candidate_git_sha: CANDIDATE,
      pack_id: "factory-gate-v1",
      manifest_sha256: MANIFEST_SHA,
      pack_run_id: packRunId,
      frg_run_id: "frg-seed",
      loop_run_id: over.loopRunId,
      created_at: "2026-08-10T12:00:00Z",
      updated_at: "2026-08-10T12:00:00Z",
    }),
  );
  return { request, bindingPath, invocation };
}

function mapFs(files: Map<string, string>) {
  return {
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
  };
}

test("expired starting adopts a valid durable handoff instead of failing (#1296)", async () => {
  const files = new Map<string, string>();
  const loopRunId = "loop-starting-adopt";
  const workDir = "/tmp/frg-work-starting-adopt";
  const { request, bindingPath } = seedLoopBinding(files, {
    loopRunId,
    workDir,
    dispatch_state: "starting",
    observation_deadline: "2026-08-10T11:59:00Z",
  });
  const fsOps = mapFs(files);
  let resumeCalls = 0;
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      probePackLoopLiveness: async () => ({
        schema_version: 1,
        kind: "pack_loop_liveness",
        loop_run_id: loopRunId,
        status: "live",
        reason: "live",
        observed_at: "2026-08-10T12:00:00Z",
      }),
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues while adopting handoff");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      resumeBoundPackLoop: async () => {
        resumeCalls += 1;
        throw new Error("must not resume while adopting a valid starting handoff");
      },
      spawnDeps: {
        readHandoff: async () => validHandoff(loopRunId),
        readSupervisor: async () => validHandoff(loopRunId).supervisor,
        storeRunDir: `/state/runs/${loopRunId}`,
        realpath: (p: string) => p,
      },
    },
  );
  assert.equal(result.in_progress, true);
  assert.equal(result.loop_run_id, loopRunId);
  assert.equal(resumeCalls, 0);
  assert.equal(JSON.parse(files.get(bindingPath)!).dispatch_state, "dispatched");
});

test("malformed starting handoff fails closed before the deadline (#1296)", async () => {
  const files = new Map<string, string>();
  const loopRunId = "loop-starting-malformed";
  const workDir = "/tmp/frg-work-starting-malformed";
  const { request, bindingPath } = seedLoopBinding(files, {
    loopRunId,
    workDir,
    dispatch_state: "starting",
    observation_deadline: "2026-08-10T12:00:30Z",
  });
  const fsOps = mapFs(files);
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues on malformed handoff");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      resumeBoundPackLoop: async () => {
        throw new Error("must not resume a malformed starting handoff");
      },
      spawnDeps: {
        readHandoff: async () => validHandoff(loopRunId, "f".repeat(40)),
        readSupervisor: async () => validHandoff(loopRunId).supervisor,
        storeRunDir: `/state/runs/${loopRunId}`,
        realpath: (p: string) => p,
      },
    },
  );
  assert.equal(result.in_progress, undefined);
  assert.equal(result.defect_class, "pack_loop_start_failed");
  assert.match(result.message ?? "", /candidate_sha mismatch|handoff/);
  assert.equal(JSON.parse(files.get(bindingPath)!).dispatch_state, "failed");
});

test("stale heartbeat with an alive pid does not authorize resume (#1296)", async () => {
  const files = new Map<string, string>();
  const loopRunId = "loop-stale-heartbeat";
  const workDir = "/tmp/frg-work-stale-heartbeat";
  const { request, bindingPath } = seedLoopBinding(files, {
    loopRunId,
    workDir,
    dispatch_state: "dispatched",
    resume_count: 0,
  });
  const fsOps = mapFs(files);
  let resumeCalls = 0;
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      probePackLoopLiveness: async () => ({
        schema_version: 1,
        kind: "pack_loop_liveness",
        loop_run_id: loopRunId,
        status: "not-live",
        reason: "stale_heartbeat",
        observed_at: "2026-08-10T12:00:00Z",
      }),
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues on stale heartbeat");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      resumeBoundPackLoop: async () => {
        resumeCalls += 1;
        throw new Error("stale heartbeat must not spawn a replacement");
      },
    },
  );
  assert.equal(result.in_progress, true);
  assert.equal(result.loop_run_id, loopRunId);
  assert.equal(result.liveness?.reason, "stale_heartbeat");
  assert.equal(resumeCalls, 0);
  const binding = JSON.parse(files.get(bindingPath)!);
  assert.equal(binding.dispatch_state, "dispatched");
  assert.equal(binding.resume_count, 0);
});

test("missing heartbeat does not authorize resume (#1296)", async () => {
  const files = new Map<string, string>();
  const loopRunId = "loop-missing-heartbeat";
  const workDir = "/tmp/frg-work-missing-heartbeat";
  const { request, bindingPath } = seedLoopBinding(files, {
    loopRunId,
    workDir,
    dispatch_state: "dispatched",
    resume_count: 0,
  });
  const fsOps = mapFs(files);
  let resumeCalls = 0;
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      probePackLoopLiveness: async () => ({
        schema_version: 1,
        kind: "pack_loop_liveness",
        loop_run_id: loopRunId,
        status: "not-live",
        reason: "missing_heartbeat",
        observed_at: "2026-08-10T12:00:00Z",
      }),
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues on missing heartbeat");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      resumeBoundPackLoop: async () => {
        resumeCalls += 1;
        throw new Error("missing heartbeat must not spawn a replacement");
      },
    },
  );
  assert.equal(result.in_progress, true);
  assert.equal(result.liveness?.reason, "missing_heartbeat");
  assert.equal(resumeCalls, 0);
  const binding = JSON.parse(files.get(bindingPath)!);
  assert.equal(binding.dispatch_state, "dispatched");
  assert.equal(binding.resume_count, 0);
});

test("void spawnCandidateLoop does not persist dispatched (#1296)", async () => {
  const files = new Map<string, string>();
  const persistCtx = {
    repoDir: "/repo",
    workDir: "/tmp/frg-work-void-spawn",
    request: baseRequest(),
    pack: packWithTemplates(),
    packRunId: "pack-1340-void-spawn",
    frgRunId: "frg-void-spawn",
    requestFingerprint: factoryReleaseRequestFingerprint(baseRequest()),
    writeFile: async (p: string, body: string) => {
      files.set(p, body);
    },
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    fileExists: async (p: string) => files.has(p),
    now: () => new Date("2026-08-10T12:00:00Z"),
  };
  await assert.rejects(
    () =>
      productionDispatchPackLoop(
        {
          repoDir: "/repo",
          request: baseRequest(),
          pack: packWithTemplates(),
          packRunId: "pack-1340-void-spawn",
          issue_numbers: [101, 102],
          engineTrack: "candidate",
          label: "factory-gate",
          persistCtx,
          candidateInvocation: testInvocation("loop-void-spawn"),
        },
        {
          fileExists: () => true,
          initBoundLoop: async () => ({ loop_run_id: "loop-void-spawn" }),
          spawnCandidateLoop: async () => undefined,
        },
      ),
    /no durable handoff acknowledgement/,
  );
  const binding = JSON.parse(files.get(factoryReleaseLoopBindingPath("loop-void-spawn"))!);
  assert.equal(binding.dispatch_state, "bound");
  assert.notEqual(binding.dispatch_state, "dispatched");
});

test("void resumeBoundPackLoop does not persist dispatched (#1296)", async () => {
  const files = new Map<string, string>();
  const loopRunId = "loop-void-resume";
  const workDir = "/tmp/frg-work-void-resume";
  const { request, bindingPath } = seedLoopBinding(files, {
    loopRunId,
    workDir,
    dispatch_state: "bound",
  });
  const fsOps = mapFs(files);
  const result = await generateDurableUnsignedFrg(
    request,
    {
      repoDir: "/repo",
      workDir,
      pack: packWithTemplates(),
      manifestPath: "/pack/factory-gate-v1/manifest.json",
    },
    {
      now: () => new Date("2026-08-10T12:00:00Z"),
      writeFile: fsOps.writeFile,
      mkdir: async () => {},
      readFile: fsOps.readFile,
      fileExists: fsOps.fileExists,
      reconcilePackLoop: async () => boundLoopArtifacts({ loop_run_id: loopRunId }),
      createOrReusePackIssues: async () => {
        throw new Error("must not create pack issues on void resume");
      },
      dispatchPackLoop: async () => {
        throw new Error("must not dispatch a second pack");
      },
      resumeBoundPackLoop: async () => undefined,
    },
  );
  assert.equal(result.in_progress, undefined);
  assert.equal(result.defect_class, "pack_loop_start_failed");
  assert.match(result.message ?? "", /no durable handoff acknowledgement/);
  assert.equal(JSON.parse(files.get(bindingPath)!).dispatch_state, "bound");
});

test("assertCandidateInvocation rejects SHA mismatch", () => {
  const inv = testInvocation("loop-x");
  assert.throws(
    () => assertCandidateInvocation(inv, "c".repeat(40), () => true),
    /does not match the request candidate SHA/,
  );
});

test("formatPackLoopLastError names exit, excerpt, and evidence", () => {
  const msg = formatPackLoopLastError({
    exitCode: 1,
    errorCode: "pre_handoff_exit",
    excerpt: "catalogue",
    evidencePath: "/tmp/err.txt",
  });
  assert.match(msg, /pack-loop child exit 1/);
  assert.match(msg, /catalogue/);
  assert.match(msg, /evidence: \/tmp\/err.txt/);
});

// ---------------------------------------------------------------------------
// #1259: --request must not resolve inside the target checkout
// ---------------------------------------------------------------------------

function realpathThrowsEnoent(): (p: string) => string {
  return (p: string) => {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
}

function realpathMap(map: Record<string, string>): (p: string) => string {
  return (p: string) => {
    if (Object.hasOwn(map, p)) return map[p]!;
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
}

test("isPathInsideCheckout: descendant, checkout root, tmpdir outside, .. escape still inside", () => {
  assert.equal(isPathInsideCheckout("/repo/.agent-pipeline/request.json", "/repo"), true);
  assert.equal(isPathInsideCheckout("/repo", "/repo"), true);
  assert.equal(isPathInsideCheckout("/tmp/factory-release-prepare-request.json", "/repo"), false);
  assert.equal(
    isPathInsideCheckout(
      path.resolve("/repo/../repo/.agent-pipeline/request.json"),
      "/repo",
    ),
    true,
  );
  assert.equal(isPathInsideCheckout("/repo-other/request.json", "/repo"), false);
});

test("resolveRequestPathForContainment: symlink into checkout is canonicalized", () => {
  const resolved = resolveRequestPathForContainment(
    "/tmp/outside-link.json",
    realpathMap({
      "/tmp/outside-link.json": "/repo/.agent-pipeline/request-1.39.13.json",
    }),
  );
  assert.equal(resolved, "/repo/.agent-pipeline/request-1.39.13.json");
  assert.equal(isPathInsideCheckout(resolved, "/repo"), true);
});

test("targetCheckoutsForPrepare includes distinct factory control from env", () => {
  const roots = targetCheckoutsForPrepare({
    repoDir: "/product",
    env: { AGENT_PIPELINE_FACTORY_CONTROL: "/factory-control" },
  });
  assert.deepEqual(roots, ["/product", "/factory-control"]);
});

test("in-checkout --request is refused before pack-loop dispatch (#1259)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/repo/.agent-pipeline/request-1.39.13.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  let startCalls = 0;
  let generateCalls = 0;
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathThrowsEnoent(),
    generateUnsignedFrg: async () => {
      generateCalls += 1;
      throw new Error("must not generate");
    },
    startBoundPackLoop: async () => {
      startCalls += 1;
      return { loop_run_id: "loop-must-not-start" };
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  await assert.rejects(
    () => runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, new RegExp(REQUEST_INSIDE_CHECKOUT_TOKEN));
      assert.match(msg, /request-1\.39\.13\.json/);
      assert.match(msg, /\/repo/);
      assert.match(msg, /\$TMPDIR/);
      assert.match(msg, /AGENT_PIPELINE_STATE_HOME/);
      assert.match(msg, /\$RUN_DIR/);
      return true;
    },
  );
  assert.equal(startCalls, 0, "in-checkout request must not start a pack loop");
  assert.equal(generateCalls, 0, "in-checkout request must not generate unsigned FRG");
});

test("request inside a distinct factory control checkout is refused (#1259)", async () => {
  const mem = memoryFs();
  const requestPath = "/factory-control/.agent-pipeline/request.json";
  await mem.writeFile(requestPath, JSON.stringify(baseRequest()));
  let startCalls = 0;
  const deps = hermeticPrepareDeps({
    env: { AGENT_PIPELINE_FACTORY_CONTROL: "/factory-control" },
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathThrowsEnoent(),
    startBoundPackLoop: async () => {
      startCalls += 1;
      return { loop_run_id: "loop-must-not-start" };
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  await assert.rejects(
    () => runFactoryReleasePrepare({ requestPath, repoDir: "/product" }, deps),
    /request_inside_checkout.*\/factory-control/,
  );
  assert.equal(startCalls, 0);
});

test("gitignored descendant --request is still refused (#1259)", async () => {
  const mem = memoryFs();
  const requestPath = "/repo/.agent-pipeline/frg/request.json";
  await mem.writeFile(requestPath, JSON.stringify(baseRequest()));
  let startCalls = 0;
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathThrowsEnoent(),
    startBoundPackLoop: async () => {
      startCalls += 1;
      return { loop_run_id: "loop-must-not-start" };
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  await assert.rejects(
    () => runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps),
    new RegExp(REQUEST_INSIDE_CHECKOUT_TOKEN),
  );
  assert.equal(startCalls, 0);
});

test("symlink --request into the checkout is refused (#1259)", async () => {
  const mem = memoryFs();
  const requestPath = "/tmp/outside-link.json";
  await mem.writeFile(requestPath, JSON.stringify(baseRequest()));
  let startCalls = 0;
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathMap({
      "/tmp/outside-link.json": "/repo/.agent-pipeline/request.json",
    }),
    startBoundPackLoop: async () => {
      startCalls += 1;
      return { loop_run_id: "loop-must-not-start" };
    },
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  await assert.rejects(
    () => runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps),
    new RegExp(REQUEST_INSIDE_CHECKOUT_TOKEN),
  );
  assert.equal(startCalls, 0);
});

test("off-repo --request under $TMPDIR is not rejected for location (#1259)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/factory-release-prepare-request.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathThrowsEnoent(),
    startBoundPackLoop: async () => ({ loop_run_id: "loop-off-repo" }),
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "in_progress");
});

test("off-repo --request under AGENT_PIPELINE_STATE_HOME is not rejected for location (#1259)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/state/home/factory-release-prepare-request.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const deps = hermeticPrepareDeps({
    env: { AGENT_PIPELINE_STATE_HOME: "/state/home" },
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathThrowsEnoent(),
    startBoundPackLoop: async () => ({ loop_run_id: "loop-state-home" }),
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "in_progress");
});

test("off-repo request dispatch writes only under contract factory-release/ (#1259)", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/factory-release-prepare-request.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const deps = hermeticPrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    realpathSync: realpathThrowsEnoent(),
    startBoundPackLoop: async () => ({ loop_run_id: "loop-clean-dispatch" }),
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.result.status, "in_progress");
  const contractRoot = artifactSubdir("/repo", FACTORY_RELEASE_ARTIFACT);
  assert.equal(FACTORY_RELEASE_ROOT_REL, ".agent-pipeline/factory-release");
  const writtenUnderRepo = [...mem.files.keys()].filter(
    (p) => p === "/repo" || p.startsWith("/repo/"),
  );
  assert.ok(writtenUnderRepo.length > 0, "prepare must persist a checkpoint under the contract dir");
  for (const dest of writtenUnderRepo) {
    assert.ok(
      dest === contractRoot || dest.startsWith(`${contractRoot}/`),
      `prepare left an unignored dest under repoDir: ${dest}`,
    );
  }
  assert.ok(
    !writtenUnderRepo.includes(requestPath),
    "request file must not land under repoDir",
  );
});

test("FACTORY_RELEASE_PREPARE_HELP names the location gate and off-repo dests (#1259)", () => {
  assert.match(FACTORY_RELEASE_PREPARE_HELP, /absolute-off-repo-request\.json/);
  assert.match(FACTORY_RELEASE_PREPARE_HELP, new RegExp(REQUEST_INSIDE_CHECKOUT_TOKEN));
  assert.match(FACTORY_RELEASE_PREPARE_HELP, /outside the target checkout/);
  assert.match(FACTORY_RELEASE_PREPARE_HELP, /\$TMPDIR/);
  assert.match(FACTORY_RELEASE_PREPARE_HELP, /AGENT_PIPELINE_STATE_HOME/);
  assert.match(FACTORY_RELEASE_PREPARE_HELP, /\$RUN_DIR/);
});

test("FRG runbook documents off-repo --request dests (#1259)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const runbook = fs.readFileSync(
    path.join(repoRoot, "docs/factory-reliability-gate-runbook.md"),
    "utf8",
  );
  const ship = fs.readFileSync(
    path.join(repoRoot, "docs/runbooks/ship-milestone.md"),
    "utf8",
  );
  assert.match(runbook, /\$TMPDIR|AGENT_PIPELINE_STATE_HOME|\$RUN_DIR/);
  assert.match(runbook, /outside the target checkout/);
  assert.doesNotMatch(
    runbook,
    /factory-release prepare --request \$REPO_DIR\/\.agent-pipeline\/request\.json/,
  );
  assert.doesNotMatch(
    ship,
    /factory-release prepare --request \$REPO_DIR\/\.agent-pipeline\/request\.json/,
  );
});

test("HMAC from-run latest.json without factory_release_binding is rejected (#1295)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const runIdB = computeAttestorRunId(buildFactoryReleaseUnsignedDigestBinding(request, unsigned));
  assert.notEqual(runIdB, unsigned.frg_run_id);
  const evidence = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: false,
  });
  assert.equal(evidence.pass, true);
  assert.equal(evidence.pack_provenance != null, true);
  assert.equal(evidence.factory_release_binding, undefined);
  assert.equal(verifyFrgAttestation(evidence, FRG_UNIT_TEST_ATTESTATION_KEY), true);

  const mem = memoryFs();
  const latestPath = `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`;
  await mem.writeFile(latestPath, JSON.stringify(evidence));
  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
  );
  assert.notEqual(observed.status, "accepted");
  assert.equal(observed.status, "rejected");
  if (observed.status === "rejected") {
    assert.equal(observed.reason, "missing_factory_release_binding");
    assert.equal(observed.expected_frg_run_id, unsigned.frg_run_id);
    assert.equal(observed.observed_run_id, runIdB);
  }
});

test("HMAC from-run latest.json with binding and pack_provenance is accepted (#1295)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const runIdB = computeAttestorRunId(binding);
  const evidence = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: true,
  });
  assert.equal(evidence.pass, true);
  assert.equal(evidence.pack_provenance != null, true);
  assert.equal(evidence.run_id, runIdB);
  assert.notEqual(evidence.run_id, unsigned.frg_run_id);
  assert.equal(verifyFrgAttestation(evidence, FRG_UNIT_TEST_ATTESTATION_KEY), true);

  const mem = memoryFs();
  const latestPath = `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`;
  await mem.writeFile(latestPath, JSON.stringify(evidence));
  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
    OBSERVE_HMAC,
  );
  assert.equal(observed.status, "accepted");
  if (observed.status === "accepted") {
    assert.equal(observed.attestation.frg_run_id, runIdB);
  }
});

test("observe rejects signed binding C when scored provenance is D (#1295)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const packedD = "d".repeat(40);
  assert.equal(binding.candidate_git_sha, CANDIDATE);
  assert.notEqual(packedD, CANDIDATE);
  const runIdB = computeAttestorRunId(binding);
  const evidence = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: true,
    packCandidateGitSha: packedD,
  });
  assert.equal(evidence.pass, true);
  assert.deepEqual(evidence.factory_release_binding, binding);
  assert.equal(evidence.pack_provenance?.candidate_git_sha, packedD);
  assert.equal(verifyFrgAttestation(evidence, FRG_UNIT_TEST_ATTESTATION_KEY), true);

  const mem = memoryFs();
  const latestPath = `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`;
  await mem.writeFile(latestPath, JSON.stringify(evidence));
  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
    OBSERVE_HMAC,
  );
  assert.equal(observed.status, "rejected");
  if (observed.status === "rejected") {
    assert.equal(observed.reason, "identity_mismatch");
    assert.equal(observed.expected_frg_run_id, unsigned.frg_run_id);
    assert.equal(observed.observed_run_id, runIdB);
  }
});

test("observe rejects factory_release_binding overlay after sign (#1295)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const runIdB = computeAttestorRunId(buildFactoryReleaseUnsignedDigestBinding(request, unsigned));
  const signed = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: false,
  });
  assert.equal(signed.factory_release_binding, undefined);
  assert.equal(verifyFrgAttestation(signed, FRG_UNIT_TEST_ATTESTATION_KEY), true);
  const overlaid = {
    ...signed,
    factory_release_binding: buildFactoryReleaseUnsignedDigestBinding(request, unsigned),
  };
  assert.equal(verifyFrgAttestation(overlaid, FRG_UNIT_TEST_ATTESTATION_KEY), false);

  const mem = memoryFs();
  const latestPath = `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`;
  await mem.writeFile(latestPath, JSON.stringify(overlaid));
  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
    OBSERVE_HMAC,
  );
  assert.notEqual(observed.status, "accepted");
  assert.equal(observed.status, "rejected");
  if (observed.status === "rejected") {
    assert.equal(observed.reason, "hmac_invalid");
    assert.equal(observed.expected_frg_run_id, unsigned.frg_run_id);
    assert.equal(observed.observed_run_id, runIdB);
  }
});

test("notes-only factory_release_binding is rejected (#1295)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const runIdB = computeAttestorRunId(buildFactoryReleaseUnsignedDigestBinding(request, unsigned));
  const evidence = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: false,
    notesBinding: true,
  });
  assert.equal(evidence.factory_release_binding, undefined);
  assert.ok((evidence.notes ?? []).some((n) => n.startsWith("factory_release_binding:")));

  const mem = memoryFs();
  await mem.writeFile(
    `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`,
    JSON.stringify(evidence),
  );
  const observed = await defaultObserveAttestation(
    request,
    unsigned,
    { repoDir: "/repo", workDir: "/tmp/work" },
    (p) => mem.readFile(p),
    (p) => mem.fileExists(p),
  );
  assert.equal(observed.status, "rejected");
  if (observed.status === "rejected") {
    assert.equal(observed.reason, "notes_only_binding");
  }
});

test("prepare completes on accepted bound B and records attested run_id (#1295)", async () => {
  const request = baseRequest();
  const requestPath = "/tmp/req-1295.json";
  const unsigned = unsignedPayload();
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const runIdB = computeAttestorRunId(binding);
  const evidence = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: true,
  });
  const mem = memoryFs();
  await mem.writeFile(requestPath, JSON.stringify(request));
  const latestPath = `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`;
  await mem.writeFile(latestPath, JSON.stringify(evidence));
  const releaseCalls = { n: 0 };
  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    generate: async () => ({ frg: unsigned, structurally_eligible: true }),
    observe: (req, uns, ctx) =>
      defaultObserveAttestation(
        req,
        uns,
        ctx,
        (p) => mem.readFile(p),
        (p) => mem.fileExists(p),
        OBSERVE_HMAC,
      ),
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "complete");
  if (outcome.result.status === "complete") {
    assert.equal(outcome.result.frg.run_id, runIdB);
  }
  assert.equal(releaseCalls.n, 1);
});

test("rejected observe stays awaiting and names A, B, and the miss (#1295)", async () => {
  const request = baseRequest();
  const requestPath = "/tmp/req-1295-reject.json";
  const unsigned = unsignedPayload();
  const runIdB = computeAttestorRunId(buildFactoryReleaseUnsignedDigestBinding(request, unsigned));
  const evidence = await hybridFromRunEvidence({
    request,
    unsigned,
    runId: runIdB,
    includeBinding: false,
  });
  const mem = memoryFs();
  await mem.writeFile(requestPath, JSON.stringify(request));
  await mem.writeFile(
    `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`,
    JSON.stringify(evidence),
  );
  const deps = makeDeps({
    fs: mem,
    generate: async () => ({ frg: unsigned, structurally_eligible: true }),
    observe: (req, uns, ctx) =>
      defaultObserveAttestation(req, uns, ctx, (p) => mem.readFile(p), (p) => mem.fileExists(p)),
    runRelease: async () => {
      throw new Error("must not release on rejected observe");
    },
  });
  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "awaiting_frg_attestation");
  if (outcome.result.status === "awaiting_frg_attestation") {
    assert.equal(outcome.result.observe_miss?.reason, "missing_factory_release_binding");
    assert.equal(outcome.result.observe_miss?.expected_frg_run_id, unsigned.frg_run_id);
    assert.equal(outcome.result.observe_miss?.observed_run_id, runIdB);
  }
});

test("defaultResolveShipPathFromRun loads the closed unsigned checkpoint (#1295)", async () => {
  const request = baseRequest();
  const unsigned = unsignedPayload();
  const fingerprint = factoryReleaseRequestFingerprint(request);
  const mem = memoryFs();
  await mem.writeFile(
    factoryReleaseVersionIndexPath("/repo", request.target_version),
    JSON.stringify({
      schema_version: 1,
      version: request.target_version,
      request_fingerprint: fingerprint,
      candidate_git_sha: request.integrated_candidate.git_sha,
      action_id: request.action_id,
      pack_run_id: unsigned.pack_run_id,
      loop_run_id: unsigned.loop_run_id,
      frg_run_id: unsigned.frg_run_id,
    }),
  );
  await mem.writeFile(
    factoryReleaseCheckpointPath("/repo", fingerprint),
    JSON.stringify({
      schema_version: 1,
      kind: "factory_release_checkpoint_store",
      request_fingerprint: fingerprint,
      phase: "awaiting_frg_attestation",
      request,
      unsigned,
    }),
  );
  await mem.writeFile(
    factoryReleaseLoopBindingPath(unsigned.loop_run_id),
    JSON.stringify({
      schema_version: 1,
      kind: "factory_release_loop_binding",
      candidate_git_sha: request.integrated_candidate.git_sha,
      loop_run_id: unsigned.loop_run_id,
    }),
  );
  const bound = await defaultResolveShipPathFromRun({
    version: request.target_version,
    fromRun: unsigned.loop_run_id,
    repoDir: "/repo",
    readFile: (p) => mem.readFile(p),
  });
  assert.equal(bound.kind, "bound");
  if (bound.kind === "bound") {
    assert.equal(bound.unsigned_frg_run_id, unsigned.frg_run_id);
    assert.equal(
      (bound.binding as { frg_run_id: string }).frg_run_id,
      unsigned.frg_run_id,
    );
  }

  const missing = await defaultResolveShipPathFromRun({
    version: request.target_version,
    fromRun: unsigned.loop_run_id,
    repoDir: "/other",
    requestCandidateGitSha: request.integrated_candidate.git_sha,
    readFile: (p) => mem.readFile(p),
  });
  assert.equal(missing.kind, "fail");
});
