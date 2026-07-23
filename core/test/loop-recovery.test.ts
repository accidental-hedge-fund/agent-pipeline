// Tests for typed durable-run blocker classification & recovery policy
// (#509, capability `durable-blocker-classification`). Every test runs
// through an in-memory LoopStoreDeps fake (mirrors loop-store.test.ts) — no
// real filesystem, process, network, or subprocess access.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileRecoveryPolicy,
  DEFAULT_RECOVERY_POLICY,
  classifyBlocker,
  recordNeedsHumanClassificationStop,
  fingerprintEvidence,
  blockItem,
  classifyAndBlockItem,
  recoverItem,
  isRunFatalBlocked,
  eligibleIndependentItems,
} from "../scripts/loop/recovery.ts";
import { mapLegacyThemeToBlockerClass } from "../scripts/loop/import.ts";
import { initRun, readLedger, acquireLock, type LoopStoreDeps } from "../scripts/loop/store.ts";
import {
  DURABLE_BLOCKER_CLASSES,
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type DurableBlockerClass,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";

// ---------------------------------------------------------------------------
// In-memory fake filesystem (mirrors loop-store.test.ts's fakeDeps).
// ---------------------------------------------------------------------------

let fakeDepsCounter = 0;

function fakeDeps(overrides: Partial<LoopStoreDeps> = {}): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const isolatedEnv = { AGENT_PIPELINE_STATE_HOME: `/state-recovery-${fakeDepsCounter++}` };

  const deps: LoopStoreDeps = {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async readTextFile(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async writeFileAtomic(p, content) {
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) {
      files.delete(p);
    },
    async removeFileIfMatches(p, expectedContent) {
      if (files.get(p) !== expectedContent) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
    async mkdirp() {},
    async renameDirExclusive(from, to) {
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
      const prefix = p + "/";
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]);
    },
    async isPidAlive() {
      return true;
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date(clock),
    uuid: () => `uuid-${uuidCounter++}`,
    env: isolatedEnv,
    ...overrides,
  };
  return { deps, files };
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
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function testLedger(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: {
      "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
      "200": { id: "200", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
  };
}

async function setup(contractOverrides: Partial<LoopContract> = {}) {
  const { deps, files } = fakeDeps();
  const contract = testContract(contractOverrides);
  await initRun(deps, contract, testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  return { deps, files, contract, token };
}

// ---------------------------------------------------------------------------
// Policy compilation — fail closed.
// ---------------------------------------------------------------------------

test("compileRecoveryPolicy: the default policy covers every DurableBlockerClass", () => {
  for (const cls of DURABLE_BLOCKER_CLASSES) {
    assert.ok(DEFAULT_RECOVERY_POLICY[cls], `missing policy entry for "${cls}"`);
  }
  assert.equal(Object.keys(DEFAULT_RECOVERY_POLICY).length, DURABLE_BLOCKER_CLASSES.length);
});

test("compileRecoveryPolicy: a missing class entry fails compilation closed", () => {
  const partial: Record<string, unknown> = { ...DEFAULT_RECOVERY_POLICY };
  delete partial["workflow-engine-defect"];
  assert.throws(() => compileRecoveryPolicy(partial), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "validation");
    assert.match((err as Error).message, /workflow-engine-defect/);
    return true;
  });
});

test("compileRecoveryPolicy: a recipe outside the permitted catalogue fails compilation", () => {
  const bad = {
    ...DEFAULT_RECOVERY_POLICY,
    "implementation-ci": { ...DEFAULT_RECOVERY_POLICY["implementation-ci"], recipes: ["merge_pr"] },
  };
  assert.throws(() => compileRecoveryPolicy(bad), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "validation");
    return true;
  });
});

test("compileRecoveryPolicy: a malformed entry (missing terminal_outcome) fails compilation", () => {
  const bad = { ...DEFAULT_RECOVERY_POLICY, "implementation-ci": { ...DEFAULT_RECOVERY_POLICY["implementation-ci"], terminal_outcome: undefined } };
  assert.throws(() => compileRecoveryPolicy(bad), /terminal_outcome/);
});

