// src/logger.js
// run 内存日志缓冲 + 收尾汇总 + 64KB 截断。
// 循环内只 push（零 KV 写），收尾由 run 模块一次性落盘。

import { truncate, isoNow } from './util.js';

/** 单条 entry 的 message 字符上限（ARCHITECTURE §8）。 */
const MESSAGE_MAX_CHARS = 200;

/** detail 序列化后的字节上限。 */
const DEFAULT_MAX_BYTES = 65536;

/**
 * UTF-8 字节数。
 * @param {string} str
 * @returns {number}
 */
function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * 定长 Number 或 null（0 合法）。
 * @param {*} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * 按 ARCHITECTURE §4.2 的 10 个字段规范化一条 LogEntry。
 * @param {object} entry
 * @returns {object} 新的 LogEntry
 */
function normalizeEntry(entry) {
  const src = entry && typeof entry === 'object' ? entry : {};
  const result = typeof src.result === 'string' && src.result ? src.result : 'failed';
  return {
    accountId: typeof src.accountId === 'string' ? src.accountId : '',
    accountName: typeof src.accountName === 'string' ? src.accountName : '',
    result,
    httpStatus: Number.isFinite(src.httpStatus) ? src.httpStatus : 0,
    code: numberOrNull(src.code),
    message: truncate(typeof src.message === 'string' ? src.message : '', MESSAGE_MAX_CHARS),
    credit: numberOrNull(src.credit),
    streakDays: numberOrNull(src.streakDays),
    durationMs: Number.isFinite(src.durationMs) ? src.durationMs : 0,
    tokenInvalid: src.tokenInvalid === true,
  };
}

/**
 * 创建一次 run 的内存日志缓冲。
 * @param {{runId:string, trigger:string, startedAtMs:number, now?:Function}} params
 * @returns {{push:Function, entries:Array, count:Function, runId:string,
 *            trigger:string, startedAtMs:number}}
 */
export function createRunLogger({ runId, trigger, startedAtMs, now } = {}) {
  const clock = typeof now === 'function' ? now : null;
  const start = Number.isFinite(startedAtMs) ? startedAtMs : clock ? clock() : 0;
  const entries = [];
  return {
    runId: typeof runId === 'string' ? runId : '',
    trigger: typeof trigger === 'string' && trigger ? trigger : 'manual',
    startedAtMs: start,
    entries,
    /**
     * 追加一条 entry（只存内存，零 KV 写）。
     * @param {object} entry 结果条目（字段见 ARCHITECTURE §4.2）
     * @returns {object} 规范化后的 entry
     */
    push(entry) {
      const normalized = normalizeEntry(entry);
      entries.push(normalized);
      return normalized;
    },
    /** @returns {number} 已缓冲条数 */
    count() {
      return entries.length;
    },
  };
}

/**
 * 汇总 + 截断，产出可直接落盘的 summary 与 detail。
 * 截断策略：序列化后用实测 UTF-8 字节数比较，超限则从尾部裁 entries；
 * 只剩 1 条仍超限时继续裁该条 message；极端情况整体丢空。
 * 注意：total/success/failed/skipped/accountResults 均基于截断前的全量 entries
 * （反映真实结果），只有 detail.entries 会被裁剪，truncated 标记是否发生过裁剪。
 * 账号「最近结果」徽标依赖 accountResults，避免面板为反查明细多付 2 次 KV 读。
 * @param {object} logger createRunLogger 的返回值
 * @param {{finishedAtMs:number, kvWriteCount?:number, maxBytes?:number}} params
 * @returns {{summary:object, detail:object, truncated:boolean, bytes:number}}
 */
export function finalizeRun(logger, { finishedAtMs, kvWriteCount = 0, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const rawEntries = logger && Array.isArray(logger.entries) ? logger.entries : [];
  const startMs = logger && Number.isFinite(logger.startedAtMs) ? logger.startedAtMs : 0;
  const finishMs = Number.isFinite(finishedAtMs) ? finishedAtMs : startMs;

  // 全量条目（message 再过一次 truncate，保证 ≤200 字符）
  const fullEntries = rawEntries.map((entry) => ({
    ...(entry && typeof entry === 'object' ? entry : {}),
    message: truncate(entry && typeof entry.message === 'string' ? entry.message : '', MESSAGE_MAX_CHARS),
  }));

  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of fullEntries) {
    // dry_run_ok 也算成功（dryRun 只查状态，不会产生 checked_in）
    if (entry.result === 'checked_in' || entry.result === 'already_checked_in' || entry.result === 'dry_run_ok') {
      success += 1;
    } else if (entry.result === 'failed') {
      failed += 1;
    } else if (entry.result === 'skipped_disabled') {
      skipped += 1;
    }
  }

  const summary = {
    runId: logger && typeof logger.runId === 'string' ? logger.runId : '',
    startedAt: isoNow(startMs),
    finishedAt: isoNow(finishMs),
    trigger: logger && typeof logger.trigger === 'string' && logger.trigger ? logger.trigger : 'manual',
    total: fullEntries.length,
    success,
    failed,
    skipped,
    durationMs: Math.max(0, finishMs - startMs),
    truncated: false,
    kvWriteCount: Number.isFinite(kvWriteCount) ? kvWriteCount : 0,
    // 面板「最近结果」徽标用：仅 accountId + result，不放 message
    accountResults: fullEntries.map((entry) => ({ accountId: entry.accountId, result: entry.result })),
  };

  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;

  let kept = fullEntries.slice();
  let truncated = false;
  const build = () => ({ ...summary, entries: kept, truncated });
  let detail = build();
  let bytes = byteLength(JSON.stringify(detail));

  // 第一轮：从尾部整条裁
  while (bytes > limit && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1);
    truncated = true;
    detail = build();
    bytes = byteLength(JSON.stringify(detail));
  }

  // 第二轮：只剩 1 条仍超限 -> 逐步对折该条 message
  if (bytes > limit && kept.length === 1) {
    truncated = true;
    let messageChars = Array.from(kept[0].message);
    let single = { ...kept[0] };
    while (bytes > limit) {
      messageChars = messageChars.slice(0, Math.floor(messageChars.length / 2));
      single = {
        ...single,
        message: messageChars.length > 0 ? `${messageChars.join('')}…` : '',
      };
      kept = [single];
      detail = build();
      bytes = byteLength(JSON.stringify(detail));
      if (messageChars.length === 0) break;
    }
  }

  // 兜底：仍然超限（几乎不可能）-> 整体丢弃 entries，保证字节上限
  if (bytes > limit) {
    kept = [];
    truncated = true;
    detail = build();
    bytes = byteLength(JSON.stringify(detail));
  }

  const finalSummary = { ...summary, truncated };
  return {
    summary: finalSummary,
    detail: { ...finalSummary, entries: kept },
    truncated,
    bytes,
  };
}
