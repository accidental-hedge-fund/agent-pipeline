// Tests for work-list declared-dependency population (#615 / #905, capabilities
// `work-list-declared-dependency-population`, `dependency-discovery-source-status`).
// Every discovery test injects WorkListDependencyDiscoverDeps fakes — zero real
// network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allExternalDependenciesSatisfied,
  compileContractItems,
  detectDependencyDeadlock,
} from "../scripts/loop/dependencies.ts";
import {
  admitHardWaits,
  assertDiscoveryCompleteForAdmission,
  collectBlockedByIssueNumbers,
  discoverDeclaredDependencies,
  extractRoadmapDeclaredEdges,
  IncompleteDependencyDiscoveryError,
  parseDeclaredDependencyIds,
  realWorkListDependencyDiscoverDeps,
  type PrerequisiteOpenClass,
  type WorkListDependencyDiscoverDeps,
} from "../scripts/loop/work-list-deps.ts";
import { eligibleIndependentItems } from "../scripts/loop/recovery.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import {
  compileWorkListRun,
  compileWorkListRunFresh,
  resolveSelectorWorkList,
  workListDiscoverDepsForCompile,
  workListRunId,
  type SelectorResolveDeps,
} from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { FACTORY_CONTROL_REPO } from "../scripts/production-engine-pin.ts";
import { LEXICAL_FIXTURE_ROWS } from "./fixtures/declared-deps/lexical-fixtures.ts";

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

test("parseDeclaredDependencyIds: phrase forms (depends on / requires / blocked by / needs)", () => {
  const text = [
    "Depends on #607 for the evaluator isolation work.",
    "This also requires #100.",
    "It is blocked by #12 and needs #3 before merge.",
  ].join("\n");
  assert.deepEqual(parseDeclaredDependencyIds(text), ["607", "100", "12", "3"]);
});

test("parseDeclaredDependencyIds: multi-reference colon/comma and and-joined forms (#905)", () => {
  assert.deepEqual(parseDeclaredDependencyIds("Depends on: #12, #13"), ["12", "13"]);
  assert.deepEqual(parseDeclaredDependencyIds("Depends on #12 and #13"), ["12", "13"]);
  assert.deepEqual(parseDeclaredDependencyIds("needs #5, #6 and #7"), ["5", "6", "7"]);
  // Oxford comma: final prerequisite after `, and` must not be dropped (#905 ffaec452).
  assert.deepEqual(parseDeclaredDependencyIds("Depends on: #12, #13, and #14"), ["12", "13", "14"]);
});

test("parseDeclaredDependencyIds: colon-form list may begin on the next line (#905 80cd834a)", () => {
  assert.deepEqual(parseDeclaredDependencyIds("Depends on:\n#12, #13"), ["12", "13"]);
  assert.deepEqual(parseDeclaredDependencyIds("Depends on:\r\n#12 and #13"), ["12", "13"]);
  assert.deepEqual(parseDeclaredDependencyIds("requires:\n#5\n#6"), ["5", "6"]);
});

test("parseDeclaredDependencyIds: shared lexical fixtures (table-driven)", () => {
  for (const row of LEXICAL_FIXTURE_ROWS) {
    assert.deepEqual(
      parseDeclaredDependencyIds(row.text, row.selfId),
      [...row.expected],
      row.name,
    );
  }
});

test("parseDeclaredDependencyIds: ## Dependency / ## Dependencies section captures bare #N", () => {
  const body = [
    "## Problem",
    "See unrelated issue #999 in the narrative — must not match.",
    "",
    "## Dependency",
    "#607 must establish evaluator isolation before this configuration.",
    "",
    "## Dependencies",
    "Also #100 and #200.",
    "",
    "## Acceptance",
    "Reference #300 only here — not a dependency section.",
  ].join("\n");
  assert.deepEqual(parseDeclaredDependencyIds(body), ["607", "100", "200"]);
});

test("parseDeclaredDependencyIds: ignores self-references and non-canonical ids", () => {
  const text = "Depends on #608 and #007 and #0 and #-1. Self: depends on #608.";
  assert.deepEqual(parseDeclaredDependencyIds(text, "608"), []);
  // Without selfId, 608 is kept; non-canonical still dropped
  assert.deepEqual(parseDeclaredDependencyIds(text), ["608"]);
});

test("parseDeclaredDependencyIds: no false edges from unrelated prose outside dep context", () => {
  const text = [
    "Issue #42 is related history.",
    "The PR for #99 landed last week.",
    "See #1 in the design doc.",
  ].join("\n");
  assert.deepEqual(parseDeclaredDependencyIds(text), []);
});

test("parseDeclaredDependencyIds: empty input", () => {
  assert.deepEqual(parseDeclaredDependencyIds(""), []);
  assert.deepEqual(parseDeclaredDependencyIds("   \n"), []);
});

test("parseDeclaredDependencyIds: dedupes and preserves first-seen order", () => {
  const text = "Depends on #2. Requires #1. Depends on #2 again.\n## Dependency\n#1 #3";
  assert.deepEqual(parseDeclaredDependencyIds(text), ["2", "1", "3"]);
});

// ---------------------------------------------------------------------------
// Roadmap / slice declared-edge extraction (pure)
// ---------------------------------------------------------------------------

