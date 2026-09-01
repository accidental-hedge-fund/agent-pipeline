// Public adapter registry surface (#431 task 1.2; #783 extension contract).
// Single-sourced lookup so `harness.ts`, `config.ts`, `executors.ts`, and
// `stages/doctor.ts` never hand-roll a second list of adapter names.
//
// Built-ins re-register through the same public `registerAdapter` surface as
// third-party extensions.

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";
import { opencodeAdapter } from "./opencode.ts";
import { piAdapter } from "./pi.ts";
import { materializeCompatibilityAdapter } from "./compatibility.ts";
import {
  BUILTIN_ADAPTER_NAMES,
  allAdapters as registryAllAdapters,
  registerAdapter,
  registeredAdapterNames as registryNames,
  resolveAdapter as registryResolve,
  resolveRegisteredAdapterForRole,
  _clearRegistryForTests,
  _setRegistryForTests as registrySetForTests,
} from "./registry.ts";
import type { AdapterRole, HarnessAdapter } from "./types.ts";

export {
  BUILTIN_ADAPTER_NAMES,
  registerAdapter,
  type BuiltinAdapterName,
} from "./registry.ts";

const BUILTIN_ADAPTERS: readonly HarnessAdapter[] = [
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  opencodeAdapter,
  piAdapter,
];

let builtinsRegistered = false;

/** Register built-in adapters through the public API (idempotent). */
export function ensureBuiltinsRegistered(): void {
  if (builtinsRegistered && BUILTIN_ADAPTER_NAMES.every((n) => registryResolve(n) !== null)) {
    return;
  }
  for (const adapter of BUILTIN_ADAPTERS) {
    if (registryResolve(adapter.name) === null) {
      registerAdapter(adapter);
    }
  }
  builtinsRegistered = true;
}

/** Resolve a registered adapter by name, or `null` when unregistered. */
export function resolveAdapter(name: string): HarnessAdapter | null {
  ensureBuiltinsRegistered();
  return registryResolve(name);
}

/**
 * Resolve an adapter for a configured role.
 *
 * - Registered adapters must declare the requested role.
 * - Unregistered names may use the compatibility path only when
 *   `allowCompatibility` is true (reviewer custom-CLI escape hatch, #40).
 */
export function resolveAdapterForRole(
  name: string,
  role: AdapterRole,
  opts: {
    allowCompatibility?: boolean;
    promptDelivery?: "argv" | "stdin";
  } = {},
): HarnessAdapter {
  ensureBuiltinsRegistered();
  const registered = resolveRegisteredAdapterForRole(name, role);
  if (registered) return registered;
  // resolveRegisteredAdapterForRole throws on missing role capability when
  // the name is registered; null means unregistered.
  if (opts.allowCompatibility && role === "reviewer") {
    return materializeCompatibilityAdapter(name, {
      promptDelivery: opts.promptDelivery ?? "argv",
    });
  }
  throw new Error(
    `No registered harness adapter named "${name}" for role ${role}. ` +
      `Registered adapters: ${registeredAdapterNames().join(", ")}.`,
  );
}

/** All registered adapter names, in insertion order. */
export function registeredAdapterNames(): string[] {
  ensureBuiltinsRegistered();
  return registryNames();
}

/** All registered adapters. Used by the runtime conformance kit. */
export function allAdapters(): HarnessAdapter[] {
  ensureBuiltinsRegistered();
  return registryAllAdapters();
}

/**
 * Test-only: clear the registry and optionally re-seed built-ins.
 * Production code must never call this.
 */
export function _resetRegistryForTests(opts: { reseedBuiltins?: boolean } = {}): void {
  _clearRegistryForTests();
  builtinsRegistered = false;
  if (opts.reseedBuiltins !== false) {
    ensureBuiltinsRegistered();
  }
}

/**
 * Test-only: replace the entire registry contents.
 */
