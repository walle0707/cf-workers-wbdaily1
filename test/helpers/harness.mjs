// test/helpers/harness.mjs
// 测试装配件：ctx 工厂（注入内存 KV / mock fetch / 可控时钟）、上游 mock、API 调度器。
// 约束：
//   1. 只用 Node 内置能力；
//   2. 每个用例必须用全新的 env + memkv + 时钟函数（limiter/authCache 按 env 或时钟复用，会跨用例污染）；
//   3. 上游 mock 只允许 copilot.tencent.com 的两个端点，其它 URL 直接抛错 —— 杜绝真实网络请求。

import { createMemoryKv } from './memkv.mjs';
import { createContext } from '../../src/store.js';
import { handleApi } from '../../src/api.js';
import { AppError, fail } from '../../src/util.js';

/** 上游基址与端点（响应形状见 PRD §6.1）。 */
export const UPSTREAM_BASE = 'https://copilot.tencent.com';
export const STATUS_PATH = '/v2/billing/meter/checkin-status';
export const DAILY_PATH = '/v2/billing/meter/daily-checkin';
export const STATUS_URL = `${UPSTREAM_BASE}${STATUS_PATH}`;
export const DAILY_URL = `${UPSTREAM_BASE}${DAILY_PATH}`;

/** token 续期端点（src/upstream-token.js 使用）。 */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
export const REFRESH_URL = `${UPSTREAM_BASE}${REFRESH_PATH}`;

/** 额度查询三个端点（src/credits.js 使用）。 */
export const SUMMARY_PATH = '/billing/meter/get-user-resource-summary';
export const PAID_PATH = '/billing/meter/get-user-resource-paid-packages';
export const FREE_PATH = '/billing/meter/get-user-resource-free-packages';

/** OAuth 授权三个端点（src/oauth.js 使用）：申请会话 / 轮询 token / 拉账号资料。 */
export const OAUTH_STATE_PATH = '/v2/plugin/auth/state';
export const OAUTH_TOKEN_PATH = '/v2/plugin/auth/token';
export const OAUTH_ACCOUNT_PATH = '/v2/plugin/login/account';

/** mock 允许的出站端点全集：出现其它路径即视为测试装配错误。 */
const ALLOWED_PATHS = new Set([
  STATUS_PATH,
  DAILY_PATH,
  REFRESH_PATH,
  SUMMARY_PATH,
  PAID_PATH,
  FREE_PATH,
  OAUTH_STATE_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_ACCOUNT_PATH,
]);

/** 站点基址（API 测试用）。 */
export const SITE_ORIGIN = 'https://wb.example.com';

/** 固定时间基准。 */
export const T0 = 1700000000000;

/**
 * 可控时钟。每次调用都返回新函数 —— createContext 用它做 isolate 状态复用键，
 * 因此「每个用例一个新时钟」= 每个用例一套全新 limiter / authCache。
 * @param {number} [startMs]
 * @returns {Function & {set:Function, advance:Function}}
 */
export function createClock(startMs = T0) {
  let current = startMs;
  const clock = () => current;
  clock.set = (ms) => {
    current = ms;
    return current;
  };
  clock.advance = (delta) => {
    current += delta;
    return current;
  };
  return clock;
}

/**
 * JSON 响应构造。
 * @param {*} body
 * @param {number} [status]
 * @returns {Response}
 */
export function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 非 JSON 响应（用于「响应非 JSON」分支）。
 * @param {string} [text]
 * @param {number} [status]
 * @returns {Response}
 */
export function textRes(text = '<html>oops</html>', status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } });
}

/** 上游成功响应：今日未签到。 */
export function statusNotCheckedIn(streakDays = 5) {
  return jsonRes({ code: 0, data: { today_checked_in: false, streak_days: streakDays } });
}

/** 上游成功响应：今日已签到。 */
export function statusCheckedIn(streakDays = 12) {
  return jsonRes({ code: 0, data: { today_checked_in: true, streak_days: streakDays } });
}

/** 上游成功响应：签到成功。 */
export function dailyOk(credit = 10, streakDays = 6) {
  return jsonRes({ code: 0, data: { credit, streak_days: streakDays, is_streak_day: true } });
}

/**
 * 创建严格的上游 fetch mock。
 * handler(call, calls) 返回 Response（或 Promise）；返回空则视为测试装配错误。
 * @param {(call:object, calls:object[]) => (Response|Promise<Response>)} handler
 * @returns {Function & {calls:object[], count:Function, tokens:Function, paths:Function}}
 */
export function createUpstreamMock(handler) {
  /** @type {Array<object>} */
  const calls = [];

  const mock = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== UPSTREAM_BASE) {
      throw new Error(`[mock] 出现了未预期的 fetch 目标：${url}`);
    }
    if (!ALLOWED_PATHS.has(parsed.pathname)) {
      throw new Error(`[mock] 出现了未预期的上游端点：${parsed.pathname}`);
    }
    const headers = init.headers || {};
    const call = {
      url: String(url),
      path: parsed.pathname,
      method: init.method,
      headers,
      authorization: headers.authorization || headers.Authorization || null,
      contentType: headers['content-type'] || headers['Content-Type'] || null,
      refreshToken: headers['x-refresh-token'] || headers['X-Refresh-Token'] || null,
      refreshSource: headers['x-auth-refresh-source'] || headers['X-Auth-Refresh-Source'] || null,
      domain: headers['x-domain'] || headers['X-Domain'] || null,
      body: init.body,
      signal: init.signal,
      token: String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, ''),
    };
    calls.push(call);
    const response = await handler(call, calls);
    if (!response) throw new Error(`[mock] handler 未返回响应（${parsed.pathname}）`);
    return response;
  };

  mock.calls = calls;
  /** 指定端点的调用次数（省略 path 返回总次数） */
  mock.count = (path) => (path ? calls.filter((call) => call.path === path).length : calls.length);
  /** 是否用某个 token 调过上游 */
  mock.tokens = () => calls.map((call) => call.token);
  /** 调用过的端点序列 */
  mock.paths = () => calls.map((call) => call.path);
  return mock;
}

