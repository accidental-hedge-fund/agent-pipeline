// grok adapter — Grok Build CLI (#431 task 3; #778 telemetry flip).
//
// Argv verified on-machine against installed grok (design.md decision 4):
//
//   grok --no-auto-update --prompt-file <PATH> --cwd <CWD>
//        --output-format streaming-json|plain --verbatim
//        --permission-mode <mode> [-m <model>] [--reasoning-effort <effort>]
//
// #778: production telemetry uses `--output-format streaming-json` (fixture-
// verified under fixtures/grok/) so tail capture can retain the terminal
// `type:end` line with cost/usage/modelUsage even when earlier `type:text`
// deltas exceed MAX_OUTPUT. Single-document `--output-format json` remains
// parseable for fixtures/legacy captures but is NOT production argv: a
// truncated single JSON object is unrecoverable under tail capture.
// PIPELINE_HARNESS_TELEMETRY=off restores `--output-format plain` (kill-switch,
// same as claude/codex).
//
// #882: freeform product text is NOT reconstructed solely from the tail-
// capped raw JSONL. `makeGrokForwardTransform` deltas are accumulated into
// a head-preserving product side channel in `runCapped` so leading sections
// (e.g. plan-revision `## Feedback Incorporated`) survive for stage contracts
// while cost recovery still uses the terminal `type:end` in the raw tail.
//
// Throttled is never reported by the verified envelope → null (unknown),
// never fabricated false. resolvedModel comes only from `modelUsage` keys.
//
// #492: `grok --help` documents `--prompt-file <PATH>` ("Single-turn prompt
// from a file") — the prompt no longer needs to fit in a single argv element.
// `runCapped`/`invoke()` materialize the file under the managed worktree root
// before spawn and remove it after the call completes.

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { harnessTelemetryEnabled } from "./claude.ts";
import {
  EMPTY_TELEMETRY,
  buildAdapterDeclaration,
  defaultRuntimeSmoke,
  isJsonRecord,
  parseJsonLine,
  type AdapterCapabilities,
  type AdapterInvocation,
  type AdapterInvocationContext,
  type AdapterPreflightDeps,
  type AdapterPreflightResult,
  type AdapterProbe,
  type AdapterRequest,
  type HarnessAdapter,
  type HarnessTelemetry,
  type HarnessTreatment,
} from "./types.ts";

/**
 * Parse grok machine-readable capture into HarnessTelemetry (#778).
 *
 * Verified shapes (fixtures/grok/):
 *  - `--output-format streaming-json` (production): JSONL with `type:text`
 *    deltas and a final `type:end` carrying cost/usage/modelUsage — the end
 *    record remains recoverable under tail capture after large streams.
 *  - `--output-format json` (fixture/legacy): single JSON object with `text`,
 *    `total_cost_usd`, `usage`, `modelUsage` (resolved model = first key).
 *
 * Never throws; unparseable → EMPTY_TELEMETRY nulls. Never copies a requested
 * model into resolvedModel; never fabricates throttled false.
 */
export function parseGrokTelemetry(capturedStdout: string): HarnessTelemetry {
  const trimmed = capturedStdout.trim();
  if (!trimmed) return { ...EMPTY_TELEMETRY };

  // Prefer line-oriented streaming-json (production) so a tail-truncated
  // capture that still contains a complete `type:end` line recovers cost.
  const lines = capturedStdout.split("\n");
  let textParts: string[] = [];
  let fromEnd: HarnessTelemetry | null = null;
  let fromObjectLine: HarnessTelemetry | null = null;

  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (obj.type === "text" && typeof obj.data === "string") {
      textParts.push(obj.data);
    } else if (obj.type === "end") {
      fromEnd = telemetryFromGrokObject(obj, textParts.join("") || null);
    } else if (typeof obj.text === "string" || obj.total_cost_usd !== undefined) {
      // A full json-mode object emitted as a single line (legacy/fixture).
      fromObjectLine = telemetryFromGrokObject(obj);
    }
  }

  if (fromEnd) {
    if (fromEnd.text === null && textParts.length > 0) {
      return { ...fromEnd, text: textParts.join("") };
    }
    return fromEnd;
  }
  if (fromObjectLine) return fromObjectLine;
  if (textParts.length > 0) {
    return { text: textParts.join(""), costUsd: null, usage: null, resolvedModel: null, throttled: null };
  }

  // Whole capture is one JSON object (--output-format json fixture/legacy).
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (isJsonRecord(obj) && (typeof obj.text === "string" || obj.total_cost_usd !== undefined || isJsonRecord(obj.usage))) {
      return telemetryFromGrokObject(obj);
    }
  } catch {
    // unparseable
  }
  return { ...EMPTY_TELEMETRY };
}

