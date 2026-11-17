// test/upstream-token.test.mjs
// 覆盖：JWT 过期判定（秒/毫秒/非法）、刷新触发条件、刷新请求协议（URL/请求头/body）、
//       刷新结果合并与 KV 回写、刷新失败不抛错、401 兜底强制刷新重试。
//
// 背景：WorkBuddy access_token 有效期仅 3600 秒，早期版本只存 access_token 不存 refresh_token，
// 导致导入 1 小时后必然 401。这些用例锁住「能自动续期」这条主链路。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRefreshedToken,
  decodeJwtPayload,
  ensureFreshToken,
  isTokenExpired,
  refreshAccessToken,
  shouldRefreshToken,
  tokenExpiresAtMs,
  TokenRefreshError,
  withFreshToken,
} from '../src/upstream-token.js';
import {
  createClock,
  createUpstreamMock,
  jsonRes,
  makeCtx,
  REFRESH_PATH,
  REFRESH_URL,
  textRes,
  T0,
} from './helpers/harness.mjs';

/** 构造一个只剩签名是假的 JWT（只被测代码读 payload，不验签）。 */
function makeJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.fake-signature`;
}

/** 过期时刻为 T0 + deltaMs 的 token。 */
function tokenExpiringIn(deltaMs) {
  return makeJwt({ exp: Math.floor((T0 + deltaMs) / 1000), sub: 'u1' });
}

const REFRESH_TOKEN = makeJwt({ client_key: 'ck', exp: Math.floor((T0 + 30 * 24 * 3600 * 1000) / 1000) });

// ============ JWT 解析 ============

test('decodeJwtPayload：正常三段式 JWT 能解出 payload', () => {
  const token = makeJwt({ exp: 1700000000, uid: 'abc' });
  assert.deepEqual(decodeJwtPayload(token), { exp: 1700000000, uid: 'abc' });
});

test('decodeJwtPayload：非 JWT / 空值 / 坏 base64 一律返回 null 且不抛', () => {
  assert.equal(decodeJwtPayload('plain-token'), null);
  assert.equal(decodeJwtPayload('a.b'), null);
  assert.equal(decodeJwtPayload(''), null);
  assert.equal(decodeJwtPayload(null), null);
  assert.equal(decodeJwtPayload(undefined), null);
  assert.equal(decodeJwtPayload(123), null);
  assert.equal(decodeJwtPayload('aaa.!!!not-base64!!!.ccc'), null);
});

test('tokenExpiresAtMs：exp 按秒解析，超过 1e12 按毫秒解析', () => {
  assert.equal(tokenExpiresAtMs(makeJwt({ exp: 1700000000 })), 1700000000000);
  assert.equal(tokenExpiresAtMs(makeJwt({ exp: 1700000000000 })), 1700000000000);
  assert.equal(tokenExpiresAtMs(makeJwt({ sub: 'no-exp' })), null);
  assert.equal(tokenExpiresAtMs('not-a-jwt'), null);
});

test('isTokenExpired：能判定过期/未过期，无法判定时返回 false（交给上游 401 兜底）', () => {
  assert.equal(isTokenExpired(tokenExpiringIn(-1000), T0), true);
  assert.equal(isTokenExpired(tokenExpiringIn(60_000), T0), false);
  assert.equal(isTokenExpired('not-a-jwt', T0), false);
});

// ============ 刷新触发条件 ============

test('shouldRefreshToken：没有 refresh_token 一律不刷（无法续期，只能让用户重导）', () => {
  const account = { token: tokenExpiringIn(-3600_000) };
  assert.equal(shouldRefreshToken(account, T0), false);
});

test('shouldRefreshToken：已过期 / 5 分钟内过期要刷，剩余 1 小时不刷', () => {
  const base = { refreshToken: REFRESH_TOKEN };
  assert.equal(shouldRefreshToken({ ...base, token: tokenExpiringIn(-1000) }, T0), true);
  assert.equal(shouldRefreshToken({ ...base, token: tokenExpiringIn(4 * 60 * 1000) }, T0), true);
  assert.equal(shouldRefreshToken({ ...base, token: tokenExpiringIn(60 * 60 * 1000) }, T0), false);
});

test('shouldRefreshToken：JWT 解不出 exp 时退回账号记录的 expiresAt', () => {
  const account = { token: 'opaque-token', refreshToken: REFRESH_TOKEN, expiresAt: T0 - 1 };
  assert.equal(shouldRefreshToken(account, T0), true);
  assert.equal(shouldRefreshToken({ ...account, expiresAt: T0 + 3600_000 }, T0), false);
});

test('shouldRefreshToken：exp 与 expiresAt 都拿不到时不主动刷（靠 401 兜底）', () => {
  assert.equal(shouldRefreshToken({ token: 'opaque', refreshToken: REFRESH_TOKEN }, T0), false);
});

// ============ applyRefreshedToken ============

test('applyRefreshedToken：换新 token 并保留旧 refresh_token（上游未回传时不能让续期链断掉）', () => {
  const old = { id: 'acc_1', token: 'old-at', refreshToken: 'old-rt', uid: 'u1' };
  const next = applyRefreshedToken(old, { accessToken: 'new-at', refreshToken: null, expiresAt: T0 + 3600_000 }, T0);
  assert.equal(next.token, 'new-at');
  assert.equal(next.refreshToken, 'old-rt');
  assert.equal(next.expiresAt, T0 + 3600_000);
  assert.equal(next.uid, 'u1');
  assert.equal(next.tokenRefreshedAt, new Date(T0).toISOString());
});

test('applyRefreshedToken：上游回了新 refresh_token 就替换', () => {
  const next = applyRefreshedToken({ token: 'old-at', refreshToken: 'old-rt' }, { accessToken: 'new-at', refreshToken: 'new-rt' }, T0);
  assert.equal(next.refreshToken, 'new-rt');
});

// ============ 刷新请求协议 ============

test('refreshAccessToken：POST 到 /v2/plugin/auth/token/refresh，带 Authorization + X-Refresh-Token + X-Auth-Refresh-Source', async () => {
  const mock = createUpstreamMock(() => jsonRes({
    code: 0,
    data: { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: T0 + 3600_000, domain: 'codebuddy.cn' },
  }));
  const { ctx } = makeCtx({ fetch: mock });

  const tokens = await refreshAccessToken(ctx, {
    token: 'old-at', refreshToken: 'old-rt', domain: 'codebuddy.cn',
  });

  assert.equal(mock.count(REFRESH_PATH), 1);
  const call = mock.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, REFRESH_URL);
  assert.equal(call.authorization, 'Bearer old-at');
  assert.equal(call.refreshToken, 'old-rt');
  assert.equal(call.refreshSource, 'plugin');
  assert.equal(call.domain, 'codebuddy.cn');
  assert.equal(call.body, '{}');
  assert.equal(tokens.accessToken, 'new-at');
  assert.equal(tokens.refreshToken, 'new-rt');
  assert.equal(tokens.expiresAt, T0 + 3600_000);
});

test('refreshAccessToken：只给 expiresIn 时按 now 折算过期时刻', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: { accessToken: 'new-at', expiresIn: 3600 } }));
  const clock = createClock(T0);
  const { ctx } = makeCtx({ fetch: mock, clock });
  const tokens = await refreshAccessToken(ctx, { token: 'old-at', refreshToken: 'old-rt' });
  assert.equal(tokens.expiresAt, T0 + 3600_000);
});

test('refreshAccessToken：缺少 refresh_token 直接抛 no_refresh_token，不发请求', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: { accessToken: 'x' } }));
  const { ctx } = makeCtx({ fetch: mock });
  await assert.rejects(
    () => refreshAccessToken(ctx, { token: 'old-at' }),
    (err) => err instanceof TokenRefreshError && err.kind === 'no_refresh_token',
  );
  assert.equal(mock.calls.length, 0);
});

test('refreshAccessToken：HTTP 401（refresh_token 失效）映射为 http 错误且 needsRelogin=true', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 12153, msg: 'refresh token failed' }, 401));
  const { ctx } = makeCtx({ fetch: mock });
  await assert.rejects(
    () => refreshAccessToken(ctx, { token: 'old-at', refreshToken: 'bad-rt' }),
    (err) => err instanceof TokenRefreshError
      && err.kind === 'http'
      && err.status === 401
      && err.needsRelogin === true,
  );
});

test('refreshAccessToken：HTTP 200 但业务 code 非 0 视为失败', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 12153, msg: 'refresh token failed: invalid_grant' }));
  const { ctx } = makeCtx({ fetch: mock });
  await assert.rejects(
    () => refreshAccessToken(ctx, { token: 'old-at', refreshToken: 'bad-rt' }),
    (err) => err instanceof TokenRefreshError && err.kind === 'api' && err.code === 12153,
  );
});

test('refreshAccessToken：响应非 JSON 时不把原始 body 里的 token 泄漏出去', async () => {
  const mock = createUpstreamMock(() => textRes('oops old-at leaked', 200));
  const { ctx } = makeCtx({ fetch: mock });
  await assert.rejects(
    () => refreshAccessToken(ctx, { token: 'old-at', refreshToken: 'old-rt' }),
    (err) => err instanceof TokenRefreshError && !err.message.includes('old-at'),
  );
});

// ============ ensureFreshToken（含 KV 回写）============

test('ensureFreshToken：临近过期时刷新并把新 token 写回 KV，账号其它字段保持不变', async () => {
  const mock = createUpstreamMock(() => jsonRes({
    code: 0, data: { accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 3600 },
  }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  await ctx.kv.putAccounts([{
    id: 'acc_1', name: '主账号', token: tokenExpiringIn(-1000), refreshToken: 'old-rt', uid: 'u1',
    enabled: true, remark: '备注', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  }]);

  const result = await ensureFreshToken(ctx, (await ctx.kv.getAccounts())[0]);

  assert.equal(result.refreshed, true);
  assert.equal(result.account.token, 'new-at');
  const stored = (await ctx.kv.getAccounts())[0];
  assert.equal(stored.token, 'new-at');
  assert.equal(stored.refreshToken, 'new-rt');
  assert.equal(stored.name, '主账号');
  assert.equal(stored.remark, '备注');
  assert.equal(stored.uid, 'u1');
});

test('ensureFreshToken：还早就不刷新，零请求零写', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: { accessToken: 'x' } }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const account = { id: 'acc_1', token: tokenExpiringIn(60 * 60 * 1000), refreshToken: 'old-rt' };
  await ctx.kv.putAccounts([account]);
  const result = await ensureFreshToken(ctx, account);
  assert.equal(result.refreshed, false);
  assert.equal(mock.calls.length, 0);
});

test('ensureFreshToken：刷新失败不抛错，返回原账号并把错误交回调用方', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 12153, msg: 'invalid_grant' }, 401));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const account = { id: 'acc_1', token: tokenExpiringIn(-1000), refreshToken: 'bad-rt' };
  await ctx.kv.putAccounts([account]);

  const result = await ensureFreshToken(ctx, account);

  assert.equal(result.refreshed, false);
  assert.equal(result.account.token, account.token);
  assert.ok(result.error instanceof TokenRefreshError);
  assert.equal((await ctx.kv.getAccounts())[0].token, account.token);
});

test('ensureFreshToken：force=true 时即使没过期也刷新（401 兜底用）', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: { accessToken: 'new-at', expiresIn: 3600 } }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const result = await ensureFreshToken(ctx, {
    id: 'acc_1', token: tokenExpiringIn(60 * 60 * 1000), refreshToken: 'old-rt',
  }, { force: true });
  assert.equal(result.refreshed, true);
  assert.equal(result.account.token, 'new-at');
});

test('ensureFreshToken：账号刷新期间被删除时不回写（不复活已删账号）', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: { accessToken: 'new-at', expiresIn: 3600 } }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  await ctx.kv.putAccounts([]);
  const result = await ensureFreshToken(ctx, {
    id: 'acc_missing', token: 'old-at', refreshToken: 'old-rt', expiresAt: T0 - 1,
  });
  assert.equal(result.refreshed, true);
  assert.deepEqual(await ctx.kv.getAccounts(), []);
});

// ============ withFreshToken（tokenInvalid 兜底重试）============

test('withFreshToken：结果 tokenInvalid 时强制续期后重试一次并成功', async () => {
  let refreshCount = 0;
  const mock = createUpstreamMock((call) => {
    if (call.path === REFRESH_PATH) {
      refreshCount += 1;
      return jsonRes({ code: 0, data: { accessToken: 'new-at', expiresIn: 3600 } });
    }
    return jsonRes({ code: 0, data: {} });
  });
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const seen = [];
  const outcome = await withFreshToken(
    ctx,
    { id: 'acc_1', token: 'opaque-old', refreshToken: 'old-rt' },
    async (account) => {
      seen.push(account.token);
      return { result: account.token === 'new-at' ? 'checked_in' : 'failed', tokenInvalid: account.token !== 'new-at' };
    },
  );
  assert.equal(outcome.result, 'checked_in');
  assert.equal(refreshCount, 1);
  assert.deepEqual(seen, ['opaque-old', 'new-at']);
});

test('withFreshToken：没有 refresh_token 时不重试，原样返回 tokenInvalid', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: {} }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  let calls = 0;
  const outcome = await withFreshToken(ctx, { id: 'acc_1', token: 'opaque' }, async () => {
    calls += 1;
    return { result: 'failed', tokenInvalid: true };
  });
  assert.equal(outcome.tokenInvalid, true);
  assert.equal(calls, 1);
  assert.equal(mock.calls.length, 0);
});

test('withFreshToken：结果正常时不触发刷新', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: {} }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const outcome = await withFreshToken(
    ctx,
    { id: 'acc_1', token: 'opaque', refreshToken: 'rt' },
    async () => ({ result: 'checked_in', tokenInvalid: false }),
  );
  assert.equal(outcome.result, 'checked_in');
  assert.equal(mock.calls.length, 0);
});

test('withFreshToken：persist=false 时不回写 KV（dryRun 零写契约）', async () => {
  const mock = createUpstreamMock(() => jsonRes({ code: 0, data: { accessToken: 'new-at', expiresIn: 3600 } }));
  const { ctx, clock } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const account = { id: 'acc_1', token: tokenExpiringIn(-1000), refreshToken: 'old-rt' };
  await ctx.kv.putAccounts([account]);
  const before = ctx.writes();
  const outcome = await withFreshToken(ctx, account, async (effective) => ({ result: 'ok', tokenInvalid: false, token: effective.token }), { persist: false });
  assert.equal(outcome.token, 'new-at');
  assert.equal(ctx.writes(), before);
});
