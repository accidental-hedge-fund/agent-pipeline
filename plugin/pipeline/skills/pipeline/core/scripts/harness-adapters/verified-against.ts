// Structured verified-against CLI identity for built-in adapters (#778).
//
// Machine-readable companion to the human header comments on each adapter
// module. Production version-drift warnings and tests read this map rather
// than parsing comments. Extension / compatibility adapters are absent —
// they have no frozen argv/telemetry fixture identity unless they supply one.

/** CLI identity against which argv and/or telemetry schema were verified. */
export interface VerifiedAgainstIdentity {
  /** CLI binary name (e.g. "grok", "claude"). */
  cli: string;
  /** Version string used for verification (e.g. "0.2.114"). */
  version: string;
  /** Optional build / commit id recorded alongside the version. */
  buildId?: string;
  /**
   * Telemetry disposition recorded at verification time:
   * - `"jsonl"` — machine-readable mode fixture-verified; adapter may declare it
   * - `"none"` — no verified machine-readable mode; adapter must keep telemetry none
   */
  telemetry: "jsonl" | "none";
  /** Short human note (argv scope, fixture date, why none, etc.). */
  notes?: string;
}

/**
 * Built-in verified-against identities. Keys are adapter names (registry id).
 * Only built-ins that freeze argv or telemetry schema against a specific CLI
 * version appear here.
 */
export const BUILTIN_VERIFIED_AGAINST: Readonly<Record<string, VerifiedAgainstIdentity>> = {
  claude: {
    cli: "claude",
    version: "stream-json",
    telemetry: "jsonl",
    notes:
      "Telemetry envelope verified via recorded fixtures (result + modelUsage + rate_limit_event); argv via pre-#431 golden suite.",
  },
  codex: {
    cli: "codex",
    version: "0.145.0",
    telemetry: "jsonl",
    notes:
      "exec --json item.completed / turn.completed fixtures; managed sandbox pair verified against codex-cli 0.145.0 (#613).",
  },
  grok: {
    cli: "grok",
    version: "0.2.114",
    buildId: "0c78503879",
    telemetry: "jsonl",
    notes:
      "Argv originally verified on 0.2.93; production --output-format streaming-json (type:text + type:end) fixture-verified on 0.2.114 (2026-08-04) for text/cost/usage/modelUsage; single-document json kept as legacy fixture parse path.",
  },
  pi: {
    cli: "pi",
    version: "readme-argv",
    telemetry: "none",
    notes:
      "--mode json exists but payload schema has no recorded fixture; telemetry remains none (golden rule 5).",
  },
  opencode: {
    cli: "opencode",
    version: "help-argv",
    telemetry: "none",
    notes:
      "--format json exists but payload schema has no recorded fixture; telemetry remains none (golden rule 5).",
  },
};

/** Look up verified-against identity for an adapter name, or null. */
export function getVerifiedAgainst(adapterName: string): VerifiedAgainstIdentity | null {
  return BUILTIN_VERIFIED_AGAINST[adapterName] ?? null;
}

/**
 * Extract a comparable version token from a CLI `--version` line.
 * Prefers the first `major.minor.patch` (or major.minor) token; falls back to
 * the trimmed line when no semver-like token is present.
 */
export function extractComparableVersion(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\d+\.\d+(?:\.\d+)?/);
  return match ? match[0] : trimmed;
}

/**
 * Whether a probed CLI version is compatible with a verified-against identity
 * under the documented rule for this family:
 * - When both sides yield a comparable semver-like token, equality of that
 *   token is required.
 * - When verified-against version is a non-semver label (e.g. "stream-json",
 *   "readme-argv"), no drift warning is emitted (no numeric baseline).
 * - Null/empty either side → no divergence claim (unknown, not a mismatch).
 */
export function versionsCompatible(
  probedVersion: string | null | undefined,
  verified: VerifiedAgainstIdentity | null | undefined,
): boolean {
  if (!verified) return true;
  const probed = extractComparableVersion(probedVersion);
  const expected = extractComparableVersion(verified.version);
  // Non-semver verified labels (no digit.digit token) → skip drift check.
  if (!expected || !/^\d+\.\d+/.test(expected)) return true;
  if (!probed) return true; // probe unknown → no false drift
  return probed === expected;
}

/**
 * Format a fail-soft compatibility warning when probed version diverges from
 * verified-against. Returns null when no warning should be emitted.
 */
export function formatVersionDriftWarning(
  adapterName: string,
  probedVersion: string | null | undefined,
  verified: VerifiedAgainstIdentity | null | undefined,
): string | null {
  if (!verified) return null;
  if (versionsCompatible(probedVersion, verified)) return null;
  const probed = extractComparableVersion(probedVersion) ?? String(probedVersion);
  const expected = extractComparableVersion(verified.version) ?? verified.version;
  return (
    `[harness ${adapterName}] CLI version drift: probed ${probed} diverges from ` +
    `verified-against ${expected} (${verified.cli}` +
    (verified.buildId ? ` build ${verified.buildId}` : "") +
    `). Argv/telemetry schema may have changed — continuing fail-soft.`
  );
}
