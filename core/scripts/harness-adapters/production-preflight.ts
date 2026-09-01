// Production preflight-on-invoke for the exact resolved harness treatment (#636).
//
// One choke point used by `harness.invoke` before `buildInvocation` / spawn:
// prompt-size (#779), absolute executable readiness, role eligibility, and
// `adapter.preflight` with the exact resolved {model, effort, sandbox, sandboxMode}.
// Built-in, extension, and compatibility adapters share this path.
//
// Consumes the once-per-run version/binary probe (#778) — does not add a second
// always-on per-call version exec. Version drift remains fail-soft; missing CLI
// and capability refusals block.

import { redactSecrets, sanitize } from "../artifact-sanitize.ts";
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
import {
  backgroundJobLifecycleCoherenceFailure,
  capabilityRefusalMessage,
  malformedLifecycleRefusalMessage,
  requiresBackgroundJobLifecycle,
} from "./background-job-lifecycle.ts";

/** Exact resolved treatment handed to production preflight-on-invoke. */
export interface ProductionPreflightRequest extends AdapterRequest {
  /** Stage role when known (implementer / reviewer). */
  role?: AdapterRole | null;
  /** Fully materialized prompt text for the #779 size check. */
  prompt: string;
  /**
   * Stage kind for #1299 mutating-implementer lifecycle preflight.
   * Planning and review omit this or use a non-mutating kind.
   */
  stageKind?: string | null;
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

/** Max operator-facing diagnostic characters after sanitization (bounded quality). */
export const PREFLIGHT_DIAGNOSTIC_MAX_CHARS = 500;

/**
 * Sanitize and bound adapter-supplied or thrown diagnostic text so credential
 * material never reaches HarnessResult remediation surfaces (#636).
 */
export function sanitizePreflightDiagnostic(text: string): string {
  let cleaned = redactSecrets(String(text ?? ""));
  // Extra credential-shaped patterns common in CLI stderr / auth URLs that are
  // not always covered by token-format redaction alone.
  cleaned = cleaned.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]");
  cleaned = cleaned.replace(
    /\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );
  cleaned = cleaned.replace(
    /https?:\/\/[^\s]*[?&](token|key|api_key|access_token)=([^&\s]+)/gi,
    (full) => full.replace(/(token|key|api_key|access_token)=([^&\s]+)/gi, "$1=[REDACTED]"),
  );
  cleaned = sanitize(cleaned).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "(no diagnostic detail)";
  if (cleaned.length > PREFLIGHT_DIAGNOSTIC_MAX_CHARS) {
    return `${cleaned.slice(0, PREFLIGHT_DIAGNOSTIC_MAX_CHARS)}…`;
  }
  return cleaned;
}

/**
 * Bounded operator-facing reason for a typed production-preflight refusal.
 * Returns null when the result is not a preflight refusal. Never copies prompt
 * text; residual diagnostic text is sanitized.
 */
export function productionPreflightRefusalReason(result: {
  preflight_failed?: boolean;
  stderr?: string | null;
}): string | null {
  if (!result.preflight_failed) return null;
  const raw = result.stderr?.trim() ?? "";
  if (!raw) return "production preflight refused";
  return sanitizePreflightDiagnostic(raw);
}

