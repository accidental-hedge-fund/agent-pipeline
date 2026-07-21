// grok adapter — Grok Build CLI (#431 task 3). Argv verified on-machine
// against an installed `grok 0.2.93 (f00f9631)` (design.md decision 4):
//
//   grok --prompt-file <PATH> --cwd <CWD> --output-format plain --verbatim
//        --permission-mode <mode> [-m <model>] [--reasoning-effort <effort>]
//
// `--output-format json/streaming-json` exist but their payload SCHEMA is not
// verified (only the flag names are, per `grok --help`) — golden rule 5
// forbids guessing an unverified schema, so this adapter invokes with
// `--output-format plain` (guaranteed-usable assistant text as stdout) and
// declares `telemetry: "none"`, matching the pre-#431 treatment every
// third-party reviewer CLI already received. `parseTelemetry` degrades to
// nulls, same as no telemetry data at all — cost stays `cost_source:
// "unknown"`, unchanged from today's custom-CLI accounting.
//
// #492: `grok --help` documents `--prompt-file <PATH>` ("Single-turn prompt
// from a file") — the prompt no longer needs to fit in a single argv element.
// `runCapped`/`invoke()` materialize the file under the managed worktree root
// before spawn and remove it after the call completes.

import { randomUUID } from "node:crypto";
import * as path from "node:path";
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
  sandbox: true,
  workingDir: "flag",
  telemetry: "none",
};

export const grokAdapter: HarnessAdapter = {
  name: "grok",
  capabilities: CAPABILITIES,

  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
    // Pipeline-owned prompt file under the managed worktree root — the runner
    // materializes it before spawn and removes exactly this file afterward.
    const promptFilePath = path.join(ctx.worktreeDir, `.pipeline-prompt-${randomUUID()}.txt`);
    const args = [
      "--prompt-file",
      promptFilePath,
      "--cwd",
      ctx.worktreeDir,
      "--output-format",
      "plain",
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

  parseTelemetry(_capturedStdout: string): HarnessTelemetry {
    return EMPTY_TELEMETRY;
  },

  describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
    const nativeFlags: string[] = [];
    if (req.model) nativeFlags.push("-m");
    if (req.effort) nativeFlags.push("--reasoning-effort");
    return {
      adapter: "grok",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass,
      requestedModel: req.model ?? null,
      // grok's `--output-format plain` invocation carries no machine-readable
      // envelope (design.md — telemetry: "none"), so the actually-resolved
      // model/effort are unknown, never echoed from the request (review-2
      // finding 0b0c7e4b).
      resolvedModel: probe.resolvedModel ?? null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: null,
      nativeFlags,
      fallback: null,
      throttled: probe.throttled ?? null,
    };
  },
};
