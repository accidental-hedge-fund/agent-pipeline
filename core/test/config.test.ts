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
import { DEFAULT_CONFIG } from "../scripts/types.ts";

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
    assert.deepEqual(cfg.harnesses, { implementer: "codex", reviewer: "claude" });
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

test("resolveConfig: models.review set + reviewer=codex warns it is inert", async () => {
  const repo = makeFakeRepo(`models:\n  review: opus\n`);
  const binDir = makeFakeGh("acme/im1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const warnings = await captureWarnings(() => {
      // claude profile → reviewer=codex
      cfgMod.resolveConfig({ repoPath: repo, profile: "claude" });
    });
    const hit = warnings.find((w) => w.includes("models.review"));
    assert.ok(hit, `expected a warning for models.review, got: ${JSON.stringify(warnings)}`);
    assert.match(hit!, /opus/);
    assert.match(hit!, /codex/);
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
