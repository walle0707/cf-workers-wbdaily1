// src/router.js
// 路由匹配 / 同源校验 / JSON body 解析 / 原始 JSON 响应构造（全部为纯函数）。
// 本文件不得访问 env、不得调用全局 fetch、不得调用 Date.now()。

import { AppError } from './util.js';
import { parseCookies, SESSION_COOKIE_NAME, verifySession } from './auth.js';

/** JSON body 上限（64KB）。 */
const MAX_BODY_BYTES = 64 * 1024;

/** auth 记录内存缓存键与 TTL（毫秒）。 */
const AUTH_CACHE_KEY = 'auth';
const AUTH_CACHE_TTL_MS = 10000;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * 构造任意形状的 JSON 响应（MCP 的 JSON-RPC 等非信封场景使用）。
 * 业务 JSON 一律走 util.js 的 ok()/fail()，不要用本函数绕开信封。
 * @param {*} body
 * @param {ResponseInit} [init]
 * @returns {Response}
 */
export function jsonResponse(body, init = {}) {
  const options = init && typeof init === 'object' ? init : {};
  const headers = new Headers(options.headers || undefined);
  if (!headers.has('content-type')) headers.set('content-type', JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(body === undefined ? null : body), {
    ...options,
    status: Number.isFinite(options.status) ? Number(options.status) : 200,
    headers,
  });
}

/**
 * 规范化路径：确保以 `/` 开头，去掉尾部多余 `/`（根路径保留）。
 * @param {string} pathname
 * @returns {string}
 */
function normalizePath(pathname) {
  let p = typeof pathname === 'string' && pathname ? pathname : '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) {
    p = p.replace(/\/+$/, '');
    if (!p) p = '/';
  }
  return p;
}

/**
 * 按段匹配单个路由模板，支持 `:id` 形式的单段参数。
 * @param {string} path 已规范化的请求路径
 * @param {string} pattern 已规范化的路由模板
 * @returns {Record<string, string>|null} 命中返回参数对象（无参数为 {}），未命中返回 null
 */
