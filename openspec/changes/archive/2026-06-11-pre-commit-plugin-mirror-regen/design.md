## Context

`plugin/` is a committed, load-bearing mirror of `core/` (+ `hosts/claude/`). Claude Code's marketplace install path copies the plugin tree at install time and cannot reference files outside it, so the mirror cannot be replaced by a symlink or a generate-on-release strategy. The cost of keeping it committed is that every `core/` edit must be followed by `node scripts/build.mjs` — a step that is easy to forget and has caused ~13/14 functional commits to need a follow-up "regenerate mirror" fix.

The `build.mjs --check` flag in `npm run ci` and `.github/workflows/ci.yml` catches the omission, but only after the PR is open and CI runs. A local pre-commit hook catches it before the commit is created.

## Goals / Non-Goals

**Goals:**
- Auto-regenerate `plugin/` and stage it whenever a commit touches `core/` or `hosts/claude/`.
- Never stage unrelated working-tree changes (the hook is surgical: only `plugin/` and `.claude-plugin/marketplace.json`).
- Provide one-command setup (`npm run setup-hooks`).
- Leave `build.mjs --check` in CI as the authoritative, clone-independent gate.

**Non-Goals:**
- Replacing the `build.mjs --check` CI gate or weakening it in any way.
- Shipping the hook as part of the published package (hooks are per-clone dev tooling).
- CI bot-commit regeneration (a `chore: regenerate` Action commit would land after the reviewer's verdict, bypassing `isPipelineInternalCommit`, and re-trigger the #16 SHA-gate → non-convergence cascade).
- Any change to runtime behavior, CLI, config, or the marketplace contract.

## Decisions

**Decision: shell script in `.githooks/pre-commit`, not a Node.js hook.**
Shell is the natural language for git hooks — it can detect staged paths with `git diff --cached --name-only` and run two commands without requiring any dependencies. A Node.js hook would require the environment to be bootstrapped before the hook runs, adding fragility.

**Decision: hook is opt-in via `npm run setup-hooks`, not auto-installed.**
Git does not automatically execute hooks from a committed `.githooks/` directory — `core.hooksPath` must be set per clone. Attempting to auto-set `core.hooksPath` in `npm install` (via a `prepare` script) would be surprising and could conflict with users who have their own global hooks directory. The opt-in `setup-hooks` command is the standard pattern and is transparent.

**Decision: the hook only stages `plugin/` and `.claude-plugin/marketplace.json`.**
Staging anything broader risks accidentally committing unintended working-tree changes. The hook runs `git add plugin/ .claude-plugin/marketplace.json` and nothing else; it does not call `git add .` or `git add -A`.

**Decision: skip hook body when no `core/` or `hosts/claude/` paths are staged.**
A README-only commit or a docs-only commit should not trigger a regeneration run (it would be a no-op, but the latency and noise still matter for the developer experience). The hook exits 0 immediately when `git diff --cached --name-only` yields no paths under `core/` or `hosts/claude/`.

**Decision: `build.mjs --check` remains unchanged in CI.**
The hook is convenience, not enforcement. Contributors who do not run `setup-hooks`, or who bypass hooks with `--no-verify` (which is their prerogative), are still caught by the CI gate. The two layers are complementary, not redundant.

## Risks / Trade-offs

- *Hook is not run if contributor uses `--no-verify`* → `build.mjs --check` in CI is the authoritative backstop; no regression from current behavior.
- *Hook runs `build.mjs` which could fail on a partial `core/` state* → if `build.mjs` exits non-zero, the hook exits non-zero and the commit is aborted; the contributor sees the error inline. This is the correct behavior.
- *`core.hooksPath` conflicts with contributor's existing global hooksPath* → setup-hooks only sets it at the repo level (`--local`), so it doesn't affect other repos or a global config.
