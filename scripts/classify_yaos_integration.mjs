#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const base = process.env.BASE_SHA ?? "";
const head = process.env.HEAD_SHA ?? "";
const outputFile = process.env.GITHUB_OUTPUT;
const sourceChanged = process.env.SOURCE_CHANGED !== "false";
let required = sourceChanged;
let reason = sourceChanged
  ? "比較対象を確認できないため安全側で結合テストを実行"
  : "ソースコード変更がないため分類対象外";

const shaPattern = /^[0-9a-f]{40}$/i;
if (sourceChanged && shaPattern.test(base) && shaPattern.test(head)) {
  try {
    const diff = execFileSync("git", [
      "diff", "--no-ext-diff", "--unified=20", base, head, "--", "src/index.js",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const changedLines = diff
      .split("\n")
      .filter(line => (/^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---")))
      .join("\n");
    // index.js is a large legacy entry point. Run the end-to-end YAOS test
    // only when changed lines touch sync, note-mutation, identity, or conflict
    // handling. If this classifier cannot inspect the diff, it fails closed.
    const syncSensitive = /enqueueSyncJob|drainSyncOutbox|yaos_sync_jobs|sync[_-]?uuid|syncOutbox|outbox|sync\/status|api\/sync|api\/notes|YJS_CLIENT|\bYAOS\b|vault_content_conflict|ambiguous_sync_(?:identity|uuid)|unsafe_path|note_revisions|telegram_note_revisions|applyKnowledgeSyncJob|knowledge-sync|source_modified_at|deleted_at|readUuid|isValidSyncUuid|syncIdentity|sync_identity|correction|restore|archive|SYNC_/i;
    required = syncSensitive.test(diff);
    reason = required
      ? "src/index.js の変更行が同期・ノート変更の保護対象に該当"
      : "src/index.js の変更行に同期・ノート変更の保護対象は見つからず";
  } catch (error) {
    required = true;
    reason = "差分判定に失敗したため安全側で結合テストを実行";
  }
}

if (outputFile) appendFileSync(outputFile, `required=${required}\n`);
console.log(`YAOS integration required: ${required}. ${reason}`);
