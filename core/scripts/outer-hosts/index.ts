// Public outer-host registry surface (#784).
// Built-ins re-register through the same public API as third-party extensions.

import {
  allOuterHosts as registryAll,
  registerOuterHost,
  registeredOuterHostIds as registryIds,
  resolveOuterHost as registryResolve,
  _clearOuterHostRegistryForTests,
  _setOuterHostRegistryForTests as registrySetForTests,
} from "./registry.ts";
import {
  loadOuterHostManifestsFromRepo,
  loadOuterHostManifestsPreferHosts,
} from "./load-manifest.ts";
import type { OuterHostManifest } from "./types.ts";
import { BUILTIN_OUTER_HOST_IDS } from "./types.ts";

export {
  BUILTIN_OUTER_HOST_IDS,
  OUTER_HOST_MANIFEST_VERSION,
  OUTER_HOST_CAPABILITY_AREAS,
  PORTABLE_OBSERVATION_BASELINE,
  type BuiltinOuterHostId,
  type OuterHostCapability,
  type OuterHostCapabilityArea,
  type OuterHostInstallMode,
  type OuterHostManifest,
  type OuterHostMaterialProgressNotify,
  type MaterialNotifySurface,
} from "./types.ts";

export {
  registerOuterHost,
  resolveOuterHost as resolveOuterHostRaw,
  registeredOuterHostIds as registeredOuterHostIdsRaw,
  allOuterHosts as allOuterHostsRaw,
  _clearOuterHostRegistryForTests,
  _setOuterHostRegistryForTests,
} from "./registry.ts";

export {
  loadBuiltinOuterHostManifests,
  loadOuterHostManifestFile,
  loadOuterHostManifestsFromRepo,
  loadOuterHostManifestsPreferHosts,
  outerHostManifestPath,
  outerHostManifestRelativePath,
  parseOuterHostManifest,
} from "./load-manifest.ts";

export {
  assertOuterHostConformance,
  checkOuterHostConformance,
  runOuterHostConformanceKit,
  type OuterHostConformanceFailure,
  type OuterHostConformanceReport,
} from "./conformance.ts";

export {
  LIFECYCLE_STEP_IDS,
  longRunningLifecyclePath,
  requiresReattachAfterCancelledWait,
  resolveMaterialNotifySurface,
  selectLifecycleSteps,
  type LifecycleStep,
  type LifecycleStepId,
} from "./orchestration.ts";

export {
  OUTER_HOST_UNKNOWN,
  outerHostEvidenceFields,
  readOuterHostFromEnv,
  resolveOuterHostEvidence,
  type OuterHostEvidenceFields,
  type OuterHostEvidenceId,
  type ResolveOuterHostEvidenceInput,
} from "./evidence.ts";

let builtinsRegistered = false;

/** Register built-in outer hosts from co-located manifests (idempotent). */
export function ensureBuiltinOuterHostsRegistered(
  repoRoot?: string,
): void {
  if (
    builtinsRegistered &&
    BUILTIN_OUTER_HOST_IDS.every((id) => registryResolve(id) !== null)
  ) {
    return;
  }
  const manifests = repoRoot
    ? loadOuterHostManifestsFromRepo(repoRoot)
    : loadOuterHostManifestsPreferHosts();
  // When an explicit repoRoot was given but empty, still try builtins.
  const resolved =
    manifests.length > 0 ? manifests : loadOuterHostManifestsPreferHosts(repoRoot);
  for (const manifest of resolved) {
    if (registryResolve(manifest.id) === null) {
      registerOuterHost(manifest);
    }
  }
  // Mark only when all built-ins resolved (partial fixture dirs still mark so
  // callers can register extensions afterward without re-scanning forever).
  builtinsRegistered = true;
}

/** Resolve a registered outer host by id (loads built-ins first). */
export function resolveOuterHost(id: string): OuterHostManifest | null {
  ensureBuiltinOuterHostsRegistered();
  return registryResolve(id);
}

/** All registered outer-host ids (loads built-ins first). */
export function registeredOuterHostIds(): string[] {
  ensureBuiltinOuterHostsRegistered();
  return registryIds();
}

/** All registered outer hosts (loads built-ins first). */
export function allOuterHosts(): OuterHostManifest[] {
  ensureBuiltinOuterHostsRegistered();
  return registryAll();
}

/**
 * Test-only full reset: clear registry and allow built-ins to re-register on
 * next resolve.
 */
export function _resetOuterHostRegistryForTests(): void {
  _clearOuterHostRegistryForTests();
  builtinsRegistered = false;
}

/** Test-only: inject hosts and skip auto builtin load until reset. */
export function _setOuterHostsForTests(hosts: OuterHostManifest[]): void {
  registrySetForTests(hosts);
  builtinsRegistered = true;
}
