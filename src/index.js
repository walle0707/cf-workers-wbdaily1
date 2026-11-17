// src/index.js
// Worker 入口：创建 ctx、在 `/api/*` 与静态资源之间分流、承接 Cron 触发。
// 本文件与 store.js 是仅有的两个允许直接访问 env / 静态资源绑定的模块。
// 约束：任何响应都必须是 JSON 信封（静态资源命中除外），绝不把 HTML 或堆栈回给调用方。

import { AppError, fail, isoNow } from './util.js';
import { createContext } from './store.js';
import { runCheckin } from './run.js';
import { handleApi } from './api.js';
import { handleMcp } from './mcp.js';
import {
  accountsDueAt,
  beijingParts,
  isDayComplete,
  pendingAccountIds,
} from './schedule.js';
import { recordProgress } from './progress.js';

/**
 * 结构化日志（单行 JSON，便于 `wrangler tail` 过滤）。
 * @param {'info'|'warn'|'error'} level
 * @param {string} event
 * @param {object} [fields]
 */
function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * 静态资源分流：命中 public/ 内真实文件时由 ASSETS 直出，其余返回 JSON 404。
 * 之所以要兜底 404，是因为 not_found_handling = "none" 会把未命中交回 Worker。
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function serveAsset(request, env) {
  const assets = env && env.ASSETS;
  if (!assets || typeof assets.fetch !== 'function') {
    return fail('NOT_FOUND', '静态资源不可用（ASSETS 未绑定）');
  }
  let response;
  try {
    response = await assets.fetch(request);
  } catch (err) {
    logEvent('error', 'assets_fetch_failed', { message: String((err && err.message) || err) });
    return fail('INTERNAL', '静态资源读取失败');
  }
  if (!response) return fail('NOT_FOUND', '资源不存在');
  if (response.status === 404) {
    let pathname = '/';
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = '/';
    }
    return fail('NOT_FOUND', `资源不存在：${pathname}`);
  }
  return response;
}

/**
 * 统一异常出口：AppError 转对应错误码，未知异常只记日志并回 INTERNAL（不含堆栈）。
 * @param {*} err
 * @returns {Response}
 */
function toErrorResponse(err) {
  if (err instanceof AppError) {
    const hasHeaders = err.headers && Object.keys(err.headers).length > 0;
    return fail(err.code, err.message, err.detail, hasHeaders ? { headers: err.headers } : undefined);
  }
  logEvent('error', 'unhandled_exception', {
    name: err && err.name ? String(err.name) : 'Error',
    message: String((err && err.message) || err),
  });
  return fail('INTERNAL', '服务内部错误');
}

export default {
  /**
   * HTTP 入口。
   * 分流顺序：OPTIONS -> /api/mcp -> /api/* -> 静态资源。
   * OPTIONS 一律 JSON 404（同源部署，不开 CORS）。
   * @param {Request} request
   * @param {object} env
   * @param {object} [executionCtx]
   * @returns {Promise<Response>}
   */
  async fetch(request, env, executionCtx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const method = String(request.method || 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        return fail('NOT_FOUND', `接口不存在：OPTIONS ${pathname}`);
      }
      if (pathname === '/api/mcp' || pathname === '/api/mcp/') {
        // MCP 走 Bearer Key 鉴权，不做同源校验（AI 客户端跨域）
        const ctx = createContext(env);
        return await handleMcp(ctx, request);
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const ctx = createContext(env);
        return await handleApi(ctx, request, url);
      }
      return await serveAsset(request, env);
    } catch (err) {
      return toErrorResponse(err);
    }
  },

  /**
   * Cron 入口：每 15 分钟轮询一次，按**每个账号自己的签到小时**挑出这一轮该跑的账号。
   *
   * 没有全局签到时间：账号 A 可以设 08:00、账号 B 设 09:00，避免同一分钟集中打上游。
   * 为什么用轮询而不是「每个账号一条精确 cron」：Cloudflare cron 不保证准点，
   * 单点触发一旦错过就整天不签。改成每小时 4 次轮询后，某个账号的目标小时内
   * :00/:15/:30/:45 都算窗口，第一次成功即写 KV 标记，后面 3 轮零写短路；
   * 第一次失败则后 3 轮自动成为重试机会。
   *
   * 写入预算：绝大多数触发只读 1 次 accounts 就返回（零写、零上游）；
   * 到点且已完成时读 2 次返回；真正跑一次 run 才产生 run 的 4+N 次写 + 1 次进度写。
   * @param {{cron?:string, scheduledTime?:number}} controller
   * @param {object} env
   * @param {object} [executionCtx]
   * @returns {Promise<void>}
   */
  async scheduled(controller, env, executionCtx) {
    const cron = controller && typeof controller.cron === 'string' ? controller.cron : null;
    let ctx = null;
    try {
      ctx = createContext(env);
      // 用 scheduledTime 判定「这一轮属于哪个小时」：即使实例冷启动延迟到 08:03 才执行，
      // 仍然按 08:00 这轮归属判断，不会因为跨点而漏签。
      // scheduledTime 是 UTC 毫秒，beijingParts 负责换算成北京日期/小时。
      const scheduledTime = controller && Number.isFinite(controller.scheduledTime)
        ? controller.scheduledTime
        : ctx.now();
      const { date, hour } = beijingParts(scheduledTime);

      const accounts = await ctx.kv.getAccounts();
      // 只有「已启用 + 自己的签到小时 == 当前北京小时」的账号才进这一轮
      const due = accountsDueAt(accounts, scheduledTime);

      logEvent('info', 'cron_tick', {
        ts: isoNow(ctx.now()),
        cron,
        scheduledTime: isoNow(scheduledTime),
        beijingDate: date,
        beijingHour: hour,
        totalAccounts: accounts.length,
        dueAccounts: due.length,
      });

      if (due.length === 0) return;

      const day = await ctx.kv.getCheckinDay();
      if (isDayComplete(due, day, date)) {
        // 这些账号本小时已签到成功：后 3 轮到这里就结束，不再打上游
        logEvent('info', 'cron_already_done', { date, hour, accounts: due.length });
        return;
      }

      const pending = pendingAccountIds(due, day, date);
      const result = await runCheckin(ctx, { trigger: 'cron', accountIds: pending });

      // 只把成功结果写进当日进度：失败不写，后续几轮才会重试。
      // 日期用上面由 scheduledTime 推导的 date，保证与 isDayComplete 是同一天口径。
      const recorded = await recordProgress(ctx, result.entries, date);

      logEvent('info', 'cron_run_finished', {
        runId: result.runId,
        date,
        hour,
        pending: pending.length,
        total: result.summary ? result.summary.total : 0,
        success: result.summary ? result.summary.success : 0,
        failed: result.summary ? result.summary.failed : 0,
        skipped: result.summary ? result.summary.skipped : 0,
        durationMs: result.summary ? result.summary.durationMs : 0,
        kvWriteCount: result.summary ? result.summary.kvWriteCount : 0,
        progressWritten: Boolean(recorded),
        flushError: result.flushError ? result.flushError.message : null,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONFLICT') {
        // 已有 run 在执行：Cron 不重试、不写 KV，直接跳过
        logEvent('warn', 'run_skipped_locked', {
          cron,
          holder: err.detail && err.detail.currentRunId ? err.detail.currentRunId : null,
        });
        return;
      }
      logEvent('error', 'cron_failed', {
        name: err && err.name ? String(err.name) : 'Error',
        message: String((err && err.message) || err),
      });
    }
  },
};
