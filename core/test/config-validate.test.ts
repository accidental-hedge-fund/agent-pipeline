// Tests for generateConfigSchema() and validateConfig() (#156).
//
// All tests use injected deps (ValidateConfigDeps) — no real filesystem,
// subprocess, or network calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateConfigSchema,
  validateConfig,
  RIGOR_GATING_PATHS,
  type ValidateConfigDeps,
  type Diagnostic,
} from "../scripts/config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build ValidateConfigDeps that fakes a git root and a pipeline.yml. */
function makeDeps(
  yamlContent: string | null,
  harnesses = { implementer: "codex", reviewer: "claude" },
): ValidateConfigDeps {
  return {
    findGitRoot: (_start: string) => "/fake-repo",
    readFile: (fp: string) => {
      if (fp.endsWith("pipeline.yml")) return yamlContent;
      return null;
    },
    harnesses,
  };
}

/** Resolve a dotted property path ("a.b.c") into the JSON Schema object. */
function resolvePath(schema: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let cur: unknown = schema;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)["properties"];
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// 5.1 Schema generation
// ---------------------------------------------------------------------------

test("generateConfigSchema: returns a JSON Schema object with top-level keys", () => {
  const schema = generateConfigSchema() as Record<string, unknown>;
  assert.ok(schema.properties, "schema must have a properties key");
  const props = schema.properties as Record<string, unknown>;
  for (const key of ["base_branch", "review_policy", "steps", "eval_gate", "shipcheck_gate"]) {
    assert.ok(props[key], `schema must include top-level key: ${key}`);
  }
});

test("generateConfigSchema: review_policy.block_threshold has correct enum", () => {
  const schema = generateConfigSchema();
  const field = resolvePath(schema as Record<string, unknown>, "review_policy.block_threshold") as Record<string, unknown> | undefined;
  assert.ok(field, "review_policy.block_threshold must exist in schema");
  assert.deepEqual(field["enum"], ["critical", "high", "medium", "low"]);
});

test("generateConfigSchema: eval_gate.mode has correct enum", () => {
  const schema = generateConfigSchema();
  const field = resolvePath(schema as Record<string, unknown>, "eval_gate.mode") as Record<string, unknown> | undefined;
  assert.ok(field, "eval_gate.mode must exist in schema");
  assert.deepEqual(field["enum"], ["gate", "advisory"]);
});

test("generateConfigSchema: openspec.enabled has correct enum", () => {
  const schema = generateConfigSchema();
  const field = resolvePath(schema as Record<string, unknown>, "openspec.enabled") as Record<string, unknown> | undefined;
  assert.ok(field, "openspec.enabled must exist in schema");
  assert.deepEqual(field["enum"], ["auto", "on", "off"]);
});

test("generateConfigSchema: all top-level properties carry a non-empty description", () => {
  const schema = generateConfigSchema() as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  for (const [key, def] of Object.entries(props)) {
    assert.ok(
      typeof def["description"] === "string" && def["description"].length > 0,
      `top-level property "${key}" must have a non-empty description`,
    );
  }
});

test("generateConfigSchema: review_policy sub-properties carry descriptions", () => {
  const schema = generateConfigSchema() as Record<string, unknown>;
  const rpDef = resolvePath(schema, "review_policy") as Record<string, unknown> | undefined;
  assert.ok(rpDef, "review_policy must exist");
  const rpProps = rpDef["properties"] as Record<string, Record<string, unknown>> | undefined;
  assert.ok(rpProps, "review_policy must have properties");
  for (const [key, def] of Object.entries(rpProps)) {
    assert.ok(
      typeof def["description"] === "string" && def["description"].length > 0,
      `review_policy.${key} must have a non-empty description`,
    );
  }
});

