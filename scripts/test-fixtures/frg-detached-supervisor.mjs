import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const packageRoot = process.env.FRG_DETACHED_PACKAGE_ROOT;
const fixtureRoot = process.env.FRG_DETACHED_FIXTURE_ROOT;
const artifacts = process.env.FRG_DETACHED_ARTIFACTS;
if (!packageRoot || !fixtureRoot || !artifacts) throw new Error("missing detached fixture environment");
writeFileSync(path.join(artifacts, "spawned-pid"), `${process.pid}\n`, { mode: 0o600 });
const deadline = Date.now() + 8_000;
while (!existsSync(path.join(artifacts, "go"))) {
  if (Date.now() >= deadline) throw new Error("timed out waiting for transient prepare exit");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const child = spawn(process.execPath, ["--experimental-test-module-mocks", path.join(fixtureRoot, "scripts", "test-fixtures", "frg-detached-fullchain.mjs")], { stdio: "inherit", env: process.env });
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
writeFileSync(path.join(artifacts, "result.json"), JSON.stringify(result), { mode: 0o600 });
process.exit(result.code ?? 1);
