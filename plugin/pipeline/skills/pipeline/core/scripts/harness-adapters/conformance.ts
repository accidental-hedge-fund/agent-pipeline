// Shared adapter conformance kit (#783).
//
// Asserts every required contract member and declaration field is present,
// that supported settings produce a coherent invocation treatment, that
// unsupported settings refuse without silent drop, that telemetry never
// throws, and that failure classes stay in the public vocabulary.
//
// Built-ins run through this kit in CI; extension fixtures use the same
// entry points.

import type {
  AdapterPreflightDeps,
  AdapterPreflightFailure,
  HarnessAdapter,
  HarnessTreatment,
} from "./types.ts";
import { ADAPTER_ROLES, EMPTY_TELEMETRY } from "./types.ts";

export interface ConformanceFailure {
  adapter: string;
  check: string;
  message: string;
}

export interface ConformanceReport {
  adapter: string;
  ok: boolean;
  failures: ConformanceFailure[];
}

const PREFLIGHT_FAILURES = new Set<AdapterPreflightFailure>([
  "missing-cli",
  "unauthenticated",
  "headless-unavailable",
  "unsupported-setting",
]);

const REQUIRED_MEMBERS = [
  "name",
  "capabilities",
  "declaration",
  "buildInvocation",
  "preflight",
  "parseTelemetry",
  "describeTreatment",
  "runtimeSmoke",
] as const;

const REQUIRED_DECLARATION_FIELDS = [
  "roles",
  "executable",
  "prompt",
  "model",
  "effort",
  "sandbox",
  "workingDir",
  "outputEnvelope",
  "telemetry",
  "authProbe",
  "versionProbe",
  "origin",
] as const;

function fail(adapter: string, check: string, message: string): ConformanceFailure {
  return { adapter, check, message };
}

/**
 * Synchronously assert structural completeness of an adapter. Throws with a
 * message naming the missing member/field when incomplete — used by tests
 * that want a single throw, and by register-time checks optionally.
 */
export function assertAdapterConformance(adapter: HarnessAdapter): void {
  const report = checkStructure(adapter);
  if (!report.ok) {
    const first = report.failures[0];
    throw new Error(
      `Adapter "${adapter?.name ?? "(unnamed)"}" failed conformance (${first.check}): ${first.message}`,
    );
  }
}

