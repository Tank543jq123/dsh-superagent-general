/**
 * CLI Source kind: instructions dropped into a folder on this machine.
 *
 * Design intent: a deployment often has no GitHub repository and no chat account —
 * just a terminal. This Source is the smallest thing that still carries a trusted
 * instruction: a file in a directory. The person writes an instruction into a `.md`
 * file, the Source turns it into a Trigger, and the reply is written beside it and
 * printed through the host logger.
 *
 * Why a folder and not a socket or a stdin protocol: the plugin runs inside the DSH
 * host, which owns its own stdio. A watched folder needs no port, no framing and no
 * client, and it survives a restart — a file that arrived while the host was down is
 * still there when it comes back. It is also the one interface a shell script, an
 * editor and another agent can all produce without agreeing on a protocol.
 *
 * Authorization still goes through the Policy: who may originate work is the allowed
 * list in this Source's Policy part, keyed by `senderId`. A file carries no identity,
 * so the configured sender id stands for the person who wrote it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'cli'

/** The Thread of a conversation: one conversation name is one Thread. */
export const cliThreadId = (conversation: string): string => conversation

/** Appends the Source prefix to a file name to form a stable Trigger id. */
export const cliTriggerId = (fileName: string): string => `${SOURCE}:${fileName}`

const CliConfigSchema = z.object({
  /** Folder instructions are dropped into. Relative paths resolve against the state directory. */
  inboxDir: z.string().trim().max(500).default('cli-inbox'),
  /** Which conversation a message belongs to. One value keeps a multi-turn thread continuous. */
  conversation: z.string().trim().min(1).max(100).default('default'),
  /** The sender id the Policy's allowed list matches; a file carries no identity of its own. */
  senderId: z.string().trim().min(1).max(200).default('cli-user'),
  /** How many replies thread context may read back. */
  keepReplies: z.number().int().min(1).max(200).default(20),
  /** Extensions treated as instructions; anything else in the folder is ignored. */
  extensions: z.string().trim().max(200).default('.txt,.md'),
  pollSeconds: z.number().int().min(1).max(300).default(2),
}).strict()
export type CliConfig = z.infer<typeof CliConfigSchema>

/**
 * The state directory, and the config the last watch pass read.
 *
 * `channel.send` and `threadContext` receive only the commands surface — they cannot
 * ask for a Source's configuration. Weixin solves the same problem by caching its
 * binding in module scope from the plugin entry; this does the same, and the watch
 * loop refreshes both on every pass so a settings change takes effect without a
 * restart. Defaults keep a reply working even before the first pass ran.
 */
let deploymentRoot = ''
let effective: CliConfig = CliConfigSchema.parse({})
export const setCliRoot = (stateDir: string): void => { deploymentRoot = stateDir }
/** Records the configuration the watch loop is using, so `send` and `read` see the same one. */
export const setCliConfig = (config: CliConfig): void => { effective = config }

/** Absolute inbox path: a relative `inboxDir` lives under the deployment's state directory. */
export const cliInbox = (stateDir: string, config: CliConfig): string =>
  config.inboxDir.startsWith('/') ? config.inboxDir : join(stateDir, config.inboxDir)

/** Reply and processed folders sit beside the inbox, so one tree holds one conversation. */
export const cliOutbox = (stateDir: string, config: CliConfig): string =>
  cliInbox(stateDir, config).replace(/[/\\]?$/, '') + '-outbox'
export const cliProcessed = (stateDir: string, config: CliConfig): string =>
  join(cliInbox(stateDir, config).replace(/[/\\]?$/, '') + '-processed', config.conversation)

const extensionsOf = (config: CliConfig): string[] =>
  config.extensions.split(',').map((ext) => ext.trim().toLowerCase()).filter(Boolean)

/**
 * The instruction file → Trigger mapping.
 *
 * `id` is the file name, which makes re-reading a recovered folder idempotent: the
 * Engine ignores a Trigger it has already taken, so a file that survives a crash is
 * never dispatched twice.
 */
export function cliTrigger(fileName: string, text: string, config: CliConfig, at: string): Trigger {
  const thread = cliThreadId(config.conversation)
  return {
    id: cliTriggerId(fileName),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: config.senderId },
    human: true,
    // A file in the inbox is a direct instruction to this machine, not something
    // overheard, so it is addressed by being written at all.
    addressed: 'direct',
    at,
    text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { conversation: config.conversation } },
    meta: { conversation: config.conversation, file: fileName, direct: true },
  }
}

