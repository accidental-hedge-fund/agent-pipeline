import { createHash } from "node:crypto";
import { canonicalJson } from "./grant.mjs";
import { assertNoSecret, redactValue, safeErrorMessage } from "./redaction.mjs";

const MATERIAL_KINDS = new Set([
  "run_start",
  "issue_start",
  "stage_change",
  "pipeline_event",
  "pr_ready",
  "merge_result",
  "frg_result",
  "release_pr",
  "release_published",
  "install_result",
  "rollback",
  "stop",
  "failure",
  "calibration",
]);

function noticeId(notice) {
  return createHash("sha256").update(canonicalJson(notice), "utf8").digest("hex");
}

export class NoticeSink {
  constructor({ validated, config, journal, store, deliver, secrets = [], now = () => new Date(), log = () => {} }) {
    this.validated = validated;
    this.config = config;
    this.journal = journal;
    this.store = store;
    this.deliver = deliver;
    this.secrets = secrets;
    this.now = now;
    this.log = log;
  }

  build(kind, fields = {}) {
    if (kind !== "heartbeat" && !MATERIAL_KINDS.has(kind)) {
      throw new Error(`unsupported notice kind ${kind}`);
    }
    const redacted = redactValue(fields, this.secrets);
    const notice = {
      schema_version: 1,
      kind,
      grant_fingerprint: this.validated.fingerprint,
      thread_id: this.validated.auth.thread_id,
      repository: this.validated.grant.repository,
      release_version: this.validated.grant.release_version,
      occurred_at: this.now().toISOString(),
      ...redacted,
    };
    assertNoSecret(notice, this.secrets);
    return notice;
  }

  async send(kind, fields = {}, { dedupeId = null } = {}) {
    let notice;
    try {
      notice = this.build(kind, fields);
    } catch (error) {
      this.log(`notice build failed: ${safeErrorMessage(error, this.secrets)}`);
      return { delivered: false, error: "notice build failed" };
    }
    const id = dedupeId ?? noticeId(notice);
    if ((this.journal.notices.delivered_ids ?? []).includes(id)) {
      return { delivered: false, skipped: true, id, notice };
    }
    let queued;
    try {
      queued = await this.store.enqueueNotice(this.journal, kind, id, notice);
    } catch (error) {
      this.log(`notice journal write failed: ${safeErrorMessage(error, this.secrets)}`);
      return { delivered: false, id, notice, error: "journal write failed" };
    }
    if (queued.state === "delivered") return { delivered: false, skipped: true, id, notice: queued.notice };
    try {
      await this.deliver(queued.notice);
      await this.store.completeNotice(this.journal, queued.kind, id);
      return { delivered: true, id, notice: queued.notice };
    } catch (error) {
      this.log(`Buzz notice delivery failed: ${safeErrorMessage(error, this.secrets)}`);
      return { delivered: false, id, notice: queued.notice, error: "delivery failed" };
    }
  }

  async flushPending() {
    const entries = Object.entries(this.journal.notices.pending ?? {});
    let delivered = 0;
    for (const [id, pending] of entries) {
      try {
        await this.deliver(pending.notice);
        await this.store.completeNotice(this.journal, pending.kind, id);
        delivered += 1;
      } catch (error) {
        this.log(`Buzz notice retry failed: ${safeErrorMessage(error, this.secrets)}`);
      }
    }
    return { delivered, pending: Object.keys(this.journal.notices.pending ?? {}).length };
  }

  async heartbeat(fields = {}) {
    const last = this.journal.notices.last_material_at ?? this.journal.notices.last_heartbeat_at;
    if (last) {
      const elapsed = this.now().getTime() - Date.parse(last);
      if (elapsed < this.config.heartbeat_seconds * 1000) return { delivered: false, skipped: true };
    }
    return this.send("heartbeat", fields);
  }
}
