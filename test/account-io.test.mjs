// test/account-io.test.mjs
// 覆盖：cockpit-tools 导出格式导入（数组 / accounts / 单对象）、字段归一化与跳过、
//       uid 优先/token 兜底合并、账号上限、导出格式与字段类型、
//       导入只写 1 次 KV 且不回显 token、导入放宽到 2MB 而其他写接口仍是 64KB。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCockpitExport,
  extractImportItems,
  mergeImportedAccounts,
  normalizeImportItem,
  normalizeImportPayload,
} from '../src/account-io.js';
import { AppError } from '../src/util.js';
import {
  createAuthedEnv,
  dispatch,
  makeAccount,
} from './helpers/harness.mjs';

const TOKEN = 'cockpit-access-token-abcdefghijklmnop';
const NOW = Date.parse('2026-11-14T08:00:00Z');

// ============ 归一化 ============

test('normalizeImportItem：兼容 access_token / accessToken / token，昵称优先于邮箱', () => {
  assert.deepEqual(normalizeImportItem({ access_token: '  Bearer abc  ', uid: ' u1 ', nickname: '主账号' }).item,
    { name: '主账号', token: 'abc', uid: 'u1' });
  assert.deepEqual(normalizeImportItem({ accessToken: 'tok', email: 'a@b.com' }).item,
    { name: 'a@b.com', token: 'tok', uid: '' });
  assert.deepEqual(normalizeImportItem({ token: 't3' }, 4).item,
    { name: '导入账号 5', token: 't3', uid: '' });
});

test('normalizeImportItem：缺 token / 非对象被拒绝且不抛异常', () => {
  for (const bad of [{}, null, 'x', [], { access_token: '   ' }, { access_token: 123 }]) {
    const result = normalizeImportItem(bad, 0);
    assert.equal(result.ok, false);
    assert.match(result.reason, /access_token|不是对象/);
  }
});

test('extractImportItems：支持数组、accounts、items、单对象；空数组与超量拒绝', () => {
  assert.equal(extractImportItems([{ a: 1 }]).length, 1);
  assert.equal(extractImportItems({ accounts: [{ a: 1 }, { a: 2 }] }).length, 2);
  assert.equal(extractImportItems({ items: [{ a: 1 }] }).length, 1);
  assert.equal(extractImportItems({ access_token: 'x' }).length, 1);
  assert.throws(() => extractImportItems([]), (err) => err instanceof AppError && err.code === 'BAD_REQUEST');
  assert.throws(() => extractImportItems(Array.from({ length: 201 }, () => ({}))),
    (err) => err instanceof AppError && /200/.test(err.message));
});

test('normalizeImportPayload：坏条目计入 skipped，好条目保留', () => {
  const parsed = normalizeImportPayload([
    { access_token: TOKEN, uid: 'u1', nickname: 'A' },
    { uid: 'no-token' },
    { accessToken: 't2' },
  ]);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.reasons.length, 1);
});

// ============ 合并 ============

test('mergeImportedAccounts：uid 命中则更新 token，保留本地名称/备注/启用状态', () => {
  const existing = [{ ...makeAccount(1, { token: 'old-token' }), uid: 'u1', name: '我的名字', remark: '备注', enabled: false }];
  const result = mergeImportedAccounts(existing, [{ name: '导入名', token: 'new-token', uid: 'u1' }], {
    nowMs: NOW, maxAccounts: 10, createdAt: new Date(NOW).toISOString(),
  });
  assert.equal(result.updated, 1);
  assert.equal(result.imported, 0);
  assert.equal(result.accounts[0].token, 'new-token');
  assert.equal(result.accounts[0].name, '我的名字');
  assert.equal(result.accounts[0].remark, '备注');
  assert.equal(result.accounts[0].enabled, false);
  assert.equal(result.accounts[0].updatedAt, new Date(NOW).toISOString());
});

test('mergeImportedAccounts：无 uid 时按 token 命中并补齐 uid；完全一致计 unchanged', () => {
  const existing = [{ ...makeAccount(2, { token: TOKEN }), uid: '' }];
  const filled = mergeImportedAccounts(existing, [{ name: 'X', token: TOKEN, uid: 'u9' }], {
    nowMs: NOW, maxAccounts: 10, createdAt: new Date(NOW).toISOString(),
  });
  assert.equal(filled.updated, 1);
  assert.equal(filled.accounts[0].uid, 'u9');

  const same = mergeImportedAccounts(filled.accounts, [{ name: 'X', token: TOKEN, uid: 'u9' }], {
    nowMs: NOW, maxAccounts: 10, createdAt: new Date(NOW).toISOString(),
  });
  assert.equal(same.unchanged, 1);
  assert.equal(same.updated, 0);
});

