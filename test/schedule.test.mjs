// test/schedule.test.mjs
// 覆盖：北京时间换算、每账号签到小时解析与自动错开、到点账号筛选、待签账号计算、
//       当日进度合并、完成判定。
//
// 关键约定：面板与存储用的都是**北京时间整点**（0~23），UTC 只在「scheduledTime -> 北京小时」
// 这一步出现（beijingParts），其余地方不做来回换算。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountsDueAt,
  beijingHourText,
  beijingParts,
  DEFAULT_CHECKIN_HOUR,
  isDayComplete,
  isDoneResult,
  mergeDayRecord,
  normalizeCheckinHour,
  parseCheckinHour,
  pendingAccountIds,
  pickNextCheckinHour,
  utcHourText,
} from '../src/schedule.js';

/** UTC 时刻 -> 毫秒。 */
function utc(y, mo, d, h, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

// ============ 时区换算 ============

test('beijingParts：UTC 00:00 是北京时间同日 08:00', () => {
  const { date, hour } = beijingParts(utc(2026, 11, 14, 0, 0));
  assert.equal(date, '2026-11-14');
  assert.equal(hour, 8);
});

test('beijingParts：UTC 16:00 已经跨到北京时间的第二天 00:00', () => {
  const { date, hour } = beijingParts(utc(2026, 11, 13, 16, 0));
  assert.equal(date, '2026-11-14');
  assert.equal(hour, 0);
});

test('beijingParts：UTC 23:45 对应北京时间次日 07:45', () => {
  const { date, hour } = beijingParts(utc(2026, 11, 13, 23, 45));
  assert.equal(date, '2026-11-14');
  assert.equal(hour, 7);
});

test('beijingParts：跨月边界——UTC 10-31 16:00 已是北京 11-01 00:00', () => {
  const { date, hour } = beijingParts(utc(2026, 10, 31, 16, 0));
  assert.equal(date, '2026-11-01');
  assert.equal(hour, 0);
});

test('beijingParts：跨年边界——UTC 12-31 16:00 已是北京次年 01-01 00:00', () => {
  const { date, hour } = beijingParts(utc(2026, 12, 31, 16, 0));
  assert.equal(date, '2027-01-01');
  assert.equal(hour, 0);
});

test('beijingParts：跨年边界——UTC 12-31 15:59 仍是北京 12-31 23:59', () => {
  const { date, hour } = beijingParts(utc(2026, 12, 31, 15, 59));
  assert.equal(date, '2026-12-31');
  assert.equal(hour, 23);
});

test('beijingParts：UTC 16:00~23:59（北京次日 0 点~8 点）日期归属正确', () => {
  // UTC 16:00 = 北京 00:00（次日）
  const t1 = beijingParts(utc(2026, 6, 15, 16, 0));
  assert.equal(t1.date, '2026-06-16');
  assert.equal(t1.hour, 0);
  // UTC 19:00 = 北京 03:00（次日）
  const t2 = beijingParts(utc(2026, 6, 15, 19, 0));
  assert.equal(t2.date, '2026-06-16');
  assert.equal(t2.hour, 3);
  // UTC 23:45 = 北京 07:45（次日）
  const t3 = beijingParts(utc(2026, 6, 15, 23, 45));
  assert.equal(t3.date, '2026-06-16');
  assert.equal(t3.hour, 7);
});

test('beijingParts：非法时间戳不抛错（回落 1970）', () => {
  const { date, hour } = beijingParts(NaN);
  assert.equal(typeof date, 'string');
  assert.equal(Number.isInteger(hour), true);
});

test('utcHourText：北京整点换算成对应 UTC 钟点（跨日只关心钟点）', () => {
  assert.equal(utcHourText(8), '00:00');
  assert.equal(utcHourText(9), '01:00');
  assert.equal(utcHourText(0), '16:00');
  assert.equal(utcHourText(23), '15:00');
});

test('beijingHourText：整点补零展示', () => {
  assert.equal(beijingHourText(8), '08:00');
  assert.equal(beijingHourText(0), '00:00');
  assert.equal(beijingHourText(23), '23:00');
});

// ============ 签到小时解析 ============

test('parseCheckinHour：只接受 0~23 的整数，非法返回 null', () => {
  assert.equal(parseCheckinHour(0), 0);
  assert.equal(parseCheckinHour(23), 23);
  assert.equal(parseCheckinHour('8'), 8, '纯数字字符串应被接受（表单传值）');
  for (const bad of [24, -1, 5.5, NaN, Infinity, 'abc', '', null, undefined, {}, []]) {
    assert.equal(parseCheckinHour(bad), null, `${JSON.stringify(bad)} 应判非法`);
  }
});

test('normalizeCheckinHour：非法/缺失回落默认 8 点', () => {
  assert.equal(normalizeCheckinHour(10), 10);
  assert.equal(normalizeCheckinHour(undefined), DEFAULT_CHECKIN_HOUR);
  assert.equal(normalizeCheckinHour('abc'), DEFAULT_CHECKIN_HOUR);
  assert.equal(normalizeCheckinHour(99), DEFAULT_CHECKIN_HOUR);
});

// ============ 自动错开 ============

test('pickNextCheckinHour：显式值优先', () => {
  assert.equal(pickNextCheckinHour([{ checkinHour: 8 }], 15), 15);
  assert.equal(pickNextCheckinHour([{ checkinHour: 8 }], 0), 0, '0 点必须被当成合法值');
});

test('pickNextCheckinHour：没指定时从 8 点起找空位，避免新账号扎堆', () => {
  assert.equal(pickNextCheckinHour([], null), 8);
  assert.equal(pickNextCheckinHour([{ checkinHour: 8 }], null), 9);
  assert.equal(pickNextCheckinHour([{ checkinHour: 8 }, { checkinHour: 9 }], null), 10);
});

test('pickNextCheckinHour：中间有空位就补中间，而不是一路往后排', () => {
  const accounts = [{ checkinHour: 8 }, { checkinHour: 10 }];
  assert.equal(pickNextCheckinHour(accounts, null), 9);
});

test('pickNextCheckinHour：24 个整点都被占满时回落默认值', () => {
  const accounts = Array.from({ length: 24 }, (_, h) => ({ checkinHour: h }));
  assert.equal(pickNextCheckinHour(accounts, null), DEFAULT_CHECKIN_HOUR);
});

test('pickNextCheckinHour：非法显式值（24）当成没指定', () => {
  assert.equal(pickNextCheckinHour([], 24), 8);
});

// ============ 到点账号筛选 ============

const A8 = { id: 'acc_8', enabled: true, checkinHour: 8 };
const A9 = { id: 'acc_9', enabled: true, checkinHour: 9 };
const A8_DISABLED = { id: 'acc_8_off', enabled: false, checkinHour: 8 };
const A_DEFAULT = { id: 'acc_default', enabled: true };

test('accountsDueAt：只返回签到小时等于当前北京小时的启用账号', () => {
  const accounts = [A8, A9, A8_DISABLED, A_DEFAULT];
  // UTC 00:00 = 北京 08:00
  assert.deepEqual(accountsDueAt(accounts, utc(2026, 11, 14, 0, 0)).map((a) => a.id), ['acc_8', 'acc_default']);
  // UTC 01:00 = 北京 09:00
  assert.deepEqual(accountsDueAt(accounts, utc(2026, 11, 14, 1, 0)).map((a) => a.id), ['acc_9']);
});

test('accountsDueAt：同一小时内 4 次轮询都能命中，不会漏窗口', () => {
  for (const minute of [0, 15, 30, 45]) {
    const due = accountsDueAt([A8], utc(2026, 11, 14, 0, minute));
    assert.equal(due.length, 1, `:${minute} 应命中`);
  }
});

test('accountsDueAt：没有签到时间的账号按默认 8 点算', () => {
  assert.equal(accountsDueAt([A_DEFAULT], utc(2026, 11, 14, 0, 0)).length, 1);
  assert.equal(accountsDueAt([A_DEFAULT], utc(2026, 11, 14, 1, 0)).length, 0);
});

test('accountsDueAt：脏数据不炸（null / 无 id / 字符串小时）', () => {
  const accounts = [null, { enabled: true }, { id: 'acc_str', enabled: true, checkinHour: '8' }];
  assert.deepEqual(accountsDueAt(accounts, utc(2026, 11, 14, 0, 0)).map((a) => a.id), ['acc_str']);
});

test('accountsDueAt：非数组输入返回空数组', () => {
  assert.deepEqual(accountsDueAt(null, utc(2026, 11, 14, 0, 0)), []);
});

// ============ 待签账号 ============

const ACC1 = { id: 'acc_1', enabled: true };
const ACC2 = { id: 'acc_2', enabled: true };
const DATE = '2026-11-14';

test('pendingAccountIds：没有当日记录时全部待签', () => {
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], null, DATE), ['acc_1', 'acc_2']);
});

