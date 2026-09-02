// Executable command-form disposition inventory (#1329).
//
// Co-located with COMMAND_REGISTRY (same rung as command-docs.ts). Each form
// records two independent axes: execution_disposition and authority_requirement.
// COMMAND_REGISTRY remains dispatch and flag validation. OPERATION_SURFACE
// remains the host/documentation catalog and is not this inventory.
//
// This module must not import pipeline.ts / the CLI.

export const EXECUTION_DISPOSITIONS = [
  "read-only",
  "bounded-atomic-administration",
  "supervised-lifecycle",
] as const;
export type ExecutionDisposition = (typeof EXECUTION_DISPOSITIONS)[number];

export const AUTHORITY_REQUIREMENTS = [
  "none",
  "typed-response",
  "protected-authority",
] as const;
export type AuthorityRequirement = (typeof AUTHORITY_REQUIREMENTS)[number];

const NO_RUN_OWNER =
  "Finishes in one bounded transaction; success or failure leaves no active Logical Operation owner; idempotent or reconcilable against the observer.";

export interface CommandForm {
  /** Stable form id: keyword, keyword.mode, or keyword.subverb. */
  id: string;
  /** COMMAND_REGISTRY keyword this form dispatches under. */
  keyword: string;
  execution_disposition: ExecutionDisposition;
  authority_requirement: AuthorityRequirement;
  /**
   * Required when execution_disposition is bounded-atomic-administration.
   * Explains why durable RecoverySupervisor ownership does not apply.
   */
  ownership_exception?: string;
  /** Flag-only alias that shares this form (e.g. --cleanup). */
  flag_alias?: string;
  notes?: string;
}

function supervised(
  id: string,
  keyword: string,
  authority: AuthorityRequirement = "none",
  notes?: string,
): CommandForm {
  return {
    id,
    keyword,
    execution_disposition: "supervised-lifecycle",
    authority_requirement: authority,
    notes,
  };
}

function readOnly(
  id: string,
  keyword: string,
  authority: AuthorityRequirement = "none",
  notes?: string,
): CommandForm {
  return {
    id,
    keyword,
    execution_disposition: "read-only",
    authority_requirement: authority,
    notes,
  };
}

function boundedAtomic(
  id: string,
  keyword: string,
  reason: string,
  authority: AuthorityRequirement = "none",
  extra?: { flag_alias?: string; notes?: string },
): CommandForm {
  return {
    id,
    keyword,
    execution_disposition: "bounded-atomic-administration",
    authority_requirement: authority,
    ownership_exception: reason,
    flag_alias: extra?.flag_alias,
    notes: extra?.notes,
  };
}

/**
 * Complete inventory of command forms. Mode forms (--dry-run, --apply, status)
 * are first-class rows and do not inherit the drive form's disposition.
 */
