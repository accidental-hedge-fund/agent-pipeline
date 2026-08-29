// Synthetic third-party adapter package fixture for #783.
// Declares both implementer and reviewer roles. Loaded only when listed in
// adapter_extensions — never auto-scanned.
//
// CommonJS so resolveConfig's createRequire loader can load it synchronously.

"use strict";

const CAPABILITIES = {
  model: false,
  effort: false,
  sandbox: false,
  workingDir: "cwd",
  telemetry: "none",
  maxPromptBytes: "unlimited",
  background_job_lifecycle: { supported: false },
};

const EMPTY_TELEMETRY = {
  text: null,
  costUsd: null,
  usage: null,
  resolvedModel: null,
  throttled: null,
};

/** @type {import("../../../scripts/harness-adapters/types.ts").HarnessAdapter} */
const extDemoAdapter = {
  name: "ext-demo",
  capabilities: CAPABILITIES,
  declaration: {
    roles: ["implementer", "reviewer"],
    executable: { command: "ext-demo", resolution: "path" },
    prompt: { delivery: "stdin", sizeLimit: "unlimited" },
    model: { supported: false, validation: "unsupported" },
    effort: { supported: false, validation: "unsupported" },
    sandbox: { supported: false },
    workingDir: "cwd",
    outputEnvelope: "passthrough",
    telemetry: "none",
    authProbe: "none",
    versionProbe: "none",
    origin: "extension",
    background_job_lifecycle: { supported: false },
  },

  buildInvocation(ctx) {
    return {
      cmd: "ext-demo",
      args: ["--run"],
      cwd: ctx.worktreeDir,
      promptDelivery: "stdin",
      stdinPayload: ctx.prompt,
    };
  },

  async preflight(deps, req) {
    if (req.model) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message: 'ext-demo does not support model selection',
      };
    }
    if (req.effort) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message: "ext-demo does not support effort selection",
      };
    }
    if (req.sandbox) {
      return {
        ok: false,
        failure: "unsupported-setting",
        message: "ext-demo does not support sandbox mode",
      };
    }
    const present = await deps.execCheck("which", ["ext-demo"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "ext-demo CLI not found on PATH",
      };
    }
    return { ok: true, authState: "unknown" };
  },

  parseTelemetry() {
    return { ...EMPTY_TELEMETRY };
  },

  describeTreatment(req, _inv, probe) {
    return {
      adapter: "ext-demo",
      cliVersion: probe.cliVersion,
      providerAuthClass: probe.providerAuthClass || "unknown",
      requestedModel: req.model ?? null,
      resolvedModel: null,
      requestedEffort: req.effort ?? null,
      resolvedEffort: null,
      nativeFlags: [],
      fallback: null,
      throttled: null,
      origin: "extension",
    };
  },

  async runtimeSmoke(deps) {
    const present = await deps.execCheck("which", ["ext-demo"]);
    if (!present) {
      return {
        ok: false,
        failure: "missing-cli",
        message: "ext-demo CLI not found on PATH",
      };
    }
    return { ok: true, authState: "unknown" };
  },
};

module.exports = { adapters: [extDemoAdapter] };
module.exports.extDemoAdapter = extDemoAdapter;
