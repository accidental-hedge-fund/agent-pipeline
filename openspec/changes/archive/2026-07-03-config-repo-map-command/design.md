## Context

`repo_map` is a strict, optional block in `PartialConfigSchema` with two optional
`owner/repo`-string arrays (`depends_on`, `depended_on_by`), each constrained by the regex
`^[^/\s]+\/[^/\s]+$` (exactly one `/`, non-empty non-whitespace segments). `pipeline init`
scaffolds the block commented out and `resolveConfig()` resolves an absent block to two
empty lists via `DEFAULT_CONFIG.repo_map`. The `pipeline config` family already has three
subcommands (`schema`, `validate`, `sync`) dispatched by `runConfigCommand`, all resolving
the config file from `--repo-path` (default cwd) up to the enclosing `.git` root's
`.github/pipeline.yml`, and all injecting filesystem I/O through `deps` seams so unit tests
touch no real fs/network. This change adds `repo-map` as a fourth subcommand family.

## Goals / Non-Goals

**Goals:**
- Add `add` / `remove` / `list` subcommands that manage `repo_map` entries.
- Preserve unrelated keys, comments, and formatting exactly — mutate only the `repo_map`
  block.
- Reuse the existing `owner/repo` format contract and the `--repo-path`/git-root resolution
  used by the other config subcommands.
- Keep the mutation logic deterministic and unit-testable through injected fs deps, with a
  best-effort reachability check injected the same way (no real network in tests).

**Non-Goals:**
- No schema change — `pipeline config schema` already emits `repo_map`.
- No cross-repo writes, PR/label/status sync, or CI gating (declarative-only, per #312).
- No reverse-edge inference: `add owner/repo --rel depends_on` does not touch the other
  repo's config or the other list.
- No creation of `.github/pipeline.yml` when it is absent — `add`/`remove` direct the user
  to `pipeline init`, consistent with `config sync`.

## Decisions

**Decision: surgical YAML-document edit, not a whole-file re-render.**
`config sync` re-renders the whole file from parsed values via `renderConfigTemplate`,
which regenerates comments and preserves only *effective* config. For a human-edited,
version-controlled config file that a config UI mutates repeatedly, minimal diffs matter:
add/remove SHALL edit the parsed `yaml` `Document` (via `parseDocument` → `setIn`/`deleteIn`
→ `toString`) so only the `repo_map` block changes and all other comments/formatting survive
byte-for-byte. `yaml` is already a dependency used in `config.ts` for CST-based line lookup.

**Decision: validate `owner/repo` against the schema regex before writing.**
Reuse the exact constraint the schema enforces (`^[^/\s]+\/[^/\s]+$`) so the CLI never
writes a value `resolveConfig()` would later reject. Validation happens before any fs read
of the target block so invalid input fails fast with exit 1.

**Decision: `add` is idempotent; `remove` is a tolerant no-op.**
`add` of an entry already present writes nothing and exits 0 (a config UI can call it
without pre-checking membership). `remove` of an absent entry warns and exits 0 (so removal
is safe to retry). Both mirror the runtime tolerance already established for `repo_map`.

**Decision: block/list creation on `add`.**
When `repo_map` is absent, `add` creates the block with the single target list; when the
block exists without the target list, `add` creates that list. It never invents the other
relationship list. After mutation the candidate SHALL parse-and-validate (schema) before the
write is committed, so a malformed document is never written.

**Decision: best-effort reachability warning on `add` only.**
`add` SHALL attempt a `gh`-backed reachability check of the added repo (injected via deps).
On failure it SHALL emit a named warning and still write — reachability never blocks the
write, mirroring #312's runtime "unreachable declared repo degrades with a warning"
behavior. `remove` and `list` perform no network check.

**Decision: exit codes.**
Invalid `owner/repo` → exit 1 (matches the issue AC and `config validate`'s error exit).
Usage errors (missing positional, unrecognized `--rel`, unknown `repo-map` subcommand) →
exit 2 (matches the family's existing "unexpected argument" / "unknown subcommand" exits).
Successful add/remove/list and tolerant no-ops → exit 0. Missing config file → exit 1 with a
`pipeline init` hint (matches `config sync`).

## Risks / Trade-offs

- **Two write paths (`sync` re-render vs. `repo-map` surgical edit).** Accepted: they serve
  different intents — sync refreshes structure, repo-map performs a targeted value edit. A
  surgical edit is the correct tool for "change one list without reformatting the file."
- **`setIn` on a document whose `repo_map` was commented out** produces a fresh uncommented
  block; the previously-commented example lines remain as comments. Mitigation: `add`
  operates on the parsed data model, so a commented-out scaffold block resolves to "absent"
  and a clean active block is created; leftover comment lines are harmless and covered by a
  round-trip test.
- **Reachability check flakiness.** Warning-only and injected, so it never fails a write or a
  test.

## Migration Plan

1. Add `owner/repo` validation + document-level add/remove/list helpers in `config.ts` with
   injected fs (and reachability) deps.
2. Add `repo-map` dispatch, arg/flag parsing, and help text to `runConfigCommand`.
3. Add unit tests (helpers + CLI) covering every acceptance criterion; prove they bite.
4. Document the command in README and host skill docs; regenerate the plugin mirror.
5. Run `npm run ci`.

Rollback is deleting the new subcommand code; no external state is mutated beyond the local
config file the user explicitly targeted.

## Open Questions

- None.
