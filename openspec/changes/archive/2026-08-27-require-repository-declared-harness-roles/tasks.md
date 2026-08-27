## 1. Fail-closed execution-policy gate

- [x] 1.1 Add a dedicated check in shared configuration resolution that requires `.github/pipeline.yml` plus both `harnesses.implementer` and `harnesses.reviewer` for execution, and verify a unit test fails `resolveConfig()` on a missing file without calling worktree, GitHub, or harness fakes
- [x] 1.2 Fail closed when the file exists but omits `harnesses`, `harnesses.implementer`, or `harnesses.reviewer`, and verify one unit test per missing path names that key and states that the active profile does not fill live workers
- [x] 1.3 Keep Zod `harnesses.implementer` / `reviewer` optional so absence is distinct from an unknown key or empty string, and verify empty-string values still fail `min(1)` while the dedicated check covers omission
- [x] 1.4 Stop `resolveHarnessRoles` / `tolerateInvalidConfig` from selecting a live role from the active profile on the execution path, and verify a partial file under the `claude` profile does not resolve reviewer `codex` by fallback

## 2. Complete declaration and overlays

- [x] 2.1 Resolve both declared roles identically under the `claude` and `codex` profiles, and verify a unit test pins `implementer: grok` / `reviewer: codex` for both profiles
- [x] 2.2 Treat `review_harness` without `harnesses.reviewer` as partial policy, and verify `resolveConfig()` fails naming `harnesses.reviewer` rather than adopting the `review_harness` command
- [x] 2.3 Keep agreeing `review_harness` structured model/effort/prompt-delivery and keep conflicting-command rejection, and verify the existing agreeing and conflicting tests still pass with both `harnesses` keys present
- [x] 2.4 Record live role sources as `repo-config` on execution runs, and verify evidence tests no longer accept `profile` as a live implementer or reviewer source

## 3. Exemptions and callers

- [x] 3.1 Exempt `pipeline init` so a missing file can be created, and verify `init` still does not invoke implementer or reviewer harnesses
- [x] 3.2 Confirm `--version` / `-V` and `path` never resolve execution config, and verify they succeed in a fixture repo with no `.github/pipeline.yml`
- [x] 3.3 Confirm `single`, loop item dispatch, `train`, and `ship` call the same `resolveConfig()` path before worktree/GitHub/harness work, and verify an injected-fake test for at least `single` fails closed on a missing reviewer with zero fake side effects
- [x] 3.4 Confirm installed host launchers inject at most `--profile` and do not write live harness roles, and verify no launcher template sets `harnesses.implementer` or `harnesses.reviewer`

## 4. Init scaffold, validate, schema, docs

- [x] 4.1 Write both harness keys as active values in a new `pipeline init` scaffold (starter pair from the active profile), and verify the written file contains uncommented `implementer` and `reviewer` and round-trips through `resolveConfig()`
- [x] 4.2 Remove "falls back to the active profile" wording from schema `.describe()` text, init/sync scaffold comments, and SKILL.md examples, and verify `pipeline config schema` output plus the rendered template do not mention live-role profile fallback
- [x] 4.3 Make `pipeline config sync` refuse to invent a missing live role from the profile, and verify a fixture that omits `harnesses.reviewer` is not rewritten with a profile value
- [x] 4.4 Emit `pipeline config validate` error diagnostics for missing file (existing), missing `harnesses` block, and each missing role, and verify `--json` exit 1 plus named paths
- [x] 4.5 Regenerate `docs/config.md` from the schema if descriptions change, and verify `npm run ci` docs check (or `generate-docs --check`) is green

## 5. Packaging and gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror in the same change, and verify `node scripts/build.mjs --check` passes
- [x] 5.2 Run `npm run ci` from the repo root and verify it passes, including `openspec validate --all`
