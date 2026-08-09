# agent-pipeline — OpenSpec project context

## Purpose
A label-driven pipeline that advances a GitHub issue (or a PR's linked issue)
through a 16-stage state machine (code `STAGES` in `core/scripts/types.ts`,
including the terminal park off-ramp `needs-human`) to `pipeline:ready-to-deploy`.
It ships as a skill for **both Claude Code (`/pipeline`) and Codex (`$pipeline`)**
from a single shared TypeScript core; the two hosts differ only by a JSON profile.

## Tech & layout
- Node ≥ 24. The core is TypeScript run via native type-stripping — no build step.
- Single source of truth is `core/`. Stages live in `core/scripts/stages/`,
  prompt templates in `core/scripts/prompts/*.md`, shared helpers in
  `core/scripts/` (`gh.ts`, `worktree.ts`, `openspec.ts`, …).
- `plugin/` is **generated** by `scripts/build.mjs` — never hand-edit it. After
  changing `core/` or `hosts/claude/SKILL.md`, run `node scripts/build.mjs` and
  commit the regenerated `plugin/` (CI enforces this via `build.mjs --check`).
- Tests are `node --test` under `core/test/` (run `cd core && npm test`).

## Conventions
- New behavior ships with tests in `core/test/`.
- OpenSpec features must keep the freeform (non-OpenSpec) path unchanged — the
  pipeline must stay usable on repos that don't use OpenSpec.
- Prefer the repo's existing patterns (typed CLI wrappers, prompt templates with
  `{{placeholders}}`, opt-in/auto-detected config) over novel approaches.

## Out of scope
- Repository-configured or advance-loop merging of PRs. `pipeline advance`,
  `pipeline single`, and `pipeline loop` stop at `pipeline:ready-to-deploy`.
  Loop-isolated commands (`pipeline merge`, `merge-queue --apply`) may merge
  under direct operator authority. External supervisors may call those same
  commands; the repository does not ship a Hermes/Buzz factory control plane
  or grant schema. Merge authority is not repository configuration. No
  `auto_merge` config key or merge stage exists.
