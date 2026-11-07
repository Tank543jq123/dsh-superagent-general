/**
 * Weixin Source kind: a personal Weixin bot that carries trusted instructions to
 * this deployment.
 *
 * Design intent: GitHub stays the place where work is tracked and reviewed, while a
 * person's Weixin direct message is where authorized work is requested. The Source is
 * therefore narrow on purpose — it listens only to the account owner's direct messages
 * by default, so an unfamiliar correspondent costs no attention.
 *
 * Authorization still goes through the Policy: who may originate work is the allowed
 * list in this Source's Policy part, keyed by Weixin sender id. `ownerUserId` from the
 * connection is offered as the default for that list, not substituted for it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import {
  beginWeixinLogin, pollWeixin, pollWeixinLogin, readWeixinBinding, sendWeixinText, WeixinSetupError,
  writeWeixinBinding, WEIXIN_QR_BASE_URL, type WeixinBinding,
} from './weixin-api.ts'
import { SOURCE, WeixinMessageSchema, weixinConversation, weixinTrigger } from './weixin-trigger.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE, weixinTrigger, weixinTriggerId, weixinConversation } from './weixin-trigger.ts'

const WeixinConfigSchema = z.object({
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'all']).default('none'),
  positiveKeywords: z.string().max(4000).default(''),
  negativeKeywords: z.string().max(4000).default(''),
  pollSeconds: z.number().int().min(2).max(300).default(5),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>

/** Connection cached per process; rereading the binding file on every poll is wasteful, and it changes only on sign-in. */
let cached: WeixinBinding | undefined
/** The state directory this Source's binding lives in, set by the plugin entry. */
let bindingRoot = ''

/** Points the connection reader at this deployment's state directory. */
export const setBindingRoot = (stateDir: string): void => { bindingRoot = stateDir; cached = undefined }

/** Loads this Source's own binding, or explains that the operator has not signed in yet. */
async function connection(): Promise<WeixinBinding> {
  if (cached) return cached
  const binding = await readWeixinBinding(bindingRoot)
  if (!binding) {
    throw new WeixinSetupError('configMissing', 'This Weixin Source is not signed in. Use its "Sign in" action to scan a QR code with Weixin.')
  }
  cached = binding
  return binding
}

/** Forgets the cached binding, so the next poll rereads it (after sign-in or sign-out). */
const forgetBinding = (): void => { cached = undefined }

