// #784 — outer-host lifecycle contract: registry, conformance, orchestration,
// evidence identity, synthetic third-party fixture, lifecycle regression fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_OUTER_HOST_IDS,
  OUTER_HOST_MANIFEST_VERSION,
  OUTER_HOST_UNKNOWN,
  allOuterHosts,
  assertOuterHostConformance,
  checkOuterHostConformance,
  ensureBuiltinOuterHostsRegistered,
  loadOuterHostManifestFile,
  longRunningLifecyclePath,
  outerHostEvidenceFields,
  parseOuterHostManifest,
  registerOuterHost,
  registeredOuterHostIds,
  requiresReattachAfterCancelledWait,
  resolveMaterialNotifySurface,
  resolveOuterHost,
  resolveOuterHostEvidence,
  runOuterHostConformanceKit,
  selectLifecycleSteps,
  _resetOuterHostRegistryForTests,
  type OuterHostManifest,
} from "../scripts/outer-hosts/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixtureDir = path.join(here, "fixtures", "outer-hosts");

function loadFixture(name: string): OuterHostManifest {
  return loadOuterHostManifestFile(path.join(fixtureDir, name));
}

// ---------------------------------------------------------------------------
// 1. Registry
// ---------------------------------------------------------------------------

test("builtins register through public API from co-located manifests", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  for (const id of BUILTIN_OUTER_HOST_IDS) {
    const host = resolveOuterHost(id);
    assert.ok(host, `builtin ${id} must resolve`);
    assert.equal(host.origin, "builtin");
    assert.equal(host.manifestVersion, OUTER_HOST_MANIFEST_VERSION);
    assert.ok(host.displayName.trim());
  }
  assert.ok(registeredOuterHostIds().length >= BUILTIN_OUTER_HOST_IDS.length);
  // Registry is the enumeration source — not a hardcoded completeness criterion
  // for "all hosts" beyond the golden builtin set.
  assert.equal(registeredOuterHostIds().length, allOuterHosts().length);
});

test("registerOuterHost: same-identity re-register is idempotent", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const host = resolveOuterHost("claude")!;
  assert.doesNotThrow(() => registerOuterHost(structuredClone(host)));
  assert.equal(resolveOuterHost("claude")!.id, "claude");
});

test("registerOuterHost: distinct implementation under same ID fails closed", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const clone = structuredClone(resolveOuterHost("claude")!) as OuterHostManifest;
  clone.displayName = "Different Claude";
  assert.throws(() => registerOuterHost(clone), /Outer-host ID collision.*"claude"/);
  assert.equal(resolveOuterHost("claude")!.displayName, "Claude Code");
});

test("ensureBuiltinOuterHostsRegistered: extension-first collision with builtin fails closed (#784)", () => {
  _resetOuterHostRegistryForTests();
  // Extension claims builtin id before builtins load — must not silently retain.
  const extClaude = loadFixture("synth-complete.json");
  extClaude.id = "claude";
  extClaude.displayName = "Extension Claude Impostor";
  extClaude.origin = "extension";
  registerOuterHost(extClaude);
  assert.throws(
    () => ensureBuiltinOuterHostsRegistered(repoRoot),
    /Outer-host ID collision.*"claude"/,
  );
});

test("ensureBuiltinOuterHostsRegistered: builtin-first then distinct extension collides (#784)", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const extClaude = loadFixture("synth-complete.json");
  extClaude.id = "claude";
  extClaude.displayName = "Extension Claude Impostor";
  extClaude.origin = "extension";
  assert.throws(() => registerOuterHost(extClaude), /Outer-host ID collision.*"claude"/);
  assert.equal(resolveOuterHost("claude")!.origin, "builtin");
  assert.equal(resolveOuterHost("claude")!.displayName, "Claude Code");
});

