// src/schedule.js
// 签到调度：把「每个账号各自的签到小时」翻译成「这一轮 cron 该跑哪些账号」。
//
// 设计要点：
//   1. **按账号独立设置**，没有全局签到时间。10 个账号可以分别落在 8、9、10… 点，
//      避免同一分钟集中打上游（扎堆既像脚本，也容易触发风控）。
//   2. Cloudflare Cron 只有到分钟的表达力，但触发并不保证准点（边缘调度 + 冷启动
//      可能带来分钟级延迟），单点触发一旦错过就整天不签。所以 wrangler.toml 固定
//      `*/15 * * * *` 高频轮询，再按「小时」判断归属：
//        - 目标小时内的 4 次触发（:00 :15 :30 :45）都算这个窗口；
//        - 第一次成功就把结果写进 KV，后面 3 次直接跳过（零写）；
//        - 第一次失败则后 3 次自动成为重试机会，天然容错。
//   3. **时区**：面板填的是北京时间（Asia/Shanghai）整点，存储的也是北京小时数，
//      **不做 UTC 存储**，避免来回换算引入错误。Cron 表达式是 UTC，但因为用的是
//      「每 15 分钟」这种与时区无关的写法，真正的时区转换只发生在
//      「UTC 时间戳 -> 北京日期/小时」这一步（beijingParts）。
//      北京不实行夏令时，所以不需要处理 DST 跳变。

/** 视为「今天这个账号已经不用再签」的结果集合。 */
export const DONE_RESULTS = Object.freeze(['checked_in', 'already_checked_in']);

/** 是否属于「已完成」集合。 */
const DONE_SET = new Set(DONE_RESULTS);

/** 默认签到小时（北京时间 8 点）。账号没设置时回落这个值。 */
export const DEFAULT_CHECKIN_HOUR = 8;

/** 自动分配签到小时的起点（新账号从 8 点开始往后找空位）。 */
const HOUR_SEARCH_START = 8;

/**
 * 把毫秒时间戳换算成北京时间的日期与小时。
 *
 * 这是全项目**唯一**的 UTC -> 北京时间转换点。云端的 `scheduledTime`、`Date.now()`
 * 都是 UTC 毫秒，面板上用户填的是北京整点，两边在这里对齐。
 * @param {number} ms
 * @returns {{date:string, hour:number}} date 形如 `2026-11-14`，hour 为 0~23
 */
export function beijingParts(ms) {
  const t = Number.isFinite(ms) ? ms : 0;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date(t));
    const pick = (type) => (parts.find((item) => item.type === type)?.value || '');
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    // 'en-CA' 的 hour 在 24 点场景会给出 '24'，归一成 0
    const rawHour = Number(pick('hour'));
    const hour = Number.isFinite(rawHour) ? (rawHour === 24 ? 0 : rawHour) : 0;
    if (year && month && day) return { date: `${year}-${month}-${day}`, hour };
  } catch {
    // Intl 不可用时走 UTC 兜底（不应发生，Workers 运行时带 full ICU）
  }
  const fallback = new Date(t);
  const iso = fallback.toISOString();
  return { date: iso.slice(0, 10), hour: fallback.getUTCHours() };
}

/**
 * 严格解析签到小时：只接受 0~23 的整数（也接受纯数字字符串）。
 * @param {*} value
 * @returns {number|null} 非法返回 null
 */
export function parseCheckinHour(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > 23) return null;
  return n;
}

/**
 * 读取账号的签到小时，非法/缺失时回落到默认 8 点。
 * @param {*} value
 * @returns {number}
 */
export function normalizeCheckinHour(value) {
  const parsed = parseCheckinHour(value);
  return parsed === null ? DEFAULT_CHECKIN_HOUR : parsed;
}

/**
 * 给新账号分配一个签到小时：优先用调用方指定的值，否则从 8 点起找第一个未被占用的整点。
 *
 * 目的：批量导入 10 个账号时不要全部压在 8 点。规则透明、可预测，用户随时能在卡片上改。
 * 24 个整点都被占满时回落默认值（超过 24 个账号本就不允许，上限是 10）。
 * @param {object[]} accounts 现有账号
 * @param {*} preferred 期望值（非法/缺失则自动分配）
 * @returns {number}
 */
export function pickNextCheckinHour(accounts, preferred) {
  const explicit = parseCheckinHour(preferred);
  if (explicit !== null) return explicit;
  const used = new Set();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || typeof account !== 'object') continue;
    if (account.checkinHour === undefined || account.checkinHour === null) continue;
    used.add(normalizeCheckinHour(account.checkinHour));
  }
  for (let i = 0; i < 24; i += 1) {
    const hour = (HOUR_SEARCH_START + i) % 24;
    if (!used.has(hour)) return hour;
  }
  return DEFAULT_CHECKIN_HOUR;
}

/**
 * 这一轮该处理哪些账号：已启用 + 签到小时等于当前北京小时。
 * @param {object[]} accounts
 * @param {number} ms
 * @returns {object[]}
 */
