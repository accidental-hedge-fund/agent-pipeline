// Tests for the durable loop store (#508): state-home resolution, run
// directory layout, atomic writes, append-only logs, locking, and the
// read-only status projection. Every test runs through an in-memory
// LoopStoreDeps fake — no real filesystem, process, or network access.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveStateHome,
  runDir,
  runExists,
  initRun,
  readContract,
  readLedger,
  writeLedger,
  appendEvent,
  appendDecision,
  readEvents,
  readDecisions,
  acquireLock,
  readLock,
  classifyStaleness,
  recoverLock,
  releaseLock,
  requireToken,
  getStatus,
  type LoopStoreDeps,
  defaultLoopStoreDeps,
  LEGACY_PIPELINE_STATE_HOME_ENV,
} from "../scripts/loop/store.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA, LoopError, type LoopContract, type LoopLedger } from "../scripts/loop/types.ts";

// ---------------------------------------------------------------------------
// In-memory fake filesystem
// ---------------------------------------------------------------------------

let fakeDepsCounter = 0;

/** The store keeps an in-process next-sequence cache keyed by absolute log
 *  path (store.ts's `nextSeqCache`) — each fakeDeps() call gets its own
 *  AGENT_PIPELINE_STATE_HOME so distinct tests never collide on the same
 *  cache entry despite reusing run id "run-1". */
function fakeDeps(overrides: Partial<LoopStoreDeps> = {}): { deps: LoopStoreDeps; files: Map<string, string>; writes: string[] } {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let clock = new Date("2026-07-22T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const alivePids = new Set<number>([111]);
  const isolatedEnv = { AGENT_PIPELINE_STATE_HOME: `/state-${fakeDepsCounter++}` };

  const deps: LoopStoreDeps = {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async readTextFile(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async writeFileAtomic(p, content) {
      writes.push(p);
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      writes.push(p);
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
      writes.push(p);
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
    async isPidAlive(pid) {
      return alivePids.has(pid);
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date(clock),
    uuid: () => `uuid-${uuidCounter++}`,
    env: isolatedEnv,
    ...overrides,
  };
  return { deps, files, writes };
}

function testContract(runId = "run-1"): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: runId,
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
    items: [{ id: "100", depends_on: [] }],
    canonical_hash: "deadbeef",
  };
}

function testLedger(runId = "run-1"): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: runId,
    items: { "100": { id: "100", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } } },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
  };
}

// ---------------------------------------------------------------------------
// State home resolution
// ---------------------------------------------------------------------------

test("resolveStateHome: explicit override wins", () => {
  const { deps } = fakeDeps({ env: { AGENT_PIPELINE_STATE_HOME: "/custom/home" } });
  assert.equal(resolveStateHome(deps), "/custom/home");
});

test("resolveStateHome: falls back to XDG_STATE_HOME", () => {
  const { deps } = fakeDeps({ env: { XDG_STATE_HOME: "/xdg" } });
  assert.equal(resolveStateHome(deps), "/xdg/agent-pipeline/loop");
});

test("resolveStateHome: falls back to home-relative default", () => {
  const { deps } = fakeDeps({ env: {} });
  assert.ok(resolveStateHome(deps).endsWith("/.local/state/agent-pipeline/loop"));
});

// ---------------------------------------------------------------------------
// Run id validation — must never escape <state-home>/runs
// ---------------------------------------------------------------------------

test("runDir refuses a run id that would traverse outside the runs root", () => {
  const { deps } = fakeDeps();
  for (const bad of ["../../../goal-loop/runs/victim", "..", ".", "a/b", "a\\b", ""]) {
    assert.throws(() => runDir(deps, bad), (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "validation");
      return true;
    });
  }
});

test("initRun refuses a malicious run id before creating anything", async () => {
  const { deps, files } = fakeDeps();
  await assert.rejects(() => initRun(deps, testContract("../../etc/victim"), testLedger("../../etc/victim")));
  assert.equal(files.size, 0);
});

