// test/frontend-badge-schedule.test.mjs
// 前端无构建、无 DOM 环境：沿用 test/frontend-filename.test.mjs 的做法，
// 用正则从 public/app.js 源码里**原样抽取**函数体，在 Function 沙箱里注入依赖后求值。
// 零新依赖、不引入 jsdom、不改动 public/app.js —— 验证的是生产代码本身，不会与实现漂移。
//
// 覆盖两处日期语义修复：
//   B2 状态徽标必须按「北京日期」过滤 run（昨天 20:37 的 already_checked_in 不得显示成「今日已签」）
//   B5 KPI「下次自动签到」= 启用账号里**真正下一次**的整点，只有「候选小时 < 当前北京小时」才顺延明天
//      （口径是**小时**而非分钟：cron 是 */15，目标小时内 :00/:15/:30/:45 同属一个窗口，
//        与 src/schedule.js 的 accountsDueAt() 一致；所以 02:41 时 2 点窗口还开着，不是明天）
// 外加 B1 / B3 的静态守卫断言。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// 生产调度器：用来做「前端 KPI 口径 == 后端真正会调度的整点」的交叉校验，
// 而不是在测试里再写一份「什么算下一次」的复刻逻辑（复刻一旦和实现同错就永远测不出来）。
import { accountsDueAt, normalizeCheckinHour } from '../src/schedule.js';

const APP_PATH = new URL('../public/app.js', import.meta.url);
const CSS_PATH = new URL('../public/styles.css', import.meta.url);
const CREDITS_PATH = new URL('../src/credits.js', import.meta.url);

/**
 * 读取源码文本并统一换行符。
 * 仓库在 Windows 上检出为 CRLF，若直接对 `\n  position: sticky;` 这类多行锚点做断言会假失败 ——
 * 断言只针对代码内容，不该被平台换行干扰。
 * @param {URL} path
 * @returns {string}
 */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 去掉整行注释，只留代码行。
 * 用途：B3 的字段删除允许保留说明性注释，断言语义应该是「代码里不再引用」而不是「文本里不出现」。
 * @param {string} src
 * @returns {string}
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/** 读取 public/app.js 源码文本。 */
function readApp() {
  return readText(APP_PATH);
}

/** 读取 public/styles.css 源码文本。 */
function readCss() {
  return readText(CSS_PATH);
}

/**
 * 从 public/app.js 里抽出一个具名函数的源码（含 function 关键字到列 0 的闭括号）。
 * @param {string} name 函数名
 * @returns {string}
 */
function functionSource(name) {
  const pattern = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const matched = pattern.exec(readApp());
  assert.ok(matched, `public/app.js 里必须仍存在函数 ${name}`);
  return matched[0];
}

/**
 * 把抽取到的函数放到「显式依赖」的沙箱里求值：所有自由变量都由 deps 注入，
 * 因此可以把「现在是几点」「state.logs 是什么」全部固定下来，不依赖真机时钟。
 * @param {Record<string, *>} deps 自由变量名 -> 值
 * @param {string} name 函数名
 * @returns {Function}
 */
function evalWith(deps, name) {
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...keys, `return (${functionSource(name)});`);
  return factory(...keys.map((key) => deps[key]));
}

/** 从 public/app.js 里取出 CLOCK_FMT 这个 Intl 实例（复用生产定义，避免另写一份时区配置）。 */
function extractClockFmt() {
  const matched = /const CLOCK_FMT = new Intl\.DateTimeFormat\('zh-CN', \{[\s\S]*?\}\);/.exec(readApp());
  assert.ok(matched, 'public/app.js 里必须仍存在 CLOCK_FMT');
  // eslint-disable-next-line no-new-func
  return new Function(`${matched[0]}\nreturn CLOCK_FMT;`)();
}

/**
 * 找出「块注释正文里混进注释终止符（星号紧跟斜杠）」的行。
 * 这不是洁癖：块注释的终止符（星号紧跟斜杠）会**提前闭合注释**，剩下半句被当成代码解析，
 * 浏览器给出的就是整包 SyntaxError —— 整个面板一行 JS 都不执行（白屏）。
 * 踩过的现场：在 JSDoc 里直接写 cron 表达式（`星号 + 斜杠 + 15` 那种写法），
 * 于是注释在那一行就被提前闭合了。
 * @param {string} src
 * @returns {string[]} 形如 `747: *   - wrangler.toml 的 cron 是 ...`
 */
function findCommentTerminatorTraps(src) {
  const traps = [];
  let inBlock = false;
  src.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (!inBlock) {
      if (!trimmed.startsWith('/*')) return;
      inBlock = true;
      // 单行块注释 `/* ... */` 自己就闭合了
      if (trimmed.slice(2).includes('*/')) inBlock = false;
      return;
    }
    // 去掉行首的 `*` 装饰后再找 `*/`；闭合行 ` */` 去掉星号只剩 `/`，不会误报
    const body = trimmed.replace(/^\*+/, '');
    if (body.includes('*/')) traps.push(`${index + 1}: ${trimmed}`);
    if (trimmed.endsWith('*/')) inBlock = false;
  });
  return traps;
}

