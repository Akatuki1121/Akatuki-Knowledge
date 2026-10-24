// AI 送信前の検査（認証情報・機微情報・個人情報の伏字）を 1 か所に集約したモジュール。
// src/index.js から import され、scripts/ と tests/ からも直接実行して検証できる。
// 注意: 検出は正規表現とキーワードによるベストエフォートであり、機微情報が存在しない保証ではない。
// 方針は docs/AI_SEND_POLICY.md を参照。

// 無料枠の Gemini へ送らない機微カテゴリ。カテゴリを増減するときはここだけを変える。
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
const SENSITIVE_INFO_RULES = [
  { id: "health", pattern: /病歴|既往歴|診断|処方薬|服薬|通院|Crohn'?s disease|クローン病|潰瘍性大腸炎|精神疾患|障害者手帳/iu },
  { id: "financial", pattern: /クレジットカード番号|カード番号|口座番号|マイナンバー|個人番号/iu },
  { id: "location", pattern: /自宅住所|住所は|住んでいる住所|番地|部屋番号/iu }
];
export function inspectAndRedact(value, { blocklist = "" } = {}) {
  if (typeof value !== "string") return { ok: false, text: "", findings: ["invalid_input"], blocked: true };
  if (value.length > 2e4) return { ok: false, text: "", findings: ["input_too_long"], blocked: true };
  const findings = [];
  for (const rule of SENSITIVE_INFO_RULES) {
    if (rule.pattern.test(value)) findings.push(rule.id);
  }
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
export function inspectWholeContent(content, env) {
  const findings = new Set();
  const chunkSize = 19e3;
  const overlap = 1e3;
  for (let start = 0; start < content.length; start += chunkSize - overlap) {
    const inspected = inspectAndRedact(content.slice(start, start + chunkSize), { blocklist: env.PRIVACY_BLOCKLIST || "" });
    for (const finding of inspected.findings) findings.add(finding);
  }
  const list = [...findings];
  const credentials = list.includes("credentials");
  return { ok: !credentials, findings: list, credentials };
}

// ノート本文を段落に分け、機微でない段落だけを伏字済みで返す。
// 認証情報を含む段落があれば ok: false（呼び出し側は送信しない）。
export function selectSafeParagraphs(content, blocklist = "") {
  const paragraphs = [];
  for (const paragraph of String(content || "").split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean)) {
    const inspected = inspectAndRedact(paragraph, { blocklist });
    if (!inspected.ok) return { ok: false, paragraphs: [] };
    if (hasSensitiveCategory(inspected.findings)) continue;
    if (inspected.text.trim()) paragraphs.push(inspected.text.trim());
  }
  return { ok: true, paragraphs };
}
