// Factory Reliability Gate (FRG) — mandatory multi-item reliability precondition
// for every release (#723, capability `factory-reliability-gate`).
//
// Layer A (hermetic composition tests) lives under core/test/*factory-reliability*.
// Layer B (this module): scripted driver that scores a durable loop run against
// fixed numeric thresholds and writes an immutable evidence artifact under
// `.agent-pipeline/frg/<version>/…`. Release preparation looks up a pass artifact
// for the resolved version and fails closed when missing, unparsable, or failed.
//
// FRG observes and scores only — it never merges PRs, enables auto-merge, or
// creates release tags (golden rule #4).

import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  isDurableBlockerClass,
  type DurableBlockerClass,
  type LoopContract,
  type LoopLedger,
  type LoopItemState,
} from "./loop/types.ts";

// ---------------------------------------------------------------------------
// Schema + thresholds
// ---------------------------------------------------------------------------

/** FRG evidence schema version — bump when field semantics change incompatibly. */
export const FRG_SCHEMA_VERSION = 1;

/** Stable scenario ids (scoreboard + Layer A mapping). */
export const FRG_SCENARIO_IDS = [
  "capacity-blocked-retain",
  "resume-mid-flight",
  "openspec-multi-change",
  "implement-lockfile-dirt",
  "local-docs-parity",
  "clean-item-throughput",
  "blocker-taxonomy",
  "pr-supersession",
  "release-plan-row",
  "empty-depends-on-stack-honesty",
] as const;

export type FrgScenarioId = (typeof FRG_SCENARIO_IDS)[number];

/**
 * Numeric pass criteria (runbook v1). May tighten via runbook updates; values
 * remain checked here so the driver never uses qualitative-only guidance.
 */
export interface FrgThresholds {
  /** K — min items reaching ready without engine-class block. */
  min_clean_ready_to_deploy: number;
  /** N — capacity stress: blocked retain count the pack must tolerate. */
  capacity_stress_n: number;
  /** Max allowed engine-class rate in [0, 1]; strictly greater fails. */
  max_engine_class_rate: number;
}

export const DEFAULT_FRG_THRESHOLDS: FrgThresholds = {
  min_clean_ready_to_deploy: 2,
  capacity_stress_n: 2,
  max_engine_class_rate: 0.25,
};

/** Blocker taxonomy buckets for gate honesty. */
export type FrgBlockerTaxonomy = "engine-class" | "product-class" | "human-authority";

/**
 * Map durable-loop blocker themes to FRG taxonomy.
 * - workflow-engine-defect → engine-class (factory defect)
 * - missing-authority / specification-decision → human-authority
 * - everything else that is a typed durable class → product-class by default
 *   (pack-injected product failures); unknown themes default to engine-class
 *   so silent new defect shapes cannot green the gate.
 */
export function classifyFrgBlocker(theme: string | null | undefined): FrgBlockerTaxonomy {
  if (!theme) return "engine-class";
  if (theme === "workflow-engine-defect") return "engine-class";
  if (theme === "missing-authority" || theme === "specification-decision") {
    return "human-authority";
  }
  if (isDurableBlockerClass(theme)) return "product-class";
  // Capacity cascade / docs-after-PR / lock-dirt-at-zero-attempts strings that
  // may appear as free-form evidence themes.
  if (
    /capacity|worktree.?cap|lockfile|docs.?fresh|pr.?supersed|archive.?false|pr_opened.?strand|resume.?strand/i.test(
      theme,
    )
  ) {
    return "engine-class";
  }
  return "engine-class";
}

export type FrgScenarioStatus = "pass" | "fail" | "warn" | "skip" | "not_observed";

export interface FrgScenarioOutcome {
  id: FrgScenarioId;
  status: FrgScenarioStatus;
  detail: string;
  /** Optional observed metric (e.g. clean ready count, engine rate). */
  observed?: number | null;
  /** Optional threshold used for this scenario. */
  threshold?: number | null;
}

export interface FrgScoreboard {
  item_count: number;
  ready_clean_count: number;
  engine_class_count: number;
  product_class_count: number;
  human_authority_count: number;
  engine_class_rate: number | null;
  per_item: FrgItemOutcome[];
}

