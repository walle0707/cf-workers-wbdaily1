// src/api.js
// 24 条 /api/* REST 路由（第 25 个端点 /api/mcp 由 mcp.js 处理）+ 可复用的服务函数（svc*）。
// mcp.js 只允许 import 这里的 svc*，不得自己写 KV，避免两套账号/日志逻辑漂移。
// 约束：不得访问裸 env / 全局 fetch / Date.now()（时间一律 ctx.now()）。

import {
  AppError,
  isoNow,
  newAccountId,
  ok,
  randomB64,
  safeEqual,
  sanitizeToken,
  sha256Hex,
} from './util.js';
import { assertSameOrigin, matchRoute, readJson, requireAuth } from './router.js';
import {
  buildClearCookie,
  buildSessionCookie,
  clientIp,
  hashPassword,
  SESSION_TTL_SEC,
  signSession,
  verifyPassword,
} from './auth.js';
import { MAX_ACCOUNTS, MAX_LOG_INDEX } from './store.js';
import { runCheckin } from './run.js';
import { checkinStatus } from './checkin.js';
import { svcAccountCredits } from './credits.js';
import { buildCockpitExport, mergeImportedAccounts, normalizeImportPayload } from './account-io.js';
import { withFreshToken } from './upstream-token.js';
import { recordProgress } from './progress.js';
import { parseCheckinHour, pickNextCheckinHour } from './schedule.js';
// 账号出参脱敏：抽到 account-view.js，api.js 与 oauth.js 共用（避免两者循环依赖）
import { maskAccount } from './account-view.js';
// OAuth 授权登录（服务端代理上游 3 个 /v2/plugin 接口）
import { pollWorkbuddyLogin, startWorkbuddyLogin } from './oauth.js';

/** 服务版本号（bootstrap 与 MCP serverInfo 保持一致）。 */
export const VERSION = '1.0.0';

/** auth 记录内存缓存键与 TTL（与 router.requireAuth 同口径）。 */
const AUTH_CACHE_KEY = 'auth';
const AUTH_CACHE_TTL_MS = 10000;

/** 默认 PBKDF2 迭代数（env 缺省时）。 */
const DEFAULT_PBKDF2_ITERATIONS = 30000;

/** 密码长度约束。 */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

/** 账号字段约束。 */
const NAME_MAX_LENGTH = 32;
const UID_MAX_LENGTH = 64;
const REMARK_MAX_LENGTH = 200;

/** 设置项约束。 */
const RETENTION_MIN = 5;
const RETENTION_MAX = 100;

/** 登录失败提示里引用的次数上限（与 createLimiter 默认 maxFailures 一致）。 */
const LOGIN_MAX_FAILURES = 5;

/**
 * 结构化日志（单行 JSON）。
 * @param {'info'|'warn'|'error'} level
 * @param {string} event
 * @param {object} [fields]
 */