export function _setRegistryForTests(adapters: HarnessAdapter[]): void {
  registrySetForTests(adapters);
  builtinsRegistered =
    BUILTIN_ADAPTER_NAMES.every((n) => registryResolve(n) !== null);
}

// Boot: register built-ins immediately so any import of this module has a
// populated registry without an explicit ensure call.
ensureBuiltinsRegistered();

export * from "./types.ts";
export { materializeCompatibilityAdapter } from "./compatibility.ts";
export {
  loadAdapterExtensions,
  type AdapterExtensionLoadResult,
} from "./extension-loader.ts";
export {
  assertAdapterConformance,
  runConformanceKit,
  checkStructure,
  type ConformanceFailure,
  type ConformanceReport,
} from "./conformance.ts";
// #778 — provider-neutral treatment fingerprint + once-per-run version probe
// (shared with evals #653 / preflight #636; importable pure units).
export {
  ADAPTER_CONTRACT_VERSION,
  adapterCapabilityHashPayload,
  buildTreatmentFingerprint,
  deriveTelemetryCoverage,
  hashAdapterCapabilities,
  sanitizeTreatmentFingerprint,
  sandboxToolPolicyIdentity,
  type BuildTreatmentFingerprintInput,
  type TelemetryChannelCoverage,
  type TelemetryCoverage,
  type TreatmentFingerprint,
} from "./treatment-fingerprint.ts";
export {
  BACKGROUND_JOB_LIFECYCLE_MAX_JOIN_GRACE_MS,
  BACKGROUND_JOB_LIFECYCLE_SCHEMA,
  BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  BackgroundJobLifecycleSupervisor,
  MUTATING_IMPLEMENTER_STAGE_KINDS,
  NEVER_STARTED_PREFLIGHT_FORBIDDEN_RECIPES,
  backgroundJobLifecycleCoherenceFailure,
  backgroundWaitBlockReason,
  capabilityRefusalMessage,
  effectiveJoinGraceMs,
  filterRecipesForHarnessBackgroundWait,
  filterRecipesForNeverStartedPreflight,
  malformedLifecycleRefusalMessage,
  harnessInvocationFingerprint,
  hashPromptForFingerprint,
  isMutatingImplementerStageKind,
  parseLifecycleJsonl,
  protocolFixtureSupportIsHonest,
  protocolProvesBackgroundJobLifecycle,
  redactLifecycleEvent,
  requiresBackgroundJobLifecycle,
  runInjectedLifecycleSupervisor,
  sameAdapterRetryForbidden,
  supportedBackgroundJobLifecycle,
  type BackgroundJobLifecycleEvidence,
  type BackgroundJobProtocolFixture,
  type InjectedLifecycleEvent,
  type PreviousLifecycleInvocation,
} from "./background-job-lifecycle.ts";
export {
  createCliVersionProbeCache,
  parseCliVersionStdout,
  probeCliVersionOnce,
  resolveCommandPath,
  _clearCliVersionProbeCacheForTests,
  _peekCliVersionProbeForTests,
  type CliVersionProbeDeps,
  type CliVersionProbeResult,
} from "./cli-version-probe.ts";
export {
  BUILTIN_VERIFIED_AGAINST,
  extractComparableVersion,
  formatVersionDriftWarning,
  getVerifiedAgainst,
  versionsCompatible,
  type VerifiedAgainstIdentity,
} from "./verified-against.ts";
// #636 — production preflight-on-invoke for the exact resolved treatment.
export {
  defaultProductionPreflightDeps,
  PREFLIGHT_DIAGNOSTIC_MAX_CHARS,
  productionPreflightRefusalReason,
  projectPreflightRemediation,
  resolveAbsoluteExecutable,
  runProductionPreflight,
  sanitizePreflightDiagnostic,
  type ProductionPreflightDeps,
  type ProductionPreflightFailureClass,
  type ProductionPreflightInterventionKind,
  type ProductionPreflightReasonCode,
  type ProductionPreflightRemediation,
  type ProductionPreflightRequest,
  type ProductionPreflightResult,
} from "./production-preflight.ts";
