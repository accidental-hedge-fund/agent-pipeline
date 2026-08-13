// Unit tests for product-vs-scratch gate-trust classification (#873).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPorcelainForScratchRecover,
  classifyWorktreeDirt,
  ENGINE_NON_PRODUCT_SCRATCH_GLOBS,
  formatProductDirtDisclosure,
  isAlwaysProductPath,
  isNonProductScratchPath,
  isSafeScratchExtensionGlob,
  matchScratchGlob,
  parsePorcelainPaths,
  PRODUCT_PATH_CANARIES,
  productDirtyPaths,
} from "../scripts/worktree-dirt.ts";

test("classifier: empty paths → empty product and scratch", () => {
  const c = classifyWorktreeDirt([]);
  assert.deepEqual(c.product, []);
  assert.deepEqual(c.scratch, []);
});

test("classifier: scratch-only (tasks/todo.md + pipeline prompt) → no product dirt", () => {
  const paths = ["tasks/todo.md", ".pipeline-prompt-abc.txt"];
  const c = classifyWorktreeDirt(paths);
  assert.deepEqual(c.product, []);
  assert.deepEqual(c.scratch, paths);
  assert.deepEqual(productDirtyPaths(paths), []);
});

test("classifier: tasks/** planning tree is scratch (aligned with allowDirtyPattern)", () => {
  assert.equal(isNonProductScratchPath("tasks/lessons.md"), true);
  assert.equal(isNonProductScratchPath("tasks/notes/x.md"), true);
  assert.deepEqual(productDirtyPaths(["tasks/lessons.md", "tasks/todo.md"]), []);
});

test("classifier: product-only paths remain product dirt", () => {
  const paths = ["core/scripts/foo.ts", "plugin/scripts/foo.ts", "openspec/changes/x/proposal.md"];
  const c = classifyWorktreeDirt(paths);
  assert.deepEqual(c.product, paths);
  assert.deepEqual(c.scratch, []);
});

test("classifier: mixed scratch + product → product non-empty, scratch separated", () => {
  const c = classifyWorktreeDirt([
    "tasks/todo.md",
    "core/scripts/testgate.ts",
    ".pipeline-prompt-1.txt",
  ]);
  assert.deepEqual(c.product, ["core/scripts/testgate.ts"]);
  assert.deepEqual(c.scratch, ["tasks/todo.md", ".pipeline-prompt-1.txt"]);
});

test("classifier: lockfile basenames are NOT scratch (#722 orthogonality)", () => {
  for (const lock of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
    assert.equal(
      isNonProductScratchPath(lock),
      false,
      `${lock} must not be classified as ignorable scratch`,
    );
  }
  assert.deepEqual(
    productDirtyPaths(["package-lock.json", "tasks/todo.md"]),
    ["package-lock.json"],
  );
});

test("classifier: .pipeline-prompt-* only at worktree root", () => {
  assert.equal(isNonProductScratchPath(".pipeline-prompt-uuid.txt"), true);
  assert.equal(isNonProductScratchPath("nested/.pipeline-prompt-uuid.txt"), false);
  assert.equal(isNonProductScratchPath("core/.pipeline-prompt-x"), false);
});

test("classifier: extra globs are unioned with engine set (no replace)", () => {
  const extra = ["notes/**", "tmp/scratch.txt"];
  // Engine set still applies
  assert.equal(isNonProductScratchPath("tasks/todo.md", extra), true);
  // Extension applies
  assert.equal(isNonProductScratchPath("notes/agent.md", extra), true);
  assert.equal(isNonProductScratchPath("tmp/scratch.txt", extra), true);
  // Unrelated product still product
  assert.equal(isNonProductScratchPath("core/scripts/x.ts", extra), false);
  // Extension cannot remove engine coverage by omission — empty extra still engines
  assert.equal(isNonProductScratchPath("tasks/todo.md", []), true);
});

