// Runtime outer-host registry (#784). Sole enumeration source for installable /
// orchestrable outer hosts. Built-ins and extensions register through the same
// public API. Separated from index so loaders can import without cycles.

import type { OuterHostManifest } from "./types.ts";
import { OUTER_HOST_MANIFEST_VERSION } from "./types.ts";

const registry = new Map<string, OuterHostManifest>();

/**
 * Structural identity for idempotent re-registration: same id + same
 * JSON-stable fingerprint is treated as the same registration.
 */
function fingerprint(manifest: OuterHostManifest): string {
  return JSON.stringify(manifest);
}

/**
 * Register an outer-host manifest.
 *
 * - Same-identity re-register (deep-equal via JSON fingerprint) is idempotent.
 * - Distinct manifests under the same id fail closed.
 * - Unsupported manifestVersion is rejected with a machine-readable error.
 */
export function registerOuterHost(manifest: OuterHostManifest): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("registerOuterHost: manifest must be an object");
  }
  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    throw new Error("registerOuterHost: manifest.id must be a non-empty string");
  }
  if (typeof manifest.manifestVersion !== "number") {
    throw new Error(
      `registerOuterHost: host "${manifest.id}" missing numeric manifestVersion`,
    );
  }
  if (manifest.manifestVersion !== OUTER_HOST_MANIFEST_VERSION) {
    throw new Error(
      `registerOuterHost: host "${manifest.id}" has unsupported manifestVersion ` +
        `${manifest.manifestVersion} (supported: ${OUTER_HOST_MANIFEST_VERSION})`,
    );
  }
  if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) {
    throw new Error(
      `registerOuterHost: host "${manifest.id}" requires non-empty displayName`,
    );
  }

  const existing = registry.get(manifest.id);
  if (existing) {
    if (fingerprint(existing) === fingerprint(manifest)) return;
    throw new Error(
      `Outer-host ID collision: "${manifest.id}" is already registered by a different implementation`,
    );
  }
  registry.set(manifest.id, Object.freeze({ ...manifest }) as OuterHostManifest);
}

/** Resolve a registered outer host by id, or null when unregistered. */
export function resolveOuterHost(id: string): OuterHostManifest | null {
  return registry.get(id) ?? null;
}

/** All registered outer-host ids, in insertion order. */
export function registeredOuterHostIds(): string[] {
  return [...registry.keys()];
}

/** All registered outer-host manifests. */
export function allOuterHosts(): OuterHostManifest[] {
  return [...registry.values()];
}

/** Test-only: clear the registry. Production code must never call this. */
export function _clearOuterHostRegistryForTests(): void {
  registry.clear();
}

/** Test-only: replace the entire registry contents. */
export function _setOuterHostRegistryForTests(hosts: OuterHostManifest[]): void {
  registry.clear();
  for (const host of hosts) {
    registerOuterHost(host);
  }
}