test("extractRoadmapDeclaredEdges: writeback _(blocked by #N)_ and table phrase forms", () => {
  const roadmap = [
    "### dependency-unlock",
    "",
    "- **RM-608** #608 — harness roles _(blocked by #607)_",
    "- **RM-607** #607 — eval isolation",
    "",
    "**v1.28.1 — Slice:**",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #610 | Feature B | depends on #609 for the base |",
    "| #609 | Feature A | independent |",
    "| #611 | Mentions #609 in prose only | no phrase — must not invent |",
  ].join("\n");
  assert.deepEqual(extractRoadmapDeclaredEdges(roadmap), [
    { depender: "608", prerequisite: "607" },
    { depender: "610", prerequisite: "609" },
  ]);
});

test("extractRoadmapDeclaredEdges: empty / no declarations", () => {
  assert.deepEqual(extractRoadmapDeclaredEdges(""), []);
  assert.deepEqual(
    extractRoadmapDeclaredEdges("| #100 | Title | rationale |\n| #200 | Other | rationale |"),
    [],
  );
});

// ---------------------------------------------------------------------------
// Discovery seam (injected fakes)
// ---------------------------------------------------------------------------

function fakeDiscoverDeps(opts: {
  bodies?: Record<string, { title: string; body: string } | null>;
  blockedBy?: Record<string, number[] | null>;
  roadmap?: Array<{ depender: string; prerequisite: string }> | null;
  /**
   * Issue id → open / closed / merged (linked PR merged while issue may still
   * be open); omit target to leave getIssueOpenState unset (assume open).
   */
  openState?: Record<string, "open" | "closed" | "merged" | null>;
  throwOnBody?: Set<string>;
  throwOnBlockedBy?: Set<string>;
}): WorkListDependencyDiscoverDeps {
  return {
    async getIssueTitleBody(n) {
      const id = String(n);
      if (opts.throwOnBody?.has(id)) throw new Error(`body fail ${id}`);
      if (!opts.bodies || !(id in opts.bodies)) return { title: "", body: "" };
      return opts.bodies[id] ?? null;
    },
    async getBlockedByIssueNumbers(n) {
      const id = String(n);
      if (opts.throwOnBlockedBy?.has(id)) throw new Error(`blockedBy fail ${id}`);
      if (!opts.blockedBy || !(id in opts.blockedBy)) return [];
      return opts.blockedBy[id] ?? null;
    },
    getRoadmapDeclaredEdges: opts.roadmap === undefined
      ? undefined
      : async () => opts.roadmap,
    getIssueOpenState:
      opts.openState === undefined
        ? undefined
        : async (n) => {
            const id = String(n);
            if (!(id in opts.openState!)) return null;
            return opts.openState![id] ?? null;
          },
  };
}

test("discoverDeclaredDependencies: body section declaration becomes raw depends_on", async () => {
  const result = await discoverDeclaredDependencies(
    ["607", "608"],
    fakeDiscoverDeps({
      bodies: {
        "607": { title: "prereq", body: "no deps" },
        "608": {
          title: "depender",
          body: "## Dependency\n\n#607 must land first.",
        },
      },
    }),
  );
  const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));
  assert.deepEqual(byId["608"]!.depends_on, ["607"]);
  assert.deepEqual(byId["607"]!.depends_on, []);
  assert.equal(result.has_incomplete, false);
  const lex608 = result.observations.find((o) => o.source === "lexical" && o.scope === "608");
  assert.equal(lex608?.status, "observed-with-edges");
});

test("discoverDeclaredDependencies: multi-source union (body + native) dedupes", async () => {
  // Include 607/609 on the selector so hard-wait admission retains both edges.
  const result = await discoverDeclaredDependencies(
    ["607", "608", "609"],
    fakeDiscoverDeps({
      bodies: {
        "607": { title: "", body: "" },
        "608": { title: "x", body: "Depends on #607." },
        "609": { title: "", body: "" },
      },
      blockedBy: {
        "607": [],
        "608": [607, 609],
        "609": [],
      },
    }),
  );
  assert.deepEqual(result.items.find((i) => i.id === "608")!.depends_on, ["607", "609"]);
  const edge607 = result.edge_provenance.find(
    (e) => e.depender === "608" && e.prerequisite === "607",
  );
  assert.ok(edge607);
  assert.ok(edge607!.sources.includes("lexical"));
  assert.ok(edge607!.sources.includes("native-blocked-by"));
});

test("discoverDeclaredDependencies: roadmap edges union when provided", async () => {
  const result = await discoverDeclaredDependencies(
    ["10", "20"],
    fakeDiscoverDeps({
      bodies: {
        "10": { title: "", body: "" },
        "20": { title: "", body: "Depends on #10." },
      },
      roadmap: [
        { depender: "20", prerequisite: "10" },
        { depender: "20", prerequisite: "99" },
      ],
    }),
  );
  // On-selector #10 admitted; off-selector #99 ignored (#1073).
  assert.deepEqual(result.items.find((i) => i.id === "20")!.depends_on, ["10"]);
  assert.ok(
    result.ignored_deps.some(
      (d) => d.depender === "20" && d.target === "99" && d.reason === "not_on_selector",
    ),
  );
  const road = result.observations.find((o) => o.source === "roadmap-declared");
  assert.equal(road?.status, "observed-with-edges");
});

