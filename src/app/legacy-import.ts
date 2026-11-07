/** One-time import of the first build's configuration; historical task records stay intact in its old database. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './store.ts'
import { storeCredentials } from '../sources/feishu-sdk.ts'
import type { Prompts } from './prompts.ts'
export function importLegacy(store: Store, directory: string): Record<string, unknown> | undefined {
  if (store.get('general-legacy-imported')) return
  const file = join(directory, 'settings.json')
  if (!existsSync(file)) {
    if (store.settingsHistory().length === 0) { const current = store.settings(); store.saveSettings({ ...current, eval: { ...current.eval, mode: 'auto' }, policy: { ...current.policy, rules: [{ id: 'general', name: '通用工作请求', enabled: true, instruction: '处理有清晰目标的调研、翻译、写作、分析、资料整理、文件操作和开发等任务。只在授权范围内行动。对群内观察消息按价值与可执行性判断，无关消息保持安静。' }] } }) }
    store.set('general-legacy-imported', true); return
  }
  const old = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  if (typeof old.appId !== 'string') return
  if (typeof old.appSecret === 'string' && old.appSecret) storeCredentials(directory, old.appId, old.appSecret)
  const groups = Array.isArray(old.groups) ? old.groups as { id: string; observe?: boolean }[] : []
  const current = store.settings()
  const policy = { allowed: (Array.isArray(old.senderIds) ? old.senderIds : []).map(id => ({ id })), admission: Object.fromEntries(groups.filter(g => g.observe).map(g => [g.id, { listedUnaddressed: 'inferred' }])) }
  store.saveSettings({ ...current, paused: old.enabled !== true, sources: { feishu: { enabled: true, config: { appId: old.appId, credentialVersion: 'legacy-v1', directMessages: old.privateMessages !== false, chats: groups.map(g => ({ chatId: g.id, listen: g.observe ? 'all' : 'mentions' })), positiveKeywords: Array.isArray(old.positive) ? old.positive.join(',') : '', negativeKeywords: Array.isArray(old.negative) ? old.negative.join(',') : '' } } }, policy: { ...current.policy, rules: [{ id: 'general', name: '通用工作请求', enabled: true, instruction: typeof old.evaluationPrompt === 'string' && old.evaluationPrompt !== '筛选值得保存的优质文章、开源项目和有明确目标的工作请求。忽略闲聊、广告、重复分享和信息不足的内容。对于文章与项目，关注实用价值、可信来源、技术深度与可复用经验。' ? old.evaluationPrompt : '处理有明确目标的各类工作请求，包括调研、分析、写作、翻译、资料整理、文件操作和开发。具体方法交给 Worker 决定，保持低打扰。' }], sources: { feishu: policy } }, eval: { ...current.eval, mode: 'auto', ...(old.provider && old.model ? { model: { provider: old.provider, model: old.model } } : {}) }, executor: { ...current.executor, maxWorkers: old.maxWorkers ?? 3, directory: old.workspace || '', ...(old.provider && old.model ? { model: { provider: old.provider, model: old.model } } : {}) } })
  store.set('general-legacy-imported', true)
  return old
}
export function importLegacyPrompts(prompts: Prompts, old: Record<string, unknown> | undefined): void {
  if (!old || prompts.current().revision !== 0) return
  const config = prompts.current().config
  if (typeof old.workerPrompt === 'string') config.scope += `\n\n用户的通用要求：\n${old.workerPrompt}`
  const k = old.knowledge as { enabled?: boolean; targetUrl?: string; instructions?: string; template?: string } | undefined
  if (k?.enabled) config.skills['knowledge'] = `当用户要求将资料收录到知识库时使用此场景要求。\n目标目录：${k.targetUrl ?? ''}\n${k.instructions ?? ''}\n文档结构：\n${k.template ?? ''}\n使用 orchestrator_feishu_api 读取目标目录并创建、写入 Docx，核对返回的标识及实际结果。`
  prompts.save(config, 0, 'panel')
}