test('pendingAccountIds：记录是昨天的等于没记录', () => {
  const day = { date: '2026-11-13', accounts: { acc_1: { result: 'checked_in' } } };
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], day, DATE), ['acc_1', 'acc_2']);
});

test('pendingAccountIds：已成功的账号被排除，失败的不写记录所以仍待签', () => {
  const day = {
    date: DATE,
    accounts: { acc_1: { result: 'checked_in' }, acc_2: { result: 'failed' } },
  };
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], day, DATE), ['acc_2']);
});

test('pendingAccountIds：already_checked_in 也算完成（幂等语义）', () => {
  const day = { date: DATE, accounts: { acc_1: { result: 'already_checked_in' } } };
  assert.deepEqual(pendingAccountIds([ACC1, ACC2], day, DATE), ['acc_2']);
});

test('pendingAccountIds：脏账号（无 id）被过滤掉', () => {
  assert.deepEqual(pendingAccountIds([ACC1, { enabled: true }, null], null, DATE), ['acc_1']);
});

// ============ 合并当日进度 ============

test('mergeDayRecord：只写入成功结果，失败不入库', () => {
  const merged = mergeDayRecord(null, DATE, [
    { accountId: 'acc_1', result: 'checked_in' },
    { accountId: 'acc_2', result: 'failed' },
  ], '2026-11-14T00:01:00.000Z');

  assert.ok(merged);
  assert.equal(merged.date, DATE);
  assert.deepEqual(Object.keys(merged.accounts), ['acc_1']);
  assert.equal(merged.accounts.acc_1.result, 'checked_in');
  assert.equal(merged.accounts.acc_1.at, '2026-11-14T00:01:00.000Z');
});

