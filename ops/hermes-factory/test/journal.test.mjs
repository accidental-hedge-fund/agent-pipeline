import assert from "node:assert/strict";
import test from "node:test";
import { JournalStore } from "../lib/journal.mjs";
import { NOW, memoryFs, testLockDeps, validated } from "./helpers.mjs";

test("admit is replay-safe and stores only one immutable grant journal", async () => {
  const mem = memoryFs();
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => "one", lockDeps: testLockDeps("one") });
  const grant = validated();
  const first = await store.admit(grant);
  const second = await store.admit(grant);
  assert.equal(second.grant_fingerprint, first.grant_fingerprint);
  assert.equal([...mem.files.keys()].filter((path) => path.includes("/runs/")).length, 1);
  assert.ok(![...mem.files.keys()].some((path) => path.includes(".tmp-")), "rename removes atomic temp files");
});

test("two store instances cannot admit concurrently through the same state directory", async () => {
  const fs = memoryFs();
  const left = new JournalStore({ stateDir: "/state", fsDeps: fs.deps, now: () => NOW, random: () => "left", lockDeps: testLockDeps("left") });
  const right = new JournalStore({ stateDir: "/state", fsDeps: fs.deps, now: () => NOW, random: () => "right", lockDeps: testLockDeps("right") });
  const competing = validated({}, {
    auth: { message_id: "c".repeat(64), thread_id: "c".repeat(64) },
    grant: { nonce: "release-1.32.1-run-002" },
  });
  const results = await Promise.allSettled([left.admit(validated()), right.admit(competing)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /admission is in progress|another grant is active/);
});

test("dead same-host lock owners are reclaimed, while live and foreign owners stop", async () => {
  const owner = { schema_version: 1, host: "agent-box", boot_id: "boot", pid: 10, start_ticks: "20", token: "current" };
  const lockDeps = {
    owner: async () => owner,
    status: async (value) => value?.token === "live" ? "alive" : value?.token === "foreign" ? "foreign" : "dead",
  };

  const staleFs = memoryFs({
    "/state/admission.lock": `${JSON.stringify({ ...owner, token: "dead" })}\n`,
    [`/state/leases/${validated().fingerprint}.lock`]: `${JSON.stringify({ ...owner, token: "dead" })}\n`,
  });
  const staleStore = new JournalStore({ stateDir: "/state", fsDeps: staleFs.deps, now: () => NOW, random: () => "stale", lockDeps });
  await assert.doesNotReject(() => staleStore.admit(validated()));
  const release = await staleStore.acquireRunLease(validated().fingerprint);
  await release();

  for (const [token, message] of [["live", /admission is in progress/], ["foreign", /another host/]]) {
    const mem = memoryFs({ "/state/admission.lock": `${JSON.stringify({ ...owner, token })}\n` });
    const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => token, lockDeps });
    await assert.rejects(() => store.admit(validated()), message);
  }
});

test("failed exclusive publication leaves no poisoned admission lock or binding", async () => {
  const mem = memoryFs();
  const healthyOpen = mem.deps.open;
  let failPath = "/state/admission.lock.claim-";
  mem.deps.open = async (path, flags, mode) => {
    const handle = await healthyOpen(path, flags, mode);
    if (!path.includes(failPath)) return handle;
    return {
      ...handle,
      async writeFile() {
        const error = new Error("simulated crash before publication");
        error.code = "EIO";
        throw error;
      },
    };
  };
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => "crash", lockDeps: testLockDeps("crash") });
  await assert.rejects(() => store.admit(validated()), /simulated crash/);
  assert.equal(mem.files.has("/state/admission.lock"), false);

  failPath = "/bindings/events/";
  await assert.rejects(() => store.admit(validated()), /simulated crash/);
  assert.equal([...mem.files.keys()].some((path) => path.includes("/bindings/events/") && !path.includes(".claim-")), false);

  failPath = "/never/";
  await assert.doesNotReject(() => store.admit(validated()));
});

