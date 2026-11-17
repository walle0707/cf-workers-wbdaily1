# CF-Workers-WBDaily

一句话：把 WorkBuddy 每日签到搬进 Cloudflare Workers —— 一个 Worker 同时提供**网页面板**、**Cron 定时签到**和 **MCP 接口**，数据只存在你自己的 KV 里。

---

## ✨ 它能做什么

| 功能 | 说明 |
| --- | --- |
| 🌐 **网页面板** | 首次设置密码 → 录入账号 → 一键签到 → 查看每次执行的逐账号明细 |
| ⏰ **自动签到** | 每个账号自选北京时间整点，到点自动签、失败自动重试，改时间不用重新部署 |
| 💰 **积分配额** | 账号卡片实时显示用量状态、总剩余积分、套餐基础/奖励积分，可手动刷新（只读上游，不写 KV） |
| 📥 **导入 / 导出** | 直接吃 `cockpit-tools` 导出的 WorkBuddy JSON，也能导出成它可再导入的格式；重复导入不产生重复账号 |
| 🤖 **MCP 接口** | 给 Claude / Cursor 等 AI 客户端 5 个工具（列账号、查状态、触发签到、读日志、管账号） |
| 🆓 **零成本** | 跑在 Cloudflare 免费额度内；零构建前端（3 个静态文件），一次常规签到只写 4 次 KV |

## 🚀 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CMToolbox/CF-Workers-WBDaily)

点击上方按钮，按页面提示完成三步：

1. **确认资源**：Cloudflare 会读取仓库配置，**自动创建 KV 命名空间并完成绑定**，同时把代码 clone 到你自己的 GitHub 账号，无需手动建 KV；
2. **填写 SETUP_TOKEN（建议）**：填一个自定义随机字符串（例如用 `openssl rand -hex 16` 生成），防止别人抢先初始化你的面板；
3. **完成部署**：打开你的 Worker 域名（形如 `https://cf-workers-wbdaily.<你的子域>.workers.dev`）→ 设置管理员密码（至少 8 位）→ 按下方「使用说明」录入账号。

> ⚠️ **不填 SETUP_TOKEN 也能用**，但任何第一个打开你域名的人都能设置密码。部署后可随时补配：Dashboard → 你的 Worker → Settings → Variables → Secrets，添加 `SETUP_TOKEN`；或命令行 `npx wrangler secret put SETUP_TOKEN`。
>
> ⚠️ **导出的账号 JSON 含明文 token**，等同账号密码，请勿放进 Git、公开网盘链接或聊天记录。

## 📖 使用说明

### 1️⃣ 录入账号

面板「新增账号」→ 填名称 + 粘贴 WorkBuddy token（可选 UID / 备注），最多 10 个。

- **`refresh_token` 强烈建议一起填**：`access_token` 是短期凭据（官方登录 `expires_in=3600`，实际以 JWT 的 `exp` 为准），而且**会被上游轮换**——在 cockpit-tools 里刷新一次，之前导出的 access_token 就可能失效。只填 access_token 迟早 401；填了 refresh_token 后程序会在到期前自动续期并回写 KV。
- **UID 建议填写**：积分配额查询需要 UID，不填可能查不到额度数据。

<details>
<summary><b>📤 账号导入 / 导出的细节</b></summary>

账号区「导入」可直接上传 `cockpit-tools` 导出的 `workbuddy_accounts_*.json`：

- 每张账号卡片底部的「导出」按钮只导出**该账号**的 JSON（文件名形如 `workbuddy_account_<账号名>_<日期>.json`）；
- 账号区顶部的「导出全部」用于批量备份（生成 `workbuddy_accounts_<日期>.json`）；
- 两者都**含明文 token**，都会二次确认，请妥善保管；
- 重复导入按 uid 优先、token 兜底匹配，不会重复添加；导入后超过 10 个账号会整批拒绝。

</details>

### 2️⃣ 设定签到时间

**签到时间是每个账号各自的属性**，没有全局设置。每张账号卡片底部有独立的下拉，选北京时间整点（0~23），**选中即保存、即时生效、不用重新部署**。

