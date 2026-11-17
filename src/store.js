// src/store.js
// 唯一装配点（createContext）+ KV 读写封装（createStore）。
// 全项目只有本文件与 index.js 允许直接接触 env / KV binding；
// 业务层只允许经由 ctx.kv.* 访问 KV（禁止 list()、禁止循环内写）。

import { AppError, isoNow } from './util.js';
import { createLimiter } from './auth.js';

/** KV 键表（全部在 WB_KV 中）。 */
export const KV_KEYS = Object.freeze({
  auth: 'config:auth',
  settings: 'config:settings',
  mcp: 'config:mcp',
  accounts: 'accounts',
  logIndex: 'log:index',
  runLock: 'lock:run',
  // 当日签到进度（北京时间日期），用于 cron 高频轮询时的幂等短路
  checkinDay: 'checkin:day',
});

/** settings 默认值（getSettings 会与存储值做浅合并）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  // 签到时间不在这里：每个账号各有自己的 checkinHour，见 schedule.js
  retentionRuns: 30,
});

/** P0 账号上限（同时保护单键值体积）。 */
export const MAX_ACCOUNTS = 10;

/** log:index 数组长度硬上限（只做保护，裁剪到 retentionRuns 由调用方负责）。 */
export const MAX_LOG_INDEX = 100;

/** run 锁的兜底 TTL（秒）。10 账号 × 2 请求 × 10s ≈ 200s 上界。 */
export const RUN_LOCK_TTL_SEC = 300;

/** 明细键 TTL（秒）。0 = 不设 TTL，走显式 delete 淘汰。 */
export const LOG_DETAIL_TTL_SEC = 0;

/** auth 内存缓存默认 TTL（毫秒）。 */
const AUTH_CACHE_TTL_MS = 10000;

/**
 * @param {string} runId
 * @returns {string} `log:run:{runId}`
 */
export function runDetailKey(runId) {
  return `log:run:${runId}`;
}

/**
 * KV 未绑定时使用的空实现：读返回 null，写直接报错（不会静默丢数据）。
 * @returns {{get:Function, put:Function, delete:Function}}
 */
function createUnboundKv() {
  const reject = async () => {
    throw new AppError('INTERNAL', 'KV 未绑定（缺少 WB_KV binding）');
  };
  return {
    get: async () => null,
    put: reject,
    delete: reject,
  };
}

/**
 * 结构化日志输出，避免多行字符串污染 Workers 日志。
 * @param {'warn'|'error'} level
 * @param {string} event
 * @param {object} [fields]
 */
function logEvent(level, event, fields = {}) {
  const payload = { level, event, ...fields };
  if (level === 'error') {
    console.error(JSON.stringify(payload));
  } else {
    console.warn(JSON.stringify(payload));
  }
}

/**
 * 创建 KV 存储封装。所有方法都是 async，且对坏 JSON 容错为 null（只打日志，不抛）。
 * @param {{kv:object, now:Function, counter?:{n:number}}} deps
 *   counter 是 isolate 级共享写计数器（由 createContext 注入），
 *   不传则退化为本 store 私有计数（单测直接 new store 时的旧行为）。
 * @returns {object} store
 */
