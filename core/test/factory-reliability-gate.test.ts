// Factory Reliability Gate (#723) — schema, scoring, evidence I/O, release lookup,
// and driver seams. Zero real network/git/subprocess; in-memory fs only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRG_SCHEMA_VERSION,
  FRG_SCENARIO_IDS,
  FRG_LAYER_A_WAIVERS,
  FRG_SCENARIO_OWNERSHIP,
  FRG_PACK_MANIFEST,
  DEFAULT_FRG_THRESHOLDS,
  classifyFrgBlocker,
  computeFrgEvidence,
  parseFrgEvidence,
  parseFrgEvidenceJson,
  normalizeFrgVersion,
  frgLatestPath,
  frgRunEvidencePath,
  writeFrgEvidence,
  lookupFrgPass,
  requireFrgPassForRelease,
  formatFrgPrSection,
  runFactoryGate,
  itemsFromLoopLedger,
  detectEmptyDependsOnStackHonesty,
  frgRequiredObservationOverrides,
  validateFrgPackContract,
  isAllowedFrgPackSelector,
  enforceRequiredScenarioCriteria,
  isReleaseEligibleFrgPass,
  formatFrgPackCloseComment,
  parseFrgItemIssueNumber,
  packLabelFromSelector,
  selectReadyCleanPackIssueNumbers,
  closeFrgPackArtifacts,
  type FrgEvidence,
  type FrgFsDeps,
  type FrgPackCloseDeps,
} from "../scripts/factory-reliability-gate.ts";
import type { LoopContract, LoopLedger } from "../scripts/loop/types.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA } from "../scripts/loop/types.ts";

/** Minimal full-pack pass scoring input (all scenarios observed; K met; live loop provenance). */
function fullPackPassInput(
  overrides: {
    version?: string;
    run_id?: string;
    loop_run_id?: string | null;
    pack_id?: string | null;
  } = {},
) {
  return {
    version: overrides.version ?? "1.29.1",
    run_id: overrides.run_id ?? "frg-full-pass",
    // Release-eligible pass requires durable loop + fixed-pack provenance.
    loop_run_id:
      overrides.loop_run_id === undefined ? "loop-full-pass" : overrides.loop_run_id,
    pack_id:
      overrides.pack_id === undefined ? FRG_PACK_MANIFEST.pack_id : overrides.pack_id,
    items: [
      { item_id: "1", state: "ready" as const, ready_clean: true },
      { item_id: "2", state: "ready" as const, ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
  };
}

// ---------------------------------------------------------------------------
// In-memory fs
// ---------------------------------------------------------------------------

function memFs(): FrgFsDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
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
  };
}

// ---------------------------------------------------------------------------
// Schema / inventory
// ---------------------------------------------------------------------------

test("FRG scenario inventory is fixed and named", () => {
  assert.equal(FRG_SCENARIO_IDS.length, 10);
  assert.ok(FRG_SCENARIO_IDS.includes("capacity-blocked-retain"));
  assert.ok(FRG_SCENARIO_IDS.includes("empty-depends-on-stack-honesty"));
  for (const id of FRG_SCENARIO_IDS) {
    assert.ok(FRG_SCENARIO_OWNERSHIP[id], `ownership for ${id}`);
    assert.ok(FRG_SCENARIO_OWNERSHIP[id].pass_criteria.length > 0);
  }
});

