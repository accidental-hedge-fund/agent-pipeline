// Shared adapter conformance kit (#783).
//
// Asserts every required contract member and declaration field is present,
// that supported settings produce a coherent invocation treatment, that
// unsupported settings refuse without silent drop, that telemetry never
// throws, that output envelopes normalize into the public telemetry shape,
// and that failure classes stay in the public vocabulary (missing-cli,
// unauthenticated, headless-unavailable, unsupported-setting) as applicable.
//
// Built-ins run through this kit in CI; extension fixtures use the same
// entry points.

import type {
  AdapterInvocationContext,
  AdapterPreflightDeps,
  AdapterPreflightFailure,
  AdapterRequest,
  HarnessAdapter,
  HarnessTreatment,
} from "./types.ts";
import {
  ADAPTER_ROLES,
  EMPTY_TELEMETRY,
  isFiniteMaxPromptBytes,
  promptLimitCoherenceFailure,
} from "./types.ts";
import { getVerifiedAgainst } from "./verified-against.ts";

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

const CONFORMANCE_WORKTREE = "/tmp/pipeline-conformance-worktree";

function fail(adapter: string, check: string, message: string): ConformanceFailure {
  return { adapter, check, message };
}

/**
 * Deps that report the CLI present and authenticated enough for built-in
 * preflight happy paths (injectable — no real subprocess).
 */
function readyDeps(): AdapterPreflightDeps {
  return {
    execCheck: async (_file, args) => {
      // opencode headless probe uses ["run", "--help"] — keep it present when
      // simulating a healthy install.
      if (args[0] === "run" && args[1] === "--help") return true;
      return true;
    },
    exec: async (_file, args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) {
        return { ok: true, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      }
      if (joined.includes("login status") || joined === "login status") {
        return { ok: true, stdout: "Logged in using ChatGPT", stderr: "" };
      }
      if (joined.includes("--help") || joined.includes("help")) {
        return {
          ok: true,
          stdout: "Usage:\n  -p, --print\n  --mode\n  run  Run headless\n",
          stderr: "",
        };
      }
      if (joined.includes("list-models") || joined === "models" || joined.includes("models")) {
        return { ok: true, stdout: "model-a\nmodel-b\n", stderr: "" };
      }
      if (joined.includes("providers") || joined.includes("auth")) {
        return { ok: true, stdout: "anthropic\nopenai\n", stderr: "" };
      }
      return { ok: true, stdout: "ok", stderr: "" };
    },
    fsExists: async () => true,
    fsExecutable: async () => true,
  };
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
      // #779: maxPromptBytes is required on every adapter.
      if (adapter.capabilities.maxPromptBytes === undefined) {
        failures.push(
          fail(name, "capabilities.maxPromptBytes", `missing required field "maxPromptBytes"`),
        );
      } else {
        const coherence = promptLimitCoherenceFailure(
          adapter.capabilities.maxPromptBytes,
          decl.prompt?.delivery,
          decl.prompt?.sizeLimit,
        );
        if (coherence) {
          failures.push(fail(name, "capabilities.maxPromptBytes", coherence));
        }
        // argv requires a finite positive limit (not unknown/unlimited).
        if (
          decl.prompt?.delivery === "argv" &&
          !isFiniteMaxPromptBytes(adapter.capabilities.maxPromptBytes)
        ) {
          failures.push(
            fail(
              name,
              "capabilities.maxPromptBytes",
              `argv prompt delivery requires a finite positive maxPromptBytes (got ${JSON.stringify(adapter.capabilities.maxPromptBytes)})`,
            ),
          );
        }
      }
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
    } else {
      failures.push(fail(name, "capabilities", `missing required member "capabilities"`));
    }
  }

  return { adapter: name, ok: failures.length === 0, failures };
}

