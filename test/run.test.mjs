// test/run.test.mjs
// run 编排的硬指标：写入次数常数化（AC-11）、淘汰（AC-12）、64KB 截断（AC-13）、
// 锁冲突零写、禁用账号语义（AC-10）、缺失账号、单账号 upstreamFatal 仍落盘。
// ARCHITECTURE §5.1 ~ §5.3。

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCheckin } from '../src/run.js';
import { AppError } from '../src/util.js';
import { createMemoryKv } from './helpers/memkv.mjs';
import {
  createClock,
  createUpstreamMock,
  dailyOk,
  jsonRes,
  makeAccount,
  makeCtx,
  STATUS_PATH,
  statusCheckedIn,
  statusNotCheckedIn,
  T0,
} from './helpers/harness.mjs';

const MAX_DETAIL_BYTES = 64 * 1024;

/**
 * 预置账号到内存 KV。
 * @param {object} kv
 * @param {object[]} accounts
 */
function seedAccounts(kv, accounts) {
  kv.seed('accounts', accounts);
}

/**
 * 「正常上游」mock：401 token 失败，其余逐个签到成功。
 * @param {string[]} failingTokens
 * @returns {Function}
 */
function normalUpstream(failingTokens = []) {
  return createUpstreamMock((call) => {
    if (failingTokens.includes(call.token)) return jsonRes({ code: 401, msg: 'unauthorized' }, 401);
    if (call.path === STATUS_PATH) return statusNotCheckedIn();
    return dailyOk(10, 7);
  });
}

test('3 账号（2 成功 1×401）：summary 正确、写入恰为 4 次、索引 1 条、锁已释放（AC-11）', async () => {
  const kv = createMemoryKv();
  const accounts = [makeAccount(1), makeAccount(2), makeAccount(3)];
  seedAccounts(kv, accounts);
  const mock = normalUpstream([accounts[2].token]);
  const { ctx } = makeCtx({ kv, fetch: mock });

  const before = ctx.writes();
  const result = await runCheckin(ctx, { trigger: 'cron' });
  const delta = ctx.writes() - before;

  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.success, 2);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.skipped, 0);
  assert.equal(result.summary.trigger, 'cron');
  assert.equal(result.summary.kvWriteCount, 4, 'summary.kvWriteCount 必须如实为 4');
  assert.equal(delta, 4, `实际写入次数必须恰为 4，实际 ${delta}`);
  assert.equal(result.flushError, null);

  // 索引：恰 1 条，最新在首位
  const index = kv.json('log:index');
  assert.equal(index.length, 1);
  assert.equal(index[0].runId, result.runId);
  assert.equal(index[0].success, 2);
  assert.equal(index[0].failed, 1);
  assert.equal(index[0].kvWriteCount, 4);

  // 明细：3 条 entry，顺序与账号顺序一致
  const detail = kv.json(`log:run:${result.runId}`);
  assert.equal(detail.total, 3);
  assert.deepEqual(detail.entries.map((entry) => entry.result), ['checked_in', 'checked_in', 'failed']);
  assert.equal(detail.entries[2].tokenInvalid, true);
  assert.equal(detail.entries[2].httpStatus, 401);

  // 锁：已用 TTL 兜底，且已释放
  const lockPut = kv.puts().find((event) => event.key === 'lock:run');
  assert.ok(lockPut, '必须抢锁写入 lock:run');
  assert.equal(lockPut.expirationTtl, 300, '锁必须带 expirationTtl=300');
  assert.equal(kv.json('lock:run'), null, 'finally 中必须释放锁');

  // 循环内不得逐条写 KV：log:run:* 只应有 1 次 put
  const detailPuts = kv.puts().filter((event) => event.key.startsWith('log:run:'));
  assert.equal(detailPuts.length, 1);
});

test('写入次数与账号数无关：10 账号（9 成功 1 失败）仍恰为 4 次（AC-11）', async () => {
  const kv = createMemoryKv();
  const accounts = Array.from({ length: 10 }, (_, index) => makeAccount(index + 1));
  seedAccounts(kv, accounts);
  const mock = normalUpstream([accounts[9].token]);
  const { ctx } = makeCtx({ kv, fetch: mock });

  const before = ctx.writes();
  const result = await runCheckin(ctx, { trigger: 'cron' });
  const delta = ctx.writes() - before;

  assert.equal(result.summary.total, 10);
  assert.equal(result.summary.success, 9);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.kvWriteCount, 4);
  assert.equal(delta, 4, `10 账号的写入次数必须与 3 账号相同，实际 ${delta}`);
  assert.equal(kv.puts().filter((event) => event.key.startsWith('log:run:')).length, 1);
  assert.equal(mock.count(), 9 * 2 + 1, '9 个账号各 2 次请求 + 1 个账号 1 次请求');
});