test("Layer A waivers name tracking issues (no silent gaps for waived scenarios)", () => {
  for (const [id, ownership] of Object.entries(FRG_SCENARIO_OWNERSHIP)) {
    if (ownership.layer_a === "waiver") {
      assert.ok(
        FRG_LAYER_A_WAIVERS[id as keyof typeof FRG_LAYER_A_WAIVERS],
        `waiver for ${id} must name an issue`,
      );
      assert.match(FRG_LAYER_A_WAIVERS[id as keyof typeof FRG_LAYER_A_WAIVERS]!, /^#\d+$/);
    }
  }
});

test("normalizeFrgVersion strips v prefix and rejects garbage", () => {
  assert.equal(normalizeFrgVersion("v1.29.1"), "1.29.1");
  assert.equal(normalizeFrgVersion("1.29.1"), "1.29.1");
  assert.throws(() => normalizeFrgVersion("42"), /Invalid FRG version/);
  assert.throws(() => normalizeFrgVersion("1.2"), /Invalid FRG version/);
});

test("classifyFrgBlocker taxonomy buckets", () => {
  assert.equal(classifyFrgBlocker("workflow-engine-defect"), "engine-class");
  assert.equal(classifyFrgBlocker("missing-authority"), "human-authority");
  assert.equal(classifyFrgBlocker("specification-decision"), "human-authority");
  assert.equal(classifyFrgBlocker("implementation-ci"), "product-class");
  assert.equal(classifyFrgBlocker("capacity-cascade"), "engine-class");
  assert.equal(classifyFrgBlocker(null), "engine-class");
  assert.equal(classifyFrgBlocker("totally-unknown-xyz"), "engine-class");
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test("computeFrgEvidence: green unit-shaped pass with K clean ready items + full pack observation", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-1",
    loop_run_id: "loop-test-1",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
      { item_id: "3", state: "waiting", blocker_theme: "missing-authority" },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    now: () => new Date("2026-07-30T12:00:00.000Z"),
  });
  assert.equal(evidence.schema_version, FRG_SCHEMA_VERSION);
  assert.equal(evidence.version, "1.29.1");
  assert.equal(evidence.run_id, "frg-test-1");
  assert.equal(evidence.pass, true);
  assert.equal(evidence.loop_run_id, "loop-test-1");
  assert.equal(evidence.pack_id, FRG_PACK_MANIFEST.pack_id);
  assert.equal(evidence.scoreboard.ready_clean_count, 2);
  assert.equal(evidence.thresholds.min_clean_ready_to_deploy, DEFAULT_FRG_THRESHOLDS.min_clean_ready_to_deploy);
  const throughput = evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(throughput?.status, "pass");
  const capacity = evidence.scenarios.find((s) => s.id === "capacity-blocked-retain");
  assert.equal(capacity?.status, "pass");
  assert.ok((capacity?.observed ?? 0) >= DEFAULT_FRG_THRESHOLDS.capacity_stress_n);
  assert.ok(evidence.scenarios.every((s) => s.status !== "not_observed"));
});

test("computeFrgEvidence: offline score without loop_run_id cannot yield release pass", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-offline",
    loop_run_id: null,
    pack_id: null,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
  });
  assert.equal(evidence.pass, false, "no live loop → not release-eligible");
  assert.equal(evidence.loop_run_id, null);
  assert.equal(evidence.pack_id, null);
  // Scenario criteria alone may be green; pass still false without provenance.
  assert.ok(evidence.scenarios.every((s) => s.status !== "not_observed"));
});

test("computeFrgEvidence: capacity pass override without observed≥N is coerced to fail", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-cap-fake",
    loop_run_id: "loop-cap",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass").map((o) =>
      o.id === "capacity-blocked-retain"
        ? {
            id: "capacity-blocked-retain" as const,
            status: "pass" as const,
            detail: "claimed pass without capacity stress",
            observed: 0,
            threshold: DEFAULT_FRG_THRESHOLDS.capacity_stress_n,
          }
        : o,
    ),
  });
  assert.equal(evidence.pass, false);
  const capacity = evidence.scenarios.find((s) => s.id === "capacity-blocked-retain");
  assert.equal(capacity?.status, "fail");
  assert.equal(capacity?.observed, 0);
});

test("computeFrgEvidence: skip on required scenario fails overall pass", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-skip",
    loop_run_id: "loop-skip",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass").map((o) =>
      o.id === "resume-mid-flight"
        ? {
            id: "resume-mid-flight" as const,
            status: "skip" as const,
            detail: "skipped",
            observed: null,
            threshold: null,
          }
        : o,
    ),
  });
  assert.equal(evidence.pass, false);
  const resume = evidence.scenarios.find((s) => s.id === "resume-mid-flight");
  assert.equal(resume?.status, "fail");
  assert.match(resume?.detail ?? "", /cannot be skipped/);
});

test("enforceRequiredScenarioCriteria + isReleaseEligibleFrgPass: capacity N and live loop", () => {
  const thresholds = DEFAULT_FRG_THRESHOLDS;
  const bad = enforceRequiredScenarioCriteria(
    [
      {
        id: "capacity-blocked-retain",
        status: "pass",
        detail: "fake",
        observed: 0,
        threshold: thresholds.capacity_stress_n,
      },
    ],
    thresholds,
  );
  assert.equal(bad[0]?.status, "fail");

  const full = computeFrgEvidence(fullPackPassInput());
  assert.equal(full.pass, true);
  assert.equal(isReleaseEligibleFrgPass(full), true);
  assert.equal(isReleaseEligibleFrgPass({ ...full, loop_run_id: null }), false);
  assert.equal(isReleaseEligibleFrgPass({ ...full, pack_id: null }), false);
  assert.equal(isReleaseEligibleFrgPass({ ...full, pass: false }), false);
});

