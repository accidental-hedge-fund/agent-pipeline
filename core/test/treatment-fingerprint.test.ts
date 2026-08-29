// #778 — provider-neutral treatment fingerprint purity + version probe +
// verified-against drift (no network / real CLI required).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ADAPTER_CONTRACT_VERSION,
  adapterCapabilityHashPayload,
  buildTreatmentFingerprint,
  deriveTelemetryCoverage,
  hashAdapterCapabilities,
  sanitizeTreatmentFingerprint,
} from "../scripts/harness-adapters/treatment-fingerprint.ts";
import {
  createCliVersionProbeCache,
  parseCliVersionStdout,
  probeCliVersionOnce,
  _clearCliVersionProbeCacheForTests,
} from "../scripts/harness-adapters/cli-version-probe.ts";
import {
  BUILTIN_VERIFIED_AGAINST,
  extractComparableVersion,
  formatVersionDriftWarning,
  getVerifiedAgainst,
  versionsCompatible,
} from "../scripts/harness-adapters/verified-against.ts";
import { parseGrokTelemetry } from "../scripts/harness-adapters/grok.ts";
import { parseClaudeTelemetry } from "../scripts/harness-adapters/claude.ts";
import { parseCodexTelemetry } from "../scripts/harness-adapters/codex.ts";
import { buildStageAccountingRecord } from "../scripts/accounting.ts";
import { resolveAdapter, _resetRegistryForTests } from "../scripts/harness-adapters/index.ts";
import { EMPTY_TELEMETRY, type AdapterInvocation, type AdapterProbe } from "../scripts/harness-adapters/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "../scripts/harness-adapters/fixtures");

function readFixture(...parts: string[]): string {
  return readFileSync(path.join(FIXTURES, ...parts), "utf8");
}

const BASE_INVOCATION: AdapterInvocation = {
  cmd: "grok",
  args: ["--output-format", "streaming-json", "--permission-mode", "bypassPermissions"],
  cwd: "/tmp/wt",
  promptDelivery: "file",
};

function baseAdapterBits() {
  _resetRegistryForTests({ reseedBuiltins: true });
  const adapter = resolveAdapter("grok")!;
  return {
    adapterId: adapter.name,
    capabilities: adapter.capabilities,
    declaration: adapter.declaration,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint purity
// ---------------------------------------------------------------------------

test("buildTreatmentFingerprint: pure — no GitHub/eval coupling; null-safe missing fields", () => {
  const bits = baseAdapterBits();
  const probe: AdapterProbe = {
    cliVersion: "0.2.114",
    providerAuthClass: "unknown",
    resolvedModel: null,
    throttled: null,
  };
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: { model: "grok-4", effort: "high" },
    invocation: BASE_INVOCATION,
    probe,
    telemetry: null,
    role: "implementer",
    cliPath: "/usr/bin/grok",
  });
  assert.equal(fp.adapterId, "grok");
  assert.equal(fp.adapterContractVersion, ADAPTER_CONTRACT_VERSION);
  assert.equal(fp.cliVersion, "0.2.114");
  assert.equal(fp.cliPath, "/usr/bin/grok");
  assert.equal(fp.role, "implementer");
  assert.equal(fp.requestedModel, "grok-4");
  assert.equal(fp.resolvedModel, null, "must not echo requested model");
  assert.equal(fp.requestedEffort, "high");
  assert.equal(fp.resolvedEffort, null);
  assert.equal(fp.fallback, null, "unknown fallback must stay null, not false");
  assert.equal(fp.providerAuthClass, null, "unknown provider must not be fabricated from model/adapter");
  assert.equal(fp.costSource, "unknown");
  assert.equal(typeof fp.capabilityHash, "string");
  assert.equal(fp.capabilityHash.length, 16);
  // jsonl-declared adapter with no recovered telemetry → unknown (not unavailable)
  assert.equal(fp.telemetryCoverage.cost, "unknown");
});

test("buildTreatmentFingerprint: jsonl adapter without recovered telemetry marks channels unknown not unavailable", () => {
  const bits = baseAdapterBits();
  assert.equal(bits.capabilities.telemetry, "jsonl");
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: { model: "m" },
    invocation: BASE_INVOCATION,
    probe: { cliVersion: null, providerAuthClass: "unknown" },
    telemetry: { ...EMPTY_TELEMETRY },
  });
  assert.equal(fp.telemetryCoverage.cost, "unknown");
  assert.equal(fp.telemetryCoverage.usage, "unknown");
  assert.equal(fp.telemetryCoverage.resolvedModel, "unknown");
  assert.equal(fp.telemetryCoverage.throttled, "unknown");
});

