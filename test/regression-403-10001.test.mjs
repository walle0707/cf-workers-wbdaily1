// test/regression-403-10001.test.mjs
// QA 独立回归验证（Bug：403 被误报成 Token 失效 / 400+code=10001 被误报成失败）。
// 本文件只补齐既有用例尚未覆盖的「分支与边界」，不改动 src/ 实现：
//   1. status 阶段的 code=10001 必须记为 failed（只有 daily 阶段才是幂等成功）；
//   2. status 阶段非 2xx 且 body 不是业务 JSON（WAF HTML 页）的兜底文案；
//   3. UPSTREAM_BASE_URL 归一化（多斜杠 / 非法值回退官方）与「base 被中转覆盖后 origin 仍是官方」；
//   4. daily 阶段 HTTP 200 + code=10001 的当前行为（文档化，见用例注释）；
//   5. credits 重试矩阵：429 / 5xx 重试，业务码 / 非 JSON / 网络错误不重试；
//   6. credits 401 的服务层语义（tokenInvalid=true、upstreamBlocked=false）。
// 对应 AC-7、AC-8、AC-9、AC-19，ARCHITECTURE §8 错误分类表。

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkinAccount, checkinStatus } from '../src/checkin.js';
import { CreditsError, fetchAccountCredits, svcAccountCredits } from '../src/credits.js';
import { AppError } from '../src/util.js';
import {
  DAILY_PATH,
  DAILY_URL,
  createUpstreamMock,
  jsonRes,
  makeAccount,
  makeCtx,
  STATUS_PATH,
  STATUS_URL,
  statusNotCheckedIn,
  textRes,
} from './helpers/harness.mjs';

/** 固定 token（用于泄漏断言）。 */
const TOKEN = 'regression-secret-token-zyxwvutsrq';

/** 官方 Origin：即使 base 被中转覆盖，也必须保持官方值。 */
const OFFICIAL_ORIGIN = 'https://copilot.tencent.com';

/** credits 三个端点。 */
const CREDITS_PATHS = {
  summary: '/billing/meter/get-user-resource-summary',
  paid: '/billing/meter/get-user-resource-paid-packages',
  free: '/billing/meter/get-user-resource-free-packages',
};

// ============ 1. checkin：status 阶段的 10001 不是幂等成功 ============

test('status 阶段返回 400 + code=10001：记为 failed（只有 daily 阶段才是幂等成功）', async () => {
  const mock = createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return jsonRes({ code: 10001, msg: '今天已签到，请明天再来' }, 400);
    throw new Error(`status 阶段失败后不得再调 ${call.path}`);
  });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed', '10001 只在 daily 阶段代表「已签到」，status 阶段必须按失败处理');
  assert.equal(result.code, 10001, '必须保留上游业务码便于排查');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.tokenInvalid, false, '业务码失败不是 token 失效');
  assert.equal(result.upstreamBlocked, false);
  assert.match(result.message, /10001/);
  assert.match(result.message, /今天已签到/);
  assert.equal(mock.count(), 1, 'status 失败必须短路，不得继续调 daily-checkin');
  assert.equal(mock.count(DAILY_PATH), 0);
});

test('checkinStatus 返回 400 + code=10001：不得伪装成 already_checked_in（dryRun 一致性）', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 10001, msg: '今天已签到，请明天再来' }, 400));
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinStatus(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed', 'dryRun 与正式 run 的口径必须一致，不能一个 failed 一个成功');
  assert.equal(result.code, 10001);
  assert.equal(result.tokenInvalid, false);
});

// ============ 2. checkin：非 2xx 且 body 不是业务 JSON 的兜底 ============

test('status 阶段 400 + WAF HTML（无业务 code）：兜底「上游请求失败」且不判 token 失效', async () => {
  const mock = createUpstreamMock(() => textRes('<html><title>400 Bad Request</title></html>', 400));
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.code, null, '没有业务码时不得编造');
  assert.equal(result.tokenInvalid, false);
  assert.equal(result.upstreamBlocked, false, '只有 403 才是出口风控');
  assert.match(result.message, /上游请求失败（HTTP 400）/);
  assert.equal(mock.count(), 1);
});

// ============ 3. checkin：UPSTREAM_BASE_URL 归一化 ============

