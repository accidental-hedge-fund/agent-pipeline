// Custom-reviewer CLI compatibility adapter (#40 / #783).
//
// Unregistered harness names used as reviewer CLIs continue to resolve without
// a published package. The engine materializes a thin adapter through the
// public extension contract so invoke/doctor/preflight share one shape rather
// than a permanent raw-spawn branch.
//
// A full package registration for the same ID always wins: callers resolve
// registered adapters first and only materialize compatibility when the name
// is absent from the registry.

import {
  EMPTY_TELEMETRY,
  buildAdapterDeclaration,
  type AdapterInvocation,
  type AdapterInvocationContext,
  type AdapterPreflightDeps,
  type AdapterPreflightResult,
  type AdapterProbe,
  type AdapterRequest,
  type HarnessAdapter,
  type HarnessTelemetry,
  type HarnessTreatment,
  type PromptDeliveryChannel,
} from "./types.ts";

export interface CompatibilityAdapterOptions {
  /** Prompt-delivery channel from review_harness.prompt_delivery (default argv). */
  promptDelivery?: "argv" | "stdin";
}

/**
 * Materialize a thin public-contract adapter for an unregistered reviewer CLI.
 * Does NOT register into the runtime registry — full package registration for
 * the same ID remains authoritative when present.
 */
export function materializeCompatibilityAdapter(
  command: string,
  opts: CompatibilityAdapterOptions = {},
): HarnessAdapter {
  if (!command || !command.trim()) {
    throw new Error("materializeCompatibilityAdapter: command must be a non-empty string");
  }
  const promptDelivery: PromptDeliveryChannel = opts.promptDelivery === "stdin" ? "stdin" : "argv";
  const capabilities = {
    model: false,
    effort: false,
    sandbox: false,
    workingDir: "cwd" as const,
    telemetry: "none" as const,
  };
  const declaration = buildAdapterDeclaration({
    roles: ["reviewer"],
    command,
    capabilities,
    promptDelivery,
    modelValidation: "unsupported",
    effortValidation: "unsupported",
    outputEnvelope: "passthrough",
    authProbe: "none",
    versionProbe: "none",
    origin: "compatibility",
  });

  const adapter: HarnessAdapter = {
    name: command,
    capabilities,
    declaration,

    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      if (promptDelivery === "stdin") {
        return {
          cmd: command,
          args: [],
          cwd: ctx.worktreeDir,
          promptDelivery: "stdin",
          stdinPayload: ctx.prompt,
        };
      }
      return {
        cmd: command,
        args: [ctx.prompt],
        cwd: ctx.worktreeDir,
        promptDelivery: "argv",
      };
    },

    async preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult> {
      if (req.model) {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: `custom reviewer CLI "${command}" does not support model selection`,
        };
      }
      if (req.effort) {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: `custom reviewer CLI "${command}" does not support effort selection`,
        };
      }
      if (req.sandbox) {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: `custom reviewer CLI "${command}" does not support sandbox mode`,
        };
      }
      // PATH-only check: custom CLIs have no documented non-interactive auth probe.
      const present =
        (await deps.execCheck("which", [command])) ||
        (await deps.execCheck(command, ["--help"])) ||
        (await deps.execCheck(command, ["--version"]));
      if (!present) {
        // Absolute paths / scripts: try a zero-arg existence via which on basename
        // or direct execCheck of the command as a path.
        const pathPresent = command.includes("/")
          ? await deps.execCheck(command, ["--help"]).catch(() => false)
          : false;
        if (!pathPresent) {
          // Still allow absolute script paths that may not accept --help: doctor
          // uses which; for path-like commands accept which failure only when
          // the name has no slash.
          if (!command.includes("/")) {
            return {
              ok: false,
              failure: "missing-cli",
              message: `configured harness \`${command}\` was not found on PATH`,
            };
          }
        }
      }
      return { ok: true, authState: "unknown" };
    },

    parseTelemetry(_capturedStdout: string): HarnessTelemetry {
      return EMPTY_TELEMETRY;
    },

    describeTreatment(req: AdapterRequest, _inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment {
      return {
        adapter: command,
        cliVersion: probe.cliVersion,
        providerAuthClass: probe.providerAuthClass || "unknown",
        requestedModel: req.model ?? null,
        // Never invent a resolved model for a compatibility adapter.
        resolvedModel: null,
        requestedEffort: req.effort ?? null,
        resolvedEffort: null,
        nativeFlags: [],
        fallback: null,
        throttled: null,
        origin: "compatibility",
      };
    },

    async runtimeSmoke(deps: AdapterPreflightDeps): Promise<AdapterPreflightResult> {
      const onPath = await deps.execCheck("which", [command]);
      if (onPath) return { ok: true, authState: "unknown" };
      if (command.includes("/")) {
        // Path-like command: smoke is presence-only; preflight does deeper checks.
        return { ok: true, authState: "unknown" };
      }
      return {
        ok: false,
        failure: "missing-cli",
        message: `configured harness \`${command}\` was not found on PATH`,
      };
    },
  };

  return adapter;
}
