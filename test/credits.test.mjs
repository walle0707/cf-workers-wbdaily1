// test/credits.test.mjs
// 覆盖：积分四分组计算（基础/赠送/奖励/购买）/ 官方 summary 优先取总剩余 /
//       CapacityType=4 日切片 / 付费与免费资源去重 / 上游请求形状（URL、头、body、日期）/
//       HTTP 401·403·业务 code·非 JSON·超时·网络 六类错误 /
//       401 映射 tokenInvalid（502 而非 401）、403 映射 upstreamBlocked /
//       非确定性失败重试一次（403/429/5xx/timeout 重试，401 与业务码不重试）/ token 不泄漏。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCredits,
  CreditsError,
  fetchAccountCredits,
  resourceRemain,
  resourceTotal,
  svcAccountCredits,
} from '../src/credits.js';
import { AppError } from '../src/util.js';
import { jsonRes, makeCtx, textRes } from './helpers/harness.mjs';

const NOW = Date.parse('2026-11-14T08:00:00Z'); // 上海时间 16:00
const TOKEN = 'credits-secret-token-abcdefghijkl';
const UID = 'u-123456';

const PATHS = {
  summary: '/billing/meter/get-user-resource-summary',
  paid: '/billing/meter/get-user-resource-paid-packages',
  free: '/billing/meter/get-user-resource-free-packages',
};

/** @param {string} code */
function pkg(code, total, left, extra = {}) {
  return {
    PackageCode: code,
    Status: 0,
    CycleCapacitySizePrecise: String(total),
    CycleCapacityRemainPrecise: String(left),
    CycleEndTime: new Date(NOW + 24 * 3600 * 1000).toISOString(),
    ...extra,
  };
}

const CODE = {
  proMon: 'TCACA_code_002_AkiJS3ZHF5',
  freeMon: 'TCACA_code_008_cfWoLwvjU4',
  activity: 'TCACA_code_007_nzdH5h4Nl0',
  bonus28: 'TCACA_code_028_NtpWi0jzXs',
  bonus30: 'TCACA_code_030_BjSt89qTvr',
  extra: 'TCACA_code_009_0XmEQc2xOf',
};

const ACCOUNT = { id: 'acc_1', name: '主账号', token: TOKEN, uid: UID };

/**
 * 按端点返回响应的严格 mock。
 * @param {{summary?:Function, paid?:Function, free?:Function}} handlers
 */
function mockUpstream(handlers = {}) {
  /** @type {Array<{path:string, headers:object, body:object}>} */
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://copilot.tencent.com');
    const path = parsed.pathname;
    assert.ok(Object.values(PATHS).includes(path), `未预期的额度端点 ${path}`);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ path, headers: init.headers || {}, body });

    const handler = path === PATHS.summary ? handlers.summary
      : path === PATHS.paid ? handlers.paid
        : handlers.free;
    if (!handler) throw new Error(`[mock] 未配置 ${path}`);
    return handler({ path, headers: init.headers || {}, body });
  };
  fetchImpl.calls = calls;
  fetchImpl.paths = () => calls.map((call) => call.path);
  return fetchImpl;
}

/** @param {object} summary @param {object[]} paid @param {object[]} free */
function okHandlers(summary, paid, free) {
  return {
    summary: () => jsonRes({ code: 0, data: summary }),
    paid: () => jsonRes({ code: 0, data: { Accounts: paid, TotalCount: paid.length } }),
    free: () => jsonRes({ code: 0, data: { Accounts: free, TotalCount: free.length } }),
  };
}

// ============ 纯计算 ============

