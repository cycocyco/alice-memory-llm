// 敏感信息脱敏。记忆会落盘、还会被送去 embedding 服务商，所以入库前先擦。
// 只报命中类型和次数，日记里绝不回显密钥本身。

const PLACEHOLDER = (kind) => `[REDACTED:${kind}]`;

// 顺序有讲究：先擦结构化凭证，再擦键值对，最后擦长串
const RULES = [
  // PEM 私钥整块
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],

  // 常见厂商 token
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],

  // URL 里的账号密码：保留协议名，抹掉凭证
  ['url-credential', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi],

  // Authorization: Bearer xxx / Basic xxx
  ['auth-header', /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi],

  // key=value / "password": "xxx" 这类
  [
    'credential',
    /(?<![A-Za-z0-9])([A-Za-z0-9_.-]{0,24}(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]{0,12})\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
  ],

  // 裸 base64 大块与 64 位 hex（多为密钥/哈希/图片残留）
  ['base64-blob', /\b[A-Za-z0-9+/]{160,}={0,2}\b/g],
  ['hex64', /\b[0-9a-f]{64}\b/gi],
];

/**
 * @returns {{text: string, hits: Array<{rule: string, count: number}>}}
 */
export function redact(input) {
  let text = String(input ?? '');
  const hits = [];
  for (const [rule, pattern] of RULES) {
    let count = 0;
    text = text.replace(pattern, (...m) => {
      count += 1;
      // url-credential 保留协议头，方便认出这是哪个数据库
      if (rule === 'url-credential') return `${m[1]}${PLACEHOLDER('credential')}@`;
      if (rule === 'credential') return `${m[1]}=${PLACEHOLDER('credential')}`;
      if (rule === 'auth-header') return `${m[1]} ${PLACEHOLDER('token')}`;
      return PLACEHOLDER(rule);
    });
    if (count) hits.push({ rule, count });
  }
  return { text, hits };
}

/** 便捷包装：开关关掉时原样返回 */
export function maybeRedact(text, enabled = true) {
  if (!enabled) return { text: String(text ?? ''), hits: [] };
  return redact(text);
}
