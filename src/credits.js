// src/credits.js
// WorkBuddy 积分配额查询：对接官方 billing/meter 资源接口。
//
// 接口口径参考 Cockpit Tools（jlcodes99/cockpit-tools，CC BY-NC-SA 4.0）的
// src-tauri/src/modules/buddy_resource_api.rs：仅参考接口路径、字段含义与分组规则，
// 未复制其源码；若需商用请自行评估上游接口与参考项目的许可约束。
//   POST /billing/meter/get-user-resource-summary        body {}
//   POST /billing/meter/get-user-resource-paid-packages  body {PageNumber, PageSize, PackageCodes[付费], Status:[0,3], NeedRenewInfo:true}
//   POST /billing/meter/get-user-resource-free-packages  body {PageNumber, PageSize, PackageCodes[免费], Status:[0,3], SlicePeriodStartTime, SlicePeriodEndTime}
// 注意：这些路由没有 /v2 前缀（签到接口是 /v2/billing/...），不要混用。
//
// 设计约束：
// - 只读上游，不写 KV；
// - 三个请求并发，任一失败整体失败（不返回“部分余额”，避免把 0 当成真实余额）；
// - 纯计算函数 computeCredits() 与 IO 分离，便于 node --test 直接断言。

import { AppError, truncate } from './util.js';
import { ensureFreshToken, tokenExpiresAtMs } from './upstream-token.js';
import { bearerOf, buildUpstreamHeaders } from './upstream-headers.js';
import { beijingDateTimeText, beijingParts } from './schedule.js';

const BASE = 'https://copilot.tencent.com';

/**
 * 额度接口 base：默认官方地址。
 * 仅用于本地联调（`wrangler dev --var CREDITS_BASE_URL:http://127.0.0.1:8790`），
 * 生产不在 wrangler.toml 里设置，永远走官方地址。
 * @param {object} ctx
 * @returns {string}
 */
function baseUrl(ctx) {
  const raw = ctx && ctx.env && typeof ctx.env.CREDITS_BASE_URL === 'string' ? ctx.env.CREDITS_BASE_URL : '';
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : BASE;
}
const ROUTE_SUMMARY = '/billing/meter/get-user-resource-summary';
const ROUTE_PAID = '/billing/meter/get-user-resource-paid-packages';
const ROUTE_FREE = '/billing/meter/get-user-resource-free-packages';

const TIMEOUT_MS = 12000;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;

/** 非确定性失败（403/429/5xx/超时）的重试次数与间隔：总计最多 2 次尝试。 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

/** 错误 message 里附带的响应体片段长度上限（去掉换行后截断）。 */
const SNIPPET_MAX_CHARS = 120;

// 官方套餐代码。付费包与免费包要分别请求，服务端按 PackageCodes 过滤。
const CODE = {
  free: 'TCACA_code_001_PqouKr6QWV',
  proMon: 'TCACA_code_002_AkiJS3ZHF5',
  proYear: 'TCACA_code_003_FAnt7lcmRT',
  proMonPlus: 'TCACA_code_005_maRGyrHhw1',
  gift: 'TCACA_code_006_DbXS0lrypC',
  activity: 'TCACA_code_007_nzdH5h4Nl0',
  freeMon: 'TCACA_code_008_cfWoLwvjU4',
  extra: 'TCACA_code_009_0XmEQc2xOf',
  youth: 'TCACA_code_023_4xbGhMrE6q',
  advanced: 'TCACA_code_026_BaESVICNoi',
  flagship: 'TCACA_code_027_0FCGVA6vSa',
  bonus28: 'TCACA_code_028_NtpWi0jzXs',
  bonus29: 'TCACA_code_029_6wCGEWquYy',
  bonus30: 'TCACA_code_030_BjSt89qTvr',
  freeMonIntl: 'TCACA_code_035_ArVxJcGDsm',
  extraIntl: 'TCACA_code_036_lupO5WgNdG',
  bonusIntl: 'TCACA_code_037_WxOD3MpI2o',
  extra38: 'TCACA_code_038_OhvqZtiPKr',
  proTrialMon: 'TCACA_code_039_KRcQj7wUat',
  proTrialYear: 'TCACA_code_040_mi9rCYg46x',
  buddyOneVip: 'TCACA_code_043_6oIkxT7Z0S',
};

