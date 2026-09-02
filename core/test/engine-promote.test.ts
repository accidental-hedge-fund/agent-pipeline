// Tests for pipeline engine-promote (Phase 4). No network/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateInstalledShipPlaybookPromoteHost,
  shipPlaybookHasAllPromoteDefault,
  shipPlaybookHasLegacyCodexOnlyPromoteDefault,
} from "../scripts/ship-playbook-promote-host.ts";
import {
  DEFAULT_ENGINE_PROMOTE_HOST,
  installArgsForTag,
  installCommandForTag,
  matchingLiveDigestForHosts,
  requirePeeledOid,
  resolvePeeledPromoteGitSha,
  runEnginePromote,
  selectedPromoteHosts,
  startingLockPidFromEnv,
  tagForVersion,
  type EnginePromoteDeps,
  type EnginePromoteHost,
  type EnginePromoteOpts,
} from "../scripts/stages/engine-promote.ts";
import type { ProductionEnginePin, PromotePinResult } from "../scripts/production-engine-pin.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function pin(v: string, prev?: string): ProductionEnginePin {
  const p: ProductionEnginePin = {
    schema_version: 1,
    version: v,
    tag: `v${v}`,
    frg_run_id: `frg-${v}`,
    frg_evidence_path: `.agent-pipeline/frg/${v}/latest.json`,
    promoted_at: "2026-08-09T00:00:00.000Z",
  };
  if (prev) {
    p.previous = {
      schema_version: 1,
      version: prev,
      tag: `v${prev}`,
      frg_run_id: `frg-${prev}`,
      promoted_at: "2026-08-01T00:00:00.000Z",
    };
  }
  return p;
}

function makeDeps(over: Partial<EnginePromoteDeps> = {}): EnginePromoteDeps & {
  installs: string[];
  installHosts: EnginePromoteHost[];
  promotes: number;
  rollbacks: number;
} {
  const installs: string[] = [];
  const installHosts: EnginePromoteHost[] = [];
  let promotes = 0;
  let rollbacks = 0;
  let current: ProductionEnginePin | null = pin("1.31.1");
  const base: EnginePromoteDeps = {
    log() {},
    async verifyPublishedRelease() {
      return { ok: true };
    },
    async promote({ version, gitSha }) {
      promotes += 1;
      current = pin(version, current?.version);
      if (gitSha && String(gitSha).trim()) current.git_sha = String(gitSha).trim();
      return { ok: true, pin: current, path: "/pin.json", reinstall_hint: `npx #v${version}` };
    },
    async rollback() {
      rollbacks += 1;
      if (!current?.previous) {
        return { ok: false, code: "no_previous", message: "no previous" } as PromotePinResult;
      }
      current = pin(current.previous.version);
      return { ok: true, pin: current, path: "/pin.json", reinstall_hint: `npx #${current.tag}` };
    },
    async loadPin() {
      if (!current) return { kind: "missing", path: "/pin.json" };
      return { kind: "ok", pin: current, path: "/pin.json" };
    },
    async installFromTag(tag, host) {
      installs.push(tag);
      installHosts.push(host);
      return { command: installCommandForTag(tag, host), stdout: "ok" };
    },
    async installedVersion() {
      const last = installs[installs.length - 1];
      return last ? last.replace(/^v/, "") : current?.version ?? null;
    },
    async installedDigest(_host) {
      return current?.git_sha ?? "b".repeat(40);
    },
    async resolvePromoteGitSha() {
      return "b".repeat(40);
    },
    async listRemainingOpenMilestoneIssues() {
      return [];
    },
    ...over,
  };
  return Object.assign(base, {
    installs,
    installHosts,
    get promotes() {
      return promotes;
    },
    get rollbacks() {
      return rollbacks;
    },
  });
}

const opts = (over: Partial<EnginePromoteOpts> = {}): EnginePromoteOpts => ({
  version: "1.34.0",
  repoDir: "/repo",
  host: "codex",
  ...over,
});