test('mergeImportedAccounts：新增账号字段完整；超过上限抛 CONFLICT 且不返回半成品', () => {
  const result = mergeImportedAccounts([], [{ name: 'A', token: 't1', uid: 'u1' }], {
    nowMs: NOW, maxAccounts: 1, createdAt: new Date(NOW).toISOString(),
  });
  assert.equal(result.imported, 1);
  assert.match(result.accounts[0].id, /^acc_/);
  assert.equal(result.accounts[0].enabled, true);
  assert.equal(result.accounts[0].remark, '');

  assert.throws(() => mergeImportedAccounts([{ ...makeAccount(3) }], [{ name: 'B', token: 't2', uid: 'u2' }], {
    nowMs: NOW, maxAccounts: 1, createdAt: new Date(NOW).toISOString(),
  }), (err) => err instanceof AppError && err.code === 'CONFLICT');
});

// ============ 导出 ============

test('buildCockpitExport：字段与 cockpit-tools 结构一致，时间戳为秒', async () => {
  const account = {
    ...makeAccount(1, { token: TOKEN, name: '主账号' }),
    uid: 'c02b0488-06f8-469b-ade5-4313d6413279',
  };
  const [row] = await buildCockpitExport([account], NOW);

  assert.match(row.id, /^workbuddy_[0-9a-f]{32}$/);
  assert.equal(row.email, '主账号');
  assert.equal(row.nickname, '主账号');
  assert.equal(row.uid, 'c02b0488-06f8-469b-ade5-4313d6413279');
  assert.equal(row.access_token, TOKEN);
  assert.equal(row.token_type, 'Bearer');
  assert.equal(row.status, 'normal');
  assert.equal(Number.isInteger(row.created_at), true);
  assert.equal(Number.isInteger(row.last_used), true);
  assert.equal(row.created_at, Math.floor(Date.parse(account.createdAt) / 1000));
  assert.equal(Object.values(row).some((value) => value === undefined), false, '不得输出 undefined 字段');
  assert.equal('refresh_token' in row, false, '没有的字段不伪造');
});

test('buildCockpitExport：没有 token 的脏记录被跳过', async () => {
  const rows = await buildCockpitExport([{ ...makeAccount(1), token: '' }, null], NOW);
  assert.deepEqual(rows, []);
});

// ============ API 层 ============

test('POST /api/accounts/import：整批只写 1 次 KV、不回显 token、可容纳 >64KB 的 cockpit 文件', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  await ctx.kv.putAccounts([makeAccount(1, { token: 'keep-me' })]);

  const before = ctx.writes();
  const payload = [
    {
      id: 'workbuddy_x', email: '落榜美術僧', uid: 'u-1', nickname: '落榜美術僧',
      access_token: `Bearer ${TOKEN}`, refresh_token: 'r'.repeat(1200),
      // cockpit 导出里的大对象，用来把整体撑到 64KB 以上
      quota_raw: { padding: 'x'.repeat(90000) },
    },
    { access_token: 'tok-2', nickname: '备号' },
    { nickname: '坏记录' },
  ];
  const res = await dispatch(ctx, '/api/accounts/import', { method: 'POST', body: payload, cookie });

  assert.equal(res.status, 200);
  assert.deepEqual(
    { total: res.body.data.total, imported: res.body.data.imported, skipped: res.body.data.skipped },
    { total: 3, imported: 2, skipped: 1 },
  );
  assert.equal(ctx.writes() - before, 1, '导入 N 个账号只能写 1 次 KV');
  assert.equal(JSON.stringify(res.body).includes(TOKEN), false, '导入响应不得回显 token');

  const accounts = await ctx.kv.getAccounts();
  assert.equal(accounts.length, 3);
  assert.equal(accounts.find((item) => item.uid === 'u-1').token, TOKEN, 'Bearer 前缀必须被剥掉');
});

