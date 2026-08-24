// Production engine pin (#762): two-track factory self-hosting.
//
// The factory maintains a machine-readable pin for the last FRG-passed release
// that has been promoted into production dogfood. Ordinary production runs
// execute that pin (track `pinned`); FRG Layer B / eval soaks use track
// `candidate`. Promote defaults to requiring a production-quality FRG pin
// (real run_id, non-null evidence path). allowWithoutFrg / --skip-frg may
// write a marked non-production-quality pin (`no-frg-<version>` + null
// evidence). Never merges or tags.
//
// The live pin lives on the factory control checkout
// (`.agent-pipeline/production-engine-pin.json`), not inside the frozen skill
// install package — promote/rollback must not require a new engine tag.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  FRG_EVIDENCE_ROOT_REL,
  frgLatestPath,
  lookupFrgPass,
  normalizeFrgVersion,
  type FrgEvidence,
  type FrgFsDeps,
  type FrgLookupResult,
} from "./factory-reliability-gate.ts";

// ---------------------------------------------------------------------------
// Constants / schema
// ---------------------------------------------------------------------------

/** Repo-relative path of the live production pin (single-source; commitable). */
export const PRODUCTION_ENGINE_PIN_REL = path.join(
  ".agent-pipeline",
  "production-engine-pin.json",
);

/** Env override for exotic layouts (absolute path). */
export const PRODUCTION_PIN_ENV = "AGENT_PIPELINE_PRODUCTION_PIN";

export const PRODUCTION_PIN_SCHEMA_VERSION = 1;

/** Skip-escape `frg_run_id` prefix. Not a production-quality FRG pass. */
export const NO_FRG_RUN_ID_PREFIX = "no-frg-";

/**
 * Installer receipt written next to the managed-skill marker by `install.mjs`.
 * Filename is skill-root relative (parent of `core/`). Presence of a receipt
 * whose `tag` matches the production pin is required to claim track `pinned`.
 */
export const INSTALL_RECEIPT_FILENAME = ".pipeline-install-receipt.json";

export const INSTALL_RECEIPT_SCHEMA_VERSION = 1;

export type EngineTrack = "pinned" | "candidate";

export type EngineTrackIntent = "pinned" | "candidate";

export type GitShaSource = "operator" | "promote-arg" | "frg-note" | "unknown";

/** Machine-readable installer receipt (tag-install provenance). */
export interface InstallReceipt {
  schema_version: number;
  version: string;
  tag: string;
  installed_at?: string;
}

/**
 * Verifiable install provenance for pinned-track enforcement.
 * Version equality alone is never sufficient to claim track `pinned`.
 */
export type PinInstallProvenance =
  | { kind: "tag_install"; tag: string; version?: string | null }
  | { kind: "working_tree"; detail?: string }
  | { kind: "missing"; detail?: string };

/** Prior pin snapshot retained for rollback (one level). */
export interface ProductionEnginePinPrevious {
  schema_version: number;
  version: string;
  tag: string;
  git_sha?: string | null;
  git_sha_source?: GitShaSource | null;
  frg_run_id: string;
  frg_evidence_path?: string | null;
  promoted_at: string;
}

export interface ProductionEnginePin {
  schema_version: number;
  version: string;
  tag: string;
  git_sha?: string | null;
  git_sha_source?: GitShaSource | null;
  frg_run_id: string;
  frg_evidence_path?: string | null;
  promoted_at: string;
  previous?: ProductionEnginePinPrevious | null;
}

// ---------------------------------------------------------------------------
// Deps (injected I/O — no real network/git/subprocess in unit tests)
// ---------------------------------------------------------------------------

export interface ProductionPinFsDeps {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  mkdir(p: string, opts: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const defaultProductionPinFsDeps: ProductionPinFsDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  rename: (from, to) => fsp.rename(from, to),
};

export interface LookupFrgPassFn {
  (repoDir: string, version: string, deps?: FrgFsDeps): Promise<FrgLookupResult>;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the production pin artifact.
 * Precedence: overridePath → env AGENT_PIPELINE_PRODUCTION_PIN →
 * `<repoDir>/.agent-pipeline/production-engine-pin.json`.
 * Pin is never read from the install package root as live authority.
 */
export function productionPinPath(
  repoDir: string,
  overridePath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof overridePath === "string" && overridePath.trim()) {
    return path.resolve(overridePath.trim());
  }
  const fromEnv = env[PRODUCTION_PIN_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return path.resolve(fromEnv.trim());
  }
  return path.join(repoDir, PRODUCTION_ENGINE_PIN_REL);
}

/** Absolute factory pin file: `<factoryControlCheckout>/.agent-pipeline/production-engine-pin.json`. */
export function defaultFactoryProductionPinPath(factoryControlCheckout: string): string {
  return path.resolve(factoryControlCheckout, PRODUCTION_ENGINE_PIN_REL);
}

/**
 * Factory ship / factory launcher pin export (#1127).
 * An operator-set `AGENT_PIPELINE_PRODUCTION_PIN` is left unchanged.
 * When unset/empty, default is the factory control checkout pin file.
 */
export function resolveExportedFactoryProductionPin(opts: {
  existing?: string | null;
  factoryControlCheckout: string;
}): string {
  const existing = typeof opts.existing === "string" ? opts.existing.trim() : "";
  if (existing) return existing;
  return defaultFactoryProductionPinPath(opts.factoryControlCheckout);
}

/**
 * Distinctive suffix of the retired Hermes-state pin file. Not live pin
 * authority. Host supervisor SKILL / env templates MUST NOT default or
 * document this path as a live pin (#1183).
 */
export const HERMES_STATE_PRODUCTION_PIN_MARKER =
  "hermes-factory/production-engine-pin.json";

/**
 * True when text defaults or documents the Hermes-state production pin path
 * (SKILL `${VAR:-hermes-state}` or env.example live value).
 */
export function textDefaultsOrDocumentsHermesStateProductionPin(text: string): boolean {
  return text.includes(HERMES_STATE_PRODUCTION_PIN_MARKER);
}

// ---------------------------------------------------------------------------
// Version / tag helpers
// ---------------------------------------------------------------------------

/** Normalize optional leading `v` (same spirit as normalizeFrgVersion, but
 *  soft: returns null when invalid rather than throwing). */
export function normalizePinVersion(version: string): string | null {
  try {
    return normalizeFrgVersion(version);
  } catch {
    return null;
  }
}

export function tagForVersion(version: string): string {
  const v = normalizePinVersion(version) ?? version.trim().replace(/^v/i, "");
  return `v${v}`;
}

export function versionsMatch(a: string, b: string): boolean {
  const na = normalizePinVersion(a);
  const nb = normalizePinVersion(b);
  if (na && nb) return na === nb;
  return a.trim().replace(/^v/i, "") === b.trim().replace(/^v/i, "");
}

/** True when two tags name the same release (optional leading `v`). */
export function tagsMatch(a: string, b: string): boolean {
  return versionsMatch(a, b);
}

// ---------------------------------------------------------------------------
// Install receipt / provenance (#762 review: version-only is insufficient)
// ---------------------------------------------------------------------------

/**
 * Parse an installer receipt. Throws on invalid shape.
 * Soft-load helper `tryParseInstallReceipt` never throws.
 */
export function parseInstallReceipt(raw: unknown): InstallReceipt {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("install receipt must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== INSTALL_RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `install receipt schema_version must be ${INSTALL_RECEIPT_SCHEMA_VERSION}`,
    );
  }
  if (typeof o.version !== "string" || !o.version.trim()) {
    throw new Error("install receipt.version must be a non-empty string");
  }
  if (typeof o.tag !== "string" || !o.tag.trim()) {
    throw new Error("install receipt.tag must be a non-empty string");
  }
  const version = o.version.trim();
  const tag = o.tag.trim();
  if (!versionsMatch(version, tag)) {
    throw new Error(
      `install receipt version ${version} does not match tag ${tag}`,
    );
  }
  const receipt: InstallReceipt = {
    schema_version: INSTALL_RECEIPT_SCHEMA_VERSION,
    version,
    tag,
  };
  if (typeof o.installed_at === "string" && o.installed_at.trim()) {
    receipt.installed_at = o.installed_at.trim();
  }
  return receipt;
}

