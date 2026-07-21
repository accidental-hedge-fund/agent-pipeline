// Config loader tests. We mock by writing a fake `.github/pipeline.yml` into
// a temp git-like directory and stubbing PATH so `gh repo view` returns a
// canned value.
//
// Because resolveConfig() shells out to `gh`, we run a small subset of tests
// that don't require gh (parsing config text directly via a parseConfig hook
// would require refactoring config.ts; instead we just validate the merged
// shape after a successful load via a fake gh).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import { findGitRoot, syncConfig, repoMapAdd, repoMapRemove, repoMapList, validateOwnerRepo } from "../scripts/config.ts";
import { resolveReviewerModelForHarness } from "../scripts/stage-routing.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-cfg-test-"));

function makeFakeRepo(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (content !== null) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "pipeline.yml"), content);
  }
  return dir;
}

function makeFakeGh(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  // Tiny shell stub that prints repo slug on `gh repo view` and exits 0.
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\necho "${repoSlug}"\n`);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

test("resolveConfig: defaults apply when no .github/pipeline.yml exists", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const { resolveConfig } = await import("../scripts/config.ts");
    const cfg = resolveConfig({ repoPath: repo });
    assert.equal(cfg.repo, "acme/widget");
    // resolveConfig uses path.resolve which doesn't resolve symlinks, but
    // mkdtemp on macOS may return /var/... while realpath gives /private/var.
    // Compare via realpath to normalize.
    assert.equal(fs.realpathSync(cfg.repo_dir), fs.realpathSync(repo));
    assert.equal(cfg.base_branch, DEFAULT_CONFIG.base_branch);
    assert.equal(cfg.worktree_root, DEFAULT_CONFIG.worktree_root);
    assert.equal(cfg.max_concurrent_worktrees, DEFAULT_CONFIG.max_concurrent_worktrees);
    assert.deepEqual(cfg.harnesses, { implementer: "codex", reviewer: "claude", reviewerModel: undefined, reviewerModelWasAuto: false, reviewerEffort: undefined, reviewerPromptDelivery: "argv" });
    assert.deepEqual(cfg.steps, { plan_review: true, standard_review: true, adversarial_review: true, docs: true });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: merges file overrides over defaults; harness roles come from the profile", async () => {
  const repo = makeFakeRepo(`base_branch: staging
max_concurrent_worktrees: 7
models:
  planning: sonnet
  review: opus
  fix: sonnet
`);
  const binDir = makeFakeGh("acme/widget2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    // Re-import so we don't get a cached version (Node caches by URL/path).
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.base_branch, "staging");
    assert.equal(cfg.max_concurrent_worktrees, 7);
    assert.equal(cfg.harnesses.implementer, "codex");
    assert.equal(cfg.harnesses.reviewer, "claude");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- dead-surface keys removed in #93: strict schema rejects them outright ----

test("resolveConfig: a harnesses block is rejected with an error naming the key", async () => {
  const repo = makeFakeRepo(`harnesses:\n  implementer: claude\n  reviewer: codex\n`);
  const binDir = makeFakeGh("acme/dead1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("harnesses"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: auto_merge is rejected with an error naming the key", async () => {
  const repo = makeFakeRepo(`auto_merge: true\n`);
  const binDir = makeFakeGh("acme/dead2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("auto_merge"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: invalid yaml → throws with parse details", async () => {
  // Type error: max_concurrent_worktrees as string
  const repo = makeFakeRepo(`max_concurrent_worktrees: not-a-number\n`);
  const binDir = makeFakeGh("acme/widget3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /Invalid .*pipeline\.yml/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: --base override wins over file value", async () => {
  const repo = makeFakeRepo(`base_branch: staging\n`);
  const binDir = makeFakeGh("acme/widget4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, baseBranch: "develop" });
    assert.equal(cfg.base_branch, "develop");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: a configurable step can be disabled, others stay default-on", async () => {
  const repo = makeFakeRepo(`steps:\n  adversarial_review: false\n  docs: false\n`);
  const binDir = makeFakeGh("acme/steps1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.steps.adversarial_review, false);
    assert.equal(cfg.steps.docs, false);
    assert.equal(cfg.steps.standard_review, true); // unspecified → default on
    assert.equal(cfg.steps.plan_review, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: disabling a protected step is rejected (strict schema)", async () => {
  // CI / mergeability / planning / implementing are not configurable; an unknown
  // step key is rejected at parse time rather than silently dropping a safety gate.
  const repo = makeFakeRepo(`steps:\n  mergeability: false\n`);
  const binDir = makeFakeGh("acme/steps2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: test_gate defaults apply when unspecified", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/tg0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.test_gate.enabled, DEFAULT_CONFIG.test_gate.enabled);
    assert.equal(cfg.test_gate.max_attempts, DEFAULT_CONFIG.test_gate.max_attempts);
    assert.equal(cfg.test_gate.timeout, DEFAULT_CONFIG.test_gate.timeout);
    assert.equal(cfg.test_gate.command, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: test_gate can be disabled; other fields keep defaults", async () => {
  const repo = makeFakeRepo(`test_gate:\n  enabled: false\n`);
  const binDir = makeFakeGh("acme/tg1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.test_gate.enabled, false);
    assert.equal(cfg.test_gate.max_attempts, DEFAULT_CONFIG.test_gate.max_attempts);
    assert.equal(cfg.test_gate.timeout, DEFAULT_CONFIG.test_gate.timeout);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: explicit test_gate command + max_attempts preserved", async () => {
  const repo = makeFakeRepo(`test_gate:\n  command: make test\n  max_attempts: 5\n`);
  const binDir = makeFakeGh("acme/tg2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.test_gate.command, "make test");
    assert.equal(cfg.test_gate.max_attempts, 5);
    assert.equal(cfg.test_gate.enabled, true); // default
    assert.equal(cfg.test_gate.timeout, 300); // default
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: invalid test_gate.max_attempts is rejected", async () => {
  const repo = makeFakeRepo(`test_gate:\n  max_attempts: -1\n`);
  const binDir = makeFakeGh("acme/tg3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: eval_gate defaults apply when block is absent", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/eg0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.eval_gate.enabled, DEFAULT_CONFIG.eval_gate.enabled);
    assert.equal(cfg.eval_gate.enabled, false);
    assert.equal(cfg.eval_gate.mode, DEFAULT_CONFIG.eval_gate.mode);
    assert.equal(cfg.eval_gate.mode, "gate");
    assert.equal(cfg.eval_gate.timeout, DEFAULT_CONFIG.eval_gate.timeout);
    assert.equal(cfg.eval_gate.max_attempts, DEFAULT_CONFIG.eval_gate.max_attempts);
    assert.equal(cfg.eval_gate.command, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: eval_gate enabled with command and advisory mode", async () => {
  const repo = makeFakeRepo(
    `eval_gate:\n  enabled: true\n  command: "pnpm evals"\n  mode: advisory\n  timeout: 120\n  max_attempts: 3\n`,
  );
  const binDir = makeFakeGh("acme/eg1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.eval_gate.enabled, true);
    assert.equal(cfg.eval_gate.command, "pnpm evals");
    assert.equal(cfg.eval_gate.mode, "advisory");
    assert.equal(cfg.eval_gate.timeout, 120);
    assert.equal(cfg.eval_gate.max_attempts, 3);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: eval_gate enabled:false keeps other defaults", async () => {
  const repo = makeFakeRepo(`eval_gate:\n  enabled: false\n`);
  const binDir = makeFakeGh("acme/eg2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.eval_gate.enabled, false);
    assert.equal(cfg.eval_gate.mode, DEFAULT_CONFIG.eval_gate.mode);
    assert.equal(cfg.eval_gate.timeout, DEFAULT_CONFIG.eval_gate.timeout);
    assert.equal(cfg.eval_gate.max_attempts, DEFAULT_CONFIG.eval_gate.max_attempts);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- visual_gate (#395) ----

test("resolveConfig: visual_gate defaults apply when block is absent", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/vg0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.visual_gate.enabled, DEFAULT_CONFIG.visual_gate.enabled);
    assert.equal(cfg.visual_gate.enabled, false);
    assert.equal(cfg.visual_gate.mode, DEFAULT_CONFIG.visual_gate.mode);
    assert.equal(cfg.visual_gate.mode, "gate");
    assert.equal(cfg.visual_gate.timeout, DEFAULT_CONFIG.visual_gate.timeout);
    assert.equal(cfg.visual_gate.max_attempts, DEFAULT_CONFIG.visual_gate.max_attempts);
    assert.equal(cfg.visual_gate.artifacts_dir, DEFAULT_CONFIG.visual_gate.artifacts_dir);
    assert.equal(cfg.visual_gate.artifacts_dir, ".pipeline-visual");
    assert.equal(cfg.visual_gate.command, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: visual_gate enabled with command, advisory mode, and custom artifacts_dir", async () => {
  const repo = makeFakeRepo(
    `visual_gate:\n  enabled: true\n  command: "npx playwright test"\n  mode: advisory\n  timeout: 600\n  max_attempts: 3\n  artifacts_dir: ".e2e-out"\n`,
  );
  const binDir = makeFakeGh("acme/vg1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.visual_gate.enabled, true);
    assert.equal(cfg.visual_gate.command, "npx playwright test");
    assert.equal(cfg.visual_gate.mode, "advisory");
    assert.equal(cfg.visual_gate.timeout, 600);
    assert.equal(cfg.visual_gate.max_attempts, 3);
    assert.equal(cfg.visual_gate.artifacts_dir, ".e2e-out");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: visual_gate enabled:false keeps other defaults", async () => {
  const repo = makeFakeRepo(`visual_gate:\n  enabled: false\n`);
  const binDir = makeFakeGh("acme/vg2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.visual_gate.enabled, false);
    assert.equal(cfg.visual_gate.mode, DEFAULT_CONFIG.visual_gate.mode);
    assert.equal(cfg.visual_gate.timeout, DEFAULT_CONFIG.visual_gate.timeout);
    assert.equal(cfg.visual_gate.max_attempts, DEFAULT_CONFIG.visual_gate.max_attempts);
    assert.equal(cfg.visual_gate.artifacts_dir, DEFAULT_CONFIG.visual_gate.artifacts_dir);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- design_gate (#436) ----

test("resolveConfig: design_gate absent — disabled by default with documented defaults", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/dg0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.design_gate.enabled, false);
    assert.deepEqual(cfg.design_gate.triggers, DEFAULT_CONFIG.design_gate.triggers);
    assert.deepEqual(cfg.design_gate.extra_triggers, {});
    assert.equal(cfg.design_gate.max_rounds, 2);
    assert.equal(cfg.design_gate.block_threshold, "medium");
    assert.equal(cfg.design_gate.min_confidence, 0.6);
    assert.equal(cfg.design_gate.limits.max_decisions, 8);
    assert.equal(cfg.design_gate.limits.max_field_chars, 4000);
    assert.equal(cfg.design_gate.limits.max_artifact_bytes, 65_536);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: design_gate enabled with a trigger subset", async () => {
  const repo = makeFakeRepo(`design_gate:\n  enabled: true\n  triggers: ["storage", "auth"]\n`);
  const binDir = makeFakeGh("acme/dg1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.design_gate.enabled, true);
    assert.deepEqual(cfg.design_gate.triggers, ["storage", "auth"]);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: design_gate unknown key is rejected at parse time", async () => {
  const repo = makeFakeRepo(`design_gate:\n  enabled: true\n  always: true\n`);
  const binDir = makeFakeGh("acme/dg2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid.*always/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- review_policy (#17) ----

test("resolveConfig: review_policy defaults apply when absent (block medium+, conf floor 0.7, bounded rounds)", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/rp0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.review_policy.block_threshold, DEFAULT_CONFIG.review_policy.block_threshold);
    assert.equal(cfg.review_policy.block_threshold, "medium");
    assert.equal(cfg.review_policy.min_confidence, DEFAULT_CONFIG.review_policy.min_confidence);
    assert.equal(cfg.review_policy.min_confidence, 0.7);
    assert.equal(
      cfg.review_policy.max_adversarial_rounds,
      DEFAULT_CONFIG.review_policy.max_adversarial_rounds,
    );
    assert.equal(cfg.review_policy.max_adversarial_rounds, 3);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_policy.max_adversarial_rounds override merges", async () => {
  const repo = makeFakeRepo(`review_policy:\n  max_adversarial_rounds: 2\n`);
  const binDir = makeFakeGh("acme/rp-cap");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.review_policy.max_adversarial_rounds, 2);
    // untouched fields keep their defaults
    assert.equal(cfg.review_policy.block_threshold, "medium");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_policy block_threshold + min_confidence override merge", async () => {
  const repo = makeFakeRepo(`review_policy:\n  block_threshold: high\n  min_confidence: 0.7\n`);
  const binDir = makeFakeGh("acme/rp1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.review_policy.block_threshold, "high");
    assert.equal(cfg.review_policy.min_confidence, 0.7);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: a partial review_policy keeps the other field at its default", async () => {
  const repo = makeFakeRepo(`review_policy:\n  block_threshold: critical\n`);
  const binDir = makeFakeGh("acme/rp2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.review_policy.block_threshold, "critical");
    assert.equal(cfg.review_policy.min_confidence, DEFAULT_CONFIG.review_policy.min_confidence);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: invalid review_policy.block_threshold is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`review_policy:\n  block_threshold: blocker\n`);
  const binDir = makeFakeGh("acme/rp3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_policy.min_confidence out of [0,1] is rejected", async () => {
  const repo = makeFakeRepo(`review_policy:\n  min_confidence: 1.5\n`);
  const binDir = makeFakeGh("acme/rp4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown review_policy key is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`review_policy:\n  block_threshold: high\n  bogus: 1\n`);
  const binDir = makeFakeGh("acme/rp5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- review_harness override (#40) ----
//
// `review_harness` overrides only the reviewer role; the implementer is always
// profile-owned. The override is applied at merge time, so all stage code keeps
// reading `cfg.harnesses.reviewer`. When absent, the profile's reviewer is used
// unchanged with no warning.

test("resolveConfig: review_harness overrides the reviewer harness; implementer unaffected (codex profile)", async () => {
  const repo = makeFakeRepo(`review_harness: my-reviewer\n`);
  const binDir = makeFakeGh("acme/rh1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    // codex profile (default): implementer=codex, reviewer=claude → reviewer overridden
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewer, "my-reviewer");
    assert.equal(cfg.harnesses.implementer, "codex"); // unchanged by file config
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness does not override the implementer (claude profile)", async () => {
  // Spec scenario: implementer cannot be overridden by file config — only the
  // reviewer is. Under the claude profile (implementer=claude, reviewer=codex),
  // setting review_harness changes only the reviewer.
  const repo = makeFakeRepo(`review_harness: my-reviewer\n`);
  const binDir = makeFakeGh("acme/rh2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.harnesses.reviewer, "my-reviewer");
    assert.equal(cfg.harnesses.implementer, "claude"); // profile implementer, unchanged
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness absent → reviewer is the profile default, no warning (codex profile)", async () => {
  const repo = makeFakeRepo(null); // no config file at all
  const binDir = makeFakeGh("acme/rh0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      // codex profile (default) → reviewer=claude
      cfg = cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.equal(cfg.harnesses.reviewer, "claude");
    assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness absent under claude profile → reviewer is codex", async () => {
  const repo = makeFakeRepo(`base_branch: main\n`); // a config file, but no review_harness
  const binDir = makeFakeGh("acme/rh3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.harnesses.reviewer, "codex"); // profile cross-harness default
    assert.equal(cfg.harnesses.implementer, "claude");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.review absent + reviewer=codex → the generated default is NOT treated as explicit (#441 finding a74ee050)", async () => {
  // Regression: when `models.review` is absent from file config, resolveConfig()
  // still supplies DEFAULT_CONFIG.models.review (claude-fable-5, a claude-only
  // alias) for `cfg.models.review`. Without this fix, `reviewWasAuto` was false
  // in this case, so the codex-reviewer guard (resolveReviewerModelForHarness)
  // treated the generated default as an explicit override and forwarded
  // `claude-fable-5` to `codex exec -m`, which codex rejects. `reviewWasAuto`
  // must be true here so the guard omits the model for a codex reviewer.
  const repo = makeFakeRepo(`base_branch: main\n`); // no models.review key at all
  const binDir = makeFakeGh("acme/im-default");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    // claude profile → reviewer=codex
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.harnesses.reviewer, "codex");
    assert.equal(cfg.models.review, "claude-fable-5");
    assert.equal(cfg.models.reviewWasAuto, true);
    assert.equal(
      resolveReviewerModelForHarness(cfg.models.review, cfg.harnesses.reviewer, !!cfg.models.reviewWasAuto),
      undefined,
      "an unconfigured codex reviewer must fall back to its own default, not claude-fable-5",
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: a non-string review_harness is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`review_harness: 42\n`);
  const binDir = makeFakeGh("acme/rh4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("review_harness"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- reviewer-model alias guard (#454) ----
//
// Before v1.15.2, a Claude-only `models.review`/`review_harness.model` alias
// against a codex reviewer was documented as inert. #441 made the reviewer
// alias load-bearing (passed through to `codex exec -m <model>`), so that
// same pre-existing config now 400s mid-run instead of silently no-op'ing.
// These regressions move the rejection to config-parse time.

test("resolveConfig: models.review set to a Claude alias + reviewer=codex throws at parse time, naming key/value/harness/alternatives (#454)", async () => {
  const repo = makeFakeRepo(`models:\n  review: sonnet\n`);
  const binDir = makeFakeGh("acme/alias-guard1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      // claude profile → reviewer=codex
      () => cfgMod.resolveConfig({ repoPath: repo, profile: "claude" }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) &&
        err.message.includes("models.review") &&
        err.message.includes("sonnet") &&
        err.message.includes("codex") &&
        err.message.includes("auto"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness.model set to a Claude alias + command=codex throws at parse time, naming review_harness.model (#454)", async () => {
  const repo = makeFakeRepo(`review_harness:\n  command: codex\n  model: opus\n`);
  const binDir = makeFakeGh("acme/alias-guard2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) &&
        err.message.includes("review_harness.model") &&
        err.message.includes("opus"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.review 'auto' + reviewer=codex resolves cleanly, no throw (#454)", async () => {
  const repo = makeFakeRepo(`models:\n  review: auto\n`);
  const binDir = makeFakeGh("acme/alias-guard3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.harnesses.reviewer, "codex");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: no models block + reviewer=codex resolves cleanly, no throw (#454)", async () => {
  const repo = makeFakeRepo(`base_branch: main\n`);
  const binDir = makeFakeGh("acme/alias-guard4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.harnesses.reviewer, "codex");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.review set to a Claude alias + reviewer=claude resolves unchanged, no throw (#454)", async () => {
  const repo = makeFakeRepo(`models:\n  review: sonnet\n`);
  const binDir = makeFakeGh("acme/alias-guard5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    // codex profile (default) → reviewer=claude
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewer, "claude");
    assert.equal(cfg.models.review, "sonnet");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: tolerateInvalidConfig warns and falls back to the default reviewer model instead of throwing (#454)", async () => {
  const repo = makeFakeRepo(`models:\n  review: sonnet\n`);
  const binDir = makeFakeGh("acme/alias-guard6");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      // claude profile → reviewer=codex
      cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude", tolerateInvalidConfig: true });
    });
    assert.equal(cfg.harnesses.reviewer, "codex");
    assert.notEqual(cfg.models.review, "sonnet");
    const hit = warnings.find((w) => w.includes("models.review"));
    assert.ok(hit, `expected a warning naming models.review, got: ${JSON.stringify(warnings)}`);
    assert.match(hit!, /sonnet/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: tolerateInvalidConfig + quiet emits no warning for a rejected reviewer alias (#454)", async () => {
  const repo = makeFakeRepo(`models:\n  review: sonnet\n`);
  const binDir = makeFakeGh("acme/alias-guard7");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      cfgMod.resolveConfig({ repoPath: repo, profile: "claude", tolerateInvalidConfig: true, quiet: true });
    });
    assert.deepEqual(warnings, []);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- inert models.* alias warning (#116) ----
//
// Model selection is claude-only (harness.ts passes --model only on the claude
// branch). A models.* alias whose backing harness role is `codex` is silently
// ignored, so resolveConfig warns. The `codex` profile is implementer=codex /
// reviewer=claude; the `claude` profile is implementer=claude / reviewer=codex —
// so we pick the profile that makes the target role codex (or not).

/** Run `fn`, capturing console.warn output; restore the original after. */
async function captureWarnings(fn: () => void | Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

test("resolveConfig: models.review set to a codex-plausible model + reviewer=codex does NOT warn or throw (codex reviewer honors -m) (#454)", async () => {
  const repo = makeFakeRepo(`models:\n  review: gpt-5.6-terra\n`);
  const binDir = makeFakeGh("acme/im1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      // claude profile → reviewer=codex
      cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    });
    assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
    assert.equal(cfg.models.review, "gpt-5.6-terra");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.review set + custom reviewer CLI warns it is inert", async () => {
  const repo = makeFakeRepo(`review_harness: my-reviewer\nmodels:\n  review: opus\n`);
  const binDir = makeFakeGh("acme/im1b");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      cfgMod.resolveConfig({ repoPath: repo });
    });
    const hit = warnings.find((w) => w.includes("models.review"));
    assert.ok(hit, `expected a warning for models.review, got: ${JSON.stringify(warnings)}`);
    assert.match(hit!, /opus/);
    assert.match(hit!, /my-reviewer/);
    assert.match(hit!, /ignored/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.planning set + implementer=codex warns it is inert", async () => {
  const repo = makeFakeRepo(`models:\n  planning: sonnet\n`);
  const binDir = makeFakeGh("acme/im2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      // codex profile (default) → implementer=codex
      cfgMod.resolveConfig({ repoPath: repo });
    });
    const hit = warnings.find((w) => w.includes("models.planning"));
    assert.ok(hit, `expected a warning for models.planning, got: ${JSON.stringify(warnings)}`);
    assert.match(hit!, /sonnet/);
    assert.match(hit!, /codex/);
    assert.match(hit!, /ignored/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.fix set + implementer=codex warns it is inert", async () => {
  const repo = makeFakeRepo(`models:\n  fix: haiku\n`);
  const binDir = makeFakeGh("acme/im3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      cfgMod.resolveConfig({ repoPath: repo });
    });
    const hit = warnings.find((w) => w.includes("models.fix"));
    assert.ok(hit, `expected a warning for models.fix, got: ${JSON.stringify(warnings)}`);
    assert.match(hit!, /haiku/);
    assert.match(hit!, /ignored/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.review set + reviewer=claude does NOT warn", async () => {
  const repo = makeFakeRepo(`models:\n  review: opus\n`);
  const binDir = makeFakeGh("acme/im4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      // codex profile (default) → reviewer=claude
      cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.planning set + implementer=claude does NOT warn", async () => {
  const repo = makeFakeRepo(`models:\n  planning: sonnet\n`);
  const binDir = makeFakeGh("acme/im5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      // claude profile → implementer=claude
      cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    });
    const planningWarn = warnings.find((w) => w.includes("models.planning"));
    assert.equal(planningWarn, undefined, `unexpected warning: ${JSON.stringify(warnings)}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: no models block + codex harness does NOT warn", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/im6");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: partial models block (review only) warns per-key, not for absent keys", async () => {
  // models.review set but planning/fix absent, under codex profile
  // (implementer=codex, reviewer=claude). review→reviewer=claude → no warn;
  // planning/fix absent → no warn. Proves the partial block validates and that
  // detection is per explicitly-set key, not "models block present at all".
  const repo = makeFakeRepo(`models:\n  review: opus\n`);
  const binDir = makeFakeGh("acme/im7");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      cfg = cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.equal(
      warnings.find((w) => w.includes("models.planning")),
      undefined,
      `unexpected models.planning warning: ${JSON.stringify(warnings)}`,
    );
    assert.deepEqual(warnings, [], `expected no warnings at all, got: ${JSON.stringify(warnings)}`);
    // Partial block resolves: explicit key kept, absent keys fall back to defaults.
    assert.equal(cfg.models.review, "opus");
    assert.equal(cfg.models.planning, DEFAULT_CONFIG.models.planning);
    assert.equal(cfg.models.fix, DEFAULT_CONFIG.models.fix);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: inert warning is non-blocking — config unchanged, alias preserved", async () => {
  // codex profile, models.planning inert (implementer=codex). The warning must
  // not throw or mutate the resolved config: the alias stays in cfg.models.
  const repo = makeFakeRepo(`models:\n  planning: haiku\n`);
  const binDir = makeFakeGh("acme/im8");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      cfg = cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.ok(warnings.some((w) => w.includes("models.planning")));
    // Alias preserved despite being inert; siblings keep defaults.
    assert.equal(cfg.models.planning, "haiku");
    assert.equal(cfg.models.review, DEFAULT_CONFIG.models.review);
    assert.equal(cfg.models.fix, DEFAULT_CONFIG.models.fix);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- models schema strictness (#116 follow-up) ----
// A typo-only models block (e.g. `reviwe: opus`) must be rejected rather than
// silently accepted with the unknown key stripped (which would produce a
// default-value config with no warning, masking the misconfiguration).

test("resolveConfig: unknown models key is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`models:\n  reviwe: opus\n`);
  const binDir = makeFakeGh("acme/models-strict1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("reviwe"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: partial known models block (single key) is still valid", async () => {
  // Regression guard: .strict() must not break partial models blocks that only
  // set one of the three known keys.
  const repo = makeFakeRepo(`models:\n  fix: sonnet\n`);
  const binDir = makeFakeGh("acme/models-strict2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.models.fix, "sonnet");
    assert.equal(cfg.models.planning, DEFAULT_CONFIG.models.planning);
    assert.equal(cfg.models.review, DEFAULT_CONFIG.models.review);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- models.implementing slot (#70) ----
//
// The implementing step gained a dedicated `models.implementing` slot. It
// resolves like every other slot (file value ?? default), defaults to "sonnet"
// (the prior implicit alias, so existing repos are unchanged), and warns when set
// while the implementer harness is codex — the same advisory the other slots get.

test("resolveConfig: models.implementing is accepted and resolves (#70)", async () => {
  const repo = makeFakeRepo(`models:\n  implementing: opus\n`);
  const binDir = makeFakeGh("acme/impl-slot1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    // claude profile → implementer=claude, so the alias is honored (no warning).
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.models.implementing, "opus");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.implementing defaults to sonnet when absent (#70)", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/impl-slot2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.models.implementing, "sonnet");
    assert.equal(cfg.models.implementing, DEFAULT_CONFIG.models.implementing);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: a models block omitting implementing keeps the default + no inert warning (#70)", async () => {
  // Another slot set, implementing absent, under the codex profile
  // (implementer=codex). review→reviewer=claude → no review warning; an absent
  // (default-valued) implementing key must never warn even though implementer=codex.
  const repo = makeFakeRepo(`models:\n  review: opus\n`);
  const binDir = makeFakeGh("acme/impl-slot3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      cfg = cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.equal(
      warnings.find((w) => w.includes("models.implementing")),
      undefined,
      `unexpected implementing warning: ${JSON.stringify(warnings)}`,
    );
    assert.equal(cfg.models.implementing, DEFAULT_CONFIG.models.implementing);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.implementing set + implementer=codex warns it is inert (#70)", async () => {
  const repo = makeFakeRepo(`models:\n  implementing: haiku\n`);
  const binDir = makeFakeGh("acme/impl-slot4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      // codex profile (default) → implementer=codex
      cfg = cfgMod.resolveConfig({ repoPath: repo });
    });
    const hit = warnings.find((w) => w.includes("models.implementing"));
    assert.ok(hit, `expected a warning for models.implementing, got: ${JSON.stringify(warnings)}`);
    assert.match(hit!, /haiku/);
    assert.match(hit!, /codex/);
    assert.match(hit!, /ignored/);
    // Non-blocking: the inert alias is still preserved in the resolved config.
    assert.equal(cfg.models.implementing, "haiku");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.implementing set + implementer=claude does NOT warn (#70)", async () => {
  const repo = makeFakeRepo(`models:\n  implementing: opus\n`);
  const binDir = makeFakeGh("acme/impl-slot5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      // claude profile → implementer=claude
      cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    });
    assert.equal(
      warnings.find((w) => w.includes("models.implementing")),
      undefined,
      `unexpected warning: ${JSON.stringify(warnings)}`,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- doctor block (#146) ----

test("resolveConfig: doctor defaults apply when block is absent", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/doc0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.doctor.runOnStart, DEFAULT_CONFIG.doctor.runOnStart);
    assert.equal(cfg.doctor.runOnStart, false);
    assert.equal(cfg.doctor.failFast, DEFAULT_CONFIG.doctor.failFast);
    assert.equal(cfg.doctor.failFast, false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: doctor block with valid keys is accepted", async () => {
  const repo = makeFakeRepo(`doctor:\n  runOnStart: true\n  failFast: false\n`);
  const binDir = makeFakeGh("acme/doc1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.doctor.runOnStart, true);
    assert.equal(cfg.doctor.failFast, false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: a partial doctor block keeps the other field at its default", async () => {
  const repo = makeFakeRepo(`doctor:\n  failFast: true\n`);
  const binDir = makeFakeGh("acme/doc2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.doctor.failFast, true);
    assert.equal(cfg.doctor.runOnStart, false); // unspecified → default
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown key under doctor is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`doctor:\n  autoFix: true\n`);
  const binDir = makeFakeGh("acme/doc3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("autoFix"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: non-boolean doctor.runOnStart is rejected", async () => {
  const repo = makeFakeRepo(`doctor:\n  runOnStart: yes-please\n`);
  const binDir = makeFakeGh("acme/doc4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- papercuts block (#419) ----

test("resolveConfig: papercuts defaults to disabled when block is absent", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/pc0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.papercuts.enabled, DEFAULT_CONFIG.papercuts.enabled);
    assert.equal(cfg.papercuts.enabled, false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: papercuts.enabled: true resolves enabled", async () => {
  const repo = makeFakeRepo(`papercuts:\n  enabled: true\n`);
  const binDir = makeFakeGh("acme/pc1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.papercuts.enabled, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown key under papercuts is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`papercuts:\n  rateLimit: 5\n`);
  const binDir = makeFakeGh("acme/pc2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("rateLimit"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- papercuts.auto_file (#421) ----

test("resolveConfig: papercuts absent block resolves auto_file false", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/pc3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.papercuts.auto_file, false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: papercuts.enabled true with auto_file absent defaults auto_file false and defaults the rest", async () => {
  const repo = makeFakeRepo(`papercuts:\n  enabled: true\n`);
  const binDir = makeFakeGh("acme/pc4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.papercuts.auto_file, false);
    assert.equal(cfg.papercuts.auto_file_window_hours, DEFAULT_CONFIG.papercuts.auto_file_window_hours);
    assert.equal(cfg.papercuts.auto_file_max_per_window, DEFAULT_CONFIG.papercuts.auto_file_max_per_window);
    assert.equal(cfg.papercuts.auto_file_min_occurrences, DEFAULT_CONFIG.papercuts.auto_file_min_occurrences);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: papercuts.auto_file true with explicit window/cap/threshold resolves them", async () => {
  const repo = makeFakeRepo(
    `papercuts:\n  enabled: true\n  auto_file: true\n  auto_file_window_hours: 12\n  auto_file_max_per_window: 2\n  auto_file_min_occurrences: 4\n`,
  );
  const binDir = makeFakeGh("acme/pc5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.papercuts.auto_file, true);
    assert.equal(cfg.papercuts.auto_file_window_hours, 12);
    assert.equal(cfg.papercuts.auto_file_max_per_window, 2);
    assert.equal(cfg.papercuts.auto_file_min_occurrences, 4);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: auto_file_max_per_window of zero is rejected, naming the field", async () => {
  const repo = makeFakeRepo(`papercuts:\n  enabled: true\n  auto_file_max_per_window: 0\n`);
  const binDir = makeFakeGh("acme/pc6");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("auto_file_max_per_window"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: auto_file_max_per_window negative is rejected", async () => {
  const repo = makeFakeRepo(`papercuts:\n  enabled: true\n  auto_file_max_per_window: -1\n`);
  const binDir = makeFakeGh("acme/pc7");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("auto_file_max_per_window"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: auto_file_min_occurrences below 2 is rejected, naming the field", async () => {
  const repo = makeFakeRepo(`papercuts:\n  enabled: true\n  auto_file_min_occurrences: 1\n`);
  const binDir = makeFakeGh("acme/pc8");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("auto_file_min_occurrences"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- setup_command (#174) ----

test("resolveConfig: setup_command passes through from file config", async () => {
  const repo = makeFakeRepo(`setup_command: "pnpm install --frozen-lockfile"\n`);
  const binDir = makeFakeGh("acme/sc1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.setup_command, "pnpm install --frozen-lockfile");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: setup_command empty string passes through", async () => {
  const repo = makeFakeRepo(`setup_command: ""\n`);
  const binDir = makeFakeGh("acme/sc2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.setup_command, "");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: setup_command absent → undefined (auto-detect default)", async () => {
  const repo = makeFakeRepo(`base_branch: main\n`);
  const binDir = makeFakeGh("acme/sc3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.setup_command, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: non-string setup_command is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`setup_command: 42\n`);
  const binDir = makeFakeGh("acme/sc4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- build_command (#387) ----

test("resolveConfig: build_command passes through from file config", async () => {
  const repo = makeFakeRepo(`build_command: "npm run build"\n`);
  const binDir = makeFakeGh("acme/bc1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.build_command, "npm run build");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: build_command absent → undefined (inert, no auto-detection)", async () => {
  const repo = makeFakeRepo(`base_branch: main\n`);
  const binDir = makeFakeGh("acme/bc2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.build_command, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: non-string build_command is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`build_command: 42\n`);
  const binDir = makeFakeGh("acme/bc3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("syncConfig: build_command is preserved through sync --apply", () => {
  const repo = makeFakeRepo(`build_command: "npm run build"\n`);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.ok, true, `diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.applied, true);
  assert.match(synced, /^build_command: npm run build/m, "build_command must be preserved after sync");
});

// ---- harness_sandbox (#21) ----

test("resolveConfig: harness_sandbox:true is accepted and returns true", async () => {
  const repo = makeFakeRepo(`harness_sandbox: true\n`);
  const binDir = makeFakeGh("acme/hs1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harness_sandbox, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: harness_sandbox absent defaults to false", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/hs2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harness_sandbox, false);
    assert.equal(cfg.harness_sandbox, DEFAULT_CONFIG.harness_sandbox);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: harness_sandbox:false is accepted and returns false", async () => {
  const repo = makeFakeRepo(`harness_sandbox: false\n`);
  const binDir = makeFakeGh("acme/hs3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harness_sandbox, false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: harness_sandbox:\"yes\" (non-boolean) is rejected with a validation error", async () => {
  const repo = makeFakeRepo(`harness_sandbox: "yes"\n`);
  const binDir = makeFakeGh("acme/hs4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("harness_sandbox"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// Regression (#146 review 2): when pipeline.yml sets doctor.runOnStart: true,
// resolveConfig must tolerate a gh failure (return repo:"") so the run-start
// preflight gate — not the generic config-error path — reports the failure.
test("resolveConfig: doctor.runOnStart:true tolerates gh failure and returns repo:''", async () => {
  const repo = makeFakeRepo(`doctor:\n  runOnStart: true\n`);
  // Fake gh that always exits non-zero.
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\nexit 1\n`);
  fs.chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    // Must NOT throw — the preflight gate owns the failure, not resolveConfig.
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.repo, "", "repo must be '' when gh fails and runOnStart tolerates it");
    assert.equal(cfg.doctor.runOnStart, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// format_gate (#182)
// ---------------------------------------------------------------------------

test("resolveConfig: format_gate absent → defaults to empty array", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/fg0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.format_gate, []);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: format_gate with valid entries is accepted", async () => {
  const repo = makeFakeRepo(
    `format_gate:\n  - command: cargo fmt\n    auto_fix: true\n  - command: cargo clippy -D warnings\n    auto_fix: false\n`,
  );
  const binDir = makeFakeGh("acme/fg1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.format_gate, [
      { command: "cargo fmt", auto_fix: true },
      { command: "cargo clippy -D warnings", auto_fix: false },
    ]);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: format_gate entry missing auto_fix → rejected", async () => {
  const repo = makeFakeRepo(`format_gate:\n  - command: cargo fmt\n`);
  const binDir = makeFakeGh("acme/fg2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("auto_fix"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: format_gate entry with unknown key → rejected", async () => {
  const repo = makeFakeRepo(
    `format_gate:\n  - command: cargo fmt\n    auto_fix: true\n    working_dir: src/\n`,
  );
  const binDir = makeFakeGh("acme/fg3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /Invalid .*pipeline\.yml/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// shipcheck_gate (#148)
// ---------------------------------------------------------------------------

test("resolveConfig: shipcheck_gate block absent → enabled:false, all defaults applied", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/sc-g0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.shipcheck_gate.enabled, false);
    assert.equal(cfg.shipcheck_gate.mode, "advisory");
    assert.equal(cfg.shipcheck_gate.max_rounds, 1);
    assert.equal(cfg.shipcheck_gate.rubric_path, ".github/shipcheck-rubric.md");
    assert.equal(cfg.shipcheck_gate.block_on_partial, false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: shipcheck_gate with valid keys accepted, values propagated", async () => {
  const repo = makeFakeRepo(
    `shipcheck_gate:\n  enabled: true\n  mode: gate\n  max_rounds: 3\n  rubric_path: ".github/my-rubric.md"\n  block_on_partial: true\n`,
  );
  const binDir = makeFakeGh("acme/sc-g1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.shipcheck_gate.enabled, true);
    assert.equal(cfg.shipcheck_gate.mode, "gate");
    assert.equal(cfg.shipcheck_gate.max_rounds, 3);
    assert.equal(cfg.shipcheck_gate.rubric_path, ".github/my-rubric.md");
    assert.equal(cfg.shipcheck_gate.block_on_partial, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown key under shipcheck_gate rejected at parse time", async () => {
  const repo = makeFakeRepo(`shipcheck_gate:\n  enabled: true\n  bogus_key: hello\n`);
  const binDir = makeFakeGh("acme/sc-g2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("bogus_key"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// findGitRoot — walk up to the nearest .git dir (#155 fix-3)
// ---------------------------------------------------------------------------

test("findGitRoot: resolves from a nested subdirectory to the repo root", () => {
  const root = fs.mkdtempSync(path.join(tmpRoot, "git-root-"));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const nested = path.join(root, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(findGitRoot(nested), root, "must walk up from nested dir to the root containing .git");
  assert.equal(findGitRoot(root), root, "must return root itself when started there");
});

test("findGitRoot: returns null when no .git ancestor exists", () => {
  // Use a temp dir that is NOT under any git repo
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
  assert.equal(findGitRoot(isolated), null);
});

// ---------------------------------------------------------------------------
// config sync — behavior-preserving scaffold refresh
// ---------------------------------------------------------------------------

test("syncConfig: preview reports drift and does not write", () => {
  const original = "base_branch: staging\n";
  const repo = makeFakeRepo(original);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo);

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.applied, false);
  assert.match(result.diff ?? "", /--- a\/\.github\/pipeline\.yml/);
  assert.match(result.diff ?? "", /-base_branch: staging/);
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "preview must not mutate pipeline.yml");
});

test("syncConfig: apply writes a validated behavior-preserving candidate", () => {
  const repo = makeFakeRepo(`base_branch: staging
models:
  review: sonnet
test_gate:
  command: npm run ci
  max_attempts: 4
review_policy:
  block_threshold: high
  min_confidence: 0.8
format_gate: []
`);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.applied, true);
  assert.match(synced, /# Pipeline configuration for this repo — synced with `pipeline config sync`\./);
  assert.match(synced, /^base_branch: staging/m);
  assert.match(synced, /^models:/m);
  assert.match(synced, /config error/, "config sync (#454) must refresh the models: comment to the post-#441 contract");
  assert.match(synced, /^  review: sonnet # reviewer harness/m);
  assert.doesNotMatch(synced, /^  planning:/m, "absent model aliases must stay commented, not become explicit");
  assert.match(synced, /^  command: npm run ci # explicit command/m);
  assert.match(synced, /^  max_attempts: 4 # fix-harness/m);
  assert.match(synced, /^  block_threshold: high #/m);
  assert.match(synced, /^  min_confidence: 0\.8 #/m);
  assert.match(synced, /^format_gate: \[\]/m);
});

test("syncConfig: invalid current config is not rewritten", () => {
  const original = "unknown_key: bad-value\n";
  const repo = makeFakeRepo(original);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });

  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.applied, false);
  assert.ok(result.diagnostics.some((d) => d.path === "unknown_key"));
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "invalid config must be preserved");
});

test("syncConfig: missing config directs the user to run init", () => {
  const repo = makeFakeRepo(null);

  const result = syncConfig(repo);

  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.applied, false);
  assert.match(result.diagnostics[0]?.message ?? "", /pipeline init/);
});

test("syncConfig: newline scalar overrides render as valid inline YAML", () => {
  const repo = makeFakeRepo('domain_description: "first line\\nsecond line"\n');
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.match(synced, /^domain_description: "first line\\nsecond line" #/m);
});

// ---------------------------------------------------------------------------
// Regression: sync --apply must NOT silently drop behavior-changing sections
// that PartialConfigSchema accepts but that renderConfigTemplate + normalizeForSync
// previously omitted. Finding 0a1f8d19 (#318).
// ---------------------------------------------------------------------------

test("syncConfig: context_snapshot.max_chars is preserved through sync --apply", () => {
  const repo = makeFakeRepo("context_snapshot:\n  max_chars: 4000\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.ok, true, `diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.applied, true);
  assert.match(synced, /^context_snapshot:/m, "context_snapshot block must be present after sync");
  assert.match(synced, /max_chars: 4000/, "max_chars value must be preserved");
});

test("syncConfig: queue settings are preserved through sync --apply", () => {
  const repo = makeFakeRepo("queue:\n  max_issues: 5\n  concurrency: 2\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.ok, true, `diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.applied, true);
  assert.match(synced, /^queue:/m, "queue block must be present after sync");
  assert.match(synced, /max_issues: 5/, "max_issues value must be preserved");
  assert.match(synced, /concurrency: 2/, "concurrency value must be preserved");
});

test("syncConfig: auto_merge_eligibility settings are preserved through sync --apply", () => {
  const repo = makeFakeRepo("auto_merge_eligibility:\n  enabled: true\n  max_diff_lines: 150\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = syncConfig(repo, { apply: true });
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.ok, true, `diagnostics: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(result.applied, true);
  assert.match(synced, /^auto_merge_eligibility:/m, "auto_merge_eligibility block must be present after sync");
  assert.match(synced, /enabled: true/, "enabled flag must be preserved");
  assert.match(synced, /max_diff_lines: 150/, "max_diff_lines value must be preserved");
});

test("CLI: `pipeline config sync` previews without mutating", () => {
  const original = "base_branch: staging\n";
  const repo = makeFakeRepo(original);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "sync", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /pipeline config sync: preview/);
  assert.match(result.stdout, /-base_branch: staging/);
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "CLI preview must not mutate pipeline.yml");
});

test("CLI: `pipeline config sync --apply` writes refreshed config", () => {
  const repo = makeFakeRepo("base_branch: staging\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "sync", "--apply", "--repo-path", repo],
    { encoding: "utf8" },
  );
  const synced = fs.readFileSync(configPath, "utf8");

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /pipeline config sync: updated/);
  assert.match(synced, /# Pipeline configuration for this repo — synced with `pipeline config sync`\./);
  assert.match(synced, /^base_branch: staging/m);
});

test("CLI: `pipeline config repo-map add` writes the entry and exits 0", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const binDir = makeFakeGh("acme/lib");
  const oldPath = process.env.PATH;

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "add", "acme/lib", "--repo-path", repo],
    { encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${oldPath}` } },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /repo_map:/);
  assert.match(written, /- acme\/lib/);
});

test("CLI: `pipeline config repo-map add --rel depended_on_by` targets depended_on_by", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const binDir = makeFakeGh("acme/app");
  const oldPath = process.env.PATH;

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "add", "acme/app", "--rel", "depended_on_by", "--repo-path", repo],
    { encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${oldPath}` } },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /depended_on_by:\s*\n\s+- acme\/app/);
});

test("CLI: `pipeline config repo-map remove` removes the entry and exits 0", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "remove", "acme/lib", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /acme\/lib/);
});

test("CLI: `pipeline config repo-map remove` on an absent entry exits 0 with a warning", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "remove", "acme/absent", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stderr, /warning/i);
});

test("CLI: `pipeline config repo-map list` prints entries grouped by relationship", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n  depended_on_by:\n    - acme/app\n");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "list", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /depends_on/);
  assert.match(result.stdout, /acme\/lib/);
  assert.match(result.stdout, /depended_on_by/);
  assert.match(result.stdout, /acme\/app/);
});

test("CLI: `pipeline config repo-map add` with a malformed owner/repo exits 1 and does not write", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "add", "not-a-repo", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1, `stdout:\n${result.stdout}`);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("CLI: `pipeline config repo-map add` with an invalid --rel exits non-zero and does not write", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "add", "acme/lib", "--rel", "siblings", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0, `stdout:\n${result.stdout}`);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("CLI: `pipeline config repo-map add` on a repo with no pipeline.yml exits 1 and creates no file", () => {
  const repo = makeFakeRepo(null);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "add", "acme/lib", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1, `stdout:\n${result.stdout}`);
  assert.match(result.stdout, /pipeline init/);
  assert.equal(fs.existsSync(configPath), false);
});

test("CLI: `pipeline config repo-map` with an unknown subcommand lists available subcommands", () => {
  const repo = makeFakeRepo("base_branch: main\n");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "repo-map", "bogus", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /add/);
  assert.match(result.stderr, /remove/);
  assert.match(result.stderr, /list/);
});

test("CLI: `pipeline config bogus` unknown-subcommand message lists repo-map", () => {
  const repo = makeFakeRepo("base_branch: main\n");

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "bogus", "--repo-path", repo],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /repo-map/);
});

test("CLI: `pipeline config --help` advertises sync preview/apply and repo-map", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "config", "--help"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /schema/);
  assert.match(result.stdout, /validate/);
  assert.match(result.stdout, /sync/);
  assert.match(result.stdout, /repo-map/);
  assert.match(result.stdout, /--apply/);
});

// ---------------------------------------------------------------------------
// models.intake / models.sweep (#220) — intake & sweep ALWAYS run the claude
// harness (hardcoded in their stages), independent of the active profile, so
// these aliases are always honored and must NEVER be reported inert — even under
// the default codex implementer profile (regression guard against a false
// "ignored because the harness is codex" warning).
// ---------------------------------------------------------------------------

test("resolveConfig: models.intake/models.sweep default to DEFAULT_CONFIG when unset (#220)", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.models.intake, DEFAULT_CONFIG.models.intake);
    assert.equal(cfg.models.sweep, DEFAULT_CONFIG.models.sweep);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.intake/models.sweep overrides from pipeline.yml win (#220)", async () => {
  const repo = makeFakeRepo("models:\n  intake: haiku\n  sweep: opus\n");
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.models.intake, "haiku");
    assert.equal(cfg.models.sweep, "opus");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.intake/models.sweep are NEVER inert under the default codex profile (#220)", async () => {
  const repo = makeFakeRepo("models:\n  intake: haiku\n  sweep: haiku\n");
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    cfgMod.resolveConfig({ repoPath: repo });
    assert.ok(
      !warnings.some((w) => w.includes("models.intake")),
      `models.intake is hardcoded to the claude harness and must never warn inert; got: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      !warnings.some((w) => w.includes("models.sweep")),
      `models.sweep is hardcoded to the claude harness and must never warn inert; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = origWarn;
    process.env.PATH = oldPath;
  }
});

test("resolveReleaseConfig: returns intake_model — default when unset, pipeline.yml override when set (#220)", async () => {
  const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
  // resolveReleaseConfig does not shell out to gh, so no fake gh is needed.
  const dflt = cfgMod.resolveReleaseConfig(makeFakeRepo(null));
  assert.equal(dflt.intake_model, DEFAULT_CONFIG.models.intake, "default intake_model must be DEFAULT_CONFIG.models.intake");
  const over = cfgMod.resolveReleaseConfig(makeFakeRepo("models:\n  intake: haiku\n"));
  assert.equal(over.intake_model, "haiku", "models.intake in pipeline.yml must override");
});

test("resolveReleaseConfig: returns intake_effort — unset by default, pipeline.yml override when set, auto resolves (#366)", async () => {
  const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
  // resolveReleaseConfig does not shell out to gh, so no fake gh is needed.
  const dflt = cfgMod.resolveReleaseConfig(makeFakeRepo(null));
  assert.equal(dflt.intake_effort, undefined, "intake_effort must be unset when effort.intake is absent");
  const over = cfgMod.resolveReleaseConfig(makeFakeRepo("effort:\n  intake: high\n"));
  assert.equal(over.intake_effort, "high", "effort.intake in pipeline.yml must override");
  const auto = cfgMod.resolveReleaseConfig(makeFakeRepo("effort:\n  intake: auto\n"));
  assert.equal(auto.intake_effort, "low", "effort.intake: auto must resolve via the intake stage routing (Analytical/Ephemeral)");
});

test("resolveReleaseConfig: returns intake_timeout — default when unset, pipeline.yml override when set (#248)", async () => {
  const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
  // resolveReleaseConfig does not shell out to gh, so no fake gh is needed.
  const dflt = cfgMod.resolveReleaseConfig(makeFakeRepo(null));
  assert.equal(dflt.intake_timeout, DEFAULT_CONFIG.intake_timeout, "default intake_timeout must be DEFAULT_CONFIG.intake_timeout");
  const over = cfgMod.resolveReleaseConfig(makeFakeRepo("intake_timeout: 123\n"));
  assert.equal(over.intake_timeout, 123, "intake_timeout in pipeline.yml must override");
});

// #154 regression: `doctor --is-ok` is a zero-output 0/1 polling gate, but config
// resolution runs first and can emit non-fatal warnings (e.g. an inert models.*
// alias under the default codex implementer). resolveConfig({ quiet: true }) must
// suppress those warnings so the gate stays silent.
test("resolveConfig: quiet suppresses inert-model-alias config warnings (#154)", async () => {
  const repo = makeFakeRepo("models:\n  planning: sonnet\n");
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const { resolveConfig } = await import("../scripts/config.ts");
    // Default profile → implementer is codex, so models.planning is an inert alias
    // that normally warns. Without quiet the warning fires (proves the bite)…
    warnings.length = 0;
    resolveConfig({ repoPath: repo });
    assert.ok(
      warnings.some((w) => w.includes("models.planning")),
      `expected an inert-alias warning without quiet; got: ${JSON.stringify(warnings)}`,
    );
    // …with quiet:true (the doctor --is-ok path), no warning may reach stderr.
    warnings.length = 0;
    resolveConfig({ repoPath: repo, quiet: true });
    assert.equal(warnings.length, 0, `quiet must suppress config warnings; got: ${JSON.stringify(warnings)}`);
  } finally {
    console.warn = origWarn;
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// intake_timeout / sweep_timeout (#248)
// ---------------------------------------------------------------------------

test("resolveConfig: intake_timeout and sweep_timeout default to 600 when absent", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/timeout-defaults");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.intake_timeout, 600);
    assert.equal(cfg.sweep_timeout, 600);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: file intake_timeout overrides default; sweep_timeout stays 600", async () => {
  const repo = makeFakeRepo(`intake_timeout: 300\n`);
  const binDir = makeFakeGh("acme/timeout-file");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.intake_timeout, 300);
    assert.equal(cfg.sweep_timeout, 600);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: intake_timeout: 0 is rejected (non-positive)", async () => {
  const repo = makeFakeRepo(`intake_timeout: 0\n`);
  const binDir = makeFakeGh("acme/timeout-zero");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("intake_timeout"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: sweep_timeout: 'fast' is rejected (non-integer)", async () => {
  const repo = makeFakeRepo(`sweep_timeout: fast\n`);
  const binDir = makeFakeGh("acme/timeout-str");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("sweep_timeout"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// plan_review_timeout (#278)
// ---------------------------------------------------------------------------

test("resolveConfig: plan_review_timeout absent → defaults to 300", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/prt0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.plan_review_timeout, 300);
    assert.equal(cfg.plan_review_timeout, DEFAULT_CONFIG.plan_review_timeout);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: file plan_review_timeout:600 overrides default; other timeouts unchanged", async () => {
  const repo = makeFakeRepo(`plan_review_timeout: 600\n`);
  const binDir = makeFakeGh("acme/prt1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.plan_review_timeout, 600);
    assert.equal(cfg.review_timeout, DEFAULT_CONFIG.review_timeout);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: plan_review_timeout: 0 is rejected (non-positive)", async () => {
  const repo = makeFakeRepo(`plan_review_timeout: 0\n`);
  const binDir = makeFakeGh("acme/prt2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("plan_review_timeout"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: plan_review_timeout: 'fast' is rejected (non-integer)", async () => {
  const repo = makeFakeRepo(`plan_review_timeout: fast\n`);
  const binDir = makeFakeGh("acme/prt3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("plan_review_timeout"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: plan_review_timeout: -1 is rejected (negative integer)", async () => {
  const repo = makeFakeRepo(`plan_review_timeout: -1\n`);
  const binDir = makeFakeGh("acme/prt4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("plan_review_timeout"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- repo_map (#312) ----

test("resolveConfig: repo_map absent → empty-list defaults", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/rm0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.repo_map.depends_on, []);
    assert.deepEqual(cfg.repo_map.depended_on_by, []);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: valid repo_map with depends_on and depended_on_by resolves", async () => {
  const repo = makeFakeRepo(`repo_map:\n  depends_on:\n    - acme/shared-lib\n  depended_on_by:\n    - acme/consumer-app\n`);
  const binDir = makeFakeGh("acme/rm1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.repo_map?.depends_on, ["acme/shared-lib"]);
    assert.deepEqual(cfg.repo_map?.depended_on_by, ["acme/consumer-app"]);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: repo_map with same repo in both lists is preserved", async () => {
  const repo = makeFakeRepo(`repo_map:\n  depends_on:\n    - acme/shared\n  depended_on_by:\n    - acme/shared\n`);
  const binDir = makeFakeGh("acme/rm2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.repo_map?.depends_on, ["acme/shared"]);
    assert.deepEqual(cfg.repo_map?.depended_on_by, ["acme/shared"]);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: repo_map entry missing slash is rejected", async () => {
  const repo = makeFakeRepo(`repo_map:\n  depends_on:\n    - notaslashrepo\n`);
  const binDir = makeFakeGh("acme/rm3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /Invalid .*pipeline\.yml/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: repo_map entry with two slashes is rejected", async () => {
  const repo = makeFakeRepo(`repo_map:\n  depends_on:\n    - acme/shared/extra\n`);
  const binDir = makeFakeGh("acme/rm4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /Invalid .*pipeline\.yml/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: repo_map unknown sub-key is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`repo_map:\n  unknown_key: []\n`);
  const binDir = makeFakeGh("acme/rm5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /Invalid .*pipeline\.yml/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- ci_mode (#350) ----

test("resolveConfig: ci_mode absent defaults to 'github'", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/cim0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.ci_mode, "github");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: ci_mode: local is accepted and resolved correctly", async () => {
  const repo = makeFakeRepo(`ci_mode: local\n`);
  const binDir = makeFakeGh("acme/cim1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.ci_mode, "local");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: out-of-enum ci_mode value is rejected with error naming ci_mode", async () => {
  const repo = makeFakeRepo(`ci_mode: skip\n`);
  const binDir = makeFakeGh("acme/cim2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("ci_mode"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- event_sink (#343) ----

test("resolveConfig: no event_sink configured → event_sink is undefined", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/es0");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.event_sink, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: event_sink.command from pipeline.yml resolves with default mode 'additive'", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "logger -t pipeline"\n`);
  const binDir = makeFakeGh("acme/es1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.event_sink, { command: "logger -t pipeline", mode: "additive" });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: event_sink.mode: exclusive from pipeline.yml is honored", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "logger -t pipeline"\n  mode: exclusive\n`);
  const binDir = makeFakeGh("acme/es2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.event_sink, { command: "logger -t pipeline", mode: "exclusive" });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: PIPELINE_EVENT_SINK_COMMAND activates a sink with no file config", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/es3");
  const oldPath = process.env.PATH;
  const oldCommand = process.env.PIPELINE_EVENT_SINK_COMMAND;
  process.env.PATH = `${binDir}:${oldPath}`;
  process.env.PIPELINE_EVENT_SINK_COMMAND = "vector-tap";
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.event_sink, { command: "vector-tap", mode: "additive" });
  } finally {
    process.env.PATH = oldPath;
    if (oldCommand === undefined) delete process.env.PIPELINE_EVENT_SINK_COMMAND;
    else process.env.PIPELINE_EVENT_SINK_COMMAND = oldCommand;
  }
});

test("resolveConfig: PIPELINE_EVENT_SINK_COMMAND overrides the file's event_sink.command", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "from-file"\n`);
  const binDir = makeFakeGh("acme/es4");
  const oldPath = process.env.PATH;
  const oldCommand = process.env.PIPELINE_EVENT_SINK_COMMAND;
  process.env.PATH = `${binDir}:${oldPath}`;
  process.env.PIPELINE_EVENT_SINK_COMMAND = "from-env";
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.event_sink?.command, "from-env");
  } finally {
    process.env.PATH = oldPath;
    if (oldCommand === undefined) delete process.env.PIPELINE_EVENT_SINK_COMMAND;
    else process.env.PIPELINE_EVENT_SINK_COMMAND = oldCommand;
  }
});

test("resolveConfig: PIPELINE_EVENT_SINK_MODE overrides the file's event_sink.mode", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "from-file"\n  mode: additive\n`);
  const binDir = makeFakeGh("acme/es5");
  const oldPath = process.env.PATH;
  const oldMode = process.env.PIPELINE_EVENT_SINK_MODE;
  process.env.PATH = `${binDir}:${oldPath}`;
  process.env.PIPELINE_EVENT_SINK_MODE = "exclusive";
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.event_sink?.mode, "exclusive");
  } finally {
    process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.PIPELINE_EVENT_SINK_MODE;
    else process.env.PIPELINE_EVENT_SINK_MODE = oldMode;
  }
});

test("resolveConfig: invalid PIPELINE_EVENT_SINK_MODE value throws", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "from-file"\n`);
  const binDir = makeFakeGh("acme/es6");
  const oldPath = process.env.PATH;
  const oldMode = process.env.PIPELINE_EVENT_SINK_MODE;
  process.env.PATH = `${binDir}:${oldPath}`;
  process.env.PIPELINE_EVENT_SINK_MODE = "bogus";
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /PIPELINE_EVENT_SINK_MODE/,
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.PIPELINE_EVENT_SINK_MODE;
    else process.env.PIPELINE_EVENT_SINK_MODE = oldMode;
  }
});

test("resolveConfig: event_sink.mode outside additive/exclusive is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "logger"\n  mode: sometimes\n`);
  const binDir = makeFakeGh("acme/es7");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("event_sink"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: event_sink unknown sub-key is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "logger"\n  url: "https://example.com"\n`);
  const binDir = makeFakeGh("acme/es8");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("event_sink"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("syncConfig: event_sink is preserved through sync --apply", () => {
  const repo = makeFakeRepo(`event_sink:\n  command: "logger -t pipeline"\n  mode: exclusive\n`);
  const result = syncConfig(repo, { apply: true });
  assert.equal(result.ok, true);
  const synced = fs.readFileSync(path.join(repo, ".github", "pipeline.yml"), "utf8");
  assert.match(synced, /^event_sink:/m, "event_sink block must be present after sync");
  assert.match(synced, /command: .*logger -t pipeline/);
  assert.match(synced, /mode: exclusive/);
});

test("syncConfig: visual_gate is preserved through sync --apply", () => {
  const repo = makeFakeRepo(
    `visual_gate:\n  enabled: true\n  command: "npx playwright test"\n  mode: advisory\n  timeout: 600\n  max_attempts: 3\n  artifacts_dir: ".e2e-out"\n`,
  );
  const result = syncConfig(repo, { apply: true });
  assert.equal(result.ok, true);
  const synced = fs.readFileSync(path.join(repo, ".github", "pipeline.yml"), "utf8");
  assert.match(synced, /^visual_gate:/m, "visual_gate block must be present after sync");
  assert.match(synced, /enabled: true/);
  assert.match(synced, /command: .*npx playwright test/);
  assert.match(synced, /mode: advisory/);
  assert.match(synced, /timeout: 600/);
  assert.match(synced, /max_attempts: 3/);
  assert.match(synced, /artifacts_dir: .*\.e2e-out/);
});

// ---------------------------------------------------------------------------
// repo_map add/remove/list (#367)
// ---------------------------------------------------------------------------

const alwaysReachable = () => true;

test("validateOwnerRepo: accepts a well-formed owner/repo string", () => {
  assert.equal(validateOwnerRepo("acme/widget"), null);
});

test("validateOwnerRepo: rejects a string with no '/'", () => {
  assert.match(validateOwnerRepo("acmewidget") ?? "", /owner\/repo/);
});

test("validateOwnerRepo: rejects an empty repo segment", () => {
  assert.match(validateOwnerRepo("acme/") ?? "", /owner\/repo/);
});

test("validateOwnerRepo: rejects an empty owner segment", () => {
  assert.match(validateOwnerRepo("/widget") ?? "", /owner\/repo/);
});

test("validateOwnerRepo: rejects whitespace in either segment", () => {
  assert.match(validateOwnerRepo("acme /widget") ?? "", /owner\/repo/);
});

test("repoMapAdd: defaults to depends_on and creates the repo_map block when absent", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = repoMapAdd(repo, "acme/lib", "depends_on", { checkReachable: alwaysReachable });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.noop, false);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /^repo_map:/m);
  assert.match(written, /^ {2}depends_on:\s*\n\s+- acme\/lib/m);
});

test("repoMapAdd: --rel depended_on_by targets the other list and leaves depends_on untouched", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = repoMapAdd(repo, "acme/app", "depended_on_by", { checkReachable: alwaysReachable });

  assert.equal(result.ok, true);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /depends_on:\s*\n\s+- acme\/lib/);
  assert.match(written, /depended_on_by:\s*\n\s+- acme\/app/);
});

test("repoMapAdd: re-adding an existing entry is an idempotent no-op success", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = repoMapAdd(repo, "acme/lib", "depends_on", { checkReachable: alwaysReachable });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.noop, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), before, "no duplicate entry should be written");
});

test("repoMapAdd: rejects a malformed owner/repo with no write", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = repoMapAdd(repo, "not-a-repo", "depends_on", { checkReachable: alwaysReachable });

  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "invalid-owner-repo");
  assert.equal(fs.readFileSync(configPath, "utf8"), before, "invalid input must not write");
});

test("repoMapAdd: fails with exit-worthy error when .github/pipeline.yml is absent, no file created", () => {
  const repo = makeFakeRepo(null);
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = repoMapAdd(repo, "acme/lib", "depends_on", { checkReachable: alwaysReachable });

  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "missing-config");
  assert.match(result.message, /pipeline init/);
  assert.equal(fs.existsSync(configPath), false, "no config file should be created");
});

test("repoMapAdd: reachability failure warns but the entry is still written", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = repoMapAdd(repo, "acme/private", "depends_on", { checkReachable: () => false });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.match(result.warning ?? "", /acme\/private/);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /- acme\/private/);
});

// Regression proof: without the injected checkReachable seam, repoMapAdd would
// have to shell out to the real `gh` CLI, which is unauthenticated/unavailable
// in CI — this test proves the reachability failure path is exercised purely
// through the injected dep, with no real network/subprocess call.
test("repoMapAdd: reachability check never blocks the write even when it always fails", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  let calls = 0;
  const result = repoMapAdd(repo, "acme/unreachable", "depends_on", {
    checkReachable: () => {
      calls++;
      return false;
    },
  });
  assert.equal(calls, 1, "reachability check must be invoked exactly once via the injected dep");
  assert.equal(result.ok, true);
  assert.ok(result.warning);
});

test("repoMapRemove: removes an existing entry", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n    - acme/other\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");

  const result = repoMapRemove(repo, "acme/lib", "depends_on");

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const written = fs.readFileSync(configPath, "utf8");
  assert.doesNotMatch(written, /acme\/lib\b/);
  assert.match(written, /acme\/other/);
});

test("repoMapRemove: removing an absent entry is a tolerant no-op with a warning", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = repoMapRemove(repo, "acme/absent", "depends_on");

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.noop, true);
  assert.ok(result.warning);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("repoMapRemove: removing from an entirely absent repo_map block is a tolerant no-op", () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = repoMapRemove(repo, "acme/absent", "depends_on");

  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("repoMapRemove: rejects a malformed owner/repo with no write", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n");
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const before = fs.readFileSync(configPath, "utf8");

  const result = repoMapRemove(repo, "bad", "depends_on");

  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "invalid-owner-repo");
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("repoMapList: prints entries grouped by relationship kind", () => {
  const repo = makeFakeRepo("repo_map:\n  depends_on:\n    - acme/lib\n  depended_on_by:\n    - acme/app\n");

  const result = repoMapList(repo);

  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, { depends_on: ["acme/lib"], depended_on_by: ["acme/app"] });
});

test("repoMapList: reports no entries when repo_map is absent", () => {
  const repo = makeFakeRepo("base_branch: main\n");

  const result = repoMapList(repo);

  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, { depends_on: [], depended_on_by: [] });
  assert.match(result.message, /no repo_map entries/i);
});

test("repoMapList: missing config file reports an error", () => {
  const repo = makeFakeRepo(null);

  const result = repoMapList(repo);

  assert.equal(result.ok, false);
  assert.match(result.message, /pipeline init/);
});

test("repoMap add/remove round-trip preserves unrelated keys, comments, and formatting byte-for-byte", () => {
  // Deliberately nonstandard formatting (uneven spacing before an inline comment,
  // 4-space indentation, a flow-style mapping) to prove the edit is scoped to the
  // repo_map block rather than re-serializing the whole document (#367 review 1).
  const original = `# top comment
base_branch:   staging    # trailing comment with odd spacing
steps:
    docs: true
flow_key: { a: 1, b: 2 }
review_policy:
  block_threshold: high
repo_map:
  depends_on:
    - acme/existing
`;
  const repo = makeFakeRepo(original);
  const configPath = path.join(repo, ".github", "pipeline.yml");
  const beforeRepoMap = original.slice(0, original.indexOf("repo_map:"));

  repoMapAdd(repo, "acme/lib", "depends_on", { checkReachable: alwaysReachable });
  const afterAdd = fs.readFileSync(configPath, "utf8");
  assert.equal(
    afterAdd.slice(0, afterAdd.indexOf("repo_map:")),
    beforeRepoMap,
    "bytes preceding repo_map must be unchanged after add",
  );

  repoMapRemove(repo, "acme/lib", "depends_on");
  const afterRemove = fs.readFileSync(configPath, "utf8");
  assert.equal(
    afterRemove.slice(0, afterRemove.indexOf("repo_map:")),
    beforeRepoMap,
    "bytes preceding repo_map must be unchanged after remove",
  );
  assert.match(afterRemove, /depends_on:\s*\n\s*- acme\/existing\s*\n/);
});

test("repoMapAdd: creating repo_map from absent produces a config that still validates", async () => {
  const repo = makeFakeRepo("base_branch: main\n");
  const binDir = makeFakeGh("acme/rm1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const result = cfgMod.repoMapAdd(repo, "acme/lib", "depends_on", { checkReachable: alwaysReachable });
    assert.equal(result.ok, true);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.repo_map.depends_on, ["acme/lib"]);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// effort: block + auto sentinel + structured review_harness (#366)
// ---------------------------------------------------------------------------

test("resolveConfig: effort block accepted and resolved", async () => {
  const repo = makeFakeRepo(`effort:\n  planning: medium\n  implementing: low\n`);
  const binDir = makeFakeGh("acme/effort1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.effort.planning, "medium");
    assert.equal(cfg.effort.implementing, "low");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown key under effort is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`effort:\n  unknown_stage: low\n`);
  const binDir = makeFakeGh("acme/effort2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("unknown_stage"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: effort block absent — every stage's resolved effort is unset, plan_review_effort defaults to medium", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/effort3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.effort.planning, undefined);
    assert.equal(cfg.effort.implementing, undefined);
    assert.equal(cfg.effort.review, undefined);
    assert.equal(cfg.effort.fix, undefined);
    assert.equal(cfg.effort.intake, undefined);
    assert.equal(cfg.effort.sweep, undefined);
    assert.equal(cfg.plan_review_effort, "medium");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.implementing 'auto' resolves to sonnet on the claude primary harness", async () => {
  const repo = makeFakeRepo(`models:\n  implementing: auto\n`);
  const binDir = makeFakeGh("acme/auto1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    assert.equal(cfg.models.implementing, "sonnet");
    assert.notEqual(cfg.models.implementing, "gpt-5.5");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.implementing 'auto' resolves to gpt-5.5 on the codex primary harness", async () => {
  const repo = makeFakeRepo(`models:\n  implementing: auto\n`);
  const binDir = makeFakeGh("acme/auto2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, profile: "codex" });
    assert.equal(cfg.models.implementing, "gpt-5.5");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: effort.implementing 'auto' resolves to low regardless of harness", async () => {
  const repo = makeFakeRepo(`effort:\n  implementing: auto\n`);
  const binDir = makeFakeGh("acme/auto3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const claudeCfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    const codexCfg = cfgMod.resolveConfig({ repoPath: repo, profile: "codex" });
    assert.equal(claudeCfg.effort.implementing, "low");
    assert.equal(codexCfg.effort.implementing, "low");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.review 'auto' resolves to claude-fable-5 under both profiles (profile-independent) and never the short alias", async () => {
  const repo = makeFakeRepo(`models:\n  review: auto\n`);
  const binDir = makeFakeGh("acme/auto4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const claudeCfg = cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    const codexCfg = cfgMod.resolveConfig({ repoPath: repo, profile: "codex" });
    assert.equal(claudeCfg.models.review, "claude-fable-5");
    assert.equal(codexCfg.models.review, "claude-fable-5");
    assert.notEqual(claudeCfg.models.review, "fable-5");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: effort.planning 'auto' splits per-stage — planning resolves medium, plan-review resolves max", async () => {
  // The same effort.planning config key backs two differently-classified
  // stages: planning (Analytical/Iterative) and plan-review (Adversarial/
  // Definitive). cfg.effort.planning serves the planning stage; cfg.plan_review_effort
  // is the dedicated derived value plan-review actually reads (#366).
  const repo = makeFakeRepo(`effort:\n  planning: auto\n`);
  const binDir = makeFakeGh("acme/auto5");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.effort.planning, "medium", "planning stage: Analytical/Iterative");
    assert.equal(cfg.plan_review_effort, "max", "plan-review stage: Adversarial/Definitive");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: models.* / effort.* never resolve to the literal string 'auto'", async () => {
  const repo = makeFakeRepo(
    `models:\n  planning: auto\n  implementing: auto\n  review: auto\n  fix: auto\n  intake: auto\n  sweep: auto\n` +
      `effort:\n  planning: auto\n  implementing: auto\n  fix: auto\n  intake: auto\n  sweep: auto\n`,
  );
  const binDir = makeFakeGh("acme/auto6");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    for (const v of Object.values(cfg.models)) assert.notEqual(v, "auto");
    for (const v of Object.values(cfg.effort)) assert.notEqual(v, "auto");
    assert.notEqual(cfg.plan_review_effort, "auto");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: structured review_harness sets reviewerModel/reviewerEffort; string form leaves them unset", async () => {
  const repo = makeFakeRepo(
    `review_harness:\n  command: claude\n  model: claude-fable-5\n  effort: high\n`,
  );
  const binDir = makeFakeGh("acme/rhstruct1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewer, "claude");
    assert.equal(cfg.harnesses.reviewerModel, "claude-fable-5");
    assert.equal(cfg.harnesses.reviewerEffort, "high");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: structured review_harness with model: auto resolves reviewerModel to claude-fable-5", async () => {
  const repo = makeFakeRepo(`review_harness:\n  command: claude\n  model: auto\n`);
  const binDir = makeFakeGh("acme/rhstruct2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewerModel, "claude-fable-5");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness (string shorthand) leaves reviewerModel/reviewerEffort unset", async () => {
  const repo = makeFakeRepo(`review_harness: claude\n`);
  const binDir = makeFakeGh("acme/rhstruct3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewer, "claude");
    assert.equal(cfg.harnesses.reviewerModel, undefined);
    assert.equal(cfg.harnesses.reviewerEffort, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---- review_harness.prompt_delivery (#492) ----

test("resolveConfig: structured review_harness with prompt_delivery: stdin resolves reviewerPromptDelivery to 'stdin'", async () => {
  const repo = makeFakeRepo(`review_harness:\n  command: my-reviewer\n  prompt_delivery: stdin\n`);
  const binDir = makeFakeGh("acme/rhpromptdelivery1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewerPromptDelivery, "stdin");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: structured review_harness without prompt_delivery defaults reviewerPromptDelivery to 'argv' (byte-for-byte the pre-#492 default)", async () => {
  const repo = makeFakeRepo(`review_harness:\n  command: my-reviewer\n  model: auto\n`);
  const binDir = makeFakeGh("acme/rhpromptdelivery2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewerPromptDelivery, "argv");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness (string shorthand) resolves reviewerPromptDelivery to 'argv'", async () => {
  const repo = makeFakeRepo(`review_harness: my-reviewer\n`);
  const binDir = makeFakeGh("acme/rhpromptdelivery3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.harnesses.reviewerPromptDelivery, "argv");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: review_harness.prompt_delivery rejects a value other than argv/stdin (strict enum)", async () => {
  const repo = makeFakeRepo(`review_harness:\n  command: my-reviewer\n  prompt_delivery: file\n`);
  const binDir = makeFakeGh("acme/rhpromptdelivery4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) => /Invalid .*pipeline\.yml/.test(err.message),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown key under structured review_harness is rejected (strict schema)", async () => {
  const repo = makeFakeRepo(`review_harness:\n  command: claude\n  temperature: 0.2\n`);
  const binDir = makeFakeGh("acme/rhstruct4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      (err: Error) =>
        /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("temperature"),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: effort.review inert-warning fires when the reviewer is a custom CLI", async () => {
  const repo = makeFakeRepo(`review_harness: my-reviewer\neffort:\n  review: high\n`);
  const binDir = makeFakeGh("acme/inerteffort1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    let cfg: any;
    const warnings = await captureWarnings(() => {
      cfg = cfgMod.resolveConfig({ repoPath: repo });
    });
    const hit = warnings.find((w) => w.includes("effort.review"));
    assert.ok(hit, `expected an effort.review inert warning, got: ${JSON.stringify(warnings)}`);
    // Advisory only — the resolved value is preserved, not blanked or thrown.
    assert.equal(cfg.effort.review, "high");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: effort.review does NOT warn when the reviewer is claude or codex (both honor per-stage effort)", async () => {
  const repo = makeFakeRepo(`effort:\n  review: high\n`);
  const binDir = makeFakeGh("acme/inerteffort2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      cfgMod.resolveConfig({ repoPath: repo }); // codex profile → reviewer=claude
    });
    assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: effort.review absent — no inert warning even with a custom reviewer CLI", async () => {
  const repo = makeFakeRepo(`review_harness: my-reviewer\n`);
  const binDir = makeFakeGh("acme/inerteffort3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      cfgMod.resolveConfig({ repoPath: repo });
    });
    assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("DEFAULT_CONFIG.models.review regression: resolves to the full claude-fable-5 id (#366 ratified default)", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/defaultreview1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(DEFAULT_CONFIG.models.review, "claude-fable-5");
    assert.equal(cfg.models.review, "claude-fable-5");
    assert.notEqual(cfg.models.review, "fable-5");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// External stage executors (#314)
// ---------------------------------------------------------------------------

async function resolveWithConfig(content: string | null, repoSlug: string): Promise<unknown> {
  const repo = makeFakeRepo(content);
  const binDir = makeFakeGh(repoSlug);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    return cfgMod.resolveConfig({ repoPath: repo });
  } finally {
    process.env.PATH = oldPath;
  }
}

async function expectInvalidConfig(content: string, repoSlug: string, messagePattern: RegExp): Promise<void> {
  const repo = makeFakeRepo(content);
  const binDir = makeFakeGh(repoSlug);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), messagePattern);
  } finally {
    process.env.PATH = oldPath;
  }
}

test("resolveConfig: no executors/stage_executors block → parity with pre-#314 defaults", async () => {
  const cfg = (await resolveWithConfig(null, "acme/exec-parity")) as { executors: unknown; stage_executors: unknown };
  assert.deepEqual(cfg.executors, {});
  assert.deepEqual(cfg.stage_executors, {});
});

test("resolveConfig: agent-system executor definition accepted", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  opencode-main:\n    type: agent-system\n    provider: opencode\n    endpoint: https://opencode.internal/api\n    credential: OPENCODE_API_KEY\n`,
    "acme/exec1",
  )) as { executors: Record<string, unknown> };
  assert.deepEqual(cfg.executors["opencode-main"], {
    type: "agent-system",
    provider: "opencode",
    endpoint: "https://opencode.internal/api",
    credential: "OPENCODE_API_KEY",
  });
});

test("resolveConfig: model-endpoint executor definition accepted", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3.1:70b\n`,
    "acme/exec2",
  )) as { executors: Record<string, unknown> };
  assert.deepEqual(cfg.executors["local-ollama"], {
    type: "model-endpoint",
    base_url: "http://localhost:11434/v1",
    model: "llama3.1:70b",
  });
});

test("resolveConfig: unknown executor type is rejected, identifying the invalid type", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: some-other-thing\n`,
    "acme/exec3",
    /Invalid .*pipeline\.yml/,
  );
});

test("resolveConfig: unknown key inside an executor definition is rejected (strict)", async () => {
  await expectInvalidConfig(
    `executors:\n  opencode-main:\n    type: agent-system\n    provider: opencode\n    endpoint: https://x\n    unexpected_key: true\n`,
    "acme/exec4",
    /Invalid .*pipeline\.yml/,
  );
});

test("resolveConfig: stage_executors assigning different executors to different stages in one run", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  opencode-main:\n    type: agent-system\n    provider: opencode\n    endpoint: https://opencode.internal/api\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3.1:70b\nstage_executors:\n  planning: opencode-main\n  review-1: local-ollama\n  review-2: local-ollama\n`,
    "acme/exec5",
  )) as { stage_executors: Record<string, string> };
  assert.deepEqual(cfg.stage_executors, { planning: "opencode-main", "review-1": "local-ollama", "review-2": "local-ollama" });
});

test("resolveConfig: stage_executors referencing an unknown executor name is rejected, naming the stage", async () => {
  await expectInvalidConfig(
    `stage_executors:\n  planning: does-not-exist\n`,
    "acme/exec6",
    /stage_executors\.planning.*unknown executor.*does-not-exist/s,
  );
});

test("resolveConfig: model-endpoint assigned to review-2 (prompt-contained) is accepted", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3.1:70b\nstage_executors:\n  review-2: local-ollama\n`,
    "acme/exec7",
  )) as { stage_executors: Record<string, string> };
  assert.equal(cfg.stage_executors["review-2"], "local-ollama");
});

test("resolveConfig: model-endpoint assigned to implementing (execution-environment) is rejected at parse time, naming stage + executor", async () => {
  await expectInvalidConfig(
    `executors:\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3.1:70b\nstage_executors:\n  implementing: local-ollama\n`,
    "acme/exec8",
    /implementing.*local-ollama/s,
  );
});

for (const stage of ["planning", "implementing", "fix-1", "fix-2", "shipcheck-gate"]) {
  test(`resolveConfig: model-endpoint assigned to execution-environment stage "${stage}" is rejected at parse time`, async () => {
    await expectInvalidConfig(
      `executors:\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: m\nstage_executors:\n  ${stage}: local-ollama\n`,
      `acme/exec-eee-${stage}`,
      new RegExp(`${stage}.*local-ollama`, "s"),
    );
  });
}

test("resolveConfig: agent-system assigned to implementing (execution-environment) is accepted, not rejected", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  opencode-main:\n    type: agent-system\n    provider: opencode\n    endpoint: https://opencode.internal/api\nstage_executors:\n  implementing: opencode-main\n`,
    "acme/exec9",
  )) as { stage_executors: Record<string, string> };
  assert.equal(cfg.stage_executors.implementing, "opencode-main");
});

test("resolveConfig: model-endpoint executor with no credential (localhost Ollama) is valid", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3.1:70b\n`,
    "acme/exec10",
  )) as { executors: Record<string, { credential?: string }> };
  assert.equal(cfg.executors["local-ollama"].credential, undefined);
});

// --- #434 api-executor-request-controls: dialect/params/headers/reasoning/structured_output ---

test("resolveConfig: model-endpoint with no dialect/params/headers still parses unchanged (#434)", async () => {
  const cfg = (await resolveWithConfig(
    `executors:\n  local-ollama:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3.1:70b\n`,
    "acme/exec11",
  )) as { executors: Record<string, { dialect?: string; params?: unknown; headers?: unknown }> };
  assert.equal(cfg.executors["local-ollama"].dialect, undefined);
  assert.equal(cfg.executors["local-ollama"].params, undefined);
  assert.equal(cfg.executors["local-ollama"].headers, undefined);
});

test("resolveConfig: model-endpoint with dialect: openrouter and allowlisted params is accepted (#434)", async () => {
  const cfg = (await resolveWithConfig(
    [
      "executors:",
      "  openrouter-review:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    credential: OPENROUTER_API_KEY",
      "    dialect: openrouter",
      "    params:",
      "      temperature: 0",
      "      seed: 7",
      "      max_output_tokens: 4096",
      "      provider:",
      "        order: [openai]",
      "      models: [openai/gpt-5, anthropic/claude-fable-5]",
      "",
    ].join("\n"),
    "acme/exec12",
  )) as { executors: Record<string, { dialect?: string; params?: { temperature?: number } }> };
  assert.equal(cfg.executors["openrouter-review"].dialect, "openrouter");
  assert.equal(cfg.executors["openrouter-review"].params?.temperature, 0);
});

test("resolveConfig: unknown dialect is rejected at parse time, naming the offending value (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3\n    dialect: some-other-thing\n`,
    "acme/exec13",
    /dialect/i,
  );
});

test("resolveConfig: unknown param key is rejected at parse time, naming the offending key (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3\n    params:\n      temperatur: 0\n`,
    "acme/exec14",
    /temperatur/,
  );
});

test("resolveConfig: an OpenRouter-only routing option on the default openai dialect is rejected, naming key + dialect (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: https://api.openai.com/v1\n    model: gpt-5\n    params:\n      provider:\n        order: [openai]\n`,
    "acme/exec15",
    /provider.*openrouter|openrouter.*provider/is,
  );
});

test("resolveConfig: headers declaring authorization is rejected at parse time (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3\n    headers:\n      authorization: "Bearer x"\n`,
    "acme/exec16",
    /authorization/,
  );
});

test("resolveConfig: a malformed provider-routing field type is rejected at parse time, not passed through (#434)", async () => {
  await expectInvalidConfig(
    [
      "executors:",
      "  bad:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    dialect: openrouter",
      "    params:",
      "      provider:",
      "        order: openai",
      "",
    ].join("\n"),
    "acme/exec17",
    /order/,
  );
});

test("resolveConfig: an unknown key inside provider-routing preferences is rejected at parse time (#434)", async () => {
  await expectInvalidConfig(
    [
      "executors:",
      "  bad:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    dialect: openrouter",
      "    params:",
      "      provider:",
      "        unknown_routing_key: true",
      "",
    ].join("\n"),
    "acme/exec18",
    /unknown_routing_key/,
  );
});

test("resolveConfig: fully-typed provider-routing preferences are accepted (#434)", async () => {
  const cfg = (await resolveWithConfig(
    [
      "executors:",
      "  openrouter-review:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    dialect: openrouter",
      "    params:",
      "      provider:",
      "        order: [openai, anthropic]",
      "        allow_fallbacks: false",
      "        data_collection: deny",
      "        sort: price",
      "        max_price:",
      "          prompt: 1",
      "          completion: 2",
      "",
    ].join("\n"),
    "acme/exec19",
  )) as { executors: Record<string, { params?: { provider?: { order?: string[] } } }> };
  assert.deepEqual(cfg.executors["openrouter-review"].params?.provider?.order, ["openai", "anthropic"]);
});

test("resolveConfig: object-form provider sort with an undocumented mode is rejected at parse time (#434 delta 8b3c0429)", async () => {
  await expectInvalidConfig(
    [
      "executors:",
      "  openrouter-review:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    dialect: openrouter",
      "    params:",
      "      provider:",
      "        sort:",
      "          by: typo",
      "",
    ].join("\n"),
    "acme/exec20",
    /sort/,
  );
});

test("resolveConfig: object-form provider sort with a documented mode and partition is accepted (#434 delta 8b3c0429)", async () => {
  const cfg = (await resolveWithConfig(
    [
      "executors:",
      "  openrouter-review:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    dialect: openrouter",
      "    params:",
      "      provider:",
      "        sort:",
      "          by: throughput",
      "          partition: model",
      "",
    ].join("\n"),
    "acme/exec21",
  )) as { executors: Record<string, { params?: { provider?: { sort?: { by?: string } } } }> };
  assert.equal(cfg.executors["openrouter-review"].params?.provider?.sort?.by, "throughput");
});

test("resolveConfig: headers declaring content-type is rejected at parse time (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3\n    headers:\n      content-type: "text/plain"\n`,
    "acme/exec17",
    /content-type/,
  );
});

test("resolveConfig: a literal and an env-referenced header are both accepted (#434)", async () => {
  const cfg = (await resolveWithConfig(
    [
      "executors:",
      "  openrouter-review:",
      "    type: model-endpoint",
      "    base_url: https://openrouter.ai/api/v1",
      "    model: openai/gpt-5",
      "    headers:",
      "      x-title: pipeline-eval",
      "      http-referer:",
      "        env: OPENROUTER_REFERER",
      "",
    ].join("\n"),
    "acme/exec18",
  )) as { executors: Record<string, { headers?: Record<string, unknown> }> };
  assert.equal(cfg.executors["openrouter-review"].headers?.["x-title"], "pipeline-eval");
  assert.deepEqual(cfg.executors["openrouter-review"].headers?.["http-referer"], { env: "OPENROUTER_REFERER" });
});

test("resolveConfig: structured_output enabled on dialect 'none' is rejected at parse time, naming the dialect (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3\n    dialect: none\n    structured_output: true\n`,
    "acme/exec19",
    /structured_output.*none|none.*structured_output/is,
  );
});

test("resolveConfig: reasoning.on_unsupported must be the literal 'record' (#434)", async () => {
  await expectInvalidConfig(
    `executors:\n  bad:\n    type: model-endpoint\n    base_url: http://localhost:11434/v1\n    model: llama3\n    reasoning:\n      effort: high\n      on_unsupported: ignore\n`,
    "acme/exec20",
    /on_unsupported/,
  );
});
