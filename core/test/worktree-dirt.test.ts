// Unit tests for product-vs-scratch gate-trust classification (#873).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorktreeDirt,
  ENGINE_NON_PRODUCT_SCRATCH_GLOBS,
  formatProductDirtDisclosure,
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

test("PRODUCT_PATH_CANARIES cover required product trees", () => {
  assert.ok(PRODUCT_PATH_CANARIES.some((p) => p.startsWith("core/")));
  assert.ok(PRODUCT_PATH_CANARIES.some((p) => p.startsWith("plugin/")));
  assert.ok(PRODUCT_PATH_CANARIES.some((p) => p.startsWith("openspec/")));
});

test("parsePorcelainPaths: strips status columns and handles renames", () => {
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
    "core/scripts/new.ts",
    "package-lock.json",
  ]);
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
});

test("matchScratchGlob: prefix and star patterns", () => {
  assert.equal(matchScratchGlob("tasks/todo.md", "tasks/**"), true);
  assert.equal(matchScratchGlob("core/x.ts", "tasks/**"), false);
  assert.equal(matchScratchGlob(".pipeline-prompt-1.txt", ".pipeline-prompt-*"), true);
  assert.equal(matchScratchGlob("a/b", "a/*"), true);
  assert.equal(matchScratchGlob("a/b/c", "a/*"), false);
  assert.equal(matchScratchGlob("vendor/cache/x", "vendor/**"), true);
});