test("computeFrgEvidence: unobserved mandatory scenarios fail overall pass (not release evidence)", () => {
  // Ordinary loop with K clean ready items but no pack scenario observations.
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-unobserved",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
  assert.equal(evidence.pass, false, "not_observed required scenarios must not produce pass:true");
  const unobserved = evidence.scenarios.filter((s) => s.status === "not_observed");
  assert.ok(unobserved.length >= 1);
  assert.ok(unobserved.some((s) => s.id === "capacity-blocked-retain"));
  // Auto-scored scenarios still pass when thresholds are met.
  assert.equal(
    evidence.scenarios.find((s) => s.id === "clean-item-throughput")?.status,
    "pass",
  );
});

test("computeFrgEvidence: clean-item throughput below K fails the gate", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-k",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    thresholds: { ...DEFAULT_FRG_THRESHOLDS, min_clean_ready_to_deploy: 2 },
  });
  assert.equal(evidence.pass, false);
  const throughput = evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(throughput?.status, "fail");
  assert.equal(throughput?.observed, 1);
  assert.equal(throughput?.threshold, 2);
});

test("computeFrgEvidence: engine-class rate above threshold fails the gate", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-engine",
    items: [
      { item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "2", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "3", state: "ready", ready_clean: true },
      { item_id: "4", state: "ready", ready_clean: true },
    ],
    thresholds: { ...DEFAULT_FRG_THRESHOLDS, max_engine_class_rate: 0.25, min_clean_ready_to_deploy: 2 },
  });
  // 2 engine / 2 classified blockers with themes = wait, ready items have no blocker_class
  // engine=2, product=0, human=0 → rate=1.0 > 0.25
  assert.equal(evidence.pass, false);
  const tax = evidence.scenarios.find((s) => s.id === "blocker-taxonomy");
  assert.equal(tax?.status, "fail");
  assert.ok(tax?.detail.includes("engine-class rate"));
  assert.ok((evidence.scoreboard.engine_class_rate ?? 0) > 0.25);
});

test("computeFrgEvidence: pass for one version does not imply another", () => {
  const a = computeFrgEvidence(fullPackPassInput({ version: "1.29.1", run_id: "frg-a" }));
  assert.equal(a.pass, true);
  assert.equal(a.version, "1.29.1");
  // Different version requires its own artifact — scoring for 1.30.0 is independent.
  const b = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-b",
    items: [{ item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
  });
  assert.equal(b.version, "1.30.0");
  assert.notEqual(b.version, a.version);
});

test("parseFrgEvidence rejects bad shapes", () => {
  assert.throws(() => parseFrgEvidence(null), /JSON object/);
  assert.throws(
    () => parseFrgEvidence({ schema_version: 99, version: "1.0.0", run_id: "x", pass: true }),
    /schema_version/,
  );
  assert.throws(
    () =>
      parseFrgEvidence({
        schema_version: 1,
        version: "1.0.0",
        run_id: "",
        pass: true,
        scenarios: [],
        scoreboard: {},
        thresholds: {},
      }),
    /run_id/,
  );
});

test("parseFrgEvidence rejects structurally incomplete pass artifacts (empty scenarios)", () => {
  // A latest.json with matching version, pass:true, empty scenarios must NOT parse.
  assert.throws(
    () =>
      parseFrgEvidence({
        schema_version: 1,
        version: "1.29.1",
        run_id: "frg-fake-pass",
        pass: true,
        scenarios: [],
        scoreboard: {},
        thresholds: {},
        loop_run_id: null,
        created_at: "2026-07-30T00:00:00Z",
        notes: [],
      }),
    /exactly 10 named outcomes|scenarios/,
  );
});

test("parseFrgEvidence rejects pass:true with not_observed scenarios", () => {
  const scored = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-inconsistent",
    loop_run_id: "loop-x",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
  assert.equal(scored.pass, false);
  // Force pass:true while keeping not_observed statuses — must reject.
  assert.throws(
    () => parseFrgEvidence({ ...scored, pass: true }),
    /not release-eligible|fail or not_observed/,
  );
});

test("parseFrgEvidence rejects pass:true without live loop_run_id (offline not release-eligible)", () => {
  const scored = computeFrgEvidence(
    fullPackPassInput({ run_id: "frg-no-loop", loop_run_id: "loop-ok" }),
  );
  assert.equal(scored.pass, true);
  assert.throws(
    () =>
      parseFrgEvidence({
        ...scored,
        loop_run_id: null,
        pack_id: FRG_PACK_MANIFEST.pack_id,
        pass: true,
      }),
    /not release-eligible|loop_run_id/,
  );
  assert.throws(
    () =>
      parseFrgEvidence({
        ...scored,
        loop_run_id: "loop-ok",
        pack_id: null,
        pass: true,
      }),
    /not release-eligible|pack_id/,
  );
});

