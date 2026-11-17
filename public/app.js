// public/app.js
// 零构建原生前端：单 state + 全量 render，无框架 / 无 CDN / 无内联事件。
// 安全约定：所有来自服务端或用户的文本一律走 textContent；
// innerHTML 只用于本地静态常量（图标 symbol id 映射）。
//
// 分层（顺序不可打乱）：
//   state → 格式化/小工具 → 渲染层（render*） → 网络层（api） → 数据加载（load*） → 动作 → 事件绑定

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/**
 * 图标 symbol id 映射（值与 index.html 里的 <symbol id="…"> 一一对应）。
 * 只做 id 映射，不再持有 24×24 path：静态 HTML 与动态渲染必须共用同一套描边风格。
 */
const ICONS = Object.freeze({
  plus: 'i-plus',
  play: 'i-play',
  edit: 'i-edit',
  trash: 'i-trash',
  upload: 'i-upload',
  download: 'i-download',
  chev: 'i-chev',
  check: 'i-check',
  search: 'i-search',
  users: 'i-users',
  clock: 'i-clock',
  coins: 'i-coins',
});

/** Asia/Shanghai 时间格式（月/日 时:分）。 */
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 只有时:分（Asia/Shanghai，用于「今天 09:00」）。 */
const CLOCK_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 积分/额度数字格式（最多两位小数）。 */
const CREDIT_FMT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

/** 完整日期时间（年/月/日 时:分，Asia/Shanghai）。 */
const DATETIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 栏目（分页）名称 + 标题。 */
const PAGES = Object.freeze({ accounts: '账号概览', logs: '执行记录', settings: '设置' });

/** 默认文档标题（登出 / 非面板视图时复原）。 */
const DEFAULT_TITLE = 'WorkBuddy Daily · 自动签到';

/** localStorage 包装：隐私模式下 localStorage 会抛，一律吞掉。 */
const store = {
  /**
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  /**
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 隐私模式 / 配额满：静默忽略，功能不降级 */
    }
  },
};

/** 全局状态（唯一真相，驱动全量渲染）。 */
const state = {
  view: 'boot',
  /** 面板栏目：'accounts' | 'logs' | 'settings'（与 state.view 是两个维度，不要混用） */
  page: 'accounts',
  /** 账号展示方式：'cards' | 'list' */
  accView: 'list',
  /** 当前主题：'dark' | 'light' */
  theme: 'dark',
  /** bootstrap 快照：{ initialized, version, setupTokenRequired } */
  bootstrap: null,
  accounts: [],
  logs: [],
  settings: null,
  mcpKey: null,
  opened: {},
  details: {},
  /** 列表视图行展开：{ [accountId]: true } */
  expanded: {},
  /** 日志过滤器：仅失败 + 关键词（账号列表不再提供搜索入口） */
  filters: { onlyFailed: false, q: '' },
  error: null,
  authError: null,
  credits: {},
  // export 按账号粒度记录忙碌态：all 表示「导出全部」，ids 表示正在导出的账号 id。
  // 单账号导出互不阻塞（A 账号导出中不影响 B 账号的导出按钮）。
  busy: {
    run: false,
    test: null,
    import: false,
    export: { all: false, ids: new Set() },
    save: false,
    key: false,
    pw: false,
    retention: false,
    hour: null,
    setup: false,
    login: false,
  },
  loading: { accounts: false, logs: false },
  me: null,
  setupTokenRequired: false,
};

