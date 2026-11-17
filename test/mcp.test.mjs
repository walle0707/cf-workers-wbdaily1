// test/mcp.test.mjs
// 覆盖：MCP Key 鉴权（401 + -32001）/ 协议版本协商 / tools/list / 协议级错误码 /
//       5 个工具的行为与脱敏 / 工具级错误走 isError / Key 重置后旧 Key 失效（AC-15 ~ AC-17）。
// ARCHITECTURE §5.7。

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMcp, MCP_TOOLS } from '../src/mcp.js';
import { sha256Hex } from '../src/util.js';
import { createMemoryKv } from './helpers/memkv.mjs';
import {
  createAuthedEnv,
  createUpstreamMock,
  dailyOk,
  dispatch,
  jsonRes,
  makeAccount,
  makeCtx,
  SITE_ORIGIN,
  STATUS_PATH,
  statusCheckedIn,
  statusNotCheckedIn,
  T0,
} from './helpers/harness.mjs';

const MCP_KEY = 'sk-mcp_unit_test_key_0123456789abcdef';

/** 正常上游 mock。 */
function okUpstream() {
  return createUpstreamMock((call) => (call.path === STATUS_PATH ? statusNotCheckedIn() : dailyOk(10, 4)));
}

/**
 * 组装一个已配置 MCP Key 的环境。
 * @param {{accounts?:object[], fetch?:Function, key?:string}} [options]
 * @returns {Promise<{ctx:object, kv:object, key:string}>}
 */
async function mcpEnv(options = {}) {
  const key = options.key || MCP_KEY;
  const kv = createMemoryKv();
  const iso = new Date(T0).toISOString();
  kv.seed('config:mcp', {
    keyHash: await sha256Hex(key),
    prefix: key.slice(0, 12),
    createdAt: iso,
    rotatedAt: iso,
  });
  if (options.accounts) kv.seed('accounts', options.accounts);
  const { ctx } = makeCtx({ kv, fetch: options.fetch || okUpstream() });
  return { ctx, kv, key };
}

/**
 * 发一次 JSON-RPC 请求。
 * @param {object} ctx
 * @param {*} payload 对象会被 JSON.stringify；raw 传入原始文本
 * @param {{key?:string|null, raw?:string, method?:string}} [options]
 * @returns {Promise<{status:number, body:any, headers:Headers}>}
 */
