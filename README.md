# agent-pipeline

A label-driven pipeline that advances a GitHub issue (or a PR's linked issue)
through a 10-stage state machine to `pipeline:ready-to-deploy` — planning →
plan-review → implementing → review → fix → pre-merge. It does **not** auto-merge;
you own the merge button.

It ships as a skill for **both Claude Code (`/pipeline`) and Codex (`$pipeline`)**
from a single shared TypeScript core. The two hosts differ only by a small
JSON **profile** (who implements vs. reviews, naming, review mode) — there is no
forked pipeline logic.

```
backlog → ready → planning → plan-review → implementing
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → ready-to-deploy
```

## Repository layout

```
core/                 single source of truth (host-agnostic TypeScript)
  scripts/            orchestrator, stages/, prompts/, gh/worktree/lock/harness
  profiles/           claude.json · codex.json · openclaw.json  ← the host seam
  test/               node --test suite (45 tests)
hosts/
  claude/SKILL.md     Claude overlay (/pipeline, Monitor/PushNotification flow)
  codex/SKILL.md      Codex overlay ($pipeline, PTY exec flow)
  codex/agents/openai.yaml   Codex UI manifest
  _shared/entry.template.mjs launcher shim template (__PROFILE__)
plugin/               GENERATED Claude plugin (committed; built by scripts/build.mjs)
.claude-plugin/marketplace.json   GENERATED marketplace catalog (repo root)
scripts/
  install.mjs         cross-tool installer (zero deps)
  build.mjs           regenerate plugin/ from core + hosts/claude
  install.sh          clone-and-install convenience wrapper
```

## Prerequisites

The pipeline is **cross-harness** — each run uses one CLI to implement and the
*other* to review. So both are required regardless of which host you install:

- **Node ≥ 24** with **`npm`** (npm ships with Node and installs the core's deps — commander, js-yaml, zod). The core runs TypeScript directly via native type-stripping; no build step.
- **`git`** and **`gh`** on PATH, with `gh auth status` authenticated against the target repo.
- **Both `claude` and `codex` CLIs** on PATH and **authenticated** (logged in) — each run uses one to implement and the other to review.
- **The reviewer is the *other* harness's review plugin** (symmetric — each profile reviews
  through the companion plugin that wraps the opposite harness):
  - `/pipeline` (Claude profile) reviews by driving Codex through the **`codex-plugin-cc`
    companion** (`codex-companion.mjs` → `/codex:review` / `/codex:adversarial-review`). Install it
    in Claude Code once: `/plugin marketplace add openai/codex-plugin-cc` then
    `/plugin install codex@openai-codex`. Without it, `/pipeline` fails at the review stage. The
    companion carries its own review prompt and drives the `codex` CLI directly, so **no extra
    Codex-side skill is required** — only `codex` installed and authenticated. Override the
    companion path with `PIPELINE_CODEX_COMPANION`. (The installer warns if it's missing.)
  - `$pipeline` (Codex profile) reviews by driving Claude Code through the **`cc-plugin-codex`
    companion** (`claude-companion.mjs` → `$cc:review` / `$cc:adversarial-review`). Install it in
    Codex once: `npx cc-plugin-codex install`. Without it, `$pipeline` fails at the review stage.
    The companion carries its own review prompt and drives the `claude` CLI directly, so **no
    Claude-side skill is required** — only `claude` installed and authenticated. Override
    the companion path with `PIPELINE_CC_COMPANION`. (The installer warns if it's missing.)
  - Both companions run the reviewer **read-only** (sandboxed / isolated review worktree) and
    emit a structured verdict against a shared `review-output.schema.json`. review-1 maps to the
    plugin's standard review, review-2 to its adversarial review.
- `~/.agent-operating-contract.md` and a per-repo conventions file: `CLAUDE.md` (Claude/OpenClaw) or `AGENTS.md` (Codex).
- **Optional: the [OpenSpec](https://openspec.dev/) CLI** (`npm i -g @fission-ai/openspec`) — only for repos that opt into the OpenSpec flow (see "OpenSpec integration (optional)"). Not needed otherwise.
- No API keys — LLM budget comes from your `claude` / `codex` subscriptions.

The installer prints a prerequisite checklist (warnings don't block install).

## Install

> Public repo under the `accidental-hedge-fund` org — the methods below need no
> special access.

### One command, both hosts (recommended)

```bash
npx github:accidental-hedge-fund/agent-pipeline install            # detects ~/.claude and ~/.codex; installs to each present host
# or a specific host:
npx github:accidental-hedge-fund/agent-pipeline install --host claude
npx github:accidental-hedge-fund/agent-pipeline install --host codex
```

Or clone and run directly:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
node agent-pipeline/scripts/install.mjs install        # --host claude|codex|all  (default all)
```

The installer copies the shared core + the right host overlay into
`~/.claude/skills/pipeline` and/or `~/.codex/skills/pipeline`, writes a launcher
shim, and pre-installs the core's dependencies. It honors `CLAUDE_CONFIG_DIR`
and `CODEX_HOME`. **Restart Codex** after a Codex install; Claude picks it up live.

#### Claude as the primary harness (`/pipeline`)

This is the Claude-primary flow: **Claude Code implements, Codex reviews.** Two installs are needed:

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host claude   # 1. this pipeline skill
# 2. the companion that runs the Codex review (inside Claude Code):
#    /plugin marketplace add openai/codex-plugin-cc
#    /plugin install codex@openai-codex
codex login                                            # 3. the companion drives the `codex` CLI
```

Installing only the pipeline skill is **not enough** for this flow — the review stage shells out to
the `codex-plugin-cc` companion (`codex-companion.mjs`). That companion is a separate Claude Code
plugin (it is not bundled here). Nothing extra is needed on the Codex side: the companion carries its
own review prompt and calls the `codex` CLI directly.

#### Codex as the primary harness (`$pipeline`)

This is the Codex-primary flow: **Codex implements, Claude Code reviews.** Two installs are needed:

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host codex   # 1. this pipeline skill
npx cc-plugin-codex install                            # 2. the companion that runs the Claude review
claude auth login                                      # 3. the companion drives the `claude` CLI
```

Installing only the pipeline skill is **not enough** for the primary flow — the review stage shells
out to the `cc-plugin-codex` companion (`claude-companion.mjs`). That companion is a separate plugin
(it is not bundled here). Nothing extra is needed on the Claude side: the companion carries its own
review prompt and calls the `claude` CLI directly. Then restart Codex and run `$pipeline N`.

### Claude Code — plugin marketplace (versioned, auto-updatable)

```
/plugin marketplace add accidental-hedge-fund/agent-pipeline
/plugin install pipeline@ahf-tools
```

This installs the same skill as a plugin (`/pipeline`, shown as `pipeline:pipeline`).
If you also have a personal install at `~/.claude/skills/pipeline`, remove it first
(`node scripts/install.mjs uninstall --host claude`) to avoid two `/pipeline` entries.
Update later with `/plugin marketplace update ahf-tools`.

## Usage

```
/pipeline N            $pipeline N            advance loop (default; up to 12 transitions)
/pipeline N --status   $pipeline N --status   read-only: stage, blocker, PR, last review
/pipeline N --unblock "<answer>"              post answer + clear the blocked label
/pipeline N --once                            advance one stage and stop
/pipeline N --dry-run                         log only; no harness calls, no GitHub writes
```

The number is auto-detected as an issue or PR. PRs resolve to their linked
closing issue; PRs with no `Closes #N` are refused. Items must carry a
`pipeline:*` label (opt-in) — add `pipeline:ready` to start.

## Per-repo config (optional)

Commit `.github/pipeline.yml` to override defaults:

```yaml
base_branch: main
worktree_root: .worktrees
review_timeout: 1200
ci_timeout: 900
conventions_md_path: CLAUDE.md     # excerpt embedded in prompts
domain_name: my-service
domain_description: a payments service
openspec:
  enabled: auto                      # auto (default) | on | off — see "OpenSpec integration"
  bootstrap: false                   # if true, run `openspec init` on repos that lack openspec/
last30days:
  enabled: false                     # opt-in pre-planning brief — see "last30days context"
  timeout: 600                       # seconds
steps:                               # turn optional steps off for speed/preference (default: all on)
  plan_review: true                  # cross-harness review of the plan before coding
  standard_review: true              # review-1 (and its fix round)
  adversarial_review: true           # review-2 (and its fix round)
  docs: true                         # docs-update pass in pre-merge
# `harnesses:` here is accepted for back-compat but IGNORED — the install profile owns it.
```

## Configurable steps (optional)

The `steps` block turns the optional "thoroughness" steps on or off per repo, to
trade rigor for speed. Default is everything on (the full pipeline). Configurable:
`plan_review`, `standard_review` (review-1 + its fix round), `adversarial_review`
(review-2 + its fix round), and `docs`. Disabling a step still yields a valid path
to `ready-to-deploy`, and each skip is recorded as a transition comment on the issue.

The structural and safety steps — planning, implementing, and the pre-merge **CI**
and **mergeability** gates — are **not** configurable: they have no toggle, and an
unknown key under `steps` (e.g. `mergeability: false`) is rejected at config-parse
time rather than silently dropping a safety gate.

## OpenSpec integration (optional)

If a target repo uses [OpenSpec](https://openspec.dev/) (it has an `openspec/`
directory), the pipeline runs a spec-first flow:

- **Planning** — instead of a freeform plan, the implementer authors an OpenSpec
  change (`proposal.md`, `tasks.md`, spec deltas) under `openspec/changes/<id>/`,
  which the *other* harness plan-reviews as intent before any code is written. The
  change is validated structurally (`openspec validate <id>`) at draft and after
  revision, and implementation works the change's `tasks.md`.
- **Review** — the change's spec deltas are fed into the standard and adversarial
  review prompts as the intended behavior, so reviews check whether the diff
  actually satisfies the spec, not just whether the code looks correct.
- **Finalize (pre-merge)** — folds the change into the living specs
  (`openspec archive`, committed to the PR), then runs `openspec validate --all`
  and refuses `pipeline:ready-to-deploy` if anything is structurally invalid.

It's **auto-detected** by default (`openspec.enabled: auto`); set it to `on` to
require OpenSpec everywhere or `off` to disable. By default the pipeline only uses
OpenSpec on repos that already have it; set `openspec.bootstrap: true` to have
**planning run `openspec init`** (committed to the PR) on repos that lack an
`openspec/` workspace. The `openspec` CLI must be on PATH — if it's missing the
pre-merge gate is skipped (non-blocking) and planning blocks with an install hint.
No `openspec/` dir (and no bootstrap) means no behavior change, so the pipeline
stays usable on any repo.

## last30days context (optional)

When `last30days.enabled: true`, a **pre-planning** step runs the
[last30days skill](https://github.com/mvanhorn/last30days-skill) against the issue
title and carries the resulting brief forward: it's posted as a
`## Pre-Planning Context — last30days` issue comment **and** injected into the
planning prompt, so the plan is written with recent public discourse (Reddit, X,
YouTube, HN, GitHub, …) in hand.

**Default off**, and best suited to product/strategy/named-topic issues — a typical
pure-code issue title returns little public signal. It's also **always
non-blocking**: if the skill isn't installed, the interpreter is missing, the run
fails, or the brief has no signal, planning proceeds without it. The pipeline reads
no API keys itself — the skill owns its own env/keys. Requires the `last30days`
skill installed (resolved from `$LAST30DAYS_SKILL_DIR`, `~/.claude/skills/last30days`,
or `~/.codex/skills/last30days`) and Python 3.12+.

## How the two hosts share one core

`core/scripts/profile.ts` loads `core/profiles/<name>.json`; the shim passes
`--profile claude` or `--profile codex`. The profile sets the only things that
differ between hosts:

| | Claude | Codex |
|---|---|---|
| invocation | `/pipeline` | `$pipeline` |
| implementer / reviewer | claude / codex | codex / claude |
| review mode | `codex-companion` | `claude-companion` |
| review companion | codex-plugin-cc (`/codex:review`) | cc-plugin-codex (`$cc:review`) |
| conventions file | `CLAUDE.md` | `AGENTS.md` |

Everything else — stages, prompts, GitHub I/O, worktrees, locking — is one
shared implementation. Inverting behavior is a JSON edit, not a code change.

## Uninstall

```bash
node scripts/install.mjs uninstall --host all      # or claude | codex
# plugin install:
/plugin uninstall pipeline@ahf-tools
```

## Development

```bash
cd core && npm ci && npm test     # 45 tests, node --test
node scripts/build.mjs            # regenerate plugin/ after editing core or the Claude overlay
node scripts/build.mjs --check    # CI gate: fail if committed plugin/ is stale
```

After changing anything under `core/` or `hosts/claude/SKILL.md`, re-run
`build.mjs` and commit the regenerated `plugin/` (CI enforces this).

## License

MIT © AHF
