// Outer-host lifecycle contract (#784).
//
// Versioned manifest schema for the *session host* that launches and supervises
// the pipeline — independent of stage adapter ID, provider/auth class, model,
// effort, and implementer/reviewer role assignment (#783).

/** Supported outer-host lifecycle manifest schema version. */
export const OUTER_HOST_MANIFEST_VERSION = 1 as const;

/** Capability support levels. */
export type CapabilitySupport = "supported" | "limited" | "unsupported";

/**
 * Install modes the installer understands. Dispatch is by mode string, never
 * by host id string equality in shared consumers.
 */
export type OuterHostInstallMode =
  | "tree"
  | "symlink-claude"
  | "commands-surface"
  | "none";

/** How managed command files are laid out when install is supported. */
export type OuterHostCommandsKind =
  | "none"
  | "claude-slash" // ~/.claude/commands/pipeline:*.md
  | "codex-prompt" // skills/pipeline/agents/pipeline/*.md (Codex prompt agents)
  | "opencode-native"; // <base>/commands/pipeline.md

/** Material-progress notify surface identifiers (values of the mapping). */
export type MaterialNotifySurface =
  | "claude_monitor_push"
  | "grok_monitor_lines"
  | "codex_chat_status"
  | "stdout_only"
  | "none";

/** Base-path resolution for install (dependency-light for install.mjs). */
export interface OuterHostBasePath {
  /** Optional env override (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR). */
  env?: string | null;
  /**
   * Default path under $HOME as segments (e.g. [".claude"]).
   * For multi-candidate bases (Codex ~/.codex vs ~/.agents), list preferred first.
   */
  defaultHomeSegments: readonly string[];
  /**
   * When true, skills live under <base>/skills; when CODEX_HOME is set the base
   * is that env value directly (Codex historical layout).
   */
  skillsUnderBase?: boolean;
  /**
   * Alternate home segments tried when the primary default does not exist
   * (Codex ~/.agents fallback). Empty/absent = no alternate.
   */
  alternateHomeSegments?: readonly string[];
}

/** Managed install artifacts — uninstall removes only these. */
export interface OuterHostManagedArtifacts {
  /** Managed skill tree under skillsDir/pipeline (or skillDirName). */
  skillTree: boolean;
  /** Glob of managed command files (e.g. "pipeline:*.md"); null when none. */
  commandsGlob: string | null;
  /** Relative segments from base for the commands directory. */
  commandsDirRelative: readonly string[] | null;
  /** Commands surface kind for installer dispatch. */
  commandsKind: OuterHostCommandsKind;
  /**
   * Extra host overlay files copied into the skill scripts/ tree
   * (e.g. opencode-pipeline-bridge.mjs).
   */
  extraScriptFiles?: readonly string[];
}

/** Install / invocation profile. */
export interface OuterHostInstallProfile {
  support: CapabilitySupport;
  /** Required when support is unsupported. */
  fallback?: string;
  mode: OuterHostInstallMode;
  basePath: OuterHostBasePath;
  /** Segments under base for the skills parent dir (usually ["skills"]). */
  skillsRelative: readonly string[];
  skillDirName: string;
  /** Repo-relative overlay directory (e.g. "hosts/claude"). Empty for symlink-only. */
  overlayDir: string;
  overlayFiles: readonly string[];
  overlayDirs: readonly string[];
  managedArtifacts: OuterHostManagedArtifacts;
  /** Explicit user-owned exclusion rule (required when install supported). */
  userOwnedExclusion: string;
  postInstall: string;
  /**
   * Lower numbers install earlier when --host all (tree hosts before
   * symlink-claude consumers that depend on Claude skill).
   */
  installOrder: number;
  /** When true, base "exists" check is skipped for forced --host install. */
  baseOptional?: boolean;
}

