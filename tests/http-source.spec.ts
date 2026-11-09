/**
 * The HTTP Source's inbox and outbox routes, exercised through the plugin entry
 * the way the host mounts it: the token fence, the request shape, the idempotency
 * key, and reading the agent's replies back per conversation.
 */
import { expect, it } from 'vitest'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import { apply, httpKind, type HttpConfig } from '../src/sources/http.ts'

const TOKEN = 'test-token-0123456789'
const CONFIG: HttpConfig = { token: TOKEN, senderId: 'http-client', thread: 'default', allowThread: true }

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>

/**
 * Mounts the Source the way its plug-in entry does and returns a request helper.
 *
 * Only what the entry and the routes read is faked: the Source context (config,
 * health, KV state, `receive`) and the web server's route registry. The KV state is
 * an in-memory map, so the outbox assertions read the same records the Store holds.
 */
function mount(config: HttpConfig | undefined) {
  const values = new Map<string, unknown>()
  const received: Trigger[] = []
  const health: Record<string, { state: string; detail: string }> = {}
  const context = {
    deployment: {}, commands: {}, ready: Promise.resolve(), configured: () => true,
    config: () => config,
    receive: async (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
    atomic: <T>(work: () => T): T => work(),
    state: {
      get: <V>(key: string): V | undefined => values.get(key) as V | undefined,
      set: <V>(key: string, value: V | undefined): void => { if (value === undefined) values.delete(key); else values.set(key, value) },
      keys: () => [...values.keys()],
    },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
    tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
    triggers: { get: () => undefined, latest: () => undefined },
    notify: () => {},
    report: (entry: string, value: { state: string; detail: string }) => { health[entry] = value },
  }
  let handler: Handler = async () => {}
  const ctx = {
    orchestrator: { machine: { stateDir: '/tmp/dsh-superagent-test' }, sources: { register: () => () => {} }, context: () => context },
    webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    effect: (effect: () => unknown) => effect(),
  }
  apply(ctx as never)
  const call = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0
    let text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', ...headers }).filter(([, value]) => value !== undefined))
    const req = { method, url: path, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: text ? JSON.parse(text) as Record<string, unknown> : undefined }
  }
  return { call, bearer: { authorization: `Bearer ${TOKEN}` }, received, health, values }
}

it('refuses every request without a configured token, and says so in health', async () => {
  const unconfigured = mount({ ...CONFIG, token: '' })
  expect(await unconfigured.call('POST', '/dsh-superagent/inbox', { text: 'do it' })).toMatchObject({ status: 401 })
  // Even a caller presenting something cannot pass: there is nothing to compare against.
  expect(await unconfigured.call('POST', '/dsh-superagent/inbox', { text: 'do it' }, unconfigured.bearer)).toMatchObject({ status: 401 })
  expect(unconfigured.received).toEqual([])
  expect(unconfigured.health.http).toMatchObject({ state: 'error', detail: expect.stringContaining('token') })
})

it('refuses a missing, malformed, or wrong token, and accepts both accepted headers', async () => {
  const { call, bearer } = mount(CONFIG)
  const inbox = (headers: Headers) => call('POST', '/dsh-superagent/inbox', { text: 'do it' }, headers)
  expect(await inbox({})).toMatchObject({ status: 401 })
  expect(await inbox({ authorization: 'Basic dXNlcjpwYXNz' })).toMatchObject({ status: 401 })
  expect(await inbox({ authorization: 'Bearer wrong-token' })).toMatchObject({ status: 401 })
  // A token that is a prefix of the real one is still wrong; the comparison is over the whole value.
  expect(await inbox({ authorization: `Bearer ${TOKEN.slice(0, -1)}` })).toMatchObject({ status: 401 })
  expect(await inbox({ 'x-dsh-superagent-token': TOKEN })).toMatchObject({ status: 200 })
  expect(await inbox(bearer)).toMatchObject({ status: 200 })
  expect(await call('GET', '/dsh-superagent/outbox?thread=default')).toMatchObject({ status: 401 })
})

it('stores one Trigger per accepted instruction, naming its conversation and sender', async () => {
  const { call, bearer, received } = mount(CONFIG)
  const answer = await call('POST', '/dsh-superagent/inbox', { text: 'file the report', thread: 'reports', sender: 'cron' }, bearer)
  expect(answer).toMatchObject({ status: 200, body: { ok: true, trigger: expect.any(String), received: 'stored' } })
  expect(received).toHaveLength(1)
  const trigger = received[0]!
  expect(trigger).toMatchObject({ id: answer.body!.trigger, source: 'http', threads: [{ source: 'http', id: 'reports' }],
    actor: { source: 'http', id: 'cron' }, human: true, addressed: 'direct', text: 'file the report',
    channel: { source: 'http', thread: 'http:reports', address: { conversation: 'reports' } },
    meta: { conversation: 'reports', direct: true } })
  // A request that names neither falls back to the configured conversation and sender.
  await call('POST', '/dsh-superagent/inbox', { text: 'second instruction' }, bearer)
  expect(received[1]).toMatchObject({ threads: [{ source: 'http', id: 'default' }], actor: { source: 'http', id: 'http-client' } })
})

it('pins every instruction to the configured conversation when callers may not choose one', async () => {
  const { call, bearer, received } = mount({ ...CONFIG, allowThread: false, thread: 'pinned' })
  await call('POST', '/dsh-superagent/inbox', { text: 'do it', thread: 'ignored' }, bearer)
  expect(received[0]).toMatchObject({ threads: [{ source: 'http', id: 'pinned' }] })
})

