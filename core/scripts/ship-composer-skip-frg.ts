// Pure helpers for installed ship-composer default --skip-frg detection (#1127).
//
// After #1039, default Tugboat / pipeline-ship-playbook release and promote
// argv omit --skip-frg. A stale installed binary that still hard-codes that
// flag on the default path silently skips FRG. These helpers detect that
// legacy shape so doctor can fail closed. Absence of an installed composer
// is skip. The logged-reason escape (`SKIP_FRG_ARGS=(--skip-frg)`) is not
// a default-argv hard-code.

import * as path from "node:path";
import { homedir } from "node:os";
import { defaultInstalledShipPlaybookPath } from "./ship-playbook-promote-host.ts";
import { defaultInstalledTugboatPath } from "./tugboat-install-parity.ts";

/** Literal `--skip-frg` token on a command line (not `${SKIP_FRG_ARGS[@]}`). */
const SKIP_FRG_ARGV_TOKEN = /(?:^|[\s"'=])--skip-frg(?:[\s"']|$)/;

/** Default install paths doctor inspects for skip-frg composers. */
export function defaultInstalledShipComposerPaths(home: string = homedir()): {
  tugboat: string;
  playbook: string;
} {
  return {
    tugboat: defaultInstalledTugboatPath(home),
    playbook: defaultInstalledShipPlaybookPath(home),
  };
}

function isCommentOrEscapeOnlyLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.startsWith("#")) return true;
  if (/^SKIP_FRG_ARGS=/.test(t)) return true;
  return false;
}

function isUsageOrHelpLine(line: string): boolean {
  return /\bUsage:|\b--help\b|tugboat\.sh --milestone|pipeline-ship-playbook/.test(
    line,
  );
}

/**
 * True when a composer body hard-codes `--skip-frg` on a default release or
 * promote invocation. Escape assignment / comments / usage text do not count.
 */
export function composerHasHardCodedDefaultSkipFrg(source: string): boolean {
  for (const line of source.split("\n")) {
    if (isCommentOrEscapeOnlyLine(line) || isUsageOrHelpLine(line)) continue;
    if (!SKIP_FRG_ARGV_TOKEN.test(line)) continue;
    if (/\brelease\b/.test(line) || /engine-promote/.test(line)) return true;
  }
  return false;
}

export type ShipComposerSkipFrgVerdict =
  | { status: "pass"; detail: string }
  | { status: "fail"; detail: string; remediation: string }
  | { status: "skip"; detail: string };

export interface InstalledComposerBody {
  path: string;
  body: string | null;
  kind: "tugboat" | "playbook";
}

function refreshRemediation(kind: "tugboat" | "playbook"): string {
  if (kind === "tugboat") {
    return (
      "Refresh the installed Tugboat from the repo example " +
      '(`install -m 0755 "$ROOT/examples/supervisor/shell/tugboat.sh" ' +
      '"$HOME/.local/bin/tugboat"`), or invoke the versioned copy under REPO_DIR. ' +
      "Default release / promote argv must omit --skip-frg. " +
      "See docs/runbooks/ship-milestone.md (#1127)."
    );
  }
  return (
    "Refresh the installed ship playbook from the repo example " +
    '(`install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" ' +
    '"$HOME/.local/bin/pipeline-ship-playbook"`), or invoke the versioned copy under REPO_DIR. ' +
    "Default release / promote argv must omit --skip-frg. " +
    "See docs/runbooks/ship-milestone.md (#1127)."
  );
}

/**
 * Evaluate installed (or fixture) Tugboat / playbook bodies for a stale
 * hard-coded default `--skip-frg`. Pure: no filesystem or network.
 *
 * - no bodies present → skip
 * - any body whose default release/promote argv hard-codes `--skip-frg` → fail
 * - present bodies without that default → pass
 */
export function evaluateInstalledShipComposerSkipFrg(
  composers: InstalledComposerBody[],
): ShipComposerSkipFrgVerdict {
  const present = composers.filter((c) => c.body !== null);
  if (present.length === 0) {
    return {
      status: "skip",
      detail: "no installed Tugboat or ship playbook",
    };
  }

  for (const c of present) {
    if (composerHasHardCodedDefaultSkipFrg(c.body!)) {
      return {
        status: "fail",
        detail:
          `installed ${c.kind} at ${c.path} still hard-codes default --skip-frg ` +
          `on release or promote argv (pre-#1039 skip-frg playbook)`,
        remediation: refreshRemediation(c.kind),
      };
    }
  }

  const labels = present.map((c) => c.kind).join(" + ");
  return {
    status: "pass",
    detail: `installed ${labels} default release / promote argv omit --skip-frg`,
  };
}
