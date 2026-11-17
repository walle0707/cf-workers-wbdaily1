// test/qa-timezone.test.mjs
// QA 独立回归验证（时区 UTC+8 修复）——不复用工程师的断言，自建输入实测：
//   1) timeMs：无时区字符串按北京时间解析（空格/T 分隔、有/无秒、带毫秒）
//   2) timeMs：显式时区（Z / +00:00 / -05:00 / +0800）不得被误加 +08:00
//   3) computeCredits：北京语义的过期时间驱动「即将过期」（3 天）与过期剔除
//   4) beijingDateTimeText：北京时间文本，跨年/闰日边界归属
//   5) beijingParts：闰日边界（UTC 2/28 16:00 -> 北京 2/29 00:00）
//   6) svcAccountCredits：401 消息里的 expiresText 用北京时间文本

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCredits, svcAccountCredits } from '../src/credits.js';
import { beijingDateTimeText, beijingParts } from '../src/schedule.js';
import { AppError, b64urlEncodeText } from '../src/util.js';
import { makeCtx } from './helpers/harness.mjs';

/** UTC 时刻 -> 毫秒。 */
function utc(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

const NOW = Date.parse('2026-11-14T08:00:00Z'); // 北京 2026-11-14 16:00
const CODE_ACTIVITY = 'TCACA_code_007_nzdH5h4Nl0';

/** 最小资源包：赠送包（benefit），到期时间可覆盖。 */
function benefitPkg(expiry) {
  return {
    PackageCode: CODE_ACTIVITY,
    Status: 0,
    CycleCapacitySizePrecise: '100',
    CycleCapacityRemainPrecise: '70',
    ...(expiry === undefined ? {} : { DeductionEndTime: expiry }),
  };
}

/** benefit 分组的 time 字段（ISO UTC）。 */
function benefitTimeOf(result) {
  const group = result.groups.find((g) => g.key === 'benefit');
  return group ? group.time : null;
}

// ============ timeMs：无时区 -> 北京（经 computeCredits 的 benefit.time 实测）============

test('timeMs：空格分隔、无秒 "2026-11-14 16:17" 按北京解析为 UTC 08:17', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14 16:17')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T08:17:00.000Z');
});

test('timeMs：T 分隔、无秒 "2026-11-14T16:17" 按北京解析为 UTC 08:17', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14T16:17')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T08:17:00.000Z');
});

test('timeMs：带毫秒的无时区字符串同样按北京解析', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14 16:17:00.500')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T08:17:00.500Z');
});

// ============ timeMs：显式时区不得被误加 +08:00 ============

test('timeMs："+00:00" 显式偏移按原样解析，不追加 +08:00', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14T16:17:00+00:00')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T16:17:00.000Z', '+00:00 必须是 UTC 16:17，不是 08:17');
});

test('timeMs："-05:00" 显式偏移按原样解析（UTC 21:17）', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14T16:17:00-05:00')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T21:17:00.000Z');
});

test('timeMs：无冒号 "+0800" 偏移识别为显式时区（不双重追加）', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14T16:17+0800')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T08:17:00.000Z', '+0800 应等价 +08:00，而非变成 NaN/再加 8 小时');
});

test('timeMs：小写 "z" 后缀按 UTC 解析', () => {
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14T16:17:00z')] }, NOW);
  assert.equal(benefitTimeOf(result), '2026-11-14T16:17:00.000Z');
});

// ============ 过期语义回归：北京时间驱动剔除与「即将过期」============

test('computeCredits：北京已过期的包必须剔除（旧 bug 会按 UTC 多活 8 小时）', () => {
  // 北京 2026-11-14 12:00:00 = UTC 04:00，早于 NOW(08:00Z)，已过期
  const result = computeCredits({ summary: null, resources: [benefitPkg('2026-11-14 12:00:00')] }, NOW);
  assert.equal(
    result.groups.find((g) => g.key === 'benefit'),
    undefined,
    '北京 12:00 到期在 16:00 查询时必须已剔除；按 UTC 解析会误判为 20:00 才过期',
  );
});

