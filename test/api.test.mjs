// test/api.test.mjs
// 覆盖：bootstrap / setup（含 SETUP_TOKEN）/ 登录鉴权 / 改密失效 / 账号 CRUD 与脱敏 /
//       手动签到与批量 run / 日志读写 / 设置校验 / 统一错误信封 / 同源校验 / 静态资源分流。
// 对应 AC-1 ~ AC-6、AC-12、AC-14(QA 侧只验证轮询接口零写)、AC-18。

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { CODE } from '../src/util.js';
import { createContext } from '../src/store.js';
import { runCheckin } from '../src/run.js';
import { createMemoryKv } from './helpers/memkv.mjs';
import {
  createAuthedEnv,
  createUpstreamMock,
  dailyOk,
  dispatch,
  jsonRes,
  loginSystem,
  makeAccount,
  makeCtx,
  PASSWORD,
  SITE_ORIGIN,
  STATUS_PATH,
  statusNotCheckedIn,
  setupSystem,
  T0,
} from './helpers/harness.mjs';

/** 允许出现的错误码集合（PRD §6.1）。 */
const ALLOWED_CODES = Object.keys(CODE);

/** 正常上游（全部签到成功）。 */
function okUpstream() {
  return createUpstreamMock((call) => (call.path === STATUS_PATH ? statusNotCheckedIn() : dailyOk(10, 8)));
}

/**
 * 走真实 worker.fetch 调用（每请求独立 ctx，与线上生命周期一致）。
 * @param {object} env
 * @param {string} path
 * @param {{method?:string, body?:*, cookie?:string, headers?:object}} [options]
 * @returns {Promise<{status:number, body:any, headers:Headers}>}
 */
async function workerCall(env, path, options = {}) {
  const headers = { origin: SITE_ORIGIN, ...(options.headers || {}) };
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.cookie) headers.cookie = options.cookie;
  const response = await worker.fetch(new Request(`${SITE_ORIGIN}${path}`, init), env);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

/**
 * 在指定 env 上完成 setup + login，返回会话 Cookie。
 * @param {object} env
 * @param {string} [password]
 * @param {string} [ip]
 * @returns {Promise<string>}
 */
async function workerLogin(env, password = PASSWORD, ip = '203.0.113.50') {
  await workerCall(env, '/api/setup', { method: 'POST', body: { password }, headers: { 'cf-connecting-ip': ip } });
  const login = await workerCall(env, '/api/login', {
    method: 'POST',
    body: { password },
    headers: { 'cf-connecting-ip': ip },
  });
  return /wb_session=[^;]+/.exec(login.headers.get('set-cookie') || '')[0];
}

/**
 * 断言失败信封形状：{ ok:false, error:{ code, message } }，且 code 在枚举内。
 * @param {object} res dispatch 结果
 * @param {string} expectedCode
 */
function assertErrorEnvelope(res, expectedCode) {
  assert.equal(res.body.ok, false, `必须是失败信封，实际 ${res.text}`);
  assert.equal(typeof res.body.error, 'object');
  assert.equal(res.body.error.code, expectedCode);
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(res.body.error.message.length > 0, 'message 不得为空');
  assert.ok(ALLOWED_CODES.includes(res.body.error.code), `错误码必须在枚举内：${res.body.error.code}`);
  assert.ok(Object.keys(res.body).every((key) => ['ok', 'error', 'detail'].includes(key)), '信封不得有额外字段');
}

// ===== bootstrap / setup =====

test('GET /api/bootstrap：未初始化 false，setup 后 true（AC-1）', async () => {
  const { ctx, kv } = makeCtx();

  const before = await dispatch(ctx, '/api/bootstrap');
  assert.equal(before.status, 200);
  assert.equal(before.body.ok, true);
  assert.equal(before.body.data.initialized, false);
  assert.equal(before.body.data.version, '1.0.0');
  assert.equal(before.body.data.setupTokenRequired, false);
  assert.equal(kv.writeCount(), 0, 'bootstrap 只读');

  const setup = await setupSystem(ctx);
  assert.equal(setup.status, 200);
  assert.deepEqual(setup.body.data, { initialized: true });

  const after = await dispatch(ctx, '/api/bootstrap');
  assert.equal(after.body.data.initialized, true);
});

test('POST /api/setup：6 位 400 / 129 位 400 / 成功 200 / 重复 409（AC-2、AC-3）', async () => {
  const { ctx, kv } = makeCtx();

  assertErrorEnvelope(await dispatch(ctx, '/api/setup', { method: 'POST', body: { password: '123456' } }), 'BAD_REQUEST');
  assertErrorEnvelope(
    await dispatch(ctx, '/api/setup', { method: 'POST', body: { password: 'a'.repeat(129) } }),
    'BAD_REQUEST',
  );
  assert.equal(kv.has('config:auth'), false, '两次被拒均不得写入 config:auth');

  assert.equal((await setupSystem(ctx, 'a'.repeat(128))).status, 200, '128 位是合法上界');

  const again = await dispatch(ctx, '/api/setup', { method: 'POST', body: { password: 'another-password' } });
  assertErrorEnvelope(again, 'CONFLICT');
  assert.equal(again.status, 409);

  const login = await loginSystem(ctx, 'a'.repeat(128));
  assert.equal(login.result.status, 200, '已初始化后原密码仍可登录');
});

