// src/upstream-headers.js
// 上游请求头的唯一事实来源：签到 / 额度 / token 续期三条链路共用。
//
// 为什么单独抽出来：
//   之前 checkin.js / credits.js / upstream-token.js 各写一套头，字段和取值互相漂移
//   （有的带 X-User-Id、有的不带，Accept 三处不一样）。上游看到同一账号在不同接口
//   呈现不同客户端特征，本身就是可疑信号；对本项目来说更是纯粹的维护负担。
//
// 取值依据（可核验，不臆造）：
//   - cockpit-tools `workbuddy_oauth.rs` 的 `fetch_dosage_notify` / `get-user-resource`：
//       Accept: application/json, text/plain, */*
//       Accept-Language: zh-CN,zh;q=0.9
//       Content-Type: application/json
//       可选 X-User-Id / X-Enterprise-Id / X-Tenant-Id / X-Domain
//     该实现**不设 User-Agent、不设 Origin/Referer**，照样能跑通所有计费接口，
//     说明上游并不校验这几项；因此本模块保留浏览器基线 UA（已验证可用），
//     额外补齐它明确带了的业务头。
//   - 业务头只在账号上确实有值时才发：发空串头比不发更容易被判定为异常。
//
// 不能补的（Workers 运行时限制，写在这里避免以后重复踩）：
//   - Accept-Encoding：由运行时自动协商并解压，手动设置会被忽略；
//   - Host / Content-Length：由运行时按实际请求重算；
//   - TLS 指纹、HTTP/2 SETTINGS、TCP 栈特征：Workers 侧无法伪造，
//     这几个才是自动化流量最本质的特征，任何请求头都掩盖不了。
//     所以「降低风控风险」的真正抓手是请求频率与节奏，不是堆头字段。
//
// 【实测结论，比上面几条更要紧】Cloudflare 会给所有出站 fetch **强制追加** `cf-worker: <worker 名>`，
// 且无法通过 headers 删除（不是可覆盖的普通头）。本地 workerd 实测抓到的是
// `cf-worker: cf-workers-wbdaily.example.com`，生产是 `<worker>.<子域>.workers.dev`。
// 也就是说：无论 UA / Origin / 业务头伪装得多完整，上游只要看这一个头就知道流量来自 Workers。
// 如果上游真按「来源是否为 Cloudflare Worker」做处置，请求头层面无解——
// 唯一出路是自建中转（README 里的 UPSTREAM_BASE_URL / CREDITS_BASE_URL / REFRESH_BASE_URL）。
// 反过来说，既然这个头一定存在，就没必要为了「藏身份」而堆砌更激进的伪造字段：
// 那只会让「自称 Chrome、TLS 不像、还带 cf-worker」的组合更违和。

/** 浏览器基线 UA（Chrome 131 / Windows）。 */
export const CLIENT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 官方 Origin（Origin/Referer 用）。 */
export const UPSTREAM_ORIGIN = 'https://copilot.tencent.com';

/** 与官方 Web 客户端一致的 Accept。 */
const ACCEPT = 'application/json, text/plain, */*';

/** 与官方 Web 客户端一致的 Accept-Language。 */
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9';

/**
 * 取账号上的字符串字段（去首尾空白，空串视为没有）。
 * @param {object} account
 * @param {string} key
 * @returns {string}
 */
function str(account, key) {
  const value = account && typeof account === 'object' ? account[key] : '';
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 组装上游请求头。
 * 顺序固定，便于对比抓包；值为空的业务头一律不发（不发 ≠ 发空串）。
 * @param {object} account 含 token（必需）、uid / enterpriseId / domain（可选）
 * @param {{contentType?:string|null, extra?:Record<string,string>}} [options]
 *   contentType 传 null 表示不带 body（GET）
 * @returns {Record<string,string>}
 */
export function buildUpstreamHeaders(account, options = {}) {
  const acc = account && typeof account === 'object' ? account : {};
  const headers = {
    accept: ACCEPT,
    'accept-language': ACCEPT_LANGUAGE,
    authorization: `Bearer ${typeof acc.token === 'string' ? acc.token : ''}`,
    'user-agent': CLIENT_USER_AGENT,
    origin: UPSTREAM_ORIGIN,
    referer: `${UPSTREAM_ORIGIN}/`,
  };
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType) headers['content-type'] = contentType;

  // 业务头：有值才发
  const uid = str(acc, 'uid');
  if (uid) headers['x-user-id'] = uid;
  const enterpriseId = str(acc, 'enterpriseId');
  if (enterpriseId) {
    // 与 cockpit-tools 保持一致：企业 ID 同时以 X-Enterprise-Id / X-Tenant-Id 发送
    headers['x-enterprise-id'] = enterpriseId;
    headers['x-tenant-id'] = enterpriseId;
  }
  const domain = str(acc, 'domain');
  if (domain) headers['x-domain'] = domain;

  const extra = options.extra && typeof options.extra === 'object' ? options.extra : null;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string' && value) headers[String(key).toLowerCase()] = value;
    }
  }
  return headers;
}

/**
 * 从请求头里取裸 token（用于错误信息脱敏，绝不外泄）。
 * @param {Record<string,string>|null|undefined} headers
 * @returns {string}
 */
export function bearerOf(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const raw = headers.authorization || headers.Authorization;
  return typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '').trim() : '';
}