export function tryParseInstallReceipt(text: string | null | undefined): InstallReceipt | null {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return parseInstallReceipt(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * Resolve skill-root install provenance from an optional receipt body.
 * Pure: no I/O. Callers load the receipt text via injected read seams.
 *
 * Precedence (fail-closed for production attribution):
 * - Explicit working-tree signal → `working_tree` even when a receipt file is
 *   present (copied/stale receipts must not reclassify a control checkout as a
 *   tag install).
 * - Valid receipt without working-tree signal → `tag_install`
 * - Missing/invalid receipt → `missing` (fail closed under pinned intent)
 */
export function resolveInstallProvenance(input: {
  receiptText?: string | null;
  /**
   * When true, classify as working-tree even if a receipt parses. Control-repo
   * and managed-worktree engines are never tag installs.
   */
  isWorkingTree?: boolean;
  workingTreeDetail?: string;
}): PinInstallProvenance {
  // Working-tree detection is authoritative: a receipt adjacent to a control
  // checkout/worktree (copied or stale) must not masquerade as tag install.
  if (input.isWorkingTree) {
    return {
      kind: "working_tree",
      detail: input.workingTreeDetail ?? "engine root is a working-tree checkout",
    };
  }
  const receipt = tryParseInstallReceipt(input.receiptText ?? null);
  if (receipt) {
    return {
      kind: "tag_install",
      tag: receipt.tag,
      version: receipt.version,
    };
  }
  return {
    kind: "missing",
    detail:
      typeof input.receiptText === "string" && input.receiptText.trim()
        ? "install receipt present but unreadable/invalid"
        : "install receipt absent",
  };
}

/**
 * True when provenance proves a tag install matching the production pin tag.
 * Version match alone is never sufficient.
 */
export function pinInstallProvenanceMatches(
  provenance: PinInstallProvenance | null | undefined,
  pin: ProductionEnginePin,
): boolean {
  if (!provenance || provenance.kind !== "tag_install") return false;
  return tagsMatch(provenance.tag, pin.tag);
}

/**
 * Absolute path of the install receipt for a skill tree whose `core/` root is
 * `engineRoot` (or install root passed as core path).
 */
export function installReceiptPath(engineRoot: string): string {
  // engine/core root → skill root (parent) → receipt
  return path.join(path.dirname(engineRoot), INSTALL_RECEIPT_FILENAME);
}

// ---------------------------------------------------------------------------
// Parse / validate
// ---------------------------------------------------------------------------

export type PinLoadResult =
  | { kind: "ok"; pin: ProductionEnginePin; path: string }
  | { kind: "missing"; path: string }
  | { kind: "unreadable"; path: string; detail: string }
  | { kind: "invalid"; path: string; detail: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** True when `run_id` / `frg_run_id` is the explicit skip-escape marker. */
export function isNoFrgRunId(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith(NO_FRG_RUN_ID_PREFIX);
}

/**
 * True when a pin (or FRG evidence fields) is production-quality: real
 * `frg_run_id` (not `no-frg-*`) and a non-null, non-empty evidence path.
 * Parse stays permissive; this predicate is the policy classifier.
 */
export function isProductionQualityPin(pin: {
  frg_run_id?: string | null;
  run_id?: string | null;
  frg_evidence_path?: string | null;
} | null | undefined): boolean {
  if (!pin) return false;
  const runId =
    typeof pin.frg_run_id === "string"
      ? pin.frg_run_id
      : typeof pin.run_id === "string"
        ? pin.run_id
        : "";
  if (!runId.trim() || isNoFrgRunId(runId)) return false;
  const evidence = pin.frg_evidence_path;
  return typeof evidence === "string" && evidence.trim().length > 0;
}

function isGitShaSource(v: unknown): v is GitShaSource {
  return v === "operator" || v === "promote-arg" || v === "frg-note" || v === "unknown";
}

function parsePrevious(raw: unknown): ProductionEnginePinPrevious | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("previous must be an object or null");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.schema_version !== "number" || !Number.isInteger(o.schema_version)) {
    throw new Error("previous.schema_version must be an integer");
  }
  if (!isNonEmptyString(o.version)) throw new Error("previous.version is required");
  if (!isNonEmptyString(o.tag)) throw new Error("previous.tag is required");
  if (!isNonEmptyString(o.frg_run_id)) throw new Error("previous.frg_run_id is required");
  if (!isNonEmptyString(o.promoted_at)) throw new Error("previous.promoted_at is required");
  const version = normalizePinVersion(o.version);
  if (!version) throw new Error(`previous.version invalid: ${o.version}`);
  const prev: ProductionEnginePinPrevious = {
    schema_version: o.schema_version,
    version,
    tag: o.tag.trim(),
    frg_run_id: o.frg_run_id.trim(),
    promoted_at: o.promoted_at.trim(),
  };
  if (o.git_sha !== undefined && o.git_sha !== null) {
    if (!isNonEmptyString(o.git_sha)) throw new Error("previous.git_sha must be a non-empty string or null");
    prev.git_sha = o.git_sha.trim();
  } else if (o.git_sha === null) {
    prev.git_sha = null;
  }
  if (o.git_sha_source !== undefined && o.git_sha_source !== null) {
    if (!isGitShaSource(o.git_sha_source)) throw new Error("previous.git_sha_source invalid");
    prev.git_sha_source = o.git_sha_source;
  } else if (o.git_sha_source === null) {
    prev.git_sha_source = null;
  }
  if (o.frg_evidence_path !== undefined && o.frg_evidence_path !== null) {
    if (typeof o.frg_evidence_path !== "string") throw new Error("previous.frg_evidence_path must be a string or null");
    prev.frg_evidence_path = o.frg_evidence_path;
  } else if (o.frg_evidence_path === null) {
    prev.frg_evidence_path = null;
  }
  return prev;
}

/** Parse and validate pin JSON text. Throws on structural invalidity. */
export function parseProductionEnginePin(text: string): ProductionEnginePin {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`production pin JSON is not parseable: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("production pin must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.schema_version !== "number" || !Number.isInteger(o.schema_version)) {
    throw new Error("schema_version must be an integer");
  }
  if (o.schema_version !== PRODUCTION_PIN_SCHEMA_VERSION) {
    throw new Error(
      `unsupported production pin schema_version ${o.schema_version} (expected ${PRODUCTION_PIN_SCHEMA_VERSION})`,
    );
  }
  if (!isNonEmptyString(o.version)) throw new Error("version is required");
  if (!isNonEmptyString(o.tag)) throw new Error("tag is required");
  if (!isNonEmptyString(o.frg_run_id)) throw new Error("frg_run_id is required");
  if (!isNonEmptyString(o.promoted_at)) throw new Error("promoted_at is required");

  const version = normalizePinVersion(o.version);
  if (!version) throw new Error(`version invalid: ${o.version}`);

  const pin: ProductionEnginePin = {
    schema_version: o.schema_version,
    version,
    tag: o.tag.trim(),
    frg_run_id: o.frg_run_id.trim(),
    promoted_at: o.promoted_at.trim(),
  };

  if (o.git_sha !== undefined && o.git_sha !== null) {
    if (!isNonEmptyString(o.git_sha)) throw new Error("git_sha must be a non-empty string or null");
    pin.git_sha = o.git_sha.trim();
  } else if (o.git_sha === null) {
    pin.git_sha = null;
  }

  if (o.git_sha_source !== undefined && o.git_sha_source !== null) {
    if (!isGitShaSource(o.git_sha_source)) throw new Error("git_sha_source invalid");
    pin.git_sha_source = o.git_sha_source;
  } else if (o.git_sha_source === null) {
    pin.git_sha_source = null;
  }

  if (o.frg_evidence_path !== undefined && o.frg_evidence_path !== null) {
    if (typeof o.frg_evidence_path !== "string") throw new Error("frg_evidence_path must be a string or null");
    pin.frg_evidence_path = o.frg_evidence_path;
  } else if (o.frg_evidence_path === null) {
    pin.frg_evidence_path = null;
  }

  if ("previous" in o) {
    pin.previous = parsePrevious(o.previous);
  }

  return pin;
}

/** Load the production pin from repoDir (or override). Injectable readFile. */
export async function resolveProductionPin(opts: {
  repoDir: string;
  readTextFile: (p: string) => Promise<string | null>;
  overridePath?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<PinLoadResult> {
  const pinPath = productionPinPath(opts.repoDir, opts.overridePath, opts.env ?? process.env);
  let text: string | null;
  try {
    text = await opts.readTextFile(pinPath);
  } catch (err) {
    return { kind: "unreadable", path: pinPath, detail: (err as Error).message };
  }
  if (text === null) {
    return { kind: "missing", path: pinPath };
  }
  try {
    const pin = parseProductionEnginePin(text);
    return { kind: "ok", pin, path: pinPath };
  } catch (err) {
    return { kind: "invalid", path: pinPath, detail: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Track classification
// ---------------------------------------------------------------------------

export interface ClassifyEngineTrackInput {
  /** Explicit operator/config intent. Required — never invent from version alone. */
  intent: EngineTrackIntent;
  /** Running engine version (e.g. from package.json / VERSION). */
  runningVersion: string | null | undefined;
  /** Loaded pin, or null when missing/unreadable. */
  pin: ProductionEnginePin | null;
  /**
   * Installer provenance (receipt / working-tree). Required for coherent
   * `pinned` — version equality alone never claims the production track.
   * When omitted, treated as missing provenance (fail closed for pinned).
   */
  installProvenance?: PinInstallProvenance | null;
}

export interface ClassifyEngineTrackResult {
  track: EngineTrack;
  pin_version: string | null;
  running_version: string | null;
  pin_match: boolean;
  /**
   * Coherent pinned production posture: intent pinned AND pin present AND
   * versions match AND install provenance proves a pin-tag install.
   */
  coherent_pinned: boolean;
  reason: string;
}

/**
 * Classify the engine track from intent + pin + running version + provenance.
 * Pure: no I/O. Does not invent track from version alone when intent is absent
 * (caller must supply intent). Version match without install provenance is
 * never coherent pinned.
 */
export function classifyEngineTrack(input: ClassifyEngineTrackInput): ClassifyEngineTrackResult {
  const running =
    typeof input.runningVersion === "string" && input.runningVersion.trim()
      ? input.runningVersion.trim()
      : null;
  const pinVersion = input.pin?.version ?? null;
  const pinMatch =
    pinVersion !== null && running !== null && versionsMatch(pinVersion, running);
  const provenance = input.installProvenance ?? { kind: "missing" as const, detail: "install provenance not supplied" };

  if (input.intent === "candidate") {
    return {
      track: "candidate",
      pin_version: pinVersion,
      running_version: running,
      pin_match: pinMatch,
      coherent_pinned: false,
      reason: pinMatch
        ? "candidate intent with pin-matching install (intentional soak of pin-equal build)"
        : "candidate intent (FRG/eval soak or explicit --engine-track candidate)",
    };
  }

  // pinned intent
  if (!input.pin) {
    return {
      track: "candidate",
      pin_version: null,
      running_version: running,
      pin_match: false,
      coherent_pinned: false,
      reason: "pinned intent but production pin missing or unreadable",
    };
  }
  if (!running) {
    return {
      track: "candidate",
      pin_version: pinVersion,
      running_version: null,
      pin_match: false,
      coherent_pinned: false,
      reason: "pinned intent but running engine version is unknown",
    };
  }
  if (!pinMatch) {
    return {
      track: "candidate",
      pin_version: pinVersion,
      running_version: running,
      pin_match: false,
      coherent_pinned: false,
      reason: `pinned intent but install v${running} ≠ pin v${pinVersion}`,
    };
  }
  if (!pinInstallProvenanceMatches(provenance, input.pin)) {
    const why =
      provenance.kind === "working_tree"
        ? provenance.detail ?? "working-tree engine (not a tag install)"
        : provenance.kind === "tag_install"
          ? `install receipt tag ${provenance.tag} ≠ pin tag ${input.pin.tag}`
          : provenance.detail ?? "install receipt missing or unverifiable";
    return {
      track: "candidate",
      pin_version: pinVersion,
      running_version: running,
      pin_match: true,
      coherent_pinned: false,
      reason: `pinned intent + version match but unverified pin install: ${why}`,
    };
  }
  return {
    track: "pinned",
    pin_version: pinVersion,
    running_version: running,
    pin_match: true,
    coherent_pinned: true,
    reason: `install matches production pin v${pinVersion} with tag-install provenance ${input.pin.tag}`,
  };
}

// ---------------------------------------------------------------------------
// Track intent resolution (CLI > config > factory-scoped default)
// ---------------------------------------------------------------------------

/**
 * GitHub owner/name of this engine's origin repository.
 * Not factory-control identity. Two-track pin policy and factory-pin
 * self-dogfood use {@link isFactoryControlCheckout} (live `REPO_DIR` /
 * `AGENT_PIPELINE_FACTORY_CONTROL`, or a managed worktree of that root).
 */
export const FACTORY_CONTROL_REPO = "accidental-hedge-fund/agent-pipeline";

/** Env override for the factory control checkout root used as pin authority. */
export const FACTORY_CONTROL_DIR_ENV = "AGENT_PIPELINE_FACTORY_CONTROL";

/**
 * Factory-plane live control checkout env (Tugboat / ship composer `REPO_DIR`).
 * A positive identity signal only when it resolves to this checkout (or a
 * managed worktree of that root). Unset `REPO_DIR` is not factory-control.
 */
export const FACTORY_PLANE_REPO_DIR_ENV = "REPO_DIR";

/** Default managed-worktree directory name under a checkout. */
export const DEFAULT_MANAGED_WORKTREE_ROOT = ".worktrees";

export type TrackCommandFamily =
  | "factory-gate"
  | "evals"
  | "loop"
  | "single"
  | "advance"
  | "doctor"
  | "train"
  | "other";

/**
 * True when `candidateDir` is `controlRoot` or a managed worktree of that
 * root (`<controlRoot>/.worktrees/<slug>`). Pure path comparison; no I/O.
 */
export function isSameOrManagedWorktreeOf(
  candidateDir: string,
  controlRoot: string,
  worktreeRootRel: string = DEFAULT_MANAGED_WORKTREE_ROOT,
): boolean {
  const candidate = path.resolve(candidateDir);
  const control = path.resolve(controlRoot);
  if (candidate === control) return true;
  const rel = worktreeRootRel.trim() || DEFAULT_MANAGED_WORKTREE_ROOT;
  const wtRoot = path.resolve(control, rel);
  if (candidate === wtRoot) return true;
  const prefix = wtRoot.endsWith(path.sep) ? wtRoot : wtRoot + path.sep;
  return candidate.startsWith(prefix);
}

function firstNonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Live factory-control authority root for this checkout, or null.
 *
 * Returns the matching signal directory (`AGENT_PIPELINE_FACTORY_CONTROL`,
 * `factoryControlDir`, or factory-plane `REPO_DIR`) when `repoDir` is that
 * directory or a managed worktree of it. The return value is always the
 * control root, never the nested worktree path.
 *
 * Never sufficient: GitHub owner/name, `package.json` `repository`, leftover
 * `.agent-pipeline/production-engine-pin.json`, Hermes-state pin, or path-name
 * heuristics (`ap-main-control`, `*factory-control*`).
 */
export function resolveFactoryControlRoot(opts: {
  repoDir: string;
  env?: NodeJS.ProcessEnv;
  factoryControlDir?: string | null;
  worktreeRoot?: string;
}): string | null {
  const env = opts.env ?? process.env;
  const repoDir = typeof opts.repoDir === "string" ? opts.repoDir.trim() : "";
  if (!repoDir) return null;
  const worktreeRoot = opts.worktreeRoot?.trim() || DEFAULT_MANAGED_WORKTREE_ROOT;

  const signals: string[] = [];
  const fromArg =
    typeof opts.factoryControlDir === "string" ? opts.factoryControlDir.trim() : "";
  if (fromArg) signals.push(fromArg);
  const fromFactoryEnv = firstNonEmptyEnv(env, FACTORY_CONTROL_DIR_ENV);
  if (fromFactoryEnv) signals.push(fromFactoryEnv);
  const fromRepoDir = firstNonEmptyEnv(env, FACTORY_PLANE_REPO_DIR_ENV);
  if (fromRepoDir) signals.push(fromRepoDir);

  for (const signal of signals) {
    if (isSameOrManagedWorktreeOf(repoDir, signal, worktreeRoot)) {
      return path.resolve(signal);
    }
  }
  return null;
}

/**
 * Checkout-role factory-control identity for two-track pin policy.
 *
 * True when {@link resolveFactoryControlRoot} returns a root: `repoDir` is the
 * live factory control checkout identified by `AGENT_PIPELINE_FACTORY_CONTROL`
 * or factory-plane `REPO_DIR` (that directory, or a managed worktree of that
 * directory). Optional `factoryControlDir` is the same signal as the
 * factory-control env.
 */
export function isFactoryControlCheckout(opts: {
  repoDir: string;
  env?: NodeJS.ProcessEnv;
  factoryControlDir?: string | null;
  worktreeRoot?: string;
}): boolean {
  return resolveFactoryControlRoot(opts) !== null;
}

/**
 * True when `repo` matches this engine's GitHub origin owner/name.
 * Not factory-control identity for two-track pin policy or factory-pin
 * self-dogfood. Use {@link isFactoryControlCheckout}.
 */
export function isFactoryControlRepo(repo: string | null | undefined): boolean {
  if (typeof repo !== "string") return false;
  const n = repo.trim().toLowerCase();
  return n.length > 0 && n === FACTORY_CONTROL_REPO.toLowerCase();
}

/**
 * Extract owner/name from a package.json `repository` field when it names a
 * GitHub repo. Pure: no I/O. Used to identify the factory control checkout
 * without network/gh for factory-pin authority checks.
 */
export function ownerRepoFromPackageRepository(
  repository: unknown,
): string | null {
  let raw: string | null = null;
  if (typeof repository === "string" && repository.trim()) {
    raw = repository.trim();
  } else if (
    repository &&
    typeof repository === "object" &&
    !Array.isArray(repository) &&
    typeof (repository as { url?: unknown }).url === "string"
  ) {
    const url = (repository as { url: string }).url.trim();
    if (url) raw = url;
  }
  if (!raw) return null;

  // github:owner/name
  const ghColon = /^github:([^/]+\/[^/#?]+)/i.exec(raw);
  if (ghColon) return ghColon[1]!.replace(/\.git$/i, "");

  // https://github.com/owner/name(.git)? or git+https://... or git@github.com:owner/name.git
  const m =
    /(?:github\.com[:/]|github:)([^/]+\/[^/#?\s]+)/i.exec(raw) ??
    null;
  if (!m) return null;
  return m[1]!.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * True when package.json `repository` names this engine's GitHub origin.
 * Not factory-control identity and not factory-pin self-dogfood. Use
 * {@link isFactoryControlCheckout}. Package `name` alone is not sufficient.
 */
export function isFactoryControlPackageMeta(pkg: {
  name?: unknown;
  repository?: unknown;
}): boolean {
  const fromRepo = ownerRepoFromPackageRepository(pkg.repository);
  return isFactoryControlRepo(fromRepo);
}

/** Result of resolving factory-pin CLI authority (show/init/promote/rollback). */
export type FactoryPinAuthorityResult =
  | {
      ok: true;
      /** Directory used as pin/FRG repoDir for factory-pin operations. */
      repoDir: string;
      /** Absolute pin path override when configured; otherwise null. */
      pinPathOverride: string | null;
      source:
        | "pin-path-override"
        | "factory-control-env"
        | "factory-control-arg"
        | "factory-plane-repo-dir"
        | "self-dogfood";
    }
  | {
      ok: false;
      code: "not_factory_pin_authority";
      message: string;
      remediation: string;
    };

/**
 * Resolve where `pipeline factory-pin` may read/write the production pin.
 * Pure: no I/O.
 *
 * Product repositories are refused by default. Authority requires one of:
 * - explicit pin path (`pinPathOverride` / `AGENT_PIPELINE_PRODUCTION_PIN`)
 * - factory control dir (`factoryControlDir` / `AGENT_PIPELINE_FACTORY_CONTROL`)
 * - factory-plane `REPO_DIR` when the invocation is that checkout or a
 *   managed worktree of it (authority root is `REPO_DIR`, not the worktree)
 * - self-dogfood (`targetIsFactoryControl` on the invocation checkout)
 *
 * When a pin-path override is set without factory-control dir, `repoDir` stays
 * the invocation dir only for FRG lookup pathing; the pin file path still comes
 * from the override via {@link productionPinPath}.
 */
export function resolveFactoryPinAuthority(opts: {
  invocationRepoDir: string;
  /** True when invocation checkout is the live factory control checkout. */
  targetIsFactoryControl?: boolean;
  factoryControlDir?: string | null;
  pinPathOverride?: string | null;
  env?: NodeJS.ProcessEnv;
}): FactoryPinAuthorityResult {
  const env = opts.env ?? process.env;
  const pinOverride = hasProductionPinPathOverride(opts.pinPathOverride, env)
    ? productionPinPath(opts.invocationRepoDir, opts.pinPathOverride, env)
    : null;

  const fromEnv = env[FACTORY_CONTROL_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return {
      ok: true,
      repoDir: path.resolve(fromEnv.trim()),
      pinPathOverride: pinOverride,
      source: "factory-control-env",
    };
  }
  if (typeof opts.factoryControlDir === "string" && opts.factoryControlDir.trim()) {
    return {
      ok: true,
      repoDir: path.resolve(opts.factoryControlDir.trim()),
      pinPathOverride: pinOverride,
      source: "factory-control-arg",
    };
  }
  const fromPlaneRepoDir = firstNonEmptyEnv(env, FACTORY_PLANE_REPO_DIR_ENV);
  if (
    fromPlaneRepoDir &&
    isSameOrManagedWorktreeOf(opts.invocationRepoDir, fromPlaneRepoDir)
  ) {
    return {
      ok: true,
      repoDir: path.resolve(fromPlaneRepoDir),
      pinPathOverride: pinOverride,
      source: "factory-plane-repo-dir",
    };
  }
  if (pinOverride) {
    // Explicit pin file authority without a control dir: allow the pin path,
    // keep FRG lookups relative to the invocation dir (operator responsibility).
    return {
      ok: true,
      repoDir: opts.invocationRepoDir,
      pinPathOverride: pinOverride,
      source: "pin-path-override",
    };
  }
  if (opts.targetIsFactoryControl) {
    return {
      ok: true,
      repoDir: opts.invocationRepoDir,
      pinPathOverride: null,
      source: "self-dogfood",
    };
  }
  return {
    ok: false,
    code: "not_factory_pin_authority",
    message:
      `factory-pin refuses to use ${opts.invocationRepoDir} as production pin authority ` +
      `(not the factory control checkout and no pin-authority override)`,
    remediation:
      `Run factory-pin from the live factory control checkout ` +
      `(${FACTORY_PLANE_REPO_DIR_ENV} / ${FACTORY_CONTROL_DIR_ENV}), ` +
      `or set ${FACTORY_CONTROL_DIR_ENV}=<factory-control-root>, ` +
      `or set ${PRODUCTION_PIN_ENV}=<absolute-pin.json path>. ` +
      `Do not write a product-local production pin. ` +
      `GitHub owner/name is not factory-pin authority.`,
  };
}

/** Result of resolving the production-pin authority directory. */
export type PinAuthorityResult =
  | { ok: true; dir: string }
  | {
      ok: false;
      code: "missing_factory_control";
      message: string;
      remediation: string;
    };

/**
 * True when an absolute pin-file override is configured (config path or env).
 * When set, pin resolution does not need a factory-control checkout directory.
 */
export function hasProductionPinPathOverride(
  overridePath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof overridePath === "string" && overridePath.trim()) return true;
  const fromEnv = env[PRODUCTION_PIN_ENV];
  return typeof fromEnv === "string" && fromEnv.trim().length > 0;
}

/**
 * Directory used as production-pin authority (factory control checkout).
 * Precedence: env AGENT_PIPELINE_FACTORY_CONTROL → factoryControlDir arg →
 * factory-plane REPO_DIR when the target is that checkout or a managed
 * worktree of it (returns the REPO_DIR root, not the worktree) →
 * targetRepoDir when targetIsFactoryControl or allowTargetFallback.
 * Pin file override (production_engine_pin_path / AGENT_PIPELINE_PRODUCTION_PIN)
 * still wins inside {@link productionPinPath} and does not require this dir.
 *
 * Active pinned intent on a non-factory target MUST NOT fall back to the
 * product repo_dir: pass allowTargetFallback: false and either configure
 * factory control / env or an explicit pin path (see
 * {@link hasProductionPinPathOverride}).
 */
export function resolvePinAuthorityDir(opts: {
  targetRepoDir: string;
  factoryControlDir?: string | null;
  env?: NodeJS.ProcessEnv;
  /** True when target is the live factory control checkout (self-dogfood). */
  targetIsFactoryControl?: boolean;
  /**
   * When false, refuse non-factory target fallback. Use for active two-track
   * intent so a product checkout cannot supply pin authority by accident.
   * Default true preserves inactive/probe behavior for ordinary hosts.
   */
  allowTargetFallback?: boolean;
}): PinAuthorityResult {
  const env = opts.env ?? process.env;
  const fromEnv = env[FACTORY_CONTROL_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { ok: true, dir: path.resolve(fromEnv.trim()) };
  }
  if (typeof opts.factoryControlDir === "string" && opts.factoryControlDir.trim()) {
    return { ok: true, dir: path.resolve(opts.factoryControlDir.trim()) };
  }
  const fromPlaneRepoDir = firstNonEmptyEnv(env, FACTORY_PLANE_REPO_DIR_ENV);
  if (
    fromPlaneRepoDir &&
    isSameOrManagedWorktreeOf(opts.targetRepoDir, fromPlaneRepoDir)
  ) {
    return { ok: true, dir: path.resolve(fromPlaneRepoDir) };
  }
  if (opts.targetIsFactoryControl || opts.allowTargetFallback !== false) {
    return { ok: true, dir: opts.targetRepoDir };
  }
  return {
    ok: false,
    code: "missing_factory_control",
    message:
      "production pin authority is not configured for this non-factory target",
    remediation:
      `Set ${FACTORY_CONTROL_DIR_ENV} to the factory control checkout root, ` +
      `or set production_engine_pin_path / ${PRODUCTION_PIN_ENV} to the pin JSON path. ` +
      `Do not place a product-local pin as production authority.`,
  };
}

/**
 * Resolved two-track intent for a command.
 * - `pinned` | `candidate` — factory two-track policy is active
 * - `null` — policy inactive (ordinary non-factory advance/doctor); no pin
 *   enforcement and no claim of track identity
 */
export type ResolvedEngineTrackIntent = EngineTrackIntent | null;

/**
 * Resolve engine track intent.
 * Precedence: force-candidate / factory-gate → explicit CLI → config →
 * command family defaults.
 *
 * Command defaults:
 * - factory-gate → always candidate (Layer B soak; not overridable to pinned)
 * - evals → candidate
 * - loop / single / advance / doctor / train / other → **pinned only when
 *   factory-control checkout-role context** (live `REPO_DIR` /
 *   `AGENT_PIPELINE_FACTORY_CONTROL`); otherwise `null` so ordinary
 *   product-repo advances and non-control clones do not require a production pin.
 */
export function resolveEngineTrackIntent(opts: {
  command: TrackCommandFamily;
  cliTrack?: EngineTrackIntent | null;
  configTrack?: EngineTrackIntent | null;
  /** When true (factory-gate), force candidate regardless of CLI/config. */
  forceCandidate?: boolean;
  /**
   * True when this invocation is the live factory control checkout
   * ({@link isFactoryControlCheckout}). When false/omitted, ordinary
   * commands default to inactive (`null`) rather than pinned. GitHub
   * owner/name is never this flag.
   */
  factoryControlContext?: boolean;
}): ResolvedEngineTrackIntent {
  if (opts.forceCandidate || opts.command === "factory-gate") {
    return "candidate";
  }
  if (opts.cliTrack === "pinned" || opts.cliTrack === "candidate") {
    return opts.cliTrack;
  }
  if (opts.configTrack === "pinned" || opts.configTrack === "candidate") {
    return opts.configTrack;
  }
  if (opts.command === "evals") return "candidate";
  // Factory production/dogfood default only — never global for all consumers.
  if (opts.factoryControlContext) return "pinned";
  return null;
}

// ---------------------------------------------------------------------------
// Pinned-track enforcement (run-start / policy)
// ---------------------------------------------------------------------------

export type PinEnforcementResult =
  | { ok: true; classification: ClassifyEngineTrackResult; pin: ProductionEnginePin | null }
  | {
      ok: false;
      classification: ClassifyEngineTrackResult;
      pin: ProductionEnginePin | null;
      code:
        | "missing_pin"
        | "invalid_pin"
        | "version_mismatch"
        | "unknown_version"
        | "unverified_install";
      message: string;
      remediation: string;
    };

export function enforcePinnedTrackPolicy(input: {
  intent: EngineTrackIntent;
  pinLoad: PinLoadResult | null;
  runningVersion: string | null | undefined;
  /**
   * Installer provenance. Omitted/null is treated as missing and refuses
   * pinned intent even when versions match (no working-tree as production).
   */
  installProvenance?: PinInstallProvenance | null;
}): PinEnforcementResult {
  const pin = input.pinLoad?.kind === "ok" ? input.pinLoad.pin : null;
  const installProvenance =
    input.installProvenance ??
    ({ kind: "missing", detail: "install provenance not supplied" } satisfies PinInstallProvenance);
  const classification = classifyEngineTrack({
    intent: input.intent,
    runningVersion: input.runningVersion,
    pin,
    installProvenance,
  });

  if (input.intent === "candidate") {
    return { ok: true, classification, pin };
  }

  // pinned intent enforcement
  if (!input.pinLoad || input.pinLoad.kind === "missing") {
    const pinPath =
      input.pinLoad?.path ?? PRODUCTION_ENGINE_PIN_REL;
    return {
      ok: false,
      classification,
      pin: null,
      code: "missing_pin",
      message: `production pin missing at ${pinPath}`,
      remediation:
        `Initialize the pin from an FRG pass: pipeline factory-pin init --from-frg <X.Y.Z> ` +
        `(writes ${PRODUCTION_ENGINE_PIN_REL}). Or run with --engine-track candidate for an intentional soak.`,
    };
  }
  if (input.pinLoad.kind === "unreadable" || input.pinLoad.kind === "invalid") {
    return {
      ok: false,
      classification,
      pin: null,
      code: "invalid_pin",
      message: `production pin unreadable/invalid at ${input.pinLoad.path}: ${input.pinLoad.detail}`,
      remediation:
        `Restore or re-init the pin: pipeline factory-pin init --from-frg <X.Y.Z> --force ` +
        `(requires FRG pass). Or use --engine-track candidate for an intentional soak.`,
    };
  }
  if (!input.runningVersion || !String(input.runningVersion).trim()) {
    return {
      ok: false,
      classification,
      pin,
      code: "unknown_version",
      message: "running engine version is unknown; cannot verify pin match",
      remediation:
        "Reinstall the pipeline skill so package.json version is readable, or use --engine-track candidate.",
    };
  }
  if (!classification.pin_match) {
    const pinVer = pin!.version;
    const runVer = String(input.runningVersion).trim();
    return {
      ok: false,
      classification,
      pin,
      code: "version_mismatch",
      message: `pinned-track intent requires install v${runVer} to match production pin v${pinVer}`,
      remediation:
        `Reinstall from the pin tag: npx -y github:accidental-hedge-fund/agent-pipeline#${pin!.tag} install, ` +
        `or re-invoke with --engine-track candidate for an intentional soak.`,
    };
  }
  if (!classification.coherent_pinned) {
    const pinTag = pin!.tag;
    return {
      ok: false,
      classification,
      pin,
      code: "unverified_install",
      message:
        `pinned-track intent requires a tag install of ${pinTag}, not a same-version working-tree ` +
        `or install without a matching receipt (${classification.reason})`,
      remediation:
        `Reinstall from the pin tag so the installer writes ${INSTALL_RECEIPT_FILENAME}: ` +
        `npx -y github:accidental-hedge-fund/agent-pipeline#${pinTag} install, ` +
        `or re-invoke with --engine-track candidate for an intentional soak.`,
    };
  }
  return { ok: true, classification, pin };
}