- 新增/导入账号时如果没指定时间，会**从 8 点起自动挑一个没被占用的整点**（导入 5 个账号 → 08 / 09 / 10 / 11 / 12 点；中间有空格会优先补洞）。这样多个账号不会压在同一小时集中请求，既像脚本也容易触发风控；
- 规则可预测，也随时能在卡片上改，不会被自动分配锁死；
- 从旧版本升级的账号没有 `checkinHour` 字段，会统一回落到 8 点，在卡片上逐个改一下即可。

> 为什么是每 15 分钟轮询、时区怎么换算？原理见下方技术细节区的「⏱️ 签到时间与调度原理」折叠块。

### 3️⃣ 日常使用

- **测试签到**：账号行右侧「测试签到」立刻跑一次，结果以徽标形式显示在该账号行上（最近一次结果）；
- **立即全部签到**：只跑「启用」的账号；执行期间按钮禁用，完成后弹「成功 x / 共 y」；
- **看额度**：卡片自动查询积分配额；点「刷新额度」可单独重查（只读上游，不写 KV）；
- **看日志**：「执行记录」列出每次执行的时间、触发方式（定时/手动/单账号）、成功数与耗时；点一行展开逐账号明细（HTTP 状态、业务 code、上游 message、连续天数、额度）。

### 4️⃣ （可选）接入 AI 客户端（MCP）

<details>
<summary><b>🤖 展开：MCP 接入配置</b></summary>

在 AI 客户端里加一个 HTTP MCP Server（各家字段命名略有差异，核心是 **URL** + **Authorization 头**）：

```json
{
  "mcpServers": {
    "wb-daily": {
      "url": "https://cf-workers-wbdaily.<你的子域>.workers.dev/api/mcp",
      "headers": {
        "Authorization": "Bearer sk-mcp_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

只支持 stdio 的客户端可以用 `mcp-remote` 桥接：

```json
{
  "mcpServers": {
    "wb-daily": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://cf-workers-wbdaily.<你的子域>.workers.dev/api/mcp",
               "--header", "Authorization: Bearer sk-mcp_xxxxxxxxxxxxxxxx"]
    }
  }
}
```

先用 curl 验证 Key 是否可用：

```bash
curl -sS https://cf-workers-wbdaily.<你的子域>.workers.dev/api/mcp \
  -H "Authorization: Bearer sk-mcp_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Key 在面板「设置」→「MCP 接口」→ 生成，**明文只显示一次**。返回 5 个工具即表示打通：

| 工具 | 作用 |
| --- | --- |
| `wb_list_accounts` | 列出账号（token 已脱敏为 `tokenMasked`） |
| `wb_checkin_status` | 只查今日签到状态，不产生签到、不写 KV |
| `wb_trigger_checkin` | 触发签到，`dryRun:true` 时只预演 |
| `wb_get_logs` | 读执行记录；给 `runId` 返回该次明细 |
| `wb_manage_account` | 增 / 改 / 删账号（出参一律脱敏） |

工具级错误不会中断会话，而是以 `isError:true` 的文本返回（例如 `CONFLICT: 已有任务在执行（run_xxx）`）；只有 Key 错误才返回 HTTP 401。

</details>

## ❓ 常见问题

**账号显示「失败 / Token 已失效（HTTP 401）」**
先看卡片上的 token 状态徽标：显示「可自动续期」→ 程序会自动换新 token，持续 401 说明 refresh_token 也失效了，重新导入账号 JSON；显示「缺 refresh_token」→ 用当前版本从 cockpit-tools 重新导出并导入一次；显示「Token 有效期未知」→ 上游 token 不是标准 JWT，程序只能靠 401 兜底续期。

**卡片提示「上游拒绝访问（HTTP 403）」**
**不是 token 问题**（token 有效也会被拦下）。这是 Worker 出口 IP 被上游边缘风控或限流，可先稍后重试（代码已对 403/429/5xx/超时自动重试 1 次）；持续失败需自建中转，方法见下方完整故障排查表。

**到点了但没签到**
先看**该账号卡片上的时间**是不是你以为的那个整点（每账号独立，不是全局设置）；再用 `npx wrangler tail --search cron_tick` 看日志，`dueAccounts` 为 0 说明没有账号设在这个小时。