test("tagForVersion and installCommandForTag", () => {
  assert.equal(tagForVersion("1.2.3"), "v1.2.3");
  assert.equal(tagForVersion("v1.2.3"), "v1.2.3");
  assert.match(installCommandForTag("v1.2.3", "codex"), /#v1\.2\.3 install --host codex/);
  assert.match(installCommandForTag("v1.2.3", "all"), /#v1\.2\.3 install --host all/);
  assert.match(installCommandForTag("v1.2.3", "omp"), /#v1\.2\.3 install --host omp/);
  assert.equal(DEFAULT_ENGINE_PROMOTE_HOST, "all");
});

test("engine-promote leftover open issue fails closed before install (#1354)", async () => {
  const deps = makeDeps({
    listRemainingOpenMilestoneIssues: async (milestone) => {
      assert.equal(milestone, "v1.34.0");
      return [1344];
    },
  });
  await assert.rejects(
    () => runEnginePromote(opts(), deps),
    /milestone v1\.34\.0 still has open issues: #1344/,
  );
  assert.equal(deps.promotes, 0);
  assert.deepEqual(deps.installs, []);
});

test("engine-promote missing remaining-open observation fails closed (#1354)", async () => {
  const deps = makeDeps();
  delete (deps as { listRemainingOpenMilestoneIssues?: unknown }).listRemainingOpenMilestoneIssues;
  await assert.rejects(
    () => runEnginePromote(opts(), deps),
    /remaining-open observation is required/,
  );
  assert.equal(deps.promotes, 0);
});

test("engine-promote: omitted host defaults to all (not silent codex) (#989)", async () => {
  const deps = makeDeps();
  const result = await runEnginePromote(
    { version: "1.34.0", repoDir: "/repo", dryRun: true },
    deps,
  );
  assert.equal(result.error, undefined);
  assert.match(result.install_command, /--host all\b/);
  assert.doesNotMatch(result.install_command, /--host codex\b/);
  assert.ok(result.steps.some((s) => s.includes("would_install:") && s.includes("--host all")));
});

test("engine-promote: explicit single-host override is preserved (#989)", async () => {
  const deps = makeDeps();
  const result = await runEnginePromote(opts({ host: "claude" }), deps);
  assert.equal(result.error, undefined);
  assert.match(result.install_command, /--host claude\b/);
  assert.doesNotMatch(result.install_command, /--host all\b/);
  assert.deepEqual(deps.installHosts, ["claude"]);
});

test("engine-promote: explicit --host codex stays scoped (#989)", async () => {
  const deps = makeDeps();
  const result = await runEnginePromote(opts({ host: "codex", dryRun: true }), deps);
  assert.match(result.install_command, /--host codex\b/);
  assert.doesNotMatch(result.install_command, /--host all\b/);
});

test("engine-promote: explicit --host omp stays scoped (#1235)", async () => {
  const deps = makeDeps();
  const result = await runEnginePromote(opts({ host: "omp", dryRun: true }), deps);
  assert.match(result.install_command, /--host omp\b/);
  assert.doesNotMatch(result.install_command, /--host all\b/);
  assert.deepEqual(deps.installHosts, []);
});

test("ship playbook: thin launcher skips promote-host check; Tugboat defaults to all (#989 / #1151)", () => {
  const playbook = path.join(
    repoRoot,
    "examples/supervisor/shell/pipeline-ship-playbook.sh",
  );
  const tugboat = path.join(repoRoot, "examples/supervisor/shell/tugboat.sh");
  assert.ok(fs.existsSync(playbook), "missing pipeline-ship-playbook.sh");
  const body = fs.readFileSync(playbook, "utf8");
  assert.match(body, /exec "\$REPO_DIR\/examples\/supervisor\/shell\/tugboat\.sh" "\$@"/);
  assert.equal(evaluateInstalledShipPlaybookPromoteHost(body).status, "skip");
  const tug = fs.readFileSync(tugboat, "utf8");
  assert.match(tug, /ENGINE_PROMOTE_HOST:-all/);
  assert.doesNotMatch(tug, /ENGINE_PROMOTE_HOST:-codex/);
});

test("legacy installed ship playbook: codex-only default fails rollout preflight (#989)", () => {
  // Fixture of the already-installed ~/.local/bin shape that triggered the incident:
  // unset ENGINE_PROMOTE_HOST expands to codex and is forwarded as --host codex.
  const legacy = [
    '#!/usr/bin/env bash',
    'HOST="${ENGINE_PROMOTE_HOST:-codex}"',
    '"$PIPELINE" engine-promote --for "$version" --host "$HOST" --skip-frg --json',
    "",
  ].join("\n");
  assert.equal(shipPlaybookHasLegacyCodexOnlyPromoteDefault(legacy), true);
  assert.equal(shipPlaybookHasAllPromoteDefault(legacy), false);

  const blocked = evaluateInstalledShipPlaybookPromoteHost(legacy, {
    pathLabel: "/home/op/.local/bin/pipeline-ship-playbook",
  });
  assert.equal(blocked.status, "fail");
  if (blocked.status === "fail") {
    assert.match(blocked.detail, /codex/i);
    assert.match(blocked.remediation, /ENGINE_PROMOTE_HOST=all|install -m 0755|REPO_DIR/i);
  }

  // Explicit override still honors operator intent (including multi-host rollout).
  const withAll = evaluateInstalledShipPlaybookPromoteHost(legacy, {
    enginePromoteHostEnv: "all",
  });
  assert.equal(withAll.status, "pass");

  // Current repo playbook is a launcher — promote-host check skips (not a full playbook).
  const current = fs.readFileSync(
    path.join(repoRoot, "examples/supervisor/shell/pipeline-ship-playbook.sh"),
    "utf8",
  );
  assert.equal(evaluateInstalledShipPlaybookPromoteHost(current).status, "skip");

  // Missing install is skip, not fail (hosts without the chain playbook).
  assert.equal(evaluateInstalledShipPlaybookPromoteHost(null).status, "skip");
});

test("engine-promote: nested installer exempts only the launcher reservation passed by the shim", () => {
  assert.equal(startingLockPidFromEnv(undefined), null);
  assert.equal(startingLockPidFromEnv(""), null);
  assert.equal(startingLockPidFromEnv("12x"), null);
  assert.equal(startingLockPidFromEnv("12345"), 12345);
  assert.deepEqual(installArgsForTag("v1.2.3", "codex", 12345), [
    "-y",
    "github:accidental-hedge-fund/agent-pipeline#v1.2.3",
    "install",
    "--host",
    "codex",
    "--yes-deps",
    "--internal-starting-lock-pid",
    "12345",
  ]);
  assert.deepEqual(installArgsForTag("v1.2.3", "codex"), [
    "-y",
    "github:accidental-hedge-fund/agent-pipeline#v1.2.3",
    "install",
    "--host",
    "codex",
    "--yes-deps",
  ]);
  assert.match(
    installCommandForTag("v1.2.3", "codex", 12345),
    /--yes-deps --internal-starting-lock-pid 12345$/,
  );
});

test("engine-promote: happy path promotes, installs, verifies", async () => {
  const deps = makeDeps();
  const result = await runEnginePromote(opts(), deps);
  assert.equal(result.error, undefined);
  assert.equal(result.release_verified, true);
  assert.equal(result.pin_promoted, true);
  assert.equal(result.install_ran, true);
  assert.equal(result.verified, true);
  assert.deepEqual(deps.installs, ["v1.34.0"]);
  assert.ok(result.pin?.version === "1.34.0");
});

test("engine-promote: dry-run does not mutate", async () => {
  const deps = makeDeps();
  const result = await runEnginePromote(opts({ dryRun: true }), deps);
  assert.equal(result.dry_run, true);
  assert.equal(result.pin_promoted, false);
  assert.equal(result.install_ran, false);
  assert.equal(deps.promotes, 0);
  assert.equal(deps.installs.length, 0);
  assert.ok(result.steps.some((s) => s.startsWith("would_")));
});

test("engine-promote: missing release fails closed", async () => {
  const deps = makeDeps({
    async verifyPublishedRelease() {
      return { ok: false, error: "not found" };
    },
  });
  const result = await runEnginePromote(opts(), deps);
  assert.ok(result.error);
  assert.equal(deps.promotes, 0);
  assert.equal(deps.installs.length, 0);
});

test("engine-promote: install failure does not roll back pin (#1331)", async () => {
  const deps = makeDeps({
    async installFromTag(tag) {
      if (tag === "v1.34.0") throw new Error("npx failed");
      return { command: "ok", stdout: "" };
    },
    async installedVersion() {
      return "1.31.1";
    },
  });
  const installs: string[] = [];
  const orig = deps.installFromTag;
  deps.installFromTag = async (tag, host) => {
    installs.push(tag);
    return orig(tag, host);
  };
  const result = await runEnginePromote(opts(), deps);
  assert.ok(result.error?.includes("install failed"));
  assert.equal(result.rolled_back, false);
  assert.equal(deps.rollbacks, 0);
  assert.ok(installs.includes("v1.34.0"));
  assert.ok(!installs.includes("v1.31.1"));
  assert.ok(result.steps.some((s) => s.includes("rollback_not_granted")));
});

test("engine-promote: matching version with wrong digest does not complete (#1331)", async () => {
  const authorized = "b".repeat(40);
  const deps = makeDeps({
    async installedVersion() {
      return "1.34.0";
    },
    async installedDigest(_host) {
      return "c".repeat(40);
    },
    async resolvePromoteGitSha() {
      return authorized;
    },
  });
  const result = await runEnginePromote(opts(), deps);
  assert.equal(result.verified, false);
  assert.match(result.error ?? "", /live digest/);
  assert.equal(result.rolled_back, false);
  assert.equal(deps.rollbacks, 0);
  assert.ok(result.pin?.git_sha === authorized);
});

test("engine-promote: matching digest completes deployment (#1331)", async () => {
  const digest = "b".repeat(40);
  const deps = makeDeps({
    async installedDigest() {
      return digest;
    },
  });
  const result = await runEnginePromote(opts(), deps);
  assert.equal(result.verified, true);
  assert.equal(result.error, undefined);
  assert.ok(result.steps.some((s) => s.startsWith("verified_digest:")));
});

test("engine-promote: wrong host digest does not complete (#1331)", async () => {
  const authorized = "b".repeat(40);
  const deps = makeDeps({
    async installedDigest(host) {
      if (host === "claude") return "c".repeat(40);
      return authorized;
    },
  });
  const result = await runEnginePromote(opts({ host: "all" }), deps);
  assert.equal(result.verified, false);
  assert.match(result.error ?? "", /host claude/);
  assert.equal(result.rolled_back, false);
  assert.equal(deps.rollbacks, 0);
});

test("selectedPromoteHosts expands all to every builtin host (#1331)", () => {
  assert.deepEqual(selectedPromoteHosts("codex"), ["codex"]);
  assert.ok(selectedPromoteHosts("all").includes("claude"));
  assert.ok(selectedPromoteHosts("all").includes("codex"));
});

test("matchingLiveDigestForHosts refuses a mismatched selected host (#1331)", () => {
  const authorized = "b".repeat(40);
  const result = matchingLiveDigestForHosts(
    [
      { host: "codex", digest: authorized },
      { host: "claude", digest: "c".repeat(40) },
    ],
    authorized,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /host claude/);
});

test("engine-promote: skip install when pin already current", async () => {
  const deps = makeDeps({
    async loadPin() {
      return { kind: "ok", pin: pin("1.34.0"), path: "/p" };
    },
  });
  const result = await runEnginePromote(opts({ skipInstall: true }), deps);
  assert.equal(result.pin_promoted, false);
  assert.equal(result.install_ran, false);
  assert.ok(result.steps.some((s) => s.includes("pin_already_current")));
});

test("engine-promote: same-version no-frg pin is not already-current without skip (#1041)", async () => {
  const noFrg: ProductionEnginePin = {
    schema_version: 1,
    version: "1.34.0",
    tag: "v1.34.0",
    frg_run_id: "no-frg-1.34.0",
    frg_evidence_path: null,
    promoted_at: "2026-08-09T00:00:00.000Z",
  };
  let promoteCalls = 0;
  let seenAllow: boolean | undefined;
  const deps = makeDeps({
    async loadPin() {
      return { kind: "ok", pin: noFrg, path: "/p" };
    },
    async promote({ allowWithoutFrg }) {
      promoteCalls += 1;
      seenAllow = allowWithoutFrg;
      if (!allowWithoutFrg) {
        return { ok: false, code: "missing_frg", message: "FRG pass missing for 1.34.0" };
      }
      return { ok: true, pin: pin("1.34.0"), path: "/pin.json", reinstall_hint: "npx #v1.34.0" };
    },
    readSkipFrg: () => false,
  });
  const result = await runEnginePromote(opts({ skipInstall: true }), deps);
  assert.equal(promoteCalls, 1);
  assert.equal(seenAllow, false);
  assert.ok(!result.steps.some((s) => s.includes("pin_already_current")));
  assert.match(result.error ?? "", /FRG pass missing/);
  assert.equal(result.pin_promoted, false);
});

test("engine-promote: same-version no-frg re-promotes from real FRG (#1041)", async () => {
  const noFrg: ProductionEnginePin = {
    schema_version: 1,
    version: "1.34.0",
    tag: "v1.34.0",
    frg_run_id: "no-frg-1.34.0",
    frg_evidence_path: null,
    promoted_at: "2026-08-09T00:00:00.000Z",
  };
  const promoted = pin("1.34.0");
  promoted.frg_run_id = "frg-abc";
  let promoteCalls = 0;
  const deps = makeDeps({
    async loadPin() {
      return { kind: "ok", pin: noFrg, path: "/p" };
    },
    async promote({ allowWithoutFrg }) {
      promoteCalls += 1;
      assert.equal(allowWithoutFrg, false);
      return { ok: true, pin: promoted, path: "/pin.json", reinstall_hint: "npx #v1.34.0" };
    },
    readSkipFrg: () => false,
  });
  const result = await runEnginePromote(opts({ skipInstall: true }), deps);
  assert.equal(result.error, undefined);
  assert.equal(promoteCalls, 1);
  assert.equal(result.pin_promoted, true);
  assert.equal(result.pin?.frg_run_id, "frg-abc");
  assert.ok(result.pin?.frg_evidence_path);
  assert.ok(!result.steps.some((s) => s.includes("pin_already_current")));
});

test("engine-promote: same-version no-frg is already-current when skip is active (#1041)", async () => {
  const noFrg: ProductionEnginePin = {
    schema_version: 1,
    version: "1.34.0",
    tag: "v1.34.0",
    frg_run_id: "no-frg-1.34.0",
    frg_evidence_path: null,
    promoted_at: "2026-08-09T00:00:00.000Z",
  };
  let promoteCalls = 0;
  const deps = makeDeps({
    async loadPin() {
      return { kind: "ok", pin: noFrg, path: "/p" };
    },
    async promote() {
      promoteCalls += 1;
      return { ok: true, pin: noFrg, path: "/pin.json", reinstall_hint: "npx #v1.34.0" };
    },
    readSkipFrg: () => false,
  });
  const result = await runEnginePromote(opts({ skipInstall: true, allowWithoutFrg: true }), deps);
  assert.equal(result.error, undefined);
  assert.equal(promoteCalls, 0);
  assert.ok(result.steps.some((s) => s.includes("pin_already_current")));
  assert.equal(result.pin?.frg_run_id, "no-frg-1.34.0");
});

test("engine-promote: unset or false skip_frg still requires FRG without --skip-frg (#1092)", async () => {
  const logs: string[] = [];
  let promoteCalls = 0;
  const deps = makeDeps({
    log(msg) {
      logs.push(msg);
    },
    async promote({ allowWithoutFrg }) {
      promoteCalls += 1;
      if (!allowWithoutFrg) {
        return { ok: false, code: "missing_frg", message: "FRG pass missing for 1.34.0" };
      }
      return { ok: true, pin: pin("1.34.0"), path: "/pin.json", reinstall_hint: "npx #v1.34.0" };
    },
    readSkipFrg: () => false,
  });
  const result = await runEnginePromote(opts(), deps);
  assert.match(result.error ?? "", /FRG pass missing/);
  assert.equal(promoteCalls, 1);
  assert.equal(result.pin_promoted, false);
  assert.ok(!logs.some((l) => /skipping Factory Reliability Gate/.test(l)));
});

test("engine-promote: skip_frg true skips FRG without --skip-frg and logs config (#1092)", async () => {
  const logs: string[] = [];
  let seenAllow: boolean | undefined;
  const deps = makeDeps({
    log(msg) {
      logs.push(msg);
    },
    async promote({ version, allowWithoutFrg }) {
      seenAllow = allowWithoutFrg;
      return { ok: true, pin: pin(version), path: "/pin.json", reinstall_hint: `npx #v${version}` };
    },
    readSkipFrg: () => true,
  });
  const result = await runEnginePromote(opts(), deps);
  assert.equal(result.error, undefined);
  assert.equal(seenAllow, true);
  assert.ok(logs.some((l) => /skip_frg: true in \.github\/pipeline\.yml/.test(l)));
  assert.ok(!logs.some((l) => /skipping Factory Reliability Gate for 1\.34\.0 \(--skip-frg\)/.test(l)));
});

test("engine-promote: non-skip promote records exported pin path not worktree repoDir (#1127)", async () => {
  const factoryPin = "/factory/.agent-pipeline/production-engine-pin.json";
  let seenOverride: string | null | undefined;
  let seenRepoDir: string | undefined;
  const promoted = pin("1.39.3");
  promoted.frg_run_id = "frg-abc";
  const deps = makeDeps({
    async promote({ repoDir, overridePath, allowWithoutFrg, version }) {
      seenRepoDir = repoDir;
      seenOverride = overridePath ?? null;
      assert.equal(allowWithoutFrg, false);
      assert.doesNotMatch(version, /no-frg/);
      return { ok: true, pin: promoted, path: factoryPin, reinstall_hint: "npx #v1.39.3" };
    },
    async loadPin() {
      return { kind: "missing", path: factoryPin };
    },
  });
  const result = await runEnginePromote(
    opts({
      version: "1.39.3",
      repoDir: "/worktrees/pipeline-promote",
      pinPath: factoryPin,
      skipInstall: true,
    }),
    deps,
  );
  assert.equal(result.error, undefined);
  assert.equal(seenRepoDir, "/worktrees/pipeline-promote");
  assert.equal(seenOverride, factoryPin);
  assert.equal(result.pin_path, factoryPin);
  assert.equal(result.pin?.frg_run_id, "frg-abc");
  assert.ok(result.pin?.frg_evidence_path);
  assert.doesNotMatch(result.pin?.frg_run_id ?? "", /^no-frg-/);
});

test("engine-promote: --skip-frg still skips when skip_frg is unset or false (#1092)", async () => {
  const logs: string[] = [];
  let seenAllow: boolean | undefined;
  const deps = makeDeps({
    log(msg) {
      logs.push(msg);
    },
    async promote({ version, allowWithoutFrg }) {
      seenAllow = allowWithoutFrg;
      return { ok: true, pin: pin(version), path: "/pin.json", reinstall_hint: `npx #v${version}` };
    },
    readSkipFrg: () => false,
  });
  const result = await runEnginePromote(opts({ allowWithoutFrg: true }), deps);
  assert.equal(result.error, undefined);
  assert.equal(seenAllow, true);
  assert.ok(logs.some((l) => /skipping Factory Reliability Gate for 1\.34\.0 \(--skip-frg\)/.test(l)));
});

test("engine-promote writes peeled tag git_sha not null (#1166)", async () => {
  const peel = "1".repeat(40);
  const deps = makeDeps({
    async resolvePromoteGitSha() {
      return peel;
    },
  });
  const result = await runEnginePromote(opts(), deps);
  assert.equal(result.error, undefined);
  assert.equal(result.pin?.git_sha, peel);
  assert.ok(result.steps.some((s) => s.startsWith("git_sha_peeled:")));
});

test("engine-promote fails closed when peel is missing (#1166)", async () => {
  const deps = makeDeps({
    async resolvePromoteGitSha() {
      throw new Error("peeled v1.34.0 is not a 40-hex git SHA");
    },
  });
  const result = await runEnginePromote(opts(), deps);
  assert.match(result.error ?? "", /not a 40-hex git SHA/);
  assert.equal(deps.promotes, 0);
  assert.equal(deps.installs.length, 0);
});

test("resolvePeeledPromoteGitSha refuses packed-not-ancestor (#1166)", async () => {
  const peel = "1".repeat(40);
  const packed = "2".repeat(40);
  await assert.rejects(
    () =>
      resolvePeeledPromoteGitSha(
        { repoDir: "/repo", version: "1.39.5", tag: "v1.39.5" },
        {
          git: async (args) => {
            if (args[0] === "rev-parse") return { stdout: peel, status: 0 };
            if (args[0] === "merge-base") return { stdout: "", status: 1 };
            return { stdout: "", status: 1 };
          },
          readLatestJson: () => ({
            pass: true,
            pack_provenance: { candidate_git_sha: packed },
          }),
        },
      ),
    /not an ancestor/,
  );
});

test("resolvePeeledPromoteGitSha accepts packed ancestor of peel (#1166)", async () => {
  const peel = "1".repeat(40);
  const packed = "2".repeat(40);
  const sha = await resolvePeeledPromoteGitSha(
    { repoDir: "/repo", version: "1.39.5", tag: "v1.39.5" },
    {
      git: async (args) => {
        if (args[0] === "rev-parse") return { stdout: peel, status: 0 };
        if (args[0] === "merge-base") return { stdout: "", status: 0 };
        return { stdout: "", status: 1 };
      },
      readLatestJson: () => ({
        pass: true,
        pack_provenance: { candidate_git_sha: packed },
      }),
    },
  );
  assert.equal(sha, peel);
});

test("resolvePeeledPromoteGitSha does not use packed gitSha as peel (#1162)", async () => {
  const peel = "1".repeat(40);
  const packed = "2".repeat(40);
  const gitCalls: string[][] = [];
  const sha = await resolvePeeledPromoteGitSha(
    { repoDir: "/repo", version: "1.39.5", tag: "v1.39.5", gitSha: packed },
    {
      git: async (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") return { stdout: peel, status: 0 };
        if (args[0] === "merge-base") return { stdout: "", status: 0 };
        return { stdout: "", status: 1 };
      },
      readLatestJson: () => ({
        pass: true,
        pack_provenance: { candidate_git_sha: packed },
      }),
    },
  );
  assert.equal(sha, peel);
  assert.ok(
    gitCalls.some((a) => a[0] === "rev-parse" && a.includes("v1.39.5^{commit}")),
    `must peel v1.39.5^{commit}, git calls=${JSON.stringify(gitCalls)}`,
  );
  assert.notEqual(sha, packed);
});

test("resolvePeeledPromoteGitSha refuses latest.json pass not true (#1166)", async () => {
  await assert.rejects(
    () =>
      resolvePeeledPromoteGitSha(
        { repoDir: "/repo", version: "1.39.5", tag: "v1.39.5", gitSha: "1".repeat(40) },
        {
          git: async () => ({ stdout: "1".repeat(40), status: 0 }),
          readLatestJson: () => ({ pass: false, pack_provenance: { candidate_git_sha: "2".repeat(40) } }),
        },
      ),
    /pass is not true/,
  );
});

test("requirePeeledOid rejects null-like values (#1166)", () => {
  assert.throws(() => requirePeeledOid("", "peeled v1.39.5"), /not a 40-hex/);
  assert.throws(() => requirePeeledOid("null", "peeled v1.39.5"), /not a 40-hex/);
});

test("engine-promote isolation: advance stages do not import", () => {
  const stagesDir = path.join(__dirname, "..", "scripts", "stages");
  const exempt = new Set([
    "engine-promote.ts",
    "release-finish.ts",
    "release.ts",
    "merge.ts",
    "merge-queue.ts",
    "merge_queue.ts",
    "merge-queue-release-when-complete.ts",
    "merge_queue_hold.ts",
    // Operator-authorized ship composition; never imported by advance dispatch.
    "ship-adapter.ts",
    "train.ts",
  ]);
  for (const f of fs.readdirSync(stagesDir).filter((x) => x.endsWith(".ts"))) {
    if (exempt.has(f)) continue;
    const c = fs.readFileSync(path.join(stagesDir, f), "utf8");
    assert.ok(!c.includes("engine-promote") && !c.includes("runEnginePromote"), f);
  }
});