/**
 * Map a successful pin-enforcement result to run-evidence engine fields.
 * Attaches `git_sha` only for a verified `pinned` track — never the pin SHA
 * on a candidate run (stale-install / phantom-defect attribution).
 */
export function engineTrackEvidenceFields(input: {
  track: EngineTrack;
  pin: ProductionEnginePin | null;
}): Pick<{ track: EngineTrack; pin_version?: string; git_sha?: string }, "track" | "pin_version" | "git_sha"> {
  const fields: {
    track: EngineTrack;
    pin_version?: string;
    git_sha?: string;
  } = { track: input.track };
  if (input.pin?.version) {
    fields.pin_version = input.pin.version;
  }
  if (
    input.track === "pinned" &&
    input.pin?.git_sha &&
    input.pin.git_sha.trim()
  ) {
    fields.git_sha = input.pin.git_sha.trim();
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Doctor pure helper
// ---------------------------------------------------------------------------

export type DoctorCheckStatus = "pass" | "fail" | "warn" | "skip";

export interface EngineTrackCheckResult {
  status: DoctorCheckStatus;
  detail: string;
  remediation?: string;
}

/**
 * Pure evaluation of install:engine-track for unit tests / doctor.
 * Injectable pin load + version + intent — no filesystem inside this body.
 * `intent: null` means two-track policy is inactive (ordinary non-factory host).
 */
export function evaluateEngineTrackCheck(input: {
  intent: ResolvedEngineTrackIntent;
  pinLoad: PinLoadResult;
  runningVersion: string;
  /** Install provenance; omitted → missing (fail closed under pinned intent). */
  installProvenance?: PinInstallProvenance | null;
}): EngineTrackCheckResult {
  // Non-factory ordinary hosts: pin is not required; do not fail closed.
  if (input.intent === null) {
    const pin =
      input.pinLoad.kind === "ok" ? input.pinLoad.pin : null;
    const pinPart = pin
      ? `production pin readable at factory path (v${pin.version}); not enforced`
      : input.pinLoad.kind === "missing"
        ? "production pin absent (ok for non-factory hosts)"
        : `production pin ${input.pinLoad.kind} (ok for non-factory hosts)`;
    const qualityPart =
      pin && !isProductionQualityPin(pin)
        ? `; pin frg_run_id=${pin.frg_run_id} is not production-quality (not enforced)`
        : "";
    return {
      status: "pass",
      detail:
        `two-track factory policy inactive; running v${input.runningVersion || "(unknown)"}; ${pinPart}${qualityPart}`,
    };
  }

  const pin = input.pinLoad.kind === "ok" ? input.pinLoad.pin : null;
  const installProvenance =
    input.installProvenance ??
    ({ kind: "missing", detail: "install provenance not supplied" } satisfies PinInstallProvenance);
  const classification = classifyEngineTrack({
    intent: input.intent,
    runningVersion: input.runningVersion,
    pin,
    installProvenance,
  });

  if (input.intent === "candidate") {
    const pinPart = pin
      ? `production pin target v${pin.version}${pin.git_sha ? ` sha=${pin.git_sha.slice(0, 12)}` : " sha=unknown"}`
      : input.pinLoad.kind === "missing"
        ? "production pin absent"
        : `production pin not usable (${input.pinLoad.kind})`;
    const qualityPart =
      pin && !isProductionQualityPin(pin)
        ? `; pin frg_run_id=${pin.frg_run_id} is a no-frg-* / null-evidence marker`
        : "";
    return {
      status: "pass",
      detail:
        `track=candidate; running v${input.runningVersion || "(unknown)"}; ${pinPart}` +
        (classification.pin_match ? "; install happens to match pin" : "; install ≠ pin (expected for soak)") +
        qualityPart,
    };
  }

  // pinned intent
  if (input.pinLoad.kind === "missing") {
    return {
      status: "fail",
      detail: `production pin missing at ${input.pinLoad.path}; cannot classify pinned-track production`,
      remediation:
        `Initialize from FRG pass: pipeline factory-pin init --from-frg <X.Y.Z> ` +
        `(writes ${PRODUCTION_ENGINE_PIN_REL}). Or use --engine-track candidate for an intentional soak.`,
    };
  }
  if (input.pinLoad.kind === "unreadable" || input.pinLoad.kind === "invalid") {
    return {
      status: "fail",
      detail: `production pin ${input.pinLoad.kind} at ${input.pinLoad.path}: ${input.pinLoad.detail}`,
      remediation:
        `Restore ${PRODUCTION_ENGINE_PIN_REL} or re-init: pipeline factory-pin init --from-frg <X.Y.Z> --force ` +
        `(requires FRG pass for that version).`,
    };
  }

  const pinVer = pin!.version;
  const runVer = input.runningVersion || "(unknown)";
  const shaPart =
    pin!.git_sha && pin!.git_sha.trim()
      ? ` pin_sha=${pin!.git_sha.slice(0, 12)}…`
      : " pin_sha=unknown";

  if (!isProductionQualityPin(pin)) {
    const defect = isNoFrgRunId(pin!.frg_run_id)
      ? `frg_run_id ${pin!.frg_run_id} is a no-frg-* skip marker, not a real FRG pass`
      : `frg_evidence_path is ${
          pin!.frg_evidence_path == null || !String(pin!.frg_evidence_path).trim()
            ? "null/empty"
            : JSON.stringify(pin!.frg_evidence_path)
        }`;
    return {
      status: "fail",
      detail: `production pin v${pinVer} is not production-quality: ${defect}${shaPart}`,
      remediation:
        `Promote from a real FRG pass: pipeline factory-pin promote --for ${pinVer} ` +
        `or pipeline engine-promote --for ${pinVer} (do not pass --skip-frg). ` +
        `Explicit --skip-frg writes a non-production-quality pin and is not the factory success path.`,
    };
  }

  if (!input.runningVersion || !input.runningVersion.trim()) {
    return {
      status: "fail",
      detail: `pinned intent: running version unknown; production pin is v${pinVer}${shaPart}`,
      remediation:
        `Reinstall from pin tag ${pin!.tag} so the running version is readable, ` +
        `or use --engine-track candidate.`,
    };
  }

  if (!classification.pin_match) {
    return {
      status: "fail",
      detail:
        `pinned-track mismatch: production pin v${pinVer} but installed/running v${runVer}${shaPart}`,
      remediation:
        `Reinstall from the pin tag: npx -y github:accidental-hedge-fund/agent-pipeline#${pin!.tag} install, ` +
        `or declare intentional candidate soak with --engine-track candidate.`,
    };
  }

  if (!classification.coherent_pinned) {
    return {
      status: "fail",
      detail:
        `pinned-track version matches pin v${pinVer} but install provenance is not a pin-tag install` +
        ` (${classification.reason})${shaPart}`,
      remediation:
        `Reinstall from the pin tag (writes ${INSTALL_RECEIPT_FILENAME}): ` +
        `npx -y github:accidental-hedge-fund/agent-pipeline#${pin!.tag} install, ` +
        `or declare intentional candidate soak with --engine-track candidate.`,
    };
  }

  return {
    status: "pass",
    detail:
      `track=pinned; production pin v${pinVer} matches installed/running v${runVer}` +
      ` via tag-install ${pin!.tag}${shaPart}`,
  };
}

// ---------------------------------------------------------------------------
// Doctor: factory-plane env pin vs control-checkout pin (#1183)
// ---------------------------------------------------------------------------

export interface ProductionPinPathCheckInput {
  /** True when the invocation is the live factory control checkout. */
  factoryControlContext: boolean;
  /**
   * Config `production_engine_pin_path`. Wins over env (same order as
   * {@link productionPinPath} / engine-promote).
   */
  overridePinPath?: string | null;
  /** Resolved AGENT_PIPELINE_PRODUCTION_PIN, or null when unset/empty. */
  envPinPath: string | null;
  /** `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. */
  controlPinPath: string;
  /**
   * Body of the effective pin (override → env) from DoctorDeps.readTextFile,
   * or null if unreadable. Not used when the effective path is the control pin.
   */
  envPinText: string | null;
  /** Control pin file body from DoctorDeps.readTextFile, or null if unreadable. */
  controlPinText: string | null;
}

function pinIdentityFields(pin: ProductionEnginePin): { version: string; git_sha: string } {
  const version = normalizePinVersion(pin.version) ?? pin.version.trim();
  const sha = typeof pin.git_sha === "string" ? pin.git_sha.trim().toLowerCase() : "";
  return { version, git_sha: sha };
}

/**
 * Effective pin path for install:production-pin-path: override → env → null
 * (null means promote would use the control-checkout pin). Same order as
 * {@link productionPinPath} without requiring repoDir.
 */
function effectiveProductionPinPathForCheck(
  overridePinPath: string | null | undefined,
  envPinPath: string | null | undefined,
): string | null {
  if (typeof overridePinPath === "string" && overridePinPath.trim()) {
    return path.resolve(overridePinPath.trim());
  }
  if (typeof envPinPath === "string" && envPinPath.trim()) {
    return path.resolve(envPinPath.trim());
  }
  return null;
}

/**
 * Pure evaluation of install:production-pin-path. No filesystem, network,
 * git, or subprocess. Fail (never warn/pass) when the factory-plane
 * effective pin (override → env) and control-checkout pin disagree on
 * version or git_sha.
 */
export function evaluateProductionPinPathCheck(
  input: ProductionPinPathCheckInput,
): EngineTrackCheckResult {
  if (!input.factoryControlContext) {
    return {
      status: "skip",
      detail: "non-factory host; split-pin check skipped",
    };
  }
  const controlPath = path.resolve(input.controlPinPath);
  const overridePath =
    typeof input.overridePinPath === "string" && input.overridePinPath.trim()
      ? path.resolve(input.overridePinPath.trim())
      : null;
  const effectivePath = effectiveProductionPinPathForCheck(
    input.overridePinPath,
    input.envPinPath,
  );
  if (!effectivePath) {
    return {
      status: "skip",
      detail: `${PRODUCTION_PIN_ENV} unset; pin resolution uses ${controlPath}`,
    };
  }
  if (effectivePath === controlPath) {
    return {
      status: "skip",
      detail: `effective pin and control-checkout pin are the same path (${controlPath})`,
    };
  }
  if (input.envPinText === null || input.controlPinText === null) {
    return {
      status: "skip",
      detail:
        `split-pin identity not compared (effective ${effectivePath} readable=${input.envPinText !== null}; ` +
        `control ${controlPath} readable=${input.controlPinText !== null})`,
    };
  }
  let effectivePin: ProductionEnginePin;
  let controlPin: ProductionEnginePin;
  try {
    effectivePin = parseProductionEnginePin(input.envPinText);
  } catch (err) {
    return {
      status: "skip",
      detail: `effective pin unreadable as pin JSON at ${effectivePath}: ${(err as Error).message}`,
    };
  }
  try {
    controlPin = parseProductionEnginePin(input.controlPinText);
  } catch (err) {
    return {
      status: "skip",
      detail: `control pin unreadable as pin JSON at ${controlPath}: ${(err as Error).message}`,
    };
  }
  const effectiveId = pinIdentityFields(effectivePin);
  const controlId = pinIdentityFields(controlPin);
  if (effectiveId.version === controlId.version && effectiveId.git_sha === controlId.git_sha) {
    return {
      status: "pass",
      detail:
        `effective pin ${effectivePath} matches control pin ${controlPath} ` +
        `(v${controlId.version} sha=${controlId.git_sha || "empty"})`,
    };
  }
  const effectiveSha = effectiveId.git_sha || "empty";
  const controlSha = controlId.git_sha || "empty";
  const remediation = overridePath
    ? `Unset production_engine_pin_path (it wins over ${PRODUCTION_PIN_ENV}) so ` +
      `the control-checkout pin ${controlPath} is used, or set ` +
      `production_engine_pin_path=${controlPath}. ` +
      `Do not use a second live pin file. Effective pin: ${effectivePath}. Control pin: ${controlPath}.`
    : `Unset ${PRODUCTION_PIN_ENV} so Tugboat binds the control-checkout pin ` +
      `${controlPath}, or set ${PRODUCTION_PIN_ENV}=${controlPath}. ` +
      `Do not use a second live pin file. Env pin: ${effectivePath}. Control pin: ${controlPath}.`;
  return {
    status: "fail",
    detail:
      `effective pin ${effectivePath} (v${effectiveId.version} sha=${effectiveSha}) disagrees with ` +
      `control pin ${controlPath} (v${controlId.version} sha=${controlSha})`,
    remediation,
  };
}

// ---------------------------------------------------------------------------
// Promote / init / rollback
// ---------------------------------------------------------------------------

export type PromotePinResult =
  | {
      ok: true;
      pin: ProductionEnginePin;
      path: string;
      reinstall_hint: string;
    }
  | {
      ok: false;
      code:
        | "missing_frg"
        | "frg_fail"
        | "frg_unparsable"
        | "version_mismatch"
        | "empty_run_id"
        | "no_frg_marker"
        | "already_exists"
        | "invalid_target"
        | "no_previous"
        | "write_error";
      message: string;
    };

function frgEvidenceRelPath(version: string): string {
  return path.join(FRG_EVIDENCE_ROOT_REL, normalizeFrgVersion(version), "latest.json");
}

function reinstallHint(tag: string): string {
  return `npx -y github:accidental-hedge-fund/agent-pipeline#${tag} install`;
}

function pinWithoutPrevious(pin: ProductionEnginePin): ProductionEnginePinPrevious {
  return {
    schema_version: pin.schema_version,
    version: pin.version,
    tag: pin.tag,
    git_sha: pin.git_sha ?? null,
    git_sha_source: pin.git_sha_source ?? null,
    frg_run_id: pin.frg_run_id,
    frg_evidence_path: pin.frg_evidence_path ?? null,
    promoted_at: pin.promoted_at,
  };
}

function buildPinFromFrgPass(opts: {
  evidence: FrgEvidence;
  version: string;
  gitSha?: string | null;
  gitShaSource?: GitShaSource | null;
  previous?: ProductionEnginePinPrevious | null;
  now: () => Date;
}): ProductionEnginePin {
  const version = normalizeFrgVersion(opts.version);
  const pin: ProductionEnginePin = {
    schema_version: PRODUCTION_PIN_SCHEMA_VERSION,
    version,
    tag: tagForVersion(version),
    frg_run_id: opts.evidence.run_id,
    frg_evidence_path: frgEvidenceRelPath(version),
    promoted_at: opts.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  if (opts.gitSha && opts.gitSha.trim()) {
    pin.git_sha = opts.gitSha.trim();
    pin.git_sha_source = opts.gitShaSource ?? "promote-arg";
  } else {
    pin.git_sha = null;
    pin.git_sha_source = "unknown";
  }
  if (opts.previous !== undefined) {
    pin.previous = opts.previous;
  }
  return pin;
}

/** Skip-escape pin only. Writes `no-frg-<version>` + null evidence. */
function buildPinWithoutFrg(opts: {
  version: string;
  gitSha?: string | null;
  gitShaSource?: GitShaSource | null;
  previous?: ProductionEnginePinPrevious | null;
  now: () => Date;
}): ProductionEnginePin {
  const version = normalizeFrgVersion(opts.version);
  const pin: ProductionEnginePin = {
    schema_version: PRODUCTION_PIN_SCHEMA_VERSION,
    version,
    tag: tagForVersion(version),
    // Stable non-empty marker — schema requires frg_run_id; not a real FRG score.
    frg_run_id: `no-frg-${version}`,
    frg_evidence_path: null,
    promoted_at: opts.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  if (opts.gitSha && opts.gitSha.trim()) {
    pin.git_sha = opts.gitSha.trim();
    pin.git_sha_source = opts.gitShaSource ?? "promote-arg";
  } else {
    pin.git_sha = null;
    pin.git_sha_source = "unknown";
  }
  if (opts.previous !== undefined) {
    pin.previous = opts.previous;
  }
  return pin;
}

async function atomicWritePin(
  pinPath: string,
  pin: ProductionEnginePin,
  deps: ProductionPinFsDeps,
): Promise<void> {
  await deps.mkdir(path.dirname(pinPath), { recursive: true });
  const body = `${JSON.stringify(pin, null, 2)}\n`;
  const tmp = `${pinPath}.tmp`;
  await deps.writeFile(tmp, body);
  await deps.rename(tmp, pinPath);
}

function frgRefusal(
  look: FrgLookupResult,
  target: string,
): Extract<PromotePinResult, { ok: false }> | null {
  if (look.kind === "pass") {
    if (!look.evidence.run_id.trim()) {
      return {
        ok: false,
        code: "empty_run_id",
        message: `FRG evidence for ${target} has empty run_id; refuse promote`,
      };
    }
    if (isNoFrgRunId(look.evidence.run_id)) {
      return {
        ok: false,
        code: "no_frg_marker",
        message:
          `FRG evidence for ${target} has non-production-quality run_id ${look.evidence.run_id} ` +
          `(no-frg-* is only the --skip-frg marker); refuse promote. ` +
          `Run: pipeline factory-gate --for ${target}`,
      };
    }
    if (!versionsMatch(look.evidence.version, target)) {
      return {
        ok: false,
        code: "version_mismatch",
        message:
          `FRG evidence version ${look.evidence.version} does not match promote target ${target}`,
      };
    }
    return null;
  }
  if (look.kind === "fail") {
    return {
      ok: false,
      code: "frg_fail",
      message:
        `FRG evidence for ${target} has pass:false (run_id=${look.evidence.run_id}); refuse promote. ` +
        `Re-run: pipeline factory-gate --for ${target}`,
    };
  }
  if (look.kind === "unparsable") {
    return {
      ok: false,
      code: "frg_unparsable",
      message:
        `FRG evidence for ${target} is unparsable (${look.path}): ${look.detail}; refuse promote`,
    };
  }
  return {
    ok: false,
    code: "missing_frg",
    message:
      `FRG pass missing for ${target} (expected ${look.path}); refuse promote. ` +
      `Run: pipeline factory-gate --for ${target}`,
  };
}

/**
 * Promote the production pin to `version` only when lookupFrgPass yields a
 * matching pass with a production-quality run_id (not `no-frg-*`) and the
 * write would set a non-null evidence path. Never merges or tags.
 * On refusal: zero pin mutations. `allowWithoutFrg` is the only writer of
 * the `no-frg-<version>` + null-evidence skip marker.
 */
export async function promoteProductionPin(opts: {
  repoDir: string;
  version: string;
  gitSha?: string | null;
  overridePath?: string | null;
  fsDeps?: ProductionPinFsDeps;
  /** Injected FRG lookup (defaults to real lookupFrgPass). */
  lookupFrg?: LookupFrgPassFn;
  /** Injected clock for promoted_at. */
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit skip escape: write a non-production-quality pin
   * (`no-frg-<version>` + null evidence). Default false — FRG required.
   */
  allowWithoutFrg?: boolean;
}): Promise<PromotePinResult> {
  const fsDeps = opts.fsDeps ?? defaultProductionPinFsDeps;
  const lookup = opts.lookupFrg ?? lookupFrgPass;
  const now = opts.now ?? (() => new Date());

  let target: string;
  try {
    target = normalizeFrgVersion(opts.version);
  } catch (err) {
    return { ok: false, code: "invalid_target", message: (err as Error).message };
  }

  let pin: ProductionEnginePin;
  if (opts.allowWithoutFrg) {
    const pinPathEarly = productionPinPath(opts.repoDir, opts.overridePath, opts.env);
    let previous: ProductionEnginePinPrevious | null = null;
    try {
      const existingText = await fsDeps.readFile(pinPathEarly);
      try {
        previous = pinWithoutPrevious(parseProductionEnginePin(existingText));
      } catch {
        previous = null;
      }
    } catch {
      previous = null;
    }
    pin = buildPinWithoutFrg({
      version: target,
      gitSha: opts.gitSha,
      gitShaSource: opts.gitSha ? "promote-arg" : "unknown",
      previous,
      now,
    });
    try {
      await atomicWritePin(pinPathEarly, pin, fsDeps);
    } catch (err) {
      return {
        ok: false,
        code: "write_error",
        message: `failed to write production pin: ${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      pin,
      path: pinPathEarly,
      reinstall_hint: reinstallHint(pin.tag),
    };
  }

  const look = await lookup(opts.repoDir, target);
  const refusal = frgRefusal(look, target);
  if (refusal) return refusal;
  if (look.kind !== "pass") {
    // Exhaustiveness: frgRefusal covers non-pass
    return { ok: false, code: "missing_frg", message: `FRG pass missing for ${target}` };
  }

  const pinPath = productionPinPath(opts.repoDir, opts.overridePath, opts.env);
  let previous: ProductionEnginePinPrevious | null = null;
  try {
    const existingText = await fsDeps.readFile(pinPath);
    try {
      const existing = parseProductionEnginePin(existingText);
      previous = pinWithoutPrevious(existing);
    } catch {
      // corrupt existing pin: still allow promote, previous omitted
      previous = null;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // leave previous null; still promote from FRG
      previous = null;
    }
  }

  pin = buildPinFromFrgPass({
    evidence: look.evidence,
    version: target,
    gitSha: opts.gitSha,
    gitShaSource: opts.gitSha ? "promote-arg" : "unknown",
    previous,
    now,
  });
  if (!isProductionQualityPin(pin)) {
    return {
      ok: false,
      code: "no_frg_marker",
      message:
        `refuse production-quality promote for ${target}: write would leave ` +
        `frg_run_id=${pin.frg_run_id} frg_evidence_path=${pin.frg_evidence_path ?? "null"}`,
    };
  }

  try {
    await atomicWritePin(pinPath, pin, fsDeps);
  } catch (err) {
    return {
      ok: false,
      code: "write_error",
      message: `failed to write production pin: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    pin,
    path: pinPath,
    reinstall_hint: reinstallHint(pin.tag),
  };
}

/**
 * Bootstrap init: same FRG pass gate as promote.
 * Refuses if pin already exists unless force (force still requires FRG pass).
 */
export async function initProductionPin(opts: {
  repoDir: string;
  version: string;
  force?: boolean;
  gitSha?: string | null;
  overridePath?: string | null;
  fsDeps?: ProductionPinFsDeps;
  lookupFrg?: LookupFrgPassFn;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}): Promise<PromotePinResult> {
  const fsDeps = opts.fsDeps ?? defaultProductionPinFsDeps;
  const pinPath = productionPinPath(opts.repoDir, opts.overridePath, opts.env);

  if (!opts.force) {
    try {
      await fsDeps.readFile(pinPath);
      return {
        ok: false,
        code: "already_exists",
        message:
          `production pin already exists at ${pinPath}; use --force to re-init from FRG pass ` +
          `(or pipeline factory-pin promote --for <version>)`,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // unreadable — allow force path only
        if (!opts.force) {
          return {
            ok: false,
            code: "already_exists",
            message:
              `production pin path exists but is unreadable (${(err as Error).message}); ` +
              `use --force with --from-frg to overwrite after FRG pass`,
          };
        }
      }
    }
  }

  // Init uses the same FRG gate; previous is null on first bootstrap.
  // When force-overwriting an existing pin, retain previous like promote.
  const lookup = opts.lookupFrg ?? lookupFrgPass;
  const now = opts.now ?? (() => new Date());

  let target: string;
  try {
    target = normalizeFrgVersion(opts.version);
  } catch (err) {
    return { ok: false, code: "invalid_target", message: (err as Error).message };
  }

  const look = await lookup(opts.repoDir, target);
  const refusal = frgRefusal(look, target);
  if (refusal) return refusal;
  if (look.kind !== "pass") {
    return { ok: false, code: "missing_frg", message: `FRG pass missing for ${target}` };
  }

  let previous: ProductionEnginePinPrevious | null | undefined = null;
  if (opts.force) {
    try {
      const existingText = await fsDeps.readFile(pinPath);
      try {
        previous = pinWithoutPrevious(parseProductionEnginePin(existingText));
      } catch {
        previous = null;
      }
    } catch {
      previous = null;
    }
  }

  const pin = buildPinFromFrgPass({
    evidence: look.evidence,
    version: target,
    gitSha: opts.gitSha,
    gitShaSource: opts.gitSha ? "promote-arg" : "unknown",
    previous: previous ?? null,
    now,
  });

  try {
    await atomicWritePin(pinPath, pin, fsDeps);
  } catch (err) {
    return {
      ok: false,
      code: "write_error",
      message: `failed to write production pin: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    pin,
    path: pinPath,
    reinstall_hint: reinstallHint(pin.tag),
  };
}

/**
 * Rollback: restore pin.previous, or --to a version that matches previous
 * (or has an FRG pass when loading previous is insufficient).
 * On refusal: active pin unchanged.
 */
export async function rollbackProductionPin(opts: {
  repoDir: string;
  /** Explicit target version; when omitted, uses pin.previous. */
  toVersion?: string | null;
  overridePath?: string | null;
  fsDeps?: ProductionPinFsDeps;
  lookupFrg?: LookupFrgPassFn;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}): Promise<PromotePinResult> {
  const fsDeps = opts.fsDeps ?? defaultProductionPinFsDeps;
  const lookup = opts.lookupFrg ?? lookupFrgPass;
  const now = opts.now ?? (() => new Date());
  const pinPath = productionPinPath(opts.repoDir, opts.overridePath, opts.env);

  let current: ProductionEnginePin;
  try {
    const text = await fsDeps.readFile(pinPath);
    current = parseProductionEnginePin(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        code: "missing_frg",
        message: `no production pin at ${pinPath} to roll back`,
      };
    }
    return {
      ok: false,
      code: "invalid_target",
      message: `current production pin invalid: ${(err as Error).message}`,
    };
  }

  // Snapshot of the current pin becomes the new previous after rollback.
  const currentAsPrevious = pinWithoutPrevious(current);

  if (!opts.toVersion || !opts.toVersion.trim()) {
    // Default: restore pin.previous
    if (!current.previous) {
      return {
        ok: false,
        code: "no_previous",
        message:
          "production pin has no previous snapshot; refuse rollback. " +
          "Pass --to <X.Y.Z> with an FRG-passed version to rebuild the pin.",
      };
    }
    const restored: ProductionEnginePin = {
      schema_version: PRODUCTION_PIN_SCHEMA_VERSION,
      version: current.previous.version,
      tag: current.previous.tag,
      git_sha: current.previous.git_sha ?? null,
      git_sha_source: current.previous.git_sha_source ?? "unknown",
      frg_run_id: current.previous.frg_run_id,
      frg_evidence_path: current.previous.frg_evidence_path ?? null,
      promoted_at: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
      previous: currentAsPrevious,
    };
    try {
      await atomicWritePin(pinPath, restored, fsDeps);
    } catch (err) {
      return {
        ok: false,
        code: "write_error",
        message: `failed to write production pin: ${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      pin: restored,
      path: pinPath,
      reinstall_hint: reinstallHint(restored.tag),
    };
  }

  let target: string;
  try {
    target = normalizeFrgVersion(opts.toVersion);
  } catch (err) {
    return { ok: false, code: "invalid_target", message: (err as Error).message };
  }

  // Prefer retained previous when it matches --to
  if (current.previous && versionsMatch(current.previous.version, target)) {
    const restored: ProductionEnginePin = {
      schema_version: PRODUCTION_PIN_SCHEMA_VERSION,
      version: current.previous.version,
      tag: current.previous.tag,
      git_sha: current.previous.git_sha ?? null,
      git_sha_source: current.previous.git_sha_source ?? "unknown",
      frg_run_id: current.previous.frg_run_id,
      frg_evidence_path: current.previous.frg_evidence_path ?? null,
      promoted_at: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
      previous: currentAsPrevious,
    };
    try {
      await atomicWritePin(pinPath, restored, fsDeps);
    } catch (err) {
      return {
        ok: false,
        code: "write_error",
        message: `failed to write production pin: ${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      pin: restored,
      path: pinPath,
      reinstall_hint: reinstallHint(restored.tag),
    };
  }

  // Otherwise require FRG pass for --to (rebuild pin; retain current as previous)
  const look = await lookup(opts.repoDir, target);
  const refusal = frgRefusal(look, target);
  if (refusal) {
    return {
      ok: false,
      code: refusal.code === "missing_frg" ? "missing_frg" : refusal.code,
      message:
        `rollback --to ${target}: no retained previous snapshot for that version and ${refusal.message}`,
    };
  }
  if (look.kind !== "pass") {
    return {
      ok: false,
      code: "missing_frg",
      message: `rollback --to ${target}: FRG pass required when previous snapshot is unavailable`,
    };
  }

  const pin = buildPinFromFrgPass({
    evidence: look.evidence,
    version: target,
    previous: currentAsPrevious,
    now,
  });

  try {
    await atomicWritePin(pinPath, pin, fsDeps);
  } catch (err) {
    return {
      ok: false,
      code: "write_error",
      message: `failed to write production pin: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    pin,
    path: pinPath,
    reinstall_hint: reinstallHint(pin.tag),
  };
}

/** Format pin for CLI show / doctor detail. */
export function formatProductionPinSummary(pin: ProductionEnginePin): string {
  const sha =
    pin.git_sha && pin.git_sha.trim()
      ? pin.git_sha
      : "unknown";
  const prev = pin.previous ? pin.previous.version : "(none)";
  return (
    `version=${pin.version} tag=${pin.tag} frg_run_id=${pin.frg_run_id} ` +
    `git_sha=${sha} promoted_at=${pin.promoted_at} previous=${prev}`
  );
}

/** Re-export path helper used by doctor/tests for frgLatestPath expectations. */
export { frgLatestPath, normalizeFrgVersion };
