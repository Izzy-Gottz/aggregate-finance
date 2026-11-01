// Shared helpers for DOM tests (happy-dom).
import { cleanup } from '@testing-library/preact'
import { afterEach } from 'vitest'

// Node 26 puts its own localStorage on globalThis (unusable without --localstorage-file), hiding happy-dom's.
// Give tests a plain in-memory one so code that remembers things in the browser is actually exercised.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  let ok = false
  try {
    globalThis[name].setItem('__t', '1')
    globalThis[name].removeItem('__t')
    ok = true
  } catch {
    /* replaced below */
  }
  if (!ok) {
    const m = new Map<string, string>()
    const store = {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size
      },
    }
    Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true })
  }
}

afterEach(() => {
  cleanup()
  location.hash = ''
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// happy-dom isn't a secure context and has no WebAuthn; screens offer passkeys only where a browser could make one, so
// tests run as if on https or localhost. A test of the http://<LAN IP> case overrides these.
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
if (!('PublicKeyCredential' in window)) Object.defineProperty(window, 'PublicKeyCredential', { value: class PublicKeyCredential {}, configurable: true })
