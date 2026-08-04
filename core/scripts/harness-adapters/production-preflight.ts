// Production preflight-on-invoke for the exact resolved harness treatment (#636).
//
// One choke point used by `harness.invoke` before `buildInvocation` / spawn:
// prompt-size (#779), absolute executable readiness, role eligibility, and
// `adapter.preflight` with the exact resolved {model, effort, sandbox}.
// Built-in, extension, and compatibility adapters share this path.
//
// Consumes the once-per-run version/binary probe (#778) — does not add a second
// always-on per-call version exec. Version drift remains fail-soft; missing CLI
// and capability refusals block.

import {
  probeCliVersionOnce,
  resolveCommandPath,
  type CliVersionProbeDeps,
  type CliVersionProbeResult,
} from "./cli-version-probe.ts";
import {
  adapterSupportsRole,
  checkMaterializedPromptBytes,
  type AdapterPreflightDeps,
  type AdapterPreflightFailure,
  type AdapterPreflightResult,
  type AdapterRequest,
  type AdapterRole,
  type HarnessAdapter,
  type MaxPromptBytes,
  type PromptDeliveryChannel,
} from "./types.ts";

/** Exact resolved treatment handed to production preflight-on-invoke. */
export interface ProductionPreflightRequest extends AdapterRequest {
  /** Stage role when known (implementer / reviewer). */
  role?: AdapterRole | null;
  /** Fully materialized prompt text for the #779 size check. */
  prompt: string;
  /**
   * Resolved sandbox/tool policy identity the invocation will apply (e.g.
   * managed sandboxMode). Distinct from AdapterRequest.sandbox restricted-
   * permission flag; recorded for diagnostics when provided.
   */
  sandboxMode?: string | null;
}

/** Distinguishable production-gate failure classes (superset of adapter preflight). */
export type ProductionPreflightFailureClass =
  | AdapterPreflightFailure
  | "prompt-limit"
  | "role-ineligible"
  | "missing-executable";

/** #760-compatible stage-diagnostic reason codes used for preflight refusals. */
export type ProductionPreflightReasonCode = "environment-auth" | "capability-refusal";

/** #760-compatible human intervention kind for preflight refusals. */
export type ProductionPreflightInterventionKind = "auth-tooling-preflight-failure";

export interface ProductionPreflightRemediation {
  /** Structured failure class. */
  failure: ProductionPreflightFailureClass;
  /** #760 reason code for stage-diagnostic / durable classification. */
  reasonCode: ProductionPreflightReasonCode;
  /** #760 intervention kind. */
  interventionKind: ProductionPreflightInterventionKind;
  /** Operator-actionable message (never credentials). */
  message: string;
}

export interface ProductionPreflightOk {
  ok: true;
  /** Absolute CLI path when resolution succeeded; null when unknown. */
  cliPath: string | null;
  /** Cached once-per-run version probe result (may be probeOk:false). */
  versionProbe: CliVersionProbeResult;
  /** Measured UTF-8 prompt bytes. */
  promptBytes: number;
  /** Echo of the exact AdapterRequest passed to adapter.preflight. */
  adapterRequest: AdapterRequest;
  /** Role checked (or null when caller did not supply one). */
  role: AdapterRole | null;
}

export interface ProductionPreflightFail {
  ok: false;
  remediation: ProductionPreflightRemediation;
  cliPath: string | null;
  versionProbe: CliVersionProbeResult | null;
  promptBytes: number | null;
  /** Echo of the request when available. */
  adapterRequest: AdapterRequest;
  role: AdapterRole | null;
}

export type ProductionPreflightResult = ProductionPreflightOk | ProductionPreflightFail;

/** Injectable deps for production preflight (tests inject fakes; no real I/O). */
export interface ProductionPreflightDeps {
  /** Adapter preflight I/O seam. */
  preflight: AdapterPreflightDeps;
  /** Once-per-run version probe (defaults share global cache). */
  versionProbe?: CliVersionProbeDeps;
  /**
   * Absolute-path resolver for PATH commands. Defaults to resolveCommandPath
   * via versionProbe/preflight exec.
   */
  resolvePath?: (command: string) => Promise<string | null>;
}

/**
 * Project an adapter / production preflight failure into #760 remediation.
 * Pure — no I/O.
 */
