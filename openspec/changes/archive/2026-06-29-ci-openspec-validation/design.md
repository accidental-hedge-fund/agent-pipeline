## Context

The repo's CI gate is the `ci` npm script (`package.json`):
`ci:core && node scripts/build.mjs --check && ci:install-smoke && ci:launcher-smoke`.
`.github/workflows/ci.yml` runs `npm run ci` verbatim — a deliberate convention
(`test-gate-ci-parity`) so the script is the single source of truth and CI never drifts
from `npm run ci`. None of these steps run `openspec validate --all`, so a structurally
invalid `openspec/` (from a human commit, a manual cleanup, or any non-pipeline change) can
pass CI. The pipeline's own pre-merge gate (`openspec-integration`) validates the workspace,
but only inside a pipeline run — not for arbitrary commits to the repo.

`openspec validate --all` currently passes locally, and there are many completed-but-active
changes under `openspec/changes/`. Archiving or deleting them is out of scope for this
change (issue #315) — the gate must pass against the workspace as it stands today.

## Goals / Non-Goals

**Goals:**
- Make `openspec validate --all` part of the required repo CI gate when an `openspec/`
  workspace is present.
- Keep the gate a single source of truth inside `npm run ci` (no bespoke `ci.yml` step).
- Keep non-OpenSpec contexts (and the install smoke test) unaffected — the step is a no-op
  without an `openspec/` directory.
- Make the step run on a clean CI runner with no preinstalled `openspec` CLI.
- Cover the wiring and the no-op behavior with tests.

**Non-Goals:**
- Fixing the missing-CLI archive skip bug (#308).
- Archiving or deleting currently completed active OpenSpec changes.
- Changing OpenSpec semantics, spec format, or the engine's planning/pre-merge OpenSpec
  behavior.
- Adding OpenSpec validation to installed target repos' CI (this is agent-pipeline's own
  dev gate; installed repos run their own CI).

## Decisions

**Decision: put the gate inside `npm run ci` via a `ci:openspec` sub-step, not a bespoke
YAML step.** The repo convention (`test-gate-ci-parity`: "GitHub Actions CI invokes npm run
ci … SHALL NOT enumerate those sub-steps as separate workflow steps") is that `ci.yml` runs
`npm run ci` and the npm script is the single source of truth. A new `ci:openspec` script
wired into the `ci` chain matches the existing `ci:core` / `ci:install-smoke` /
`ci:launcher-smoke` pattern and is automatically covered by both `npm run ci` locally and in
Actions, with no YAML change.

**Decision: guard on `openspec/` existence — no-op (exit 0) when absent.** A small
`scripts/ci-openspec.mjs` checks for the `openspec/` directory (mirroring the engine's
filesystem-based `isInitialized` / `auto` detection). When absent it prints a skip message
and exits 0. This satisfies "repos without `openspec/` are not forced into OpenSpec by
default", keeps the step safe as a copyable pattern, and ensures the install smoke test
(which never has an `openspec/` workspace) is unaffected. The repo's own `openspec/` always
exists, so the gate is always active here.

**Decision: gate on the filesystem, not `cfg.openspec.enabled`.** The `openspec.enabled`
config governs the *pipeline engine's* flow on a target repo; this is agent-pipeline's own
dev CI gate over its own `openspec/`. "Directory present → validate" is the right, simple
rule and needs no config plumbing.

**Decision: validate the whole workspace (`openspec validate --all`).** This covers both
living specs under `openspec/specs/` and active changes under `openspec/changes/`, matching
the pre-merge finalize gate and catching drift in either surface.

**Decision: resolve the CLI PATH-first with a deterministic fallback.** The engine shells
`openspec` from PATH (`openspec.ts`), and contributors who have it installed should use their
version. A fresh GitHub Actions runner has no `openspec` on PATH, so the guard falls back to
an on-demand invocation of the published `@fission-ai/openspec` CLI (the package the README
already documents: `npm i -g @fission-ai/openspec`), pinned to a known version for
determinism. The exact version is confirmed at implementation time against the published
package — per the repo rule, verify external shapes, don't guess.

## Risks / Trade-offs

- **An already-invalid active change would turn CI red on merge.** Mitigation: the
  implementation must run `openspec validate --all` and confirm green before wiring the step
  in; the background note says it passes locally today. If something is invalid, that is a
  real signal to surface (not to suppress), and fixing structural validity is in scope while
  archiving the changes is not.
- **CLI fallback adds a network fetch on CI.** Mitigation: PATH-first (no fetch when the CLI
  is present) plus a pinned version keeps it deterministic; the workspace is small so
  validation is fast, consistent with the `ci.yml` note that the core install is sub-second.
- **A future `ci.yml` rewrite could drop `npm run ci`.** Mitigation: the existing
  `test-gate-ci-parity` requirement already pins `ci.yml` to `npm run ci`; this change relies
  on that invariant rather than duplicating step logic.

## Migration Plan

1. Add `scripts/ci-openspec.mjs` and the `ci:openspec` npm script; wire it into `ci`.
2. Add the drift-guard and no-op tests under `scripts/*.test.mjs`.
3. Update README / CLAUDE.md / AGENTS.md build/test guidance.
4. Run `openspec validate --all`, `node scripts/build.mjs --check`, and `npm run ci`.

Rollback is removing the `ci:openspec` entry from the `ci` chain and deleting the guard
script and its test; no external state is mutated.

## Open Questions

- None.
