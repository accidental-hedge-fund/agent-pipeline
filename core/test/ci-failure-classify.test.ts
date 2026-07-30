// Pure CI failure classification (#679). No network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCiFailure,
  classifySingleCheck,
} from "../scripts/ci-failure-classify.ts";
import type { CheckRun } from "../scripts/types.ts";

function check(partial: Partial<CheckRun> & { name: string }): CheckRun {
  return {
    bucket: "fail",
    state: "FAILURE",
    ...partial,
  };
}

test("infra signature: IPC deserialize classifies as infra", () => {
  const failed = [check({ name: "test" })];
  const cls = classifyCiFailure({
    failed,
    logExcerpt:
      "Unable to deserialize cloned data due to invalid or unsupported version",
  });
  assert.equal(cls, "infra");
});

test("infra signature: cancel bucket classifies as infra", () => {
  assert.equal(
    classifySingleCheck(check({ name: "ci", bucket: "cancel" })),
    "infra",
  );
});

test("infra signature: OOM in log classifies as infra", () => {
  assert.equal(
    classifyCiFailure({
      failed: [check({ name: "build" })],
      logExcerpt: "Killed process ... out of memory",
    }),
    "infra",
  );
});

test("assertion output classifies as assertion", () => {
  assert.equal(
    classifyCiFailure({
      failed: [check({ name: "test" })],
      logExcerpt: "AssertionError: expected 1 to equal 2\n    at Object.<anonymous>",
    }),
    "assertion",
  );
});

test("assertion: TypeScript assignability error classifies as assertion", () => {
  assert.equal(
    classifyCiFailure({
      failed: [check({ name: "typecheck" })],
      logExcerpt: "error TS2322: Type 'string' is not assignable to type 'number'",
    }),
    "assertion",
  );
});

test("no confident match classifies as unknown", () => {
  assert.equal(
    classifyCiFailure({
      failed: [check({ name: "mystery-job" })],
      logExcerpt: "something went sideways in the void",
    }),
    "unknown",
  );
});

test("mixed assertion and infra prefers assertion", () => {
  const cls = classifyCiFailure({
    failed: [
      check({
        name: "flake",
        description: "Unable to deserialize cloned data",
      }),
      check({
        name: "unit",
        description: "AssertionError: expected true to be false",
      }),
    ],
  });
  assert.equal(cls, "assertion");
});

test("empty failed set is unknown", () => {
  assert.equal(classifyCiFailure({ failed: [] }), "unknown");
});

test("extract: bare check name without log stays unknown (not forced assertion)", () => {
  // Guard against over-broad signatures that would classify every red job as product.
  assert.equal(
    classifyCiFailure({ failed: [check({ name: "test" })] }),
    "unknown",
  );
});
