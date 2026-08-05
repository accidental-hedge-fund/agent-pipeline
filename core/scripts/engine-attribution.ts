// Engine + discovery attribution (#763): closed discovery-channel vocabulary,
// engine commit SHA resolution, GitHub HTML markers, and event inheritance.
//
// Producers stamp version + commit_sha + discovery-channel on auto-filed issue
// bodies, blocker comments, and defect/blocker/intervention events. Scoreboard
// collectors inherit missing event fields from run.json engine identity and a
// run-level channel default (`live-run` for ordinary advance). Never invent a
// SHA; unresolved identity is explicit (`unknown` / null).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Discovery channel (closed four-value vocabulary)
// ---------------------------------------------------------------------------

export const DISCOVERY_CHANNELS = [
  "live-run",
  "review-batch",
  "papercut-autofile",
  "manual",
] as const;

export type DiscoveryChannel = (typeof DISCOVERY_CHANNELS)[number];

const DISCOVERY_CHANNEL_SET: ReadonlySet<string> = new Set(DISCOVERY_CHANNELS);

/** True when value is one of the four closed discovery-channel members. */
export function isDiscoveryChannel(value: unknown): value is DiscoveryChannel {
  return typeof value === "string" && DISCOVERY_CHANNEL_SET.has(value);
}

/**
 * Normalize a channel for write paths: reject anything outside the closed set.
 * Returns null when the value is missing or invalid (caller must not invent).
 */
export function normalizeDiscoveryChannel(value: unknown): DiscoveryChannel | null {
  return isDiscoveryChannel(value) ? value : null;
}

/**
 * Read-side residual for historical garbage: valid channels pass through;
 * anything else becomes null so consumers can bucket under missing-attribution.
 * Never coerces missing/invalid to `live-run`.
 */
export function parseDiscoveryChannelLoose(value: unknown): DiscoveryChannel | null {
  return normalizeDiscoveryChannel(value);
}

/** Default discovery channel for ordinary issue advance / durable-loop item execution. */
export const DEFAULT_LIVE_RUN_CHANNEL: DiscoveryChannel = "live-run";

/** All three auto-file categories stamp this coarse channel (category markers stay distinct). */
export const AUTO_FILE_DISCOVERY_CHANNEL: DiscoveryChannel = "papercut-autofile";

// ---------------------------------------------------------------------------
// Engine commit SHA resolution
// ---------------------------------------------------------------------------

export interface ResolveEngineCommitShaDeps {
  /**
   * Run `git -C <cwd> rev-parse HEAD` and return stdout trim, or null on failure.
   * Injectable so unit tests never spawn git.
   */
  revParseHead: (cwd: string) => string | null;
  /** True when `root` looks like a directory that might be a git checkout. */
  isDirectory?: (root: string) => boolean;
}

