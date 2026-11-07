# SuperAgent

## 职责

以官方原型的完整实现提供通用 SuperAgent。core 管理 Trigger、Thread、Eval、Ticket、Assignment、Subscription；app 装配持久化、Effect、Outbox、提示词和管理 API；executor 与 sessions 驱动 DSH Router/Worker；sources 适配入口；client 提供 DSH 原生面板。宿主的工具、模型、会话底层由 DSH 提供。

## 公开接口

index.ts 导出 Cordis 插件 apply/Config 与 core 的公开接口；sources/kind.ts、sources/host.ts 定义 Source 扩展接口；client/index.tsx 为 DSH 客户端入口。外部调用遵循这些接口。内部边界沿用原型，不增设平行编排逻辑。

## 依赖与约定

依赖 package.json 中的 DSH peer 包、官方飞书 SDK、SQLite、React。核心概念和状态语义见 ../docs/ARCHITECTURE.md；适配记录见 ../docs/UPSTREAM.md。默认中文、默认概览、配置标签最后，所有执行任务使用 DSH Worker Session。

飞书 SDK 传输层对数组查询参数使用重复同名编码；订阅轮询沿用原型规则，成功补查会自动清除线程的旧轮询错误。

提示词的读取角色、规则派工范围与来源技能协议见 [配置说明](../docs/PROMPTS.md)。公共提示按通用目标执行；来源技能保留平台衔接要求，具体团队流程由用户配置。
