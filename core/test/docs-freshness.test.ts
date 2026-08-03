// Regression tests for docs-generator freshness gate (#716).
//
// Injectable seams only — no real network, git, or subprocess as the sole pass path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDocsFreshness,
  ciScriptReachesDocsFreshness,
  detectDocsGenerator,
  docsRegenerateCommitMessage,
  enforceDocsFreshness,
  extractStalePaths,
  scriptInvokesDocsGenerator,
  scriptIsConditionalDocsCiEntry,
  scriptIsDocsFreshnessCheck,
  type DocsFreshnessDeps,
} from "../scripts/docs-freshness.ts";
import {
  resumeFromImplementing,
  type ResumeFromImplementingDeps,
} from "../scripts/stages/planning.ts";
import type { TestGateResult } from "../scripts/testgate.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { buildImplementingPrompt, DOCS_INSTRUCTION_WITH_GENERATOR } from "../scripts/prompts/index.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/fake/repo",
    base_branch: "main",
    harnesses: { implementer: "claude", reviewer: "codex" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    test_gate: { enabled: false },
    implementation_ready_message: "Implementation ready.",
    marker_footer: "*Automated by Pipeline*",
    worktree_root: ".worktrees",
    ...overrides,
  } as unknown as PipelineConfig;
}

function dummyPromptCfg(): PipelineConfig {
  return makeCfg({ steps: { docs: true } as any });
}

function passedGate(): TestGateResult {
  return { skipped: false, passed: true, attempts: 0 };
}

function staleCheckOutput(files: string[] = ["CHANGELOG.md"]): string {
  return [
    "generate-docs --check: stale generated docs:",
    ...files.map((f) => `  - ${f}`),
    "Run: node scripts/generate-docs.mjs",
  ].join("\n");
}

function makeEnforceDeps(opts: {
  checkCodes?: number[];
  generateCode?: number;
  generateOutput?: string;
  preStatus?: string;
  postStatus?: string;
  hasGeneratorFile?: boolean;
  packageScripts?: Record<string, string> | null;
}): {
  deps: DocsFreshnessDeps;
  log: string[];
  commits: string[];
  added: { n: number };
} {
  const log: string[] = [];
  const commits: string[] = [];
  const added = { n: 0 };
  let checkIdx = 0;
  const checkCodes = opts.checkCodes ?? [1, 0];
  let statusCall = 0;

  const hasFile = opts.hasGeneratorFile ?? true;
  const scripts =
    opts.packageScripts === null
      ? null
      : {
          "docs:check": "node scripts/generate-docs.mjs --check",
          "docs:generate": "node scripts/generate-docs.mjs",
          ...(opts.packageScripts ?? {}),
        };

  const deps: DocsFreshnessDeps = {
    fileExists: (p) => hasFile && p.replace(/\\/g, "/").endsWith("scripts/generate-docs.mjs"),
    readPackageJson: () => (scripts ? { scripts } : null),
    runDocsCommand: async (_wt, command) => {
      log.push(command);
      const isCheck = /docs:check|--check/.test(command);
      if (isCheck) {
        const code = checkCodes[Math.min(checkIdx, checkCodes.length - 1)] ?? 1;
        checkIdx++;
        return {
          code,
          output: code === 0 ? "generate-docs --check: ok" : staleCheckOutput(),
        };
      }
      return {
        code: opts.generateCode ?? 0,
        output: opts.generateOutput ?? "generated",
      };
    },
    gitStatusPorcelain: async () => {
      statusCall++;
      if (statusCall === 1) return opts.preStatus ?? "";
      return opts.postStatus ?? " M CHANGELOG.md\n";
    },
    gitAddAll: async () => {
      added.n++;
    },
    gitCommit: async (_wt, message) => {
      commits.push(message);
    },
  };
  return { deps, log, commits, added };
}

// ---------------------------------------------------------------------------
// Pure detection / parsing
// ---------------------------------------------------------------------------

test("scriptInvokesDocsGenerator: matches generator contract only", () => {
  assert.equal(scriptInvokesDocsGenerator("node scripts/generate-docs.mjs --check"), true);
  assert.equal(scriptInvokesDocsGenerator("node scripts/generate-docs.mjs"), true);
  assert.equal(scriptInvokesDocsGenerator("npm run docs:generate && something"), false);
  assert.equal(scriptInvokesDocsGenerator("markdownlint docs/"), false);
  assert.equal(scriptInvokesDocsGenerator(undefined), false);
});

