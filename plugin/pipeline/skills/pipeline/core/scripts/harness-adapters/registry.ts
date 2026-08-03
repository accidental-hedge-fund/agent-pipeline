// Runtime adapter registry core (#783). Separated from index.ts so loaders
// and compatibility helpers can import registration without a cycle through
// built-in adapter modules.

import type { AdapterRole, HarnessAdapter } from "./types.ts";
import { adapterSupportsRole } from "./types.ts";

/** Built-in adapter IDs shipped with the engine. Golden suites may assert this
 *  set independently of the runtime registry (which may also hold extensions). */
export const BUILTIN_ADAPTER_NAMES = ["claude", "codex", "grok", "opencode", "pi"] as const;
export type BuiltinAdapterName = (typeof BUILTIN_ADAPTER_NAMES)[number];

/** Mutable runtime registry — load-time registration only in production. */
const registry = new Map<string, HarnessAdapter>();

/**
 * Register an adapter into the runtime registry.
 *
 * - Same object (reference identity) re-registered under the same ID is
 *   idempotent (no-op).
 * - Distinct implementations claiming the same ID fail closed.
 */
export function registerAdapter(adapter: HarnessAdapter): void {
  if (!adapter || typeof adapter.name !== "string" || !adapter.name.trim()) {
    throw new Error("registerAdapter: adapter.name must be a non-empty string");
  }
  if (!adapter.declaration) {
    throw new Error(
      `registerAdapter: adapter "${adapter.name}" is missing the required declaration field`,
    );
  }
  if (!adapter.declaration.roles || adapter.declaration.roles.length === 0) {
    throw new Error(
      `registerAdapter: adapter "${adapter.name}" must declare at least one role capability`,
    );
  }
  const existing = registry.get(adapter.name);
  if (existing) {
    if (existing === adapter) return;
    throw new Error(
      `Adapter ID collision: "${adapter.name}" is already registered by a different implementation`,
    );
  }
  registry.set(adapter.name, adapter);
}

/** Resolve a registered adapter by name, or `null` when unregistered. */
export function resolveAdapter(name: string): HarnessAdapter | null {
  return registry.get(name) ?? null;
}

/** All registered adapter names, in insertion order. */
export function registeredAdapterNames(): string[] {
  return [...registry.keys()];
}

/** All registered adapters. */
export function allAdapters(): HarnessAdapter[] {
  return [...registry.values()];
}

/**
 * Resolve an adapter for a configured role against the current registry.
 * Does not materialize compatibility adapters — callers that need the #40
 * escape hatch pass `materialize` or use `resolveAdapterForRole` in index.
 */
export function resolveRegisteredAdapterForRole(
  name: string,
  role: AdapterRole,
): HarnessAdapter | null {
  const registered = registry.get(name);
  if (!registered) return null;
  if (!adapterSupportsRole(registered, role)) {
    throw new Error(
      `Adapter "${name}" does not declare the ${role} role capability ` +
        `(declared roles: ${registered.declaration.roles.join(", ") || "(none)"}).`,
    );
  }
  return registered;
}

/**
 * Test-only: clear the registry. Production code must never call this.
 */
export function _clearRegistryForTests(): void {
  registry.clear();
}

/**
 * Test-only: replace the entire registry contents.
 */
export function _setRegistryForTests(adapters: HarnessAdapter[]): void {
  registry.clear();
  for (const adapter of adapters) {
    registerAdapter(adapter);
  }
}
