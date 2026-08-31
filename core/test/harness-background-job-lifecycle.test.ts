// #1299 — background-job lifecycle capability, join-grace watchdog, reason
// code, mutating-implementer preflight, salvage-without-success, no same-
// adapter retry. Injectable event streams only — no real network/git/CLI.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { invoke } from "../scripts/harness.ts";
import {
  BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS,
  BACKGROUND_JOB_LIFECYCLE_SCHEMA,
  BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  BackgroundJobLifecycleSupervisor,
  adapterCapabilityHashPayload,
  allAdapters,
  backgroundJobLifecycleCoherenceFailure,
  buildAdapterDeclaration,
  checkStructure,
  effectiveJoinGraceMs,
  filterRecipesForHarnessBackgroundWait,
  harnessInvocationFingerprint,
  hashAdapterCapabilities,
  hashPromptForFingerprint,
  materializeCompatibilityAdapter,
  parseLifecycleJsonl,
  protocolFixtureSupportIsHonest,
  protocolProvesBackgroundJobLifecycle,
  redactLifecycleEvent,
  registerAdapter,
  requiresBackgroundJobLifecycle,
  resolveAdapter,
  runConformanceKit,
  runInjectedLifecycleSupervisor,
  runProductionPreflight,
  sameAdapterRetryForbidden,
  supportedBackgroundJobLifecycle,
  _resetRegistryForTests,
  type AdapterPreflightDeps,
  type BackgroundJobLifecycleEvent,
  type BackgroundJobProtocolFixture,
  type HarnessAdapter,
  type InjectedLifecycleEvent,
} from "../scripts/harness-adapters/index.ts";
import { defaultProductionPreflightDeps } from "../scripts/harness-adapters/production-preflight.ts";
import { classifyHarnessFailure, interventionKindFromReason, isMechanicalInfrastructureReason } from "../scripts/escalation-classify.ts";
import { STAGE_DIAGNOSTIC_REASON_CODES, buildStageDiagnostic, projectPipelineReasonCode } from "../scripts/stage-diagnostic.ts";
import { invokeFixHarnessWithRetry } from "../scripts/stages/fix.ts";
import { buildImplementingPrompt } from "../scripts/prompts/index.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(
  HERE,
  "../scripts/harness-adapters/fixtures/background-job-lifecycle",
);

function readProtocolFixture(name: string): BackgroundJobProtocolFixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as BackgroundJobProtocolFixture;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function lifecycleEvent(
  kind: BackgroundJobLifecycleEvent["kind"],
  opts: { jobId?: string; atMs?: number; state?: string; extra?: Record<string, unknown> } = {},
): BackgroundJobLifecycleEvent & Record<string, unknown> {
  return {
    schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA,
    kind,
    adapter: "lifecycle-test",
    invocation_id: "inv-1",
    job_id: opts.jobId ?? "job-1",
    timestamp: isoAt(opts.atMs ?? 0),
    state: opts.state ?? kind,
    ...(opts.extra ?? {}),
  };
}

