/**
 * HTTP Source kind: any program can hand this deployment an instruction over HTTP.
 *
 * Design intent: the other Sources each need an account somewhere — GitHub, a Feishu
 * app, a Weixin bot. This one needs nothing: a token and a POST. It is the entry a
 * cron job, a shell script, a CI step, or another agent uses when there is no chat
 * account and no repository to work in.
 *
 * ## Why a prefix beside `/orchestrator` rather than under it
 *
 * The management API enforces a same-origin browser-trust fence, which a `curl` from
 * another program cannot satisfy by design. The inbox therefore lives at its own
 * prefix and carries its own authentication: a bearer token compared in constant
 * time. Without a configured token every request is refused — an unauthenticated
 * inbox on a loopback port is still reachable by any local process.
 *
 * ## Why replies go to a pull endpoint
 *
 * A Source can send a reply, but HTTP has no address to send it to: the caller made
 * one request and is gone. Replies are therefore kept per conversation and read back
 * with `GET .../outbox?thread=…`. That also makes the exchange inspectable after the
 * fact, which a one-shot response body would not.
 */
import type { Context } from '@deepseek-ai/cordis'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'http'

/** The Trigger id of one accepted request; `id` is the caller's idempotency key. */
export const httpTriggerId = (id: string): string => `${SOURCE}:${id}`

/** The Thread of a conversation name. */
export const httpThreadId = (thread: string): string => thread

/** How many replies one conversation keeps for reading back. */
const OUTBOX_LIMIT = 50
/** Request bodies are instructions, not payloads; anything larger is refused. */
const MAX_BODY = 64 * 1024

const HttpConfigSchema = z.object({
  /** Bearer token every request must present. Empty refuses everything. */
  token: z.string().trim().max(500).default(''),
  /** Sender id the Policy's allowed list matches, when a request names none. */
  senderId: z.string().trim().min(1).max(200).default('http-client'),
  /** Default conversation when a request names none. */
  thread: z.string().trim().min(1).max(100).default('default'),
  /** Whether the caller may choose the conversation; off pins every request to `thread`. */
  allowThread: z.boolean().default(true),
}).strict()
export type HttpConfig = z.infer<typeof HttpConfigSchema>

/**
 * Live configuration and deployment, refreshed by the plugin entry.
 *
 * The route handler runs outside any per-Source context — it is registered with the
 * web server, not with the Engine — so it cannot ask for the Source's config. The
 * entry keeps both current instead, the same shape the CLI and Weixin Sources use.
 */
let live: HttpConfig = HttpConfigSchema.parse({})
let root = ''
export const setHttpRuntime = (config: HttpConfig, stateDir: string): void => { live = config; root = stateDir }

