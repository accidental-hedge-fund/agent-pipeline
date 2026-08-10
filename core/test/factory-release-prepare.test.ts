// Unit tests for durable post-pilot factory-release prepare (#953 / #908).
// All I/O is injected — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  compareSemver,
  defaultFactoryReleasePrepareDeps,
  factoryReleaseRequestFingerprint,
  isPostPilotReleaseVersion,
  parseFactoryReleasePrepareRequest,
  rejectForbiddenRequestFields,
  runFactoryReleasePrepare,
  type FactoryReleaseFrgPayload,
  type FactoryReleasePrepareDeps,
  type FactoryReleasePrepareRequest,
  type ObservedAttestation,
  type UnsignedFrgGenerationResult,
} from "../scripts/factory-release-prepare.ts";
import {
  FRG_PACK_MANIFEST,
  FRG_SCENARIO_IDS,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  computeFrgEvidence,
  type FrgEvidence,
} from "../scripts/factory-reliability-gate.ts";
import {
  FRG_HYBRID_PILOT_VERSION,
  type LoadedFrgPack,
} from "../scripts/frg-pack-observations.ts";

const MANIFEST_SHA = "a".repeat(64);
const CANDIDATE = "b".repeat(40);
const ACTION_ID = "action-ship-1.34.0-001";

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

function releaseEligibleEvidence(version = "1.34.0"): FrgEvidence {
  // Build via computeFrgEvidence so fingerprints + attestation match.
  // Post-pilot: no pack_provenance (hybrid is 1.33.0-only).
  const scenarioPass = (id: (typeof FRG_SCENARIO_IDS)[number]) => ({
    id,
    status: "pass" as const,
    detail: "unit",
    observed: id === "capacity-blocked-retain" ? 2 : null,
    threshold: id === "capacity-blocked-retain" ? 2 : null,
  });
  const evidence = computeFrgEvidence({
    version,
    run_id: "frg-134",
    loop_run_id: "loop-134",
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
  });
  assert.equal(evidence.pass, true);
  assert.equal(evidence.pack_provenance, null);
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

function makeDeps(opts: {
  fs: ReturnType<typeof memoryFs>;
  generate?: FactoryReleasePrepareDeps["generateUnsignedFrg"];
  observe?: FactoryReleasePrepareDeps["observeAttestation"];
  runRelease?: FactoryReleasePrepareDeps["runRelease"];
  generateCalls?: { n: number };
  releaseCalls?: { n: number };
}): FactoryReleasePrepareDeps {
  const generateCalls = opts.generateCalls ?? { n: 0 };
  const releaseCalls = opts.releaseCalls ?? { n: 0 };
  return defaultFactoryReleasePrepareDeps({
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
  const evidence = releaseEligibleEvidence();
  let attested = false;

  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    generateCalls,
    observe: async () => {
      if (!attested) return null;
      return {
        frg_run_id: "frg-134",
        evidence_path: "/repo/.agent-pipeline/frg/1.34.0/frg-134/evidence.json",
        evidence_sha256: crypto.createHash("sha256").update("e").digest("hex"),
        latest_path: "/repo/.agent-pipeline/frg/1.34.0/latest.json",
        latest_sha256: crypto.createHash("sha256").update("e").digest("hex"),
        evidence,
      } satisfies ObservedAttestation;
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
  assert.equal(second.result.frg.run_id, "frg-134");
  assert.equal(releaseCalls.n, 1);
  // Idempotent: generate only once across both calls
  assert.equal(generateCalls.n, 1);
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
  const evidence = releaseEligibleEvidence();
  const deps = makeDeps({
    fs: mem,
    releaseCalls,
    generateCalls,
    observe: async () => ({
      frg_run_id: "frg-134",
      evidence_path: "/repo/e.json",
      evidence_sha256: "e".repeat(64),
      latest_path: "/repo/l.json",
      latest_sha256: "e".repeat(64),
      evidence,
    }),
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

test("stale foreign evidence (wrong frg_run_id) is refused at attestation", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  const evidence = releaseEligibleEvidence();
  // Mutate run id so binding fails
  (evidence as { run_id: string }).run_id = "frg-FOREIGN";
  const deps = makeDeps({
    fs: mem,
    observe: async () => ({
      frg_run_id: "frg-FOREIGN",
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

test("default generateUnsigned refuses synthetic trivial pack as release-eligible", async () => {
  const mem = memoryFs();
  const request = baseRequest();
  const requestPath = "/tmp/req-134.json";
  await mem.writeFile(requestPath, JSON.stringify(request));
  // Use default generator (refuseSyntheticTrivialPack)
  const deps = defaultFactoryReleasePrepareDeps({
    env: {},
    now: () => new Date("2026-08-10T12:00:00Z"),
    readRequestText: (p) => mem.readRequestText(p),
    readFile: (p) => mem.readFile(p),
    writeFile: (p, body) => mem.writeFile(p, body),
    mkdir: async () => {},
    fileExists: (p) => mem.fileExists(p),
    loadPack: async () => fakePack(),
    // leave generateUnsignedFrg as default refuse
    observeAttestation: async () => null,
    runRelease: async () => {
      throw new Error("must not release");
    },
  });

  const outcome = await runFactoryReleasePrepare({ requestPath, repoDir: "/repo" }, deps);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.status, "failed");
  if (outcome.result.status === "failed") {
    // Default durable generator fails closed without a factory-gate loop;
    // it never invents a synthetic trivial pack pass.
    assert.match(outcome.result.message, /factory-gate|Synthetic trivial|not release-eligible/i);
    assert.ok(
      ["missing_generator", "pack_loop_missing", "probe_failed", "frg_not_eligible"].includes(
        outcome.result.defect_class,
      ),
      `unexpected defect_class ${outcome.result.defect_class}`,
    );
    assert.notEqual(outcome.result.defect_class, "complete");
  }
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
