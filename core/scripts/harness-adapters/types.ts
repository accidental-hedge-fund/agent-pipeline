// Adapter contract for local CLI harnesses (#431 — cli-harness-adapters;
// #783 — public end-user extension registry).
//
// Every harness-specific invocation/preflight/telemetry detail lives behind an
// implementation of `HarnessAdapter`, registered by name via the public
// `registerAdapter` API in `index.ts`. `harness.ts`'s `invoke()` dispatches
// through the registry instead of branching on harness names.
//
// Because the pipeline strips TypeScript types at runtime (no `tsc` step),
// this contract is backed by a shared runtime conformance kit
// (`conformance.ts` + tests) that iterates the registry and asserts every
// adapter implements every required member and declaration field.

/** The execution sandbox mode a harness invocation runs under (#607 —
 *  eval-agent-isolation-boundary). `"managed"` is the harness's own sandbox
 *  (codex: consecutive `--sandbox` + `workspace-write`; #613 replaced the
 *  deprecated `--full-auto` alias); `"external-bypass"` is the explicit bypass
 *  mode codex offers for a runner whose own sandbox (bubblewrap/userns) cannot
 *  start. Single-sourced here so the eval manifest and adapter invocation
 *  shaping never drift on the set of supported values. */
export const EXTERNAL_SANDBOX_MODES = ["managed", "external-bypass"] as const;
export type ExternalSandboxMode = (typeof EXTERNAL_SANDBOX_MODES)[number];

/** Roles an adapter may declare eligibility for (#783). Assignment is config +
 *  declared capability, never a name allowlist or marketing-name heuristic. */
export const ADAPTER_ROLES = ["implementer", "reviewer"] as const;
export type AdapterRole = (typeof ADAPTER_ROLES)[number];

/** Registration / materialization origin of an adapter implementation. */
export type AdapterOrigin = "builtin" | "extension" | "compatibility";

/** How model / effort values are validated when the capability is supported. */
export type SettingValidationPolicy =
  | "open" // any non-empty string accepted; CLI validates further
  | "closed-enum" // adapter preflight enforces a known set
  | "format" // adapter preflight enforces a structural format (e.g. provider/model)
  | "unsupported"; // capability is false; requests must refuse

/** What a harness CLI's headless interface supports (design.md decision 2). */
export interface AdapterCapabilities {
  /** Supports selecting a model via a CLI flag. */
  model: boolean;
  /** Supports a reasoning-effort control via a CLI flag. */
  effort: boolean;
  /** Supports a restricted-permission / sandboxed mode distinct from the
   *  harness's default managed workspace sandbox. */
  sandbox: boolean;
  /** How the working directory is set: process cwd inheritance, or an explicit flag. */
  workingDir: "cwd" | "flag";
  /** Whether the CLI offers machine-readable per-call output ("jsonl") or not ("none"). */
  telemetry: "none" | "jsonl";
}

/**
 * Machine-checkable extension declaration surface (#783). Every registered
 * adapter — built-in, third-party package, or custom-reviewer compatibility —
 * must populate these fields. The shared conformance kit fails incomplete
 * declarations by naming the missing field.
 */
export interface AdapterExtensionDeclaration {
  /** Roles this adapter may serve. Empty is invalid. */
  roles: readonly AdapterRole[];
  /** How the CLI binary is located. */
  executable: {
    /** Command name on PATH, or absolute path when resolution is "absolute". */
    command: string;
    /** PATH lookup vs absolute path only. */
    resolution: "path" | "absolute";
  };
  /** Prompt delivery channel and size-limit policy. */
  prompt: {
    delivery: PromptDeliveryChannel;
    /** `"max-arg-strlen"` for argv channel; `"unlimited"` for stdin/file. */
    sizeLimit: "max-arg-strlen" | "unlimited";
  };
  /** Model discovery / validation policy (no vendor-global catalog in core). */
  model: {
    supported: boolean;
    validation: SettingValidationPolicy;
    /** Optional closed set when validation is "closed-enum". */
    allowedValues?: readonly string[];
  };
  /** Effort discovery / validation policy. */
  effort: {
    supported: boolean;
    validation: SettingValidationPolicy;
    allowedValues?: readonly string[];
  };
  /** Sandbox / tool / permission policy. */
  sandbox: {
    supported: boolean;
  };
  /** cwd / worktree behavior — mirrors capabilities.workingDir. */
  workingDir: "cwd" | "flag";
  /** Expected output envelope after normalization into harness result text. */
  outputEnvelope: "text" | "jsonl" | "passthrough";
  /** Telemetry parsing behavior. */
  telemetry: "none" | "jsonl";
  /** Authentication probe class. */
  authProbe: "documented" | "none";
  /** Version probe class. */
  versionProbe: "documented" | "none";
  /** Registration origin for treatment/doctor distinction. */
  origin: AdapterOrigin;
}

