# #1236 Revised plan — launcher bootstrap on supported Node

## Status

- [x] Plan review NEEDS_REVISION incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation (launchers + `ensure-engines-node.mjs` helpers + staging)
- [x] Tests in `scripts/launcher-bootstrap.test.mjs` and `scripts/ensure-engines-node.test.mjs`
- [x] `node scripts/build.mjs` after `hosts/_shared/` edits; regenerated `plugin/`
- [x] `npm run ci`

## Locked decisions (post plan-review)

1. Version short-circuit is sync, builtins-only, and runs before any resolver import or Node-floor check.
2. Resolver load uses two module paths (installed sibling, then repo `hosts/_shared` → `../../scripts/`). No static sibling import.
3. Shared DI seam: `reexecOntoEnginesNode` + `formatMissingEnginesNodeDiagnostic` in `ensure-engines-node.mjs`. Tests cover the helper **and** each launcher file.
4. Every major `< 24` (including 18/20) re-execs or fails closed before TypeScript. Child argv is `[scriptPath, ...userArgs]`. PATH is prepended, not replaced.
5. Miss diagnostic names invoking version, `/usr/bin/node`, and `AGENT_PIPELINE_NODE`. No `nvm install 24`.
6. `engines.node` stays `>=24`. No tester-suite pass claim.

See `openspec/changes/launcher-bootstrap-supported-node/design.md`.

---

# Grill-with-docs — #1235 OMP host and #1236 launcher bootstrap

## Plan

- [x] Ground the two issue contracts in the current launcher, installer, and OMP documentation.
- [x] Resolve the first design frontier with the operator.
- [x] Record the agreed host and launcher terms in `CONTEXT.md`.
- [x] Test the remaining lifecycle and failure-boundary decisions with the operator.
- [x] Open #1240 in milestone v1.39.13 for separate cross-host repository-policy enforcement; it is not a #1235 dependency.
- [x] Append locked decisions to #1235 and #1236.
- [x] Review the documentation diff and run `npm run ci` (exit 0).

## Review

- Documentation terminology matches the locked issue decisions.
- `npm run ci` passed on 2026-08-25.
- The gate generated an unrelated `.gitignore` artifact block in this worktree; it was removed and is not part of this documentation change.

## Locked decisions

1. OMP installs only to the user-global `~/.omp/agent` root; project `.omp` is not installer-managed.
2. OMP's `/pipeline` is a native, non-LLM TypeScript command. It invokes the installed launcher with the session working directory and exact user argv. Its initial lifecycle surface is `stdout_only`; existing CLI detach, run-store, and event commands remain the durable path.
3. Node 18–23 compatibility is introspection-only: `--version`, `-V`, and version JSON run without Node 24. Every TypeScript-loading command, including `path`, resolves and re-execs Node >=24.
4. `ensure-engines-node.mjs` remains the sole resolver. The installer stages it as a standard shared-launcher asset rather than duplicating resolver logic into host launchers.
5. A runnable repository must declare both harness roles in `.github/pipeline.yml`; host profiles must not choose stage workers. The current profile fallback conflicts with this policy and needs an explicit implementation boundary.
6. OMP's generated TypeScript command invokes `scripts/pipeline.mjs` with the absolute `process.execPath` captured by `install.mjs`; it uses neither a shell nor PATH `node`.
7. OMP has an `omp` profile only because the current launcher/config interface requires one before repository configuration is read. Required repository policy means that profile cannot choose live workers.
8. Strict repository-policy enforcement is a separate cross-host issue, not an execution dependency of #1235.

---

# #1223 Revised plan — getPrDiff files-API fallback

## Status

- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation (`core/scripts/gh.ts` only for helper + classifier)
- [x] Tests in `core/test/gh.test.ts` (injectable runner; prove 406 + omitted-text tests fail on current helper)
- [x] OpenSpec change `getprdiff-files-api-fallback` kept in sync
- [x] `node scripts/build.mjs` after any `core/` edit
- [x] `npm run ci`

## Locked decisions (post plan-review)

1. Fast path stays `gh pr diff -R cfg.repo` with `retries: 1`. 406 is not transient.
2. Fallback is `gh api repos/${cfg.repo}/pulls/${n}/files?per_page=100 --paginate --slurp`, flattened as `T[][]` (live PR #1222: 4 pages, 377 files).
3. Omitted text (`patch` missing, `changes > 0`) is materialized from git blobs / contents. Header-only is only for `changes === 0`.
4. Flattened length `>= 3000` throws. No silent prefix.
5. Same `cfg.repo` as fast path. No `--hostname`. No `git diff`. No caller signature change.
6. OpenSpec delta lives at `openspec/changes/getprdiff-files-api-fallback/`.

See that change's `design.md` for the full contract.

## Results

- `getPrDiff` tries `gh pr diff` first (`retries: 1`). HTTP 406 / too-large falls back to paginated files-list composition.
- Omitted text patches (`patch` absent, `changes > 0`) are materialized from git blobs / contents. A 3000-file list throws.
- Tests: `core/test/gh.test.ts` (injectable runner; 50 passing including #1223 cases).
- `openspec validate getprdiff-files-api-fallback`: valid.
- `node scripts/build.mjs --check`: clean.
- `npm run ci`: exit 0.
