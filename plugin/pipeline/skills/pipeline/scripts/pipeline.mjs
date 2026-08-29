#!/usr/bin/env node
// Transitional marketplace bridge (#1048). The product engine lives in the
// managed Claude install; this plugin shell deliberately contains no core copy.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const configuredRoot = process.env.CLAUDE_CONFIG_DIR?.trim();
const claudeRoot = configuredRoot
  ? resolve(configuredRoot)
  : join(homedir(), ".claude");
const managedSkill = join(claudeRoot, "skills", "pipeline");
const managedMarker = join(managedSkill, ".pipeline-installer-managed");
const managedLauncher = join(managedSkill, "scripts", "pipeline.mjs");

if (!existsSync(managedMarker) || !existsSync(managedLauncher)) {
  console.error(`pipeline plugin bridge: managed Claude CLI install not found at ${managedLauncher}`);
  console.error("Install it with: npx --yes github:accidental-hedge-fund/agent-pipeline install --host claude");
  process.exit(1);
}

const child = spawnSync(process.execPath, [managedLauncher, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
if (child.error) {
  console.error(`pipeline plugin bridge: failed to launch managed CLI: ${child.error.message}`);
  process.exit(1);
}
if (child.signal) {
  console.error(`pipeline plugin bridge: managed CLI terminated by ${child.signal}`);
  process.exit(1);
}
process.exit(child.status ?? 1);