export function projectPreflightRemediation(
  adapterName: string,
  failure: ProductionPreflightFailureClass,
  detail: string,
  opts?: { setting?: string; value?: string },
): ProductionPreflightRemediation {
  const settingBit =
    opts?.setting != null
      ? ` (setting: ${opts.setting}${opts.value != null ? `=${opts.value}` : ""})`
      : "";
  let reasonCode: ProductionPreflightReasonCode;
  switch (failure) {
    case "missing-cli":
    case "missing-executable":
    case "unauthenticated":
      reasonCode = "environment-auth";
      break;
    case "unsupported-setting":
    case "headless-unavailable":
    case "prompt-limit":
    case "role-ineligible":
      reasonCode = "capability-refusal";
      break;
    default:
      reasonCode = "capability-refusal";
  }
  const base =
    detail.trim().length > 0
      ? detail.trim()
      : `[harness ${adapterName}] production preflight failed: ${failure}${settingBit}`;
  const withAdapter = base.includes(adapterName) ? base : `[harness ${adapterName}] ${base}`;
  return {
    failure,
    reasonCode,
    interventionKind: "auth-tooling-preflight-failure",
    message: withAdapter,
  };
}

/**
 * Resolve a declared adapter command to an absolute path when possible.
 * Injectable; unit tests never need a real PATH.
 */
export async function resolveAbsoluteExecutable(
  command: string,
  resolution: "path" | "absolute",
  deps: {
    resolvePath?: (command: string) => Promise<string | null>;
    exec?: CliVersionProbeDeps["exec"];
  },
): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (resolution === "absolute" || trimmed.startsWith("/") || trimmed.startsWith(".")) {
    // Already path-like — return as-is when absolute; leave relative for fs checks.
    return trimmed.startsWith("/") ? trimmed : trimmed;
  }
  if (deps.resolvePath) {
    try {
      return (await deps.resolvePath(trimmed)) ?? null;
    } catch {
      return null;
    }
  }
  if (deps.exec) {
    return resolveCommandPath(trimmed, { exec: deps.exec });
  }
  return null;
}

/**
 * Single production preflight-before-invoke helper (#636).
 *
 * Ordering:
 * 1. #779 prompt-size against adapter maxPromptBytes
 * 2. Role eligibility when role is supplied
 * 3. Absolute executable resolution (record when known)
 * 4. Once-per-run version/binary probe (shared cache; fail-soft on version alone)
 * 5. adapter.preflight with exact resolved AdapterRequest
 *
 * Never substitutes an ambient model or another adapter.
 */