test("registerOuterHost: unsupported manifestVersion is rejected", () => {
  _resetOuterHostRegistryForTests();
  const bad = loadFixture("synth-complete.json");
  bad.id = "bad-version";
  (bad as { manifestVersion: number }).manifestVersion = 99;
  assert.throws(() => registerOuterHost(bad), /unsupported manifestVersion.*99/);
});

test("extension registration does not require editing built-in host modules", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const synth = loadFixture("synth-complete.json");
  registerOuterHost(synth);
  assert.ok(registeredOuterHostIds().includes("synth-third-party"));
  assert.equal(resolveOuterHost("synth-third-party")!.origin, "extension");
  // Built-in modules under hosts/{claude,codex,grok,opencode} are not modified
  // for this registration — only registerOuterHost was called.
});

// ---------------------------------------------------------------------------
// 2. Golden built-in install destinations + lifecycle support
// ---------------------------------------------------------------------------

test("golden: built-in install modes and lifecycle support match pre-change behavior", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);

  const claude = resolveOuterHost("claude")!;
  assert.equal(claude.install.mode, "tree");
  assert.equal(claude.install.managedArtifacts.commandsKind, "claude-slash");
  assert.equal(claude.profileDefault, "claude");
  assert.equal(claude.material_progress_notify.mapping.surface, "claude_monitor_push");
  assert.ok(claude.material_progress_notify.mapping.tools.includes("PushNotification"));
  assert.equal(claude.wait_cancel.classification, "non_terminal");
  assert.equal(claude.reattach.support, "supported");
  assert.equal(claude.early_run_handoff.support, "supported");
  assert.equal(claude.event_follow.support, "supported");
  assert.equal(claude.terminal_cleanup.support, "supported");
  assert.equal(claude.terminal_summary.support, "supported");

  const codex = resolveOuterHost("codex")!;
  assert.equal(codex.install.mode, "tree");
  assert.equal(codex.install.managedArtifacts.commandsKind, "codex-prompt");
  assert.equal(codex.material_progress_notify.mapping.surface, "codex_chat_status");
  assert.ok(!codex.material_progress_notify.mapping.tools.includes("PushNotification"));

  const grok = resolveOuterHost("grok")!;
  assert.equal(grok.install.mode, "symlink-claude");
  assert.equal(grok.material_progress_notify.mapping.surface, "grok_monitor_lines");
  assert.match(grok.material_progress_notify.how, /Never require Claude PushNotification|Never.*PushNotification/i);

  const opencode = resolveOuterHost("opencode")!;
  assert.equal(opencode.install.mode, "tree");
  assert.equal(opencode.install.managedArtifacts.commandsKind, "opencode-native");
  assert.ok(
    opencode.install.managedArtifacts.extraScriptFiles?.includes(
      "opencode-pipeline-bridge.mjs",
    ),
  );
  assert.equal(opencode.material_progress_notify.mapping.surface, "stdout_only");

  const omp = resolveOuterHost("omp")!;
  assert.equal(omp.install.mode, "tree");
  assert.equal(omp.install.managedArtifacts.commandsKind, "omp-native");
  assert.notEqual(omp.install.managedArtifacts.commandsKind, "opencode-native");
  assert.deepEqual(omp.install.basePath.defaultHomeSegments, [".omp", "agent"]);
  assert.equal(omp.install.basePath.env, null);
  assert.equal(omp.material_progress_notify.mapping.surface, "stdout_only");
  assert.match(
    omp.material_progress_notify.fallback ?? omp.event_follow.how ?? "",
    /stdout|events\.jsonl/i,
  );
  assert.equal(omp.id, "omp");
  assert.notEqual(omp.id, "pi");
});

test("co-located manifests exist for every builtin and match registry", () => {
  for (const id of BUILTIN_OUTER_HOST_IDS) {
    const p = path.join(repoRoot, "hosts", id, "outer-host.manifest.json");
    assert.ok(fs.existsSync(p), `missing ${p}`);
    const fromDisk = loadOuterHostManifestFile(p);
    assert.equal(fromDisk.id, id);
  }
});