/**
 * Machine-consumable discovery probe kind. Discovery consumers use this rather
 * than assuming `which <host-id>` (#784) — e.g. Grok is available via an
 * installed skill symlink/tree, not a `grok` executable.
 */
export type OuterHostDiscoveryProbeKind =
  | "which"
  | "skill_path"
  | "which_or_skill_path";

/** Typed discovery probe declared on the outer-host invocation profile. */
export interface OuterHostDiscoveryProbeSpec {
  kind: OuterHostDiscoveryProbeKind;
  /**
   * CLI name for `which` / `which_or_skill_path`. Defaults to the host id when
   * omitted and the kind includes a which probe.
   */
  whichCommand?: string;
}

/** Skill / command invocation surface. */
export interface OuterHostInvocation {
  support: CapabilitySupport;
  fallback?: string;
  skillPathHint: string;
  commandSurface: string;
  /**
   * Human-readable probe description (docs / operator hints). Not executed as a
   * shell command by discovery — see {@link discovery}.
   */
  discoveryProbe: string;
  /**
   * Machine-consumable discovery probe. Install/discovery surfaces resolve
   * availability from this field plus install base-path data (#784).
   */
  discovery: OuterHostDiscoveryProbeSpec;
}

/** Generic capability with how-to + required fallback when not fully supported. */
export interface OuterHostCapability {
  support: CapabilitySupport;
  /** How to exercise the capability when supported or limited. */
  how: string;
  /**
   * Required when support !== "supported". Portable baseline is stdout /
   * events.jsonl when observation is involved.
   */
  fallback?: string;
}

/** Wait/cancel classification — cancelled wait is never terminal success. */
export interface OuterHostWaitCancel extends OuterHostCapability {
  /** Always non_terminal under this contract. */
  classification: "non_terminal";
  recovery: "reattach_or_portable_follow";
}

/** Material-progress notification mapping. */
export interface OuterHostMaterialProgressNotify extends OuterHostCapability {
  mapping: {
    surface: MaterialNotifySurface;
    /** Host-local tool or surface names (e.g. PushNotification, monitor). */
    tools: readonly string[];
    /** Installed material-filter path hint (scripts/material-filter.mjs). */
    filter: string;
  };
}

/**
 * Versioned outer-host lifecycle manifest.
 * Independent of stage adapter, provider, model, effort, and role.
 */
export interface OuterHostManifest {
  /** Schema / manifest version (currently 1). */
  manifestVersion: number;
  id: string;
  displayName: string;
  /** Optional default pipeline profile name when this host launches. */
  profileDefault?: string | null;
  /** Registration origin. */
  origin: "builtin" | "extension";
  install: OuterHostInstallProfile;
  invocation: OuterHostInvocation;
  early_run_handoff: OuterHostCapability;
  event_follow: OuterHostCapability;
  reattach: OuterHostCapability;
  wait_cancel: OuterHostWaitCancel;
  material_progress_notify: OuterHostMaterialProgressNotify;
  terminal_cleanup: OuterHostCapability;
  terminal_summary: OuterHostCapability;
}

/** Capability areas every manifest must declare. */
export const OUTER_HOST_CAPABILITY_AREAS = [
  "install",
  "invocation",
  "early_run_handoff",
  "event_follow",
  "reattach",
  "wait_cancel",
  "material_progress_notify",
  "terminal_cleanup",
  "terminal_summary",
] as const;

export type OuterHostCapabilityArea = (typeof OUTER_HOST_CAPABILITY_AREAS)[number];

/** Built-in outer host ids (golden install coverage may assert this set). */
export const BUILTIN_OUTER_HOST_IDS = ["claude", "codex", "grok", "opencode"] as const;
export type BuiltinOuterHostId = (typeof BUILTIN_OUTER_HOST_IDS)[number];

/** Portable observation baseline named in fallbacks. */
export const PORTABLE_OBSERVATION_BASELINE =
  "stdout JSON and/or run-store events.jsonl follow (pipeline logs --events --follow)";
