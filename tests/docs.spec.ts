import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDocs = ['docs/000-philosophy.md', 'docs/001-domain.md', 'docs/002-authorization.md', 'docs/003-execution.md', 'docs/004-prompts.md', 'docs/005-panel.md', 'docs/006-deployment.md', 'docs/007-architecture.md', 'docs/008-cookbook.md', 'docs/ARCHITECTURE.md', 'docs/PROMPTS.md', 'docs/UPSTREAM.md', 'docs/USER-GUIDE.md', 'docs/009-general-upgrade.md']
const documents = ['README.md', 'README.en.md', 'src/README.md', 'src/CHANGELOG.md', ...publicDocs]
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const manifest = JSON.parse(read('package.json')) as { files: string[]; scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string>; peerDependencies: Record<string, string> }
const sourceFiles = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name))
function localLinks(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}

describe('public documentation and distribution', () => {
  it('resolves links in current project documentation without reference documents', () => {
    const missing = documents.flatMap(file => localLinks(file).filter(target => !existsSync(resolve(ROOT, dirname(file), target))).map(target => `${file} → ${target}`))
    expect(missing).toEqual([])
  })
  it('contains no unresolved merge markers in public documentation', () => {
    expect(documents.filter(file => /^(<{7}|>{7}) /m.test(read(file)))).toEqual([])
  })
  it('packages only the maintained public documents', () => {
    expect(manifest.files.filter(file => file.startsWith('docs/')).sort()).toEqual([...publicDocs].sort())
    expect(manifest.files).not.toContain('docs')
  })
  it('builds before packing and includes all runtime asset families', () => {
    expect(manifest.scripts.prepack).toBe('pnpm build')
    for (const family of ['lib', 'cordis.patch.yml', 'prompts', 'skills', 'locale/*.json', 'LICENSE']) expect(manifest.files).toContain(family)
  })
  it('uses declared registry dependencies without machine-local package links', () => {
    const invalid = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }).filter(([, version]) => /^(?:file:|link:|workspace:|\/|\.\.?\/)/.test(version))
    expect(invalid).toEqual([])
  })
  it('injects a fixed delegation gate after the composed worker prompt', () => {
    const source = read('src/app/sessions.ts')
    expect(source).toContain('DELEGATION_GATE')
    expect(source).toContain('开工前派工检查')
    expect(source).toContain('派工：无（理由）')
  })
  it('tells workers when to dispatch subagents', () => {
    const work = read('prompts/work.md')
    expect(work).toContain('## 派工')
    expect(work).toContain('subagent')
    expect(work).toContain('两个及以上互不依赖的子任务')
    expect(read('prompts/worker.md')).toContain('subagent')
  })
  it('makes dispatch a gate before work starts, not an optional optimisation', () => {
    // 【2026-11-09】实测：worker 加了「可切块时优先派」之后仍然不派 —— 软措辞不产生行为变化。
    // 现在改成开工前的强制判定，并把"默认偏向派"写明；同时也放进 shared（两个角色都读）。
    const work = read('prompts/work.md')
    expect(work).toMatch(/动手前先做一次判定|这是流程的第一步/)
    expect(work).toMatch(/能 → 必须先派|必须先派/)
    expect(work).toMatch(/默认偏向派工/)
    // 反例清单必须挡住"我自己更快"这类借口
    expect(work).toMatch(/我自己写更快/)
    const shared = read('prompts/shared.md')
    expect(shared).toContain('Delegation is the default for splittable work')
    expect(shared).toMatch(/fallback, not the default/)
    // worker.md 不能再出现"自行选择方法"这类反向暗示
    const worker = read('prompts/worker.md')
    expect(worker).not.toContain('自行选择方法')
    expect(worker).toContain('独立完成是兜底不是默认')
  })
  it('resolves source-relative imports entirely within the checked-out project', () => {
    const missing = [...sourceFiles('src'), ...sourceFiles('tests')].flatMap(file => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].flatMap(match => {
        const target = resolve(dirname(file), match[1]!.split('?')[0]!)
        return target.startsWith(ROOT + '/') && existsSync(target) ? [] : [`${file}: ${match[1]}`]
      })
    })
    expect(missing).toEqual([])
  })
})
