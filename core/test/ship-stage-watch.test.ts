// Regression: host observation must bind to one explicit run and use the
// shared material filter. It must not discover host-global "latest" runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const script = path.join(repoRoot, "examples/supervisor/shell/ship-stage-watch.sh");

function fixture(): { root: string; events: string; filter: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-stage-watch-"));
  const events = path.join(root, "exact-run", "events.jsonl");
  const filter = path.join(root, "material-filter.mjs");
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(
    filter,
    `#!/usr/bin/env node
import readline from "node:readline";
const untilIdentity = process.argv.includes("--until-identity-terminal");
const loopTerminal = new Set(["loop_run_superseded", "loop_run_complete", "loop_run_stopped"]);
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  try {
    const row = JSON.parse(line);
    if (row.material) console.log(row.message);
    if (loopTerminal.has(row.kind)) {
      console.log("[" + row.kind + "]");
      if (untilIdentity) process.exit(0);
    }
    if (row.kind === "ship_phase") {
      console.log("[ship_phase] " + row.phase + " → " + row.status);
      if (untilIdentity && row.phase === "complete" && row.status === "completed") process.exit(0);
    }
  } catch {}
}
`,
    { mode: 0o755 },
  );
  return { root, events, filter };
}

function hangFilter(root: string): string {
  const filter = path.join(root, "hang-filter.mjs");
  fs.writeFileSync(
    filter,
    `#!/usr/bin/env node
import readline from "node:readline";
const loopTerminal = new Set(["loop_run_superseded", "loop_run_complete", "loop_run_stopped"]);
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  try {
    const row = JSON.parse(line);
    if (row.material) console.log(row.message);
    if (loopTerminal.has(row.kind)) console.log("[" + row.kind + "]");
  } catch {}
}
`,
    { mode: 0o755 },
  );
  return filter;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    const finish = (err: Error | null, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      killWatchTree(child);
      finish(new Error(`watcher still alive after ${timeoutMs}ms; stdout=${stdout} stderr=${stderr}`), null);
    }, timeoutMs);
    child.on("close", (code) => {
      finish(null, code);
    });
  });
}

function killWatchTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function spawnFollow(opts: {
  events: string;
  filter: string;
  label?: string;
  idleSecs?: string;
  extraEnv?: Record<string, string>;
}): ChildProcess {
  return spawn("bash", [script, "--events-file", opts.events, "--label", opts.label ?? "ship v1.40.0"], {
    env: {
      ...process.env,
      PIPELINE_MATERIAL_FILTER: opts.filter,
      SHIP_NOTIFY: "0",
      ...(opts.idleSecs != null ? { SHIP_STAGE_WATCH_IDLE_SECS: opts.idleSecs } : {}),
      ...(opts.extraEnv ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

test("watcher requires one absolute events file and contains no global discovery", () => {
  const body = fs.readFileSync(script, "utf8");
  assert.match(body, /--events-file/);
  assert.match(body, /PIPELINE_MATERIAL_FILTER/);
  assert.doesNotMatch(body, /AGENT_PIPELINE_LOOP_ROOT|\.local\/state\/agent-pipeline|ps -eo|ls -t/);

  const r = spawnSync("bash", [script, "--events-file", "relative/events.jsonl", "--once"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /absolute path/);
});

test("watcher streams only shared-filter output from the exact file", () => {
  const { events, filter } = fixture();
  fs.writeFileSync(
    events,
    [
      JSON.stringify({ material: false, message: "global noise" }),
      JSON.stringify({ material: true, message: "#909 stage start → planning" }),
    ].join("\n") + "\n",
  );

  const r = spawnSync(
    "bash",
    [script, "--events-file", events, "--label", "ship v1.34.0", "--once"],
    {
      env: {
        ...process.env,
        PIPELINE_MATERIAL_FILTER: filter,
        SHIP_NOTIFY: "0",
      },
      encoding: "utf8",
    },
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /ship v1\.34\.0: #909 stage start/);
  assert.doesNotMatch(r.stdout, /global noise/);
});

test("watcher rejects --milestone (bundled contract is --events-file only)", () => {
  const r = spawnSync("bash", [script, "--milestone", "v1.39.8"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument: --milestone/);
  assert.match(r.stderr, /--events-file/);
  assert.doesNotMatch(r.stderr, /--since /);
});

test("watcher fails visibly when the exact file is absent in once mode", () => {
  const { root, filter } = fixture();
  const absent = path.join(root, "missing", "events.jsonl");
  const r = spawnSync("bash", [script, "--events-file", absent, "--once"], {
    env: { ...process.env, PIPELINE_MATERIAL_FILTER: filter },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /events file not found/);
});

test("follow mode exits after loop_run_superseded and emits the identity-terminal line (#1227)", async () => {
  const { root, events, filter } = fixture();
  fs.writeFileSync(events, "");
  const child = spawnFollow({ events, filter, idleSecs: "2" });
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(
    events,
    JSON.stringify({
      seq: 1,
      time: "2026-08-23T21:19:00.000Z",
      kind: "loop_run_superseded",
      data: { superseded_by: "loop-9d33dc88" },
    }) + "\n",
  );
  const result = await waitForExit(child, 4000);
  assert.equal(result.code, 0, `stderr=${result.stderr} stdout=${result.stdout}`);
  assert.match(result.stdout, /\[loop_run_superseded\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("follow mode exits when identity-terminal already exists before startup (#1227)", async () => {
  const { root, events, filter } = fixture();
  fs.writeFileSync(
    events,
    [
      JSON.stringify({ material: true, message: "#1221 stage start → implementing" }),
      JSON.stringify({
        seq: 1,
        time: "2026-08-23T21:19:00.000Z",
        kind: "loop_run_superseded",
        data: { superseded_by: "loop-9d33dc88" },
      }),
    ].join("\n") + "\n",
  );
  const child = spawnFollow({ events, filter, idleSecs: "1" });
  const result = await waitForExit(child, 4000);
  assert.equal(result.code, 0, `stderr=${result.stderr} stdout=${result.stdout}`);
  assert.match(result.stdout, /\[loop_run_superseded\]/);
  assert.doesNotMatch(result.stdout, /stage start/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("follow mode idle after supersede exits even if the filter would hang (#1227)", async () => {
  const { root, events } = fixture();
  const filter = hangFilter(root);
  fs.writeFileSync(events, "");
  const child = spawnFollow({ events, filter, idleSecs: "1" });
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(
    events,
    JSON.stringify({
      kind: "loop_run_superseded",
      data: { superseded_by: "loop-9d33dc88" },
    }) + "\n",
  );
  const result = await waitForExit(child, 4000);
  assert.equal(result.code, 0, `stderr=${result.stderr} stdout=${result.stdout}`);
  assert.match(result.stdout, /\[loop_run_superseded\]/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("follow mode does not exit solely because a live quiet run is idle (#1227)", async () => {
  const { root, events, filter } = fixture();
  fs.writeFileSync(events, "");
  const child = spawnFollow({ events, filter, idleSecs: "1" });
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(
    events,
    JSON.stringify({ material: true, message: "#1221 stage start → implementing" }) + "\n",
  );
  await new Promise((r) => setTimeout(r, 1800));
  const stillAlive = child.exitCode === null && child.signalCode == null;
  killWatchTree(child);
  await waitForExit(child, 2000).catch(() => ({ code: null, stdout: "", stderr: "" }));
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(stillAlive, true, "live quiet run must keep following past the idle bound");
});

test("follow mode still requires one absolute events file and does not glob latest runs (#1227)", () => {
  const body = fs.readFileSync(script, "utf8");
  assert.match(body, /--until-identity-terminal/);
  assert.match(body, /SHIP_STAGE_WATCH_IDLE_SECS/);
  assert.match(body, /SHIP_STAGE_WATCH_SCAN_EOF_HOLD/);
  assert.doesNotMatch(body, /superseded_by.*events\.jsonl/);
  assert.doesNotMatch(body, /AGENT_PIPELINE_LOOP_ROOT|\.local\/state\/agent-pipeline|ls -t|find .*events\.jsonl/);
});

test("follow mode does not lose loop_run_superseded appended after scan EOF (#1227)", async () => {
  const { root, events, filter } = fixture();
  fs.writeFileSync(events, "");
  const hold = path.join(root, "scan-eof-hold");
  fs.mkdirSync(hold);
  const child = spawnFollow({
    events,
    filter,
    idleSecs: "2",
    extraEnv: { SHIP_STAGE_WATCH_SCAN_EOF_HOLD: hold },
  });
  const ready = path.join(hold, "eof-reached");
  const deadline = Date.now() + 4000;
  while (!fs.existsSync(ready) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.existsSync(ready), true, "scan never reached EOF");
  assert.equal(child.exitCode, null, "watcher must still be in the scan-to-follow hold");
  fs.appendFileSync(
    events,
    JSON.stringify({
      seq: 1,
      time: "2026-08-23T21:19:00.000Z",
      kind: "loop_run_superseded",
      data: { superseded_by: "loop-9d33dc88" },
    }) + "\n",
  );
  fs.writeFileSync(path.join(hold, "continue"), "1");
  const result = await waitForExit(child, 4000);
  assert.equal(result.code, 0, `stderr=${result.stderr} stdout=${result.stdout}`);
  assert.match(result.stdout, /\[loop_run_superseded\]/);
  fs.rmSync(root, { recursive: true, force: true });
});