function telemetryFromGrokObject(
  obj: Record<string, unknown>,
  textOverride: string | null = null,
): HarnessTelemetry {
  const text =
    textOverride !== null
      ? textOverride
      : typeof obj.text === "string"
        ? obj.text
        : null;
  const costUsd =
    typeof obj.total_cost_usd === "number" && Number.isFinite(obj.total_cost_usd)
      ? obj.total_cost_usd
      : null;
  const usage = isJsonRecord(obj.usage) ? obj.usage : null;
  const modelUsage = isJsonRecord(obj.modelUsage) ? obj.modelUsage : null;
  const resolvedModel = modelUsage ? Object.keys(modelUsage)[0] ?? null : null;
  // Verified grok envelopes do not report a throttle signal.
  return { text, costUsd, usage, resolvedModel, throttled: null };
}

/** Stateful per-call transform for streaming-json: buffer partial JSON lines
 *  across chunk boundaries and forward only `type:text` assistant deltas —
 *  raw envelope JSON is never forwarded (mirrors claude/codex #429). */
export function makeGrokForwardTransform(): (chunk: string) => string {
  let buffered = "";
  return (chunk: string): string => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      const obj = parseJsonLine(line);
      if (!obj) continue;
      if (obj.type === "text" && typeof obj.data === "string") {
        out += obj.data;
      }
    }
    return out;
  };
}

const CAPABILITIES: AdapterCapabilities = {
  model: true,
  effort: true,
  sandbox: true,
  workingDir: "flag",
  telemetry: "jsonl",
  // prompt-file delivery — no OS per-argument ceiling on the prompt payload (#779).
  maxPromptBytes: "unlimited",
};

export const grokAdapter: HarnessAdapter = {
  name: "grok",
  capabilities: CAPABILITIES,
  declaration: buildAdapterDeclaration({
    command: "grok",
    capabilities: CAPABILITIES,
    promptDelivery: "file",
    outputEnvelope: "jsonl",
    authProbe: "documented",
    versionProbe: "documented",
    origin: "builtin",
  }),

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const telemetryMode = harnessTelemetryEnabled();
    // Pipeline-owned prompt file under the managed worktree root — the runner
    // materializes it before spawn and removes exactly this file afterward.
    const promptFilePath = path.join(ctx.worktreeDir, `.pipeline-prompt-${randomUUID()}.txt`);
    const args = [
      // Headless pipeline runs should never spend a stage checking for or
      // applying a CLI update. Updates belong to the operator's maintenance
      // window, not a reproducible task worktree invocation.
      "--no-auto-update",
      "--prompt-file",
      promptFilePath,
      "--cwd",
      ctx.worktreeDir,
      "--output-format",
      // streaming-json (not single-document json): tail capture must retain a
      // complete terminal type:end line for cost/usage/model recovery (#778
      // review-2 543d8bde).
      telemetryMode ? "streaming-json" : "plain",
      "--verbatim",
      "--permission-mode",
      ctx.sandbox ? "default" : "bypassPermissions",
    ];
    if (ctx.model) args.push("-m", ctx.model);
    if (ctx.effort) args.push("--reasoning-effort", ctx.effort);
    return {
      cmd: "grok",
      args,
      cwd: ctx.worktreeDir,
      captureMode: telemetryMode ? "tail" : undefined,
      transformForward: telemetryMode ? makeGrokForwardTransform() : undefined,
      promptDelivery: "file",
      promptFile: { path: promptFilePath, content: ctx.prompt },
    };
  },

  async preflight(deps: AdapterPreflightDeps, _req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = await deps.execCheck("grok", ["--version"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "grok CLI not found on PATH — install Grok Build and run `grok login`.",
      };
    }
    // `grok models` is a lightweight authenticated-only probe (design.md
    // decision 4): it requires a completed login to succeed.
    const authRes = await deps.exec("grok", ["models"]);
    if (!authRes.ok) {
      return {
        ok: false,
        failure: "unauthenticated",
        authState: "unauthenticated",
        message: "grok CLI is installed but not authenticated — run `grok login`.",
      };
    }
    return { ok: true, authState: "authenticated" };
  },

  parseTelemetry: parseGrokTelemetry,

  describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
    const nativeFlags: string[] = [];
    if (req.model) nativeFlags.push("-m");
    if (req.effort) nativeFlags.push("--reasoning-effort");
    return {
      adapter: "grok",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass,
      requestedModel: req.model ?? null,
      // Recovered from modelUsage when telemetry is enabled; null otherwise —
      // never echoed from the request (review-2 finding 0b0c7e4b / #778).
      resolvedModel: probe.resolvedModel ?? null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: null,
      nativeFlags,
      fallback: null,
      throttled: probe.throttled ?? null,
      origin: "builtin",
    };
  },

  runtimeSmoke(deps: AdapterPreflightDeps): Promise<AdapterPreflightResult> {
    return defaultRuntimeSmoke("grok", deps);
  },
};