/** 业务错误的统一载体。 */
class ApiError extends Error {
  constructor(code, message, status = 0, detail = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ============ 小工具 ============

/**
 * 创建元素。
 * @param {string} tag
 * @param {string} [className]
 * @param {string|number} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * 生成图标元素（引用 index.html 的 symbol 精灵，零内联 path）。
 * @param {keyof typeof ICONS|string} name
 * @returns {SVGElement}
 */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${ICONS[name] || ICONS.plus}`);
  svg.appendChild(use);
  return svg;
}

/**
 * 重设按钮内容（图标 + 文案）。
 * @param {HTMLElement|null} button
 * @param {string|null} iconName
 * @param {string} label
 */
function setButtonContent(button, iconName, label) {
  if (!button) return;
  button.textContent = '';
  if (iconName) button.appendChild(icon(iconName));
  button.appendChild(document.createTextNode(label));
}

/**
 * 复制图标（精灵表里没有 copy 符号，这里内联一份 16x16 path，保持零依赖）。
 * 描边 / 填充颜色由 CSS（.acc-line .copy svg）按 currentColor 控制。
 * @returns {SVGElement}
 */
function copyIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '5.5');
  rect.setAttribute('y', '5.5');
  rect.setAttribute('width', '8');
  rect.setAttribute('height', '8');
  rect.setAttribute('rx', '1.5');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2');
  svg.appendChild(rect);
  svg.appendChild(path);
  return svg;
}

/**
 * 把时间戳格式化成 HH:MM（Asia/Shanghai）。
 * @param {number} ms
 * @returns {string}
 */
function formatClock(ms) {
  return CLOCK_FMT.format(new Date(ms));
}

/** @param {string} iso @returns {string} */
function fmtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return TIME_FMT.format(date);
}

/** @param {string} iso @returns {string} */
function fmtRelative(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** @param {number} ms @returns {string} */
function fmtDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/**
 * 积分数字格式化。null / undefined / 空串一律 「—」（不能因为 Number(null) === 0 而显示 0）。
 * @param {number|null|undefined} value
 * @returns {string}
 */
function fmtCredits(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return CREDIT_FMT.format(number);
}

/**
 * 「今天 09:00 / 昨天 09:00 / 11-12 09:00」——最近签到时刻，口径固定 Asia/Shanghai。
 * @param {string} iso
 * @returns {string}
 */
function fmtDayTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const stamp = fmtDateStamp(date);
  const clock = CLOCK_FMT.format(date);
  if (stamp === fmtDateStamp()) return `今天 ${clock}`;
  if (stamp === fmtDateStamp(new Date(Date.now() - 86400000))) return `昨天 ${clock}`;
  return fmtTime(iso);
}

/**
 * 完整日期时间格式化（Asia/Shanghai）。
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATETIME_FMT.format(date);
}

/**
 * 上海时区日期戳 YYYY-MM-DD（用于导出文件名与「今天」判定）。
 * @param {Date} [date]
 * @returns {string}
 */
function fmtDateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => (parts.find((item) => item.type === type)?.value || '');
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 北京时间整点 -> 'HH:00'。@param {number} hour @returns {string} */
function fmtHour(hour) {
  const value = Number(hour);
  if (!Number.isInteger(value)) return '—';
  return `${String(((value % 24) + 24) % 24).padStart(2, '0')}:00`;
}

/**
 * 把账号名转成文件名安全片段：替换 Windows/macOS 非法字符与控制字符为 `_`，
 * 去掉首尾空白与点（Windows 不允许文件名以点结尾），保留中文。
 * 清理后为空则回退为账号 id。
 *
 * ⚠ 不可改：test/frontend-filename.test.mjs 用正则从本文件原样抽取本函数并在沙箱求值，
 * 函数体内不得出现**列 0 的 `}`**，签名与 `.slice(0, 64)` 必须原样。
 * @param {string} name 账号名
 * @param {string} fallback 兜底值（账号 id）
 * @returns {string}
 */
function sanitizeFilenamePart(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, 64);
  const safeFallback = String(fallback || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
  return cleaned || safeFallback || 'account';
}

/**
 * 触发浏览器下载 JSON 文件。
 * @param {string} filename
 * @param {*} data
 */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 复制文本到剪贴板（navigator.clipboard；不可用时静默降级为提示 toast）。
 * @param {string} text
 * @param {string} label 复制对象的展示名（用于 toast 文案，如 'UID'）
 */
async function copyText(text, label) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast(`${label} 已复制到剪贴板`, 'ok');
      return;
    }
    throw new Error('clipboard unavailable');
  } catch {
    // 剪贴板权限被拒 / 非 secure context：不打断用户，提示手动复制
    toast('自动复制不可用，请手动复制', 'warn');
  }
}

/**
 * 结果 -> 徽标。
 * @param {string|null} result
 * @returns {HTMLElement}
 */
function resultBadge(result) {
  const map = {
    checked_in: ['签到成功', 'badge-ok'],
    already_checked_in: ['今日已签', 'badge-info'],
    failed: ['失败', 'badge-bad'],
    skipped_disabled: ['已跳过', 'badge-warn'],
    dry_run_ok: ['可签到', 'badge-info'],
  };
  const hit = map[result];
  if (!hit) return el('span', 'badge badge-mute', '未跑过');
  return el('span', `badge ${hit[1]}`, hit[0]);
}

/** @param {string} trigger @returns {HTMLElement} */
function triggerBadge(trigger) {
  const map = { cron: ['定时', 'badge-info'], manual: ['手动', 'badge-ok'], 'manual-single': ['单账号', 'badge-warn'] };
  const hit = map[trigger] || [String(trigger || '未知'), 'badge-mute'];
  return el('span', `badge ${hit[1]}`, hit[0]);
}

/**
 * token 生命周期摘要（卡片与列表共用）。
 * parts 供明细磁贴拆「主值（时效）/ 副值（续期能力）」，text 仍是旧口径完整句子。
 * @param {object} account
 * @returns {{text:string, tone:'ok'|'warn'|'bad'|'mute', parts:string[]}}
 */
function tokenState(account) {
  const expMs = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : NaN;
  const parts = [];
  let tone = 'mute';
  if (Number.isFinite(expMs)) {
    const leftMs = expMs - Date.now();
    if (leftMs <= 0) {
      parts.push('已过期');
      tone = 'bad';
    } else if (leftMs <= 10 * 60 * 1000) {
      parts.push(`${Math.max(1, Math.ceil(leftMs / 60000))} 分钟后过期`);
      tone = 'warn';
    } else {
      parts.push(`有效至 ${fmtTime(account.tokenExpiresAt)}`);
      tone = 'ok';
    }
  } else {
    parts.push('有效期未知');
  }
  if (account.hasRefreshToken) {
    parts.push('可自动续期');
  } else {
    parts.push('缺 refresh_token');
    if (tone !== 'bad') tone = 'warn';
  }
  return { text: parts.join(' · '), tone, parts };
}

/**
 * token 语气 -> meta 值配色类（对应 .acc-line .v 的 good / warn-t / bad）。
 * @param {'ok'|'warn'|'bad'|'mute'} tone
 * @returns {string}
 */
function tokenValueClass(tone) {
  if (tone === 'bad') return 'bad';
  if (tone === 'warn') return 'warn-t';
  if (tone === 'ok') return 'good';
  return '';
}

/**
 * 账号状态徽标：禁用 > token 失效 > 「今天」最近一次 run 的结果。
 *
 * ⚠ 必须按北京日期过滤：run 的 result 只对**它发生的那一天**有效。
 * 昨晚 23:xx 手动测试返回 already_checked_in，若直接拿来渲染，今天凌晨又没跑过时
 * 卡片会一直显示「今日已签」，与 KPI「今天还没有执行记录」自相矛盾。
 * @param {object} account
 * @returns {HTMLElement}
 */
function statusBadge(account) {
  if (account.enabled !== true) return el('span', 'badge badge-mute', '已禁用');
  const entry = state.credits[account.id];
  if (entry && entry.error && entry.error.tokenInvalid === true) {
    return el('span', 'badge badge-bad', 'token 失效');
  }
  const today = latestRunTodayFor(account.id);
  if (today) return resultBadge(today.result);
  // 今天还没有该账号的执行记录：跑过（哪怕只是昨天）就是中性「未签到」，完全没跑过仍是「未跑过」
  return latestRunFor(account.id) ? el('span', 'badge badge-mute', '未签到') : resultBadge(null);
}

/**
 * 卡片视图的一行「键 / 值」。
 * @param {string} label
 * @param {string} value
 * @param {string} [extraClass]
 * @returns {HTMLElement}
 */
function cardLine(label, value, extraClass) {
  const row = el('div', 'acc-line');
  row.appendChild(el('span', 'k', label));
  row.appendChild(el('span', extraClass ? `v ${extraClass}` : 'v', value));
  return row;
}

/**
 * 卡片视图的一行「键 / 自定义控件」。
 * @param {string} label
 * @param {HTMLElement} control
 * @returns {HTMLElement}
 */
function cardLineControl(label, control) {
  const row = el('div', 'acc-line');
  row.appendChild(el('span', 'k', label));
  row.appendChild(control);
  return row;
}

/**
 * 卡片「签到时间」下拉（北京时间整点，每账号独立）。
 *
 * 不用打开编辑弹窗才能改：签到时间是高频调整项，且用户需要一眼看出「我的账号是不是都堆在同一小时」。
 * 改动即时 PUT /api/accounts/:id，无需重新部署；title 里同时给出对应的 UTC 时刻，避免用户自己换算。
 * 卡片视图与列表视图共用 `.acc-hour-select` 类名 —— 焦点守卫靠它一次覆盖两个视图。
 * @param {object} account
 * @returns {HTMLElement}
 */
function checkinHourPicker(account) {
  const hour = Number.isInteger(account.checkinHour) ? account.checkinHour : 8;
  const select = el('select', 'acc-hour-select');
  select.setAttribute('aria-label', `账号 ${account.name} 的签到时间（北京时间）`);
  for (let h = 0; h < 24; h += 1) {
    const option = document.createElement('option');
    option.value = String(h);
    option.textContent = `每天 ${String(h).padStart(2, '0')}:00`;
    select.appendChild(option);
  }
  select.value = String(hour);
  select.disabled = state.busy.hour === account.id;
  select.title = `北京时间 ${fmtHour(hour)}（UTC ${fmtHour(hour - 8)}）`;
  select.addEventListener('change', () => {
    const next = Number(select.value);
    if (!Number.isInteger(next) || next === hour) {
      select.value = String(hour);
      return;
    }
    void saveAccountHour(account, next);
  });
  return select;
}

/**
 * 保存单个账号的签到时间。
 * @param {object} account
 * @param {number} hour 北京时间 0~23
 */
async function saveAccountHour(account, hour) {
  // 不做请求前的全量重渲染：那会让下拉在请求期间闪回旧值。
  state.busy.hour = account.id;
  let failed = false;
  try {
    await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'PUT', body: { checkinHour: hour } });
    toast(`「${account.name}」改为每天 ${fmtHour(hour)}（北京时间）签到`, 'ok');
  } catch (err) {
    failed = true;
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '保存签到时间失败');
      toast('保存失败', 'bad');
    }
  } finally {
    state.busy.hour = null;
    // 失败必须强制重绘：此时下拉多半还持有焦点，焦点守卫会拦下普通重绘，
    // 结果就是「服务端没改、界面还显示改后的值」+ 已删账号残留。成功路径不需要强制，
    // 保留焦点更顺手（值本来就等于服务端值）。
    await refreshAccounts({ force: failed });
  }
}

// ============ 主题 ============

/**
 * 应用主题（不写 DOM 之外的副作用；persist=false 时不落 localStorage）。
 * @param {'dark'|'light'} theme
 * @param {boolean} [persist]
 */
function applyTheme(theme, persist = true) {
  const next = theme === 'light' ? 'light' : 'dark';
  state.theme = next;
  document.documentElement.setAttribute('data-theme', next);

  const use = $('#theme-icon use');
  if (use) use.setAttribute('href', next === 'dark' ? '#i-sun' : '#i-moon');

  const btn = $('#btn-theme');
  if (btn) {
    btn.title = next === 'dark' ? '切换到日间模式' : '切换到夜间模式';
    btn.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
  }

  if (persist) store.set('wb:theme', next);
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

/**
 * 初始化主题：优先级 ?theme= > localStorage > 系统偏好。
 * `<head>` 内联脚本已在首帧前做过一次，这里是幂等同步（顺带同步按钮态）。
 */
function initTheme() {
  const query = new URLSearchParams(window.location.search).get('theme');
  if (query === 'light' || query === 'dark') {
    applyTheme(query, false);
    return;
  }
  const saved = store.get('wb:theme');
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved, false);
    return;
  }
  const prefersDark = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light', false);
}

// ============ 视图与提示 ============

/**
 * 切换视图（setup / login / panel）。
 * @param {'setup'|'login'|'panel'|'boot'} name
 */
function showView(name) {
  state.view = name;
  const views = { setup: '#view-setup', login: '#view-login', panel: '#view-panel' };
  for (const [key, selector] of Object.entries(views)) {
    const node = $(selector);
    if (node) node.hidden = key !== name;
  }
  const loginInput = $('#login-password');
  const setupInput = $('#setup-password');
  if (name === 'login' && loginInput) loginInput.focus();
  if (name === 'setup' && setupInput) setupInput.focus();
  renderPageChrome();
}

/** @param {string} code @param {string} message */
function setError(code, message) {
  state.error = { code, message };
  renderError();
}

function clearError() {
  state.error = null;
  renderError();
}

/** @param {string} code @param {string} message */
function setAuthError(code, message) {
  state.authError = { code, message };
  renderAuthError();
}

function clearAuthError() {
  state.authError = null;
  renderAuthError();
}

/**
 * 显示 toast（同一文案去重，最多同时 3 条，始终固定在右下角）。
 * @param {string} message
 * @param {'ok'|'bad'|'warn'|'info'} [kind]
 */
function toast(message, kind = 'info') {
  const host = $('#toast-host');
  if (!host) return;
  const text = String(message);
  // 去重：相同文案不叠加（连点按钮不会堆出一列胶囊）
  for (const existing of Array.from(host.children)) {
    if (existing.dataset.message === text) {
      existing.remove();
    }
  }
  while (host.children.length >= 3) {
    host.firstElementChild.remove();
  }
  const node = el('div', `toast is-${kind}`, text);
  node.dataset.message = text;
  host.appendChild(node);
  window.setTimeout(() => node.remove(), 4200);
}

// ============ 渲染 ============

function renderAll() {
  renderError();
  renderAuthError();
  renderAccounts();
  renderLogs();
  renderSettings();
  syncBusy();
}

function renderError() {
  const bar = $('#panel-error');
  const text = $('#panel-error-text');
  if (!bar || !text) return;
  if (!state.error) {
    bar.hidden = true;
    text.textContent = '';
    return;
  }
  text.textContent = `${state.error.code}: ${state.error.message}`;
  bar.hidden = false;
}

function renderAuthError() {
  const setupError = $('#setup-error');
  const loginError = $('#login-error');
  if (setupError) {
    if (state.view === 'setup') {
      setupError.hidden = !state.authError;
      setupError.textContent = state.authError ? state.authError.message : '';
    } else {
      setupError.hidden = true;
    }
  }
  if (loginError) {
    if (state.view === 'login') {
      loginError.hidden = !state.authError;
      loginError.textContent = state.authError ? state.authError.message : '';
    } else {
      loginError.hidden = true;
    }
  }
}

/** @param {string} accountId @returns {string} */
function accountName(accountId) {
  const hit = state.accounts.find((account) => account.id === accountId);
  return hit ? hit.name : '';
}

/**
 * 找某账号最近一次结果（依赖 RunSummary.accountResults，零额外读）。
 * @param {string} accountId
 * @returns {string|null}
 */
function latestResultFor(accountId) {
  const hit = latestRunFor(accountId);
  return hit ? hit.result : null;
}

/**
 * 最近一次命中该账号的 run（列表视图要显示「今天 09:00」，光有 result 不够）。
 * @param {string} accountId
 * @returns {{result:string, startedAt:string}|null}
 */
function latestRunFor(accountId) {
  for (const run of state.logs) {
    const results = Array.isArray(run.accountResults) ? run.accountResults : [];
    const hit = results.find((item) => item && item.accountId === accountId);
    if (hit) return { result: hit.result || 'failed', startedAt: run.startedAt || '' };
  }
  return null;
}

/**
 * 今天（Asia/Shanghai）最近一次 run。
 * @returns {object|null}
 */
function latestRunToday() {
  const today = fmtDateStamp();
  for (const run of state.logs) {
    if (!run || !run.startedAt) continue;
    const date = new Date(run.startedAt);
    if (Number.isNaN(date.getTime())) continue;
    if (fmtDateStamp(date) === today) return run;
  }
  return null;
}

/**
 * 最近一次命中该账号、且 startedAt 落在今天（Asia/Shanghai）的 run。
 * 与 latestRunFor 的唯一差别就是这条日期过滤：跨天的旧结果不能代表今天。
 * @param {string} accountId
 * @returns {{result:string, startedAt:string}|null}
 */
function latestRunTodayFor(accountId) {
  const today = fmtDateStamp();
  for (const run of state.logs) {
    if (!run || !run.startedAt) continue;
    const date = new Date(run.startedAt);
    if (Number.isNaN(date.getTime())) continue;
    if (fmtDateStamp(date) !== today) continue;
    const results = Array.isArray(run.accountResults) ? run.accountResults : [];
    const hit = results.find((item) => item && item.accountId === accountId);
    if (hit) return { result: hit.result || 'failed', startedAt: run.startedAt };
  }
  return null;
}

/**
 * 当前北京时间的「当天第几分钟」（0~1439）。
 * 复用 CLOCK_FMT（Asia/Shanghai）避免新引入时区字符串；取模 24 兜住 ICU 的 24:00 写法。
 * @param {Date} [date]
 * @returns {number}
 */
function beijingMinuteOfDay(date = new Date()) {
  const [hh, mm] = CLOCK_FMT.format(date).split(':');
  const hour = Number(hh) % 24;
  const minute = Number(mm);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return 0;
  return hour * 60 + minute;
}

/**
 * 「下次自动签到」：启用账号里**真正下一次**会触发的签到小时，外加「今天还是明天」。
 *
 * ⚠ 是「下一次」，不是「最小的小时」。账号小时是 [2, 9]、当前 03:00 时，最小的小时是 2，
 * 但 2 点的窗口今天已经关了，今天还有动作的是 09:00 那个账号——所以要挑
 * 「不早于当前小时的最小候选」，只有当前小时之后一个候选都没有时，才回到全局最小值并标明天。
 * （例：[2, 9] @03:00 -> 09:00 今天；[2, 9] @10:00 -> 02:00 明天；[2, 9] @02:41 -> 02:00 今天。）
 *
 * 比较口径是**小时**，不是分钟——这是刻意对齐调度器语义的结果：
 *   - wrangler.toml 的 cron 是 `0,15,30,45 * * * *`（每 15 分钟一轮），即每小时触发 4 次，
 *     目标小时内的 :00 / :15 / :30 / :45 四轮都属于同一个签到窗口；
 *   - src/schedule.js 的 accountsDueAt() 也只比对「北京小时相等」，
 *     窗口内失败还会由后几轮自动重试。
 * 所以此刻 02:41、目标小时 2 时，下一次动作就是**今天 02:45 那轮**，不该标「明天」；
 * 反过来写成「目标分钟数 <= 当前分钟数 -> 明天」会在窗口中途提前跳到明天，
 * 写成无条件加「明天」则凌晨会显示错。判据只能是「目标小时 < 当前北京小时」。
 *
 * 依赖只允许是 `state` 与 `beijingMinuteOfDay`（测试会把两者注入沙箱求值），
 * 因此这里不引用任何模块级常量：默认小时 8 与 src/schedule.js 的 DEFAULT_CHECKIN_HOUR 对齐，
 * 就地写成字面量；越界/非法小时也按同一口径回落 8 点，不取模兜底。
 * @returns {{hour:number, isTomorrow:boolean}|null} 无启用账号时返回 null
 */
function nextCheckinInfo() {
  const hours = [];
  for (const account of state.accounts) {
    if (!account || account.enabled !== true) continue;
    // 与 src/schedule.js 的 normalizeCheckinHour 同口径：只认 0~23 的整数（纯数字字符串也接受），
    // 越界 / 小数 / 空值一律回落 8 点（= DEFAULT_CHECKIN_HOUR）。
    // 越界值不能取模兜底，否则手改 KV 写成 25 会算成 1 点，与后端「25 -> 8 点」分叉。
    let value = account.checkinHour;
    if (typeof value === 'string') value = value.trim() === '' ? NaN : Number(value);
    const valid = Number.isInteger(value) && value >= 0 && value <= 23;
    const hour = valid ? value : 8;
    if (!hours.includes(hour)) hours.push(hour);
  }
  if (hours.length === 0) return null;
  // 当前北京小时（0~23）；beijingMinuteOfDay() 保持无参调用，便于测试注入。
  const currentHour = Math.floor(beijingMinuteOfDay() / 60);
  let next = null;
  for (const candidate of hours) {
    if (candidate >= currentHour && (next === null || candidate < next)) next = candidate;
  }
  // 今天还有窗口没关：最近的那个候选就是「今天」的下一次
  if (next !== null) return { hour: next, isTomorrow: false };
  // 今天的窗口全关了：回到全局最小值，落在明天
  let earliest = hours[0];
  for (const candidate of hours) {
    if (candidate < earliest) earliest = candidate;
  }
  return { hour: earliest, isTomorrow: true };
}

/**
 * 轮询焦点保护：活动元素是输入类控件且位于 .content 内 -> 本次重绘让路。
 * 弹窗在 .content 之外，因此弹窗内输入不会被误判。
 * @returns {boolean}
 */
function isEditingInPanel() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return false;
  return typeof active.closest === 'function' && active.closest('.content') !== null;
}

/**
 * 当前要渲染的账号（返回副本，避免渲染层就地改动 state）。
 * 顶栏搜索已移除，这里不再做关键词过滤；如需恢复，请把过滤放进本函数。
 * @returns {object[]}
 */
function visibleAccounts() {
  return state.accounts.slice();
}

/**
 * KPI 四个卡片：全部由现有 state 推导，缺数据一律 「—」，绝不造环比。
 */
function renderKpis() {
  const accounts = state.accounts;
  const enabled = accounts.filter((account) => account && account.enabled === true);
  const disabledCount = accounts.length - enabled.length;

  // 1. 启用账号
  const enabledNode = $('#kpi-enabled');
  if (enabledNode) {
    enabledNode.textContent = String(enabled.length);
    enabledNode.appendChild(el('small', null, `/ ${accounts.length}`));
  }
  const enabledSub = $('#kpi-enabled-sub');
  if (enabledSub) {
    enabledSub.textContent = accounts.length === 0
      ? '还没有账号'
      : (disabledCount > 0 ? `${disabledCount} 个已禁用` : '全部启用');
  }

  // 2. 今日签到（取今天最近一次 run 的 success/total）
  const todayRun = latestRunToday();
  const todayNode = $('#kpi-today');
  const todaySub = $('#kpi-today-sub');
  if (todayRun) {
    const success = Number(todayRun.success) || 0;
    const total = Number(todayRun.total) || 0;
    const failed = Number(todayRun.failed) || 0;
    if (todayNode) {
      todayNode.textContent = String(success);
      todayNode.appendChild(el('small', null, `/ ${total}`));
    }
    if (todaySub) {
      if (failed > 0) todaySub.textContent = `${failed} 个失败`;
      else if (total > success) todaySub.textContent = `${total - success} 个未成功`;
      else todaySub.textContent = '全部成功';
    }
  } else {
    if (todayNode) todayNode.textContent = '—';
    if (todaySub) todaySub.textContent = '今天还没有执行记录';
  }

  // 3. 总剩余积分（state.credits 汇总，只算已查到的）
  let creditSum = 0;
  let creditReady = 0;
  for (const account of accounts) {
    const entry = state.credits[account.id];
    const raw = entry && entry.data ? entry.data.totalLeft : null;
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) {
      creditSum += value;
      creditReady += 1;
    }
  }
  const creditNode = $('#kpi-credits');
  const creditSub = $('#kpi-credits-sub');
  if (creditNode) creditNode.textContent = creditReady > 0 ? fmtCredits(creditSum) : '—';
  if (creditSub) {
    creditSub.textContent = accounts.length === 0
      ? '还没有账号'
      : (creditReady === 0 ? '尚未查询额度' : `${creditReady} / ${accounts.length} 个已查询`);
  }

  // 4. 下次自动签到（启用账号里「不早于当前小时」的最小整点；今天的窗口全关才顺延到明天）
  const nextInfo = nextCheckinInfo();
  const hour = nextInfo ? nextInfo.hour : null;
  const nextNode = $('#kpi-next');
  const nextSub = $('#kpi-next-sub');
  if (nextNode) {
    nextNode.textContent = hour === null ? '—' : fmtHour(hour);
    if (hour !== null && nextInfo.isTomorrow) nextNode.appendChild(el('small', null, '明天'));
  }
  if (nextSub) nextSub.textContent = hour === null ? '没有启用账号' : '北京时间 · Cron 每小时扫描';

  // 页头副标题：能算的拼进去，算不出的整段省略
  const sub = $('#accounts-sub');
  if (sub) {
    const parts = [`${accounts.length} 个账号`];
    if (todayRun) parts.push(`今日 ${Number(todayRun.success) || 0} / ${Number(todayRun.total) || 0} 已签到`);
    if (creditReady > 0) parts.push(`共 ${fmtCredits(creditSum)} 积分`);
    // 与 KPI 卡片共用同一份 nextCheckinInfo()，避免同屏两处对「今天/明天」各说各话
    if (nextInfo) {
      parts.push(nextInfo.isTomorrow
        ? `下次自动 明天 ${fmtHour(nextInfo.hour)}`
        : `下次自动 ${fmtHour(nextInfo.hour)}`);
    }
    sub.textContent = parts.join(' · ');
  }
}

/** 侧栏：角标 + 下次自动 + 版本。 */
function renderNav() {
  const accountsCount = $('#nav-count-accounts');
  if (accountsCount) accountsCount.textContent = String(state.accounts.length);
  const logsCount = $('#nav-count-logs');
  if (logsCount) logsCount.textContent = String(state.logs.length);

  const next = $('#side-next');
  if (next) {
    // 同一份 nextCheckinInfo()；侧栏空间小，只给钟点，不追「明天」
    const info = nextCheckinInfo();
    next.textContent = info === null ? '—' : fmtHour(info.hour);
  }

  const version = $('#side-version');
  if (version) {
    const raw = state.bootstrap && state.bootstrap.version ? String(state.bootstrap.version) : '';
    version.textContent = raw || '—';
  }
}

/** 面包屑 / 文档标题 / 侧栏角标（数据变化与切页后都调）。 */
function renderPageChrome() {
  const label = PAGES[state.page] || PAGES.accounts;
  const crumb = $('#crumb-current');
  if (crumb) crumb.textContent = label;
  document.title = state.view === 'panel' ? `${label} · WorkBuddy Daily` : DEFAULT_TITLE;
  renderNav();
}

/**
 * 切换面板栏目。
 * ⚠ 只在 state.view === 'panel' 时才动 URL 与标题（否则登录页会被写成「设置 · …」）。
 * @param {'accounts'|'logs'|'settings'} name
 */
function setPage(name) {
  const page = PAGES[name] ? name : 'accounts';
  state.page = page;

  for (const node of $$('.page[data-page]')) {
    node.hidden = node.dataset.page !== page;
  }
  for (const link of $$('[data-page-link]')) {
    const on = link.dataset.pageLink === page;
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  store.set('wb:page', page);
  renderPageChrome();

  if (state.view === 'panel') {
    // R13：replaceState 必须保留 query string，否则 ?theme= 会在切页后丢失
    const target = `${window.location.pathname}${window.location.search}#${page}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== target) window.history.replaceState(null, '', target);
  }

  window.scrollTo(0, 0);
}