test("parseFrgEvidence rejects pass:true capacity with observed below N", () => {
  const scored = computeFrgEvidence(fullPackPassInput({ run_id: "frg-cap-parse" }));
  const scenarios = scored.scenarios.map((s) =>
    s.id === "capacity-blocked-retain"
      ? { ...s, status: "pass", observed: 0, detail: "forged" }
      : s,
  );
  assert.throws(
    () => parseFrgEvidence({ ...scored, scenarios, pass: true }),
    /not release-eligible|capacity/,
  );
});

test("parseFrgEvidence accepts complete computeFrgEvidence output", () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-roundtrip" }));
  const parsed = parseFrgEvidence(JSON.parse(JSON.stringify(evidence)));
  assert.equal(parsed.pass, true);
  assert.equal(parsed.run_id, "frg-roundtrip");
  assert.equal(parsed.loop_run_id, "loop-full-pass");
  assert.equal(parsed.pack_id, FRG_PACK_MANIFEST.pack_id);
  assert.equal(parsed.scenarios.length, FRG_SCENARIO_IDS.length);
});

// ---------------------------------------------------------------------------
// Evidence I/O + lookup
// ---------------------------------------------------------------------------

test("writeFrgEvidence + lookupFrgPass: pass and fail distinguished from missing", async () => {
  const fs = memFs();
  const repo = "/repo";
  const passEv = computeFrgEvidence(fullPackPassInput({ version: "1.29.1", run_id: "frg-pass-1" }));
  await writeFrgEvidence(repo, passEv, fs);
  const look = await lookupFrgPass(repo, "1.29.1", fs);
  assert.equal(look.kind, "pass");
  if (look.kind === "pass") {
    assert.equal(look.evidence.run_id, "frg-pass-1");
    assert.equal(look.evidence.pass, true);
  }

  const miss = await lookupFrgPass(repo, "1.30.0", fs);
  assert.equal(miss.kind, "missing");
  if (miss.kind === "missing") {
    assert.equal(miss.version, "1.30.0");
    assert.ok(miss.path.includes("1.30.0"));
  }

  const failEv = computeFrgEvidence({
    version: "1.29.2",
    run_id: "frg-fail-1",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence(repo, failEv, fs);
  const lookFail = await lookupFrgPass(repo, "1.29.2", fs);
  assert.equal(lookFail.kind, "fail");
});

test("lookupFrgPass: incomplete pass:true latest.json is unparsable (does not unblock release)", async () => {
  const fs = memFs();
  await fs.writeFile(
    frgLatestPath("/repo", "1.29.1"),
    JSON.stringify({
      schema_version: 1,
      version: "1.29.1",
      run_id: "frg-incomplete",
      pass: true,
      scenarios: [],
      scoreboard: {},
      thresholds: {},
    }),
  );
  const look = await lookupFrgPass("/repo", "1.29.1", fs);
  assert.equal(look.kind, "unparsable");
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "1.29.1", fs),
    /unparsable|scenarios/,
  );
});

test("lookupFrgPass: unparsable evidence is distinguishable", async () => {
  const fs = memFs();
  const p = frgLatestPath("/repo", "1.0.0");
  await fs.writeFile(p, "{ not json");
  const look = await lookupFrgPass("/repo", "1.0.0", fs);
  assert.equal(look.kind, "unparsable");
});

test("requireFrgPassForRelease: missing / fail / empty run_id refuse; pass returns evidence", async () => {
  const fs = memFs();
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "1.29.1", fs),
    /pass missing for version 1\.29\.1/,
  );

  const failEv = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-fail",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
  });
  await writeFrgEvidence("/repo", failEv, fs);
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "1.29.1", fs),
    /Gate FAILED for version 1\.29\.1/,
  );

  const passEv = computeFrgEvidence(fullPackPassInput({ version: "1.29.1", run_id: "frg-ok" }));
  await writeFrgEvidence("/repo", passEv, fs);
  const ok = await requireFrgPassForRelease("/repo", "1.29.1", fs);
  assert.equal(ok.run_id, "frg-ok");
  assert.equal(ok.pass, true);

  // Empty run_id must fail closed even if pass:true is claimed.
  const bad: FrgEvidence = { ...passEv, run_id: "   " };
  // Bypass parseFrgEvidence writer: write raw JSON that parse will reject on lookup.
  await fs.writeFile(
    frgLatestPath("/repo", "9.9.9"),
    JSON.stringify({
      schema_version: 1,
      version: "9.9.9",
      run_id: "",
      pass: true,
      scenarios: [],
      scoreboard: {},
      thresholds: DEFAULT_FRG_THRESHOLDS,
    }),
  );
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "9.9.9", fs),
    /unparsable|run_id/,
  );
  void bad;
});

