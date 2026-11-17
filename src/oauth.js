// src/oauth.js
// WorkBuddy OAuth 授权登录（**服务端代理**）：给面板提供「不导出 JSON 也能加账号」的录入方式。
//
// 参考实现：cockpit-tools 的 WorkBuddy 登录（src-tauri/src/modules/workbuddy_oauth.rs）。
// 与客户端版本最大的区别：浏览器不能直接打 copilot.tencent.com（跨域，且 token 不能落到页面），
// 所以三次上游请求全部由 Worker 代理，前端只拿到 verificationUri 与「脱敏后的账号」。
//
// 上游协议（基址 https://copilot.tencent.com，前缀 /v2/plugin）：
//   1) POST /v2/plugin/auth/state?platform=workbuddy   body {}
//        -> { code, data: { state, authUrl } }          authUrl 也可能是 auth_url / url，可能为空
//   2) GET  /v2/plugin/auth/token?state=<state>
//        -> { code 0|200, data: { accessToken, refreshToken, expiresAt, domain, tokenType } }
//        未完成登录时通常 code=0 但 data 里没有 accessToken（也可能直接给非 2xx）
//   3) GET  /v2/plugin/login/account?state=<state>   Authorization: Bearer <accessToken>
//        -> { code, data: { uid, nickname, email, enterpriseId, enterpriseName } }
//   请求 1)/2) 必须带浏览器 UA + X-No-Authorization / X-No-User-Id / X-No-Enterprise-Id /
//   X-No-Department-Info: true；**缺 UA 会被网关 403 或 code=10085**（实测，与 cockpit-tools 一致）。
//
// 安全约定（本文件是唯一接触上游 OAuth 接口的地方）：
//   - 任何返回值、日志都不得出现明文 token 或完整 state（日志最多打 state 前 6 位）；
//   - authUrl 只允许 copilot.tencent.com / *.tencent.com，其余一律回退官方兜底地址（防开放重定向）；
//   - 上游非 JSON 响应一律按 UPSTREAM_ERROR 处理，绝不把上游 HTML 透给前端。
//   - 「还在等登录」用返回值表达（status: 'pending'），不用异常：异常只表示真的出错了。
//
// 约束：只经 ctx.fetch / ctx.now / ctx.kv 访问外部资源（禁止裸 env / 全局 fetch / Date.now()）。

import { AppError, isoNow, newAccountId, sanitizeToken, truncate } from './util.js';
import { MAX_ACCOUNTS } from './store.js';
import { pickNextCheckinHour } from './schedule.js';
import { maskAccount } from './account-view.js';

/** 默认上游基址（与签到 / 额度 / 续期同域）。 */
const DEFAULT_BASE = 'https://copilot.tencent.com';

/** 三个上游端点路径。 */
const AUTH_STATE_PATH = '/v2/plugin/auth/state';
const AUTH_TOKEN_PATH = '/v2/plugin/auth/token';
const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account';

/**
 * 浏览器 UA：**逐字对齐 cockpit-tools**（macOS Chrome 131）。
 * 不要换成 upstream-headers.js 里的 Windows UA —— 那是计费接口的基线；
 * 这个值是与 OAuth 实现一起被验证过的，缺失/被改写会被网关 403 / code=10085。
 */
const OAUTH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 与官方 Web 客户端一致的 Accept。 */
const ACCEPT = 'application/json, text/plain, */*';

/** 单次上游请求超时（毫秒）。轮询本身 2 秒一次，超时不能比它长太多。 */
const TIMEOUT_MS = 15000;

/** 授权会话建议有效期（秒）与建议轮询间隔（秒），仅用于前端调度。 */
const LOGIN_TTL_SEC = 600;
const POLL_INTERVAL_SEC = 2;

/** state 形如上游生成的随机串；限定字符集既防注入也防用它拼 URL 时出岔子。 */
const STATE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** 上游「state 失效」的 HTTP 状态（state 不存在 / 已过期 / 已使用）。 */
const STATE_EXPIRED_HTTP = new Set([400, 401, 404, 409, 410]);

