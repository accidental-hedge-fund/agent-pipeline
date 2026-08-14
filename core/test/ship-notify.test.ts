// Regression: ship-notify must not mask messenger send failures.
// Transient 502-class exits retry then succeed; permanent failures leave
// audit + supervisor-visible markers while still exiting 0 (best-effort).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const script = path.join(repoRoot, "examples/supervisor/shell/ship-notify.sh");

type Fixture = {
  root: string;
  state: string;
  buzzBin: string;
  creds: string;
  callsFile: string;
  failUntilFile: string;
};

function makeFixture(opts?: { failUntil?: number; alwaysFail?: boolean }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-notify-"));
  const state = path.join(root, "state");
  const notifyDir = path.join(state, "notify");
  fs.mkdirSync(notifyDir, { recursive: true });

  const callsFile = path.join(root, "calls.count");
  const failUntilFile = path.join(root, "fail-until");
  fs.writeFileSync(callsFile, "0");
  if (opts?.alwaysFail) {
    fs.writeFileSync(failUntilFile, "999999");
  } else {
    fs.writeFileSync(failUntilFile, String(opts?.failUntil ?? 0));
  }

  const buzzBin = path.join(root, "fake-buzz");
  // Fake buzz: argv is messages send ... ; count calls; fail while call# <= failUntil.
  fs.writeFileSync(
    buzzBin,
    `#!/usr/bin/env bash
set -euo pipefail
calls_file=${JSON.stringify(callsFile)}
fail_until_file=${JSON.stringify(failUntilFile)}
n=$(cat "$calls_file")
n=$((n + 1))
printf '%s' "$n" >"$calls_file"
limit=$(cat "$fail_until_file")
if [[ "$n" -le "$limit" ]]; then
  echo "502 Bad Gateway (fixture attempt $n)" >&2
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  );

  const creds = path.join(root, "creds.json");
  fs.writeFileSync(creds, JSON.stringify({ nsec: "nsec1fixture-not-real" }));

  return { root, state, buzzBin, creds, callsFile, failUntilFile };
}

function runNotify(
  fx: Fixture,
  args: string[],
  envExtra: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHIP_NOTIFY: "1",
      PIPELINE_SUPERVISOR_STATE: fx.state,
      BUZZ_BIN: fx.buzzBin,
      BUZZ_CHANNEL: "ch-fixture",
      BUZZ_CREDENTIALS_FILE: fx.creds,
      BUZZ_RELAY_URL: "wss://example.invalid",
      // Zero sleeps so CI does not wait production backoff.
      SHIP_NOTIFY_BACKOFF_S: "0 0 0",
      SHIP_NOTIFY_MAX_ATTEMPTS: "3",
      ...envExtra,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function callCount(fx: Fixture): number {
  return Number(fs.readFileSync(fx.callsFile, "utf8").trim() || "0");
}

function auditLog(fx: Fixture): string {
  const p = path.join(fx.state, "notify", "audit.log");
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

function failedMarkers(fx: Fixture): string[] {
  const dir = path.join(fx.state, "notify", "failed");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => !n.startsWith("."));
}

test("script header documents retry/audit and no longer masks with || true alone", () => {
  const body = fs.readFileSync(script, "utf8");
  assert.match(body, /SHIP_NOTIFY_MAX_ATTEMPTS/);
  assert.match(body, /SHIP_NOTIFY_BACKOFF_S/);
  assert.match(body, /audit\.log/);
  assert.match(body, /failed\//);
  // Old sole-path mask must not remain as the send outcome handling.
  assert.doesNotMatch(body, /\$BUZZ_BIN.*\|\|\s*true/);
  assert.match(body, /append_audit|audit\.log/);
});

test("transient 502 then success: three sends, success audit, no final-failure marker", () => {
  const fx = makeFixture({ failUntil: 2 });
  const r = runNotify(fx, ["stage done #599 → pre-merge", "stage-adv-done-599-pre-merge"]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(callCount(fx), 3);
  const audit = auditLog(fx);
  assert.match(audit, /\tok\t/);
  assert.match(audit, /attempts=3/);
  assert.equal(failedMarkers(fx).length, 0, `unexpected markers: ${failedMarkers(fx)}`);
  // Dedupe file present with content.
  const dedupe = path.join(fx.state, "notify", "stage-adv-done-599-pre-merge");
  assert.ok(fs.existsSync(dedupe));
  assert.match(fs.readFileSync(dedupe, "utf8"), /stage done #599/);
});

test("permanent failure: audit + marker, exit 0, attempt count equals budget", () => {
  const fx = makeFixture({ alwaysFail: true });
  const r = runNotify(fx, ["train → failed merge", "tug-train-failed-1"]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(callCount(fx), 3);
  const audit = auditLog(fx);
  assert.match(audit, /\tfail\t/);
  assert.match(audit, /502 Bad Gateway|exit 1/);
  const markers = failedMarkers(fx);
  assert.ok(markers.length >= 1, "expected supervisor-visible failure marker");
  const markerBody = fs.readFileSync(
    path.join(fx.state, "notify", "failed", markers[0]!),
    "utf8",
  );
  assert.match(markerBody, /status=fail/);
  assert.match(markerBody, /train → failed merge|train.*failed/);
  assert.match(markerBody, /502|exit/);
  // Regression bite: durable artifacts must exist — not exit-0-only "success".
  assert.ok(audit.includes("fail"), "fail-all must write failure audit");
  assert.ok(markers.length > 0, "fail-all must write failure marker");
});

test("TTL dedupe suppresses second identical send; --force still attempts and surfaces failure", () => {
  const fx = makeFixture({ failUntil: 0 }); // first send succeeds
  const key = "dedupe-key-a";
  const msg = "same content within TTL";
  let r = runNotify(fx, [msg, key]);
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 1);
  assert.match(auditLog(fx), /\tok\t/);

  // Second identical within TTL: no additional send.
  r = runNotify(fx, [msg, key]);
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 1);

  // Force + always-fail messenger: bypasses TTL, attempts send, writes fail artifacts.
  fs.writeFileSync(fx.failUntilFile, "999999");
  r = runNotify(fx, [msg, key, "--force"]);
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 1 + 3); // one prior success + 3 force failures
  assert.match(auditLog(fx), /\tfail\t/);
  assert.ok(failedMarkers(fx).length >= 1);
});

test("SHIP_NOTIFY=0 / unconfigured / empty message: exit 0, no send, no invented failure marker", () => {
  const fx = makeFixture({ alwaysFail: true });

  // Disabled
  let r = runNotify(fx, ["hello", "k1"], { SHIP_NOTIFY: "0" });
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 0);
  assert.equal(failedMarkers(fx).length, 0);
  assert.equal(auditLog(fx), "");

  // Empty message
  r = runNotify(fx, [""]);
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 0);
  assert.equal(failedMarkers(fx).length, 0);

  // Unconfigured messenger (no BUZZ_BIN)
  r = spawnSync("bash", [script, "would-post", "k-unconf"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHIP_NOTIFY: "1",
      PIPELINE_SUPERVISOR_STATE: fx.state,
      BUZZ_BIN: "",
      BUZZ_CHANNEL: "ch",
      BUZZ_CREDENTIALS_FILE: fx.creds,
      SHIP_NOTIFY_BACKOFF_S: "0 0 0",
    },
  });
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 0);
  assert.equal(failedMarkers(fx).length, 0);
  // No audit invented for unconfigured path
  assert.equal(auditLog(fx), "");
});

test("success clears prior key-scoped failure marker", () => {
  const fx = makeFixture({ alwaysFail: true });
  const key = "clear-marker-key";
  let r = runNotify(fx, ["first fails", key]);
  assert.equal(r.status, 0);
  assert.ok(failedMarkers(fx).length >= 1);

  // Now succeed on first attempt.
  fs.writeFileSync(fx.failUntilFile, "0");
  fs.writeFileSync(fx.callsFile, "0");
  r = runNotify(fx, ["second succeeds", key, "--force"]);
  assert.equal(r.status, 0);
  assert.equal(callCount(fx), 1);
  // Key-scoped markers for this key should be cleared.
  const remaining = failedMarkers(fx).filter((n) => n.startsWith("clear-marker-key-"));
  assert.equal(remaining.length, 0, `leftover markers: ${remaining}`);
  assert.match(auditLog(fx), /\tok\t/);
});