test("formatFrgPrSection includes run_id and pass for release PR surface", () => {
  const evidence = computeFrgEvidence(
    fullPackPassInput({ run_id: "frg-attach-1", loop_run_id: "loop-abc" }),
  );
  const section = formatFrgPrSection(evidence);
  assert.match(section, /Factory Reliability Gate/);
  assert.match(section, /frg-attach-1/);
  assert.match(section, /pass/);
  assert.match(section, /1\.29\.1/);
  assert.match(section, /loop-abc/);
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

test("runFactoryGate: scoreInput path does not persist evidence by default", async () => {
  const fs = memFs();
  const lines: string[] = [];
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      json: true,
      scoreInput: fullPackPassInput({ run_id: "frg-driver-1" }),
      stdout: (m) => lines.push(m),
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.equal(result.evidencePath, null, "offline scoreInput must not write by default");
  assert.equal(result.latestPath, null);
  assert.equal(fs.files.size, 0);
  const parsed = parseFrgEvidenceJson(lines.join("\n"));
  assert.equal(parsed.run_id, "frg-driver-1");
});

test("runFactoryGate: scoreInput without loop_run_id cannot produce release pass even if written", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: fullPackPassInput({
        run_id: "frg-offline-write",
        loop_run_id: null,
        pack_id: null,
      }),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.evidence.pass, false);
  // Even if a fail report is written, release lookup must not treat it as pass.
  if (result.evidencePath) {
    const look = await lookupFrgPass("/repo", "1.29.1", fs);
    assert.notEqual(look.kind, "pass");
  }
});

test("runFactoryGate: scoreInput with explicit writeEvidence + live provenance can persist", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: fullPackPassInput({ run_id: "frg-explicit-write" }),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.ok(result.evidencePath?.includes("frg-explicit-write"));
  const look = await lookupFrgPass("/repo", "1.29.1", fs);
  assert.equal(look.kind, "pass");
});

test("runFactoryGate: fail exits non-zero", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: {
        version: "1.29.1",
        run_id: "frg-driver-fail",
        items: [{ item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" }],
      },
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.evidence.pass, false);
});

