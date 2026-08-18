# Agent 市场

**https://lyra-registry.gj7nrhnb9j.workers.dev**

给 **Claude Code、Codex、Pi、Lyra** 装 skill、MCP 服务和插件。一个 Cloudflare Worker，管索引、构建、审核和分发。

这不是某一个客户端专属的市场，而这一点是**格式决定的**，不是我们宣称的：`SKILL.md` 是 Claude Code 立下的约定，Codex、Pi、Lyra 都在读同一套；`.mcp.json` 描述的是 MCP 服务，而 MCP 是有很多客户端的协议。一个技能目录确实能装进上面每一个。真正不通用的只有插件清单——`.claude-plugin/` 和 `.lyra-plugin/` 各是一家的格式。

所以**每个条目能装进哪些客户端，是从包里读出来的**，和 `kind` 一样，不接受作者声明。

也不是一份 JSON 索引。**每个条目都由平台从源码构建**：拉仓库、读内容、数出到底有几个技能、打成规范化的包、算哈希、存进 R2。所以目录上写的「8 个技能」是数出来的，不是抄来的；而下载下来的包能对哈希，装之前就知道拿到的是不是我们构建的那一份。

## 它解决什么

上一版市场是 `Lyra-Plugins` 仓库里两份 GitHub Action 生成的 JSON，客户端直接抓 `raw.githubusercontent.com`。够用，直到不够用：

| 问题 | 现在 |
| --- | --- |
| `raw.githubusercontent.com` 限流，返回 429 | 走 Cloudflare 边缘，带缓存 |
| 安装靠 `git clone`，上游挂了就装不上 | 包在 R2 里，带 sha256；git 作为回退 |
| 装之前不知道里面有什么 | 构建时数出技能数和服务数，写进目录 |
| 加条目要改 JSON 提 PR | GitHub 登录，填仓库地址，自助提交 |
| 没有搜索、分类、统计 | 都有 |
| 图标直连 GitHub，访问不了就是一片灰块 | 平台代理并缓存进 R2，也可以在后台手动换 |
| 只服务一个客户端 | 每条标出能装进哪些客户端，可按客户端筛选 |

## 结构

```
packages/
  shared/   契约：索引格式、API 形状、路径安全检查。纯类型和纯函数，客户端也用同一份
  api/      Cloudflare Worker：目录 API、构建流水线、OAuth、审核、每日同步
  web/      站点与管理后台：React + Vite，作为 Worker 的静态资源一起部署
```

站点和 API 是**同一个 Worker**。同源，所以站点调自己的 API 不需要 CORS，会话 cookie 直接带上。

## 跑起来

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

Worker 在 `http://localhost:8787`，站点作为它的静态资源一起提供。改前端要热更新的话另开一个：

```bash
pnpm dev:web
```

站点在 `5173`，`/v1` 和 `/auth` 代理到 8787，后面是真的 Worker、真的 D1、真的 R2。

### 本地密钥

`packages/api/.dev.vars`（已 gitignore）：

```
SESSION_SECRET=随便一串长的
GITHUB_TOKEN=ghp_...
```

`GITHUB_TOKEN` **不是可选的**。未认证的 GitHub 每小时只给 60 次，而且是按 IP 算的——Worker 的出口 IP 和同机房所有租户共用，那个额度实际上是别人的。开发时用 `gh auth token` 就行。

## 检查

```bash
pnpm check     # lint + typecheck + test
```

还有一个需要网络的交叉验证，它拿平台构建出来的包，喂给 Lyra 客户端**自己的**那份判定代码：

```bash
cd packages/api
LYRA_REPO=../../Lyra GH_TOKEN=$(gh auth token) node --experimental-strip-types scripts/crosscheck.ts
```

这是整套系统最重要的一条不变量：**平台说它是什么，客户端装出来就得是什么**。两边各有各的单测，但各自测的是自己对规则的理解——只有这个脚本能发现两边的理解已经分岔。

## 部署

先确认 token 够用：

```bash
CLOUDFLARE_API_TOKEN=… pnpm check:cf
```

它逐个探测要用到的资源，缺哪个就告诉你去补哪一条权限。全绿之后：

```bash
npx wrangler d1 create lyra-registry          # 把返回的 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create lyra-registry
npx wrangler kv namespace create CACHE        # 同样把 id 填进去

npx wrangler secret put SESSION_SECRET
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_TOKEN

pnpm db:migrate
pnpm deploy
```

### token 需要哪些权限

在 Dashboard → 右上角头像 → **My Profile → API Tokens** 里编辑（或新建）token，**Account 级别**勾这四条：

| 权限 | 用来做什么 |
| --- | --- |
| `Workers Scripts : Edit` | 部署 Worker 本身，以及站点这批静态资源 |
| `D1 : Edit` | 建库、跑迁移、读写目录 |
| `Workers R2 Storage : Edit` | 存包和图标 |
| `Workers KV Storage : Edit` | 边缘缓存 |

都是 **Account** 那一栏，不是 User，也不是 Zone——这是最容易勾错的地方。