function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * 读取 auth 记录（优先 10s 内存缓存，miss 时读一次 KV 并回填）。
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
async function readAuthRecord(ctx) {
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
 * 失效 auth 缓存（setup / 改密 / mcp-key 等写操作后调用）。
 * @param {object} ctx
 */
function invalidateAuthCache(ctx) {
  if (ctx.authCache && typeof ctx.authCache.invalidate === 'function') {
    ctx.authCache.invalidate(AUTH_CACHE_KEY);
  }
}

/**
 * 取 env 中的 PBKDF2 迭代数（hashPassword 内部会 clamp 到 [10000, 200000]）。
 * @param {object} ctx
 * @returns {number}
 */
function iterationsFrom(ctx) {
  const raw = ctx.env ? Number(ctx.env.PBKDF2_ITERATIONS) : NaN;
  return Number.isFinite(raw) ? raw : DEFAULT_PBKDF2_ITERATIONS;
}

/**
 * 密码归一化口径：**setup / login / 改密（旧密码 + 新密码）四处必须完全一致**。
 * 用户从密码管理器复制密码常带首尾空格，若只在 setup 处 trim，
 * 就会「设置成功但永远登不进去」。这里是唯一的 trim 入口。
 * @param {*} input
 * @returns {string}
 */
function normalizePasswordForCompare(input) {
  return typeof input === 'string' ? input.trim() : '';
}

/**
 * 密码校验：trim 后 8~128 字符（长度校验也用归一化后的值）。
 * @param {*} input
 * @returns {string} 归一化后的密码
 * @throws {AppError} BAD_REQUEST
 */
function normalizePassword(input) {
  const value = normalizePasswordForCompare(input);
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new AppError('BAD_REQUEST', `密码至少 ${PASSWORD_MIN_LENGTH} 位`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new AppError('BAD_REQUEST', `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`);
  }
  return value;
}

/**
 * 取字符串字段并 trim；非字符串返回空串。
 * @param {*} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ===== 服务层（api 与 mcp 共用，全部只经 ctx.kv.* 访问 KV）=====

/**
 * 账号列表（脱敏）。
 * @param {object} ctx
 * @returns {Promise<object[]>}
 */
export async function svcListAccounts(ctx) {
  const accounts = await ctx.kv.getAccounts();
  return accounts.map((account) => maskAccount(account));
}

/**
 * 账号列表（含明文 token，仅供服务端内部使用，禁止直接出参）。
 * @param {object} ctx
 * @returns {Promise<object[]>}
 */
async function svcRawAccounts(ctx) {
  const accounts = await ctx.kv.getAccounts();
  return accounts.filter((account) => account && typeof account === 'object');
}

/**
 * 新建账号。
 * @param {object} ctx
 * @param {object} input {name, token, uid?, remark?, enabled?}
 * @returns {Promise<object>} 脱敏后的账号
 * @throws {AppError} BAD_REQUEST | CONFLICT
 */
export async function svcCreateAccount(ctx, input) {
  const src = input && typeof input === 'object' ? input : {};
  const name = asString(src.name);
  if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
    throw new AppError('BAD_REQUEST', `账号名称长度需为 1~${NAME_MAX_LENGTH} 个字符`);
  }
  const token = sanitizeToken(src.token);
  if (!token) throw new AppError('BAD_REQUEST', 'Token 不能为空');
  const refreshToken = sanitizeToken(src.refreshToken);
  const uid = asString(src.uid);
  if (uid.length > UID_MAX_LENGTH) {
    throw new AppError('BAD_REQUEST', `UID 不能超过 ${UID_MAX_LENGTH} 个字符`);
  }
  const remark = asString(src.remark);
  if (remark.length > REMARK_MAX_LENGTH) {
    throw new AppError('BAD_REQUEST', `备注不能超过 ${REMARK_MAX_LENGTH} 个字符`);
  }
  // 签到小时：显式传了就必须合法；没传则自动挑一个没被占用的整点，避免新账号全部压在 8 点
  let checkinHour = null;
  if (src.checkinHour !== undefined && src.checkinHour !== null && src.checkinHour !== '') {
    checkinHour = parseCheckinHour(src.checkinHour);
    if (checkinHour === null) {
      throw new AppError('BAD_REQUEST', 'checkinHour 必须是 0~23 的整数（北京时间整点）');
    }
  }
  const accounts = await ctx.kv.getAccounts();
  if (accounts.length >= MAX_ACCOUNTS) {
    throw new AppError('CONFLICT', `最多 ${MAX_ACCOUNTS} 个账号`);
  }
  const nowIso = isoNow(ctx.now());
  const account = {
    id: newAccountId(),
    name,
    token,
    uid,
    enabled: src.enabled === undefined ? true : src.enabled === true,
    remark,
    checkinHour: pickNextCheckinHour(accounts, checkinHour),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  // 有 refresh_token 才能扛过 access_token 的短期有效期，缺失时不写该字段（保持记录干净）
  if (refreshToken) account.refreshToken = refreshToken;
  const next = [...accounts, account];
  await ctx.kv.putAccounts(next);
  return maskAccount(account);
}

/**
 * 更新账号。token 字段缺失或空串 = 不修改。
 * @param {object} ctx
 * @param {string} id
 * @param {object} input
 * @returns {Promise<object>} 脱敏后的账号
 * @throws {AppError} BAD_REQUEST | NOT_FOUND
 */
export async function svcUpdateAccount(ctx, id, input) {
  const targetId = asString(id);
  if (!targetId) throw new AppError('NOT_FOUND', '账号不存在');
  const src = input && typeof input === 'object' ? input : {};
  const accounts = await ctx.kv.getAccounts();
  const index = accounts.findIndex((account) => account && account.id === targetId);
  if (index < 0) throw new AppError('NOT_FOUND', '账号不存在');

  const current = accounts[index];
  const next = { ...current };

  if (src.name !== undefined) {
    const name = asString(src.name);
    if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
      throw new AppError('BAD_REQUEST', `账号名称长度需为 1~${NAME_MAX_LENGTH} 个字符`);
    }
    next.name = name;
  }
  if (src.token !== undefined && asString(src.token) !== '') {
    const token = sanitizeToken(src.token);
    if (!token) throw new AppError('BAD_REQUEST', 'Token 不能为空');
    next.token = token;
    // token 换了，旧的过期时间作废（下次访问会按新 JWT 重新计算）
    delete next.expiresAt;
  }
  // refresh_token 与 token 同语义：留空 = 不修改，便于用户只换 access_token
  if (src.refreshToken !== undefined && asString(src.refreshToken) !== '') {
    const refreshToken = sanitizeToken(src.refreshToken);
    if (refreshToken) next.refreshToken = refreshToken;
  }
  if (src.uid !== undefined) {
    const uid = asString(src.uid);
    if (uid.length > UID_MAX_LENGTH) {
      throw new AppError('BAD_REQUEST', `UID 不能超过 ${UID_MAX_LENGTH} 个字符`);
    }
    next.uid = uid;
  }
  if (src.remark !== undefined) {
    const remark = asString(src.remark);
    if (remark.length > REMARK_MAX_LENGTH) {
      throw new AppError('BAD_REQUEST', `备注不能超过 ${REMARK_MAX_LENGTH} 个字符`);
    }
    next.remark = remark;
  }
  if (src.enabled !== undefined) {
    next.enabled = src.enabled === true;
  }
  // 签到小时（北京时间整点）：传了才改，非法直接 400，避免静默回落造成"改了没生效"
  if (src.checkinHour !== undefined && src.checkinHour !== null && src.checkinHour !== '') {
    const hour = parseCheckinHour(src.checkinHour);
    if (hour === null) {
      throw new AppError('BAD_REQUEST', 'checkinHour 必须是 0~23 的整数（北京时间整点）');
    }
    next.checkinHour = hour;
  }
  next.updatedAt = isoNow(ctx.now());

  const list = accounts.slice();
  list[index] = next;
  await ctx.kv.putAccounts(list);
  return maskAccount(next);
}