**登录或设置密码时报 `1102` / 页面 500**
单请求 CPU 超限。确认 `wrangler.toml` 里 `PBKDF2_ITERATIONS = "30000"`，不要调到 10 万。

<details>
<summary><b>🩺 展开完整故障排查表</b></summary>

| 现象 | 原因与处理 |
| --- | --- |
| 账号显示「失败 / Token 已失效（HTTP 401）」 | **先看卡片上的 token 状态徽标**。`access_token` 是短期凭据且会被上游轮换：<br>① 显示「可自动续期」→ 程序会在到期前自动换新，持续 401 说明 refresh_token 也失效了，重新导入账号 JSON；<br>② 显示「缺 refresh_token」→ 该账号导入时没带 refresh_token（旧版本面板会在上传前裁掉它），请用当前版本从 cockpit-tools 重新导出并导入一次；<br>③ 显示「Token 有效期未知」→ 上游 token 不是标准 JWT，程序只能靠 401 兜底续期 |
| 卡片提示「…未保存 refresh_token，无法自动续期」 | 导入来源缺少 refresh_token（旧版本前端上传时会裁掉它）。cockpit-tools 的 `workbuddy_accounts_*.json` 里带 `refreshToken` 字段，用当前版本重新导入即可；手工新增则把 refresh_token 一起粘进对话框 |
| 卡片提示「上游拒绝访问（HTTP 403）：可能是出口 IP 被风控或触发限流」 | **不是 token 问题**（token 有效也会被这条链路拦下）。这是 Worker 出口 IP 被上游边缘（EdgeOne/APISIX）风控或限流；可先稍后重试（代码已对 403/429/5xx/超时自动重试 1 次）。持续失败请用自建中转：`wrangler secret put UPSTREAM_BASE_URL`（签到）、`CREDITS_BASE_URL`（额度）、`REFRESH_BASE_URL`（token 续期），值填你自己中转的 `https://...` 基址 |
| 测试签到提示「今天已签到，请明天再来」/ run 明细里 `code=10001` | 当日重复签到属于幂等成功：现在按 `already_checked_in` 处理，不再记成「失败」。上游返回的是 HTTP 400 + 业务码 10001，代码优先按业务码判定 |
| 登录或设置密码时报 `1102` / 页面 500 | 单请求 CPU 超限。确认 `wrangler.toml` 里 `PBKDF2_ITERATIONS = "30000"`，不要调到 10 万 |
| 页面 404 / 打开是空白 | 检查 `wrangler.toml` 的 `[assets] directory = "./public"`、`binding = "ASSETS"`、`not_found_handling = "none"`；`public/` 下必须有 `index.html`、`app.js`、`styles.css` |
| 部署报 `KV namespace ... not found` | `[[kv_namespaces]]` 的 `id` 还是无效/占位值，替换成 `wrangler kv namespace create WB_KV` 的输出 |
| 设置页提示「系统已初始化」（409） | KV 里已有 `config:auth`。要重新初始化请按下方「彻底重置」处理（注意：只删 `config:auth` 会保留账号与 token） |
| 登录提示「尝试过于频繁」 | 5 次密码错误后进入退避（30s 起，逐次翻倍，封顶 15min），等倒计时结束或换网络环境 |
| 签到提示「已有任务在执行」 | 有别的 run 持有锁（`lock:run`，TTL 300s）。等 5 分钟或等上一次跑完 |
| 到点了但没签到 | ① 先看**该账号卡片上的时间**是不是你以为的那个整点（每账号独立，不是全局设置）；② `npx wrangler tail --search cron_tick` 看每轮日志：`beijingHour` 是当前北京时间小时，`dueAccounts` 是这一轮到点的账号数，为 0 说明没有任何账号设在这个小时；③ 若 `cron_tick` 根本没有，说明 `wrangler.toml` 的 `crons` 没部署上去，重新 `npm run deploy` |
| 想确认某天是否真的签过 | `wrangler kv key get --namespace-id <id> --remote "checkin:day"`；只有成功（`checked_in` / `already_checked_in`）才会出现在里面，失败不入库因此会重试 |
| 想把调度换成别的频率 | 改账号的签到时间只需在卡片上选；只有当你想改「每小时重试几次」时才动 `wrangler.toml` 的 `crons`（必须仍是每 15 分钟的整数倍，否则会漏窗口） |
| 想看运行日志 | `npx wrangler tail`（结构化单行 JSON，可用 `--search run_finished` 过滤） |