test("classifier (#873 review): unsafe extension globs cannot waive product dirt", () => {
  // Bites without isSafeScratchExtensionGlob: these would classify product as scratch.
  for (const bad of ["**", "core/**", "plugin/**", "openspec/**", "*"]) {
    assert.equal(
      isSafeScratchExtensionGlob(bad),
      false,
      `${bad} must be rejected as an unsafe scratch extension`,
    );
    assert.equal(
      isNonProductScratchPath("core/scripts/foo.ts", [bad]),
      false,
      `${bad} must not classify core/ as scratch`,
    );
    assert.equal(
      isNonProductScratchPath("plugin/scripts/foo.ts", [bad]),
      false,
      `${bad} must not classify plugin/ as scratch`,
    );
    assert.equal(
      isNonProductScratchPath("openspec/changes/x/proposal.md", [bad]),
      false,
      `${bad} must not classify openspec/ as scratch`,
    );
    // Product dirt list still non-empty under a hostile extension config
    assert.deepEqual(
      productDirtyPaths(
        ["core/scripts/foo.ts", "tasks/todo.md"],
        [bad],
      ),
      ["core/scripts/foo.ts"],
    );
  }
  // Narrow non-product namespace remains allowed
  assert.equal(isSafeScratchExtensionGlob("notes/**"), true);
  assert.equal(isNonProductScratchPath("notes/agent.md", ["notes/**"]), true);
  // Engine-known scratch still scratch even when unsafe globs are present
  assert.equal(isNonProductScratchPath("tasks/todo.md", ["**"]), true);
});

test("classifier (#873 review 2): targeted product/lockfile globs cannot waive product dirt", () => {
  // Canary-only validation missed exact product files and lockfiles that match
  // no sample canary. Both validation and classify-time hard exclusion must bite.
  const targeted = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "core/package.json",
    "plugin/SKILL.md",
    "openspec/specs/foo/spec.md",
    "package.json",
  ];
  for (const bad of targeted) {
    assert.equal(
      isSafeScratchExtensionGlob(bad),
      false,
      `${bad} must be rejected as an unsafe scratch extension`,
    );
  }
  // Classify-time: lockfile stays product even under a hostile exact-glob config
  assert.equal(isNonProductScratchPath("package-lock.json", ["package-lock.json"]), false);
  assert.deepEqual(
    productDirtyPaths(["package-lock.json", "tasks/todo.md"], ["package-lock.json"]),
    ["package-lock.json"],
  );
  // Nested product files cannot be waived
  assert.equal(isNonProductScratchPath("core/package.json", ["core/package.json"]), false);
  assert.equal(isNonProductScratchPath("plugin/SKILL.md", ["plugin/SKILL.md"]), false);
  assert.equal(
    isNonProductScratchPath("openspec/specs/foo/spec.md", ["openspec/specs/foo/spec.md"]),
    false,
  );
  // isAlwaysProductPath hard boundary covers product trees + lockfiles
  assert.equal(isAlwaysProductPath("core/scripts/any.ts"), true);
  assert.equal(isAlwaysProductPath("package-lock.json"), true);
  assert.equal(isAlwaysProductPath("pkg/yarn.lock"), true);
  assert.equal(isAlwaysProductPath("tasks/todo.md"), false);
  assert.equal(isAlwaysProductPath("notes/agent.md"), false);
});

test("PRODUCT_PATH_CANARIES cover required product trees", () => {
  assert.ok(PRODUCT_PATH_CANARIES.some((p) => p.startsWith("core/")));
  assert.ok(PRODUCT_PATH_CANARIES.some((p) => p.startsWith("plugin/")));
  assert.ok(PRODUCT_PATH_CANARIES.some((p) => p.startsWith("openspec/")));
  assert.ok(PRODUCT_PATH_CANARIES.includes("package-lock.json"));
  assert.ok(PRODUCT_PATH_CANARIES.includes("core/package.json"));
  assert.ok(PRODUCT_PATH_CANARIES.includes("plugin/SKILL.md"));
});