test("discoverDeclaredDependencies: source throw marks unavailable and keeps other sources' edges", async () => {
  const result = await discoverDeclaredDependencies(
    ["1", "2"],
    fakeDiscoverDeps({
      bodies: {
        "1": { title: "", body: "" },
        "2": { title: "", body: "Depends on #1." },
      },
      throwOnBody: new Set(["2"]),
      blockedBy: { "2": [1] },
    }),
  );
  // Body failed for 2, but native blockedBy still contributes 1.
  assert.deepEqual(result.items.find((i) => i.id === "2")!.depends_on, ["1"]);
  assert.equal(result.has_incomplete, true);
  const lex2 = result.observations.find((o) => o.source === "lexical" && o.scope === "2");
  assert.equal(lex2?.status, "unavailable");
  // Multi-item admission must refuse — edges from other sources do not override.
  assert.throws(
    () => assertDiscoveryCompleteForAdmission(["1", "2"], result),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDependencyDiscoveryError);
      assert.equal(err.loopFailureClass, "validation");
      assert.match(err.message, /incomplete/i);
      return true;
    },
  );
});

test("discoverDeclaredDependencies: null observation is unavailable not observed-empty", async () => {
  const result = await discoverDeclaredDependencies(
    ["10", "20"],
    fakeDiscoverDeps({
      bodies: {
        "10": { title: "", body: "" },
        "20": null,
      },
      blockedBy: {
        "10": [],
        "20": null,
      },
    }),
  );
  const lex20 = result.observations.find((o) => o.source === "lexical" && o.scope === "20");
  const nat20 = result.observations.find((o) => o.source === "native-blocked-by" && o.scope === "20");
  assert.equal(lex20?.status, "unavailable");
  assert.equal(nat20?.status, "unavailable");
  assert.notEqual(lex20?.status, "observed-empty");
  assert.equal(result.has_incomplete, true);
});

test("discoverDeclaredDependencies: fully observed empty is observed-empty", async () => {
  const result = await discoverDeclaredDependencies(
    ["100", "200"],
    fakeDiscoverDeps({
      bodies: {
        "100": { title: "a", body: "No deps." },
        "200": { title: "b", body: "Also independent. Mentions #100 in prose only." },
      },
      blockedBy: { "100": [], "200": [] },
    }),
  );
  assert.deepEqual(
    result.items.map((i) => i.depends_on),
    [[], []],
  );
  assert.equal(result.has_incomplete, false);
  for (const o of result.observations) {
    assert.equal(o.status, "observed-empty");
  }
  // Admission proceeds — independent items, no invented edges.
  assert.doesNotThrow(() => assertDiscoveryCompleteForAdmission(["100", "200"], result));
});

test("discoverDeclaredDependencies: lexical edge retained when native is observed-empty", async () => {
  const result = await discoverDeclaredDependencies(
    ["607", "608"],
    fakeDiscoverDeps({
      bodies: {
        "607": { title: "", body: "" },
        "608": { title: "", body: "Depends on #607." },
      },
      blockedBy: { "607": [], "608": [] },
    }),
  );
  assert.deepEqual(result.items.find((i) => i.id === "608")!.depends_on, ["607"]);
  assert.equal(result.has_incomplete, false);
  const nat = result.observations.find((o) => o.source === "native-blocked-by" && o.scope === "608");
  assert.equal(nat?.status, "observed-empty");
  const lex = result.observations.find((o) => o.source === "lexical" && o.scope === "608");
  assert.equal(lex?.status, "observed-with-edges");
});

test("discoverDeclaredDependencies: multi-ref admits on-selector only; off-selector ignored (#1073)", async () => {
  const result = await discoverDeclaredDependencies(
    ["899", "900"],
    fakeDiscoverDeps({
      bodies: {
        "899": { title: "", body: "" },
        "900": { title: "", body: "Depends on: #899, #662" },
      },
      blockedBy: { "899": [], "900": [] },
    }),
  );
  // Hard-wait admission drops #662 (not on selector) before compile partition.
  assert.deepEqual(result.items.find((i) => i.id === "900")!.depends_on, ["899"]);
  assert.ok(
    result.ignored_deps.some(
      (d) => d.depender === "900" && d.target === "662" && d.reason === "not_on_selector",
    ),
  );
});

test("discoverDeclaredDependencies: no declarations → empty depends_on (independent-by-default)", async () => {
  const result = await discoverDeclaredDependencies(
    ["100", "200"],
    fakeDiscoverDeps({
      bodies: {
        "100": { title: "a", body: "No deps." },
        "200": { title: "b", body: "Also independent. Mentions #100 in prose only." },
      },
    }),
  );
  assert.deepEqual(
    result.items.map((i) => i.depends_on),
    [[], []],
  );
});

// ---------------------------------------------------------------------------
// Compile partition (discover → compileContractItems / compileWorkListRunFresh)
// ---------------------------------------------------------------------------

function fakeCfg(repo = "owner/repo"): PipelineConfig {
  return {
    repo,
    base_branch: "main",
    repo_dir: "/tmp/never-used-work-list-deps",
  } as PipelineConfig;
}

test("compile: in-snapshot declaration → depends_on, not external_depends_on", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "607": { title: "prereq", body: "" },
      "608": { title: "dep", body: "## Dependency\n#607" },
    },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["608", "607"],
    "run-in",
    deps,
  );
  const item608 = contract.items.find((i) => i.id === "608")!;
  const item607 = contract.items.find((i) => i.id === "607")!;
  assert.deepEqual(item608.depends_on, ["607"]);
  assert.deepEqual(item608.external_depends_on, []);
  assert.deepEqual(item607.depends_on, []);
  // Topo: 607 before 608 even though input listed 608 first
  assert.ok(
    contract.items.findIndex((i) => i.id === "607") < contract.items.findIndex((i) => i.id === "608"),
  );
  // Provenance on accepted contract
  assert.ok(contract.dependency_discovery);
  assert.ok(
    contract.dependency_discovery!.edge_provenance.some(
      (e) => e.depender === "608" && e.prerequisite === "607" && e.sources.includes("lexical"),
    ),
  );
  assert.ok(contract.dependency_discovery!.observations.every((o) => o.observation_id));
  assert.equal(discovery.has_incomplete, false);
});

