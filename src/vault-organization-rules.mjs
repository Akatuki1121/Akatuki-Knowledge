// 保管庫の整理自動化・段階1 (記録と分類だけ) の第0層の分類規則。
// 純粋関数だけを置く。DB・AI・時刻には触らない。
// 設計: docs/VAULT_ORGANIZATION.md と設計書 (vault-auto-organization-design.md) §3・§4。
//
// 段階1では分類の結果を記録するだけで、ノートへの操作は一切しない。
// 規則は上から順 (K1 → K2 → K3 → K4) に評価し、最初に一致したものだけを
// 根拠にする。複数の宛先が競合する一致は規則では決めない (曖昧な語は
// 対応表に載せない) のが初版の原則で、決まらないものは Workers AI (第1層)
// へ回り、それでも決まらなければ段0 (Inbox に残す) になる。

// 宛先フォルダの集合 (いずれも Notes/ の下)。設計 §0.5 で実在を確認した
// フォルダから、AI共有と「私について」を外したもの (J4: 性質上、自動の
// 分類先から外す側を初期値にする)。Inbox 自身も宛先にしない (残留は段0)。
export const VAULT_ORGANIZATION_TARGET_FOLDERS = Object.freeze([
  "履歴",
  "ツール",
  "原ゼミ最終課題",
  "改善",
  "Tailscale",
  "日常",
  "原ゼミマイコンカー",
  "プログラムワークショップIV",
  "アル丸スマッシュ",
  "Purge",
  "Akatuki-Knowledge",
  "電子工作",
]);

// 第0層の規則が読む本文の冒頭の長さと、第1層 (Workers AI) へ渡す冒頭の
// 長さ。AI へは全文を渡さない (設計 §11)。
export const VAULT_ORGANIZATION_RULE_HEAD_CHARS = 1_000;
export const VAULT_ORGANIZATION_AI_HEAD_CHARS = 800;
export const VAULT_ORGANIZATION_AI_MAX_OUTPUT_TOKENS = 512;

// X1: 認証情報を含むノートは、名前の一致だけで常時除外する (絶対に触らない)。
const EXCLUDED_NOTE_PATH = "Notes/Inbox/Akatuki-Knowledge E2E 発行用の環境変数.md";
// X1: 題やパスに認証情報を思わせる固定の語があれば、疑わしい側に倒して
// 除外にする。本文は開かない。
const CREDENTIAL_PATH_WORDS = Object.freeze([
  "環境変数",
  "認証情報",
  "credential",
  "credentials",
  "APIキー",
  "apiキー",
  "API key",
  "api_key",
  "apikey",
  "秘密鍵",
  "private key",
  "パスワード",
  "password",
  "secret",
]);
// X2: コンフリクト名の付いたファイルは、この仕組みでは触らない
// (扱いは既存の決まりに委ねる)。
const CONFLICT_PATH_MARKER = " (YAOS conflict";

/**
 * 常時除外の判定。パスと題だけで判定し、本文は受け取らない。
 * 除外なら { ruleId: "X1" | "X2" }、そうでなければ null を返す。
 */
export function checkVaultNoteExclusion(input) {
  const path = typeof input?.path === "string" ? input.path : "";
  const title = typeof input?.title === "string" ? input.title : "";
  if (path.includes(CONFLICT_PATH_MARKER)) return { ruleId: "X2" };
  if (path === EXCLUDED_NOTE_PATH) return { ruleId: "X1" };
  const haystack = (path + "\n" + title).toLowerCase();
  if (CREDENTIAL_PATH_WORDS.some((word) => haystack.includes(word.toLowerCase()))) {
    return { ruleId: "X1" };
  }
  return null;
}

const DATE_AT_TITLE_START = /^\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日)/u;
const DATE_ANYWHERE = /(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日)/u;
const WEEKDAY_MARKER = /(?:[（(][月火水木金土日](?:曜日)?[）)]|[月火水木金土日]曜日)/u;

// K1 日常の記録: 題が日付で始まるか、題と冒頭が日記の型 (日付と曜日が
// ある) なら Notes/日常 への段1の候補にする。J6 (日常の判定規則の
// 具体形) は未確定で、段階1では候補として記録するだけに留まる。
function matchDailyRecord(title, contentHead) {
  if (DATE_AT_TITLE_START.test(title)) return true;
  const combined = title + "\n" + contentHead;
  return DATE_ANYWHERE.test(combined) && WEEKDAY_MARKER.test(combined);
}

