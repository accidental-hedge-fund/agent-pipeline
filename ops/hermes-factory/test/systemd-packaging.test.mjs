import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scorerUnit = new URL("../systemd/hermes-factory-frg@.service", import.meta.url);
const factoryUnit = new URL("../systemd/hermes-factory.service", import.meta.url);

test("FRG scorer stops with the live factory service", async () => {
  const body = await readFile(scorerUnit, "utf8");

  assert.match(body, /^BindsTo=hermes-factory\.service$/m);
  assert.match(body, /^PartOf=hermes-factory\.service$/m);
  assert.match(body, /^After=hermes-factory\.service$/m);
  assert.match(body, /^ExecStart=\/usr\/bin\/node --experimental-strip-types .*\/lib\/frg-attestor\.mjs attest --request /m);
  assert.doesNotMatch(body, /frg-runner\.mjs score/);
  assert.doesNotMatch(body, /network-online/);
  assert.match(body, /^PrivateNetwork=true$/m);
});

test("factory service restarts bounded process failures but remains explicitly started", async () => {
  const body = await readFile(factoryUnit, "utf8");
  assert.match(body, /^Restart=on-failure$/m);
  assert.match(body, /^RestartSec=60$/m);
  assert.match(body, /^StartLimitIntervalSec=300$/m);
  assert.match(body, /^StartLimitBurst=6$/m);
  assert.doesNotMatch(body, /^\[Install\]$/m);
});