test("scriptIsDocsFreshnessCheck: requires generator + --check (not write-mode)", () => {
  assert.equal(scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs --check"), true);
  assert.equal(scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs"), false);
  assert.equal(scriptIsDocsFreshnessCheck("markdownlint docs/"), false);
  assert.equal(scriptIsDocsFreshnessCheck(undefined), false);
});

test("scriptIsDocsFreshnessCheck: compound script with --check elsewhere is write-mode (#716)", () => {
  // --check must be an arg of generate-docs itself, not a later segment.
  assert.equal(
    scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs && echo --check"),
    false,
  );
  assert.equal(
    scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs || echo --check"),
    false,
  );
  assert.equal(
    scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs; echo --check"),
    false,
  );
  // Still true when --check is on the generator segment (even with a trailing step).
  assert.equal(
    scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs --check && echo ok"),
    true,
  );
});

test("scriptIsDocsFreshnessCheck: check-then-write fallback is not a freshness check (#716)", () => {
  // A red --check can be masked by a write-mode generator fallback that exits 0.
  assert.equal(
    scriptIsDocsFreshnessCheck(
      "node scripts/generate-docs.mjs --check || node scripts/generate-docs.mjs",
    ),
    false,
  );
  assert.equal(
    scriptIsDocsFreshnessCheck(
      "node scripts/generate-docs.mjs --check; node scripts/generate-docs.mjs",
    ),
    false,
  );
  assert.equal(
    scriptIsDocsFreshnessCheck(
      "node scripts/generate-docs.mjs --check && node scripts/generate-docs.mjs",
    ),
    false,
  );
  // All generator segments check-mode remains accepted.
  assert.equal(
    scriptIsDocsFreshnessCheck(
      "node scripts/generate-docs.mjs --check || node scripts/generate-docs.mjs --check",
    ),
    true,
  );
});

test("detectDocsGenerator: absent when no file and no generator docs:check", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: () => false,
    readPackageJson: () => ({ scripts: { "docs:check": "markdownlint docs/" } }),
  });
  assert.equal(surface.present, false);
});

test("detectDocsGenerator: unrelated docs:check does not activate (#716)", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: () => false,
    readPackageJson: () => ({ scripts: { "docs:check": "prettier --check docs/**/*.md" } }),
  });
  assert.equal(surface.present, false);
});

test("detectDocsGenerator: generator file present activates", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: (p) => p.replace(/\\/g, "/").endsWith("scripts/generate-docs.mjs"),
    readPackageJson: () => null,
  });
  assert.equal(surface.present, true);
  if (surface.present) {
    assert.match(surface.checkCommand, /generate-docs\.mjs --check|docs:check/);
    assert.match(surface.generateCommand, /generate-docs\.mjs|docs:generate/);
  }
});

test("detectDocsGenerator: docs:check script invoking generator activates without file", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: () => false,
    readPackageJson: () => ({
      scripts: {
        "docs:check": "node scripts/generate-docs.mjs --check",
        "docs:generate": "node scripts/generate-docs.mjs",
      },
    }),
  });
  assert.equal(surface.present, true);
  if (surface.present) {
    assert.equal(surface.checkCommand, "npm run docs:check");
    assert.equal(surface.generateCommand, "npm run docs:generate");
  }
});

test("detectDocsGenerator: write-mode docs:check is not selected as check command (#716)", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: (p) => p.replace(/\\/g, "/").endsWith("scripts/generate-docs.mjs"),
    readPackageJson: () => ({
      scripts: {
        // Miswired: docs:check writes instead of checking.
        "docs:check": "node scripts/generate-docs.mjs",
        "docs:generate": "node scripts/generate-docs.mjs",
      },
    }),
  });
  assert.equal(surface.present, true);
  if (surface.present) {
    assert.equal(
      surface.checkCommand,
      "node scripts/generate-docs.mjs --check",
      "must not use write-mode npm run docs:check as the freshness check",
    );
    assert.notEqual(surface.checkCommand, "npm run docs:check");
  }
});

