## 1. Grammar soft-section fixtures

- [x] 1.1 Add table-driven fixtures proving bare `#N` under `Related` / `See also` / dogfood / later-milestone headings are not lexical prerequisites
- [x] 1.2 Prove phrase forms under soft headings still extract (`Depends on: #N` under `## Related`)
- [x] 1.3 Prove `## Dependencies` bare `#N` still extracts as a lexical candidate
- [x] 1.4 Adjust `declared-dependency-grammar` only if current parser fails 1.1–1.3 (prefer fixture-first)

## 2. Hard-wait admission

- [x] 2.1 Add a pure admission helper (or equivalent) that takes raw declared edges + selector id set + open/closed observations and returns admitted edges + `ignored_dep` records with stable reason codes
- [x] 2.2 Wire admission into work-list declared-dependency population **after** source union and **before** `compileContractItems` / partition
- [x] 2.3 Ensure off-selector open targets never land on `external_depends_on`
- [x] 2.4 Ensure closed/merged targets never land as hard waits; emit `ignored_dep` with closed-class reason
- [x] 2.5 Inject observation seams in unit tests (no real network, git, or subprocess)

## 3. Deadlock / eligibility regressions

- [x] 3.1 Fixture: Related-only / see `#B` → no hard wait, no `dependency_deadlock` for B
- [x] 3.2 Fixture: `Depends on: #B` with B open on selector → wait / deadlock unchanged when frontier is only that gate
- [x] 3.3 Fixture: `Depends on: #B` with B closed or off-selector → A eligible; `ignored_dep` present
- [x] 3.4 Fixture: bare `#B` under `## Dependencies` with B open off-selector (dogfood #838/#839 class) → no ship-stop solely for that ref
- [x] 3.5 Fixture: in-train real pair (class of #647 → #599) still hard-waits

## 4. Mirror, validate, CI

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [x] 4.2 Run `openspec validate loop-hard-deps-on-train-selector` (and `openspec validate --all` as needed)
- [ ] 4.3 Run `npm run ci` from repo root and fix failures until green