test("parsePorcelainPaths: strips status columns and keeps both rename endpoints", () => {
  const raw = [
    " M tasks/todo.md",
    "?? .pipeline-prompt-abc.txt",
    "R  old.ts -> core/scripts/new.ts",
    "",
    "?? package-lock.json",
  ].join("\n");
  assert.deepEqual(parsePorcelainPaths(raw), [
    "tasks/todo.md",
    ".pipeline-prompt-abc.txt",
    "old.ts",
    "core/scripts/new.ts",
    "package-lock.json",
  ]);
});

test("parsePorcelainPaths (#873 review 2): product→scratch rename keeps product source", () => {
  // Destination-only parsing would classify this as scratch-only and waive the gate.
  const raw = "R  core/scripts/foo.ts -> tasks/foo.ts\n";
  const paths = parsePorcelainPaths(raw);
  assert.deepEqual(paths, ["core/scripts/foo.ts", "tasks/foo.ts"]);
  const c = classifyWorktreeDirt(paths);
  assert.deepEqual(c.product, ["core/scripts/foo.ts"]);
  assert.deepEqual(c.scratch, ["tasks/foo.ts"]);
  assert.deepEqual(productDirtyPaths(paths), ["core/scripts/foo.ts"]);
});

test("parsePorcelainPaths (#873 review 2): scratch→scratch rename stays scratch-only", () => {
  const paths = parsePorcelainPaths("R  tasks/a.md -> tasks/b.md\n");
  assert.deepEqual(productDirtyPaths(paths), []);
  assert.deepEqual(classifyWorktreeDirt(paths).scratch, ["tasks/a.md", "tasks/b.md"]);
});

test("formatProductDirtDisclosure: empty → empty string; non-empty lists paths", () => {
  assert.equal(formatProductDirtDisclosure([]), "");
  const d = formatProductDirtDisclosure(["core/foo.ts", "plugin/bar.ts"]);
  assert.match(d, /Uncommitted paths:/);
  assert.match(d, /core\/foo\.ts/);
  assert.match(d, /plugin\/bar\.ts/);
  assert.doesNotMatch(d, /tasks\/todo/);
});

test("ENGINE_NON_PRODUCT_SCRATCH_GLOBS documents required engine set", () => {
  assert.ok(ENGINE_NON_PRODUCT_SCRATCH_GLOBS.includes("tasks/**"));
  assert.ok(ENGINE_NON_PRODUCT_SCRATCH_GLOBS.includes(".pipeline-prompt-*"));
  assert.ok(
    ENGINE_NON_PRODUCT_SCRATCH_GLOBS.includes("artifacts/challenge-response-*.json"),
    "engine set must include challenge-response dumps (#1013)",
  );
});

test("matchScratchGlob: prefix and star patterns", () => {
  assert.equal(matchScratchGlob("tasks/todo.md", "tasks/**"), true);
  assert.equal(matchScratchGlob("core/x.ts", "tasks/**"), false);
  assert.equal(matchScratchGlob(".pipeline-prompt-1.txt", ".pipeline-prompt-*"), true);
  assert.equal(matchScratchGlob("a/b", "a/*"), true);
  assert.equal(matchScratchGlob("a/b/c", "a/*"), false);
  assert.equal(matchScratchGlob("vendor/cache/x", "vendor/**"), true);
});

// ---------------------------------------------------------------------------
// #1013: challenge-response dumps are engine-known non-product scratch
// ---------------------------------------------------------------------------

test("classifier (#1013): challenge-response-only porcelain is scratch", () => {
  const paths = ["artifacts/challenge-response-1010.json"];
  const c = classifyWorktreeDirt(paths);
  assert.deepEqual(c.product, []);
  assert.deepEqual(c.scratch, paths);
  assert.deepEqual(productDirtyPaths(paths), []);
  assert.equal(isNonProductScratchPath("artifacts/challenge-response-1010.json"), true);
  assert.equal(isNonProductScratchPath("artifacts/challenge-response-42.json"), true);
});

