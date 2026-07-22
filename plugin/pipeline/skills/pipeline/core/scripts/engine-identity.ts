// Engine identity (#450): the version + template fingerprint a run is pinned
// to, and a best-effort probe of the current on-disk identity so mid-run
// drift (an update landing under a live run) is detectable and attributable.
//
// Two distinct reads, deliberately kept separate:
//  - resolvePinnedEngineIdentity() reads the version from disk once but takes
//    its template fingerprint from the ALREADY-PINNED in-memory snapshot
//    (prompts/index.ts) — no template file is read here.
//  - probeEngineIdentity() re-reads BOTH the version and the templates fresh
//    from disk every call, independent of the pinned snapshot, so it reflects
//    whatever an update has just written underneath the running process.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getTemplateSnapshot, type TemplateSnapshot } from "./prompts/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url)); // core/scripts
const engineRoot = path.dirname(here); // core/
const promptsDir = path.join(here, "prompts");

export interface EngineIdentity {
  version: string;
  root: string;
  templates_fingerprint: string;
}

/** Hash sorted `name:sha256(content)` pairs into one stable value. Content-
 *  sensitive and enumeration-order-independent by construction (sorted keys). */
export function templatesFingerprint(snapshot: TemplateSnapshot): string {
  const names = Object.keys(snapshot).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    const contentHash = createHash("sha256").update(snapshot[name], "utf8").digest("hex");
    hash.update(`${name}:${contentHash}\n`);
  }
  return hash.digest("hex");
}

/** Read `version` from `<root>/package.json`, or null on any failure. */
export function readEngineVersion(root: string = engineRoot): string | null {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Resolve the identity of the engine pinned for this process, from the
 *  already-pinned template snapshot. Returns null when the version cannot be
 *  resolved (missing/malformed package.json) — callers omit the identity
 *  rather than fail the run. */
export function resolvePinnedEngineIdentity(): EngineIdentity | null {
  const version = readEngineVersion();
  if (version === null) return null;
  return { version, root: engineRoot, templates_fingerprint: templatesFingerprint(getTemplateSnapshot()) };
}

/** Injectable seam for `probeEngineIdentity` — both members do a real
 *  filesystem read by default; unit tests replace them with fakes. */
export interface DriftProbeDeps {
  readVersion: () => string | null;
  readTemplatesFromDisk: () => TemplateSnapshot;
}

function readTemplatesFromDiskDefault(): TemplateSnapshot {
  const snapshot: TemplateSnapshot = {};
  for (const entry of fs.readdirSync(promptsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = entry.name.slice(0, -".md".length);
      snapshot[name] = fs.readFileSync(path.join(promptsDir, entry.name), "utf8");
    }
  }
  return snapshot;
}

export const defaultDriftProbeDeps: DriftProbeDeps = {
  readVersion: () => readEngineVersion(),
  readTemplatesFromDisk: readTemplatesFromDiskDefault,
};

/** Re-read the on-disk engine version and template set fresh (bypassing the
 *  pinned snapshot) and return the resulting identity. Advisory: any throw
 *  (unreadable files, unparseable package.json) is swallowed and yields null
 *  rather than propagating — a failed probe must never affect a stage outcome. */
export function probeEngineIdentity(deps: DriftProbeDeps = defaultDriftProbeDeps): EngineIdentity | null {
  try {
    const version = deps.readVersion();
    if (version === null) return null;
    const snapshot = deps.readTemplatesFromDisk();
    return { version, root: engineRoot, templates_fingerprint: templatesFingerprint(snapshot) };
  } catch {
    return null;
  }
}

/** Pure decision, no I/O: does a freshly-probed identity count as a NEW drift
 *  transition relative to the last-observed identity (which starts equal to
 *  the pinned identity, before any observation)? Comparing against
 *  last-observed — not the pinned identity — on every call is what makes a
 *  single update produce exactly one `engine_drift` event across many
 *  subsequent stage boundaries that observe the same (now-current) identity. */
export function isEngineDriftTransition(lastObserved: EngineIdentity, observed: EngineIdentity): boolean {
  return observed.version !== lastObserved.version || observed.templates_fingerprint !== lastObserved.templates_fingerprint;
}
