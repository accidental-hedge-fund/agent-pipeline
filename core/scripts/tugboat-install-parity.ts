// Pure helpers for Option 1 Tugboat install parity (#927).
//
// After #1001, agent-box / Buzz ship uses the thin composer under
// examples/supervisor/shell/tugboat.sh. An already-installed ~/.local/bin/tugboat
// (or a host fork that lost promote-all / failure_detail / CI-wait / thinness)
// would silently diverge from repo examples. These helpers detect that shape so
// doctor can fail closed with refresh remediation. Absence of an installed
// Tugboat is skip — not every host uses Option 1 thin ship.

import * as path from "node:path";
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

/** Default install path used by docs/runbooks/ship-milestone.md (Option 1). */
export function defaultInstalledTugboatPath(home: string = homedir()): string {
  return path.join(home, ".local", "bin", "tugboat");
}

export type ThinMarkerName =
  | "thin_identity"
  | "promote_all_default"
  | "failure_detail"
  | "ci_wait_bucket";

/** Critical thin markers an installed Option 1 Tugboat must retain. */
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

export type TugboatInstallParityVerdict =
  | { status: "pass"; detail: string }
  | { status: "fail"; detail: string; remediation: string }
  | { status: "skip"; detail: string };

/**
 * Evaluate an installed (or fixture) Option 1 Tugboat body for install parity.
 * Pure: no filesystem or network.
 *
 * - null source → skip (not installed; only absence skips)
 * - any present body at the documented path → evaluate markers; fail closed
 *   when critical thin markers are missing (including arbitrary older/local
 *   forks that do not match recognizer strings — #927 review 1)
 * - forbidden second-brain markers → fail
 * - all critical markers present → pass
 */
export function evaluateInstalledTugboatParity(
  source: string | null,
  opts: {
    pathLabel?: string;
  } = {},
): TugboatInstallParityVerdict {
  const label = opts.pathLabel ?? "tugboat";
  if (source === null) {
    return {
      status: "skip",
      detail: `no installed Option 1 Tugboat at ${label}`,
    };
  }

  // Any file present at the documented Option 1 path is treated as the primary
  // ship binary. Skip is reserved for an absent path only — an unrecognized
  // or stripped body must fail closed so a divergent fork cannot bypass doctor.
  if (tugboatHasForbiddenSecondBrainMarkers(source)) {
    return {
      status: "fail",
      detail:
        `installed ${label} embeds second ship-brain or grant-factory markers; ` +
        `Option 1 primary path must stay thin (compose CLI only)`,
      remediation: tugboatRefreshRemediation(),
    };
  }

  const missing = missingTugboatThinMarkers(source);
  if (missing.length > 0) {
    return {
      status: "fail",
      detail:
        `installed Option 1 ship binary at ${label} is missing critical thin markers: ` +
        `${missing.join(", ")}`,
      remediation: tugboatRefreshRemediation(),
    };
  }

  return {
    status: "pass",
    detail: `installed ${label} retains Option 1 thin markers (promote all, failure_detail, CI-wait bucket, thin identity)`,
  };
}

function tugboatRefreshRemediation(): string {
  return (
    "Refresh Option 1 ship binaries from the repo examples " +
    '(`install -m 0755 "$ROOT/examples/supervisor/shell/tugboat.sh" ' +
    '"$HOME/.local/bin/tugboat"` and sibling notify/stage-watch/helpers), ' +
    "or invoke the versioned copy under REPO_DIR directly " +
    '(`"$REPO_DIR/examples/supervisor/shell/tugboat.sh" --milestone vX.Y.Z`). ' +
    "Do not keep a divergent host fork as the primary Buzz ship path. " +
    "See docs/runbooks/ship-milestone.md (#927 / #1001)."
  );
}
