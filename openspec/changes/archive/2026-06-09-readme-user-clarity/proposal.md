## Why

The README is the primary front door for a tool that is designed to have many consumers, but it currently reads as a dense reference document aimed at people who already understand the system. A developer arriving cold cannot determine within the first screenful what the tool does, who it is for, or that it requires **both** harnesses (a non-obvious cross-harness prerequisite) — meaning many installs hit a surprise blocker partway through.

## What Changes

- **Opening / hero section** — replace the current layout-first opening with a purpose-first intro: what the pipeline does, the cross-harness model, and the core prerequisite summary, all before any configuration detail.
- **Quickstart section** — introduce an explicit fast-path from "I just want to try this" to a first successful pipeline run: one recommended install command, prerequisites checklist, and a two-step first-run example.
- **Section reordering** — move advanced/optional topics (OpenSpec, last30days, configurable steps, eval gate, companion review modes, development) into a visually separated area so they do not block newcomers reaching the core flow.
- **Formatting and navigability pass** — consistent heading hierarchy, an anchor-friendly section structure, working links, and correct code/config block syntax so the document is skimmable and GitHub-renderable.
- **Accuracy pass** — verify every instruction against current behavior (reviewer wiring, install flags, companion modes, uninstall) so no step contradicts how the tool actually works.

No behavior, commands, config keys, or install mechanics change — this is documentation only.

## Capabilities

### New Capabilities

- `readme-user-clarity`: Requirements for what the README must communicate, how it must be structured, and how accurately it must reflect the tool's current behavior — covering the opening, quickstart, optional-topics separation, navigability, and formatting standards.

### Modified Capabilities

(none — no existing spec-level requirements change)

## Impact

- `README.md` — the only file changed
