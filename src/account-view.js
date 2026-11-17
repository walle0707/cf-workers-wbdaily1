// src/account-view.js
// 账号出参脱敏的**唯一实现**（api.js 的 svc* 与 oauth.js 的 OAuth 落库共用）。
//
// 为什么单独成文件：OAuth 授权成功后必须立刻把「脱敏后的账号」回给前端，
// 而脱敏逻辑原本写在 api.js 内部；若 oauth.js 反向 import api.js，
// 就会形成 api.js <-> oauth.js 的循环依赖。抽成独立模块后两边都只是单向引用。
//
// 约束：纯函数，不读写 KV、不发请求、不直接取当前时间
//   （时间从 token 的 JWT exp 解出，全部由调用方传入或用 token 自身声明）。

import { isoNow, maskToken } from './util.js';
import { tokenExpiresAtMs } from './upstream-token.js';
import { normalizeCheckinHour } from './schedule.js';

/**
 * 账号出参脱敏：只给 tokenMasked，**绝不**返回 token 字段。
 * 额外给两个「token 生命周期」字段，让面板能直接显示「还有多久过期 / 能不能自动续期」：
 *   - tokenExpiresAt：从 JWT exp 解出的过期时刻（解不出为 null）
 *   - hasRefreshToken：是否保存了 refresh_token（决定过期后能否自动续期）
 * @param {object} account
 * @returns {object}
 */
export function maskAccount(account) {
  const src = account && typeof account === 'object' ? account : {};
  const token = typeof src.token === 'string' ? src.token : '';
  const expMs = tokenExpiresAtMs(token);
  return {
    id: typeof src.id === 'string' ? src.id : '',
    name: typeof src.name === 'string' ? src.name : '',
    tokenMasked: maskToken(token),
    uid: typeof src.uid === 'string' ? src.uid : '',
    enabled: src.enabled === true,
    remark: typeof src.remark === 'string' ? src.remark : '',
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : '',
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : '',
    tokenExpiresAt: expMs === null ? null : isoNow(expMs),
    hasRefreshToken: typeof src.refreshToken === 'string' && Boolean(src.refreshToken),
    // 每账号独立的签到小时（北京时间 0~23），缺失时回落默认 8 点
    checkinHour: normalizeCheckinHour(src.checkinHour),
  };
}