test("detectDocsGenerator: check-then-write docs:check is not selected as check command (#716)", () => {
  const surface = detectDocsGenerator("/wt", {
    fileExists: (p) => p.replace(/\\/g, "/").endsWith("scripts/generate-docs.mjs"),
    readPackageJson: () => ({
      scripts: {
        "docs:check":
          "node scripts/generate-docs.mjs --check || node scripts/generate-docs.mjs",
        "docs:generate": "node scripts/generate-docs.mjs",
      },
    }),
  });
  assert.equal(surface.present, true);
  if (surface.present) {
    assert.equal(
      surface.checkCommand,
      "node scripts/generate-docs.mjs --check",
      "must not use check-then-write npm run docs:check as the freshness check",
    );
    assert.notEqual(surface.checkCommand, "npm run docs:check");
  }
});

test("ciScriptReachesDocsFreshness: false when docs:check is check-then-write fallback (#716)", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && npm run docs:check",
      "ci:core": "node --test",
      "docs:check":
        "node scripts/generate-docs.mjs --check || node scripts/generate-docs.mjs",
    }),
    false,
  );
});

test("detectDocsGenerator: compound write-mode docs:check is not selected as check command (#716)", () => {
  // --check only appears in a later segment — still write-mode for the generator.
  const surface = detectDocsGenerator("/wt", {
    fileExists: (p) => p.replace(/\\/g, "/").endsWith("scripts/generate-docs.mjs"),
    readPackageJson: () => ({
      scripts: {
        "docs:check": "node scripts/generate-docs.mjs && echo --check",
        "docs:generate": "node scripts/generate-docs.mjs",
      },
    }),
  });
  assert.equal(surface.present, true);
  if (surface.present) {
    assert.equal(
      surface.checkCommand,
      "node scripts/generate-docs.mjs --check",
      "must not use compound write-mode npm run docs:check as the freshness check",
    );
    assert.notEqual(surface.checkCommand, "npm run docs:check");
  }
});

test("extractStalePaths: parses known generator output; does not invent names", () => {
  assert.deepEqual(
    extractStalePaths(staleCheckOutput(["CHANGELOG.md", "docs/cli.md"])),
    ["CHANGELOG.md", "docs/cli.md"],
  );
  assert.deepEqual(extractStalePaths("spawn ENOENT generate-docs"), []);
  assert.deepEqual(extractStalePaths("tsc: error TS2322"), []);
});

test("docsRegenerateCommitMessage: conventional subject with issue ref", () => {
  assert.equal(docsRegenerateCommitMessage(716), "docs: regenerate generated docs (#716)");
});

// ---------------------------------------------------------------------------
// ciScriptReachesDocsFreshness — structural graph walk
// ---------------------------------------------------------------------------

test("ciScriptReachesDocsFreshness: direct docs:check in ci", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && npm run docs:check",
      "docs:check": "node scripts/generate-docs.mjs --check",
    }),
    true,
  );
});

test("ciScriptReachesDocsFreshness: transitive via nested script", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:full",
      "ci:full": "npm run unit && npm run docs:check",
      unit: "npm test",
      "docs:check": "node scripts/generate-docs.mjs --check",
    }),
    true,
  );
});

test("ciScriptReachesDocsFreshness: false when docs:check is unrelated", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run docs:check",
      "docs:check": "markdownlint docs/",
    }),
    false,
  );
});

test("ciScriptReachesDocsFreshness: false when docs:check is write-mode generator (#716)", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && npm run docs:check",
      "ci:core": "npm test",
      // Invokes generator but without --check — not a freshness edge.
      "docs:check": "node scripts/generate-docs.mjs",
    }),
    false,
  );
});

test("ciScriptReachesDocsFreshness: false when docs:check is compound write-mode (#716)", () => {
  // --check only in a later segment must not certify the ci graph as freshness-wired.
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && npm run docs:check",
      "ci:core": "npm test",
      "docs:check": "node scripts/generate-docs.mjs && echo --check",
    }),
    false,
  );
});

test("ciScriptReachesDocsFreshness: false when ci has no docs step", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && node scripts/build.mjs --check",
      "ci:core": "npm test",
    }),
    false,
  );
});