test("classifier (#1013): challenge-response + product still product-blocks", () => {
  const c = classifyWorktreeDirt([
    "artifacts/challenge-response-1010.json",
    "core/scripts/foo.ts",
  ]);
  assert.deepEqual(c.product, ["core/scripts/foo.ts"]);
  assert.deepEqual(c.scratch, ["artifacts/challenge-response-1010.json"]);
  assert.deepEqual(
    productDirtyPaths([
      "artifacts/challenge-response-1010.json",
      "core/scripts/foo.ts",
    ]),
    ["core/scripts/foo.ts"],
  );
});

test("classifier (#1013): non-matching artifacts/ path remains product dirt", () => {
  // Narrow glob only — no blanket artifacts/** waiver.
  assert.equal(isNonProductScratchPath("artifacts/other-notes.md"), false);
  assert.equal(isNonProductScratchPath("artifacts/reports/pipeline-1.html"), false);
  assert.equal(
    isNonProductScratchPath("artifacts/nested/challenge-response-1.json"),
    false,
    "nested under artifacts/ must not match the single-segment engine glob",
  );
  assert.deepEqual(productDirtyPaths(["artifacts/other-notes.md"]), [
    "artifacts/other-notes.md",
  ]);
});

test("classifier (#1013, bites without new engine glob): legacy patterns alone do not match challenge-response", () => {
  // Without artifacts/challenge-response-*.json in the engine set, this path
  // would be product dirt. Legacy globs alone must not match it.
  const path = "artifacts/challenge-response-1010.json";
  assert.equal(matchScratchGlob(path, "tasks/**"), false);
  assert.equal(matchScratchGlob(path, ".pipeline-prompt-*"), false);
  assert.equal(
    matchScratchGlob(path, "artifacts/challenge-response-*.json"),
    true,
    "new engine glob must match the observed dump path",
  );
  // Engine set is load-bearing: path is scratch only because of the new glob.
  assert.ok(
    ENGINE_NON_PRODUCT_SCRATCH_GLOBS.includes("artifacts/challenge-response-*.json"),
  );
  assert.equal(isNonProductScratchPath(path), true);
});

test("matchScratchGlob (#1013): challenge-response pattern is narrow", () => {
  const pat = "artifacts/challenge-response-*.json";
  assert.equal(matchScratchGlob("artifacts/challenge-response-1010.json", pat), true);
  assert.equal(matchScratchGlob("artifacts/challenge-response-x.json", pat), true);
  assert.equal(matchScratchGlob("artifacts/challenge-response.json", pat), false);
  assert.equal(matchScratchGlob("artifacts/other.json", pat), false);
  assert.equal(matchScratchGlob("challenge-response-1.json", pat), false);
  assert.equal(matchScratchGlob("core/scripts/foo.ts", pat), false);
});

// ---------------------------------------------------------------------------
// #1020: porcelain classification for scratch recover (untracked-only)
// ---------------------------------------------------------------------------

test("classifyPorcelainForScratchRecover (#1020): untracked scratch only", () => {
  const c = classifyPorcelainForScratchRecover("?? artifacts/challenge-response-1.json\n");
  assert.deepEqual(c.product, []);
  assert.deepEqual(c.untrackedScratch, ["artifacts/challenge-response-1.json"]);
});

test("classifyPorcelainForScratchRecover (#1020): tracked scratch is product", () => {
  const c = classifyPorcelainForScratchRecover(" M artifacts/challenge-response-1.json\n");
  assert.deepEqual(c.untrackedScratch, []);
  assert.deepEqual(c.product, ["artifacts/challenge-response-1.json"]);
});

test("classifyPorcelainForScratchRecover (#1020): mixed product blocks", () => {
  const c = classifyPorcelainForScratchRecover(
    "?? artifacts/challenge-response-1.json\n M core/scripts/foo.ts\n",
  );
  assert.deepEqual(c.untrackedScratch, ["artifacts/challenge-response-1.json"]);
  assert.deepEqual(c.product, ["core/scripts/foo.ts"]);
});
