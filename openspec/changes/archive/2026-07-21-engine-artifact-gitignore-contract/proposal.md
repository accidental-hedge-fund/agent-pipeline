## Why

The engine writes per-issue evidence history to `.agent-pipeline/history/issue-<N>.jsonl`
(`issueHistoryDir()` in `core/scripts/run-store.ts`, #377), but nothing declares that
directory as a local-only artifact. On this repo's own checkout the hand-written
`.gitignore` covers `.agent-pipeline/runs/` and `.agent-pipeline/roadmap/` only, so after
any advance the protected branch carries `?? .agent-pipeline/` and `pipeline doctor` reports
`✗ worktree-clean — uncommitted changes on protected branch main` (observed 2026-07-21 with
history files for #383–#445 present). Every clean-tree gate — the doctor preflight, release
preflight, `--doctor` runs — then fails on artifacts the pipeline itself produced.

The root cause is broader than one missing line. There is **no ignore-delivery mechanism in
the engine at all**: `pipeline init` scaffolds labels and `.github/pipeline.yml` and nothing
else, and the ignore entries in this repo were added by hand. Operator repos therefore have
**zero** coverage — their first `/pipeline N` run dirties their tree and breaks their doctor
preflight, and the next artifact directory the engine adds will repeat the failure with no
guard to catch it.

## What Changes

- Introduce a single source of truth for engine-written artifact directories: an exported
  ordered list of `.agent-pipeline/` artifact paths with their documentation comments,
  covering `runs/`, `roadmap/`, and `history/`. The existing directory helpers
  (`runsDir`, `issueHistoryDir`, the roadmap output dir) derive their path segments from it
  so a directory cannot exist without a declared ignore entry.
- `pipeline init` ensures a delimited, engine-managed block in the target repo's root
  `.gitignore` containing exactly those entries. The write is idempotent, additive, and
  never touches lines outside the managed block; re-running `init` refreshes the block to
  the current contract (this is the mechanism that "establishes the ignore" for operator
  repos, and the re-run path is what refreshes an existing scaffold).
- Add `.agent-pipeline/history/` to this repo's own `.gitignore` so `pipeline doctor` passes
  `worktree-clean` with history files present.
- Add a drift-guard regression test asserting that every `.agent-pipeline/` artifact
  directory the engine can write is present in the ignore contract, and that the block
  rendered by `init` contains each entry — so adding a future artifact directory without an
  ignore entry fails CI.
- Document the ignore contract where the artifact layout is documented (README and the host
  SKILL.md variants), listing all three paths rather than a subset.

## Capabilities

### New Capabilities
- `engine-artifact-ignore-contract`: the single source of truth for engine-written
  `.agent-pipeline/` artifact directories, the invariant that every such directory has a
  declared ignore entry, and the drift guard that enforces it.

### Modified Capabilities
- `init-command`: `init` additionally ensures the engine-managed `.gitignore` block, with
  no-clobber semantics for operator-authored lines and idempotent re-runs.

## Impact

- `core/scripts/run-store.ts` — export the artifact-path contract; derive `runsDir` /
  `issueHistoryDir` from it.
- `core/scripts/roadmap/index.ts` — derive the roadmap artifact dir from the same contract.
- `core/scripts/pipeline.ts` (`runInit`) — call the new gitignore-ensure step and report it.
- `core/test/` — new unit tests for the ignore-block renderer/ensure logic (injected fs
  deps, no real filesystem or subprocess) plus the drift guard.
- This repo's root `.gitignore` — add `.agent-pipeline/history/`.
- `README.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — document the ignore contract.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).

## Acceptance Criteria

- [ ] A single exported constant enumerates every engine-written `.agent-pipeline/` artifact
      directory and includes `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`, and
      `.agent-pipeline/history/`.
- [ ] `runsDir()`, `issueHistoryDir()`, and the roadmap artifact directory resolve to paths
      derived from that constant (no independently hard-coded `.agent-pipeline/<name>`
      literals remain in those helpers).
- [ ] `pipeline init` on a repo with no `.gitignore` creates one containing a delimited
      engine-managed block listing all three entries.
- [ ] `pipeline init` on a repo with an existing `.gitignore` appends the managed block and
      leaves every pre-existing line byte-identical.
- [ ] Re-running `pipeline init` after the contract gains a new entry rewrites only the
      managed block so it lists the new entry; lines outside the block are unchanged and the
      block is not duplicated.
- [ ] `pipeline init` is a no-op on `.gitignore` when the managed block already matches the
      contract (no write, and the printed output says so).
- [ ] A regression test fails when an `.agent-pipeline/` artifact directory the engine writes
      has no entry in the ignore contract.
- [ ] This repo's root `.gitignore` contains `.agent-pipeline/history/`, and
      `git status --porcelain` on the protected branch is empty with history files present,
      so `pipeline doctor` reports `worktree-clean` as passing.
- [ ] README and both host `SKILL.md` variants list all three ignored artifact paths; no doc
      lists a strict subset.
- [ ] `npm run ci` passes from the repo root, including `node scripts/build.mjs --check`.

## Out of scope

- Changing where the engine writes artifacts, or making `history/` committable.
- Retroactively removing already-committed `.agent-pipeline/` files from any repo's history.
- Any change to `pipeline config sync`'s `.github/pipeline.yml` preview/apply contract — see
  `design.md` for why `init` (not `config sync`) is the delivery mechanism.