/**
 * 永不 resolve 且忽略 AbortSignal 的 fetch（用于超时测试）。
 * @returns {Function}
 */
export function createHangingFetch() {
  const calls = [];
  const mock = (url, init = {}) => {
    calls.push({ url: String(url), path: new URL(String(url)).pathname, init });
    return new Promise(() => {});
  };
  mock.calls = calls;
  return mock;
}

/**
 * 组装一个测试用 ctx（业务环境的唯一装配点）。
 * @param {{kv?:object, fetch?:Function, clock?:Function, env?:object}} [options]
 * @returns {{ctx:object, kv:object, clock:Function, env:object}}
 */
export function makeCtx(options = {}) {
  const kv = options.kv || createMemoryKv();
  const clock = options.clock || createClock();
  const env = { WB_KV: null, ...(options.env || {}) };
  const fetchImpl = options.fetch || (async () => {
    throw new Error('[mock] 本用例未配置 fetch mock');
  });
  const ctx = createContext(env, { kv, fetch: fetchImpl, now: clock });
  return { ctx, kv, clock, env };
}

/**
 * 构造 API 请求（默认同源 Origin，写操作自动带 content-type: application/json）。
 * @param {string} path
 * @param {{method?:string, body?:*, cookie?:string, origin?:string|null, ip?:string, headers?:object}} [options]
 * @returns {Request}
 */
export function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.origin !== null) headers.origin = options.origin || SITE_ORIGIN;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.ip !== undefined) headers['cf-connecting-ip'] = options.ip;
  const init = { method, headers };
  if (options.body !== undefined) {
    if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  return new Request(`${SITE_ORIGIN}${path}`, init);
}

/**
 * 把 Response 归一化成 { status, body, headers, text }。
 * @param {Response} response
 * @returns {Promise<{status:number, body:any, headers:Headers, text:string}>}
 */
async function toResult(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { __unparsable: text };
  }
  return { status: response.status, body, headers: response.headers, text };
}

/**
 * 调度一次 /api/* 请求。等价于 index.js 的分流 + 顶层异常出口（AppError -> 统一错误信封），
 * 但允许注入 ctx（这样就能用 mock fetch，绝不发真实网络请求）。
 * @param {object} ctx
 * @param {string} path
 * @param {object} [options]
 * @returns {Promise<{status:number, body:any, headers:Headers, text:string}>}
 */
export async function dispatch(ctx, path, options = {}) {
  const request = apiRequest(path, options);
  const url = new URL(request.url);
  try {
    const response = await handleApi(ctx, request, url);
    return await toResult(response);
  } catch (err) {
    if (err instanceof AppError) {
      const headers = err.headers && Object.keys(err.headers).length > 0 ? { headers: err.headers } : undefined;
      return toResult(fail(err.code, err.message, err.detail, headers));
    }
    throw err;
  }
}

/** 默认管理员密码。 */
export const PASSWORD = 'Passw0rd!2024';

/**
 * 完成 setup（系统初始化）。
 * @param {object} ctx
 * @param {string} [password]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function setupSystem(ctx, password = PASSWORD, options = {}) {
  return dispatch(ctx, '/api/setup', { method: 'POST', body: { password }, ...options });
}

/**
 * 登录并取出会话 Cookie。
 * @param {object} ctx
 * @param {string} [password]
 * @param {object} [options]
 * @returns {Promise<{result:object, cookie:string, setCookie:string}>}
 */
export async function loginSystem(ctx, password = PASSWORD, options = {}) {
  const ip = options.ip || '10.0.0.9';
  const result = await dispatch(ctx, '/api/login', { method: 'POST', body: { password }, ip });
  const setCookie = result.headers.get('set-cookie') || '';
  const matched = /wb_session=([^;]+)/.exec(setCookie);
  return {
    result,
    setCookie,
    cookie: matched ? `wb_session=${matched[1]}` : '',
  };
}

/**
 * setup + login 一步到位。
 * @param {object} [options]
 * @returns {Promise<{ctx:object, kv:object, clock:Function, env:object, cookie:string, setCookie:string}>}
 */
export async function createAuthedEnv(options = {}) {
  const made = makeCtx(options);
  const setup = await setupSystem(made.ctx, options.password || PASSWORD, { ip: options.ip });
  if (setup.status !== 200) {
    throw new Error(`setup 失败：${setup.status} ${JSON.stringify(setup.body)}`);
  }
  const { cookie, setCookie } = await loginSystem(made.ctx, options.password || PASSWORD, { ip: options.ip });
  return { ...made, cookie, setCookie };
}

/**
 * 构造一个账号记录（KV 内形态，含明文 token）。
 * @param {number|string} seed
 * @param {{enabled?:boolean, name?:string, token?:string}} [patch]
 * @returns {object}
 */
export function makeAccount(seed, patch = {}) {
  const id = `acc_${seed}`;
  const iso = new Date(T0).toISOString();
  return {
    id,
    name: patch.name || `账号${seed}`,
    token: patch.token || `token-${seed}-abcdefghijkl`,
    uid: '',
    enabled: patch.enabled === undefined ? true : patch.enabled === true,
    remark: '',
    createdAt: iso,
    updatedAt: iso,
  };
}
