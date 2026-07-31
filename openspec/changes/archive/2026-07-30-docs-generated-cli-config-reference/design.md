## Context

Today four hand-maintained surfaces restating overlapping operator knowledge:

| Surface | ~lines | Jobs |
| --- | --- | --- |
| `README.md` | ~2040 | Landing + install + ~20-command CLI reference + config guide + concepts |
| `hosts/claude/SKILL.md` | ~1290 | Host skill + Modes command table + config + run flow |
| `hosts/codex/SKILL.md` | ~1030 | Same for `$pipeline` |
| `ROADMAP.md` | ~850 | Forward plan + accreting "Shipped" prose + release-plan table |

Structured sources already exist and are used at runtime:

- **Commands:** `COMMAND_REGISTRY` in `core/scripts/command-registry.ts` (dispatch + flag allowlists). Entries currently lack human-facing summary/usage text.
- **Config:** Zod `PartialConfigSchema` in `core/scripts/config.ts` with many `.describe()` strings; `pipeline config schema` already derives JSON Schema from that surface.
- **Releases:** git tags + GitHub Releases (release sub-command / workflow already produce versioned artifacts).
- **Staleness pattern:** `node scripts/build.mjs --check` compares committed `plugin/` to a fresh generation — the model this change copies for docs.

Related but **separate** work: #626 (stage-count SSOT / TERMINAL alignment) and #598 (published docs site). This design does not solve stage-count fragmentation; it only stops CLI/config/history drift and unbounded README/ROADMAP growth.

## Goals / Non-Goals

**Goals:**

1. Single source of truth for the **documented CLI surface** → generated `docs/cli.md` + host SKILL command tables.
2. Single source of truth for the **documented config surface** → generated `docs/config.md`.
3. CI **fails closed** when committed generated docs are stale (mirror-style).
4. README becomes a **landing page** with links into `docs/`; target well under ~400 lines.
5. ROADMAP stops accreting shipped history; history lives in **`CHANGELOG.md`**.
6. Zero change to engine dispatch, stages, review policy, or merge posture.

**Non-Goals:**

