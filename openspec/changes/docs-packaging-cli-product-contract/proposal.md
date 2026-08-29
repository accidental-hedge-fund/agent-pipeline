## Why

Operator and contributor docs still present `plugin/` as how the engine is distributed. The product is the `pipeline` CLI. Hosts are argv wrappers. v1.40.0 starts by locking that contract in docs before install (#1048), short SKILL (#1049), and `plugin/` deletion (#1050).

## What Changes

- Add hand-authored `docs/packaging.md` as the packaging contract: `pipeline <verb> [--json]` plus event JSONL is the product surface; hosts are shims; slash-command packs are not required; MCP is not required (#907 parked).
- Keep root `CONTEXT.md` as glossary only. It already exists. This change SHALL keep the grill terms (CLI, Host, Shim, Slash command, Plugin directory, OPERATION_SURFACE, MCP server) and SHALL NOT turn the file into implementation notes.
- Rewrite AGENTS.md golden rule #1 (and the matching CLAUDE.md rule, which stays in sync): the product is CLI + short SKILL. One transitional line: `build.mjs --check` still applies until #1048. Stop stating “always commit the `plugin/` core mirror” as the forever rule.
- Rewrite `openspec/project.md` so it is not “Claude+Codex only” and not “always commit the mirror” as the forever packaging rule.
- README: describe an implementer/reviewer **pair** from `.github/pipeline.yml` (see #976). Stop saying both Claude and Codex CLIs are required as the product. Keep the README lean. Link `docs/packaging.md` from README and `docs/concepts.md`.
- Supervisor docs: one sentence that merge is operator-authorized; no grant factory, MessagingPort, or second control plane. Link `docs/packaging.md`.
- **No engine behavior change.** Do not delete `plugin/` (#1050). Do not rewrite host SKILL.md (#1049). Do not implement MCP.

## Capabilities

### New Capabilities

- `cli-product-packaging`: Docs contract that the product is the `pipeline` CLI (`pipeline <verb> [--json]` plus event JSONL). Hosts are shims. Contributor path is install CLI + short SKILL, not copy `core/` or treat `plugin/` as distribution. MCP is not required. Merge remains operator-authorized with no grant factory.

### Modified Capabilities

- `docs-landing-split`: README and `docs/concepts.md` SHALL link `docs/packaging.md`. README SHALL describe an implementer/reviewer pair, not a Claude+Codex-only “both CLIs required” product.
- `core-mirror-sync`: Repo-local golden-rule files SHALL stop teaching “always commit `plugin/`” as the forever product rule. Until #1048 they MAY keep one transitional `build.mjs --check` line.
- `namespaced-command-surface`: Existing `/pipeline:*` host entries SHALL be documented as optional shims that exec the CLI, not as the product surface. This slice does not delete those files.

## Acceptance criteria

- [ ] `docs/packaging.md` exists at repo root `docs/`.
- [ ] Root `README.md` contains a working relative link to `docs/packaging.md`.
- [ ] `docs/concepts.md` contains a working relative link to `docs/packaging.md`.
- [ ] `docs/packaging.md` states that the product surface is `pipeline <verb> [--json]` plus event JSONL.
- [ ] `docs/packaging.md` states that hosts are argv (or JSON) wrappers / short SKILL shims, not a second engine.
- [ ] `docs/packaging.md` states that a `/pipeline:*` slash-command pack is not required as the product.
- [ ] `docs/packaging.md` states that an MCP server is not required and is parked (#907).
- [ ] `docs/packaging.md` states that merge is operator-authorized and that this repository does not ship a grant factory, MessagingPort, or second control plane.
- [ ] Root `CONTEXT.md` is committed and defines CLI, Host, Shim, Slash command, Plugin directory, OPERATION_SURFACE, and MCP server.
- [ ] `CONTEXT.md` remains glossary-only (term, meaning, avoid-list). It does not contain implementation steps.
- [ ] `AGENTS.md` golden rule #1 names CLI + SKILL as the product and does not say “always commit the `plugin/` core mirror” as the forever rule.
- [ ] `AGENTS.md` golden rule #1 (or the immediately following sentence) states that `build.mjs --check` still applies until #1048.
- [ ] `CLAUDE.md` golden rule #1 matches `AGENTS.md` on this point (repo convention: keep them in sync).
- [ ] `openspec/project.md` does not say the product is Claude+Codex only.
- [ ] `openspec/project.md` does not say “always commit the regenerated `plugin/`” as the forever packaging rule.
- [ ] README does not say both Claude and Codex CLIs are required as the product. It describes a configured implementer/reviewer pair.
- [ ] Contributor-facing docs (README Development and/or `docs/packaging.md`) present the contributor path as install the CLI + a short host SKILL, not “copy `core/`” or “ship `plugin/` as the product.”
- [ ] `docs/supervisor.md` links `docs/packaging.md` and retains the operator-authorized merge / no grant-factory sentence.
- [ ] Host SKILL.md files are not rewritten in this slice (#1049).
- [ ] `plugin/` is not deleted in this slice (#1050).
- [ ] No pipeline stage-machine, CLI verb, install, merge, or review-policy behavior change.
- [ ] `npm run ci` is green (including `openspec validate --all` and docs freshness when the generator is present).

## Impact

- **Docs:** new `docs/packaging.md`; links from README, `docs/concepts.md`, and `docs/supervisor.md`; glossary retention in `CONTEXT.md`.
- **Contributor conventions:** `AGENTS.md`, `CLAUDE.md`, `openspec/project.md`.
- **Specs:** new `cli-product-packaging`; deltas for `docs-landing-split`, `core-mirror-sync`, `namespaced-command-surface`.
- **Engine / install / plugin tree:** none in this slice.
- **Related later slices (out of scope):** #1048 Claude install provisions CLI (no core copy, no `/pipeline:*` files); #1049 short SKILL; #1050 delete `plugin/`; #976 deeper harness-pair docs; #907 MCP parked.
- **Parent:** #1046 (unmiled tracker). Program: v1.40.0 first slice. No `Depends on`.
