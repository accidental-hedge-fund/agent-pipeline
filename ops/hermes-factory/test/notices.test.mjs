import assert from "node:assert/strict";
import test from "node:test";
import { NoticeSink } from "../lib/notices.mjs";
import { admittedJournal, config, NOW } from "./helpers.mjs";

test("material notices keep a durable pending item and retry it once after an outage", async () => {
  const { store, grant, journal } = await admittedJournal();
  const delivered = [];
  let offline = true;
  const sink = new NoticeSink({
    validated: grant,
    config: config(),
    journal,
    store,
    secrets: ["secret-canary"],
    deliver: async (notice) => {
      delivered.push(notice);
      if (offline) throw new Error("Buzz is offline");
    },
  });
  const first = await sink.send("stage_change", { stage: "review secret-canary" }, { dedupeId: "event-1" });
  assert.equal(first.delivered, false);
  assert.equal(first.notice.stage, "review [REDACTED]");
  assert.equal(journal.notices.pending["event-1"].notice.stage, "review [REDACTED]");
  assert.equal(delivered.length, 1);
  offline = false;
  const retried = await sink.flushPending();
  assert.deepEqual(retried, { delivered: 1, pending: 0 });
  const replay = await sink.send("stage_change", { stage: "changed content" }, { dedupeId: "event-1" });
  assert.equal(replay.skipped, true);
  assert.equal(delivered.length, 2);
  assert.equal(journal.notices.last_material_id, "event-1");
});

test("heartbeat is bounded by the configured interval", async () => {
  const { store, grant, journal } = await admittedJournal();
  const delivered = [];
  const sink = new NoticeSink({
    validated: grant,
    config: config(),
    journal,
    store,
    now: () => NOW,
    deliver: async (notice) => delivered.push(notice),
  });
  await sink.send("issue_start", { issue: 905 });
  const heartbeat = await sink.heartbeat({ status: "running" });
  assert.equal(heartbeat.skipped, true);
  assert.equal(delivered.length, 1);
});