function makeAdapter(opts: {
  name: string;
  lifecycle: HarnessAdapter["capabilities"]["background_job_lifecycle"];
  omitLifecycle?: boolean;
}): HarnessAdapter {
  const caps = {
    model: false,
    effort: false,
    sandbox: false,
    workingDir: "cwd" as const,
    telemetry: "none" as const,
    maxPromptBytes: "unlimited" as const,
    ...(opts.omitLifecycle ? {} : { background_job_lifecycle: opts.lifecycle }),
  };
  const adapter: HarnessAdapter = {
    name: opts.name,
    capabilities: caps as HarnessAdapter["capabilities"],
    declaration: buildAdapterDeclaration({
      command: opts.name,
      capabilities: caps as HarnessAdapter["capabilities"],
      promptDelivery: "stdin",
      origin: "extension",
      authProbe: "none",
      versionProbe: "none",
    }),
    buildInvocation(ctx) {
      return {
        cmd: opts.name,
        args: ["--print"],
        cwd: ctx.worktreeDir,
        promptDelivery: "stdin",
        stdinPayload: ctx.prompt,
      };
    },
    async preflight() {
      return { ok: true, authState: "unknown" };
    },
    parseTelemetry() {
      return { text: null, costUsd: null, usage: null, resolvedModel: null, throttled: null };
    },
    parseBackgroundJobLifecycle(chunk, ctx) {
      return parseLifecycleJsonl(chunk, ctx);
    },
    describeTreatment(req, _inv, probe) {
      return {
        adapter: opts.name,
        cliVersion: probe.cliVersion,
        providerAuthClass: probe.providerAuthClass,
        requestedModel: req.model ?? null,
        resolvedModel: null,
        requestedEffort: req.effort ?? null,
        resolvedEffort: null,
        nativeFlags: [],
        fallback: null,
        throttled: null,
        origin: "extension",
      };
    },
    async runtimeSmoke() {
      return { ok: true };
    },
  };
  if (opts.lifecycle.supported !== true) {
    delete adapter.parseBackgroundJobLifecycle;
  }
  if (opts.omitLifecycle) {
    delete (adapter.declaration as { background_job_lifecycle?: unknown }).background_job_lifecycle;
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// 1. Capability declaration + hash identity
// ---------------------------------------------------------------------------

test("background_job_lifecycle omitted fails structure and names the field", () => {
  const adapter = makeAdapter({
    name: "omit-lifecycle",
    lifecycle: BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
    omitLifecycle: true,
  });
  const report = checkStructure(adapter);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((f) => f.message.includes("background_job_lifecycle")),
    JSON.stringify(report.failures),
  );
});

test("join grace above pipeline max fails conformance by naming the incoherent grace", () => {
  const fail = backgroundJobLifecycleCoherenceFailure({
    supported: true,
    schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA,
    join_grace_ms: BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS + 1,
  });
  assert.ok(fail);
  assert.match(fail!, /incoherent join grace/);
  assert.match(fail!, /background_job_lifecycle/);
  assert.equal(
    effectiveJoinGraceMs({
      supported: true,
      schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA,
      join_grace_ms: BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS + 50_000,
    }),
    BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS,
  );
});

test("hashAdapterCapabilities: support vs non-support changes the hash; payload pins the field", () => {
  const unsupported = makeAdapter({
    name: "hash-a",
    lifecycle: BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  });
  const supported = makeAdapter({
    name: "hash-b",
    lifecycle: supportedBackgroundJobLifecycle(30_000),
  });
  const a = hashAdapterCapabilities(unsupported.capabilities, unsupported.declaration);
  const bCaps = {
    ...unsupported.capabilities,
    background_job_lifecycle: supported.capabilities.background_job_lifecycle,
  };
  const bDecl = {
    ...unsupported.declaration,
    background_job_lifecycle: supported.declaration.background_job_lifecycle,
  };
  const b = hashAdapterCapabilities(bCaps, bDecl);
  assert.notEqual(a, b);
  const payload = adapterCapabilityHashPayload(unsupported.capabilities, unsupported.declaration);
  assert.ok("background_job_lifecycle" in payload);
  assert.ok("background_job_lifecycle_decl" in payload);
  const stripped = { ...payload };
  delete stripped.background_job_lifecycle;
  delete stripped.background_job_lifecycle_decl;
  assert.ok(!("background_job_lifecycle" in stripped));
  assert.notDeepEqual(payload, stripped);
});

test("effectiveJoinGraceMs is min(declared, 120_000)", () => {
  assert.equal(BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS, 120_000);
  assert.equal(
    effectiveJoinGraceMs(supportedBackgroundJobLifecycle(5_000)),
    5_000,
  );
  assert.equal(
    effectiveJoinGraceMs(supportedBackgroundJobLifecycle()),
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 2. Built-in adapters + protocol fixtures
// ---------------------------------------------------------------------------

test("every built-in declares background_job_lifecycle explicitly unsupported", () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  for (const name of ["claude", "codex", "grok", "pi", "opencode"]) {
    const adapter = resolveAdapter(name);
    assert.ok(adapter, name);
    assert.deepEqual(adapter!.capabilities.background_job_lifecycle, BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED);
    assert.deepEqual(adapter!.declaration.background_job_lifecycle, BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED);
    const report = checkStructure(adapter!);
    assert.equal(report.ok, true, `${name}: ${JSON.stringify(report.failures)}`);
  }
});

test("historical #547 and incident #268 protocol fixtures stay unsupported", () => {
  for (const file of ["claude-547.json", "incident-268.json"]) {
    const fixture = readProtocolFixture(file);
    assert.equal(protocolProvesBackgroundJobLifecycle(fixture), false);
    assert.equal(protocolFixtureSupportIsHonest(fixture), true);
    assert.equal(fixture.background_job_lifecycle.supported, false);
    assert.ok(fixture.transcript_excerpt);
    assert.match(fixture.transcript_excerpt!, /background/i);
  }
});

test("conformance kit iterates built-ins, extensions, and compatibility for lifecycle declaration", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  const deps: AdapterPreflightDeps = {
    exec: async () => ({ ok: true, stdout: "ok", stderr: "" }),
    execCheck: async () => true,
    fsExists: async () => true,
    fsExecutable: async () => true,
  };
  for (const adapter of allAdapters()) {
    const report = await runConformanceKit(adapter, deps);
    assert.equal(report.ok, true, `${adapter.name}: ${JSON.stringify(report.failures)}`);
  }
  const compat = materializeCompatibilityAdapter("kit-lifecycle-reviewer");
  const compatReport = await runConformanceKit(compat, deps);
  assert.equal(compatReport.ok, true, JSON.stringify(compatReport.failures));
  const omit = makeAdapter({
    name: "kit-omit",
    lifecycle: BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
    omitLifecycle: true,
  });
  const omitReport = checkStructure(omit);
  assert.equal(omitReport.ok, false);
  assert.ok(omitReport.failures.some((f) => /background_job_lifecycle/.test(f.message)));
  const noSchema = checkStructure(
    makeAdapter({
      name: "kit-noschema",
      lifecycle: { supported: true } as never,
    }),
  );
  assert.equal(noSchema.ok, false);
  assert.ok(noSchema.failures.some((f) => /background_job_lifecycle/.test(f.message)));
});

// ---------------------------------------------------------------------------
// 3. Typed lifecycle stream + join-grace watchdog
// ---------------------------------------------------------------------------

test("redaction rejects command/tool/prompt/secret payloads", () => {
  for (const extra of [
    { command: "npm test" },
    { tool_output: "secret-bytes" },
    { prompt: "system prompt" },
    { secret: "TOKEN" },
  ]) {
    const parsed = redactLifecycleEvent(lifecycleEvent("job_completed", { extra }));
    assert.equal(parsed.ok, false);
  }
  const clean = redactLifecycleEvent(lifecycleEvent("job_completed"));
  assert.equal(clean.ok, true);
  if (clean.ok) {
    assert.equal(clean.event.job_id, "job-1");
    assert.equal("command" in clean.event, false);
  }
});

test("valid join inside grace is not harness-background-wait or timeout", () => {
  const events: InjectedLifecycleEvent[] = [
    { atMs: 10, event: lifecycleEvent("job_started", { atMs: 10, state: "running" }) },
    { atMs: 20, event: lifecycleEvent("job_completed", { atMs: 20, state: "completed" }) },
    { atMs: 25, event: lifecycleEvent("notification_delivered", { atMs: 25, state: "completed" }) },
    { atMs: 30, event: lifecycleEvent("foreground_joined", { atMs: 30, state: "joined" }) },
  ];
  const result = runInjectedLifecycleSupervisor({
    events,
    joinGraceMs: 50,
    outerDeadlineMs: 5_000,
    adapter: "lifecycle-test",
    invocationId: "inv-1",
  });
  assert.equal(result.background_wait, false);
  assert.equal(result.timed_out, false);
  assert.equal(result.outcome, "joined");
  assert.ok(result.durationMs < 5_000);
});

test("completed-but-undelivered bites before outer timeout and does not set timed_out", () => {
  const events: InjectedLifecycleEvent[] = [
    { atMs: 10, event: lifecycleEvent("job_started", { atMs: 10, state: "running" }) },
    { atMs: 20, event: lifecycleEvent("job_completed", { atMs: 20, state: "completed" }) },
  ];
  const result = runInjectedLifecycleSupervisor({
    events,
    joinGraceMs: 50,
    outerDeadlineMs: 5_000,
    adapter: "lifecycle-test",
    invocationId: "inv-1",
  });
  assert.equal(result.background_wait, true);
  assert.equal(result.timed_out, false);
  assert.ok(result.durationMs < 5_000, `duration ${result.durationMs} should be grace-bounded`);
  assert.equal(result.evidence?.job_id, "job-1");
  assert.equal(result.evidence?.state, "completed");
  const classified = classifyHarnessFailure({
    background_wait: result.background_wait,
    timed_out: result.timed_out,
  });
  assert.equal(classified, "harness-background-wait");
});

test("unjoined after delivery still ends as harness-background-wait before outer cap", () => {
  const events: InjectedLifecycleEvent[] = [
    { atMs: 10, event: lifecycleEvent("job_started", { atMs: 10, state: "running" }) },
    { atMs: 20, event: lifecycleEvent("job_failed", { atMs: 20, state: "failed" }) },
    { atMs: 25, event: lifecycleEvent("notification_delivered", { atMs: 25, state: "failed" }) },
  ];
  const result = runInjectedLifecycleSupervisor({
    events,
    joinGraceMs: 40,
    outerDeadlineMs: 10_000,
    adapter: "lifecycle-test",
    invocationId: "inv-1",
  });
  assert.equal(result.background_wait, true);
  assert.equal(result.timed_out, false);
  assert.ok(result.durationMs < 10_000);
});

test("long-running job with no complete/fail is harness-timeout not background-wait", () => {
  const events: InjectedLifecycleEvent[] = [
    { atMs: 0, event: lifecycleEvent("job_started", { atMs: 0, state: "running" }) },
    { atMs: 5_000, event: lifecycleEvent("job_completed", { atMs: 5_000, state: "completed" }) },
  ];
  const result = runInjectedLifecycleSupervisor({
    events,
    joinGraceMs: 50,
    outerDeadlineMs: 100,
    adapter: "lifecycle-test",
    invocationId: "inv-1",
  });
  assert.equal(result.timed_out, true);
  assert.equal(result.background_wait, false);
  assert.equal(result.outcome, "outer_timeout");
  assert.equal(
    classifyHarnessFailure({ timed_out: true, background_wait: false }),
    "harness-timeout",
  );
});

test("malformed and duplicate events are non-joins; waiting prose is not proof", () => {
  const supervisor = new BackgroundJobLifecycleSupervisor({
    joinGraceMs: 50,
    outerDeadlineMs: 1_000,
    nowMs: () => 0,
    startedAtMs: 0,
  });
  const malformed = supervisor.feed({ schema: BACKGROUND_JOB_LIFECYCLE_SCHEMA });
  assert.equal(malformed.ok, false);
  const first = lifecycleEvent("job_started", { atMs: 0, state: "running" });
  assert.equal(supervisor.feed(first).ok, true);
  assert.equal(supervisor.feed(first).ok, true, "identical duplicate is idempotent");
  supervisor.feed(lifecycleEvent("job_completed", { atMs: 10, state: "completed" }));
  supervisor.feed(lifecycleEvent("job_failed", { atMs: 11, state: "failed" }));
  const atGrace = new BackgroundJobLifecycleSupervisor({
    joinGraceMs: 50,
    outerDeadlineMs: 1_000,
    nowMs: () => 0,
    startedAtMs: 0,
  });
  atGrace.feed(lifecycleEvent("job_started"));
  assert.equal(atGrace.evaluate().kind, "continue");
  const prose = runInjectedLifecycleSupervisor({
    events: [],
    joinGraceMs: 50,
    outerDeadlineMs: 80,
    adapter: "claude",
    invocationId: "inv-prose",
    transcript: "I'll wait for the background test run's notification before committing",
  });
  assert.equal(prose.background_wait, false);
  assert.equal(prose.timed_out, true);
});

test("invoke() injected stream does not spawn a subprocess", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  const adapter = makeAdapter({
    name: "lifecycle-inject",
    lifecycle: supportedBackgroundJobLifecycle(50),
  });
  registerAdapter(adapter);
  const result = await invoke("lifecycle-inject", "/tmp/wt", "prompt", {
    stageKind: "implement",
    timeoutSec: 5,
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "ok", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => "/bin/true",
      fsExecutable: async () => true,
    }),
    lifecycle: {
      skipSpawn: true,
      eventStream: [
        { atMs: 10, event: lifecycleEvent("job_started", { atMs: 10, state: "running" }) },
        { atMs: 20, event: lifecycleEvent("job_completed", { atMs: 20, state: "completed" }) },
      ],
    },
  });
  assert.equal(result.background_wait, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.success, false);
  assert.ok(result.lifecycle_evidence);
  assert.equal("command" in (result.lifecycle_evidence as object), false);
});