test("core-shipped builtins stay in lockstep with hosts/ manifests", () => {
  for (const id of BUILTIN_OUTER_HOST_IDS) {
    const hostPath = path.join(repoRoot, "hosts", id, "outer-host.manifest.json");
    const builtinPath = path.join(
      repoRoot,
      "core/scripts/outer-hosts/builtins",
      `${id}.json`,
    );
    assert.ok(fs.existsSync(builtinPath), `missing runtime builtin ${builtinPath}`);
    assert.equal(
      fs.readFileSync(hostPath, "utf8"),
      fs.readFileSync(builtinPath, "utf8"),
      `hosts/${id}/outer-host.manifest.json must match core/scripts/outer-hosts/builtins/${id}.json`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Conformance kit
// ---------------------------------------------------------------------------

test("conformance kit: all built-in outer hosts pass", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const reports = runOuterHostConformanceKit(allOuterHosts());
  for (const r of reports) {
    assert.equal(
      r.ok,
      true,
      `host ${r.host} failed: ${JSON.stringify(r.failures)}`,
    );
  }
});

test("conformance kit: complete synthetic third-party host passes", () => {
  const synth = loadFixture("synth-complete.json");
  const report = checkOuterHostConformance(synth);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.doesNotThrow(() => assertOuterHostConformance(synth));
});

test("conformance kit: unsupported capability with fallback and no how passes (#784)", () => {
  // Spec-valid complete declaration: unsupported + explicit portable fallback,
  // without how-to data (how is only required for supported/limited).
  const synth = loadFixture("unsupported-capability-no-how.json");
  assert.equal(synth.early_run_handoff.support, "unsupported");
  assert.equal(synth.early_run_handoff.how, undefined);
  assert.ok(synth.early_run_handoff.fallback?.trim());
  const report = checkOuterHostConformance(synth);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.doesNotThrow(() => assertOuterHostConformance(synth));
});

test("conformance kit: incomplete synthetic host fails naming missing field", () => {
  const incomplete = loadFixture("incomplete.json");
  const report = checkOuterHostConformance(incomplete);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (f) =>
        f.message.includes("early_run_handoff") ||
        f.check === "fallback" ||
        f.message.includes("fallback"),
    ),
    JSON.stringify(report.failures),
  );
  assert.throws(
    () => assertOuterHostConformance(incomplete),
    /incomplete-synth|early_run_handoff|fallback/,
  );
});

test("conformance kit: limited install without fallback fails (#784)", () => {
  const report = checkOuterHostConformance(loadFixture("limited-install-no-fallback.json"));
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (f) => f.check === "fallback" && f.message.includes("install") && f.message.includes("limited"),
    ),
    JSON.stringify(report.failures),
  );
});

test("conformance kit: limited invocation without fallback fails (#784)", () => {
  const report = checkOuterHostConformance(loadFixture("limited-invocation-no-fallback.json"));
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (f) =>
        f.check === "fallback" &&
        f.message.includes("invocation") &&
        f.message.includes("limited"),
    ),
    JSON.stringify(report.failures),
  );
});

test("conformance kit: missing skillsRelative fails when install supported (#784)", () => {
  const report = checkOuterHostConformance(loadFixture("missing-skills-relative.json"));
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (f) => f.check === "install.skillsRelative" || f.message.includes("skillsRelative"),
    ),
    JSON.stringify(report.failures),
  );
});

