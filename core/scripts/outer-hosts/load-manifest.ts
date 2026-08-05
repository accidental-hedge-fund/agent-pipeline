// Load outer-host manifests from co-located JSON (install-time single source).
// Pure filesystem reads — no engine deps so install.mjs can share the same files.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OuterHostManifest } from "./types.ts";
import { OUTER_HOST_MANIFEST_VERSION } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// core/scripts/outer-hosts → repo root is ../../..
const defaultRepoRoot = path.resolve(here, "../../..");

/** Relative path under a host overlay: hosts/<id>/outer-host.manifest.json */
export function outerHostManifestRelativePath(hostId: string): string {
  return path.join("hosts", hostId, "outer-host.manifest.json");
}

/**
 * Parse and lightly validate a raw JSON object into OuterHostManifest.
 * Full conformance is the kit's job; this rejects only unusable shapes.
 */
export function parseOuterHostManifest(raw: unknown, sourceLabel = "manifest"): OuterHostManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: expected object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    throw new Error(`${sourceLabel}: missing id`);
  }
  if (typeof obj.manifestVersion !== "number") {
    throw new Error(`${sourceLabel} (${obj.id}): missing manifestVersion`);
  }
  if (obj.manifestVersion !== OUTER_HOST_MANIFEST_VERSION) {
    throw new Error(
      `${sourceLabel} (${obj.id}): unsupported manifestVersion ${obj.manifestVersion} ` +
        `(supported: ${OUTER_HOST_MANIFEST_VERSION})`,
    );
  }
  return raw as OuterHostManifest;
}

/** Load one manifest JSON from an absolute path. */
export function loadOuterHostManifestFile(filePath: string): OuterHostManifest {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return parseOuterHostManifest(raw, filePath);
}

/**
 * Discover and load all hosts/<id>/outer-host.manifest.json under repoRoot.
 * Order is filesystem order (stable enough for registration; installOrder
 * sorts install-time selection separately).
 */
export function loadOuterHostManifestsFromRepo(
  repoRoot: string = defaultRepoRoot,
): OuterHostManifest[] {
  const hostsDir = path.join(repoRoot, "hosts");
  if (!fs.existsSync(hostsDir)) return [];
  const out: OuterHostManifest[] = [];
  for (const ent of fs.readdirSync(hostsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith("_") || ent.name.startsWith(".")) continue;
    const manifestPath = path.join(hostsDir, ent.name, "outer-host.manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = loadOuterHostManifestFile(manifestPath);
    if (manifest.id !== ent.name) {
      throw new Error(
        `outer-host manifest id "${manifest.id}" does not match directory "${ent.name}" (${manifestPath})`,
      );
    }
    out.push(manifest);
  }
  return out;
}

/**
 * Built-in manifests shipped under core/scripts/outer-hosts/builtins/.
 * Used when hosts/ is absent (installed skill tree only ships core/).
 */
export function loadBuiltinOuterHostManifests(): OuterHostManifest[] {
  const dir = path.join(here, "builtins");
  if (!fs.existsSync(dir)) return [];
  const out: OuterHostManifest[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    out.push(loadOuterHostManifestFile(path.join(dir, ent.name)));
  }
  return out;
}

/**
 * Prefer co-located hosts/<id> manifests (dev clone / installer source);
 * fall back to core-shipped builtins for installed skill layouts.
 */
export function loadOuterHostManifestsPreferHosts(
  repoRoot: string = defaultRepoRoot,
): OuterHostManifest[] {
  const fromHosts = loadOuterHostManifestsFromRepo(repoRoot);
  if (fromHosts.length > 0) return fromHosts;
  return loadBuiltinOuterHostManifests();
}

/** Absolute path to a host's co-located manifest under repoRoot. */
export function outerHostManifestPath(
  hostId: string,
  repoRoot: string = defaultRepoRoot,
): string {
  return path.join(repoRoot, outerHostManifestRelativePath(hostId));
}
