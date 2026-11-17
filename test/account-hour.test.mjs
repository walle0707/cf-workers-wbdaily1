// test/account-hour.test.mjs
// 覆盖「每账号独立签到时间」的接口契约：
//   - 新增账号不指定时间时自动错开（8、9、10…），避免批量导入后全部压在 8 点；
//   - 显式指定优先，非法值 400；
//   - PUT 可单独改时间，不改其它字段；
//   - 导入多个账号同样错开；
//   - 导出带回 checkin_hour，便于备份恢复。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAuthedEnv,
  dispatch,
} from './helpers/harness.mjs';

/** 造一个长度足够的 token（后端只要求非空）。 */
function token(tag) {
  return `token-${tag}-abcdefghijklmnop`;
}

test('新增账号：不指定时间时从 8 点起自动错开', async () => {
  const { ctx, cookie } = await createAuthedEnv();

  const a = await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: 'A', token: token('a') } });
  const b = await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: 'B', token: token('b') } });
  const c = await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: 'C', token: token('c') } });

  assert.equal(a.body.data.checkinHour, 8);
  assert.equal(b.body.data.checkinHour, 9);
  assert.equal(c.body.data.checkinHour, 10);
});

test('新增账号：显式指定的时间优先，0 点算合法值', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  const res = await dispatch(ctx, '/api/accounts', {
    method: 'POST', cookie, body: { name: 'A', token: token('a'), checkinHour: 0 },
  });
  assert.equal(res.body.data.checkinHour, 0);
});

test('新增账号：非法签到时间返回 400', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  for (const bad of [24, -1, 5.5, 'abc']) {
    const res = await dispatch(ctx, '/api/accounts', {
      method: 'POST', cookie, body: { name: 'X', token: token('x'), checkinHour: bad },
    });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} 应被拒绝`);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  }
});

test('PUT 账号：只改签到时间，不动 token / 名称 / 备注', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  const created = await dispatch(ctx, '/api/accounts', {
    method: 'POST', cookie, body: { name: 'A', token: token('a'), remark: '备注' },
  });
  const id = created.body.data.id;

  const updated = await dispatch(ctx, `/api/accounts/${id}`, {
    method: 'PUT', cookie, body: { checkinHour: 21 },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.checkinHour, 21);
  assert.equal(updated.body.data.name, 'A');
  assert.equal(updated.body.data.remark, '备注');
  assert.equal(updated.body.data.tokenMasked, created.body.data.tokenMasked, 'token 不应被清空');
});

test('PUT 账号：非法签到时间返回 400，且原值不变', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  const created = await dispatch(ctx, '/api/accounts', {
    method: 'POST', cookie, body: { name: 'A', token: token('a'), checkinHour: 7 },
  });
  const id = created.body.data.id;

  const bad = await dispatch(ctx, `/api/accounts/${id}`, { method: 'PUT', cookie, body: { checkinHour: 99 } });
  assert.equal(bad.status, 400);

  const list = await dispatch(ctx, '/api/accounts', { cookie });
  assert.equal(list.body.data[0].checkinHour, 7);
});

test('GET /api/accounts：总是返回 checkinHour（存量账号回落 8）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv();
  // 模拟旧版本留下的账号记录（没有 checkinHour 字段）
  kv.seed('accounts', [{ id: 'acc_old', name: '旧账号', token: token('old'), uid: '', enabled: true, remark: '', createdAt: 'T', updatedAt: 'T' }]);

  const list = await dispatch(ctx, '/api/accounts', { cookie });
  assert.equal(list.body.data[0].checkinHour, 8);
});

test('导入多个账号：自动错开（8、9、10…）', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  const payload = [
    { access_token: token('1'), nickname: '一号' },
    { access_token: token('2'), nickname: '二号' },
    { access_token: token('3'), nickname: '三号' },
  ];
  const imported = await dispatch(ctx, '/api/accounts/import', { method: 'POST', cookie, body: payload });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.data.imported, 3);

  const list = await dispatch(ctx, '/api/accounts', { cookie });
  assert.deepEqual(list.body.data.map((a) => a.checkinHour).sort((x, y) => x - y), [8, 9, 10]);
});

test('导入：显式 checkin_hour 生效，非法值整条跳过', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  const payload = [
    { access_token: token('ok'), nickname: '正常', checkin_hour: 6 },
    { access_token: token('bad'), nickname: '非法', checkin_hour: 30 },
  ];
  const res = await dispatch(ctx, '/api/accounts/import', { method: 'POST', cookie, body: payload });

  assert.equal(res.body.data.imported, 1);
  assert.equal(res.body.data.skipped, 1);
  assert.match(res.body.data.reasons[0], /checkin_hour/);

  const list = await dispatch(ctx, '/api/accounts', { cookie });
  assert.equal(list.body.data[0].checkinHour, 6);
});

test('导出：带上 checkin_hour，便于还原', async () => {
  const { ctx, cookie } = await createAuthedEnv();
  await dispatch(ctx, '/api/accounts', { method: 'POST', cookie, body: { name: 'A', token: token('a'), checkinHour: 13 } });

  const exported = await dispatch(ctx, '/api/accounts/export', { cookie });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.data[0].checkin_hour, 13);
});
