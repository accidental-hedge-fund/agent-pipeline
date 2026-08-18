// Installed ship-composer default --skip-frg detection (#1127).
// Inspects source / fixtures only — no live pack, network, git, or ship.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  composerHasHardCodedDefaultSkipFrg,
  evaluateInstalledShipComposerSkipFrg,
} from "../scripts/ship-composer-skip-frg.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const LEGACY_SKIP_FRG_PLAYBOOK = [
  "#!/usr/bin/env bash",
  'HOST="${ENGINE_PROMOTE_HOST:-all}"',
  '"$PIPELINE" release "$version" --no-edit --skip-frg',
  '"$PIPELINE" engine-promote --for "$version" --host "$HOST" --skip-frg --json',
  "",
].join("\n");

const CURRENT_ESCAPE_ONLY = [
  "#!/usr/bin/env bash",
  "SKIP_FRG_ARGS=()",
  'if [[ "$SKIP_FRG" == "1" ]]; then',
  "  SKIP_FRG_ARGS=(--skip-frg)",
  "fi",
  '"$PIPELINE" release "$version" --no-edit "${SKIP_FRG_ARGS[@]}"',
  '"$PIPELINE" engine-promote --for "$version" --host "$HOST" "${SKIP_FRG_ARGS[@]}" --json',
  "",
].join("\n");

test("composerHasHardCodedDefaultSkipFrg: legacy default argv fails (#1127)", () => {
  assert.equal(composerHasHardCodedDefaultSkipFrg(LEGACY_SKIP_FRG_PLAYBOOK), true);
});

test("composerHasHardCodedDefaultSkipFrg: escape-only body passes (#1127)", () => {
  assert.equal(composerHasHardCodedDefaultSkipFrg(CURRENT_ESCAPE_ONLY), false);
});

test("evaluateInstalledShipComposerSkipFrg: old skip-frg playbook fails; current examples pass", () => {
  const failed = evaluateInstalledShipComposerSkipFrg([
    { path: "/home/op/.local/bin/pipeline-ship-playbook", body: LEGACY_SKIP_FRG_PLAYBOOK, kind: "playbook" },
  ]);
  assert.equal(failed.status, "fail");
  if (failed.status === "fail") {
    assert.match(failed.detail, /skip-frg/);
    assert.match(failed.remediation, /pipeline-ship-playbook\.sh|#1127/);
  }

  const tugboatFailed = evaluateInstalledShipComposerSkipFrg([
    { path: "/home/op/.local/bin/tugboat", body: LEGACY_SKIP_FRG_PLAYBOOK, kind: "tugboat" },
  ]);
  assert.equal(tugboatFailed.status, "fail");
  if (tugboatFailed.status === "fail") {
    assert.match(tugboatFailed.remediation, /tugboat\.sh/);
  }

  const tugboat = fs.readFileSync(
    path.join(repoRoot, "examples/supervisor/shell/tugboat.sh"),
    "utf8",
  );
  const playbook = fs.readFileSync(
    path.join(repoRoot, "examples/supervisor/shell/pipeline-ship-playbook.sh"),
    "utf8",
  );
  assert.equal(composerHasHardCodedDefaultSkipFrg(tugboat), false);
  assert.equal(composerHasHardCodedDefaultSkipFrg(playbook), false);
  const current = evaluateInstalledShipComposerSkipFrg([
    { path: "examples/supervisor/shell/tugboat.sh", body: tugboat, kind: "tugboat" },
    { path: "examples/supervisor/shell/pipeline-ship-playbook.sh", body: playbook, kind: "playbook" },
  ]);
  assert.equal(current.status, "pass");

  assert.equal(evaluateInstalledShipComposerSkipFrg([]).status, "skip");
  assert.equal(
    evaluateInstalledShipComposerSkipFrg([
      { path: "/missing/tugboat", body: null, kind: "tugboat" },
      { path: "/missing/playbook", body: null, kind: "playbook" },
    ]).status,
    "skip",
  );
});
