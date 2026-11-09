# 变更记录

## 2026-11-09 · 0.2.7

### 改进 · 垫片生成按平台分叉（Windows 分支未验证）

> ⚠️ **Windows 支持标注为「未验证方案，不对结果负责」。**
> 本仓库的开发与全部验证都在 Linux 上完成。下面 Windows 相关代码是按各平台文档写出的
> "应该能工作"的方案，**没有在真实 Windows 上运行过一次**。欢迎实测反馈，但不承诺可用。

- `writeEnvironment` 原来无条件写 `#!/bin/sh` 垫片 + `mode: 0o755`。Windows 没有 shebang，
  `.cmd` 是另一种形状 —— 现在按平台分叉：POSIX 仍是 `#!/bin/sh`，Windows 写 `.cmd`
  （`@echo off` / `REM` 标记 / `exit /b %ERRORLEVEL%`）。
- Windows 不再传 `mode: 0o755`：NTFS 不看 POSIX 权限位，传一个假的权限值只会误导。
- Windows 的 PATH 剥离改用 `for %%E in (...)` 逐项比较，与 POSIX 版语义一致。
- 已知未覆盖：PATHEXT 让调用方可能绕过 `名称.cmd` 直接命中同目录的 `名称.exe`；
  cmd 对 `%` 的加倍转义在路径含 `%` 时仍未实测。

### 说明
- 拦截层（`blockedCommands`）仍然需要垫片 —— 那是"禁止"，无法用环境变量表达。
  账号绑定已在 0.2.6 改为 `GH_CONFIG_DIR`，不再依赖垫片。

## 2026-11-09 · 0.2.6

### 新增 · 平台抽象层（Windows 支持的第一步）
- `src/infra/platform.ts`：整个仓库**唯一**回答"这是哪个操作系统"的模块。回答三个问题——命令行怎么跑（`shellArgv`）、可执行搜索路径怎么拼（`pathVariable` / `pathDelimiter`）、路径怎么引号（`quoteForShell`）。
- 为什么集中：测下来 1198 个测试里 131 挂、跨 9 个文件，几乎全是 `spawn sh ENOENT` / `spawn sleep ENOENT` —— 89% 逻辑可移植，不可移植的集中在「命令怎么跑、环境怎么拼、服务脚本怎么写」三件事上。散落的 `process.platform` 判断会让每一处都成为可以搞错的地方。

### 修复 · `executor.prepare` 在 Windows 上必然失败
- `src/executor/dsh.ts` 写死了 `['sh', '-c', command]`，Windows 上没有 `sh` → ENOENT → prepare 永远失败。改用 `shellArgv()`：POSIX 仍是 `sh -c`，Windows 用 `cmd /d /s /c`（`/d` 跳过注册表 AutoRun，`/s` 按 cmd 文档的引号契约取整条）。
- 不用 PowerShell 做默认：`executor.prepare` 是操作者写的一行命令，文档里例子几乎全是 POSIX shell；`cmd` 是更接近的翻译，换 PowerShell 会悄悄改变 `&&`、`>` 和引号的语义。

### 改进 · 账号绑定不再依赖 PATH 垫片
- `agentVariables` 增加 `GH_CONFIG_DIR`：让 `gh` 自己的工作目录指向智能体账号的配置。原来这件事靠一个 `#!/bin/sh` 垫片 `exec` 另一个程序——POSIX-only，Windows 上根本没有 shebang，`.cmd` 又是另一种形状。
- 文档里早就提到 `GH_CONFIG_DIR`（`src/sources/github.ts:47` 的提示文案），但代码从未设置它。现在补上。
- 拦截层（`blockedCommands`）仍然需要垫片，但那是"禁止"——与"绑到哪个账号"是两件事，拆开后 Windows 不再需要 `.cmd` 垫片来绑账号。

### 已验证 / 未验证
- 已验证：`src/executor/dsh.ts` 是生产代码里唯一写死 `sh -c` 的地方（其余 `sh`/`sleep` 都在测试里）；上游三个仓库的 README/docs/package.json 里 `windows|win32` 命中数为 0，`package.json` 也没有 `os` 字段——不是明确拒绝 Windows，而是默认按 POSIX 设计、从未测试。
- **未验证：以上改动都没有在真实 Windows 上跑过。** 本机是 Linux，`shellArgv` / `quoteForShell` 的 Windows 分支只有单元测试覆盖（`tests/platform.spec.ts` 10 项，显式传 `'win32'`）。

## 2026-11-09 · 0.2.5

### 新增 · 本地命令信道（`cli`）
- 不需要 GitHub、飞书或微信即可开用：把一个 `.md`/`.txt` 文件丢进 `<stateDir>/cli-inbox/`，它就是一条指令；处理完移到 `cli-inbox-processed/<会话名>/`，回复写到 `cli-inbox-outbox/`。
- 配置：`inboxDir`（默认 `cli-inbox`）、`conversation`（默认 `default`，同一会话名的多轮指令是连续线程）、`senderId`（默认 `cli-user`，策略的允许列表要包含它）、`extensions`、`keepReplies`、`pollSeconds`。
- 回复文件用 message id 命名 —— `send` 的契约是按 id 幂等，重试会覆盖而不是留下两份。
- 空文件留在原处不消费：更可能是还没写完，而不是有意留白。
- 与其它 Source 一样通过 Policy 授权；文件本身不带身份，`senderId` 代表投递它的人。