test("compile: multi-ref admits on-selector hard wait; off-selector becomes ignored_dep (#1073)", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "899": { title: "", body: "" },
      "900": { title: "", body: "Depends on: #899, #662" },
    },
    blockedBy: { "899": [], "900": [] },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["899", "900"],
    "run-900",
    deps,
  );
  const item900 = contract.items.find((i) => i.id === "900")!;
  assert.deepEqual(item900.depends_on, ["899"]);
  // Off-selector open refs no longer land on external_depends_on (#1073).
  assert.deepEqual(item900.external_depends_on, []);
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "900" && d.target === "662" && d.reason === "not_on_selector",
    ),
  );
  assert.ok(
    contract.dependency_discovery?.ignored_deps?.some(
      (d) => d.depender === "900" && d.target === "662" && d.reason === "not_on_selector",
    ),
  );
});

test("compile: out-of-snapshot declaration is ignored (not external hard wait) (#1073)", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "608": { title: "dep", body: "Depends on #607." },
    },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["608"],
    "run-ext",
    deps,
  );
  const item = contract.items[0]!;
  assert.equal(item.id, "608");
  assert.deepEqual(item.depends_on, []);
  assert.deepEqual(item.external_depends_on, []);
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "608" && d.target === "607" && d.reason === "not_on_selector",
    ),
  );
});

test("compile: multi-item refuses incomplete discovery and produces no contract", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "1": { title: "", body: "" },
      "2": { title: "", body: "Depends on #1." },
    },
    blockedBy: {
      "1": [],
      "2": null, // native unobservable
    },
  });
  await assert.rejects(
    () => compileWorkListRunFresh(fakeCfg(), "claude", ["1", "2"], "run-refuse", deps),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDependencyDiscoveryError);
      assert.equal(err.loopFailureClass, "validation");
      assert.match(err.message, /native-blocked-by/);
      assert.match(err.message, /incomplete|unavailable/i);
      return true;
    },
  );
});

test("compile: factory-owned single-item refuses incomplete discovery (no contract/ledger) (#905 0f108c73)", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "42": { title: "solo", body: "" },
    },
    blockedBy: {
      "42": null, // native unobservable — incomplete, not observed-empty
    },
  });
  await assert.rejects(
    () =>
      compileWorkListRunFresh(
        fakeCfg(FACTORY_CONTROL_REPO),
        "claude",
        ["42"],
        "run-factory-single-refuse",
        deps,
      ),
    (err: unknown) => {
      assert.ok(err instanceof IncompleteDependencyDiscoveryError);
      assert.equal(err.loopFailureClass, "validation");
      assert.match(err.message, /factory-owned|incomplete/i);
      assert.match(err.message, /native-blocked-by/);
      assert.ok(
        err.incomplete.some(
          (o) => o.source === "native-blocked-by" && o.scope === "42",
        ),
      );
      return true;
    },
  );
});

test("compile: non-factory single-item still admits when a source is incomplete (exploratory)", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "42": { title: "solo", body: "Depends on #99." },
    },
    blockedBy: {
      "42": null,
    },
  });
  const { contract, ledger, discovery } = await compileWorkListRunFresh(
    fakeCfg("acme/widget"),
    "claude",
    ["42"],
    "run-exploratory-single",
    deps,
  );
  assert.equal(discovery.has_incomplete, true);
  assert.equal(contract.items.length, 1);
  assert.equal(contract.items[0]!.id, "42");
  assert.ok(ledger.items["42"]);
});

test("compile: no declarations → empty lists; input order does not invent edges", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "200": { title: "b", body: "prose #100 only" },
      "100": { title: "a", body: "independent" },
    },
  });
  const { contract } = await compileWorkListRunFresh(fakeCfg(), "claude", ["200", "100"], "run-ind", deps);
  for (const item of contract.items) {
    assert.deepEqual(item.depends_on, []);
    assert.deepEqual(item.external_depends_on, []);
  }
  // Input order preserved when no edges (topo tie-break)
  assert.deepEqual(
    contract.items.map((i) => i.id),
    ["200", "100"],
  );
});

test("compile: in-snapshot cycle from discovered edges fails validation", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "100": { title: "", body: "Depends on #200." },
      "200": { title: "", body: "Depends on #100." },
    },
  });
  await assert.rejects(
    () => compileWorkListRunFresh(fakeCfg(), "claude", ["100", "200"], "run-cycle", deps),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "validation");
      assert.match(err.message, /cycle/i);
      return true;
    },
  );
});

test("compile: repeated compile of same declarations is stable", async () => {
  const depsFactory = (): WorkListDependencyDiscoverDeps =>
    fakeDiscoverDeps({
      bodies: {
        "1": { title: "", body: "" },
        "2": { title: "", body: "Depends on #1." },
        "3": { title: "", body: "Requires #2." },
      },
    });
  const a = await compileWorkListRunFresh(fakeCfg(), "claude", ["3", "1", "2"], "run-stable", depsFactory());
  const b = await compileWorkListRunFresh(fakeCfg(), "claude", ["3", "1", "2"], "run-stable", depsFactory());
  assert.deepEqual(
    a.contract.items.map((i) => ({ id: i.id, depends_on: i.depends_on, external_depends_on: i.external_depends_on })),
    b.contract.items.map((i) => ({ id: i.id, depends_on: i.depends_on, external_depends_on: i.external_depends_on })),
  );
  assert.deepEqual(
    a.contract.items.map((i) => i.id),
    ["1", "2", "3"],
  );
});

