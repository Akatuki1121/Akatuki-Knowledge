import assert from "node:assert/strict";
import {
  CIRCULATION_AUDIT_RULES,
  enumerateCirculationSet,
  detectCirculationChanges,
  buildCirculationAuditPlan
} from "../src/circulation-audit.mjs";

const now = Date.parse("2026-11-25T00:00:00.000Z");
const old = "2026-11-01T00:00:00.000Z";
const recent = "2026-11-24T00:00:00.000Z";

const notes = [
  { id: "inbox", path: "Notes/Inbox/a.md", content_hash: "a", updated_at: old, deleted_at: null },
  { id: "task", path: "Notes/タスク/task.md", content_hash: "b", updated_at: recent, deleted_at: null },
  { id: "improve", path: "Notes/改善/improve.md", content_hash: "c", updated_at: old, deleted_at: null },
  { id: "share", path: "Notes/AI共有/share.md", content_hash: "d", updated_at: recent, deleted_at: null },
  { id: "history", path: "Notes/履歴/history.md", content_hash: "e", updated_at: old, deleted_at: null },
  { id: "outside", path: "Notes/思考/outside.md", content_hash: "f", updated_at: old, deleted_at: null },
  { id: "deleted", path: "Notes/Inbox/deleted.md", content_hash: "g", updated_at: old, deleted_at: "2026-11-20T00:00:00Z" }
];
const telegramNotes = [
  { id: "tg-old", content_hash: "t1", updated_at: old, deleted_at: null },
  { id: "tg-new", content_hash: "t2", updated_at: recent, deleted_at: null },
  { id: "tg-deleted", content_hash: "t3", updated_at: old, deleted_at: "2026-11-20T00:00:00Z" }
];
const reviews = [
  { file_id: "review-inbox", path: "Notes/Inbox/a.md", classification: "needs_review", reason: "vault_pull_live_content_conflict" },
  { file_id: "review-history", path: "Notes/履歴/history.md", classification: "deferred", reason: "incomplete_vault_observation" }
];

const set = enumerateCirculationSet({ notes, telegramNotes, identityReviews: reviews });
assert.equal(set.all.length, 7, "履歴を含め、live の対象だけを集合に入れる");
assert.equal(set.patrol.length, 6, "履歴は日次巡回から除外する");
assert.equal(set.quarantined.length, 2, "履歴を含む隔離を数える");
assert.equal(set.patrolQuarantined.length, 1, "日次巡回範囲内の隔離だけを分離する");
assert.equal(set.effectivePatrol.length, 5, "隔離を実効対象から外す");
assert.equal(CIRCULATION_AUDIT_RULES.stagnantDays, 14);

const previous = [
  { source: "obsidian", note_id: "inbox", last_seen_hash: "a", first_seen_in_set_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-11-24T00:00:00Z", last_path: "Notes/Inbox/a.md" },
  { source: "obsidian", note_id: "task", last_seen_hash: "old-b", first_seen_in_set_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-11-24T00:00:00Z", last_path: "Notes/タスク/task.md" },
  { source: "telegram", note_id: "tg-old", last_seen_hash: "t1", first_seen_in_set_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-11-24T00:00:00Z", last_path: null },
  { source: "obsidian", note_id: "improve", last_seen_hash: "c", first_seen_in_set_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-11-24T00:00:00Z", last_path: "Notes/改善/improve.md" },
  { source: "obsidian", note_id: "removed", last_seen_hash: "gone", first_seen_in_set_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-11-24T00:00:00Z", last_path: "Notes/改善/removed.md" }
];
const changes = detectCirculationChanges(set.all, previous);
assert.equal(changes.added.length, 3, "新規に集合へ入った行を検出する");
assert.equal(changes.hashChanged.length, 1, "content_hash の変化を検出する");
assert.equal(changes.setOut.length, 1, "集合から出た行を検出する");
assert.equal(changes.changedCount, 5);

const plan = buildCirculationAuditPlan({
  notes, telegramNotes, identityReviews: reviews, previousState: previous, now
});
assert.equal(plan.findings.filter((item) => item.kind === "quarantined_overlap").length, 1);
assert.equal(plan.findings.filter((item) => item.kind === "stagnant").length, 1, "古いまま hash が変わっていない巡回対象だけを滞留とする");
assert.equal(plan.findings.filter((item) => item.kind === "pathless_aged").length, 1);
assert.equal(plan.findings.filter((item) => item.kind === "set_out").length, 1);
assert.equal(plan.stateRows.length, plan.all.length);
assert.equal(plan.stateRows.find((row) => row.note_id === "inbox").first_seen_in_set_at, previous[0].first_seen_in_set_at);
assert.equal(plan.stateRows.find((row) => row.note_id === "inbox").last_seen_at, new Date(now).toISOString());
console.log("Circulation audit enumeration, quarantine, change detection, and finding checks passed.");