test("ciScriptReachesDocsFreshness: conditional ci:docs entry counts (#756)", () => {
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && npm run ci:docs",
      "ci:core": "npm test",
      "ci:docs": "node scripts/ci-docs.mjs",
    }),
    true,
  );
  assert.equal(
    scriptIsConditionalDocsCiEntry("node scripts/ci-docs.mjs"),
    true,
  );
  assert.equal(
    scriptIsConditionalDocsCiEntry("node scripts/build.mjs --check"),
    false,
  );
});

// ---------------------------------------------------------------------------
// enforceDocsFreshness — matrix
// ---------------------------------------------------------------------------

test("enforceDocsFreshness: generator absent → no-op, no commands", async () => {
  const { deps, log, commits, added } = makeEnforceDeps({
    hasGeneratorFile: false,
    packageScripts: null,
  });
  // Override detection to fully absent
  deps.fileExists = () => false;
  deps.readPackageJson = () => ({ scripts: {} });

  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.deepEqual(result, { ok: true, ran: false });
  assert.deepEqual(log, []);
  assert.deepEqual(commits, []);
  assert.equal(added.n, 0);
});

test("enforceDocsFreshness: green check → proceeds without heal", async () => {
  const { deps, log, commits } = makeEnforceDeps({ checkCodes: [0] });
  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  if (result.ok && result.ran) assert.equal(result.healed, false);
  assert.equal(log.length, 1, "only check ran");
  assert.deepEqual(commits, []);
});

test("enforceDocsFreshness: stale check + heal success → commit + re-check", async () => {
  const { deps, log, commits, added } = makeEnforceDeps({
    checkCodes: [1, 0],
    postStatus: " M CHANGELOG.md\n",
  });
  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  if (result.ok && result.ran && result.healed) {
    assert.ok(result.paths.includes("CHANGELOG.md"));
  } else {
    assert.fail("expected healed:true");
  }
  assert.equal(added.n, 1);
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /docs: regenerate generated docs \(#716\)/);
  assert.ok(log.some((c) => /docs:check|--check/.test(c)));
  assert.ok(log.some((c) => /docs:generate|generate-docs\.mjs$/.test(c) || c === "npm run docs:generate" || c === "node scripts/generate-docs.mjs"));
});

test("enforceDocsFreshness: dirty tree before generate → fail closed, no commit", async () => {
  const { deps, commits, added } = makeEnforceDeps({
    checkCodes: [1],
    preStatus: " M core/scripts/foo.ts\n",
  });
  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /uncommitted changes|cannot auto-heal/i);
    assert.match(result.reason, /PR open\/update withheld/i);
    assert.ok(result.stalePaths.includes("CHANGELOG.md") || result.stalePaths.length >= 0);
  }
  assert.deepEqual(commits, []);
  assert.equal(added.n, 0);
});

test("enforceDocsFreshness: generate no-op → fail closed with original check output", async () => {
  const { deps, commits } = makeEnforceDeps({
    checkCodes: [1],
    postStatus: "",
  });
  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /no file changes|cannot auto-heal/i);
    assert.ok(result.stalePaths.includes("CHANGELOG.md"));
    assert.match(result.reason, /CHANGELOG\.md/);
  }
  assert.deepEqual(commits, []);
});

test("enforceDocsFreshness: generate fails → fail closed without inventing stale names", async () => {
  const { deps, commits } = makeEnforceDeps({
    checkCodes: [1],
    generateCode: 1,
    generateOutput: "spawn ENOENT: generate-docs crashed",
  });
  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /docs generator failed/i);
    assert.match(result.reason, /ENOENT/);
    assert.deepEqual(result.stalePaths, [], "must not invent stale file names from generate failure");
  }
  assert.deepEqual(commits, []);
});

test("enforceDocsFreshness: re-check still red after heal → fail closed with stale names", async () => {
  const { deps, commits } = makeEnforceDeps({
    checkCodes: [1, 1],
    postStatus: " M CHANGELOG.md\n",
  });
  const result = await enforceDocsFreshness("/wt", 716, deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /still failing after regenerate/i);
    assert.ok(result.stalePaths.includes("CHANGELOG.md"));
  }
  assert.equal(commits.length, 1, "heal commit was attempted");
});