function matchPattern(path, pattern) {
  const pathSegments = normalizePath(path).split('/').filter(Boolean);
  const patternSegments = normalizePath(pattern).split('/').filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return null;
  const params = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const expected = patternSegments[i];
    const actual = pathSegments[i];
    if (expected.startsWith(':')) {
      const name = expected.slice(1);
      if (!name || !actual) return null;
      try {
        params[name] = decodeURIComponent(actual);
      } catch {
        params[name] = actual;
      }
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/**
 * 在路由表中查找第一个方法 + 路径都匹配的路由。
 * @param {string} method HTTP 方法
 * @param {string} pathname 请求路径
 * @param {Array<{method:string, pattern:string, handler:Function, auth?:boolean}>} routes 路由表
 * @returns {{route:object, params:Record<string,string>}|null}
 */
export function matchRoute(method, pathname, routes) {
  const upperMethod = String(method || 'GET').toUpperCase();
  const path = normalizePath(pathname);
  const list = Array.isArray(routes) ? routes : [];
  for (const route of list) {
    if (!route || typeof route.pattern !== 'string') continue;
    if (String(route.method || 'GET').toUpperCase() !== upperMethod) continue;
    const params = matchPattern(path, route.pattern);
    if (params) return { route, params };
  }
  return null;
}

/**
 * 取 URL 字符串的 host（含端口）。解析失败返回 null。
 * @param {string} value
 * @returns {string|null}
 */
function hostOf(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * 同源校验（仅用于 POST/PUT/DELETE 等写操作）。
 * 规则：Origin 与 Referer 都缺失时放行（curl / MCP 等非浏览器客户端）；
 * 存在任一时，其 host 必须与请求 URL 的 host 一致，否则抛 FORBIDDEN。
 * 注意 `Origin: null` 视为不匹配（沙箱 iframe / 跨站跳转会发这个值）。
 * @param {Request} request
 * @param {URL|string} url 请求 URL
 * @returns {void}
 * @throws {AppError} FORBIDDEN
 */
export function assertSameOrigin(request, url) {
  const target = url instanceof URL ? url : new URL(String(url));
  const rawOrigin = request.headers.get('origin');
  const rawReferer = request.headers.get('referer');
  const origin = rawOrigin && rawOrigin.trim() ? rawOrigin.trim() : null;
  const referer = rawReferer && rawReferer.trim() ? rawReferer.trim() : null;
  if (!origin && !referer) return;
  if (origin && hostOf(origin) !== target.host) {
    throw new AppError('FORBIDDEN', '跨站请求被拒绝（Origin 不匹配）');
  }
  if (referer && hostOf(referer) !== target.host) {
    throw new AppError('FORBIDDEN', '跨站请求被拒绝（Referer 不匹配）');
  }
}

/**
 * 读取 auth 记录（优先 10s 内存缓存）。miss 时读一次 KV 并回填缓存；本函数**不写 KV**。
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
async function loadAuthRecord(ctx) {
  const cache = ctx.authCache && typeof ctx.authCache.get === 'function' ? ctx.authCache : null;
  if (cache) {
    const cached = cache.get(AUTH_CACHE_KEY);
    if (cached) return cached;
  }
  const record = await ctx.kv.getAuth();
  if (record && cache && typeof cache.set === 'function') {
    cache.set(AUTH_CACHE_KEY, record, AUTH_CACHE_TTL_MS);
  }
  return record;
}

/**
 * 会话鉴权：Cookie -> verifySession。失败抛 UNAUTHORIZED，message 按 reason 区分。
 * @param {object} ctx
 * @param {Request} request
 * @returns {Promise<{authRecord:object, session:{valid:boolean, exp:number|null, reason:string|null}}>}
 * @throws {AppError} UNAUTHORIZED
 */
export async function requireAuth(ctx, request) {
  const authRecord = await loadAuthRecord(ctx);
  if (!authRecord) {
    throw new AppError('UNAUTHORIZED', '系统尚未初始化');
  }
  const cookies = parseCookies(request && request.headers ? request.headers.get('cookie') || '' : '');
  const token = cookies[SESSION_COOKIE_NAME] || '';
  if (!token) {
    throw new AppError('UNAUTHORIZED', '未登录或会话无效');
  }
  const session = await verifySession(token, {
    secret: authRecord.sessionSecret,
    sessionVersion: authRecord.sessionVersion,
    now: ctx.now(),
  });
  if (!session.valid) {
    if (session.reason === 'expired') throw new AppError('UNAUTHORIZED', '登录已过期，请重新登录');
    if (session.reason === 'version') throw new AppError('UNAUTHORIZED', '密码已变更，请重新登录');
    throw new AppError('UNAUTHORIZED', '未登录或会话无效');
  }
  return { authRecord, session };
}

/**
 * 要求系统已初始化（存在 config:auth）。返回 auth 记录。
 * @param {object} ctx
 * @returns {Promise<object>}
 * @throws {AppError} BAD_REQUEST
 */
export async function requireInitialized(ctx) {
  const authRecord = await loadAuthRecord(ctx);
  if (!authRecord) {
    throw new AppError('BAD_REQUEST', '系统尚未初始化，请先设置管理员密码');
  }
  return authRecord;
}

/**
 * 读取并解析 JSON 请求体。
 * 规则：content-type 必须含 application/json；body 上限 64KB；解析失败抛 BAD_REQUEST。
 * @param {Request} request
 * @returns {Promise<object>} 空 body 返回 {}
 * @throws {AppError} BAD_REQUEST
 */
export async function readJson(request, options = {}) {
  const limit = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : MAX_BODY_BYTES;
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new AppError('BAD_REQUEST', '请求必须为 application/json');
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new AppError('BAD_REQUEST', `请求体超过 ${limit} 字节上限`);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) {
    throw new AppError('BAD_REQUEST', `请求体超过 ${limit} 字节上限`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('BAD_REQUEST', '请求体不是合法 JSON');
  }
}
