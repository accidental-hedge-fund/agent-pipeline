// Pure ship-end identity gate (#1151).
//
// After train-complete, FRG pack / release / finish / tag must execute the
// candidate engine at the FRG-bound 40-hex SHA, not the previous production
// pin. Package --version equality is display-only and SHALL NOT pass.
// Installed pipeline-ship-playbook must be a thin launcher to repo Tugboat.
//
// Inject strings, digests, and SHA. No network, git, or subprocess.

import { contentDigest } from "./tugboat-install-parity.ts";

export const EXACT_GIT_SHA_RE = /^[0-9a-f]{40}$/;

/** Known stale full-compose playbook digest prefix from the 1.39.4 pin (hex). */
export const STALE_PLAYBOOK_DIGEST_PREFIX = "2afe3c92";

/** Thin launcher: exec repo Tugboat with the caller's argv. */
export const PLAYBOOK_THIN_LAUNCHER_RE =
  /^\s*exec\s+"\$REPO_DIR\/examples\/supervisor\/shell\/tugboat\.sh"\s+"\$@"\s*$/m;

/** Recognizer for a leftover full playbook compose (not a launcher). */
const FULL_PLAYBOOK_COMPOSE_RE =
  /factory-release prepare|"\$PIPELINE"\s+release\s+|pipeline-ship-playbook\.sh --milestone|HOST="\$\{ENGINE_PROMOTE_HOST:-/;

export type ShipEndComposerKind =
  | "tugboat-repo"
  | "playbook-launcher"
  | "playbook-stale"
  | "in-engine-ship"
  | "unused";

export type PlaybookComposerKind = "playbook-launcher" | "playbook-stale" | "unused";

export interface ShipEndIdentityInput {
  /** True when Tugboat, a selected playbook, or in-engine ship-end is in use. */
  shipEndToolsInUse: boolean;
  /** FRG-bound candidate SHA (40-hex). Null when no bound request/status. */
  candidateSha: string | null;
  /** Invoked ship-end CLI `commit_sha`. Null when unresolvable — never invent. */
  invokedCommitSha: string | null;
  /** Package version string; advisory only. Matching this MUST NOT pass SHA mismatch. */
  invokedVersion?: string | null;
  composerKind: ShipEndComposerKind;
  /** Selected installed playbook classification. Unused when not selected. */
  selectedPlaybookKind?: PlaybookComposerKind;
  /** contentDigest of the resolved tugboat.sh body, when compared. */
  resolvedTugboatDigest?: string | null;
  /** contentDigest of tugboat.sh at the candidate SHA tree, when compared. */
  candidateTugboatDigest?: string | null;
}

export type ShipEndIdentityVerdict =
  | { status: "pass"; detail: string }
  | { status: "fail"; detail: string; remediation: string }
  | { status: "skip"; detail: string };

/** Exact 40-hex SHA or null. Never invents. Abbreviated SHAs are null. */
export function parseExactGitSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return EXACT_GIT_SHA_RE.test(sha) ? sha : null;
}

/** `{ version, commit_sha }` JSON line. `commit_sha` is 40-hex or null. */
export function formatPipelineVersionJson(
  version: string,
  commitSha: string | null,
): string {
  return JSON.stringify({
    version,
    commit_sha: parseExactGitSha(commitSha),
  }) + "\n";
}

/** True when the playbook body execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh`. */
export function isThinPlaybookLauncher(body: string): boolean {
  return PLAYBOOK_THIN_LAUNCHER_RE.test(body);
}

/**
 * Classify an installed playbook body.
 * Marker-only mention of tugboat.sh is not a launcher.
 * `unused` is absence only (null body). Any installed non-launcher body is
 * noncompliant (`playbook-stale`), including unrecognized shell forms.
 * Selection is a separate doctor/unit input — do not infer it from the body.
 */
export function classifyPlaybookBody(body: string | null): PlaybookComposerKind {
  if (body == null) return "unused";
  if (isThinPlaybookLauncher(body)) return "playbook-launcher";
  if (FULL_PLAYBOOK_COMPOSE_RE.test(body)) return "playbook-stale";
  const digest = contentDigest(body);
  if (digest.startsWith(STALE_PLAYBOOK_DIGEST_PREFIX)) return "playbook-stale";
  return "playbook-stale";
}

export function shipEndCandidateRemediation(): string {
  return (
    "Invoke factory-release prepare, factory-gate, pipeline release, and release finish " +
    "from the candidate engine at the FRG-bound 40-hex SHA " +
    "(clean REPO_DIR HEAD, $REPO_DIR/.worktrees/ship-candidate-<sha>, or " +
    "PIPELINE_CANDIDATE_ENGINE_ROOT). Do not use ~/.local/bin/pipeline when that " +
    "binary is the previous production pin. See docs/runbooks/ship-milestone.md (#1151)."
  );
}

export function shipEndPlaybookRemediation(): string {
  return (
    "Refresh the installed playbook from the candidate launcher " +
    '(`install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" ' +
    '"$HOME/.local/bin/pipeline-ship-playbook"`) or exec ' +
    '"$REPO_DIR/examples/supervisor/shell/tugboat.sh". ' +
    "A stale full playbook is not an accepted ship-end composer. " +
    "See docs/runbooks/ship-milestone.md (#1151)."
  );
}

/**
 * Evaluate ship-end CLI SHA and playbook composer kind against the candidate.
 * Pure: no filesystem or network.
 */
export function evaluateShipEndIdentity(
  input: ShipEndIdentityInput,
): ShipEndIdentityVerdict {
  if (!input.shipEndToolsInUse) {
    return {
      status: "skip",
      detail:
        "no installed Tugboat, no installed playbook, and no in-engine ship-end in use",
    };
  }

  const playbookKind = input.selectedPlaybookKind ??
    (input.composerKind === "playbook-stale" ||
        input.composerKind === "playbook-launcher"
      ? input.composerKind
      : "unused");

  if (playbookKind === "playbook-stale" || input.composerKind === "playbook-stale") {
    return {
      status: "fail",
      detail:
        "selected ship playbook is not a thin launcher to " +
        "$REPO_DIR/examples/supervisor/shell/tugboat.sh",
      remediation: shipEndPlaybookRemediation(),
    };
  }

  if (
    input.resolvedTugboatDigest &&
    input.candidateTugboatDigest &&
    input.resolvedTugboatDigest !== input.candidateTugboatDigest
  ) {
    return {
      status: "fail",
      detail:
        "resolved tugboat.sh content digest does not match tugboat.sh at the candidate SHA",
      remediation: shipEndPlaybookRemediation(),
    };
  }

  const bound = parseExactGitSha(input.candidateSha);
  if (!bound) {
    return {
      status: "pass",
      detail:
        "ship-end tools present; no bound candidate SHA to compare; playbook is a launcher or unused",
    };
  }

  const invoked = parseExactGitSha(input.invokedCommitSha);
  if (invoked !== bound) {
    const versionNote = input.invokedVersion
      ? ` (package version ${input.invokedVersion} is not identity)`
      : "";
    return {
      status: "fail",
      detail:
        `ship-end CLI commit_sha ${invoked ?? "null"} does not equal candidate SHA ${bound}` +
        versionNote,
      remediation: shipEndCandidateRemediation(),
    };
  }

  return {
    status: "pass",
    detail: `ship-end CLI commit_sha matches candidate SHA ${bound}`,
  };
}

export { contentDigest };
