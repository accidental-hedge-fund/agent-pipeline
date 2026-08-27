// Host install discovery for `pipeline path [--json]`.
//
// Probes known install locations for the pipeline core and whether the
// `claude` / `codex` host CLIs are reachable, then derives a four-state
// hostCoverage value that Pipeline Desk (or any integrator) can act on
// without parsing prose output.
//
// #784: completeness-oriented host listing comes from the outer-host registry
// (or an injectable list). Legacy `hostCoverage` remains Claude/Codex-only.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ensureBuiltinOuterHostsRegistered,
  registeredOuterHostIds,
  resolveOuterHost as resolveOuterHostDefault,
} from "./outer-hosts/index.ts";
import type {
  OuterHostDiscoveryProbeSpec,
  OuterHostManifest,
} from "./outer-hosts/types.ts";

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

/** Additive OMP host entry (#1235). `available` means a managed skill
 *  install is present. Does not affect `hostCoverage`. */
export type OmpHostEntry = HostEntry & {
  skillPath: string | null;
};

/** Generic registry-driven host entry for completeness listings (#784). */
export type RegistryHostEntry = HostEntry & {
  /** When known (e.g. managed skill install path). */
  skillPath?: string | null;
  /** Outer-host display name when known. */
  displayName?: string;
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
    /** Additive OMP reporting — never changes hostCoverage meanings. */
    omp: OmpHostEntry;
    /**
     * Index signature for registry-registered hosts beyond the legacy trio.
     * Completeness listings iterate registry ids; synthetic hosts appear here
     * in tests without editing a built-in-only name table.
     */
    [hostId: string]: HostEntry | OpenCodeHostEntry | OmpHostEntry | RegistryHostEntry;
  };
  /**
   * Ordered outer-host ids from the runtime registry (completeness source).
   * Additive (#784) — does not replace hostCoverage.
   */
  registeredOuterHosts?: string[];
};

