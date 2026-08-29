// Shared host-SKILL one-pager renderer (#1049).
//
// One deep rendering seam: `renderHostSkill(options?)`. Production defaults
// load `OPERATION_SURFACE` and `loadOuterHostManifestsPreferHosts()`. Tests
// inject both. Notify values come only from selected manifests' mapping
// fields. `SKILL_HOST_IDS` is membership-only: no notify values, no lifecycle
// dispatch.
//
// #971 may import this module and call `renderHostSkill` for the same bytes.
// This file does not add Hermes or OpenClaw install logic.

import { loadOuterHostManifestsPreferHosts } from "./outer-hosts/load-manifest.ts";
import type { OuterHostManifest } from "./outer-hosts/types.ts";
import {
  OPERATION_SURFACE,
  type OperationSurfaceEntry,
} from "./operation-surface.ts";

/** Issue-locked generated-host membership. Contains no notify values. */
export const SKILL_HOST_IDS = ["claude", "codex", "grok", "opencode"] as const;
export type SkillHostId = (typeof SKILL_HOST_IDS)[number];

export const HOST_SKILL_PACKAGING_DOC_URL =
  "https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/packaging.md";
export const HOST_SKILL_CLI_DOC_URL =
  "https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/cli.md";

export interface SkillNotifyRow {
  id: SkillHostId;
  displayName: string;
  surface: string;
  tools: readonly string[];
  filter: string;
}

export interface RenderHostSkillOptions {
  operationSurface?: readonly OperationSurfaceEntry[];
  manifests?: readonly OuterHostManifest[];
}

/** Repo-relative SKILL path for one generated host. */
export function hostSkillRelativePath(id: SkillHostId): string {
  return `hosts/${id}/SKILL.md`;
}

/** Repo-relative SKILL paths derived from membership, in tuple order. */
export function hostSkillRelativePaths(
  ids: readonly SkillHostId[] = SKILL_HOST_IDS,
): readonly string[] {
  return ids.map(hostSkillRelativePath);
}

function isSkillHostId(value: string): value is SkillHostId {
  return (SKILL_HOST_IDS as readonly string[]).includes(value);
}

function usableNotifySurface(surface: unknown): surface is string {
  return typeof surface === "string" && surface.trim() !== "" && surface.trim() !== "none";
}

function portableFallback(fallback: unknown): fallback is string {
  return typeof fallback === "string" && fallback.trim() !== "";
}

/**
 * Select exactly one manifest per `SKILL_HOST_IDS` entry, in tuple order.
 * Fail closed on a missing or duplicate selected ID. Ignore non-selected
 * manifests such as OMP.
 */
