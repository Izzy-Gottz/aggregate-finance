import { describe, expect, it } from 'vitest'
import { toMinor } from '@agfn/connector-sdk'
import { parseOfxTree } from './ofx.ts'
import { parseMoney } from './pdf/values.ts'

// Files come from signed-in users on a shared server, so a hostile one mustn't hold the event loop. 8 MB is the upload limit.
const MB = 1024 * 1024
// Generous so a loaded machine doesn't fail it: the slowdowns this guards against take minutes on 8 MB, not seconds.
function quick<T>(fn: () => T): T {
  const start = performance.now()
  const out = fn()
  expect(performance.now() - start).toBeLessThan(10_000)
  return out
}

describe('hostile uploads stay fast', () => {
  it.each(['<?', '<!--', '<![CDATA[', '<a ', '<', '<a/'])('OFX full of unclosed %s', (open) => {
    quick(() => parseOfxTree(open.repeat(Math.floor((8 * MB) / open.length))))
    quick(() => parseOfxTree(`${open.repeat(Math.floor((8 * MB) / open.length))}>`))
  })
  it('a huge amount cell', () => {
    expect(() => quick(() => toMinor(`${'1'.repeat(8 * MB)}x`, 'USD'))).toThrow('not an amount')
  })
  it('a PDF amount with a long run of spaces', () => {
    expect(quick(() => parseMoney(`-${' '.repeat(8 * MB)}x`))).toBeNull()
    expect(parseMoney('-$1,234.56')).toBe(-123456)
  })
})
