// test/oauth.test.mjs
// 覆盖：OAuth 授权账号录入（src/oauth.js + src/account-view.js + 两条 /api/oauth/* 路由）
//
// 用例分组：
//   1. start 成功（上游请求形状 + 出参契约）
//   2. 授权链接白名单（safeVerificationUri 防开放重定向）
//   3. start 失败（HTTP 403 / 非 JSON / 缺 state / 网络错误 -> 502）
//   4. poll pending（中间态不发 profile 请求）
//   5. poll success 全链路（KV 落库 / Bearer 与 x-domain / 脱敏出参 / 日志不泄密）
//   6. poll expired（HTTP 4xx 与 code=12153）
//   7. poll 硬错误（429 / 500 / 非 JSON -> 502）
//   8. state 校验（格式与长度边界 -> 400）
//   9. 同 uid 二次导入（更新而非新增，旧 refreshToken/domain/enterpriseId 不被清空）
//  10. 账号上限（第 11 个 CONFLICT；同 uid 更新不受限）
//  11. 端点层（无 Cookie 401 / start 跨站 403 / poll 不做同源校验）
//  12. enterpriseId 生效（buildUpstreamHeaders 带业务头，maskAccount 不暴露）
//  13. expiresAt 语义（上游秒 -> 毫秒；只给 expiresIn；saveOAuthAccount 入参按毫秒原样）
//  14. 续期集成（OAuth 落库账号过期后自动 refresh 并回写）
//  15. 前端静态检查（录入方式切换节点 + 弹窗 close 停轮询）
//
// 约定：只用 ctx.now / ctx.fetch / ctx.kv，绝不真实联网；每个用例独立 env。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { pollWorkbuddyLogin, safeVerificationUri, saveOAuthAccount, startWorkbuddyLogin } from '../src/oauth.js';
import { maskAccount } from '../src/account-view.js';
import { buildUpstreamHeaders } from '../src/upstream-headers.js';
import { svcAccountCredits } from '../src/credits.js';
import { AppError } from '../src/util.js';
import {
  FREE_PATH,
  OAUTH_ACCOUNT_PATH,
  OAUTH_STATE_PATH,
  OAUTH_TOKEN_PATH,
  PAID_PATH,
  REFRESH_PATH,
  SUMMARY_PATH,
  T0,
  createAuthedEnv,
  createClock,
  createUpstreamMock,
  dispatch,
  jsonRes,
  makeAccount,
  makeCtx,
  textRes,
} from './helpers/harness.mjs';

/** 合法 state（上游形态：字母数字与 -_，8~128 位）。 */
const STATE = 'st-abcdef123456';

/** 官方兜底授权地址前缀（state 需 URL 编码后拼接）。 */
const FALLBACK_PREFIX = 'https://copilot.tencent.com/login?state=';

/** 四个「匿名客户端」请求头：缺失会被上游网关 403 / code=10085。 */
const NO_HEADERS = ['x-no-authorization', 'x-no-user-id', 'x-no-enterprise-id', 'x-no-department-info'];

/**
 * 只放行指定上游端点的 mock（其余路径立刻失败，避免用例偷偷依赖别的端点）。
 * @param {Record<string, (call:object) => (Response|Promise<Response>|null)>} routes
 * @returns {Function & {calls:object[], count:Function, paths:Function}}
 */
function mockRoutes(routes) {
  return createUpstreamMock((call) => {
    const handler = routes[call.path];
    if (!handler) throw new Error(`[mock] 用例未声明的上游端点：${call.path}`);
    return handler(call);
  });
}

/** start 成功响应（可覆写 authUrl）。 */
function stateOk(patch = {}) {
  return jsonRes({ code: 0, data: { state: STATE, authUrl: `${FALLBACK_PREFIX}${STATE}`, ...patch } });
}

/** poll 中间态：code 正常但没有 accessToken。 */
function tokenPending() {
  return jsonRes({ code: 0, data: {} });
}

/**
 * console 打桩：收所有日志行，用于断言「日志里没有明文 token / 完整 state」。
 * @returns {{lines:string[], text:Function, restore:Function}}
 */
