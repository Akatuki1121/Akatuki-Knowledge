export const AGENT_MEMORY_KINDS = Object.freeze([
  "fact",
  "preference",
  "constraint",
  "decision",
  "temporary_state",
  "procedure",
  "hypothesis",
]);

export function legacyKnowledgeTypeForMemory(memoryKind) {
  if (memoryKind === "decision") return "rationale";
  if (memoryKind === "procedure") return "procedure";
  return "fact";
}

const MEMORY_STATUS = Object.freeze({
  active: "active",
  unverified: "unverified",
  conflicted: "conflicted",
  forgotten: "forgotten",
  superseded: "superseded",
});
const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function normalizedText(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ja-JP");
}

export function deriveAgentMemoryTrust(input) {
  if (!input
    || typeof input.userMessage !== "string"
    || typeof input.sourceQuote !== "string"
    || !input.sourceQuote.trim()
    || !normalizedText(input.userMessage).includes(normalizedText(input.sourceQuote))
    || !Number.isFinite(input.confidence)
    || input.confidence < 0.85) {
    return "inferred";
  }
  if (input.requestedTrust === "user_confirmed"
    && /(?:今後|これから).{0,30}(?:として扱|で記録|を採用|で確定|にする)|(?:正しいのは|正解は|採用するのは).{1,80}(?:です|だ|にする|を採用|で確定)/u.test(input.userMessage)) {
    return "user_confirmed";
  }
  return input.requestedTrust === "user_stated" ? "user_stated" : "inferred";
}

export function shouldOmitStoredMemory(message) {
  if (typeof message !== "string") return false;
  return /(?:記憶|覚え|記録|保存|メモ|ノート)(?:しないで|ないで|しない|しなくて|残さないで)|(?:この話|この件|この内容).{0,20}(?:覚えないで|記録しないで|保存しないで|メモしないで|忘れて|記憶しないで)|(?:記憶から消して|記録を消して|保存した内容を削除)|(?:don't\s+(?:remember|save|store|record|note)|forget\s+(?:this|that|it)|stop remembering)/iu.test(message);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAgentMemoryMetadata(input) {
  if (!input
    || !["obsidian", "telegram"].includes(input.source)
    || typeof input.noteId !== "string"
    || !input.noteId.trim()
    || typeof input.content !== "string"
    || !input.content.trim()
    || !AGENT_MEMORY_KINDS.includes(input.memoryKind)
    || typeof input.memoryKey !== "string"
    || input.memoryKey.trim().length < 2
    || input.memoryKey.trim().length > 160
    || (input.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.contentHash))) {
    throw new TypeError("Invalid agent memory input");
  }

  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError("Invalid agent memory confidence");
  }
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const now = new Date(nowMs).toISOString();
  const contentHash = typeof input.contentHash === "string" && /^[a-f0-9]{64}$/u.test(input.contentHash)
    ? input.contentHash
    : await sha256Hex(normalizedText(input.content));
  const trustLevel = ["user_stated", "user_confirmed"].includes(input.trustLevel) && confidence >= 0.85
    ? input.trustLevel
    : "inferred";
  const status = input.memoryKind === "hypothesis" || trustLevel === "inferred"
    ? MEMORY_STATUS.unverified
    : MEMORY_STATUS.active;
  let expiresAt = null;
  if (input.memoryKind === "temporary_state") {
    const requestedExpiry = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
    const expiryMs = Number.isFinite(requestedExpiry)
      ? Math.min(Math.max(requestedExpiry, nowMs), nowMs + MAX_TTL_MS)
      : nowMs + MEMORY_TTL_MS;
    expiresAt = new Date(expiryMs).toISOString();
  }

  return {
    source: input.source,
    noteId: input.noteId.trim(),
    memoryKind: input.memoryKind,
    trustLevel,
    status,
    confidence,
    sourceRef: typeof input.sourceRef === "string" && input.sourceRef.trim()
      ? input.sourceRef.trim().slice(0, 256)
      : input.noteId.trim(),
    memoryKeyHash: await sha256Hex(normalizedText(input.memoryKey)),
    valueHash: await sha256Hex(normalizedText(input.content)),
    contentHash,
    recordedAt: now,
    updatedAt: now,
    confirmedAt: trustLevel === "user_confirmed" ? now : null,
    expiresAt,
  };
}

export async function isAgentMemorySuppressed(db, metadata) {
  const row = await db.prepare(`
    SELECT suppression_id FROM agent_memory_suppressions
    WHERE content_hash = ?
       OR memory_key_hash = ?
       OR value_hash = ?
    LIMIT 1
  `).bind(metadata.contentHash, metadata.memoryKeyHash, metadata.valueHash).first();
  return Boolean(row);
}