function revParseHeadDefault(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const sha = out.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isDirectoryDefault(root: string): boolean {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

export const defaultResolveEngineCommitShaDeps: ResolveEngineCommitShaDeps = {
  revParseHead: revParseHeadDefault,
  isDirectory: isDirectoryDefault,
};

/**
 * Resolve the git commit SHA of an engine root checkout. Returns null when
 * unresolvable — never invents a SHA. Walks from `engineRoot` upward one level
 * when the root is `core/` inside a monorepo checkout (common install layout).
 */
export function resolveEngineCommitSha(
  engineRoot: string,
  deps: ResolveEngineCommitShaDeps = defaultResolveEngineCommitShaDeps,
): string | null {
  if (typeof engineRoot !== "string" || !engineRoot.trim()) return null;
  const root = path.resolve(engineRoot.trim());
  const isDir = deps.isDirectory ?? isDirectoryDefault;
  if (!isDir(root)) return null;

  const direct = deps.revParseHead(root);
  if (direct) return direct;

  // Engine root is often `…/core`; the git worktree lives one level up.
  const parent = path.dirname(root);
  if (parent && parent !== root) {
    return deps.revParseHead(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// GitHub HTML comment markers (additive; pure format/parse)
// ---------------------------------------------------------------------------

/** `<!-- pipeline:engine version=<semver> sha=<sha|unknown> -->` */
export const ENGINE_MARKER_RE =
  /<!--\s*pipeline:engine\s+version=([^\s>]+)\s+sha=([^\s>]+)\s*-->/i;

/** `<!-- pipeline:discovery-channel <channel> -->` */
export const DISCOVERY_CHANNEL_MARKER_RE =
  /<!--\s*pipeline:discovery-channel\s+([a-z0-9-]+)\s*-->/i;

export interface EngineIdentityStamp {
  version: string;
  /** Full or short hex SHA, or the explicit unresolved token `unknown`. */
  commit_sha: string;
}

export function formatEngineMarker(stamp: EngineIdentityStamp): string {
  const version = stamp.version.trim() || "unknown";
  const sha = stamp.commit_sha.trim() || "unknown";
  return `<!-- pipeline:engine version=${version} sha=${sha} -->`;
}

export function formatDiscoveryChannelMarker(channel: DiscoveryChannel): string {
  return `<!-- pipeline:discovery-channel ${channel} -->`;
}

export function parseEngineMarker(body: string): EngineIdentityStamp | null {
  const m = body.match(ENGINE_MARKER_RE);
  if (!m) return null;
  return { version: m[1], commit_sha: m[2] };
}

export function parseDiscoveryChannelMarker(body: string): DiscoveryChannel | null {
  const m = body.match(DISCOVERY_CHANNEL_MARKER_RE);
  if (!m) return null;
  return parseDiscoveryChannelLoose(m[1]);
}

/**
 * Compose attribution markers for GitHub bodies. Order: category provenance
 * (caller-owned), then engine, then discovery-channel. Does not include the
 * category marker — callers prepend their own.
 */
export function formatAttributionMarkers(opts: {
  version: string | null | undefined;
  commit_sha: string | null | undefined;
  discovery_channel: DiscoveryChannel;
}): string {
  const version =
    typeof opts.version === "string" && opts.version.trim()
      ? opts.version.trim()
      : "unknown";
  const sha =
    typeof opts.commit_sha === "string" && opts.commit_sha.trim()
      ? opts.commit_sha.trim()
      : "unknown";
  return [
    formatEngineMarker({ version, commit_sha: sha }),
    formatDiscoveryChannelMarker(opts.discovery_channel),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Event / run inheritance
// ---------------------------------------------------------------------------

export interface EngineAttributionFields {
  engine_version: string | null;
  engine_commit_sha: string | null;
  discovery_channel: DiscoveryChannel | null;
  /** True when neither inline fields nor run inheritance supplied a channel. */
  missing_attribution: boolean;
}

export interface RunEngineAttributionSource {
  version?: string | null;
  commit_sha?: string | null;
  /** Legacy #762 production pin SHA — not preferred over commit_sha. */
  git_sha?: string | null;
}

/**
 * Read the run-level discovery-channel stamp from run.json when present.
 * Returns null for historical run.json that lack the field — callers must
 * treat that as missing-attribution, never invent live-run from engine.version.
 */
export function runLevelDiscoveryChannel(
  runJson: Record<string, unknown> | null | undefined,
): DiscoveryChannel | null {
  if (!runJson) return null;
  return parseDiscoveryChannelLoose(runJson["discovery_channel"]);
}

/**
 * Resolve attribution for a ledger event:
 * 1. Inline event fields (`engine_version`, `engine_commit_sha`, `discovery_channel`)
 * 2. Else inherit from run.json engine identity + run default channel
 * 3. Missing channel is explicit (never defaulted to live-run at read time
 *    unless `runDefaultChannel` is provided as the documented run-level default)
 *
 * Documented inheritance rule: new ordinary-advance runs persist
 * `run.json.discovery_channel = "live-run"`; collectors pass that stamp as
 * `runDefaultChannel` so events that omit the field inherit it. Historical
 * runs without the stamp (or events with `runDefaultChannel = null`) remain
 * `missing_attribution`. Do **not** infer channel from engine.version alone.
 */
export function resolveEventAttribution(
  event: Record<string, unknown> | null | undefined,
  runEngine: RunEngineAttributionSource | null | undefined,
  runDefaultChannel: DiscoveryChannel | null = null,
): EngineAttributionFields {
  const ev = event ?? {};
  const inlineVersion =
    typeof ev["engine_version"] === "string" && ev["engine_version"].trim()
      ? (ev["engine_version"] as string).trim()
      : null;
  const inlineSha =
    typeof ev["engine_commit_sha"] === "string" && (ev["engine_commit_sha"] as string).trim()
      ? (ev["engine_commit_sha"] as string).trim()
      : null;
  const inlineChannel = parseDiscoveryChannelLoose(ev["discovery_channel"]);

  const inheritedVersion =
    typeof runEngine?.version === "string" && runEngine.version.trim()
      ? runEngine.version.trim()
      : null;
  const inheritedSha =
    (typeof runEngine?.commit_sha === "string" && runEngine.commit_sha.trim()
      ? runEngine.commit_sha.trim()
      : null) ??
    (typeof runEngine?.git_sha === "string" && runEngine.git_sha.trim()
      ? runEngine.git_sha.trim()
      : null);

  const engine_version = inlineVersion ?? inheritedVersion;
  const engine_commit_sha = inlineSha ?? inheritedSha;
  const discovery_channel = inlineChannel ?? runDefaultChannel;
  const missing_attribution =
    engine_version === null && engine_commit_sha === null && inlineChannel === null && runDefaultChannel === null;

  return {
    engine_version,
    engine_commit_sha,
    discovery_channel,
    missing_attribution,
  };
}

/**
 * Build additive attribution fields for a new event from a known engine identity.
 * Non-fatal callers may omit this when identity is unknown.
 */
export function buildEventAttributionFields(opts: {
  version?: string | null;
  commit_sha?: string | null;
  discovery_channel?: DiscoveryChannel | null;
}): {
  engine_version?: string;
  engine_commit_sha?: string | null;
  discovery_channel?: DiscoveryChannel;
} {
  const out: {
    engine_version?: string;
    engine_commit_sha?: string | null;
    discovery_channel?: DiscoveryChannel;
  } = {};
  if (typeof opts.version === "string" && opts.version.trim()) {
    out.engine_version = opts.version.trim();
  }
  if (opts.commit_sha === null) {
    out.engine_commit_sha = null;
  } else if (typeof opts.commit_sha === "string" && opts.commit_sha.trim()) {
    out.engine_commit_sha = opts.commit_sha.trim();
  }
  if (opts.discovery_channel && isDiscoveryChannel(opts.discovery_channel)) {
    out.discovery_channel = opts.discovery_channel;
  }
  return out;
}

/** Snapshot of the producing engine for stamping GitHub bodies / events. */
export function snapshotEngineStamp(opts: {
  version?: string | null;
  commit_sha?: string | null;
}): EngineIdentityStamp {
  return {
    version:
      typeof opts.version === "string" && opts.version.trim()
        ? opts.version.trim()
        : "unknown",
    commit_sha:
      typeof opts.commit_sha === "string" && opts.commit_sha.trim()
        ? opts.commit_sha.trim()
        : "unknown",
  };
}