/**
 * 切换账号展示方式（卡片 / 列表），并记忆。
 * @param {'cards'|'list'} view
 */
function setAccView(view) {
  const next = view === 'cards' ? 'cards' : 'list';
  state.accView = next;
  for (const node of $$('.acc-view[data-view]')) {
    node.hidden = node.dataset.view !== next;
  }
  for (const btn of $$('[data-view-btn]')) {
    btn.setAttribute('aria-pressed', btn.dataset.viewBtn === next ? 'true' : 'false');
  }
  store.set('wb:acc-view', next);
}

/**
 * 列表行展开/收起（手风琴：一次只开一个）。
 * 直接改 hidden / class，不重建 DOM —— 重建会把焦点和选择一起丢掉。
 * @param {string} accountId
 */
function toggleRowDetail(accountId) {
  const id = String(accountId || '');
  if (!id) return;
  const willOpen = state.expanded[id] !== true;
  state.expanded = {};
  if (willOpen) state.expanded[id] = true;

  for (const node of $$('.detail[data-detail]')) {
    node.hidden = state.expanded[node.dataset.detail] !== true;
  }
  for (const row of $$('.t-row[data-row]')) {
    const on = state.expanded[row.dataset.row] === true;
    row.classList.toggle('is-open', on);
    const chev = row.querySelector('.row-chev');
    if (chev) chev.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
}

/**
 * 渲染账号区（卡片 + 列表 + 计数 + KPI）。
 * @param {boolean} [force] true 时无视焦点守卫强制重绘（服务端状态可能与界面不一致时用）
 */
function renderAccounts(force = false) {
  // 全量重建 DOM。若用户正在操作面板里的输入类控件（30s 轮询会触发重建），
  // 重建会把下拉关掉、输入清空，所以这次刷新直接让路，等下一轮。
  // 例外：saveAccountHour 失败等「界面已经错了」的场景必须 force 重绘。
  if (force !== true && isEditingInPanel()) {
    renderKpis();
    return;
  }

  const cards = $('#accounts-cards');
  const body = $('#acc-body');
  const skeleton = $('#accounts-skeleton');
  const empty = $('#accounts-empty');
  if (!cards || !body) return;

  cards.textContent = '';
  body.textContent = '';

  const loading = state.loading.accounts && state.accounts.length === 0;
  if (skeleton) skeleton.hidden = !loading;

  const rows = visibleAccounts();
  const noAccount = state.accounts.length === 0;
  const noMatch = !noAccount && rows.length === 0;

  if (empty) {
    empty.hidden = loading || (!noAccount && !noMatch);
    if (noAccount) empty.textContent = '还没有账号。点击「新增账号」，粘贴 WorkBuddy token 即可开始。';
    else if (noMatch) empty.textContent = '没有匹配的账号。清空顶栏搜索即可看到全部。';
  }

  for (const account of rows) {
    cards.appendChild(accountCard(account));
    body.appendChild(accountRow(account));
    body.appendChild(accountDetail(account));
  }

  const count = $('#accounts-count');
  if (count) count.textContent = `${state.accounts.length} 个`;

  renderKpis();
  // 增删改 / 导入后，侧栏「账号概览」角标必须立刻跟着变，不能等下一轮 30s 轮询
  renderNav();
}

/**
 * 账号卡片（方案 A · Dashboard Focus）：头部身份区 + 积分 Hero 面板 + meta 两列 + 操作区。
 *
 * ⚠ 不可改清单（test/frontend-filename.test.mjs 用正则从本函数抽取断言）：
 *   1. 必须存在 `el('div', 'acc-card-head')` 与 `el('div', 'acc-card-foot')`；
 *   2. 必须存在 `const exportBtn = el('button', `btn btn-ghost btn-sm${exporting ? ' is-busy' : ''}`, '导出')`
 *      与 `const exporting = isExporting(account.id);`、`exportBtn.disabled = exporting;`、
 *      `exportBtn.setAttribute('aria-busy', …)`、`foot.appendChild(exportBtn)`、
 *      `exportBtn.addEventListener('click', () => askExportAccount(account))`；
 *   3. 导出按钮不得出现在 head 里；
 *   4. 本函数体内不得出现**列 0 的 `}`**（测试用 `[\s\S]*?\n\}` 截取函数体，
 *      出现就会提前截断）。同理不要把卡片拆成 accountCardHead() 之类子函数。
 * @param {object} account
 * @returns {HTMLElement}
 */
function accountCard(account) {
  const card = el('article', 'acc-card');
  const entry = state.credits[account.id];
  const planLabel = entry && entry.data ? entry.data.planLabel : null;
  const testing = state.busy.test === account.id;

  // ---- 卡片头：头像 + 名称/套餐 + 打码 token + 状态徽标 + 编辑/删除 ----
  const head = el('div', 'acc-card-head');
  const avatar = el('span', 'avatar', String(account.name || '?').slice(0, 1));
  avatar.setAttribute('aria-hidden', 'true');
  head.appendChild(avatar);

  const ident = el('div', 'acc-card-id');
  const nameRow = el('div', 'nm');
  nameRow.appendChild(document.createTextNode(account.name || account.id || '未命名'));
  if (planLabel) {
    const isPro = String(planLabel).toLowerCase() === 'pro';
    nameRow.appendChild(el('span', isPro ? 'plan pro' : 'plan', planLabel));
  }
  ident.appendChild(nameRow);
  ident.appendChild(el('div', 'tk', account.tokenMasked || '—'));
  head.appendChild(ident);

  const spacer = el('div', 'spacer');
  spacer.appendChild(statusBadge(account));
  head.appendChild(spacer);

  const editBtn = el('button', 'btn btn-ghost btn-icon btn-sm');
  editBtn.type = 'button';
  editBtn.title = '编辑';
  editBtn.setAttribute('aria-label', `编辑账号 ${account.name}`);
  editBtn.appendChild(icon('edit'));
  editBtn.disabled = testing;
  editBtn.addEventListener('click', () => openAccountDialog(account));

  const delBtn = el('button', 'btn btn-ghost btn-icon btn-sm btn-danger-ghost');
  delBtn.type = 'button';
  delBtn.title = '删除';
  delBtn.setAttribute('aria-label', `删除账号 ${account.name}`);
  delBtn.appendChild(icon('trash'));
  delBtn.disabled = testing;
  delBtn.addEventListener('click', () => askDeleteAccount(account));

  head.appendChild(editBtn);
  head.appendChild(delBtn);
  card.appendChild(head);

  // ---- 主体：积分 Hero 面板（视觉核心） + meta 两列（UID / Token / 签到时间 / 上次签到） ----
  const body = el('div', 'acc-card-b');
  body.appendChild(creditBlock(account, entry));

  const meta = el('div', 'acc-meta');
  const uidLine = cardLine('UID', account.uid || '—', 'mono');
  if (account.uid) {
    // UID 是高频粘贴项：hover / 键盘聚焦时浮出复制按钮，点击写入剪贴板
    const copyBtn = el('button', 'copy');
    copyBtn.type = 'button';
    copyBtn.title = '复制 UID';
    copyBtn.setAttribute('aria-label', `复制账号 ${account.name} 的 UID`);
    copyBtn.appendChild(copyIcon());
    copyBtn.addEventListener('click', () => {
      void copyText(account.uid, 'UID');
    });
    uidLine.appendChild(copyBtn);
  }
  meta.appendChild(uidLine);

  const token = tokenState(account);
  meta.appendChild(cardLine('Token', token.text, tokenValueClass(token.tone)));
  meta.appendChild(cardLineControl('签到时间', checkinHourPicker(account)));

  const latest = latestRunFor(account.id);
  meta.appendChild(cardLine('上次签到', latest && latest.startedAt ? fmtDayTime(latest.startedAt) : '—'));
  body.appendChild(meta);
  card.appendChild(body);

  // ---- 底部操作区：测试签到（primary 主按钮）/ 刷新额度 / 导出（编辑与删除在头部图标位） ----
  const foot = el('div', 'acc-card-foot');
  // busy 态：文案不变 + 按钮内 spinner + disabled（不做绝对定位浮层，不替换文案）
  const testBtn = el('button', `btn btn-primary btn-sm${testing ? ' is-busy' : ''}`, '测试签到');
  testBtn.type = 'button';
  testBtn.disabled = testing || state.busy.run;
  testBtn.setAttribute('aria-busy', testing ? 'true' : 'false');
  if (testing) testBtn.title = '签到中…';
  testBtn.addEventListener('click', () => testCheckin(account));

  const creditsLoading = Boolean(entry && entry.loading);
  const creditBtn = el('button', `btn btn-ghost btn-sm${creditsLoading ? ' is-busy' : ''}`, '刷新额度');
  creditBtn.type = 'button';
  creditBtn.disabled = creditsLoading;
  creditBtn.setAttribute('aria-busy', creditsLoading ? 'true' : 'false');
  creditBtn.title = '重新查询积分配额';
  creditBtn.addEventListener('click', () => loadCredits(account.id));

  // 单账号导出：卡片内直接导出「这个账号」的 cockpit-tools JSON（含明文 token）
  const exporting = isExporting(account.id);
  const exportBtn = el('button', `btn btn-ghost btn-sm${exporting ? ' is-busy' : ''}`, '导出');
  exportBtn.type = 'button';
  exportBtn.disabled = exporting;
  exportBtn.setAttribute('aria-busy', exporting ? 'true' : 'false');
  exportBtn.setAttribute('aria-label', `导出账号 ${account.name} 的 JSON`);
  exportBtn.title = exporting
    ? '导出中…'
    : `导出「${account.name}」的账号 JSON（文件含明文 token）`;
  exportBtn.addEventListener('click', () => askExportAccount(account));

  foot.appendChild(testBtn);
  foot.appendChild(creditBtn);
  foot.appendChild(exportBtn);
  card.appendChild(foot);

  return card;
}

/**
 * 列表视图的一行。
 * ⚠ 直接子元素必须恰好 6 个且顺序固定（≤1100px 靠 nth-child 映射 grid-area）：
 *   1 .acc-cell  2 状态  3 签到时间  4 .money  5 .dim  6 .row-actions
 * @param {object} account
 * @returns {HTMLElement}
 */
function accountRow(account) {
  const row = el('div', 't-row is-clickable');
  row.dataset.row = account.id;
  if (state.expanded[account.id] === true) row.classList.add('is-open');

  const entry = state.credits[account.id];
  const planLabel = entry && entry.data ? entry.data.planLabel : null;

  // 1. 账号（avatar + 名称/套餐 + 打码 token）
  const cell = el('div', 'acc-cell');
  const avatar = el('span', 'avatar', String(account.name || '?').slice(0, 1));
  avatar.setAttribute('aria-hidden', 'true');
  cell.appendChild(avatar);
  const ident = el('div', 'acc-cell-id');
  const nameRow = el('div', 'nm');
  nameRow.appendChild(document.createTextNode(account.name || account.id || '未命名'));
  if (planLabel) {
    const isPro = String(planLabel).toLowerCase() === 'pro';
    nameRow.appendChild(el('span', isPro ? 'plan pro' : 'plan', planLabel));
  }
  ident.appendChild(nameRow);
  ident.appendChild(el('div', 'tk', account.tokenMasked || '—'));
  cell.appendChild(ident);
  row.appendChild(cell);

  // 2. 状态
  const status = el('span');
  status.appendChild(statusBadge(account));
  row.appendChild(status);

  // 3. 签到时间
  const hourCell = el('span');
  hourCell.appendChild(checkinHourPicker(account));
  row.appendChild(hourCell);

  // 4. 剩余积分
  const moneyValue = entry && entry.data ? entry.data.totalLeft : null;
  const money = el('span', 'money', fmtCredits(moneyValue));
  if (moneyValue !== null && moneyValue !== undefined && Number.isFinite(Number(moneyValue))) {
    money.appendChild(el('small', null, '分'));
  }
  row.appendChild(money);

  // 5. 最近签到
  const latest = latestRunFor(account.id);
  row.appendChild(el('span', 'dim', latest && latest.startedAt ? fmtDayTime(latest.startedAt) : '—'));

  // 6. 操作
  const actions = el('div', 'row-actions');

  const editBtn = el('button', 'btn btn-ghost btn-icon btn-sm');
  editBtn.type = 'button';
  editBtn.title = '编辑';
  editBtn.setAttribute('aria-label', `编辑账号 ${account.name}`);
  editBtn.appendChild(icon('edit'));
  editBtn.addEventListener('click', () => openAccountDialog(account));

  const delBtn = el('button', 'btn btn-ghost btn-icon btn-sm btn-danger-ghost');
  delBtn.type = 'button';
  delBtn.title = '删除';
  delBtn.setAttribute('aria-label', `删除账号 ${account.name}`);
  delBtn.appendChild(icon('trash'));
  delBtn.addEventListener('click', () => askDeleteAccount(account));

  const chevBtn = el('button', 'row-chev');
  chevBtn.type = 'button';
  chevBtn.setAttribute('aria-expanded', state.expanded[account.id] === true ? 'true' : 'false');
  chevBtn.setAttribute('aria-label', `展开账号 ${account.name} 的积分明细`);
  chevBtn.title = '展开积分明细';
  chevBtn.appendChild(icon('chev'));
  chevBtn.addEventListener('click', () => toggleRowDetail(account.id));

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  actions.appendChild(chevBtn);
  row.appendChild(actions);

  // 点行展开；点按钮 / 下拉不触发展开
  row.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button') || target.closest('select') || target.closest('option')) return;
    toggleRowDetail(account.id);
  });

  return row;
}

