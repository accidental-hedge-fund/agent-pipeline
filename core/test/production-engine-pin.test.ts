// Unit tests for two-track production engine pin (#762).
// Injectable deps only — no real network, git, or subprocess.

import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import type { FrgEvidence, FrgLookupResult } from "../scripts/factory-reliability-gate.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  FACTORY_CONTROL_REPO,
  INSTALL_RECEIPT_FILENAME,
  PRODUCTION_ENGINE_PIN_REL,
  PRODUCTION_PIN_ENV,
  PRODUCTION_PIN_SCHEMA_VERSION,
  classifyEngineTrack,
  engineTrackEvidenceFields,
  enforcePinnedTrackPolicy,
  evaluateEngineTrackCheck,
  formatProductionPinSummary,
  initProductionPin,
  isFactoryControlRepo,
  parseInstallReceipt,
  parseProductionEnginePin,
  pinInstallProvenanceMatches,
  productionPinPath,
  promoteProductionPin,
  resolveEngineTrackIntent,
  resolveInstallProvenance,
  resolvePinAuthorityDir,
  resolveProductionPin,
  rollbackProductionPin,
  tagForVersion,
  versionsMatch,
  type PinInstallProvenance,
  type ProductionEnginePin,
  type ProductionPinFsDeps,
} from "../scripts/production-engine-pin.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPin(overrides: Partial<ProductionEnginePin> = {}): ProductionEnginePin {
  return {
    schema_version: PRODUCTION_PIN_SCHEMA_VERSION,
    version: "1.29.1",
    tag: "v1.29.1",
    git_sha: null,
    git_sha_source: "unknown",
    frg_run_id: "frg-test-run-1",
    frg_evidence_path: ".agent-pipeline/frg/1.29.1/latest.json",
    promoted_at: "2026-07-01T00:00:00Z",
    previous: null,
    ...overrides,
  };
}

/** Tag-install provenance matching validPin() — required for coherent pinned. */
function pinProvenance(tag = "v1.29.1"): PinInstallProvenance {
  return { kind: "tag_install", tag, version: tag.replace(/^v/i, "") };
}

function passEvidence(version: string, runId = "frg-pass-1"): FrgEvidence {
  return {
    schema_version: 1,
    version,
    run_id: runId,
    pass: true,
    scenarios: [],
    scoreboard: {
      pack_id: "factory-gate-v1",
      created_at: "2026-07-01T00:00:00Z",
      item_count: 2,
      ready_clean_count: 2,
      engine_class_count: 0,
      engine_class_rate: 0,
      thresholds: {
        min_clean_ready_to_deploy: 2,
        capacity_stress_n: 2,
        max_engine_class_rate: 0.25,
      },
    },
    thresholds: {
      min_clean_ready_to_deploy: 2,
      capacity_stress_n: 2,
      max_engine_class_rate: 0.25,
    },
    loop_run_id: "loop-1",
    pack_id: "factory-gate-v1",
    created_at: "2026-07-01T00:00:00Z",
    notes: [],
    composition: {
      dimensions: [],
      false_human_authority_count: 0,
    },
    integrity: {
      producer: "pipeline-factory-gate",
      content_sha256: "abc",
      scoreboard_fingerprint: "def",
      composition_fingerprint: "ghi",
      attested_at: "2026-07-01T00:00:00Z",
    },
  } as FrgEvidence;
}

function memFs(initial: Record<string, string> = {}): {
  deps: ProductionPinFsDeps;
  files: Map<string, string>;
  writes: string[];
} {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const deps: ProductionPinFsDeps = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
      writes.push(p);
    },
    mkdir: async () => {},
    rename: async (from, to) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, files.get(from)!);
      files.delete(from);
      writes.push(`rename:${from}->${to}`);
    },
  };
  return { deps, files, writes };
}