test("buildTreatmentFingerprint: never infers provider from model name", () => {
  const bits = baseAdapterBits();
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: { model: "anthropic/claude-opus" },
    invocation: BASE_INVOCATION,
    probe: { cliVersion: null, providerAuthClass: "unknown" },
    telemetry: null,
  });
  assert.equal(fp.providerAuthClass, null);
  assert.notEqual(fp.providerAuthClass, "anthropic");
});

test("buildTreatmentFingerprint: recovered cost sets costSource actual and coverage recovered", () => {
  const bits = baseAdapterBits();
  const tel = parseGrokTelemetry(readFixture("grok", "output-format-json.json"));
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: { model: "requested-alias" },
    invocation: BASE_INVOCATION,
    probe: {
      cliVersion: "0.2.114",
      providerAuthClass: "unknown",
      resolvedModel: tel.resolvedModel,
      throttled: tel.throttled,
    },
    telemetry: tel,
    costSource: "actual",
  });
  assert.equal(fp.costSource, "actual");
  assert.equal(fp.resolvedModel, "grok-4.5-build");
  assert.notEqual(fp.resolvedModel, "requested-alias");
  assert.equal(fp.telemetryCoverage.cost, "recovered");
  assert.equal(fp.telemetryCoverage.usage, "recovered");
  assert.equal(fp.telemetryCoverage.resolvedModel, "recovered");
  assert.equal(fp.telemetryCoverage.throttled, "unknown", "grok has no throttle signal");
  assert.equal(fp.fallback, null);
});

test("hashAdapterCapabilities: stable for identical declaration, changes when telemetry flips", () => {
  const bits = baseAdapterBits();
  const a = hashAdapterCapabilities(bits.capabilities, bits.declaration);
  const b = hashAdapterCapabilities(bits.capabilities, bits.declaration);
  assert.equal(a, b);
  const flippedCaps = { ...bits.capabilities, telemetry: "none" as const };
  const flippedDecl = { ...bits.declaration, telemetry: "none" as const, outputEnvelope: "text" as const };
  assert.notEqual(a, hashAdapterCapabilities(flippedCaps, flippedDecl));
});

test("hashAdapterCapabilities: background_job_lifecycle is a pin input and support flips the hash (#1299)", () => {
  const bits = baseAdapterBits();
  const payload = adapterCapabilityHashPayload(bits.capabilities, bits.declaration);
  assert.ok("background_job_lifecycle" in payload);
  assert.ok("background_job_lifecycle_decl" in payload);
  const supported = {
    supported: true as const,
    schema: "pipeline/background-job-lifecycle@1" as const,
  };
  const flippedCaps = { ...bits.capabilities, background_job_lifecycle: supported };
  const flippedDecl = { ...bits.declaration, background_job_lifecycle: supported };
  assert.notEqual(
    hashAdapterCapabilities(bits.capabilities, bits.declaration),
    hashAdapterCapabilities(flippedCaps, flippedDecl),
  );
});

test("sanitizeTreatmentFingerprint: round-trips and drops invalid costSource", () => {
  const bits = baseAdapterBits();
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: {},
    invocation: BASE_INVOCATION,
    probe: { cliVersion: null, providerAuthClass: "unknown" },
    telemetry: null,
  });
  const cleaned = sanitizeTreatmentFingerprint(fp);
  assert.ok(cleaned);
  assert.equal(cleaned!.adapterId, "grok");
  assert.equal(sanitizeTreatmentFingerprint(null), undefined);
});

// ---------------------------------------------------------------------------
// Fixture-backed parseTelemetry (grok / claude / codex)
// ---------------------------------------------------------------------------

test("parseGrokTelemetry: output-format-json fixture recovers text/cost/usage/resolvedModel; throttled null", () => {
  const tel = parseGrokTelemetry(readFixture("grok", "output-format-json.json"));
  assert.equal(tel.text, "hello world");
  assert.equal(tel.costUsd, 0.00125);
  assert.equal(tel.usage?.input_tokens, 100);
  assert.equal(tel.resolvedModel, "grok-4.5-build");
  assert.equal(tel.throttled, null);
});

test("parseGrokTelemetry: streaming-json fixture recovers text from type:text and cost from type:end", () => {
  const tel = parseGrokTelemetry(readFixture("grok", "streaming-json-end.jsonl"));
  assert.equal(tel.text, "hello world");
  assert.equal(tel.costUsd, 0.00125);
  assert.equal(tel.resolvedModel, "grok-4.5-build");
  assert.equal(tel.throttled, null);
});

