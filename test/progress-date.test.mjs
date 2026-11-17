// test/progress-date.test.mjs
// 覆盖 B4：recordProgress 的可选第三参（北京日期显式注入）与 cron 的日期口径一致性。
//
// 为什么需要这个测试：修复前 recordProgress 一律用 ctx.now() 推导日期，而 scheduled()
// 用 controller.scheduledTime 推导日期。当实例冷启动把「23:xx 这一轮」推迟到次日 00:0x
// 才执行时，两者会算出不同的日期 —— 进度被写到次日，当天凌晨的 isDayComplete 永远读不到，
// 结果同一小时的后 3 轮反复打上游。这里用「scheduledTime 属于 11-14 / 机器时钟已是 11-15」
// 构造该场景，断言进度必须落在 11-14。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../src/index.js';
import { recordProgress } from '../src/progress.js';
import { createMemoryKv } from './helpers/memkv.mjs';
import {
  createUpstreamMock,
  DAILY_PATH,
  jsonRes,
  makeAccount,
  makeCtx,
  STATUS_PATH,
} from './helpers/harness.mjs';

/** 北京 2026-11-14 23:00（= UTC 15:00），cron 的 scheduledTime。 */
const SCHEDULED_BJ_1114_2300 = Date.UTC(2026, 10, 14, 15, 0, 0);
/** 北京 2026-11-15 00:05（= UTC 16:05），冷启动延迟后的「机器当前时间」。 */
const ACTUAL_BJ_1115_0005 = Date.UTC(2026, 10, 14, 16, 5, 0);
/** 北京 2026-11-15 09:00（= UTC 01:00）。 */
const ACTUAL_BJ_1115_0900 = Date.UTC(2026, 10, 15, 1, 0, 0);

const DONE_ENTRY = [{ accountId: 'acc_1', result: 'checked_in' }];

/**
 * 在指定「当前时间」下执行一段逻辑：临时替换 Date.now()。
 * scheduled() 内部用 createContext(env) 装配，now 默认是 () => Date.now()，
 * 因此这是唯一能控制 cron 分支时钟的注入点（不改源码）。
 * @param {number} ms
 * @param {Function} fn
 * @returns {Promise<*>}
 */
async function withFakeNow(ms, fn) {
  const original = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

/** 默认上游：今天没签到，签到成功。 */
function okUpstream() {
  return createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return jsonRes({ code: 0, data: { today_checked_in: false, streak_days: 3 } });
    if (call.path === DAILY_PATH) return jsonRes({ code: 0, data: { credit: 10, streak_days: 4 } });
    throw new Error(`[mock] 未预期端点 ${call.path}`);
  });
}

/**
 * 用打桩的全局 fetch 跑一次 scheduled。
 * @param {object} kv
 * @param {number} scheduledTime
 * @param {Function} fetchImpl
 * @returns {Promise<{calls:object[]}>}
 */
async function runCron(kv, scheduledTime, fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime }, { WB_KV: kv });
  } finally {
    globalThis.fetch = original;
  }
  return { calls: fetchImpl.calls || [] };
}

// ============ recordProgress 的第三参语义 ============

test('recordProgress：显式 date 优先于 ctx.now()（机器时钟跨天也不影响归属）', async () => {
  const kv = createMemoryKv();
  const { ctx } = makeCtx({ kv, clock: () => ACTUAL_BJ_1115_0005 });

  // 机器时间已是北京 11-15 00:05，但这一轮属于 11-14
  const record = await recordProgress(ctx, DONE_ENTRY, '2026-11-14');
  assert.ok(record, '有成功项就必须写入进度');
  assert.equal(record.date, '2026-11-14', '进度日期必须以调用方传入的北京日期为准');
  assert.equal(kv.json('checkin:day').date, '2026-11-14');
  assert.equal(kv.json('checkin:day').accounts.acc_1.result, 'checked_in');
});

test('recordProgress：不传第三参时回落到 ctx.now() 推导的北京日期', async () => {
  const kv = createMemoryKv();
  const { ctx } = makeCtx({ kv, clock: () => ACTUAL_BJ_1115_0005 });

  const record = await recordProgress(ctx, DONE_ENTRY);
  assert.equal(record.date, '2026-11-15', '缺省行为必须保持原样（api.js / mcp.js 走这条路径）');
  assert.equal(kv.json('checkin:day').date, '2026-11-15');
});

test('recordProgress：date 为 null / 空串 / 非字符串时同样回落 ctx.now()', async () => {
  for (const bad of [null, undefined, '', 0, {}, '2026-11-14']) {
    const kv = createMemoryKv();
    const { ctx } = makeCtx({ kv, clock: () => ACTUAL_BJ_1115_0900 });
    const record = await recordProgress(ctx, DONE_ENTRY, bad);
    assert.ok(record, `date=${JSON.stringify(bad)} 时仍应写入进度`);
    const expected = bad === '2026-11-14' ? '2026-11-14' : '2026-11-15';
    assert.equal(record.date, expected, `date=${JSON.stringify(bad)} 的归属日期不对`);
  }
});

