// Self-host engine promote (factory simplification Phase 4).
//
// After a release is published (tag + GitHub Release), promote the production
// engine pin, install that exact tag into the host skill tree(s), and verify
// pin ↔ install receipt agreement. On install/verify failure after a pin
// mutation, roll the pin back and attempt to reinstall the previous tag.
//
// Never merges PRs or creates tags. Loop-isolated CLI surface.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isProductionQualityPin,
  promoteProductionPin,
  resolveProductionPin,
  rollbackProductionPin,
  type ProductionEnginePin,
  type PromotePinResult,
} from "../production-engine-pin.ts";
import { readSkipFrgFromPipelineYml } from "../config.ts";
import { formatFrgSkipReason, resolveFrgSkip } from "../frg-skip.ts";

const execFileAsync = promisify(execFile);

export type EnginePromoteHost = "codex" | "claude" | "grok" | "opencode" | "all";

/** Default install host when promote omits --host / host option (#989). */
export const DEFAULT_ENGINE_PROMOTE_HOST: EnginePromoteHost = "all";

export interface EnginePromoteOpts {
  /** Semver X.Y.Z (with or without leading v). */
  version: string;
  repoDir: string;
  /** Host(s) for install.mjs --host (default all — every configured outer host). */
  host?: EnginePromoteHost;
  dryRun?: boolean;
  /** Skip promote when pin already at target version. Default true. */
  skipPromoteIfCurrent?: boolean;
  /** Skip the install step (pin-only). Default false. */
  skipInstall?: boolean;
  /**
   * Explicit skip escape: write a non-production-quality pin
   * (`no-frg-<version>` + null evidence). Default false.
   */
  allowWithoutFrg?: boolean;
  gitSha?: string | null;
  /** Absolute pin path override (AGENT_PIPELINE_PRODUCTION_PIN). */
  pinPath?: string | null;
}

export interface EnginePromoteResult {
  schema_version: 1;
  kind: "engine_promote";
  version: string;
  tag: string;
  dry_run: boolean;
  release_verified: boolean;
  pin_promoted: boolean;
  pin_path: string | null;
  pin: ProductionEnginePin | null;
  install_ran: boolean;
  install_command: string;
  verified: boolean;
  rolled_back: boolean;
  reinstall_hint: string | null;
  steps: string[];
  error?: string;
}

export interface EnginePromoteDeps {
  log(msg: string): void;
  /** True when GitHub has a non-draft release for tag. */
  verifyPublishedRelease(tag: string): Promise<{ ok: true } | { ok: false; error: string }>;
  promote(opts: {
    repoDir: string;
    version: string;
    gitSha?: string | null;
    overridePath?: string | null;
    allowWithoutFrg?: boolean;
  }): Promise<PromotePinResult>;
  rollback(opts: {
    repoDir: string;
    overridePath?: string | null;
  }): Promise<PromotePinResult>;
  loadPin(opts: {
    repoDir: string;
    overridePath?: string | null;
  }): Promise<
    | { kind: "ok"; pin: ProductionEnginePin; path: string }
    | { kind: "missing"; path: string }
    | { kind: string; path?: string; detail?: string }
  >;
  /** Run installer for tag; throw on non-zero. */
  installFromTag(tag: string, host: EnginePromoteHost): Promise<{ command: string; stdout: string }>;
  /** Read installed pipeline --version (semver without v). */
  installedVersion(): Promise<string | null>;
  /**
   * Optional gh-free `skip_frg` read. When omitted, the command reads
   * `.github/pipeline.yml` via {@link readSkipFrgFromPipelineYml}.
   */
  readSkipFrg?: () => boolean | undefined;
}

function normalizeVersion(raw: string): string {
  const v = String(raw ?? "").trim().replace(/^[vV]/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) {
    throw new Error(`invalid version ${JSON.stringify(raw)} — expected X.Y.Z`);
  }
  return v;
}

export function tagForVersion(version: string): string {
  return `v${normalizeVersion(version)}`;
}

export function startingLockPidFromEnv(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) ? pid : null;
}

export function installArgsForTag(
  tag: string,
  host: EnginePromoteHost,
  startingLockPid: number | null = null,
): string[] {
  const args = [
    "-y",
    `github:accidental-hedge-fund/agent-pipeline#${tag}`,
    "install",
    "--host",
    host,
    "--yes-deps",
  ];
  if (startingLockPid !== null) {
    if (!Number.isSafeInteger(startingLockPid) || startingLockPid <= 0) {
      throw new Error("starting lock PID must be a safe positive integer");
    }
    args.push("--internal-starting-lock-pid", String(startingLockPid));
  }
  return args;
}

export function installCommandForTag(
  tag: string,
  host: EnginePromoteHost,
  startingLockPid: number | null = null,
): string {
  return `npx ${installArgsForTag(tag, host, startingLockPid).join(" ")}`;
}