test("workListRunId ignores discovered edges (issue list only)", async () => {
  const issues = ["607", "608"] as const;
  const idA = workListRunId("owner/repo", "claude", issues);
  const depsWithEdge = fakeDiscoverDeps({
    bodies: {
      "607": { title: "", body: "" },
      "608": { title: "", body: "Depends on #607." },
    },
  });
  const depsEmpty = fakeDiscoverDeps({
    bodies: {
      "607": { title: "", body: "" },
      "608": { title: "", body: "" },
    },
  });
  const withEdge = await compileWorkListRunFresh(fakeCfg(), "claude", issues, idA, depsWithEdge);
  const empty = await compileWorkListRunFresh(fakeCfg(), "claude", issues, idA, depsEmpty);
  assert.equal(withEdge.contract.run_id, empty.contract.run_id);
  assert.equal(withEdge.contract.run_id, idA);
  assert.notDeepEqual(
    withEdge.contract.items.find((i) => i.id === "608")!.depends_on,
    empty.contract.items.find((i) => i.id === "608")!.depends_on,
  );
});

// ---------------------------------------------------------------------------
// Regression: population must not be skipped / empty-hardcode restored
// ---------------------------------------------------------------------------

test("regression: compileWorkListRunFresh feeds declared edges (bites if population skipped)", async () => {
  // Motivating production case: #608 body ## Dependency on #607.
  const deps = fakeDiscoverDeps({
    bodies: {
      "607": { title: "eval isolation", body: "" },
      "608": {
        title: "harness roles",
        body:
          "## Problem\n\nConfig.\n\n## Dependency\n\n#607 must establish evaluator isolation before this configuration is used.",
      },
    },
    blockedBy: { "607": [], "608": [] },
  });
  const { contract } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["607", "608"],
    "run-regression-615",
    deps,
  );
  const item608 = contract.items.find((i) => i.id === "608")!;
  assert.deepEqual(
    item608.depends_on,
    ["607"],
    "declared ## Dependency on #607 must land on in-snapshot depends_on — empty hardcode would leave this []",
  );
  assert.deepEqual(item608.external_depends_on, []);

  // Prove the pure empty path is what we'd get WITHOUT discovery — documents the bite.
  const emptyCompile = compileWorkListRun(fakeCfg(), "claude", ["607", "608"], "run-empty");
  assert.deepEqual(
    emptyCompile.contract.items.find((i) => i.id === "608")!.depends_on,
    [],
    "sync compile without rawItems remains independent-by-default for tests",
  );
});

test("compileContractItems still partitions when fed discovered raw items directly", () => {
  const items = compileContractItems([
    { id: "608", depends_on: ["607"] },
    { id: "607", depends_on: [] },
  ]);
  assert.deepEqual(
    items.map((i) => ({ id: i.id, depends_on: i.depends_on, external_depends_on: i.external_depends_on })),
    [
      { id: "607", depends_on: [], external_depends_on: [] },
      { id: "608", depends_on: ["607"], external_depends_on: [] },
    ],
  );
});

// ---------------------------------------------------------------------------
// Production path: selector resolution → roadmap edges → compile (#615 2e0c6562)
// ---------------------------------------------------------------------------

test("resolveSelectorWorkList: roadmap-slice carries declared edges from ROADMAP.md", async () => {
  const roadmap = [
    "**v9.1.0 — Test slice:**",
    "",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #608 | Depender | _(blocked by #607)_ |",
    "| #607 | Prerequisite | independent |",
  ].join("\n");
  // listOpenIssues is required for pipeline:epic exclusion on roadmap-slice (#766);
  // return non-epic inventory so exclusion is a no-op for this edge-carry assertion.
  const deps: SelectorResolveDeps = {
    listOpenIssues: async () => [
      { number: 607, labels: [], milestone: null },
      { number: 608, labels: [], milestone: null },
    ],
    readRoadmap: async () => roadmap,
  };
  const resolved = await resolveSelectorWorkList(
    fakeCfg(),
    { type: "roadmap-slice", value: "v9.1.0" },
    deps,
  );
  assert.deepEqual(resolved.issues, ["607", "608"]);
  assert.deepEqual(resolved.roadmapDeclaredEdges, [
    { depender: "608", prerequisite: "607" },
  ]);
});

test("production-path compile: roadmap-only edge becomes depends_on (no body/native)", async () => {
  // Edge exists ONLY in the roadmap graph — bodies empty, blockedBy empty.
  // Bites if production omit getRoadmapDeclaredEdges (finding 2e0c6562).
  const roadmap = [
    "**v2.0.0 — Slice:**",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #608 | Config | blocked by #607 |",
    "| #607 | Isolation | none |",
  ].join("\n");
  const selectorDeps: SelectorResolveDeps = {
    listOpenIssues: async () => [],
    readRoadmap: async () => roadmap,
  };
  const resolved = await resolveSelectorWorkList(
    fakeCfg(),
    { type: "roadmap-slice", value: "v2.0.0" },
    selectorDeps,
  );
  // Production wires edges through workListDiscoverDepsForCompile; here we
  // inject body/native fakes so the test stays network-free while still using
  // the same roadmap-edge plumbing as the production factory.
  const discoverDeps: WorkListDependencyDiscoverDeps = {
    getIssueTitleBody: async () => ({ title: "", body: "" }),
    getBlockedByIssueNumbers: async () => [],
    getRoadmapDeclaredEdges: async () => resolved.roadmapDeclaredEdges,
  };
  // Sanity: factory returns a seam that exposes the same edges.
  const factoryDeps = workListDiscoverDepsForCompile(fakeCfg(), resolved.roadmapDeclaredEdges);
  assert.deepEqual(await factoryDeps.getRoadmapDeclaredEdges!(), resolved.roadmapDeclaredEdges);

  const { contract } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    resolved.issues,
    "run-roadmap-only",
    discoverDeps,
  );
  const item608 = contract.items.find((i) => i.id === "608")!;
  assert.deepEqual(
    item608.depends_on,
    ["607"],
    "roadmap-only declared edge must land on in-snapshot depends_on",
  );
  assert.deepEqual(item608.external_depends_on, []);
  assert.ok(
    contract.items.findIndex((i) => i.id === "607") < contract.items.findIndex((i) => i.id === "608"),
  );
});

