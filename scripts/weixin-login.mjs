#!/usr/bin/env node
/**
 * Signs this deployment's Weixin Source in.
 *
 * The Source keeps its own Weixin binding under the deployment's state directory,
 * independent of any other program's connection: signing out elsewhere no longer
 * strips the token this Source polls with.
 *
 * Usage:
 *   node scripts/weixin-login.mjs [--state-dir <dir>] [--timeout <seconds>]
 *
 * The script prints a QR image URL, waits for the operator to scan and confirm it on
 * their phone, then writes `<stateDir>/weixin-binding.json` (mode 0600). Nothing is
 * printed that contains the token.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const QR_BASE = 'https://ilinkai.weixin.qq.com/'
const BOT_TYPE = '3'
const STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode', 'verify_code_blocked', 'binded_redirect'])

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const stateDir = argOf('--state-dir', process.env.DSH_SUPERAGENT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'state', 'superagent'))
const timeoutSeconds = Number(argOf('--timeout', '300'))

const fail = (message) => { console.error(`\n✗ ${message}\n`); process.exit(1) }

async function requestOnce(url, init, timeoutMs) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`)
  return response.json()
}

console.log('正在向微信申请登录二维码…')
let qr
try {
  qr = await requestOnce(new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, QR_BASE), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ local_token_list: [] }),
  }, 15_000)
} catch (error) {
  fail(`申请二维码失败：${error instanceof Error ? error.message : String(error)}`)
}
const qrcode = typeof qr?.qrcode === 'string' ? qr.qrcode : ''
if (!qrcode) fail('微信没有返回二维码令牌。')

const imageUrl = typeof qr?.qrcode_img_content === 'string' ? qr.qrcode_img_content : ''
console.log('\n请用手机微信扫码并确认：\n')
if (imageUrl) console.log(`  ${imageUrl}\n`)
else console.log('  （微信未返回图片地址，请稍后重试）\n')

const deadline = Date.now() + timeoutSeconds * 1000
let lastStatus = ''
while (Date.now() < deadline) {
  let page
  try {
    page = await requestOnce(new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, QR_BASE), {
      headers: { 'content-type': 'application/json' },
    }, 30_000)
  } catch (error) {
    // A transient status failure is not fatal: keep polling until the deadline.
    await delay(2000)
    continue
  }
  const status = STATUSES.has(page?.status) ? page.status : 'wait'
  if (status !== lastStatus) {
    if (status === 'scaned') console.log('  已扫码，请在手机上确认…')
    if (status === 'need_verifycode') console.log('  微信要求输入验证码，请在手机端完成。')
    if (status === 'expired') fail('二维码已过期，请重新运行本脚本。')
    if (status === 'binded_redirect') console.log('  该微信已绑定到另一处，按其提示操作。')
    lastStatus = status
  }
  if (status === 'confirmed') {
    const token = page?.bot_token
    const botId = page?.ilink_bot_id
    const ownerUserId = page?.ilink_user_id
    if (typeof token !== 'string' || !token || typeof botId !== 'string' || !botId || typeof ownerUserId !== 'string' || !ownerUserId) {
      fail('微信确认了登录，但返回的凭据不完整。')
    }
    const binding = {
      botId, accountId: ownerUserId, ownerUserId,
      baseUrl: typeof page?.baseurl === 'string' && page.baseurl ? page.baseurl : QR_BASE,
      token,
    }
    const path = join(stateDir, 'weixin-binding.json')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    console.log(`\n✓ 绑定成功`)
    console.log(`  机器人：${botId}`)
    console.log(`  所有者：${ownerUserId}`)
    console.log(`  已写入：${path}\n`)
    console.log(`接下来把所有者 id 加入微信 Source 的允许名单，然后重启服务：`)
    console.log(`  scripts/dsh-superagent --profile superagent restart\n`)
    process.exit(0)
  }
  await delay(2000)
}
fail(`等待扫码超时（${timeoutSeconds} 秒），请重新运行本脚本。`)
