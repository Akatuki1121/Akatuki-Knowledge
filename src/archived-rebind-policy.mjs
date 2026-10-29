export const ARCHIVED_REBIND_TARGETS = Object.freeze([
  { path: "Notes/履歴/履歴 (YAOS conflict - disk from device-mv9dhgcw 2026-10-16T04-53-31Z).md", currentFileId: "WlGQsLovflZyZU_s", oldFileId: "I33EQMDJSKHBGwu0", syncUuid: "bbe5d2d2-7f1b-5126-be79-25c585385bb5" },
  { path: "Notes/Inbox/スマホを置いて走れる。Xiaomiの「Smart Band 10 Pro」が過去最安8千円台  ライフハッカー・ジャパン.md", currentFileId: "WBOFMy9GgGVQZ7uf", oldFileId: "aEmAL9YytKj9jsAB", syncUuid: "8fcc6b2e-02c3-57e7-8f7b-4c0722a188a4" },
  { path: "Notes/Inbox/How to be more ambitious A tutorial for humans with models.md", currentFileId: "ZZ3dcx5iw1IttE8h", oldFileId: "0H4LcCwoiQZcV2k4", syncUuid: "3f65dfa7-bb6b-541a-a4fa-52f6ebfee34b" },
  { path: "Notes/Inbox/無題のファイル.md", currentFileId: "xjda4ykuJod9UV67", oldFileId: "m_E8FOrL7kMvzzL8", syncUuid: "661a4f2d-9e6c-5299-9044-54d5295bce53" },
  { path: "Notes/Inbox/【依頼】Telegram上の知識bot「Akatuki knowledge」の仕様を一緒に詰めたい。.md", currentFileId: "mJzLFguxm4kkhxmA", oldFileId: "nsEAjQ7-OkoG29Jy", syncUuid: "94afba99-0012-511d-9969-0499f86e3a3d" },
  { path: "Notes/Inbox/akatuki-knowledge-triage.md", currentFileId: "xI1hOes1Xznnv9TG", oldFileId: "XrTSfF-A7rQ6qNBE", syncUuid: "737f562f-cdfd-5c5f-b4cf-438a3e1fd9b3" },
  { path: "Notes/Inbox/Akatuki-Knowledgeの記録.md", currentFileId: "p0oCIS2G-hAKwtfn", oldFileId: "gijPK-Ib3wFUGPwv", syncUuid: "3ef3e351-0420-56f4-b633-b2cdf481d0d2" },
  { path: "Notes/Inbox/M5Stamp-C3 Mate GPIO 注意点・検証メモ.md", currentFileId: "pVraKhyhv1AKzars", oldFileId: "TwF2Co0473bbMSwJ", syncUuid: "162b7002-3dbe-5f30-aa3b-cef60d85260c" }
]);

const TARGETS_BY_PATH = new Map(ARCHIVED_REBIND_TARGETS.map((target) => [target.path, target]));
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

export function validateArchivedRebind(input) {
  const target = TARGETS_BY_PATH.get(input?.path);
  if (!target) return { ok: false, error: "path_not_allowed" };
  if (input.expectedOldFileId !== target.oldFileId
    || input.expectedCurrentFileId !== target.currentFileId
    || input.expectedSyncUuid !== target.syncUuid) {
    return { ok: false, error: "identity_precondition_failed" };
  }
  if (!isHash(input.expectedD1Hash) || !isHash(input.expectedVaultHash)
    || input.actualD1Hash !== input.expectedD1Hash
    || input.actualVaultHash !== input.expectedVaultHash
    || input.note?.content_hash !== input.expectedD1Hash
    || input.vault?.contentHash !== input.expectedVaultHash
    || input.observation?.contentHash !== input.expectedVaultHash) {
    return { ok: false, error: "content_hash_precondition_failed" };
  }
  if (!input.observationComplete || input.observation?.path !== target.path
    || input.observation?.fileId !== target.currentFileId || input.observation?.deleted === true
    || input.vault?.path !== target.path || input.vault?.fileId !== target.currentFileId) {
    return { ok: false, error: "vault_observation_precondition_failed" };
  }
  const note = input.note;
  if (!note || note.id !== target.path || note.path !== target.path || !note.deleted_at) {
    return { ok: false, error: "archived_note_precondition_failed" };
  }
  if (!Array.isArray(input.mappings) || input.mappings.length !== 1) {
    return { ok: false, error: "identity_mapping_precondition_failed" };
  }
  const mapping = input.mappings[0];
  if (mapping.file_id !== target.oldFileId || mapping.note_id !== target.path
    || mapping.sync_uuid !== target.syncUuid || mapping.last_path !== target.path) {
    return { ok: false, error: "identity_mapping_precondition_failed" };
  }
  return { ok: true, target };
}

export function getArchivedRebindTarget(path) {
  return TARGETS_BY_PATH.get(path) ?? null;
}