test("generateConfigSchema: steps sub-properties carry descriptions", () => {
  const schema = generateConfigSchema() as Record<string, unknown>;
  const stepsDef = resolvePath(schema, "steps") as Record<string, unknown> | undefined;
  assert.ok(stepsDef, "steps must exist");
  const stepsProps = stepsDef["properties"] as Record<string, Record<string, unknown>> | undefined;
  assert.ok(stepsProps, "steps must have properties");
  for (const [key, def] of Object.entries(stepsProps)) {
    assert.ok(
      typeof def["description"] === "string" && def["description"].length > 0,
      `steps.${key} must have a non-empty description`,
    );
  }
});

test("generateConfigSchema: all top-level keys are optional (not in required array)", () => {
  const schema = generateConfigSchema() as Record<string, unknown>;
  // Zod v4 omits `required` entirely when all fields are optional
  const required = schema["required"];
  assert.ok(
    required === undefined || (Array.isArray(required) && required.length === 0),
    "all top-level keys must be optional (no required array, or empty required array)",
  );
});

// ---------------------------------------------------------------------------
// 5.2 RIGOR_GATING_PATHS resolves to real properties
// ---------------------------------------------------------------------------

test("RIGOR_GATING_PATHS: every path resolves to a real property in the generated schema", () => {
  const schema = generateConfigSchema();
  for (const gatingPath of RIGOR_GATING_PATHS) {
    const resolved = resolvePath(schema as Record<string, unknown>, gatingPath);
    assert.ok(
      resolved !== undefined,
      `RIGOR_GATING_PATHS entry "${gatingPath}" must resolve to a property in the JSON Schema`,
    );
  }
});

test("RIGOR_GATING_PATHS: contains expected minimum set of paths", () => {
  const required = [
    "review_policy.block_threshold",
    "review_policy.min_confidence",
    "review_policy.max_adversarial_rounds",
    "steps.plan_review",
    "steps.standard_review",
    "steps.adversarial_review",
    "eval_gate.enabled",
    "eval_gate.mode",
    "shipcheck_gate.enabled",
    "shipcheck_gate.mode",
  ];
  for (const p of required) {
    assert.ok(RIGOR_GATING_PATHS.includes(p), `RIGOR_GATING_PATHS must include "${p}"`);
  }
});

// ---------------------------------------------------------------------------
// 5.3 validateConfig: valid config
// ---------------------------------------------------------------------------