export function selectSkillHostManifests(
  manifests: readonly OuterHostManifest[],
): OuterHostManifest[] {
  const byId = new Map<string, OuterHostManifest[]>();
  for (const manifest of manifests) {
    const id = typeof manifest.id === "string" ? manifest.id : "";
    const list = byId.get(id) ?? [];
    list.push(manifest);
    byId.set(id, list);
  }

  const selected: OuterHostManifest[] = [];
  for (const id of SKILL_HOST_IDS) {
    const matches = byId.get(id) ?? [];
    if (matches.length === 0) {
      throw new Error(`host-skill: missing selected host manifest: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`host-skill: duplicate selected host manifest: ${id}`);
    }
    selected.push(matches[0]!);
  }
  return selected;
}

function assertNotifyCapability(manifest: OuterHostManifest): void {
  const notify = manifest.material_progress_notify;
  const mapping = notify?.mapping;
  const surfaceOk = usableNotifySurface(mapping?.surface);
  const fallbackOk = portableFallback(notify?.fallback);
  if (!surfaceOk && !fallbackOk) {
    throw new Error(
      `host-skill: host ${manifest.id} material_progress_notify has neither a usable surface nor a portable fallback`,
    );
  }
}

/** Compact notify rows projected from selected manifests, in tuple order. */
export function projectSkillNotifyRows(
  manifests: readonly OuterHostManifest[],
): SkillNotifyRow[] {
  const selected = selectSkillHostManifests(manifests);
  return selected.map((manifest) => {
    if (!isSkillHostId(manifest.id)) {
      throw new Error(`host-skill: selected manifest id is not a SKILL host: ${manifest.id}`);
    }
    assertNotifyCapability(manifest);
    const mapping = manifest.material_progress_notify.mapping;
    return {
      id: manifest.id,
      displayName: manifest.displayName,
      surface: mapping.surface,
      tools: mapping.tools,
      filter: mapping.filter,
    };
  });
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return `${s} `;
  return s + " ".repeat(width - s.length);
}

function renderVerbTable(surface: readonly OperationSurfaceEntry[]): string {
  const pad = 52;
  const lines: string[] = ["```"];
  for (const op of surface) {
    const usage = `pipeline ${op.usage}`;
    lines.push(`${padRight(usage, pad)}${op.desc}`);
  }
  lines.push("```");
  return lines.join("\n");
}

function formatTools(tools: readonly string[]): string {
  return tools.length > 0 ? tools.join(", ") : "—";
}

function renderNotifyTable(rows: readonly SkillNotifyRow[]): string {
  const lines = [
    "| Host | Surface | Tools | Filter |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.surface} | ${formatTools(row.tools)} | ${row.filter} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the complete host-neutral SKILL one-pager.
 *
 * Optional `operationSurface` and `manifests` support deterministic tests.
 * Production defaults are `OPERATION_SURFACE` and
 * `loadOuterHostManifestsPreferHosts()`.
 */
export function renderHostSkill(options: RenderHostSkillOptions = {}): string {
  const operationSurface = options.operationSurface ?? OPERATION_SURFACE;
  const manifests = options.manifests ?? loadOuterHostManifestsPreferHosts();
  const rows = projectSkillNotifyRows(manifests);

  return [
    "---",
    "name: pipeline",
    "description: |",
    "  Use this skill whenever the user wants to advance a GitHub issue or PR",
    "  through a label-driven dev pipeline toward `pipeline:ready-to-deploy`.",
    "  Triggers include phrases like \"pipeline issue 419\", \"push #360 forward\",",
    "  \"advance this PR through review\", \"run the pipeline on <issue>\", or the",
    "  `/pipeline` slash command. Do NOT use this skill for: general PR review",
    "  (use /review), backlog triage/cleanup (use /sweep), or deploying a finished",
    "  item (deployment is out of scope — the pipeline stops at ready-to-deploy).",
    "---",
    "",
    "# pipeline",
    "",
    "Host SKILL for the `pipeline` CLI. Execute catalog operations as `pipeline <verb>`.",
    "",
    "Default numeric drive (outside the verb table): `pipeline <N>` starts durable",
    "autonomous one-item work for issue or PR N. `pipeline status <N>` reports issue",
    "metadata (stage, blocker, PR). It does not discover a run id.",
    "",
    "## Operations",
    "",
    renderVerbTable(operationSurface),
    "",
    "## Follow / notify",
    "",
    "Capture durable run ids from handoff and linkage. Do not infer them from",
    "`pipeline status <N>`. `pipeline loop` drive and resume are long-running.",
    "Do not treat them as seconds-only or as fire-and-forget.",
    "",
    "1. Status pre-check: `pipeline status <N>`.",
    "2. Launch default drive: `pipeline <N>` or `pipeline single <N>`.",
    "3. Retain `loop_run_id` from the durable handoff (`run_id`).",
    "4. Follow `pipeline loop logs <loop-run-id> --events --follow`.",
    "5. After `loop_item_advance_linked` publishes `pipeline_run_id`, retain that",
    "   value as the linked `advance_run_id` and also follow",
    "   `pipeline logs <advance-run-id> --events --follow`. Keep the loop follow",
    "   active. On a later linkage or a terminal advance, stop or replace the prior",
    "   advance follow. Do not guess an advance id before linkage.",
    "6. Notify only material events through the active host row and the shared",
    "   material filter (`scripts/material-filter.mjs`). See the CLI event",
    "   reference rather than this one-pager for the complete kind inventory.",
    "7. Reattach an interrupted follow with the same retained ids.",
    "   Interrupted follow is non-terminal. Cancelled wait is not completion.",
    "8. Stop every run-scoped follow on confirmed terminal (`run_complete`,",
    "   `loop_run_complete`, `loop_run_stopped`) or supervisor exit, in the same",
    "   turn.",
    "9. After a confirmed terminal loop outcome, emit a final summary with the",
    "   terminal reason and confirmation that follows stopped.",
    "10. Premature supervisor exit is non-terminal failure/recovery, never",
    "    completion. Tear down every run-scoped follow, then report recovery — do",
    "    not emit a completion summary.",
    "",
    "The follower or observer never invokes a merge-capable command: `merge`,",
    "`merge-queue --apply`, `train --merge`, or `ship`.",
    "",
    "### Host notify map",
    "",
    "Select the row for the active host. Shared orchestration does not hard-require",
    "another host's tools. Compact rows carry mapping fields only; portable",
    "fallback stays in the outer-host manifest and durable docs.",
    "",
    renderNotifyTable(rows),
    "",
    "## Authority",
    "",
    "Default `pipeline <N>`, `pipeline single`, and `pipeline loop` are autonomous",
    "through `pipeline:ready-to-deploy` and never merge or deploy.",
    "",
    "Operator-authorized, non-advance surfaces:",
    "",
    "- `pipeline merge <pr>`",
    "- `pipeline merge-queue --apply` (merge-queue is dry-run by default unless `--apply` is explicit)",
    "- `pipeline train --merge`",
    "- `pipeline ship --milestone`",
    "",
    "`Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z`. No grant",
    "file is required.",
    "",
    "## Docs",
    "",
    `- Packaging: ${HOST_SKILL_PACKAGING_DOC_URL}`,
    `- CLI: ${HOST_SKILL_CLI_DOC_URL}`,
    "",
  ].join("\n");
}
