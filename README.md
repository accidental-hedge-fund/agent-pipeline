# agent-pipeline

**agent-pipeline** is a label-driven GitHub issue pipeline that advances an issue from backlog to `pipeline:ready-to-deploy` through a 16-stage state machine — backlog → ready → planning → plan-review → implementing → design-gate → review → fix → pre-merge → visual-gate → eval-gate → shipcheck-gate → ready-to-deploy, with `needs-human` as the terminal park off-ramp. It does **not** auto-merge; you own the merge button.

It ships as a skill for **both Claude Code (`/pipeline`) and Codex (`$pipeline`)** from a single shared TypeScript core. **Both harnesses are required for every run**: one implements, and the other cross-reviews. By default, `/pipeline` uses Claude to implement and Codex to review; `$pipeline` inverts this. The pipeline is cross-harness by design — you cannot skip the reviewer install.

## Lifecycle

![agent-pipeline state machine — ready → deploy-ready, no human writes the code](docs/assets/state-machine.png)

`ready` is the queue/opt-in entry point. Once a run starts, long-running work is labelled and recorded under the concrete stages that are doing it: `planning`, `plan-review`, and `implementing`. Recoverable stops keep the active `pipeline:*` stage plus `blocked`; exhausted or ambiguous paths park at `needs-human`. The pipeline never guesses past uncertainty and never presses merge.

