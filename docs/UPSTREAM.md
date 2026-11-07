# 上游来源与适配边界

## 来源与许可

上游为 [DeepSeek Harness Team 的 dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，移植基线提交为 [`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。上游采用 MIT 许可，根目录 [LICENSE](../LICENSE) 保留原始版权与许可。

本项目将插件实现及必要资源纳入自己的源码树，构建与运行使用本仓库文件和声明的包依赖。上游完整仓库、文章附件及内部研究记录不在发布清单中。

## 适配边界

- `src/core/` 与基线逐文件一致，保留 Engine 和领域聚合、授权、订阅直通与恢复语义。
- Session、Executor、Store、Effects、Outbox、Passes、MasterAssessor 及面板主体沿用原型实现。
- 适配集中在可选 GitHub、通用默认要求、飞书 SDK 接入、凭证存储、关键词与设置体验。公共角色、主动评估与执行提示按通用任务解释，来源技能保留平台衔接协议，团队专用流程交由用户配置；Worker 的额外主动授权提示同步以接单范围约束。
- 翻译、分析、知识库维护等场景通过团队技能提供给 Worker，所有任务统一进入原型派工与会话链路。
- 保留独立进程守护，并将 SDK 的终止连接失败交回原型的退避恢复循环。

相对原型的用户可见变化见 [README](../README.md)，当前代码职责见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 上游机制说明

源码注释沿用的文档编号对应以下上游资料：

| 编号 | 上游文档 |
|---|---|
| 000 | [理念](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md) |
| 001 | [领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md) |
| 002 | [授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md) |
| 003 | [执行与恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md) |
| 004 | [提示词](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/004-prompts.md) |
| 005 | [管理面板](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/005-panel.md) |
| 006 | [部署参考](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md) |
| 007 | [原型架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md) |
| 008 | [Source 扩展](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/008-cookbook.md) |

这些文档描述上游基线。当前插件的安装、配置和限制以本项目使用指南为准。
