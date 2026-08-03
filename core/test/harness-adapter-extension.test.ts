// #783 — adapter extension registry, compatibility path, conformance kit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ADAPTER_NAMES,
  allAdapters,
  assertAdapterConformance,
  checkStructure,
  loadAdapterExtensions,
  materializeCompatibilityAdapter,
  registerAdapter,
  registeredAdapterNames,
  resolveAdapter,
  resolveAdapterForRole,
  runConformanceKit,
  _resetRegistryForTests,
} from "../scripts/harness-adapters/index.ts";
import type {
  AdapterPreflightDeps,
  HarnessAdapter,
} from "../scripts/harness-adapters/types.ts";
import { buildAdapterDeclaration } from "../scripts/harness-adapters/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures", "adapter-extension");

function fakeDeps(present = true, pathExists = present, pathExecutable = pathExists): AdapterPreflightDeps {
  return {
    exec: async () => ({ ok: present, stdout: present ? "ok" : "", stderr: "" }),
    execCheck: async () => present,
    fsExists: async () => pathExists,
    fsExecutable: async () => pathExecutable,
  };
}

test("builtins register through public API and appear in runtime registry", () => {
  _resetRegistryForTests();
  for (const name of BUILTIN_ADAPTER_NAMES) {
    const adapter = resolveAdapter(name);
    assert.ok(adapter, `builtin ${name} must resolve`);
    assert.equal(adapter.declaration.origin, "builtin");
    assert.ok(adapter.declaration.roles.includes("implementer"));
    assert.ok(adapter.declaration.roles.includes("reviewer"));
    assert.equal(typeof adapter.runtimeSmoke, "function");
  }
  assert.equal(registeredAdapterNames().length, allAdapters().length);
  // Registry-driven enumeration — not a hardcoded completeness criterion for "all adapters"
  assert.ok(registeredAdapterNames().length >= BUILTIN_ADAPTER_NAMES.length);
});

test("registerAdapter: same-identity re-register is idempotent", () => {
  _resetRegistryForTests();
  const adapter = resolveAdapter("claude")!;
  assert.doesNotThrow(() => registerAdapter(adapter));
  assert.equal(resolveAdapter("claude"), adapter);
});

test("registerAdapter: distinct implementation under same ID fails closed", () => {
  _resetRegistryForTests();
  const clone: HarnessAdapter = {
    ...resolveAdapter("claude")!,
    name: "claude",
    // new object identity
    buildInvocation: resolveAdapter("claude")!.buildInvocation.bind(resolveAdapter("claude")!),
  };
  // Spread still shares functions but is a different object.
  assert.notEqual(clone, resolveAdapter("claude"));
  assert.throws(
    () => registerAdapter(clone),
    /Adapter ID collision.*"claude"/,
  );
  // Original retained
  assert.equal(resolveAdapter("claude")!.declaration.origin, "builtin");
});

test("registerAdapter: extension surfaces in registeredAdapterNames without core name-list edit", () => {
  _resetRegistryForTests();
  const ext = makeMinimalExtension("synth-reg");
  registerAdapter(ext);
  assert.ok(registeredAdapterNames().includes("synth-reg"));
  assert.equal(resolveAdapter("synth-reg"), ext);
});

