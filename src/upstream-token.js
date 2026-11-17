// src/upstream-token.js
// WorkBuddy access_token 生命周期管理：JWT 过期判定 + refresh_token 换新 + KV 回写。
//
// 为什么需要这个模块：
//   WorkBuddy 的 access_token 是短期凭据：官方开放平台登录返回 expires_in=3600，
//   cockpit-tools / workbuddy-switch 的扫码登录响应同样是 expiresIn=3600；
//   但实测也有 exp 长达数十天的 token，说明有效期按签发渠道而异 —— 因此本模块
//   **一律以 JWT 里的 exp 为准**，不硬编码时长。
//   更关键的是：token 会被上游轮换。cockpit-tools 每次「刷新额度」都会先调 refresh
//   换一组新 token（refresh.rs），旧 access_token 随之失效。所以从 cockpit 导出后
//   再在 cockpit 里刷新一次，导出的那份 token 就打不通上游了 —— 现象是 401，
//   而不是「exp 到了」。
//   结论不变：只存 access_token 的账号迟早会 401，必须持有 refresh_token 自己续期。
//
// 上游刷新协议（与 cockpit-tools workbuddy_oauth.rs::refresh_token 逐字对齐，已线上实测）：
//   POST {base}/v2/plugin/auth/token/refresh
//   Authorization: Bearer <旧 access_token>   ← 必须带，缺失时网关报 refreshToken is empty
//   X-Refresh-Token: <refresh_token>
//   X-Auth-Refresh-Source: plugin
//   X-Domain: <domain>                        ← 可选
//   body: {}
//   -> { code: 0, data: { accessToken, refreshToken, expiresAt, domain } }
// 失败样例：401 { code:12153, msg:"refresh token failed:10000:token format error" }
//
// 约束：不访问裸 env / 全局 fetch / Date.now()（时间一律 ctx.now()，fetch 一律 ctx.fetch）。

import { b64urlDecodeText, isoNow, truncate } from './util.js';
import { buildUpstreamHeaders } from './upstream-headers.js';

/** access_token 过期判定时使用的默认提前刷新窗口（毫秒）。 */
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 单次刷新请求超时（毫秒）。刷新是用户请求链路的一部分，不能比额度查询更久。 */
const REFRESH_TIMEOUT_MS = 10000;

/** 上游错误片段截断长度。 */
const SNIPPET_MAX_CHARS = 160;

/** 默认刷新基址（与额度/签到同域，同一套账号体系）。 */
const DEFAULT_REFRESH_BASE = 'https://copilot.tencent.com';

/** 刷新端点路径。 */
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/** 刷新失败原因分类。 */
export class TokenRefreshError extends Error {
  /**
   * @param {'http'|'api'|'network'|'timeout'|'bad_json'|'no_refresh_token'} kind
   * @param {string} message
   * @param {{status?:number, code?:number|null}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(typeof message === 'string' ? message : String(message));
    this.name = 'TokenRefreshError';
    this.kind = kind;
    this.status = Number.isFinite(extra.status) ? extra.status : 0;
    this.code = extra.code === undefined ? null : extra.code;
  }

  /** refresh_token 本身失效（需要用户重新授权，重试无用）。 */
  get needsRelogin() {
    return this.kind === 'api' || this.status === 401;
  }
}

// ============ 纯计算 ============

/**
 * 解析 JWT payload（**不验签**，仅用于读取 exp/sub 等声明）。
 * 非三段式 JWT、base64 解码失败、JSON 非法一律返回 null，绝不抛异常。
 * @param {*} token
 * @returns {Record<string, unknown>|null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(b64urlDecodeText(parts[1]));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 取 token 的过期时刻（毫秒）。无法判定时返回 null。
 * exp 按 JWT 规范是秒级；同时容忍上游偶发回毫秒（>1e12 视为毫秒）。
 * @param {*} token
 * @returns {number|null}
 */
export function tokenExpiresAtMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const raw = payload.exp;
  const exp = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp > 1e12 ? Math.trunc(exp) : Math.trunc(exp * 1000);
}