test("compileRecoveryPolicy: missing-authority / specification-decision must route to human_authority with no recipes", () => {
  const bad = { ...DEFAULT_RECOVERY_POLICY, "missing-authority": { ...DEFAULT_RECOVERY_POLICY["missing-authority"], recipes: ["wait_and_retry"] } };
  assert.throws(() => compileRecoveryPolicy(bad), /human-authority/);
});

test("compileRecoveryPolicy: unknown class names are refused", () => {
  assert.throws(() => compileRecoveryPolicy({ ...DEFAULT_RECOVERY_POLICY, "not-a-real-class": {} }), /unknown blocker class/);
});

test("no permitted recipe across any class performs a merge, release, credential, or deploy action", () => {
  const gated = /merge|release|credential|deploy/;
  for (const cls of DURABLE_BLOCKER_CLASSES) {
    for (const recipe of DEFAULT_RECOVERY_POLICY[cls].recipes) {
      assert.doesNotMatch(recipe, gated);
    }
  }
});

// ---------------------------------------------------------------------------
// Classification — fail closed on unknown/ambiguous.
// ---------------------------------------------------------------------------

test("classifyBlocker: a single matching candidate resolves", () => {
  assert.equal(classifyBlocker(["not-a-class", "implementation-ci"]), "implementation-ci");
});

test("classifyBlocker: no matching candidate fails closed", () => {
  assert.throws(() => classifyBlocker(["mystery", "unknown-thing"]), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "stop");
    return true;
  });
});

test("classifyBlocker: more than one matching candidate is ambiguous and fails closed", () => {
  assert.throws(() => classifyBlocker(["implementation-ci", "workflow-state"]), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "stop");
    assert.match((err as Error).message, /ambiguous/);
    return true;
  });
});

test("classifyAndBlockItem: an unmatched blocker stops the run for human review and consumes no budget", async () => {
  const { deps, contract, token } = await setup();
  await assert.rejects(
    () => classifyAndBlockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", candidateClasses: ["mystery"], evidence: "??" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "stop");
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop?.reason, "needs_human_classification");
  assert.equal(ledger.stop?.item_id, "100");
  assert.equal(ledger.items["100"].state, "in_progress", "item is left unchanged, not blocked");
  assert.equal(ledger.items["100"].recovery_budgets_remaining.default, 3, "no budget consumed");
});

test("classifyAndBlockItem: an ambiguous blocker does not silently retry", async () => {
  const { deps, contract, token } = await setup();
  await assert.rejects(() =>
    classifyAndBlockItem(deps, contract, {
      runId: "run-1",
      token,
      itemId: "100",
      engine: "claude",
      candidateClasses: ["implementation-ci", "upstream-dependency"],
      evidence: "two things matched",
    }),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop?.reason, "needs_human_classification");
});

// ---------------------------------------------------------------------------
// Fingerprinting — pure, tested, normalization-tolerant.
// ---------------------------------------------------------------------------

test("fingerprintEvidence: incidental formatting differences fingerprint identically", () => {
  const a = "CI run 1234abcf failed: step 42 exited 1";
  const b = "ci run   1234abcf   failed: STEP 42 exited 1";
  assert.equal(fingerprintEvidence(a), fingerprintEvidence(b));
});

test("fingerprintEvidence: materially different evidence fingerprints distinctly", () => {
  const a = fingerprintEvidence("CI failed: lint error in foo.ts");
  const b = fingerprintEvidence("CI failed: type error in bar.ts");
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Blocking transition.
// ---------------------------------------------------------------------------

test("blockItem: a valid class is accepted and recorded as the item's blocked theme", async () => {
  const { deps, contract, token } = await setup();
  const ledger = await blockItem(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    blockerClass: "implementation-ci",
    evidence: "CI failed on step 3",
  });
  assert.equal(ledger.items["100"].state, "blocked");
  assert.equal(ledger.items["100"].blocked_theme, "implementation-ci");
});

test("blockItem: a missing class is refused, item unchanged", async () => {
  const { deps, contract, token } = await setup();
  await assert.rejects(
    () => blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "" as DurableBlockerClass, evidence: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "validation");
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
});

test("blockItem: an out-of-enum class is refused naming the value, state unchanged", async () => {
  const { deps, contract, token } = await setup();
  await assert.rejects(
    () => blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "totally-made-up", evidence: "x" }),
    /totally-made-up/,
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
});