test('SETUP_TOKEN：缺头 403 / 错值 403 / 对值 200', async () => {
  const setupToken = 'deploy-token-abc-123';
  const { ctx } = makeCtx({ env: { SETUP_TOKEN: setupToken } });

  const bootstrap = await dispatch(ctx, '/api/bootstrap');
  assert.equal(bootstrap.body.data.setupTokenRequired, true);

  const missing = await dispatch(ctx, '/api/setup', { method: 'POST', body: { password: PASSWORD } });
  assertErrorEnvelope(missing, 'FORBIDDEN');
  assert.equal(missing.status, 403);

  const wrong = await dispatch(ctx, '/api/setup', {
    method: 'POST',
    body: { password: PASSWORD },
    headers: { 'x-setup-token': 'wrong-token' },
  });
  assertErrorEnvelope(wrong, 'FORBIDDEN');

  const right = await dispatch(ctx, '/api/setup', {
    method: 'POST',
    body: { password: PASSWORD },
    headers: { 'x-setup-token': setupToken },
  });
  assert.equal(right.status, 200);
  assert.equal(right.body.data.initialized, true);
});

// ===== 鉴权 =====

test('未登录 GET /api/accounts → 401 UNAUTHORIZED；错 Cookie 同样 401（AC-5）', async () => {
  const { ctx, kv } = await createAuthedEnv();
  const writesBefore = kv.writeCount();

  const anonymous = await dispatch(ctx, '/api/accounts');
  assertErrorEnvelope(anonymous, 'UNAUTHORIZED');
  assert.equal(anonymous.status, 401);

  const badCookie = await dispatch(ctx, '/api/accounts', { cookie: 'wb_session=forged.token' });
  assertErrorEnvelope(badCookie, 'UNAUTHORIZED');
  assert.equal(badCookie.status, 401);

  assert.equal(kv.writeCount(), writesBefore, '鉴权失败的读接口不得写 KV');
});

test('登录成功下发 HttpOnly 会话 Cookie，且可访问 /api/accounts（AC-4）', async () => {
  const { ctx } = await createAuthedEnv();

  const login = await loginSystem(ctx);
  assert.equal(login.result.status, 200);
  assert.ok(login.setCookie.includes('HttpOnly'), `Cookie 必须 HttpOnly：${login.setCookie}`);
  assert.ok(login.setCookie.includes('Secure'));
  assert.ok(login.setCookie.includes('SameSite=Lax'));
  assert.ok(login.setCookie.includes('Max-Age=604800'));
  assert.ok(login.result.body.data.expiresAt);

  const session = await dispatch(ctx, '/api/session', { cookie: login.cookie });
  assert.equal(session.status, 200);
  assert.equal(session.body.data.authenticated, true);

  const accounts = await dispatch(ctx, '/api/accounts', { cookie: login.cookie });
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.body.data, []);
});

test('改密后旧 Cookie 立即失效（密码已变更），新密码可登录（AC 对应 P1-2）', async () => {
  const { ctx } = await createAuthedEnv();
  const old = await loginSystem(ctx);

  const changed = await dispatch(ctx, '/api/password', {
    method: 'POST',
    cookie: old.cookie,
    body: { oldPassword: PASSWORD, newPassword: 'NewPassw0rd!2025' },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.data, { updated: true });

  const stale = await dispatch(ctx, '/api/accounts', { cookie: old.cookie });
  assertErrorEnvelope(stale, 'UNAUTHORIZED');
  assert.equal(stale.status, 401);
  assert.match(stale.body.error.message, /密码已变更/, '改密后旧会话必须提示密码已变更');

  const relogin = await loginSystem(ctx, 'NewPassw0rd!2025');
  assert.equal(relogin.result.status, 200);
  assert.equal((await dispatch(ctx, '/api/accounts', { cookie: relogin.cookie })).status, 200);
});

test('修改密码：旧密码错误 401，新密码过短 400', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const wrongOld = await dispatch(ctx, '/api/password', {
    method: 'POST',
    cookie,
    body: { oldPassword: 'not-my-password', newPassword: 'NewPassw0rd!2025' },
  });
  assertErrorEnvelope(wrongOld, 'UNAUTHORIZED');

  const shortNew = await dispatch(ctx, '/api/password', {
    method: 'POST',
    cookie,
    body: { oldPassword: PASSWORD, newPassword: 'short' },
  });
  assertErrorEnvelope(shortNew, 'BAD_REQUEST');

  assert.equal((await dispatch(ctx, '/api/accounts', { cookie })).status, 200, '失败后旧会话仍有效');
});

