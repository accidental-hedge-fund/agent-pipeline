// Factory Reliability Gate (#723) — schema, scoring, evidence I/O, release lookup,
// and driver seams. Zero real network/git/subprocess; in-memory fs only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRG_SCHEMA_VERSION,
  FRG_SCENARIO_IDS,
  FRG_LAYER_A_WAIVERS,
  FRG_SCENARIO_OWNERSHIP,
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
  type FrgEvidence,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";
import type { LoopContract, LoopLedger } from "../scripts/loop/types.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA } from "../scripts/loop/types.ts";

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

test("computeFrgEvidence: green unit-shaped pass with K clean ready items", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-1",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
      { item_id: "3", state: "waiting", blocker_theme: "missing-authority" },
    ],
    now: () => new Date("2026-07-30T12:00:00.000Z"),
  });
  assert.equal(evidence.schema_version, FRG_SCHEMA_VERSION);
  assert.equal(evidence.version, "1.29.1");
  assert.equal(evidence.run_id, "frg-test-1");
  assert.equal(evidence.pass, true);
  assert.equal(evidence.scoreboard.ready_clean_count, 2);
  assert.equal(evidence.thresholds.min_clean_ready_to_deploy, DEFAULT_FRG_THRESHOLDS.min_clean_ready_to_deploy);
  const throughput = evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(throughput?.status, "pass");
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
  const a = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-a",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
  assert.equal(a.pass, true);
  assert.equal(a.version, "1.29.1");
  // Different version requires its own artifact — scoring for 1.30.0 is independent.
  const b = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-b",
    items: [{ item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" }],
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

// ---------------------------------------------------------------------------
// Evidence I/O + lookup
// ---------------------------------------------------------------------------

test("writeFrgEvidence + lookupFrgPass: pass and fail distinguished from missing", async () => {
  const fs = memFs();
  const repo = "/repo";
  const passEv = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-pass-1",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
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

  const passEv = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-ok",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
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
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-attach-1",
    loop_run_id: "loop-abc",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
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

test("runFactoryGate: scoreInput path writes evidence and exits 0 on pass", async () => {
  const fs = memFs();
  const lines: string[] = [];
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      json: true,
      scoreInput: {
        version: "1.29.1",
        run_id: "frg-driver-1",
        items: [
          { item_id: "1", state: "ready", ready_clean: true },
          { item_id: "2", state: "ready", ready_clean: true },
        ],
      },
      stdout: (m) => lines.push(m),
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.ok(result.evidencePath?.includes("frg-driver-1"));
  assert.ok(result.latestPath?.includes("latest.json"));
  const parsed = parseFrgEvidenceJson(lines.join("\n"));
  assert.equal(parsed.run_id, "frg-driver-1");
});

test("runFactoryGate: fail exits non-zero", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
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
      scoreInput: {
        version: "1.0.0",
        run_id: "frg-no-merge",
        items: [
          { item_id: "1", state: "ready", ready_clean: true },
          { item_id: "2", state: "ready", ready_clean: true },
        ],
      },
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