test('POST /api/accounts/import：账号数超上限返回 409，且不写入', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  const full = Array.from({ length: 10 }, (_, i) => makeAccount(i + 1));
  await ctx.kv.putAccounts(full);
  const before = ctx.writes();

  const res = await dispatch(ctx, '/api/accounts/import', {
    method: 'POST', cookie, body: [{ access_token: 'extra', uid: 'u-extra' }],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CONFLICT');
  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export：需登录；返回 cockpit 兼容数组且含明文 token', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  await ctx.kv.putAccounts([{ ...makeAccount(1, { token: TOKEN, name: '主账号' }), uid: 'u-1' }]);

  const unauth = await dispatch(ctx, '/api/accounts/export');
  assert.equal(unauth.status, 401);

  const res = await dispatch(ctx, '/api/accounts/export', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].access_token, TOKEN);
  assert.equal(res.body.data[0].uid, 'u-1');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET /api/accounts/export?id=：只导出指定账号，仍返回数组且 no-store', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  await ctx.kv.putAccounts([
    { ...makeAccount(1, { token: TOKEN, name: '主账号' }), uid: 'u-1' },
    { ...makeAccount(2, { token: 'token-2-abcdefghijkl' }), uid: 'u-2' },
  ]);

  const res = await dispatch(ctx, '/api/accounts/export?id=acc_2', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].uid, 'u-2');
  assert.equal(res.body.data[0].access_token, 'token-2-abcdefghijkl');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  // 全量导出（不带 id）仍然返回两条，向后兼容
  const all = await dispatch(ctx, '/api/accounts/export', { cookie });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 2);
});

test('GET /api/accounts/export：id 不存在返回 404，id 为空返回 400，且零 KV 写', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  await ctx.kv.putAccounts([{ ...makeAccount(1, { token: TOKEN }), uid: 'u-1' }]);
  const before = ctx.writes();

  const missing = await dispatch(ctx, '/api/accounts/export?id=acc_missing', { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const empty = await dispatch(ctx, '/api/accounts/export?id=', { cookie });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'BAD_REQUEST');

  assert.equal(ctx.writes(), before);
});