test("blockItem: identical evidence repeated past the limit stops the run even with budget remaining", async () => {
  const { deps, contract, token } = await setup();
  // "workflow-state" has repeated_evidence_limit: 2 in DEFAULT_RECOVERY_POLICY.
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "stuck in review" });
  let ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop, null);
  assert.equal(ledger.items["100"].recovery_budgets_remaining.default, 3, "budget untouched by blocking");

  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "stuck in review" });
  ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop, null, "one repeat is still under the limit of 2");

  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "stuck in review" });
  ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop?.reason, "repeated_no_progress");
  assert.equal(ledger.stop?.item_id, "100");
  assert.equal(ledger.items["100"].recovery_budgets_remaining.default, 3, "class budget still had room when the run stopped");
});

test("blockItem: a differing fingerprint resets the repeated-evidence count to zero", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "stuck in review" });
  let ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].repeated_evidence_count, 0);

  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "stuck in review" });
  ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].repeated_evidence_count, 1);

  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "a completely different failure now" });
  ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].repeated_evidence_count, 0);
  assert.equal(ledger.stop, null);
});

test("blockItem: a stopped run refuses every further transition", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "e" });
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "e" });
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "workflow-state", evidence: "e" }); // stops the run
  await assert.rejects(
    () => blockItem(deps, contract, { runId: "run-1", token, itemId: "200", engine: "claude", blockerClass: "implementation-ci", evidence: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "stop");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Recovery — budget keyed by classification, same-item resume, authority safety.
// ---------------------------------------------------------------------------

test("recoverItem: budget is charged only on recovery, keyed by the item's blocker class", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed" });
  const { ledger, attempt } = await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: ["rerun_ci"] });
  assert.equal(attempt.outcome, "recovered");
  assert.equal(ledger.items["100"].recovery_budgets_remaining["implementation-ci"], 2, "class budget decremented from the policy's retry_budget of 3");
  assert.equal(ledger.items["100"].recovery_budgets_remaining.default, 3, "the unrelated default key is untouched");
});

test("recoverItem: exhausted class budget stops the run terminally", async () => {
  const { deps, contract, token } = await setup();
  const ledgerFile = "run-1";
  // Drain the class budget to zero directly (simulating prior exhausted attempts).
  const ledger = await readLedger(deps, ledgerFile);
  ledger.items["100"].recovery_budgets_remaining["implementation-ci"] = 0;
  await import("../scripts/loop/store.ts").then((m) => m.writeLedger(deps, ledger, token));

  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed again" });
  const result = await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: ["rerun_ci"] });
  assert.equal(result.attempt.outcome, "exhausted");
  assert.equal(result.ledger.stop?.reason, "recovery_exhausted");
  assert.equal(result.ledger.items["100"].state, "blocked", "item does not resume when its budget is exhausted");

  await assert.rejects(() => recoverItem(deps, contract, { runId: "run-1", token, itemId: "200", engine: "claude", actions: [] }));
});

test("recoverItem: on success the same item resumes blocked -> in_progress, retaining history, class, and evidence", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed", note: "first block" });
  const { ledger } = await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: ["rerun_ci"] });
  const item = ledger.items["100"];
  assert.equal(item.state, "in_progress");
  assert.equal(item.blocked_theme, "implementation-ci", "blocker class is retained after recovery");
  assert.ok(item.evidence_fingerprint, "evidence fingerprint is retained after recovery");
  assert.ok(item.history.some((h) => h.to === "blocked" && h.note === "first block"), "prior history is retained");
  assert.ok(item.history.some((h) => h.from === "blocked" && h.to === "in_progress"), "resume is recorded on history");
  assert.equal(ledger.items["200"].state, "pending", "no other item was started in its place");
});

test("recoverItem: missing-authority routes to a human, not a retry — no budget charged, no recipe attempted", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "missing-authority", evidence: "needs a merge grant" });
  const before = (await readLedger(deps, "run-1")).items["100"].recovery_budgets_remaining;
  const { ledger, attempt } = await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: [] });
  assert.equal(attempt.outcome, "human_authority");
  assert.equal(ledger.items["100"].state, "blocked", "item stays blocked pending a human, not retried");
  assert.deepEqual(ledger.items["100"].recovery_budgets_remaining, before, "no budget charged");
});

