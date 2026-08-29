## 1. Glossary and packaging page

- [x] 1.1 Confirm root `CONTEXT.md` defines CLI, Host, Shim, Slash command, Plugin directory, OPERATION_SURFACE, and MCP server, remains glossary-only, and keeps extra terms already on main. Verify by reading the file: all seven terms present, no implementation steps.
- [x] 1.2 Add hand-authored `docs/packaging.md` covering CLI contract (`pipeline <verb> [--json]` plus event JSONL), hosts as shims, slash-command pack not required, MCP not required (#907 parked), operator-authorized merge with no grant factory / MessagingPort / second control plane, contributor path as install CLI + short SKILL, and `plugin/` as transitional until #1050. Verify the file exists and each claim is a searchable sentence.

## 2. Landing pages and supervisor docs

- [x] 2.1 Add a working relative link to `docs/packaging.md` from root `README.md` (contents and/or Where to go next). Verify the markdown link resolves and `README.md` stays under 400 lines (`wc -l`).
- [x] 2.2 Rewrite README purpose and prerequisites so they describe an implementer/reviewer pair from `.github/pipeline.yml`, not “both Claude and Codex CLIs are required.” Verify the first screenful satisfies the modified `readme-user-clarity` purpose-first requirement, and that the exact “both CLIs are required” / “Both \`claude\` and \`codex\` CLIs” product sentences are gone.
- [x] 2.3 Point README Development at the packaging contract for product law, while leaving current `build.mjs --check` commands as the still-true CI gate until #1048. Verify Development still documents `node scripts/build.mjs --check` and does not call `plugin/` the product.
- [x] 2.4 Add a working relative link to `docs/packaging.md` from `docs/concepts.md` (contents and the hosts/core section). Rewrite the “Claude host also feeds the generated `plugin/` marketplace mirror” product wording so `plugin/` is transitional, not the distribution product. Verify the link and that the layout table does not call `plugin/` the product.
- [x] 2.5 Add a working relative link to `docs/packaging.md` from `docs/supervisor.md`. Verify the page still states merge is operator-authorized and that this repository does not ship a grant factory or second control plane.

## 3. Contributor conventions

- [x] 3.1 Rewrite `AGENTS.md` golden rule #1 to: product is CLI + short SKILL; one line that `build.mjs --check` still applies until #1048. Verify the forever “always commit the regenerated `plugin/`” wording is gone from golden rule #1.
- [x] 3.2 Apply the same golden rule #1 rewrite to `CLAUDE.md`. Verify the two files match on this rule.
- [x] 3.3 Rewrite `openspec/project.md` so it is not “Claude+Codex only” and not “always commit the mirror” as the forever packaging rule. Verify those two phrases are gone and the CLI/host-shim contract is present.
- [x] 3.4 Leave host `SKILL.md` files and the `plugin/` tree unedited. Verify `git diff -- hosts/*/SKILL.md plugin/` is empty for this implementation.

## 4. Validation

- [x] 4.1 Run `openspec validate docs-packaging-cli-product-contract` and fix structural errors until it passes.
- [x] 4.2 Run `npm run ci` from the repo root. Verify it is green. This slice has no `core/` edits, so do not regenerate `plugin/`.
- [x] 4.3 Check `proposal.md` acceptance criteria against the tree (packaging page linked, CONTEXT.md glossary, AGENTS.md product-first, contributor path, no engine change) and record any miss before calling the change done.
