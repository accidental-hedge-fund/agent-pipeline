// Host install discovery for `pipeline path [--json]`.
//
// Probes known install locations for the pipeline core and whether the
// `claude` / `codex` host CLIs are reachable, then derives a four-state
// hostCoverage value that Pipeline Desk (or any integrator) can act on
// without parsing prose output.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HostEntry = {
  available: boolean;
  cliBin: string | null;
};

export type HostCoverage = "missing" | "claude-only" | "codex-only" | "both";

export type DiscoveryResult = {
  corePath: string | null;
  version: string | null;
  hostCoverage: HostCoverage;
  hosts: {
    claude: HostEntry;
    codex: HostEntry;
  };
};

/** IO seam for unit tests — override probes without touching the filesystem. */
export type DiscoverHostsDeps = {
  which: (cmd: string) => Promise<string | null>;
  probeCandidates: () => Promise<string | null>;
  readVersion: (corePath: string) => Promise<string | null>;
};

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

/** Run `which <cmd>` and return the resolved path, or null if not found. */
async function whichDefault(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [cmd], { encoding: "utf8" });
    const p = stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Probe candidate install locations in priority order and return the first
 * directory that contains `scripts/pipeline.ts` (the pipeline core). Returns
 * null if no candidate resolves.
 *
 * Order:
 *   1. npm global root (`npm root -g`)
 *   2. ~/.claude/skills/pipeline/core
 *   3. ~/.codex/skills/pipeline/core
 *   4. ./node_modules/pipeline/core (local dev)
 */
async function probeCandidatesDefault(): Promise<string | null> {
  const home = os.homedir();

  // npm global root: `npm root -g` → "<prefix>/lib/node_modules"
  const npmRoot = await (async () => {
    try {
      const { stdout } = await execFileAsync("npm", ["root", "-g"], { encoding: "utf8" });
      const r = stdout.trim();
      return r.length > 0 ? r : null;
    } catch {
      return null;
    }
  })();

  const candidates: string[] = [];
  if (npmRoot) candidates.push(path.join(npmRoot, "pipeline", "core"));
  candidates.push(path.join(home, ".claude", "skills", "pipeline", "core"));
  candidates.push(path.join(home, ".codex", "skills", "pipeline", "core"));
  candidates.push(path.join(".", "node_modules", "pipeline", "core"));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "scripts", "pipeline.ts"))) {
      return candidate;
    }
  }
  return null;
}

/** Read `version` from `<corePath>/package.json`, or null on any error. */
async function readVersionDefault(corePath: string): Promise<string | null> {
  try {
    const pkgPath = path.join(corePath, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

const defaultDeps: DiscoverHostsDeps = {
  which: whichDefault,
  probeCandidates: probeCandidatesDefault,
  readVersion: readVersionDefault,
};

// ---------------------------------------------------------------------------
// discoverHosts
// ---------------------------------------------------------------------------

/**
 * Probe known install locations and host CLIs, then return a DiscoveryResult.
 *
 * - Exits with code 0 for any resolved state (including `missing`).
 * - Throws on a probe error (e.g., `npm root -g` unavailable) so the CLI
 *   layer can exit non-zero with a diagnostic.
 */
export async function discoverHosts(
  deps: DiscoverHostsDeps = defaultDeps,
): Promise<DiscoveryResult> {
  const [corePath, claudeBin, codexBin] = await Promise.all([
    deps.probeCandidates(),
    deps.which("claude"),
    deps.which("codex"),
  ]);

  const version = corePath ? await deps.readVersion(corePath) : null;

  const claudeAvailable = claudeBin !== null;
  const codexAvailable = codexBin !== null;

  let hostCoverage: HostCoverage;
  if (!claudeAvailable && !codexAvailable) {
    hostCoverage = "missing";
  } else if (claudeAvailable && !codexAvailable) {
    hostCoverage = "claude-only";
  } else if (!claudeAvailable && codexAvailable) {
    hostCoverage = "codex-only";
  } else {
    hostCoverage = "both";
  }

  return {
    corePath,
    version,
    hostCoverage,
    hosts: {
      claude: { available: claudeAvailable, cliBin: claudeBin },
      codex: { available: codexAvailable, cliBin: codexBin },
    },
  };
}