- Publishing a static docs site or hosting (tracked as #598).
- Generating conceptual/behavioral narrative from `openspec/specs/*.md` (future optional; this change hand-extracts concepts from the current README).
- Stage-count SSOT / fixing living TERMINAL vs `needs-human` (#626).
- Auto-merging, release automation redesign, or changing `pipeline config schema` wire format.
- Making every registry keyword user-facing (hidden/legacy aliases stay undocumented).

## Decisions

### D1 — Generator location and runtime

**Decision:** Implement generation as a **repo-root Node script** under `scripts/` (e.g. `scripts/generate-docs.mjs`), with pure transform helpers either inlined or in `core/scripts/docs-*.ts` importable via native type-stripping — same pattern as `build.mjs` + core modules.

**Why:** Operators and CI already run `node scripts/build.mjs`; mirroring that UX keeps the mental model. The generator must import `COMMAND_REGISTRY` and Zod schema modules without pulling Commander CLI side effects — the registry already guarantees no Commander import at load time.

**Alternatives considered:**

- *Only core unit tests that write docs* — fails the "contributor runs one command to refresh" and CI `--check` ergonomics.
- *Shell/markdown templating outside Node* — cannot import the TypeScript registry/schema cleanly.

### D2 — CLI doc metadata co-located with the registry

**Decision:** Extend documentation metadata **keyed by registry command id**, co-located with the registry (either optional fields on `CommandEntry` or a sibling `COMMAND_DOCS` map in the same module / adjacent file). Minimum fields:

| Field | Purpose |
| --- | --- |
| `summary` | One-line description for tables |
| `usage` | Synopsis string(s), host-token-agnostic body (e.g. `status <n>`) |
| `documented` | Default true; `false` for hidden/legacy aliases |
| (optional) `section` / `group` | Ordering in docs (e.g. advance, intake, factory) |

The generator **never invents** commands not present in `COMMAND_REGISTRY`. Adding a documented command requires a registry entry **and** doc metadata; removing a command from the registry drops it from docs on the next generate.

**Why not scrape Commander help?** Commander help strings are not the registry SSOT and can drift from allowlists. **Why not keep prose only in Markdown?** That preserves the three-way drift the issue is filed to kill.

**Dispatch semantics unchanged:** `needsIssueNumber`, `allowedFlags`, etc. remain the only fields used by the CLI path; doc fields are ignored at runtime.

### D3 — Host SKILL command tables via markers, not full-file generation

**Decision:** Host SKILL files remain hand-authored for procedural run-flow content. Only the **command inventory region** is generated, delimited by stable markers, e.g.:

```markdown
<!-- BEGIN GENERATED: cli-command-table -->
...
<!-- END GENERATED: cli-command-table -->
```

The generator rewrites the region in-place for `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`, substituting the host invocation prefix (`/pipeline` vs `$pipeline`). After host SKILL updates, `node scripts/build.mjs` regenerates `plugin/` as today.

**Why:** Full-file SKILL generation would freeze run-flow pseudocode and host-specific guidance behind a generator and fight concurrent skill fixes. Marker regions match how many codebases embed generated blocks without owning the whole file.

**Alternatives considered:**

- *SKILL links out to `docs/cli.md` only* — weaker for in-session agents that load SKILL.md as the primary context and may not open linked files.
- *Duplicate full CLI docs into each SKILL* — re-creates bloat.

### D4 — Config reference from Zod / PartialConfigSchema

**Decision:** Derive `docs/config.md` from the same schema surface that backs `pipeline config schema` (Zod → walk properties, types, enums, `.describe()` text). Prefer reusing any existing schema-walk helper used by the config-schema command rather than a second ad-hoc field list.

**Coverage:** Document top-level keys and important nested blocks (e.g. `review_policy`, `steps`, `eval_gate`, `doctor`) with type, default where known from `DEFAULT_CONFIG`, and description. Explicitly **omit** or mark non-existent keys such as `auto_merge` (already rejected by schema).

**Defaults:** When a default is available from `DEFAULT_CONFIG`, include it; when not easily derivable without execution side effects, omit rather than invent.

### D5 — Staleness gate (mirror-style)

**Decision:**

```text
node scripts/generate-docs.mjs          # write generated artifacts
node scripts/generate-docs.mjs --check  # exit non-zero if any artifact would change
```

Wire `--check` into `npm run ci` (alongside `build.mjs --check`). Comparison is content-based (normalize trailing newlines; ignore pure timestamp headers if any — prefer **no** unstable timestamps in output).

Generated files commit to git (like `plugin/`), so clones and GitHub render work without running the generator.

### D6 — README landing split

**Decision:** Rewrite `README.md` as:

1. Purpose / lifecycle one-pager (keep existing state-machine asset link)
2. Prerequisites
3. Quickstart (single recommended install path)
4. Install (concise; details can link to concepts if needed)
5. "Where to go next" links: `docs/cli.md`, `docs/config.md`, `docs/concepts.md`, `CHANGELOG.md`, `ROADMAP.md`
6. Minimal development/license footer

Hand-move advanced topics, troubleshooting depth, and host-sharing narrative into **`docs/concepts.md`** (authored, not generated). Preserve `readme-user-clarity` intent: first screenful purpose-first; quickstart complete; optional topics labeled and not required for first run — those rules apply to the **landing + concepts** pair, with CLI/config references living in their generated pages.

**Target size:** well under ~400 lines for `README.md` itself.

### D7 — CHANGELOG and ROADMAP history

**Decision:** Introduce `CHANGELOG.md` as the historical release surface. Preferred generation path:

1. **Primary:** Build sections from **git tags** (annotated tag messages / GitHub Release body when available via `gh`, with a pure-git fallback for offline/CI without network).
2. **Release tooling hook (optional in same change if cheap):** `pipeline release` (or the release PR workflow) appends/refreshes the newest version section so the next release does not reintroduce ROADMAP prose.

`ROADMAP.md`:

- Keep **Forward Roadmap** and any planning narrative that is not per-version history.
- **Remove** the free-form **Shipped** prose block (or replace with a one-line pointer to `CHANGELOG.md`).
- Keep the **Release plan** table if still useful for forward planning; shipped rows may remain as compact status cells but MUST NOT restate full release notes (those belong in CHANGELOG). Correcting the table's fork from milestones is nice-to-have, not required for acceptance if it is clearly "plan" not "history dump."

**Why not Keep Shipped in ROADMAP and only "summarize"?** The issue's failure mode is unbounded accretion; relocation is the fix.

**Alternatives considered:**

- *Only append on release, no full backfill* — leaves a gap for past versions; prefer one-time backfill from tags for existing releases so history is not lost when Shipped prose is deleted.
- *Depend on GitHub Releases only* — fragile in offline unit tests; keep tag-based core path for deterministic generation.

### D8 — Scope boundary vs #626 / #598

**Decision:** Document in tasks that stage-count/diagram consistency is **#626**, not this change. Do not expand the generator to emit `STAGES` from `types.ts` unless #626 is explicitly folded later. Docs site publishing remains **#598**.

If implementers notice stage-count contradictions while editing README/SKILL prose, fix only the lines they touch if trivial and already wrong relative to code — but do not create a stage SSOT subsystem here.

### D9 — Testing strategy

- **Unit tests** (no network, no git, no subprocess for pure transforms): given a fixture registry / schema slice, assert Markdown shape (command present/absent, usage line, config key + description).
- **Staleness:** `--check` covered by a test or by running the real check in `npm run ci` (CI is the production gate).
- **CHANGELOG generator:** unit-test with injected tag/release fixtures via a `deps` seam (mirror stage-test style); do not call live `gh` in unit tests.
- **Bite tests:** temporarily corrupt a generated file or remove a metadata field and prove the check/test fails.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Registry doc metadata becomes a second thing to update when adding a command | Document in CLAUDE.md / conventions: "new command → registry + doc metadata + regenerate docs"; optional later linter that every non-hidden entry has `summary`. |
| Marker regions get hand-edited and overwritten | Comment above markers: DO NOT EDIT; CI `--check` fails if someone hand-edits without regenerating from source (hand edit of generated body is wiped on regenerate — intentional). |
| Zod → Markdown misses nested keys or defaults | Start with top-level + known nested blocks; parity test against `pipeline config schema` property keys. |
| CHANGELOG backfill is noisy or incomplete for early tags | Prefer tag subject + release body when present; allow sparse early entries over inventing prose. |
| README shrink loses a critical install edge-case | Keep install correctness under `readme-user-clarity` scenarios; move depth to concepts, not delete accuracy. |
| SKILL shrink insufficient if only tables are generated | Accept residual SKILL size; full skill rewrite is out of scope. Success = no independent hand command inventory. |
| Generator imports pull heavy deps / side effects | Import only registry + schema modules; guard with a smoke test that generator load does not parse `process.argv` as CLI. |

## Migration Plan

1. Land generators + metadata + first generated `docs/cli.md` / `docs/config.md` while README still has old content (optional intermediate commit in one PR is fine).
2. Replace host SKILL command regions with markers + generate.
3. Rewrite README landing; extract concepts.
4. Generate CHANGELOG; strip ROADMAP Shipped prose; add pointer.
5. Wire `--check` into CI; prove red on intentional staleness.
6. Regenerate `plugin/` if SKILL changed; `npm run ci` green.
7. Rollback: revert the docs PR; no engine state to unwind. Generated files are pure artifacts.

## Open Questions

1. **Exact CHANGELOG format** (Keep a Changelog vs tag-body dump) — default to Keep a Changelog-ish headings (`## [x.y.z] - date`) unless release bodies already dictate structure.
2. **Whether `pipeline release` must write CHANGELOG in this change** — preferred yes if the hook is small; if release path is risky, document a manual `generate-docs` step in the release checklist as interim.
3. **Whether command flag lists** (from `allowedFlags`) appear in `docs/cli.md` — useful but may be noisy; minimum viable is usage + summary; flags can be a follow-up column once attribute→CLI-flag mapping is reliable from `buildCmd()`.
