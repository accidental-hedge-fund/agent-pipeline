import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";

const REQUIRED_WRAPPER_FILES = Object.freeze([
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
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export async function verifyWrapperArtifact(config, readFile) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(config.wrapper_manifest_file, "utf8"));
  } catch {
    throw new Error("the wrapper artifact manifest is missing or invalid JSON");
  }
  if (
    manifest?.schema_version !== 1 ||
    manifest?.wrapper?.git_commit !== config.wrapper_git_sha ||
    !Array.isArray(manifest?.wrapper?.files) ||
    manifest.wrapper.files.length === 0
  ) {
    throw new Error("the wrapper artifact manifest does not bind the configured wrapper commit");
  }
  const seen = new Set();
  for (const entry of manifest.wrapper.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !entry.path ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
      seen.has(entry.path)
    ) {
      throw new Error("the wrapper artifact manifest contains an invalid file receipt");
    }
    seen.add(entry.path);
    const path = resolve(config.wrapper_dir, entry.path);
    if (!inside(config.wrapper_dir, path)) throw new Error("a wrapper artifact receipt escapes wrapper_dir");
    let body;
    try {
      body = await readFile(path);
    } catch {
      throw new Error(`the wrapper artifact is missing ${entry.path}`);
    }
    if (sha256(body) !== entry.sha256) throw new Error(`the wrapper artifact hash does not match for ${entry.path}`);
  }
  const missing = REQUIRED_WRAPPER_FILES.filter((required) => !seen.has(required));
  const extra = [...seen].filter((path) => !REQUIRED_WRAPPER_FILES.includes(path));
  if (missing.length || extra.length) {
    throw new Error(
      `the wrapper artifact manifest file set is not exact (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
  return { git_commit: config.wrapper_git_sha, file_count: seen.size };
}

export async function verifyFrgPackManifest(config, readFile) {
  let body;
  try {
    body = await readFile(config.frg_pack_manifest);
  } catch {
    throw new Error("the configured FRG pack manifest is missing");
  }
  const hash = sha256(body);
  if (hash !== config.frg_pack_manifest_sha256) {
    throw new Error("the FRG pack manifest hash does not match machine config");
  }
  let manifest;
  try {
    manifest = JSON.parse(body.toString());
  } catch {
    throw new Error("the configured FRG pack manifest is invalid JSON");
  }
  if (manifest?.pack_id !== "factory-gate-v1") throw new Error("the configured FRG pack is not factory-gate-v1");
  return { pack_id: manifest.pack_id, manifest_sha256: hash };
}
