// AI 送信前の検査（認証情報の検出と個人情報の伏字）を 1 か所に集約したモジュール。
// src/index.js から import され、scripts/ と tests/ からも直接実行して検証できる。
// 注意: 検出は正規表現によるベストエフォートであり、認証情報が存在しない保証ではない。
// 方針は docs/AI_SEND_POLICY.md を参照。
//
// 2026-10-25 の所有者方針変更: 送信ブロックは認証情報・シークレット検出
// (credentials) のみとし、機微語リスト（診断・クローン病・服薬・部屋番号・
// 金融系キーワードなど）によるカテゴリ検出と送信ブロックは廃止した。
// inspectAndRedact は health / financial / location を findings に出さない。
// 個人情報の伏字 (REDACTION_RULES) と認証情報のマスクは従来どおり維持する。
//
// 2026-11-09 の所有者決定: Gemini は既に無く、内部の AI は自己改善用の
// Workers AI だけになったため、Gemini 時代の残骸は撤去した。具体的には、
// ノート書き込み時に本文全体を走査して ai_allowed=0 / review_state=
// 'blocked_credentials' を付ける経路 (inspectWholeContent とその呼び出し)
// と、消費側が消滅していた Telegram 履歴向けの関数群 (selectSafeParagraphs /
// planTelegramHistory / selectAiSafeHistory) を削除した。このモジュールに
// 残るのは、プロンプト等の送信直前に使う inspectAndRedact だけである。

// 機微カテゴリの定義（履歴互換のため残す）。現在の inspectAndRedact は
// カテゴリを findings に出さないため、hasSensitiveCategory は実入力では
// 常に false を返し、各送信境界のカテゴリ判定は発火しない。
// カテゴリ検出を復活させる場合は、このモジュールでのみ行うこと。
export const SENSITIVE_CATEGORIES = Object.freeze(["health", "financial", "location"]);

export function hasSensitiveCategory(findings) {
  return (findings || []).some((finding) => SENSITIVE_CATEGORIES.includes(finding));
}

const REDACTION_RULES = [
  { id: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, replacement: "[EMAIL]" },
  { id: "phone", pattern: /(?<!\d)(?:\+81[-\s]?)?0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}(?!\d)/gu, replacement: "[PHONE]" },
  { id: "postal_code", pattern: /(?<!\d)〒?\d{3}[-ー]?\d{4}(?!\d)/gu, replacement: "[POSTAL_CODE]" },
  { id: "bank_account", pattern: /((?:銀行口座|口座)番号(?:は|が|[:=：])?\s*)\d{6,14}(?!\d)/giu, replacement: "$1[ACCOUNT_NUMBER]" },
  { id: "card_number", pattern: /((?:クレジットカード|カード)番号(?:は|が|[:=：])?\s*)(?:\d[ -]?){13,19}(?!\d)/giu, replacement: "$1[CARD_NUMBER]" },
  { id: "personal_id", pattern: /((?:マイナンバー|個人番号)(?:は|が|[:=：])?\s*)\d{12}(?!\d)/giu, replacement: "$1[PERSONAL_ID]" },
  { id: "street_address", pattern: /((?:自宅住所|住所)(?:は|が|[:=：])\s*)[^\n。！？!?]{3,100}/giu, replacement: "$1[ADDRESS]" },
  { id: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, replacement: "[IP_ADDRESS]" },
  { id: "url_query", pattern: /https?:\/\/[^\s?#]+\?[^\s#]*/giu, replacement: "[URL_WITH_QUERY]" }
];
const CREDENTIAL_RULES = [
  { id: "api_key", pattern: /\b(?:AIza[0-9A-Za-z_-]{25,}|sk-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu },
  { id: "credential_assignment", pattern: /(?<![A-Za-z0-9_])["']?(?:password|passwd|passphrase|パスワード|api[_ -]?key|apiキー|access[_ -]?token|refresh[_ -]?token|secret|client_secret|private[_ -]?key|秘密鍵|認証トークン|authorization|auth[_ -]?token|token|credential|credentials|cookie|session)["']?(?![A-Za-z0-9_])\s*[:=：]\s*(?:"[^"\r\n]{1,}"|'[^'\r\n]{1,}'|[^\s"',;]{1,})/giu },
  { id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/giu },
  { id: "private_key_block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu }
];
export function inspectAndRedact(value, { blocklist = "" } = {}) {
  if (typeof value !== "string") return { ok: false, text: "", findings: ["invalid_input"], blocked: true };
  if (value.length > 2e4) return { ok: false, text: "", findings: ["input_too_long"], blocked: true };
  // 機微語リストによるカテゴリ検出は廃止済み (2026-10-25 方針変更)。
  // findings に health / financial / location は出ない。ブロック理由は
  // 認証情報の検出と、入力として送れない構造的な理由だけに限る。
  const findings = [];
  let text2 = value;
  let credentialDetected = false;
  for (const rule of CREDENTIAL_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text2)) {
      findings.push("credentials", rule.id);
      credentialDetected = true;
      rule.pattern.lastIndex = 0;
      text2 = text2.replace(rule.pattern, "[CREDENTIAL_BLOCKED]");
    }
  }
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text2)) {
      findings.push(rule.id);
      rule.pattern.lastIndex = 0;
      text2 = text2.replace(rule.pattern, rule.replacement);
    }
  }
  const terms = blocklist.split(/[\n,、]/u).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 100);
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (text2.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
      findings.push(`custom_${i + 1}`);
      text2 = text2.replace(new RegExp(escapeRegExp(term), "giu"), "[REDACTED]");
    }
  }
  const uniqueFindings = [...new Set(findings)];
  const blocked = credentialDetected || uniqueFindings.includes("invalid_input") || uniqueFindings.includes("input_too_long");
  return { ok: !blocked, text: text2, findings: uniqueFindings, blocked };
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