/** Structural checks only (no async preflight). */
export function checkStructure(adapter: HarnessAdapter): ConformanceReport {
  const failures: ConformanceFailure[] = [];
  const name = typeof adapter?.name === "string" ? adapter.name : "(unnamed)";

  if (!adapter || typeof adapter !== "object") {
    return {
      adapter: name,
      ok: false,
      failures: [fail(name, "structure", "adapter is not an object")],
    };
  }

  for (const member of REQUIRED_MEMBERS) {
    if ((adapter as Record<string, unknown>)[member] === undefined) {
      failures.push(fail(name, "required-member", `missing required member "${member}"`));
    }
  }

  if (typeof adapter.buildInvocation !== "function") {
    failures.push(fail(name, "required-member", `buildInvocation must be a function`));
  }
  if (typeof adapter.preflight !== "function") {
    failures.push(fail(name, "required-member", `preflight must be a function`));
  }
  if (typeof adapter.parseTelemetry !== "function") {
    failures.push(fail(name, "required-member", `parseTelemetry must be a function`));
  }
  if (typeof adapter.describeTreatment !== "function") {
    failures.push(fail(name, "required-member", `describeTreatment must be a function`));
  }
  if (typeof adapter.runtimeSmoke !== "function") {
    failures.push(fail(name, "required-member", `runtimeSmoke must be a function`));
  }

  const decl = adapter.declaration;
  if (!decl || typeof decl !== "object") {
    failures.push(fail(name, "declaration", `missing required field "declaration"`));
  } else {
    for (const field of REQUIRED_DECLARATION_FIELDS) {
      if ((decl as Record<string, unknown>)[field] === undefined) {
        failures.push(fail(name, "declaration", `missing required declaration field "${field}"`));
      }
    }
    if (!Array.isArray(decl.roles) || decl.roles.length === 0) {
      failures.push(fail(name, "declaration.roles", `roles must be a non-empty array`));
    } else {
      for (const role of decl.roles) {
        if (!(ADAPTER_ROLES as readonly string[]).includes(role)) {
          failures.push(fail(name, "declaration.roles", `unknown role "${role}"`));
        }
      }
    }
    if (!decl.executable?.command) {
      failures.push(fail(name, "declaration.executable", `executable.command is required`));
    }
    if (!decl.prompt?.delivery) {
      failures.push(fail(name, "declaration.prompt", `prompt.delivery is required`));
    }
    // Capability / declaration consistency
    if (adapter.capabilities) {
      if (decl.model?.supported !== adapter.capabilities.model) {
        failures.push(
          fail(
            name,
            "declaration.model",
            `declaration.model.supported (${decl.model?.supported}) must match capabilities.model (${adapter.capabilities.model})`,
          ),
        );
      }
      if (decl.effort?.supported !== adapter.capabilities.effort) {
        failures.push(
          fail(
            name,
            "declaration.effort",
            `declaration.effort.supported (${decl.effort?.supported}) must match capabilities.effort (${adapter.capabilities.effort})`,
          ),
        );
      }
      if (decl.sandbox?.supported !== adapter.capabilities.sandbox) {
        failures.push(
          fail(
            name,
            "declaration.sandbox",
            `declaration.sandbox.supported (${decl.sandbox?.supported}) must match capabilities.sandbox (${adapter.capabilities.sandbox})`,
          ),
        );
      }
      if (decl.workingDir !== adapter.capabilities.workingDir) {
        failures.push(
          fail(
            name,
            "declaration.workingDir",
            `declaration.workingDir must match capabilities.workingDir`,
          ),
        );
      }
      if (decl.telemetry !== adapter.capabilities.telemetry) {
        failures.push(
          fail(
            name,
            "declaration.telemetry",
            `declaration.telemetry must match capabilities.telemetry`,
          ),
        );
      }
    }
  }

  return { adapter: name, ok: failures.length === 0, failures };
}

/**
 * Full conformance kit (structure + behavioral checks). Uses injectable
 * preflight deps so unit tests never spawn real CLIs.
 */