test('淘汰：retentionRuns=5 连续 6 次 run 后索引恰 5 条、最旧明细被删、第 6 次写 5 次（AC-12）', async () => {
  const kv = createMemoryKv();
  kv.seed('config:settings', { retentionRuns: 5 });
  seedAccounts(kv, [makeAccount(1)]);
  const { ctx } = makeCtx({ kv, fetch: normalUpstream() });

  const runIds = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await runCheckin(ctx, { trigger: 'cron' });
    runIds.push(result.runId);
  }
  assert.equal(kv.json('log:index').length, 5, '前 5 次不应触发淘汰');

  const before = ctx.writes();
  const sixth = await runCheckin(ctx, { trigger: 'cron' });
  const delta = ctx.writes() - before;

  assert.equal(sixth.summary.kvWriteCount, 5, '命中淘汰的 run 写入预算为 5');
  assert.equal(delta, 5, `淘汰 run 实际写入必须为 5，实际 ${delta}`);

  const index = kv.json('log:index');
  assert.equal(index.length, 5, '索引长度必须等于 retentionRuns');
  assert.equal(index[0].runId, sixth.runId, '最新 run 必须在首位');
  assert.equal(index[4].runId, runIds[1], '第 2 次 run 是当前最旧（第 1 次已被淘汰）');

  const oldestRunId = runIds[0];
  assert.equal(kv.has(`log:run:${oldestRunId}`), false, '最旧明细键必须被删除');
  assert.equal(kv.json(`log:run:${oldestRunId}`), null);
  assert.ok(kv.json(`log:run:${sixth.runId}`), '新 run 明细必须存在');
});

test('锁冲突：抛 CONFLICT（带 currentRunId），零写入且不产生索引', async () => {
  const kv = createMemoryKv();
  seedAccounts(kv, [makeAccount(1)]);
  kv.seed('lock:run', {
    runId: 'run_holder',
    holder: 'cron',
    startedAt: new Date(T0).toISOString(),
  });
  const mock = normalUpstream();
  const { ctx } = makeCtx({ kv, fetch: mock });

  const before = ctx.writes();
  await assert.rejects(
    () => runCheckin(ctx, { trigger: 'manual' }),
    (err) => {
      assert.ok(err instanceof AppError, '必须抛 AppError');
      assert.equal(err.code, 'CONFLICT');
      assert.equal(err.detail.currentRunId, 'run_holder', 'detail.currentRunId 必须指向占用者');
      assert.match(err.message, /run_holder/);
      return true;
    },
  );

  assert.equal(ctx.writes() - before, 0, '抢锁失败必须零 KV 写');
  assert.equal(kv.has('log:index'), false, '抢锁失败不得写索引');
  assert.equal(mock.count(), 0, '抢锁失败不得调上游');
});

test('禁用账号：cron 跳过不签到；manual 记 skipped_disabled；manual-single 强制跑（AC-10）', async () => {
  const kv = createMemoryKv();
  const active1 = makeAccount(1);
  const active2 = makeAccount(2);
  const disabled = makeAccount(3, { enabled: false });
  seedAccounts(kv, [active1, active2, disabled]);
  const mock = normalUpstream();
  const { ctx } = makeCtx({ kv, fetch: mock });

  // cron：禁用账号既不出现在 entries 里，也绝不被调用上游
  const cron = await runCheckin(ctx, { trigger: 'cron' });
  assert.equal(cron.summary.total, 2, 'cron 只处理启用账号');
  assert.equal(cron.summary.success, 2);
  assert.equal(cron.entries.some((entry) => entry.accountId === disabled.id), false, '禁用账号不产生 entry');
  assert.equal(mock.tokens().includes(disabled.token), false, '禁用账号绝不允许调上游');

  // manual + 指定 accountIds：标记 skipped_disabled
  const manual = await runCheckin(ctx, { accountIds: [disabled.id], trigger: 'manual' });
  assert.equal(manual.summary.total, 1);
  assert.equal(manual.summary.skipped, 1);
  assert.equal(manual.entries[0].result, 'skipped_disabled');
  assert.equal(manual.entries[0].accountId, disabled.id);

  // manual-single：忽略 enabled，强制跑
  const single = await runCheckin(ctx, { accountIds: [disabled.id], trigger: 'manual-single' });
  assert.equal(single.summary.total, 1);
  assert.equal(single.summary.success, 1);
  assert.equal(single.entries[0].result, 'checked_in');
  assert.equal(single.entries[0].accountId, disabled.id);
  assert.equal(mock.tokens().includes(disabled.token), true, 'manual-single 必须真的调用上游');
});

