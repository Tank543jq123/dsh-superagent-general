# dsh-superagent-general

**简体中文** | [English](README.en.md)

> 面向团队的通用 DSH SuperAgent：从 **GitHub、飞书、微信** 接收受权请求，按 Policy 判断是否接单，在独立的 DSH Worker Session 中执行，并把结果送回原对话。

本仓库是原 `dsh-superagent` 的升级发布版：保留我们原有的**微信来源**与**可配置沙箱**，引入 [SuperAgent-General](https://github.com/comeonzhj/SuperAgent-General) 的通用产品层（中文提示词、飞书应用 SDK、面板与语言、关键词过滤、完整测试）。领域内核 `src/core` 仍与官方原型基线 `8c32a9d` 一致。

## 这是什么

`dsh-superagent-general` 是一个 DSH（DeepSeek Harness）插件，不是另一个独立 Agent 框架：

- **三种来源**：GitHub 用于跟踪和评审；微信用于可信的日常指令；飞书可选，走应用 SDK 长连接。
- **两层准入**：代码层的名单、准入表、关键词先过滤；模型只在 Policy 规则内做研判。
- **授权即数据**：接受请求时生成不可变的 Mandate，记录来源、范围、命中规则与 Policy 版本；Worker 只受它约束。
- **一单一 Session**：每个工单有自己的 DSH Worker Session 和目录，报告通过持久发件箱回到来源对话。
- **可恢复**：Effects、Outbox、SQLite 与工单阶段一起保证重启、退避和人工介入后的恢复。
- **原生面板**：概览、来源、触发、评估、执行、关于、设置；任务详情可打开真实 Worker 会话。

## 快速开始

### 环境

- Node.js `^22.19.0` 或 `>=24`
- pnpm `11.7`
- DSH `0.2.1-alpha.2` 兼容范围（见 `package.json`）
- GitHub 操作需要 `gh`；微信/飞书为可选来源

### 安装

```sh
git clone https://github.com/Tank543jq123/dsh-superagent-general.git
cd dsh-superagent-general
pnpm install
pnpm check                         # typecheck + tests + build
pnpm pack --pack-destination dist  # 生成可安装的 .tgz
```

在 DSH 插件页安装 `dist/dsh-superagent-0.2.2.tgz`，启用 bundle `dsh-superagent`，然后重启对应的 DSH profile。

### 配置

在 profile 的 patch 里给出部署级设置：

```yaml
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/superagent-data
    # read-only | workspace-write | danger-full-access
    permissionPreset: workspace-write
```

首次打开侧边栏 **SuperAgent**，按顺序配置：

1. **来源**：GitHub（仓库、执行账号）、微信（扫码登录、是否接收私聊/群聊）、飞书（APP_ID/APP_SECRET，需先启用 `dsh-superagent-feishu`）。
2. **策略**：允许发起工作的人、接收范围准入表、关注/忽略关键词。
3. **评估**：默认 `observe` 只记录研判；确认行为符合预期后再切 `auto`。
4. **执行**：Worker 模型、并发数、任务目录、prepare 命令与命令限制。
5. **提示词**：团队沟通/范围/交付要求，以及按需加载的团队技能。

### 使用

- 在面板查看 **概览**：待人工、系统问题、执行器负载、24 小时流量。
- 在微信里给机器人发一条指令，或在 GitHub Issue/PR 里 @ 执行账号；新请求会生成候选，Router 判断后创建工单。
- 工单详情可以打开真实的 `worker-…` Session，查看推理、工具调用和交付过程。
- 结果通过来源对话返回；长任务、阻塞、需要决策时使用结构化报告与 `human_action`。

### 微信入口

微信来源默认只接收**账号所有者私聊**，作为可信指令入口；群聊默认关闭。第一次使用在“来源 → 微信”点“扫码登录”，或运行：

```sh
node scripts/weixin-login.mjs --state-dir /absolute/path/to/superagent-data
```

绑定文件保存在 stateDir，权限 `0600`，不进入仓库或模型上下文。

### 飞书（可选）

飞书插件默认关闭。需要时：

1. 在“来源 → 飞书”填写 `APP_ID` / `APP_SECRET` 并保存；密钥单独存 `feishu-credentials.json`，权限 `0600`。
2. 在 profile 覆盖 `dsh-superagent-feishu` 的 `disabled: false`。
3. 在飞书后台开启机器人、长连接、接收消息事件与相应权限，发布应用。
4. 重启并检查 health；真实收发需要自己的应用权限完成联调。

## 三种来源

| 来源 | 入口 | 典型用途 | 默认 |
|---|---|---|---|
| GitHub | Issue / PR 评论、CI、审查 | 代码修改、评审、交付 PR | 开启 |
| 微信 | 所有者私聊、可选群聊 | 调研、写作、翻译、文件、开发指令 | 开启 |
| 飞书 | 私聊、群聊、话题线程 | 团队协作与飞书文档/知识库 | 关闭，配置后启用 |

## 关键设计（简版）

- **Gate + Eval**：代码判“谁能发起、强度多少”；模型在 `Eval` 里判“值不值得做”。`off / observe / auto` 三档渐进上线。
- **Mandate**：接受即生成不可变授权，记录 `basis`、规则、Policy 版本；人工停止可撤回，策略失效可重校验。
- **订阅直通**：已有工单的后续消息直接进入 Worker，不再重复评估；越界请求交回 Router。
- **Effects + Outbox**：事务内入队、提交后执行；幂等、保序、退避、健康上报。
- **按“在等谁”分阶段**：`person / working / idle / ended`，面板、重试、通知共用同一判定。
- **SourceKind 协议**：新增来源要带配置表单、准入、评估上下文、回执和健康，而不是只加一个 fetch。

完整设计见 [`docs/000-008`](docs/000-philosophy.md) 与 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 从哪来：开发路径

本仓库不是从零重写，也不是把 General 整仓覆盖；它是一条可复核的三方移植路径：

| 时间 | 仓库 / 提交 | 发生了什么 |
|---|---|---|
| 2026-10-31 | [`deepseek-ai/dsh-superagent-prototype` @ 8c32a9d](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) | 官方原型基线：Engine、Router/Worker、授权、订阅、Effects/Outbox、原生面板 |
| 2026-11-04/05 | [`comeonzhj/SuperAgent-General` @ aedd8ff](https://github.com/comeonzhj/SuperAgent-General) | 同一基线的兄弟 fork：通用中文产品层、飞书 SDK、面板/语言、关键词、完整测试 |
| 2026-11-05→07 | 原 `dsh-superagent` 本地版本 / `d97463a` | 并行加入微信 Source、`permissionPreset` 沙箱、微信登录脚本、测试与文档；11 月 7 日冻结 |
| 2026-11-07 | 提交 `fa31795` → `509329e`，tag `general-v0.2.2-port` | 以 `8c32a9d` 为共同基线做主题级三方移植；保留微信与沙箱，采用 General 产品层 |
| 现在 | [`Tank543jq123/dsh-superagent-general`](https://github.com/Tank543jq123/dsh-superagent-general) | 公开的升级发布版（main + tag + 回滚分支） |

为什么不用 `git merge`：两个仓库没有共同提交历史（General 的首个提交是独立根提交），`merge` 需要 `--allow-unrelated-histories`，冲突面等于整棵树，容易把本地的微信和沙箱改动覆盖掉。实际做法是用 `git diff 8c32a9d <general-commit> -- <paths>` 生成主题补丁，逐项合并、逐项测试。完整记录见 [`docs/009-general-upgrade.md`](docs/009-general-upgrade.md)。

### 采用了什么

- General 的通用中文提示词、团队三段、飞书/GitHub 技能、Worker 授权措辞。
- 飞书应用 SDK：凭证、长连接事件、API 读取门面、面板密钥处理。
- 面板信息架构、中英文文案、对应客户端测试。
- 正/负关键词过滤，并纳入 Policy 版本。
- General 的测试套件与产品文档。

### 保留了什么

- 微信 Source 与 `./weixin-watch` 入口（我们的可信指令通道）。
- `permissionPreset`：默认 `workspace-write`，不再硬编码 `danger-full-access`。
- 包身份 `dsh-superagent`、原 `docs/000-008` 与 `SETUP.md`。
- 已保存的团队提示词覆盖（见“验证与边界”）。

### 没有采用什么

- General 的包名/版本与删除编号文档的做法。
- General 的 `supervise.ts` watchdog（本分支由部署环境负责进程守护）。
- `legacy-import` 的自动接线（保留为可测试的独立迁移助手，但 Runtime 不调用）。
- 默认启用飞书（本仓库默认关闭，避免没有凭证时产生 setup 问题）。

## 与 `comeonzhj/SuperAgent-General` 的区别

| 维度 | SuperAgent-General | 本仓库 |
|---|---|---|
| 定位 | 通用中文任务产品 | 通用任务 + 微信可信入口 |
| 来源 | GitHub + 飞书 SDK | GitHub + 飞书 SDK + **微信** |
| 沙箱 | 继承原型的 `danger-full-access` | `permissionPreset`，默认 `workspace-write` |
| 包名 | `dsh-superagent-general` | `dsh-superagent`（保持 profile 兼容） |
| 设计文档 | 4 篇产品文档，移除 000-008 | 保留 `docs/000-008` + `SETUP.md`，新增 009 升级记录 |
| 飞书 | 默认启用 | 代码完整，插件默认关闭，配置后启用 |
| 运维 | 含 watchdog / 旧配置导入 | watchdog 移除；legacy import 未接线 |
| 提示词 | General 中文默认 | General 内置角色 + 已保存的团队三段覆盖 |
| 测试 | General 套件 | 合并后 62 文件 / 1197 测试 |

## 与原 `dsh-superagent` 的关系

| 维度 | 原版本 | 本仓库 |
|---|---|---|
| 基线 | `8c32a9d` | 同一基线 |
| 微信 | 有 | 保留 |
| 沙箱 | `permissionPreset` | 保留，默认 `workspace-write` |
| 产品层 | 偏 GitHub/PR 的编码 Agent | 采用 General 通用产品层 |
| 飞书 | CLI 模式，默认关闭 | 应用 SDK，默认关闭，按需启用 |
| 包身份 | `dsh-superagent` | 保留 |
| 文档 | 000-008 + SETUP | 保留并新增 009 |

## 验证与边界

本仓库当前验证：

- `pnpm check`：62/62 测试文件、1197/1197 测试、类型检查、ESM + client 构建通过。
- 重启后的 DSH 服务 health：runtime、weixin、github、models、evals、relay、notice、launch、delivery、assessment、reply 共 11 项 ready。
- 独立测试 Agent 复核 READY；独立审查发现的安装指南/迁移/守护矛盾已修正。

已知边界：

- **飞书只做了代码级验证**：真实收发需要 `APP_ID`/`APP_SECRET`、应用权限和自己的飞书应用，插件默认关闭。
- **提示词是混合形态**：General 的内置角色和默认段已生效，但 profile 中保存的团队三段仍是自定义文本（含交付/评审约束）。要完全采用 General 默认，在面板恢复团队三段后保存。
- **面板 UI** 只验证了 API/health，未做截图级视觉检查；请在自己的 DSH 中打开确认。
- **旧配置不会自动迁移**：`legacy-import` 未接入 Runtime；旧 `settings.json` 需手工迁移。
- 本仓库基于研究原型做产品化适配，不是 DeepSeek 官方产品；使用前请按自己的权限、团队和合规要求验证。

## 回滚

```sh
# 本地回滚到升级前
git switch main
git reset --hard pre-general-main      # = 8c32a9d
pnpm install && pnpm check && pnpm build
# 重启 DSH profile
```

- 升级提交：`509329e`；tag：`general-v0.2.2-port`。
- 回滚分支：`pre-general-main`（8c32a9d）。
- 远端：`Tank543jq123/dsh-superagent-general`；如需团队远端，请替换 remote 后推送。
- 回滚前保留旧的 `lib/` 或安装包，避免同时重建和重启。

## 许可与致谢

MIT License。上游版权与许可见 [LICENSE](LICENSE)。

- 官方原型：[DeepSeek Harness Team / dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- 通用产品层：[ZhangJia (comeonzhj) / SuperAgent-General](https://github.com/comeonzhj/SuperAgent-General)
- 本仓库的微信来源、`permissionPreset` 与移植整合：本 fork 维护者

如果这个页面有帮助，欢迎直接读 [`SETUP.md`](SETUP.md) 按步骤配置，或在 Issue 里说明你的场景。