test('静态守卫：public/app.js 必须能通过语法解析（注释里混入 */ 会让整页 JS 不执行）', () => {
  const src = readText(APP_PATH);

  // 1) 先抓「块注释里写了 */」这个具体陷阱，失败信息直接给行号，比 SyntaxError 好定位
  const traps = findCommentTerminatorTraps(src);
  assert.deepEqual(
    traps,
    [],
    `块注释正文里混入 */ 会提前闭合注释，后续半句被当成代码：\n${traps.join('\n')}`,
  );

  // 2) 再做整体语法检查。只编译不执行，不需要新依赖，也不需要 node --check 子进程。
  //    app.js 里没有 import/export 声明、也没有顶层 await，所以 Function 构造器够用。
  let parseError = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
  } catch (err) {
    parseError = err;
  }
  assert.equal(
    parseError,
    null,
    parseError
      ? `public/app.js 无法解析，浏览器会整包拒绝执行（面板白屏）：${parseError.message}`
      : 'public/app.js 可以正常解析',
  );
});

// ============ 时间锚点（全部写成带 +08:00 的绝对时刻，与机器时区无关） ============

/** 「现在」= 北京 2026-11-15 02:00（真机 bug 场景的同一时刻）。 */
const NOW_BJ_1115_0200 = new Date('2026-11-15T02:00:00+08:00');
/** run 发生在北京 2026-11-14 20:37（= UTC 12:37）。 */
const RUN_BJ_1114_2037 = '2026-11-14T12:37:00.000Z';
/** run 发生在北京 2026-11-14 23:59（= UTC 15:59，跨天前一秒）。 */
const RUN_BJ_1114_2359 = '2026-11-14T15:59:00.000Z';
/** run 发生在北京 2026-11-15 00:00（= UTC 16:00，刚好跨到「今天」）。 */
const RUN_BJ_1115_0000 = '2026-11-14T16:00:00.000Z';
/** run 发生在北京 2026-11-15 09:00。 */
const RUN_BJ_1115_0900 = '2026-11-15T01:00:00.000Z';

/**
 * 构造一个 latestRunTodayFor 沙箱。
 * fmtDateStamp 的默认参数被替换成固定的「现在」，等价于把真机时钟钉在 now 上，
 * 但内部仍然走生产代码里的 Asia/Shanghai 换算（不是复制一份逻辑）。
 * @param {{logs:object[], now?:Date}} params
 * @returns {Function} latestRunTodayFor
 */
function makeTodayFilter({ logs, now = NOW_BJ_1115_0200 }) {
  const realFmtDateStamp = evalWith({}, 'fmtDateStamp');
  const fmtDateStamp = (date = now) => realFmtDateStamp(date);
  return evalWith({ state: { logs }, fmtDateStamp }, 'latestRunTodayFor');
}

/**
 * 构造 statusBadge 沙箱：el 用假的（返回 {tag, cls, text}），其余全用生产代码。
 * @param {{logs:object[], accounts:object[], credits?:object, now?:Date}} params
 * @returns {Function} statusBadge
 */
function makeStatusBadge({ logs, accounts, credits = {}, now = NOW_BJ_1115_0200 }) {
  const realFmtDateStamp = evalWith({}, 'fmtDateStamp');
  const fmtDateStamp = (date = now) => realFmtDateStamp(date);
  const state = { logs, accounts, credits };
  const fakeEl = (tag, className, text) => ({
    tag,
    cls: className || '',
    text: text === undefined || text === null ? '' : String(text),
  });
  const latestRunFor = evalWith({ state }, 'latestRunFor');
  const latestRunTodayFor = evalWith({ state, fmtDateStamp }, 'latestRunTodayFor');
  const resultBadge = evalWith({ el: fakeEl }, 'resultBadge');
  return evalWith(
    { el: fakeEl, state, latestRunTodayFor, latestRunFor, resultBadge },
    'statusBadge',
  );
}

/**
 * 构造 nextCheckinInfo 沙箱。
 * nextCheckinInfo 内部是**无参**调用 beijingMinuteOfDay()，而后者默认 new Date()。
 * 为了不依赖真机时钟，这里注入一个「带固定分钟数」的替代实现：
 * 无参调用返回注入值，带参调用仍走生产实现（保证两种调用口径都被覆盖）。
 *
 * 自由变量只有 state 与 beijingMinuteOfDay —— `nextCheckinHour()` 已被删除，
 * 若这里再注入它，functionSource() 会因源码里找不到该函数而直接断言失败
 * （这正是上一轮 5 条用例集体报错的原因）。
 *
 * @param {{accounts:object[], minuteOfDay:number|Function}} params
 *   minuteOfDay 传函数时每次调用重新求值，便于在一个沙箱里遍历多个时刻（避免反复重编译）。
 * @returns {Function} nextCheckinInfo
 */
