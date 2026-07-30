## Context

Agent Pipeline’s true runtime floor is **Node ≥ 24** (native TypeScript
type-stripping in the core; launchers hard-gate on major ≥ 24; CI uses Node 24;
`core/package.json` already has `"engines": { "node": ">=24" }`; README states
Node ≥ 24). The **root** `package.json` still advertises `"engines": { "node": ">=18" }`,
so npm/consumers and a casual `package.json` read disagree with every other surface.

Install docs still pin **`#v1.2.1`** in the recommended and “specific version”
examples while the package is **1.28.x** (current tag `v1.28.4`). That pin is not
merely “conservative” — it is an abandoned line that misleads new installs.

After **#512 / #609**, durable multi-item runs use the **in-repo** loop supervisor.
`pipeline:loop` run-start preflight checks **in-repo store schema compatibility**
(`checkLoopStoreSchemaCompatibility`), not external goal-loop discovery. External
goal-loop remains a **legacy optional** skill (import/resume of old runs). Yet:

| Surface | Today when goal-loop is absent |
| --- | --- |
| `checkLoopContractCoherence` | **fail** (“Install goal-loop before running pipeline:loop”) |
| `pipeline doctor` (`loop:contract-coherence`) | **fail** (uses that function) |
| Installer | **ok** + info that loop is **unavailable** without goal-loop (false) |
| Living `install-version-coherence` | absence **fails** doctor |
| Living `pipeline-loop-facade` | absence MUST NOT fail loop preflight |

So living specs already disagree with each other and with #512 product reality.
This change resolves the packaging/docs/doctor half; it does not re-architect the
loop engine.

## Goals / Non-Goals

**Goals:**

- One Node floor story: root engines ≥ 24, coherent with core and launchers.
- CI that fails on root↔core **version** skew and **engines** floor lies.
- README install pins that are current or deliberately unversioned (no ancient
  hardcoded tags in recommended paths).
- Doctor/installer/docs treat external goal-loop as optional legacy: absence is
  non-blocking; incompatible *discovered* install still fails.
- Comments and README doctor table match post-#512 semantics.

**Non-Goals:**

- CLAUDE_CONFIG_DIR command hardcoding.
- Marketplace plugin update locks.
- Removing legacy goal-loop import/resume or deprecating host goal-loop skills.
- Changing the durable loop store schema, loop CLI flags, or run-start
  store-schema check beyond clarifying shared-surface wording.
- Auto-bumping README pins on every release via automation (manual “current tag
  or unversioned wording” is enough for this issue).

## Decisions

### 1. Align root `engines.node` to `>=24` (not “document as installer-only”)

**Choice:** Set root `package.json` `engines.node` to `"≥24"`-equivalent
(`">=24"`), matching `core/package.json`.

**Why:** Issue allows either true alignment *or* documenting a split with a CI
test that fails on lies. A real dual story (“root is installer-only, core is
runtime”) is harder to keep honest and still confuses `npx`/npm consumers of the
repo package. The installer and launchers already require 24 at run time; root
`>=18` is simply stale.

**Alternatives considered:**

| Approach | Verdict |
| --- | --- |
| Root `>=18` + comment + CI that only checks “documented split” | Rejected: still advertises a false install floor to npm |
| Root omits `engines` | Rejected: loses npm engine warnings; worse than correct floor |
| Root `>=24` | **Chosen** |

### 2. Packaging coherence gate in CI (version + engines)

**Choice:** Add a deterministic check (scripts unit test and/or tiny script
invoked by `ci:scripts` / an existing scripts-test file) that:

1. Parses root and `core/package.json`.
2. Asserts `version` strings are identical.
3. Asserts root `engines.node` requires major ≥ the floor implied by core
   `engines.node` (for the current constant floor, both must be `>=24` or
   stricter).

**Why:** Version fields already match at 1.28.4 by habit; engines do not. Without
CI, the next release can re-split either field. Scripts tests already cover
installer packaging concerns and run under `npm run ci`.

**Alternatives considered:**

| Approach | Verdict |
| --- | --- |
| Only human review of package.json | Rejected: issue requires CI assert |
| Gate inside `build.mjs --check` | Acceptable if convenient; not required if scripts tests already run in `ci` |
| Compare to git tags | Out of scope; tag is release tooling |

