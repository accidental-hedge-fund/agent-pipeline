// codex adapter — reproduces the pre-adapter argv byte-for-byte apart from
// prompt delivery (#431 task 2.2; #492 moved the prompt off argv) and the
// #613 managed-sandbox flag migration.
//
// codex: codex exec [--json] --sandbox workspace-write -C <worktreeDir> [-m X]
//        [-c model_reasoning_effort=Y] -
//        (the trailing `-` sentinel; prompt delivered on stdin, not as a
//        positional)
//        Managed path uses consecutive `--sandbox` + `workspace-write` (not
//        the deprecated `--full-auto` alias). On codex-cli 0.145.0, that shape
//        is session-equivalent to former `--full-auto`: `approval: never` +
//        `sandbox: workspace-write`. Post-`exec` approval-policy tokens
//        (`-a` / `--ask-for-approval`) are rejected by the CLI and are not
//        emitted; never-ask is the `codex exec` path default.
//        PIPELINE_CODEX_NO_SANDBOX=1 swaps the managed sandbox pair for
//        --dangerously-bypass-approvals-and-sandbox. #607 / #636: production
//        `invoke` resolves effective sandboxMode (explicit or ambient) once
//        before preflight and always passes it here. Ambient env is only a
//        fallback when `ctx.sandboxMode` is absent (non-invoke callers).
//
// #492: `codex exec --help` documents the prompt argument: "If not provided
// as an argument (or if `-` is used), instructions are read from stdin" — the
// explicit `-` sentinel (rather than omitting the positional) makes the
// stdin-read unambiguous regardless of any other positional-looking argv.

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
  // Codex never reports a per-call cost field, resolved model, or a
  // rate-limit/throttle signal (design.md — verified) — resolvedModel and
  // throttled stay unknown (null), never fabricated.
  return text === null && usage === null
    ? EMPTY_TELEMETRY
    : { text, costUsd: null, usage, resolvedModel: null, throttled: null };
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
  // already workspace-sandboxed via --sandbox workspace-write; harness_sandbox
  // opt is a no-op for codex (separate from the managed/bypass selector below)
  sandbox: false,
  workingDir: "flag",
  telemetry: "jsonl",
  // stdin delivery — no OS per-argument ceiling on the prompt payload (#779).
  maxPromptBytes: "unlimited",
};

export const codexAdapter: HarnessAdapter = {
  name: "codex",
  capabilities: CAPABILITIES,
  declaration: buildAdapterDeclaration({
    command: "codex",
    capabilities: CAPABILITIES,
    promptDelivery: "stdin",
    outputEnvelope: "jsonl",
    authProbe: "documented",
    versionProbe: "documented",
    origin: "builtin",
  }),

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const telemetryMode = harnessTelemetryEnabled();
    const noSandbox = ctx.sandboxMode !== undefined
      ? ctx.sandboxMode === "external-bypass"
      : process.env.PIPELINE_CODEX_NO_SANDBOX === "1";
    const args = ["exec"];
    if (telemetryMode) args.push("--json");
    // Managed: `--sandbox` + `workspace-write` (two argv elements). Do not emit
    // post-`exec` approval-policy tokens (`-a` / `--ask-for-approval`) — the
    // CLI rejects them after `exec`, and never-ask is the exec-path default
    // (#613 / codex-cli 0.145.0). Bypass is mutually exclusive with that pair.
    if (noSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--sandbox", "workspace-write");
    }
    args.push("-C", ctx.worktreeDir);
    if (ctx.model) args.push("-m", ctx.model);
    if (ctx.effort) args.push("-c", `model_reasoning_effort=${ctx.effort}`);
    args.push("-");
    return {
      cmd: "codex",
      args,
      cwd: ctx.worktreeDir,
      captureMode: telemetryMode ? "tail" : undefined,
      transformForward: telemetryMode ? makeCodexForwardTransform() : undefined,
      promptDelivery: "stdin",
      stdinPayload: ctx.prompt,
    };
  },

  async preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = await deps.execCheck("codex", ["--version"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "codex CLI not found on PATH — install it and run `codex login` to complete authentication.",
      };
    }
    // `capabilities.sandbox` is false: codex is always workspace-sandboxed via
    // its managed `--sandbox workspace-write` path (or explicit external
    // bypass via sandboxMode). The AdapterRequest.sandbox restricted-permission
    // flag is not a separate codex mode — refuse rather than silently drop
    // (#783 unsupported-capability contract). Callers that need external
    // bypass use sandboxMode on the invocation context, not this flag.
    if (req.sandbox) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message:
          "codex does not honor AdapterRequest.sandbox as a restricted-permission mode — it is always managed workspace-write (or external-bypass via sandboxMode).",
      };
    }
    // `codex login status` is codex's documented non-interactive login-state
    // probe (verified: prints "Logged in using ..." and exits 0 when
    // authenticated). An installed-but-logged-out CLI must fail this
    // distinctly from the missing-CLI case above, never be reported ready.
    const authRes = await deps.exec("codex", ["login", "status"]);
    if (!authRes.ok) {
      return {
        ok: false,
        failure: "unauthenticated",
        authState: "unauthenticated",
        message: "codex CLI is installed but not authenticated — run `codex login` to complete authentication.",
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
      // Codex's JSON telemetry never reports the model/effort it actually
      // resolved to (design.md — verified), so these stay unknown rather than
      // echoing the request (review-2 finding 0b0c7e4b).
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
    return defaultRuntimeSmoke("codex", deps);
  },
};
