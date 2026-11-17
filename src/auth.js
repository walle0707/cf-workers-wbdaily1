// src/auth.js
// 密码哈希/校验（PBKDF2-SHA256）、HMAC 会话签发/验签、Cookie 解析构造、内存限流器。
// 约束：不得访问 env、不得调用全局 fetch、不得调用 Date.now()（时间一律经参数注入）。

import { b64urlDecodeText, b64urlEncode, b64urlEncodeText, safeEqual } from './util.js';

/** 会话 Cookie 名（ARCHITECTURE §9.9）。 */
export const SESSION_COOKIE_NAME = 'wb_session';

/** 会话有效期（秒），7 天。 */
export const SESSION_TTL_SEC = 604800;

/** PBKDF2 迭代数边界（免费版 10ms CPU 约束，见 ARCHITECTURE §1.1）。 */
const MIN_ITERATIONS = 10000;
const MAX_ITERATIONS = 200000;
const DEFAULT_ITERATIONS = 30000;

/** salt 长度（字节）。 */
const SALT_BYTES = 16;

/**
 * 把迭代数约束到 [10000, 200000]，非法值回落 30000。
 * @param {*} value
 * @returns {number}
 */
function clampIterations(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return DEFAULT_ITERATIONS;
  const int = Math.floor(n);
  if (int < MIN_ITERATIONS) return MIN_ITERATIONS;
  if (int > MAX_ITERATIONS) return MAX_ITERATIONS;
  return int;
}

/**
 * 字节数组 -> 标准 base64（带填充，非 base64url）。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 标准 base64 -> 字节数组。
 * @param {string} str
 * @returns {Uint8Array}
 */
function base64ToBytes(str) {
  const binary = atob(String(str === undefined || str === null ? '' : str));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * PBKDF2-SHA256 派生 256bit。
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Promise<Uint8Array>}
 */
async function deriveBits(password, salt, iterations) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * HMAC-SHA256 签名。
 * @param {string} secret 密钥字符串
 * @param {string} message 待签名文本
 * @returns {Promise<Uint8Array>}
 */