/** 上游「state 失效」的业务码（12153 = token/state 格式错误或已失效，线上实测）。 */
const STATE_EXPIRED_CODE = 12153;

/**
 * 上游「登录进行中」的业务码（11217 = login ing...，线上实测）。
 *
 * 注意：它不是错误。用户还没在授权页点完登录时，上游会回 **HTTP 200 + code=11217**，
 * 把非 0 码一律当失败会让前端在第一次轮询就报 502、停在「等待登录」之前。
 */
const LOGIN_PENDING_CODE = 11217;

/** 授权地址白名单：只认 copilot.tencent.com 与 *.tencent.com。 */
const ALLOWED_AUTH_HOST = 'copilot.tencent.com';
const ALLOWED_AUTH_HOST_SUFFIX = '.tencent.com';

/** 授权链接兜底（上游没给 authUrl 时用官方登录页 + state）。 */
const FALLBACK_AUTH_URL = 'https://copilot.tencent.com/login?state=';

/** 账号字段约束（与 api.js 的 svcCreateAccount 同口径）。 */
const NAME_MAX_LENGTH = 32;
const UID_MAX_LENGTH = 64;

/** OAuth 新建账号的默认备注：一眼区分「授权导入」与「手工粘贴」。 */
const OAUTH_REMARK = 'OAuth 授权';

/** 日志里保留的 state 前缀长度（完整 state 是凭据，不入日志）。 */
const STATE_LOG_CHARS = 6;

/** 上游响应片段截断长度（错误信息里引用）。 */
const SNIPPET_MAX_CHARS = 120;

/**
 * 结构化日志（单行 JSON，与 api.js / store.js 同格式）。
 * @param {'info'|'warn'|'error'} level
 * @param {string} event
 * @param {object} [fields]
 */
function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * 取字符串字段并 trim（非字符串 -> 空串）。
 * @param {*} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 取对象字段（数组 / 基本类型 -> null）。
 * @param {*} value
 * @returns {object|null}
 */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * 取有限数值（数字或纯数字字符串），否则 null。
 * @param {*} value
 * @returns {number|null}
 */
function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * state 的日志前缀（只打前 6 位）。
 * @param {*} state
 * @returns {string}
 */
function statePrefixOf(state) {
  return typeof state === 'string' ? state.slice(0, STATE_LOG_CHARS) : '';
}

/**
 * 上游响应片段：去换行、压空白、截断；顺带剔除可能回显的 token/state。
 * @param {*} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
function bodySnippet(text, secrets = []) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  let snippet = truncate(text.replace(/\s+/g, ' ').trim(), SNIPPET_MAX_CHARS);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) snippet = snippet.split(secret).join('***');
  }
  return snippet;
}

/**
 * 上游原始过期时刻归一：>1e12 视为毫秒，否则按秒 ×1000；只有有限正数才返回。
 * **只用于上游响应里的原始值**（由 resolveExpiresAt 调用）：
 * 内部已经是毫秒的值不要再过一遍本函数，否则会被二次放大。
 * @param {*} value 上游 expiresAt（秒或毫秒）
 * @returns {number|null}
 */
function normalizeExpiresAtMs(value) {
  const raw = asNumber(value);
  if (raw === null || raw <= 0) return null;
  return raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000);
}

/**
 * OAuth 基址：默认官方地址。
 * 仅用于本地联调（`wrangler dev --var OAUTH_BASE_URL:http://127.0.0.1:8790`），
 * 生产不在 wrangler.toml 里设置，永远走官方地址（与 CREDITS_BASE_URL 同一策略）。
 * @param {object} ctx
 * @returns {string}
 */
function oauthBaseUrl(ctx) {
  const raw = ctx && ctx.env && typeof ctx.env.OAUTH_BASE_URL === 'string' ? ctx.env.OAUTH_BASE_URL : '';
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : DEFAULT_BASE;
}

