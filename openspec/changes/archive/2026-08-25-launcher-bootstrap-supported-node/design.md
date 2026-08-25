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
- Every TypeScript-loading route on **any** Node major `< 24` (including 18 and 20) re-execs onto resolved Node ≥ 24, or fails closed. TypeScript never loads on the parent.
- Fail closed only on a resolver miss, with a shared diagnostic that names the three sources.
- One walker: `ensure-engines-node.mjs`. Staged as a standard shared-launcher asset.
- One injectable bootstrap seam (`reexecOntoEnginesNode` + `formatMissingEnginesNodeDiagnostic`) shared by both launchers. Tests cover that seam **and** each launcher file's wiring.
- Biting tests for the 22.23.2 cases on both launchers, injectable so CI does not need a Node 22 image.
- `engines.node` stays `>=24`.

**Non-Goals:**

- Pinning a Node 24 absolute path into OpenCode / SKILL.md command templates.
- Adding an OMP host (#1235).
- Changing operator PATH.
- Lowering `engines.node` or compiling `pipeline.ts` to JS.
- Treating Node 20 as an engine runtime (re-exec parent only).
- A second recoverer, merge-inside-advance, or papercut policy change.
- Changing living `--version` token detection (`rawArgs.includes("--version") || rawArgs.includes("-V")`).

## Bootstrap module layout

`entry.template.mjs` is not a sibling of the resolver in the repository. It is a sibling after install/build.

| Location of the running file | Resolver path (first existing wins) |
| --- | --- |
| Installed / plugin: `…/skills/pipeline/scripts/pipeline.mjs` | `join(here, "ensure-engines-node.mjs")` |
| Repo: `scripts/pipeline-launcher.mjs` | `join(here, "ensure-engines-node.mjs")` |
| Repo: `hosts/_shared/entry.template.mjs` | `join(here, "..", "..", "scripts", "ensure-engines-node.mjs")` |

This list is **module location**. It is not a Node-binary walker. Candidate binaries stay solely in `resolveEnginesNode`.

Neither launcher SHALL static-import `ensure-engines-node.mjs` at top level. A static sibling import makes `node hosts/_shared/entry.template.mjs --version` fail module load in the repo.

Order of work in both launchers:

1. Read `core/package.json` with node builtins (`fs`).
2. Version short-circuit (`--version` / `-V` / `--version --json`) using only builtins + optional `git rev-parse`. Exit. No resolver load. No major gate. No TypeScript.
3. If `parseNodeMajor(process.versions.node) < 24`: `existsSync` the two module paths above, dynamic-`import()` the first hit, call `reexecOntoEnginesNode`. Exit with the helper result. Do not continue into TypeScript on the parent.
4. Remainder of today's launcher (corrupt-install, `path` fast-path, `npm ci`, spawn `pipeline.ts` / `path-cli.ts`) runs only on Node ≥ 24.

If the resolver module is missing after step 2, fail closed. Do not load TypeScript. Name the missing path.

## Decisions

### 1. Version short-circuit runs before any engines gate or resolver load

**Choice:** Keep `--version` / `-V` / `--version --json` on node builtins only (`fs`, `child_process` for `git rev-parse`). Run that block before the major check and before loading `ensure-engines-node.mjs`. Token detection stays `rawArgs.includes("--version") || rawArgs.includes("-V")` (living contract). `--json` without those flags is not version introspection.

**Why:** ESM static imports evaluate before any statement. A static `import` of a sibling `./ensure-engines-node.mjs` makes `node hosts/_shared/entry.template.mjs --version` fail module load in the repo. Version must work from that path (AC1) and without a Node ≥ 24 binary. Mixed argv such as `status --version` already short-circuits today; this issue does not change that.

**Alternatives considered:**

- Static import with a `__ENSURE_ENGINES_NODE_SPEC__` placeholder → rejected. Unreplaced specifier breaks AC1.
- Static import of `../../scripts/ensure-engines-node.mjs` in the template, rewritten at install/build → works, but version would still load the resolver and the rewrite is a brittle string replace. Dynamic load after version is simpler.
- Compile version into the shim at install time → rejected. Living `cli-version-flag` forbids a baked version string.
- Treat only "pure" version argv as introspection → rejected. Would change Node ≥ 24 behavior (`status --version`) outside this issue.

### 2. Shared injectable seam: `reexecOntoEnginesNode` + `formatMissingEnginesNodeDiagnostic`

**Choice:** Export two helpers from `scripts/ensure-engines-node.mjs`. Both launchers call them after the version short-circuit. Tests inject `resolve`, `spawn`, `env`, `execPath`, `execVersion`, and `stderr`. Do not add a third bootstrap file.

`reexecOntoEnginesNode(opts)`:

- If `parseNodeMajor(execVersion) >= floor`, return `{ action: "continue" }` (no spawn).
- Else `resolveEnginesNode({ floor, execPath, execVersion, env, … })`.
- Miss → write `formatMissingEnginesNodeDiagnostic({ invokingVersion: execVersion, floor })`, return `{ action: "exit", status: 1 }`.
- Hit with `resolved.path === execPath` → return `{ action: "continue" }` (loop guard; should not happen when major < 24).
- Hit otherwise → `spawn(resolved.path, [scriptPath, ...argv], { env: envPreferringNode(resolved.path, env), stdio: "inherit" })`.
  - Child argv is exactly the script path plus original user args in order. No inserted `--` / profile / strip-types flags at this hop (those stay in the ≥24 remainder, as today).
  - `PATH` is the resolved binary's directory **prepended** to the parent `PATH`, not a replacement (`envPreferringNode` already does this).
  - Spawn error (`result.error`) → diagnostic naming `resolved.path` and the error message; `{ action: "exit", status: 1 }`.
  - Child signal (`result.signal`) → `{ action: "exit", status: 1, signal }`. The launcher re-sends that signal to itself when possible, else exits 1.
  - Else `{ action: "exit", status: result.status ?? 1 }`.

`formatMissingEnginesNodeDiagnostic` is a pure string builder. Required substrings: the invoking version (e.g. `22.23.2`), `/usr/bin/node`, and `AGENT_PIPELINE_NODE`. It SHALL NOT contain `nvm install 24`. Launchers SHALL NOT probe `/usr/bin/node` or `AGENT_PIPELINE_NODE` themselves to build this text. `runUnderEnginesNode` miss text SHALL call the same helper.

**Why:** Review required a testable DI seam and a diagnostic structured enough that launchers do not duplicate probes. `runUnderEnginesNode` argv is "run this command under engines Node" (CI wrapper). Launcher re-exec argv is "re-invoke this script with a different `execPath`". Keep those contracts separate. One new export, same file.

**Alternatives considered:**

- Only source-order assertions on the launchers → would not prove argv / PATH / diagnostic.
- A third `launcher-bootstrap.mjs` → another staged asset and the same layout problem.
- Overload `runUnderEnginesNode` → would mix CI `-c` / `--` dispatch with shim re-exec.

### 3. Re-exec is spawn of the resolved absolute binary; every major < 24

**Choice:** After version handling, **every** TypeScript-loading route on Node major `< 24` — including 18 and 20, not only 22 — must call the seam before any `.ts` load. Routes include `status`, `train`, `path`, `path --json`, and a bare invoke. Node 18–23 introspection does not extend to TypeScript execution. EOL Node is not an engine runtime; it is only a legal bootstrap parent.

Child `process.execPath` is the resolved ≥24 binary. Downstream `path-cli.ts` / `pipeline.ts` spawns that already use `process.execPath` therefore stay on the selected Node. There is no re-exec loop: the child major is ≥ 24, so the helper returns `continue`.

**Why:** Review required an explicit rule for 18/20. A 22-only re-exec would load TypeScript on Node 18/20 if those processes reached the remainder. Locked issue text already says every TypeScript-loading route re-execs Node ≥ 24 before loading the core.

**Alternatives considered:**

- Fail closed immediately on majors `< 22` without resolving → extra branch, still needs the resolver for the miss text, and would refuse a Node 18 parent that has `/usr/bin/node` 24.
- `process.execPath` rewrite without spawn → not possible in-process.

### 4. Staging copies the resolver next to the shim

**Choice:** `scripts/install.mjs` `stageInto` and `scripts/build.mjs` plugin generation copy `scripts/ensure-engines-node.mjs` into the skill `scripts/` directory next to `pipeline.mjs` (same pattern as `material-filter.mjs`). `ci-install-smoke` / installer tests assert the file exists after install. Regenerated `plugin/` is committed with the source change. Every module a generated shim imports at bootstrap MUST be staged (today: `ensure-engines-node.mjs` only; no third file).

**Why:** Installed trees are `…/skills/pipeline/scripts/pipeline.mjs`. A relative import or dynamic sibling load only works if the file is there. The npm package already includes `scripts/` in `"files"`, so `pipeline-launcher.mjs` needs no extra publish step.

**Alternatives considered:**

- Inline `resolveEnginesNode` into the template → rejected. Two walkers the next time CI resolver policy changes.
- Import from `core/scripts/` → core is TypeScript and not the install `scripts/` surface.

### 5. Tests inject node version; they cover the helper AND each launcher file

**Choice:** Two layers. Both are required.

**Layer A — helper (hermetic DI).** `scripts/ensure-engines-node.test.mjs` passes `execVersion: "22.23.2"` (and `"18.20.0"`, `"20.19.0"`) into `reexecOntoEnginesNode` / `resolveEnginesNode` with fake `resolve` / `spawn` / `pathExists`. These tests MUST fail against today's `runUnderEnginesNode` miss text if `AGENT_PIPELINE_NODE` is dropped, and they MUST fail if re-exec skips spawn. This layer owns:

- `AGENT_PIPELINE_NODE` precedence
- `/usr/bin/node` fallback (do not use the live CI `/usr/bin/node` as the only proof)
- fail-closed naming all three sources
- PATH prepend (not replace)
- spawn error / signal / status propagation
- loop guard (`resolved.path === execPath` → continue)
- Node 18/20 TypeScript routes re-exec or fail closed

**Layer B — actual launcher wiring.** `scripts/launcher-bootstrap.test.mjs` drives `hosts/_shared/entry.template.mjs` and `scripts/pipeline-launcher.mjs` themselves (not only the helper). Pattern: `core/test/version.test.ts` already copies the template into a fake install layout and spawns it. Extend that:

- `--version` / `-V` / `--version --json` with an ESM `--import` preload that sets `process.versions.node` to `22.23.2`. No resolver required. `commit_sha` is `null` or `/^[0-9a-f]{40}$/`; tests do not invent a SHA and do not require real git (omit `git` from PATH to force `null`).
- Mixed argv: `status --version` still short-circuits (includes-detection). `path --json` and bare `status` / `train --milestone data-integrity` do **not**.
- Re-exec spawn: same version patch plus `AGENT_PIPELINE_NODE` pointing at a fake binary that reports `24.0.0` for `-p process.versions.node` and records argv otherwise. `AGENT_PIPELINE_NODE` is the first resolver candidate after a too-old execPath, so a real `/usr/bin/node` 24 does not steal the spawn. Assert child argv is `[scriptPath, ...userArgs]` in order and child `PATH` starts with that binary's directory.
- Installed-template resolution: copy the template to `<tmp>/scripts/pipeline.mjs` **with** a sibling `ensure-engines-node.mjs` and run `status` under the version patch; the generated shim must load the sibling. Copy **without** the sibling and run `--version`; it must still exit 0 (repo-template layout).
- Source assertions on both launcher files: no static `import` of the resolver; no duplicated candidate list (`~/.local/node-v24`, PATH-split walker); version short-circuit text appears before `ensure-engines-node`; no `nvm install 24` string.

If the `--import` patch cannot stick on a given Node build, skip that spawn and keep Layer A as the hermetic gate — do not silently pass. Record the skip in the test output.

No real network. No live Node 22 image.

**Why:** CI is Node ≥ 24. `process.versions.node` cannot be 22.23.2 without a patch or injection. Review required tests of each launcher's wiring, not only a helper. Fail-closed and `/usr/bin/node` cannot be proven by spawning the real launcher on a box that already has `/usr/bin/node` 24; those cases stay on the injected seam.

**Alternatives considered:**

- Skip spawn tests unless `which node22` exists → would not bite on CI.
- Only source-order assertions → would not prove re-exec argv.

### 6. engines.node stays >=24; packaging-coherence is unchanged; Node 18 syntax is a bootstrap constraint

**Choice:** Do not edit root or `core/` `engines.node`. Do not add a spec delta to `packaging-coherence`. TypeScript still runs only on Node ≥ 24 via native type-stripping. Bootstrap files (`hosts/_shared/entry.template.mjs`, `scripts/pipeline-launcher.mjs`, `scripts/ensure-engines-node.mjs`) SHALL use only APIs already valid on Node 18: `fs` / `path` / `child_process.spawnSync` / `url.fileURLToPath` / `url.pathToFileURL` / `import.meta.url` / dynamic `import()` / `Number.parseInt`. They SHALL NOT use `import.meta.dirname` (Node 20.11+ / 21.2+). Version-only handling and the re-exec helper must parse and run on Node 18 because that process is the parent.

**Why:** Supported Node 22 is a bootstrap problem, not an engine-runtime problem. Lowering the floor would violate living packaging law. Version-on-18 is an acceptance criterion; the resolver must load on that same parent for non-version argv.

Keep the existing `packaging-coherence.test.mjs` case `root engines >=18 with core >=24 fails`.

## Risks / Trade-offs

- **[Risk] Dynamic import of the resolver fails on a stale install that has a new shim but no staged `ensure-engines-node.mjs`.** → Mitigation: installer + `build.mjs` copy the file; install-smoke asserts it; fail closed names the missing module rather than loading TypeScript on Node 22.
- **[Risk] `process.versions.node` patch via `--import` is ignored on some Node builds.** → Mitigation: injectable helper tests remain the hermetic gate; spawn tests assert the patch took or skip that spawn if the patch cannot stick.
- **[Risk] Re-exec loses flags such as `NODE_OPTIONS` or host-injected env.** → Mitigation: `envPreferringNode` spreads the parent env and only prepends `PATH`. No env wipe.
- **[Risk] Version-on-18 uses APIs missing on Node 18.** → Mitigation: version path stays on `fs` / `spawnSync` / `JSON.parse` / `import.meta.url`. Resolver and re-exec helper stay on the same API set. Source assertion bans `import.meta.dirname`.
- **[Risk] Re-exec loop if the child still sees major < 24.** → Mitigation: spawn the resolved absolute path so `process.execPath` is that binary; helper continues when major ≥ 24 or `resolved.path === execPath`.
- **[Trade-off] Two launchers still contain glue (locate resolver, call re-exec).** Accepted: the walker is not duplicated. Extracting a third shared file recreates the layout problem.
- **[Check] Tester-suite evidence is not claimed.** Done means Layer A + Layer B tests fail without the fix and pass with it, `node scripts/build.mjs --check` is clean, and `npm run ci` is green. Do not claim a tester-suite pass.

## Migration Plan

- No operator migration. Install or update the skill / package so staged `ensure-engines-node.mjs` sits next to `pipeline.mjs`.
- Rollback: revert the change. PATH Node 22 fails closed again as today.
- No data migration. No label or config schema change.

## Open Questions

None. Locked issue decisions already fix introspection vs re-exec vs sole resolver vs staging. Plan-review required layout, DI seam, `<24` including 18/20, structured miss diagnostic, re-exec argv/PATH/exit semantics, and extra tests; those are decisions 1–6 above.