function makeNextCheckinInfo({ accounts, minuteOfDay }) {
  const realMinuteOfDay = evalWith({ CLOCK_FMT: extractClockFmt() }, 'beijingMinuteOfDay');
  const clock = typeof minuteOfDay === 'function' ? minuteOfDay : () => minuteOfDay;
  const beijingMinuteOfDay = (date) => (date === undefined ? clock() : realMinuteOfDay(date));
  return evalWith({ state: { accounts }, beijingMinuteOfDay }, 'nextCheckinInfo');
}

// ============ 时间锚点自检：先证明锚点算出来的北京日期符合预期 ============

test('时间锚点自检：fmtDateStamp 按 Asia/Shanghai 换算，与机器时区无关', () => {
  const fmtDateStamp = evalWith({}, 'fmtDateStamp');
  // 20:37Z 之后的 12:37Z 是北京 20:37 当天；16:00Z 是北京次日 00:00
  assert.equal(fmtDateStamp(new Date(RUN_BJ_1114_2037)), '2026-11-14');
  assert.equal(fmtDateStamp(new Date(RUN_BJ_1114_2359)), '2026-11-14');
  assert.equal(fmtDateStamp(new Date(RUN_BJ_1115_0000)), '2026-11-15');
  assert.equal(fmtDateStamp(NOW_BJ_1115_0200), '2026-11-15');
});

// ============ B2：latestRunTodayFor 的日期过滤 ============

test('latestRunTodayFor：昨天 20:37 的 run 不算今天（真机 bug 场景）', () => {
  const latestRunTodayFor = makeTodayFilter({
    logs: [{
      startedAt: RUN_BJ_1114_2037,
      accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }],
    }],
  });
  // 北京时间 11-15 02:00 看「昨天 20:37 的已签」——必须为 null，否则卡片会谎报「今日已签」
  assert.equal(latestRunTodayFor('acc_1'), null);
});

test('latestRunTodayFor：今天 00:00 的 run 命中', () => {
  const latestRunTodayFor = makeTodayFilter({
    logs: [{
      startedAt: RUN_BJ_1115_0000,
      accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }],
    }],
  });
  assert.deepEqual(latestRunTodayFor('acc_1'), {
    result: 'already_checked_in',
    startedAt: RUN_BJ_1115_0000,
  });
});

test('latestRunTodayFor：昨天 23:59 vs 今天 00:00 —— 跨分钟边界只差 1 分钟也不同天', () => {
  const logs = [
    { startedAt: RUN_BJ_1115_0000, accountResults: [{ accountId: 'acc_1', result: 'skipped_disabled' }] },
    { startedAt: RUN_BJ_1114_2359, accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }] },
  ];
  const latestRunTodayFor = makeTodayFilter({ logs });
  // 只认 00:00 那条；23:59 那条同属 acc_1 但必须被日期过滤掉
  assert.equal(latestRunTodayFor('acc_1').startedAt, RUN_BJ_1115_0000);
  assert.equal(latestRunTodayFor('acc_1').result, 'skipped_disabled');

  // 反过来：只有昨天 23:59 那条时必须为 null
  const onlyYesterday = makeTodayFilter({ logs: [logs[1]] });
  assert.equal(onlyYesterday('acc_1'), null);
});

test('latestRunTodayFor：startedAt 非法 / 缺失时跳过而不是抛错', () => {
  const logs = [
    { startedAt: 'not-a-date', accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: '', accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: undefined, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    null,
    { accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: RUN_BJ_1115_0900, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
  ];
  const latestRunTodayFor = makeTodayFilter({ logs });
  // 脏数据被跳过，最终命中今天 09:00 那条（整个过程不得抛异常）
  assert.equal(latestRunTodayFor('acc_1').result, 'checked_in');
  assert.equal(latestRunTodayFor('acc_1').startedAt, RUN_BJ_1115_0900);

  // 全部非法 -> null，仍然不抛
  const allBad = makeTodayFilter({ logs: logs.slice(0, 5) });
  assert.equal(allBad('acc_1'), null);
});

test('latestRunTodayFor：state.logs 是「新 -> 旧」，取今天里最新的一条', () => {
  const logs = [
    { startedAt: RUN_BJ_1115_0900, accountResults: [{ accountId: 'acc_1', result: 'failed' }] },
    { startedAt: RUN_BJ_1115_0000, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] },
    { startedAt: RUN_BJ_1114_2037, accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }] },
  ];
  const latestRunTodayFor = makeTodayFilter({ logs });
  assert.equal(latestRunTodayFor('acc_1').result, 'failed');
  // 昨天那条「已签」不会盖住今天的「失败」
  assert.notEqual(latestRunTodayFor('acc_1').result, 'already_checked_in');
});

