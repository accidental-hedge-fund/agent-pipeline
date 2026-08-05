## Context

Factory self-hosting today has the pieces for pinning but not the **two-track policy**:

| Piece | Exists today | Gap |
| --- | --- | --- |
| Tag-pinned install | `npx …#vX.Y.Z install` (README) | Not the mandatory factory production policy; operators can still run from working tree / floating default branch |
| FRG pass artifact | `factory-reliability-gate` evidence with `version`, `pass`, `run_id` | Pass does not promote a production pin; release refuses without FRG, but dogfood still may run the candidate |
| Doctor version coherence | `install:version-coherence` (loaded VERSION vs on-disk) | No track (`pinned` vs `candidate`) and no pin-target comparison |
| Doctor freshness | `install:version-freshness` vs latest GitHub release tag | Report-only; does not encode "intentionally pinned last-FRG-passed" |
| Run engine identity | `run.json` `engine.{version,root,templates_fingerprint}` + mid-run drift (#450) | No `track` field; cannot attribute defects to pin vs candidate |

v1.29.0 soak proved the feedback loop: candidate regressions degrade the repair capacity of the
same process that must fix them. Reliability audit (2026-07-31) named two-track stabilization as
the gap.

Constraints:

- Golden rule #4: no auto-merge / unattended release authority.
- FRG pack composition is out of scope (sibling issues); this change **consumes** FRG pass artifacts.
- Host-local install paths remain host-local; pin metadata should be repo-documented and machine-readable so doctor/run evidence can agree.
- Prefer existing seams: doctor `DoctorDeps`, run-store engine identity, FRG evidence lookup, tag install.

## Goals / Non-Goals

**Goals:**

1. Define two tracks: **pinned** (last FRG-passed release) and **candidate** (unreleased / working-tree / release-branch build).
2. Make the production pin the authoritative target for factory dogfood/production loops.
3. Restrict candidate exercise to FRG Layer B and documented eval campaigns (explicit candidate track).
4. Promote the pin only from FRG `pass: true` for that version; document rollback by repoint + reinstall.
5. Disclose track + version (+ SHA when known) on doctor and in run evidence.
6. Unit-test pin resolution, track classification, doctor mismatch, and promote refusal without real I/O.

**Non-Goals:**

- FRG scenario-pack composition or threshold retuning.
- Auto-merge, auto-tag, or unattended release.
- Cross-host install locking or multi-machine pin distribution beyond a repo-checked pin artifact + reinstall procedure.
- Replacing mid-run template snapshot isolation or existing version-coherence/freshness checks.
- Forcing every non-factory consumer of the skill onto the pin (downstream repos may float; **factory** production policy is normative).

## Decisions

### Decision 1 — Production pin is a small machine-readable repo artifact

**Chosen:** Store the production pin as a versioned JSON (or equivalent) artifact in-repo, e.g.
under `docs/` or a stable path such as `docs/production-engine-pin.json`, with at least:

| Field | Intent |
| --- | --- |
| `schema_version` | Integer; start at `1` |
| `version` | Semver of last FRG-passed release (e.g. `1.29.1`) |
| `tag` | Git release tag (e.g. `v1.29.1`) |
| `git_sha` | Release commit SHA when known (nullable only if historically unavailable) |
| `frg_run_id` / `frg_evidence_ref` | Link to the FRG pass that authorized the pin |
| `promoted_at` | ISO 8601 UTC timestamp of last promote |
| `previous` | Optional prior pin snapshot for one-step rollback reference |

**Rejected:** Env-var-only pin (not auditable in git; diverges across hosts).  
**Rejected:** "Latest GitHub release" as implicit pin (release and dogfood policy must stay explicit; FRG pass is the gate, not "newest tag scraped at runtime").  
**Rejected:** Embedding pin only in README prose (not machine-checkable by doctor).

**Why.** Doctor, promote, and run evidence need one source of truth. Git-tracked pin is reviewable
and rolls back via ordinary commit or an explicit reinstall from the previous tag.

### Decision 2 — Track classification at run start (not mid-run rewrite)

**Chosen:** Classify each process as `pinned` or `candidate` once at run start from:

1. Explicit operator/CLI/config intent when present (e.g. factory-gate / eval ⇒ candidate; ordinary
   loop with production policy ⇒ pinned), and
2. Comparison of running engine `VERSION` (+ optional root) to the production pin.

Rules of thumb for classification:

| Situation | Track |
| --- | --- |
| Running version equals production pin and install root is the skill install (not an ad-hoc worktree engine) | `pinned` |
| FRG Layer B / factory-gate / documented eval campaign against working tree or unreleased build | `candidate` |
| Running version ≠ pin (ahead or behind) while not in an explicit candidate soak path | **Misconfigured** — doctor fail/warn; run evidence still records observed track as `candidate` (or `unknown` only if identity cannot be resolved) with mismatch detail |

**Rejected:** Inferring track solely from "is git dirty" (noisy; unrelated product worktrees).  
**Rejected:** Changing track mid-run when files change (mid-run identity is already covered by engine drift events).

**Why.** Attribution and policy are about **intent + pin match**, not filesystem dirt. Drift remains a separate signal.

### Decision 3 — Production policy binds factory dogfood via install + doctor, not a second orchestrator

**Chosen:** Production/dogfood runs continue to use the installed skill entrypoints. Operators
(and factory automation docs) **install from the pin tag** and run that install. Doctor gains
`install:engine-track` (or extends version-coherence) that:

- reports pin target, installed/running version, classified track;
- **fails** (or hard-warns with non-zero when production policy is in force) when production
  intent is configured/assumed for this host and install ≠ pin;
- **passes** when install matches pin on the production path;
- does not block intentional candidate soaks (FRG/eval) when those paths declare candidate track.

**Rejected:** Spawning every loop item through a forced `npx` download each run (slow, flaky network).  
**Rejected:** Silently rewriting `PATH` to a worktree engine for "convenience".

**Why.** The install pin already exists; the missing piece is **policy + disclosure**, not a new
runtime download path.

### Decision 4 — Promotion is FRG-gated and explicit; not release-merge

**Chosen:** Promotion API/procedure:

1. Resolve FRG evidence for target version `X.Y.Z`.
2. Require `pass: true` and valid schema (same class of check release uses).
3. Update pin artifact fields (`version`, `tag`, `git_sha`, FRG ref, `promoted_at`, stash `previous`).
4. Document operator reinstall: `npx -y github:…#vX.Y.Z install …`.
5. Optional helper: `pipeline factory-pin promote --from-frg <version>` (or factory-gate flag
   `--promote-pin-on-pass`) that performs (1)–(3) only — **never** merges PRs or creates tags.

**Rejected:** Auto-promote on every green `npm run ci`.  
**Rejected:** Auto-promote on release PR open without FRG pass.  
**Rejected:** Coupling promote to auto-tag-on-merge (tags remain release-owned; pin follows FRG-passed release versions that are already shippable).

**Why.** Issue requires FRG pass as the promote signal and forbids auto-merge authority changes.

### Decision 5 — Rollback is repoint + reinstall

**Chosen:** Documented rollback:

1. Set pin `version`/`tag`/`git_sha` to the previous FRG-passed values (from `previous` or known history).
2. Reinstall from that tag.
3. Confirm with `pipeline doctor` (track `pinned`, versions match).

No force-push, no worktree wipe of product issue worktrees, no merge of release branches.

**Why.** Matches issue wording and keeps recovery local and reversible.

### Decision 6 — Evidence field is additive on existing engine identity

**Chosen:** Extend the run engine identity object with:

```text
engine.track: "pinned" | "candidate"
engine.pin_version?: string   // production pin version when known
engine.git_sha?: string       // when resolvable
```

Keep existing `version`, `root`, `templates_fingerprint`. Evidence bundle summary includes the same
fields so scoreboard/defect attribution can filter by track.

**Rejected:** Separate parallel identity file (duplicates run.json).  
**Rejected:** Encoding track only in free-form log lines (not machine-queryable).

### Decision 7 — Prefer ADDED requirements on existing capabilities where behavior is additive

**Chosen:** For doctor, run-dir, and FRG, add **ADDED** requirements rather than rewriting large
MODIFIED blocks, unless an existing requirement's normative text must change. The new capability
owns the two-track policy; deltas only attach disclosure/promotion hooks.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Operators still run candidate by accident for dogfood | Doctor fail/warn under production policy; docs lead with pin install; track on every run |
| Pin file drifts from actual GitHub tags | Promote only from FRG evidence + known tag; doctor can cross-check version string; freshness remains report-only |
| Candidate soaks lack pin safety net if FRG is skipped | FRG remains mandatory for release; this change does not weaken FRG — it uses pass for promote |
| Hosts diverge (one host updated, another not) | Pin is repo-global; each host reinstalls; doctor per host reports install vs pin |
| Over-blocking non-factory users of doctor | Production-policy strictness scoped to factory config / documented factory hosts; pure consumers keep warn-only freshness |
| Promote helper writes pin without reinstall | Docs + doctor still show mismatch until reinstall; promote output MUST print reinstall command |

## Migration Plan

1. Land pin artifact initialized to the current last known FRG-passed release (or latest released FRG-passed version at implement time).
2. Ship doctor + run evidence fields (non-breaking additive).
3. Update FRG runbook + README with two-track policy and promote/rollback.
4. Factory operators reinstall from pin; subsequent dogfood loops use pinned install.
5. After next FRG pass, exercise promote path once and verify doctor + a sample run.json.
6. Rollback drill: repoint to previous, reinstall, doctor pass.

No data migration of historical runs (pre-change `run.json` lacks `track` — readers treat missing track as unknown, same pattern as missing engine identity).

## Open Questions

1. **Strictness of production mismatch:** fail (`ok: false`) vs warn for install≠pin — prefer **fail when factory production policy is enabled**, warn otherwise; confirm default for this repo's factory hosts at implement time.
2. **Exact pin path filename** under `docs/` vs `.github/` — prefer `docs/production-engine-pin.json` for visibility; implement may adjust if generator/docs layout requires it.
3. **Whether factory-gate auto-writes the pin on pass** or only prints a promote command — either satisfies the issue if promote remains FRG-gated and non-merging; prefer explicit `--promote-pin-on-pass` opt-in to avoid surprise git dirt on release hosts.