// ---------------------------------------------------------------------------
// Run init + layout
// ---------------------------------------------------------------------------

test("initRun creates contract + ledger and emits an init event", async () => {
  const { deps, files } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const dir = runDir(deps, "run-1");
  assert.ok(files.has(`${dir}/contract.json`));
  assert.ok(files.has(`${dir}/ledger.json`));
  const events = await readEvents(deps, "run-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "run_initialized");
});

test("initRun refuses when the run directory already exists (conflict)", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  await assert.rejects(() => initRun(deps, testContract(), testLedger()), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "conflict");
    return true;
  });
});

test("initRun: two racing initializations of the same run id, exactly one succeeds", async () => {
  const { deps, files } = fakeDeps();
  const results = await Promise.allSettled([
    initRun(deps, testContract(), testLedger()),
    initRun(deps, testContract(), testLedger()),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof LoopError);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.loopFailureClass, "conflict");
  const dir = runDir(deps, "run-1");
  assert.ok(files.has(`${dir}/contract.json`));
  assert.ok(files.has(`${dir}/ledger.json`));
});

test("initRun: a crash between mkdirp and the exclusive create does not permanently wedge the run id", async () => {
  const { deps, files } = fakeDeps();
  const dir = runDir(deps, "run-1");
  await deps.mkdirp(dir); // simulate a prior process that created the dir but never wrote contract.json
  await initRun(deps, testContract(), testLedger());
  assert.ok(files.has(`${dir}/contract.json`));
  assert.ok(files.has(`${dir}/ledger.json`));
});

test("initRun never completes a foreign partial state — atomic publication makes stranded inits impossible on the canonical path (#508 delta 92d2ec8f)", async () => {
  // Under stage-then-rename publication, a crash before publish leaves only an
  // unpublished staging directory: the run id itself never appears partially
  // initialized, so a retry with the SAME run id simply initializes fresh.
  const { deps, files } = fakeDeps();
  const dir = runDir(deps, "run-1");
  await initRun(deps, testContract(), testLedger());
  assert.ok(files.has(`${dir}/contract.json`));
  assert.ok(files.has(`${dir}/ledger.json`));
  const events = await readEvents(deps, "run-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "run_initialized");
  // An externally hand-crafted contract-only directory (impossible for the
  // engine to produce) is refused — the old completion path let a second
  // request's ledger complete a first request's contract (the corruption
  // 92d2ec8f names), so init must never adopt foreign partial state.
  const { deps: deps2 } = fakeDeps();
  const dir2 = runDir(deps2, "run-x");
  await deps2.createFileExclusive(`${dir2}/contract.json`, JSON.stringify(testContract("run-x"), null, 2));
  await assert.rejects(() => initRun(deps2, testContract("run-x"), testLedger("run-x")), /already exists/);
});

test("readContract / readLedger round-trip", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const contract = await readContract(deps, "run-1");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(contract.run_id, "run-1");
  assert.equal(ledger.items["100"].state, "pending");
});

test("readContract fails naming the run id for an unknown run", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(() => readContract(deps, "ghost"), /ghost/);
});

test("runExists reflects presence", async () => {
  const { deps } = fakeDeps();
  assert.equal(await runExists(deps, "run-1"), false);
  await initRun(deps, testContract(), testLedger());
  assert.equal(await runExists(deps, "run-1"), true);
});

test("writeLedger overwrites atomically and is readable back", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  const ledger = await readLedger(deps, "run-1");
  ledger.items["100"].state = "in_progress";
  await writeLedger(deps, ledger, token);
  const reread = await readLedger(deps, "run-1");
  assert.equal(reread.items["100"].state, "in_progress");
});

