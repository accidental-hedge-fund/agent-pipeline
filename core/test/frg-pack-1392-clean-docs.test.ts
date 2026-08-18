// FRG pack-1392-tugboat-ship-1.39.2 clean-docs fixture (#1112).
// Reads only the run-scoped path and fails if release_version is not 1.39.2.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const RUN_SCOPED_RELATIVE =
  "./fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json";
const FIXTURE_PATH = fileURLToPath(new URL(RUN_SCOPED_RELATIVE, import.meta.url));

test("clean-docs fixture lives at the pack-1392-tugboat-ship-1.39.2 path and parses as JSON", () => {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  assert.equal(typeof parsed, "object");
  assert.ok(parsed !== null);
});

test("clean-docs fixture release_version is 1.39.2", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(fixture.release_version, "1.39.2");
});

test("clean-docs test does not read another pack-run fixture path", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const otherPackPaths = source.match(
    /fixtures\/frg\/(?!pack-1392-tugboat-ship-1\.39\.2)[^/"'\s]+/g,
  );
  assert.equal(otherPackPaths, null);
});