test('不存在的 accountId：产生 failed entry（message「账号不存在」）且不抛错', async () => {
  const kv = createMemoryKv();
  seedAccounts(kv, [makeAccount(1)]);
  const mock = normalUpstream();
  const { ctx } = makeCtx({ kv, fetch: mock });

  const result = await runCheckin(ctx, { accountIds: ['acc_does_not_exist'], trigger: 'manual' });

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.entries[0].accountId, 'acc_does_not_exist');
  assert.equal(result.entries[0].result, 'failed');
  assert.equal(result.entries[0].message, '账号不存在');
  assert.equal(mock.count(), 0, '不存在的账号不得调上游');
  assert.equal(result.flushError, null);
  assert.equal(result.summary.kvWriteCount, 4, '缺失账号也要正常收尾落盘');
});

test('64KB 截断：200 账号极端 run 体积 ≤65536B、truncated=true、total 不撒谎（AC-13）', async () => {
  const kv = createMemoryKv();
  const accounts = Array.from({ length: 200 }, (_, index) => makeAccount(`big${index}`, { name: `账号-${index}-超长名称` }));
  seedAccounts(kv, accounts);
  // 每条 entry 的 message 都会被截到 200 字符，保证总体积必然超过 64KB
  const mock = createUpstreamMock(() => jsonRes({ code: 1, msg: 'x'.repeat(400) }, 200));
  const { ctx } = makeCtx({ kv, fetch: mock });

  const result = await runCheckin(ctx, { trigger: 'cron' });
  const detail = kv.json(`log:run:${result.runId}`);
  const bytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');

  assert.ok(bytes <= MAX_DETAIL_BYTES, `detail 体积 ${bytes}B 必须 ≤ ${MAX_DETAIL_BYTES}B`);
  assert.equal(detail.truncated, true, '超过 64KB 必须置 truncated=true');
  assert.equal(detail.total, 200, 'total 必须基于截断前的全量 entries，不得撒谎');
  assert.equal(detail.failed, 200);
  assert.ok(detail.entries.length < 200, 'entries 必须被裁剪');
  assert.ok(detail.entries.length >= 1, '截断后至少保留 1 条');
  for (const entry of detail.entries) {
    assert.ok(Array.from(entry.message).length <= 200, `单条 message 必须 ≤200 字符，实际 ${Array.from(entry.message).length}`);
  }
  assert.equal(result.summary.truncated, true);
  assert.equal(result.summary.total, 200);
  assert.equal(result.summary.kvWriteCount, 4, '截断不得增加写入次数');
  assert.equal(Buffer.byteLength(JSON.stringify(kv.json('log:index')[0]), 'utf8') <= MAX_DETAIL_BYTES, true);
});

test('单账号 upstreamFatal（500）：仍落盘 1 条 run，返回体 flushError 为 null', async () => {
  const kv = createMemoryKv();
  const account = makeAccount(1);
  seedAccounts(kv, [account]);
  const mock = createUpstreamMock(() => jsonRes({ code: 500, msg: 'boom' }, 500));
  const { ctx } = makeCtx({ kv, fetch: mock });

  const before = ctx.writes();
  const result = await runCheckin(ctx, { accountIds: [account.id], trigger: 'manual-single' });
  const delta = ctx.writes() - before;

  assert.equal(result.flushError, null, '日志必须落盘成功');
  assert.equal(result.entries[0].result, 'failed');
  assert.equal(result.outcomes[0].upstreamFatal, true, '内存结局需携带 upstreamFatal 供 API 转 502');
  assert.equal(delta, 4);
  assert.equal(result.summary.kvWriteCount, 4);

  const detail = kv.json(`log:run:${result.runId}`);
  assert.ok(detail, '单账号失败也必须写明细（已批准的偏差：诊断优先）');
  assert.equal(detail.failed, 1);
  assert.equal(kv.json('log:index').length, 1);
  assert.equal(kv.json('lock:run'), null);
});