// 与官方客户端一致：付费包与免费包分别请求，服务端按 PackageCodes 过滤。
// 注意：赠送/奖励类包在「免费包」里查（官方就是这么分的），不要放进付费请求。
const PAID_CODES = [
  CODE.proMon, CODE.proMonPlus, CODE.proYear, CODE.youth, CODE.advanced, CODE.flagship,
  CODE.buddyOneVip, CODE.extra, CODE.extra38, CODE.extraIntl,
];

const FREE_CODES = [
  CODE.free, CODE.freeMon, CODE.freeMonIntl, CODE.gift, CODE.proTrialMon, CODE.proTrialYear,
  CODE.activity, CODE.bonus28, CODE.bonusIntl, CODE.bonus29, CODE.bonus30,
];

/** 四类积分（顺序即面板展示顺序）。 */
export const CREDIT_GROUPS = [
  {
    key: 'planBase',
    label: '套餐基础积分',
    codes: [
      CODE.proMon, CODE.proMonPlus, CODE.proYear, CODE.youth, CODE.advanced, CODE.flagship,
      CODE.buddyOneVip, CODE.freeMon, CODE.freeMonIntl, CODE.proTrialMon, CODE.proTrialYear, CODE.free,
    ],
  },
  { key: 'planBonus', label: '套餐赠送积分', codes: [CODE.bonus28, CODE.bonusIntl] },
  { key: 'benefit', label: '平台奖励积分', codes: [CODE.activity, CODE.bonus29, CODE.bonus30, CODE.gift] },
  { key: 'addon', label: '购买积分', codes: [CODE.extra, CODE.extra38, CODE.extraIntl] },
];

/** 套餐基础积分里优先展示哪一个（与官方客户端一致：高等级优先、有余额优先、总量大优先）。 */
const BASE_PRIORITY = {
  [CODE.buddyOneVip]: 5,
  [CODE.flagship]: 4,
  [CODE.advanced]: 3,
  [CODE.proMon]: 2,
  [CODE.proMonPlus]: 2,
  [CODE.proYear]: 2,
  [CODE.youth]: 1,
};

const PLAN_LABELS = {
  [CODE.free]: 'FREE',
  [CODE.freeMon]: 'FREE',
  [CODE.freeMonIntl]: 'FREE',
  [CODE.proMon]: 'PRO',
  [CODE.proMonPlus]: 'PRO',
  [CODE.proYear]: 'PRO',
  [CODE.youth]: '青春版',
  [CODE.advanced]: '高级版',
  [CODE.flagship]: '旗舰版',
  [CODE.proTrialMon]: '试用',
  [CODE.proTrialYear]: '试用',
  [CODE.buddyOneVip]: 'BUDDY ONE',
};

/** 上游额度接口错误（区分 HTTP / 业务 code / 网络 / 超时 / 解析）。 */
export class CreditsError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CreditsError';
    this.kind = kind;
    this.status = Number.isFinite(extra.status) ? extra.status : 0;
    this.code = extra.code === undefined ? null : extra.code;
  }
}

// ============ 纯计算 ============