function stubConsole() {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const collect = (level) => (...args) => {
    lines.push(`[${level}] ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`);
  };
  console.log = collect('log');
  console.warn = collect('warn');
  console.error = collect('error');
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

/** 断言上游拒绝被映射成 AppError 且错误码/提示符合契约。 */
async function rejectsWith(run, code, matcher) {
  await assert.rejects(run, (err) => {
    assert.ok(err instanceof AppError, `应抛 AppError，实际：${err && err.name}`);
    assert.equal(err.code, code);
    assert.match(err.message, matcher);
    return true;
  });
}

// ============ 1. start 成功 ============

test('start 成功：上游请求形状与出参契约', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => stateOk() });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  const res = await dispatch(ctx, '/api/oauth/start', { method: 'POST', body: {}, cookie });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    state: STATE,
    verificationUri: `${FALLBACK_PREFIX}${STATE}`,
    expiresIn: 600,
    intervalSeconds: 2,
  });
  // 响应里不允许出现任何 token 字段
  assert.doesNotMatch(res.text, /accessToken|refreshToken/);

  assert.equal(mock.count(), 1, 'start 只应打一次上游');
  const [call] = mock.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, OAUTH_STATE_PATH);
  const parsed = new URL(call.url);
  assert.equal(parsed.origin, 'https://copilot.tencent.com');
  assert.equal(parsed.searchParams.get('platform'), 'workbuddy');
  assert.match(call.headers['user-agent'], /Macintosh/, 'UA 必须是 macOS（与 cockpit-tools 逐字对齐）');
  assert.match(call.headers['user-agent'], /Chrome\/131\./);
  for (const key of NO_HEADERS) {
    assert.equal(call.headers[key], 'true', `${key} 必须为 'true'`);
  }
  assert.equal(call.contentType, 'application/json');
  assert.equal(call.body, '{}');
});

// ============ 2. 授权链接白名单 ============

test('safeVerificationUri：非白名单 / 非法地址一律回退官方兜底且 state 已编码', () => {
  const weirdState = 'a b/c&d=e';
  const encoded = encodeURIComponent(weirdState);
  const rejected = [
    'https://evil.example.com/x',
    '',
    '   ',
    'not-a-url',
    'http://copilot.tencent.com/x',
    'https://copilot.tencent.com.evil.com/x',
    'https://tencent.com.evil/x',
    'javascript:alert(1)',
  ];
  for (const raw of rejected) {
    assert.equal(
      safeVerificationUri(raw, weirdState),
      `${FALLBACK_PREFIX}${encoded}`,
      `应回退兜底地址：${raw === '' ? '(空串)' : raw}`,
    );
  }
});

test('safeVerificationUri：copilot.tencent.com 与 *.tencent.com 原样放行', () => {
  for (const raw of [
    'https://copilot.tencent.com/login?state=1',
    'https://a.tencent.com/x',
    'https://x.tencent.com/a?b=1#c',
  ]) {
    assert.equal(safeVerificationUri(raw, STATE), new URL(raw).href, `应原样放行：${raw}`);
  }
});

test('start：上游给的白名单外 authUrl 会被改写成兜底地址', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => stateOk({ authUrl: 'https://evil.example.com/steal' }) });
  const { ctx } = makeCtx({ fetch: mock });

  const data = await startWorkbuddyLogin(ctx);

  assert.equal(data.verificationUri, `${FALLBACK_PREFIX}${encodeURIComponent(STATE)}`);
  assert.doesNotMatch(data.verificationUri, /evil\.example\.com/);
});

// ============ 3. start 失败 ============

test('start 失败：上游 403 + code=10085 -> 502 且提示含 HTTP 403', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => jsonRes({ code: 10085, msg: 'invalid client' }, 403) });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  const res = await dispatch(ctx, '/api/oauth/start', { method: 'POST', body: {}, cookie });

  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'UPSTREAM_ERROR');
  assert.match(res.body.error.message, /HTTP 403/);
  assert.equal(res.body.detail.status, 403);
});

test('start 失败：200 但响应是 HTML -> 502「不是 JSON」', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => textRes('<html>gated</html>', 200) });
  const { ctx } = makeCtx({ fetch: mock });

  await rejectsWith(() => startWorkbuddyLogin(ctx), 'UPSTREAM_ERROR', /不是 JSON/);
});

test('start 失败：200 但缺 data.state -> 502', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => jsonRes({ code: 0, data: { authUrl: 'https://a.tencent.com/x' } }) });
  const { ctx } = makeCtx({ fetch: mock });

  await rejectsWith(() => startWorkbuddyLogin(ctx), 'UPSTREAM_ERROR', /未返回 state/);
});