test('AC-12 字面量：已有 30 条 run，第 31 次后仍 30 条且最旧明细已删除', async () => {
  const kv = createMemoryKv();
  seedAccounts(kv, [makeAccount(1)]);
  const { ctx } = makeCtx({ kv, fetch: normalUpstream() });

  const runIds = [];
  for (let i = 0; i < 30; i += 1) {
    runIds.push((await runCheckin(ctx, { trigger: 'cron' })).runId);
  }
  assert.equal(kv.json('log:index').length, 30, '默认 retentionRuns=30');

  const before = ctx.writes();
  const thirtyFirst = await runCheckin(ctx, { trigger: 'cron' });

  assert.equal(ctx.writes() - before, 5, '第 31 次 run 命中淘汰，写入 5 次');
  assert.equal(thirtyFirst.summary.kvWriteCount, 5);

  const index = kv.json('log:index');
  assert.equal(index.length, 30, 'GET /api/logs 恰好返回 30 条');
  assert.equal(index[0].runId, thirtyFirst.runId, '新 run 在首位');
  assert.equal(index.some((item) => item.runId === runIds[0]), false, '最旧 run 已从索引移除');
  assert.equal(kv.has(`log:run:${runIds[0]}`), false, '最旧 run 的明细键已删除（取明细应 404）');
  assert.equal(kv.keys().filter((key) => key.startsWith('log:run:')).length, 30, '不得残留孤儿明细键');
});

test('AC-19 上游超时 10s：该账号 failed 且 durationMs≈10000，其余账号继续，run 正常收尾', async () => {
  const kv = createMemoryKv();
  const slow = makeAccount(1);
  const fast = makeAccount(2);
  seedAccounts(kv, [slow, fast]);

  const clock = createClock();
  const mock = createUpstreamMock((call) => {
    if (call.token === slow.token) {
      // 让注入时钟走满 10s，使 durationMs 能反映真实超时预算
      clock.advance(10000);
      return new Promise(() => {}); // 永不 resolve，且忽略 AbortSignal
    }
    if (call.path === STATUS_PATH) return statusNotCheckedIn();
    return dailyOk(10, 3);
  });
  const { ctx } = makeCtx({ kv, fetch: mock, clock });

  const before = ctx.writes();
  const startedAt = Date.now();
  const result = await runCheckin(ctx, { trigger: 'cron' });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 9900, `单个超时账号应占用约 10s，实际 ${elapsed}ms`);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.success, 1);
  assert.equal(result.summary.failed, 1);

  const slowEntry = result.entries[0];
  assert.equal(slowEntry.accountId, slow.id);
  assert.equal(slowEntry.result, 'failed');
  assert.match(slowEntry.message, /超时/);
  assert.ok(slowEntry.durationMs >= 9900 && slowEntry.durationMs <= 11000, `durationMs≈10000，实际 ${slowEntry.durationMs}`);

  assert.equal(result.entries[1].accountId, fast.id);
  assert.equal(result.entries[1].result, 'checked_in', '超时账号不得中断其余账号');
  assert.equal(result.flushError, null, 'run 必须正常收尾落盘');
  assert.equal(ctx.writes() - before, 4);
  assert.equal(kv.json('log:index').length, 1);
  assert.equal(kv.json(`log:run:${result.runId}`).failed, 1);
  assert.equal(kv.json('lock:run'), null);
});

test('dryRun：只查状态，零 KV 写、不抢锁、不落盘', async () => {
  const kv = createMemoryKv();
  seedAccounts(kv, [makeAccount(1), makeAccount(2)]);
  const mock = createUpstreamMock(() => statusCheckedIn(9));
  const { ctx } = makeCtx({ kv, fetch: mock });

  const before = ctx.writes();
  const result = await runCheckin(ctx, { trigger: 'manual', dryRun: true });
  const delta = ctx.writes() - before;

  assert.equal(delta, 0, 'dryRun 必须零 KV 写');
  assert.equal(result.summary.kvWriteCount, 0);
  assert.equal(kv.has('log:index'), false);
  assert.equal(kv.has('lock:run'), false);
  assert.equal(result.summary.total, 2);
  assert.deepEqual(result.entries.map((entry) => entry.result), ['dry_run_ok', 'dry_run_ok']);
  assert.deepEqual(mock.paths(), [STATUS_PATH, STATUS_PATH], 'dryRun 只允许调 checkin-status');
});
