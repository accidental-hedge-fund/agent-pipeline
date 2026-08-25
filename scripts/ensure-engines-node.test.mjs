#!/usr/bin/env node
// Unit tests for scripts/ensure-engines-node.mjs — multi-node factory host
// re-exec (Hermes Node 22 early on PATH + engines-compliant Node 24 elsewhere).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINES_NODE_FLOOR_MAJOR,
  envPreferringNode,
  formatMissingEnginesNodeDiagnostic,
  parseNodeMajor,
  probeNodeMajor,
  reexecOntoEnginesNode,
  resolveEnginesNode,
  runUnderEnginesNode,
} from "./ensure-engines-node.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("parseNodeMajor: extracts major from version strings", () => {
  assert.equal(parseNodeMajor("24.18.0"), 24);
  assert.equal(parseNodeMajor("22.23.2"), 22);
  assert.equal(parseNodeMajor("24"), 24);
  assert.equal(parseNodeMajor(""), null);
  assert.equal(parseNodeMajor("not-a-version"), null);
});

test("ENGINES_NODE_FLOOR_MAJOR matches package engines (>=24)", () => {
  assert.equal(ENGINES_NODE_FLOOR_MAJOR, 24);
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const core = JSON.parse(readFileSync(join(REPO_ROOT, "core", "package.json"), "utf8"));
  assert.match(String(root.engines?.node ?? ""), /24/);
  assert.match(String(core.engines?.node ?? ""), /24/);
});

test("resolveEnginesNode: prefers process.execPath when it already satisfies the floor", () => {
  const resolved = resolveEnginesNode({
    floor: 24,
    execPath: "/virtual/node24",
    execVersion: "24.1.0",
    env: { PATH: "/opt/old" },
    pathExists: (p) => p === "/virtual/node24",
    spawn: () => {
      throw new Error("must not probe when execPath already satisfies");
    },
  });
  assert.deepEqual(resolved, { path: "/virtual/node24", major: 24 });
});

test("resolveEnginesNode: multi-node host — too-old execPath, system Node 24 wins", () => {
  const probes = [];
  const resolved = resolveEnginesNode({
    floor: 24,
    execPath: "/home/user/.local/bin/node",
    execVersion: "22.23.2",
    env: {
      PATH: "/home/user/.local/bin:/usr/bin",
    },
    home: "/home/user",
    pathExists: (p) =>
      p === "/home/user/.local/bin/node" ||
      p === "/usr/bin/node" ||
      p === "/home/user/.local/node-v24/bin/node",
    spawn: (cmd, args) => {
      probes.push(cmd);
      if (cmd === "/usr/bin/node" && args[0] === "-p") {
        return { status: 0, stdout: "24.18.0\n" };
      }
      if (cmd === "/home/user/.local/node-v24/bin/node") {
        return { status: 0, stdout: "24.5.0\n" };
      }
      return { status: 1, stdout: "" };
    },
  });
  assert.equal(resolved?.path, "/usr/bin/node");
  assert.equal(resolved?.major, 24);
  assert.ok(
    !probes.includes("/home/user/.local/bin/node"),
    "must not re-probe the already-too-old execPath",
  );
});

test("resolveEnginesNode: AGENT_PIPELINE_NODE override wins when it satisfies", () => {
  const resolved = resolveEnginesNode({
    floor: 24,
    execPath: "/old/node",
    execVersion: "22.0.0",
    env: { AGENT_PIPELINE_NODE: "/custom/node24", PATH: "" },
    home: "/home/user",
    pathExists: (p) => p === "/custom/node24" || p === "/usr/bin/node",
    spawn: (cmd) => {
      if (cmd === "/custom/node24") return { status: 0, stdout: "24.0.0\n" };
      if (cmd === "/usr/bin/node") return { status: 0, stdout: "24.18.0\n" };
      return { status: 1, stdout: "" };
    },
  });
  assert.equal(resolved?.path, "/custom/node24");
});

test("resolveEnginesNode: returns null when no engines-compliant node exists", () => {
  const resolved = resolveEnginesNode({
    floor: 24,
    execPath: "/only/node22",
    execVersion: "22.0.0",
    env: { PATH: "/only" },
    home: "/home/user",
    pathExists: (p) => p === "/only/node" || p === "/only/node22",
    spawn: () => ({ status: 0, stdout: "22.0.0\n" }),
  });
  assert.equal(resolved, null);
});

test("envPreferringNode: puts node bin dir first on PATH", () => {
  const env = envPreferringNode("/usr/bin/node", { PATH: "/opt/old:/bin", HOME: "/h" });
  assert.equal(env.PATH?.split(":")[0], "/usr/bin");
  assert.match(env.PATH ?? "", /\/opt\/old/);
  assert.equal(env.AGENT_PIPELINE_ENGINES_NODE, "/usr/bin/node");
  assert.equal(env.AGENT_PIPELINE_ENGINES_NODE_OK, "1");
  assert.equal(env.HOME, "/h");
});