test("validateConfig: valid config returns { valid: true, diagnostics: [] }", () => {
  const deps = makeDeps(`
base_branch: main
review_policy:
  block_threshold: high
  min_confidence: 0.8
steps:
  plan_review: true
  standard_review: true
  adversarial_review: true
`);
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test("validateConfig: empty file is valid (all defaults apply)", () => {
  const deps = makeDeps("");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

// ---------------------------------------------------------------------------
// 5.4 validateConfig: missing file
// ---------------------------------------------------------------------------

test("validateConfig: missing config file returns error diagnostic, does not throw", () => {
  const deps: ValidateConfigDeps = {
    findGitRoot: () => "/fake-repo",
    readFile: () => null,
    harnesses: { implementer: "codex", reviewer: "claude" },
  };
  let result;
  assert.doesNotThrow(() => {
    result = validateConfig("/fake-repo", deps);
  });
  assert.equal((result as unknown as { valid: boolean }).valid, false);
  const diags = (result as unknown as { diagnostics: Diagnostic[] }).diagnostics;
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.path, "");
  assert.ok(diags[0]!.message.includes("not found") || diags[0]!.message.includes("pipeline.yml"));
});

// ---------------------------------------------------------------------------
// 5.5 validateConfig: invalid YAML
// ---------------------------------------------------------------------------

test("validateConfig: invalid YAML returns error diagnostic with line number, does not throw", () => {
  const deps = makeDeps("key: [\n  bad: value");
  let result;
  assert.doesNotThrow(() => {
    result = validateConfig("/fake-repo", deps);
  });
  assert.equal((result as unknown as { valid: boolean }).valid, false);
  const diags = (result as unknown as { diagnostics: Diagnostic[] }).diagnostics;
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.path, "");
  assert.ok(typeof diags[0]!.line === "number", "line must be a number for YAML errors");
  assert.ok(diags[0]!.line! > 0, "line must be 1-indexed (>0)");
});

// ---------------------------------------------------------------------------
// 5.6 validateConfig: unknown key
// ---------------------------------------------------------------------------

test("validateConfig: unknown top-level key returns error diagnostic, does not throw", () => {
  const deps = makeDeps("auto_merge: true\n");
  let result;
  assert.doesNotThrow(() => {
    result = validateConfig("/fake-repo", deps);
  });
  assert.equal((result as unknown as { valid: boolean }).valid, false);
  const diags = (result as unknown as { diagnostics: Diagnostic[] }).diagnostics;
  assert.ok(diags.length > 0);
  const d = diags.find((x) => x.path === "auto_merge");
  assert.ok(d, `expected diagnostic with path "auto_merge", got: ${JSON.stringify(diags)}`);
  assert.equal(d!.severity, "error");
});

// ---------------------------------------------------------------------------
// 5.7 validateConfig: rigor-gating bad value
// ---------------------------------------------------------------------------

test("validateConfig: bad review_policy.block_threshold → error with rigorGating:true, does not throw", () => {
  const deps = makeDeps("review_policy:\n  block_threshold: typo\n");
  let result;
  assert.doesNotThrow(() => {
    result = validateConfig("/fake-repo", deps);
  });
  assert.equal((result as unknown as { valid: boolean }).valid, false);
  const diags = (result as unknown as { diagnostics: Diagnostic[] }).diagnostics;
  const d = diags.find((x) => x.path === "review_policy.block_threshold");
  assert.ok(d, `expected diagnostic for review_policy.block_threshold, got: ${JSON.stringify(diags)}`);
  assert.equal(d!.severity, "error");
  assert.equal(d!.rigorGating, true);
});

test("validateConfig: bad steps.adversarial_review type → error with rigorGating:true", () => {
  const deps = makeDeps('steps:\n  adversarial_review: "yes"\n');
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((x) => x.path === "steps.adversarial_review");
  assert.ok(d, `expected diagnostic for steps.adversarial_review, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "error");
  assert.equal(d!.rigorGating, true);
});

test("validateConfig: bad eval_gate.mode enum → error with rigorGating:true", () => {
  const deps = makeDeps('eval_gate:\n  mode: blocking\n');
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((x) => x.path === "eval_gate.mode");
  assert.ok(d, `expected diagnostic for eval_gate.mode, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "error");
  assert.equal(d!.rigorGating, true);
});

// ---------------------------------------------------------------------------
// 5.8 validateConfig: inert-model warning
// ---------------------------------------------------------------------------

test("validateConfig: models.review set while reviewer=codex → warning, valid:true", () => {
  // reviewer=codex means models.review is inert
  const deps = makeDeps(
    'models:\n  review: "claude-opus-4-8"\n',
    { implementer: "claude", reviewer: "codex" },
  );
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true, "warning-only should be valid");
  const d = result.diagnostics.find((x) => x.path === "models.review");
  assert.ok(d, `expected warning for models.review, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "warning");
});

test("validateConfig: models.review set while reviewer=claude → no warning (not inert)", () => {
  // reviewer=claude means models.review IS honored
  const deps = makeDeps(
    'models:\n  review: "claude-opus-4-8"\n',
    { implementer: "codex", reviewer: "claude" },
  );
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true);
  const d = result.diagnostics.find((x) => x.path === "models.review");
  assert.equal(d, undefined, "no warning when reviewer is claude");
});

test("validateConfig: warning-only run has valid:true and exit-0 semantics", () => {
  const deps = makeDeps(
    'models:\n  planning: haiku\n',
    { implementer: "codex", reviewer: "claude" }, // implementer=codex → models.planning is inert
  );
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((d) => d.severity === "warning"));
});

// ---------------------------------------------------------------------------
// 5.9 validateConfig: never throws
// ---------------------------------------------------------------------------

test("validateConfig: no git root → returns error, does not throw", () => {
  const deps: ValidateConfigDeps = {
    findGitRoot: () => null,
    readFile: () => null,
    harnesses: { implementer: "codex", reviewer: "claude" },
  };
  assert.doesNotThrow(() => validateConfig("/no-git-here", deps));
  const result = validateConfig("/no-git-here", deps);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.severity === "error"));
});

test("validateConfig: validateConfig independent of resolveConfig — resolveConfig still throws on same invalid input", () => {
  // validateConfig returns structured result for a bad value
  const deps = makeDeps("review_policy:\n  block_threshold: invalid\n");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.path === "review_policy.block_threshold"));
  // We don't call resolveConfig here (it would need a real fs + gh), but
  // the test asserts that validateConfig does not throw even when the config
  // would cause resolveConfig to throw.
  assert.doesNotThrow(() => validateConfig("/fake-repo", deps));
});

// ---------------------------------------------------------------------------
// 5.10 validateConfig: scalar YAML root (finding 4)
// ---------------------------------------------------------------------------

test("validateConfig: scalar string YAML is an error, not valid", () => {
  const deps = makeDeps("just-a-string");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0]!.severity, "error");
  assert.equal(result.diagnostics[0]!.path, "");
  assert.ok(result.diagnostics[0]!.message.includes("string"));
});

test("validateConfig: boolean YAML root (false) is an error, not valid", () => {
  const deps = makeDeps("false");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0]!.severity, "error");
});

test("validateConfig: numeric YAML root (0) is an error, not valid", () => {
  const deps = makeDeps("0");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0]!.severity, "error");
});

// ---------------------------------------------------------------------------
// 5.11 validateConfig: unknown nested key in eval_gate (finding 2)
// ---------------------------------------------------------------------------

test("validateConfig: misspelled eval_gate.enabled (enabeld) is an error, not silently accepted", () => {
  const deps = makeDeps("eval_gate:\n  enabeld: true\n");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((x) => x.path.startsWith("eval_gate"));
  assert.ok(d, `expected diagnostic for eval_gate unknown key, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "error");
});

test("validateConfig: misspelled eval_gate.mode (mdoe) is an error, not silently accepted", () => {
  const deps = makeDeps("eval_gate:\n  mdoe: advisory\n");
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((x) => x.path.startsWith("eval_gate"));
  assert.ok(d, `expected diagnostic for eval_gate unknown key, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "error");
});

// ---------------------------------------------------------------------------
// 5.12 validateConfig: review_harness override applies to inert-model detection (finding 3)
// ---------------------------------------------------------------------------

test("validateConfig: review_harness overrides profile reviewer for inert-model check — no warning when review_harness=claude", () => {
  // Profile says reviewer=codex, but file overrides it to claude → models.review IS honored → no warning
  const deps = makeDeps(
    "review_harness: claude\nmodels:\n  review: \"claude-opus-4-8\"\n",
    { implementer: "codex", reviewer: "codex" },
  );
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true);
  const d = result.diagnostics.find((x) => x.path === "models.review");
  assert.equal(d, undefined, "no inert warning when review_harness overrides reviewer to claude");
});

test("validateConfig: review_harness overrides profile reviewer — warning when review_harness=codex", () => {
  // Profile says reviewer=claude, but file overrides it to codex → models.review is inert → warning
  const deps = makeDeps(
    "review_harness: codex\nmodels:\n  review: \"claude-opus-4-8\"\n",
    { implementer: "codex", reviewer: "claude" },
  );
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, true, "warning-only should still be valid");
  const d = result.diagnostics.find((x) => x.path === "models.review");
  assert.ok(d, `expected inert warning when review_harness=codex, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "warning");
});

// ---------------------------------------------------------------------------
// 5.13 runConfigCommand CLI dispatch (finding 1)
// ---------------------------------------------------------------------------

import { runConfigCommand, type CliOpts } from "../scripts/pipeline.ts";

test("runConfigCommand: 'schema' subcommand writes valid JSON Schema to stdout", async () => {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // @ts-ignore — narrowing to string for test capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(String(chunk)); return true; };
  const prevExitCode = process.exitCode;
  try {
    await runConfigCommand(["schema"], { profile: "codex" } as CliOpts);
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = prevExitCode;
  }
  const output = chunks.join("");
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.ok(parsed["properties"], "schema output must have a properties key");
});

test("runConfigCommand: 'validate' subcommand with --json on non-existent repo writes JSON and does not throw", async () => {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // @ts-ignore — narrowing to string for test capture
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(String(chunk)); return true; };
  const prevExitCode = process.exitCode;
  let threw = false;
  try {
    await runConfigCommand(["validate"], { profile: "codex", json: true, repoPath: "/tmp/no-such-pipeline-repo-xyz" } as CliOpts);
  } catch {
    threw = true;
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = prevExitCode;
  }
  assert.equal(threw, false, "runConfigCommand must not throw");
  const output = chunks.join("");
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.ok("valid" in parsed, "output must have a 'valid' key");
  assert.ok("diagnostics" in parsed, "output must have a 'diagnostics' key");
  assert.equal(parsed["valid"], false); // no git root at /tmp/no-such-pipeline-repo-xyz
});

