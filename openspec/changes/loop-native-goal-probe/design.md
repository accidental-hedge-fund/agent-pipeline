## Context

`pipeline:loop` (#451, shipped v1.21.0) refuses to run without the active engine's built-in
autonomous goal mode, because falling back to a non-durable loop is worse than not starting.
The gate itself is correct; its *detection* is not.

Evidence gathered on the reference host (2026-07-22):

```
$ claude --version
2.1.216 (Claude Code)
$ claude --help | grep -i goal
$ (no output)
```

`claude --help` lists CLI flags and sub-commands only. `/goal` is an interactive **slash
command**, resolved inside a session — it is structurally absent from CLI help, and no future
Claude Code release is obliged to put it there. So the current probe's negative is not weak
evidence, it is *no* evidence: the signal and the capability are unrelated.

## Goals / Non-Goals

**Goals**

- Detect the capability correctly on hosts where it demonstrably works.
- Keep the gate fail-closed on hosts that genuinely lack it, with remediation that is true.
- Keep every check read-only and injectable through the existing `DoctorDeps` seam.

**Non-Goals**

- Not attempting to *invoke* `/goal` (or any session) to probe it. Launching an interactive
  engine session from preflight is neither read-only nor deterministic.
- Not inspecting undocumented engine internals (bundled slash-command manifests, installation
  state files). Those are private surfaces that break silently across releases.
- Not weakening the gate: no "warn and continue", no degraded fallback loop (#451).

## Decisions

### Decision 1 — Three ordered signals, with an explicit attestation as the top authority

The probe resolves in this precedence:

1. **Operator attestation** (config): `available` → pass, `unavailable` → fail. An explicit
   human assertion outranks inference in both directions.
2. **Positive `--help` marker**: if the engine *does* advertise a goal mode in `--help`, pass.
   Retained purely additively so a future CLI that surfaces the capability is picked up with
   no code change. Its **absence carries no weight**.
3. **Version floor**: parse `<bin> --version` and pass when the engine's version is at or
   above a documented per-engine floor.

Anything else — no attestation, no marker, version unparseable, version below floor, engine
with no known native goal mode — fails.

*Alternative rejected:* a version floor alone. It cannot express "this engine has no native
goal mode at any version" (Codex today), and it strands hosts whose version string the parser
does not understand (vendored builds, wrappers) with no escape hatch that isn't a code edit.

*Alternative rejected:* attestation alone. It makes the shipped default unusable out of the
box — every Claude host would need config before the feature works, which is the #506
symptom with extra steps.

### Decision 2 — Per-engine floor table with recorded evidence, `null` meaning "no known support"

A single constant maps each `LoopEngine` to `{ floor, verifiedOn, note }` or `null`:

- `claude`: floor `2.1.216`, verified 2026-07-22 on the reference host by a completed native
  six-milestone `/goal` run (#506 reproduction). The floor is deliberately the **lowest
  version we have positive evidence for**, not the lowest version that might work — raising
  the bar produces false negatives, and lowering it without evidence produces false positives
  which are worse (a run that starts and cannot finish durably).
- `codex`: `null` — no native goal-mode equivalent is known for `codex-cli` (0.144.6 observed
  2026-07-22). Codex hosts fail closed with remediation pointing at the attestation key, which
  is the honest answer rather than a guessed floor.

The evidence lives in a code comment beside the table so a later bump has to state its own
evidence. When a floor is `null` the check must not silently pass.

### Decision 3 — Semver-ish comparison, tolerant parser, fail-closed on parse failure

Version output is matched with a leading `(\d+)\.(\d+)\.(\d+)` extraction (`2.1.216 (Claude
Code)` → `2.1.216`; `codex-cli 0.144.6` → `0.144.6`) and compared numerically component-wise.
Pre-release/build suffixes are ignored for ordering. A non-zero exec, empty output, or no
match is **not** treated as "recent enough" — it fails with remediation naming the raw
version string observed and the attestation key.

### Decision 4 — Attestation is a `pipeline.yml` config key, not an env var or CLI flag

The key lives under the loop config in `.github/pipeline.yml` (default: automatic detection)
so the assertion is reviewable in the repo alongside the rest of the pipeline contract, and
so an audit of a run can show *who* asserted the capability. A CLI flag would let a single
invocation bypass a real gate with no durable record; an env var is invisible to review.

### Decision 5 — Remediation content is part of the contract

The #506 failure was made expensive by remediation that was confidently wrong ("update
claude" on an already-current, already-capable host). The failure message SHALL state: the
engine, the detected version string (or that it could not be read), the required floor (or
that no native goal mode is known for that engine), and the attestation key with its
values. This is asserted by test, not left to prose.

## Risks / Trade-offs

- **A wrong floor re-introduces false negatives.** Mitigated by choosing the lowest
  evidenced version and by the attestation escape hatch that requires no release.
- **Attestation can be abused to force a run on an incapable host.** Accepted: it is an
  explicit, reviewed, repo-visible operator assertion, and #451's no-fallback rule still
  holds — an incapable host simply fails later, loudly, instead of silently degrading.
- **Version strings drift.** Parser is deliberately loose (first `x.y.z`), fail-closed when
  it does not match, and covered by fixtures for both engines' real observed output.

## Migration

Additive. Existing hosts need no config change: claude ≥ 2.1.216 passes on the version floor
alone. The attestation key is optional with an automatic default, so existing
`.github/pipeline.yml` files remain valid.