test('start 失败：fetch 抛网络错误 -> 502', async () => {
  const mock = mockRoutes({
    [OAUTH_STATE_PATH]: () => {
      throw new TypeError('network down');
    },
  });
  const { ctx } = makeCtx({ fetch: mock });

  await rejectsWith(() => startWorkbuddyLogin(ctx), 'UPSTREAM_ERROR', /网络错误/);
});

// ============ 4. poll pending ============

test('poll pending：code=0 但没有 accessToken -> pending，且不请求 profile', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => tokenPending(),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'should-not-happen' } }),
  });
  const { ctx } = makeCtx({ fetch: mock });

  const data = await pollWorkbuddyLogin(ctx, STATE);

  assert.deepEqual(data, { status: 'pending' });
  assert.equal(mock.count(OAUTH_ACCOUNT_PATH), 0, 'pending 阶段不应拉账号资料');
  assert.equal(mock.count(OAUTH_TOKEN_PATH), 1);

  // 轮询请求形态：GET + state 回传 + 四头，且**不带** content-type
  const [call] = mock.calls;
  assert.equal(call.method, 'GET');
  assert.equal(new URL(call.url).searchParams.get('state'), STATE);
  assert.match(call.headers['user-agent'], /Macintosh/);
  for (const key of NO_HEADERS) {
    assert.equal(call.headers[key], 'true', `${key} 必须为 'true'`);
  }
  assert.equal(call.contentType, null, 'GET 轮询不应带 content-type');
  assert.equal(call.body, undefined);
});

// 线上实测：生成链接后立即轮询，上游回 HTTP 200 + code=11217「login ing...」。
// 这是「用户还没登录完」的中间态，必须继续等；当成错误会让面板一开就报 502。
test('poll pending：code=11217（login ing）-> pending，不报错、不写 KV', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 11217, msg: 'login ing...', requestId: 'req-1' }),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'should-not-happen' } }),
  });
  const { ctx } = makeCtx({ fetch: mock });

  const data = await pollWorkbuddyLogin(ctx, STATE);

  assert.deepEqual(data, { status: 'pending' });
  assert.equal(mock.count(OAUTH_ACCOUNT_PATH), 0, 'pending 阶段不应拉账号资料');
  assert.deepEqual(await ctx.kv.getAccounts(), []);
});

test('poll 连续轮询：先 11217 再返回 token -> 最终 success（模拟前端等待循环）', async () => {
  let round = 0;
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => {
      round += 1;
      if (round === 1) return jsonRes({ code: 11217, msg: 'login ing...' });
      return jsonRes({ code: 0, data: { accessToken: 'at-loop', refreshToken: 'rt-loop' } });
    },
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'u-loop', nickname: '循环用户' } }),
  });
  const { ctx } = makeCtx({ fetch: mock });

  assert.deepEqual(await pollWorkbuddyLogin(ctx, STATE), { status: 'pending' });
  const done = await pollWorkbuddyLogin(ctx, STATE);

  assert.equal(done.status, 'success');
  assert.equal(done.account.name, '循环用户');
  assert.equal(mock.count(OAUTH_TOKEN_PATH), 2);
  assert.equal(mock.count(OAUTH_ACCOUNT_PATH), 1);
  const list = await ctx.kv.getAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].token, 'at-loop');
});

// ============ 5. poll success 全链路 ============