**彻底重置（清空所有数据，不可恢复）**：

```bash
# 推荐：直接删掉整个命名空间，然后重新 create + 把新 id 填回 wrangler.toml
npx wrangler kv namespace delete WB_KV
```

这会把**登录密码、账号与 token、MCP Key、全部日志**一起删除（控制台里删 KV 命名空间等价）。

> ⚠️ **只删 `config:auth` 不等于重置**：账号、token、MCP Key、日志都还在，下一个设置密码的人会直接接管你所有的 token。只有当「想保留账号与日志、只想重设密码」时才这么做：
>
> ```bash
> # 先列出全部键，确认清楚要动哪些（log:run:{runId} 每个 run 一个，要按实际 runId 删）
> npx wrangler kv key list --namespace-id <你的 KV id>
> npx wrangler kv key delete --namespace-id <你的 KV id> config:auth
> ```

</details>

## 🔧 技术细节（按需展开）

<details>
<summary><b>🏗️ 架构总览</b></summary>

```
┌──────────────┐        ┌──────────────────────── Cloudflare Worker ────────────────────────┐
│  浏览器面板   │  HTTP  │  index.js                                          src/api.js      │
│ index.html   │───────▶│   ├─ /api/*        ──▶ 鉴权(Cookie) ──▶ 业务 handler ──┐          │
│ app.js       │  JSON  │   ├─ /api/mcp      ──▶ 鉴权(Bearer Key) ──▶ MCP 工具 ──┤          │
│ styles.css   │◀───────│   └─ 其它路径      ──▶ ASSETS（静态文件）            │          │
└──────────────┘        │                                                       ▼          │
                        │  Cron(每15分钟) ──▶ schedule 判定 ──▶ run.js ──▶ checkin.js ─▶ 上游 │
                        │                                                       │          │
                        │                            store.js ──▶ KV (WB_KV) ◀──┘          │
                        └──────────────────────────────────────────────────────────────────┘
```

三层结构：`index`（分流）→ `api / mcp / run`（业务）→ `store`（KV 封装），工具函数在 `util / router / auth / checkin / logger`。所有业务函数首参是 `ctx`，KV、`fetch`、时钟全部注入，方便单测。

Cron 不再直接签到：`index.scheduled()` 先让 `schedule.js` 挑出「自己的签到小时 == 当前北京小时」的账号，有才调 `run.js`，其余触发零写返回；`upstream-headers.js` 统一三条上游链路的请求头，`upstream-token.js` 负责 access_token 的续期。

</details>

<details>
<summary><b>📦 手动部署（CLI 方式）</b></summary>

前置要求：一个 Cloudflare 账号（免费版即可）、Node.js **20+**（推荐 22，与 `package.json` 的 `engines` 一致）与 npm、一个可用的 WorkBuddy token（面板里填，或从已登录的网页端复制）。

```bash
# 1. 装依赖
npm install

# 2. 创建 KV 命名空间，把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]] id
npx wrangler kv namespace create WB_KV

# 3. 设置部署令牌（强烈推荐，防止别人抢先初始化你的面板）
npx wrangler secret put SETUP_TOKEN

# 4. 部署
npm run deploy

# 5. 打开终端输出的域名，按页面提示设置管理员密码（至少 8 位）
```

`SETUP_TOKEN` 的作用：设置了它之后，`POST /api/setup` 必须带上正确的 `x-setup-token` 头。面板检测到它存在时，首次设置页会多出一个「部署令牌」输入框。**不设置也能用**，但任何人只要第一个打开你的域名就能设密码。

> `wrangler.toml` 里 `[assets]` 的 `not_found_handling` 必须是 `none`，否则 `POST /api/*` 会拿到 HTML 而不是 JSON。

