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
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HostEntry = {
  available: boolean;
  cliBin: string | null;
};

/** Additive OpenCode host entry (#861). `available` means a managed skill
 *  install is present; `cliBin` is optional CLI reachability. Does not affect
 *  `hostCoverage` (Claude/Codex-only enum). */
export type OpenCodeHostEntry = HostEntry & {
  skillPath: string | null;
};

export type HostCoverage = "missing" | "claude-only" | "codex-only" | "both";

export type DiscoveryResult = {
  corePath: string | null;
  version: string | null;
  hostCoverage: HostCoverage;
  hosts: {
    claude: HostEntry;
    codex: HostEntry;
    /** Additive OpenCode reporting — never changes hostCoverage meanings. */
    opencode: OpenCodeHostEntry;
  };
};

/** IO seam for unit tests — override probes without touching the filesystem. */
export type DiscoverHostsDeps = {
  which: (cmd: string) => Promise<string | null>;
  probeCandidates: () => Promise<string | null>;
  readVersion: (corePath: string) => Promise<string | null>;
  /** Optional seam for OpenCode skill path probe (#861). */
  probeOpenCodeSkill?: () => Promise<string | null>;
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
 * null if no candidate resolves. Throws on a hard probe error (e.g., `npm`
 * binary not found on PATH) so the CLI layer can exit non-zero with a
 * diagnostic.
 *
 * Order:
 *   1. Current core (this file's parent's parent — always the running install)
 *   2. npm global root (`npm root -g`): agent-pipeline, then pipeline
 *   3. ~/.claude/skills/pipeline/core
 *   4. ~/.codex/skills/pipeline/core
 *   5. ./node_modules/{agent-pipeline,pipeline}/core (local dev)
 */
async function probeCandidatesDefault(): Promise<string | null> {
  const home = os.homedir();

  // Probe 1: the core that contains THIS file — always correct regardless of
  // install method (skill dir, npm global, local dev clone, plugin marketplace).
  const selfCore = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (fs.existsSync(path.join(selfCore, "scripts", "pipeline.ts"))) {
    return selfCore;
  }

  // npm global root: `npm root -g` → "<prefix>/lib/node_modules"
  // Throws when `npm` is not on PATH at all (ENOENT) so the caller can exit
  // non-zero. Other npm errors (non-zero exit, empty output) are treated as
  // "no npm global root" — not a hard failure.
  const npmRoot = await (async () => {
    try {
      const { stdout } = await execFileAsync("npm", ["root", "-g"], { encoding: "utf8" });
      const r = stdout.trim();
      return r.length > 0 ? r : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("install-location probe failed: `npm` is not on PATH");
      }
      return null;
    }
  })();

  const candidates: string[] = [];
  if (npmRoot) {
    candidates.push(path.join(npmRoot, "agent-pipeline", "core")); // npm global: agent-pipeline
    candidates.push(path.join(npmRoot, "pipeline", "core"));       // npm global: legacy name
  }
  candidates.push(path.join(home, ".claude", "skills", "pipeline", "core"));
  candidates.push(path.join(home, ".codex", "skills", "pipeline", "core"));
  // OpenCode skill tree (#861) — additive candidate only; does not affect hostCoverage.
  const opencodeBase = process.env.OPENCODE_CONFIG_DIR?.trim()
    ? process.env.OPENCODE_CONFIG_DIR.trim()
    : path.join(home, ".config", "opencode");
  candidates.push(path.join(opencodeBase, "skills", "pipeline", "core"));
  candidates.push(path.join(".", "node_modules", "agent-pipeline", "core")); // local dev
  candidates.push(path.join(".", "node_modules", "pipeline", "core"));       // local dev legacy

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "scripts", "pipeline.ts"))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Probe for an OpenCode-managed skill install. Returns the skill directory when
 * present (managed marker or launcher), else null. Additive for discovery only.
 */
async function probeOpenCodeSkillDefault(): Promise<string | null> {
  const home = os.homedir();
  const base = process.env.OPENCODE_CONFIG_DIR?.trim()
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR.trim())
    : path.join(home, ".config", "opencode");
  const skillDir = path.join(base, "skills", "pipeline");
  const marker = path.join(skillDir, ".pipeline-installer-managed");
  const launcher = path.join(skillDir, "scripts", "pipeline.mjs");
  if (fs.existsSync(marker) || fs.existsSync(launcher)) {
    return skillDir;
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
  probeOpenCodeSkill: probeOpenCodeSkillDefault,
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
 * - `hostCoverage` remains Claude/Codex-only; OpenCode is additive under
 *   `hosts.opencode` and never flips coverage enum meanings (#861).
 */
export async function discoverHosts(
  deps: DiscoverHostsDeps = defaultDeps,
): Promise<DiscoveryResult> {
  const probeOpenCode = deps.probeOpenCodeSkill ?? (async () => null);
  const [corePath, claudeBin, codexBin, opencodeBin, opencodeSkill] = await Promise.all([
    deps.probeCandidates(),
    deps.which("claude"),
    deps.which("codex"),
    deps.which("opencode"),
    probeOpenCode(),
  ]);

  const version = corePath ? await deps.readVersion(corePath) : null;

  const claudeAvailable = claudeBin !== null;
  const codexAvailable = codexBin !== null;

  let hostCoverage: HostCoverage;
  if (!corePath || (!claudeAvailable && !codexAvailable)) {
    // No resolved pipeline core, or no host CLIs reachable — not usable.
    // OpenCode presence alone does not change this Claude/Codex contract (#861).
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
      opencode: {
        available: opencodeSkill !== null,
        cliBin: opencodeBin,
        skillPath: opencodeSkill,
      },
    },
  };
}

/** Render a {@link DiscoveryResult} for the `pipeline path` subcommand. Pure and
 *  dependency-free so it can be shared by the full CLI (`handlePathSubcommand`)
 *  and the minimal dep-free discovery entry (`path-cli.ts`) the launcher runs
 *  when `core/node_modules` is absent — keeping a single source for the output
 *  shape so the two paths cannot drift (#153). */
export function formatDiscovery(result: DiscoveryResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const lines = [
    `core path: ${result.corePath ?? "(not found)"}`,
    `version:   ${result.version ?? "(unknown)"}`,
    `coverage:  ${result.hostCoverage}`,
    `  claude:  ${result.hosts.claude.available ? `yes (${result.hosts.claude.cliBin})` : "no"}`,
    `  codex:   ${result.hosts.codex.available ? `yes (${result.hosts.codex.cliBin})` : "no"}`,
  ];
  // Additive OpenCode line (#861) — never part of hostCoverage.
  if (result.hosts.opencode) {
    const oc = result.hosts.opencode;
    const detail = oc.available
      ? `yes${oc.skillPath ? ` (${oc.skillPath})` : ""}${oc.cliBin ? ` cli=${oc.cliBin}` : ""}`
      : "no";
    lines.push(`  opencode: ${detail}`);
  }
  return lines.join("\n");
}
