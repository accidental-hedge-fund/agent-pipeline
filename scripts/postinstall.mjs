#!/usr/bin/env node
// Best-effort core dependency provisioning at install time (#153).
//
// Provisioning core/node_modules during `npm install` (while the package dir is
// still writable) means the `pipeline` launcher never has to mutate a possibly
// read-only global package directory at command time — that was the read-only
// regression an earlier review round flagged.
//
// But this step MUST be best-effort. A transient registry outage, an offline
// install, an npm cache-permission problem, or an engine-strict mismatch must
// NOT abort the package install: existing flows such as
// `npx github:accidental-hedge-fund/agent-pipeline install` reach
// `scripts/install.mjs`, whose own per-host `npm ci` is intentionally
// best-effort (warn, don't fail). A fatal root postinstall turned that
// recoverable warning into a hard pre-installer failure. So we always exit 0;
// the installer and the launcher each retain their own fallback / diagnostic
// for missing dependencies.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const coreDir = path.join(root, "core");

const result = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: coreDir,
  stdio: "inherit",
});

if (result.error || result.status !== 0) {
  const why = result.error
    ? result.error.message
    : `exit ${result.status ?? `signal ${result.signal}`}`;
  console.warn(
    `[agent-pipeline] postinstall: best-effort core dependency provisioning did not ` +
      `complete (${why}). Package install continues; the installer and the ` +
      `\`pipeline\` launcher provision or diagnose core dependencies on demand.`,
  );
}

// Provisioning is best-effort by contract — never abort the package install.
process.exit(0);
