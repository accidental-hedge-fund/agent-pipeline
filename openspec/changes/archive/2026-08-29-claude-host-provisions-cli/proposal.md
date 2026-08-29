## Why

`scripts/build.mjs` copies `core/` into `plugin/…/core/` (~299 files) and emits one `/pipeline:<verb>.md` file per `OPERATION_SURFACE` entry. CI `--check` fails on a byte-identical core-tree drift. Claude slash-command files are six-line argv wrappers around that copy. The product is the `pipeline` CLI. Claude must get that CLI the same way Codex and Grok do: `install --host claude` stages the launcher, repository core tree, current-main Node resolver, and SKILL, then best-effort prewarms `core/node_modules`. A failed prewarm leaves a retryable install; the first non-version launcher invocation retries and fails visibly if that retry cannot complete. Hosts are short SKILL shims that exec `pipeline <verb>`. They are not a second engine and not a marketplace command pack.

This is v1.40.0 packaging class law under #1046: #1047 completed via PR #1304, this #1048 / PR #1222 reconciliation follows it, and #1049 starts only after both merge results are contained in `main`; #1050 remains on the same ship. It is not a path-local mole. The next host that vendors `core/scripts` into `plugin/` or emits `/pipeline:*` files must fail tests without a new issue.

## What Changes

- **CLI install for Claude.** `install --host claude` SHALL stage the launcher, repository `core/` payload, current-main Node resolver, and Claude SKILL overlay as one install tree. It SHALL attempt `npm ci --omit=dev --no-audit --no-fund` as a best-effort dependency prewarm. Missing `npm` or a non-zero prewarm SHALL warn without failing installation. A failed prewarm SHALL leave dependencies retryable; the first non-version launcher invocation SHALL retry and SHALL fail visibly with manual `npm ci` remediation if that retry fails. Concurrent installers SHALL have one tree publisher and prewarm owner without blocking a first launcher from waiting on that owner's core-local lock. Short SKILL prose remains #1049's downstream scope.
- **No core copy in `plugin/`.** `scripts/build.mjs` SHALL NOT copy `core/scripts` (or any engine source under `core/`) into `plugin/`. **No dual-ship** of the core mirror.
- **No `/pipeline:*` command pack.** Build and install SHALL NOT generate Claude `pipeline:<verb>.md` files or Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`. `OPERATION_SURFACE` remains the verb catalog for docs and the SKILL table. It is not a reason to emit one file per verb.
- **No marketplace command pack.** The generator SHALL NOT emit a per-verb slash-command tree under `plugin/pipeline/commands/`.
- **`--check` is SKILL/catalog freshness.** `node scripts/build.mjs --check` SHALL assert generated SKILL overlay and marketplace catalog freshness only. It SHALL NOT require a byte-identical `plugin/` core tree.
- **Operator-visible CLI verbs unchanged.** `pipeline doctor`, `pipeline status`, `pipeline single`, and the rest of the CLI keyword surface keep their names, arguments, and behavior.
- **Leftover slash files.** Uninstall SHALL still remove leftover `pipeline:*.md` from a previous install so a migrated host is clean.
- **BREAKING** for operators who invoke `/pipeline:status` (and peers) as Claude slash commands, or `$pipeline:status` Codex yaml agents, as the product path. The product path is `pipeline <verb>`.
- **Not this change:** `git rm plugin/` (#1050, same ship). MCP (#907, parked). Splitting `pipeline.ts` (#990 → v1.40.2). Stage machine. Short SKILL rewrite (#1049, follow-on after #1048).

## Acceptance criteria

- [ ] After `node scripts/build.mjs`, the generator has not written `plugin/**/core/scripts/pipeline.ts` (or any `core/scripts` engine source under `plugin/`).
- [ ] `node scripts/build.mjs --check` exits 0 without a byte-identical `plugin/` core tree when generated SKILL overlay and marketplace catalog match.
- [ ] `node scripts/build.mjs --check` exits non-zero when the generated SKILL overlay or marketplace catalog is stale.
- [ ] `install --host claude` (not dry-run) does not write `pipeline:*.md` under the resolved Claude `commands/` directory.
- [ ] `install --host claude` stages the launcher, repository `core/` payload, `scripts/ensure-engines-node.mjs`, and Claude SKILL as one tree, then attempts to prewarm `core/node_modules` (same CLI shape as Codex/Grok).
- [ ] Missing `npm` or a non-zero install-time `npm ci` warns and exits 0 without discarding the installed tree or leaving partial dependencies classified as ready.
- [ ] When dependencies are not ready, the first non-version launcher invocation retries the same `npm ci`; success dispatches the original verb, while failure exits non-zero, names the manual command and installed `core/` path, and remains retryable. `--version` stays dependency-free.
- [ ] Concurrent fresh installers have one publisher and prewarm owner; a competing install or uninstall fails before replacing/removing the tree or starting another `npm ci`.
- [ ] Abandoned installer or core-local dependency ownership fails closed with exact recovery and is never reclaimed until a surviving npm child has been ruled out.
- [ ] After either install-time prewarm or a successful first-run retry, the installed launcher dispatches `doctor` and `status <N>` as CLI verbs. Those verbs do not require a generated slash-command tree or `plugin/**/core/scripts/pipeline.ts`.
- [ ] Codex host install does not write `pipeline-<name>.yaml` command agents from `OPERATION_SURFACE`.
- [ ] `pipeline doctor`, `pipeline status`, and `pipeline single` still dispatch as CLI keywords with unchanged operator-visible contracts.
- [ ] `uninstall --host claude` still deletes leftover `pipeline:*.md` files and does not delete unrelated command files.
- [ ] Unit/smoke tests prove: no vendored `plugin/**/core/scripts/pipeline.ts` required for install; no generated slash-command tree required for install.
- [ ] This change does not `git rm -r plugin/` (that is #1050).
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `cli-host-provision`: Claude install stages the pipeline CLI launcher, repository core tree, current-main Node resolver, and SKILL, then best-effort prewarms dependencies. Failed prewarm remains retryable on the first non-version invocation and fails that invocation visibly if retry cannot complete. The SKILL execs `pipeline <verb>`. Build and install do not vendor `core/scripts` into `plugin/` and do not emit a `/pipeline:*` or Codex yaml command pack. `OPERATION_SURFACE` stays a catalog. `#990` is not required.

