// Minimal, dependency-free entry for `pipeline path [--json]` (#153).
//
// The full CLI (`pipeline.ts`) imports `commander`, so it cannot load before
// `core/node_modules` is provisioned. But the desktop discovery contract must
// keep working even when a best-effort postinstall could not install
// dependencies (e.g. a transient/offline/read-only install): an integrator that
// runs `pipeline path --json` needs a machine-readable discovery state, not a
// hard failure with a reinstall hint.
//
// `discovery.ts` depends only on Node built-ins, so this entry can run under
// `node --experimental-strip-types` with no third-party dependencies. The
// launcher routes `pipeline path` here whenever `core/node_modules` is absent;
// the rendering is shared with `handlePathSubcommand` via `formatDiscovery` so
// the two code paths cannot drift.

import { discoverHosts, formatDiscovery } from "./discovery.ts";

const asJson = process.argv.slice(2).includes("--json");

discoverHosts()
  .then((result) => {
    process.stdout.write(formatDiscovery(result, asJson) + "\n");
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`pipeline path: probe error: ${(err as Error).message}\n`);
    process.exit(1);
  });