/**
 * 列表视图的展开明细（行的兄弟节点，紧跟其后）。
 * 方案 B「指标磁贴」：四磁贴（总剩余积分 / 签到状态 / 签到计划 / Token 有效期）
 * + 双进度卡 + 底栏（UID 芯片 + 测试签到 / 刷新额度 / 导出）。
 * 加载 / 错误 / 空态沿用 creditBlock（与卡片视图同源）；展开行本身（.t-row 六列）结构与交互不动。
 * @param {object} account
 * @returns {HTMLElement}
 */
function accountDetail(account) {
  const open = state.expanded[account.id] === true;
  const wrap = el('div', 'detail');
  wrap.dataset.detail = account.id;
  wrap.hidden = !open;

  const entry = state.credits[account.id];
  const data = entry && entry.data;
  const body = el('div', 'detail-body');

  if (!data) {
    // 加载中 / 查询失败 / 尚未查询：整块交给 creditBlock，保持与卡片视图完全同源
    body.appendChild(creditBlock(account, entry));
  } else {
    // ---- 指标磁贴行 ----
    const tiles = el('div', 'detail-tiles');

    // 1) 总剩余积分（大号等宽数字，明细区的核心视觉）
    const balance = el('span', null, fmtCredits(data.totalLeft));
    if (data.totalLeft !== null && data.totalLeft !== undefined && Number.isFinite(Number(data.totalLeft))) {
      balance.appendChild(el('span', 'unit', '分'));
    }
    tiles.appendChild(detailTile('总剩余积分', balance, null, { num: true, live: true }));

    // 2) 签到状态（徽标）+ 最近一次签到时间作副值
    const latest = latestRunFor(account.id);
    const statusSub = latest && latest.startedAt ? `最近 ${fmtDayTime(latest.startedAt)}` : '今天还没跑过';
    tiles.appendChild(detailTile('签到状态', statusBadge(account), statusSub));

    // 3) 签到计划（北京时间整点下拉，与折叠行同源同交互）
    tiles.appendChild(detailTile('签到计划', checkinHourPicker(account), null));

    // 4) Token 有效期（主值 = 时效，副值 = 续期能力）
    const token = tokenState(account);
    // title 保留旧口径完整句子「Token 有效至 … · 可自动续期」，值本身不重复前缀
    const tokenText = `Token ${token.text}`;
    const tokenParts = Array.isArray(token.parts) && token.parts.length > 0 ? token.parts : [token.text];
    tiles.appendChild(detailTile(
      'Token 有效期',
      tokenParts[0],
      tokenParts.length > 1 ? tokenParts.slice(1).join(' · ') : null,
      { tone: tokenValueClass(token.tone), title: tokenText },
    ));

    body.appendChild(tiles);

    // ---- 双进度卡：条长口径与 creditBarRow 一致（填充 = 剩余额度，越长越充足） ----
    const groups = Array.isArray(data.groups) ? data.groups : [];
    if (groups.length > 0) {
      const bars = el('div', 'detail-bars');
      for (const group of groups) bars.appendChild(creditBarCard(group, bars.childElementCount));
      body.appendChild(bars);
    }
  }

  // ---- 底栏：UID 芯片（常显复制按钮，触屏友好） + 测试签到 / 刷新额度 / 导出 ----
  const foot = el('div', 'detail-foot');
  const uidChip = el('span', 'uid-chip');
  uidChip.appendChild(el('span', 'k', 'UID'));
  uidChip.appendChild(el('span', 'mono-v', account.uid || '—'));
  if (account.uid) {
    const copyBtn = el('button', 'copy');
    copyBtn.type = 'button';
    copyBtn.title = '复制 UID';
    copyBtn.setAttribute('aria-label', `复制账号 ${account.name} 的 UID`);
    copyBtn.appendChild(copyIcon());
    copyBtn.addEventListener('click', () => {
      void copyText(account.uid, 'UID');
    });
    uidChip.appendChild(copyBtn);
  }
  foot.appendChild(uidChip);
  foot.appendChild(el('span', 'spacer'));
  foot.appendChild(detailAction('测试签到', () => testCheckin(account), 'btn-primary'));
  foot.appendChild(detailAction('刷新额度', () => loadCredits(account.id)));
  foot.appendChild(detailAction('导出', () => askExportAccount(account)));
  body.appendChild(foot);

  wrap.appendChild(body);
  return wrap;
}

/**
 * 明细磁贴：标签 + 主值 + 可选副值。
 * @param {string} label
 * @param {HTMLElement|string} value 主值（元素或文本）
 * @param {string|null} [sub] 副值文本
 * @param {{num?:boolean, live?:boolean, tone?:string, title?:string}} [opts]
 *   num: 主值用等宽数字放大；live: 标签前带实时数据呼吸点；
 *   tone: 主值语气配色（复用 tokenValueClass 的 good / warn-t / bad）；title: 主值悬浮提示
 * @returns {HTMLElement}
 */
function detailTile(label, value, sub, opts = {}) {
  const tile = el('div', 'tile');
  const k = el('span', 'tile-k', label);
  if (opts.live) k.appendChild(el('span', 'hero-live'));
  tile.appendChild(k);

  const v = el('div', `tile-v${opts.num ? ' num' : ''}${opts.tone ? ` ${opts.tone}` : ''}`);
  if (typeof value === 'string') v.appendChild(document.createTextNode(value));
  else v.appendChild(value);
  if (opts.title) v.title = opts.title;
  tile.appendChild(v);

  if (sub) tile.appendChild(el('span', 'tile-sub', sub));
  return tile;
}

/**
 * 明细区的单张进度卡（方案 B 版进度行：名称 + 大号剩余百分比 + 进度条 + 用量说明）。
 * 条长口径与 creditBarRow 完全一致：填充 = 剩余额度（越长越充足），百分比同源。
 * @param {object} group
 * @param {number} index 展示顺序（决定配色档位）
 * @returns {HTMLElement}
 */
function creditBarCard(group, index) {
  const tone = barToneClass(index);
  const percent = creditRemainPercent(group);

  const card = el('div', 'pcard');
  const head = el('div', 'pcard-head');
  const name = el('span', 'bar-name');
  name.appendChild(el('span', `sw ${tone}`));
  name.appendChild(el('span', null, group.label || '积分'));
  head.appendChild(name);
  head.appendChild(el('span', `pcard-pct ${tone}`, `剩余 ${percent}%`));
  card.appendChild(head);

  const track = el('div', 'bar-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', `${group.label || '积分'}剩余额度`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percent));
  const fill = el('span', `bar-fill ${tone}`);
  fill.style.width = `${percent}%`;
  track.appendChild(fill);
  card.appendChild(track);

  const cap = el('div', 'pcard-cap');
  cap.appendChild(document.createTextNode('已使用 '));
  cap.appendChild(el('b', null, fmtCredits(group.used)));
  cap.appendChild(document.createTextNode(`/${fmtCredits(group.total)}`));
  if (group.expiring) cap.appendChild(el('span', 'credit-expiry', '即将过期'));
  card.appendChild(cap);
  return card;
}

/**
 * 进度条「剩余百分比」（0~100 整数）：优先后端 remainPercent，缺失时用 (total-used)/total 兜底。
 * creditBarRow 与 creditBarCard 共用，保证条宽与文案永远一致。
 * @param {object} group
 * @returns {number}
 */
function creditRemainPercent(group) {
  const total = Number(group.total);
  const used = Number(group.used);
  const reported = Number(group.remainPercent);
  if (Number.isFinite(reported)) return Math.max(0, Math.min(100, Math.round(reported)));
  if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) {
    return Math.max(0, Math.min(100, Math.round(((total - used) / total) * 100)));
  }
  return 0;
}

/**
 * 明细面板里的小按钮。
 * @param {string} label
 * @param {Function} onClick
 * @param {string} [extraClass] 追加类（如 btn-primary 把「测试签到」升为主按钮）
 * @returns {HTMLElement}
 */
