// test/frontend-filename.test.mjs
// 前端无构建、无 DOM 环境，这里只用「读源码 + 抽取纯函数」的方式做静态与纯函数验证，
// 不引入 jsdom 等新依赖，也不改动 public/app.js 的结构。
// 覆盖：导出文件名净化、单账号导出的请求拼装与按钮位置、busy 状态不再有布尔残留。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP_PATH = new URL('../public/app.js', import.meta.url);
const HTML_PATH = new URL('../public/index.html', import.meta.url);

/** 读取前端源码。 */
function readApp() {
  return readFileSync(APP_PATH, 'utf8');
}

/**
 * 从 public/app.js 里原样抽取一个具名函数并在沙箱里求值。
 * 好处：验证的是生产代码，不是「复制一份的等价逻辑」，避免测试与实现漂移。
 * @param {string} name 函数名
 * @returns {Function}
 */
function extractFunction(name) {
  const pattern = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const matched = pattern.exec(readApp());
  assert.ok(matched, `public/app.js 里必须仍存在函数 ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${matched[0]});`)();
}

const sanitizeFilenamePart = extractFunction('sanitizeFilenamePart');

test('sanitizeFilenamePart：Windows/macOS 非法字符与控制字符全部替换为 _', () => {
  assert.equal(sanitizeFilenamePart('a/b', 'acc_1'), 'a_b');
  assert.equal(sanitizeFilenamePart('a\\b', 'acc_1'), 'a_b');
  assert.equal(sanitizeFilenamePart('a:b*c?d"e<f>g|h', 'acc_1'), 'a_b_c_d_e_f_g_h');
  assert.equal(sanitizeFilenamePart('tab\tnull\u0000del\u007f', 'acc_1'), 'tab_null_del_');
});

test('sanitizeFilenamePart：保留中文与常规字符，便于用户认出是哪个账号', () => {
  assert.equal(sanitizeFilenamePart('主账号', 'acc_1'), '主账号');
  assert.equal(sanitizeFilenamePart('落榜美術僧', 'acc_1'), '落榜美術僧');
  assert.equal(sanitizeFilenamePart('acc-1_备用', 'acc_1'), 'acc-1_备用');
});

test('sanitizeFilenamePart：去掉首尾空白与点号，纯点号名回退到账号 id', () => {
  assert.equal(sanitizeFilenamePart('  .隐藏.  ', 'acc_1'), '隐藏');
  for (const bad of ['', '   ', '.', '..', '...', ' . ']) {
    assert.equal(sanitizeFilenamePart(bad, 'acc_1'), 'acc_1', `${JSON.stringify(bad)} 必须回退`);
  }
  // 空名 + 空兜底 -> 常量兜底，绝不产出 "workbuddy_account__<日期>.json" 这种无意义文件名
  assert.equal(sanitizeFilenamePart('', ''), 'account');
  assert.equal(sanitizeFilenamePart(undefined, undefined), 'account');
  assert.equal(sanitizeFilenamePart(null, 'a/b'), 'a_b', '兜底值本身也要净化');
});

test('sanitizeFilenamePart：路径穿越序列不会逃出目录分隔符', () => {
  // 分隔符先变 _，再把开头的点去掉 -> 只剩一段不含分隔符的普通名字
  assert.equal(sanitizeFilenamePart('../../etc/passwd', 'acc_1'), '_.._etc_passwd');
  assert.equal(sanitizeFilenamePart('a/b/../../c', 'acc_1'), 'a_b_.._.._c');
  for (const evil of ['../x', '..\\x', '/etc/passwd', 'C:\\Windows', 'a\u0000/../b']) {
    const part = sanitizeFilenamePart(evil, 'acc_1');
    assert.equal(/[/\\]/.test(part), false, `${evil} 净化后不得残留目录分隔符`);
    assert.equal(part.startsWith('.'), false, `${evil} 净化后不得以点号开头`);
    assert.equal(part.endsWith('.'), false, `${evil} 净化后不得以点号结尾`);
  }
});

test('sanitizeFilenamePart：超长名截断到 64 字符', () => {
  const part = sanitizeFilenamePart('x'.repeat(100), 'acc_1');
  assert.equal(part.length, 64);
  assert.equal(part, 'x'.repeat(64));
  // 中文按字符计，不会被切坏
  assert.equal(sanitizeFilenamePart('账'.repeat(80), 'acc_1').length, 64);
});