test('poll success：token 落库 + profile 带 Bearer/x-domain + 出参脱敏 + 日志不泄密', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({
      code: 0,
      data: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1700003600000, domain: 'd1' },
    }),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({
      code: 0,
      data: { uid: 'u1', nickname: '小明', email: 'a@b.c', enterpriseId: 'ent-1' },
    }),
  });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  const spy = stubConsole();
  let res;
  try {
    res = await dispatch(ctx, `/api/oauth/poll?state=${encodeURIComponent(STATE)}`, { cookie });
  } finally {
    spy.restore();
  }

  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'success');

  // ---- KV：恰好 1 个账号，字段全部正确 ----
  const list = await ctx.kv.getAccounts();
  assert.equal(list.length, 1);
  const stored = list[0];
  assert.equal(stored.token, 'at-1');
  assert.equal(stored.refreshToken, 'rt-1');
  assert.equal(stored.uid, 'u1');
  assert.equal(stored.domain, 'd1');
  assert.equal(stored.enterpriseId, 'ent-1');
  assert.equal(stored.expiresAt, 1700003600000);
  assert.equal(stored.enabled, true);
  assert.equal(stored.remark, 'OAuth 授权');
  assert.equal(stored.checkinHour, 8);
  assert.equal(stored.name, '小明');
  assert.equal(stored.createdAt, new Date(T0).toISOString());
  assert.equal(stored.updatedAt, new Date(T0).toISOString());
  assert.match(stored.id, /^acc_/);

  // ---- profile 请求：真实 Bearer + x-domain + 四头 ----
  const profileCall = mock.calls.find((call) => call.path === OAUTH_ACCOUNT_PATH);
  assert.ok(profileCall, '应请求 profile 端点');
  assert.equal(profileCall.method, 'GET');
  assert.equal(profileCall.authorization, 'Bearer at-1');
  assert.equal(profileCall.headers['x-domain'], 'd1');
  for (const key of NO_HEADERS.filter((name) => name !== 'x-no-authorization')) {
    assert.equal(profileCall.headers[key], 'true', `${key} 必须保留`);
  }

  // ---- 出参：无明文 token、无 enterpriseId、有 tokenMasked / hasRefreshToken ----
  const account = res.body.data.account;
  assert.equal(account.token, undefined);
  assert.equal(account.enterpriseId, undefined);
  assert.equal(typeof account.tokenMasked, 'string');
  assert.equal(account.hasRefreshToken, true);
  assert.equal(account.uid, 'u1');
  assert.doesNotMatch(res.text, /at-1|rt-1|ent-1/);

  // ---- 日志：不放 token 明文、不放完整 state ----
  const logText = spy.text();
  assert.ok(logText.length > 0, '应有日志输出');
  assert.doesNotMatch(logText, /at-1/, '日志不得出现 access_token');
  assert.doesNotMatch(logText, /rt-1/, '日志不得出现 refresh_token');
  assert.ok(!logText.includes(STATE), '日志不得出现完整 state');
  assert.ok(logText.includes(STATE.slice(0, 6)), '日志应保留 state 前 6 位以便排查');
});

test('poll success：profile 失败不阻断导入（token 已拿到就落库）', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-2', refreshToken: 'rt-2' } }),
    [OAUTH_ACCOUNT_PATH]: () => textRes('<html>502 bad gateway</html>', 502),
  });
  const { ctx } = makeCtx({ fetch: mock });

  const data = await pollWorkbuddyLogin(ctx, STATE);

  assert.equal(data.status, 'success');
  const list = await ctx.kv.getAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].token, 'at-2');
  assert.equal(list[0].uid, '');
  assert.equal(list[0].name, 'WorkBuddy 账号 1', '拿不到资料时用序号兜底名');
});

// ============ 6. poll expired ============

test('poll expired：HTTP 404 -> expired 且不写 KV', async () => {
  const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 12153, msg: 'state expired' }, 404) });
  const { ctx } = makeCtx({ fetch: mock });

  assert.deepEqual(await pollWorkbuddyLogin(ctx, STATE), { status: 'expired' });
  assert.deepEqual(await ctx.kv.getAccounts(), []);
});

test('poll expired：HTTP 200 + code=12153 -> expired 且不写 KV', async () => {
  const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 12153, msg: 'token format error' }) });
  const { ctx } = makeCtx({ fetch: mock });

  assert.deepEqual(await pollWorkbuddyLogin(ctx, STATE), { status: 'expired' });
  assert.deepEqual(await ctx.kv.getAccounts(), []);
});

// ============ 7. poll 硬错误 ============

test('poll 硬错误：HTTP 429 / 500 -> 502', async () => {
  for (const status of [429, 500]) {
    const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, msg: 'upstream busy' }, status) });
    const { ctx } = makeCtx({ fetch: mock });
    await rejectsWith(
      () => pollWorkbuddyLogin(ctx, STATE),
      'UPSTREAM_ERROR',
      new RegExp(`HTTP ${status}`),
    );
    assert.deepEqual(await ctx.kv.getAccounts(), [], '出错不应写 KV');
  }
});