function detailAction(label, onClick, extraClass) {
  const btn = el('button', `btn btn-ghost btn-sm${extraClass ? ` ${extraClass}` : ''}`, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * 积分配额区块（含加载 / 错误 / 空态）。卡片与列表明细共用。
 * @param {object} account
 * @param {object|undefined} entry
 * @returns {HTMLElement}
 */
function creditBlock(account, entry) {
  const wrap = el('div', 'credit-block');

  if (!entry || (entry.loading && !entry.data)) {
    wrap.appendChild(el('div', 'credit-loading', '正在查询积分配额…'));
    const skeleton = el('div', 'credit-skeleton');
    skeleton.appendChild(el('div', 'skeleton-row'));
    skeleton.appendChild(el('div', 'skeleton-row'));
    wrap.appendChild(skeleton);
    return wrap;
  }

  if (entry.error) {
    const error = el('div', 'credit-error');
    // 只有「确实 401」才归到 token 问题；403/429/超时等环境问题直接显示后端 message，
    // 否则会把出口风控误报成 token 失效（用户改 token 也修不好）。
    // token 失效时优先用后端 message：它已经区分了「已过期 / 缺 refresh_token / 续期失败」。
    error.appendChild(el('span', null, entry.error.tokenInvalid === true
      ? (entry.error.message || 'Token 已失效，请更新账号 token 后重试')
      : (entry.error.message || '额度查询失败')));
    if (entry.error.tokenInvalid === true) {
      const fix = el('button', 'btn btn-ghost btn-sm', '更新 Token');
      fix.type = 'button';
      fix.addEventListener('click', () => openAccountDialog(account));
      error.appendChild(fix);
    }
    const retry = el('button', 'btn btn-ghost btn-sm', '重试');
    retry.type = 'button';
    retry.addEventListener('click', () => loadCredits(account.id));
    error.appendChild(retry);
    wrap.appendChild(error);
    return wrap;
  }

  const data = entry.data;
  if (!data) {
    wrap.appendChild(el('div', 'credit-loading', '尚未查询积分配额'));
    return wrap;
  }

  // ---- Hero 头部：总剩余积分（大号等宽数字，卡片的核心视觉） ----
  const top = el('div', 'hero-top');
  const label = el('span', 'hero-label');
  label.appendChild(el('span', 'hero-live'));
  label.appendChild(document.createTextNode('总剩余积分'));
  top.appendChild(label);

  const num = el('span', 'hero-num', fmtCredits(data.totalLeft));
  // 只有确实是数字时才带「分」后缀；缺失态显示「—」时不带单位
  if (data.totalLeft !== null && data.totalLeft !== undefined && Number.isFinite(Number(data.totalLeft))) {
    num.appendChild(el('span', 'hero-unit', '分'));
  }
  top.appendChild(num);
  wrap.appendChild(top);

  // ---- 双色进度行：套餐基础 = primary 绿，平台奖励 = info 蓝（按展示顺序取色） ----
  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (groups.length === 0) {
    wrap.appendChild(el('p', 'credit-loading', '暂无有效积分包'));
    return wrap;
  }
  const bars = el('div', 'hero-bars');
  for (const group of groups) bars.appendChild(creditBarRow(group, bars.childElementCount));
  wrap.appendChild(bars);

  // data.switchAt（积分切换时间）只有 cockpit tools 用，签到面板不展示
  return wrap;
}

/**
 * Hero 面板里的单条进度行（色点 + 名称 + 已使用/总量 + 进度条 + 剩余百分比）。
 *
 * 条长表示**剩余额度**（越长越充足），与右侧「剩余 X%」同源 —— 与旧 credit-group 完全同一口径。
 * ⚠ 不要改回 `used / total`：填充色是主题色，用主题色表示「已用」会出现
 * 「满格 = 额度用光」的反直觉表达。旁边「已使用 x/y」只是数字说明，不冲突。
 * @param {object} group
 * @param {number} index 展示顺序（决定配色档位）
 * @returns {HTMLElement}
 */
function creditBarRow(group, index) {
  const row = el('div', 'bar-row');

  // 优先后端 remainPercent，缺失时 (total-used)/total 兜底 —— 与 creditBarCard 共用同一口径
  const percent = creditRemainPercent(group);

  const name = el('span', 'bar-name');
  name.appendChild(el('span', `sw ${barToneClass(index)}`));
  name.appendChild(el('span', null, group.label || '积分'));
  row.appendChild(name);

  const val = el('span', 'bar-val');
  val.appendChild(document.createTextNode('已使用 '));
  val.appendChild(el('b', null, fmtCredits(group.used)));
  val.appendChild(document.createTextNode(`/${fmtCredits(group.total)}`));
  row.appendChild(val);

  const track = el('div', 'bar-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', `${group.label || '积分'}剩余额度`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percent));
  const fill = el('span', `bar-fill ${barToneClass(index)}`);
  fill.style.width = `${percent}%`;
  track.appendChild(fill);
  row.appendChild(track);

  row.appendChild(el('span', 'bar-pct', `剩余 ${percent}%`));

  if (group.expiring) row.appendChild(el('span', 'credit-expiry', '即将过期'));
  return row;
}

/**
 * 进度条配色档位：第 1 条 = 套餐基础（primary 绿），第 2 条 = 平台奖励（info 蓝），
 * 更多档位（套餐赠送 / 购买积分）用 warn 琥珀区分，避免再引入新色彩 token。
 * @param {number} index
 * @returns {string}
 */
function barToneClass(index) {
  if (index === 0) return 'plan-c';
  if (index === 1) return 'bonus-c';
  return 'warn-c';
}

/**
 * 日志筛选（纯内存过滤，零请求）。
 * @returns {object[]}
 */
function visibleLogs() {
  const q = state.filters.q.trim().toLowerCase();
  return state.logs.filter((run) => {
    if (state.filters.onlyFailed && !(Number(run.failed) > 0)) return false;
    if (!q) return true;
    if (String(run.runId || '').toLowerCase().includes(q)) return true;
    if (String(run.trigger || '').toLowerCase().includes(q)) return true;
    for (const item of Array.isArray(run.accountResults) ? run.accountResults : []) {
      if (item && accountName(item.accountId).toLowerCase().includes(q)) return true;
    }
    const detail = state.details[run.runId];
    if (detail && Array.isArray(detail.entries)) {
      for (const entry of detail.entries) {
        if (String(entry.accountName || '').toLowerCase().includes(q)) return true;
      }
    }
    return false;
  });
}

/**
 * 日志页副标题与条数：成功率等统计全部从 state.logs 聚合，样本为 0 时整句省略。
 * @param {object[]} rows 当前筛选后的行
 */
function renderLogsStats(rows) {
  const count = $('#logs-count');
  if (count) count.textContent = `${rows.length} 条`;

  const sub = $('#logs-sub');
  if (!sub) return;
  const total = state.logs.length;
  if (total === 0) {
    sub.textContent = '还没有执行记录';
    return;
  }
  let sumSuccess = 0;
  let sumTotal = 0;
  for (const run of state.logs) {
    sumSuccess += Number(run.success) || 0;
    sumTotal += Number(run.total) || 0;
  }
  const parts = [`最近 ${total} 次执行`];
  if (sumTotal > 0) parts.push(`成功率 ${Math.round((sumSuccess / sumTotal) * 100)}%`);
  const newest = state.logs[0];
  const writes = newest ? Number(newest.kvWriteCount) : NaN;
  if (Number.isFinite(writes)) parts.push(`最近一次写入 ${writes} 次 KV`);
  sub.textContent = parts.join(' · ');
}

function renderLogs() {
  const list = $('#logs-list');
  const skeleton = $('#logs-skeleton');
  const empty = $('#logs-empty');
  if (!list || !skeleton || !empty) return;

  list.textContent = '';

  const loading = state.loading.logs && state.logs.length === 0;
  skeleton.hidden = !loading;

  const rows = visibleLogs();
  renderLogsStats(rows);
  renderNav();

  if (loading) {
    empty.hidden = true;
    return;
  }
  if (state.logs.length === 0) {
    empty.hidden = false;
    empty.textContent = '还没有执行记录。后台每 15 分钟扫描一次，到账号设定的签到时间才会真正执行；也可以点「立即全部签到」。';
    return;
  }
  if (rows.length === 0) {
    empty.hidden = false;
    empty.textContent = '没有符合筛选条件的记录。';
    return;
  }
  empty.hidden = true;
  for (const run of rows) {
    list.appendChild(runItem(run));
  }
}

/**
 * 日志行（头部是 <button>，可键盘操作；不用相邻兄弟选择器，避免轮询重绘时错位）。
 * @param {object} run RunSummary
 * @returns {HTMLElement}
 */
function runItem(run) {
  const wrap = el('div', `log-item${state.opened[run.runId] ? ' is-open' : ''}`);

  const head = el('button', 'log-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', state.opened[run.runId] ? 'true' : 'false');

  const time = el('div', 'log-time');
  time.appendChild(el('b', null, fmtTime(run.startedAt)));
  time.appendChild(el('small', null, fmtRelative(run.startedAt)));

  const trigger = el('span', 'trg');
  trigger.appendChild(triggerBadge(run.trigger));

  const meta = el('div', 'log-sum');
  const total = Number(run.total) || 0;
  const success = Number(run.success) || 0;
  const failed = Number(run.failed) || 0;
  const skipped = Number(run.skipped) || 0;
  const writes = Number(run.kvWriteCount) || 0;
  // 单行紧凑摘要：成功 2/3 · 失败 1 · 269ms · 写入 4（失败为 0 时不出现「失败 0」）
  // 只有「失败 N」这一段染红，其余保持次级正文色。
  meta.appendChild(document.createTextNode(`成功 ${success}/${total}`));
  if (failed > 0) {
    meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(el('span', 'bad', `失败 ${failed}`));
  }
  if (skipped > 0) meta.appendChild(document.createTextNode(` · 跳过 ${skipped}`));
  meta.appendChild(document.createTextNode(` · ${fmtDuration(run.durationMs)} · 写入 ${writes}`));
  if (run.truncated) meta.appendChild(document.createTextNode(' · 已截断'));

  const chevron = el('span', 'log-chevron');
  chevron.appendChild(icon('chev'));

  head.appendChild(time);
  head.appendChild(trigger);
  head.appendChild(meta);
  head.appendChild(chevron);
  head.addEventListener('click', () => toggleRun(run.runId));

  wrap.appendChild(head);

  if (state.opened[run.runId]) {
    const body = el('div', 'log-body');
    const detail = state.details[run.runId];
    if (!detail) {
      body.appendChild(el('p', 'muted', '加载中…'));
    } else if (detail.error) {
      body.appendChild(el('p', 'form-error', detail.error));
    } else {
      const entries = Array.isArray(detail.entries) ? detail.entries : [];
      if (entries.length === 0) {
        body.appendChild(el('p', 'muted', '这次执行没有任何账号记录。'));
      }
      for (const entry of entries) {
        body.appendChild(entryRow(entry));
      }
    }
    wrap.appendChild(body);
  }

  return wrap;
}

/**
 * @param {object} entry LogEntry
 * @returns {HTMLElement}
 */
function entryRow(entry) {
  const row = el('div', 'entry');
  row.appendChild(el('div', 'entry-name', entry.accountName || entry.accountId || '未知账号'));
  row.appendChild(resultBadge(entry.result));
  row.appendChild(el('div', 'entry-msg', entry.message || '—'));

  const sub = el('div', 'entry-sub');
  sub.appendChild(el('span', null, `HTTP ${entry.httpStatus === null || entry.httpStatus === undefined ? '—' : entry.httpStatus}`));
  sub.appendChild(el('span', null, `code ${entry.code === null || entry.code === undefined ? '—' : entry.code}`));
  if (entry.streakDays !== null && entry.streakDays !== undefined) sub.appendChild(el('span', null, `连续 ${entry.streakDays} 天`));
  if (entry.credit !== null && entry.credit !== undefined) sub.appendChild(el('span', null, `+${entry.credit} 额度`));
  sub.appendChild(el('span', null, fmtDuration(entry.durationMs)));
  if (entry.tokenInvalid) sub.appendChild(el('span', 'badge badge-bad', 'token 失效'));
  row.appendChild(sub);
  return row;
}

function renderSettings() {
  const settings = state.settings;
  const retention = $('#retention-input');
  // 焦点保护：用户正在这个输入框里打字时，30s 轮询不得覆写 value（否则光标与输入一起丢）
  if (settings && retention && document.activeElement !== retention) {
    retention.value = String(settings.retentionRuns);
  }

  const prefixNode = $('#mcp-prefix');
  const exists = Boolean(state.mcpKey && state.mcpKey.exists);
  if (prefixNode) {
    prefixNode.textContent = exists
      ? `当前 Key：${state.mcpKey.prefix || '（未知前缀）'}`
      : '未生成';
    const box = prefixNode.closest('.keybox');
    if (box) box.classList.toggle('is-off', !exists);
  }

  const genBtn = $('#btn-gen-mcp');
  if (genBtn) setButtonContent(genBtn, null, exists ? '重置 Key' : '生成 Key');
}

/** 同步所有按钮的 busy 状态（spinner 在按钮内，文案不变；每个节点都做空值保护）。 */
function syncBusy() {
  const runBtn = $('#btn-run-all');
  if (runBtn) {
    runBtn.disabled = state.busy.run;
    runBtn.classList.toggle('is-busy', state.busy.run);
    runBtn.setAttribute('aria-busy', state.busy.run ? 'true' : 'false');
    setButtonContent(runBtn, 'play', '立即全部签到');
  }

  /**
   * @param {string} selector
   * @param {boolean} disabled
   * @param {boolean} [busy] 传了才更新 is-busy / aria-busy
   */
  const setState = (selector, disabled, busy) => {
    const node = $(selector);
    if (!node) return;
    node.disabled = disabled === true;
    if (busy !== undefined) {
      node.classList.toggle('is-busy', busy === true);
      node.setAttribute('aria-busy', busy === true ? 'true' : 'false');
    }
  };

  setState('#btn-add-account', state.busy.run);
  setState('#btn-import-accounts', state.busy.run || state.busy.import, state.busy.import);
  setState('#btn-clear-logs', state.busy.run);
  setState('#btn-save-retention', state.busy.retention);
  setState('#btn-gen-mcp', state.busy.key);
  setState('#btn-change-pw', state.busy.pw);
  setState('#btn-setup', state.busy.setup);
  setState('#btn-login', state.busy.login);

  // 「导出全部」忙碌态：单账号导出不影响这里，反之亦然
  const exportAllBtn = $('#btn-export-accounts');
  if (exportAllBtn) {
    exportAllBtn.disabled = state.busy.export.all;
    // 整轮签到期间上游可能正在轮换 token，此时导出的会是半截状态，先与 run 互斥
    if (state.busy.run) exportAllBtn.disabled = true;
    exportAllBtn.classList.toggle('is-busy', state.busy.export.all);
    exportAllBtn.setAttribute('aria-busy', state.busy.export.all ? 'true' : 'false');
  }
}

// ============ 网络层 ============

/**
 * 统一 API 客户端。
 * @param {string} path
 * @param {{method?:string, body?:*, headers?:Record<string,string>, allow401?:boolean}} [options]
 * @returns {Promise<*>} 信封里的 data
 */
async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { ...(options.headers || {}) },
  };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('NETWORK', '网络错误，请检查连接后重试', 0);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401 && !options.allow401) {
    stopPolling();
    state.me = null;
    showView('login');
    const message = payload && payload.error && payload.error.message ? payload.error.message : '登录已失效，请重新登录';
    setAuthError('UNAUTHORIZED', message);
    throw new ApiError('UNAUTHORIZED', message, 401);
  }

  if (!payload || typeof payload !== 'object') {
    throw new ApiError('BAD_RESPONSE', `服务返回异常（HTTP ${response.status}）`, response.status);
  }
  if (payload.ok === false) {
    const error = payload.error || {};
    throw new ApiError(error.code || 'INTERNAL', error.message || '请求失败', response.status, payload.detail || null);
  }
  return payload.data;
}

// ============ 数据加载 ============

/** 启动流程：bootstrap -> session 探活 -> setup / login / panel。 */
async function boot() {
  clearAuthError();
  try {
    const data = await api('/api/bootstrap', { allow401: true });
    state.setupTokenRequired = Boolean(data && data.setupTokenRequired);
    state.bootstrap = {
      initialized: Boolean(data && data.initialized),
      version: (data && data.version) || '',
      setupTokenRequired: state.setupTokenRequired,
    };
    const tokenWrap = $('#setup-token-wrap');
    if (tokenWrap) tokenWrap.hidden = !state.setupTokenRequired;
    renderNav();

    if (!data || !data.initialized) {
      showView('setup');
      renderAuthError();
      return;
    }
    try {
      const me = await api('/api/session', { allow401: true });
      state.me = me;
      await enterPanel();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        showView('login');
        renderAuthError();
        return;
      }
      throw err;
    }
  } catch (err) {
    // bootstrap 本身失败：留在登录页给一个重试入口
    showView('login');
    const retry = $('#btn-retry');
    if (retry) retry.hidden = false;
    setAuthError(err.code || 'NETWORK', err.message || '无法连接服务');
  }
}

/** 进入面板：切视图 + 开轮询 + 首屏并发 4 个 GET。 */
async function enterPanel() {
  showView('panel');
  state.authError = null;
  renderAuthError();
  startPolling();
  await loadPanel();
}

/** 首屏 4 个 GET 并发；任一失败只显示错误条，不清空其他区块。 */
async function loadPanel() {
  state.loading.accounts = true;
  state.loading.logs = true;
  renderAccounts();
  renderLogs();

  const results = await Promise.allSettled([
    api('/api/accounts').then((data) => { state.accounts = Array.isArray(data) ? data : []; }),
    api('/api/logs').then((data) => { state.logs = Array.isArray(data) ? data : []; }),
    api('/api/settings').then((data) => { state.settings = data || null; }),
    api('/api/mcp-key').then((data) => { state.mcpKey = data || { exists: false }; }),
  ]);

  state.loading.accounts = false;
  state.loading.logs = false;

  const failure = results.find((item) => item.status === 'rejected');
  if (failure) {
    const err = failure.reason;
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '加载失败');
    }
  } else {
    clearError();
  }
  renderAll();
  // 首屏先渲染账号与日志，再后台补积分（每账号 3 个上游请求，不阻塞首屏）
  void loadAllCredits({ onlyMissing: true, silent: true });
}