test('latestRunTodayFor：只返回该账号自己的结果，不串账号', () => {
  const logs = [{
    startedAt: RUN_BJ_1115_0900,
    accountResults: [
      { accountId: 'acc_1', result: 'checked_in' },
      { accountId: 'acc_2', result: 'failed' },
    ],
  }];
  const latestRunTodayFor = makeTodayFilter({ logs });
  assert.equal(latestRunTodayFor('acc_1').result, 'checked_in');
  assert.equal(latestRunTodayFor('acc_2').result, 'failed');
  assert.equal(latestRunTodayFor('acc_404'), null);
});

// ============ B2：statusBadge 的三态渲染 ============

test('statusBadge：昨天 20:37 的 already_checked_in 必须渲染成「未签到」，不能是「今日已签」', () => {
  const statusBadge = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: true }],
    logs: [{
      startedAt: RUN_BJ_1114_2037,
      accountResults: [{ accountId: 'acc_1', result: 'already_checked_in' }],
    }],
  });
  const badge = statusBadge({ id: 'acc_1', name: '账号1', enabled: true });
  assert.equal(badge.text, '未签到');
  assert.equal(badge.cls, 'badge badge-mute');
  assert.notEqual(badge.text, '今日已签', '这正是被修复的 bug：跨天的已签状态不得延续到今天');
});

test('statusBadge：今天 09:00 的 checked_in 渲染成「签到成功」', () => {
  const statusBadge = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: true }],
    logs: [{
      startedAt: RUN_BJ_1115_0900,
      accountResults: [{ accountId: 'acc_1', result: 'checked_in' }],
    }],
  });
  const badge = statusBadge({ id: 'acc_1', name: '账号1', enabled: true });
  assert.equal(badge.text, '签到成功');
  assert.equal(badge.cls, 'badge badge-ok');
});

test('statusBadge：从未跑过 -> 「未跑过」；今天没有但历史跑过 -> 「未签到」', () => {
  const account = { id: 'acc_1', name: '账号1', enabled: true };
  const never = makeStatusBadge({ accounts: [account], logs: [] });
  assert.equal(never(account).text, '未跑过');
  assert.equal(never(account).cls, 'badge badge-mute');

  const historical = makeStatusBadge({
    accounts: [account],
    logs: [{ startedAt: RUN_BJ_1114_2037, accountResults: [{ accountId: 'acc_1', result: 'checked_in' }] }],
  });
  assert.equal(historical(account).text, '未签到');
  assert.equal(historical(account).cls, 'badge badge-mute');
});

test('statusBadge：禁用 / token 失效的优先级高于日期过滤', () => {
  const logs = [{
    startedAt: RUN_BJ_1115_0900,
    accountResults: [{ accountId: 'acc_1', result: 'checked_in' }],
  }];
  const disabled = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: false }],
    logs,
  });
  assert.equal(disabled({ id: 'acc_1', name: '账号1', enabled: false }).text, '已禁用');

  const tokenBad = makeStatusBadge({
    accounts: [{ id: 'acc_1', name: '账号1', enabled: true }],
    logs,
    credits: { acc_1: { error: { tokenInvalid: true, message: 'Token 已过期' } } },
  });
  const badge = tokenBad({ id: 'acc_1', name: '账号1', enabled: true });
  assert.equal(badge.text, 'token 失效');
  assert.equal(badge.cls, 'badge badge-bad');
});

// ============ B5：beijingMinuteOfDay + nextCheckinInfo ============

test('beijingMinuteOfDay：北京时刻换算成当天第几分钟', () => {
  const beijingMinuteOfDay = evalWith({ CLOCK_FMT: extractClockFmt() }, 'beijingMinuteOfDay');
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T00:00:00+08:00')), 0);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T02:00:00+08:00')), 120);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T08:00:00+08:00')), 480);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T09:30:00+08:00')), 570);
  assert.equal(beijingMinuteOfDay(new Date('2026-11-15T23:59:00+08:00')), 1439);
});

test('nextCheckinInfo：北京 02:00 + hour 8 -> 今天（不带「明天」）', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 2 * 60,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：北京 09:30 + hour 8 -> 明天', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 9 * 60 + 30,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: true });
});