/**
 * 申请登录会话 / 轮询 token 用的「匿名客户端」请求头。
 * 四个 X-No-* 与 UA 缺一不可：上游据此判定这是一个尚未登录的官方客户端。
 * 头名统一小写（与 upstream-headers.js 同风格；HTTP 头本身大小写不敏感）。
 * @param {{json?:boolean}} [options] json=true 时补 Content-Type（仅带 body 的 POST 需要）
 * @returns {Record<string,string>}
 */
function anonymousHeaders(options = {}) {
  const headers = {
    accept: ACCEPT,
    'user-agent': OAUTH_USER_AGENT,
    'x-no-authorization': 'true',
    'x-no-user-id': 'true',
    'x-no-enterprise-id': 'true',
    'x-no-department-info': 'true',
  };
  // GET 没有 body 就不带 Content-Type（带一个空体声明的 content-type 反而更像异常客户端）
  if (options.json === true) headers['content-type'] = 'application/json';
  return headers;
}

/**
 * 拉账号资料用的请求头：换成真实的 Bearer，其余 X-No-* 保留（上游要求）。
 * @param {{accessToken:string, domain?:string}} tokens
 * @returns {Record<string,string>}
 */
function accountHeaders(tokens) {
  const headers = {
    accept: ACCEPT,
    'user-agent': OAUTH_USER_AGENT,
    authorization: `Bearer ${tokens && typeof tokens.accessToken === 'string' ? tokens.accessToken : ''}`,
    'x-no-user-id': 'true',
    'x-no-enterprise-id': 'true',
    'x-no-department-info': 'true',
  };
  const domain = asString(tokens && tokens.domain);
  if (domain) headers['x-domain'] = domain;
  return headers;
}

/**
 * 发一次上游请求并尽力解析 JSON。
 * 只对「网络 / 超时」抛 UPSTREAM_ERROR —— HTTP 状态与业务 code 交给调用方按语义分派
 * （轮询要用 4xx 表达「state 已失效」，不能一律当异常）。
 * 超时统一用 AbortSignal.timeout(TIMEOUT_MS)（Workers 与 Node 20 都支持）。
 * @param {object} ctx
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string}} init
 * @param {{event:string, state?:string}} meta 日志用；state 只打前缀
 * @returns {Promise<{status:number, ok:boolean, json:object|null, text:string}>}
 * @throws {AppError} UPSTREAM_ERROR 网络错误 / 超时
 */
async function requestUpstream(ctx, url, init, meta) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
  let response;
  let text;
  try {
    response = await ctx.fetch(url, { ...init, signal });
    text = await response.text();
  } catch (err) {
    const kind = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network';
    logEvent('warn', `${meta.event}_transport_failed`, {
      kind,
      statePrefix: statePrefixOf(meta.state),
      message: truncate(String((err && err.message) || err), SNIPPET_MAX_CHARS),
    });
    throw new AppError(
      'UPSTREAM_ERROR',
      kind === 'timeout'
        ? 'OAuth 授权请求上游超时，请重试'
        : 'OAuth 授权请求上游失败（网络错误），请稍后重试',
      { kind },
    );
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: Number.isFinite(response.status) ? response.status : 0,
    ok: response.ok === true,
    json: asRecord(json),
    text: typeof text === 'string' ? text : '',
  };
}

/**
 * 校验上游返回的授权地址，防开放重定向。
 * 解析失败 / 非 https / host 不在白名单 —— 一律回退官方兜底地址。
 * @param {string} raw 上游 authUrl（可能为空）
 * @param {string} state
 * @returns {string}
 */
export function safeVerificationUri(raw, state) {
  const encodedState = encodeURIComponent(typeof state === 'string' ? state : '');
  const fallback = `${FALLBACK_AUTH_URL}${encodedState}`;
  const candidate = asString(raw);
  if (!candidate) return fallback;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fallback;
  }
  if (parsed.protocol !== 'https:') return fallback;
  const host = parsed.hostname.toLowerCase();
  const allowed = host === ALLOWED_AUTH_HOST || host.endsWith(ALLOWED_AUTH_HOST_SUFFIX);
  if (!allowed) return fallback;
  return parsed.href;
}