// K2 の対象から日常を外す。日常は K1 の日付と日記の型だけで決める。
// 「日常」の語そのものは本文に普通に現れるため、フォルダ名の一致では
// 決めない。
const FOLDER_NAME_MATCH_FOLDERS = Object.freeze(
  VAULT_ORGANIZATION_TARGET_FOLDERS.filter((folder) => folder !== "日常"),
);

// K2 フォルダ名そのものの一致: 題または冒頭に宛先フォルダ名そのものが
// 現れ、他の宛先フォルダ名が現れない場合だけ決める。
function matchFolderName(title, contentHead) {
  const combined = title + "\n" + contentHead;
  const matched = FOLDER_NAME_MATCH_FOLDERS.filter((folder) => combined.includes(folder));
  return matched.length === 1 ? matched[0] : null;
}

// K3 題材語の対応表。一意に決まる組だけを載せる。競合する語 (原ゼミ、
// GPIO や回路の語) は載せず、Workers AI へ回す。
// contextPatterns は本文の冒頭に要る授業の文脈語で、題材語だけでは
// 決めない組に付ける。
const TOPIC_RULES = Object.freeze([
  Object.freeze({
    words: Object.freeze(["Skybox", "キューブマップ"]),
    contextPatterns: Object.freeze([/第[0-9０-９]+回/u, "演習", "課題", "授業", "講義"]),
    targetFolder: "プログラムワークショップIV",
  }),
  Object.freeze({
    words: Object.freeze(["くるくるかいろくん"]),
    contextPatterns: null,
    targetFolder: "原ゼミ最終課題",
  }),
]);

function matchesContext(contentHead, contextPatterns) {
  if (!contextPatterns) return true;
  return contextPatterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(contentHead) : contentHead.includes(pattern));
}

function matchTopicRule(title, contentHead) {
  const combined = title + "\n" + contentHead;
  for (const rule of TOPIC_RULES) {
    if (!rule.words.some((word) => combined.includes(word))) continue;
    if (!matchesContext(contentHead, rule.contextPatterns)) continue;
    return rule.targetFolder;
  }
  return null;
}

// K4 ウェブクリップの型: 題に媒体名が付いているか、区切りと定型の
// 案内文の組み合わせがあれば、段2 (整形) の候補として記録する。
// 宛先はこの規則では決めない。
const CLIP_MEDIA_NAMES = Object.freeze([
  "ライフハッカー",
  "ITmedia",
  "GIGAZINE",
  "ギズモード",
  "Impress Watch",
  "PC Watch",
  "ケータイ Watch",
  "窓の杜",
  "マイナビニュース",
  "TechCrunch",
  "Engadget",
]);
const CLIP_BOILERPLATE_WORDS = Object.freeze([
  "この記事",
  "公開日",
  "最終更新",
  "プライバシー",
  "Cookie",
  "クッキー",
  "©",
]);

function matchWebClip(title, contentHead) {
  if (CLIP_MEDIA_NAMES.some((name) => title.includes(name))) return true;
  const hasSeparator = title.includes("｜") || title.includes(" | ");
  if (!hasSeparator) return false;
  return /https?:\/\//u.test(contentHead)
    || CLIP_BOILERPLATE_WORDS.some((word) => contentHead.includes(word));
}

function decided(ruleId, targetFolder, stage) {
  return { ruleId, targetFolder, targetPath: "Notes/" + targetFolder, stage };
}

/**
 * 第0層の分類。入力は題と本文の冒頭 (先頭
 * VAULT_ORGANIZATION_RULE_HEAD_CHARS 字まで)。
 * 決まれば { ruleId, targetFolder, targetPath, stage }、K4 だけが当たれば
 * 宛先なしの { ruleId: "K4", targetFolder: null, targetPath: null, stage: 2 }、
 * 決まらなければ null を返す。
 */
