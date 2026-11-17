// src/mcp.js
// MCP（Model Context Protocol）JSON-RPC 2.0 分发 + 5 个工具。
// 鉴权：Authorization: Bearer <MCP Key>（KV 只存 sha256 十六进制）。
// 约定：工具级错误用 result.isError（HTTP 200），协议级错误用 JSON-RPC error，
//       鉴权失败固定 HTTP 401 + code -32001。

import { AppError, sanitizeToken, sha256Hex, safeEqual } from './util.js';
import { jsonResponse } from './router.js';
import { runCheckin } from './run.js';
import { recordProgress } from './progress.js';
import {
  VERSION,
  svcCheckinStatus,
  svcCreateAccount,
  svcDeleteAccount,
  svcGetLogs,
  svcGetRun,
  svcListAccounts,
  svcUpdateAccount,
} from './api.js';

/** 支持的协议版本（回显客户端值，否则回落最后一个）。 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC 错误码。 */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_UNAUTHORIZED = -32001;

/** 工具文本内容的字符上限（防止超长 JSON 淹没客户端上下文）。 */
const TOOL_TEXT_MAX_CHARS = 12000;

/**
 * 组装 JSON-RPC 错误响应（默认 HTTP 200；解析失败用 400）。
 * @param {number} code
 * @param {string} message
 * @param {string|number|null} id
 * @param {number} [status]
 * @returns {Response}
 */
function rpcError(code, message, id = null, status = 200) {
  return jsonResponse(
    { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } },
    { status },
  );
}

/**
 * 组装 JSON-RPC 成功响应。
 * @param {*} result
 * @param {string|number|null} id
 * @returns {Response}
 */
function rpcResult(result, id = null) {
  return jsonResponse({ jsonrpc: '2.0', id: id === undefined ? null : id, result }, { status: 200 });
}

/**
 * 工具调用成功结果。
 * @param {*} payload 任意可 JSON 序列化对象
 * @returns {{content:Array<{type:string,text:string}>}}
 */
function toolOk(payload) {
  let text = JSON.stringify(payload === undefined ? null : payload);
  if (typeof text !== 'string') text = 'null';
  if (text.length > TOOL_TEXT_MAX_CHARS) text = text.slice(0, TOOL_TEXT_MAX_CHARS);
  return { content: [{ type: 'text', text }] };
}

/**
 * 工具调用错误结果（HTTP 200 + isError）。
 * @param {string} code 错误码字符串（CONFLICT / NOT_FOUND / BAD_REQUEST ...）
 * @param {string} message
 * @returns {{content:Array<{type:string,text:string}>, isError:true}}
 */
function toolError(code, message) {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}

/**
 * 校验 MCP Key。
 * @param {object} ctx
 * @param {Request} request
 * @returns {Promise<boolean>}
 */
async function verifyMcpKey(ctx, request) {
  const header = request.headers.get('authorization') || '';
  const key = sanitizeToken(header);
  if (!key) return false;
  const record = await ctx.kv.getMcp();
  if (!record || typeof record.keyHash !== 'string' || !record.keyHash) return false;
  const hash = await sha256Hex(key);
  return safeEqual(hash, record.keyHash);
}

/**
 * 取工具入参对象。
 * @param {*} value
 * @returns {object}
 */
