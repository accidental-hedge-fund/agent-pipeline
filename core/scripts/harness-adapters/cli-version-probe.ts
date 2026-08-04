// Once-per-run (per CLI identity) binary/version probe (#778 / #636 seam).
//
// Production invoke and preflight-on-invoke (#636) MUST consume this helper
// rather than each spawning an independent always-on per-call `--version`.
// Cache is keyed by the CLI command string (PATH name or absolute path).
// Probe failure leaves version/path unknown (null) — never fabricates values
// and never blocks the stage solely because the probe failed.

import type { AdapterPreflightDeps } from "./types.ts";

/** Result of a version/binary probe for one CLI identity. */
export interface CliVersionProbeResult {
  /** Parsed/trimmed version string, or null when unavailable. */
  cliVersion: string | null;
  /** Absolute path when resolution succeeds; null when unknown. */
  cliPath: string | null;
  /** True when the version exec reported ok. */
  probeOk: boolean;
}

/** Injectable I/O for the version probe (same shape as preflight deps). */
export type CliVersionProbeDeps = Pick<AdapterPreflightDeps, "exec"> & {
  /** Optional absolute-path resolution for a PATH command. */
  resolvePath?(command: string): Promise<string | null>;
};

const EMPTY: CliVersionProbeResult = {
  cliVersion: null,
  cliPath: null,
  probeOk: false,
};

/** Parse a typical CLI version line into a concise version string. */
export function parseCliVersionStdout(stdout: string): string | null {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  // Reject machine-readable capture / help dumps mistaken for --version output
  // (e.g. a test fake CLI that ignores argv and prints a telemetry fixture).
  if (line.startsWith("{") || line.startsWith("[")) return null;
  if (line.length > 240) return null;
  // Prefer "name X.Y.Z ..." → capture from first digit run through end of token.
  const token = line.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9._]+)?)/);
  if (token) return token[1];
  // Fall back to the whole first non-empty line only when it is short and
  // does not look like a JSONL telemetry event type tag.
  if (/^"?type"\s*:/.test(line) || line.includes('"session_id"')) return null;
  return line.length > 120 ? null : line;
}

/**
 * Create an isolated probe cache. Tests use this; production uses the
 * process-wide singleton via {@link probeCliVersionOnce}.
 */
export function createCliVersionProbeCache(): {
  get(command: string, deps: CliVersionProbeDeps): Promise<CliVersionProbeResult>;
  peek(command: string): CliVersionProbeResult | undefined;
  clear(): void;
  size(): number;
} {
  const cache = new Map<string, Promise<CliVersionProbeResult>>();
  const settled = new Map<string, CliVersionProbeResult>();

  return {
    async get(command: string, deps: CliVersionProbeDeps): Promise<CliVersionProbeResult> {
      const key = command.trim();
      if (!key) return { ...EMPTY };
      let pending = cache.get(key);
      if (!pending) {
        pending = runProbe(key, deps).then((result) => {
          settled.set(key, result);
          return result;
        });
        cache.set(key, pending);
      }
      return pending;
    },
    peek(command: string): CliVersionProbeResult | undefined {
      return settled.get(command.trim());
    },
    clear(): void {
      cache.clear();
      settled.clear();
    },
    size(): number {
      return cache.size;
    },
  };
}

async function runProbe(
  command: string,
  deps: CliVersionProbeDeps,
): Promise<CliVersionProbeResult> {
  let cliPath: string | null = null;
  if (command.startsWith("/")) {
    cliPath = command;
  } else if (deps.resolvePath) {
    try {
      cliPath = (await deps.resolvePath(command)) ?? null;
    } catch {
      cliPath = null;
    }
  }

  try {
    const res = await deps.exec(command, ["--version"]);
    if (!res.ok) {
      // Some CLIs only document `version` subcommand.
      const alt = await deps.exec(command, ["version"]).catch(() => ({
        ok: false,
        stdout: "",
        stderr: "",
      }));
      if (!alt.ok) {
        return { cliVersion: null, cliPath, probeOk: false };
      }
      return {
        cliVersion: parseCliVersionStdout(alt.stdout),
        cliPath,
        probeOk: true,
      };
    }
    return {
      cliVersion: parseCliVersionStdout(res.stdout),
      cliPath,
      probeOk: true,
    };
  } catch {
    return { cliVersion: null, cliPath, probeOk: false };
  }
}

/** Process-wide once-per-run cache shared by invoke and preflight surfaces. */
const globalCache = createCliVersionProbeCache();

/**
 * Probe (or return cached) CLI version for `command`. Safe to call on every
 * invoke — only the first call per command identity spawns a subprocess.
 */
export async function probeCliVersionOnce(
  command: string,
  deps: CliVersionProbeDeps,
): Promise<CliVersionProbeResult> {
  return globalCache.get(command, deps);
}

/** Test-only: clear the process-wide cache between cases. */
export function _clearCliVersionProbeCacheForTests(): void {
  globalCache.clear();
}

/** Test-only: peek a settled global-cache entry without probing. */
export function _peekCliVersionProbeForTests(command: string): CliVersionProbeResult | undefined {
  return globalCache.peek(command);
}

/**
 * Default resolvePath using `command -v` via the injectable exec seam.
 * Returns null when resolution fails.
 */
export async function resolveCommandPath(
  command: string,
  deps: Pick<CliVersionProbeDeps, "exec">,
): Promise<string | null> {
  if (command.startsWith("/")) return command;
  try {
    const res = await deps.exec("command", ["-v", command]);
    if (!res.ok) return null;
    const line = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line && line.startsWith("/") ? line : line || null;
  } catch {
    return null;
  }
}