/**
 * 从上游 token 响应里取过期时刻（毫秒）。
 * 优先用绝对时间 expiresAt（秒/毫秒都容忍），否则用 expiresIn（秒）按 ctx.now() 推算。
 * @param {object|null} data
 * @param {number} nowMs
 * @returns {number|null}
 */
function resolveExpiresAt(data, nowMs) {
  const record = asRecord(data) || {};
  const absolute = normalizeExpiresAtMs(record.expiresAt ?? record.expires_at);
  if (absolute !== null) return absolute;
  const expiresIn = asNumber(record.expiresIn ?? record.expires_in);
  if (expiresIn !== null && expiresIn > 0) return nowMs + Math.trunc(expiresIn * 1000);
  return null;
}

/**
 * 申请 OAuth 授权会话（上游第 1 步）。
 * @param {object} ctx
 * @returns {Promise<{state:string, verificationUri:string, expiresIn:number, intervalSeconds:number}>}
 * @throws {AppError} UPSTREAM_ERROR 上游失败 / 响应异常 / 未返回 state
 */
export async function startWorkbuddyLogin(ctx) {
  const url = `${oauthBaseUrl(ctx)}${AUTH_STATE_PATH}?platform=workbuddy`;
  const result = await requestUpstream(ctx, url, {
    method: 'POST',
    headers: anonymousHeaders({ json: true }),
    body: '{}',
  }, { event: 'oauth_start' });

  if (!result.ok) {
    const snippet = bodySnippet(result.text);
    logEvent('warn', 'oauth_start_http_error', {
      status: result.status,
      snippet,
    });
    throw new AppError(
      'UPSTREAM_ERROR',
      snippet ? `OAuth 授权申请失败（HTTP ${result.status}）：${snippet}` : `OAuth 授权申请失败（HTTP ${result.status}）`,
      { status: result.status },
    );
  }
  if (!result.json) {
    logEvent('warn', 'oauth_start_bad_json', { status: result.status, snippet: bodySnippet(result.text) });
    throw new AppError('UPSTREAM_ERROR', 'OAuth 授权申请失败：上游响应不是 JSON');
  }

  const code = asNumber(result.json.code);
  if (code !== null && code !== 0 && code !== 200) {
    const snippet = bodySnippet(result.text);
    logEvent('warn', 'oauth_start_api_error', { code, status: result.status, snippet });
    throw new AppError(
      'UPSTREAM_ERROR',
      snippet ? `OAuth 授权申请失败（code=${code}）：${snippet}` : `OAuth 授权申请失败（code=${code}）`,
      { status: result.status, code },
    );
  }

  const data = asRecord(result.json.data) || {};
  const state = asString(data.state);
  if (!state) {
    logEvent('warn', 'oauth_start_no_state', { status: result.status });
    throw new AppError('UPSTREAM_ERROR', 'OAuth 授权申请失败：上游未返回 state');
  }
  const rawAuthUrl = asString(data.authUrl ?? data.auth_url ?? data.url);
  const verificationUri = safeVerificationUri(rawAuthUrl, state);
  logEvent('info', 'oauth_start_ok', {
    statePrefix: statePrefixOf(state),
    // authUrl 被白名单拒绝时记录一次，便于排查「为什么打开的是兜底地址」
    authUrlRewritten: Boolean(rawAuthUrl) && verificationUri !== rawAuthUrl,
    hasAuthUrl: Boolean(rawAuthUrl),
  });

  return {
    state,
    verificationUri,
    expiresIn: LOGIN_TTL_SEC,
    intervalSeconds: POLL_INTERVAL_SEC,
  };
}

/**
 * 拉账号资料（上游第 3 步）。**失败只告警、不阻断导入**：
 * access_token 已经拿到，名称缺省可以后续在面板里改。
 * @param {object} ctx
 * @param {{accessToken:string, domain:string}} tokens
 * @param {string} state
 * @returns {Promise<{uid:string, nickname:string, email:string, enterpriseId:string, enterpriseName:string}>}
 */
