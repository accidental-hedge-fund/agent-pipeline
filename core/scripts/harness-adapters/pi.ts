// pi adapter — Pi Coding Agent CLI (`@mariozechner/pi-coding-agent`, #431
// task 4). Argv verified via the project's README.md at
// github.com/badlogic/pi-mono (design.md decision 4):
//
//   pi -p <PROMPT> [--model <pattern>] [--thinking <level>] -a
//
// `--mode json` ("output all events as JSON lines") exists but its payload
// schema is not verified — same golden-rule-5 reasoning as grok/opencode:
// this adapter omits it and declares `telemetry: "none"`.
//
// No documented `--cwd`/`-C` flag exists — pi operates on the process's
// current working directory, so `workingDir: "cwd"` and the adapter relies
// entirely on the spawn cwd (set by the invoke() dispatcher), never a flag.
//
// `-a`/`--approve` is always passed (unattended headless run, no TTY to
// answer a trust prompt).
//
// `pi --list-models` is pi's lightweight authenticated-only probe (verified
// live against the current CLI, review-2 finding 73d2e88a): with no login
// completed it prints "No models available. Use /login ..." on stdout and
// exits 0, so exit code alone can't distinguish the states, but the message
// text can — same "empty vs populated listing" shape as `opencode providers
// list`. A logged-in installation lists actual model entries instead. This
// replaces the earlier `authState: "unknown"` pass-through: pi's preflight
// now fails closed with `unauthenticated` when the listing comes back empty,
// rather than letting an unverified auth state reach stage invocation.

import {
  EMPTY_TELEMETRY,
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

const CAPABILITIES: AdapterCapabilities = {
  model: true,
  effort: true,
  // pi offers only `-a`/`--approve` (unattended auto-approve) or the
  // interactive `-na`/`--no-approve` prompt, which blocks headlessly with no
  // TTY to answer it. There is no unattended *restricted* mode, so a
  // requested sandbox cannot actually be honored — declared unsupported
  // rather than silently widened (see preflight below).
  sandbox: false,
  workingDir: "cwd",
  telemetry: "none",
};

// `--thinking <level>` documented enum (verified live, design.md decision 4)
// — review-2 finding 16ab70d8: an invalid effort must fail preflight rather
// than reach invocation and fail only after the stage has begun.
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const PI_NO_MODELS_MARKER = "No models available";

export const piAdapter: HarnessAdapter = {
  name: "pi",
  capabilities: CAPABILITIES,

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const args = ["-p", ctx.prompt];
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.effort) args.push("--thinking", ctx.effort);
    // Always on for pipeline invocations (unattended headless run, no TTY to
    // answer a trust prompt). A requested sandbox mode is rejected at
    // preflight (capabilities.sandbox: false) rather than reaching here and
    // being silently widened.
    args.push("-a");
    // No --cwd/-C flag exists (design.md decision 4) — cwd carries the
    // worktree directory for the spawned process instead.
    return { cmd: "pi", args, cwd: ctx.worktreeDir };
  },

  async preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = (await deps.execCheck("pi", ["--version"])) || (await deps.execCheck("pi", ["--help"]));
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "pi CLI not found on PATH — install `@mariozechner/pi-coding-agent` and complete /login once interactively.",
      };
    }
    if (req.sandbox) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message:
          "pi has no unattended restricted-permission mode — only -a/--approve (full auto-approve) or an interactive prompt (which blocks headlessly) are available, so a requested sandbox mode is unsupported.",
      };
    }
    if (req.effort && !PI_THINKING_LEVELS.has(req.effort)) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message: `pi --thinking accepts one of ${[...PI_THINKING_LEVELS].join("|")} — requested effort "${req.effort}" is unsupported.`,
      };
    }
    const helpRes = await deps.exec("pi", ["--help"]);
    if (!helpRes.ok) {
      return {
        ok: false,
        failure: "headless-unavailable",
        message: "pi --help failed to run — headless mode cannot be verified in this installation.",
      };
    }
    const headlessDocumented = /-p\b|--print\b/.test(helpRes.stdout) || /--mode\b/.test(helpRes.stdout);
    if (!headlessDocumented) {
      return {
        ok: false,
        failure: "headless-unavailable",
        message: "pi --help does not document -p/--print — headless mode may be unavailable in this installed version.",
      };
    }
    // `pi --list-models` prints "No models available. Use /login ..." and
    // exits 0 when no provider is authenticated, vs. an actual model listing
    // when one is (verified live, review-2 finding 73d2e88a — see module
    // comment above). Exit code can't distinguish the states; message text can.
    const modelsRes = await deps.exec("pi", ["--list-models"]);
    if (!modelsRes.ok || modelsRes.stdout.includes(PI_NO_MODELS_MARKER)) {
      return {
        ok: false,
        failure: "unauthenticated",
        authState: "unauthenticated",
        message: "pi reported no available models — run pi interactively once and complete /login.",
      };
    }
    return { ok: true, authState: "authenticated" };
  },

  parseTelemetry(_capturedStdout: string): HarnessTelemetry {
    return EMPTY_TELEMETRY;
  },

  describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
    const nativeFlags: string[] = [];
    if (req.model) nativeFlags.push("--model");
    if (req.effort) nativeFlags.push("--thinking");
    return {
      adapter: "pi",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass,
      requestedModel: req.model ?? null,
      // pi has no machine-readable per-call output enabled (telemetry:
      // "none"), so the actually-resolved model/effort are unknown, never
      // echoed from the request (review-2 finding 0b0c7e4b).
      resolvedModel: probe.resolvedModel ?? null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: null,
      nativeFlags,
      fallback: null,
      throttled: probe.throttled ?? null,
    };
  },
};