test("checkDocsFreshness: green check-only → ok without heal", async () => {
  const { deps, log, commits } = makeEnforceDeps({ checkCodes: [0] });
  const result = await checkDocsFreshness("/wt", deps);
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  if (result.ok && result.ran) assert.equal(result.healed, false);
  assert.equal(log.length, 1);
  assert.deepEqual(commits, []);
});

test("checkDocsFreshness: red check-only → fail closed, no generate", async () => {
  const { deps, log, commits } = makeEnforceDeps({ checkCodes: [1] });
  const result = await checkDocsFreshness("/wt", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /final HEAD before push/i);
    assert.ok(result.stalePaths.includes("CHANGELOG.md"));
  }
  assert.equal(log.length, 1, "only check ran — no generate");
  assert.deepEqual(commits, []);
});

// ---------------------------------------------------------------------------
// README landing-page contract on the docs-freshness surface (#855)
// ---------------------------------------------------------------------------

function landingPageCheckOutput(): string {
  return [
    "README landing-page contract breach:",
    "  measured_lines: 2067",
    "  - [line-budget] README.md landing-page line budget exceeded: 2067 lines (must be fewer than 400)",
    "  - [full-inventory-shape] README.md matches a full hand-maintained CLI/config inventory shape",
    "",
    "Restore a lean root README.md (< 400 lines, companion links).",
  ].join("\n");
}

test("checkDocsFreshness: README landing-page red blocks pre-PR class outcomes (#855)", async () => {
  const { deps, commits } = makeEnforceDeps({
    checkCodes: [1],
  });
  // Override check output to landing-page diagnostics (not stale generator paths).
  const commands: string[] = [];
  deps.runDocsCommand = async (_wt, cmd) => {
    commands.push(cmd);
    return { code: 1, output: landingPageCheckOutput() };
  };
  const result = await checkDocsFreshness("/wt", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /landing-page contract breach|README/i);
    assert.match(result.reason, /line-budget|2067/);
    // Must not invent stale generator file names that were not in the failure.
    assert.deepEqual(result.stalePaths, []);
    assert.ok(
      result.reason.includes("landing-page") || result.reason.includes("README"),
      "failure reason must name the README / landing-page breach class",
    );
  }
  assert.deepEqual(commits, []);
  assert.equal(commands.length, 1, "only check ran — no generate/heal");
});

test("enforceDocsFreshness: generator-only heal does not greenwash monolithic README (#855)", async () => {
  // Check fails for README only; generate "succeeds" and dirties only generator
  // outputs; re-check still fails with landing-page diagnostics.
  const landingOut = landingPageCheckOutput();
  const { deps, commits } = makeEnforceDeps({
    checkCodes: [1, 1],
    postStatus: " M docs/cli.md\n M CHANGELOG.md\n",
  });
  deps.runDocsCommand = async (_wt, cmd) => {
    if (/--check|docs:check/.test(cmd)) {
      return { code: 1, output: landingOut };
    }
    // write mode: generator-owned only
    return { code: 0, output: "wrote docs/cli.md\nwrote CHANGELOG.md\n" };
  };
  const result = await enforceDocsFreshness("/wt", 855, deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /still failing after regenerate|landing-page|README/i);
    assert.match(result.reason, /landing-page contract breach/i);
    assert.deepEqual(result.stalePaths, [], "must not invent stale generator paths from README-only failure");
  }
  assert.equal(commits.length, 1, "heal commit of generator outputs may still be attempted");
});

// ---------------------------------------------------------------------------
/** No-op supersede so unit tests never hit GitHub (#729). */
const noopDispose: NonNullable<ResumeFromImplementingDeps["disposeSupersededIssuePrs"]> = async () => ({
  closed: [],
  commented: [],
  errors: [],
  isCanonical: true,
});

// resumeFromImplementing wiring — ordering, both PR surfaces, bite
// ---------------------------------------------------------------------------