export async function prepareAgentMemoryMetadataStatements(db, metadata) {
  const previous = await db.prepare(`
    SELECT 1 FROM agent_memory_metadata
    WHERE memory_key_hash = ?
      AND value_hash <> ?
      AND status IN ('active', 'unverified', 'conflicted')
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).bind(metadata.memoryKeyHash, metadata.valueHash, metadata.updatedAt).first();
  const resolvingConflict = metadata.trustLevel === "user_confirmed";
  const status = resolvingConflict ? metadata.status : previous ? MEMORY_STATUS.conflicted : metadata.status;
  const statements = resolvingConflict ? [
    db.prepare(`
      UPDATE agent_memory_metadata
      SET status = 'superseded', updated_at = ?
      WHERE memory_key_hash = ?
        AND value_hash <> ?
        AND status IN ('active', 'unverified', 'conflicted')
    `).bind(metadata.updatedAt, metadata.memoryKeyHash, metadata.valueHash),
  ] : [];
  statements.push(
    db.prepare(`
      INSERT INTO agent_memory_metadata (
        source, note_id, memory_kind, trust_level, status, confidence, source_ref,
        memory_key_hash, value_hash, content_hash, recorded_at, updated_at, confirmed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, note_id, memory_key_hash, value_hash) DO UPDATE SET
        memory_kind = excluded.memory_kind,
        trust_level = excluded.trust_level,
        status = CASE
          WHEN agent_memory_metadata.status = 'conflicted' AND excluded.trust_level <> 'user_confirmed' THEN 'conflicted'
          ELSE excluded.status
        END,
        confidence = excluded.confidence,
        source_ref = excluded.source_ref,
        content_hash = excluded.content_hash,
        confirmed_at = COALESCE(excluded.confirmed_at, agent_memory_metadata.confirmed_at),
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).bind(
      metadata.source,
      metadata.noteId,
      metadata.memoryKind,
      metadata.trustLevel,
      status,
      metadata.confidence,
      metadata.sourceRef,
      metadata.memoryKeyHash,
      metadata.valueHash,
      metadata.contentHash,
      metadata.recordedAt,
      metadata.updatedAt,
      metadata.confirmedAt,
      metadata.expiresAt,
    ),
  );
  if (previous && !resolvingConflict) {
    statements.push(db.prepare(`
      UPDATE agent_memory_metadata
      SET status = 'conflicted', updated_at = ?
      WHERE memory_key_hash = ?
        AND value_hash <> ?
        AND status IN ('active', 'unverified', 'conflicted')
        AND (expires_at IS NULL OR expires_at > ?)
    `).bind(metadata.updatedAt, metadata.memoryKeyHash, metadata.valueHash, metadata.updatedAt));
  }
  return { metadata: { ...metadata, status }, statements };
}

export async function saveAgentMemoryMetadata(db, metadata) {
  const prepared = await prepareAgentMemoryMetadataStatements(db, metadata);
  await db.batch(prepared.statements);
  return prepared.metadata;
}

export function buildAgentMemorySuppressionStatements(db, input) {
  if (!input
    || !["obsidian", "telegram"].includes(input.source)
    || typeof input.noteId !== "string"
    || !input.noteId.trim()
    || typeof input.contentHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(input.contentHash)
    || typeof input.createdAt !== "string") {
    throw new TypeError("Invalid agent memory suppression input");
  }

  return [
    db.prepare(`
      INSERT OR IGNORE INTO agent_memory_suppressions (
        source, note_id, content_hash, memory_key_hash, value_hash, created_at
      )
      SELECT ?, ?, ?, memory_key_hash, value_hash, ?
      FROM agent_memory_metadata
      WHERE source = ? AND note_id = ?
      UNION ALL
      SELECT ?, ?, ?, NULL, NULL, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_memory_metadata WHERE source = ? AND note_id = ?
      )
    `).bind(
      input.source,
      input.noteId.trim(),
      input.contentHash,
      input.createdAt,
      input.source,
      input.noteId.trim(),
      input.source,
      input.noteId.trim(),
      input.contentHash,
      input.createdAt,
      input.source,
      input.noteId.trim(),
    ),
    db.prepare(`
      UPDATE agent_memory_metadata
      SET status = 'forgotten', updated_at = ?
      WHERE source = ? AND note_id = ?
    `).bind(input.createdAt, input.source, input.noteId.trim()),
  ];
}
