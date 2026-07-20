## 1. Harness codex model passthrough

- [ ] 1.1 In `invoke()` (`core/scripts/harness.ts`) codex branch, append `-m <model>` when `opts.model` is set, placed before the trailing prompt positional; keep the existing `-c model_reasoning_effort=<value>` effort flag ordering
- [ ] 1.2 Update the `InvokeOptions.model` JSDoc and the file header comment to note that codex now honors `-m <model>` (drop "Currently only honored by claude")
- [ ] 1.3 Add unit tests asserting the built codex argv: model+effort → includes `-m <model>` and `-c model_reasoning_effort=<level>`; effort-only → no `-m`; claude branch argv unchanged (`--model`/`--effort`); custom CLI receives neither flag

## 2. Reviewer-harness-aware model resolution (auto sentinel)

- [ ] 2.1 Make reviewer model resolution consult the reviewer's actual harness so an `auto`-resolved model is not a claude-only alias handed to codex: when the reviewer is codex and the resolved reviewer model is a claude-only alias (the Adversarial routing cells yield only `claude-fable-5`), pass `undefined` (omit `-m`) instead
- [ ] 2.2 Preserve verbatim passthrough of an explicit (non-`auto`) reviewer model to codex (`-m <id>`) — the operator owns naming a codex-valid id
- [ ] 2.3 Keep the claude reviewer path identical (explicit and `auto` both resolve/pass exactly as today)
- [ ] 2.4 Add unit tests: codex reviewer + `models.review: auto` (and structured `review_harness.model: auto`) → no `-m`; codex reviewer + explicit `gpt-5.6-terra` → `-m gpt-5.6-terra`; claude reviewer + `auto` → `-m claude-fable-5` (round-aware, unchanged)

## 3. Inert-model warning reframe

- [ ] 3.1 In `warnInertModelAliases` (`core/scripts/config.ts`), change the `models.review` branch to warn when the reviewer is a **custom** CLI (not `claude`, not `codex`) and to NOT warn when the reviewer is `codex`; leave implementer-role keys (`planning`/`implementing`/`fix`) warning under a codex implementer unchanged
- [ ] 3.2 Apply the same reframe to the `validateConfig` mirror of this warning (the `config validate` path around the `models.${key} … is "codex"` message)
- [ ] 3.3 Add unit tests: `models.review` + codex reviewer → no warning; `models.review` + custom reviewer CLI → warning naming the key, value, and reviewer command; `models.planning` + codex implementer → warning (unchanged)

## 4. Unavailable-model error surfacing

- [ ] 4.1 Verify an unknown codex model exits nonzero and its stderr is captured; ensure the blocked-item evidence includes codex's stderr excerpt and the configured model id (no silent fallback)
- [ ] 4.2 Add a unit test: codex reviewer invoked with an unavailable model and a nonzero exit produces a blocked result whose evidence names the configured model and includes codex's CLI output

## 5. Docs

- [ ] 5.1 Update the `pipeline init` scaffold comments in `renderModelLines` (`config.ts`) so the codex reviewer case is not described as inert; `models.review` is honored by codex
- [ ] 5.2 Update `README.md` `models:` block comments (and any "only the claude harness honors these" line) to reflect codex reviewer model passthrough
- [ ] 5.3 Update the skill docs (`hosts/**/SKILL.md`) where the codex-reviewer model caveat appears

## 6. CI gate

- [ ] 6.1 Regenerate the mirror: `node scripts/build.mjs`, commit `plugin/` with `core/` in the same change
- [ ] 6.2 Run `npm run ci` from repo root and confirm green (core tests + `build.mjs --check` + install smoke + `openspec validate --all`)
