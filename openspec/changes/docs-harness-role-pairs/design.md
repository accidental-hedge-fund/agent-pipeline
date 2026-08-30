## Context

See `proposal.md` for why. Config already has `harnesses.implementer` / `harnesses.reviewer` and `steps.adversarial_review`. #1047 already replaced the README “both CLIs required” sentence with pair language. Leftover: no role matrix, first-run still shows `/pipeline` / `$pipeline`, and a few exclusive Claude/Codex sentences remain in the four in-scope files.

Constraints:

- Docs only. No engine, install, harness-resolution, or default-pair change.
- Keep the README lean (`docs-landing-split`: fewer than 400 lines). README is 321 lines today.
- `CONTEXT.md` glossary terms Implementer and Reviewer already exist (#1047). Do not edit that file.
- Packaging / `plugin/` / MCP are out of scope.

Conflicts (do not average them):

1. Grill lock: `/pipeline` / `$pipeline` are not the product surface; old slash names at most once as history. OpenCode and OMP install sections still document a real native `/pipeline` command. Those are host install artifacts, not the product first-run.
2. Living `readme-user-clarity` still requires the first-run command to be `/pipeline N` or `$pipeline N`. This change MODIFIES that requirement.
3. Living `docs-landing-split` still says the full matrix remains #976. This change MODIFIES that deferral now that #976 is this change.
4. `docs/concepts.md` already has an adapter login table with `harnesses:` YAML examples. That table is login/catalog, not the pair + `adversarial_review` matrix. Do not overload it.

## Goals / Non-Goals

**Goals:**

1. One concepts matrix sourced from existing config keys.
2. First-run examples that match the CLI product surface.
3. Leftover exclusive-pair sentences gone from the four in-scope files.

**Non-Goals:**

- New doctor check, new CLI verb, new config key, or generated matrix.
- Editing `CONTEXT.md`, host `SKILL.md`, `plugin/`, or installer host-discovery text (`~/.claude` / `~/.codex`).
- Changing same-harness fallback behavior; only document it as fallback.

## Decisions

### D1 — Put the matrix in `docs/concepts.md`; keep README a pointer

**Choice:** Add a dedicated “Implementer and reviewer pair” section in `docs/concepts.md`. README gets a short link (contents and/or Prerequisites). Do not paste the table into README.

**Why:** #1047 already forbade expanding README into a full matrix. README is 321/399 lines. The issue names `docs/concepts.md` as an in-scope file.

**Alternatives considered:**

- New `docs/harness-pairs.md` — extra page the issue did not list; README already points at concepts for advanced topics.
- Embed the matrix in README — violates the landing-page budget and the #1047 deferral contract.

### D2 — Hand-author the matrix against existing keys; do not generate it

**Choice:** Write a small Markdown table whose columns are `harnesses.implementer`, `harnesses.reviewer`, and `steps.adversarial_review`. Rows: this repo (Grok / Codex / on) and Codex / Claude / on. Point at generated `docs/config.md` for the flag. Point at `pipeline doctor` for the live pair.

**Why:** First holding rung of the reuse ladder. The keys, the config reference, and doctor `harness:<bin>` checks already exist. A generated matrix would be a new docs-generator concern this issue does not ask for.

**Alternatives considered:**

- Generate the table from the Zod schema — extra machinery, still would need hand-authored examples.
- Add a doctor “Resolved pair: …” banner — engine change, non-goal.

### D3 — Doctor pointer names existing `harness:<bin>` checks

**Choice:** Docs say `pipeline doctor` reports the configured implementer and reviewer harnesses. They describe the existing `harness:<bin>` checks. They do not require a new check id or a labeled summary line.

**Why:** Doctor already preflights both resolved role binaries. Inventing a new output shape is an engine change.

**Alternatives considered:**

- Require a new `roles: implementer=… reviewer=…` doctor line — clearer, but out of scope.

### D4 — Product first-run is `pipeline N`; historical slash names once; host-install `/pipeline` stays

**Choice:** README Quickstart, README Onboarding, and the concepts post-init line use `pipeline N`. One labeled historical note MAY mention Claude Code `/pipeline` and Codex `$pipeline`. OpenCode / OMP install subsections keep their native `/pipeline` command names. Override examples in concepts use `pipeline N --override`.

**Why:** Grill lock names `/pipeline` / `$pipeline` as the old Claude/Codex product tokens. Erasing OpenCode/OMP install facts would be packaging-scope and would be false.

**Alternatives considered:**

- Delete every `/pipeline` string in README — breaks honest OpenCode/OMP install docs.
- Leave Quickstart as `/pipeline` plus `$pipeline` — contradicts the product-surface grill lock.

### D5 — Keep the adapter login table; add a separate pair section

**Choice:** Leave the existing “Adapters, update, lessons…” login table. Add the new matrix near Configurable steps, where `standard_review` / `adversarial_review` are already listed.

**Why:** Login and pairing are different questions. Merging them would mix “how to authenticate `grok`” with “which role is independent review.”

**Alternatives considered:**

- Extend the login table with an `adversarial_review` column — wrong axis; that table is per adapter, not per pair.

### D6 — Treat this-repo Grok/Codex sentences as an example pair, not product law

**Choice:** Rewrite the concepts line “The current Grok profile must use exactly `grok-4.6`… Codex remains the reviewer” so Grok/Codex is this repository’s configured pair (and a matrix row), not a product-wide reviewer brand.

**Why:** The issue asks for that pair as an example. Leaving “Codex remains the reviewer” as unmarked product law reintroduces Claude↔Codex-only reading.

**Alternatives considered:**

- Delete the Grok profile sentence — loses a true local constraint (`models.planning: grok-4.6`) that is not this issue’s target.

### D7 — Do not extend the executable docs checker for the matrix

**Choice:** Landing-page size and companion-link checks stay as they are. Matrix presence is specified and verified by reading the files plus `npm run ci`. Do not add a new `generate-docs` assertion.

**Why:** A new checker is an engine/docs-tooling change. Issue non-goal: no harness-resolution or engine change.

## Risks / Trade-offs

- [README link plus a historical slash note blows the 400-line budget] → Mitigation: replace Quickstart `/pipeline` / `$pipeline` blocks with one `pipeline N` command; net line count should drop.
- [Implementer counts OpenCode `/pipeline` against the “at most once” cap] → Mitigation: D4 excludes host-install artifacts. Spec scenarios say so.
- [Doctor does not print a pretty “implementer=grok reviewer=codex” banner] → Mitigation: D3 documents existing `harness:<bin>` checks. Do not promise a banner.
- [Adapter login table still shows a Claude/Codex YAML example] → Mitigation: that remains a valid pair example; the new matrix is the required sourced table.
- [Living `readme-user-clarity` still requires slash first-run] → Mitigation: MODIFIED delta in this change.

## Migration Plan

1. Land docs + spec deltas on this branch. No runtime migration.
2. Rollback is revert of the docs commit.

## Open Questions

None. Grill lock settles pair-required, product surface, glossary owner (#1047), and the four in-scope files.