test("runUnderEnginesNode: -c runs bash with PATH preferring engines node", () => {
  /** @type {Array<{ cmd: string, args: string[], opts: object }>} */
  const calls = [];
  const code = runUnderEnginesNode(["-c", "npm run ci:core"], {
    resolve: () => ({ path: "/usr/bin/node", major: 24 }),
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], opts });
      return { status: 0 };
    },
    env: { PATH: "/home/user/.local/bin:/usr/bin" },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "bash");
  assert.deepEqual(calls[0].args, ["-c", "npm run ci:core"]);
  assert.equal(calls[0].opts.env.PATH.split(":")[0], "/usr/bin");
});

test("runUnderEnginesNode: missing engines node exits 1 with a clear message", () => {
  let err = "";
  const code = runUnderEnginesNode(["-c", "true"], {
    resolve: () => null,
    spawn: () => {
      throw new Error("must not spawn");
    },
    stderr: (s) => {
      err += s;
    },
  });
  assert.equal(code, 1);
  assert.match(err, /requires Node >= 24/i);
  assert.match(err, /AGENT_PIPELINE_NODE/);
});

test("package.json ci script routes through ensure-engines-node", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const ci = pkg.scripts?.ci ?? "";
  assert.match(
    ci,
    /ensure-engines-node\.mjs/,
    `ci must invoke ensure-engines-node.mjs; got: ${ci}`,
  );
  // Drift guards elsewhere require these substrings stay in the ci entry.
  assert.ok(ci.includes("ci:scripts"), "ci chain must still list ci:scripts");
  assert.ok(ci.includes("ci:docs"), "ci chain must still list ci:docs");
  assert.ok(ci.includes("ci:core"), "ci chain must still list ci:core");
});

test("probeNodeMajor: live process.execPath reports a finite major", () => {
  const major = probeNodeMajor(process.execPath, {});
  assert.ok(major != null && major >= 1, `expected a real major; got ${major}`);
});

test("formatMissingEnginesNodeDiagnostic: names invoking version, /usr/bin/node, AGENT_PIPELINE_NODE", () => {
  const text = formatMissingEnginesNodeDiagnostic({ invokingVersion: "22.23.2", floor: 24 });
  assert.match(text, /22\.23\.2/);
  assert.match(text, /\/usr\/bin\/node/);
  assert.match(text, /AGENT_PIPELINE_NODE/);
  assert.equal(text.includes("nvm install 24"), false);
});

test("runUnderEnginesNode miss path uses formatMissingEnginesNodeDiagnostic", () => {
  let err = "";
  const code = runUnderEnginesNode(["-c", "true"], {
    resolve: () => null,
    spawn: () => {
      throw new Error("must not spawn");
    },
    stderr: (s) => {
      err += s;
    },
  });
  assert.equal(code, 1);
  const expected = formatMissingEnginesNodeDiagnostic({
    invokingVersion: process.versions.node,
    floor: 24,
  });
  assert.equal(err, expected);
});

test("reexecOntoEnginesNode: Node 22 + fake 24 spawns with argv preserved and PATH prepended", () => {
  /** @type {Array<{ cmd: string, args: string[], opts: object }>} */
  const calls = [];
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/old/node",
    scriptPath: "/skill/scripts/pipeline.mjs",
    argv: ["status"],
    env: { PATH: "/keep-me:/bin" },
    resolve: () => ({ path: "/opt/node24/bin/node", major: 24 }),
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], opts });
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { action: "exit", status: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/opt/node24/bin/node");
  assert.deepEqual(calls[0].args, ["/skill/scripts/pipeline.mjs", "status"]);
  assert.equal(calls[0].opts.env.PATH.split(delimiter)[0], "/opt/node24/bin");
  assert.match(calls[0].opts.env.PATH, /\/keep-me/);
});

test("reexecOntoEnginesNode: Node 18.20.0 and 20.19.0 TypeScript argv also spawn", () => {
  for (const ver of ["18.20.0", "20.19.0"]) {
    /** @type {string[][]} */
    const spawns = [];
    const result = reexecOntoEnginesNode({
      execVersion: ver,
      execPath: "/old/node",
      scriptPath: "/shim.mjs",
      argv: ["train", "--milestone", "data-integrity"],
      resolve: () => ({ path: "/opt/node24/bin/node", major: 24 }),
      spawn: (cmd, args) => {
        spawns.push([cmd, ...args]);
        return { status: 0 };
      },
    });
    assert.equal(result.action, "exit", ver);
    assert.deepEqual(spawns, [
      ["/opt/node24/bin/node", "/shim.mjs", "train", "--milestone", "data-integrity"],
    ]);
  }
});