test("parseGrokTelemetry: tail-truncated capture still recovers cost/model from type:end only (#778 543d8bde)", () => {
  // Simulate MAX_OUTPUT tail that dropped early type:text lines and starts mid-stream.
  const truncated =
    `":"partial garbage mid-line"}\n` +
    `{"type":"text","data":" surviving"}\n` +
    `{"type":"end","stopReason":"EndTurn","usage":{"input_tokens":9,"output_tokens":1},"total_cost_usd":0.0033,"modelUsage":{"grok-4.5-build":{"inputTokens":9,"outputTokens":1,"costUSD":0.0033}}}\n`;
  const tel = parseGrokTelemetry(truncated);
  assert.equal(tel.costUsd, 0.0033);
  assert.equal(tel.resolvedModel, "grok-4.5-build");
  assert.equal(tel.usage?.input_tokens, 9);
  assert.equal(tel.text, " surviving");
  assert.equal(tel.throttled, null);
});

test("parseGrokTelemetry: unparseable / empty degrades to nulls without throw", () => {
  assert.doesNotThrow(() => parseGrokTelemetry(""));
  assert.doesNotThrow(() => parseGrokTelemetry("{broken"));
  assert.doesNotThrow(() => parseGrokTelemetry("plain text only"));
  const empty = parseGrokTelemetry("");
  assert.equal(empty.text, null);
  assert.equal(empty.costUsd, null);
  assert.equal(empty.resolvedModel, null);
  assert.equal(empty.throttled, null);
});

test("parseGrokTelemetry: never echoes a requested model (no request field on parser)", () => {
  // Parser has no access to request — resolvedModel only from modelUsage.
  const tel = parseGrokTelemetry('{"text":"hi","usage":{"input_tokens":1}}');
  assert.equal(tel.resolvedModel, null);
  assert.equal(tel.throttled, null);
});

test("claude/codex fixture corpus regressions still recover claimed fields", () => {
  const claude = parseClaudeTelemetry(readFixture("claude", "stream-json-result.jsonl"));
  assert.equal(claude.text, "hello world");
  assert.equal(claude.costUsd, 0.0014383);
  assert.equal(claude.resolvedModel, "claude-fable-5");
  assert.equal(claude.throttled, false);

  const codex = parseCodexTelemetry(readFixture("codex", "exec-json.jsonl"));
  assert.equal(codex.text, "hello world");
  assert.equal(codex.costUsd, null);
  assert.equal(codex.resolvedModel, null);
  assert.equal(codex.throttled, null);
  assert.equal(codex.usage?.input_tokens, 14385);
});

// ---------------------------------------------------------------------------
// Version probe once-per-run cache
// ---------------------------------------------------------------------------

test("cli-version-probe: caches per CLI identity; second call does not re-exec", async () => {
  _clearCliVersionProbeCacheForTests();
  let calls = 0;
  const deps = {
    exec: async (file: string, args: string[]) => {
      calls++;
      assert.equal(file, "grok");
      assert.deepEqual(args, ["--version"]);
      return { ok: true, stdout: "grok 0.2.114 (0c78503879) [stable]\n", stderr: "" };
    },
  };
  const a = await probeCliVersionOnce("grok", deps);
  const b = await probeCliVersionOnce("grok", deps);
  assert.equal(a.cliVersion, "0.2.114");
  assert.equal(b.cliVersion, "0.2.114");
  assert.equal(calls, 1, "must not spawn a second --version for the same CLI identity");
  _clearCliVersionProbeCacheForTests();
});

test("cli-version-probe: isolated cache + probe failure leaves null without throw", async () => {
  const cache = createCliVersionProbeCache();
  const result = await cache.get("missing-cli", {
    exec: async () => ({ ok: false, stdout: "", stderr: "not found" }),
  });
  assert.equal(result.probeOk, false);
  assert.equal(result.cliVersion, null);
});

test("parseCliVersionStdout: extracts semver-like token from common formats", () => {
  assert.equal(parseCliVersionStdout("grok 0.2.114 (0c78503879) [stable]"), "0.2.114");
  assert.equal(parseCliVersionStdout("claude 1.2.3"), "1.2.3");
  assert.equal(parseCliVersionStdout(""), null);
});

// ---------------------------------------------------------------------------
// Verified-against drift (fail-soft)
// ---------------------------------------------------------------------------

test("verified-against: every jsonl built-in has structured identity", () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  for (const name of ["claude", "codex", "grok"]) {
    const adapter = resolveAdapter(name)!;
    assert.equal(adapter.capabilities.telemetry, "jsonl");
    const v = getVerifiedAgainst(name);
    assert.ok(v, `${name} must have verified-against metadata`);
    assert.ok(v!.version.length > 0);
    assert.equal(v!.telemetry, "jsonl");
  }
  // pi/opencode remain none with disposition recorded
  assert.equal(resolveAdapter("pi")!.capabilities.telemetry, "none");
  assert.equal(resolveAdapter("opencode")!.capabilities.telemetry, "none");
  assert.equal(BUILTIN_VERIFIED_AGAINST.pi.telemetry, "none");
  assert.equal(BUILTIN_VERIFIED_AGAINST.opencode.telemetry, "none");
});