test("the same event identity cannot bind changed grant content", async () => {
  const mem = memoryFs();
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => String(mem.files.size), lockDeps: testLockDeps("binding") });
  await store.admit(validated());
  const changed = validated({}, { grant: { nonce: "release-1.32.1-run-002", ordered_issues: [905] , issue_limit: 1 } });
  await assert.rejects(() => store.admit(changed), /already bound/);
});

test("actions are atomic, idempotent, and ambiguous actions require reconciliation", async () => {
  const mem = memoryFs();
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => String(mem.files.size), lockDeps: testLockDeps("actions") });
  const journal = await store.admit(validated());
  const first = await store.beginAction(journal, "issue_pr_merge", { issue: 905, pr: 100, head_oid: "a".repeat(40) });
  assert.equal(first.state, "started");
  const replay = await store.beginAction(journal, "issue_pr_merge", { issue: 905, pr: 100, head_oid: "a".repeat(40) });
  assert.equal(replay.state, "reconcile");
  await store.markAction(journal, first.id, "ambiguous", "lost response");
  assert.equal((await store.beginAction(journal, "issue_pr_merge", { issue: 905, pr: 100, head_oid: "a".repeat(40) })).state, "reconcile");
  await store.retryAction(journal, first.id);
  await store.completeAction(journal, first.id, { merge_oid: "b".repeat(40) });
  const done = await store.beginAction(journal, "issue_pr_merge", { issue: 905, pr: 100, head_oid: "a".repeat(40) });
  assert.equal(done.state, "completed");
  assert.equal(done.record.result.merge_oid, "b".repeat(40));
});

test("queued journal saves cannot let an older rename erase a newer observation", async () => {
  const mem = memoryFs();
  const rename = mem.deps.rename;
  let pauseNextRunRename = false;
  let entered;
  let resume;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const resumePromise = new Promise((resolve) => { resume = resolve; });
  mem.deps.rename = async (from, to) => {
    if (pauseNextRunRename && to.includes("/runs/")) {
      pauseNextRunRename = false;
      entered();
      await resumePromise;
    }
    return rename(from, to);
  };
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => String(mem.files.size), lockDeps: testLockDeps("queue") });
  const journal = await store.admit(validated());
  const action = await store.beginAction(journal, "issue_advance", { issue: 905 });
  pauseNextRunRename = true;
  const first = store.observeAction(journal, action.id, { first: "one" });
  await enteredPromise;
  const second = store.observeAction(journal, action.id, { second: "two" });
  resume();
  await Promise.all([first, second]);
  const stored = JSON.parse(mem.files.get(`/state/runs/${journal.grant_fingerprint}.json`));
  assert.deepEqual(stored.actions[action.id].observed, { first: "one", second: "two" });
});

test("journal refuses prompt and command output fields", async () => {
  const mem = memoryFs();
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => "x", lockDeps: testLockDeps("safe") });
  const journal = await store.admit(validated());
  const action = await store.beginAction(journal, "issue_advance", { issue: 905 });
  await assert.rejects(() => store.completeAction(journal, action.id, { stdout: "secret" }), /not permitted/);
});

test("a terminal failed run does not block admission of a later grant", async () => {
  const mem = memoryFs();
  const store = new JournalStore({ stateDir: "/state", fsDeps: mem.deps, now: () => NOW, random: () => String(mem.files.size), lockDeps: testLockDeps("next") });
  const first = await store.admit(validated());
  await store.markStatus(first, "failed");
  const nextMessage = "c".repeat(64);
  const next = await store.admit(validated({}, {
    auth: { message_id: nextMessage, thread_id: nextMessage },
    grant: { nonce: "release-1.32.1-run-002", ordered_issues: [905], issue_limit: 1 },
  }));
  assert.notEqual(next.grant_fingerprint, first.grant_fingerprint);
  assert.equal((await store.getActive()).grant_fingerprint, next.grant_fingerprint);
});
