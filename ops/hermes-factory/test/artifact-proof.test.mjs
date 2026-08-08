import assert from "node:assert/strict";
import test from "node:test";
import { sha256, verifyWrapperArtifact } from "../lib/artifact-proof.mjs";
import { config } from "./helpers.mjs";

const files = [
  "factory.mjs",
  "lib/artifact-proof.mjs",
  "lib/clean-exec.mjs",
  "lib/config.mjs",
  "lib/controller.mjs",
  "lib/durable-command.mjs",
  "lib/frg-attestor.mjs",
  "lib/frg-runner.mjs",
  "lib/github.mjs",
  "lib/grant.mjs",
  "lib/issue-run-proof.mjs",
  "lib/journal.mjs",
  "lib/model-proof.mjs",
  "lib/native-release.mjs",
  "lib/notices.mjs",
  "lib/redaction.mjs",
  "lib/runtime.mjs",
  "trusted-frg/factory-reliability-gate.ts",
  "trusted-frg/frg-pack-observations.ts",
  "trusted-frg/loop/types.ts",
];

function artifactFixture() {
  const machine = config();
  const bodies = new Map(files.map((path) => [`${machine.wrapper_dir}/${path}`, `body:${path}`]));
  const manifest = {
    schema_version: 1,
    wrapper: {
      git_commit: machine.wrapper_git_sha,
      files: files.map((path) => ({ path, sha256: sha256(bodies.get(`${machine.wrapper_dir}/${path}`)) })),
    },
  };
  bodies.set(machine.wrapper_manifest_file, JSON.stringify(manifest));
  return { machine, bodies, manifest };
}

test("wrapper artifact proof requires the exact closed runtime file set and hashes", async () => {
  const fixture = artifactFixture();
  const readFile = async (path) => {
    if (!fixture.bodies.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return fixture.bodies.get(path);
  };
  const proof = await verifyWrapperArtifact(fixture.machine, readFile);
  assert.equal(proof.file_count, files.length);
  fixture.bodies.set(`${fixture.machine.wrapper_dir}/lib/controller.mjs`, "changed");
  await assert.rejects(() => verifyWrapperArtifact(fixture.machine, readFile), /hash does not match/);
});

test("wrapper artifact proof rejects omitted or extra executable files", async () => {
  for (const mutate of [
    (manifest) => manifest.wrapper.files.pop(),
    (manifest) => manifest.wrapper.files.push({ path: "lib/unreviewed.mjs", sha256: sha256("extra") }),
  ]) {
    const fixture = artifactFixture();
    mutate(fixture.manifest);
    fixture.bodies.set(fixture.machine.wrapper_manifest_file, JSON.stringify(fixture.manifest));
    await assert.rejects(
      () => verifyWrapperArtifact(fixture.machine, async (path) => fixture.bodies.get(path) ?? "extra"),
      /file set is not exact/,
    );
  }
});
