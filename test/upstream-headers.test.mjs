// test/upstream-headers.test.mjs
// 覆盖上游请求头的统一构造：
//   - 公共头取值（Accept / Accept-Language / UA / Origin / Referer）；
//   - 业务头按账号字段「有才发」（uid / enterpriseId / domain），空值不发空串；
//   - 三条链路（签到 / 额度 / 续期）发出去的公共头必须逐字一致，
//     否则同一账号在不同接口呈现不同客户端特征，既可疑也难排查。

import test from 'node:test';
import assert from 'node:assert/strict';

import { bearerOf, buildUpstreamHeaders, CLIENT_USER_AGENT, UPSTREAM_ORIGIN } from '../src/upstream-headers.js';
import { checkinStatus } from '../src/checkin.js';
import { fetchAccountCredits } from '../src/credits.js';
import {
  createUpstreamMock,
  jsonRes,
  makeCtx,
  STATUS_PATH,
} from './helpers/harness.mjs';

const ACCOUNT = {
  id: 'acc_1',
  name: '主账号',
  token: 'secret-token',
  uid: 'u-123',
  enterpriseId: 'ent-456',
  domain: 'codebuddy.cn',
};

test('公共头：取值与官方 Web 客户端一致', () => {
  const headers = buildUpstreamHeaders({ token: 'abc' });
  assert.equal(headers.accept, 'application/json, text/plain, */*');
  assert.equal(headers['accept-language'], 'zh-CN,zh;q=0.9');
  assert.equal(headers.authorization, 'Bearer abc');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['user-agent'], CLIENT_USER_AGENT);
  assert.equal(headers.origin, UPSTREAM_ORIGIN);
  assert.equal(headers.referer, `${UPSTREAM_ORIGIN}/`);
});

test('业务头：账号没有的字段一个都不发（不发空串）', () => {
  const headers = buildUpstreamHeaders({ token: 'abc' });
  for (const key of ['x-user-id', 'x-enterprise-id', 'x-tenant-id', 'x-domain']) {
    assert.equal(key in headers, false, `${key} 不应出现`);
  }
});

test('业务头：uid / enterpriseId / domain 有值才发，enterpriseId 同时落两个头', () => {
  const headers = buildUpstreamHeaders(ACCOUNT);
  assert.equal(headers['x-user-id'], 'u-123');
  assert.equal(headers['x-enterprise-id'], 'ent-456');
  assert.equal(headers['x-tenant-id'], 'ent-456');
  assert.equal(headers['x-domain'], 'codebuddy.cn');
});

test('业务头：首尾空白与空白串视为「没有」', () => {
  const headers = buildUpstreamHeaders({ token: 'abc', uid: '   ', enterpriseId: '', domain: '  ' });
  assert.equal('x-user-id' in headers, false);
  assert.equal('x-enterprise-id' in headers, false);
  assert.equal('x-domain' in headers, false);
});

test('contentType 传 null 时不带 content-type（GET 场景）', () => {
  const headers = buildUpstreamHeaders({ token: 'abc' }, { contentType: null });
  assert.equal('content-type' in headers, false);
});

test('extra 叠加：key 统一小写，空值跳过', () => {
  const headers = buildUpstreamHeaders({ token: 'abc' }, {
    extra: { 'X-Refresh-Token': 'rt', 'x-auth-refresh-source': 'plugin', 'x-empty': '' },
  });
  assert.equal(headers['x-refresh-token'], 'rt');
  assert.equal(headers['x-auth-refresh-source'], 'plugin');
  assert.equal('x-empty' in headers, false);
});

test('bearerOf：大小写都能取到裸 token', () => {
  assert.equal(bearerOf({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerOf({ Authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerOf({}), '');
  assert.equal(bearerOf(null), '');
});

// ============ 跨链路一致性 ============

test('签到与额度发出的公共头逐字一致（同账号特征不漂移）', async () => {
  const checkinMock = createUpstreamMock((call) => {
    if (call.path === STATUS_PATH) return jsonRes({ code: 0, data: { today_checked_in: true } });
    throw new Error('[mock] 不应调用 daily');
  });
  await checkinStatus(makeCtx({ fetch: checkinMock }).ctx, ACCOUNT);
  const checkinHeaders = checkinMock.calls[0].headers;

  const creditsMock = createUpstreamMock((call) => {
    if (call.path.endsWith('summary')) return jsonRes({ code: 0, data: { Packages: [] } });
    return jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } });
  });
  await fetchAccountCredits(makeCtx({ fetch: creditsMock }).ctx, ACCOUNT);
  const creditsHeaders = creditsMock.calls[0].headers;

  assert.deepEqual(creditsHeaders, checkinHeaders);
});
