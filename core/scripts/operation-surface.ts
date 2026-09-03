// Shared host-operation catalog (#273, #1048).
//
// Entries here drive the generated CLI/SKILL documentation for the in-scope
// host verbs. They do not create one host command file per verb.

export type OperationSection =
  | "advance"
  | "lifecycle"
  | "factory"
  | "observability"
  | "config"
  | "other";

export interface OperationSurfaceEntry {
  name: string;
  /** One-line description used by generated CLI and host SKILL tables. */
  desc: string;
  /** Full host-token-agnostic usage, beginning with the operation name. */
  usage: string;
  /** Legacy catalog shape retained for packaging consumers. */
  argHint: string;
  /** Legacy direct-CLI forwarding shape retained for host consumers. */
  cliArgs: string;
  section: OperationSection;
  fast: boolean;
  inRepoLoop?: boolean;
}

interface OperationInput {
  name: string;
  desc: string;
  usage: string;
  section: OperationSection;
  fast: boolean;
  inRepoLoop?: boolean;
}

function operation(input: OperationInput): OperationSurfaceEntry {
  const prefix = `${input.name} `;
  const argHint = input.usage.startsWith(prefix)
    ? input.usage.slice(prefix.length)
    : input.usage === input.name
      ? ""
      : input.usage;
  return {
    ...input,
    argHint,
    cliArgs: argHint ? `${input.name} $ARGUMENTS` : input.name,
  };
}