test('mergeDayRecord：跨天的旧记录不继承', () => {
  const old = { date: '2026-11-13', accounts: { acc_1: { result: 'checked_in' } } };
  const merged = mergeDayRecord(old, DATE, [{ accountId: 'acc_2', result: 'checked_in' }], 'T');
  assert.deepEqual(Object.keys(merged.accounts), ['acc_2']);
});

test('mergeDayRecord：同一天已有记录时做增量合并', () => {
  const old = { date: DATE, accounts: { acc_1: { result: 'checked_in', at: 'A' } } };
  const merged = mergeDayRecord(old, DATE, [{ accountId: 'acc_2', result: 'checked_in' }], 'B');
  assert.deepEqual(Object.keys(merged.accounts).sort(), ['acc_1', 'acc_2']);
  assert.equal(merged.accounts.acc_1.at, 'A', '已有条目不被覆盖');
});

test('mergeDayRecord：没有任何成功时返回 null，调用方据此跳过写入', () => {
  assert.equal(mergeDayRecord(null, DATE, [{ accountId: 'acc_1', result: 'failed' }], 'T'), null);
  const old = { date: DATE, accounts: { acc_1: { result: 'checked_in', at: 'A' } } };
  assert.equal(mergeDayRecord(old, DATE, [], 'T'), null, '无变化不应触发写');
});

test('mergeDayRecord：结果与上次完全相同时不重复写', () => {
  const old = { date: DATE, accounts: { acc_1: { result: 'checked_in', at: 'A' } } };
  assert.equal(mergeDayRecord(old, DATE, [{ accountId: 'acc_1', result: 'checked_in' }], 'B'), null);
});

// ============ 完成判定 ============

test('isDayComplete：全部成功才 true', () => {
  const day = { date: DATE, accounts: { acc_1: { result: 'checked_in' }, acc_2: { result: 'already_checked_in' } } };
  assert.equal(isDayComplete([ACC1, ACC2], day, DATE), true);
  assert.equal(isDayComplete([ACC1, ACC2, { id: 'acc_3' }], day, DATE), false);
  assert.equal(isDayComplete([], null, DATE), true, '没有到点账号视为无事可做');
});

test('isDoneResult：只有两类结果算完成', () => {
  assert.equal(isDoneResult('checked_in'), true);
  assert.equal(isDoneResult('already_checked_in'), true);
  assert.equal(isDoneResult('failed'), false);
  assert.equal(isDoneResult('skipped_disabled'), false);
});
