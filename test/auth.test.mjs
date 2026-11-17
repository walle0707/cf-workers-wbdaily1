// test/auth.test.mjs
// 覆盖：密码策略（setup 层）/ PBKDF2 哈希与校验 / 会话签发与 4 类失效原因 /
//        Cookie 属性 / 内存限流器 / 登录 429 与 Retry-After（含锁定期内正确密码）。
// 对应 AC-2、AC-4、AC-18，ARCHITECTURE §8 / §9.9。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClearCookie,
  buildSessionCookie,
  createLimiter,
  hashPassword,
  parseCookies,
  signSession,
  verifyPassword,
  verifySession,
  SESSION_TTL_SEC,
} from '../src/auth.js';
import {
  createClock,
  dispatch,
  loginSystem,
  makeCtx,
  PASSWORD,
  setupSystem,
} from './helpers/harness.mjs';

// ===== 密码策略（setup 层）=====

test('setup 拒绝长度不足 8 位的密码并保留未初始化状态', async () => {
  const { ctx, kv } = makeCtx();

  const six = await dispatch(ctx, '/api/setup', { method: 'POST', body: { password: '123456' } });
  assert.equal(six.status, 400);
  assert.equal(six.body.ok, false);
  assert.equal(six.body.error.code, 'BAD_REQUEST');
  assert.match(six.body.error.message, /至少 8 位/);

  const blank = await dispatch(ctx, '/api/setup', { method: 'POST', body: { password: '        ' } });
  assert.equal(blank.status, 400, '纯空白密码 trim 后长度为 0，必须被拒');

  const missing = await dispatch(ctx, '/api/setup', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);

  assert.equal(kv.has('config:auth'), false, '被拒的 setup 不得写入 config:auth');
});

// ===== PBKDF2 哈希与校验 =====

test('hashPassword / verifyPassword 正反例', async () => {
  const record = await hashPassword(PASSWORD, { iterations: 12000 });

  assert.equal(record.iterations, 12000);
  assert.equal(typeof record.passwordHash, 'string');
  assert.equal(typeof record.salt, 'string');
  assert.ok(record.passwordHash.length > 0);
  assert.equal(Buffer.from(record.salt, 'base64').length, 16, 'salt 必须是 16 字节');

  assert.equal(await verifyPassword(PASSWORD, record), true);
  assert.equal(await verifyPassword('wrong-password', record), false);
  assert.equal(await verifyPassword('', record), false);
  assert.equal(await verifyPassword(PASSWORD + ' ', record), false, '不得做 trim 容错');
});

test('verifyPassword 对畸形记录一律返回 false（不抛异常）', async () => {
  assert.equal(await verifyPassword(PASSWORD, null), false);
  assert.equal(await verifyPassword(PASSWORD, {}), false);
  assert.equal(await verifyPassword(PASSWORD, { passwordHash: 'abc' }), false);
  assert.equal(await verifyPassword(PASSWORD, { passwordHash: '', salt: '' }), false);
  assert.equal(await verifyPassword(PASSWORD, { passwordHash: 'abc', salt: '!!!' }), false);
});

test('同一密码两次哈希产生不同 salt 与不同摘要', async () => {
  const [a, b] = await Promise.all([
    hashPassword(PASSWORD, { iterations: 10000 }),
    hashPassword(PASSWORD, { iterations: 10000 }),
  ]);

  assert.notEqual(a.salt, b.salt, '每次哈希必须重新生成随机 salt');
  assert.notEqual(a.passwordHash, b.passwordHash, 'salt 不同则摘要必然不同');
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
});

test('迭代数被 clamp 到 [10000, 200000]', async () => {
  const low = await hashPassword('12345678', { iterations: 1 });
  assert.equal(low.iterations, 10000);
  const high = await hashPassword('12345678', { iterations: 999999 });
  assert.equal(high.iterations, 200000);
});

// ===== 会话签发与验签（4 种失败原因）=====

test('会话签发后可通过验签且 exp 为 ttl 之后', async () => {
  const clock = createClock();
  const secret = 'unit-test-secret';
  const token = await signSession({ secret, sessionVersion: 1, ttlSec: SESSION_TTL_SEC, now: clock() });

  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'token 形如 payload.sig（base64url）');

  const result = await verifySession(token, { secret, sessionVersion: 1, now: clock() });
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(result.exp, Math.floor(clock() / 1000) + SESSION_TTL_SEC);
  assert.equal(SESSION_TTL_SEC, 604800, '会话有效期必须是 7 天');
});

test('会话失效原因 1/4：malformed', async () => {
  const secret = 'unit-test-secret';
  const now = createClock()();

  for (const bad of ['', 'not-a-token', 'onlyonepart', 'a.b.c', '..', null, undefined, 123]) {
    const result = await verifySession(bad, { secret, sessionVersion: 1, now });
    assert.equal(result.valid, false, `token=${String(bad)} 应判为无效`);
    assert.equal(result.reason, 'malformed', `token=${String(bad)} 应判为 malformed`);
  }
});