/**
 * 删除账号。
 * @param {object} ctx
 * @param {string} id
 * @returns {Promise<{deleted:boolean}>}
 * @throws {AppError} NOT_FOUND
 */
export async function svcDeleteAccount(ctx, id) {
  const targetId = asString(id);
  if (!targetId) throw new AppError('NOT_FOUND', '账号不存在');
  const accounts = await ctx.kv.getAccounts();
  const list = accounts.filter((account) => account && account.id !== targetId);
  if (list.length === accounts.length) throw new AppError('NOT_FOUND', '账号不存在');
  await ctx.kv.putAccounts(list);
  return { deleted: true };
}

/**
 * 日志索引（倒序），limit 为空时返回全部（索引本身已按 retentionRuns 裁剪）。
 * @param {object} ctx
 * @param {number|string|null} [limit]
 * @returns {Promise<object[]>}
 */
export async function svcGetLogs(ctx, limit) {
  const index = await ctx.kv.getLogIndex();
  if (limit === null || limit === undefined || limit === '') return index;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return index;
  const size = Math.max(1, Math.min(MAX_LOG_INDEX, Math.floor(parsed)));
  return index.slice(0, size);
}

/**
 * 单次 run 明细：必须先命中索引（孤儿明细键不泄漏）。
 * @param {object} ctx
 * @param {string} runId
 * @returns {Promise<object>}
 * @throws {AppError} NOT_FOUND
 */
export async function svcGetRun(ctx, runId) {
  const target = asString(runId);
  if (!target) throw new AppError('NOT_FOUND', '日志不存在');
  const index = await ctx.kv.getLogIndex();
  const hit = index.some((item) => item && item.runId === target);
  if (!hit) throw new AppError('NOT_FOUND', '日志不存在');
  const detail = await ctx.kv.getRunDetail(target);
  if (!detail) throw new AppError('NOT_FOUND', '日志不存在');
  return detail;
}

/**
 * 清空日志：删明细 + 索引置空。
 * @param {object} ctx
 * @returns {Promise<{deleted:number}>}
 */
export async function svcClearLogs(ctx) {
  const index = await ctx.kv.getLogIndex();
  const ids = index.map((item) => (item && typeof item.runId === 'string' ? item.runId : '')).filter(Boolean);
  const deleted = await ctx.kv.deleteRunDetails(ids);
  await ctx.kv.putLogIndex([]);
  return { deleted };
}

/**
 * 设置视图。目前只有日志保留条数：
 * - 签到时间是**每账号**属性（`accounts[].checkinHour`，北京时间整点）；
 * - cron 轮询间隔是部署常量（见 wrangler.toml），不随设置变化。
 * @param {object} ctx
 * @returns {Promise<{retentionRuns:number}>}
 */
export async function svcSettings(ctx) {
  const settings = await ctx.kv.getSettings();
  return {
    retentionRuns: Number.isFinite(settings.retentionRuns) ? settings.retentionRuns : 30,
  };
}

