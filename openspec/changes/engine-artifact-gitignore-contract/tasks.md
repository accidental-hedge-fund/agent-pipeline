## 1. Artifact-path contract (source of truth)

- [ ] 1.1 Add an exported ordered artifact-directory contract to `core/scripts/run-store.ts`: one entry per engine-written `.agent-pipeline/` directory with its relative ignore path and documentation comment, covering `runs/`, `roadmap/`, and `history/`.
- [ ] 1.2 Derive `runsDir()` and `issueHistoryDir()` from the contract entries instead of inline `.agent-pipeline/<name>` literals.
- [ ] 1.3 Derive the roadmap artifact directory in `core/scripts/roadmap/index.ts` from the same contract entry.

## 2. Managed `.gitignore` block

- [ ] 2.1 Add a pure renderer that produces the sentinel-delimited managed block text from the contract.
- [ ] 2.2 Add `ensureArtifactIgnoreBlock(repoDir, deps)` with injectable `readFile`/`writeFile` deps returning a `{ created | updated | unchanged }` result.
- [ ] 2.3 Implement the three cases: no `.gitignore` → create with block; block absent → append preserving prior bytes; block present → replace only the sentinel span.
- [ ] 2.4 Return `unchanged` with no write when the existing block already equals the rendered contract.

## 3. `pipeline init` wiring

- [ ] 3.1 Call `ensureArtifactIgnoreBlock` from `runInit` after the config scaffold.
- [ ] 3.2 Print a distinct line per outcome (created / updated / already current) alongside the existing init output.
- [ ] 3.3 Confirm `init` remains idempotent end-to-end and still ensures labels and config.

## 4. This repo's `.gitignore`

- [ ] 4.1 Add `.agent-pipeline/history/` with an explanatory comment, matching the existing `runs/` and `roadmap/` entry style.
- [ ] 4.2 Verify `git status --porcelain` is empty on the protected branch with history files present, and that `pipeline doctor` reports `worktree-clean` passing.

## 5. Tests

- [ ] 5.1 Drift guard: every engine-written `.agent-pipeline/` artifact directory has a contract entry, and the rendered block contains each entry — the test fails if a directory is added without one.
- [ ] 5.2 Unit tests for `ensureArtifactIgnoreBlock`: create, append-preserving-existing-bytes, in-place block refresh, and no-write-when-current — all with injected fs deps (no real filesystem, git, or subprocess).
- [ ] 5.3 Regression test proving the bug: the contract/rendered block includes `.agent-pipeline/history/` (fails on the pre-fix contract).
- [ ] 5.4 Prove each new test bites by temporarily reverting the corresponding change.

## 6. Docs and mirror

- [ ] 6.1 Document the ignored artifact paths (all three) in `README.md`.
- [ ] 6.2 Update `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` where artifact paths are listed so no doc lists a strict subset.
- [ ] 6.3 Regenerate the plugin mirror (`node scripts/build.mjs`) and commit it in the same change.
- [ ] 6.4 Run `npm run ci` from the repo root and confirm it is green.
