import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnvironments } from "../factory.mjs";
import { parseEffectiveGrokModel, probeEffectiveGrokModel } from "../lib/model-proof.mjs";
import { config, ok } from "./helpers.mjs";

test("requires provider-reported effective grok-4.5 telemetry", () => {
  const exact = `${JSON.stringify({ type: "end", modelUsage: { "grok-4.5": { requests: 1 } } })}\n`;
  assert.equal(parseEffectiveGrokModel(exact), "grok-4.5");
  const runtimeId = `${JSON.stringify({ type: "end", modelUsage: { "grok-4.5-build": { requests: 1 } } })}\n`;
  assert.equal(parseEffectiveGrokModel(runtimeId), "grok-4.5");
  assert.throws(() => parseEffectiveGrokModel(JSON.stringify({ type: "end" })), /effective model/);
  assert.throws(
    () => parseEffectiveGrokModel(JSON.stringify({ type: "end", modelUsage: { "grok-4.4": {} } })),
    /expected grok-4.5/,
  );
});

test("model probe requests exact grok-4.5 without passing service secrets", async () => {
  const calls = [];
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    GH_TOKEN: "gh-secret-canary",
    BUZZ_PRIVATE_KEY: "buzz-secret-canary",
    PIPELINE_FRG_ATTESTATION_KEY: "frg-secret-canary",
  };
  const machine = config();
  const result = await probeEffectiveGrokModel(machine, {
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return ok(JSON.stringify({ type: "end", modelUsage: { "grok-4.5-build": {} } }));
    },
    mkdir: async () => {},
    mkdtemp: async () => "/state/model-probes/probe-1",
    writeFile: async () => {},
    rm: async () => {},
    env: source,
  });
  assert.equal(result.effective_model, "grok-4.5");
  assert.deepEqual(calls[0].args.slice(-4), ["-m", "grok-4.5", "--reasoning-effort", "low"]);
  assert.equal(calls[0].options.env.HOME, "/home/user");
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
  assert.equal(calls[0].options.env.BUZZ_PRIVATE_KEY, undefined);
  assert.equal(calls[0].options.env.PIPELINE_FRG_ATTESTATION_KEY, undefined);
});

test("every child role is allowlisted and the external pin is shared only where required", () => {
  const machine = config();
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/user",
    GH_TOKEN: "gh-secret-canary",
    GIT_SSH_COMMAND: "ssh",
    BUZZ_PRIVATE_KEY: "buzz-secret-canary",
    BUZZ_AUTH_TAG: "buzz-auth-canary",
    PIPELINE_FRG_ATTESTATION_KEY: "frg-secret-canary",
    PIPELINE_FRG_ATTESTATION_KEY_FILE: "/credential/canary",
  };
  const envs = buildChildEnvironments(machine, source);
  for (const [role, env] of Object.entries(envs)) {
    assert.equal(env.BUZZ_PRIVATE_KEY, undefined, role);
    assert.equal(env.BUZZ_AUTH_TAG, undefined, role);
    assert.equal(env.PIPELINE_FRG_ATTESTATION_KEY, undefined, role);
    assert.equal(env.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined, role);
  }
  assert.equal(envs.pipeline.AGENT_PIPELINE_PRODUCTION_PIN, machine.production_pin_file);
  assert.equal(envs.frg_runner.AGENT_PIPELINE_PRODUCTION_PIN, machine.production_pin_file);
  assert.equal(envs.install.AGENT_PIPELINE_PRODUCTION_PIN, machine.production_pin_file);
  assert.equal(envs.model_probe.AGENT_PIPELINE_PRODUCTION_PIN, undefined);
  assert.equal(envs.systemd.GH_TOKEN, undefined);
});
