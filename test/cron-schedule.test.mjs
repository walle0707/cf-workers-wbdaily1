// test/cron-schedule.test.mjs
// 覆盖 scheduled() 的调度语义（这是「每 15 分钟轮询 + 按小时归属」的对外行为）：
//   1. 非签到小时：只读 settings，零 KV 写、零上游请求；
//   2. 签到小时首次触发：跑一轮签到，成功结果写入 checkin:day；
//   3. 同一小时后 3 轮：读到达标即短路，零写零请求；
//   4. 首轮失败：不写进度，下一轮会重试；
//   5. 部分成功：只跑剩下的账号。
//
// 说明：scheduled() 内部用 createContext(env) 装配真实 fetch，
// 所以这里用 globalThis.fetch 打桩（前后恢复），不会产生真实网络请求。

import test from 'node:test';
import assert from 'node:assert/strict';

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

/** 北京时间 2026-11-14 08:00 对应的 UTC 毫秒。 */
const BEIJING_8AM = Date.UTC(2026, 10, 14, 0, 0, 0);
const HOUR = 3600 * 1000;

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

/** 默认上游：今天没签到，签到成功。 */
function okUpstream() {
  return createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return jsonRes({ code: 0, data: { today_checked_in: false, streak_days: 3 } });
    if (call.path === DAILY_PATH) return jsonRes({ code: 0, data: { credit: 10, streak_days: 4 } });
    throw new Error(`[mock] 未预期端点 ${call.path}`);
  });
}

test('没有账号到点：只读 accounts，零 KV 写、零上游请求', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]); // 默认 8 点
  kv.resetEvents();
  const upstream = okUpstream();

  // 北京 07:00（UTC 前一日 23:00），没有任何账号设在这个小时
  await runCron(kv, Date.UTC(2026, 10, 13, 23, 0, 0), upstream);

  assert.equal(kv.writeCount(), 0, '无到点账号时不允许任何写');
  assert.equal(upstream.calls.length, 0, '无到点账号时不允许打上游');
  // 只读了 accounts 一次
  assert.deepEqual(kv.reads().map((event) => event.key), ['accounts']);
});

test('每个账号按自己的小时签到：8 点只跑 A，9 点只跑 B', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [
    { ...makeAccount(1), checkinHour: 8 },
    { ...makeAccount(2), checkinHour: 9 },
  ]);

  // 08:00：只应请求 acc_1
  const at8 = okUpstream();
  await runCron(kv, BEIJING_8AM, at8);
  assert.equal(at8.tokens().every((token) => token.includes('token-1')), true, '08:00 不应碰 9 点的账号');

  const day = kv.json('checkin:day');
  assert.deepEqual(Object.keys(day.accounts), ['acc_1']);

  // 09:00：只应请求 acc_2
  kv.resetEvents();
  const at9 = okUpstream();
  await runCron(kv, BEIJING_8AM + HOUR, at9);
  assert.ok(at9.calls.length > 0);
  assert.equal(at9.tokens().every((token) => token.includes('token-2')), true, '09:00 不应重复请求 8 点的账号');
  assert.deepEqual(Object.keys(kv.json('checkin:day').accounts).sort(), ['acc_1', 'acc_2']);
});

test('把账号的签到时间改到别的小时后，原小时不再触发', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [{ ...makeAccount(1), checkinHour: 8 }]);

  // 08:00 签到成功
  await runCron(kv, BEIJING_8AM, okUpstream());
  assert.ok(kv.json('checkin:day'));

  // 用户把时间改到 9 点，并清掉昨日进度
  kv.seed('accounts', [{ ...makeAccount(1), checkinHour: 9 }]);
  kv.seed('checkin:day', null);

  kv.resetEvents();
  const stillAt8 = okUpstream();
  await runCron(kv, BEIJING_8AM, stillAt8);
  assert.equal(stillAt8.calls.length, 0, '改到 9 点后 8 点不应再跑');

  const at9 = okUpstream();
  await runCron(kv, BEIJING_8AM + HOUR, at9);
  assert.ok(at9.calls.length > 0, '9 点应正常触发');
});

test('签到小时首次触发：跑一轮签到并把成功结果写入 checkin:day', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);
  const upstream = okUpstream();

  await runCron(kv, BEIJING_8AM, upstream);

  assert.ok(upstream.calls.length >= 2, '应当发生真实的签到请求');
  const day = kv.json('checkin:day');
  assert.ok(day, 'checkin:day 必须被写入');
  assert.equal(day.date, '2026-11-14');
  assert.equal(day.accounts.acc_1.result, 'checked_in');
  assert.equal(typeof day.accounts.acc_1.at, 'string');
});

test('同一小时内后续 3 轮：读到达标即短路，零写零请求', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);
  await runCron(kv, BEIJING_8AM, okUpstream());

  for (const offsetMinutes of [15, 30, 45]) {
    kv.resetEvents();
    const upstream = okUpstream();
    await runCron(kv, BEIJING_8AM + offsetMinutes * 60 * 1000, upstream);

    assert.equal(kv.writeCount(), 0, `:${offsetMinutes} 轮不应写 KV`);
    assert.equal(upstream.calls.length, 0, `:${offsetMinutes} 轮不应打上游`);
  }
});

