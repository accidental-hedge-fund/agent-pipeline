// Typed wrappers for the OpenSpec CLI (https://openspec.dev).
//
// OpenSpec is a spec-driven-development layer: a target repo keeps living
// requirements under `openspec/specs/` and per-change deltas under
// `openspec/changes/`. The pipeline integrates OPT-IN. By default
// (`openspec.enabled: "auto"`) the integration activates only on repos that
// already have an `openspec/` directory, so the pipeline stays usable on any
// repo. "on"/"off" force it regardless of detection.
//
// This module is intentionally thin: it shells out via execFile (like gh.ts),
// reads change folders straight off disk for deterministic discovery, and
// exposes PURE parsers the tests cover without needing the `openspec` binary.
// Machine-readable commands require both CLI success and their documented
// semantic postconditions; an exit code alone is not proof that state changed.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PipelineConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface ValidationIssue {
  item?: string;
  message: string;
}

export interface ValidateResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** True when the `openspec` binary is missing / could not be spawned. */
  unavailable: boolean;
  raw: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  unavailable: boolean;
}

async function runOpenspec(dir: string, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("openspec", args, {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "", unavailable: false };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") {
      return { code: -1, stdout: "", stderr: e.message ?? "openspec not found", unavailable: true };
    }
    const code = typeof e.code === "number" ? e.code : 1;
    return { code, stdout: e.stdout ?? "", stderr: e.stderr ?? "", unavailable: false };
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Does the repo/worktree have an OpenSpec workspace (an `openspec/` dir)? */
export function isInitialized(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "openspec")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the PLANNING stage should use the OpenSpec flow. Unlike isActive
 * (which gates the worktree-time review/pre-merge steps), this also returns true
 * for an uninitialized repo when bootstrap is enabled — planning then runs
 * `openspec init` in the worktree before authoring the change.
 */
export function shouldPlanWithOpenspec(cfg: Pick<PipelineConfig, "openspec">, repoDir: string): boolean {
  const mode = cfg.openspec?.enabled ?? "auto";
  if (mode === "off") return false;
  if (mode === "on") return true;
  return isInitialized(repoDir) || Boolean(cfg.openspec?.bootstrap);
}

/** Resolve whether the OpenSpec integration is active for this repo. */
export function isActive(cfg: Pick<PipelineConfig, "openspec">, dir: string): boolean {
  const mode = cfg.openspec?.enabled ?? "auto";
  if (mode === "off") return false;
  if (mode === "on") return true;
  return isInitialized(dir);
}

// ---------------------------------------------------------------------------
// Change folder discovery (filesystem — robust to CLI schema drift)
// ---------------------------------------------------------------------------

/** Active change ids: subdirs of `openspec/changes/` excluding `archive`. */
export function listChangeDirs(dir: string): string[] {
  const base = path.join(dir, "openspec", "changes");
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function changeDirExists(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, "openspec", "changes", name)).isDirectory();
  } catch {
    return false;
  }
}

/** Read a file inside a change folder (e.g. "proposal.md", "tasks.md"). */
export function readChangeFile(dir: string, name: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "openspec", "changes", name, file), "utf8");
  } catch {
    return null;
  }
}

/**
 * Concatenate a change's spec delta files (`openspec/changes/<name>/specs/**.md`)
 * into a single markdown block — the "intended behavior" to anchor reviews on.
 * Empty string when the change has no spec deltas.
 */
export function readSpecDeltas(dir: string, name: string): string {
  const base = path.join(dir, "openspec", "changes", name, "specs");
  const parts: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          parts.push(`#### ${path.relative(base, p)}\n\n${fs.readFileSync(p, "utf8").trim()}`);
        } catch {
          /* skip unreadable file */
        }
      }
    }
  };
  walk(base);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate the whole workspace: `openspec validate --all --json`. */
export async function validate(dir: string, timeoutMs = 60_000): Promise<ValidateResult> {
  return runValidate(dir, ["validate", "--all", "--json"], timeoutMs);
}

/** Validate a single change: `openspec validate <name> --json`. */
export async function validateItem(dir: string, name: string, timeoutMs = 60_000): Promise<ValidateResult> {
  return runValidate(dir, ["validate", name, "--json"], timeoutMs);
}

async function runValidate(dir: string, args: string[], timeoutMs: number): Promise<ValidateResult> {
  const r = await runOpenspec(dir, args, timeoutMs);
  if (r.unavailable) {
    return { valid: true, issues: [], unavailable: true, raw: r.stderr };
  }
  return parseValidateResult(r.code, `${r.stdout}${r.stderr}`);
}

// ---------------------------------------------------------------------------
// Archive (fold a completed change's deltas into the living specs)
// ---------------------------------------------------------------------------

