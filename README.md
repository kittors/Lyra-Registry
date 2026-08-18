# Lyra Registry

[Lyra](https://github.com/kittors/Lyra) 的插件、MCP 服务和技能集合目录。一个 Cloudflare Worker，管索引、构建、审核和分发。

不是一份 JSON 索引。**每个条目都由平台从源码构建**：拉仓库、读内容、数出到底有几个技能、打成规范化的包、算哈希、存进 R2。所以目录上写的「8 个技能」是数出来的，不是抄来的；而下载下来的包能对哈希，装之前就知道拿到的是不是我们构建的那一份。

## 它解决什么

上一版市场是 `Lyra-Plugins` 仓库里两份 GitHub Action 生成的 JSON，客户端直接抓 `raw.githubusercontent.com`。够用，直到不够用：

| 问题 | 现在 |
| --- | --- |
| `raw.githubusercontent.com` 限流，返回 429 | 走 Cloudflare 边缘，带缓存 |
| 安装靠 `git clone`，上游挂了就装不上 | 包在 R2 里，带 sha256；git 作为回退 |
| 装之前不知道里面有什么 | 构建时数出技能数和服务数，写进目录 |
| 加条目要改 JSON 提 PR | GitHub 登录，填仓库地址，自助提交 |
| 没有搜索、分类、统计 | 都有 |
| 图标直连 GitHub，访问不了就是一片灰块 | 平台代理并缓存 |

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

Worker 在 `http://localhost:8787`，站点已经构建好一起served。改前端要热更新的话另开一个：

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

需要 Cloudflare 的 D1、R2、Workers 权限。

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
| `GET /v1/icon/:id` | 图标，平台代理并缓存 |
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

## 三种东西

| kind | 是什么 | 装到哪 |
| --- | --- | --- |
| `plugin` | 一组技能，可能带清单 | `~/.lyra/plugins/<id>/` |
| `mcp` | 一个 `.mcp.json` 里的服务声明 | `~/.lyra/mcp/<id>/`，并写进设置 |
| `skill` | 一层 `SKILL.md` 目录 | 平铺进 `~/.lyra/skills/`，带 `<id>-` 前缀 |

判定规则和 Lyra 客户端的 `inspectBundle` 逐条对齐——有技能就是插件，只有服务声明才是 MCP，技能集合永远不靠猜。索引里写的 `kind` 只是一个**声称**，构建时会按实际内容纠正，并把纠正告诉提交者。

## 每日同步

Cron 每天跑一次。对每个条目先问一句「HEAD 指向哪个 commit」——40 字节，没变就跳过，不下载任何东西。变了才重建。

拿不到 commit 时记为**失败**而不是「没变」。这两者只在被限流的时候有区别，而那正好是所有条目一起看起来没变的时候。

## 许可

MIT
