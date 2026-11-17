// test/token-refresh-integration.test.mjs
// 覆盖：额度接口在 access_token 过期时的完整续期链路
//   1. 账号带 refresh_token -> 先刷新、再查询，返回 200 且新 token 落 KV；
//   2. 账号不带 refresh_token -> 502 + detail 明确告知「过期且无法续期」，不误导为「token 填写错误」；
//   3. 刷新接口本身失败 -> 仍把上游 401 作为结论，且 detail 带上续期失败原因。
//
// 这是线上故障（导入 1 小时后面板报「Token 已失效」）的回归用例。

import test from 'node:test';
import assert from 'node:assert/strict';

import { svcAccountCredits } from '../src/credits.js';
import { AppError } from '../src/util.js';
import {
  createClock,
  createUpstreamMock,
  jsonRes,
  makeCtx,
  REFRESH_PATH,
  T0,
  textRes,
} from './helpers/harness.mjs';

const SUMMARY_PATH = '/billing/meter/get-user-resource-summary';
const PAID_PATH = '/billing/meter/get-user-resource-paid-packages';
const FREE_PATH = '/billing/meter/get-user-resource-free-packages';

/** 构造只读 payload 的 JWT。 */
function makeJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc(payload)}.sig`;
}

/** 已过期 1 小时的 access_token。 */
const EXPIRED_TOKEN = makeJwt({ exp: Math.floor((T0 - 3600_000) / 1000), sub: 'u1' });
const REFRESH_TOKEN = makeJwt({ client_key: 'ck' });

/**
 * 汇总类上游 mock：刷新端点回新 token，三个 billing 端点回空数据。
 * @param {{refresh?:Function}} [overrides]
 */
function mockUpstream(overrides = {}) {
  return createUpstreamMock((call) => {
    if (call.path === REFRESH_PATH) {
      if (overrides.refresh) return overrides.refresh(call);
      return jsonRes({ code: 0, data: { accessToken: 'fresh-token', refreshToken: 'fresh-rt', expiresIn: 3600 } });
    }
    // 过期 token 一律按线上真实表现返回 401 HTML（APISIX 网关拦截页）
    if (call.token === EXPIRED_TOKEN) return textRes('<html>401 Authorization Required</html>', 401);
    if (call.path === SUMMARY_PATH) return jsonRes({ code: 0, data: { Packages: [] } });
    if (call.path === PAID_PATH || call.path === FREE_PATH) return jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } });
    throw new Error(`[mock] 未预期的端点 ${call.path}`);
  });
}

test('额度查询：token 已过期但保存了 refresh_token 时自动续期并成功返回', async () => {
  const mock = mockUpstream();
  const clock = createClock(T0);
  const { ctx } = makeCtx({ fetch: mock, clock });
  await ctx.kv.putAccounts([{
    id: 'acc_1', name: '主账号', token: EXPIRED_TOKEN, refreshToken: REFRESH_TOKEN, uid: 'u1',
    enabled: true, remark: '', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  }]);

  const view = await svcAccountCredits(ctx, 'acc_1');

  assert.equal(view.accountId, 'acc_1');
  // 先刷新 1 次，再用新 token 打 3 个额度端点
  assert.equal(mock.count(REFRESH_PATH), 1);
  assert.equal(mock.calls[0].refreshToken, REFRESH_TOKEN);
  const billingTokens = mock.calls.filter((call) => call.path !== REFRESH_PATH).map((call) => call.token);
  assert.ok(billingTokens.every((token) => token === 'fresh-token'), `额度请求应使用新 token，实际：${billingTokens}`);
  // 新 token 必须落 KV，否则下一次请求又要重刷
  const stored = (await ctx.kv.getAccounts())[0];
  assert.equal(stored.token, 'fresh-token');
  assert.equal(stored.refreshToken, 'fresh-rt');
});

test('额度查询：token 已过期且没有 refresh_token 时，502 提示明确指向「无法自动续期」', async () => {
  const mock = mockUpstream();
  const clock = createClock(T0);
  const { ctx } = makeCtx({ fetch: mock, clock });
  await ctx.kv.putAccounts([{
    id: 'acc_1', name: '主账号', token: EXPIRED_TOKEN, uid: 'u1',
    enabled: true, remark: '', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  }]);

  await assert.rejects(
    () => svcAccountCredits(ctx, 'acc_1'),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'UPSTREAM_ERROR');
      assert.equal(err.detail.tokenInvalid, true);
      assert.equal(err.detail.expired, true);
      assert.equal(err.detail.hasRefreshToken, false);
      assert.match(err.message, /未保存 refresh_token/);
      return true;
    },
  );
  // 没有 refresh_token 就不该发刷新请求
  assert.equal(mock.count(REFRESH_PATH), 0);
});

test('额度查询：刷新接口 401（refresh_token 失效）时，错误里带上续期失败原因', async () => {
  const mock = mockUpstream({
    refresh: () => jsonRes({ code: 12153, msg: 'refresh token failed:10000:token format error' }, 401),
  });
  const clock = createClock(T0);
  const { ctx } = makeCtx({ fetch: mock, clock });
  await ctx.kv.putAccounts([{
    id: 'acc_1', name: '主账号', token: EXPIRED_TOKEN, refreshToken: REFRESH_TOKEN, uid: 'u1',
    enabled: true, remark: '', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  }]);

  await assert.rejects(
    () => svcAccountCredits(ctx, 'acc_1'),
    (err) => {
      assert.equal(err.detail.tokenInvalid, true);
      assert.equal(err.detail.hasRefreshToken, true);
      assert.match(err.detail.refreshError, /刷新接口返回 HTTP 401/);
      return true;
    },
  );
});

// ============ 签到主路径（cron / 手动全部）============

test('签到主路径：token 已过期时先续期，再用新 token 完成签到', async () => {
  const { runCheckin } = await import('../src/run.js');
  const { STATUS_PATH, DAILY_PATH } = await import('./helpers/harness.mjs');
  const mock = createUpstreamMock((call) => {
    if (call.path === REFRESH_PATH) {
      return jsonRes({ code: 0, data: { accessToken: 'fresh-token', expiresIn: 3600 } });
    }
    if (call.token !== 'fresh-token') return textRes('<html>401 Authorization Required</html>', 401);
    if (call.path === STATUS_PATH) return jsonRes({ code: 0, data: { today_checked_in: false, streak_days: 3 } });
    if (call.path === DAILY_PATH) return jsonRes({ code: 0, data: { credit: 10, streak_days: 4 } });
    throw new Error(`[mock] 未预期端点 ${call.path}`);
  });
  const clock = createClock(T0);
  const { ctx } = makeCtx({ fetch: mock, clock });
  await ctx.kv.putAccounts([{
    id: 'acc_1', name: '主账号', token: EXPIRED_TOKEN, refreshToken: REFRESH_TOKEN, uid: 'u1',
    enabled: true, remark: '', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  }]);

  const result = await runCheckin(ctx, { trigger: 'manual' });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].result, 'checked_in');
  assert.equal(mock.count(REFRESH_PATH), 1);
  const stored = (await ctx.kv.getAccounts())[0];
  assert.equal(stored.token, 'fresh-token');
});

test('dryRun：token 过期时仍会续期，但承诺「零 KV 写」不被破坏', async () => {
  const { runCheckin } = await import('../src/run.js');
  const { STATUS_PATH } = await import('./helpers/harness.mjs');
  const mock = createUpstreamMock((call) => {
    if (call.path === REFRESH_PATH) {
      return jsonRes({ code: 0, data: { accessToken: 'fresh-token', expiresIn: 3600 } });
    }
    if (call.path === STATUS_PATH && call.token === 'fresh-token') {
      return jsonRes({ code: 0, data: { today_checked_in: false, streak_days: 2 } });
    }
    throw new Error(`[mock] 未预期请求 ${call.path} (${call.token})`);
  });
  const clock = createClock(T0);
  const { ctx } = makeCtx({ fetch: mock, clock });
  await ctx.kv.putAccounts([{
    id: 'acc_1', name: '主账号', token: EXPIRED_TOKEN, refreshToken: REFRESH_TOKEN, uid: 'u1',
    enabled: true, remark: '', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  }]);
  const writesBefore = ctx.writes();

  const result = await runCheckin(ctx, { trigger: 'manual', dryRun: true });

  assert.equal(result.entries[0].result, 'dry_run_ok');
  assert.equal(ctx.writes(), writesBefore, 'dryRun 不允许任何 KV 写');
  assert.equal((await ctx.kv.getAccounts())[0].token, EXPIRED_TOKEN, 'dryRun 不回写 token');
});
