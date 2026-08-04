// Production preflight-on-invoke (#636): exact resolved treatment, absolute
// executable resolution, capability refusal matrix, typed remediation, PATH
// parity, and once-per-run version probe consumption.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  invoke,
  runProductionPreflight,
  projectPreflightRemediation,
  resolveAbsoluteExecutable,
  defaultProductionPreflightDeps,
  type ProductionPreflightDeps,
} from "../scripts/harness.ts";
import {
  _clearCliVersionProbeCacheForTests,
  _peekCliVersionProbeForTests,
  _resetRegistryForTests,
  buildAdapterDeclaration,
  materializeCompatibilityAdapter,
  probeCliVersionOnce,
  registerAdapter,
  resolveAdapter,
  type AdapterPreflightDeps,
  type AdapterRequest,
  type HarnessAdapter,
  type MaxPromptBytes,
} from "../scripts/harness-adapters/index.ts";
import {
  assertHarnessDiscoveryParity,
  packDetachHarnessEnv,
  PIPELINE_HARNESS_CLI_PATHS_ENV,
  spawnDetached,
  type SpawnDetachedDeps,
} from "../scripts/detach.ts";
import { EventEmitter } from "node:events";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-preflight-636-"));

function okPreflightDeps(overrides: Partial<AdapterPreflightDeps> = {}): AdapterPreflightDeps {
  return {
    exec: async () => ({ ok: true, stdout: "ok\n", stderr: "" }),
    execCheck: async () => true,
    fsExists: async () => true,
    fsExecutable: async () => true,
    ...overrides,
  };
}