export interface ArchiveResult {
  success: boolean;
  unavailable: boolean;
  output: string;
  /** Stable policy input for engine-owned archive repair. */
  diagnostic?: ArchiveFailureDiagnostic;
}

export const OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE = "openspec-archive-apply-conflict" as const;

export interface ArchiveFailureDiagnostic {
  reasonCode: typeof OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE;
  evidenceKey: string;
  /** Exact OpenSpec status code, or a stable wrapper postcondition code. */
  diagnosticCode: string;
  message?: string;
  fix?: string;
}

export type ArchiveChangeState = "removed" | "present" | "unverified";

export interface ArchiveDeps {
  run?: (dir: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  changeState?: (dir: string, name: string) => ArchiveChangeState;
}

/** Minimum OpenSpec CLI version whose `archive` supports `--json` — 1.5 added
 *  the machine-readable `{ archive, status }` envelope parseArchiveResult
 *  requires. */
export const OPENSPEC_ARCHIVE_JSON_MIN_VERSION = "1.5.0";

/**
 * Parse the first `major.minor.patch` triple out of `openspec --version`
 * output (the real CLI prints a bare `1.5.0`). Returns null when no version is
 * identifiable — the preflight in {@link archive} then treats the probe as
 * inconclusive and lets the archive call's own result govern.
 */
export function parseOpenspecCliVersion(output: string): [number, number, number] | null {
  const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

interface ArchiveJsonDiagnostic {
  code?: string;
  message?: string;
  fix?: string;
}

function archiveFailure(
  name: string,
  diagnosticCode: string,
  output: string,
  diagnostic: ArchiveJsonDiagnostic = {},
): ArchiveResult {
  return {
    success: false,
    unavailable: false,
    output,
    diagnostic: {
      reasonCode: OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE,
      evidenceKey: `${OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE}:${name}:${diagnosticCode}`,
      diagnosticCode,
      ...(diagnostic.message ? { message: diagnostic.message } : {}),
      ...(diagnostic.fix ? { fix: diagnostic.fix } : {}),
    },
  };
}

/**
 * Parse `openspec archive --json` and require the named archive plus its
 * filesystem postcondition. OpenSpec 1.5 emits `{ archive: null, status: [...] }`
 * for semantic failures, including apply conflicts that human mode reports with
 * exit 0 after printing "Aborted. No files were changed."
 */
export function parseArchiveResult(
  name: string,
  code: number,
  stdout: string,
  stderr: string,
  changeState: ArchiveChangeState,
): ArchiveResult {
  const output = `${stdout}${stderr}`.trim();
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return archiveFailure(name, code === 0 ? "archive_json_invalid" : "archive_command_failed", output);
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return archiveFailure(name, code === 0 ? "archive_json_invalid" : "archive_command_failed", output);
  }

  const status = Array.isArray(parsed.status)
    ? parsed.status.find((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : undefined;
  const cliDiagnostic: ArchiveJsonDiagnostic = status
    ? {
        ...(typeof status.code === "string" ? { code: status.code } : {}),
        ...(typeof status.message === "string" ? { message: status.message } : {}),
        ...(typeof status.fix === "string" ? { fix: status.fix } : {}),
      }
    : {};

  if (code !== 0 || cliDiagnostic.code) {
    return archiveFailure(name, cliDiagnostic.code ?? "archive_command_failed", output, cliDiagnostic);
  }

  const archiveValue = parsed.archive;
  if (!archiveValue || typeof archiveValue !== "object" || Array.isArray(archiveValue)) {
    return archiveFailure(name, cliDiagnostic.code ?? "archive_result_missing", output, cliDiagnostic);
  }
  const archiveObject = archiveValue as Record<string, unknown>;
  if (
    archiveObject.change !== name ||
    typeof archiveObject.archivedAs !== "string" ||
    archiveObject.archivedAs.length === 0
  ) {
    return archiveFailure(name, "archive_result_mismatch", output);
  }
  if (changeState === "present") {
    return archiveFailure(name, "archive_active_change_remains", output);
  }
  if (changeState === "unverified") {
    return archiveFailure(name, "archive_active_change_unverified", output);
  }

  return { success: true, unavailable: false, output };
}

function archiveChangeState(dir: string, name: string): ArchiveChangeState {
  try {
    return fs.statSync(path.join(dir, "openspec", "changes", name)).isDirectory() ? "present" : "unverified";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "removed" : "unverified";
  }
}

/** `openspec archive <name> --yes --json` — apply deltas and verify the active change left the tree. */
export async function archive(
  dir: string,
  name: string,
  timeoutMs = 60_000,
  deps: ArchiveDeps = {},
): Promise<ArchiveResult> {
  const run = deps.run ?? runOpenspec;
  // Capability preflight: `archive --json` requires OpenSpec >= 1.5. A
  // positively identified older CLI must fail here with an actionable upgrade
  // diagnostic — feeding its non-JSON usage error into the parse below would
  // misreport a tooling gap as a generic archive_command_failed apply
  // conflict and send implementer repair rounds chasing a change that has
  // nothing wrong with it. An inconclusive probe (unrecognized output or
  // probe error) falls through to the archive call, whose own result governs.
  const probe = await run(dir, ["--version"], timeoutMs);
  if (probe.unavailable) {
    return { success: false, unavailable: true, output: `${probe.stdout}${probe.stderr}`.trim() };
  }
  const cliVersion = probe.code === 0 ? parseOpenspecCliVersion(`${probe.stdout}${probe.stderr}`) : null;
  if (cliVersion && !versionAtLeast(cliVersion, parseOpenspecCliVersion(OPENSPEC_ARCHIVE_JSON_MIN_VERSION)!)) {
    const found = cliVersion.join(".");
    const message =
      `openspec CLI ${found} does not support \`archive --json\`; ` +
      `openspec >= ${OPENSPEC_ARCHIVE_JSON_MIN_VERSION} is required`;
    const fix = `Upgrade the openspec CLI to ${OPENSPEC_ARCHIVE_JSON_MIN_VERSION} or newer, then re-run.`;
    return archiveFailure(name, "archive_cli_unsupported", `${message}. ${fix}`, { message, fix });
  }
  const r = await run(dir, ["archive", name, "--yes", "--json"], timeoutMs);
  if (r.unavailable) {
    return {
      success: false,
      unavailable: true,
      output: `${r.stdout}${r.stderr}`.trim(),
    };
  }
  const changeState = (deps.changeState ?? archiveChangeState)(dir, name);
  return parseArchiveResult(name, r.code, r.stdout, r.stderr, changeState);
}

export interface InitResult {
  success: boolean;
  unavailable: boolean;
  output: string;
}

/** `openspec init --tools <tools>` — scaffolds an OpenSpec workspace in `dir`. */
export async function init(dir: string, tools = "claude,codex", timeoutMs = 120_000): Promise<InitResult> {
  const r = await runOpenspec(dir, ["init", "--tools", tools], timeoutMs);
  return {
    success: r.code === 0 && !r.unavailable,
    unavailable: r.unavailable,
    output: `${r.stdout}${r.stderr}`.trim(),
  };
}

/**
 * Spec deltas for the active change (or "" when OpenSpec is not active or has no changes).
 * Shared helper called by all pipeline stages that need the current change's requirements.
 *
 * NOTE: In worktrees that may contain pre-existing changes (fix rounds, review rounds),
 * prefer openspecContextFromDiff() which targets the branch-introduced change instead of
 * picking changes[0] — that can be an unrelated pre-existing change.
 */
export function openspecContext(cfg: Pick<PipelineConfig, "openspec">, cwd: string): string {
  if (!isActive(cfg, cwd)) return "";
  const changes = listChangeDirs(cwd);
  return changes.length ? readSpecDeltas(cwd, changes[0]) : "";
}

/**
 * Spec deltas for the change(s) this PR branch introduced, identified via a git
 * diff path list (e.g. from `git diff --name-only origin/<base>...HEAD`).
 *
 * Uses changeIdsFromPaths to find the branch-specific change IDs, then reads
 * their spec deltas. Returns "" when the branch introduced no OpenSpec changes —
 * unlike openspecContext which picks changes[0] and may return an unrelated
 * pre-existing change's deltas.
 */
export function openspecContextFromDiff(
  cfg: Pick<PipelineConfig, "openspec">,
  cwd: string,
  diffPaths: string[],
): string {
  if (!isActive(cfg, cwd)) return "";
  const ids = changeIdsFromPaths(diffPaths).filter((id) => changeDirExists(cwd, id));
  if (!ids.length) return "";
  return ids.map((id) => readSpecDeltas(cwd, id)).filter(Boolean).join("\n\n");
}

/**
 * Distinct active change ids referenced by a list of repo-relative paths
 * (matches `openspec/changes/<id>/…`, excludes the `archive` folder). Pure;
 * exported for tests. Used to find the change(s) a PR branch introduced.
 */
export function changeIdsFromPaths(paths: string[]): string[] {
  const ids = new Set<string>();
  for (const p of paths) {
    const m = p.replace(/\\/g, "/").match(/(?:^|\/)openspec\/changes\/([^/]+)\//);
    if (m && m[1] !== "archive") ids.add(m[1]);
  }
  return [...ids];
}

/**
 * Map an OpenSpec archive folder name to the change id it corresponds to.
 * Real archives use date-prefixed dirs (`YYYY-MM-DD-<id>`); bare ids are kept.
 * Pure; exported for tests.
 */
export function changeIdFromArchiveFolderName(folder: string): string {
  const m = folder.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  return m ? m[1] : folder;
}

/**
 * Residual probe from a cumulative PR changed-file list (#467 / #714). Pure
 * over path strings.
 *
 * - `activeIds` = ids appearing as `openspec/changes/<id>/…` (id ≠ `archive`)
 * - `archivedIds` = ids from `openspec/changes/archive/<folder>/…`, with
 *   date-prefixed folders (`YYYY-MM-DD-<id>`) normalized to bare `<id>`
 * - returns `activeIds \ archivedIds` (stable sort for deterministic reasons)
 *
 * **Limitation:** a cumulative PR file list can list both an archive path and a
 * later-reintroduced `openspec/changes/<id>/` for the same id; subtraction then
 * wrongly yields empty. Pre-merge MUST NOT use this helper as proof that no
 * active change remains on the reviewed tip — membership comes from tip-tree
 * views only: on-disk `listChangeDirs` when a worktree exists, or
 * `listPrHeadChangeDirs` (PR-head Contents API) when it does not (#714 review 2).
 * Kept for pure unit tests and any diagnostic path that accepts the limitation.
 */
export function unarchivedChangeIdsFromPrFiles(paths: string[]): string[] {
  const active = new Set<string>();
  const archived = new Set<string>();
  for (const raw of paths) {
    const p = raw.replace(/\\/g, "/");
    const archivedMatch = p.match(/(?:^|\/)openspec\/changes\/archive\/([^/]+)\//);
    if (archivedMatch) {
      // Record both the raw folder name and the date-stripped change id so
      // `archive/foo/` and `archive/2026-07-30-foo/` both clear active `foo`.
      archived.add(archivedMatch[1]);
      archived.add(changeIdFromArchiveFolderName(archivedMatch[1]));
      continue;
    }
    const activeMatch = p.match(/(?:^|\/)openspec\/changes\/([^/]+)\//);
    if (activeMatch && activeMatch[1] !== "archive") active.add(activeMatch[1]);
  }
  return [...active].filter((id) => !archived.has(id)).sort();
}

/**
 * Alias for the path-list residual helper. Prefer tip-tree membership
 * (`listChangeDirs` on the reviewed head) when a synchronized worktree exists.
 */
export const sharedActiveChangeIdsFromPaths = unarchivedChangeIdsFromPrFiles;

/**
 * Pure parser. Exit code is the source of truth for pass/fail (0 = valid). The
 * `--json` payload is parsed best-effort to surface issue messages; if it isn't
 * JSON we fall back to the raw text. Exported for tests.
 */
export function parseValidateResult(exitCode: number, output: string): ValidateResult {
  const raw = (output ?? "").trim();
  const valid = exitCode === 0;
  const issues: ValidationIssue[] = [];

  const jsonMatch = raw.match(/[[{][\s\S]*[\]}]/);
  if (jsonMatch) {
    try {
      collectIssues(JSON.parse(jsonMatch[0]), issues);
    } catch {
      /* not JSON — fall through to the text fallback below */
    }
  }

  if (!valid && issues.length === 0 && raw) {
    issues.push({ message: raw.slice(0, 1000) });
  }
  return { valid, issues, unavailable: false, raw: raw.slice(0, 4000) };
}

/**
 * Recursively pull issue messages out of an unknown OpenSpec JSON shape. The
 * documented `validate --json` shape nests `{ results: { changes: [...] } }`,
 * so we descend into structural containers as well as collecting message-ish
 * leaves.
 */
function collectIssues(data: unknown, out: ValidationIssue[]): void {
  if (typeof data === "string") {
    const s = data.trim();
    if (s) out.push({ message: s });
    return;
  }
  if (Array.isArray(data)) {
    for (const el of data) collectIssues(el, out);
    return;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["items", "issues", "results", "errors", "problems", "changes"]) {
      if (o[key] && typeof o[key] === "object") collectIssues(o[key], out);
    }
    const message =
      (typeof o.message === "string" && o.message) ||
      (typeof o.error === "string" && o.error) ||
      (typeof o.text === "string" && o.text) ||
      "";
    if (message) {
      const item =
        (typeof o.item === "string" && o.item) ||
        (typeof o.name === "string" && o.name) ||
        (typeof o.id === "string" && o.id) ||
        undefined;
      out.push(item ? { item, message } : { message });
    }
  }
}