test("recoverItem: specification-decision routes to a human, not a retry", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "specification-decision", evidence: "ambiguous requirement" });
  const { attempt } = await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: [] });
  assert.equal(attempt.outcome, "human_authority");
});

test("recoverItem: a recipe not permitted for the class is refused", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed" });
  await assert.rejects(
    () => recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: ["reauthenticate"] }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "validation");
      return true;
    },
  );
});

test("recovery attempts persist in the ledger and survive a resuming read", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed" });
  await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: ["rerun_ci"] });

  // A fresh read (as a resuming process would perform) sees the same history.
  const resumed = await readLedger(deps, "run-1");
  assert.equal(resumed.recovery_attempts.length, 1);
  assert.equal(resumed.recovery_attempts[0].item_id, "100");
  assert.equal(resumed.recovery_attempts[0].class, "implementation-ci");
  assert.equal(resumed.recovery_attempts[0].outcome, "recovered");
  assert.deepEqual(resumed.recovery_attempts[0].actions, ["rerun_ci"]);
  assert.ok(resumed.recovery_attempts[0].evidence_fingerprint.length > 0);
});

test("a Pipeline-native event is emitted for every recovery attempt", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed" });
  await recoverItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", actions: ["rerun_ci"] });
  const events = (await import("../scripts/loop/store.ts")).readEvents;
  const log = await events(deps, "run-1");
  assert.ok(log.some((e) => e.kind === "loop_recovery_attempt"));
  assert.ok(log.some((e) => e.kind === "loop_item_blocked"));
});

// ---------------------------------------------------------------------------
// Independent-item continuation.
// ---------------------------------------------------------------------------

test("eligibleIndependentItems: a non-run-fatal block lets an independent pending item proceed", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed" });
  const ledger = await readLedger(deps, "run-1");
  const eligible = eligibleIndependentItems(contract, ledger);
  assert.deepEqual(eligible, ["200"]);
});

test("eligibleIndependentItems: a run-fatal block stops the whole run — no further item starts", async () => {
  const { deps, contract, token } = await setup();
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "environment-auth", evidence: "token expired" });
  const ledger = await readLedger(deps, "run-1");
  assert.ok(isRunFatalBlocked(contract, ledger));
  assert.deepEqual(eligibleIndependentItems(contract, ledger), []);
});

test("eligibleIndependentItems: an item depending on the blocked item is not eligible", async () => {
  const { deps, token } = await setup();
  const contract = testContract({ items: [{ id: "100", depends_on: [] }, { id: "200", depends_on: ["100"] }] });
  await initRun(deps, contract, testLedger()).catch(() => {}); // already initialized under run-1 in setup(); reuse ledger directly
  await blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "ci failed" });
  const ledger = await readLedger(deps, "run-1");
  assert.deepEqual(eligibleIndependentItems(contract, ledger), [], "200 depends on the blocked item 100");
});

test("eligibleIndependentItems: the single-active-item invariant holds — no item is eligible while one is in_progress", async () => {
  const { deps, contract } = await setup();
  const ledger = testLedger();
  ledger.items["100"].state = "blocked";
  ledger.items["100"].blocked_theme = "implementation-ci";
  ledger.items["200"].state = "in_progress";
  assert.deepEqual(eligibleIndependentItems(contract, ledger), []);
});

// ---------------------------------------------------------------------------
// Legacy import — theme -> class mapping.
// ---------------------------------------------------------------------------

test("mapLegacyThemeToBlockerClass: a native class name passes through unchanged", () => {
  assert.equal(mapLegacyThemeToBlockerClass("implementation-ci"), "implementation-ci");
});

test("mapLegacyThemeToBlockerClass: known legacy theme spellings map onto their class", () => {
  assert.equal(mapLegacyThemeToBlockerClass("rate_limit"), "transient-rate-limit");
  assert.equal(mapLegacyThemeToBlockerClass("CI Failure"), "implementation-ci");
  assert.equal(mapLegacyThemeToBlockerClass("needs-human"), "missing-authority");
});

test("mapLegacyThemeToBlockerClass: an unmapped legacy theme is refused rather than guessed", () => {
  assert.throws(() => mapLegacyThemeToBlockerClass("something-nobody-ever-recorded"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "validation");
    return true;
  });
});
