// Deliberately incomplete adapter fixture — missing required declaration
// fields and runtimeSmoke. The conformance kit must fail this.

"use strict";

module.exports = {
  adapters: [
    {
      name: "incomplete-ext",
      capabilities: {
        model: false,
        effort: false,
        sandbox: false,
        workingDir: "cwd",
        telemetry: "none",
      },
      // missing declaration
      buildInvocation(ctx) {
        return {
          cmd: "incomplete-ext",
          args: [ctx.prompt],
          cwd: ctx.worktreeDir,
          promptDelivery: "argv",
        };
      },
      async preflight() {
        return { ok: true };
      },
      parseTelemetry() {
        return {
          text: null,
          costUsd: null,
          usage: null,
          resolvedModel: null,
          throttled: null,
        };
      },
      describeTreatment() {
        return {
          adapter: "incomplete-ext",
          cliVersion: null,
          providerAuthClass: "unknown",
          requestedModel: null,
          resolvedModel: null,
          requestedEffort: null,
          resolvedEffort: null,
          nativeFlags: [],
          fallback: null,
          throttled: null,
        };
      },
      // missing runtimeSmoke
    },
  ],
};
