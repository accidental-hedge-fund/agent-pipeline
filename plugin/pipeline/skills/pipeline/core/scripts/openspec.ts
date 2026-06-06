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
// exposes a PURE parser (parseValidateResult) the tests cover without needing
// the `openspec` binary. Pass/fail is driven by the CLI's exit code — the
// documented, CI-friendly contract — with `--json` output parsed best-effort
// only to surface human-readable issue messages.

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
}

/** `openspec archive <name> --yes` — merges delta specs and moves the change to archive/. */
export async function archive(dir: string, name: string, timeoutMs = 60_000): Promise<ArchiveResult> {
  const r = await runOpenspec(dir, ["archive", name, "--yes"], timeoutMs);
  return {
    success: r.code === 0 && !r.unavailable,
    unavailable: r.unavailable,
    output: `${r.stdout}${r.stderr}`.trim(),
  };
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
    for (const key of ["issues", "results", "errors", "problems", "changes"]) {
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