test('recordProgress：传入与 now 同一天的 date 时行为与两参调用完全一致', async () => {
  const kvA = createMemoryKv();
  const a = await recordProgress(makeCtx({ kv: kvA, clock: () => ACTUAL_BJ_1115_0900 }).ctx, DONE_ENTRY, '2026-11-15');

  const kvB = createMemoryKv();
  const b = await recordProgress(makeCtx({ kv: kvB, clock: () => ACTUAL_BJ_1115_0900 }).ctx, DONE_ENTRY);

  assert.equal(a.date, b.date);
  assert.deepEqual(a.accounts, b.accounts);
  assert.deepEqual(kvA.json('checkin:day'), kvB.json('checkin:day'));
});

test('recordProgress：重复结果仍然短路（第三参不改变「无变化返回 null」语义）', async () => {
  const kv = createMemoryKv();
  const { ctx } = makeCtx({ kv, clock: () => ACTUAL_BJ_1115_0005 });
  assert.ok(await recordProgress(ctx, DONE_ENTRY, '2026-11-14'));
  kv.resetEvents();
  assert.equal(await recordProgress(ctx, DONE_ENTRY, '2026-11-14'), null, '同结果重复写应返回 null');
  assert.equal(kv.writeCount(), 0, '无变化时零写');
});

// ============ cron 的日期口径一致性（端到端） ============

test('cron：scheduledTime 属于 11-14、机器时钟已是 11-15 时，进度必须落在 11-14', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [{ ...makeAccount(1), checkinHour: 23 }]);
  const upstream = okUpstream();

  // 23:00 这一轮被冷启动推迟到次日 00:05 才真正执行
  await withFakeNow(ACTUAL_BJ_1115_0005, () => runCron(kv, SCHEDULED_BJ_1114_2300, upstream));

  assert.ok(upstream.calls.length > 0, '到点就该打上游');
  assert.equal(
    kv.json('checkin:day').date,
    '2026-11-14',
    '进度日期必须跟随 scheduledTime，否则与 isDayComplete 的日期口径打架',
  );
});

test('cron：上一条场景的收益——同一小时后 3 轮能正确短路（零上游、零写）', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [{ ...makeAccount(1), checkinHour: 23 }]);

  await withFakeNow(ACTUAL_BJ_1115_0005, () => runCron(kv, SCHEDULED_BJ_1114_2300, okUpstream()));

  // 23:15 那轮：scheduledTime 仍属 11-14，机器时钟仍在次日
  kv.resetEvents();
  const second = okUpstream();
  await withFakeNow(ACTUAL_BJ_1115_0005, () =>
    runCron(kv, SCHEDULED_BJ_1114_2300 + 15 * 60 * 1000, second));

  assert.equal(second.calls.length, 0, '该账号本小时已签成功，23:15 那轮不得再打上游');
  assert.equal(kv.writeCount(), 0, '短路轮次不允许任何 KV 写');
});

test('cron：对照实验——若按 ctx.now() 推导日期，进度会落到次日（说明第三参确实在起作用）', async () => {
  const kv = createMemoryKv();
  // 直接模拟「修复前」的两参调用，证明这条路径会写出 11-15
  const { ctx } = makeCtx({ kv, clock: () => ACTUAL_BJ_1115_0005 });
  const legacy = await recordProgress(ctx, DONE_ENTRY);
  assert.equal(legacy.date, '2026-11-15', '两参调用确实会写到次日——这正是 B4 要消除的分歧');

  // 修复后走三参调用，同一时钟下写出 11-14
  const kvFixed = createMemoryKv();
  const fixedCtx = makeCtx({ kv: kvFixed, clock: () => ACTUAL_BJ_1115_0005 }).ctx;
  const fixed = await recordProgress(fixedCtx, DONE_ENTRY, '2026-11-14');
  assert.equal(fixed.date, '2026-11-14');
  assert.notEqual(legacy.date, fixed.date, '两种调用在跨天场景下必须给出不同日期，否则修复无效');
});

// ============ 静态守卫：其余入口保持两参调用 ============

test('B4 静态守卫：api.js / mcp.js 仍以两参调用 recordProgress（只有 cron 传日期）', () => {
  const api = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mcp = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  const apiCalls = api.match(/recordProgress\([^)]*\)/g) || [];
  assert.ok(apiCalls.length >= 2, 'api.js 必须仍有两处 recordProgress 调用');
  for (const call of apiCalls) {
    assert.equal(call.includes(','), true, '调用应有参数');
    assert.equal(
      /recordProgress\(ctx, result\.entries\)/.test(call),
      true,
      `api.js 的手动入口不应传日期：${call}`,
    );
  }

  assert.match(mcp, /recordProgress\(ctx, result\.entries\)/, 'mcp.js 必须保持两参调用');
  assert.match(index, /recordProgress\(ctx, result\.entries, date\)/, 'cron 必须传 scheduledTime 推导出的 date');
});