// ---------------------------------------------------------------------------
// 5.14 runConfigCommand: extra-arg rejection (review 2, finding 1)
// ---------------------------------------------------------------------------

test("runConfigCommand: extra args after 'schema' set exitCode=2 and do not write schema", async () => {
  const chunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalError = process.stderr.write.bind(process.stderr);
  // @ts-ignore
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(String(chunk)); return true; };
  // @ts-ignore
  process.stderr.write = (chunk: string | Uint8Array): boolean => { stderrChunks.push(String(chunk)); return true; };
  const prevExitCode = process.exitCode;
  try {
    await runConfigCommand(["schema", "extra"], { profile: "codex" } as CliOpts);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalError;
    const savedCode = process.exitCode;
    process.exitCode = prevExitCode;
    assert.equal(savedCode, 2, "exitCode must be 2 on extra args");
  }
  assert.equal(chunks.length, 0, "schema must not be written to stdout on extra args");
});

test("runConfigCommand: extra args after 'validate' set exitCode=2 and do not write JSON", async () => {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // @ts-ignore
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(String(chunk)); return true; };
  const prevExitCode = process.exitCode;
  try {
    await runConfigCommand(["validate", "extra"], { profile: "codex", json: true } as CliOpts);
  } finally {
    process.stdout.write = originalWrite;
    const savedCode = process.exitCode;
    process.exitCode = prevExitCode;
    assert.equal(savedCode, 2, "exitCode must be 2 on extra args");
  }
  assert.equal(chunks.length, 0, "no JSON must be written to stdout on extra args");
});

