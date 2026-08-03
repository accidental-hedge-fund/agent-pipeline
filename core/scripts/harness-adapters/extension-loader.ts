// Declarative end-user adapter extension loader (#783).
//
// Primary registration path: repository config key `adapter_extensions`, a
// list of module entry points (repo-relative or absolute). Each module may:
//
//   1. `export default` / `module.exports` a HarnessAdapter (or array)
//   2. `export const adapters = [...]` / `exports.adapters`
//   3. `export function register(api)` / `exports.register` that calls
//      `api.registerAdapter(...)`
//
// Only explicitly configured entry points (plus built-ins) are loaded — the
// pipeline never auto-scans node_modules.
//
// Production resolveConfig is synchronous, so the default loader uses
// `createRequire` (CommonJS-compatible entry points: `.cjs`, `.js` with
// module.exports, or packages that expose a CJS main). Tests may inject
// `requireModule` / async `importModule` fakes.

import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { registerAdapter, resolveAdapter } from "./registry.ts";
import type { HarnessAdapter } from "./types.ts";

export interface AdapterExtensionLoadResult {
  loaded: string[];
  registeredIds: string[];
  errors: string[];
}

export interface LoadAdapterExtensionsOptions {
  /** Absolute path to the target repository root. */
  repoDir: string;
  /** Entry points from config (`adapter_extensions`). */
  entryPoints: readonly string[];
  /**
   * Injectable module loader (sync). Defaults to createRequire from repoDir.
   * Tests pass a fake so no real filesystem load occurs.
   */
  requireModule?: (specifier: string) => unknown;
  /**
   * Injectable registration target (defaults to the production registry).
   */
  register?: (adapter: HarnessAdapter) => void;
}

/**
 * Synchronously load and register adapter modules listed in config.
 * Unconfigured packages are never loaded. Failures are collected (not thrown)
 * so resolveConfig can decide whether to surface them; each error names the
 * entry point.
 */
export function loadAdapterExtensions(
  opts: LoadAdapterExtensionsOptions,
): AdapterExtensionLoadResult {
  const result: AdapterExtensionLoadResult = {
    loaded: [],
    registeredIds: [],
    errors: [],
  };
  if (!opts.entryPoints || opts.entryPoints.length === 0) {
    return result;
  }

  const defaultRequire = createRequire(path.join(opts.repoDir, "package.json"));
  const requireModule = opts.requireModule ?? ((specifier: string) => defaultRequire(specifier));
  const register = opts.register ?? registerAdapter;

  for (const entry of opts.entryPoints) {
    if (typeof entry !== "string" || !entry.trim()) {
      result.errors.push(`adapter_extensions entry is empty or not a string`);
      continue;
    }
    const resolved = resolveEntryPath(opts.repoDir, entry);
    let mod: unknown;
    try {
      mod = requireModule(resolved.specifier);
    } catch (err) {
      result.errors.push(
        `adapter_extensions entry "${entry}" failed to load (${resolved.specifier}): ${(err as Error).message}`,
      );
      continue;
    }
    result.loaded.push(entry);

    try {
      const newlyRegistered: string[] = [];
      const trackingRegister = (adapter: HarnessAdapter): void => {
        register(adapter);
        newlyRegistered.push(adapter.name);
      };

      applyModuleExports(mod, trackingRegister, entry);
      result.registeredIds.push(...newlyRegistered);
    } catch (err) {
      result.errors.push(
        `adapter_extensions entry "${entry}" failed to register: ${(err as Error).message}`,
      );
    }
  }

  return result;
}

function resolveEntryPath(
  repoDir: string,
  entry: string,
): { specifier: string; kind: "path" | "package" } {
  // Absolute path — createRequire accepts absolute filesystem paths.
  if (path.isAbsolute(entry)) {
    return { specifier: entry, kind: "path" };
  }
  // Relative path (./ or ../)
  if (entry.startsWith("./") || entry.startsWith("../") || entry.startsWith(".\\")) {
    const abs = path.resolve(repoDir, entry);
    return { specifier: abs, kind: "path" };
  }
  // Bare package name / subpath — leave to the module resolver (must be
  // resolvable from the repo's node_modules; never auto-scanned).
  return { specifier: entry, kind: "package" };
}

function applyModuleExports(
  mod: unknown,
  register: (adapter: HarnessAdapter) => void,
  entryLabel: string,
): void {
  if (!mod || (typeof mod !== "object" && typeof mod !== "function")) {
    throw new Error(`module did not export an object`);
  }
  const m = mod as Record<string, unknown>;

  // 3. Programmatic hook: register(api)
  if (typeof m.register === "function") {
    (m.register as (api: { registerAdapter: typeof register }) => unknown)({
      registerAdapter: register,
    });
    return;
  }

  // 2. Named export: adapters
  if (m.adapters !== undefined) {
    registerAdapterExport(m.adapters, register, entryLabel);
    return;
  }

  // 1. Default export / module.exports: single adapter or array
  // CJS interop: module.exports = adapter may appear as mod itself when the
  // whole export is the adapter (function-like or plain object with name).
  if (m.default !== undefined) {
    registerAdapterExport(m.default, register, entryLabel);
    return;
  }

  if (isHarnessAdapterShape(mod)) {
    registerAdapterExport(mod, register, entryLabel);
    return;
  }

  throw new Error(
    `module must export default HarnessAdapter | HarnessAdapter[], ` +
      `named adapters, or register(api) — none found in "${entryLabel}"`,
  );
}

function registerAdapterExport(
  value: unknown,
  register: (adapter: HarnessAdapter) => void,
  entryLabel: string,
): void {
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    if (!isHarnessAdapterShape(item)) {
      throw new Error(
        `export from "${entryLabel}" is not a HarnessAdapter (missing name/declaration/buildInvocation)`,
      );
    }
    const adapter = item as HarnessAdapter;
    if (adapter.declaration.origin === "builtin") {
      const patched: HarnessAdapter = {
        ...adapter,
        declaration: { ...adapter.declaration, origin: "extension" },
      };
      register(patched);
    } else {
      register(adapter);
    }
  }
}

function isHarnessAdapterShape(value: unknown): value is HarnessAdapter {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<HarnessAdapter>;
  return (
    typeof a.name === "string" &&
    typeof a.declaration === "object" &&
    a.declaration !== null &&
    typeof a.buildInvocation === "function" &&
    typeof a.preflight === "function" &&
    typeof a.parseTelemetry === "function" &&
    typeof a.describeTreatment === "function" &&
    typeof a.runtimeSmoke === "function"
  );
}

/** Sync helper for tests: assert an ID is registered after load. */
export function isAdapterRegistered(name: string): boolean {
  return resolveAdapter(name) !== null;
}

/** File-URL form of a path — exported for docs/tests that prefer ESM import(). */
export function entryPointToFileUrl(repoDir: string, entry: string): string {
  const { specifier, kind } = resolveEntryPath(repoDir, entry);
  if (kind === "package") return specifier;
  return pathToFileURL(specifier).href;
}