test('单账号导出：请求 URL 用 encodeURIComponent 拼 id，返回值按数组直接下载（无二次包裹）', () => {
  const src = readApp();
  assert.match(src, /\/api\/accounts\/export\?id=\$\{encodeURIComponent\(/, '导出 URL 必须编码 id');
  // downloadJson 拿到的是后端返回的数组本身，而不是 { data: [...] }
  const exportBlock = /async function doExportAccount\(account\)[\s\S]*?\n\}/.exec(src);
  assert.ok(exportBlock, 'public/app.js 里必须存在 doExportAccount');
  assert.match(exportBlock[0], /const list = Array\.isArray\(data\) \? data : \[\];/);
  assert.match(exportBlock[0], /downloadJson\(`workbuddy_account_\$\{part\}_\$\{fmtDateStamp\(\)\}\.json`, list\)/);
  // 全量导出保持旧文件名
  const allBlock = /async function doExportAccounts\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(allBlock, 'public/app.js 里必须存在 doExportAccounts');
  assert.match(allBlock[0], /downloadJson\(`workbuddy_accounts_\$\{fmtDateStamp\(\)\}\.json`, data\)/);
  assert.match(allBlock[0], /api\('\/api\/accounts\/export'\)/, '全量导出不得带 id 参数');
});

test('单账号导出按钮：位于 .acc-card-foot 内，且与其它按钮同样式', () => {
  const src = readApp();
  const cardBlock = /function accountCard\(account\)[\s\S]*?\n\}/.exec(src);
  assert.ok(cardBlock, 'public/app.js 里必须存在 accountCard');
  const body = cardBlock[0];
  const footIndex = body.indexOf("el('div', 'acc-card-foot')");
  const exportIndex = body.indexOf('const exportBtn =');
  assert.ok(footIndex > -1, '必须仍存在 .acc-card-foot 容器');
  assert.ok(exportIndex > -1, '必须存在卡片内导出按钮');
  assert.ok(exportIndex > footIndex, '导出按钮必须在 .acc-card-foot 之后创建（即在卡片底部操作区）');
  assert.match(body, /foot\.appendChild\(exportBtn\)/, '导出按钮必须挂到 foot 上');
  assert.match(body, /el\('button', `btn btn-ghost btn-sm\$\{exporting \? ' is-busy' : ''\}`, '导出'\)/);
  assert.match(body, /exportBtn\.disabled = exporting;/, '按账号粒度禁用');
  assert.match(body, /exportBtn\.setAttribute\('aria-busy', exporting \? 'true' : 'false'\)/);
  assert.match(body, /exportBtn\.addEventListener\('click', \(\) => askExportAccount\(account\)\)/);
  assert.match(body, /const exporting = isExporting\(account\.id\);/);
  // 不能出现在 card-head（head 里只有编辑/删除）
  const headBlock = /const head = el\('div', 'acc-card-head'\)[\s\S]*?card\.appendChild\(head\)/.exec(body);
  assert.ok(headBlock, '必须仍存在 acc-card-head');
  assert.equal(headBlock[0].includes('exportBtn'), false, '导出按钮不得出现在 card-head');
});

test('导出忙碌态：state.busy.export 只有 .all / .ids 语义，无布尔残留', () => {
  const src = readApp();
  assert.equal(/busy\.export\s*=\s*(true|false)/.test(src), false, 'busy.export 不得被整体赋值为布尔');
  assert.equal(/\(state\.busy\.export\)/.test(src), false, '不得把 busy.export 当布尔判断');
  assert.equal(/!state\.busy\.export\b(?!\.)/.test(src), false, '不得对 busy.export 取反后当布尔用');
  assert.match(src, /export: \{ all: false, ids: new Set\(\) \}/, 'state.busy.export 必须是 {all, ids}');
  assert.match(src, /function isExporting\(accountId\) \{\s*return state\.busy\.export\.ids\.has\(String\(accountId \|\| ''\)\);/);
  // 全部导出按钮的禁用态由 .all 驱动
  assert.match(src, /exportAllBtn\.disabled = state\.busy\.export\.all;/);
});

test('确认弹窗：单账号文案含账号名与「明文 token」警示；顶部按钮仍绑定全部导出', () => {
  const src = readApp();
  const askBlock = /function askExportAccount\(account\)[\s\S]*?\n\}/.exec(src);
  assert.ok(askBlock, '必须存在 askExportAccount');
  assert.match(askBlock[0], /「\$\{name\}」/, '弹窗文案必须带账号名');
  assert.match(askBlock[0], /明文/, '弹窗必须保留明文 token 警示');
  assert.match(askBlock[0], /askConfirm\(/);
  assert.match(src, /\$\('#btn-export-accounts'\)\.addEventListener\('click', askExportAccounts\)/);

  const html = readFileSync(HTML_PATH, 'utf8');
  const btn = /<button id="btn-export-accounts"[\s\S]*?<\/button>/.exec(html);
  assert.ok(btn, 'index.html 必须保留 #btn-export-accounts');
  assert.match(btn[0], /导出全部/, '顶部按钮文案应为「导出全部」');
});
