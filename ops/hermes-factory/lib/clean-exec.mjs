#!/usr/bin/env node

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENV_LINE = /^([A-Z][A-Z0-9_]*)="((?:[^"\\]|\\["\\])*)"$/;

export function parsePrivateEnvironment(body) {
  const env = {};
  for (const line of String(body).split(/\r?\n/)) {
    if (!line) continue;
    const match = ENV_LINE.exec(line);
    if (!match || Object.hasOwn(env, match[1])) throw new Error("private child environment is invalid");
    env[match[1]] = match[2].replace(/\\(["\\])/g, "$1");
  }
  return env;
}

async function readPrivateEnvironment(path) {
  if (!isAbsolute(path)) throw new Error("the child environment path must be absolute");
  const stat = await fs.stat(path);
  if (!stat.isFile()) throw new Error("the child environment must be a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("the child environment must be owned by the service account");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("the child environment must be owner-only");
  return parsePrivateEnvironment(await fs.readFile(path, "utf8"));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.length < 4 || argv[0] !== "--env-file" || argv[2] !== "--") {
    throw new Error("Usage: clean-exec.mjs --env-file <owner-only-file> -- <absolute-command> [args...]");
  }
  const command = argv[3];
  if (!isAbsolute(command)) throw new Error("the child command must be absolute");
  const env = await (deps.readEnvironment ?? readPrivateEnvironment)(argv[1]);
  const launch = deps.spawn ?? spawn;
  const child = launch(command, argv.slice(4), {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardTerm = () => forward("SIGTERM");
  const forwardInterrupt = () => forward("SIGINT");
  process.once("SIGTERM", forwardTerm);
  process.once("SIGINT", forwardInterrupt);
  let outcome;
  try {
    outcome = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => accept({ code, signal }));
    });
  } finally {
    process.removeListener("SIGTERM", forwardTerm);
    process.removeListener("SIGINT", forwardInterrupt);
  }
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exitCode = outcome.code ?? 1;
}

const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`clean-exec: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