test("conformance kit: rejects malformed commandsDirRelative entries (#784)", () => {
  const cases = [
    "commands-dir-null-entry.json",
    "commands-dir-empty-entry.json",
    "commands-dir-traversal.json",
  ] as const;
  for (const name of cases) {
    const report = checkOuterHostConformance(loadFixture(name));
    assert.equal(report.ok, false, `${name} should fail: ${JSON.stringify(report.failures)}`);
    assert.ok(
      report.failures.some(
        (f) =>
          f.check === "install.managedArtifacts.commandsDirRelative" &&
          (f.message.includes("non-empty relative") || f.message.includes("commandsDirRelative")),
      ),
      `${name}: expected commandsDirRelative failure, got ${JSON.stringify(report.failures)}`,
    );
  }
  // Absolute segment (runtime JSON path; not covered by type annotations).
  const absolute = structuredClone(loadFixture("synth-complete.json")) as OuterHostManifest & {
    install: { managedArtifacts: { commandsDirRelative: unknown } };
  };
  absolute.install.managedArtifacts.commandsDirRelative = ["/etc"];
  const absReport = checkOuterHostConformance(absolute);
  assert.equal(absReport.ok, false);
  assert.ok(
    absReport.failures.some((f) => f.check === "install.managedArtifacts.commandsDirRelative"),
    JSON.stringify(absReport.failures),
  );
  // Non-string number entry.
  absolute.install.managedArtifacts.commandsDirRelative = [42];
  const numReport = checkOuterHostConformance(absolute);
  assert.equal(numReport.ok, false);
  assert.ok(
    numReport.failures.some((f) => f.check === "install.managedArtifacts.commandsDirRelative"),
    JSON.stringify(numReport.failures),
  );
});

// ---------------------------------------------------------------------------
// 4. Orchestration — capability-driven, no host-name branch
// ---------------------------------------------------------------------------

test("selectLifecycleSteps is driven by capabilities for synthetic host", () => {
  const synth = loadFixture("synth-complete.json");
  const steps = selectLifecycleSteps(synth);
  const ids = steps.map((s) => s.id);
  assert.ok(ids.includes("early_run_handoff"));
  assert.ok(ids.includes("event_follow"));
  assert.ok(ids.includes("reattach_after_cancel"));
  assert.ok(ids.includes("terminal_cleanup"));
  assert.ok(ids.includes("terminal_summary"));
  // Material notify falls back to portable for unsupported
  const notify = steps.find((s) => s.id === "material_progress_notify")!;
  assert.equal(notify.usesPortableBaseline, true);
  assert.equal(resolveMaterialNotifySurface(synth), "stdout_only");
});

test("lifecycle fixture: reattach-after-cancel is host-agnostic", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const synth = loadFixture("synth-complete.json");
  registerOuterHost(synth);

  // Assert every registered host with reattach/wait_cancel — not a host-name table.
  for (const host of allOuterHosts()) {
    assert.equal(
      host.wait_cancel.classification,
      "non_terminal",
      `${host.id} wait_cancel must be non_terminal`,
    );
    assert.equal(
      requiresReattachAfterCancelledWait(host),
      true,
      `${host.id} must require reattach after cancelled wait`,
    );
  }
});

test("lifecycle fixture: long-running handoff→progress→reattach→terminal→cleanup→summary", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const synth = loadFixture("synth-complete.json");
  registerOuterHost(synth);

  for (const host of allOuterHosts()) {
    const pathIds = longRunningLifecyclePath(host);
    assert.deepEqual(pathIds, [
      "early_run_handoff",
      "event_follow",
      "material_progress_notify",
      "reattach_after_cancel",
      "wait_cancel_non_terminal",
      "terminal_exit",
      "terminal_cleanup",
      "terminal_summary",
    ]);
    // Mid-follow cancel re-enters follow before summary when reattach required.
    if (requiresReattachAfterCancelledWait(host)) {
      const reattachIdx = pathIds.indexOf("reattach_after_cancel");
      const summaryIdx = pathIds.indexOf("terminal_summary");
      assert.ok(reattachIdx < summaryIdx);
    }
  }
});

