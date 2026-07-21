// codex adapter — reproduces the pre-adapter argv byte-for-byte (#431 task 2.2).
//
// codex: codex exec [--json] --full-auto -C <worktreeDir> [-m X]
//        [-c model_reasoning_effort=Y] <prompt>
//        PIPELINE_CODEX_NO_SANDBOX=1 swaps --full-auto for
//        --dangerously-bypass-approvals-and-sandbox.

import {
  EMPTY_TELEMETRY,
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
import { harnessTelemetryEnabled } from "./claude.ts";

export function parseCodexTelemetry(capturedStdout: string): HarnessTelemetry {
  const lines = capturedStdout.split("\n");
  let text: string | null = null;
  let usage: Record<string, unknown> | null = null;
  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!obj) continue;
    if (
      obj.type === "item.completed" &&
      isJsonRecord(obj.item) &&
      obj.item.type === "agent_message" &&
      typeof obj.item.text === "string"
    ) {
      text = obj.item.text;
    } else if (obj.type === "turn.completed" && isJsonRecord(obj.usage)) {
      usage = obj.usage;
    }
  }
  // Codex never reports a per-call cost field (design.md — verified).
  return text === null && usage === null ? EMPTY_TELEMETRY : { text, costUsd: null, usage };
}

function extractCodexForwardableText(obj: Record<string, unknown>): string | null {
  if (
    obj.type === "item.completed" &&
    isJsonRecord(obj.item) &&
    obj.item.type === "agent_message" &&
    typeof obj.item.text === "string"
  ) {
    return `${obj.item.text}\n`;
  }
  return null;
}

export function makeCodexForwardTransform(): (chunk: string) => string {
  let buffered = "";
  return (chunk: string): string => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      const obj = parseJsonLine(line);
      if (!obj) continue;
      const text = extractCodexForwardableText(obj);
      if (text) out += text;
    }
    return out;
  };
}

const CAPABILITIES: AdapterCapabilities = {
  model: true,
  effort: true,
  sandbox: false, // already workspace-sandboxed via --full-auto; sandbox opt is a no-op
  workingDir: "flag",
  telemetry: "jsonl",
};

export const codexAdapter: HarnessAdapter = {
  name: "codex",
  capabilities: CAPABILITIES,

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const telemetryMode = harnessTelemetryEnabled();
    const noSandbox = process.env.PIPELINE_CODEX_NO_SANDBOX === "1";
    const args = ["exec"];
    if (telemetryMode) args.push("--json");
    args.push(noSandbox ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto", "-C", ctx.worktreeDir);
    if (ctx.model) args.push("-m", ctx.model);
    if (ctx.effort) args.push("-c", `model_reasoning_effort=${ctx.effort}`);
    args.push(ctx.prompt);
    return {
      cmd: "codex",
      args,
      cwd: ctx.worktreeDir,
      captureMode: telemetryMode ? "tail" : undefined,
      transformForward: telemetryMode ? makeCodexForwardTransform() : undefined,
    };
  },

  async preflight(deps: AdapterPreflightDeps, _req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = await deps.execCheck("codex", ["--version"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "codex CLI not found on PATH — install it and run `codex login` to complete authentication.",
      };
    }
    return { ok: true, authState: "authenticated" };
  },

  parseTelemetry: parseCodexTelemetry,

  describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
    const nativeFlags: string[] = [];
    if (req.model) nativeFlags.push("-m");
    if (req.effort) nativeFlags.push("-c model_reasoning_effort");
    return {
      adapter: "codex",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass,
      requestedModel: req.model ?? null,
      resolvedModel: req.model ?? null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: req.effort ?? null,
      nativeFlags,
      fallback: false,
    };
  },
};