/**
 * 查询账号的今日签到状态（只调 checkin-status，不写 KV）。
 * @param {object} ctx
 * @param {string|null} [accountId] 省略时查全部启用账号
 * @returns {Promise<object[]>} [{accountId, accountName, result, message, streakDays, httpStatus, tokenInvalid}]
 * @throws {AppError} NOT_FOUND
 */
export async function svcCheckinStatus(ctx, accountId) {
  const accounts = await svcRawAccounts(ctx);
  const targetId = asString(accountId);
  const targets = targetId ? accounts.filter((account) => account.id === targetId) : accounts.filter((a) => a.enabled === true);
  if (targetId && targets.length === 0) throw new AppError('NOT_FOUND', '账号不存在');
  const out = [];
  for (const account of targets) {
    // access_token 只有 3600 秒有效期：先按 exp 续期，401 再兜底续期一次
    const status = await withFreshToken(ctx, account, (effective) => checkinStatus(ctx, effective));
    out.push({
      accountId: account.id,
      accountName: typeof account.name === 'string' ? account.name : '',
      result: status.result,
      message: status.message,
      streakDays: status.streakDays,
      httpStatus: status.httpStatus,
      tokenInvalid: status.tokenInvalid === true,
    });
  }
  return out;
}

// ===== 路由处理器 =====

/**
 * GET /api/bootstrap（公开）
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleBootstrap({ ctx }) {
  const authRecord = await readAuthRecord(ctx);
  return ok({
    initialized: Boolean(authRecord),
    version: VERSION,
    setupTokenRequired: Boolean(ctx.env && ctx.env.SETUP_TOKEN),
  });
}

/**
 * POST /api/setup（公开，可要求 x-setup-token）
 * @param {{ctx:object, request:Request, body:object}} params
 * @returns {Promise<Response>}
 */