/** The minimal per-call settings a stage requests of an adapter. Shared base
 *  for preflight and treatment-description; `buildInvocation` additionally
 *  needs the prompt/worktree/mode fields carried by `AdapterInvocationContext`. */
export interface AdapterRequest {
  model?: string;
  effort?: string;
  /** When true, the caller is requesting a restricted-permission mode. Consulted
   *  by `preflight` to decide whether the adapter's `sandbox` capability can
   *  actually honor the request (rather than `buildInvocation` silently
   *  widening permissions when it can't). */
  sandbox?: boolean;
}

/** Full context handed to `buildInvocation`. */
export interface AdapterInvocationContext extends AdapterRequest {
  prompt: string;
  worktreeDir: string;
  /** When true and the adapter is claude, run a lean single-shot generation
   *  (no tools, no MCP servers). Ignored by every other adapter. */
  lean?: boolean;
  /** Additional env vars merged into the child process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Explicit execution sandbox mode for this invocation (#607). When
   *  supplied, it alone decides the sandbox-selecting argument — consulted
   *  only by the codex adapter today. When absent, the codex adapter falls
   *  back to the ambient `PIPELINE_CODEX_NO_SANDBOX` environment variable,
   *  preserving pre-#607 behavior for every caller that supplies no value. */
  sandboxMode?: ExternalSandboxMode;
}

/** How a prompt reaches its CLI (#492 — MAX_ARG_STRLEN spawn failures on
 *  oversize prompts). `"argv"`: the prompt is already embedded in `args`
 *  (unchanged pre-#492 shape). `"stdin"`: the prompt is NOT in `args` — it is
 *  written to the child's standard input instead. `"file"`: the prompt is NOT
 *  in `args` — it is written to a pipeline-owned file under the managed
 *  worktree root that `args` references via the CLI's documented flag. */
export type PromptDeliveryChannel = "argv" | "stdin" | "file";

/** Linux `MAX_ARG_STRLEN` — the maximum size, in bytes, of a single argv
 *  element (32 × PAGE_SIZE = 131,072 bytes on the common 4 KiB page size).
 *  Single-sourced so the pre-spawn oversize guard in `runCapped` and its
 *  regression tests never drift. */
export const MAX_ARG_STRLEN = 131_072;

/** The concrete command an adapter wants executed. `captureMode`/
 *  `transformForward` mirror `runCapped`'s options — adapter-declared instead
 *  of `harness === "claude"` tests at the call site. */
export interface AdapterInvocation {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  captureMode?: "head" | "tail";
  transformForward?: (chunk: string) => string;
  /** How the prompt reaches this CLI (#492). The adapter is the sole owner of
   *  this decision — the call site in `harness.ts` never branches on harness
   *  name to infer it. */
  promptDelivery: PromptDeliveryChannel;
  /** Present only when `promptDelivery === "stdin"`: the prompt bytes to write
   *  to the child's standard input. Never also embedded in `args`. */
  stdinPayload?: string;
  /** Present only when `promptDelivery === "file"`: the prompt file the
   *  runner must materialize under the managed worktree root before spawn and
   *  remove after the call completes. `args` already references `path` via
   *  the CLI's documented prompt-file flag. */
  promptFile?: { path: string; content: string };
}

/** Per-call cost/token telemetry recovered from an adapter's machine-readable
 *  output, when it offers one. Pure and must never throw — unparseable or
 *  absent output degrades to nulls rather than failing the stage. */
