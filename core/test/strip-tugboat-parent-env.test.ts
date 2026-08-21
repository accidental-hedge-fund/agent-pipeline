// Isolation for Tugboat parent skip-train env leaked into `npm test` (#1188).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripTugboatParentEnv,
  TUGBOAT_PARENT_CONTROL_KEYS,
} from "./strip-tugboat-parent-env.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("stripTugboatParentEnv deletes inherited skip-train keys (#1188)", () => {
  const env: NodeJS.ProcessEnv = {
    TUGBOAT_SKIP_TRAIN: "1",
    TUGBOAT_CANDIDATE_COMPOSER: "deadbeef",
    PATH: "/bin",
    HOME: "/tmp",
  };
  stripTugboatParentEnv(env);
  assert.equal(env.TUGBOAT_SKIP_TRAIN, undefined);
  assert.equal(env.TUGBOAT_CANDIDATE_COMPOSER, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp");
  assert.deepEqual([...TUGBOAT_PARENT_CONTROL_KEYS], [
    "TUGBOAT_SKIP_TRAIN",
    "TUGBOAT_CANDIDATE_COMPOSER",
  ]);
});

test("tugboat.test.ts strips parent skip-train at load (#1188)", () => {
  const body = fs.readFileSync(path.join(here, "tugboat.test.ts"), "utf8");
  assert.match(body, /from "\.\/strip-tugboat-parent-env\.ts"/);
  assert.match(body, /stripTugboatParentEnv\(/);
});