test('登出下发清除 Cookie', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const out = await dispatch(ctx, '/api/logout', { method: 'POST', cookie, body: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.data, { loggedOut: true });
  assert.ok((out.headers.get('set-cookie') || '').includes('Max-Age=0'));
});

// ===== 账号 CRUD 与脱敏 =====

test('创建账号：token 归一化落 KV，列表只回脱敏值（AC-6）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv();

  const created = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: '主账号', token: 'Bearer xyz', uid: '123', remark: '备注' },
  });
  assert.equal(created.status, 200);
  const id = created.body.data.id;
  assert.ok(id.startsWith('acc_'), `id 形如 acc_<uuid>，实际 ${id}`);
  assert.equal(created.body.data.tokenMasked, '****', '短 token 全星号');
  assert.equal('token' in created.body.data, false, '出参绝不允许包含 token 字段');

  const stored = kv.json('accounts');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].token, 'xyz', 'Bearer 前缀必须被剥掉后落 KV');
  assert.equal(stored[0].enabled, true, 'enabled 默认 true');

  const long = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: '备用号', token: 'abcdefghijkl' },
  });
  assert.equal(long.body.data.tokenMasked, 'abcd****ijkl');

  const list = await dispatch(ctx, '/api/accounts', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2);
  for (const item of list.body.data) {
    assert.deepEqual(Object.keys(item).includes('token'), false, `列表项不得含 token 字段：${JSON.stringify(item)}`);
  }
  assert.equal(list.text.includes('abcdefghijkl'), false, '列表响应体不得出现 token 明文');
  assert.equal(list.text.includes('xyz'), false, '列表响应体不得出现 token 明文');
});

test('更新账号：省略 token 不改、token 空串不改、新 token 归一化', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv();
  const created = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: '主账号', token: 'abcdefghijkl' },
  });
  const id = created.body.data.id;

  const rename = await dispatch(ctx, `/api/accounts/${id}`, {
    method: 'PUT',
    cookie,
    body: { name: '改名后' },
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.data.name, '改名后');
  assert.equal(kv.json('accounts')[0].token, 'abcdefghijkl', '省略 token 必须保持原值');

  const emptyToken = await dispatch(ctx, `/api/accounts/${id}`, {
    method: 'PUT',
    cookie,
    body: { token: '' },
  });
  assert.equal(emptyToken.status, 200);
  assert.equal(kv.json('accounts')[0].token, 'abcdefghijkl', 'token 空串表示不修改');

  const newToken = await dispatch(ctx, `/api/accounts/${id}`, {
    method: 'PUT',
    cookie,
    body: { token: 'Bearer newtoken1234567890', enabled: false },
  });
  assert.equal(newToken.status, 200);
  assert.equal(kv.json('accounts')[0].token, 'newtoken1234567890');
  assert.equal(kv.json('accounts')[0].enabled, false);
  assert.equal(newToken.body.data.tokenMasked, 'newt****7890');

  const missing = await dispatch(ctx, '/api/accounts/acc_not_exist', { method: 'PUT', cookie, body: { name: 'x' } });
  assertErrorEnvelope(missing, 'NOT_FOUND');
  assert.equal(missing.status, 404);
});

test('账号字段校验：名称超 32 / 备注超 200 / token 为空均 400', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  assertErrorEnvelope(
    await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: 'n'.repeat(33), token: 'abcdefghijkl' } }),
    'BAD_REQUEST',
  );
  assertErrorEnvelope(
    await dispatch(ctx, '/api/accounts', {
      method: 'POST',
      cookie,
      body: { name: 'ok', token: 'abcdefghijkl', remark: 'r'.repeat(201) },
    }),
    'BAD_REQUEST',
  );
  assertErrorEnvelope(
    await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: 'ok', token: '  ' } }),
    'BAD_REQUEST',
  );
  assertErrorEnvelope(
    await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: '', token: 'abcdefghijkl' } }),
    'BAD_REQUEST',
  );
});

test('第 11 个账号返回 409 CONFLICT（上限 10）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv();

  for (let i = 1; i <= 10; i += 1) {
    const res = await dispatch(ctx, '/api/accounts', {
      method: 'POST',
      cookie,
      body: { name: `账号${i}`, token: `token-${i}-abcdefghijkl` },
    });
    assert.equal(res.status, 200, `第 ${i} 个账号应创建成功`);
  }
  assert.equal(kv.json('accounts').length, 10);

  const eleventh = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: '第十一个', token: 'token-11-abcdefghijkl' },
  });
  assertErrorEnvelope(eleventh, 'CONFLICT');
  assert.equal(eleventh.status, 409);
  assert.equal(kv.json('accounts').length, 10, '被拒后不得写入第 11 个账号');
});

