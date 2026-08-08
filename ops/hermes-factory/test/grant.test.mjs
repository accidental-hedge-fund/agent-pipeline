import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateMachineConfig } from "../lib/config.mjs";
import {
  GRANT_ACTIONS,
  GrantError,
  canonicalJson,
  requireFullReleaseGrant,
  validateControlEnvelope,
  validateGrantEnvelope,
} from "../lib/grant.mjs";
import { CHANNEL, EVENT_SECONDS, MESSAGE, NOW, OPERATOR, config, envelope } from "./helpers.mjs";

test("the shipped Hermes skill grant envelope passes validation", () => {
  const skill = readFileSync(new URL("../hermes/skills/pipeline-factory/SKILL.md", import.meta.url), "utf8");
  const documentedGrant = skill.match(/## Release grant[\s\S]*?```json\n([\s\S]*?)\n```/);
  assert.ok(documentedGrant, "release grant JSON block must exist in the shipped Hermes skill");
  const raw = JSON.parse(documentedGrant[1]);
  Object.assign(raw.auth, {
    chat_id: CHANNEL,
    user_id: OPERATOR,
    message_id: MESSAGE,
    thread_id: MESSAGE,
    created_at: EVENT_SECONDS,
  });
  Object.assign(raw.grant, {
    nonce: "release-1.32.1-run-001",
    repository: "owner/repo",
    release_version: "1.32.1",
    milestone: "v1.32.1",
    issued_at: NOW.toISOString(),
    expires_at: "2026-08-09T12:00:00.000Z",
  });

  const value = validateGrantEnvelope(raw, validateMachineConfig(config()), { now: () => NOW });
  assert.equal(value.grant.milestone, "v1.32.1");
});

test("validates exact relay-observed Buzz identity and canonical release scope", () => {
  const cfg = validateMachineConfig(config(), { requireEnabled: true });
  const value = validateGrantEnvelope(envelope(), cfg, { now: () => NOW });
  assert.equal(value.auth.user_id, OPERATOR);
  assert.equal(value.auth.chat_id, CHANNEL);
  assert.equal(value.auth.message_id, MESSAGE);
  assert.equal(value.fingerprint.length, 64);
  assert.deepEqual(value.grant.actions, GRANT_ACTIONS);
});

test("canonical JSON and fingerprint do not depend on object insertion order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
  const cfg = validateMachineConfig(config());
  const first = validateGrantEnvelope(envelope(), cfg, { now: () => NOW });
  const source = envelope();
  const reordered = { grant: { ...source.grant }, auth: { ...source.auth } };
  const second = validateGrantEnvelope(reordered, cfg, { now: () => NOW });
  assert.equal(first.fingerprint, second.fingerprint);
});