// ---------------------------------------------------------------------------
// 4. Diagnostic reason, preflight, retry
// ---------------------------------------------------------------------------

test("harness-background-wait is additive, maps before timed_out, projects recover", () => {
  assert.ok(STAGE_DIAGNOSTIC_REASON_CODES.includes("harness-background-wait"));
  assert.equal(
    classifyHarnessFailure({ background_wait: true, timed_out: true }),
    "harness-background-wait",
  );
  assert.equal(classifyHarnessFailure({ timed_out: true }), "harness-timeout");
  const proj = projectPipelineReasonCode("harness-background-wait");
  assert.equal(proj.blockerClass, "workflow-engine-defect");
  assert.equal(proj.disposition, "recover");
  assert.notEqual(proj.disposition, "human_authority");
  assert.equal(isMechanicalInfrastructureReason("harness-background-wait"), true);
  assert.equal(interventionKindFromReason("harness-background-wait"), "reviewer-unavailable");
  const diag = buildStageDiagnostic({
    reasonCode: "harness-background-wait",
    blockerKind: "harness-failure",
    reason: "missed join",
    stage: "implementing",
  });
  assert.equal(diag.reason_code, "harness-background-wait");
});

test("mutating implementer preflight spawns explicit unsupported; omits still refuse", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  const adapter = makeAdapter({
    name: "no-lifecycle-cli",
    lifecycle: BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  });
  registerAdapter(adapter);
  const omitted = makeAdapter({
    name: "omit-lifecycle-cli",
    lifecycle: BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
    omitLifecycle: true,
  });
  registerAdapter(omitted);
  const deps = defaultProductionPreflightDeps({
    exec: async (_file, args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) {
        return { ok: true, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      }
      return { ok: true, stdout: "ok", stderr: "" };
    },
    execCheck: async () => true,
    resolvePath: async () => "/bin/true",
    fsExecutable: async () => true,
  });
  for (const stageKind of ["implement", "fix-round", "test-fix", "eval-fix", "visual-fix"] as const) {
    const allowed = await runProductionPreflight(
      adapter,
      { prompt: "p", stageKind, role: "implementer" },
      deps,
    );
    assert.equal(allowed.ok, true, stageKind);
    const refused = await runProductionPreflight(
      omitted,
      { prompt: "p", stageKind, role: "implementer" },
      deps,
    );
    assert.equal(refused.ok, false, stageKind);
    if (!refused.ok) {
      assert.equal(refused.remediation.reasonCode, "capability-refusal");
      assert.match(refused.remediation.message, /background_job_lifecycle/);
      assert.match(refused.remediation.message, /omit-lifecycle-cli/);
      assert.match(refused.remediation.message, /omits/);
      assert.match(refused.remediation.message, /cannot succeed/);
    }
    assert.equal(requiresBackgroundJobLifecycle(stageKind), true);
  }
  const plan = await runProductionPreflight(
    adapter,
    { prompt: "p", stageKind: "planning", role: "implementer" },
    deps,
  );
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const review = await runProductionPreflight(
    adapter,
    { prompt: "p", stageKind: "review", role: "reviewer" },
    deps,
  );
  assert.equal(review.ok, true, JSON.stringify(review));
  const supported = makeAdapter({
    name: "yes-lifecycle-cli",
    lifecycle: supportedBackgroundJobLifecycle(10_000),
  });
  const ok = await runProductionPreflight(
    supported,
    { prompt: "p", stageKind: "implement", role: "implementer" },
    deps,
  );
  assert.equal(ok.ok, true);
  for (const name of ["claude", "codex", "grok"] as const) {
    const builtin = resolveAdapter(name)!;
    assert.equal(builtin.capabilities.background_job_lifecycle.supported, false, name);
    const impl = await runProductionPreflight(
      builtin,
      { prompt: "p", stageKind: "implement", role: "implementer" },
      deps,
    );
    if (!impl.ok) {
      assert.doesNotMatch(impl.remediation.message, /background_job_lifecycle/, name);
    }
  }
  const claudePlan = await runProductionPreflight(
    resolveAdapter("claude")!,
    { prompt: "p", stageKind: "planning", role: "implementer" },
    deps,
  );
  assert.equal(claudePlan.ok, true, JSON.stringify(claudePlan));
});