test('会话失效原因 2/4：bad_sig（签名或 payload 被篡改）', async () => {
  const clock = createClock();
  const secret = 'unit-test-secret';
  const token = await signSession({ secret, sessionVersion: 1, now: clock() });
  const [payload, signature] = token.split('.');

  const flippedSig = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  const tamperedSig = await verifySession(`${payload}.${flippedSig}`, { secret, sessionVersion: 1, now: clock() });
  assert.equal(tamperedSig.valid, false);
  assert.equal(tamperedSig.reason, 'bad_sig');

  // 换成另一个合法 payload（未来 exp）但保留旧签名 -> 必须判 bad_sig，而不是 expired/version
  const forgedPayload = Buffer.from(JSON.stringify({ exp: Math.floor(clock() / 1000) + 99999, ver: 1 }))
    .toString('base64url');
  const tamperedPayload = await verifySession(`${forgedPayload}.${signature}`, {
    secret, sessionVersion: 1, now: clock(),
  });
  assert.equal(tamperedPayload.valid, false);
  assert.equal(tamperedPayload.reason, 'bad_sig');

  // 换 secret 验签同样 bad_sig
  const wrongSecret = await verifySession(token, { secret: 'another-secret', sessionVersion: 1, now: clock() });
  assert.equal(wrongSecret.reason, 'bad_sig');
});

test('会话失效原因 3/4：expired', async () => {
  const clock = createClock();
  const secret = 'unit-test-secret';
  const token = await signSession({ secret, sessionVersion: 1, ttlSec: 60, now: clock() });

  const stillValid = await verifySession(token, { secret, sessionVersion: 1, now: clock.advance(59000) });
  assert.equal(stillValid.valid, true);

  const expired = await verifySession(token, { secret, sessionVersion: 1, now: clock.advance(2000) });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.exp, stillValid.exp, '过期时仍返回同一个 exp 供前端判断');
});

test('会话失效原因 4/4：version（改密后旧 Cookie 失效）', async () => {
  const clock = createClock();
  const secret = 'unit-test-secret';
  const token = await signSession({ secret, sessionVersion: 1, now: clock() });

  const bumped = await verifySession(token, { secret, sessionVersion: 2, now: clock() });
  assert.equal(bumped.valid, false);
  assert.equal(bumped.reason, 'version');
  assert.ok(bumped.exp !== null);

  // 缺省 sessionVersion 视为 1，与 signSession 默认一致
  const defaulted = await verifySession(token, { secret, now: clock() });
  assert.equal(defaulted.valid, true);
});

// ===== Cookie 属性 =====

test('会话 Cookie 含 HttpOnly / Secure / SameSite=Lax / Path=/ / Max-Age=604800', () => {
  const cookie = buildSessionCookie('payload.signature');
  assert.ok(cookie.startsWith('wb_session=payload.signature'), 'Cookie 名固定 wb_session');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) {
    assert.ok(cookie.includes(attr), `Cookie 缺少属性 ${attr}：${cookie}`);
  }
  assert.equal(parseCookies(cookie).wb_session, 'payload.signature');
});

test('清除会话的 Cookie 把 Max-Age 置 0 且仍带安全属性', () => {
  const cookie = buildClearCookie();
  assert.ok(cookie.startsWith('wb_session=;'));
  assert.ok(cookie.includes('Max-Age=0'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('Secure'));
  assert.ok(cookie.includes('SameSite=Lax'));
});

test('parseCookies 容错：无值 / 多值 / 非法百分号编码', () => {
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('flag; c=3'), { flag: '', c: '3' });
  assert.deepEqual(parseCookies('bad=%E0%A4%A'), { bad: '%E0%A4%A' }, 'decode 失败保留原文而不是抛错');
});

// ===== 内存限流器 =====

test('限流器：第 6 次拒绝并给出 retryAfterSec，冷却后恢复', () => {
  const clock = createClock();
  const limiter = createLimiter({ now: clock });
  const ip = '198.51.100.7';

  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check(ip).allowed, true, `第 ${i + 1} 次应放行`);
    limiter.fail(ip);
  }

  const blocked = limiter.check(ip);
  assert.equal(blocked.allowed, false, '连续 5 次失败后第 6 次必须被拒');
  assert.ok(blocked.retryAfterSec >= 30, `退避至少 30s，实际 ${blocked.retryAfterSec}`);

  assert.equal(limiter.check('203.0.113.9').allowed, true, '限流按 IP 隔离');

  clock.advance(31000);
  assert.equal(limiter.check(ip).allowed, true, '冷却结束后恢复');

  limiter.reset(ip);
  assert.equal(limiter.check(ip).remaining, 5, 'reset 后失败计数清零');
});

