// Pure helpers for ship playbook promote-host default detection (#989).
//
// After engine-promote defaults to --host all, an already-installed
// ~/.local/bin/pipeline-ship-playbook that still expands
// HOST="${ENGINE_PROMOTE_HOST:-codex}" and passes --host codex silently
// bypasses the stage default. These helpers detect that legacy shape so
// doctor / rollout preflight can fail closed before a multi-host ship.

import * as path from "node:path";
import { homedir } from "node:os";

/** Unset default in pre-#989 installed playbooks (codex-only promote). */
export const LEGACY_SHIP_PLAYBOOK_CODEX_HOST_DEFAULT =
  /HOST="\$\{ENGINE_PROMOTE_HOST:-codex\}"/;

/** Unset default after #989 (multi-host promote). */
export const SHIP_PLAYBOOK_ALL_HOST_DEFAULT =
  /HOST="\$\{ENGINE_PROMOTE_HOST:-all\}"/;

/** Default install path used by docs/runbooks/ship-milestone.md. */
export function defaultInstalledShipPlaybookPath(home: string = homedir()): string {
  return path.join(home, ".local", "bin", "pipeline-ship-playbook");
}

/** True when source uses the pre-#989 unset default `:-codex`. */
export function shipPlaybookHasLegacyCodexOnlyPromoteDefault(source: string): boolean {
  return LEGACY_SHIP_PLAYBOOK_CODEX_HOST_DEFAULT.test(source);
}

/** True when source uses the multi-host unset default `:-all`. */
export function shipPlaybookHasAllPromoteDefault(source: string): boolean {
  return SHIP_PLAYBOOK_ALL_HOST_DEFAULT.test(source);
}

export type ShipPlaybookPromoteHostVerdict =
  | { status: "pass"; detail: string }
  | { status: "fail"; detail: string; remediation: string }
  | { status: "skip"; detail: string };

/**
 * Evaluate an installed (or fixture) ship playbook body for promote-host
 * rollout safety. Pure: no filesystem or network.
 *
 * - null source → skip (not installed)
 * - legacy `:-codex` with no ENGINE_PROMOTE_HOST override → fail (silent codex-only)
 * - legacy `:-codex` with ENGINE_PROMOTE_HOST set → pass (operator override)
 * - `:-all` → pass
 * - other shapes → skip (not a recognized playbook)
 */
export function evaluateInstalledShipPlaybookPromoteHost(
  source: string | null,
  opts: {
    pathLabel?: string;
    /** Value of process.env.ENGINE_PROMOTE_HOST when the ship would run. */
    enginePromoteHostEnv?: string | undefined;
  } = {},
): ShipPlaybookPromoteHostVerdict {
  const label = opts.pathLabel ?? "pipeline-ship-playbook";
  if (source === null) {
    return {
      status: "skip",
      detail: `no installed ship playbook at ${label}`,
    };
  }

  if (shipPlaybookHasLegacyCodexOnlyPromoteDefault(source)) {
    const env = opts.enginePromoteHostEnv?.trim();
    if (env) {
      return {
        status: "pass",
        detail:
          `installed ${label} has legacy codex-only default, ` +
          `but ENGINE_PROMOTE_HOST=${env} overrides it for this environment`,
      };
    }
    return {
      status: "fail",
      detail:
        `installed ship playbook at ${label} still defaults ENGINE_PROMOTE_HOST ` +
        `to codex (pre-#989); a ship using it would promote only Codex`,
      remediation:
        "Before the rollout ship, refresh the playbook from the repo example " +
        '(`install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" ' +
        '"$HOME/.local/bin/pipeline-ship-playbook"`), or invoke the versioned copy under ' +
        "REPO_DIR directly " +
        '(`"$REPO_DIR/examples/supervisor/shell/pipeline-ship-playbook.sh" --milestone vX.Y.Z`), ' +
        "or export ENGINE_PROMOTE_HOST=all for the ship run. " +
        "See docs/runbooks/ship-milestone.md (#989).",
    };
  }

  if (shipPlaybookHasAllPromoteDefault(source)) {
    return {
      status: "pass",
      detail: `installed ${label} defaults promote host to all`,
    };
  }

  return {
    status: "skip",
    detail:
      `installed ${label} is present but not a recognized ship playbook promote-host shape`,
  };
}