/** 轮询只刷日志与设置（零额外读）。 */
async function refreshQuiet() {
  if (state.view !== 'panel') return;
  const results = await Promise.allSettled([
    api('/api/logs').then((data) => { state.logs = Array.isArray(data) ? data : []; }),
    api('/api/settings').then((data) => { state.settings = data || null; }),
  ]);
  const failure = results.find((item) => item.status === 'rejected');
  if (failure && !(failure.reason instanceof ApiError && failure.reason.status === 401)) {
    setError(failure.reason.code || 'INTERNAL', failure.reason.message || '刷新失败');
    return;
  }
  if (!failure) clearError();
  renderLogs();
  renderSettings();
  renderAccounts();
}

let pollTimer = null;

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (state.view !== 'panel') return;
    refreshQuiet();
  }, 30000);
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 只刷新账号（增删改后）。
 * @param {{force?:boolean}} [options] force=true 时无视焦点守卫强制重绘
 */
async function refreshAccounts(options = {}) {
  try {
    const data = await api('/api/accounts');
    state.accounts = Array.isArray(data) ? data : [];
    // 账号可能被删：清掉指向已不存在账号的展开态
    const ids = new Set(state.accounts.map((account) => account.id));
    for (const id of Object.keys(state.expanded)) {
      if (!ids.has(id)) delete state.expanded[id];
    }
    for (const id of Object.keys(state.credits)) {
      if (!ids.has(id)) delete state.credits[id];
    }
    renderAccounts(options.force === true);
    void loadAllCredits({ onlyMissing: true, silent: true });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message);
  }
}

/**
 * 查询单个账号的积分配额（只读上游，零 KV 写）。
 * @param {string} accountId
 * @param {{silent?:boolean, render?:boolean}} [options]
 * @returns {Promise<void>}
 */
async function loadCredits(accountId, options = {}) {
  const id = String(accountId || '');
  if (!id) return;
  const current = state.credits[id];
  if (current && current.loading) return;
  const render = options.render !== false;
  state.credits[id] = { loading: true, data: current ? current.data : null, error: null };
  if (render) renderAccounts();

  try {
    const data = await api(`/api/accounts/${encodeURIComponent(id)}/credits`);
    state.credits[id] = { loading: false, data: data || null, error: null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // 401 表示面板会话失效，api() 已统一回登录页，这里不再渲染错误
      state.credits[id] = { loading: false, data: null, error: null };
      return;
    }
    state.credits[id] = {
      loading: false,
      data: null,
      error: {
        code: (err && err.code) || 'INTERNAL',
        message: (err && err.message) || '额度查询失败',
        tokenInvalid: Boolean(err && err.detail && err.detail.tokenInvalid),
      },
    };
    if (!options.silent) toast(`额度查询失败：${(err && err.message) || '未知错误'}`, 'bad');
  } finally {
    if (render) renderAccounts();
  }
}

/**
 * 批量查询积分配额（首屏 / 手动刷新 / 新增账号后）。
 * @param {{onlyMissing?:boolean, silent?:boolean}} [options]
 * @returns {Promise<void>}
 */
async function loadAllCredits(options = {}) {
  const targets = state.accounts.filter((account) => {
    if (!account || !account.id) return false;
    if (!options.onlyMissing) return true;
    const entry = state.credits[account.id];
    return !entry || (!entry.loading && !entry.data && !entry.error);
  });
  if (targets.length === 0) return;
  await Promise.allSettled(targets.map((account) =>
    loadCredits(account.id, { silent: options.silent !== false, render: false })));
  renderAccounts();
}

/** 只刷新日志与设置（执行签到后）。 */
async function refreshLogs() {
  try {
    const [logs, settings] = await Promise.all([api('/api/logs'), api('/api/settings')]);
    state.logs = Array.isArray(logs) ? logs : [];
    state.settings = settings || null;
    renderLogs();
    renderSettings();
    renderAccounts();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message);
  }
}

// ============ 动作 ============

async function submitSetup() {
  const password = $('#setup-password').value;
  const confirm = $('#setup-confirm').value;
  const setupToken = $('#setup-token').value.trim();
  // 与后端同口径：长度校验用 trim 后的值（后端也 trim），但提交原值
  const passwordValue = password.trim();
  const confirmValue = confirm.trim();
  clearAuthError();

  if (passwordValue.length < 8) {
    setAuthError('BAD_REQUEST', '密码至少 8 位');
    return;
  }
  if (passwordValue.length > 128) {
    setAuthError('BAD_REQUEST', '密码不能超过 128 位');
    return;
  }
  if (passwordValue !== confirmValue) {
    setAuthError('BAD_REQUEST', '两次输入的密码不一致');
    return;
  }
  if (state.setupTokenRequired && !setupToken) {
    setAuthError('FORBIDDEN', '请输入部署令牌（SETUP_TOKEN）');
    return;
  }

  state.busy.setup = true;
  syncBusy();
  try {
    const headers = setupToken ? { 'x-setup-token': setupToken } : {};
    await api('/api/setup', { method: 'POST', body: { password }, headers, allow401: true });
    toast('密码已设置，正在登录…', 'ok');
    await loginWith(password);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setAuthError(err.code || 'INTERNAL', err.message || '设置失败');
  } finally {
    state.busy.setup = false;
    syncBusy();
  }
}

/**
 * 用已知密码登录（setup 成功后自动调用）。
 * @param {string} password
 */
async function loginWith(password) {
  const data = await api('/api/login', { method: 'POST', body: { password }, allow401: true });
  state.me = { authenticated: true, expiresAt: data.expiresAt };
  $('#setup-password').value = '';
  $('#setup-confirm').value = '';
  $('#login-password').value = '';
  await enterPanel();
}

async function submitLogin() {
  const password = $('#login-password').value;
  clearAuthError();
  if (!password) {
    setAuthError('BAD_REQUEST', '请输入密码');
    return;
  }
  state.busy.login = true;
  syncBusy();
  try {
    await loginWith(password);
    toast('登录成功', 'ok');
  } catch (err) {
    setAuthError(err.code || 'INTERNAL', err.message || '登录失败');
  } finally {
    state.busy.login = false;
    syncBusy();
  }
}

async function doLogout() {
  try {
    await api('/api/logout', { method: 'POST', allow401: true });
  } catch {
    /* 登出失败也照样清本地状态 */
  }
  stopPolling();
  state.me = null;
  state.accounts = [];
  state.logs = [];
  state.settings = null;
  state.mcpKey = null;
  state.credits = {};
  state.details = {};
  state.opened = {};
  state.expanded = {};
  clearError();
  clearAuthError();
  showView('login');
  toast('已登出', 'info');
}

async function runAll() {
  if (state.busy.run) return;
  state.busy.run = true;
  syncBusy();
  renderAccounts();
  try {
    const data = await api('/api/checkin/run', { method: 'POST', body: {} });
    const summary = data && data.summary ? data.summary : null;
    if (summary) {
      const kind = Number(summary.failed) > 0 ? 'warn' : 'ok';
      toast(`已完成：成功 ${summary.success} / 共 ${summary.total}${summary.failed ? `（失败 ${summary.failed}）` : ''}`, kind);
    } else {
      toast('已完成', 'ok');
    }
    if (data && data.flushError) setError('INTERNAL', data.flushError.message || '日志写入失败');
    await refreshLogs();
    // 整轮签到会改变多个账号的额度，统一重查（只读上游）
    void loadAllCredits({ silent: true });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONFLICT') {
      toast('已有任务在执行，请稍后再试', 'warn');
      setError('CONFLICT', err.message);
    } else if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '签到失败');
      toast('签到失败：' + (err.message || '未知错误'), 'bad');
    }
  } finally {
    state.busy.run = false;
    syncBusy();
    renderAccounts();
  }
}

/**
 * @param {object} account
 */
async function testCheckin(account) {
  if (state.busy.test) return;
  state.busy.test = account.id;
  renderAccounts();
  try {
    const data = await api(`/api/accounts/${encodeURIComponent(account.id)}/checkin`, { method: 'POST', body: {} });
    const result = data && data.result ? data.result : 'failed';
    if (result === 'checked_in') toast(`${account.name}：签到成功`, 'ok');
    else if (result === 'already_checked_in') toast(`${account.name}：今日已签到`, 'info');
    else toast(`${account.name}：${data && data.message ? data.message : '签到失败'}`, Number(data && data.tokenInvalid) ? 'bad' : 'warn');
    await refreshLogs();
    // 签到会消耗额度，顺带刷新该账号积分
    void loadCredits(account.id, { silent: true });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UPSTREAM_ERROR') {
      toast('上游不可用，请稍后再试', 'bad');
      setError('UPSTREAM_ERROR', err.message);
    } else if (err instanceof ApiError && err.code === 'CONFLICT') {
      toast('已有任务在执行', 'warn');
    } else if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '签到失败');
      toast('签到失败：' + (err.message || '未知错误'), 'bad');
    }
  } finally {
    state.busy.test = null;
    renderAccounts();
  }
}

let editingAccountId = null;

/**
 * 账号弹窗的录入方式与 OAuth 授权会话状态（纯模块局部，不进全局 state：
 * 它只影响弹窗内部，不参与全量渲染，避免轮询把整个账号列表重绘一遍）。
 */
const accountForm = {
  /** 当前录入方式：'oauth' | 'token' */
  mode: 'oauth',
  /** 上游 state（凭据，取消/成功后立刻清空，不写 localStorage） */
  state: '',
  /** 授权链接（放只读输入框，供弹窗被拦截时手动复制） */
  uri: '',
  /** 轮询间隔（毫秒），取值来自 /api/oauth/start 的 intervalSeconds */
  intervalMs: 2000,
  /** 授权会话截止时刻（毫秒）；超时后停止轮询并提示重新生成 */
  deadlineMs: 0,
  /** setTimeout 句柄（必须串行，不能 setInterval 叠加请求） */
  timer: null,
  /** 会话序号：每次重置 +1，用于丢弃上一轮迟到的响应 */
  sequence: 0,
  /** 是否已经成功生成过授权链接（决定主按钮文案） */
  started: false,
  /** 连续瞬时失败次数（网络错误 / 上游 5xx）：达到上限才停表，避免一次波动就中断等待 */
  failures: 0,
};

/** 授权会话默认有效期与轮询间隔（服务端没给时的兜底，与服务端常量一致）。 */
const OAUTH_TTL_MS = 600 * 1000;
const OAUTH_INTERVAL_MS = 2000;
/** 连续瞬时失败上限：到第 3 次才报错，前两次继续按间隔重试。 */
const OAUTH_MAX_TRANSIENT_FAILURES = 3;

/**
 * 打开账号弹窗。
 * @param {object|null} account null 表示新增
 */
function openAccountDialog(account) {
  editingAccountId = account ? account.id : null;
  $('#dlg-account-title').textContent = account ? '编辑账号' : '新增账号';
  $('#acc-name').value = account ? account.name : '';
  $('#acc-token').value = '';
  $('#acc-token').placeholder = account ? `留空则不修改（当前 ${account.tokenMasked}）` : '粘贴 WorkBuddy token';
  $('#acc-refresh-token').value = '';
  $('#acc-refresh-token').placeholder = account && account.hasRefreshToken
    ? '留空则不修改（已保存）'
    : '粘贴 refresh_token（否则 token 失效后只能手动重导）';
  $('#acc-uid').value = account ? account.uid || '' : '';
  $('#acc-remark').value = account ? account.remark || '' : '';
  $('#acc-enabled').checked = account ? account.enabled === true : true;
  // 每次打开都复位：关掉上一次残留的 state / 定时器 / 授权链接
  resetOauthFlow();
  // 编辑已有账号只能是 Token 录入（OAuth 会整组覆盖 token，不能当「编辑」用）
  const modeSwitch = $('#acc-mode-switch');
  if (modeSwitch) modeSwitch.hidden = Boolean(account);
  setAccountMode(account ? 'token' : 'oauth');
  setFormError('#dlg-account-error', '');
  $('#dlg-account').showModal();
}

// ============ 账号录入方式：OAuth 授权 / Token 录入 ============

/**
 * 切换录入方式。
 * - OAuth：隐藏名称/token/refresh/uid/备注与「保存」按钮，只留「取消」（名称由上游资料生成，可后续编辑）；
 * - Token：显示原有全部字段与「保存」按钮，行为与校验完全不变。
 * @param {'oauth'|'token'} mode
 */
