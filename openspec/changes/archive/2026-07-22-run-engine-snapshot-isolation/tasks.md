# Tasks — run-engine snapshot isolation (#450)

## 1. Pin prompt templates at process start

- [ ] 1.1 In `core/scripts/prompts/index.ts`, add a module-scope template snapshot populated at
      module initialization by enumerating `*.md` files next to `index.ts`, behind an injectable
      `readTemplates` seam with the filesystem implementation as its default.
- [ ] 1.2 Rewrite `loadTemplate(name)` to resolve from the snapshot; throw a named-template error for
      an unknown name and never fall back to a filesystem read.
- [ ] 1.3 Export `__resetTemplateSnapshotForTests()` (and a seam override) so tests can populate a
      snapshot deterministically.
- [ ] 1.4 Verify by inspection that no `build*Prompt()` path retains an `fs` read.

## 2. Template fingerprint

- [ ] 2.1 Add an exported pure `templatesFingerprint(snapshot)` hashing sorted
      `name:sha256(content)` pairs into a single stable value.
- [ ] 2.2 Add an engine-identity resolver returning `{ version, root, templates_fingerprint }` from
      the pinned snapshot plus the existing `core/package.json` version source, returning `null` on
      any resolution failure.

## 3. Pin the identity in run.json

- [ ] 3.1 Extend `RunMeta` and `InitRunDirOpts` in `core/scripts/run-store.ts` with the optional
      `engine` object; keep `schema_version` at `1` (additive, optional).
- [ ] 3.2 Pass the resolved identity from `core/scripts/pipeline-run.ts` at `initRunDir` time;
      omit the field when resolution fails and keep run-directory creation succeeding.
- [ ] 3.3 Preserve write-once semantics — a re-entered run-id leaves `run.json` untouched.

## 4. Stage-boundary drift detection

- [ ] 4.1 Add an `EngineDriftEvent` variant to `RunEvent` carrying pinned identity, observed
      identity, and stage.
- [ ] 4.2 Add an injectable drift probe that re-reads the on-disk engine version and recomputes the
      template fingerprint, returning `null` on any throw.
- [ ] 4.3 Call the probe at each stage boundary in `pipeline-run.ts`; compare against the pinned
      identity and against the last observed identity so only transitions emit an event.
- [ ] 4.4 Emit the event, print a visible warning naming both identities, and record the drift in
      `core/scripts/evidence-bundle.ts`.
- [ ] 4.5 Ensure a run with no pinned `engine` object (pre-change run directory) reports nothing.
- [ ] 4.6 Verify no drift path alters a stage outcome, blocker, or exit status.

## 5. Installer live-run deferral

- [ ] 5.1 Add a pure `findLiveRunLocks({ listLocks, readLock, isPidLive })` helper in
      `scripts/install.mjs` mirroring `PipelineLock` liveness semantics (signalable ⇒ live, `ESRCH`
      ⇒ stale, `EPERM` ⇒ live, unparseable contents ⇒ stale).
- [ ] 5.2 Add a `--force` flag to `parseArgs`.
- [ ] 5.3 Run the scan before any file copy on the `install`/`update` path when an existing core is
      present; on live locks, print the paths/PIDs plus the remedy and exit non-zero.
- [ ] 5.4 With `--force`, print the same details as a warning and proceed.
- [ ] 5.5 Leave the first-install (no existing core) and `uninstall` paths unguarded.
- [x] 5.6 Add an installer-held update lock (`acquireUpdateLock`/`releaseUpdateLock`) acquired
      before the live-lock scan and held across the whole copy, so the scan and the copy are one
      critical section instead of two independently-timed steps.
- [x] 5.7 Have the launcher shim (`hosts/_shared/entry.template.mjs`) reserve a
      `pipeline-starting-<pid>.lock` slot — matching the scan's existing `pipeline-*.lock` pattern —
      and re-check the update lock immediately before spawning the engine subprocess, closing the
      TOCTOU between the installer's scan and its copy (round-2 review finding).

## 6. Tests

- [ ] 6.1 `prompts` swap test: build a fix prompt, rewrite `fix.md` on disk with a novel
      `{{reviewed_sha}}`-shaped placeholder, rebuild, assert identical output and no error.
- [ ] 6.2 Assert the template read seam records zero invocations after module initialization, and
      that an unknown template name throws.
- [ ] 6.3 Fingerprint tests: content-sensitive, enumeration-order-independent, stable.
- [ ] 6.4 `run-store` test: `run.json` carries the `engine` object; omitted on resolution failure;
      unchanged on re-entry.
- [ ] 6.5 Drift tests: version change and content-only change each emit one event; repeated
      boundaries emit none; a throwing probe emits none and changes no outcome; absent pin is silent.
- [ ] 6.6 Installer tests: live lock ⇒ refusal with no copy and named paths/PIDs; stale/unparseable
      lock ⇒ proceed; `--force` ⇒ proceed with warning.
- [ ] 6.7 Prove both regression tests bite by reverting each behavior locally.
- [x] 6.8 Update-lock/shim tests: a shim-shaped `pipeline-starting-<pid>.lock` blocks an update like
      any other live lock; a second installer instance is refused while the update lock is held; a
      stale update lock (dead PID) never blocks and is cleaned up; the shim refuses to spawn the
      engine while the update lock is held and never leaves a dangling reservation.

## 7. Docs, mirror, gate

- [ ] 7.1 Document the update-deferral behavior and `--force` in `hosts/claude/SKILL.md` and
      `hosts/codex/SKILL.md`.
- [ ] 7.2 Regenerate the mirror: `node scripts/build.mjs`, commit `plugin/` in the same change.
- [ ] 7.3 `npm run ci` green from the repo root.
- [ ] 7.4 File the deferred follow-up issue for the salvage leak of `.pipeline-rebase-attempted`
      (pipeline-internal marker committed by `trySalvageUncommittedWork`), referencing #450.