/** Files in `inbox` that look like instructions, oldest first so the order a person wrote is kept. */
export function pendingFiles(inbox: string, config: CliConfig): string[] {
  if (!existsSync(inbox)) return []
  const allowed = extensionsOf(config)
  return readdirSync(inbox)
    .filter((fileName) => allowed.some((ext) => fileName.toLowerCase().endsWith(ext)))
    .map((fileName) => ({ fileName, at: statSync(join(inbox, fileName)).mtimeMs }))
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.fileName)
}

/**
 * Moves a handled file out of the inbox.
 *
 * Renaming rather than deleting is deliberate: the file is the person's own text, and
 * a run report can point at it afterwards. A processed folder also makes "what has
 * this deployment already seen" answerable from the filesystem alone.
 */
export function retireFile(stateDir: string, config: CliConfig, fileName: string): void {
  const done = cliProcessed(stateDir, config)
  mkdirSync(done, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  renameSync(join(cliInbox(stateDir, config), fileName), join(done, `${stamp}-${fileName}`))
}

/**
 * Writes a reply beside the inbox and returns its path.
 *
 * The file name uses the outbound message's own id, not a sequence number: `send` is
 * contracted to be idempotent by id, so a retried delivery overwrites one file
 * instead of leaving two replies that read as an exchange with itself.
 */
export function writeReply(stateDir: string, config: CliConfig, message: OutboundMessage): string {
  const outbox = cliOutbox(stateDir, config)
  mkdirSync(outbox, { recursive: true })
  const path = join(outbox, `${String(message.id).replace(/[^\w.-]+/g, '_')}.md`)
  writeFileSync(path, message.text, 'utf8')
  return path
}

/** The kept replies of one conversation, oldest first, shaped as thread-context messages. */
export function replyMessages(stateDir: string, config: CliConfig, limit: number): { id: string; from: string; at: string; text: string }[] {
  const outbox = cliOutbox(stateDir, config)
  if (!existsSync(outbox)) return []
  return readdirSync(outbox)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => ({ fileName, at: statSync(join(outbox, fileName)).mtimeMs }))
    .sort((left, right) => left.at - right.at)
    .slice(-limit)
    .map(({ fileName, at }) => ({
      id: basename(fileName, '.md'),
      from: 'agent',
      at: new Date(at).toISOString(),
      text: readFileSync(join(outbox, fileName), 'utf8'),
    }))
}