test('computeCredits：四类分组、基础包只取一个、奖励包过期不计数、总剩余优先取 summary', () => {
  const resources = [
    pkg(CODE.proMon, 500, 400),
    pkg(CODE.freeMon, 500, 500),
    pkg(CODE.activity, 100, 70, { DeductionEndTime: new Date(NOW + 3600 * 1000).toISOString() }),
    pkg(CODE.bonus30, 100, 100, { DeductionEndTime: new Date(NOW - 1000).toISOString() }),
    pkg(CODE.bonus28, 200, 180),
    pkg(CODE.extra, 50, 45),
  ];
  const result = computeCredits({
    summary: { Packages: [{ CycleRemainCapacity: '695.5' }] },
    resources,
  }, NOW);

  assert.equal(result.status, 'normal');
  assert.equal(result.totalLeft, 695.5, '总剩余必须用官方 summary 的 CycleRemainCapacity');
  assert.equal(result.planLabel, 'PRO');
  assert.deepEqual(
    result.groups.map((group) => [group.key, group.left, group.used]),
    [['planBase', 400, 100], ['planBonus', 180, 20], ['benefit', 70, 30], ['addon', 45, 5]],
  );
  assert.equal(result.groups[2].expiring, true, '1 小时内过期应标记即将过期');
  assert.equal(result.groups[2].remainPercent, 70);
});

test('computeCredits：无 summary 时回退到分组求和；无有效资源时 status=warning 且 total=null', () => {
  const withResources = computeCredits({ summary: null, resources: [pkg(CODE.proMon, 100, 80)] }, NOW);
  assert.equal(withResources.totalLeft, 80);
  assert.equal(withResources.groups[0].remainPercent, 80);

  const empty = computeCredits({ summary: null, resources: [] }, NOW);
  assert.equal(empty.status, 'warning');
  assert.equal(empty.totalLeft, null);
  assert.deepEqual(empty.groups, []);

  const zero = computeCredits({ summary: { Packages: [] }, resources: [] }, NOW);
  assert.equal(zero.totalLeft, 0, '官方 summary 明确为空时是 0，不是 null');
});

test('CapacityType=4 时按当日切片计算总量与剩余', () => {
  const resource = {
    PackageCode: CODE.proMon,
    Status: 0,
    CapacityType: 4,
    CycleCapacitySizePrecise: '9999',
    CycleCapacityRemainPrecise: '9999',
    SlicePeriodUsageDetails: [{ SlicePeriodCapacitySizePrecise: '88', SlicePeriodCapacityRemainPrecise: '66' }],
  };
  assert.equal(resourceTotal(resource), 88);
  assert.equal(resourceRemain(resource), 66);
  const result = computeCredits({ summary: { Packages: [] }, resources: [resource] }, NOW);
  assert.equal(result.groups[0].left, 66);
  assert.equal(result.groups[0].total, 88);
});

test('computeCredits：无时区后缀的时间字符串按北京时间（UTC+8）解析', () => {
  // 北京 2026-11-17 00:00:00 = UTC 2026-11-16T16:00:00Z
  const beijingStr = '2026-11-17 00:00:00';
  const result = computeCredits({
    summary: null,
    resources: [pkg(CODE.activity, 100, 70, { DeductionEndTime: beijingStr })],
  }, NOW);
  const benefit = result.groups.find((g) => g.key === 'benefit');
  assert.ok(benefit, 'benefit 分组应存在');
  assert.equal(
    benefit.time,
    '2026-11-16T16:00:00.000Z',
    '北京时间 11-17 00:00 应解析为 UTC 11-16 16:00（而非 UTC 11-17 00:00）',
  );
});

test('computeCredits：T 分隔无时区字符串同样按北京时间解析', () => {
  const beijingStr = '2026-11-17T00:00:00';
  const result = computeCredits({
    summary: null,
    resources: [pkg(CODE.activity, 100, 70, { DeductionEndTime: beijingStr })],
  }, NOW);
  const benefit = result.groups.find((g) => g.key === 'benefit');
  assert.equal(benefit.time, '2026-11-16T16:00:00.000Z');
});

test('computeCredits：带显式时区的字符串不受影响（Z / +08:00）', () => {
  // UTC 2026-11-17T00:00:00Z
  const utcResult = computeCredits({
    summary: null,
    resources: [pkg(CODE.activity, 100, 70, { DeductionEndTime: '2026-11-17T00:00:00Z' })],
  }, NOW);
  const utcGroup = utcResult.groups.find((g) => g.key === 'benefit');
  assert.equal(utcGroup.time, '2026-11-17T00:00:00.000Z', 'Z 后缀应按 UTC 解析');

  // 北京 2026-11-17T00:00:00+08:00 = UTC 2026-11-16T16:00:00Z
  const tzResult = computeCredits({
    summary: null,
    resources: [pkg(CODE.activity, 100, 70, { DeductionEndTime: '2026-11-17T00:00:00+08:00' })],
  }, NOW);
  const tzGroup = tzResult.groups.find((g) => g.key === 'benefit');
  assert.equal(tzGroup.time, '2026-11-16T16:00:00.000Z', '+08:00 后缀应正确解析');
});

