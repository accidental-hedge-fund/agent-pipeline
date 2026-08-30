## Why

Operator docs still read as a Claude↔Codex product even though repository config already selects an implementer/reviewer pair. This leftover “must be Claude vs Codex” sweep is issue #976: #1047 locked packaging and pair *language*; this change documents the configurable pair, the `adversarial_review` flag, and `pipeline` CLI as the product surface.

## What Changes

- Sweep absolute language in `README.md`, `openspec/project.md`, `docs/supervisor.md`, and `docs/concepts.md` so implementer and reviewer are config roles from `.github/pipeline.yml`, not fixed product names.
- Document a role matrix sourced from `harnesses.implementer`, `harnesses.reviewer`, and `steps.adversarial_review`. Keep it out of the lean README: a short pointer there, the matrix in `docs/concepts.md`.
- Show worked pairs: Grok implement / Codex review (this repo) and Codex implement / Claude review. State that one-harness self-review is not the default product.
- Point operators at `pipeline doctor` for the resolved pair (existing `harness:<bin>` checks). Do not add a new doctor check.
- Link `steps.adversarial_review` to generated `docs/config.md` wherever those four files describe review-1 / review-2.
- Make the operator first-run command `pipeline N`. Treat Claude Code `/pipeline` and Codex `$pipeline` as historical/host-shim names, not the product.
- **No engine, install, harness-resolution, or default-pair change.** No packaging / `plugin/` work. No MCP. No `CONTEXT.md` glossary edit (#1047 already added Implementer and Reviewer).

## Capabilities

### New Capabilities

- `docs-harness-role-pairs`: Operator-docs contract that implementer and reviewer are repository config roles, that the pair plus `steps.adversarial_review` is shown as a matrix, that `pipeline doctor` is the resolved-pair surface, and that the product command is the `pipeline` CLI.

### Modified Capabilities

- `docs-landing-split`: README stays lean and points at the concepts matrix. Drop the “full harness-matrix remains issue #976” deferral.
- `readme-user-clarity`: First-run example uses `pipeline N`. Drop the requirement that the first-run command is `/pipeline N` or `$pipeline N`. Drop the “deeper harness-pair documentation remains issue #976” deferral.

## Acceptance criteria

- [ ] `README.md`, `openspec/project.md`, `docs/supervisor.md`, and `docs/concepts.md` describe implementer and reviewer as `.github/pipeline.yml` roles (`harnesses.implementer`, `harnesses.reviewer`), not as fixed product names.
- [ ] Those four files contain no remaining “must be Claude vs Codex”, “Claude↔Codex-only”, or “both Claude and Codex CLIs are required for every install” product sentences.
- [ ] README Quickstart first-run and Onboarding invoke `pipeline N` (the CLI). They do not present `/pipeline N` or `$pipeline N` as the required product command.
- [ ] In those four files, Claude Code `/pipeline` and Codex `$pipeline` appear at most once as a historical or host-shim alias. Host-specific install subsections MAY still name that host’s native command (OpenCode / OMP) as an install artifact.
- [ ] `docs/concepts.md` contains a role matrix whose columns are sourced from `harnesses.implementer`, `harnesses.reviewer`, and `steps.adversarial_review`.
- [ ] That matrix includes the worked pairs Grok implement / Codex review (this repository) and Codex implement / Claude review.
- [ ] Adjacent prose states that an independent reviewer is required as the default product and that one-harness self-review is fallback, not the recommended setup.
- [ ] The matrix section, README pointer, or supervisor prerequisites name `pipeline doctor` as the command that reports the resolved pair.
- [ ] Operator text in the four files that describes review-1 / review-2 links `steps.adversarial_review` to `docs/config.md`.
- [ ] Root `README.md` stays under 400 lines and does not embed the full matrix.
- [ ] `CONTEXT.md` is unchanged in this change.
- [ ] No harness resolution, default pair, install, merge, review-policy, or stage-machine behavior change.
- [ ] `npm run ci` is green, including `openspec validate --all` and docs freshness when the generator is present.

## Impact

- **Docs:** `README.md`, `openspec/project.md`, `docs/supervisor.md`, `docs/concepts.md`.
- **Specs:** new `docs-harness-role-pairs`; deltas for `docs-landing-split` and `readme-user-clarity`.
- **Engine / install / plugin / CONTEXT.md / host SKILL.md:** none.
- **Reuse:** existing `harnesses.*` keys, `steps.adversarial_review`, generated `docs/config.md`, and `pipeline doctor` `harness:<bin>` checks. No new config key, CLI verb, or doctor check.
- **Related:** parent packaging #1046 / #1047 (done, no hard dep). Packaging deletion #1048–#1050 is out of scope. Program v1.40.0. Issue #976.
