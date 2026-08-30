## 1. Concepts matrix and adversarial_review link

- [ ] 1.1 Add a dedicated implementer/reviewer pair section in `docs/concepts.md` (near Configurable steps, not inside the adapter login table) with a matrix whose columns are `harnesses.implementer`, `harnesses.reviewer`, and `steps.adversarial_review`. Include rows for Grok implement / Codex review (this repository) and Codex implement / Claude review. Verify the table is present and the adapter login table is unchanged as a login catalog.
- [ ] 1.2 In that section, state that an independent reviewer is the default product and that same-harness self-review is fallback, not the recommended setup. Link `steps.adversarial_review` to `docs/config.md`. Verify the relative link resolves and the fallback sentence is searchable.
- [ ] 1.3 Point that section at `pipeline doctor` as the command that reports the configured implementer and reviewer harnesses (existing `harness:<bin>` checks). Verify the command name is present and that the text does not invent a new doctor check id.
- [ ] 1.4 Rewrite the concepts Grok-profile sentence so Grok/Codex is this repository’s configured pair (a matrix row), not unmarked product law that “Codex remains the reviewer.” Verify the old exclusive sentence is gone.

## 2. Product command and leftover exclusive language

- [ ] 2.1 Change README Quickstart first-run and README Onboarding from `/pipeline N` / `$pipeline N` to `pipeline N`. Optionally keep one labeled historical/host-shim note for Claude Code `/pipeline` and Codex `$pipeline`. Change common-commands `/pipeline decompose` examples to `pipeline decompose`. Verify those first-run blocks invoke `pipeline N` and `wc -l README.md` is under 400.
- [ ] 2.2 Change the `docs/concepts.md` post-init invoke line to `pipeline N`. Change override examples from `/pipeline N --override` to `pipeline N --override`. Change the park-release “`/pipeline` / `pipeline single`” phrasing to CLI form. Leave OpenCode/OMP native `/pipeline` names in README install subsections. Verify concepts first-run is `pipeline N` and OpenCode/OMP install facts remain.
- [ ] 2.3 Sweep leftover exclusive product language in `README.md`, `openspec/project.md`, `docs/supervisor.md`, and `docs/concepts.md`: no “must be Claude vs Codex”, “Claude↔Codex-only”, or “both CLIs required for every install”; README LLM-budget line names configured harness CLIs, not only `claude` / `codex`. Verify those four files fail a search for the exclusive phrases.

## 3. README pointer, supervisor, and project context

- [ ] 3.1 Add a working relative link from README (contents and/or Prerequisites) to the new `docs/concepts.md` role-matrix heading. Do not embed the full table. Verify the markdown link resolves and README stays under 400 lines.
- [ ] 3.2 Update `docs/supervisor.md` so supervisors MUST NOT assume a Claude implement / Codex review pair, MUST read `harnesses.*` from `.github/pipeline.yml`, and MAY confirm the resolved pair with `pipeline doctor`. Verify those three claims are searchable sentences.
- [ ] 3.3 Update `openspec/project.md` so implementer and reviewer are config roles from `harnesses.*`, not host-brand product names. Keep the existing “not a Claude-plus-Codex-only product” host-surface sentence. Verify the role sentence is present.
- [ ] 3.4 Leave `CONTEXT.md`, host `SKILL.md`, `plugin/`, installer host-discovery (`~/.claude` / `~/.codex`), and engine/config code unedited. Verify `git diff -- CONTEXT.md hosts plugin core` is empty for this implementation.

## 4. Validation

- [ ] 4.1 Run `openspec validate docs-harness-role-pairs` and fix structural errors until it passes.
- [ ] 4.2 Run `npm run ci` from the repo root. Verify it is green. This slice has no `core/` edits, so do not regenerate `plugin/`.
- [ ] 4.3 Check `proposal.md` acceptance criteria against the tree (roles not brands, no exclusive-pair sentences, `pipeline N` first-run, concepts matrix with both worked pairs, doctor pointer, `adversarial_review` link, README under 400 lines, no engine change) and record any miss before calling the change done.
