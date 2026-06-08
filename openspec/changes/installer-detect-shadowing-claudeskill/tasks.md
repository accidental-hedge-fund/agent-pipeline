## 1. Marker File — Write on Install

- [ ] 1.1 In `stageInto()`, write an empty `.pipeline-installer-managed` file into the staging directory so it is included in the atomic rename
- [ ] 1.2 Verify dry-run path does NOT write the marker (no-op check — `stageInto` is not called in dry-run)

## 2. Shadow Detection Logic

- [ ] 2.1 Add `detectPersonalSkill(host)` function that checks `existsSync(dest)` and absence of `.pipeline-installer-managed`; returns `{ shadowing: boolean, dest: string }`
- [ ] 2.2 Add `uniqueBackupPath(claudeBase, timestamp)` helper that returns the first non-existing path of the form `pipeline.<ts>.bak`, `pipeline.<ts>.bak.1`, …, `pipeline.<ts>.bak.N` (cap at 100)
- [ ] 2.3 Add `relocatePersonalSkill(dest, backupPath)` that calls `renameSync(dest, backupPath)` — no deletion, no overwrite

## 3. Interactive + Non-interactive Flow

- [ ] 3.1 Add `offerRelocation(dest, claudeBase)` async function: checks `process.stdin.isTTY`; if false, emits warning + manual command and returns without prompting
- [ ] 3.2 In TTY path: use `readline.createInterface` to prompt "Relocate [y/N]?"; on "y" call `relocatePersonalSkill`; on "n" print manual command + duplicate-`/pipeline` consequence
- [ ] 3.3 Wire `offerRelocation` into `main()` — call for each host that includes "claude", after `preflight()` and before the `installHost()` loop

## 4. Unit Tests

- [ ] 4.1 Create `scripts/install.test.mjs` with a test harness that stubs `fs` operations and `process.stdin.isTTY`
- [ ] 4.2 Test: no marker → `detectPersonalSkill` returns `{ shadowing: true }` with correct `dest`
- [ ] 4.3 Test: marker present → `detectPersonalSkill` returns `{ shadowing: false }`
- [ ] 4.4 Test: `uniqueBackupPath` returns first non-existing name; increments suffix when backups exist; throws after 100 collisions
- [ ] 4.5 Test: `CLAUDE_CONFIG_DIR` override — detection and backup paths use the custom dir
- [ ] 4.6 Test: non-TTY path emits warning with manual command and does not prompt

## 5. README Update

- [ ] 5.1 In README "Claude Code — plugin marketplace" section, replace the prose instruction to manually remove `~/.claude/skills/pipeline` with a note that the installer detects and offers to relocate any pre-existing personal install