/** Build table-driven supported-setting contexts for invocation treatment checks. */
function supportedSettingCases(adapter: HarnessAdapter): AdapterInvocationContext[] {
  const base: AdapterInvocationContext = {
    prompt: "conformance-prompt",
    worktreeDir: CONFORMANCE_WORKTREE,
  };
  const cases: AdapterInvocationContext[] = [{ ...base }];
  if (adapter.capabilities?.model) {
    // opencode requires provider/model format; others accept open strings.
    const model =
      adapter.name === "opencode" ? "anthropic/conformance-model" : "conformance-model";
    cases.push({ ...base, model });
  }
  if (adapter.capabilities?.effort) {
    const effort =
      adapter.declaration?.effort?.allowedValues?.[0] ??
      (adapter.name === "pi" ? "high" : "high");
    cases.push({ ...base, effort });
  }
  if (adapter.capabilities?.sandbox) {
    cases.push({ ...base, sandbox: true });
  }
  // Combined cwd + supported model when both apply (covers workingDir treatment).
  if (adapter.capabilities?.model) {
    const model =
      adapter.name === "opencode" ? "anthropic/conformance-model" : "conformance-model";
    cases.push({ ...base, model, worktreeDir: CONFORMANCE_WORKTREE });
  }
  return cases;
}

/**
 * Full conformance kit (structure + behavioral checks). Uses injectable
 * preflight deps so unit tests never spawn real CLIs.
 */