test("same-adapter retry of the same fingerprint is refused and does not spawn", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  const adapter = makeAdapter({
    name: "retry-lifecycle",
    lifecycle: supportedBackgroundJobLifecycle(50),
  });
  registerAdapter(adapter);
  const fingerprint = harnessInvocationFingerprint({
    adapter: "retry-lifecycle",
    stageKind: "implement",
    promptHash: "abc",
  });
  assert.equal(
    sameAdapterRetryForbidden({
      adapter: "retry-lifecycle",
      fingerprint,
      previous: { adapter: "retry-lifecycle", fingerprint, reason: "harness-background-wait" },
    }),
    true,
  );
  const result = await invoke("retry-lifecycle", "/tmp/wt", "prompt", {
    stageKind: "implement",
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "ok", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => "/bin/true",
      fsExecutable: async () => true,
    }),
    lifecycle: {
      previous: {
        adapter: "retry-lifecycle",
        fingerprint: harnessInvocationFingerprint({
          adapter: "retry-lifecycle",
          stageKind: "implement",
          model: null,
          effort: null,
          promptHash: hashPromptForFingerprint("prompt"),
        }),
        reason: "harness-background-wait",
      },
    },
  });
  assert.equal(result.background_wait, true);
  assert.equal(result.timed_out, false);
  assert.match(result.stderr, /same-adapter retry/);
  assert.equal(result.duration, 0);

  const retry = await invokeFixHarnessWithRetry({
    basePrompt: "fix",
    fixTimeoutSec: 100,
    maxRetries: 2,
    invokeAttempt: async () => ({
      success: false,
      stdout: "",
      stderr: "wait",
      exit_code: -1,
      duration: 1,
      timed_out: false,
      background_wait: true,
    }),
  });
  assert.equal(retry.attempts.length, 1);
  assert.equal(retry.finalResult.background_wait, true);
});

