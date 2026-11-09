/**
 * The one place that knows which operating system this runs on.
 *
 * ## Why this module exists
 *
 * Everything here was written assuming POSIX. Measured on Windows: 131 of 1198 tests
 * fail across 9 files, and almost all of them are `spawn sh ENOENT` or
 * `spawn sleep ENOENT` — so about 89% of the logic is portable, and what is not is
 * concentrated in three things: how a command line is run, how the environment is
 * assembled, and how a service script is written.
 *
 * That concentration is the point of this file. A `process.platform` check scattered
 * through the executor, the environment builder and the Sources would make each of
 * them a place to get the platform wrong; one module that answers the questions they
 * actually have keeps the conditionals countable.
 *
 * Nothing here is a shim generator. Where DSH already answers a question (see
 * `resolveExecutable` on its subprocess service) the caller should ask DSH instead of
 * reimplementing it — this module only covers the gaps DSH leaves open.
 */

/** True on Windows, where the shell is not `sh` and paths are separated by `;`. */
export const isWindows = (): boolean => process.platform === 'win32'

/**
 * The argv that runs `command` through a shell.
 *
 * POSIX gets `sh -c`. Windows gets `cmd /d /s /c`: `/d` skips AutoRun commands from
 * the registry (which would otherwise run arbitrary text before the real command),
 * and `/s` makes cmd treat the whole string as one command with the outer quotes
 * stripped, which is the quoting contract `cmd.exe` actually documents.
 *
 * Why not PowerShell: `executor.prepare` is a command line an operator wrote, and the
 * overwhelming majority of examples in the docs are POSIX shell. `cmd` is the closer
 * translation, and a PowerShell default would silently change the meaning of `&&`,
 * `>`, and quoting for anyone who wrote one.
 *
 * @param command the operator's command line
 * @param platform defaults to this process's, so tests can pin both sides
 */
export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['cmd', '/d', '/s', '/c', command] : ['sh', '-c', command]
}

/** The environment variable that lists executable search directories. */
export const pathVariable = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'Path' : 'PATH'

/** The separator between entries of the executable search path. */
export const pathDelimiter = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? ';' : ':'

/**
 * Names a same-directory executable can have on this platform.
 *
 * Windows resolves `gh` through `PATHEXT`, and a file written without an extension is
 * not executable there at all — which is why a POSIX shell shim cannot stand in for
 * an executable on Windows. Callers that must *create* an executable therefore need
 * one of these names, and callers that only *look one up* should ask DSH's
 * `resolveExecutable`, which already knows this.
 */
export function executableNames(base: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base] : [base]
}

/**
 * A path quoted for the platform's shell, or left alone when it needs no quoting.
 *
 * POSIX single quotes, with the `'\''` escape for an embedded quote. Windows double
 * quotes, because `cmd` does not treat single quotes as quoting at all — a POSIX-quoted
 * argument reaches `cmd` with the quotes intact and the path then does not resolve.
 */
export function quoteForShell(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return /[\s"^&|<>()]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return /[\s'"$`\\!*?[\]{}()<>|&;#~]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value
}