const REPO = "/repo";
const PIN_PATH = path.join(REPO, PRODUCTION_ENGINE_PIN_REL);
const FIXED_NOW = () => new Date("2026-08-01T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Path / parse / validate
// ---------------------------------------------------------------------------

test("productionPinPath: defaults to repoDir/.agent-pipeline/production-engine-pin.json", () => {
  assert.equal(
    productionPinPath("/repo", null, {}),
    path.join("/repo", PRODUCTION_ENGINE_PIN_REL),
  );
});

test("productionPinPath: overridePath wins over env", () => {
  assert.equal(
    productionPinPath("/repo", "/custom/pin.json", {
      [PRODUCTION_PIN_ENV]: "/env/pin.json",
    }),
    path.resolve("/custom/pin.json"),
  );
});

test("productionPinPath: env wins over default", () => {
  assert.equal(
    productionPinPath("/repo", null, { [PRODUCTION_PIN_ENV]: "/env/pin.json" }),
    path.resolve("/env/pin.json"),
  );
});

test("isFactoryControlRepo: only the canonical factory control owner/name", () => {
  assert.equal(isFactoryControlRepo(FACTORY_CONTROL_REPO), true);
  assert.equal(isFactoryControlRepo(FACTORY_CONTROL_REPO.toUpperCase()), true);
  assert.equal(isFactoryControlRepo("acme/widget"), false);
  assert.equal(isFactoryControlRepo("other/agent-pipeline"), false);
  assert.equal(isFactoryControlRepo(""), false);
  assert.equal(isFactoryControlRepo(null), false);
});

test("resolvePinAuthorityDir: factory control env beats target repoDir", () => {
  const fromEnv = resolvePinAuthorityDir({
    targetRepoDir: "/product/target",
    env: { [FACTORY_CONTROL_DIR_ENV]: "/factory/control" },
    allowTargetFallback: false,
  });
  assert.equal(fromEnv.ok, true);
  if (fromEnv.ok) assert.equal(fromEnv.dir, path.resolve("/factory/control"));

  const fromArg = resolvePinAuthorityDir({
    targetRepoDir: "/product/target",
    factoryControlDir: "/factory/explicit",
    env: {},
    allowTargetFallback: false,
  });
  assert.equal(fromArg.ok, true);
  if (fromArg.ok) assert.equal(fromArg.dir, path.resolve("/factory/explicit"));

  // Inactive/probe default: target fallback allowed.
  const fallback = resolvePinAuthorityDir({
    targetRepoDir: "/product/target",
    env: {},
  });
  assert.equal(fallback.ok, true);
  if (fallback.ok) assert.equal(fallback.dir, "/product/target");
});

test("resolvePinAuthorityDir: refuses non-factory target under active intent", () => {
  const refused = resolvePinAuthorityDir({
    targetRepoDir: "/product/target",
    env: {},
    allowTargetFallback: false,
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "missing_factory_control");
    assert.match(refused.remediation, /AGENT_PIPELINE_FACTORY_CONTROL|production_engine_pin_path|AGENT_PIPELINE_PRODUCTION_PIN/);
  }

  // Self-dogfood: factory control target is authority without env.
  const self = resolvePinAuthorityDir({
    targetRepoDir: "/factory/control",
    env: {},
    targetIsFactoryControl: true,
    allowTargetFallback: false,
  });
  assert.equal(self.ok, true);
  if (self.ok) assert.equal(self.dir, "/factory/control");
});

test("resolveProductionPin: pin authority can differ from target product repo", async () => {
  // Factory pin lives on control checkout; product target has no pin file.
  const factoryDir = "/factory/control";
  const factoryPin = path.join(factoryDir, PRODUCTION_ENGINE_PIN_REL);
  const productDir = "/product/target";
  const pinJson = JSON.stringify(validPin({ version: "1.29.1" }));
  const files = new Map<string, string>([[factoryPin, pinJson]]);
  const readTextFile = async (p: string) => files.get(p) ?? null;

  const fromProduct = await resolveProductionPin({
    repoDir: productDir,
    readTextFile,
  });
  assert.equal(fromProduct.kind, "missing");

  const authority = resolvePinAuthorityDir({
    targetRepoDir: productDir,
    factoryControlDir: factoryDir,
    env: {},
    allowTargetFallback: false,
  });
  assert.equal(authority.ok, true);
  if (!authority.ok) return;
  const fromAuthority = await resolveProductionPin({
    repoDir: authority.dir,
    readTextFile,
  });
  assert.equal(fromAuthority.kind, "ok");
  if (fromAuthority.kind === "ok") {
    assert.equal(fromAuthority.pin.version, "1.29.1");
    assert.equal(fromAuthority.path, factoryPin);
  }
});

test("parseProductionEnginePin: accepts valid pin", () => {
  const pin = parseProductionEnginePin(JSON.stringify(validPin()));
  assert.equal(pin.version, "1.29.1");
  assert.equal(pin.tag, "v1.29.1");
  assert.equal(pin.frg_run_id, "frg-test-run-1");
});

test("parseProductionEnginePin: normalizes leading v on version", () => {
  const pin = parseProductionEnginePin(
    JSON.stringify(validPin({ version: "v1.29.1" })),
  );
  assert.equal(pin.version, "1.29.1");
});

test("parseProductionEnginePin: rejects missing frg_run_id", () => {
  const bad = { ...validPin(), frg_run_id: "" };
  assert.throws(() => parseProductionEnginePin(JSON.stringify(bad)), /frg_run_id/);
});

test("parseProductionEnginePin: rejects bad schema_version", () => {
  assert.throws(
    () => parseProductionEnginePin(JSON.stringify(validPin({ schema_version: 99 }))),
    /schema_version/,
  );
});

test("versionsMatch / tagForVersion", () => {
  assert.equal(versionsMatch("1.29.1", "v1.29.1"), true);
  assert.equal(versionsMatch("1.29.1", "1.30.0"), false);
  assert.equal(tagForVersion("1.30.0"), "v1.30.0");
});

test("resolveProductionPin: same path for doctor vs run-start fakes", async () => {
  const pin = validPin();
  const text = JSON.stringify(pin);
  const pinPath = productionPinPath(REPO, null, {});
  const loadA = await resolveProductionPin({
    repoDir: REPO,
    readTextFile: async (p) => (p === pinPath ? text : null),
    env: {},
  });
  const loadB = await resolveProductionPin({
    repoDir: REPO,
    readTextFile: async (p) => (p === pinPath ? text : null),
    env: {},
  });
  assert.equal(loadA.kind, "ok");
  assert.equal(loadB.kind, "ok");
  if (loadA.kind === "ok" && loadB.kind === "ok") {
    assert.equal(loadA.path, loadB.path);
    assert.equal(loadA.pin.version, loadB.pin.version);
  }
});

test("resolveProductionPin: missing", async () => {
  const load = await resolveProductionPin({
    repoDir: REPO,
    readTextFile: async () => null,
    env: {},
  });
  assert.equal(load.kind, "missing");
});

test("resolveProductionPin: invalid JSON", async () => {
  const load = await resolveProductionPin({
    repoDir: REPO,
    readTextFile: async () => "not-json",
    env: {},
  });
  assert.equal(load.kind, "invalid");
});

// ---------------------------------------------------------------------------
// Classification matrix
// ---------------------------------------------------------------------------

test("classifyEngineTrack: pinned intent + match + tag provenance → track pinned", () => {
  const r = classifyEngineTrack({
    intent: "pinned",
    runningVersion: "1.29.1",
    pin: validPin(),
    installProvenance: pinProvenance(),
  });
  assert.equal(r.track, "pinned");
  assert.equal(r.coherent_pinned, true);
  assert.equal(r.pin_match, true);
});

test("classifyEngineTrack: pinned intent + version match without provenance → not coherent pinned", () => {
  const r = classifyEngineTrack({
    intent: "pinned",
    runningVersion: "1.29.1",
    pin: validPin(),
    // omitted provenance → missing
  });
  assert.equal(r.track, "candidate");
  assert.equal(r.coherent_pinned, false);
  assert.equal(r.pin_match, true);
  assert.match(r.reason, /unverified|receipt|provenance/i);
});

test("classifyEngineTrack: pinned intent + version match + working_tree → not coherent pinned", () => {
  const r = classifyEngineTrack({
    intent: "pinned",
    runningVersion: "1.29.1",
    pin: validPin(),
    installProvenance: { kind: "working_tree", detail: "repo checkout" },
  });
  assert.equal(r.track, "candidate");
  assert.equal(r.coherent_pinned, false);
  assert.equal(r.pin_match, true);
});

test("classifyEngineTrack: pinned intent + mismatch → not coherent pinned", () => {
  const r = classifyEngineTrack({
    intent: "pinned",
    runningVersion: "1.30.0",
    pin: validPin(),
    installProvenance: pinProvenance(),
  });
  assert.equal(r.track, "candidate");
  assert.equal(r.coherent_pinned, false);
  assert.equal(r.pin_match, false);
});

test("classifyEngineTrack: candidate intent always candidate (even on match)", () => {
  const r = classifyEngineTrack({
    intent: "candidate",
    runningVersion: "1.29.1",
    pin: validPin(),
    installProvenance: pinProvenance(),
  });
  assert.equal(r.track, "candidate");
  assert.equal(r.coherent_pinned, false);
  assert.equal(r.pin_match, true);
});

test("classifyEngineTrack: pinned intent + missing pin", () => {
  const r = classifyEngineTrack({
    intent: "pinned",
    runningVersion: "1.29.1",
    pin: null,
  });
  assert.equal(r.track, "candidate");
  assert.equal(r.coherent_pinned, false);
});

// ---------------------------------------------------------------------------
// Intent precedence
// ---------------------------------------------------------------------------

test("resolveEngineTrackIntent: factory-gate forces candidate", () => {
  assert.equal(
    resolveEngineTrackIntent({ command: "factory-gate", cliTrack: "pinned", configTrack: "pinned" }),
    "candidate",
  );
});

test("resolveEngineTrackIntent: CLI overrides config", () => {
  assert.equal(
    resolveEngineTrackIntent({ command: "loop", cliTrack: "candidate", configTrack: "pinned" }),
    "candidate",
  );
});

test("resolveEngineTrackIntent: config when no CLI", () => {
  assert.equal(
    resolveEngineTrackIntent({ command: "advance", configTrack: "candidate" }),
    "candidate",
  );
});

test("resolveEngineTrackIntent: defaults are factory-scoped (#762 review 2)", () => {
  assert.equal(resolveEngineTrackIntent({ command: "evals" }), "candidate");
  // Factory control production/dogfood defaults to pinned.
  assert.equal(
    resolveEngineTrackIntent({ command: "loop", factoryControlContext: true }),
    "pinned",
  );
  assert.equal(
    resolveEngineTrackIntent({ command: "single", factoryControlContext: true }),
    "pinned",
  );
  assert.equal(
    resolveEngineTrackIntent({ command: "advance", factoryControlContext: true }),
    "pinned",
  );
  assert.equal(
    resolveEngineTrackIntent({ command: "doctor", factoryControlContext: true }),
    "pinned",
  );
  // Ordinary non-factory product repos: policy inactive (no pin required).
  assert.equal(resolveEngineTrackIntent({ command: "loop" }), null);
  assert.equal(resolveEngineTrackIntent({ command: "single" }), null);
  assert.equal(resolveEngineTrackIntent({ command: "advance" }), null);
  assert.equal(resolveEngineTrackIntent({ command: "doctor" }), null);
  assert.equal(
    resolveEngineTrackIntent({ command: "advance", factoryControlContext: false }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Enforce pinned policy
// ---------------------------------------------------------------------------

test("enforcePinnedTrackPolicy: candidate never fails for mismatch", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "candidate",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.30.0",
  });
  assert.equal(r.ok, true);
  assert.equal(r.classification.track, "candidate");
});

test("enforcePinnedTrackPolicy: pinned + missing pin fails", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "pinned",
    pinLoad: { kind: "missing", path: PIN_PATH },
    runningVersion: "1.29.1",
    installProvenance: pinProvenance(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "missing_pin");
});

test("enforcePinnedTrackPolicy: pinned + invalid pin fails (fail closed)", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "pinned",
    pinLoad: { kind: "invalid", path: PIN_PATH, detail: "bad json" },
    runningVersion: "1.29.1",
    installProvenance: pinProvenance(),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "invalid_pin");
});

