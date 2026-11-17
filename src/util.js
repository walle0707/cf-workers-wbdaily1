// src/util.js
// 纯函数工具层：响应信封 / 错误码 / 脱敏 / 编码 / 常量时间比较 / 时间与 ID。
// 本文件零依赖（只用运行时内置的 Web 标准 API），不得 import 其它模块。
// 约定：字符串引号一律 ASCII 直引号；注释用中文。

/**
 * 错误码 -> HTTP 状态映射。全局只允许使用这 8 个错误码，禁止自造。
 * @type {Readonly<Record<string, number>>}
 */
export const CODE = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
});

/** 统一 JSON 响应头（禁止第三方信封）。 */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * 业务异常。所有可预期的失败都抛它，由 index.js 顶层统一转成 fail() 响应。
 */
export class AppError extends Error {
  /**
   * @param {string} code CODE 中的错误码字符串，例如 'CONFLICT'
   * @param {string} message 面向调用方的中文提示，不得包含 token
   * @param {*} [detail] 附加信息，会放进响应体的 detail 字段
   * @param {{headers?:Record<string,string>}} [options] 额外响应头（如 429 的 Retry-After）
   */
  constructor(code, message, detail = null, options = {}) {
    super(typeof message === 'string' ? message : String(message));
    this.name = 'AppError';
    this.code = typeof code === 'string' && code ? code : 'INTERNAL';
    this.detail = detail === undefined ? null : detail;
    const headers = options && typeof options === 'object' ? options.headers : null;
    this.headers = headers && typeof headers === 'object' ? { ...headers } : {};
  }
}

/**
 * 成功信封：200 {ok:true, data}
 * @param {*} data 任意可 JSON 序列化的业务数据
 * @param {ResponseInit} [init] 额外响应选项（headers 可覆盖 content-type）
 * @returns {Response}
 */
export function ok(data, init = {}) {
  const options = init && typeof init === 'object' ? init : {};
  const headers = new Headers(options.headers || undefined);
  if (!headers.has('content-type')) headers.set('content-type', JSON_CONTENT_TYPE);
  // 业务响应一律不缓存（面板轮询 + Cookie 会话）
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  const body = JSON.stringify({ ok: true, data: data === undefined ? null : data });
  return new Response(body, {
    ...options,
    status: Number.isFinite(options.status) ? Number(options.status) : 200,
    headers,
  });
}

/**
 * 失败信封：{ok:false, error:{code, message}, detail?}
 * HTTP 状态由 CODE 映射决定，未知 code 一律回落 500。
 * @param {string} code 错误码字符串
 * @param {string} message 中文提示
 * @param {*} [extra] 非空时作为 detail 字段输出
 * @returns {Response}
 */
export function fail(code, message, extra, init) {
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE, code);
  const status = known ? CODE[code] : CODE.INTERNAL;
  const payload = {
    ok: false,
    error: {
      code: typeof code === 'string' && code ? code : 'INTERNAL',
      message: typeof message === 'string' ? message : String(message === undefined ? '' : message),
    },
  };
  if (extra !== undefined && extra !== null) payload.detail = extra;
  const options = init && typeof init === 'object' ? init : {};
  const headers = new Headers(options.headers || undefined);
  headers.set('content-type', JSON_CONTENT_TYPE);
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers });
}

/**
 * 清洗用户粘贴的 token：trim 后循环剥离 `Bearer ` 前缀（大小写不敏感，可多次出现）。
 * @param {*} raw 原始输入
 * @returns {string} 裸 token；非字符串输入返回空串
 */
export function sanitizeToken(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  // 循环剥离：`Bearer Bearer abc` 之类也要还原成 abc；
  // 单独的 `Bearer`（无后续内容）剥成空串；`BearerToken` 这种不算前缀，不剥。
  for (;;) {
    const matched = /^bearer(?:\s+|$)/i.exec(s);
    if (!matched) break;
    s = s.slice(matched[0].length).trim();
  }
  return s;
}

/**
 * 脱敏展示 token：长度 >= 12 返回 前4 + '****' + 后4，否则固定 '****'。
 * @param {*} t token
 * @returns {string}
 */
export function maskToken(t) {
  const chars = Array.from(typeof t === 'string' ? t : '');
  if (chars.length < 12) return '****';
  return chars.slice(0, 4).join('') + '****' + chars.slice(-4).join('');
}

/**
 * base64url 编码。
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {string} 不含 `=` 填充的 base64url
 */
export function b64urlEncode(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    bytes = new TextEncoder().encode(String(input === undefined ? '' : input));
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url 解码为字节数组（二进制安全原语）。
 * @param {string} s base64url 字符串（容忍缺失填充）
 * @returns {Uint8Array}
 */
export function b64urlDecode(s) {
  const normalized = String(s === undefined || s === null ? '' : s)
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/\s+/g, '');
  const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const binary = atob(normalized + '='.repeat(padLength));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * base64url 编码 UTF-8 文本（会话 payload 等文本场景的便捷封装）。
 * @param {string} text
 * @returns {string}
 */
export function b64urlEncodeText(text) {
  return b64urlEncode(typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text));
}

/**
 * base64url 解码为 UTF-8 文本（会话 payload 等文本场景的便捷封装）。
 * @param {string} s base64url 字符串
 * @returns {string}
 */
export function b64urlDecodeText(s) {
  return new TextDecoder().decode(b64urlDecode(s));
}

/**
 * 生成密码学随机字节并以 base64url 返回。
 * @param {number} [byteLen] 随机字节数，默认 32
 * @returns {string}
 */
export function randomB64(byteLen) {
  const n = Number.isFinite(byteLen) && byteLen > 0 ? Math.floor(byteLen) : 32;
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

/**
 * 常量时间比较：先各自 SHA-256，再逐字节 XOR 累加。
 * 摘要后长度恒为 32，因此不会泄露明文长度，也不会提前 return。
 * @param {*} a
 * @param {*} b
 * @returns {Promise<boolean>}
 */
export async function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(typeof a === 'string' ? a : String(a === undefined || a === null ? '' : a));
  const right = encoder.encode(typeof b === 'string' ? b : String(b === undefined || b === null ? '' : b));
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', left),
    crypto.subtle.digest('SHA-256', right),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

/**
 * 按字符截断字符串：超出 max 时保留 max-1 个字符再加 `…`，总长不超过 max。
 * 使用 Array.from 以按码点计数，避免截断代理对。
 * @param {*} s
 * @param {number} [max] 默认 200
 * @returns {string}
 */
export function truncate(s, max = 200) {
  const str = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 200;
  const chars = Array.from(str);
  if (chars.length <= limit) return str;
  if (limit <= 1) return '…';
  return chars.slice(0, limit - 1).join('') + '…';
}

/**
 * 毫秒时间戳 -> ISO8601 UTC（带毫秒）。无参时取当前时间。
 * 注意：这是全项目唯一允许直接调用 Date.now() 的工具函数。
 * @param {number} [ms]
 * @returns {string}
 */
export function isoNow(ms) {
  const t = Number.isFinite(ms) ? Math.floor(ms) : Date.now();
  return new Date(t).toISOString();
}

/**
 * @returns {string} `acc_<uuid>`
 */
export function newAccountId() {
  return `acc_${crypto.randomUUID()}`;
}

/**
 * @returns {string} `run_<uuid>`
 */
export function newRunId() {
  return `run_${crypto.randomUUID()}`;
}

/**
 * SHA-256 摘要，输出小写十六进制（用于 MCP Key 落盘，不存明文）。
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