### 新增 · HTTP 接口信道（`http`）
- 任何程序都能用 HTTP 派活：`POST /dsh-superagent/inbox`，body `{ text, id?, thread?, sender? }`，回复用 `GET /dsh-superagent/outbox?thread=…` 读回。
- **必须配 token**，`Authorization: Bearer <token>` 或 `x-dsh-superagent-token`；令牌比较走 `timingSafeEqual`（长度不等时也做一次等价比较，不靠长度泄露）。**没配 token 时拒绝一切请求**并在 health 上报 —— 回环端口上的裸收件箱本机任何进程都能打。
- 走独立前缀而不是挂在 `/orchestrator` 下：管理 API 有 same-origin 浏览器信任栅栏，外部 `curl` 按设计过不去。
- `id` 是幂等键：同一个 id 不会开出第二个工单。
- body 上限 64 KiB。

### 说明
- 挂载点已加入 bundle（`cordis.patch.yml`）、构建入口（`tsdown.config.ts`）与 `package.json` exports；`tests/bundle-patch.spec.ts` 的行 id 断言同步更新。

## 2026-11-09 · 0.2.4

### 修复 · 派工落地
- Worker 的系统提示词末尾新增固定、不可被团队提示覆盖的「开工前派工检查（强制）」：开始前先切块；≥2 个互不依赖的块必须先用一条消息派对应 subagent；不得先顺序做完再补派。
- 报告第一行必须写 `派工：无（理由）` 或 `派工：N 个（谁做什么）`，让派工情况可验收。
- 单文件/单点小修仍可直接做；子 Agent approvalPolicy 固定 never，需要审批的操作留给自己或报告。

### 说明
- 这是提示词层的强制前置检查，不改变 DSH 的 subagent 工具或其审批策略。
- 本机 Worker 默认模型仍是 `workbuddy/deepseek-v4.1-flash`；普通 Agent 若使用本地 27B，模型能力差异仍可能影响派工意愿，模型切换是独立的部署决策。


## 2026-11-08 · 0.2.3

### 新增 · 子 Agent 派工
- Worker 提示词与工作说明新增「派工」规则：任务含两个及以上互不依赖的子任务，或预计十余步以上且能切成独立小块时，用一条消息同时派多个 subagent，自己继续做余下部分。
- 明确边界：决策、最终交付判断和串行依赖留在 Worker；子 Agent 的结果是输入，依赖它的结论要复核；几小步能做完的事直接做，不为了派而派。
- `docs/004-prompts.md` 补充 Subagent dispatch 说明；`tests/docs.spec.ts` 增加派工规则断言。

### 修复
- 修正 `src/app/sessions.ts` 的陈旧注释：Session 创建时设置的是配置的 `permissionPreset`，不是固定 `danger-full-access`。

### 部署说明（本机，非仓库默认）
- 本机 `superagent` profile 的 `permissionPreset` 已从 `workspace-write` 改为 `danger-full-access`，host 重启后新会话生效；插件默认值仍是 `workspace-write`，仓库不改变这个默认。
- 这是“可信本机 + 单人”的取舍；隔离靠专用 OS 账户。子 Agent 的 approvalPolicy 仍由 DSH 固定为 `never`，需要审批的操作会被拒绝而不是转给父级；子 Agent 应停下报告父级。

### 验证
- `pnpm check`：62 个测试文件 / 1198 项通过；类型检查、ESM/client 构建通过。
- 注意：在**宿主会话内**直接跑会有 2 项失败（`tests/runtime.spec.ts` 的"环境恢复"用例），
  原因是宿主给 worker 注入了 `GIT_CONFIG_GLOBAL` 与 `worker-bin` PATH，用例断言"恢复后为空"。
  用干净环境跑（`env -u GIT_CONFIG_GLOBAL` + 系统 PATH）该项 91/91 通过 —— 是环境问题，不是回归。
- 新会话（subagent）实测：workspace 外写入成功；profile `danger-full-access`；`prompts/work.md` 的「## 派工」与 worker 的 subagent 行存在。


## 2026-11-07

- 新增：迁移 SuperAgent-General 产品层，包括通用提示词、飞书应用 SDK 传输、面板与语言、关键词过滤和对应测试。
- 保留：微微信来源、`permissionPreset` 沙箱默认、`dsh-superagent` 包身份和 `docs/000-008` 设计文档。
- 修复：飞书事件消费者的错误状态不再被延迟的 ready 覆盖；本包根目录解析使用 `dsh-superagent`。


## 2026-11-05

- 修复：清理公共提示与主动授权提示中的仓库维护限制，通用任务可按自身目标与交付形式执行。
- 变更：飞书技能按应用 SDK 整理，GitHub 技能保留平台协议并移除原型团队特定的审查、提交改写与自动合并流程。
- 新增：提示词与接单规则配置说明，面板标明主动规则的 Router 判断及 Worker 派工用途，团队约定提示改为通用场景。

- 修复：飞书 SDK 查询数组使用重复同名参数，正常存在的消息可以被批量读取，已交付工单的订阅轮询可恢复。
- 修复：分别提示消息查询无结果与飞书明确标记删除，避免将空响应误判为消息删除。

## 2026-11-04

- 变更：README 集中说明相对官方原型的调整，公开文档收敛为使用、架构和上游说明。
- 修复：打包前自动构建，发布清单明确包含插件运行资源，避免源码检出缺少构建产物。

- 修复：关键词变更纳入原型的策略版本机制，重新评估进行中的旧判断。

- 修复：飞书 SDK 连接失败后回到原型现有的退避恢复循环，平台配置完成后可自动恢复连接。

- 变更：基于官方原型恢复完整编排引擎、持久化、Router/Worker 会话与原生管理面板。
- 变更：通用任务默认使用官方 Router/Worker；默认概览、原生主题与自动轮询，设置移到最后，新增关于页。
- 新增：飞书应用凭证与 SDK 适配、正负关键词、原型 Worker 的飞书 API 工具。
- 新增：首版配置迁移与独立凭证存储，旧数据库保留。
- 变更：可选场景通过团队技能注入上下文，移除固定知识收录执行路径。