test("loadAdapterExtensions: loads synthetic fixture and registers both roles", () => {
  _resetRegistryForTests();
  const entry = path.join(fixtureDir, "ext-demo.cjs");
  const result = loadAdapterExtensions({
    repoDir: fixtureDir,
    entryPoints: [entry],
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.registeredIds.includes("ext-demo"));
  const adapter = resolveAdapter("ext-demo");
  assert.ok(adapter);
  assert.equal(adapter.declaration.origin, "extension");
  assert.ok(adapter.declaration.roles.includes("implementer"));
  assert.ok(adapter.declaration.roles.includes("reviewer"));
  // Role resolution succeeds for both
  assert.equal(resolveAdapterForRole("ext-demo", "implementer").name, "ext-demo");
  assert.equal(resolveAdapterForRole("ext-demo", "reviewer").name, "ext-demo");
});

test("loadAdapterExtensions: unconfigured packages are not loaded", () => {
  _resetRegistryForTests();
  // Empty list → no load
  const result = loadAdapterExtensions({
    repoDir: fixtureDir,
    entryPoints: [],
  });
  assert.deepEqual(result.loaded, []);
  assert.equal(resolveAdapter("ext-demo"), null);
});

test("role resolution: missing role capability is rejected with adapter and role names", () => {
  _resetRegistryForTests();
  const reviewerOnly = makeMinimalExtension("rev-only", ["reviewer"]);
  registerAdapter(reviewerOnly);
  assert.throws(
    () => resolveAdapterForRole("rev-only", "implementer"),
    /rev-only.*implementer/,
  );
});

test("role eligibility is not inferred from adapter marketing name", () => {
  _resetRegistryForTests();
  // Name looks like a built-in marketing string but roles are declaration-only.
  const odd = makeMinimalExtension("claude-but-not", ["reviewer"]);
  registerAdapter(odd);
  assert.throws(() => resolveAdapterForRole("claude-but-not", "implementer"), /implementer/);
  assert.equal(resolveAdapterForRole("claude-but-not", "reviewer").name, "claude-but-not");
});

test("compatibility adapter: unregistered reviewer materializes on public contract", () => {
  _resetRegistryForTests();
  assert.equal(resolveAdapter("my-reviewer"), null);
  const compat = materializeCompatibilityAdapter("my-reviewer", { promptDelivery: "argv" });
  assert.equal(compat.declaration.origin, "compatibility");
  assert.deepEqual([...compat.declaration.roles], ["reviewer"]);
  const inv = compat.buildInvocation({
    prompt: "PROMPT",
    worktreeDir: "/tmp/wt",
  });
  assert.equal(inv.cmd, "my-reviewer");
  assert.deepEqual(inv.args, ["PROMPT"]);
  assert.equal(inv.promptDelivery, "argv");
});

test("compatibility adapter: stdin prompt delivery preserved", () => {
  const compat = materializeCompatibilityAdapter("my-reviewer", { promptDelivery: "stdin" });
  const inv = compat.buildInvocation({ prompt: "P", worktreeDir: "/tmp/wt" });
  assert.equal(inv.promptDelivery, "stdin");
  assert.deepEqual(inv.args, []);
  assert.equal(inv.stdinPayload, "P");
});

test("full package registration wins over compatibility for the same ID", () => {
  _resetRegistryForTests();
  const full = makeMinimalExtension("my-reviewer", ["reviewer", "implementer"]);
  registerAdapter(full);
  // resolveAdapter finds the package; compatibility is never consulted.
  assert.equal(resolveAdapter("my-reviewer"), full);
  assert.equal(resolveAdapterForRole("my-reviewer", "reviewer"), full);
  assert.equal(full.declaration.origin, "extension");
});

test("compatibility adapter: missing CLI fails with public vocabulary", async () => {
  const compat = materializeCompatibilityAdapter("definitely-missing-cli-xyz");
  const res = await compat.runtimeSmoke(fakeDeps(false));
  assert.equal(res.ok, false);
  assert.equal(res.failure, "missing-cli");
  assert.match(res.message ?? "", /definitely-missing-cli-xyz/);
});

test("compatibility adapter: object-form model and effort are accepted, not refused", async () => {
  const compat = materializeCompatibilityAdapter("my-reviewer", { promptDelivery: "stdin" });
  assert.equal(compat.capabilities.model, true);
  assert.equal(compat.capabilities.effort, true);
  assert.equal(compat.declaration.model.supported, true);
  assert.equal(compat.declaration.effort.supported, true);
  assert.equal(compat.declaration.model.validation, "open");
  assert.equal(compat.declaration.effort.validation, "open");

  const pre = await compat.preflight(fakeDeps(true), {
    model: "auto",
    effort: "high",
  });
  assert.equal(pre.ok, true, `expected accept model/effort, got ${JSON.stringify(pre)}`);

  const inv = compat.buildInvocation({
    prompt: "PROMPT",
    worktreeDir: "/tmp/wt",
    model: "auto",
    effort: "high",
  });
  // Legacy unconstrained spawn: no invented --model/--effort flags.
  assert.equal(inv.promptDelivery, "stdin");
  assert.deepEqual(inv.args, []);
  assert.equal(inv.stdinPayload, "PROMPT");

  const treatment = compat.describeTreatment(
    { model: "auto", effort: "high" },
    inv,
    { cliVersion: null, providerAuthClass: "unknown", resolvedModel: null },
  );
  assert.equal(treatment.requestedModel, "auto");
  assert.equal(treatment.requestedEffort, "high");
  assert.equal(treatment.resolvedModel, null);
  assert.deepEqual(treatment.nativeFlags, []);
});

test("compatibility adapter: sandbox remains unsupported", async () => {
  const compat = materializeCompatibilityAdapter("my-reviewer");
  const pre = await compat.preflight(fakeDeps(true), { sandbox: true });
  assert.equal(pre.ok, false);
  assert.equal(pre.failure, "unsupported-setting");
});

test("compatibility adapter: missing path-like CLI fails closed (not ready)", async () => {
  const pathCmd = "/nonexistent/path/to/custom-reviewer";
  const compat = materializeCompatibilityAdapter(pathCmd);
  const absent: AdapterPreflightDeps = {
    exec: async () => ({ ok: false, stdout: "", stderr: "not found" }),
    execCheck: async () => false,
    fsExists: async () => false,
    fsExecutable: async () => false,
  };
  const pre = await compat.preflight(absent, {});
  assert.equal(pre.ok, false, "path-like missing CLI must not report ready");
  assert.equal(pre.failure, "missing-cli");
  assert.match(pre.message ?? "", /custom-reviewer|not found|path/i);

  const smoke = await compat.runtimeSmoke(absent);
  assert.equal(smoke.ok, false);
  assert.equal(smoke.failure, "missing-cli");
});

test("compatibility adapter: path-like CLI ready when fsExecutable reports executable file", async () => {
  const pathCmd = "/opt/tools/my-reviewer";
  const compat = materializeCompatibilityAdapter(pathCmd);
  const present: AdapterPreflightDeps = {
    exec: async () => ({ ok: false, stdout: "", stderr: "" }),
    execCheck: async () => false, // which and --help/--version all fail
    fsExists: async (p) => p === pathCmd,
    fsExecutable: async (p) => p === pathCmd,
  };
  const pre = await compat.preflight(present, { model: "auto", effort: "high" });
  assert.equal(pre.ok, true, JSON.stringify(pre));
  const smoke = await compat.runtimeSmoke(present);
  assert.equal(smoke.ok, true);
});

test("compatibility adapter: existing non-executable path fails as missing-cli", async () => {
  const pathCmd = "/opt/tools/not-executable-reviewer";
  const compat = materializeCompatibilityAdapter(pathCmd);
  // Path exists but is not executable (e.g. mode 0644 or a directory).
  const nonExec: AdapterPreflightDeps = {
    exec: async () => ({ ok: false, stdout: "", stderr: "permission denied" }),
    execCheck: async () => false,
    fsExists: async (p) => p === pathCmd,
    fsExecutable: async () => false,
  };
  const pre = await compat.preflight(nonExec, {});
  assert.equal(pre.ok, false, "existence without executability must not report ready");
  assert.equal(pre.failure, "missing-cli");
  assert.match(pre.message ?? "", /not found|not executable|path/i);

  const smoke = await compat.runtimeSmoke(nonExec);
  assert.equal(smoke.ok, false);
  assert.equal(smoke.failure, "missing-cli");

  // Existence-only seam without fsExecutable must also fail closed.
  const existsOnly: AdapterPreflightDeps = {
    exec: async () => ({ ok: false, stdout: "", stderr: "" }),
    execCheck: async () => false,
    fsExists: async (p) => p === pathCmd,
  };
  const preExistsOnly = await compat.preflight(existsOnly, {});
  assert.equal(preExistsOnly.ok, false, "fsExists alone must not report ready");
  assert.equal(preExistsOnly.failure, "missing-cli");
});

test("conformance kit: covers supported settings, envelope normalize, failure classes", async () => {
  _resetRegistryForTests();
  for (const adapter of allAdapters()) {
    if (adapter.declaration.origin !== "builtin") continue;
    const report = await runConformanceKit(adapter, fakeDeps(true));
    assert.equal(
      report.ok,
      true,
      `${adapter.name} expanded kit failures: ${JSON.stringify(report.failures, null, 2)}`,
    );
    // Kit must exercise failure-classification and output-normalization checks
    // (report.ok alone is insufficient if those checks were never added).
    assert.ok(
      report.failures.length === 0,
    );
  }
  // Compatibility adapter also passes the public kit.
  const compat = materializeCompatibilityAdapter("kit-custom-reviewer");
  const compatReport = await runConformanceKit(compat, fakeDeps(true));
  assert.equal(
    compatReport.ok,
    true,
    `compatibility kit failures: ${JSON.stringify(compatReport.failures, null, 2)}`,
  );
});

test("identity: extension treatment does not invent provider or resolved model", () => {
  _resetRegistryForTests();
  const entry = path.join(fixtureDir, "ext-demo.cjs");
  loadAdapterExtensions({ repoDir: fixtureDir, entryPoints: [entry] });
  const adapter = resolveAdapter("ext-demo")!;
  const inv = adapter.buildInvocation({
    prompt: "p",
    worktreeDir: "/tmp/wt",
    model: "some-alias",
  });
  const treatment = adapter.describeTreatment(
    { model: "some-alias" },
    inv,
    { cliVersion: null, providerAuthClass: "unknown", resolvedModel: null },
  );
  assert.equal(treatment.adapter, "ext-demo");
  assert.equal(treatment.resolvedModel, null);
  assert.equal(treatment.providerAuthClass, "unknown");
  assert.equal(treatment.origin, "extension");
  // Outer host is not a field on treatment — adapter stays independent.
  assert.notEqual(treatment.adapter, "claude");
});

test("conformance kit: every builtin passes structure checks", () => {
  _resetRegistryForTests();
  for (const adapter of allAdapters()) {
    if (adapter.declaration.origin !== "builtin") continue;
    const report = checkStructure(adapter);
    assert.equal(report.ok, true, `${adapter.name}: ${JSON.stringify(report.failures)}`);
  }
});

test("conformance kit: every builtin passes full kit with injectable deps", async () => {
  _resetRegistryForTests();
  for (const adapter of allAdapters()) {
    if (adapter.declaration.origin !== "builtin") continue;
    const report = await runConformanceKit(adapter, fakeDeps(true));
    assert.equal(
      report.ok,
      true,
      `${adapter.name} conformance failures: ${JSON.stringify(report.failures, null, 2)}`,
    );
  }
});

test("conformance kit: synthetic extension fixture passes", async () => {
  _resetRegistryForTests();
  const entry = path.join(fixtureDir, "ext-demo.cjs");
  loadAdapterExtensions({ repoDir: fixtureDir, entryPoints: [entry] });
  const adapter = resolveAdapter("ext-demo")!;
  const report = await runConformanceKit(adapter, fakeDeps(true));
  assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
});

test("conformance kit: incomplete fixture fails and names missing member", () => {
  // Load incomplete shape without going through registerAdapter (which also
  // requires declaration) — exercise checkStructure / assertAdapterConformance.
  const req = createRequire(import.meta.url);
  const mod = req(path.join(fixtureDir, "incomplete.cjs")) as {
    adapters: HarnessAdapter[];
  };
  const incomplete = mod.adapters[0];
  const report = checkStructure(incomplete);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (f) =>
        f.message.includes("declaration") ||
        f.message.includes("runtimeSmoke") ||
        f.check === "required-member" ||
        f.check === "declaration",
    ),
    JSON.stringify(report.failures),
  );
  assert.throws(() => assertAdapterConformance(incomplete), /incomplete-ext|declaration|runtimeSmoke/);
});