test('nextCheckinInfo：北京 08:00 整 + hour 8 -> 今天（08:00 属同一小时窗口，仍算今天）', () => {
  // 口径是**小时**：08:00-08:59 整段窗口都在跑（cron */15 在 :00/:15/:30/:45 各触发一轮，
  // src/schedule.js 的 accountsDueAt() 只比对北京小时相等）。所以 08:00 时下一次动作
  // 还在今天，不能标「明天」——上一轮写成 hour*60 <= now 的「严格大于」是错的。
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 8 * 60,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：北京 07:59 + hour 8 -> 今天（差一分钟仍属今天）', () => {
  const nextCheckinInfo = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: true, checkinHour: 8 }],
    minuteOfDay: 8 * 60 - 1,
  });
  assert.deepEqual(nextCheckinInfo(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：返回「真正下一次」而不是「最小的小时」（用户实测 02:41 场景）', () => {
  /** @type {object[]} 2 点那个账号 */
  const HOUR_2 = [{ id: 'acc_2', enabled: true, checkinHour: 2 }];
  /** @type {object[]} 8 点那个账号 */
  const HOUR_8 = [{ id: 'acc_8', enabled: true, checkinHour: 8 }];
  /** @type {object[]} 9 点那个账号 */
  const HOUR_9 = [{ id: 'acc_9', enabled: true, checkinHour: 9 }];
  const TWO_AND_NINE = [...HOUR_2, ...HOUR_9];
  const EIGHT_AND_NINE = [...HOUR_8, ...HOUR_9];

  // [2,9] @02:41（用户截图原场景）：2 点窗口还开着，02:45 那轮会跑 -> 今天，不是明天
  assert.deepEqual(
    makeNextCheckinInfo({ accounts: TWO_AND_NINE, minuteOfDay: 2 * 60 + 41 })(),
    { hour: 2, isTomorrow: false },
    '02:41 时 2 点窗口未关，下一次动作是今天 02:45',
  );

  // [2,9] @03:00：最小的小时是 2，但 2 点窗口今天已关；今天还有动作的是 09:00 那个账号
  assert.deepEqual(
    makeNextCheckinInfo({ accounts: TWO_AND_NINE, minuteOfDay: 3 * 60 })(),
    { hour: 9, isTomorrow: false },
    '最小的小时（2）不是下一次，旧实现会在这里错报「02:00 明天」',
  );

  // [2,9] @10:00：两个窗口今天都关了，才回到全局最小值 2 点并标明天
  assert.deepEqual(
    makeNextCheckinInfo({ accounts: TWO_AND_NINE, minuteOfDay: 10 * 60 })(),
    { hour: 2, isTomorrow: true },
  );

  // [8,9] @09:30：9 点窗口内 09:45 还会跑
  assert.deepEqual(
    makeNextCheckinInfo({ accounts: EIGHT_AND_NINE, minuteOfDay: 9 * 60 + 30 })(),
    { hour: 9, isTomorrow: false },
  );

  // [8,9] @08:30：8 点窗口内 08:45 还会跑（8 比 9 早，取更近的那个）
  assert.deepEqual(
    makeNextCheckinInfo({ accounts: EIGHT_AND_NINE, minuteOfDay: 8 * 60 + 30 })(),
    { hour: 8, isTomorrow: false },
  );
});

test('nextCheckinInfo：无启用账号 / 空数组 -> null（KPI 显示 —）', () => {
  const noneEnabled = makeNextCheckinInfo({
    accounts: [{ id: 'acc_1', enabled: false, checkinHour: 8 }],
    minuteOfDay: 2 * 60,
  });
  assert.equal(noneEnabled(), null, '没有启用账号时 KPI 必须显示 —');

  const empty = makeNextCheckinInfo({ accounts: [], minuteOfDay: 2 * 60 });
  assert.equal(empty(), null);
});

