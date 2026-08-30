# Packaging contract

The product is the `pipeline` CLI. Hosts wrap that CLI. They are not a second engine.

Terms used here are defined in [CONTEXT.md](../CONTEXT.md).

## Product surface

The product surface is `pipeline <verb> [--json]`, plus the event JSONL stream.

Operators, supervisors, and host shims invoke that same CLI. Machine consumers use `--json` on stdout and the event JSONL log. The generated verb inventory lives in [cli.md](cli.md). This page is the packaging contract, not a second command list.

## Hosts are shims

Hosts are argv or JSON wrappers / short SKILL shims that exec the CLI. A host is not a second pipeline engine.

The contributor path is: install the `pipeline` CLI, then add a short host SKILL that execs that CLI. Do not copy `core/` as the product. Do not recreate a committed `plugin/` directory.

## No per-verb slash-command pack

A `/pipeline:*` slash-command pack is not part of the product. Build and install do not emit `pipeline:<command>.md` files or Codex per-verb YAML agents. Hosts exec the CLI through their short SKILL instead.

Uninstall still removes installer-owned `pipeline:*.md` leftovers from older Claude installs.

## MCP is not required

An MCP server is not required. That surface is parked at issue #907.

## Merge authority

Merge is operator-authorized. This repository does not ship a grant factory, MessagingPort, or second control plane. `pipeline advance`, `pipeline single`, and `pipeline loop` stop at `pipeline:ready-to-deploy` and never merge.

## Host SKILL freshness

`node scripts/build.mjs --check` asserts that the four generated host SKILLs (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, `hosts/opencode/SKILL.md`) are fresh. After a renderer, operation-surface, build, or SKILL-host manifest edit, run `node scripts/build.mjs` and include those generated outputs in the same commit. The docs generator does not read or write a SKILL. The generator does not write `plugin/` or a marketplace catalog.

If `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy, run `install --host claude` or pin.

The generated `hosts/grok/SKILL.md` is a repository conformance output, byte-identical to the Claude one-pager. Grok install remains `symlink-claude` (`overlayDir: hosts/claude`, `overlayFiles: []`). The installed Grok path is the Claude-managed symlink, not a separate overlay of `hosts/grok/SKILL.md`. Grok notify comes from its outer-host manifest mapping (`grok_monitor_lines` / `monitor`). Portable fallback is stdout material lines via `events.jsonl` plus `material-filter.mjs`. Do not require Claude `PushNotification` on Grok.

OMP/Tugboat is a tree/native-CLI install host. It has no SKILL overlay (`install.overlayFiles: []`).

The installer stages the CLI implementation from `core/` into its managed host install tree. That is the single CLI install path, not a committed `plugin/` tree or a second engine.

## Related

- [CONTEXT.md](../CONTEXT.md) — packaging glossary
- [cli.md](cli.md) — generated verb inventory
- [concepts.md](concepts.md) — layout and advanced topics
- [supervisor.md](supervisor.md) — supervisors compose the CLI
