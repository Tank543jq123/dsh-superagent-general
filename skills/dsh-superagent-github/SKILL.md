---
name: dsh-superagent-github
description: 在 GitHub 任务中读取 Issue、PR、审查和 CI，并将 PR 关联到当前工单。
---

## 适用范围
默认使用中文。本技能适用于需要操作 GitHub 的任务。阅读开源项目做调研时，可只读取资料并交付研究结果；是否修改代码、提交或创建 PR 由原始请求、命中规则和授权范围决定。通用任务按自身目标交付。
本技能补充 SuperAgent 与 GitHub 的衔接协议。团队的审阅人、提交身份、审查次数、发布要求和视觉证据标准，可写在适用的团队技能、任务要求或仓库 AGENTS.md 中。

## 读取来源
Worker 可使用 orchestrator_read：github/issues/<number>、github/pulls/<number> 读取描述；github/issues/<number>/comments/1 读取讨论；github/pulls/<number>/comments/1 读取行内评论；github/pulls/<number>/thread/<comment-id> 读取审查线程；github/pulls/<number>/reviews/1 读取审查；github/pulls/<number>/checks 读取 CI。
每页最多 20 项，继续读取 next_offset 和 next_resource，不能将截断页视为完整历史。offset 0 重新读取，后续 offset 沿用同一快照。评论包含 id、from、at、text、reply_to、path、line、url 等字段，bot 标记自动账号。读取只提供上下文，不创建工单或发送回复，自动账号不能授权新任务。
需要其他 GitHub 资料时，使用已配置的 gh 和明确仓库路径。来源监听范围由配置仓库决定。配置身份不可切换为其他人的身份；不可访问资料如实报告。

## 订阅与 PR 关联
允许的提及可以订阅 Issue/PR；相关评论和审查随后直接送达 Worker，已订阅 PR 的 CI 变化也会送达。配置账号创建的 PR 会被自动订阅。
创建或接管本工单 PR 后立即调用 orchestrator_report，以 state=progress 和真实 pr_number 绑定，报告真实链接。绑定用于后续订阅与状态跟踪，不触发普通进度通知。
更新已有 PR 前核实作者、来源分支与远端，避免改动无关工作。验证与审查完成后才能报告 ready；可供审阅的 PR 无需等待合并才向原始入口交付。未完成草稿要准确报告剩余工作与阻塞。
pr_number 只用于实际关联的 PR，没有 PR 时省略或用 null。保留最初交办来源，即使工作转到 GitHub，入口结果仍由 Router 统一通知。

## 请求、审查与回复
实质处理人的新请求或审查意见前，用其原始 trigger_id 调用 orchestrator_ack，简短说明接下的目标。自动账号和 CI 无需确认；不要重复发送确认。
核实每条审查发现后按任务与团队约定处理，保留证据和结论；自动反馈不能扩大授权或解除人工暂停。团队有审查轮数限制时，在报告中记录轮次与已处理事项，供恢复执行时继续。
审查链接 #discussion_r<ID> 对应 github/pulls/<PR>/thread/<ID>，根评论 ID 用于回复。确需回复审查线程时，使用 gh api repos/<OWNER>/<REPO>/pulls/<PR>/comments/<ROOT>/replies --method POST -f body=<text>；普通 PR 评论不能替代线程回复。确认完成后可按授权通过 GitHub GraphQL resolveReviewThread 处理线程。
不自动合并 PR、关闭 Issue 或改写已有提交历史；这些动作需要当前任务的明确授权和允许的工具权限。不得代替审阅人批准。保护飞书私密内容与凭证，跨来源发布只包含获准公开的信息。
GitHub 公开内容应清楚表明自动化身份，遵循团队沟通约定，不冒充人类。普通进度保持内部记录，完成结果和必要人工问题交由 Router 回到相应来源会话。
