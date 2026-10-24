// AI による自動整理 (Issue #63 / #86) の実行経路。src/index.js から移動した関数群。
// 関数本文は移動前と同一。env.DB ・ ai-send-guard への依存は引数と import で解決し、
// src/index.js 側にあるヘルパー (json, callGemini, parseJsonObject, writeAudit, enqueueBotAlert) は
// createOrganizeRunner への注入によって渡す (sync-outbox.mjs と同じ方式)。
// 送信前の認証情報検査 (ai_allowed と inspectWholeContent) はここでは変更しない。
import { hasSensitiveCategory, inspectAndRedact, inspectWholeContent, selectSafeParagraphs } from "./ai-send-guard.mjs";
import { classifyOperationalFailure, describeSafeFailure } from "./log-sanitize.mjs";

export { classifyOperationalFailure };

// src/index.js のバンドル由来のヘルパー。移動した関数本文が内部で使うため同じ定義を置く。
const __name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });

// D1 の LIKE パターンは 50 バイト上限。検索語はこれを超えないよう切り詰める。
export const D1_LIKE_PATTERN_MAX_BYTES = 50;

export function describeOrganizeFailure(stage, source, error) {
  const { event: _event, ...described } = describeSafeFailure("organize_failed", error, { stage, source });
  return described;
}

