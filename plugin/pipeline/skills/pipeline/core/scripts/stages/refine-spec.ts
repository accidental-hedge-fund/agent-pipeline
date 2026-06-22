// refine-spec sub-command (#295): takes an existing issue title and body,
// generates a refined spec via a single model harness call, and writes the
// result as a JSON object to stdout.
//
// Non-mutating by design: no GitHub writes, no git writes, no filesystem writes.
// The RefineSpecDeps interface has no write-capable slots — the guarantee is
// structural, not behavioral.

import { invoke } from "../harness.ts";
import { buildRefineSpecPrompt } from "../prompts/index.ts";
import { DEFAULT_CONFIG } from "../types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RefineSpecOpts {
  title: string;
  body: string;
}

export interface RefineSpecResult {
  title: string;
  body: string;
  milestone: string | null;
}

export interface RefineSpecDeps {
  /** Invoke the spec-refinement model harness with the given prompt. Returns the raw stdout. */
  runHarness(prompt: string): Promise<{ success: boolean; output: string; timed_out?: boolean }>;
  /** Write a progress/diagnostic message to stderr. */
  log(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realRefineSpecDeps(
  repoDir: string,
  model: string = DEFAULT_CONFIG.models.intake,
): RefineSpecDeps {
  return {
    runHarness: async (prompt) => {
      const result = await invoke("claude", repoDir, prompt, {
        stream: true,
        model,
        lean: true,
        timeoutSec: DEFAULT_CONFIG.intake_timeout,
      });
      return { success: result.success, output: result.stdout, timed_out: result.timed_out };
    },
    log: (msg) => process.stderr.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Result shape validation
// ---------------------------------------------------------------------------

/**
 * Validate that the parsed harness response has the required fields and types.
 * Returns an error message on failure, or null on success.
 */
export function validateRefineSpecResult(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "harness response is not a JSON object";
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.title !== "string" || obj.title.length === 0) {
    return 'missing or empty required field "title" (must be a non-empty string)';
  }
  if (typeof obj.body !== "string" || obj.body.length === 0) {
    return 'missing or empty required field "body" (must be a non-empty string)';
  }
  if (obj.milestone !== null && typeof obj.milestone !== "string") {
    return 'required field "milestone" must be a string or null';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runRefineSpec(
  opts: RefineSpecOpts,
  deps: RefineSpecDeps,
): Promise<void> {
  // 1. Validate inputs.
  if (!opts.title || !opts.title.trim()) {
    process.stderr.write(
      "pipeline refine-spec: --title is required.\n" +
        '  Usage: pipeline refine-spec --title "<title>" --body "<body>"\n',
    );
    process.exitCode = 2;
    return;
  }
  if (!opts.body || !opts.body.trim()) {
    process.stderr.write(
      "pipeline refine-spec: --body is required.\n" +
        '  Usage: pipeline refine-spec --title "<title>" --body "<body>"\n',
    );
    process.exitCode = 2;
    return;
  }

  // 2. Render the prompt.
  const prompt = buildRefineSpecPrompt({ title: opts.title.trim(), body: opts.body.trim() });

  // 3. Invoke the harness (exactly once).
  deps.log("[pipeline refine-spec] generating refined spec via model harness...");
  let harnessOutput: string;
  try {
    const result = await deps.runHarness(prompt);
    if (!result.success) {
      const timeoutMsg = result.timed_out
        ? ` (timed out after ${DEFAULT_CONFIG.intake_timeout}s)`
        : "";
      process.stderr.write(
        `pipeline refine-spec: harness call failed${timeoutMsg} — check output above for details.\n`,
      );
      process.exitCode = 1;
      return;
    }
    harnessOutput = result.output;
  } catch (err) {
    process.stderr.write(`pipeline refine-spec: harness error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // 4. Parse the response as JSON.
  let parsed: unknown;
  try {
    // Strip a surrounding code fence if the model wrapped the JSON anyway.
    const stripped = harnessOutput.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/s, "$1").trim();
    parsed = JSON.parse(stripped);
  } catch {
    process.stderr.write(
      `pipeline refine-spec: harness returned non-JSON output.\n` +
        `  First 500 chars: ${harnessOutput.slice(0, 500)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 5. Validate shape.
  const shapeError = validateRefineSpecResult(parsed);
  if (shapeError) {
    process.stderr.write(
      `pipeline refine-spec: harness response has wrong shape: ${shapeError}.\n` +
        `  First 500 chars: ${harnessOutput.slice(0, 500)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 6. Emit validated result to stdout and exit 0.
  const result = parsed as RefineSpecResult;
  const output: RefineSpecResult = {
    title: result.title,
    body: result.body,
    milestone: result.milestone ?? null,
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exitCode = 0;
}