function makeRecordingAdapter(opts: {
  name: string;
  roles?: ("implementer" | "reviewer")[];
  maxPromptBytes?: MaxPromptBytes;
  preflight?: HarnessAdapter["preflight"];
  sandboxSupported?: boolean;
}): { adapter: HarnessAdapter; calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  const caps = {
    model: true,
    effort: true,
    sandbox: opts.sandboxSupported ?? true,
    workingDir: "cwd" as const,
    telemetry: "none" as const,
    maxPromptBytes: opts.maxPromptBytes ?? ("unlimited" as const),
  };
  const adapter: HarnessAdapter = {
    name: opts.name,
    capabilities: caps,
    declaration: buildAdapterDeclaration({
      command: opts.name,
      capabilities: caps,
      promptDelivery: "stdin",
      roles: opts.roles ?? ["implementer", "reviewer"],
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
    async preflight(deps, req) {
      calls.push({ ...req });
      if (opts.preflight) return opts.preflight(deps, req);
      if (!(await deps.execCheck(opts.name, ["--version"]))) {
        return {
          ok: false,
          failure: "missing-cli",
          message: `${opts.name} CLI not found on PATH`,
        };
      }
      if (req.sandbox && !caps.sandbox) {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: `${opts.name} does not support sandbox`,
        };
      }
      return { ok: true, authState: "unknown" };
    },
    parseTelemetry() {
      return { text: null, costUsd: null, usage: null, resolvedModel: null, throttled: null };
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
    async runtimeSmoke(deps) {
      return (await deps.execCheck(opts.name, ["--version"]))
        ? { ok: true }
        : { ok: false, failure: "missing-cli", message: "missing" };
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Exact resolved request for implementer + reviewer
// ---------------------------------------------------------------------------

test("production preflight: implementer and reviewer pass distinct exact model/effort/sandbox/sandboxMode", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
  const { adapter, calls } = makeRecordingAdapter({ name: "ext-exact-636" });
  registerAdapter(adapter);

  const deps: ProductionPreflightDeps = defaultProductionPreflightDeps({
    exec: async () => ({ ok: true, stdout: "ext-exact-636 1.2.3\n", stderr: "" }),
    execCheck: async () => true,
    resolvePath: async () => "/usr/local/bin/ext-exact-636",
  });

  const impl = await runProductionPreflight(
    adapter,
    {
      prompt: "implement me",
      role: "implementer",
      model: "impl-model-x",
      effort: "high",
      sandbox: true,
      sandboxMode: "managed",
    },
    deps,
  );
  const rev = await runProductionPreflight(
    adapter,
    {
      prompt: "review me",
      role: "reviewer",
      model: "rev-model-y",
      effort: "low",
      sandbox: false,
      sandboxMode: "external-bypass",
    },
    deps,
  );

  assert.equal(impl.ok, true);
  assert.equal(rev.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    model: "impl-model-x",
    effort: "high",
    sandbox: true,
    sandboxMode: "managed",
  });
  assert.deepEqual(calls[1], {
    model: "rev-model-y",
    effort: "low",
    sandbox: false,
    sandboxMode: "external-bypass",
  });
  assert.equal(impl.ok && impl.role, "implementer");
  assert.equal(rev.ok && rev.role, "reviewer");
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
});

test("invoke(): production preflight receives exact resolved treatment for both roles (injected deps)", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
  const { adapter, calls } = makeRecordingAdapter({ name: "invoke-exact-636" });
  // Preflight ok, but buildInvocation would spawn — use a real executable body
  // only if preflight is injected to always-ok and we skip real spawn by failing
  // preflight after capture... better: inject preflight that records and fails
  // after first call so spawn never runs.
  const seen: AdapterRequest[] = [];
  let roleSeen: string[] = [];
  registerAdapter({
    ...adapter,
    async preflight(_deps, req) {
      seen.push({ ...req });
      return { ok: false, failure: "unauthenticated", message: "stop-after-capture" };
    },
  });

  const baseDeps = defaultProductionPreflightDeps({
    exec: async () => ({ ok: true, stdout: "1.0.0\n", stderr: "" }),
    execCheck: async () => true,
    resolvePath: async () => "/opt/invoke-exact-636",
  });

  const impl = await invoke("invoke-exact-636", tmpRoot, "p", {
    stream: false,
    role: "implementer",
    model: "m-impl",
    reasoningEffort: "xhigh",
    sandbox: true,
    sandboxMode: "managed",
    preflightDeps: baseDeps,
  });
  const rev = await invoke("invoke-exact-636", tmpRoot, "p", {
    stream: false,
    role: "reviewer",
    model: "m-rev",
    reasoningEffort: "minimal",
    sandbox: false,
    sandboxMode: "external-bypass",
    preflightDeps: baseDeps,
  });

  assert.equal(impl.preflight_failed, true);
  assert.equal(rev.preflight_failed, true);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], {
    model: "m-impl",
    effort: "xhigh",
    sandbox: true,
    sandboxMode: "managed",
  });
  assert.deepEqual(seen[1], {
    model: "m-rev",
    effort: "minimal",
    sandbox: false,
    sandboxMode: "external-bypass",
  });
  // No spawn: failure is typed preflight, not spawn_error (auth class).
  assert.equal(impl.spawn_error ?? false, false);
  assert.equal(impl.preflight_class, "unauthenticated");
  assert.equal(impl.preflight_intervention_kind, "auth-tooling-preflight-failure");
  assert.equal(impl.preflight_reason_code, "environment-auth");
  void roleSeen;
  void calls;
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
});

// ---------------------------------------------------------------------------
// Capability refusal matrix
// ---------------------------------------------------------------------------