test('限流退避指数增长并封顶 15 分钟', () => {
  const clock = createClock();
  const limiter = createLimiter({ now: clock, baseMs: 30000, maxMs: 900000 });
  const ip = '198.51.100.8';

  for (let i = 0; i < 5; i += 1) limiter.fail(ip);
  const first = limiter.check(ip).retryAfterSec;
  assert.ok(first >= 30 && first <= 31, `首次退避 30s，实际 ${first}`);

  for (let i = 0; i < 6; i += 1) limiter.fail(ip);
  const capped = limiter.check(ip).retryAfterSec;
  assert.equal(capped, 900, `退避封顶 15 分钟，实际 ${capped}`);
});

// ===== API 层：登录 429 + Retry-After =====

test('登录失败 5 次后第 6 次返回 429 且带 Retry-After（正确密码同样被拒）', async () => {
  const { ctx } = makeCtx();
  await setupSystem(ctx);

  for (let i = 1; i <= 5; i += 1) {
    const failed = await loginSystem(ctx, 'wrong-password', { ip: '192.0.2.10' });
    assert.equal(failed.result.status, 401, `第 ${i} 次错误密码应 401`);
    assert.equal(failed.result.body.error.code, 'UNAUTHORIZED');
    assert.equal(failed.result.body.detail.remaining, 5 - i);
  }

  const blocked = await loginSystem(ctx, PASSWORD, { ip: '192.0.2.10' });
  assert.equal(blocked.result.status, 429, '锁定期内即使密码正确也必须 429');
  assert.equal(blocked.result.body.error.code, 'RATE_LIMITED');
  const retryAfter = blocked.result.headers.get('retry-after');
  assert.ok(retryAfter !== null, '429 必须携带 Retry-After 响应头');
  assert.ok(Number(retryAfter) > 0, `Retry-After 必须为正整数秒，实际 ${retryAfter}`);
  assert.equal(blocked.setCookie, '', '被限流时不得下发会话 Cookie');

  const otherIp = await loginSystem(ctx, PASSWORD, { ip: '192.0.2.11' });
  assert.equal(otherIp.result.status, 200, '其它 IP 不受影响');
});

test('登录成功会清空失败计数', async () => {
  const { ctx } = makeCtx();
  await setupSystem(ctx);

  for (let i = 0; i < 4; i += 1) {
    const failed = await loginSystem(ctx, 'wrong-password', { ip: '192.0.2.20' });
    assert.equal(failed.result.status, 401);
  }

  const success = await loginSystem(ctx, PASSWORD, { ip: '192.0.2.20' });
  assert.equal(success.result.status, 200);

  const failedAgain = await loginSystem(ctx, 'wrong-password', { ip: '192.0.2.20' });
  assert.equal(failedAgain.result.status, 401);
  assert.equal(failedAgain.result.body.detail.remaining, 4, '登录成功后计数应清零');
});

// ===== F2 回归：密码首尾空格口径必须一致（统一 trim）=====

test('F2 回归：带空格设置的密码，带空格与不带空格都必须能登录；改密同理', async () => {
  const { ctx } = makeCtx();
  const spaced = '  Passw0rd!2024  ';

  const setup = await setupSystem(ctx, spaced);
  assert.equal(setup.status, 200, 'setup 应允许带首尾空格的密码（后端 trim 后入库）');

  const withSpaces = await loginSystem(ctx, spaced, { ip: '198.18.0.1' });
  assert.equal(withSpaces.result.status, 200, '带空格登录必须成功（与 setup 口径一致）');

  const withoutSpaces = await loginSystem(ctx, 'Passw0rd!2024', { ip: '198.18.0.2' });
  assert.equal(withoutSpaces.result.status, 200, '去空格登录也必须成功');

  const changed = await dispatch(ctx, '/api/password', {
    method: 'POST',
    cookie: withoutSpaces.cookie,
    body: { oldPassword: 'Passw0rd!2024', newPassword: '  NewPassw0rd!2025  ' },
  });
  assert.equal(changed.status, 200, '改密的新密码带空格应被接受');

  const newTrimmed = await loginSystem(ctx, 'NewPassw0rd!2025', { ip: '198.18.0.3' });
  assert.equal(newTrimmed.result.status, 200, '新密码（去空格）必须能登录');

  const newSpaced = await loginSystem(ctx, '  NewPassw0rd!2025  ', { ip: '198.18.0.4' });
  assert.equal(newSpaced.result.status, 200, '新密码（带空格）必须能登录');

  const oldPassword = await loginSystem(ctx, 'Passw0rd!2024', { ip: '198.18.0.5' });
  assert.equal(oldPassword.result.status, 401, '改密后旧密码必须失效');
});
