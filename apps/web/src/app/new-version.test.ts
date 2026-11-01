// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { runningBundle, servedBundle } from './new-version.ts'

describe('new version check', () => {
  it('reads the running bundle from the page and the served one from the index', async () => {
    document.head.innerHTML = '<script type="module" src="/assets/app-YRR2K37P.js"></script>'
    expect(runningBundle()).toBe('assets/app-YRR2K37P.js')
    const f = (async () => new Response('<script type="module" src="/assets/app-AMLB2S4D.js"></script>')) as unknown as typeof fetch
    expect(await servedBundle(f)).toBe('assets/app-AMLB2S4D.js')
    const down = (async () => new Response('', { status: 502 })) as unknown as typeof fetch
    expect(await servedBundle(down)).toBeNull()
  })
  it('has nothing to compare in dev and tests (no built bundle on the page)', () => {
    document.head.innerHTML = '<script type="module" src="/src/main.ts"></script>'
    expect(runningBundle()).toBeNull()
  })
})
