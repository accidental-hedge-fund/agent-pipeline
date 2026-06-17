## 1. CLI dispatch wiring

- [ ] 1.1 Add `release` to the `.argument()` help text in `core/scripts/pipeline.ts` alongside `init`, `doctor`, `logs`, `path`, `config`, `run`.
- [ ] 1.2 Add `const isReleaseCommand = numArg === "release"` dispatch variable in `pipeline.ts` (mirroring the `isDoctorCommand` pattern).
- [ ] 1.3 Add conflict guard: reject `pipeline release` combined with `--cleanup`, `--init`, `--doctor`, or `--status` (same pattern as the existing doctor conflict guards).
- [ ] 1.4 Add the release argument parsing: the second positional (`args[1]`) is the version/alias; validate it is present and not purely numeric before dispatching.
- [ ] 1.5 Dispatch to `runRelease(version, opts, config)` at the appropriate point in the `pipeline.ts` control flow (after config resolution, before the issue-number check).

## 2. Version resolution

- [ ] 2.1 Create `core/scripts/stages/release.ts`. Export `runRelease(version: string, opts: ReleaseOpts, config: ResolvedConfig): Promise<void>`.
- [ ] 2.2 Implement `resolveVersion(alias: string, currentVersion: string): string` — expands `major`, `minor`, `patch` aliases via semver arithmetic; passes through a valid `X.Y.Z` string unchanged; throws a descriptive error on invalid input.
- [ ] 2.3 Read `core/package.json` at runtime to get the current version for alias expansion (same pattern as the `--version` flag's `VERSION` constant).

## 3. Version bump

- [ ] 3.1 Implement `bumpVersion(resolvedVersion: string, deps: ReleaseDeps): void` — reads both `package.json` files, updates the `version` field, writes them back preserving indentation.
- [ ] 3.2 Inject file-read/write via `deps.readFile` / `deps.writeFile` seam so unit tests never touch disk.

## 4. Mirror regen

- [ ] 4.1 Implement the `node scripts/build.mjs` invocation inside `runRelease`, using `deps.runCommand` seam.
- [ ] 4.2 On non-zero exit from `build.mjs`: print its output, throw with a clear error message, abort before CI gate.

## 5. CI gate

- [ ] 5.1 Implement the `npm run ci` invocation (from repo root) using `deps.runCommand` seam.
- [ ] 5.2 On non-zero exit: print CI output, throw with a clear error message, abort before ROADMAP edit.

## 6. ROADMAP scaffolding

- [ ] 6.1 Implement `discoverShippedPRs(lastTag: string, deps: ReleaseDeps): ShippedPR[]` — runs `git log <lastTag>..HEAD` via `deps.runCommand`, extracts PR numbers from `Merge pull request #N` and `(#N)` patterns, fetches titles via `gh pr view N --json title,body`.
- [ ] 6.2 Implement `scaffoldRoadmap(roadmapText: string, ctx: ReleaseContext): string` — patches the four mutation sites atomically in-memory. Returns the patched text. Throws with a named-anchor error if any site is not found.
- [ ] 6.3 Implement the four patch functions: `patchIntroLine`, `patchReleasePlanRow`, `prependShippedBlock`, `stampPerIssueTable`.
- [ ] 6.4 Write the patched ROADMAP to disk via `deps.writeFile`.

## 7. Editor confirmation

- [ ] 7.1 After writing the scaffolded ROADMAP, launch `$EDITOR ROADMAP.md` via `deps.spawnEditor` unless `--no-edit` or `--dry-run` is set; block until the process exits.
- [ ] 7.2 If `$EDITOR` is unset and `--no-edit` is not passed, print a warning and proceed as `--no-edit`.

## 8. Commit and PR creation

- [ ] 8.1 Create a branch `release/vX.Y.Z` from current HEAD via `git checkout -b`.
- [ ] 8.2 Stage the changed files: root `package.json`, `core/package.json`, `plugin/` tree, `ROADMAP.md`.
- [ ] 8.3 Commit with message `release: X.Y.Z — <theme>\n\nIssue: #170\n` (theme read from the release-plan row's theme column, or left as `<theme>` if not detected).
- [ ] 8.4 Open the PR via `gh pr create --title "release: X.Y.Z — <theme>" --body "<pr-body>"`.
- [ ] 8.5 Print the PR URL to stdout on success.

## 9. Dry-run mode

- [ ] 9.1 Under `--dry-run`: run version resolution and ROADMAP scaffold in memory; print the resolved version, the per-file diffs (unified format), and the PR body to stdout; exit 0 without writing any file or calling any GitHub API.
- [ ] 9.2 Version validation still runs under `--dry-run`; an invalid version exits non-zero before any diff is computed.

## 10. Unit tests

- [ ] 10.1 Create `core/test/release.test.ts`. Define `ReleaseDeps` with seams for `readFile`, `writeFile`, `runCommand`, `spawnEditor` so all tests are network- and filesystem-free.
- [ ] 10.2 Test `resolveVersion`: patch/minor/major expansion, explicit semver passthrough, invalid input error.
- [ ] 10.3 Test `bumpVersion`: both files updated; JSON structure preserved.
- [ ] 10.4 Test `scaffoldRoadmap`: all four mutation sites patched; missing-anchor error thrown with correct site name.
- [ ] 10.5 Test `discoverShippedPRs`: merge-commit pattern extraction; squash-merge `(#N)` pattern; no-PR-detected warning.
- [ ] 10.6 Test dry-run path: no `writeFile` or `spawnEditor` called; stdout output contains resolved version + diff + PR body.
- [ ] 10.7 Prove each test bites: confirm it fails without the corresponding production code.

## 11. Mirror sync and CI

- [ ] 11.1 Run `node scripts/build.mjs` from repo root to regenerate `plugin/` after implementation.
- [ ] 11.2 Run `npm run ci` from repo root; all checks green before marking done.