test('首轮签到失败：不写进度，下一轮自动重试', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);

  // 第一轮：上游 500
  const failing = createUpstreamMock(() => jsonRes({ code: 500, msg: 'boom' }, 500));
  await runCron(kv, BEIJING_8AM, failing);
  assert.equal(kv.json('checkin:day'), null, '失败不应写入完成标记');

  // 第二轮（15 分钟后）：上游恢复
  kv.resetEvents();
  const healthy = okUpstream();
  await runCron(kv, BEIJING_8AM + 15 * 60 * 1000, healthy);

  assert.ok(healthy.calls.length >= 2, '第二轮必须重新尝试签到');
  assert.equal(kv.json('checkin:day').accounts.acc_1.result, 'checked_in');
});

test('已签到（上游 today_checked_in=true）：记为 already_checked_in 并达标', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);
  const upstream = createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return jsonRes({ code: 0, data: { today_checked_in: true, streak_days: 9 } });
    throw new Error('[mock] 已签到不应调用 daily-checkin');
  });

  await runCron(kv, BEIJING_8AM, upstream);

  const day = kv.json('checkin:day');
  assert.equal(day.accounts.acc_1.result, 'already_checked_in');

  // 后续轮次同样短路
  kv.resetEvents();
  const again = okUpstream();
  await runCron(kv, BEIJING_8AM + 30 * 60 * 1000, again);
  assert.equal(kv.writeCount(), 0);
  assert.equal(again.calls.length, 0);
});

test('部分成功：第二轮只对剩下未完成的账号发起请求', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1), makeAccount(2)]);

  // 第一轮：acc_1 成功、acc_2 失败
  const partial = createUpstreamMock((call) => {
    if (call.token.includes('token-2')) return jsonRes({ code: 500, msg: 'boom' }, 500);
    if (call.path === STATUS_PATH) return jsonRes({ code: 0, data: { today_checked_in: false } });
    return jsonRes({ code: 0, data: { credit: 10, streak_days: 1 } });
  });
  await runCron(kv, BEIJING_8AM, partial);

  const day = kv.json('checkin:day');
  assert.deepEqual(Object.keys(day.accounts), ['acc_1'], '只记录成功的那一个');

  // 第二轮：只有 acc_2 会被请求
  kv.resetEvents();
  const retry = okUpstream();
  await runCron(kv, BEIJING_8AM + 15 * 60 * 1000, retry);
  assert.ok(retry.calls.length > 0);
  assert.equal(retry.tokens().every((token) => token.includes('token-2')), true, '不应重复请求已完成的 acc_1');
  assert.equal(kv.json('checkin:day').accounts.acc_2.result, 'checked_in');
});

test('没有启用账号：零写零请求', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1, { enabled: false })]);
  kv.resetEvents();
  const upstream = okUpstream();

  await runCron(kv, BEIJING_8AM, upstream);

  assert.equal(kv.writeCount(), 0);
  assert.equal(upstream.calls.length, 0);
});

test('跨天：昨天的记录不会让今天跳过签到', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);
  kv.seed('checkin:day', { date: '2026-11-13', accounts: { acc_1: { result: 'checked_in' } } });
  const upstream = okUpstream();

  await runCron(kv, BEIJING_8AM, upstream);

  assert.ok(upstream.calls.length > 0, '新的一天必须重新签到');
  assert.equal(kv.json('checkin:day').date, '2026-11-14');
});

test('手动签到写入的进度同样能让 cron 短路（不重复打上游）', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);

  // 模拟「用户在 07:50 点了立即全部签到」：进度由 recordProgress 统一写入
  // 用固定时钟，保证 recordProgress 写的日期与 cron 判断的日期是同一天
  const { ctx } = makeCtx({ kv, fetch: okUpstream(), clock: () => BEIJING_8AM });
  const recorded = await recordProgress(ctx, [{ accountId: 'acc_1', result: 'checked_in' }]);
  assert.ok(recorded, '手动签到也应写当日进度');

  kv.resetEvents();
  const upstream = okUpstream();
  await runCron(kv, BEIJING_8AM, upstream);

  assert.equal(upstream.calls.length, 0, 'cron 到点后不应再打上游');
  assert.equal(kv.writeCount(), 0, 'cron 短路不应写 KV');
});

test('dryRun / 失败结果不写进度', async () => {
  const kv = createMemoryKv();
  kv.seed('accounts', [makeAccount(1)]);
  const { ctx } = makeCtx({ kv, fetch: okUpstream() });

  assert.equal(await recordProgress(ctx, [{ accountId: 'acc_1', result: 'failed' }]), null);
  assert.equal(await recordProgress(ctx, []), null);
  assert.equal(await recordProgress(ctx, null), null);
  assert.equal(kv.has('checkin:day'), false);
});