function setAccountMode(mode) {
  const next = mode === 'token' ? 'token' : 'oauth';
  accountForm.mode = next;
  const oauthOn = next === 'oauth';

  const oauthPanel = $('#acc-oauth-panel');
  const tokenPanel = $('#acc-token-panel');
  if (oauthPanel) oauthPanel.hidden = !oauthOn;
  if (tokenPanel) tokenPanel.hidden = oauthOn;

  // 两个标签同时维护 aria-selected（role=tab）与 aria-pressed（按钮语义），读屏两种姿势都能播报
  for (const [selector, on] of [['#acc-mode-oauth', oauthOn], ['#acc-mode-token', !oauthOn]]) {
    const btn = $(selector);
    if (!btn) continue;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // 底部主操作随录入方式切换：OAuth = 授权登录，Token = 保存录入（两者都固定在「取消」右侧）
  const save = $('#btn-acc-save');
  if (save) save.hidden = oauthOn;
  const start = $('#btn-acc-oauth-start');
  if (start) start.hidden = !oauthOn;

  // 「启用」勾选保留可见：OAuth 新建的账号服务端一律 enabled=true（账号此刻还不存在，无从选择），
  // 因此这里置灰并复位为勾选，避免用户以为「取消勾选就不启用」；创建后可在账号列表里随时关闭。
  const enabled = $('#acc-enabled');
  if (enabled) {
    enabled.disabled = oauthOn;
    if (oauthOn) {
      enabled.checked = true;
      enabled.title = 'OAuth 授权创建的账号默认启用，可在账号列表里随时关闭';
    } else {
      enabled.title = '';
    }
  }

  // 切回 Token 录入时把后台轮询停掉，避免两套交互状态同时存在
  if (!oauthOn) resetOauthFlow();
  setFormError('#dlg-account-error', '');
}

/**
 * tablist 键盘操作：左右方向键在两个标签之间切换（Enter/Space 由 button 原生处理）。
 * @param {KeyboardEvent} event
 */
function onAccountModeKeydown(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const next = accountForm.mode === 'oauth' ? 'token' : 'oauth';
  setAccountMode(next);
  const btn = next === 'oauth' ? $('#acc-mode-oauth') : $('#acc-mode-token');
  if (btn) btn.focus();
}

/**
 * 停止轮询（清定时器 + 让上一轮在途请求的响应失效）。
 */
function stopOauthPolling() {
  if (accountForm.timer !== null) {
    window.clearTimeout(accountForm.timer);
    accountForm.timer = null;
  }
  accountForm.sequence += 1;
}

/**
 * 复位授权会话（不清录入方式）：清 state / 链接 / 状态文案 / 按钮态。
 */
function resetOauthFlow() {
  stopOauthPolling();
  accountForm.state = '';
  accountForm.uri = '';
  accountForm.deadlineMs = 0;
  accountForm.started = false;
  accountForm.failures = 0;

  const input = $('#acc-oauth-url');
  if (input) input.value = '';
  const copy = $('#btn-acc-oauth-copy');
  if (copy) copy.disabled = true;
  const start = $('#btn-acc-oauth-start');
  if (start) {
    start.disabled = false;
    start.textContent = '授权登录';
  }
  hideOauthAbortButton();
  setOauthStatus('');
  setFormError('#acc-oauth-error', '');
}

/**
 * 写状态行。
 * @param {string} text
 * @param {'idle'|'ok'|'warn'|'bad'} [kind]
 */
function setOauthStatus(text, kind = 'idle') {
  const node = $('#acc-oauth-status');
  if (!node) return;
  node.textContent = typeof text === 'string' ? text : '';
  const classes = ['status-line'];
  if (kind === 'ok') classes.push('is-ok');
  else if (kind === 'warn') classes.push('is-warn');
  else if (kind === 'bad') classes.push('is-bad');
  node.className = classes.join(' ');
}

/**
 * 展示授权流程错误（含错误码，便于对照服务端日志）。
 * @param {*} err
 */
function setOauthError(err) {
  const code = (err && err.code) || 'INTERNAL';
  const message = (err && err.message) || '授权失败';
  setFormError('#acc-oauth-error', `${code}: ${message}`);
}

/**
 * 等待态文案（每次轮询都刷新剩余秒数）。
 */
function renderOauthWaiting() {
  const remainSec = Math.max(0, Math.ceil((accountForm.deadlineMs - Date.now()) / 1000));
  setOauthStatus(`等待授权…（剩余 ${remainSec} 秒）请在弹出的官方页面完成登录，本页会自动检测结果`, 'warn');
}

/**
 * 主按钮切到「可重试」态（过期 / 出错后仍能再生成一次）。
 * 只负责主按钮本身：是否显示「取消等待」由调用方决定（等待中要显示，失败/过期要隐藏）。
 * @param {string} label
 */
function restoreOauthStartButton(label) {
  const start = $('#btn-acc-oauth-start');
  if (start) {
    start.disabled = false;
    start.textContent = label;
  }
}

/**
 * 隐藏「取消等待」按钮。
 */
function hideOauthAbortButton() {
  const abort = $('#btn-acc-oauth-abort');
  if (abort) abort.hidden = true;
}

/**
 * 申请授权链接：POST /api/oauth/start -> window.open + 开始轮询。
 * 弹窗可能被浏览器拦截，因此链接同时放进只读输入框 + 提供「复制链接」兜底。
 */
async function startOauthLogin() {
  const button = $('#btn-acc-oauth-start');
  if (!button || button.disabled) return;

  // 重新生成 = 丢弃上一轮会话，新开一轮（sequence 变化后旧响应会被忽略）
  stopOauthPolling();
  accountForm.failures = 0;
  const runId = accountForm.sequence;
  button.disabled = true;
  button.textContent = '正在申请…';
  setFormError('#acc-oauth-error', '');
  setOauthStatus('正在向 WorkBuddy 申请授权链接…');

  try {
    const data = await api('/api/oauth/start', { method: 'POST', body: {} });
    if (accountForm.sequence !== runId) return;
    const uri = data && typeof data.verificationUri === 'string' ? data.verificationUri : '';
    const state = data && typeof data.state === 'string' ? data.state : '';
    if (!uri || !state) throw new ApiError('BAD_RESPONSE', '服务返回的授权信息不完整', 0);

    const intervalSec = Number(data.intervalSeconds);
    accountForm.intervalMs = Number.isFinite(intervalSec) && intervalSec > 0
      ? Math.min(10, Math.max(1, Math.round(intervalSec))) * 1000
      : OAUTH_INTERVAL_MS;
    const ttlSec = Number(data.expiresIn);
    const ttlMs = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec * 1000 : OAUTH_TTL_MS;

    accountForm.state = state;
    accountForm.uri = uri;
    accountForm.deadlineMs = Date.now() + ttlMs;
    accountForm.started = true;

    const input = $('#acc-oauth-url');
    if (input) input.value = uri;
    const copy = $('#btn-acc-oauth-copy');
    if (copy) copy.disabled = false;
    const abort = $('#btn-acc-oauth-abort');
    if (abort) abort.hidden = false;

    // noopener/noreferrer：绝不把本站 window 句柄交给外部页面。
    // 副作用是 window.open 恒返回 null，无法据此判断「是否被拦截」，
    // 所以统一 toast 提示「若未自动打开请复制链接」。
    window.open(uri, '_blank', 'noopener,noreferrer');
    toast('已打开授权页；若未自动打开，请复制链接手动访问', 'info');

    renderOauthWaiting();
    restoreOauthStartButton('重新生成链接');
    scheduleOauthPoll(runId);
  } catch (err) {
    if (accountForm.sequence !== runId) return;
    accountForm.state = '';
    accountForm.started = false;
    setOauthStatus('');
    setOauthError(err);
    hideOauthAbortButton();
    restoreOauthStartButton('授权登录');
  }
}

/**
 * 安排下一次轮询（setTimeout 串行，绝不 setInterval 叠加请求）。
 * @param {number} runId
 */
function scheduleOauthPoll(runId) {
  if (accountForm.sequence !== runId) return;
  if (!accountForm.state) return;
  if (accountForm.deadlineMs > 0 && Date.now() >= accountForm.deadlineMs) {
    expireOauthFlow('授权已超时，请点击「授权登录」重试');
    return;
  }
  accountForm.timer = window.setTimeout(() => {
    accountForm.timer = null;
    void pollOauthOnce(runId);
  }, accountForm.intervalMs);
}

/**
 * 轮询一次授权结果。
 * @param {number} runId
 */
async function pollOauthOnce(runId) {
  if (accountForm.sequence !== runId) return;
  const state = accountForm.state;
  if (!state) return;
  try {
    const data = await api(`/api/oauth/poll?state=${encodeURIComponent(state)}`);
    // 迟到响应：期间用户取消了 / 重新生成了 / 关了弹窗，一律丢弃
    if (accountForm.sequence !== runId) return;
    // 拿到正常响应（pending/success/expired）即视为链路恢复，重置瞬时失败计数
    accountForm.failures = 0;
    const status = data && typeof data.status === 'string' ? data.status : '';
    if (status === 'success') {
      await finishOauthFlow(data && data.account);
      return;
    }
    if (status === 'expired') {
      expireOauthFlow('授权已失效，请点击「授权登录」重试');
      return;
    }
    renderOauthWaiting();
    scheduleOauthPoll(runId);
  } catch (err) {
    if (accountForm.sequence !== runId) return;
    // 401 由 api() 统一处理（回登录页），这里只需停表
    if (err instanceof ApiError && err.status === 401) {
      stopOauthPolling();
      accountForm.state = '';
      return;
    }
    // 瞬时故障（网络错误 / 上游 5xx）不立刻打断等待：用户可能正在授权页登录，
    // 一有波动就停表会让人误以为授权失败。连续失败达到上限才真正报错。
    const transient = err instanceof ApiError && (err.status === 0 || err.status === 502);
    if (transient) {
      accountForm.failures += 1;
      if (accountForm.failures < OAUTH_MAX_TRANSIENT_FAILURES) {
        setOauthStatus(
          `网络波动，正在重试（${accountForm.failures}/${OAUTH_MAX_TRANSIENT_FAILURES}）…`,
          'warn',
        );
        scheduleOauthPoll(runId);
        return;
      }
    }
    stopOauthPolling();
    accountForm.state = '';
    accountForm.started = false;
    setOauthStatus('');
    setOauthError(err);
    hideOauthAbortButton();
    restoreOauthStartButton('重新生成链接');
  }
}

/**
 * 授权成功：关弹窗 -> toast -> 刷新列表 -> 拉新账号额度。
 * @param {object|null} account 服务端返回的脱敏账号
 */
async function finishOauthFlow(account) {
  const created = account && typeof account === 'object' ? account : {};
  stopOauthPolling();
  accountForm.state = '';
  accountForm.started = false;
  setOauthStatus('授权成功，账号已添加', 'ok');

  const dialog = $('#dlg-account');
  if (dialog && dialog.open) dialog.close();
  toast('账号已添加', 'ok');
  await refreshAccounts();
  if (typeof created.id === 'string' && created.id) {
    await loadCredits(created.id, { silent: true });
  }
}

/**
 * 授权会话过期（上游 state 失效 或 本地 600 秒超时）。
 * @param {string} message
 */
function expireOauthFlow(message) {
  stopOauthPolling();
  accountForm.state = '';
  accountForm.started = false;
  setOauthStatus(message, 'warn');
  hideOauthAbortButton();
  restoreOauthStartButton('重新生成链接');
}

/**
 * 取消等待：只停止轮询并回到未开始态（不调后端取消接口，state 会自然过期）。
 */
function abortOauthWait() {
  stopOauthPolling();
  accountForm.state = '';
  accountForm.started = false;
  accountForm.deadlineMs = 0;
  hideOauthAbortButton();
  restoreOauthStartButton('授权登录');
  setOauthStatus('已取消等待授权', 'idle');
}

/**
 * 复制授权链接（弹窗被拦截时的兜底路径）。
 */
async function copyOauthUri() {
  const input = $('#acc-oauth-url');
  const uri = (input && input.value) || accountForm.uri;
  if (!uri) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(uri);
      toast('授权链接已复制', 'ok');
      return;
    }
    throw new Error('clipboard unavailable');
  } catch {
    if (input) {
      input.focus();
      input.select();
    }
    toast('自动复制不可用，请按 Ctrl/Cmd + C 手动复制', 'warn');
  }
}

/**
 * @param {string} selector
 * @param {string} message
 */
function setFormError(selector, message) {
  const node = $(selector);
  if (!node) return;
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

async function saveAccount() {
  const name = $('#acc-name').value.trim();
  const token = $('#acc-token').value.trim();
  setFormError('#dlg-account-error', '');
  if (!name) {
    setFormError('#dlg-account-error', '请输入账号名称');
    return;
  }
  if (name.length > 32) {
    setFormError('#dlg-account-error', '账号名称不能超过 32 个字符');
    return;
  }
  const body = {
    name,
    uid: $('#acc-uid').value.trim(),
    remark: $('#acc-remark').value.trim(),
    enabled: $('#acc-enabled').checked,
  };
  if (editingAccountId === null) {
    if (!token) {
      setFormError('#dlg-account-error', '请输入 token');
      return;
    }
    body.token = token;
  } else if (token) {
    // 留空 = 不修改：请求体里不带 token 字段
    body.token = token;
  }

  // refresh_token 与 token 同语义：留空 = 不修改（编辑时只想换 access_token 不会被清空）
  const refreshToken = $('#acc-refresh-token').value.trim();
  if (refreshToken) body.refreshToken = refreshToken;

  const isCreate = editingAccountId === null;
  $('#btn-acc-save').disabled = true;
  try {
    if (isCreate) {
      await api('/api/accounts', { method: 'POST', body });
    } else {
      await api(`/api/accounts/${encodeURIComponent(editingAccountId)}`, { method: 'PUT', body });
    }
    $('#dlg-account').close();
    toast(isCreate ? '账号已添加' : '账号已更新', 'ok');
    await refreshAccounts();
    if (!isCreate && editingAccountId) {
      // token / uid 可能变化，强制重查该账号额度
      await loadCredits(editingAccountId, { silent: true });
    }
  } catch (err) {
    setFormError('#dlg-account-error', `${err.code || 'INTERNAL'}: ${err.message || '保存失败'}`);
  } finally {
    $('#btn-acc-save').disabled = false;
  }
}

/**
 * @param {object} account
 */
function askDeleteAccount(account) {
  askConfirm(
    {
      title: '删除账号',
      text: `确定删除「${account.name}」吗？该操作不可撤销（不会删除历史日志）。`,
      okLabel: '删除',
    },
    async () => {
      try {
        await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
        toast('账号已删除', 'ok');
        delete state.credits[account.id];
        delete state.expanded[account.id];
        await refreshAccounts();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '删除失败');
      }
    },
  );
}

/**
 * 上传前裁掉 cockpit-tools 的大字段（quota_raw/usage_raw 等），只保留导入所需字段。
 * 既减少请求体积，也避免把整份账号快照送到服务端。
 *
 * 注意 refresh_token 必须保留：它被裁掉等于「token 一失效就只能手动重导」。
 * cockpit-tools 导出用驼峰 refreshToken，这里统一落成 refresh_token 再上传。
 * @param {*} payload
 * @returns {*}
 */
function compactImportPayload(payload) {
  const pick = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const picked = {
      access_token: item.access_token ?? item.accessToken ?? item.token,
      uid: item.uid,
      nickname: item.nickname,
      email: item.email,
    };
    const refresh = item.refresh_token ?? item.refreshToken;
    if (typeof refresh === 'string' && refresh) picked.refresh_token = refresh;
    if (typeof item.domain === 'string' && item.domain) picked.domain = item.domain;
    return picked;
  };
  if (Array.isArray(payload)) return payload.map(pick);
  if (payload && Array.isArray(payload.accounts)) return { accounts: payload.accounts.map(pick) };
  if (payload && Array.isArray(payload.items)) return { items: payload.items.map(pick) };
  return pick(payload);
}

/** 导入体积上限：与后端 route 的 bodyLimit（5MB）对齐，避免后端 413 被前端误报成「不是合法 JSON」。 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 选择并导入 cockpit-tools 兼容的账号 JSON。
 * @param {Event} event
 */