async function handleSetup({ ctx, request, body }) {
  const setupToken = ctx.env ? ctx.env.SETUP_TOKEN : '';
  if (setupToken) {
    const provided = request.headers.get('x-setup-token') || '';
    const matched = await safeEqual(provided, setupToken);
    if (!matched) throw new AppError('FORBIDDEN', '部署令牌无效');
  }
  const password = normalizePassword(body ? body.password : '');
  // 二次确认：并发 setup 时只有一个能成功
  const existing = await ctx.kv.getAuth();
  if (existing) throw new AppError('CONFLICT', '系统已初始化');

  const hash = await hashPassword(password, { iterations: iterationsFrom(ctx) });
  const nowIso = isoNow(ctx.now());
  const record = {
    passwordHash: hash.passwordHash,
    salt: hash.salt,
    iterations: hash.iterations,
    sessionVersion: 1,
    sessionSecret: randomB64(32),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await ctx.kv.putAuth(record);
  invalidateAuthCache(ctx);
  return ok({ initialized: true });
}

/**
 * POST /api/login（公开，isolate 内存限流）
 * @param {{ctx:object, request:Request, body:object}} params
 * @returns {Promise<Response>}
 */
async function handleLogin({ ctx, request, body }) {
  const ip = clientIp(request);
  const gate = ctx.limiter.check(ip);
  if (!gate.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(gate.retryAfterSec || 1));
    throw new AppError(
      'RATE_LIMITED',
      `尝试过于频繁，请 ${retryAfterSec} 秒后再试`,
      { remaining: 0 },
      { headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }
  const authRecord = await readAuthRecord(ctx);
  if (!authRecord) throw new AppError('BAD_REQUEST', '系统尚未初始化，请先设置管理员密码');

  // 与 setup / 改密同一口径：先 trim 再比较（用户从密码管理器复制常带首尾空格）
  const password = normalizePasswordForCompare(body && body.password);
  const valid = await verifyPassword(password, authRecord);
  if (!valid) {
    ctx.limiter.fail(ip);
    const after = ctx.limiter.check(ip);
    const remaining = after.allowed ? Math.max(0, after.remaining) : 0;
    throw new AppError('UNAUTHORIZED', `密码错误，还可尝试 ${remaining} 次`, { remaining });
  }

  ctx.limiter.reset(ip);
  const token = await signSession({
    secret: authRecord.sessionSecret,
    sessionVersion: authRecord.sessionVersion,
    ttlSec: SESSION_TTL_SEC,
    now: ctx.now(),
  });
  const expiresAtMs = (Math.floor(ctx.now() / 1000) + SESSION_TTL_SEC) * 1000;
  return ok({ expiresAt: isoNow(expiresAtMs) }, { headers: { 'Set-Cookie': buildSessionCookie(token) } });
}

/**
 * POST /api/logout（auth）
 * @returns {Promise<Response>}
 */
async function handleLogout() {
  return ok({ loggedOut: true }, { headers: { 'Set-Cookie': buildClearCookie() } });
}

/**
 * GET /api/session（auth）
 * @param {{ctx:object, authSession:object}} params
 * @returns {Promise<Response>}
 */
async function handleSession({ ctx, authSession }) {
  const exp = authSession && Number.isFinite(authSession.exp) ? authSession.exp : Math.floor(ctx.now() / 1000);
  return ok({ authenticated: true, expiresAt: isoNow(exp * 1000) });
}

/**
 * POST /api/password（auth）：改密并 bump sessionVersion（旧 Cookie 全量失效）
 * @param {{ctx:object, request:Request, body:object, authRecord:object}} params
 * @returns {Promise<Response>}
 */
async function handleChangePassword({ ctx, body, authRecord }) {
  const current = authRecord || (await readAuthRecord(ctx));
  if (!current) throw new AppError('UNAUTHORIZED', '系统尚未初始化');
  const oldPassword = normalizePasswordForCompare(body && body.oldPassword);
  const valid = await verifyPassword(oldPassword, current);
  if (!valid) throw new AppError('UNAUTHORIZED', '原密码错误');
  const newPassword = normalizePassword(body ? body.newPassword : '');
  const hash = await hashPassword(newPassword, { iterations: iterationsFrom(ctx) });
  const next = {
    ...current,
    passwordHash: hash.passwordHash,
    salt: hash.salt,
    iterations: hash.iterations,
    sessionVersion: (Number.isFinite(current.sessionVersion) ? current.sessionVersion : 1) + 1,
    updatedAt: isoNow(ctx.now()),
  };
  await ctx.kv.putAuth(next);
  invalidateAuthCache(ctx);
  return ok({ updated: true });
}

/**
 * GET /api/accounts（auth）
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleListAccounts({ ctx }) {
  return ok(await svcListAccounts(ctx));
}

/**
 * POST /api/accounts（auth）
 * @param {{ctx:object, body:object}} params
 * @returns {Promise<Response>}
 */
async function handleCreateAccount({ ctx, body }) {
  return ok(await svcCreateAccount(ctx, body));
}

/**
 * PUT /api/accounts/:id（auth）
 * @param {{ctx:object, params:object, body:object}} params
 * @returns {Promise<Response>}
 */
async function handleUpdateAccount({ ctx, params, body }) {
  return ok(await svcUpdateAccount(ctx, params.id, body));
}

/**
 * DELETE /api/accounts/:id（auth）
 * @param {{ctx:object, params:object}} params
 * @returns {Promise<Response>}
 */
async function handleDeleteAccount({ ctx, params }) {
  return ok(await svcDeleteAccount(ctx, params.id));
}

/**
 * POST /api/accounts/:id/checkin（auth）：单账号签到（同步等待，落盘一次 run）
 * @param {{ctx:object, params:object}} params
 * @returns {Promise<Response>}
 */
async function handleAccountCheckin({ ctx, params }) {
  const id = asString(params.id);
  if (!id) throw new AppError('NOT_FOUND', '账号不存在');
  // 先确认账号存在（1 次读）：避免为一个打错的 id 白写一次 run（4 次 KV 写 + 脏日志）
  const accounts = await svcRawAccounts(ctx);
  if (!accounts.some((account) => account.id === id)) throw new AppError('NOT_FOUND', '账号不存在');
  const result = await runCheckin(ctx, { accountIds: [id], trigger: 'manual-single' });
  const entry = result.entries && result.entries[0] ? result.entries[0] : null;
  const outcome = result.outcomes && result.outcomes[0] ? result.outcomes[0] : null;
  if (!entry || (outcome && outcome.missing)) throw new AppError('NOT_FOUND', '账号不存在');
  if (outcome && outcome.upstreamFatal) {
    // 日志已落盘（诊断优先，已批准的偏差），HTTP 语义仍用 502
    throw new AppError('UPSTREAM_ERROR', entry.message);
  }
  // 手动签到也写当日进度：否则 cron 到点还会对同一账号再打一遍上游
  await recordProgress(ctx, result.entries);
  return ok({ ...entry, runId: result.runId });
}

/**
 * POST /api/accounts/import（auth）：兼容 cockpit-tools 的账号 JSON 导入。
 * body 可以是顶层数组、{accounts:[]}、{items:[]} 或单对象。
 * 只返回计数，绝不回显 token。
 * @param {{ctx:object, body:*}} params
 * @returns {Promise<Response>}
 */
async function handleImportAccounts({ ctx, body }) {
  const parsed = normalizeImportPayload(body);
  const existing = await ctx.kv.getAccounts();
  const nowMs = ctx.now();
  const merged = mergeImportedAccounts(existing, parsed.items, {
    nowMs,
    maxAccounts: MAX_ACCOUNTS,
    createdAt: isoNow(nowMs),
  });
  // 整批一次写入：导入 N 个账号也只产生 1 次 KV 写
  if (merged.imported > 0 || merged.updated > 0) {
    await ctx.kv.putAccounts(merged.accounts);
  }
  return ok({
    total: parsed.total,
    imported: merged.imported,
    updated: merged.updated,
    unchanged: merged.unchanged,
    skipped: parsed.skipped,
    reasons: parsed.reasons,
  });
}

/**
 * GET /api/accounts/export?id=（auth）：导出为 cockpit-tools 兼容格式。
 * 不带 id 时导出全部账号；带 id 时只导出该账号（仍返回数组，保证与 cockpit-tools
 * 导入格式、前端下载逻辑一致）。出参含明文 token，仅限已登录管理员；
 * 响应 no-store，服务端不打印 token。
 * @param {{ctx:object, url:URL}} params
 * @returns {Promise<Response>}
 * @throws {AppError} BAD_REQUEST id 为空字符串
 * @throws {AppError} NOT_FOUND 指定 id 的账号不存在
 */
async function handleExportAccounts({ ctx, url }) {
  const accounts = await ctx.kv.getAccounts();
  // 无 ?id= 参数 -> 全量导出（向后兼容，行为与改造前完全一致）
  const rawId = url && url.searchParams ? url.searchParams.get('id') : null;
  if (rawId === null) {
    const data = await buildCockpitExport(accounts, ctx.now());
    return ok(data);
  }
  const id = asString(rawId);
  if (!id) throw new AppError('BAD_REQUEST', 'id 不能为空');
  const list = Array.isArray(accounts) ? accounts : [];
  const target = list.filter((account) => account && account.id === id);
  if (target.length === 0) throw new AppError('NOT_FOUND', '账号不存在');
  const data = await buildCockpitExport(target, ctx.now());
  return ok(data);
}

/**
 * GET /api/accounts/:id/credits（auth）：实时查询积分配额。
 * 只读上游、零 KV 写；token 失效用 502 + detail.tokenInvalid 表达，
 * 不能用 401（否则前端会误判会话过期并退出登录）。
 * 上游 403（出口 IP 被风控/限流）用 detail.upstreamBlocked 表达，不标记 tokenInvalid。
 * @param {{ctx:object, params:object}} params
 * @returns {Promise<Response>}
 */
async function handleAccountCredits({ ctx, params }) {
  const credits = await svcAccountCredits(ctx, asString(params.id));
  return ok(credits);
}

/**
 * POST /api/oauth/start（auth）：申请一次 WorkBuddy OAuth 授权会话。
 * 只返回 { state, verificationUri, expiresIn, intervalSeconds }：
 * state 是本次登录的临时凭据（前端拿去轮询），**任何 token 都不出现在响应里**。
 * 写操作：沿用 handleApi 里的同源校验 + JSON body 机制（前端会带 {}）。
 * 真正常见的失败是「上游拒绝/超时」，统一映射成 502 UPSTREAM_ERROR。
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleOauthStart({ ctx }) {
  return ok(await startWorkbuddyLogin(ctx));
}

/**
 * GET /api/oauth/poll?state=（auth）：轮询授权结果。
 * 三种状态：pending（还在等登录）/ expired（state 失效，需重新生成）/ success（已落库，带脱敏账号）。
 * 「还在等」用返回值表达，不用 4xx/5xx，否则前端没法区分「继续等」和「出错」。
 * @param {{ctx:object, url:URL}} params
 * @returns {Promise<Response>}
 */
async function handleOauthPoll({ ctx, url }) {
  const state = url && url.searchParams ? url.searchParams.get('state') : '';
  return ok(await pollWorkbuddyLogin(ctx, state));
}

/**
 * POST /api/checkin/run（auth）：全部（或指定）账号签到
 * @param {{ctx:object, body:object}} params
 * @returns {Promise<Response>}
 */
async function handleRunCheckin({ ctx, body }) {
  const rawIds = body && body.accountIds !== undefined && body.accountIds !== null ? body.accountIds : null;
  let accountIds = null;
  if (rawIds !== null) {
    if (!Array.isArray(rawIds)) throw new AppError('BAD_REQUEST', 'accountIds 必须为字符串数组');
    for (const item of rawIds) {
      if (typeof item !== 'string' || !item) {
        throw new AppError('BAD_REQUEST', 'accountIds 必须为字符串数组');
      }
    }
    accountIds = rawIds.length > 0 ? rawIds : null;
  }
  const result = await runCheckin(ctx, { accountIds, trigger: 'manual' });
  // 手动签到也写当日进度，避免 cron 在同一小时里重复签
  await recordProgress(ctx, result.entries);
  return ok({ runId: result.runId, summary: result.summary, flushError: result.flushError });
}

/**
 * GET /api/logs?limit=（auth）
 * @param {{ctx:object, url:URL}} params
 * @returns {Promise<Response>}
 */
async function handleGetLogs({ ctx, url }) {
  const limit = url.searchParams.get('limit');
  return ok(await svcGetLogs(ctx, limit));
}

/**
 * GET /api/logs/:runId（auth）
 * @param {{ctx:object, params:object}} params
 * @returns {Promise<Response>}
 */
async function handleGetRun({ ctx, params }) {
  return ok(await svcGetRun(ctx, params.runId));
}

/**
 * DELETE /api/logs（auth）
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleClearLogs({ ctx }) {
  return ok(await svcClearLogs(ctx));
}

/**
 * GET /api/settings（auth）
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleGetSettings({ ctx }) {
  return ok(await svcSettings(ctx));
}

/**
 * 把日志裁剪到 retentionRuns 条（用户调低保留条数时立即回收）。
 * 顺序：先删明细、再写索引；失败只重试一次，绝不留下「索引指向已删明细」的半截状态。
 * 这样下一次 run 最多只淘汰 1 条，写入预算稳定在 4~5 次，
 * 不会出现「30→5 后下一次 run 一次删 20+ 条」的爆表。
 * @param {object} ctx
 * @param {number} retentionRuns
 * @returns {Promise<{evicted:number, failed:boolean}>}
 */
async function evictExcessLogs(ctx, retentionRuns) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const index = await ctx.kv.getLogIndex();
      if (index.length <= retentionRuns) return { evicted: 0, failed: false };
      const kept = index.slice(0, retentionRuns);
      const dropped = index
        .slice(retentionRuns)
        .map((item) => (item && typeof item.runId === 'string' ? item.runId : ''))
        .filter(Boolean);
      for (const runId of dropped) {
        await ctx.kv.deleteRunDetail(runId);
      }
      await ctx.kv.putLogIndex(kept);
      return { evicted: dropped.length, failed: false };
    } catch (err) {
      // 读回旧索引重试一次即可，不做跨键事务（KV 无 CAS）
      logEvent('warn', 'settings_evict_failed', {
        attempt,
        retentionRuns,
        message: String((err && err.message) || err),
      });
    }
  }
  return { evicted: 0, failed: true };
}