/**
 * 判断 token 是否已过期（无法判定时返回 false，交给上游 401 兜底）。
 * @param {*} token
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isTokenExpired(token, nowMs) {
  const expMs = tokenExpiresAtMs(token);
  if (expMs === null) return false;
  return expMs <= nowMs;
}

/**
 * 该账号当前是否应该触发刷新。
 * 判定顺序：
 *   1. 没有 refreshToken -> false（没法刷，只能靠用户重新导入）；
 *   2. token 能解出 exp -> 用 exp；
 *   3. 解不出 exp 但账号记录里有 expiresAt -> 用 expiresAt；
 *   4. 都拿不到 -> false（交给 401 后的强制刷新兜底）。
 * @param {object} account
 * @param {number} nowMs
 * @param {number} [skewMs] 提前量
 * @returns {boolean}
 */
export function shouldRefreshToken(account, nowMs, skewMs = DEFAULT_REFRESH_SKEW_MS) {
  if (!account || typeof account !== 'object') return false;
  if (typeof account.refreshToken !== 'string' || !account.refreshToken) return false;
  const skew = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : DEFAULT_REFRESH_SKEW_MS;
  const fromJwt = tokenExpiresAtMs(account.token);
  const known = fromJwt === null
    ? (Number.isFinite(account.expiresAt) ? account.expiresAt : null)
    : fromJwt;
  if (known === null) return false;
  return known - nowMs <= skew;
}

/**
 * 把刷新结果合并进账号对象（纯函数，不写 KV）。
 * 域名/refreshToken 缺失时保留旧值，避免上游偶发不返回导致下次无法刷新。
 * @param {object} account
 * @param {{accessToken:string, refreshToken?:string|null, expiresAt?:number|null, domain?:string|null}} tokens
 * @param {number} nowMs
 * @returns {object}
 */
export function applyRefreshedToken(account, tokens, nowMs) {
  const src = account && typeof account === 'object' ? account : {};
  const next = { ...src };
  if (tokens && typeof tokens.accessToken === 'string' && tokens.accessToken) {
    next.token = tokens.accessToken;
  }
  if (tokens && typeof tokens.refreshToken === 'string' && tokens.refreshToken) {
    next.refreshToken = tokens.refreshToken;
  }
  const expMs = tokens && Number.isFinite(tokens.expiresAt)
    ? tokens.expiresAt
    : tokenExpiresAtMs(next.token);
  if (expMs !== null) next.expiresAt = expMs;
  if (tokens && typeof tokens.domain === 'string' && tokens.domain) next.domain = tokens.domain;
  next.tokenRefreshedAt = isoNow(nowMs);
  return next;
}

// ============ 上游请求 ============

/**
 * 刷新基址：默认官方地址，env.REFRESH_BASE_URL 可覆盖（仅 http(s):// 开头才生效）。
 * 典型用途：Worker 出口被上游风控时改走自建中转。
 * @param {object} ctx
 * @returns {string}
 */
function refreshBaseUrl(ctx) {
  const raw = ctx && ctx.env && typeof ctx.env.REFRESH_BASE_URL === 'string' ? ctx.env.REFRESH_BASE_URL : '';
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : DEFAULT_REFRESH_BASE;
}

/**
 * 提前刷新窗口：env.TOKEN_REFRESH_SKEW_SEC 可覆盖，缺省 300 秒。
 * @param {object} ctx
 * @returns {number}
 */
function refreshSkewMs(ctx) {
  const raw = ctx && ctx.env ? Number(ctx.env.TOKEN_REFRESH_SKEW_SEC) : NaN;
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) * 1000 : DEFAULT_REFRESH_SKEW_MS;
}

/**
 * 组装刷新请求头：公共头走统一模块，再叠加刷新接口专属的两个字段。
 * `X-Refresh-Token` 与 `X-Auth-Refresh-Source: plugin` 缺一不可，实测缺失时网关会
 * 把刷新判定成其它 client 来源（400 refreshToken is empty / invalid_grant）。
 * @param {object} account
 * @returns {Record<string,string>}
 */
function refreshHeaders(account) {
  return buildUpstreamHeaders(account, {
    extra: {
      'x-refresh-token': account.refreshToken,
      'x-auth-refresh-source': 'plugin',
    },
  });
}

/**
 * 上游响应片段：去换行、压缩空白、截断；剔除 token 原文，避免泄漏到日志/面板。
 * @param {string} text
 * @param {object} account
 * @returns {string}
 */
function bodySnippet(text, account) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  let snippet = truncate(text.replace(/\s+/g, ' ').trim(), SNIPPET_MAX_CHARS);
  for (const secret of [account && account.token, account && account.refreshToken]) {
    if (typeof secret === 'string' && secret) snippet = snippet.split(secret).join('***');
  }
  return snippet;
}

