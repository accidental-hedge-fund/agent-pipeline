# agent-pipeline

**agent-pipeline** is a label-driven GitHub issue pipeline that advances an issue from backlog to `pipeline:ready-to-deploy` through a 13-stage state machine — planning → plan-review → implementing → review → fix → pre-merge → eval-gate → shipcheck-gate. It does **not** auto-merge; you own the merge button.

It ships as a skill for **both Claude Code (`/pipeline`) and Codex (`$pipeline`)** from a single shared TypeScript core. **Both harnesses are required for every run**: one implements, and the other cross-reviews. By default, `/pipeline` uses Claude to implement and Codex to review; `$pipeline` inverts this. The pipeline is cross-harness by design — you cannot skip the reviewer install.

```text
backlog → ready → planning → plan-review → implementing
              → review-1 → fix-1 → review-2 → fix-2
              → pre-merge → eval-gate → shipcheck-gate → ready-to-deploy
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
  - [Evidence bundle](#evidence-bundle)
  - [Machine-readable artifact conventions](#machine-readable-artifact-conventions)
- [Advanced topics](#advanced-topics)
  - [Configurable steps](#configurable-steps)
  - [Human plan feedback](#human-plan-feedback)
  - [Commit traceability trailers](#commit-traceability-trailers-always-on)
  - [Eval gate](#eval-gate)
  - [Shipcheck gate](#shipcheck-gate)
  - [OpenSpec integration](#openspec-integration)
  - [last30days context](#last30days-context)
  - [Conventions & carry-forward lessons](#conventions--carry-forward-lessons)
- [How the two hosts share one core](#how-the-two-hosts-share-one-core)
- [Repository layout](#repository-layout)
- [Editor / Desktop integration](#editor--desktop-integration)
- [Uninstall](#uninstall)
- [Development](#development)
- [License](#license)

## Prerequisites

The pipeline is **cross-harness** — each run uses one CLI to implement and the *other* to review. **Both CLIs are required regardless of which host you install.**

- **Node ≥ 24** with **`npm`** (npm ships with Node and installs the core's dependencies — commander, js-yaml, zod). The core runs TypeScript directly via native type-stripping; no build step.
- **`git`** and **`gh`** on PATH, with `gh auth status` authenticated against the target repo.
- **Both `claude` and `codex` CLIs** on PATH and **authenticated** — each run uses one to implement and the other to review.
- **Review runs on the *other* harness, invoked directly** (`reviewMode: prompt-harness`): the reviewer CLI is called with the pipeline's own JSON-returning review prompt. **No review plugin is required** — you just need the other harness's CLI installed and authenticated.
- **Same-harness fallback (if the reviewer CLI is missing).** Cross-harness review is the design and the recommended setup — keep both CLIs installed. But if the configured reviewer CLI is *not installed / not spawnable* at review time, the pipeline does not stall: the implementing harness reviews its own work instead, and every such review (plan-review and both rounds) is **prominently labeled as a same-harness self-review** in the posted comment and the stage transition. A self-review is weaker than an independent one, so the label makes clear it was not cross-harness; a self-reviewed item still advances normally (the pipeline never merges — a human owns that). If *neither* harness is spawnable, the item blocks with a specific reason (there is nothing to review with). A reviewer that runs but times out or errors is a genuine failure and still blocks — only a missing CLI triggers the fallback.
- `~/.agent-operating-contract.md` and a per-repo conventions file: `CLAUDE.md` (Claude) or `AGENTS.md` (Codex).
- **Optional:** the [OpenSpec](https://openspec.dev/) CLI (`npm i -g @fission-ai/openspec`) — only needed for repos that opt into the OpenSpec planning flow.
- No API keys — LLM budget comes from your `claude` / `codex` subscriptions.

The installer prints a prerequisite checklist during install (warnings do not block the install).

## Quickstart

**Step 1 — Install**

```bash
# Pinned to a released version (reproducible — recommended):
npx -y github:accidental-hedge-fund/agent-pipeline#v1.2.1 install

# Or track the latest default branch:
npx github:accidental-hedge-fund/agent-pipeline install
```

This detects which of `~/.claude` and `~/.codex` exist and installs to each. After installing for Codex, **restart Codex** to pick up the skill. Pin to a tag (`#v1.2.1`) for a reproducible install; the bare form tracks the latest default branch — see [Install a specific version](#install-a-specific-version).

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

For a reproducible, non-interactive install — pin the released tag (`#v1.2.1`) and auto-accept the optional-dependency prompts with `--yes-deps`:

```bash
npx -y github:accidental-hedge-fund/agent-pipeline#v1.2.1 install --host claude --yes-deps
```