test("writeLedger refuses an absent or mismatched token", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const ledger = await readLedger(deps, "run-1");
  await assert.rejects(() => writeLedger(deps, ledger, "no-such-token"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
  await acquireLock(deps, "run-1", "claude");
  await assert.rejects(() => writeLedger(deps, ledger, "wrong-token"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Append-only logs — dense sequencing, no rewrite of existing bytes
// ---------------------------------------------------------------------------

test("events get dense 0-based sequence numbers", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger()); // seq 0: run_initialized
  const { token } = await acquireLock(deps, "run-1", "claude");
  await appendEvent(deps, "run-1", token, "a", {});
  await appendEvent(deps, "run-1", token, "b", {});
  const events = await readEvents(deps, "run-1");
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2]);
});

test("appending a log never rewrites prior bytes", async () => {
  const { deps, files } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  const dir = runDir(deps, "run-1");
  const before = files.get(`${dir}/events.jsonl`)!;
  await appendEvent(deps, "run-1", token, "next", { x: 1 });
  const after = files.get(`${dir}/events.jsonl`)!;
  assert.ok(after.startsWith(before));
  assert.equal(after.split("\n").filter((l) => l.length > 0).length, before.split("\n").filter((l) => l.length > 0).length + 1);
});

test("concurrent appendEvent calls under one valid holder never produce duplicate sequence numbers", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger()); // seq 0: run_initialized
  const { token } = await acquireLock(deps, "run-1", "claude");
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => appendEvent(deps, "run-1", token, `e${i}`, { i })),
  );
  const events = await readEvents(deps, "run-1");
  assert.equal(events.length, 11);
  const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 11 }, (_, i) => i));
});

test("decisions log is independent of the events log sequence", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  await appendEvent(deps, "run-1", token, "e1", {});
  await appendDecision(deps, "run-1", token, "d1", {});
  await appendDecision(deps, "run-1", token, "d2", {});
  const decisions = await readDecisions(deps, "run-1");
  assert.deepEqual(decisions.map((d) => d.seq), [0, 1]);
});

test("appendEvent and appendDecision refuse an absent or mismatched token", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  await assert.rejects(() => appendEvent(deps, "run-1", "no-such-token", "a", {}), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
  const { token } = await acquireLock(deps, "run-1", "claude");
  await assert.rejects(() => appendDecision(deps, "run-1", "wrong-token", "d", {}), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
  await appendEvent(deps, "run-1", token, "a", {});
});

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

test("acquireLock returns a token and a second acquisition is refused naming the holder", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const first = await acquireLock(deps, "run-1", "claude");
  assert.ok(first.token);
  await assert.rejects(() => acquireLock(deps, "run-1", "codex"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    assert.match((err as Error).message, /claude pid 111/);
    return true;
  });
});

test("acquireLock: two racing acquisitions that both observe no lock, exactly one succeeds", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  // Both callers observe "no lock" before either writes — createFileExclusive
  // is the only thing that can arbitrate between them.
  assert.equal(await readLock(deps, "run-1"), null);
  assert.equal(await readLock(deps, "run-1"), null);
  const results = await Promise.allSettled([acquireLock(deps, "run-1", "claude"), acquireLock(deps, "run-1", "codex")]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof LoopError);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.loopFailureClass, "lock");
});

test("requireToken refuses a mismatched or absent token, naming the holder", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  await assert.rejects(() => requireToken(deps, "run-1", "wrong-token"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
  const held = await requireToken(deps, "run-1", token);
  assert.equal(held.engine, "claude");
});

test("read-only status does not require a token even when locked by another process", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  await acquireLock(deps, "run-1", "claude");
  const status = await getStatus(deps, "run-1");
  assert.equal(status.run_id, "run-1");
});

test("classifyStaleness: same host + dead pid is stale", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { record } = await acquireLock(deps, "run-1", "claude");
  const deadDeps = { ...deps, isPidAlive: async () => false };
  assert.equal(await classifyStaleness(deadDeps, record), "stale_same_host_dead_pid");
});

test("classifyStaleness: same host + live pid is not stale", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { record } = await acquireLock(deps, "run-1", "claude");
  assert.equal(await classifyStaleness(deps, record), "not_stale");
});