async function fetchAccountProfile(ctx, tokens, state) {
  const empty = { uid: '', nickname: '', email: '', enterpriseId: '', enterpriseName: '' };
  const url = `${oauthBaseUrl(ctx)}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`;
  try {
    const result = await requestUpstream(ctx, url, {
      method: 'GET',
      headers: accountHeaders(tokens),
    }, { event: 'oauth_profile', state });
    const data = asRecord(result.json && result.json.data);
    if (!result.ok || !data) {
      logEvent('warn', 'oauth_profile_unusable', {
        status: result.status,
        statePrefix: statePrefixOf(state),
        snippet: bodySnippet(result.text, [tokens.accessToken]),
      });
      return empty;
    }
    return {
      uid: asString(data.uid).slice(0, UID_MAX_LENGTH),
      nickname: asString(data.nickname),
      email: asString(data.email),
      enterpriseId: asString(data.enterpriseId ?? data.enterprise_id).slice(0, UID_MAX_LENGTH),
      enterpriseName: asString(data.enterpriseName ?? data.enterprise_name),
    };
  } catch (err) {
    // 资料接口失败不影响导入：这里只记一条 warn（requestUpstream 已记过 transport 失败）
    logEvent('warn', 'oauth_profile_failed', {
      statePrefix: statePrefixOf(state),
      message: truncate(String((err && err.message) || err), SNIPPET_MAX_CHARS),
    });
    return empty;
  }
}

/**
 * 账号落库（OAuth 专用，独立成函数便于单测）。
 *
 * 规则（与账号手工录入保持一致的字段口径）：
 *   - 匹配已有账号：**uid 优先，access_token 兜底**
 *     （profile 接口失败时 uid 为空，「不阻断导入」的代价就是只能靠 token 认人；
 *     少了这层兜底，同一个 token 连轮询两次会建出两条账号）；
 *   - 命中 → 只更新 token / refreshToken / domain / enterpriseId / expiresAt / updatedAt，
 *     其中 refreshToken / domain / enterpriseId 是「新值存在才覆盖」，uid 只在原值为空时回填
 *     （已有 uid 不覆盖，避免上游换绑时改错人），name / remark / enabled / checkinHour 一律保留；
 *   - 未匹配 → 新建：name = nickname || email || `WorkBuddy 账号 N`（截断到 32 字），
 *     remark = 'OAuth 授权'，enabled = true，checkinHour 自动挑空位；
 *   - 达到 MAX_ACCOUNTS 且**需要新建**时才 CONFLICT（命中更新不受上限影响）。
 *
 * enterpriseId 必须落库：upstream-headers.js 会用 `account.enterpriseId` 生成
 * `x-enterprise-id` / `x-tenant-id`，账号 JSON 导入导出也带这个字段；
 * 企业账号缺它会丢业务头（上游按个人上下文处理）。maskAccount 不暴露该字段，无泄漏风险。
 * @param {object} ctx
 * @param {object} payload
 *   {token, refreshToken?, uid?, domain?, enterpriseId?, expiresAt?, nickname?, email?}
 *   expiresAt 为**已归一化的毫秒时间戳**（秒→毫秒的换算在上游响应解析时一次做完）
 * @returns {Promise<object>} 脱敏后的账号（**不含明文 token**）
 * @throws {AppError} UPSTREAM_ERROR 缺 access_token | CONFLICT 账号数量超限
 */
