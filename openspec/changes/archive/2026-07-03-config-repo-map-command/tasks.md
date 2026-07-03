## 1. Repo-map mutation core

- [ ] 1.1 Add an `owner/repo` validator in `config.ts` that reuses the schema regex
  (`^[^/\s]+\/[^/\s]+$`) and returns a structured error for invalid input.
- [ ] 1.2 Add a deterministic `repo-map add` helper that parses the config `Document`,
  creates the `repo_map` block/target list if absent, inserts the entry (idempotent), and
  re-validates the candidate before returning it — through injected fs deps.
- [ ] 1.3 Add a `repo-map remove` helper that deletes the entry from the target list,
  treating an absent entry as a tolerant no-op, preserving all other document content.
- [ ] 1.4 Add a `repo-map list` helper that reads the resolved `repo_map` lists grouped by
  relationship kind.
- [ ] 1.5 Add an injectable best-effort reachability check used by `add`; a failure yields a
  warning, never an abort.

## 2. CLI command

- [ ] 2.1 Add `pipeline config repo-map <add|remove|list>` dispatch to `runConfigCommand`,
  parsing the `<owner/repo>` positional and `--rel depends_on|depended_on_by` (default
  `depends_on`).
- [ ] 2.2 Map outcomes to exit codes: invalid `owner/repo` → 1; usage error (missing arg,
  bad `--rel`, unknown subcommand) → 2; missing config file → 1 with a `pipeline init` hint;
  success and tolerant no-ops → 0.
- [ ] 2.3 Print `list` output grouped by relationship kind, and print clear add/remove/no-op
  result messages.
- [ ] 2.4 Advertise `repo-map` in `pipeline config` help text and the unknown-subcommand
  message.

## 3. Tests and docs

- [ ] 3.1 Unit-test the mutation helpers: add (default + explicit `--rel`, block creation,
  idempotency), remove (present + absent), list, invalid `owner/repo`, missing config file,
  reachability-failure warning, and round-trip preservation of unrelated keys/comments.
- [ ] 3.2 Add CLI-level tests for `pipeline config repo-map` covering exit codes and help.
- [ ] 3.3 Prove each regression test bites (fails without the new behavior).
- [ ] 3.4 Document `config repo-map` in the README and host skill docs.
- [ ] 3.5 Regenerate the plugin mirror (`node scripts/build.mjs`).
- [ ] 3.6 Run `npm run ci` (core tests, mirror check, install smoke, OpenSpec validate).
