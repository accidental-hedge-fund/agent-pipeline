// Fixture integrity preflight (#637). No real git/network/subprocess —
// all I/O through injectable deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  FIXTURE_PREFLIGHT_REASON_PREFIX,
  findDisallowedTestRootTokens,
  formatPreflightFailures,
  preflightReason,
  publicChecksRequireGeneratedPackagingOutputs,
  allowsGeneratedPackagingOutput,
  requiredGeneratedPackagingOutputs,
  runDeepExperimentPreflight,
  runDeepFixturePreflight,
  runStaticFixturePreflight,
  type DeepPreflightDeps,
} from "../scripts/evals/preflight.ts";
import { loadFixture, validateFixture } from "../scripts/evals/fixture.ts";
import type { Fixture } from "../scripts/evals/types.ts";

/** Injectable cell-surface fakes for deep preflight unit tests (no real fs). */
function cellSurfaceFakes(extra: DeepPreflightDeps = {}): DeepPreflightDeps {
  return {
    staticDeps: {
      catFile: async () => "commit",
      readFileAtCommit: async () => null,
    },
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
    materializeReviewDiff: async () => "/fake/review.diff",
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

test("generated packaging allowance accepts only exact SKILL or catalog outputs", () => {
  assert.equal(publicChecksRequireGeneratedPackagingOutputs(["npm run ci"]), true);
  assert.equal(publicChecksRequireGeneratedPackagingOutputs(["echo ok"]), false);
  assert.equal(allowsGeneratedPackagingOutput(["core/scripts/gh.ts"]), false);
  assert.equal(allowsGeneratedPackagingOutput(["plugin"]), false);
  assert.equal(allowsGeneratedPackagingOutput(["plugin/"]), false);
  assert.equal(
    allowsGeneratedPackagingOutput(["plugin/pipeline/skills/pipeline/core/scripts/gh.ts"]),
    false,
  );
  assert.equal(
    allowsGeneratedPackagingOutput(["plugin/pipeline/skills/pipeline/SKILL.md"]),
    true,
  );
  assert.equal(allowsGeneratedPackagingOutput([".claude-plugin/marketplace.json"]), true);
  assert.equal(allowsGeneratedPackagingOutput(undefined), true);
  assert.deepEqual(
    requiredGeneratedPackagingOutputs(
      ["core/scripts/gh.ts"],
      "const CORE_ENTRIES = ['scripts'];\nconst coreDst = 'core';\n",
    ),
    ["plugin/pipeline/skills/pipeline/core/scripts/gh.ts"],
  );
  assert.deepEqual(requiredGeneratedPackagingOutputs(["core/scripts/gh.ts"], null), []);
  assert.deepEqual(
    requiredGeneratedPackagingOutputs(["core/scripts/command-registry.ts"], null),
    ["plugin/pipeline/skills/pipeline/SKILL.md"],
  );
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

test("static preflight: broad plugin allowance fails when generated packaging checks run", async () => {
  const fixture = makeFixture({
    public_checks: ["npm run ci"],
    allowed_change_paths: ["core/scripts/gh.ts", "plugin/"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async () => "commit",
  });
  assert.equal(result.ok, false);
  const allowance = result.failures.find((f) => f.check === "plugin_allowance");
  assert.ok(allowance);
  assert.match(allowance!.detail, /broad plugin/);
  assert.match(allowance!.remediation, /exact generator output path/);
  assert.match(allowance!.remediation, new RegExp(SHA));
});

test("static preflight: exact generated SKILL or catalog allowance passes", async () => {
  for (const generatedPath of [
    "plugin/pipeline/skills/pipeline/SKILL.md",
    ".claude-plugin/marketplace.json",
  ]) {
    const fixture = makeFixture({
      public_checks: ["npm run ci"],
      allowed_change_paths: ["core/scripts/gh.ts", generatedPath],
      grader_refs: [{ grader: "implementation-fix", version: "1" }],
      smoke_only: false,
    });
    const result = await runStaticFixturePreflight(fixture, {
      catFile: async () => "commit",
      readFileAtCommit: async () => null,
    });
    assert.equal(result.ok, true, formatPreflightFailures(result.failures));
  }
});

test("static preflight: current command-catalog edit requires the exact generated SKILL", async () => {
  const fixture = makeFixture({
    public_checks: ["npm run ci"],
    allowed_change_paths: ["core/scripts/command-registry.ts"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
  });
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async () => "commit",
    readFileAtCommit: async () => null,
  });
  assert.equal(result.ok, false);
  const allowance = result.failures.find((failure) => failure.check === "plugin_allowance");
  assert.ok(allowance);
  assert.match(allowance.detail, /plugin\/pipeline\/skills\/pipeline\/SKILL\.md/);
});

test("static preflight: committed historical fixture allows its exact pinned core mirror", async () => {
  const fixture = loadFixture(
    resolve(import.meta.dirname, "../evals/fixtures/fix-graded-null-guard.json"),
  );
  const result = await runStaticFixturePreflight(fixture, {
    catFile: async () => "commit",
    readFileAtCommit: async () =>
      "const CORE_ENTRIES = ['scripts'];\nconst coreDst = join(skillDir, 'core');\n",
  });
  assert.equal(result.ok, true, formatPreflightFailures(result.failures));
  assert.ok(
    fixture.allowed_change_paths?.includes(
      "plugin/pipeline/skills/pipeline/core/scripts/gh.ts",
    ),
  );
});

test("deep preflight: red public baseline blocks treatments (infra)", async () => {
  const fixture = makeFixture({
    public_checks: ["npm run ci"],
    grader_refs: [{ grader: "implementation-fix", version: "1" }],
    smoke_only: false,
    allowed_change_paths: [
      "core/scripts/gh.ts",
      "plugin/pipeline/skills/pipeline/SKILL.md",
    ],
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

// --- #637 review 2: seeded defects must prove they bite (ae1fad38) ---

test("deep preflight: seeded defect path exists but non-biting probe fails preflight naming defect_id", async () => {
  // Regression: path-existence alone previously let already-fixed seeds into
  // scored runs. Probe that exits 0 = defect no longer bites.
  const fixture = makeFixture({
    public_checks: [],
    stage_entry_artifacts: {
      review: {
        diff: "diff --git a/core/scripts/gh.ts b/core/scripts/gh.ts\n+return Number(result.number);\n",
      },
    },
    seeded_defects: [
      {
        defect_id: "already-fixed-sentinel",
        path: "core/scripts/gh.ts",
        line_start: 701,
        line_end: 702,
        expected_severity: "high",
        // Probe passes → non-biting (simulates defect already fixed in ground truth)
        biting_probe: "true",
      },
    ],
    grader_refs: [{ grader: "review", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      pathExists: async () => true,
      runCheck: async ({ check }) => check === "true",
    }),
  );
  assert.equal(result.ok, false);
  const bite = result.failures.find((f) => f.check === "biting_probe");
  assert.ok(bite, formatPreflightFailures(result.failures));
  assert.match(bite!.detail, /already-fixed-sentinel/);
  assert.match(bite!.detail, /already passes|non-biting/);
});

test("deep preflight: seeded defect with biting probe (fails at pin) passes", async () => {
  const fixture = makeFixture({
    public_checks: [],
    stage_entry_artifacts: {
      review: {
        diff: "diff --git a/core/scripts/gh.ts b/core/scripts/gh.ts\n+return Number(result.number ?? -1);\n",
      },
    },
    seeded_defects: [
      {
        defect_id: "sentinel-still-present",
        path: "core/scripts/gh.ts",
        line_start: 701,
        line_end: 702,
        expected_severity: "high",
        biting_probe: "false",
      },
    ],
    grader_refs: [{ grader: "review", version: "1" }],
    smoke_only: false,
  });
  let seenProbeEnv: NodeJS.ProcessEnv | undefined;
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      runCheck: async ({ check, env }) => {
        if (check === "false") {
          seenProbeEnv = env;
          return false; // still fails at pin = biting
        }
        return true;
      },
    }),
  );
  assert.equal(result.ok, true, formatPreflightFailures(result.failures));
  assert.ok(seenProbeEnv);
  assert.equal(seenProbeEnv!.EVAL_PREFLIGHT_REVIEW_DIFF, "/fake/review.diff");
});

test("deep preflight: unrelated hidden check does not substitute for seeded-defect probe", async () => {
  // A fixture can have a biting hidden check while its seeded defect probe is
  // already non-biting — preflight must still reject the seeded defect.
  const fixture = makeFixture({
    public_checks: [],
    hidden_checks: ["node --test core/test/unrelated-hidden.test.ts"],
    seeded_defects: [
      {
        defect_id: "seed-without-bite",
        path: "core/scripts/gh.ts",
        line_start: 1,
        line_end: 2,
        expected_severity: "high",
        biting_probe: "echo seed-fixed",
      },
    ],
    grader_refs: [{ grader: "review", version: "1" }],
    smoke_only: false,
  });
  const result = await runDeepFixturePreflight(
    cfg,
    fixture,
    cellSurfaceFakes({
      runCheck: async ({ check }) => {
        // Hidden still bites (fails); seeded probe already passes.
        if (check.includes("unrelated-hidden")) return false;
        if (check.includes("seed-fixed")) return true;
        return true;
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some(
      (f) => f.check === "biting_probe" && /seed-without-bite/.test(f.detail),
    ),
    formatPreflightFailures(result.failures),
  );
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