export function accountsDueAt(accounts, ms) {
  const { hour } = beijingParts(ms);
  return (Array.isArray(accounts) ? accounts : []).filter((account) => {
    if (!account || typeof account !== 'object') return false;
    if (account.enabled !== true) return false;
    if (typeof account.id !== 'string' || !account.id) return false;
    return normalizeCheckinHour(account.checkinHour) === hour;
  });
}

/**
 * 北京时间整点 -> 展示文本，如 8 -> `08:00`。
 * @param {number} hour
 * @returns {string}
 */
export function beijingHourText(hour) {
  return `${String(normalizeCheckinHour(hour)).padStart(2, '0')}:00`;
}

/**
 * 毫秒时间戳 -> 北京时间的日期时间文本 `YYYY-MM-DD HH:MM`（面向用户展示）。
 * @param {number} ms
 * @returns {string}
 */
export function beijingDateTimeText(ms) {
  const t = Number.isFinite(ms) ? ms : 0;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(t));
    const pick = (type) => (parts.find((item) => item.type === type)?.value || '');
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    const rawHour = Number(pick('hour'));
    const hour = Number.isFinite(rawHour) ? (rawHour === 24 ? 0 : rawHour) : 0;
    const minute = pick('minute');
    if (year && month && day) {
      return `${year}-${month}-${day} ${String(hour).padStart(2, '0')}:${minute || '00'}`;
    }
  } catch {
    // Intl 不可用时走 UTC 兜底
  }
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * 北京时间整点 -> 对应的 UTC 整点文本（跨日只关心钟点，便于面板提示）。
 * 例：北京 08:00 -> UTC 00:00；北京 00:00 -> UTC 16:00（前一日）。
 * @param {number} hour
 * @returns {string}
 */
export function utcHourText(hour) {
  const utcHour = ((normalizeCheckinHour(hour) - 8) % 24 + 24) % 24;
  return `${String(utcHour).padStart(2, '0')}:00`;
}

/**
 * 算出这一轮需要签到的账号 id。
 * 规则：
 *   - 当天的记录日期不是今天 -> 全部待签；
 *   - 是今天 -> 排除已成功（checked_in / already_checked_in）的账号；
 *   - 失败结果不写入记录，所以失败账号天然会被重试。
 * @param {object[]} accounts 本轮到点的账号
 * @param {{date?:string, accounts?:Record<string,{result?:string}>}|null} dayRecord
 * @param {string} date 北京时间日期 `YYYY-MM-DD`
 * @returns {string[]}
 */
export function pendingAccountIds(accounts, dayRecord, date) {
  const list = Array.isArray(accounts) ? accounts.filter((item) => item && typeof item.id === 'string' && item.id) : [];
  const record = dayRecord && typeof dayRecord === 'object' ? dayRecord : null;
  const sameDay = Boolean(record && record.date === date);
  const doneMap = sameDay && record.accounts && typeof record.accounts === 'object' ? record.accounts : null;
  if (!doneMap) return list.map((account) => account.id);
  return list
    .filter((account) => {
      const hit = doneMap[account.id];
      return !(hit && typeof hit === 'object' && DONE_SET.has(hit.result));
    })
    .map((account) => account.id);
}

/**
 * 把本次 run 的成功结果合并进当日记录。
 * 只记成功：失败不入库，才会被后续几轮重试捞起来。
 * @param {{date?:string, accounts?:object}|null} dayRecord 旧记录
 * @param {string} date 北京时间日期
 * @param {object[]} entries runCheckin 的 entries
 * @param {string} nowIso 写入时刻（ISO）
 * @returns {object|null} 新的记录；没有任何成功（且无历史）时返回 null，表示不必写
 */
export function mergeDayRecord(dayRecord, date, entries, nowIso) {
  const record = dayRecord && typeof dayRecord === 'object' && dayRecord.date === date ? dayRecord : null;
  const accounts = record && record.accounts && typeof record.accounts === 'object'
    ? { ...record.accounts }
    : {};
  let changed = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.accountId !== 'string' || !entry.accountId) continue;
    if (!DONE_SET.has(entry.result)) continue;
    const prev = accounts[entry.accountId];
    if (prev && prev.result === entry.result) continue;
    accounts[entry.accountId] = { result: entry.result, at: nowIso };
    changed = true;
  }
  if (!changed && record) return null;
  if (!changed && Object.keys(accounts).length === 0) return null;
  return { date, accounts, updatedAt: nowIso };
}

/**
 * 当日记录是否已经覆盖所有给定账号（用于「零写提前返回」）。
 * @param {object[]} accounts 本轮到点的账号
 * @param {{date?:string, accounts?:object}|null} dayRecord
 * @param {string} date
 * @returns {boolean}
 */
export function isDayComplete(accounts, dayRecord, date) {
  return pendingAccountIds(accounts, dayRecord, date).length === 0;
}

/** 供外部复用的「已完成」判定。 */
export function isDoneResult(result) {
  return DONE_SET.has(result);
}
