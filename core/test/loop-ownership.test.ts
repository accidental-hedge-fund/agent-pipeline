// Tests for durable-run ownership + conflict declarations (#529, capability
// `durable-run-ownership-conflicts`). Every test runs through pure in-memory inputs or an
// in-memory LoopStoreDeps fake — no real filesystem, process, network, git, or subprocess access
// anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConflict,
  evaluateOwnershipEvidence,
  globOverlap,
  normalizeOwnership,
  recordOwnershipEvidence,
  validateOwnershipDeclaration,
} from "../scripts/loop/ownership.ts";
import { acquireLock, initRun, type LoopStoreDeps } from "../scripts/loop/store.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopLedger,
  type OwnershipDeclaration,
} from "../scripts/loop/types.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirrors loop-dependencies.test.ts).
// ---------------------------------------------------------------------------

let counter = 0;

function fakeDeps(): { deps: LoopStoreDeps; calls: string[] } {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-ownership-${counter++}` };

  const deps: LoopStoreDeps = {
    async fsExists(p) {
      calls.push(`fsExists:${p}`);
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async readTextFile(p) {
      calls.push(`readTextFile:${p}`);
      return files.has(p) ? files.get(p)! : null;
    },
    async writeFileAtomic(p, content) {
      calls.push(`writeFileAtomic:${p}`);
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      calls.push(`createFileExclusive:${p}`);
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) {
      calls.push(`removeFile:${p}`);
      files.delete(p);
    },
    async removeFileIfMatches(p, expectedContent) {
      calls.push(`removeFileIfMatches:${p}`);
      if (files.get(p) !== expectedContent) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      calls.push(`appendLine:${p}`);
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
    async mkdirp() {
      calls.push("mkdirp");
    },
    async renameDirExclusive(from, to) {
      calls.push(`renameDirExclusive:${from}->${to}`);
      const fromPrefix = from + "/";
      const published = [...files.keys()].some((k) => k === to || k.startsWith(to + "/"));
      if (published) return false;
      for (const k of [...files.keys()]) {
        if (k.startsWith(fromPrefix)) {
          files.set(to + "/" + k.slice(fromPrefix.length), files.get(k)!);
          files.delete(k);
        }
      }
      return true;
    },
    async listDir(p) {
      calls.push(`listDir:${p}`);
      const prefix = p + "/";
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]);
    },
    async isPidAlive() {
      return true;
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date((clock += 1000)),
    uuid: () => `uuid-${uuidCounter++}`,
    env,
  };
  return { deps, calls };
}

function testContract(overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "milestone", value: "v2" },
    objective: "ship v2",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: [],
    recovery_budgets: { default: 3 },
    recovery_policy: {} as LoopContract["recovery_policy"],
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [{ id: "100", depends_on: [], external_depends_on: [] }],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function testLedger(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: {},
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
}

// ---------------------------------------------------------------------------
// 5.1 Schema validation.
// ---------------------------------------------------------------------------

test("validateOwnershipDeclaration accepts a well-formed declaration", () => {
  const decl: OwnershipDeclaration = {
    exclusive: ["src/widgets/**", "src/gizmos/index.ts"],
    shared: {
      generated_artifact: ["dist/schema.json"],
      package_version: ["package-lock.json"],
      ci_workflow: [".github/workflows/ci.yml"],
    },
    conflicts_with: ["200"],
    exceptions: [
      {
        surface: { kind: "generated_artifact", pattern: "dist/schema.json" },
        counterpart_item_id: "200",
        justification: "reviewed: both items append disjoint keys",
        review_ref: "PR#42",
      },
    ],
  };
  assert.doesNotThrow(() => validateOwnershipDeclaration(decl));
});

test("validateOwnershipDeclaration accepts an absent declaration as unknown ownership", () => {
  assert.doesNotThrow(() => validateOwnershipDeclaration(undefined));
  assert.doesNotThrow(() => validateOwnershipDeclaration(null));
});

test("validateOwnershipDeclaration rejects an unknown shared surface kind", () => {
  assert.throws(
    () => validateOwnershipDeclaration({ shared: { totally_made_up: ["x"] } }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
});

test("validateOwnershipDeclaration rejects a malformed glob", () => {
  assert.throws(
    () => validateOwnershipDeclaration({ exclusive: ["src/a**b/*.ts"] }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
  assert.throws(
    () => validateOwnershipDeclaration({ exclusive: [""] }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
});

test("validateOwnershipDeclaration rejects an exception missing justification or review_ref", () => {
  assert.throws(
    () =>
      validateOwnershipDeclaration({
        shared: { schema_state: ["schema.json"] },
        exceptions: [
          {
            surface: { kind: "schema_state", pattern: "schema.json" },
            counterpart_item_id: "200",
            justification: "",
            review_ref: "PR#1",
          },
        ],
      }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
  assert.throws(
    () =>
      validateOwnershipDeclaration({
        shared: { schema_state: ["schema.json"] },
        exceptions: [
          { surface: { kind: "schema_state", pattern: "schema.json" }, counterpart_item_id: "200", justification: "ok" },
        ],
      }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
});

test("validateOwnershipDeclaration rejects an exception missing counterpart_item_id", () => {
  assert.throws(
    () =>
      validateOwnershipDeclaration({
        shared: { schema_state: ["schema.json"] },
        exceptions: [
          { surface: { kind: "schema_state", pattern: "schema.json" }, justification: "ok", review_ref: "PR#1" },
        ],
      }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "validation",
  );
});

// ---------------------------------------------------------------------------
// 5.2 Normalization determinism.
// ---------------------------------------------------------------------------

test("normalizeOwnership is deterministic across repeated normalization", () => {
  const decl: OwnershipDeclaration = {
    exclusive: ["src/b/**", "src/a/**"],
    shared: { generated_artifact: ["dist/schema.json"], schema_state: ["state.db"] },
  };
  const first = normalizeOwnership(decl);
  const second = normalizeOwnership(decl);
  assert.deepEqual(first, second);
});

test("normalizeOwnership tags every entry with its conflict class and collapses duplicates", () => {
  const decl: OwnershipDeclaration = {
    exclusive: ["src/a/**", "src/a/**", "./src/a/"],
    shared: { generated_artifact: ["dist/schema.json"] },
  };
  const normalized = normalizeOwnership(decl);
  assert.equal(normalized.filter((s) => s.class === "exclusive").length, 2);
  assert.equal(normalized.filter((s) => s.class === "shared").length, 1);
  assert.ok(normalized.every((s) => s.class === "exclusive" || s.class === "shared"));
});

test("normalizeOwnership normalizes an absent/empty declaration to the empty set", () => {
  assert.deepEqual(normalizeOwnership(undefined), []);
  assert.deepEqual(normalizeOwnership({}), []);
});

// ---------------------------------------------------------------------------
// globOverlap semantics — pinned by test, not assumed (golden rule #5).
// ---------------------------------------------------------------------------

test("globOverlap: exact identical paths overlap", () => {
  assert.equal(globOverlap("src/a.ts", "src/a.ts"), true);
});

test("globOverlap: disjoint exact paths do not overlap", () => {
  assert.equal(globOverlap("src/a.ts", "src/b.ts"), false);
});

test("globOverlap: a ** glob overlaps a concrete path beneath it", () => {
  assert.equal(globOverlap("src/a/**", "src/a/foo/bar.ts"), true);
});

test("globOverlap: two ** globs under disjoint prefixes do not overlap", () => {
  assert.equal(globOverlap("src/a/**", "src/b/**"), false);
});

test("globOverlap: single-segment wildcard overlaps a concrete matching segment", () => {
  assert.equal(globOverlap("src/*.ts", "src/a.ts"), true);
  assert.equal(globOverlap("src/*.ts", "src/a.js"), false);
});

// ---------------------------------------------------------------------------
// 5.3 Exact paths & glob overlap evaluation.
// ---------------------------------------------------------------------------

test("evaluateConflict: disjoint exact exclusive paths evaluate disjoint", () => {
  const a = { id: "100", decl: { exclusive: ["src/a.ts"] }, normalized: normalizeOwnership({ exclusive: ["src/a.ts"] }) };
  const b = { id: "200", decl: { exclusive: ["src/b.ts"] }, normalized: normalizeOwnership({ exclusive: ["src/b.ts"] }) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "disjoint");
  assert.equal(verdict.reason, null);
});

test("evaluateConflict: overlapping exclusive globs conflict and name the surface", () => {
  const declA: OwnershipDeclaration = { exclusive: ["src/a/**"] };
  const declB: OwnershipDeclaration = { exclusive: ["src/a/foo.ts"] };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "conflict");
  assert.equal(verdict.reason?.kind, "overlapping_surface");
  if (verdict.reason?.kind === "overlapping_surface") {
    assert.equal(verdict.reason.surface.class, "exclusive");
  }
});

test("evaluateConflict: an exclusive surface overlapping another item's shared surface conflicts", () => {
  const declA: OwnershipDeclaration = { exclusive: ["src/**"] };
  const declB: OwnershipDeclaration = { shared: { public_api: ["src/api.ts"] } };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "conflict");
  assert.equal(verdict.reason?.kind, "overlapping_surface");
});

test("evaluateConflict: dot-dot path aliases do not bypass overlap detection — declaration is rejected", () => {
  assert.throws(() => validateOwnershipDeclaration({ exclusive: ["src/../shared/config.ts"] }));
});

// ---------------------------------------------------------------------------
// 5.4 Shared generated output & package/config/state conflicts by default.
// ---------------------------------------------------------------------------

for (const kind of ["generated_artifact", "package_version", "schema_state", "ci_workflow"] as const) {
  test(`evaluateConflict: two items owning the same ${kind} surface conflict by default`, () => {
    const declA: OwnershipDeclaration = { shared: { [kind]: ["shared/thing"] } };
    const declB: OwnershipDeclaration = { shared: { [kind]: ["shared/thing"] } };
    const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
    const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
    const verdict = evaluateConflict(a, b);
    assert.equal(verdict.verdict, "conflict");
    assert.equal(verdict.reason?.kind, "overlapping_surface");
    if (verdict.reason?.kind === "overlapping_surface") {
      assert.equal(verdict.reason.surface.kind, kind);
      assert.equal(verdict.reason.surface.class, "shared");
    }
  });
}

// ---------------------------------------------------------------------------
// 5.5 Approved exception suppresses only the named shared-surface conflict.
// ---------------------------------------------------------------------------

test("evaluateConflict: a valid reviewed exception flips a shared-surface conflict to disjoint", () => {
  const exception = {
    surface: { kind: "generated_artifact" as const, pattern: "dist/schema.json" },
    counterpart_item_id: "200",
    justification: "both items append disjoint keys, reviewed",
    review_ref: "PR#42",
  };
  const declA: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] }, exceptions: [exception] };
  const declB: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] } };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "disjoint");
  assert.equal(verdict.reason, null);
});

test("evaluateConflict: an exception reviewed for a different pair does not suppress this pair's conflict", () => {
  // Regression for review 1 finding 02334167: an exception reviewed for A<->B must not also
  // suppress A<->C on the same shared surface.
  const exception = {
    surface: { kind: "generated_artifact" as const, pattern: "dist/schema.json" },
    counterpart_item_id: "200",
    justification: "reviewed for 100<->200 only",
    review_ref: "PR#42",
  };
  const declA: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] }, exceptions: [exception] };
  const declB: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] } };
  const declC: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] } };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const c = { id: "300", decl: declC, normalized: normalizeOwnership(declC) };

  const abVerdict = evaluateConflict(a, b);
  assert.equal(abVerdict.verdict, "disjoint");

  const acVerdict = evaluateConflict(a, c);
  assert.equal(acVerdict.verdict, "conflict");
  assert.equal(acVerdict.reason?.kind, "overlapping_surface");
});

test("evaluateConflict: an exception does not suppress an explicit conflicts_with edge", () => {
  const exception = {
    surface: { kind: "generated_artifact" as const, pattern: "dist/schema.json" },
    counterpart_item_id: "200",
    justification: "reviewed anyway",
    review_ref: "PR#42",
  };
  const declA: OwnershipDeclaration = {
    shared: { generated_artifact: ["dist/schema.json"] },
    conflicts_with: ["200"],
    exceptions: [exception],
  };
  const declB: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] } };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "conflict");
  assert.equal(verdict.reason?.kind, "explicit_edge");
});

// ---------------------------------------------------------------------------
// 5.6 Unknown ownership is always conflict, never disjoint.
// ---------------------------------------------------------------------------

test("evaluateConflict: an item with no declaration conflicts with every other item", () => {
  const declB: OwnershipDeclaration = { exclusive: ["src/b/**"] };
  const a = { id: "100", decl: undefined, normalized: normalizeOwnership(undefined) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "conflict");
  assert.equal(verdict.reason?.kind, "unknown_ownership");
});

test("evaluateConflict: an item with an empty declaration is unknown ownership, never disjoint", () => {
  const declA: OwnershipDeclaration = {};
  const declB: OwnershipDeclaration = { exclusive: ["src/b/**"] };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "conflict");
  assert.equal(verdict.reason?.kind, "unknown_ownership");
  assert.notEqual(verdict.verdict, "disjoint");
});

// ---------------------------------------------------------------------------
// 5.7 Determinism & no real I/O.
// ---------------------------------------------------------------------------

test("evaluateConflict is deterministic across repeated calls with identical inputs", () => {
  const declA: OwnershipDeclaration = { exclusive: ["src/a/**"] };
  const declB: OwnershipDeclaration = { exclusive: ["src/a/foo.ts"] };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const first = evaluateConflict(a, b);
  const second = evaluateConflict(a, b);
  assert.deepEqual(first, second);
});

test("recordOwnershipEvidence performs no real network/git/subprocess calls — only the injected store seam", async () => {
  const { deps, calls } = fakeDeps();
  const contract = testContract();
  const ledger = testLedger();
  await initRun(deps, contract, ledger);
  const lock = await acquireLock(deps, "run-1", "claude");

  const evidence = evaluateOwnershipEvidence([{ id: "100" }, { id: "200", ownership: { exclusive: ["src/b/**"] } }]);
  await recordOwnershipEvidence(deps, "run-1", lock.token, evidence);

  // Every call observed went through the injected fake filesystem seam (appendLine et al.) —
  // none of these are real network/git/subprocess primitives.
  assert.ok(calls.length > 0);
  assert.ok(calls.some((c) => c.startsWith("appendLine:")));
});

// ---------------------------------------------------------------------------
// 5.8 Planning evidence records the normalized set and structured reason.
// ---------------------------------------------------------------------------

test("evaluateOwnershipEvidence: a conflicted pair's evidence contains the normalized set and reason", () => {
  const declA: OwnershipDeclaration = { shared: { schema_state: ["state.db"] } };
  const declB: OwnershipDeclaration = { shared: { schema_state: ["state.db"] } };
  const evidence = evaluateOwnershipEvidence([
    { id: "100", ownership: declA },
    { id: "200", ownership: declB },
  ]);
  assert.equal(evidence.items.length, 2);
  assert.deepEqual(evidence.items[0].surfaces, normalizeOwnership(declA));
  assert.deepEqual(evidence.items[1].surfaces, normalizeOwnership(declB));
  assert.equal(evidence.pairs.length, 1);
  const pair = evidence.pairs[0];
  assert.equal(pair.verdict, "conflict");
  assert.equal(pair.reason?.kind, "overlapping_surface");
});

test("evaluateOwnershipEvidence: a disjoint pair's evidence records its verdict and sets", () => {
  const declA: OwnershipDeclaration = { exclusive: ["src/a/**"] };
  const declB: OwnershipDeclaration = { exclusive: ["src/b/**"] };
  const evidence = evaluateOwnershipEvidence([
    { id: "100", ownership: declA },
    { id: "200", ownership: declB },
  ]);
  const pair = evidence.pairs[0];
  assert.equal(pair.verdict, "disjoint");
  assert.equal(pair.reason, null);
  assert.deepEqual(evidence.items[0].surfaces, normalizeOwnership(declA));
  assert.deepEqual(evidence.items[1].surfaces, normalizeOwnership(declB));
});

test("evaluateOwnershipEvidence: rejects a malformed runtime declaration rather than evaluating it", () => {
  // `shared.shared_config` must be an array of glob strings — a bare string would be iterated as
  // characters by normalizeOwnership if validation were skipped, producing an unsafe verdict.
  const malformed = { shared: { shared_config: "config.yml" } } as unknown as OwnershipDeclaration;
  assert.throws(() =>
    evaluateOwnershipEvidence([
      { id: "100", ownership: malformed },
      { id: "200", ownership: { exclusive: ["src/b/**"] } },
    ]),
  );
});

// ---------------------------------------------------------------------------
// 5.9 Planning-input-only: declarations/exceptions grant no merge or review bypass.
// ---------------------------------------------------------------------------

test("evaluateConflict and evaluateOwnershipEvidence expose no merge or review authority", () => {
  const exception = {
    surface: { kind: "generated_artifact" as const, pattern: "dist/schema.json" },
    counterpart_item_id: "200",
    justification: "reviewed",
    review_ref: "PR#42",
  };
  const declA: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] }, exceptions: [exception] };
  const declB: OwnershipDeclaration = { shared: { generated_artifact: ["dist/schema.json"] } };
  const a = { id: "100", decl: declA, normalized: normalizeOwnership(declA) };
  const b = { id: "200", decl: declB, normalized: normalizeOwnership(declB) };
  const verdict = evaluateConflict(a, b);
  assert.equal(verdict.verdict, "disjoint");

  // The verdict is a plain { verdict, reason } record — no field authorizes a merge, waives a
  // review gate, or touches the serialized merge barrier.
  assert.deepEqual(Object.keys(verdict).sort(), ["reason", "verdict"]);

  const evidence = evaluateOwnershipEvidence([
    { id: "100", ownership: declA },
    { id: "200", ownership: declB },
  ]);
  assert.deepEqual(Object.keys(evidence).sort(), ["items", "pairs"]);
});
