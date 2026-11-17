// src/account-io.js
// 账号 JSON 导入 / 导出，兼容 jlcodes99/cockpit-tools 的 WorkBuddy 导出格式。
//
// cockpit-tools 导入实现（src-tauri/src/modules/workbuddy_account.rs）的硬约束：
//   - 接受顶层数组 / {accounts:[...]} / {items:[...]} / 单对象；
//   - 每条只强制要求 access_token（也接受 accessToken / token），其余字段可缺省；
//   - 导入时会按 uid → email → access_token 重新推导本地 id，忽略文件里的 id。
// 因此我们导出时保留同名关键字段（id/email/uid/nickname/access_token/token_type/
// status/created_at/last_used），缺失的 refresh_token、raw 快照不伪造、直接省略。
//
// 安全：导入结果只返回计数；导出含明文 token，仅允许已登录管理员调用，且不写日志。

import { AppError, newAccountId, sanitizeToken, sha256Hex, truncate } from './util.js';
import { parseCheckinHour, pickNextCheckinHour } from './schedule.js';

const NAME_MAX = 32;
const UID_MAX = 64;
const MAX_IMPORT_ITEMS = 200;

/** 单条导入条目最多接受这么多字节，避免超长 token 撑爆 KV。 */
const TOKEN_MAX_LENGTH = 8192;

/**
 * 取出待导入数组（兼容数组 / accounts / items / 单对象）。
 * @param {*} payload
 * @returns {object[]}
 * @throws {AppError} BAD_REQUEST
 */
export function extractImportItems(payload) {
  let list;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.accounts)) list = payload.accounts;
    else if (Array.isArray(payload.items)) list = payload.items;
    else list = [payload];
  } else {
    throw new AppError('BAD_REQUEST', '导入内容必须是 JSON 数组或对象');
  }
  if (list.length === 0) throw new AppError('BAD_REQUEST', '导入数组为空');
  if (list.length > MAX_IMPORT_ITEMS) {
    throw new AppError('BAD_REQUEST', `单次最多导入 ${MAX_IMPORT_ITEMS} 条记录`);
  }
  return list;
}

/**
 * 归一化单条记录（cockpit-tools / 本系统字段都接受）。
 *
 * refresh_token 必须一并保留：WorkBuddy 的 access_token 只有 3600 秒有效期，
 * 丢了 refresh_token 就等于「token 一失效就只能手动重导」。
 * 字段名同时兼容下划线与驼峰（cockpit-tools 导出用驼峰 refreshToken）。
 * @param {*} raw
 * @param {number} index 0-based
 * @returns {{ok:true, item:{name:string, token:string, refreshToken:string, uid:string, domain:string}}|{ok:false, reason:string}}
 */
export function normalizeImportItem(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `第 ${index + 1} 条不是对象` };
  }
  const tokenRaw = raw.access_token ?? raw.accessToken ?? raw.token;
  if (typeof tokenRaw !== 'string' || !tokenRaw.trim()) {
    return { ok: false, reason: `第 ${index + 1} 条缺少 access_token` };
  }
  const token = sanitizeToken(tokenRaw);
  if (!token) return { ok: false, reason: `第 ${index + 1} 条 access_token 为空` };
  if (token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, reason: `第 ${index + 1} 条 access_token 过长` };
  }

  // refresh_token 可选：缺失时仍允许导入（只是 token 失效后需重新导入）
  const refreshRaw = raw.refresh_token ?? raw.refreshToken;
  const refreshToken = typeof refreshRaw === 'string' ? sanitizeToken(refreshRaw) : '';
  if (refreshToken.length > TOKEN_MAX_LENGTH) {
    return { ok: false, reason: `第 ${index + 1} 条 refresh_token 过长` };
  }

  const uidRaw = raw.uid;
  const uid = typeof uidRaw === 'string' ? uidRaw.trim().slice(0, UID_MAX) : '';

  const domainRaw = raw.domain;
  const domain = typeof domainRaw === 'string' ? domainRaw.trim().slice(0, UID_MAX) : '';

  // 企业 ID：上游部分接口要求 X-Enterprise-Id / X-Tenant-Id，与 uid 一起决定租户上下文
  const enterpriseRaw = raw.enterprise_id ?? raw.enterpriseId;
  const enterpriseId = typeof enterpriseRaw === 'string' ? enterpriseRaw.trim().slice(0, UID_MAX) : '';

  // 每账号签到小时（北京时间整点）：cockpit 导出里没有这个字段，本系统导出时带上便于备份恢复
  const checkinHourRaw = raw.checkin_hour ?? raw.checkinHour;
  const checkinHour = parseCheckinHour(checkinHourRaw);
  if (checkinHourRaw !== undefined && checkinHourRaw !== null && checkinHourRaw !== '' && checkinHour === null) {
    return { ok: false, reason: `第 ${index + 1} 条 checkin_hour 必须是 0~23 的整数` };
  }

  const nick = typeof raw.nickname === 'string' ? raw.nickname.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  const name = truncate(nick || email || `导入账号 ${index + 1}`, NAME_MAX);

  // 只回传真实存在的可选字段，避免空串污染下游判定（也保持既有出参形状不变）
  const item = { name, token, uid };
  if (refreshToken) item.refreshToken = refreshToken;
  if (domain) item.domain = domain;
  if (enterpriseId) item.enterpriseId = enterpriseId;
  if (checkinHour !== null) item.checkinHour = checkinHour;
  return { ok: true, item };
}