export const weixinKind: SourceKind<WeixinConfig> = {
  kind: SOURCE,
  title: { zh: '微信', en: 'Weixin' },
  description: {
    zh: '接收微信里发给这台机器的指令。默认只接收账号所有者的私聊，作为可信的指令入口；工作在 GitHub 上跟踪和评审。',
    en: 'Receives instructions sent to this machine over Weixin. By default only the account owner\'s direct messages, as the trusted entry point for work; work is tracked and reviewed on GitHub.',
  },
  schema: WeixinConfigSchema,
  fields: [
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' },
      hint: { zh: '关闭后，微信里的私聊不会产生工单。', en: 'When off, direct messages on Weixin create no Tickets.' } },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other chats' },
      options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'all', label: { zh: '全部消息', en: 'All messages' } }],
      hint: { zh: '群聊消息。默认不接收：微信入口只承担可信指令，群聊噪音交给策略准入决定。', en: 'Group messages. Not received by default: the Weixin entry carries trusted instructions only, and group noise is left to Policy admission.' } },
    { key: 'positiveKeywords', type: 'text', label: { zh: '关注关键词', en: 'Positive keywords' },
      hint: { zh: '用逗号分隔，留空表示不限；候选消息至少包含一个。注意：这是 Source 级过滤，对所有者私聊同样生效，默认留空。', en: 'Comma-separated; blank allows all. Source-level: it also filters the owner\'s direct messages, so leave blank by default.' } },
    { key: 'negativeKeywords', type: 'text', label: { zh: '忽略关键词', en: 'Negative keywords' },
      hint: { zh: '用逗号分隔；命中任一词就忽略，优先于关注词。', en: 'Comma-separated; a negative match excludes a message and wins over positive keywords.' } },
    { key: 'binding', type: 'fact', label: { zh: '微信绑定', en: 'Weixin binding' },
      hint: { zh: '本 Source 自己的微信绑定，独立于其他程序的连接。未绑定时请用「扫码登录」。', en: "This Source's own Weixin binding, independent of any other program. When unbound, use Sign in." } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 300, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['weixin'],

  // The owner's direct chat is the trusted entry; everything else is off unless configured.
  scope({ meta }, config) {
    const direct = meta.direct === true
    if (direct) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    return config.otherChats === 'all' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chats_not_allowed' }
  },

  channel: {
    allowed: (address, config) => config.directMessages || address.direct !== 'true',
    async send(_host, message: OutboundMessage): Promise<'sent' | 'gone'> {
      // `send` receives only the commands surface, so the connection is resolved from the cached
      // account the polling loop loaded: a reply always follows a Trigger from the same connection.
      const binding = await connection()
      const toUserId = message.channel.address.conversation
      if (!toUserId) throw new Error('The Weixin reply has no conversation')
      try {
        await sendWeixinText(binding.baseUrl, binding.token, {
          toUserId, text: message.text,
          ...(message.channel.address.contextToken ? { contextToken: message.channel.address.contextToken } : {}),
          signal: AbortSignal.timeout(30_000),
        })
        return 'sent'
      } catch (error) {
        // A provider rejection is permanent for this address; anything else may succeed on retry.
        if (error instanceof WeixinSetupError && error.code === 'providerRejected') return 'gone'
        throw error
      }
    },
    link: (address) => ({ url: '', label: { zh: `微信会话 ${address.conversation ?? ''}`, en: `Weixin conversation ${address.conversation ?? ''}` } }),
  },

  policy: {
    unnamed: { person: { zh: '微信用户', en: 'Weixin user' }, bot: { zh: '微信机器人', en: 'Weixin bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate sender ids').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信账号', en: 'Weixin accounts that may originate work' },
        hint: { zh: '填微信用户 id（形如 xxx@im.wechat）。只有这里的人发的消息才能产生工单。', en: 'Weixin user ids (such as xxx@im.wechat). Only messages from these accounts can create Tickets.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '用户 id', en: 'User id' } },
          { key: 'name', type: 'text', label: { zh: '备注', en: 'Note' }, optional: true },
        ] },
    ],
    explicit: {
      zh: 'listened 的会话里，名单上的账号发来的消息。私聊默认算作对机器人的直接请求。',
      en: 'A message from an allowed account in a listened conversation. A direct message counts as addressed to the bot.',
    },
    rows: () => [
      { id: 'direct', label: { zh: '私聊', en: 'Direct message' }, note: { zh: '与本机微信机器人的一对一聊天', en: 'A one-to-one chat with this machine\'s Weixin bot' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'other', label: { zh: '其他会话', en: 'Other chats' }, note: { zh: '群聊等非私聊会话', en: 'Group and other non-direct conversations' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
    ],
  },

  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEIXIN_USER', description: { zh: '发起工单的微信用户 id', en: 'The Weixin user id that started the ticket' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_WEIXIN_USER: trigger?.actor.id ?? '' }),
  },
}

/** Runs the long-poll loop of an enabled Weixin Source. */
export const runWeixin = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> => loop(ctx, signal)

async function loop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let retry = 0
  while (!signal.aborted) {
    const config = ctx.config<WeixinConfig>(SOURCE)
    if (!config) {
      ctx.report('weixin', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    let binding: WeixinBinding
    try {
      binding = await connection()
    } catch (error) {
      // Setup is not complete; report it and try again, since the operator may fix it in the panel.
      ctx.report('weixin', { state: 'error', detail: error instanceof Error ? error.message : String(error) })
      await delay(15_000, undefined, { signal }).catch(() => {})
      continue
    }
    const cursor = ctx.state.get(KV.sources.weixinCursor) ?? ''
    try {
      const page = await pollWeixin(binding.baseUrl, binding.token, cursor, signal)
      if (page.cursor && page.cursor !== cursor) ctx.state.set(KV.sources.weixinCursor, page.cursor)
      for (const item of page.messages) await ingest(ctx, binding, item)
      ctx.report('weixin', { state: 'ready', detail: `Polling; ${page.messages.length} new message(s)` })
      retry = 0
    } catch (error) {
      if (signal.aborted) return
      retry += 1
      ctx.report('weixin', { state: retry >= 3 ? 'error' : 'starting', detail: error instanceof Error ? error.message : String(error) })
    }
    await delay(Math.max(1000, config.pollSeconds * 1000), undefined, { signal }).catch(() => {})
  }
}

/** Translates one provider message into a Trigger and hands it to the engine. */
async function ingest(ctx: SourceContext, binding: WeixinBinding, item: unknown): Promise<void> {
  const parsed = WeixinMessageSchema.safeParse(item)
  if (!parsed.success) return
  const message = parsed.data
  // The bot's own id is the recipient of every message it receives; a direct chat is one
  // without a group id, which the Trigger marks as addressed to the agent.
  const self = message.to_user_id ?? binding.botId
  const direct = !message.group_id
  const trigger = weixinTrigger(message, self, { direct })
  if (!trigger) return
  await ctx.receive(trigger)
  const conversation = weixinConversation(message)
  const label = direct ? { value: { zh: '私聊', en: 'Direct message' } } : { value: conversation }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat: label } })
}

/** Cordis plug-in entry registering the Weixin Source kind and starting its long-poll loop. */
export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  // The binding lives beside this deployment's other agent state, not in another program's configuration.
  const stateDir = (ctx.orchestrator as unknown as { machine?: { stateDir?: string } }).machine?.stateDir
  if (stateDir) setBindingRoot(stateDir)
  ctx.effect(() => ctx.orchestrator.sources.register(weixinKind), 'weixin: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, weixinKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as source health instead.
    const running = runWeixin(source, controller.signal)
      .catch((error: unknown) => { source.report('weixin', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