/** IO seam for unit tests — override probes without touching the filesystem. */
export type DiscoverHostsDeps = {
  which: (cmd: string) => Promise<string | null>;
  probeCandidates: () => Promise<string | null>;
  readVersion: (corePath: string) => Promise<string | null>;
  /** Optional seam for OpenCode skill path probe (#861). */
  probeOpenCodeSkill?: () => Promise<string | null>;
  /** Optional seam for OMP skill path probe (#1235). */
  probeOmpSkill?: () => Promise<string | null>;
  /**
   * Optional seam for registry-driven host id enumeration (#784).
   * Defaults to the outer-host runtime registry.
   */
  listOuterHostIds?: () => string[];
  /**
   * Resolve an outer-host manifest for manifest-driven discovery probes (#784).
   * Defaults to the outer-host runtime registry.
   */
  resolveOuterHost?: (id: string) => OuterHostManifest | null;
  /**
   * True when a skill path exists as a directory or symlink (including a
   * dangling symlink — matches `test -L || test -d`). Injectable for tests.
   */
  skillPathPresent?: (absPath: string) => boolean;
  /** Home directory for install base-path resolution. Defaults to os.homedir(). */
  homeDir?: () => string;
  /** Env lookup for install.basePath.env overrides. Defaults to process.env. */
  envGet?: (key: string) => string | undefined;
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
  // OMP skill tree (#1235) — additive candidate only; does not affect hostCoverage.
  candidates.push(path.join(home, ".omp", "agent", "skills", "pipeline", "core"));
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

/**
 * Probe for an OMP-managed skill install. Returns the skill directory when
 * present (managed marker or launcher), else null. Additive for discovery only.
 * No env override — always ~/.omp/agent.
 */
async function probeOmpSkillDefault(): Promise<string | null> {
  const home = os.homedir();
  const skillDir = path.join(home, ".omp", "agent", "skills", "pipeline");
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

/** True when path is a directory or symlink (dangling symlink counts). */
export function skillPathPresentDefault(absPath: string): boolean {
  try {
    const st = fs.lstatSync(absPath);
    return st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve the managed skill install path from a host's install profile.
 * Mirrors install.mjs base-path resolution (env override → defaultHomeSegments
 * → alternateHomeSegments when primary is absent). Prefers the first candidate
 * whose skill path (or base) is present so a valid alternate-path install
 * (e.g. Codex `~/.agents/skills/pipeline`) is not reported unavailable.
 * Pure aside from home/env/exists seams.
 */
export function resolveManifestSkillPath(
  manifest: OuterHostManifest,
  deps: {
    homeDir: () => string;
    envGet: (key: string) => string | undefined;
    /**
     * True when a path exists as a directory or symlink. Defaults to
     * skillPathPresentDefault. Used for primary-vs-alternate base selection.
     */
    pathPresent?: (absPath: string) => boolean;
  },
): string {
  const bp = manifest.install.basePath;
  const skillTail = [
    ...(manifest.install.skillsRelative ?? []),
    manifest.install.skillDirName ?? "pipeline",
  ];
  const pathPresent = deps.pathPresent ?? skillPathPresentDefault;
  const skillUnder = (base: string) => path.join(base, ...skillTail);

  const envKey = typeof bp.env === "string" ? bp.env.trim() : "";
  const envVal = envKey ? deps.envGet(envKey)?.trim() : "";
  if (envVal) {
    return skillUnder(path.resolve(envVal));
  }

  const primaryBase = path.join(deps.homeDir(), ...bp.defaultHomeSegments);
  const bases: string[] = [primaryBase];
  const alt = bp.alternateHomeSegments;
  if (Array.isArray(alt) && alt.length > 0) {
    bases.push(path.join(deps.homeDir(), ...alt));
  }

  // Prefer the first candidate whose skill install is present (valid alternate
  // install must not false-negative when primary base is missing).
  for (const base of bases) {
    const skill = skillUnder(base);
    if (pathPresent(skill)) return skill;
  }
  // Mirror install.mjs: first existing base wins when no skill is present yet.
  for (const base of bases) {
    if (pathPresent(base)) return skillUnder(base);
  }
  return skillUnder(primaryBase);
}

/** Normalize a manifest discovery probe (defaults whichCommand to host id). */
export function normalizeDiscoveryProbe(
  hostId: string,
  discovery: OuterHostDiscoveryProbeSpec | undefined | null,
): OuterHostDiscoveryProbeSpec {
  if (!discovery || typeof discovery !== "object") {
    // Fail closed for unknown shapes: skill_path-only would false-negative CLI
    // hosts; which-only false-negatives Grok. Prefer skill_path when the
    // install profile exists (extensions often ship skill trees without a
    // same-named CLI). Callers without a probe still get skill_path.
    return { kind: "skill_path" };
  }
  const kind = discovery.kind;
  if (kind === "which" || kind === "which_or_skill_path") {
    return {
      kind,
      whichCommand:
        typeof discovery.whichCommand === "string" && discovery.whichCommand.trim()
          ? discovery.whichCommand.trim()
          : hostId,
    };
  }
  return { kind: "skill_path" };
}

const defaultDeps: DiscoverHostsDeps = {
  which: whichDefault,
  probeCandidates: probeCandidatesDefault,
  readVersion: readVersionDefault,
  probeOpenCodeSkill: probeOpenCodeSkillDefault,
  probeOmpSkill: probeOmpSkillDefault,
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
 * - `hostCoverage` remains Claude/Codex-only; OpenCode and OMP are additive
 *   under `hosts.opencode` / `hosts.omp` and never flip coverage enum
 *   meanings (#861 / #1235).
 */
export async function discoverHosts(
  deps: DiscoverHostsDeps = defaultDeps,
): Promise<DiscoveryResult> {
  const probeOpenCode = deps.probeOpenCodeSkill ?? (async () => null);
  const probeOmp = deps.probeOmpSkill ?? (async () => null);
  const listIds =
    deps.listOuterHostIds ??
    (() => {
      ensureBuiltinOuterHostsRegistered();
      return registeredOuterHostIds();
    });
  const resolveHost =
    deps.resolveOuterHost ??
    ((id: string) => {
      ensureBuiltinOuterHostsRegistered();
      return resolveOuterHostDefault(id);
    });
  const skillPresent = deps.skillPathPresent ?? skillPathPresentDefault;
  const homeDir = deps.homeDir ?? (() => os.homedir());
  const envGet = deps.envGet ?? ((key: string) => process.env[key]);
  const pathDeps = { homeDir, envGet };

  const [corePath, claudeBin, codexBin, opencodeBin, opencodeSkill, ompSkill] = await Promise.all([
    deps.probeCandidates(),
    deps.which("claude"),
    deps.which("codex"),
    deps.which("opencode"),
    probeOpenCode(),
    probeOmp(),
  ]);

  const version = corePath ? await deps.readVersion(corePath) : null;

  const claudeAvailable = claudeBin !== null;
  const codexAvailable = codexBin !== null;

  let hostCoverage: HostCoverage;
  if (!corePath || (!claudeAvailable && !codexAvailable)) {
    // No resolved pipeline core, or no host CLIs reachable — not usable.
    // OpenCode/OMP presence alone does not change this Claude/Codex contract (#861/#1235).
    hostCoverage = "missing";
  } else if (claudeAvailable && !codexAvailable) {
    hostCoverage = "claude-only";
  } else if (!claudeAvailable && codexAvailable) {
    hostCoverage = "codex-only";
  } else {
    hostCoverage = "both";
  }

  const hosts: DiscoveryResult["hosts"] = {
    claude: { available: claudeAvailable, cliBin: claudeBin },
    codex: { available: codexAvailable, cliBin: codexBin },
    opencode: {
      available: opencodeSkill !== null,
      cliBin: opencodeBin,
      skillPath: opencodeSkill,
    },
    omp: {
      available: ompSkill !== null,
      cliBin: null,
      skillPath: ompSkill,
    },
  };

  // Registry-driven completeness: every registered outer host appears under
  // hosts (additive entries for ids beyond the legacy trio). Synthetic hosts
  // in tests inject via listOuterHostIds without editing built-in modules.
  // Availability is resolved from the manifest's typed discovery probe — never
  // assumed to be `which <host-id>` (#784 / Grok skill-path install).
  const registeredOuterHosts = listIds();
  for (const id of registeredOuterHosts) {
    if (hosts[id]) continue;
    const manifest = resolveHost(id);
    if (!manifest) {
      // No manifest: do not invent availability from a same-named CLI.
      hosts[id] = {
        available: false,
        cliBin: null,
        skillPath: null,
      };
      continue;
    }

    const probe = normalizeDiscoveryProbe(id, manifest.invocation?.discovery);
    const skillAbs = resolveManifestSkillPath(manifest, {
      ...pathDeps,
      pathPresent: skillPresent,
    });
    const skillOk = skillPresent(skillAbs);
    const skillPath = skillOk ? skillAbs : null;

    let cliBin: string | null = null;
    if (probe.kind === "which" || probe.kind === "which_or_skill_path") {
      const cmd = probe.whichCommand ?? id;
      cliBin = await deps.which(cmd);
    }

    let available: boolean;
    if (probe.kind === "which") {
      available = cliBin !== null;
    } else if (probe.kind === "skill_path") {
      available = skillOk;
    } else {
      // which_or_skill_path
      available = cliBin !== null || skillOk;
    }

    hosts[id] = {
      available,
      cliBin,
      skillPath,
      displayName: manifest.displayName,
    };
  }

  return {
    corePath,
    version,
    hostCoverage,
    hosts,
    registeredOuterHosts,
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
    const oc = result.hosts.opencode as OpenCodeHostEntry;
    const detail = oc.available
      ? `yes${oc.skillPath ? ` (${oc.skillPath})` : ""}${oc.cliBin ? ` cli=${oc.cliBin}` : ""}`
      : "no";
    lines.push(`  opencode: ${detail}`);
  }
  if (result.hosts.omp) {
    const omp = result.hosts.omp as OmpHostEntry;
    const detail = omp.available
      ? `yes${omp.skillPath ? ` (${omp.skillPath})` : ""}`
      : "no";
    lines.push(`  omp: ${detail}`);
  }
  // Registry-driven extras (#784) beyond Claude/Codex/OpenCode/OMP lines.
  const printed = new Set(["claude", "codex", "opencode", "omp"]);
  for (const id of result.registeredOuterHosts ?? Object.keys(result.hosts)) {
    if (printed.has(id)) continue;
    const entry = result.hosts[id];
    if (!entry) continue;
    const skill =
      "skillPath" in entry && entry.skillPath ? ` (${entry.skillPath})` : "";
    lines.push(
      `  ${id}: ${entry.available ? `yes${skill}${entry.cliBin ? ` cli=${entry.cliBin}` : ""}` : "no"}`,
    );
  }
  return lines.join("\n");
}