it('answers a body without text, from the wrong method, or with unknown fields with 4xx', async () => {
  const { call, bearer, received } = mount(CONFIG)
  expect(await call('POST', '/dsh-superagent/inbox', {}, bearer)).toMatchObject({ status: 400 })
  expect(await call('POST', '/dsh-superagent/inbox', { text: '' }, bearer)).toMatchObject({ status: 400 })
  expect(await call('POST', '/dsh-superagent/inbox', 'not json', bearer)).toMatchObject({ status: 400 })
  // `.strict()` keeps a typo from being silently ignored: the caller learns the field is unknown.
  expect(await call('POST', '/dsh-superagent/inbox', { text: 'do it', ttext: 'typo' }, bearer)).toMatchObject({ status: 400 })
  expect(await call('PUT', '/dsh-superagent/inbox', { text: 'do it' }, bearer)).toMatchObject({ status: 404 })
  expect(received).toEqual([])
})

it('maps an idempotency id to the same Trigger id, so a retry cannot open a second ticket', async () => {
  const { call, bearer, received } = mount(CONFIG)
  const first = await call('POST', '/dsh-superagent/inbox', { id: 'retry-me', text: 'do it' }, bearer)
  const second = await call('POST', '/dsh-superagent/inbox', { id: 'retry-me', text: 'do it' }, bearer)
  expect(first.body!.trigger).toBe(second.body!.trigger)
  expect(received.map(trigger => trigger.id)).toEqual([first.body!.trigger, first.body!.trigger])
  // Two requests without an id are two instructions.
  const a = await call('POST', '/dsh-superagent/inbox', { text: 'do it' }, bearer)
  const b = await call('POST', '/dsh-superagent/inbox', { text: 'do it' }, bearer)
  expect(a.body!.trigger).not.toBe(b.body!.trigger)
})

it('keeps the agent\'s reply in the conversation\'s outbox and reads it back', async () => {
  const { call, bearer } = mount(CONFIG)
  const message = (id: string, text: string, conversation: string): OutboundMessage =>
    ({ id, kind: 'reply', text, channel: { source: 'http', thread: `http:${conversation}`, address: { conversation } } })
  // The channel receives only the commands surface; the reply is written to this Source's KV.
  expect(await httpKind.channel!.send({} as never, message('m1', 'the report is filed', 'reports'))).toBe('sent')
  await httpKind.channel!.send({} as never, message('m2', 'and the second one too', 'reports'))
  await httpKind.channel!.send({} as never, message('m3', 'unrelated conversation', 'other'))
  // Re-sending one message id does not duplicate it: delivery is idempotent like every other Channel.
  // The record keeps its one entry (currently moved to the tail on a repeat); what matters here is the count.
  await httpKind.channel!.send({} as never, message('m1', 'the report is filed', 'reports'))
  const read = await call('GET', '/dsh-superagent/outbox?thread=reports', undefined, bearer)
  expect(read).toMatchObject({ status: 200, body: { ok: true, thread: 'reports' } })
  const messages = read.body!.messages as { id: string; from: string; text: string; at: string }[]
  expect(messages).toHaveLength(2)
  expect(messages.map(entry => entry.id).sort()).toEqual(['m1', 'm2'])
  for (const entry of messages) expect(entry).toMatchObject({ from: 'agent', at: expect.any(String) })
  // A caller that names no conversation reads the configured one.
  expect(await call('GET', '/dsh-superagent/outbox', undefined, bearer)).toMatchObject({ status: 200,
    body: { thread: 'default', messages: [] } })
  // Conversations stay separate: another thread's reply never leaks into this one.
  expect(await call('GET', '/dsh-superagent/outbox?thread=other', undefined, bearer)).toMatchObject({ status: 200,
    body: { thread: 'other', messages: [{ id: 'm3', text: 'unrelated conversation' }] } })
})

it('reads a thread\'s history back as context, and names the conversation for the environment', async () => {
  const { call, bearer, received, values } = mount(CONFIG)
  await call('POST', '/dsh-superagent/inbox', { text: 'start the work', thread: 'ctx' }, bearer)
  await httpKind.channel!.send({} as never, { id: 'r1', kind: 'reply', text: 'working on it',
    channel: { source: 'http', thread: 'http:ctx', address: { conversation: 'ctx' } } })
  const trigger = received[0]!
  expect(httpKind.threadContext!.messageId(trigger)).toBe(String(trigger.id).replace('http:', ''))
  const thread = await httpKind.threadContext!.read({} as never, trigger, 'thread', undefined, CONFIG)
  expect(thread.messages).toEqual([{ id: 'r1', from: 'agent', at: expect.any(String), text: 'working on it' }])
  // The environment variable names the conversation the ticket came from.
  expect(httpKind.environment!.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_HTTP_THREAD'])
  expect(httpKind.environment!.values({ deployment: {} as never, config: CONFIG, trigger }))
    .toEqual({ DSH_SUPERAGENT_HTTP_THREAD: 'ctx' })
  // The outbox is the Source's own KV: reading it never wrote anything else there.
  expect([...values.keys()]).toEqual(['http-outbox:ctx'])
})

it('describes its own health when a token is configured, and answers a probe', async () => {
  const configured = mount({ ...CONFIG, token: 'a-much-longer-token-value' })
  expect(configured.health.http).toMatchObject({ state: 'ready' })
  expect(await configured.call('GET', '/dsh-superagent/inbox', undefined, { authorization: 'Bearer a-much-longer-token-value' }))
    .toMatchObject({ status: 200, body: { ok: true, source: 'http', ready: true } })
})