test('UPSTREAM_BASE_URL 归一化：多斜杠剥离、非法值回退官方、origin/referer 恒为官方', async () => {
  /** @type {Array<{url:string, headers:object}>} */
  const calls = [];
  const relayFetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return jsonRes({ code: 0, data: { today_checked_in: true, streak_days: 3 } });
  };

  // 1) 合法 http(s) + 多斜杠：必须归一化成单斜杠
  const relay = makeCtx({ fetch: relayFetch, env: { UPSTREAM_BASE_URL: 'https://relay.example.com///' } });
  const relayed = await checkinStatus(relay.ctx, makeAccount(1, { token: TOKEN }));
  assert.equal(relayed.result, 'already_checked_in');
  assert.equal(calls[0].url, `https://relay.example.com${STATUS_PATH}`, '末尾多斜杠必须被剥成一条');
  assert.equal(calls[0].headers.origin, OFFICIAL_ORIGIN, 'base 被中转覆盖后 origin 仍是官方值');
  assert.equal(calls[0].headers.referer, `${OFFICIAL_ORIGIN}/`);

  // 2) 非法值（非 http(s):// 前缀）：必须回退官方地址，绝不发往任意协议
  for (const value of ['', 'relay.example.com', 'ftp://relay.example.com', '//relay.example.com', 'javascript:alert(1)']) {
    calls.length = 0;
    const ignored = makeCtx({ fetch: relayFetch, env: { UPSTREAM_BASE_URL: value } });
    await checkinStatus(ignored.ctx, makeAccount(1, { token: TOKEN }));
    assert.equal(calls[0].url, STATUS_URL, `非法 UPSTREAM_BASE_URL=${JSON.stringify(value)} 必须回退官方地址`);
  }
});

// ============ 4. checkin：daily 阶段 200 + code=10001（当前行为，文档化） ============

test('daily 阶段 HTTP 200 + code=10001：当前记为 failed（已知待加固点，见用例注释）', async () => {
  // 线上实测的 10001 是「HTTP 400 + code=10001」，本用例锁定「若上游改为 HTTP 200 返回」的当前行为：
  // 此时 code 走 isBusinessOk(code===0) 判定 → 记为 failed。若上游改用 200 表达「今天已签到」，
  // 需要把 10001 的幂等判定从「非 2xx 分支」上提到「业务码判定」层（已上报团队，不在本次修复范围）。
  const mock = createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return statusNotCheckedIn(2);
    if (call.path === DAILY_PATH) return jsonRes({ code: 10001, msg: '今天已签到，请明天再来' }, 200);
    throw new Error(`未预期的端点 ${call.path}`);
  });
  const { ctx } = makeCtx({ fetch: mock });

  const result = await checkinAccount(ctx, makeAccount(1, { token: TOKEN }));

  assert.equal(result.result, 'failed');
  assert.equal(result.code, 10001);
  assert.equal(result.tokenInvalid, false, '无论 HTTP 状态如何，10001 都不是 token 失效');
  assert.match(result.message, /10001/);
  assert.deepEqual(mock.paths(), [STATUS_PATH, DAILY_PATH]);
});

// ============ 5. credits：重试矩阵 ============

/**
 * 构造 credits 上游 mock（三元端点全可达）。
 * @param {{summary?:Function, paid?:Function, free?:Function}} handlers
 * @returns {Function & {calls:Array<object>}}
 */
function creditsUpstream(handlers = {}) {
  /** @type {Array<{path:string, headers:object}>} */
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, headers: init.headers || {} });
    const handler = path === CREDITS_PATHS.summary ? handlers.summary
      : path === CREDITS_PATHS.paid ? handlers.paid
        : handlers.free;
    if (!handler) throw new Error(`[mock] 未配置 ${path}`);
    return handler({ path, headers: init.headers || {} });
  };
  impl.calls = calls;
  impl.countOf = (path) => calls.filter((call) => call.path === path).length;
  return impl;
}

/** 统计 sleep 调用（不真的等待）。 */
function sleepSpy() {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  sleep.waits = waits;
  return sleep;
}

const CREDITS_ACCOUNT = { id: 'acc_1', name: '主账号', token: TOKEN, uid: 'u-1' };
const CREDITS_NOW = Date.parse('2026-11-14T08:00:00Z');

