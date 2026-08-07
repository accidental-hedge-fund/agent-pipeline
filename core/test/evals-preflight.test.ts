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
  runDeepExperimentPreflight,
  runDeepFixturePreflight,
  runStaticFixturePreflight,
  type DeepPreflightDeps,
} from "../scripts/evals/preflight.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import type { Fixture } from "../scripts/evals/types.ts";

/** Injectable cell-surface fakes for deep preflight unit tests (no real fs). */
function cellSurfaceFakes(extra: DeepPreflightDeps = {}): DeepPreflightDeps {
  return {
    staticDeps: { catFile: async () => "commit" },
    createWorktree: async () => {},
    removeWorktree: async () => {},
    bootstrapWorktree: async () => {},
    installBoundaryShim: () => "/fake-shim",
    removeBoundaryShim: () => {},
    isolationEnv: () => ({
      PATH: "/fake-shim:/usr/bin",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      EVAL_BOUNDARY_DENIAL_LOG: "/fake/denials.jsonl",
    }),
    pathExists: async () => true,
    ...extra,
  };
}

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
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({ runCheck: async () => false }),
  );
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
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({ runCheck: async () => true }), // already passes = non-biting
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.check === "biting_probe"));
});

test("deep preflight: unresolvable path fails naming fixture", async () => {
  const fixture = makeFixture({
    public_checks: ["node --test core/test/missing.test.ts"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      runCheck: async () => true,
      pathExists: async (_wt, rel) => rel !== "core/test/missing.test.ts",
    }),
  );
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
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      // public passes, hidden fails (biting)
      runCheck: async ({ check }) => !check.includes("hidden"),
    }),
  );
  assert.equal(result.ok, true, formatPreflightFailures(result.failures));
});

// --- #637 review 1: smoke-only must not bypass deep preflight (235a716c) ---

test("deep experiment preflight: smoke_only fixtures still run deep cell-like checks", async () => {
  const events: string[] = [];
  const fixture = makeFixture({
    smoke_only: true,
    grader_refs: [],
    public_checks: ["true"],
  });
  const fixtures = new Map([["fx", fixture]]);
  const result = await runDeepExperimentPreflight(cfg, fixtures, ["fx"], {
    ...cellSurfaceFakes({
      createWorktree: async () => {
        events.push("createWorktree");
      },
      bootstrapWorktree: async () => {
        events.push("bootstrap");
      },
      installBoundaryShim: () => {
        events.push("shim");
        return "/fake-shim";
      },
      runCheck: async ({ env }) => {
        events.push("check");
        assert.ok(env, "deep checks must receive cell isolation env");
        assert.equal(env.GH_TOKEN, "");
        return true;
      },
    }),
  });
  assert.equal(result.ok, true, formatPreflightFailures(result.failures));
  assert.ok(events.includes("createWorktree"), "smoke_only must allocate a cell-like worktree");
  assert.ok(events.includes("bootstrap"), "smoke_only must run dependency bootstrap surface");
  assert.ok(events.includes("shim"), "smoke_only must install PATH deny shim");
  assert.ok(events.includes("check"), "smoke_only must run deep public baseline checks");
});

// --- #637 review 1: deep checks use cell isolation + bootstrap (f386edda) ---

test("deep preflight: bootstrap, boundary shim, then checks with isolation env", async () => {
  const events: string[] = [];
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const fixture = makeFixture({
    public_checks: ["npm test"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      sandboxMode: "managed",
      createWorktree: async () => {
        events.push("createWorktree");
      },
      bootstrapWorktree: async () => {
        events.push("bootstrap");
      },
      installBoundaryShim: () => {
        events.push("shim");
        return "/fake-shim";
      },
      removeBoundaryShim: () => {
        events.push("removeShim");
      },
      isolationEnv: () => {
        events.push("isolationEnv");
        return {
          PATH: "/fake-shim:/usr/bin",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          SSH_AUTH_SOCK: "",
          EVAL_BOUNDARY_DENIAL_LOG: "/fake/denials.jsonl",
        };
      },
      runCheck: async ({ env }) => {
        events.push("check");
        seenEnv = env;
        return true;
      },
      removeWorktree: async () => {
        events.push("removeWorktree");
      },
    }),
  );
  assert.equal(result.ok, true, formatPreflightFailures(result.failures));
  // Cell surface order: worktree → bootstrap → shim → isolation env → check → cleanup.
  const createIdx = events.indexOf("createWorktree");
  const bootIdx = events.indexOf("bootstrap");
  const shimIdx = events.indexOf("shim");
  const envIdx = events.indexOf("isolationEnv");
  const checkIdx = events.indexOf("check");
  const removeShimIdx = events.indexOf("removeShim");
  const removeWtIdx = events.indexOf("removeWorktree");
  assert.ok(createIdx >= 0 && bootIdx > createIdx, "bootstrap after worktree");
  assert.ok(shimIdx > bootIdx, "boundary shim after bootstrap");
  assert.ok(envIdx > shimIdx, "isolation env after shim");
  assert.ok(checkIdx > envIdx, "checks after isolation env");
  assert.ok(removeShimIdx > checkIdx, "shim removed after checks");
  assert.ok(removeWtIdx > removeShimIdx, "worktree removed last");
  assert.ok(seenEnv);
  assert.equal(seenEnv!.GH_TOKEN, "", "checks must not observe ambient GH credentials");
  assert.match(String(seenEnv!.PATH), /fake-shim/, "checks must run with PATH deny shim prepended");
});

test("deep preflight: bootstrap failure is infrastructure and skips checks", async () => {
  let checkRan = false;
  const fixture = makeFixture({
    public_checks: ["npm test"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      bootstrapWorktree: async () => {
        throw new Error("npm ci failed");
      },
      runCheck: async () => {
        checkRan = true;
        return true;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(checkRan, false, "checks must not run after bootstrap failure");
  assert.ok(result.failures.some((f) => f.check === "bootstrap"));
  assert.match(result.failures[0].detail, /npm ci failed/);
});
