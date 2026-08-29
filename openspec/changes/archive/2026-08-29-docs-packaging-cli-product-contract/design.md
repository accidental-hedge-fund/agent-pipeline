## Context

See `proposal.md` for why. Today README, `openspec/project.md`, `AGENTS.md`, `CLAUDE.md`, and `docs/concepts.md` still describe a Claude+Codex skill pair whose distribution is the generated `plugin/` mirror. Root `CONTEXT.md` already has the grill terms (committed on main; started in worktree `docs/1.40.0-packaging-glossary`). The installer still copies core and still writes `/pipeline:*` files. Those install facts change in #1048 / #1050, not here.

Constraints:

- Docs and contributor-convention files only. No engine behavior change.
- Do not rewrite host `SKILL.md` (#1049).
- Do not delete `plugin/` (#1050).
- Do not implement MCP (#907 parked).
- Keep the README lean (`docs-landing-split`: fewer than 400 lines; existing executable companion trio unchanged).

Conflicts (do not average them):

1. Living `namespaced-command-surface` still requires generating `/pipeline:*` entries. This slice reclassifies them in docs as shims. It does not delete the files.
2. Living `core-mirror-sync` still requires a regenerate-and-commit-`plugin/` instruction. This slice makes that instruction transitional until #1048 in repo-root golden-rule files only.
3. Issue #976 is a separate open harness-pair docs item on the same milestone. This slice only changes README pair language as the #1047 grill lock requires. It does not absorb #976.
4. README install still documents that the current installer copies core. Packaging.md states the product contract (CLI + short SKILL) and names the installer/mirror as transitional until #1048 / #1050. Do not claim the installer already stopped copying core.
5. Living `readme-user-clarity` currently requires “both Claude Code and Codex are required” in the first screenful. This slice MODIFIES that requirement so the README pair-language edit does not contradict a living spec. Deeper pair matrix remains #976.

## Goals / Non-Goals

**Goals:**

1. One packaging page that a reader can treat as the product contract.
2. Golden-rule and OpenSpec project text that match that contract, with one honest transitional CI line.
3. Keep `CONTEXT.md` as glossary, including extra terms already on main.
4. Keep docs check / engine / install behavior unchanged.

**Non-Goals:**

- Extending `README_REQUIRED_COMPANIONS` to include `docs/packaging.md` (that would be an engine/docs-check behavior change).
- Generating `docs/packaging.md` from `OPERATION_SURFACE` (the page is a contract essay, not a verb inventory; `docs/cli.md` already lists verbs).
- Rewriting host SKILL essays, install.mjs, or `scripts/build.mjs`.
- Filling #976’s full harness-pair matrix.

## Decisions

### D1 — Hand-author `docs/packaging.md`; do not generate it

**Choice:** Add a short hand-authored page under `docs/`. Link it from README, `docs/concepts.md`, and `docs/supervisor.md`. Keep `docs/cli.md` as the generated verb inventory.

**Why:** The contract is a small set of claims (CLI is the product; hosts are shims; no required slash pack; no MCP; operator-authorized merge). Generating that essay from `OPERATION_SURFACE` would imply one markdown file per verb, which the glossary already forbids.

**Alternatives considered:**

- Fold the contract into README — blows the lean landing page and mixes install how-to with product law.
- Fold into `docs/concepts.md` only — hides the contract behind “advanced topics.”
- Generate from `OPERATION_SURFACE` — wrong artifact class.

### D2 — Keep existing `CONTEXT.md` terms; do not revert the glossary worktree draft

**Choice:** Treat the committed root `CONTEXT.md` as the glossary file this issue requires. Keep CLI, Host, Shim, Slash command, Plugin directory, OPERATION_SURFACE, and MCP server. Keep extra terms already on main (intake, ship path, and later packaging terms). Do not replace the file with the shorter untracked draft in `docs/1.40.0-packaging-glossary`.

**Why:** The issue asks for those grill terms, glossary-only. Stripping later terms would lose living vocabulary for no #1047 gain.

**Alternatives considered:**

- Replace with the shorter glossary worktree file — drops intake/ship-path terms already used by other issues.

### D3 — Rewrite repo-root golden rules only; leave host SKILL.md alone

**Choice:** Edit `AGENTS.md` and `CLAUDE.md` golden rule #1 to “CLI + SKILL” plus one `build.mjs --check` until #1048 line. Leave `hosts/*/SKILL.md` wording to #1049.

**Why:** Grill lock names AGENTS.md in this issue. Repo convention keeps CLAUDE.md in sync. Rewriting SKILL.md is an explicit non-goal.

**Alternatives considered:**

- Also rewrite SKILL.md now — violates #1049 boundary and invites an 80KB essay edit.

### D4 — Document the future contract; name the transitional mirror honestly

**Choice:** Packaging.md states the product as CLI + short SKILL, not copy core. When it mentions `plugin/` or `build.mjs --check`, it labels them transitional until #1048 / #1050. README Development may keep the current `build.mjs --check` commands as the still-true CI gate, pointed at packaging.md for the product law.

**Why:** Lying that the installer already stopped copying core would fail the next review. Lying that `plugin/` is the product is the bug this issue fixes.

**Alternatives considered:**

- Rewrite README install as if #1048 already shipped — false.
- Leave README saying `plugin/` is how the engine is distributed — the bug.

### D5 — Do not extend the executable README companion checker

**Choice:** Require relative links in prose/spec. Do not add `docs/packaging.md` to `README_REQUIRED_COMPANIONS` in this slice.

**Why:** Issue requires no engine behavior change. The existing checker trio stays the landing-page fail-closed path.

**Alternatives considered:**

- Add packaging.md to the checker now — small and useful, but it is a `core/scripts` behavior change and would force a `plugin/` regen.

### D6 — Reclassify slash commands in docs; do not MODIFIED-delete `namespaced-command-surface`

**Choice:** Add a requirement that packaging docs call `/pipeline:*` entries optional CLI shims. Leave the generation requirement in force until #1048 / #1050.

**Why:** Deleting the generation law here would contradict the still-shipping installer and the “no engine change / no plugin delete” non-goals.

### D7 — README pair language is the #1047 slice of #976, not the whole issue

**Choice:** Replace “both Claude and Codex CLIs are required” with implementer/reviewer pair from `.github/pipeline.yml`. Leave full pair matrix, same-harness fallback narrative, and host catalog to #976.

**Why:** Grill lock for #1047 names that README sentence. Absorbing #976 would broaden this docs slice.

**Alternatives considered:**

- Rewrite the full harness-pair matrix in README now — that is #976.

### D8 — MODIFY `readme-user-clarity` instead of leaving the both-CLIs living requirement in force

**Choice:** Copy the living “README opens with a purpose-first summary” requirement under `## MODIFIED Requirements` and replace “both Claude Code and Codex are required” with the implementer/reviewer pair. Keep the other `readme-user-clarity` requirements (quickstart, optional-section separation, Grok subsection as install-path docs).

**Why:** A README edit that only lives in `docs-landing-split` / `cli-product-packaging` would still fail the archived `readme-user-clarity` first-screenful contract at archive time.

**Alternatives considered:**

- Leave `readme-user-clarity` unchanged — implementation would contradict a living spec.
- Rewrite every `readme-user-clarity` requirement that mentions Claude or Codex — over-scope; those remaining lines are install-host docs, not the “both CLIs required as the product” sentence.

## Risks / Trade-offs

- [Docs say CLI + SKILL while installer still copies core] → Mitigation: packaging.md names #1048 / #1050 as the install and deletion slices. Do not claim those already shipped.
- [Living `namespaced-command-surface` still requires generating slash files] → Mitigation: this slice only reclassifies them in docs. Later slices remove generation.
- [Living `core-mirror-sync` vs new golden rule] → Mitigation: MODIFIED requirement keeps regen until #1048; ADDED requirement forbids forever-rule wording in AGENTS.md / CLAUDE.md.
- [README line budget] → Mitigation: add a short link and swap pair sentences; do not paste packaging.md into README.
- [#976 still open on v1.40.0] → Mitigation: this slice only does the pair-language sentence. Remaining harness-pair docs stay on #976.
- [Living `readme-user-clarity` still requires both CLIs] → Mitigation: MODIFY that first-screenful requirement in this change. Do not leave the old wording in force.

## Migration Plan

1. Land docs + convention files on this branch. No install migration.
2. After merge, #1048 / #1049 / #1050 implement the contract this page describes.
3. Rollback is revert of the docs commit. No runtime rollback.

## Open Questions

None. Grill lock settles the contract claims. Transitional honesty for the still-present `plugin/` tree is a decision (D4), not a later question.
