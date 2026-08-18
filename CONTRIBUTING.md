# 参与开发

## 提交一个插件 / MCP 服务 / 技能集合

**不用改这个仓库。** 去站点上登录，填仓库地址，提交。平台会把它拉下来构建一遍，当场告诉你能不能装、里面有几个技能。

要改的只有你自己那个仓库。

## 改这个平台

```bash
pnpm install
pnpm db:migrate:local
pnpm dev            # Worker，8787
pnpm dev:web        # 站点，5173，API 代理到 8787
```

`packages/api/.dev.vars` 里放 `SESSION_SECRET` 和 `GITHUB_TOKEN`（见 README）。这个文件已经在 `.gitignore` 里，别把它提交上来。

改完必须三条全过：

```bash
pnpm check
```

### 三条全过不等于做完了

类型自洽只证明类型自洽。凡是用户看得见的改动，**在跑起来的东西上量一遍**，量到具体的数——这个仓库自己就踩过：

- 图标接上了、类型干净、`curl` 也能拿到图片，而浏览器里整个目录是一片灰块。原因是它直连 `github.com`，而看的人到不了 GitHub。任何静态检查都不会报这个。
- 给子路径条目补 README 回退，Waza 拿到了正确的 README，Context7 拿到的却是「Lyra Plugins：一份索引，一个格式说明」——一个自信的错误描述，比没有描述更糟。
- 手工签一个会话去提交，撞出 `FOREIGN KEY constraint failed`。看起来是测试造的，其实是真的：会话有一周有效期，而那一行的存在只在登录回调里写过一次。

怎么算量一遍：读 `getComputedStyle`、比对哈希、数返回的行数。**「看起来对」不是结论。**

**断言失败先怀疑断言。** tar 的测试第一次失败是因为 macOS 的 bsdtar 会往归档里塞 AppleDouble 元数据文件，不是解析器错了。

没条件验证的部分，交付时**明说哪一步没验**。

## 硬约束

- **缩进 tab**，YAML / JSON 用 2 空格
- **注释用英文，解释为什么**，不复述代码做了什么
- **单文件尽量 300 行以内**，但拆分要有真实边界
- **不要提交任何密钥**
- 改了行为就补测试

## 两条不变量

**一、`packages/shared` 是契约，Lyra 客户端也读同一份。**

改 `RegistryEntry` 的形状、改 `normalise` 的接受范围、改 `normalisePath` 的拒绝规则，都是在改一个**已经发出去的**客户端依赖的东西。加字段（可选）永远安全；改语义不是。

**二、平台的判定必须等于客户端的判定。**

`packages/api/src/build/inspect.ts` 和 Lyra 的 `inspectBundle` 回答同一个问题：这个目录是插件、MCP 服务，还是技能集合。两边分岔的后果是目录上写着插件、装出来是 MCP 服务，而两边的单测都会通过——各自测的是各自对规则的理解。

所以改了任何一边的判定规则，跑这个：

```bash
cd packages/api
LYRA_REPO=../../Lyra GH_TOKEN=$(gh auth token) node --experimental-strip-types scripts/crosscheck.ts
```

它拿平台真实构建出来的包，解开，喂给客户端**自己的**代码，比对结论。

## 容易踩的坑

- **`node --experimental-strip-types` 不处理 `node_modules` 里的 TS**，但 pnpm workspace 是 symlink，realpath 之后不在 `node_modules` 下，所以能跑。这也是 `packages/shared` 不需要构建步骤的原因。
- **Worker 代码和测试用不同的 tsconfig**。`tsconfig.json` 只管 `src`，types 是 `@cloudflare/workers-types`；`tsconfig.test.json` 管测试，types 是 `node`。这不是麻烦，是约束：Worker 代码里 `node:fs` 应该连编译都过不去。
- **`DecompressionStream` 在两套类型里签名不同**，`pipeThrough` 因此对不上。已经收敛在 `pipeline.ts` 的 `through()` 里，别在别处再写一遍 cast。
- **codeload 的 tarball 顶层目录是 `<repo>-<ref>`，不是 `<repo>-<sha>`。** commit 得单独问，用 `Accept: application/vnd.github.sha`，40 字节。
- **目录 API 有 60 秒边缘缓存。** 本地调试时页面「没更新」通常是这个，不是代码没生效。
