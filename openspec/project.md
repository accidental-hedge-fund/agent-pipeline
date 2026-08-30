# agent-pipeline — OpenSpec project context

## Purpose
A label-driven pipeline that advances a GitHub issue (or a PR's linked issue)
through a 18-stage state machine (code `STAGES` in `core/scripts/types.ts`,
including the terminal park off-ramp `needs-human`) to `pipeline:ready-to-deploy`.
The product is the `pipeline` CLI (`pipeline <verb> [--json]` plus event JSONL).
Hosts are argv or JSON wrappers (short SKILL shims) around that CLI; they are
not a second engine. Implementer and reviewer are config roles from
`harnesses.*` in `.github/pipeline.yml`, not host-brand product names.
Claude Code, Codex, Grok, OpenCode, and OMP are host
surfaces, not a Claude-plus-Codex-only product.

## Tech & layout
- Node ≥ 24. The core is TypeScript run via native type-stripping — no build step.
- Single source of truth is `core/`. Stages live in `core/scripts/stages/`,
  prompt templates in `core/scripts/prompts/*.md`, shared helpers in
  `core/scripts/` (`gh.ts`, `worktree.ts`, `openspec.ts`, …).
- The product is the pipeline CLI plus host SKILL. After changing `core/` or
  `hosts/claude/SKILL.md`, run `node scripts/build.mjs` so `--check` can assert
  generated host SKILL freshness. Do not recreate or commit `plugin/`.
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
  under direct operator authority. The explicit ship coordinator may compose
  those commands after it validates a minimal, immutable, event-bound,
  expiring authorization document supplied by a trusted channel adapter. The
  repository does not ship a Hermes/Buzz transport client, durable factory
  action bus, or second scheduler. Merge authority is not repository
  configuration. No `auto_merge` config key or merge stage exists.
