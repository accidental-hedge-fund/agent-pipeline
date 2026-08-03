#!/usr/bin/env node
// OpenCode /pipeline argument bridge (#861).
//
// Routes OpenCode command arguments to the co-located pipeline.mjs launcher
// without shell word-splitting or metacharacter expansion.
//
// Modes:
//   node opencode-pipeline-bridge.mjs --from-stdin
//     Read a raw argument string from stdin (used by the OpenCode command
//     template heredoc so $ARGUMENTS never pass through unquoted shell).
//   node opencode-pipeline-bridge.mjs [--] <argv…>
//     Forward discrete argv tokens (unit-test / direct invocation path).
//
// Always spawns the launcher with shell:false so spaces and metacharacters
// reach pipeline.mjs intact.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tokenize a raw argument string the way a user typed it after `/pipeline`.
 * Supports single/double quotes and backslash escapes inside double quotes.
 * Does not expand globs, variables, or subshells.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function parseArgvString(input) {
  const s = String(input ?? "").replace(/\r?\n$/, "");
  const args = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let tok = "";
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\" && quote === '"' && i + 1 < s.length) {
          i++;
          tok += s[i++];
        } else {
          tok += s[i++];
        }
      }
      if (i < s.length && s[i] === quote) i++;
      args.push(tok);
    } else {
      let tok = "";
      while (i < s.length && !/\s/.test(s[i])) tok += s[i++];
      args.push(tok);
    }
  }
  return args;
}

function resolveLauncherArgs(argv) {
  if (argv[0] === "--from-stdin") {
    const raw = readFileSync(0, "utf8");
    return parseArgvString(raw);
  }
  if (argv[0] === "--") return argv.slice(1);
  return argv;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const launcher = join(here, "pipeline.mjs");
  const launcherArgs = resolveLauncherArgs(process.argv.slice(2));

  const result = spawnSync(process.execPath, [launcher, ...launcherArgs], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    process.stderr.write(
      `opencode-pipeline-bridge: failed to spawn launcher: ${result.error.message}\n`,
    );
    process.exit(1);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

// ESM main guard — tolerates bin symlinks; allows unit tests to import helpers.
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && String(process.argv[1]).endsWith("opencode-pipeline-bridge.mjs");
  }
}

if (isMain()) main();