test("production preflight: unsupported model/effort/sandbox, oversize prompt, missing executable — each distinct", async () => {
  _clearCliVersionProbeCacheForTests();

  // Unsupported effort via closed-enum adapter
  const effortAdapter = makeRecordingAdapter({
    name: "refuse-effort",
    preflight: async (_d, req) => {
      if (req.effort === "ludicrous") {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: 'refuse-effort does not support effort "ludicrous"',
        };
      }
      return { ok: true };
    },
  }).adapter;

  const deps = defaultProductionPreflightDeps({
    exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
    execCheck: async () => true,
    resolvePath: async () => "/bin/refuse",
  });

  const effortFail = await runProductionPreflight(
    effortAdapter,
    { prompt: "p", effort: "ludicrous", model: "m" },
    deps,
  );
  assert.equal(effortFail.ok, false);
  if (!effortFail.ok) {
    assert.equal(effortFail.remediation.failure, "unsupported-setting");
    assert.equal(effortFail.remediation.reasonCode, "capability-refusal");
    assert.match(effortFail.remediation.message, /ludicrous/);
  }

  // Unsupported model
  const modelAdapter = makeRecordingAdapter({
    name: "refuse-model",
    preflight: async (_d, req) => {
      if (req.model === "nope-model") {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: 'refuse-model does not support model "nope-model"',
        };
      }
      return { ok: true };
    },
  }).adapter;
  const modelFail = await runProductionPreflight(
    modelAdapter,
    { prompt: "p", model: "nope-model" },
    deps,
  );
  assert.equal(modelFail.ok, false);
  if (!modelFail.ok) {
    assert.equal(modelFail.remediation.failure, "unsupported-setting");
    assert.match(modelFail.remediation.message, /nope-model/);
  }

  // Unsupported sandbox boolean
  const sandboxAdapter = makeRecordingAdapter({
    name: "refuse-sandbox",
    sandboxSupported: false,
    preflight: async (_d, req) => {
      if (req.sandbox) {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: "refuse-sandbox does not support sandbox",
        };
      }
      return { ok: true };
    },
  }).adapter;
  const sandboxFail = await runProductionPreflight(
    sandboxAdapter,
    { prompt: "p", sandbox: true },
    deps,
  );
  assert.equal(sandboxFail.ok, false);
  if (!sandboxFail.ok) {
    assert.equal(sandboxFail.remediation.failure, "unsupported-setting");
    assert.match(sandboxFail.remediation.message, /sandbox/);
  }

  // Unsupported sandboxMode (distinct tool/permission policy value)
  const sandboxModeAdapter = makeRecordingAdapter({
    name: "refuse-sandbox-mode",
    preflight: async (_d, req) => {
      if (req.sandboxMode === "external-bypass") {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: 'refuse-sandbox-mode does not support sandboxMode "external-bypass"',
        };
      }
      return { ok: true };
    },
  }).adapter;
  const sandboxModeFail = await runProductionPreflight(
    sandboxModeAdapter,
    { prompt: "p", sandboxMode: "external-bypass" },
    deps,
  );
  assert.equal(sandboxModeFail.ok, false);
  if (!sandboxModeFail.ok) {
    assert.equal(sandboxModeFail.remediation.failure, "unsupported-setting");
    assert.match(sandboxModeFail.remediation.message, /external-bypass/);
  }

  // Oversize prompt (#779)
  const small = makeRecordingAdapter({
    name: "refuse-prompt",
    maxPromptBytes: 8,
  }).adapter;
  // Override delivery to argv finite for coherence — capabilities already finite.
  const oversize = await runProductionPreflight(
    {
      ...small,
      declaration: {
        ...small.declaration,
        prompt: { delivery: "argv", sizeLimit: "max-arg-strlen" },
      },
      buildInvocation(ctx) {
        return {
          cmd: "refuse-prompt",
          args: [ctx.prompt],
          cwd: ctx.worktreeDir,
          promptDelivery: "argv",
        };
      },
    },
    { prompt: "123456789" }, // 9 bytes > 8
    deps,
  );
  assert.equal(oversize.ok, false);
  if (!oversize.ok) {
    assert.equal(oversize.remediation.failure, "prompt-limit");
    assert.equal(oversize.remediation.reasonCode, "capability-refusal");
  }

  // Missing executable
  const missing = makeRecordingAdapter({
    name: "refuse-missing",
    preflight: async () => ({
      ok: false,
      failure: "missing-cli",
      message: "refuse-missing CLI not found on PATH",
    }),
  }).adapter;
  const missingFail = await runProductionPreflight(
    missing,
    { prompt: "p" },
    defaultProductionPreflightDeps({
      exec: async () => ({ ok: false, stdout: "", stderr: "not found" }),
      execCheck: async () => false,
      resolvePath: async () => null,
    }),
  );
  assert.equal(missingFail.ok, false);
  if (!missingFail.ok) {
    assert.ok(
      missingFail.remediation.failure === "missing-cli" ||
        missingFail.remediation.failure === "missing-executable",
    );
    assert.equal(missingFail.remediation.reasonCode, "environment-auth");
    assert.equal(missingFail.remediation.interventionKind, "auth-tooling-preflight-failure");
  }

  _clearCliVersionProbeCacheForTests();
});