test("registerAdapter rejects incomplete adapter missing declaration", () => {
  _resetRegistryForTests();
  assert.throws(
    () =>
      registerAdapter({
        name: "no-decl",
        capabilities: {
          model: false,
          effort: false,
          sandbox: false,
          workingDir: "cwd",
          telemetry: "none",
        },
      } as HarnessAdapter),
    /declaration/,
  );
});

function makeMinimalExtension(
  name: string,
  roles: Array<"implementer" | "reviewer"> = ["implementer", "reviewer"],
): HarnessAdapter {
  const capabilities = {
    model: false,
    effort: false,
    sandbox: false,
    workingDir: "cwd" as const,
    telemetry: "none" as const,
  };
  return {
    name,
    capabilities,
    declaration: buildAdapterDeclaration({
      roles,
      command: name,
      capabilities,
      promptDelivery: "argv",
      origin: "extension",
      authProbe: "none",
      versionProbe: "none",
    }),
    buildInvocation(ctx) {
      return {
        cmd: name,
        args: [ctx.prompt],
        cwd: ctx.worktreeDir,
        promptDelivery: "argv",
      };
    },
    async preflight(_deps, req) {
      if (req.model || req.effort || req.sandbox) {
        return { ok: false, failure: "unsupported-setting", message: "unsupported" };
      }
      return { ok: true, authState: "unknown" };
    },
    parseTelemetry() {
      return {
        text: null,
        costUsd: null,
        usage: null,
        resolvedModel: null,
        throttled: null,
      };
    },
    describeTreatment(req, _inv, probe) {
      return {
        adapter: name,
        cliVersion: probe.cliVersion,
        providerAuthClass: probe.providerAuthClass || "unknown",
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
}