### Modified Capabilities

- `namespaced-command-surface`: Retract generated per-verb host command files. Operators invoke `pipeline <verb>`. `OPERATION_SURFACE` is catalog only. Advance default and modifier flags stay as today.
- `installer-command-lifecycle`: Claude install SHALL NOT write `pipeline:*.md`. Uninstall SHALL still remove leftover `pipeline:*.md`. Dry-run still writes nothing.
- `core-mirror-sync`: Golden rule and `--check` SHALL require SKILL/catalog freshness, not a committed `plugin/` core copy.
- `pre-commit-mirror-regen`: The hook SHALL NOT regenerate or stage a `plugin/` core copy. It MAY still run `build.mjs` for SKILL/catalog until #1050.
- `test-gate-ci-parity`: `build.mjs --check` in `npm run ci` SHALL fail on stale SKILL/catalog, not on absence of a byte-identical `plugin/` core tree.
- `loop-skill-orchestration`: Loop long-running follow/notify law stays. It SHALL NOT depend on generated `plugin/pipeline/commands/pipeline:loop.md`.
- `dependency-advisory-hygiene`: The `js-yaml` floor SHALL be enforced on `core/` (and the installed CLI tree). It SHALL NOT require a `plugin/…/core/` lockfile copy.
- `cli-product-packaging`: Retire #1047's temporary `plugin/`-mirror transition clauses after #1048 lands.
- `eval-fixture-contract`: Admit exact pin-resolved generator outputs only. Current pins admit SKILL/catalog outputs; a historical pin may admit an exact core-mirror output only when pinned `scripts/build.mjs` proves it generated that path. Never grant a broad plugin-core mirror exception.
- `eval-fixture-preflight`: Resolve required generator-owned allowances from the fixture's pinned `scripts/build.mjs`; reject broad `plugin/**` boundaries and avoid unrelated current SKILL/catalog requirements for ordinary core edits.
- `generated-cli-reference`: Generate and staleness-check command tables for Claude, Codex, OMP, and OpenCode while comparing packaging freshness to the remaining generated SKILL/catalog gate, not to a core mirror.
- `cli-harness-adapters`: Keep Pi missing-CLI guidance on the maintained npm package without requiring a generated copy of the core adapter source.
- `gh-pr-diff`: Fail closed when the files-list fallback reports a patch-less zero-line `modified` entry without the mode metadata needed for a complete diff.
- `launcher-bootstrap`: Keep resolver staging in the installed skill and generated plugin shell without a copied core tree.
- `monitor-filter-guidance`: Keep host guidance aligned through the generated plugin SKILL overlay, not generated core mirrors.
- `pipeline-loop-facade`: Preserve durable loop behavior while moving host packaging from per-verb command files to CLI/SKILL guidance.
- `pre-merge-module-boundary`: Require packaging freshness without copying moved core modules into `plugin/`.
- `ship-path-autonomy-doctrine`: Retain prompt tests and SKILL/catalog freshness without a copied prompt mirror.
- `stage-inventory-ssot`: Keep the generated Claude SKILL overlay current without a copied core tree.
- `supervisor-recover-parked`: Keep implementation verification tied to SKILL/catalog freshness rather than a core mirror.
- `command-registry`: Keep legacy-flag and detached-run guidance on the direct CLI surface rather than removed per-verb host entries.
- `durable-loop-engine`: Name `pipeline loop` as the invocation of the sole durable state engine.
- `host-neutral-progress-notify`: Keep Grok progress guidance host-neutral while naming the direct `pipeline loop` path.
- `install-version-coherence`: Retarget loop compatibility checks and remediation to `pipeline loop` without weakening the checks.
- `merge-authority-boundary`: Keep merge and `merge-queue --apply` as explicit operator SKILL/CLI surfaces, not generated command files.
- `native-goal-bootstrap`: Put native-goal bootstrap guidance in host SKILLs without claiming generated per-verb command surfaces.
- `readme-user-clarity`: Document durable multi-item work through `pipeline loop` while leaving external goal-loop optional.
- `visual-gate`: Document visual-gate label initialization through `pipeline init`.
- `worktree-capacity-admission`: Document capacity recovery through `pipeline cleanup`.
- `release-sub-command`: Regenerate and stage the exact remaining packaging outputs under both `plugin/` and `.claude-plugin/`, without staging FRG evidence or restoring a plugin core mirror.