async function callMcp(ctx, payload, options = {}) {
  const headers = { 'content-type': 'application/json' };
  const key = options.key === undefined ? MCP_KEY : options.key;
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const body = options.raw !== undefined ? options.raw : JSON.stringify(payload);
  const method = options.method || 'POST';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  const request = new Request(`${SITE_ORIGIN}/api/mcp`, init);
  const response = await handleMcp(ctx, request);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { __unparsable: text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/**
 * 取出工具调用结果的文本并解析为 JSON。
 * @param {object} rpcBody
 * @returns {{parsed:any, text:string, isError:boolean}}
 */
function toolResult(rpcBody) {
  assert.ok(rpcBody.result, `期望 JSON-RPC result，实际：${JSON.stringify(rpcBody)}`);
  assert.equal(Array.isArray(rpcBody.result.content), true, 'result.content 必须是数组');
  const text = rpcBody.result.content[0].text;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { parsed, text, isError: rpcBody.result.isError === true };
}

/** 构造一条 RunSummary。 */
function runSummary(runId, minutesAgo = 0) {
  const startedAt = new Date(T0 - minutesAgo * 60000).toISOString();
  return {
    runId,
    startedAt,
    finishedAt: startedAt,
    trigger: 'cron',
    total: 1,
    success: 1,
    failed: 0,
    skipped: 0,
    durationMs: 12,
    truncated: false,
    kvWriteCount: 4,
  };
}

// ===== 鉴权 =====

test('无 Key / 错 Key → 401 且 body 是 JSON-RPC -32001（AC-15）', async () => {
  const { ctx } = await mcpEnv();

  const noKey = await callMcp(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { key: null });
  assert.equal(noKey.status, 401);
  assert.equal(noKey.body.jsonrpc, '2.0');
  assert.equal(noKey.body.id, null);
  assert.equal(noKey.body.error.code, -32001);
  assert.equal(noKey.body.error.message, 'UNAUTHORIZED');

  const wrongKey = await callMcp(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { key: 'sk-mcp_wrong_key' });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.body.error.code, -32001);

  const emptyKv = makeCtx();
  const noRecord = await callMcp(emptyKv.ctx, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(noRecord.status, 401, '尚未生成 MCP Key 时任何 Bearer 都必须 401');
  assert.equal(noRecord.body.error.code, -32001);
});

test('GET /api/mcp 返回 404 JSON（仅支持 POST）', async () => {
  const { ctx } = await mcpEnv();
  const result = await callMcp(ctx, null, { method: 'GET', raw: '' });
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'NOT_FOUND');
});

// ===== 协议 =====

test('initialize 回显 2025-06-18，未知版本回落 2024-11-05', async () => {
  const { ctx } = await mcpEnv();

  const latest = await callMcp(ctx, {
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
  });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.id, 'init-1', 'id 必须回显');
  assert.equal(latest.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(latest.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(latest.body.result.serverInfo.name, 'wb-daily');
  assert.equal(latest.body.result.serverInfo.version, '1.0.0');

  const middle = await callMcp(ctx, {
    jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' },
  });
  assert.equal(middle.body.result.protocolVersion, '2025-03-26');

  const unknown = await callMcp(ctx, {
    jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2099-01-01' },
  });
  assert.equal(unknown.body.result.protocolVersion, '2024-11-05', '未知版本必须回落到 2024-11-05');

  const missing = await callMcp(ctx, { jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
  assert.equal(missing.body.result.protocolVersion, '2024-11-05');
});

test('tools/list 恰好 5 个工具，且都有 name/description/object inputSchema（AC-16）', async () => {
  const { ctx } = await mcpEnv();

  const res = await callMcp(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.status, 200);
  const tools = res.body.result.tools;
  assert.equal(tools.length, 5);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'wb_checkin_status',
    'wb_get_logs',
    'wb_list_accounts',
    'wb_manage_account',
    'wb_trigger_checkin',
  ]);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} 缺少 description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema.type 必须是 object`);
  }
  assert.equal(MCP_TOOLS.length, 5);
});

test('协议级错误码：-32700 解析失败 / -32600 非法请求 / -32601 未知方法 / -32602 未知工具', async () => {
  const { ctx } = await mcpEnv();

  const parseError = await callMcp(ctx, null, { raw: '{not json' });
  assert.equal(parseError.status, 400, '解析失败必须 HTTP 400');
  assert.equal(parseError.body.error.code, -32700);

  const invalidRequest = await callMcp(ctx, { id: 1, method: 'tools/list' });
  assert.equal(invalidRequest.body.error.code, -32600, '缺少 jsonrpc:2.0 必须 -32600');

  const unknownMethod = await callMcp(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/unknown' });
  assert.equal(unknownMethod.status, 200);
  assert.equal(unknownMethod.body.error.code, -32601);

  const unknownTool = await callMcp(ctx, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'wb_not_exist', arguments: {} },
  });
  assert.equal(unknownTool.status, 200);
  assert.equal(unknownTool.body.error.code, -32602);

  const missingName = await callMcp(ctx, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} });
  assert.equal(missingName.body.error.code, -32602);
});

// ===== 工具行为 =====

test('wb_list_accounts 返回 tokenMasked 且绝无 token 字段（AC-6）', async () => {
  const accounts = [makeAccount(1, { token: 'abcdefghijkl' }), makeAccount(2, { token: 'xyz' })];
  const { ctx } = await mcpEnv({ accounts });

  const res = await callMcp(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wb_list_accounts', arguments: {} },
  });
  const { parsed } = toolResult(res.body);

  assert.equal(parsed.total, 2);
  assert.equal(parsed.accounts[0].tokenMasked, 'abcd****ijkl');
  assert.equal(parsed.accounts[1].tokenMasked, '****');
  for (const account of parsed.accounts) {
    assert.equal(Object.keys(account).includes('token'), false, `工具出参不得含 token：${JSON.stringify(account)}`);
  }
  assert.equal(res.body.result.content[0].text.includes('abcdefghijkl'), false);
});

test('wb_checkin_status 查全部启用账号且零 KV 写（AC-16）', async () => {
  const accounts = [makeAccount(1), makeAccount(2, { enabled: false })];
  const { ctx, kv } = await mcpEnv({
    accounts,
    fetch: createUpstreamMock(() => statusCheckedIn(11)),
  });

  const before = ctx.writes();
  const res = await callMcp(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wb_checkin_status', arguments: {} },
  });
  const { parsed } = toolResult(res.body);

  assert.equal(parsed.total, 1, '只查启用账号');
  assert.equal(parsed.statuses[0].accountId, accounts[0].id);
  assert.equal(parsed.statuses[0].result, 'already_checked_in');
  assert.equal(parsed.statuses[0].streakDays, 11);
  assert.equal(ctx.writes() - before, 0, 'checkin_status 必须零 KV 写');
  assert.equal(kv.events.filter((event) => event.op !== 'get').length, 0, '全程不得产生任何 KV 写事件');

  const single = await callMcp(ctx, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wb_checkin_status', arguments: { accountId: accounts[1].id } },
  });
  assert.equal(toolResult(single.body).parsed.total, 1, '指定 accountId 时即使禁用也查（显式查询）');

  const missing = await callMcp(ctx, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wb_checkin_status', arguments: { accountId: 'acc_ghost' } },
  });
  assert.equal(toolResult(missing.body).isError, true, '账号不存在是工具级错误');
  assert.match(toolResult(missing.body).text, /NOT_FOUND/);
});

test('wb_trigger_checkin：锁被占用时 isError 且 text 含 CONFLICT', async () => {
  const { ctx, kv } = await mcpEnv({ accounts: [makeAccount(1)] });
  kv.seed('lock:run', { runId: 'run_holder', holder: 'cron', startedAt: new Date(T0).toISOString() });

  const res = await callMcp(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wb_trigger_checkin', arguments: {} },
  });

  assert.equal(res.status, 200, '工具级错误必须 HTTP 200');
  const { isError, text } = toolResult(res.body);
  assert.equal(isError, true);
  assert.match(text, /CONFLICT/);
  assert.match(text, /run_holder/);
});

test('wb_trigger_checkin：正常返回 runId/summary/entries；dryRun 零写', async () => {
  const { ctx, kv } = await mcpEnv({ accounts: [makeAccount(1), makeAccount(2)] });
  const writesBefore = ctx.writes();

  const dry = await callMcp(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'wb_trigger_checkin', arguments: { dryRun: true } },
  });
  const dryParsed = toolResult(dry.body).parsed;
  assert.equal(dryParsed.dryRun, true);
  assert.equal(dryParsed.summary.total, 2);
  assert.equal(ctx.writes() - writesBefore, 0, 'dryRun 必须零 KV 写');
  assert.equal(kv.has('log:index'), false);

  const real = await callMcp(ctx, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wb_trigger_checkin', arguments: {} },
  });
  const parsed = toolResult(real.body).parsed;
  assert.match(parsed.runId, /^run_/);
  assert.equal(parsed.summary.total, 2);
  assert.equal(parsed.summary.success, 2);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.flushError, null);
  assert.equal(kv.json('log:index').length, 1, '触发后必须产生 1 条索引');
});

test('wb_manage_account：create 脱敏返回、update 改名、delete 后列表减少', async () => {
  const { ctx } = await mcpEnv();

  const created = await callMcp(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'wb_manage_account', arguments: { action: 'create', name: 'MCP账号', token: 'Bearer abcdefghijkl' } },
  });
  const createdAccount = toolResult(created.body).parsed.account;
  assert.equal(createdAccount.tokenMasked, 'abcd****ijkl');
  assert.equal(Object.keys(createdAccount).includes('token'), false);
  assert.equal(created.body.result.content[0].text.includes('abcdefghijkl'), false);

  const updated = await callMcp(ctx, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'wb_manage_account', arguments: { action: 'update', id: createdAccount.id, name: '改名了' } },
  });
  assert.equal(toolResult(updated.body).parsed.account.name, '改名了');

  const list = await callMcp(ctx, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wb_list_accounts', arguments: {} },
  });
  assert.equal(toolResult(list.body).parsed.total, 1);

  const deleted = await callMcp(ctx, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'wb_manage_account', arguments: { action: 'delete', id: createdAccount.id } },
  });
  assert.equal(toolResult(deleted.body).parsed.deleted, true);

  const after = await callMcp(ctx, {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wb_list_accounts', arguments: {} },
  });
  assert.equal(toolResult(after.body).parsed.total, 0, '删除后列表必须减少');

  const badAction = await callMcp(ctx, {
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'wb_manage_account', arguments: { action: 'explode' } },
  });
  assert.equal(toolResult(badAction.body).isError, true);
  assert.match(toolResult(badAction.body).text, /BAD_REQUEST/);
});

test('wb_get_logs：limit 生效，给 runId 返回明细', async () => {
  const { ctx, kv } = await mcpEnv();
  const summaries = [1, 2, 3, 4, 5].map((index) => runSummary(`run_${index}`, index));
  kv.seed('log:index', summaries);
  const detail = { ...summaries[0], entries: [{ accountId: 'acc_1', accountName: '账号1', result: 'checked_in' }] };
  kv.seed('log:run:run_1', detail);

  const limited = await callMcp(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wb_get_logs', arguments: { limit: 2 } },
  });
  const limitedParsed = toolResult(limited.body).parsed;
  assert.equal(limitedParsed.total, 2, 'limit 必须生效');
  assert.deepEqual(limitedParsed.logs.map((item) => item.runId), ['run_1', 'run_2']);

  const full = await callMcp(ctx, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wb_get_logs', arguments: {} },
  });
  assert.equal(toolResult(full.body).parsed.total, 5, '省略 limit 返回全部索引');

  const one = await callMcp(ctx, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wb_get_logs', arguments: { runId: 'run_1' } },
  });
  const oneParsed = toolResult(one.body).parsed;
  assert.equal(oneParsed.runId, 'run_1');
  assert.equal(oneParsed.entries.length, 1);

  const missing = await callMcp(ctx, {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wb_get_logs', arguments: { runId: 'run_ghost' } },
  });
  assert.equal(toolResult(missing.body).isError, true);
  assert.match(toolResult(missing.body).text, /NOT_FOUND/);
});

test('MCP Key 重置后旧 Key 立即失效，新 Key 可用，KV 只存哈希（AC-17）', async () => {
  const { ctx, kv, cookie } = await createAuthedEnv();

  const first = await dispatch(ctx, '/api/mcp-key', { method: 'POST', cookie });
  assert.equal(first.status, 200);
  const firstKey = first.body.data.key;

  const allowed = await callMcp(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { key: firstKey });
  assert.equal(allowed.status, 200, '新生成的 Key 必须立刻可用');
  assert.equal(allowed.body.result.tools.length, 5);

  const rotated = await dispatch(ctx, '/api/mcp-key', { method: 'POST', cookie });
  const secondKey = rotated.body.data.key;
  assert.notEqual(secondKey, firstKey);

  const stale = await callMcp(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { key: firstKey });
  assert.equal(stale.status, 401, '重置后旧 Key 必须立即失效');
  assert.equal(stale.body.error.code, -32001);

  const fresh = await callMcp(ctx, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { key: secondKey });
  assert.equal(fresh.status, 200);

  const record = kv.json('config:mcp');
  assert.equal(record.keyHash.length, 64, 'KV 只存 sha256 十六进制');
  assert.equal(record.prefix, secondKey.slice(0, 12));
  assert.equal(JSON.stringify(record).includes(secondKey), false, 'KV 不得出现明文 Key');
});