| Band | What happens |
| --- | --- |
| Spec before code | `planning` writes the implementation plan/spec; when enabled, `plan-review` is **independent agent plan review** of that plan (or a labeled same-harness self-review if the reviewer CLI is missing — see [Prerequisites](#prerequisites)) plus an optional **human feedback window** before implementation — not human sign-off. OpenSpec-backed repos reconcile and archive specs during `pre-merge`. |
| Structured review | Reviewers emit findings with severity, confidence, and file/line context. The same review input should lead to the same advance/block decision, not a model coin flip. |
| Bounded convergence | Review/fix rounds are capped by policy and guarded against recurring findings. If the run cannot converge cleanly, it stops with evidence instead of looping indefinitely. |
| Surgical fixes | `fix-1` and `fix-2` are scoped to reviewer findings. No opportunistic refactors, no scope creep, no destructive cleanup. |
| Gated stop | `pre-merge` checks CI, conflicts, mergeability, and spec archive. `visual-gate` can run a repo-defined E2E/visual suite (e.g. Playwright) and captures its artifacts as PR-visible evidence. `eval-gate` can run a repo-defined eval/scoring suite. `shipcheck-gate` lets the reviewer apply an acceptance rubric. |
| Human merge | `ready-to-deploy` is the happy-path terminal for the autonomous loop; `needs-human` is the park terminal when review ceilings or similar paths exhaust. A human owns the merge button. |

| Naive AI loop | agent-pipeline lifecycle |
| --- | --- |
| `prompt -> code -> merge` | `plan -> build -> review/fix -> gated stop` |
| Unreviewed, unbounded, opaque | Reviewed, bounded, audited, human-gated |

## Contents

- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Install](#install)
- [Where to go next](#where-to-go-next)
- [Onboarding a new repo](#onboarding-a-new-repo)
- [Development](#development)
- [License](#license)

## Prerequisites

The pipeline is **cross-harness** — each run uses one CLI to implement and the *other* to review. **Both CLIs are required regardless of which host you install.**

- **Node ≥ 24** with **`npm`** (npm ships with Node and installs the core's dependencies — commander, js-yaml, zod). The core runs TypeScript directly via native type-stripping; no build step.
- **`git`** and **`gh`** on PATH, with `gh auth status` authenticated against the target repo.
- **Both `claude` and `codex` CLIs** on PATH and **authenticated** — each run uses one to implement and the other to review.
- **Review runs on the *other* harness, invoked directly** (`reviewMode: prompt-harness`): the reviewer CLI is called with the pipeline's own JSON-returning review prompt. **No review plugin is required** — you just need the other harness's CLI installed and authenticated.
- **Same-harness fallback (if the reviewer CLI is missing).** Cross-harness review is the design and the recommended setup — keep both CLIs installed. But if the configured reviewer CLI is *not installed / not spawnable* at review time, the pipeline does not stall: the implementing harness reviews its own work instead, and every such review is **prominently labeled as a same-harness self-review**. A self-reviewed item still advances normally (the pipeline never merges — a human owns that). If *neither* harness is spawnable, the item blocks. A reviewer that runs but times out or errors is a genuine failure and still blocks — only a missing CLI triggers the fallback.
- `~/.agent-operating-contract.md` and a per-repo conventions file: `CLAUDE.md` (Claude) or `AGENTS.md` (Codex).
- **Optional:** the [OpenSpec](https://openspec.dev/) CLI (`npm i -g @fission-ai/openspec`) — only needed for repos that opt into the OpenSpec planning flow.
- No API keys — LLM budget comes from your `claude` / `codex` subscriptions.

The installer prints a prerequisite checklist during install (warnings do not block the install).

## Quickstart

**Step 1 — Install**

```bash
# Track the latest default branch:
npx github:accidental-hedge-fund/agent-pipeline install

# Or pin a released tag for a reproducible install (recommended for prod):
npx -y github:accidental-hedge-fund/agent-pipeline#v1.29.1 install
```

This detects which of `~/.claude` and `~/.codex` exist and installs to each. After installing for Codex, **restart Codex** to pick up the skill. Pin to a released tag (see [GitHub Releases](https://github.com/accidental-hedge-fund/agent-pipeline/releases)) for a reproducible install.

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

The pipeline advances the issue through planning, implementation, cross-harness review, fix rounds, and pre-merge checks — without further manual input — and stops at `pipeline:ready-to-deploy` for a human merge.

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

For a reproducible, non-interactive install — pin a released tag and auto-accept optional-dependency prompts with `--yes-deps`:

```bash
npx -y github:accidental-hedge-fund/agent-pipeline#v1.29.1 install --host claude --yes-deps
```

The bare commands track the **latest** default branch; add `#<tag>` to pin a release. The pipeline is **cross-harness** regardless of which host you install — `--host claude` only controls where the skill lands; the *other* harness's CLI is still required for review.

Or clone and run directly:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
node agent-pipeline/scripts/install.mjs install        # --host claude|codex|grok|all  (default: all)
```

The installer copies the shared core and the right host overlay into `~/.claude/skills/pipeline` and/or `~/.codex/skills/pipeline`, writes a launcher shim, and pre-installs the core's dependencies. It honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. **Restart Codex** after a Codex install; Claude picks the skill up live.

### Optional dependency prompts

After the core install, the installer may prompt for optional tools (OpenSpec CLI, last30days skill). Declining still completes the core install.

```bash
npx github:accidental-hedge-fund/agent-pipeline install --yes-deps
PIPELINE_INSTALL_DEPS=1 npx github:accidental-hedge-fund/agent-pipeline install  # same via env var
```

### Grok (optional)

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host grok
# or from a clone:
node scripts/install.mjs install --host grok
```

### Uninstall

```bash
npx github:accidental-hedge-fund/agent-pipeline uninstall --host all   # or claude | codex
# or from a clone:
node scripts/install.mjs uninstall --host all
```

## Where to go next

| Doc | What it covers |
| --- | --- |
| **[docs/cli.md](docs/cli.md)** | Full CLI command reference (generated from the command registry) |
| **[docs/config.md](docs/config.md)** | `.github/pipeline.yml` config key reference (generated from the Zod schema) |
| **[docs/concepts.md](docs/concepts.md)** | Advanced/optional topics: gates, OpenSpec, review policy, desktop integration, troubleshooting |
| **[CHANGELOG.md](CHANGELOG.md)** | Per-version release history (generated from git tags) |
| **[ROADMAP.md](ROADMAP.md)** | Forward-looking release plan |

**Common commands** (see [docs/cli.md](docs/cli.md) for the full inventory):

```text
/pipeline N                 # advance issue N (Claude)
$pipeline N                 # advance issue N (Codex)
/pipeline:status N          # stage, blocker, PR, last review
/pipeline:doctor            # deterministic preflight
/pipeline:init              # labels + .github/pipeline.yml scaffold
```

## Onboarding a new repo

```bash
# From the target repo:
/pipeline:init              # or: pipeline init
# Commit .github/pipeline.yml (edit as needed), then:
gh issue edit N --add-label "pipeline:ready"
/pipeline N
```

`init` ensures pipeline labels, scaffolds `.github/pipeline.yml`, and gitignores local-only `.agent-pipeline/` paths. For configuration detail, see [docs/config.md](docs/config.md). For optional gates, OpenSpec, and conventions, see [docs/concepts.md](docs/concepts.md).

## Development

```bash
npm run setup-hooks               # one-time per clone: auto-regenerate plugin/ on core/ commits
cd core && npm ci && npm test     # node --test
node scripts/build.mjs            # regenerate plugin/ after editing core or the Claude overlay
node scripts/build.mjs --check    # CI gate: fail if committed plugin/ is stale
node scripts/generate-docs.mjs    # regenerate docs/cli.md, docs/config.md, CHANGELOG.md, SKILL tables
node scripts/generate-docs.mjs --check
npm run docs:generate             # same as generate-docs write mode
npm run docs:check                # same as generate-docs --check
npm run ci                        # full CI gate (tests + mirror + install-smoke + openspec + docs + scripts)
```

After changing anything under `core/` or `hosts/claude/SKILL.md`, re-run `build.mjs` and commit the regenerated `plugin/` (CI enforces this). After changing the command registry, config schema, or docs generator, re-run `generate-docs.mjs` and commit generated docs (CI enforces this via `ci:docs` once the generator is present).

`npm run ci` always includes a **conditional** docs freshness step (`ci:docs`): it is a no-op when the docs generator is absent, and runs check-mode when `scripts/generate-docs.mjs` is present — so a stale generated artifact fails the same local command the pipeline test-gate runs.

## License

MIT License

Copyright (c) 2026 AHF

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