export const COMMAND_FORM_INVENTORY: readonly CommandForm[] = [
  // --- Advance / durable drives ---
  supervised("advance", "advance", "none", "Default numeric invocation; durable one-item drive"),
  supervised("single", "single"),
  supervised("run", "run", "none", "Hidden advance alias; inherits advance disposition"),
  supervised("loop", "loop"),
  readOnly("loop.logs", "loop"),

  // --- Operator lifecycle drives ---
  supervised("train", "train"),
  supervised("train.merge", "train", "protected-authority", "--merge is protected operator merge authority"),
  readOnly("train.dry-run", "train"),
  supervised("merge", "merge", "protected-authority"),
  readOnly("merge-queue", "merge-queue", "none", "Dry-run is the default"),
  readOnly("merge-queue.dry-run", "merge-queue"),
  supervised("merge-queue.apply", "merge-queue", "protected-authority"),
  supervised("ship", "ship", "protected-authority"),
  readOnly("ship.status", "ship"),
  supervised("recover-parked", "recover-parked"),
  readOnly("recover-parked.dry-run", "recover-parked"),
  supervised("queue", "queue"),
  supervised("override", "override", "typed-response", "Class policy may additionally require protected-authority"),
  supervised("unblock", "unblock", "typed-response"),

  // --- Handoff ---
  readOnly("handoff.list", "handoff"),
  readOnly("handoff.show", "handoff"),
  supervised("handoff.answer", "handoff", "typed-response"),
  supervised("handoff.reject", "handoff", "typed-response"),
  supervised("handoff.supersede", "handoff", "protected-authority"),

  // --- Admission / backlog (bounded-atomic GitHub writes; no run owner) ---
  boundedAtomic("intake", "intake", `${NO_RUN_OWNER} Creates an issue/PR; does not start a pipeline run.`),
  readOnly("intake.dry-run", "intake"),
  readOnly("decompose", "decompose", "none", "Dry-run is the default"),
  readOnly("decompose.dry-run", "decompose"),
  boundedAtomic("decompose.apply", "decompose", `${NO_RUN_OWNER} Writes child issues and ROADMAP; does not start a run.`),
  boundedAtomic("triage", "triage", `${NO_RUN_OWNER} One admission label write.`),
  readOnly("sweep", "sweep", "none", "Dry-run is the default"),
  readOnly("sweep.dry-run", "sweep"),
  boundedAtomic("sweep.apply", "sweep", `${NO_RUN_OWNER} Re-specs issues and reconciles ROADMAP; does not start a run.`),
  readOnly("roadmap", "roadmap", "none", "Dry-run is the default"),
  readOnly("roadmap.dry-run", "roadmap"),
  boundedAtomic("roadmap.apply", "roadmap", `${NO_RUN_OWNER} Converges open issues to the reviewed manifest; does not start a run.`),
  boundedAtomic("init", "init", `${NO_RUN_OWNER} Labels plus pipeline.yml scaffold.`, "none", { flag_alias: "--init" }),
  boundedAtomic(
    "cleanup",
    "cleanup",
    `${NO_RUN_OWNER} Removes only classified merged-PR worktrees; skips unknown and live-owned state.`,
    "none",
    { flag_alias: "--cleanup" },
  ),
  boundedAtomic(
    "remove-worktree",
    "remove-worktree",
    `${NO_RUN_OWNER} One-shot worktree/branch delete; refuses a fenced live owner including --force.`,
    "none",
    { flag_alias: "--remove-worktree" },
  ),

  // --- Doctor / observability ---
  readOnly("doctor", "doctor", "none", "Standalone diagnostic; exit 1 on failed checks is allowed"),
  readOnly("status", "status"),
  readOnly("summary", "summary"),
  readOnly("logs", "logs"),
  readOnly("path", "path"),
  readOnly("scoreboard", "scoreboard"),
  readOnly("controls", "controls"),
  readOnly("liveness.status", "liveness"),
  boundedAtomic(
    "liveness.restore",
    "liveness",
    `${NO_RUN_OWNER} Restores a worker identity; does not choose recovery policy.`,
  ),

  // --- Release / factory / engine ---
  supervised("release", "release", "protected-authority"),
  readOnly("release.dry-run", "release"),
  supervised("release.finish", "release", "protected-authority"),
  supervised("release.ensure-tag", "release", "protected-authority"),
  readOnly("engine-promote.dry-run", "engine-promote"),
  supervised("engine-promote", "engine-promote"),
  boundedAtomic("factory-gate", "factory-gate", `${NO_RUN_OWNER} Writes FRG evidence; never merges or tags.`),
  supervised("factory-release", "factory-release"),
  supervised("factory-release.prepare", "factory-release"),
  readOnly("factory-pin.show", "factory-pin"),
  boundedAtomic("factory-pin.init", "factory-pin", `${NO_RUN_OWNER} Writes pin JSON only.`),
  boundedAtomic("factory-pin.promote", "factory-pin", `${NO_RUN_OWNER} Writes pin JSON only.`),
  supervised("factory-pin.rollback", "factory-pin", "protected-authority"),

  // --- Grill ---
  supervised("grill", "grill", "none", "Unresolved authority nodes become typed-response handoffs"),
  readOnly("grill.dry-run", "grill"),
  readOnly("grill.status", "grill"),

  // --- Config / local administration ---
  readOnly("config.schema", "config"),
  readOnly("config.validate", "config"),
  boundedAtomic("config.sync", "config", `${NO_RUN_OWNER} Scaffolds local config files.`),
  boundedAtomic("config.repo-map", "config", `${NO_RUN_OWNER} Local repo-map mutation.`),
  readOnly("config", "config", "none", "Keyword default is schema/validate when no mutating sub-verb"),

  readOnly("improve", "improve", "none", "Dry-run is the default"),
  readOnly("improve.dry-run", "improve"),
  boundedAtomic("improve.apply", "improve", `${NO_RUN_OWNER} Clusters local friction into backlog candidates.`),

  readOnly("refine-spec", "refine-spec"),
  readOnly("refine-spec.apply", "refine-spec", "none", "Diagnostic shim toward grill; does not write GitHub"),

  readOnly("backfill", "backfill", "none", "Dry-run is the default"),
  readOnly("backfill.dry-run", "backfill"),
  boundedAtomic("backfill.apply", "backfill", `${NO_RUN_OWNER} Spec-only PR; does not start a pipeline run.`),

  readOnly("evals.plan", "evals"),
  boundedAtomic("evals.run", "evals", `${NO_RUN_OWNER} Offline experiment dir writes; never GitHub.`),
  readOnly("evals.grade", "evals"),
  readOnly("evals.report", "evals"),
  readOnly("evals.harvest", "evals", "none", "Draft-only by default"),
  boundedAtomic("evals.harvest.apply", "evals", `${NO_RUN_OWNER} Repo-local fixture write; never GitHub.`),
  readOnly("evals", "evals", "none", "Keyword default is the documented sub-verb set"),

  boundedAtomic("papercut", "papercut", `${NO_RUN_OWNER} Append-only local friction event.`),
  boundedAtomic("correction.record", "correction", `${NO_RUN_OWNER} Append-only local correction ledger.`),
  boundedAtomic("correction.attribute", "correction", `${NO_RUN_OWNER} Append-only local control attribution.`),
  readOnly("correction", "correction", "none", "Keyword default is record|attribute"),

  readOnly("report", "report", "none", "Preview is the default"),
  boundedAtomic("report.apply", "report", `${NO_RUN_OWNER} Optional product-fault submit after --yes; no pipeline run.`),

  readOnly("outcomes.list", "outcomes"),
  readOnly("outcomes.dry-run", "outcomes"),
  boundedAtomic("outcomes.ingest", "outcomes", `${NO_RUN_OWNER} Host-local outcome store; no GitHub mutation.`),
  readOnly("outcomes", "outcomes", "none", "Keyword default is ingest|list"),

  readOnly("lineage.export", "lineage"),
  readOnly("lineage.impact", "lineage"),
  readOnly("lineage.dry-run", "lineage"),
  boundedAtomic("lineage.propose", "lineage", `${NO_RUN_OWNER} Host-local lineage proposal; no GitHub mutation.`),
  boundedAtomic("lineage.ingest", "lineage", `${NO_RUN_OWNER} Host-local lineage ingest; no GitHub mutation.`),
  readOnly("lineage", "lineage", "none", "Keyword default is export|impact|propose|ingest"),
];

