# Packaging contract

The product is the `pipeline` CLI. Hosts wrap that CLI. They are not a second engine.

Terms used here are defined in [CONTEXT.md](../CONTEXT.md).

## Product surface

The product surface is `pipeline <verb> [--json]`, plus the event JSONL stream.

Operators, supervisors, and host shims invoke that same CLI. Machine consumers use `--json` on stdout and the event JSONL log. The generated verb inventory lives in [cli.md](cli.md). This page is the packaging contract, not a second command list.

## Hosts are shims

Hosts are argv or JSON wrappers / short SKILL shims that exec the CLI. A host is not a second pipeline engine.

The contributor path is: install the `pipeline` CLI, then add a short host SKILL that execs that CLI. Do not copy `core/` as the product. Do not treat the committed `plugin/` directory as the distribution product.

## Slash commands are optional shims

A `/pipeline:*` slash-command pack is not required as the product. Existing `pipeline:<command>` host entries are optional shims that exec the CLI. They are not a second product surface.

This page does not delete those files. Stop of `/pipeline:*` file emission is issue #1048. Deletion of `plugin/` is issue #1050.

## MCP is not required

An MCP server is not required. That surface is parked at issue #907.

## Merge authority

Merge is operator-authorized. This repository does not ship a grant factory, MessagingPort, or second control plane. `pipeline advance`, `pipeline single`, and `pipeline loop` stop at `pipeline:ready-to-deploy` and never merge.

## Transitional mirror (until #1048 / #1050)

`plugin/` is a generated mirror of `core/` (plus the Claude host overlay). It is scheduled for deletion in #1050. It is not the distribution product.

Until #1048, `node scripts/build.mjs --check` remains the CI gate for that mirror. After a `core/` edit, run `node scripts/build.mjs` and include the regenerated `plugin/` in the same commit. That is a transitional CI gate, not the product rule.

The current installer may still copy `core/` into a host config tree. That install behavior changes in #1048. This page states the product contract. It does not claim #1048 already shipped.

## Related

- [CONTEXT.md](../CONTEXT.md) — packaging glossary
- [cli.md](cli.md) — generated verb inventory
- [concepts.md](concepts.md) — layout and advanced topics
- [supervisor.md](supervisor.md) — supervisors compose the CLI