export async function runProductionPreflight(
  adapter: HarnessAdapter,
  req: ProductionPreflightRequest,
  deps: ProductionPreflightDeps,
): Promise<ProductionPreflightResult> {
  const adapterRequest: AdapterRequest = {
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.effort !== undefined ? { effort: req.effort } : {}),
    ...(req.sandbox !== undefined ? { sandbox: req.sandbox } : {}),
  };
  const role = req.role ?? null;
  const command = adapter.declaration.executable.command;
  const resolution = adapter.declaration.executable.resolution;

  // 1. Prompt-size gate (#779) — before any spawn / buildInvocation.
  const limitCheck = checkMaterializedPromptBytes(
    adapter.capabilities.maxPromptBytes as MaxPromptBytes,
    req.prompt,
    {
      adapterName: adapter.name,
      delivery: adapter.declaration.prompt.delivery as PromptDeliveryChannel,
    },
  );
  if (!limitCheck.ok) {
    return {
      ok: false,
      remediation: projectPreflightRemediation(adapter.name, "prompt-limit", limitCheck.message),
      cliPath: null,
      versionProbe: null,
      promptBytes: limitCheck.measured,
      adapterRequest,
      role,
    };
  }

  // 2. Role eligibility when the caller named a role.
  if (role != null && !adapterSupportsRole(adapter, role)) {
    const msg =
      `[harness ${adapter.name}] adapter does not declare role "${role}" — ` +
      `declared roles: ${adapter.declaration.roles.join(", ") || "(none)"}. ` +
      `Assign a role-capable adapter; the pipeline will not fall back to another harness.`;
    return {
      ok: false,
      remediation: projectPreflightRemediation(adapter.name, "role-ineligible", msg, {
        setting: "role",
        value: role,
      }),
      cliPath: null,
      versionProbe: null,
      promptBytes: limitCheck.measured,
      adapterRequest,
      role,
    };
  }

  // 3. Absolute executable resolution (record when known).
  const resolvePath =
    deps.resolvePath ??
    ((cmd: string) =>
      resolveCommandPath(cmd, {
        exec: deps.versionProbe?.exec ?? deps.preflight.exec,
      }));
  let cliPath: string | null = null;
  try {
    cliPath = await resolveAbsoluteExecutable(command, resolution, {
      resolvePath,
      exec: deps.versionProbe?.exec ?? deps.preflight.exec,
    });
  } catch {
    cliPath = null;
  }

  // 4. Once-per-run version probe (shared cache with fingerprint accounting).
  const versionDeps: CliVersionProbeDeps = deps.versionProbe ?? {
    exec: deps.preflight.exec,
    resolvePath,
  };
  // Prefer probing the absolute path when known so fingerprint path matches.
  const probeCommand = cliPath && cliPath.startsWith("/") ? cliPath : command;
  let versionProbe: CliVersionProbeResult = {
    cliVersion: null,
    cliPath,
    probeOk: false,
  };
  try {
    versionProbe = await probeCliVersionOnce(probeCommand, {
      ...versionDeps,
      resolvePath: versionDeps.resolvePath ?? resolvePath,
    });
    // Prefer earlier absolute resolution when the probe left path null.
    if (!versionProbe.cliPath && cliPath) {
      versionProbe = { ...versionProbe, cliPath };
    } else if (versionProbe.cliPath) {
      cliPath = versionProbe.cliPath;
    }
  } catch {
    // Version probe is fail-soft for version alone; readiness still checked below.
  }

  // 5. Adapter preflight with the exact resolved request (no ambient defaults).
  let adapterResult: AdapterPreflightResult;
  try {
    adapterResult = await adapter.preflight(deps.preflight, adapterRequest);
  } catch (err) {
    const msg =
      `[harness ${adapter.name}] production preflight threw: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `This is a typed capability/readiness failure — the pipeline will not fall back to another harness.`;
    return {
      ok: false,
      remediation: projectPreflightRemediation(adapter.name, "missing-cli", msg),
      cliPath,
      versionProbe,
      promptBytes: limitCheck.measured,
      adapterRequest,
      role,
    };
  }

  if (!adapterResult.ok) {
    const failure: ProductionPreflightFailureClass =
      adapterResult.failure === "missing-cli"
        ? cliPath == null && resolution === "path"
          ? "missing-executable"
          : "missing-cli"
        : (adapterResult.failure ?? "missing-cli");
    const detail =
      adapterResult.message ??
      `[harness ${adapter.name}] production preflight refused (${failure})`;
    return {
      ok: false,
      remediation: projectPreflightRemediation(adapter.name, failure, detail),
      cliPath,
      versionProbe,
      promptBytes: limitCheck.measured,
      adapterRequest,
      role,
    };
  }

  // When PATH resolution is declared and we still have no absolute path and the
  // version probe could not confirm readiness, fail closed for missing executable
  // only if presence was not established by adapter preflight (ok above means
  // presence was established — keep path null rather than inventing one).
  return {
    ok: true,
    cliPath,
    versionProbe,
    promptBytes: limitCheck.measured,
    adapterRequest,
    role,
  };
}

/**
 * Build default production preflight deps from injectable exec (and optional
 * fs helpers). Shared shape with doctor so call sites can pass the same seam.
 */
export function defaultProductionPreflightDeps(opts: {
  exec: AdapterPreflightDeps["exec"];
  execCheck?: AdapterPreflightDeps["execCheck"];
  fsExists?: AdapterPreflightDeps["fsExists"];
  fsExecutable?: AdapterPreflightDeps["fsExecutable"];
  resolvePath?: (command: string) => Promise<string | null>;
}): ProductionPreflightDeps {
  const exec = opts.exec;
  const execCheck =
    opts.execCheck ??
    (async (file: string, args: string[]) => {
      try {
        return (await exec(file, args)).ok;
      } catch {
        return false;
      }
    });
  return {
    preflight: {
      exec,
      execCheck,
      ...(opts.fsExists ? { fsExists: opts.fsExists } : {}),
      ...(opts.fsExecutable ? { fsExecutable: opts.fsExecutable } : {}),
    },
    versionProbe: {
      exec,
      resolvePath: opts.resolvePath,
    },
    resolvePath: opts.resolvePath,
  };
}
