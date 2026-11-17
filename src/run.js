// src/run.js
// run 编排：抢锁 -> 读取账号与索引 -> 串行签到（内存日志，零 KV 写）-> 收尾落盘 -> 解锁。
// 写入预算（ARCHITECTURE §5.3）：锁 1 + 明细 1 + 索引 1 + 淘汰 N + 解锁 1 = 4 + N。

import { AppError, newRunId, truncate } from './util.js';
import { createRunLogger, finalizeRun } from './logger.js';
import { checkinAccount, checkinStatus } from './checkin.js';
import { withFreshToken } from './upstream-token.js';

/** run 锁 TTL（秒）。 */
const RUN_LOCK_TTL_SEC = 300;

/** retentionRuns 的合法区间（与面板 PUT /api/settings 的校验保持一致）。 */
const MIN_RETENTION_RUNS = 5;
const MAX_RETENTION_RUNS = 100;
const DEFAULT_RETENTION_RUNS = 30;

/** 单条 message 字符上限。 */
const MESSAGE_MAX_CHARS = 200;

/**
 * 约束 retentionRuns 到 [5, 100]，非法值回落 30。
 * @param {*} value
 * @returns {number}
 */
function clampRetention(value) {
  if (!Number.isFinite(value)) return DEFAULT_RETENTION_RUNS;
  const int = Math.floor(value);
  if (int < MIN_RETENTION_RUNS) return MIN_RETENTION_RUNS;
  if (int > MAX_RETENTION_RUNS) return MAX_RETENTION_RUNS;
  return int;
}

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
 * 生成执行计划，保持 accountIds 的给定顺序。
 * 语义：
 * - 未指定 accountIds：cron/manual 只跑 enabled 账号；
 * - 指定 accountIds：manual-single 忽略 enabled（强制跑），其它 trigger 下禁用账号记 skipped；
 * - 指定了不存在的 id：记一条 failed（账号不存在），不抛错。
 * @param {object[]} accounts
 * @param {string[]|null} accountIds
 * @param {string} trigger
 * @returns {Array<{kind:'run'|'skipped'|'missing', account?:object, id?:string}>}
 */
function buildPlan(accounts, accountIds, trigger) {
  const list = Array.isArray(accounts) ? accounts.filter((item) => item && typeof item === 'object') : [];
  const ids = Array.isArray(accountIds) && accountIds.length > 0 ? accountIds : null;
  if (!ids) {
    return list
      .filter((account) => account.enabled === true)
      .map((account) => ({ kind: 'run', account }));
  }
  const byId = new Map();
  for (const account of list) {
    if (typeof account.id === 'string' && account.id) byId.set(account.id, account);
  }
  const plan = [];
  for (const rawId of ids) {
    const id = typeof rawId === 'string' ? rawId : String(rawId === undefined || rawId === null ? '' : rawId);
    const account = byId.get(id);
    if (!account) {
      plan.push({ kind: 'missing', id });
      continue;
    }
    if (trigger !== 'manual-single' && account.enabled !== true) {
      plan.push({ kind: 'skipped', account });
      continue;
    }
    plan.push({ kind: 'run', account });
  }
  return plan;
}

/**
 * 执行签到编排。
 * @param {object} ctx
 * @param {{accountIds?:string[]|null, trigger?:string, dryRun?:boolean}} [options]
 * @returns {Promise<{runId:string, summary:object, entries:object[], outcomes:object[],
 *                    flushError:null|{code:string, message:string}}>}
 * @throws {AppError} CONFLICT 已有 run 在执行（detail.currentRunId 携带占用者）
 */
