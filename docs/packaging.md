# Packaging contract

The product is the `pipeline` CLI. Hosts wrap that CLI. They are not a second engine.

Terms used here are defined in [CONTEXT.md](../CONTEXT.md).

## Product surface

The product surface is `pipeline <verb> [--json]`, plus the event JSONL stream.

Operators, supervisors, and host shims invoke that same CLI. Machine consumers use `--json` on stdout and the event JSONL log. The generated verb inventory lives in [cli.md](cli.md). This page is the packaging contract, not a second command list.

## Hosts are shims

Hosts are argv or JSON wrappers / short SKILL shims that exec the CLI. A host is not a second pipeline engine.

The contributor path is: install the `pipeline` CLI, then add a short host SKILL that execs that CLI. Do not copy `core/` as the product. Do not treat the committed `plugin/` directory as the distribution product.

## No per-verb slash-command pack

A `/pipeline:*` slash-command pack is not part of the product. Build and install do not emit `pipeline:<command>.md` files or Codex per-verb YAML agents. Hosts exec the CLI through their short SKILL instead.

Uninstall still removes installer-owned `pipeline:*.md` leftovers from older Claude installs. Whole-tree deletion of `plugin/` remains issue #1050.

## MCP is not required

An MCP server is not required. That surface is parked at issue #907.

## Merge authority

Merge is operator-authorized. This repository does not ship a grant factory, MessagingPort, or second control plane. `pipeline advance`, `pipeline single`, and `pipeline loop` stop at `pipeline:ready-to-deploy` and never merge.

## Transitional plugin shell (until #1050)

`plugin/` contains the generated Claude SKILL overlay and marketplace catalog. It does not contain a copy of `core/scripts` or a per-verb command tree. The remaining shell is scheduled for deletion in #1050 and is not the distribution product.

`node scripts/build.mjs --check` asserts that the generated SKILL overlay and marketplace catalog are fresh. After a `core/` or Claude host-SKILL edit, run `node scripts/build.mjs` and include those generated outputs in the same commit.

The installer stages the CLI implementation from `core/` into its managed host install tree. That is the single CLI install path, not a committed `plugin/` mirror or a second engine.

## Related

- [CONTEXT.md](../CONTEXT.md) — packaging glossary
- [cli.md](cli.md) — generated verb inventory
- [concepts.md](concepts.md) — layout and advanced topics
- [supervisor.md](supervisor.md) — supervisors compose the CLI
