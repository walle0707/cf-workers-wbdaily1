// src/checkin.js
// 上游客户端：AbortController 超时控制 + 两段式签到（先 status 后 daily）+ 错误归一化。
// 约束：不直接调用全局 fetch、不直接调用 Date.now()（fetch 与时间全部经 ctx 注入）；
//       上游 base 可经 env.UPSTREAM_BASE_URL 覆盖（与 credits.js 的 CREDITS_BASE_URL 同风格）。
// 安全：任何 message 都可能进入日志与面板，**永不包含 token 或其片段**。

import { sanitizeToken, truncate } from './util.js';
import { buildUpstreamHeaders } from './upstream-headers.js';

/** 上游默认基址（官方接口）。 */
export const UPSTREAM_BASE = 'https://copilot.tencent.com';

/** 今日签到状态查询路径。 */
const STATUS_PATH = '/v2/billing/meter/checkin-status';

/** 执行签到的路径。 */
const DAILY_PATH = '/v2/billing/meter/daily-checkin';

/** 单次上游请求默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 10000;

/** message 字符上限。 */
const MESSAGE_MAX_CHARS = 200;

/** 上游响应文本保留上限（仅用于错误诊断，避免把超大 body 带进内存与日志）。 */
const UPSTREAM_TEXT_MAX_CHARS = 2000;

/** 上游业务码：今天已签到（同一天重复签到，属于幂等场景）。 */
const CODE_ALREADY_CHECKED_IN = 10001;

/**
 * 上游基址：默认官方地址，env.UPSTREAM_BASE_URL 可覆盖（仅 http(s):// 开头才生效）。
 * 典型用途：Worker 出口 IP 被上游风控时，改走用户自建中转。
 * @param {object} ctx
 * @returns {string}
 */
function baseUrl(ctx) {
  const raw = ctx && ctx.env && typeof ctx.env.UPSTREAM_BASE_URL === 'string' ? ctx.env.UPSTREAM_BASE_URL : '';
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : UPSTREAM_BASE;
}

/**
 * 取数字字段，非法返回 null（0 合法）。
 * @param {*} value
 * @returns {number|null}
 */
