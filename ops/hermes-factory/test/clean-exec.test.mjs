import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { main, parsePrivateEnvironment } from "../lib/clean-exec.mjs";

test("private environment parser accepts only the serialized allowlist", () => {
  assert.deepEqual(
    parsePrivateEnvironment('HOME="/home/user"\nPATH="/usr/bin"\nVALUE="a\\\\b\\\"c"\n'),
    { HOME: "/home/user", PATH: "/usr/bin", VALUE: 'a\\b"c' },
  );
  assert.throws(() => parsePrivateEnvironment('PATH="ok"\nPATH="again"\n'), /invalid/);
  assert.throws(() => parsePrivateEnvironment('BAD="line\\nvalue"\n'), /invalid/);
});

test("clean launcher gives the action child only the private allowlist", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const run = main(
    ["--env-file", "/state/child.env", "--", "/usr/bin/node", "/pipeline.mjs", "single", "905"],
    {
      readEnvironment: async () => ({ PATH: "/usr/bin", HOME: "/home/user" }),
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    },
  );
  await run;
  assert.deepEqual(calls, [{
    command: "/usr/bin/node",
    args: ["/pipeline.mjs", "single", "905"],
    options: { cwd: process.cwd(), env: { PATH: "/usr/bin", HOME: "/home/user" }, stdio: "inherit" },
  }]);
  assert.equal(calls[0].options.env.BUZZ_PRIVATE_KEY, undefined);
  assert.equal(calls[0].options.env.PIPELINE_FRG_ATTESTATION_KEY, undefined);
});
