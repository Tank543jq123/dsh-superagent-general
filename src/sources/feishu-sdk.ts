/** Feishu transport adapter. The upstream Source/Engine contracts stay unchanged. */
import * as Lark from '@larksuiteoapi/node-sdk'
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CliError } from '../infra/commands.ts'
export interface Credentials { appId: string; appSecret: string }
export function storedCredentials(directory: string): Credentials | undefined {
  const path = join(directory, 'feishu-credentials.json')
  if (!existsSync(path)) return
  const value = JSON.parse(readFileSync(path, 'utf8')) as Credentials
  return value.appId && value.appSecret ? value : undefined
}
export function storeCredentials(directory: string, appId: string, appSecret: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'feishu-credentials.json'), temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ appId, appSecret }), { mode: 0o600 }); renameSync(temporary, path)
}
/** Keep rich text readable for the existing trigger/context schemas. */
export function messageText(raw: string): string {
  let value: unknown; try { value = JSON.parse(raw) } catch { return raw }
  const pieces: string[] = []
  const walk = (v: unknown): void => { if (!v || typeof v !== 'object') return; if (Array.isArray(v)) { v.forEach(walk); return }; const o = v as Record<string, unknown>; for (const key of ['text', 'href', 'image_key', 'file_key']) if (typeof o[key] === 'string') pieces.push(o[key] as string); for (const [key, child] of Object.entries(o)) if (!['text', 'href', 'image_key', 'file_key'].includes(key)) walk(child) }
  walk(value); return pieces.join('\n') || raw
}
/** SDK-backed transport implementing the original Source reader command facade. */
export class FeishuApi {
  readonly client: Lark.Client
  constructor(appId: string, appSecret: string) { this.client = new Lark.Client({ appId, appSecret, appType: Lark.AppType.SelfBuild, loggerLevel: Lark.LoggerLevel.error }) }
  async request<T>(method: string, url: string, data?: unknown, params?: unknown): Promise<T> {
    if (!url.startsWith('/open-apis/') || url.includes('..') || /[?#]/.test(url)) throw new Error('请使用飞书开放平台的接口路径。')
    // Match the SDK's generated API methods: Feishu expects repeated keys for array query parameters.
    const result = await this.client.request({ method, url, data, params, timeout: 20000, paramsSerializer: { indexes: null } }) as { code?: number; data?: T; bot?: T }
    if (result.code) throw new CliError(`飞书操作未完成（${result.code}），请检查应用及资源权限。`, result.code)
    return (result.data ?? result.bot ?? result) as T
  }
  async identity(): Promise<{ open_id: string; app_name?: string }> {
    const bot = await this.request<{ open_id: string; app_name?: string }>('GET', '/open-apis/bot/v3/info')
    if (!bot.open_id) throw new Error('请启用并发布飞书机器人。')
    return bot
  }
  private normalized(item: Record<string, unknown>) {
    const body = item.body as { content?: string } | undefined
    return { ...item, msg_type: item.message_type ?? 'text', content: messageText(body?.content ?? ''), sender: item.sender ?? { id: '', sender_type: 'user' } }
  }
  /** Compatibility facade for upstream readers; no CLI process or user login is used. */
  async compat<T>(args: string[], cwd?: string, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const flag = (name: string, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback }
    const call = <V>(method: string, url: string, data?: unknown, params?: unknown) => this.request<V>(method, url, data, params)
    let result: unknown
    if (args[0] === 'api') result = await call(args[1]!, args[2]!, flag('--body') ? JSON.parse(flag('--body')) : undefined, flag('--params') ? JSON.parse(flag('--params')) : undefined)
    else if (args[1] === '+messages-reply') result = await call('POST', `/open-apis/im/v1/messages/${encodeURIComponent(flag('--message-id'))}/reply`, { msg_type: 'text', content: JSON.stringify({ text: flag('--markdown') }), reply_in_thread: true, uuid: createHash('sha256').update(flag('--idempotency-key')).digest('hex').slice(0, 32) })
    else if (args[1] === '+messages-mget') {
      const data = await call<{ items?: Record<string, unknown>[] }>('GET', '/open-apis/im/v1/messages/mget', undefined, { message_ids: flag('--message-ids').split(',') })
      result = { messages: (data.items ?? []).map(item => this.normalized(item)) }
    } else if (args[1] === '+threads-messages-list') {
      const data = await call<{ items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string }>('GET', '/open-apis/im/v1/messages', undefined, { container_id_type: 'thread', container_id: flag('--thread'), page_size: Number(flag('--page-size', '20')), page_token: flag('--page-token') || undefined, sort_type: flag('--order') === 'desc' ? 'ByCreateTimeDesc' : 'ByCreateTimeAsc' })
      result = { messages: (data.items ?? []).map(item => this.normalized(item)), has_more: !!data.has_more, page_token: data.page_token, thread_id: flag('--thread') }
    } else if (args[1] === '+chat-list' || args[1] === '+chat-members-list') {
      const members = args[1] === '+chat-members-list', all: Record<string, unknown>[] = []; let token: string | undefined; const seen = new Set<string>()
      do {
        const page: { items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string } = await call('GET', members ? `/open-apis/im/v1/chats/${encodeURIComponent(flag('--chat-id'))}/members` : '/open-apis/im/v1/chats', undefined, { page_size: 100, page_token: token, ...(members ? { member_id_type: 'open_id' } : {}) })
        all.push(...page.items ?? []); if (page.has_more && (!page.page_token || seen.has(page.page_token))) throw new Error('飞书分页未推进。'); token = page.has_more ? page.page_token : undefined; if (token) seen.add(token)
      } while (token)
      result = members ? { users: all, has_more: false } : { chats: all }
    } else if (args[1] === '+messages-resources-download') {
      const response = await this.client.im.messageResource.get({ path: { message_id: flag('--message-id'), file_key: flag('--file-key') }, params: { type: 'image' } })
      const path = join(cwd ?? '.', 'image.png'); await response.writeFile(path); result = { saved_path: path }
    } else throw new Error('此飞书操作尚未接入应用接口。')
    signal?.throwIfAborted(); return result as T
  }
}