export async function runConformanceKit(
  adapter: HarnessAdapter,
  deps: AdapterPreflightDeps = {
    exec: async () => ({ ok: true, stdout: "", stderr: "" }),
    execCheck: async () => true,
  },
): Promise<ConformanceReport> {
  const structural = checkStructure(adapter);
  const failures = [...structural.failures];
  const name = structural.adapter;

  if (typeof adapter.buildInvocation === "function") {
    try {
      const inv = adapter.buildInvocation({
        prompt: "conformance-prompt",
        worktreeDir: "/tmp/pipeline-conformance-worktree",
      });
      if (!inv || typeof inv.cmd !== "string" || !Array.isArray(inv.args)) {
        failures.push(fail(name, "buildInvocation", `must return { cmd, args, cwd, promptDelivery }`));
      } else {
        if (typeof inv.cwd !== "string") {
          failures.push(fail(name, "buildInvocation", `cwd must be a string`));
        }
        if (!inv.promptDelivery) {
          failures.push(fail(name, "buildInvocation", `promptDelivery is required`));
        }
        // Declared delivery channel must match invocation.
        if (
          adapter.declaration?.prompt?.delivery &&
          inv.promptDelivery !== adapter.declaration.prompt.delivery
        ) {
          // Built-ins fix delivery; allow only if declaration matches.
          failures.push(
            fail(
              name,
              "invocation-treatment",
              `buildInvocation promptDelivery "${inv.promptDelivery}" does not match declaration.prompt.delivery "${adapter.declaration.prompt.delivery}"`,
            ),
          );
        }
        if (inv.cmd !== adapter.declaration?.executable?.command && adapter.declaration?.origin !== "compatibility") {
          // Compatibility may use path-like commands; built-ins/extensions should match.
          if (adapter.declaration?.origin === "builtin" || adapter.declaration?.origin === "extension") {
            failures.push(
              fail(
                name,
                "invocation-treatment",
                `buildInvocation.cmd "${inv.cmd}" does not match declaration.executable.command "${adapter.declaration?.executable?.command}"`,
              ),
            );
          }
        }
      }
    } catch (err) {
      failures.push(
        fail(name, "buildInvocation", `threw: ${(err as Error).message}`),
      );
    }
  }

  // Unsupported-capability refusal (no silent drop)
  if (typeof adapter.preflight === "function" && adapter.capabilities) {
    if (!adapter.capabilities.model) {
      try {
        const res = await adapter.preflight(deps, { model: "invented-model-xyz" });
        if (res.ok || res.failure !== "unsupported-setting") {
          failures.push(
            fail(
              name,
              "unsupported-refusal",
              `model capability is false but preflight did not refuse with unsupported-setting (ok=${res.ok}, failure=${res.failure})`,
            ),
          );
        }
      } catch (err) {
        failures.push(fail(name, "unsupported-refusal", `preflight threw: ${(err as Error).message}`));
      }
    }
    if (!adapter.capabilities.effort) {
      try {
        const res = await adapter.preflight(deps, { effort: "invented-effort-xyz" });
        if (res.ok || res.failure !== "unsupported-setting") {
          failures.push(
            fail(
              name,
              "unsupported-refusal",
              `effort capability is false but preflight did not refuse with unsupported-setting (ok=${res.ok}, failure=${res.failure})`,
            ),
          );
        }
      } catch (err) {
        failures.push(fail(name, "unsupported-refusal", `preflight threw: ${(err as Error).message}`));
      }
    }
    if (!adapter.capabilities.sandbox) {
      try {
        const res = await adapter.preflight(deps, { sandbox: true });
        if (res.ok || res.failure !== "unsupported-setting") {
          failures.push(
            fail(
              name,
              "unsupported-refusal",
              `sandbox capability is false but preflight did not refuse with unsupported-setting (ok=${res.ok}, failure=${res.failure})`,
            ),
          );
        }
      } catch (err) {
        failures.push(fail(name, "unsupported-refusal", `preflight threw: ${(err as Error).message}`));
      }
    }
  }

  // Telemetry never throws; nulls when absent; never invents resolved model
  if (typeof adapter.parseTelemetry === "function") {
    for (const sample of ["", "not-json", "{", "null", "[]", "partial { broken"]) {
      try {
        const tel = adapter.parseTelemetry(sample);
        if (!tel || typeof tel !== "object") {
          failures.push(fail(name, "telemetry", `parseTelemetry must return an object`));
          break;
        }
        if (tel.resolvedModel !== null && tel.resolvedModel !== undefined) {
          // Empty/malformed input must not invent a model id.
          if (sample === "" || sample === "not-json" || sample === "{") {
            failures.push(
              fail(
                name,
                "telemetry",
                `parseTelemetry invented resolvedModel "${tel.resolvedModel}" from unparseable input`,
              ),
            );
          }
        }
      } catch (err) {
        failures.push(
          fail(name, "telemetry", `parseTelemetry threw on sample ${JSON.stringify(sample)}: ${(err as Error).message}`),
        );
      }
    }
    // Sanity: EMPTY shape keys exist
    try {
      const empty = adapter.parseTelemetry("");
      for (const key of Object.keys(EMPTY_TELEMETRY)) {
        if (!(key in empty)) {
          failures.push(fail(name, "telemetry", `parseTelemetry result missing key "${key}"`));
        }
      }
    } catch {
      /* already recorded */
    }
  }

  // describeTreatment identity separation: adapter field equals adapter.name;
  // does not invent provider from model.
  if (typeof adapter.describeTreatment === "function" && typeof adapter.buildInvocation === "function") {
    try {
      const inv = adapter.buildInvocation({
        prompt: "p",
        worktreeDir: "/tmp/pipeline-conformance-worktree",
        model: "some-model-alias",
      });
      const treatment: HarnessTreatment = adapter.describeTreatment(
        { model: "some-model-alias" },
        inv,
        {
          cliVersion: null,
          providerAuthClass: "unknown",
          resolvedModel: null,
          throttled: null,
        },
      );
      if (treatment.adapter !== adapter.name) {
        failures.push(
          fail(
            name,
            "identity",
            `describeTreatment.adapter "${treatment.adapter}" must equal adapter.name "${adapter.name}"`,
          ),
        );
      }
      if (treatment.resolvedModel !== null && treatment.resolvedModel !== undefined) {
        // Probe said null — treatment must not invent.
        if (treatment.resolvedModel === "some-model-alias") {
          failures.push(
            fail(
              name,
              "identity",
              `describeTreatment must not echo requested model as resolvedModel`,
            ),
          );
        }
      }
      if (treatment.providerAuthClass && treatment.providerAuthClass !== "unknown") {
        // Only allowed when probe provided a non-unknown class — we passed unknown.
        if (treatment.providerAuthClass !== "unknown") {
          // Adapters may hardcode a known class for their CLI; that is ok only
          // for builtins that document it. For extension/compat, must stay unknown
          // when probe says unknown.
          if (
            adapter.declaration?.origin === "extension" ||
            adapter.declaration?.origin === "compatibility"
          ) {
            failures.push(
              fail(
                name,
                "identity",
                `extension/compatibility adapter must not invent providerAuthClass (got "${treatment.providerAuthClass}")`,
              ),
            );
          }
        }
      }
    } catch (err) {
      failures.push(fail(name, "identity", `describeTreatment threw: ${(err as Error).message}`));
    }
  }

  // runtimeSmoke is callable and returns a preflight-shaped result
  if (typeof adapter.runtimeSmoke === "function") {
    try {
      const smoke = await adapter.runtimeSmoke(deps);
      if (!smoke || typeof smoke.ok !== "boolean") {
        failures.push(fail(name, "runtimeSmoke", `must return { ok: boolean, ... }`));
      } else if (!smoke.ok && smoke.failure && !PREFLIGHT_FAILURES.has(smoke.failure)) {
        failures.push(
          fail(
            name,
            "failure-classification",
            `runtimeSmoke failure "${smoke.failure}" is not in the public vocabulary`,
          ),
        );
      }
    } catch (err) {
      failures.push(fail(name, "runtimeSmoke", `threw: ${(err as Error).message}`));
    }
  }

  // missing-cli classification via preflight with deps that report absence
  if (typeof adapter.preflight === "function") {
    const missingDeps: AdapterPreflightDeps = {
      exec: async () => ({ ok: false, stdout: "", stderr: "not found" }),
      execCheck: async () => false,
    };
    try {
      const res = await adapter.preflight(missingDeps, {});
      if (res.ok) {
        failures.push(
          fail(name, "failure-classification", `preflight returned ok with missing CLI deps`),
        );
      } else if (res.failure && !PREFLIGHT_FAILURES.has(res.failure)) {
        failures.push(
          fail(
            name,
            "failure-classification",
            `preflight failure "${res.failure}" is not in the public vocabulary`,
          ),
        );
      } else if (res.failure !== "missing-cli") {
        // Some adapters may hit headless/auth before missing — still must be a known class.
        // Prefer missing-cli when execCheck is always false; warn if not.
        if (!res.failure) {
          failures.push(
            fail(name, "failure-classification", `preflight failure class is missing`),
          );
        }
      }
    } catch (err) {
      failures.push(
        fail(name, "failure-classification", `preflight threw: ${(err as Error).message}`),
      );
    }
  }

  return { adapter: name, ok: failures.length === 0, failures };
}
