// claude adapter — reproduces the pre-adapter argv byte-for-byte (#431 task 2.1).
//
// claude: claude --print --permission-mode bypassPermissions --verbose
//         --output-format stream-json --include-partial-messages
//         [--tools "" --strict-mcp-config] [--model X] [--effort Y] <prompt>
//
// #429: telemetry mode (`--verbose --output-format stream-json
// --include-partial-messages`) is the default; PIPELINE_HARNESS_TELEMETRY=off
// restores the pre-#429 plain-text argv (`--output-format text`).

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

/** `PIPELINE_HARNESS_TELEMETRY=off` is an escape-hatch kill-switch (#429), not
 *  a config surface: no `pipeline.yml` key. Shared by claude and codex. */
export function harnessTelemetryEnabled(): boolean {
  return process.env.PIPELINE_HARNESS_TELEMETRY !== "off";
}

/** Scans every `rate_limit_event` line (verified live: `{"type":
 *  "rate_limit_event", "rate_limit_info": {"status": "allowed" | ...}}`) for a
 *  non-"allowed" status. `null` when the stream carries no such event at all
 *  (telemetry disabled, or an older CLI that doesn't emit it) — that is
 *  "unknown", never "not throttled" (review-2 finding 0b0c7e4b). */
function scanClaudeThrottled(lines: string[]): boolean | null {
  let sawEvent = false;
  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!obj || obj.type !== "rate_limit_event") continue;
    sawEvent = true;
    const info = isJsonRecord(obj.rate_limit_info) ? obj.rate_limit_info : null;
    if (info && typeof info.status === "string" && info.status !== "allowed") return true;
  }
  return sawEvent ? false : null;
}

export function parseClaudeTelemetry(capturedStdout: string): HarnessTelemetry {
  const lines = capturedStdout.split("\n");
  const throttled = scanClaudeThrottled(lines);
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseJsonLine(lines[i]);
    if (!obj || obj.type !== "result") continue;
    const text = typeof obj.result === "string" ? obj.result : null;
    const costUsd =
      typeof obj.total_cost_usd === "number" && Number.isFinite(obj.total_cost_usd)
        ? obj.total_cost_usd
        : null;
    const usage = isJsonRecord(obj.usage) ? obj.usage : null;
    // The actual served model is a key of `modelUsage` (verified live) — the
    // requested `--model` value can be an alias, so this is the only reliable
    // resolved-model signal claude's envelope offers.
    const modelUsage = isJsonRecord(obj.modelUsage) ? obj.modelUsage : null;
    const resolvedModel = modelUsage ? Object.keys(modelUsage)[0] ?? null : null;
    return { text, costUsd, usage, resolvedModel, throttled };
  }
  return { ...EMPTY_TELEMETRY, throttled };
}

function extractClaudeForwardableText(obj: Record<string, unknown>): string | null {
  if (obj.type !== "stream_event" || !isJsonRecord(obj.event)) return null;
  const event = obj.event;
  if (
    event.type === "content_block_delta" &&
    isJsonRecord(event.delta) &&
    event.delta.type === "text_delta" &&
    typeof event.delta.text === "string"
  ) {
    return event.delta.text;
  }
  return null;
}

/** Build a stateful per-call transform that buffers partial JSON lines across
 *  chunk boundaries and forwards only the assistant text — raw envelope JSON
 *  is never forwarded (#429). */
export function makeClaudeForwardTransform(): (chunk: string) => string {
  let buffered = "";
  return (chunk: string): string => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      const obj = parseJsonLine(line);
      if (!obj) continue;
      const text = extractClaudeForwardableText(obj);
      if (text) out += text;
    }
    return out;
  };
}

const CAPABILITIES: AdapterCapabilities = {
  model: true,
  effort: true,
  sandbox: true,
  workingDir: "cwd",
  telemetry: "jsonl",
};

export const claudeAdapter: HarnessAdapter = {
  name: "claude",
  capabilities: CAPABILITIES,

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const telemetryMode = harnessTelemetryEnabled();
    const permMode = ctx.sandbox ? "default" : "bypassPermissions";
    const args = telemetryMode
      ? ["--print", "--permission-mode", permMode, "--verbose", "--output-format", "stream-json", "--include-partial-messages"]
      : ["--print", "--permission-mode", permMode, "--output-format", "text"];
    if (ctx.lean) {
      // Variadic `--tools` empty value must be placed before the trailing
      // prompt positional, never after — the variadic would otherwise
      // swallow the prompt.
      args.push("--tools", "", "--strict-mcp-config");
    }
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.effort) args.push("--effort", ctx.effort);
    args.push(ctx.prompt);
    return {
      cmd: "claude",
      args,
      cwd: ctx.worktreeDir,
      captureMode: telemetryMode ? "tail" : undefined,
      transformForward: telemetryMode ? makeClaudeForwardTransform() : undefined,
    };
  },

  async preflight(deps: AdapterPreflightDeps, _req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = await deps.execCheck("claude", ["--version"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "claude CLI not found on PATH — install it and run `claude` once to complete login.",
      };
    }
    // `claude auth status --json` is claude's documented non-interactive
    // login-state probe (verified: `{ "loggedIn": true, ... }` on stdout,
    // exit 0). An installed-but-logged-out CLI must fail this distinctly from
    // the missing-CLI case above, never be reported ready.
    const authRes = await deps.exec("claude", ["auth", "status", "--json"]);
    let loggedIn = false;
    if (authRes.ok) {
      try {
        loggedIn = (JSON.parse(authRes.stdout) as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        loggedIn = false;
      }
    }
    if (!loggedIn) {
      return {
        ok: false,
        failure: "unauthenticated",
        authState: "unauthenticated",
        message: "claude CLI is installed but not authenticated — run `claude` and complete login.",
      };
    }
    return { ok: true, authState: "authenticated" };
  },

  parseTelemetry: parseClaudeTelemetry,

  describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
    const nativeFlags: string[] = [];
    if (req.model) nativeFlags.push("--model");
    if (req.effort) nativeFlags.push("--effort");
    return {
      adapter: "claude",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass,
      requestedModel: req.model ?? null,
      // Recovered from the `result` envelope's `modelUsage` key when telemetry
      // is enabled (see parseClaudeTelemetry); unknown otherwise — never
      // echoed from the request (review-2 finding 0b0c7e4b).
      resolvedModel: probe.resolvedModel ?? null,
      requestedEffort: req.effort ?? null,
      // claude's envelope never reports the effort it actually resolved to.
      resolvedEffort: null,
      nativeFlags,
      fallback: null,
      throttled: probe.throttled ?? null,
    };
  },
};