// ---------------------------------------------------------------------------
// Production GraphQL blockedBy pagination (#615 / finding 623ee5cb)
// ---------------------------------------------------------------------------

function blockedByGraphqlPage(opts: {
  title?: string;
  body?: string;
  numbers: number[];
  hasNextPage: boolean;
  endCursor: string | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          title: opts.title ?? "depender",
          body: opts.body ?? "",
          blockedBy: {
            pageInfo: { hasNextPage: opts.hasNextPage, endCursor: opts.endCursor },
            nodes: opts.numbers.map((number) => ({ number })),
          },
        },
      },
    },
  });
}

test("collectBlockedByIssueNumbers: dedupes and skips invalid nodes", () => {
  const seen = new Set<number>();
  const out: number[] = [];
  collectBlockedByIssueNumbers(
    [{ number: 1 }, { number: 2 }, { number: 1 }, null, { number: 0 }, { number: -3 }, {}],
    seen,
    out,
  );
  assert.deepEqual(out, [1, 2]);
});

test("realWorkListDependencyDiscoverDeps: paginates blockedBy past first 100 (623ee5cb)", async () => {
  // First page: 100 blockers; second page carries #101 — a first-page-only
  // query would silently drop 101 and treat the partial list as complete.
  const page1Numbers = Array.from({ length: 100 }, (_, i) => i + 1);
  const calls: string[][] = [];
  const runGhApi = async (args: string[]): Promise<string> => {
    calls.push([...args]);
    // Parse after= from args (only present on page 2+).
    let after: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-F" && args[i + 1]!.startsWith("after=")) {
        after = args[i + 1]!.slice("after=".length);
      }
    }
    if (!after) {
      return blockedByGraphqlPage({
        numbers: page1Numbers,
        hasNextPage: true,
        endCursor: "cursor-page-1",
      });
    }
    assert.equal(after, "cursor-page-1");
    return blockedByGraphqlPage({
      numbers: [101, 50], // 50 already on page 1 — must dedupe
      hasNextPage: false,
      endCursor: "cursor-page-2",
    });
  };

  const deps = realWorkListDependencyDiscoverDeps(fakeCfg(), { runGhApi });
  const blockedBy = await deps.getBlockedByIssueNumbers(608);
  assert.ok(blockedBy);
  assert.equal(blockedBy.length, 101, "must include the blocker beyond the first page");
  assert.equal(blockedBy[0], 1);
  assert.equal(blockedBy[99], 100);
  assert.equal(blockedBy[100], 101);
  assert.ok(!blockedBy.includes(50) || blockedBy.filter((n) => n === 50).length === 1);
  assert.equal(calls.length, 2, "must issue a follow-up cursor query");

  // Native discovery still observes beyond-first-page ids; hard-wait admission
  // drops off-selector targets (#1073) rather than treating them as gates.
  const result = await discoverDeclaredDependencies(["608"], deps);
  assert.deepEqual(result.items[0]!.depends_on, []);
  assert.ok(
    result.ignored_deps.some((d) => d.depender === "608" && d.target === "101" && d.reason === "not_on_selector"),
  );
  assert.ok(
    result.ignored_deps.some((d) => d.depender === "608" && d.target === "1" && d.reason === "not_on_selector"),
  );
});