for (const [name, mutate, code] of [
  ["signer", (e) => (e.auth.user_id = "c".repeat(64)), "signer-mismatch"],
  ["channel", (e) => (e.auth.chat_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "channel-mismatch"],
  ["message shape", (e) => (e.auth.message_id = "not-a-nostr-id"), "invalid-field"],
  ["root thread", (e) => (e.auth.thread_id = "c".repeat(64)), "thread-mismatch"],
  ["repository", (e) => (e.grant.repository = "other/repo"), "repository-mismatch"],
  ["base", (e) => (e.grant.base_branch = "staging"), "base-mismatch"],
  ["milestone", (e) => (e.grant.milestone = "v1.32.2"), "milestone-mismatch"],
  ["model", (e) => (e.grant.model = "grok-4"), "model-mismatch"],
  ["expiry order", (e) => (e.grant.expires_at = "2026-08-08T11:59:59.000Z"), "invalid-expiry"],
  ["issue duplicate", (e) => (e.grant.ordered_issues = [905, 905]), "invalid-issues"],
  ["issue limit", (e) => (e.grant.issue_limit = 2), "issue-limit"],
  ["action order", (e) => (e.grant.actions = ["rollback", "issue_advance"]), "invalid-actions"],
  ["unknown field", (e) => (e.grant.extra_authority = true), "unknown-field"],
]) {
  test(`denies ${name} drift`, () => {
    const raw = envelope();
    mutate(raw);
    assert.throws(
      () => validateGrantEnvelope(raw, validateMachineConfig(config()), { now: () => NOW }),
      (error) => error instanceof GrantError && error.code === code,
    );
  });
}

test("requires every workflow action for a full release run", () => {
  const raw = envelope({ grant: { actions: GRANT_ACTIONS.filter((action) => action !== "rollback") } });
  const value = validateGrantEnvelope(raw, validateMachineConfig(config()), { now: () => NOW });
  assert.throws(() => requireFullReleaseGrant(value), /missing action.*rollback/);
});

test("denies an otherwise valid expired grant", () => {
  const raw = envelope({
    grant: {
      issued_at: "2026-08-08T12:00:00.000Z",
      expires_at: "2026-08-08T12:01:00.000Z",
    },
  });
  assert.throws(
    () => validateGrantEnvelope(raw, validateMachineConfig(config()), {
      now: () => new Date("2026-08-08T12:01:01.000Z"),
    }),
    (error) => error instanceof GrantError && error.code === "expired",
  );
});

test("expired grant identity can be revalidated only for terminal cleanup", () => {
  const expiredNow = () => new Date("2026-08-10T12:00:00.000Z");
  assert.throws(() => validateGrantEnvelope(envelope(), config(), { now: expiredNow }), /expired/);
  const cleanup = validateGrantEnvelope(envelope(), config(), { now: expiredNow, allowExpired: true });
  assert.equal(cleanup.grant.release_version, "1.32.1");
});

test("validates a stop in the original thread and rejects another thread", () => {
  const cfg = validateMachineConfig(config());
  const grant = validateGrantEnvelope(envelope(), cfg, { now: () => NOW });
  const raw = {
    auth: {
      adapter: "hermes-native-buzz",
      chat_id: CHANNEL,
      user_id: OPERATOR,
      message_id: "c".repeat(64),
      thread_id: MESSAGE,
      created_at: EVENT_SECONDS + 60,
    },
    control: {
      schema_version: 1,
      kind: "stop",
      grant_fingerprint: grant.fingerprint,
      issued_at: "2026-08-08T12:01:00.000Z",
      reason: "operator stop",
    },
  };
  assert.equal(validateControlEnvelope(raw, cfg, grant, { now: () => new Date("2026-08-08T12:01:01.000Z") }).control.kind, "stop");
  raw.auth.thread_id = "d".repeat(64);
  assert.throws(
    () => validateControlEnvelope(raw, cfg, grant, { now: () => new Date("2026-08-08T12:01:01.000Z") }),
    /thread_id/,
  );
});

test("machine config rejects disabled runs and the stale launcher", () => {
  assert.throws(() => validateMachineConfig(config({ enabled: false }), { requireEnabled: true }), /disabled/);
  assert.throws(
    () => validateMachineConfig(config({ pipeline_command: ["/usr/local/bin/pipeline", "/x/scripts/pipeline.mjs"] })),
    /must not use/,
  );
  assert.throws(() => validateMachineConfig(config({ auto_merge: true })), /unknown field/);
  assert.throws(
    () => validateMachineConfig(config({ notification_command: ["/usr/bin/curl", "https://example.invalid"] })),
    /pinned Hermes/,
  );
  assert.throws(
    () => validateMachineConfig(config({ frg_scorer_request_dir: "/tmp/requests" })),
    /state_dir\/frg-scorer-requests/,
  );
});

test("machine config binds both launchers, install order, and secret roles", () => {
  assert.throws(
    () => validateMachineConfig(config({ candidate_pipeline_command: ["/usr/bin/node", "/repo/core/scripts/pipeline.ts"] })),
    /candidate_pipeline_command/,
  );
  assert.throws(() => validateMachineConfig(config({ install_hosts: ["grok", "claude", "codex"] })), /claude before grok/);
  assert.throws(() => validateMachineConfig(config({ install_hosts: ["claude", "grok"] })), /include codex/);
  const leaked = config();
  leaked.env_allowlists.pipeline.push("BUZZ_PRIVATE_KEY");
  assert.throws(() => validateMachineConfig(leaked), /Buzz credentials must not enter/);
  const frgLeak = config();
  frgLeak.env_allowlists.install.push("PIPELINE_FRG_ATTESTATION_KEY_FILE");
  assert.throws(() => validateMachineConfig(frgLeak), /must not receive the FRG credential/);
  const rawFrgSecret = config();
  rawFrgSecret.env_allowlists.frg_runner = ["PIPELINE_FRG_ATTESTATION_KEY"];
  assert.throws(() => validateMachineConfig(rawFrgSecret), /must not receive the FRG credential/);
});