/**
 * PUT /api/settings（auth）：目前只有日志保留条数。
 * 签到时间是**每账号**属性，走 PUT /api/accounts/:id 的 checkinHour 字段。
 * @param {{ctx:object, body:object}} params
 * @returns {Promise<Response>}
 */
async function handlePutSettings({ ctx, body }) {
  const raw = body ? body.retentionRuns : undefined;
  const retention = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(retention) || !Number.isInteger(retention) || retention < RETENTION_MIN || retention > RETENTION_MAX) {
    throw new AppError('BAD_REQUEST', `retentionRuns 必须是 ${RETENTION_MIN}~${RETENTION_MAX} 的整数`);
  }
  await ctx.kv.putSettings({ retentionRuns: retention });
  // 立即回收超额日志（用户主动操作，写入成本可见；避免把淘汰压力推给下一次 run）
  const eviction = await evictExcessLogs(ctx, retention);
  const view = await svcSettings(ctx);
  return ok({ ...view, evicted: eviction.evicted, evictFailed: eviction.failed });
}

/**
 * GET /api/mcp-key（auth）
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleGetMcpKey({ ctx }) {
  const record = await ctx.kv.getMcp();
  if (!record) return ok({ exists: false });
  return ok({
    exists: true,
    prefix: typeof record.prefix === 'string' ? record.prefix : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  });
}

/**
 * POST /api/mcp-key（auth）：生成/重置 MCP Key，明文仅此一次返回
 * @param {{ctx:object}} params
 * @returns {Promise<Response>}
 */