test('删除账号：列表减少，删不存在的 404', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv();
  const created = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: '待删', token: 'abcdefghijkl' },
  });
  const id = created.body.data.id;

  const deleted = await dispatch(ctx, `/api/accounts/${id}`, { method: 'DELETE', cookie });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.data, { deleted: true });
  assert.equal(kv.json('accounts').length, 0);

  const list = await dispatch(ctx, '/api/accounts', { cookie });
  assert.equal(list.body.data.length, 0);

  const again = await dispatch(ctx, `/api/accounts/${id}`, { method: 'DELETE', cookie });
  assertErrorEnvelope(again, 'NOT_FOUND');
});

// ===== 签到接口 =====

test('POST /api/checkin/run 返回 {runId, summary}，且日志索引随即可查', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  kv.seed('accounts', [makeAccount(1), makeAccount(2)]);

  const run = await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} });
  assert.equal(run.status, 200);
  assert.match(run.body.data.runId, /^run_/);
  assert.equal(run.body.data.summary.total, 2);
  assert.equal(run.body.data.summary.success, 2);
  assert.equal(run.body.data.summary.kvWriteCount, 4);
  assert.equal(run.body.data.flushError, null);

  const logs = await dispatch(ctx, '/api/logs', { cookie });
  assert.equal(logs.body.data.length, 1);
  assert.equal(logs.body.data[0].runId, run.body.data.runId);
});

test('POST /api/checkin/run：accountIds 类型非法 400，不存在 id 记 failed 不报错', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  kv.seed('accounts', [makeAccount(1)]);

  assertErrorEnvelope(
    await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: { accountIds: 'acc_1' } }),
    'BAD_REQUEST',
  );
  assertErrorEnvelope(
    await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: { accountIds: [1] } }),
    'BAD_REQUEST',
  );

  const run = await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: { accountIds: ['acc_ghost'] } });
  assert.equal(run.status, 200);
  assert.equal(run.body.data.summary.failed, 1);
});

test('POST /api/accounts/:id/checkin 返回 CheckinResult（checked_in / already_checked_in）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  const account = makeAccount(1);
  kv.seed('accounts', [account]);

  const res = await dispatch(ctx, `/api/accounts/${account.id}/checkin`, { method: 'POST', cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.result, 'checked_in');
  assert.equal(res.body.data.accountId, account.id);
  assert.equal(res.body.data.credit, 10);
  assert.equal(res.body.data.streakDays, 8);
  assert.match(res.body.data.runId, /^run_/);
  assert.equal(res.text.includes(account.token), false, '签到结果不得泄漏 token');

  const notFound = await dispatch(ctx, '/api/accounts/acc_ghost/checkin', { method: 'POST', cookie, body: {} });
  assertErrorEnvelope(notFound, 'NOT_FOUND');
});

test('单账号签到 401：HTTP 200 + failed + tokenInvalid（AC-9）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({
    fetch: createUpstreamMock(() => jsonRes({ code: 401, msg: 'expired' }, 401)),
  });
  const account = makeAccount(1);
  kv.seed('accounts', [account]);

  const res = await dispatch(ctx, `/api/accounts/${account.id}/checkin`, { method: 'POST', cookie, body: {} });
  assert.equal(res.status, 200, 'token 失效不是上游故障，必须 200');
  assert.equal(res.body.data.result, 'failed');
  assert.equal(res.body.data.tokenInvalid, true);
  assert.equal(res.body.data.httpStatus, 401);
});

test('单账号签到 500：502 UPSTREAM_ERROR 且日志仍落盘（已批准的偏差）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({
    fetch: createUpstreamMock(() => jsonRes({ code: 500, msg: 'boom' }, 500)),
  });
  const account = makeAccount(1);
  kv.seed('accounts', [account]);

  const res = await dispatch(ctx, `/api/accounts/${account.id}/checkin`, { method: 'POST', cookie, body: {} });
  assertErrorEnvelope(res, 'UPSTREAM_ERROR');
  assert.equal(res.status, 502);

  const index = kv.json('log:index');
  assert.equal(index.length, 1, '即使返回 502，run 明细仍必须落盘用于诊断');
  assert.equal(index[0].failed, 1);
});

// ===== 日志接口 =====