</details>

<details>
<summary><b>💻 本地开发与测试</b></summary>

```bash
npx wrangler dev            # 默认 http://localhost:8787
```

本地调试建议放一个 `.dev.vars`（已在 `.gitignore` 中）：

```ini
SETUP_TOKEN=dev-token
```

`wrangler dev` 会用本地模拟的 KV；想连真实 KV 加 `--remote`。本地没有 `SETUP_TOKEN` 时，设置页不会显示部署令牌输入框。

跑单元测试（**零依赖、不需要 wrangler 登录、不需要网络**）：

```bash
npm test
```

等价于 `node --test test/*.test.mjs`。它会跑 `test/` 下的全部用例：用内存 KV + mock 上游覆盖签到 / 鉴权 / 接口 / MCP / 额度 / 导入导出全链路，**不会真的去签到**，也不会碰你线上的 KV。

> 请用 `npm test`（或上面的完整命令），不要用 `node --test test`。后者在 Node 22 上会按目录解析成模块路径并报 `MODULE_NOT_FOUND`。

</details>

<details>
<summary><b>⏱️ 签到时间与调度原理</b></summary>

#### 时区：面板填北京时间，cron 是 UTC

- 面板与 KV 里存的都是**北京时间整点**（0~23），不做 UTC 存储，避免来回换算引入错误；
- 唯一的转换点是 `beijingParts()`：把 Cloudflare 给的 `scheduledTime`（UTC 毫秒）换算成「北京日期 + 北京小时」；
- `wrangler.toml` 用的是 `*/15 * * * *`，这种写法和时区无关，所以**不需要你把 8 点折算成 0 点**；
- 卡片下拉的 `title` 会顺带显示对应的 UTC 钟点（如北京 08:00 → UTC 00:00）供核对。

#### 为什么是每 15 分钟轮询，而不是「每个账号一条精确 cron」

Cloudflare 的 cron 触发不保证准点（边缘调度 + 实例冷启动可能延迟几分钟），且一个 Worker 最多 3 条 cron，没法给 10 个账号各配一条。所以固定每 15 分钟触发，再由 `scheduled()` 按「账号自己的小时」挑人：

```text
每 15 分钟触发
  └─ 读 accounts（1 次读）
      ├─ 没有账号落在当前北京小时 → 直接返回（零写、零上游）
      └─ 有 → 读 checkin:day 排掉已完成的
            ├─ 全完成 → 返回（零写、零上游）
            └─ 跑 runCheckin(只跑这些账号) → 写 checkin:day
```

某个账号的目标小时内 `:00 / :15 / :30 / :45` 共 4 轮都算窗口：

- 第一轮成功后把结果写进 KV 的 `checkin:day`，后 3 轮读到达标即短路（零写、零上游请求）；
- 第一轮失败（5xx / 403 / 超时）不写进度，后 3 轮自动成为**重试机会**；
- 部分成功时只对剩下的账号发起请求，已完成的不会重复打上游。

判定用的是**本轮 cron 的 `scheduledTime`**，不是执行时刻：即使实例冷启动延迟到 08:03 才跑，仍按 08:00 这轮归属，不会因为跨点而漏签。

#### 改轮询频率

只有当你想改「每小时重试几次」时才需要动 `wrangler.toml` 的 `crons` 并重新 `npm run deploy`；改某个账号的签到小时不需要动它。

</details>

<details>
<summary><b>🧾 免费额度与成本</b></summary>

| 项目 | 免费额度 | 本项目的用量 |
| --- | --- | --- |
| KV 写入 | 1000 次/天 | 常规一次签到 **4 次**（抢锁 / 明细 / 索引 / 解锁）+ **1 次**进度标记；命中淘汰的 run 再多一次 |
| KV 读取 | 100,000 次/天 | Cron 每次触发 1 次（读 accounts）；有账号到点时那几轮再多 1~2 次；面板首屏约 4 次，轮询每次 3 次 |
| Worker 请求 | 100,000 次/天 | 每天 **96 次 Cron**（每 15 分钟）+ 你自己开面板的次数 |