test('computeCredits：「即将过期」3 天窗口按北京时间计算', () => {
  // 北京 2026-11-17 15:59 = UTC 07:59，距 NOW(2026-11-14T08:00Z) 不足 3 天 -> 预警
  const near = computeCredits({ summary: null, resources: [benefitPkg('2026-11-17 15:59:00')] }, NOW);
  const nearGroup = near.groups.find((g) => g.key === 'benefit');
  assert.equal(nearGroup.expiring, true, '3 天差 1 分钟内必须预警');
  assert.equal(nearGroup.time, '2026-11-17T07:59:00.000Z');

  // 北京 2026-11-17 16:01 = UTC 08:01，超过 3 天窗口 -> 不预警
  const far = computeCredits({ summary: null, resources: [benefitPkg('2026-11-17 16:01:00')] }, NOW);
  const farGroup = far.groups.find((g) => g.key === 'benefit');
  assert.equal(farGroup.expiring, false, '超过 3 天窗口不得预警');
  assert.equal(farGroup.time, '2026-11-17T08:01:00.000Z');
});

// ============ beijingDateTimeText ============

test('beijingDateTimeText：常规时刻输出北京 YYYY-MM-DD HH:MM', () => {
  assert.equal(beijingDateTimeText(utc(2026, 11, 14, 8, 0)), '2026-11-14 16:00');
  assert.equal(beijingDateTimeText(utc(2026, 11, 14, 0, 30)), '2026-11-14 08:30');
});

test('beijingDateTimeText：UTC 15:59 vs 16:00 跨年边界日期归属', () => {
  assert.equal(beijingDateTimeText(utc(2026, 12, 31, 15, 59)), '2026-12-31 23:59');
  assert.equal(beijingDateTimeText(utc(2026, 12, 31, 16, 0)), '2027-01-01 00:00');
});

test('beijingDateTimeText：午夜（ICU 偶发 24 点写法）归一为 00:00', () => {
  assert.equal(beijingDateTimeText(utc(2026, 6, 15, 16, 0)), '2026-06-16 00:00');
  assert.equal(beijingDateTimeText(utc(2026, 6, 15, 15, 59)), '2026-06-15 23:59');
});

// ============ beijingParts：闰日等刁钻边界 ============

test('beijingParts：闰年 UTC 2/28 16:00 -> 北京 2/29 00:00', () => {
  const { date, hour } = beijingParts(utc(2028, 2, 28, 16, 0));
  assert.equal(date, '2028-02-29');
  assert.equal(hour, 0);
});

test('beijingParts：平年 UTC 2/28 16:00 -> 北京 3/1 00:00', () => {
  const { date, hour } = beijingParts(utc(2027, 2, 28, 16, 0));
  assert.equal(date, '2027-03-01');
  assert.equal(hour, 0);
});

test('beijingParts 与 beijingDateTimeText 日期口径一致（同刻同日）', () => {
  for (const ms of [utc(2026, 12, 31, 15, 59), utc(2026, 12, 31, 16, 0), utc(2028, 2, 28, 16, 0)]) {
    const { date } = beijingParts(ms);
    assert.equal(beijingDateTimeText(ms).slice(0, 10), date, `t=${ms} 两接口日期必须一致`);
  }
});

// ============ expiresText：svcAccountCredits 401 消息用北京时间 ============

/** 构造带 exp 的 JWT（仅测试用，签名随意）。 */
function jwtWithExp(expMs) {
  return `qa.${b64urlEncodeText(JSON.stringify({ exp: Math.floor(expMs / 1000) }))}.sig`;
}

test('svcAccountCredits：401 且无 refresh_token 时，过期文本是北京时间', async () => {
  // token 过期时刻：UTC 2026-11-14 07:00 = 北京 15:00（早于 NOW，expired=true）
  const expMs = utc(2026, 11, 14, 7, 0);
  const account = { id: 'acc_qa', name: 'QA', token: jwtWithExp(expMs), uid: 'u-qa' };

  const fetch401 = async () => new Response(JSON.stringify({}), { status: 401 });
  const { ctx } = makeCtx({ fetch: fetch401, clock: () => NOW });
  await ctx.kv.putAccounts([account]);

  await assert.rejects(svcAccountCredits(ctx, 'acc_qa'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'UPSTREAM_ERROR');
    assert.equal(err.detail.tokenInvalid, true);
    assert.equal(err.detail.expired, true);
    assert.match(err.message, /已于 2026-11-14 15:00 过期/, `消息应含北京时间，实际：${err.message}`);
    assert.doesNotMatch(err.message, /已于 2026-11-14 07:00 过期/, '不得输出 UTC 文本');
    assert.doesNotMatch(err.message, /T\d{2}:\d{2}/, '不得是 ISO(T 分隔)样式');
    return true;
  });
});
