// Ship-end identity helper (#1151). Injected strings/digests/SHA only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPlaybookBody,
  contentDigest,
  evaluateShipEndIdentity,
  formatPipelineVersionJson,
  isThinPlaybookLauncher,
  parseExactGitSha,
  STALE_PLAYBOOK_DIGEST_PREFIX,
} from "../scripts/ship-end-identity.ts";

const C = "c".repeat(40);
const PIN = "a".repeat(40);
const LAUNCHER = [
  "#!/usr/bin/env bash",
  "# thin launcher",
  'exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"',
  "",
].join("\n");

const STALE_FULL = [
  "#!/usr/bin/env bash",
  'PIPELINE="${PIPELINE:-pipeline}"',
  '"$PIPELINE" train --milestone "v$version" --merge --json',
  '"$PIPELINE" factory-release prepare --request "$req" --json',
  '"$PIPELINE" release "$version" --no-edit',
  'HOST="${ENGINE_PROMOTE_HOST:-all}"',
  "",
].join("\n");

test("parseExactGitSha accepts only 40-hex and never invents", () => {
  assert.equal(parseExactGitSha(C), C);
  assert.equal(parseExactGitSha(C.toUpperCase()), C);
  assert.equal(parseExactGitSha("abc"), null);
  assert.equal(parseExactGitSha(C.slice(0, 7)), null);
  assert.equal(parseExactGitSha(null), null);
  assert.equal(parseExactGitSha(""), null);
  assert.equal(parseExactGitSha("  " + C + "  "), C);
});

test("formatPipelineVersionJson emits null commit_sha when unresolvable", () => {
  assert.equal(
    formatPipelineVersionJson("1.39.5", C).trim(),
    JSON.stringify({ version: "1.39.5", commit_sha: C }),
  );
  assert.equal(
    formatPipelineVersionJson("1.39.5", null).trim(),
    JSON.stringify({ version: "1.39.5", commit_sha: null }),
  );
  assert.equal(
    formatPipelineVersionJson("1.39.5", "deadbeef").trim(),
    JSON.stringify({ version: "1.39.5", commit_sha: null }),
  );
});

test("thin launcher classifier requires exec of repo tugboat.sh", () => {
  assert.equal(isThinPlaybookLauncher(LAUNCHER), true);
  assert.equal(classifyPlaybookBody(LAUNCHER), "playbook-launcher");
  assert.equal(
    classifyPlaybookBody("# mentions $REPO_DIR/examples/supervisor/shell/tugboat.sh\n"),
    "playbook-stale",
  );
  assert.equal(classifyPlaybookBody(STALE_FULL), "playbook-stale");
  assert.equal(classifyPlaybookBody(null), "unused");
});

test("thin launcher classifier rejects pre-exec pinned release plus tugboat exec", () => {
  const pinnedThenExec = [
    "#!/usr/bin/env bash",
    '"$PIPELINE" release 1.39.5',
    'exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"',
    "",
  ].join("\n");
  assert.equal(isThinPlaybookLauncher(pinnedThenExec), false);
  assert.equal(classifyPlaybookBody(pinnedThenExec), "playbook-stale");
});

test("thin launcher classifier rejects exec embedded in divergent shell", () => {
  const embedded = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    '~/.local/bin/pipeline ship --milestone "$1"',
    'exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"',
    "echo leftover",
    "",
  ].join("\n");
  assert.equal(isThinPlaybookLauncher(embedded), false);
  assert.equal(classifyPlaybookBody(embedded), "playbook-stale");
});

test("thin launcher classifier rejects bash -c shebang preamble plus tugboat exec", () => {
  const envDashS = [
    `#!/usr/bin/env -S bash -c '"$PIPELINE" release 1.39.5; exec bash "$0"'`,
    'exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"',
    "",
  ].join("\n");
  const bashDashC = [
    `#!/bin/bash -c '"$PIPELINE" release 1.39.5; exec bash "$0"'`,
    'exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"',
    "",
  ].join("\n");
  assert.equal(isThinPlaybookLauncher(envDashS), false);
  assert.equal(classifyPlaybookBody(envDashS), "playbook-stale");
  assert.equal(isThinPlaybookLauncher(bashDashC), false);
  assert.equal(classifyPlaybookBody(bashDashC), "playbook-stale");
});

test("classifyPlaybookBody: unused is absence only; unrecognized installed bodies are stale", () => {
  const divergent = [
    "#!/bin/zsh",
    "set -e",
    '~/.local/bin/pipeline ship --milestone "$1"',
    "",
  ].join("\n");
  assert.equal(classifyPlaybookBody(divergent), "playbook-stale");
  assert.equal(classifyPlaybookBody("echo not a launcher\n"), "playbook-stale");
  assert.equal(classifyPlaybookBody(null), "unused");
});