export async function runEnginePromote(
  opts: EnginePromoteOpts,
  deps: EnginePromoteDeps,
): Promise<EnginePromoteResult> {
  const version = normalizeVersion(opts.version);
  const tag = tagForVersion(version);
  const host = opts.host ?? DEFAULT_ENGINE_PROMOTE_HOST;
  const dryRun = !!opts.dryRun;
  const skipPromoteIfCurrent = opts.skipPromoteIfCurrent !== false;
  const skipInstall = !!opts.skipInstall;
  const configSkip = deps.readSkipFrg
    ? deps.readSkipFrg()
    : readSkipFrgFromPipelineYml(opts.repoDir);
  const frgSkip = resolveFrgSkip({
    cliSkip: !!opts.allowWithoutFrg,
    configSkip,
  });
  const allowWithoutFrg = frgSkip.skip;
  const steps: string[] = [];
  const startingLockPid = startingLockPidFromEnv(process.env.PIPELINE_STARTING_LOCK_PID);
  const installCmd = installCommandForTag(tag, host, startingLockPid);
  if (frgSkip.source) {
    deps.log(
      `[engine-promote] skipping Factory Reliability Gate for ${version} (${formatFrgSkipReason(frgSkip.source)})`,
    );
  }

  const base: EnginePromoteResult = {
    schema_version: 1,
    kind: "engine_promote",
    version,
    tag,
    dry_run: dryRun,
    release_verified: false,
    pin_promoted: false,
    pin_path: null,
    pin: null,
    install_ran: false,
    install_command: installCmd,
    verified: false,
    rolled_back: false,
    reinstall_hint: null,
    steps,
  };

  // 1) Published release
  deps.log(`[engine-promote] verifying GitHub Release ${tag}…`);
  const rel = await deps.verifyPublishedRelease(tag);
  if (!rel.ok) {
    return { ...base, error: rel.error, steps: [...steps, `release_verify_failed: ${rel.error}`] };
  }
  steps.push(`release_verified: ${tag}`);
  base.release_verified = true;

  // 2) Promote pin (unless already current)
  const pinLoad = await deps.loadPin({
    repoDir: opts.repoDir,
    overridePath: opts.pinPath,
  });
  // Same version+tag is already-current only for a production-quality pin,
  // or when the resolved skip is active. A no-frg-* / null-evidence pin
  // must re-enter promote (real FRG) or refuse — never succeed as current.
  let alreadyPinned =
    pinLoad.kind === "ok" &&
    pinLoad.pin.version === version &&
    pinLoad.pin.tag === tag &&
    (allowWithoutFrg || isProductionQualityPin(pinLoad.pin));

  if (alreadyPinned && skipPromoteIfCurrent) {
    steps.push(`pin_already_current: ${version}`);
    base.pin = pinLoad.kind === "ok" ? pinLoad.pin : null;
    base.pin_path = pinLoad.kind === "ok" ? pinLoad.path : null;
    deps.log(`[engine-promote] production pin already at ${version}`);
  } else if (dryRun) {
    steps.push(`would_promote_pin: ${version}`);
    deps.log(`[engine-promote] dry-run: would promote pin to ${version}`);
  } else {
    deps.log(`[engine-promote] promoting production pin to ${version}…`);
    const promo = await deps.promote({
      repoDir: opts.repoDir,
      version,
      gitSha: opts.gitSha,
      overridePath: opts.pinPath,
      allowWithoutFrg,
    });
    if (!promo.ok) {
      return {
        ...base,
        error: promo.message,
        steps: [...steps, `promote_failed: ${promo.message}`],
        reinstall_hint: null,
      };
    }
    steps.push(`pin_promoted: ${promo.path}`);
    base.pin_promoted = true;
    base.pin = promo.pin;
    base.pin_path = promo.path;
    base.reinstall_hint = promo.reinstall_hint;
  }

  // 3) Install
  if (skipInstall) {
    steps.push("install_skipped");
    base.verified = alreadyPinned || base.pin_promoted;
    return base;
  }

  if (dryRun) {
    steps.push(`would_install: ${installCmd}`);
    deps.log(`[engine-promote] dry-run: would run: ${installCmd}`);
    return base;
  }

  deps.log(`[engine-promote] installing ${tag} (host=${host})…`);
  try {
    const inst = await deps.installFromTag(tag, host);
    steps.push(`install_ok: ${inst.command}`);
    base.install_ran = true;
  } catch (err) {
    const msg = (err as Error).message;
    steps.push(`install_failed: ${msg}`);
    deps.log(`[engine-promote] install failed: ${msg}`);
    // Rollback pin if we changed it
    if (base.pin_promoted) {
      deps.log(`[engine-promote] rolling back production pin…`);
      const rb = await deps.rollback({
        repoDir: opts.repoDir,
        overridePath: opts.pinPath,
      });
      if (rb.ok) {
        base.rolled_back = true;
        steps.push(`pin_rolled_back: ${rb.pin.version}`);
        base.pin = rb.pin;
        base.reinstall_hint = rb.reinstall_hint;
        try {
          await deps.installFromTag(rb.pin.tag, host);
          steps.push(`reinstall_previous_ok: ${rb.pin.tag}`);
        } catch (err2) {
          steps.push(`reinstall_previous_failed: ${(err2 as Error).message}`);
        }
      } else {
        steps.push(`pin_rollback_failed: ${rb.message}`);
      }
    }
    return { ...base, error: `install failed: ${msg}` };
  }

  // 4) Verify installed version matches
  const installed = await deps.installedVersion();
  if (installed && installed.replace(/^[vV]/, "") === version) {
    base.verified = true;
    steps.push(`verified_installed: ${installed}`);
    deps.log(`[engine-promote] verified installed version ${installed}`);
  } else {
    const msg =
      `installed version ${installed ?? "(unknown)"} does not match target ${version}`;
    steps.push(`verify_failed: ${msg}`);
    if (base.pin_promoted) {
      const rb = await deps.rollback({
        repoDir: opts.repoDir,
        overridePath: opts.pinPath,
      });
      if (rb.ok) {
        base.rolled_back = true;
        steps.push(`pin_rolled_back: ${rb.pin.version}`);
        base.reinstall_hint = rb.reinstall_hint;
        try {
          await deps.installFromTag(rb.pin.tag, host);
          steps.push(`reinstall_previous_ok: ${rb.pin.tag}`);
        } catch (err2) {
          steps.push(`reinstall_previous_failed: ${(err2 as Error).message}`);
        }
      }
    }
    return { ...base, error: msg };
  }

  return base;
}