test("production preflight: missing-cli vs unauthenticated vs headless remain distinguishable", async () => {
  const deps = defaultProductionPreflightDeps({
    exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
    execCheck: async () => true,
    resolvePath: async () => "/bin/x",
  });

  for (const failure of ["missing-cli", "unauthenticated", "headless-unavailable"] as const) {
    const adapter = makeRecordingAdapter({
      name: `class-${failure}`,
      preflight: async () => ({
        ok: false,
        failure,
        message: `class-${failure}: ${failure}`,
      }),
    }).adapter;
    const result = await runProductionPreflight(adapter, { prompt: "p" }, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      // missing-cli may be remapped to missing-executable when path unresolved;
      // for this case resolvePath returns /bin/x so keep missing-cli.
      if (failure === "missing-cli") {
        assert.ok(
          result.remediation.failure === "missing-cli" ||
            result.remediation.failure === "missing-executable",
        );
      } else {
        assert.equal(result.remediation.failure, failure);
      }
    }
  }
});

test("projectPreflightRemediation: #760 typed reason + intervention, no secrets", () => {
  const r = projectPreflightRemediation(
    "codex",
    "unauthenticated",
    "codex CLI is installed but not authenticated — run `codex login`",
  );
  assert.equal(r.reasonCode, "environment-auth");
  assert.equal(r.interventionKind, "auth-tooling-preflight-failure");
  assert.doesNotMatch(r.message, /sk-|api[_-]?key|Bearer\s/i);
  assert.match(r.message, /codex/);

  const cap = projectPreflightRemediation("pi", "unsupported-setting", 'effort "ludicrous" unsupported', {
    setting: "effort",
    value: "ludicrous",
  });
  assert.equal(cap.reasonCode, "capability-refusal");
});

// ---------------------------------------------------------------------------
// Registered / compatibility adapter diagnostic parity
// ---------------------------------------------------------------------------

test("invoke(): synthetic registered adapter preflight failure is classifiable (bounded, no secrets)", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
  registerAdapter(
    makeRecordingAdapter({
      name: "ext-diag-636",
      preflight: async () => ({
        ok: false,
        failure: "unsupported-setting",
        message: 'ext-diag-636 refuses effort "max" — choose high|low',
      }),
    }).adapter,
  );

  const result = await invoke("ext-diag-636", tmpRoot, "prompt", {
    stream: false,
    reasoningEffort: "max",
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => "/opt/ext-diag-636",
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.preflight_failed, true);
  assert.equal(result.preflight_class, "unsupported-setting");
  assert.equal(result.preflight_intervention_kind, "auth-tooling-preflight-failure");
  assert.match(result.stderr, /ext-diag-636/);
  assert.match(result.stderr, /effort|max|high\|low/i);
  // Bounded diagnostic: structured class + remediation, not an empty throw.
  assert.ok((result.stderr?.length ?? 0) > 20);
  assert.doesNotMatch(result.stderr, /sk-[a-zA-Z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]+/);
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
});

test("compatibility adapter missing CLI: same bounded diagnostic quality class as registered path", async () => {
  _clearCliVersionProbeCacheForTests();
  const missing = `compat-missing-636-${path.basename(tmpRoot)}`;
  const result = await invoke(missing, tmpRoot, "prompt", {
    stream: false,
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: false, stdout: "", stderr: "" }),
      execCheck: async () => false,
      resolvePath: async () => null,
      fsExecutable: async () => false,
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.preflight_failed, true);
  assert.ok(
    result.preflight_class === "missing-cli" || result.preflight_class === "missing-executable",
  );
  assert.equal(result.spawn_error, true, "#39 fallback still applies via spawn_error");
  assert.match(result.stderr, /not found|not executable/i);
  assert.doesNotMatch(result.stderr, /Unknown harness/);
  _clearCliVersionProbeCacheForTests();
});

// ---------------------------------------------------------------------------
// Absolute executable + version probe cache reuse
// ---------------------------------------------------------------------------