test("identity helper fails pin 1.39.4 SHA vs candidate C even when version is forged 1.39.5", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: PIN,
    invokedVersion: "1.39.5",
    composerKind: "tugboat-repo",
    selectedPlaybookKind: "unused",
  });
  assert.equal(r.status, "fail");
  if (r.status === "fail") {
    assert.match(r.detail, /does not equal candidate SHA/);
    assert.match(r.detail, /package version 1\.39\.5 is not identity/);
    assert.match(r.remediation, /candidate engine|FRG-bound/);
  }
});

test("identity helper fails matching version with mismatched SHA", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: PIN,
    invokedVersion: "1.39.5",
    composerKind: "in-engine-ship",
  });
  assert.equal(r.status, "fail");
});

test("identity helper fails null invoked SHA while tools are in use and SHA is bound", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: null,
    invokedVersion: "1.39.5",
    composerKind: "tugboat-repo",
  });
  assert.equal(r.status, "fail");
  if (r.status === "fail") {
    assert.match(r.detail, /null/);
  }
});

test("identity helper fails selected stale full playbook including 2afe3c92 prefix", () => {
  const digest = contentDigest(STALE_FULL);
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: C,
    composerKind: "playbook-stale",
    selectedPlaybookKind: "playbook-stale",
  });
  assert.equal(r.status, "fail");
  if (r.status === "fail") {
    assert.match(r.detail, /thin launcher/);
    assert.match(r.remediation, /pipeline-ship-playbook\.sh|tugboat\.sh/);
  }
  const prefixed = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: C,
    composerKind: "playbook-stale",
    selectedPlaybookKind: "playbook-stale",
    resolvedTugboatDigest: STALE_PLAYBOOK_DIGEST_PREFIX + "0".repeat(56),
    candidateTugboatDigest: "9b8063d1" + "0".repeat(56),
  });
  assert.equal(prefixed.status, "fail");
  assert.equal(digest.length, 64);
});

test("identity helper fails injected stale digest 2afe3c92 vs candidate tugboat 9b8063d1", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: C,
    composerKind: "tugboat-repo",
    selectedPlaybookKind: "playbook-stale",
    resolvedTugboatDigest: STALE_PLAYBOOK_DIGEST_PREFIX + "ff".repeat(28),
    candidateTugboatDigest: "9b8063d1" + "aa".repeat(28),
  });
  assert.equal(r.status, "fail");
  if (r.status === "fail") {
    assert.match(r.remediation, /tugboat\.sh|pipeline-ship-playbook\.sh/);
  }
});

test("identity helper passes matching candidate SHA with thin launcher", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: C,
    invokedVersion: "1.39.5",
    composerKind: "playbook-launcher",
    selectedPlaybookKind: "playbook-launcher",
  });
  assert.equal(r.status, "pass");
});

test("identity helper passes repo-script composer (tugboat-repo)", () => {
  const tug = "canonical tugboat body\n";
  const digest = contentDigest(tug);
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: C,
    composerKind: "tugboat-repo",
    selectedPlaybookKind: "unused",
    resolvedTugboatDigest: digest,
    candidateTugboatDigest: digest,
  });
  assert.equal(r.status, "pass");
});

test("identity helper skips when unused tools", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: false,
    candidateSha: C,
    invokedCommitSha: PIN,
    composerKind: "unused",
    selectedPlaybookKind: "unused",
  });
  assert.equal(r.status, "skip");
});

test("identity helper without bound SHA still fails selected stale playbook", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: null,
    invokedCommitSha: null,
    composerKind: "playbook-stale",
    selectedPlaybookKind: "playbook-stale",
  });
  assert.equal(r.status, "fail");
});

test("identity helper without bound SHA passes launcher / unused playbook", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: null,
    invokedCommitSha: null,
    composerKind: "tugboat-repo",
    selectedPlaybookKind: "unused",
  });
  assert.equal(r.status, "pass");
});

test("identity helper fails selected unrecognized non-launcher playbook", () => {
  const r = evaluateShipEndIdentity({
    shipEndToolsInUse: true,
    candidateSha: C,
    invokedCommitSha: C,
    composerKind: "playbook-stale",
    selectedPlaybookKind: "playbook-stale",
  });
  assert.equal(r.status, "fail");
  if (r.status === "fail") {
    assert.match(r.detail, /thin launcher/);
    assert.match(r.remediation, /pipeline-ship-playbook\.sh|tugboat\.sh/);
  }
});
