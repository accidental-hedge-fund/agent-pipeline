// Tests for pipeline engine-promote (Phase 4). No network/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ENGINE_PROMOTE_HOST,
  installArgsForTag,
  installCommandForTag,
  runEnginePromote,
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
    async promote({ version }) {
      promotes += 1;
      current = pin(version, current?.version);
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
  assert.equal(DEFAULT_ENGINE_PROMOTE_HOST, "all");
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

test("ship playbook: ENGINE_PROMOTE_HOST defaults to all and passes --host (#989)", () => {
  const playbook = path.join(
    repoRoot,
    "examples/supervisor/shell/pipeline-ship-playbook.sh",
  );
  assert.ok(fs.existsSync(playbook), "missing pipeline-ship-playbook.sh");
  const body = fs.readFileSync(playbook, "utf8");
  // Unset default must be all — fail if someone restores codex-only ship default.
  assert.match(body, /HOST="\$\{ENGINE_PROMOTE_HOST:-all\}"/);
  assert.doesNotMatch(body, /HOST="\$\{ENGINE_PROMOTE_HOST:-codex\}"/);
  // Header documents default all and valid values including single hosts.
  assert.match(body, /ENGINE_PROMOTE_HOST\s+codex\|claude\|grok\|opencode\|all \(default all\)/);
  // Promote always passes explicit --host (no silent omission).
  assert.match(
    body,
    /engine-promote --for "\$version" --host "\$HOST" --skip-frg --json/,
  );
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

test("engine-promote: install failure rolls back pin", async () => {
  const deps = makeDeps({
    async installFromTag(tag) {
      if (tag === "v1.34.0") throw new Error("npx failed");
      return { command: "ok", stdout: "" };
    },
    async installedVersion() {
      return "1.31.1";
    },
  });
  // track installs via wrapper
  const installs: string[] = [];
  const orig = deps.installFromTag;
  deps.installFromTag = async (tag, host) => {
    installs.push(tag);
    return orig(tag, host);
  };
  const result = await runEnginePromote(opts(), deps);
  assert.ok(result.error?.includes("install failed"));
  assert.equal(result.rolled_back, true);
  assert.ok(installs.includes("v1.34.0"));
  assert.ok(installs.includes("v1.31.1")); // reinstall previous
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
