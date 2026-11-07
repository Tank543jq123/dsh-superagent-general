import { setTimeout as wait } from 'node:timers/promises'
import * as Lark from '@larksuiteoapi/node-sdk'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { importLegacy, importLegacyPrompts } from '../src/app/legacy-import.ts'
import { Prompts } from '../src/app/prompts.ts'
import { FeishuApi, storedCredentials, storeCredentials } from '../src/sources/feishu-sdk.ts'
import { SettingsSchema, settingsPolicy, policyVersion } from '../src/policy.ts'
import { startRuntime, feishu } from './fixtures/host.ts'
const temporary: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'general-adaptation-')); temporary.push(path); return path }
afterEach(() => { vi.restoreAllMocks(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
it('fresh installations receive a generic policy without requiring GitHub', () => {
  const path = directory(), store = new Store(join(path, 'orchestrator.sqlite'), () => {})
  try { importLegacy(store, path); expect(store.settings().policy.rules.map(r => r.id)).toEqual(['general']); expect(store.settings().policy.rules[0]?.instruction).toContain('翻译'); expect(store.settings().eval.mode).toBe('auto'); const revision = store.settingsHistory().length; importLegacy(store, path); expect(store.settingsHistory()).toHaveLength(revision) } finally { store.close() }
})
it('imports the old credentials and scope once, and makes a scenario available as a team skill', () => {
  const path = directory(), store = new Store(join(path, 'orchestrator.sqlite'), () => {})
  writeFileSync(join(path, 'settings.json'), JSON.stringify({ appId: 'cli_demo', appSecret: 'private-demo', enabled: true, senderIds: ['ou_alice'], groups: [{ id: 'oc_team', observe: true }], knowledge: { enabled: true, targetUrl: 'https://example.feishu.cn/wiki/target', instructions: '按行业归类' } }))
  try {
    const old = importLegacy(store, path), prompts = new Prompts(store, () => 100000, () => [], () => true); importLegacyPrompts(prompts, old)
    expect(storedCredentials(path)).toEqual({ appId: 'cli_demo', appSecret: 'private-demo' }); expect(statSync(join(path, 'feishu-credentials.json')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(store.settings())).not.toContain('private-demo'); expect(store.settings().sources.feishu?.config.appId).toBe('cli_demo'); expect(prompts.current().config.skills.knowledge).toContain('按行业归类')
    expect(readFileSync(join(path, 'settings.json'), 'utf8')).toContain('private-demo')
  } finally { store.close() }
})
it('SDK transport implements the original reader facade with no subprocess', async () => {
  const api = new FeishuApi('cli_demo', 'demo-secret')
  const request = vi.spyOn(api, 'request').mockResolvedValue({ items: [{ message_id: 'om_1', chat_id: 'oc_team', message_type: 'text', body: { content: '{"text":"你好"}' }, sender: { id: 'ou_alice', sender_type: 'user' } }] })
  expect(await api.compat(['im', '+messages-mget', '--message-ids', 'om_1'])).toMatchObject({ messages: [{ message_id: 'om_1', content: '你好', msg_type: 'text' }] })
  expect(request).toHaveBeenCalledWith('GET', '/open-apis/im/v1/messages/mget', undefined, { message_ids: ['om_1'] })
})
it('SDK transport excludes non-platform URLs before any request', async () => { const api = new FeishuApi('cli_demo', 'secret'); await expect(api.request('GET', 'https://example.com/')).rejects.toThrow('接口路径') })
it('negative keywords win over positive keywords at the original policy gate', () => {
  const settings = SettingsSchema.parse({ sources: { feishu: { config: { positiveKeywords: '工具', negativeKeywords: '广告' } } }, policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const policy = settingsPolicy(settings, { scope: () => ({ listened: true, observed: true, row: 'oc_team' }) })
  expect(policy.gate(feishu('1', '工具广告'), { subscriptions: [] } as never, []).admissible).toBe(false)
  expect(policy.gate(feishu('2', '工具调研'), { subscriptions: [] } as never, []).admissible).toBe(true)
})
it('a generic request uses the upstream Router and a registered, named Worker Session', async () => {
  const host = await startRuntime(store => { const s = store.settings(); store.saveSettings({ ...s, sources: { feishu: s.sources.feishu!, github: { enabled: false, config: {} } } }) })
  try {
    expect(host.runtime.configured()).toBe(true); expect(host.runtime.deployment.repository).toBe('')
    const { ticket, sessionId } = await host.acceptedTicket(feishu('generic', '请调研三种公开资料并总结'))
    expect(host.agents.has(host.runtime.masterId)).toBe(true); expect(host.agents.has(sessionId)).toBe(true)
    expect(host.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId, agentPreset: 'dsh-superagent-worker', workspaceId: expect.any(String) }))
    expect(host.runtime.store.threads.get('feishu:oc_team:om_generic')?.subscriptions).toContain(ticket.id)
    expect(host.tools.get(sessionId)?.has('orchestrator_feishu_api')).toBe(true)
  } finally { await host.stop() }
})

it('terminal SDK connection failures return to the original consumer backoff loop', async () => {
  vi.useFakeTimers()
  const start = vi.spyOn(Lark.WSClient.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(Lark.WSClient.prototype, 'close').mockImplementation(() => {})
  vi.spyOn(Lark.WSClient.prototype, 'getConnectionStatus').mockReturnValue({ state: 'failed', reconnectAttempts: 0 })
  const controller = new AbortController(), commands = { withSignal: () => commands, lark: async () => ({ chats: [] }) }
  const context = { ready: Promise.resolve(), configured: () => true, deployment: { feishu: { appId: 'cli_demo', appSecret: 'test-secret', botId: 'ou_bot', brand: 'feishu' } }, config: () => ({ enabled: true, chats: [], directMessages: true }), report: vi.fn(), state: { get: () => undefined, set: vi.fn() }, threads: { subscribed: () => [] }, commands } as unknown as SourceContext
  const running = runFeishu(context, controller.signal)
  try { await vi.advanceTimersByTimeAsync(3100); await wait(1100); expect(start).toHaveBeenCalledTimes(2) }
  finally { controller.abort(); await running; vi.useRealTimers() }
})

it('keyword edits use the original policy version mechanism to invalidate stale evaluations', () => {
  const first = SettingsSchema.parse({ sources: { feishu: { config: { positiveKeywords: '工具' } } } })
  const changed = structuredClone(first); changed.sources.feishu!.config.negativeKeywords = '广告'
  expect(policyVersion(changed)).not.toBe(policyVersion(first))
  const displayOnly = structuredClone(first); displayOnly.sources.feishu!.config.readPageSize = 30
  expect(policyVersion(displayOnly)).toBe(policyVersion(first))
})

it('routes a proactive translation through the original assessment and hands only matched rules to its Worker', async () => {
  const host = await startRuntime()
  try {
    const settings = host.runtime.store.settings()
    const rules = [
      { id: 'translate', name: '文章翻译', enabled: true, instruction: '群内推荐外文文章时翻译，保留来源，参考 translation 技能。' },
      { id: 'filing', name: '文件归档', enabled: true, instruction: '归档用户指定的文件。' },
    ]
    host.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, rules } })
    const trigger = feishu('translate', '推荐这篇外文文章，请整理中文译文。', { mentions: [] })
    host.runtime.receive(trigger)
    await host.runtime.idle()
    expect(host.relays(host.runtime.masterId).at(-1)).toMatchObject({ kind: 'candidate', strength: 'inferred' })
    await host.runTool(host.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
    const result = await host.runTool(host.runtime.masterId, 'orchestrator_eval_decide', {
      trigger_id: trigger.id, decision: 'accept', title: '翻译推荐文章', worktree_name: 'translate-article',
      scope: '翻译该文章并保留来源', intent_evidence: '推荐这篇外文文章，请整理中文译文。', reason: '目标清晰且符合文章翻译规则',
      acknowledgement: '收到，整理这篇文章的中文译文并保留来源。',
      rule_assessments: [{ rule_id: 'translate', matched: true, reason: '明确提出中文译文目标' },
        { rule_id: 'filing', matched: false, reason: '没有文件归档请求' }],
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false,
        evidence: '文章已有来源，交付目标为中文译文' },
    })
    await host.runtime.idle()
    const ticket = host.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    const sessionId = `worker-${ticket.id}`
    expect(ticket.mandate.basis.rules).toEqual(['translate'])
    const assignment = await host.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })
    expect(assignment.text).toContain(rules[0]!.instruction)
    expect(assignment.text).not.toContain(rules[1]!.instruction)
    expect(host.agents.has(sessionId)).toBe(true)
    const explicit = await host.acceptedTicket(feishu('explicit-translation', '请把这段文字译成中文。'))
    expect(explicit.ticket.execution?.assignment).not.toContain(rules[0]!.instruction)
  } finally { await host.stop() }
})
