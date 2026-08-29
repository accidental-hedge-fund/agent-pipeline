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
  BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  EMPTY_TELEMETRY,
  MAX_ARGV_PROMPT_BYTES,
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

/** True when the command looks like a filesystem path rather than a PATH name. */
function isPathLikeCommand(command: string): boolean {
  return command.includes("/") || command.startsWith(".");
}

/**
 * Presence probe for a custom reviewer command. PATH names use `which` +
 * version/help probes. Path-like commands (absolute or relative) require an
 * injectable executability check (`fsExecutable`) or a successful direct
 * spawn probe — mere path existence is not enough (non-executable files and
 * directories must fail closed as missing-cli).
 */
async function isCommandPresent(
  deps: AdapterPreflightDeps,
  command: string,
): Promise<boolean> {
  if (await deps.execCheck("which", [command])) return true;

  if (isPathLikeCommand(command)) {
    // Executable regular file (not a directory / non-executable path).
    if (typeof deps.fsExecutable === "function") {
      if (await deps.fsExecutable(command)) return true;
    }
    // Direct probes: a real executable path may answer --version/--help even
    // when the injectable seam is absent. Existence-only (fsExists) must not
    // report ready.
    if (await deps.execCheck(command, ["--version"]).catch(() => false)) return true;
    if (await deps.execCheck(command, ["--help"]).catch(() => false)) return true;
    return false;
  }

  return (
    (await deps.execCheck(command, ["--version"])) ||
    (await deps.execCheck(command, ["--help"]))
  );
}

/**
 * Materialize a thin public-contract adapter for an unregistered reviewer CLI.
 * Does NOT register into the runtime registry — full package registration for
 * the same ID remains authoritative when present.
 *
 * Model and effort follow the legacy object-form `review_harness` treatment:
 * values are accepted (open) and recorded on treatment identity, not refused.
 * Unconstrained CLIs have no standard flag vocabulary, so buildInvocation does
 * not invent `--model` / `--effort` argv; sandbox remains unsupported.
 */
export function materializeCompatibilityAdapter(
  command: string,
  opts: CompatibilityAdapterOptions = {},
): HarnessAdapter {
  if (!command || !command.trim()) {
    throw new Error("materializeCompatibilityAdapter: command must be a non-empty string");
  }
  const promptDelivery: PromptDeliveryChannel = opts.promptDelivery === "stdin" ? "stdin" : "argv";
  // Open model/effort: retain configured review_harness object-form settings
  // without inventing a closed catalog or refusing at preflight (#783 review).
  // #779: default argv → finite MAX_ARGV_PROMPT_BYTES; stdin → unlimited.
  const capabilities = {
    model: true,
    effort: true,
    sandbox: false,
    workingDir: "cwd" as const,
    telemetry: "none" as const,
    maxPromptBytes:
      promptDelivery === "stdin" ? ("unlimited" as const) : MAX_ARGV_PROMPT_BYTES,
    background_job_lifecycle: BACKGROUND_JOB_LIFECYCLE_UNSUPPORTED,
  };
  const declaration = buildAdapterDeclaration({
    roles: ["reviewer"],
    command,
    executableResolution: isPathLikeCommand(command) ? "absolute" : "path",
    capabilities,
    promptDelivery,
    modelValidation: "open",
    effortValidation: "open",
    outputEnvelope: "passthrough",
    authProbe: "none",
    versionProbe: "none",
    origin: "compatibility",
  });

  const missingCli = (): AdapterPreflightResult => ({
    ok: false,
    failure: "missing-cli",
    message: isPathLikeCommand(command)
      ? `configured harness \`${command}\` was not found at that path (or is not executable)`
      : `configured harness \`${command}\` was not found on PATH`,
  });

  const adapter: HarnessAdapter = {
    name: command,
    capabilities,
    declaration,

    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      // Legacy custom-CLI spawn: prompt only (argv or stdin). Model/effort are
      // accepted at the contract surface and recorded on treatment, not turned
      // into invented CLI flags for an unconstrained command.
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
      // Model/effort are open — do not refuse configured object-form values.
      if (req.sandbox) {
        return {
          ok: false,
          failure: "unsupported-setting",
          message: `custom reviewer CLI "${command}" does not support sandbox mode`,
        };
      }
      if (!(await isCommandPresent(deps, command))) {
        return missingCli();
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
        // No native model/effort flags for unconstrained custom CLIs.
        nativeFlags: [],
        fallback: null,
        throttled: null,
        origin: "compatibility",
      };
    },

    async runtimeSmoke(deps: AdapterPreflightDeps): Promise<AdapterPreflightResult> {
      if (!(await isCommandPresent(deps, command))) {
        return missingCli();
      }
      return { ok: true, authState: "unknown" };
    },
  };

  return adapter;
}