export async function runConformanceKit(
  adapter: HarnessAdapter,
  deps: AdapterPreflightDeps = readyDeps(),
): Promise<ConformanceReport> {
  const structural = checkStructure(adapter);
  const failures = [...structural.failures];
  const name = structural.adapter;
  const ready = readyDeps();
  // Prefer caller deps for presence-shaped checks, but merge path seams when provided.
  const presentDeps: AdapterPreflightDeps = {
    ...ready,
    ...deps,
    fsExists: deps.fsExists ?? ready.fsExists,
    fsExecutable: deps.fsExecutable ?? ready.fsExecutable,
  };

  // --- Table-driven supported settings → invocation treatment ---
  if (typeof adapter.buildInvocation === "function") {
    for (const ctx of supportedSettingCases(adapter)) {
      try {
        const inv = adapter.buildInvocation(ctx);
        if (!inv || typeof inv.cmd !== "string" || !Array.isArray(inv.args)) {
          failures.push(
            fail(name, "buildInvocation", `must return { cmd, args, cwd, promptDelivery }`),
          );
          continue;
        }
        if (typeof inv.cwd !== "string") {
          failures.push(fail(name, "buildInvocation", `cwd must be a string`));
        }
        if (!inv.promptDelivery) {
          failures.push(fail(name, "buildInvocation", `promptDelivery is required`));
        }
        if (
          adapter.declaration?.prompt?.delivery &&
          inv.promptDelivery !== adapter.declaration.prompt.delivery
        ) {
          failures.push(
            fail(
              name,
              "invocation-treatment",
              `buildInvocation promptDelivery "${inv.promptDelivery}" does not match declaration.prompt.delivery "${adapter.declaration.prompt.delivery}"`,
            ),
          );
        }
        if (
          inv.cmd !== adapter.declaration?.executable?.command &&
          adapter.declaration?.origin !== "compatibility"
        ) {
          if (
            adapter.declaration?.origin === "builtin" ||
            adapter.declaration?.origin === "extension"
          ) {
            failures.push(
              fail(
                name,
                "invocation-treatment",
                `buildInvocation.cmd "${inv.cmd}" does not match declaration.executable.command "${adapter.declaration?.executable?.command}"`,
              ),
            );
          }
        }
        // cwd / worktree treatment
        if (adapter.capabilities?.workingDir === "cwd") {
          if (inv.cwd !== ctx.worktreeDir) {
            failures.push(
              fail(
                name,
                "invocation-treatment",
                `workingDir "cwd": inv.cwd "${inv.cwd}" must equal worktreeDir "${ctx.worktreeDir}"`,
              ),
            );
          }
        } else if (adapter.capabilities?.workingDir === "flag") {
          // Flag adapters still set process cwd or embed worktree in args.
          if (
            inv.cwd !== ctx.worktreeDir &&
            !inv.args.some((a) => typeof a === "string" && a.includes(ctx.worktreeDir))
          ) {
            failures.push(
              fail(
                name,
                "invocation-treatment",
                `workingDir "flag": worktreeDir must appear in args or inv.cwd`,
              ),
            );
          }
        }
        // Supported model/effort/sandbox must not be silently dropped from treatment identity.
        if (typeof adapter.describeTreatment === "function") {
          const req: AdapterRequest = {
            model: ctx.model,
            effort: ctx.effort,
            sandbox: ctx.sandbox,
          };
          const treatment = adapter.describeTreatment(req, inv, {
            cliVersion: null,
            providerAuthClass: "unknown",
            resolvedModel: null,
            throttled: null,
          });
          if (ctx.model && treatment.requestedModel !== ctx.model) {
            failures.push(
              fail(
                name,
                "invocation-treatment",
                `supported model "${ctx.model}" not recorded as requestedModel (got ${JSON.stringify(treatment.requestedModel)})`,
              ),
            );
          }
          if (ctx.effort && treatment.requestedEffort !== ctx.effort) {
            failures.push(
              fail(
                name,
                "invocation-treatment",
                `supported effort "${ctx.effort}" not recorded as requestedEffort (got ${JSON.stringify(treatment.requestedEffort)})`,
              ),
            );
          }
        }
        // Preflight must accept supported settings (no unsupported-setting).
        if (typeof adapter.preflight === "function") {
          const req: AdapterRequest = {
            model: ctx.model,
            effort: ctx.effort,
            sandbox: ctx.sandbox,
          };
          // Only assert when at least one supported setting is present.
          if (ctx.model || ctx.effort || ctx.sandbox) {
            const res = await adapter.preflight(presentDeps, req);
            if (!res.ok && res.failure === "unsupported-setting") {
              failures.push(
                fail(
                  name,
                  "invocation-treatment",
                  `declared-supported setting refused as unsupported-setting: ${res.message ?? res.failure}`,
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
  }

  // Unsupported-capability refusal (no silent drop)
  if (typeof adapter.preflight === "function" && adapter.capabilities) {
    if (!adapter.capabilities.model) {
      try {
        const res = await adapter.preflight(presentDeps, { model: "invented-model-xyz" });
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
        const res = await adapter.preflight(presentDeps, { effort: "invented-effort-xyz" });
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
        const res = await adapter.preflight(presentDeps, { sandbox: true });
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

  // Output-envelope normalization via parseTelemetry
  if (typeof adapter.parseTelemetry === "function") {
    const envelopeSamples: string[] = [
      "",
      "not-json",
      "{",
      "null",
      "[]",
      "partial { broken",
      "plain assistant text without envelope\n",
    ];
    // Representative JSONL / result envelopes (claude / codex / grok-shaped).
    // Vendor-neutral: every jsonl adapter must non-throw on all samples and
    // must not invent resolvedModel from unparseable input (#778).
    if (
      adapter.declaration?.outputEnvelope === "jsonl" ||
      adapter.declaration?.telemetry === "jsonl" ||
      adapter.capabilities?.telemetry === "jsonl"
    ) {
      envelopeSamples.push(
        '{"type":"result","result":"conformance-text","total_cost_usd":0.01,"usage":{"input_tokens":1},"modelUsage":{"conformance-resolved":{}}}\n',
        '{"type":"item.completed","item":{"type":"agent_message","text":"codex-text"}}\n{"type":"turn.completed","usage":{"input_tokens":2}}\n',
        '{"text":"grok-text","total_cost_usd":0.02,"usage":{"input_tokens":3},"modelUsage":{"conformance-grok":{}}}\n',
      );
    }
    if (adapter.declaration?.outputEnvelope === "passthrough" || adapter.declaration?.outputEnvelope === "text") {
      envelopeSamples.push("passthrough body line one\npassthrough body line two\n");
    }

    for (const sample of envelopeSamples) {
      try {
        const tel = adapter.parseTelemetry(sample);
        if (!tel || typeof tel !== "object") {
          failures.push(fail(name, "output-normalization", `parseTelemetry must return an object`));
          break;
        }
        for (const key of Object.keys(EMPTY_TELEMETRY)) {
          if (!(key in tel)) {
            failures.push(
              fail(name, "output-normalization", `parseTelemetry result missing key "${key}"`),
            );
          }
        }
        // Malformed / empty input must not invent a resolved model.
        if (
          (sample === "" || sample === "not-json" || sample === "{" || sample === "null") &&
          tel.resolvedModel !== null &&
          tel.resolvedModel !== undefined
        ) {
          failures.push(
            fail(
              name,
              "output-normalization",
              `parseTelemetry invented resolvedModel "${tel.resolvedModel}" from unparseable input`,
            ),
          );
        }
      } catch (err) {
        failures.push(
          fail(
            name,
            "output-normalization",
            `parseTelemetry threw on sample ${JSON.stringify(sample).slice(0, 80)}: ${(err as Error).message}`,
          ),
        );
      }
    }
  }

  // Telemetry never throws; nulls when absent (legacy check name kept)
  if (typeof adapter.parseTelemetry === "function") {
    try {
      const empty = adapter.parseTelemetry("");
      for (const key of Object.keys(EMPTY_TELEMETRY)) {
        if (!(key in empty)) {
          failures.push(fail(name, "telemetry", `parseTelemetry result missing key "${key}"`));
        }
      }
    } catch (err) {
      failures.push(fail(name, "telemetry", `parseTelemetry threw: ${(err as Error).message}`));
    }
  }

  // #778: built-in adapters that enable machine-readable telemetry MUST expose
  // a structured verified-against identity (no silent jsonl without baseline).
  if (
    adapter.declaration?.origin === "builtin" &&
    (adapter.capabilities?.telemetry === "jsonl" || adapter.declaration?.telemetry === "jsonl")
  ) {
    const verified = getVerifiedAgainst(adapter.name);
    if (!verified || !verified.version) {
      failures.push(
        fail(
          name,
          "verified-against",
          `jsonl-declared built-in must record a non-empty verified-against identity`,
        ),
      );
    } else if (verified.telemetry !== "jsonl") {
      failures.push(
        fail(
          name,
          "verified-against",
          `jsonl-declared built-in has verified-against.telemetry="${verified.telemetry}" (expected "jsonl")`,
        ),
      );
    }
  }

  // describeTreatment identity separation
  if (typeof adapter.describeTreatment === "function" && typeof adapter.buildInvocation === "function") {
    try {
      const inv = adapter.buildInvocation({
        prompt: "p",
        worktreeDir: CONFORMANCE_WORKTREE,
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
      if (
        treatment.providerAuthClass &&
        treatment.providerAuthClass !== "unknown" &&
        (adapter.declaration?.origin === "extension" ||
          adapter.declaration?.origin === "compatibility")
      ) {
        failures.push(
          fail(
            name,
            "identity",
            `extension/compatibility adapter must not invent providerAuthClass (got "${treatment.providerAuthClass}")`,
          ),
        );
      }
    } catch (err) {
      failures.push(fail(name, "identity", `describeTreatment threw: ${(err as Error).message}`));
    }
  }

  // runtimeSmoke is callable and returns a preflight-shaped result
  if (typeof adapter.runtimeSmoke === "function") {
    try {
      const smoke = await adapter.runtimeSmoke(presentDeps);
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

  // --- Failure classification simulations ---
  if (typeof adapter.preflight === "function") {
    // missing-cli
    const missingDeps: AdapterPreflightDeps = {
      exec: async () => ({ ok: false, stdout: "", stderr: "not found" }),
      execCheck: async () => false,
      fsExists: async () => false,
      fsExecutable: async () => false,
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
      } else if (!res.failure) {
        failures.push(
          fail(name, "failure-classification", `preflight failure class is missing`),
        );
      } else if (res.failure !== "missing-cli") {
        // Prefer missing-cli when every presence probe fails; other public
        // classes are still acceptable only when the adapter cannot reach a
        // presence check (should not happen with these deps).
        failures.push(
          fail(
            name,
            "failure-classification",
            `expected missing-cli when CLI probes fail, got "${res.failure}"`,
          ),
        );
      }
    } catch (err) {
      failures.push(
        fail(name, "failure-classification", `preflight threw: ${(err as Error).message}`),
      );
    }

    // unauthenticated — only required when the adapter declares a documented auth probe
    if (adapter.declaration?.authProbe === "documented") {
      const unauthDeps: AdapterPreflightDeps = {
        execCheck: async (_file, args) => {
          // Keep presence and opencode headless probe green so auth is reached.
          if (args[0] === "run" && args[1] === "--help") return true;
          return true;
        },
        exec: async (_file, args) => {
          const joined = args.join(" ");
          if (joined.includes("--help") || joined.includes("help")) {
            return {
              ok: true,
              stdout: "Usage:\n  -p, --print\n  --mode\n  run  Run headless\n",
              stderr: "",
            };
          }
          if (joined.includes("auth status")) {
            return { ok: true, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
          }
          // codex login status / grok models / pi list-models / opencode providers
          return {
            ok: false,
            stdout: "No models available. Use /login ...",
            stderr: "not authenticated",
          };
        },
        fsExists: async () => true,
        fsExecutable: async () => true,
      };
      try {
        const res = await adapter.preflight(unauthDeps, {});
        if (res.ok || res.failure !== "unauthenticated") {
          failures.push(
            fail(
              name,
              "failure-classification",
              `documented authProbe: expected unauthenticated when auth probes fail (ok=${res.ok}, failure=${res.failure})`,
            ),
          );
        }
      } catch (err) {
        failures.push(
          fail(
            name,
            "failure-classification",
            `unauthenticated simulation threw: ${(err as Error).message}`,
          ),
        );
      }
    }

    // headless-unavailable — simulate when the adapter can surface that class
    {
      const headlessDeps: AdapterPreflightDeps = {
        execCheck: async (_file, args) => {
          // Presence OK; opencode headless probe fails.
          if (args[0] === "run" && args[1] === "--help") return false;
          if (args.includes("--version") || args.includes("--help")) return true;
          return true;
        },
        exec: async (_file, args) => {
          const joined = args.join(" ");
          // pi headless: --help fails
          if (joined === "--help" || (args.length === 1 && args[0] === "--help")) {
            return { ok: false, stdout: "", stderr: "help failed" };
          }
          if (joined.includes("auth status")) {
            return { ok: true, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
          }
          return { ok: true, stdout: "ok", stderr: "" };
        },
        fsExists: async () => true,
        fsExecutable: async () => true,
      };
      try {
        const res = await adapter.preflight(headlessDeps, {});
        if (!res.ok && res.failure === "headless-unavailable") {
          // Applicable and correctly classified.
        } else if (!res.ok && res.failure && PREFLIGHT_FAILURES.has(res.failure)) {
          // Not applicable for this adapter under this simulation (e.g. hits
          // unauthenticated or missing first) — do not fail the kit.
        } else if (res.ok) {
          // Adapter has no headless probe path — not applicable.
        } else if (res.failure && !PREFLIGHT_FAILURES.has(res.failure)) {
          failures.push(
            fail(
              name,
              "failure-classification",
              `headless simulation produced non-public failure "${res.failure}"`,
            ),
          );
        }
      } catch (err) {
        failures.push(
          fail(
            name,
            "failure-classification",
            `headless simulation threw: ${(err as Error).message}`,
          ),
        );
      }
    }
  }

  return { adapter: name, ok: failures.length === 0, failures };
}
