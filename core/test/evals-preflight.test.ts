// Fixture integrity preflight (#637). No real git/network/subprocess —
// all I/O through injectable deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIXTURE_PREFLIGHT_REASON_PREFIX,
  findDisallowedTestRootTokens,
  formatPreflightFailures,
  preflightReason,
  publicChecksRequirePluginMirror,
  allowsPluginMirrorPaths,
  runDeepFixturePreflight,
  runStaticFixturePreflight,
} from "../scripts/evals/preflight.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import type { Fixture } from "../scripts/evals/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";
const MISSING = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeFixture(overrides: Record<string, unknown> = {}): Fixture {
  const refs = (overrides.grader_refs as unknown[] | undefined) ?? [];
  const smoke =
    overrides.smoke_only !== undefined
      ? overrides.smoke_only
      : refs.length === 0;
  return validateFixture(
    {
      fixture_id: "fx",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
      grader_refs: refs,
      smoke_only: smoke,
      ...overrides,
      grader_refs: overrides.grader_refs ?? refs,
      smoke_only: overrides.smoke_only !== undefined ? overrides.smoke_only : smoke,
    },
    "fx.json",
  );
}

// Minimal cfg shape — preflight only reads repo_dir for worktree layout.
// Avoid importing scripts/types.ts (pulls zod) — structural match is enough.
const cfg = { repo_dir: "/repo" } as { repo_dir: string } as Parameters<
  typeof runDeepFixturePreflight
>[0];

test("preflightReason: stable fixture_preflight:<check>:<id> namespace", () => {
  assert.equal(preflightReason("base_commit_reachable", "fx"), "fixture_preflight:base_commit_reachable:fx");
  assert.ok(preflightReason("path_token", "fx").startsWith(FIXTURE_PREFLIGHT_REASON_PREFIX));
});

test("findDisallowedTestRootTokens: flags bare test/ roots, not core/test/", () => {
  assert.deepEqual(findDisallowedTestRootTokens("node --test test/gh.test.ts"), ["test/gh.test.ts"]);
  assert.deepEqual(findDisallowedTestRootTokens("node --test core/test/gh.test.ts"), []);
});

test("publicChecksRequirePluginMirror / allowsPluginMirrorPaths", () => {
  assert.equal(publicChecksRequirePluginMirror(["npm run ci"]), true);
  assert.equal(publicChecksRequirePluginMirror(["echo ok"]), false);
  assert.equal(allowsPluginMirrorPaths(["core/scripts/gh.ts"]), false);
  assert.equal(allowsPluginMirrorPaths(["core/scripts/gh.ts", "plugin/scripts/gh.ts"]), true);
  assert.equal(allowsPluginMirrorPaths(undefined), true);
});

test("static preflight: missing base_commit object fails naming fixture and SHA", async () => {
  const fixture = makeFixture({ base_commit: MISSING });
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async () => null,
  });
  assert.equal(result.ok, false);
  const miss = result.failures.find((f) => f.check === "base_commit_reachable");
  assert.ok(miss);
  assert.equal(miss!.fixture_id, "fx");
  assert.match(miss!.detail, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(miss!.reason, /fixture_preflight:base_commit_reachable:fx/);
  assert.match(formatPreflightFailures(result.failures), /fixture_preflight:base_commit_reachable:fx/);
});

test("static preflight: present commit object passes reachability", async () => {
  const fixture = makeFixture();
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async (sha) => (sha === SHA ? "commit" : null),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("static preflight: bare test/ path token fails naming fixture", async () => {
  const fixture = makeFixture({
    public_checks: ["node --test test/gh.test.ts"],
  });
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async () => "commit",
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === "path_token"));
  assert.match(result.failures.find((f) => f.check === "path_token")!.detail, /test\/gh/);
});

test("static preflight: missing plugin allowance when npm run ci + allowed_change_paths fails", async () => {
  const fixture = makeFixture({
    public_checks: ["npm run ci"],
    allowed_change_paths: ["core/scripts/gh.ts"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async () => "commit",
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === "plugin_allowance"));
});

test("deep preflight: red public baseline blocks treatments (infra)", async () => {
  const fixture = makeFixture({
    public_checks: ["npm run ci"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
    allowed_change_paths: ["core/scripts/gh.ts", "plugin/scripts/gh.ts"],
  });
  const result = await runDeepFixturePreflight(cfg, fixture, {
    staticDeps: { catFile: async () => "commit" },
    createWorktree: async () => {},
    removeWorktree: async () => {},
    runCheck: async () => false, // baseline red
    pathExists: async () => true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === "public_baseline"));
  assert.match(result.failures[0].reason, /fixture_preflight:public_baseline:fx/);
});

test("deep preflight: non-biting hidden probe fails preflight", async () => {
  const fixture = makeFixture({
    public_checks: [],
    hidden_checks: ["node --test core/test/gh.test.ts -- --grep missing"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(cfg, fixture, {
    staticDeps: { catFile: async () => "commit" },
    createWorktree: async () => {},
    removeWorktree: async () => {},
    runCheck: async () => true, // already passes = non-biting
    pathExists: async () => true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === "biting_probe"));
});

test("deep preflight: unresolvable path fails naming fixture", async () => {
  const fixture = makeFixture({
    public_checks: ["node --test core/test/missing.test.ts"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(cfg, fixture, {
    staticDeps: { catFile: async () => "commit" },
    createWorktree: async () => {},
    removeWorktree: async () => {},
    runCheck: async () => true,
    pathExists: async (_wt, rel) => rel !== "core/test/missing.test.ts",
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === "unresolvable_path"));
});

test("deep preflight: healthy baseline and biting hidden probe pass", async () => {
  const fixture = makeFixture({
    public_checks: ["npm test"],
    hidden_checks: ["node --test core/test/hidden.test.ts"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(cfg, fixture, {
    staticDeps: { catFile: async () => "commit" },
    createWorktree: async () => {},
    removeWorktree: async () => {},
    // public passes, hidden fails (biting)
    runCheck: async ({ check }) => !check.includes("hidden"),
    pathExists: async () => true,
  });
  assert.equal(result.ok, true, formatPreflightFailures(result.failures));
});