async function handleRotateMcpKey({ ctx }) {
  const key = `sk-mcp_${randomB64(32)}`;
  const prefix = key.slice(0, 12);
  const nowIso = isoNow(ctx.now());
  await ctx.kv.putMcp({
    keyHash: await sha256Hex(key),
    prefix,
    createdAt: nowIso,
    rotatedAt: nowIso,
  });
  invalidateAuthCache(ctx);
  return ok({ key, prefix });
}

/**
 * 路由表（24 条；第 25 个端点 /api/mcp 由 mcp.js 处理）。
 * auth: true 表示需要会话 Cookie。
 * @type {Array<{method:string, pattern:string, handler:Function, auth:boolean}>}
 */
export const API_ROUTES = [
  { method: 'GET', pattern: '/api/bootstrap', handler: handleBootstrap, auth: false },
  { method: 'POST', pattern: '/api/setup', handler: handleSetup, auth: false },
  { method: 'POST', pattern: '/api/login', handler: handleLogin, auth: false },
  { method: 'POST', pattern: '/api/logout', handler: handleLogout, auth: true },
  { method: 'GET', pattern: '/api/session', handler: handleSession, auth: true },
  { method: 'POST', pattern: '/api/password', handler: handleChangePassword, auth: true },
  { method: 'GET', pattern: '/api/accounts', handler: handleListAccounts, auth: true },
  { method: 'POST', pattern: '/api/accounts', handler: handleCreateAccount, auth: true },
  { method: 'POST', pattern: '/api/accounts/import', handler: handleImportAccounts, auth: true, bodyLimit: 5 * 1024 * 1024 },
  { method: 'GET', pattern: '/api/accounts/export', handler: handleExportAccounts, auth: true },
  { method: 'PUT', pattern: '/api/accounts/:id', handler: handleUpdateAccount, auth: true },
  { method: 'DELETE', pattern: '/api/accounts/:id', handler: handleDeleteAccount, auth: true },
  { method: 'POST', pattern: '/api/accounts/:id/checkin', handler: handleAccountCheckin, auth: true },
  { method: 'GET', pattern: '/api/accounts/:id/credits', handler: handleAccountCredits, auth: true },
  // OAuth 授权录入：start 申请会话（写操作，走同源校验），poll 轮询结果
  { method: 'POST', pattern: '/api/oauth/start', handler: handleOauthStart, auth: true },
  { method: 'GET', pattern: '/api/oauth/poll', handler: handleOauthPoll, auth: true },
  { method: 'POST', pattern: '/api/checkin/run', handler: handleRunCheckin, auth: true },
  { method: 'GET', pattern: '/api/logs', handler: handleGetLogs, auth: true },
  { method: 'GET', pattern: '/api/logs/:runId', handler: handleGetRun, auth: true },
  { method: 'DELETE', pattern: '/api/logs', handler: handleClearLogs, auth: true },
  { method: 'GET', pattern: '/api/settings', handler: handleGetSettings, auth: true },
  { method: 'PUT', pattern: '/api/settings', handler: handlePutSettings, auth: true },
  { method: 'GET', pattern: '/api/mcp-key', handler: handleGetMcpKey, auth: true },
  { method: 'POST', pattern: '/api/mcp-key', handler: handleRotateMcpKey, auth: true },
];