test('poll 硬错误：200 + HTML -> 502「不是 JSON」', async () => {
  const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => textRes('<html>oops</html>', 200) });
  const { ctx } = makeCtx({ fetch: mock });

  await rejectsWith(() => pollWorkbuddyLogin(ctx, STATE), 'UPSTREAM_ERROR', /不是 JSON/);
});

// ============ 8. state 校验 ============

test('state 校验：非法格式/长度 -> 400 BAD_REQUEST，且不请求上游', async () => {
  const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => tokenPending() });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  const badStates = ['', 'short', 'bad state!', 'a'.repeat(129), `${STATE}!`];
  for (const bad of badStates) {
    const res = await dispatch(ctx, `/api/oauth/poll?state=${encodeURIComponent(bad)}`, { cookie });
    assert.equal(res.status, 400, `state=${bad.slice(0, 16)} 应为 400`);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  }

  // 缺 state 查询参数
  const missing = await dispatch(ctx, '/api/oauth/poll', { cookie });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'BAD_REQUEST');

  assert.equal(mock.count(), 0, 'state 非法时不应打上游');
});

test('state 校验：合法边界（8 位与 128 位）放行', async () => {
  const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => tokenPending() });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  for (const ok of ['abcdefgh', 'a'.repeat(128), 'Aa0_-Bb9']) {
    const res = await dispatch(ctx, `/api/oauth/poll?state=${encodeURIComponent(ok)}`, { cookie });
    assert.equal(res.status, 200, `state=${ok.slice(0, 12)} 应放行`);
    assert.equal(res.body.data.status, 'pending');
  }
});

// ============ 9. 同 uid 二次导入 ============

test('同 uid 二次导入：更新而不新增，旧 refreshToken/domain/enterpriseId 保留', async () => {
  let pollNo = 0;
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => {
      pollNo += 1;
      // 第二次上游只给新 accessToken：refreshToken/domain/expiresAt 全部缺失
      if (pollNo === 1) {
        return jsonRes({
          code: 0,
          data: { accessToken: 'at-1', refreshToken: 'rt-1', domain: 'd1', expiresAt: 1700003600000 },
        });
      }
      return jsonRes({ code: 0, data: { accessToken: 'at-2' } });
    },
    [OAUTH_ACCOUNT_PATH]: () => {
      if (pollNo === 1) {
        return jsonRes({ code: 0, data: { uid: 'u1', nickname: '小明', email: 'a@b.c', enterpriseId: 'ent-1' } });
      }
      // 第二次连 enterpriseId 都没有
      return jsonRes({ code: 0, data: { uid: 'u1' } });
    },
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });

  const first = await pollWorkbuddyLogin(ctx, STATE);
  assert.equal(first.status, 'success');
  const created = (await ctx.kv.getAccounts())[0];
  const originalCheckinHour = created.checkinHour;

  // 模拟用户在面板里改过名字（remark / checkinHour / id 都不该被 OAuth 覆盖）
  await ctx.kv.putAccounts([{ ...created, name: '改过的名字' }]);

  const second = await pollWorkbuddyLogin(ctx, STATE);
  assert.equal(second.status, 'success');

  const after = await ctx.kv.getAccounts();
  assert.equal(after.length, 1, '同 uid 必须更新而不是新增');
  const updated = after[0];
  assert.equal(updated.id, created.id, 'id 必须保持不变');
  assert.equal(updated.token, 'at-2', 'token 必须已更新');
  assert.equal(updated.name, '改过的名字', 'name 必须保留用户手改值');
  assert.equal(updated.remark, 'OAuth 授权', 'remark 保留');
  assert.equal(updated.checkinHour, originalCheckinHour, 'checkinHour 保留');
  assert.equal(updated.refreshToken, 'rt-1', '上游未回 refreshToken 时不得清空旧值');
  assert.equal(updated.domain, 'd1', '上游未回 domain 时不得清空旧值');
  assert.equal(updated.enterpriseId, 'ent-1', '上游未回 enterpriseId 时不得清空旧值');
  assert.equal('expiresAt' in updated, false, '本次无过期信息 -> 旧 expiresAt 应删除');
  assert.equal(updated.enabled, true);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, new Date(T0).toISOString());
});

// ============ 9b. 去重与 uid 回填回归（profile 失败后重试 / 满额命中） ============

