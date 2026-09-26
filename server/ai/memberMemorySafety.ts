/**
 * Deterministic write filters for member memory.
 *
 * The English threat patterns are ported from NousResearch Hermes Agent
 * `tools/threat_patterns.py` (commit d0288be5, MIT; see THIRD_PARTY_NOTICES.md),
 * "strict" scope — the scope Hermes uses for memory writes because every entry is
 * re-injected into future system prompts. Hermes-specific paths
 * (`~/.hermes/.env`, `.hermes/config.yaml`) are omitted. Chinese patterns and the
 * credential detector are Tongpin additions: memory must never hold passwords,
 * keys, tokens, verification codes or ID/card/bank numbers.
 */

/** Bounded scan: the filters are advisory guards, keep worst-case runtime flat. */
const MAX_SCAN_CHARS = 16_384;
/** Bounded filler between attack words (Hermes `_FILLER`). */
const F = String.raw`(?:\w+\s+){0,8}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const MODIFY = String.raw`(?:update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;

const THREAT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Classic prompt injection.
  [new RegExp(String.raw`ignore\s+${F}(?:previous|all|above|prior)\s+${F}instructions`, "i"), "prompt_injection"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [new RegExp(String.raw`disregard\s+${F}(?:your|all|any)\s+${F}(?:instructions|rules|guidelines)`, "i"), "disregard_rules"],
  [new RegExp(String.raw`act\s+as\s+(?:if|though)\s+${F}you\s+${F}(?:have\s+no|don't\s+have)\s+${F}(?:restrictions|limits|rules)`, "i"), "bypass_restrictions"],
  [/<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i, "html_comment_injection"],
  [/<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i, "hidden_div"],
  [/translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(?:execute|run|eval)\b/i, "translate_execute"],
  [new RegExp(String.raw`do\s+not\s+${F}tell\s+${F}the\s+user`, "i"), "deception_hide"],
  // Role / identity hijack.
  [new RegExp(String.raw`you\s+are\s+${F}now\s+(?:a|an|the)\s+`, "i"), "role_hijack"],
  [new RegExp(String.raw`pretend\s+${F}(?:you\s+are|to\s+be)\s+`, "i"), "role_pretend"],
  [new RegExp(String.raw`output\s+${F}(?:system|initial)\s+prompt`, "i"), "leak_system_prompt"],
  [new RegExp(String.raw`(?:respond|answer|reply)\s+without\s+${F}(?:restrictions|limitations|filters|safety)`, "i"), "remove_filters"],
  [new RegExp(String.raw`you\s+have\s+been\s+${F}(?:updated|upgraded|patched)\s+to`, "i"), "fake_update"],
  [/\bname\s+yourself\s+\w+/i, "identity_override"],
  // C2 / promptware vocabulary.
  [/register\s+(?:as\s+)?a?\s*node/i, "c2_node_registration"],
  [/(?:heartbeat|beacon|check[\s-]?in)\s+(?:to|with)\s+/i, "c2_heartbeat"],
  [/pull\s+(?:down\s+)?(?:new\s+)?task(?:ing|s)?\b/i, "c2_task_pull"],
  [/connect\s+to\s+the\s+network\b/i, "c2_network_connect"],
  [/you\s+must\s+(?:\w+\s+){0,3}(?:register|connect|report|beacon)\b/i, "forced_action"],
  [/only\s+use\s+one[\s-]?liners?\b/i, "anti_forensic_oneliner"],
  [new RegExp(String.raw`never\s+${F}(?:create|write)\s+${F}(?:script|file)\s+${F}disk`, "i"), "anti_forensic_disk"],
  [/unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*/i, "env_var_unset_agent"],
  [/\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b/i, "known_c2_framework"],
  [/\bc2\s+(?:server|channel|infrastructure|beacon)\b/i, "c2_explicit"],
  [/\bcommand\s+and\s+control\b/i, "c2_explicit_long"],
  // Exfiltration.
  [new RegExp(String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, "i"), "exfil_curl"],
  [new RegExp(String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, "i"), "exfil_wget"],
  [/cat\s+[^\n]{0,2048}(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  [/(?:send|post|upload|transmit)\s+[^\n]{0,2048}\s+(?:to|at)\s+https?:\/\//i, "send_to_url"],
  [new RegExp(String.raw`(?:include|output|print|share)\s+${F}(?:conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "i"), "context_exfil"],
  // Persistence.
  [/authorized_keys/i, "ssh_backdoor"],
  [/(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME\/\.ssh|~\/\.ssh)/i, "ssh_access"],
  [new RegExp(String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "i"), "agent_config_mod"],
  // Tongpin: Chinese equivalents. Memory is declarative facts about a member;
  // anything shaped like an instruction to the assistant is refused.
  [/(?:忽略|无视|忘掉|忘记|抛开|不要理会|不用管)[^\n。]{0,12}(?:之前|以上|上面|前面|先前|所有|全部|原有|原来)的?[^\n。]{0,6}(?:指令|指示|规则|设定|要求|提示词|系统提示)/, "zh_prompt_injection"],
  [/(?:绕过|突破|解除|关闭|无视)[^\n。]{0,8}(?:安全|限制|规则|审核|过滤)/, "zh_disregard_rules"],
  [/你(?:现在|从现在起|从此|今后|以后)(?:就)?是(?:一个|一名|一位|个)?/, "zh_role_hijack"],
  [/(?:假装|扮演|伪装成)(?:你是|成为|成|一个|一名)/, "zh_role_pretend"],
  [/(?:输出|泄露|透露|打印|显示|复述)[^\n。]{0,8}(?:系统提示|系统指令|提示词|系统设定|system\s*prompt)|(?:系统提示|系统指令|提示词|系统设定|system\s*prompt)[^\n。]{0,8}(?:输出|泄露|透露|打印|显示|复述|发给|告诉)/i, "zh_leak_system_prompt"],
  [/(?:不要|别|不得|切勿)[^\n。]{0,6}(?:告诉|透露给|通知)(?:用户|成员|本人)/, "zh_deception_hide"],
  [/越狱|开发者模式|DAN\s*模式|无限制模式|jailbreak/i, "zh_jailbreak"],
  [/(?:发送|上传|转发|提交|同步)[^\n]{0,60}(?:到|至|给)[^\n]{0,10}https?:\/\//, "zh_send_to_url"],
  [/(?:输出|发送|导出|分享|泄露)[^\n。]{0,10}(?:对话记录|聊天记录|上下文|历史消息|其他成员)/, "zh_context_exfil"],
  [/(?:给我|为我|帮我|自动)[^\n。]{0,6}(?:提升|提高|增加|开通|授予)[^\n。]{0,6}(?:权限|额度|配额)|(?:无限|不限)(?:额度|权限|配额)|管理员权限/, "zh_privilege"],
  [/(?:自动|直接|无需确认|不用确认|跳过确认)[^\n。]{0,8}(?:执行|调用工具|运行命令|操作电脑|付款|转账|删除文件)/, "zh_tool_abuse"],
  // Nothing may imitate the rendered memory block or a system turn. Patterns
  // run on NFKC text, where full-width （ ） ： fold to ( ) :.
  [/<\/?\s*member_memory|成员档案[（(]关于|记忆[（(]AI 的工作笔记[）)]|═{3,}|系统消息|系统设置[:：]|\[system\]|^\s*system\s*:/im, "memory_block_spoof"],
];

/** Hermes INVISIBLE_CHARS plus LRM/RLM/ALM directional marks. */
const INVISIBLE_CHARS = /[​‌‍‎‏؜⁠⁢⁣⁤﻿‪-‮⁦-⁩]/;

/** Pattern id of the first threat in `content`, or null. */
export function scanMemoryThreat(content: string): string | null {
  if (!content) return null;
  const bounded = content.slice(0, MAX_SCAN_CHARS);
  const invisible = bounded.match(INVISIBLE_CHARS);
  // Checked on the raw text: NFKC can strip these code points.
  if (invisible) return `invisible_unicode_U+${invisible[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  // NFKC folds full-width variants (ｉｇｎｏｒｅ → ignore) against homograph bypass.
  const normalized = bounded.normalize("NFKC");
  for (const [pattern, id] of THREAT_PATTERNS) if (pattern.test(normalized)) return id;
  return null;
}

const SHOUTY_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Credential-shaped spans: [global pattern, reason id, optional exemption for the captured value]. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string, ((value: string) => boolean)?]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "private_key"],
  // Naming the concept is fine ("钱包私钥不得写入日志"); a value is not.
  [/(?:助记词|mnemonic|seed\s*phrase|私钥|private\s*key)\s*(?:是|为|:|：|=|＝)\s*\S{4,}/gi, "wallet_secret"],
  // BIP39-style mnemonic: 12–24 short lowercase words in a row.
  [/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, "wallet_secret"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, "api_key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "api_key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "api_key"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "api_key"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "api_key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "api_key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "api_key"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "api_key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "token"],
  [/\b(?:0x)?[0-9a-fA-F]{64}\b/g, "private_key"],
  [/https?:\/\/[^\s/:@]+:[^\s/@]+@/g, "url_credentials"],
  // Keyword followed by a credential-looking value (Latin/digits, not prose).
  // Hermes #116221: a SHOUTY_SNAKE value names where a secret lives; it is not one.
  [/(?:密码|口令|pass(?:word|wd|code)|pwd|pin\s*码|pin|密钥|秘钥|api[\s_-]?key|access[\s_-]?key|secret|token|令牌|凭证|cookie|session)\s*(?:是|为|:|：|=|＝)\s*["'“‘]?([A-Za-z0-9!@#$%^&*()_+\-=.,/?~]{4,})/gi, "credential", value => SHOUTY_SNAKE.test(value.replace(/["'”’]$/, ""))],
  [/\b(?:password|passcode|pwd)\s+is\s+\S{4,}/gi, "credential"],
  [/(?:验证码|校验码|动态码|动态密码|短信码|确认码|授权码|otp|one[-\s]?time\s+(?:code|password)|verification\s+code|2fa\s+code)\D{0,8}[A-Za-z0-9]{4,8}/gi, "verification_code"],
  [/(?:身份证|银行卡|信用卡|储蓄卡|卡号|账号|帐号|账户|护照|社保号)[^\n。]{0,8}\d{6,}/g, "account_number"],
  // 18-digit mainland ID, and any 12–23 digit run (bank cards, account numbers).
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, "id_number"],
  [/(?<!\d)(?:\d[ -]?){11,22}\d(?!\d)/g, "account_number"],
];
/** Long random-looking tokens (mixed letters and digits). */
const GENERIC_TOKEN = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const HARDCODED_SECRET = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi;

interface SecretSpan { start: number; end: number; reason: string }

function secretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  const bounded = text.slice(0, MAX_SCAN_CHARS);
  for (const [pattern, reason, exempt] of SECRET_PATTERNS) {
    for (const match of bounded.matchAll(pattern)) {
      if (exempt && match[1] !== undefined && exempt(match[1])) continue;
      spans.push({ start: match.index, end: match.index + match[0].length, reason });
    }
  }
  for (const match of bounded.matchAll(GENERIC_TOKEN)) {
    // A public wallet/contract address is useful project memory, not a credential.
    if (!ETH_ADDRESS.test(match[0])) spans.push({ start: match.index, end: match.index + match[0].length, reason: "token" });
  }
  for (const match of bounded.matchAll(HARDCODED_SECRET)) {
    // Hermes #116221: naming an environment variable is not embedding a secret.
    if (!SHOUTY_SNAKE.test(match[1])) spans.push({ start: match.index, end: match.index + match[0].length, reason: "credential" });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Reason id of the first credential-shaped span, or null. */
export function detectMemorySecret(content: string): string | null {
  return secretSpans(content)[0]?.reason ?? null;
}

/** Replace credential-shaped spans before text leaves for the reviewer model. */
export function redactMemorySecrets(content: string): string {
  const spans = secretSpans(content);
  if (!spans.length) return content;
  let result = "", cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    result += content.slice(cursor, Math.max(cursor, span.start)) + "[已隐藏的敏感信息]";
    cursor = span.end;
  }
  return result + content.slice(cursor);
}

export type MemoryContentRejection = { code: "AI_MEMORY_SECRET"; reason: string } | { code: "AI_MEMORY_UNSAFE"; reason: string };

/** Single gate for every write path (member panel and background review). */
export function rejectMemoryContent(content: string): MemoryContentRejection | null {
  const secret = detectMemorySecret(content);
  if (secret) return { code: "AI_MEMORY_SECRET", reason: secret };
  const threat = scanMemoryThreat(content);
  if (threat) return { code: "AI_MEMORY_UNSAFE", reason: threat };
  return null;
}