test("runFactoryGate: does not merge or tag (no side-effect hooks)", async () => {
  // Structural: driver only writes FRG evidence files — no merge/tag deps exist.
  const fs = memFs();
  await runFactoryGate(
    {
      version: "1.0.0",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: fullPackPassInput({ version: "1.0.0", run_id: "frg-no-merge" }),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  for (const key of fs.files.keys()) {
    assert.ok(key.includes(".agent-pipeline/frg"), `only FRG paths written: ${key}`);
    assert.ok(!key.includes("tag"), key);
  }
});

test("runFactoryGate --from-run: refuses unrelated durable loop (non-pack selector)", async () => {
  const fs = memFs();
  const productContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-product",
    selector: { type: "milestone", value: "v2-product" },
    items: [
      { id: "1", depends_on: [], external_depends_on: [] },
      { id: "2", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-product",
    items: {
      "1": { state: "ready", history: [], recovery_attempts: [] },
      "2": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  await assert.rejects(
    () =>
      runFactoryGate(
        {
          version: "1.29.1",
          repoDir: "/repo",
          fromRun: "loop-product",
          loadLedger: async () => ledger,
          loadContract: async () => productContract,
          scenarioOverrides: frgRequiredObservationOverrides("pass"),
          stdout: () => {},
          stderr: () => {},
        },
        fs,
      ),
    /refused to score non-pack run|not an FRG fixed-pack selector/,
  );
  assert.equal(fs.files.size, 0, "must not write FRG evidence for non-pack runs");
});

test("runFactoryGate --from-run: accepts factory-gate label pack and scores", async () => {
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-frg",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-frg",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-frg",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.equal(result.evidence.loop_run_id, "loop-frg");
  assert.equal(result.evidence.pack_id, FRG_PACK_MANIFEST.pack_id);
  assert.ok(
    result.evidence.notes.some((n) => n.includes(FRG_PACK_MANIFEST.pack_id)),
  );
  const capacity = result.evidence.scenarios.find((s) => s.id === "capacity-blocked-retain");
  assert.equal(capacity?.status, "pass");
  assert.ok((capacity?.observed ?? 0) >= DEFAULT_FRG_THRESHOLDS.capacity_stress_n);
});

test("runFactoryGate --from-run: requires loadContract (pack validation seam)", async () => {
  await assert.rejects(
    () =>
      runFactoryGate({
        version: "1.29.1",
        repoDir: "/repo",
        fromRun: "loop-x",
        loadLedger: async () =>
          ({
            schema: LOOP_LEDGER_SCHEMA,
            run_id: "loop-x",
            items: {},
          }) as unknown as LoopLedger,
        stdout: () => {},
        stderr: () => {},
      }),
    /requires a contract loader/,
  );
});

test("validateFrgPackContract: fixed-pack manifest enforces selector + multi-item", () => {
  assert.equal(isAllowedFrgPackSelector({ type: "label", value: "factory-gate" }), true);
  assert.equal(isAllowedFrgPackSelector({ type: "milestone", value: "v2" }), false);
  assert.equal(isAllowedFrgPackSelector({ type: "work-list", value: ["1", "2"] }), false);

  const ok = validateFrgPackContract({
    schema: LOOP_CONTRACT_SCHEMA,
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "1", depends_on: [], external_depends_on: [] },
      { id: "2", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract);
  assert.equal(ok.ok, true);

  const single = validateFrgPackContract({
    schema: LOOP_CONTRACT_SCHEMA,
    selector: { type: "label", value: "factory-gate" },
    items: [{ id: "1", depends_on: [], external_depends_on: [] }],
  } as unknown as LoopContract);
  assert.equal(single.ok, false);
  if (!single.ok) assert.match(single.detail, /≥2 items/);
});

test("itemsFromLoopLedger projects ready/blocked themes", () => {
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-1",
    items: {
      "10": {
        state: "ready",
        history: [],
        recovery_attempts: [],
      },
      "20": {
        state: "blocked",
        blocked_theme: "workflow-engine-defect",
        evidence_fingerprint: "abc",
        history: [],
        recovery_attempts: [],
      },
    },
  } as unknown as LoopLedger;
  const items = itemsFromLoopLedger(ledger);
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.item_id === "10" && i.ready_clean === true));
  assert.ok(items.some((i) => i.item_id === "20" && i.blocker_theme === "workflow-engine-defect"));
});

test("detectEmptyDependsOnStackHonesty warns on multi empty-depends_on", () => {
  const contract = {
    schema: LOOP_CONTRACT_SCHEMA,
    items: [
      { id: "1", depends_on: [] },
      { id: "2", depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = { schema: LOOP_LEDGER_SCHEMA, run_id: "r", items: {} } as unknown as LoopLedger;
  const o = detectEmptyDependsOnStackHonesty(contract, ledger);
  assert.ok(o);
  assert.equal(o!.id, "empty-depends-on-stack-honesty");
  assert.equal(o!.status, "warn");
});

test("paths are stable under .agent-pipeline/frg", () => {
  assert.equal(
    frgLatestPath("/repo", "1.2.3"),
    "/repo/.agent-pipeline/frg/1.2.3/latest.json",
  );
  assert.equal(
    frgRunEvidencePath("/repo", "1.2.3", "frg-x"),
    "/repo/.agent-pipeline/frg/1.2.3/frg-x/evidence.json",
  );
});

// ---------------------------------------------------------------------------
// Post-pass pack auto-close (#754)
// ---------------------------------------------------------------------------

function fakePackCloseDeps(opts: {
  issues?: Record<
    number,
    { state: "open" | "closed"; labels: string[]; pr?: number | null }
  >;
  closePrImpl?: (pr: number, comment: string) => Promise<void>;
  closeIssueImpl?: (issue: number, comment: string) => Promise<void>;
}): FrgPackCloseDeps & {
  closedPrs: { pr: number; comment: string }[];
  closedIssues: { issue: number; comment: string }[];
  mergeCalls: number;
} {
  const issues = opts.issues ?? {};
  const closedPrs: { pr: number; comment: string }[] = [];
  const closedIssues: { issue: number; comment: string }[] = [];
  return {
    closedPrs,
    closedIssues,
    mergeCalls: 0,
    getIssueStateAndLabels: async (n) => {
      const row = issues[n];
      if (!row) return null;
      return { state: row.state, labels: row.labels };
    },
    findOpenPrForIssue: async (n) => {
      const row = issues[n];
      if (!row) return null;
      return row.pr === undefined ? null : row.pr;
    },
    closePr: async (pr, comment) => {
      if (opts.closePrImpl) return opts.closePrImpl(pr, comment);
      closedPrs.push({ pr, comment });
    },
    closeIssue: async (issue, comment) => {
      if (opts.closeIssueImpl) return opts.closeIssueImpl(issue, comment);
      closedIssues.push({ issue, comment });
    },
  };
}

test("formatFrgPackCloseComment is deterministic and cites version + run_id", () => {
  const c = formatFrgPackCloseComment("1.29.1", "frg-abc");
  assert.match(c, /FRG 1\.29\.1 pass \(run_id=frg-abc\)/);
  assert.match(c, /closing without merge/);
  assert.equal(c, formatFrgPackCloseComment("1.29.1", "frg-abc"));
});

test("parseFrgItemIssueNumber accepts positive integers only", () => {
  assert.equal(parseFrgItemIssueNumber("749"), 749);
  assert.equal(parseFrgItemIssueNumber(" 10 "), 10);
  assert.equal(parseFrgItemIssueNumber("0"), null);
  assert.equal(parseFrgItemIssueNumber("-1"), null);
  assert.equal(parseFrgItemIssueNumber("issue-10"), null);
  assert.equal(parseFrgItemIssueNumber(""), null);
});

test("packLabelFromSelector uses label value or factory-gate default", () => {
  assert.equal(packLabelFromSelector({ type: "label", value: "factory-gate" }), "factory-gate");
  assert.equal(packLabelFromSelector({ type: "milestone", value: "frg-pack" }), "factory-gate");
  assert.equal(packLabelFromSelector(null), "factory-gate");
});

test("selectReadyCleanPackIssueNumbers only includes ready_clean scored items", () => {
  const selected = selectReadyCleanPackIssueNumbers({
    item_count: 3,
    ready_clean_count: 1,
    engine_class_count: 0,
    product_class_count: 0,
    human_authority_count: 0,
    engine_class_rate: null,
    per_item: [
      { item_id: "10", state: "ready", ready_clean: true, blocker_theme: null, blocker_class: null },
      { item_id: "20", state: "blocked", ready_clean: false, blocker_theme: null, blocker_class: null },
      { item_id: "not-a-number", state: "ready", ready_clean: true, blocker_theme: null, blocker_class: null },
    ],
  });
  assert.deepEqual(selected, [{ item_id: "10", issueNumber: 10 }]);
});

test("closeFrgPackArtifacts: closes open pack PR+issue with standard comment", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-close-1" }));
  assert.equal(evidence.pass, true);
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 101 },
      2: { state: "open", labels: ["factory-gate"], pr: 102 },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  const comment = formatFrgPackCloseComment(evidence.version, evidence.run_id);
  assert.deepEqual(result.closedPrs.sort((a, b) => a - b), [101, 102]);
  assert.deepEqual(result.closedIssues.sort((a, b) => a - b), [1, 2]);
  assert.equal(result.errors.length, 0);
  assert.ok(deps.closedPrs.every((c) => c.comment === comment));
  assert.ok(deps.closedIssues.every((c) => c.comment === comment));
  assert.equal(deps.mergeCalls, 0);
});

test("closeFrgPackArtifacts: skips issues missing pack label (product never closed)", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput());
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 101 },
      2: { state: "open", labels: ["pipeline:ready-to-deploy"], pr: 999 },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.deepEqual(result.closedPrs, [101]);
  assert.deepEqual(result.closedIssues, [1]);
  assert.ok(result.skipped.some((s) => s.issueNumber === 2 && /missing pack label/.test(s.reason)));
  assert.equal(deps.closedPrs.some((c) => c.pr === 999), false);
});

test("closeFrgPackArtifacts: already-closed resources skip without error", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput());
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "closed", labels: ["factory-gate"], pr: null },
      2: { state: "open", labels: ["factory-gate"], pr: null },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.deepEqual(result.closedIssues, [2]);
  assert.ok(result.skipped.some((s) => s.issueNumber === 1 && /already closed/.test(s.reason)));
  assert.equal(result.errors.length, 0);
});