export async function runCheckin(ctx, { accountIds = null, trigger = 'manual', dryRun = false } = {}) {
  const runId = newRunId();
  const triggerName = typeof trigger === 'string' && trigger ? trigger : 'manual';
  const startedAtMs = ctx.now();
  const logger = createRunLogger({ runId, trigger: triggerName, startedAtMs, now: ctx.now });
  // 内存侧的每账号结局（含 upstreamFatal / tokenInvalid，不落 KV）。
  // 单账号签到接口靠它决定 502 还是 200，LogEntry 本身只保留固定的 10 个字段。
  const outcomes = [];

  // ---------- dryRun：只查状态，不抢锁、不落盘、零 KV 写 ----------
  if (dryRun) {
    const accounts = await ctx.kv.getAccounts();
    const plan = buildPlan(accounts, accountIds, triggerName);
    for (const item of plan) {
      if (item.kind === 'missing') {
        outcomes.push({ accountId: item.id, result: 'failed', missing: true, tokenInvalid: false, upstreamFatal: false });
        logger.push({
          accountId: item.id,
          accountName: '',
          result: 'failed',
          message: '账号不存在',
        });
        continue;
      }
      if (item.kind === 'skipped') {
        outcomes.push({
          accountId: item.account.id,
          result: 'skipped_disabled',
          missing: false,
          tokenInvalid: false,
          upstreamFatal: false,
        });
        logger.push({
          accountId: item.account.id,
          accountName: item.account.name,
          result: 'skipped_disabled',
          message: '账号已禁用，跳过',
        });
        continue;
      }
      try {
        const status = await withFreshToken(ctx, item.account, (account) => checkinStatus(ctx, account), { persist: false });
        const okStatus = status.result === 'already_checked_in' || status.result === 'not_checked_in';
        outcomes.push({
          accountId: item.account.id,
          result: okStatus ? 'dry_run_ok' : 'failed',
          missing: false,
          tokenInvalid: status.tokenInvalid === true,
          upstreamFatal: status.upstreamFatal === true,
        });
        logger.push({
          accountId: item.account.id,
          accountName: item.account.name,
          result: okStatus ? 'dry_run_ok' : 'failed',
          httpStatus: status.httpStatus,
          code: status.code,
          message: status.message,
          credit: status.credit,
          streakDays: status.streakDays,
          durationMs: status.durationMs,
          tokenInvalid: status.tokenInvalid,
        });
      } catch (err) {
        outcomes.push({
          accountId: item.account.id,
          result: 'failed',
          missing: false,
          tokenInvalid: false,
          upstreamFatal: false,
        });
        logger.push({
          accountId: item.account.id,
          accountName: item.account.name,
          result: 'failed',
          message: truncate(String((err && err.message) || err), MESSAGE_MAX_CHARS),
        });
      }
    }
    const finalized = finalizeRun(logger, { finishedAtMs: ctx.now(), kvWriteCount: 0 });
    logEvent('info', 'run_dry_finished', {
      runId,
      trigger: triggerName,
      total: finalized.summary.total,
      success: finalized.summary.success,
      failed: finalized.summary.failed,
      skipped: finalized.summary.skipped,
      durationMs: finalized.summary.durationMs,
    });
    return { runId, summary: finalized.summary, entries: logger.entries, flushError: null, outcomes };
  }

  // ---------- 抢锁（失败零写并抛 CONFLICT）----------
  const baseWrites = ctx.writes();
  const lock = await ctx.kv.acquireRunLock(runId, triggerName, RUN_LOCK_TTL_SEC);
  if (!lock.acquired) {
    const current = lock.current && typeof lock.current === 'object' ? lock.current : null;
    const holderRunId = current && typeof current.runId === 'string' ? current.runId : 'unknown';
    throw new AppError('CONFLICT', `已有任务在执行（${holderRunId}）`, {
      currentRunId: holderRunId,
    });
  }

  let flushError = null;
  let finalized = null;
  let plannedWrites = 4;

  try {
    // 抢锁成功后才读账号；同时留一份索引/设置快照作为**兜底**（收尾重读失败时用它继续落盘）
    const accounts = await ctx.kv.getAccounts();
    const startIndex = await ctx.kv.getLogIndex();
    const startSettings = await ctx.kv.getSettings();

    const plan = buildPlan(accounts, accountIds, triggerName);
    for (const item of plan) {
      if (item.kind === 'missing') {
        outcomes.push({ accountId: item.id, result: 'failed', missing: true, tokenInvalid: false, upstreamFatal: false });
        logger.push({
          accountId: item.id,
          accountName: '',
          result: 'failed',
          message: '账号不存在',
        });
        continue;
      }
      if (item.kind === 'skipped') {
        outcomes.push({
          accountId: item.account.id,
          result: 'skipped_disabled',
          missing: false,
          tokenInvalid: false,
          upstreamFatal: false,
        });
        logger.push({
          accountId: item.account.id,
          accountName: item.account.name,
          result: 'skipped_disabled',
          message: '账号已禁用，跳过',
        });
        continue;
      }
      try {
        const outcome = await withFreshToken(ctx, item.account, (account) => checkinAccount(ctx, account));
        outcomes.push({
          accountId: item.account.id,
          result: outcome.result,
          missing: false,
          tokenInvalid: outcome.tokenInvalid === true,
          upstreamFatal: outcome.upstreamFatal === true,
        });
        logger.push({
          accountId: item.account.id,
          accountName: item.account.name,
          result: outcome.result,
          httpStatus: outcome.httpStatus,
          code: outcome.code,
          message: outcome.message,
          credit: outcome.credit,
          streakDays: outcome.streakDays,
          durationMs: outcome.durationMs,
          tokenInvalid: outcome.tokenInvalid,
        });
      } catch (err) {
        // 单账号任何异常都归一成 failed entry，绝不中断整轮
        outcomes.push({
          accountId: item.account.id,
          result: 'failed',
          missing: false,
          tokenInvalid: false,
          upstreamFatal: false,
        });
        logger.push({
          accountId: item.account.id,
          accountName: item.account.name,
          result: 'failed',
          message: truncate(String((err && err.message) || err), MESSAGE_MAX_CHARS),
        });
      }
    }

    // ---------- 收尾：先算截断后的 detail，再落盘（明细成功后才写索引）----------
    // 并发修正（QA F4）：锁只挡得住并发 run，挡不住并发的 PUT /api/settings。
    // 若沿用启动时的索引快照拼回去，run 期间刚被删除的旧条目会被「复活」成孤儿指针
    // （索引超限 + 面板展开 404）。所以收尾前**重读**索引与设置，按当前 retention 计算裁剪量；
    // 重读失败不中断落盘，退回启动快照并打 warn。
    // 代价：2 次读（读预算充裕）；收益：索引永不指向已删明细，evictCount 与 kvWriteCount 都对得上。
    let indexList = Array.isArray(startIndex) ? startIndex : [];
    let retentionRuns = clampRetention(startSettings && startSettings.retentionRuns);
    try {
      const [freshIndex, freshSettings] = await Promise.all([ctx.kv.getLogIndex(), ctx.kv.getSettings()]);
      if (Array.isArray(freshIndex)) indexList = freshIndex;
      if (freshSettings && typeof freshSettings === 'object') {
        retentionRuns = clampRetention(freshSettings.retentionRuns);
      }
    } catch (err) {
      logEvent('warn', 'run_index_reread_failed', {
        runId,
        message: String((err && err.message) || err),
      });
    }

    const evictCount = Math.max(0, indexList.length + 1 - retentionRuns);
    // 锁 1 + 明细 1 + 索引 1 + 淘汰 evictCount + 解锁 1
    plannedWrites = 4 + evictCount;

    // 注意：kvWriteCount 必须用重算后的 plannedWrites —— putRunDetail 在这之后才发生
    finalized = finalizeRun(logger, { finishedAtMs: ctx.now(), kvWriteCount: plannedWrites });

    try {
      await ctx.kv.putRunDetail(runId, finalized.detail, { expirationTtl: ctx.logDetailTtlSec });
    } catch (err) {
      flushError = { code: 'INTERNAL', message: '日志写入失败' };
      logEvent('error', 'run_detail_write_failed', {
        runId,
        message: String((err && err.message) || err),
      });
    }

    if (!flushError) {
      try {
        const nextIndex = [finalized.summary, ...indexList];
        const kept = nextIndex.slice(0, retentionRuns);
        const evicted = nextIndex.slice(retentionRuns);
        await ctx.kv.putLogIndex(kept);
        for (const item of evicted) {
          const oldRunId = item && typeof item.runId === 'string' ? item.runId : null;
          if (!oldRunId) continue;
          try {
            await ctx.kv.deleteRunDetail(oldRunId);
          } catch (err) {
            logEvent('error', 'run_evict_failed', {
              runId,
              evictedRunId: oldRunId,
              message: String((err && err.message) || err),
            });
          }
        }
      } catch (err) {
        flushError = { code: 'INTERNAL', message: '日志写入失败' };
        logEvent('error', 'run_index_write_failed', {
          runId,
          message: String((err && err.message) || err),
        });
      }
    }
  } finally {
    try {
      await ctx.kv.releaseRunLock(runId);
    } catch (err) {
      // 解锁失败只记日志，不影响返回值；锁有 TTL 兜底
      logEvent('error', 'run_unlock_failed', {
        runId,
        message: String((err && err.message) || err),
      });
    }
  }

  const actualWrites = ctx.writes() - baseWrites;
  const summary = finalized ? finalized.summary : null;
  logEvent('info', 'run_finished', {
    runId,
    trigger: triggerName,
    total: summary ? summary.total : 0,
    success: summary ? summary.success : 0,
    failed: summary ? summary.failed : 0,
    skipped: summary ? summary.skipped : 0,
    durationMs: summary ? summary.durationMs : Math.max(0, ctx.now() - startedAtMs),
    plannedWrites,
    actualWrites,
    truncated: summary ? summary.truncated : false,
    flushError: flushError ? flushError.message : null,
  });
  if (actualWrites < plannedWrites) {
    // 少写 = 真正的落盘问题（明细/索引/淘汰/解锁有失败）
    logEvent('warn', 'run_write_mismatch', {
      runId,
      plannedWrites,
      actualWrites,
      flushError: flushError ? flushError.message : null,
    });
  } else if (actualWrites > plannedWrites) {
    // 多写：写计数器是 isolate 级共享的，run 期间可能有并发的设置/账号写入被计入，属正常
    logEvent('info', 'run_write_overlap', {
      runId,
      plannedWrites,
      actualWrites,
    });
  }

  return {
    runId,
    summary: summary || {},
    entries: logger.entries,
    flushError,
    outcomes,
  };
}
