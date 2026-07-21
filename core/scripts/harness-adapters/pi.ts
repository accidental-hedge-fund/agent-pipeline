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
// No documented non-interactive login-status probe exists (only the
// interactive `/login`/`/logout` REPL commands and an `--api-key` override).
// Per design.md decision 7 ("preflight fails loudly rather than silently
// drop"), this is a genuine, accepted limitation: preflight reports this
// sub-check as `authState: "unknown"` — never a fabricated pass/fail — with
// an explicit message that the first real invocation is the actual auth
// test. `ok: true` is still returned (this is informational, not a block);
// doctor surfaces it as a distinct result rather than blocking the run.

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
  sandbox: true, // -a/--approve is the closest analogue; always-on for pipeline use
  workingDir: "cwd",
  telemetry: "none",
};

export const PI_NO_AUTH_PROBE_MESSAGE =
  "pi has no documented non-interactive auth-status probe — the first real invocation is the actual auth test.";

export const piAdapter: HarnessAdapter = {
  name: "pi",
  capabilities: CAPABILITIES,

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    const args = ["-p", ctx.prompt];
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.effort) args.push("--thinking", ctx.effort);
    args.push("-a");
    // No --cwd/-C flag exists (design.md decision 4) — cwd carries the
    // worktree directory for the spawned process instead.
    return { cmd: "pi", args, cwd: ctx.worktreeDir };
  },

  async preflight(deps: AdapterPreflightDeps, _req: AdapterRequest): Promise<AdapterPreflightResult> {
    const present = (await deps.execCheck("pi", ["--version"])) || (await deps.execCheck("pi", ["--help"]));
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "pi CLI not found on PATH — install `@mariozechner/pi-coding-agent` and complete /login once interactively.",
      };
    }
    const helpRes = await deps.exec("pi", ["--help"]);
    const headlessDocumented =
      helpRes.ok && (/-p\b|--print\b/.test(helpRes.stdout) || /--mode\b/.test(helpRes.stdout));
    if (helpRes.ok && !headlessDocumented) {
      return {
        ok: false,
        failure: "headless-unavailable",
        message: "pi --help does not document -p/--print — headless mode may be unavailable in this installed version.",
      };
    }
    // Documented, accepted limitation (design.md decision 4) — not a
    // fabricated pass/fail. See module comment above.
    return { ok: true, authState: "unknown", message: PI_NO_AUTH_PROBE_MESSAGE };
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
      resolvedModel: req.model ?? null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: req.effort ?? null,
      nativeFlags,
      fallback: false,
    };
  },
};