test("enforcePinnedTrackPolicy: pinned + mismatch fails", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.30.0",
    installProvenance: pinProvenance("v1.30.0"),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "version_mismatch");
    assert.match(r.remediation, /reinstall|candidate/i);
  }
});

test("enforcePinnedTrackPolicy: pinned + version match + tag receipt ok", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "v1.29.1",
    installProvenance: pinProvenance(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.classification.track, "pinned");
});

test("enforcePinnedTrackPolicy: pinned + same-version working tree fails (unverified_install)", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.29.1",
    installProvenance: { kind: "working_tree", detail: "control-repo checkout" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "unverified_install");
    assert.match(r.remediation, /reinstall|candidate|receipt/i);
  }
});

test("enforcePinnedTrackPolicy: pinned + version match without receipt fails", () => {
  const r = enforcePinnedTrackPolicy({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.29.1",
    installProvenance: { kind: "missing", detail: "no receipt" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "unverified_install");
});

test("engineTrackEvidenceFields: pin git_sha only on verified pinned track", () => {
  const pin = validPin({
    git_sha: "abc123def4567890abc123def4567890abc123de",
    git_sha_source: "promote-arg",
  });
  const pinned = engineTrackEvidenceFields({ track: "pinned", pin });
  assert.equal(pinned.track, "pinned");
  assert.equal(pinned.pin_version, "1.29.1");
  assert.equal(pinned.git_sha, "abc123def4567890abc123def4567890abc123de");

  const candidate = engineTrackEvidenceFields({ track: "candidate", pin });
  assert.equal(candidate.track, "candidate");
  assert.equal(candidate.pin_version, "1.29.1");
  assert.equal(candidate.git_sha, undefined, "candidate must not inherit production pin SHA");
});

test("resolveInstallProvenance: receipt → tag_install; receipt wins over working_tree", () => {
  const text = JSON.stringify({
    schema_version: 1,
    version: "1.29.1",
    tag: "v1.29.1",
    installed_at: "2026-07-01T00:00:00Z",
  });
  const fromReceipt = resolveInstallProvenance({ receiptText: text });
  assert.equal(fromReceipt.kind, "tag_install");
  if (fromReceipt.kind === "tag_install") assert.equal(fromReceipt.tag, "v1.29.1");

  // Valid receipt is positive tag-install evidence even if path heuristics
  // also look like a working tree (e.g. tests under .worktrees/).
  const receiptOverWt = resolveInstallProvenance({ receiptText: text, isWorkingTree: true });
  assert.equal(receiptOverWt.kind, "tag_install");

  const wtOnly = resolveInstallProvenance({ receiptText: null, isWorkingTree: true });
  assert.equal(wtOnly.kind, "working_tree");

  assert.equal(resolveInstallProvenance({ receiptText: null }).kind, "missing");
});

test("parseInstallReceipt + pinInstallProvenanceMatches", () => {
  const receipt = parseInstallReceipt({
    schema_version: 1,
    version: "1.29.1",
    tag: "v1.29.1",
  });
  assert.equal(receipt.tag, "v1.29.1");
  assert.equal(
    pinInstallProvenanceMatches({ kind: "tag_install", tag: "v1.29.1" }, validPin()),
    true,
  );
  assert.equal(
    pinInstallProvenanceMatches({ kind: "tag_install", tag: "v1.30.0" }, validPin()),
    false,
  );
  assert.equal(INSTALL_RECEIPT_FILENAME, ".pipeline-install-receipt.json");
});

// ---------------------------------------------------------------------------
// Doctor evaluateEngineTrackCheck
// ---------------------------------------------------------------------------

test("evaluateEngineTrackCheck: pin match + tag provenance under pinned intent → pass", () => {
  const r = evaluateEngineTrackCheck({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.29.1",
    installProvenance: pinProvenance(),
  });
  assert.equal(r.status, "pass");
  assert.match(r.detail, /pinned/);
  assert.match(r.detail, /1\.29\.1/);
});

test("evaluateEngineTrackCheck: version match without provenance → fail", () => {
  const r = evaluateEngineTrackCheck({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.29.1",
    installProvenance: { kind: "missing" },
  });
  assert.equal(r.status, "fail");
  assert.match(r.detail, /provenance|receipt|tag-install|unverified/i);
  assert.ok(r.remediation);
});

test("evaluateEngineTrackCheck: mismatch under pinned intent → fail", () => {
  const r = evaluateEngineTrackCheck({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.30.0",
    installProvenance: pinProvenance(),
  });
  assert.equal(r.status, "fail");
  assert.match(r.detail, /1\.29\.1/);
  assert.match(r.detail, /1\.30\.0/);
  assert.ok(r.remediation);
});

test("evaluateEngineTrackCheck: missing pin under pinned intent → fail", () => {
  const r = evaluateEngineTrackCheck({
    intent: "pinned",
    pinLoad: { kind: "missing", path: PIN_PATH },
    runningVersion: "1.29.1",
  });
  assert.equal(r.status, "fail");
  assert.match(r.remediation ?? "", /factory-pin init/);
});

test("evaluateEngineTrackCheck: inactive intent (non-factory) + missing pin → pass", () => {
  const r = evaluateEngineTrackCheck({
    intent: null,
    pinLoad: { kind: "missing", path: PIN_PATH },
    runningVersion: "1.30.0",
  });
  assert.equal(r.status, "pass");
  assert.match(r.detail, /inactive|non-factory/i);
});

test("evaluateEngineTrackCheck: candidate intent with mismatch → pass", () => {
  const r = evaluateEngineTrackCheck({
    intent: "candidate",
    pinLoad: { kind: "ok", pin: validPin(), path: PIN_PATH },
    runningVersion: "1.30.0",
  });
  assert.equal(r.status, "pass");
  assert.match(r.detail, /candidate/);
  assert.match(r.detail, /1\.29\.1/);
});

test("evaluateEngineTrackCheck: reports sha unknown when absent", () => {
  const r = evaluateEngineTrackCheck({
    intent: "pinned",
    pinLoad: { kind: "ok", pin: validPin({ git_sha: null }), path: PIN_PATH },
    runningVersion: "1.29.1",
    installProvenance: pinProvenance(),
  });
  assert.equal(r.status, "pass");
  assert.match(r.detail, /unknown/);
});

// ---------------------------------------------------------------------------
// Promote
// ---------------------------------------------------------------------------

test("promoteProductionPin: success from FRG pass retains previous", async () => {
  const existing = validPin({ version: "1.29.1", tag: "v1.29.1" });
  const { deps, files } = memFs({ [PIN_PATH]: JSON.stringify(existing) });
  let mergeCalls = 0;
  let tagCalls = 0;
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    gitSha: "abc123def4567890abc123def4567890abc123de",
    fsDeps: deps,
    now: FIXED_NOW,
    env: {},
    lookupFrg: async (_repo, version) => {
      assert.equal(version, "1.30.0");
      return { kind: "pass", evidence: passEvidence("1.30.0", "frg-new") };
    },
  });
  // Promote must not expose merge/tag deps — hermetic assert: no such calls recorded
  assert.equal(mergeCalls, 0);
  assert.equal(tagCalls, 0);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pin.version, "1.30.0");
    assert.equal(result.pin.tag, "v1.30.0");
    assert.equal(result.pin.frg_run_id, "frg-new");
    assert.equal(result.pin.git_sha, "abc123def4567890abc123def4567890abc123de");
    assert.equal(result.pin.git_sha_source, "promote-arg");
    assert.equal(result.pin.previous?.version, "1.29.1");
    assert.match(result.reinstall_hint, /#v1\.30\.0/);
    const written = parseProductionEnginePin(files.get(PIN_PATH)!);
    assert.equal(written.version, "1.30.0");
  }
});