test("classifyStaleness: a different host is never stale, regardless of pid liveness", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const record = { engine: "claude" as const, pid: 999, hostname: "other-host", acquired_at: "x", token: "t", run_id: "run-1" };
  assert.equal(await classifyStaleness(deps, record), "unverifiable_cross_host");
});

test("recoverLock: refuses a non-stale lock without force", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  await acquireLock(deps, "run-1", "claude");
  await assert.rejects(() => recoverLock(deps, "run-1", "test"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
});

test("recoverLock: recovers a dead same-host holder, emits an event, and invalidates the old token", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { token: oldToken } = await acquireLock(deps, "run-1", "claude");
  const deadDeps = { ...deps, isPidAlive: async () => false };
  await recoverLock(deadDeps, "run-1", "dead pid");
  const events = await readEvents(deps, "run-1");
  assert.ok(events.some((e) => e.kind === "lock_recovered"));
  assert.equal(await readLock(deps, "run-1"), null);
  await assert.rejects(() => requireToken(deps, "run-1", oldToken));
  const fresh = await acquireLock(deps, "run-1", "codex");
  assert.notEqual(fresh.token, oldToken);
});

test("recoverLock: a second stale recovery of an already-superseded lock does not strip the new holder (ABA race)", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  await acquireLock(deps, "run-1", "claude"); // L1, dead
  const deadDeps = { ...deps, isPidAlive: async () => false };

  // Two recoveries both observe L1 as stale before either removes it.
  const l1 = await readLock(deadDeps, "run-1");
  const staleness1 = await classifyStaleness(deadDeps, l1!);
  assert.equal(staleness1, "stale_same_host_dead_pid");

  // First recovery actually runs, removes L1, and a fresh holder acquires L2.
  await recoverLock(deadDeps, "run-1", "recovery-1");
  const { token: l2Token } = await acquireLock(deps, "run-1", "codex"); // L2, alive by default fake

  // Second recovery resumes with its stale L1 snapshot and must not remove L2.
  const removed = await deadDeps.removeFileIfMatches(`${runDir(deadDeps, "run-1")}/lock.json`, JSON.stringify(l1, null, 2));
  assert.equal(removed, false);
  const stillLocked = await readLock(deps, "run-1");
  assert.ok(stillLocked);
  assert.equal(stillLocked!.token, l2Token);
});

test("recoverLock: a cross-host lock is never auto-recovered without force", async () => {
  const { deps, files } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const dir = runDir(deps, "run-1");
  files.set(
    `${dir}/lock.json`,
    JSON.stringify({ engine: "claude", pid: 1, hostname: "other-host", acquired_at: "x", token: "t", run_id: "run-1" }),
  );
  await assert.rejects(() => recoverLock(deps, "run-1", "test"), (err: unknown) => {
    assert.ok(err instanceof LoopError);
    assert.equal(err.loopFailureClass, "lock");
    return true;
  });
});

test("release requires the matching token", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  await assert.rejects(() => releaseLock(deps, "run-1", "wrong"));
  await releaseLock(deps, "run-1", token);
  assert.equal(await readLock(deps, "run-1"), null);
});

// ---------------------------------------------------------------------------
// Status projection — zero writes
// ---------------------------------------------------------------------------

test("getStatus reports the full run picture", async () => {
  const { deps } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  const status = await getStatus(deps, "run-1");
  assert.equal(status.run_id, "run-1");
  assert.deepEqual(status.items, { "100": { state: "pending" } });
  assert.equal(status.consecutive_blocked, 0);
  assert.equal(status.merge_barrier, null);
  assert.equal(status.stop, null);
  assert.equal(status.lock.holder, null);
});

test("getStatus performs zero writes", async () => {
  const { deps, writes } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  writes.length = 0;
  await getStatus(deps, "run-1");
  assert.deepEqual(writes, []);
});

test("status of an unknown run fails naming the run id, without creating one", async () => {
  const { deps, files } = fakeDeps();
  const before = files.size;
  await assert.rejects(() => getStatus(deps, "ghost"), /ghost/);
  assert.equal(files.size, before);
});