export function createStore({ kv, now, counter } = {}) {
  const namespace = kv && typeof kv.get === 'function' ? kv : createUnboundKv();
  const clock = typeof now === 'function' ? now : () => 0;
  // 写计数必须跨请求累计（否则面板「今日写入」恒为 0），因此允许注入共享计数器
  const writeCounter = counter && typeof counter === 'object' ? counter : { n: 0 };

  /**
   * 读 + 解析。null / 空串 / 坏 JSON 一律返回 null。
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async function readJson(key) {
    let raw;
    try {
      raw = await namespace.get(key);
    } catch (err) {
      logEvent('error', 'kv_read_failed', { key, message: String((err && err.message) || err) });
      return null;
    }
    if (raw === null || raw === undefined || raw === '') return null;
    // 兼容测试用内存 KV 直接存对象的情况
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (err) {
      logEvent('error', 'kv_bad_json', { key, message: String((err && err.message) || err) });
      return null;
    }
  }

  /**
   * 序列化写入，成功后写计数 +1；expirationTtl 透传。
   * @param {string} key
   * @param {*} value
   * @param {{expirationTtl?:number}} [opts]
   */
  async function writeJson(key, value, opts) {
    const options = opts && Number.isFinite(opts.expirationTtl) && opts.expirationTtl > 0
      ? { expirationTtl: Math.floor(opts.expirationTtl) }
      : undefined;
    await namespace.put(key, JSON.stringify(value), options);
    writeCounter.n += 1;
  }

  /**
   * 删除键，成功后写计数 +1。
   * @param {string} key
   */
  async function removeKey(key) {
    await namespace.delete(key);
    writeCounter.n += 1;
  }

  /** 取鉴权记录（不存在返回 null）。 */
  async function getAuth() {
    const value = await readJson(KV_KEYS.auth);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  /** 写鉴权记录，返回写入的内存对象（不回读 KV）。 */
  async function putAuth(record) {
    if (!record || typeof record !== 'object') throw new AppError('BAD_REQUEST', 'auth 记录必须为对象');
    await writeJson(KV_KEYS.auth, record);
    return record;
  }

  /** 取设置（与 DEFAULT_SETTINGS 浅合并，永不为 null）。 */
  async function getSettings() {
    const stored = await readJson(KV_KEYS.settings);
    const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    return { ...DEFAULT_SETTINGS, ...source };
  }

  /** 按补丁更新设置，返回合并后的内存对象。 */
  async function putSettings(patch) {
    const current = await getSettings();
    const delta = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const next = { ...current, ...delta, updatedAt: isoNow(clock()) };
    await writeJson(KV_KEYS.settings, next);
    return next;
  }

  /** 取账号数组（坏值 -> []）。 */
  async function getAccounts() {
    const value = await readJson(KV_KEYS.accounts);
    return Array.isArray(value) ? value : [];
  }

  /** 覆盖写账号数组（数量上限 MAX_ACCOUNTS），返回写入的内存数组。 */
  async function putAccounts(list) {
    if (!Array.isArray(list)) throw new AppError('BAD_REQUEST', 'accounts 必须为数组');
    if (list.length > MAX_ACCOUNTS) {
      throw new AppError('BAD_REQUEST', `账号数量不能超过 ${MAX_ACCOUNTS}`);
    }
    await writeJson(KV_KEYS.accounts, list);
    return list;
  }

  /**
   * 取当日签到进度（不存在/坏值返回 null）。
   * 结构：`{ date, accounts: { [accountId]: { result, at } }, updatedAt }`
   */
  async function getCheckinDay() {
    const value = await readJson(KV_KEYS.checkinDay);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  /** 覆盖写当日签到进度，返回写入的内存对象。 */
  async function putCheckinDay(record) {
    if (!record || typeof record !== 'object') throw new AppError('BAD_REQUEST', 'checkinDay 记录必须为对象');
    await writeJson(KV_KEYS.checkinDay, record);
    return record;
  }

  /** 取 MCP Key 记录（不存在返回 null）。 */
  async function getMcp() {
    const value = await readJson(KV_KEYS.mcp);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  /** 写 MCP Key 记录。 */
  async function putMcp(record) {
    if (!record || typeof record !== 'object') throw new AppError('BAD_REQUEST', 'mcp 记录必须为对象');
    await writeJson(KV_KEYS.mcp, record);
    return record;
  }

  /** 取 run 索引（坏值 -> []，一定是数组）。 */
  async function getLogIndex() {
    const value = await readJson(KV_KEYS.logIndex);
    return Array.isArray(value) ? value : [];
  }

  /**
   * 覆盖写 run 索引。只做长度保护（<= MAX_LOG_INDEX）；
   * 裁剪到 settings.retentionRuns 由调用方（run/api）负责。
   */
  async function putLogIndex(list) {
    const safe = Array.isArray(list) ? list.slice(0, MAX_LOG_INDEX) : [];
    await writeJson(KV_KEYS.logIndex, safe);
    return safe;
  }

  /** 取某次 run 的明细（不存在返回 null）。 */
  async function getRunDetail(runId) {
    if (!runId) return null;
    const value = await readJson(runDetailKey(runId));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  /**
   * 写某次 run 的明细。expirationTtl 默认取 LOG_DETAIL_TTL_SEC（0 表示不设 TTL）。
   * @param {string} runId
   * @param {object} detail
   * @param {{expirationTtl?:number}} [opts]
   */
  async function putRunDetail(runId, detail, opts = {}) {
    if (!runId) throw new AppError('BAD_REQUEST', 'runId 不能为空');
    if (!detail || typeof detail !== 'object') throw new AppError('BAD_REQUEST', 'detail 必须为对象');
    const ttl = Number.isFinite(opts.expirationTtl) ? opts.expirationTtl : LOG_DETAIL_TTL_SEC;
    await writeJson(runDetailKey(runId), detail, ttl > 0 ? { expirationTtl: ttl } : undefined);
    return detail;
  }

  /** 删除单个明细键（淘汰用），返回是否真的发了删除。 */
  async function deleteRunDetail(runId) {
    if (!runId) return false;
    await removeKey(runDetailKey(runId));
    return true;
  }

  /** 批量删除明细键，返回删除条数。 */
  async function deleteRunDetails(ids) {
    const list = Array.isArray(ids) ? ids : [];
    let deleted = 0;
    for (const id of list) {
      if (!id) continue;
      await removeKey(runDetailKey(id));
      deleted += 1;
    }
    return deleted;
  }

  /**
   * 抢 run 锁。先读：有值直接放弃（零写）；无值才 put + 回读校验。
   * @param {string} runId
   * @param {string} holder 'cron' | 'manual' | 'manual-single' | 'mcp' 等
   * @param {number} [ttlSec]
   * @returns {Promise<{acquired:boolean, current:object|null}>}
   */
  async function acquireRunLock(runId, holder, ttlSec = RUN_LOCK_TTL_SEC) {
    if (!runId) throw new AppError('BAD_REQUEST', 'runId 不能为空');
    const current = await readJson(KV_KEYS.runLock);
    if (current && typeof current === 'object') {
      return { acquired: false, current };
    }
    const lock = {
      runId,
      holder: typeof holder === 'string' && holder ? holder : 'unknown',
      startedAt: isoNow(clock()),
    };
    const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : RUN_LOCK_TTL_SEC;
    await writeJson(KV_KEYS.runLock, lock, { expirationTtl: ttl });
    // KV 无 CAS：回读确认最终持有者是自己（最小妥协）
    const confirm = await readJson(KV_KEYS.runLock);
    if (!confirm || confirm.runId !== runId) {
      logEvent('warn', 'lock_acquire_lost', {
        runId,
        holder: confirm && typeof confirm.runId === 'string' ? confirm.runId : null,
      });
      return { acquired: false, current: confirm && typeof confirm === 'object' ? confirm : null };
    }
    return { acquired: true, current: lock };
  }

  /**
   * 释放 run 锁：仅当锁上记录的 runId 与入参一致时才删除，否则 no-op。
   * @param {string} runId
   * @returns {Promise<void>}
   */
  async function releaseRunLock(runId) {
    if (!runId) return;
    const current = await readJson(KV_KEYS.runLock);
    if (!current || typeof current !== 'object' || current.runId !== runId) return;
    await removeKey(KV_KEYS.runLock);
  }

  /** 本 isolate 累计 KV 写次数（put + delete）。 */
  function writeCount() {
    return writeCounter.n;
  }

  return {
    getAuth,
    putAuth,
    getSettings,
    putSettings,
    getAccounts,
    putAccounts,
    getCheckinDay,
    putCheckinDay,
    getMcp,
    putMcp,
    getLogIndex,
    putLogIndex,
    getRunDetail,
    putRunDetail,
    deleteRunDetail,
    deleteRunDetails,
    acquireRunLock,
    releaseRunLock,
    writeCount,
  };
}

/**
 * 内存 auth 缓存（带 TTL）。键固定 `config:auth` 即可（单管理员）。
 * @param {{now:Function, defaultTtlMs?:number}} deps
 * @returns {{get:Function, set:Function, invalidate:Function}}
 */
export function createAuthCache({ now, defaultTtlMs = AUTH_CACHE_TTL_MS } = {}) {
  const clock = typeof now === 'function' ? now : () => 0;
  const ttl = Number.isFinite(defaultTtlMs) && defaultTtlMs > 0 ? defaultTtlMs : AUTH_CACHE_TTL_MS;
  const map = new Map();
  return {
    /**
     * @param {string} key
     * @returns {*} 命中返回值，未命中或已过期返回 null
     */
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= clock()) {
        map.delete(key);
        return null;
      }
      return hit.value;
    },
    /**
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMs]
     * @returns {*} 写入的值
     */
    set(key, value, ttlMs) {
      const life = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : ttl;
      map.set(key, { value, expiresAt: clock() + life });
      return value;
    },
    /**
     * @param {string} [key] 省略时清空全部
     */
    invalidate(key) {
      if (key === undefined) {
        map.clear();
        return;
      }
      map.delete(key);
    },
  };
}

/** isolate 级状态（限流器 + auth 缓存）的复用表：env 对象 -> state。 */
const ISOLATE_STATE_BY_ENV = new WeakMap();

/** 注入了自定义时钟时按时钟函数复用（便于单测在同一时钟下跨 ctx 共享状态）。 */
const ISOLATE_STATE_BY_CLOCK = new WeakMap();

/** 完全没有 env 对象时的兜底键。 */
const FALLBACK_ISOLATE_KEY = { fallback: true };

/** 无 env 时的兜底状态。 */
let fallbackIsolateState = null;

/**
 * 创建一份 isolate 级状态。
 * @param {Function} clock 返回毫秒数
 * @returns {{limiter:object, authCache:object, writeCounter:{n:number}}}
 */
function createIsolateState(clock) {
  return {
    limiter: createLimiter({ now: clock }),
    authCache: createAuthCache({ now: clock }),
    // 写计数与 limiter/authCache 同属 isolate 级：index.js 每个请求都 createContext，
    // 若计数器挂在 store 实例上会随请求归零，面板「今日写入」就永远是 0。
    writeCounter: { n: 0 },
  };
}

/**
 * 取（或创建）某个 isolate 的状态。
 * 复用键优先级：注入的时钟函数 > env 对象 > 全局兜底。
 * @param {object} environment
 * @param {Function|null} clock
 * @returns {{limiter:object, authCache:object, writeCounter:{n:number}}}
 */
function getIsolateState(environment, clock) {
  if (clock) {
    let state = ISOLATE_STATE_BY_CLOCK.get(clock);
    if (!state) {
      state = createIsolateState(clock);
      ISOLATE_STATE_BY_CLOCK.set(clock, state);
    }
    return state;
  }
  if (environment && typeof environment === 'object' && environment !== FALLBACK_ISOLATE_KEY) {
    let state = ISOLATE_STATE_BY_ENV.get(environment);
    if (!state) {
      state = createIsolateState(() => Date.now());
      ISOLATE_STATE_BY_ENV.set(environment, state);
    }
    return state;
  }
  if (!fallbackIsolateState) fallbackIsolateState = createIsolateState(() => Date.now());
  return fallbackIsolateState;
}

/**
 * 解析本次请求应使用的 limiter / authCache / 写计数器。
 * 关键：这三者都必须是 **isolate 级单例**，否则每个请求新建实例会让限流、
 * 10s auth 缓存、写计数全部失效（前两者是自检发现并修掉的真实缺陷，后者由 QA 抓出）。
 * @param {object} environment
 * @param {object} patch
 * @returns {{limiter:object, authCache:object, writeCounter:{n:number}}}
 */
function resolveIsolateState(environment, patch) {
  const injectedLimiter = patch.limiter && typeof patch.limiter.check === 'function' ? patch.limiter : null;
  const injectedCache = patch.authCache && typeof patch.authCache.get === 'function' ? patch.authCache : null;
  const clock = typeof patch.now === 'function' ? patch.now : null;
  const state = getIsolateState(environment, clock);

  return {
    limiter: injectedLimiter || state.limiter,
    authCache: injectedCache || state.authCache,
    writeCounter: state.writeCounter,
  };
}

/**
 * 唯一装配点：把 env / kv / fetch / now / limiter / authCache / 写计数 组装成 ctx。
 * QA 用 createContext(env, {fetch: mock, now: () => 1234, kv: createMemoryKv()}) 即可脱离 workerd。
 * @param {object} env Worker 环境（含 WB_KV / PBKDF2_ITERATIONS / SETUP_TOKEN）
 * @param {object} [overrides] 可覆盖 kv / fetch / now / limiter / authCache / store
 * @returns {object} ctx
 */
export function createContext(env, overrides) {
  const environment = env && typeof env === 'object' ? env : FALLBACK_ISOLATE_KEY;
  const patch = overrides && typeof overrides === 'object' ? overrides : {};
  const now = typeof patch.now === 'function' ? patch.now : () => Date.now();
  const fetchImpl = typeof patch.fetch === 'function'
    ? patch.fetch
    : globalThis.fetch.bind(globalThis);
  const isolateState = resolveIsolateState(environment, patch);
  const store = patch.store && typeof patch.store === 'object'
    ? patch.store
    : createStore({
      kv: patch.kv || environment.WB_KV || null,
      now,
      counter: isolateState.writeCounter,
    });
  const detailTtlSec = Number.isFinite(patch.logDetailTtlSec) ? patch.logDetailTtlSec : LOG_DETAIL_TTL_SEC;

  return {
    env: environment,
    kv: store,
    fetch: fetchImpl,
    now,
    limiter: isolateState.limiter,
    authCache: isolateState.authCache,
    logDetailTtlSec: detailTtlSec,
    writes: () => store.writeCount(),
  };
}