The bare commands above always track the **latest** default branch; add `#<tag>` to pin a release (see [Install a specific version](#install-a-specific-version)). The pipeline is **cross-harness** regardless of which host you install — `--host claude` only controls where the skill lands; the *other* harness's CLI (`codex`) is still required for review.

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
# Install exactly v1.2.1 (any host flag works the same way)
npx -y github:accidental-hedge-fund/agent-pipeline#v1.2.1 install --host claude
```

Everything else is identical to the latest-version commands — `#v1.2.1` just tells `npx` to fetch that tag rather than the default branch. Or clone and check out the tag directly:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
cd agent-pipeline && git checkout v1.2.1
node scripts/install.mjs install --host claude
```

Confirm what's installed at any time with `pipeline --version` (or `/pipeline --version` / `$pipeline --version`).

> The plugin marketplace path above always tracks the **latest** published version and is not a way to pin an older release — use the `#<tag>` form for that.

## Usage

```text
/pipeline N            $pipeline N            advance loop (default; up to 12 transitions)
/pipeline N --status   $pipeline N --status   read-only: stage, blocker, PR, last review
/pipeline N --status --json                   machine-readable JSON status envelope (stable contract)
/pipeline N --summary  $pipeline N --summary  print the run's evidence bundle (local, offline) and exit
/pipeline N --unblock "<answer>"              post answer + clear the blocked label
$pipeline N --unblock "<answer>"              (same for Codex)
/pipeline N --once                            advance one stage and stop
/pipeline N --dry-run                         log only; no harness calls, no GitHub writes
/pipeline --cleanup    $pipeline --cleanup    sweep merged-PR worktrees, then exit (no number)
/pipeline --init       $pipeline --init       onboard: ensure labels + scaffold .github/pipeline.yml
/pipeline doctor       $pipeline doctor       deterministic preflight check; print pass/fail summary, exit (no number)
/pipeline doctor --json                       machine-readable JSON doctor envelope (stable contract)
/pipeline doctor --is-ok                      silent exit-0/1 polling gate; no output
/pipeline N --doctor   $pipeline N --doctor   run the preflight before advancing; abort the run on any failure
/pipeline intake --description "<text>"       spec a rough idea into a GitHub issue + propose a ROADMAP.md PR (no number)
/pipeline intake "<text>" --release v1.6.0    same, pinning the target release slot
/pipeline intake --description "<text>" --dry-run   print the proposed issue + roadmap diff without writing anything
/pipeline sweep                               batch re-spec thin issues + reconcile ROADMAP.md (dry-run; no number)
/pipeline sweep --apply                       same, updating issue bodies and opening a ROADMAP reconciliation PR
/pipeline sweep --apply --repo other/repo     sweep a different repository
/pipeline roadmap                             analyze the open backlog → dependency-aware scored roadmap (dry-run; no number)
/pipeline roadmap --apply                     same, applying hygiene write-backs and opening a roadmap.md PR
/pipeline roadmap --next <N>                  read existing plan.json, emit top-N dependency-safe issues (no re-run)
/pipeline --version    $pipeline --version    print the package version, then exit (no number; -V alias)
```

The number is auto-detected as an issue or PR. PRs resolve to their linked closing issue; PRs with no `Closes #N` are refused. Items must carry a `pipeline:*` label (opt-in) — add `pipeline:ready` to start.

`--cleanup` takes no number: it sweeps pipeline-managed worktrees under `worktree_root` whose PR is already merged, removing the worktree and its local branch. It only touches `pipeline/<N>-<slug>` worktrees, never the remote branch, and skips (reporting the reason) any worktree with uncommitted changes or a local HEAD that differs from the merged PR's commit. It is idempotent — a second run finds nothing to do.

## Intake sub-command

`pipeline intake` is a no-issue-number front-door command that turns a rough one-line description into a decision-complete GitHub issue **and** proposes a matching `ROADMAP.md` update — all in one shot.

```bash
# Generate a spec, create the issue, and open a ROADMAP PR:
/pipeline intake --description "add retry logic to the fix loop"

# Pin the target release slot:
/pipeline intake --description "add retry logic to the fix loop" --release v1.6.0

# Or pass the description as a positional argument:
/pipeline intake "add retry logic to the fix loop"

# Preview without writing anything to GitHub:
/pipeline intake --description "add retry logic to the fix loop" --dry-run
```

**What it does:**

1. **Spec generation (only model-invoking step):** invokes the claude harness with the description to produce a structured spec — Summary, User story, Acceptance criteria (testable `- [ ]` items), Out of scope, and Open questions only when genuinely ambiguous. Follows the same WHAT-not-HOW contract as the `/pm` skill.
2. **Issue creation (deterministic):** creates a GitHub issue with the generated spec body and two labels: `pipeline:ready` and `release:vX.Y.Z`.
3. **ROADMAP PR (deterministic):** writes three mutations to `ROADMAP.md` — a release-plan table row, a per-issue sem-ver table row, and a detail-section bullet — commits them on a new branch (`intake/issue-N-<slug>`), and opens a PR targeting the default branch for human review.

**Flags:**

| Flag | Description |
|------|-------------|
| `--description "<text>"` | Free-text seed description (required unless passed as positional arg). |
| `--release <vX.Y.Z>` | Pin the target release slot. When omitted, the first open lane in `ROADMAP.md` is proposed. |
| `--dry-run` | Print the proposed issue body and ROADMAP diff; exit without writing to GitHub or the filesystem. |

The pipeline never merges — the ROADMAP PR requires a human to review and merge the release-slot placement.

## Sweep sub-command

`pipeline sweep` is a no-issue-number batch maintenance pass that re-specs every thin issue in the backlog and reconciles `ROADMAP.md` in one shot. Without `--apply` it only **previews** what it would change — safe to run at any time.

```bash
# Preview: print which issues would be re-specced and the proposed ROADMAP diff (no writes):
/pipeline sweep

# Apply: update thin issue bodies and open a ROADMAP reconciliation PR:
/pipeline sweep --apply

# Target a different repository:
/pipeline sweep --apply --repo owner/other-repo
```

**What it does:**

1. **Classify (deterministic):** for each open issue, applies a structural heuristic to decide if it is *sufficient* (leave as-is) or *thin* (needs re-speccing). The heuristic checks body length ≥ 150 chars, presence of ≥ 2 required section headings, and that the body isn't a single sentence.
2. **Re-spec (model-invoking, one call per thin issue):** for each thin issue, invokes the claude harness to generate an implementable spec body following the WHAT-not-HOW contract (Summary, User story, Acceptance criteria, Out of scope; Open questions only when genuinely ambiguous). Author context is preserved, not discarded.
3. **Roadmap reconciliation (deterministic):** identifies open issues absent from any of the three ROADMAP structures (release-plan table, per-issue sem-ver table, detail sections) and adds them. Under `--apply`, the update is delivered as a branch + PR for human review — never committed directly to the default branch.

**Flags:**

| Flag | Description |
|------|-------------|
| `--apply` | Apply writes: update thin issue bodies and open the ROADMAP reconciliation PR. Default is dry-run (preview only). |
| `--repo <owner/repo>` | Override the target repository. Default: current repo from `gh` config. |

**Idempotency:** a second sweep run recognizes already-specced issues as sufficient and skips them — no model calls, no updates.

The pipeline never merges — the ROADMAP reconciliation PR requires a human to review and merge.

**Config overrides** (`.github/pipeline.yml`):
```yaml
sweep:
  min_body_length: 200        # minimum body chars (default: 150)
  required_sections:           # headings that must be present (without ##)
    - Summary
    - User story
    - Acceptance criteria
    - Out of scope
```

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
shipcheck_gate:                      # reviewer-owned acceptance rubric after eval-gate, before ready-to-deploy (#148)
  enabled: false                     # default: false; set true to enable
  mode: advisory                     # advisory (default): record without blocking | gate: block on fail verdict
  max_rounds: 1                      # reviewer invocations before surfacing parse-failure (default: 1)
  rubric_path: .github/shipcheck-rubric.md   # repo-root-relative path to the private rubric file
  block_on_partial: false            # gate mode only: when true, a "partial" verdict also blocks (default: false)
format_gate:                         # run formatter/linter commands after each implementing/fix harness (#182)
  - command: cargo fmt               # shell command to run in the worktree root
    auto_fix: true                   # true: commit any changes and re-run; false: block on non-zero exit
  - command: cargo clippy -D warnings
    auto_fix: false
review_policy:                       # which review findings block progression vs. merely advise
  block_threshold: medium            # critical|high|medium|low — findings below this advise, not block (default: medium; 'high' = more throughput, 'low' = block on everything)
  min_confidence: 0.7                # 0..1 — findings below this confidence advise, not block (default: 0.7)
  max_adversarial_rounds: 3          # cap review-round re-runs; after this, still-blocking findings go advisory and the item routes to pipeline:needs-human
doctor:                              # deterministic preflight capability check — see "Preflight (doctor)"
  runOnStart: false                  # default: false; if true, run the preflight before planning and abort the run on any failure
  failFast: false                    # default: false; if true, stop at the first failing check instead of collecting all failures
review_harness: my-reviewer          # optional: override the reviewer CLI for the review step — see "Custom reviewer harness" (default: the profile's reviewer)
# The implementer harness is owned by the install profile and cannot be set here.
# Only the reviewer is overridable, via `review_harness`; a `harnesses:` key is
# rejected at config-parse time.
harness_sandbox: false               # opt-in: true → claude implementer uses --permission-mode default instead of bypassPermissions (see "Sandboxed harness execution")
```

### Custom reviewer harness (`review_harness`)

By default the review step runs on the profile's cross-harness reviewer (`codex` under `/pipeline`, `claude` under `$pipeline`). Set `review_harness` to point review at a different reviewer CLI instead — the implementer harness is unaffected and stays profile-owned:

```yaml
review_harness: my-reviewer          # any CLI on your PATH
```

When set, every review round (plan-review, review-1, review-2) invokes `my-reviewer` in place of the profile reviewer. The pipeline calls it as `my-reviewer "<prompt>"` — the JSON-returning verdict prompt is passed as a single positional argument — and reads the CLI's **stdout** as the review output. A custom reviewer must therefore:

- **Read the prompt from its first positional argument** and run the requested review.
- **Print a fenced JSON verdict block on stdout** matching the schema the pipeline gates on — `{"verdict": "approve" | "needs-attention", "summary": …, "findings": […], "next_steps": […]}` (the same `{{schema_block}}` a built-in reviewer returns; see `core/scripts/review-schema.ts`). Findings drive the severity policy exactly as with a built-in reviewer.
- **Be an installed/authenticated CLI** — no API key is introduced; like `claude`/`codex`, the reviewer brings its own auth.

If the configured CLI is **not installed or not executable**, the review step fails with a specific, named reason (`reviewer CLI 'my-reviewer' not found or not executable — ensure it is installed and on PATH`) and the [same-harness fallback](#prerequisites) applies — the implementing harness reviews instead, prominently labeled. When `review_harness` is absent, the profile's reviewer is used unchanged.

## Preflight (doctor)

`pipeline doctor` runs a fast, **deterministic, model-free** capability check and prints a per-check pass/fail summary — a "this repo is runnable" signal before any autonomous work begins. It exits `0` when everything passes and `1` when any check fails, so it drops cleanly into CI or an onboarding script. It invokes no language model and consumes no tokens.

```bash
/pipeline doctor    # Claude Code primary
$pipeline doctor    # Codex primary
```

The checks (each emits one sentence of remediation text on failure):

| Check | Passes when | Skipped when |
| --- | --- | --- |
| `cli:gh` / `cli:node` | `gh` and `node` are on `PATH` | — |
| `github-auth` | `gh auth status` exits 0 | — |
| `repo-access` | `gh repo view <repo>` succeeds | — |
| `worktree-clean` | the checkout has no uncommitted changes **while on a protected branch** (`main`/`master`/`staging`/`base_branch`); feature branches always pass | — |
| `harness:<bin>` | each configured harness (`claude`/`codex`) is on `PATH` | — |
| `package-install` | `node_modules` exists and is not older than `package-lock.json` | the repo root has no `package-lock.json` |
| `openspec-cli` | the `openspec` CLI is on `PATH` | OpenSpec is not active (`openspec.enabled: off`, or `auto` with no `openspec/` dir) |
| `eval-command` | the configured eval command's binary resolves on `PATH` | the eval gate is off or has no `command` |

**Run-start gating (opt-in).** Set `doctor.runOnStart: true` in `.github/pipeline.yml`, or pass `--doctor` on a normal run, to run the preflight **before planning**. A failing preflight prints the summary and aborts with a non-zero exit **before any planning, implementation, or review tokens are spent**. With neither set, a run is completely unaffected — no checks execute. `--fail-fast` (or `doctor.failFast: true`) stops at the first failing check instead of collecting all failures.

The latest result is stored under `/tmp/pipeline-<domain>-doctor-result.json`; `/pipeline N --status` appends that preflight summary (with its timestamp) when one is present, and omits the section otherwise.

**Machine-readable output (#154).** Two flags expose the doctor result as a stable JSON contract for tooling (e.g. Pipeline Desk):

- `pipeline doctor --json` — emits a single unfenced JSON object with `schema_version`, `status` (`"ok"` or `"error"`), and a `checks` array where each entry is `{name, ok, reason, fix}`. Exit code mirrors the prose path (0 = all pass, 1 = any fail). Human output is suppressed.
- `pipeline doctor --is-ok` — runs all checks, emits **zero bytes of output**, and exits 0 (all pass) or 1 (any fail). Use for cheap polling. Mutually exclusive with `--json`.

Similarly, `pipeline N --status --json` emits a single unfenced JSON object describing the issue's pipeline state (`schema_version`, `status`, `issue`, `stage`, `pr`, `branch`, `worktree`, `last_event`, `review_summary`, `next_action`, `config`). The human `--status` output is unchanged when `--json` is absent.

## Worktree dependency install (`setup_command`)

When the pipeline creates a fresh worktree for an issue, it automatically runs the repo's dependency install step before any stage executes. This ensures binaries (e.g. `vitest`, `jest`, `tsc`) are available when the test/build gate runs.

**Auto-detection (default):** the pipeline checks the worktree root for a lockfile and runs the corresponding install command:

| Lockfile | Command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install` |
| `yarn.lock` | `yarn install` |
| `package-lock.json` | `npm ci` |

When `node_modules` already exists in the worktree (e.g. on a subsequent run), the install step is skipped automatically (idempotent fast-path). When no lockfile is present and no `setup_command` is configured, the step is silently skipped.

**Override or opt out** with `setup_command` in `.github/pipeline.yml`:

```yaml
# Explicit install with flags:
setup_command: "pnpm install --frozen-lockfile"

# Multi-step setup (shell operators work — the command is run via /bin/sh -c):
setup_command: "pnpm install && pnpm run build:types"

# Opt out entirely (skip the install step even when a lockfile is present):
setup_command: ""
```

When `setup_command` is set to a non-empty string, it overrides auto-detection entirely — the configured command runs even when `node_modules` is already present. When set to `""`, the install step is skipped regardless of lockfile presence.

**Failure handling:** if the install command exits non-zero, the pipeline blocks immediately with a `worktree-setup-failed` blocker and surfaces the command output. Subsequent stages never run. The `blocked` comment tells you to fix the root cause (e.g. missing package manager, bad lockfile) or set `setup_command: ""` to opt out, then re-run.

## Sandboxed harness execution (`harness_sandbox`)

By default, the claude implementer runs with `--permission-mode bypassPermissions`, which grants unrestricted host access. Set `harness_sandbox: true` in `.github/pipeline.yml` to switch to claude's native sandboxed permission mode:

```yaml
harness_sandbox: true   # claude implementer uses --permission-mode default (sandboxed)
```

When `harness_sandbox` is `true`, the claude harness is invoked with `--permission-mode default` instead of `bypassPermissions`. All other flags are unchanged. The codex harness is already workspace-sandboxed via `--full-auto` and is unaffected by this setting in both modes.

**Default** (`harness_sandbox: false` or absent): the invocation is byte-identical to the pre-change behaviour — `--permission-mode bypassPermissions`. No change to existing repos unless you opt in.

## Test/build gate (optional, default on)

When `test_gate.enabled` (the default), the target repo's **own** test/build command runs inside the worktree during implementation and **after each fix round**, before a PR is opened or the item advances. If it fails, the implementer harness gets the failure output and retries in a **bounded generate→test→fix loop** — up to `max_attempts` fix invocations (default 3), each test run capped at `timeout` seconds (default 300). The item never opens a PR or advances while the command is failing; persistent failure → `blocked` with the captured output surfaced on the issue.

The command is **auto-detected** (first match wins):

1. Explicit `test_gate.command` override (run through `bash -c` with `set -o pipefail` so shell operators like `&&`, `||`, `;`, and `|` work — and a failing stage in a pipeline like `npm test | tee log` fails the gate instead of being masked)
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

`test_gate.command` is run through `bash -c` with `set -o pipefail`, so compound operators like `&&`, `||`, `;`, and `|` work directly in the config value — and `pipefail` ensures a failing earlier stage in a pipeline (e.g. `npm test | tee log`) fails the gate rather than being hidden by the last stage's exit code. (Configured commands therefore require `bash`; it is assumed present, as on every supported CI runner and dev host.) Auto-detected commands (entries 2–6) continue to spawn the binary directly without a shell.

## Format/lint gate (optional, default off)

The single most common cause of pre-merge CI failures in multi-language repos is formatter/linter drift: the implementing or fix harness produces code that **compiles and passes review but is not style-clean** — `cargo fmt --check`, `cargo clippy -D warnings`, or `eslint` fail only at the CI step after the PR is opened. `format_gate` closes that gap by running configured commands **inside the worktree immediately after each implementing or fix-round harness exits**, before the PR is opened or updated.

Configure `format_gate` in `.github/pipeline.yml` as an array of entries, each with:

- **`command`** (`string`): shell command to run in the worktree root. Run through `/bin/sh -c`, so pipes, `&&`, and env vars are valid.
- **`auto_fix`** (`boolean`): when `true`, the command is expected to mutate files (e.g. `cargo fmt`, `eslint --fix`). The pipeline commits any changes it produces with message `chore: auto-format (#N)` and re-runs the command to verify stability. When `false`, the command is check-only (e.g. `cargo clippy -D warnings`) — a non-zero exit immediately blocks without any worktree mutation.

```yaml
format_gate:
  - command: cargo fmt           # auto-fix: runs, commits any changes, re-runs to confirm stable
    auto_fix: true
  - command: cargo clippy -D warnings   # check-only: blocks on non-zero exit
    auto_fix: false
```

For JS/TS repos:

```yaml
format_gate:
  - command: eslint --fix src/
    auto_fix: true
  - command: prettier --check src/
    auto_fix: false
```

**How it runs:**

1. After the implementing or fix-round harness exits and commit-range verification passes, each format gate entry runs in order.
2. `auto_fix: true` — the command runs. If uncommitted changes are present afterward, they are staged and committed as `chore: auto-format (#N)`. The command then re-runs; if the re-run exits non-zero, the pipeline blocks.
3. `auto_fix: false` — the command runs. If it exits non-zero, the pipeline blocks immediately with the command's combined output as the reason.
4. If the gate produces an auto-format commit, the review-SHA gate recognizes it as pipeline-internal and does **not** re-trigger a full review cycle.

**When no `format_gate` is configured** (the default), the step is a no-op and behavior is completely unchanged — existing pipeline runs are unaffected.

**Failure handling:** a blocked format gate posts a `## Pipeline: Blocked` comment on the issue with the failing command and its output. Fix the formatting/lint issue in the worktree, commit, clear the `blocked` label, and re-run.

## Troubleshooting

### Pipeline is blocked

When the pipeline cannot advance on its own, it applies a `blocked` label to the issue and posts a `## Pipeline: Blocked` comment explaining why. The comment's **### How to unblock** section states the recovery verb that actually resolves *that* blocker class — it is recipe-specific, not a one-size hint. For example:

- **Test/build gate failed** → fix the failing test(s) in the worktree, commit, then re-run.
- **Merge conflict / branch behind** → rebase on the latest target, resolve, push, then re-run.
- **OpenSpec change invalid** → run `openspec validate <change>`, fix the errors, commit, then re-run.
- **No commits produced** → finish and commit the work in the worktree (the pipeline salvages real uncommitted work automatically), then re-run.
- **Needs a human decision** → fix the findings and re-run, **or** record an audited disposition with `--override "<finding-key>: <reason>"`.

To unblock:

1. Read the blocker comment and follow its **### How to unblock** recipe.
2. Address the root cause in the worktree (fix tests, rebase, validate specs, etc.) and commit.
3. Re-run the pipeline — it picks up from the blocked stage:

```bash
gh issue edit N --remove-label "blocked"
/pipeline N   # or: $pipeline N
```

For a blocker that only needs a human answer (no code change), post the answer and clear the label in one step:

```bash
/pipeline N --unblock "your answer or context here"
# or for Codex:
$pipeline N --unblock "your answer or context here"
```

### Common blockers

- **Test gate failure** — the repo's test/build command is failing. Fix the tests, or set `test_gate.command` in `.github/pipeline.yml` if the wrong command is being detected.
- **Reviewer CLI not found or not authenticated** — install and authenticate both `claude` and `codex` CLIs (see [Prerequisites](#prerequisites)).
- **`gh` not authenticated** — run `gh auth login` and try again.
- **Missing `pipeline:ready` label** — create it with `gh label create "pipeline:ready"` before labeling an issue.
- **PR has no `Closes #N` link** — the pipeline cannot resolve a PR to an issue without a closing reference. Add `Closes #N` to the PR body.
- **Review verdict is stale** — if commits land after a review approval, the pipeline detects the stale SHA and re-reviews automatically before advancing.
- **"No commits found in the range"** — the harness step finished without committing **and** left no uncommitted work behind (genuinely empty run). When the harness does leave real uncommitted work in the worktree, the pipeline salvages it automatically into a `salvage: stage harness work (#N)` commit (with the standard `Issue:`/`Pipeline-Run:` trailers) and validates it through the normal gates instead of blocking.

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

### Evidence bundle (run directory)

Every run writes a **run directory** under `.agent-pipeline/runs/<run-id>/` in the repo root, created before the first stage so it survives a mid-run crash. The run id is filesystem-safe (`<issue>-<YYYY-MM-DDTHH-MM-SSZ>`). The directory contains four files:

| File | Written | Contents |
|------|---------|----------|
| `run.json` | At startup | Immutable identity: `schema_version`, `run_id`, `issue`, `repo`, `profile`, `started_at` |
| `events.jsonl` | Incrementally | Append-only event log — one JSON object per line; each has `schema_version`, `type`, `at`. Event types: `run_start`, `run_complete`, `stage_start`, `stage_complete` (with `outcome` and `commits`), `pr_created`, `pr_updated`, `worktree_created`, `review_verdict` (with `round`, `sha`, `verdict`, `finding_counts`). |
| `terminal.log` | Incrementally | Raw combined stdout/stderr of the pipeline run, identical to what appears in the terminal. |
| `summary.json` | At finalization | Full evidence bundle: all stage records, review verdicts, overrides, recovery events, and `final_state`. Absent for crashed runs; treat a missing `summary.json` as in-progress or crashed. |

The `run_id` field in `summary.json` matches the directory name so the two can be joined by a single stable identifier.

It is a **write-only audit supplement**, not a second state machine: GitHub labels and comments remain the authoritative state, and deleting or corrupting the bundle has zero effect on a run. When a run finalizes, the pipeline posts a single comment on the PR (or issue) recording the local bundle path so a maintainer can find it.

**Legacy path.** For backward compatibility, `summary.json` content is also written to `<stateDir>/<issue>/evidence.json` (typically `/tmp/pipeline-<domain>/<issue>/evidence.json`) so existing consumers experience no breakage.

Print a human-readable summary of a run at any time — this reads the local file only, so it works offline:

```bash
/pipeline N --summary
$pipeline N --summary
```

Print or follow the terminal output of a run (works after the process exits, or from another terminal while it runs):

```bash
# print full terminal.log for a run
$pipeline logs <run-id>

# stream new output as it is written (like tail -f)
$pipeline logs <run-id> --follow

# list available run-ids (most recent first)
$pipeline logs
```

Stream lifecycle events to stdout as JSON lines alongside normal output (for orchestrators like Pipeline Desk):

```bash
$pipeline N --json-events
```

Each event emitted to `events.jsonl` is also written to stdout. Human-readable output continues to go to `terminal.log` and the terminal unchanged.

### Machine-readable artifact conventions

Every machine-readable artifact written by the pipeline engine follows these cross-cutting conventions (#161):

**`schema_version` integer.** Every JSON object or JSONL record carries a top-level `schema_version` integer field (currently `1`). Backward-compat promise: field names and types are stable across minor versions; key order is not load-bearing; new optional fields may be added without bumping; removed or renamed fields are major-version bumps. Consumers that ignore unknown fields are forward-compatible. Absent `schema_version` should be treated as `0` (pre-convention).

> **Transitional note (evidence bundle):** The evidence bundle carries both `schema_version` (integer, new) and `schemaVersion` (camelCase, legacy) at the same value during the transitional period. Both are equivalent; new consumers should read `schema_version`.

**Non-fatal I/O.** Every artifact write is wrapped in a non-fatal try/catch. If writing fails (disk full, permissions, etc.) a warning is logged and the error does not propagate — a broken telemetry sink never blocks a stage. The pipeline stage that triggered the write continues and completes normally.

**Write-time injection denylist.** Before persisting any artifact record, the serialized JSON content is passed through a denylist of prompt-injection patterns (e.g. `ignore previous instructions`, `you are now`, `system:`, `disregard`). Matching spans are replaced with `[REDACTED-INJECTION]`. The record is written with the substitution in place; it is never silently dropped. This prevents a replayed artifact line from injecting instructions into a later agent's context.

**Value redaction.** Sensitive values — GitHub tokens, API keys, and env vars whose name matches a secret pattern — are replaced with `[REDACTED]` before any record is written (see `makeCommandRecord` in `evidence-bundle.ts`).

**`_`-prefix local-only fields.** Fields that must not be surfaced to any remote or sync target (e.g. absolute workspace paths, machine-local identifiers) use a leading-underscore name (e.g. `_localPath`). No such fields exist in the current schema (no absolute path fields are stored in machine-readable records), but any future addition of local-only fields must use this convention. The README documents any current `_`-prefixed fields here when they are added.

**Filesystem-only data sharing.** Artifacts share data exclusively through the filesystem. No event bus, IPC daemon, or in-process event emitter is used as a cross-artifact communication channel.

---

## Advanced topics

The following features are all **default off** (or are clearly optional). A reader who completes Prerequisites, Quickstart, and Usage has a fully working setup without needing any of these sections.

### Configurable steps

The `steps` block turns the optional "thoroughness" steps on or off per repo, to trade rigor for speed. Default is everything on (the full pipeline). Configurable: `plan_review`, `standard_review` (review-1 + its fix round), `adversarial_review` (review-2 + its fix round), and `docs` (when on, the implementing prompt instructs the implementer to update affected documentation — README, config docs, and the like — as part of the same change, so docs land inside the reviewed diff; when off, no docs ask is made). The docs step never targets the **conventions file** (`CLAUDE.md`/`AGENTS.md`, or whatever `conventions_md_path` points at): the pipeline only ever *reads* that file (see [Conventions & carry-forward lessons](#conventions--carry-forward-lessons)), so its carry-forward lessons stay maintainer-curated and are never written by a pipeline step. Disabling a step still yields a valid path to `ready-to-deploy`, and each skip is recorded as a transition comment on the issue.

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

### Shipcheck gate

When `shipcheck_gate.enabled` (default **off**), the **reviewer harness** (not the implementer) evaluates a repo-local acceptance rubric **after eval-gate, before `ready-to-deploy`**. This ensures the builder cannot self-certify: the same cross-harness reviewer that caught review findings applies your rubric to the finished change.

**Enable it** in `.github/pipeline.yml`:

```yaml
shipcheck_gate:
  enabled: true
  mode: advisory      # advisory (default) | gate
```

**Rubric file.** Commit a private Markdown rubric at `.github/shipcheck-rubric.md` (override with `rubric_path`). When the file is absent, the pipeline falls back to the issue's acceptance-criteria section (or full issue body) and logs a warning. The rubric text is embedded in the shipcheck prompt, giving the reviewer explicit criteria to evaluate.

**What the reviewer receives.** The shipcheck prompt assembles: the rubric text, the issue body, the implementation plan (from the planning stage comment), a summary of changed files (from the PR diff), the eval-gate outcome (when available), and any OpenSpec spec deltas on the branch. The reviewer returns a structured verdict: `pass`, `partial`, or `fail`, with per-criterion breakdown.

**Modes.**

- **`advisory`** (default) — records the verdict as an issue and PR comment (`## Shipcheck (advisory)`) and always advances to `ready-to-deploy`, regardless of the verdict.
- **`gate`** — posts the verdict comment and **blocks `ready-to-deploy` on a `fail` verdict**. A `partial` verdict also blocks when `block_on_partial: true` (default `false`).

**Parse failures.** If the reviewer output is unparseable after `max_rounds` attempts (default 1): in gate mode, the item is blocked with a `needs-human` blocker; in advisory mode, a warning is logged and the item advances. A reviewer that exits non-zero is always treated as a failed round, even if it printed parseable JSON — a timed-out process must not silently pass the gate.

When disabled (the default), pre-merge and eval-gate skip straight to `ready-to-deploy` and the `shipcheck-gate` label is never applied. **Rollback** is `shipcheck_gate: { enabled: false }`.

### Review severity policy & audited overrides

By default only **high/critical, well-confident** findings block: a `needs-attention` verdict routes to a fix round only when a finding meets the severity threshold and the confidence floor. `review_policy` lets a repo tune this:

- **`block_threshold`** (`critical`|`high`|`medium`|`low`, default `medium`) — findings whose severity is **below** the threshold are recorded as **advisory** and do not route to a fix round. The default `medium` blocks medium-and-above (only low-severity findings advise), so real issues are fixed or explicitly overridden rather than silently advised past at merge (review comments land on the issue, but a human merges the PR). Set `high` to also advise medium findings (more throughput, less rigor), or `low` to block on every finding.
- **`min_confidence`** (`0`..`1`, default `0.7`) — findings whose reported confidence is below this floor advise rather than block, even if high-severity.
- **`max_adversarial_rounds`** (integer, default `3`) — caps how many times a review round may re-run after a fix. Once a round hits the cap with findings still blocking, they are recorded as advisory and the item is parked at the **`pipeline:needs-human`** terminal with a punch-list comment — it never loops to exhaustion and never auto-advances with unresolved blocking findings. Resume by `--override`-ing a finding — which records the disposition and **auto-resumes the run**, flipping the label back to the review round recorded in the ceiling comment — or by fixing the findings by hand and relabeling `pipeline:needs-human` → `pipeline:review-<round>` (the round is recorded in the ceiling comment). Running `--status` on a parked item surfaces this punch-list inline — the count of unresolved blocking findings plus the resume steps — so you don't have to open the issue to see what's left.

The loop is also **recurrence-aware**: when a re-review after a fix round emits a blocking finding whose stable finding key matches one from the immediately-prior round — the exact same finding survived a fix attempt — the item parks at `needs-human` immediately instead of grinding to the round cap (an unchanged re-emit is a proven non-convergence signal; a finding that moves to a different file, severity, or 5-line band carries a different key and is treated as new — but a mere *title rewording* at the same location keeps the same key and is correctly seen as recurring). Each finding on the punch-list is tagged **`RECURRING (n rounds)`** or **`NEW`** so you can instantly see which findings a fix has already failed to resolve. Both mechanisms are pure set-comparisons of the finding keys the pipeline already emits — no extra model or network calls, and no new authority: they only end the loop earlier at the same human gate.

When a review produces findings but **none block** under the policy, the item advances as if approved, and an audited *"advanced under severity policy"* comment records the advisory findings (each with its key, severity, and why it didn't block). The pipeline still stops at `ready-to-deploy` — you still own the merge.

**Audited overrides.** Every finding is shown with a stable `override-key` in the review comment. To disposition one specific blocking finding (e.g. a false positive or out-of-scope ask) so it stops blocking:

```
/pipeline N --override "<override-key>: rejected — <why>"
/pipeline N --override "<override-key>: deferred #123 — tracked separately"
```

This posts an audited `## Pipeline: Finding override` comment (the recording account is the *who*, your reason the *why*), clears the `blocked` label, and **automatically resumes the advance loop** with the override applied — no second invocation needed. From `needs-human`, the label is first flipped back to the review round recorded in the ceiling comment; if other blocking findings remain, the run re-parks at `needs-human` (it never advances past an unresolved blocker, and still stops at `ready-to-deploy`). The key is **location-based and title-stable** (`severity | file | 5-line band`, falling back to a normalized title when the reviewer emits no line), so a finding the reviewer re-emits on a later round keeps the same key — even if it rewords the title or drifts a couple of lines — and the override keeps applying instead of silently lapsing and re-parking the item (#144). **Rollback** to the pre-1.0.1 block-on-everything behavior is `review_policy: { block_threshold: low, min_confidence: 0 }`.

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

### Conventions & carry-forward lessons

Every stage prompt the pipeline builds — planning, plan-review, plan-revision, implementing, both review rounds, and both fix rounds — is injected with an excerpt of the target repo's **conventions file**: `CLAUDE.md` by default (or `AGENTS.md` on the Codex host), or whatever path you set via `conventions_md_path`. The pipeline **reads** this file each run and embeds it so every implementer and reviewer step works against your repo's stated rules, not just inferred style.

This makes the conventions file the natural home for **carry-forward lessons**: a maintainer-curated `## Lessons / Gotchas` section (or a dedicated lessons file pointed at by `conventions_md_path`) where you record recurring review findings, past mistakes, and repo-specific hazards. Because the section is ordinary conventions text, it rides the existing injection into planning and review with **no extra configuration** — there is no separate lessons config key, store, or flag beyond the `conventions_md_path` / `CLAUDE.md` default. Each future run reads the updated lessons, so a pattern you write down once stops recurring.

The contract is deliberately **one-directional — the pipeline only ever reads this file**. No stage (planning, review, fix, pre-merge, eval, deploy-ready, or auto-recover) writes to, appends to, or creates the conventions file; labels and issue/PR comments remain the only pipeline-owned state. You curate the lessons by hand (the human is the loop), and the pipeline carries them forward. A repo with no conventions file is unaffected: `readConventions` returns a benign stub and every stage proceeds normally.

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

## Desktop Integration

Pipeline Desk (or any desktop app) can launch and supervise `agent-pipeline` runs as subprocesses using two stable, host-neutral entry points.

The `pipeline` command is provided by the `agent-pipeline` npm package. Install it globally to make the command available system-wide:

```bash
npm install -g agent-pipeline
pipeline --version   # verify the install
```

If you prefer not to install globally, you can also invoke it via `npx` with an explicit bin selection:

```bash
npx --package agent-pipeline pipeline path --json
```

> **Note:** `npx agent-pipeline` invokes the installer (`scripts/install.mjs`), not the pipeline CLI. Always use `npx --package agent-pipeline pipeline <subcommand>` to reach the `pipeline` bin directly.

### Discover installed hosts — `pipeline path --json`

Before launching a run, probe which hosts are installed:

```bash
pipeline path --json
```

Output (always exits 0; check `hostCoverage` to decide what to do):

```jsonc
// both hosts installed
{
  "corePath": "/Users/alice/.claude/skills/pipeline/core",
  "version": "1.4.0",
  "hostCoverage": "both",          // "missing" | "claude-only" | "codex-only" | "both"
  "hosts": {
    "claude": { "available": true,  "cliBin": "/usr/local/bin/claude" },
    "codex":  { "available": true,  "cliBin": "/usr/local/bin/codex"  }
  }
}

// no install
{
  "corePath": null, "version": null, "hostCoverage": "missing",
  "hosts": {
    "claude": { "available": false, "cliBin": null },
    "codex":  { "available": false, "cliBin": null }
  }
}
```

| `hostCoverage` | Meaning |
|---|---|
| `"missing"` | `pipeline` core not found at any probe location — prompt user to install |
| `"claude-only"` | Core found; only the `claude` CLI is reachable |
| `"codex-only"` | Core found; only the `codex` CLI is reachable |
| `"both"` | Core found; both CLIs are reachable |

Exit code 0 for all resolved states (including `missing`); non-zero only on a probe error (e.g., `npm` not on PATH).

### Launch a detached run — `pipeline run <N> --detach`

Launches the pipeline as a detached background process that **survives the launcher's exit** (SIGTERM-proof via process-group escape):

```bash
pipeline run 153 --detach [--timeout <seconds>] [--flock-timeout <ms>]
```

The command prints the **run directory path** to stdout and exits immediately. The pipeline run continues in the background.

```bash
RUN_DIR=$(pipeline run 153 --detach --timeout 3600)
echo "Run dir: $RUN_DIR"
# /Users/alice/.pipeline/runs/153/2026-06-16_19-49-00
```

**Options:**
- `--timeout <seconds>` — watchdog: kills the run after this many seconds and writes a non-zero sentinel. Recommended for production use.
- `--flock-timeout <ms>` — max ms to wait for the per-issue advisory lock (default: 5000). A second launch for the same issue waits up to this long, then exits non-zero.

### Run directory layout

```
~/.pipeline/runs/<issue>/<timestamp>/
  pipeline.log      stdout + stderr of the pipeline run (appended continuously)
  sentinel.json     written atomically when the run completes (absent while running)
  run-store.json    machine-readable pointer to the .agent-pipeline run store (run_store_dir, events, terminal_log)
  ../
    .lock           advisory lock file (present while a run is active)
```

The wrapper directory above is for **process supervision** (is the run alive? what
exit code?). For **structured run data**, a detached launch pins and prints the
same `.agent-pipeline/runs/<run-id>/` run store a foreground run uses — the
launch logs `structured run artifacts at <repo>/.agent-pipeline/runs/<run-id>/`.
That directory's **`events.jsonl` and `terminal.log` are the Pipeline Desk
contract** (not `pipeline.log`): render the stage timeline from `events.jsonl`
with zero prose parsing, and follow live output with
`pipeline logs <run-id> --follow`. Pass `--json-events` to also stream the event
lines to the detached run's stdout (captured in `pipeline.log`).

### Poll for completion — `sentinel.json`

A poller can classify the run state without parsing prose:

```
sentinel.json absent  → run is still in progress
sentinel.json present → run is done (read exitCode to classify)
```

**`sentinel.json` schema:**

```jsonc
{
  "exitCode": 0,                         // 0 = success; non-zero = failed; -1 = watchdog kill
  "durationMs": 142000,
  "completedAt": "2026-06-16T20:11:22Z",
  "timedOut": true                        // only present when --timeout watchdog fired
}
```

```javascript
// Minimal Node.js poller
const sentinelPath = path.join(runDir, "sentinel.json");
while (!fs.existsSync(sentinelPath)) await sleep(5000);
const { exitCode, timedOut } = JSON.parse(fs.readFileSync(sentinelPath, "utf8"));
// exitCode === 0 → success; timedOut === true → watchdog; else → failure
```

### Pipeline Desk integration checklist

1. Call `pipeline path --json` on startup; prompt install if `hostCoverage === "missing"`.
2. Launch: `RUN_DIR=$(pipeline run <N> --detach --timeout 3600)`.
3. Watch `$RUN_DIR/sentinel.json` for completion (poll or `fs.watch`).
4. Stream `$RUN_DIR/pipeline.log` to the UI while the run is in progress.
5. For a concurrent launch attempt on the same issue, `pipeline run` exits non-zero — handle the error (poll until the prior run finishes, then retry).

### Human interfaces are unchanged

`/pipeline` (Claude) and `$pipeline` (Codex) remain the first-class human entry points. The detached launcher is additive — it does not move any state-machine logic to the desktop side.

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

## Editor / Desktop integration

Pipeline Desk and other editor integrations can delegate all schema and validation knowledge back to the engine via two commands, avoiding any duplication of Zod schema logic.

### `pipeline config schema`

Prints the JSON Schema (draft-2020-12) for `.github/pipeline.yml` to stdout and exits 0. The schema is derived directly from the engine's `PartialConfigSchema`, so it is always in sync with what the engine actually validates.

```bash
pipeline config schema
# → JSON Schema object to stdout
```

Use this to power autocomplete and hover tooltips in your editor integration.

### `pipeline config validate [--repo-path <path>] [--json]`

Validates the `.github/pipeline.yml` at the git root of `--repo-path` (defaults to the current working directory). Exits 0 if valid; exits 1 if any `severity: "error"` diagnostic is present.

```bash
pipeline config validate --repo-path /path/to/repo --json
```

With `--json`, prints a structured JSON object:

```json
{
  "valid": true,
  "diagnostics": []
}
```

Each `Diagnostic` object has the shape:

```json
{
  "severity": "error" | "warning",
  "path": "dotted.field.path (empty string for file-level errors)",
  "message": "Human-readable description",
  "line": 5
}
```

- `line` is present for YAML syntax errors (1-indexed); absent for field-level Zod errors.
- For rigor/cost-gating fields (`review_policy.block_threshold`, `review_policy.min_confidence`, `review_policy.max_adversarial_rounds`, `steps.*`, `eval_gate.enabled/mode`, `shipcheck_gate.enabled/mode`), an invalid value produces a diagnostic with an additional `"rigorGating": true` marker. These are always `severity: "error"` (exit 1) — a typo must never silently flip a rigor switch.
- Inert-model alias warnings (`models.*` set while the backing harness is `codex`) are `severity: "warning"` and do not affect the exit code when they are the only findings.

Without `--json`, a human-readable summary is printed (one line per diagnostic). The same exit-code rules apply.

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
npm run setup-hooks               # one-time per clone: auto-regenerate plugin/ on core/ commits
cd core && npm ci && npm test     # node --test
node scripts/build.mjs            # regenerate plugin/ after editing core or the Claude overlay
node scripts/build.mjs --check    # CI gate: fail if committed plugin/ is stale
npm run ci                        # run the full CI command (tests + build check + install smoke)
```

After changing anything under `core/` or `hosts/claude/SKILL.md`, re-run `build.mjs` and commit the regenerated `plugin/` (CI enforces this). Run `npm run setup-hooks` once per clone to install a local pre-commit hook that does this for you: when a commit touches `core/` or `hosts/claude/` it regenerates and stages `plugin/` + `.claude-plugin/marketplace.json` automatically. It's convenience only — `build.mjs --check` in CI stays the authoritative gate, and `git commit --no-verify` bypasses it.

## License

MIT © AHF
