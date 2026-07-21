// Adapter contract for local CLI harnesses (#431 — cli-harness-adapters).
//
// Every harness-specific invocation/preflight/telemetry detail lives behind an
// implementation of `HarnessAdapter`, registered by name in `index.ts`.
// `harness.ts`'s `invoke()` dispatches through the registry instead of
// branching on harness names — see design.md decision 2.
//
// Because the pipeline strips TypeScript types at runtime (no `tsc` step),
// this contract is backed by a runtime conformance test
// (`harness-adapters.test.ts`) that iterates the registry and asserts every
// adapter actually implements every member below with the right kind.

/** What a harness CLI's headless interface supports (design.md decision 2). */
export interface AdapterCapabilities {
  /** Supports selecting a model via a CLI flag. */
  model: boolean;
  /** Supports a reasoning-effort control via a CLI flag. */
  effort: boolean;
  /** Supports a restricted-permission / sandboxed mode distinct from full-auto. */
  sandbox: boolean;
  /** How the working directory is set: process cwd inheritance, or an explicit flag. */
  workingDir: "cwd" | "flag";
  /** Whether the CLI offers machine-readable per-call output ("jsonl") or not ("none"). */
  telemetry: "none" | "jsonl";
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
}

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
}

/** Per-call cost/token telemetry recovered from an adapter's machine-readable
 *  output, when it offers one. Pure and must never throw — unparseable or
 *  absent output degrades to nulls rather than failing the stage. */
export interface HarnessTelemetry {
  text: string | null;
  costUsd: number | null;
  usage: Record<string, unknown> | null;
}

/** Thin, injectable I/O seam for preflight checks — the same shape as
 *  `DoctorDeps`'s `exec`/`execCheck` members, so `doctor.ts` can pass its own
 *  deps straight through without adaptation. No real subprocess/network call
 *  in tests; fakes only. */
export interface AdapterPreflightDeps {
  exec(file: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  execCheck(file: string, args: string[]): Promise<boolean>;
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
}

/** Treatment identity recorded into stage accounting (design.md decision 5, 6). */
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
  /** Whether this invocation was subject to a provider fallback or throttling.
   *  No adapter implements fallback logic today — always false, never fabricated. */
  fallback: boolean;
}

/** The complete adapter contract. Every registered adapter must implement
 *  every member — see the runtime conformance test. */
export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation;
  preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult>;
  parseTelemetry(capturedStdout: string): HarnessTelemetry;
  describeTreatment(req: AdapterRequest, inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment;
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
export const EMPTY_TELEMETRY: HarnessTelemetry = { text: null, costUsd: null, usage: null };