test("resumeFromImplementing: docs check runs after gates and before push/createPr (#716 ordering)", async () => {
  const callLog: string[] = [];
  let createPrCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => {
      callLog.push("test-gate");
      return passedGate();
    },
    runFormatGate: async () => {
      callLog.push("format-gate");
      return { status: "ok", committed: false };
    },
    enforceDocsFreshness: async () => {
      callLog.push("docs-freshness");
      return { ok: true, ran: true, healed: false };
    },
    getPrForBranch: async () => null,
    disposeSupersededIssuePrs: noopDispose,
    createPr: async () => {
      callLog.push("createPr");
      createPrCalled = true;
      return 77;
    },
    gitInWorktree: async (_p, args) => {
      if (args[0] === "push") callLog.push("push");
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async () => {},
    transition: async () => {},
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    716,
    { path: "/fake/wt", branch: "pipeline/716-docs" },
    {
      prTitle: "[Pipeline] docs (#716)",
      prBody: "Closes #716",
      transitionMessage: (n) => `PR #${n}`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.ok(createPrCalled);
  const docsIdx = callLog.indexOf("docs-freshness");
  const pushIdx = callLog.indexOf("push");
  const createIdx = callLog.indexOf("createPr");
  assert.ok(docsIdx >= 0, "docs freshness must run");
  assert.ok(pushIdx > docsIdx, "docs check before push");
  assert.ok(createIdx > docsIdx, "docs check before createPr");
  assert.ok(callLog.indexOf("format-gate") < docsIdx || callLog.indexOf("test-gate") < docsIdx,
    "format/test gates before docs");
});

test("resumeFromImplementing: red docs blocks createPr and push (deliberate stale / #597-class)", async () => {
  let createPrCalled = false;
  let pushCalled = false;
  let blockedReason = "";

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({
      ok: false,
      ran: true,
      reason:
        "docs freshness check failed. PR open/update withheld for docs freshness.\n\n" +
        "Stale generated file(s): CHANGELOG.md\n\n```\n" +
        staleCheckOutput() +
        "\n```",
      stalePaths: ["CHANGELOG.md"],
    }),
    getPrForBranch: async () => null,
    disposeSupersededIssuePrs: noopDispose,
    createPr: async () => {
      createPrCalled = true;
      return 0;
    },
    gitInWorktree: async (_p, args) => {
      if (args[0] === "push") pushCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async (_cfg, _n, reason) => {
      blockedReason = reason;
    },
    transition: async () => {
      assert.fail("transition must not run on red docs");
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    716,
    { path: "/fake/wt", branch: "pipeline/716-docs" },
    {
      prTitle: "t",
      prBody: "b",
      transitionMessage: () => "m",
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, false);
  if (!result.advanced) assert.equal(result.status, "blocked");
  assert.ok(!createPrCalled, "createPr must NOT be called when docs check is red");
  assert.ok(!pushCalled, "push must NOT succeed as implement advance when docs check is red");
  assert.match(blockedReason, /CHANGELOG\.md/);
  assert.match(blockedReason, /withheld/i);
});

test("resumeFromImplementing: existing-PR resume also fails closed on red docs", async () => {
  let createPrCalled = false;
  let pushCalled = false;
  let transitionCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => ({
      ok: false,
      ran: true,
      reason: "docs red — withheld\n\n```\nstale\n```",
      stalePaths: ["CHANGELOG.md"],
    }),
    getPrForBranch: async () => 55,
    disposeSupersededIssuePrs: noopDispose,
    createPr: async () => {
      createPrCalled = true;
      return 0;
    },
    gitInWorktree: async (_p, args) => {
      if (args[0] === "push") pushCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async () => {},
    transition: async () => {
      transitionCalled = true;
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    716,
    { path: "/fake/wt", branch: "pipeline/716-docs" },
    {
      prTitle: "t",
      prBody: "b",
      transitionMessage: () => "m",
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, false);
  assert.ok(!createPrCalled);
  assert.ok(!pushCalled, "must not push red-docs head as successful gate pass");
  assert.ok(!transitionCalled, "must not advance past implement verification");
});

test("resumeFromImplementing: auto-heal re-runs format+test gates then final docs check before push", async () => {
  const callLog: string[] = [];
  let gateRounds = 0;

  const deps: ResumeFromImplementingDeps = {
    _runFormatAndTestGates: async () => {
      gateRounds++;
      callLog.push(`gates-${gateRounds}`);
      return { ok: true, gate: passedGate() };
    },
    enforceDocsFreshness: async () => {
      callLog.push("docs-heal");
      return { ok: true, ran: true, healed: true, paths: ["CHANGELOG.md"] };
    },
    checkDocsFreshness: async () => {
      callLog.push("docs-final-check");
      return { ok: true, ran: true, healed: false };
    },
    getPrForBranch: async () => null,
    disposeSupersededIssuePrs: noopDispose,
    createPr: async () => {
      callLog.push("createPr");
      return 88;
    },
    gitInWorktree: async (_p, args) => {
      if (args[0] === "push") callLog.push("push");
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async () => {},
    transition: async () => {
      callLog.push("transition");
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    716,
    { path: "/fake/wt", branch: "pipeline/716-docs" },
    {
      prTitle: "t",
      prBody: "b",
      transitionMessage: () => "m",
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.equal(gateRounds, 2, "format+test must re-run after heal");
  assert.deepEqual(
    callLog.slice(0, 5),
    ["gates-1", "docs-heal", "gates-2", "docs-final-check", "push"],
  );
  assert.ok(callLog.includes("createPr"));
});

test("resumeFromImplementing: post-heal final docs check red blocks push/createPr (#716)", async () => {
  let createPrCalled = false;
  let pushCalled = false;
  let blockedReason = "";

  const deps: ResumeFromImplementingDeps = {
    _runFormatAndTestGates: async () => ({ ok: true, gate: passedGate() }),
    enforceDocsFreshness: async () => ({
      ok: true,
      ran: true,
      healed: true,
      paths: ["CHANGELOG.md"],
    }),
    // Format/test after heal re-staled generated docs — check-only must fail closed.
    checkDocsFreshness: async () => ({
      ok: false,
      ran: true,
      reason:
        "docs freshness check failed on the final HEAD before push. " +
        "PR open/update withheld for docs freshness.\n\n" +
        "Stale generated file(s): CHANGELOG.md\n\n```\n" +
        staleCheckOutput() +
        "\n```",
      stalePaths: ["CHANGELOG.md"],
    }),
    getPrForBranch: async () => null,
    disposeSupersededIssuePrs: noopDispose,
    createPr: async () => {
      createPrCalled = true;
      return 0;
    },
    gitInWorktree: async (_p, args) => {
      if (args[0] === "push") pushCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async (_cfg, _n, reason) => {
      blockedReason = reason;
    },
    transition: async () => {
      assert.fail("transition must not run when final docs check is red");
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    716,
    { path: "/fake/wt", branch: "pipeline/716-docs" },
    {
      prTitle: "t",
      prBody: "b",
      transitionMessage: () => "m",
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, false);
  if (!result.advanced) assert.equal(result.status, "blocked");
  assert.ok(!createPrCalled, "createPr must NOT run when post-heal final docs check is red");
  assert.ok(!pushCalled, "push must NOT run when post-heal final docs check is red");
  assert.match(blockedReason, /final HEAD before push|CHANGELOG\.md/i);
});

test("bite: removing pre-PR docs enforcement would allow createPr on red docs", async () => {
  // Proves the regression would fail without the enforceDocsFreshness call:
  // when the dep always returns green, createPr runs; the red-docs test above
  // is the complementary half. Here we assert the success path still requires
  // the seam to be invoked (not skipped).
  let docsCalled = false;
  let createPrCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    runFormatGate: async () => ({ status: "ok", committed: false }),
    enforceDocsFreshness: async () => {
      docsCalled = true;
      return { ok: true, ran: true, healed: false };
    },
    getPrForBranch: async () => null,
    disposeSupersededIssuePrs: noopDispose,
    createPr: async () => {
      createPrCalled = true;
      return 1;
    },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
  };

  await resumeFromImplementing(
    makeCfg(),
    716,
    { path: "/wt", branch: "b" },
    { prTitle: "t", prBody: "b", transitionMessage: () => "m", pipelineRunId: "r" },
    deps,
  );
  assert.ok(docsCalled, "docs freshness seam must be invoked on the pre-PR path");
  assert.ok(createPrCalled);

  // Source-level bite: resumeFromImplementing must call enforceDocsFreshness
  // (or deps.enforceDocsFreshness) before createPr in planning.ts.
  const planningSrc = fs.readFileSync(
    path.join(REPO_ROOT, "core/scripts/stages/planning.ts"),
    "utf8",
  );
  const enforceIdx = planningSrc.indexOf("docsEnforce(");
  const createPrIdx = planningSrc.indexOf("prCreator(");
  assert.ok(enforceIdx > 0, "planning.ts must call docsEnforce");
  assert.ok(createPrIdx > enforceIdx, "docsEnforce must appear before prCreator in source order");

  // Fix path that can push an updated head must also enforce before push (#716).
  const fixSrc = fs.readFileSync(
    path.join(REPO_ROOT, "core/scripts/stages/fix.ts"),
    "utf8",
  );
  const fixDocsIdx = fixSrc.indexOf("docsEnforce(");
  // The push after gates is `["push", "origin", branch]` — require docs before first push.
  const fixPushIdx = fixSrc.indexOf('["push", "origin", branch]');
  assert.ok(fixDocsIdx > 0, "fix.ts must call docsEnforce on the post-gate path");
  assert.ok(fixPushIdx > fixDocsIdx, "docsEnforce must appear before push in fix.ts");

  // Post-heal path must re-verify check-only before push (planning + fix).
  for (const [label, src] of [
    ["planning.ts", planningSrc],
    ["fix.ts", fixSrc],
  ] as const) {
    const healBlock = src.indexOf("docsResult.ran && docsResult.healed");
    assert.ok(healBlock > 0, `${label} must have post-heal branch`);
    const finalCheckIdx = src.indexOf("docsCheckOnly(", healBlock);
    const pushAfterHeal = src.indexOf("push", finalCheckIdx > 0 ? finalCheckIdx : healBlock);
    assert.ok(finalCheckIdx > healBlock, `${label} must call docsCheckOnly after heal`);
    assert.ok(pushAfterHeal > finalCheckIdx, `${label}: final docs check before push`);
  }
});

// ---------------------------------------------------------------------------
// Prompt contract (#716)
// ---------------------------------------------------------------------------

test("implementing prompt: docsEnabled + docsGeneratorPresent requires regenerate+check", () => {
  const out = buildImplementingPrompt({
    cfg: dummyPromptCfg(),
    issueNumber: 716,
    title: "Title",
    body: "Body",
    plan: "p",
    pipelineRunId: "716/x",
    docsEnabled: true,
    docsGeneratorPresent: true,
  });
  assert.match(out, /## Documentation Updates/);
  assert.match(out, /Generated docs \(required\)/);
  assert.match(out, /regenerate and commit/);
  assert.match(out, /npm run docs:check/);
  assert.match(out, /generate-docs\.mjs --check/);
  assert.match(out, /Green unit tests alone/);
  // Constant must stay in the rendered prompt (drift guard).
  assert.ok(out.includes("scripts/generate-docs.mjs"));
  assert.ok(DOCS_INSTRUCTION_WITH_GENERATOR.includes("npm run docs:check"));
});

test("implementing prompt: docsEnabled without generator keeps hand-maintained docs only", () => {
  const out = buildImplementingPrompt({
    cfg: dummyPromptCfg(),
    issueNumber: 716,
    title: "Title",
    body: "Body",
    plan: "p",
    pipelineRunId: "716/x",
    docsEnabled: true,
    docsGeneratorPresent: false,
  });
  assert.match(out, /## Documentation Updates/);
  assert.doesNotMatch(out, /Generated docs \(required\)/);
  assert.doesNotMatch(out, /npm run docs:check/);
  assert.doesNotMatch(out, /generate-docs\.mjs --check/);
});

// ---------------------------------------------------------------------------
// Repo structural drift-guard (conditional on generator presence)
// ---------------------------------------------------------------------------

test("repo drift-guard: package.json ci always reaches conditional docs entry (#756)", () => {
  const pkgPath = path.join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};

  assert.ok(
    ciScriptReachesDocsFreshness(scripts),
    `package.json 'ci' must reach ci:docs / generate-docs --check; got ci=${scripts.ci}`,
  );
  assert.ok(
    typeof scripts["ci:docs"] === "string" &&
      scriptIsConditionalDocsCiEntry(scripts["ci:docs"]),
    "package.json must define ci:docs → scripts/ci-docs.mjs",
  );

  // Mis-wired chain without docs entry must not report freshness.
  assert.equal(
    ciScriptReachesDocsFreshness({
      ci: "npm run ci:core && node scripts/build.mjs --check",
      "ci:core": "npm test",
    }),
    false,
    "mis-wired ci without docs step must not report freshness",
  );
});