// ---------------------------------------------------------------------------
// #508 pre-merge delta findings bc212827 / 5668c55c / 92d2ec8f
// ---------------------------------------------------------------------------

test("resolveStateHome: legacy PIPELINE_STATE_HOME is honored as a migration fallback (#508 delta 5668c55c)", () => {
  const legacyOnly = resolveStateHome({ env: { PIPELINE_STATE_HOME: "/legacy-home" } as NodeJS.ProcessEnv, hostname: () => "h" });
  assert.equal(legacyOnly, "/legacy-home");
  const both = resolveStateHome({
    env: { PIPELINE_STATE_HOME: "/legacy-home", AGENT_PIPELINE_STATE_HOME: "/new-home" } as NodeJS.ProcessEnv,
    hostname: () => "h",
  });
  assert.equal(both, "/new-home", "the new variable must take precedence");
});

test("initRun: a concurrent initializer cannot interleave records — the loser reports conflict and the winner's run stays coherent (#508 delta 92d2ec8f)", async () => {
  const { deps, files } = fakeDeps();
  const contractA = testContract("run-race");
  const contractB = { ...testContract("run-race"), canonical_hash: "hash-B" };
  const ledgerA = testLedger("run-race");
  const ledgerB = { ...testLedger("run-race"), consecutive_blocked: 7 };

  // Initializer B completes fully in the window after A staged its contract
  // but before A publishes: with atomic publication, B publishes first and A's
  // exclusive rename must fail.
  const baseWrite = deps.writeFileAtomic.bind(deps);
  let interleaved = false;
  deps.writeFileAtomic = async (p, content) => {
    await baseWrite(p, content);
    if (!interleaved && p.includes(".init-") && p.endsWith("/ledger.json")) {
      interleaved = true;
      await initRun({ ...deps, writeFileAtomic: baseWrite }, contractB, ledgerB);
    }
  };

  await assert.rejects(() => initRun(deps, contractA, ledgerA), /initialized concurrently|already exists/);

  const publishedContract = [...files.entries()].find(([k]) => k.endsWith("run-race/contract.json"));
  const publishedLedger = [...files.entries()].find(([k]) => k.endsWith("run-race/ledger.json"));
  assert.ok(publishedContract && publishedLedger, "exactly the winner's run must be published");
  assert.equal(JSON.parse(publishedContract![1]).canonical_hash, "hash-B", "contract must be the winner's");
  assert.equal(JSON.parse(publishedLedger![1]).consecutive_blocked, 7, "ledger must be the winner's — no cross-request mixing");
});

test("defaultLoopStoreDeps: real-fs lock lifecycle — acquire, release via compare-and-delete, mismatch preserved (#508 delta bc212827)", async () => {
  const os = await import("node:os");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const stateHome = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "loop-store-real-"));
  try {
    const deps = defaultLoopStoreDeps({ AGENT_PIPELINE_STATE_HOME: stateHome } as NodeJS.ProcessEnv);
    await initRun(deps, testContract("real-run"), testLedger("real-run"));
    const acquired = await acquireLock(deps, "real-run", "claude");
    assert.ok("token" in acquired && acquired.token, "lock must be acquired through the real factory");
    await releaseLock(deps, "real-run", (acquired as { token: string }).token);
    const lockFile = pathMod.join(stateHome, "runs", "real-run", "lock.json");
    assert.equal(fsMod.existsSync(lockFile), false, "release must remove the lock via removeFileIfMatches");

    // Mismatch branch: a superseded record must be preserved, not deleted.
    fsMod.writeFileSync(lockFile, "{\"foreign\":true}");
    const removed = await deps.removeFileIfMatches(lockFile, "something-else");
    assert.equal(removed, false);
    assert.equal(fsMod.readFileSync(lockFile, "utf8"), "{\"foreign\":true}", "a non-matching record must survive");
  } finally {
    fsMod.rmSync(stateHome, { recursive: true, force: true });
  }
});