## Impact

- **Generator:** `scripts/build.mjs` stops copying `CORE_ENTRIES` into `plugin/` and stops writing `plugin/pipeline/commands/pipeline:<name>.md`. `--check` compares SKILL overlay and `.claude-plugin/marketplace.json` (catalog), not a core tree.
- **Installer:** `scripts/install.mjs` stops `installClaudeCommands` / `installCodexCommands` emission from `OPERATION_SURFACE`. Claude `commandsKind` is not a slash-command pack. Staging of the launcher, repository `core/`, and current-main Node resolver remains the CLI provision path. Install-time `npm ci` is a fail-soft prewarm; the installed launcher owns the fail-closed, retryable first-run path.
- **Hooks / CI:** `.githooks/pre-commit`, `npm run ci` / `build.mjs --check`, `scripts/ci-install-smoke.mjs`, and root `scripts/install.test.mjs` follow the new check and install contracts.
- **Docs / agent rules:** `CLAUDE.md`, `AGENTS.md`, `openspec/project.md`, `docs/concepts.md`, and the host SKILL packaging guidance become CLI + SKILL. They no longer say “always commit the `plugin/` core mirror” or advertise a generated per-verb menu.
- **Depends on:** #1047, completed by PR #1304 at merge commit `0494825bff716f08db9e5ac8869a30e20d338970`. That change added `docs/packaging.md` and transitional packaging specs. This change reconciles those contracts to the post-core-mirror state while rewriting the remaining golden-rule text.
- **Same ship, not this change:** #1050 deletes `plugin/`. Leftover `plugin/` files after the generator stops copying core are #1050’s delete, unless a regenerate side effect drops them. This change MUST NOT restore the copy and MUST NOT claim `git rm plugin/` as its deliverable.
- **Follow-on:** #1049 short SKILL starts only after #1047 is complete and this #1048 / PR #1222 reconciliation is merged. This install points at the current host SKILL overlay; it does not perform the broad short-SKILL rewrite.
- **Does not:** add MCP; split `pipeline.ts`; change the stage machine; merge inside advance/loop; add `auto_merge`.