test('GET /api/logs/:runId：不在索引 → 404；命中 → 返回含 entries 的明细', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  kv.seed('accounts', [makeAccount(1)]);

  const missing = await dispatch(ctx, '/api/logs/run_not_in_index', { cookie });
  assertErrorEnvelope(missing, 'NOT_FOUND');
  assert.equal(missing.status, 404);

  const run = await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} });
  const detail = await dispatch(ctx, `/api/logs/${run.body.data.runId}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.runId, run.body.data.runId);
  assert.equal(detail.body.data.entries.length, 1);
  assert.deepEqual(Object.keys(detail.body.data.entries[0]).sort(), [
    'accountId', 'accountName', 'code', 'credit', 'durationMs', 'httpStatus',
    'message', 'result', 'streakDays', 'tokenInvalid',
  ].sort(), 'LogEntry 必须恰好是 ARCHITECTURE §4.2 的 10 个字段');
});

test('GET /api/logs?limit=N 生效；DELETE /api/logs 返回 deleted 且索引清空', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  kv.seed('accounts', [makeAccount(1)]);

  for (let i = 0; i < 3; i += 1) {
    await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} });
  }
  const all = await dispatch(ctx, '/api/logs', { cookie });
  assert.equal(all.body.data.length, 3);

  const limited = await dispatch(ctx, '/api/logs?limit=2', { cookie });
  assert.equal(limited.body.data.length, 2);

  const cleared = await dispatch(ctx, '/api/logs', { method: 'DELETE', cookie });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data, { deleted: 3 });
  assert.deepEqual(kv.json('log:index'), []);
  assert.equal(kv.keys().filter((key) => key.startsWith('log:run:')).length, 0, '明细键必须一并删除');
});

// ===== 设置 =====

test('PUT /api/settings：4 → 400、5 → 200、101 → 400', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  assertErrorEnvelope(
    await dispatch(ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 4 } }),
    'BAD_REQUEST',
  );
  assertErrorEnvelope(
    await dispatch(ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 101 } }),
    'BAD_REQUEST',
  );
  assertErrorEnvelope(
    await dispatch(ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 5.5 } }),
    'BAD_REQUEST',
  );

  const ok5 = await dispatch(ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 5 } });
  assert.equal(ok5.status, 200);
  assert.equal(ok5.body.data.retentionRuns, 5);
  // 签到时间已改为每账号属性，settings 里只剩日志保留条数
  assert.equal('checkinHour' in ok5.body.data, false, '全局签到时间必须已移除');
});

test('GET /api/settings 与轮询接口零 KV 写（AC-14 的接口侧证据）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  kv.seed('accounts', [makeAccount(1)]);
  await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} });

  kv.resetEvents();
  for (let i = 0; i < 10; i += 1) {
    await dispatch(ctx, '/api/logs', { cookie });
    await dispatch(ctx, '/api/settings', { cookie });
    await dispatch(ctx, '/api/accounts', { cookie });
    await dispatch(ctx, '/api/mcp-key', { cookie });
  }
  assert.equal(kv.writeCount(), 0, '轮询类 GET 接口必须零写');
});

// ===== MCP Key 面板接口 =====

test('POST /api/mcp-key 明文仅出现一次，GET 只回 prefix', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const empty = await dispatch(ctx, '/api/mcp-key', { cookie });
  assert.deepEqual(empty.body.data, { exists: false });

  const created = await dispatch(ctx, '/api/mcp-key', { method: 'POST', cookie, body: {} });
  assert.equal(created.status, 200);
  assert.ok(created.body.data.key.startsWith('sk-mcp_'));
  assert.equal(created.body.data.prefix, created.body.data.key.slice(0, 12));

  const fetched = await dispatch(ctx, '/api/mcp-key', { cookie });
  assert.equal(fetched.body.data.exists, true);
  assert.equal(fetched.body.data.prefix, created.body.data.prefix);
  assert.equal('key' in fetched.body.data, false, '明文 Key 不得再取回');
  assert.equal(fetched.text.includes(created.body.data.key), false);
});

// ===== 统一信封 / 同源 / 静态资源 =====

test('响应头带 Cache-Control: no-store（成功与失败都带）', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const okRes = await dispatch(ctx, '/api/accounts', { cookie });
  assert.equal(okRes.headers.get('cache-control'), 'no-store');

  const errRes = await dispatch(ctx, '/api/accounts');
  assert.equal(errRes.headers.get('cache-control'), 'no-store');
  assert.match(errRes.headers.get('content-type') || '', /application\/json/);
});

test('GET/POST /api/typo 返回 JSON 错误信封而不是 HTML（Worker 层）', async () => {
  const kv = createMemoryKv();
  const env = { WB_KV: kv };

  const get = await worker.fetch(new Request(`${SITE_ORIGIN}/api/typo`), env);
  assert.equal(get.status, 404);
  assert.match(get.headers.get('content-type') || '', /application\/json/);
  const getBody = await get.json();
  assert.equal(getBody.ok, false);
  assert.equal(getBody.error.code, 'NOT_FOUND');
  assert.equal(ALLOWED_CODES.includes(getBody.error.code), true);

  const post = await worker.fetch(
    new Request(`${SITE_ORIGIN}/api/typo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_ORIGIN },
      body: '{}',
    }),
    env,
  );
  assert.equal(post.status, 404);
  assert.match(post.headers.get('content-type') || '', /application\/json/);

  const options = await worker.fetch(new Request(`${SITE_ORIGIN}/api/accounts`, { method: 'OPTIONS' }), env);
  assert.equal(options.status, 404);
  assert.match(options.headers.get('content-type') || '', /application\/json/);
});