test("closeFrgPackArtifacts: close error is fail-soft (best-effort continues)", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-soft" }));
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 101 },
      2: { state: "open", labels: ["factory-gate"], pr: 102 },
    },
  });
  deps.closePr = async (pr, comment) => {
    if (pr === 101) throw new Error("simulated gh pr close failure");
    deps.closedPrs.push({ pr, comment });
  };
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.ok(result.errors.some((e) => /PR #101/.test(e)));
  assert.deepEqual(result.closedPrs, [102]);
  assert.deepEqual(result.closedIssues.sort((a, b) => a - b), [1, 2]);
});

test("runFactoryGate: release-eligible pass closes pack artifacts via injected deps", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 751 },
      20: { state: "open", labels: ["factory-gate"], pr: 752 },
    },
  });
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-close",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-close",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-close",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.ok(result.evidencePath);
  assert.ok(result.packClose);
  assert.deepEqual(result.packClose!.closedPrs.sort((a, b) => a - b), [751, 752]);
  assert.deepEqual(result.packClose!.closedIssues.sort((a, b) => a - b), [10, 20]);
  const comment = formatFrgPackCloseComment(result.evidence.version, result.evidence.run_id);
  assert.ok(deps.closedPrs.every((c) => c.comment === comment));
  // Evidence still on disk with pass true
  const latest = await fs.readFile(frgLatestPath("/repo", "1.29.1"));
  assert.equal(JSON.parse(latest).pass, true);
});

