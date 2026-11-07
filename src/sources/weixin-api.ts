/**
 * Weixin bot transport for the `weixin` Source kind.
 *
 * Weixin has no CLI the way GitHub (`gh`) and Feishu (`lark-cli`) do: the bot speaks
 * HTTPS to `ilinkai.weixin.qq.com`. This module therefore owns the small amount of
 * HTTP and credential work the Source needs, instead of going through `Commands`.
 *
 * Connection facts are read from the configuration `@xmanrui/dsh-im` already wrote,
 * and the access token from DSH's credential store. Nothing here modifies either
 * file: the existing connection settings are the source of truth, and a mismatched
 * one is reported as a setup problem rather than silently repaired.
 *
 * The wire format below mirrors `@xmanrui/dsh-im`'s `weixin-api.mjs`
 * (`ilink/bot/getupdates`, `ilink/bot/sendmessage`): the field names, the
 * `base_info` block and the `Authorization` header set are protocol facts, not
 * guesses, and a change there is a protocol change this Source has to follow.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { WeixinUpdatesSchema } from './weixin-trigger.ts'

/** Protocol version the IM plugin negotiates (`ILINK_CLIENT_VERSION` as `major.minor.patch`). */
const CHANNEL_VERSION = '2.4.6'
/** `iLink-App-Id` value every bot request carries. */
const APP_ID = 'bot'
/** Numeric form of `CHANNEL_VERSION`, sent as `iLink-App-ClientVersion`. */
const APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
/** Default long-poll wait of `ilink/bot/getupdates`, in milliseconds. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 25_000

/** One Weixin bot account as `@xmanrui/dsh-im` stores it in `integrations/dsh-weixin/config.json`. */
const AccountSchema = z.looseObject({
  botId: z.string().min(1),
  accountId: z.string().optional(),
  tokenRef: z.string().min(1),
  ownerUserId: z.string().min(1),
  baseUrl: z.string().url(),
})
const ConfigSchema = z.looseObject({ version: z.number().optional(), accounts: z.array(AccountSchema) })

export interface WeixinAccount { botId: string; tokenRef: string; ownerUserId: string; baseUrl: string }

/** The DSH home whose credential store holds the bot token. */
const dshHome = (): string => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Default location of the connection configuration the IM plugin maintains. */
export const WEIXIN_CONFIG_PATH = (): string => join(dshHome(), 'integrations', 'dsh-weixin', 'config.json')

/** Raised when the stored connection or its token cannot be used; the message becomes the setup problem. */
export class WeixinSetupError extends Error {
  constructor(readonly code: 'configMissing' | 'configInvalid' | 'tokenMissing' | 'providerRejected' | 'networkError', message: string) {
    super(message)
    this.name = 'WeixinSetupError'
  }
}

/**
 * Reads the bot connection from the IM plugin's configuration file.
 *
 * `accountIndex` selects an account when the file holds several; the first is the default.
 */
export async function readWeixinAccount(configPath: string, accountIndex = 0): Promise<WeixinAccount> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    throw new WeixinSetupError('configMissing',
      `The Weixin connection configuration is not readable at ${configPath}. Connect a Weixin account in DeepSeek Harness first.`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new WeixinSetupError('configInvalid', `The Weixin connection configuration at ${configPath} is not valid JSON.`)
  }
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) throw new WeixinSetupError('configInvalid', `The Weixin connection configuration at ${configPath} is invalid.`)
  const account = parsed.data.accounts[accountIndex]
  if (!account) throw new WeixinSetupError('configInvalid', `The Weixin connection configuration at ${configPath} holds no account ${accountIndex}.`)
  return { botId: account.botId, tokenRef: account.tokenRef, ownerUserId: account.ownerUserId, baseUrl: account.baseUrl }
}

/**
 * Reads the access token DSH stores under `tokenRef`.
 *
 * The credential file is a small YAML map under `refs:`. This reads the one scalar of
 * the named ref rather than parsing general YAML: the format is DSH-owned and stable,
 * and every value the bot needs is a plain scalar.
 */
export async function readWeixinToken(tokenRef: string): Promise<string> {
  const path = join(dshHome(), '.credentials.yaml')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new WeixinSetupError('tokenMissing', `The credential store at ${path} is not readable.`)
  }
  const escaped = tokenRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`, 'm'))
  if (!match) throw new WeixinSetupError('tokenMissing', `The Weixin bot token ${tokenRef} is not in the credential store at ${path}.`)
  return match[1]!.replace(/^['"]|['"]$/g, '')
}

/** The `base_info` block every bot request carries. */
const baseInfo = (): Record<string, unknown> => ({ channel_version: CHANNEL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' })

/** Headers of an authenticated bot request, matching the IM plugin's `authenticatedHeaders`. */
function authHeaders(token: string): Record<string, string> {
  return {
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(APP_CLIENT_VERSION),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    Authorization: `Bearer ${token.trim()}`,
  }
}

/** Posts one JSON request to the Weixin bot API and returns the decoded body. */
async function postJson(baseUrl: string, endpoint: string, token: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const url = new URL(endpoint, baseUrl)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ ...body as Record<string, unknown>, base_info: baseInfo() }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new WeixinSetupError('networkError', `The Weixin API could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new WeixinSetupError('providerRejected', `The Weixin API answered ${response.status} for ${endpoint}.`)
  try {
    return await response.json()
  } catch {
    throw new WeixinSetupError('providerRejected', `The Weixin API returned an unreadable body for ${endpoint}.`)
  }
}

export interface PollResult { messages: unknown[]; cursor: string }

