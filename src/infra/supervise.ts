/** Opt-in external supervisor, independent of the DSH process. */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { statSync } from 'node:fs'
export function heartbeatStale(path: string, started: number, now = Date.now()): boolean {
  if (now - started < 120000) return false
  try { return now - statSync(path).mtimeMs > 120000 } catch { return true }
}
export async function supervise(command: string, args: string[], signal: AbortSignal, heartbeat?: string): Promise<void> {
  let failures = 0
  while (!signal.aborted) {
    const began = Date.now()
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(command, args, { stdio: 'inherit', shell: false })
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const stop = (): void => { if (killTimer) return; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 10000); killTimer.unref() }
      const healthTimer = heartbeat ? setInterval(() => { if (heartbeatStale(heartbeat, began)) stop() }, 10000) : undefined
      signal.addEventListener('abort', stop, { once: true })
      const cleanup = (): void => { signal.removeEventListener('abort', stop); if (healthTimer) clearInterval(healthTimer); if (killTimer) clearTimeout(killTimer) }
      child.once('error', error => { cleanup(); reject(error) }); child.once('exit', value => { cleanup(); done(value) })
    })
    if (signal.aborted || code === 0) return
    failures = Date.now() - began > 60000 ? 1 : failures + 1
    if (failures >= 5) throw new Error('连续启动失败 5 次，已停止自动重启，请查看 DSH 错误输出。')
    await delay(Math.min(60000, 1000 * 2 ** failures), undefined, { signal }).catch(() => {})
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const params = process.argv.slice(2).filter((v, i) => !(i === 0 && v === '--'))
  let heartbeat: string | undefined
  if (params[0] === '--heartbeat') { params.shift(); heartbeat = params.shift() }
  const [command, ...args] = params
  if (!command) { console.error('用法：pnpm watchdog -- [--heartbeat 心跳文件完整路径] <DSH 启动命令> [参数]'); process.exitCode = 1 }
  else { const abort = new AbortController(); process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort()); await supervise(command, args, abort.signal, heartbeat).catch(error => { console.error(error instanceof Error ? error.message : '守护进程退出'); process.exitCode = 1 }) }
}