test('跨站 Origin 的写请求返回 403 FORBIDDEN（Worker 层）', async () => {
  const kv = createMemoryKv();
  const env = { WB_KV: kv };

  const crossSite = await worker.fetch(
    new Request(`${SITE_ORIGIN}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
    env,
  );
  assert.equal(crossSite.status, 403);
  const body = await crossSite.json();
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(kv.has('config:auth'), false, '跨站请求不得产生任何写入');

  const nullOrigin = await worker.fetch(
    new Request(`${SITE_ORIGIN}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
    env,
  );
  assert.equal(nullOrigin.status, 403, 'Origin: null 必须视为跨站');
});

test('静态资源分流：命中直出、未命中回 JSON 404', async () => {
  const html = '<!doctype html><title>WorkBuddy Daily</title>';
  const env = {
    WB_KV: createMemoryKv(),
    ASSETS: {
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === '/' || pathname === '/index.html') {
          return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response('not found', { status: 404 });
      },
    },
  };

  const root = await worker.fetch(new Request(`${SITE_ORIGIN}/`), env);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') || '', /text\/html/);
  assert.equal(await root.text(), html);

  const missing = await worker.fetch(new Request(`${SITE_ORIGIN}/nope.js`), env);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') || '', /application\/json/);

  const noAssets = await worker.fetch(new Request(`${SITE_ORIGIN}/`), { WB_KV: createMemoryKv() });
  assert.equal(noAssets.status, 404);
  assert.equal((await noAssets.json()).error.code, 'NOT_FOUND');
});

test('写接口必须 application/json：非 JSON content-type 返回 400', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const plain = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: 'x', token: 'abcdefghijkl' },
    headers: { 'content-type': 'text/plain' },
  });
  assertErrorEnvelope(plain, 'BAD_REQUEST');
  assert.equal(plain.status, 400);

  const brokenJson = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: '{not valid json',
  });
  assertErrorEnvelope(brokenJson, 'BAD_REQUEST');
});

// ===== F3 回归：调低 retentionRuns 时立即淘汰，后续 run 写入 ≤5 =====

test('F3 回归：PUT retentionRuns 后立即淘汰到 5 条，随后 run 写入 ≤5', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv({ fetch: okUpstream() });
  kv.seed('accounts', [makeAccount(1)]);

  const runIds = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} });
    assert.equal(res.status, 200);
    runIds.push(res.body.data.runId);
  }
  assert.equal((await dispatch(ctx, '/api/logs', { cookie })).body.data.length, 8);

  const put = await dispatch(ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 5 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.retentionRuns, 5);
  assert.equal(put.body.data.evicted, 3, 'PUT 响应应告知本次清理条数');
  assert.equal(put.body.data.evictFailed, false);

  // 立刻生效，不用等下一次 run
  const logs = await dispatch(ctx, '/api/logs', { cookie });
  assert.equal(logs.body.data.length, 5, 'PUT 之后必须立刻只剩 5 条');
  assert.equal(logs.body.data[0].runId, runIds[7], '最新的 run 仍在首位');

  for (const oldRunId of runIds.slice(0, 3)) {
    assert.equal(kv.has(`log:run:${oldRunId}`), false, `被淘汰的明细键必须删除：${oldRunId}`);
    const gone = await dispatch(ctx, `/api/logs/${oldRunId}`, { cookie });
    assert.equal(gone.status, 404, `被淘汰的 run 取明细必须 404：${oldRunId}`);
  }
  assert.equal(kv.keys().filter((key) => key.startsWith('log:run:')).length, 5, '不得残留孤儿明细键');

  // 紧接着一次 run：写入必须 ≤5（不允许再出现 4 + 多条淘汰）
  const before = ctx.writes();
  const next = await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} });
  const delta = ctx.writes() - before;

  assert.equal(next.status, 200);
  assert.equal(delta, 5, `稳态 run 的写入必须是 4 + 1 次淘汰 = 5，实际 ${delta}`);
  assert.equal(next.body.data.summary.kvWriteCount, delta, 'kvWriteCount 必须与实际写入一致');
  assert.equal((await dispatch(ctx, '/api/logs', { cookie })).body.data.length, 5, '稳态后索引仍是 5 条');
  assert.equal(kv.json('lock:run'), null);
});