export interface HarnessTelemetry {
  text: string | null;
  costUsd: number | null;
  usage: Record<string, unknown> | null;
  /** The actual model that served this call, recovered from the CLI's own
   *  machine-readable output (e.g. claude's `modelUsage` envelope key) — never
   *  guessed or copied from the requested model. `null` when the CLI's output
   *  doesn't report one (review-2 finding 0b0c7e4b). */
  resolvedModel: string | null;
  /** Whether the CLI's own output reported a rate-limit/throttle signal for
   *  this call. `null` when the CLI reports no such signal at all (not the
   *  same as "not throttled" — see review-2 finding 0b0c7e4b). */
  throttled: boolean | null;
}

/** Thin, injectable I/O seam for preflight checks — the same shape as
 *  `DoctorDeps`'s `exec`/`execCheck`/`fsExists` members, so `doctor.ts` can
 *  pass its own deps straight through without adaptation. No real
 *  subprocess/network call in tests; fakes only. */
export interface AdapterPreflightDeps {
  exec(file: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  execCheck(file: string, args: string[]): Promise<boolean>;
  /** Path existence for absolute/relative path-like CLI commands. Optional so
   *  existing fakes keep working; path-like readiness checks fail closed when
   *  absent and other presence probes fail. Matches `DoctorDeps.fsExists`. */
  fsExists?(p: string): Promise<boolean>;
}

/** Distinguishable preflight failure classes (design.md decision 7). */
export type AdapterPreflightFailure =
  | "missing-cli"
  | "unauthenticated"
  | "headless-unavailable"
  | "unsupported-setting";

export interface AdapterPreflightResult {
  ok: boolean;
  /** Present when `ok` is false — the distinguishable failure class. */
  failure?: AdapterPreflightFailure;
  /** Human-readable detail naming the stage/adapter/CLI/setting, never a credential. */
  message?: string;
  /** Coarse authentication signal. "unknown" is a legitimate, non-fabricated
   *  outcome for a CLI with no documented non-interactive auth-status probe
   *  (e.g. pi, design.md decision 4) — it does NOT imply failure by itself. */
  authState?: "authenticated" | "unauthenticated" | "unknown";
  /** CLI version string when the preflight probe reports one. */
  cliVersion?: string | null;
}

/** Coarse, non-secret identity signals for treatment-identity recording
 *  (design.md decision 5). Never an account id, token, or auth-file path. */
export interface AdapterProbe {
  cliVersion: string | null;
  /** e.g. "oauth:anthropic", "api-key:xai", or "unknown". Never inferred from
   *  the model name — a model alias can be served by more than one route. */
  providerAuthClass: string;
  /** The actual model that served this call, recovered from the adapter's own
   *  telemetry parsing (review-2 finding 0b0c7e4b) — `null` when the CLI's
   *  output doesn't report one. Never copied from the requested model. */
  resolvedModel?: string | null;
  /** Whether the adapter's telemetry parsing found a rate-limit/throttle
   *  signal for this call. `null`/absent when the CLI reports no such signal
   *  at all — not the same as "not throttled". */
  throttled?: boolean | null;
}

/** Treatment identity recorded into stage accounting (design.md decision 5, 6).
 *  Adapter, provider, model, and effort stay independent dimensions — never
 *  collapsed into outer-host identity (#783). */
export interface HarnessTreatment {
  adapter: string;
  cliVersion: string | null;
  providerAuthClass: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  requestedEffort: string | null;
  resolvedEffort: string | null;
  /** Native CLI flag names actually used for this invocation (e.g. ["--model", "--effort"]). */
  nativeFlags: string[];
  /** Whether this invocation was subject to a provider fallback. No adapter
   *  has a documented way to detect a fallback today, so this is `null`
   *  (unknown) rather than a fabricated `false` (review-2 finding 0b0c7e4b) —
   *  it must never be inferred, only recovered from documented CLI output. */
  fallback: boolean | null;
  /** Whether this invocation was subject to provider-side throttling, per the
   *  adapter's own probe (`null` when the CLI reports no such signal). */
  throttled: boolean | null;
  /** Registration origin — distinguishes full packages from the custom-
   *  reviewer compatibility path (#783 / #40). */
  origin?: AdapterOrigin;
}

/** The complete adapter contract. Every registered adapter must implement
 *  every member — see the runtime conformance kit. */
export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /** Full machine-checkable extension declaration (#783). */
  readonly declaration: AdapterExtensionDeclaration;
  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation;
  preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult>;
  parseTelemetry(capturedStdout: string): HarnessTelemetry;
  describeTreatment(req: AdapterRequest, inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment;
  /**
   * Cheap readiness probe distinct from full stage invocation (#783). Doctor
   * and run-start preflight may call this without spending a full implementer
   * or reviewer turn. Implementations SHOULD avoid model-consuming work.
   */
  runtimeSmoke(deps: AdapterPreflightDeps): Promise<AdapterPreflightResult>;
}

/** Shared: never throws, matches a JSON object on one line. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The empty telemetry result every adapter falls back to on unparseable or
 *  absent output — single-sourced so every adapter degrades identically. */
export const EMPTY_TELEMETRY: HarnessTelemetry = {
  text: null,
  costUsd: null,
  usage: null,
  resolvedModel: null,
  throttled: null,
};

/**
 * Build a complete extension declaration for a built-in or extension adapter
 * from the common capability surface. Keeps declaration fields in lockstep
 * with `AdapterCapabilities` without a second hand-maintained enum.
 */
export function buildAdapterDeclaration(opts: {
  roles?: readonly AdapterRole[];
  command: string;
  executableResolution?: "path" | "absolute";
  capabilities: AdapterCapabilities;
  promptDelivery: PromptDeliveryChannel;
  modelValidation?: SettingValidationPolicy;
  effortValidation?: SettingValidationPolicy;
  modelAllowedValues?: readonly string[];
  effortAllowedValues?: readonly string[];
  outputEnvelope?: "text" | "jsonl" | "passthrough";
  authProbe?: "documented" | "none";
  versionProbe?: "documented" | "none";
  origin?: AdapterOrigin;
}): AdapterExtensionDeclaration {
  const caps = opts.capabilities;
  const promptDelivery = opts.promptDelivery;
  return {
    roles: opts.roles ?? (["implementer", "reviewer"] as const),
    executable: {
      command: opts.command,
      resolution: opts.executableResolution ?? "path",
    },
    prompt: {
      delivery: promptDelivery,
      sizeLimit: promptDelivery === "argv" ? "max-arg-strlen" : "unlimited",
    },
    model: {
      supported: caps.model,
      validation:
        opts.modelValidation ??
        (caps.model ? "open" : "unsupported"),
      ...(opts.modelAllowedValues ? { allowedValues: opts.modelAllowedValues } : {}),
    },
    effort: {
      supported: caps.effort,
      validation:
        opts.effortValidation ??
        (caps.effort ? "open" : "unsupported"),
      ...(opts.effortAllowedValues ? { allowedValues: opts.effortAllowedValues } : {}),
    },
    sandbox: { supported: caps.sandbox },
    workingDir: caps.workingDir,
    outputEnvelope:
      opts.outputEnvelope ??
      (caps.telemetry === "jsonl" ? "jsonl" : "text"),
    telemetry: caps.telemetry,
    authProbe: opts.authProbe ?? "documented",
    versionProbe: opts.versionProbe ?? "documented",
    origin: opts.origin ?? "builtin",
  };
}

/** Default cheap smoke: PATH presence via `--version` (or absolute path probe). */
export async function defaultRuntimeSmoke(
  command: string,
  deps: AdapterPreflightDeps,
  resolution: "path" | "absolute" = "path",
): Promise<AdapterPreflightResult> {
  if (resolution === "absolute") {
    const present = await deps.execCheck(command, ["--version"]).catch(() => false);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: `${command} is not executable — install or fix the path for this adapter.`,
      };
    }
    return { ok: true };
  }
  const present =
    (await deps.execCheck(command, ["--version"])) ||
    (await deps.execCheck(command, ["--help"]));
  if (!present) {
    return {
      ok: false,
      failure: "missing-cli",
      message: `${command} CLI not found on PATH.`,
    };
  }
  return { ok: true };
}

/** Whether `adapter` declares the given role capability. */
export function adapterSupportsRole(adapter: HarnessAdapter, role: AdapterRole): boolean {
  return adapter.declaration.roles.includes(role);
}