test('nextCheckinInfo：禁用账号不参与选取，0 点（falsy 整数）不得被当成「未设置」', () => {
  // 禁用账号的 6 点不许抢走「下一次」
  const withDisabled = makeNextCheckinInfo({
    accounts: [
      { id: 'acc_1', enabled: true, checkinHour: 9 },
      { id: 'acc_2', enabled: true, checkinHour: 8 },
      { id: 'acc_3', enabled: false, checkinHour: 6 },
    ],
    minuteOfDay: 2 * 60,
  });
  assert.deepEqual(withDisabled(), { hour: 8, isTomorrow: false });

  // 0 点是 falsy：写成 `account.checkinHour || 8` 会把它错当默认值 8
  const midnight = makeNextCheckinInfo({
    accounts: [{ id: 'acc_0', enabled: true, checkinHour: 0 }, { id: 'acc_8', enabled: true, checkinHour: 8 }],
    minuteOfDay: 30,
  });
  assert.deepEqual(midnight(), { hour: 0, isTomorrow: false }, '00:30 时 0 点窗口仍开着');

  const midnightPassed = makeNextCheckinInfo({
    accounts: [{ id: 'acc_0', enabled: true, checkinHour: 0 }, { id: 'acc_8', enabled: true, checkinHour: 8 }],
    minuteOfDay: 60,
  });
  assert.deepEqual(midnightPassed(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：重复小时去重；非法/缺失小时回落到 8 点（与 normalizeCheckinHour 一致）', () => {
  const duplicated = makeNextCheckinInfo({
    accounts: [
      { id: 'acc_1', enabled: true, checkinHour: 9 },
      { id: 'acc_2', enabled: true, checkinHour: 9 },
    ],
    minuteOfDay: 10 * 60,
  });
  assert.deepEqual(duplicated(), { hour: 9, isTomorrow: true });

  // 缺失 / null / 非整数 -> 全部按 8 点算（= src/schedule.js 的 DEFAULT_CHECKIN_HOUR）
  const fallback = makeNextCheckinInfo({
    accounts: [
      { id: 'acc_1', enabled: true },
      { id: 'acc_2', enabled: true, checkinHour: null },
      { id: 'acc_3', enabled: true, checkinHour: 8.5 },
    ],
    minuteOfDay: 2 * 60,
  });
  assert.deepEqual(fallback(), { hour: 8, isTomorrow: false });
});

test('nextCheckinInfo：非法 / 越界 / 字符串小时与后端 normalizeCheckinHour 完全同口径', () => {
  // 前端不能自己发明一套「怎么算合法的 0~23 整点」。这里直接拿后端那两个函数当预言机：
  // 越界值退回「取模兜底」（25 -> 1 点）就会和调度器的「25 -> 8 点」分叉，
  // 面板会承诺一个永远不会发生的签到时间。
  const raws = [
    undefined, null, '', '   ', 0, 8, 23, '9', ' 10 ', 24, 25, -1, 8.5, 'abc', true, '0x10',
  ];
  for (const raw of raws) {
    const expected = normalizeCheckinHour(raw);
    // 把「当前小时」设成该账号折成的小时：这一次一定是今天的这一档
    const got = makeNextCheckinInfo({
      accounts: [{ id: 'acc_x', enabled: true, checkinHour: raw }],
      minuteOfDay: expected * 60,
    })();
    assert.deepEqual(
      got,
      { hour: expected, isTomorrow: false },
      `checkinHour=${JSON.stringify(raw)} 应折成后端认可的 ${expected} 点`,
    );
  }
});

test('nextCheckinInfo 与生产调度器 accountsDueAt 逐小时交叉校验（口径不许漂移）', () => {
  /**
   * 北京 2026-11-15 的 hour 点整对应的毫秒。
   * 北京 = UTC+8，所以北京 h 点 = UTC (h-8) 点；Date.UTC 会自动把负数/超过 23 归一成跨日。
   * @param {number} hour
   * @returns {number}
   */
  const beijingMs = (hour) => Date.UTC(2026, 10, 15, hour - 8);

  const configs = [
    [{ id: 'a', enabled: true, checkinHour: 8 }],
    [{ id: 'a', enabled: true, checkinHour: 2 }, { id: 'b', enabled: true, checkinHour: 9 }],
    [{ id: 'a', enabled: true, checkinHour: 0 }, { id: 'b', enabled: true, checkinHour: 23 }],
    [{ id: 'a', enabled: true, checkinHour: 8 }, { id: 'b', enabled: false, checkinHour: 5 }],
    [{ id: 'a', enabled: true, checkinHour: 9 }, { id: 'b', enabled: true, checkinHour: 9 }],
    [{ id: 'a', enabled: true, checkinHour: 23 }],
  ];

  for (const accounts of configs) {
    // 调度器视角：哪几个整点这组账号真的会被调度（用的是生产代码，不是复刻逻辑）
    const dueHours = [];
    for (let hour = 0; hour < 24; hour += 1) {
      if (accountsDueAt(accounts, beijingMs(hour)).length > 0) dueHours.push(hour);
    }
    assert.ok(dueHours.length > 0, '这组账号至少有一个可调度整点');

    // 窗口内的三个代表时刻：:00（刚进窗口）、:30（窗口中段）、:59（窗口最后一分钟）
    for (const minuteOffset of [0, 30, 59]) {
      let minuteOfDay = 0;
      const nextCheckinInfo = makeNextCheckinInfo({ accounts, minuteOfDay: () => minuteOfDay });
      for (let currentHour = 0; currentHour < 24; currentHour += 1) {
        minuteOfDay = currentHour * 60 + minuteOffset;
        const todayPending = dueHours.filter((hour) => hour >= currentHour);
        const expectToday = todayPending.length > 0;
        const label = `hours=[${accounts.map((a) => a.checkinHour).join(',')}] @${currentHour}:${String(minuteOffset).padStart(2, '0')}`;
        assert.deepEqual(
          nextCheckinInfo(),
          { hour: expectToday ? todayPending[0] : dueHours[0], isTomorrow: !expectToday },
          `${label} 的「下一次」与调度器口径不一致`,
        );
      }
    }
  }
});

// ============ B5 静态守卫：单一数据源 + 无参时钟签名 ============

test('B5 静态守卫：public/app.js 里 nextCheckinHour 已彻底不存在（函数与调用点都已删除）', () => {
  // 注：这里只对**代码**严格。若将来有人在注释里写「原 nextCheckinHour 已合并进
  // nextCheckinInfo」这种迁移说明，不应该判失败（与上面 B3 的 switchAt 守卫同一口径）。
  const code = codeOnly(readApp());
  assert.equal(code.includes('nextCheckinHour'), false, '代码里不得再引用 nextCheckinHour');
  // 但函数定义本身必须是真删了，不能只留个空壳或改名后仍导出旧语义
  assert.equal(/function\s+nextCheckinHour\s*\(/.test(readApp()), false, 'nextCheckinHour 定义必须已删除');
});

test('B5 静态守卫：beijingMinuteOfDay 保持 `date = new Date()` 默认参数的无参调用签名', () => {
  // 测试沙箱靠「无参调用走注入时钟」来固定时间，签名一改（比如改成必传参数或
  // Date.now()）所有时间相关用例就会静默失真，必须锁住。
  assert.match(
    readApp(),
    /function beijingMinuteOfDay\(date = new Date\(\)\)/,
    'beijingMinuteOfDay 必须保留 date = new Date() 默认参数',
  );
  // nextCheckinInfo 内部必须真的无参调用它（而不是自己 new Date()）
  assert.match(
    functionSource('nextCheckinInfo'),
    /beijingMinuteOfDay\(\)/,
    'nextCheckinInfo 必须无参调用 beijingMinuteOfDay()，不得自行 new Date()',
  );
  assert.equal(
    /new Date\(\)/.test(functionSource('nextCheckinInfo')),
    false,
    'nextCheckinInfo 不得直接 new Date()，否则时间无法注入',
  );
});

test('B5 静态守卫：KPI / 页头副标题 / 侧栏三处共用同一份 nextCheckinInfo()', () => {
  const code = codeOnly(readApp());
  const definitions = (code.match(/function nextCheckinInfo\(\)/g) || []).length;
  assert.equal(definitions, 1, 'nextCheckinInfo 只能有一份实现，否则同屏两处会对「今天/明天」各说各话');

  // 调用点：renderKpis 一处（KPI 卡片与 #accounts-sub 共用同一份结果）+ renderNav 一处（#side-next）
  const callSites = (code.match(/nextCheckinInfo\(\)/g) || []).length - definitions;
  assert.ok(callSites >= 2, `nextCheckinInfo() 至少要有 2 个调用点（renderKpis / renderNav），实际 ${callSites} 处`);
  const mentions = (code.match(/nextCheckinInfo/g) || []).length;
  assert.ok(mentions >= 3, `app.js 里 nextCheckinInfo 引用计数（含定义）应 ≥ 3，实际 ${mentions}`);

  const kpis = codeOnly(functionSource('renderKpis'));
  // 只求值一次、两个展示位共用同一个 nextInfo —— 这才是「不会各说各话」的真正保证
  assert.equal(
    (kpis.match(/nextCheckinInfo\(\)/g) || []).length,
    1,
    'renderKpis 只应求值一次 nextCheckinInfo()，KPI 与 #accounts-sub 共用该结果',
  );
  assert.ok((kpis.match(/nextInfo/g) || []).length >= 4, 'KPI 卡片与 #accounts-sub 都必须读同一份 nextInfo');
  const nav = codeOnly(functionSource('renderNav'));
  assert.equal((nav.match(/nextCheckinInfo\(\)/g) || []).length, 1, 'renderNav 的 #side-next 必须复用同一份 nextCheckinInfo()');

  // KPI：<small>明天</small> 只在 isTomorrow 时挂上去（今天时不得出现）
  assert.match(
    kpis,
    /nextInfo\.isTomorrow\) nextNode\.appendChild\(el\('small', null, '明天'\)\)/,
    '#kpi-next 的「明天」小字必须受 nextInfo.isTomorrow 控制',
  );
  // 页头副标题：明天时带「明天 」前缀，今天时不带
  assert.match(
    kpis,
    /下次自动 明天 \$\{fmtHour\(nextInfo\.hour\)\}/,
    '#accounts-sub 的明天分支必须带「下次自动 明天 」文案',
  );
  assert.match(
    kpis,
    /下次自动 \$\{fmtHour\(nextInfo\.hour\)\}/,
    '#accounts-sub 的今天分支必须是「下次自动 HH:00」，不带「明天」',
  );
});

// ============ B3：字段移除的静态守卫 ============

/**
 * 找出 app.js 里所有含某个 token 的行，返回 {line, text, isComment}。
 * 用途：允许注释里出现说明文字，但**代码**里不许再渲染该字段。
 * @param {string} token
 * @returns {{line:number, text:string, isComment:boolean}[]}
 */
function findTokenLines(token) {
  return readApp()
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter((item) => item.text.includes(token))
    .map((item) => {
      const trimmed = item.text.trim();
      return { ...item, isComment: trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') };
    });
}

test('B3 静态守卫：public/app.js 里 switchAt 只允许出现在注释中', () => {
  const hits = findTokenLines('switchAt');
  assert.ok(hits.length > 0, '应当保留说明性注释，便于后人理解为什么删了');
  for (const hit of hits) {
    assert.equal(
      hit.isComment,
      true,
      `public/app.js:${hit.line} 仍在代码里使用 switchAt：${hit.text.trim()}`,
    );
  }
});

test('B3 静态守卫：public/app.js 不再有 credit-switch 与「切换时间」渲染文案', () => {
  const src = readApp();
  assert.equal(src.includes('credit-switch'), false, 'credit-switch 类名不应再出现在 app.js');
  assert.equal(src.includes('切换时间：'), false, '不得再有「切换时间：」的展示模板（全角冒号）');
  assert.equal(src.includes('积分切换时间 '), false, '不得再有「积分切换时间 xxx」的展示模板（带尾空格）');
  // 模板字符串形式的渲染也要断掉
  assert.equal(/`切换时间[^`]*\$\{/.test(src), false, '不得用模板字符串渲染切换时间');
});

test('B3 静态守卫：creditBlock 与 accountDetail 的 foot 不再拼 switchAt', () => {
  const credit = codeOnly(functionSource('creditBlock'));
  const detail = codeOnly(functionSource('accountDetail'));
  assert.equal(credit.includes('switchAt'), false, 'creditBlock 不应再读 switchAt');
  assert.equal(credit.includes('credit-switch'), false, 'creditBlock 不应再产出 .credit-switch 节点');
  assert.equal(detail.includes('switchAt'), false, 'accountDetail 不应再读 switchAt');
  // 明细底部仍要保留 Token 状态与操作按钮（只删了 switchAt 一行，不能删漏或删多）
  assert.match(detail, /Token \$\{token\.text\}/, 'detail-foot 仍须展示 Token 状态');
  assert.match(detail, /detailAction\('刷新额度'/, 'detail-foot 仍须保留「刷新额度」');
  assert.match(detail, /detailAction\('测试签到'/, 'detail-foot 仍须保留「测试签到」');
  assert.match(detail, /detailAction\('导出'/, 'detail-foot 仍须保留「导出」');
});

test('B3 静态守卫：src/credits.js 的 switchAt 产出未被误删（后端契约不动）', () => {
  const credits = readText(CREDITS_PATH);
  assert.match(credits, /const switchAt = baseMember/, 'credits.js 仍须计算 switchAt');
  assert.match(credits, /^\s*switchAt,$/m, 'credits.js 的返回对象仍须带 switchAt');
  assert.match(credits, /switchAt:string\|null/, 'JSDoc 里的 switchAt 类型也不能删');
});

// ============ B1：布局的静态守卫 ============

/** 取出 701~900 媒体查询的整块 CSS。 */
function extractMidRangeMedia() {
  const matched = /@media \(min-width: 701px\) and \(max-width: 900px\) \{[\s\S]*?\n\}/.exec(readCss());
  assert.ok(matched, 'public/styles.css 必须存在 701~900 的媒体查询');
  return matched[0];
}

test('B1 静态守卫：701~900 媒体查询同时解掉包含块并浮起 .top-right', () => {
  const block = extractMidRangeMedia();
  assert.match(block, /\.shell \{ position: relative; \}/, '.shell 必须成为新的包含块');
  assert.match(block, /position: static;/, '.topbar 必须降为 static（否则仍是绝对定位包含块）');
  assert.match(block, /backdrop-filter: none;/, 'backdrop-filter 也会创建包含块，必须关掉');
  assert.match(block, /-webkit-backdrop-filter: none;/, 'Safari 前缀同样要关');
  // .top-right 必须是 absolute 且贴到 .shell 顶部
  const topRight = /\n  \.top-right \{[\s\S]*?\n  \}/.exec(block);
  assert.ok(topRight, '块内必须存在 .top-right 规则');
  assert.match(topRight[0], /position: absolute;/, '.top-right 必须 absolute');
  assert.match(topRight[0], /top: 0;/, '.top-right 必须贴顶（第一行）');
  assert.match(topRight[0], /right: 10px;/, '.top-right 必须贴右');
  assert.match(topRight[0], /z-index: 5;/, '图标必须浮在导航行之上且可点');
  // 侧栏要给图标留位置，否则导航项被压住
  const sidebar = /\n  \.sidebar \{[^}]*\}/.exec(block);
  assert.ok(sidebar, '块内必须存在 .sidebar 规则');
  assert.match(sidebar[0], /padding-right: 148px;/, '.sidebar 必须预留图标宽度');
});

test('B1 静态守卫：≥901px 仍是左侧栏 sticky 玻璃顶栏，≤700px 仍是底部 Tab Bar', () => {
  const css = readCss();
  // 全局规则（901px 以上生效）不得被改成 static
  assert.match(css, /^\.topbar \{\n  position: sticky;/m, '桌面端顶栏必须保持 sticky');
  assert.match(css, /^\.sidebar \{\n  position: sticky;/m, '桌面端侧栏必须保持 sticky');
  // 手机断点仍是 fixed 底部 Tab Bar
  assert.match(css, /\.sidebar \{\n    position: fixed;[\s\S]{0,200}?bottom: 0;/, '≤700px 侧栏仍是底部 fixed Tab Bar');
  // 701~900 的规则不得写进无媒体查询的全局作用域
  const globals = css.replace(/@media[\s\S]*$/m, '');
  assert.equal(/\.top-right \{[^}]*position: absolute/.test(globals), false, '绝对定位不得泄漏到全局');
});

test('B1 静态守卫：.credit-switch 的 CSS 规则已随字段一起删除', () => {
  assert.equal(readCss().includes('.credit-switch'), false, 'styles.css 里不应再有 .credit-switch 规则');
});