export const OPERATION_SURFACE: readonly OperationSurfaceEntry[] = [
  operation({
    name: "status",
    desc: "Read-only — print stage, blocker, PR, last review",
    usage: "status <n>",
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "unblock",
    desc: "Post an answer and clear the blocked label",
    usage: 'unblock <n> "<answer>"',
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "override",
    desc:
      "Operator-supplied or explicitly approved exact disposition (\"<key>: <reason>\"); auto-resumes. Not an autonomous host next action",
    usage: 'override <n> "<key>: <reason>"',
    section: "lifecycle",
    fast: false,
  }),
  operation({
    name: "recover-parked",
    desc:
      "One supervisor pass for a parked issue: deterministic recover first (including publish of an unpublished stage commit), then reflow only stale/DNR/below-high residuals (never auto-override HIGH/CRITICAL/security); pre-PR engine parks re-enter without a linked PR; re-enter single if clear",
    usage: "recover-parked <n> [--json] [--dry-run]",
    section: "lifecycle",
    fast: false,
  }),
  operation({
    name: "summary",
    desc: "Print the run evidence bundle for an issue number or exact run-id",
    usage: "summary <issue-number|run-id>",
    section: "observability",
    fast: true,
  }),
  operation({
    name: "doctor",
    desc:
      "Deterministic preflight check; print summary, exit 0/1. Reports continuous liveness as configured/available/active/degraded/unavailable without treating absence as human authority. Opt-in --harness-smoke adds one cheap model call per unique configured harness treatment",
    usage: "doctor [--json|--is-ok] [--fail-fast] [--harness-smoke]",
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "liveness",
    desc:
      "Discover, claim, and reattach machine-local durable supervisors after worker or machine restart (not recovery or merge)",
    usage: "liveness status [--json] | liveness restore [--json] [--run-id <id>]",
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "init",
    desc: "Ensure pipeline labels and scaffold .github/pipeline.yml",
    usage: "init",
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "cleanup",
    desc: "Sweep merged-PR worktrees and delete their local branches",
    usage: "cleanup",
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "intake",
    desc: "Spec a rough description into a GitHub issue and ROADMAP PR",
    usage: 'intake --description "<text>" [--release vX.Y.Z] [--dry-run]',
    section: "factory",
    fast: false,
  }),
  operation({
    name: "decompose",
    desc:
      "Break an epic issue into dependency-linked child issues and a ROADMAP PR (dry-run default; --apply writes; not intake / not roadmap-order-only / not loop-execute)",
    usage:
      'decompose --epic <N> [--description "…"] [--apply] [--release vX.Y.Z] [--max-children N] [--max-effort S|M|L|XL] [--allow-xl]',
    section: "factory",
    fast: false,
  }),
  operation({
    name: "sweep",
    desc: "Batch re-spec thin issues and reconcile ROADMAP.md",
    usage: "sweep [--apply] [--repo owner/name]",
    section: "factory",
    fast: false,
  }),
  operation({
    name: "grill",
    desc:
      "Native grill-with-docs admission: freeze a selector, auto-settle in-scope recommendations, write Decisions and domain docs, request pipeline:ready",
    usage:
      "grill --issue N [--dry-run] [--json] | grill --issues N,N,... [--dry-run] [--json] | grill --milestone M [--dry-run] [--json] | grill --label L [--label L] [--dry-run] [--json] | grill status --run-id <id> [--follow] [--json] | grill --resume <run-id>",
    section: "factory",
    fast: false,
  }),
  operation({
    name: "triage",
    desc:
      "Set a pre-pipeline stage label (ready or backlog) on an issue. needs-spec is an admission hold: apply the spec, then triage --stage ready.",
    usage: "triage <n> --stage ready|backlog",
    section: "factory",
    fast: true,
  }),
  operation({
    name: "merge",
    desc: "Operator-authorized squash merge of a ready-to-deploy PR (never called by the advance loop)",
    usage: "merge <pr>",
    section: "lifecycle",
    fast: true,
  }),
  operation({
    name: "merge-queue",
    desc:
      "Operator-authorized sequential merge of ready-to-deploy PRs; dry-run by default; optional prepare-only release-when-complete",
    usage:
      "merge-queue --milestone <m> [--apply] [--release-when-complete --release-version <ver>]",
    section: "lifecycle",
    fast: false,
  }),
  operation({
    name: "train",
    desc:
      "Operator-authorized integrate train: base-eligible frontiers advance via one loop wave each (recovery inside the wave); optionally serial-merge with base containment; parks stay RecoverySupervisor-owned (recover-parked remains an operator CLI); independent R2D siblings may merge while a peer is parked or cooling (never called by the advance loop)",
    usage:
      "train --milestone <m> [--merge] [--json] [--dry-run] | train --issues <n,n> [--merge] [--json] [--dry-run]",
    section: "lifecycle",
    fast: false,
  }),
  operation({
    name: "ship",
    desc:
      "Run or inspect one durable milestone shipment (train --merge, release, finish, promote). Operator product is pipeline ship --milestone vX.Y.Z; no grant file required.",
    usage:
      "ship --milestone vX.Y.Z [--json] | ship status --milestone vX.Y.Z [--json]",
    section: "lifecycle",
    fast: false,
  }),
  operation({
    name: "release",
    desc:
      "Prepare a release PR from the matching GitHub milestone plan (or finish-merge one); finish never tags; ship-end ensure-tag creates vX.Y.Z from on-disk HMAC latest.json when FRG is gitignored; --dry-run reports milestone presence/open issues",
    usage:
      'release <version> [--theme "..."] [--dry-run|--json] [--no-edit] [--skip-frg] | release finish <pr> [--json] | release ensure-tag <X.Y.Z> <merge-oid> --packed-candidate <sha>',
    section: "lifecycle",
    fast: false,
  }),
  operation({
    name: "roadmap",
    desc:
      "Analyze open backlog into a dependency-aware scored roadmap; under SemVer, dry-run lists full milestone reconciliation actions and --apply converges open issues to the reviewed manifest (fingerprint-gated)",
    usage: "roadmap [--apply] [--next <n>]",
    section: "factory",
    fast: false,
  }),
  operation({
    name: "logs",
    desc: "List or stream pipeline run logs (events --follow exits 0 on terminal run_complete)",
    usage: "logs [<run-id>] [--events] [-f] [--no-until-terminal]",
    section: "observability",
    fast: true,
  }),
  // Multi-item drive/resume is long-running (minutes–hours), so it has its
  // specialized in-repo orchestration guidance rather than the fast template.
  operation({
    name: "loop",
    desc: "Durable multi-item run — driven in-repo by the pipeline's own loop supervisor",
    usage:
      "loop --milestone <m> [--audit] [--follow] | loop --label <l> [--audit] [--follow] | loop --range a-b [--audit] [--follow] | loop --roadmap-slice <slice> [--audit] [--follow] | loop <N> [<N> ...] [--audit] [--follow] | loop --resume <run-id> [--audit] [--follow]",
    section: "advance",
    fast: false,
    inRepoLoop: true,
  }),
];
