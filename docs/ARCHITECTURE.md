# 架构与开发入口

本插件以官方 SuperAgent 原型为基线。来源和适配范围统一记录在 [UPSTREAM.md](UPSTREAM.md)，安装配置见 [USER-GUIDE.md](USER-GUIDE.md)。

## 一条请求的处理路径

飞书 Source 接收事件并归一化为 Trigger。原型的程序准入和关键词过滤决定哪些新候选进入 Router 的语义评估。Router 创建或关联 Ticket，由 Executor 创建工作区并启动独立 Worker Session。Worker 报告结果，Router 通过持久发件箱交付到来源对话。

同一 Thread 的后续消息沿原型订阅直通 Worker；Worker 判断继续处理、取消无关订阅或将范围外请求交回 Router。Thread 与 Ticket 的订阅关系为多对多。

## 代码职责

| 入口 | 职责 |
|---|---|
| [src/index.ts](../src/index.ts) / [cordis.patch.yml](../cordis.patch.yml) | 插件生命周期、组合包与角色预设 |
| [src/core/](../src/core/) | Trigger、Thread、Eval、Ticket、Assignment、Subscription 的领域状态与命令 |
| [src/app/runtime.ts](../src/app/runtime.ts) | 服务装配、启动与停止 |
| [src/app/sessions.ts](../src/app/sessions.ts) / [src/executor/](../src/executor/) | Router/Worker Session、持久输入、派工与报告 |
| [src/app/store.ts](../src/app/store.ts) / [src/app/effects.ts](../src/app/effects.ts) / [src/app/outbox.ts](../src/app/outbox.ts) | SQLite、提交后效果与发件箱 |
| [src/sources/](../src/sources/) | 来源接口及飞书/GitHub 适配；SDK 适配集中在 `feishu-sdk.ts` |
| [src/policy.ts](../src/policy.ts) | 原型准入、策略版本与关键词扩展 |
| [src/client/](../src/client/) | DSH 原生 React 面板、列表/详情、自动轮询和打开会话 |
| [prompts/](../prompts/) / [skills/](../skills/) | 通用要求、角色协议和可选场景技能 |
| [tests/](../tests/) | 沿用的原型测试与通用适配回归测试 |

## 扩展约定

沿用现有 Engine、Source 扩展接口和团队技能机制。场景要求作为 Worker 上下文配置；新增来源通过 SourceKind 接口接入。模块公开接口与协作约定见 [src/README.md](../src/README.md) 和 [AGENTS.md](../AGENTS.md)。

源码注释中保留的 `docs/001`、`docs/002` 等编号对应上游原型文档，链接集中在 UPSTREAM.md。它们提供设计背景，运行和构建从本仓库文件与声明的包依赖完成。

## 构建和分发

Host、客户端和守护入口由 `tsdown.config.ts` 构建到 `lib/`。客户端使用 DSH 的模块加载器及 React 服务。提示词和内置技能通过包内路径读取，打包时必须同时携带 `prompts/`、`skills/`、`locale/` 和 `cordis.patch.yml`。

DSH 包作为宿主 peer 依赖，飞书 SDK 等作为插件直接依赖。开发时安装声明的依赖；运行时由 DSH 装配宿主服务。
