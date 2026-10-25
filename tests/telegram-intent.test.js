// Issue #86: src/telegram-intent.mjs のモジュール契約テスト。
// Telegram 意図判定の純粋述語群を index.js から分離したため、文字列抽出では
// なくモジュールの振る舞いで検証する。述語は承認・巻き戻し・フォルダ整理等の
// ハンドラへの振り分けそのものなので、正規表現の境界 (句読点・語尾・
// 全角半角・前後空白) での一致が変わると誤振り分けになる。現行の一致意味論を
// そのまま固定する (意味論の変更はこの抽出には混ぜない)。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTelegramIntent } from "../src/telegram-intent.mjs";

const {
  isConversationSummaryRequest,
  extractReorganizationQuery,
  isUndoRequest,
  isPolicyUndoRequest,
  isImprovementApproval,
  isImprovementRejection,
  isImprovementStatusRequest,
  isFolderOrganizationRequest,
  isFolderOrganizationApproval,
  isFolderOrganizationRejection,
  validateOrganizationPath,
  isMemoryProcessingCandidate
} = createTelegramIntent();

// 移動した関数が Worker エントリポイントに実際に接続されていることを確認する。
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
test("index.js wires the telegram intent predicates from the module", () => {
  assert.ok(workerSource.includes('from "./telegram-intent.mjs"'), "index.js must import telegram-intent.mjs");
  assert.ok(workerSource.includes("createTelegramIntent()"), "index.js must instantiate the telegram intent predicates");
  // 安全ゲートは述語群に含めず index.js 側に残す。
  assert.ok(workerSource.includes("function isRestrictedImprovement"), "isRestrictedImprovement must stay in index.js");
});

test("isConversationSummaryRequest matches summary-and-save phrasings only", () => {
  assert.equal(isConversationSummaryRequest("ここまでの知識をまとめて保存して"), true);
  assert.equal(isConversationSummaryRequest("これまでの話を要約してナレッジに保存して"), true);
  // 要約だけ・保存だけでは一致しない (現行意味論)。
  assert.equal(isConversationSummaryRequest("この会話を要約して"), false);
  assert.equal(isConversationSummaryRequest("会話の内容をまとめて"), false);
  assert.equal(isConversationSummaryRequest("今日の天気は？"), false);
});

test("extractReorganizationQuery extracts the target with trim and length bounds", () => {
  assert.equal(extractReorganizationQuery("プロジェクト計画を再整理して"), "プロジェクト計画");
  assert.equal(extractReorganizationQuery("プロジェクト計画を整理し直して。"), "プロジェクト計画");
  assert.equal(extractReorganizationQuery("プロジェクト計画 もう一度整理して！"), "プロジェクト計画");
  // 前後の空白は抽出結果から取り除かれる。
  assert.equal(extractReorganizationQuery("  プロジェクト計画  を再整理"), "プロジェクト計画");
  // 対象外の文では null。
  assert.equal(extractReorganizationQuery("普通のメッセージです"), null);
  assert.equal(extractReorganizationQuery("再整理して"), null);
  // 最小2文字: 抽出対象が1文字しか取れない文は null。
  assert.equal(extractReorganizationQuery("あ再整理して"), null);
  assert.equal(extractReorganizationQuery("あい再整理して"), "あい");
  // 最大120文字: 120文字は通り、121文字は null。
  assert.equal(extractReorganizationQuery("x".repeat(120) + "を再整理して"), "x".repeat(120));
  assert.equal(extractReorganizationQuery("x".repeat(121) + "を再整理して"), null);
});

test("isUndoRequest matches only the fixed undo phrasings", () => {
  assert.equal(isUndoRequest("今のなし"), true);
  assert.equal(isUndoRequest("さっきの記録はなし。"), true);
  assert.equal(isUndoRequest("直前のメモを取り消して！"), true);
  assert.equal(isUndoRequest("記録を取り消して"), true);
  // 前後空白は許容される。
  assert.equal(isUndoRequest(" 今のなし "), true);
  // 語尾違いは一致しない。
  assert.equal(isUndoRequest("今のなしです"), false);
  assert.equal(isUndoRequest("さっきの記録を消して"), false);
});

test("isPolicyUndoRequest matches improvement rollback phrasings only", () => {
  assert.equal(isPolicyUndoRequest("改善案を戻して"), true);
  assert.equal(isPolicyUndoRequest("直前の改善設定を元に戻して。"), true);
  assert.equal(isPolicyUndoRequest("最後の改善を取り消して"), true);
  // 承認の文面は巻き戻しではない。
  assert.equal(isPolicyUndoRequest("改善案を反映して"), false);
});

test("isImprovementApproval matches only the fixed approval phrasings", () => {
  assert.equal(isImprovementApproval("改善案を反映して"), true);
  assert.equal(isImprovementApproval("それでいこう"), true);
  assert.equal(isImprovementApproval("その設定で！"), true);
  assert.equal(isImprovementApproval("次からそうして"), true);
  // 疑問形・丁寧形は承認として扱わない (現行意味論)。
  assert.equal(isImprovementApproval("反映して？"), false);
  assert.equal(isImprovementApproval("改善案を反映してください"), false);
});