function asArgs(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 5 个 MCP 工具的定义（供 tools/list）。
 * @type {Array<{name:string, description:string, inputSchema:object}>}
 */
export const MCP_TOOLS = [
  {
    name: 'wb_list_accounts',
    description: '列出所有 WorkBuddy 签到账号（token 已脱敏，只返回 tokenMasked）。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'wb_checkin_status',
    description: '查询账号今日签到状态（只查询，不执行签到，不产生 KV 写入）。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '账号 ID，省略则查询全部启用账号' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wb_trigger_checkin',
    description: '触发签到。dryRun=true 时只查询状态；省略 accountId 时对全部启用账号执行。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '只签到这个账号，省略则全部启用账号' },
        dryRun: { type: 'boolean', description: '仅预演（只查状态，零 KV 写）', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wb_get_logs',
    description: '读取签到历史。给 runId 返回该次明细，否则返回索引列表。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'run ID，省略则返回索引列表' },
        limit: { type: 'integer', description: '索引条数上限（1~100）', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wb_manage_account',
    description: '管理签到账号：create / update / delete。出参一律脱敏（tokenMasked）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: '操作类型' },
        id: { type: 'string', description: '账号 ID（update / delete 必填）' },
        name: { type: 'string', description: '账号名称' },
        token: { type: 'string', description: '上游 token（update 时省略或空串表示不修改）' },
        uid: { type: 'string', description: '上游 UID（可选）' },
        remark: { type: 'string', description: '备注（可选）' },
        enabled: { type: 'boolean', description: '是否启用' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

/**
 * 执行单个工具。
 * @param {object} ctx
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>} 工具结果（含 content / 可选 isError）
 */
async function callTool(ctx, name, args) {
  try {
    if (name === 'wb_list_accounts') {
      const accounts = await svcListAccounts(ctx);
      return toolOk({ accounts, total: accounts.length });
    }
    if (name === 'wb_checkin_status') {
      const statuses = await svcCheckinStatus(ctx, asArgs(args).accountId);
      return toolOk({ statuses, total: statuses.length });
    }
    if (name === 'wb_trigger_checkin') {
      const input = asArgs(args);
      const accountId = typeof input.accountId === 'string' && input.accountId ? input.accountId : null;
      const result = await runCheckin(ctx, {
        accountIds: accountId ? [accountId] : null,
        trigger: 'manual',
        dryRun: input.dryRun === true,
      });
      // dryRun 不产生签到副作用，也就不该写当日进度
      if (input.dryRun !== true) await recordProgress(ctx, result.entries);
      return toolOk({
        runId: result.runId,
        dryRun: input.dryRun === true,
        summary: result.summary,
        entries: result.entries,
        flushError: result.flushError,
      });
    }
    if (name === 'wb_get_logs') {
      const input = asArgs(args);
      const runId = typeof input.runId === 'string' && input.runId ? input.runId : null;
      if (runId) return toolOk(await svcGetRun(ctx, runId));
      const logs = await svcGetLogs(ctx, input.limit);
      return toolOk({ logs, total: logs.length });
    }
    if (name === 'wb_manage_account') {
      const input = asArgs(args);
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'create') {
        const account = await svcCreateAccount(ctx, input);
        return toolOk({ account });
      }
      if (action === 'update') {
        if (!input.id) return toolError('BAD_REQUEST', 'update 需要提供 id');
        const account = await svcUpdateAccount(ctx, input.id, input);
        return toolOk({ account });
      }
      if (action === 'delete') {
        if (!input.id) return toolError('BAD_REQUEST', 'delete 需要提供 id');
        return toolOk(await svcDeleteAccount(ctx, input.id));
      }
      return toolError('BAD_REQUEST', 'action 必须是 create / update / delete');
    }
    return toolError('NOT_FOUND', `未知工具：${name}`);
  } catch (err) {
    if (err instanceof AppError) return toolError(err.code, err.message);
    console.error(JSON.stringify({ level: 'error', event: 'mcp_tool_failed', tool: name, message: String((err && err.message) || err) }));
    return toolError('INTERNAL', '工具执行失败');
  }
}

/**
 * 处理 MCP 请求（仅 POST /api/mcp）。
 * @param {object} ctx
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleMcp(ctx, request) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'MCP 仅支持 POST' } }, { status: 404 });
  }

  // 鉴权优先于解析（避免对匿名请求做全量 JSON 解析）
  const authorized = await verifyMcpKey(ctx, request);
  if (!authorized) {
    return jsonResponse(
      { jsonrpc: '2.0', id: null, error: { code: RPC_UNAUTHORIZED, message: 'UNAUTHORIZED' } },
      { status: 401 },
    );
  }

  let payload;
  try {
    const text = await request.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    return rpcError(RPC_PARSE_ERROR, 'Parse error', null, 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.jsonrpc !== '2.0') {
    const id = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.id : null;
    return rpcError(RPC_INVALID_REQUEST, 'Invalid Request', id === undefined ? null : id);
  }

  const id = payload.id === undefined ? null : payload.id;
  const rpcMethod = typeof payload.method === 'string' ? payload.method : '';
  const params = asArgs(payload.params);

  try {
    if (rpcMethod === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(
        {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'wb-daily', version: VERSION },
        },
        id,
      );
    }
    if (rpcMethod === 'ping') {
      return rpcResult({}, id);
    }
    if (rpcMethod === 'tools/list') {
      return rpcResult({ tools: MCP_TOOLS }, id);
    }
    if (rpcMethod === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return rpcError(RPC_INVALID_PARAMS, '缺少工具名 name', id);
      const known = MCP_TOOLS.some((tool) => tool.name === name);
      if (!known) return rpcError(RPC_INVALID_PARAMS, `未知工具：${name}`, id);
      const result = await callTool(ctx, name, params.arguments);
      return rpcResult(result, id);
    }
    if (!rpcMethod) return rpcError(RPC_INVALID_REQUEST, 'Invalid Request', id);
    return rpcError(RPC_METHOD_NOT_FOUND, `Method not found: ${rpcMethod}`, id);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'mcp_failed', message: String((err && err.message) || err) }));
    return rpcError(RPC_INTERNAL_ERROR, 'Internal error', id);
  }
}
