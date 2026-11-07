import * as Lark from '@larksuiteoapi/node-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { FeishuApi } from '../src/sources/feishu-sdk.ts'
import { Commands } from '../src/infra/commands.ts'
import { readFeishu } from '../src/sources/feishu-read.ts'
import { pollThreads } from '../src/sources/feishu-loops.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Thread } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'

const now = Date.now()
const source = { message_id: 'om_source', chat_id: 'oc_chat', thread_id: 'omt_topic', message_type: 'text', create_time: String(now - 3600000), body: { content: '{"text":"请调研定价"}' }, sender: { id: 'ou_author', sender_type: 'user' } }
const deployment = () => testDeployment({ feishu: { cli: '', appId: 'cli_test', appSecret: 'test-secret', botId: 'ou_bot', brand: 'feishu', name: 'Test bot' } })
const commands = () => new Commands(deployment, {}, new AbortController().signal)

/** Simulate Feishu's query contract using the SDK's real Axios URL serializer, without a network request. */
function wireMessages(items: Record<string, unknown>[] = [source]) {
  const urls: URL[] = []
  vi.spyOn(Lark.Client.prototype, 'request').mockImplementation(async payload => {
    const url = new URL(Lark.defaultHttpInstance.getUri(payload), 'https://open.feishu.cn')
    urls.push(url)
    if (url.pathname.endsWith('/messages/mget')) {
      const requested = url.searchParams.getAll('message_ids')
      return { code: 0, data: { items: items.filter(item => requested.includes(String(item.message_id))) } }
    }
    if (url.pathname.endsWith('/messages') && url.searchParams.get('container_id_type') === 'thread') {
      return { code: 0, data: { items, has_more: false } }
    }
    throw new Error('Unexpected test request')
  })
  return urls
}
afterEach(() => vi.restoreAllMocks())

it('encodes raw array query parameters as repeated Feishu keys', async () => {
  const other = { ...source, message_id: 'om_other' }, urls = wireMessages([source, other])
  const api = new FeishuApi('cli_test', 'test-secret')
  const result = await api.compat<{ items: typeof source[] }>(['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', JSON.stringify({ message_ids: ['om_source', 'om_other'] })])
  expect(result.items.map(item => item.message_id)).toEqual(['om_source', 'om_other'])
  expect(urls[0]!.searchParams.getAll('message_ids')).toEqual(['om_source', 'om_other'])
  expect([...urls[0]!.searchParams.keys()]).not.toContain('message_ids[]')
})

it('normalizes SDK message reads after applying the same wire query encoding', async () => {
  wireMessages()
  const result = await commands().lark<{ messages: { message_id: string; content: string }[] }>(['im', '+messages-mget', '--message-ids', 'om_source'])
  expect(result.messages).toMatchObject([{ message_id: 'om_source', content: '请调研定价' }])
})

it('polls an ended ticket subscription, clears the old poll error, and preserves the subscription', async () => {
  const urls = wireMessages()
  const trigger = feishuTrigger({ message_id: 'om_source', chat_id: 'oc_chat', chat_type: 'group', sender_id: 'ou_author', sender_type: 'user', content: '请调研定价', create_time: source.create_time }, 'ou_bot', 'cli_test')!
  const thread: Thread = { key: 'feishu:oc_chat:om_source', ref: trigger.threads[0]!, createdAt: new Date(now - 1800000).toISOString(), lastAt: trigger.at, subscriptions: ['finished-ticket'], correlated: [], pending: [], meta: { pollError: 'Error: The source Feishu message is unavailable or deleted; retained trigger text is still readable' } }
  const records = new Map<string, unknown>(), receive = vi.fn(), command = commands()
  const context = {
    commands: command, deployment: deployment(), receive,
    config: () => ({ readPageSize: 20, chats: [{ chatId: 'oc_chat', listen: 'all' }] }),
    state: { get: (key: string) => records.get(key), set: (key: string, value: unknown) => records.set(key, value) },
    triggers: { latest: () => trigger },
    tickets: { get: () => ({ ended: { at: new Date(now - 60000).toISOString(), by: 'executor' } }) },
    threads: { subscribed: () => [thread], patch: (_key: string, values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete thread.meta[key]; else thread.meta[key] = value } } },
  } as unknown as SourceContext
  await pollThreads(context)
  expect(thread.meta).not.toHaveProperty('pollError')
  expect(thread.subscriptions).toEqual(['finished-ticket'])
  expect(urls.some(url => url.searchParams.get('container_id_type') === 'thread')).toBe(true)
  expect(receive).not.toHaveBeenCalled()
})

it('distinguishes an omitted source from an explicitly deleted message', async () => {
  const ref = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
  wireMessages([])
  await expect(readFeishu(commands(), ref, 'feishu/source/thread', 20)).rejects.toThrow('飞书未返回原消息')
  vi.restoreAllMocks()
  wireMessages([{ ...source, deleted: true }])
  await expect(readFeishu(commands(), ref, 'feishu/source/thread', 20)).rejects.toThrow('飞书已标记原消息为删除')
})