/**
 * 解析刷新响应体，抽出新 token。
 * @param {*} json
 * @returns {{accessToken:string, refreshToken:string|null, expiresAt:number|null, domain:string|null}}
 * @throws {TokenRefreshError}
 */
function parseRefreshPayload(json) {
  const body = json && typeof json === 'object' ? json : null;
  if (!body) throw new TokenRefreshError('bad_json', '刷新响应非 JSON');
  const code = Number(body.code);
  if (Number.isFinite(code) && code !== 0 && code !== 200) {
    const msg = typeof body.msg === 'string' ? body.msg : typeof body.message === 'string' ? body.message : '';
    throw new TokenRefreshError('api', `刷新失败 code=${code}${msg ? `：${msg}` : ''}`, { code });
  }
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null;
  if (!data) throw new TokenRefreshError('bad_json', '刷新响应缺少 data');
  const accessToken = typeof data.accessToken === 'string'
    ? data.accessToken
    : typeof data.access_token === 'string' ? data.access_token : '';
  if (!accessToken) throw new TokenRefreshError('bad_json', '刷新响应缺少 accessToken');
  const refreshToken = typeof data.refreshToken === 'string'
    ? data.refreshToken
    : typeof data.refresh_token === 'string' ? data.refresh_token : null;
  // expiresAt 可能是秒或毫秒；也可能只给 expiresIn（秒）
  let expiresAt = null;
  const rawExpiresAt = Number.isFinite(data.expiresAt) ? data.expiresAt : Number(data.expires_at);
  if (Number.isFinite(rawExpiresAt) && rawExpiresAt > 0) {
    expiresAt = rawExpiresAt > 1e12 ? Math.trunc(rawExpiresAt) : Math.trunc(rawExpiresAt * 1000);
  } else {
    const expiresIn = Number(data.expiresIn ?? data.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = null; // 由调用方用 nowMs 计算
  }
  const domain = typeof data.domain === 'string' && data.domain ? data.domain : null;
  return { accessToken, refreshToken, expiresAt, domain, expiresIn: Number(data.expiresIn ?? data.expires_in) };
}

/**
 * 用 refresh_token 换一组新 token。
 * @param {object} ctx
 * @param {object} account 含 token / refreshToken / domain
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{accessToken:string, refreshToken:string|null, expiresAt:number|null, domain:string|null}>}
 * @throws {TokenRefreshError}
 */
export async function refreshAccessToken(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  if (typeof acc.refreshToken !== 'string' || !acc.refreshToken) {
    throw new TokenRefreshError('no_refresh_token', '账号未保存 refresh_token');
  }
  if (typeof acc.token !== 'string' || !acc.token) {
    throw new TokenRefreshError('no_refresh_token', '账号缺少 access_token');
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : REFRESH_TIMEOUT_MS;
  const url = `${refreshBaseUrl(ctx)}${REFRESH_PATH}`;
  const controller = new AbortController();
  let timer = null;

  const task = (async () => {
    const response = await ctx.fetch(url, {
      method: 'POST',
      headers: refreshHeaders(acc),
      body: '{}',
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  })();
  // 超时后 task 迟到的 reject 不应触发 unhandledRejection
  task.catch(() => {});

  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* abort 失败无需处理 */
      }
      reject(new TokenRefreshError('timeout', '刷新 token 超时'));
    }, timeoutMs);
  });

  let response;
  let text;
  try {
    ({ response, text } = await Promise.race([task, timeoutPromise]));
  } catch (err) {
    if (err instanceof TokenRefreshError) throw err;
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new TokenRefreshError('timeout', '刷新 token 超时');
    }
    throw new TokenRefreshError('network', `刷新 token 网络错误：${(err && err.name) || 'Error'}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (!response.ok) {
    const snippet = bodySnippet(text, acc);
    throw new TokenRefreshError(
      'http',
      snippet ? `刷新接口返回 HTTP ${response.status}：${snippet}` : `刷新接口返回 HTTP ${response.status}`,
      { status: response.status },
    );
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const snippet = bodySnippet(text, acc);
    throw new TokenRefreshError('bad_json', snippet ? `刷新响应非 JSON：${snippet}` : '刷新响应非 JSON');
  }

  const parsed = parseRefreshPayload(json);
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : 0;
  const expiresAt = parsed.expiresAt === null && Number.isFinite(parsed.expiresIn) && parsed.expiresIn > 0
    ? nowMs + Math.trunc(parsed.expiresIn) * 1000
    : parsed.expiresAt;
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt,
    domain: parsed.domain,
  };
}

// ============ 编排列 ============

/**
 * 把刷新后的 token 回写 KV（整表读改写，一次写）。
 * 账号在刷新期间被删除时直接放弃回写（不复活已删账号）。
 * @param {object} ctx
 * @param {object} account 刷新后的账号
 * @returns {Promise<boolean>} 是否真的写入
 */
export async function persistAccountToken(ctx, account) {
  const target = account && typeof account === 'object' ? account : null;
  if (!target || typeof target.id !== 'string' || !target.id) return false;
  const list = await ctx.kv.getAccounts();
  const index = list.findIndex((item) => item && item.id === target.id);
  if (index < 0) return false;
  const next = list.slice();
  next[index] = {
    ...list[index],
    token: target.token,
    refreshToken: target.refreshToken,
    expiresAt: target.expiresAt,
    domain: target.domain,
    tokenRefreshedAt: target.tokenRefreshedAt,
    updatedAt: isoNow(ctx.now()),
  };
  await ctx.kv.putAccounts(next);
  return true;
}

/**
 * 必要时刷新账号 token：到期前 5 分钟（可配）触发，成功则回写 KV。
 * **刷新失败不抛异常**：调用方应继续用旧 token 发请求，让上游 401 给出最终结论，
 * 避免「刷新接口抖动」直接让用户看到不可用的错误。
 * @param {object} ctx
 * @param {object} account
 * @param {{force?:boolean, timeoutMs?:number, skewMs?:number, persist?:boolean}} [options]
 *   persist=false 时只换内存里的 token、不回写 KV（dryRun 这类承诺零写的路径用）
 * @returns {Promise<{account:object, refreshed:boolean, error:TokenRefreshError|null}>}
 */
export async function ensureFreshToken(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : 0;
  const force = options.force === true;
  const persist = options.persist !== false;
  const skew = Number.isFinite(options.skewMs) ? options.skewMs : refreshSkewMs(ctx);

  const needed = force
    ? (typeof acc.refreshToken === 'string' && Boolean(acc.refreshToken))
    : shouldRefreshToken(acc, nowMs, skew);
  if (!needed) return { account: acc, refreshed: false, error: null };

  try {
    const tokens = await refreshAccessToken(ctx, acc, options);
    const next = applyRefreshedToken(acc, tokens, nowMs);
    if (persist) {
      try {
        await persistAccountToken(ctx, next);
      } catch {
        // 回写失败不影响本次使用（KV 抖动/写入配额），下次到期会再刷
      }
    }
    return { account: next, refreshed: true, error: null };
  } catch (err) {
    const error = err instanceof TokenRefreshError
      ? err
      : new TokenRefreshError('network', String((err && err.message) || err));
    return { account: acc, refreshed: false, error };
  }
}

/**
 * 「先续期、再执行、401 再兜底续期一次」的通用封装。
 *
 * 约定 run 返回的是**结果对象**而非抛错（与 checkinStatus / checkinAccount 的返回形状一致）：
 *   - 结果里 tokenInvalid === true 视为 token 失效信号；
 *   - 本轮还没刷过且账号有 refresh_token 时，强制刷新后再跑一次。
 * 刷新失败不抛错：把原始 outcome 交回调用方，日志里能看到真实原因。
 * @param {object} ctx
 * @param {object} account
 * @param {(account:object) => Promise<object>} run
 * @param {{persist?:boolean, force?:boolean, timeoutMs?:number, skewMs?:number}} [options]
 *   persist=false 用于 dryRun 这类承诺零 KV 写的路径
 * @returns {Promise<object>}
 */
export async function withFreshToken(ctx, account, run, options = {}) {
  const prepared = await ensureFreshToken(ctx, account, options);
  let outcome = await run(prepared.account);
  const hasRefreshToken = typeof prepared.account.refreshToken === 'string'
    && Boolean(prepared.account.refreshToken);
  if (outcome && outcome.tokenInvalid === true && !prepared.refreshed && hasRefreshToken) {
    const forced = await ensureFreshToken(ctx, prepared.account, { ...options, force: true });
    if (forced.refreshed) outcome = await run(forced.account);
  }
  return outcome;
}
