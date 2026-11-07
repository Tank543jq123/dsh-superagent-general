import { describe, expect, it } from 'vitest'
import { weixinKind } from '../src/sources/weixin.ts'

describe('weixin source configuration', () => {
  it('parses keyword fields and exposes them in the settings form', () => {
    const config = weixinKind.schema.parse({ positiveKeywords: '工具', negativeKeywords: '广告' })
    expect(config).toMatchObject({ positiveKeywords: '工具', negativeKeywords: '广告' })
    const fields = weixinKind.fields.map(field => field.key)
    expect(fields).toContain('positiveKeywords')
    expect(fields).toContain('negativeKeywords')
  })
})
