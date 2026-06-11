# agent-pipeline

**agent-pipeline** is a label-driven GitHub issue pipeline that advances an issue from backlog to `pipeline:ready-to-deploy` through a 12-stage state machine — planning → plan-review → implementing → review → fix → pre-merge → eval-gate. It does **not** auto-merge; you own the merge button.

It ships as a skill for **both Claude Code (`/pipeline`) and Codex (`$pipeline`)** from a single shared TypeScript core. **Both harnesses are required for every run**: one implements, and the other cross-reviews. By default, `/pipeline` uses Claude to implement and Codex to review; `$pipeline` inverts this. The pipeline is cross-harness by design — you cannot skip the reviewer install.

```text
backlog → ready → planning → plan-review → implementing
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → eval-gate → ready-to-deploy
```

## Contents

- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Install](#install)
- [Usage](#usage)
- [Onboarding a new repo](#onboarding-a-new-repo)
- [Per-repo config](#per-repo-config-optional)
- [Test/build gate](#testbuild-gate-optional-default-on)
- [Troubleshooting](#troubleshooting)
- [Advanced topics](#advanced-topics)
  - [Configurable steps](#configurable-steps)
  - [Human plan feedback](#human-plan-feedback)
  - [Commit traceability trailers](#commit-traceability-trailers-always-on)
  - [Eval gate](#eval-gate)
  - [OpenSpec integration](#openspec-integration)
  - [last30days context](#last30days-context)
- [How the two hosts share one core](#how-the-two-hosts-share-one-core)
- [Repository layout](#repository-layout)
- [Uninstall](#uninstall)
- [Development](#development)
- [License](#license)

## Prerequisites

The pipeline is **cross-harness** — each run uses one CLI to implement and the *other* to review. **Both CLIs are required regardless of which host you install.**

- **Node ≥ 24** with **`npm`** (npm ships with Node and installs the core's dependencies — commander, js-yaml, zod). The core runs TypeScript directly via native type-stripping; no build step.
- **`git`** and **`gh`** on PATH, with `gh auth status` authenticated against the target repo.
- **Both `claude` and `codex` CLIs** on PATH and **authenticated** — each run uses one to implement and the other to review.
- **Review runs on the *other* harness, invoked directly** (`reviewMode: prompt-harness`): the reviewer CLI is called with the pipeline's own JSON-returning review prompt. **No review plugin is required** — you just need the other harness's CLI installed and authenticated.
- `~/.agent-operating-contract.md` and a per-repo conventions file: `CLAUDE.md` (Claude) or `AGENTS.md` (Codex).
- **Optional:** the [OpenSpec](https://openspec.dev/) CLI (`npm i -g @fission-ai/openspec`) — only needed for repos that opt into the OpenSpec planning flow.
- No API keys — LLM budget comes from your `claude` / `codex` subscriptions.

The installer prints a prerequisite checklist during install (warnings do not block the install).

## Quickstart

**Step 1 — Install**

```bash
npx github:accidental-hedge-fund/agent-pipeline install
```

This detects which of `~/.claude` and `~/.codex` exist and installs to each. After installing for Codex, **restart Codex** to pick up the skill.

**Step 2 — Label an issue and run**

```bash
# Create the pipeline:ready label if it doesn't exist yet
gh label create "pipeline:ready" --color 0075ca --description "Start the pipeline" 2>/dev/null || true

# Label any open issue to opt it in
gh issue edit N --add-label "pipeline:ready"
```

Then invoke from Claude Code:

```text
/pipeline N
```

Or from Codex (after restarting it):

```text
$pipeline N
```

The pipeline advances the issue up to 12 transitions per invocation — creating a worktree, opening a PR, requesting cross-harness review, fixing review findings, and running pre-merge checks — all without further manual input.

## Install

> Public repo under the `accidental-hedge-fund` org — no special access needed.

### Recommended: one command, both hosts

```bash
# Detects ~/.claude and ~/.codex; installs to each present host
npx github:accidental-hedge-fund/agent-pipeline install

# Or a specific host:
npx github:accidental-hedge-fund/agent-pipeline install --host claude
npx github:accidental-hedge-fund/agent-pipeline install --host codex
```

Or clone and run directly:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
node agent-pipeline/scripts/install.mjs install        # --host claude|codex|all  (default: all)
```

The installer copies the shared core and the right host overlay into `~/.claude/skills/pipeline` and/or `~/.codex/skills/pipeline`, writes a launcher shim, and pre-installs the core's dependencies. It honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. **Restart Codex** after a Codex install; Claude picks the skill up live.

After the core install, the installer detects which optional feature tools (the OpenSpec CLI, the last30days skill) are relevant to your setup and prompts you to install or update each one. Declining any dependency still completes the core install.

To skip all prompts and auto-accept in non-interactive environments:

```bash
npx github:accidental-hedge-fund/agent-pipeline install --yes-deps
PIPELINE_INSTALL_DEPS=1 npx github:accidental-hedge-fund/agent-pipeline install  # same via env var
```

In non-interactive environments without `--yes-deps`, dependency prompts are skipped automatically and a summary is printed with instructions to re-run with `--yes-deps`.

#### Claude as the primary harness (`/pipeline`)

Claude Code implements, Codex reviews.

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host claude
codex login                                            # the reviewer — review invokes `codex` directly
```

Review (`reviewMode: prompt-harness`) invokes the `codex` CLI directly with a JSON-returning prompt — **no review plugin needed**, just the authenticated `codex` CLI.

#### Codex as the primary harness (`$pipeline`)

Codex implements, Claude Code reviews.

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host codex
claude auth login                                      # the reviewer — review invokes `claude` directly
```

Review (`reviewMode: prompt-harness`) invokes the `claude` CLI directly with a JSON-returning prompt — **no review plugin needed**, just the authenticated `claude` CLI. Then restart Codex and run `$pipeline N`.

### Claude Code plugin marketplace (versioned, auto-updatable)

```text
/plugin marketplace add accidental-hedge-fund/agent-pipeline
/plugin install pipeline@ahf-tools
```

This installs the same skill as a plugin (`/pipeline`, shown as `pipeline:pipeline`). If you have a personal install at `~/.claude/skills/pipeline`, the installer detects it automatically and offers to relocate it to a timestamped backup — no data is lost. Update later with `/plugin marketplace update ahf-tools`.

### Install a specific version

The bare `npx github:…` commands above install the **latest** code (the default branch). To install a specific released version instead, pin the git ref with `#<tag>` — released versions are tagged `vMAJOR.MINOR.PATCH` (see the [tags](https://github.com/accidental-hedge-fund/agent-pipeline/tags)):

```bash
# Install exactly v1.0.1 (any host flag works the same way)
npx -y github:accidental-hedge-fund/agent-pipeline#v1.0.1 install --host claude
```

Everything else is identical to the latest-version commands — `#v1.0.1` just tells `npx` to fetch that tag rather than the default branch. Or clone and check out the tag directly:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
cd agent-pipeline && git checkout v1.0.1
node scripts/install.mjs install --host claude
```

Confirm what's installed at any time with `pipeline --version` (or `/pipeline --version` / `$pipeline --version`).

> The plugin marketplace path above always tracks the **latest** published version and is not a way to pin an older release — use the `#<tag>` form for that.

## Usage

```text
/pipeline N            $pipeline N            advance loop (default; up to 12 transitions)
/pipeline N --status   $pipeline N --status   read-only: stage, blocker, PR, last review
/pipeline N --unblock "<answer>"              post answer + clear the blocked label
$pipeline N --unblock "<answer>"              (same for Codex)
/pipeline N --once                            advance one stage and stop
/pipeline N --dry-run                         log only; no harness calls, no GitHub writes
/pipeline --cleanup    $pipeline --cleanup    sweep merged-PR worktrees, then exit (no number)
/pipeline --init       $pipeline --init       onboard: ensure labels + scaffold .github/pipeline.yml
/pipeline --version    $pipeline --version    print the package version, then exit (no number; -V alias)
```

The number is auto-detected as an issue or PR. PRs resolve to their linked closing issue; PRs with no `Closes #N` are refused. Items must carry a `pipeline:*` label (opt-in) — add `pipeline:ready` to start.

`--cleanup` takes no number: it sweeps pipeline-managed worktrees under `worktree_root` whose PR is already merged, removing the worktree and its local branch. It only touches `pipeline/<N>-<slug>` worktrees, never the remote branch, and skips (reporting the reason) any worktree with uncommitted changes or a local HEAD that differs from the merged PR's commit. It is idempotent — a second run finds nothing to do.

## Onboarding a new repo

Before running the pipeline for the first time on a fresh repo, run `init` to create all pipeline labels and scaffold a starter config in one step:

```bash
/pipeline --init    # Claude Code primary
$pipeline --init    # Codex primary
```

`init` does two things, idempotently:

1. **Creates all pipeline labels** (`pipeline:<stage>`, `blocked`, `harness:claude`, `harness:codex`) in the target repo via `gh label create`. Labels that already exist are left untouched.
2. **Writes `.github/pipeline.yml`** with all configurable keys at their default values. If the file already exists it is preserved and a notice is printed — `init` never clobbers an existing config.

Safe to re-run: a second `init` on the same repo finds all labels present and the config file already there, and exits cleanly. A normal `/pipeline N` run still creates any missing labels as a side-effect even if you never ran `init` — `init` is additive, not a new precondition.

After running `init`, commit `.github/pipeline.yml` (edit as needed), add `pipeline:ready` to an issue, and start the pipeline.

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
  docs: true                         # include the docs-update instruction in the implementing prompt
test_gate:                           # run the repo's own tests/build before opening a PR
  enabled: true                      # default: true; set false to disable entirely
  command: "pnpm test"               # optional explicit command; auto-detected when absent
  max_attempts: 3                    # fix-harness invocations before blocking
  timeout: 300                       # seconds per test/build run
eval_gate:                           # run the repo's eval harness after pre-merge, before ready-to-deploy
  enabled: false                     # default: false; set true to enable (one-time declaration per repo)
  command: "pnpm evals"              # shell command to run; supports pipes, env vars, &&, etc.
  mode: gate                         # gate (default): block on fail | advisory: record result and always advance
  timeout: 300                       # hard stage-level budget in seconds (all attempts share this budget)
  max_attempts: 2                    # total attempts before giving up (1 = no retry)
review_policy:                       # which review findings block progression vs. merely advise
  block_threshold: medium            # critical|high|medium|low — findings below this advise, not block (default: medium; 'high' = more throughput, 'low' = block on everything)
  min_confidence: 0.7                # 0..1 — findings below this confidence advise, not block (default: 0.7)
  max_adversarial_rounds: 3          # cap review-round re-runs; after this, still-blocking findings go advisory and the item routes to pipeline:needs-human
# Harness roles (implementer/reviewer) are owned by the install profile and cannot
# be set here — a `harnesses:` key is rejected at config-parse time.
```

## Test/build gate (optional, default on)

When `test_gate.enabled` (the default), the target repo's **own** test/build command runs inside the worktree during implementation and **after each fix round**, before a PR is opened or the item advances. If it fails, the implementer harness gets the failure output and retries in a **bounded generate→test→fix loop** — up to `max_attempts` fix invocations (default 3), each test run capped at `timeout` seconds (default 300). The item never opens a PR or advances while the command is failing; persistent failure → `blocked` with the captured output surfaced on the issue.

The command is **auto-detected** (first match wins):

1. Explicit `test_gate.command` override (parsed without a shell)
2. `package.json` — a real `test` script (npm placeholder/`echo` stubs skipped), else a `build:check` / `typecheck` / `type-check` / `build` script; the package manager follows the lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm)
3. `go.mod` → `go test ./...`
4. `Cargo.toml` → `cargo test`
5. pytest — only with a concrete marker (`pytest.ini`, root `conftest.py`, or a `[tool.pytest*]` section in `pyproject.toml`); `pyproject.toml` alone is **not** enough
6. `Makefile` with a `test:` target → `make test`

**Repos with no detectable command (and no override) are skipped entirely** — zero behavior change. For monorepos or custom runners, set `test_gate.command` explicitly. **Rollback** is a one-line `test_gate: { enabled: false }`.

### Matching CI: set `test_gate.command` when CI does more than `npm test`

Auto-detection picks the package `test` script (or equivalent). If your CI also runs additional steps — a generated-artifact sync check, a typecheck pass, an install smoke-test — the gate will miss those steps and a CI-only failure can escape to pre-merge.

**Fix:** add a script that chains all CI steps and point the gate at it:

```yaml
# .github/pipeline.yml
test_gate:
  command: "npm run ci"   # wraps the full CI command sequence (see package.json)
```

```json
{
  "scripts": {
    "ci:core": "(cd core && npm ci --no-audit --no-fund && npm test)",
    "ci": "npm run ci:core && node scripts/build.mjs --check && npm run ci:install-smoke",
    "ci:install-smoke": "node scripts/ci-install-smoke.mjs"
  }
}
```

`test_gate.command` is parsed **without a shell** (whitespace-tokenized, then spawned directly). Compound operators like `&&` must live inside the script body (where npm/shell handles them), not raw in the config value.

## Troubleshooting

### Pipeline is blocked

When the pipeline cannot advance on its own, it applies a `blocked` label to the issue and posts a comment explaining why. To unblock:

1. Read the blocker comment on the issue.
2. Address the root cause (fix failing tests, answer a question, supply missing context, etc.).
3. Clear the label and re-invoke using `--unblock`:

```bash
/pipeline N --unblock "your answer or context here"
# or for Codex:
$pipeline N --unblock "your answer or context here"
```

Or clear the label manually and re-run normally:

```bash
gh issue edit N --remove-label "blocked"
/pipeline N   # or: $pipeline N
```

### Common blockers

- **Test gate failure** — the repo's test/build command is failing. Fix the tests, or set `test_gate.command` in `.github/pipeline.yml` if the wrong command is being detected.
- **Reviewer CLI not found or not authenticated** — install and authenticate both `claude` and `codex` CLIs (see [Prerequisites](#prerequisites)).
- **`gh` not authenticated** — run `gh auth login` and try again.
- **Missing `pipeline:ready` label** — create it with `gh label create "pipeline:ready"` before labeling an issue.
- **PR has no `Closes #N` link** — the pipeline cannot resolve a PR to an issue without a closing reference. Add `Closes #N` to the PR body.
- **Review verdict is stale** — if commits land after a review approval, the pipeline detects the stale SHA and re-reviews automatically before advancing.

### Dry-run and status inspection

To observe what the pipeline would do without making any writes:

```bash
/pipeline N --dry-run
$pipeline N --dry-run
```

To print the current stage, any blocker, the linked PR, and the last review verdict without advancing:

```bash
/pipeline N --status
$pipeline N --status
```

---

## Advanced topics

The following features are all **default off** (or are clearly optional). A reader who completes Prerequisites, Quickstart, and Usage has a fully working setup without needing any of these sections.

### Configurable steps

The `steps` block turns the optional "thoroughness" steps on or off per repo, to trade rigor for speed. Default is everything on (the full pipeline). Configurable: `plan_review`, `standard_review` (review-1 + its fix round), `adversarial_review` (review-2 + its fix round), and `docs` (when on, the implementing prompt instructs the implementer to update affected documentation — README, CLAUDE.md, config docs — as part of the same change, so docs land inside the reviewed diff; when off, no docs ask is made). Disabling a step still yields a valid path to `ready-to-deploy`, and each skip is recorded as a transition comment on the issue.

The structural and safety steps — planning, implementing, and the pre-merge **CI** and **mergeability** gates — are **not** configurable: they have no toggle, and an unknown key under `steps` (e.g. `mergeability: false`) is rejected at config-parse time rather than silently dropping a safety gate.

Review verdicts are also pinned to the commit they evaluated. Every review comment records the reviewed commit SHA — surfaced in the header (e.g. `— approve (commit a1b2c3d)`) and embedded as a machine-readable footer sentinel. Before pre-merge acts on a prior approval it re-checks that SHA against current HEAD: if any commit has landed since the review, the stale verdict is discarded and the item returns to its review round for a fresh review (posting a `## Pipeline: Re-running review` comment) rather than advancing. This is always-on — there is no toggle.

### Human plan feedback

When `plan_review` is on, the pipeline posts the plan as an `## Implementation Plan` issue comment and runs the reviewer harness against it. **Comments you leave on that plan before the revision step are folded into the revision** alongside the reviewer's feedback — so a human reading the plan can steer it without waiting for a separate approval gate. Any comment posted after the plan that doesn't start with a pipeline header (`## Implementation Plan`, `## Plan Review`, `## Pipeline:`, …) is treated as human input; the practical window is the reviewer-harness run (comments that land after the revision starts are picked up on the next trigger).

The revised plan comment attributes contributors with a `**Human feedback from**: @login, …` line, and the revision **must** end with a `## Human Feedback Acknowledgement` section listing each commenter as `addressed — <reason>` or `declined — <reason>` — a revision missing it is **blocked**. With no human comments present, behavior is byte-for-byte identical to before (no extra section, no attribution line). The feature is a no-op when `plan_review` is disabled.

### Commit traceability trailers (always on)

Every commit the pipeline produces is stamped with two git trailers tying it back to its origin — both the commits the pipeline writes directly (OpenSpec init/archive) and the ones the implement/fix harnesses author:

```
Issue: #<n>
Pipeline-Run: <n>/<UTC-ISO-datetime>
```

The `Pipeline-Run` id is generated once per `/pipeline` invocation and reused for every commit in that run, so `git log --grep="Pipeline-Run: 42/"` surfaces all commits from every run on issue #42, and `git log --format="%(trailers:key=Issue)"` reads the issue link back via `git interpret-trailers`. The test/build gate enforces it: if a fix-harness commit lands without both trailers, the gate blocks rather than advancing. There is no toggle.

### Eval gate

When `eval_gate.enabled` (default **off**), the target repo's eval harness runs **after pre-merge, before `ready-to-deploy`**, inside the issue's worktree. It's a one-time opt-in per repo: set `enabled: true` and a `command`. The command runs through `sh -c` (so pipes, `&&`, and env vars work) and its **exit code alone** decides pass/fail — the pipeline never parses scores. The outcome (PASS/FAIL, mode, elapsed, output excerpt) is always recorded as an issue comment.

- **`mode: gate`** (default) — a non-zero exit **blocks** the item.
- **`mode: advisory`** — the result is recorded and the item **always advances**, even after retries are exhausted.
- A failing run is retried up to `max_attempts` (default 2; `1` = no retry), short-circuiting on the first pass.
- `timeout` (default 300) is a **hard stage-level budget in seconds, shared across all attempts**, so total wall-time never exceeds it.
- **Tooling failures always block, regardless of mode** — if the command times out or can't be spawned the item is blocked even in advisory mode.

When disabled (the default), pre-merge advances straight to `ready-to-deploy` and the `eval-gate` label is never applied. **Rollback** is `eval_gate: { enabled: false }`.

### Review severity policy & audited overrides

By default only **high/critical, well-confident** findings block: a `needs-attention` verdict routes to a fix round only when a finding meets the severity threshold and the confidence floor. `review_policy` lets a repo tune this:

- **`block_threshold`** (`critical`|`high`|`medium`|`low`, default `medium`) — findings whose severity is **below** the threshold are recorded as **advisory** and do not route to a fix round. The default `medium` blocks medium-and-above (only low-severity findings advise), so real issues are fixed or explicitly overridden rather than silently advised past at merge (review comments land on the issue, but a human merges the PR). Set `high` to also advise medium findings (more throughput, less rigor), or `low` to block on every finding.
- **`min_confidence`** (`0`..`1`, default `0.7`) — findings whose reported confidence is below this floor advise rather than block, even if high-severity.
- **`max_adversarial_rounds`** (integer, default `3`) — caps how many times a review round may re-run after a fix. Once a round hits the cap with findings still blocking, they are recorded as advisory and the item is parked at the **`pipeline:needs-human`** terminal with a punch-list comment — it never loops to exhaustion and never auto-advances with unresolved blocking findings. Resume by `--override`-ing or fixing the findings, then relabel `pipeline:needs-human` → `pipeline:review-2`. Running `--status` on a parked item surfaces this punch-list inline — the count of unresolved blocking findings plus the resume steps — so you don't have to open the issue to see what's left.

When a review produces findings but **none block** under the policy, the item advances as if approved, and an audited *"advanced under severity policy"* comment records the advisory findings (each with its key, severity, and why it didn't block). The pipeline still stops at `ready-to-deploy` — you still own the merge.

**Audited overrides.** Every finding is shown with a stable `override-key` in the review comment. To disposition one specific blocking finding (e.g. a false positive or out-of-scope ask) so it stops blocking:

```
/pipeline N --override "<override-key>: rejected — <why>"
/pipeline N --override "<override-key>: deferred #123 — tracked separately"
```

This posts an audited `## Pipeline: Finding override` comment (the recording account is the *who*, your reason the *why*) and clears the `blocked` label; re-run `/pipeline N` to advance with the override applied. The key is content-addressed, so a finding the reviewer re-emits on a later commit keeps the same key and the override keeps applying. **Rollback** to the pre-1.0.1 block-on-everything behavior is `review_policy: { block_threshold: low, min_confidence: 0 }`.

### OpenSpec integration

If a target repo uses [OpenSpec](https://openspec.dev/) (it has an `openspec/` directory), the pipeline runs a spec-first flow:

- **Planning** — instead of a freeform plan, the implementer authors an OpenSpec change (`proposal.md`, `tasks.md`, spec deltas) under `openspec/changes/<id>/`, which the *other* harness plan-reviews as intent before any code is written. The change is validated structurally (`openspec validate <id>`) at draft and after revision, and implementation works the change's `tasks.md`.
- **Spec deltas as intended behavior** — once authored, the change's spec deltas are injected into every harness step that acts on the change — plan-review, plan-revision, implementing, the standard and adversarial review rounds, and the fix rounds — so each step checks its work against the spec, not just whether the code looks correct.
- **Finalize (pre-merge)** — folds the change into the living specs (`openspec archive`, committed to the PR), then runs `openspec validate --all` and refuses `pipeline:ready-to-deploy` if anything is structurally invalid.

It's **auto-detected** by default (`openspec.enabled: auto`); set it to `on` to require OpenSpec everywhere or `off` to disable. By default the pipeline only uses OpenSpec on repos that already have it; set `openspec.bootstrap: true` to have **planning run `openspec init`** on repos that lack an `openspec/` workspace. The `openspec` CLI must be on PATH — if it's missing the pre-merge gate is skipped (non-blocking) and planning blocks with an install hint. No `openspec/` dir (and no bootstrap) means no behavior change.

### last30days context

When `last30days.enabled: true`, a **pre-planning** step runs the [last30days skill](https://github.com/mvanhorn/last30days-skill) against the issue's full content (title + description, excerpted for long descriptions) and carries the resulting brief forward: it's posted as a `## Pre-Planning Context — last30days` issue comment **and** injected into the planning prompt, so the plan is written with recent public discourse (Reddit, X, YouTube, HN, GitHub, …) in hand. When an issue's description is absent, the title alone is used.

> **Data boundary**: the research topic (title + excerpt of the description) is forwarded to the last30days skill and its configured external data sources. Before sending, the pipeline automatically redacts URLs, email addresses, Bearer tokens, long hex strings, and common `key=value` / `token=value` assignments from the description. Despite this redaction, **do not enable this feature for issues that contain sensitive customer data, unreleased roadmap details, or proprietary stack traces**.

**Default off**, and best suited to product/strategy/named-topic issues. It's also **always non-blocking**: if the skill isn't installed, the interpreter is missing, the run fails, or the brief has no signal, planning proceeds without it.

Requires the `last30days` skill installed (`/plugin marketplace add mvanhorn/last30days-skill` in Claude Code, or `npx skills add mvanhorn/last30days-skill -g` for Codex/CLI hosts; resolved from `$LAST30DAYS_SKILL_DIR`, `~/.claude/skills/last30days`, or `~/.codex/skills/last30days`) and Python 3.12+.

**Data-source keys** are configured in the skill, not this pipeline. The two highest-lift keys are `BRAVE_SEARCH_API_KEY` (free [Brave Search API](https://brave.com/search/api/)) and `SCRAPECREATORS_API_KEY` (fuller social/X coverage). Without any keys the skill still runs on free public sources. See the [skill's setup guide](https://github.com/mvanhorn/last30days-skill#setup) for full instructions.

---

## How the two hosts share one core

`core/scripts/profile.ts` loads `core/profiles/<name>.json`; the shim passes `--profile claude` or `--profile codex`. The profile sets the only things that differ between hosts:

| | Claude | Codex |
|---|---|---|
| invocation | `/pipeline` | `$pipeline` |
| implementer / reviewer | claude / codex | codex / claude |
| review mode | `prompt-harness` | `prompt-harness` |
| reviewer (direct, JSON prompt) | `codex` CLI | `claude` CLI |
| conventions file | `CLAUDE.md` | `AGENTS.md` |

Everything else — stages, prompts, GitHub I/O, worktrees, locking — is one shared implementation. Inverting behavior is a JSON edit, not a code change.

## Repository layout

```text
core/                 single source of truth (host-agnostic TypeScript)
  scripts/            orchestrator, stages/, prompts/, gh/worktree/lock/harness
  profiles/           claude.json · codex.json  ← the host seam
  test/               node --test suite
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

## Uninstall

```bash
# npx form:
npx github:accidental-hedge-fund/agent-pipeline uninstall --host all   # or claude | codex
# or from a clone:
node scripts/install.mjs uninstall --host all
# plugin install:
/plugin uninstall pipeline@ahf-tools
```

## Development

```bash
cd core && npm ci && npm test     # node --test
node scripts/build.mjs            # regenerate plugin/ after editing core or the Claude overlay
node scripts/build.mjs --check    # CI gate: fail if committed plugin/ is stale
npm run ci                        # run the full CI command (tests + build check + install smoke)
```

After changing anything under `core/` or `hosts/claude/SKILL.md`, re-run `build.mjs` and commit the regenerated `plugin/` (CI enforces this).

## License

MIT © AHF