test("isImprovementRejection matches only the fixed rejection phrasings", () => {
  assert.equal(isImprovementRejection("改善案はやめて"), true);
  assert.equal(isImprovementRejection("改善案は却下して"), true);
  assert.equal(isImprovementRejection("改善案は取り下げて。"), true);
  // 「を」は現行パターンに含まれないため一致しない (現行意味論)。
  assert.equal(isImprovementRejection("その改善案を却下して。"), false);
  assert.equal(isImprovementRejection("改善案を反映して"), false);
});

test("isImprovementStatusRequest matches status inquiry phrasings only", () => {
  assert.equal(isImprovementStatusRequest("改善候補を見せて"), true);
  assert.equal(isImprovementStatusRequest("反映待ちある？"), true);
  assert.equal(isImprovementStatusRequest("改善案は？"), true);
  assert.equal(isImprovementStatusRequest("改善案は?"), true);
  assert.equal(isImprovementStatusRequest("改善案を反映して"), false);
});

test("isFolderOrganizationRequest matches folder organization phrasings", () => {
  assert.equal(isFolderOrganizationRequest("フォルダを整理して"), true);
  assert.equal(isFolderOrganizationRequest("フォルダーの構成を見直したい"), true);
  assert.equal(isFolderOrganizationRequest("ノートをフォルダに分類する案を出して"), true);
  // 整理案への反応も依頼述語に一致する (承認/却下述語と併せて振り分ける現行意味論)。
  assert.equal(isFolderOrganizationRequest("フォルダ整理案を反映して"), true);
  assert.equal(isFolderOrganizationRequest("メモを整理して"), false);
});

test("isFolderOrganizationApproval matches only the fixed approval phrasings", () => {
  assert.equal(isFolderOrganizationApproval("フォルダ整理案を反映して"), true);
  assert.equal(isFolderOrganizationApproval("フォルダー整理案を実行して。"), true);
  assert.equal(isFolderOrganizationApproval("フォルダ整理案を適用して！"), true);
  assert.equal(isFolderOrganizationApproval("フォルダ整理案を反映してください"), false);
});

test("isFolderOrganizationRejection matches only the fixed rejection phrasings", () => {
  assert.equal(isFolderOrganizationRejection("フォルダ整理案を却下して"), true);
  assert.equal(isFolderOrganizationRejection("フォルダー整理案をやめて！"), true);
  assert.equal(isFolderOrganizationRejection("フォルダ整理案を取り下げて"), true);
  assert.equal(isFolderOrganizationRejection("フォルダ整理案を反映して"), false);
});

test("validateOrganizationPath normalizes and rejects unsafe paths", () => {
  // .md が補われ、パスの大文字小文字は保持される。
  assert.equal(validateOrganizationPath("Notes/プロジェクト"), "Notes/プロジェクト.md");
  assert.equal(validateOrganizationPath("AbC/DeF"), "AbC/DeF.md");
  assert.equal(validateOrganizationPath("Notes/メモ.md"), "Notes/メモ.md");
  // バックスラッシュはスラッシュへ正規化される。
  assert.equal(validateOrganizationPath("Notes\\Sub\\メモ"), "Notes/Sub/メモ.md");
  // 非文字列・空は null。
  assert.equal(validateOrganizationPath(123), null);
  assert.equal(validateOrganizationPath(""), null);
  assert.equal(validateOrganizationPath("   "), null);
  // 親参照・カレント参照・絶対パス・ドライブレターは null。
  assert.equal(validateOrganizationPath("../secret"), null);
  assert.equal(validateOrganizationPath("a/../b"), null);
  assert.equal(validateOrganizationPath("a/./b"), null);
  assert.equal(validateOrganizationPath("/absolute/path"), null);
  assert.equal(validateOrganizationPath("C:/drive/path"), null);
  // 禁止文字を含むセグメントは null。
  assert.equal(validateOrganizationPath("bad<name"), null);
  assert.equal(validateOrganizationPath("bad|name"), null);
  // 長さ上限は入力パスに対して 300 文字 (現行意味論)。
  assert.equal(validateOrganizationPath("a".repeat(300)), "a".repeat(300) + ".md");
  assert.equal(validateOrganizationPath("a".repeat(301)), null);
});

test("isMemoryProcessingCandidate requires 12+ chars and a memory keyword", () => {
  assert.equal(isMemoryProcessingCandidate("短い"), false);
  assert.equal(isMemoryProcessingCandidate("12345678901"), false);
  // 12文字でもキーワードが無ければ false。
  assert.equal(isMemoryProcessingCandidate("123456789012"), false);
  assert.equal(isMemoryProcessingCandidate("今日はとても良い天気で散歩しました"), false);
  // 日本語キーワードの代表一致。
  assert.equal(isMemoryProcessingCandidate("私は毎朝6時に起きるのが習慣です"), true);
  assert.equal(isMemoryProcessingCandidate("この設定を覚えておいてほしいです"), true);
  // 英字キーワードは大小文字を区別しない。
  assert.equal(isMemoryProcessingCandidate("Please remember this preference of mine"), true);
  assert.equal(isMemoryProcessingCandidate("PLEASE REMEMBER THIS ALWAYS OK"), true);
  // 非文字列は false。
  assert.equal(isMemoryProcessingCandidate(null), false);
  assert.equal(isMemoryProcessingCandidate(undefined), false);
});