test("reexecOntoEnginesNode: miss uses formatMissingEnginesNodeDiagnostic", () => {
  let err = "";
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/old/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    resolve: () => null,
    spawn: () => {
      throw new Error("must not spawn");
    },
    stderr: (s) => {
      err += s;
    },
  });
  assert.deepEqual(result, { action: "exit", status: 1 });
  assert.equal(
    err,
    formatMissingEnginesNodeDiagnostic({ invokingVersion: "22.23.2", floor: 24 }),
  );
});

test("reexecOntoEnginesNode: spawn error exits 1 naming the path", () => {
  let err = "";
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/old/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    resolve: () => ({ path: "/opt/node24/bin/node", major: 24 }),
    spawn: () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }),
    stderr: (s) => {
      err += s;
    },
  });
  assert.deepEqual(result, { action: "exit", status: 1 });
  assert.match(err, /\/opt\/node24\/bin\/node/);
  assert.match(err, /ENOENT/);
});

test("reexecOntoEnginesNode: child signal is returned", () => {
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/old/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    resolve: () => ({ path: "/opt/node24/bin/node", major: 24 }),
    spawn: () => ({ status: null, signal: "SIGTERM" }),
  });
  assert.deepEqual(result, { action: "exit", status: 1, signal: "SIGTERM" });
});

test("reexecOntoEnginesNode: major >= 24 continues without spawn", () => {
  const result = reexecOntoEnginesNode({
    execVersion: "24.18.0",
    execPath: "/usr/bin/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  assert.deepEqual(result, { action: "continue" });
});

test("reexecOntoEnginesNode: resolved.path === execPath continues (loop guard)", () => {
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/same/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    resolve: () => ({ path: "/same/node", major: 24 }),
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  assert.deepEqual(result, { action: "continue" });
});

test("reexecOntoEnginesNode: AGENT_PIPELINE_NODE wins through injected pathExists/spawn", () => {
  /** @type {string[]} */
  const spawned = [];
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/old/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    env: { AGENT_PIPELINE_NODE: "/custom/node24", PATH: "/usr/bin" },
    home: "/home/user",
    pathExists: (p) => p === "/custom/node24" || p === "/usr/bin/node",
    spawn: (cmd, args) => {
      if (args[0] === "-p") {
        if (cmd === "/custom/node24") return { status: 0, stdout: "24.0.0\n" };
        if (cmd === "/usr/bin/node") return { status: 0, stdout: "24.18.0\n" };
        return { status: 1, stdout: "" };
      }
      spawned.push(cmd);
      return { status: 0 };
    },
  });
  assert.equal(result.action, "exit");
  assert.deepEqual(spawned, ["/custom/node24"]);
});

test("reexecOntoEnginesNode: /usr/bin/node fallback when AGENT_PIPELINE_NODE is unset", () => {
  /** @type {string[]} */
  const spawned = [];
  const result = reexecOntoEnginesNode({
    execVersion: "22.23.2",
    execPath: "/old/node",
    scriptPath: "/shim.mjs",
    argv: ["status"],
    env: { PATH: "/opt/old" },
    home: "/home/user",
    pathExists: (p) => p === "/usr/bin/node",
    spawn: (cmd, args) => {
      if (args[0] === "-p") {
        if (cmd === "/usr/bin/node") return { status: 0, stdout: "24.18.0\n" };
        return { status: 1, stdout: "" };
      }
      spawned.push(cmd);
      return { status: 0 };
    },
  });
  assert.equal(result.action, "exit");
  assert.deepEqual(spawned, ["/usr/bin/node"]);
});

test("resolveEnginesNode candidate order is execPath, AGENT_PIPELINE_NODE, /usr/bin/node, ~/.local/node-v24, PATH", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "ensure-engines-node.mjs"), "utf8");
  const start = src.indexOf("export function resolveEnginesNode");
  const end = src.indexOf("export function envPreferringNode");
  const body = src.slice(start, end);
  const execIdx = body.indexOf("execMajor != null && execMajor >= floor");
  const envIdx = body.indexOf("env.AGENT_PIPELINE_NODE");
  const usrIdx = body.indexOf('"/usr/bin/node"');
  const localIdx = body.indexOf("node-v24");
  const pathIdx = body.indexOf("env.PATH");
  assert.ok(execIdx >= 0, "execPath-if-satisfying must be first");
  assert.ok(envIdx > execIdx, "AGENT_PIPELINE_NODE after execPath");
  assert.ok(usrIdx > envIdx, "/usr/bin/node after AGENT_PIPELINE_NODE");
  assert.ok(localIdx > usrIdx, "~/.local/node-v24 after /usr/bin/node");
  assert.ok(pathIdx > localIdx, "PATH after ~/.local/node-v24");
});