/**
 * Project an adapter / production preflight failure into #760 remediation.
 * Pure — no I/O. Adapter-supplied detail is sanitized before projection.
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
  const safeDetail = sanitizePreflightDiagnostic(detail);
  const base =
    safeDetail !== "(no diagnostic detail)"
      ? safeDetail
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
 * Resolve a declared adapter command to an absolute filesystem path when possible.
 * Relative path-like strings are never returned as "resolved absolute" paths.
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

  // Absolute path declaration or already-absolute command — never treat relative
  // "./foo" / "foo/bar" as a resolved absolute executable path.
  if (resolution === "absolute" || trimmed.startsWith("/")) {
    return trimmed.startsWith("/") ? trimmed : null;
  }
  // Relative path-like names are not PATH bare commands and are not absolute.
  if (trimmed.startsWith(".") || trimmed.includes("/")) {
    return null;
  }

  if (deps.resolvePath) {
    try {
      const resolved = (await deps.resolvePath(trimmed)) ?? null;
      if (resolved == null) return null;
      const abs = resolved.trim();
      return abs.startsWith("/") ? abs : null;
    } catch {
      return null;
    }
  }
  if (deps.exec) {
    const resolved = await resolveCommandPath(trimmed, { exec: deps.exec });
    if (resolved == null) return null;
    const abs = resolved.trim();
    return abs.startsWith("/") ? abs : null;
  }
  return null;
}

function missingExecutableRemediation(
  adapterName: string,
  command: string,
  resolution: "path" | "absolute",
  detail?: string,
): ProductionPreflightRemediation {
  const msg =
    detail ??
    (resolution === "absolute"
      ? `[harness ${adapterName}] declared absolute command "${command}" is missing or not executable. ` +
        `Install or fix the binary path; the pipeline will not spawn an unresolved CLI or fall back to another harness.`
      : `[harness ${adapterName}] CLI command "${command}" could not be resolved to a runnable absolute executable on PATH. ` +
        `Install the CLI and ensure it is on PATH (or pack the absolute path for detached runs); ` +
        `the pipeline will not spawn an unresolved command name alone.`);
  return projectPreflightRemediation(adapterName, "missing-executable", msg, {
    setting: "executable",
    value: command,
  });
}

/**
 * Single production preflight-before-invoke helper (#636).
 *
 * Ordering:
 * 1. #779 prompt-size against adapter maxPromptBytes
 * 2. Role eligibility when role is supplied
 * 3. Absolute executable resolution — fail closed when unresolved / not executable
 * 4. Once-per-run version/binary probe (shared cache; fail-soft on version alone)
 * 5. adapter.preflight with exact resolved AdapterRequest (incl. sandboxMode)
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
    ...(req.sandboxMode !== undefined ? { sandboxMode: req.sandboxMode } : {}),
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

  // 1b. Mutating implementer work requires an explicit background_job_lifecycle
  // declaration (#1299 / #1364 / #1362). Omitted or malformed field →
  // capability-refusal. Explicit supported:false means the adapter cannot prove
  // join; spawn anyway and leave the lifecycle supervisor off. Do not invent
  // events.
  if (requiresBackgroundJobLifecycle(req.stageKind)) {
    const lifecycle =
      adapter.capabilities.background_job_lifecycle ??
      adapter.declaration.background_job_lifecycle;
    if (!lifecycle) {
      const msg = capabilityRefusalMessage(adapter.name);
      return {
        ok: false,
        remediation: projectPreflightRemediation(adapter.name, "unsupported-setting", msg, {
          setting: "background_job_lifecycle",
          value: "omitted",
        }),
        cliPath: null,
        versionProbe: null,
        promptBytes: limitCheck.measured,
        adapterRequest,
        role,
      };
    }
    const coherence = backgroundJobLifecycleCoherenceFailure(lifecycle);
    if (coherence) {
      const msg = malformedLifecycleRefusalMessage(adapter.name, coherence);
      return {
        ok: false,
        remediation: projectPreflightRemediation(adapter.name, "unsupported-setting", msg, {
          setting: "background_job_lifecycle",
          value: "malformed",
        }),
        cliPath: null,
        versionProbe: null,
        promptBytes: limitCheck.measured,
        adapterRequest,
        role,
      };
    }
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

  // 3. Absolute executable resolution — fail closed independently of adapter.preflight.
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

  if (cliPath == null || !cliPath.startsWith("/")) {
    return {
      ok: false,
      remediation: missingExecutableRemediation(adapter.name, command, resolution),
      cliPath: null,
      versionProbe: null,
      promptBytes: limitCheck.measured,
      adapterRequest,
      role,
    };
  }

  // Validate the resolved absolute path is runnable when an executability seam
  // is available (production injects fsExecutable; tests may omit it).
  if (typeof deps.preflight.fsExecutable === "function") {
    let executable = false;
    try {
      executable = await deps.preflight.fsExecutable(cliPath);
    } catch {
      executable = false;
    }
    if (!executable) {
      return {
        ok: false,
        remediation: missingExecutableRemediation(
          adapter.name,
          command,
          resolution,
          `[harness ${adapter.name}] resolved executable "${cliPath}" is missing or not executable. ` +
            `Fix install permissions or PATH packing; the pipeline will not spawn a non-runnable path.`,
        ),
        cliPath,
        versionProbe: null,
        promptBytes: limitCheck.measured,
        adapterRequest,
        role,
      };
    }
  }

  // 4. Once-per-run version probe (shared cache with fingerprint accounting).
  const versionDeps: CliVersionProbeDeps = deps.versionProbe ?? {
    exec: deps.preflight.exec,
    resolvePath,
  };
  // Prefer probing the absolute path so fingerprint path matches.
  const probeCommand = cliPath;
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
      // Only adopt probe path when it is absolute; never demote to relative.
      if (versionProbe.cliPath.startsWith("/")) {
        cliPath = versionProbe.cliPath;
      } else {
        versionProbe = { ...versionProbe, cliPath };
      }
    }
  } catch {
    // Version probe is fail-soft for version alone; readiness already established.
  }

  // 5. Adapter preflight with the exact resolved request (incl. sandboxMode).
  let adapterResult: AdapterPreflightResult;
  try {
    adapterResult = await adapter.preflight(deps.preflight, adapterRequest);
  } catch (err) {
    const raw =
      err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    const msg =
      `[harness ${adapter.name}] production preflight threw: ${raw}. ` +
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
    const failure: ProductionPreflightFailureClass = adapterResult.failure ?? "missing-cli";
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