/** Modules that implement supervised-lifecycle forms (static lifecycle-exit scan). */
export const SUPERVISED_COMMAND_MODULES = [
  "scripts/pipeline.ts",
  "scripts/pipeline-run.ts",
  "scripts/recover-parked.ts",
  "scripts/factory-release-prepare.ts",
  "scripts/stages/queue.ts",
  "scripts/stages/merge.ts",
  "scripts/stages/merge-queue.ts",
  "scripts/stages/train.ts",
  "scripts/stages/ship.ts",
  "scripts/stages/ship-adapter.ts",
  "scripts/stages/release.ts",
  "scripts/stages/release-finish.ts",
  "scripts/stages/engine-promote.ts",
  "scripts/stages/grill.ts",
] as const;

/** Read-only command modules that must not write recovery state. */
export const READ_ONLY_COMMAND_MODULES = [
  "scripts/stages/doctor.ts",
  "scripts/status-json.ts",
  "scripts/path-cli.ts",
  "scripts/scoreboard.ts",
  "scripts/loop/logs.ts",
] as const;

const FORM_BY_ID = new Map(COMMAND_FORM_INVENTORY.map((f) => [f.id, f]));

export function isExecutionDisposition(value: unknown): value is ExecutionDisposition {
  return typeof value === "string" && (EXECUTION_DISPOSITIONS as readonly string[]).includes(value);
}

export function isAuthorityRequirement(value: unknown): value is AuthorityRequirement {
  return typeof value === "string" && (AUTHORITY_REQUIREMENTS as readonly string[]).includes(value);
}

export function lookupCommandForm(id: string): CommandForm | undefined {
  return FORM_BY_ID.get(id);
}

export function formsForKeyword(
  keyword: string,
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): CommandForm[] {
  return inventory.filter((f) => f.keyword === keyword);
}

export function inventoryKeywords(
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): Set<string> {
  return new Set(inventory.map((f) => f.keyword));
}

export function flagAliasForm(
  flag: string,
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): CommandForm | undefined {
  return inventory.find((f) => f.flag_alias === flag);
}

/** Numeric or undefined lookup classifies as the advance form. */
export function formForLookupKeyword(keyword: string | undefined): CommandForm | undefined {
  if (keyword === undefined || /^\d+$/.test(keyword)) return lookupCommandForm("advance");
  return formsForKeyword(keyword)[0] ?? lookupCommandForm(keyword);
}