Cron 从「每天 1 次」变成「每天 96 次」，但绝大多数触发**只读 1 次 `accounts` 就返回**（没有账号落在当前小时），不写 KV、不碰上游。真正签到的那一轮仍然是 4~5 次写，10 个账号也一样（批量写集中在一次收尾，循环里零写入）。导入 N 个账号只写 **1 次**（整批一次 `putAccounts`），导出与额度查询各 **0 次**。

**调低「日志保留条数」时的一次性开销**：保存设置的那一刻会立即清理超额的旧记录（先删明细、再写回裁剪后的索引），所以那一次 `PUT /api/settings` 会产生 `N+1` 次写入（N = 被清理的条数）。这就是面板可能提示「设置已保存，同时清理了 N 条旧记录」的原因。这样做是为了让后续每次 run 最多只淘汰 1 条、稳定在 4~5 写，而不是攒到下一次 run 一次删几十条。

**PBKDF2 为什么是 30000 迭代而不是 10 万**：免费版单个请求 CPU 上限 10ms，`deriveBits` 跑 10 万迭代大概率触发 `1102`（CPU 超限）导致登录必失败。迭代数写在哈希记录里（`config:auth.iterations`），以后升级到付费版可以逐条提高，不影响老记录。

</details>

<details>
<summary><b>🔐 安全权衡（请务必阅读）</b></summary>

1. **token 明文存放在 KV**。能读你 KV 的人就能看到 token。这是为了「一次读取全部账号、省读次数」而做的取舍；如需要可自行加密后再存。
2. **单管理员、单 MCP Key**。没有多用户、没有细粒度权限，面板密码只有一套。
3. **登出是无状态的**：只清 Cookie，被复制的 Cookie 在 `exp` 之前仍然有效。唯一能全量失效的手段是**修改密码**（会 bump `sessionVersion`，旧会话立即失效）。
4. **限流只在 isolate 内存里**：多边缘节点各自计数，理论上可被绕过；做全局限流需要 KV 写，会破坏写入预算，因此没有做。
5. **CORS 未开启**：面板与 API 同源部署，写操作还会校验 `Origin`/`Referer`；MCP 走独立的 Bearer Key，不受同源限制。
6. **`SETUP_TOKEN` 建议一定要配**，否则存在「被抢先初始化」的风险。
7. **导出的 JSON 含明文 token**：与 KV 里的存储方式一致，拿到文件等于拿到账号；卡片内单账号导出与顶部「导出全部」都会二次确认，请勿放进 Git、网盘公开链接或聊天记录。
8. **上游请求头能被上游识别出「来自 Worker」，且无法消除**。所有出站 `fetch` 会被 Cloudflare 强制追加 `cf-worker: <worker 名>`（本地实测：`cf-workers-wbdaily.example.com`；生产是 `<worker>.<子域>.workers.dev`），这个头**不能通过 headers 删除**。也就是说：UA、`Origin`、`Accept` 伪装得再完整，上游只要看这一个头就知道流量来自 Workers。本项目已把其余头对齐官方 Web 客户端（见下节），但如果上游是按「来源是否 Cloudflare Worker」处置，请求头层面无解 —— 唯一出路是自建中转，并用 `UPSTREAM_BASE_URL` / `CREDITS_BASE_URL` / `REFRESH_BASE_URL` 指过去。
9. **TLS / HTTP2 指纹无法伪造**：Workers 的出口握手特征与 Chrome 完全不同。因此项目**没有**堆砌 `sec-ch-ua`、`sec-fetch-*` 这类只有真浏览器才有的头 —— 「自称 Chrome、TLS 不像、还带 cf-worker」的组合比朴素请求更违和。

</details>

<details>
<summary><b>🧬 上游请求头对齐</b></summary>

签到 / 额度 / token 续期三条链路的请求头由 `src/upstream-headers.js` 统一构造，避免同一账号在不同接口呈现不同特征：