**R2 还要先开通一次**：Dashboard → R2 → Overview，按提示绑定支付方式。免费额度是 10GB 存储加每月一百万次读，这个平台的用量远在额度里，但不开通的话账号上就没有 R2 这个产品，权限勾了也没用。

`wrangler.jsonc` 里的 `GITHUB_CLIENT_ID`、`ADMIN_LOGINS`、`PUBLIC_URL` 是公开配置，直接改。`ADMIN_LOGINS` 空着表示**没有人**是管理员——这比默认让第一个登录的人当管理员安全。

GitHub OAuth App 的回调地址填 `<PUBLIC_URL>/auth/callback`。

## API

公开的部分不需要认证，带 CORS，可以直接给客户端用。

| 路径 | 说明 |
| --- | --- |
| `GET /v1/entries` | 目录，支持 `q` `kind` `category` `sort` `page` |
| `GET /v1/entries/:id` | 详情，含 README 和版本历史 |
| `GET /v1/index` | **旧格式索引**，见下 |
| `GET /v1/download/:id` | 当前版本的包，302 到带版本号的地址 |
| `GET /v1/download/:id/:version` | 包本身，响应头带 `x-lyra-sha256` |
| `GET /v1/icon/:id` | 图标，平台代理并缓存；后台上传过的优先 |
| `GET /v1/categories`、`/v1/stats` | 分类与统计 |

`/v1/index` answers 的是**文件版市场的格式**（`{ name, plugins: [...] }`），也就是一个放在 GitHub 仓库里的 `registry.json` 长的样子。这样已经发出去的客户端不用升级就能把源指过来。`?kind=skill` 会用 `collections` 这个字段名，因为技能源在客户端里是分开配置的。

## 发布一个条目

登录后在站点上填仓库地址就行，或者：

```bash
curl -X POST https://<你的部署>/v1/entries \
  -H "Authorization: Bearer <会话>" -H "content-type: application/json" \
  -d '{"repository":"https://github.com/owner/name","path":"plugins/thing"}'
```

名称、描述、图标、作者、版本、有几个技能——全部从仓库里读。读不出来的才需要你填。

**技能集合必须显式声明 `"kind":"skill"`。** 插件和 MCP 服务能从内容判断出来（有没有技能、有没有 `.mcp.json`），但一层 `SKILL.md` 目录和插件的 `skills/` 目录长得完全一样，光看是分不出来的。

提交之后是 `pending`，管理员通过了才出现在目录里。

## 维护后台

`/console`，只有 `ADMIN_LOGINS` 里的账号能进——**其他人访问它得到的是 404，不是「无权限」**，因为后者等于确认了这个页面存在。导航里也不会出现。

后台能改的只有**展示**：名称、描述、分类、图标、品牌色、排序权重。改不了类型、技能数、兼容的客户端——那些是从包里读出来的事实，能覆盖它们就等于能发布一条关于别人代码的假声明。

每个手动改过的字段会被记进 `curated`，**每日重建不会覆盖它**。这条规则值得写清楚，因为它是「能编辑」这件事成立的前提：

> 推导出来的，重建时刷新；人写下的，重建时保留。

把某个字段清空就是放弃这次覆盖，让它回到自动读取的值。图标同理，「恢复默认」会回到仓库 owner 的 GitHub 头像。

## 三种东西

| kind | 是什么 | 谁能装 |
| --- | --- | --- |
| `skill` | 一层 `SKILL.md` 目录 | Claude Code、Codex、Pi、Lyra——这是可移植的那种 |
| `mcp` | 一个 `.mcp.json` 里的服务声明 | 任何 MCP 客户端 |
| `plugin` | 一组技能，带某一家的清单 | 看清单是谁的格式 |

技能落到各家自己的目录：

| 客户端 | 目录 |
| --- | --- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi | `~/.pi/skills/` |
| Lyra | `~/.lyra/skills/` |

MCP 服务按各家的配置方式加（Lyra 是写进「设置 › MCP」）。

每条还会标出**能装进哪些客户端**，同样从内容推导：有 `SKILL.md` 就是可移植的，Claude Code / Codex / Pi / Lyra 都能装；有 `.mcp.json` 就标成「任何 MCP 客户端」，而不是列举五个——那会让第六个看起来不支持；插件清单只在它**确实是插件**时才算数（Context7 有一个 `.lyra-plugin/` 目录，里面只是名字和图标，把它当证据会让一个 MCP 服务被标成 Lyra 插件）。

判定规则和 Lyra 客户端的 `inspectBundle` 逐条对齐——有技能就是插件，只有服务声明才是 MCP，技能集合永远不靠猜。索引里写的 `kind` 只是一个**声称**，构建时会按实际内容纠正，并把纠正告诉提交者。

## 每日同步

Cron 每天跑一次。对每个条目先问一句「HEAD 指向哪个 commit」——40 字节，没变就跳过，不下载任何东西。变了才重建。

拿不到 commit 时记为**失败**而不是「没变」。这两者只在被限流的时候有区别，而那正好是所有条目一起看起来没变的时候。

## 许可

MIT