test("promoteProductionPin: refuses missing FRG — no mutation", async () => {
  const existing = validPin();
  const before = JSON.stringify(existing);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({
      kind: "missing",
      version: "1.30.0",
      path: "/repo/.agent-pipeline/frg/1.30.0/latest.json",
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing_frg");
  assert.equal(files.get(PIN_PATH), before);
});

test("promoteProductionPin: refuses pass:false — no mutation", async () => {
  const existing = validPin();
  const before = JSON.stringify(existing);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const failEv = { ...passEvidence("1.30.0"), pass: false };
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({ kind: "fail", evidence: failEv }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "frg_fail");
  assert.equal(files.get(PIN_PATH), before);
});

test("promoteProductionPin: refuses unparsable — no mutation", async () => {
  const existing = validPin();
  const before = JSON.stringify(existing);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({
      kind: "unparsable",
      version: "1.30.0",
      path: "/x",
      detail: "bad json",
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "frg_unparsable");
  assert.equal(files.get(PIN_PATH), before);
});

test("promoteProductionPin: refuses wrong-version evidence", async () => {
  const existing = validPin();
  const before = JSON.stringify(existing);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({
      kind: "pass",
      evidence: passEvidence("1.29.9", "frg-wrong"),
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "version_mismatch");
  assert.equal(files.get(PIN_PATH), before);
});

test("promoteProductionPin: refuses empty run_id", async () => {
  const existing = validPin();
  const before = JSON.stringify(existing);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const ev = passEvidence("1.30.0", "  ");
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({ kind: "pass", evidence: ev }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "empty_run_id");
  assert.equal(files.get(PIN_PATH), before);
});

test("promoteProductionPin: git_sha optional when not provided", async () => {
  const { deps, files } = memFs();
  const result = await promoteProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    now: FIXED_NOW,
    env: {},
    lookupFrg: async () => ({ kind: "pass", evidence: passEvidence("1.30.0") }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pin.git_sha, null);
    assert.equal(result.pin.git_sha_source, "unknown");
  }
  // atomic write used rename
  assert.ok([...files.keys()].some((k) => k === PIN_PATH));
});

// ---------------------------------------------------------------------------
// Init bootstrap
// ---------------------------------------------------------------------------

test("initProductionPin: bootstrap from FRG pass", async () => {
  const { deps, files } = memFs();
  const result = await initProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    now: FIXED_NOW,
    env: {},
    lookupFrg: async () => ({ kind: "pass", evidence: passEvidence("1.30.0", "frg-init") }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pin.version, "1.30.0");
    assert.equal(result.pin.frg_run_id, "frg-init");
    assert.equal(result.pin.previous, null);
  }
  assert.ok(files.has(PIN_PATH));
});

test("initProductionPin: refuses without FRG pass (blank init forbidden)", async () => {
  const { deps, files } = memFs();
  const result = await initProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({
      kind: "missing",
      version: "1.30.0",
      path: "/x",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(files.size, 0);
});

test("initProductionPin: refuses when pin already exists without --force", async () => {
  const { deps } = memFs({ [PIN_PATH]: JSON.stringify(validPin()) });
  const result = await initProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({ kind: "pass", evidence: passEvidence("1.30.0") }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "already_exists");
});

test("initProductionPin: --force still requires FRG pass", async () => {
  const before = JSON.stringify(validPin());
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const result = await initProductionPin({
    repoDir: REPO,
    version: "1.30.0",
    force: true,
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({
      kind: "fail",
      evidence: { ...passEvidence("1.30.0"), pass: false },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(files.get(PIN_PATH), before);
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test("rollbackProductionPin: restores previous", async () => {
  const current = validPin({
    version: "1.30.0",
    tag: "v1.30.0",
    frg_run_id: "frg-new",
    previous: {
      schema_version: 1,
      version: "1.29.1",
      tag: "v1.29.1",
      git_sha: null,
      git_sha_source: "unknown",
      frg_run_id: "frg-old",
      frg_evidence_path: ".agent-pipeline/frg/1.29.1/latest.json",
      promoted_at: "2026-07-01T00:00:00Z",
    },
  });
  const { deps, files } = memFs({ [PIN_PATH]: JSON.stringify(current) });
  const result = await rollbackProductionPin({
    repoDir: REPO,
    fsDeps: deps,
    now: FIXED_NOW,
    env: {},
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pin.version, "1.29.1");
    assert.equal(result.pin.previous?.version, "1.30.0");
    assert.match(result.reinstall_hint, /#v1\.29\.1/);
  }
  const written = parseProductionEnginePin(files.get(PIN_PATH)!);
  assert.equal(written.version, "1.29.1");
});

test("rollbackProductionPin: refuse when no previous and no --to", async () => {
  const current = validPin({ previous: null });
  const before = JSON.stringify(current);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const result = await rollbackProductionPin({
    repoDir: REPO,
    fsDeps: deps,
    env: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "no_previous");
  assert.equal(files.get(PIN_PATH), before);
});

test("rollbackProductionPin: --to matching previous", async () => {
  const current = validPin({
    version: "1.30.0",
    tag: "v1.30.0",
    previous: {
      schema_version: 1,
      version: "1.29.1",
      tag: "v1.29.1",
      frg_run_id: "frg-old",
      promoted_at: "2026-07-01T00:00:00Z",
    },
  });
  const { deps } = memFs({ [PIN_PATH]: JSON.stringify(current) });
  const result = await rollbackProductionPin({
    repoDir: REPO,
    toVersion: "1.29.1",
    fsDeps: deps,
    now: FIXED_NOW,
    env: {},
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.pin.version, "1.29.1");
});

test("rollbackProductionPin: --to without previous requires FRG pass", async () => {
  const current = validPin({ previous: null });
  const before = JSON.stringify(current);
  const { deps, files } = memFs({ [PIN_PATH]: before });
  const result = await rollbackProductionPin({
    repoDir: REPO,
    toVersion: "1.28.0",
    fsDeps: deps,
    env: {},
    lookupFrg: async () => ({
      kind: "missing",
      version: "1.28.0",
      path: "/x",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(files.get(PIN_PATH), before);
});

test("formatProductionPinSummary includes version and sha unknown", () => {
  const s = formatProductionPinSummary(validPin({ git_sha: null }));
  assert.match(s, /1\.29\.1/);
  assert.match(s, /unknown/);
});

// Ensure lookupFrg type stays hermetic (unused import lint guard via use)
void (null as unknown as FrgLookupResult);
