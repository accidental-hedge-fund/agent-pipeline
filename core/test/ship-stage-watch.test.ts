// Regression: host observation must bind to one explicit run and use the
// shared material filter. It must not discover host-global "latest" runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  try { const row = JSON.parse(line); if (row.material) console.log(row.message); } catch {}
}
`,
    { mode: 0o755 },
  );
  return { root, events, filter };
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
