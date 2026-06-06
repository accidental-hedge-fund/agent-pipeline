// Typed wrappers for the OpenSpec CLI (https://openspec.dev).
//
// OpenSpec is a spec-driven-development layer: a target repo keeps living
// requirements under `openspec/specs/` and per-change deltas under
// `openspec/changes/`. The pipeline integrates OPT-IN. By default
// (`openspec.enabled: "auto"`) the integration activates only on repos that
// already have an `openspec/` directory, so the pipeline stays usable on any
// repo. "on"/"off" force it regardless of detection.
//
// This module is intentionally thin: it shells out via execFile (like gh.ts)
// and exposes a PURE parser (parseValidateResult) the tests cover without
// needing the `openspec` binary. Pass/fail is driven by the CLI's exit code —
// the documented, CI-friendly contract — with `--json` output parsed
// best-effort only to surface human-readable issue messages.

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

/**
 * Run `openspec validate --all --json` in `dir`. Never throws: a missing
 * binary or spawn error resolves to `{ valid: true, unavailable: true }` so a
 * tooling gap never hard-blocks the pipeline (the caller logs + skips).
 */
export async function validate(dir: string, timeoutMs = 60_000): Promise<ValidateResult> {
  try {
    const { stdout } = await execFileAsync("openspec", ["validate", "--all", "--json"], {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseValidateResult(0, stdout);
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    // ENOENT (binary missing) or spawn failure → unavailable, NOT invalid.
    if (e.code === "ENOENT") {
      return { valid: true, issues: [], unavailable: true, raw: e.message ?? "openspec not found" };
    }
    const exit = typeof e.code === "number" ? e.code : 1;
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return parseValidateResult(exit, out);
  }
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

/** Recursively pull issue messages out of an unknown OpenSpec JSON shape. */
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
    for (const key of ["issues", "results", "errors", "problems"]) {
      if (Array.isArray(o[key])) collectIssues(o[key], out);
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