test('去重回归：profile 失败（uid 为空）连续两次 poll 只落 1 条账号', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-1' } }),
    [OAUTH_ACCOUNT_PATH]: () => textRes('<html>502 bad gateway</html>', 502),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });

  const first = await pollWorkbuddyLogin(ctx, STATE);
  const second = await pollWorkbuddyLogin(ctx, STATE);
  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');

  const list = await ctx.kv.getAccounts();
  assert.equal(list.length, 1, '同一 token 重复轮询不得建出第二条账号');
  assert.equal(list[0].uid, '');
  assert.equal(list[0].token, 'at-1');
  assert.deepEqual(list.map((account) => account.checkinHour), [8], '不应出现 8/9 两个签到小时');
});

test('去重回归：profile 恢复后同 token 再 poll -> 回填 uid 且不改 id/name', async () => {
  let profileDown = true;
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-1' } }),
    [OAUTH_ACCOUNT_PATH]: () => (profileDown
      ? textRes('<html>502 bad gateway</html>', 502)
      : jsonRes({ code: 0, data: { uid: 'uid-1', nickname: '小明' } })),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });

  // 第一次：profile 挂掉 -> 建出 uid 为空的账号（兜底名）
  await pollWorkbuddyLogin(ctx, STATE);
  const created = (await ctx.kv.getAccounts())[0];
  assert.equal(created.uid, '');
  assert.equal(created.name, 'WorkBuddy 账号 1');

  // 第二次：profile 恢复且这次带着 uid -> 命中同 token，回填 uid
  profileDown = false;
  const again = await pollWorkbuddyLogin(ctx, STATE);
  assert.equal(again.status, 'success');

  const after = await ctx.kv.getAccounts();
  assert.equal(after.length, 1, '仍是同一条账号');
  assert.equal(after[0].id, created.id, 'id 必须与第一次相同');
  assert.equal(after[0].uid, 'uid-1', 'uid 应被回填');
  assert.equal(after[0].name, created.name, '更新分支不改 name（兜底名保留，用户可手改）');
  assert.equal(after[0].remark, 'OAuth 授权');
  assert.equal(after[0].checkinHour, created.checkinHour);
  assert.equal(after[0].createdAt, created.createdAt);
  assert.equal(after[0].updatedAt, new Date(T0).toISOString());
});

test('去重回归：token 兜底命中满额账号时保留原 uid，不新增也不 CONFLICT', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-9' } }),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'uid-B', nickname: '新名字' } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const ten = Array.from({ length: 10 }, (_unused, index) => ({ ...makeAccount(index + 1), uid: '' }));
  // 目标账号：已有 uid，且 token 与本次上游一致（走 uid-B 匹配失败 -> token 兜底命中）
  ten[0] = { ...ten[0], uid: 'uid-A', token: 'at-9', checkinHour: 9, name: '老账号' };
  await ctx.kv.putAccounts(ten);

  const data = await pollWorkbuddyLogin(ctx, STATE);

  assert.equal(data.status, 'success');
  const after = await ctx.kv.getAccounts();
  assert.equal(after.length, 10, '满额时命中已有账号不应新增（也不应抛 CONFLICT）');
  const target = after.find((account) => account.id === ten[0].id);
  assert.ok(target, '原账号必须还在');
  assert.equal(target.uid, 'uid-A', '已有非空 uid 不得被上游新 uid 覆盖');
  assert.equal(target.name, '老账号');
  assert.equal(target.checkinHour, 9);
  assert.equal(target.token, 'at-9');
  assert.equal(data.account.uid, 'uid-A', '出参也应是保留后的 uid');
});

// ============ 10. 账号上限 ============

test('账号上限：已有 10 个账号时新 uid 导入 -> CONFLICT，同 uid 更新不受限', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-new' } }),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'u-new' } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });
  const ten = Array.from({ length: 10 }, (_unused, index) => ({
    ...makeAccount(index + 1),
    uid: index === 0 ? 'u1' : '',
  }));
  await ctx.kv.putAccounts(ten);

  // 新 uid -> CONFLICT
  await rejectsWith(
    () => saveOAuthAccount(ctx, { token: 'at-new', uid: 'u-new' }),
    'CONFLICT',
    /最多 10 个账号/,
  );
  assert.equal((await ctx.kv.getAccounts()).length, 10);

  // 同 uid -> 允许更新，数量不变
  const updated = await saveOAuthAccount(ctx, { token: 'at-upd', uid: 'u1' });
  assert.equal(updated.id, 'acc_1');
  const after = await ctx.kv.getAccounts();
  assert.equal(after.length, 10);
  assert.equal(after[0].token, 'at-upd');
});