/**
 * 判断请求是否真的带了 body。
 * 有 content-length 时按长度判断；否则看 body 流是否存在（chunked 上传）。
 * @param {Request} request
 * @returns {boolean}
 */
function hasRequestBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    return Number.isFinite(length) ? length > 0 : true;
  }
  return Boolean(request.body);
}

/**
 * 处理 /api/* 请求：路由匹配 -> 写操作同源 + JSON body -> 鉴权 -> 业务。
 * 未匹配抛 NOT_FOUND（由 index.js 转 JSON 404）。
 * 说明：写操作若确实没有 body（如 DELETE /api/logs、POST /api/logout），跳过 readJson 直接当 {}；
 * 带 body 时仍强制 application/json，跨站保护靠 assertSameOrigin。
 * @param {object} ctx
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleApi(ctx, request, url) {
  const method = String(request.method || 'GET').toUpperCase();
  const matched = matchRoute(method, url.pathname, API_ROUTES);
  if (!matched) throw new AppError('NOT_FOUND', '接口不存在');
  const { route, params } = matched;
  const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE';
  if (isWrite) assertSameOrigin(request, url);
  const body = isWrite && hasRequestBody(request)
    ? await readJson(request, route.bodyLimit ? { maxBytes: route.bodyLimit } : undefined)
    : isWrite ? {} : null;

  let authRecord = null;
  let authSession = null;
  if (route.auth) {
    const guard = await requireAuth(ctx, request);
    authRecord = guard.authRecord;
    authSession = guard.session;
  }

  const response = await route.handler({ ctx, request, url, params, body, authRecord, authSession });
  if (!response || !(response instanceof Response)) {
    logEvent('error', 'api_handler_bad_response', { pattern: route.pattern, method: route.method });
    return ok(null);
  }
  return response;
}