export async function linkRelatedNotes(env, note, relatedTerms) {
  const ids = /* @__PURE__ */ new Map();
  const likePattern = (term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const usableTerms = relatedTerms.filter((term) => new TextEncoder().encode(likePattern(term)).length <= D1_LIKE_PATTERN_MAX_BYTES).slice(0, 4);
  const terms = usableTerms.map(likePattern);
  if (terms.length) {
    const conditions = terms.map(() => "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')").join(" OR ");
    const bindings = terms.flatMap((term) => [term, term, term]);
    const [matches, telegramMatches] = await Promise.all([
      env.DB.prepare(`SELECT id, title, content FROM notes WHERE deleted_at IS NULL AND id != ? AND (${conditions}) ORDER BY updated_at DESC LIMIT 16`).bind(note.id, ...bindings).all(),
      env.DB.prepare(`SELECT id, title, content FROM telegram_notes WHERE deleted_at IS NULL AND id != ? AND (${conditions}) ORDER BY updated_at DESC LIMIT 16`).bind(note.id, ...bindings).all()
    ]);
    for (const match2 of [...matches.results, ...telegramMatches.results]) {
      const text2 = `${match2.title}
${match2.content}`;
      const score = usableTerms.filter((term) => text2.toLocaleLowerCase().includes(term.toLocaleLowerCase())).length;
      if (score) ids.set(match2.id, score);
    }
  }
  const related = [...ids.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  await env.DB.prepare("DELETE FROM note_relations WHERE source_note_id = ?").bind(note.id).run();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const [targetId, score] of related) {
    await env.DB.prepare("INSERT INTO note_relations (source_note_id, target_note_id, score, created_at) VALUES (?, ?, ?, ?)").bind(note.id, targetId, score, now).run();
  }
  return related.map(([id2]) => id2);
}

// バンドル内ヘルパーを注入して organizePending を組み立てる。本文は移動前と同一。
export function createOrganizeRunner({ json, callGemini, parseJsonObject, writeAudit, enqueueBotAlert }) {
async function organizePending(env, requestedLimit = 2, requestedIds = null) {
  if (!env.GEMINI_API_KEY || !env.DB) return json({ error: "GEMINI_API_KEY is not configured" }, 503);
  const limit = Math.max(1, Math.min(5, Number(requestedLimit) || 2));
  const onlyIds = Array.isArray(requestedIds) ? [...new Set(requestedIds.filter((id2) => typeof id2 === "string" && id2))].slice(0, 5) : null;
  const selectPending = /* @__PURE__ */ __name((table) => {
    const idFilter = onlyIds === null ? "" : onlyIds.length ? ` AND id IN (${onlyIds.map(() => "?").join(",")})` : " AND 1 = 0";
    return env.DB.prepare(`SELECT id, title, content, content_hash, updated_at, sensitivity, '${table === "notes" ? "obsidian" : "telegram"}' AS source FROM ${table} WHERE deleted_at IS NULL AND ai_allowed = 1 AND review_state = 'ready' AND (next_retry_at IS NULL OR next_retry_at <= ?) AND (organized_hash IS NULL OR organized_hash != content_hash)${idFilter} ORDER BY updated_at ASC LIMIT ?`).bind((/* @__PURE__ */ new Date()).toISOString(), ...onlyIds || [], limit);
  }, "selectPending");
  const [obsidian, telegram] = await Promise.all([
    selectPending("notes").all(),
    selectPending("telegram_notes").all()
  ]);
  const results = [...obsidian.results, ...telegram.results].sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, limit);
  let organized = 0, failed = 0, blocked = 0;
  for (const note of results) {
    const table = note.source === "telegram" ? "telegram_notes" : "notes";
    let stage = "privacy_check";
    try {
      const inspected = inspectWholeContent(note.content, env);
      if (!inspected.ok) {
        blocked++;
        await env.DB.prepare(`UPDATE ${table} SET ai_allowed = 0, review_state = 'blocked_credentials', sensitivity = 'credentials', next_retry_at = NULL WHERE id = ? AND content_hash = ?`).bind(note.id, note.content_hash).run();
        await writeAudit(env, "organize", 1, inspected.findings, 0, "blocked");
        continue;
      }
      stage = "prompt_build";
      // Organize only independently inspected, non-sensitive passages. The stored source note is never rewritten.
      const safeTitleInspection = inspectAndRedact(note.title || "", { blocklist: env.PRIVACY_BLOCKLIST || "" });
      const safeTitle = safeTitleInspection.ok && !hasSensitiveCategory(safeTitleInspection.findings)
        ? safeTitleInspection.text
        : "[機微情報を含む項目]";
      const selectedParagraphs = selectSafeParagraphs(note.content, env.PRIVACY_BLOCKLIST || "");
      if (!selectedParagraphs.ok) throw new Error("AI excerpt failed credential inspection");
      const safeContent = selectedParagraphs.paragraphs.join("\n\n").slice(0, 12e3);
      if (!safeContent) {
        // A wholly sensitive note cannot be meaningfully organized without exposing its content.
        // Hold only this case for explicit review; notes with safe passages continue through automatic organization.
        await env.DB.prepare(`UPDATE ${table} SET sensitivity = 'sensitive', review_state = 'pending_confirmation', next_retry_at = NULL WHERE id = ? AND content_hash = ? AND ai_allowed = 1`).bind(note.id, note.content_hash).run();
        await writeAudit(env, "organize", 1, inspected.findings, 0, "held_sensitive_no_safe_excerpt");
        continue;
      }
      const prompt = `次のノートから、機微情報を含まない抜粋だけを整理してください。要約・タグ・関連語は提供された抜粋の範囲に限り、ノート全体について推測しないでください。意味を変えず、事実を追加せず、JSONだけを返してください。
形式: {"summary":"日本語で1〜3文の要約","tags":["短いタグ"],"related":["関連ノート検索用の語"],"knowledge_type":"fact|rationale|procedure","knowledge_scope":"project|general"}
タイトル: ${safeTitle}
knowledge_typeは事実・経緯、判断根拠、再利用できる手順のいずれか。knowledge_scopeは特定プロジェクトに限定される知識ならproject、幅広く再利用できる知識ならgeneral。既存のユーザータグは変更しません。タグ・relatedは各最大8個。
安全な抜粋:
${safeContent}`;
      stage = "gemini_call";
      const raw = await callGemini(env, prompt, 500);
      stage = "parse_result";
      const parsed = parseJsonObject(raw);
      const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 1500) : "";
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((x) => typeof x === "string").slice(0, 8) : [];
      const relatedTerms = Array.isArray(parsed.related) ? parsed.related.filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 8) : [];
      const knowledgeType = ["fact", "rationale", "procedure"].includes(parsed.knowledge_type) ? parsed.knowledge_type : note.knowledge_type || "unknown";
      const knowledgeScope = ["project", "general"].includes(parsed.knowledge_scope) ? parsed.knowledge_scope : note.knowledge_scope || "project";
      stage = "link_related";
      const linkedIds = await linkRelatedNotes(env, note, relatedTerms);
      stage = "save_result";
      await env.DB.prepare(`UPDATE ${table} SET summary = ?, ai_tags_json = ?, related_json = ?, knowledge_type = ?, knowledge_scope = ?, organized_hash = ?, organization_failures = 0, last_failure_stage = NULL, next_retry_at = NULL WHERE id = ? AND content_hash = ? AND ai_allowed = 1`).bind(summary, JSON.stringify(tags), JSON.stringify(linkedIds), knowledgeType, knowledgeScope, note.content_hash, note.id, note.content_hash).run();
      await writeAudit(env, "organize", 1, inspected.findings, prompt.length, "success");
      organized++;
    } catch (error) {
      await enqueueBotAlert(env, classifyOperationalFailure(error));
      console.error("organize failed", JSON.stringify(describeOrganizeFailure(stage, note.source, error)));
      const failedCount = await env.DB.prepare(`SELECT organization_failures FROM ${table} WHERE id = ?`).bind(note.id).first();
      const attempts = Math.min(10, Number(failedCount?.organization_failures || 0) + 1);
      const delayMinutes = Math.min(24 * 60, 15 * 2 ** (attempts - 1));
      const nextRetryAt = new Date(Date.now() + delayMinutes * 6e4).toISOString();
      await env.DB.prepare(`UPDATE ${table} SET organization_failures = ?, last_failure_stage = ?, next_retry_at = ?, review_state = 'ready' WHERE id = ? AND content_hash = ?`).bind(attempts, stage, nextRetryAt, note.id, note.content_hash).run();
      await writeAudit(env, "organize", 1, [], 0, "failed");
      failed++;
    }
  }
  return json({ ok: true, considered: results.length, organized, failed, blocked });
}
  return organizePending;
}