export interface FrgItemOutcome {
  item_id: string;
  state: string;
  ready_clean: boolean;
  blocker_theme: string | null;
  blocker_class: FrgBlockerTaxonomy | null;
}

export interface FrgEvidence {
  schema_version: number;
  version: string;
  run_id: string;
  pass: boolean;
  scenarios: FrgScenarioOutcome[];
  scoreboard: FrgScoreboard;
  thresholds: FrgThresholds;
  /** Durable loop run id when evidence is projected from a real loop. */
  loop_run_id: string | null;
  created_at: string;
  /** Optional notes (warnings, pack selection). */
  notes: string[];
}

export type FrgLookupResult =
  | { kind: "pass"; evidence: FrgEvidence }
  | { kind: "fail"; evidence: FrgEvidence }
  | { kind: "missing"; version: string; path: string }
  | { kind: "unparsable"; version: string; path: string; detail: string };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Repo-relative root for FRG evidence (stable; documented in the runbook). */
export const FRG_EVIDENCE_ROOT_REL = path.join(".agent-pipeline", "frg");

export function normalizeFrgVersion(version: string): string {
  const v = version.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(
      `Invalid FRG version "${version}": expected X.Y.Z (optional leading v)`,
    );
  }
  return v;
}

export function frgVersionDir(repoDir: string, version: string): string {
  return path.join(repoDir, FRG_EVIDENCE_ROOT_REL, normalizeFrgVersion(version));
}

export function frgLatestPath(repoDir: string, version: string): string {
  return path.join(frgVersionDir(repoDir, version), "latest.json");
}

export function frgRunEvidencePath(repoDir: string, version: string, runId: string): string {
  return path.join(frgVersionDir(repoDir, version), runId, "evidence.json");
}