test('computeCredits：纯日期字符串按北京时间当天 0 点解析（不再返回 null）', () => {
  // "2026-11-20" = 北京 2026-11-20 00:00 = UTC 2026-11-19T16:00:00Z
  const result = computeCredits({
    summary: null,
    resources: [pkg(CODE.activity, 100, 70, { DeductionEndTime: '2026-11-20' })],
  }, NOW);
  const benefit = result.groups.find((g) => g.key === 'benefit');
  assert.ok(benefit, 'benefit 分组应存在');
  assert.equal(
    benefit.time,
    '2026-11-19T16:00:00.000Z',
    '纯日期应解析为北京当天 0 点 = UTC 前一天 16:00',
  );
});

test('computeCredits：纯日期字符串不被 3 天窗口误判为已过期', () => {
  // NOW = 北京 11-14 16:00；"2026-11-20" = 北京 11-20 00:00 → 还有约 5.3 天，不应 expiring
  const result = computeCredits({
    summary: null,
    resources: [pkg(CODE.activity, 100, 70, { DeductionEndTime: '2026-11-20' })],
  }, NOW);
  const benefit = result.groups.find((g) => g.key === 'benefit');
  assert.equal(benefit.expiring, false, '5 天后到期不应标 expiring');
});

// ============ 上游请求 ============

test('fetchAccountCredits：三次请求并发、头与 body 正确、付费/免费同 ResourceId 去重', async () => {
  const shared = pkg(CODE.proMon, 500, 400, { ResourceId: 7 });
  const mock = mockUpstream(okHandlers(
    { Packages: [{ CycleRemainCapacity: '400' }] },
    [shared],
    [shared, { ...pkg(CODE.activity, 100, 70), ResourceId: 8 }],
  ));
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });

  const result = await fetchAccountCredits(ctx, ACCOUNT);

  assert.equal(result.accountId, 'acc_1');
  assert.equal(result.totalLeft, 400);
  assert.equal(mock.paths().length, 3, 'summary + paid + free 各一次');
  assert.deepEqual(new Set(mock.paths()), new Set(Object.values(PATHS)));

  for (const call of mock.calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['x-user-id'], UID);
    assert.equal(call.headers['content-type'], 'application/json');
    // 与 checkin.js 同口径的浏览器特征头：额度接口恰恰是线上被 403 风控的那条链路
    assert.equal(
      call.headers['user-agent'],
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'User-Agent 必须与 checkin.js 的 CLIENT_USER_AGENT 完全一致',
    );
    assert.equal(call.headers.origin, 'https://copilot.tencent.com');
    assert.equal(call.headers.referer, 'https://copilot.tencent.com/');
    assert.equal(call.headers.accept, 'application/json, text/plain, */*');
    assert.equal(call.headers['accept-language'], 'zh-CN,zh;q=0.9');
  }

  const paidBody = mock.calls.find((call) => call.path === PATHS.paid).body;
  assert.equal(paidBody.PageNumber, 1);
  assert.equal(paidBody.PageSize, 200);
  assert.deepEqual(paidBody.Status, [0, 3]);
  assert.equal(paidBody.NeedRenewInfo, true);
  assert.ok(paidBody.PackageCodes.includes(CODE.proMon));

  const freeBody = mock.calls.find((call) => call.path === PATHS.free).body;
  assert.equal(freeBody.SlicePeriodStartTime, '2026-11-14 00:00:00', '免费额度按上海时区自然日切片');
  assert.equal(freeBody.SlicePeriodEndTime, '2026-11-14 23:59:59');
  assert.ok(!('NeedRenewInfo' in freeBody));

  // 去重后只保留一个 ResourceId=7，加上 activity 的 8
  assert.equal(result.groups.find((group) => group.key === 'planBase').left, 400);
  assert.equal(result.groups.find((group) => group.key === 'benefit').left, 70);
});