test("resolveAbsoluteExecutable: success and failure via injectable deps", async () => {
  const abs = await resolveAbsoluteExecutable("claude", "path", {
    resolvePath: async () => "/home/x/.local/bin/claude",
  });
  assert.equal(abs, "/home/x/.local/bin/claude");

  const miss = await resolveAbsoluteExecutable("nope", "path", {
    resolvePath: async () => null,
  });
  assert.equal(miss, null);

  const already = await resolveAbsoluteExecutable("/usr/bin/codex", "absolute", {});
  assert.equal(already, "/usr/bin/codex");

  // Relative paths are never treated as resolved absolute executables.
  const relative = await resolveAbsoluteExecutable("./local/bin/claude", "path", {
    resolvePath: async () => "./local/bin/claude",
  });
  assert.equal(relative, null);

  const relativeAbsMode = await resolveAbsoluteExecutable("relative-cmd", "absolute", {});
  assert.equal(relativeAbsMode, null);

  const nonAbsResolved = await resolveAbsoluteExecutable("claude", "path", {
    resolvePath: async () => "not/an/absolute/path",
  });
  assert.equal(nonAbsResolved, null);
});

test("production preflight: unresolved PATH executable fails closed before adapter.preflight", async () => {
  let adapterPreflightCalls = 0;
  const adapter = makeRecordingAdapter({
    name: "path-unresolved-636",
    preflight: async () => {
      adapterPreflightCalls++;
      // Would succeed if consulted — production must not rely on this alone.
      return { ok: true, authState: "unknown" };
    },
  }).adapter;

  const result = await runProductionPreflight(
    adapter,
    { prompt: "p", model: "m" },
    defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => null,
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.remediation.failure, "missing-executable");
    assert.equal(result.remediation.reasonCode, "environment-auth");
    assert.match(result.remediation.message, /path-unresolved-636|absolute executable/i);
  }
  assert.equal(adapterPreflightCalls, 0, "adapter.preflight must not run when executable unresolved");
});

test("production preflight: non-executable absolute path fails closed via fsExecutable", async () => {
  let adapterPreflightCalls = 0;
  const adapter = makeRecordingAdapter({
    name: "not-exec-636",
    preflight: async () => {
      adapterPreflightCalls++;
      return { ok: true };
    },
  }).adapter;
  // Force absolute resolution with a declared absolute command.
  const absAdapter: typeof adapter = {
    ...adapter,
    declaration: {
      ...adapter.declaration,
      executable: { command: "/opt/not-exec-636", resolution: "absolute" },
    },
  };

  const result = await runProductionPreflight(
    absAdapter,
    { prompt: "p" },
    defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
      execCheck: async () => true,
      fsExecutable: async () => false,
      resolvePath: async () => "/opt/not-exec-636",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.remediation.failure, "missing-executable");
    assert.match(result.remediation.message, /not executable|missing/i);
  }
  assert.equal(adapterPreflightCalls, 0);
});

