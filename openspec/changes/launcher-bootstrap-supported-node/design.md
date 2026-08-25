## Context

See `proposal.md` for why. Current law and code:

- `hosts/_shared/entry.template.mjs` gates `nodeMajor < 24` at lines 91–98 and only then short-circuits `--version` / `-V` at lines 194–211. `scripts/pipeline-launcher.mjs` gates at lines 24–31, before version handling. Both print `requires Node >= 24 … nvm install 24 && nvm use 24` and exit 1.
- `--version` reads `core/package.json` and optional `git rev-parse HEAD`. It does not load TypeScript. `--version --json` emits `{ version, commit_sha }` (`commit_sha` is exact 40-hex or `null`).
- `scripts/ensure-engines-node.mjs` already exports `resolveEnginesNode`, `envPreferringNode`, and `runUnderEnginesNode`. Candidate order: satisfying `process.execPath`, then `AGENT_PIPELINE_NODE`, `/usr/bin/node`, `~/.local/node-v24/bin/node`, then `PATH`. `npm run ci` uses this wrapper. The launchers do not.
- Installer `stageInto` writes `scripts/pipeline.mjs` from the template and copies `hosts/_shared/material-filter.mjs`. It does not copy `ensure-engines-node.mjs`. `scripts/build.mjs` does the same for `plugin/pipeline/skills/pipeline/scripts/`.
- Observed host (2026-08-24): PATH `node` 22.23.2, `/usr/bin/node` 24.18.0, package version `1.39.12`.
- Living `packaging-coherence` refuses a root `engines.node` that admits majors below 24. That gate stays.
- Living `cli-version-flag` requires version from `core/package.json` and a pre-`npm ci` short-circuit. It is silent on the Node major of the invoking process.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is one OMP `$pipeline --version` / `$pipeline train --milestone data-integrity` on PATH Node 22.23.2 with `/usr/bin/node` 24.18.0. The class is: launchers treat PATH `node` as the engine runtime and fail closed before introspection or re-exec, even when an engines-compliant binary is already installed. An OMP-only `execPath` pin, or a host-local “use `/usr/bin/node`” mole, leaves `pipeline-launcher.mjs` and every other host broken.
2. **Shared surfaces.** The walker stays `scripts/ensure-engines-node.mjs`. Both launchers reuse it. Installer and `build.mjs` stage that file next to the shim. Fail-closed diagnostics are shared. No new `BlockerKind`, recovery recipe, merge path, or second candidate walker.
3. **Next identical fault.** The next host whose PATH `node` is 22 with Node 24 elsewhere uses the same bootstrap. Tests fail if `--version` still hits the gate on `22.23.2`, if `status`/`train` skip re-exec, or if fail-closed omits `AGENT_PIPELINE_NODE`. No new mole issue for the same PATH-22 layout.

## Goals / Non-Goals

**Goals:**

- Version-only argv is introspection-compatible on Node 18–23 with no engines-compliant Node.
- Every TypeScript-loading route re-execs onto resolved Node ≥ 24 and preserves argv / PATH-prefer.
- Fail closed only on a resolver miss, with the three named sources in the diagnostic.
- One walker: `ensure-engines-node.mjs`. Staged as a standard shared-launcher asset.
- Biting tests for the 22.23.2 cases on both launchers, injectable so CI does not need a Node 22 image.
- `engines.node` stays `>=24`.

**Non-Goals:**

