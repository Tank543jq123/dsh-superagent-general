import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDocs = ['docs/USER-GUIDE.md', 'docs/UPSTREAM.md', 'docs/ARCHITECTURE.md', 'docs/PROMPTS.md']
const documents = ['README.md', 'src/README.md', 'src/CHANGELOG.md', ...publicDocs]
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