function toNumber(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * 取上游业务数据体（{code, data, msg}）。
 * @param {*} json
 * @returns {object}
 */
function pickData(json) {
  if (!json || typeof json !== 'object') return {};
  const data = json.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * 取上游业务提示文本。
 * @param {*} json
 * @returns {string}
 */
function pickUpstreamMessage(json) {
  if (!json || typeof json !== 'object') return '';
  const candidate = typeof json.msg === 'string' ? json.msg : typeof json.message === 'string' ? json.message : '';
  return candidate;
}

/**
 * 判断上游业务是否成功（code === 0）。
 * @param {*} json
 * @returns {boolean}
 */
function isBusinessOk(json) {
  return !!json && typeof json === 'object' && json.code === 0;
}

/**
 * 取出「带业务 code 的 JSON body」：非 2xx 响应同样适用（例如 400 + {code:10001}）。
 * @param {*} json
 * @returns {object|null}
 */
function businessBody(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return Number.isFinite(json.code) ? json : null;
}

/**
 * 组装统一的 failed 结果。
 * @param {{httpStatus?:number, code?:number|null, message:string, tokenInvalid?:boolean,
 *          upstreamBlocked?:boolean, upstreamFatal?:boolean, durationMs?:number,
 *          credit?:number|null, streakDays?:number|null}} partial
 * @returns {object} CheckinResult
 */
function failed(partial) {
  const src = partial || {};
  return {
    result: 'failed',
    httpStatus: Number.isFinite(src.httpStatus) ? src.httpStatus : 0,
    code: Number.isFinite(src.code) ? src.code : null,
    message: truncate(typeof src.message === 'string' ? src.message : '', MESSAGE_MAX_CHARS),
    credit: Number.isFinite(src.credit) ? src.credit : null,
    streakDays: Number.isFinite(src.streakDays) ? src.streakDays : null,
    durationMs: Number.isFinite(src.durationMs) ? src.durationMs : 0,
    tokenInvalid: src.tokenInvalid === true,
    upstreamBlocked: src.upstreamBlocked === true,
    upstreamFatal: src.upstreamFatal === true,
  };
}

/**
 * 组装「今日已签到」的幂等结果。
 * 用于 daily-checkin 返回非 2xx 但业务体是 {code:10001} 的场景：
 * 上游 httpStatus 保留原值（便于诊断），语义上按成功处理，绝不记成 failed。
 * @param {number} httpStatus 上游 HTTP 状态（典型 400）
 * @param {object} json 上游业务体
 * @returns {object} CheckinResult
 */
function alreadyCheckedIn(httpStatus, json) {
  const upstreamMessage = pickUpstreamMessage(json);
  const code = json && Number.isFinite(json.code) ? json.code : CODE_ALREADY_CHECKED_IN;
  return {
    result: 'already_checked_in',
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
    code,
    message: truncate(upstreamMessage || '今天已签到，请明天再来', MESSAGE_MAX_CHARS),
    credit: null,
    streakDays: null,
    durationMs: 0,
    tokenInvalid: false,
    upstreamBlocked: false,
    upstreamFatal: false,
  };
}

/**
 * 组装一次上游请求的请求头。
 * 具体字段与取值统一由 upstream-headers.js 维护（签到/额度/续期三条链路共用一套，
 * 避免同一账号在不同接口呈现不同客户端特征）。这里只负责传入账号上下文。
 * @param {object} account 含裸 token，可选 uid / enterpriseId / domain
 * @returns {Record<string,string>}
 */
function buildHeaders(account) {
  return buildUpstreamHeaders(account);
}

/**
 * 上游调用：POST 空 JSON body，带 Bearer token，AbortController 控超时。
 * @param {object} ctx
 * @param {string} path 以 `/` 开头
 * @param {object} account 含裸 token（必需），可带 uid / enterpriseId / domain 以补齐业务头
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{httpStatus:number, json:any, text:string,
 *                    error:null|'TIMEOUT'|'NETWORK'|'BAD_JSON',
 *                    durationMs:number, errorName:string|null}>}
 */
export async function callUpstream(ctx, path, account, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl(ctx)}${path.startsWith('/') ? path : `/${path}`}`;
  const startedAtMs = ctx.now();
  const controller = new AbortController();

  let httpStatus = 0;
  let json = null;
  let text = '';
  let error = null;
  let errorName = null;
  let timer = null;

  // 超时兜底：既 abort 请求，也用一个必然 reject 的 Promise 参与竞速。
  // 这样即使底层 fetch 实现忽略 signal（例如单测里的 mock 永不 resolve），也能按时返回 TIMEOUT。
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* abort 失败无需处理 */
      }
      const timeoutError = new Error('upstream timeout');
      timeoutError.name = 'TimeoutError';
      reject(timeoutError);
    }, timeoutMs);
  });

  const requestPromise = (async () => {
    const response = await ctx.fetch(url, {
      method: 'POST',
      headers: buildHeaders(account),
      body: '{}',
      signal: controller.signal,
    });
    const status = Number.isFinite(response && response.status) ? response.status : 0;
    // 先取原始文本：非 2xx 的业务体（如 {code:10001}）也要能被上层解析。
    let rawText = '';
    try {
      const bodyText = typeof response.text === 'function' ? await response.text() : '';
      rawText = typeof bodyText === 'string' ? bodyText : '';
    } catch (textError) {
      const name = textError && textError.name ? String(textError.name) : '';
      if (name === 'AbortError' || name === 'TimeoutError') throw textError;
      rawText = '';
    }
    let parsed = null;
    let parseFailed = false;
    if (rawText === '') {
      parseFailed = true;
    } else {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parseFailed = true;
      }
    }
    return { status, parsed, parseFailed, text: rawText };
  })();
  // 超时竞速结束后，迟到的 reject 不应变成 unhandled rejection
  requestPromise.catch(() => {});

  try {
    const result = await Promise.race([requestPromise, timeoutPromise]);
    httpStatus = result.status;
    text = typeof result.text === 'string' ? truncate(result.text, UPSTREAM_TEXT_MAX_CHARS) : '';
    if (result.parseFailed) {
      json = null;
      // 非 2xx 时 body 解析失败不算 BAD_JSON，交由上层按 httpStatus 判定
      error = httpStatus >= 200 && httpStatus < 300 ? 'BAD_JSON' : null;
    } else {
      json = result.parsed;
    }
  } catch (err) {
    const name = err && err.name ? String(err.name) : '';
    errorName = name || 'Error';
    if (name === 'AbortError' || name === 'TimeoutError') {
      error = 'TIMEOUT';
    } else {
      error = 'NETWORK';
    }
    json = null;
    text = '';
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  return {
    httpStatus,
    json,
    text,
    error,
    durationMs: Math.max(0, ctx.now() - startedAtMs),
    errorName,
  };
}

/**
 * 传输层错误归一化（超时 / 网络 / 响应非 JSON）；无传输层错误返回 null。
 * 顺序即 ARCHITECTURE §8 的优先级：传输层先于 HTTP 状态与业务码判定。
 * @param {{httpStatus:number, error:string|null, errorName:string|null}} call
 * @returns {object|null}
 */
function classifyTransportError(call) {
  const httpStatus = Number.isFinite(call.httpStatus) ? call.httpStatus : 0;
  if (call.error === 'TIMEOUT') {
    return failed({ httpStatus, message: '上游超时（10s）', upstreamFatal: true });
  }
  if (call.error === 'NETWORK') {
    return failed({ httpStatus, message: `网络错误：${call.errorName || 'Error'}`, upstreamFatal: true });
  }
  if (call.error === 'BAD_JSON') {
    return failed({ httpStatus, message: '上游响应非 JSON', upstreamFatal: true });
  }
  return null;
}

/**
 * HTTP 状态归一化：只处理「语义明确的」状态，其余（含 400）留给业务码判定。
 * 关键约定：
 *   - 只有 401 才算 token 失效；
 *   - 403 是出口 IP 被上游边缘风控/限流，不是 token 问题（环境问题，非致命）。
 * @param {number} httpStatus
 * @returns {object|null}
 */
function classifyHttpStatus(httpStatus) {
  if (httpStatus === 401) {
    return failed({ httpStatus, message: 'Token 已失效（HTTP 401）', tokenInvalid: true });
  }
  if (httpStatus === 403) {
    return failed({
      httpStatus,
      message: '上游拒绝访问（HTTP 403）：可能是出口 IP 被风控或触发限流，请稍后重试',
      upstreamBlocked: true,
    });
  }
  if (httpStatus === 429) {
    return failed({ httpStatus, message: '上游限流（HTTP 429），请稍后再试' });
  }
  if (httpStatus >= 500) {
    return failed({ httpStatus, message: `上游服务异常（HTTP ${httpStatus}）`, upstreamFatal: true });
  }
  return null;
}

/**
 * 业务失败（HTTP 2xx 或非 2xx 但 body 是业务 JSON）。
 * @param {*} json
 * @param {number} httpStatus
 * @returns {object}
 */
function classifyBusinessError(json, httpStatus) {
  const code = json && typeof json === 'object' && Number.isFinite(json.code) ? json.code : null;
  const upstreamMessage = pickUpstreamMessage(json);
  return failed({
    httpStatus,
    code,
    message: `上游业务失败 code=${code === null ? 'unknown' : code}: ${upstreamMessage || '未知'}`,
  });
}

/**
 * 统一失败分类。
 * 顺序：传输层 -> HTTP 状态（401/403/429/5xx）-> 非 2xx 的业务体 -> 2xx 的业务体。
 * @param {{httpStatus:number, json:any, error:string|null, errorName:string|null}} call
 * @param {'status'|'daily'} phase 当前处于哪一段请求（10001 只在 daily 段是幂等成功）
 * @returns {object|null} failed 结果；无失败返回 null
 */
function classifyFailure(call, phase) {
  const httpStatus = Number.isFinite(call.httpStatus) ? call.httpStatus : 0;

  const transport = classifyTransportError(call);
  if (transport) return transport;

  const statusFailure = classifyHttpStatus(httpStatus);
  if (statusFailure) return statusFailure;

  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const business = businessBody(call.json);

  if (!httpOk) {
    // 非 2xx 但 body 是可解析的业务体：按业务码判定，
    // 避免把 {code:10001} 这类确定的业务结论误报成「上游请求失败（HTTP xxx）」。
    if (business) {
      if (business.code === CODE_ALREADY_CHECKED_IN && phase === 'daily') {
        return alreadyCheckedIn(httpStatus, business);
      }
      return classifyBusinessError(business, httpStatus);
    }
    // 非 2xx 且 body 不是业务 JSON（典型：WAF/网关返回 HTML 页）
    return failed({ httpStatus, message: `上游请求失败（HTTP ${httpStatus}）` });
  }

  if (!isBusinessOk(call.json)) return classifyBusinessError(call.json, httpStatus);
  return null;
}

/**
 * 只查询今日签到状态（不产生签到副作用），供 dryRun / 状态类接口复用。
 * @param {object} ctx
 * @param {object} account
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<object>} result ∈ already_checked_in | not_checked_in | failed
 */
export async function checkinStatus(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const token = sanitizeToken(acc.token);
  if (!token) {
    return failed({ message: 'Token 为空，请在面板重新填写' });
  }
  const call = await callUpstream(ctx, STATUS_PATH, { ...acc, token }, options);
  const failure = classifyFailure(call, 'status');
  if (failure) return { ...failure, durationMs: call.durationMs };

  const data = pickData(call.json);
  const streakDays = toNumber(data.streak_days === undefined ? data.streakDays : data.streak_days);
  const streakText = streakDays === null ? 0 : streakDays;
  if (data.today_checked_in === true) {
    return {
      result: 'already_checked_in',
      httpStatus: call.httpStatus,
      code: 0,
      message: truncate(`今日已签到，连续 ${streakText} 天`, MESSAGE_MAX_CHARS),
      credit: null,
      streakDays,
      durationMs: call.durationMs,
      tokenInvalid: false,
      upstreamBlocked: false,
      upstreamFatal: false,
    };
  }
  return {
    result: 'not_checked_in',
    httpStatus: call.httpStatus,
    code: 0,
    message: truncate('今日尚未签到', MESSAGE_MAX_CHARS),
    credit: null,
    streakDays,
    durationMs: call.durationMs,
    tokenInvalid: false,
    upstreamBlocked: false,
    upstreamFatal: false,
  };
}

/**
 * 执行单账号签到：先查 status，已签到则幂等跳过；否则调 daily-checkin。
 * 严格按 ARCHITECTURE §8 的九类分支（403 归为「出口风控」而非 token 失效）。
 * @param {object} ctx
 * @param {object} account Account（含 token）
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{result:'checked_in'|'already_checked_in'|'failed',
 *                    httpStatus:number, code:number|null, message:string,
 *                    credit:number|null, streakDays:number|null,
 *                    durationMs:number, tokenInvalid:boolean,
 *                    upstreamBlocked:boolean, upstreamFatal:boolean}>}
 */
export async function checkinAccount(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const token = sanitizeToken(acc.token);
  const startedAtMs = ctx.now();
  const elapsed = () => Math.max(0, ctx.now() - startedAtMs);

  if (!token) {
    return { ...failed({ message: 'Token 为空，请在面板重新填写' }), durationMs: elapsed() };
  }

  // 第一段：查询今日签到状态
  const statusCall = await callUpstream(ctx, STATUS_PATH, { ...acc, token }, options);
  const statusFailure = classifyFailure(statusCall, 'status');
  if (statusFailure) return { ...statusFailure, durationMs: elapsed() };

  const statusData = pickData(statusCall.json);
  const statusStreak = toNumber(statusData.streak_days === undefined ? statusData.streakDays : statusData.streak_days);
  if (statusData.today_checked_in === true) {
    // 幂等：已签到绝不调用 daily-checkin
    return {
      result: 'already_checked_in',
      httpStatus: statusCall.httpStatus,
      code: 0,
      message: truncate(`今日已签到，连续 ${statusStreak === null ? 0 : statusStreak} 天`, MESSAGE_MAX_CHARS),
      credit: null,
      streakDays: statusStreak,
      durationMs: elapsed(),
      tokenInvalid: false,
      upstreamBlocked: false,
      upstreamFatal: false,
    };
  }

  // 第二段：执行签到
  const dailyCall = await callUpstream(ctx, DAILY_PATH, { ...acc, token }, options);
  const dailyFailure = classifyFailure(dailyCall, 'daily');
  if (dailyFailure) return { ...dailyFailure, durationMs: elapsed() };

  const dailyData = pickData(dailyCall.json);
  const credit = toNumber(dailyData.credit);
  const streakDays = toNumber(dailyData.streak_days === undefined ? dailyData.streakDays : dailyData.streak_days);
  return {
    result: 'checked_in',
    httpStatus: dailyCall.httpStatus,
    code: 0,
    message: truncate(
      `签到成功，+${credit === null ? 0 : credit} 额度，连续 ${streakDays === null ? 0 : streakDays} 天`,
      MESSAGE_MAX_CHARS,
    ),
    credit,
    streakDays,
    durationMs: elapsed(),
    tokenInvalid: false,
    upstreamBlocked: false,
    upstreamFatal: false,
  };
}
