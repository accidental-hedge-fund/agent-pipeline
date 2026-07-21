// opencode adapter — OpenCode CLI (npm `opencode-ai`, bin `opencode`, #431
// task 4). Argv verified via `npx --yes opencode-ai@latest --help` / `run
// --help` / `providers --help` (design.md decision 4):
//
//   opencode run <message> --dir <dir> [-m <provider/model>]
//             [--variant <effort>] --auto
//
// `--format json` ("raw JSON events") exists but its payload schema is not
// verified — same golden-rule-5 reasoning as the grok adapter: this adapter
// omits `--format json` (default text output, guaranteed usable downstream)
// and declares `telemetry: "none"`.
//
// `-m` requires a `provider/model` formatted value (design.md decision 4); a
// configured model with no `/` is rejected at preflight as an
// unsupported-setting failure rather than guessing a provider prefix.
//
// `--auto` ("auto-approve permissions not explicitly denied") is always
// passed — the default is unattended-unsafe for a headless pipeline run (it
// can block on a permission prompt with no TTY to answer it).
//
// #492: `opencode run --help` (re-read at implementation time — golden rule 5)
// documents no stdin or prompt-file channel for the message positional; `-f`
// attaches a file alongside the message, it does not replace it. This adapter
// therefore declares `promptDelivery: "argv"` explicitly rather than being
// assumed to support another channel — an oversize prompt on this adapter is
// refused by the pre-spawn guard in `runCapped` rather than silently
// truncated or guessed at.

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
  // opencode offers only `--auto` (auto-approve all permissions) or the
  // interactive default, which blocks headlessly with no TTY to answer a
  // permission prompt. There is no unattended *restricted* mode, so a
  // requested sandbox cannot actually be honored — declared unsupported
  // rather than silently widened (see preflight below).
  sandbox: false,
  workingDir: "flag",
  telemetry: "none",
};

export const opencodeAdapter: HarnessAdapter = {
  name: "opencode",
  capabilities: CAPABILITIES,

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const args = ["run", ctx.prompt, "--dir", ctx.worktreeDir];
    if (ctx.model) args.push("-m", ctx.model);
    if (ctx.effort) args.push("--variant", ctx.effort);
    // Always on for pipeline invocations (design.md decision 4): the default
    // (no --auto) is unattended-unsafe for a headless run. A requested
    // sandbox mode is rejected at preflight (capabilities.sandbox: false)
    // rather than reaching here and being silently widened.
    args.push("--auto");
    return { cmd: "opencode", args, cwd: ctx.worktreeDir, promptDelivery: "argv" };
  },

  async preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = await deps.execCheck("opencode", ["--version"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "opencode CLI not found on PATH — install via `npm i -g opencode-ai` and run `opencode auth login`.",
      };
    }
    if (req.model && !req.model.includes("/")) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message: `opencode requires a "provider/model" formatted model (got "${req.model}") — set it as e.g. "anthropic/claude-opus-4".`,
      };
    }
    if (req.sandbox) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message:
          "opencode has no unattended restricted-permission mode — only --auto (full auto-approve) or an interactive prompt (which blocks headlessly) are available, so a requested sandbox mode is unsupported.",
      };
    }
    const headless = await deps.execCheck("opencode", ["run", "--help"]);
    if (!headless) {
      return {
        ok: false,
        failure: "headless-unavailable",
        message: "opencode `run --help` failed — the non-interactive `run` subcommand is unavailable in this installed version.",
      };
    }
    // `opencode providers list` (alias `opencode auth`) lists configured
    // provider credentials — the closest thing to a login-state probe
    // (design.md decision 4). No documented flag reports auth state as clean
    // machine-readable JSON, so a non-empty listing is treated as
    // authenticated and a failing/empty listing as unauthenticated.
    const authRes = await deps.exec("opencode", ["providers", "list"]);
    if (!authRes.ok || !authRes.stdout.trim()) {
      return {
        ok: false,
        failure: "unauthenticated",
        authState: "unauthenticated",
        message: "opencode reported no configured providers — run `opencode auth login`.",
      };
    }
    return { ok: true, authState: "authenticated" };
  },

  parseTelemetry(_capturedStdout: string): HarnessTelemetry {
    return EMPTY_TELEMETRY;
  },

  describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
    const nativeFlags: string[] = [];
    if (req.model) nativeFlags.push("-m");
    if (req.effort) nativeFlags.push("--variant");
    return {
      adapter: "opencode",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass,
      requestedModel: req.model ?? null,
      // The default (non-`--format json`) invocation carries no
      // machine-readable envelope, so the actually-resolved model/effort are
      // unknown, never echoed from the request (review-2 finding 0b0c7e4b).
      resolvedModel: probe.resolvedModel ?? null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: null,
      nativeFlags,
      fallback: null,
      throttled: probe.throttled ?? null,
    };
  },
};