test("invokeFixHarnessWithRetry does not retry a typed production-preflight refusal", async () => {
  let calls = 0;
  const retry = await invokeFixHarnessWithRetry({
    basePrompt: "fix",
    fixTimeoutSec: 100,
    maxRetries: 2,
    invokeAttempt: async () => {
      calls += 1;
      return {
        success: false,
        stdout: "",
        stderr:
          "[harness grok] adapter omits background_job_lifecycle. retrying the same invocation cannot succeed",
        exit_code: -1,
        duration: 0,
        timed_out: false,
        preflight_failed: true,
        preflight_class: "unsupported-setting",
        preflight_reason_code: "capability-refusal",
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(retry.attempts.length, 1);
  assert.equal(retry.finalResult.preflight_failed, true);
  assert.equal(retry.finalResult.preflight_reason_code, "capability-refusal");
  assert.equal(
    classifyHarnessFailure(retry.finalResult),
    "capability-refusal",
  );
});

test("harness-background-wait recovery recipes do not include same-adapter repair or publish", () => {
  const filtered = filterRecipesForHarnessBackgroundWait([
    "unlink_engine_scratch",
    "checkpoint_owned_harness_dirt",
    "publish_unpublished_stage_commit",
    "restart_workflow_engine",
    "repair_pipeline_item",
  ]);
  assert.deepEqual(filtered, [
    "unlink_engine_scratch",
    "checkpoint_owned_harness_dirt",
    "restart_workflow_engine",
  ]);
});

// ---------------------------------------------------------------------------
// 5. Salvage without success or publish
// ---------------------------------------------------------------------------

test("salvage-plus-background-wait fixture does not claim publish or review-1", () => {
  const result = {
    success: false,
    timed_out: false,
    background_wait: true,
    salvaged: true,
  };
  assert.equal(result.timed_out, false);
  assert.equal(result.background_wait, true);
  const reason = classifyHarnessFailure(result);
  assert.equal(reason, "harness-background-wait");
  assert.notEqual(reason, "harness-timeout");
  const recipes = filterRecipesForHarnessBackgroundWait(["publish_unpublished_stage_commit", "repair_pipeline_item"]);
  assert.equal(recipes.includes("publish_unpublished_stage_commit"), false);
  assert.equal(recipes.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Prompt discipline coexistence
// ---------------------------------------------------------------------------

test("lifecycle-tracked join is not a prompt-discipline failure; waiting prose is not a hang classifier", () => {
  const implementing = buildImplementingPrompt({
    cfg: {
      domain: "acme",
      repo: "acme/widget",
      repo_dir: "/tmp/does-not-exist",
      base_branch: "main",
      worktree_root: ".worktrees",
      max_concurrent_worktrees: 5,
      auto_recovery_max_retries: 2,
      implementation_timeout: 1200,
      review_timeout: 1200,
      fix_timeout: 1200,
      ci_timeout: 900,
      ci_poll_interval: 30,
      harnesses: { implementer: "codex", reviewer: "claude" },
      models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
      openspec: { enabled: "auto", bootstrap: false },
      last30days: { enabled: false, timeout: 600 },
      steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
      domain_name: "Widget",
      domain_description: "the example widget service",
    } as PipelineConfig,
    issueNumber: 1299,
    title: "t",
    body: "b",
    plan: "p",
    pipelineRunId: "1299/2026-08-29T17:39:28Z",
  });
  assert.match(implementing, /single-turn/i);
  const joined = runInjectedLifecycleSupervisor({
    events: [
      { atMs: 1, event: lifecycleEvent("job_started", { atMs: 1, state: "running" }) },
      { atMs: 2, event: lifecycleEvent("job_completed", { atMs: 2, state: "completed" }) },
      { atMs: 3, event: lifecycleEvent("notification_delivered", { atMs: 3, state: "completed" }) },
      { atMs: 4, event: lifecycleEvent("foreground_joined", { atMs: 4, state: "joined" }) },
    ],
    joinGraceMs: 50,
    outerDeadlineMs: 1_000,
    adapter: "lifecycle-test",
    invocationId: "inv-1",
  });
  assert.equal(joined.outcome, "joined");
  const prose = runInjectedLifecycleSupervisor({
    events: [],
    joinGraceMs: 50,
    outerDeadlineMs: 60,
    adapter: "claude",
    invocationId: "inv-prose",
    transcript: "Let's check on the background test run.",
  });
  assert.equal(prose.background_wait, false);
});
