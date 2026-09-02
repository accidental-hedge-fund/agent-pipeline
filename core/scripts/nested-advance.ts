#!/usr/bin/env node
// Non-public nested whole-item executor (#1327).
//
// Supervisor dispatch (`realDispatchItem`) spawns this module instead of
// public `pipeline <N>`. Public numeric CLI admission never selects this
// path from `PIPELINE_NESTED_ADVANCE` or any other environment marker.

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.ts";
import { isKillSwitchActive } from "./lock.ts";
import { runAdvance, type AdvanceDeps, type AdvanceOpts } from "./pipeline-run.ts";
import type { PipelineConfig } from "./types.ts";

/** Absolute path of this child executor. Used as `realDispatchItem` default script. */
export const NESTED_ADVANCE_CHILD_SCRIPT = fileURLToPath(import.meta.url);

/**
 * Non-public nested whole-item adapter. Calls {@link runAdvance} with
 * handoff suppressed. Never constructs argv and never calls the one-item
 * supervisor.
 */
export async function runNestedWholeItemAdvance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts,
  deps?: AdvanceDeps,
): Promise<void> {
  await runAdvance(cfg, issueNumber, { ...opts, emitAdvanceHandoff: false }, deps);
}

export interface ParsedNestedAdvanceChildArgv {
  issueNumber: number;
  repoPath: string;
  opts: AdvanceOpts;
}

/** Inverse of `dispatchItemChildArgs` after the script-path slot. */
export function parseNestedAdvanceChildArgv(
  argv: readonly string[],
): ParsedNestedAdvanceChildArgv {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      profile: { type: "string" },
      "repo-path": { type: "string" },
      "run-id": { type: "string" },
      "engine-track": { type: "string" },
      once: { type: "boolean" },
      "dry-run": { type: "boolean" },
      model: { type: "string" },
      "json-events": { type: "boolean" },
      sha: { type: "string" },
    },
  });
  const raw = positionals[0];
  const issueNumber = Number.parseInt(raw ?? "", 10);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || String(issueNumber) !== raw) {
    throw new Error("nested advance child: <issue> is required and must be a positive integer");
  }
  if (positionals.length > 1) {
    throw new Error(`nested advance child: unexpected argument '${positionals[1]}'`);
  }
  const repoPath = values["repo-path"];
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("nested advance child: --repo-path is required");
  }
  const engineTrack = values["engine-track"];
  const sha = typeof values.sha === "string" ? values.sha.trim() : "";
  return {
    issueNumber,
    repoPath,
    opts: {
      profile: values.profile,
      runId: values["run-id"],
      ...(engineTrack === "pinned" || engineTrack === "candidate" ? { engineTrack } : {}),
      once: values.once,
      dryRun: values["dry-run"],
      model: values.model,
      jsonEvents: values["json-events"],
      ...(sha ? { candidateShaOverride: sha } : {}),
    },
  };
}

export interface NestedAdvanceChildDeps {
  resolveConfig?: typeof resolveConfig;
  runNestedWholeItemAdvance?: typeof runNestedWholeItemAdvance;
  isKillSwitchActive?: (domain: string) => boolean;
  writeStderr?: (msg: string) => void;
}

/**
 * Dedicated child entry. Parses the supervisor spawn argv and runs the
 * nested adapter. Does not enter public numeric CLI admission.
 */
export async function runNestedAdvanceChild(
  argv: readonly string[],
  deps: NestedAdvanceChildDeps = {},
): Promise<number> {
  const writeStderr = deps.writeStderr ?? ((msg: string) => {
    process.stderr.write(msg.endsWith("\n") ? msg : `${msg}\n`);
  });
  let parsed: ParsedNestedAdvanceChildArgv;
  try {
    parsed = parseNestedAdvanceChildArgv(argv);
  } catch (err) {
    writeStderr(`pipeline: ${(err as Error).message}`);
    return 2;
  }
  const resolve = deps.resolveConfig ?? resolveConfig;
  let cfg: PipelineConfig;
  try {
    cfg = resolve({ repoPath: parsed.repoPath, profile: parsed.opts.profile });
  } catch (err) {
    writeStderr(`pipeline: ${(err as Error).message}`);
    return 2;
  }
  if (parsed.opts.engineTrack === "pinned" || parsed.opts.engineTrack === "candidate") {
    cfg = { ...cfg, engine_track: parsed.opts.engineTrack };
  }
  const killSwitch = deps.isKillSwitchActive ?? isKillSwitchActive;
  if (killSwitch(cfg.domain)) {
    writeStderr(
      `pipeline: kill switch is active (/tmp/pipeline-${cfg.domain}.disabled). Remove it to re-enable.`,
    );
    return 0;
  }
  const runNested = deps.runNestedWholeItemAdvance ?? runNestedWholeItemAdvance;
  try {
    await runNested(cfg, parsed.issueNumber, parsed.opts);
    return 0;
  } catch (err) {
    writeStderr(`pipeline: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] === NESTED_ADVANCE_CHILD_SCRIPT) {
  runNestedAdvanceChild(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