test("invoke(): registered adapter diagnostics redact credentials and stay bounded", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
  const secretToken = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const bearer = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
  registerAdapter(
    makeRecordingAdapter({
      name: "ext-secret-diag-636",
      preflight: async () => ({
        ok: false,
        failure: "unauthenticated",
        message:
          `auth failed for ext-secret-diag-636: ${bearer} api_key=${secretToken} ` +
          `https://api.example.com/login?token=super-secret-token-value status=401`,
      }),
    }).adapter,
  );

  const result = await invoke("ext-secret-diag-636", tmpRoot, "prompt", {
    stream: false,
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => "/opt/ext-secret-diag-636",
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.preflight_failed, true);
  assert.equal(result.preflight_class, "unauthenticated");
  assert.match(result.stderr, /ext-secret-diag-636/);
  assert.doesNotMatch(result.stderr, new RegExp(secretToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.stderr, /Bearer\s+eyJ/);
  assert.doesNotMatch(result.stderr, /super-secret-token-value/);
  assert.match(result.stderr, /REDACTED/i);

  // Thrown path also redacts.
  registerAdapter(
    makeRecordingAdapter({
      name: "ext-throw-secret-636",
      preflight: async () => {
        throw new Error(`probe stderr: Authorization: ${bearer} key=${secretToken}`);
      },
    }).adapter,
  );
  const thrown = await invoke("ext-throw-secret-636", tmpRoot, "prompt", {
    stream: false,
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "1.0\n", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => "/opt/ext-throw-secret-636",
    }),
  });
  assert.equal(thrown.preflight_failed, true);
  assert.doesNotMatch(thrown.stderr, new RegExp(secretToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(thrown.stderr, /Bearer\s+eyJ/);
  assert.match(thrown.stderr, /REDACTED|threw/i);

  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
});

test("production preflight + fingerprint: shared version probe cache is warm (no second exec)", async () => {
  _clearCliVersionProbeCacheForTests();
  let versionExecs = 0;
  const deps = defaultProductionPreflightDeps({
    exec: async (file, args) => {
      if (args[0] === "--version" || args[0] === "version") {
        versionExecs++;
        return { ok: true, stdout: "shared-cli 9.9.9\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    execCheck: async () => true,
    resolvePath: async () => "/opt/shared-cli",
  });

  const { adapter } = makeRecordingAdapter({ name: "shared-cli" });
  const pre = await runProductionPreflight(adapter, { prompt: "p", model: "m" }, deps);
  assert.equal(pre.ok, true);
  assert.ok(versionExecs >= 1);
  const afterPreflight = versionExecs;

  // Fingerprint / accounting path reuses the cache via probeCliVersionOnce.
  const cached = await probeCliVersionOnce("/opt/shared-cli", {
    exec: async () => {
      versionExecs++;
      return { ok: true, stdout: "should-not-run\n", stderr: "" };
    },
  });
  assert.equal(cached.cliVersion, "9.9.9");
  assert.equal(versionExecs, afterPreflight, "warm cache must not re-exec --version");
  assert.ok(_peekCliVersionProbeForTests("/opt/shared-cli"));
  _clearCliVersionProbeCacheForTests();
});

test("invoke(): fingerprint consumes preflight absolute path; version drift remains fail-soft", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();

  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const cliPath = path.join(dir, "claude");
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "claude 0.0.1-drift"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi
printf 'ok\\n'
`,
  );
  fs.chmodSync(cliPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  const writes: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    writes.push(String(chunk));
    return origWrite(chunk as never, ...(rest as never[]));
  };

  try {
    const result = await invoke("claude", tmpRoot, "prompt", {
      stream: false,
      accounting: { runDir, issue: 636, stage: "implementing", role: "implementer" },
      versionProbeDeps: {
        exec: async () => ({ ok: true, stdout: "claude 0.0.1-drift\n", stderr: "" }),
      },
      preflightDeps: defaultProductionPreflightDeps({
        exec: async (file, args) => {
          if (args[0] === "auth" || (args[0] === "auth" && args[1] === "status")) {
            return { ok: true, stdout: '{"loggedIn":true}\n', stderr: "" };
          }
          if (args.includes("--version") || args[0] === "--version") {
            return { ok: true, stdout: "claude 0.0.1-drift\n", stderr: "" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        execCheck: async () => true,
        resolvePath: async () => cliPath,
      }),
    });
    assert.equal(result.success, true, "version drift must not block");
    const event = JSON.parse(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim());
    assert.equal(event.treatment_fingerprint?.cliPath, cliPath);
    assert.equal(event.treatment_fingerprint?.cliVersion, "0.0.1-drift");
    // Drift is fail-soft: success remains true (missing CLI would have blocked).
    assert.equal(result.preflight_failed ?? false, false);
    void writes;
  } finally {
    process.stderr.write = origWrite;
    process.env.PATH = oldPath;
    _clearCliVersionProbeCacheForTests();
    _resetRegistryForTests({ reseedBuiltins: true });
  }
});

// ---------------------------------------------------------------------------
// Detached PATH parity
// ---------------------------------------------------------------------------

test("packDetachHarnessEnv: preserves PATH and packs absolute CLI paths", () => {
  const packed = packDetachHarnessEnv(
    { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/op", OTHER: "x" },
    { absoluteCliPaths: { claude: "/usr/local/bin/claude", codex: "/opt/codex" } },
  );
  assert.equal(packed.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(packed.HOME, "/home/op");
  assert.equal(
    packed[PIPELINE_HARNESS_CLI_PATHS_ENV],
    JSON.stringify({ claude: "/usr/local/bin/claude", codex: "/opt/codex" }),
  );
});

test("assertHarnessDiscoveryParity: stripped detach PATH fails unless absolute packed", () => {
  const pathMap: Record<string, string> = {
    "/usr/local/bin:/bin": "/usr/local/bin/claude",
  };
  const resolve = (cmd: string, pathEnv: string | undefined) => {
    if (cmd !== "claude") return null;
    if (!pathEnv) return null;
    return pathMap[pathEnv] ?? null;
  };

  const stripped = assertHarnessDiscoveryParity({
    command: "claude",
    foregroundPath: "/usr/local/bin:/bin",
    detachPath: "/usr/bin", // stripped — cannot resolve
    resolve,
  });
  assert.equal(stripped.ok, false);
  if (!stripped.ok) assert.match(stripped.message, /PATH parity/);

  const withAbs = assertHarnessDiscoveryParity({
    command: "claude",
    foregroundPath: "/usr/local/bin:/bin",
    detachPath: "/usr/bin",
    resolve,
    absolutePacked: "/usr/local/bin/claude",
  });
  assert.equal(withAbs.ok, true);

  const preserved = assertHarnessDiscoveryParity({
    command: "claude",
    foregroundPath: "/usr/local/bin:/bin",
    detachPath: "/usr/local/bin:/bin",
    resolve,
  });
  assert.equal(preserved.ok, true);
});

test("spawnDetached: packs env with preserved PATH (injected spawn)", async () => {
  const homeDir = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  const calls: { opts: Record<string, unknown> }[] = [];
  const deps: SpawnDetachedDeps & { calls: typeof calls } = {
    homedir: () => homeDir,
    now: () => 1_700_000_000_000,
    pid: () => 42,
    spawn(cmd, args, opts) {
      calls.push({ opts: opts as Record<string, unknown> });
      const ev = new EventEmitter();
      return Object.assign(ev, { pid: 9999, unref() {} }) as unknown as ReturnType<
        SpawnDetachedDeps["spawn"]
      >;
    },
    awaitLockHandshake: async () => ({ acquired: true }),
    calls,
  };

  const oldPath = process.env.PATH;
  process.env.PATH = "/custom/bin:/usr/bin";
  try {
    await spawnDetached(
      636,
      [],
      {
        domain: "agent-pipeline",
        absoluteCliPaths: { claude: "/custom/bin/claude" },
      },
      deps,
    );
    assert.equal(calls.length, 1);
    const env = calls[0]!.opts.env as NodeJS.ProcessEnv;
    assert.equal(env.PATH, "/custom/bin:/usr/bin");
    assert.equal(
      env[PIPELINE_HARNESS_CLI_PATHS_ENV],
      JSON.stringify({ claude: "/custom/bin/claude" }),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// No ambient fallback
// ---------------------------------------------------------------------------

test("invoke(): preflight failure does not substitute another adapter or ambient model", async () => {
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
  registerAdapter(
    makeRecordingAdapter({
      name: "no-fallback-636",
      preflight: async () => ({
        ok: false,
        failure: "unsupported-setting",
        message: "no-fallback-636 refuses model ambient-default",
      }),
    }).adapter,
  );
  const result = await invoke("no-fallback-636", tmpRoot, "prompt", {
    stream: false,
    model: "ambient-default",
    preflightDeps: defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "1\n", stderr: "" }),
      execCheck: async () => true,
      resolvePath: async () => "/opt/no-fallback-636",
    }),
  });
  assert.equal(result.success, false);
  assert.equal(result.preflight_failed, true);
  assert.match(result.stderr, /no-fallback-636/);
  assert.doesNotMatch(result.stderr, /falling back|using default harness|substituted/i);
  // claude must still be registered — we did not reassign.
  assert.ok(resolveAdapter("claude"));
  _resetRegistryForTests({ reseedBuiltins: true });
  _clearCliVersionProbeCacheForTests();
});

test("compatibility materialize + production preflight share the same gate path", async () => {
  const compat = materializeCompatibilityAdapter("/opt/custom-reviewer-636", {
    promptDelivery: "argv",
  });
  const result = await runProductionPreflight(
    compat,
    { prompt: "p", role: "reviewer", model: "any", effort: "high" },
    defaultProductionPreflightDeps({
      exec: async () => ({ ok: true, stdout: "", stderr: "" }),
      execCheck: async () => true,
      fsExecutable: async () => true,
      resolvePath: async () => "/opt/custom-reviewer-636",
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.adapterRequest, { model: "any", effort: "high" });
    assert.equal(result.role, "reviewer");
  }
});