export const cliKind: SourceKind<CliConfig> = {
  kind: SOURCE,
  title: { zh: '本地命令', en: 'Local command' },
  description: {
    zh: '把一个文件夹当作指令入口：丢一个 .md/.txt 文件进去就是一条指令，回复写在旁边的 outbox 文件夹里。不需要 GitHub、飞书或微信。',
    en: 'Uses a folder as the instruction entry: each .md/.txt file dropped in is one instruction; replies are written to the outbox folder beside it. Needs no GitHub, Feishu or Weixin.',
  },
  schema: CliConfigSchema,
  fields: [
    { key: 'inboxDir', type: 'text', label: { zh: '收件文件夹', en: 'Inbox folder' },
      hint: { zh: '相对路径按状态目录解析。丢进去的 .txt/.md 各算一条指令，处理完移到 <收件夹>-processed/。', en: 'A relative path resolves against the state directory. Each .txt/.md dropped in counts as one instruction and moves to <inbox>-processed/ once handled.' } },
    { key: 'conversation', type: 'text', label: { zh: '会话名', en: 'Conversation' },
      hint: { zh: '同一个会话名的多条指令是一个连续对话，工单据此接续。', en: 'Instructions under one conversation name form one continuous thread, which tickets continue from.' } },
    { key: 'senderId', type: 'text', label: { zh: '发信人 ID', en: 'Sender id' },
      hint: { zh: '策略里「能发起工作的账号」必须包含这个值，否则指令只会成为候选而不被受理。文件本身不带身份。', en: 'The Policy\'s allowed list must contain this value, or an instruction only becomes a candidate. A file carries no identity of its own.' } },
    { key: 'extensions', type: 'text', advanced: true, label: { zh: '识别的扩展名', en: 'Recognised extensions' } },
    { key: 'keepReplies', type: 'number', advanced: true, min: 1, max: 200, label: { zh: '保留回复条数', en: 'Replies kept' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 300, label: { zh: '扫描间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['cli'],

  // A file appearing in the inbox is the whole signal; there is nothing to observe.
  scope() {
    return { listened: true, observed: false, row: 'inbox' }
  },

  channel: {
    async send(_host, message: OutboundMessage): Promise<'sent'> {
      // No config parameter here: both the root and the live config come from module
      // scope, refreshed by the watch loop (the same arrangement weixin uses for its
      // binding). The reply id makes a retry overwrite rather than duplicate.
      writeReply(deploymentRoot, effective, message)
      return 'sent'
    },
    link: (address) => ({ url: '', label: { zh: `本地会话 ${address.conversation ?? ''}`, en: `Local conversation ${address.conversation ?? ''}` } }),
  },

  policy: {
    unnamed: { person: { zh: '本地用户', en: 'Local user' }, bot: { zh: '本地程序', en: 'Local program' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine((users) => new Set(users.map((user) => user.id)).size === users.length, 'Duplicate sender ids').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的本地用户', en: 'Local users who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '发信人 ID', en: 'Sender id' } },
        { key: 'name', type: 'text', optional: true, label: { zh: '显示名', en: 'Display name' } }] }],
    explicit: { zh: '名单里的发信人 ID 投递的指令文件。', en: 'An instruction file dropped by a sender id on the list.' },
    rows: () => [{ id: 'inbox', label: { zh: '收件文件夹', en: 'Inbox' }, note: { zh: '全部', en: 'All' },
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }],
  },

  threadContext: {
    messageId: (trigger: Trigger) => String(trigger.id).replace(`${SOURCE}:`, ''),
    async read(_commands, _trigger, part, cursor) {
      // There is no remote history: only the replies this Source wrote are readable.
      const messages = replyMessages(deploymentRoot, effective, effective.keepReplies)
      if (part === 'parent') return { messages: messages.slice(-1), body: {} }
      if (part === 'root') return { messages: messages.slice(0, 1), body: {} }
      const start = cursor ? Math.max(0, messages.findIndex((message) => message.id === cursor) + 1) : 0
      return { messages: messages.slice(start), body: {} }
    },
  },

  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_CLI_THREAD',
      description: { zh: '这条工单来自哪个本地会话名，便于把文件写到对应位置', en: 'The local conversation name this ticket came from' } }],
    values: () => ({ DSH_SUPERAGENT_CLI_THREAD: effective.conversation }),
  },
}

export const name = 'dsh-superagent-cli'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  // The state directory lives beside this deployment's other agent state, not in another program's configuration.
  const stateDir = (ctx.orchestrator as unknown as { machine?: { stateDir?: string } }).machine?.stateDir
  if (stateDir) setCliRoot(stateDir)
  ctx.effect(() => ctx.orchestrator.sources.register(cliKind), 'cli: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, cliKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as source health instead.
    const running = watchCli(source, controller.signal)
      .catch((error: unknown) => { source.report('cli', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  }, 'cli: inbox watch')
}

/**
 * Polls the inbox and reports every new instruction as a Trigger.
 *
 * A file is retired only after `receive` returned, so a rejected instruction stays
 * where the person put it rather than disappearing. The seen set survives in the
 * Source's own KV, so a restart does not redispatch what has already gone through.
 */
async function watchCli(source: SourceContext, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) return
    const config = source.config<CliConfig>(SOURCE)
    if (!config) {
      // Disabled or uninstalled: nothing to watch, and the health entry says so.
      source.report('cli', { state: 'paused', detail: 'This CLI Source is disabled.' })
      await new Promise((done) => setTimeout(done, 5000))
      continue
    }
    setCliConfig(config)
    const inbox = cliInbox(deploymentRoot, config)
    try {
      mkdirSync(inbox, { recursive: true })
      const names = pendingFiles(inbox, config)
      for (const fileName of names) {
        const text = readFileSync(join(inbox, fileName), 'utf8').trim()
        // An empty file is left in place: it is more likely a half-written instruction
        // than an intentional blank, and retiring it would swallow the real text.
        if (!text) continue
        const at = new Date(statSync(join(inbox, fileName)).mtimeMs).toISOString()
        await source.receive(cliTrigger(fileName, text, config, at))
        retireFile(deploymentRoot, config, fileName)
      }
      source.report('cli', { state: 'ready', detail: `${inbox} · ${names.length} file(s) waiting` })
    } catch (error) {
      // A bad file must not stop the Source: report and keep polling, or one malformed
      // instruction would silently disable the only entry point this deployment has.
      source.report('cli', { state: 'error', detail: String(error instanceof Error ? error.message : error) })
    }
    await new Promise((done) => setTimeout(done, config.pollSeconds * 1000))
  }
}
