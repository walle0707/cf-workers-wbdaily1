// src/progress.js
// 当日签到进度（KV `checkin:day`）的读写编排，供 cron / 面板手动 / MCP 三个入口共用。
//
// 为什么要统一：
//   cron 每 15 分钟轮询，目标小时内会触发 4 轮；如果「手动全部签到」或 MCP 触发过签到
//   却没写进度，cron 到点还会再对同一批账号打一遍上游（虽然上游 checkin-status 会给
//   already_checked_in 兜底，但那是白白多 2 个请求，既浪费也增加风控暴露面）。
//   所以任何一次成功签到都写进度，cron 只认进度，不认「这一轮是谁签的」。
//
// 写失败的处理：进度是**优化项**，不是正确性依赖（上游本身有幂等）。写挂了一律静默，
// 最坏结果只是下一轮多查一次，绝不能因为进度写失败把一次成功的签到判成失败。

import { beijingParts, mergeDayRecord } from './schedule.js';
import { isoNow } from './util.js';

/**
 * 把本次 run 的成功结果合并进当日进度。
 *
 * 北京日期由调用方决定：cron 分支用 scheduledTime 推导（跨零点 / 实例冷启动延迟时，
 * 「这一轮属于哪一天」必须以触发时刻为准，否则会跟 isDayComplete 的日期口径打架）；
 * 手动 / MCP 入口不传，回落到「现在」的北京日期。
 * @param {object} ctx
 * @param {object[]} entries runCheckin 的 entries（含 accountId / result）
 * @param {string} [date] 北京日期 YYYY-MM-DD；缺省时用 ctx.now() 推导
 * @returns {Promise<object|null>} 合并后的记录；无成功项、无变化或写失败时返回 null
 */
export async function recordProgress(ctx, entries, date = null) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  try {
    const nowMs = typeof ctx.now === 'function' ? ctx.now() : 0;
    const beijingDate = typeof date === 'string' && date ? date : beijingParts(nowMs).date;
    const record = await ctx.kv.getCheckinDay();
    const merged = mergeDayRecord(record, beijingDate, entries, isoNow(nowMs));
    if (!merged) return null;
    await ctx.kv.putCheckinDay(merged);
    return merged;
  } catch {
    // 进度是优化项：写失败最坏只是下一轮多查一次，不影响本次签到结论
    return null;
  }
}