test("runFactoryGate: pass:false does not close pack artifacts", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 1 },
      20: { state: "open", labels: ["factory-gate"], pr: 2 },
    },
  });
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-fail",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  // Only one ready item → clean-item-throughput fails K=2
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-fail",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "blocked", blocked_theme: "implementation-ci", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-fail",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.packClose, null);
  assert.equal(deps.closedPrs.length, 0);
  assert.equal(deps.closedIssues.length, 0);
});

test("runFactoryGate: non-release-eligible offline score does not close", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 9 },
      2: { state: "open", labels: ["factory-gate"], pr: 10 },
    },
  });
  // scoreInput without writeEvidence: pass is false without loop/pack provenance
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      scoreInput: {
        version: "1.29.1",
        run_id: "offline",
        loop_run_id: null,
        pack_id: null,
        items: [
          { item_id: "1", state: "ready", ready_clean: true },
          { item_id: "2", state: "ready", ready_clean: true },
        ],
        scenario_overrides: frgRequiredObservationOverrides("pass"),
      },
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, false);
  assert.equal(result.packClose, null);
  assert.equal(deps.closedPrs.length, 0);
});

test("runFactoryGate: --no-close-pack skips closes while keeping pass", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 751 },
      20: { state: "open", labels: ["factory-gate"], pr: 752 },
    },
  });
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-optout",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-optout",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const stderrLines: string[] = [];

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-optout",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      noClosePack: true,
      packCloseDeps: deps,
      stdout: () => {},
      stderr: (m) => stderrLines.push(m),
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.packClose, null);
  assert.equal(deps.closedPrs.length, 0);
  assert.equal(deps.closedIssues.length, 0);
  assert.ok(stderrLines.some((l) => /--no-close-pack/.test(l)));
  assert.ok(fs.files.has(frgLatestPath("/repo", "1.29.1")));
});

test("runFactoryGate: close error leaves pass and evidence intact (fail-soft)", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 751 },
      20: { state: "open", labels: ["factory-gate"], pr: 752 },
    },
  });
  deps.closePr = async () => {
    throw new Error("github unavailable");
  };
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-soft",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-soft",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-soft",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.packClose);
  assert.ok(result.packClose!.errors.length >= 1);
  // Issues still closed (PR close failed but issue path continues)
  assert.deepEqual(result.packClose!.closedIssues.sort((a, b) => a - b), [10, 20]);
  const onDisk = JSON.parse(await fs.readFile(result.evidencePath!));
  assert.equal(onDisk.pass, true);
  assert.equal(onDisk.run_id, result.evidence.run_id);
});

test("runFactoryGate: without packCloseDeps, release pass does not call network (no-op close)", async () => {
  // Regression / bite: production hook is optional when deps omitted; pass still writes.
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-nodeps",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-nodeps",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-nodeps",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.equal(result.packClose, null);
});

test("runFactoryGate: item absent from scoreboard never closed even if labeled factory-gate", async () => {
  const fs = memFs();
  // Scoreboard only has 10 and 20; issue 999 is labeled but not on the scored run.
  const lookedUp: number[] = [];
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 1 },
      20: { state: "open", labels: ["factory-gate"], pr: 2 },
      999: { state: "open", labels: ["factory-gate"], pr: 999 },
    },
  });
  const baseLookup = deps.getIssueStateAndLabels;
  deps.getIssueStateAndLabels = async (n) => {
    lookedUp.push(n);
    return baseLookup(n);
  };
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-scope",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-scope",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-scope",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.ok(!result.packClose!.closedIssues.includes(999));
  assert.ok(!result.packClose!.closedPrs.includes(999));
  assert.ok(!lookedUp.includes(999), "must not repo-wide sweep factory-gate issues");
  assert.deepEqual(result.packClose!.closedIssues.sort((a, b) => a - b), [10, 20]);
});