test("versionsCompatible / formatVersionDriftWarning: diverge warns; match silent; null probe no warn", () => {
  const verified = getVerifiedAgainst("grok")!;
  assert.equal(versionsCompatible("0.2.114", verified), true);
  assert.equal(formatVersionDriftWarning("grok", "0.2.114", verified), null);

  assert.equal(versionsCompatible("0.2.93", verified), false);
  const warn = formatVersionDriftWarning("grok", "0.2.93", verified);
  assert.ok(warn);
  assert.match(warn!, /version drift/);
  assert.match(warn!, /0\.2\.93/);
  assert.match(warn!, /0\.2\.114/);

  // Absent probe → no fabricated drift
  assert.equal(versionsCompatible(null, verified), true);
  assert.equal(formatVersionDriftWarning("grok", null, verified), null);

  // Non-semver verified labels skip drift
  assert.equal(versionsCompatible("anything", getVerifiedAgainst("claude")), true);
});

test("extractComparableVersion: prefers first major.minor.patch token", () => {
  assert.equal(extractComparableVersion("grok 0.2.114 (abc)"), "0.2.114");
  assert.equal(extractComparableVersion("  "), null);
});

// ---------------------------------------------------------------------------
// Accounting emission for grok-style recovered / unrecovered envelopes
// ---------------------------------------------------------------------------

test("buildStageAccountingRecord: grok-style recovered cost → actual + resolved_model + fingerprint", () => {
  const bits = baseAdapterBits();
  const tel = parseGrokTelemetry(readFixture("grok", "output-format-json.json"));
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: { model: "requested" },
    invocation: BASE_INVOCATION,
    probe: {
      cliVersion: "0.2.114",
      providerAuthClass: "unknown",
      resolvedModel: tel.resolvedModel,
      throttled: null,
    },
    telemetry: tel,
    costSource: "actual",
  });
  const record = buildStageAccountingRecord({
    runId: "run-778",
    issue: 778,
    stage: "implementing",
    harness: "grok",
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: "2026-08-04T00:00:01.000Z",
    outcome: "success",
    usage: { total_cost_usd: tel.costUsd, usage: tel.usage },
    adapter: "grok",
    adapterCliVersion: "0.2.114",
    requestedModel: "requested",
    resolvedModel: tel.resolvedModel,
    throttled: null,
    treatmentFingerprint: fp,
  });
  assert.equal(record.cost_source, "actual");
  // stage accounting rounds USD (roundUsd); fixture cost 0.00125 → 0.0013
  assert.equal(record.cost_usd, 0.0013);
  assert.equal(record.adapter_cli_version, "0.2.114");
  assert.equal(record.resolved_model, "grok-4.5-build");
  assert.equal(record.throttled, undefined, "null throttle omitted, never false");
  assert.ok(record.treatment_fingerprint);
  assert.equal(record.treatment_fingerprint!.adapterId, "grok");
  assert.equal(record.treatment_fingerprint!.cliVersion, "0.2.114");
  assert.equal(record.treatment_fingerprint!.costSource, "actual");
  assert.equal(record.treatment_fingerprint!.resolvedModel, "grok-4.5-build");
  assert.notEqual(record.treatment_fingerprint!.resolvedModel, "requested");
});

test("buildStageAccountingRecord: unrecovered envelope stays unknown with null cost_usd (no zero-fill)", () => {
  const bits = baseAdapterBits();
  const fp = buildTreatmentFingerprint({
    ...bits,
    request: { model: "requested" },
    invocation: BASE_INVOCATION,
    probe: { cliVersion: null, providerAuthClass: "unknown", resolvedModel: null, throttled: null },
    telemetry: { ...EMPTY_TELEMETRY },
  });
  const record = buildStageAccountingRecord({
    runId: "run-778",
    issue: 778,
    stage: "implementing",
    harness: "grok",
    startedAt: "2026-08-04T00:00:00.000Z",
    outcome: "success",
    adapter: "grok",
    requestedModel: "requested",
    resolvedModel: null,
    treatmentFingerprint: fp,
  });
  assert.equal(record.cost_source, "unknown");
  assert.equal(record.cost_usd, null);
  assert.equal(record.resolved_model, undefined);
  assert.equal(record.adapter_cli_version, undefined);
  assert.equal(record.treatment_fingerprint!.costSource, "unknown");
  assert.equal(record.treatment_fingerprint!.resolvedModel, null);
});

test("deriveTelemetryCoverage: none adapter marks all channels unavailable", () => {
  const cov = deriveTelemetryCoverage("none", null);
  assert.equal(cov.cost, "unavailable");
  assert.equal(cov.usage, "unavailable");
  assert.equal(cov.resolvedModel, "unavailable");
  assert.equal(cov.throttled, "unavailable");
});