test("lifecycle fixture: cancelled wait is never terminal success", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  for (const host of allOuterHosts()) {
    assert.equal(host.wait_cancel.classification, "non_terminal");
    assert.equal(host.wait_cancel.recovery, "reattach_or_portable_follow");
    const steps = selectLifecycleSteps(host);
    const wc = steps.find((s) => s.id === "wait_cancel_non_terminal")!;
    assert.match(wc.guidance, /non-terminal|not terminal|Cancelled/i);
  }
});

test("lifecycle fixture: material progress uses declared mapping or portable baseline", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const surfaces = new Set(
    allOuterHosts().map((h) => resolveMaterialNotifySurface(h)),
  );
  // Built-ins cover known surfaces; no host-name switch required to resolve.
  assert.ok(surfaces.has("claude_monitor_push"));
  assert.ok(surfaces.has("codex_chat_status"));
  assert.ok(surfaces.has("grok_monitor_lines"));
  assert.ok(surfaces.has("stdout_only"));
});

test("outer-host omp is distinct from adapter id pi (#1235)", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const omp = resolveOuterHost("omp");
  assert.ok(omp, "builtin omp must resolve");
  assert.equal(omp.id, "omp");
  assert.equal(resolveOuterHost("pi"), null, "adapter id pi is not an outer host");
  assert.ok(registeredOuterHostIds().includes("omp"));
  assert.ok(!registeredOuterHostIds().includes("pi"));
});

test("evidence records omp not pi as the outer host (#1235)", () => {
  const fields = outerHostEvidenceFields({
    explicit: "omp",
    implementerAdapterId: "claude",
    reviewerAdapterId: "codex",
  });
  assert.equal(fields.outer_host, "omp");
  assert.notEqual(fields.outer_host, "pi");
  assert.notEqual(fields.outer_host, "claude");
});

// ---------------------------------------------------------------------------
// 5. Evidence identity separation
// ---------------------------------------------------------------------------

test("evidence: outer_host is separate from implementer/reviewer adapter ids", () => {
  const fields = outerHostEvidenceFields({
    explicit: "opencode",
    implementerAdapterId: "claude",
    reviewerAdapterId: "codex",
  });
  assert.equal(fields.outer_host, "opencode");
  assert.notEqual(fields.outer_host, "claude");
  assert.notEqual(fields.outer_host, "codex");
});

test("evidence: extension adapter case keeps host distinct", () => {
  const fields = outerHostEvidenceFields({
    explicit: "claude",
    implementerAdapterId: "my-ext",
    reviewerAdapterId: "codex",
  });
  assert.equal(fields.outer_host, "claude");
  assert.notEqual(fields.outer_host, "my-ext");
});

test("evidence: unknown host is not invented from implementer adapter", () => {
  const id = resolveOuterHostEvidence({
    explicit: null,
    implementerAdapterId: "claude",
    reviewerAdapterId: "codex",
  });
  assert.equal(id, OUTER_HOST_UNKNOWN);
  assert.notEqual(id, "claude");
});

test("evidence: unregistered explicit id becomes unknown when checker provided", () => {
  const id = resolveOuterHostEvidence({
    explicit: "not-a-real-host",
    isRegistered: (x) => x === "claude",
  });
  assert.equal(id, OUTER_HOST_UNKNOWN);
});

// ---------------------------------------------------------------------------
// 6. Manifest independence from adapter fields
// ---------------------------------------------------------------------------

test("manifest does not require adapter/provider/model/effort fields", () => {
  const claude = loadOuterHostManifestFile(
    path.join(repoRoot, "hosts/claude/outer-host.manifest.json"),
  );
  const raw = claude as unknown as Record<string, unknown>;
  for (const key of ["adapterId", "provider", "model", "effort", "roles"]) {
    assert.equal(raw[key], undefined, `must not require ${key}`);
  }
  assert.equal(claude.id, "claude");
});

test("parseOuterHostManifest rejects unsupported version with diagnostic", () => {
  assert.throws(
    () => parseOuterHostManifest({ id: "x", manifestVersion: 0 }, "test"),
    /unsupported manifestVersion/,
  );
});
