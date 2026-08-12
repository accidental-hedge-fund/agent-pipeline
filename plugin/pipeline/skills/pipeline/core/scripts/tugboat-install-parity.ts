// Pure helpers for Option 1 Tugboat install pack parity (#927).
//
// After #1001, agent-box / Buzz ship uses the thin composer under
// examples/supervisor/shell/tugboat.sh plus sibling pure helpers
// (release-checks-green.py, train-status-complete.py). Marker-only checks
// accept a fork that retains recognizer strings while changing promote or
// CI-wait behavior. These helpers compare installed file content digests to
// the repo examples so doctor fails closed on behavioral divergence, missing
// helpers, or a stale CI gate. Absence of an installed Tugboat is skip —
// not every host uses Option 1 thin ship.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** Unset promote-host default after #989 / #1001 (multi-host). */
export const TUGBOAT_ALL_HOST_DEFAULT = /ENGINE_PROMOTE_HOST:-all/;

/** Thin composer self-identification (header and/or state kind). */
export const TUGBOAT_THIN_IDENTITY =
  /Tugboat — thin ship composer|kind": "tugboat_ship"/;

/** Failure detail enrichment (#997). */
export const TUGBOAT_FAILURE_DETAIL = /failure_detail\s*\(/;

/** CI wait uses valid gh pr checks fields including bucket (#996). */
export const TUGBOAT_CI_WAIT_BUCKET =
  /gh pr checks "\$pr" --json name,state,bucket/;

/** Forbidden second-ship-brain / grant-factory product markers. */
export const TUGBOAT_FORBIDDEN_SECOND_BRAIN =
  /grant[\/_]factory|factory\.mjs|pipeline ship /;

/** Critical Option 1 pack members verified by content digest. */
export const OPTION1_CRITICAL_PACK_IDS = [
  "tugboat",
  "release-checks-green.py",
  "train-status-complete.py",
] as const;

export type Option1CriticalPackId = (typeof OPTION1_CRITICAL_PACK_IDS)[number];

/** SHA-256 hex digest of UTF-8 file body (canonical content identity). */
export function contentDigest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Default install path used by docs/runbooks/ship-milestone.md (Option 1). */
export function defaultInstalledTugboatPath(home: string = homedir()): string {
  return path.join(home, ".local", "bin", "tugboat");
}

/** Documented Option 1 pack install paths under ~/.local/bin. */
export function defaultInstalledOption1PackPaths(
  home: string = homedir(),
): Record<Option1CriticalPackId, string> {
  const bin = path.join(home, ".local", "bin");
  return {
    tugboat: path.join(bin, "tugboat"),
    "release-checks-green.py": path.join(bin, "release-checks-green.py"),
    "train-status-complete.py": path.join(bin, "train-status-complete.py"),
  };
}

/** Canonical pack sources under a pipeline install / checkout root. */
export function canonicalOption1PackPaths(
  installRoot: string,
): Record<Option1CriticalPackId, string> {
  const shell = path.join(installRoot, "examples", "supervisor", "shell");
  return {
    tugboat: path.join(shell, "tugboat.sh"),
    "release-checks-green.py": path.join(shell, "release-checks-green.py"),
    "train-status-complete.py": path.join(shell, "train-status-complete.py"),
  };
}

export type ThinMarkerName =
  | "thin_identity"
  | "promote_all_default"
  | "failure_detail"
  | "ci_wait_bucket";

/** Critical thin markers an Option 1 Tugboat source should retain (source audit). */
export function missingTugboatThinMarkers(source: string): ThinMarkerName[] {
  const missing: ThinMarkerName[] = [];
  if (!TUGBOAT_THIN_IDENTITY.test(source)) missing.push("thin_identity");
  if (!TUGBOAT_ALL_HOST_DEFAULT.test(source)) missing.push("promote_all_default");
  if (!TUGBOAT_FAILURE_DETAIL.test(source)) missing.push("failure_detail");
  if (!TUGBOAT_CI_WAIT_BUCKET.test(source)) missing.push("ci_wait_bucket");
  return missing;
}

/** True when source still matches Option 1 thin ship critical markers. */
export function tugboatHasCriticalThinMarkers(source: string): boolean {
  return missingTugboatThinMarkers(source).length === 0;
}

/** True when source embeds forbidden second-brain / grant-factory ship path. */
export function tugboatHasForbiddenSecondBrainMarkers(source: string): boolean {
  return TUGBOAT_FORBIDDEN_SECOND_BRAIN.test(source);
}

/** Installed or canonical bodies for the critical Option 1 pack (null = missing). */
export type Option1PackBodies = Record<Option1CriticalPackId, string | null>;

export type TugboatInstallParityVerdict =
  | { status: "pass"; detail: string }
  | { status: "fail"; detail: string; remediation: string }
  | { status: "skip"; detail: string };

/**
 * Evaluate installed Option 1 pack bodies against canonical repo examples.
 * Pure: no filesystem or network.
 *
 * - installed.tugboat null → skip (not installed; only absence skips)
 * - any present primary binary → content-digest the critical pack (Tugboat +
 *   release-checks-green.py + train-status-complete.py) against canonical;
 *   fail closed on missing sibling, content mismatch, or unreadable canonical
 * - forbidden second-brain markers on installed Tugboat → fail
 * - all digests match → pass
 */
export function evaluateOption1PackParity(
  installed: Option1PackBodies,
  canonical: Option1PackBodies,
  opts: {
    pathLabel?: string;
  } = {},
): TugboatInstallParityVerdict {
  const label = opts.pathLabel ?? "tugboat";
  if (installed.tugboat === null) {
    return {
      status: "skip",
      detail: `no installed Option 1 Tugboat at ${label}`,
    };
  }

  const missingCanonical: string[] = [];
  for (const id of OPTION1_CRITICAL_PACK_IDS) {
    if (canonical[id] === null) missingCanonical.push(id === "tugboat" ? "tugboat.sh" : id);
  }
  if (missingCanonical.length > 0) {
    return {
      status: "fail",
      detail:
        `cannot verify Option 1 pack: missing canonical sources ` +
        `(${missingCanonical.join(", ")}) under install-root examples/supervisor/shell/`,
      remediation: tugboatRefreshRemediation(),
    };
  }

  // Any file present at the documented Option 1 path is treated as the primary
  // ship binary. Skip is reserved for an absent path only.
  if (tugboatHasForbiddenSecondBrainMarkers(installed.tugboat)) {
    return {
      status: "fail",
      detail:
        `installed ${label} embeds second ship-brain or grant-factory markers; ` +
        `Option 1 primary path must stay thin (compose CLI only)`,
      remediation: tugboatRefreshRemediation(),
    };
  }

  const divergent: string[] = [];
  for (const id of OPTION1_CRITICAL_PACK_IDS) {
    const got = installed[id];
    const want = canonical[id]!;
    if (got === null) {
      divergent.push(`${id} (missing)`);
      continue;
    }
    if (contentDigest(got) !== contentDigest(want)) {
      divergent.push(id);
    }
  }

  if (divergent.length > 0) {
    return {
      status: "fail",
      detail:
        `installed Option 1 pack diverges from repo examples ` +
        `(content mismatch or missing): ${divergent.join(", ")}`,
      remediation: tugboatRefreshRemediation(),
    };
  }

  return {
    status: "pass",
    detail:
      `installed Option 1 pack matches repo examples ` +
      `(tugboat + release-checks-green.py + train-status-complete.py content digests)`,
  };
}

function tugboatRefreshRemediation(): string {
  return (
    "Refresh Option 1 ship binaries from the repo examples " +
    '(`install -m 0755 "$ROOT/examples/supervisor/shell/tugboat.sh" ' +
    '"$HOME/.local/bin/tugboat"` and sibling notify/stage-watch/helpers ' +
    "including release-checks-green.py and train-status-complete.py), " +
    "or invoke the versioned copy under REPO_DIR directly " +
    '(`"$REPO_DIR/examples/supervisor/shell/tugboat.sh" --milestone vX.Y.Z`). ' +
    "Do not keep a divergent host fork as the primary Buzz ship path. " +
    "See docs/runbooks/ship-milestone.md (#927 / #1001)."
  );
}