for (const status of [429, 503]) {
  test(`credits 上游 ${status}：重试一次（共 2 次尝试），最终仍失败`, async () => {
    const mock = creditsUpstream({
      summary: () => textRes(`<html>${status}</html>`, status),
      paid: () => textRes(`<html>${status}</html>`, status),
      free: () => textRes(`<html>${status}</html>`, status),
    });
    const { ctx } = makeCtx({ fetch: mock, clock: () => CREDITS_NOW });
    const sleep = sleepSpy();

    await assert.rejects(
      fetchAccountCredits(ctx, CREDITS_ACCOUNT, { sleep }),
      (err) => {
        assert.ok(err instanceof CreditsError);
        assert.equal(err.kind, 'http');
        assert.equal(err.status, status);
        return true;
      },
    );

    assert.deepEqual(sleep.waits, [400], `${status} 属于非确定性失败，必须间隔 400ms 重试一次`);
    assert.equal(mock.countOf(CREDITS_PATHS.summary), 2);
    assert.equal(mock.calls.length, 6, '三个端点 × 2 次尝试');
  });
}

test('credits 业务码失败（kind=api）：确定性结论，绝不重试', async () => {
  const mock = creditsUpstream({
    summary: () => jsonRes({ code: 40003, message: '风控校验不通过' }),
    paid: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
    free: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => CREDITS_NOW });
  const sleep = sleepSpy();

  await assert.rejects(
    fetchAccountCredits(ctx, CREDITS_ACCOUNT, { sleep }),
    (err) => err instanceof CreditsError && err.kind === 'api' && err.code === 40003,
  );

  assert.deepEqual(sleep.waits, [], '业务码失败不重试');
  assert.equal(mock.countOf(CREDITS_PATHS.summary), 1);
});

test('credits 响应非 JSON（2xx）：不重试，且 message 片段不含 token', async () => {
  const mock = creditsUpstream({
    summary: ({ headers }) => textRes(`<html>gateway${headers.authorization || headers.Authorization}</html>`, 200),
    paid: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
    free: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => CREDITS_NOW });
  const sleep = sleepSpy();

  await assert.rejects(
    fetchAccountCredits(ctx, CREDITS_ACCOUNT, { sleep }),
    (err) => {
      assert.ok(err instanceof CreditsError);
      assert.equal(err.kind, 'bad_json');
      assert.equal(String(err.message).includes(TOKEN), false, 'message 绝不包含 token');
      assert.match(err.message, /\*\*\*/, 'token 必须被替换成 ***');
      return true;
    },
  );

  assert.deepEqual(sleep.waits, [], '非 JSON 属于确定性失败，不重试');
  assert.equal(mock.countOf(CREDITS_PATHS.summary), 1);
});

test('credits 网络错误（kind=network）：不重试（与 timeout 的重试口径不同，属预期设计）', async () => {
  const mock = creditsUpstream({
    summary: () => { throw new Error('boom'); },
    paid: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
    free: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => CREDITS_NOW });
  const sleep = sleepSpy();

  await assert.rejects(
    fetchAccountCredits(ctx, CREDITS_ACCOUNT, { sleep }),
    (err) => err instanceof CreditsError && err.kind === 'network',
  );

  assert.deepEqual(sleep.waits, []);
  assert.equal(mock.countOf(CREDITS_PATHS.summary), 1, 'network 不在重试白名单内（白名单只有 403/429/5xx/timeout）');
});

// ============ 6. credits 服务层：401 的语义 ============

test('svcAccountCredits 401：tokenInvalid=true 且 upstreamBlocked=false（只请求 1 次）', async () => {
  const mock = creditsUpstream({
    summary: () => jsonRes({ code: 401, message: 'unauthorized' }, 401),
    paid: () => jsonRes({}),
    free: () => jsonRes({}),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => CREDITS_NOW });
  await ctx.kv.putAccounts([CREDITS_ACCOUNT]);
  const sleep = sleepSpy();

  await assert.rejects(
    svcAccountCredits(ctx, 'acc_1', { sleep }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'UPSTREAM_ERROR', '必须是 502 语义，不能是 401（否则前端会退出登录）');
      assert.equal(err.detail.tokenInvalid, true);
      assert.equal(err.detail.upstreamBlocked, false, '401 不是出口风控');
      assert.equal(err.detail.status, 401);
      assert.match(err.message, /Token 已失效/);
      return true;
    },
  );

  assert.deepEqual(sleep.waits, [], '401 是确定性结论，不重试');
  assert.equal(mock.countOf(CREDITS_PATHS.summary), 1);
});
