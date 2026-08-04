// Provider-neutral immutable production treatment fingerprint (#778).
//
// Pure builder of (declaration, probe, request, invocation, telemetry, role,
// policy) inputs — no GitHub client, no eval executor, no network. Evals
// (#653) and production invoke share this shape and builder.

import { createHash } from "node:crypto";
import type {
  AdapterCapabilities,
  AdapterExtensionDeclaration,
  AdapterInvocation,
  AdapterProbe,
  AdapterRequest,
  AdapterRole,
  HarnessTelemetry,
  HarnessTreatment,
} from "./types.ts";

/** Coverage class for one telemetry channel on a single invocation. */
export type TelemetryChannelCoverage =
  | "recovered" // adapter declares a channel and this call recovered a value
  | "unavailable" // adapter declares telemetry none / channel not offered
  | "unknown"; // channel offered but this call did not recover a value

/** Per-channel telemetry coverage honesty (#778). */
export interface TelemetryCoverage {
  cost: TelemetryChannelCoverage;
  usage: TelemetryChannelCoverage;
  resolvedModel: TelemetryChannelCoverage;
  throttled: TelemetryChannelCoverage;
}

/**
 * Immutable treatment fingerprint recorded for every production harness
 * invocation that emits treatment / stage-accounting provenance.
 * Unknown fields are null/omitted — never zero-filled or inferred.
 */
export interface TreatmentFingerprint {
  adapterId: string;
  /** Adapter contract stamp (HarnessAdapter surface generation). */
  adapterContractVersion: string;
  /** Absolute CLI path when known. */
  cliPath: string | null;
  /** Probed CLI version when known. */
  cliVersion: string | null;
  /** Stable hash of declared capability / declaration treatment surface. */
  capabilityHash: string;
  /** Role for this invocation when known. */
  role: AdapterRole | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  requestedEffort: string | null;
  resolvedEffort: string | null;
  /** Resolved sandbox/tool policy identity for the invocation. */
  sandboxToolPolicy: string | null;
  promptContractVersion: string;
  outputContractVersion: string;
  /** true/false when known; null = unknown (never fabricated false). */
  fallback: boolean | null;
  /** Typed failure reason when the invocation failed for a known class. */
  failureReason: string | null;
  /**
   * Provider/auth class only when actually reported. "unknown" or null when
   * unreported — never inferred from model name or adapter id.
   */
  providerAuthClass: string | null;
  telemetryCoverage: TelemetryCoverage;
  /** Aligns with stage-cost-accounting: actual | estimated | unknown. */
  costSource: "actual" | "estimated" | "unknown";
  /** Registration origin when known. */
  origin: string | null;
}

/** Contract version of the HarnessAdapter public surface (#783/#778). */
export const ADAPTER_CONTRACT_VERSION = "1";

export interface BuildTreatmentFingerprintInput {
  adapterId: string;
  capabilities: AdapterCapabilities;
  declaration: AdapterExtensionDeclaration;
  request: AdapterRequest;
  invocation: AdapterInvocation;
  probe: AdapterProbe;
  telemetry: HarnessTelemetry | null;
  treatment?: HarnessTreatment | null;
  role?: AdapterRole | null;
  /** Absolute CLI path when resolved by the once-per-run probe. */
  cliPath?: string | null;
  /** When the invocation failed for a known typed reason. */
  failureReason?: string | null;
  /**
   * Cost classification for this call after accounting rules (actual when a
   * numeric cost was recovered, estimated when an operator estimate applied,
   * unknown otherwise). Builder does not invent "actual" from tokens alone.
   */
  costSource?: "actual" | "estimated" | "unknown";
}

/**
 * Stable capability hash over the declaration/capability surface that defines
 * treatment identity. Excludes volatile path and probe results.
 */