/** @param {*} value @returns {Record<string, unknown>|null} */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** @param {*} value @returns {number|null} */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 时间字段既可能是秒级/毫秒级数字，也可能是日期字符串。 */
function timeMs(value) {
  const numeric = num(value);
  if (numeric != null) {
    const abs = Math.abs(numeric);
    if (abs === 0) return null;
    return Math.trunc(abs < 1e12 ? numeric * 1000 : numeric);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  // 纯日期字符串（无时间部分）补成当天 00:00:00，否则拼 +08:00 后 Date.parse 会 NaN
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  // 兼容 "2026-11-14 16:17:00"（Safari 不接受空格分隔，换成 T）
  const normalized = dateOnly
    ? `${text}T00:00:00`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text;
  // 无时区后缀的日期时间字符串按北京时间（UTC+8）解析：上游为中国服务，
  // CycleEndTime / DeductionEndTime 等时间字段约定使用北京时间；
  // 带 Z / ±HH:MM 显式时区的字符串由 Date.parse 自行处理。
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = Date.parse(hasTz ? normalized : `${normalized}+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** CapacityType === 4 时，周期内按日切片（官方按天请求）。 */
function currentSlice(raw) {
  if (num(raw.CapacityType) !== 4) return null;
  const details = Array.isArray(raw.SlicePeriodUsageDetails) ? raw.SlicePeriodUsageDetails : [];
  return asRecord(details[0]);
}

/** @param {Record<string, unknown>} raw @returns {number} */
export function resourceTotal(raw) {
  const slice = currentSlice(raw);
  if (slice) return Math.max(0, num(slice.SlicePeriodCapacitySizePrecise) ?? 0);
  return Math.max(0, num(raw.CycleCapacitySizePrecise) ?? num(raw.CycleCapacitySize)
    ?? num(raw.CapacitySizePrecise) ?? num(raw.CapacitySize) ?? 0);
}

/** @param {Record<string, unknown>} raw @returns {number} */
export function resourceRemain(raw) {
  const slice = currentSlice(raw);
  if (slice) return Math.max(0, num(slice.SlicePeriodCapacityRemainPrecise) ?? 0);
  return Math.max(0, num(raw.CycleCapacityRemainPrecise) ?? num(raw.CycleCapacityRemain)
    ?? num(raw.CapacityRemainPrecise) ?? num(raw.CapacityRemain) ?? 0);
}

/** @param {Record<string, unknown>} raw @returns {number|null} */
function refreshAt(raw) {
  const cycleReset = timeMs(raw.CycleResetTime);
  if (cycleReset != null) return cycleReset;
  const cycleEnd = timeMs(raw.CycleEndTime);
  return cycleEnd == null ? null : cycleEnd + 1000;
}

/** @param {Record<string, unknown>} raw @returns {number|null} */
function expireAt(raw) {
  return timeMs(raw.DeductionEndTime) ?? timeMs(raw.ExpiredTime) ?? timeMs(raw.CycleEndTime);
}

/** @param {Record<string, unknown>} raw @returns {boolean} */
function isActive(raw) {
  if (raw.Unlimited === true || raw.unlimited === true) return true;
  const status = num(raw.Status ?? raw.status);
  return status === 0 || status === 3;
}

/** @param {string} code @returns {string|null} */
function planLabelOf(code) {
  return PLAN_LABELS[code] || null;
}

/**
 * 计算积分视图（纯函数，无 IO）。
 * @param {{summary?:object|null, resources?:object[]|null}} input
 * @param {number} nowMs
 * @returns {{status:'normal'|'warning', totalLeft:number|null, planLabel:string|null, switchAt:string|null, groups:object[]}}
 */
export function computeCredits(input, nowMs = Date.now()) {
  const summary = asRecord(input && input.summary);
  const rawList = Array.isArray(input && input.resources) ? input.resources : [];

  const resources = rawList
    .map((item) => asRecord(item))
    .filter((item) => item && isActive(item))
    .map((item) => {
      const total = resourceTotal(item);
      const left = resourceRemain(item);
      return {
        packageCode: typeof item.PackageCode === 'string' ? item.PackageCode : '',
        total,
        left,
        used: Math.max(0, total - left),
        expireAt: expireAt(item),
        refreshAt: refreshAt(item),
      };
    });

  const groups = [];
  let baseMember = null;
  for (const group of CREDIT_GROUPS) {
    let members = resources.filter((item) => group.codes.includes(item.packageCode)
      && (group.key === 'planBase' || item.expireAt == null || item.expireAt > nowMs));
    if (members.length === 0) continue;
    if (group.key === 'planBase') {
      members = members.slice().sort((a, b) =>
        (BASE_PRIORITY[b.packageCode] ?? 0) - (BASE_PRIORITY[a.packageCode] ?? 0)
        || Number(b.total === 0 || b.left > 0) - Number(a.total === 0 || a.left > 0)
        || b.total - a.total);
      members = [members[0]];
      baseMember = members[0];
    }
    const total = members.reduce((sum, item) => sum + item.total, 0);
    const left = members.reduce((sum, item) => sum + item.left, 0);
    const usesExpiry = group.key === 'benefit' || group.key === 'addon';
    const dates = members
      .map((item) => (usesExpiry ? item.expireAt : item.refreshAt))
      .filter((value) => value != null);
    const time = dates.length ? Math.min(...dates) : null;
    groups.push({
      key: group.key,
      label: group.label,
      total: round2(total),
      left: round2(left),
      used: round2(members.reduce((sum, item) => sum + item.used, 0)),
      remainPercent: total > 0 ? Math.max(0, Math.min(100, Math.floor((left / total) * 100))) : 0,
      time: time == null ? null : new Date(time).toISOString(),
      usesExpiry,
      expiring: usesExpiry && members.some((item) => item.left > 0 && item.expireAt != null
        && item.expireAt - nowMs <= 3 * 24 * 3600 * 1000),
    });
  }

  const packages = summary && Array.isArray(summary.Packages) ? summary.Packages : null;
  let totalLeft = null;
  if (packages) {
    totalLeft = round2(packages.reduce((sum, item) => {
      const record = asRecord(item);
      return sum + Math.max(0, num(record && record.CycleRemainCapacity) ?? 0);
    }, 0));
  } else if (groups.length) {
    totalLeft = round2(groups.reduce((sum, group) => sum + group.left, 0));
  }

  const switchAt = baseMember
    ? (baseMember.refreshAt == null ? null : new Date(baseMember.refreshAt).toISOString())
    : null;

  return {
    status: groups.length ? 'normal' : 'warning',
    totalLeft,
    planLabel: baseMember ? planLabelOf(baseMember.packageCode) : null,
    switchAt,
    groups,
  };
}

/** @param {number} value @returns {number} */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// ============ 上游请求 ============

/**
 * 组装额度接口请求头。
 * 字段定义统一收敛到 upstream-headers.js（与签到/续期共用），这里不再单独维护一份，
 * 避免「签到带了 X-User-Id、额度没带」这类同账号特征不一致的疏漏。
 * @param {object} account @returns {Record<string,string>}
 */
function creditHeaders(account) {
  return buildUpstreamHeaders(account);
}

/**
 * 上游响应体片段：去换行、压缩空白、截断到 120 字符，并剔除 token。
 * 目的：让「额度查询失败」的 message 一眼能看出是 WAF 拦截页还是业务错误。
 * @param {*} text 上游原始响应文本
 * @param {Record<string,string>|null|undefined} headers 请求头（取 token 做脱敏）
 * @returns {string}
 */
function bodySnippet(text, headers) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  let snippet = truncate(text.replace(/\s+/g, ' ').trim(), SNIPPET_MAX_CHARS);
  const token = bearerOf(headers);
  // 上游若把请求头回显到体里，message 依然不得出现 token
  if (token) snippet = snippet.split(token).join('***');
  return snippet;
}

/**
 * 判定额度查询失败是否值得重试：只重试「非确定性失败」。
 * 401（token 失效）与业务 code 失败属于确定性结论，重试没有意义。
 * @param {*} err
 * @returns {boolean}
 */
function isRetryable(err) {
  if (!(err instanceof CreditsError)) return false;
  if (err.kind === 'timeout') return true;
  if (err.kind === 'http') return err.status === 403 || err.status === 429 || err.status >= 500;
  return false;
}

/**
 * 解析等待函数：优先 options.sleep（单测注入），其次 ctx.sleep，最后 setTimeout。
 * @param {object} ctx
 * @param {object} options
 * @returns {(ms:number)=>Promise<void>}
 */
function resolveSleep(ctx, options) {
  const custom = options && typeof options.sleep === 'function' ? options.sleep : null;
  if (custom) return custom;
  const fromCtx = ctx && typeof ctx.sleep === 'function' ? ctx.sleep : null;
  if (fromCtx) return fromCtx;
  return (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发一次额度请求，返回 data 对象。
 * @param {object} ctx
 * @param {string} route
 * @param {Record<string,string>} headers
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function postMeter(ctx, route, headers, body, timeoutMs) {
  const controller = new AbortController();
  let timer = null;

  // fetch 与超时 Promise 竞速：即使某些实现忽略 AbortSignal，也不会永久挂起。
  const task = (async () => {
    const response = await ctx.fetch(`${baseUrl(ctx)}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  })();
  // 超时后 task 迟到的 reject 不应触发 unhandledRejection
  task.catch(() => {});

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CreditsError('timeout', '额度接口超时'));
    }, timeoutMs);
  });

  let response;
  let text;
  try {
    ({ response, text } = await Promise.race([task, timeout]));
  } catch (err) {
    if (err instanceof CreditsError) throw err;
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new CreditsError('timeout', '额度接口超时');
    }
    throw new CreditsError('network', `网络错误：${(err && err.name) || 'Error'}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (!response.ok) {
    // 带上响应体片段：一眼区分「WAF/网关拦截页」与「上游业务错误」
    const snippet = bodySnippet(text, headers);
    const message = snippet
      ? `额度接口返回 HTTP ${response.status}：${snippet}`
      : `额度接口返回 HTTP ${response.status}`;
    throw new CreditsError('http', message, { status: response.status });
  }
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) {
    throw new CreditsError('bad_json', '额度接口响应过大');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const snippet = bodySnippet(text, headers);
    throw new CreditsError('bad_json', snippet ? `额度接口响应非 JSON：${snippet}` : '额度接口响应非 JSON');
  }
  const code = num(json && json.code);
  if (code != null && code !== 0 && code !== 200) {
    const snippet = bodySnippet(text, headers);
    throw new CreditsError(
      'api',
      snippet ? `额度接口业务失败 code=${code}：${snippet}` : `额度接口业务失败 code=${code}`,
      { code },
    );
  }
  const data = asRecord(json && json.data);
  if (!data) throw new CreditsError('data', '额度接口缺少 data');
  return data;
}

/**
 * 拉取一页资源包（自动翻页）。
 * @param {object} ctx
 * @param {string} route
 * @param {Record<string,string>} headers
 * @param {(page:number)=>object} bodyOf
 * @param {number} timeoutMs
 * @returns {Promise<object[]>}
 */
async function fetchPackages(ctx, route, headers, bodyOf, timeoutMs) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await postMeter(ctx, route, headers, bodyOf(page), timeoutMs);
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    items.push(...accounts);
    const total = num(data.TotalCount);
    if (accounts.length === 0) break;
    if (total == null ? accounts.length < PAGE_SIZE : items.length >= total) break;
  }
  return items;
}

/**
 * 单次尝试：并发拉 summary + 付费包 + 免费包，合并去重后计算视图（不做重试）。
 * @param {object} ctx
 * @param {{account:object, headers:Record<string,string>, date:string,
 *          timeoutMs:number, nowMs:number}} params
 * @returns {Promise<object>}
 */
async function fetchCreditsOnce(ctx, params) {
  const { account, headers, date, timeoutMs, nowMs } = params;
  const [summary, paid, free] = await Promise.all([
    postMeter(ctx, ROUTE_SUMMARY, headers, {}, timeoutMs),
    fetchPackages(ctx, ROUTE_PAID, headers, (page) => ({
      PageNumber: page,
      PageSize: PAGE_SIZE,
      PackageCodes: PAID_CODES,
      Status: [0, 3],
      NeedRenewInfo: true,
    }), timeoutMs),
    fetchPackages(ctx, ROUTE_FREE, headers, (page) => ({
      PageNumber: page,
      PageSize: PAGE_SIZE,
      PackageCodes: FREE_CODES,
      Status: [0, 3],
      SlicePeriodStartTime: `${date} 00:00:00`,
      SlicePeriodEndTime: `${date} 23:59:59`,
    }), timeoutMs),
  ]);

  // 同一 ResourceId 可能同时出现在付费与免费查询里，按官方口径去重。
  const seen = new Set();
  const resources = [];
  for (const item of [...paid, ...free]) {
    const record = asRecord(item);
    if (!record) continue;
    const id = record.ResourceId == null ? null : String(record.ResourceId);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    resources.push(record);
  }

  const computed = computeCredits({ summary, resources }, nowMs);
  return {
    accountId: typeof account.id === 'string' ? account.id : '',
    fetchedAt: new Date(nowMs).toISOString(),
    ...computed,
  };
}

/**
 * 查询单个账号的积分配额。
 * 对 403 / 429 / 5xx / 超时这类「非确定性失败」，整体失败后间隔约 400ms 重试一次
 * （总计最多 2 次尝试）；401 与业务码失败是确定性结论，不重试。
 * @param {object} ctx
 * @param {object} account 含明文 token 的账号
 * @param {{timeoutMs?:number, now?:number, sleep?:(ms:number)=>Promise<void>}} [options]
 *   sleep 仅用于单测注入，生产走 setTimeout。
 * @returns {Promise<object>} 可直接出参的积分视图
 */
export async function fetchAccountCredits(ctx, account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const token = typeof acc.token === 'string' ? acc.token : '';
  if (!token) throw new CreditsError('data', '账号缺少 token');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, options.timeoutMs) : TIMEOUT_MS;
  const nowMs = Number.isFinite(options.now) ? options.now : (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const date = beijingParts(nowMs).date;
  const headers = creditHeaders(acc);
  const sleep = resolveSleep(ctx, options);
  const params = { account: acc, headers, date, timeoutMs, nowMs };

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchCreditsOnce(ctx, params);
    } catch (err) {
      lastError = err;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
  // 理论不可达（循环内必然 return 或 throw），兜底保持类型稳定
  throw lastError instanceof CreditsError ? lastError : new CreditsError('network', '额度查询失败');
}

/**
 * 服务层：按账号 id 查询（供 REST / 未来 MCP 复用）。
 * 只有 HTTP 401 映射 tokenInvalid；403 是出口被上游边缘风控，映射 upstreamBlocked。
 *
 * 401 的含义要结合 token 生命周期解释：WorkBuddy 的 access_token 只有 3600 秒有效期，
 * 过期后网关直接拒签。因此这里的顺序是「先按 exp 判断并自动续期 -> 再请求 -> 401 兜底再续期一次」，
 * 只有续期也失败时才把结论抛给用户，并在 detail 里带上「是否过期 / 有没有 refresh_token / 续期失败原因」。
 * @param {object} ctx
 * @param {string} accountId
 * @param {{timeoutMs?:number, sleep?:(ms:number)=>Promise<void>}} [options]
 * @returns {Promise<object>}
 * @throws {AppError} NOT_FOUND | UPSTREAM_ERROR
 */
export async function svcAccountCredits(ctx, accountId, options = {}) {
  const id = typeof accountId === 'string' ? accountId : '';
  const accounts = await ctx.kv.getAccounts();
  const account = accounts.find((item) => item && item.id === id);
  if (!account) throw new AppError('NOT_FOUND', '账号不存在');

  // 第一段：按 JWT exp 判断是否临近过期，能刷则先刷（失败不阻塞，交给上游裁决）
  const prepared = await ensureFreshToken(ctx, account, options);
  let effective = prepared.account;
  let refreshError = prepared.error;

  try {
    return await fetchAccountCredits(ctx, effective, options);
  } catch (err) {
    // 第二段：exp 解不出来（例如非 JWT 或上游换了 token 格式）时，用 401 作为刷新信号再试一次
    const canRetry = err instanceof CreditsError && err.status === 401
      && !prepared.refreshed
      && typeof effective.refreshToken === 'string' && Boolean(effective.refreshToken);
    if (canRetry) {
      const forced = await ensureFreshToken(ctx, effective, { ...options, force: true });
      if (forced.refreshed) {
        try {
          return await fetchAccountCredits(ctx, forced.account, options);
        } catch (retryErr) {
          if (!(retryErr instanceof CreditsError)) throw retryErr;
          err = retryErr;
          effective = forced.account;
          refreshError = null;
        }
      } else {
        refreshError = forced.error || refreshError;
      }
    }

    if (err instanceof CreditsError) {
      // 关键修正：403 不是 token 失效（线上实测 token 有效但上游边缘返回 403）。
      const tokenInvalid = err.status === 401;
      const upstreamBlocked = err.status === 403;
      const nowMs = typeof ctx.now === 'function' ? ctx.now() : 0;
      const expMs = tokenExpiresAtMs(effective.token);
      const expired = expMs !== null && expMs <= nowMs;
      // 面向用户的过期文本用北京时间展示（与面板口径一致）
      const expiresText = expMs === null ? '' : beijingDateTimeText(expMs);
      const hasRefreshToken = typeof effective.refreshToken === 'string' && Boolean(effective.refreshToken);
      const refreshHint = refreshError ? `：${refreshError.message}` : '';
      const message = tokenInvalid
        ? (hasRefreshToken
          // 有 refresh_token：只报「续期失败」，因为这才是用户唯一能行动的点
          ? `Token 已失效（HTTP 401），自动续期失败${refreshHint || '（未知原因）'}。请重新导出账号 JSON 导入`
          // 没有 refresh_token：说明 access_token 一定会被过期/轮换，必须重导
          : `Token 已失效（HTTP 401）：${expired ? `已于 ${expiresText} 过期` : '可能已被上游轮换或吊销'}。该账号未保存 refresh_token，无法自动续期，请重新导出完整账号 JSON（含 refreshToken）导入`)
        : upstreamBlocked
          ? '上游拒绝访问（HTTP 403）：可能是出口 IP 被风控或触发限流，请稍后重试'
          : err.kind === 'timeout'
            ? '额度查询超时，请稍后重试'
            : `额度查询失败：${err.message}`;
      throw new AppError('UPSTREAM_ERROR', message, {
        tokenInvalid,
        upstreamBlocked,
        kind: err.kind,
        status: err.status,
        expired,
        expiresAt: expMs === null ? null : new Date(expMs).toISOString(),
        hasRefreshToken,
        refreshError: refreshError ? refreshError.message : null,
      });
    }
    throw err;
  }
}