/**
 * Long-polls for new messages.
 *
 * `cursor` is the opaque `get_updates_buf` the provider returns; passing it back is
 * what makes polling resumable, so the caller persists it rather than counting.
 * A timeout is an ordinary empty result: the provider closes an idle long poll
 * without messages, which is not a failure.
 */
export async function pollWeixin(baseUrl: string, token: string, cursor: string, signal: AbortSignal): Promise<PollResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_LONG_POLL_TIMEOUT_MS)
  try {
    const raw = await postJson(baseUrl, 'ilink/bot/getupdates', token, { get_updates_buf: cursor },
      AbortSignal.any([signal, controller.signal]))
    const page = WeixinUpdatesSchema.parse(raw)
    return { messages: page.msgs, cursor: page.get_updates_buf ?? cursor }
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) return { messages: [], cursor }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Sends one text message as the bot, in the wire shape `ilink/bot/sendmessage` expects. */
export async function sendWeixinText(baseUrl: string, token: string, input: {
  toUserId: string; text: string; contextToken?: string; signal: AbortSignal
}): Promise<void> {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: input.toUserId,
      client_id: `dsh-superagent-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: input.text } }],
      ...(input.contextToken ? { context_token: input.contextToken } : {}),
    },
  }
  const raw = await postJson(baseUrl, 'ilink/bot/sendmessage', token, body, input.signal)
  const rejected = z.looseObject({ ret: z.coerce.number().optional(), errcode: z.coerce.number().optional() }).safeParse(raw)
  if (rejected.success) {
    const code = rejected.data.errcode ?? rejected.data.ret
    if (code !== undefined && code !== 0) throw new WeixinSetupError('providerRejected', `The Weixin API rejected the reply with code ${code}.`)
  }
}

// ───────────────────────── independent sign-in ─────────────────────────
//
// The Source owns its own Weixin binding so that it does not depend on another
// program's connection file: signing out of that program would otherwise strip the
// token this Source needs. Signing in is a QR handshake — request a code, poll its
// status until the operator confirms it on a phone, then store the returned token.

/** Base URL of the QR handshake, which is not the bot API host. */
export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/'
/** Bot type the provider expects for a personal-account bot. */
const BOT_TYPE = '3'

/** Where this Source keeps its own binding: the bot identity, its token and the API base. */
export interface WeixinBinding { botId: string; accountId: string; ownerUserId: string; baseUrl: string; token: string }

/** Login states the provider reports; only `confirmed` carries credentials. */
const LOGIN_STATUSES = ['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'] as const
const LoginSchema = z.looseObject({
  status: z.enum(LOGIN_STATUSES),
  bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().optional(),
  baseurl: z.string().optional(),
  qrcode_img_content: z.string().optional(),
})

/** Absolute path of this Source's own binding file, separate from any other program's configuration. */
export const WEIXIN_BINDING_PATH = (stateDir: string): string => join(stateDir, 'weixin-binding.json')

/** Reads this Source's own binding, or `undefined` when it has never signed in. */
export async function readWeixinBinding(stateDir: string): Promise<WeixinBinding | undefined> {
  let text: string
  try {
    text = await readFile(WEIXIN_BINDING_PATH(stateDir), 'utf8')
  } catch {
    return undefined
  }
  const parsed = z.looseObject({
    botId: z.string().min(1), accountId: z.string().min(1), ownerUserId: z.string().min(1),
    baseUrl: z.string().url(), token: z.string().min(1),
  }).safeParse(JSON.parse(text))
  return parsed.success ? parsed.data : undefined
}

/** Writes the binding with owner-only permissions; the token lives here, not in a shared credential store. */
export async function writeWeixinBinding(stateDir: string, binding: WeixinBinding): Promise<void> {
  const path = WEIXIN_BINDING_PATH(stateDir)
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export interface QrCode { qrcode: string; imageUrl: string }

/** Requests a sign-in QR code; the operator scans it in Weixin and confirms on the phone. */
export async function beginWeixinLogin(signal: AbortSignal): Promise<QrCode> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, WEIXIN_QR_BASE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_token_list: [] }),
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) throw new WeixinSetupError('providerRejected', `The Weixin QR request answered ${response.status}.`)
    const page = z.looseObject({ qrcode: z.string().optional(), qrcode_img_content: z.string().optional() }).parse(await response.json())
    return { qrcode: page.qrcode ?? '', imageUrl: page.qrcode_img_content ?? '' }
  } finally {
    clearTimeout(timer)
  }
}

/** Polls the sign-in status once; `confirmed` returns the credentials to store. */
export async function pollWeixinLogin(qrcode: string, signal: AbortSignal): Promise<{
  status: typeof LOGIN_STATUSES[number]; binding?: WeixinBinding; imageUrl?: string
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, WEIXIN_QR_BASE_URL), {
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) throw new WeixinSetupError('providerRejected', `The Weixin sign-in status answered ${response.status}.`)
    const page = LoginSchema.parse(await response.json())
    if (page.status !== 'confirmed') return { status: page.status, ...(page.qrcode_img_content ? { imageUrl: page.qrcode_img_content } : {}) }
    if (!page.bot_token || !page.ilink_bot_id || !page.ilink_user_id) {
      throw new WeixinSetupError('providerRejected', 'Weixin confirmed the sign-in but returned incomplete credentials.')
    }
    return {
      status: 'confirmed',
      binding: {
        botId: page.ilink_bot_id, accountId: page.ilink_user_id, ownerUserId: page.ilink_user_id,
        baseUrl: page.baseurl ?? WEIXIN_QR_BASE_URL, token: page.bot_token,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}