export function hashAdapterCapabilities(
  capabilities: AdapterCapabilities,
  declaration: AdapterExtensionDeclaration,
): string {
  const payload = {
    model: capabilities.model,
    effort: capabilities.effort,
    sandbox: capabilities.sandbox,
    workingDir: capabilities.workingDir,
    telemetry: capabilities.telemetry,
    maxPromptBytes: capabilities.maxPromptBytes,
    roles: [...declaration.roles].slice().sort(),
    promptDelivery: declaration.prompt.delivery,
    promptSizeLimit: declaration.prompt.sizeLimit,
    modelValidation: declaration.model.validation,
    effortValidation: declaration.effort.validation,
    outputEnvelope: declaration.outputEnvelope,
    telemetryDecl: declaration.telemetry,
    authProbe: declaration.authProbe,
    versionProbe: declaration.versionProbe,
    origin: declaration.origin,
  };
  const json = JSON.stringify(payload);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function channelCoverage(
  declaredTelemetry: "none" | "jsonl",
  recovered: boolean,
): TelemetryChannelCoverage {
  if (declaredTelemetry === "none") return "unavailable";
  return recovered ? "recovered" : "unknown";
}

/**
 * Derive telemetry coverage honesty from adapter declaration + recovered
 * telemetry. Never marks cost recovered without a numeric cost.
 */
export function deriveTelemetryCoverage(
  declaredTelemetry: "none" | "jsonl",
  telemetry: HarnessTelemetry | null | undefined,
): TelemetryCoverage {
  return {
    cost: channelCoverage(
      declaredTelemetry,
      telemetry != null && telemetry.costUsd !== null && Number.isFinite(telemetry.costUsd),
    ),
    usage: channelCoverage(declaredTelemetry, telemetry != null && telemetry.usage !== null),
    resolvedModel: channelCoverage(
      declaredTelemetry,
      telemetry != null && telemetry.resolvedModel != null && telemetry.resolvedModel !== "",
    ),
    throttled: channelCoverage(
      declaredTelemetry,
      telemetry != null && typeof telemetry.throttled === "boolean",
    ),
  };
}

/** Identity of the sandbox/tool policy applied on this invocation. */
export function sandboxToolPolicyIdentity(
  request: AdapterRequest,
  invocation: AdapterInvocation,
  declaration: AdapterExtensionDeclaration,
): string | null {
  if (!declaration.sandbox.supported && !request.sandbox) {
    return "unsupported";
  }
  // Prefer explicit argv tokens when present (deterministic, no name branches).
  const args = invocation.args;
  const idxSandbox = args.indexOf("--sandbox");
  if (idxSandbox >= 0 && args[idxSandbox + 1]) {
    return `sandbox:${args[idxSandbox + 1]}`;
  }
  if (args.includes("--dangerously-bypass-approvals-and-sandbox")) {
    return "external-bypass";
  }
  const idxPerm = args.indexOf("--permission-mode");
  if (idxPerm >= 0 && args[idxPerm + 1]) {
    return `permission-mode:${args[idxPerm + 1]}`;
  }
  if (args.includes("--auto") || args.includes("-a")) {
    return "auto-approve";
  }
  if (request.sandbox === true) return "requested-restricted";
  if (request.sandbox === false) return "requested-unrestricted";
  return declaration.sandbox.supported ? "default" : "unsupported";
}

/**
 * Pure treatment fingerprint builder. Free of GitHub / eval-executor coupling
 * so unit tests and #653 can call it with fakes.
 */
export function buildTreatmentFingerprint(
  input: BuildTreatmentFingerprintInput,
): TreatmentFingerprint {
  const decl = input.declaration;
  const caps = input.capabilities;
  const telemetry = input.telemetry;
  const treatment = input.treatment;
  const probe = input.probe;

  const resolvedModel =
    treatment?.resolvedModel ??
    probe.resolvedModel ??
    telemetry?.resolvedModel ??
    null;
  const resolvedEffort = treatment?.resolvedEffort ?? null;
  const fallback = treatment?.fallback ?? null;
  const providerAuthClass =
    probe.providerAuthClass && probe.providerAuthClass !== ""
      ? probe.providerAuthClass
      : treatment?.providerAuthClass ?? null;

  // Provider must not be inferred from model name — leave unknown as-is.
  const normalizedProvider =
    providerAuthClass === "unknown" ? null : providerAuthClass;

  const costSource: "actual" | "estimated" | "unknown" =
    input.costSource ??
    (telemetry != null && telemetry.costUsd !== null && Number.isFinite(telemetry.costUsd)
      ? "actual"
      : "unknown");

  return {
    adapterId: input.adapterId,
    adapterContractVersion: ADAPTER_CONTRACT_VERSION,
    cliPath: input.cliPath ?? null,
    cliVersion: probe.cliVersion ?? treatment?.cliVersion ?? null,
    capabilityHash: hashAdapterCapabilities(caps, decl),
    role: input.role ?? null,
    requestedModel: input.request.model ?? treatment?.requestedModel ?? null,
    resolvedModel,
    requestedEffort: input.request.effort ?? treatment?.requestedEffort ?? null,
    resolvedEffort,
    sandboxToolPolicy: sandboxToolPolicyIdentity(input.request, input.invocation, decl),
    promptContractVersion: `prompt/${decl.prompt.delivery}/${decl.prompt.sizeLimit}`,
    outputContractVersion: `output/${decl.outputEnvelope}/${decl.telemetry}`,
    fallback,
    failureReason: input.failureReason ?? null,
    providerAuthClass: normalizedProvider,
    telemetryCoverage: deriveTelemetryCoverage(caps.telemetry, telemetry),
    costSource,
    origin: decl.origin ?? treatment?.origin ?? null,
  };
}

/**
 * Sanitize a fingerprint for stage-accounting persistence: drop nulls that
 * readers treat as absent, never write fabricated zeros.
 */
export function sanitizeTreatmentFingerprint(
  fp: TreatmentFingerprint | null | undefined,
): TreatmentFingerprint | undefined {
  if (!fp || typeof fp !== "object") return undefined;
  return {
    adapterId: String(fp.adapterId ?? ""),
    adapterContractVersion: String(fp.adapterContractVersion ?? ADAPTER_CONTRACT_VERSION),
    cliPath: fp.cliPath ?? null,
    cliVersion: fp.cliVersion ?? null,
    capabilityHash: String(fp.capabilityHash ?? ""),
    role: fp.role ?? null,
    requestedModel: fp.requestedModel ?? null,
    resolvedModel: fp.resolvedModel ?? null,
    requestedEffort: fp.requestedEffort ?? null,
    resolvedEffort: fp.resolvedEffort ?? null,
    sandboxToolPolicy: fp.sandboxToolPolicy ?? null,
    promptContractVersion: String(fp.promptContractVersion ?? ""),
    outputContractVersion: String(fp.outputContractVersion ?? ""),
    fallback: typeof fp.fallback === "boolean" ? fp.fallback : null,
    failureReason: fp.failureReason ?? null,
    providerAuthClass: fp.providerAuthClass ?? null,
    telemetryCoverage: {
      cost: fp.telemetryCoverage?.cost ?? "unknown",
      usage: fp.telemetryCoverage?.usage ?? "unknown",
      resolvedModel: fp.telemetryCoverage?.resolvedModel ?? "unknown",
      throttled: fp.telemetryCoverage?.throttled ?? "unknown",
    },
    costSource:
      fp.costSource === "actual" || fp.costSource === "estimated" || fp.costSource === "unknown"
        ? fp.costSource
        : "unknown",
    origin: fp.origin ?? null,
  };
}