async function hmacSha256(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * 把注入的时间归一化成毫秒数。
 * @param {*} now 毫秒数，或返回毫秒数的函数
 * @returns {number}
 */
function toMillis(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(value) ? value : 0;
}

/**
 * 计算 PBKDF2 哈希记录。
 * @param {string} password 明文密码
 * @param {{iterations?:number}} [options]
 * @returns {Promise<{passwordHash:string, salt:string, iterations:number}>} 均 base64
 */
export async function hashPassword(password, options = {}) {
  const plain = typeof password === 'string' ? password : String(password === undefined || password === null ? '' : password);
  const iterations = clampIterations(options && options.iterations);
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await deriveBits(plain, salt, iterations);
  return {
    passwordHash: bytesToBase64(derived),
    salt: bytesToBase64(salt),
    iterations,
  };
}

/**
 * 校验密码。用记录内的 iterations 重算（不是当前 env 值），任何异常都返回 false。
 * @param {string} password 明文密码
 * @param {{passwordHash?:string, salt?:string, iterations?:number}} authRecord
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, authRecord) {
  try {
    if (!authRecord || typeof authRecord !== 'object') return false;
    const passwordHash = authRecord.passwordHash;
    const salt = authRecord.salt;
    if (typeof passwordHash !== 'string' || !passwordHash) return false;
    if (typeof salt !== 'string' || !salt) return false;
    const plain = typeof password === 'string' ? password : String(password === undefined || password === null ? '' : password);
    const derived = await deriveBits(plain, base64ToBytes(salt), clampIterations(authRecord.iterations));
    return await safeEqual(bytesToBase64(derived), passwordHash);
  } catch {
    return false;
  }
}

/**
 * 签发会话 token：`payloadB64.sigB64`，payload 仅含 exp(秒) 与 ver。
 * @param {{secret:string, sessionVersion:number, ttlSec?:number, now:number|Function}} params
 *   now 为毫秒数（或返回毫秒数的函数）
 * @returns {Promise<string>}
 */
export async function signSession({ secret, sessionVersion, ttlSec = SESSION_TTL_SEC, now } = {}) {
  const key = typeof secret === 'string' ? secret : '';
  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : SESSION_TTL_SEC;
  const exp = Math.floor(toMillis(now) / 1000) + ttl;
  const ver = Number.isFinite(sessionVersion) ? sessionVersion : 1;
  const payload = b64urlEncodeText(JSON.stringify({ exp, ver }));
  const signature = b64urlEncode(await hmacSha256(key, payload));
  return `${payload}.${signature}`;
}

/**
 * 验签会话 token。判定顺序：malformed -> bad_sig -> expired -> version。
 * 任何情况都不抛异常。
 * @param {string} token
 * @param {{secret:string, sessionVersion:number, now:number|Function}} params
 * @returns {Promise<{valid:boolean, exp:number|null, reason:'malformed'|'expired'|'version'|'bad_sig'|null}>}
 */
export async function verifySession(token, { secret, sessionVersion, now } = {}) {
  const denied = (reason, exp = null) => ({ valid: false, exp, reason });
  if (typeof token !== 'string' || !token) return denied('malformed');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return denied('malformed');

  try {
    // 先验签：篡改 payload 必须判成 bad_sig，而不是 expired
    const expected = b64urlEncode(await hmacSha256(typeof secret === 'string' ? secret : '', parts[0]));
    if (!(await safeEqual(expected, parts[1]))) return denied('bad_sig');
  } catch {
    return denied('bad_sig');
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeText(parts[0]));
  } catch {
    return denied('malformed');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return denied('malformed');
  const exp = Number.isFinite(payload.exp) ? payload.exp : null;
  if (exp === null) return denied('malformed');

  const nowSec = Math.floor(toMillis(now) / 1000);
  if (nowSec >= exp) return denied('expired', exp);
  // 缺省 sessionVersion 视为 1（与 signSession 的默认值保持一致）
  const expectedVer = Number.isFinite(sessionVersion) ? sessionVersion : 1;
  if (payload.ver !== expectedVer) return denied('version', exp);
  return { valid: true, exp, reason: null };
}

/**
 * 解析 Cookie 头为对象（值做 decodeURIComponent，失败保留原文）。
 * @param {string} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const segment of header.split(';')) {
    const part = segment.trim();
    if (!part) continue;
    const index = part.indexOf('=');
    if (index < 0) {
      out[part] = '';
      continue;
    }
    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rawValue);
    } catch {
      out[name] = rawValue;
    }
  }
  return out;
}

/**
 * 构造会话 Cookie（HttpOnly; Secure; SameSite=Lax; Path=/）。
 * @param {string} token
 * @param {number} [maxAgeSec] 默认 604800
 * @returns {string}
 */
export function buildSessionCookie(token, maxAgeSec = SESSION_TTL_SEC) {
  const maxAge = Number.isFinite(maxAgeSec) && maxAgeSec >= 0 ? Math.floor(maxAgeSec) : SESSION_TTL_SEC;
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/**
 * 构造清除会话的 Cookie。
 * @returns {string}
 */
export function buildClearCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * 客户端 IP：优先 CF-Connecting-IP，其次 X-Forwarded-For 首段，否则 'unknown'。
 * @param {Request} request
 * @returns {string}
 */
export function clientIp(request) {
  const direct = request && request.headers ? request.headers.get('cf-connecting-ip') : null;
  if (direct && direct.trim()) return direct.trim();
  const forwarded = request && request.headers ? request.headers.get('x-forwarded-for') : null;
  if (forwarded && forwarded.trim()) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * 内存限流器（isolate 级，非全局，见 ARCHITECTURE §10 L2）。
 * @param {{maxFailures?:number, baseMs?:number, maxMs?:number, now:Function}} params
 * @returns {{check:Function, fail:Function, reset:Function}}
 */
export function createLimiter({ maxFailures = 5, baseMs = 30000, maxMs = 900000, now } = {}) {
  const clock = typeof now === 'function' ? now : () => 0;
  const limit = Number.isFinite(maxFailures) && maxFailures > 0 ? Math.floor(maxFailures) : 5;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 30000;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 900000;
  const map = new Map();

  const keyOf = (ip) => (typeof ip === 'string' && ip ? ip : 'unknown');

  return {
    /**
     * 是否放行。锁定期内直接拒绝，且不递增失败计数。
     * @param {string} ip
     * @returns {{allowed:boolean, remaining?:number, retryAfterSec?:number}}
     */
    check(ip) {
      const key = keyOf(ip);
      const record = map.get(key);
      if (!record) return { allowed: true, remaining: limit };
      const current = clock();
      if (record.lockedUntil && record.lockedUntil > current) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((record.lockedUntil - current) / 1000)) };
      }
      return { allowed: true, remaining: Math.max(0, limit - record.failures) };
    },
    /**
     * 记录一次失败。第 maxFailures 次失败开始进入退避：base * 2^(n-maxFailures)，封顶 maxMs。
     * @param {string} ip
     * @returns {{failures:number, lockedUntil:number}}
     */
    fail(ip) {
      const key = keyOf(ip);
      const record = map.get(key) || { failures: 0, lockedUntil: 0 };
      record.failures += 1;
      if (record.failures >= limit) {
        const over = record.failures - limit;
        const backoff = Math.min(base * 2 ** over, cap);
        record.lockedUntil = clock() + backoff;
      }
      map.set(key, record);
      return record;
    },
    /**
     * 清空某 IP 的失败记录（登录成功后调用）。
     * @param {string} ip
     */
    reset(ip) {
      map.delete(keyOf(ip));
    },
  };
}