export function newFrgRunId(now: () => Date = () => new Date()): string {
  const iso = now().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `frg-${iso}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Evidence parse / write / lookup
// ---------------------------------------------------------------------------

export interface FrgFsDeps {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  mkdir(p: string, opts: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const defaultFsDeps: FrgFsDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  rename: (from, to) => fsp.rename(from, to),
};

/** Parse and validate a machine-readable FRG evidence object. */
export function parseFrgEvidence(raw: unknown): FrgEvidence {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== FRG_SCHEMA_VERSION) {
    throw new Error(
      `FRG evidence schema_version must be ${FRG_SCHEMA_VERSION} (got ${String(o.schema_version)})`,
    );
  }
  if (typeof o.version !== "string" || !/^\d+\.\d+\.\d+$/.test(o.version)) {
    throw new Error("FRG evidence.version must be X.Y.Z");
  }
  if (typeof o.run_id !== "string" || o.run_id.trim() === "") {
    throw new Error("FRG evidence.run_id must be a non-empty string");
  }
  if (typeof o.pass !== "boolean") {
    throw new Error("FRG evidence.pass must be a boolean");
  }
  if (!Array.isArray(o.scenarios)) {
    throw new Error("FRG evidence.scenarios must be an array");
  }
  if (o.scoreboard === null || typeof o.scoreboard !== "object") {
    throw new Error("FRG evidence.scoreboard must be an object");
  }
  if (o.thresholds === null || typeof o.thresholds !== "object") {
    throw new Error("FRG evidence.thresholds must be an object");
  }
  return o as unknown as FrgEvidence;
}

/** Synchronous-style parse from a JSON string. */
export function parseFrgEvidenceJson(text: string): FrgEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`FRG evidence JSON parse failed: ${(err as Error).message}`);
  }
  return parseFrgEvidence(raw);
}

/** Atomic write of immutable evidence + latest pointer for the version. */
export async function writeFrgEvidence(
  repoDir: string,
  evidence: FrgEvidence,
  deps: FrgFsDeps = defaultFsDeps,
): Promise<{ evidencePath: string; latestPath: string }> {
  const version = normalizeFrgVersion(evidence.version);
  const evidencePath = frgRunEvidencePath(repoDir, version, evidence.run_id);
  const latestPath = frgLatestPath(repoDir, version);
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  await deps.mkdir(path.dirname(evidencePath), { recursive: true });
  const tmp = `${evidencePath}.tmp`;
  await deps.writeFile(tmp, body);
  await deps.rename(tmp, evidencePath);
  await deps.mkdir(path.dirname(latestPath), { recursive: true });
  const latestTmp = `${latestPath}.tmp`;
  await deps.writeFile(latestTmp, body);
  await deps.rename(latestTmp, latestPath);
  return { evidencePath, latestPath };
}

/**
 * Look up the latest FRG evidence for a version. Distinguishes missing vs
 * failed vs unparsable so release can surface the right refusal.
 */
export async function lookupFrgPass(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
): Promise<FrgLookupResult> {
  const v = normalizeFrgVersion(version);
  const latestPath = frgLatestPath(repoDir, v);
  let text: string;
  try {
    text = await deps.readFile(latestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", version: v, path: latestPath };
    }
    return {
      kind: "unparsable",
      version: v,
      path: latestPath,
      detail: (err as Error).message,
    };
  }
  try {
    const evidence = parseFrgEvidenceJson(text);
    if (evidence.version !== v) {
      return {
        kind: "unparsable",
        version: v,
        path: latestPath,
        detail: `evidence.version ${evidence.version} does not match lookup ${v}`,
      };
    }
    if (!evidence.run_id.trim()) {
      return {
        kind: "unparsable",
        version: v,
        path: latestPath,
        detail: "evidence.run_id is empty",
      };
    }
    return evidence.pass
      ? { kind: "pass", evidence }
      : { kind: "fail", evidence };
  } catch (err) {
    return {
      kind: "unparsable",
      version: v,
      path: latestPath,
      detail: (err as Error).message,
    };
  }
}

/**
 * Release-path gate: require a pass artifact for the resolved version.
 * Throws with a message that names the version and how to run the FRG driver.
 */
export async function requireFrgPassForRelease(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
): Promise<FrgEvidence> {
  const v = normalizeFrgVersion(version);
  const result = await lookupFrgPass(repoDir, v, deps);
  if (result.kind === "pass") return result.evidence;
  if (result.kind === "fail") {
    throw new Error(
      `[pipeline release] Factory Reliability Gate FAILED for version ${v} ` +
        `(run_id=${result.evidence.run_id}). ` +
        `See docs/factory-reliability-gate-runbook.md and re-run: ` +
        `pipeline factory-gate --for ${v}`,
    );
  }
  if (result.kind === "unparsable") {
    throw new Error(
      `[pipeline release] Factory Reliability Gate evidence for version ${v} is unparsable ` +
        `(${result.path}): ${result.detail}. ` +
        `See docs/factory-reliability-gate-runbook.md and re-run: ` +
        `pipeline factory-gate --for ${v}`,
    );
  }
  throw new Error(
    `[pipeline release] Factory Reliability Gate pass missing for version ${v} ` +
      `(expected ${result.path}). ` +
      `Unit CI alone is not sufficient. Run: pipeline factory-gate --for ${v} ` +
      `(see docs/factory-reliability-gate-runbook.md).`,
  );
}

/** Markdown section for the release PR body. */
export function formatFrgPrSection(evidence: FrgEvidence): string {
  return [
    "### Factory Reliability Gate",
    "",
    `- **Version:** ${evidence.version}`,
    `- **Result:** ${evidence.pass ? "pass" : "fail"}`,
    `- **FRG run_id:** \`${evidence.run_id}\``,
    evidence.loop_run_id ? `- **Loop run_id:** \`${evidence.loop_run_id}\`` : null,
    `- **Clean ready-to-deploy:** ${evidence.scoreboard.ready_clean_count} (threshold K=${evidence.thresholds.min_clean_ready_to_deploy})`,
    `- **Engine-class rate:** ${
      evidence.scoreboard.engine_class_rate === null
        ? "n/a"
        : `${(evidence.scoreboard.engine_class_rate * 100).toFixed(1)}%`
    } (max ${(evidence.thresholds.max_engine_class_rate * 100).toFixed(0)}%)`,
    "",
    `_Evidence: \`${FRG_EVIDENCE_ROOT_REL}/${evidence.version}/${evidence.run_id}/evidence.json\`_`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Scoring from durable loop ledger / item outcomes
// ---------------------------------------------------------------------------

export interface FrgItemInput {
  item_id: string;
  state: string;
  blocker_theme?: string | null;
  /** When true, item reached ready/ready-to-deploy without engine-class block. */
  ready_clean?: boolean;
}

export interface FrgScenarioOverride {
  id: FrgScenarioId;
  status: FrgScenarioStatus;
  detail: string;
  observed?: number | null;
  threshold?: number | null;
}

export interface ComputeFrgInput {
  version: string;
  run_id?: string;
  loop_run_id?: string | null;
  items: FrgItemInput[];
  thresholds?: FrgThresholds;
  /** Pack-specific scenario outcomes (capacity, resume, …). */
  scenario_overrides?: FrgScenarioOverride[];
  notes?: string[];
  now?: () => Date;
}

function isReadyState(state: string): boolean {
  return state === "ready" || state === "ready_to_deploy" || state === "merged" || state === "released";
}

/** Build scoreboard + overall pass from item outcomes and scenario overrides. */
export function computeFrgEvidence(input: ComputeFrgInput): FrgEvidence {
  const version = normalizeFrgVersion(input.version);
  const thresholds = { ...DEFAULT_FRG_THRESHOLDS, ...input.thresholds };
  const now = input.now ?? (() => new Date());
  const runId = input.run_id?.trim() || newFrgRunId(now);

  const perItem: FrgItemOutcome[] = input.items.map((it) => {
    const theme = it.blocker_theme ?? null;
    const blockerClass = theme ? classifyFrgBlocker(theme) : null;
    const readyClean =
      it.ready_clean ??
      (isReadyState(it.state) && blockerClass !== "engine-class");
    return {
      item_id: it.item_id,
      state: it.state,
      ready_clean: readyClean,
      blocker_theme: theme,
      blocker_class: blockerClass,
    };
  });

  let engine = 0;
  let product = 0;
  let human = 0;
  for (const it of perItem) {
    if (it.blocker_class === "engine-class") engine++;
    else if (it.blocker_class === "product-class") product++;
    else if (it.blocker_class === "human-authority") human++;
  }
  const classified = engine + product + human;
  const engineRate = classified === 0 ? null : engine / classified;
  const readyCleanCount = perItem.filter((i) => i.ready_clean).length;

  const overrideById = new Map(
    (input.scenario_overrides ?? []).map((s) => [s.id, s] as const),
  );

  const scenarios: FrgScenarioOutcome[] = FRG_SCENARIO_IDS.map((id) => {
    if (overrideById.has(id)) {
      const o = overrideById.get(id)!;
      return {
        id,
        status: o.status,
        detail: o.detail,
        observed: o.observed ?? null,
        threshold: o.threshold ?? null,
      };
    }
    if (id === "clean-item-throughput") {
      const ok = readyCleanCount >= thresholds.min_clean_ready_to_deploy;
      return {
        id,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${readyCleanCount} clean ready items meet K=${thresholds.min_clean_ready_to_deploy}`
          : `${readyCleanCount} clean ready items < K=${thresholds.min_clean_ready_to_deploy}`,
        observed: readyCleanCount,
        threshold: thresholds.min_clean_ready_to_deploy,
      };
    }
    if (id === "blocker-taxonomy") {
      const rate = engineRate;
      const ok = rate === null || rate <= thresholds.max_engine_class_rate;
      return {
        id,
        status: ok ? "pass" : "fail",
        detail:
          rate === null
            ? "no classified blockers; engine-class rate n/a (pass)"
            : ok
              ? `engine-class rate ${(rate * 100).toFixed(1)}% ≤ max ${(thresholds.max_engine_class_rate * 100).toFixed(0)}%`
              : `engine-class rate ${(rate * 100).toFixed(1)}% > max ${(thresholds.max_engine_class_rate * 100).toFixed(0)}%`,
        observed: rate,
        threshold: thresholds.max_engine_class_rate,
      };
    }
    return {
      id,
      status: "not_observed",
      detail: "not observed in this scoring pass (live pack or Layer A must cover)",
      observed: null,
      threshold: null,
    };
  });

  // Fail closed: any explicit fail scenario fails the gate; required core
  // scenarios (throughput + taxonomy) always computed above.
  const hardFail = scenarios.some((s) => s.status === "fail");
  const pass = !hardFail;

  return {
    schema_version: FRG_SCHEMA_VERSION,
    version,
    run_id: runId,
    pass,
    scenarios,
    scoreboard: {
      item_count: perItem.length,
      ready_clean_count: readyCleanCount,
      engine_class_count: engine,
      product_class_count: product,
      human_authority_count: human,
      engine_class_rate: engineRate,
      per_item: perItem,
    },
    thresholds,
    loop_run_id: input.loop_run_id ?? null,
    created_at: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
    notes: input.notes ?? [],
  };
}

/** Project FRG item inputs from a durable loop ledger. */
export function itemsFromLoopLedger(ledger: LoopLedger): FrgItemInput[] {
  const out: FrgItemInput[] = [];
  for (const [itemId, entry] of Object.entries(ledger.items ?? {})) {
    const state = entry.state as LoopItemState;
    const theme =
      entry.blocked_theme && isDurableBlockerClass(entry.blocked_theme)
        ? (entry.blocked_theme as DurableBlockerClass)
        : entry.blocked_theme ?? null;
    out.push({
      item_id: itemId,
      state,
      blocker_theme: theme,
      ready_clean: state === "ready" || state === "merged" || state === "released",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Driver CLI
// ---------------------------------------------------------------------------

export interface FactoryGateOpts {
  /** Target release version X.Y.Z (required). */
  version: string;
  repoDir: string;
  /** Score an existing durable loop run instead of starting a new one. */
  fromRun?: string;
  /** Label selector for starting a new pack loop (default: factory-gate). */
  label?: string[];
  /** Milestone selector alternative to label. */
  milestone?: string;
  /** Emit evidence JSON to stdout. */
  json?: boolean;
  /**
   * When set, skip live loop I/O and score this pre-built input (tests / offline
   * fixture scoring). Still writes evidence when `writeEvidence` is true.
   */
  scoreInput?: ComputeFrgInput;
  /** Persist evidence under the repo (default true). */
  writeEvidence?: boolean;
  /**
   * Start a durable loop for the pack (production path). Injected so unit tests
   * never spawn a real loop. Returns the loop run id when complete.
   */
  startLoop?: (args: {
    repoDir: string;
    label?: string[];
    milestone?: string;
  }) => Promise<{ loop_run_id: string }>;
  /**
   * Load ledger for a loop run id. Defaults unused when scoreInput provided.
   */
  loadLedger?: (loopRunId: string) => Promise<LoopLedger>;
  /** Load contract (optional; used for empty-depends_on stack honesty notes). */
  loadContract?: (loopRunId: string) => Promise<LoopContract | null>;
  /** Scenario overrides after ledger projection (live observations). */
  scenarioOverrides?: FrgScenarioOverride[];
  thresholds?: FrgThresholds;
  now?: () => Date;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export interface FactoryGateResult {
  evidence: FrgEvidence;
  evidencePath: string | null;
  latestPath: string | null;
  exitCode: number;
}

/**
 * Run the FRG driver: score (from ledger / fixture / started loop), write
 * evidence, return pass/fail. Does not merge or tag.
 */
export async function runFactoryGate(
  opts: FactoryGateOpts,
  fsDeps: FrgFsDeps = defaultFsDeps,
): Promise<FactoryGateResult> {
  const version = normalizeFrgVersion(opts.version);
  const stdout = opts.stdout ?? ((m) => process.stdout.write(`${m}\n`));
  const stderr = opts.stderr ?? ((m) => process.stderr.write(`${m}\n`));
  const writeEvidence = opts.writeEvidence !== false;

  let computeInput: ComputeFrgInput;

  if (opts.scoreInput) {
    computeInput = {
      ...opts.scoreInput,
      version,
      thresholds: opts.thresholds ?? opts.scoreInput.thresholds,
      now: opts.now ?? opts.scoreInput.now,
    };
  } else if (opts.fromRun) {
    if (!opts.loadLedger) {
      throw new Error(
        "pipeline factory-gate: --from-run requires a ledger loader (internal: loadLedger dep)",
      );
    }
    const ledger = await opts.loadLedger(opts.fromRun);
    const items = itemsFromLoopLedger(ledger);
    const notes: string[] = [
      `Projected from durable loop run ${opts.fromRun}`,
      "Scenario pack selection: reliability label/fixture pack (not full product milestone)",
    ];
    let overrides = [...(opts.scenarioOverrides ?? [])];
    if (opts.loadContract) {
      const contract = await opts.loadContract(opts.fromRun);
      if (contract) {
        const stackHonesty = detectEmptyDependsOnStackHonesty(contract, ledger);
        if (stackHonesty) overrides = mergeScenarioOverride(overrides, stackHonesty);
      }
    }
    // Default live scenarios that only the operator can assert fully may remain
    // not_observed; throughput + taxonomy are always computed from the ledger.
    computeInput = {
      version,
      loop_run_id: opts.fromRun,
      items,
      scenario_overrides: overrides,
      notes,
      thresholds: opts.thresholds,
      now: opts.now,
    };
  } else if (opts.startLoop) {
    stderr(
      `[pipeline factory-gate] starting durable loop for FRG pack (version ${version})…`,
    );
    const { loop_run_id } = await opts.startLoop({
      repoDir: opts.repoDir,
      label: opts.label ?? ["factory-gate"],
      milestone: opts.milestone,
    });
    if (!opts.loadLedger) {
      throw new Error(
        "pipeline factory-gate: startLoop path requires loadLedger to project outcomes",
      );
    }
    const ledger = await opts.loadLedger(loop_run_id);
    computeInput = {
      version,
      loop_run_id,
      items: itemsFromLoopLedger(ledger),
      scenario_overrides: opts.scenarioOverrides,
      notes: [
        `Live FRG loop ${loop_run_id}`,
        `Selector: label=${(opts.label ?? ["factory-gate"]).join(",")} milestone=${opts.milestone ?? "(none)"}`,
      ],
      thresholds: opts.thresholds,
      now: opts.now,
    };
  } else {
    throw new Error(
      "pipeline factory-gate: provide --from-run <loop-run-id> after a durable pack loop finishes.\n" +
        "  1) Start the pack via shipped durable loop (no second ledger):\n" +
        "       pipeline loop --label factory-gate\n" +
        "     (or --milestone <reliability-pack> — not the full product milestone)\n" +
        "  2) Score + write evidence:\n" +
        "       pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> [--json]\n" +
        "  See docs/factory-reliability-gate-runbook.md",
    );
  }

  const evidence = computeFrgEvidence(computeInput);
  let evidencePath: string | null = null;
  let latestPath: string | null = null;
  if (writeEvidence) {
    const written = await writeFrgEvidence(opts.repoDir, evidence, fsDeps);
    evidencePath = written.evidencePath;
    latestPath = written.latestPath;
  }

  if (opts.json) {
    stdout(JSON.stringify(evidence, null, 2));
  } else {
    stdout(`[pipeline factory-gate] version=${evidence.version} run_id=${evidence.run_id} pass=${evidence.pass}`);
    stdout(
      `  clean_ready=${evidence.scoreboard.ready_clean_count}/${evidence.thresholds.min_clean_ready_to_deploy} ` +
        `engine_rate=${
          evidence.scoreboard.engine_class_rate === null
            ? "n/a"
            : (evidence.scoreboard.engine_class_rate * 100).toFixed(1) + "%"
        } ` +
        `(max ${(evidence.thresholds.max_engine_class_rate * 100).toFixed(0)}%)`,
    );
    for (const s of evidence.scenarios) {
      if (s.status === "not_observed") continue;
      stdout(`  scenario ${s.id}: ${s.status} — ${s.detail}`);
    }
    if (evidencePath) stdout(`  evidence: ${evidencePath}`);
  }

  if (!evidence.pass) {
    stderr(
      `[pipeline factory-gate] FAIL — see docs/factory-reliability-gate-runbook.md`,
    );
  }

  return {
    evidence,
    evidencePath,
    latestPath,
    exitCode: evidence.pass ? 0 : 1,
  };
}

function mergeScenarioOverride(
  list: FrgScenarioOverride[],
  next: FrgScenarioOverride,
): FrgScenarioOverride[] {
  const filtered = list.filter((s) => s.id !== next.id);
  return [...filtered, next];
}

/**
 * Process honesty: empty depends_on items that still introduce stacked OpenSpec
 * changes across branches should warn/fail rather than silent omission.
 * Detects multi-item contracts where every item has empty depends_on but
 * contract notes / item ids imply independent OpenSpec stacking risk when more
 * than one item is active — we mark warn when ≥2 empty-depends_on items exist
 * (live pack should tighten with real branch observation).
 */
export function detectEmptyDependsOnStackHonesty(
  contract: LoopContract,
  _ledger: LoopLedger,
): FrgScenarioOverride | null {
  const items = contract.items ?? [];
  const emptyDeps = items.filter(
    (it) => !it.depends_on || it.depends_on.length === 0,
  );
  if (emptyDeps.length >= 2 && items.length >= 2) {
    return {
      id: "empty-depends-on-stack-honesty",
      status: "warn",
      detail:
        `${emptyDeps.length} items have empty depends_on while the pack has ${items.length} items — ` +
        `verify OpenSpec changes are not stacked across independent branches (process honesty)`,
      observed: emptyDeps.length,
      threshold: null,
    };
  }
  return {
    id: "empty-depends-on-stack-honesty",
    status: "pass",
    detail: "no empty-depends_on multi-item stacking signal",
    observed: emptyDeps.length,
    threshold: null,
  };
}

/** Layer A / Layer B ownership map (mirrored in the runbook). */
export const FRG_SCENARIO_OWNERSHIP: Record<
  FrgScenarioId,
  { layer_a: "test" | "waiver"; layer_b: boolean; pass_criteria: string }
> = {
  "capacity-blocked-retain": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: `With max worktrees low and blocked retain ≥ N=${DEFAULT_FRG_THRESHOLDS.capacity_stress_n}, next eligible item is not false-blocked as needs-human solely for capacity`,
  },
  "resume-mid-flight": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Supervisor interrupt/resume leaves live next_action; no permanent dead pr_opened strand",
  },
  "openspec-multi-change": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Archive result and residual still-active check agree (no skip then still-active block)",
  },
  "implement-lockfile-dirt": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Uncommitted lockfile after HEAD advanced is folded/cleaned; no human-block on known lock dirt at 0 attempts",
  },
  "local-docs-parity": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Docs/generator failures that fail CI fail before PR open / ready-to-deploy",
  },
  "clean-item-throughput": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: `≥ K=${DEFAULT_FRG_THRESHOLDS.min_clean_ready_to_deploy} easy items reach ready-to-deploy without engine-class block`,
  },
  "blocker-taxonomy": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: `engine-class rate ≤ ${DEFAULT_FRG_THRESHOLDS.max_engine_class_rate}`,
  },
  "pr-supersession": {
    layer_a: "waiver",
    layer_b: true,
    pass_criteria: "Stale second PR for same issue does not remain open after new head (#729)",
  },
  "release-plan-row": {
    layer_a: "waiver",
    layer_b: true,
    pass_criteria: "Release-cut plan-row present or scaffolded; tag path documented (#730/#449)",
  },
  "empty-depends-on-stack-honesty": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Empty depends_on items that stack OpenSpec across branches produce warn or fail",
  },
};

/** Explicit Layer A waivers (scenario id → tracking issue). No silent gaps. */
export const FRG_LAYER_A_WAIVERS: Partial<Record<FrgScenarioId, string>> = {
  "pr-supersession": "#729",
  "release-plan-row": "#730",
};