// ---------------------------------------------------------------------------
// 5.15 RIGOR_GATING_PATHS: shipcheck cost/rigor fields (review 2, finding 2)
// ---------------------------------------------------------------------------

test("validateConfig: bad shipcheck_gate.max_rounds type → error with rigorGating:true", () => {
  const deps = makeDeps('shipcheck_gate:\n  max_rounds: "many"\n');
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((x) => x.path === "shipcheck_gate.max_rounds");
  assert.ok(d, `expected diagnostic for shipcheck_gate.max_rounds, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "error");
  assert.equal(d!.rigorGating, true);
});

test("validateConfig: bad shipcheck_gate.block_on_partial type → error with rigorGating:true", () => {
  const deps = makeDeps('shipcheck_gate:\n  block_on_partial: "yes"\n');
  const result = validateConfig("/fake-repo", deps);
  assert.equal(result.valid, false);
  const d = result.diagnostics.find((x) => x.path === "shipcheck_gate.block_on_partial");
  assert.ok(d, `expected diagnostic for shipcheck_gate.block_on_partial, got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(d!.severity, "error");
  assert.equal(d!.rigorGating, true);
});

test("RIGOR_GATING_PATHS: includes shipcheck_gate.max_rounds and shipcheck_gate.block_on_partial", () => {
  assert.ok(RIGOR_GATING_PATHS.includes("shipcheck_gate.max_rounds"),
    "RIGOR_GATING_PATHS must include shipcheck_gate.max_rounds");
  assert.ok(RIGOR_GATING_PATHS.includes("shipcheck_gate.block_on_partial"),
    "RIGOR_GATING_PATHS must include shipcheck_gate.block_on_partial");
});

// ---------------------------------------------------------------------------
// #156 review-2: validation diagnostics carry source line numbers
// (so a desktop editor can attach unknown-key / bad-value errors to a location).
// ---------------------------------------------------------------------------

test("validateConfig: bad rigor-gating value carries source line + rigorGating", () => {
  const yaml = [
    "base_branch: main",        // line 1
    "review_policy:",           // line 2
    "  block_threshold: typo",  // line 3 — invalid enum on a rigor-gating path
  ].join("\n");
  const result = validateConfig("/repo", makeDeps(yaml));
  assert.equal(result.valid, false);
  const diag = result.diagnostics.find((d: Diagnostic) => d.path === "review_policy.block_threshold");
  assert.ok(diag, "expected a diagnostic for review_policy.block_threshold");
  assert.equal(diag!.severity, "error");
  assert.equal(diag!.rigorGating, true, "rigor-gating path must be marked");
  assert.equal(diag!.line, 3, `expected source line 3, got ${diag!.line}`);
});

test("validateConfig: unrecognized key carries a source line", () => {
  const yaml = [
    "base_branch: main",  // line 1
    "bogus_key: 1",       // line 2 — unknown top-level key
  ].join("\n");
  const result = validateConfig("/repo", makeDeps(yaml));
  assert.equal(result.valid, false);
  const diag = result.diagnostics.find((d: Diagnostic) => d.path === "bogus_key");
  assert.ok(diag, "expected a diagnostic for the unknown key");
  assert.equal(diag!.line, 2, `expected source line 2, got ${diag!.line}`);
});

// #156 review-2 round-2: the line locator must be YAML-CST-aware, not a regex scan.
// Flow mappings and block scalars broke the heuristic; these bite that failure.

test("validateConfig: flow-mapping bad rigor value carries the correct source line (#156)", () => {
  const yaml = [
    "base_branch: main",                         // line 1
    "review_policy: { block_threshold: typo }",  // line 2 — FLOW mapping, invalid enum
  ].join("\n");
  const result = validateConfig("/repo", makeDeps(yaml));
  assert.equal(result.valid, false);
  const diag = result.diagnostics.find((d: Diagnostic) => d.path === "review_policy.block_threshold");
  assert.ok(diag, "expected a diagnostic for the flow-mapping key");
  assert.equal(diag!.rigorGating, true);
  assert.equal(diag!.line, 2, `flow-mapping key must resolve to line 2; got ${diag!.line}`);
});

test("validateConfig: block-scalar config-like text does not mislocate the real bad key (#156)", () => {
  const yaml = [
    "setup_command: |",               // line 1
    "  echo 'block_threshold: typo'", // line 2 — config-like text INSIDE a string block scalar
    "  echo done",                    // line 3
    "review_policy:",                 // line 4
    "  block_threshold: typo",        // line 5 — the REAL invalid rigor-gating key
  ].join("\n");
  const result = validateConfig("/repo", makeDeps(yaml));
  assert.equal(result.valid, false);
  const diag = result.diagnostics.find((d: Diagnostic) => d.path === "review_policy.block_threshold");
  assert.ok(diag, "expected a diagnostic for the real key");
  assert.equal(diag!.line, 5, `must locate the real key at line 5, not the block-scalar text; got ${diag!.line}`);
});
