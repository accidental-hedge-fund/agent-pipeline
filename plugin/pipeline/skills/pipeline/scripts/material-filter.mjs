#!/usr/bin/env node
// Thin launcher for the shared material-filter core script (#742).
// Installed next to pipeline.mjs so host skill docs use a stable install path:
//   node ~/.claude/skills/pipeline/scripts/material-filter.mjs
// Operators do not need to address core/scripts/*.ts or pass strip-types flags.
//
// Observation only — never rewrites the run store. Streams stdin → core filter → stdout.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const filterTs = join(here, "..", "core", "scripts", "material-filter.ts");

if (!existsSync(filterTs)) {
  console.error(`material-filter: core script missing at ${filterTs}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", filterTs, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("error", (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