export function missingRegistryKeywords(
  registryKeys: readonly string[],
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): string[] {
  const keywords = inventoryKeywords(inventory);
  return registryKeys.filter((k) => !keywords.has(k));
}

/**
 * A mutating form is any non-read-only disposition, or a registry/mode form
 * that writes GitHub, git, worktree, run-store, pin, or recovery state.
 */
export function missingMutatingDispositions(input: {
  registryKeys: readonly string[];
  documentedModes?: readonly { keyword: string; mode: string }[];
  inventory?: readonly CommandForm[];
}): string[] {
  const inventory = input.inventory ?? COMMAND_FORM_INVENTORY;
  const missing: string[] = [];
  for (const key of missingRegistryKeywords(input.registryKeys, inventory)) {
    missing.push(key);
  }
  for (const mode of input.documentedModes ?? []) {
    const id = `${mode.keyword}.${mode.mode}`;
    if (!inventory.some((f) => f.id === id || (mode.mode === "keyword" && f.id === mode.keyword))) {
      missing.push(id);
    }
  }
  for (const form of inventory) {
    if (form.execution_disposition !== "read-only") {
      if (!isExecutionDisposition(form.execution_disposition) || !isAuthorityRequirement(form.authority_requirement)) {
        missing.push(form.id);
      }
    }
  }
  return missing;
}

export function boundedAtomicRowsMissingReason(
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): string[] {
  return inventory
    .filter((f) => f.execution_disposition === "bounded-atomic-administration")
    .filter((f) => !f.ownership_exception?.trim())
    .map((f) => f.id);
}

export function hostCatalogVerbsMissingForms(
  surfaceNames: readonly string[],
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): string[] {
  const keywords = inventoryKeywords(inventory);
  return surfaceNames.filter((name) => name.trim() && !keywords.has(name));
}

export function parserKeywordsMissingFromInventory(
  parserKeywords: readonly string[],
  inventory: readonly CommandForm[] = COMMAND_FORM_INVENTORY,
): string[] {
  const keywords = inventoryKeywords(inventory);
  return parserKeywords.filter((k) => !keywords.has(k));
}

/** Extract `numArg === "keyword"` dispatch sites from pipeline.ts source. */
export function collectParserDispatchKeywords(pipelineSource: string): string[] {
  const found = new Set<string>();
  const re = /numArg === ["']([a-z0-9-]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pipelineSource)) !== null) {
    found.add(m[1]!);
  }
  if (/remove-worktree/.test(pipelineSource) && /opts\.removeWorktree/.test(pipelineSource)) {
    found.add("remove-worktree");
  }
  return [...found].sort();
}

const DOCUMENTED_MODE_RE = /--dry-run|--apply|\bstatus\b/;

export function documentedModeFormsFromUsage(keyword: string, usage: string): { keyword: string; mode: string }[] {
  const modes: { keyword: string; mode: string }[] = [];
  if (/--dry-run/.test(usage)) modes.push({ keyword, mode: "dry-run" });
  if (/--apply/.test(usage)) modes.push({ keyword, mode: "apply" });
  if (new RegExp(`(?:^|\\s)${keyword}\\s+status\\b|\\b${keyword} status\\b`).test(usage) || /\bstatus\b/.test(usage) && keyword === "ship") {
    if (/\bstatus\b/.test(usage) && (usage.includes(`${keyword} status`) || usage.includes("status --"))) {
      modes.push({ keyword, mode: "status" });
    }
  }
  if (keyword === "grill" && /grill status/.test(usage)) {
    if (!modes.some((m) => m.mode === "status")) modes.push({ keyword, mode: "status" });
  }
  if (keyword === "liveness" && /liveness status/.test(usage)) {
    modes.push({ keyword, mode: "status" });
  }
  return modes;
}

export function assertCommandFormClosedSets(form: CommandForm): void {
  if (!isExecutionDisposition(form.execution_disposition)) {
    throw new Error(`unknown execution_disposition on ${form.id}: ${String(form.execution_disposition)}`);
  }
  if (!isAuthorityRequirement(form.authority_requirement)) {
    throw new Error(`unknown authority_requirement on ${form.id}: ${String(form.authority_requirement)}`);
  }
}

/** Unused import guard helper for documented-mode scans. */
export function usageLooksLikeModeForm(usage: string): boolean {
  return DOCUMENTED_MODE_RE.test(usage);
}
