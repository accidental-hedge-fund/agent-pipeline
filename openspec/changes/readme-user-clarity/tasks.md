## 1. Audit

- [ ] 1.1 Read README.md end-to-end and annotate which sections satisfy each spec requirement and which do not
- [ ] 1.2 Verify every install command, flag, and env var against the current `scripts/install.mjs` implementation to confirm accuracy
- [ ] 1.3 Verify the reviewer-wiring description matches the current `prompt-harness` default and correctly separates it from optional companion modes
- [ ] 1.4 Verify all `.github/pipeline.yml` config key examples are currently recognized (check `core/scripts/types.ts` and `config.ts`)
- [ ] 1.5 Check all hyperlinks in the current README for validity (internal anchors and external URLs)

## 2. Opening and Hero Section

- [ ] 2.1 Write a purpose-first opening paragraph (≤ one screenful) that states: what the pipeline does, the cross-harness model (Claude implements + Codex reviews, or vice versa), and that both harnesses are required
- [ ] 2.2 Consolidate the prerequisites into a clear "Prerequisites" section immediately after the opening, before repository layout or install instructions — including Node ≥ 24, git, gh, both CLIs, and conventions files
- [ ] 2.3 Move the repository layout block to after the quickstart so it doesn't interrupt the newcomer path

## 3. Quickstart Section

- [ ] 3.1 Add a "Quickstart" (or "Getting Started") H2 section that contains: (a) the single recommended install one-liner, (b) a two-step first-run example showing how to label an issue `pipeline:ready` and invoke `/pipeline N`
- [ ] 3.2 Ensure the recommended install command is visually distinct (e.g., presented first, before alternative install paths)
- [ ] 3.3 Confirm the first-run example is accurate against current CLI behavior

## 4. Optional Topics Separation

- [ ] 4.1 Audit each of the following sections and add "(optional)" to the heading or a "default off" / "optional" lead sentence where missing: OpenSpec integration, last30days context, configurable steps, eval gate, companion review modes
- [ ] 4.2 Reorder sections so all optional/advanced topics appear after the core quickstart and usage sections — proposed order: Quickstart → Usage → Per-repo config → Test/build gate → [Optional:] Configurable steps, Eval gate, OpenSpec, last30days → How the two hosts share one core → Uninstall → Development
- [ ] 4.3 Verify a reader can stop after "Usage" and have a working setup without needing any optional section

## 5. Navigability and Formatting

- [ ] 5.1 Ensure there is exactly one H1 heading; audit all heading levels for consistency (no skipped levels, no H3 before H2 in the same section)
- [ ] 5.2 Add a table of contents (linked anchor list) near the top of the document covering all H2 sections
- [ ] 5.3 Add language hints (`bash`, `yaml`, `json`) to all fenced code blocks that are missing them
- [ ] 5.4 Fix any broken or placeholder anchor links discovered in task 1.5

## 6. Accuracy and Final Review

- [ ] 6.1 Apply any accuracy corrections identified in task 1.2–1.4 (stale flags, wrong reviewer description, invalid config keys)
- [ ] 6.2 Read the revised README top-to-bottom as a first-time user and confirm: purpose is clear in the first screenful, cross-harness requirement is visible before install, quickstart leads to a working setup, optional sections are clearly marked
- [ ] 6.3 Render the README on GitHub (or a local preview tool) and confirm: no broken Markdown, code blocks render with syntax hints, table of contents anchors resolve