export function realEnginePromoteDeps(repoDir: string): EnginePromoteDeps {
  return {
    log(msg) {
      console.error(msg);
    },
    async verifyPublishedRelease(tag) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["release", "view", tag, "--json", "isDraft,tagName"],
          { cwd: repoDir, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const data = JSON.parse(String(stdout)) as { isDraft?: boolean; tagName?: string };
        if (data.isDraft) {
          return { ok: false, error: `GitHub Release ${tag} is still a draft` };
        }
        if (data.tagName && data.tagName !== tag && data.tagName !== tag.replace(/^v/, "")) {
          // accept either form if gh normalizes
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error:
            `GitHub Release ${tag} not found or unreadable: ${(err as Error).message}. ` +
            `Publish the release (or wait for release.yml) before engine-promote.`,
        };
      }
    },
    async promote(opts) {
      return promoteProductionPin({
        repoDir: opts.repoDir,
        version: opts.version,
        gitSha: opts.gitSha,
        overridePath: opts.overridePath,
        allowWithoutFrg: opts.allowWithoutFrg,
      });
    },
    async rollback(opts) {
      return rollbackProductionPin({
        repoDir: opts.repoDir,
        overridePath: opts.overridePath,
      });
    },
    async loadPin(opts) {
      const { readFile } = await import("node:fs/promises");
      return resolveProductionPin({
        repoDir: opts.repoDir,
        overridePath: opts.overridePath,
        readTextFile: async (p) => {
          try {
            return await readFile(p, "utf8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
          }
        },
      });
    },
    async installFromTag(tag, host) {
      const startingLockPid = startingLockPidFromEnv(process.env.PIPELINE_STARTING_LOCK_PID);
      const cmd = installCommandForTag(tag, host, startingLockPid);
      // Use shell-free argv. The internal PID exemption names only this
      // launcher's validated reservation; unrelated live runs still block.
      const { stdout, stderr } = await execFileAsync(
        "npx",
        installArgsForTag(tag, host, startingLockPid),
        {
          cwd: repoDir,
          timeout: 600_000,
          maxBuffer: 50 * 1024 * 1024,
          env: process.env,
        },
      );
      return { command: cmd, stdout: String(stdout) + String(stderr) };
    },
    async installedVersion() {
      try {
        // Prefer the codex skill launcher when present
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
        const candidates = [
          process.env.PIPELINE?.split(/\s+/).filter(Boolean),
          home
            ? ["/usr/bin/node", `${home}/.codex/skills/pipeline/scripts/pipeline.mjs`]
            : null,
          ["pipeline"],
        ].filter(Boolean) as string[][];
        for (const argv of candidates) {
          try {
            const { stdout } = await execFileAsync(argv[0]!, [...argv.slice(1), "--version"], {
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
              env: process.env,
            });
            const line = String(stdout).trim().split(/\r?\n/)[0] ?? "";
            const m = line.match(/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/);
            if (m) return m[0];
          } catch {
            continue;
          }
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