async function onImportFile(event) {
  const input = event.target;
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  if (file.size > IMPORT_MAX_BYTES) {
    toast('文件过大（上限 5MB）', 'bad');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('不是合法的 JSON 文件', 'bad');
    return;
  }

  state.busy.import = true;
  renderAccounts();
  syncBusy();
  try {
    const data = await api('/api/accounts/import', { method: 'POST', body: compactImportPayload(payload) });
    const parts = [];
    if (Number(data.imported) > 0) parts.push(`新增 ${data.imported}`);
    if (Number(data.updated) > 0) parts.push(`更新 ${data.updated}`);
    if (Number(data.unchanged) > 0) parts.push(`未变化 ${data.unchanged}`);
    if (Number(data.skipped) > 0) parts.push(`跳过 ${data.skipped}`);
    const changed = Number(data.imported) > 0 || Number(data.updated) > 0;
    toast(parts.length ? `导入完成：${parts.join('，')}` : '没有可导入的账号', changed ? 'ok' : 'warn');
    if (Array.isArray(data.reasons) && data.reasons.length > 0) {
      setError('BAD_REQUEST', data.reasons.join('；'));
    }
    await refreshAccounts();
    // 没有 refresh_token 的账号迟早掉线，导入完就提醒，别等到签到失败才发现
    const noRefresh = state.accounts.filter((account) => account.hasRefreshToken !== true);
    if (noRefresh.length > 0) {
      setError('BAD_REQUEST', `${noRefresh.length} 个账号未包含 refresh_token：access_token 会过期或被上游轮换，失效后需手动重新导入`);
    }
    void loadAllCredits({ silent: true });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '导入失败');
      toast(`导入失败：${err.message || '未知错误'}`, 'bad');
    }
  } finally {
    state.busy.import = false;
    renderAccounts();
    syncBusy();
  }
}

/**
 * 某账号是否正在导出（按账号粒度，互不阻塞）。
 * @param {string} accountId
 * @returns {boolean}
 */
function isExporting(accountId) {
  return state.busy.export.ids.has(String(accountId || ''));
}

/**
 * 单账号导出前确认（文件含明文 token，弹窗文案必须带上账号名，
 * 让用户清楚知道导出的是哪个账号）。
 * @param {object} account
 */
function askExportAccount(account) {
  if (!account || !account.id || isExporting(account.id)) return;
  const name = account.name || account.id;
  askConfirm(
    {
      title: '导出账号 JSON',
      text: `将导出「${name}」的账号 JSON，文件包含 token 明文，可用于在 cockpit-tools 中恢复该账号。请妥善保管，不要上传到公开位置。`,
      okLabel: '导出',
    },
    () => doExportAccount(account),
  );
}

/**
 * 导出单个账号：GET /api/accounts/export?id=
 * 失败（账号已被删除等）必须 toast，不能静默。
 * @param {object} account
 */
async function doExportAccount(account) {
  const id = account && account.id ? String(account.id) : '';
  if (!id || isExporting(id)) return;
  state.busy.export.ids.add(id);
  renderAccounts();
  try {
    const data = await api(`/api/accounts/export?id=${encodeURIComponent(id)}`);
    const list = Array.isArray(data) ? data : [];
    if (list.length === 0) {
      // 后端保证命中账号时返回长度 1 的数组；为空说明该账号没有可导出的 token
      const message = `账号「${account.name || id}」没有可导出的 token`;
      setError('BAD_REQUEST', message);
      toast(`导出失败：${message}`, 'bad');
      return;
    }
    const part = sanitizeFilenamePart(account.name, id);
    downloadJson(`workbuddy_account_${part}_${fmtDateStamp()}.json`, list);
    toast(`已导出「${account.name || id}」，注意文件含明文 token`, 'warn');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '导出失败');
      toast(`导出失败：${err.message || '未知错误'}`, 'bad');
    }
  } finally {
    state.busy.export.ids.delete(id);
    renderAccounts();
  }
}

/** 导出全部账号前确认（文件含明文 token）。 */
function askExportAccounts() {
  if (state.busy.export.all) return;
  askConfirm(
    {
      title: '导出全部账号 JSON',
      text: '将导出全部账号的 JSON，文件包含 token 明文，可用于在 cockpit-tools 中批量恢复。请妥善保管，不要上传到公开位置。',
      okLabel: '导出全部',
    },
    doExportAccounts,
  );
}

async function doExportAccounts() {
  if (state.busy.export.all) return;
  state.busy.export.all = true;
  syncBusy();
  try {
    const data = await api('/api/accounts/export');
    downloadJson(`workbuddy_accounts_${fmtDateStamp()}.json`, data);
    toast('已导出全部账号，注意文件含明文 token', 'warn');
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      setError(err.code || 'INTERNAL', err.message || '导出失败');
      toast(`导出失败：${err.message || '未知错误'}`, 'bad');
    }
  } finally {
    state.busy.export.all = false;
    syncBusy();
  }
}

/**
 * 展开/收起日志并懒加载明细。
 * @param {string} runId
 */
async function toggleRun(runId) {
  state.opened[runId] = !state.opened[runId];
  renderLogs();
  if (!state.opened[runId]) return;
  if (state.details[runId]) return;
  try {
    const detail = await api(`/api/logs/${encodeURIComponent(runId)}`);
    state.details[runId] = detail && typeof detail === 'object' ? detail : { error: '明细格式异常' };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    state.details[runId] = { error: `${err.code || 'INTERNAL'}: ${err.message || '加载失败'}` };
  }
  renderLogs();
}

function askClearLogs() {
  askConfirm(
    {
      title: '清空日志',
      text: '将删除全部执行记录（含明细），此操作不可撤销。账号与设置不受影响。',
      okLabel: '清空',
    },
    async () => {
      try {
        const data = await api('/api/logs', { method: 'DELETE' });
        state.logs = [];
        state.details = {};
        state.opened = {};
        toast(`已清空 ${data && Number.isFinite(data.deleted) ? data.deleted : 0} 条记录`, 'ok');
        await refreshLogs();
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '清空失败');
      }
    },
  );
}

async function saveRetention() {
  const raw = Number($('#retention-input').value);
  const hint = $('#retention-hint');
  if (hint) hint.hidden = true;
  if (!Number.isInteger(raw) || raw < 5 || raw > 100) {
    setError('BAD_REQUEST', '日志保留条数需为 5~100 的整数');
    return;
  }
  state.busy.retention = true;
  syncBusy();
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: { retentionRuns: raw } });
    renderSettings();
    if (hint) hint.hidden = false;
    const evicted = Number(state.settings && state.settings.evicted) || 0;
    toast(evicted > 0 ? `设置已保存，同时清理了 ${evicted} 条旧记录` : '设置已保存', 'ok');
    if (evicted > 0) await refreshLogs();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '保存失败');
  } finally {
    state.busy.retention = false;
    syncBusy();
  }
}


/**
 * 生成/重置 MCP Key。
 * @param {boolean} rotate 是否需要二次确认（重置）
 */
function requestMcpKey(rotate) {
  const run = async () => {
    state.busy.key = true;
    syncBusy();
    try {
      const data = await api('/api/mcp-key', { method: 'POST', body: {} });
      state.mcpKey = { exists: true, prefix: data.prefix };
      renderSettings();
      showMcpKey(data.key);
      toast('Key 已生成，请立即复制', 'ok');
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) setError(err.code || 'INTERNAL', err.message || '生成失败');
    } finally {
      state.busy.key = false;
      syncBusy();
    }
  };
  if (!rotate) {
    run();
    return;
  }
  askConfirm(
    {
      title: '重置 MCP Key',
      text: '重置后旧的 Key 立即失效，所有已配置的 AI 客户端都需要更新。',
      okLabel: '重置',
    },
    run,
  );
}

/**
 * 展示 MCP Key 明文（只显示一次）。
 * @param {string} key
 */
function showMcpKey(key) {
  const input = $('#mcp-key-input');
  input.value = key;
  $('#dlg-mcp').showModal();
  input.focus();
  input.select();
}

async function copyMcpKey() {
  const input = $('#mcp-key-input');
  const key = input.value;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(key);
      toast('已复制到剪贴板', 'ok');
      return;
    }
    throw new Error('clipboard unavailable');
  } catch {
    input.focus();
    input.select();
    toast('自动复制不可用，请按 Ctrl/Cmd + C 手动复制', 'warn');
  }
}

async function changePassword() {
  const oldPassword = $('#pw-old').value;
  const newPassword = $('#pw-new').value;
  const confirm = $('#pw-confirm').value;
  // 与后端同口径：一律按 trim 后比较（旧密码也 trim，避免「带空格设的密码」永远改不了）
  const oldValue = oldPassword.trim();
  const newValue = newPassword.trim();
  const confirmValue = confirm.trim();
  setFormError('#pw-error', '');
  if (!oldValue) {
    setFormError('#pw-error', '请输入当前密码');
    return;
  }
  if (newValue.length < 8) {
    setFormError('#pw-error', '新密码至少 8 位');
    return;
  }
  if (newValue !== confirmValue) {
    setFormError('#pw-error', '两次输入的新密码不一致');
    return;
  }
  state.busy.pw = true;
  syncBusy();
  try {
    await api('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
    $('#pw-old').value = '';
    $('#pw-new').value = '';
    $('#pw-confirm').value = '';
    stopPolling();
    state.me = null;
    showView('login');
    toast('密码已更新，请重新登录', 'ok');
  } catch (err) {
    setFormError('#pw-error', err.message || '修改失败');
  } finally {
    state.busy.pw = false;
    syncBusy();
  }
}

let confirmHandler = null;

/**
 * 通用二次确认。
 * @param {{title:string, text:string, okLabel?:string}} options
 * @param {Function} onConfirm
 */
function askConfirm(options, onConfirm) {
  $('#confirm-title').textContent = options.title;
  $('#confirm-text').textContent = options.text;
  $('#btn-confirm-ok').textContent = options.okLabel || '确认';
  confirmHandler = onConfirm;
  $('#dlg-confirm').showModal();
}

// ============ 事件绑定 ============

function bindEvents() {
  $('#btn-setup').addEventListener('click', submitSetup);
  $('#btn-login').addEventListener('click', submitLogin);
  $('#btn-retry').addEventListener('click', () => {
    $('#btn-retry').hidden = true;
    boot();
  });
  $('#form-setup').addEventListener('submit', (event) => {
    event.preventDefault();
    submitSetup();
  });
  $('#form-login').addEventListener('submit', (event) => {
    event.preventDefault();
    submitLogin();
  });

  $('#btn-logout').addEventListener('click', doLogout);
  $('#btn-run-all').addEventListener('click', runAll);
  $('#btn-add-account').addEventListener('click', () => openAccountDialog(null));
  $('#btn-import-accounts').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', onImportFile);
  $('#btn-export-accounts').addEventListener('click', askExportAccounts);
  $('#btn-clear-logs').addEventListener('click', askClearLogs);
  $('#btn-save-retention').addEventListener('click', saveRetention);
  $('#btn-gen-mcp').addEventListener('click', () => requestMcpKey(Boolean(state.mcpKey && state.mcpKey.exists)));
  $('#btn-change-pw').addEventListener('click', changePassword);
  $('#btn-copy-key').addEventListener('click', copyMcpKey);
  $('#btn-panel-error-close').addEventListener('click', clearError);
  $('#btn-theme').addEventListener('click', toggleTheme);

  // 栏目导航（侧栏 / 底部 Tab Bar 共用同一批 [data-page-link]）
  for (const link of $$('[data-page-link]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      setPage(link.dataset.pageLink);
    });
  }
  window.addEventListener('hashchange', () => setPage(window.location.hash.slice(1)));

  // 账号双视图切换
  for (const btn of $$('[data-view-btn]')) {
    btn.addEventListener('click', () => setAccView(btn.dataset.viewBtn));
  }

  $('#filter-all').addEventListener('click', () => setFilter(false));
  $('#filter-failed').addEventListener('click', () => setFilter(true));
  $('#log-search').addEventListener('input', (event) => {
    state.filters.q = event.target.value;
    renderLogs();
  });

  $('#btn-acc-save').addEventListener('click', saveAccount);
  $('#btn-acc-cancel').addEventListener('click', () => $('#dlg-account').close());

  // 账号录入方式切换（按钮原生支持 Enter/Space，方向键额外补充 tablist 习惯）
  for (const btn of $$('[data-acc-mode]')) {
    btn.addEventListener('click', () => setAccountMode(btn.dataset.accMode));
    btn.addEventListener('keydown', onAccountModeKeydown);
  }
  $('#btn-acc-oauth-start').addEventListener('click', startOauthLogin);
  $('#btn-acc-oauth-abort').addEventListener('click', abortOauthWait);
  $('#btn-acc-oauth-copy').addEventListener('click', copyOauthUri);

  // 弹窗关闭（Esc / 取消 / 点遮罩 / 授权成功）都停掉轮询并复位，避免后台空转
  $('#dlg-account').addEventListener('close', () => {
    stopOauthPolling();
    resetOauthFlow();
  });
  // 点遮罩关闭：<dialog> 原生不响应遮罩点击，这里按「点击目标是 dialog 自身」判定
  $('#dlg-account').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  $('#btn-confirm-ok').addEventListener('click', async () => {
    const handler = confirmHandler;
    confirmHandler = null;
    $('#dlg-confirm').close();
    if (typeof handler === 'function') await handler();
  });
  $('#btn-confirm-cancel').addEventListener('click', () => {
    confirmHandler = null;
    $('#dlg-confirm').close();
  });
  $('#btn-mcp-close').addEventListener('click', () => {
    $('#mcp-key-input').value = '';
    $('#dlg-mcp').close();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view === 'panel') refreshQuiet();
  });
}

/**
 * @param {boolean} onlyFailed
 */
function setFilter(onlyFailed) {
  state.filters.onlyFailed = onlyFailed;
  const all = $('#filter-all');
  const failed = $('#filter-failed');
  if (all) {
    all.classList.toggle('is-on', !onlyFailed);
    all.setAttribute('aria-pressed', onlyFailed ? 'false' : 'true');
  }
  if (failed) {
    failed.classList.toggle('is-on', onlyFailed);
    failed.setAttribute('aria-pressed', onlyFailed ? 'true' : 'false');
  }
  renderLogs();
}

// ============ 启动（顺序不可变） ============

initTheme();
bindEvents();
renderAll();
setPage(window.location.hash.slice(1) || store.get('wb:page') || 'accounts');
setAccView(store.get('wb:acc-view') === 'cards' ? 'cards' : 'list');
boot();