- Pinning a Node 24 absolute path into OpenCode / SKILL.md command templates.
- Adding an OMP host (#1235).
- Changing operator PATH.
- Lowering `engines.node` or compiling `pipeline.ts` to JS.
- Treating Node 20 as an engine runtime.
- A second recoverer, merge-inside-advance, or papercut policy change.

## Decisions

### 1. Version short-circuit runs before any engines gate or resolver load

**Choice:** Keep `--version` / `-V` / `--version --json` on node builtins only (`fs`, `child_process` for `git rev-parse`). Run that block before the major check and before loading `ensure-engines-node.mjs`.

**Why:** ESM static imports evaluate before any statement. A static `import` of a sibling `./ensure-engines-node.mjs` makes `node hosts/_shared/entry.template.mjs --version` fail module load in the repo (the template is not a sibling of the resolver). Version must work from that path (AC1) and without a Node ≥ 24 binary.

**Alternatives considered:**

- Static import with a `__ENSURE_ENGINES_NODE_SPEC__` placeholder → rejected. Unreplaced specifier breaks AC1.
- Static import of `../../scripts/ensure-engines-node.mjs` in the template, rewritten at install/build → works, but version would still load the resolver and the rewrite is a brittle string replace. Dynamic load after version is simpler.
- Compile version into the shim at install time → rejected. Living `cli-version-flag` forbids a baked version string.

### 2. Re-exec is spawn of the resolved absolute binary, not a second walker

**Choice:** After version handling, if `parseNodeMajor(process.versions.node) < 24`, dynamically import `ensure-engines-node.mjs`, call `resolveEnginesNode`, and `spawnSync(resolved.path, [scriptPath, ...argv], { env: envPreferringNode(resolved.path), stdio: "inherit" })`. Exit with the child status. If `resolved.path === process.execPath`, continue (should not happen when major < 24).

Locate the resolver with a two-entry existsSync list, not a Node-version walker:

1. `join(here, "ensure-engines-node.mjs")` — installed skill, plugin mirror, `scripts/pipeline-launcher.mjs`
2. `join(here, "..", "..", "scripts", "ensure-engines-node.mjs")` — repo `hosts/_shared/entry.template.mjs`

That list is module location. Candidate Node binaries stay solely in `resolveEnginesNode`.

**Why:** Direct exec of the resolved path matches “re-exec onto a resolved Node ≥ 24 binary.” `envPreferringNode` already sets `PATH` and `AGENT_PIPELINE_ENGINES_NODE`. Child `process.execPath` is Node ≥ 24, so the gate is a no-op and there is no re-exec loop.

**Alternatives considered:**

- Shell out to `node scripts/ensure-engines-node.mjs -- node <shim> …` → extra hop; child argv0 is `node` via PATH lookup rather than the resolved absolute path.
- Duplicate the `/usr/bin/node` probe in each shim → rejected. Locked: sole resolver.
- `process.execPath` rewrite without spawn → not possible in-process.

### 3. Fail-closed diagnostic is shared and names three sources

**Choice:** Export a small diagnostic helper from `ensure-engines-node.mjs` (or keep the existing `runUnderEnginesNode` miss text and extend it) so both launchers print the same miss. Required substrings: the invoking `process.versions.node`, `/usr/bin/node`, and `AGENT_PIPELINE_NODE`. Do not lead with `nvm install 24`. When `/usr/bin/node` or `AGENT_PIPELINE_NODE` is already ≥ 24, this path is not taken (re-exec succeeded).

**Why:** Today’s `nvm install 24` line is the false instruction from the 2026-08-24 incident. `runUnderEnginesNode` already names `AGENT_PIPELINE_NODE` and `/usr/bin/node`; extend that rather than invent a third message.

**Alternatives considered:**

- Keep the nvm line and add `/usr/bin/node` as a footnote → still lies when 24 is installed.
- Probe `/usr/bin/node` in the shim to customize the message → that’s a second walker. Let the resolver miss, then name the sources it considered.

### 4. Staging copies the resolver next to the shim

**Choice:** `scripts/install.mjs` `stageInto` and `scripts/build.mjs` plugin generation copy `scripts/ensure-engines-node.mjs` into the skill `scripts/` directory next to `pipeline.mjs` (same pattern as `material-filter.mjs`). `ci-install-smoke` / installer tests assert the file exists after install. Regenerated `plugin/` is committed with the source change.

**Why:** Installed trees are `…/skills/pipeline/scripts/pipeline.mjs`. A relative import or dynamic sibling load only works if the file is there. The npm package already includes `scripts/` in `"files"`, so `pipeline-launcher.mjs` needs no extra publish step.

**Alternatives considered:**

- Inline `resolveEnginesNode` into the template → rejected. Two walkers the next time CI resolver policy changes.
- Import from `core/scripts/` → core is TypeScript and not the install `scripts/` surface.

### 5. Tests inject node version; spawn tests may patch `process.versions.node`

**Choice:** Export bootstrap helpers from `ensure-engines-node.mjs` (`parseNodeMajor` already exists) so unit tests pass `execVersion: "22.23.2"`, a fake `resolve`, and a fake `spawn`. Those tests MUST fail against today’s gate-first shims.

Additionally:

- `--version` on the real shim files: spawn with an ESM `--import` preload that defines `process.versions.node` as `22.23.2`. Version short-circuit does not call the resolver, so a live `/usr/bin/node` 24 does not interfere.
- Re-exec spawn: same version patch plus `AGENT_PIPELINE_NODE` pointing at a fake binary that reports `24.0.0` for `-p process.versions.node` and records argv otherwise. `AGENT_PIPELINE_NODE` is the first resolver candidate after a too-old execPath, so a real `/usr/bin/node` 24 does not steal the spawn.
- Fail-closed: injectable resolver-miss test (a live `/usr/bin/node` 24 would otherwise succeed). Assert `AGENT_PIPELINE_NODE` in the diagnostic.

Cover both launcher files. No real network or git. No live Node 22 image required.

**Why:** CI is Node ≥ 24. `process.versions.node` cannot be 22.23.2 without a patch or injection. The 2026-08-24 strings (`22.23.2`, `AGENT_PIPELINE_NODE`, `status` / `train`) must appear in tests that fail before the fix.

**Alternatives considered:**

- Skip spawn tests unless `which node22` exists → would not bite on CI.
- Only source-order assertions (“gate after version”) → would not prove re-exec argv or fail-closed text.

### 6. engines.node stays >=24; packaging-coherence is unchanged

**Choice:** Do not edit root or `core/` `engines.node`. Do not add a spec delta to `packaging-coherence`. TypeScript still runs only on Node ≥ 24 via native type-stripping.

**Why:** Supported Node 22 is a bootstrap problem, not an engine-runtime problem. Lowering the floor would violate living packaging law and this issue’s out-of-scope list.

## Risks / Trade-offs

- **[Risk] Dynamic import of the resolver fails on a stale install that has a new shim but no staged `ensure-engines-node.mjs`.** → Mitigation: installer + `build.mjs` copy the file; install-smoke asserts it; fail closed names the missing module rather than loading TypeScript on Node 22.
- **[Risk] `process.versions.node` patch via `--import` is ignored on some Node builds.** → Mitigation: injectable helper tests remain the hermetic gate; spawn tests assert the patch took (`process.versions.node` in a tiny probe) or skip that spawn if the patch cannot stick.
- **[Risk] Re-exec loses flags such as `NODE_OPTIONS` or host-injected env.** → Mitigation: `envPreferringNode` spreads the parent env and only prepends `PATH`. No env wipe.
- **[Risk] Version-on-18 uses APIs missing on Node 18.** → Mitigation: version path stays on `fs` / `spawnSync` / `JSON.parse` / `import.meta.url`, all present in Node 18. Resolver is not loaded on that path.
- **[Trade-off] Two launchers still contain glue (locate resolver, call re-exec).** Accepted: the walker is not duplicated. Extracting a third shared file recreates the layout problem.

## Migration Plan

- No operator migration. Install or update the skill / package so staged `ensure-engines-node.mjs` sits next to `pipeline.mjs`.
- Rollback: revert the change. PATH Node 22 fails closed again as today.
- No data migration. No label or config schema change.

## Open Questions

None. Locked issue decisions already fix introspection vs re-exec vs sole resolver vs staging.