test('F3 补充：GET /api/settings 形状不变（不泄漏 PUT 独有的 evicted 字段）', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const got = await dispatch(ctx, '/api/settings', { cookie });
  assert.deepEqual(Object.keys(got.body.data).sort(), ['retentionRuns']);
  assert.equal('evicted' in got.body.data, false);
  assert.equal('evictFailed' in got.body.data, false);
});

test('F3 补充：淘汰删除失败时 PUT 仍 200，evictFailed=true 且索引保持原样（不留半截状态）', async () => {
  const base = createMemoryKv();
  const flaky = {
    get: (key) => base.get(key),
    put: (key, value, options) => base.put(key, value, options),
    delete: async (key) => {
      if (String(key).startsWith('log:run:')) throw new Error('kv delete boom');
      return base.delete(key);
    },
  };
  const { ctx } = makeCtx({ kv: flaky, fetch: okUpstream() });
  assert.equal((await setupSystem(ctx)).status, 200);
  const { cookie } = await loginSystem(ctx);
  base.seed('accounts', [makeAccount(1)]);

  for (let i = 0; i < 8; i += 1) {
    assert.equal((await dispatch(ctx, '/api/checkin/run', { method: 'POST', cookie, body: {} })).status, 200);
  }

  const put = await dispatch(ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 5 } });
  assert.equal(put.status, 200, '淘汰失败不应让设置接口整体失败（设置本身已保存）');
  assert.equal(put.body.data.evictFailed, true);
  assert.equal(put.body.data.evicted, 0);
  assert.equal(put.body.data.retentionRuns, 5);
  assert.equal(base.json('log:index').length, 8, '明细删除失败时索引必须保持原样，绝不能出现「索引指向已删明细」');
  assert.equal(base.keys().filter((key) => key.startsWith('log:run:')).length, 8, '明细仍在，与索引一致');
});

// ===== F4 回归：run 期间调低 retentionRuns 不得「复活」已淘汰条目（确定性时序，不用随机 sleep）=====