/**
 * 批量归一化，非法条目计入 skipped 而不中断整批。
 * @param {*} payload
 * @returns {{items:object[], skipped:number, reasons:string[]}}
 */
export function normalizeImportPayload(payload) {
  const list = extractImportItems(payload);
  const items = [];
  const reasons = [];
  for (let i = 0; i < list.length; i += 1) {
    const result = normalizeImportItem(list[i], i);
    if (result.ok) items.push(result.item);
    else {
      if (reasons.length < 5) reasons.push(result.reason);
    }
  }
  return { items, skipped: list.length - items.length, reasons, total: list.length };
}

/**
 * 合并导入条目：uid 优先、其次 token 精确匹配。
 * 匹配到既有账号时只补 uid / 换 token，不覆盖用户改过的名称、备注与启用状态。
 * @param {object[]} existing
 * @param {object[]} incoming
 * @param {{nowMs:number, maxAccounts:number, createdAt:string}} options
 * @returns {{accounts:object[], imported:number, updated:number, unchanged:number}}
 * @throws {AppError} CONFLICT 超过账号上限
 */
export function mergeImportedAccounts(existing, incoming, options) {
  const nowIso = options.createdAt;
  const accounts = (Array.isArray(existing) ? existing : []).map((account) => ({ ...account }));
  let imported = 0;
  let updated = 0;
  let unchanged = 0;

  for (const item of incoming) {
    const matched = (item.uid ? accounts.find((account) => account.uid && account.uid === item.uid) : null)
      || accounts.find((account) => account.token === item.token);

    if (matched) {
      let changed = false;
      if (matched.token !== item.token) {
        matched.token = item.token;
        // token 换了，旧的过期时间立刻作废（refreshToken 可能没换，仍需重算）
        delete matched.expiresAt;
        changed = true;
      }
      if (item.refreshToken && matched.refreshToken !== item.refreshToken) {
        matched.refreshToken = item.refreshToken;
        changed = true;
      }
      if (!matched.uid && item.uid) {
        matched.uid = item.uid;
        changed = true;
      }
      if (!matched.domain && item.domain) {
        matched.domain = item.domain;
        changed = true;
      }
      if (!matched.enterpriseId && item.enterpriseId) {
        matched.enterpriseId = item.enterpriseId;
        changed = true;
      }
      if (!matched.name && item.name) {
        matched.name = item.name;
        changed = true;
      }
      if (changed) {
        matched.updatedAt = nowIso;
        updated += 1;
      } else {
        unchanged += 1;
      }
      continue;
    }

    if (accounts.length >= options.maxAccounts) {
      throw new AppError('CONFLICT', `导入后将超过 ${options.maxAccounts} 个账号上限，请先清理账号`);
    }
    const fresh = {
      id: newAccountId(),
      name: item.name,
      token: item.token,
      uid: item.uid,
      enabled: true,
      remark: '',
      // 没带时间就自动挑一个空位；批量导入 10 个账号会落到 8、9、10… 点，不会扎堆
      checkinHour: pickNextCheckinHour(accounts, item.checkinHour),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (item.refreshToken) fresh.refreshToken = item.refreshToken;
    if (item.domain) fresh.domain = item.domain;
    if (item.enterpriseId) fresh.enterpriseId = item.enterpriseId;
    accounts.push(fresh);
    imported += 1;
  }

  return { accounts, imported, updated, unchanged };
}

/**
 * 构造 cockpit-tools 兼容的导出数组。
 * 字段名与序列化形态对齐其 WorkbuddyAccount 结构；未知字段不伪造。
 * @param {object[]} accounts 含明文 token 的账号
 * @param {number} nowMs
 * @returns {Promise<object[]>}
 */
export async function buildCockpitExport(accounts, nowMs) {
  const list = Array.isArray(accounts) ? accounts : [];
  const nowSec = Math.floor(nowMs / 1000);
  const result = [];

  for (const account of list) {
    if (!account || typeof account.token !== 'string' || !account.token) continue;
    const identity = account.uid || account.token;
    const digest = await sha256Hex(identity);
    const createdSec = Math.floor(Date.parse(account.createdAt) / 1000) || nowSec;
    const usedSec = Math.floor(Date.parse(account.updatedAt) / 1000) || createdSec;

    const row = {
      id: `workbuddy_${digest.slice(0, 32)}`,
      email: typeof account.name === 'string' ? account.name : '',
      access_token: account.token,
      token_type: 'Bearer',
      status: 'normal',
      created_at: createdSec,
      last_used: usedSec,
    };
    // refresh_token 必须回传：它是 access_token 失效后还能自动续期的唯一凭据。
    // cockpit-tools 的导入解析同时接受 refresh_token / refreshToken（见其 workbuddy_account.rs）。
    if (typeof account.refreshToken === 'string' && account.refreshToken) {
      row.refresh_token = account.refreshToken;
    }
    if (account.uid) row.uid = account.uid;
    if (account.domain) row.domain = account.domain;
    if (account.enterpriseId) row.enterprise_id = account.enterpriseId;
    if (Number.isInteger(account.checkinHour)) row.checkin_hour = account.checkinHour;
    if (account.name) row.nickname = account.name;
    result.push(row);
  }

  return result;
}