export async function saveOAuthAccount(ctx, payload) {
  const src = asRecord(payload) || {};
  const token = sanitizeToken(src.token);
  if (!token) throw new AppError('UPSTREAM_ERROR', 'OAuth 授权失败：上游未返回 access_token');

  const refreshToken = sanitizeToken(src.refreshToken);
  const uid = asString(src.uid).slice(0, UID_MAX_LENGTH);
  const domain = asString(src.domain).slice(0, UID_MAX_LENGTH);
  const enterpriseId = asString(src.enterpriseId).slice(0, UID_MAX_LENGTH);
  // expiresAt 入参已是毫秒：这里只做「有限正数」兜底，绝不再按秒二次放大
  // （否则测试用极小 now + 上游只给 expiresIn 时会被多乘一次 1000）
  const rawExpiresAt = asNumber(src.expiresAt);
  const expiresAt = rawExpiresAt !== null && rawExpiresAt > 0 ? Math.trunc(rawExpiresAt) : null;
  const nowIso = isoNow(ctx.now());
  const accounts = await ctx.kv.getAccounts();
  const list = Array.isArray(accounts) ? accounts : [];

  // 匹配顺序：uid 优先，access_token 兜底。
  // 兜底是必需的：fetchAccountProfile 失败时 uid 为空（「不阻断导入」的设计），
  // 若只按 uid 匹配，同一个 token 连轮询两次就会建出两条账号 —— 白占配额，
  // 而且两条都 enabled 会让 Cron 对同一账号重复签到。
  let index = uid
    ? list.findIndex((account) => account && typeof account.uid === 'string' && account.uid === uid)
    : -1;
  if (index < 0) {
    index = list.findIndex((account) => account && typeof account.token === 'string' && account.token === token);
  }

  if (index >= 0) {
    const next = { ...list[index], token, updatedAt: nowIso };
    // uid 回填：上一次 profile 没取到（uid 为空）时，这次取到了就补上；
    // 已有 uid 时不覆盖 —— 上游若把同一 token 换绑到别的账号，覆盖会改错人。
    if (!next.uid && uid) next.uid = uid;
    // 新值存在才覆盖：上游偶尔不回 refreshToken / domain / enterpriseId，
    // 覆盖成空串会让自动续期彻底失效、并丢掉业务头
    if (refreshToken) next.refreshToken = refreshToken;
    if (domain) next.domain = domain;
    if (enterpriseId) next.enterpriseId = enterpriseId;
    if (expiresAt !== null) {
      next.expiresAt = expiresAt;
    } else {
      // token 换了但拿不到新过期时间：旧值作废，下次按新 JWT exp 重算
      delete next.expiresAt;
    }
    const updated = list.slice();
    updated[index] = next;
    await ctx.kv.putAccounts(updated);
    logEvent('info', 'oauth_account_updated', { accountId: next.id });
    return maskAccount(next);
  }

  if (list.length >= MAX_ACCOUNTS) {
    throw new AppError('CONFLICT', `最多 ${MAX_ACCOUNTS} 个账号`);
  }

  const nickname = asString(src.nickname);
  const email = asString(src.email);
  const fallbackName = `WorkBuddy 账号 ${list.length + 1}`;
  const account = {
    id: newAccountId(),
    name: truncate(nickname || email || fallbackName, NAME_MAX_LENGTH),
    token,
    uid,
    enabled: true,
    remark: OAUTH_REMARK,
    checkinHour: pickNextCheckinHour(list, null),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (refreshToken) account.refreshToken = refreshToken;
  if (domain) account.domain = domain;
  if (enterpriseId) account.enterpriseId = enterpriseId;
  if (expiresAt !== null) account.expiresAt = expiresAt;

  const created = [...list, account];
  await ctx.kv.putAccounts(created);
  logEvent('info', 'oauth_account_created', { accountId: account.id });
  return maskAccount(account);
}

/**
 * 轮询授权结果（上游第 2 步 + 第 3 步）。
 *
 * 三种结果**用返回值表达**，不用异常：
 *   { status: 'pending' }                   还没在官方页面完成登录（无 accessToken 或 code=11217 login ing）
 *   { status: 'expired' }                   上游明确 state 失效（4xx / code=12153）
 *   { status: 'success', account }          token 已落库，account 为脱敏出参
 * 真出错（网络 / 超时 / 上游异常）才抛 UPSTREAM_ERROR。
 * @param {object} ctx
 * @param {string} state 上游 start 返回的 state
 * @returns {Promise<{status:'pending'}|{status:'expired'}|{status:'success', account:object}>}
 * @throws {AppError} BAD_REQUEST state 非法 | UPSTREAM_ERROR 上游失败
 */
export async function pollWorkbuddyLogin(ctx, state) {
  const normalized = asString(state);
  if (!STATE_PATTERN.test(normalized)) {
    throw new AppError('BAD_REQUEST', 'state 参数非法');
  }
  const url = `${oauthBaseUrl(ctx)}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(normalized)}`;
  const result = await requestUpstream(ctx, url, {
    method: 'GET',
    headers: anonymousHeaders(),
  }, { event: 'oauth_poll', state: normalized });

  if (!result.ok) {
    if (STATE_EXPIRED_HTTP.has(result.status)) {
      logEvent('info', 'oauth_poll_state_expired', {
        status: result.status,
        statePrefix: statePrefixOf(normalized),
      });
      return { status: 'expired' };
    }
    const snippet = bodySnippet(result.text);
    logEvent('warn', 'oauth_poll_http_error', {
      status: result.status,
      statePrefix: statePrefixOf(normalized),
      snippet,
    });
    throw new AppError(
      'UPSTREAM_ERROR',
      snippet ? `OAuth 授权轮询失败（HTTP ${result.status}）：${snippet}` : `OAuth 授权轮询失败（HTTP ${result.status}）`,
      { status: result.status },
    );
  }
  if (!result.json) {
    logEvent('warn', 'oauth_poll_bad_json', {
      status: result.status,
      statePrefix: statePrefixOf(normalized),
      snippet: bodySnippet(result.text),
    });
    throw new AppError('UPSTREAM_ERROR', 'OAuth 授权轮询失败：上游响应不是 JSON');
  }

  const code = asNumber(result.json.code);
  if (code !== null && code !== 0 && code !== 200) {
    if (code === STATE_EXPIRED_CODE) {
      logEvent('info', 'oauth_poll_state_expired', {
        code,
        statePrefix: statePrefixOf(normalized),
      });
      return { status: 'expired' };
    }
    // 登录进行中：不是错误，继续等下一次轮询（前端会显示「等待授权…」）。
    // 线上实测：生成链接后立即 poll 会拿到 { code: 11217, msg: "login ing..." }。
    if (code === LOGIN_PENDING_CODE) {
      logEvent('info', 'oauth_poll_login_pending', {
        code,
        statePrefix: statePrefixOf(normalized),
      });
      return { status: 'pending' };
    }
    const snippet = bodySnippet(result.text);
    logEvent('warn', 'oauth_poll_api_error', {
      code,
      status: result.status,
      statePrefix: statePrefixOf(normalized),
      snippet,
    });
    throw new AppError(
      'UPSTREAM_ERROR',
      snippet ? `OAuth 授权轮询失败（code=${code}）：${snippet}` : `OAuth 授权轮询失败（code=${code}）`,
      { status: result.status, code },
    );
  }

  const data = asRecord(result.json.data) || {};
  const accessToken = sanitizeToken(data.accessToken ?? data.access_token);
  if (!accessToken) {
    // code 正常但没有 accessToken = 用户还没在官方页面点完登录，这是最常见的中间态
    return { status: 'pending' };
  }

  const tokens = {
    accessToken,
    refreshToken: sanitizeToken(data.refreshToken ?? data.refresh_token),
    domain: asString(data.domain).slice(0, UID_MAX_LENGTH),
    expiresAt: resolveExpiresAt(data, ctx.now()),
  };
  const profile = await fetchAccountProfile(ctx, tokens, normalized);
  const account = await saveOAuthAccount(ctx, {
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    uid: profile.uid,
    domain: tokens.domain,
    enterpriseId: profile.enterpriseId,
    expiresAt: tokens.expiresAt,
    nickname: profile.nickname,
    email: profile.email,
  });
  logEvent('info', 'oauth_login_success', {
    statePrefix: statePrefixOf(normalized),
    accountId: account.id,
    hasRefreshToken: account.hasRefreshToken,
  });
  return { status: 'success', account };
}
