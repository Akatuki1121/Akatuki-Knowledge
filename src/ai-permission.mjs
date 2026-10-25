// AI 送信許可の一括確認・反映 (Issue #61 / #86)。src/index.js から移動した関数群。
// 関数本文は移動前と同一。ai-send-guard への依存 (inspectWholeContent /
// hasSensitiveCategory) は createBulkAiPermission への注入で解決し
// (src/gemini-client.mjs と同じ方式)、このモジュールは Worker
// エントリポイントに依存しない。許可判定・ハッシュ照合・確認状態の
// 保存と失効・承認フローの条件と順序は変更しない。

// 依存を注入して一括 AI 許可の関数群を組み立てる。本文は移動前と同一。
export function createBulkAiPermission({ inspectWholeContent, hasSensitiveCategory }) {
function isBulkAiPermissionRequest(message) {
  return /^(?:AI送信許可|AI許可)を?(?:安全に)?一括(?:確認|設定|許可)(?:して)?[。.!！]?$/u.test(message.trim());
}
function isBulkAiPermissionApproval(message) {
  return /^(?:AI送信許可|AI許可)を一括反映して[。.!！]?$/u.test(message.trim());
}
function isBulkAiPermissionRejection(message) {
  return /^(?:AI送信許可|AI許可)の一括許可案を(?:却下して|取り下げて|やめて)[。.!！]?$/u.test(message.trim());
}
async function inspectBulkAiPermissionCandidates(env) {
  const { results } = await env.DB.prepare("SELECT id, content, content_hash, ai_allowed FROM notes WHERE deleted_at IS NULL AND path IS NOT NULL").all();
  let credentials = 0;
  let sensitive = 0;
  let alreadyAllowed = 0;
  const eligible = [];
  const credentialAllowed = [];
  const sensitiveCandidates = [];
  for (const note of results || []) {
    const content = typeof note.content === "string" ? note.content : "";
    const candidate = { id: note.id, content, contentHash: note.content_hash ?? null };
    const inspection = inspectWholeContent(content, env);
    if (inspection.credentials) {
      credentials++;
      if (note.ai_allowed === 1) credentialAllowed.push(candidate);
      continue;
    }
    if (hasSensitiveCategory(inspection.findings)) {
      sensitive++;
      sensitiveCandidates.push(candidate);
      continue;
    }
    if (note.ai_allowed === 1) alreadyAllowed++;
    else eligible.push(candidate);
  }
  return { total: (results || []).length, eligible, credentials, credentialAllowed, sensitive, sensitiveCandidates, alreadyAllowed };
}
async function hashBulkAiPermissionContent(content) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function proposeBulkAiPermission(env, chatId) {
  let scan;
  try {
    scan = await inspectBulkAiPermissionCandidates(env);
  } catch {
    return "一括許可の確認状態を保存できないため、処理を中止しました。データベースの準備が必要です。ノートは変更していません。";
  }
  const previewNotes = [];
  for (const [action, notes] of [["allow", scan.eligible], ["revoke", scan.credentialAllowed], ["hold", scan.sensitiveCandidates]]) {
    for (const note of notes) {
      previewNotes.push({
        id: String(note.id),
        hash: await hashBulkAiPermissionContent(note.content),
        action
      });
    }
  }
  if (previewNotes.length > 1000) {
    return "対象ノートが1000件を超えたため、一括許可を安全に固定できませんでした。ノートは変更していません。対象を絞ってください。";
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  try {
    await env.DB.prepare("DELETE FROM bot_ai_permission_previews WHERE chat_id = ?").bind(chatId).run();
    await env.DB.prepare("INSERT INTO bot_ai_permission_previews (chat_id, candidates_json, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'pending')")
      .bind(chatId, JSON.stringify(previewNotes), now.toISOString(), expiresAt).run();
  } catch {
    return "一括許可の確認状態を保存できないため、処理を中止しました。必要なデータベース移行が未適用の可能性があります。ノートは変更していません。";
  }
  if (!previewNotes.length) {
    return "AI送信許可の一括確認が完了しました。対象ノート: " + scan.total + "件 / 新たに許可できるノート: 0件 / 認証情報を検出: " + scan.credentials + "件 / 機微情報を含むノート: " + scan.sensitive + "件 / 既に許可済み（安全確認済み）: " + scan.alreadyAllowed + "件。ノートは変更していません。";
  }
  return "AI送信許可の一括反映待ちです。\n"
    + "対象ノート: " + scan.total + "件\n"
    + "新たに許可できるノート: " + scan.eligible.length + "件\n"
    + "認証情報を検出: " + scan.credentials + "件（許可対象から除外し、既に許可済みなら許可を解除）\n"
    + "機微情報のため確認待ち: " + scan.sensitive + "件（許可設定は変更せず、本文を送信する処理から除外）\n"
    + "既に許可済み（安全確認済み）: " + scan.alreadyAllowed + "件\n"
    + "この確認は10分で失効します。\n\n"
    + "この時点では設定を変更していません。許可対象を確認し、反映する場合だけ「AI送信許可を一括反映して」と送ってください。確認時点の対象ノートだけを反映します。";
}
async function applyBulkAiPermission(env, chatId) {
  let preview;
  try {
    preview = await env.DB.prepare("SELECT candidates_json, expires_at, status FROM bot_ai_permission_previews WHERE chat_id = ?").bind(chatId).first();
  } catch {
    return "一括許可の確認状態を読み出せないため、処理を中止しました。ノートは変更していません。";
  }
  if (!preview || preview.status !== "pending") {
    return "先に「AI送信許可を一括確認して」で対象件数を確認してください。許可設定は変更していません。";
  }
  const latestAssistant = await env.DB.prepare("SELECT content, created_at FROM telegram_messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").bind(chatId).first();
  if (!latestAssistant?.content?.includes("AI送信許可の一括反映待ちです")
    || Date.parse(latestAssistant.created_at) < Date.parse(preview.created_at)) {
    return "直近の確認結果と一致しないため、反映を中止しました。もう一度「AI送信許可を一括確認して」と送ってください。ノートは変更していません。";
  }
  if (Date.parse(preview.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM bot_ai_permission_previews WHERE chat_id = ?").bind(chatId).run();
    return "一括許可の確認が期限切れです。もう一度「AI送信許可を一括確認して」と送ってください。ノートは変更していません。";
  }
  let candidates;
  try {
    candidates = JSON.parse(preview.candidates_json);
    if (!Array.isArray(candidates) || candidates.length > 1000 || candidates.some((item) =>
      !item || typeof item.id !== "string" || !/^[a-f0-9]{64}$/u.test(item.hash) || !["allow", "revoke", "hold"].includes(item.action))) {
      throw new Error("invalid_preview");
    }
  } catch {
    await env.DB.prepare("DELETE FROM bot_ai_permission_previews WHERE chat_id = ?").bind(chatId).run();
    return "一括許可の確認データが不正なため中止しました。もう一度確認してください。ノートは変更していません。";
  }
  const now = new Date().toISOString();
  let changed = 0;
  let revoked = 0;
  let held = 0;
  let credentials = 0;
  let skipped = 0;
  let alreadyAllowed = 0;
  for (let offset = 0; offset < candidates.length; offset += 50) {
    const chunk = candidates.slice(offset, offset + 50);
    const { results: rows } = await env.DB.prepare("SELECT id, content, content_hash, ai_allowed FROM notes WHERE deleted_at IS NULL AND path IS NOT NULL AND id IN (" + chunk.map(() => "?").join(", ") + ")").bind(...chunk.map((item) => item.id)).all();
    const notesById = new Map((rows || []).map((row) => [String(row.id), row]));
    const statements = [];
    const actions = [];
    for (const candidate of chunk) {
      const note = notesById.get(candidate.id);
      if (!note || typeof note.content !== "string" || await hashBulkAiPermissionContent(note.content) !== candidate.hash) {
        skipped++;
        continue;
      }
      const inspection = inspectWholeContent(note.content, env);
      const hasCredentials = inspection.credentials;
      const isSensitive = hasSensitiveCategory(inspection.findings);
      if (hasCredentials) credentials++;
      if (candidate.action === "allow" && (hasCredentials || isSensitive || note.ai_allowed === 1)) {
        if (!hasCredentials && !isSensitive) alreadyAllowed++;
        skipped++;
        continue;
      }
      if (candidate.action === "revoke" && (!hasCredentials || note.ai_allowed !== 1)) {
        skipped++;
        continue;
      }
      if (candidate.action === "hold" && (!isSensitive || hasCredentials)) {
        skipped++;
        continue;
      }
      const statement = candidate.action === "allow"
        ? env.DB.prepare("UPDATE notes SET ai_allowed = 1, sensitivity = 'user-approved', review_state = 'ready', next_retry_at = NULL WHERE id = ? AND deleted_at IS NULL AND ai_allowed = 0 AND content_hash IS ? AND content = ?")
            .bind(note.id, note.content_hash ?? null, note.content)
        : candidate.action === "revoke"
          ? env.DB.prepare("UPDATE notes SET ai_allowed = 0, sensitivity = 'credentials', review_state = 'blocked_credentials', next_retry_at = NULL WHERE id = ? AND deleted_at IS NULL AND ai_allowed = 1 AND content_hash IS ? AND content = ?")
              .bind(note.id, note.content_hash ?? null, note.content)
          : env.DB.prepare("UPDATE notes SET sensitivity = 'sensitive', review_state = 'ready', next_retry_at = NULL WHERE id = ? AND deleted_at IS NULL AND content_hash IS ? AND content = ?")
              .bind(note.id, note.content_hash ?? null, note.content);
      statements.push(statement);
      actions.push(candidate.action);
    }
    if (statements.length) {
      const batchResults = await env.DB.batch(statements);
      batchResults.forEach((result, index) => {
        if (result.meta?.changes) {
          if (actions[index] === "allow") changed++;
          else if (actions[index] === "revoke") revoked++;
          else if (actions[index] === "hold") held++;
        } else skipped++;
      });
    }
  }
  await env.DB.prepare("DELETE FROM bot_ai_permission_previews WHERE chat_id = ? AND status = 'pending'").bind(chatId).run();
  return "AI送信許可の一括反映が完了しました。\n"
    + "新たに許可: " + changed + "件\n"
    + "認証情報検出: " + credentials + "件\n"
    + "認証情報検出により許可解除: " + revoked + "件\n"
    + "機微情報ノートの安全処理へ移行: " + held + "件\n"
    + "内容変更・状態変化・競合で見送り: " + skipped + "件\n"
    + "既に許可済み（安全確認済み）: " + alreadyAllowed + "件\n\n"
    + "確認時点の対象だけを再検査し、本文が一致したノートだけを変更しました。";
}
async function rejectBulkAiPermission(env, chatId) {
  try {
    const result = await env.DB.prepare("DELETE FROM bot_ai_permission_previews WHERE chat_id = ? AND status = 'pending'").bind(chatId).run();
    return result.meta?.changes
      ? "AI送信許可の一括許可案を取り下げました。ノートは変更していません。"
      : "取り下げる一括許可案はありません。ノートは変更していません。";
  } catch {
    return "一括許可の確認状態を取り下げられませんでした。ノートは変更していません。";
  }
}
  return { isBulkAiPermissionRequest, isBulkAiPermissionApproval, isBulkAiPermissionRejection, proposeBulkAiPermission, applyBulkAiPermission, rejectBulkAiPermission };
}