export function classifyVaultNoteByRules(input) {
  const title = typeof input?.title === "string" ? input.title : "";
  const contentHead = typeof input?.contentHead === "string" ? input.contentHead : "";
  if (matchDailyRecord(title, contentHead)) return decided("K1", "日常", 1);
  const folderByName = matchFolderName(title, contentHead);
  if (folderByName) return decided("K2", folderByName, 1);
  const folderByTopic = matchTopicRule(title, contentHead);
  if (folderByTopic) return decided("K3", folderByTopic, 1);
  if (matchWebClip(title, contentHead)) {
    return { ruleId: "K4", targetFolder: null, targetPath: null, stage: 2 };
  }
  return null;
}

/**
 * 第1層 (Workers AI) へ渡すプロンプト。宛先は対象フォルダの集合だけを
 * 列挙し、AI共有と「私について」は含めない。入力は題と冒頭だけ。
 */
export function buildVaultClassificationPrompt(input) {
  const title = typeof input?.title === "string" ? input.title : "";
  const contentHead = typeof input?.contentHead === "string" ? input.contentHead : "";
  const folderList = VAULT_ORGANIZATION_TARGET_FOLDERS.map((folder) => "- " + folder).join("\n");
  return [
    "あなたはノートの分類器です。次のノートの題と本文の冒頭を読み、置き場所として最も合うフォルダを1つ選んでください。",
    "",
    "宛先フォルダの候補 (いずれも Notes/ の下のフォルダ名):",
    folderList,
    "",
    "ルール:",
    "- 候補に無いフォルダは選ばないでください。",
    "- どれにも合わない場合は target を null にしてください。",
    "- 返答は次の形の JSON オブジェクト1つだけにしてください: {\"target\": \"<フォルダ名 or null>\", \"confidence\": <0.0から1.0の数値>, \"reason\": \"<短い根拠>\"}",
    "",
    "題: " + title,
    "本文の冒頭:",
    contentHead,
  ].join("\n");
}

/**
 * 段2 (整形) のうち段階2で実行する唯一の操作: 空白の正規化。
 * 行末の空白 (半角空白とタブ) の除去、3行以上の連続空行を1行への圧縮、
 * 末尾の改行を1つに揃える、だけを行う。本文の文字そのものには触らない。
 * 冪等で、既に正規化済みの本文はそのまま返す。
 */
export function normalizeVaultNoteWhitespace(content) {
  if (typeof content !== "string" || content === "") return "";
  const lines = content.split("\n").map((line) => line.replace(/[ \t]+$/u, ""));
  const out = [];
  let pendingBlanks = 0;
  const flushBlanks = () => {
    const count = pendingBlanks >= 3 ? 1 : pendingBlanks;
    for (let i = 0; i < count; i++) out.push("");
    pendingBlanks = 0;
  };
  for (const line of lines) {
    if (line === "") {
      pendingBlanks++;
      continue;
    }
    flushBlanks();
    out.push(line);
  }
  // 末尾の空行は落とし、改行1つで終える (flushBlanks は呼ばない)。
  return out.join("\n") + "\n";
}

/**
 * R4 の機械照合: 2つの本文の差が空白だけであることを確かめる。
 * 空白を全部除いた文字列が一致し、かつ本文の行 (行末の空白を除いた
 * 空でない行) の並びが一致する場合だけ true を返す。行の結合や分割、
 * 行頭の空白の変化も「空白だけの差」とはみなさない。
 */
export function isWhitespaceOnlyChange(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  if (before.replace(/\s+/gu, "") !== after.replace(/\s+/gu, "")) return false;
  const significantLines = (text) => text.split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .filter((line) => line !== "");
  const a = significantLines(before);
  const b = significantLines(after);
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * 第1層の応答の解釈。読めない応答、宛先集合に無いフォルダ、数値でない
 * 確信度は「AI では決まらない」として null を返す (失敗とは別に扱う)。
 * 形が整っていれば { decided, target, targetPath, confidence, reason } を
 * 返し、target が null の応答は decided: false で返す。
 */
export function parseVaultClassificationResponse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    && parsed.confidence >= 0 && parsed.confidence <= 1
    ? parsed.confidence
    : null;
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";
  if (parsed.target === null || parsed.target === undefined) {
    return { decided: false, target: null, targetPath: null, confidence, reason };
  }
  if (typeof parsed.target !== "string"
    || !VAULT_ORGANIZATION_TARGET_FOLDERS.includes(parsed.target)
    || confidence === null) {
    return null;
  }
  return {
    decided: true,
    target: parsed.target,
    targetPath: "Notes/" + parsed.target,
    confidence,
    reason,
  };
}