test('F4 回归：run 收尾重读索引，不复活已淘汰 run、无孤儿指针、kvWriteCount 与实际一致', async () => {
  const kv = createMemoryKv();

  // 用「显式闸门」把 run 精确卡在「已进入上游循环、尚未收尾」的窗口：
  // 首个上游请求挂起并通知测试，PUT 完成后再放行。全程无 sleep、无随机时序。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let paused = false;

  const base = createUpstreamMock((call) => (call.path === STATUS_PATH ? statusNotCheckedIn() : dailyOk(10, 6)));
  const gatedFetch = async (url, init) => {
    if (!paused) {
      paused = true;
      entered();
      await gate;
    }
    return base(url, init);
  };

  // run 侧 ctx 与 PUT 侧 ctx 共享同一个 memkv，但每个 ctx 有自己的 clock（= 独立的 isolate 写计数器），
  // 这样才能把「run 自己的写入」与「并发 PUT 的写入」分开计量。
  const runSide = makeCtx({ kv, fetch: gatedFetch });
  assert.equal((await setupSystem(runSide.ctx)).status, 200);
  const { cookie } = await loginSystem(runSide.ctx);
  kv.seed('accounts', [makeAccount(1)]);

  // 预置 8 条历史 run（索引 + 明细）
  const iso = new Date(T0).toISOString();
  const oldRuns = Array.from({ length: 8 }, (_, i) => ({
    runId: `run_old${i}`,
    startedAt: iso,
    finishedAt: iso,
    trigger: 'cron',
    total: 1,
    success: 1,
    failed: 0,
    skipped: 0,
    durationMs: 1,
    truncated: false,
    kvWriteCount: 4,
  }));
  kv.seed('log:index', oldRuns);
  for (const old of oldRuns) kv.seed(`log:run:${old.runId}`, { ...old, entries: [] });

  const writesBefore = runSide.ctx.writes();
  const runPromise = runCheckin(runSide.ctx, { trigger: 'cron' });
  await enteredPromise; // 此刻 run 已进入上游调用循环，尚未收尾

  // 证明「PUT 确实发生在 run 执行期间」：run 已持锁，且索引还是 PUT 前的 8 条。
  // 若这一步不成立，本用例就不算命中并发窗口（会退化成普通时序）。
  const inFlight = kv.json('lock:run');
  assert.equal(inFlight && inFlight.holder, 'cron', '此时 run 必须已持有锁，证明后续 PUT 发生在 run 执行期间');
  assert.equal(kv.json('log:index').length, 8, 'PUT 之前索引仍是 8 条');

  // 真实的 PUT 语义：先写 settings，再裁索引 + 删明细（不是只裁索引）
  const putSide = makeCtx({ kv, fetch: gatedFetch });
  const put = await dispatch(putSide.ctx, '/api/settings', { method: 'PUT', cookie, body: { retentionRuns: 5 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.evicted, 3, 'PUT 应淘汰 3 条（8 → 5）');
  assert.equal(kv.json('log:index').length, 5, 'PUT 后索引应为 5 条');

  release();
  const result = await runPromise;

  // ① 收尾后索引长度 == 新 retention
  const index = kv.json('log:index');
  assert.equal(index.length, 5, `收尾后索引必须等于新 retention(5)，实际 ${index.length}`);
  assert.equal(index[0].runId, result.runId, '最新 run 必须在首位');

  // ② 索引里每一个 runId 都能读到明细（不允许指向 404 的孤儿指针）
  const orphans = index.filter((item) => !kv.has(`log:run:${item.runId}`)).map((item) => item.runId);
  assert.deepEqual(orphans, [], `索引中不得出现指向已删明细的条目：${orphans.join(', ')}`);
  for (const item of index) {
    const detail = await dispatch(runSide.ctx, `/api/logs/${item.runId}`, { cookie });
    assert.equal(detail.status, 200, `索引中的 ${item.runId} 必须能取到明细`);
    assert.equal(detail.body.data.runId, item.runId);
  }
  assert.equal(
    kv.keys().filter((key) => key.startsWith('log:run:')).length,
    5,
    '明细键数必须与索引条数一致（既无孤儿指针，也无多余残留）',
  );

  // ③ 被 PUT 淘汰的旧 run 不得复活
  for (const evicted of oldRuns.slice(5)) {
    assert.equal(index.some((item) => item.runId === evicted.runId), false, `${evicted.runId} 不得被拼回索引`);
    assert.equal(kv.has(`log:run:${evicted.runId}`), false, `${evicted.runId} 的明细不应重新出现`);
  }

  // ④ kvWriteCount 必须等于 run 自身的真实写入次数（不含并发 PUT 的写入）
  const runWrites = runSide.ctx.writes() - writesBefore;
  assert.equal(
    result.summary.kvWriteCount,
    runWrites,
    `summary.kvWriteCount(${result.summary.kvWriteCount}) 必须等于 run 实际写入(${runWrites})`,
  );
  assert.equal(runWrites, 5, '锁 1 + 明细 1 + 索引 1 + 淘汰 1 + 解锁 1 = 5');
  assert.equal(kv.json('lock:run'), null, '锁必须释放');
});

/**
 * 额度接口 mock：三个 billing/meter 端点。
 * @param {{summary?:object, paid?:object[], free?:object[]}} data
 * @returns {Function}
 */
function creditsUpstream(data) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('get-user-resource-summary')) return jsonRes({ code: 0, data: data.summary || {} });
    if (path.endsWith('get-user-resource-paid-packages')) {
      const items = data.paid || [];
      return jsonRes({ code: 0, data: { Accounts: items, TotalCount: items.length } });
    }
    if (path.endsWith('get-user-resource-free-packages')) {
      const items = data.free || [];
      return jsonRes({ code: 0, data: { Accounts: items, TotalCount: items.length } });
    }
    throw new Error(`未预期的额度端点 ${path}`);
  };
}

test('积分配额端点：需登录、返回分组、零 KV 写、token 失效返回 502 而非 401', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  await ctx.kv.putAccounts([makeAccount(1, { token: 'tok-credits-abcdefghijkl' })]);

  const unauth = await dispatch(ctx, '/api/accounts/acc_1/credits');
  assertErrorEnvelope(unauth, 'UNAUTHORIZED');

  ctx.fetch = creditsUpstream({
    summary: { Packages: [{ CycleRemainCapacity: '400' }] },
    paid: [{
      PackageCode: 'TCACA_code_002_AkiJS3ZHF5',
      Status: 0,
      CycleCapacitySizePrecise: '500',
      CycleCapacityRemainPrecise: '400',
      CycleEndTime: new Date(T0 + 86400000).toISOString(),
    }],
    free: [],
  });
  const writesBefore = ctx.writes();
  const okRes = await dispatch(ctx, '/api/accounts/acc_1/credits', { cookie });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.data.accountId, 'acc_1');
  assert.equal(okRes.body.data.totalLeft, 400);
  assert.equal(okRes.body.data.groups[0].key, 'planBase');
  assert.equal(ctx.writes(), writesBefore, '额度查询是只读的，不得写 KV');

  ctx.fetch = async (url) => {
    if (String(url).endsWith('get-user-resource-summary')) return jsonRes({ message: 'unauthorized' }, 401);
    return jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } });
  };
  const badRes = await dispatch(ctx, '/api/accounts/acc_1/credits', { cookie });
  assertErrorEnvelope(badRes, 'UPSTREAM_ERROR');
  assert.equal(badRes.status, 502, '上游 token 失效必须 502（401 会让前端误判会话过期）');
  assert.equal(badRes.body.detail.tokenInvalid, true);
});