test("realWorkListDependencyDiscoverDeps: single-page blockedBy needs no after cursor", async () => {
  let calls = 0;
  const runGhApi = async (args: string[]): Promise<string> => {
    calls += 1;
    for (let i = 0; i < args.length - 1; i++) {
      assert.ok(
        !(args[i] === "-F" && args[i + 1]!.startsWith("after=")),
        "first/only page must not send after=",
      );
    }
    return blockedByGraphqlPage({
      title: "x",
      body: "Depends on #1.", // lexical still parsed separately; native is 7
      numbers: [7],
      hasNextPage: false,
      endCursor: null,
    });
  };
  const deps = realWorkListDependencyDiscoverDeps(fakeCfg(), { runGhApi });
  assert.deepEqual(await deps.getBlockedByIssueNumbers(9), [7]);
  const text = await deps.getIssueTitleBody(9);
  assert.deepEqual(text, { title: "x", body: "Depends on #1." });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Hard-wait admission (#1073) — pure helper + dogfood / deadlock fixtures
// ---------------------------------------------------------------------------

test("admitHardWaits: open on-selector admitted; off-selector / closed / not_open ignored", () => {
  const selector = new Set(["647", "599", "901"]);
  const openState = new Map<string, PrerequisiteOpenClass>([
    ["599", "open"],
    ["822", "open"],
    ["900", "closed"],
    ["901", "not_open"],
  ]);
  const { admitted, ignored } = admitHardWaits(
    [
      { depender: "647", prerequisite: "599" },
      { depender: "647", prerequisite: "822" },
      { depender: "647", prerequisite: "900" },
      { depender: "647", prerequisite: "901" },
    ],
    selector,
    openState,
  );
  assert.deepEqual(admitted, [{ depender: "647", prerequisite: "599" }]);
  assert.deepEqual(ignored, [
    { depender: "647", target: "822", reason: "not_on_selector" },
    { depender: "647", target: "900", reason: "closed" },
    { depender: "647", target: "901", reason: "not_open" },
  ]);
});

test("admitHardWaits: missing openState entry is not_open on-selector", () => {
  const { admitted, ignored } = admitHardWaits(
    [{ depender: "1", prerequisite: "2" }],
    new Set(["1", "2"]),
    new Map(),
  );
  assert.deepEqual(admitted, []);
  assert.deepEqual(ignored, [{ depender: "1", target: "2", reason: "not_open" }]);
});

test("admitHardWaits: unobserved off-selector is not_on_selector", () => {
  const { admitted, ignored } = admitHardWaits(
    [{ depender: "1", prerequisite: "99" }],
    new Set(["1"]),
    new Map(), // missing → not_open, but off-selector wins
  );
  assert.deepEqual(admitted, []);
  assert.deepEqual(ignored, [{ depender: "1", target: "99", reason: "not_on_selector" }]);
});

test("#1073 soft Related-only / see #B: no hard wait, no dependency_deadlock", async () => {
  const softBody = [
    "## Related",
    "See #822 for later-milestone context.",
    "History of #100.",
  ].join("\n");
  assert.deepEqual(parseDeclaredDependencyIds(softBody, "838"), []);

  const deps = fakeDiscoverDeps({
    bodies: {
      "838": { title: "dogfood soft", body: softBody },
    },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["838"],
    "run-soft-related",
    deps,
  );
  const item = contract.items[0]!;
  assert.deepEqual(item.depends_on, []);
  assert.deepEqual(item.external_depends_on, []);
  assert.deepEqual(discovery.ignored_deps, []);

  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-soft-related",
    items: {
      "838": { id: "838", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  const loopContract = contract as unknown as LoopContract;
  assert.deepEqual(eligibleIndependentItems(loopContract, ledger, {}), ["838"]);
  assert.equal(detectDependencyDeadlock(loopContract, ledger, {}), null);
});

test("#1073 Depends on open on-selector: hard wait hold (#647→#599 class)", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "599": { title: "prereq", body: "" },
      "647": { title: "handoff", body: "Depends on: #599" },
    },
    openState: { "599": "open", "647": "open" },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["647", "599"],
    "run-hard-intrain",
    deps,
  );
  const item647 = contract.items.find((i) => i.id === "647")!;
  assert.deepEqual(item647.depends_on, ["599"]);
  assert.deepEqual(item647.external_depends_on, []);
  assert.deepEqual(discovery.ignored_deps, []);

  const pendingBoth: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-hard-intrain",
    items: {
      "599": { id: "599", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
      "647": { id: "647", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  const loopContract = contract as unknown as LoopContract;
  // 599 is free; 647 is held on the admitted hard wait.
  assert.deepEqual(eligibleIndependentItems(loopContract, pendingBoth, {}), ["599"]);
  assert.ok(!eligibleIndependentItems(loopContract, pendingBoth, {}).includes("647"));

  // After prereq reaches terminal success, 647 becomes eligible.
  const afterPrereq: LoopLedger = {
    ...pendingBoth,
    items: {
      "599": { id: "599", state: "ready", history: [], recovery_budgets_remaining: { default: 3 } },
      "647": { id: "647", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
  };
  assert.deepEqual(eligibleIndependentItems(loopContract, afterPrereq, {}), ["647"]);
  assert.equal(detectDependencyDeadlock(loopContract, afterPrereq, {}), null);

  // Admitted hard wait still appears in a dependency_deadlock chain when the
  // prereq ledger entry is missing (structurally unrunnable frontier).
  const dangling: LoopContract = {
    ...loopContract,
    schema: LOOP_CONTRACT_SCHEMA,
    items: [
      { id: "599", depends_on: [], external_depends_on: [] },
      { id: "647", depends_on: ["599"], external_depends_on: [] },
    ],
  };
  const missingPrereqLedger: LoopLedger = {
    ...pendingBoth,
    items: {
      "647": { id: "647", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
  };
  const chain = detectDependencyDeadlock(dangling, missingPrereqLedger, {});
  assert.ok(chain);
  assert.ok(chain!.some((e) => e.item_id === "647" && e.waiting_on === "599" && e.kind === "in_run"));
});

test("#1073 Depends on closed target: ignored; A eligible", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "838": { title: "a", body: "Depends on: #822" },
    },
    openState: { "822": "closed" },
  });
  // 822 not on selector AND closed → reason closed (closed checked first).
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["838"],
    "run-closed-dep",
    deps,
  );
  const item = contract.items[0]!;
  assert.deepEqual(item.depends_on, []);
  assert.deepEqual(item.external_depends_on, []);
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "838" && d.target === "822" && d.reason === "closed",
    ),
  );
  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-closed-dep",
    items: {
      "838": { id: "838", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  const loopContract = contract as unknown as LoopContract;
  assert.deepEqual(eligibleIndependentItems(loopContract, ledger, {}), ["838"]);
  assert.equal(detectDependencyDeadlock(loopContract, ledger, {}), null);
});

test("#1073 bare #B under ## Dependencies open off-selector: no ship-stop (#838/#839 class)", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "838": {
        title: "slice",
        body: ["## Dependencies", "#822 was related dogfood work."].join("\n"),
      },
      "839": {
        title: "sibling",
        body: ["## Dependencies", "#822"].join("\n"),
      },
    },
    openState: { "822": "open", "838": "open", "839": "open" },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["838", "839"],
    "run-deps-section-offtrain",
    deps,
  );
  for (const id of ["838", "839"]) {
    const item = contract.items.find((i) => i.id === id)!;
    assert.deepEqual(item.depends_on, []);
    assert.deepEqual(item.external_depends_on, []);
  }
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "838" && d.target === "822" && d.reason === "not_on_selector",
    ),
  );
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "839" && d.target === "822" && d.reason === "not_on_selector",
    ),
  );
  // Lexical still extracts bare section refs as candidates (admission drops them).
  assert.deepEqual(
    parseDeclaredDependencyIds("## Dependencies\n#822", "838"),
    ["822"],
  );

  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-deps-section-offtrain",
    items: {
      "838": { id: "838", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
      "839": { id: "839", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  const loopContract = contract as unknown as LoopContract;
  const eligible = eligibleIndependentItems(loopContract, ledger, {});
  assert.ok(eligible.includes("838"));
  assert.ok(eligible.includes("839"));
  assert.equal(detectDependencyDeadlock(loopContract, ledger, {}), null);
  assert.equal(allExternalDependenciesSatisfied(contract.items[0]!, {}), true);
});

test("#1073 closed on-selector Depends on is not a hard wait", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "100": { title: "done", body: "" },
      "200": { title: "next", body: "Depends on #100" },
    },
    openState: { "100": "closed", "200": "open" },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["100", "200"],
    "run-closed-on-selector",
    deps,
  );
  assert.deepEqual(contract.items.find((i) => i.id === "200")!.depends_on, []);
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "200" && d.target === "100" && d.reason === "closed",
    ),
  );
});