test('fetchAccountCredits：HTTP 401 抛 CreditsError(http,401)，不重试、不泄漏 token', async () => {
  const mock = mockUpstream({
    summary: () => jsonRes({ code: 401, message: 'unauthorized' }, 401),
    paid: () => jsonRes({}),
    free: () => jsonRes({}),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });
  const sleeps = [];

  await assert.rejects(
    fetchAccountCredits(ctx, ACCOUNT, { sleep: async (ms) => { sleeps.push(ms); } }),
    (err) => {
      assert.ok(err instanceof CreditsError);
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 401);
      assert.ok(!String(err.message).includes(TOKEN));
      return true;
    },
  );
  assert.equal(sleeps.length, 0, '401 是确定性失败，不得重试');
  assert.equal(mock.calls.filter((call) => call.path === PATHS.summary).length, 1, '401 只允许 1 次尝试');
});

test('fetchAccountCredits：业务 code≠0 / 非 JSON / 缺 data 分别抛 api、bad_json、data', async () => {
  const cases = [
    [{ ...okHandlers({}, [], []), summary: () => jsonRes({ code: 1001, data: {} }) }, 'api'],
    [{ ...okHandlers({}, [], []), summary: () => textRes('<html>') }, 'bad_json'],
    [{ ...okHandlers({}, [], []), summary: () => jsonRes({ code: 0 }) }, 'data'],
  ];
  for (const [handlers, kind] of cases) {
    const mock = mockUpstream(handlers);
    const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });
    await assert.rejects(fetchAccountCredits(ctx, ACCOUNT), (err) => {
      assert.ok(err instanceof CreditsError);
      assert.equal(err.kind, kind);
      return true;
    });
  }
});

test('fetchAccountCredits：上游忽略 AbortSignal 也会在 timeoutMs 后返回 timeout', async () => {
  const hanging = () => new Promise(() => {});
  const mock = mockUpstream({ summary: hanging, paid: hanging, free: hanging });
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });

  const started = Date.now();
  await assert.rejects(
    // 注入 sleep 避免真的等 400ms；timeout 属于可重试类，共 2 次尝试
    fetchAccountCredits(ctx, ACCOUNT, { timeoutMs: 60, sleep: async () => {} }),
    (err) => err instanceof CreditsError && err.kind === 'timeout',
  );
  assert.ok(Date.now() - started < 1000, '不应依赖上游自觉中断');
});

test('fetchAccountCredits：网络错误抛 network', async () => {
  const mock = async () => { throw new TypeError('boom'); };
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });
  await assert.rejects(fetchAccountCredits(ctx, ACCOUNT), (err) => {
    assert.ok(err instanceof CreditsError);
    assert.equal(err.kind, 'network');
    return true;
  });
});

// ============ 重试策略 ============

test('fetchAccountCredits：403 重试一次（共 2 次尝试）后仍失败', async () => {
  const mock = mockUpstream({
    summary: () => textRes('<html>403 Forbidden</html>', 403),
    paid: () => textRes('<html>403 Forbidden</html>', 403),
    free: () => textRes('<html>403 Forbidden</html>', 403),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });
  const sleeps = [];

  await assert.rejects(
    fetchAccountCredits(ctx, ACCOUNT, { sleep: async (ms) => { sleeps.push(ms); } }),
    (err) => err instanceof CreditsError && err.kind === 'http' && err.status === 403,
  );

  assert.deepEqual(sleeps, [400], '403 属于非确定性失败，必须间隔 400ms 重试一次');
  assert.equal(mock.calls.filter((call) => call.path === PATHS.summary).length, 2, 'summary 应尝试 2 次');
  assert.equal(mock.calls.length, 6, '三个端点 × 2 次尝试');
});

