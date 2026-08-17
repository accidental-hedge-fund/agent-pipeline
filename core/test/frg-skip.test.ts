// Shared FRG skip resolver (#1092). Pure: no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFrgSkipReason, resolveFrgSkip } from "../scripts/frg-skip.ts";

test("resolveFrgSkip: unset config and no CLI flag does not skip", () => {
  assert.deepEqual(resolveFrgSkip({}), { skip: false, source: null });
  assert.deepEqual(resolveFrgSkip({ cliSkip: false }), { skip: false, source: null });
  assert.deepEqual(resolveFrgSkip({ configSkip: false }), { skip: false, source: null });
  assert.deepEqual(resolveFrgSkip({ cliSkip: false, configSkip: false }), {
    skip: false,
    source: null,
  });
});

test("resolveFrgSkip: config true skips with source config", () => {
  assert.deepEqual(resolveFrgSkip({ configSkip: true }), { skip: true, source: "config" });
  assert.deepEqual(resolveFrgSkip({ cliSkip: false, configSkip: true }), {
    skip: true,
    source: "config",
  });
});

test("resolveFrgSkip: CLI flag skips with source cli even when config is false", () => {
  assert.deepEqual(resolveFrgSkip({ cliSkip: true }), { skip: true, source: "cli" });
  assert.deepEqual(resolveFrgSkip({ cliSkip: true, configSkip: false }), {
    skip: true,
    source: "cli",
  });
  assert.deepEqual(resolveFrgSkip({ cliSkip: true, configSkip: undefined }), {
    skip: true,
    source: "cli",
  });
});

test("resolveFrgSkip: CLI flag wins when config is also true", () => {
  assert.deepEqual(resolveFrgSkip({ cliSkip: true, configSkip: true }), {
    skip: true,
    source: "cli",
  });
});

test("formatFrgSkipReason: CLI names the flag; config names the yml key", () => {
  assert.equal(formatFrgSkipReason("cli"), "--skip-frg");
  assert.equal(formatFrgSkipReason("config"), "skip_frg: true in .github/pipeline.yml");
});