### 3. README pins: current tag or unversioned guidance, never stale hardcoded `v1.2.1`

**Choice:** Rewrite recommended and “install a specific version” examples to either:

- use the **current** release tag present on the branch at change time (e.g.
  `v1.28.4` when that is `package.json` version), **or**
- show the unpinned `npx -y github:…/agent-pipeline install` form as recommended
  and document pinning as “replace with a released tag such as `vX.Y.Z` from
  GitHub Releases” without embedding an obsolete number.

Do **not** leave `v1.2.1` as the worked example.

**Why:** Hardcoding a forever-stale pin is the bug. Hardcoding the latest tag
will age, but aging from current is far less harmful; unversioned wording ages
gracefully. Implementer may pick either pattern so long as acceptance criteria
hold (no `v1.2.1` / ancient pins in recommended paths).

### 4. `loop:contract-coherence`: absence → skip; incompatible discovery → fail

**Choice:** When no goal-loop install is discoverable, `checkLoopContractCoherence`
returns **`skip`** (or doctor maps absence to skip) with detail that external
goal-loop is optional/legacy and not required for `pipeline:loop`. When a
install is discovered but schema ids are missing or outside the supported set,
status remains **`fail`** with both sides named.

Installer:

- On absence: quiet info or omit, and **MUST NOT** claim `/pipeline:loop` is
  unavailable without goal-loop.
- On incompatible discovery: still block install completion (or report hard
  failure) as today for schema mismatch.

**Why skip over warn:** Doctor already has `warn` for advisory issues that
operators should act on. Missing an optional legacy skill is not something to
remediate for a healthy Pipeline-only install — `skip` matches other optional
checks (OpenSpec inactive, eval unconfigured). Issue allows skip/warn/retire;
skip is the least noisy.

**Why not retire the check entirely:** A *present* incompatible goal-loop can
still confuse operators using legacy paths or dual installs; keep the
compatibility gate when discovery succeeds.

**Shared implementation surfaces (post-#512):**

| Consumer | Check |
| --- | --- |
| `pipeline doctor` | external `loop:contract-coherence` (optional discovery) |
| Installer | same function for discovery/compat; absence non-blocking |
| `pipeline:loop` run-start | **in-repo** `loop:store-schema-compatibility` only — does **not** require external goal-loop |

Living `install-version-coherence` text that claims all three surfaces share
external goal-loop discovery SHALL be corrected to this table.

### 5. Spec ownership split

**Choice:**

- New capability `packaging-coherence` for version/engines CI invariants.
- MODIFY `install-version-coherence` for `loop:contract-coherence` semantics.
- MODIFY/ADD under `readme-user-clarity` for pin currency and loop messaging
  accuracy (extends existing “instructions accurate to current behavior”).

**Why:** Packaging CI is a distinct concern from doctor’s install-root version
check (`install:version-coherence`). Loop messaging is user-facing README +
installer, not a new loop engine capability.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| README pin to “current tag” ages after next release | Prefer unversioned recommended install + “pin via Releases” language, or accept short-lived pin drift as better than `v1.2.1` |
| Operators who still use external goal-loop as primary loop path | Legacy import/resume remains; docs already describe in-repo loop as the product path after #512 |
| Doctor previously failed without goal-loop — behavior change | Intentional; matches product truth and reduces false reds; document in proposal acceptance criteria |
| Root `engines: >=24` may warn npm on older Node during install scripts | Correct signal; install already warns when major < 24 |
| Spec archive must reconcile living `install-version-coherence` fail-on-absent with this change | Delta MODIFIED requirements carry full replacement text |

## Migration Plan

1. Spec/intent land in this OpenSpec change (planning only).
2. Implementation: engines + CI gate + README + loop-preflight/doctor/installer
   messaging + tests in one PR.
3. No data migration; no install-path rewrite for existing users.
4. Rollback: revert the PR; worst case reintroduces false doctor fails and stale
   docs.

## Open Questions

None blocking. Implementer may choose skip vs warn for absence if a review
prefers warn for discoverability; default is **skip**. Implementer may choose
current-tag pin vs unversioned README wording.