// ============ 11. 端点层 ============

test('端点层：两条路由无 Cookie -> 401', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => stateOk(), [OAUTH_TOKEN_PATH]: () => tokenPending() });
  const { ctx } = await createAuthedEnv({ fetch: mock });

  const start = await dispatch(ctx, '/api/oauth/start', { method: 'POST', body: {} });
  assert.equal(start.status, 401);
  assert.equal(start.body.error.code, 'UNAUTHORIZED');

  const poll = await dispatch(ctx, `/api/oauth/poll?state=${encodeURIComponent(STATE)}`);
  assert.equal(poll.status, 401);
  assert.equal(poll.body.error.code, 'UNAUTHORIZED');

  assert.equal(mock.count(), 0, '未鉴权不应打上游');
});

test('端点层：start 带跨站 Origin -> 403（写操作同源校验）', async () => {
  const mock = mockRoutes({ [OAUTH_STATE_PATH]: () => stateOk() });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  const res = await dispatch(ctx, '/api/oauth/start', {
    method: 'POST',
    body: {},
    cookie,
    origin: 'https://evil.example.com',
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
  assert.equal(mock.count(), 0);
});

test('端点层：poll 为 GET，不做同源校验（跨站 Origin 也 200）', async () => {
  const mock = mockRoutes({ [OAUTH_TOKEN_PATH]: () => tokenPending() });
  const { ctx, cookie } = await createAuthedEnv({ fetch: mock });

  const res = await dispatch(ctx, `/api/oauth/poll?state=${encodeURIComponent(STATE)}`, {
    cookie,
    origin: 'https://evil.example.com',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'pending');
});

// ============ 12. enterpriseId 生效 ============

test('enterpriseId：落库后上游请求带 x-enterprise-id / x-tenant-id，脱敏出参不含该字段', async () => {
  const mock = mockRoutes({});
  const { ctx } = makeCtx({ fetch: mock });

  const view = await saveOAuthAccount(ctx, {
    token: 'at-ent-token-1234',
    uid: 'u1',
    enterpriseId: 'ent-1',
    domain: 'd1',
  });

  const stored = (await ctx.kv.getAccounts())[0];
  assert.equal(stored.enterpriseId, 'ent-1');

  const headers = buildUpstreamHeaders(stored);
  assert.equal(headers['x-enterprise-id'], 'ent-1');
  assert.equal(headers['x-tenant-id'], 'ent-1');
  assert.equal(headers['x-user-id'], 'u1');
  assert.equal(headers['x-domain'], 'd1');

  assert.equal(view.enterpriseId, undefined, 'maskAccount 不得返回 enterpriseId');
  assert.equal(view.token, undefined);
  assert.doesNotMatch(JSON.stringify(view), /ent-1/);
});

// ============ 13. expiresAt 语义 ============

test('expiresAt：上游给秒级值 -> 落库为毫秒', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-1', expiresAt: 1700003600 } }),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'u1' } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });

  await pollWorkbuddyLogin(ctx, STATE);

  assert.equal((await ctx.kv.getAccounts())[0].expiresAt, 1700003600000);
});

test('expiresAt：上游只给 expiresIn -> 按 ctx.now() 推算', async () => {
  const mock = mockRoutes({
    [OAUTH_TOKEN_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'at-1', expiresIn: 600 } }),
    [OAUTH_ACCOUNT_PATH]: () => jsonRes({ code: 0, data: { uid: 'u1' } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });

  await pollWorkbuddyLogin(ctx, STATE);

  assert.equal((await ctx.kv.getAccounts())[0].expiresAt, T0 + 600000);
});

test('expiresAt：saveOAuthAccount 入参按毫秒语义原样落库（不再按秒放大）', async () => {
  // 说明：payload.expiresAt 约定为「已归一化毫秒」，因此 1700003600 会原样写入。
  // 秒 -> 毫秒的换算只在上游响应解析（resolveExpiresAt）里做一次，避免二次放大。
  const mock = mockRoutes({});
  const { ctx } = makeCtx({ fetch: mock });

  await saveOAuthAccount(ctx, { token: 'at-1', uid: 'u1', expiresAt: 1700003600 });

  assert.equal((await ctx.kv.getAccounts())[0].expiresAt, 1700003600);
});

// ============ 14. 续期集成 ============

test('续期集成：OAuth 落库账号 token 过期后自动 refresh 并回写新 token', async () => {
  /** 构造只读 payload 的 JWT。 */
  const makeJwt = (payload) => {
    const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    return `${enc({ alg: 'HS256' })}.${enc(payload)}.sig`;
  };
  // 已过期 1 小时
  const expiredToken = makeJwt({ exp: Math.floor((T0 - 3600_000) / 1000), sub: 'u1' });
  const mock = mockRoutes({
    [REFRESH_PATH]: () => jsonRes({ code: 0, data: { accessToken: 'fresh-token', refreshToken: 'fresh-rt', expiresIn: 3600 } }),
    [SUMMARY_PATH]: () => jsonRes({ code: 0, data: { Packages: [] } }),
    [PAID_PATH]: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
    [FREE_PATH]: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: createClock(T0) });

  const view = await saveOAuthAccount(ctx, { token: expiredToken, refreshToken: 'rt-oauth', uid: 'u1' });
  const credits = await svcAccountCredits(ctx, view.id);

  assert.equal(credits.accountId, view.id);
  assert.equal(mock.count(REFRESH_PATH), 1, '过期账号应触发一次续期');
  const billingTokens = mock.calls.filter((call) => call.path !== REFRESH_PATH).map((call) => call.token);
  assert.ok(
    billingTokens.every((token) => token === 'fresh-token'),
    `额度请求应使用新 token，实际：${billingTokens}`,
  );

  const stored = (await ctx.kv.getAccounts())[0];
  assert.equal(stored.token, 'fresh-token', '新 token 必须回写 KV');
  assert.equal(stored.refreshToken, 'fresh-rt');
  assert.equal(stored.uid, 'u1', '续期不得丢 uid');
});

// ============ 15. 前端静态检查（轻量） ============

test('前端：账号弹窗同时存在录入方式切换与两个面板', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['acc-mode-switch', 'acc-oauth-panel', 'acc-token-panel']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
});

test('前端：授权登录/保存录入固定在弹窗底部右侧，OAuth 面板内不再有主按钮', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const cancelAt = html.indexOf('id="btn-acc-cancel"');
  const startAt = html.indexOf('id="btn-acc-oauth-start"');
  const saveAt = html.indexOf('id="btn-acc-save"');
  assert.ok(cancelAt > 0 && startAt > cancelAt && saveAt > startAt, '底部顺序应为 取消 -> 授权登录 -> 保存录入');
  assert.ok(!html.slice(cancelAt, startAt).includes('</div>'), '「授权登录」必须与「取消」在同一操作栏');
  assert.ok(!html.slice(cancelAt, saveAt).includes('</div>'), '「保存录入」必须与「取消」在同一操作栏');
  assert.match(html, /<button id="btn-acc-oauth-start"[^>]*>授权登录<\/button>/, '主按钮文案应为「授权登录」');
  assert.match(html, /<button id="btn-acc-save"[^>]*>保存录入<\/button>/, '主按钮文案应为「保存录入」');

  // 主按钮已移到 footer：OAuth 面板里不得再出现（避免两个入口）
  const panel = html.slice(html.indexOf('id="acc-oauth-panel"'), html.indexOf('</section>', html.indexOf('id="acc-oauth-panel"')));
  assert.ok(!panel.includes('btn-acc-oauth-start'), 'OAuth 面板内不应再放「授权登录」按钮');

  // 两种模式的显隐必须成对切换
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("save.hidden = oauthOn"), 'Token 模式才显示保存录入');
  assert.ok(app.includes("start.hidden = !oauthOn"), 'OAuth 模式才显示授权登录');
});

test('前端：dlg-account 的 close 监听里调用 stopOauthPolling', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const marker = "$('#dlg-account').addEventListener('close'";
  const index = js.indexOf(marker);
  assert.ok(index >= 0, "app.js 应注册 #dlg-account 的 close 监听");
  const block = js.slice(index, index + 300);
  assert.match(block, /stopOauthPolling\(\)/, '关闭弹窗时必须停掉轮询，避免后台空转');
});