test("#1073 on-selector open issue with merged linked PR is not a hard wait (depender eligible)", async () => {
  // Issue still open at Issue.state, but linked PR is merged → closed/merged-class
  // non-admission (spec: satisfied via merged linked PR under observation seam).
  const deps = fakeDiscoverDeps({
    bodies: {
      "100": { title: "shipped via PR; issue left open", body: "" },
      "200": { title: "next", body: "Depends on #100" },
    },
    openState: { "100": "merged", "200": "open" },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["100", "200"],
    "run-merged-pr-on-selector",
    deps,
  );
  const item200 = contract.items.find((i) => i.id === "200")!;
  assert.deepEqual(item200.depends_on, []);
  assert.deepEqual(item200.external_depends_on, []);
  assert.ok(
    discovery.ignored_deps.some(
      (d) => d.depender === "200" && d.target === "100" && d.reason === "closed",
    ),
    "merged linked-PR satisfaction must ignore with closed/merged-class reason",
  );

  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-merged-pr-on-selector",
    items: {
      "100": { id: "100", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
      "200": { id: "200", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  const loopContract = contract as unknown as LoopContract;
  const eligible = eligibleIndependentItems(loopContract, ledger, {});
  assert.ok(eligible.includes("200"), "depender must be eligible once merged-PR prereq is non-admitted");
  assert.ok(eligible.includes("100"));
  assert.equal(detectDependencyDeadlock(loopContract, ledger, {}), null);
});

test("realWorkListDependencyDiscoverDeps: open issue + merged linked PR → merged admission class", async () => {
  // Production observation seam: Issue.state OPEN, linked PR MERGED → "merged".
  const deps = realWorkListDependencyDiscoverDeps(fakeCfg(), {
    runGhApi: async () =>
      JSON.stringify({
        data: { repository: { issue: { state: "OPEN" } } },
      }),
    findPrForIssue: async (n) => (n === 100 ? 55 : null),
    getPrState: async (pr) => (pr === 55 ? "merged" : null),
  });
  assert.equal(await deps.getIssueOpenState!(100), "merged");
  assert.equal(await deps.getIssueOpenState!(200), "open");
});

test("realWorkListDependencyDiscoverDeps: open issue + no merged PR stays open", async () => {
  const deps = realWorkListDependencyDiscoverDeps(fakeCfg(), {
    runGhApi: async () =>
      JSON.stringify({
        data: { repository: { issue: { state: "OPEN" } } },
      }),
    findPrForIssue: async () => null,
    getPrState: async () => null,
  });
  assert.equal(await deps.getIssueOpenState!(42), "open");
});

test("#1073 phrase under Related still extracts; open on-selector remains hard wait", async () => {
  const deps = fakeDiscoverDeps({
    bodies: {
      "599": { title: "", body: "" },
      "647": {
        title: "",
        body: ["## Related", "Depends on: #599", "See also bare #822."].join("\n"),
      },
    },
  });
  const { contract, discovery } = await compileWorkListRunFresh(
    fakeCfg(),
    "claude",
    ["647", "599"],
    "run-phrase-under-related",
    deps,
  );
  assert.deepEqual(contract.items.find((i) => i.id === "647")!.depends_on, ["599"]);
  assert.ok(!discovery.ignored_deps.some((d) => d.target === "599"));
  // Bare #822 under Related never entered raw set.
  assert.ok(!discovery.ignored_deps.some((d) => d.target === "822"));
});
