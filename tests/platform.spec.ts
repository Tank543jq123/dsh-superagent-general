import { describe, expect, it } from 'vitest'
import { executableNames, isWindows, pathDelimiter, pathVariable, quoteForShell, shellArgv } from '../src/infra/platform.ts'

/**
 * The platform seam, pinned.
 *
 * These are the three questions the rest of the code actually asks — how a command
 * line runs, how the executable search path is spelled, and how a path is quoted —
 * and each one has a wrong answer that only shows up on the other platform. Pinning
 * both sides here means a caller cannot quietly reintroduce `sh -c`.
 */
describe('running a command line through a shell', () => {
  it('uses sh -c on POSIX', () => {
    expect(shellArgv('npm ci', 'linux')).toEqual(['sh', '-c', 'npm ci'])
    expect(shellArgv('npm ci', 'darwin')).toEqual(['sh', '-c', 'npm ci'])
  })

  it('uses cmd /d /s /c on Windows', () => {
    // /d skips registry AutoRun text, /s makes cmd take the rest as one command.
    expect(shellArgv('npm ci', 'win32')).toEqual(['cmd', '/d', '/s', '/c', 'npm ci'])
  })

  it('keeps the command line intact, including its own quoting', () => {
    const line = 'node -e "console.log(1)" && echo done'
    expect(shellArgv(line, 'linux')[2]).toBe(line)
    expect(shellArgv(line, 'win32')[4]).toBe(line)
  })

  it('defaults to this process platform', () => {
    expect(shellArgv('x')[0]).toBe(isWindows() ? 'cmd' : 'sh')
  })
})

describe('the executable search path', () => {
  it('names the variable each platform reads', () => {
    // Windows spells it `Path`; the variable name is case-insensitive there, but the
    // exact spelling is what a child process receives and what documentation quotes.
    expect(pathVariable('win32')).toBe('Path')
    expect(pathVariable('linux')).toBe('PATH')
  })

  it('separates entries with the platform delimiter', () => {
    expect(pathDelimiter('win32')).toBe(';')
    expect(pathDelimiter('linux')).toBe(':')
  })
})

describe('names an executable can have', () => {
  it('tries PATHEXT extensions on Windows and a bare name on POSIX', () => {
    // A POSIX shell script named `gh` is not executable on Windows at all, which is
    // why the self-written shim cannot stand in for one.
    expect(executableNames('gh', 'win32')).toEqual(['gh.exe', 'gh.cmd', 'gh.bat', 'gh'])
    expect(executableNames('gh', 'linux')).toEqual(['gh'])
  })
})

describe('quoting a path for the platform shell', () => {
  it('leaves a plain path alone', () => {
    expect(quoteForShell('/usr/bin/gh', 'linux')).toBe('/usr/bin/gh')
    expect(quoteForShell('gh', 'win32')).toBe('gh')
  })

  it('single-quotes on POSIX, escaping an embedded quote', () => {
    expect(quoteForShell('/opt/my tools/gh', 'linux')).toBe(`'/opt/my tools/gh'`)
    expect(quoteForShell("/opt/it's/gh", 'linux')).toBe(`'/opt/it'\\''s/gh'`)
  })

  it('double-quotes on Windows, because cmd ignores single quotes', () => {
    // A POSIX-quoted argument reaches cmd with the quotes intact and the path then
    // does not resolve — so the two platforms cannot share one quoter.
    expect(quoteForShell('C:\\Program Files\\gh.exe', 'win32')).toBe('"C:\\Program Files\\gh.exe"')
    expect(quoteForShell('C:\\a&b\\gh.exe', 'win32')).toBe('"C:\\a&b\\gh.exe"')
  })
})