/** Constant-time token comparison; a length mismatch is still compared to avoid leaking it by timing. */
function tokenOk(given: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Compare against itself so the branch costs the same as a real comparison.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Reads the caller's token from either accepted header. */
export function presentedToken(req: Pick<IncomingMessage, 'headers'>): string {
  const auth = String(req.headers.authorization ?? '')
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const direct = req.headers['x-dsh-superagent-token']
  return String(Array.isArray(direct) ? direct[0] ?? '' : direct ?? '').trim()
}

const Reply = z.object({ text: z.string().min(1, 'text is required').max(64 * 1024) }).strict()

/** The wire shape of one accepted instruction. */
const Inbox = z.object({
  text: z.string().min(1, 'text is required').max(64 * 1024),
  /** Idempotency key: the same id never opens a second ticket. */
  id: z.string().trim().min(1).max(200).optional(),
  thread: z.string().trim().min(1).max(100).optional(),
  sender: z.string().trim().min(1).max(200).optional(),
}).strict()

/** One instruction → Trigger. `human: true` because a person wrote it, even when a script posted it. */
export function httpTrigger(input: z.infer<typeof Inbox>, config: HttpConfig, at: string): Trigger {
  const thread = config.allowThread ? input.thread ?? config.thread : config.thread
  const sender = input.sender ?? config.senderId
  return {
    id: httpTriggerId(input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    source: SOURCE,
    threads: [{ source: SOURCE, id: httpThreadId(thread) }],
    actor: { source: SOURCE, id: sender },
    human: true,
    addressed: 'direct',
    at,
    text: input.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { conversation: thread } },
    meta: { conversation: thread, direct: true, ...(input.id ? { requestId: input.id } : {}) },
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw new HttpError(413, `Request exceeds ${MAX_BODY} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new HttpError(400, 'The request body is not JSON') }
}

/** A refusal with an HTTP status, thrown by the body reader and answered by the route. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export const httpKind: SourceKind<HttpConfig> = {
  kind: SOURCE,
  title: { zh: 'HTTP 接口', en: 'HTTP endpoint' },
  description: {
    zh: '任何程序都能用 HTTP POST 派活：带一个 token 就能投递指令，回复按会话存在发件箱里读回。不需要 GitHub、飞书或微信。',
    en: 'Any program can hand work over HTTP: POST an instruction with a token, and read replies back from a per-conversation outbox. Needs no GitHub, Feishu or Weixin.',
  },
  schema: HttpConfigSchema,
  fields: [
    { key: 'token', type: 'text', secret: true, label: { zh: '访问令牌', en: 'Access token' },
      hint: { zh: '请求必须带 Authorization: Bearer <token> 或 x-dsh-superagent-token。留空则拒绝所有请求。', en: 'Requests must carry Authorization: Bearer <token> or x-dsh-superagent-token. Empty refuses every request.' } },
    { key: 'senderId', type: 'text', label: { zh: '默认发信人 ID', en: 'Default sender id' },
      hint: { zh: '策略里「能发起工作的账号」要包含它；请求可用 sender 字段覆盖。', en: 'The Policy\'s allowed list must contain it; a request may override it with sender.' } },
    { key: 'thread', type: 'text', label: { zh: '默认会话名', en: 'Default conversation' },
      hint: { zh: '请求未指定 thread 时用这个名字。', en: 'Used when a request names no thread.' } },
    { key: 'allowThread', type: 'switch', advanced: true, label: { zh: '允许调用方指定会话', en: 'Let callers choose the conversation' } },
  ],
  health: ['http'],

  scope() {
    return { listened: true, observed: false, row: 'inbox' }
  },

  channel: {
    async send(host, message: OutboundMessage): Promise<'sent'> {
      const thread = String(message.channel.address.conversation ?? live.thread)
      // `host` here is the commands surface only, so the outbox is written through the
      // Source's own KV, which the plugin entry pointed at this deployment.
      appendReply(thread, { id: String(message.id), text: message.text, at: new Date().toISOString() })
      return 'sent'
    },
    link: (address) => ({ url: '', label: { zh: `HTTP 会话 ${address.conversation ?? ''}`, en: `HTTP conversation ${address.conversation ?? ''}` } }),
  },

  policy: {
    unnamed: { person: { zh: 'HTTP 客户端', en: 'HTTP client' }, bot: { zh: 'HTTP 服务', en: 'HTTP service' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine((users) => new Set(users.map((user) => user.id)).size === users.length, 'Duplicate sender ids').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发信人 ID', en: 'Sender ids that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '发信人 ID', en: 'Sender id' } },
        { key: 'name', type: 'text', optional: true, label: { zh: '显示名', en: 'Display name' } }] }],
    explicit: { zh: '名单里的发信人 ID 通过 HTTP 投递的指令。', en: 'An instruction posted over HTTP by a sender id on the list.' },
    rows: () => [{ id: 'inbox', label: { zh: '收件接口', en: 'Inbox' }, note: { zh: '全部', en: 'All' },
      cells: { listedUnaddressed: true, unaddressed: true, unlistedUnaddressed: true } as never }],
  },

  threadContext: {
    messageId: (trigger: Trigger) => String(trigger.id).replace(`${SOURCE}:`, ''),
    async read(_commands, trigger, part, cursor) {
      const thread = String(trigger.meta.conversation ?? live.thread)
      const messages = repliesOf(thread)
      if (part === 'parent') return { messages: messages.slice(-1), body: {} }
      if (part === 'root') return { messages: messages.slice(0, 1), body: {} }
      const start = cursor ? Math.max(0, messages.findIndex((message) => message.id === cursor) + 1) : 0
      return { messages: messages.slice(start), body: {} }
    },
  },

  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_HTTP_THREAD',
      description: { zh: '这条工单来自哪个 HTTP 会话名', en: 'The HTTP conversation name this ticket came from' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_HTTP_THREAD: String(trigger?.meta?.conversation ?? live.thread) }),
  },
}

/** Replies are appended per conversation, keeping the newest `OUTBOX_LIMIT`. */
export function appendReply(thread: string, reply: { id: string; text: string; at: string }): void {
  const key = KV.sources.httpOutbox(thread)
  const current = store?.get(key) ?? []
  const next = [...current.filter((entry) => entry.id !== reply.id), reply].slice(-OUTBOX_LIMIT)
  store?.set(key, next)
}

/** The kept replies of one conversation. */
export function repliesOf(thread: string): { id: string; from: string; at: string; text: string }[] {
  const kept = store?.get(KV.sources.httpOutbox(thread)) ?? []
  return kept.map((entry) => ({ id: entry.id, from: 'agent', at: entry.at, text: entry.text }))
}

/**
 * The Source's own KV, captured by the plugin entry.
 *
 * `channel.send` and `threadContext` receive no `state`, and the route handler runs
 * outside the per-Source context, so both go through this one handle.
 */
let store: SourceContext['state'] | undefined
export const setHttpStore = (state: SourceContext['state']): void => { store = state }

export const name = 'dsh-superagent-http'
export const inject = ['orchestrator', 'webServer']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(httpKind), 'http: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, httpKind)
    setHttpStore(source.state)
    const stateDir = (ctx.orchestrator as unknown as { machine?: { stateDir?: string } }).machine?.stateDir ?? ''
    const refresh = (): void => {
      const config = source.config<HttpConfig>(SOURCE)
      if (!config) {
        source.report('http', { state: 'paused', detail: 'This HTTP Source is disabled.' })
        return
      }
      setHttpRuntime(config, stateDir)
      source.report('http', config.token
        ? { state: 'ready', detail: `POST /dsh-superagent/inbox` }
        : { state: 'error', detail: 'No access token is configured, so every request is refused.' })
    }
    refresh()
    // Settings changes arrive through the same registry the panel writes to, so a
    // token or sender change takes effect without restarting the deployment.
    return () => { /* the route disposer below owns teardown */ }
  }, 'http: runtime')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-superagent',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (!tokenOk(presentedToken(req), live.token)) {
          send(res, 401, { ok: false, error: 'A valid access token is required (Authorization: Bearer <token>)' })
          return
        }
        if (url.pathname === '/dsh-superagent/inbox' && req.method === 'POST') {
          const parsed = Inbox.safeParse(await body(req))
          if (!parsed.success) {
            send(res, 400, { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') })
            return
          }
          const source = sourceContext(ctx.orchestrator, httpKind)
          const trigger = httpTrigger(parsed.data, live, new Date().toISOString())
          const result = await source.receive(trigger)
          send(res, 200, { ok: true, trigger: trigger.id, received: result })
          return
        }
        if (url.pathname === '/dsh-superagent/outbox' && req.method === 'GET') {
          const thread = url.searchParams.get('thread') ?? live.thread
          send(res, 200, { ok: true, thread, messages: repliesOf(thread) })
          return
        }
        if (url.pathname === '/dsh-superagent/inbox' && req.method === 'GET') {
          // A health probe that also tells the caller what the endpoint wants.
          send(res, 200, { ok: true, source: SOURCE, ready: live.token !== '', thread: live.thread })
          return
        }
        send(res, 404, { ok: false, error: `Unknown path ${url.pathname}` })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        send(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'http: inbox routes')
}