test('导入放宽到 5MB 不影响其他写接口：普通 POST /api/accounts 仍限 64KB', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  const res = await dispatch(ctx, '/api/accounts', {
    method: 'POST',
    cookie,
    body: { name: 'x'.repeat(70 * 1024), token: 'tok' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /65536/);
});

// ============ 导出 ?id= 契约细化 ============

/** 单账号导出测试用的互不重叠 token（避免子串误判）。 */
const TOKEN_A = 'token-one-aaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-two-bbbbbbbbbbbbbbbb';

/**
 * 建一个含 2 个账号的已登录环境。
 * @returns {Promise<{ctx:object, cookie:string, accounts:object[]}>}
 */
async function createExportEnv() {
  const { ctx, cookie } = await createAuthedEnv({});
  const accounts = [
    { ...makeAccount(1, { token: TOKEN_A, name: '主账号' }), uid: 'u-1' },
    { ...makeAccount(2, { token: TOKEN_B, name: '备号' }), uid: 'u-2' },
  ];
  await ctx.kv.putAccounts(accounts);
  return { ctx, cookie, accounts };
}

test('GET /api/accounts/export：未登录时带不带 id 都是 401，且 no-store、零 KV 写', async () => {
  const { ctx } = await createExportEnv();
  const before = ctx.writes();

  for (const path of ['/api/accounts/export', '/api/accounts/export?id=acc_1']) {
    const res = await dispatch(ctx, path);
    assert.equal(res.status, 401, `${path} 必须 401`);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(ctx.writes(), before, '未登录不得产生任何 KV 写');
});

test('GET /api/accounts/export（无 id）：全量数组，长度等于账号数，含全部 token', async () => {
  const { ctx, cookie, accounts } = await createExportEnv();
  const before = ctx.writes();

  const res = await dispatch(ctx, '/api/accounts/export', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data.length, accounts.length);
  assert.deepEqual(res.body.data.map((row) => row.uid).sort(), ['u-1', 'u-2']);
  assert.deepEqual(res.body.data.map((row) => row.access_token).sort(), [TOKEN_A, TOKEN_B].sort());
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(ctx.writes(), before, '导出不得产生 KV 写');
});

test('GET /api/accounts/export?id=<存在>：长度 1、字段与该账号一致、不含其它账号', async () => {
  const { ctx, cookie } = await createExportEnv();
  const before = ctx.writes();

  const res = await dispatch(ctx, '/api/accounts/export?id=acc_2', { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data), '必须仍是数组（cockpit-tools 兼容）');
  assert.equal(res.body.data.length, 1);
  const [row] = res.body.data;
  assert.equal(row.uid, 'u-2');
  assert.equal(row.access_token, TOKEN_B);
  assert.equal(row.nickname, '备号');
  assert.equal(row.email, '备号');
  assert.equal(row.token_type, 'Bearer');
  // 不得泄漏另一个账号
  assert.equal(res.text.includes(TOKEN_A), false, '不得包含其它账号的 token');
  assert.equal(res.text.includes('u-1'), false, '不得包含其它账号的 uid');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export?id=<存在>：重复调用结果完全一致（幂等）', async () => {
  const { ctx, cookie } = await createExportEnv();
  const before = ctx.writes();

  const first = await dispatch(ctx, '/api/accounts/export?id=acc_1', { cookie });
  const second = await dispatch(ctx, '/api/accounts/export?id=acc_1', { cookie });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.text, first.text, '同一账号两次导出字节级一致');
  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export?id=<不存在>：404 NOT_FOUND「账号不存在」、no-store、零 KV 写', async () => {
  const { ctx, cookie } = await createExportEnv();
  const before = ctx.writes();

  for (const path of ['/api/accounts/export?id=acc_missing', '/api/accounts/export?id=ACC_1']) {
    const res = await dispatch(ctx, path, { cookie });
    assert.equal(res.status, 404, `${path} 必须 404`);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.equal(res.body.error.message, '账号不存在');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export?id=<空/空白>：400 BAD_REQUEST「id 不能为空」、no-store、零 KV 写', async () => {
  const { ctx, cookie } = await createExportEnv();
  const before = ctx.writes();

  for (const query of ['id=', 'id=%20%20', 'id=%20%09%20', 'id=%0A']) {
    const res = await dispatch(ctx, `/api/accounts/export?${query}`, { cookie });
    assert.equal(res.status, 400, `${query} 必须 400`);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
    assert.equal(res.body.error.message, 'id 不能为空');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export?id=：id 含特殊字符/中文时按编码精确匹配，不误判 400/404', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  const weirdId = 'acc_1&x=1/中文 +%20 "q"?';
  const accounts = [
    { ...makeAccount(1, { token: TOKEN_A }), id: weirdId, uid: 'u-weird' },
    { ...makeAccount(2, { token: TOKEN_B }), uid: 'u-2' },
  ];
  await ctx.kv.putAccounts(accounts);
  const before = ctx.writes();

  const res = await dispatch(ctx, `/api/accounts/export?id=${encodeURIComponent(weirdId)}`, { cookie });
  assert.equal(res.status, 200, '含特殊字符的 id 不应被误判为 400/404');
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].uid, 'u-weird');
  assert.equal(res.body.data[0].access_token, TOKEN_A);

  // 前缀/未编码的近似值不能命中
  const prefix = await dispatch(ctx, '/api/accounts/export?id=acc_1', { cookie });
  assert.equal(prefix.status, 404, 'id 必须是精确匹配，不能前缀命中');
  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export：账号列表为空时，无 id 返回 []，任意 id 返回 404', async () => {
  const { ctx, cookie } = await createAuthedEnv({});
  const before = ctx.writes();

  const all = await dispatch(ctx, '/api/accounts/export', { cookie });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.data, []);
  assert.equal(all.headers.get('cache-control'), 'no-store');

  const one = await dispatch(ctx, '/api/accounts/export?id=acc_1', { cookie });
  assert.equal(one.status, 404);
  assert.equal(one.body.error.code, 'NOT_FOUND');

  assert.equal(ctx.writes(), before);
});

test('GET /api/accounts/export：成功与失败路径都不把 token 打进控制台日志', async () => {
  const { ctx, cookie } = await createExportEnv();
  const calls = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (...args) => calls.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const name of Object.keys(originals)) console[name] = capture;
  try {
    await dispatch(ctx, '/api/accounts/export', { cookie });
    await dispatch(ctx, '/api/accounts/export?id=acc_1', { cookie });
    await dispatch(ctx, '/api/accounts/export?id=acc_missing', { cookie });
    await dispatch(ctx, '/api/accounts/export?id=', { cookie });
  } finally {
    for (const [name, fn] of Object.entries(originals)) console[name] = fn;
  }
  const output = calls.join('\n');
  assert.equal(output.includes(TOKEN_A), false, '日志不得出现 token 明文');
  assert.equal(output.includes(TOKEN_B), false, '日志不得出现 token 明文');
});

test('回归：导出仍是 GET /api/accounts/export（POST 依旧 404，路径未变）', async () => {
  const { ctx, cookie } = await createExportEnv();
  const before = ctx.writes();

  const post = await dispatch(ctx, '/api/accounts/export', { method: 'POST', cookie, body: {} });
  assert.equal(post.status, 404);
  assert.equal(post.body.error.code, 'NOT_FOUND');

  const wrongPath = await dispatch(ctx, '/api/accounts/exports', { cookie });
  assert.equal(wrongPath.status, 404);

  assert.equal(ctx.writes(), before);
});