| 头 | 值 | 说明 |
| --- | --- | --- |
| `accept` | `application/json, text/plain, */*` | 与官方 Web 客户端一致 |
| `accept-language` | `zh-CN,zh;q=0.9` | 同上 |
| `content-type` | `application/json` | body 恒为 `{}` |
| `authorization` | `Bearer <access_token>` | |
| `user-agent` | Chrome 131 / Windows | 浏览器基线，已验证可用 |
| `origin` / `referer` | `https://copilot.tencent.com` | |
| `x-user-id` | 账号 `uid` | **有值才发** |
| `x-enterprise-id` / `x-tenant-id` | 账号 `enterpriseId` | 同上，两个头同值 |
| `x-domain` | 账号 `domain` | 同上 |
| `x-refresh-token` / `x-auth-refresh-source` | 仅续期接口 | 后者固定 `plugin`，缺失会被网关判定为其它 client |

空值**不发空串**：`X-User-Id: ` 这种空头比不带更容易被判异常。业务头的取值来源是账号记录，从 cockpit-tools 导入时 `uid` / `enterpriseId` / `domain` 会被一并保留。

</details>

<details>
<summary><b>🗄️ 数据存储（KV 键一览）</b></summary>

全部数据在 **1 个 KV 命名空间**（`WB_KV`）里，共 8 类键（其中 `log:run:{runId}` 每个 run 一个，条数受「日志保留条数」限制）：

| 键 | 内容 |
| --- | --- |
| `config:auth` | 管理员密码哈希、会话密钥、`sessionVersion` |
| `config:settings` | 日志保留条数 `retentionRuns`（签到时间不在这里，见 `accounts`） |
| `config:mcp` | MCP Key 的 sha256（不存明文） |
| `accounts` | 账号数组（token 明文，最多 10 个）；每项含 `checkinHour`（北京时间整点）、`refreshToken`、`enterpriseId` |
| `log:index` | 执行记录索引（倒序，≤ 保留条数） |
| `log:run:{runId}` | 单次执行明细（≤ 64KB，超出自动截断） |
| `lock:run` | 互斥锁（TTL 300s） |
| `checkin:day` | 当日签到进度 `{date, accounts:{id:{result,at}}}`，只记成功；cron 后 3 轮靠它零写短路，跨天自动作废 |

</details>

<details>
<summary><b>📁 目录结构</b></summary>

```
.
├── src
│   ├── index.js      Worker 入口：/api 与静态资源分流、Cron 触发
│   ├── router.js     路由匹配、同源校验、JSON body 解析、requireAuth
│   ├── util.js       响应信封 / 错误码 / 脱敏 / 编码 / 常量时间比较 / ID
│   ├── auth.js       PBKDF2 密码、HMAC 会话 Cookie、内存限流器
│   ├── store.js      createContext 装配点 + KV 读写封装 + 写计数
│   ├── checkin.js    上游签到客户端（10s 超时、两段式签到、9 类错误归一）
│   ├── credits.js    上游额度客户端（积分配额四分组、只读、零 KV 写）
│   ├── account-io.js 账号 JSON 导入/导出（cockpit-tools 兼容）
│   ├── logger.js     run 内存日志缓冲 + 64KB 截断汇总
│   ├── run.js        签到编排：抢锁 → 串行执行 → 收尾落盘 → 解锁
│   ├── api.js        22 条 REST 路由 + 可复用的服务函数
│   ├── schedule.js   签到调度纯函数：北京时区换算、每账号小时判定与自动错开、当日进度合并
│   ├── upstream-headers.js 上游请求头唯一事实来源（签到/额度/续期共用）
│   ├── upstream-token.js   access_token 生命周期：JWT exp 判定 + refresh 续期 + 回写
│   └── mcp.js        MCP JSON-RPC 分发 + 5 个工具
├── public
│   ├── index.html    三态视图骨架（setup / login / panel）
│   ├── app.js        单 state + 全量 render、API 客户端、轮询
│   └── styles.css    深色主题、卡片、徽标、移动端单列
├── wrangler.toml     Worker、assets、KV 绑定、Cron、环境变量
└── package.json
```

</details>

## License

[MIT](./LICENSE)

## 致谢

积分配额接口的路径、字段与分组规则参考了 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)（CC BY-NC-SA 4.0），仅参考接口事实、未复制其源码；商用前请自行评估上游接口与参考项目的许可约束。
