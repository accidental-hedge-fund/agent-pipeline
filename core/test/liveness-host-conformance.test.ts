// Host liveness conformance (#1332). Typed lifecycle outcomes, not prompt text.
// No real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLivenessRestoreFixture,
  type TypedLifecycleOutcome,
} from "../scripts/liveness-provider.ts";
import { BUILTIN_OUTER_HOST_IDS } from "../scripts/outer-hosts/index.ts";
import { SKILL_HOST_IDS } from "../scripts/host-skill.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

const BUILTIN_AND_CLI = [...BUILTIN_OUTER_HOST_IDS, "direct-cli"] as const;
const OUTCOMES: TypedLifecycleOutcome[] = [
  "verified_success",
  "cooling",
  "external_condition_wait",
  "typed_request",
  "cancellation",
];

test("SKILL_HOST_IDS stay claude, codex, grok, opencode", () => {
  assert.deepEqual([...SKILL_HOST_IDS], ["claude", "codex", "grok", "opencode"]);
});

test("Hermes and OpenClaw are not builtin install hosts", () => {
  assert.equal((BUILTIN_OUTER_HOST_IDS as readonly string[]).includes("hermes"), false);
  assert.equal((BUILTIN_OUTER_HOST_IDS as readonly string[]).includes("openclaw"), false);
  assert.deepEqual([...BUILTIN_OUTER_HOST_IDS], ["claude", "codex", "grok", "opencode", "omp"]);
});

test("dead-worker restore yields the same typed class as direct CLI", () => {
  for (const host of BUILTIN_AND_CLI) {
    for (const outcome of OUTCOMES) {
      const result = evaluateLivenessRestoreFixture({
        restoreSupport: "supported",
        workerDead: true,
        ledgerTerminal: false,
        directCliOutcome: outcome,
        hostOutcome: outcome,
      });
      assert.equal(result.matchesDirectCli, true, `${host} ${outcome}`);
      assert.equal(result.falseHuman, false);
      assert.equal(result.cell.kind, "typed_outcome");
    }
  }
});

test("unsupported restore is a typed capability condition, not a False-human projection", () => {
  const result = evaluateLivenessRestoreFixture({
    restoreSupport: "unsupported",
    workerDead: true,
    ledgerTerminal: false,
    directCliOutcome: "verified_success",
  });
  assert.ok(result.cell.kind === "not_applicable" || result.cell.kind === "capability_request");
  assert.equal(result.falseHuman, false);
});

test("example supervisor packs constrain launch/follow/reattach/answer/cancel/notify", () => {
  const hermes = readFileSync(join(repoRoot, "examples/supervisor/hermes/SKILL.md"), "utf8");
  const openclaw = readFileSync(join(repoRoot, "examples/supervisor/openclaw/SKILL.md"), "utf8");
  for (const body of [hermes, openclaw]) {
    assert.match(body, /liveness restore/);
    assert.match(body, /Do not classify a dead worker/);
    assert.match(body, /Do not retry `pipeline single`/);
    assert.doesNotMatch(body, /retry `pipeline single` because the worker died and then classify/);
  }
});

test("example packs fail a fixture that classifies recovery or retries a supervised verb", () => {
  const hermes = readFileSync(join(repoRoot, "examples/supervisor/hermes/SKILL.md"), "utf8");
  const hostile = hermes.replace(
    "Do not classify a dead worker. Do not retry `pipeline single` because follow stopped.",
    "Classify the dead worker and retry `pipeline single` as recovery.",
  );
  assert.notEqual(hostile, hermes);
  assert.match(hostile, /Classify the dead worker/);
  assert.match(hostile, /retry `pipeline single` as recovery/);
  assert.doesNotMatch(hermes, /Classify the dead worker/);
  assert.doesNotMatch(hermes, /retry `pipeline single` as recovery/);
});

test("docs do not tell a human to own worker death", () => {
  const context = readFileSync(join(repoRoot, "CONTEXT.md"), "utf8");
  const concepts = readFileSync(join(repoRoot, "docs/concepts.md"), "utf8");
  for (const body of [context, concepts]) {
    assert.match(body, /pipeline liveness restore|Liveness provider|dead worker is not-live|A dead worker is not-live/i);
    assert.doesNotMatch(body, /ask a human to own worker death/i);
    assert.doesNotMatch(body, /needs-human because the worker died/i);
  }
});

test("#971 wrappers call the same restore/follow CLI and are not the lifecycle owner", () => {
  const launcher = readFileSync(
    join(repoRoot, "examples/supervisor/shell/pipeline-launcher.sh"),
    "utf8",
  );
  assert.match(launcher, /pipeline liveness restore/);
  assert.match(launcher, /not the lifecycle owner/);
  assert.match(launcher, /exec /);
  assert.match(launcher, /must\n# not retry a supervised verb or classify recovery/);
  assert.equal((BUILTIN_OUTER_HOST_IDS as readonly string[]).includes("971-wrapper"), false);
  assert.equal((SKILL_HOST_IDS as readonly string[]).includes("971-wrapper"), false);
});
