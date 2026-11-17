// test/helpers/memkv.mjs
// 内存版 KV Namespace，实现 src/store.js 需要的 get/put/delete 三个方法，
// 并记录每一次读/写/删以及 put 的 expirationTtl，供测试断言「写入次数」与「TTL」。
// 不依赖任何第三方包，也不需要 miniflare / workerd。

/**
 * 创建内存 KV。
 * @param {Record<string, string|object>} [initial] 预置数据（对象会被 JSON.stringify）
 * @returns {object} kv（含测试辅助方法）
 */
export function createMemoryKv(initial = {}) {
  /** @type {Map<string, string>} */
  const data = new Map();
  /** @type {Array<{op:'get'|'put'|'delete', key:string, value?:string, expirationTtl?:number|null}>} */
  const events = [];

  for (const [key, value] of Object.entries(initial)) {
    data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const kv = {
    // ===== KV Namespace 接口 =====
    async get(key) {
      events.push({ op: 'get', key });
      return data.has(key) ? data.get(key) : null;
    },
    async put(key, value, options) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      data.set(key, raw);
      const ttl = options && Number.isFinite(options.expirationTtl) ? options.expirationTtl : null;
      events.push({ op: 'put', key, value: raw, expirationTtl: ttl });
    },
    async delete(key) {
      data.delete(key);
      events.push({ op: 'delete', key });
    },

    // ===== 测试辅助 =====
    /** 全部事件（按发生顺序） */
    events,
    /** put 事件 */
    puts() {
      return events.filter((event) => event.op === 'put');
    },
    /** delete 事件 */
    deletes() {
      return events.filter((event) => event.op === 'delete');
    },
    /** 写事件（put + delete），等价于 store 的写计数口径 */
    writes() {
      return events.filter((event) => event.op === 'put' || event.op === 'delete');
    },
    /** 写事件总数 */
    writeCount() {
      return kv.writes().length;
    },
    /** get 事件 */
    reads() {
      return events.filter((event) => event.op === 'get');
    },
    /** 清空事件记录（保留数据），用于分段统计增量 */
    resetEvents() {
      events.length = 0;
    },
    /** 是否存在的键 */
    has(key) {
      return data.has(key);
    },
    /** 原始字符串值 */
    raw(key) {
      return data.has(key) ? data.get(key) : null;
    },
    /** 解析后的值（不存在返回 null） */
    json(key) {
      const raw = data.get(key);
      if (raw === undefined || raw === null) return null;
      return JSON.parse(raw);
    },
    /** 预置/覆盖一个键 */
    seed(key, value) {
      data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    /** 当前所有键 */
    keys() {
      return [...data.keys()];
    },
    /** 键数量 */
    size() {
      return data.size;
    },
  };

  return kv;
}