test('fetchAccountCredits：首次 403、重试 200 → 整体成功（验证重试生效）', async () => {
  let summaryCalls = 0;
  const mock = mockUpstream({
    summary: () => {
      summaryCalls += 1;
      return summaryCalls === 1
        ? textRes('<html>403 Forbidden</html>', 403)
        : jsonRes({ code: 0, data: { Packages: [{ CycleRemainCapacity: '400' }] } });
    },
    paid: () => jsonRes({ code: 0, data: { Accounts: [pkg(CODE.proMon, 500, 400)], TotalCount: 1 } }),
    free: () => jsonRes({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });
  let slept = 0;

  const result = await fetchAccountCredits(ctx, ACCOUNT, {
    sleep: async () => { slept += 1; },
  });

  assert.equal(result.totalLeft, 400);
  assert.equal(result.groups[0].left, 400);
  assert.equal(summaryCalls, 2);
  assert.equal(slept, 1, '只在两次尝试之间等待一次');
});

test('CreditsError.message 带响应体片段（去换行、≤120 字符），且必然剔除 token', async () => {
  const mock = mockUpstream({
    // 故意让上游把请求头回显到 body 里，验证 message 不会泄漏 token
    summary: ({ headers }) => textRes(`<html>\n<title>403 Forbidden</title>\n${headers.authorization || headers.Authorization}\n</html>`, 403),
    paid: () => jsonRes({}),
    free: () => jsonRes({}),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });

  await assert.rejects(
    fetchAccountCredits(ctx, ACCOUNT, { sleep: async () => {} }),
    (err) => {
      assert.ok(err instanceof CreditsError);
      assert.equal(err.kind, 'http');
      assert.match(err.message, /403 Forbidden/, '片段要能看出是拦截页');
      assert.equal(err.message.includes('\n'), false, '片段必须去掉换行');
      assert.equal(err.message.includes(TOKEN), false, 'message 绝不包含 token');
      assert.ok(err.message.length < 200, `message 过长：${err.message.length}`);
      return true;
    },
  );
});

// ============ 服务层 ============

test('svcAccountCredits：账号不存在抛 404；token 失效映射为 502 + detail.tokenInvalid（不能是 401）', async () => {
  const mock401 = mockUpstream({
    summary: () => jsonRes({}, 401),
    paid: () => jsonRes({}),
    free: () => jsonRes({}),
  });
  const { ctx } = makeCtx({ fetch: mock401, clock: () => NOW });
  await ctx.kv.putAccounts([ACCOUNT]);

  await assert.rejects(svcAccountCredits(ctx, 'acc_missing'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'NOT_FOUND');
    return true;
  });

  await assert.rejects(svcAccountCredits(ctx, 'acc_1'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'UPSTREAM_ERROR', '必须是 502，不能是 401（前端会误判会话过期）');
    assert.equal(err.detail.tokenInvalid, true);
    assert.match(err.message, /Token 已失效/);
    return true;
  });
  assert.equal(ctx.writes(), 1, '额度查询只允许 putAccounts 这一次写，业务查询零写');
});

test('svcAccountCredits：403 不判 tokenInvalid，而是 upstreamBlocked（出口风控，会重试 1 次）', async () => {
  const mock = mockUpstream({
    summary: () => textRes('<html>403 Forbidden</html>', 403),
    paid: () => textRes('<html>403 Forbidden</html>', 403),
    free: () => textRes('<html>403 Forbidden</html>', 403),
  });
  const { ctx } = makeCtx({ fetch: mock, clock: () => NOW });
  await ctx.kv.putAccounts([ACCOUNT]);

  await assert.rejects(
    svcAccountCredits(ctx, 'acc_1', { sleep: async () => {} }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'UPSTREAM_ERROR', 'HTTP 语义仍是 502，不能返回 401/403 给前端');
      assert.equal(err.detail.tokenInvalid !== true, true, '403 绝不能标记 tokenInvalid');
      assert.equal(err.detail.upstreamBlocked, true);
      assert.equal(err.detail.status, 403);
      assert.match(err.message, /拒绝访问/);
      assert.match(err.message, /HTTP 403/);
      assert.equal(String(err.message).includes(TOKEN), false);
      return true;
    },
  );
  // 403 属于非确定性失败 → 重试一次
  assert.equal(mock.calls.filter((call) => call.path === PATHS.summary).length, 2, '403 必须重试 1 次');
});
